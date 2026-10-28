'use strict';

/**
 * Drifty Car validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Drifty Car was born on replay AND on deterministic math, so the only trace
 * this file scores is a v3 trace: a start marker with v >= 3, then hold pairs.
 * There is no v1 plausibility path and no v2 engine-Math path. A trace without
 * a v3 marker scores zero (the session layer refuses markerless traces
 * platform-wide anyway).
 *
 * The game: a car drives up a smooth curving road. Hold the left or right side
 * of the screen and it turns that way; let go and it straightens. The score is
 * the distance driven (one point per DIST_UNIT world units, a metre on screen)
 * plus DIAMOND_POINTS for every diamond picked up. The road speeds up and
 * narrows as the run goes on. Leaving the road ends the run.
 *
 * What the server does with a trace:
 *   1. rebuilds the road from the session seed: road point K's side, reach,
 *      rise, width and cash are a pure function of (seed, K);
 *   2. applies each hold pair { n, dir, pressStep, releaseStep } on the fixed
 *      steps it landed on (dir -1 steers left, +1 right);
 *   3. walks the same 1/60 s steps as the client. The heading is an INTEGER
 *      number of angle units; its sine and cosine come from a table built once
 *      with DMath (shared/anticheat/dmath.js, an fdlibm port that gives the same
 *      bits in every engine), never Math.sin. The road between two points is a
 *      smoothstep curve (3t^2 - 2t^3): +, - and x only;
 *   4. counts the score: whole metres driven, plus DIAMOND_POINTS a diamond.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/drifty-car/js/game.js.
 * shared/tests/driftyCarParity.test.js pulls every constant and every function
 * out of both files and fails the moment one copy is edited without the other.
 * Edit both or neither; a gameplay change is a trace version bump.
 *
 * NOBODY PARKS: there is no idle timer, because the road itself is one. Road
 * points strictly alternate left and right of x = 0, each at least X_MIN away,
 * and X_MIN is wider than the widest half-road. So a car driving straight (no
 * input) at ANY x is off the road within two curves, and a car holding one way
 * turns off it even sooner. IDLE_STEPS below is the bound that follows; the
 * parity suite proves it from every curve of real runs and from the start line.
 */

const DMath = require('../dmath');

// ==== RULES BLOCK: identical in games/drifty-car/js/game.js ====
const ANGLE_UNITS = 2880;
const RAD_PER_UNIT = 6.283185307179586 / ANGLE_UNITS;
const MAX_HEADING = 440;
const TURN_MAX = 24;
const TURN_ACCEL = 4;
const TURN_RELEASE = 3;
const RETURN_DIV = 40;
const RETURN_MIN = 1;
const GRIP = 0.05;
const SPEED_BASE_H = 370;
const SPEED_PER_CURVE_H = 9;
const SPEED_BONUS_CAP_H = 380;
const START_GUARD_STEPS = 27;
const START_BACK = 90;
const START_LEN = 380;
const START_HALF = 92;
const X_MIN = 100;
// Every corner has a CHARACTER, drawn from the seed: a long sweeper, an ordinary
// bend, a tight one, or a quick kink. A style sets how far out the point sits
// (how hard the corner turns) and how much road it takes to get there (how long
// it lasts), and the harder kinds get commoner the further the run goes, so the
// road never settles into one repeated shape. Every point still alternates sides
// and still sits at least X_MIN out, which is what keeps a parked car off it.
const X_SPREAD = 80;                             // the widest style's spread
const STYLE_AMP = [80, 40, 60, 20];              // sweeper, normal, tight, kink
const STYLE_DY_NUM = [7, 4, 3, 2];               // ... as quarters of the stage's length
const STYLE_BAND = [20, 60];                     // the run's three stages, in curves
const STYLE_ODDS = [[35, 75, 95], [25, 60, 88], [15, 45, 80]];   // cumulative, out of 100
// The first corners are ordinary ones and open out gradually: a hard corner at
// point 2 ended a run before the player had done anything.
const STYLE_WARM = 8;
const DY_BASE = 400;
const DY_SHRINK = 6;
const DY_FLOOR = 200;
const DY_SPAN = 100;
const SLOPE_NUM = 5;
const SLOPE_DEN = 3;
const HALF_BASE = 80;
const HALF_NARROW_EVERY = 3;
const HALF_FLOOR = 42;
const HALF_SPREAD = 6;
const CAR_R = 9;
const COIN_FROM = 2;
const COIN_CHANCE = 60;
const COIN_R = 14;
const COIN_EDGE = 18;
const COIN_T_MIN = 250;
const COIN_T_SPAN = 500;
const DIST_UNIT = 10;
// The pickup is a NITRO canister, and it is worth points and nothing else. A
// speed surge was tried on 18 Sep 2026 and taken straight back out: the speed of
// the car is the road's business, not a pickup's.
const NITRO_POINTS = 25;
const DRIFT_SLIP = 0.6;
// The score is distance and diamonds, and nothing else. A drift bonus was tried
// on 18 Sep 2026 and taken back out the same day: the founder wanted the slide
// to be how you get round a corner, not a thing that pays.
const RULES_VERSION = 3;
const CAMERA_FOLLOW = 0.1;
const RNG_STRIDE = 0x9E3779B1;
const RNG_SALT = 0x0D81F7CA;
let TRIG_SIN = null;
let TRIG_COS = null;

function segRng(seedInt, index) {
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

// The heading is a whole number of angle units in [-MAX_HEADING, MAX_HEADING],
// so its sine and cosine are a table lookup, built ONCE from DMath.
function trigTables() {
  if (TRIG_SIN) return;
  const sinT = [];
  const cosT = [];
  for (let h = -MAX_HEADING; h <= MAX_HEADING; h++) {
    sinT.push(DMath.sin(h * RAD_PER_UNIT));
    cosT.push(DMath.cos(h * RAD_PER_UNIT));
  }
  TRIG_SIN = sinT;
  TRIG_COS = cosT;
}

function speedFor(curve) {
  return (SPEED_BASE_H + Math.min(SPEED_BONUS_CAP_H, curve * SPEED_PER_CURVE_H)) / 100;
}

function sideOf(k) {
  return k % 2 === 0 ? -1 : 1;
}

// Road point K's x. Its first draw, so it is the same number pointSpec sees.
function styleAt(roll, k) {
  if (k < STYLE_WARM) return 1;
  const band = k < STYLE_BAND[0] ? 0 : (k < STYLE_BAND[1] ? 1 : 2);
  const odds = STYLE_ODDS[band];
  const r = Math.floor(roll * 100);
  for (let i = 0; i < odds.length; i++) if (r < odds[i]) return i;
  return odds.length;
}

// A KINK sits on the SAME side as the corner before it, so the car only has to
// flick rather than cross the road: that is what makes a short, sharp corner
// possible at all, since crossing to the other side always needs length (the
// slope clamp below). The side is still a closed form of (seed, K).
const STYLE_KINK = 3;

function pointX(seedInt, k) {
  if (k <= 1) return 0;
  const rng = segRng(seedInt, k);
  const style = styleAt(rng(), k);
  const side = (style === STYLE_KINK ? -1 : 1) * sideOf(k);
  let spread = STYLE_AMP[style];
  if (k < STYLE_WARM) spread = Math.floor(spread * k / STYLE_WARM);
  return side * (X_MIN + Math.floor(rng() * (spread + 1)));
}

// Road point K is a pure function of (seed, K). All six draws happen on every
// index in this order, whichever branches use them. Its rise is clamped so the
// smoothstep curve from the previous point is never steeper than
// 1.5 x SLOPE_DEN / SLOPE_NUM (0.9, about 42 degrees), which the car can follow.
function pointSpec(seedInt, k) {
  const rng = segRng(seedInt, k);
  const styleRoll = rng();
  rng();                                         // the amplitude, read by pointX
  const dyRoll = rng();
  const halfRoll = rng();
  const coinRoll = rng();
  const coinTRoll = rng();
  const coinOffRoll = rng();
  if (k <= 1) {
    return { x: 0, dy: k === 0 ? 0 : START_LEN + START_BACK, half: START_HALF, hasCoin: false, coinT: 0, coinOff: 0 };
  }
  const x = pointX(seedInt, k);
  const dx = Math.abs(x - pointX(seedInt, k - 1));
  const style = styleAt(styleRoll, k);
  const stage = Math.max(DY_FLOOR, DY_BASE - k * DY_SHRINK);
  const dyLo = Math.max(DY_FLOOR, Math.floor(stage * STYLE_DY_NUM[style] / 4));
  let dy = dyLo + Math.floor(dyRoll * (DY_SPAN + 1));
  const slopeMin = Math.ceil(dx * SLOPE_NUM / SLOPE_DEN);
  if (dy < slopeMin) dy = slopeMin;
  const half = Math.max(HALF_FLOOR, HALF_BASE - Math.floor(k / HALF_NARROW_EVERY)) + Math.floor(halfRoll * (HALF_SPREAD + 1));
  const hasCoin = k >= COIN_FROM && Math.floor(coinRoll * 100) < COIN_CHANCE;
  const coinT = COIN_T_MIN + Math.floor(coinTRoll * (COIN_T_SPAN + 1));
  const coinOff = coinOffRoll * 2 - 1;
  return { x: x, dy: dy, half: half, hasCoin: hasCoin, coinT: coinT, coinOff: coinOff };
}

// The road between points a (behind) and b (ahead), at height y.
function roadCentre(a, b, y) {
  let t = (a.y - y) / (a.y - b.y);
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return a.x + (b.x - a.x) * (t * t * (3 - 2 * t));
}

function roadHalf(a, b, y) {
  let t = (a.y - y) / (a.y - b.y);
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return a.half + (b.half - a.half) * t;
}

// Point K placed in the world. Only its y depends on the point before it.
function makePoint(seedInt, k, prev) {
  const spec = pointSpec(seedInt, k);
  const p = {
    k: k, x: spec.x, y: k === 0 ? START_BACK : prev.y - spec.dy, half: spec.half,
    hasCoin: spec.hasCoin, coinX: 0, coinY: 0, coinTaken: false,
  };
  if (spec.hasCoin) {
    const t = spec.coinT / 1000;
    const cy = prev.y - spec.dy * t;
    p.coinX = roadCentre(prev, p, cy) + spec.coinOff * (roadHalf(prev, p, cy) - COIN_EDGE);
    p.coinY = cy;
  }
  return p;
}

function ptAt(sim, k) {
  while (sim.pts.length <= k) {
    const i = sim.pts.length;
    sim.pts.push(makePoint(sim.seedInt, i, i === 0 ? null : sim.pts[i - 1]));
  }
  return sim.pts[k];
}

function initSim(seedHex, version) {
  trigTables();
  const sim = {
    version: Number(version) >= RULES_VERSION ? RULES_VERSION : 3,
    seedInt: seedToInt(seedHex),
    pts: [],
    frames: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: -speedFor(0),
    heading: 0,
    turn: 0,
    holdDir: 0,
    holdN: 0,
    pressStep: -1,
    speed: speedFor(0),
    slip: 0,
    drifting: false,
    seg: 0,
    curves: 0,
    coins: 0,
    meters: 0,
    score: 0,
    cameraX: 0,
    cameraY: 0,
    dead: false,
    deathFrame: null,
    deathCause: null,
  };
  ptAt(sim, 1);
  return sim;
}

function killSim(sim, cause) {
  sim.dead = true;
  sim.deathFrame = sim.frames;
  sim.deathCause = cause;
}

function stepSim(sim) {
  if (sim.dead) return;
  sim.frames++;
  // Drift steering. Holding builds the turn rate up by TURN_ACCEL a step to
  // TURN_MAX, so the nose swings round while GRIP is low and the car keeps
  // sliding the way it was going: the player counter-steers to catch it.
  // Letting go stops the rotation and the nose settles slowly back to straight
  // (a share of the heading, never less than RETURN_MIN), without swinging past.
  const before = sim.heading;
  if (sim.holdDir !== 0) {
    sim.turn += Math.max(-TURN_ACCEL, Math.min(TURN_ACCEL, sim.holdDir * TURN_MAX - sim.turn));
  } else {
    const back = sim.heading === 0 ? 0 : -(Math.trunc(sim.heading / RETURN_DIV) + (sim.heading > 0 ? RETURN_MIN : -RETURN_MIN));
    sim.turn += Math.max(-TURN_RELEASE, Math.min(TURN_RELEASE, back - sim.turn));
  }
  sim.heading += sim.turn;
  if (sim.heading > MAX_HEADING) { sim.heading = MAX_HEADING; sim.turn = 0; }
  if (sim.heading < -MAX_HEADING) { sim.heading = -MAX_HEADING; sim.turn = 0; }
  if (sim.holdDir === 0 && before !== 0 && (sim.heading === 0 || (sim.heading > 0) !== (before > 0))) {
    sim.heading = 0;
    sim.turn = 0;
  }
  const hs = TRIG_SIN[sim.heading + MAX_HEADING];
  const hc = TRIG_COS[sim.heading + MAX_HEADING];
  sim.speed = speedFor(sim.curves);
  sim.vx += (hs * sim.speed - sim.vx) * GRIP;
  sim.vy += (-hc * sim.speed - sim.vy) * GRIP;
  sim.x += sim.vx;
  sim.y += sim.vy;
  sim.slip = hs * sim.vy + hc * sim.vx;
  sim.drifting = Math.abs(sim.slip) > DRIFT_SLIP;
  sim.cameraX += (sim.x - sim.cameraX) * CAMERA_FOLLOW;
  sim.cameraY = sim.y;

  let a = ptAt(sim, sim.seg);
  let b = ptAt(sim, sim.seg + 1);
  while (sim.y <= b.y) {
    sim.seg++;
    sim.curves++;
    a = b;
    b = ptAt(sim, sim.seg + 1);
  }

  for (let k = sim.seg; k <= sim.seg + 1; k++) {
    const p = sim.pts[k];
    if (p.hasCoin && !p.coinTaken) {
      const cx = sim.x - p.coinX;
      const cy = sim.y - p.coinY;
      if (cx * cx + cy * cy < (CAR_R + COIN_R) * (CAR_R + COIN_R)) {
        p.coinTaken = true;
        sim.coins++;
      }
    }
  }

  // The car only ever moves up the road (the heading never passes 90 degrees),
  // so -y is the distance driven.
  sim.meters = Math.max(0, Math.floor(-sim.y / DIST_UNIT));
  sim.score = sim.meters + sim.coins * NITRO_POINTS;

  if (Math.abs(sim.x - roadCentre(a, b, sim.y)) > roadHalf(a, b, sim.y)) killSim(sim, 'offroad');
}

function pressSim(sim, dir) {
  if (sim.dead || sim.holdDir !== 0 || sim.frames < START_GUARD_STEPS) return false;
  if (dir !== 1 && dir !== -1) return false;
  sim.holdDir = dir;
  sim.pressStep = sim.frames;
  sim.holdN++;
  return true;
}

function releaseSim(sim) {
  if (sim.dead || sim.holdDir === 0) return false;
  sim.holdDir = 0;
  return true;
}
// ==== END RULES BLOCK ====

// ── server-only bounds ──────────────────────────────────────────────────
//
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A human cannot change grip more than a few times a second. 60,000 pairs is
// ~17 a second for an hour, far past any real run, and stops a huge trace
// turning one submit into a CPU sink. It REFUSES further inputs, never zeroes.
const MAX_INPUTS = 60000;
// The bound the road's own geometry puts on a parked input (see the header).
// Documentation and a test target, not a rule: nothing below reads it.
const IDLE_STEPS = 600;

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

function died(state) {
  state.dead = true;
  state.score = state.sim.score;
  return { accepted: false, newScore: state.score, reason: 'dead' };
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    // v3 only: this game's physics has only ever run on DMath.
    if (Number(payload.v) >= 3 && state.mode !== 'sim') {
      state.mode = 'sim';
      // Scored by the rules the run was PLAYED under: a v3 trace pays no drift.
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No v3 start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'hold') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, dir, pressStep, releaseStep } = payload;
  if (!isStep(n) || (dir !== 1 && dir !== -1) || !isStep(pressStep) || !isStep(releaseStep) || releaseStep < pressStep) {
    return reject(state, 'bad_hold');
  }

  const sim = state.sim;
  // Steps may REPEAT (a press can land on the step the previous release did)
  // but never go BACKWARDS: a rewind would let an attacker re-run the same
  // window and keep the best outcome.
  if (pressStep < sim.frames) return reject(state, 'frame_regressed');
  // Pairs are numbered in the order they were made. A pair out of sequence (a
  // duplicate, a reshuffled or spliced trace) is refused whole, BEFORE the
  // replay advances, so it cannot shift the next pair.
  if (n !== sim.holdN) return reject(state, 'out_of_order');

  advanceTo(sim, pressStep);
  if (sim.dead) return died(state);
  // The client only records a press it applied, so a press the rules refuse
  // (inside the start guard) is a forged one.
  if (!pressSim(sim, dir)) return reject(state, 'not_ready');

  advanceTo(sim, releaseStep);
  if (sim.dead) return died(state);
  releaseSim(sim);
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
  // Run the world out past the last input. The road ends every parked car
  // within IDLE_STEPS, so this settles in a few hundred steps.
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
      curves: sim.curves, coins: sim.coins, meters: sim.meters, holds: sim.holdN,
      version: sim.version,
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
    initSim, stepSim, pressSim, releaseSim, advanceTo, pointSpec, pointX, makePoint, ptAt, segRng, seedToInt,
    roadCentre, roadHalf, speedFor, sideOf, styleAt, trigTables, MAX_INPUTS, MAX_SIM_STEPS, IDLE_STEPS, DMath,
    ANGLE_UNITS, MAX_HEADING, TURN_MAX, TURN_ACCEL, TURN_RELEASE, RETURN_DIV, RETURN_MIN, GRIP, SPEED_BASE_H, SPEED_PER_CURVE_H, SPEED_BONUS_CAP_H,
    START_GUARD_STEPS, START_BACK, START_LEN, START_HALF, X_MIN, X_SPREAD, DY_BASE, DY_SHRINK, DY_FLOOR,
    DY_SPAN, SLOPE_NUM, SLOPE_DEN, HALF_BASE, HALF_NARROW_EVERY, HALF_FLOOR, HALF_SPREAD, CAR_R, COIN_FROM,
    COIN_R, COIN_EDGE, STYLE_AMP, STYLE_DY_NUM, STYLE_BAND, STYLE_ODDS, STYLE_KINK, STYLE_WARM, DRIFT_SLIP, DIST_UNIT, NITRO_POINTS, RULES_VERSION,
    tables: () => ({ sin: TRIG_SIN, cos: TRIG_COS }),
  },
};
