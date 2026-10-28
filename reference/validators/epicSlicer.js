'use strict';

const DMath = require('../dmath');

/**
 * Epic Slicer validator — SERVER-SIDE DETERMINISTIC REPLAY.
 *
 * The score is not taken from the client any more. The server re-runs the
 * whole game from the session seed — every wave, every fruit's spawn point,
 * velocity, size and type, every bomb roll, gravity, the edge bounces, the
 * missed-fruit life loss — and scores the swipe segments the player actually
 * made against the fruits that were actually there at that moment.
 *
 * Epic Slicer is the hardest of the converted games because a point is not an
 * input. Its emit is a swipe SEGMENT with geometry, and scoring is combo-based
 * (the Nth fruit of a swipe is worth its own value plus min(N-1, 4), so one
 * fruit is 1 and five are 15). Reproducing that needs the fruit population, the
 * flight paths, the segment/circle hit test AND the combo bookkeeping — an
 * off-by-one in the ORDER fruits are hit changes the score without changing
 * the fruit count.
 *
 * What this replaces: a bounds checker with "HUD-snapshot self-correction",
 * added in Session 44 after seven failed attempts to stop the client's ledger
 * and the server's drifting apart. That model was honest about its own limits
 * — it credited `max(accumulated, what the client said its score was)`, so it
 * could never UNDER-pay an honest player, and it bounded the per-event claim
 * so it could not be inflated without limit. But two ledgers that must agree
 * will always drift, and the way it resolved the drift was to believe the
 * client. Replay removes the second ledger entirely: there is one score and
 * the server computes it.
 *
 * ── EVERY CONSTANT BELOW IS LIFTED FROM games/epic-slicer/js/game.js ──
 * and MUST stay identical to it. A change there without a change here
 * silently mis-scores every honest player, which is the one failure a cash
 * leaderboard cannot absorb. shared/tests/epicSlicerParity.test.js drives the
 * REAL game file headlessly and fails the moment these drift.
 */

// ── constants, mirrored from the game ───────────────────────────────
// The v2/v3 field. v4's field width lives in the RULES block below.
const DESIGN_WIDTH  = 414;
const DESIGN_HEIGHT = 736;
const FIXED_DT_MS   = 1000 / 60;
const MAX_FRUITS    = 9;
const COMBO_BONUS_CAP = 4;
const BOMB_MIN_GAP_MS = 2600;
const START_LIVES   = 3;
// A TAP IS NOT A SLICE — the gesture's total path length, including the
// segment under test, before it may cut anything. Mirrors
// MIN_SWIPE_TRAVEL_PX in games/epic-slicer/js/game.js, where the measurement
// that set it is written out. Both halves must carry the same number, which is
// why it is a constant and not a config knob: the client cannot read
// platform_config, so a knob here would desync the two.
//
// The server can check this for itself because the client now emits EVERY
// segment of a gesture, not just the ones that scored — the approach to a
// fruit is exactly the part that scores nothing, and it is most of the travel.
const MIN_SWIPE_TRAVEL_PX = 16;
const FRUIT_TYPES = [
  { name: 'watermelon', points: 1 },
  { name: 'orange',     points: 1 },
  { name: 'apple',      points: 1 },
  { name: 'lemon',      points: 1 },
  { name: 'berry',      points: 2 },
];
// A run cannot outlive its session (games.max_duration_secs is 300), so this
// is only a guard against a pathological trace, never a real ceiling.
const MAX_SIM_STEPS = 60 * 400;

// ── RULES v2..v4 ── word for word in the game and the validator ────────
// Everything below, down to the END marker, is byte-identical in the game and
// in the validator; shared/tests/epicSlicerParity.test.js extracts the block
// from both files and requires an exact match.
//
// v4 (27 Sep 2026) is the FULL-WIDTH field. A phone in a browser gives a game
// a box about 0.65 wide to tall, and the old 414x736 field (0.5625) left a
// dead band down each side of every phone. The field is 480 wide now, the
// same 736 tall, so a 390x603 box fills edge to edge while the whole height,
// which every arc uses, stays on screen on every device (games/_shared/kj-fit.js).
// Launch points and the edge bounce spread over the new width. The arcs keep
// their height and their time in the air: gravity and the launch speeds are
// unchanged, except that the late-game speed boost stops at 1.2 instead of
// 1.5, so the highest possible fruit's hit zone stays inside the field's top
// edge (apex 52 design px down) instead of reaching 22 px above it, where a
// tall screen could reach it and a 0.65 phone could not.
//
// v2 and v3 keep the 414 field and the 1.5 cap: a run in progress when this
// deploys is scored by the rules it was played on.
const RULES_VERSION = 5;
// v5 (1 Oct 2026): a combo is earned by a swipe, not by holding a finger down.
// Once a gesture has made a combo (two or more fruit of one wave), it is SPENT:
// fruit of any later wave in the same gesture score their base points only,
// with no bonus and no new combo. Lifting the finger and swiping again makes
// the next combo. The bonus cap also rises from +4 to +5 (the Nth fruit is
// worth its value plus min(N-1, 5): 1, 3, 6, 10, 15, 21).
const COMBO_CAP_V5 = 5;
const COMBO_CAP_V4 = 4;
function comboCapFor(version) { return version >= 5 ? COMBO_CAP_V5 : COMBO_CAP_V4; }
const FIELD_H = 736;
const FIELD_W_V4 = 480;
const FIELD_W_V3 = 414;
const BOOST_CAP_V4 = 1.2;
const BOOST_CAP_V3 = 1.5;
const FRUIT_GRAVITY = 0.18;

function fieldWidthFor(version) { return version >= 4 ? FIELD_W_V4 : FIELD_W_V3; }
function boostCapFor(version) { return version >= 4 ? BOOST_CAP_V4 : BOOST_CAP_V3; }

// A fruit's launch. `draw(min, max)` is the SEEDED stream, and the order of
// its six calls is part of the protocol: target, start, drift factor, drift
// jitter, lift, size.
function launchFruit(W, cap, score, isBomb, draw) {
  const safeMargin = Math.max(58, W * 0.18);
  const targetX = draw(safeMargin, W - safeMargin);
  const x = draw(safeMargin, W - safeMargin);
  const y = FIELD_H + 45;
  const speedBoost = Math.min(score * 0.006, cap);
  const vx = (targetX - x) * draw(0.0018, 0.0028) + draw(-0.45, 0.45);
  const vy = -draw(FIELD_H * 0.0155, FIELD_H * 0.0205) - speedBoost;
  const size = isBomb ? draw(30, 40) : draw(31, 45);
  return { x, y, vx, vy, size };
}

// One fixed step of a fruit's flight, with the bounce off the field's sides.
function moveFruit(f, W) {
  f.vy += FRUIT_GRAVITY;
  f.x += f.vx;
  f.y += f.vy;
  const edgeLimit = Math.max(f.size + 12, W * 0.1);
  if (f.x < edgeLimit) {
    f.x = edgeLimit;
    f.vx = Math.abs(f.vx) * 0.55;
  } else if (f.x > W - edgeLimit) {
    f.x = W - edgeLimit;
    f.vx = -Math.abs(f.vx) * 0.55;
  }
}

// Below the field's bottom edge by its size and a margin: a life is lost.
function fruitFellOut(f) { return f.y > FIELD_H + f.size + 20; }

// Far enough out that it can never come back into play.
function fruitGone(f, W) { return f.y > FIELD_H + 120 || f.x < -140 || f.x > W + 140; }
// ── END RULES ──────────────────────────────────────────────────────────

// ── tunables ────────────────────────────────────────────────────────
// Source of truth in production is platform_config under
// `anticheat.epic-slicer.*`; anticheatSession.js resolves them at session
// start and passes them in as init({ tunables }). These are the cold-start /
// DB-down fallbacks per the GROUND RULE.
//
// The SIM bounds are backstops, not the defence. The defence is that a forged
// segment has to intersect a fruit that genuinely exists at that step, and
// there are at most nine on screen and each can be sliced once — so the score
// a forgery can reach is bounded by the spawner, not by how much it sends.
// These three only stop a client claiming a finger that teleports.
//
// The V1 bounds below it are the pre-replay plausibility model. They still run
// for traces with no v2 marker (a stale cached build mid-rollout) and go dead
// the moment `anticheat.epic-slicer.require_v2` is switched on.
const DEFAULTS = {
  // ── sim ──
  // CUMULATIVE finger travel against elapsed game time, with a burst
  // allowance. Same shape as Pulse's cumulative tap bound and for the same
  // reason: a flat per-instant cap has to be set at the best burst a human can
  // manage, which leaves the whole rest of the run wide open.
  //
  // There is deliberately NO per-segment length cap, and that is a measured
  // decision, not a shortcut. A segment's endpoints are in design space and
  // the field is letterboxed, so on a wide screen a player genuinely can start
  // a swipe outside the field and cross the whole of it in one pointermove.
  // The honest corpus below reaches 599 design px in a SINGLE segment — a cap
  // of 600 would already have been clipping people. Length only matters as
  // travel per unit of time, which is what this bounds.
  //
  // RE-DERIVED once the client began emitting every segment. It used to see
  // only the scoring ones and measured a peak of 392 design px/sec; with the
  // whole finger path in the trace the same corpus peaks at 2,070, because the
  // approach to each fruit is most of the travel and none of it scored. 4000
  // would have left 1.9x headroom over honest play — thin enough to start
  // clipping people, which is the failure this platform can least afford.
  //
  // Measured over 160 autopiloted runs across eight player styles (mean score
  // 151.9, best 487, mean duration 54.7s): peak SUSTAINED travel 2,070 design
  // px/sec. 10,000 is ~4.8x that — about 24 screen-widths per second held for
  // a whole run — so it cannot clip a hand. It still refuses the cheap forgery
  // by a wide margin: sweeping a full-field segment every step to harvest
  // every fruit the instant it becomes reachable needs ~50,000 px/sec.
  //
  // ANY CHANGE TO WHAT IS EMITTED CHANGES THIS NUMBER. Re-measure, do not
  // reason about it.
  maxTravelPxPerSec: 10000,
  // Segments accepted per 60Hz simulation step. THIS IS A WORK BOUND, NOT A
  // SCORING ONE: stacking segments on one step buys an attacker nothing,
  // because a fruit can be sliced exactly once and at most nine are on screen
  // — the adversarial suite pins that 400 segments on one step score exactly
  // what one segment scores.
  //
  // It was 12, set from an autopilot corpus that peaked at 2, and within an
  // hour of going live it was clipping 31% of REAL runs. The mechanism is not
  // a fast digitiser, which was the thing I reasoned about: it is a STALLED
  // FRAME. `stepIndex` only advances inside update(), so every pointermove
  // that queues while a frame is late lands on the SAME step. A budget Android
  // was measured at 33 on one step, Windows at 17, this machine's autopilot at
  // 2 — so the corpus could not see it and only production could.
  //
  // 300 is ~9x the worst observed. Set it high: being wrong LOW silently
  // under-pays players on slow devices, which is precisely who this hit.
  maxSegmentsPerStep: 300,
  // ── v1 (pre-replay traces only) ──
  maxSlicesPerSec: 10,
  maxFruitsPerSwipe: 4,
  maxPointsPerSwipe: 24,
  rateWindowMs: 1000,
  hardSliceCap: 4000,
};

// ── seeded RNG — mulberry32, bit-identical to the client ────────────
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

// ── the simulation ──────────────────────────────────────────────────

// `M`: DMath for a v3 trace, the engine's own for v2. The only transcendental
// on this replay path is the segment length in the finger-speed backstop; the
// client measures it as sqrt(dx*dx + dy*dy), which is exactly DMath.hypot and
// is NOT exactly Math.hypot (a scaling loop, implementation-defined rounding).
function initSim(seed, M = DMath.NATIVE, version = 3) {
  return {
    M,
    version,
    // The field this run is played on. v4 is 480 wide, v2/v3 414.
    W: fieldWidthFor(version),
    boostCap: boostCapFor(version),
    comboCap: comboCapFor(version),
    comboLocked: false,
    rnd: makeRng(seed),
    fruits: [],
    pendingSpawns: [],
    step: 0,
    simTimeMs: 0,
    spawnTimer: 0,
    waveId: 0,
    lastBombAt: -1e9,
    score: 0,
    lives: START_LIVES,
    dead: false,
    deathStep: null,
    // Combo state. Scoped to a swipe (reset on pointerdown) and to a wave
    // (slicing a fruit from a different wave than the running combo starts a
    // fresh one) — exactly as the client scopes it.
    comboWaveId: -1,
    swipeSlices: 0,
    // Path length of the current gesture. The client sends EVERY segment now,
    // including the ones that score nothing, precisely so this can be computed
    // here rather than taken on trust.
    swipeTravel: 0,
    // Bookkeeping the bounds read.
    segments: 0,
    travelPx: 0,
    slices: 0,
    gestures: 0,
    // Accuracy fingerprint accumulators — see applySegment.
    offsetSum: 0,
    offsetSqSum: 0,
    offsetN: 0,
  };
}

function srand(sim, min, max) { return sim.rnd() * (max - min) + min; }

/**
 * Mirrors spawnFruit(). THE DRAW ORDER IS LOAD-BEARING, including both
 * short-circuits: the bomb roll only happens when the slot is allowed AND the
 * cooldown has expired, and the fruit-type roll only happens when the slot did
 * not become a bomb. Evaluating either unconditionally desyncs the whole run
 * from that point on.
 */
function spawnFruit(sim, allowBomb, fruitWaveId) {
  if (sim.fruits.length >= MAX_FRUITS) return;

  const now = sim.simTimeMs;
  const bombChance = sim.score < 6 ? 0 : Math.min(0.055 + sim.score * 0.0011, 0.17);
  const isBomb = allowBomb
    && (now - sim.lastBombAt) >= BOMB_MIN_GAP_MS
    && sim.rnd() < bombChance;
  if (isBomb) sim.lastBombAt = now;
  const { x, y, vx, vy, size } =
    launchFruit(sim.W, sim.boostCap, sim.score, isBomb, (a, b) => srand(sim, a, b));
  const fruit = isBomb ? null : FRUIT_TYPES[Math.floor(sim.rnd() * FRUIT_TYPES.length)];
  // rotation + spin are drawn by the client and are pure decoration, but they
  // ADVANCE THE STREAM, so the server must draw them too.
  srand(sim, 0, Math.PI * 2);
  srand(sim, -0.08, 0.08);

  sim.fruits.push({
    x, y, vx, vy, size,
    sliced: false, missed: false, isBomb, fruit,
    waveId: fruitWaveId,
  });
}

function spawnWave(sim) {
  const maxWaveSize = sim.score < 10 ? 1 : sim.score < 24 ? 2 : 3;
  const count = 1 + Math.floor(sim.rnd() * maxWaveSize);
  const bombSlot = Math.floor(sim.rnd() * count);
  sim.waveId += 1;
  for (let i = 0; i < count; i++) {
    sim.pendingSpawns.push({ t: i * 120, allowBomb: i === bombSlot, waveId: sim.waveId });
  }
}

function loseLife(sim) {
  sim.lives -= 1;
  if (sim.lives <= 0) {
    sim.dead = true;
    sim.deathStep = sim.step;
  }
}

/** One fixed 60Hz update, in the client's exact order. */
function stepSim(sim) {
  if (sim.dead) return;
  const dt = FIXED_DT_MS;

  sim.step += 1;
  sim.simTimeMs = sim.step * FIXED_DT_MS;

  sim.spawnTimer += dt;
  const spawnDelay = Math.max(520, 1050 - sim.score * 3.2);
  if (sim.spawnTimer > spawnDelay) {
    sim.spawnTimer = 0;
    spawnWave(sim);
  }

  // Reverse iteration, matching the client — slot 0 of a wave carries t = 0
  // and therefore spawns in the SAME step the wave was scheduled.
  for (let i = sim.pendingSpawns.length - 1; i >= 0; i--) {
    sim.pendingSpawns[i].t -= dt;
    if (sim.pendingSpawns[i].t <= 0) {
      spawnFruit(sim, sim.pendingSpawns[i].allowBomb, sim.pendingSpawns[i].waveId);
      sim.pendingSpawns.splice(i, 1);
    }
  }

  for (let i = sim.fruits.length - 1; i >= 0; i--) {
    const f = sim.fruits[i];
    moveFruit(f, sim.W);

    // `!sim.dead` stands in for the client's `state === 'playing'`: once the
    // third life is gone the state flips inside this very loop and the
    // remaining fruits of the step no longer cost anything.
    if (!f.sliced && !sim.dead && !f.isBomb
        && fruitFellOut(f) && !f.missed) {
      f.missed = true;
      loseLife(sim);
    }

    if (f.sliced || fruitGone(f, sim.W)) {
      sim.fruits.splice(i, 1);
    }
  }
}

function advanceTo(sim, step) {
  let guard = 0;
  while (!sim.dead && sim.step < step && guard < MAX_SIM_STEPS) {
    stepSim(sim);
    guard++;
  }
}

function distanceSqPointToSegment(px, py, x1, y1, x2, y2) {
  const A = px - x1;
  const B = py - y1;
  const C = x2 - x1;
  const D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = lenSq !== 0 ? dot / lenSq : -1;
  param = Math.max(0, Math.min(1, param));
  const xx = x1 + param * C;
  const yy = y1 + param * D;
  const dx = px - xx;
  const dy = py - yy;
  return dx * dx + dy * dy;
}

/**
 * Mirrors checkSlice(). Returns what the segment scored.
 *
 * Two details that look like bugs and are not:
 *
 *  - A segment that hits a bomb keeps going. The client's forEach does not
 *    stop, and sliceFruit() has no state guard, so a swipe that crosses fruit
 *    → bomb → fruit credits BOTH fruits before the run ends. Returning early
 *    here would under-pay that swipe by up to 6 points.
 *  - Hitting a fruit from a different wave than the running combo RESETS the
 *    combo tally mid-segment, including `slicedThisMove`, but keeps
 *    `pointsThisMove` — those fruits were sliced and their bonus was earned.
 */
function applySegment(sim, x1, y1, x2, y2) {
  let slicedThisMove = 0;
  let bombThisMove = false;
  let pointsThisMove = 0;
  let comboIndex = sim.swipeSlices;
  let comboSpent = false;

  // A tap cuts nothing, and the server decides that for itself: it has the
  // whole finger path, so `swipeTravel` is computed here, never reported.
  // Applied to bombs too, exactly as the client applies it.
  if (sim.swipeTravel < MIN_SWIPE_TRAVEL_PX) {
    return { slicedThisMove: 0, bombThisMove: false, pointsThisMove: 0 };
  }

  for (const f of sim.fruits) {
    const hitRadius = f.size * (f.isBomb ? 0.9 : 1.05);
    if (f.sliced) continue;
    if (distanceSqPointToSegment(f.x, f.y, x1, y1, x2, y2) >= hitRadius * hitRadius) continue;

    let bonus = 0;
    if (!f.isBomb) {
      if (!sim.comboLocked && f.waveId !== sim.comboWaveId) {
        if (sim.version >= 5 && comboIndex >= 2) sim.comboLocked = true;
        else {
          sim.comboWaveId = f.waveId;
          comboIndex = 0;
          sim.swipeSlices = 0;
          slicedThisMove = 0;
        }
      }
      if (sim.comboLocked) {
        // A spent gesture: base points, no bonus, no tally.
        comboSpent = true;
      } else {
        comboIndex += 1;
        bonus = Math.min(comboIndex - 1, sim.comboCap);
      }
      pointsThisMove += ((f.fruit && f.fruit.points) || 1) + bonus;
    }

    f.sliced = true;
    if (f.isBomb) {
      bombThisMove = true;
      // Mirrored from the client for fidelity, and INERT: the run is over on
      // the next line, so nothing pending can ever spawn. Kept because it
      // costs nothing and the day the death semantics change it would matter;
      // said out loud because mutation testing correctly reports that deleting
      // it changes no result, and a reader deserves to know that is expected
      // rather than a hole in the suite.
      sim.pendingSpawns = [];
    } else {
      sim.score += (f.fruit.points + bonus);
      if (comboSpent) comboSpent = false;
      else slicedThisMove += 1;
    }
  }

  if (slicedThisMove > 0) sim.swipeSlices += slicedThisMove;
  if (bombThisMove) {
    sim.dead = true;
    if (sim.deathStep === null) sim.deathStep = sim.step;
  }
  return { slicedThisMove, bombThisMove, pointsThisMove };
}

// ── validator surface ───────────────────────────────────────────────

function init({ seed, maxDurationSecs, tunables, elapsedSecs } = {}) {
  const t = { ...DEFAULTS, ...(tunables || {}) };
  return {
    // 'v1' = the pre-replay plausibility model, kept for the length of the
    // rollout so a stale cached client is scored the way it was played rather
    // than zeroed. 'sim' = deterministic replay, entered by a v2 start marker.
    mode: 'v1',
    version: null,
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    tunables: t,
    maxDurationSecs: Number(maxDurationSecs) || 600,
    elapsedSecs: Number(elapsedSecs) || 0,
    rejectCount: 0,
    // ── sim bookkeeping ──
    lastStep: -1,
    segmentsThisStep: 0,
    lastSwipe: null,
    // ── v1 bookkeeping ──
    score: 0,
    slices: 0,
    lastSliceT: null,
    rateWindow: [],
    dead: false,
    bombHit: false,
    lastScoreAfter: 0,
    maxScoreAfter: 0,
  };
}

function processEvent(state, event) {
  if (!event || event.type !== 'input') return { accepted: true, newScore: state.score };
  const payload = event.payload || {};
  const kind = payload.kind;

  // The start marker opts this trace into the simulator. Without it we are
  // looking at a pre-replay client and must keep scoring it the old way.
  if (kind === 'start' && Number(payload.v) >= 2) {
    state.mode = 'sim';
    // v4 = the full-width field; v3 = v2 on DMath; v2 = the engine's Math.
    // The RULES follow the marker, never this server's build, so a run that
    // was in progress when a deploy landed is scored as it was played.
    const v = Number(payload.v);
    state.version = v >= 5 ? 5 : v >= 4 ? 4 : v >= 3 ? 3 : 2;
    state.sim = initSim(state.seed, state.version >= 3 ? DMath : DMath.NATIVE, state.version);
    return { accepted: true, newScore: 0 };
  }
  if (kind !== 'slice') return { accepted: true, newScore: state.score };

  return state.mode === 'sim' ? _simSlice(state, payload) : _v1Slice(state, payload);
}

function _simSlice(state, payload) {
  const sim = state.sim;
  const T = state.tunables;
  if (sim.dead) return { accepted: false, newScore: sim.score, reason: 'dead' };

  const step = Number(payload.step);
  const x1 = Number(payload.startX), y1 = Number(payload.startY);
  const x2 = Number(payload.endX),   y2 = Number(payload.endY);
  if (!Number.isFinite(step) || step < 0 || Math.floor(step) !== step
      || !Number.isFinite(x1) || !Number.isFinite(y1)
      || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    state.rejectCount++;
    return { accepted: false, newScore: sim.score, reason: 'malformed' };
  }

  // Steps move FORWARD, never back. Equal steps are legitimate here, unlike
  // Pulse: several pointermove reports genuinely arrive between two updates,
  // and a segment that hits nothing is not emitted, so consecutive scoring
  // segments frequently share a step. Stacking them buys nothing structural
  // either — a fruit can only be sliced once, and there are at most nine on
  // screen — but the count is capped anyway so a flood cannot be free.
  if (step < state.lastStep) {
    state.rejectCount++;
    return { accepted: false, newScore: sim.score, reason: 'step_regression' };
  }
  if (step === state.lastStep) {
    state.segmentsThisStep += 1;
    if (state.segmentsThisStep > T.maxSegmentsPerStep) {
      state.rejectCount++;
      return { accepted: false, newScore: sim.score, reason: 'segments_per_step' };
    }
  } else {
    state.segmentsThisStep = 1;
    state.lastStep = step;
  }

  // ── ONE GESTURE AT A TIME ───────────────────────────────────────
  // A new gesture clears the combo (the client does this on pointerdown) and
  // its id may only ever go FORWARD. Two gestures whose segments interleave
  // means two fingers were down at once, which the client refuses to produce —
  // so a trace containing it was not produced by the client. This is the
  // server's own enforcement of the single-pointer rule; the client's is a
  // suggestion, since a client can be modified and this cannot.
  const swipe = Number(payload.swipe);
  if (Number.isFinite(swipe) && state.lastSwipe !== null && swipe < state.lastSwipe) {
    state.rejectCount++;
    return { accepted: false, newScore: sim.score, reason: 'concurrent_gestures' };
  }
  if (swipe !== state.lastSwipe) {
    state.lastSwipe = swipe;
    sim.comboWaveId = -1;
    sim.comboLocked = false;
    sim.swipeSlices = 0;
    sim.swipeTravel = 0;
    sim.gestures += 1;
  }

  advanceTo(sim, step);
  // The run can END INSIDE that advance — three missed fruits while the
  // player was not swiping — and a segment must not be scored against a world
  // that has already stopped. The check at the top of this function only
  // catches events AFTER the one that walked into the death, so this is the
  // load-bearing one of the two.
  if (sim.dead) {
    return { accepted: false, newScore: sim.score, reason: 'dead' };
  }

  // ── finger-speed backstop ───────────────────────────────────────
  const len = sim.M.hypot(x2 - x1, y2 - y1);
  // The 1-second floor is not slack for the player — it is so the bound is
  // well defined near t = 0. Nothing can score before the first wave lands at
  // ~1.05s, so it cannot bind on an honest run; there used to be a separate
  // `travel_burst_px` knob here and mutation testing showed setting it to
  // ZERO changed nothing, which made it a config row that could not affect
  // any outcome.
  const elapsedSec = Math.max(1, (sim.step * FIXED_DT_MS) / 1000);
  if (sim.travelPx + len > T.maxTravelPxPerSec * elapsedSec) {
    state.rejectCount++;
    return { accepted: false, newScore: sim.score, reason: 'travel_rate' };
  }
  sim.travelPx += len;
  sim.swipeTravel += len;
  sim.segments += 1;

  const res = applySegment(sim, x1, y1, x2, y2);
  if (res.slicedThisMove > 0) {
    sim.slices += res.slicedThisMove;
    // FINGERPRINT, measured only — no gate, and deliberately so until there is
    // production data to set one from. A human's slice passes through a fruit
    // at a scatter of offsets from its centre; a vision bot aims at the centre
    // and hits it with a consistency no hand has. Recorded here so the
    // distribution starts accumulating the day this ships, rather than the day
    // someone needs it.
    for (const f of sim.fruits) {
      if (!f.sliced || f._m) continue;
      f._m = true;
      const d = Math.sqrt(distanceSqPointToSegment(f.x, f.y, x1, y1, x2, y2));
      sim.offsetSum += d / f.size;
      sim.offsetSqSum += (d / f.size) * (d / f.size);
      sim.offsetN += 1;
    }
  }
  return { accepted: true, newScore: sim.score };
}

// ── v1: the pre-replay plausibility model ───────────────────────────
// Unchanged in behaviour. It scores from what the client REPORTED, bounded
// per event and by a rolling rate cap. It is not good enough to be the model
// — that is why replay exists — but it is the right thing to score a trace
// emitted by a build that predates replay, and it goes dead the moment
// `require_v2` is switched on.
function _v1Slice(state, payload) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  const T = state.tunables;
  const tHint = Number(payload.tHint);
  const { startX, startY, endX, endY } = payload;
  if (!Number.isFinite(tHint) || tHint < 0
      || !Number.isFinite(Number(startX)) || !Number.isFinite(Number(endX))
      || !Number.isFinite(Number(startY)) || !Number.isFinite(Number(endY))) {
    state.rejectCount++;
    return { accepted: false, newScore: state.score, reason: 'malformed' };
  }

  const MAX_POINTS_PER_SWIPE = Number.isFinite(T.maxPointsPerSwipe)
    ? T.maxPointsPerSwipe : (T.maxFruitsPerSwipe * 3);
  const scoreAfterRaw = Number(payload.scoreAfter);
  if (Number.isFinite(scoreAfterRaw) && scoreAfterRaw >= 0) {
    const delta = scoreAfterRaw - state.lastScoreAfter;
    if (delta >= 0 && delta <= MAX_POINTS_PER_SWIPE) {
      state.lastScoreAfter = scoreAfterRaw;
      if (scoreAfterRaw > state.maxScoreAfter) state.maxScoreAfter = scoreAfterRaw;
    }
  }

  if (state.lastSliceT !== null && (tHint - state.lastSliceT) < -1000) {
    state.rejectCount++;
    return { accepted: false, newScore: state.score, reason: 'clock_backwards' };
  }
  if (state.slices >= T.hardSliceCap) {
    state.dead = true;
    return { accepted: false, newScore: state.score, reason: 'hard_cap' };
  }
  const refT = state.lastSliceT !== null ? Math.max(tHint, state.lastSliceT) : tHint;
  state.rateWindow = state.rateWindow.filter((t) => refT - t < T.rateWindowMs);
  if (state.rateWindow.length >= T.maxSlicesPerSec) {
    state.rejectCount++;
    return { accepted: false, newScore: state.score, reason: 'rate_cap' };
  }
  state.rateWindow.push(refT);

  let fruitsHit = Number(payload.fruitsHit);
  if (!Number.isFinite(fruitsHit) || fruitsHit < 0) fruitsHit = 0;
  fruitsHit = Math.min(Math.floor(fruitsHit), T.maxFruitsPerSwipe);

  let pointsHit = Number(payload.pointsHit);
  if (!Number.isFinite(pointsHit) || pointsHit < 0) pointsHit = fruitsHit;
  pointsHit = Math.min(Math.floor(pointsHit), MAX_POINTS_PER_SWIPE);

  state.score += pointsHit;
  state.slices += 1;
  state.lastSliceT = state.lastSliceT === null ? tHint : Math.max(tHint, state.lastSliceT);

  if (payload.bombHit === true) {
    state.bombHit = true;
    state.dead = true;
  }
  return { accepted: true, newScore: state.score };
}


// The replay's run-out is bounded by how long the session REALLY lasted. A
// run cannot hold more steps than real time allowed (the fixed step only ever
// drops time, never adds it), so an honest run always dies inside this bound;
// without it, a run the client ended by a rule the replay does not model spun
// on to the session maximum. Only the submit replay passes elapsedSecs; the
// live stream does not, and keeps the old bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode === 'sim' && state.sim) {
    const sim = state.sim;
    // Run the world out so a run that was already over when the player
    // stopped slicing is recorded as over — the score cannot change (only a
    // segment scores) but `gameOver` and the death step are what the parity
    // suite compares, and a score-only comparison is far too blunt to catch a
    // drifting physics constant.
    let guard = 0;
    const capSteps = elapsedCap(state, 60);
    while (!sim.dead && guard < MAX_SIM_STEPS && sim.step < capSteps) { stepSim(sim); guard++; }
    return {
      score: sim.score,
      gameOver: true,
      suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
      debug: {
        mode: 'sim',
        version: state.version,
        step: sim.step,
        deathStep: sim.deathStep,
        lives: sim.lives,
        slices: sim.slices,
        segments: sim.segments,
        gestures: sim.gestures,
        travelPx: Math.round(sim.travelPx),
        rejects: state.rejectCount,
        // Mean and spread of where the cut passed relative to each fruit's
        // centre, 0 = dead centre, 1 = the rim. Forensic only.
        aimMean: sim.offsetN ? +(sim.offsetSum / sim.offsetN).toFixed(4) : null,
        aimSd: sim.offsetN
          ? +Math.sqrt(Math.max(0, sim.offsetSqSum / sim.offsetN
              - (sim.offsetSum / sim.offsetN) ** 2)).toFixed(4)
          : null,
        aimN: sim.offsetN,
      },
    };
  }

  // v1. The HUD channel is bounded by what the ACCEPTED events could possibly
  // have earned — it used to be an unbounded max(), which is how a Sky Tower
  // run was forged on 4 Sep 2026; every validator built from that template
  // shared the flaw.
  const T = state.tunables || DEFAULTS;
  const perEvent = Number.isFinite(T.maxPointsPerSwipe)
    ? T.maxPointsPerSwipe : (T.maxFruitsPerSwipe * 3);
  const hudCeiling = state.slices * perEvent;
  const hudSnapshot = Math.min(state.maxScoreAfter || 0, hudCeiling);
  const finalScore = Math.max(state.score, hudSnapshot);
  return {
    score: finalScore,
    gameOver: state.dead,
    suspicious: state.rejectCount >= 5 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'v1',
      accumulated: state.score,
      hudSnapshot,
      diff: hudSnapshot - state.score,
    },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  init, processEvent, finalize, simulate,
  DEFAULTS,
  _sim: {
    initSim, stepSim, advanceTo, spawnFruit, spawnWave, applySegment, DMath,
    distanceSqPointToSegment, makeRng,
    DESIGN_WIDTH, DESIGN_HEIGHT, FIXED_DT_MS, COMBO_BONUS_CAP, FRUIT_TYPES,
    RULES_VERSION, COMBO_CAP_V5, COMBO_CAP_V4, comboCapFor, FIELD_W_V4, FIELD_W_V3, BOOST_CAP_V4, BOOST_CAP_V3,
    fieldWidthFor, boostCapFor, launchFruit, moveFruit, fruitFellOut, fruitGone,
  },
  _internal: { DEFAULTS },
};
