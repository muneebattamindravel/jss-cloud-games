'use strict';

/**
 * Nishana validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Nishana was built on replay from day one, so there is no plausibility path:
 * a trace without a v2 start marker is not a run (the session layer refuses
 * markerless traces platform-wide anyway) and scores zero.
 *
 * The game: a painted roundel spins, a tap throws a knife into it, and a knife
 * that lands within KNIFE_GAP of one already stuck ends the run. Clearing a
 * stage's knives bursts the target and brings a trickier one.
 *
 * What the server does with a trace:
 *   1. rebuilds every stage from the session seed. Stage S takes thirteen
 *      draws that are a pure function of (seed, S), never of a running stream;
 *   2. applies each throw { n, step } on the fixed step it left the hand,
 *      before that step advances the target, exactly as the client does;
 *   3. runs the same fixed steps and resolves each knife on its own landing
 *      step, so where it lands is the target's own angle and nothing else.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/nishana/js/game.js.
 * shared/tests/nishanaParity.test.js pulls every constant and every rules
 * function out of both files and fails the moment one copy is edited without
 * the other. A gameplay change is a trace version bump, never an edit in place.
 *
 * Integer arithmetic only. The rules never compute an x or a y, so there is no
 * trig, no pow and no Math.random anywhere on the scoring path.
 */

// The block below is carried WORD FOR WORD in games/nishana/js/rules.js,
// two-space indent and all, so the two can be compared byte for byte.
  // ==== NISHANA RULES BEGIN ====
  const ANGLE_UNITS = 3600;          // a tenth of a degree per unit
  const HIT_AT = 0;                  // the one rim point every knife arrives at
  const KNIFE_GAP = 134;             // two knives closer than this collide
  const RULES_VERSION = 3;

  // Precision. A landing is judged against the GAP it lands in, so the same
  // throw is worth more as the wheel fills up and the gaps close.
  const TIGHT_GAP = 1200;            // a gap wider than this is not a test
  const PTS_STICK = 1;
  const PTS_TIGHT = 1;               // on top of PTS_STICK
  const PTS_PERFECT = 2;             // on top of PTS_STICK
  const FOCUS_NEED = 3;              // perfects in a row to light it
  const FOCUS_LANDINGS = 5;
  const FOCUS_MULT = 2;

  const GEM_HALF = 120;
  const GEM_POINTS = 5;
  const BIG_BONUS = 5;
  const BIG_EVERY = 5;
  const FLY_STEPS = 6;
  const THROW_COOLDOWN = 4;
  const STAGE_GAP_STEPS = 28;
  const START_GUARD_STEPS = 27;
  const STAGE_STEPS_START = 840;
  const STAGE_STEPS_DROP = 18;
  const STAGE_STEPS_FLOOR = 450;
  const SMOULDER_STEPS = 180;
  const SPIN_ACC = 4;
  const SLOW_SPIN = 16;
  const KNIVES_BASE = 6;
  const KNIVES_MAX = 11;
  const PRE_MAX = 4;
  const PRE_GAP = 320;
  const PRE_TRIES = 6;
  const GEM_TRIES = 2;
  const GEM_CLEAR = 200;
  const SPEED_BASE = 86;
  const SPEED_PER_STAGE = 7;
  const SPEED_JITTER = 12;
  const SKIN_COUNT = 6;
  const RNG_STRIDE = 0x9E3779B1;
  const RNG_SALT = 0x5F1E4C77;
  const SEED_MIX = 0x85EBCA6B;

  // Each pattern loops { target spin, steps } pairs. The target is angle units
  // per step BEFORE the stage's speed scale and direction; spin eases toward it
  // by SPIN_ACC a step, so a change of pace is felt rather than snapped.
  const PATTERNS = [
    [36, 220],
    [25, 110, 50, 110],
    [17, 76, 56, 150, 17, 55],
    [36, 130, -36, 130],
    [45, 37, 8, 20, 45, 37, 8, 20],
    [30, 270, -54, 92],
    [62, 50, -25, 110, 62, 50],
    [5, 45, 72, 65, 5, 45, -72, 65],
  ];
  const PATTERN_POOL = [3, 5, 6, 8];
  const PATTERN_TIER_FROM = [4, 9, 15];

  function stageRng(seedInt, index) {
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

  // Shortest way round the circle. ANGLE_UNITS is even, so the half is an exact
  // integer and this never leaves integer arithmetic.
  function arcDist(a, b) {
    let d = (a - b) % ANGLE_UNITS;
    if (d < 0) d += ANGLE_UNITS;
    return d > ANGLE_UNITS / 2 ? ANGLE_UNITS - d : d;
  }

  function withinAny(list, a, gap) {
    for (let i = 0; i < list.length; i++) {
      if (arcDist(list[i], a) < gap) return true;
    }
    return false;
  }

  // The gap the landing sits in: how far back to the knife behind it and how
  // far on to the knife ahead. With no knives at all it answers the whole
  // circle, which no precision tier can reward.
  function gapAround(stuck, rel) {
    let back = ANGLE_UNITS, fwd = ANGLE_UNITS;
    for (let i = 0; i < stuck.length; i++) {
      const b = ((rel - stuck[i]) % ANGLE_UNITS + ANGLE_UNITS) % ANGLE_UNITS;
      if (b < back) back = b;
      const f = ((stuck[i] - rel) % ANGLE_UNITS + ANGLE_UNITS) % ANGLE_UNITS;
      if (f < fwd) fwd = f;
    }
    return { back: back, fwd: fwd, g: stuck.length === 0 ? ANGLE_UNITS : back + fwd };
  }

  // 0 plain, 1 tight, 2 perfect. off2 is TWICE the distance from the gap's
  // midpoint, which keeps the whole test in integers.
  function tierOf(back, fwd, g) {
    if (g > TIGHT_GAP) return 0;
    const off2 = back > fwd ? back - fwd : fwd - back;
    if (off2 * 4 <= g) return 2;
    if (off2 * 2 <= g) return 1;
    return 0;
  }

  function isBigStage(stage) { return stage % BIG_EVERY === 0; }

  function knivesFor(stage) {
    return Math.min(KNIVES_MAX, KNIVES_BASE + Math.floor((stage - 1) * 2 / 5));
  }

  function preFor(stage, big) {
    const base = stage < 3 ? 0 : Math.min(PRE_MAX, Math.floor((stage - 3) / 3) + 1);
    return big ? Math.min(PRE_MAX + 1, base + 1) : base;
  }

  function stageStepsFor(stage) {
    return Math.max(STAGE_STEPS_FLOOR, STAGE_STEPS_START - (stage - 1) * STAGE_STEPS_DROP);
  }

  function tierForStage(stage) {
    return stage < PATTERN_TIER_FROM[0] ? 0 : stage < PATTERN_TIER_FROM[1] ? 1 : stage < PATTERN_TIER_FROM[2] ? 2 : 3;
  }

  // Stage S is a pure function of (seed, S). Thirteen draws are taken on EVERY
  // stage whatever the branches do with them, so the stream can never depend on
  // how many pre-stuck knives or gems a stage happens to want.
  function buildStage(sim, stage) {
    const rng = stageRng(sim.seedInt, stage);
    const patternRoll = rng();
    const dirRoll = rng();
    const speedRoll = rng();
    const preRolls = [];
    for (let i = 0; i < PRE_TRIES; i++) preRolls.push(rng() % ANGLE_UNITS);
    const gemCountRoll = rng();
    const gemRolls = [];
    for (let i = 0; i < GEM_TRIES; i++) gemRolls.push(rng() % ANGLE_UNITS);
    const skinRoll = rng();

    const big = isBigStage(stage);
    const tier = tierForStage(stage);
    const hi = PATTERN_POOL[tier];
    const lo = big && tier > 0 ? PATTERN_POOL[tier - 1] : 0;

    let pre = [];
    const wantPre = preFor(stage, big);
    for (let i = 0; i < PRE_TRIES && pre.length < wantPre; i++) {
      if (!withinAny(pre, preRolls[i], PRE_GAP)) pre = pre.concat([preRolls[i]]);
    }
    let gems = [];
    const wantGem = gemCountRoll % 3;
    for (let i = 0; i < GEM_TRIES && gems.length < wantGem; i++) {
      const a = gemRolls[i];
      if (!withinAny(pre, a, GEM_CLEAR) && !withinAny(gems, a, GEM_CLEAR)) gems = gems.concat([a]);
    }

    sim.stage = stage;
    sim.stuck = pre;
    sim.gems = gems;
    sim.air = [];
    sim.knivesLeft = knivesFor(stage);
    sim.stageKnives = sim.knivesLeft;
    sim.stageStartFrame = sim.frames;
    sim.stageEndsAt = sim.frames + stageStepsFor(stage);
    sim.patSeq = PATTERNS[lo + (patternRoll % (hi - lo))];
    sim.patPos = 0;
    sim.patLeft = sim.patSeq[1];
    sim.patDir = (dirRoll >>> 31) === 1 ? 1 : -1;
    sim.patScale = SPEED_BASE + (stage - 1) * SPEED_PER_STAGE + (speedRoll % SPEED_JITTER);
    sim.skin = skinRoll % SKIN_COUNT;
    sim.rot = (stage * 617) % ANGLE_UNITS;
    sim.spin = spinTargetOf(sim);
  }

  function spinTargetOf(sim) {
    return Math.floor(sim.patSeq[sim.patPos] * sim.patScale / 100) * sim.patDir;
  }

  function advanceSpin(sim) {
    const target = spinTargetOf(sim);
    const d = target - sim.spin;
    sim.spin += d > SPIN_ACC ? SPIN_ACC : d < -SPIN_ACC ? -SPIN_ACC : d;
    sim.rot = (sim.rot + sim.spin) % ANGLE_UNITS;
    if (sim.rot < 0) sim.rot += ANGLE_UNITS;
    sim.patLeft--;
    if (sim.patLeft <= 0) {
      sim.patPos = (sim.patPos + 2) % sim.patSeq.length;
      sim.patLeft = sim.patSeq[sim.patPos + 1];
    }
  }

  function killSim(sim, cause) {
    sim.dead = true;
    sim.deathFrame = sim.frames;
    sim.deathCause = cause;
  }

  // A knife arrives at HIT_AT, so where it lands ON THE WHEEL is purely the
  // wheel's angle at that step. No x, no y, no trig.
  function landKnife(sim) {
    const rel = ((HIT_AT - sim.rot) % ANGLE_UNITS + ANGLE_UNITS) % ANGLE_UNITS;
    const gap = gapAround(sim.stuck, rel);
    const margin = gap.back < gap.fwd ? gap.back : gap.fwd;
    sim.lastRel = rel;
    sim.lastMargin = sim.stuck.length > 0 ? margin : -1;

    // Detector material only: it never reaches a score. A planner either
    // maximises this margin or sits on a fixed one; a hand is wide and drifts.
    if (sim.stuck.length > 0) {
      sim.marginCount++;
      sim.marginSum += margin;
      sim.marginSq += margin * margin;
      if (margin < sim.marginMin) sim.marginMin = margin;
    }
    if (sim.stuck.length > 0 && margin < KNIFE_GAP) {
      sim.hitRel = rel;
      killSim(sim, 'knife');
      return;
    }

    sim.stuck = sim.stuck.concat([rel]);
    sim.stuckCount++;

    const tier = tierOf(gap.back, gap.fwd, gap.g);
    let gained = PTS_STICK;
    if (tier === 2) gained += PTS_PERFECT;
    else if (tier === 1) gained += PTS_TIGHT;

    let taken = -1;
    for (let i = 0; i < sim.gems.length; i++) {
      if (arcDist(rel, sim.gems[i]) <= GEM_HALF) { taken = i; break; }
    }
    if (taken >= 0) {
      sim.gems = sim.gems.slice(0, taken).concat(sim.gems.slice(taken + 1));
      sim.gemsTaken++;
      gained += GEM_POINTS;
    }

    const mult = sim.focusLeft > 0 ? FOCUS_MULT : 1;
    sim.score += gained * mult;
    sim.lastTier = tier;
    sim.lastGem = taken >= 0 ? 1 : 0;
    sim.lastGain = gained * mult;
    sim.lastMult = mult;
    sim.lastGap = gap.g;
    sim.lastLandFrame = sim.frames;
    if (sim.focusLeft > 0) sim.focusLeft--;

    // Focus is earned by three clean threads in a row and cannot be refreshed
    // while it runs, so it is a reward and never a runaway.
    if (tier === 2) {
      sim.perfects++;
      sim.perfectRun++;
      if (sim.focusLeft === 0 && sim.perfectRun >= FOCUS_NEED) {
        sim.focusLeft = FOCUS_LANDINGS;
        sim.focusStarted++;
        sim.perfectRun = 0;
        sim.focusAt = sim.frames;
      }
    } else {
      if (tier === 1) sim.tights++;
      sim.perfectRun = 0;
    }
  }

  function stepSim(sim) {
    if (sim.dead) return;
    if (sim.gapUntil >= 0) {
      if (sim.frames < sim.gapUntil) { advanceSpin(sim); sim.frames++; return; }
      sim.gapUntil = -1;
      buildStage(sim, sim.stage + 1);
    }
    advanceSpin(sim);
    if (sim.air.length > 0) {
      let rest = [];
      let landed = false;
      for (let i = 0; i < sim.air.length; i++) {
        if (sim.air[i].land === sim.frames) landed = true;
        else rest = rest.concat([sim.air[i]]);
      }
      if (landed) {
        sim.air = rest;
        landKnife(sim);
      }
    }
    if (!sim.dead && sim.gapUntil < 0 && sim.knivesLeft === 0 && sim.air.length === 0) {
      sim.stagesCleared++;
      sim.stepsUsed += sim.frames - sim.stageStartFrame;
      sim.stepsAllowed += stageStepsFor(sim.stage);
      if (isBigStage(sim.stage)) sim.score += BIG_BONUS * (sim.focusLeft > 0 ? FOCUS_MULT : 1);
      sim.gapUntil = sim.frames + STAGE_GAP_STEPS;
      sim.clearedAt = sim.frames;
    }
    if (!sim.dead && sim.gapUntil < 0 && sim.frames >= sim.stageEndsAt) killSim(sim, 'time');
    sim.frames++;
  }

  // A throw is applied BEFORE the step it names advances the wheel, exactly as
  // the client does. Refused throws record nothing on the client, so the replay
  // has nothing to apply; the server refuses the same ones without zeroing.
  function throwSim(sim) {
    if (sim.dead || sim.gapUntil >= 0) return false;
    if (sim.frames < START_GUARD_STEPS) return false;
    if (sim.knivesLeft <= 0) return false;
    if (sim.frames - sim.lastThrowStep < THROW_COOLDOWN) return false;
    if (sim.frames - sim.lastThrowStep === THROW_COOLDOWN) sim.firstFeasible++;
    const target = spinTargetOf(sim);
    if (sim.spin < SLOW_SPIN && sim.spin > -SLOW_SPIN) sim.throwsSlow++;
    if ((target > 0 && sim.spin < 0) || (target < 0 && sim.spin > 0)) sim.throwsTurning++;
    sim.lastThrowStep = sim.frames;
    sim.knivesLeft--;
    sim.air = sim.air.concat([{ land: sim.frames + FLY_STEPS, n: sim.thrown }]);
    sim.thrown++;
    return true;
  }

  function initSim(seedHex, version) {
    const sim = {
      version: version >= RULES_VERSION ? RULES_VERSION : version,
      seedInt: seedToInt(seedHex), frames: 0, score: 0, stage: 0,
      rot: 0, spin: 0,
      patSeq: PATTERNS[0], patPos: 0, patLeft: 0, patDir: 1, patScale: SPEED_BASE,
      stuck: [], gems: [], air: [],
      knivesLeft: 0, stageKnives: 0, stageStartFrame: 0, stageEndsAt: 0, gapUntil: -1, skin: 0,
      thrown: 0, stuckCount: 0, gemsTaken: 0, stagesCleared: 0,
      perfects: 0, tights: 0, perfectRun: 0, focusLeft: 0, focusStarted: 0, focusAt: -1,
      lastThrowStep: -1000000, lastRel: -1, lastMargin: -1, lastGain: 0, lastMult: 1,
      lastTier: 0, lastGem: 0, lastGap: 0, lastLandFrame: -1, clearedAt: -1, hitRel: -1,
      marginCount: 0, marginSum: 0, marginSq: 0, marginMin: ANGLE_UNITS,
      firstFeasible: 0, throwsSlow: 0, throwsTurning: 0, stepsUsed: 0, stepsAllowed: 0,
      dead: false, deathFrame: 0, deathCause: '',
    };
    buildStage(sim, 1);
    return sim;
  }
  // ==== NISHANA RULES END ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound, far above anything a hand can produce: the rules allow one
// throw per THROW_COOLDOWN steps, so an hour of play is at most this many. It
// REFUSES further inputs, it never zeroes a run, and it stops a huge trace
// becoming a CPU sink.
const MAX_INPUTS = Math.ceil(MAX_SIM_STEPS / THROW_COOLDOWN) + 64;

function advanceTo(sim, step) {
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepSim(sim);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing
// would apply a malformed step as if it were real.
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
    if (Number(payload.v) >= RULES_VERSION && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score.
  if (state.mode !== 'sim' || kind !== 'throw') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, step } = payload;
  if (!isStep(n) || !isStep(step)) return reject(state, 'bad_throw');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would let an attacker re-run the
  // same window and keep the best outcome. A repeat of the current step is
  // allowed through to throwSim, which refuses it on the cooldown.
  if (step < sim.frames) return reject(state, 'frame_regressed');

  advanceTo(sim, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  // The throw names its index in the run. Any other index is out of order (a
  // stolen or reshuffled trace) and is refused whole.
  if (n !== sim.thrown) return reject(state, 'out_of_order');
  // The client only records a throw it applied, so a refused one is forged.
  if (!throwSim(sim)) return reject(state, 'refused');
  state.score = sim.score;
  if (sim.dead) state.dead = true;
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

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const sim = state.sim;
  // Run the world out past the last input. The stage clock ends every run that
  // stopped throwing within stageStepsFor(stage) steps of the stage's start.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepSim(sim);
    guard++;
  }
  const mc = sim.marginCount;
  const mean = mc > 0 ? sim.marginSum / mc : null;
  const varr = mc > 0 ? Math.max(0, sim.marginSq / mc - mean * mean) : null;
  const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    // Raw material for the humanness fingerprint. RECORDED, never gated. A
    // planner either maximises the margin to the nearest knife or sits on a
    // fixed one; a hand is wide and tightens under pressure.
    debug: {
      mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame, deathCause: sim.deathCause,
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      stage: sim.stage, stagesCleared: sim.stagesCleared, thrown: sim.thrown,
      stuck: sim.stuckCount, gems: sim.gemsTaken,
      aimMean: round2(mean),
      aimSd: varr === null ? null : round2(Math.sqrt(varr)),
      aimMin: mc > 0 ? sim.marginMin : null,
      aimN: mc,
      firstFeasibleShare: sim.thrown > 0 ? round2(sim.firstFeasible / sim.thrown) : null,
      slowShare: sim.thrown > 0 ? round2(sim.throwsSlow / sim.thrown) : null,
      turningShare: sim.thrown > 0 ? round2(sim.throwsTurning / sim.thrown) : null,
      stepsUsed: sim.stepsUsed, stepsAllowed: sim.stepsAllowed,
      paceShare: sim.stepsAllowed > 0 ? round2(sim.stepsUsed / sim.stepsAllowed) : null,
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
    RULES_VERSION, PATTERNS, PATTERN_POOL, PATTERN_TIER_FROM,
    initSim, stepSim, throwSim, landKnife, killSim, buildStage, advanceSpin, spinTargetOf,
    stageRng, seedToInt, arcDist, withinAny, gapAround, tierOf, isBigStage, knivesFor, preFor,
    stageStepsFor, tierForStage,
    advanceTo, MAX_INPUTS, MAX_SIM_STEPS,
    ANGLE_UNITS, HIT_AT, KNIFE_GAP, GEM_HALF, GEM_POINTS, BIG_BONUS, BIG_EVERY,
    TIGHT_GAP, PTS_STICK, PTS_TIGHT, PTS_PERFECT, FOCUS_NEED, FOCUS_LANDINGS, FOCUS_MULT,
    FLY_STEPS, THROW_COOLDOWN, STAGE_GAP_STEPS, START_GUARD_STEPS,
    STAGE_STEPS_START, STAGE_STEPS_DROP, STAGE_STEPS_FLOOR, SMOULDER_STEPS,
    SPIN_ACC, SLOW_SPIN, KNIVES_BASE, KNIVES_MAX, PRE_MAX, PRE_GAP, PRE_TRIES,
    GEM_TRIES, GEM_CLEAR, SPEED_BASE, SPEED_PER_STAGE, SPEED_JITTER, SKIN_COUNT,
    RNG_STRIDE, RNG_SALT, SEED_MIX,
  },
};
