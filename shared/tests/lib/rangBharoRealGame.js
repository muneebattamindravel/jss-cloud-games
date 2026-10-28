'use strict';

/**
 * Flies the REAL games/rang-bharo/js/game.js in a sandbox: a fake window, a
 * fake clock and frame loop (timers run on it, never stubbed), a recording
 * canvas, the real kj-replay.js. Swipes go through real pointer events and
 * keys through real key events, so the input path under test is the phone's.
 *
 * The pilots decide from what the game shows (the probe's sim and the game's
 * OWN rules functions), never from the validator, so the thing under test
 * never chooses its own inputs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'games', 'rang-bharo');
const GAME = path.join(DIR, 'js', 'game.js');
const REPLAY = path.join(ROOT, 'games', '_shared', 'kj-replay.js');

// A test-only probe placed inside the game's closure. It reads, never writes.
const PROBE = `
  window.__probe = {
    get sim() { return sim; }, get mode() { return mode; }, get acc() { return acc; },
    get submitted() { return submitted; }, get inbox() { return inbox; }, get sessionReady() { return sessionReady; },
    rules: { slideEnd, genMaze, solvePar, initSim, stepSim, inputDir, blockedAt, DX, DY, TIME_STEPS, STEPS_PER_TILE, CLEAR_PAUSE },
  };
`;
const STEP_CALL = '    stepSim(sim);\n    curB = ballPosOf(sim);';
const DRAW_CALL = "draw(mode === 'play' ? Math.min(1, acc / STEP_MS) : 1);";
const BOOT_MARK = '  // ---------- boot ----------';
function gameSource(src, drawOn) {
  let s = src || fs.readFileSync(GAME, 'utf8');
  for (const m of [STEP_CALL, DRAW_CALL, BOOT_MARK]) if (s.split(m).length !== 2) throw new Error('harness hook not found once: ' + m);
  s = s.replace(STEP_CALL, STEP_CALL + '\n    if (window.__onStep) window.__onStep(sim);');
  if (!drawOn) s = s.replace(DRAW_CALL, 'if (window.__draw) ' + DRAW_CALL);
  return s.replace(BOOT_MARK, PROBE + BOOT_MARK);
}

// ── a canvas that records and refuses nonsense ─────────────────────────────
function makeCtx(log, strict) {
  const bad = (name, args) => {
    for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${name} got ${a}`);
  };
  const target = {
    canvas: null, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', font: '', textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, imageSmoothingEnabled: true,
  };
  const methods = ['fillRect', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'arc',
    'ellipse', 'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'transform', 'fillText', 'strokeText',
    'drawImage', 'quadraticCurveTo', 'clip', 'rect', 'arcTo', 'roundRect', 'bezierCurveTo', 'setLineDash', 'strokeRect'];
  for (const m of methods) {
    target[m] = function (...args) {
      if (strict) bad(m, args);
      if (strict && m === 'drawImage' && (!args[0] || typeof args[0] !== 'object')) throw new Error('drawImage of nothing');
      if (strict && (m === 'arc' || m === 'ellipse') && (args[2] < 0 || (m === 'ellipse' && args[3] < 0))) throw new Error(m + ' negative radius');
      log.calls[m] = (log.calls[m] || 0) + 1;
      if (log.onCall) log.onCall(m);
    };
  }
  const grad = () => ({ addColorStop(o) { if (strict && !(o >= 0 && o <= 1)) throw new Error('stop ' + o); } });
  target.createRadialGradient = (...a) => {
    if (strict) { bad('createRadialGradient', a); if (a[2] < 0 || a[5] < 0) throw new Error('negative radius'); }
    log.gradients++; return grad();
  };
  target.createLinearGradient = (...a) => { if (strict) bad('createLinearGradient', a); log.gradients++; return grad(); };
  target.measureText = (t) => ({ width: String(t).length * 8 });
  return target;
}

function makeEl(id, log, strict) {
  const handlers = {};
  const el = {
    id, width: 300, height: 150, disabled: false, textContent: '', hidden: false,
    style: { setProperty() {} },
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
      toggle(c, on) { if (on === undefined ? !this.set.has(c) : on) this.set.add(c); else this.set.delete(c); },
    },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    dispatch(type, ev) { for (const fn of handlers[type] || []) fn(Object.assign({ stopPropagation() {}, preventDefault() {} }, ev)); },
    getContext() { if (!el._ctx) { el._ctx = makeCtx(log, strict); el._ctx.canvas = el; } return el._ctx; },
  };
  return el;
}

/**
 * boot({ seed, width, height, hz, dpr, strict, embed, tutorial, replay, search, deferSession, math, clockStart })
 *   seed     what the session would mint (hex string)
 *   replay   { events, version, speed } to play a stored run back
 */
function boot(opts = {}) {
  const width = opts.width || 375, height = opts.height || 812;
  const hz = opts.hz || 60;
  const log = { calls: {}, gradients: 0 };
  const strict = opts.strict !== false;
  const listeners = {};
  const els = {};
  const trace = [];
  const results = [];
  let now = opts.clockStart || 0;
  let rafQ = [];
  let timers = [];
  let tutSeen = !opts.tutorial;
  const readyCbs = [];

  const doc = {
    documentElement: { clientWidth: width, clientHeight: height, style: { setProperty() {} } },
    visibilityState: 'visible', hidden: false,
    getElementById(id) { if (!els[id]) els[id] = makeEl(id, log, strict); return els[id]; },
    createElement() { return makeEl('c', log, strict); },
    addEventListener() {},
    body: { classList: { add() {} } },
  };
  const win = {
    document: doc, innerWidth: width, innerHeight: height,
    devicePixelRatio: opts.dpr || 2,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame(fn) { rafQ.push(fn); return rafQ.length; },
    setInterval() { throw new Error('the game must not rely on setInterval'); },
    setTimeout(fn, ms) { timers.push({ at: now + (ms || 0), fn }); return timers.length; },
    clearTimeout() {},
    performance: { now: () => now },
    console,
    Math: opts.math || Math, URLSearchParams,
    location: { search: opts.replay ? '?replay=1&tut=0' : (opts.search || '') },
    postMessage() {},
    __kjEmbed: opts.embed !== false,
    __kjSeed: opts.seed === undefined ? null : opts.seed,
    __kjOnSessionReady(cb) { if (opts.deferSession) readyCbs.push(cb); else cb(); },
    __kjGameStart(tHint, want) {
      const v = Number(want) >= 1 ? 1 : 0;
      trace.push({ type: 'input', payload: { kind: 'start', v, tHint } });
      return v;
    },
    __kjMove(tHint, n, dir, step) { trace.push({ type: 'input', payload: { kind: 'move', n, dir, step, tHint } }); },
    __kjSubmit(score) { results.push(score); },
  };
  if (opts.embed === false) { delete win.__kjOnSessionReady; delete win.__kjGameStart; delete win.__kjMove; delete win.__kjSubmit; win.__kjSubmit = (s) => results.push(s); }
  win.window = win; win.self = win; win.parent = win;
  win.KJTut = { shouldShow: () => !tutSeen, markSeen() { tutSeen = true; }, seen: () => tutSeen };
  if (opts.replay) win.__kjReplay = opts.replay;
  const ctx = vm.createContext(win);
  if (opts.replay) vm.runInContext(fs.readFileSync(REPLAY, 'utf8'), ctx, { filename: 'kj-replay.js' });
  vm.runInContext(gameSource(opts.source, opts.draw), ctx, { filename: 'game.js' });

  function runTimers() {
    for (;;) {
      let idx = -1;
      for (let i = 0; i < timers.length; i++) if (timers[i].at <= now && (idx < 0 || timers[i].at < timers[idx].at)) idx = i;
      if (idx < 0) break;
      const t = timers.splice(idx, 1)[0];
      t.fn();
    }
  }
  function frame() { const q = rafQ; rafQ = []; for (const fn of q) fn(now); }
  function advance(ms) {
    const dt = 1000 / hz;
    let left = ms;
    while (left > 1e-9) { const d = Math.min(dt, left); now += d; left -= d; runTimers(); frame(); }
  }
  // A hidden tab: time passes and timers fire, but no frame is drawn.
  function advanceHidden(ms) { const end = now + ms; while (now < end) { now = Math.min(end, now + 50); runTimers(); } }
  function frameAt(gapMs) { now += gapMs; runTimers(); frame(); }
  function fire(type, ev) { for (const fn of (listeners[type] || [])) fn(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev)); }
  let pid = 1;
  const DXs = [0, 1, 0, -1], DYs = [-1, 0, 1, 0];
  // One finger: down, a short flick (24 px over two moves), up.
  function swipe(dir, o = {}) {
    const id = o.id || pid++;
    const x = width * (o.x || 0.5), y = height * (o.y || 0.55), len = o.len || 24;
    fire('pointerdown', { pointerType: 'touch', pointerId: id, clientX: x, clientY: y });
    if (!o.flickOnly) {
      fire('pointermove', { pointerType: 'touch', pointerId: id, clientX: x + DXs[dir] * len * 0.5, clientY: y + DYs[dir] * len * 0.5 });
      fire('pointermove', { pointerType: 'touch', pointerId: id, clientX: x + DXs[dir] * len, clientY: y + DYs[dir] * len });
    }
    fire('pointerup', { pointerType: 'touch', pointerId: id, clientX: x + DXs[dir] * len, clientY: y + DYs[dir] * len });
  }
  const KEYS = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'];
  function key(dir, repeat) { fire('keydown', { key: typeof dir === 'number' ? KEYS[dir] : dir, repeat: !!repeat }); }
  function click(id) { doc.getElementById(id).dispatch('click', {}); }

  frame();
  return {
    win, log, trace, results, els, probe: () => win.__probe,
    advance, advanceHidden, frameAt, swipe, key, fire, click,
    clickPlay() { click('playBtn'); },
    readySession() { while (readyCbs.length) readyCbs.shift()(); },
    // From PLAY to the first live step (READY / GO plays out).
    start() { click('playBtn'); if (win.__probe.mode === 'howto') click('howOk'); let n = 0; while (win.__probe.mode !== 'play' && n++ < 600) advance(1000 / hz); },
    get now() { return now; },
    get timers() { return timers.length; },
  };
}

// ── planning, from the game's own rules ─────────────────────────────────────
// Shortest sequence of moves that paints every floor tile from the sim's
// current position and painted set (BFS), or null past the cap.
function planBfs(R, m, pos, painted, cap) {
  const N = m.w * m.h;
  const dest = new Int32Array(N * 4);
  for (let c = 0; c < N; c++) for (let d = 0; d < 4; d++) dest[c * 4 + d] = m.cells[c] ? R.slideEnd(m.cells, m.w, m.h, c, d) : c;
  const W = (N + 31) >> 5, mask0 = new Int32Array(W);
  let cnt0 = 0;
  for (let c = 0; c < N; c++) if (painted[c]) { mask0[c >> 5] |= 1 << (c & 31); cnt0++; }
  if (cnt0 === m.floors) return [];
  const seen = new Map();
  seen.set(pos + ':' + mask0.join(','), null);
  let frontier = [{ c: pos, m: mask0, key: pos + ':' + mask0.join(',') }];
  const parent = new Map();
  let states = 0;
  while (frontier.length) {
    const next = [];
    for (const st of frontier) {
      for (let d = 0; d < 4; d++) {
        const e = dest[st.c * 4 + d];
        if (e === st.c) continue;
        const mm = st.m.slice();
        let cc = st.c;
        const step = R.DX[d] + R.DY[d] * m.w;
        while (cc !== e) { cc += step; mm[cc >> 5] |= 1 << (cc & 31); }
        const key = e + ':' + mm.join(',');
        if (seen.has(key)) continue;
        seen.set(key, true);
        parent.set(key, { from: st.key, d });
        let cnt = 0;
        for (let k = 0; k < W; k++) { let v = mm[k] >>> 0; while (v) { v &= v - 1; cnt++; } }
        if (cnt === m.floors) {
          const out = []; let kk = key;
          while (parent.has(kk)) { const p = parent.get(kk); out.push(p.d); kk = p.from; }
          return out.reverse();
        }
        if (++states > cap) return null;
        next.push({ c: e, m: mm, key });
      }
    }
    frontier = next;
  }
  return null;
}
// What one slide in direction d would paint that is not painted yet.
function freshOf(R, m, pos, painted, d) {
  const e = R.slideEnd(m.cells, m.w, m.h, pos, d);
  let c = pos, n = 0;
  const step = R.DX[d] + R.DY[d] * m.w;
  while (c !== e) { c += step; if (!painted[c]) n++; }
  return { e, n };
}
// Nearest new paint by BFS over positions only: the fallback when the full
// plan is too big to search.
function greedyNext(R, m, pos, painted) {
  const N = m.w * m.h, seen = new Uint8Array(N);
  seen[pos] = 1;
  let q = [{ c: pos, first: -1 }];
  while (q.length) {
    const nq = [];
    for (const s of q) for (let d = 0; d < 4; d++) {
      const f = freshOf(R, m, s.c, painted, d);
      if (f.e === s.c) continue;
      const first = s.first < 0 ? d : s.first;
      if (f.n > 0) return first;
      if (!seen[f.e]) { seen[f.e] = 1; nq.push({ c: f.e, first }); }
    }
    q = nq;
  }
  return 0;
}
function openDirs(R, sim) {
  const out = [];
  for (let d = 0; d < 4; d++) if (!R.blockedAt(sim, sim.bx, sim.by, d)) out.push(d);
  return out;
}

// ── pilots ─────────────────────────────────────────────────────────────────
// A human pilot looks at a new maze for `read` steps (more for more floor),
// then plays the shortest route it can find, waiting `think` steps (gauss) at
// each rest. With chance `err` it misreads and swipes another open way, then
// replans from where it is. With chance `ahead` it sends the next swipe while
// the ball still rolls. Skill = read, think, err, ahead.
const PILOTS = {
  flawless: { plan: true, read: 0, readPer: 0, think: 0, sd: 0, err: 0, ahead: 1 },
  bot: { plan: true, read: 0, readPer: 0, think: 10, sd: 0, err: 0, ahead: 0 },
  good: { plan: true, read: 30, readPer: 1.2, think: 16, sd: 6, err: 0.05, ahead: 0.35 },
  average: { plan: true, read: 60, readPer: 2.4, think: 28, sd: 10, err: 0.12, ahead: 0.12 },
  novice: { plan: true, read: 90, readPer: 3.6, think: 46, sd: 18, err: 0.22, ahead: 0 },
  greedy: { greedy: true, think: 0, sd: 0 },   // a bot with no plan: the open way that paints most, at once
  lazy: { greedy: true, think: 16, sd: 6 },    // a human with no plan: the same, at a good player's pace
  cycler: { cycle: true, think: 0 },           // laziest: up, right, down, left, forever
  spammer: { spam: 4 },                        // a random swipe every 4 steps
  idle: { idle: true },
  multi: { plan: true, read: 30, readPer: 1.2, think: 16, sd: 6, err: 0.05, ahead: 0.35, fingers: 3 },
};

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd) { return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd()); }

/**
 * fly(g, pilot, { maxSteps, rngSeed, hz, keys, onStep, cap }) flies one run to
 * the end of the clock. Decisions are taken once per GAME step, never per frame.
 */
function fly(g, pilotName, opts = {}) {
  const p = typeof pilotName === 'string' ? PILOTS[pilotName] : pilotName;
  const rnd = mulberry(opts.rngSeed || 7);
  const hz = opts.hz || 60;
  const maxSteps = opts.maxSteps || 60 * 60 * 10;
  const cap = opts.cap || 200000;
  if (g.probe().mode !== 'play') g.start();
  const pr = g.probe(), R = pr.rules;
  let aheadTried = false, lastStep = -1, plan = null, planMaze = 0, wakeAt = -1, sent = -1, cyc = 0, guard = 0, mazeSeen = 0, wasRest = false;
  const send = (d) => {
    if (opts.keys && rnd() < 0.4) g.key(d);
    else {
      // extra fingers land first and rest (a thumb, a palm): they must add nothing
      if (p.fingers) for (let f = 1; f < p.fingers; f++) g.fire('pointerdown', { pointerType: 'touch', pointerId: 9000 + f, clientX: 40 * f, clientY: 300 });
      g.swipe(d, { flickOnly: rnd() < 0.2, len: 14 + Math.floor(rnd() * 30) });
      if (p.fingers) {
        for (let f = 1; f < p.fingers; f++) g.fire('pointerup', { pointerType: 'touch', pointerId: 9000 + f, clientX: 40 * f, clientY: 300 });
      }
    }
    sent = pr.sim.inputs;
  };
  const replan = (sim) => {
    const pos = sim.by * sim.maze.w + sim.bx;
    plan = planBfs(R, sim.maze, pos, sim.painted, cap);
    // too big to search: at the maze's start the designed route is known good
    if (!plan && sim.moves === 0 && pos === sim.maze.start) plan = sim.maze.path.slice();
    planMaze = sim.n;
  };
  while (!pr.sim.over && pr.sim.step < maxSteps && guard++ < maxSteps * 4) {
    const sim = pr.sim;
    if (sim.step !== lastStep) {
      lastStep = sim.step;
      if (opts.onStep) opts.onStep(sim);
      const waiting = sent >= 0 && sim.inputs === sent;         // our last swipe has not landed yet
      const rest = sim.dir < 0 && sim.pause === 0;
      if (p.idle || waiting) { /* nothing */ }
      else if (p.spam) { if (sim.step % p.spam === 0) send(Math.floor(rnd() * 4)); }
      else if (p.cycle) { if (rest && sim.queued < 0) { send(cyc & 3); cyc++; } }
      else if (p.greedy) {
        if (rest && !wasRest) wakeAt = sim.step + Math.max(0, Math.round(p.think + gauss(rnd) * p.sd));
        if (rest && sim.queued < 0 && sim.step >= wakeAt) {
          const pos = sim.by * sim.maze.w + sim.bx;
          let best = -1, bn = -1;
          const ds = openDirs(R, sim);
          for (const d of ds) { const n = freshOf(R, sim.maze, pos, sim.painted, d).n + rnd() * 0.5; if (n > bn) { bn = n; best = d; } }
          if (bn < 1) best = ds[Math.floor(rnd() * ds.length)];
          send(best);
        }
      } else if (p.plan && sim.pause === 0) {
        if (sim.n !== mazeSeen) {
          mazeSeen = sim.n; plan = null;
          wakeAt = sim.step + Math.round(p.read + p.readPer * sim.maze.floors);
        }
        // the ball came to rest: look, then think
        if (rest && !wasRest && sim.step > wakeAt) wakeAt = sim.step + Math.max(0, Math.round(p.think + gauss(rnd) * p.sd));
        if (!rest) aheadTried = aheadTried && sim.sub !== 0;
        if (sim.queued < 0 && sim.step >= wakeAt) {
          if (rest) {
            if (!plan || planMaze !== sim.n || (plan.length && R.blockedAt(sim, sim.bx, sim.by, plan[0]))) replan(sim);
            let d = plan && plan.length ? plan[0] : greedyNext(R, sim.maze, sim.by * sim.maze.w + sim.bx, sim.painted);
            if (p.err && rnd() < p.err) {
              const ds = openDirs(R, sim).filter((x) => x !== d);
              if (ds.length) { d = ds[Math.floor(rnd() * ds.length)]; plan = null; }
            } else if (plan && plan.length) plan = plan.slice(1);
            send(d);
            aheadTried = false;
          } else if (!aheadTried && sim.sub === 1) {
            // while the ball rolls, sometimes send the move after this one
            aheadTried = true;
            if (plan && plan.length && rnd() < p.ahead) { send(plan[0]); plan = plan.slice(1); }
          }
        }
      }
      wasRest = sim.dir < 0 && sim.pause === 0;
    }
    g.advance(1000 / hz);
  }
  g.advance(8000);   // the end screen plays out and the score goes
  return { score: pr.sim.score, step: pr.sim.step, over: pr.sim.over, mazes: pr.sim.mazes, perfects: pr.sim.perfects, sim: pr.sim };
}

function seedHex(i) {
  let h = '';
  let a = (i * 2654435761) >>> 0;
  for (let k = 0; k < 4; k++) { a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) >>> 0; h += a.toString(16).padStart(8, '0'); }
  return h;
}

module.exports = { boot, fly, PILOTS, seedHex, gameSource, planBfs, freshOf, greedyNext, GAME, DIR, ROOT };
