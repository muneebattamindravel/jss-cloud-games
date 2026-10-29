'use strict';

/**
 * Flies the REAL Smash It page in a sandbox: the bridge script from
 * games/smash-it/index.html (with a recording SDK in place of kj-sdk-v2), the
 * real three.min.js, rapier.js, rules.js, audio.js and game.js, and the real
 * kj-press.js and kj-replay.js. Only the WebGL renderer is stubbed (Node has no
 * GL): cameras, raycasts and every scene object are the real three.js, so a
 * tap at a screen point turns into a shot exactly as on a phone. Timers run on
 * a fake clock (never stubbed) and frames come from a fake
 * requestAnimationFrame at the chosen refresh rate.
 *
 * Pilots plan with the GAME's own world (the sim inside the sandbox), never
 * with the validator, so the thing under test never chooses its own inputs.
 * They decide once per STEP and act through real pointer events.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'games', 'smash-it');
const GAME = path.join(DIR, 'js', 'game.js');
const RULES = path.join(DIR, 'js', 'rules.js');
const AUDIO = path.join(DIR, 'js', 'audio.js');
const THREE = path.join(DIR, 'js', 'vendor', 'three.min.js');
const RAPIER = path.join(DIR, 'js', 'vendor', 'rapier.js');
const HTML = path.join(DIR, 'index.html');
const PRESS = path.join(ROOT, 'games', '_shared', 'kj-press.js');
const REPLAY = path.join(ROOT, 'games', '_shared', 'kj-replay.js');

const STEP_CALL = '        R.stepSim(S); handleEvents(S);\n';

// The step observer: called after every fixed step of a live or replayed run.
function gameSource(src) {
  let s = src || fs.readFileSync(GAME, 'utf8');
  if (!s.includes(STEP_CALL)) throw new Error('step call not found; update the harness');
  return s.replace(STEP_CALL, '        R.stepSim(S); if (window.__onStep) window.__onStep(S); handleEvents(S);\n');
}

// The page's own bridge: the inline script after the SDK tag in index.html.
function bridgeSource(html) {
  const h = html || fs.readFileSync(HTML, 'utf8');
  const a = h.indexOf('<script>', h.indexOf('kj-sdk-v2.js'));
  const b = h.indexOf('</script>', a);
  if (a < 0 || b < 0) throw new Error('bridge script not found; update the harness');
  return h.slice(a + 8, b);
}

// A recursive stand-in: any property, call or construction returns another
// stand-in, and it reads as 0 in arithmetic. Used for the WebGL renderer only.
function standIn(log, name) {
  const fn = function () {};
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'valueOf') return () => 0;
      if (k === 'then') return undefined;
      if (log) log.renderer[name + '.' + String(k)] = (log.renderer[name + '.' + String(k)] || 0) + 1;
      return standIn(log, name + '.' + String(k));
    },
    set() { return true; },
    apply() { return standIn(log, name + '()'); },
    construct() { return standIn(log, 'new ' + name); },
  });
}

// A 2D context for the game's texture painting. Image data are real typed arrays.
function makeCtx(log, strict) {
  const target = {
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(Math.max(0, w | 0) * Math.max(0, h | 0) * 4), width: w, height: h }; },
    createImageData(w, h) { return { data: new Uint8ClampedArray(Math.max(0, w | 0) * Math.max(0, h | 0) * 4), width: w, height: h }; },
    measureText(t) { return { width: String(t).length * 8 }; },
    createLinearGradient() { log.gradients++; return { addColorStop(o) { if (strict && !(o >= 0 && o <= 1)) throw new Error('stop ' + o); } }; },
    createRadialGradient(...a) {
      if (strict) for (const v of a) if (!Number.isFinite(v)) throw new Error('createRadialGradient got ' + v);
      if (strict && (a[2] < 0 || a[5] < 0)) throw new Error('negative radius');
      log.gradients++; return { addColorStop(o) { if (strict && !(o >= 0 && o <= 1)) throw new Error('stop ' + o); } };
    },
  };
  const props = {};
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (k in props) return props[k];
      return function (...args) {
        if (strict) for (const v of args) if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${String(k)} got ${v}`);
        log.calls[k] = (log.calls[k] || 0) + 1;
      };
    },
    set(t, k, v) {
      if (strict && typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${String(k)} = ${v}`);
      props[k] = v; return true;
    },
  });
}

function makeEl(id, log, strict, doc) {
  const handlers = {};
  const kids = [];
  const el = {
    id, tagName: 'DIV', width: 300, height: 150, disabled: false, textContent: '', hidden: false, offsetWidth: 0,
    style: { setProperty() {} }, dataset: {},
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
      toggle(c, on) { const want = on === undefined ? !this.set.has(c) : !!on; if (want) this.set.add(c); else this.set.delete(c); return want; },
    },
    parentNode: null,
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener() {},
    _fire(type, ev) { for (const fn of (handlers[type] || [])) fn(ev || {}); },
    getContext() { if (!el._ctx) el._ctx = makeCtx(log, strict); return el._ctx; },
    toDataURL() { return 'data:image/png;base64,'; },
    getBoundingClientRect() { return { left: 0, top: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight }; },
    appendChild(c) { kids.push(c); c.parentNode = el; return c; },
    remove() { if (el.parentNode) { /* detached */ } },
    querySelector(sel) { const k = '__q' + sel; if (!el[k]) el[k] = makeEl(id + ' ' + sel, log, strict, doc); return el[k]; },
    set src(v) { el._src = v; setTimeout0(() => el._fire('load', {})); },
    get src() { return el._src; },
  };
  let setTimeout0 = (f) => f();
  el._setTimer = (f) => { setTimeout0 = f; };
  return el;
}

/**
 * boot({ seed, width, height, hz, dpr, strict, embed, replay, search, deferSession, math, clockStart })
 *   seed     what the session would mint (a hex string)
 *   embed    inside the platform (default) or standalone
 *   replay   { events, version, speed } to play a stored run back (?replay=1)
 * Resolves once the physics engine has started (Rapier compiles asynchronously).
 */
async function boot(opts = {}) {
  const width = opts.width || 375, height = opts.height || 812;
  const hz = opts.hz || 60;
  const log = { calls: {}, gradients: 0, renderer: {} };
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
  const embed = opts.embed !== false;
  const seed = opts.seed === undefined ? '0123456789abcdef0123456789abcdef' : opts.seed;

  const doc = {
    documentElement: { clientWidth: width, clientHeight: height, style: { setProperty() {}, zoom: '' } },
    hidden: false, visibilityState: 'visible',
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    body: { classList: { set: new Set(), add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } }, appendChild() {} },
  };
  doc.getElementById = function (id) { if (!els[id]) { els[id] = makeEl(id, log, strict, doc); els[id].parentNode = makeEl(id + '-parent', log, strict, doc); } return els[id]; };
  doc.createElement = function (tag) { const e = makeEl('new-' + tag, log, strict, doc); e.tagName = String(tag).toUpperCase(); return e; };
  doc.createElementNS = function (ns, tag) { return doc.createElement(tag); };
  doc.querySelector = function () { return null; };
  // The thenables resolve synchronously, so the bridge needs no await.
  const sync = (value) => ({ then(f) { const r = f ? f(value) : value; return sync(r); }, catch() { return sync(value); } });
  const parent = embed ? { postMessage(m) { posted.push(m); } } : null;
  const win = {
    document: doc,
    innerWidth: width, innerHeight: height,
    devicePixelRatio: opts.dpr || 2,
    navigator: { userAgent: 'node' },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame(fn) { rafQ.push(fn); return rafQ.length; },
    cancelAnimationFrame() {},
    setTimeout(fn, ms) { timers.push({ at: now + (ms || 0), fn }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1] = null; },
    setInterval(fn, ms) { const t = { at: now + ms, every: ms, fn }; timers.push(t); return timers.length; },
    clearInterval(id) { if (timers[id - 1]) timers[id - 1] = null; },
    performance: { now: () => now },
    console,
    Math: opts.math || Math, JSON, Date, Object, Array, Number, String, Promise, Set, Map, WeakMap, Proxy, Reflect, Symbol,
    parseInt, parseFloat, isFinite, isNaN, Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    Int8Array, Int16Array, Int32Array, ArrayBuffer, DataView, URLSearchParams, URL, Error, TypeError, RangeError,
    WebAssembly, TextDecoder, TextEncoder, BigInt, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { search: opts.replay ? '?replay=1&tut=0' : (opts.search || ''), pathname: '/games/smash-it/index.html', href: 'http://x/games/smash-it/index.html' },
    // The SDK, recorded instead of sent.
    kjStartV2() { win.__kjSeed = seed; return sync({ seed }); },
    kjEmit(type, payload) { trace.push({ type, payload }); },
    kjSubmitV2(o) { results.push(o.clientClaimedScore); return sync({ authoritativeScore: o.clientClaimedScore }); },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.parent = embed ? parent : win;
  win.postMessage = function (m) { posted.push(m); };
  win.__smashItHarness = {};
  if (opts.replay) win.__kjReplay = opts.replay;
  for (const id in els) els[id]._setTimer((f) => win.setTimeout(f, 0));
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(PRESS, 'utf8'), ctx, { filename: 'kj-press.js' });
  vm.runInContext(fs.readFileSync(REPLAY, 'utf8'), ctx, { filename: 'kj-replay.js' });
  vm.runInContext(fs.readFileSync(THREE, 'utf8'), ctx, { filename: 'three.min.js' });
  // Node has no WebGL: the renderer alone is a stand-in.
  vm.runInContext('void 0', ctx);
  win.THREE.WebGLRenderer = function () { return standIn(log, 'renderer'); };
  vm.runInContext(fs.readFileSync(RAPIER, 'utf8'), ctx, { filename: 'rapier.js' });
  // index.html order: the vendors, the SDK, the bridge, rules.js, audio.js, game.js.
  vm.runInContext(opts.bridge || bridgeSource(), ctx, { filename: 'bridge.js' });
  vm.runInContext(opts.rules || fs.readFileSync(RULES, 'utf8'), ctx, { filename: 'rules.js' });
  vm.runInContext(fs.readFileSync(AUDIO, 'utf8'), ctx, { filename: 'audio.js' });
  vm.runInContext(gameSource(opts.source), ctx, { filename: 'game.js' });

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
  function frame() { const q = rafQ; rafQ = []; for (const fn of q) fn(now); }
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
  const pr = () => win.__smashItHarness.game;
  let pid = 1;
  function tap(x, y, opts2 = {}) {
    const id = pid++;
    fireWin('pointerdown', { pointerType: opts2.mouse ? 'mouse' : 'touch', pointerId: id, clientX: x, clientY: y, target: opts2.target || canvas, isPrimary: true, isTrusted: true, preventDefault() {} });
    if (!opts2.hold) { fireWin('pointerup', { pointerType: opts2.mouse ? 'mouse' : 'touch', pointerId: id, clientX: x, clientY: y, target: canvas }); fireWin('touchend', { touches: [] }); }
    return id;
  }
  function release(id) { fireWin('pointerup', { pointerType: 'touch', pointerId: id, target: canvas }); fireWin('touchend', { touches: [] }); }
  function click(id) { doc.getElementById(id)._fire('click', {}); }
  function sendConfig() { fireWin('message', { data: { type: 'KJ_CONFIG' } }); }

  // Rapier compiles its WebAssembly asynchronously; wait for the game to see it.
  const until = Date.now() + 30000;
  while (Date.now() < until && !(pr() && pr().engineReady)) await new Promise((r) => setTimeout(r, 5));
  if (!(pr() && pr().engineReady)) throw new Error('physics engine did not start: hook=' + !!pr() + ' RAPIER=' + typeof win.RAPIER + ' KTRules=' + typeof win.KTRules);
  if (embed && !opts.deferSession) sendConfig();
  frame();
  return {
    win, log, trace, results, posted, els, canvas, probe: pr, doc, ctx,
    advance, advanceHidden, frameAt, hide, tap, release, click, fireWin,
    clickPlay() { click('playBtn'); },
    readySession() { sendConfig(); },
    get now() { return now; },
    hz,
  };
}

// ── pilots ─────────────────────────────────────────────────────────────────
// Every pilot reads the GAME's own world (positions of blocks still standing)
// and taps a screen point through the game's own camera. Styles:
//   sharpshooter  no lag, aims at the lowest supporting jar/TNT at once; the
//                 bot a seed-reader could build (the bot-gap reference)
//   good/average/novice  human models: reaction lag after the last shot,
//                 aim noise in world units, a share of careless top shots
//   spammer       taps random points as fast as the gap allows
//   thumbs        two fingers landing together each time (one press must count)
//   idle          never taps
const PILOTS = {
  sharpshooter: { lag: 0, noise: 0, careless: 0 },
  good: { lag: 24, noise: 0.18, careless: 0.1 },
  average: { lag: 45, noise: 0.35, careless: 0.25 },
  novice: { lag: 75, noise: 0.6, careless: 0.45 },
  spammer: { spam: true },
  thumbs: { lag: 30, noise: 0.25, careless: 0.2, thumbs: true },
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

// A target: TNT first, then the jar with the most blocks resting above it,
// low and central; careless shots pick any standing block.
function pickTarget(S, rnd, careless) {
  const list = S.blocks;
  if (!list.length) return null;
  if (careless && rnd() < careless) { const b = list[Math.floor(rnd() * list.length)]; return b.body.translation(); }
  let best = null, bs = -1e9;
  for (const b of list) {
    const p = b.body.translation();
    if (p.y < -0.5) continue;
    let above = 0;
    for (const o of list) { const q = o.body.translation(); if (q.y > p.y + 0.3 && Math.abs(q.x - p.x) < 1.2) above++; }
    const sc = (b.t === 'bomb' ? 40 : b.t === 'jar' ? 10 : b.t === 'ice' ? 4 : 0) + above * 3 - p.y * 2 - Math.abs(p.x) * 0.3;
    if (sc > bs) { bs = sc; best = p; }
  }
  return best;
}

/**
 * fly(g, pilot, { maxSteps, rngSeed, onStep }) flies one run to its end.
 * Decisions happen once per game STEP; a tap is a real pointer event.
 */
function fly(g, pilotName, opts = {}) {
  const p = typeof pilotName === 'string' ? PILOTS[pilotName] : pilotName;
  const rnd = mulberry(opts.rngSeed || 7);
  const maxSteps = opts.maxSteps || 60 * 60 * 10;
  if (g.probe().mode !== 'play') g.clickPlay();
  const G = g.probe();
  let lastStep = -1, readyAt = 0, lastShots = 0, guard = 0;
  while (G.mode === 'play' && G.S.step < maxSteps && guard < maxSteps * 4) {
    guard++;
    const S = G.S;
    if (S.step !== lastStep) {
      lastStep = S.step;
      if (opts.onStep) opts.onStep(S);
      if (S.shots !== lastShots) { lastShots = S.shots; readyAt = S.step + Math.max(0, Math.round((p.lag || 0) * (1 + gauss(rnd) * 0.25))); }
      const canShoot = S.phase === 'play' && S.balls > 0 && S.step - S.lastShot >= 10 && !G.pendingShot;
      if (!p.idle && canShoot && (p.spam || S.step >= readyAt)) {
        let pt;
        if (p.spam) pt = { x: (rnd() - 0.5) * 9, y: rnd() * 8 };
        else { const t = pickTarget(S, rnd, p.careless); pt = t ? { x: t.x + gauss(rnd) * (p.noise || 0), y: t.y + gauss(rnd) * (p.noise || 0) } : null; }
        if (pt) {
          const sc = G.toScreen(pt.x, pt.y);
          if (p.thumbs) { const a = g.tap(sc.x, sc.y, { hold: true }); const b = g.tap(sc.x + 30, sc.y + 10, { hold: true }); g.release(a); g.release(b); }
          else g.tap(sc.x, sc.y);
        }
      }
    }
    g.advance(1000 / g.hz);
  }
  g.advance(4000);   // the last pieces fall and the score goes
  const S = G.S;
  return { score: S.score, step: S.step, level: S.level, shots: S.shots, end: S.end, over: S.phase === 'over' };
}

function seedHex(i) {
  let h = '';
  let a = (i * 2654435761) >>> 0;
  for (let k = 0; k < 4; k++) { a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) >>> 0; h += a.toString(16).padStart(8, '0'); }
  return h;
}

module.exports = { boot, fly, PILOTS, seedHex, gameSource, bridgeSource, pickTarget, GAME, RULES, HTML, DIR, ROOT };
