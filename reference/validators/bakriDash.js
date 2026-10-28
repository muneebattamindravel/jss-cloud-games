'use strict';

/**
 * Bakri Dash validator: SERVER-SIDE DETERMINISTIC REPLAY, and
 * nothing else.
 *
 * There is no v1 path. The game was born on replay, so a trace without a v2
 * start marker is simply not a run and scores zero.
 *
 * What the server does with a trace:
 *   1. rebuilds every lane from the session seed: lane N's type, trees,
 *      mover speed, spacing, length, phase and direction are a pure function
 *      of (seed, N), never of a running stream;
 *   2. steps the world at 1/60 s: every cart, log and train position is a
 *      closed form of (lane, step), integer arithmetic only;
 *   3. applies each hop { n, dir, step } on the fixed step it landed on;
 *   4. ends the run on the same rules as the client: a cart or train, water,
 *      the canal edge, the cheel after IDLE_STEPS without a forward hop, or
 *      falling behind the camera.
 *
 * The client's own number is never read. require_claimed_match in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/bakri-dash/js/game.js.
 * shared/tests/bakriDashParity.test.js pulls every constant and every rules
 * function out of both files and fails the moment one copy is edited without
 * the other. A gameplay change is a trace version bump, never an edit in place.
 */

// ==== RULES BLOCK: identical in games/bakri-dash/js/game.js ====
const COLS = 9;
const CELL = 64;
const HALF_CELL = 32;
const WORLD_W = 576;
const LANE_SUB = 256;
const HOP_STEPS = 8;
const START_GUARD_STEPS = 27;
const IDLE_STEPS = 420;
const HERO_HALF = 18;
const LOG_GRACE = 8;
const START_COL = 4;
const START_LANES = 2;
const REST_EVERY = 10;
const GRASS = 0;
const ROAD = 1;
const RIVER = 2;
const RAIL = 3;
const DIR_UP = 0;
const DIR_LEFT = 1;
const DIR_RIGHT = 2;
const DIR_DOWN = 3;
const GRASS_BASE = 45;
const GRASS_MIN = 12;
const GRASS_RAMP = 6;
const RIVER_FROM = 6;
const RAIL_FROM = 14;
const RAIL_PCT = 14;
const RIVER_PCT = 30;
const LANE_LOOP = 2304;
const LANE_MARGIN = 288;
const ROAD_V_MIN = 1;
const ROAD_V_BASE = 2;
const ROAD_V_RAMP = 25;
const ROAD_V_CAP = 6;
const ROAD_LENS = [48, 96, 128];
const ROAD_GAPS = [576, 384, 288, 256, 192];
const ROAD_GAP_RAMP = 20;
const ROAD_CLEAR = 160;
const RIVER_V_MIN = 1;
const RIVER_V_BASE = 1;
const RIVER_V_RAMP = 30;
const RIVER_V_CAP = 3;
const RIVER_LENS = [256, 192, 128];
const RIVER_LEN_RAMP = 40;
const RIVER_WATER_MIN = 48;
const RIVER_WATER_BASE = 112;
const RIVER_WATER_RAMP = 10;
const RIVER_WATER_CAP = 192;
const TRAIN_V = 24;
const TRAIN_LEN = 704;
const TRAIN_MARGIN = 768;
const RAIL_PERIOD_BASE = 420;
const RAIL_PERIOD_MIN = 220;
const RAIL_PERIOD_STEP = 20;
const RAIL_PERIOD_RAMP = 10;
const RAIL_PERIOD_SPREAD = 120;
const TREE_ALLOWED = 455;
const TREE_ALL = 511;
const CAM_CREEP_BASE = 1;
const CAM_CREEP_RAMP = 40;
const CAM_CREEP_CAP = 4;
const CAM_CHASE = 12;
const CAM_BEHIND = 768;
const RNG_STRIDE = 0x9E3779B1;
const RNG_SALT = 0x3A11C0DE;
const RULES_VERSION = 3;
const COIN_POINTS = 1;
const COIN_POINTS_V2 = 0;

function laneRng(seedInt, index) {
  let a = (((seedInt ^ RNG_SALT) >>> 0) + Math.imul(index + 1, RNG_STRIDE)) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedToInt(seedHex) {
  return (typeof seedHex === 'string' && seedHex.length >= 8)
    ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
}

// Lane N is a pure function of (seed, N). All nine draws happen on every
// index in this order, whichever branches use them, so no branch can shift
// the stream for another field.
function laneSpec(seedInt, n) {
  const rng = laneRng(seedInt, n);
  const typeRoll = rng();
  const kindRoll = rng();
  const dirRoll = rng();
  const speedRoll = rng();
  const gapRoll = rng();
  const lenRoll = rng();
  const phaseRoll = rng();
  const treeRollA = rng();
  const treeRollB = rng();
  let type = GRASS;
  if (n > START_LANES && n % REST_EVERY !== 0) {
    const grassPct = Math.max(GRASS_MIN, GRASS_BASE - Math.floor(n / GRASS_RAMP));
    if (Math.floor(typeRoll * 100) >= grassPct) {
      const k = Math.floor(kindRoll * 100);
      if (n >= RAIL_FROM && k < RAIL_PCT) type = RAIL;
      else if (n >= RIVER_FROM && k < RAIL_PCT + RIVER_PCT) type = RIVER;
      else type = ROAD;
    }
  }
  const dir = dirRoll < 0.5 ? -1 : 1;
  let speed = 0;
  let len = 0;
  let gap = 1;
  let count = 0;
  let loop = 1;
  let margin = 0;
  let trees = 0;
  if (type === ROAD) {
    const vHi = Math.min(ROAD_V_CAP, ROAD_V_BASE + Math.floor(n / ROAD_V_RAMP));
    speed = ROAD_V_MIN + Math.floor(speedRoll * (vHi - ROAD_V_MIN + 1));
    len = ROAD_LENS[Math.floor(lenRoll * ROAD_LENS.length)];
    const gi = Math.min(ROAD_GAPS.length - 1, Math.floor(n / ROAD_GAP_RAMP));
    const want = Math.max(ROAD_GAPS[Math.floor(gapRoll * (gi + 1))], len + ROAD_CLEAR);
    loop = LANE_LOOP;
    margin = LANE_MARGIN;
    count = Math.floor(loop / want);
    gap = Math.floor(loop / count);
  } else if (type === RIVER) {
    const vHi = Math.min(RIVER_V_CAP, RIVER_V_BASE + Math.floor(n / RIVER_V_RAMP));
    speed = RIVER_V_MIN + Math.floor(speedRoll * (vHi - RIVER_V_MIN + 1));
    const li = Math.min(RIVER_LENS.length - 1, Math.floor(n / RIVER_LEN_RAMP));
    len = RIVER_LENS[li + Math.floor(lenRoll * (RIVER_LENS.length - li))];
    const wHi = Math.min(RIVER_WATER_CAP, RIVER_WATER_BASE + Math.floor(n / RIVER_WATER_RAMP));
    const want = len + RIVER_WATER_MIN + Math.floor(gapRoll * (wHi - RIVER_WATER_MIN + 1));
    loop = LANE_LOOP;
    margin = LANE_MARGIN;
    count = Math.floor(loop / want);
    gap = Math.floor(loop / count);
  } else if (type === RAIL) {
    speed = TRAIN_V;
    len = TRAIN_LEN;
    const period = Math.max(RAIL_PERIOD_MIN, RAIL_PERIOD_BASE - RAIL_PERIOD_STEP * Math.floor(n / RAIL_PERIOD_RAMP))
      + Math.floor(gapRoll * (RAIL_PERIOD_SPREAD + 1));
    loop = period * TRAIN_V;
    margin = TRAIN_MARGIN;
    gap = loop;
    count = 1;
  } else {
    trees = n < 0 ? TREE_ALL : (Math.floor(treeRollA * 512) & Math.floor(treeRollB * 512) & TREE_ALLOWED);
  }
  const phase = Math.floor(phaseRoll * loop);
  return { type: type, dir: dir, speed: speed, len: len, gap: gap, count: count, loop: loop,
    margin: margin, phase: phase, trees: trees };
}

// Where mover k's left edge is at step t: a closed form, in world units.
function moverLeft(spec, k, t) {
  const raw = spec.phase + k * spec.gap + spec.dir * spec.speed * t;
  return (((raw % spec.loop) + spec.loop) % spec.loop) - spec.margin;
}

function laneHits(spec, x, t) {
  for (let k = 0; k < spec.count; k++) {
    const left = moverLeft(spec, k, t);
    if (x + HERO_HALF > left && x - HERO_HALF < left + spec.len) return true;
  }
  return false;
}

function logUnder(spec, x, t) {
  for (let k = 0; k < spec.count; k++) {
    const left = moverLeft(spec, k, t);
    if (x >= left - LOG_GRACE && x <= left + spec.len + LOG_GRACE) return true;
  }
  return false;
}

// The coin on field lane N: one column, or -1. A pure function of (seed, N),
// the very place the coins have always been drawn. v3 (15 Sep 2026): a
// coin is worth a point; a v2 trace, from a run already in progress when that
// deployed, keeps coins worth nothing.
function coinCol(seedInt, n, spec) {
  if (n <= START_LANES || spec.type !== GRASS) return -1;
  let h = Math.imul(seedInt ^ 0x51ED, 0x2C1B3C6D) + Math.imul(n, 0x297A2D39);
  h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B) >>> 0;
  if (h % 4 !== 0) return -1;
  const col = (h >>> 8) % COLS;
  return ((spec.trees >> col) & 1) ? -1 : col;
}

function coinPointsFor(version) {
  return version >= 3 ? COIN_POINTS : COIN_POINTS_V2;
}

function initSim(seedHex, version) {
  return {
    version: version >= RULES_VERSION ? RULES_VERSION : 2,
    seedInt: seedToInt(seedHex),
    frames: 0,
    lane: 0,
    x: START_COL * CELL + HALF_CELL,
    hop: false,
    hopT: 0,
    fromX: START_COL * CELL + HALF_CELL,
    toX: START_COL * CELL + HALF_CELL,
    fromLane: 0,
    lastDir: DIR_UP,
    hops: 0,
    idleSteps: 0,
    camY: 0,
    maxLane: 0,
    score: 0,
    coins: 0,
    coinsTaken: [],
    dead: false,
    deathFrame: null,
    deathCause: null,
  };
}

function killSim(sim, cause) {
  sim.dead = true;
  sim.deathFrame = sim.frames;
  sim.deathCause = cause;
}

function stepSim(sim) {
  if (sim.dead) return;
  sim.frames++;
  const spec = laneSpec(sim.seedInt, sim.lane);
  if (sim.hop) {
    sim.hopT++;
    sim.x = sim.fromX + Math.floor(((sim.toX - sim.fromX) * sim.hopT) / HOP_STEPS);
    if (sim.hopT >= HOP_STEPS) {
      sim.hop = false;
      sim.hopT = 0;
      sim.x = sim.toX;
      if (sim.lane > sim.maxLane) sim.maxLane = sim.lane;
      const coin = coinCol(sim.seedInt, sim.lane, spec);
      if (coin >= 0 && Math.floor(sim.x / CELL) === coin && sim.coinsTaken.indexOf(sim.lane) < 0) {
        // A NEW list, never a push: a shallow copy of the state (a lookahead) must
        // never be able to change the taken coins of the state it was copied from.
        sim.coinsTaken = sim.coinsTaken.concat([sim.lane]);
        sim.coins++;
      }
      sim.score = sim.maxLane + sim.coins * coinPointsFor(sim.version);
    }
  } else if (spec.type === RIVER) {
    sim.x += spec.dir * spec.speed;
  }
  sim.idleSteps++;
  if (sim.idleSteps >= IDLE_STEPS) {
    killSim(sim, 'eagle');
    return;
  }
  if (sim.hops > 0) {
    sim.camY += Math.min(CAM_CREEP_CAP, CAM_CREEP_BASE + Math.floor(sim.maxLane / CAM_CREEP_RAMP));
  }
  const want = sim.lane * LANE_SUB;
  if (want > sim.camY) sim.camY = Math.min(want, sim.camY + CAM_CHASE);
  if (want < sim.camY - CAM_BEHIND) {
    killSim(sim, 'camera');
    return;
  }
  if (spec.type === ROAD || spec.type === RAIL) {
    if (laneHits(spec, sim.x, sim.frames)) killSim(sim, spec.type === RAIL ? 'train' : 'hit');
    return;
  }
  if (spec.type === RIVER && !sim.hop) {
    if (sim.x < 0 || sim.x > WORLD_W) {
      killSim(sim, 'edge');
      return;
    }
    if (!logUnder(spec, sim.x, sim.frames)) killSim(sim, 'drown');
  }
}

// One hop. Refused while a hop is still in the air, inside the start guard,
// into a tree, or out of the world: a refused hop changes nothing.
function hopSim(sim, dir) {
  if (sim.dead || sim.hop || sim.frames < START_GUARD_STEPS) return false;
  if (dir !== DIR_UP && dir !== DIR_LEFT && dir !== DIR_RIGHT && dir !== DIR_DOWN) return false;
  const toLane = sim.lane + (dir === DIR_UP ? 1 : (dir === DIR_DOWN ? -1 : 0));
  const spec = laneSpec(sim.seedInt, toLane);
  let toX = sim.x + (dir === DIR_LEFT ? -CELL : (dir === DIR_RIGHT ? CELL : 0));
  if (spec.type === RIVER) {
    if (toX < 0 || toX > WORLD_W) return false;
  } else {
    const col = Math.floor(toX / CELL);
    if (col < 0 || col >= COLS) return false;
    if ((spec.trees >> col) & 1) return false;
    toX = col * CELL + HALF_CELL;
  }
  sim.hop = true;
  sim.hopT = 0;
  sim.fromX = sim.x;
  sim.toX = toX;
  sim.fromLane = sim.lane;
  sim.lane = toLane;
  sim.lastDir = dir;
  sim.hops++;
  if (dir === DIR_UP) sim.idleSteps = 0;
  return true;
}
// ==== END RULES BLOCK ====

// ── server-only bounds ──────────────────────────────────────────────────
//
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it. In practice the cheel takes
// the goat IDLE_STEPS after its last forward hop, so the bound is only ever
// reached by a trace that keeps hopping forward for an hour.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A hop takes HOP_STEPS, so an hour holds at most 27,000 of them. 40,000 is
// past any possible run and stops a huge trace turning one submit into a CPU
// sink. It REFUSES further inputs, it never zeroes.
const MAX_INPUTS = 40000;

function advanceTo(sim, step) {
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepSim(sim);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing would
// apply a malformed step as if it were real.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function isDir(v) {
  return v === DIR_UP || v === DIR_LEFT || v === DIR_RIGHT || v === DIR_DOWN;
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
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'hop') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, dir, step } = payload;
  if (!isStep(n) || !isStep(step) || !isDir(dir)) return reject(state, 'bad_hop');

  const sim = state.sim;
  // Steps may REPEAT (a hop can land on the step the previous one ended on)
  // but never go BACKWARDS: a rewind would let an attacker re-run the same
  // window and keep the best outcome.
  if (step < sim.frames) return reject(state, 'frame_regressed');

  advanceTo(sim, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  // Hops are numbered in the order the client applied them. Any other number
  // is a reshuffled or stitched trace and is refused whole.
  if (n !== sim.hops) return reject(state, 'out_of_order');
  // The client only records a hop it applied, so a hop the rules refuse (still
  // in the air, inside the start guard, into a tree or out of the world) is a
  // forged one. Refused, never buffered.
  if (!hopSim(sim, dir)) return reject(state, 'not_ready');
  state.score = sim.score;
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
  // Run the world out past the last input. Every run ends by a rule the replay
  // models, and the cheel alone settles a silent run within IDLE_STEPS.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepSim(sim);
    guard++;
  }
  // The score never moves after the last landing, so finalize reads it from
  // the sim, never from a number the client sent.
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame, deathCause: sim.deathCause,
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      hops: sim.hops, lane: sim.lane, maxLane: sim.maxLane, coins: sim.coins, version: sim.version,
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
    RULES_VERSION, COIN_POINTS, COIN_POINTS_V2, coinCol, coinPointsFor,
    initSim, stepSim, hopSim, advanceTo, laneSpec, laneRng, seedToInt, moverLeft, laneHits, logUnder,
    MAX_INPUTS, MAX_SIM_STEPS, COLS, CELL, HALF_CELL, WORLD_W, LANE_SUB, HOP_STEPS, START_GUARD_STEPS,
    IDLE_STEPS, HERO_HALF, LOG_GRACE, START_COL, START_LANES, REST_EVERY, GRASS, ROAD, RIVER, RAIL,
    DIR_UP, DIR_LEFT, DIR_RIGHT, DIR_DOWN, LANE_LOOP, LANE_MARGIN, ROAD_LENS, ROAD_GAPS, ROAD_CLEAR,
    RIVER_LENS, RIVER_WATER_MIN, RIVER_WATER_CAP, TRAIN_V, TRAIN_LEN, TRAIN_MARGIN, TREE_ALLOWED, TREE_ALL,
    CAM_CREEP_BASE, CAM_CREEP_RAMP, CAM_CREEP_CAP, CAM_CHASE, CAM_BEHIND, RIVER_FROM, RAIL_FROM,
    ROAD_V_CAP, RIVER_V_CAP, RAIL_PERIOD_MIN,
  },
};
