'use strict';

/**
 * Twist Fall validator.
 *
 * TWO PATHS, and which one runs is decided by the trace itself:
 *
 *   'sim'  — SERVER-SIDE DETERMINISTIC REPLAY. The score is not taken from the
 *            client at all: the tower is rebuilt from the session seed, the
 *            rotation the player applied is re-applied on the fixed-step frames
 *            it landed on, and the server counts the platforms the ball fell
 *            past before it landed on a red arc. Entered by a v2 `start`
 *            marker.
 *
 *   'v1'   — the old plausibility model (count the `pass` events, rate-limit
 *            them, recover from the HUD snapshot). KEPT ON PURPOSE for the
 *            length of the rollout: a stale cached client is still out there
 *            emitting markerless traces, and scoring those players zero is the
 *            one failure a cash leaderboard can least afford.
 *            `anticheat.twist-fall.require_v2` closes that door once the
 *            frontend is fully deployed.
 *
 * Why replay at all: a signed envelope only ever proved "a real session", never
 * "a human played it". A beta tester forged 450 points on Sky Tower by signing
 * fake events, because the SDK hands the browser the session secret — it has
 * to, in order to sign. The only defence is that forged inputs cannot add up
 * to a score the game would not have produced.
 *
 * ⚠ EVERY CONSTANT BELOW IS LIFTED FROM games/twist-fall/js/game.js AND MUST
 * STAY IDENTICAL TO IT. A change there without a change here silently
 * mis-scores every honest player — the one failure we cannot absorb.
 * shared/tests/twistFallParity.test.js drives the REAL game file through a
 * headless harness and fails the moment these drift, comparing the whole
 * trajectory rather than the final number.
 */

// ── tuning constants, verbatim from the game ────────────────────────────
const TAU                     = Math.PI * 2;
const DESIGN_WIDTH            = 390;
const DESIGN_HEIGHT           = 844;
const PLATFORM_SPACING        = 198.45;
const MIN_PLATFORM_SPACING    = 157.95;
const PLATFORM_OUTER_SCALE    = .378;
const PLATFORM_OUTER_MAX      = 230;
const PLATFORM_TILT           = .33;
const PLATFORM_CONTACT_OFFSET = .46;
const START_SAFE_ANGLE        = Math.PI / 2;
const START_DANGER_CLEARANCE  = .42;

// performanceConfig — a single fixed profile in the game, so these are
// constants and not device-dependent. deviceProfile only moves the canvas
// pixel budget, which is drawing, not physics.
const INITIAL_PLATFORMS  = 10;
const VISIBLE_PAD_TOP    = 160;
const VISIBLE_PAD_BOTTOM = 190;
const PLATFORM_BUFFER    = 640;

const BALL_START_Y   = 185;
const BALL_GRAVITY   = .62;
const BALL_BOUNCE    = -13.5;
const PLATFORM_START_Y = 360;

// Physics geometry is device-independent BY CONSTRUCTION: the game pins
// W = DESIGN_WIDTH and H = DESIGN_HEIGHT and letterboxes the canvas around
// them, so every expression below evaluates to the same number on every phone.
// twistFallParity.test.js proves that from the outside, by running the same
// course and inputs at aspect ratios from 320x568 to 1440x780 and requiring an
// identical trajectory — the fairness bug that made Smash Down diverge on 4.5%
// of courses (worst pair 58 points against 16) is structurally impossible here,
// but "structurally impossible" is a claim that has to be tested.
const BALL_RADIUS = Math.max(16, Math.min(23, DESIGN_WIDTH * .047));      // 18.33
const PLATFORM_OUTER_RADIUS_X = Math.min(DESIGN_WIDTH * PLATFORM_OUTER_SCALE, PLATFORM_OUTER_MAX);
// platformContactY(p) = p.y + platformOuterRadiusY() * PLATFORM_CONTACT_OFFSET,
// where platformOuterRadiusY() = platformOuterRadiusX() * PLATFORM_TILT. The
// multiplication order is the client's; floats are not associative.
const PLATFORM_CONTACT_OFFSET_Y =
  (PLATFORM_OUTER_RADIUS_X * PLATFORM_TILT) * PLATFORM_CONTACT_OFFSET;    // 22.378356

// A run that reaches this many steps is not a run — an HOUR of simulation,
// the session's own lifetime (SESSION_LIFETIME_SECS). It used to be 20
// minutes and silently TRUNCATED anything longer: advanceTo just stopped
// stepping, so a 25-minute run was scored as of minute 20 with no flag. Bounds
// server CPU per submit; the sim is a few dozen ns a step, so an hour is ms.
const MAX_SIM_FRAMES = 60 * 60 * 60;
// Rotation travels as INTEGER QUANTA of 1e-5 rad. Both sides compute the
// applied delta as `q / ROT_QUANTUM` from the same integer, so the addition is
// bit-identical without either of them having to format a float.
const ROT_QUANTUM = 1e5;

// Bounds the trace's rotation channel, counted in QUANTA (array entries), not
// events. The client can honestly produce at most one per fixed step, so a
// 600-second session — the game's whole max_duration_secs — carries 36,000.
// This sits far above that, because a cap that can only ever clip belongs far
// above anything an honest client can produce; the simulation work itself is
// bounded independently by MAX_SIM_FRAMES.
const MAX_INPUTS = 200000;
// One event's array. The client cuts batches at 120, but where it cuts them is
// NOT part of the protocol — the array is positional, so the server does not
// care. This is a work bound on one event and nothing else.
const MAX_BATCH = 100000;
// An honest rotation quantum is bounded by the screen: a full-width drag inside
// one frame is 390 * .012 = 4.68 rad = 468,000 quanta, and an arrow key is
// 24,000. This is ~200,000x that, so it can only ever refuse a forgery. It
// exists so a wild magnitude cannot quietly destroy the precision of towerRot
// for the rest of the replay.
const MAX_ROT_QUANTUM = 1e11;

function norm(a) { a %= TAU; return a < 0 ? a + TAU : a; }

function angleInArc(a, start, size) {
  a = norm(a); start = norm(start);
  const end = norm(start + size);
  if (start <= end) return a >= start && a <= end;
  return a >= start || a <= end;
}

// The client stores dangerStartAngle / dangerEndAngle on every danger piece and
// falls back to start/size only for shapes it no longer creates. We always
// build both, so this is the same test either way.
function angleInDangerSegment(angle, seg) {
  return angleInArc(angle, seg.dangerStartAngle, seg.dangerEndAngle - seg.dangerStartAngle);
}

// ── the course ──────────────────────────────────────────────────────────
//
// INDEX-ADDRESSED, not a running stream: a platform's layout is a pure
// function of (seed, index). A stream would have to be consumed in exactly the
// same ORDER as the client, so a cosmetic random added to createPlatform later
// would desync the server silently. This cannot drift that way.
//
// mulberry32, byte-identical to platformRng() in games/twist-fall/js/game.js.
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

const srand = (g, a, b) => g() * (b - a) + a;

// Fisher-Yates, seeded — the client's `sort(() => Math.random() - .5)` was not
// a uniform shuffle and could not be replayed at all. Consumes exactly n-1
// draws, which is part of the protocol.
function shuffleSeeded(list, g) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(g() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

// ⚠ THE DRAW ORDER IS THE PROTOCOL — see the matching comment in
// createPlatform(). Adding, removing or reordering a draw here without doing
// the same in the game (or vice versa) silently mis-scores every honest run.
function makePlatform(seedInt, y, index) {
  const grnd = platformRng(seedInt, index);
  const segmentCount = index === 0 ? 1 : Math.floor(srand(grnd, 1, 3.999));
  const unit = TAU / segmentCount;
  // Drawn ALWAYS, even when index > 0 leaves it unused: the client draws it
  // unconditionally, so skipping it here would shift every later draw.
  const firstGap = srand(grnd, 1.02, 1.18);
  const firstBodySize = TAU - firstGap;
  const offset = index === 0 ? norm(START_SAFE_ANGLE - firstBodySize * .5) : srand(grnd, 0, TAU);
  const bodyPieces = [];

  for (let i = 0; i < segmentCount; i++) {
    const gap = index === 0 ? firstGap : srand(grnd, .84, Math.min(1.16, unit * .48));
    const size = Math.max(unit * .50, unit - gap);
    const jitter = index === 0 ? 0 : srand(grnd, -unit * .035, unit * .035);
    const start = norm(offset + i * unit + gap * .5 + jitter);
    bodyPieces.push({ start, size });
  }

  const dangerTopPieces = [];
  const dangerCount = index < 2 ? 1 : Math.min(bodyPieces.length, Math.floor(srand(grnd, 1, 2.999)));
  const dangerCandidates = shuffleSeeded(bodyPieces.slice(), grnd);

  for (const piece of dangerCandidates) {
    if (dangerTopPieces.length >= dangerCount) break;
    const maxSize = Math.min(piece.size * .72, srand(grnd, .42, .78));
    if (maxSize < .24) continue;
    // The draw happens even when index === 0 overwrites the result below —
    // the client evaluates it before reassigning, so the stream must too.
    let start = norm(piece.start + srand(grnd, .05, Math.max(.06, piece.size - maxSize - .05)));

    if (index === 0) {
      const safeEnd = norm(piece.start + piece.size - maxSize - .08);
      start = angleInArc(START_SAFE_ANGLE, piece.start, piece.size * .5)
        ? safeEnd
        : norm(piece.start + .08);
    }

    const mid = norm(start + maxSize * .5);

    if (index === 0
        && angleInArc(START_SAFE_ANGLE, mid - START_DANGER_CLEARANCE, START_DANGER_CLEARANCE * 2)) {
      continue;
    }

    dangerTopPieces.push({
      start,
      dangerStartAngle: start,
      dangerEndAngle: start + maxSize,
      size: maxSize,
    });
  }

  return { y, index, bodyPieces, dangerTopPieces, passed: false, broken: false };
}

function initSim(seed) {
  const seedInt = seedToInt(seed);
  const platforms = [];
  let nextPlatformIndex = 0;
  for (let i = 0; i < INITIAL_PLATFORMS; i++) {
    platforms.push(makePlatform(seedInt, PLATFORM_START_Y + i * PLATFORM_SPACING, nextPlatformIndex++));
  }
  return {
    seedInt,
    frames: 0,
    score: 0,
    dead: false,
    deathFrame: null,
    deathCause: null,
    towerRot: 0,
    worldY: BALL_START_Y,
    screenY: BALL_START_Y,
    vy: 0,
    cameraY: 0,
    cameraTargetY: 0,
    platforms,
    nextPlatformIndex,
  };
}

function contactYOf(p) { return p.y + PLATFORM_CONTACT_OFFSET_Y; }

// One fixed 1/60s updateFixed() — the same order, the same early returns, and
// the same stale-`nearPassBand` quirk as the client's. The quirk is real: a
// ball moving fast enough can satisfy BOTH the bounce test and the pass test
// against one platform in a single step, because nearPassBand is computed
// before the bounce resets worldY. It is copied rather than tidied, because a
// tidier server is a server that disagrees with the game.
function stepSim(sim) {
  if (sim.dead) return;
  sim.frames++;

  const previousWorldY = sim.worldY;
  const speedBoost = Math.min(sim.score * .002, .45);
  sim.vy += BALL_GRAVITY + speedBoost * .15;
  sim.worldY += sim.vy;

  const desiredScreenY = DESIGN_HEIGHT * .34;
  sim.cameraTargetY = Math.max(sim.cameraTargetY, sim.worldY - desiredScreenY, 0);
  sim.cameraY += (sim.cameraTargetY - sim.cameraY) * .135;
  sim.screenY = sim.worldY - sim.cameraY;

  // refreshVisiblePlatforms(). Not cosmetic here: it decides which platforms
  // are collision-checked at all.
  const visible = [];
  for (const p of sim.platforms) {
    const y = p.y - sim.cameraY;
    if (y > -VISIBLE_PAD_TOP && y < DESIGN_HEIGHT + VISIBLE_PAD_BOTTOM) visible.push(p);
  }

  const visibleAngle = norm(Math.PI / 2 - sim.towerRot);
  for (let i = 0; i < visible.length; i++) {
    const p = visible[i];
    if (p.broken) continue;

    const contactY = contactYOf(p);
    const previousBottom = previousWorldY + BALL_RADIUS;
    const currentBottom = sim.worldY + BALL_RADIUS;
    const nearCollisionBand = currentBottom >= contactY - 18 && previousBottom <= contactY + 28;
    const nearPassBand = sim.worldY > contactY + 46;

    if (!nearCollisionBand && (p.passed || !nearPassBand)) continue;

    const hitY = sim.vy > 0 && previousBottom <= contactY + 18 && currentBottom >= contactY - 10;

    if (hitY) {
      const overPiece = p.bodyPieces.some((piece) => angleInArc(visibleAngle, piece.start, piece.size));
      const danger = overPiece
        && p.dangerTopPieces.some((piece) => angleInDangerSegment(visibleAngle, piece));

      if (overPiece) {
        if (danger) {
          // Landed on a red arc — endGame(). The run stops scoring here, and
          // the client returns from updateFixed, so no platform generation and
          // no fall-off test this frame either.
          sim.dead = true;
          sim.deathFrame = sim.frames;
          sim.deathCause = 'danger';
          return;
        }
        sim.worldY = contactY - BALL_RADIUS;
        sim.vy = BALL_BOUNCE;
      }
    }

    if (!p.passed && nearPassBand) {
      p.passed = true;
      p.broken = true;
      sim.score++;
    }
  }

  while (sim.platforms[sim.platforms.length - 1].y - sim.cameraY < DESIGN_HEIGHT + PLATFORM_BUFFER) {
    const last = sim.platforms[sim.platforms.length - 1];
    const nextY = last.y + Math.max(MIN_PLATFORM_SPACING, PLATFORM_SPACING - sim.score * .30);
    sim.platforms.push(makePlatform(sim.seedInt, nextY, sim.nextPlatformIndex++));
  }
  while (sim.platforms.length && sim.platforms[0].y - sim.cameraY < -300) {
    sim.platforms.shift();
  }

  if (sim.screenY > DESIGN_HEIGHT + 180) {                     // endGame()
    sim.dead = true;
    sim.deathFrame = sim.frames;
    sim.deathCause = 'fell';
  }
}

// The client applies the coalesced delta at the top of the step, so on the
// server it is applied between step F and step F+1. ONE addition on each side,
// of the identical double — which is exactly why the client coalesces rather
// than emitting every pointermove: summing N deltas and adding one number are
// not the same float.
function rotateSim(sim, d) {
  if (sim.dead) return;
  sim.towerRot += d;
}

// The cap is on the SIMULATION, not on this call. A per-call guard bounds one
// advance and nothing else, so a trace made of many batches could buy far more
// total steps than one long batch — every step costs the same work, and this is
// the bound on what a single submit can make the server do.
function advanceTo(sim, frame) {
  const limit = Math.min(frame, MAX_SIM_FRAMES);
  while (!sim.dead && sim.frames < limit) stepSim(sim);
}

// ── v1 plausibility bounds (pre-replay traces only) ─────────────────────
//
// Unchanged from the pre-replay validator, deliberately: a stale cached client
// must keep scoring exactly as it does today for the length of the rollout.
// Set from production — 41 unflagged human sessions topped out at 0.83
// passes/sec. None of it matters on the sim path, where the score is computed
// rather than counted.
const MIN_PASS_INTERVAL_MS = 60;
const MAX_PASSES_PER_SEC   = 6;
const MAX_PASSES           = 5000;
const MAX_SCORE_DELTA_PER_EVENT = 1;
const HUD_DROP_TOLERANCE = 5;

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
    passes: 0,
    lastPassT: null,
    firstPassT: null,
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
      state.sim = initSim(state.seed);
    }
    return { accepted: true, newScore: state.score };
  }

  // ── replay path ────────────────────────────────────────────────────
  if (state.mode === 'sim') {
    if (kind === 'pass') {
      // Not scored — the replay is the score. Recorded so a gap between what
      // the player saw and what the server computed is visible in review.
      const sa = Number(payload && payload.scoreAfter);
      if (Number.isFinite(sa) && sa > state.claimedHud) state.claimedHud = sa;
      return { accepted: true, newScore: state.score };
    }
    if (kind !== 'rot') return { accepted: true, newScore: state.score };

    // `typeof` FIRST, because Number() coerces. `Number(null)` is 0, so a
    // frameless input would be silently applied at frame 0 rather than
    // refused — found in Smash Down by its adversarial suite, not by reading
    // the code. An input whose frame is not a number cannot be replayed at
    // all, so refusing it is the only honest handling; the client always
    // sends one.
    const f = payload && payload.f;
    if (typeof f !== 'number' || !Number.isFinite(f)
        || f < 0 || Math.floor(f) !== f) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'bad_frame' };
    }
    const q = payload && payload.q;
    if (!Array.isArray(q) || q.length === 0 || q.length > MAX_BATCH) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'bad_batch' };
    }
    // Batches are POSITIONAL and dense, so they cannot overlap: entry i of a
    // batch based at f lands on step f+1+i, and a later batch must start at or
    // after the last step this one addressed. Frames therefore never repeat
    // and never regress — a replay that rewound would let an attacker re-run
    // the same simulation window and keep the best outcome.
    if (f < state.lastFrame) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'frame_regressed' };
    }

    if (state.inputCount + q.length > MAX_INPUTS) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'input_cap' };
    }

    // VALIDATE THE WHOLE BATCH BEFORE APPLYING ANY OF IT: a batch lands whole
    // or not at all. Stopping half way through would leave the replay running
    // from a state the game never had, and — worse — it would leave lastFrame
    // behind the frames already consumed, so a second batch based at the same
    // frame would be accepted and re-address them. Refusing outright costs an
    // honest client nothing; it never sends one of these.
    for (let i = 0; i < q.length; i++) {
      const qi = q[i];
      if (typeof qi !== 'number' || !Number.isInteger(qi) || Math.abs(qi) > MAX_ROT_QUANTUM) {
        state.rejectCount++;
        return { accepted: true, newScore: state.score, reason: 'bad_delta' };
      }
    }
    state.inputCount += q.length;
    state.lastFrame = f + q.length;

    const sim = state.sim;
    for (let i = 0; i < q.length; i++) {
      // A zero means the tower did not turn on that step. It is in the array
      // to keep the positions honest and changes nothing, so it does not need
      // the simulation advanced for it.
      if (q[i] === 0) continue;
      advanceTo(sim, f + i);
      if (sim.dead) break;
      rotateSim(sim, q[i] / ROT_QUANTUM);
    }

    if (sim.dead) {
      state.dead = true;
      state.score = sim.score;
      return { accepted: false, newScore: state.score, reason: 'dead' };
    }
    state.score = sim.score;
    return { accepted: true, newScore: state.score };
  }

  // ── v1 plausibility path ───────────────────────────────────────────
  if (kind !== 'pass') return { accepted: true, newScore: state.score };

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

  if (state.lastPassT !== null) {
    if (tHint - state.lastPassT < MIN_PASS_INTERVAL_MS) {
      state.rejectCount++;
      // Advance the clock on the REFUSED event too — tracking only accepted
      // ones left it stale and doubled the gap for the next event, letting a
      // flood alternate reject/accept straight through the limit.
      state.lastPassT = tHint;
      return { accepted: true, newScore: state.score, reason: 'too_fast' };
    }
  } else {
    state.firstPassT = tHint;
  }

  if (state.passes >= MAX_PASSES) {
    state.dead = true;
    return { accepted: false, newScore: state.score, reason: 'hard_cap' };
  }

  if (state.firstPassT !== null && state.passes > 5) {
    const elapsedSec = Math.max(1, (tHint - state.firstPassT) / 1000);
    if (state.passes / elapsedSec > MAX_PASSES_PER_SEC) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'rate_cap' };
    }
  }

  state.score += 1;
  state.passes += 1;
  state.lastPassT = tHint;
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
    // when the player stopped touching the screen is recorded as dead — and so
    // a ball still falling is credited with the platforms it clears.
    //
    // Bounded by the SESSION's own maximum duration, not by a flat number of
    // seconds. Twist Fall's whole input is rotation, so a player who lines the
    // tower up once and then watches the ball fall emits a handful of events
    // and the REST of their run lives entirely in this tail. A flat 60-second
    // run-out would silently truncate any such run and credit them fewer
    // platforms than they watched break.
    const runOutFrames = Math.min(
      MAX_SIM_FRAMES,
      Math.max(60 * 60, Math.ceil((Number(state.maxDurationSecs) || 600) * 60)));
    // MAX_SIM_FRAMES bounds the run-out too, and cannot truncate an honest
    // run: the game's max_duration_secs is 600, so a full session's inputs
    // reach frame 36,000 and the run-out adds at most another 36,000 — exactly
    // the cap. Anything past that is not a run.
    let guard = 0;
    const capFrames = elapsedCap(state, 60);
    while (!sim.dead && guard < runOutFrames && sim.frames < MAX_SIM_FRAMES && sim.frames < capFrames) {
      stepSim(sim); guard++;
    }
    return {
      score: sim.score,
      gameOver: true,
      // The client's own number is NOT consulted here — the replay is the
      // score. `require_claimed_match` in submitSession is the gate that
      // compares them.
      suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
      debug: {
        mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame,
        deathCause: sim.deathCause, score: sim.score, dead: sim.dead,
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
  const hudCeiling  = state.passes * MAX_SCORE_DELTA_PER_EVENT + HUD_DROP_TOLERANCE;
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
    initSim, stepSim, rotateSim, advanceTo, makePlatform, platformRng, shuffleSeeded,
    seedToInt, angleInArc, angleInDangerSegment, norm,
    BALL_RADIUS, PLATFORM_CONTACT_OFFSET_Y, PLATFORM_OUTER_RADIUS_X,
    PLATFORM_SPACING, MIN_PLATFORM_SPACING, MAX_INPUTS, MAX_SIM_FRAMES, MAX_ROT_QUANTUM, MAX_BATCH, ROT_QUANTUM,
    DESIGN_WIDTH, DESIGN_HEIGHT,
  },
  _internal: { MIN_PASS_INTERVAL_MS, MAX_PASSES_PER_SEC, MAX_PASSES },
};
