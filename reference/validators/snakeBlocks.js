'use strict';

/**
 * Snake Blocks validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Snake Blocks (in the mould of Voodoo's Snake VS Block, built in-house on
 * replay from day one) is scored from a v2 trace only: a start marker with
 * v >= 2, touch / lift markers and dense positional path batches. There is no
 * plausibility path (the session layer refuses markerless traces).
 *
 * The game: a chain of balls rides at a fixed height while rows of numbered
 * blocks scroll down onto it. The player drags to steer. Pushing into a block
 * grinds it down one ball a tick (every ball it takes is a point) and breaking
 * it pays its face value times a chain multiplier; green balls lengthen the
 * chain; dividers block the head sideways. Run out of balls and the run is
 * over.
 *
 * What the server does with a trace:
 *   1. rebuilds the whole course from the session seed: row N (its blocks,
 *      pickup and dividers) is a pure function of (seed, N);
 *   2. replays the touch / lift markers and the path batches { f, x: [...] },
 *      where x[i] is where the player had steered the head during fixed step
 *      f+1+i, in whole design units;
 *   3. walks the same 1/60 s steps as the client and scores its own work.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/snake-blocks/js/game.js.
 * shared/tests/snakeBlocksParity.test.js fails the moment one copy is edited
 * without the other, and shared/tests/fixtures/snakeBlocksGolden.json pins the
 * rules themselves, because a change made in BOTH files would pass a parity
 * check. A gameplay change is a trace version bump and a new golden corpus.
 *
 * Only + - * / floor min max and comparisons on the rules path, so no dmath is
 * needed: they are exact in every engine.
 *
 * ⚠ WHAT THIS CANNOT DO. The course is a pure function of a seed on the
 * player's device, and the generator guarantees a walkable path through all of
 * it, so a bot that reads the seed can plan every row. Replay credits exactly
 * what the inputs produce; the session hour, the economy that bleeds every run
 * (see taxFor), games.max_score_per_sec and the humanness fingerprint
 * (finalize's debug block, RECORDED, never gated) are what bound that.
 */

// ==== RULES BLOCK: identical in games/snake-blocks/js/game.js ====
//
// UNITS. Everything lateral (the head's x, column edges, radii, wall lines) is
// in WHOLE DESIGN UNITS, because the trace carries the head's x as an integer
// design unit and the server must apply exactly what the client applied.
// Everything along the world (scroll, row pitch, block height, wall spans) is
// in SUB-UNITS of 1/16 of a design unit so the scroll can ramp smoothly; every
// such constant ends in Q. Only + - * / floor min max and comparisons, all of
// which are exact in every engine. No trig, no pow, no square roots.
const U = 16;
const FIELD_W = 414;
const FIELD_H = 736;
const COLS = 5;
const COL_W = 80;
const LANE_X = 7;
const HEAD_Y = 556;
const HEAD_R = 15;
const X_MIN = LANE_X + HEAD_R;
const X_MAX = LANE_X + COLS * COL_W - HEAD_R;
const START_X = (X_MIN + X_MAX) / 2;
const HEAD_MAX_STEP = 13;
const ROW_HQ = 176 * U;
const BLOCK_HQ = 64 * U;
const HEAD_RQ = HEAD_R * U;
const WALL_GAPQ = 8 * U;
const WALL_LENQ = 96 * U;
const WALL_HALF = 3;
const PICK_R = 14;
const PICK_RQ = (HEAD_R + PICK_R) * U;
const PICK_YQ = BLOCK_HQ / 2;
const START_LEN = 4;
const START_GUARD_STEPS = 27;
const ARM_TIMEOUT_STEPS = 1800;
const SPEED_BASE = 54;
const SPEED_EVERY = 1;
const SPEED_CAP = 128;
const HIT_BASE = 3;
const HIT_MIN = 1;
const HIT_SPEEDUP = 150;
const FULL_FROM = 4;
const FULL_SLACK = 2;
const PHASE_LENS = [4, 3, 5, 4, 6, 3, 5, 4];
const PHASE_N = 8;
const PHASE_CYCLE = 34;
const SCATTER_FROM = 2;
const PICK_FROM = 1;
const PICK_CHANCE = 62;
const PICK_MIN = 2;
const WALL_FROM = 8;
const RNG_STRIDE = 0x9E3779B1;
const ROW_SALT = 0x5BF03635;
const FULL_SALT = 0x1B873593;

// Column subsets of the five lanes, grouped by how many lanes they fill. A
// scattered row picks its mask from one of these; a full row is always 31.
// Which of the four NON-anchor lanes a row fills, by how many it fills.
const COMB4 = [
  [[]],
  [[0], [1], [2], [3]],
  [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
  [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
  [[0, 1, 2, 3]],
];

// THE PATH. Every row leaves one lane open for certain, and these are the
// sequences that lane walks. Each starts on the middle lane and never steps
// more than PATH_JUMP lanes at a time, so the join between two of them is a
// step of at most PATH_JUMP as well and the whole course is one walkable line.
// The first two are all single steps; the rest are what the run gets later.
const LANE_PATHS = [
  [2, 1, 0, 1, 2, 3, 4, 3],
  [2, 3, 4, 3, 2, 1, 0, 1],
  [2, 0, 1, 2, 4, 3, 2, 1],
  [2, 3, 1, 0, 2, 4, 3, 4],
  [2, 1, 3, 4, 2, 0, 1, 2],
  [2, 4, 3, 1, 2, 3, 1, 0],
  [2, 0, 2, 3, 4, 2, 1, 0],
  [2, 4, 2, 0, 2, 4, 2, 0],
];
const PATH_LEN = 8;
const PATH_EASY = 2;
const PATH_EASY_ROWS = 24;
const PATH_JUMP = 2;
const PATH_SALT = 0x27D4EB2F;
const DENSE_FROM = 40;
const CHAIN_MAX = 8;
const CHAIN_GAP = 2;
// Population count of a four bit divider mask.
const POP4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

const DEATH_CAUSES = ['none', 'crushed', 'idle'];

function rowRng(seedInt, salt, index) {
  let a = (((seedInt ^ salt) >>> 0) + Math.imul(index + 1, RNG_STRIDE)) >>> 0;
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

function colLeft(c) { return LANE_X + c * COL_W; }
function colRight(c) { return LANE_X + (c + 1) * COL_W; }
function colMid(c) { return LANE_X + c * COL_W + COL_W / 2; }

// The typical block value at row n. It grows for ever, and it grows ever more
// slowly, so a deep run gets harder without turning into a minute of grinding
// on one block. Integer arithmetic, continuous at every join.
function valFor(n) {
  if (n < 36) return 2 + Math.floor(n / 3);
  if (n < 120) return 14 + Math.floor((n - 36) / 7);
  if (n < 400) return 26 + Math.floor((n - 120) / 18);
  return 42 + Math.floor((n - 400) / 55);
}

// What share of a phase's pickups the next full row takes, in eighths. It
// starts well under the supply and climbs past it for ever, so an early run is
// generous, a deep one bleeds, and no run lasts for ever however well it is
// played. How deep a player gets is how much they banked on the way.
function taxFor(n) {
  if (n < 50) return 3;
  if (n < 150) return 4;
  if (n < 300) return 5;
  if (n < 480) return 6;
  if (n < 700) return 7;
  if (n < 960) return 8;
  return 9 + Math.floor((n - 960) / 260);
}

// Green balls thin out as the run goes on, from the other side of the same
// squeeze.
function pickChanceFor(n) {
  if (n < 60) return PICK_CHANCE;
  if (n < 220) return PICK_CHANCE - 6;
  if (n < 480) return PICK_CHANCE - 13;
  return PICK_CHANCE - 20;
}

// How many steps of grinding buy one unit off a block. It shortens with the
// score, so the game speeds up as it goes; HIT_MIN is the rules' own ceiling
// on points per second (60 / HIT_MIN).
function hitSteps(score) {
  const s = HIT_BASE - Math.floor(score / HIT_SPEEDUP);
  return s < HIT_MIN ? HIT_MIN : s;
}

// Full rows come every four to seven rows, on a cycle the seed rotates. Both
// directions are closed form: no walking from row zero.
function phaseLen(seedInt, i) {
  return PHASE_LENS[(i + (seedInt % PHASE_N)) % PHASE_N];
}

function fullRowAt(seedInt, p) {
  let n = FULL_FROM + Math.floor(p / PHASE_N) * PHASE_CYCLE;
  const rem = p % PHASE_N;
  for (let i = 0; i < rem; i++) n += phaseLen(seedInt, i);
  return n;
}

function fullIndexAt(seedInt, n) {
  if (n < FULL_FROM) return -1;
  const d = n - FULL_FROM;
  const c = Math.floor(d / PHASE_CYCLE);
  let acc = c * PHASE_CYCLE;
  for (let i = 0; i < PHASE_N; i++) {
    if (acc === d) return c * PHASE_N + i;
    if (acc > d) return -1;
    acc += phaseLen(seedInt, i);
  }
  return -1;
}

// The open lane at row n. A pure function of (seed, n): the block of eight
// rows picks a path, and the row reads its place in it.
function anchorAt(seedInt, n) {
  if (n < 0) return 2;
  const b = Math.floor(n / PATH_LEN);
  const pool = b * PATH_LEN < PATH_EASY_ROWS ? PATH_EASY : LANE_PATHS.length;
  const p = Math.floor(rowRng(seedInt, PATH_SALT, b)() * pool);
  return LANE_PATHS[p][n - b * PATH_LEN];
}

// Every region a divider mask carves out of the five lanes must hold a lane
// the row leaves empty. That is what stops a wall from sealing the head into a
// pocket whose only way out is a block.
function wallsValid(wmask, bmask, a0, a1) {
  // A divider may never stand between the lane the path just left and the one
  // it is heading for: the player has one gap to make that move and a wall in
  // the way would make it impossible, not merely hard.
  const lo = a0 < a1 ? a0 : a1;
  const hi = a0 < a1 ? a1 : a0;
  for (let b = lo + 1; b <= hi; b++) {
    if (wmask & (1 << (b - 1))) return false;
  }
  let start = 0;
  for (let b = 1; b <= COLS; b++) {
    if (b < COLS && !(wmask & (1 << (b - 1)))) continue;
    let open = false;
    for (let c = start; c < b; c++) {
      if (!(bmask & (1 << c))) { open = true; break; }
    }
    if (!open) return false;
    start = b;
  }
  return true;
}

// Row n without the full row rule applied: blocks, one pickup, dividers.
// Exactly eleven draws on every index, whatever branches are taken. This is
// what a full row sums to find the budget its phase offered, so it never
// recurses into rowSpec.
//
// The lane the path is on is ALWAYS left open, and every other lane may be
// filled. So a player who tracks the path can always get through, and a player
// who strays is taking a real risk: at DENSE_FROM the path is sometimes the
// only way out of a row.
function baseRow(seedInt, n) {
  const rng = rowRng(seedInt, ROW_SALT, n);
  const countRoll = rng();
  const maskRoll = rng();
  const v0 = rng();
  const v1 = rng();
  const v2 = rng();
  const v3 = rng();
  const pickRoll = rng();
  const pickColRoll = rng();
  const pickValRoll = rng();
  const wallCountRoll = rng();
  const wallPickRoll = rng();
  const v = valFor(n);
  const anchor = anchorAt(seedInt, n);
  const others = [];
  for (let c = 0; c < COLS; c++) if (c !== anchor) others.push(c);
  // A row that fills all four other lanes leaves the path as the only way
  // through. Spaced out by construction so two never come back to back.
  const dense = n >= DENSE_FROM && (n + (seedInt % 3)) % 3 === 0;
  const cmax = n < SCATTER_FROM ? 0 : (n < 8 ? 1 : (n < 20 ? 2 : (dense ? 4 : 3)));
  const k = Math.floor(countRoll * (cmax + 1));
  const opts = COMB4[k];
  const pickedOf = opts[Math.floor(maskRoll * opts.length)];
  let mask = 0;
  const vals = [0, 0, 0, 0, 0];
  const rolls = [v0, v1, v2, v3];
  for (let j = 0; j < pickedOf.length; j++) {
    const c = others[pickedOf[j]];
    mask |= 1 << c;
    vals[c] = 1 + Math.floor(rolls[j] * (v + 8));
  }
  let pick = null;
  if (n >= PICK_FROM && Math.floor(pickRoll * 100) < pickChanceFor(n)) {
    const free = [];
    for (let c = 0; c < COLS; c++) if (!(mask & (1 << c))) free.push(c);
    if (free.length > 0) {
      const pc = free[Math.floor(pickColRoll * free.length)];
      pick = { c: pc, v: PICK_MIN + Math.floor(pickValRoll * v) };
    }
  }
  const wmax = n < WALL_FROM ? 0 : (n < 28 ? 1 : 2);
  const want = Math.floor(wallCountRoll * (wmax + 1));
  let walls = 0;
  if (want > 0) {
    const a0 = anchorAt(seedInt, n - 1);
    const cands = [];
    for (let m = 1; m < 16; m++) {
      if (POP4[m] === want && wallsValid(m, mask, a0, anchor)) cands.push(m);
    }
    if (cands.length > 0) walls = cands[Math.floor(wallPickRoll * cands.length)];
  }
  return { n: n, full: false, mask: mask, vals: vals, pick: pick, walls: walls, anchor: anchor, cheapCol: -1, cheap: 0, budget: 0 };
}

// A full row fills all five lanes, so it cannot be dodged: it is where the
// score comes from. Two guarantees are built into it rather than hoped for.
//   1. Its cheapest block costs no more than the share of the phase's pickups
//      taxFor(n) asks for, plus FULL_SLACK, so a player who collected them can
//      always pass. The cheap lane is the lane the PATH is on, so it is always
//      one gap and at most PATH_JUMP lanes from where the path just was, and no
//      divider may stand in between.
//   2. Every lane's block costs MORE than the pickups that phase put in that
//      same lane. So a head that never moves loses at least one length a
//      phase and dies within a bounded number of steps, whatever the seed.
function fullRow(seedInt, n, p) {
  const rng = rowRng(seedInt, FULL_SALT, n);
  const e0 = rng();
  const e1 = rng();
  const e2 = rng();
  const e3 = rng();
  const e4 = rng();
  const prev = p > 0 ? fullRowAt(seedInt, p - 1) : -1;
  const sup = [0, 0, 0, 0, 0];
  let budget = 0;
  for (let m = prev + 1; m < n; m++) {
    const r = baseRow(seedInt, m);
    if (r.pick !== null) { sup[r.pick.c] += r.pick.v; budget += r.pick.v; }
  }
  const v = valFor(n);
  const cheapCol = anchorAt(seedInt, n);
  const cheap = Math.max(sup[cheapCol] + 1, Math.min(Math.floor((budget * taxFor(n)) / 8) + FULL_SLACK, 2 * v));
  const extras = [e0, e1, e2, e3, e4];
  const vals = [0, 0, 0, 0, 0];
  for (let c = 0; c < COLS; c++) {
    if (c === cheapCol) { vals[c] = cheap; continue; }
    vals[c] = Math.max(sup[c] + 1, cheap + 1 + Math.floor(extras[c] * (2 * v + 2)));
  }
  return { n: n, full: true, mask: 31, vals: vals, pick: null, walls: 0, anchor: cheapCol, cheapCol: cheapCol, cheap: cheap, budget: budget };
}

function rowSpec(seedInt, n) {
  const p = fullIndexAt(seedInt, n);
  if (p >= 0) return fullRow(seedInt, n, p);
  return baseRow(seedInt, n);
}

function specFor(sim, n) {
  let s = sim.specs.get(n);
  if (!s) {
    if (sim.specs.size > 48) sim.specs.clear();
    s = rowSpec(sim.seedInt, n);
    sim.specs.set(n, s);
  }
  return s;
}

function initSim(seedHex) {
  return {
    seedInt: seedToInt(seedHex),
    frames: 0,
    armed: false,
    down: false,
    hx: START_X,
    scroll: 0,
    speed: SPEED_BASE,
    rowN: 0,
    rowVals: null,
    lastPick: -1,
    len: START_LEN,
    chain: 0,
    chainRow: -2,
    hitT: 0,
    hitCol: -1,
    picks: 0,
    score: 0,
    ev: 0,
    evCol: -1,
    dead: false,
    deathFrame: null,
    deathCause: null,
    specs: new Map(),
  };
}

function killSim(sim, cause) {
  sim.dead = true;
  sim.deathFrame = sim.frames;
  sim.deathCause = cause;
}

// The engaged row is the first one the head has not scrolled clean past. The
// gap between two rows is wider than the head, so only one row is ever live.
function ensureRow(sim) {
  while (sim.rowN * ROW_HQ + BLOCK_HQ <= sim.scroll - HEAD_RQ) {
    sim.rowN++;
    sim.rowVals = null;
    // CHAIN_GAP rows went by with nothing broken: the chain is over.
    if (sim.rowN - sim.chainRow > CHAIN_GAP) sim.chain = 0;
  }
  if (sim.rowVals === null) sim.rowVals = specFor(sim, sim.rowN).vals.slice();
}

function travelTo(px, x) {
  const d = x - px;
  if (d > HEAD_MAX_STEP) return px + HEAD_MAX_STEP;
  if (d < -HEAD_MAX_STEP) return px - HEAD_MAX_STEP;
  return x;
}

// The widest span the head's centre may occupy this step. Dividers push it to
// whichever side of the line it is already on; live blocks in the engaged band
// stop it at their edge. It is never killed by a side: it is blocked.
function clampLateral(sim, px, nx) {
  let lo = X_MIN;
  let hi = X_MAX;
  let bump = 0;
  const n = sim.rowN;
  for (let k = 0; k < 2; k++) {
    const m = n + k;
    const sp = specFor(sim, m);
    if (sp.walls === 0) continue;
    const y1 = m * ROW_HQ - WALL_GAPQ;
    const y0 = y1 - WALL_LENQ;
    if (sim.scroll + HEAD_RQ <= y0 || sim.scroll - HEAD_RQ >= y1) continue;
    for (let b = 1; b < COLS; b++) {
      if (!(sp.walls & (1 << (b - 1)))) continue;
      const wx = LANE_X + b * COL_W;
      if (px < wx) {
        const h = wx - HEAD_R - WALL_HALF;
        if (h < hi) hi = h;
      } else {
        const l = wx + HEAD_R + WALL_HALF;
        if (l > lo) lo = l;
      }
    }
  }
  const nb = n * ROW_HQ;
  if (sim.scroll + HEAD_RQ > nb && sim.scroll - HEAD_RQ < nb + BLOCK_HQ) {
    for (let c = 0; c < COLS; c++) {
      if (sim.rowVals[c] <= 0) continue;
      if (px < colLeft(c)) {
        const h = colLeft(c) - HEAD_R;
        if (h < hi) hi = h;
      } else {
        const l = colRight(c) + HEAD_R;
        if (l > lo) lo = l;
      }
    }
  }
  if (lo > hi) return px;
  let out = nx;
  if (out < lo) { out = lo; bump = 1; }
  if (out > hi) { out = hi; bump = 1; }
  // A divider can come down on top of the head. Sliding it clear takes at most
  // HEAD_MAX_STEP a step, the same bound as the player's own hand, so nothing
  // ever teleports sideways.
  if (out - px > HEAD_MAX_STEP) out = px + HEAD_MAX_STEP;
  if (out - px < -HEAD_MAX_STEP) out = px - HEAD_MAX_STEP;
  if (bump) sim.ev |= 8;
  return out;
}

// The lowest lane of the engaged row whose block still stands under the head.
function firstBlocking(sim) {
  for (let c = 0; c < COLS; c++) {
    if (sim.rowVals[c] <= 0) continue;
    if (sim.hx + HEAD_R > colLeft(c) && sim.hx - HEAD_R < colRight(c)) return c;
  }
  return -1;
}

// One pickup per row at most, in a lane the row leaves empty. Rows are met in
// order and never revisited, so the row index of the last one taken is all the
// bookkeeping it needs.
function takePick(sim) {
  const n = sim.rowN;
  if (n <= sim.lastPick) return;
  const g = specFor(sim, n).pick;
  if (g === null) return;
  const dxq = (sim.hx - colMid(g.c)) * U;
  const dyq = sim.scroll - (n * ROW_HQ + PICK_YQ);
  if (dxq * dxq + dyq * dyq > PICK_RQ * PICK_RQ) return;
  sim.lastPick = n;
  sim.len += g.v;
  sim.picks++;
  sim.ev |= 4;
  sim.evCol = g.c;
}

// One fixed step. `x` is where the player has steered the head to, already
// bounded by HEAD_MAX_STEP on the client and checked again here. Nothing moves
// until the first touch after the start guard.
function stepSim(sim, down, x) {
  if (sim.dead) return;
  sim.frames++;
  sim.ev = 0;
  sim.evCol = -1;
  if (!sim.armed) {
    sim.down = down;
    if (down && sim.frames >= START_GUARD_STEPS) sim.armed = true;
    if (!sim.armed && sim.frames >= ARM_TIMEOUT_STEPS) killSim(sim, 'idle');
    return;
  }
  sim.down = down;
  ensureRow(sim);
  const px = sim.hx;
  let nx = down ? travelTo(px, x) : px;
  if (nx < X_MIN) nx = X_MIN;
  if (nx > X_MAX) nx = X_MAX;
  sim.hx = clampLateral(sim, px, nx);
  sim.speed = Math.min(SPEED_CAP, SPEED_BASE + Math.floor(sim.rowN / SPEED_EVERY));
  const nb = sim.rowN * ROW_HQ;
  let hit = -1;
  if (sim.scroll + HEAD_RQ <= nb && sim.scroll + sim.speed + HEAD_RQ > nb) hit = firstBlocking(sim);
  if (hit >= 0) {
    // Grinding holds the whole world, exactly as the game it is built after
    // does. The pressure is the snake's length, never the clock.
    sim.scroll = nb - HEAD_RQ;
    if (sim.hitCol !== hit) { sim.hitCol = hit; sim.hitT = 0; }
    sim.hitT++;
    if (sim.hitT >= hitSteps(sim.score)) {
      sim.hitT = 0;
      const vals = sim.rowVals.slice();
      vals[hit] -= 1;
      sim.rowVals = vals;
      sim.len--;
      sim.score++;
      sim.ev |= 1;
      sim.evCol = hit;
      if (vals[hit] <= 0) {
        // Breaking a block through pays its face value times the chain: the
        // number of rows in a row you have broken something in. Nibbling a
        // number and sliding off pays only the balls it took, so the game is
        // never "grind or dodge": it is how long a chain you dare keep alive.
        sim.hitCol = -1;
        sim.ev |= 2;
        sim.chain = (sim.rowN - sim.chainRow <= CHAIN_GAP) ? sim.chain + 1 : 1;
        if (sim.chain > CHAIN_MAX) sim.chain = CHAIN_MAX;
        sim.chainRow = sim.rowN;
        const orig = specFor(sim, sim.rowN).vals[hit];
        sim.score += orig * sim.chain;
      }
      if (sim.len <= 0) { killSim(sim, 'crushed'); return; }
    }
  } else {
    sim.hitCol = -1;
    sim.hitT = 0;
    sim.scroll += sim.speed;
  }
  takePick(sim);
}
// ==== END RULES BLOCK ====

// ── server-only bounds ──────────────────────────────────────────────────
//
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// One sample per step for an hour is 216,000. A little above it, so no honest
// trace can reach it; it REFUSES further input, never zeroes a run.
const MAX_INPUTS = 220000;
// The client cuts a batch at this many samples. Where it cuts is NOT part of
// the protocol (the array is positional); this is only a work bound.
const PATH_BATCH_MAX = 120;
const RULES_VERSION = 2;
const MIN_REPLAY_VERSION = 2;

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing would
// apply a malformed step as if it were real.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}
function isHeadX(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= X_MIN && v <= X_MAX;
}

// ── the raw material the bot detector reads (recorded, never gated) ─────
// A hand and a planner differ in HOW they steer, not what they score:
//  - lane*: how far the head was from the lane centre the course's open path
//    runs through, at the moment each row was entered. A planner sits dead on
//    it; a hand scatters.
//  - stroke*: runs of steps in which the head moved, their length and speed.
//  - reversalsPerRow: a hand overshoots and comes back.
function newStats() {
  return {
    laneN: 0, laneSum: 0, laneSq: 0, centred: 0,
    moveSteps: 0, downSteps: 0, strokeN: 0, curDir: 0, curLen: 0, curDist: 0,
    strokeLenSum: 0, strokeLenSq: 0, strokeSpdSum: 0, strokeSpdSq: 0, reversals: 0,
    touches: 0, holdN: 0, holdSum: 0, holdSq: 0, curHold: 0,
  };
}
function closeStroke(st) {
  if (st.curLen > 0) {
    st.strokeN++;
    st.strokeLenSum += st.curLen; st.strokeLenSq += st.curLen * st.curLen;
    const spd = st.curDist / st.curLen;
    st.strokeSpdSum += spd; st.strokeSpdSq += spd * spd;
  }
  st.curDir = 0; st.curLen = 0; st.curDist = 0;
}
function closeHold(st) {
  if (st.curHold > 0) { st.holdN++; st.holdSum += st.curHold; st.holdSq += st.curHold * st.curHold; }
  st.curHold = 0;
}
function sdOf(n, sum, sq) {
  if (n < 2) return null;
  const m = sum / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

// One step, watched. The accounting reads the run and never writes it.
function stepWatch(state, down, x) {
  const sim = state.sim;
  const st = state.stats;
  const px = sim.hx;
  const prow = sim.rowN;
  stepSim(sim, down, x);
  if (down) {
    st.downSteps++;
    st.curHold++;
    const dx = sim.hx - px;
    if (dx === 0) closeStroke(st);
    else {
      st.moveSteps++;
      const dir = dx < 0 ? -1 : 1;
      if (st.curDir !== 0 && dir !== st.curDir) { st.reversals++; closeStroke(st); }
      st.curDir = dir; st.curLen++; st.curDist += dx < 0 ? -dx : dx;
    }
  }
  if (sim.rowN !== prow && sim.rowN > 0) {
    const off = Math.abs(sim.hx - colMid(anchorAt(sim.seedInt, sim.rowN)));
    st.laneN++; st.laneSum += off; st.laneSq += off * off;
    if (off < 8) st.centred++;
  }
  // Test-only: the parity suite compares the whole simulation after EVERY step.
  if (state.onStep) state.onStep(sim);
}

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepWatch(state, state.down, state.lastX);
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
    down: false,
    lastX: START_X,
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
      state.sim = initSim(state.seed);
    }
    return { accepted: true, newScore: state.score };
  }

  // No marker at or above MIN_REPLAY_VERSION, no replay, no score.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  if (kind === 'touch' || kind === 'lift') return processMarker(state, kind, payload);
  if (kind === 'path') return processPath(state, payload);
  return { accepted: true, newScore: state.score };
}

// { kind: 'touch' | 'lift', step }: the finger went down, or came up, at the
// START of fixed step `step`. Nothing happens to the head before the finger is
// down, and the world keeps scrolling while it is not.
function processMarker(state, kind, payload) {
  const step = payload.step;
  if (!isStep(step) || step < 1) return reject(state, 'bad_marker');
  const sim = state.sim;
  // Markers never rewind: a rewind would let an attacker re-run one window.
  if (step - 1 < sim.frames) return reject(state, 'frame_regressed');
  if (step - 1 >= MAX_SIM_STEPS) return reject(state, 'too_late');
  if (kind === 'touch') {
    if (state.down) return reject(state, 'bad_marker');
    advanceTo(state, step - 1);
    if (sim.dead) return died(state);
    state.down = true;
    state.stats.touches++;
  } else {
    if (!state.down) return reject(state, 'bad_marker');
    advanceTo(state, step - 1);
    if (sim.dead) return died(state);
    state.down = false;
    closeHold(state.stats);
    closeStroke(state.stats);
  }
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// { kind: 'path', f, x: [...] }: x[i] is where the player had steered the head
// during step f+1+i. POSITIONAL and dense, validated whole BEFORE any of it is
// applied, so a batch that would stop half way can never leave the replay in a
// state the game never had.
function processPath(state, payload) {
  const f = payload.f;
  const xs = payload.x;
  if (!isStep(f) || !Array.isArray(xs) || xs.length === 0 || xs.length > PATH_BATCH_MAX) {
    return reject(state, 'bad_batch');
  }
  const sim = state.sim;
  if (!state.down) return reject(state, 'not_down');
  // Batches never overlap and never rewind.
  if (f < sim.frames) return reject(state, 'frame_regressed');
  if (f >= MAX_SIM_STEPS) return reject(state, 'too_late');
  for (let i = 0; i < xs.length; i++) {
    if (!isHeadX(xs[i])) return reject(state, 'bad_sample');
  }
  if (state.inputCount + xs.length > MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount += xs.length;

  advanceTo(state, f);
  for (let i = 0; i < xs.length; i++) {
    if (sim.dead || sim.frames >= MAX_SIM_STEPS) break;
    state.lastX = xs[i];
    stepWatch(state, true, xs[i]);
  }
  if (sim.dead) return died(state);
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
  // Run the world out past the last input, with the head where the trace left
  // it. A parked head is eaten by the first block it cannot afford.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepWatch(state, state.down, state.lastX);
    guard++;
  }
  closeStroke(st);
  closeHold(st);
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame, deathCause: sim.deathCause,
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      rows: sim.rowN, picks: sim.picks, len: sim.len, chain: sim.chain,
      // Not gated. Raw material for the bot fingerprint.
      fingerprint: {
        rowsEntered: st.laneN,
        meanLaneErr: st.laneN > 0 ? st.laneSum / st.laneN : null,
        sdLaneErr: sdOf(st.laneN, st.laneSum, st.laneSq),
        centredShare: st.laneN > 0 ? st.centred / st.laneN : null,
        strokes: st.strokeN,
        strokeLenMean: st.strokeN > 0 ? st.strokeLenSum / st.strokeN : null,
        strokeLenSd: sdOf(st.strokeN, st.strokeLenSum, st.strokeLenSq),
        strokeSpdMean: st.strokeN > 0 ? st.strokeSpdSum / st.strokeN : null,
        strokeSpdSd: sdOf(st.strokeN, st.strokeSpdSum, st.strokeSpdSq),
        reversalsPerRow: sim.rowN > 0 ? st.reversals / sim.rowN : null,
        moveFrac: st.downSteps > 0 ? st.moveSteps / st.downSteps : null,
        touches: st.touches,
        holdMean: st.holdN > 0 ? st.holdSum / st.holdN : null,
      },
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
    initSim, stepSim, killSim, rowSpec, baseRow, fullRow, specFor, anchorAt, fullRowAt, fullIndexAt,
    valFor, taxFor, pickChanceFor, hitSteps, phaseLen, wallsValid, rowRng, seedToInt, travelTo,
    clampLateral, firstBlocking, takePick, ensureRow, colLeft, colRight, colMid,
    advanceTo, stepWatch, MAX_INPUTS, MAX_SIM_STEPS, PATH_BATCH_MAX, RULES_VERSION, MIN_REPLAY_VERSION,
    U, FIELD_W, FIELD_H, COLS, COL_W, LANE_X, HEAD_Y, HEAD_R, X_MIN, X_MAX, START_X, HEAD_MAX_STEP,
    ROW_HQ, BLOCK_HQ, START_LEN, START_GUARD_STEPS, ARM_TIMEOUT_STEPS, SPEED_BASE, SPEED_CAP,
    HIT_BASE, HIT_MIN, HIT_SPEEDUP, CHAIN_MAX, CHAIN_GAP, PICK_YQ, PICK_R, WALL_HALF,
  },
};
