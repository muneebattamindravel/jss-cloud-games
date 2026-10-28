'use strict';

/**
 * Block Blast validator.
 *
 * TWO PATHS, and which one runs is decided by the trace itself:
 *
 *   'sim' — SERVER-SIDE DETERMINISTIC REPLAY. The score is not taken from the
 *           client and neither is the OUTCOME of a move. The server deals the
 *           same tray from the session seed, applies each placement to its own
 *           8x8 board, detects the full rows and columns itself, clears them,
 *           tracks the combo streak itself, and computes the points from the
 *           same table the game uses. Entered by a v2 `start` marker.
 *
 *   'v1'   — the old summary model: the client reported cells / rows / cols /
 *            perfect and the server re-derived the arithmetic from that. KEPT
 *            ON PURPOSE for the length of the rollout. Unlike Sky Tower, this
 *            path scores an OLD trace correctly, so a stale cached client is
 *            not zeroed by it; `anticheat.block-blast.require_v2` closes the
 *            door once the frontend is fully deployed.
 *
 * WHY THE SUMMARY PATH WAS NOT ENOUGH. It bounded the arithmetic but not the
 * truth. It had no board, so it could not tell whether a claimed triple clear
 * was possible — a forged trace reporting rows:3, cols:3, perfect:true on every
 * placement is arithmetically consistent with the rule table and would have
 * been paid. That is a bounds checker wearing a replay's clothes. The server
 * now owns the board, so the only thing a client can claim is WHICH PIECE it
 * put WHERE, and an impossible placement is refused rather than scored.
 *
 * What makes this game easy to replay, relative to the physics ones:
 *   - It is TURN BASED. There is no timestep, no physics and no frame counter,
 *     so frame rate cannot change a score and there is nothing to run out in
 *     finalize(). The trace's ORDER is the whole clock.
 *   - Nothing about gameplay derives from the viewport: the grid, the piece
 *     shapes and the hit testing are all in the pinned 520x930 design space,
 *     and eventPoint() maps the pointer into it. Only the CSS size and the
 *     device pixel ratio follow the screen. blockBlastParity.test.js pins that.
 *
 * ⚠ EVERY CONSTANT AND EVERY RULE BELOW IS LIFTED FROM
 * games/block-blast/js/game.js AND MUST STAY IDENTICAL TO IT — the SHAPES
 * table, the number of colours (a cosmetic draw, but it CONSUMES a number from
 * the seeded stream), the deal size, and ScoreManager.calculate(). A change
 * there without a change here silently mis-scores every honest player.
 * shared/tests/blockBlastParity.test.js drives the REAL game file through a
 * headless harness and compares the two WORLDS after every placement.
 */

// ── the board and the deal, verbatim from the game ──────────────────────
const ROWS = 8;
const COLS = 8;
const TRAY_SIZE = 3;

// SHAPES, in order. The INDEX is what the seeded stream picks, so the order of
// this array is protocol: reordering it deals different pieces for the same
// seed and desyncs every replay.
const SHAPES = [
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [2, 0], [1, 1]],
  [[0, 0], [0, 1], [0, 2], [1, 2]],
  [[0, 0], [1, 0], [2, 0], [3, 0]],
  [[0, 0], [0, 1], [1, 1], [2, 1]],
  [[0, 0]],
  [[0, 0], [1, 0]],
  [[0, 0], [0, 1], [0, 2]],
  [[0, 0], [1, 0], [1, 1]],
  [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]],
  [[0, 0], [1, 0], [0, 1]],
  [[0, 1], [1, 1], [1, 0], [2, 0]],
];

// The colour of a piece is PURELY COSMETIC — it never reaches the score. It is
// modelled here anyway because newPieces() draws it from the SAME seeded
// stream, one call after the shape, so skipping it would shift every later
// shape by one and desync the whole deal. Its presence is what makes the two
// halves consume the stream in step; the parity suite compares it for exactly
// that reason, because a colour mismatch surfaces a desync one draw earlier
// than a shape mismatch would.
const COLOR_COUNT = 7;

// A backstop on WORK, not on scoring. A placement is a drag: at the ~2/sec a
// fast expert sustains, a full 600-second session is ~1,200 moves, and the
// board itself bounds how many can be legal. 20,000 is more than an order of
// magnitude past that and exists only so a giant forged trace cannot turn one
// submit into a CPU sink. It REFUSES further moves rather than killing the
// run: a work cap must never cost an honest player the score they earned.
// (Epic Slicer's segments-per-step cap was set from a synthetic corpus and
// under-paid 31% of real runs within an hour. A cap that can only clip belongs
// far above anything observable — so do not tune this DOWN toward real play.)
//
// It is the DEFAULT for `anticheat.block-blast.max_moves`, the one tunable the
// replay path reads.
const MAX_MOVES = 20000;

// ── The scoring table — mirror of ScoreManager in the game ────────────────
function lineClearBonus(linesCleared) {
  if (linesCleared <= 0) return 0;
  if (linesCleared === 1) return 10;
  if (linesCleared === 2) return 25;
  if (linesCleared === 3) return 50;
  if (linesCleared === 4) return 80;
  return 120;
}

function comboBonus(streak) {
  if (streak <= 1) return 0;
  if (streak === 2) return 5;
  if (streak === 3) return 10;
  if (streak === 4) return 15;
  return 20;
}

// ── the seeded piece stream ─────────────────────────────────────────────
//
// Bit-for-bit identical to kjMulberry32() in the game and to
// shared/anticheat/prng.js. Inlined rather than imported so this file states
// the whole protocol in one place — the game states it the same way, and the
// parity suite proves the two agree.
function mulberry32(seedHex) {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// newPieces(): three pieces, each one shape draw then one colour draw. The
// ORDER of those draws is protocol — swapping them deals a different run.
function dealTray(rng) {
  const tray = [];
  for (let i = 0; i < TRAY_SIZE; i++) {
    const shapeIndex = Math.floor(rng() * SHAPES.length);
    const colorIndex = Math.floor(rng() * COLOR_COUNT);
    tray.push({ shapeIndex, colorIndex, shape: SHAPES[shapeIndex], used: false });
  }
  return tray;
}

function initSim(seed) {
  if (typeof seed !== 'string' || seed.length < 8) return null;
  const rng = mulberry32(seed);
  return {
    rng,
    // Flat 64-cell occupancy. `board[y * COLS + x]`, 1 = filled.
    board: new Uint8Array(ROWS * COLS),
    tray: dealTray(rng),
    combo: 0,
    score: 0,
    moves: 0,
    over: false,          // no unused piece fits anywhere — the run has ended
    deals: 1,
  };
}

const at = (board, x, y) => board[y * COLS + x];

function fits(board, shape, col, row) {
  for (let i = 0; i < shape.length; i++) {
    const x = col + shape[i][0];
    const y = row + shape[i][1];
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return false;
    if (board[y * COLS + x]) return false;
  }
  return true;
}

// canPlaceAny() — some UNUSED tray piece fits somewhere on the board.
function canPlaceAny(sim) {
  for (const piece of sim.tray) {
    if (piece.used) continue;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (fits(sim.board, piece.shape, x, y)) return true;
      }
    }
  }
  return false;
}

/**
 * Apply one placement, exactly as onPointerUp -> handleLineClear ->
 * ScoreManager.applyMove -> advanceAfterPlacement does.
 *
 * Returns null if the move is ILLEGAL — an empty or out-of-range tray slot, a
 * piece that runs off the grid, or a piece that overlaps an occupied cell. An
 * illegal move is refused rather than scored, and the board is left untouched.
 *
 * Note there is deliberately NO separate "the run is already over" guard. The
 * run ends exactly when no unused piece fits anywhere, and in that state every
 * placement is already refused by the legality test above — a second guard
 * would be provably unreachable code, which is worse than no guard.
 */
function applyPlacement(sim, slot, col, row) {
  // One guard, deliberately. An explicit range check beside this one reads
  // well but is provably unreachable — a dense array answers `undefined` for a
  // negative, fractional or past-the-end index, so each of the two masks the
  // other and neither can be mutation-tested. Unreachable code that looks like
  // a safety net is worse than no safety net: the reader trusts it and the
  // suite cannot tell you when it stops being true.
  //
  // It also makes the `typeof` gate in processEvent load-bearing rather than
  // decorative: `tray['0']` IS `tray[0]`, so a stringly-typed slot is refused
  // there and only there.
  const piece = sim.tray[slot];
  if (!piece || piece.used) return null;
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
  if (!fits(sim.board, piece.shape, col, row)) return null;

  for (let i = 0; i < piece.shape.length; i++) {
    const x = col + piece.shape[i][0];
    const y = row + piece.shape[i][1];
    sim.board[y * COLS + x] = 1;
  }
  piece.used = true;

  // handleLineClear() — full rows and columns are read off the board AFTER the
  // piece lands, and both sets are computed BEFORE either is cleared. Clearing
  // rows first and then re-reading the columns would miss a column that was
  // only full because of the cells a cleared row has just removed.
  const rows = [];
  const cols = [];
  for (let y = 0; y < ROWS; y++) {
    let full = true;
    for (let x = 0; x < COLS; x++) if (!at(sim.board, x, y)) { full = false; break; }
    if (full) rows.push(y);
  }
  for (let x = 0; x < COLS; x++) {
    let full = true;
    for (let y = 0; y < ROWS; y++) if (!at(sim.board, x, y)) { full = false; break; }
    if (full) cols.push(x);
  }

  for (const y of rows) for (let x = 0; x < COLS; x++) sim.board[y * COLS + x] = 0;
  for (const x of cols) for (let y = 0; y < ROWS; y++) sim.board[y * COLS + x] = 0;

  // ScoreManager.calculate() — the whole rule, in the client's own order.
  const linesCleared = rows.length + cols.length;
  const comboStreakAfterMove = linesCleared > 0 ? sim.combo + 1 : 0;
  const placedCellPoints = piece.shape.length;
  const lineBonus = lineClearBonus(linesCleared);
  const cBonus = linesCleared > 0 ? comboBonus(comboStreakAfterMove) : 0;
  const rowColumnBonus = rows.length > 0 && cols.length > 0 ? 10 : 0;
  // boardIsEmpty(boardAfterClear). The board can only be empty AFTER a clear —
  // a piece has just been placed on it — so this is structurally unreachable
  // without linesCleared > 0, which is why the game does not gate it either.
  let empty = true;
  for (let i = 0; i < sim.board.length; i++) if (sim.board[i]) { empty = false; break; }
  const perfectClearBonus = empty ? 100 : 0;

  const points = Math.trunc(placedCellPoints + lineBonus + cBonus + rowColumnBonus + perfectClearBonus);
  sim.combo = comboStreakAfterMove;
  sim.score = Math.trunc(sim.score + points);
  sim.moves += 1;

  // advanceAfterPlacement() — a fresh tray only once all three are used.
  if (sim.tray.every((p) => p.used)) {
    sim.tray = dealTray(sim.rng);
    sim.deals += 1;
  }
  sim.over = !canPlaceAny(sim);

  return { points, rows: rows.length, cols: cols.length, perfect: perfectClearBonus > 0 };
}

// ── v1 summary path tuning (pre-replay traces only) ─────────────────────
//
// Unchanged from the pre-replay validator, and it stays that way: its whole
// job now is to keep scoring the traces an older cached client emits exactly
// as it did before. None of it runs on the sim path.
//
// maxCellsPerPiece (5): the largest shape in SHAPES has five cells.
// maxLinesPerMove (8): a single placement can complete at most 3 rows + 3 cols.
// minPlaceIntervalMs (90): a real drag takes 250ms+; 90 rejects machine-gun spam.
// maxScorePerSec (60): a fast expert sustains roughly 30/sec; this is 2x that.
// flatSlack (300): one-time allowance so the opening moves are credited.
// dropTolerance (400): how far the client HUD may exceed our derived total.
// hardEventCap (20000): backstop on total events processed per session.
//
// maxMoves (20000) is the ONE tunable the replay path reads, and it bounds
// WORK — see MAX_MOVES above.
const DEFAULTS = {
  maxCellsPerPiece: 5,
  maxLinesPerMove: 8,
  minPlaceIntervalMs: 90,
  maxScorePerSec: 60,
  flatSlack: 300,
  dropTolerance: 400,
  hardEventCap: 20000,
  maxMoves: MAX_MOVES,
};

function init({ seed, maxDurationSecs, tunables } = {}) {
  const t = { ...DEFAULTS, ...(tunables || {}) };
  return {
    // 'v1' until a v2 start marker arrives — see the header.
    mode: 'v1',
    sim: null,
    seed: typeof seed === 'string' ? seed : null,

    score: 0,        // rate-bounded credited score (v1 path)
    derived: 0,      // sum of points we re-derived ourselves (v1 path)
    combo: 0,        // consecutive scoring moves; tracked HERE, never sent
    claimed: 0,      // monotonic HUD high-water mark the client reported
    placements: 0,
    startT: null,    // tHint of the first placement
    lastT: null,     // tHint of the latest placement
    lastPlaceT: null,
    events: 0,
    rejectCount: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 600,
    tunables: t,
    // Forensics only, on the sim path: the HUD value the client last reported,
    // so a replay/HUD gap is visible in review even when the gate is off. It is
    // NEVER read to credit a point — `require_claimed_match` in submitSession
    // is what compares the two.
    claimedHud: 0,
  };
}

// v1 only: cap the credited score at max-rate x play-span + one-time slack.
function boundedScore(state) {
  const T = state.tunables || DEFAULTS;
  const spanSec = state.startT === null
    ? 0
    : Math.min(Math.max(0, (state.lastT - state.startT) / 1000), state.maxDurationSecs);
  const ceiling = T.maxScorePerSec * spanSec + T.flatSlack;
  const recovered = Math.min(state.claimed, state.derived + T.dropTolerance);
  return Math.min(Math.max(state.derived, recovered), ceiling);
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};

  // The start marker opts this trace into the simulator. Without it we are
  // looking at a pre-replay client and must keep scoring it the old way.
  if (payload.kind === 'start') {
    if (Number(payload.v) >= 2 && state.mode !== 'sim') {
      const sim = initSim(state.seed);
      // No seed means no deal, and therefore no replay. Staying on the v1 path
      // is the honest fallback: it still scores the run from the summaries the
      // client sent rather than zeroing a player over a session-start problem.
      if (sim) { state.mode = 'sim'; state.sim = sim; }
    }
    return { accepted: true, newScore: state.score };
  }

  if (payload.kind !== 'place') {
    return { accepted: true, newScore: state.score };
  }

  // ── replay path ────────────────────────────────────────────────────
  if (state.mode === 'sim') {
    const sim = state.sim;

    // Forensic only. Recorded before anything can reject, because its purpose
    // is to make a client/server gap visible in review — including on a trace
    // the server refuses. It cannot credit a point on this path.
    const sa = Number(payload.scoreAfter);
    if (Number.isFinite(sa) && sa > state.claimedHud) state.claimedHud = sa;

    if (sim.moves >= (state.tunables || DEFAULTS).maxMoves) {
      state.rejectCount++;
      return { accepted: false, newScore: state.score, reason: 'move_cap' };
    }

    // `typeof` FIRST, because Number() coerces: Number(null) is 0, so a
    // slotless move would otherwise be silently applied at slot 0. (That exact
    // bug was live in the Smash Down validator and was found by its adversarial
    // suite, not by reading the code.)
    const slot = payload.slot;
    const col = payload.col;
    const row = payload.row;
    if (typeof slot !== 'number' || typeof col !== 'number' || typeof row !== 'number') {
      // Breaks the streak for the same reason an illegal move does — see below.
      sim.combo = 0;
      state.rejectCount++;
      return { accepted: false, newScore: state.score, reason: 'malformed' };
    }

    const result = applyPlacement(sim, slot, col, row);
    if (!result) {
      // An ILLEGAL move: an empty or out-of-range slot, off the grid, or over
      // an occupied cell. Refused, and the board is left untouched.
      //
      // The rejection also BREAKS THE COMBO STREAK. A refused placement still
      // happened on the client, so our board and theirs have diverged and we no
      // longer know what the later moves cleared; carrying a streak across that
      // gap would credit a later clear a bigger bonus than the game gave, and
      // would let a client protect a streak by deliberately sending junk.
      // Breaking it can only ever LOWER the score, which is the safe direction.
      sim.combo = 0;
      state.rejectCount++;
      return { accepted: false, newScore: state.score, reason: 'illegal_move' };
    }

    state.score = sim.score;
    state.placements += 1;
    state.events += 1;
    return { accepted: true, newScore: state.score };
  }

  // ── v1 summary path ────────────────────────────────────────────────
  const T = state.tunables || DEFAULTS;

  const reject = (reason) => {
    state.combo = 0;
    state.rejectCount++;
    return { accepted: false, newScore: state.score, reason };
  };

  if (state.events >= T.hardEventCap) {
    state.dead = true;
    return { accepted: false, newScore: state.score, reason: 'hard_cap' };
  }

  const tHint = Number(payload.tHint);
  const cells = Number(payload.cells);
  const rows = Number(payload.rows);
  const cols = Number(payload.cols);
  const scoreAfter = Number(payload.scoreAfter);

  const intInRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

  if (!Number.isFinite(tHint) || tHint < 0
      || !Number.isFinite(scoreAfter) || scoreAfter < 0
      || !intInRange(cells, 1, T.maxCellsPerPiece)
      || !intInRange(rows, 0, 8)
      || !intInRange(cols, 0, 8)) {
    return reject('malformed');
  }

  const linesCleared = rows + cols;
  if (linesCleared > T.maxLinesPerMove) {
    return reject('too_many_lines');
  }

  const perfect = payload.perfect === true;
  if (perfect && linesCleared === 0) {
    return reject('impossible_perfect');
  }

  if (state.lastPlaceT !== null && tHint - state.lastPlaceT < T.minPlaceIntervalMs) {
    return reject('too_fast');
  }

  const streak = linesCleared > 0 ? state.combo + 1 : 0;
  const points = cells
    + lineClearBonus(linesCleared)
    + (linesCleared > 0 ? comboBonus(streak) : 0)
    + (rows > 0 && cols > 0 ? 10 : 0)
    + (perfect ? 100 : 0);

  state.combo = streak;
  state.derived += points;
  state.events += 1;
  state.placements += 1;
  state.lastPlaceT = tHint;
  if (state.startT === null) state.startT = tHint;
  state.lastT = state.lastT === null ? tHint : Math.max(state.lastT, tHint);
  if (scoreAfter > state.claimed) state.claimed = scoreAfter; // monotonic

  state.score = boundedScore(state);
  return { accepted: true, newScore: state.score };
}

function finalize(state) {
  if (state.mode === 'sim' && state.sim) {
    const sim = state.sim;
    // There is NO run-out here, and that is a property of the game rather than
    // an omission. Block Blast is turn based: nothing advances between inputs,
    // so once the last placement is applied the world is already final. (The
    // physics games have to keep stepping past the last input, bounded by the
    // SESSION's own max duration, or a player who pressed once and held would
    // lose the whole tail of their run.)
    return {
      score: sim.score,
      // The run genuinely ends when nothing fits. A trace that stops earlier is
      // a player who closed the tab or a submit that raced the last move; we
      // still score what they played.
      gameOver: sim.over,
      suspicious: state.rejectCount >= 5 ? `validator_rejects:${state.rejectCount}` : null,
      debug: {
        mode: 'sim',
        score: sim.score,
        moves: sim.moves,
        deals: sim.deals,
        combo: sim.combo,
        over: sim.over,
        rejects: state.rejectCount,
        claimedHud: Math.floor(state.claimedHud),
        diff: Math.floor(state.claimedHud) - sim.score,
      },
    };
  }

  const score = Math.floor(boundedScore(state));
  const T = state.tunables || DEFAULTS;
  const spanSec = state.startT === null
    ? 0
    : Math.min(Math.max(0, (state.lastT - state.startT) / 1000), state.maxDurationSecs);
  return {
    score,
    gameOver: state.dead,
    suspicious: state.rejectCount >= 5 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'v1',
      credited: score,
      derived: state.derived,
      hudSnapshot: Math.floor(state.claimed),
      diff: Math.floor(state.claimed) - state.derived,
      placements: state.placements,
      ceiling: Math.floor(T.maxScorePerSec * spanSec + T.flatSlack),
      elapsedSec: Math.round(spanSec * 100) / 100,
      events: state.events,
    },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  init,
  processEvent,
  finalize,
  simulate,
  DEFAULTS,
  _sim: {
    initSim, applyPlacement, dealTray, canPlaceAny, fits, mulberry32,
    SHAPES, COLOR_COUNT, TRAY_SIZE, ROWS, COLS, MAX_MOVES,
  },
  _internal: { DEFAULTS, lineClearBonus, comboBonus },
};
