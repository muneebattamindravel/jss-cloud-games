// Minar Tod: the rules. Everything that decides the score lives here.
// Integer only, fixed 1/60 s steps, the course is a pure function of the seed.
// The renderer reads this state and never writes it.

// ==== MINAR TOD RULES BEGIN ====
var STEP_HZ = 60;
var RUN_STEPS = 180 * STEP_HZ;      // 3 minute clock
var COLS = 8;                       // blocks around the cylinder
var ANG = 65536;                    // one full turn, in angle units
var COL_ANG = 8192;                 // ANG / COLS
var FLIGHT = 12;                    // steps a ball flies before it lands
var TRANS_STEPS = 120;              // steps between towers (no input)
var MAX_LEVELS = 20;
var COPY_DOWN = 70, COPY_SIDE = 130;   // out of 256: how often a cell copies a neighbour
var STAND_STEPS = 240;

var EMPTY = 0, STEEL = 6, BOMB = 7; // colours are 1..5

var HASH_K = 0x9e3779b1, HASH_J = 0x85ebca77, MIX_A = 0x7feb352d, MIX_B = 0x846ca68b;

// Quarter sine, amplitude 1024, 64 steps per quarter turn (256 per turn).
var SINQ = [0, 25, 50, 75, 100, 125, 150, 175, 200, 224, 249, 273, 297, 321, 345, 369,
  392, 415, 438, 460, 483, 505, 526, 548, 569, 590, 610, 630, 650, 669, 688, 706,
  724, 742, 759, 775, 792, 807, 822, 837, 851, 865, 878, 891, 903, 915, 926, 936,
  946, 955, 964, 972, 980, 987, 993, 999, 1004, 1009, 1013, 1016, 1019, 1021, 1023, 1024, 1024];

function isin(i) {
  i = i & 255;
  if (i < 64) return SINQ[i];
  if (i < 128) return SINQ[128 - i];
  if (i < 192) return -SINQ[i - 128];
  return -SINQ[256 - i];
}

function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, HASH_K) ^ Math.imul(j + 1, HASH_J)) | 0;
  h = Math.imul(h ^ (h >>> 16), MIX_A);
  h = Math.imul(h ^ (h >>> 15), MIX_B);
  return (h ^ (h >>> 16)) >>> 0;
}

// What tower k looks like. One new thing at a time:
// 0: three colours, steady spin. 1: four colours. 2: the spin breathes.
// 3: steel. 4: five colours. 5: bombs. 6+: the spin can reverse, then it all ramps.
function towerSpec(seed, k) {
  var levels = Math.min(MAX_LEVELS, 10 + 2 * k);
  var colours = k < 1 ? 3 : k < 4 ? 4 : 5;
  var base = Math.min(260, 110 + 15 * k);          // angle units per step (a turn in 10 s at first)
  var amp = k < 2 ? 0 : k < 6 ? 512 : 1400;         // spin swing, 1024 = 100 percent of base
  var hs = hash(seed, k, 9001);
  var dir = (hs & 1) ? 1 : -1;
  var wobble = 48 + ((hs >>> 1) & 31);              // table units per 256 steps
  var phase = (hs >>> 6) & 255;
  var steel = k < 3 ? 0 : Math.min(10, 4 + (k - 3));  // percent of cells
  var bomb = k < 5 ? 0 : 2;                          // percent of cells
  return { k: k, levels: levels, colours: colours, base: base, amp: amp, dir: dir,
    wobble: wobble, phase: phase, steel: steel, bomb: bomb };
}

// Cells in a flat array, index c * MAX_LEVELS + r, r = 0 at the bottom.
function buildGrid(seed, spec) {
  var g = new Array(COLS * MAX_LEVELS);
  for (var i = 0; i < g.length; i++) g[i] = EMPTY;
  for (var r = 0; r < spec.levels; r++) {
    for (var c = 0; c < COLS; c++) {
      var h = hash(seed, 100 + spec.k, r * COLS + c);   // one draw per cell, always
      var roll = h % 100;
      var pick = 1 + ((h >>> 8) % spec.colours);
      var copy = (h >>> 16) & 255;
      var v = pick;
      if (copy < COPY_DOWN && r > 0) v = g[c * MAX_LEVELS + r - 1];
      else if (copy < COPY_SIDE && c > 0) v = g[(c - 1) * MAX_LEVELS + r];
      if (v === STEEL || v === BOMB) v = pick;
      if (roll < spec.steel && r > 0) v = STEEL;
      else if (roll >= 100 - spec.bomb && r > 1) v = BOMB;
      g[c * MAX_LEVELS + r] = v;
    }
  }
  return g;
}

function colHeight(g, c) {
  var r = 0;
  while (r < MAX_LEVELS && g[c * MAX_LEVELS + r] !== EMPTY) r++;
  return r;
}

function topHeight(g) {
  var m = 0;
  for (var c = 0; c < COLS; c++) m = Math.max(m, colHeight(g, c));
  return m;
}

function breakablesLeft(g) {
  var n = 0;
  for (var i = 0; i < g.length; i++) if (g[i] !== EMPTY && g[i] !== STEEL) n++;
  return n;
}

// The cells a hit on (c, r) breaks, as indices. Steel breaks nothing; a bomb
// clears its whole ring; a colour clears its connected group (wrapping around).
function hitCells(g, c, r) {
  var v = g[c * MAX_LEVELS + r];
  var out = [];
  if (v === EMPTY || v === STEEL) return out;
  if (v === BOMB) {
    for (var cc = 0; cc < COLS; cc++) if (g[cc * MAX_LEVELS + r] !== EMPTY) out.push(cc * MAX_LEVELS + r);
    return out;
  }
  var seen = {};
  var stack = [c * MAX_LEVELS + r];
  seen[stack[0]] = 1;
  while (stack.length) {
    var i = stack.pop();
    out.push(i);
    var ic = (i / MAX_LEVELS) | 0, ir = i - ic * MAX_LEVELS;
    var nb = [((ic + 1) % COLS) * MAX_LEVELS + ir, ((ic + COLS - 1) % COLS) * MAX_LEVELS + ir,
      ir + 1 < MAX_LEVELS ? i + 1 : -1, ir > 0 ? i - 1 : -1];
    for (var n = 0; n < 4; n++) {
      var j = nb[n];
      if (j >= 0 && !seen[j] && g[j] === v) { seen[j] = 1; stack.push(j); }
    }
  }
  out.sort(function (a, b) { return a - b; });
  return out;
}

// Remove cells and let every column settle. Returns the new grid.
function removeAndSettle(g, cells) {
  var ng = g.slice();
  for (var i = 0; i < cells.length; i++) ng[cells[i]] = EMPTY;
  for (var c = 0; c < COLS; c++) {
    var w = 0;
    for (var r = 0; r < MAX_LEVELS; r++) {
      var v = ng[c * MAX_LEVELS + r];
      if (v !== EMPTY) { ng[c * MAX_LEVELS + w] = v; w++; }
    }
    for (; w < MAX_LEVELS; w++) ng[c * MAX_LEVELS + w] = EMPTY;
  }
  return ng;
}

// Block points go into the tower and are banked only when it is smashed.
function groupPoints(n) { return 5 * n * (n + 1); }   // 1 block 10, 10 blocks 550

// Greedy: always take the biggest chunk. Every cell can be hit, so this many
// balls always clears the tower; the budget adds slack for humans.
function greedyShots(g) {
  var shots = 0;
  while (breakablesLeft(g) > 0 && shots < 400) {
    var best = null;
    for (var c = 0; c < COLS; c++) {
      var h = colHeight(g, c);
      for (var r = 0; r < h; r++) {
        var cells = hitCells(g, c, r);
        if (cells.length && (!best || cells.length > best.length)) best = cells;
      }
    }
    g = removeAndSettle(g, best);
    shots++;
  }
  return shots;
}

function ballBudget(shots) { return shots + 2 + ((shots / 10) | 0); }

function startTower(s, k) {
  var spec = towerSpec(s.seed, k);
  s.tower = k;
  s.spec = spec;
  s.grid = buildGrid(s.seed, spec);
  s.par = greedyShots(s.grid);
  s.balls = ballBudget(s.par);
  s.towerStep = 0;
  s.angle = (hash(s.seed, k, 9002) & (ANG - 1));
}

function initSim(seed) {
  var s = { seed: seed >>> 0, step: 0, score: 0, phase: 'play', trans: 0, fired: 0,
    ball: null, pending: 0, broken: 0, best: 0, cleared: 0, hits: 0 };
  startTower(s, 0);
  return s;
}

function spinSpeed(spec, t) {
  var v = spec.base;
  if (spec.amp) v = spec.base + ((spec.base * spec.amp / 1024 | 0) * isin(spec.phase + ((t * spec.wobble) >> 8)) >> 10);
  return spec.dir * v;
}

// A column can be tapped while its face is on the near half of the tower.
function colVisible(angle, c) {
  var d = ((c * COL_ANG + angle + ANG / 2) & (ANG - 1)) - ANG / 2;
  return d >= -ANG / 4 && d <= ANG / 4;
}

// Where the tower will stand `ahead` steps from now.
function angleAhead(s, ahead) {
  var a = s.angle;
  for (var i = 0; i < ahead; i++) a = (a + spinSpeed(s.spec, s.towerStep + i)) & (ANG - 1);
  return a;
}

// One tap on block (c, r). Accepted only while playing, with balls left, no
// ball in the air, and a block there on the near side of the tower.
function fire(s, c, r) {
  if (s.phase !== 'play' || s.ball || s.balls <= 0) return false;
  if (!(c >= 0 && c < COLS && r >= 0 && r < MAX_LEVELS) || c !== (c | 0) || r !== (r | 0)) return false;
  if (s.grid[c * MAX_LEVELS + r] === EMPTY || !colVisible(s.angle, c)) return false;
  s.balls--;
  s.fired++;
  s.ball = { c: c, r: r, land: s.step + FLIGHT };
  return true;
}

// Advance one step. Returns an event for the effects layer, or null.
function stepSim(s) {
  if (s.phase === 'over') return null;
  var ev = null;
  s.step++;
  if (s.phase === 'trans') {
    s.trans--;
    if (s.trans <= 0) { startTower(s, s.tower + 1); s.phase = 'play'; ev = { type: 'tower' }; }
  } else {
    s.angle = (s.angle + spinSpeed(s.spec, s.towerStep)) & (ANG - 1);
    s.towerStep++;
    if (s.ball && s.step >= s.ball.land) ev = land(s);
  }
  if (s.step >= RUN_STEPS) { s.score += s.pending; s.pending = 0; s.phase = 'over';   // the clock banks the tower in play
    s.ball = null; ev = { type: 'over', prev: ev }; }
  return ev;
}

function land(s) {
  var c = s.ball.c, r = s.ball.r;   // nothing changes the grid while a ball flies
  s.ball = null;
  var ev = { type: 'miss', c: c, r: r, cells: [], pts: 0 };
  if (s.grid[c * MAX_LEVELS + r] !== EMPTY) {
    var v = s.grid[c * MAX_LEVELS + r];
    if (v === STEEL) ev.type = 'steel';
    else {
      var cells = hitCells(s.grid, c, r);
      ev.type = v === BOMB ? 'bomb' : 'break';
      ev.colour = v;
      ev.cells = cells;
      ev.pts = groupPoints(cells.length);
      ev.before = s.grid;
      s.grid = removeAndSettle(s.grid, cells);
      s.pending += ev.pts;
      s.broken += cells.length;
      s.hits++;
      if (cells.length > s.best) s.best = cells.length;
    }
  }
  if (breakablesLeft(s.grid) === 0) {
    ev.bonus = 1000 + 500 * s.tower + 200 * s.balls;
    ev.banked = s.pending; s.pending = 0;
    s.score += ev.banked;
    ev.cleared = true;
    s.score += ev.bonus;
    s.cleared++;
    s.phase = 'trans'; s.trans = TRANS_STEPS;
  } else if (s.balls <= 0) {
    ev.stands = true;
    ev.lost = s.pending; s.pending = 0;   // a tower left standing banks nothing
    s.phase = 'trans'; s.trans = STAND_STEPS;
  }
  return ev;
}
// ==== MINAR TOD RULES END ====

if (typeof module !== 'undefined') {
  module.exports = { initSim: initSim, stepSim: stepSim, fire: fire, colVisible: colVisible, angleAhead: angleAhead,
    hitCells: hitCells, colHeight: colHeight, topHeight: topHeight, greedyShots: greedyShots,
    towerSpec: towerSpec, buildGrid: buildGrid, breakablesLeft: breakablesLeft, removeAndSettle: removeAndSettle,
    groupPoints: groupPoints, FLIGHT: FLIGHT, COLS: COLS, MAX_LEVELS: MAX_LEVELS, RUN_STEPS: RUN_STEPS,
    EMPTY: EMPTY, STEEL: STEEL, BOMB: BOMB, ANG: ANG, COL_ANG: COL_ANG, hash: hash };
}
