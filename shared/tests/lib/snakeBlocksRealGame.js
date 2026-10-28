'use strict';

/**
 * Drive the REAL games/snake-blocks/js/game.js headlessly.
 *
 * The parity ORACLE for the Snake Blocks validator. Not a port: a port drifts
 * from the shipped file. The pilot plans with the GAME's own rules functions
 * (reached through a test-only probe), never with the validator under test, so
 * a mutated server rule cannot move the plan and the score together.
 *
 * The clock is ours. The game paces a fixed 1/60 s accumulator, so advancing the
 * clock by FRAME_MS per animation frame yields one step per frame. The finger
 * is real: pointer events on the canvas, in client pixels, mapped through the
 * game's own view transform.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../../..');
const GAME_PATH = path.join(ROOT, 'games/snake-blocks/js/game.js');
const RAW_SRC = fs.readFileSync(GAME_PATH, 'utf8');

// TEST-ONLY instrumentation, appended INSIDE the game's closure in the string
// we evaluate. The shipped file is never touched.
const PROBE = `
  window.__probe = function () {
    return {
      sim: sim, state: state, aimX: aimX, scale: scale, offX: offX, traceVersion: traceVersion,
      accumulator: accumulator, submitted: submitted, pointerDown: pointer.down, deathWait: deathWait,
      fns: { rowSpec: rowSpec, specFor: specFor, anchorAt: anchorAt, initSim: initSim, stepSim: stepSim,
        hitSteps: hitSteps, valFor: valFor, travelTo: travelTo, colMid: colMid, colLeft: colLeft, colRight: colRight },
      K: { AIM_GAIN: AIM_GAIN, AIM_SLACK: AIM_SLACK, X_MIN: X_MIN, X_MAX: X_MAX, START_X: START_X, HEAD_MAX_STEP: HEAD_MAX_STEP,
        COLS: COLS, ROW_HQ: ROW_HQ, BLOCK_HQ: BLOCK_HQ, HEAD_RQ: HEAD_RQ, U: U, START_GUARD_STEPS: START_GUARD_STEPS,
        PATH_BATCH_MAX: PATH_BATCH_MAX, ROW_HQ: ROW_HQ, PICK_YQ: PICK_YQ },
    };
  };
`;
const closeIdx = RAW_SRC.lastIndexOf('})();');
if (closeIdx < 0) throw new Error('snake-blocks/game.js: could not find the IIFE close to instrument');
const GAME_SCRIPT = new vm.Script(RAW_SRC.slice(0, closeIdx) + PROBE + RAW_SRC.slice(closeIdx),
  { filename: 'snake-blocks/game.js' });

const REPLAY_SCRIPT = new vm.Script(fs.readFileSync(path.join(ROOT, 'games/_shared/kj-replay.js'), 'utf8'), { filename: 'kj-replay.js' });

const FRAME_MS = 1000 / 60;

// Every field of the run, in the order the parity suite compares them.
const STATE_FIELDS = ['frames', 'armed', 'down', 'hx', 'scroll', 'speed', 'rowN', 'lastPick', 'len', 'chain',
  'chainRow', 'hitT', 'hitCol', 'picks', 'score', 'ev', 'evCol', 'dead', 'deathFrame', 'deathCause'];
function rowOf(sim) {
  const r = STATE_FIELDS.map((f) => sim[f]);
  // Bit 8 (the head was pushed off a divider or a block's edge) is drawing: the
  // trace carries where the head ENDED, which is already clamped, so the server
  // cannot see the push and need not. Bits 1, 2 and 4 are the run.
  r[STATE_FIELDS.indexOf('ev')] = sim.ev & 7;
  r.push(sim.rowVals ? sim.rowVals.join(',') : '');
  return r;
}

/** A 2D context that VALIDATES its arguments when strict. */
function fakeCtx(strict, stats) {
  const finite = (name, args, n) => {
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(args[i])) throw new Error(`${name}: non-finite argument ${i} (${args.join(', ')})`);
    }
  };
  const check = (name, args) => {
    if (stats) stats.calls = (stats.calls || 0) + 1;
    if (stats && (name === 'createRadialGradient' || name === 'createLinearGradient')) stats.gradients = (stats.gradients || 0) + 1;
    if (!strict) return;
    switch (name) {
      case 'arc':
        finite(name, args, 5);
        if (!(args[2] >= 0)) throw new Error(`arc: radius ${args[2]}`);
        break;
      case 'ellipse':
        finite(name, args, 7);
        if (!(args[2] >= 0) || !(args[3] >= 0)) throw new Error(`ellipse radii ${args[2]}, ${args[3]}`);
        break;
      case 'createRadialGradient':
        finite(name, args, 6);
        if (!(args[2] >= 0) || !(args[5] >= 0)) throw new Error(`createRadialGradient radii ${args[2]}, ${args[5]}`);
        break;
      case 'addColorStop':
        if (!(args[0] >= 0 && args[0] <= 1)) throw new Error(`addColorStop offset ${args[0]}`);
        if (typeof args[1] !== 'string' || /NaN|undefined/.test(args[1])) throw new Error(`addColorStop colour ${args[1]}`);
        break;
      case 'fillRect': case 'strokeRect': case 'clearRect': case 'moveTo': case 'lineTo':
      case 'translate': case 'scale': case 'setTransform': case 'createLinearGradient':
      case 'quadraticCurveTo': case 'bezierCurveTo': case 'rect':
        finite(name, args, args.length);
        break;
      case 'drawImage':
        finite(name, args.slice(1), args.length - 1);
        break;
      case 'fillText': case 'strokeText':
        finite(name, args.slice(1), 2);
        break;
      default:
    }
  };
  const child = {};
  const props = { globalAlpha: 1, lineWidth: 1, fillStyle: '#000', strokeStyle: '#000', globalCompositeOperation: 'source-over', font: '10px sans-serif' };
  const GRAD = { addColorStop: (o, c) => check('addColorStop', [o, c]) };
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return (t) => ({ width: String(t).length * 8 });
      if (Object.prototype.hasOwnProperty.call(props, prop)) return props[prop];
      if (!child[prop]) child[prop] = (...args) => { check(prop, args); return GRAD; };
      return child[prop];
    },
    set(_t, prop, value) {
      props[prop] = value;
      if (strict && (prop === 'globalAlpha' || prop === 'lineWidth') && !Number.isFinite(value)) throw new Error(`${prop} = ${value}`);
      if (strict && (prop === 'fillStyle' || prop === 'strokeStyle') && typeof value === 'string'
        && /NaN|undefined|Infinity/.test(value)) throw new Error(`${prop} = ${value}`);
      return true;
    },
  });
}

// A permissive stand-in for anything (Web Audio): every property is callable,
// constructible and coerces to 0.
function anyNode() {
  return new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : (p === 'then' ? undefined : anyNode())),
    set: () => true, apply: () => anyNode(), construct: () => anyNode(),
  });
}

function makeEl(id, box, strict, stats) {
  const listeners = {};
  const classes = new Set();
  const style = { setProperty() {} };
  return {
    id, style, dataset: {}, textContent: '', disabled: false, width: 300, height: 150,
    get clientWidth() { return box.w; }, get clientHeight() { return box.h; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: box.w, height: box.h, right: box.w, bottom: box.h }),
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
    },
    getContext: () => fakeCtx(strict, stats),
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    setPointerCapture() {},
    appendChild() {}, setAttribute() {},
    _fire(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev || { preventDefault() {} })); },
  };
}

/** Boot the game with a controllable clock, viewport and Math.random. */
function boot({
  seed = null, viewport = { w: 375, h: 812 }, dpr = 2, strictCanvas = false, embed = true,
  random = null, clockOffset = 0, version = 2, sessionReady = true, perf = false, replay = null,
} = {}) {
  const box = { w: viewport.w, h: viewport.h };
  const stats = { calls: 0, gradients: 0 };
  const els = {};
  const getEl = (sel) => { const id = String(sel).replace(/^#/, ''); return els[id] || (els[id] = makeEl(id, box, strictCanvas, id === 'game' ? stats : null)); };
  const clock = { now: 0 };
  let pendingFrame = null;
  const win = {};
  const trace = [];
  const starts = [];
  const timers = [];
  let submittedScore = null;
  let readyCb = null;
  const audio = { contexts: 0, buffers: 0, fills: 0, resumes: 0, voices: 0, last: null };

  const MathForGame = random ? new Proxy(Math, { get: (t, p) => (p === 'random' ? random : t[p]) }) : Math;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math: MathForGame, JSON, Object, Array, String, Number, Boolean, Map, Set, Symbol, Proxy, RegExp,
    isNaN, isFinite, parseInt, parseFloat, Infinity, NaN, Error, Promise, Float32Array, Uint8Array,
    performance: { now: () => clock.now + clockOffset },
    requestAnimationFrame: (cb) => { pendingFrame = cb; return 1; },
    cancelAnimationFrame() { pendingFrame = null; },
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock.now + (Number(ms) || 0) }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    setInterval: () => 0, clearInterval() {},
    location: { search: perf ? '?perf=1' : '' },
    navigator: { deviceMemory: 8, hardwareConcurrency: 8 },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      querySelector: getEl, getElementById: getEl, createElement: () => makeEl('c', box, strictCanvas),
      documentElement: getEl('documentElement'), body: makeEl('body', box, false),
      readyState: 'complete', visibilityState: 'visible', hidden: false,
      addEventListener() {}, removeEventListener() {},
    },
    AudioContext: function () {
      audio.contexts++;
      const ctx = new Proxy({ state: 'suspended', sampleRate: 48000, currentTime: 0 }, {
        get: (t, p) => {
          if (p in t) return t[p];
          if (p === 'resume') return () => { audio.resumes++; t.state = 'running'; return Promise.resolve(); };
          if (p === 'createBuffer') return (ch, len) => { audio.buffers++; return { getChannelData: () => { audio.fills++; return new Float32Array(len); } }; };
          if (p === 'createOscillator' || p === 'createBufferSource') return () => { audio.voices++; return anyNode(); };
          return anyNode();
        },
        set: (t, p, v) => { t[p] = v; return true; },
      });
      audio.last = ctx;
      return ctx;
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.devicePixelRatio = dpr;
  sandbox.innerWidth = viewport.w;
  sandbox.innerHeight = viewport.h;
  sandbox.addEventListener = (t, fn) => { (win[t] = win[t] || []).push(fn); };
  sandbox.removeEventListener = () => {};

  sandbox.__kjEmbed = embed;
  sandbox.__kjSeed = seed;
  sandbox.__kjTutorialOpen = false;
  sandbox.__kjOnSessionReady = (cb) => { if (sessionReady) cb(); else readyCb = cb; };
  sandbox.__kjGameStart = (tHint, want) => {
    const v = Math.min(Number(want) || 1, version);
    starts.push({ tHint, want, got: v });
    return v;
  };
  sandbox.__kjPath = (tHint, f, x) => { trace.push({ kind: 'path', f, x: x.slice(), tHint }); };
  sandbox.__kjMarker = (tHint, kind, step) => { trace.push({ kind, step, tHint }); };
  sandbox.__kjSubmit = (score) => { if (submittedScore === null) submittedScore = score; };

  vm.createContext(sandbox);
  // Replay mode (admin run viewer): the real kj-replay.js, fed a recorded run.
  if (replay) {
    sandbox.location = { search: '?replay=1' };
    sandbox.URLSearchParams = URLSearchParams;
    sandbox.__kjReplay = replay;
    REPLAY_SCRIPT.runInContext(sandbox);
  }
  GAME_SCRIPT.runInContext(sandbox);

  const runTimers = () => {
    for (let i = 0; i < timers.length; i++) {
      const t = timers[i];
      if (t.fn && t.at <= clock.now) { const fn = t.fn; t.fn = null; fn(); }
    }
  };
  const fireWin = (t, ev) => (win[t] || []).slice().forEach((fn) => fn(ev));
  const frameBy = (ms) => {
    clock.now += ms;
    runTimers();
    const cb = pendingFrame;
    pendingFrame = null;
    if (cb) cb(clock.now + clockOffset);
  };

  const fingers = new Map();
  const pev = (id, type, x) => ({ pointerId: id, pointerType: type || 'touch', clientX: x, clientY: 400, target: {}, cancelable: true, preventDefault() {} });
  const canvas = () => getEl('game');

  const api = {
    clock, trace, starts, els, sandbox, stats, box, audio,
    fireWin: (t, ev) => fireWin(t, ev || {}),
    frame: () => frameBy(FRAME_MS),
    frameBy,
    probe: () => sandbox.__probe(),
    playClick: () => getEl('playBtn')._fire('click', { preventDefault() {} }),
    markReady: () => { if (readyCb) { const cb = readyCb; readyCb = null; cb(); } },
    down: (id = 1, type, x = 187) => { fingers.set(id, { x }); canvas()._fire('pointerdown', pev(id, type, x)); },
    // Move finger `id` by `px` client pixels.
    moveBy: (px, id = 1, type) => { const fg = fingers.get(id); if (!fg) return; fg.x += px; canvas()._fire('pointermove', pev(id, type, fg.x)); },
    up: (id = 1) => { const fg = fingers.get(id); fingers.delete(id); canvas()._fire('pointerup', pev(id, 'touch', fg ? fg.x : 0)); },
    cancel: (id = 1) => { fingers.delete(id); canvas()._fire('pointercancel', pev(id, 'touch', 0)); },
    blur: () => fireWin('blur', {}),
    hide: () => fireWin('blur', {}),
    resizeTo: (w, h) => { box.w = w; box.h = h; fireWin('resize', {}); },
    runTimers,
    get submitted() { return submittedScore; },
    get finished() { return submittedScore !== null; },
  };
  return api;
}

// ── the autopilot ────────────────────────────────────────────────────────
// A human model, planning with the GAME's own functions. Each row it picks a
// lane to be in when the head reaches it:
//   grind   take the biggest block the chain can afford (the score)
//   margin  how many balls it keeps in hand beyond what a block costs
//   lag     steps after a row is engaged before the pilot reacts
//   err     aim error (design units) held for the whole row
//   blunder chance per row of picking the wrong lane outright
//   jitter  a wobble on the finger every step
//   idle    never touch the screen
//   hold    touch once and never move
const STYLES = {
  flawless: { grind: true, margin: 0, lag: 0, err: 0, collect: true, horizon: 10 },
  expert: { grind: true, margin: 1, lag: 6, err: 8, collect: true },
  good: { grind: true, margin: 1, lag: 12, err: 16, blunder: 0.01, collect: true },
  average: { grind: true, margin: 2, lag: 20, err: 28, blunder: 0.04, collect: true },
  novice: { grind: false, margin: 3, lag: 32, err: 40, blunder: 0.1, collect: true },
  dodger: { grind: false, margin: 0, lag: 4, err: 6, collect: true },
  jitter: { grind: true, margin: 1, lag: 8, err: 10, jitter: 7, collect: true },
  lifter: { grind: true, margin: 1, lag: 6, err: 10, collect: true, lift: { every: 140, steps: 18 } },
  idle: { idle: true },
  hold: { hold: true },
};

// Lanes the head can get to from lane `a` on row m without crossing a divider.
function canCross(walls, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  for (let k = lo + 1; k <= hi; k++) if (walls & (1 << (k - 1))) return false;
  return true;
}

// Plans the next rows by dynamic programming over (lane, balls in hand, chain,
// rows since the last break), using the GAME's own row generator. It is what a
// very good, patient player would do: take every pickup that is reachable,
// grind a block when the chain can afford it and when keeping the balls would
// be worth less than the points, and never stand where a divider cuts the way
// to the next row. `lam` is what a ball in hand is worth in points; `horizon`
// is how many rows ahead it looks.
function plan(p, s, style) {
  const K = p.K;
  const n = s.rowN;
  const H = style.horizon || 8;
  const lam = style.lam == null ? 2 : style.lam;
  const margin = style.margin || 0;
  const nb = n * K.ROW_HQ;
  const inBand = s.scroll + K.HEAD_RQ > nb && s.scroll - K.HEAD_RQ < nb + K.BLOCK_HQ;
  // Chewing a block: stay with it until it is gone.
  if (inBand && s.hitCol >= 0) return p.fns.colMid(s.hitCol);
  const m0 = inBand ? n + 1 : n;
  const cur = Math.max(0, Math.min(K.COLS - 1, Math.floor((s.hx - 7) / 80)));
  let len0 = s.len;
  let chainBump = 0;
  if (inBand) {
    const spn = p.fns.specFor(s, n);
    // a pickup under the head is about to be taken: stay until it is
    if (spn.pick && n > s.lastPick && spn.pick.c === cur && Math.abs(s.hx - p.fns.colMid(cur)) < 25) return p.fns.colMid(cur);
    if (spn.pick && n <= s.lastPick && false) len0 += 0;
    // a live block under the head is about to be ground: stay and finish it
    const live = (s.rowVals || spn.vals)[cur];
    if (live > 0) return p.fns.colMid(cur);
  }
  const chainNow = (m0 - s.chainRow <= 2) ? s.chain : 0;
  const gap0 = Math.min(3, m0 - s.chainRow);
  let layer = new Map();
  const key = (lane, len, ch, gap) => lane + ',' + len + ',' + ch + ',' + gap;
  layer.set(key(cur, len0, chainNow, gap0), { lane: cur, len: len0, ch: chainNow, gap: gap0, score: 0, first: -1 });
  for (let m = m0; m < m0 + H; m++) {
    const sp = p.fns.specFor(s, m);
    const vals = m === n && s.rowVals ? s.rowVals : sp.vals;
    const next = new Map();
    for (const st of layer.values()) {
      for (let b = 0; b < K.COLS; b++) {
        if (!canCross(sp.walls, st.lane, b)) continue;
        // the head can only travel so far before the next row's band arrives,
        // and the faster the world scrolls the less time it has
        const spd = Math.min(128, 54 + m);
        let tsteps = Math.floor((K.ROW_HQ - K.BLOCK_HQ - 2 * K.HEAD_RQ) / spd);
        if (m > m0 || inBand) {
          // while the previous row's band is passing it may keep sliding, as
          // long as every lane it crosses is clear
          const pv = m - 1 === n && s.rowVals ? s.rowVals : p.fns.specFor(s, m - 1).vals;
          const here = m === m0 ? cur : st.lane;
          let clear = true;
          for (let c = Math.min(here, b); c <= Math.max(here, b); c++) if (pv[c] > 0 && c !== here) clear = false;
          if (clear) {
            const bandLeft = m === m0 && inBand ? (nb + K.BLOCK_HQ + K.HEAD_RQ - s.scroll) : (K.BLOCK_HQ + 2 * K.HEAD_RQ);
            tsteps += Math.max(0, Math.floor(bandLeft / spd));
          }
        }
        const reach = 13 * Math.max(0, tsteps - 2 - (style.slow || 0));
        const from = m === m0 ? s.hx : p.fns.colMid(st.lane);
        if (Math.abs(p.fns.colMid(b) - from) > reach) continue;
        const v = vals[b];
        let len = st.len;
        let ch = st.ch;
        let gap = Math.min(3, st.gap + (m === m0 ? 0 : 1));
        if (gap > 2) ch = 0;
        let score = st.score;
        if (v > 0) {
          if (len < v + 1 + margin) continue;
          len -= v;
          const orig = sp.vals[b];
          const nch = (gap <= 2 && ch > 0) ? Math.min(8, ch + 1) : 1;
          score += v + orig * nch;
          ch = nch; gap = 0;
        } else if (sp.pick && sp.pick.c === b && m > s.lastPick && style.collect !== false) {
          len += sp.pick.v;
        }
        const k2 = key(b, len, ch, gap);
        const prev = next.get(k2);
        const first = st.first === -1 ? b : st.first;
        if (!prev || score > prev.score) next.set(k2, { lane: b, len, ch, gap, score, first });
      }
    }
    if (next.size === 0) break;
    layer = next;
  }
  let best = null;
  let bv = -Infinity;
  for (const st of layer.values()) {
    const v = st.score + lam * st.len;
    if (v > bv) { bv = v; best = st; }
  }
  if (!best || best.first < 0) {
    // nothing can be survived: the cheapest lane in the next row is the best of a bad lot
    const sp = p.fns.specFor(s, m0);
    const vals = m0 === n && s.rowVals ? s.rowVals : sp.vals;
    let c2 = cur; let low = Infinity;
    for (let c = 0; c < K.COLS; c++) { if (vals[c] < low) { low = vals[c]; c2 = c; } }
    return p.fns.colMid(c2);
  }
  return p.fns.colMid(best.first);
}

function autopilot({
  seed = null, style = {}, maxSteps = 60 * 240, hz = 60, viewport, dpr, random, clockOffset = 0,
  multi = false, strictCanvas = false, version = 2, stopAt = null,
} = {}) {
  const g = boot({ seed, viewport, dpr, random, clockOffset, strictCanvas, version });
  g.frame();
  g.playClick();
  const rows = new Map();
  let lcg = ((typeof seed === 'string' ? parseInt(seed.slice(0, 7), 16) : 12345) ^ 0x5eed) >>> 0;
  const rnd = () => { lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0; return lcg / 4294967296; };
  const dt = 1000 / hz;
  const limit = Math.ceil(maxSteps * (hz / 60)) + 400;
  let isDown = false;
  let acted = -1;
  let forRow = -1;
  let want = 207;
  let rowSince = 0;
  let liftLeft = 0;
  let rowErr = 0;
  let rowBlunder = -1;
  let multiDown = false;
  const stats = { multi: 0, batches: 0, lifts: 0 };

  for (let i = 0; i < limit && !g.finished; i++) {
    g.frameBy(dt);
    const p = g.probe();
    const s = p.sim;
    if (p.state === 'play' || s.dead) { if (!rows.has(s.frames)) rows.set(s.frames, rowOf(s)); }
    if (s.dead || g.finished) continue;
    if (s.frames >= maxSteps || (stopAt && stopAt(s))) break;
    if (s.frames === acted) continue;   // decide once per STEP, never per frame
    acted = s.frames;
    if (style.idle) continue;
    if (!isDown && s.frames >= p.K.START_GUARD_STEPS) { g.down(1, 'touch', 180); isDown = true; }
    if (!isDown) continue;
    if (style.hold) continue;
    if (style.lift) {
      if (liftLeft > 0) { liftLeft--; if (liftLeft === 0) { g.down(1, 'touch', 180); isDown = true; } continue; }
      if (s.frames % style.lift.every === 0 && s.frames > p.K.START_GUARD_STEPS + 30) { g.up(1); isDown = false; liftLeft = style.lift.steps; continue; }
    }

    if (forRow !== s.rowN) {
      forRow = s.rowN;
      rowSince = 0;
      rowErr = Math.round((rnd() * 2 - 1) * (style.err || 0));
      rowBlunder = style.blunder && rnd() < style.blunder ? Math.floor(rnd() * 5) : -1;
    }
    if (rowSince % (style.every || 3) === 0) {
      want = plan(p, s, style);
      if (rowBlunder >= 0) want = p.fns.colMid(rowBlunder);
      want += rowErr;
    }
    rowSince++;
    if (rowSince < (style.lag || 0)) continue;
    let t = want;
    if (style.jitter) t += Math.round((rnd() * 2 - 1) * style.jitter);
    t = Math.max(p.K.X_MIN, Math.min(p.K.X_MAX, t));
    // finger movement in client pixels that moves aimX to t
    const dClient = ((t - p.aimX) / p.K.AIM_GAIN) * p.scale;
    if (Math.abs(dClient) > 0.2) g.moveBy(dClient, 1, 'touch');
    if (multi && s.frames % 97 === 0) {
      if (!multiDown) { g.down(2, 'touch', 300); multiDown = true; stats.multi++; } else { g.up(2); multiDown = false; }
    }
    if (multiDown) g.moveBy(40, 2, 'touch');
  }
  const s = g.probe().sim;
  for (let i = 0; i < 300 && !g.finished && s.dead; i++) g.frameBy(dt);
  stats.batches = g.trace.filter((t) => t.kind === 'path').length;
  stats.lifts = g.trace.filter((t) => t.kind === 'lift').length;
  return {
    score: g.submitted !== null ? g.submitted : s.score, died: s.dead, endFrame: s.deathFrame,
    cause: s.deathCause, trace: g.trace.slice(), starts: g.starts.slice(), rows, stats, finalSim: s, g,
  };
}

/** The trace in the shape the validator eats. */
function asEvents(trace, v = 2) {
  const out = [{ type: 'input', payload: { kind: 'start', v } }];
  for (const t of trace) {
    if (t.kind === 'path') out.push({ type: 'input', payload: { kind: 'path', f: t.f, x: t.x.slice(), tHint: t.tHint } });
    else out.push({ type: 'input', payload: { kind: t.kind, step: t.step, tHint: t.tHint } });
  }
  return out;
}

/** The trace with the player's clock stripped: what a run IS, not when it was sent. */
function schedOf(trace) {
  return trace.map((t) => (t.kind === 'path' ? `p${t.f}:${t.x.join(',')}` : `${t.kind}${t.step}`)).join('|');
}

function seedsFor(n, salt = 2654435761) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((((i + 1) * salt) >>> 0).toString(16).padStart(8, '0') + 'ab12cd34ef56');
  return out;
}

module.exports = {
  boot, autopilot, asEvents, schedOf, rowOf, seedsFor, plan, STYLES,
  FRAME_MS, STATE_FIELDS, GAME_PATH, ROOT,
};
