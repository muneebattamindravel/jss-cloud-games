'use strict';

/**
 * Tetris Smash validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a 10 x 20 well (two hidden rows above, the board is 10 x 22).
 * Pieces fall under gravity, a grounded piece locks after LOCK_STEPS, full rows
 * clear and score by level. The run lasts RUN_STEPS (5 minutes) or ends when a
 * new piece cannot spawn. Piece K of the run comes from a 7-bag: bag floor(K/7)
 * is shuffled by Fisher-Yates with six draws hash32(seed, bag, i), never from a
 * running stream.
 *
 * What the server does with a trace:
 *   1. rebuilds the run from the session seed;
 *   2. for every step, exactly as the client's processStep does: beginStep,
 *      then every accepted act whose `step` names that step, in trace order,
 *      then stepSim;
 *   3. adds up the score. An act the rules refuse is refused here too and
 *      changes nothing.
 *
 * Trace v2: { kind: 'start', v: 2 }, then { kind: 'act', n, a, step } per
 * ACCEPTED action: n is its index in the run (sim.n before it applied), a the
 * action code (0 left, 1 right, 2 clockwise, 3 anticlockwise, 4 soft drop on,
 * 5 soft drop off, 6 hard drop), step the step it was applied before.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/tetris-smash/js/rules.js.
 * shared/tests/tetrisSmashParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump, never an edit
 * in place.
 */

  // ==== TETRIS SMASH RULES BEGIN ====
  // Carried word for word in shared/anticheat/validators/tetrisSmash.js.
  // Integers only. No clock, no screen, no random numbers. Every action is applied
  // before the fixed 1/60 s step it names; piece K comes from a 7-bag shuffled
  // by a pure function of (seed, bag index) with six draws on every bag.
  var RULES_VERSION = 2;
  var COLS = 10;
  var ROWS = 22;                 // rows 0 and 1 are hidden above the well
  var HIDDEN = 2;
  var RUN_STEPS = 18000;         // 5 minutes of play at 60 steps a second
  var LOCK_STEPS = 30;           // a grounded piece locks after 30 steps
  var LOCK_RESETS = 15;          // a move or turn on the ground restarts that wait, 15 times a piece at most
  var SOFT_G = 2;                // soft drop: one row every 2 steps
  var SPAWN_STEPS = 6;           // the gap before the next piece appears
  var CLEAR_STEPS = 24;          // the same gap when rows were cleared
  var LINES_PER_LEVEL = 10;
  var MAX_ACTS = 40000;          // a work bound, far above any human run
  var GRAVITY = [48, 40, 33, 27, 22, 18, 15, 12, 10, 8, 7, 6, 5, 4, 4, 3, 3, 2, 2, 1];   // steps a row, level 1 to 20
  var LINE_POINTS = [0, 100, 300, 500, 800];
  var COMBO_POINTS = 50;
  var HARD_POINTS = 2;           // a hard drop scores 2 a row fallen
  // Actions: 0 left, 1 right, 2 turn clockwise, 3 turn anticlockwise,
  // 4 soft drop on, 5 soft drop off, 6 hard drop.
  var A_LEFT = 0, A_RIGHT = 1, A_CW = 2, A_CCW = 3, A_SOFT_ON = 4, A_SOFT_OFF = 5, A_HARD = 6;
  // Pieces 0..6: I O T S Z J L. Rotation 0 cells (x, y) inside a box of BOX[t].
  var BOX = [4, 4, 3, 3, 3, 3, 3];
  var BASE = [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[2, 0], [0, 1], [1, 1], [2, 1]]
  ];
  var SPAWN_X = 3, SPAWN_Y = 1;
  // Kick tests (dx, dy with y DOWN), indexed [from * 4 + to]. JLSTZ, then I.
  var KICKS = {
    1: [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    4: [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    6: [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    9: [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    11: [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    14: [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    12: [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    3: [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]
  };
  var KICKS_I = {
    1: [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
    4: [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
    6: [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
    9: [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
    11: [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
    14: [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
    12: [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
    3: [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]]
  };
  function hash32(a, b, c) {
    var h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul(b | 0, 0x85EBCA6B) ^ Math.imul(c | 0, 0xC2B2AE35)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846CA68B) >>> 0; h ^= h >>> 16;
    return h >>> 0;
  }
  function seedToInt(seedHex) {
    return (typeof seedHex === 'string' && /^[0-9a-fA-F]{8}/.test(seedHex)) ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
  }
  // The cells of piece t in rotation r, turned clockwise r times inside its box.
  function pieceCells(t, r) {
    var n = BOX[t], out = [], i, k;
    for (i = 0; i < 4; i++) {
      var x = BASE[t][i][0], y = BASE[t][i][1];
      if (t !== 1) for (k = 0; k < r; k++) { var nx = n - 1 - y; y = x; x = nx; }
      out.push([x, y]);
    }
    return out;
  }
  // Piece number k of the run (k from 0): bag floor(k / 7), shuffled with six draws.
  function pieceAt(seedInt, k) {
    var bag = Math.floor(k / 7), arr = [0, 1, 2, 3, 4, 5, 6], i;
    for (i = 6; i >= 1; i--) {
      var j = hash32(seedInt, bag, i) % (i + 1);
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr[k % 7];
  }
  function fits(board, t, r, x, y) {
    var c = pieceCells(t, r);
    for (var i = 0; i < 4; i++) {
      var cx = x + c[i][0], cy = y + c[i][1];
      if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return false;
      if (board[cy * COLS + cx]) return false;
    }
    return true;
  }
  function dropDistance(board, p) {
    var d = 0;
    while (fits(board, p.t, p.r, p.x, p.y + d + 1)) d++;
    return d;
  }
  function gravityFor(level) { return GRAVITY[Math.min(GRAVITY.length, level) - 1]; }
  function initSim(seedInt) {
    var b = [], i;
    for (i = 0; i < COLS * ROWS; i++) b.push(0);
    var sim = {
      seed: seedInt >>> 0, board: b, cur: null, k: 0,
      frame: 0, gc: 0, lockT: 0, resets: 0, soft: false, wait: 0,
      score: 0, lines: 0, level: 1, combo: -1, b2b: false, n: 0,
      dead: false, end: '', ev: []
    };
    spawn(sim);
    return sim;
  }
  // Put the next piece from the bags in the well.
  function spawn(sim) {
    var t = pieceAt(sim.seed, sim.k);
    sim.k = sim.k + 1;
    var p = { t: t, r: 0, x: SPAWN_X, y: SPAWN_Y };
    sim.gc = 0; sim.lockT = 0; sim.resets = 0;
    if (!fits(sim.board, p.t, p.r, p.x, p.y)) { sim.cur = null; sim.dead = true; sim.end = 'topout'; sim.ev = sim.ev.concat([{ e: 'topout' }]); return; }
    sim.cur = p;
    sim.ev = sim.ev.concat([{ e: 'spawn', t: t }]);
  }
  function grounded(sim) { return !fits(sim.board, sim.cur.t, sim.cur.r, sim.cur.x, sim.cur.y + 1); }
  // A move or turn that succeeds on the ground restarts the lock wait, up to LOCK_RESETS times.
  function touched(sim, wasGround) {
    if ((wasGround || grounded(sim)) && sim.resets < LOCK_RESETS) { sim.lockT = 0; sim.resets = sim.resets + 1; }
  }
  function lockPiece(sim, hard) {
    var p = sim.cur, c = pieceCells(p.t, p.r), nb = sim.board.slice(), i, r, x;
    for (i = 0; i < 4; i++) nb[(p.y + c[i][1]) * COLS + p.x + c[i][0]] = p.t + 1;
    var full = [];
    for (r = 0; r < ROWS; r++) {
      var all = true;
      for (x = 0; x < COLS; x++) if (!nb[r * COLS + x]) { all = false; break; }
      if (all) full.push(r);
    }
    var gained = 0, level = sim.level;
    if (full.length) {
      var kept = [];
      for (r = 0; r < ROWS; r++) if (full.indexOf(r) < 0) for (x = 0; x < COLS; x++) kept.push(nb[r * COLS + x]);
      var fresh = [];
      for (i = 0; i < full.length * COLS; i++) fresh.push(0);
      nb = fresh.concat(kept);
      var base = LINE_POINTS[full.length] * level;
      if (full.length === 4 && sim.b2b) base = Math.floor(base * 3 / 2);
      gained = base;
      sim.combo = sim.combo + 1;
      if (sim.combo > 0) gained = gained + COMBO_POINTS * sim.combo * level;
      sim.b2b = full.length === 4;
      sim.lines = sim.lines + full.length;
      sim.level = 1 + Math.floor(sim.lines / LINES_PER_LEVEL);
    } else {
      sim.combo = -1;
    }
    sim.board = nb;
    sim.score = sim.score + gained;
    sim.cur = null;
    sim.wait = full.length ? CLEAR_STEPS : SPAWN_STEPS;
    sim.ev = sim.ev.concat([{ e: 'lock', t: p.t, r: p.r, x: p.x, y: p.y, rows: full, gained: gained, combo: sim.combo, hard: !!hard, level: sim.level, levelUp: sim.level > level }]);
  }
  // One action. Returns true when applied, or the reason it was refused. A
  // refusal changes nothing.
  function actSim(sim, a) {
    if (sim.dead) return 'dead';
    if (a !== 0 && a !== 1 && a !== 2 && a !== 3 && a !== 4 && a !== 5 && a !== 6) return 'bad_action';
    if (sim.n >= MAX_ACTS) return 'act_cap';
    if (a === A_SOFT_ON) { if (sim.soft) return 'no_change'; sim.soft = true; sim.n = sim.n + 1; return true; }
    if (a === A_SOFT_OFF) { if (!sim.soft) return 'no_change'; sim.soft = false; sim.n = sim.n + 1; return true; }
    var p = sim.cur;
    if (!p) return 'no_piece';
    if (a === A_LEFT || a === A_RIGHT) {
      var dx = a === A_LEFT ? -1 : 1, g0 = grounded(sim);
      if (!fits(sim.board, p.t, p.r, p.x + dx, p.y)) return 'blocked';
      sim.cur = { t: p.t, r: p.r, x: p.x + dx, y: p.y };
      touched(sim, g0);
      sim.n = sim.n + 1;
      return true;
    }
    if (a === A_CW || a === A_CCW) {
      if (p.t === 1) return 'no_turn';
      var to = (p.r + (a === A_CW ? 1 : 3)) % 4, table = p.t === 0 ? KICKS_I : KICKS, tests = table[p.r * 4 + to], g1 = grounded(sim);
      for (var i = 0; i < tests.length; i++) {
        var nx = p.x + tests[i][0], ny = p.y + tests[i][1];
        if (fits(sim.board, p.t, to, nx, ny)) {
          sim.cur = { t: p.t, r: to, x: nx, y: ny };
          touched(sim, g1);
          sim.n = sim.n + 1;
          return true;
        }
      }
      return 'blocked';
    }
    // A_HARD: straight down and locked at once.
    var d = dropDistance(sim.board, p);
    sim.cur = { t: p.t, r: p.r, x: p.x, y: p.y + d };
    sim.score = sim.score + HARD_POINTS * d;
    sim.n = sim.n + 1;
    lockPiece(sim, true);
    return true;
  }
  // One fixed step: the spawn wait, gravity and the lock, then the clock.
  // Both sides call this at the start of each step, before that step's actions.
  function beginStep(sim) { sim.ev = []; }
  function stepSim(sim) {
    if (sim.dead) return;
    if (!sim.cur) {
      if (sim.wait > 0) sim.wait = sim.wait - 1;
      if (sim.wait === 0) spawn(sim);
    } else {
      var g = gravityFor(sim.level);
      if (sim.soft && SOFT_G < g) g = SOFT_G;
      sim.gc = sim.gc + 1;
      if (sim.gc >= g) {
        sim.gc = 0;
        if (!grounded(sim)) {
          var p = sim.cur;
          sim.cur = { t: p.t, r: p.r, x: p.x, y: p.y + 1 };
        }
      }
      if (grounded(sim)) {
        sim.lockT = sim.lockT + 1;
        if (sim.lockT >= LOCK_STEPS) lockPiece(sim, false);
      } else {
        sim.lockT = 0;
      }
    }
    sim.frame = sim.frame + 1;
    if (!sim.dead && sim.frame >= RUN_STEPS) { sim.dead = true; sim.end = 'time'; }
  }
  // ==== TETRIS SMASH RULES END ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it. The rules end a run at
// RUN_STEPS long before this.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound on trace events, above the rules' own MAX_ACTS so the rules
// refuse first. It REFUSES further inputs, it never zeroes.
const MAX_INPUTS = MAX_ACTS + 20000;

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, open: false, seen: 0,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { actSteps: [], piece: null, perPiece: [], finesse: [], place: [], perStep: 0, maxPerStep: 0, lastStep: -1 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. Per piece: the actions spent on it, the extra
// moves and turns over the fewest that reach its final place from spawn on
// an empty well (a planner is exact, a hand wastes some), and the steps from
// spawn to lock. Across the run: the spread of the gaps between actions.
function cellsKey(t, r, x, y) {
  const c = pieceCells(t, r);
  let minY = 99;
  for (const q of c) minY = Math.min(minY, y + q[1]);
  return c.map((q) => (x + q[0]) + ':' + (y + q[1] - minY)).sort().join(',');
}
const EMPTY = (() => { const b = []; for (let i = 0; i < COLS * ROWS; i++) b.push(0); return b; })();
// Fewest moves and turns from spawn to a placement with the same cells
// (rotation-symmetric pieces count by cells, not by rotation index), on an
// empty well with the game's own kicks. null when no such path exists.
function fewestMoves(t, target) {
  const sim = { board: EMPTY, cur: { t, r: 0, x: SPAWN_X, y: SPAWN_Y }, dead: false, n: 0, soft: false, lockT: 0, resets: 0 };
  const key = (p) => p.r + '/' + p.x + '/' + p.y;
  const seen = new Set([key(sim.cur)]);
  let frontier = [sim.cur];
  for (let d = 0; d <= 12; d++) {
    const next = [];
    for (const p of frontier) {
      if (cellsKey(p.t, p.r, p.x, p.y) === target) return d;
      for (const a of [A_LEFT, A_RIGHT, A_CW, A_CCW]) {
        const s = { board: EMPTY, cur: p, dead: false, n: 0, soft: false, lockT: 0, resets: 0 };
        if (actSim(s, a) !== true) continue;
        const k = key(s.cur);
        if (!seen.has(k)) { seen.add(k); next.push(s.cur); }
      }
    }
    frontier = next;
  }
  return null;
}
function noteEvents(state) {
  const sim = state.sim, st = state.stats;
  for (; state.seen < sim.ev.length; state.seen++) {
    const e = sim.ev[state.seen];
    if (e.e === 'spawn') st.piece = { t: e.t, at: sim.frame, acts: 0, moves: 0 };
    else if (e.e === 'lock' && st.piece) {
      const p = st.piece;
      st.perPiece.push(p.acts);
      st.place.push(sim.frame - p.at);
      const min = fewestMoves(e.t, cellsKey(e.t, e.r, e.x, e.y));
      if (min !== null) st.finesse.push(Math.max(0, p.moves - min));
      st.piece = null;
    }
  }
}
function openStep(state) {
  if (state.open) return;
  beginStep(state.sim);
  state.seen = 0;
  state.open = true;
}
function stepOnce(state) {
  openStep(state);
  stepSim(state.sim);
  noteEvents(state);
  state.open = false;
}
function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frame < step && sim.frame < MAX_SIM_STEPS) stepOnce(state);
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }
function gapCv(steps) {
  if (steps.length < 3) return null;
  const g = [];
  for (let i = 1; i < steps.length; i++) g.push(steps[i] - steps[i - 1]);
  const m = mean(g); const s = sd(g);
  return m > 0 && s !== null ? s / m : null;
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
      state.sim = initSim(seedToInt(state.seed));
      state.seen = state.sim.ev.length;
      noteEvents(state);
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'act') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, a, step } = payload;
  if (!isInt(n) || !isInt(a) || !isInt(step)) return reject(state, 'bad_act');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would re-run a window and keep the
  // best outcome.
  if (step < sim.frame) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.frame !== step) return reject(state, 'beyond_cap');
  // The act names its index in the run; any other index is out of order.
  if (n !== sim.n) return reject(state, 'out_of_order');
  openStep(state);
  const piece = sim.cur;
  const r = actSim(sim, a);
  if (r !== true) return reject(state, 'refused:' + r);
  const st = state.stats;
  st.actSteps.push(step);
  if (step === st.lastStep) st.perStep++; else { st.perStep = 1; st.lastStep = step; }
  if (st.perStep > st.maxPerStep) st.maxPerStep = st.perStep;
  if (piece && st.piece) { st.piece.acts++; if (a <= A_CCW) st.piece.moves++; }
  noteEvents(state);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always ends inside this bound.
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
  // Run the world out past the last act: gravity keeps falling, pieces lock,
  // and the clock ends the run at RUN_STEPS.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frame < capSteps && sim.frame < MAX_SIM_STEPS) {
    stepOnce(state);
    guard++;
  }
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.frame, end: sim.end, dead: sim.dead,
      score: sim.score, lines: sim.lines, level: sim.level, pieces: sim.k,
      inputs: state.inputCount, rejects: state.rejectCount, acts: st.actSteps.length,
      actsPerPiece: round3(mean(st.perPiece)),
      finesseMean: round3(mean(st.finesse)), finesseZeroShare: st.finesse.length ? round3(st.finesse.filter((f) => f === 0).length / st.finesse.length) : null,
      placeMean: round3(mean(st.place)), placeSd: round3(sd(st.place)),
      gapCv: round3(gapCv(st.actSteps)), maxActsPerStep: st.maxPerStep,
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
  _limits: { MAX_SIM_STEPS, MAX_INPUTS, FPS: 60 },
  RULES_VERSION,
  init, processEvent, finalize, simulate,
  _sim: {
    RULES_VERSION, COLS, ROWS, HIDDEN, RUN_STEPS, LOCK_STEPS, LOCK_RESETS, SOFT_G, SPAWN_STEPS, CLEAR_STEPS,
    LINES_PER_LEVEL, MAX_ACTS, GRAVITY, LINE_POINTS, COMBO_POINTS, HARD_POINTS,
    A_LEFT, A_RIGHT, A_CW, A_CCW, A_SOFT_ON, A_SOFT_OFF, A_HARD, BOX, BASE, SPAWN_X, SPAWN_Y, KICKS, KICKS_I,
    hash32, seedToInt, pieceCells, pieceAt, fits, dropDistance, gravityFor, initSim, spawn, grounded, touched,
    lockPiece, actSim, beginStep, stepSim, MAX_INPUTS, MAX_SIM_STEPS, fewestMoves, cellsKey, elapsedCap,
  },
};
