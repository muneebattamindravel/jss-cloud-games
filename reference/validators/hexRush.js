'use strict';

/**
 * Hex Rush validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Hex Rush was born on replay, so the only trace this file scores is a v2
 * trace: a start marker with v >= 2, then hold pairs. There is no plausibility
 * path (the session layer refuses markerless traces platform-wide anyway).
 *
 * The game: a cursor orbits a hexagon. Holding a side of the screen turns it
 * one way or the other. Walls close in from the edge in seeded patterns with
 * gaps; be in a gap when one arrives. Touching the front of a wall ends the
 * run. The score is how long the run lasted, a point every SCORE_EVERY steps,
 * so tenths of a second.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed: pattern K's shape, rotation,
 *      mirror and the gap before the next one are a pure function of (seed, K);
 *   2. applies each hold pair { n, dir, pressStep, releaseStep } on the fixed
 *      steps it landed on (dir -1 turns one way, +1 the other);
 *   3. walks the same 1/60 s steps as the client. EVERYTHING IS INTEGER AND
 *      POLAR: an angle is a whole number out of ANGLE_UNITS and a radius a whole
 *      number of sixteenths of a design unit, so there is no trig anywhere on
 *      this path and no need for shared/anticheat/dmath.js. The only arithmetic
 *      is +, -, *, /, Math.floor and comparisons, all exact in every engine;
 *   4. counts the score off its own step counter.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/hex-rush/js/game.js.
 * shared/tests/hexRushParity.test.js pulls every constant and every function out
 * of both files and fails the moment one copy is edited without the other, and
 * shared/tests/fixtures/hexRushGolden.json pins the rules themselves, because a
 * change made in BOTH files would pass a parity check. Edit both or neither; a
 * gameplay change is a trace version bump and a new golden corpus.
 *
 * ⚠ WHAT THIS CANNOT DO, stated plainly. The course is a pure function of a
 * seed that is on the player's device, and the generator GUARANTEES a path
 * through everything it makes (the parity suite proves it), so a bot that reads
 * the seed and plans ahead survives for ever. No rule here can stop that and
 * none of this pretends to. What bounds it is the session hour, the
 * games.max_score_per_sec backstop, and the humanness fingerprint: a run several
 * times longer than the longest honest one is decisive on its own, and a hand
 * arrives in a gap late and unevenly where a planner arrives early and exactly.
 * That is why finalize()'s debug block carries more detail here than anywhere
 * else on the platform. It is RECORDED, never gated.
 */

  // ==== RULES BLOCK: identical in games/hex-rush/js/game.js ====
  //
  // POLAR AND INTEGER, so the rules need no trig at all. The circle is
  // ANGLE_UNITS units wide, divided into SECTORS sectors of SECTOR each. A wall
  // fills its whole sector between two radii; the cursor is an angle with a
  // fixed radius and an angular half width. Radial distances are in sixteenths
  // of a design unit. Everything below the effects marker draws this on
  // HEXAGONAL rings (see hexR), so the radius a wall has in the rules is exactly
  // the radius the player watches it reach.
  const RULES_VERSION = 3;
  // The floor a trace must clear to be replayed at all (a markerless trace
  // is refused platform-wide before it ever reaches here). Stays fixed as
  // RULES_VERSION moves, so a run in flight when a rules change ships is
  // never orphaned by the very check meant to let it keep replaying.
  const MIN_REPLAY_VERSION = 2;
  const ANGLE_UNITS = 3600;
  const SECTORS = 6;
  const SECTOR = 600;
  const CENTRE_R = 820;
  const CURSOR_R = 1160;
  const CURSOR_HALF = 48;
  const SPAWN_R = 7040;
  const ROW = 560;
  const THICK = 320;
  const START_A = 300;
  const START_GUARD_STEPS = 27;
  const FIRST_SPAWN_STEP = 30;
  const SCORE_EVERY = 6;

  // The ramp. Walls close in faster, the cursor turns faster with them, the gap
  // between patterns shrinks, and the harder patterns unlock by index and then
  // get commoner. All of it plateaus, and that is deliberate: the generator
  // GUARANTEES a path through every course it makes, so a bot that reads the
  // seed survives whatever we do here. What bounds a run is the session hour,
  // games.max_score_per_sec, and the bot detector.
  const W_BASE = 28;
  const W_NUM = 3;
  const W_DEN = 5;
  const W_CAP = 54;
  const T_BASE = 27;
  const T_NUM = 1;
  const T_DEN = 2;
  const T_CAP = 50;
  // Kept for a v2 trace already in flight when this shipped: the turn rate
  // an in-progress run was actually played with never changes under it.
  const T_BASE_V2 = 24;
  const T_CAP_V2 = 46;
  const GAP_BASE = 6;
  const GAP_SHRINK_EVERY = 9;
  const GAP_FLOOR = 5;
  const GAP_SPAN = 2;
  const NEW_SHARE = 50;

  // A pattern is a list of rings: [wall mask, row offset, thickness in THICK].
  // Bit i of the mask is a WALL in sector i, so a clear bit is a gap and every
  // ring has at least one. shared/tests/hexRushParity.test.js proves, over every
  // pattern pair and every level, that a gap of one ring is always inside the
  // rotation the speeds allow before the next ring arrives.
  const PATTERNS = [
    [[0x3e, 0, 1]],
    [[0x36, 0, 1]],
    [[0x3e, 0, 1], [0x3d, 3, 1]],
    [[0x3e, 0, 4]],
    [[0x3e, 0, 1], [0x3d, 3, 1], [0x3b, 6, 1], [0x37, 9, 1], [0x2f, 12, 1]],
    [[0x3e, 0, 1], [0x3d, 3, 1], [0x3e, 6, 1], [0x3d, 9, 1]],
    [[0x3e, 0, 1], [0x37, 7, 1]],
    [[0x36, 0, 1], [0x2d, 3, 1], [0x1b, 6, 1], [0x36, 9, 1]],
  ];
  const PATTERN_FROM = [0, 3, 6, 10, 15, 22, 30, 40];

  const RNG_STRIDE = 0x9E3779B1;
  const RNG_SALT = 0x5F2A19C3;
  // A work bound, not a rule. Spawning is a pure function of the seed and the
  // step, so nothing an attacker sends can reach it; the parity suite records
  // the real high-water mark, which is a fraction of this.
  const MAX_WALLS = 512;

  function patRng(seedInt, index) {
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

  function sectorOf(ang) {
    return Math.floor(wrapAng(ang) / SECTOR);
  }

  function wallSpeed(level) {
    return W_BASE + Math.min(W_CAP, Math.floor(level * W_NUM / W_DEN));
  }

  function turnRate(level, version) {
    return version >= 3
      ? T_BASE + Math.min(T_CAP, Math.floor(level * T_NUM / T_DEN))
      : T_BASE_V2 + Math.min(T_CAP_V2, Math.floor(level * T_NUM / T_DEN));
  }

  // Which pattern index K draws. Harder entries unlock by index, and once three
  // are unlocked half the picks come from the newest two, so the road keeps
  // showing the player something they have not learned yet.
  function patternIndexAt(styleRoll, biasRoll, k) {
    let n = 1;
    while (n < PATTERNS.length && k >= PATTERN_FROM[n]) n++;
    const lo = (n > 2 && Math.floor(biasRoll * 100) < NEW_SHARE) ? n - 2 : 0;
    const i = lo + Math.floor(styleRoll * (n - lo));
    return i < n ? i : n - 1;
  }

  // Pattern K is a pure function of (seed, K). All five draws happen on every
  // index, in this order, whichever branches use them.
  function patternSpec(seedInt, k) {
    const rng = patRng(seedInt, k);
    const styleRoll = rng();
    const biasRoll = rng();
    const rotRoll = rng();
    const mirrorRoll = rng();
    const gapRoll = rng();
    const idx = patternIndexAt(styleRoll, biasRoll, k);
    const rot = Math.floor(rotRoll * SECTORS) % SECTORS;
    const mirror = Math.floor(mirrorRoll * 2) === 1;
    const gapRows = Math.max(GAP_FLOOR, GAP_BASE - Math.floor(k / GAP_SHRINK_EVERY))
      + Math.floor(gapRoll * (GAP_SPAN + 1));
    return { idx: idx, rot: rot, mirror: mirror, gapRows: gapRows };
  }

  // Mirroring reverses a spiral; the rotation then turns the whole ring. Both
  // keep every angular distance inside the pattern, which is why the
  // reachability proof only has to look at the table.
  function mapSector(s, rot, mirror) {
    const m = mirror ? (SECTORS - s) % SECTORS : s;
    return (m + rot) % SECTORS;
  }

  // How far the pattern reaches behind its front ring: its outermost surface.
  function patternDepth(idx) {
    const rows = PATTERNS[idx];
    let d = 0;
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i][1] * ROW + rows[i][2] * THICK;
      if (e > d) d = e;
    }
    return d;
  }

  // Is a wall crossing the cursor's own radius in this sector right now? This is
  // both the sideways block and the death test, so what stops the cursor and
  // what kills it can never disagree.
  function blockedAt(sim, sector) {
    for (let i = 0; i < sim.walls.length; i++) {
      const wl = sim.walls[i];
      if (wl.sector === sector && wl.dist <= CURSOR_R && wl.dist + wl.thick >= CURSOR_R) return true;
    }
    return false;
  }

  // The next pattern starts only once the one before it has come in past
  // SPAWN_R by its gap, so rings always arrive in the order they were made and
  // two patterns can never interleave. Every wall shares one speed, so the
  // distances between rings are frozen at the moment they are made: only how
  // long they take to arrive depends on the level.
  function spawnPattern(sim) {
    const k = sim.patterns;
    const spec = patternSpec(sim.seedInt, k);
    const rows = PATTERNS[spec.idx];
    const add = [];
    for (let i = 0; i < rows.length; i++) {
      const mask = rows[i][0];
      const dist = SPAWN_R + rows[i][1] * ROW;
      const thick = rows[i][2] * THICK;
      for (let s = 0; s < SECTORS; s++) {
        if (mask & (1 << s)) add.push({ sector: mapSector(s, spec.rot, spec.mirror), dist: dist, thick: thick });
      }
    }
    if (sim.walls.length + add.length <= MAX_WALLS) sim.walls = sim.walls.concat(add);
    sim.patterns = k + 1;
    sim.nextSpawn = sim.frames
      + Math.ceil((patternDepth(spec.idx) + spec.gapRows * ROW) / wallSpeed(sim.patterns));
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
      walls: [],
      patterns: 0,
      nextSpawn: FIRST_SPAWN_STEP,
      score: 0,
      dead: false,
      deathFrame: null,
      deathCause: null,
    };
  }

  function killSim(sim, cause) {
    sim.dead = true;
    sim.deathFrame = sim.frames;
    sim.deathCause = cause;
  }

  function stepSim(sim) {
    if (sim.dead) return;
    sim.frames++;
    const level = sim.patterns;
    const w = wallSpeed(level);

    // 1. Rotate. The side held is the ACTION and the only thing the rules see;
    //    which half of the screen produced it, and how far the view has spun
    //    since, never reach here. A rotation that would carry the leading edge
    //    into a sector a wall is crossing is CLAMPED at the boundary: the cursor
    //    slides along a wall, it does not die on its side.
    if (sim.holdDir !== 0) {
      const t = turnRate(level, sim.version);
      const lead0 = wrapAng(sim.a + sim.holdDir * CURSOR_HALF);
      let lead1 = lead0 + sim.holdDir * t;
      if (sim.holdDir > 0) {
        const bnd = (Math.floor(lead0 / SECTOR) + 1) * SECTOR;
        if (lead1 >= bnd && blockedAt(sim, (bnd / SECTOR) % SECTORS)) lead1 = bnd - 1;
      } else {
        const bnd = Math.floor(lead0 / SECTOR) * SECTOR;
        if (lead1 < bnd && blockedAt(sim, (bnd / SECTOR + SECTORS - 1) % SECTORS)) lead1 = bnd;
      }
      sim.a = wrapAng(lead1 - sim.holdDir * CURSOR_HALF);
    }

    // 2. The walls close in. The list is REPLACED, never edited in place: a
    //    pilot planning on a shallow copy must not be able to write into the
    //    real run. A wall that has passed inside the middle hexagon is gone.
    const moved = [];
    for (let i = 0; i < sim.walls.length; i++) {
      const wl = sim.walls[i];
      const d = wl.dist - w;
      if (d + wl.thick > CENTRE_R) moved.push({ sector: wl.sector, dist: d, thick: wl.thick });
    }
    sim.walls = moved;
    if (sim.frames >= sim.nextSpawn) spawnPattern(sim);

    // 3. Death: a wall whose radial span holds the cursor's radius, in a sector
    //    the cursor's own angular span overlaps. The span is at most two
    //    sectors, because the cursor is narrower than one.
    const lo = sectorOf(sim.a - CURSOR_HALF);
    const hi = sectorOf(sim.a + CURSOR_HALF);
    for (let i = 0; i < sim.walls.length; i++) {
      const wl = sim.walls[i];
      if (wl.dist <= CURSOR_R && wl.dist + wl.thick >= CURSOR_R && (wl.sector === lo || wl.sector === hi)) {
        killSim(sim, 'wall');
        break;
      }
    }

    // 4. The score IS the clock: a point every SCORE_EVERY steps, so tenths of a
    //    second survived. It comes off the step counter, so what the HUD shows
    //    and what the server computes cannot drift apart.
    sim.score = Math.floor(sim.frames / SCORE_EVERY);
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
// The bound the course's own geometry puts on a parked cursor: every ring
// carries at least one wall, so a cursor that never moves meets one. Measured
// at 846 steps over 4,000 seeds, so 1,200 is documentation and a test target
// with room, not a rule. Nothing below reads it.
const IDLE_STEPS = 1200;

// ── the raw material the bot detector reads (recorded, never gated) ─────
// A hand and a planner differ in HOW they arrive, not in what they score:
//  - angMargin: how much angular clearance was left when a ring arrived. A
//    planner leaves a comfortable, even margin; a hand's is scattered and
//    sometimes tiny.
//  - timeMargin: how many steps the cursor had already been in that sector
//    when the ring arrived. A planner arrives early, a hand arrives late.
//  - gapOff: how far from the middle of a sector a hold was released. A planner
//    releases on the centre; a hand scatters.
//  - turnPerRing: total rotation divided by rings passed. A planner turns the
//    minimum; a hand overshoots and comes back. This stands in for "did they go
//    the short way round", which needs a target the server cannot know.
function newStats() {
  return {
    rings: 0, turn: 0, holdSteps: 0, sectorStep: 0, reversals: 0, lastDir: 0,
    angN: 0, angSum: 0, angMin: Infinity,
    timeN: 0, timeSum: 0, timeMin: Infinity,
    holdN: 0, holdSum: 0, holdSq: 0, holdMin: Infinity,
    offN: 0, offSum: 0, offSq: 0, offCentre: 0,
  };
}
function mean(sum, n) { return n > 0 ? sum / n : null; }
function sd(sum, sq, n) { return n > 1 ? Math.sqrt(Math.max(0, sq / n - (sum / n) * (sum / n))) : null; }
function fin(v) { return Number.isFinite(v) ? v : null; }

// How far the cursor's nearest edge is from a walled sector, in angle units.
// Zero means it is inside it, which is a death and never a margin.
function angGap(x, y) {
  const t = Math.abs(((x - y) % ANGLE_UNITS + ANGLE_UNITS) % ANGLE_UNITS);
  return Math.min(t, ANGLE_UNITS - t);
}
function clearanceTo(a, s) {
  const eL = wrapAng(a - CURSOR_HALF), eR = wrapAng(a + CURSOR_HALF);
  if (sectorOf(eL) === s || sectorOf(eR) === s) return 0;
  const lo = s * SECTOR, hi = lo + SECTOR;
  return Math.min(angGap(eL, lo), angGap(eL, hi), angGap(eR, lo), angGap(eR, hi));
}
// Signed distance from the middle of the sector the cursor sits in.
function offCentre(a) {
  const mid = sectorOf(a) * SECTOR + SECTOR / 2;
  let d = a - mid;
  if (d > ANGLE_UNITS / 2) d -= ANGLE_UNITS;
  if (d < -ANGLE_UNITS / 2) d += ANGLE_UNITS;
  return d;
}

// One step, watched. The accounting reads the run and never writes it, and it
// is deliberately OUTSIDE the rules block: game.js has no copy of it.
function stepWatch(state) {
  const sim = state.sim;
  const st = state.stats;
  const a0 = sim.a;
  const sec0 = sectorOf(sim.a);
  const w = wallSpeed(sim.patterns);
  stepSim(sim);
  let d = sim.a - a0;
  if (d > ANGLE_UNITS / 2) d -= ANGLE_UNITS;
  if (d < -ANGLE_UNITS / 2) d += ANGLE_UNITS;
  st.turn += Math.abs(d);
  if (sim.holdDir !== 0) st.holdSteps++;
  if (sectorOf(sim.a) !== sec0) st.sectorStep = sim.frames;
  let arrived = false;
  let best = -1;
  for (let i = 0; i < sim.walls.length; i++) {
    const wl = sim.walls[i];
    if (!(wl.dist <= CURSOR_R && wl.dist + w > CURSOR_R)) continue;
    arrived = true;
    const c = clearanceTo(sim.a, wl.sector);
    if (c > 0 && (best < 0 || c < best)) best = c;
  }
  if (arrived) {
    st.rings++;
    if (best >= 0) { st.angN++; st.angSum += best; if (best < st.angMin) st.angMin = best; }
    const t = sim.frames - st.sectorStep;
    st.timeN++; st.timeSum += t; if (t < st.timeMin) st.timeMin = t;
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

  advanceTo(state, releaseStep);
  if (sim.dead) return died(state);
  releaseSim(sim);

  const len = releaseStep - pressStep;
  st.holdN++; st.holdSum += len; st.holdSq += len * len;
  if (len < st.holdMin) st.holdMin = len;
  const off = Math.abs(offCentre(sim.a));
  st.offN++; st.offSum += off; st.offSq += off * off;
  if (off <= 30) st.offCentre++;

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
  // Run the world out past the last input. Every ring carries at least one wall,
  // so a parked cursor meets one inside IDLE_STEPS and this settles quickly.
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
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      holds: sim.holdN, patterns: sim.patterns, rings: st.rings, version: sim.version,
      holdMean: fin(mean(st.holdSum, st.holdN)), holdSd: fin(sd(st.holdSum, st.holdSq, st.holdN)),
      holdMin: fin(st.holdMin),
      gapOffMean: fin(mean(st.offSum, st.offN)), gapOffSd: fin(sd(st.offSum, st.offSq, st.offN)),
      centreShare: st.offN > 0 ? st.offCentre / st.offN : null,
      angMarginMean: fin(mean(st.angSum, st.angN)), angMarginMin: fin(st.angMin),
      timeMarginMean: fin(mean(st.timeSum, st.timeN)), timeMarginMin: fin(st.timeMin),
      reversalsPerPattern: sim.patterns > 0 ? st.reversals / sim.patterns : null,
      turnPerRing: st.rings > 0 ? st.turn / st.rings : null,
      holdFrac: sim.frames > 0 ? st.holdSteps / sim.frames : null,
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
    initSim, stepSim, pressSim, releaseSim, killSim, advanceTo, stepWatch,
    patRng, seedToInt, wrapAng, sectorOf, wallSpeed, turnRate, patternIndexAt, patternSpec,
    mapSector, patternDepth, blockedAt, spawnPattern, clearanceTo, offCentre,
    MAX_INPUTS, MAX_SIM_STEPS, IDLE_STEPS,
    RULES_VERSION, ANGLE_UNITS, SECTORS, SECTOR, CENTRE_R, CURSOR_R, CURSOR_HALF, SPAWN_R, ROW, THICK,
    START_A, START_GUARD_STEPS, FIRST_SPAWN_STEP, SCORE_EVERY,
    MIN_REPLAY_VERSION, W_BASE, W_NUM, W_DEN, W_CAP, T_BASE, T_NUM, T_DEN, T_CAP, T_BASE_V2, T_CAP_V2,
    GAP_BASE, GAP_SHRINK_EVERY, GAP_FLOOR, GAP_SPAN, NEW_SHARE,
    PATTERNS, PATTERN_FROM, RNG_STRIDE, RNG_SALT, MAX_WALLS,
  },
};
