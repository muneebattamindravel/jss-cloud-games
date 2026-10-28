'use strict';

/**
 * Tappa validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * There is no v1 path. Tappa was born on replay, so a trace without a v2
 * start marker is not a run and scores zero.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed: tile N (its side of the
 *      lane, how far out, how wide, and how it slides) is a pure function of
 *      (seed, N), never of a running stream;
 *   2. applies the ball's lateral path on the fixed steps it landed on. The
 *      path is a dense positional batch { f, x: [...] } where x[i] is the ball
 *      during step f+1+i, in integer design units; { kind: 'touch', step } and
 *      { kind: 'lift', step } say when the finger arrived and left;
 *   3. walks the same fixed steps as the client. The ball hops by itself on a
 *      clock that shortens with the tile index; on each landing step the only
 *      question is whether the ball is over the tile, and how near its centre.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/tappa/js/game.js.
 * shared/tests/tappaParity.test.js pulls every constant and every rules
 * function out of both files and fails the moment one copy is edited without
 * the other. A gameplay change is a trace version bump, never an edit in place.
 *
 * No trig, no square roots and no exponentials on this path: the rules are one
 * dimensional, and the only arithmetic they need is +, -, x, /, floor, min,
 * max and comparisons, which are exact in every engine. The arc the player
 * sees is drawn from the hop's progress and has never reached a score.
 */

// ==== RULES BLOCK: identical in games/tappa/js/game.js ====
//
// One dimension. The rules know the ball's lateral x, the hop clock, and the
// tiles. Height, depth and perspective are DRAWING and live below the effects
// marker; nothing up here has ever heard of them. That is what makes Tappa
// cheap to replay and impossible to desync: there is no physics, only a beat.
const FIELD_W = 414;
const FIELD_H = 736;
const MID = 207;                 // the lane the first tiles sit on

// The ball. Its lateral x IS the trace: an integer design unit, moved by at
// most BALL_MAX_STEP a step, on the client and on the server alike.
const BALL_MAX_STEP = 48;
const BALL_TOL = 4;              // forgiveness at the tile's edge
const PERFECT_HALF = 10;          // within this of the centre is a PERFECT
const PERFECT_CAP = 4;           // a perfect scores 1 + min(streak, cap)

// The hop clock, in fixed steps. It shortens with the tile index to a floor,
// so the run only ever gets faster.
const HOP_START = 34;
const HOP_MIN = 23;
const HOP_EVERY = 6;

// How wide a tile is, narrowing to a floor with a seeded spread.
const HALF_BASE = 48;
const HALF_FLOOR = 28;
const HALF_EVERY = 4;
const HALF_SPREAD = 10;

// Where a tile sits: MID + side * out, out drawn inside a band bounded so the
// next tile is always reachable, then clamped into the field.
const EDGE = 6;
const OUT_OPEN = 46;             // how far out the first placed tile may sit
const OUT_RAMP = 8;              // and how fast that opens up, per tile
const OUT_RAMP_CAP = 130;        // the widest a tile ever sits from the lane
const PARK_GAP = 8;              // out is never small enough for a still ball to live

// The slide. Tile n slides on the STEP CLOCK, so it keeps moving while the
// ball is in the air. Nothing moves for the first MOVE_FROM tiles: the opening
// is about landing accurately on a still target, and a tile that started
// swinging three seconds in read as a stutter rather than a course.
const MOVE_FROM = 38;
const AMP_MIN = 16;
const AMP_MAX = 80;
const AMP_EVERY = 5;
// A tile's speed is bounded by a MINIMUM PERIOD rather than set directly, so a
// bigger swing buys a longer glide and never a vibration. A small swing
// crossed in a handful of steps is a shake, which is exactly what it was.
const SLIDE_MIN_PERIOD = 64;
const SLIDE_SPD_CAP = 6;
// The eased wave's steepest moment is 1.5x its average, so this is what a hop
// has to out-run in the worst case.
const SLIDE_PEAK = 12;

// The reach budget: how far a hop can be asked to carry the ball, worst case.
const REACH_MARGIN_STEPS = 3;
const REACH_SLACK = 15;

const SAFE_TILES = 3;            // centred and wide, so the first hops teach
const START_GUARD_STEPS = 27;
const ARM_TIMEOUT_STEPS = 1800;

const RNG_STRIDE = 0x9E3779B1;
const TILE_SALT = 0x5BD1E995;

const DEATH_CAUSES = ['none', 'miss', 'idle'];

function tileRng(seedInt, salt, index) {
  let a = (((seedInt ^ salt) >>> 0) + Math.imul(index + 1, RNG_STRIDE)) >>> 0;
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

// A triangle wave in whole design units: -amp .. amp .. -amp every 4 x amp.
function triWave(x, amp) {
  if (amp <= 0) return 0;
  const m = x % (4 * amp);
  return m < 2 * amp ? m - amp : 3 * amp - m;
}

// The hop that LANDS on tile n lasts this many steps.
function hopLen(n) {
  const v = HOP_START - Math.floor(n / HOP_EVERY);
  return v < HOP_MIN ? HOP_MIN : v;
}

function halfCapFor(n) {
  const v = HALF_BASE - Math.floor(n / HALF_EVERY);
  return v < HALF_FLOOR ? HALF_FLOOR : v;
}

function ampCapFor(n) {
  if (n < MOVE_FROM) return 0;
  const v = AMP_MIN + Math.floor((n - MOVE_FROM) / AMP_EVERY);
  return v > AMP_MAX ? AMP_MAX : v;
}

function spdForAmp(amp) {
  if (amp <= 0) return 0;
  const v = Math.floor((4 * amp) / SLIDE_MIN_PERIOD);
  if (v < 1) return 1;
  return v > SLIDE_SPD_CAP ? SLIDE_SPD_CAP : v;
}

// What the hop onto tile n can carry, worst case: its steps less a margin,
// times the speed the ball closes at while the tile runs away from it, less
// the two slides it has to cover. It only ever FALLS with n, which is what
// makes outMaxFor below sound.
function budgetFor(n) {
  const steps = hopLen(n) - REACH_MARGIN_STEPS;
  const close = BALL_MAX_STEP - SLIDE_PEAK;
  const prev = n > 0 ? ampCapFor(n - 1) : 0;
  return steps * close - ampCapFor(n) - prev - REACH_SLACK;
}

// How far tile n may sit from the lane. Three caps, each of which really
// binds somewhere: the opening ramp for the first dozen tiles, the hard cap
// that keeps every tile on screen, and the NEXT hop's budget from there on.
//
// Capping by budget(n + 1) as well as by its own is what makes the pair
// (n - 1, n) reachable without either tile knowing where the other landed:
// budgetFor never rises, so out(n - 1) <= budget(n)/2 and
// out(n) <= budget(n + 1)/2 <= budget(n)/2, and the two always sum inside
// budget(n). That is the whole reachability proof, and it costs no recursion.
function outMaxFor(n) {
  const open = OUT_OPEN + n * OUT_RAMP;
  const cap = open > OUT_RAMP_CAP ? OUT_RAMP_CAP : open;
  const b = Math.floor(budgetFor(n + 1) / 2);
  return cap < b ? cap : b;
}

// Tile n: which side of the lane, how far out, how wide, how it slides.
// A pure function of (seed, n) with FIVE draws on every index, whatever
// branch is taken.
function tileSpec(seedInt, n) {
  const r = tileRng(seedInt, TILE_SALT, n);
  const rSide = r();
  const rOut = r();
  const rHalf = r();
  const rAmp = r();
  const rPhase = r();
  const cap = halfCapFor(n);
  const lo = cap - HALF_SPREAD < HALF_FLOOR ? HALF_FLOOR : cap - HALF_SPREAD;
  const half = n < SAFE_TILES ? HALF_BASE : lo + Math.floor(rHalf * (cap - lo + 1));
  // A still ball must die: two tiles on opposite sides, each at least this far
  // out, cannot both be stood on without moving.
  // outMin <= outMaxFor(n) for every n, asserted by the parity suite: there is
  // no clamp here because there is nothing for one to catch.
  const outMin = half + BALL_TOL + PARK_GAP;
  const out = n < SAFE_TILES ? 0 : outMin + Math.floor(rOut * (outMaxFor(n) - outMin + 1));
  const base = MID + (rSide < 0.5 ? -out : out);
  // The swing is bounded by the room the tile actually has: a slab must never
  // leave the field, however far out it sits or however wide it is. The reach
  // budget uses ampCapFor, which is never smaller than this, so bounding here
  // can only make a hop easier.
  const room = FIELD_W - 1 - EDGE - MID - out - half;
  const ampCap = ampCapFor(n);
  const hi = ampCap < room ? ampCap : room;
  const amp = hi <= AMP_MIN ? (hi < 0 ? 0 : hi) : AMP_MIN + Math.floor(rAmp * (hi - AMP_MIN + 1));
  return { base, half, amp, spd: spdForAmp(amp), phase: Math.floor(rPhase * 4096) };
}

// The triangle wave with its corners taken off: a smoothstep over the swing,
// so a tile eases to a stop at each end instead of snapping back. Integer
// only, and the sign is reapplied rather than floored through, so the two
// halves of the wave are exact mirrors and both copies agree bit for bit.
function centreAt(spec, t) {
  const amp = spec.amp;
  if (amp <= 0) return spec.base;
  const s = triWave((t + spec.phase) * spec.spd, amp);
  const a = s < 0 ? -s : s;
  const e = Math.floor((a * (3 * amp * amp - a * a)) / (2 * amp * amp));
  return spec.base + (s < 0 ? -e : e);
}

function initSim(seedHex) {
  return {
    version: 2,
    seedInt: seedToInt(seedHex),
    frames: 0,
    armed: false,
    armFrame: 0,
    bx: MID,
    tile: 0,
    hopStart: 0,
    hopSteps: hopLen(1),
    score: 0,
    streak: 0,
    bestStreak: 0,
    landings: 0,
    perfects: 0,
    lastOffset: 0,
    lastGain: 0,
    lastPerfect: false,
    landed: 0,
    dead: false,
    deathFrame: 0,
    deathCause: 'none',
  };
}

function killSim(sim, cause) {
  sim.dead = true;
  sim.deathFrame = sim.frames;
  sim.deathCause = cause;
}

// One fixed step. `x` is the ball's lateral position, already clamped to
// BALL_MAX_STEP of where it was: it IS the trace, and the server applies it
// exactly as the client recorded it. Nothing happens until the first touch
// after the start guard; from then on the ball hops by itself and the only
// question each landing asks is whether it is over the tile.
function stepSim(sim, down, x) {
  if (sim.dead) return;
  sim.frames++;
  sim.landed = 0;
  if (!sim.armed) {
    if (down) sim.bx = x;
    if (down && sim.frames >= START_GUARD_STEPS) {
      sim.armed = true;
      sim.armFrame = sim.frames;
      sim.hopStart = sim.frames;
      sim.hopSteps = hopLen(1);
      return;
    }
    if (sim.frames >= ARM_TIMEOUT_STEPS) killSim(sim, 'idle');
    return;
  }
  sim.bx = x;
  if (sim.frames - sim.hopStart < sim.hopSteps) return;
  const n = sim.tile + 1;
  const spec = tileSpec(sim.seedInt, n);
  const c = centreAt(spec, sim.frames);
  const d = sim.bx - c;
  const ad = d < 0 ? -d : d;
  sim.lastOffset = d;
  if (ad > spec.half + BALL_TOL) {
    killSim(sim, 'miss');
    return;
  }
  const perfect = ad <= PERFECT_HALF;
  sim.streak = perfect ? sim.streak + 1 : 0;
  if (sim.streak > sim.bestStreak) sim.bestStreak = sim.streak;
  // ONE expression: the HUD and the score are the same number, always.
  const gained = perfect ? 1 + (sim.streak < PERFECT_CAP ? sim.streak : PERFECT_CAP) : 1;
  sim.score += gained;
  sim.landings++;
  if (perfect) sim.perfects++;
  sim.lastGain = gained;
  sim.lastPerfect = perfect;
  sim.landed = 1;
  sim.tile = n;
  sim.hopStart = sim.frames;
  sim.hopSteps = hopLen(n + 1);
}
// ==== END RULES BLOCK ====

// ── server-only bounds ──────────────────────────────────────────────────
//
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// The client ships one sample per step while the finger is down, cut into
// batches of at most PATH_BATCH_MAX. A path event longer than that is not one
// the client can produce.
const PATH_BATCH_MAX = 120;
// Samples and markers together. An hour of finger-down play is 216,000
// samples; this sits above it and stops a huge trace from turning one submit
// into a CPU sink. It REFUSES further inputs, it never zeroes.
const MAX_INPUTS = 240000;

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) {
    stepSim(sim, state.down, sim.bx);
    if (sim.landed === 1) recordLanding(state, sim);
  }
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing
// would apply a malformed value as if it were real.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function isCoord(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= FIELD_W - 1;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    down: false,
    lastStep: 0,
    inputCount: 0,
    rejectCount: 0,
    score: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    // ── bot fingerprint raw material. Recorded, never gated. ──────────────
    // How the ball LANDED: the offset from the tile's centre, run by run.
    landN: 0,
    landSum: 0,
    landSq: 0,
    // How the ball was STEERED: strokes, their length and speed, reversals,
    // the share of steps pinned at the chase limit, and the share of steps
    // spent already aligned and perfectly still (a planner arrives early and
    // freezes; a person drifts and corrects late).
    armedSteps: 0,
    moveSteps: 0,
    limitSteps: 0,
    stillAligned: 0,
    strokeN: 0,
    strokeLenSum: 0,
    strokeLenSq: 0,
    strokeSpdSum: 0,
    strokeSpdSq: 0,
    reversals: 0,
    curDir: 0,
    curLen: 0,
    curDist: 0,
    // Cached so the fingerprint costs one tileSpec per hop, not one per step.
    fpTile: -1,
    fpSpec: null,
  };
}

function recordLanding(state, sim) {
  const d = sim.lastOffset;
  state.landN++;
  state.landSum += d < 0 ? -d : d;
  state.landSq += d * d;
}

function closeStroke(state) {
  if (state.curLen > 0) {
    state.strokeN++;
    state.strokeLenSum += state.curLen;
    state.strokeLenSq += state.curLen * state.curLen;
    const spd = state.curDist / state.curLen;
    state.strokeSpdSum += spd;
    state.strokeSpdSq += spd * spd;
  }
  state.curDir = 0;
  state.curLen = 0;
  state.curDist = 0;
}

// One applied sample, after the rules have run it. Statistics only: nothing
// here can reach the score.
function recordSteer(state, sim, dx) {
  if (!sim.armed) return;
  state.armedSteps++;
  const a = dx < 0 ? -dx : dx;
  if (a === BALL_MAX_STEP) state.limitSteps++;
  if (a === 0) {
    closeStroke(state);
    if (state.fpTile !== sim.tile || state.fpSpec === null) {
      state.fpTile = sim.tile;
      state.fpSpec = tileSpec(sim.seedInt, sim.tile + 1);
    }
    const off = sim.bx - centreAt(state.fpSpec, sim.frames);
    if ((off < 0 ? -off : off) <= PERFECT_HALF) state.stillAligned++;
    return;
  }
  state.moveSteps++;
  const dir = dx < 0 ? -1 : 1;
  if (state.curDir !== 0 && dir !== state.curDir) {
    state.reversals++;
    closeStroke(state);
  }
  state.curDir = dir;
  state.curLen++;
  state.curDist += a;
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function deadResult(state) {
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
    if (Number(payload.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed);
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  if (kind === 'lift' || kind === 'touch') return processMarker(state, kind, payload);
  if (kind === 'path') return processPath(state, payload);
  return { accepted: true, newScore: state.score };
}

// { kind: 'lift' | 'touch', step }: the finger is up (or down) from `step` on.
function processMarker(state, kind, payload) {
  const step = payload.step;
  if (!isStep(step)) return reject(state, 'bad_marker');
  if (step <= state.lastStep) return reject(state, 'frame_regressed');
  const wantDown = kind === 'touch';
  if (state.down === wantDown) return reject(state, 'bad_marker');
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  advanceTo(state, step - 1);
  if (state.sim.dead) return deadResult(state);
  state.down = wantDown;
  state.lastStep = wantDown ? step - 1 : step;
  state.score = state.sim.score;
  return { accepted: true, newScore: state.score };
}

// { kind: 'path', f, x: [...] }: x[i] is the ball during step f+1+i.
// POSITIONAL and dense, applied whole or not at all.
function processPath(state, payload) {
  const f = payload.f;
  const xs = payload.x;
  if (!isStep(f) || !Array.isArray(xs) || xs.length === 0 || xs.length > PATH_BATCH_MAX) {
    return reject(state, 'bad_batch');
  }
  // A later batch must start at or after the last step already addressed, so
  // batches never overlap and never rewind: a rewind would let an attacker
  // re-run the same window and keep the best outcome.
  if (f < state.lastStep) return reject(state, 'frame_regressed');
  if (!state.down) return reject(state, 'not_touching');
  if (state.inputCount + xs.length > MAX_INPUTS) return reject(state, 'input_cap');

  // VALIDATE THE WHOLE BATCH BEFORE APPLYING ANY OF IT. A batch that stopped
  // half way would leave the replay in a state the game never had.
  //
  // The ball is dragged RELATIVELY and never jumps to the finger, so the
  // BALL_MAX_STEP bound holds across a touch as well as within a drag. There
  // is deliberately no exemption for the first sample after a touch: that
  // would be a hole the client has no use for.
  const sim = state.sim;
  let px = sim.bx;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (!isCoord(x)) return reject(state, 'bad_sample');
    const dx = x - px;
    if (dx > BALL_MAX_STEP || dx < -BALL_MAX_STEP) return reject(state, 'teleport');
    px = x;
  }

  state.inputCount += xs.length;
  state.lastStep = f + xs.length;
  for (let i = 0; i < xs.length; i++) {
    advanceTo(state, f + i);
    if (sim.dead || sim.frames >= MAX_SIM_STEPS) break;
    const dx = xs[i] - sim.bx;
    stepSim(sim, true, xs[i]);
    if (sim.landed === 1) recordLanding(state, sim);
    if (!sim.dead) recordSteer(state, sim, dx);
  }
  if (sim.dead) return deadResult(state);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always dies inside this bound. Only
// the submit replay passes elapsedSecs; the live stream keeps the session bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function sdOf(n, sum, sq) {
  if (n < 2) return null;
  const m = sum / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const sim = state.sim;
  // Run the world out past the last input, with the ball where the trace left
  // it. Every run ends by a rule the replay models: the course leaves the lane
  // from tile SAFE_TILES on, so a still ball misses within a few hops, and a
  // run that never starts dies at ARM_TIMEOUT_STEPS.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepSim(sim, state.down, sim.bx);
    if (sim.landed === 1) recordLanding(state, sim);
    guard++;
  }
  closeStroke(state);
  const meanErr = state.landN > 0 ? state.landSum / state.landN : null;
  const armed = state.armedSteps;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame, deathCause: sim.deathCause,
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      tile: sim.tile, landings: sim.landings, armed: sim.armed,
      // Not gated. Raw material for the bot fingerprint.
      fingerprint: {
        drops: state.landN,
        perfectRate: sim.landings > 0 ? sim.perfects / sim.landings : null,
        perfectStreakMax: sim.bestStreak,
        meanErr,
        sdErr: sdOf(state.landN, state.landSum, state.landSq),
        strokes: state.strokeN,
        strokeLenMean: state.strokeN > 0 ? state.strokeLenSum / state.strokeN : null,
        strokeLenSd: sdOf(state.strokeN, state.strokeLenSum, state.strokeLenSq),
        strokeSpdMean: state.strokeN > 0 ? state.strokeSpdSum / state.strokeN : null,
        strokeSpdSd: sdOf(state.strokeN, state.strokeSpdSum, state.strokeSpdSq),
        reversalsPerHop: sim.landings > 0 ? state.reversals / sim.landings : null,
        limitFrac: armed > 0 ? state.limitSteps / armed : null,
        moveFrac: armed > 0 ? state.moveSteps / armed : null,
        stillAlignedFrac: armed > 0 ? state.stillAligned / armed : null,
      },
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
    initSim, stepSim, killSim, tileSpec, centreAt, tileRng, seedToInt, triWave,
    hopLen, halfCapFor, ampCapFor, spdForAmp, budgetFor, outMaxFor, advanceTo, DEATH_CAUSES,
    MAX_INPUTS, MAX_SIM_STEPS, PATH_BATCH_MAX,
    FIELD_W, FIELD_H, MID, BALL_MAX_STEP, BALL_TOL, PERFECT_HALF, PERFECT_CAP,
    HOP_START, HOP_MIN, HOP_EVERY, HALF_BASE, HALF_FLOOR, HALF_EVERY, HALF_SPREAD,
    EDGE, OUT_OPEN, OUT_RAMP, OUT_RAMP_CAP, PARK_GAP, MOVE_FROM, AMP_MIN, AMP_MAX, AMP_EVERY,
    SLIDE_MIN_PERIOD, SLIDE_SPD_CAP, SLIDE_PEAK, REACH_MARGIN_STEPS, REACH_SLACK,
    SAFE_TILES, START_GUARD_STEPS, ARM_TIMEOUT_STEPS, RNG_STRIDE, TILE_SALT,
  },
};
