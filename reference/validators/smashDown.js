'use strict';

/**
 * Smash Down validator.
 *
 * TWO PATHS, and which one runs is decided by the trace itself:
 *
 *   'sim'  — SERVER-SIDE DETERMINISTIC REPLAY. The score is not taken from the
 *            client at all: the tower is rebuilt from the session seed, the
 *            player's presses and releases are re-applied on the fixed-step
 *            frames they landed on, and the server counts the platforms that
 *            broke before the ball smashed into a red arc. Entered by a v2
 *            `start` marker.
 *
 *   'v1'    — the old plausibility model (count the smash events, rate-limit
 *            them). KEPT ON PURPOSE for the length of the rollout: a stale
 *            cached client is still out there emitting markerless traces, and
 *            scoring those players zero is the one failure a cash leaderboard
 *            can least afford. `anticheat.smash-down.require_v2` closes that
 *            door once the frontend is fully deployed.
 *
 * Why replay at all: a signed envelope only ever proved "a real session", never
 * "a human played it". A beta tester forged 450 points on Sky Tower by signing
 * fake events, because the SDK hands the browser the session secret — it has
 * to, in order to sign. The only defence is that forged inputs cannot add up
 * to a score the game would not have produced.
 *
 * ⚠ EVERY CONSTANT BELOW IS LIFTED FROM games/smash-down/js/game.js AND MUST
 * STAY IDENTICAL TO IT. A change there without a change here silently
 * mis-scores every honest player — the one failure we cannot absorb.
 * shared/tests/smashDownParity.test.js drives the REAL game file through a
 * headless harness and fails the moment these drift.
 */

// ── tuning constants, verbatim from the game ────────────────────────────
const TAU                        = Math.PI * 2;
const DESIGN_HEIGHT              = 800;
const PORTRAIT_ASPECT            = 9 / 16;
const CAMERA_PROXIMITY           = 1.134;
const PLATFORM_SPACING           = 29;
const PLATFORM_OUTER_SCALE       = 0.2752;
const PLATFORM_OUTER_MAX         = 160;
const PLATFORM_TILT              = 0.26;
const PLATFORM_THICKNESS         = 17.51;
const PLATFORM_CONTACT_OFFSET    = 0.46;
const DIFFICULTY_START           = 8;
const DIFFICULTY_CAP             = 120;
const EXPERT_DIFFICULTY_START    = 220;
const EXPERT_DIFFICULTY_CAP      = 400;
const ROTATION_SPEED_MIN         = 0.018;
const ROTATION_SPEED_MAX         = 0.040;
const ROTATION_SPEED_EXPERT      = 0.055;
const SMASH_HIT_PAUSE_FRAMES     = 1;
const SMASH_ENTRY_SPEED          = 8;
const TAP_PUSH_WINDOW_MS         = 180;
const FRAME_MS                   = 1000 / 60;
const TAP_PUSH_WINDOW_FRAMES     = Math.round(TAP_PUSH_WINDOW_MS / FRAME_MS);   // 11
const POST_BREAK_SPEED           = 1.8;
const SMASH_REARM_FRAMES         = 7;
const SMASH_SPEED_CAP            = 15;
const NORMAL_FALL_SPEED_CAP      = 8.2;
const SMASH_UPWARD_DAMPING       = 0.60;
const SMASH_TURN_ACCELERATION    = 1.65;
const SMASH_DOWNWARD_ACCELERATION = 0.34;
const RELEASE_BRAKE_SPEED        = 5.8;
const RELEASE_BRAKE_FRAMES       = 6;

const BALL_GRAVITY               = 1.18;
const BALL_BOUNCE                = -14.5;
const BALL_START_Y               = 185;
const PLATFORM_START_Y           = 360;
const INITIAL_PLATFORMS          = 40;

// v3 (1 Oct 2026): THE RISING PRESSURE LINE. A player who is not going down
// fast enough is caught by a ceiling that creeps down the course, so the ball
// is eventually pushed off the top. It advances CEIL_RATE (+ a little per
// platform smashed, capped) world units every fixed step, and is never allowed
// to trail more than CEIL_LEAD above the deepest point the camera has reached,
// so a player who keeps descending is never near it. Counted in steps, not
// time. Older traces (v2) have no ceiling and replay without it.
const CEIL_LEAD                  = 24;
const CEIL_RATE                  = 0.65;
const CEIL_RATE_PER_SCORE        = 0.0013;
const CEIL_SCORE_CAP             = 150;

// Physics geometry is device-independent by construction — that is the point
// of pinning it in the client. Both values are the design-width evaluation of
// the expressions the game used to run against the player's viewport.
const DESIGN_PORTRAIT_WIDTH = DESIGN_HEIGHT * PORTRAIT_ASPECT;               // 450
const BALL_RADIUS = Math.max(16, Math.min(23, DESIGN_PORTRAIT_WIDTH * 0.047));
const PLATFORM_CONTACT_OFFSET_Y =
  Math.min(DESIGN_PORTRAIT_WIDTH * PLATFORM_OUTER_SCALE, PLATFORM_OUTER_MAX)
  * CAMERA_PROXIMITY * (1.11 - 0.5 * 0.22)      // towerPerspectiveScale(H/2), H === DESIGN_HEIGHT
  * PLATFORM_TILT * PLATFORM_CONTACT_OFFSET;

// A run that reaches this many steps is not a run — an HOUR of simulation,
// the session's own lifetime (SESSION_LIFETIME_SECS). It used to be 20
// minutes and silently TRUNCATED anything longer: advanceTo just stopped
// stepping, so a 25-minute run was scored as of minute 20 with no flag. Bounds
// server CPU per submit; the sim is a few dozen ns a step, so an hour is ms.
const MAX_SIM_FRAMES = 60 * 60 * 60;
// Bounds the trace's input channel. A human presses at most a few times per
// second; 20,000 is far past any real run and stops a huge trace from turning
// one submit into a CPU sink.
const MAX_INPUTS = 20000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp  = (a, b, t) => a + (b - a) * t;

function smoothstep01(x) { return x * x * (3 - 2 * x); }
function difficultyAt(progress) {
  return smoothstep01(clamp((progress - DIFFICULTY_START) / (DIFFICULTY_CAP - DIFFICULTY_START), 0, 1));
}
function expertDifficultyAt(progress) {
  return smoothstep01(clamp(
    (progress - EXPERT_DIFFICULTY_START) / (EXPERT_DIFFICULTY_CAP - EXPERT_DIFFICULTY_START), 0, 1));
}
function rotationSpeedAt(progress) {
  const standard = lerp(ROTATION_SPEED_MIN, ROTATION_SPEED_MAX, difficultyAt(progress));
  return lerp(standard, ROTATION_SPEED_EXPERT, expertDifficultyAt(progress));
}
function ceilRateAt(score) {
  return CEIL_RATE + CEIL_RATE_PER_SCORE * Math.min(score, CEIL_SCORE_CAP);
}
function norm(a) { a %= TAU; return a < 0 ? a + TAU : a; }
function angleInArc(a, start, size) {
  a = norm(a); start = norm(start);
  const end = norm(start + size);
  if (start <= end) return a >= start && a <= end;
  return a >= start || a <= end;
}

// ── the course ──────────────────────────────────────────────────────────
//
// INDEX-ADDRESSED, not a running stream: a platform's danger arc is a pure
// function of (seed, index). A stream would have to be consumed in exactly the
// same ORDER as the client, so a cosmetic random added to createPlatform later
// would desync the server silently. This cannot drift that way.
//
// mulberry32, and the draw order (roll, size, start) is the protocol — see the
// matching comment in createPlatform().
function platformRng(seedInt, index) {
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

function makePlatform(seedInt, y, index) {
  const grnd = platformRng(seedInt, index);
  const difficulty = difficultyAt(index);
  const expertDifficulty = expertDifficultyAt(index);
  const dangerChance = lerp(lerp(0.22, 0.78, difficulty), 0.94, expertDifficulty);
  const isBreatherPlatform = index > 0 && index % 12 === 0;

  let danger = null;
  if (index >= DIFFICULTY_START && !isBreatherPlatform && grnd() < dangerChance) {
    const lo = lerp(lerp(0.52, 0.90, difficulty), 1.15, expertDifficulty);
    const hi = lerp(lerp(0.82, 1.50, difficulty), 2.0, expertDifficulty);
    const size = grnd() * (hi - lo) + lo;
    danger = { start: grnd() * TAU, size };
  }
  return {
    y, index, danger,
    passed: false, broken: false, breakPending: false, pendingDanger: false,
  };
}

// The four body segments are each `TAU/4 + .006` wide and start at a common
// offset, so their union is the whole circle plus a hair of overlap: there is
// no angle at which the ball is NOT over the platform body. That is why the
// client's cosmetic seam offset is left on Math.random and does not appear
// here at all. smashDownParity.test.js pins it.
const OVER_PIECE_ALWAYS = true;

function initSim(seed, version = 3) {
  const seedInt = seedToInt(seed);
  const platforms = [];
  for (let i = 0; i < INITIAL_PLATFORMS; i++) {
    platforms.push(makePlatform(seedInt, PLATFORM_START_Y + i * PLATFORM_SPACING, i));
  }
  return {
    seedInt,
    version: Number(version) >= 3 ? 3 : 2,
    ceilY: -CEIL_LEAD,
    frames: 0,
    score: 0,
    dead: false,
    towerRot: 0,
    rotationSpeed: rotationSpeedAt(0),
    worldY: BALL_START_Y,
    screenY: BALL_START_Y,
    vy: 0,
    cameraY: 0,
    cameraTargetY: 0,
    deathFrame: null,
    smashing: false,
    smashPressFrame: -1,
    smashRearmFrames: 0,
    releaseBrakeFrames: 0,
    smashStreak: 0,
    hitPauseFrames: 0,
    platforms,
    inputs: 0,
  };
}

function contactYOf(p) { return p.y + PLATFORM_CONTACT_OFFSET_Y; }

// resolvePendingBreaks() — runs on the frame a hit-pause expires.
function resolvePendingBreaks(sim) {
  for (const p of sim.platforms) {
    if (!p.breakPending) continue;
    p.breakPending = false;
    p.broken = true;
    sim.smashStreak++;

    if (sim.smashing) {
      const chainProgress = clamp(sim.smashStreak - 1, 0, 4);
      const chainSpeed = Math.min(POST_BREAK_SPEED + chainProgress * 3.3, SMASH_SPEED_CAP);
      sim.vy = Math.min(sim.vy, chainSpeed);
      sim.smashRearmFrames = Math.max(0, SMASH_REARM_FRAMES - chainProgress * 2);
    } else {
      sim.smashRearmFrames = 0;
    }

    sim.score++;
    sim.rotationSpeed = rotationSpeedAt(sim.score);      // updateUI()
  }
}

// One fixed 1/60s update() — the same order and the same early returns as the
// client's, including the ones that skip platform generation for a frame.
function stepSim(sim) {
  if (sim.dead) return;
  sim.frames++;

  if (sim.hitPauseFrames > 0) {
    sim.hitPauseFrames--;
    if (sim.hitPauseFrames === 0) resolvePendingBreaks(sim);
    return;
  }

  const previousWorldY = sim.worldY;
  sim.towerRot += sim.rotationSpeed;
  if (sim.smashRearmFrames > 0) sim.smashRearmFrames--;

  if (sim.smashing) {
    sim.releaseBrakeFrames = 0;
    if (sim.vy < 0) {
      sim.vy = sim.vy * SMASH_UPWARD_DAMPING + SMASH_TURN_ACCELERATION;
    } else {
      sim.vy = Math.min(sim.vy + SMASH_DOWNWARD_ACCELERATION, SMASH_SPEED_CAP);
    }
  } else if (sim.releaseBrakeFrames > 0 && sim.vy > RELEASE_BRAKE_SPEED) {
    const remainingSpeed = sim.vy - RELEASE_BRAKE_SPEED;
    sim.vy -= Math.max(0.32, remainingSpeed / sim.releaseBrakeFrames);
    sim.releaseBrakeFrames--;
  } else {
    sim.releaseBrakeFrames = 0;
    sim.vy = Math.min(sim.vy + BALL_GRAVITY, NORMAL_FALL_SPEED_CAP);
  }
  sim.worldY += sim.vy;

  const desiredScreenY = DESIGN_HEIGHT * 0.27;
  sim.cameraTargetY = Math.max(sim.cameraTargetY, sim.worldY - desiredScreenY, 0);
  sim.cameraY += (sim.cameraTargetY - sim.cameraY) * 0.135;
  sim.screenY = sim.worldY - sim.cameraY;

  // v3: the rising pressure line. Raised, then tested against the ball's top.
  if (sim.version >= 3) {
    sim.ceilY = Math.max(sim.ceilY + ceilRateAt(sim.score), sim.cameraTargetY - CEIL_LEAD);
    if (sim.worldY - BALL_RADIUS < sim.ceilY) {
      sim.dead = true;
      sim.deathFrame = sim.frames;
      return;
    }
  }

  // The visibility window is not cosmetic here: it decides which platforms are
  // collision-checked at all, and which can be scored by the fell-past branch.
  const visible = [];
  for (const p of sim.platforms) {
    const y = p.y - sim.cameraY;
    if (y > -220 && y < DESIGN_HEIGHT + 260) visible.push(p);
  }

  for (const p of visible) {
    if (p.broken) continue;

    const contactY = contactYOf(p);
    const previousBottom = previousWorldY + BALL_RADIUS;
    const currentBottom = sim.worldY + BALL_RADIUS;
    // The upper bound is defensive padding against re-triggering a platform
    // the ball is already below, and it never binds — over 3,031 contact
    // candidates the closest it came was 25.51 units, the whole slack.
    const hitY = sim.vy > 0
      && previousBottom <= contactY + PLATFORM_THICKNESS + 8
      && currentBottom >= contactY - 2;

    if (hitY) {
      const visibleAngle = norm(Math.PI / 2 - sim.towerRot);
      const overPiece = OVER_PIECE_ALWAYS;
      const danger = overPiece && !!p.danger
        && angleInArc(visibleAngle, p.danger.start, p.danger.size);
      const smashCanBreak = sim.smashing && sim.smashRearmFrames <= 0;

      if (overPiece) {
        if (smashCanBreak && danger) {
          // Smashed into a red arc — endGame(true). The run stops scoring here.
          sim.worldY = contactY - BALL_RADIUS * 0.68;
          sim.screenY = sim.worldY - sim.cameraY;
          sim.dead = true;
          sim.deathFrame = sim.frames;
          return;
        }

        if (smashCanBreak) {
          p.passed = true;
          p.breakPending = true;
          p.pendingDanger = danger;
          sim.worldY = contactY - BALL_RADIUS * 0.70;
          sim.screenY = sim.worldY - sim.cameraY;
          sim.hitPauseFrames = SMASH_HIT_PAUSE_FRAMES;
          return;                       // skips platform generation this frame
        }

        sim.worldY = contactY - BALL_RADIUS;
        sim.vy = BALL_BOUNCE;
        sim.smashStreak = 0;
      }
    }

    // The client's fell-past safety net, copied faithfully — and never reached:
    // the only way past an unbroken platform is to smash it, which sets
    // `passed` first, and a bounce leaves the ball above. Measured over 24 runs
    // / 7,477 steps: 0 executions. Kept anyway, because the two halves must
    // stay identical if a future change ever makes it reachable.
    if (!p.passed && sim.worldY > contactYOf(p) + 46) {
      p.passed = true;
      p.broken = true;
      sim.score++;
      sim.rotationSpeed = rotationSpeedAt(sim.score);    // updateUI()
    }
  }

  while (sim.platforms[sim.platforms.length - 1].y - sim.cameraY < DESIGN_HEIGHT + 1300) {
    const last = sim.platforms[sim.platforms.length - 1];
    sim.platforms.push(makePlatform(sim.seedInt, last.y + PLATFORM_SPACING, last.index + 1));
  }
  while (sim.platforms.length && sim.platforms[0].y - sim.cameraY < -360) {
    sim.platforms.shift();
  }

  if (sim.screenY > DESIGN_HEIGHT + 180) {                    // endGame()
    sim.dead = true;
    sim.deathFrame = sim.frames;
  }
}

// engageSmash() — a press while already holding changes nothing, and the
// client does not record one, so this mirrors that early return.
function pressSim(sim) {
  if (sim.dead || sim.smashing) return;
  sim.smashing = true;
  sim.smashPressFrame = sim.frames;
  sim.smashRearmFrames = 0;
  sim.releaseBrakeFrames = 0;
  sim.vy = Math.max(sim.vy, SMASH_ENTRY_SPEED);
}

// releaseSmash() — applied for EVERY recorded release, including one that was
// not holding: that still zeroes smashRearmFrames, which is a real physics
// mutation, and a replay that skipped it would drift.
function releaseSim(sim) {
  if (sim.dead) return;
  const wasSmashing = sim.smashing;
  // The quick-tap window is counted in FIXED STEPS, exactly as the client now
  // does. It used to be wall-clock ms on both sides, which made a stuttering
  // phone read a held press as a tap.
  const wasQuickTap = wasSmashing
    && sim.frames - sim.smashPressFrame <= TAP_PUSH_WINDOW_FRAMES;
  sim.smashing = false;
  sim.smashPressFrame = -1;
  sim.smashRearmFrames = 0;

  if (wasQuickTap) {
    sim.releaseBrakeFrames = 0;
    sim.vy = Math.max(sim.vy, SMASH_ENTRY_SPEED);
  } else if (wasSmashing && sim.vy > RELEASE_BRAKE_SPEED) {
    sim.releaseBrakeFrames = RELEASE_BRAKE_FRAMES;
  }
}

function advanceTo(sim, frame) {
  let guard = 0;
  while (!sim.dead && sim.frames < frame && guard < MAX_SIM_FRAMES) { stepSim(sim); guard++; }
}

// ── v1 plausibility bounds (pre-replay traces only) ─────────────────────
//
// LEFT DELIBERATELY LOOSE. A smashing dive is capped by SMASH_SPEED_CAP (15)
// over PLATFORM_SPACING (29), i.e. ~31 platforms/sec, so no honest interval
// bound here can be tight — a tighter one would clip a real full dive. This
// game's v1 defence was always `games.max_score_per_sec` (it scores exactly 1
// per event, so events/sec == score/sec). None of it matters on the sim path,
// where the score is computed rather than counted.
const MIN_SMASH_INTERVAL_MS     = 20;
const MAX_SMASHES_PER_SEC       = 35;
const MAX_SMASHES               = 5000;
const MAX_SCORE_DELTA_PER_EVENT = 1;
const HUD_DROP_TOLERANCE        = 5;

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    // 'v1' until a v2 start marker arrives — see the header.
    mode: 'v1',
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    lastFrame: -1,
    inputCount: 0,

    score: 0,
    dead: false,
    smashes: 0,
    lastT: null,
    firstT: null,
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
  if (!event || typeof event !== 'object') return { accepted: true, newScore: state.score };
  const { type, payload } = event;
  if (type !== 'input') return { accepted: true, newScore: state.score };
  const kind = payload && payload.kind;

  // The start marker opts this trace into the simulator. Without it we are
  // looking at a pre-replay client and must keep scoring it the old way.
  if (kind === 'start') {
    if (payload && Number(payload.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, payload.v);
    }
    return { accepted: true, newScore: state.score };
  }

  // ── replay path ────────────────────────────────────────────────────
  if (state.mode === 'sim') {
    if (kind === 'smash') {
      // Not scored — the replay is the score. Recorded so a gap between what
      // the player saw and what the server computed is visible in review.
      const sa = Number(payload && payload.scoreAfter);
      if (Number.isFinite(sa) && sa > state.claimedHud) state.claimedHud = sa;
      return { accepted: true, newScore: state.score };
    }
    if (kind !== 'press' && kind !== 'release') {
      return { accepted: true, newScore: state.score };
    }

    if (state.inputCount >= MAX_INPUTS) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'input_cap' };
    }
    state.inputCount++;

    // `typeof` FIRST, because Number() coerces. `Number(null)` is 0, so a
    // frameless input used to be silently applied at frame 0 rather than
    // refused — found by the adversarial suite, not by reading the code.
    // An input whose frame is not a number cannot be replayed at all, so
    // refusing it is the only honest handling; the client always sends one.
    const frame = payload && payload.frame;
    if (typeof frame !== 'number' || !Number.isFinite(frame)
        || frame < 0 || Math.floor(frame) !== frame) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'bad_frame' };
    }
    // Frames may REPEAT — a press and its release can genuinely land in the
    // same gap between two steps, and the order within that gap is what the
    // trace records. They may never go BACKWARDS: a replay that rewound would
    // let an attacker re-run the same simulation window and pick the outcome.
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
    if (kind === 'press') pressSim(sim); else releaseSim(sim);
    state.score = sim.score;
    return { accepted: true, newScore: state.score };
  }

  // ── v1 plausibility path ───────────────────────────────────────────
  if (kind !== 'smash') return { accepted: true, newScore: state.score };

  const tHint = Number(payload && payload.tHint);
  if (!Number.isFinite(tHint) || tHint < 0) {
    state.rejectCount++;
    return { accepted: true, newScore: state.score, reason: 'bad_thint' };
  }

  const scoreAfterRaw = Number(payload && payload.scoreAfter);
  if (Number.isFinite(scoreAfterRaw) && scoreAfterRaw >= 0) {
    const delta = scoreAfterRaw - state.lastScoreAfter;
    if (delta >= 0 && delta <= MAX_SCORE_DELTA_PER_EVENT) {
      state.lastScoreAfter = scoreAfterRaw;
      if (scoreAfterRaw > state.maxScoreAfter) state.maxScoreAfter = scoreAfterRaw;
    }
  }

  if (state.lastT !== null) {
    if (tHint - state.lastT < MIN_SMASH_INTERVAL_MS) {
      state.rejectCount++;
      // Advance the clock on the REFUSED event too — tracking only accepted
      // ones left it stale and doubled the gap for the next event, letting a
      // flood alternate reject/accept straight through the limit.
      state.lastT = tHint;
      return { accepted: true, newScore: state.score, reason: 'too_fast' };
    }
  } else {
    state.firstT = tHint;
  }

  if (state.smashes >= MAX_SMASHES) {
    state.dead = true;
    return { accepted: false, newScore: state.score, reason: 'hard_cap' };
  }

  if (state.firstT !== null && state.smashes > 5) {
    const elapsedSec = Math.max(1, (tHint - state.firstT) / 1000);
    if (state.smashes / elapsedSec > MAX_SMASHES_PER_SEC) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'rate_cap' };
    }
  }

  state.score += 1;
  state.smashes += 1;
  state.lastT = tHint;
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
    // Run the world out past the last input, so a run that was already doomed
    // when the player stopped pressing is recorded as dead — and so a ball
    // still falling is credited with the platforms it clears.
    //
    // Bounded by the SESSION's own maximum duration, not by a flat number of
    // seconds. Smash Down's whole input is hold-and-release, so a player who
    // presses once and holds to the death emits exactly ONE input and their
    // entire run lives in this tail. A flat 60-second run-out would have
    // silently truncated any such run longer than a minute and credited them
    // fewer platforms than they watched break.
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
        mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame,
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
  const hudCeiling  = state.smashes * MAX_SCORE_DELTA_PER_EVENT + HUD_DROP_TOLERANCE;
  const hudSnapshot = Math.min(state.maxScoreAfter || 0, hudCeiling);
  const finalScore = Math.max(accumulated, hudSnapshot);
  return {
    score: finalScore,
    gameOver: state.dead || finalScore > 0,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
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
  init, processEvent, finalize, simulate,
  _sim: {
    initSim, stepSim, pressSim, releaseSim, advanceTo, makePlatform, platformRng,
    seedToInt, rotationSpeedAt, ceilRateAt, difficultyAt, expertDifficultyAt, angleInArc, norm,
    BALL_RADIUS, CEIL_LEAD, CEIL_RATE, CEIL_RATE_PER_SCORE, CEIL_SCORE_CAP, PLATFORM_CONTACT_OFFSET_Y, PLATFORM_SPACING, TAP_PUSH_WINDOW_FRAMES,
    MAX_INPUTS, MAX_SIM_FRAMES,
  },
  _internal: { MIN_SMASH_INTERVAL_MS, MAX_SMASHES_PER_SEC, MAX_SMASHES },
};
