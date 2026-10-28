'use strict';

/**
 * Gannay Wala validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Gannay Wala was integrated on replay, so there is no v1 path: a trace
 * without a v2 start marker is not a run (the session layer refuses markerless
 * traces platform-wide anyway) and scores zero.
 *
 * The game: a farmer chops a sugarcane stalk from the left or the right. Every
 * chop scores one and drops the stalk by a segment. A leaf that comes down on
 * the farmer's side ends the run, and a timer that drains every step (faster as
 * the score climbs) ends it too; every chop tops the timer up.
 *
 * What the server does with a trace:
 *   1. rebuilds the stalk from the session seed: row K's two draws are a pure
 *      function of (seed, K), never of a running stream;
 *   2. applies each chop { n, side, step } on the fixed step it landed on,
 *      before that step drains the timer, exactly as the client does;
 *   3. runs the same fixed steps as the client and counts the chops the leaf
 *      and timer rules allow.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below (constants and the sim functions) is carried WORD FOR
 * WORD in games/gannay-wala/js/game.js. shared/tests/gannayWalaParity.test.js
 * pulls every constant and every sim function out of both files and fails the
 * moment one copy is edited without the other. Edit both or neither; a gameplay
 * change is a trace version bump, never an edit in place.
 *
 * Integer arithmetic only: the hazard chance is a comparison of integers out of
 * HAZARD_SCALE, the timer is integer units. No trig, no pow, no Math.random.
 */

// ==== RULES BLOCK: identical in games/gannay-wala/js/game.js ====
const ENERGY_MAX = 10000;
const ENERGY_START = 5850;
const ROWS_VISIBLE = 10;
const OPEN_CLEAR_ROWS = 3;
const START_GUARD_STEPS = 27;
const DRAIN_BASE = 30;
const DRAIN_RAMP_CAP = 14;
const DRAIN_SCORE_CAP = 120;
const GAIN_BASE = 750;
const GAIN_FLOOR = 620;
const HAZARD_SCALE = 11000;
const HAZARD_BASE = 4730;
const HAZARD_PER_POINT = 20;
const HAZARD_CAP = 7920;
const LEAF_LIMIT_EARLY = 2;
const LEAF_LIMIT_MID = 3;
const LEAF_LIMIT_LATE = 4;
const LEAF_MID_FROM = 35;
const LEAF_LATE_FROM = 90;
const RNG_STRIDE = 0x9E3779B1;
const RNG_SALT = 0x6A77A1E5;
const SEED_MIX = 0x85EBCA6B;
const RULES_VERSION = 6;
const DRAIN_RAMP_CAP_V2 = 43;
const GAIN_FLOOR_V2 = 450;
const DRAIN_RAMP_CAP_V3 = 36;
const GAIN_FLOOR_V3 = 620;
const DRAIN_RAMP_CAP_V4 = 40;
const GAIN_FLOOR_V4 = 520;
// v5: the stalk is built from Timberman-style patterns. 1 is the pattern's own
// side, -1 the other side, 0 a clear row. Harder patterns unlock by score tier.
const TIER_FROM = [25, 70, 140];
const TIER_POOL = [3, 6, 9, 12];
const TIER_BREATH = [2, 1, 0, 0];
const BREATH_ROWS = [0, 0, 0];
// Fairness, in the generator because only the generator sees what came before.
// Leaves NEVER sit on opposite sides of touching rows. Such a pair is legal by
// the rules (only the row that drops level kills, and stepping under a leaf
// that is about to be cut away is forgiven) but it FORCES the farmer to walk
// into the leaf beside him, which every player reads as certain death. A clear
// row is inserted instead and the leaf is kept for the next row, so a switch
// always gets one free chop. MAX_LEAF_RUN does the same for a long same-side
// stack. Neither drops a leaf: the pattern is delayed, never edited.
const MAX_LEAF_RUN = 4;
// v6 (30 Sep 2026): leaves never touch at all, same side or opposite, so every
// leaf is followed by at least one clear row. Stacks become spaced same-side
// runs and zigzags keep their rhythm with a clear row between. Two more tiers,
// and the drain keeps creeping after score DRAIN_LATE_FROM, so a long run keeps
// getting harder. Every milestone is 30% sooner than v5's (x0.7), and past
// DRAIN_LATE_FROM the drain never goes flat: +1 every DRAIN_LATE_EVERY points,
// then from DRAIN_LATE_EASE on each step waits one DRAIN_LATE_EVERY longer than
// the last, up to the safety cap DRAIN_LATE_CAP.
const TIER_FROM_V6 = [18, 49, 98, 154, 224];
const TIER_POOL_V6 = [3, 6, 9, 12, 15, 18];
const TIER_BREATH_V6 = [2, 1, 0, 0, 0, 0];
const DRAIN_LATE_FROM = 49;
const DRAIN_LATE_EVERY = 21;
const DRAIN_LATE_EASE = 8;
const DRAIN_LATE_CAP = 24;
// v6 refill shrinks as the bar fills: full below BAR_EASE_FROM, falling
// linearly to (100 - BAR_TOP_CUT)% at a full bar, and the cut itself grows by
// one percent every BAR_CUT_EVERY points up to BAR_CUT_CAP. A steady player can
// no longer pin the bar at full; a low bar still refills in full.
const BAR_EASE_FROM = 5000;
const BAR_TOP_CUT = 45;
const BAR_CUT_EVERY = 10;
const BAR_CUT_CAP = 30;
const PATTERNS_V6 = [[1, 0, 0], [1, 0, 1, 0, 0], [1, 0, 0, -1, 0, 0], [1, 0, -1, 0], [1, 0, 1, 0, -1, 0], [1, 0, -1, 0, 1, 0], [1, 0, -1, 0, 1, 0, -1, 0], [1, 0, 1, 0, -1, 0, 1, 0], [1, 0, -1, 0, -1, 0, 1, 0], [1, 0, -1, 0, 1, 0, -1, 0, 1, 0], [1, 0, -1, 0, 1, 0, 1, 0, -1, 0], [1, 0, 1, 0, -1, 0, 1, 0, -1, 0], [1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1, 0], [1, 0, -1, 0, -1, 0, 1, 0, -1, 0, 1, 0], [1, 0, 1, 0, -1, 0, 1, 0, -1, 0, -1, 0], [1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1, 0], [1, 0, -1, 0, -1, 0, 1, 0, -1, 0, 1, 0, 1, 0, -1, 0], [1, 0, -1, 0, 1, 0, -1, 0, -1, 0, 1, 0, -1, 0, 1, 0]];
const PATTERNS = [[1, 0, 0], [1, 1, 0, 0], [1, 0, 0, -1, 0, 0], [1, 1, 1, 0], [1, 0, -1, 0, 1, 0], [1, 1, 0, -1, -1, 0], [1, 1, 1, 1, 0, -1, 0], [1, -1, 1, 0], [1, 0, -1, 0, 1, 0, -1, 0], [1, -1, 1, -1, 1, 0], [1, 1, -1, -1, 1, 1, 0], [1, -1, -1, 1, 1, -1, 0]];

function rowRng(seedInt, index) {
  let a = (((seedInt ^ RNG_SALT) >>> 0) + Math.imul(index + 1, RNG_STRIDE)) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

function lateDrainFor(score) {
  let late = 0;
  let gap = DRAIN_LATE_EVERY;
  let at = DRAIN_LATE_FROM + gap;
  while (score >= at && late < DRAIN_LATE_CAP) {
    late++;
    if (late >= DRAIN_LATE_EASE) gap += DRAIN_LATE_EVERY;
    at += gap;
  }
  return late;
}

function drainFor(score, version) {
  if (version >= 6) return DRAIN_BASE + Math.min(DRAIN_RAMP_CAP, Math.floor(Math.min(score, DRAIN_SCORE_CAP) * 4 / 7)) + lateDrainFor(score);
  const cap = version >= 5 ? DRAIN_RAMP_CAP : version >= 4 ? DRAIN_RAMP_CAP_V4 : version >= 3 ? DRAIN_RAMP_CAP_V3 : DRAIN_RAMP_CAP_V2;
  return DRAIN_BASE + Math.min(cap, Math.floor(Math.min(score, DRAIN_SCORE_CAP) * 2 / 5));
}

function gainFor(score, version) {
  if (version >= 6) return Math.max(GAIN_FLOOR, GAIN_BASE - Math.floor(score * 18 / 7));
  return Math.max(version >= 5 ? GAIN_FLOOR : version >= 4 ? GAIN_FLOOR_V4 : version >= 3 ? GAIN_FLOOR_V3 : GAIN_FLOOR_V2, GAIN_BASE - Math.floor(score * 9 / 5));
}

function leafLimitFor(score) {
  return score < LEAF_MID_FROM ? LEAF_LIMIT_EARLY : score < LEAF_LATE_FROM ? LEAF_LIMIT_MID : LEAF_LIMIT_LATE;
}

function tierFor(score, version) {
  const from = version >= 6 ? TIER_FROM_V6 : TIER_FROM;
  let tier = 0;
  while (tier < from.length && score >= from[tier]) tier++;
  return tier;
}

// v5 row K: three draws, always, whether or not a new pattern starts here. Half
// the time a pattern is picked from the newest ones the tier unlocked. The
// sequence is replaced, never edited in place.
function patternRow(sim) {
  const rng = rowRng(sim.seedInt, sim.rowsMade);
  sim.rowsMade++;
  const pickRoll = rng();
  const sideRoll = rng() >>> 31;
  const gapRoll = rng();
  if (sim.patPos >= sim.patSeq.length) {
    const v6 = sim.version >= 6;
    const pool = v6 ? TIER_POOL_V6 : TIER_POOL;
    const tier = tierFor(sim.score, sim.version);
    const lo = tier > 0 && (pickRoll & 1) === 0 ? pool[tier - 1] : 0;
    const idx = lo + ((pickRoll >>> 1) % (pool[tier] - lo));
    sim.patSeq = (v6 ? PATTERNS_V6 : PATTERNS)[idx].concat(BREATH_ROWS.slice(0, (v6 ? TIER_BREATH_V6 : TIER_BREATH)[tier] + (gapRoll % 2)));
    sim.patPos = 0;
    sim.patSide = sideRoll === 1 ? 1 : -1;
  }
  const rel = sim.patSeq[sim.patPos];
  let row = rel === 0 ? 0 : rel * sim.patSide;
  const flips = row !== 0 && sim.lastLeaf !== 0 && row !== sim.lastLeaf;
  const stacks = row !== 0 && (sim.version >= 6 ? sim.lastLeaf !== 0 : sim.leafRun >= MAX_LEAF_RUN);
  if (flips || stacks) row = 0; else sim.patPos++;
  sim.leafRun = row === 0 ? 0 : sim.leafRun + 1;
  sim.lastLeaf = row;
  return row;
}

// Row K draws exactly two numbers, always, even when the row is forced clear,
// so no rule can change which numbers a later row gets.
function nextRow(sim) {
  if (sim.version >= 5) return patternRow(sim);
  const rng = rowRng(sim.seedInt, sim.rowsMade);
  sim.rowsMade++;
  const hazardRoll = rng() % HAZARD_SCALE;
  const sideRoll = rng() >>> 31;
  let leaves = 0;
  for (let i = 0; i < sim.rows.length; i++) {
    if (sim.rows[i] !== 0) leaves++;
  }
  if (leaves >= leafLimitFor(sim.score)) return 0;
  if (sim.rows[sim.rows.length - 1] !== 0) return 0;
  if (hazardRoll >= Math.min(HAZARD_CAP, HAZARD_BASE + sim.score * HAZARD_PER_POINT)) return 0;
  return sideRoll === 1 ? 1 : -1;
}

function refillFor(sim) {
  const g = gainFor(sim.score, sim.version);
  if (sim.version < 6 || sim.energy <= BAR_EASE_FROM) return g;
  const cut = BAR_TOP_CUT + Math.min(BAR_CUT_CAP, Math.floor(sim.score / BAR_CUT_EVERY));
  return g - Math.floor((g * cut * (sim.energy - BAR_EASE_FROM)) / (100 * (ENERGY_MAX - BAR_EASE_FROM)));
}

function initSim(seedHex, version) {
  const sim = {
    version: version >= RULES_VERSION ? RULES_VERSION : version >= 5 ? 5 : version >= 4 ? 4 : version >= 3 ? 3 : 2,
    seedInt: seedToInt(seedHex), frames: 0, score: 0, energy: ENERGY_START, side: -1,
    rows: [], rowsMade: 0, patSeq: [], patPos: 0, patSide: 1, leafRun: 0, lastLeaf: 0, chops: 0, lastChopStep: -1, dead: false, deathFrame: 0, deathCause: '',
  };
  for (let i = 0; i < OPEN_CLEAR_ROWS; i++) sim.rows.push(0);
  while (sim.rows.length < ROWS_VISIBLE) sim.rows.push(nextRow(sim));
  return sim;
}

function killSim(sim, cause) {
  sim.dead = true;
  sim.deathFrame = sim.frames;
  sim.deathCause = cause;
}

// One fixed step. The timer does not drain inside the start guard, so the
// press that started the run costs nothing.
function stepSim(sim) {
  if (sim.dead) return;
  if (sim.frames >= START_GUARD_STEPS) sim.energy = Math.max(0, sim.energy - drainFor(sim.score, sim.version));
  sim.frames++;
  if (sim.energy === 0) killSim(sim, 'time');
}

// A chop lands BEFORE the step it names drains the timer. One chop per step;
// a second press on the same step, or one inside the start guard, is refused.
// rows[0] is the segment level with the farmer: after the stalk drops, a leaf
// there on his side ends the run. The fatal chop still counts.
function chopSim(sim, side) {
  if (sim.dead || (side !== -1 && side !== 1)) return false;
  if (sim.frames < START_GUARD_STEPS || sim.lastChopStep === sim.frames) return false;
  sim.lastChopStep = sim.frames;
  sim.chops++;
  sim.side = side;
  sim.rows.shift();
  sim.score++;
  sim.rows.push(nextRow(sim));
  sim.energy = Math.min(ENERGY_MAX, sim.energy + refillFor(sim));
  if (sim.rows[0] === sim.side) killSim(sim, 'leaves');
  return true;
}
// ==== END RULES BLOCK ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it. In practice the timer ends any
// run within ENERGY_MAX / DRAIN_BASE steps of its last chop.
const MAX_SIM_STEPS = 60 * 60 * 60;
// The rules allow at most one chop per step, so an hour of chopping is at most
// MAX_SIM_STEPS chops. A human manages a small fraction of that. It REFUSES
// further inputs, it never zeroes, and it stops a huge trace becoming a CPU sink.
const MAX_INPUTS = MAX_SIM_STEPS;

function advanceTo(sim, step) {
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepSim(sim);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing would
// apply a malformed step as if it were real.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0,
    rejectCount: 0,
    score: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
  };
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
      // v6 (30 Sep 2026): leaves never touch, and the ramp keeps climbing. Each
      // version replays on its own rules.
      // v3 (15 Sep 2026): a gentler timer. A v2 trace, from a run already in
      // progress when the change deployed, is scored by the v2 timer it was played on.
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'chop') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, side, step } = payload;
  if (!isStep(n) || !isStep(step) || (side !== -1 && side !== 1)) return reject(state, 'bad_chop');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would let an attacker re-run the
  // same window and keep the best outcome. A repeat of the current step is
  // allowed through to chopSim, which refuses a second chop on it.
  if (step < sim.frames) return reject(state, 'frame_regressed');

  advanceTo(sim, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  // The chop names its index in the run. Any other index is out of order (a
  // stolen or reshuffled trace) and is refused whole.
  if (n !== sim.chops) return reject(state, 'out_of_order');
  // The client only records a chop it applied, so a refused one is forged.
  if (!chopSim(sim, side)) return reject(state, 'refused');
  state.score = sim.score;
  if (sim.dead) state.dead = true;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always dies inside this bound. Only the
// submit replay passes elapsedSecs; the live stream keeps the session bound.
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
  // Run the world out past the last input. The timer ends every run that
  // stopped chopping within ENERGY_MAX / DRAIN_BASE steps.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepSim(sim);
    guard++;
  }
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame, deathCause: sim.deathCause,
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      chops: sim.chops,
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
    RULES_VERSION, DRAIN_RAMP_CAP_V2, GAIN_FLOOR_V2, DRAIN_RAMP_CAP_V3, GAIN_FLOOR_V3, DRAIN_RAMP_CAP_V4, GAIN_FLOOR_V4,
    TIER_FROM, TIER_POOL, TIER_BREATH, BREATH_ROWS, PATTERNS, MAX_LEAF_RUN, tierFor, patternRow,
    TIER_FROM_V6, TIER_POOL_V6, TIER_BREATH_V6, PATTERNS_V6, DRAIN_LATE_FROM, DRAIN_LATE_EVERY, DRAIN_LATE_EASE, DRAIN_LATE_CAP, lateDrainFor,
    BAR_EASE_FROM, BAR_TOP_CUT, BAR_CUT_EVERY, BAR_CUT_CAP, refillFor,
    initSim, stepSim, chopSim, killSim, nextRow, rowRng, seedToInt, drainFor, gainFor, leafLimitFor,
    advanceTo, MAX_INPUTS, MAX_SIM_STEPS,
    ENERGY_MAX, ENERGY_START, ROWS_VISIBLE, OPEN_CLEAR_ROWS, START_GUARD_STEPS, DRAIN_BASE, DRAIN_RAMP_CAP,
    DRAIN_SCORE_CAP, GAIN_BASE, GAIN_FLOOR, HAZARD_SCALE, HAZARD_BASE, HAZARD_PER_POINT, HAZARD_CAP,
    LEAF_LIMIT_EARLY, LEAF_LIMIT_MID, LEAF_LIMIT_LATE, LEAF_MID_FROM, LEAF_LATE_FROM,
  },
};
