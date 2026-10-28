// Tetris Smash rules. A classic script (no module) so the validator can carry
// the block below word for word. The page reads it as window.TS.
(function (root) {
  'use strict';
  // ==== TETRIS SMASH RULES BEGIN (word for word in games/tetris-smash/js/rules.js and shared/anticheat/validators/tetrisSmash.js) ====
  // Integers only. No clock, no screen, no Math.random. Every action is applied
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
  // 4 soft drop on, 5 soft drop off, 6 hard drop, 7 hold.
  var A_LEFT = 0, A_RIGHT = 1, A_CW = 2, A_CCW = 3, A_SOFT_ON = 4, A_SOFT_OFF = 5, A_HARD = 6, A_HOLD = 7;
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
      seed: seedInt >>> 0, board: b, cur: null, hold: -1, holdUsed: false, k: 0,
      frame: 0, gc: 0, lockT: 0, resets: 0, soft: false, wait: 0,
      score: 0, lines: 0, level: 1, combo: -1, b2b: false, n: 0,
      dead: false, end: '', ev: []
    };
    spawn(sim, -1);
    return sim;
  }
  // Put a piece in the well: the next one from the bags, or type `t` from hold.
  function spawn(sim, t) {
    if (t < 0) { t = pieceAt(sim.seed, sim.k); sim.k = sim.k + 1; }
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
    sim.holdUsed = false;
    sim.wait = full.length ? CLEAR_STEPS : SPAWN_STEPS;
    sim.ev = sim.ev.concat([{ e: 'lock', t: p.t, r: p.r, x: p.x, y: p.y, rows: full, gained: gained, combo: sim.combo, hard: !!hard, level: sim.level, levelUp: sim.level > level }]);
  }
  // One action. Returns true when applied, or the reason it was refused. A
  // refusal changes nothing.
  function actSim(sim, a) {
    if (sim.dead) return 'dead';
    if (a !== 0 && a !== 1 && a !== 2 && a !== 3 && a !== 4 && a !== 5 && a !== 6 && a !== 7) return 'bad_action';
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
    if (a === A_HARD) {
      var d = dropDistance(sim.board, p);
      sim.cur = { t: p.t, r: p.r, x: p.x, y: p.y + d };
      sim.score = sim.score + HARD_POINTS * d;
      sim.n = sim.n + 1;
      lockPiece(sim, true);
      return true;
    }
    // A_HOLD: once per piece.
    if (sim.holdUsed) return 'hold_used';
    var held = sim.hold;
    sim.hold = p.t;
    sim.n = sim.n + 1;
    spawn(sim, held);
    sim.holdUsed = true;
    sim.ev = sim.ev.concat([{ e: 'hold', t: p.t }]);
    return true;
  }
  // One fixed step: the spawn wait, gravity and the lock, then the clock.
  // Both sides call this at the start of each step, before that step's actions.
  function beginStep(sim) { sim.ev = []; }
  function stepSim(sim) {
    if (sim.dead) return;
    if (!sim.cur) {
      if (sim.wait > 0) sim.wait = sim.wait - 1;
      if (sim.wait === 0) spawn(sim, -1);
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

  var api = {
    RULES_VERSION: RULES_VERSION, COLS: COLS, ROWS: ROWS, HIDDEN: HIDDEN, RUN_STEPS: RUN_STEPS,
    LOCK_STEPS: LOCK_STEPS, LOCK_RESETS: LOCK_RESETS, CLEAR_STEPS: CLEAR_STEPS, SPAWN_STEPS: SPAWN_STEPS,
    A_LEFT: A_LEFT, A_RIGHT: A_RIGHT, A_CW: A_CW, A_CCW: A_CCW, A_SOFT_ON: A_SOFT_ON, A_SOFT_OFF: A_SOFT_OFF,
    A_HARD: A_HARD, A_HOLD: A_HOLD, BOX: BOX,
    hash32: hash32, seedToInt: seedToInt, pieceCells: pieceCells, pieceAt: pieceAt, fits: fits,
    dropDistance: dropDistance, gravityFor: gravityFor, initSim: initSim, actSim: actSim, stepSim: stepSim, beginStep: beginStep,
    spawn: spawn, lockPiece: lockPiece
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TS = api;
})(typeof window !== 'undefined' ? window : this);
