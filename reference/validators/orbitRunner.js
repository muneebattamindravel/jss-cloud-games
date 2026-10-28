'use strict';

const DMath = require('../dmath');

/**
 * Orbit Runner validator.
 *
 * TWO PATHS, and which one runs is decided by the trace itself:
 *
 *   'sim'  — SERVER-SIDE DETERMINISTIC REPLAY. The score is not taken from the
 *            client at all: the course is rebuilt from the session seed, the
 *            player's launch taps are re-applied on the fixed-step frames they
 *            landed on, and the server flies the rocket and counts the planets
 *            it actually caught. Entered by a v2 `start` marker.
 *
 *   'v1'   — the old plausibility model (count the `jump` events, rate-limit
 *            them). KEPT ON PURPOSE for the length of the rollout: a stale
 *            cached client is still out there emitting markerless traces, and
 *            on those the count IS the score, so the v1 path scores them
 *            correctly. Zeroing a stale-cache player is the one failure a cash
 *            leaderboard can least afford. `anticheat.orbit-runner.require_v2`
 *            closes that door once the frontend is fully deployed.
 *
 * Why replay at all: a signed envelope only ever proved "a real session", never
 * "a human played it". A beta tester forged 450 points on Sky Tower by signing
 * fake events, because the SDK hands the browser the session secret — it has
 * to, in order to sign. The only defence is that forged inputs cannot add up
 * to a score the game would not have produced.
 *
 * ⚠ EVERY CONSTANT BELOW IS LIFTED FROM games/orbit-runner/js/game.js AND MUST
 * STAY IDENTICAL TO IT. A change there without a change here silently
 * mis-scores every honest player — the one failure we cannot absorb.
 * shared/tests/orbitRunnerParity.test.js drives the REAL game file through a
 * headless harness and compares the whole simulation, step for step, so a
 * drifted constant fails on the frame it first differs rather than whenever it
 * happens to reach the score.
 */

const TAU = Math.PI * 2;

// ── tuning constants, verbatim from the game ────────────────────────────
//
// These are DESIGN units. They used to be multiplied by a viewport-derived
// gameScale on the client, while horizontal placement used raw viewport
// pixels — so the run depended on the size of the player's window, which is
// both unfair and unreplayable. The play field is a fixed 420x760 now.
const DESIGN_WIDTH           = 420;
const DESIGN_HEIGHT          = 760;
const DT                     = 1 / 60;
const PLANET_GAP             = 355;
const PLANET_START_Y         = DESIGN_HEIGHT * 0.70;
const PLANET_EDGE_MARGIN     = 74;
// v4: a planet sits far enough from the edge that its WHOLE orbit, and the
// rocket riding it, is on screen. Every phone fits the 420 field to its
// width, so an orbit reaching past x 0 or 420 hid the rocket.
const ORBIT_EDGE_PAD         = 14;
const CAPTURE_WINDOW         = 26;
const LAUNCH_SPEED_BASE      = 390;
const LAUNCH_SPEED_PER_SCORE = 7;
const LAUNCH_SPEED_BONUS_CAP = 130;
const ORBIT_SPEED_BASE       = 2.8;
const ORBIT_SPEED_PER_SCORE  = 0.065;
const ORBIT_SPEED_BONUS_CAP  = 2.05;
const MAX_FLY_TIME           = 2.45;
const FLY_X_MARGIN           = 80;
const FLY_Y_MARGIN           = 120;
const CAMERA_LOOK_AHEAD      = 0.62;
const CAMERA_LERP            = 0.07;
const INITIAL_PLANETS        = 10;

// A run that reaches this many steps is not a run — an HOUR of simulation,
// the session's own lifetime (SESSION_LIFETIME_SECS). It used to be 20
// minutes and silently TRUNCATED anything longer: advanceTo just stopped
// stepping, so a 25-minute run was scored as of minute 20 with no flag. Bounds
// server CPU per submit; the sim is a few dozen ns a step, so an hour is ms.
const MAX_SIM_FRAMES = 60 * 60 * 60;
// Bounds the trace's input channel. Orbit Runner emits ONE input per launch
// and a launch takes the better part of a second, so a real run is a few
// hundred at most; 20,000 is far past any of them and stops a huge trace from
// turning one submit into a CPU sink.
const MAX_INPUTS = 20000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp  = (a, b, t) => a + (b - a) * t;

// ── the course ──────────────────────────────────────────────────────────
//
// INDEX-ADDRESSED, not a running stream: planet N is a pure function of
// (seed, N). A stream would have to be consumed in exactly the same ORDER as
// the client, so a cosmetic random added to addPlanet() later would desync the
// server silently. This cannot drift that way, and it lets the replay ask
// about planet 400 without having built the 399 before it.
//
// mulberry32, and the draw order (x jitter, radius, band roll 1, band roll 2,
// band value) is the protocol — see the matching comment in addPlanet().
function planetRng(seedInt, index) {
  let a = (seedInt + Math.imul(index + 1, 0x9E3779B1)) >>> 0;
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

// ⚠ ALL FIVE VALUES ARE DRAWN ON EVERY INDEX, in this order, even where the
// branch ignores some of them. A branch that consumed a different NUMBER of
// draws would make the stream position depend on the branch — the fragility
// index-addressing exists to remove.
function makePlanet(seedInt, index, version = 4) {
  const grnd = planetRng(seedInt, index);
  const xRoll = grnd();
  const radiusRoll = grnd();
  const bandRoll1 = grnd();
  const bandRoll2 = grnd();
  const bandValue = grnd();

  const y = PLANET_START_Y - index * PLANET_GAP;
  const radius = 39 + radiusRoll * (52 - 39);

  let x;
  let orbitOffset;
  if (index === 0) {
    x = DESIGN_WIDTH / 2;
    orbitOffset = 20;
  } else {
    const side = index % 2 === 0 ? 0.26 : 0.74;
    // The two-roll ladder is the shipped distribution, kept deliberately:
    // P(near) = .45, P(mid) = .55 * .80 = .44, P(far) = .55 * .20 = .11.
    orbitOffset = bandRoll1 < 0.45
      ? 18 + bandValue * (28 - 18)
      : bandRoll2 < 0.80
        ? 30 + bandValue * (42 - 30)
        : 44 + bandValue * (58 - 44);
    const edge = version >= 4
      ? Math.max(PLANET_EDGE_MARGIN, radius + orbitOffset + ORBIT_EDGE_PAD)
      : PLANET_EDGE_MARGIN;
    x = clamp(
      DESIGN_WIDTH * side + (-45 + xRoll * 90),
      edge,
      DESIGN_WIDTH - edge
    );
  }

  return { index, x, y, r: radius, orbit: radius + orbitOffset };
}

function orbitSpeedAt(score) {
  return ORBIT_SPEED_BASE + Math.min(ORBIT_SPEED_BONUS_CAP, score * ORBIT_SPEED_PER_SCORE);
}
function launchSpeedAt(score) {
  return LAUNCH_SPEED_BASE + Math.min(LAUNCH_SPEED_BONUS_CAP, score * LAUNCH_SPEED_PER_SCORE);
}

// `M` is the math the trace was PLAYED on: DMath for a v3 trace, the engine's
// Math for v2. See dmath.js for why a v3 exists at all — the engine's
// sin/cos/atan2 differ by an ulp between V8 versions and between browsers,
// and every capture compounds it. A v2 trace is still replayed on Math on
// purpose: that is what its client computed with, and switching it would
// re-create the mismatch for every cached client during the rollout.
function initSim(seed, M = Math, version = 4) {
  const seedInt = seedToInt(seed);
  const sim = {
    M,
    version,
    seedInt,
    frames: 0,
    score: 0,
    dead: false,
    deathFrame: null,
    // The client keeps a growing `planets` array and tops it up to 8 ahead of
    // the rocket. Here the same rows are memoised on demand — the array is
    // bookkeeping on the client and drawing state, never gameplay, because
    // makePlanet() does not depend on the planet before it.
    planets: new Map(),
    planetCount: INITIAL_PLANETS,
    rocketPlanet: 0,
    angle: -Math.PI / 2,
    orbitDir: 1,
    orbitSpeed: ORBIT_SPEED_BASE,
    mode: 'orbit',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    flyTime: 0,
    cameraY: 0,
    targetCameraY: 0,
    inputs: 0,
  };
  positionOnOrbit(sim);
  return sim;
}

function planetAt(sim, index) {
  let p = sim.planets.get(index);
  if (!p) { p = makePlanet(sim.seedInt, index, sim.version); sim.planets.set(index, p); }
  return p;
}

// updateRocketOrbitPosition()
function positionOnOrbit(sim) {
  const p = planetAt(sim, sim.rocketPlanet);
  sim.x = p.x + sim.M.cos(sim.angle) * p.orbit;
  sim.y = p.y + sim.M.sin(sim.angle) * p.orbit;
}

// capturePlanet()
function capture(sim, nextIndex) {
  const p = planetAt(sim, nextIndex);
  sim.rocketPlanet = nextIndex;
  sim.mode = 'orbit';
  sim.angle = sim.M.atan2(sim.y - p.y, sim.x - p.x);
  sim.orbitDir *= -1;
  sim.score++;
  sim.targetCameraY = planetAt(sim, sim.rocketPlanet).y - DESIGN_HEIGHT * CAMERA_LOOK_AHEAD;
  // The client's top-up loop. Kept because `planetCount` is what its
  // `planets[rocket.planet + 1]` guard reads, and the guard is mirrored below.
  while (sim.planetCount - sim.rocketPlanet < 8) sim.planetCount++;
}

// One fixed 1/60s update() — the same order and the same fall-through as the
// client's, including the bounds check that still runs on a frame that has
// just captured.
function stepSim(sim) {
  if (sim.dead) return;
  sim.frames++;

  sim.orbitSpeed = orbitSpeedAt(sim.score);

  if (sim.mode === 'orbit') {
    sim.angle += sim.orbitDir * sim.orbitSpeed * DT;
    positionOnOrbit(sim);
  } else if (sim.mode === 'fly') {
    sim.flyTime += DT;
    sim.x += sim.vx * DT;
    sim.y += sim.vy * DT;

    // The client reads planets[rocket.planet + 1] and guards on it. It is
    // always present (the array starts at 10 and is topped up to 8 ahead), so
    // this guard never bites — mirrored anyway, because the two halves must
    // stay identical if that ever changes.
    if (sim.rocketPlanet + 1 < sim.planetCount) {
      const next = planetAt(sim, sim.rocketPlanet + 1);
      const d = sim.M.hypot(sim.x - next.x, sim.y - next.y);
      if (Math.abs(d - next.orbit) < CAPTURE_WINDOW) capture(sim, sim.rocketPlanet + 1);
    }

    // ⚠ RUNS EVEN ON A FRAME THAT JUST CAPTURED, faithful to the client:
    // capture() moves neither the rocket nor its flyTime, so in principle a
    // catch at the edge of the field, or on the step flyTime crosses the
    // limit, would score and then end the run.
    //
    // MEASURED, it never happens, and the fall-through is dead code today.
    // Horizontally it cannot fire at all: a planet's x is clamped to [74, 346]
    // and its orbit is at most 52 + 58 = 110, so the furthest a capture ring
    // reaches is x = 482 and x = -62 — inside the -80/500 bounds. On fly time
    // it does not: across 300 runs and 4,169 captures the closest any capture
    // came to the 2.45s limit was 1.35s, because a flight shallow enough to
    // take that long leaves the field before it arrives. Kept in both halves
    // anyway, and pinned by "a capture can never coincide with the
    // out-of-bounds death" in the parity suite, so a wider placement or a
    // bigger capture window has to re-derive the claim instead of inheriting
    // it. Its mutation is marked inert for the same reason.
    if (sim.flyTime > MAX_FLY_TIME
        || sim.x < -FLY_X_MARGIN
        || sim.x > DESIGN_WIDTH + FLY_X_MARGIN
        || sim.y - sim.cameraY > DESIGN_HEIGHT + FLY_Y_MARGIN) {
      sim.dead = true;
      sim.deathFrame = sim.frames;
    }
  }

  // Per STEP, not per second — as the client always did. The camera is
  // GAMEPLAY here: the fell-off-the-bottom death above is measured against it,
  // which is why a variable timestep made a 144Hz display a different game.
  sim.cameraY = lerp(sim.cameraY, sim.targetCameraY, CAMERA_LERP);
}

// tap() → launchRocket(). A tap while already flying changes nothing and the
// client does not record one, so this mirrors that early return: a forged
// extra tap mid-flight buys an attacker exactly what it buys a player.
function tapSim(sim) {
  if (sim.dead || sim.mode !== 'orbit') return;
  const tangent = sim.angle + sim.orbitDir * Math.PI / 2;
  const speed = launchSpeedAt(sim.score);
  sim.vx = sim.M.cos(tangent) * speed;
  sim.vy = sim.M.sin(tangent) * speed;
  sim.mode = 'fly';
  sim.flyTime = 0;
}

function advanceTo(sim, frame) {
  let guard = 0;
  while (!sim.dead && sim.frames < frame && guard < MAX_SIM_FRAMES) { stepSim(sim); guard++; }
}

// ── v1 plausibility bounds (pre-replay traces only) ─────────────────────
//
// Unchanged from the pre-replay validator, on purpose: a stale cached client
// emits exactly the traces these were written for, and its score IS the count
// of accepted jumps. None of it matters on the sim path, where the score is
// computed rather than counted.
const MIN_JUMP_INTERVAL_MS = 250;
const MAX_JUMPS_PER_SEC = 4;
const RATE_WINDOW_MS = 1000;
const HARD_JUMP_CAP = 1000;
const MAX_SCORE_DELTA_PER_EVENT = 1;
const HUD_DROP_TOLERANCE = 5;

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    // 'v1' until a v2 start marker arrives — see the header.
    mode: 'v1',
    // 2 or 3 once a start marker arrives: which Math the trace was played on.
    version: null,
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    lastFrame: -1,
    inputCount: 0,

    score: 0,
    dead: false,
    jumps: 0,
    lastJumpT: null,
    rateWindow: [],
    rejectCount: 0,
    maxDurationSecs: Number(maxDurationSecs) || 600,
    elapsedSecs: Number(elapsedSecs) || 0,
    lastScoreAfter: 0,
    maxScoreAfter: 0,
    // Forensics only. The HUD value the client last reported on the sim path,
    // so a replay/HUD gap is visible in review even when the gate is off.
    claimedHud: 0,
  };
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || event.type !== 'input') return { accepted: true, newScore: state.score };
  const payload = event.payload || {};
  const kind = payload.kind;

  // The start marker opts this trace into the simulator. Without it we are
  // looking at a pre-replay client and must keep scoring it the old way.
  if (kind === 'start') {
    const v = Number(payload.v);
    if (v >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      // v4 = v3 with every orbit placed on screen; v3 = v2 on DMath.
      state.version = v >= 4 ? 4 : v >= 3 ? 3 : 2;
      state.sim = initSim(state.seed, state.version >= 3 ? DMath : Math, state.version);
    }
    return { accepted: true, newScore: state.score };
  }

  // ── replay path ────────────────────────────────────────────────────
  if (state.mode === 'sim') {
    if (kind === 'jump') {
      // Not scored — the replay is the score. Recorded so a gap between what
      // the player saw and what the server computed is visible in review.
      const sa = Number(payload.scoreAfter);
      if (Number.isFinite(sa) && sa > state.claimedHud) state.claimedHud = sa;
      return { accepted: true, newScore: state.score };
    }
    if (kind !== 'tap') return { accepted: true, newScore: state.score };

    if (state.inputCount >= MAX_INPUTS) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'input_cap' };
    }
    state.inputCount++;

    // `typeof` FIRST, because Number() coerces. `Number(null)` is 0, so a
    // frameless input would otherwise be silently applied at frame 0 rather
    // than refused — a real bug, found in Smash Down by its adversarial suite
    // and not by reading the code. An input whose frame is not a number cannot
    // be replayed at all, so refusing it is the only honest handling; the
    // client always sends one.
    const frame = payload.frame;
    if (typeof frame !== 'number' || !Number.isFinite(frame)
        || frame < 0 || Math.floor(frame) !== frame) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'bad_frame' };
    }
    // Frames may REPEAT — two taps can genuinely land in the same gap between
    // two steps (a touchstart and a synthesised mousedown, or two fingers).
    // They may never go BACKWARDS: a replay that rewound would let an attacker
    // re-run the same simulation window and pick the outcome.
    if (frame < state.lastFrame) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'frame_regressed' };
    }
    state.lastFrame = frame;

    const sim = state.sim;
    advanceTo(sim, frame);
    if (sim.dead) {
      state.dead = true;
      state.score = sim.score;
      return { accepted: false, newScore: state.score, reason: 'dead' };
    }
    tapSim(sim);
    state.score = sim.score;
    return { accepted: true, newScore: state.score };
  }

  // ── v1 plausibility path ───────────────────────────────────────────
  if (kind !== 'jump') return { accepted: true, newScore: state.score };

  const tHint = Number(payload.tHint);
  if (!Number.isFinite(tHint) || tHint < 0) {
    state.rejectCount++;
    return { accepted: false, newScore: state.score, reason: 'bad_thint' };
  }

  const scoreAfterRaw = Number(payload.scoreAfter);
  if (Number.isFinite(scoreAfterRaw) && scoreAfterRaw >= 0) {
    const delta = scoreAfterRaw - state.lastScoreAfter;
    if (delta >= 0 && delta <= MAX_SCORE_DELTA_PER_EVENT) {
      state.lastScoreAfter = scoreAfterRaw;
      if (scoreAfterRaw > state.maxScoreAfter) state.maxScoreAfter = scoreAfterRaw;
    }
  }

  if (state.lastJumpT !== null && tHint <= state.lastJumpT) {
    state.rejectCount++;
    return { accepted: false, newScore: state.score, reason: 'non_monotonic' };
  }
  if (state.lastJumpT !== null && (tHint - state.lastJumpT) < MIN_JUMP_INTERVAL_MS) {
    state.rejectCount++;
    // Advance the clock on the REFUSED event too — it tracked only accepted
    // ones, so a reject left it stale and doubled the gap for the next event,
    // letting a flood alternate reject/accept straight through the limit.
    state.lastJumpT = tHint;
    return { accepted: false, newScore: state.score, reason: 'too_fast' };
  }
  if (state.jumps >= HARD_JUMP_CAP) {
    state.dead = true;
    return { accepted: false, newScore: state.score, reason: 'hard_cap' };
  }
  state.rateWindow = state.rateWindow.filter((t) => tHint - t < RATE_WINDOW_MS);
  if (state.rateWindow.length >= MAX_JUMPS_PER_SEC) {
    state.rejectCount++;
    return { accepted: false, newScore: state.score, reason: 'rate_cap' };
  }
  state.rateWindow.push(tHint);

  // Client-asserted miss → game over, no score for this jump.
  if (payload.missed === true) {
    state.dead = true;
    state.lastJumpT = tHint;
    return { accepted: true, newScore: state.score };
  }

  state.score += 1;
  state.jumps += 1;
  state.lastJumpT = tHint;
  return { accepted: true, newScore: state.score };
}


// The replay's run-out is bounded by how long the session REALLY lasted. A
// run cannot hold more steps than real time allowed (the fixed step only ever
// drops time, never adds it), so an honest run always dies inside this bound;
// without it, a run the client ended by a rule the replay does not model (the
// overheat and idle rules) spun on to the session maximum. Only the submit
// replay passes elapsedSecs; the live stream does not, and keeps the old bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode === 'sim' && state.sim) {
    const sim = state.sim;
    // Run the world out past the last input, so a rocket still in flight when
    // the player stopped tapping is credited with the planet it was about to
    // catch — and so a run that was already doomed is recorded as dead.
    //
    // Bounded by the SESSION's own maximum duration, not by a flat number of
    // seconds: a player's whole last flight lives in this tail, and a run that
    // ends in orbit never dies at all (nobody tapped again), so a short flat
    // run-out would truncate the tail of a long session rather than the tail
    // of a long flight. Orbiting scores nothing, so spinning the world out
    // cannot inflate anything — the only thing this can add is a capture the
    // player had already earned.
    const runOutFrames = Math.min(
      MAX_SIM_FRAMES,
      Math.max(60 * 60, Math.ceil((Number(state.maxDurationSecs) || 600) * 60)));
    let guard = 0;
    const capFrames = elapsedCap(state, 60);
    while (!sim.dead && guard < runOutFrames && sim.frames < capFrames) { stepSim(sim); guard++; }
    return {
      score: sim.score,
      gameOver: true,
      // The client's own number is NOT consulted here — the replay is the
      // score. `require_claimed_match` in submitSession is the gate that
      // compares them.
      suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
      debug: {
        mode: 'sim', version: state.version, frames: sim.frames, deathFrame: sim.deathFrame,
        score: sim.score, dead: sim.dead,
        inputs: state.inputCount, claimedHud: state.claimedHud,
      },
    };
  }

  const accumulated = state.score;
  // Bound the HUD channel by what the ACCEPTED events could possibly have
  // earned, plus a little slack for events genuinely lost in flight.
  //
  // It used to be `Math.max(accumulated, hudSnapshot)` with hudSnapshot
  // unbounded, and the snapshot was recorded before the rate checks — so a
  // refused event still raised the ceiling and BOTH rate limits became
  // decorative. That is how a Sky Tower run was forged on 4 Sep 2026; every
  // validator built from this template shared the flaw.
  const hudCeiling  = state.jumps * MAX_SCORE_DELTA_PER_EVENT + HUD_DROP_TOLERANCE;
  const hudSnapshot = Math.min(state.maxScoreAfter || 0, hudCeiling);
  const finalScore = Math.max(accumulated, hudSnapshot);
  return {
    score: finalScore,
    gameOver: state.dead,
    suspicious: state.rejectCount >= 5 ? `validator_rejects:${state.rejectCount}` : null,
    debug: { mode: 'v1', accumulated, hudSnapshot, diff: hudSnapshot - accumulated },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  // Pinned to the session lifetime by shared/tests/sessionLifetime.test.js.
  _limits: { MAX_SIM_FRAMES, FPS: 60 },
  init,
  processEvent,
  finalize,
  simulate,
  _sim: {
    initSim, stepSim, tapSim, advanceTo, makePlanet, planetAt, planetRng, seedToInt, DMath,
    orbitSpeedAt, launchSpeedAt,
    DESIGN_WIDTH, DESIGN_HEIGHT, DT, PLANET_GAP, PLANET_START_Y, CAPTURE_WINDOW, ORBIT_EDGE_PAD, PLANET_EDGE_MARGIN,
    MAX_FLY_TIME, MAX_INPUTS, MAX_SIM_FRAMES,
  },
  _internal: { MIN_JUMP_INTERVAL_MS, MAX_JUMPS_PER_SEC },
};
