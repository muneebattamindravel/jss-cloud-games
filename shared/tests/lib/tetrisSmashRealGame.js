'use strict';

/**
 * Flies the REAL Tetris Smash page in a sandbox: the bridge script from
 * games/tetris-smash/index.html (with a recording SDK in place of kj-sdk-v2),
 * the real rules.js and game.js, and the real kj-press.js, kj-fit.js and
 * kj-replay.js. Timers and intervals run on a fake clock (never stubbed), and
 * frames come from a fake requestAnimationFrame at the chosen refresh rate.
 * Pilots act through real pointer and key events, so the input path under test
 * is the one a phone uses.
 *
 * The pilots plan with the GAME's own rules (window.TS inside the sandbox),
 * never with the validator, so the thing under test never chooses its own
 * inputs. They decide once per STEP, never per frame.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'games', 'tetris-smash');
const GAME = path.join(DIR, 'js', 'game.js');
const RULES = path.join(DIR, 'js', 'rules.js');
const HTML = path.join(DIR, 'index.html');
const PRESS = path.join(ROOT, 'games', '_shared', 'kj-press.js');
const FIT = path.join(ROOT, 'games', '_shared', 'kj-fit.js');
const REPLAY = path.join(ROOT, 'games', '_shared', 'kj-replay.js');
const TUT = path.join(ROOT, 'games', '_shared', 'kj-tutorial-state.js');

// A test-only probe appended inside the game's closure. It reads, never writes.
const PROBE = `
  window.__probe = {
    get st() { return st; }, get sim() { return st && st.sim; }, get tut() { return tut; }, get mode() { return mode; },
    get acc() { return acc; }, get pending() { return pending; }, get buffered() { return buffered; },
    get gesture() { return gesture; }, get fit() { return fit; }, get sessionReady() { return sessionReady; },
    get traceVersion() { return traceVersion; }, get runsStarted() { return runsStarted; }, G: G,
  };
`;
const STEP_CALL = '    if (!sim.dead) G.stepSim(sim);\n    handleEvents(sim, st);\n';
const RENDER_CALL = 'pump(now); resize(); render(now, dt); requestAnimationFrame(frame);';
const BOOT_CALL = '  resize(); requestAnimationFrame(frame);\n})();';

function gameSource(src, draw) {
  let s = src || fs.readFileSync(GAME, 'utf8');
  if (!draw) {
    if (!s.includes(RENDER_CALL)) throw new Error('render call not found; update the harness');
    s = s.replace(RENDER_CALL, 'pump(now); resize(); if (window.__draw) render(now, dt); requestAnimationFrame(frame);');
  }
  if (!s.includes(STEP_CALL)) throw new Error('step call not found; update the harness');
  s = s.replace(STEP_CALL, STEP_CALL + '    if (window.__onStep) window.__onStep(sim);\n');
  if (!s.includes(BOOT_CALL)) throw new Error('boot call not found; update the harness');
  return s.replace(BOOT_CALL, PROBE + BOOT_CALL);
}

// The page's own bridge: the inline script after the SDK tag in index.html.
function bridgeSource(html) {
  const h = html || fs.readFileSync(HTML, 'utf8');
  const a = h.indexOf('<script>', h.indexOf('kj-sdk-v2.js'));
  const b = h.indexOf('</script>', a);
  if (a < 0 || b < 0) throw new Error('bridge script not found; update the harness');
  return h.slice(a + 8, b);
}

// ── a canvas that records and refuses nonsense ─────────────────────────────
function makeCtx(log, strict) {
  const bad = (name, args) => {
    for (const a of args) {
      if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${name} got ${a}`);
    }
  };
  const props = {
    canvas: null, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000',
    strokeStyle: '#000', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', letterSpacing: '0px',
    lineJoin: 'miter', lineCap: 'butt', imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
  };
  const target = {};
  const methods = ['fillRect', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke',
    'arc', 'ellipse', 'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'transform',
    'fillText', 'strokeText', 'drawImage', 'quadraticCurveTo', 'clip', 'rect', 'arcTo', 'bezierCurveTo',
    'setLineDash', 'strokeRect'];
  for (const m of methods) {
    target[m] = function (...args) {
      if (strict) bad(m, args);
      log.calls[m] = (log.calls[m] || 0) + 1;
    };
  }
  const grad = () => ({ addColorStop(o) { if (strict && !(o >= 0 && o <= 1)) throw new Error('stop ' + o); } });
  target.createRadialGradient = (...a) => {
    if (strict) { bad('createRadialGradient', a); if (a[2] < 0 || a[5] < 0) throw new Error('negative radius'); }
    log.gradients++; return grad();
  };
  target.createLinearGradient = (...a) => { if (strict) bad('createLinearGradient', a); log.gradients++; return grad(); };
  target.measureText = (t) => ({ width: String(t).length * 8 });
  // Property writes are checked in strict mode; reads of anything else are
  // not numbers, so a draw path that reads a value back (g.lineWidth * 2) shows.
  return new Proxy(target, {
    get(t, k) { if (k in t) return t[k]; if (k in props) return props[k]; return strict ? undefined : 0; },
    set(t, k, v) {
      if (strict && typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${String(k)} = ${v}`);
      if (strict && k === 'globalAlpha' && (v < 0 || v > 1.0001)) log.badAlpha++;
      props[k] = v; return true;
    },
  });
}

function makeEl(id, log, strict) {
  const handlers = {};
  const el = {
    id, width: 300, height: 150, disabled: false, textContent: '', hidden: false,
    style: { setProperty() {} },
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
    },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    _fire(type, ev) { for (const fn of (handlers[type] || [])) fn(ev || {}); },
    getContext() { if (!el._ctx) { el._ctx = makeCtx(log, strict); } return el._ctx; },
    toDataURL() { return 'data:image/png;base64,'; },
  };
  return el;
}

/**
 * boot({ seed, width, height, hz, dpr, strict, embed, tutorial, replay, search, deferSession, math, clockStart })
 *   seed     16+ hex chars, what the session would mint
 *   embed    inside the platform (default) or standalone
 *   replay   { events, version, speed } to play a stored run back (?replay=1)
 */
function boot(opts = {}) {
  const width = opts.width || 375, height = opts.height || 812;
  const hz = opts.hz || 60;
  const log = { calls: {}, gradients: 0, badAlpha: 0 };
  const strict = opts.strict !== false;
  const listeners = {};
  const docListeners = {};
  const els = {};
  const trace = [];          // what kjEmit recorded: the trace the server would get
  const results = [];        // what reached kjSubmitV2
  const posted = [];         // postMessage to the parent
  let now = opts.clockStart || 0;
  let rafQ = [];
  const timers = [];
  let tutSeen = !opts.tutorial;
  const embed = opts.embed !== false;
  const seed = opts.seed === undefined ? '0123456789abcdef0123456789abcdef' : opts.seed;

  const doc = {
    documentElement: { clientWidth: width, clientHeight: height, style: { setProperty() {} } },
    hidden: false, visibilityState: 'visible',
    getElementById(id) { if (!els[id]) els[id] = makeEl(id, log, strict); return els[id]; },
    createElement() { return makeEl('c', log, strict); },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    body: { classList: { set: new Set(), add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } } },
  };
  // The thenables resolve synchronously, so a test needs no await.
  const sync = (value) => ({ then(f) { const r = f ? f(value) : value; return sync(r); }, catch() { return sync(value); } });
  const parent = embed ? { postMessage(m) { posted.push(m); } } : null;
  const win = {
    document: doc,
    devicePixelRatio: opts.dpr || 2,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame(fn) { rafQ.push(fn); return rafQ.length; },
    setTimeout(fn, ms) { timers.push({ at: now + (ms || 0), fn }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1] = null; },
    setInterval(fn, ms) { const t = { at: now + ms, every: ms, fn }; timers.push(t); return timers.length; },
    clearInterval(id) { if (timers[id - 1]) timers[id - 1] = null; },
    performance: { now: () => now },
    console,
    Math: opts.math || Math, JSON, Date, Object, Array, Number, String, Promise, Set, Map, Proxy,
    parseInt, parseFloat, isFinite, Float32Array, Uint8Array, URLSearchParams, Error,
    location: { search: opts.replay ? '?replay=1&tut=0' : (opts.search || ''), pathname: '/games/tetris-smash/index.html' },
    // The SDK, recorded instead of sent.
    kjStartV2() { win.__kjSeed = seed; return sync({ seed }); },
    kjEmit(type, payload) { trace.push({ type, payload }); },
    kjSubmitV2(o) { results.push(o.clientClaimedScore); return sync({ authoritativeScore: o.clientClaimedScore }); },
  };
  win.window = win;
  win.self = win;
  win.parent = embed ? parent : win;
  win.postMessage = function (m) { posted.push(m); };
  win.KJTut = { shouldShow: () => !tutSeen, markSeen() { tutSeen = true; }, seen: () => tutSeen };
  if (opts.replay) win.__kjReplay = opts.replay;
  const ctx = vm.createContext(win);
  // realTut: the platform's own kj-tutorial-state.js (it reads ?tut and its storage) instead of the switch above.
  if (opts.realTut) vm.runInContext(fs.readFileSync(TUT, 'utf8'), ctx, { filename: 'kj-tutorial-state.js' });
  vm.runInContext(fs.readFileSync(PRESS, 'utf8'), ctx, { filename: 'kj-press.js' });
  vm.runInContext(fs.readFileSync(REPLAY, 'utf8'), ctx, { filename: 'kj-replay.js' });
  vm.runInContext(fs.readFileSync(FIT, 'utf8'), ctx, { filename: 'kj-fit.js' });
  vm.runInContext(opts.rules || fs.readFileSync(RULES, 'utf8'), ctx, { filename: 'rules.js' });
  // index.html order: rules.js, game.js (defer), the SDK, the bridge; a
  // deferred script runs after the bridge.
  vm.runInContext(opts.bridge || bridgeSource(), ctx, { filename: 'bridge.js' });
  vm.runInContext(gameSource(opts.source, opts.draw), ctx, { filename: 'game.js' });

  function fireWin(type, ev) { for (const fn of (listeners[type] || [])) fn(ev); }
  function runTimers() {
    for (let i = 0; i < timers.length; i++) {
      const t = timers[i];
      if (t && t.at <= now) {
        if (t.every) t.at += t.every; else timers[i] = null;
        t.fn();
      }
    }
  }
  function frame() {
    const q = rafQ; rafQ = [];
    for (const fn of q) fn(now);
  }
  function advance(ms) {
    const dt = 1000 / hz;
    let left = ms;
    while (left > 1e-9) { const d = Math.min(dt, left); now += d; left -= d; runTimers(); if (!doc.hidden) frame(); }
  }
  // A hidden tab: time passes and timers fire, but no frame is drawn.
  function hide(on) { doc.hidden = on; doc.visibilityState = on ? 'hidden' : 'visible'; for (const fn of (docListeners.visibilitychange || [])) fn({}); }
  function advanceHidden(ms) { const was = doc.hidden; hide(true); const step = 100; for (let t = 0; t < ms; t += step) { now += step; runTimers(); } hide(was); }
  function frameAt(gapMs) { now += gapMs; runTimers(); frame(); }

  const canvas = doc.getElementById('game');
  const pr = () => win.__probe;
  // Client px of a design point.
  function client(x, y) { const f = pr().fit; return { x: x * f.s + f.offX, y: y * f.s + f.offY }; }
  let pid = 1;
  const touch = { id: 0, x: 0, y: 0 };
  function down(x, y) {
    touch.id = pid++; touch.x = x; touch.y = y;
    fireWin('pointerdown', { pointerType: 'touch', pointerId: touch.id, clientX: x, clientY: y, target: canvas, isTrusted: true });
  }
  function move(x, y) { touch.x = x; touch.y = y; fireWin('pointermove', { pointerType: 'touch', pointerId: touch.id, clientX: x, clientY: y, target: canvas }); }
  function up() {
    fireWin('pointerup', { pointerType: 'touch', pointerId: touch.id, clientX: touch.x, clientY: touch.y, target: canvas });
    fireWin('touchend', { touches: [] });
  }
  function key(code, isUp) { fireWin(isUp ? 'keyup' : 'keydown', { code, repeat: false, preventDefault() {} }); }
  function click(id) { const b = doc.getElementById(id); b._fire('click', {}); }
  function sendConfig() { fireWin('message', { data: { type: 'KJ_CONFIG' } }); }

  if (embed && !opts.deferSession) sendConfig();
  frame();
  return {
    win, log, trace, results, posted, els, canvas, probe: pr, doc,
    advance, advanceHidden, frameAt, hide, down, move, up, key, click, client, fireWin,
    clickPlay() { click('playBtn'); },
    clickHow() { click('howBtn'); },
    readySession() { sendConfig(); },
    get now() { return now; },
    hz,
  };
}

// ── gestures (design px, as the founder's controls define them) ───────────
// One gesture spans steps: a tap is down then up 3 frames later; a drag moves
// one column per MOVE_PX of finger travel; a swipe down is 60 px in 4 frames.
const MOVE_PX = 24, AXIS_PX = 12;
function gesturePlan(kind, arg) {
  if (kind === 'tap') return [{ t: 'down', dx: 0, dy: 0 }, { t: 'wait' }, { t: 'wait' }, { t: 'up' }];
  if (kind === 'drag') {
    // arg = columns (signed). The finger locks to the axis, then crosses one
    // column threshold per frame.
    const sgn = arg < 0 ? -1 : 1, n = Math.abs(arg), out = [{ t: 'down', dx: 0, dy: 0 }, { t: 'move', dx: sgn * (AXIS_PX + 1), dy: 0 }];
    for (let i = 1; i <= n; i++) out.push({ t: 'move', dx: sgn * (i * MOVE_PX + 1), dy: 1 });
    out.push({ t: 'up' });
    return out;
  }
  if (kind === 'swipe') return [{ t: 'down', dx: 0, dy: 0 }, { t: 'move', dx: 1, dy: 20 }, { t: 'move', dx: 2, dy: 60 }, { t: 'up' }];
  throw new Error('gesture ' + kind);
}

// ── placement search with the game's own rules ─────────────────────────────
// Every (turns, shift) reachable from the piece's place by `turns` clockwise
// turns then `shift` moves, hard-dropped; scored on the board it leaves.
function boardScore(G, board, lines, style) {
  const C = G.COLS, R = G.ROWS;
  let holes = 0, agg = 0, bump = 0, prev = -1, maxH = 0, wells = 0;
  const hs = [];
  for (let x = 0; x < C; x++) {
    let h = 0, seen = false;
    for (let y = 0; y < R; y++) {
      if (board[y * C + x]) { if (!seen) { seen = true; h = R - y; } }
      else if (seen) holes++;
    }
    hs.push(h); agg += h; maxH = Math.max(maxH, h);
    if (prev >= 0) bump += Math.abs(h - prev);
    prev = h;
  }
  for (let x = 0; x < C; x++) {
    const l = x > 0 ? hs[x - 1] : 99, r = x < C - 1 ? hs[x + 1] : 99, d = Math.min(l, r) - hs[x];
    if (d > 2) wells += d;
  }
  if (style === 'builder') {
    // Keep the right column open and save up for fours; clear smaller only when high.
    const danger = maxH > 12;
    const lineVal = lines === 4 ? 60 : danger ? lines * 7.6 : -lines * 4;
    const inWell = hs[C - 1];
    return lineVal - agg * 0.51 - holes * 3.6 - (bump - Math.abs(hs[C - 1] - hs[C - 2])) * 0.18 - inWell * (danger ? 0.5 : 6) - (maxH > 14 ? (maxH - 14) * 4 : 0);
  }
  return lines * 7.6 - agg * 0.51 - holes * 3.6 - bump * 0.18 - wells * 0.3 - (maxH > 14 ? (maxH - 14) * 4 : 0);
}
function placements(G, sim, style) {
  const out = [];
  if (!sim.cur) return out;
  const turnsList = sim.cur.t === 1 ? [0] : [0, 1, 2, 3];
  for (const turns of turnsList) {
    for (let shift = -6; shift <= 6; shift++) {
      const c = Object.assign({}, sim);
      c.ev = [];
      const acts = [];
      let ok = true;
      for (let i = 0; i < turns && ok; i++) { ok = G.actSim(c, G.A_CW) === true; acts.push(G.A_CW); }
      const a = shift < 0 ? G.A_LEFT : G.A_RIGHT;
      for (let i = 0; i < Math.abs(shift) && ok; i++) { ok = G.actSim(c, a) === true; acts.push(a); }
      if (!ok) continue;
      const lines0 = c.lines;
      if (G.actSim(c, G.A_HARD) !== true) continue;
      out.push({ turns, shift, acts, score: boardScore(G, c.board, c.lines - lines0, style) + (c.score - sim.score) * 0.0001, dead: c.dead });
    }
  }
  return out;
}

// ── pilots ─────────────────────────────────────────────────────────────────
// A human pilot looks at a new piece for `lag` steps, picks a place (its
// judgement has `noise`; a slip picks a neighbour column with `miss`), then
// performs the gestures one after another with `gap` steps between them. A
// `waste` share of pieces gets an extra move out and back (slower finesse).
// The flawless planner places every piece on the step it appears, perfectly.
const PILOTS = {
  flawless: { flawless: true },
  builder: { flawless: true, style: 'builder' },
  // Keys only: turns the short way (anticlockwise for three), soft-drops to the
  // floor, then wiggles there until the reset cap runs out and the lock takes it.
  fiddler: { fiddle: true },
  good: { lag: 12, gap: 3, noise: 0.3, miss: 0.02, waste: 0.1 },
  average: { lag: 22, gap: 6, noise: 0.8, miss: 0.05, waste: 0.25 },
  novice: { lag: 36, gap: 10, noise: 1.8, miss: 0.1, waste: 0.4 },
  spammer: { spam: true },
  idle: { idle: true },
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
 * fly(g, pilot, { maxSteps, rngSeed, keys, onStep }) flies one run. Decisions
 * happen once per game STEP; the finger moves once per frame.
 */
function fly(g, pilotName, opts = {}) {
  const p = typeof pilotName === 'string' ? PILOTS[pilotName] : pilotName;
  const rnd = mulberry(opts.rngSeed || 7);
  const maxSteps = opts.maxSteps || 60 * 60 * 6;
  if (g.probe().mode !== 'play') g.clickPlay();
  const pr = g.probe(), G = pr.G;
  const queue = [];           // gestures still to perform: { kind, arg, at }
  let cur = null, curK = -1, lastFrame = -1, guard = 0, gestureSteps = null, script = [], softHeld = false, nextKey = 0;
  const anchor = () => g.client(186, 520);
  function startGesture(kind, arg) { gestureSteps = gesturePlan(kind, arg).slice(); }
  function fingerFrame() {
    if (!gestureSteps || !gestureSteps.length) return false;
    const s = gestureSteps.shift(), a = anchor(), k = pr.fit.s;
    if (s.t === 'down') g.down(a.x, a.y);
    else if (s.t === 'move') g.move(a.x + s.dx * k, a.y + s.dy * k);
    else if (s.t === 'up') { g.up(); gestureSteps = null; }
    return true;
  }
  function keysFor(acts) {
    for (const a of acts) {
      const code = a === G.A_LEFT ? 'ArrowLeft' : a === G.A_RIGHT ? 'ArrowRight' : a === G.A_CW ? 'ArrowUp' : a === G.A_CCW ? 'KeyZ' : 'Space';
      g.key(code); g.key(code, true);
    }
  }
  function plan(sim) {
    const list = placements(G, sim, p.style);
    if (!list.length) return null;
    let best = null, bs = -Infinity;
    for (const c of list) { const s = c.score + (p.noise ? gauss(rnd) * p.noise : 0); if (s > bs) { bs = s; best = c; } }
    return best;
  }
  while (pr.mode === 'play' && pr.sim.frame < maxSteps && guard < maxSteps * 6) {
    guard++;
    const sim = pr.sim;
    if (sim.frame !== lastFrame) {
      lastFrame = sim.frame;
      if (opts.onStep) opts.onStep(sim);
      if (p.spam) {
        if (!gestureSteps) { const r = rnd(); startGesture(r < 0.4 ? 'tap' : r < 0.8 ? 'drag' : 'swipe', (rnd() < 0.5 ? -1 : 1) * (1 + Math.floor(rnd() * 3))); }
      } else if (p.fiddle) {
        if (sim.cur && sim.k !== curK) {
          curK = sim.k;
          const best = plan(sim);
          script = [];
          if (best) {
            if (best.turns === 3) script.push({ code: 'KeyZ' }); else for (let i = 0; i < best.turns; i++) script.push({ code: 'ArrowUp' });
            const mv = best.shift < 0 ? 'ArrowLeft' : 'ArrowRight';
            for (let i = 0; i < Math.abs(best.shift); i++) script.push({ code: mv });
            script.push({ soft: true });
            for (let i = 0; i < 20; i++) script.push({ code: i % 2 ? mv === 'ArrowLeft' ? 'ArrowLeft' : 'ArrowRight' : mv === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft', ground: true, every: 4 });
          }
        }
        if (!sim.cur && softHeld) { g.key('ArrowDown', true); softHeld = false; }
        if (sim.cur && script.length && sim.frame >= nextKey) {
          const s0 = script[0];
          const grounded = !G.fits(sim.board, sim.cur.t, sim.cur.r, sim.cur.x, sim.cur.y + 1);
          if (s0.soft) { if (!softHeld) { g.key('ArrowDown'); softHeld = true; } script.shift(); }
          else if (!s0.ground || grounded) { g.key(s0.code); g.key(s0.code, true); script.shift(); nextKey = sim.frame + (s0.every || 1); }
        }
      } else if (p.flawless) {
        if (sim.cur && sim.k !== curK) {
          curK = sim.k;
          const best = plan(sim);
          if (best) keysFor(best.acts.concat([G.A_HARD]));
        }
      } else if (!p.idle) {
        if (sim.cur && sim.k !== curK) {
          curK = sim.k;
          cur = plan(sim);
          queue.length = 0;
          if (cur) {
            let shift = cur.shift;
            if (rnd() < p.miss) shift += rnd() < 0.5 ? -1 : 1;
            const at = sim.frame + Math.max(1, Math.round(p.lag + gauss(rnd) * p.lag * 0.25));
            for (let i = 0; i < cur.turns; i++) queue.push({ kind: 'tap', at });
            if (rnd() < p.waste) { const w = shift >= 0 ? -1 : 1; queue.push({ kind: 'drag', arg: w, at }); shift -= w; }
            if (shift) queue.push({ kind: 'drag', arg: shift, at });
            queue.push({ kind: 'swipe', at });
          }
        }
        if (!gestureSteps && queue.length && sim.frame >= queue[0].at) {
          const q = queue.shift();
          startGesture(q.kind, q.arg);
          if (queue.length) queue[0].at = Math.max(queue[0].at, sim.frame + p.gap);
        }
      }
    }
    fingerFrame();
    g.advance(1000 / g.hz);
  }
  if (gestureSteps) { g.up(); gestureSteps = null; }
  g.advance(8000);   // the end card plays out and the score goes
  return { score: pr.sim.score, frame: pr.sim.frame, dead: pr.sim.dead, end: pr.sim.end, lines: pr.sim.lines, level: pr.sim.level, sim: pr.sim };
}

function seedHex(i) {
  let h = '';
  let a = (i * 2654435761) >>> 0;
  for (let k = 0; k < 4; k++) { a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) >>> 0; h += a.toString(16).padStart(8, '0'); }
  return h;
}

module.exports = { boot, fly, PILOTS, seedHex, gameSource, bridgeSource, placements, boardScore, GAME, RULES, HTML, DIR, ROOT };
