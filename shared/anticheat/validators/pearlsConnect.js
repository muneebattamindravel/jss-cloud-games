'use strict';

/**
 * Pearls Connect validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a 6 x 6 board of pearls in five colours. The player drags through
 * pearls of one colour, each next to the one before; lifting the finger clears
 * the chain (n pearls pay n(n+1)/2). Closing a loop clears every pearl of that
 * colour and pays double. Pearls above fall, new ones enter from the top, and
 * a board with no pair reshuffles. Five minutes; the score is the points.
 *
 * What the server does with a trace:
 *   1. rebuilds the board from the session seed: pearl k to enter column c is
 *      hash(seed, c, k), shuffle attempt t uses hash row SHUFFLE_ROW + t, never
 *      a running stream;
 *   2. applies each chain { n, step, down, cells } before step `step + 1`
 *      runs, exactly as the client does (a chain the rules refuse is refused
 *      here too);
 *   3. runs the fixed steps out to the end of the clock and adds up the score.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/pearls-connect/js/game.js.
 * shared/tests/pearlsConnectParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump, never an
 * edit in place.
 */

// ==== PEARLS CONNECT RULES BEGIN ====
// The board is N x N cells, index i = r * N + c, row 0 at the top, and each
// cell holds a pearl kind 0..KINDS-1. A chain is the list of cells the finger
// passed through, in order; it clears when the finger lifts. Pearl number k
// to enter column c is a pure function of (seed, c, k), so a refill never
// depends on how many draws came before it. Integers only.
var RULES_VERSION = 2;      // trace v2 (v1 is the platform's "not a replay")
var N = 6;
var CELLS = 36;
var KINDS = 5;
var RUN_STEPS = 18000;      // 5 minutes of fixed 1/60 s steps
var MIN_CHAIN = 2;          // the shortest chain that clears
var LOOP_MIN = 4;           // the smallest loop, in pearls
var LOOP_MULT = 2;          // a loop pays double
var SHUFFLE_TRIES = 64;
var SHUFFLE_ROW = 100;      // hash row of the first shuffle, above every column
var SEED_MIX = 0x85EBCA6B;
var HASH_K = 0x9E3779B1;
var HASH_J = 0x85EBCA77;
var MIX_A = 0x7FEB352D;
var MIX_B = 0x846CA68B;

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

// Draw j of row k: a pure function of (seed, k, j).
function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, HASH_K) ^ Math.imul(j + 1, HASH_J)) | 0;
  h = Math.imul(h ^ (h >>> 16), MIX_A);
  h = Math.imul(h ^ (h >>> 15), MIX_B);
  return (h ^ (h >>> 16)) >>> 0;
}

// n pearls pay 1 + 2 + ... + n; a loop pays that twice.
function chainPoints(n, loop) { return n * (n + 1) / 2 * (loop ? LOOP_MULT : 1); }

function adjacent(a, b) {
  var ra = Math.floor(a / N), rb = Math.floor(b / N), ca = a - ra * N, cb = b - rb * N;
  if (ra === rb) return ca - cb === 1 || cb - ca === 1;
  return ca === cb && (ra - rb === 1 || rb - ra === 1);
}

function hasPair(grid) {
  for (var i = 0; i < CELLS; i++) {
    if (i % N < N - 1 && grid[i] === grid[i + 1]) return true;
    if (i + N < CELLS && grid[i] === grid[i + N]) return true;
  }
  return false;
}

// Pearl number k to enter column c. `avoid` (a loop's colour, or -1) is
// stepped past with the same single draw, so every index costs one draw.
function spawnKind(seed, c, k, avoid) {
  var h = hash(seed, c, k), kind = h % KINDS;
  if (avoid >= 0 && kind === avoid) kind = (kind + 1 + (h >>> 8) % (KINDS - 1)) % KINDS;
  return kind;
}

// No pair anywhere: the pearls are shuffled in place (seeded Fisher-Yates,
// one hash row per attempt) until there is one.
function reshuffle(sim) {
  var grid = sim.grid.slice(), t, i, j, x;
  for (t = 0; t < SHUFFLE_TRIES; t++) {
    var row = SHUFFLE_ROW + sim.shuffles;
    sim.shuffles++;
    for (i = CELLS - 1; i > 0; i--) { j = hash(sim.seed, row, i) % (i + 1); x = grid[i]; grid[i] = grid[j]; grid[j] = x; }
    if (hasPair(grid)) break;
  }
  if (!hasPair(grid)) grid[1] = grid[0];
  sim.grid = grid;
}

function initSim(seedHex, version) {
  var sim = {
    version: version, seed: seedToInt(seedHex), step: 0, score: 0, over: false,
    grid: [], spawned: [], shuffles: 0, chains: 0, lastStep: -1, events: []
  };
  var grid = [], spawned = [], r, c;
  for (c = 0; c < N; c++) spawned.push(N);
  // each column fills from the bottom: the bottom pearl is its number 0
  for (r = 0; r < N; r++) for (c = 0; c < N; c++) grid.push(spawnKind(sim.seed, c, N - 1 - r, -1));
  sim.grid = grid; sim.spawned = spawned;
  if (!hasPair(sim.grid)) reshuffle(sim);
  return sim;
}

// Reads a chain: cells on the board, each next to the one before, all one
// colour, none twice, except that the last may close a loop onto a cell at
// least LOOP_MIN back. Returns null for anything else.
function readChain(grid, cells) {
  if (!Array.isArray(cells) || cells.length < MIN_CHAIN) return null;
  var seen = [], i, a, kind = -1, loopAt = -1;
  for (i = 0; i < CELLS; i++) seen.push(-1);
  for (i = 0; i < cells.length; i++) {
    a = cells[i];
    // a whole number on the board (this also refuses strings, null and NaN)
    if (a !== Math.floor(a) || a < 0 || a >= CELLS) return null;
    if (i === 0) kind = grid[a];
    else if (!adjacent(cells[i - 1], a) || grid[a] !== kind) return null;
    if (seen[a] >= 0) {
      if (i !== cells.length - 1 || i - seen[a] < LOOP_MIN) return null;
      loopAt = seen[a];
    } else seen[a] = i;
  }
  return { kind: kind, loop: loopAt >= 0, n: loopAt >= 0 ? cells.length - 1 : cells.length };
}

// A chain clears at the step the finger lifts. Refused (and never recorded)
// once the run is over, on a step another chain already used, or when
// readChain refuses it. A loop clears every pearl of its colour.
function chainSim(sim, cells) {
  if (sim.over || sim.step <= sim.lastStep) return false;
  var ch = readChain(sim.grid, cells);
  if (!ch) return false;
  var gone = [], clear = [], i, r, c;
  for (i = 0; i < CELLS; i++) gone.push(false);
  for (i = 0; i < ch.n; i++) { gone[cells[i]] = true; clear.push(cells[i]); }
  if (ch.loop) for (i = 0; i < CELLS; i++) if (!gone[i] && sim.grid[i] === ch.kind) { gone[i] = true; clear.push(i); }
  var pts = chainPoints(clear.length, ch.loop);
  // Gravity: in each column the pearls left fall to the bottom in order and
  // new ones enter from the top; after a loop no new pearl is its colour.
  var grid = [], from = [], spawned = sim.spawned.slice();
  for (i = 0; i < CELLS; i++) { grid.push(0); from.push(-1); }
  for (c = 0; c < N; c++) {
    var to = N - 1;
    for (r = N - 1; r >= 0; r--) {
      if (!gone[r * N + c]) { grid[to * N + c] = sim.grid[r * N + c]; from[to * N + c] = r * N + c; to--; }
    }
    for (; to >= 0; to--) { grid[to * N + c] = spawnKind(sim.seed, c, spawned[c], ch.loop ? ch.kind : -1); spawned[c]++; }
  }
  sim.grid = grid; sim.spawned = spawned;
  sim.score += pts; sim.chains++; sim.lastStep = sim.step;
  var shuffled = !hasPair(sim.grid);
  if (shuffled) reshuffle(sim);
  sim.events = [{ t: 'clear', kind: ch.kind, loop: ch.loop, cells: clear, pts: pts, from: from, shuffled: shuffled }];
  return true;
}

function stepSim(sim) {
  sim.events = [];
  if (sim.over) return;
  sim.step++;
  if (sim.step >= RUN_STEPS) sim.over = true;
}
// ==== PEARLS CONNECT RULES END ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it. The run itself ends at
// RUN_STEPS, far inside it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound above any real run (at most one chain a step). It REFUSES
// further inputs, it never zeroes.
const MAX_INPUTS = RUN_STEPS + 100;
// A chain longer than this cannot be legal (it would repeat a cell before
// its end); it is refused before the rules read it.
const MAX_CELLS = CELLS + 1;

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { steps: [], drags: [], lens: [], loops: 0, loopSkipped: 0 },
  };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always ends inside this bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}
function stepLimit(state) {
  return Math.min(MAX_SIM_STEPS, elapsedCap(state, 60));
}
function advanceTo(state, step) {
  const sim = state.sim, lim = stepLimit(state);
  while (!sim.over && sim.step < step && sim.step < lim) stepSim(sim);
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. Per chain: the steps since the last chain (decision
// time), the steps per pearl the drag took (hand speed), the chain's length,
// and whether a 2 x 2 loop was on the board and the player took something
// else (a planner never leaves one; a hand often does).
function squareLoop(grid) {
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      const i = r * N + c, k = grid[i];
      if (grid[i + 1] === k && grid[i + N] === k && grid[i + N + 1] === k) return true;
    }
  }
  return false;
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }
function gapsOf(steps) { const g = []; for (let i = 1; i < steps.length; i++) g.push(steps[i] - steps[i - 1]); return g; }

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function processEvent(state, event) {
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
  if (state.mode !== 'sim' || kind !== 'chain') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, step, down, cells } = payload;
  if (!isStep(n) || !isStep(step) || !isStep(down) || !Array.isArray(cells) || cells.length > MAX_CELLS) return reject(state, 'bad_chain');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would re-run a window and keep the
  // best outcome.
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.step !== step) return reject(state, sim.over ? 'over' : 'beyond_cap');
  // The chain names its index in the run; any other index is out of order.
  if (n !== sim.chains) return reject(state, 'out_of_order');
  // It began after the last chain lifted, and before it lifted itself.
  if (down > step || down < sim.lastStep) return reject(state, 'bad_down');
  const loopOnBoard = squareLoop(sim.grid);
  if (!chainSim(sim, cells)) return reject(state, 'refused');
  const ev = sim.events[0];
  state.stats.steps.push(step);
  state.stats.lens.push(ev.loop ? cells.length - 1 : cells.length);
  state.stats.drags.push((step - down) / Math.max(1, cells.length - 1));
  if (ev.loop) state.stats.loops++;
  else if (loopOnBoard) state.stats.loopSkipped++;
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const sim = state.sim;
  // Run the clock out past the last chain, bounded by the real session.
  const runOut = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  advanceTo(state, runOut);
  const st = state.stats, gaps = gapsOf(st.steps), gm = mean(gaps), gs = sd(gaps);
  return {
    score: sim.score,
    gameOver: sim.over,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, over: sim.over, score: sim.score,
      chains: sim.chains, shuffles: sim.shuffles,
      inputs: state.inputCount, rejects: state.rejectCount,
      gapMean: round3(gm), gapSd: round3(gs), gapCv: round3(gm && gs !== null ? gs / gm : null),
      dragMean: round3(mean(st.drags)), dragSd: round3(sd(st.drags)),
      lenMean: round3(mean(st.lens)), lenMax: st.lens.length ? Math.max.apply(null, st.lens) : 0,
      loops: st.loops, loopSkipped: st.loopSkipped,
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
    RULES_VERSION, initSim, stepSim, chainSim, readChain, reshuffle, spawnKind, hasPair, adjacent, chainPoints,
    hash, seedToInt, squareLoop, MAX_INPUTS, MAX_SIM_STEPS, MAX_CELLS,
    N, CELLS, KINDS, RUN_STEPS, MIN_CHAIN, LOOP_MIN, LOOP_MULT, SHUFFLE_TRIES, SHUFFLE_ROW,
    SEED_MIX, HASH_K, HASH_J, MIX_A, MIX_B,
  },
};
