'use strict';

/**
 * Flies the REAL games/pearls-connect/js/game.js in a sandbox: a fake window, a
 * fake clock and frame loop (timers run on it, never stubbed away), a
 * recording canvas, and the bridge's contract recorded instead of sent. Chains
 * are drawn with real pointer events on the canvas, so the input path under
 * test is the one a phone uses.
 *
 * The pilots decide from what the game shows (the probe's sim and the game's
 * OWN rules functions), never from the validator, so the thing under test
 * never chooses its own inputs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'games', 'pearls-connect');
const GAME = path.join(DIR, 'js', 'game.js');
const REPLAY = path.join(ROOT, 'games', '_shared', 'kj-replay.js');
const W = 414, H = 736, CELL = 62, GY = 200;
const GX = (W - 6 * CELL) / 2;

// A test-only probe appended inside the game's closure. It reads, never writes.
const PROBE = `
  window.__probe = {
    get sim() { return sim; }, get state() { return state; }, get traceVersion() { return traceVersion; },
    get submitted() { return submitted; }, get chain() { return chain; }, get fx() { return fx; }, get board() { return board; },
    rules: { initSim: initSim, stepSim: stepSim, chainSim: chainSim, readChain: readChain, adjacent: adjacent,
      chainPoints: chainPoints, hasPair: hasPair, N: N, CELLS: CELLS, KINDS: KINDS, RUN_STEPS: RUN_STEPS, LOOP_MIN: LOOP_MIN },
  };
`;

// After every step the game runs, a test hook sees the world (read only).
const STEP_CALL = 'stepSim(sim); acc -= STEP_MS; n++;';
const RENDER_CALL = '    render();\n    renderTop();';
function gameSource(src, draw) {
  let s = src || fs.readFileSync(GAME, 'utf8');
  if (!draw) {
    if (!s.includes(RENDER_CALL)) throw new Error('render call not found; update the harness');
    s = s.replace(RENDER_CALL, '    if (window.__draw) { render(); renderTop(); }');
  }
  if (!s.includes(STEP_CALL)) throw new Error('step call not found; update the harness');
  s = s.replace(STEP_CALL, STEP_CALL + ' if (window.__onStep) window.__onStep(sim);');
  const end = s.lastIndexOf('requestAnimationFrame(frame);');
  if (end < 0) throw new Error('frame start not found; update the harness');
  return s.slice(0, end) + PROBE + s.slice(end);
}

// ── a canvas that records and refuses nonsense ─────────────────────────────
function makeCtx(log, strict) {
  const bad = (name, args) => {
    for (const a of args) {
      if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${name} got ${a}`);
    }
  };
  const target = {
    canvas: null, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000',
    strokeStyle: '#000', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    lineCap: 'butt', lineJoin: 'miter', shadowColor: 'transparent', shadowBlur: 0, shadowOffsetY: 0,
  };
  const methods = ['fillRect', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke',
    'arc', 'ellipse', 'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'transform',
    'fillText', 'drawImage', 'quadraticCurveTo', 'clip', 'rect', 'arcTo', 'bezierCurveTo', 'strokeText', 'strokeRect'];
  for (const m of methods) {
    target[m] = function (...args) {
      if (strict) bad(m, args);
      if (strict && (m === 'arc' || m === 'ellipse') && args[2] < 0) throw new Error(m + ' negative radius');
      log.calls[m] = (log.calls[m] || 0) + 1;
    };
  }
  const grad = () => ({ addColorStop(o) { if (strict && !(o >= 0 && o <= 1)) throw new Error('stop ' + o); } });
  target.createRadialGradient = (...a) => {
    if (strict) { bad('createRadialGradient', a); if (a[2] < 0 || a[5] < 0) throw new Error('negative radius'); }
    log.gradients++; return grad();
  };
  target.createLinearGradient = (...a) => { if (strict) bad('createLinearGradient', a); log.gradients++; return grad(); };
  target.measureText = (t) => ({ width: String(t).length * 12 });
  return target;
}

function makeEl(id, log, strict) {
  const listeners = {};
  const el = {
    id, width: 300, height: 150, disabled: false, textContent: '', onclick: null, hidden: false, tagName: 'DIV',
    style: { setProperty() {} },
    classList: {
      set: new Set(['is-hidden']),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
    },
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getContext() { if (!el._ctx) { el._ctx = makeCtx(log, strict); el._ctx.canvas = el; } return el._ctx; },
  };
  return el;
}

/**
 * boot({ seed, width, height, hz, dpr, strict, embed, version, tutorial, replay, search, math, deferSession })
 *   seed     16+ hex chars, what the session would mint
 *   version  what the bridge answers to __kjGameStart (2 by default)
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
  const timers = [];
  let tutSeen = !opts.tutorial;
  const readyCbs = [];

  const doc = {
    documentElement: { clientWidth: width, clientHeight: height, style: { setProperty() {} } },
    visibilityState: 'visible',
    getElementById(id) { if (!els[id]) { els[id] = makeEl(id, log, strict); if (id === 'menu') els[id].classList.remove('is-hidden'); } return els[id]; },
    createElement() { return makeEl('c', log, strict); },
    addEventListener() {},
    body: { classList: { add() {} } },
  };
  const win = {
    document: doc,
    devicePixelRatio: opts.dpr || 2,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame(fn) { rafQ.push(fn); return rafQ.length; },
    setInterval() { return 0; },
    setTimeout(fn, ms) { timers.push({ at: now + (ms || 0), fn }); return timers.length; },
    clearTimeout() {},
    performance: { now: () => now },
    console,
    Math: opts.math || Math, JSON, Date, Object, Array, Number, String, Promise, Set, Map, RegExp, parseInt, parseFloat, isFinite, URLSearchParams,
    location: { search: opts.replay ? '?replay=1&tut=0' : (opts.search || '') },
    postMessage() {},
    __kjEmbed: opts.embed !== false,
    __kjSeed: opts.seed || null,
    __pcHarness: true,
    // The bridge's contract, recorded instead of sent.
    __kjOnSessionReady(cb) { if (opts.deferSession) readyCbs.push(cb); else cb(); },
    __kjGameStart(tHint, want) {
      const v = opts.version != null ? opts.version : (Number(want) >= 2 ? 2 : 1);
      trace.push({ type: 'input', payload: { kind: 'start', v, tHint } });
      return v;
    },
    __kjChain(tHint, n, step, down, cells) {
      trace.push({ type: 'input', payload: { kind: 'chain', n, step, down, cells: cells.slice(), tHint } });
    },
    __kjSubmit(score) { results.push(score); },
  };
  win.window = win;
  win.self = win;
  win.parent = win;
  win.KJTut = { shouldShow: () => !tutSeen, markSeen() { tutSeen = true; }, seen: () => tutSeen };
  if (opts.replay) win.__kjReplay = opts.replay;
  const ctx = vm.createContext(win);
  if (opts.replay) vm.runInContext(fs.readFileSync(REPLAY, 'utf8'), ctx, { filename: 'kj-replay.js' });
  vm.runInContext(gameSource(opts.source, opts.draw), ctx, { filename: 'game.js' });

  function runTimers() {
    for (let i = 0; i < timers.length; i++) {
      if (timers[i] && timers[i].at <= now) { const t = timers[i]; timers[i] = null; t.fn(); }
    }
  }
  function frame() {
    const q = rafQ; rafQ = [];
    for (const fn of q) fn(now);
  }
  function advance(ms) {
    const dt = 1000 / hz;
    let left = ms;
    while (left > 1e-9) { const d = Math.min(dt, left); now += d; left -= d; runTimers(); frame(); }
  }
  // A hidden tab: time passes and timers fire, but no frame is drawn.
  function advanceHidden(ms) { now += ms; runTimers(); }
  function frameAt(gapMs) { now += gapMs; runTimers(); frame(); }
  function canvasFire(type, ev) { const c = doc.getElementById('scene'); for (const fn of (c.listeners[type] || [])) fn(ev); }
  function fire(type, ev) { for (const fn of (listeners[type] || [])) fn(ev); }
  // Design units to the client pixels a finger would touch on this screen.
  function toClient(x, y) {
    const sc = Math.min(width / W, height / H), ox = (width - W * sc) / 2, oy = (height - H * sc) / 2;
    return { clientX: ox + x * sc, clientY: oy + y * sc };
  }
  function cellClient(i) { return toClient(GX + (i % 6) * CELL + CELL / 2, GY + Math.floor(i / 6) * CELL + CELL / 2); }
  function down(i, id) { canvasFire('pointerdown', Object.assign({ pointerType: 'touch', pointerId: id || 1 }, cellClient(i))); }
  function move(i, id) { canvasFire('pointermove', Object.assign({ pointerType: 'touch', pointerId: id || 1 }, cellClient(i))); }
  function moveTo(x, y, id) { canvasFire('pointermove', Object.assign({ pointerType: 'touch', pointerId: id || 1 }, toClient(x, y))); }
  function up(id) { canvasFire('pointerup', { pointerType: 'touch', pointerId: id || 1 }); }
  function click(id) { const b = doc.getElementById(id); if (b.onclick) b.onclick(); }

  frame();
  return {
    win, log, trace, results, els, probe: () => win.__probe,
    advance, advanceHidden, frameAt, fire, click, down, move, moveTo, up, cellClient,
    clickPlay() { click('playBtn'); if (!tutSeen) return; },
    readySession() { while (readyCbs.length) readyCbs.shift()(); },
    // Advances until the game has run exactly one more step.
    stepOnce() { const s0 = win.__probe.sim.step; let n = 0; while (win.__probe.sim.step === s0 && n++ < 10) advance(1000 / hz / 2); },
    // Advances until the run is in play (past READY) and on its first step.
    toPlay() { if (win.__probe.state === 'menu') click('playBtn'); if (win.__probe.state === 'menu') click('howPlayBtn'); let n = 0; while (win.__probe.state === 'ready' && n++ < 600) advance(1000 / hz); },
    setNow(t) { now = t; },
    get now() { return now; },
    resize(w, h) { doc.documentElement.clientWidth = w; doc.documentElement.clientHeight = h; fire('resize', {}); },
  };
}

// ── planning, from the game's own rules ────────────────────────────────────
// Every path of one colour from each start cell, depth first, up to `depth`
// pearls and `budget` nodes. Returns the best open chain and the best loop by
// the rules' own points.
function plan(R, grid, depth, budget) {
  const N = R.N, CELLS = R.CELLS;
  let nodes = 0, best = null, bestPts = 0, bestLoop = null, bestLoopPts = 0;
  const count = [];
  for (let k = 0; k < R.KINDS; k++) count.push(0);
  for (let i = 0; i < CELLS; i++) count[grid[i]]++;
  const nb = (i) => { const r = Math.floor(i / N), c = i % N, o = []; if (r > 0) o.push(i - N); if (c < N - 1) o.push(i + 1); if (r < N - 1) o.push(i + N); if (c > 0) o.push(i - 1); return o; };
  const pathArr = [], on = new Array(CELLS).fill(-1);
  function dfs(i) {
    if (nodes++ > budget) return;
    const len = pathArr.length;
    if (len >= 2) { const p = R.chainPoints(len, false); if (p > bestPts) { bestPts = p; best = pathArr.slice(); } }
    for (const j of nb(i)) {
      if (grid[j] !== grid[i]) continue;
      if (on[j] >= 0) {
        if (len - on[j] >= R.LOOP_MIN) {
          const p = R.chainPoints(count[grid[i]], true);
          if (p > bestLoopPts) { bestLoopPts = p; bestLoop = pathArr.concat([j]); }
        }
        continue;
      }
      if (len >= depth) continue;
      on[j] = len; pathArr.push(j); dfs(j); pathArr.pop(); on[j] = -1;
    }
  }
  for (let s = 0; s < CELLS && nodes <= budget; s++) { on[s] = 0; pathArr.push(s); dfs(s); pathArr.pop(); on[s] = -1; }
  return { best, bestPts, bestLoop, bestLoopPts };
}

// A human pilot looks at the board for `think` steps (a spread of `thinkSd`),
// finds chains up to `depth` long, notices an available loop with chance
// `loopEye`, and drags at `perPearl` steps a pearl. A slip (`slip` a chain)
// drags a random pair without looking, which the rules often refuse.
const PILOTS = {
  flawless: { depth: 14, budget: 40000, loopEye: 1, think: 8, thinkSd: 0, perPearl: 2, perSd: 0, slip: 0 },
  bot: { depth: 14, budget: 40000, loopEye: 1, think: 1, thinkSd: 0, perPearl: 0, perSd: 0, slip: 0 },
  good: { depth: 9, budget: 6000, loopEye: 0.85, think: 70, thinkSd: 25, perPearl: 5, perSd: 1.2, slip: 0.01 },
  average: { depth: 6, budget: 2500, loopEye: 0.5, think: 120, thinkSd: 40, perPearl: 7, perSd: 2, slip: 0.03 },
  novice: { depth: 4, budget: 800, loopEye: 0.2, think: 200, thinkSd: 60, perPearl: 10, perSd: 3, slip: 0.08 },
  // a quick human who only ever swipes the first pair they see
  pairs: { depth: 2, budget: 200, loopEye: 0, think: 18, thinkSd: 6, perPearl: 4, perSd: 1, slip: 0.02 },
  multi: { depth: 6, budget: 2500, loopEye: 0.5, think: 120, thinkSd: 40, perPearl: 7, perSd: 2, slip: 0.03, extraFinger: true },
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
 * fly(g, pilot, { maxSteps, rngSeed, hz, onStep }) flies one run. Decisions
 * are made once per GAME step, never per frame; a chain is pressed, dragged
 * pearl by pearl and lifted on the steps the pilot chose.
 */
function fly(g, pilotName, opts = {}) {
  const p = typeof pilotName === 'string' ? PILOTS[pilotName] : pilotName;
  const rnd = mulberry(opts.rngSeed || 7);
  const maxSteps = opts.maxSteps || 18000;
  g.toPlay();
  const pr = g.probe(), R = pr.rules;
  let lastStep = -1, guard = 0, nextAt = 0, drag = null;
  const hzMs = 1000 / (opts.hz || 60);
  const thinkOf = () => Math.max(1, Math.round(p.think + gauss(rnd) * (p.thinkSd || 0)));
  const perOf = () => Math.max(0, Math.round(p.perPearl + gauss(rnd) * (p.perSd || 0)));
  // every deadline is an absolute step, so frame timing cannot shift a decision
  nextAt = p.idle ? Infinity : p.spam ? 4 : thinkOf();
  while (pr.state === 'play' && pr.sim.step < maxSteps && guard < maxSteps * 6) {
    guard++;
    const sim = pr.sim;
    if (sim.step !== lastStep) {
      lastStep = sim.step;
      if (opts.onStep) opts.onStep(sim);
      if (drag) {
        // continue the drag: every `due` step the finger reaches the next pearl
        while (drag && sim.step >= drag.due) {
          if (drag.i < drag.cells.length) {
            g.move(drag.cells[drag.i]); drag.i++; drag.due = sim.step + perOf();
            if (p.extraFinger && drag.i === 2) { g.down(drag.cells[0], 9); g.up(9); }
          } else { g.up(); drag = null; nextAt = sim.step + thinkOf(); }
          if (drag && drag.due > sim.step) break;
        }
      } else if (sim.step < nextAt) { /* thinking */ }
      else if (p.spam) {
        const a = Math.floor(rnd() * 36), dirs = [1, -1, 6, -6], b = a + dirs[Math.floor(rnd() * 4)];
        if (b >= 0 && b < 36) { g.down(a); g.move(b); g.up(); }
        nextAt = sim.step + 4;
      } else {
        let cells = null;
        if (rnd() < p.slip) {
          const a = Math.floor(rnd() * 35);
          cells = [a, a % 6 < 5 ? a + 1 : a + 6 < 36 ? a + 6 : a - 6];
        } else {
          const pl = plan(R, sim.grid, p.depth, p.budget);
          cells = pl.best;
          if (pl.bestLoop && rnd() < p.loopEye && pl.bestLoopPts >= pl.bestPts) cells = pl.bestLoop;
        }
        if (cells) {
          g.down(cells[0]);
          drag = { cells, i: 1, due: sim.step + perOf() };
          if (drag.due <= sim.step) {
            while (drag.i < cells.length) { g.move(cells[drag.i]); drag.i++; }
            g.up(); drag = null; nextAt = sim.step + thinkOf();
          }
        } else nextAt = sim.step + 10;
      }
    }
    g.advance(hzMs);
  }
  g.advance(6000);   // TIME'S UP plays out and the score goes
  return { score: pr.sim.score, step: pr.sim.step, over: pr.sim.over, chains: pr.sim.chains, sim: pr.sim };
}

function seedHex(i) {
  let h = '';
  let a = (i * 2654435761) >>> 0;
  for (let k = 0; k < 4; k++) { a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) >>> 0; h += a.toString(16).padStart(8, '0'); }
  return h;
}

module.exports = { boot, fly, plan, PILOTS, seedHex, gameSource, mulberry, GAME, DIR, ROOT };
