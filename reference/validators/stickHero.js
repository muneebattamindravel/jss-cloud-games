'use strict';

/**
 * Stick Hero validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * There is no v1 path. Stick Hero was born on replay, so a trace without a v2
 * start marker is simply not a run (the session layer refuses markerless
 * traces platform-wide anyway) and scores zero.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed: platform N's gap and width
 *      are a pure function of (seed, N), never of a running stream;
 *   2. applies each hold pair { n, pressStep, releaseStep } on the fixed steps
 *      it landed on: the stick is (releaseStep - pressStep) x the platform's
 *      growth (4, 5 or 6 design units a step), integer arithmetic on both sides;
 *   3. applies each flip { n, step } on the step it landed on: a tap while the
 *      hero walks the stick hangs him underneath it (to grab a gem) or back on
 *      top;
 *   4. walks the same fixed steps as the client (stand, grow, fall, walk,
 *      scroll) and counts the score the landing, gem and fever rules produce.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below (constants and the sim functions) is carried WORD
 * FOR WORD in games/stick-hero/js/game.js. shared/tests/stickHeroParity.test.js
 * pulls every constant and every sim function out of both files and fails the
 * moment one copy is edited without the other. Edit both or neither; a
 * gameplay change is a trace version bump, never an edit in place.
 *
 * No trig anywhere on this path: the landing test is integer comparison of the
 * stick tip against platform edges, and the stick falling is a fixed number of
 * steps. Only +, -, x, /, floor, min, max and comparisons, which are exact in
 * every engine.
 */

// ==== RULES BLOCK: identical in games/stick-hero/js/game.js ====
const GROWTH_BASE = 4;
const GROWTH_RAMP_EVERY = 30;
const GROWTH_EXTRA_CAP = 2;
const FALL_STEPS = 18;
const WALK_PER_STEP = 5;
const SCROLL_PER_STEP = 9;
const MAX_HOLD_STEPS = 120;
const CRUMBLE_STEPS = 300;
const START_GUARD_STEPS = 27;
const HERO_INSET = 12;
const HERO_ANCHOR_X = 104;
const FIRST_PLATFORM_LEFT = 8;
const FIRST_PLATFORM_WIDTH = 96;
const GAP_MIN = 36;
const GAP_MAX_BASE = 150;
const GAP_MAX_CAP = 250;
const GAP_WIDEN_EVERY = 1;
const WIDTH_MIN_BASE = 40;
const WIDTH_MAX_BASE = 70;
const WIDTH_FLOOR = 24;
const WIDTH_SPREAD_MIN = 12;
const WIDTH_NARROW_EVERY = 2;
const MAX_REACH = 290;
const PERFECT_HALF = 4;
const PERFECT_STREAK_CAP = 3;
const GEM_FROM = 2;
const GEM_CHANCE = 45;
const GEM_EDGE = 22;
const GEM_REACH = 16;
const GEM_POINTS = 6;
const GEM_POINTS_V4 = 3;
const GEM_POINTS_V2 = 1;
const GEM_POINTS_V3 = 2;
const RULES_VERSION = 5;
const GEM_CENTRE_SPREAD = 10;
const GEM_CENTRE_SHARE = 85;
const FEVER_STREAK = 3;
const FEVER_PLATFORMS = 5;
const FEVER_MULT = 2;
const RNG_STRIDE = 0x9E3779B1;
const RNG_SALT = 0x5717C4E0;

function platformRng(seedInt, index) {
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

function growthFor(n) {
  return GROWTH_BASE + Math.min(GROWTH_EXTRA_CAP, Math.floor(n / GROWTH_RAMP_EVERY));
}

// Platform N is a pure function of (seed, N). All four draws happen on every
// index in this order, whichever branches use them, so no branch can shift the
// stream for another field.
// v3 (15 Sep 2026): a gem is worth 2, because flipping for one is hard. A v2
// trace, from a run already in progress when that deployed, keeps 1.
function gemPointsFor(version) {
  return version >= 5 ? GEM_POINTS : version >= 4 ? GEM_POINTS_V4 : version >= 3 ? GEM_POINTS_V3 : GEM_POINTS_V2;
}

function gemPlace(version, gap, roll) {
  const lo = GEM_EDGE, hi = gap - GEM_EDGE;
  if (version < 5) return lo + Math.floor(roll * (hi - lo + 1));
  const mid = Math.floor(gap / 2);
  const pct = roll * 100;
  if (pct < GEM_CENTRE_SHARE) {
    const k = Math.floor(pct * 2 * GEM_CENTRE_SPREAD / GEM_CENTRE_SHARE) - GEM_CENTRE_SPREAD + 1;
    return Math.max(lo, Math.min(hi, mid + k));
  }
  const r = (pct - GEM_CENTRE_SHARE) / (100 - GEM_CENTRE_SHARE);
  return lo + Math.floor(r * (hi - lo + 1));
}

function platformSpec(seedInt, n, version) {
  const rng = platformRng(seedInt, n);
  const gapRoll = rng();
  const widthRoll = rng();
  const gemRoll = rng();
  const gemPosRoll = rng();
  const gapHi = Math.min(GAP_MAX_CAP, GAP_MAX_BASE + Math.floor(n / GAP_WIDEN_EVERY));
  const narrow = Math.floor(n / WIDTH_NARROW_EVERY);
  const widthLo = Math.max(WIDTH_FLOOR, WIDTH_MIN_BASE - narrow);
  const widthHi = Math.max(widthLo + WIDTH_SPREAD_MIN, WIDTH_MAX_BASE - narrow);
  const width = widthLo + Math.floor(widthRoll * (widthHi - widthLo + 1));
  let gap = GAP_MIN + Math.floor(gapRoll * (gapHi - GAP_MIN + 1));
  if (gap + width > MAX_REACH) gap = MAX_REACH - width;
  const hasGem = n >= GEM_FROM && Math.floor(gemRoll * 100) < GEM_CHANCE && gap >= 2 * GEM_EDGE;
  const gem = hasGem ? gemPlace(version, gap, gemPosRoll) : 0;
  return { gap: gap, width: width, gem: gem };
}

function placeNext(sim) {
  const spec = platformSpec(sim.seedInt, sim.platformIndex + 1, sim.version);
  sim.nextLeft = sim.curLeft + sim.curWidth + spec.gap;
  sim.nextWidth = spec.width;
  sim.gemDist = spec.gem;
  sim.gemTaken = false;
}

function initSim(seedHex, version) {
  const sim = {
    version: version >= RULES_VERSION ? RULES_VERSION : version >= 4 ? 4 : version >= 3 ? 3 : 2,
    seedInt: seedToInt(seedHex),
    frames: 0,
    phase: 'idle',
    standSteps: 0,
    holdSteps: 0,
    pressStep: -1,
    growth: growthFor(0),
    stickLen: 0,
    fallStep: 0,
    heroX: FIRST_PLATFORM_LEFT + FIRST_PLATFORM_WIDTH - HERO_INSET,
    walkTarget: 0,
    landed: false,
    perfect: false,
    flipped: false,
    cameraX: FIRST_PLATFORM_LEFT + FIRST_PLATFORM_WIDTH - HERO_ANCHOR_X,
    cameraTarget: 0,
    platformIndex: 0,
    curLeft: FIRST_PLATFORM_LEFT,
    curWidth: FIRST_PLATFORM_WIDTH,
    nextLeft: 0,
    nextWidth: 0,
    gemDist: 0,
    gemTaken: false,
    gems: 0,
    score: 0,
    lastGain: 0,
    perfectStreak: 0,
    feverCharge: 0,
    feverLeft: 0,
    dead: false,
    deathFrame: null,
    deathCause: null,
  };
  placeNext(sim);
  return sim;
}

function killSim(sim, cause) {
  sim.dead = true;
  sim.deathFrame = sim.frames;
  sim.deathCause = cause;
  sim.phase = 'dead';
}

function stepSim(sim) {
  if (sim.dead) return;
  sim.frames++;
  if (sim.phase === 'idle' || sim.phase === 'grow') {
    sim.standSteps++;
    if (sim.standSteps >= CRUMBLE_STEPS) {
      killSim(sim, 'crumble');
      return;
    }
  }
  if (sim.phase === 'idle') return;
  if (sim.phase === 'grow') {
    sim.holdSteps++;
    sim.stickLen = sim.holdSteps * sim.growth;
    if (sim.holdSteps > MAX_HOLD_STEPS) killSim(sim, 'break');
    return;
  }
  if (sim.phase === 'fall') {
    sim.fallStep++;
    if (sim.fallStep >= FALL_STEPS) {
      const tip = sim.curLeft + sim.curWidth + sim.stickLen;
      const nextRight = sim.nextLeft + sim.nextWidth;
      const mid = sim.nextLeft + Math.floor(sim.nextWidth / 2);
      sim.landed = tip >= sim.nextLeft && tip <= nextRight;
      sim.perfect = sim.landed && tip >= mid - PERFECT_HALF && tip <= mid + PERFECT_HALF;
      sim.walkTarget = sim.landed ? nextRight - HERO_INSET : tip;
      sim.phase = 'walk';
    }
    return;
  }
  if (sim.phase === 'walk') {
    sim.heroX = Math.min(sim.heroX + WALK_PER_STEP, sim.walkTarget);
    if (sim.flipped && sim.gemDist > 0 && !sim.gemTaken) {
      const gemX = sim.curLeft + sim.curWidth + sim.gemDist;
      if (sim.heroX >= gemX - GEM_REACH && sim.heroX <= gemX + GEM_REACH) {
        const gemGain = gemPointsFor(sim.version) * (sim.feverLeft > 0 && sim.version < 5 ? FEVER_MULT : 1);
        sim.gemTaken = true;
        sim.gems++;
        sim.score += gemGain;
      }
    }
    if (sim.flipped && sim.heroX >= sim.nextLeft) {
      killSim(sim, 'flip');
      return;
    }
    if (sim.heroX >= sim.walkTarget) {
      if (!sim.landed) {
        killSim(sim, 'miss');
        return;
      }
      sim.perfectStreak = sim.perfect ? Math.min(sim.perfectStreak + 1, PERFECT_STREAK_CAP) : 0;
      let gained = 1 + (sim.perfect ? sim.perfectStreak : 0);
      if (sim.feverLeft > 0) {
        gained = gained * FEVER_MULT;
        sim.feverLeft--;
      } else if (sim.perfect) {
        sim.feverCharge++;
        if (sim.feverCharge >= FEVER_STREAK) {
          sim.feverLeft = FEVER_PLATFORMS;
          sim.feverCharge = 0;
        }
      } else {
        sim.feverCharge = 0;
      }
      sim.score += gained;
      sim.lastGain = gained;
      sim.cameraTarget = sim.nextLeft + sim.nextWidth - HERO_ANCHOR_X;
      sim.phase = 'scroll';
    }
    return;
  }
  if (sim.phase === 'scroll') {
    sim.cameraX = Math.min(sim.cameraX + SCROLL_PER_STEP, sim.cameraTarget);
    if (sim.cameraX >= sim.cameraTarget) {
      sim.platformIndex++;
      sim.curLeft = sim.nextLeft;
      sim.curWidth = sim.nextWidth;
      placeNext(sim);
      sim.growth = growthFor(sim.platformIndex);
      sim.stickLen = 0;
      sim.holdSteps = 0;
      sim.fallStep = 0;
      sim.standSteps = 0;
      sim.pressStep = -1;
      sim.landed = false;
      sim.perfect = false;
      sim.flipped = false;
      sim.phase = 'idle';
    }
  }
}

function pressSim(sim) {
  if (sim.dead || sim.phase !== 'idle' || sim.frames < START_GUARD_STEPS) return false;
  sim.phase = 'grow';
  sim.pressStep = sim.frames;
  sim.holdSteps = 0;
  sim.stickLen = 0;
  return true;
}

function releaseSim(sim) {
  if (sim.dead || sim.phase !== 'grow') return false;
  sim.stickLen = (sim.frames - sim.pressStep) * sim.growth;
  sim.phase = 'fall';
  sim.fallStep = 0;
  return true;
}

// A tap while walking flips the hero under the stick, or back on top. Only
// over the gap: on solid ground there is nothing to hang from.
function flipSim(sim) {
  if (sim.dead || sim.phase !== 'walk') return false;
  if (sim.heroX <= sim.curLeft + sim.curWidth || sim.heroX >= sim.nextLeft) return false;
  sim.flipped = !sim.flipped;
  return true;
}
// ==== END RULES BLOCK ====

// ── server-only bounds ──────────────────────────────────────────────────
//
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it. In practice every platform
// crumbles CRUMBLE_STEPS after the hero reaches it, so the bound is only ever
// reached by a trace that keeps landing for an hour.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A human holds at most once every ~1.3 s (grow, fall, walk and scroll all
// take steps) and flips at most a handful of times per platform. 40,000 is far
// past any real run and stops a huge trace turning one submit into a CPU sink.
// It REFUSES further inputs, it never zeroes.
const MAX_INPUTS = 40000;

function advanceTo(sim, step) {
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepSim(sim);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing would
// apply a malformed step as if it were real. Smash Down's adversarial suite
// found exactly that.
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
    if (Number(payload.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || (kind !== 'hold' && kind !== 'flip')) return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  if (kind === 'flip') return processFlip(state, payload);

  const { n, pressStep, releaseStep } = payload;
  if (!isStep(n) || !isStep(pressStep) || !isStep(releaseStep) || releaseStep < pressStep) {
    return reject(state, 'bad_hold');
  }

  const sim = state.sim;
  // Steps may REPEAT (a press can land on the step the previous walk ended on)
  // but never go BACKWARDS: a rewind would let an attacker re-run the same
  // window and keep the best outcome. The replay has already simulated up to
  // sim.frames, so anything earlier is refused, not guessed at.
  if (pressStep < sim.frames) return reject(state, 'frame_regressed');

  advanceTo(sim, pressStep);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  // The pair names the platform it was made on. A pair for any other platform
  // is out of order (a stolen or reshuffled trace) and is refused whole.
  if (n !== sim.platformIndex) return reject(state, 'out_of_order');
  // The client only records a press it applied, so a press the rules refuse
  // (not standing idle, or inside the start guard) is a forged one.
  if (!pressSim(sim)) return reject(state, 'not_idle');

  advanceTo(sim, releaseStep);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  releaseSim(sim);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// A flip names the platform it was made on and the step it landed on. Several
// flips may share a step (two taps between frames) and each toggles, exactly
// as in the client; the gem and wall checks only run inside a step, so a stack
// of flips on one step can never collect anything.
function processFlip(state, payload) {
  const { n, step } = payload;
  if (!isStep(n) || !isStep(step)) return reject(state, 'bad_flip');
  const sim = state.sim;
  if (step < sim.frames) return reject(state, 'frame_regressed');
  advanceTo(sim, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (n !== sim.platformIndex) return reject(state, 'out_of_order');
  // The client only records a flip it applied, so a refused one is forged.
  if (!flipSim(sim)) return reject(state, 'not_walking');
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
  // models (a miss, a snapped stick, hitting a wall upside down, or a platform
  // crumbling CRUMBLE_STEPS after arrival), so a run that stopped emitting is
  // always settled here within a few hundred steps.
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
      platformIndex: sim.platformIndex, gems: sim.gems,
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
    initSim, stepSim, pressSim, releaseSim, flipSim, advanceTo, platformSpec, platformRng,
    seedToInt, placeNext, growthFor, MAX_INPUTS, MAX_SIM_STEPS,
    GROWTH_BASE, GROWTH_RAMP_EVERY, GROWTH_EXTRA_CAP, FALL_STEPS, WALK_PER_STEP, SCROLL_PER_STEP,
    MAX_HOLD_STEPS, CRUMBLE_STEPS, START_GUARD_STEPS, HERO_INSET, HERO_ANCHOR_X, PERFECT_HALF,
    MAX_REACH, PERFECT_STREAK_CAP, GAP_MIN, WIDTH_FLOOR, GEM_FROM, GEM_EDGE,
    GEM_REACH, GEM_POINTS, GEM_POINTS_V4, GEM_CENTRE_SPREAD, GEM_CENTRE_SHARE, GEM_POINTS_V2, GEM_POINTS_V3, RULES_VERSION, gemPointsFor, FEVER_STREAK, FEVER_PLATFORMS, FEVER_MULT,
  },
};
