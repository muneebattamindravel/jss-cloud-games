'use strict';

/**
 * Dots Reflexes validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a wheel of four coloured slots sits in the middle of the screen
 * (two colours as halves at the start, then three, then four). A tap on the
 * right half turns it a quarter clockwise, the left half a quarter
 * anticlockwise. Dots fly in from the top and the bottom; when one arrives,
 * the slot facing it must be its colour. A match scores 1, a mismatch ends
 * the run.
 *
 * What the server does with a trace:
 *   1. rebuilds the dot stream from the session seed: dot K takes five draws
 *      from hash(seed, K, j), never from a running stream;
 *   2. applies each tap { n, side, step } before step `step` runs, exactly as
 *      the client does;
 *   3. runs the same fixed steps and counts the matches.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/dots-reflexes/js/game.js.
 * shared/tests/dotsReflexesParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump, never an edit
 * in place.
 *
 * Integer arithmetic only (+ - * / floor ceil min max imul and bit ops): no
 * trig, no pow, no Math.random, no clock and no screen, so no dmath is needed.
 */

/* eslint-disable no-var */
// ==== RULES BLOCK: identical in games/dots-reflexes/js/game.js and shared/anticheat/validators/dotsReflexes.js ====
// Rules space: the wheel turns in whole quarters. q counts clockwise quarters
// (any integer; only q & 3 matters) and changes the moment a tap lands: the
// slot that FACES an arriving dot is decided by q, never by the drawn spring.
// A dot is a distance from the wheel centre in units (16 a design pixel) that
// falls by its speed every step; it ARRIVES on step a. Everything is an integer.
var RULES_VERSION = 2;
var U = 16;                 // rule units per design pixel
var D_HIT = 87 * U;         // a dot arrives this far from the wheel centre (wheel 70 + dot 15 + 2)
var D_SPAWN = 426 * U;      // and starts just past the edge of the design field
var TRAVEL = D_SPAWN - D_HIT;
var SEP = 34 * U;           // the closest two dots on one lane may come
var V0 = 52;                // units a step for the first dot
var V_NUM = 7;              // +7 units a step for every 20 dots
var V_DEN = 20;
var VMAX = 160;
var FIRST = 90;             // the first dot arrives on this step (the start guard)
var TURN_STEPS = 9;         // steps allowed for every quarter turn a dot demands
var SLACK0 = 48;            // reaction steps between arrivals at the start
var SLACK_NUM = 3;          // minus 3 for every 20 dots
var SLACK_DEN = 20;
var SLACK_MIN = 12;
var JIT0 = 34;              // plus 0 .. jitter-1 steps from the seed
var JIT_DEN = 8;
var JIT_MIN = 8;
var BURST_GAP = 10;         // steps between the dots of a burst (same lane, same colour)
var STAGE_BONUS = 40;       // extra steps before the first dot of a new colour
var MAX_SAME = 4;           // a wheel that never turns meets a wrong colour within MAX_SAME + 1 groups
var STAGE3_AT = 12;         // the wheel gains its third colour at 12 points
var STAGE4_AT = 30;         // and its fourth at 30
var DOUBLE_FROM = 16;       // dots from both ends at once
var DOUBLE_PCT = 14;
var BURST_FROM = 24;        // three in a row on one lane
var BURST_PCT = 8;          // rolls DOUBLE_PCT .. DOUBLE_PCT + BURST_PCT - 1
var SLOWFAST_FROM = 20;     // a slow dot followed by a fast one
var SLOWFAST_PCT = 8;       // rolls after the burst band
var GEN_AHEAD = 220;        // dots exist this many steps before they arrive
var SEED_MIX = 0x85EBCA6B;
var HASH_K = 0x9E3779B1;
var HASH_J = 0x85EBCA77;
var MIX_A = 0x7FEB352D;
var MIX_B = 0x846CA68B;

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

// Draw j of dot k: a pure function of (seed, k, j).
function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, HASH_K) ^ Math.imul(j + 1, HASH_J)) | 0;
  h = Math.imul(h ^ (h >>> 16), MIX_A);
  h = Math.imul(h ^ (h >>> 15), MIX_B);
  return (h ^ (h >>> 16)) >>> 0;
}

function stageOf(k) { return k < STAGE3_AT ? 2 : k < STAGE4_AT ? 3 : 4; }
// Slot colours, slot 0..3 = top, right, bottom, left at q = 0. Two colours are
// halves; the third and fourth each take over one slot.
function slotsFor(stage) { return stage === 2 ? [0, 0, 1, 1] : stage === 3 ? [0, 2, 1, 1] : [0, 2, 1, 3]; }
// The colour facing direction d (0 top, 2 bottom) at orientation q.
function facing(slots, q, d) { return slots[(d - q) & 3]; }
// Bit i set: at q & 3 === i, direction d shows colour c.
function setFor(slots, d, c) {
  var m = 0;
  for (var q = 0; q < 4; q++) if (facing(slots, q, d) === c) m |= 1 << q;
  return m;
}
// Quarter turns needed to reach set b, from the WORST orientation in set a a
// player may be resting on (each turning the short way to its nearest b).
function turnsBetween(a, b) {
  var worst = 0;
  for (var i = 0; i < 4; i++) {
    if (!(a & (1 << i))) continue;
    var best = 2;
    for (var j = 0; j < 4; j++) {
      if (!(b & (1 << j))) continue;
      var t = (j - i) & 3;
      if (t === 3) t = 1;
      if (t < best) best = t;
    }
    if (best > worst) worst = best;
  }
  return worst;
}
function speedOf(k) { return Math.min(VMAX, V0 + Math.floor(k * V_NUM / V_DEN)); }
function slackOf(k) { return Math.max(SLACK_MIN, SLACK0 - Math.floor(k * SLACK_NUM / SLACK_DEN)); }
function jitterOf(k) { return Math.max(JIT_MIN, JIT0 - Math.floor(k / JIT_DEN)); }
function travelSteps(v) { return Math.ceil(TRAVEL / v); }

function initSim(seedHex, version) {
  return {
    version: version, seed: seedToInt(seedHex), step: 0, q: 0, taps: 0,
    score: 0, dead: false, deathStep: -1, deathK: -1,
    stage: 2, slots: slotsFor(2), dots: [], events: [],
    genK: 0, genA: 0, prevSet: 1, survive: [1, 0, 0, 0], lane: [null, null, null],
    lastD: 0, lastC: 0, burstLeft: 0, fastNext: 0
  };
}

// The next dot (or pair) behind the last one on the same lane must never
// catch it up, at the arrival nor at its own spawn.
function laneOk(prev, a, v) {
  if (!prev) return true;
  if (v * (a - prev.a) < SEP) return false;
  var spawn = a - travelSteps(v);
  if (spawn < prev.a && v * travelSteps(v) - prev.v * (prev.a - spawn) < SEP) return false;
  return true;
}

// Dot k (or the pair k, k + 1): five draws on every index, whatever is used.
function genNext(sim) {
  var k = sim.genK, s = sim.seed, st = stageOf(k), slots = slotsFor(st);
  var r0 = hash(s, k, 0), r1 = hash(s, k, 1), r2 = hash(s, k, 2), r3 = hash(s, k, 3), r4 = hash(s, k, 4);
  var roll = r2 % 100, newStage = k > 0 && stageOf(k - 1) !== st;
  var blocked = 0, q, i, set = 0, d = 0, c = -1, burstDot = false, burstLeft = sim.burstLeft;
  // Every orientation that has survived MAX_SAME groups running must lose
  // this one, so a wheel left alone always meets a wrong colour.
  for (q = 0; q < 4; q++) if (sim.survive[q] >= MAX_SAME) blocked |= 1 << q;
  var group = [];
  if (burstLeft > 0) {
    burstLeft--;
    set = setFor(slots, sim.lastD, sim.lastC);
    if (set & blocked) burstLeft = 0;
    else { group = [{ d: sim.lastD, c: sim.lastC }]; burstDot = true; }
  }
  if (!group.length && k >= DOUBLE_FROM && roll < DOUBLE_PCT) {
    for (i = 0; i < 4 && !group.length; i++) {
      var o = (r4 + i) & 3, ct = facing(slots, o, 0), cb = facing(slots, o, 2);
      var sp = setFor(slots, 0, ct) & setFor(slots, 2, cb);
      if (!(sp & blocked)) { set = sp; group = [{ d: 0, c: ct }, { d: 2, c: cb }]; }
    }
  }
  if (!group.length) {
    var order = [];
    if (newStage) order.push(st - 1);        // a new colour arrives first
    for (i = 0; i < st; i++) order.push((r1 + i) % st);
    for (var pass = 0; pass < 2 && c < 0; pass++) {
      d = ((r0 & 1) ? 2 : 0) ^ (pass ? 2 : 0);
      for (i = 0; i < order.length; i++) {
        var sc = setFor(slots, d, order[i]);
        if (!(sc & blocked)) { c = order[i]; set = sc; break; }
      }
    }
    if (c < 0) { d = (r0 & 1) ? 2 : 0; c = order[0]; set = setFor(slots, d, c); }
    group = [{ d: d, c: c }];
    if (k >= BURST_FROM && roll >= DOUBLE_PCT && roll < DOUBLE_PCT + BURST_PCT) burstLeft = 2;
  }
  var turns = turnsBetween(sim.prevSet, set);
  var gap;
  if (k === 0) gap = FIRST;
  else if (burstDot) gap = BURST_GAP;
  else gap = turns * TURN_STEPS + slackOf(k) + (r3 % jitterOf(k));
  if (newStage) gap += STAGE_BONUS;
  var a = sim.genA + gap, v = speedOf(k), fastNext = 0;
  if (sim.fastNext) v = Math.min(VMAX, Math.floor(v * 5 / 4));
  else if (k >= SLOWFAST_FROM && !burstDot &&
           roll >= DOUBLE_PCT + BURST_PCT && roll < DOUBLE_PCT + BURST_PCT + SLOWFAST_PCT) {
    v = Math.floor(v * 3 / 4); fastNext = 1;
  }
  var ok = false;
  while (!ok) {
    ok = true;
    for (i = 0; i < group.length; i++) if (!laneOk(sim.lane[group[i].d], a, v)) ok = false;
    if (!ok) a++;
  }
  var add = [], lane = sim.lane.slice(), survive = [];
  for (i = 0; i < group.length; i++) {
    add.push({ k: k + i, d: group[i].d, c: group[i].c, a: a, v: v, spawn: a - travelSteps(v) });
    lane[group[i].d] = { a: a, v: v };
  }
  for (q = 0; q < 4; q++) survive.push((set & (1 << q)) ? sim.survive[q] + 1 : 0);
  sim.dots = sim.dots.concat(add);
  sim.lane = lane; sim.survive = survive; sim.prevSet = set; sim.genA = a;
  sim.lastD = group[group.length - 1].d; sim.lastC = group[group.length - 1].c;
  sim.burstLeft = burstLeft; sim.fastNext = fastNext;
  sim.genK = k + group.length;
}

// A tap turns the wheel a quarter at once, even mid-spring. Never refused
// while the run is alive (the client records nothing otherwise).
function tapSim(sim, side) {
  if (sim.dead) return false;
  sim.q += side ? 1 : -1;
  sim.taps++;
  return true;
}

function stepSim(sim) {
  var ev = [];
  sim.events = ev;
  if (sim.dead) return;
  var t = ++sim.step;
  while (sim.genA <= t + GEN_AHEAD) genNext(sim);
  var keep = [];
  for (var i = 0; i < sim.dots.length; i++) {
    var dot = sim.dots[i];
    if (dot.a !== t || sim.dead) { if (dot.a >= t) keep.push(dot); continue; }
    if (facing(sim.slots, sim.q & 3, dot.d) === dot.c) {
      sim.score++;
      ev.push({ t: 'match', k: dot.k, d: dot.d, c: dot.c, n: sim.score });
    } else {
      sim.dead = true; sim.deathStep = t; sim.deathK = dot.k;
      ev.push({ t: 'die', k: dot.k, d: dot.d, c: dot.c });
    }
  }
  sim.dots = keep;
  if (sim.dead) return;
  var st = stageOf(sim.score);
  if (st !== sim.stage) {
    sim.stage = st; sim.slots = slotsFor(st);
    ev.push({ t: 'colour', slot: st === 3 ? 1 : 3 });
  }
}
// ==== END RULES BLOCK ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound far above any real run. It REFUSES further inputs, it never
// zeroes, and it stops a huge trace becoming a CPU sink.
const MAX_INPUTS = 4 * 60 * 60 * 20;

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { steps: [], margins: [], lastTap: -1, tapsSince: 0, qAtArrival: 0, needless: 0, arrivals: 0 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. At every arrival: how many steps the wheel had
// already been settled on the right slot (the MARGIN: a planner turns early
// and evenly, a hand late and unevenly), and how many taps were spent beyond
// the fewest that arrival needed (needless turns: a hand overshoots and comes
// back, a planner never does).
function noteStep(state) {
  const sim = state.sim;
  const st = state.stats;
  for (const e of sim.events) {
    if (e.t !== 'match') continue;
    st.arrivals++;
    st.margins.push(st.lastTap < 0 ? sim.step : sim.step - st.lastTap);
  }
  // needless turns, once per arrival step
  if (sim.events.some((e) => e.t === 'match' || e.t === 'die')) {
    let mask = 15;
    for (const e of sim.events) if (e.t === 'match') mask &= setFor(sim.slots, e.d, e.c);
    const from = 1 << (st.qAtArrival & 3);
    const need = mask ? turnsBetween(from, mask) : 0;
    st.needless += Math.max(0, st.tapsSince - need);
    st.tapsSince = 0;
    st.qAtArrival = sim.q;
  }
}
function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.step < step && sim.step < MAX_SIM_STEPS) { stepSim(sim); noteStep(state); }
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }
function gapCv(steps) {
  if (steps.length < 3) return null;
  const g = [];
  for (let i = 1; i < steps.length; i++) g.push(steps[i] - steps[i - 1]);
  const m = mean(g); const s = sd(g);
  return m > 0 && s !== null ? s / m : null;
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'tap') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, side, step } = payload;
  if (!isStep(n) || !isStep(step) || (side !== 0 && side !== 1)) return reject(state, 'bad_tap');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would re-run a window and keep the
  // best outcome. Several taps on one step are allowed (they apply in order).
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  // The tap names its index in the run; any other index is out of order.
  if (n !== sim.taps) return reject(state, 'out_of_order');
  tapSim(sim, side);
  state.stats.steps.push(sim.step);
  state.stats.lastTap = sim.step;
  state.stats.tapsSince++;
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always dies inside this bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const sim = state.sim;
  // Run the world out past the last input. A wheel that stops turning meets a
  // wrong colour within MAX_SAME + 1 groups.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {
    stepSim(sim); noteStep(state);
    guard++;
  }
  const st = state.stats;
  const taps = st.steps.length;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, deathStep: sim.deathStep, deathK: sim.deathK,
      score: sim.score, dead: sim.dead, stage: sim.stage,
      inputs: state.inputCount, rejects: state.rejectCount, taps,
      endSpeed: speedOf(sim.score),
      marginMean: round3(mean(st.margins)), marginSd: round3(sd(st.margins)),
      gapCv: round3(gapCv(st.steps)),
      needlessTurns: st.needless,
      needlessShare: taps ? round3(st.needless / taps) : null,
    },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  // Pinned to the session lifetime by shared/tests/sessionLifetime.test.js.
  _limits: { MAX_SIM_STEPS, FPS: 60 },
  init, processEvent, finalize, simulate,
  _sim: {
    RULES_VERSION, initSim, stepSim, tapSim, genNext, hash, seedToInt, stageOf, slotsFor, facing, setFor,
    turnsBetween, speedOf, slackOf, jitterOf, travelSteps, laneOk,
    MAX_INPUTS, MAX_SIM_STEPS,
    U, D_HIT, D_SPAWN, TRAVEL, SEP, V0, V_NUM, V_DEN, VMAX, FIRST, TURN_STEPS, SLACK0, SLACK_NUM, SLACK_DEN,
    SLACK_MIN, JIT0, JIT_DEN, JIT_MIN, BURST_GAP, STAGE_BONUS, MAX_SAME, STAGE3_AT, STAGE4_AT,
    DOUBLE_FROM, DOUBLE_PCT, BURST_FROM, BURST_PCT, SLOWFAST_FROM, SLOWFAST_PCT, GEN_AHEAD,
    SEED_MIX, HASH_K, HASH_J, MIX_A, MIX_B,
  },
};
