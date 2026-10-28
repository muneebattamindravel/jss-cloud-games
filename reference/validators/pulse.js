'use strict';

const DMath = require('../dmath');

/**
 * Circle validator — plausibility model.
 *
 * Game mechanic: the player is a small circle that "jumps" on every
 * pointerdown. Each successful jump = +1 score. Failing to jump in
 * time (or jumping into a wall) ends the run. Very similar shape to
 * skyTower — a rate-limited +1-per-input game.
 *
 * Score dynamics:
 *   - Every accepted tap → +1
 *
 * Cheats caught:
 *   - Tapping faster than physically possible (MIN_TAP_INTERVAL_MS)
 *   - Submitting a high score without playing (no events → 0)
 *   - Modifying score client-side (server counts accepted events)
 *   - Per-event scoreAfter inflation (MAX_SCORE_DELTA_PER_EVENT = 1)
 */

const MIN_TAP_INTERVAL_MS       = 90;
// Kept only as an instantaneous floor. The real limit is SUSTAINED and comes
// from the game's own physics (games/pulse/js/game.js):
//
//   a tap sets vy = repeatJump (-3.9); gravity adds +0.185 per frame at a
//   fixed 60fps. Displacement over N frames between taps is
//        -3.9N + 0.0925*N*(N-1)
//   which is ZERO at N ~ 43.2 frames = 720ms. So ~1.39 taps/sec is the
//   neutral hover rate: tap faster than that and the ring climbs, and it dies
//   at the ceiling (`ring.y < ring.outerRy + 55` -> die()).
//
// So a sustained rate above ~1.4/sec is not skill, it is impossible — the
// player would be dead. 10/sec was seven times a hard physical maximum.
// 2.0 keeps ~44% headroom over that maximum.
// NO LONGER ENFORCED — superseded by the cumulative bound below. Kept only
// because tests and _internal reference it; do not reintroduce it as a check,
// a flat 10/sec is seven times what the ring's physics permit.
const MAX_TAPS_PER_SEC          = 10;
const MAX_SUSTAINED_TAPS_PER_SEC = 2.0;
// Bursts above the hover rate ARE legitimate — you can climb from the floor to
// the ceiling before you must slow down. The usable column is ~610px and a
// burst at the instantaneous ceiling closes it in about 32 taps; 60 is a
// generous allowance so no honest burst is ever clipped.
const BURST_ALLOWANCE_TAPS       = 60;
const MAX_TAPS                  = 3000;
const MAX_SCORE_DELTA_PER_EVENT = 1;
// Slack above what accepted events could have earned, so an event lost in
// flight is still recoverable without the channel being unbounded.
const HUD_DROP_TOLERANCE = 5;


// ── DETERMINISTIC REPLAY ────────────────────────────────────────────────
//
// Pulse is now replayed, not merely bounds-checked: the score is the number of
// taps that land before the ring dies, and we work that out by re-running the
// game. Every constant below is lifted from games/pulse/js/game.js and MUST
// stay identical to it — a change there without a change here silently
// mis-scores every honest player, which is the one failure a cash leaderboard
// cannot absorb. shared/tests/pulseParity.test.js drives the REAL game file
// and fails the moment these drift.
const BASE_W                    = 414;
const START_STRAIGHT_END_X      = 360;
const START_SPEED               = 0.35;
const BASE_SPEED                = 2.85;
const MAX_SPEED                 = 5.25;
const START_EASE_FRAMES         = 34;
const GRAVITY                   = 0.185;
const FIRST_JUMP                = -3.05;
const REPEAT_JUMP               = -3.9;
const RAIL_COLLISION_HALF_WIDTH = 7.5;
const TRACK_FALL_LIMIT          = 300;
const RING_X                    = 196;
const RING_INNER_RY             = 65;
// The world is translation-invariant: the ring starts on the line, and the
// rail, the fall limit and the track clamps are all measured FROM the track
// centre. So the server can pick any centre and reach the identical result —
// which is exactly what decoupling gameplay from the device's viewport bought
// us. 448 is the design centre (BASE_H / 2).
const TRACK_CENTER_Y            = 448;
const CHUNKS = [
  [[120, -66], [125, 0], [205, 0]],
  [[130, 72], [160, 0], [150, -28], [165, -86], [190, -86]],
  [[185, 0], [150, -62], [145, 35], [190, 0]],
  [[130, -55], [145, -55], [165, 20], [160, 90], [205, 90]],
  [[145, 0], [145, 55], [165, 55], [170, -28], [210, -28]],
];
// A run that reaches this many steps is not a run — an HOUR of simulation,
// the session's own lifetime (SESSION_LIFETIME_SECS). It used to be 12
// minutes and silently TRUNCATED anything longer: advanceTo just stopped
// stepping, so a 25-minute run was scored as of minute 12 with no flag. Bounds
// server CPU per submit; the sim is a few dozen ns a step, so an hour is ms.
const MAX_SIM_FRAMES = 60 * 60 * 60;

function makeRng(seedHex) {
  let a = (typeof seedHex === 'string' && seedHex.length >= 8)
    ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
  return function rnd() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The shuffled bag — identical draw order to the client, or the track differs.
function nextChunkIndex(w) {
  if (!w.bag.length) {
    w.bag = CHUNKS.map((_, i) => i);
    for (let i = w.bag.length - 1; i > 0; i--) {
      const j = Math.floor(w.rnd() * (i + 1));
      const t = w.bag[i]; w.bag[i] = w.bag[j]; w.bag[j] = t;
    }
  }
  return w.bag.shift();
}

function extendWorldTo(w, targetX) {
  if (!w.pts.length) return;
  let x = w.pts[w.pts.length - 1].x;
  while (x < targetX) {
    const chunk = CHUNKS[nextChunkIndex(w)];
    const baseY = TRACK_CENTER_Y + w.M.sin(w.chunkIndex * 0.9 + w.sinePhase) * 22;
    const minY = TRACK_CENTER_Y - 138;
    const maxY = TRACK_CENTER_Y + 142;
    for (const [dx, dy] of chunk) {
      x += dx;
      const y = Math.max(minY, Math.min(maxY, baseY + dy));
      w.pts.push({ x, y });
    }
    w.chunkIndex++;
  }
}

// `M` is the math the trace was PLAYED on: DMath for a v3 trace, the engine's
// own (DMath.NATIVE) for v2. See dmath.js: Math.sin and Math.pow differ by an
// ulp between engines, and the track's wobble and the start easing both run
// through them. A v2 trace stays on the engine's Math on purpose.
function buildWorld(seed, M = DMath.NATIVE) {
  const w = { pts: [], chunkIndex: 0, bag: [], rnd: makeRng(seed), sinePhase: 0, M };
  w.sinePhase = w.rnd() * Math.PI * 2;          // draw 1 — matches the client
  let x = -260;
  const y = TRACK_CENTER_Y;
  w.pts.push({ x, y });
  x = START_STRAIGHT_END_X;
  w.pts.push({ x, y });
  w.pts.push({ x: 500, y: TRACK_CENTER_Y - 8 });
  w.pts.push({ x: 650, y: TRACK_CENTER_Y - 28 });
  w.pts.push({ x: 810, y: TRACK_CENTER_Y - 58 });
  extendWorldTo(w, 5000);
  return w;
}

function pruneWorld(w, cameraX) {
  while (w.pts.length > 8 && w.pts[1].x < cameraX - 900) w.pts.shift();
}

function lineYAt(w, x) {
  const pts = w.pts;
  if (!pts.length) return TRACK_CENTER_Y;
  if (x > pts[pts.length - 1].x - 1200) extendWorldTo(w, x + 2400);
  if (x <= pts[0].x) return pts[0].y;
  let low = 0, high = pts.length - 2;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const a = pts[mid], b = pts[mid + 1];
    if (x < a.x) high = mid - 1;
    else if (x > b.x) low = mid + 1;
    else { const t = (x - a.x) / (b.x - a.x); return a.y + (b.y - a.y) * t; }
  }
  return pts[pts.length - 1].y;
}

function quadraticPoint(start, control, end, t) {
  const inv = 1 - t;
  return inv * inv * start + 2 * inv * t * control + t * t * end;
}

// COLLISION USES THE SMOOTHED LINE, not the raw points. Porting the raw
// polyline instead would put the rail a few pixels off exactly where the track
// bends hardest — which is where players actually die.
function visualLineYAt(w, x) {
  const pts = w.pts;
  if (pts.length < 3) return lineYAt(w, x);
  if (x > pts[pts.length - 1].x - 1200) extendWorldTo(w, x + 2400);
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], current = pts[i], next = pts[i + 1];
    const startX = (prev.x + current.x) * 0.5, startY = (prev.y + current.y) * 0.5;
    const endX = (current.x + next.x) * 0.5,  endY = (current.y + next.y) * 0.5;
    if (x < startX || x > endX) continue;
    let low = 0, high = 1;
    for (let step = 0; step < 12; step++) {
      const mid = (low + high) * 0.5;
      if (quadraticPoint(startX, current.x, endX, mid) < x) low = mid; else high = mid;
    }
    const t = (low + high) * 0.5;
    return quadraticPoint(startY, current.y, endY, t);
  }
  return lineYAt(w, x);
}

function initSim(seed, M = DMath.NATIVE) {
  const w = buildWorld(seed, M);
  return {
    w, M,
    frames: 0, cameraX: 0, speed: BASE_SPEED,
    ringY: lineYAt(w, 0 + RING_X), vy: 0,
    score: 0, dead: false, started: false, taps: 0,
  };
}

// One fixed 60Hz update — the same order as the client's update().
function stepSim(sim) {
  if (sim.dead || !sim.started) return;
  sim.frames++;
  sim.cameraX += sim.speed;
  if (sim.frames < START_EASE_FRAMES) {
    const t = sim.frames / START_EASE_FRAMES;
    const eased = 1 - sim.M.cube(1 - t);
    sim.speed = START_SPEED + (BASE_SPEED - START_SPEED) * eased;
  } else {
    sim.speed = Math.min(MAX_SPEED, sim.speed + 0.00055);
  }
  extendWorldTo(sim.w, sim.cameraX + BASE_W + 2400);
  pruneWorld(sim.w, sim.cameraX);

  sim.vy += GRAVITY;
  sim.ringY += sim.vy;

  const lineY = visualLineYAt(sim.w, sim.cameraX + RING_X);
  const lineTopY = lineY - RAIL_COLLISION_HALF_WIDTH;
  const lineBottomY = lineY + RAIL_COLLISION_HALF_WIDTH;
  const innerTopY = sim.ringY - RING_INNER_RY;
  const innerBottomY = sim.ringY + RING_INNER_RY;

  // The client only arms the rail after frame 24 (the start straight).
  if (sim.frames > 24 && (lineTopY <= innerTopY || lineBottomY >= innerBottomY)) {
    sim.dead = true;
    return;
  }
  if (Math.abs(sim.ringY - TRACK_CENTER_Y) > TRACK_FALL_LIMIT) sim.dead = true;
}

// A tap: the first one starts the run, the rest are jumps. Each scores +1,
// which is the whole scoring model — score IS the tap count.
function applyTap(sim) {
  if (sim.dead) return false;
  if (!sim.started) {
    sim.started = true;
    sim.score += 1;
    sim.taps += 1;
    sim.speed = START_SPEED;
    sim.vy = FIRST_JUMP;
    return true;
  }
  sim.score += 1;
  sim.taps += 1;
  sim.vy = REPEAT_JUMP;
  return true;
}

// Advance to an absolute frame index, then tap. A tap carries the frame the
// client consumed it on, so the server lands it on the same frame.
function advanceTo(sim, frame) {
  let guard = 0;
  while (!sim.dead && sim.frames < frame && guard < MAX_SIM_FRAMES) {
    stepSim(sim); guard++;
  }
}

function init({ seed, maxDurationSecs, range, gameMeta } = {}) {
  return {
    // 'v1' = the old plausibility model, kept for the length of the rollout so
    // a stale cached client is scored the way it was played rather than
    // zeroed. 'sim' = deterministic replay, entered by a v2 start marker.
    mode: 'v1',
    version: null,   // 2 or 3 once a start marker arrives: which Math the trace was played on
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    lastFrame: -1,
    score: 0,
    dead: false,
    taps: 0,
    lastTapT: null,
    firstTapT: null,
    rejectCount: 0,
    maxDurationSecs: Number(maxDurationSecs) || 600,
    lastScoreAfter: 0,
    maxScoreAfter: 0,
  };
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object') {
    return { accepted: true, newScore: state.score };
  }
  const { type, payload } = event;
  if (type !== 'input') return { accepted: true, newScore: state.score };
  const kind0 = payload && payload.kind;

  // The start marker opts this trace into the simulator. Without it we are
  // looking at a pre-replay client and must keep scoring it the old way.
  if (kind0 === 'start' && payload && Number(payload.v) >= 2) {
    state.mode = 'sim';
    state.version = Number(payload.v) >= 3 ? 3 : 2;
    state.sim = initSim(state.seed, state.version >= 3 ? DMath : DMath.NATIVE);
    return { accepted: true, newScore: state.score };
  }
  if (kind0 !== 'tap') return { accepted: true, newScore: state.score };

  // ── replay path ──────────────────────────────────────────────────
  if (state.mode === 'sim') {
    const frame = Number(payload && payload.frame);
    if (!Number.isFinite(frame) || frame < 0 || Math.floor(frame) !== frame) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'bad_frame' };
    }
    // Frames must move STRICTLY forward — a frame holds at most one scoring
    // tap. Allowing equal frames was a real hole: no simulation time passes
    // between two taps on the same frame, so the ring never falls, never hits
    // the rail, and every extra tap is a free point. A flood of 2000 taps on
    // frame 1 scored 2000. The client now refuses a second tap on a frame for
    // the same reason, so an honest trace never trips this.
    if (frame <= state.lastFrame) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'frame_not_advanced' };
    }
    state.lastFrame = frame;

    const sim = state.sim;
    advanceTo(sim, frame);
    if (sim.dead) {
      // The ring was already gone by this frame — every later tap is a tap on
      // a dead run and scores nothing.
      state.dead = true;
      state.score = sim.score;
      return { accepted: false, newScore: state.score, reason: 'dead' };
    }
    applyTap(sim);
    state.score = sim.score;
    state.taps = sim.taps;
    return { accepted: true, newScore: state.score };
  }

  const kind = kind0;

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

  if (state.lastTapT !== null) {
    const gap = tHint - state.lastTapT;
    if (gap < MIN_TAP_INTERVAL_MS) {
      state.rejectCount++;
      // Advance the clock on the REFUSED event too — it tracked only accepted
      // ones, so a reject left it stale and doubled the gap for the next event,
      // letting a flood alternate reject/accept straight through the limit.
      state.lastTapT = tHint;
      return { accepted: true, newScore: state.score, reason: 'too_fast' };
    }
  } else {
    state.firstTapT = tHint;
  }

  if (state.taps >= MAX_TAPS) {
    state.dead = true;
    return { accepted: false, newScore: state.score, reason: 'hard_cap' };
  }

  // CUMULATIVE bound, not an instantaneous rate. A flat rate cap has to be set
  // at the best burst a player can manage or it clips them, which leaves the
  // rest of the run wide open. Bounding the TOTAL against elapsed time allows
  // the burst while making it impossible to sustain — which is exactly what
  // the ring's physics do.
  if (state.firstTapT !== null && state.taps > 5) {
    const elapsedSec = Math.max(0, (tHint - state.firstTapT) / 1000);
    const allowed = MAX_SUSTAINED_TAPS_PER_SEC * elapsedSec + BURST_ALLOWANCE_TAPS;
    if (state.taps >= allowed) {
      state.rejectCount++;
      return { accepted: true, newScore: state.score, reason: 'rate_cap' };
    }
  }

  state.score += 1;
  state.taps += 1;
  state.lastTapT = tHint;

  return { accepted: true, newScore: state.score };
}

function finalize(state) {
  if (state.mode === 'sim' && state.sim) {
    const sim = state.sim;
    // Run the world out to the end so a run that was already doomed when the
    // player stopped tapping is recorded as dead.
    let guard = 0;
    while (!sim.dead && guard < 60 * 30) { stepSim(sim); guard++; }
    return {
      score: sim.score,
      gameOver: true,
      // The client's own number is NOT consulted here — the replay is the
      // score. `claimedMismatch` is left for submitSession's own gate.
      suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
      debug: {
        mode: 'sim', version: state.version, frames: sim.frames, taps: sim.taps,
        dead: sim.dead, accumulated: sim.score,
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
  const hudCeiling  = state.taps * MAX_SCORE_DELTA_PER_EVENT + HUD_DROP_TOLERANCE;
  const hudSnapshot = Math.min(state.maxScoreAfter || 0, hudCeiling);
  const finalScore = Math.max(accumulated, hudSnapshot);
  return {
    score: finalScore,
    gameOver: state.dead || finalScore > 0,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: { accumulated, hudSnapshot, diff: hudSnapshot - accumulated, mode: 'v1' },
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
  _sim: {
    initSim, stepSim, applyTap, advanceTo, buildWorld, visualLineYAt, lineYAt, DMath,
    TRACK_CENTER_Y, RING_X, CHUNKS, TRACK_FALL_LIMIT,
  },
  init, processEvent, finalize, simulate,
  _internal: { MIN_TAP_INTERVAL_MS, MAX_TAPS_PER_SEC, MAX_TAPS, MAX_SCORE_DELTA_PER_EVENT },
};
