'use strict';

/**
 * Helpers shared by the Smash It suites.
 *
 *   clientRules()       a fresh copy of the CLIENT's rules (games/smash-it/js/rules.js
 *                       and the vendored rapier.js) in its own sandbox, never the
 *                       validator's copy
 *   shotsOf(trace)      the shot payloads of a recorded trace
 *   serverWorlds(...)   the validator's own rules flown over a shot schedule,
 *                       returning the world after every step
 *   digest(world)       a short hash of one step's world (goldens)
 *   corpusRun(...)      a rules-level run on the client copy with a planner that
 *                       reads the client world (deep levels the page pilots never reach)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const V = require('../../anticheat/validators/smashIt');

const ROOT = path.join(__dirname, '..', '..', '..');
const RULES = path.join(ROOT, 'games', 'smash-it', 'js', 'rules.js');
const RAPIER = path.join(ROOT, 'games', 'smash-it', 'js', 'vendor', 'rapier.js');

async function clientRules(src) {
  const win = {
    WebAssembly, TextDecoder, TextEncoder, console, Promise, Object, Array, Math, Error, TypeError, RangeError, Symbol, BigInt, Number, String,
    Function, Reflect, JSON, Set, Map, WeakMap, Proxy, ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, parseInt, parseFloat, isFinite, isNaN,
    Date, performance: { now: () => 0 },   // Rapier reads a clock for its own step timers (never for results)
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(RAPIER, 'utf8'), ctx, { filename: 'rapier.js' });
  vm.runInContext(src || fs.readFileSync(RULES, 'utf8'), ctx, { filename: 'rules.js' });
  await win.KTRules.ready();
  return win.KTRules;
}

function shotsOf(trace) {
  return trace.map((e) => e.payload || e).filter((p) => p && p.kind === 'shot');
}

function serverWorlds(seed, shots, steps, level) {
  const X = V._sim;
  const sim = X.initSim(typeof seed === 'string' ? X.seedToInt(seed) : seed, level || 1);
  sim.events = [];
  const out = [];
  let k = 0;
  for (let s = 0; s < steps && sim.phase !== 'over'; s++) {
    while (k < shots.length && shots[k].step === sim.step) { X.shoot(sim, shots[k].x, shots[k].y); k++; }
    X.stepSim(sim);
    sim.events = [];
    out.push(X.snapshot(sim));
  }
  try { sim.world.free(); } catch (_e) { /* freed */ }
  return out;
}

function sameWorld(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function digest(world) {
  const buf = Buffer.from(new Float64Array(world).buffer);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * corpusRun(K, seedInt, level, { rng, steps, every, noise, onStep })
 * Plays the client copy K from `level` with a planner that aims at the most
 * load-bearing block (TNT first), every `every` steps, with aim noise. Returns
 * the shot schedule, the client worlds, and a tally of what the run reached.
 */
function corpusRun(K, seedInt, level, opts = {}) {
  const rnd = mulberry(opts.rng || 1);
  const S = K.initSim(seedInt, level);
  const shots = [], worlds = [], seen = {};
  const steps = opts.steps || 1800, every = opts.every || 24, noise = opts.noise === undefined ? 0.2 : opts.noise;
  for (const e of S.events) seen[e.e] = (seen[e.e] || 0) + 1;
  S.events = [];
  if (S.fan) seen.hasFan = 1; if (S.shields.length) seen['shields' + S.shields.length] = 1; if (S.pend) seen.hasPend = 1; if (S.boss) seen.boss = 1;
  for (let s = 0; s < steps && S.phase !== 'over'; s++) {
    if (S.phase === 'play' && S.step % every === 0 && S.blocks.length && S.balls > 0) {
      let best = null, bs = -1e9;
      for (const b of S.blocks) {
        const p = b.body.translation(); let above = 0;
        for (const o of S.blocks) { const q = o.body.translation(); if (q.y > p.y + 0.3 && Math.abs(q.x - p.x) < 1.2) above++; }
        const sc = (opts.prefer ? (b.t === opts.prefer ? 100 : 0) : (b.t === 'bomb' ? 40 : b.t === 'jar' ? 10 : 0)) + above * 3 - p.y * 2 + rnd() * 6;
        if (sc > bs) { bs = sc; best = p; }
      }
      const x = Math.round((best.x + (rnd() - 0.5) * 2 * noise) * 100), y = Math.round((best.y + (rnd() - 0.5) * 2 * noise) * 100);
      const n = S.shots, step = S.step;
      if (K.shoot(S, x, y) === true) shots.push({ kind: 'shot', n, x, y, step });
    }
    K.stepSim(S);
    for (const e of S.events) {
      seen[e.e] = (seen[e.e] || 0) + 1;
      if (e.e === 'break') seen['break:' + e.t] = (seen['break:' + e.t] || 0) + 1;
      if (e.e === 'break' && e.how === 'crush') seen.crush = (seen.crush || 0) + 1;
      if (e.e === 'fall') seen['fall:' + e.t] = (seen['fall:' + e.t] || 0) + 1;
      if (e.e === 'bonk') seen['bonk:' + e.what] = (seen['bonk:' + e.what] || 0) + 1;
      if (e.e === 'crack') seen['crack:' + e.t] = (seen['crack:' + e.t] || 0) + 1;
    }
    S.events = [];
    worlds.push(K.snapshot(S));
    if (opts.onStep) opts.onStep(S);
  }
  if (S.end) seen['end:' + S.end] = 1;
  const out = { shots, worlds, seen, score: S.score, step: S.step, phase: S.phase, level: S.level };
  try { S.world.free(); } catch (_e) { /* freed */ }
  return out;
}

module.exports = { clientRules, shotsOf, serverWorlds, sameWorld, digest, corpusRun, mulberry, RULES, ROOT };
