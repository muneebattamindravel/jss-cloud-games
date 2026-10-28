'use strict';

/**
 * Flies the REAL games/chakkar-chaku/js/game.js in a sandbox: a fake window, a
 * fake clock and frame loop, a recording canvas, the real kj-press.js, kj-fit.js
 * and dmath.js. Throws go through real pointer and key events, so the input
 * path under test is the one a phone uses.
 *
 * The pilots decide from what the game shows (the probe's sim and the game's
 * OWN rules functions), never from the validator, so the thing under test
 * never chooses its own inputs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'games', 'chakkar-chaku');
const GAME = path.join(DIR, 'js', 'game.js');
const PRESS = path.join(ROOT, 'games', '_shared', 'kj-press.js');
const FIT = path.join(ROOT, 'games', '_shared', 'kj-fit.js');
const DMATH = path.join(ROOT, 'games', '_shared', 'dmath.js');
const REPLAY = path.join(ROOT, 'games', '_shared', 'kj-replay.js');

// A test-only probe appended inside the game's closure. It reads, never writes.
const PROBE = `
  window.__probe = {
    get sim() { return sim; }, get state() { return state; }, get traceVersion() { return traceVersion; },
    get acc() { return acc; }, get submitted() { return submitted; }, get prac() { return prac; },
    get fx() { return fx; },
    rules: { stepSim: stepSim, throwSim: throwSim, initSim: initSim, idleSteps: idleSteps, circ: circ, FLY: FLY, TOL: TOL, TURN: TURN },
  };
`;

// After every step the game runs, a test hook sees the world (read only).
const STEP_CALL = 'stepSim(sim); handleEvents(t);';
const RENDER_CALL = "render(state === 'play' ? Math.min(1, acc / STEP_MS) : 0);";
function gameSource(src, draw) {
  let s = src || fs.readFileSync(GAME, 'utf8');
  if (!draw) {
    if (!s.includes(RENDER_CALL)) throw new Error('render call not found; update the harness');
    s = s.replace(RENDER_CALL, 'if (window.__draw) ' + RENDER_CALL);
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
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
  };
  const methods = ['fillRect', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke',
    'arc', 'ellipse', 'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'transform',
    'fillText', 'drawImage', 'quadraticCurveTo', 'clip', 'rect', 'arcTo', 'roundRect', 'bezierCurveTo',
    'setLineDash', 'strokeText', 'strokeRect'];
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
  return target;
}

function makeEl(id, log, strict) {
  const el = {
    id, width: 300, height: 150, disabled: false, textContent: '', onclick: null, hidden: false,
    style: { setProperty() {} },
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
    },
    addEventListener() {},
    getContext() { if (!el._ctx) { el._ctx = makeCtx(log, strict); el._ctx.canvas = el; } return el._ctx; },
    toDataURL() { return 'data:image/png;base64,'; },
  };
  return el;
}

/**
 * boot({ seed, width, height, hz, dpr, strict, embed, version, tutorial, replay, search })
 *   seed     16+ hex chars, what the session would mint
 *   version  what the bridge answers to __kjGameStart (3 by default)
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
    getElementById(id) { if (!els[id]) els[id] = makeEl(id, log, strict); return els[id]; },
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
    Math: opts.math || Math, JSON, Date, Object, Array, Number, String, Promise, Set, Map, parseInt, parseFloat, isFinite, Float32Array, URLSearchParams,
    location: { search: opts.replay ? '?replay=1&tut=0' : (opts.search || '') },
    postMessage() {},
    __kjEmbed: opts.embed !== false,
    __kjSeed: opts.seed || null,
    // The bridge's contract, recorded instead of sent.
    __kjOnSessionReady(cb) { if (opts.deferSession) readyCbs.push(cb); else cb(); },
    __kjGameStart(tHint, want) {
      const v = opts.version != null ? opts.version : (Number(want) >= 3 ? 3 : Number(want) >= 2 ? 2 : 1);
      trace.push({ type: 'input', payload: { kind: 'start', v, tHint } });
      return v;
    },
    __kjThrow(tHint, n, step) {
      trace.push({ type: 'input', payload: { kind: 'throw', n, step, tHint } });
    },
    __kjSubmit(score) { results.push(score); },
  };
  win.window = win;
  win.self = win;
  win.parent = win;
  win.KJTut = { shouldShow: () => !tutSeen, markSeen() { tutSeen = true; }, seen: () => tutSeen };
  if (opts.replay) win.__kjReplay = opts.replay;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(PRESS, 'utf8'), ctx, { filename: 'kj-press.js' });
  if (opts.replay) vm.runInContext(fs.readFileSync(REPLAY, 'utf8'), ctx, { filename: 'kj-replay.js' });
  vm.runInContext(fs.readFileSync(FIT, 'utf8'), ctx, { filename: 'kj-fit.js' });
  if (!opts.noDmath) vm.runInContext(fs.readFileSync(DMATH, 'utf8'), ctx, { filename: 'dmath.js' });
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
  function fire(type, ev) { for (const fn of (listeners[type] || [])) fn(ev); }
  let pid = 1;
  function tap(side) {
    const x = side ? width * 0.75 : width * 0.5;
    const id = pid++;
    fire('pointerdown', { pointerType: 'touch', pointerId: id, clientX: x, clientY: height * 0.7 });
    fire('pointerup', { pointerType: 'touch', pointerId: id });
    fire('touchend', { touches: [] });
  }
  function key(code) {
    fire('keydown', { code, preventDefault() {} });
    fire('keyup', { code });
  }
  function click(id) { const b = doc.getElementById(id); if (b.onclick) b.onclick(); }

  frame();
  return {
    win, log, trace, results, els, probe: () => win.__probe,
    advance, advanceHidden, frameAt, tap, key, fire, click,
    clickPlay() { click('playBtn'); },
    clickHow() { click('howBtn'); },
    readySession() { while (readyCbs.length) readyCbs.shift()(); },
    // Advances until the game has run exactly one more step.
    stepOnce() { const s0 = win.__probe.sim.step; let n = 0; while (win.__probe.sim.step === s0 && n++ < 10) advance(1000 / hz / 2); },
    setNow(t) { now = t; },
    get now() { return now; },
    resize(w, h) { doc.documentElement.clientWidth = w; doc.documentElement.clientHeight = h; fire('resize', {}); },
  };
}

// ── pilots ─────────────────────────────────────────────────────────────────
// A human pilot knows how the log moves (the patterns repeat and are learned)
// but not to the step: it picks a moment `lead` steps ahead when, by the
// game's own rules, a knife would land at least `margin` clear of every stuck
// knife, and its finger lands there with a timing error of `sd` steps. A slip
// (`slip` a step) throws without looking. It then waits `think` steps before
// the next decision. Skill = sd, margin, slip, think.
const PILOTS = {
  flawless: { flawless: true },
  good: { sd: 1.8, margin: 50, slip: 0.0002, think: 6, lead: 6 },
  average: { sd: 2.8, margin: 70, slip: 0.0005, think: 12, lead: 8 },
  novice: { sd: 4, margin: 90, slip: 0.001, think: 20, lead: 10 },
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

// Would a knife thrown `ahead` steps from now land clear by `margin`? Uses the
// game's own rules on a copy (sim arrays are replaced, never mutated).
function landsClear(R, sim, ahead, margin) {
  const c = Object.assign({}, sim);
  for (let i = 0; i < ahead; i++) { R.stepSim(c); if (c.dead || c.trans > 0) return false; }
  if (!R.throwSim(c)) return false;
  const log = c.log;
  for (let i = 0; i < R.FLY; i++) R.stepSim(c);
  if (c.dead) return false;
  if (c.log !== log || !margin) return true;
  const a = c.stuck[c.stuck.length - 1];
  for (let i = 0; i < c.stuck.length - 1; i++) if (R.circ(a, c.stuck[i]) < R.TOL + margin) return false;
  return true;
}

/**
 * fly(g, pilot, { maxSteps, rngSeed, hz, keys, onStep }) flies one run.
 * Steps are counted on the GAME's own step counter, never frames.
 */
function fly(g, pilotName, opts = {}) {
  const p = typeof pilotName === 'string' ? PILOTS[pilotName] : pilotName;
  const rnd = mulberry(opts.rngSeed || 7);
  const maxSteps = opts.maxSteps || 60 * 60 * 10;
  if (g.probe().state !== 'play') g.clickPlay();
  const pr = g.probe(), R = pr.rules;
  let pending = -1, wait = 0, lastStep = -1, guard = 0;
  const press = () => { if (opts.keys && rnd() < 0.3) g.key('Space'); else g.tap(rnd() < 0.5 ? 1 : 0); };
  while (pr.state === 'play' && pr.sim.step < maxSteps && guard < maxSteps * 4) {
    guard++;
    const sim = pr.sim;
    if (sim.step !== lastStep) {
      lastStep = sim.step;
      if (opts.onStep) opts.onStep(sim);
      if (p.spam) press();
      else if (p.flawless) { if (sim.fly < 0 && sim.trans === 0 && landsClear(R, sim, 0, 0)) press(); }
      else if (!p.idle) {
        if (pending >= 0 && sim.step >= pending) { press(); pending = -1; wait = p.think; }
        else if (pending < 0 && sim.fly < 0 && sim.trans === 0) {
          if (wait > 0) wait--;
          else if (rnd() < p.slip) press();
          else if (landsClear(R, sim, p.lead, p.margin)) pending = sim.step + Math.max(1, p.lead + Math.round(gauss(rnd) * p.sd));
        }
      }
    }
    g.advance(1000 / (opts.hz || 60));
  }
  g.advance(15000);   // the death plays out and the score goes
  return { score: pr.sim.score, step: pr.sim.step, dead: pr.sim.dead, deathStep: pr.sim.deathStep, cause: pr.sim.cause, log: pr.sim.log, sim: pr.sim };
}

function seedHex(i) {
  let h = '';
  let a = (i * 2654435761) >>> 0;
  for (let k = 0; k < 4; k++) { a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) >>> 0; h += a.toString(16).padStart(8, '0'); }
  return h;
}

module.exports = { boot, fly, PILOTS, seedHex, gameSource, landsClear, GAME, DIR, ROOT };
