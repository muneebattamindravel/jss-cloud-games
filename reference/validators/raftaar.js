'use strict';

/**
 * Raftaar validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Raftaar was built on replay, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: three tracks, one ball. A tap on the left or right half moves the
 * ball one track that way (a tap mid-change re-targets at once). Spikes ride
 * the tracks toward the ball; one hit ends the run. Passing a spike scores 1,
 * collecting a diamond scores 1.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed: row K takes five draws from
 *      hash(seed, K, j), never from a running stream;
 *   2. applies each tap { n, side, step } before step `step` runs, exactly as
 *      the client does;
 *   3. runs the same fixed steps and counts what the client would have scored.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/raftaar/js/game.js.
 * shared/tests/raftaarParity.test.js fails the moment one copy changes without
 * the other. A gameplay change is a trace version bump, never an edit in place.
 *
 * Integer arithmetic only (+ - * / floor min max imul and bit ops): no trig,
 * no pow, no Math.random, no clock and no screen, so no dmath is needed.
 */

/* eslint-disable no-var */
// ==== RULES BLOCK: identical in games/raftaar/js/game.js and shared/anticheat/validators/raftaar.js ====
// Rules space: three lanes LANE_W units apart, the ball at x (units) and at
// world distance pos. Everything is an integer. The perspective, the bends,
// the hue and every effect are DRAWING and never read or write anything here.
var RULES_VERSION = 3;
var LANE_W = 96;            // units between lane centres
var START_LANE = 1;         // the run starts on the middle track
var SWITCH_RATE = 24;       // units a step while changing lane (4 steps a lane), v3
var SWITCH_RATE_V2 = 12;    // v2 runs keep their own rate (8 steps a lane)
var HIT_X = 64;             // ball and spike overlap when closer than this
var GEM_X = 48;             // ball and diamond touch when closer than this
var SPEED_BASE = 14;        // units a step at the start
var SPEED_EVERY = 4;        // +1 unit a step for every 4 spikes passed
var SPEED_MAX = 30;
var FIRST_ROW = 2400;       // the first row is this far ahead (the start guard)
var GAP_START = 46;         // steps between rows at the start
var GAP_EVERY = 3;          // one step shorter for every 3 spikes generated
var GAP_MIN = 24;           // never shorter: two lanes take 16 steps
var GAP_SPREAD = 9;         // plus 0..8 steps from the seed
var DOUBLE_FROM = 6;        // rows of two spikes from this many spikes in
var DOUBLE_PCT = 40;
var GEM_PCT = 45;
var MAX_FREE = 3;           // every lane is blocked at least once in 4 rows
var KEEP_BEHIND = 900;      // rows this far behind the ball are forgotten
var GEN_AHEAD = 6000;       // rows exist this far ahead of the ball
var SEED_MIX = 0x85EBCA6B;
var HASH_K = 0x9E3779B1;
var HASH_J = 0x85EBCA77;
var MIX_A = 0x7FEB352D;
var MIX_B = 0x846CA68B;

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

// Draw j of row k: a pure function of (seed, k, j).
function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, HASH_K) ^ Math.imul(j + 7, HASH_J)) | 0;
  h = Math.imul(h ^ (h >>> 16), MIX_A);
  h = Math.imul(h ^ (h >>> 15), MIX_B);
  return (h ^ (h >>> 16)) >>> 0;
}

// Speed follows the SPIKES passed, never the score: diamonds score too, and
// the generator sizes every gap from the spike count it will be driven at.
function speedAt(passed) { return Math.min(SPEED_MAX, SPEED_BASE + Math.floor(passed / SPEED_EVERY)); }

function laneX(i) { return (i - 1) * LANE_W; }

function initSim(seedHex, version) {
  return {
    version: version, rate: version >= 3 ? SWITCH_RATE : SWITCH_RATE_V2,
    seed: seedToInt(seedHex), step: 0, pos: 0,
    x: laneX(START_LANE), target: START_LANE, taps: 0,
    score: 0, passed: 0, gems: 0, dead: false, deathStep: -1, deathLane: -1,
    rows: [], nextRow: 0, genD: 0, genTris: 0, since: [0, 0, 0], events: []
  };
}

// Row k: five draws on every index, whatever the branch uses. Its distance is
// the last row's plus the gap, sized from the speed the pair is driven at.
function genRow(sim) {
  var k = sim.nextRow, s = sim.seed;
  var r0 = hash(s, k, 0), r1 = hash(s, k, 1), r2 = hash(s, k, 2), r3 = hash(s, k, 3), r4 = hash(s, k, 4);
  var tris = sim.genTris;
  var gap = Math.max(GAP_MIN, GAP_START - Math.floor(tris / GAP_EVERY)) + (r0 % GAP_SPREAD);
  var d = k === 0 ? FIRST_ROW : sim.genD + speedAt(tris) * gap;
  var count = (tris >= DOUBLE_FROM && (r1 % 100) < DOUBLE_PCT) ? 2 : 1;
  var blocked = [false, false, false];
  // The most overdue lane is blocked first, so nobody can park.
  var forced = -1, most = MAX_FREE - 1, i;
  for (i = 0; i < 3; i++) if (sim.since[i] > most) { most = sim.since[i]; forced = i; }
  if (count === 2) {
    var free = r2 % 3;
    if (free === forced) free = (free + 1 + (r3 % 2)) % 3;
    for (i = 0; i < 3; i++) blocked[i] = i !== free;
  } else {
    blocked[forced >= 0 ? forced : r2 % 3] = true;
  }
  var since = sim.since.slice(), open = [];
  for (i = 0; i < 3; i++) { if (blocked[i]) since[i] = 0; else { since[i]++; open.push(i); } }
  var row = { k: k, d: d, blocked: blocked, gem: -1, gemD: 0 };
  if (k > 0 && (r4 % 100) < GEM_PCT) { row.gem = open[r3 % open.length]; row.gemD = sim.genD + ((d - sim.genD) >> 1); }
  sim.rows = sim.rows.concat([row]);
  sim.nextRow = k + 1; sim.genD = d; sim.genTris = tris + count; sim.since = since;
}

// A tap moves the TARGET one lane, even mid-change. False when there is no
// lane that way (the client records nothing then).
function tapSim(sim, side) {
  if (sim.dead) return false;
  var t = sim.target + (side ? 1 : -1);
  if (t < 0 || t > 2) return false;
  sim.target = t;
  sim.taps++;
  return true;
}

function stepSim(sim) {
  var ev = [];
  sim.events = ev;
  if (sim.dead) return;
  sim.step++;
  var tx = laneX(sim.target);
  if (sim.x < tx) sim.x = Math.min(tx, sim.x + sim.rate);
  else if (sim.x > tx) sim.x = Math.max(tx, sim.x - sim.rate);
  var from = sim.pos;
  sim.pos = from + speedAt(sim.passed);
  while (sim.genD < sim.pos + GEN_AHEAD) genRow(sim);
  var keep = [], r, i;
  for (r = 0; r < sim.rows.length; r++) {
    var row = sim.rows[r];
    if (row.gem >= 0 && row.gemD > from && row.gemD <= sim.pos && Math.abs(sim.x - laneX(row.gem)) < GEM_X) {
      sim.score++; sim.gems++;
      ev.push({ t: 'gem', k: row.k, n: sim.score });
    }
    if (row.d > from && row.d <= sim.pos) {
      for (i = 0; i < 3; i++) {
        if (row.blocked[i] && Math.abs(sim.x - laneX(i)) < HIT_X) {
          sim.dead = true; sim.deathStep = sim.step; sim.deathLane = i;
          ev.push({ t: 'die', k: row.k, lane: i });
          return;
        }
      }
      for (i = 0; i < 3; i++) {
        if (row.blocked[i]) { sim.passed++; sim.score++; ev.push({ t: 'pass', k: row.k, lane: i, n: sim.score }); }
      }
    }
    if (row.d > sim.pos - KEEP_BEHIND) keep.push(row);
  }
  sim.rows = keep;
}
// ==== END RULES BLOCK ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound far above any real run (the rules take any number of taps on a
// step, but a hand cannot make more than a few a second). It REFUSES further
// inputs, it never zeroes, and it stops a huge trace becoming a CPU sink.
const MAX_INPUTS = 4 * 60 * 60 * 20;
// How far ahead a spike is visible on screen, in units (the drawing's ZFAR).
// Used only to describe reaction times for the bot detector.
const VISIBLE_UNITS = 4200;

function advanceTo(sim, step) {
  while (!sim.dead && sim.step < step && sim.step < MAX_SIM_STEPS) stepSim(sim);
}

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
    stats: { margins: [], seen: [], steps: [], needless: 0, edge: 0 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. At each tap: how many steps remain before the next
// row reaches the ball (the reaction MARGIN: a planner switches early and
// evenly, a hand late and unevenly), and how long that row has been on screen.
function noteTap(state, side) {
  const sim = state.sim;
  const st = state.stats;
  let next = null;
  for (const row of sim.rows) if (row.d > sim.pos && (!next || row.d < next.d)) next = row;
  st.steps.push(sim.step);
  if (!next) return;
  const v = speedAt(sim.passed);
  const left = next.d - sim.pos;
  st.margins.push(Math.floor(left / v));
  st.seen.push(Math.max(0, Math.floor((VISIBLE_UNITS - left) / v)));
  // A tap that moves the ball off a lane the next row leaves open.
  if (!next.blocked[sim.target]) st.needless++;
  // A tap that runs into the edge is refused by the rules before it gets here.
  void side;
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
      state.sim = initSim(state.seed, Number(payload.v) >= 3 ? 3 : 2);
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
  advanceTo(sim, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  // The tap names its index in the run; any other index is out of order.
  if (n !== sim.taps) return reject(state, 'out_of_order');
  // The client only records a tap the rules applied, so a refused one is forged.
  if (!tapSim(sim, side)) return reject(state, 'refused');
  noteTap(state, side);
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
  // Run the world out past the last input. A ball that stops moving dies
  // within MAX_FREE + 1 rows, because every lane is blocked that often.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {
    stepSim(sim);
    guard++;
  }
  const st = state.stats;
  const taps = st.steps.length;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, deathStep: sim.deathStep, deathLane: sim.deathLane,
      score: sim.score, passed: sim.passed, gems: sim.gems, dead: sim.dead,
      inputs: state.inputCount, rejects: state.rejectCount, taps,
      endSpeed: speedAt(sim.passed),
      marginMean: round3(mean(st.margins)), marginSd: round3(sd(st.margins)),
      seenMean: round3(mean(st.seen)), seenSd: round3(sd(st.seen)),
      gapCv: round3(gapCv(st.steps)),
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
    RULES_VERSION, initSim, stepSim, tapSim, genRow, advanceTo, hash, seedToInt, speedAt, laneX,
    MAX_INPUTS, MAX_SIM_STEPS, VISIBLE_UNITS,
    LANE_W, START_LANE, SWITCH_RATE, SWITCH_RATE_V2, HIT_X, GEM_X, SPEED_BASE, SPEED_EVERY, SPEED_MAX,
    FIRST_ROW, GAP_START, GAP_EVERY, GAP_MIN, GAP_SPREAD, DOUBLE_FROM, DOUBLE_PCT, GEM_PCT,
    MAX_FREE, KEEP_BEHIND, GEN_AHEAD, SEED_MIX, HASH_K, HASH_J, MIX_A, MIX_B,
  },
};
