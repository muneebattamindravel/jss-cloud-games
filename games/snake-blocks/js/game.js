/**
 * Snake Blocks, in the mould of Voodoo's Snake VS Block.
 *
 * A chain of balls rides at a fixed height while the world scrolls down onto
 * it. Drag to steer. Numbered blocks come at you: push into one and it grinds
 * down, one ball a tick, and every ball it takes is a point. Green balls make
 * the chain longer. Run out of balls and the run is over.
 *
 * Built on server-side replay from day one. Everything that can decide a score
 *   - lives in the RULES BLOCK below, which is carried word for word in
 *     shared/anticheat/validators/snakeBlocks.js;
 *   - is integer arithmetic (no trig, no pow, no square roots);
 *   - runs in whole 1/60 s steps, never on the frame's real delta;
 *   - lives in a fixed 414 x 736 design field, never in the viewport;
 *   - is a pure function of the session seed and the row index.
 *
 * The trace carries the steered position of the head, one integer design unit
 * per fixed step, as dense positional batches. It carries no score and no
 * outcome: the server works those out for itself.
 *
 * Everything below the `// -- effects` marker is presentation. It reads the
 * simulation and never writes to it, and its randomness is Math.random, which
 * shared/tests/snakeBlocksParity.test.js proves cannot reach a score.
 */
(function () {
  'use strict';

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

  // ── client only: time, input shaping and the trace ─────────────────────
  const FRAME_MS = 1000 / 60;
  const MAX_CATCHUP_STEPS = 3;
  const STEP_EPSILON_MS = 0.01;
  // At most two seconds of samples per path event. Where batches are cut is
  // not part of the protocol: the server applies them positionally.
  const PATH_BATCH_MAX = 120;
  // How far the steer target may sit ahead of a head that a block or a divider
  // is HOLDING. It is applied only then: a flick across the field must reach
  // the far lane, so a free head never has its target clipped, and a head
  // pressed against a block never banks the push.
  const AIM_SLACK = 40;
  // A drag of one screen unit moves the head this much. Relative, never
  // absolute: the head goes where the finger has pushed it, not where it is.
  const AIM_GAIN = 1.45;
  const DEATH_SUBMIT_STEPS = 56;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const hudEl = document.getElementById('hud');
  const scoreEl = document.getElementById('score');
  const perfEl = document.getElementById('perf');
  const menuEl = document.getElementById('menu');
  const playBtn = document.getElementById('playBtn');
  const playLabel = document.getElementById('playLabel');
  const playSpin = document.getElementById('playSpin');
  const overEl = document.getElementById('gameOver');
  const finalScoreEl = document.getElementById('finalScore');
  const retryBtn = document.getElementById('retryBtn');

  let sim = initSim(null);
  let state = 'menu';            // menu | play | over
  let sessionReady = false;
  let traceVersion = 0;
  let lastFrameTime = null;      // null, never a negative number: a shifted
  let accumulator = 0;           // performance.now() can itself be negative
  let frameAvg = 0;
  let clockLag = 0;
  let deathWait = 0;
  let submitted = false;

  const pointer = { down: false, x: 0 };
  let activePointer = null;
  let wasDown = false;
  let aimX = START_X;
  let aimAcc = 0;
  let lastFingerX = 0;
  let pathF = -1;
  let pathX = [];

  // REPLAY (admin run viewer, games/_shared/kj-replay.js): the recorded touch /
  // lift markers and path batches drive the run exactly as the server's replay
  // reads them, real input is ignored, and the run starts itself. Nothing is
  // emitted. Per step: down comes from the markers (a marker naming step N holds
  // from step N on), the head target from the path sample for that step, and a
  // step with no sample keeps the last one, as the server's advanceTo does.
  const RP = (window.KJReplay && window.KJReplay.active()) ? window.KJReplay : null;
  let replayMarks = [];
  let replayAt = 0;
  let replayDown = false;
  let replayX = START_X;
  let replayXs = null;
  if (RP) RP.ready('snake-blocks');
  function buildReplay() {
    replayMarks = [];
    replayXs = new Map();
    RP.events().forEach(function (e) {
      if (e.kind === 'touch' || e.kind === 'lift') replayMarks.push({ at: Number(e.step), down: e.kind === 'touch' });
      else if (e.kind === 'path' && Array.isArray(e.x)) {
        for (let i = 0; i < e.x.length; i++) replayXs.set(Number(e.f) + 1 + i, Number(e.x[i]));
      }
    });
    replayAt = 0;
    replayDown = false;
    replayX = START_X;
  }
  function replayInput(step) {
    while (replayAt < replayMarks.length && replayMarks[replayAt].at <= step) replayDown = replayMarks[replayAt++].down;
    const x = replayXs.get(step);
    if (x !== undefined) replayX = x;
  }

  let viewW = 0, viewH = 0, dpr = 1, scale = 1, offX = 0, offY = 0;

  // ── view ───────────────────────────────────────────────────────────────
  // Sized from the page's OWN box, never Math.max across viewport sources. A
  // resize that changes nothing touches nothing: assigning canvas.width clears
  // and reallocates the backing store, and iOS fires resize repeatedly while
  // its toolbar settles.
  function resize() {
    const el = document.documentElement;
    const w = Math.max(1, Math.round((el && el.clientWidth) || window.innerWidth || FIELD_W));
    const h = Math.max(1, Math.round((el && el.clientHeight) || window.innerHeight || FIELD_H));
    const d = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    if (w === viewW && h === viewH && d === dpr) return;
    viewW = w; viewH = h; dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    scale = Math.min(w / FIELD_W, h / FIELD_H);
    offX = (w - FIELD_W * scale) / 2;
    offY = (h - FIELD_H * scale) / 2;
    onViewChanged();
  }

  // ── platform plumbing ──────────────────────────────────────────────────
  function onSessionReady() {
    sessionReady = true;
    if (playBtn) playBtn.disabled = false;
    if (playLabel) playLabel.textContent = 'PLAY';
    if (playSpin) playSpin.classList.add('is-hidden');
  }
  if (typeof window.__kjOnSessionReady === 'function') window.__kjOnSessionReady(onSessionReady);
  else onSessionReady();

  function canEmit(hook) {
    return !(traceVersion < 2 || typeof window[hook] !== 'function');
  }

  function flushPath() {
    if (pathX.length > 0 && canEmit('__kjPath')) {
      try { window.__kjPath(performance.now(), pathF, pathX); } catch (_e) { /* ignore */ }
    }
    pathX = [];
    pathF = -1;
  }
  // The bridge calls this right before it submits, so an open batch can never
  // be stranded outside the trace whoever called submit.
  window.__kjFlush = flushPath;

  function emitMarker(kind, step) {
    if (!canEmit('__kjMarker')) return;
    try { window.__kjMarker(performance.now(), kind, step); } catch (_e) { /* ignore */ }
  }

  function start() {
    if (!sessionReady || state === 'play') return;
    if (state === 'over' && window.__kjEmbed) return;   // the Result screen owns "play again"
    sim = initSim(typeof window.__kjSeed === 'string' ? window.__kjSeed : null);
    state = 'play';
    accumulator = 0;
    deathWait = 0;
    submitted = false;
    wasDown = false;
    aimX = START_X;
    aimAcc = 0;
    pathX = [];
    pathF = -1;
    releaseAll();
    resetEffects();
    if (menuEl) menuEl.classList.add('is-hidden');
    if (overEl) overEl.classList.add('is-hidden');
    if (hudEl) hudEl.classList.remove('is-hidden');
    traceVersion = (typeof window.__kjGameStart === 'function')
      ? (Number(window.__kjGameStart(performance.now(), 2)) || 0) : 0;
    if (RP) { traceVersion = RP.capVersion(traceVersion); buildReplay(); RP.started(traceVersion); }
    updateScore();
    restoreAudio();
    sfxStart();
  }

  // The chain shatters before the score is sent: sending it hands the screen
  // to the platform's result, so the death has to play out first.
  function endGame() {
    if (submitted) return;
    submitted = true;
    state = 'over';
    releaseAll();
    flushPath();
    fadeOutAudio();
    if (RP) RP.setStep(sim.frames);
    if (typeof window.__kjSubmit === 'function') window.__kjSubmit(sim.score);
    if (finalScoreEl) finalScoreEl.textContent = String(sim.score);
    if (overEl && !window.__kjEmbed) overEl.classList.remove('is-hidden');
    if (hudEl) hudEl.classList.add('is-hidden');
  }

  // One fixed step. The steer target is read ONCE, the rules chase it at
  // HEAD_MAX_STEP, and the head's position AFTER the step is what goes into
  // the trace: exactly the value the server will apply, so its own chase and
  // its own clamps are a no-op on an honest sample.
  function tick() {
    const step = sim.frames + 1;
    let down = pointer.down;
    if (RP) { replayInput(step); down = replayDown; aimX = replayX; }
    if (!RP && down !== wasDown) {
      flushPath();
      emitMarker(down ? 'touch' : 'lift', step);
      wasDown = down;
    }
    const px = sim.hx;
    const wanted = travelTo(px, aimX);
    snapPrev();
    stepSim(sim, down, aimX);
    if (down && sim.hx !== wanted) {
      const d = aimX - sim.hx;
      if (d > AIM_SLACK) aimX = sim.hx + AIM_SLACK;
      else if (d < -AIM_SLACK) aimX = sim.hx - AIM_SLACK;
    }
    // Only a step that actually ran is a sample: once the run is over the loop
    // keeps ticking for the ending, and recording those would repeat the dying
    // step's position under a step number that never advances.
    if (!RP && down && sim.frames === step) {
      if (pathX.length === 0) pathF = step - 1;
      pathX.push(sim.hx);
      if (pathX.length >= PATH_BATCH_MAX) flushPath();
    }
    afterStep();
    if (RP) RP.report(sim.frames, sim.score);
    if (sim.dead) {
      if (deathWait === 0) onDeath();
      deathWait++;
      if (deathWait >= DEATH_SUBMIT_STEPS) endGame();
    }
  }

  // ── input: ONE finger owns the run, and it steers by pushing ───────────
  function ignoreInput() {
    return !!RP || window.__kjTutorialOpen === true || state !== 'play';
  }

  function pointerIdOf(e) {
    return e && e.pointerId !== undefined ? e.pointerId : 1;
  }

  // The one place the view is read: mapping a touch INTO design units.
  function readPointer(e) {
    let left = 0;
    if (typeof canvas.getBoundingClientRect === 'function') {
      const r = canvas.getBoundingClientRect();
      left = r.left || 0;
    }
    pointer.x = ((Number(e.clientX) || 0) - left - offX) / scale;
  }

  function onPointerDown(e) {
    ensureAudio();
    if (ignoreInput()) return;
    const id = pointerIdOf(e);
    // A second finger is ignored, never punished: a thumb on the bezel must not
    // cost a run.
    if (activePointer !== null && activePointer !== id) return;
    activePointer = id;
    try { if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(id); } catch (_e) { /* ignore */ }
    readPointer(e);
    lastFingerX = pointer.x;
    aimAcc = 0;
    pointer.down = true;
  }

  function onPointerMove(e) {
    if (activePointer === null || pointerIdOf(e) !== activePointer) return;
    readPointer(e);
    aimAcc += (pointer.x - lastFingerX) * AIM_GAIN;
    lastFingerX = pointer.x;
    const m = Math.round(aimAcc);
    if (m === 0) return;
    aimAcc -= m;
    aimX += m;
    if (aimX < X_MIN) aimX = X_MIN;
    if (aimX > X_MAX) aimX = X_MAX;
  }

  function onPointerUp(e) {
    if (activePointer === null || pointerIdOf(e) !== activePointer) return;
    activePointer = null;
    pointer.down = false;
  }

  function releaseAll() {
    activePointer = null;
    pointer.down = false;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onPointerUp);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  // Nothing on the canvas relies on a synthesized click, so the touch itself
  // is cancelled: Safari then never raises the magnifier on a long press or
  // takes a drag over half way (which would fire pointercancel mid-steer).
  const cancelTouch = function (e) { if (e && e.cancelable !== false && e.preventDefault) e.preventDefault(); };
  canvas.addEventListener('touchstart', cancelTouch, { passive: false });
  canvas.addEventListener('touchmove', cancelTouch, { passive: false });
  window.addEventListener('blur', releaseAll);
  window.addEventListener('pagehide', releaseAll);
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { releaseAll(); pauseAudio(); }
      else { lastFrameTime = null; resumeAudio(); }
    });
  } catch (_e) { /* no document */ }
  window.addEventListener('resize', resize);
  // The game has no keyboard controls, so a key must never reach a focused
  // button and start a run the player did not ask for.
  window.addEventListener('keydown', function (e) {
    if (!e || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' || e.code === 'Enter') { if (e.preventDefault) e.preventDefault(); }
  });

  if (playBtn) playBtn.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); start(); });
  if (retryBtn) retryBtn.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); start(); });

  // ── effects ────────────────────────────────────────────────────────────
  // Presentation only. Nothing below this line writes to `sim`: the view keeps
  // its own copy of the course, and its randomness is Math.random, which the
  // parity suite proves cannot reach a score. Every gradient and sprite is
  // built once, never on a frame.
  const TAU = Math.PI * 2;
  const PERF = (function () { try { return /[?&]perf=1\b/.test(String(location.search || '')); } catch (_e) { return false; } })();

  const BALL_GAP = 13.5;
  const TAIL_MAX = 18;
  const TRAIL_MAX = 900;
  const SPR = 2;                 // sprite oversample
  const BLOCK_W = COL_W - 6;
  const BLOCK_H = BLOCK_HQ / U;
  const LIP = 8;                 // how far the block's thickness shows below its face
  const WORLD_ROWS = 26;         // rows per world

  function store(k, v) { try { localStorage.setItem(k, v); } catch (_e) { /* ignore */ } }
  function load(k) { try { return localStorage.getItem(k); } catch (_e) { return null; } }
  function vib(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_e) { /* ignore */ } }

  // ── colour ─────────────────────────────────────────────────────────────
  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function shade(c, k) { return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)]; }
  function mixRGB(a, b, k) {
    return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
  }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // Cool for a number you can shrug off, hot for one that will eat you. The
  // same eight bright colours in every world, so a number reads at a glance
  // wherever you are.
  let BAND_COL = [];
  let FW = '800';
  function bandOf(v, n) {
    const t = v / (2 * valFor(n) + 4);
    const i = Math.floor(t * BAND_COL.length);
    return i < 0 ? 0 : (i >= BAND_COL.length ? BAND_COL.length - 1 : i);
  }

  // ── worlds: a new place every WORLD_ROWS rows ──────────────────────────
  let WORLDS = [];

  // ── skins, unlocked by your best score ─────────────────────────────────
  const SKINS = [{ id: 'viper', name: 'VIPER', a: [26, 196, 106], b: [150, 255, 190], need: 0 }];
  let best = Math.max(0, Number(load('sb_best')) || 0);
  const skin = SKINS[0];

  // ── view state ─────────────────────────────────────────────────────────
  const prev = { scroll: 0, hx: START_X, len: START_LEN, chain: 0 };
  let trail = [];
  let trailArc = 0;
  let fx = [];                   // particles of every kind
  let rings = [];
  let pops = [];
  let banners = [];
  let swallow = [];              // ages of the lumps travelling down the body
  const spring = [0, 0, 0, 0, 0];
  const springV = [0, 0, 0, 0, 0];
  let shake = 0, flash = 0, punch = 0, time = 0;
  let deathT = -1;
  let deathBalls = null;
  let splat = null;
  const MENU_SEED = '7c41a9d2e5b38f610c4d29a7base';
  let menuSeedInt = 0;
  let menuScroll = 0;
  const menuSpecs = new Map();
  let lastScore = 0, lastPicks = 0, lastLen = START_LEN, crunchRun = 0;
  let headPulse = 0, chainT = 0, grindT = 0, dangerT = 0, heartT = 0, speedFx = 0;
  let edgeGlow = null;
  let beatBest = false;
  let worldFrom = 0, worldTo = 0, worldT = 1;
  let worldForce = -1;
  let tilt = 0;
  const viewSpecs = new Map();
  const passed = new Map();
  let lastRowN = 0;
  let lastRowVals = null;
  let lastCrunchAt = 0;

  let blockSpr = null;
  let ballCache = new Map();
  let pickSpr = null;
  let floorCache = new Map();
  let skyCache = new Map();
  let decoCache = new Map();
  let logoCanvas = null;
  let vigCanvas = null, vigW = 0, vigH = 0;
  let dangerW = 0, dangerH = 0;

  function viewSpec(n) {
    let s = viewSpecs.get(n);
    if (s === undefined) {
      if (viewSpecs.size > 64) viewSpecs.clear();
      s = rowSpec(sim.seedInt, n);
      viewSpecs.set(n, s);
    }
    return s;
  }

  function roundRect(g, x, y, w, h, r) {
    const k = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + k, y);
    g.lineTo(x + w - k, y);
    g.quadraticCurveTo(x + w, y, x + w, y + k);
    g.lineTo(x + w, y + h - k);
    g.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
    g.lineTo(x + k, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - k);
    g.lineTo(x, y + k);
    g.quadraticCurveTo(x, y, x + k, y);
    g.closePath();
  }
  function offscreen(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  function star4(g, r, w) {
    g.beginPath();
    g.moveTo(0, -r); g.lineTo(w, -w); g.lineTo(r, 0); g.lineTo(w, w);
    g.lineTo(0, r); g.lineTo(-w, w); g.lineTo(-r, 0); g.lineTo(-w, -w);
    g.closePath();
  }
  const FONT = "'Arial Black', 'Helvetica Neue', Arial, system-ui, sans-serif";
  function outlinedText(g, txt, x, y, size, fill, stroke, lw) {
    g.font = FW + ' ' + size + 'px ' + FONT;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = lw;
    g.strokeStyle = stroke;
    g.strokeText(txt, x, y);
    g.fillStyle = fill;
    g.fillText(txt, x, y);
  }


  // ── themes: the same game, a different world ───────────────────────────
  function makeBlockJelly(c) {
    const pad = 18, w = BLOCK_W, h = BLOCK_H, face = h - LIP, R = 22;
    const cv = offscreen((w + pad * 2) * SPR, (h + pad * 2) * SPR);
    const g = cv.getContext('2d');
    g.scale(SPR, SPR); g.translate(pad, pad);
    g.save();
    g.shadowColor = rgba(c, 0.9); g.shadowBlur = 20;
    const rg = g.createRadialGradient(w / 2, face * 0.38, 4, w / 2, face * 0.55, w * 0.62);
    rg.addColorStop(0, rgba(mixRGB(c, [255, 255, 255], 0.55), 0.95));
    rg.addColorStop(0.55, rgba(c, 0.82));
    rg.addColorStop(1, rgba(shade(c, 0.5), 0.9));
    g.fillStyle = rg; roundRect(g, 0, 2, w, face, R); g.fill();
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1.6; roundRect(g, 0.8, 2.8, w - 1.6, face - 1.6, R - 1); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.beginPath(); g.ellipse(w * 0.3, 11, w * 0.2, 4.5, -0.15, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.22)';
    for (const [x, y, r] of [[w * 0.78, face * 0.62, 3], [w * 0.86, face * 0.42, 1.8], [w * 0.2, face * 0.74, 2.2]]) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
    return { c: cv, pad: pad, w: w, h: h, ink: rgba(shade(c, 0.28), 0.95), col: c, num: '#ffffff', nlw: 5 };
  }

  function makeBlock(c) { return makeBlockJelly(c); }

  function ballSprite(col) {
    const key = col.join(',');
    let s = ballCache.get(key);
    if (s) return s;
    if (ballCache.size > 80) ballCache.clear();
    const R = 16, o = R + 8;
    const cv = offscreen(o * 2 * SPR, o * 2 * SPR);
    const g = cv.getContext('2d');
    g.scale(SPR, SPR); g.translate(o, o);
    g.save(); g.shadowColor = rgba(col, 0.95); g.shadowBlur = 14;
    g.beginPath(); g.arc(0, 0, R - 1, 0, TAU);
    const rg = g.createRadialGradient(-3, -4, 1, 0, 0, R);
    rg.addColorStop(0, rgba(mixRGB(col, [255, 255, 255], 0.85), 0.98));
    rg.addColorStop(0.5, rgba(col, 0.85));
    rg.addColorStop(1, rgba(shade(col, 0.55), 0.55));
    g.fillStyle = rg; g.fill(); g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1.2; g.beginPath(); g.arc(0, 0, R - 1.5, 0, TAU); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.ellipse(-5, -6, 4.5, 2.2, -0.6, 0, TAU); g.fill();
    s = { c: cv, o: o };
    ballCache.set(key, s);
    return s;
  }

  function floorSprite(wi, parity) {
    const key = wi * 2 + parity;
    let s = floorCache.get(key);
    if (s) return s;
    const h = ROW_HQ / U;
    const cv = offscreen(FIELD_W * SPR, h * SPR);
    const g = cv.getContext('2d');
    g.scale(SPR, SPR);
    for (let c = 0; c < COLS; c++) {
      g.fillStyle = 'rgba(150,235,255,' + (((c + parity) % 2) ? 0.045 : 0.075) + ')';
      roundRect(g, colLeft(c) + 3, 4, COL_W - 6, h - 8, 22); g.fill();
      g.strokeStyle = 'rgba(170,245,255,0.13)'; g.lineWidth = 1.2;
      roundRect(g, colLeft(c) + 3.6, 4.6, COL_W - 7.2, h - 9.2, 21.5); g.stroke();
    }
    s = cv;
    floorCache.set(key, s);
    return s;
  }

  const THEME_DEFS = {
    ocean: { id: 'ocean', fw: '800', block: 'jelly', ball: 'orb', floor: 'water', sky: 'rays',
      worlds: [
        { name: 'TWILIGHT ZONE', sky: ['#04284f', '#05476b', '#0a8296'], lane: [[255, 255, 255, 0.05], [255, 255, 255, 0.03]], rail: [120, 235, 255], glow: [60, 200, 255], deco: 'bubble' },
        { name: 'MIDNIGHT ZONE', sky: ['#010a1f', '#031c3e', '#06406a'], lane: [[255, 255, 255, 0.05], [255, 255, 255, 0.03]], rail: [90, 200, 255], glow: [30, 140, 255], deco: 'plankton' },
        { name: 'THE ABYSS', sky: ['#00030c', '#020e26', '#101f4a'], lane: [[255, 255, 255, 0.05], [255, 255, 255, 0.03]], rail: [150, 150, 255], glow: [110, 90, 255], deco: 'plankton' },
        { name: 'CORAL REEF', sky: ['#055270', '#078aa0', '#35d0b8'], lane: [[255, 255, 255, 0.05], [255, 255, 255, 0.03]], rail: [160, 255, 230], glow: [60, 240, 200], deco: 'bubble' },
      ],
      band: [[90, 235, 255], [60, 245, 200], [150, 255, 140], [230, 255, 110], [255, 210, 110], [255, 150, 140], [255, 110, 210], [180, 130, 255]],
      logo: [['#e8ffff', '#6fe6ff', '#064a6a', '#021a2a'], ['#bfffe8', '#2fe0b0', '#06503e', '#021a2a']] },
  };
  let TH = THEME_DEFS.ocean;

  function readThemeId() { return 'ocean'; }

  function applyTheme(id) {
    TH = THEME_DEFS.ocean;
    WORLDS = TH.worlds;
    BAND_COL = TH.band;
    FW = TH.fw;
    ballCache.clear(); floorCache.clear(); skyCache.clear(); decoCache.clear();
    logoCanvas = null;
    try { document.body.setAttribute('data-theme', TH.id); } catch (_e) { /* ignore */ }
    buildSprites();
  }

  // ── sprites, built once ────────────────────────────────────────────────
  function buildBlockSprites() { blockSpr = BAND_COL.map(makeBlock); }

  // One glossy ball. Sprites are cached by colour, so a rainbow body costs a
  // fixed handful of them rather than one per frame.
  function bodyColor(i) {
    return i % 2 === 0 ? skin.a : mixRGB(skin.a, skin.b, 0.3);
  }
  function headColor() {
    return mixRGB(skin.a, skin.b, 0.55);
  }

  function buildPickSprite() {
    const R = 17, o = R + 8;
    const cv = offscreen(o * 2 * SPR, o * 2 * SPR);
    const g = cv.getContext('2d');
    g.scale(SPR, SPR);
    g.translate(o, o);
    g.save();
    g.shadowColor = 'rgba(255,200,50,0.95)'; g.shadowBlur = 12;
    g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fillStyle = '#ffcf3a'; g.fill();
    g.restore();
    const rg = g.createRadialGradient(-5, -6, 1, 0, 0, R);
    rg.addColorStop(0, '#fff7c0'); rg.addColorStop(0.45, '#ffc728'); rg.addColorStop(1, '#a86a00');
    g.beginPath(); g.arc(0, 0, R - 1, 0, TAU); g.fillStyle = rg; g.fill();
    g.strokeStyle = '#fff1a8'; g.lineWidth = 1.8; g.stroke();
    g.strokeStyle = 'rgba(120,70,0,0.55)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(0, 0, R - 5, 0, TAU); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.beginPath(); g.ellipse(-5.5, -7, 5, 2.4, -0.6, 0, TAU); g.fill();
    pickSpr = { c: cv, o: o };
  }

  function buildSprites() {
    buildBlockSprites();
    buildPickSprite();
    ballCache.clear();
  }

  // The floor of one world: five rounded lanes per row, two rows alternating.
  function skyCanvas(wi) {
    const key = wi + ':' + viewW + 'x' + viewH;
    let c = skyCache.get(key);
    if (c) return c;
    if (skyCache.size > 8) skyCache.clear();
    const W = WORLDS[wi];
    const w = Math.max(2, viewW), h = Math.max(2, viewH);
    c = offscreen(w, h);
    const g = c.getContext('2d');
    const lg = g.createLinearGradient(0, 0, 0, h);
    lg.addColorStop(0, W.sky[0]); lg.addColorStop(0.55, W.sky[1]); lg.addColorStop(1, W.sky[2]);
    g.fillStyle = lg; g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w * 0.5, h * 0.18, 10, w * 0.5, h * 0.18, Math.max(w, h) * 0.7);
    rg.addColorStop(0, rgba(W.glow, 0.34)); rg.addColorStop(1, rgba(W.glow, 0));
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
    const rg2 = g.createRadialGradient(w * 0.5, h * 1.02, 10, w * 0.5, h * 1.02, h * 0.6);
    rg2.addColorStop(0, rgba(W.glow, 0.28)); rg2.addColorStop(1, rgba(W.glow, 0));
    g.fillStyle = rg2; g.fillRect(0, 0, w, h);
    if (TH.sky === 'rays') {
      g.save(); g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        const x0 = w * (0.05 + i * 0.19), a = 0.05 + (i % 3) * 0.015;
        const lg2 = g.createLinearGradient(x0, 0, x0 + w * 0.2, h * 0.85);
        lg2.addColorStop(0, 'rgba(200,250,255,' + a * 2 + ')'); lg2.addColorStop(1, 'rgba(200,250,255,0)');
        g.fillStyle = lg2;
        g.beginPath(); g.moveTo(x0, 0); g.lineTo(x0 + w * 0.09, 0); g.lineTo(x0 + w * 0.34, h * 0.85); g.lineTo(x0 + w * 0.12, h * 0.85); g.closePath(); g.fill();
      }
      g.restore();
    }
    skyCache.set(key, c);
    return c;
  }

  function decoItems(wi) {
    let it = decoCache.get(wi);
    if (it) return it;
    it = [];
    const n = 16;
    for (let i = 0; i < n; i++) {
      it.push({ x: Math.random(), y: Math.random(), s: 0.5 + Math.random() * 0.9, v: 0.05 + Math.random() * 0.14, p: Math.random() * TAU, k: Math.floor(Math.random() * 3) });
    }
    decoCache.set(wi, it);
    return it;
  }

  function onViewChanged() {
    skyCache.clear();
    vigCanvas = null;
  }

  // ── particles ──────────────────────────────────────────────────────────
  function addFx(p) { fx.push(p); if (fx.length > 420) fx.splice(0, fx.length - 420); }
  // chunky confetti, the colour of the thing that broke
  function chips(x, y, col, n, spd) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = spd * (0.4 + Math.random() * 0.9);
      addFx({ t: 'chip', x: x + (Math.random() - 0.5) * 30, y: y + (Math.random() - 0.5) * 20, vx: Math.cos(a) * s, vy: Math.sin(a) * s - spd * 0.55,
        r: 3 + Math.random() * 4.5, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 18, life: 0.7 + Math.random() * 0.5, age: 0,
        col: Math.random() < 0.25 ? mixRGB(col, [255, 255, 255], 0.55) : col, g: 1100 });
    }
  }
  function puffs(x, y, n, col) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = 40 + Math.random() * 110;
      addFx({ t: 'puff', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.7, r: 10 + Math.random() * 14, life: 0.45 + Math.random() * 0.25, age: 0, col: col || [255, 255, 255], g: 0 });
    }
  }
  function stars(x, y, col, n, spd) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = spd * (0.4 + Math.random());
      addFx({ t: 'star', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, r: 4 + Math.random() * 6, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 8, life: 0.6 + Math.random() * 0.5, age: 0, col: col, g: 500 });
    }
  }
  function dots(x, y, col, n, spd, r) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = spd * (0.3 + Math.random());
      addFx({ t: 'dot', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: r * (0.6 + Math.random() * 0.8), life: 0.4 + Math.random() * 0.3, age: 0, col: col, g: 300 });
    }
  }
  function ring(x, y, col, r1, life, w) { rings.push({ x: x, y: y, t: 0, life: life, r0: 8, r1: r1, col: col, w: w }); if (rings.length > 14) rings.shift(); }
  function pop(x, y, txt, fill, size) { pops.push({ x: x, y: y, t: 0, n: txt, col: fill, size: size }); if (pops.length > 12) pops.shift(); }
  function banner(text, sub, col, big) { banners.push({ text: text, sub: sub, col: col, t: 0, big: !!big }); if (banners.length > 3) banners.shift(); }

  const CHAIN_WORDS = ['', '', 'NICE', 'SMOOTH', 'BRUTAL', 'SAVAGE', 'RUTHLESS', 'UNREAL', 'LEGENDARY'];

  function startWorld(wi) {
    worldFrom = worldTo;
    worldTo = wi;
    worldT = 0;
    if (sim.rowN > 0) {
      banner('WORLD ' + (Math.floor(sim.rowN / WORLD_ROWS) + 1), WORLDS[wi].name, [255, 255, 255], true);
      punch = Math.max(punch, 0.9); flash = Math.max(flash, 0.5);
      ring(FIELD_W / 2, HEAD_Y - 80, WORLDS[wi].glow, 520, 0.9, 10);
      ring(FIELD_W / 2, HEAD_Y - 80, [255, 255, 255], 420, 0.7, 5);
      sfxWorld();
      vib([20, 40, 20]);
    }
  }

  function resetEffects() {
    fx = []; rings = []; pops = []; banners = []; swallow = [];
    deathT = -1; deathBalls = null; splat = null;
    lastScore = 0; lastPicks = 0; lastLen = sim.len; crunchRun = 0;
    headPulse = 0; chainT = 0; grindT = 0; dangerT = 0; speedFx = 0;
    edgeGlow = null; beatBest = false; punch = 0; shake = 0; flash = 0; tilt = 0;
    worldFrom = worldForce >= 0 ? worldForce : 0; worldTo = worldFrom; worldT = 1;
    for (let i = 0; i < COLS; i++) { spring[i] = 0; springV[i] = 0; }
    viewSpecs.clear();
    passed.clear();
    lastRowN = sim.rowN;
    lastRowVals = null;
    trail = []; trailArc = 0;
    trail.push({ s: 0, x: sim.hx, w: sim.scroll });
    prev.scroll = sim.scroll; prev.hx = sim.hx; prev.len = sim.len; prev.chain = sim.chain;
  }

  function snapPrev() {
    lastRowN = sim.rowN;
    lastRowVals = sim.rowVals;
    prev.scroll = sim.scroll; prev.hx = sim.hx; prev.len = sim.len; prev.chain = sim.chain;
  }

  // ── the trail the body rides on ────────────────────────────────────────
  function pushTrail(x, w) {
    const last = trail.length ? trail[trail.length - 1] : null;
    if (last) {
      const dx = x - last.x;
      const dw = (w - last.w) / U;
      const d = Math.sqrt(dx * dx + dw * dw);
      if (d < 0.3) return;
      trailArc += d;
    }
    trail.push({ s: trailArc, x: x, w: w });
    if (trail.length > TRAIL_MAX) trail.shift();
  }
  function sampleTrail(s) {
    if (trail.length === 0) return null;
    if (s <= trail[0].s) return trail[0];
    let lo = 0, hi = trail.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (trail[mid].s < s) lo = mid + 1; else hi = mid;
    }
    const b = trail[lo];
    const a = trail[lo > 0 ? lo - 1 : 0];
    const span = b.s - a.s;
    const k = span > 0 ? (s - a.s) / span : 0;
    return { x: a.x + (b.x - a.x) * k, w: a.w + (b.w - a.w) * k };
  }
  function worldY(w, scroll) { return HEAD_Y - (w - scroll) / U; }

  // ── what the rules did on the step just taken ──────────────────────────
  function afterStep() {
    const quiet = sim.dead;
    pushTrail(sim.hx, sim.scroll);
    if (sim.rowN !== lastRowN && lastRowVals) {
      passed.set(lastRowN, lastRowVals);
      if (passed.size > 8) passed.delete(passed.keys().next().value);
    }
    const wi = worldOfRow(sim.rowN);
    if (wi !== worldTo && sim.armed) startWorld(wi);

    const c = sim.evCol;
    const rowY = worldY(sim.rowN * ROW_HQ, sim.scroll);
    const midY = worldY(sim.rowN * ROW_HQ + BLOCK_HQ / 2, sim.scroll);

    if (sim.ev & 1) {
      crunchRun++;
      headPulse = 1;
      if (c >= 0) {
        springV[c] -= 190;
        const col = BAND_COL[bandOf(Math.max(1, (viewSpec(sim.rowN).vals[c] || 1)), sim.rowN)];
        if (crunchRun % 2 === 0) chips(colMid(c) + (Math.random() * 40 - 20), rowY - 4, col, 2, 190);
        if (crunchRun % 3 === 0) puffs(colMid(c), rowY - 2, 1, mixRGB(col, [255, 255, 255], 0.6));
      }
      if (!quiet) sfxCrunch(crunchRun);
    } else if (sim.hitCol < 0) {
      crunchRun = 0;
    }

    if (sim.ev & 2) {
      const x = c >= 0 ? colMid(c) : START_X;
      const col = BAND_COL[c >= 0 ? bandOf(Math.max(1, (viewSpec(sim.rowN).vals[c] || 1)), sim.rowN) : 3];
      chips(x, midY, col, 16 + sim.chain * 2, 340);
      puffs(x, midY, 7);
      stars(x, midY, [255, 238, 150], 5 + sim.chain * 2, 300);
      ring(x, midY, mixRGB(col, [255, 255, 255], 0.4), 150, 0.4, 6);
      shake = Math.max(shake, 6 + sim.chain * 1.5);
      punch = Math.max(punch, Math.min(1, 0.4 + sim.chain * 0.12));
      flash = Math.max(flash, 0.22);
      if (sim.chain >= 2) {
        edgeGlow = { col: col, t: 1 };
        if (sim.chain !== prev.chain) {
          chainT = 1;
          if (sim.chain >= 3) banner(CHAIN_WORDS[Math.min(8, sim.chain)], 'x' + sim.chain + ' CHAIN', [255, 225, 70], false);
        }
        ring(x, midY, [255, 255, 255], 240, 0.55, 4);
      }
      if (!quiet) sfxBreak(sim.chain);
      vib(sim.chain >= 4 ? 28 : 14);
    }

    if (sim.picks !== lastPicks) {
      lastPicks = sim.picks;
      const px = c >= 0 ? colMid(c) : sim.hx;
      const py = worldY(sim.rowN * ROW_HQ + PICK_YQ, sim.scroll);
      const got = sim.len - prev.len;
      stars(px, py, [255, 226, 90], 9, 220);
      dots(px, py, [255, 255, 255], 8, 180, 3);
      ring(px, py, [255, 226, 90], 80, 0.4, 5);
      pop(px, py - 14, '+' + Math.max(1, got), '#ffe58a', 24);
      swallow.push(0);
      if (swallow.length > 4) swallow.shift();
      headPulse = 1.3;
      if (!quiet) sfxPick(got);
      vib(8);
    }

    if (sim.score !== lastScore) {
      const gained = sim.score - lastScore;
      lastScore = sim.score;
      updateScore();
      if ((sim.ev & 2) && c >= 0 && gained > 3) {
        pop(colMid(c), midY - 26, '+' + gained, sim.chain >= 2 ? '#ffe14a' : '#ffffff', sim.chain >= 2 ? 34 : 26);
      }
      if (!beatBest && best > 0 && sim.score > best) {
        beatBest = true;
        banner('NEW BEST!', 'KEEP GOING', [255, 225, 70], true);
        edgeGlow = { col: [255, 225, 70], t: 1 };
        for (let i = 0; i < 5; i++) stars(60 + i * 74, 130 + Math.random() * 60, [255, 226, 90], 4, 160);
        stars(FIELD_W / 2, 200, [255, 226, 90], 14, 300);
        sfxBest();
        vib([30, 40, 30]);
      }
    }
    if (sim.len !== lastLen) { lastLen = sim.len; headPulse = Math.max(headPulse, 0.7); }
    if ((sim.ev & 8) && !quiet) { sfxThud(); dots(sim.hx, HEAD_Y, [255, 255, 255], 3, 70, 2); }
    // a sparkle off the tail now and then
    if (!sim.dead && sim.len > 3 && Math.random() < 0.28) {
      const tp = sampleTrail(trailArc - Math.min(TAIL_MAX, sim.len) * BALL_GAP);
      if (tp) addFx({ t: 'dot', x: tp.x + (Math.random() - 0.5) * 8, y: worldY(tp.w, sim.scroll), vx: (Math.random() - 0.5) * 40, vy: 20 + Math.random() * 30,
        r: 2 + Math.random() * 2, life: 0.5, age: 0, col: mixRGB(skin.a, [255, 255, 255], 0.55), g: 0 });
    }
  }

  // ── the ending: one hit, one splat ─────────────────────────────────────
  const SPLAT_AT = 0.09;
  const SPLAT_LIFE = 0.5;

  function onDeath() {
    deathT = 0;
    shake = 9; flash = 0.3;
    const balls = [];
    const shown = Math.min(TAIL_MAX, Math.max(0, lastLen + 5));
    for (let i = 1; i <= shown; i++) {
      const p = sampleTrail(trailArc - i * BALL_GAP);
      if (!p) break;
      const y = worldY(p.w, sim.scroll);
      if (y > FIELD_H + 80) break;
      balls.push({ x: p.x, y: y, order: i });
    }
    deathBalls = balls;
    const lobes = [];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + Math.random() * 0.6;
      const d = 8 + Math.random() * 28;
      lobes.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.72, r: 14 + Math.random() * 20 });
    }
    const drops = [];
    const n = 18 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + (Math.random() - 0.5) * 0.5;
      drops.push({ a: a, dist: 44 + Math.random() * 100, r: 2.6 + Math.random() * 5.4, tail: 0.9 + Math.random() * 1.8 });
    }
    splat = { x: sim.hx, y: HEAD_Y, lobes: lobes, drops: drops };
    if (sim.score > best) { best = sim.score; store('sb_best', String(best)); }
    sfxSplat();
    vib(60);
  }

  function drawDeath() {
    if (!splat) return;
    const col = skin.a;
    const core = mixRGB(col, [255, 255, 255], 0.5);
    if (deathT < SPLAT_AT) {
      const k = deathT / SPLAT_AT, e = k * k;
      for (const b of deathBalls) {
        const spr = ballSprite(bodyColor(b.order));
        const size = spr.o * 2 * 0.8 * (1 - 0.35 * e);
        ctx.drawImage(spr.c, b.x + (splat.x - b.x) * e - size / 2, b.y + (splat.y - b.y) * e - size / 2, size, size);
      }
      drawHead(splat.x, splat.y, 1 + 0.5 * e, true);
      return;
    }
    const p = Math.min(1, (deathT - SPLAT_AT) / SPLAT_LIFE);
    const e = 1 - (1 - p) * (1 - p) * (1 - p);
    const a = p < 0.45 ? 1 : Math.max(0, 1 - (p - 0.45) / 0.55);
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.lineWidth = 3; ctx.strokeStyle = rgb(shade(col, 0.4));
    ctx.fillStyle = rgb(col);
    for (const l of splat.lobes) {
      ctx.beginPath(); ctx.arc(splat.x + l.dx * e, splat.y + l.dy * e, l.r * (0.35 + 0.65 * e), 0, TAU); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = rgb(col);
    for (const l of splat.lobes) {
      ctx.beginPath(); ctx.arc(splat.x + l.dx * e, splat.y + l.dy * e, l.r * (0.35 + 0.65 * e) - 1, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = rgb(core);
    for (let i = 0; i < 4; i++) {
      const l = splat.lobes[i];
      ctx.beginPath(); ctx.arc(splat.x + l.dx * e * 0.5, splat.y + l.dy * e * 0.5, l.r * (0.2 + 0.36 * e), 0, TAU); ctx.fill();
    }
    ctx.fillStyle = rgb(col);
    for (const d of splat.drops) {
      const dist = d.dist * e;
      ctx.save();
      ctx.translate(splat.x + Math.cos(d.a) * dist, splat.y + Math.sin(d.a) * dist * 0.85);
      ctx.rotate(d.a);
      ctx.beginPath(); ctx.ellipse(0, 0, d.r * (1 + d.tail * (1 - e)), d.r, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
    // the face, left behind for a moment
    const fa = Math.max(0, 1 - p * 3);
    if (fa > 0) {
      ctx.globalAlpha = a * fa;
      ctx.strokeStyle = '#2a1050'; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
      for (let sd = -1; sd <= 1; sd += 2) {
        const ex = splat.x + sd * 8, ey = splat.y - 3;
        ctx.beginPath(); ctx.moveTo(ex - 4, ey - 4); ctx.lineTo(ex + 4, ey + 4); ctx.moveTo(ex + 4, ey - 4); ctx.lineTo(ex - 4, ey + 4); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ── the score, and the best ────────────────────────────────────────────
  const bestEl = document.getElementById('best');
  const bestNumEl = document.getElementById('bestNum');
  function updateScore() {
    if (scoreEl) {
      scoreEl.textContent = String(sim.score);
      scoreEl.classList.add('is-pop');
      setTimeout(function () { if (scoreEl) scoreEl.classList.remove('is-pop'); }, 100);
    }
    if (bestEl) {
      bestEl.textContent = beatBest ? 'NEW BEST!' : 'BEST ' + best;
      bestEl.classList.toggle('is-new', beatBest);
    }
  }

  // ── audio: synthesised, no files ───────────────────────────────────────
  // C major pentatonic with a bright marimba voice and a small hall, so every
  // sound the player causes is a note in the same key as the music under it.
  let actx = null, bus = null, wetIn = null, delayIn = null;
  let sendAmt = 0.2, sendDelay = 0;

  function ensureAudio() {
    try {
      if (!actx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        actx = new AC();
        bus = actx.createGain();
        bus.gain.value = 0.55;
        const comp = actx.createDynamicsCompressor();
        comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
        bus.connect(comp); comp.connect(actx.destination);
        try {
          const len = Math.floor(actx.sampleRate * 1.3);
          const ir = actx.createBuffer(2, len, actx.sampleRate);
          for (let c = 0; c < 2; c++) {
            const d = ir.getChannelData(c);
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8);
          }
          const conv = actx.createConvolver(); conv.buffer = ir;
          const wet = actx.createGain(); wet.gain.value = 0.7;
          wetIn = actx.createGain();
          wetIn.connect(conv); conv.connect(wet); wet.connect(bus);
          const dl = actx.createDelay(1); dl.delayTime.value = 0.25;
          const fb = actx.createGain(); fb.gain.value = 0.3;
          const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
          delayIn = actx.createGain();
          delayIn.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(bus);
        } catch (_e) { wetIn = null; delayIn = null; }
      }
      if (actx.state === 'suspended') actx.resume().catch(function () {});
    } catch (_e) { actx = null; }
  }
  function pauseAudio() { try { if (actx && actx.state === 'running') actx.suspend(); } catch (_e) { /* ignore */ } }
  function resumeAudio() { try { if (actx && actx.state === 'suspended') actx.resume(); } catch (_e) { /* ignore */ } }
  // Sending the score hands the screen to the platform's result: nothing of
  // ours may still be ringing when it does.
  function fadeOutAudio() {
    if (!actx || !bus) return;
    try {
      const t0 = actx.currentTime;
      bus.gain.cancelScheduledValues(t0);
      bus.gain.setValueAtTime(bus.gain.value, t0);
      bus.gain.linearRampToValueAtTime(0.0001, t0 + 0.4);
      setTimeout(function () { try { if (actx && actx.state === 'running') actx.suspend(); } catch (_e) { /* ignore */ } }, 480);
    } catch (_e) { /* ignore */ }
  }
  function restoreAudio() {
    ensureAudio();
    try { if (bus) { bus.gain.cancelScheduledValues(actx.currentTime); bus.gain.setValueAtTime(0.55, actx.currentTime); } } catch (_e) { /* ignore */ }
  }
  window.addEventListener('touchend', ensureAudio, { passive: true });
  window.addEventListener('click', ensureAudio, { passive: true });

  function tone(freq, dur, type, gain, sweepTo, delay) {
    if (!actx || !bus) return;
    try {
      const t0 = actx.currentTime + (delay || 0);
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(bus);
      if (wetIn && sendAmt > 0) { const sg = actx.createGain(); sg.gain.value = sendAmt; g.connect(sg); sg.connect(wetIn); }
      if (delayIn && sendDelay > 0) { const dg = actx.createGain(); dg.gain.value = sendDelay; g.connect(dg); dg.connect(delayIn); }
      o.start(t0); o.stop(t0 + dur + 0.03);
    } catch (_e) { /* ignore */ }
  }
  function noise(dur, gain, cut, type, delay) {
    if (!actx || !bus) return;
    try {
      const t0 = actx.currentTime + (delay || 0);
      const n = Math.max(1, Math.floor(actx.sampleRate * dur));
      const buf = actx.createBuffer(1, n, actx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = actx.createBufferSource();
      src.buffer = buf;
      const f = actx.createBiquadFilter();
      f.type = type || 'lowpass';
      f.frequency.value = cut || 1800;
      const g = actx.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(bus);
      if (wetIn && sendAmt > 0.15) { const sg = actx.createGain(); sg.gain.value = sendAmt * 0.5; g.connect(sg); sg.connect(wetIn); }
      src.start(t0);
    } catch (_e) { /* ignore */ }
  }

  const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29];
  function nt(i, base) { return (base || 261.63) * Math.pow(2, PENTA[clamp(i, 0, PENTA.length - 1)] / 12); }
  // a marimba: a clean attack, a woody second partial, and a bell on top
  function mallet(f, gain, dur, send, delaySend) {
    const ps = sendAmt, pd = sendDelay;
    sendAmt = send == null ? 0.28 : send; sendDelay = delaySend || 0;
    tone(f, dur || 0.3, 'sine', gain);
    tone(f * 4, (dur || 0.3) * 0.25, 'sine', gain * 0.35);
    tone(f * 2, (dur || 0.3) * 0.5, 'triangle', gain * 0.3);
    sendAmt = ps; sendDelay = pd;
  }
  function kick(g, d) { tone(150, 0.16, 'sine', g, 44, d); noise(0.012, g * 0.3, 2400, 'lowpass', d); }

  function sfxStart() {
    sendAmt = 0.4;
    tone(180, 0.35, 'triangle', 0.08, 900);
    for (let k = 0; k < 4; k++) mallet(nt(k * 2, 261.63), 0.14, 0.45, 0.45, 0.3);
    sendAmt = 0.2;
  }
  // chewing a block climbs the scale: a little tune, not a machine gun
  function sfxCrunch(i) {
    if (!actx) return;
    const now = actx.currentTime;
    if (now - lastCrunchAt < 0.07) return;
    lastCrunchAt = now;
    mallet(nt(Math.min(12, Math.floor(i / 3)), 261.63), 0.13, 0.22, 0.22);
    noise(0.03, 0.04, 2800, 'bandpass');
  }
  function sfxBreak(chain) {
    const c = clamp(chain, 1, 8);
    sendAmt = 0.35;
    tone(260, 0.12, 'sine', 0.2, 80);                      // the pop
    noise(0.1, 0.18, 4200, 'bandpass');
    kick(0.26);
    const r = 1 + c;
    mallet(nt(r), 0.16, 0.5, 0.5, 0.25);
    mallet(nt(r + 2), 0.14, 0.5, 0.5, 0.25);
    mallet(nt(r + 4), 0.12, 0.5, 0.5, 0.25);
    for (let k = 0; k < Math.min(4, c); k++) tone(nt(r + 4 + k, 523.25), 0.18, 'sine', 0.05, 0, 0.05 + k * 0.05);
    if (c >= 3) { tone(240, 0.35, 'sawtooth', 0.035, 1500); noise(0.35, 0.04, 9000, 'highpass'); }
    if (c >= 5) mallet(nt(r + 7, 523.25), 0.14, 0.8, 0.6, 0.4);
    sendAmt = 0.2;
  }
  function sfxPick(v) {
    sendAmt = 0.35;
    tone(420, 0.14, 'sine', 0.15, 980);
    const steps = clamp(Math.round(v / 3), 2, 5);
    for (let i = 0; i < steps; i++) tone(nt(5 + i, 523.25), 0.14, 'triangle', 0.08, 0, 0.07 + i * 0.05);
    noise(0.06, 0.03, 9000, 'highpass', 0.05);
    sendAmt = 0.2;
  }
  function sfxWorld() {
    sendAmt = 0.55; sendDelay = 0.3;
    for (let k = 0; k < 6; k++) mallet(nt(2 + k + (k > 3 ? 1 : 0), 261.63), 0.15, 0.6, 0.6, 0.35);
    tone(120, 0.7, 'sawtooth', 0.045, 1900);
    kick(0.28);
    sendAmt = 0.2; sendDelay = 0;
  }
  function sfxBest() {
    sendAmt = 0.55; sendDelay = 0.3;
    for (let k = 0; k < 5; k++) mallet(nt(4 + k * 2, 261.63), 0.16, 0.7, 0.6, 0.4);
    kick(0.28);
    sendAmt = 0.2; sendDelay = 0;
  }
  function sfxThud() { tone(90, 0.08, 'sine', 0.1); noise(0.05, 0.04, 700); }
  // One soft, low bonk. A single voice, eased in so it does not click.
  function sfxSplat() {
    if (!actx || !bus) return;
    try {
      const t0 = actx.currentTime;
      const o = actx.createOscillator();
      const f = actx.createBiquadFilter();
      const g = actx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(190, t0);
      o.frequency.exponentialRampToValueAtTime(70, t0 + 0.22);
      f.type = 'lowpass'; f.frequency.value = 520;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.1, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.36);
      o.connect(f); f.connect(g); g.connect(bus);
      o.start(t0); o.stop(t0 + 0.4);
    } catch (_e) { /* ignore */ }
  }

  // The music: C - G - Am - F at 118 BPM, bass and a bouncy marimba arpeggio.
  // It leans in as you speed up, and it never plays over the ending.
  const BASS = [65.41, 51.91, 38.89, 58.27];
  const CHORD = [[0, 3, 7, 12], [-4, 0, 3, 8], [-9, -5, -2, 3], [-2, 2, 5, 10]];
  const ARP_ORDER = [0, 1, 2, 3, 2, 1, 2, 3];
  let musicT = 0, musicStep = 0;
  function driveMusic(on, k) {
    if (!actx || !bus) return;
    if (!on) { musicT = 0; return; }
    const now = actx.currentTime;
    if (musicT === 0 || musicT < now - 0.5) { musicT = now + 0.06; musicStep = 0; }
    const eighth = 60 / (112 + 24 * k) / 2;
    while (musicT < now + 0.3) {
      const d = Math.max(0, musicT - now);
      const bar = Math.floor(musicStep / 8) % 4;
      const st = musicStep % 8;
      sendAmt = 0.14;
      if (st % 2 === 0) kick(0.13, d);
      if (st === 2 || st === 6) noise(0.07, 0.05, 3200, 'bandpass', d);
      noise(0.02, 0.014 + 0.012 * k, 8500, 'highpass', d);
      if (st === 0 || st === 3 || st === 4 || st === 7) tone(BASS[bar], eighth * 1.7, 'triangle', 0.11, 0, d);
      if (st === 0) { sendAmt = 0.6; for (let q = 0; q < 3; q++) tone(261.63 * Math.pow(2, CHORD[bar][q] / 12), eighth * 7.5, 'sine', 0.02, 0, d); }
      sendAmt = 0.3; sendDelay = 0.26;
      const semi = CHORD[bar][ARP_ORDER[st]];
      mallet(261.63 * Math.pow(2, semi / 12) * 2, 0.028 + 0.02 * k, eighth * 1.6, 0.3, 0.26);
      sendAmt = 0.2; sendDelay = 0;
      musicT += eighth;
      musicStep++;
    }
  }
  function driveAudio() {
    if (!actx) return;
    try {
      const on = state === 'play' && sim.armed && !sim.dead;
      const k = on ? clamp((sim.speed - SPEED_BASE) / Math.max(1, SPEED_CAP - SPEED_BASE), 0, 1) : 0;
      driveMusic(on, k);
    } catch (_e) { /* ignore */ }
  }

  // ── drawing ────────────────────────────────────────────────────────────
  function worldOfRow(n) {
    if (worldForce >= 0) return worldForce;
    return ((Math.floor(n / WORLD_ROWS) % WORLDS.length) + WORLDS.length) % WORLDS.length;
  }

  function drawDeco(wi, a, vScroll) {
    if (a <= 0.01) return;
    const items = decoItems(wi);
    const W = WORLDS[wi];
    const sc = vScroll / U;
    const span = viewH + 260;
    ctx.save();
    ctx.globalAlpha = a;
    for (const it of items) {
      const y = ((it.y * span + sc * it.v) % span + span) % span - 130;
      const x = it.x * viewW + Math.sin(time * 0.4 + it.p) * 14;
      const s = 20 * it.s;
      ctx.globalCompositeOperation = 'lighter';
      switch (W.deco) {
        case 'bubble': {
          const by = ((it.y * span - time * (14 + it.s * 18) + sc * it.v * 0.3) % span + span) % span - 130;
          ctx.strokeStyle = 'rgba(210,250,255,0.4)'; ctx.lineWidth = 1.5; ctx.fillStyle = 'rgba(210,250,255,0.07)';
          ctx.beginPath(); ctx.arc(x, by, s * 0.5, 0, TAU); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, by, s * 0.33, 3.7, 4.6); ctx.stroke();
          break;
        }
        case 'plankton': {
          const py = ((it.y * span - time * 10 + sc * it.v * 0.2) % span + span) % span - 130;
          const pg = ctx.createRadialGradient(x, py, 0, x, py, s * 0.45);
          pg.addColorStop(0, rgba(W.glow, 0.9)); pg.addColorStop(1, rgba(W.glow, 0));
          ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(x, py, s * 0.45, 0, TAU); ctx.fill();
          break;
        }
        default: {
          const eg = ctx.createRadialGradient(x, y, 0, x, y, s * 0.8);
          eg.addColorStop(0, rgba(W.glow, 0.85)); eg.addColorStop(1, rgba(W.glow, 0));
          ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(x, y, s * 0.8, 0, TAU); ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  function drawFloor(vScroll) {
    const nLo = Math.floor((vScroll - (FIELD_H - HEAD_Y + 260) * U) / ROW_HQ);
    const nHi = Math.floor((vScroll + (HEAD_Y + 80) * U) / ROW_HQ);
    const h = ROW_HQ / U;
    for (let n = nLo; n <= nHi; n++) {
      const spr = floorSprite(worldOfRow(n), ((n % 2) + 2) % 2);
      ctx.drawImage(spr, 0, worldY(n * ROW_HQ, vScroll) - h, FIELD_W, h);
    }
    // the rails down both sides
    const W = WORLDS[worldTo];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const top = -offY / scale - 10, hh = viewH / scale + 20;
    ctx.fillStyle = rgba(W.rail, 0.5);
    ctx.fillRect(1, top, 4, hh);
    ctx.fillRect(FIELD_W - 5, top, 4, hh);
    ctx.fillStyle = rgba(W.rail, 0.18);
    ctx.fillRect(-4, top, 14, hh);
    ctx.fillRect(FIELD_W - 10, top, 14, hh);
    ctx.restore();
  }

  // One block, with a face that watches the snake. Calm when you can afford
  // it, frowning when you cannot, squeezed shut while you are chewing it.
  function drawBlock(x, y, v, orig, spr, hx, hy, mood, wob, sq) {
    ctx.save();
    ctx.translate(x + wob, y);
    ctx.scale(sq, 2 - sq);
    ctx.drawImage(spr.c, -spr.w / 2 - spr.pad, -spr.h / 2 - spr.pad, spr.w + spr.pad * 2, spr.h + spr.pad * 2);
    const fh = BLOCK_H - LIP;
    const fy = -BLOCK_H / 2;
    const worn = 1 - v / Math.max(1, orig);
    if (worn > 0.25) {
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(-6, fy + 3); ctx.lineTo(-2, fy + 14); ctx.lineTo(-10, fy + 24); ctx.lineTo(-5, fy + fh - 3);
      if (worn > 0.55) { ctx.moveTo(14, fy + 4); ctx.lineTo(9, fy + 16); ctx.lineTo(17, fy + 28); ctx.lineTo(12, fy + fh - 3); }
      if (worn > 0.8) { ctx.moveTo(-28, fy + 18); ctx.lineTo(-16, fy + 22); ctx.lineTo(-9, fy + 18); }
      ctx.stroke();
    }
    if (mood === 2) {
      ctx.fillStyle = 'rgba(255,255,255,' + (0.2 + 0.14 * Math.sin(time * 40)) + ')';
      roundRect(ctx, -BLOCK_W / 2 + 2, fy + 2, BLOCK_W - 4, fh - 4, 10); ctx.fill();
    } else if (mood === 1) {
      // too big for you: a slow red warning pulse round the edge
      ctx.strokeStyle = 'rgba(255,70,90,' + (0.35 + 0.3 * Math.sin(time * 6)) + ')';
      ctx.lineWidth = 2.4;
      roundRect(ctx, -BLOCK_W / 2 + 1, fy + 1, BLOCK_W - 2, fh - 2, 11); ctx.stroke();
    }
    const fs = v >= 100 ? 24 : (v >= 10 ? 30 : 34);
    outlinedText(ctx, String(v), 0, fy + fh / 2 + 1, fs, spr.num || '#ffffff', spr.ink, spr.nlw == null ? 6 : spr.nlw);
    ctx.restore();
  }

  function drawRows(vScroll, vHx) {
    const wLo = vScroll - 6200;
    const wHi = vScroll + (HEAD_Y + 180) * U;
    const n0 = Math.max(0, Math.floor(wLo / ROW_HQ));
    const n1 = Math.floor(wHi / ROW_HQ);
    const live = state === 'play';
    const affordable = live ? sim.len : 0;
    for (let n = n0; n <= n1; n++) {
      const spec = viewSpec(n);
      const vals = (live && n === sim.rowN && sim.rowVals) ? sim.rowVals : (passed.get(n) || spec.vals);
      const top = worldY(n * ROW_HQ + BLOCK_HQ, vScroll);
      if (spec.walls) drawWalls(spec, n, vScroll);
      if (spec.pick && !(live && n <= sim.lastPick)) drawPick(spec.pick, n, vScroll);
      for (let c = 0; c < COLS; c++) {
        const v = vals[c];
        if (v <= 0) continue;
        const orig = spec.vals[c] || v;
        const spr = blockSpr[bandOf(v, n)];
        const grinding = live && n === sim.rowN && sim.hitCol === c;
        const wob = (live && n === sim.rowN) ? spring[c] : 0;
        const sq = grinding ? 1 + 0.04 * Math.sin(time * 42) : 1;
        let mood = 0;
        if (grinding) mood = 2;
        else if (live && sim.armed && top < HEAD_Y + 40 && v > affordable - 1) mood = 1;
        drawBlock(colMid(c), top + BLOCK_H / 2, v, orig, spr, vHx, HEAD_Y, mood, wob, sq);
      }
    }
  }

  // Candy-striped barriers, not lines: you can see what they are.
  function drawWalls(spec, n, vScroll) {
    const y1 = worldY(n * ROW_HQ - WALL_GAPQ, vScroll);
    const y0 = worldY(n * ROW_HQ - WALL_GAPQ - WALL_LENQ, vScroll);
    const W = WORLDS[worldOfRow(n)];
    for (let b = 1; b < COLS; b++) {
      if (!(spec.walls & (1 << (b - 1)))) continue;
      const x = LANE_X + b * COL_W;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(W.glow, 0.32);
      roundRect(ctx, x - 12, y1 - 3, 24, (y0 - y1) + 6, 12); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      roundRect(ctx, x - 3.5, y1, 7, y0 - y1, 3.5);
      ctx.fillStyle = '#eaf6ff'; ctx.fill();
      ctx.strokeStyle = rgb(mixRGB(W.glow, [255, 255, 255], 0.3)); ctx.lineWidth = 2; ctx.stroke();
      const sh = ((time * 170 + b * 61) % ((y0 - y1) + 60)) - 30;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillRect(x - 1.5, Math.max(y1 + 2, y1 + sh), 3, Math.min(20, y0 - 2 - Math.max(y1 + 2, y1 + sh)));
      ctx.restore();
    }
  }

  function drawPick(pick, n, vScroll) {
    const x = colMid(pick.c);
    const y = worldY(n * ROW_HQ + PICK_YQ, vScroll) + Math.sin(time * 4 + n) * 3;
    const pu = 1 + 0.07 * Math.sin(time * 5 + n);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const gl = ctx.createRadialGradient(x, y, 4, x, y, 40);
    gl.addColorStop(0, 'rgba(255,220,70,0.5)'); gl.addColorStop(1, 'rgba(255,200,40,0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, 40, 0, TAU); ctx.fill();
    ctx.restore();
    const s = pickSpr.o * 2 * pu;
    ctx.drawImage(pickSpr.c, x - s / 2, y - s / 2, s, s);
    for (let i = 0; i < 2; i++) {
      ctx.save();
      ctx.translate(x + Math.cos(time * 2 + i * Math.PI + n) * 22, y + Math.sin(time * 2 + i * Math.PI + n) * 12);
      ctx.rotate(time * 1.4);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.5 + 0.4 * Math.sin(time * 5 + i)) + ')';
      star4(ctx, 5, 1.3); ctx.fill();
      ctx.restore();
    }
    outlinedText(ctx, '+' + pick.v, x, y + 1, 16, '#ffffff', 'rgba(110,60,0,0.95)', 5);
  }

  // ── the snake ──────────────────────────────────────────────────────────
  function ballScale(i, shown) {
    const t = Math.pow((i - 1) / Math.max(1, shown - 1), 0.85);
    let r = lerp(14.8, 8.6, t);
    r *= 1 + 0.05 * Math.sin(time * 9 - i * 0.8);
    for (let k = 0; k < swallow.length; k++) {
      const d = swallow[k] * 24 - i;
      r *= 1 + 0.34 * Math.exp(-(d * d) / 5);
    }
    return r / 16;
  }

  function drawChainBody(pts, shown) {
    // shadows first, so the body never sits on its own
    ctx.fillStyle = 'rgba(0,0,10,0.3)';
    for (let i = shown; i >= 1; i--) {
      const p = pts[i];
      if (!p) continue;
      const r = ballScale(i, shown) * 16;
      ctx.beginPath(); ctx.ellipse(p.x + 3, p.y + 6, r, r * 0.9, 0, 0, TAU); ctx.fill();
    }
    for (let i = shown; i >= 1; i--) {
      const p = pts[i];
      if (!p) continue;
      const spr = ballSprite(bodyColor(i));
      const s = spr.o * 2 * ballScale(i, shown);
      ctx.drawImage(spr.c, p.x - s / 2, p.y - s / 2, s, s);
    }
  }

  // The face: eyes that look where the snake is going, blink, widen when it is
  // nearly gone, squint on a roll; a mouth that opens as it chews.
  function drawHead(x, y, k, dying) {
    const spr = ballSprite(headColor());
    const VR = 17.5 * k;
    const s = spr.o * 2 * (VR / 16);
    const hit = state === 'play' && sim.hitCol >= 0 && !sim.dead;
    const scared = dangerT > 0.3 && !dying;
    let lx;
    if (state === 'menu') lx = Math.sin(time * 1.1);
    else lx = clamp((aimX - x) / 60, -1, 1);
    const sx = 1 + 0.1 * grindT + 0.06 * headPulse;
    const sy = 1 - 0.13 * grindT - 0.04 * headPulse;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dying ? 0 : tilt);
    ctx.scale(sx, sy);
    ctx.drawImage(spr.c, -s / 2, -s / 2, s, s);
    const kk = VR / 17.5;
    const eyeCol = scared ? [255, 70, 80] : (hit ? [255, 255, 255] : mixRGB(skin.b, [255, 255, 255], 0.4));
    // two glowing slits that look where you steer
    for (let sd = -1; sd <= 1; sd += 2) {
      const cx = sd * 7.4 * kk + lx * 1.6, cy = -2.4 * kk;
      if (dying) {
        ctx.strokeStyle = '#06101e'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(cx - 3, cy - 3); ctx.lineTo(cx + 3, cy + 3); ctx.moveTo(cx + 3, cy - 3); ctx.lineTo(cx - 3, cy + 3); ctx.stroke();
        continue;
      }
      const w = (hit ? 3.4 : 4.6) * kk, h = (scared ? 6.6 : (hit ? 3.4 : 5.2)) * kk;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(sd * (hit ? -0.5 : -0.28));
      ctx.fillStyle = '#04101c';
      ctx.beginPath(); ctx.ellipse(0, 0, w + 1.6, h + 1.6, 0, 0, TAU); ctx.fill();
      ctx.shadowColor = rgba(eyeCol, 0.95); ctx.shadowBlur = 6;
      ctx.fillStyle = rgb(eyeCol);
      ctx.beginPath(); ctx.ellipse(0, 0, w, h, 0, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#04101c';
      ctx.beginPath(); ctx.ellipse(lx * 0.8, 0, w * 0.28, h * 0.85, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
    // a forked tongue, now and then
    const tf = time % 2.6;
    if (!dying && tf > 2.2 && tf < 2.5) {
      const tl = Math.sin((tf - 2.2) / 0.3 * Math.PI) * 9 * kk;
      ctx.strokeStyle = '#ff3a5c'; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 8 * kk); ctx.lineTo(0, 8 * kk + tl); ctx.lineTo(-2.4, 8 * kk + tl + 2.4); ctx.moveTo(0, 8 * kk + tl); ctx.lineTo(2.4, 8 * kk + tl + 2.4); ctx.stroke();
    }
    ctx.restore();
  }

  function drawSnake(vScroll, vHx) {
    const len = state === 'play' ? sim.len : START_LEN;
    const shown = Math.min(TAIL_MAX, Math.max(0, len - 1));
    if (deathT >= 0) { drawDeath(); return; }
    const gap = BALL_GAP * (1 - 0.3 * grindT);
    const pts = [{ x: vHx, y: HEAD_Y }];
    for (let i = 1; i <= shown; i++) {
      const p = sampleTrail(trailArc - i * gap);
      if (!p) break;
      pts.push({ x: p.x, y: worldY(p.w, vScroll) });
    }
    drawChainBody(pts, shown);
    drawHead(vHx, HEAD_Y, 1, false);
    if (dangerT > 0) {
      ctx.strokeStyle = 'rgba(255,60,90,' + (0.4 + 0.4 * Math.sin(time * 11)) + ')';
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(vHx, HEAD_Y, 26 + 3 * Math.sin(time * 11), 0, TAU); ctx.stroke();
    }
    // the length, in a pill above the head
    const py = HEAD_Y - 38 - 3 * headPulse;
    const txt = String(len);
    ctx.font = FW + ' ' + (len > 99 ? 15 : 18) + 'px ' + FONT;
    const w = Math.max(38, ctx.measureText(txt).width + 22);
    ctx.fillStyle = 'rgba(6,10,26,0.82)';
    roundRect(ctx, vHx - w / 2, py - 14, w, 28, 9); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = rgb(mixRGB(skin.a, skin.b, 0.4)); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, vHx, py + 1);
  }

  // ── particles, rings, words ────────────────────────────────────────────
  function drawFx() {
    for (const r of rings) {
      if (r.t < 0) continue;
      const k = r.t / r.life;
      const rad = r.r0 + (r.r1 - r.r0) * (1 - (1 - k) * (1 - k));
      ctx.strokeStyle = rgba(r.col, Math.max(0, 1 - k) * 0.85);
      ctx.lineWidth = r.w * (1 - k * 0.7);
      ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.stroke();
    }
    for (const p of fx) {
      const a = Math.max(0, 1 - p.age / p.life);
      if (p.t === 'chip') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = rgba(p.col, Math.min(1, a * 1.6));
        ctx.beginPath(); ctx.moveTo(0, -p.r * 1.2); ctx.lineTo(p.r * 0.8, p.r * 0.8); ctx.lineTo(-p.r * 0.8, p.r * 0.8); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.7, a) + ')';
        ctx.beginPath(); ctx.moveTo(0, -p.r * 1.2); ctx.lineTo(p.r * 0.25, 0); ctx.lineTo(-p.r * 0.5, p.r * 0.3); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else if (p.t === 'puff') {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = rgba(p.col, a * 0.22);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + (1 - a) * 1.6), 0, TAU); ctx.fill();
        ctx.restore();
      } else if (p.t === 'star') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = rgba(p.col, Math.min(1, a * 1.5));
        star4(ctx, p.r * (0.5 + a * 0.7), p.r * 0.22); ctx.fill(); ctx.restore();
      } else {
        ctx.fillStyle = rgba(p.col, a);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.4 + a * 0.8), 0, TAU); ctx.fill();
      }
    }
    for (const p of pops) {
      const a = Math.max(0, 1 - p.t / 0.8);
      const sc = 1 + 0.35 * Math.max(0, 1 - p.t * 6);
      ctx.globalAlpha = a;
      outlinedText(ctx, p.n, p.x, p.y - p.t * 60, p.size * sc, p.col, 'rgba(2,6,20,0.9)', 6);
      ctx.globalAlpha = 1;
    }
  }

  function drawBanners() {
    for (let i = 0; i < banners.length; i++) {
      const b = banners[i];
      const k = b.t / 1.6;
      const pop = k < 0.1 ? 0.3 + (k / 0.1) * 1.0 : 1.3 - Math.min(0.3, (k - 0.1) * 1.4);
      const a = k < 0.72 ? 1 : Math.max(0, 1 - (k - 0.72) / 0.28);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(FIELD_W / 2, (b.big ? 215 : 160 + i * 6) - k * 24);
      ctx.scale(pop, pop);
      outlinedText(ctx, b.text, 0, 0, b.big ? 50 : 38, rgb(b.col), 'rgba(2,6,20,0.9)', 9);
      if (b.sub) outlinedText(ctx, b.sub, 0, b.big ? 40 : 31, 16, '#ffffff', 'rgba(2,6,20,0.9)', 5);
      ctx.restore();
    }
  }

  function drawMeter() {
    if (state !== 'play' || sim.dead) return;
    const ch = sim.chain || 0;
    if (ch < 1) return;
    const fill = Math.min(1, ch / CHAIN_MAX);
    const w = 150, h = 12, x = FIELD_W / 2 - w / 2, y = 96;
    ctx.save();
    ctx.fillStyle = 'rgba(4,8,24,0.75)';
    roundRect(ctx, x - 3, y - 3, w + 6, h + 6, 8); ctx.fill();
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#5ff0ff'); g.addColorStop(0.5, '#ffe14a'); g.addColorStop(1, '#ff4f8f');
    ctx.fillStyle = g;
    roundRect(ctx, x, y, Math.max(h, w * fill), h, 6); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    roundRect(ctx, x + 2, y + 1.5, Math.max(h - 4, w * fill - 4), 3.5, 2); ctx.fill();
    ctx.restore();
    outlinedText(ctx, 'CHAIN x' + ch, FIELD_W / 2, y + 28, 14, '#ffe14a', 'rgba(2,6,20,0.9)', 5);
  }

  function drawSpeedLines() {
    if (speedFx < 0.1) return;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < 14; i++) {
      const lane = (i * 0.618034 + 0.13) % 1;
      const x = 12 + lane * (FIELD_W - 24);
      const len = 36 + 110 * speedFx * (0.5 + ((i * 37) % 10) / 10);
      const ph = ((i * 71) % 100) / 100;
      const y = ((time * (420 + 760 * speedFx) * (0.55 + ph * 0.7) + ph * (FIELD_H + 200)) % (FIELD_H + 200)) - 100;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.06 + 0.14 * speedFx) + ')';
      ctx.lineWidth = 1.6 + (i % 3) * 0.8;
      ctx.beginPath(); ctx.moveTo(x, y - len); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawEdgeGlow() {
    if (!edgeGlow) return;
    const a = edgeGlow.t * 0.45, w = 80;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let side = 0; side < 2; side++) {
      const x0 = side ? FIELD_W : 0;
      const g = ctx.createLinearGradient(x0, 0, side ? FIELD_W - w : w, 0);
      g.addColorStop(0, rgba(edgeGlow.col, a)); g.addColorStop(1, rgba(edgeGlow.col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(side ? FIELD_W - w : 0, -offY / scale, w, viewH / scale);
    }
    ctx.restore();
  }

  // ── per-frame cosmetics ────────────────────────────────────────────────
  function updateCosmetics(dt) {
    for (let i = 0; i < COLS; i++) {
      springV[i] += -spring[i] * 320 * dt;
      springV[i] *= Math.max(0, 1 - 11 * dt);
      spring[i] += springV[i] * dt;
    }
    for (let i = fx.length - 1; i >= 0; i--) {
      const p = fx[i];
      p.age += dt;
      if (p.age >= p.life) { fx.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.t === 'puff') { p.vx *= Math.max(0, 1 - 3 * dt); p.vy *= Math.max(0, 1 - 3 * dt); }
      else p.vy += p.g * dt;
      if (p.vr) p.rot += p.vr * dt;
    }
    for (let i = rings.length - 1; i >= 0; i--) { rings[i].t += dt; if (rings[i].t >= rings[i].life) rings.splice(i, 1); }
    for (let i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; if (pops[i].t > 0.8) pops.splice(i, 1); }
    for (let i = banners.length - 1; i >= 0; i--) { banners[i].t += dt; if (banners[i].t > 1.6) banners.splice(i, 1); }
    for (let i = swallow.length - 1; i >= 0; i--) { swallow[i] += dt; if (swallow[i] > 1) swallow.splice(i, 1); }
    if (shake > 0) shake = Math.max(0, shake - dt * 40);
    if (flash > 0) flash = Math.max(0, flash - dt * 3.4);
    if (punch > 0) punch = Math.max(0, punch - dt * 5);
    if (headPulse > 0) headPulse = Math.max(0, headPulse - dt * 6);
    if (chainT > 0) chainT = Math.max(0, chainT - dt * 0.85);
    if (edgeGlow) { edgeGlow.t -= dt * 1.7; if (edgeGlow.t <= 0) edgeGlow = null; }
    if (worldT < 1) worldT = Math.min(1, worldT + dt * 1.1);
    if (deathT >= 0) deathT += dt;
    if (state === 'menu') menuScroll += MENU_SPEED * dt;
    const pushing = state === 'play' && sim.hitCol >= 0 && !sim.dead;
    grindT = pushing ? Math.min(1, grindT + dt * 7) : Math.max(0, grindT - dt * 9);
    const low = state === 'play' && sim.armed && !sim.dead && sim.len <= 4;
    dangerT = low ? Math.min(1, dangerT + dt * 4) : Math.max(0, dangerT - dt * 4);
    if (low) {
      heartT += dt;
      if (heartT > 0.62) { heartT = 0; tone(70, 0.16, 'sine', 0.14, 50); }
    } else heartT = 0.5;
    const want = state === 'play' && sim.armed && !sim.dead ? clamp((sim.speed - SPEED_BASE) / Math.max(1, SPEED_CAP - SPEED_BASE), 0, 1) : 0;
    speedFx += (want - speedFx) * Math.min(1, dt * 2);
    const targetTilt = state === 'play' ? clamp((sim.hx - prev.hx) * 0.035, -0.28, 0.28) : 0;
    tilt += (targetTilt - tilt) * Math.min(1, dt * 14);
    driveAudio();
  }

  // ── the logo and the platform icon ─────────────────────────────────────
  // Chunky 3D wordmark: extruded, outlined, with a gloss laid over the fill.
  function wordArt(g, text, cx, cy, size, c1, c2, ext, outline) {
    g.save();
    g.font = FW + ' ' + size + 'px ' + FONT;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    for (let i = 8; i >= 1; i--) {
      g.lineWidth = size * 0.13; g.strokeStyle = outline; g.strokeText(text, cx, cy + i);
      g.fillStyle = ext; g.fillText(text, cx, cy + i);
    }
    g.lineWidth = size * 0.13; g.strokeStyle = outline; g.strokeText(text, cx, cy);
    // fill on its own canvas, so the gloss only ever lands on the letters
    const w = Math.ceil(size * text.length * 0.9), h = Math.ceil(size * 1.5);
    const t = offscreen(w * SPR, h * SPR);
    const tg = t.getContext('2d');
    tg.scale(SPR, SPR);
    tg.font = g.font; tg.textAlign = 'center'; tg.textBaseline = 'middle';
    const gr = tg.createLinearGradient(0, h * 0.2, 0, h * 0.8);
    gr.addColorStop(0, c1); gr.addColorStop(1, c2);
    tg.fillStyle = gr; tg.fillText(text, w / 2, h / 2);
    tg.globalCompositeOperation = 'source-atop';
    const gl = tg.createLinearGradient(0, h * 0.25, 0, h * 0.55);
    gl.addColorStop(0, 'rgba(255,255,255,0.7)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    tg.fillStyle = gl; tg.fillRect(0, 0, w, h * 0.55);
    g.drawImage(t, cx - w / 2, cy - h / 2, w, h);
    g.restore();
  }

  function buildLogo() {
    const W = 360, H = 230;
    const cv = offscreen(W * SPR, H * SPR);
    const g = cv.getContext('2d');
    g.scale(SPR, SPR);
    g.translate(W / 2, 0);
    g.rotate(-0.03);
    const L = TH.logo;
    wordArt(g, 'SNAKE', 0, 70, 84, L[0][0], L[0][1], L[0][2], L[0][3]);
    wordArt(g, 'BLOCKS', 0, 154, 74, L[1][0], L[1][1], L[1][2], L[1][3]);
    return cv;
  }

  function buildIcon(size) {
    const s = size / 512;
    const cv = offscreen(size, size);
    const g = cv.getContext('2d');
    g.scale(s, s);
    const bg = g.createLinearGradient(0, 0, 0, 512);
    bg.addColorStop(0, '#04284f'); bg.addColorStop(0.55, '#05577a'); bg.addColorStop(1, '#0ca3a0');
    g.fillStyle = bg; g.fillRect(0, 0, 512, 512);
    const gl = g.createRadialGradient(256, 120, 10, 256, 120, 380);
    gl.addColorStop(0, 'rgba(120,235,255,0.55)'); gl.addColorStop(1, 'rgba(120,235,255,0)');
    g.fillStyle = gl; g.fillRect(0, 0, 512, 512);
    g.strokeStyle = 'rgba(170,245,255,0.2)'; g.lineWidth = 3;
    for (let c = 0; c < 4; c++) { roundRect(g, 18 + c * 124, -20, 112, 552, 40); g.stroke(); }
    g.strokeStyle = 'rgba(210,250,255,0.35)'; g.lineWidth = 3;
    for (const [bx, by, br] of [[70, 90, 18], [120, 400, 11], [430, 330, 15], [400, 470, 9], [60, 250, 8]]) { g.beginPath(); g.arc(bx, by, br, 0, TAU); g.stroke(); }
    const spr = blockSpr[5];
    g.save(); g.translate(340, 135); g.scale(2.7, 2.7);
    g.drawImage(spr.c, -spr.w / 2 - spr.pad, -spr.h / 2 - spr.pad, spr.w + spr.pad * 2, spr.h + spr.pad * 2);
    outlinedText(g, '9', 0, 1, 34, '#ffffff', spr.ink, 6);
    g.restore();
    const sk = SKINS[0];
    for (let i = 5; i >= 1; i--) {
      const sp = ballSprite(i % 2 === 0 ? sk.a : mixRGB(sk.a, sk.b, 0.3));
      const r = lerp(60, 36, i / 5);
      const x = 170 - i * 18 + Math.sin(i) * 10, y = 300 + i * 46;
      g.drawImage(sp.c, x - r * (sp.o / 16), y - r * (sp.o / 16), r * 2 * (sp.o / 16), r * 2 * (sp.o / 16));
    }
    const hs = ballSprite(mixRGB(sk.a, sk.b, 0.55));
    const hr = 92;
    g.save(); g.translate(190, 270);
    g.drawImage(hs.c, -hr * (hs.o / 16), -hr * (hs.o / 16), hr * 2 * (hs.o / 16), hr * 2 * (hs.o / 16));
    const kk = hr / 17.5;
    for (const sd of [-1, 1]) {
      g.save(); g.translate(sd * 7.4 * kk, -2.4 * kk); g.rotate(sd * -0.28);
      g.shadowColor = 'rgba(190,255,220,1)'; g.shadowBlur = 24;
      g.fillStyle = '#04101c'; g.beginPath(); g.ellipse(0, 0, 4.6 * kk + 7, 5.2 * kk + 7, 0, 0, TAU); g.fill();
      g.fillStyle = '#d8ffe8'; g.beginPath(); g.ellipse(0, 0, 4.6 * kk, 5.2 * kk, 0, 0, TAU); g.fill();
      g.shadowBlur = 0; g.fillStyle = '#04101c'; g.beginPath(); g.ellipse(0, 0, 1.5 * kk, 4.6 * kk, 0, 0, TAU); g.fill();
      g.restore();
    }
    g.restore();
    return cv;
  }
  window.__sbBuildIcon = buildIcon;

  // ── the menu plays itself ──────────────────────────────────────────────
  const MENU_SPEED = 2000;
  const MENU_HEAD_Y = 380;

  function menuSpec(n) {
    let sp = menuSpecs.get(n);
    if (sp === undefined) {
      if (menuSpecs.size > 48) menuSpecs.clear();
      sp = rowSpec(menuSeedInt, n);
      menuSpecs.set(n, sp);
    }
    return sp;
  }
  function menuPathX(w) {
    const n = Math.floor(w / ROW_HQ);
    const t = (w - n * ROW_HQ) / ROW_HQ;
    const a = colMid(anchorAt(menuSeedInt, n));
    const b = colMid(anchorAt(menuSeedInt, n + 1));
    const k = clamp((t - 0.16) / 0.56, 0, 1);
    return a + (b - a) * (k * k * (3 - 2 * k));
  }

  function drawMenuWorld() {
    const sc = menuScroll;
    const vw = sc - (HEAD_Y - MENU_HEAD_Y) * U;
    drawFloor(vw);
    const hx = menuPathX(sc);
    const n0 = Math.max(0, Math.floor((sc - 7000) / ROW_HQ));
    const n1 = Math.floor((sc + (HEAD_Y + 180) * U) / ROW_HQ);
    for (let n = n0; n <= n1; n++) {
      const spec = menuSpec(n);
      const top = worldY(n * ROW_HQ + BLOCK_HQ, vw);
      if (spec.walls) drawWalls(spec, n, vw);
      if (spec.pick) drawPick(spec.pick, n, vw);
      for (let c = 0; c < COLS; c++) {
        const v = spec.vals[c];
        if (v <= 0) continue;
        drawBlock(colMid(c), top + BLOCK_H / 2, v, v, blockSpr[bandOf(v, n)], hx, MENU_HEAD_Y, 0, 0, 1);
      }
    }
    const shown = 13;
    const pts = [{ x: hx, y: MENU_HEAD_Y }];
    for (let i = 1; i <= shown; i++) {
      const w = sc - i * BALL_GAP * U;
      pts.push({ x: menuPathX(w), y: worldY(w, vw) });
    }
    drawChainBody(pts, shown);
    drawHead(hx, MENU_HEAD_Y, 1, false);
  }

  function menuScrim() {
    if (vigCanvas && vigW === viewW && vigH === viewH) return vigCanvas;
    vigW = viewW; vigH = viewH;
    vigCanvas = offscreen(Math.max(2, viewW), Math.max(2, viewH));
    const g = vigCanvas.getContext('2d');
    const lg = g.createLinearGradient(0, 0, 0, viewH);
    lg.addColorStop(0, 'rgba(2,4,16,0.0)');
    lg.addColorStop(0.2, 'rgba(2,4,16,0.4)');
    lg.addColorStop(0.5, 'rgba(2,4,16,0.0)');
    lg.addColorStop(0.72, 'rgba(2,4,16,0.55)');
    lg.addColorStop(1, 'rgba(2,4,16,0.85)');
    g.fillStyle = lg;
    g.fillRect(0, 0, viewW, viewH);
    return vigCanvas;
  }

  function drawMenu() {
    if (!logoCanvas) logoCanvas = buildLogo();
    ctx.drawImage(menuScrim(), -offX / scale, -offY / scale, viewW / scale, viewH / scale);
    const bob = Math.sin(time * 1.6) * 5;
    ctx.save();
    ctx.translate(FIELD_W / 2, 150 + bob);
    ctx.rotate(Math.sin(time * 1.1) * 0.012);
    ctx.drawImage(logoCanvas, -180, -115, 360, 230);
    ctx.restore();
  }

  // ── one frame ──────────────────────────────────────────────────────────
  let dangerVigCanvas = null;
  function dangerVig() {
    if (dangerVigCanvas && dangerW === viewW && dangerH === viewH) return dangerVigCanvas;
    dangerW = viewW; dangerH = viewH;
    dangerVigCanvas = offscreen(Math.max(2, viewW), Math.max(2, viewH));
    const g = dangerVigCanvas.getContext('2d');
    const rg = g.createRadialGradient(viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.3, viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.72);
    rg.addColorStop(0, 'rgba(255,40,70,0)'); rg.addColorStop(1, 'rgba(255,40,70,0.8)');
    g.fillStyle = rg; g.fillRect(0, 0, viewW, viewH);
    return dangerVigCanvas;
  }
  let edgeVig = null, edgeVigW = 0, edgeVigH = 0;
  function softEdge() {
    if (edgeVig && edgeVigW === viewW && edgeVigH === viewH) return edgeVig;
    edgeVigW = viewW; edgeVigH = viewH;
    edgeVig = offscreen(Math.max(2, viewW), Math.max(2, viewH));
    const g = edgeVig.getContext('2d');
    const rg = g.createRadialGradient(viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.45, viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.78);
    rg.addColorStop(0, 'rgba(0,0,10,0)'); rg.addColorStop(1, 'rgba(0,0,10,0.5)');
    g.fillStyle = rg; g.fillRect(0, 0, viewW, viewH);
    return edgeVig;
  }

  function render() {
    const t = state === 'play' ? clamp(accumulator / FRAME_MS, 0, 1) : 1;
    const vScroll = prev.scroll + (sim.scroll - prev.scroll) * t;
    const vHx = prev.hx + (sim.hx - prev.hx) * t;
    // the sky, the world behind the world
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const skyScroll = state === 'menu' ? menuScroll : vScroll;
    if (worldT < 1) {
      ctx.drawImage(skyCanvas(worldFrom), 0, 0, viewW, viewH);
      ctx.globalAlpha = worldT;
      ctx.drawImage(skyCanvas(worldTo), 0, 0, viewW, viewH);
      ctx.globalAlpha = 1;
      drawDeco(worldFrom, 1 - worldT, skyScroll);
      drawDeco(worldTo, worldT, skyScroll);
    } else {
      ctx.drawImage(skyCanvas(worldTo), 0, 0, viewW, viewH);
      drawDeco(worldTo, 1, skyScroll);
    }
    const sx = shake > 0 ? (Math.random() * 2 - 1) * shake : 0;
    const sy = shake > 0 ? (Math.random() * 2 - 1) * shake : 0;
    const zs = scale * (1 + 0.05 * punch);
    ctx.setTransform(zs * dpr, 0, 0, zs * dpr, (offX + sx + (scale - zs) * FIELD_W / 2) * dpr, (offY + sy + (scale - zs) * HEAD_Y) * dpr);
    if (state === 'menu') {
      drawMenuWorld();
    } else {
      drawFloor(vScroll);
      drawRows(vScroll, vHx);
      drawSpeedLines();
      drawSnake(vScroll, vHx);
    }
    drawFx();
    if (state === 'play') { drawEdgeGlow(); drawMeter(); drawBanners(); }
    if (state === 'menu') drawMenu();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(softEdge(), 0, 0, viewW, viewH);
    if (dangerT > 0) {
      ctx.globalAlpha = dangerT * (0.28 + 0.22 * Math.sin(time * 11));
      ctx.drawImage(dangerVig(), 0, 0, viewW, viewH);
      ctx.globalAlpha = 1;
    }
    if (flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.5, flash * 0.5) + ')';
      ctx.fillRect(0, 0, viewW, viewH);
    }
  }

  // ── the loop ───────────────────────────────────────────────────────────
  // The run is advanced by the AVERAGE frame length, with the difference paid
  // back a little at a time, so an unevenly delivered frame (iOS hands the
  // page a 32 ms frame and then a 4 ms one at the moment of a touch) does not
  // lurch and stall. Pacing only: steps, trace and scoring are untouched.
  function pace(dt) {
    if (!(frameAvg > 0)) frameAvg = dt > 0 ? Math.min(FRAME_MS * MAX_CATCHUP_STEPS, dt) : FRAME_MS;
    frameAvg += (Math.max(1, Math.min(FRAME_MS * MAX_CATCHUP_STEPS, dt)) - frameAvg) * 0.2;
    clockLag = Math.max(-100, Math.min(100, clockLag + dt - frameAvg));
    const fix = Math.max(-6, Math.min(6, clockLag * 0.25));
    clockLag -= fix;
    return Math.max(0, frameAvg + fix);
  }

  let perfSamples = [];
  function recordPerf(ms) {
    perfSamples.push(ms);
    if (perfSamples.length < 60) return;
    const sorted = perfSamples.slice().sort(function (a, b) { return a - b; });
    const avg = sorted.reduce(function (a, b) { return a + b; }, 0) / sorted.length;
    const stats = { avg: avg, p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1], samples: sorted.length };
    window.__sbPerf = stats;
    perfSamples = [];
    if (perfEl) {
      perfEl.classList.remove('is-hidden');
      perfEl.textContent = 'draw avg ' + stats.avg.toFixed(2) + ' ms\np95 ' + stats.p95.toFixed(2) + '  max ' + stats.max.toFixed(2)
        + '\nfx ' + fx.length + '  trail ' + trail.length;
    }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (lastFrameTime === null) { lastFrameTime = now; frameAvg = 0; clockLag = 0; }
    let raw = now - lastFrameTime;
    if (!(raw >= 0)) raw = 0;
    lastFrameTime = now;
    const dt = pace(raw);
    if (RP && state === 'menu' && sessionReady && RP.loaded()) start();
    if (state === 'play') {
      accumulator += RP ? RP.elapsed(dt, FRAME_MS * MAX_CATCHUP_STEPS) : dt;
      while (accumulator >= FRAME_MS - STEP_EPSILON_MS && state === 'play') {
        tick();
        accumulator -= FRAME_MS;
      }
    } else {
      accumulator = 0;
    }
    const cdt = Math.min(dt, 100) / 1000;
    time += cdt;
    updateCosmetics(cdt);
    const t0 = PERF ? performance.now() : 0;
    render();
    if (PERF) recordPerf(performance.now() - t0);
  }

  // QA only, behind ?perf=1: drive the run by hand so a state deep into a game
  // can be looked at without playing to it. It only calls the same tick() the
  // loop calls, so it can never produce a state the loop could not.
  if (PERF) {
    window.__sbDebug = {
      start: start,
      step: function (n) { for (let i = 0; i < (n || 1) && state === 'play'; i++) tick(); },
      hold: function (d) { pointer.down = !!d; },
      aim: function (x) { aimX = clamp(Math.round(x), X_MIN, X_MAX); },
      sim: function () { return sim; },
      spec: function (n) { return rowSpec(sim.seedInt, n); },
      bench: function (n) { const t0 = performance.now(); for (let i = 0; i < n; i++) render(); return (performance.now() - t0) / n; },
      calm: function () { fx = []; rings = []; pops = []; banners = []; swallow = []; flash = 0; shake = 0; punch = 0; edgeGlow = null; headPulse = 0; chainT = 0; },
      world: function (i) { worldForce = i; worldFrom = i; worldTo = i; worldT = 1; },
      demo: function (chain) {
        const x = 207, y = 330;
        chips(x, y, BAND_COL[3], 18, 340); puffs(x, y, 7); stars(x, y, [255, 238, 150], 12, 300);
        ring(x, y, [255, 255, 255], 240, 0.55, 4);
        edgeGlow = { col: BAND_COL[chain % 8], t: 1 };
        chainT = 1; swallow.push(0.1);
        banner(CHAIN_WORDS[Math.min(8, chain)] || 'NICE!', 'x' + chain + ' CHAIN', [255, 225, 70], false);
        pop(x, y, '+120', '#ffe14a', 34);
        punch = 0.6; speedFx = 1;
      },
      deathAt: function (t) { if (deathT >= 0) deathT = t; return deathT; },
    };
  }

  // QA only: ?perf=1&shot=play puts a mid-run frame on screen for a screenshot.
  if (PERF && /[?&]shot=play\b/.test(String(location.search || ''))) {
    setTimeout(function () {
      start(); pointer.down = true;
      for (let i = 0; i < 300 && state === 'play'; i++) tick();
      pointer.down = false;
      window.__sbDebug.demo(4);
    }, 300);
  }

  menuSeedInt = seedToInt(MENU_SEED);
  menuScroll = 3 * ROW_HQ;
  applyTheme(readThemeId());
  if (bestNumEl) bestNumEl.textContent = String(best);
  resize();
  resetEffects();
  updateScore();
  requestAnimationFrame(loop);
})();
