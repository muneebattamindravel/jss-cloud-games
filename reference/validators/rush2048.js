'use strict';
// 2048 Rush: server-side deterministic REPLAY (Oct 2026, migration 202).
//
// A 4x4 2048 board as a race against a 5 minute clock. The rules block below
// is carried WORD FOR WORD in games/rush-2048/js/game.js; the cross-file test
// (shared/tests/rush2048Parity.test.js) fails if the two ever differ.
//
// Trace v2: { kind: 'start', v: 2 } then one { kind: 'move', n, dir, step } per
// move the client applied. The server replays every move through the same
// rules and computes the score itself. A move the rules refuse (out of order,
// in the lock, past the clock, changes nothing, after the board locked) is
// REFUSED and changes nothing; refusals never zero the run.
//
// Turn based: there is no physics and nothing happens between moves, so
// finalize has nothing to run out.

// ==== RUSH2048 RULES BEGIN (word for word in games/rush-2048/js/game.js and shared/anticheat/validators/rush2048.js) ====
// Integers only. No clock, no screen, no Math.random. A move is applied on the
// fixed 1/60 s step the player made it on; the tile spawned after move N is a
// pure function of (seed, N), with two draws taken on every index.
var RUN_STEPS = 18000;        // 5 minutes of play at 60 steps a second
var MOVE_LOCK_STEPS = 7;      // a move is refused until 7 steps after the last one
var GRID = 4;
var RULES_VERSION = 2;
var MAX_MOVES = 4000;         // a work bound: the lock allows at most 2,572 moves in a run
var OPEN_SECOND = 1000000;    // index of the second opening tile
function hash32(a, b, c) {
  var h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul(b | 0, 0x85EBCA6B) ^ Math.imul(c | 0, 0xC2B2AE35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846CA68B) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
function seedToInt(seedHex) {
  return (typeof seedHex === 'string' && /^[0-9a-fA-F]{8}/.test(seedHex)) ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
}
function lineIdx(dir, i) { // the cells of line i, ordered from the side tiles slide toward
  var out = [], k;
  for (k = 0; k < GRID; k++) {
    if (dir === 3) out.push(i * GRID + k);
    else if (dir === 1) out.push(i * GRID + (GRID - 1 - k));
    else if (dir === 0) out.push(k * GRID + i);
    else out.push((GRID - 1 - k) * GRID + i);
  }
  return out;
}
// dir: 0 up, 1 right, 2 down, 3 left. Each tile merges at most once per move,
// the pair nearest the side tiles slide toward merging first. A merge scores
// the value of the new tile.
function slideBoard(board, dir) {
  var nb = [], moved = false, gained = 0, moves = [], merges = [], i, k;
  for (i = 0; i < GRID * GRID; i++) nb.push(0);
  for (i = 0; i < GRID; i++) {
    var idx = lineIdx(dir, i), tiles = [];
    for (k = 0; k < GRID; k++) if (board[idx[k]]) tiles.push({ v: board[idx[k]], from: idx[k] });
    var w = 0;
    for (k = 0; k < tiles.length; k++) {
      if (k + 1 < tiles.length && tiles[k + 1].v === tiles[k].v) {
        var v2 = tiles[k].v * 2;
        nb[idx[w]] = v2; gained += v2;
        moves.push({ from: tiles[k].from, to: idx[w], v: tiles[k].v });
        moves.push({ from: tiles[k + 1].from, to: idx[w], v: tiles[k + 1].v });
        merges.push({ to: idx[w], v: v2 });
        k++;
      } else {
        nb[idx[w]] = tiles[k].v;
        moves.push({ from: tiles[k].from, to: idx[w], v: tiles[k].v });
      }
      w++;
    }
  }
  for (i = 0; i < GRID * GRID; i++) if (nb[i] !== board[i]) moved = true;
  return { board: nb, moved: moved, gained: gained, moves: moves, merges: merges };
}
// 90% a 2, 10% a 4, on the (h2 mod empties)-th empty cell in row-major order.
function spawnTile(board, seedInt, n) {
  var empties = [], i;
  for (i = 0; i < GRID * GRID; i++) if (!board[i]) empties.push(i);
  var h1 = hash32(seedInt, n, 1), h2 = hash32(seedInt, n, 2);
  if (!empties.length) return -1;
  var cell = empties[h2 % empties.length];
  board[cell] = (h1 % 10) === 0 ? 4 : 2;
  return cell;
}
function canMoveBoard(board) {
  for (var d = 0; d < 4; d++) if (slideBoard(board, d).moved) return true;
  return false;
}
function initSim(seedInt) {
  var b = [];
  for (var i = 0; i < GRID * GRID; i++) b.push(0);
  spawnTile(b, seedInt, 0);
  spawnTile(b, seedInt, OPEN_SECOND);
  return { seed: seedInt >>> 0, board: b, score: 0, n: 0, busyUntil: 0, lastStep: 0, maxTile: maxOf(b), dead: false, spawn: -1 };
}
function maxOf(board) { var m = 0; for (var i = 0; i < board.length; i++) if (board[i] > m) m = board[i]; return m; }
// Apply move n (the move index) in direction dir on step `step`. Returns the
// slide result, or the reason it was refused. A refusal changes nothing.
function moveSim(sim, dir, step) {
  if (sim.dead) return 'dead';
  if (dir !== 0 && dir !== 1 && dir !== 2 && dir !== 3) return 'bad_dir';
  if (step < sim.lastStep) return 'frame_regressed';
  if (step >= RUN_STEPS) return 'time_up';
  if (step < sim.busyUntil) return 'busy';
  if (sim.n >= MAX_MOVES) return 'move_cap';
  var r = slideBoard(sim.board, dir);
  if (!r.moved) return 'no_change';
  sim.n = sim.n + 1;
  sim.board = r.board;                       // a new array, never edited in place
  sim.score = sim.score + r.gained;
  sim.spawn = spawnTile(sim.board, sim.seed, sim.n);
  sim.busyUntil = step + MOVE_LOCK_STEPS;
  sim.lastStep = step;
  sim.maxTile = maxOf(sim.board);
  if (!canMoveBoard(sim.board)) sim.dead = true;
  return r;
}
// ==== RUSH2048 RULES END ====

const MAX_INPUTS = MAX_MOVES + 200;

function isInt(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, version: 0,
    maxDurationSecs: Number(maxDurationSecs) || 3600, elapsedSecs: Number(elapsedSecs) || 0,
    // humanness raw material (recorded, never gated)
    gaps: [], atLock: 0, dirCounts: [0, 0, 0, 0], greedyBest: 0, lastMoveStep: -1,
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

// The best score a single move could take from this board (for the "moves
// that were the greedy best" fingerprint).
function bestGain(board) {
  let b = -1;
  for (let d = 0; d < 4; d++) { const r = slideBoard(board, d); if (r.moved && r.gained > b) b = r.gained; }
  return b;
}

function processEvent(state, event) {
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};
  if (p.kind === 'start') {
    if (Number(p.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.version = 2;
      state.sim = initSim(seedToInt(state.seed));
    }
    return { accepted: true, newScore: state.score };
  }
  // No start marker, no replay, no score.
  if (state.mode !== 'sim' || p.kind !== 'move') return { accepted: true, newScore: state.score };
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  const { n, dir, step } = p;
  if (!isInt(n) || !isInt(dir) || dir > 3 || !isInt(step)) return reject(state, 'bad_move');
  const sim = state.sim;
  if (sim.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (n !== sim.n) return reject(state, 'out_of_order');
  const greedy = bestGain(sim.board);
  const prevStep = state.lastMoveStep;
  const r = moveSim(sim, dir, step);
  if (typeof r === 'string') return reject(state, r);
  if (prevStep >= 0) {
    const gap = step - prevStep;
    state.gaps.push(gap);
    if (gap === MOVE_LOCK_STEPS) state.atLock++;
  }
  state.lastMoveStep = step;
  state.dirCounts[dir]++;
  if (r.gained === greedy && greedy > 0) state.greedyBest++;
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

function fingerprint(state) {
  const g = state.gaps;
  const n = g.length;
  const mean = n ? g.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n ? Math.sqrt(g.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n) : 0;
  const moves = state.dirCounts.reduce((a, b) => a + b, 0);
  let ent = 0;
  for (const c of state.dirCounts) if (c) { const q = c / moves; ent -= q * Math.log(q) / Math.LN2; }
  return {
    moves,
    gapMeanSteps: Math.round(mean * 100) / 100,
    gapCv: mean ? Math.round((sd / mean) * 1000) / 1000 : 0,
    atLockShare: n ? Math.round((state.atLock / n) * 1000) / 1000 : 0,
    dirEntropy: Math.round(ent * 1000) / 1000,
    greedyShare: moves ? Math.round((state.greedyBest / moves) * 1000) / 1000 : 0,
  };
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', moves: sim.n, score: sim.score, dead: sim.dead, maxTile: sim.maxTile,
      lastStep: sim.lastStep, inputs: state.inputCount, rejects: state.rejectCount,
      fingerprint: fingerprint(state),
    },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  // The clock is a rule (RUN_STEPS, 5 minutes), well inside the session hour.
  _limits: { MAX_SIM_STEPS: 3600 * 60, FPS: 60, RUN_STEPS },
  init, processEvent, finalize, simulate,
  _sim: {
    RUN_STEPS, MOVE_LOCK_STEPS, GRID, RULES_VERSION, MAX_MOVES, OPEN_SECOND,
    hash32, seedToInt, lineIdx, slideBoard, spawnTile, canMoveBoard, initSim, maxOf, moveSim, bestGain,
  },
};
