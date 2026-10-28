'use strict';

/**
 * Duet validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Duet (a partner's game, integrated on replay from day one) is scored from a
 * v2 or v3 trace: a start marker with v >= 2, then hold pairs. v3 (Sep 2026)
 * keeps the difficulty ramp climbing past level 10; a v2 trace replays on the
 * v2 ramp, so a run in flight when v3 shipped scores as it was played. There is no
 * plausibility path (the session layer refuses markerless traces platform-wide).
 *
 * The game: two orbs, red and blue, sit opposite each other on a ring. Holding
 * the left half of the screen turns the pair one way, the right half the other.
 * Shapes fall down three lanes, spinning; an orb that touches one ends the run.
 * Every shape that falls past the ring scores SCORE_PER_PASS.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed: shape N's type, lane and spin
 *      are a pure function of (seed, N) and the level it spawns at, and the
 *      level is itself a function of the seed alone (every shape falls at one
 *      shared speed, so when each one passes never depends on the player);
 *   2. applies each hold pair { n, dir, pressStep, releaseStep } on the fixed
 *      steps it landed on (dir -1 turns one way, +1 the other);
 *   3. walks the same 1/60 s steps as the client. The ring angle is an INTEGER
 *      out of ANGLE_UNITS. The only trig is shared/anticheat/dmath.js (an fdlibm
 *      port, the same bits in every engine), never the engine's Math.sin/cos;
 *   4. counts the score off its own pass counter.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/duet/js/game.js.
 * shared/tests/duetParity.test.js pulls every constant and every function out of
 * both files and fails the moment one copy is edited without the other, and
 * shared/tests/fixtures/duetGolden.json pins the rules themselves, because a
 * change made in BOTH files would pass a parity check. Edit both or neither; a
 * gameplay change is a trace version bump and a new golden corpus.
 *
 * ⚠ WHAT THIS CANNOT DO, stated plainly. The course is a pure function of a seed
 * that is on the player's device, so a bot that reads the seed and plans ahead
 * can survive for a very long time. Replay makes the server credit exactly what
 * the inputs produce; it cannot say whether a hand produced them. What bounds
 * that is the session hour, games.max_score_per_sec, and the humanness
 * fingerprint, whose raw material is finalize()'s debug block. It is RECORDED,
 * never gated.
 */

const DM = require('../dmath');

  // ==== RULES BLOCK: identical in games/duet/js/game.js ====
  //
  // Design space 400 x 650. The ring's angle is a whole number out of
  // ANGLE_UNITS (tenths of a degree), so turning is exact integer arithmetic; the
  // orb positions and the spinning shapes go through DM (games/_shared/dmath.js
  // in the browser, shared/anticheat/dmath.js on the server), which is the same
  // bits in every engine. The engine's own sin and cos never touch this path.
  const RULES_VERSION = 3;
  // The floor a trace must clear to be replayed at all. Stays fixed as
  // RULES_VERSION moves, so a run in flight when a rules change ships is never
  // orphaned by the check meant to let it keep replaying.
  const MIN_REPLAY_VERSION = 2;
  const ANGLE_UNITS = 3600;
  const TURN = 47;
  const RAD = Math.PI * 2 / ANGLE_UNITS;
  const QUARTER = Math.PI / 4;
  const ORBIT_X = 200;
  const ORBIT_Y = 520;
  const ORBIT_R = 85;
  const DOT_R = 12;
  const START_A = 0;
  const START_GUARD_STEPS = 27;
  const FIRST_SPAWN_STEP = 30;
  const SPAWN_Y = -50;
  const PASS_Y = 568;
  const DROP_Y = 730;
  const LANES = [114, 200, 286];
  const SCORE_PER_PASS = 10;
  // The ramp: every PASSES_PER_LEVEL shapes the fall gets faster, the shapes
  // come closer together and spin harder, and the rarer shapes get commoner.
  // In v2 all of it plateaus around level 10 (score 900), so a strong player
  // spent most of a long run at one flat difficulty. v3 keeps levels 0 to 10
  // exactly as they were and then keeps climbing, more slowly, through the
  // V3_* constants below: the spawn gap reaches its floor at level 24 (score
  // 2,160), the spin at level 55 (score 4,950), the fall speed at level 50
  // (score 4,500). The gap and the spin are what end long runs; the fall only
  // creeps, because a faster fall on its own made measured runs LONGER. The gap
  // floor is not free to tune: at 26 steps the course stops always having a way
  // through (shared/tests/duetParity.test.js, "every course has a way through").
  const PASSES_PER_LEVEL = 9;
  const SPEED_BASE = 3.1;
  const SPEED_STEP = 0.23;
  const SPEED_MAX = 5.2;
  const SPAWN_BASE = 84;
  const SPAWN_STEP = 6;
  const SPAWN_MIN = 44;
  const SPIN_BASE = 0.55;
  const SPIN_STEP = 0.12;
  const SPIN_MAX = 1.75;
  const SPIN_RANGE = 0.055;
  // v3 only: the second phase of the ramp, counted in levels past V3_FROM_LEVEL.
  // The fall speeds up by SPEED_V3_STEP a level to SPEED_V3_MAX, the spawn gap
  // loses a step every SPAWN_V3_EVERY level(s) down to SPAWN_V3_MIN, and the spin
  // grows by SPIN_V3_STEP a level to SPIN_V3_MAX. shared/tests/duetParity.test.js
  // proves every course still has a way through at the new maxima.
  const V3_FROM_LEVEL = 10;
  const SPEED_V3_STEP = 0.01;
  const SPEED_V3_MAX = 5.6;
  const SPAWN_V3_EVERY = 1;
  const SPAWN_V3_MIN = 30;
  const SPIN_V3_STEP = 0.05;
  const SPIN_V3_MAX = 4;
  const WEIGHT_BONUS_MAX = 4;
  // NOBODY PARKS. The course alone kills a ring that never turns, but only
  // probabilistically: measured over 10,800 seed and angle pairs the median
  // still ring lasts 221 steps and the worst 2,213, with a tail that never
  // quite ends. So a ring that has not turned for STILL_LIMIT steps ends the
  // run outright, and the client warns for the last few seconds of it. A tap
  // that turns nothing is not turning.
  const STILL_LIMIT = 900;

  // Every shape: [weight, parts]. A part is a ROUNDED RECTANGLE in the shape's
  // own frame, [x, y, w, h, corner radius, angle]; r = min(w, h) / 2 is a
  // capsule. The parts are fitted to the drawn art so that every point that
  // kills lies inside the art (shared/tests/duetRender.test.js checks it against
  // the shipped sprites): an orb dies on what it can see, never on empty space.
  const TYPES = [
    [8, [[0, 0, 74, 30, 15, 0]]],                                                    // bar
    [5, [[0, 0, 57, 57, 8, 0]]],                                                     // square
    [4, [[0, 0, 48, 30, 2, 0], [0, 0, 30, 46, 7, 0], [0, 0, 40, 40, 4, 0]]],         // cube
    [4, [[0, 0, 49, 49, 2, QUARTER], [0, 0, 14, 72, 7, 0]]],                         // diamond
    [4, [[-15, 0, 29, 82, 14.5, 0], [15, 0, 29, 82, 14.5, 0]]],                      // twin
    [3, [[0, 0, 82, 34, 11, 0], [0, 0, 34, 82, 11, 0]]],                             // plus
    [2, [[0, -23, 74, 30, 15, 0], [0, 23, 74, 30, 15, 0]]],                          // stack
    [3, [[0, 0, 64, 46, 10, 0]]],                                                    // soft rect
    [3, [[0, 0, 54, 53, 16, 0]]],                                                    // squircle
    [3, [[0, 0, 74, 31, 15.5, 0]]],                                                  // soft pill
    [3, [[0, 0, 54, 54, 9, QUARTER]]],                                               // soft diamond
    [3, [[0, 0, 78, 32, 12, 0], [0, 0, 32, 78, 12, 0]]],                             // soft plus
  ];

  const RNG_STRIDE = 0x9E3779B1;
  const RNG_SALT = 0x2D0E7A11;
  // A work bound, not a rule. Spawning is a pure function of the seed and the
  // step, so nothing an attacker sends can reach it; the parity suite records
  // the real high-water mark, which is a fraction of this.
  const MAX_OBS = 64;

  function obsRng(seedInt, index) {
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

  function wrapAng(v) {
    const m = v % ANGLE_UNITS;
    return m < 0 ? m + ANGLE_UNITS : m;
  }

  function levelOf(passed) {
    return Math.floor(passed / PASSES_PER_LEVEL);
  }

  function fallSpeed(level) {
    return Math.min(SPEED_BASE + level * SPEED_STEP, SPEED_MAX);
  }

  function spawnGap(level) {
    return Math.max(SPAWN_BASE - level * SPAWN_STEP, SPAWN_MIN);
  }

  function spinScale(level) {
    return Math.min(SPIN_BASE + level * SPIN_STEP, SPIN_MAX);
  }

  // The ramp a run actually plays. A v2 run (in flight when v3 shipped) keeps
  // the v2 curve for ever; a v3 run follows it to V3_FROM_LEVEL and then climbs on.
  function lateLevels(level, version) {
    return version >= 3 ? Math.max(0, level - V3_FROM_LEVEL) : 0;
  }

  function speedFor(level, version) {
    const x = lateLevels(level, version);
    return x > 0 ? Math.min(SPEED_MAX + x * SPEED_V3_STEP, SPEED_V3_MAX) : fallSpeed(level);
  }

  function gapFor(level, version) {
    const x = lateLevels(level, version);
    return x > 0 ? Math.max(SPAWN_MIN - Math.floor(x / SPAWN_V3_EVERY), SPAWN_V3_MIN) : spawnGap(level);
  }

  function spinFor(level, version) {
    const x = lateLevels(level, version);
    return x > 0 ? Math.min(SPIN_MAX + x * SPIN_V3_STEP, SPIN_V3_MAX) : spinScale(level);
  }

  // Shape N is a pure function of (seed, N) and the level it spawns at. All
  // three draws happen on every index, in this order, whatever they pick.
  function obstacleSpec(seedInt, n, level, version) {
    const rng = obsRng(seedInt, n);
    const typeRoll = rng();
    const laneRoll = rng();
    const spinRoll = rng();
    const bonus = Math.min(level, WEIGHT_BONUS_MAX);
    let total = 0;
    for (let i = 0; i < TYPES.length; i++) total += TYPES[i][0] + bonus;
    let w = typeRoll * total;
    let type = 0;
    while (type < TYPES.length - 1 && w > TYPES[type][0] + bonus) {
      w -= TYPES[type][0] + bonus;
      type++;
    }
    const lane = Math.floor(laneRoll * LANES.length);
    const spin = (spinRoll - 0.5) * SPIN_RANGE * spinFor(level, version);
    return { type: type, lane: lane, spin: spin };
  }

  // Where the two orbs are. Red sits at the angle, blue opposite it.
  function dotsOf(a) {
    const t = a * RAD;
    const ox = ORBIT_R * DM.cos(t);
    const oy = ORBIT_R * DM.sin(t);
    return [ORBIT_X + ox, ORBIT_Y + oy, ORBIT_X - ox, ORBIT_Y - oy];
  }

  // Which orbs a shape touches: bit 1 red, bit 2 blue. A part is the rounded
  // rectangle it describes: the orb touches it when its centre is closer than
  // DOT_R + r to the part's inner rectangle.
  function hitMask(o, d) {
    const parts = TYPES[o.type][1];
    const c = DM.cos(o.ang);
    const s = DM.sin(o.ang);
    let mask = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const px = o.x + p[0] * c - p[1] * s;
      const py = o.y + p[0] * s + p[1] * c;
      let pc = c;
      let ps = s;
      if (p[5] !== 0) { pc = DM.cos(o.ang + p[5]); ps = DM.sin(o.ang + p[5]); }
      const hw = p[2] / 2 - p[4];
      const hh = p[3] / 2 - p[4];
      const rr = DOT_R + p[4];
      for (let k = 0; k < 2; k++) {
        const dx = d[k * 2] - px;
        const dy = d[k * 2 + 1] - py;
        const lx = dx * pc + dy * ps;
        const ly = dy * pc - dx * ps;
        const qx = lx - Math.max(-hw, Math.min(lx, hw));
        const qy = ly - Math.max(-hh, Math.min(ly, hh));
        if (qx * qx + qy * qy < rr * rr) mask |= (1 << k);
      }
    }
    return mask;
  }

  function spawnObstacle(sim, level) {
    const n = sim.spawned;
    const spec = obstacleSpec(sim.seedInt, n, level, sim.version);
    if (sim.obs.length < MAX_OBS) {
      sim.obs = sim.obs.concat([{ n: n, type: spec.type, x: LANES[spec.lane], y: SPAWN_Y, ang: 0, spin: spec.spin, passed: false }]);
    }
    sim.spawned = n + 1;
    sim.nextSpawn = sim.frames + gapFor(level, sim.version);
  }

  function initSim(seedHex, version) {
    return {
      version: (function (v) { return v >= RULES_VERSION ? RULES_VERSION : (v >= MIN_REPLAY_VERSION ? v : 1); })(Number(version) || 0),
      seedInt: seedToInt(seedHex),
      frames: 0,
      a: START_A,
      holdDir: 0,
      holdN: 0,
      pressStep: -1,
      still: 0,
      obs: [],
      spawned: 0,
      nextSpawn: FIRST_SPAWN_STEP,
      passed: 0,
      score: 0,
      dead: false,
      deathFrame: null,
      deathCause: null,
      deathMask: 0,
    };
  }

  function killSim(sim, cause, mask) {
    sim.dead = true;
    sim.deathFrame = sim.frames;
    sim.deathCause = cause;
    sim.deathMask = mask;
  }

  function stepSim(sim) {
    if (sim.dead) return;
    sim.frames++;

    // 1. Turn. The side held is the ACTION and the only thing the rules see;
    //    which half of the screen produced it never reaches here.
    if (sim.holdDir !== 0) {
      sim.a = wrapAng(sim.a + sim.holdDir * TURN);
      sim.still = 0;
    } else {
      sim.still++;
    }

    // 2. The course. The level is read once, before anything moves, so every
    //    shape on the board falls at the same speed this step.
    const level = levelOf(sim.passed);
    const v = speedFor(level, sim.version);
    if (sim.frames >= sim.nextSpawn) spawnObstacle(sim, level);

    // 3. Everything falls and spins. The list is REPLACED, never edited in
    //    place: a pilot planning on a shallow copy must not be able to write
    //    into the real run. A shape below DROP_Y is gone.
    const moved = [];
    for (let i = 0; i < sim.obs.length; i++) {
      const o = sim.obs[i];
      const y = o.y + v;
      if (y <= DROP_Y) moved.push({ n: o.n, type: o.type, x: o.x, y: y, ang: o.ang + o.spin, spin: o.spin, passed: o.passed });
    }
    sim.obs = moved;

    // 4. Death: either orb inside any shape. Checked before scoring, so the
    //    step that kills never also scores.
    const d = dotsOf(sim.a);
    let mask = 0;
    for (let i = 0; i < sim.obs.length; i++) mask |= hitMask(sim.obs[i], d);
    if (mask !== 0) {
      killSim(sim, 'hit', mask);
      return;
    }
    if (sim.still >= STILL_LIMIT) {
      killSim(sim, 'still', 0);
      return;
    }

    // 5. A shape whose centre has fallen past PASS_Y scores, once.
    let passed = sim.passed;
    let changed = false;
    const next = [];
    for (let i = 0; i < sim.obs.length; i++) {
      const o = sim.obs[i];
      if (!o.passed && o.y > PASS_Y) {
        passed++;
        changed = true;
        next.push({ n: o.n, type: o.type, x: o.x, y: o.y, ang: o.ang, spin: o.spin, passed: true });
      } else {
        next.push(o);
      }
    }
    if (changed) sim.obs = next;
    sim.passed = passed;
    sim.score = passed * SCORE_PER_PASS;
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
// A hand cannot change side more than a few times a second. 60,000 pairs is
// ~17 a second for an hour, far past any real run, and stops a huge trace
// turning one submit into a CPU sink. It REFUSES further inputs, never zeroes.
const MAX_INPUTS = 60000;

// ── the raw material the bot detector reads (recorded, never gated) ─────
// A hand and a planner differ in HOW they get through, not in what they score:
//  - clear*: the closest either orb came to each shape before it passed, in
//    design pixels. A planner leaves an even, comfortable margin; a hand's is
//    scattered and sometimes a hair.
//  - hold*: how long each hold lasted, in steps. A planner's holds are exactly
//    as long as the turn needs; a hand overshoots and corrects.
//  - reversalsPerPass / turnPerPass: a hand wanders.
//  - leadMean: steps between the last press before a shape passed and the pass.
//    A planner moves early; a hand reacts late.
function newStats() {
  return {
    turn: 0, holdSteps: 0, reversals: 0, lastDir: 0, lastPress: -1,
    holdN: 0, holdSum: 0, holdSq: 0, holdMin: Infinity,
    clearN: 0, clearSum: 0, clearSq: 0, clearMin: Infinity, tight: 0,
    leadN: 0, leadSum: 0,
    near: new Map(),
  };
}
function mean(sum, n) { return n > 0 ? sum / n : null; }
function sd(sum, sq, n) { return n > 1 ? Math.sqrt(Math.max(0, sq / n - (sum / n) * (sum / n))) : null; }
function fin(v) { return Number.isFinite(v) ? v : null; }

// How far the nearer orb is from a shape's surface, in design pixels (negative
// inside it). Reads the run, writes nothing; deliberately OUTSIDE the rules.
function clearance(o, d) {
  const parts = TYPES[o.type][1];
  const c = DM.cos(o.ang);
  const s = DM.sin(o.ang);
  let best = Infinity;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const px = o.x + p[0] * c - p[1] * s;
    const py = o.y + p[0] * s + p[1] * c;
    const pc = p[5] !== 0 ? DM.cos(o.ang + p[5]) : c;
    const ps = p[5] !== 0 ? DM.sin(o.ang + p[5]) : s;
    const hw = p[2] / 2 - p[4];
    const hh = p[3] / 2 - p[4];
    for (let k = 0; k < 2; k++) {
      const dx = d[k * 2] - px;
      const dy = d[k * 2 + 1] - py;
      const lx = dx * pc + dy * ps;
      const ly = dy * pc - dx * ps;
      const qx = lx - Math.max(-hw, Math.min(lx, hw));
      const qy = ly - Math.max(-hh, Math.min(ly, hh));
      const g = Math.sqrt(qx * qx + qy * qy) - DOT_R - p[4];
      if (g < best) best = g;
    }
  }
  return best;
}
// Only a shape inside this band of the ring can be close to an orb.
const NEAR_BAND = ORBIT_R + DOT_R + 60;

// One step, watched. The accounting reads the run and never writes it.
function stepWatch(state) {
  const sim = state.sim;
  const st = state.stats;
  const a0 = sim.a;
  stepSim(sim);
  let d = sim.a - a0;
  if (d > ANGLE_UNITS / 2) d -= ANGLE_UNITS;
  if (d < -ANGLE_UNITS / 2) d += ANGLE_UNITS;
  st.turn += Math.abs(d);
  if (sim.holdDir !== 0) st.holdSteps++;
  if (sim.dead) return;
  const dots = dotsOf(sim.a);
  for (let i = 0; i < sim.obs.length; i++) {
    const o = sim.obs[i];
    if (o.passed) {
      if (st.near.has(o.n)) {
        const g = st.near.get(o.n);
        st.near.delete(o.n);
        st.clearN++; st.clearSum += g; st.clearSq += g * g;
        if (g < st.clearMin) st.clearMin = g;
        if (g < 6) st.tight++;
        if (st.lastPress >= 0) { st.leadN++; st.leadSum += sim.frames - st.lastPress; }
      }
      continue;
    }
    if (Math.abs(o.y - ORBIT_Y) > NEAR_BAND) continue;
    const g = clearance(o, dots);
    const prev = st.near.has(o.n) ? st.near.get(o.n) : Infinity;
    if (g < prev) st.near.set(o.n, g);
  }
}

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepWatch(state);
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
    stats: newStats(),
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
    if (Number(payload.v) >= MIN_REPLAY_VERSION && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No marker at or above MIN_REPLAY_VERSION, no replay, no score.
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

  advanceTo(state, pressStep);
  if (sim.dead) return died(state);
  // The client only records a press it applied, so a press the rules refuse
  // (inside the start guard) is a forged one.
  if (!pressSim(sim, dir)) return reject(state, 'not_ready');

  const st = state.stats;
  if (st.lastDir !== 0 && dir !== st.lastDir) st.reversals++;
  st.lastDir = dir;
  st.lastPress = pressStep;

  advanceTo(state, releaseStep);
  if (sim.dead) return died(state);
  releaseSim(sim);

  const len = releaseStep - pressStep;
  st.holdN++; st.holdSum += len; st.holdSq += len * len;
  if (len < st.holdMin) st.holdMin = len;

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
  const st = state.stats;
  // Run the world out past the last input. A ring that stops turning dies
  // inside STILL_LIMIT steps, so this settles quickly.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepWatch(state);
    guard++;
  }
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame, deathCause: sim.deathCause,
      deathMask: sim.deathMask, score: sim.score, passed: sim.passed, dead: sim.dead,
      inputs: state.inputCount, rejects: state.rejectCount, holds: sim.holdN, spawned: sim.spawned,
      version: sim.version,
      holdMean: fin(mean(st.holdSum, st.holdN)), holdSd: fin(sd(st.holdSum, st.holdSq, st.holdN)),
      holdMin: fin(st.holdMin),
      holdFrac: sim.frames > 0 ? st.holdSteps / sim.frames : null,
      clearMean: fin(mean(st.clearSum, st.clearN)), clearSd: fin(sd(st.clearSum, st.clearSq, st.clearN)),
      clearMin: fin(st.clearMin),
      tightShare: st.clearN > 0 ? st.tight / st.clearN : null,
      leadMean: fin(mean(st.leadSum, st.leadN)),
      reversalsPerPass: sim.passed > 0 ? st.reversals / sim.passed : null,
      turnPerPass: sim.passed > 0 ? st.turn / sim.passed : null,
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
    initSim, stepSim, pressSim, releaseSim, killSim, advanceTo, stepWatch, clearance,
    obsRng, seedToInt, wrapAng, levelOf, fallSpeed, spawnGap, spinScale, obstacleSpec,
    lateLevels, speedFor, gapFor, spinFor,
    dotsOf, hitMask, spawnObstacle,
    MAX_INPUTS, MAX_SIM_STEPS, NEAR_BAND, STILL_LIMIT,
    RULES_VERSION, MIN_REPLAY_VERSION, ANGLE_UNITS, TURN, RAD, QUARTER,
    ORBIT_X, ORBIT_Y, ORBIT_R, DOT_R, START_A, START_GUARD_STEPS, FIRST_SPAWN_STEP,
    SPAWN_Y, PASS_Y, DROP_Y, LANES, SCORE_PER_PASS, PASSES_PER_LEVEL,
    SPEED_BASE, SPEED_STEP, SPEED_MAX, SPAWN_BASE, SPAWN_STEP, SPAWN_MIN,
    SPIN_BASE, SPIN_STEP, SPIN_MAX, SPIN_RANGE, WEIGHT_BONUS_MAX,
    V3_FROM_LEVEL, SPEED_V3_STEP, SPEED_V3_MAX, SPAWN_V3_EVERY, SPAWN_V3_MIN, SPIN_V3_STEP, SPIN_V3_MAX,
    TYPES, RNG_STRIDE, RNG_SALT, MAX_OBS,
  },
};
