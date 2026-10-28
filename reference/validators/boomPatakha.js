'use strict';

const DMath = require('../dmath');

/**
 * Boom Patakha validator — plausibility model.
 *
 * Game mechanic: the player taps to shoot a projectile up at a rotating
 * ring of dots. Each hit awards points; a "perfect hit" starts a streak
 * that grows the per-shot reward. Perfect streak of N → `N + 1` points
 * on the next hit. Regular hit → 1 point. Miss (projectile passes the
 * dots) → game over. Bottom-spike collision → game over.
 *
 * Score dynamics:
 *   - Regular hit  → +1
 *   - Perfect hit  → +(streak + 1), streak grows unbounded during a run
 *
 * Cheats caught:
 *   - Shooting faster than physically possible (MIN_SHOT_INTERVAL_MS)
 *   - Submitting a high score without playing (no events → 0)
 *   - Modifying `score` client-side (server tracks HUD snapshots + caps
 *     per-event delta)
 *   - Impossible per-shot inflation (MAX_SCORE_DELTA_PER_EVENT bounds
 *     tampered scoreAfter growth to a realistic ceiling)
 *
 * MAX_SCORE_DELTA_PER_EVENT MUST stay ≥ the game's per-hit reward cap
 * (games/boom-patakha/js/game.js PERFECT_AWARD_CAP = 10). The game caps a
 * single perfect hit at 10 points, so 12 (cap + a small grace) is above
 * every legitimate single-event delta while still catching obvious
 * tampering. NOTE: an earlier value of 20 predated the game-side cap and
 * assumed the uncapped `perfectStreak + 1` reward "still counted" past 20
 * — it did not. An uncapped award of 21+ produced an out-of-bounds delta
 * that froze the HUD channel and silently truncated skilled runs (an
 * 860-point run finalized at 209). Capping the reward in-game fixed the
 * root cause; this bound just has to track that cap. If the game's cap is
 * ever raised, raise this in lockstep.
 */

const MIN_SHOT_INTERVAL_MS      = 200;   // shortest physically reasonable shot-to-shot cadence
const MAX_SHOTS_PER_SEC         = 5;
const MAX_SHOTS                 = 4000;  // hard cap over one session
const MAX_SCORE_DELTA_PER_EVENT = 12;
// Slack above what accepted events could have earned, so an event lost in
// flight is still recoverable without the channel being unbounded.
const HUD_DROP_TOLERANCE = 24;    // ≥ game's PERFECT_AWARD_CAP (10) + grace


// ── DETERMINISTIC REPLAY SIMULATOR (v2) ─────────────────────────────
// A byte-for-byte mirror of games/boom-patakha/js/game.js. Every constant,
// every formula and — critically — the ORDER of the seeded random draws must
// match it exactly. skyTower taught the discipline: parity is not asserted,
// it is TESTED, and boomPatakhaParity.test.js drives a faithful independent
// port of the client through hundreds of runs to prove it.
//
// The game is replayable because two things were fixed in the client:
//   * FIXED TIMESTEP — the sim advances in whole FIXED_STEP steps, so a
//     60Hz phone, a 120Hz phone and this file all compute the same physics.
//     (It also removed a real unfairness: the old dt was clamped at 0.033, so
//     a stuttering device got a slower, easier game.)
//   * SEEDED ROUNDS — target speed/height/entry/phase/direction came from
//     Math.random(), i.e. the server could not know where the target was.
//
// A shot carries the STEP its tap was consumed on, not the moment the
// projectile landed, so the server looks for the target where the player
// actually saw it.
const DESIGN_WIDTH        = 768;
const DESIGN_HEIGHT       = 1664;
const TOP_SPIKES_HEIGHT   = 64;
const BOTTOM_SPIKES_HEIGHT = 68;
const PLAYER_START_Y      = 1380;
const PLAYER_DESCENT_SPEED = 36;
const PLAYER_RADIUS       = 37.375;
const PERFECT_AWARD_CAP   = 10;
const FIXED_STEP          = 1 / 120;
const MOTION_AMPLITUDE    = 279;
const MOTION_CENTER_X     = DESIGN_WIDTH / 2;
// A run that reaches this many steps is not a run — an HOUR of simulation,
// the session's own lifetime (SESSION_LIFETIME_SECS). It used to be 12
// minutes and silently TRUNCATED anything longer: the step loop just stopped
// stepping, so a 25-minute run was scored as of minute 12 with no flag. Bounds
// server CPU per submit; the sim is a few dozen ns a step, so an hour is ms.
const MAX_SIM_STEPS       = 120 * 60 * 60;

function makeRng(seedHex) {
  let a = (typeof seedHex === 'string' && seedHex.length >= 8)
    ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
  return function rnd() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTargetSpeed(sim) {
  const minimumSpeed = 330;
  const maximumSpeed = Math.min(820, 760 + sim.stage * 10);
  const base = minimumSpeed + sim.rnd() * (maximumSpeed - minimumSpeed);
  const ease = Math.min(1, 0.45 + sim.score * 0.09);
  return base * ease;
}

// prepareNextRound() — the five seeded draws, IN ORDER. Reordering these
// silently desyncs every subsequent target.
function prepareNextRound(sim) {
  sim.stage = Math.floor(sim.score / 8) + 1;
  const t = sim.target;
  t.radius = Math.max(35.6, (30 - sim.stage * 0.45) * 2.197 * 0.81);
  t.destinationY = 560 + sim.rnd() * 510;          // draw 1
  t.entryStartY = -t.radius - 30;
  t.y = t.entryStartY;
  t.entryProgress = 0;
  t.entryDuration = 0.75 + sim.rnd() * 0.25;       // draw 2
  t.entering = true;
  t.speed = randomTargetSpeed(sim);                // draw 3
  t.motionAmplitude = MOTION_AMPLITUDE;
  t.motionPhase = sim.rnd() * Math.PI * 2;         // draw 4
  t.motionDirection = sim.rnd() > 0.5 ? 1 : -1;    // draw 5
  t.x = MOTION_CENTER_X + sim.M.sin(t.motionPhase) * t.motionAmplitude;
  sim.projectileActive = false;
  sim.playerY = PLAYER_START_Y;
  sim.projectileY = PLAYER_START_Y;
}

// `M` is the math the trace was PLAYED on: DMath for a v3 trace, the engine's
// own (DMath.NATIVE) for v2 — the target's swing, its entry easing and the hit
// test all go through sin/cos/hypot, which differ by an ulp between engines.
function initSim(seed, M = DMath.NATIVE) {
  const sim = {
    M,
    rnd: makeRng(seed),
    score: 0, stage: 1, perfectStreak: 0,
    playerY: PLAYER_START_Y, projectileY: PLAYER_START_Y,
    projectileActive: false, projectileVelocityY: 0,
    hasShotOnce: false, dead: false, steps: 0, shots: 0, hits: 0,
    target: {
      x: MOTION_CENTER_X, y: 780, destinationY: 780, entryStartY: -100,
      entryProgress: 1, entryDuration: 0.9, entering: false, radius: 49.828,
      speed: 0, motionAmplitude: MOTION_AMPLITUDE, motionPhase: 0, motionDirection: 1,
    },
  };
  prepareNextRound(sim);   // the first real target, exactly as startGame does
  return sim;
}

function circlesOverlap(M, ax, ay, ar, bx, by, br) {
  return M.hypot(ax - bx, ay - by) <= ar + br;
}

// The projectile can cross the target between two steps; the client sweeps the
// segment rather than only testing the endpoint, so we must too.
function sweptHit(sim, previousY) {
  const t = sim.target;
  const topY = Math.min(previousY, sim.projectileY);
  const bottomY = Math.max(previousY, sim.projectileY);
  const closestY = Math.max(topY, Math.min(t.y, bottomY));
  const distance = sim.M.hypot(MOTION_CENTER_X - t.x, closestY - t.y);
  return distance <= PLAYER_RADIUS + t.radius + 10;
}

function registerHit(sim) {
  // The shot is always fired straight up from the centre, so the player's x is
  // fixed at MOTION_CENTER_X — a "perfect" is purely how close the target was
  // to centre at the instant of impact.
  const perfect = Math.abs(MOTION_CENTER_X - sim.target.x) <= sim.target.radius * 0.18;
  let awarded = 1;
  if (perfect) {
    sim.perfectStreak += 1;
    awarded = Math.min(sim.perfectStreak + 1, PERFECT_AWARD_CAP);
  } else {
    sim.perfectStreak = 0;
  }
  sim.score += awarded;
  sim.hits += 1;
  prepareNextRound(sim);
  return awarded;
}

// Fire a shot, exactly as the client's shoot() does. A tap while a projectile
// is already in flight is IGNORED — the client gates on projectile.active, so
// a forger spamming taps gets no extra shots.
function fireShot(sim) {
  if (sim.dead || sim.projectileActive) return false;
  sim.projectileActive = true;
  sim.projectileY = sim.playerY;
  sim.projectileVelocityY = -1900 - Math.min(520, sim.stage * 32);
  sim.hasShotOnce = true;
  sim.shots += 1;
  return true;
}

// One FIXED_STEP of the world — the mirror of update(FIXED_STEP).
function stepSim(sim) {
  if (sim.dead) return;
  const t = sim.target;
  const dt = FIXED_STEP;

  if (t.motionAmplitude > 0) {
    const angularSpeed = t.speed / t.motionAmplitude;
    t.motionPhase += t.motionDirection * angularSpeed * dt;
    t.x = MOTION_CENTER_X + sim.M.sin(t.motionPhase) * t.motionAmplitude;
  }

  if (t.entering) {
    t.entryProgress = Math.min(1, t.entryProgress + dt / t.entryDuration);
    const eased = 0.5 - sim.M.cos(t.entryProgress * Math.PI) / 2;
    t.y = t.entryStartY + (t.destinationY - t.entryStartY) * eased;
    if (t.entryProgress >= 1) { t.y = t.destinationY; t.entering = false; }
  }

  if (!sim.projectileActive) {
    if (sim.hasShotOnce) sim.playerY += PLAYER_DESCENT_SPEED * dt;
    sim.projectileY = sim.playerY;
    // Sat still too long: the player sinks onto the bottom spikes.
    if (sim.playerY + PLAYER_RADIUS >= DESIGN_HEIGHT - BOTTOM_SPIKES_HEIGHT) {
      sim.dead = true;
    }
    return;
  }

  const previousY = sim.projectileY;
  sim.projectileY += sim.projectileVelocityY * dt;
  sim.playerY = sim.projectileY;

  if (circlesOverlap(sim.M, MOTION_CENTER_X, sim.projectileY, PLAYER_RADIUS, t.x, t.y, t.radius)
      || sweptHit(sim, previousY)) {
    registerHit(sim);
  } else if (sim.projectileY - PLAYER_RADIUS <= TOP_SPIKES_HEIGHT) {
    // Missed: the shot buries itself in the ceiling spikes.
    sim.projectileActive = false;
    sim.dead = true;
  }
}

// Advance the world to an absolute step index, firing a shot on arrival.
function advanceTo(sim, targetStep, fire) {
  while (!sim.dead && sim.steps < targetStep && sim.steps < MAX_SIM_STEPS) {
    stepSim(sim);
    sim.steps += 1;
  }
  if (sim.dead) return;
  if (fire) fireShot(sim);
}

function init({ seed, maxDurationSecs, range, gameMeta } = {}) {
  return {
    // 'v1' until a v2 start marker arrives, then 'sim' (deterministic replay).
    // v1 is the ORIGINAL plausibility model and is deliberately kept: during a
    // rollout the old client is still out there, and unlike Sky Tower's dead
    // legacy path this one scores those traces CORRECTLY — it is the model
    // they were played under. Close it with require_v2 once the frontend is
    // fully deployed.
    mode: 'v1',
    version: null,   // 2 or 3 once a start marker arrives: which Math the trace was played on
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    score: 0,
    dead: false,
    shots: 0,
    lastShotT: null,
    firstShotT: null,
    rejectCount: 0,
    maxDurationSecs: Number(maxDurationSecs) || 600,
    // HUD-snapshot self-correction (same pattern as skyTower.js).
    // Game emits payload.scoreAfter on every scoring shot. finalize()
    // returns max(accumulated, hudSnapshot).
    lastScoreAfter: 0,
    maxScoreAfter: 0,
  };
}

function processEvent(state, event) {
  if (!event || typeof event !== 'object') {
    return { accepted: true, newScore: currentScore(state) };
  }
  const { type, payload } = event;
  const kind0 = payload && payload.kind;

  // ── v2 start marker: switch to deterministic replay ──
  if (type === 'input' && kind0 === 'start' && payload && Number(payload.v) >= 2) {
    state.mode = 'sim';
    state.version = Number(payload.v) >= 3 ? 3 : 2;
    state.sim = initSim(state.seed, state.version >= 3 ? DMath : DMath.NATIVE);
    return { accepted: true, newScore: 0 };
  }

  if (state.mode === 'sim') {
    if (type !== 'input' || kind0 !== 'shoot') {
      return { accepted: true, newScore: state.sim.score };
    }
    const step = Number(payload && payload.step);
    if (!Number.isFinite(step) || step < 0) {
      return { accepted: true, newScore: state.sim.score, reason: 'bad_step' };
    }
    // Steps must not go backwards — a trace is a timeline, not a set.
    if (step < state.sim.steps) {
      return { accepted: true, newScore: state.sim.score, reason: 'step_regression' };
    }
    advanceTo(state.sim, step, true);
    return { accepted: true, newScore: state.sim.score };
  }

  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (type !== 'input') return { accepted: true, newScore: state.score };
  const kind = kind0;
  if (kind !== 'shoot') return { accepted: true, newScore: state.score };

  const tHint = Number(payload && payload.tHint);
  if (!Number.isFinite(tHint) || tHint < 0) {
    state.rejectCount++;
    return { accepted: true, newScore: state.score, reason: 'bad_thint' };
  }

  // HUD-snapshot recording — happens BEFORE rate/rejection logic so
  // even rate-capped shots contribute their scoreAfter. Per-event
  // delta cap MAX_SCORE_DELTA_PER_EVENT bounds tampered inflation.
  const scoreAfterRaw = Number(payload && payload.scoreAfter);
  if (Number.isFinite(scoreAfterRaw) && scoreAfterRaw >= 0) {
    const delta = scoreAfterRaw - state.lastScoreAfter;
    if (delta >= 0 && delta <= MAX_SCORE_DELTA_PER_EVENT) {
      state.lastScoreAfter = scoreAfterRaw;
      if (scoreAfterRaw > state.maxScoreAfter) state.maxScoreAfter = scoreAfterRaw;
    }
  }

  if (state.lastShotT !== null) {
    const gap = tHint - state.lastShotT;
    if (gap < MIN_SHOT_INTERVAL_MS) {
      state.rejectCount++;
      // Advance the clock on the REFUSED event too — it tracked only accepted
      // ones, so a reject left it stale and doubled the gap for the next event,
      // letting a flood alternate reject/accept straight through the limit.
      state.lastShotT = tHint;
      return { accepted: true, newScore: state.score, reason: 'too_fast' };
    }
  } else {
    state.firstShotT = tHint;
  }

  if (state.shots >= MAX_SHOTS) {
    state.dead = true;
    return { accepted: false, newScore: state.score, reason: 'hard_cap' };
  }

  if (state.firstShotT !== null && state.shots > 5) {
    const elapsedSec = Math.max(1, (tHint - state.firstShotT) / 1000);
    const ratePerSec = state.shots / elapsedSec;
    if (ratePerSec > MAX_SHOTS_PER_SEC) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'rate_cap' };
    }
  }

  // Accumulate a conservative baseline of +1 per accepted shot. The
  // HUD-snapshot delta is the source of truth for real perfect-streak
  // points — max(accumulated, hudSnapshot) in finalize picks whichever
  // is higher. If the client tampers with only accumulated (e.g. bumps
  // score directly), the +1 baseline caps their gain.
  state.score += 1;
  state.shots += 1;
  state.lastShotT = tHint;

  return { accepted: true, newScore: state.score };
}

function currentScore(state) {
  return state.mode === 'sim' && state.sim ? state.sim.score : state.score;
}

function finalize(state) {
  if (state.mode === 'sim' && state.sim) {
    const sim = state.sim;
    // RESOLVE THE LAST SHOT. Events are emitted when a shot LANDS, so the
    // final event leaves a projectile still in flight at the point the trace
    // ends. Stopping here would silently drop the last hit — worth 1 point on
    // a sloppy run and 10 on a perfect streak. Fly it out to its conclusion;
    // it is fully determined, so nothing is being trusted to the client.
    let guard = 0;
    while (!sim.dead && sim.projectileActive && guard < 5000) {
      stepSim(sim); sim.steps += 1; guard += 1;
    }
    return {
      score: sim.score,
      gameOver: sim.dead || sim.score > 0,
      suspicious: null,
      debug: {
        mode: 'sim', version: state.version, steps: sim.steps, shots: sim.shots, hits: sim.hits, dead: sim.dead,
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
  const hudCeiling  = state.shots * MAX_SCORE_DELTA_PER_EVENT + HUD_DROP_TOLERANCE;
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
  _limits: { MAX_SIM_STEPS, FPS: 120 },
  init, processEvent, finalize, simulate,
  _sim: {
    initSim, stepSim, advanceTo, fireShot, prepareNextRound, makeRng, DMath,
    FIXED_STEP, PLAYER_START_Y, PLAYER_RADIUS, DESIGN_WIDTH, DESIGN_HEIGHT,
    TOP_SPIKES_HEIGHT, BOTTOM_SPIKES_HEIGHT, PERFECT_AWARD_CAP,
    MOTION_AMPLITUDE, MOTION_CENTER_X, PLAYER_DESCENT_SPEED,
  },
  _internal: { MIN_SHOT_INTERVAL_MS, MAX_SHOTS_PER_SEC, MAX_SHOTS, MAX_SCORE_DELTA_PER_EVENT },
};
