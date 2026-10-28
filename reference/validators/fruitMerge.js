'use strict';
// Fruit Merge: server-side deterministic REPLAY (Oct 2026, migration 207).
//
// A Suika-style merge game against a 5 minute clock. Fruits are circles in a
// jar, moved by a small integer physics engine (Verlet steps, a fixed number of
// solver passes in body id order, bounce and friction from integer arithmetic,
// Math.sqrt as the only non-trivial op, which IEEE 754 makes exact on every
// engine). The rules block below is carried WORD FOR WORD in
// games/fruit-merge/js/game.js; shared/tests/fruitMergeParity.test.js fails if
// the two ever differ.
//
// Trace v2: { kind: 'start', v: 2 } then one { kind: 'drop', n, x, step } per
// drop the client applied: the drop index, the integer design x it was
// released at, and the fixed step it was applied before. The server steps the
// world to that step and drops the same fruit (drop n's tier is a pure
// function of (seed, n)). A drop the rules refuse (in the reload, before the
// last fruit landed, out of order, rewound, after the run ended) is REFUSED
// and changes nothing; refusals never zero the run.
//
// The block keeps the game's two-space indent so it is byte-identical.

  // ==== FRUITMERGE RULES BEGIN (word for word in games/fruit-merge/js/game.js and shared/anticheat/validators/fruitMerge.js) ====
  // Integers only: +, -, *, /, Math.trunc, Math.floor, Math.sqrt (correctly
  // rounded everywhere) and comparisons. No clock, no screen, no Math.random.
  // Positions are in 1/256 design units. Bodies are circles moved by Verlet
  // integration (the velocity is position minus previous position) and pushed
  // apart by a fixed number of solver passes, always in body id order.
  var SU = 256;
  var JAR_L = 40 * SU, JAR_R = 374 * SU, FLOOR_Y = 656 * SU;   // v3; v2 traces keep FLOOR_Y_V2
  var FLOOR_Y_V2 = 716 * SU;
  var DANGER_Y = 272 * SU;      // a settled body poking above this line counts toward overflow
  var DROP_Y = 172 * SU;        // where a dropped fruit appears
  var RADII = [0, 13, 18, 23, 29, 35, 43, 51, 59, 69, 80, 95];   // design units, tier 1..11
  var TOP_TIER = 11;
  var DROP_TIERS = 5;
  var DROP_WEIGHTS = [0, 28, 25, 22, 16, 9];   // out of 100, tiers 1..5
  var GRAVITY = 100;            // sub units per step per step
  var DAMP = 255;               // velocity kept per step, out of 256 (air drag)
  var FLOOR_FRICTION = 200;     // horizontal velocity kept on the floor, out of 256 (v3)
  var FLOOR_FRICTION_V2 = 235;
  var VMAX = 20 * SU;           // per axis, per step (under the smallest pair's 26 unit reach)
  var VMAX_UP = 6 * SU;         // upward, per step: a bounce, never a launch
  var SOLVER_PASSES = 10;
  var MAX_PUSH = 4 * SU;        // one solver pass moves a pair apart by at most this, so a deep overlap eases out instead of launching
  var BOUNCE = 64;              // share of the approach speed returned on impact, out of 256
  var BOUNCE_MIN = 384;         // impacts slower than 1.5 units a step do not bounce
  var PAIR_FRICTION = 40;       // tangential sliding removed per step between touching fruits, out of 256 (v3)
  var PAIR_FRICTION_V2 = 12;
  var GROW_STEPS = 6;           // a merged fruit grows from half size over 6 steps
  var MERGE_SLOP = SU;          // equal fruits merge when within one design unit of touching
  var CHAIN_STEPS = 90;         // a merge this soon after its parent's birth is a chain
  var DROP_LOCK_STEPS = 60;     // a drop is refused until 60 steps (1 s) after the last one
  var DANGER_AGE = 60;          // a body younger than this is still falling in
  var DANGER_STEPS = 180;       // 3 seconds over the line ends the run
  var RUN_STEPS = 18000;        // 5 minutes at 60 steps a second
  var MAX_DROPS = 700;          // a work bound: the lock allows at most 600
  var MAX_BODIES = 220;         // a work bound: the jar holds far fewer
  var RULES_VERSION = 4;
  function tri(t) { return (t * (t + 1)) / 2; }
  // Points for a merge into tier t (v4: doubling, 2 4 8 ... 1024; v2 and v3:
  // the triangle number), and for two top-tier fruits vanishing (v4: 2048).
  function mergePoints(v, t) { return v >= 4 ? (1 << (t - 1)) : tri(t); }
  function topPoints(v) { return v >= 4 ? (1 << TOP_TIER) : tri(TOP_TIER); }
  function hash32(a, b, c) {
    var h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul(b | 0, 0x85EBCA6B) ^ Math.imul(c | 0, 0xC2B2AE35)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846CA68B) >>> 0; h ^= h >>> 16;
    return h >>> 0;
  }
  function seedToInt(seedHex) {
    return (typeof seedHex === 'string' && /^[0-9a-fA-F]{8}/.test(seedHex)) ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
  }
  // Drop n's tier: one draw on every index.
  function tierOf(seedInt, n) {
    var h = hash32(seedInt, n, 7) % 100, acc = 0;
    for (var t = 1; t <= DROP_TIERS; t++) { acc += DROP_WEIGHTS[t]; if (h < acc) return t; }
    return 1;
  }
  function isqrt(v) {
    var s = Math.floor(Math.sqrt(v));
    while (s * s > v) s--;
    while ((s + 1) * (s + 1) <= v) s++;
    return s;
  }
  function clampV(v) { return v > VMAX ? VMAX : (v < -VMAX ? -VMAX : v); }
  function bodyR(b) { return Math.trunc(RADII[b.t] * SU * (GROW_STEPS + b.g) / (2 * GROW_STEPS)); }
  function dropLimits(t) { return [Math.trunc(JAR_L / SU) + RADII[t], Math.trunc(JAR_R / SU) - RADII[t]]; }
  // The version is the one the trace's start marker recorded: a v2 run is
  // replayed on the v2 jar and friction, a v3 run on the v3 jar with the
  // triangle scores, anything else on the current rules.
  function initSim(seedInt, version) {
    var v2 = version === 2;
    return { seed: seedInt >>> 0, v: v2 ? 2 : (version === 3 ? 3 : RULES_VERSION), fy: v2 ? FLOOR_Y_V2 : FLOOR_Y,
      ffr: v2 ? FLOOR_FRICTION_V2 : FLOOR_FRICTION, pfr: v2 ? PAIR_FRICTION_V2 : PAIR_FRICTION, bodies: [], nextId: 1, step: 0, n: 0, readyAt: 0, lastStep: 0, score: 0,
      maxTier: 0, dangerT: 0, dead: false, endReason: '', ev: [] };
  }
  function makeBody(sim, t, x, y, px, py, g, chain) {
    var b = { id: sim.nextId, t: t, x: x, y: y, px: px, py: py, g: g, age: 0, born: sim.step, chain: chain };
    sim.nextId = sim.nextId + 1;
    return b;
  }
  // Drop n at design x on step `step` (the step it is applied before). A
  // refusal changes nothing.
  function dropSim(sim, x, step) {
    if (sim.dead) return 'dead';
    if (typeof x !== 'number' || x !== Math.floor(x) || x < -100000 || x > 100000) return 'bad_x';
    if (step !== sim.step) return step < sim.step ? 'frame_regressed' : 'not_yet';
    if (step >= RUN_STEPS) return 'time_up';
    if (step < sim.readyAt) return 'busy';
    if (sim.n >= MAX_DROPS) return 'drop_cap';
    if (sim.bodies.length >= MAX_BODIES) return 'body_cap';
    var t = tierOf(sim.seed, sim.n), lim = dropLimits(t);
    var cx = x < lim[0] ? lim[0] : (x > lim[1] ? lim[1] : x);
    var b = makeBody(sim, t, cx * SU, DROP_Y, cx * SU, DROP_Y, GROW_STEPS, 0);
    sim.bodies = sim.bodies.concat([b]);
    sim.n = sim.n + 1;
    sim.readyAt = step + DROP_LOCK_STEPS;
    sim.lastStep = step;
    if (t > sim.maxTier) sim.maxTier = t;
    return b;
  }
  function solvePair(a, b) {
    var ra = bodyR(a), rb = bodyR(b), rs = ra + rb;
    var dx = b.x - a.x, dy = b.y - a.y;
    if (dx >= rs || dx <= -rs || dy >= rs || dy <= -rs) return;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs) return;
    var d = isqrt(d2);
    if (d === 0) { dx = 1; dy = 0; d = 1; }
    var over = rs - d;
    if (over > MAX_PUSH) over = MAX_PUSH;
    var ma = RADII[a.t] * RADII[a.t], mb = RADII[b.t] * RADII[b.t];
    var sa = Math.trunc(mb * 1024 / (ma + mb));
    var cx = Math.trunc(dx * over / d), cy = Math.trunc(dy * over / d);
    var ax = Math.trunc(cx * sa / 1024), ay = Math.trunc(cy * sa / 1024);
    a.x = a.x - ax; a.y = a.y - ay;
    b.x = b.x + (cx - ax); b.y = b.y + (cy - ay);
  }
  // Velocity is position minus previous position, so a change of velocity is
  // made by moving the previous position the other way.
  function contactPair(a, b, ax0, ay0, bx0, by0, pfr) {
    var rs = bodyR(a) + bodyR(b) + SU;
    var dx = b.x - a.x, dy = b.y - a.y;
    if (dx >= rs || dx <= -rs || dy >= rs || dy <= -rs) return;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs) return;
    var d = isqrt(d2);
    if (d === 0) return;
    var ma = RADII[a.t] * RADII[a.t], mb = RADII[b.t] * RADII[b.t];
    var sa = Math.trunc(mb * 1024 / (ma + mb));
    // bounce: approach speed along the normal, measured before the step
    var vn0 = Math.trunc(((bx0 - ax0) * dx + (by0 - ay0) * dy) / d);
    var rvx = (b.x - b.px) - (a.x - a.px), rvy = (b.y - b.py) - (a.y - a.py);
    var vn = Math.trunc((rvx * dx + rvy * dy) / d);
    var dv = 0;
    if (vn0 < -BOUNCE_MIN) { dv = Math.trunc(-vn0 * BOUNCE / 256) - vn; if (dv < 0) dv = 0; }
    // friction: part of the sliding along the tangent
    var vt = Math.trunc((rvy * dx - rvx * dy) / d);
    var dt = -Math.trunc(vt * pfr / 256);
    if (dv === 0 && dt === 0) return;
    var cx = Math.trunc((dx * dv - dy * dt) / d), cy = Math.trunc((dy * dv + dx * dt) / d);
    var ax = Math.trunc(cx * sa / 1024), ay = Math.trunc(cy * sa / 1024);
    a.px = a.px + ax; a.py = a.py + ay;
    b.px = b.px - (cx - ax); b.py = b.py - (cy - ay);
  }
  function solveWalls(b, fy) {
    var r = bodyR(b);
    if (b.x < JAR_L + r) b.x = JAR_L + r;
    if (b.x > JAR_R - r) b.x = JAR_R - r;
    if (b.y > fy - r) b.y = fy - r;
  }
  function clampStep(bs) {
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var uy = clampV(b.y - b.py); if (uy < -VMAX_UP) uy = -VMAX_UP;
      b.px = b.x - clampV(b.x - b.px); b.py = b.y - uy;
    }
  }
  // One fixed 1/60 s step. Leaves the step's events in sim.ev.
  function stepSim(sim) {
    if (sim.dead) return;
    var bs = sim.bodies.map(function (o) { return { id: o.id, t: o.t, x: o.x, y: o.y, px: o.px, py: o.py, g: o.g, age: o.age, born: o.born, chain: o.chain }; });
    var ev = [], i, j, b, v0x = [], v0y = [];
    for (i = 0; i < bs.length; i++) {
      b = bs[i];
      var vx = clampV(Math.trunc((b.x - b.px) * DAMP / 256));
      var vy = clampV(Math.trunc((b.y - b.py) * DAMP / 256) + GRAVITY);
      v0x.push(vx); v0y.push(vy);
      b.px = b.x; b.py = b.y; b.x = b.x + vx; b.y = b.y + vy;
      if (b.g < GROW_STEPS) b.g = b.g + 1;
      b.age = b.age + 1;
    }
    for (var pass = 0; pass < SOLVER_PASSES; pass++) {
      for (i = 0; i < bs.length; i++) for (j = i + 1; j < bs.length; j++) solvePair(bs[i], bs[j]);
      for (i = 0; i < bs.length; i++) solveWalls(bs[i], sim.fy);
    }
    // Nothing leaves a step faster than the speed limit, however hard it was
    // pushed. v2 clamped before the contacts; v3 clamps after them, because
    // contact friction could still add an upward kick past VMAX_UP.
    if (sim.v === 2) clampStep(bs);
    // Contacts: a bounce from the approach speed before the step, then
    // friction on what is left of the sliding, in pair order.
    for (i = 0; i < bs.length; i++) for (j = i + 1; j < bs.length; j++) contactPair(bs[i], bs[j], v0x[i], v0y[i], v0x[j], v0y[j], sim.pfr);
    for (i = 0; i < bs.length; i++) {
      b = bs[i];
      var r = bodyR(b);
      if (b.y >= sim.fy - r) {
        b.px = b.x - Math.trunc((b.x - b.px) * sim.ffr / 256);
        if (v0y[i] > BOUNCE_MIN) b.py = b.y + Math.trunc(v0y[i] * BOUNCE / 256);
      }
      if (b.x <= JAR_L + r && v0x[i] < -BOUNCE_MIN) b.px = b.x + Math.trunc(v0x[i] * BOUNCE / 256);
      if (b.x >= JAR_R - r && v0x[i] > BOUNCE_MIN) b.px = b.x + Math.trunc(v0x[i] * BOUNCE / 256);
    }
    if (sim.v !== 2) clampStep(bs);
    // Merges, in pair order. Each body merges at most once a step.
    var gone = {}, born = [], merged = 0;
    for (i = 0; i < bs.length; i++) {
      if (gone[bs[i].id]) continue;
      for (j = i + 1; j < bs.length; j++) {
        var a = bs[i], c = bs[j];
        if (gone[c.id] || a.t !== c.t) continue;
        var rs = bodyR(a) + bodyR(c) + MERGE_SLOP, dx = c.x - a.x, dy = c.y - a.y;
        if (dx >= rs || dx <= -rs || dy >= rs || dy <= -rs || dx * dx + dy * dy > rs * rs) continue;
        gone[a.id] = 1; gone[c.id] = 1; merged++;
        var mx = Math.trunc((a.x + c.x) / 2), my = Math.trunc((a.y + c.y) / 2);
        var near = (sim.step - a.born <= CHAIN_STEPS && a.chain > 0) || (sim.step - c.born <= CHAIN_STEPS && c.chain > 0);
        var chain = near ? Math.max(a.chain, c.chain) + 1 : 1;
        if (a.t < TOP_TIER) {
          var nt = a.t + 1;
          born.push(makeBody(sim, nt, mx, my, Math.trunc((a.px + c.px) / 2), Math.trunc((a.py + c.py) / 2), 0, chain));
          sim.score = sim.score + mergePoints(sim.v, nt);
          if (nt > sim.maxTier) sim.maxTier = nt;
          ev.push({ k: 'merge', t: nt, x: mx, y: my, chain: chain, top: false, a: a.id, c: c.id });
        } else {
          sim.score = sim.score + topPoints(sim.v);
          ev.push({ k: 'merge', t: TOP_TIER, x: mx, y: my, chain: chain, top: true, a: a.id, c: c.id });
        }
        break;
      }
    }
    if (merged) bs = bs.filter(function (o) { return !gone[o.id]; }).concat(born);
    sim.bodies = bs;
    var over = false;
    for (i = 0; i < bs.length; i++) {
      b = bs[i];
      if (b.age >= DANGER_AGE && b.y - RADII[b.t] * SU < DANGER_Y) { over = true; break; }
    }
    sim.dangerT = over ? sim.dangerT + 1 : 0;
    sim.step = sim.step + 1;
    if (sim.dangerT >= DANGER_STEPS) { sim.dead = true; sim.endReason = 'full'; ev.push({ k: 'full' }); }
    else if (sim.step >= RUN_STEPS) { sim.dead = true; sim.endReason = 'time'; }
    sim.ev = ev;
  }
  // ==== FRUITMERGE RULES END ====

const MAX_SIM_STEPS = 3600 * 60;   // a work bound: the session hour
const MAX_INPUTS = MAX_DROPS + 200;

function isStep(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }
function isX(v) { return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= -100000 && v <= 100000; }
function round3(v) { return v === null || v === undefined ? null : Math.round(v * 1000) / 1000; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function sd(a) { const m = mean(a); return m === null ? null : Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length); }
function dropReady(sim) { return sim.step >= sim.readyAt; }

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600, elapsedSecs: Number(elapsedSecs) || 0,
    // humanness raw material (recorded, never gated)
    stats: { dropSteps: [], xs: [], atLimit: 0, readyStep: 0, dropIds: {}, mergeDrops: 0 },
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

// One step, plus what the fingerprint wants to know about it: the first step
// the dropper was ready again, and whether a dropped fruit merged soon after.
function step1(state) {
  const sim = state.sim, st = state.stats;
  const wasReady = dropReady(sim);
  stepSim(sim);
  if (!wasReady && dropReady(sim)) st.readyStep = sim.step;
  for (const e of sim.ev) {
    if (e.k !== 'merge') continue;
    for (const id of [e.a, e.c]) {
      if (st.dropIds[id] !== undefined) { if (sim.step - st.dropIds[id] <= 120) st.mergeDrops++; delete st.dropIds[id]; }
    }
  }
}

function advanceTo(state, target) {
  const sim = state.sim;
  while (!sim.dead && sim.step < target && sim.step < MAX_SIM_STEPS) step1(state);
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};
  if (p.kind === 'start') {
    if (Number(p.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(seedToInt(state.seed), Number(p.v));
    }
    return { accepted: true, newScore: state.score };
  }
  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || p.kind !== 'drop') return { accepted: true, newScore: state.score };
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  const { n, x, step } = p;
  if (!isStep(n) || !isX(x) || !isStep(step)) return reject(state, 'bad_drop');
  const sim = state.sim;
  // Steps never go backwards: a rewind would re-run a window and keep the best outcome.
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  if (n !== sim.n) return reject(state, 'out_of_order');
  const st = state.stats;
  const atLimit = dropReady(sim) && step === st.readyStep;
  const r = dropSim(sim, x, step);
  // The client only records a drop the rules applied, so a refused one is forged.
  if (typeof r === 'string') return reject(state, r);
  st.dropSteps.push(step);
  st.xs.push(Math.trunc(r.x / SU));
  if (atLimit) st.atLimit++;
  st.dropIds[r.id] = step;
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always ends inside this bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function fingerprint(state) {
  const st = state.stats;
  const gaps = [];
  for (let i = 1; i < st.dropSteps.length; i++) gaps.push(st.dropSteps[i] - st.dropSteps[i - 1]);
  const gm = mean(gaps), gs = sd(gaps);
  const drops = st.dropSteps.length;
  return {
    drops,
    gapMeanSteps: round3(gm),
    gapCv: gm ? round3(gs / gm) : null,
    atLimitShare: drops ? round3(st.atLimit / drops) : null,
    xSd: round3(sd(st.xs)),
    mergeShare: drops ? round3(st.mergeDrops / drops) : null,
  };
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out past the last drop, so merges still in motion score. The
  // clock is a rule (RUN_STEPS), so nobody parks: the run ends by then.
  const capSteps = elapsedCap(state, 60);
  while (!sim.dead && sim.step < capSteps && sim.step < MAX_SIM_STEPS) step1(state);
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: Object.assign({
      mode: 'sim', steps: sim.step, drops: sim.n, score: sim.score, dead: sim.dead, endReason: sim.endReason,
      maxTier: sim.maxTier, inputs: state.inputCount, rejects: state.rejectCount,
    }, { fingerprint: fingerprint(state) }),
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  // Pinned to the session lifetime by shared/tests/sessionLifetime.test.js.
  _limits: { MAX_SIM_STEPS, FPS: 60, RUN_STEPS },
  init, processEvent, finalize, simulate,
  _sim: {
    SU, JAR_L, JAR_R, FLOOR_Y, DANGER_Y, DROP_Y, RADII, TOP_TIER, DROP_TIERS, DROP_WEIGHTS, GRAVITY, DAMP,
    FLOOR_FRICTION, FLOOR_Y_V2, FLOOR_FRICTION_V2, PAIR_FRICTION_V2, VMAX, VMAX_UP, SOLVER_PASSES, MAX_PUSH, BOUNCE, BOUNCE_MIN, PAIR_FRICTION, GROW_STEPS,
    MERGE_SLOP, CHAIN_STEPS, DROP_LOCK_STEPS, DANGER_AGE, DANGER_STEPS, RUN_STEPS, MAX_DROPS,
    MAX_BODIES, RULES_VERSION, MAX_SIM_STEPS, MAX_INPUTS,
    tri, mergePoints, topPoints, hash32, seedToInt, tierOf, isqrt, clampV, bodyR, dropLimits, initSim, makeBody, dropSim,
    solvePair, contactPair, solveWalls, clampStep, stepSim, dropReady, elapsedCap,
  },
};
