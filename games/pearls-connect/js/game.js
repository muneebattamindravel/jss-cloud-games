/*
 * Pearls Connect: drag through pearls of one colour to clear them. Close a loop
 * and every pearl of that colour goes. Five minutes.
 *
 * Scored by the SERVER, which replays the chains this file records against the
 * session seed (shared/anticheat/validators/pearlsConnect.js). The rules block
 * below is carried word for word in that validator. A gameplay change is a
 * trace version bump, never an edit in place.
 *
 * Everything below the rules block is presentation. It reads the sim and never
 * writes it; its randomness is Math.random, which cannot reach a score.
 */
(function () {
  'use strict';

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

  var WARN_STEPS = 10 * 60;   // last 10 s: the clock warns (presentation)

  // ── layout: a fixed 414 x 736 design space ─────────────────────────────────
  var W = 414, H = 736;
  var CELL = 62, GX = (W - N * CELL) / 2, GY = 200, PR = 23;
  var BOARD = N * CELL;
  var HIT_R = CELL * 0.44;
  var SCORE_Y = 74, BAR_Y = 140;
  var FONT = "'Titan One', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  var GEMS = [
    { name: 'ruby',     base: '#ff3d6e', light: '#ffc2d3', dark: '#8f0f36', glow: '255,61,110' },
    { name: 'emerald',  base: '#22d58a', light: '#c4ffe4', dark: '#0a6e45', glow: '34,213,138' },
    { name: 'sapphire', base: '#3f8cff', light: '#cfe1ff', dark: '#173a9c', glow: '63,140,255' },
    { name: 'topaz',    base: '#ffbe2e', light: '#fff0c0', dark: '#a35d00', glow: '255,190,46' },
    { name: 'amethyst', base: '#b265ff', light: '#ead6ff', dark: '#5a1aa8', glow: '178,101,255' },
  ];
  var PRAISE = [[10, 'AMAZING!'], [8, 'SUPERB!'], [6, 'GREAT!'], [4, 'NICE!']];

  var canvas = document.getElementById('scene'), ctx = canvas.getContext('2d');
  var topCv = document.getElementById('top'), tctx = topCv.getContext('2d');
  var dpr = 1, cw = 0, ch = 0, sc = 1, ox = 0, oy = 0;
  var SPR = { pearl: [], glow: [], tray: [], shadow: null, bg: null, vigRed: null, star: null };

  function mk(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function rrect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  // ── sprites, drawn once per screen size ────────────────────────────────────
  // A pearl: deep body, a bright core lit from the top left, light bouncing up
  // from below, a hard specular and a soft one, and a faint engraved mark per
  // colour so colour-blind players can tell them apart.
  function buildPearl(k) {
    var gm = GEMS[k], px = sc * dpr, pad = 6, s = PR * 2 + pad * 2, c = mk(s * px, s * px), g = c.getContext('2d'), m = s / 2, R = PR;
    g.scale(px, px);
    var body = g.createRadialGradient(m - R * 0.35, m - R * 0.42, R * 0.08, m, m, R * 1.05);
    body.addColorStop(0, gm.light); body.addColorStop(0.32, gm.base); body.addColorStop(0.85, gm.dark); body.addColorStop(1, gm.dark);
    g.beginPath(); g.arc(m, m, R, 0, Math.PI * 2); g.fillStyle = body; g.fill();
    g.save(); g.beginPath(); g.arc(m, m, R, 0, Math.PI * 2); g.clip();
    var bounce = g.createRadialGradient(m + R * 0.15, m + R * 0.75, 0, m + R * 0.15, m + R * 0.75, R * 0.8);
    bounce.addColorStop(0, 'rgba(255,255,255,0.42)'); bounce.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = bounce; g.fillRect(0, 0, s, s);
    // engraved mark
    g.globalAlpha = 0.16; g.fillStyle = '#ffffff'; g.strokeStyle = '#ffffff'; g.lineWidth = 2;
    var mr = R * 0.28;
    g.beginPath();
    if (k === 0) { g.moveTo(m, m - mr); g.lineTo(m + mr, m); g.lineTo(m, m + mr); g.lineTo(m - mr, m); g.closePath(); g.fill(); }
    else if (k === 1) { g.arc(m, m, mr * 0.8, 0, Math.PI * 2); g.stroke(); }
    else if (k === 2) { g.moveTo(m, m - mr); g.lineTo(m + mr * 0.9, m + mr * 0.7); g.lineTo(m - mr * 0.9, m + mr * 0.7); g.closePath(); g.fill(); }
    else if (k === 3) { for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? mr * 0.45 : mr; g.lineTo(m + Math.cos(a) * rr, m + Math.sin(a) * rr); } g.closePath(); g.fill(); }
    else { g.rect(m - mr * 0.7, m - mr * 0.7, mr * 1.4, mr * 1.4); g.fill(); }
    g.globalAlpha = 1;
    g.restore();
    g.lineWidth = 1.2; g.strokeStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.arc(m, m, R - 0.6, 0, Math.PI * 2); g.stroke();
    // speculars
    g.save(); g.translate(m - R * 0.36, m - R * 0.44); g.rotate(-0.6);
    var sp = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.36);
    sp.addColorStop(0, 'rgba(255,255,255,0.95)'); sp.addColorStop(0.6, 'rgba(255,255,255,0.35)'); sp.addColorStop(1, 'rgba(255,255,255,0)');
    g.scale(1, 0.58); g.fillStyle = sp; g.beginPath(); g.arc(0, 0, R * 0.36, 0, Math.PI * 2); g.fill();
    g.restore();
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(m + R * 0.42, m + R * 0.36, R * 0.07, 0, Math.PI * 2); g.fill();
    return c;
  }
  function buildGlow(k, r) {
    var px = sc * dpr, s = r * 2, c = mk(s * px, s * px), g = c.getContext('2d');
    g.scale(px, px);
    var gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(' + GEMS[k].glow + ',0.9)'); gr.addColorStop(0.35, 'rgba(' + GEMS[k].glow + ',0.35)'); gr.addColorStop(1, 'rgba(' + GEMS[k].glow + ',0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    return c;
  }
  function buildShadow() {
    var px = sc * dpr, s = PR * 2 + 16, c = mk(s * px, s * 0.6 * px), g = c.getContext('2d');
    g.scale(px, px);
    var gr = g.createRadialGradient(s / 2, s * 0.3, 0, s / 2, s * 0.3, s / 2);
    gr.addColorStop(0, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.save(); g.scale(1, 0.6); g.fillStyle = gr; g.fillRect(0, 0, s, s); g.restore();
    return c;
  }
  // A glowing frame round the board in one colour, for loops.
  function buildTrayGlow(k) {
    var px = sc * dpr, pad = 40, w = BOARD + 24 + pad * 2, h = w, c = mk(w * px, h * px), g = c.getContext('2d');
    g.scale(px, px);
    g.shadowColor = 'rgba(' + GEMS[k].glow + ',1)'; g.shadowBlur = 26;
    g.strokeStyle = 'rgba(' + GEMS[k].glow + ',1)'; g.lineWidth = 5;
    rrect(g, pad, pad, BOARD + 24, BOARD + 24, 26); g.stroke(); g.stroke();
    return c;
  }
  function buildStar() {
    var px = sc * dpr, s = 24, c = mk(s * px, s * px), g = c.getContext('2d');
    g.scale(px, px); g.translate(s / 2, s / 2);
    g.fillStyle = '#fff'; g.beginPath();
    for (var i = 0; i < 8; i++) { var a = i * Math.PI / 4, r = i % 2 ? 2.2 : 11; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill();
    var gr = g.createRadialGradient(0, 0, 0, 0, 0, 7); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 7, 0, Math.PI * 2); g.fill();
    return c;
  }
  // The whole backdrop at screen size: a night sky gradient, a faint jali of
  // eight-point stars, and the board tray with its gold rim and sockets.
  function buildBg() {
    var c = mk(canvas.width, canvas.height), g = c.getContext('2d'), i, j;
    var gr = g.createRadialGradient(c.width / 2, c.height * 0.38, 0, c.width / 2, c.height * 0.38, Math.max(c.width, c.height) * 0.8);
    gr.addColorStop(0, '#2b1d62'); gr.addColorStop(0.55, '#150f3a'); gr.addColorStop(1, '#07061a');
    g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
    // jali pattern
    var u = 46 * sc * dpr, cx0 = (ox + W / 2) * dpr, cy0 = (oy + GY + BOARD / 2) * dpr;
    g.strokeStyle = 'rgba(255,214,120,0.06)'; g.lineWidth = 1.2 * dpr;
    var nx = Math.ceil(c.width / u / 2) + 1, ny = Math.ceil(c.height / u / 2) + 1;
    for (i = -nx; i <= nx; i++) for (j = -ny; j <= ny; j++) {
      var x = cx0 + i * u, y = cy0 + j * u, r = u * 0.42;
      g.beginPath(); g.rect(x - r * 0.7, y - r * 0.7, r * 1.4, r * 1.4); g.stroke();
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4); g.beginPath(); g.rect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4); g.stroke(); g.restore();
    }
    // tray
    g.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
    var tx = GX - 12, ty = GY - 12, tw = BOARD + 24;
    g.save(); g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 30; g.shadowOffsetY = 12;
    rrect(g, tx, ty, tw, tw, 26); g.fillStyle = '#140d33'; g.fill(); g.restore();
    var fill = g.createLinearGradient(0, ty, 0, ty + tw);
    fill.addColorStop(0, '#24185a'); fill.addColorStop(1, '#130c34');
    rrect(g, tx, ty, tw, tw, 26); g.fillStyle = fill; g.fill();
    var rim = g.createLinearGradient(0, ty, 0, ty + tw);
    rim.addColorStop(0, '#ffe7a0'); rim.addColorStop(0.5, '#c98a1e'); rim.addColorStop(1, '#ffd36b');
    g.lineWidth = 3; g.strokeStyle = rim; rrect(g, tx, ty, tw, tw, 26); g.stroke();
    g.lineWidth = 1; g.strokeStyle = 'rgba(255,220,140,0.25)'; rrect(g, tx + 6, ty + 6, tw - 12, tw - 12, 21); g.stroke();
    // corner studs
    var studs = [[tx, ty], [tx + tw, ty], [tx, ty + tw], [tx + tw, ty + tw]];
    for (i = 0; i < 4; i++) {
      var sg = g.createRadialGradient(studs[i][0] - 2, studs[i][1] - 2, 0, studs[i][0], studs[i][1], 7);
      sg.addColorStop(0, '#fff6d0'); sg.addColorStop(0.5, '#e6a530'); sg.addColorStop(1, '#7a4500');
      g.beginPath(); g.arc(studs[i][0] + (i % 2 ? -10 : 10), studs[i][1] + (i < 2 ? 10 : -10), 4.5, 0, Math.PI * 2); g.fillStyle = sg; g.fill();
    }
    // sockets
    for (i = 0; i < N; i++) for (j = 0; j < N; j++) {
      var sx = GX + i * CELL + CELL / 2, sy = GY + j * CELL + CELL / 2;
      var so = g.createRadialGradient(sx, sy - 4, PR * 0.3, sx, sy, PR + 4);
      so.addColorStop(0, 'rgba(0,0,0,0.45)'); so.addColorStop(0.8, 'rgba(0,0,0,0.25)'); so.addColorStop(1, 'rgba(255,255,255,0.06)');
      g.beginPath(); g.arc(sx, sy, PR + 4, 0, Math.PI * 2); g.fillStyle = so; g.fill();
    }
    return c;
  }
  function buildVignette(rgb) {
    var c = mk(canvas.width / 2, canvas.height / 2), g = c.getContext('2d');
    var gr = g.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.35, c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.75);
    gr.addColorStop(0, 'rgba(' + rgb + ',0)'); gr.addColorStop(1, 'rgba(' + rgb + ',0.75)');
    g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
    return c;
  }
  function resize() {
    var w = document.documentElement.clientWidth || 1, h = document.documentElement.clientHeight || 1;
    var d = Math.min(2.5, window.devicePixelRatio || 1);
    if (w === cw && h === ch && d === dpr) return;
    cw = w; ch = h; dpr = d;
    canvas.width = topCv.width = Math.round(cw * dpr); canvas.height = topCv.height = Math.round(ch * dpr);
    sc = Math.min(cw / W, ch / H); ox = (cw - W * sc) / 2; oy = (ch - H * sc) / 2;
    SPR.pearl = []; SPR.glow = []; SPR.tray = [];
    for (var k = 0; k < KINDS; k++) { SPR.pearl.push(buildPearl(k)); SPR.glow.push(buildGlow(k, PR * 2.2)); SPR.tray.push(buildTrayGlow(k)); }
    SPR.shadow = buildShadow(); SPR.star = buildStar(); SPR.bg = buildBg(); SPR.vigRed = buildVignette('255,30,70');
  }
  window.addEventListener('resize', resize);
  setInterval(resize, 500);
  resize();

  // ── state ──────────────────────────────────────────────────────────────────
  // state: menu | ready | play | timeup | over. `sim` is the rules' world;
  // `board[c][r]` holds only how each pearl is DRAWN (fall, squash, lift).
  var sim = initSim(null, RULES_VERSION), board = [], state = 'menu', shownTarget = 0, shown = 0, best = 0;
  var chain = [], loop = false, dragging = false, downStep = 0;
  var stats = { pearls: 0, chain: 0, loops: 0, move: 0 };
  var fx = { parts: [], ghosts: [], orbs: [], texts: [], rings: [], confetti: [], bokeh: [],
    shake: 0, flash: 0, flashRGB: '255,255,255', banner: null, scoreBump: 0, readyT: 0, timeupT: 0, loopT: 0, idle: 0, hint: null };
  var finger = null, clock = 0, lastSec = -1, lastInput = 0;
  try { best = Number(localStorage.getItem('pearlsConnectBest')) || 0; } catch (_e) {}

  function cellCX(c) { return GX + c * CELL + CELL / 2; }
  function cellCY(r) { return GY + r * CELL + CELL / 2; }
  function kindAt(c, r) { return sim.grid[r * N + c]; }
  function pearlY(c, r) { return cellCY(r) + board[c][r].dy; }
  function mkPearl(dy) { return { dy: dy, v: 0, sq: 0, sqv: 0, s: 0, sv: 0, flip: 0, landed: dy === 0 }; }

  function newBoard(drop) {
    board = [];
    for (var c = 0; c < N; c++) {
      var col = [];
      for (var r = 0; r < N; r++) {
        var p = mkPearl(drop ? -(N + 1) * CELL - (N - r) * 18 - c * 26 : 0);
        p.v = drop ? 200 : 0; col.push(p);
      }
      board.push(col);
    }
  }
  function findPair() {
    for (var c = 0; c < N; c++) for (var r = 0; r < N; r++) {
      var k = kindAt(c, r);
      if (c + 1 < N && kindAt(c + 1, r) === k) return [{ c: c, r: r }, { c: c + 1, r: r }];
      if (r + 1 < N && kindAt(c, r + 1) === k) return [{ c: c, r: r }, { c: c, r: r + 1 }];
    }
    return null;
  }
  function showShuffle() {
    for (var c = 0; c < N; c++) for (var r = 0; r < N; r++) board[c][r].flip = 0.5 + (c + r) * 0.03;
    fx.banner = { text: 'NO MOVES! SHUFFLE', t: 0 };
    audio.shuffle();
  }

  // ── the chain ──────────────────────────────────────────────────────────────
  function at(x, y) {
    var c = Math.floor((x - GX) / CELL), r = Math.floor((y - GY) / CELL);
    if (c < 0 || r < 0 || c >= N || r >= N) return null;
    var dx = x - cellCX(c), dy = y - cellCY(r);
    if (dx * dx + dy * dy > HIT_R * HIT_R) return null;
    return { c: c, r: r };
  }
  function same(a, b) { return a.c === b.c && a.r === b.r; }
  function adj(a, b) { return Math.abs(a.c - b.c) + Math.abs(a.r - b.r) === 1; }
  function inChain(c, r) { for (var i = 0; i < chain.length; i++) if (chain[i].c === c && chain[i].r === r) return true; return false; }
  function chainKind() { return chain.length ? kindAt(chain[0].c, chain[0].r) : -1; }
  function countKind(k) { var n = 0; for (var i = 0; i < CELLS; i++) if (sim.grid[i] === k) n++; return n; }
  function preview() {
    if (chain.length < 2) return null;
    var n = loop ? countKind(chainKind()) : chain.length;
    return { n: n, pts: chainPoints(n, loop) };
  }

  function begin(p) {
    if (!p) return;
    chain = [p]; loop = false; dragging = true; fx.hint = null; downStep = sim.step;
    audio.note(0);
    buzz(6);
  }
  function extend(p) {
    if (!dragging || !p || !chain.length) return;
    var last = chain[chain.length - 1];
    if (same(p, last)) return;
    if (chain.length >= 2 && same(p, chain[chain.length - 2])) {
      var wasLoop = loop;
      chain.pop(); loop = false;
      audio.note(chain.length - 1, true);
      if (wasLoop) fx.loopT = 0;
      return;
    }
    if (loop || !adj(p, last) || kindAt(p.c, p.r) !== chainKind()) return;
    if (inChain(p.c, p.r)) {
      if (chain.length >= 4) {
        chain.push(p); loop = true; fx.loopT = 0.0001;
        audio.loop(); buzz(25);
        fx.flash = 0.3; fx.flashRGB = GEMS[chainKind()].glow;
        fx.rings.push({ x: cellCX(p.c), y: cellCY(p.r), rgb: GEMS[chainKind()].glow, t: 0, dur: 0.6, r0: PR, r1: 200, w: 8 });
      }
      return;
    }
    chain.push(p);
    audio.note(chain.length - 1);
    buzz(4);
  }
  function release() {
    if (!dragging) return;
    dragging = false;
    var cells = [], len = chain.length;
    for (var i = 0; i < len; i++) cells.push(chain[i].r * N + chain[i].c);
    chain = []; loop = false; fx.loopT = 0;
    if (state !== 'play' || len < 2) { if (len === 1) audio.cancel(); return; }
    applyChain(cells, downStep, true);
  }
  // One path for a live chain and a replayed one. The rules decide; only a
  // chain they accepted is recorded, and the record is the ACTION (the cells
  // in drag order, the step it lifted, the step it began), never its result.
  function applyChain(cells, down, live) {
    var n = sim.chains, step = sim.step;
    if (!chainSim(sim, cells)) { audio.cancel(); return false; }
    if (live) { try { if (typeof window.__kjChain === 'function') window.__kjChain(performance.now(), n, step, down, cells); } catch (_e) {} }
    clearFx(sim.events[0]);
    return true;
  }

  // Effects for a clear, then the drawing state follows the rules' gravity:
  // `from[i]` is the cell each pearl came from, -1 for a new one.
  function clearFx(ev) {
    var k = ev.kind, wasLoop = ev.loop, n = ev.cells.length, pts = ev.pts, c, r, i, sx = 0, sy = 0;
    stats.pearls += n; stats.move = Math.max(stats.move, pts); if (wasLoop) stats.loops++; else stats.chain = Math.max(stats.chain, n);
    var step0 = Math.min(0.045, 0.5 / n);
    var nOrbs = Math.min(n, 14), per = Math.floor(pts / nOrbs), rem = pts - per * nOrbs;
    for (i = 0; i < n; i++) {
      c = ev.cells[i] % N; r = Math.floor(ev.cells[i] / N);
      var x = cellCX(c), y = pearlY(c, r);
      sx += x; sy += y;
      var delay = i * step0;
      fx.ghosts.push({ x: x, y: y, k: k, t: -delay, i: i, n: n, big: wasLoop || n >= 6 });
      if (i < nOrbs) fx.orbs.push({ x0: x, y0: y, k: k, t: -delay - 0.12, dur: 0.55 + Math.random() * 0.15, val: per + (i === nOrbs - 1 ? rem : 0),
        cx: x + (Math.random() - 0.5) * 160, cy: Math.min(y, SCORE_Y) - 60 - Math.random() * 80, trail: [] });
    }
    var mx = sx / n, my = sy / n, word = '';
    if (wasLoop) word = 'LOOP!';
    else for (i = 0; i < PRAISE.length; i++) if (n >= PRAISE[i][0]) { word = PRAISE[i][1]; break; }
    fx.texts.push({ text: '+' + pts, x: mx, y: my, t: -0.05, size: pts >= 100 ? 54 : pts >= 21 ? 46 : 36, col: '#ffffff', edge: GEMS[k].dark });
    if (word) fx.texts.push({ text: word, x: W / 2, y: GY + BOARD / 2 - 30, t: -0.12, size: wasLoop ? 64 : 52, col: GEMS[k].base, edge: '#1a0b2e', praise: true });
    fx.shake = Math.min(1.2, 0.2 + n * 0.06 + (wasLoop ? 0.4 : 0));
    if (wasLoop || n >= 6) { fx.flash = Math.max(fx.flash, wasLoop ? 0.35 : 0.18); fx.flashRGB = GEMS[k].glow; }
    audio.clearSeq(n, step0, wasLoop);
    if (word) audio.praise(wasLoop);
    buzz(wasLoop ? [30, 40, 30] : n >= 6 ? 30 : 15);
    var old = board, nb = [];
    for (c = 0; c < N; c++) {
      var col = [], fresh = 0;
      for (r = 0; r < N; r++) if (ev.from[r * N + c] < 0) fresh++;
      for (r = 0; r < N; r++) {
        var f = ev.from[r * N + c];
        if (f >= 0) {
          var q = old[f % N][Math.floor(f / N)], fall = (Math.floor(f / N) - r) * CELL;
          if (fall < 0) { q.dy += fall; q.landed = false; q.v = Math.min(q.v, 0); }
          col.push(q);
        } else { var np = mkPearl(-fresh * CELL - 30 - (fresh - r) * 8); np.landed = false; col.push(np); }
      }
      nb.push(col);
    }
    board = nb;
    if (ev.shuffled) showShuffle();
  }

  // ── input ──────────────────────────────────────────────────────────────────
  function toDesign(e) {
    var rc = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: ((e.clientX - rc.left) - ox) / sc, y: ((e.clientY - rc.top) - oy) / sc };
  }
  var activeId = null;
  canvas.addEventListener('pointerdown', function (e) {
    audio.unlock();
    if (RP || state !== 'play' || activeId !== null) return;
    activeId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_e) {}
    finger = toDesign(e); lastInput = clock;
    begin(at(finger.x, finger.y));
  });
  canvas.addEventListener('pointermove', function (e) {
    if (e.pointerId !== activeId) return;
    finger = toDesign(e);
    if (!dragging) { begin(at(finger.x, finger.y)); return; }
    var list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (!list.length) list = [e];
    for (var i = 0; i < list.length; i++) { var d = toDesign(list[i]); extend(at(d.x, d.y)); }
  });
  function up(e) {
    if (e.pointerId !== activeId) return;
    activeId = null; finger = null; lastInput = clock;
    release();
  }
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  ['touchstart', 'touchmove'].forEach(function (n) { canvas.addEventListener(n, function (e) { e.preventDefault(); }, { passive: false }); });
  // No keyboard controls: a key must never press a focused button by accident.
  window.addEventListener('keydown', function (e) { if (!e.target || e.target.tagName !== 'BUTTON') { if (e.preventDefault) e.preventDefault(); } });

  function buzz(p) { try { if (!muted && navigator.vibrate) navigator.vibrate(p); } catch (_e) {} }

  // ── screens ────────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  function show(id, on) { $(id).classList[on ? 'remove' : 'add']('is-hidden'); }
  function refreshMenuBest() {
    $('menuBest').hidden = !best;
    $('menuBestVal').textContent = 'BEST ' + best;
  }
  refreshMenuBest();

  // ── platform ───────────────────────────────────────────────────────────────
  var Q = /[?&]/.test(location.search) ? location.search : '';
  var EMBED = !!window.__kjEmbed;
  // QA switches (?seed=): read only by localSeed, which only a standalone page
  // reaches; inside the platform start() never borrows a seed.
  function qp(name) { var m = new RegExp('[?&]' + name + '=([^&]*)').exec(Q); return m ? decodeURIComponent(m[1]) : null; }
  var RP = (window.KJReplay && window.KJReplay.active()) ? window.KJReplay : null;
  var replayChains = null, traceVersion = 0, submitted = false, sessionReady = false;
  if (RP) RP.ready('pearls-connect');
  function onSessionReady() {
    sessionReady = true;
    var b = $('playBtn');
    b.disabled = false; b.textContent = 'PLAY';
    if (RP) start();
  }
  function localSeed() {
    var s = qp('seed');
    if (s && /^[0-9a-f]{16}/i.test(s)) return s;
    var h = '';
    for (var i = 0; i < 16; i++) h += Math.floor(Math.random() * 16).toString(16);
    return h;
  }
  function shouldTutorial() { return !RP && !!window.KJTut && window.KJTut.shouldShow(); }

  // The world is built once, from the session's seed, when the run starts.
  function start() {
    if (!sessionReady || state === 'ready' || state === 'play' || state === 'timeup') return;
    if (EMBED && submitted) return;   // one run per session: the Result screen owns "play again"
    show('menu', false); show('how', false); show('over', false);
    traceVersion = (typeof window.__kjGameStart === 'function')
      ? (Number(window.__kjGameStart(performance.now(), RULES_VERSION)) || 0) : RULES_VERSION;
    if (RP) {
      traceVersion = RP.capVersion(traceVersion);
      replayChains = RP.cursor('chain', function (e) { return Number(e.step); });
      RP.started(traceVersion);
    }
    sim = initSim(window.__kjSeed || (EMBED ? null : localSeed()), RULES_VERSION);
    newBoard(true);
    state = RP ? 'play' : 'ready'; shown = 0; shownTarget = 0; chain = []; loop = false; dragging = false; activeId = null;
    submitted = false; acc = 0;
    stats = { pearls: 0, chain: 0, loops: 0, move: 0 };
    fx.parts = []; fx.ghosts = []; fx.orbs = []; fx.texts = []; fx.rings = []; fx.confetti = []; fx.banner = null; fx.hint = null;
    fx.readyT = RP ? 2 : 0; fx.timeupT = 0; fx.loopT = 0; lastSec = -1; lastInput = clock;
    if (!RP) audio.ready();
  }
  function timeUp() {
    state = 'timeup'; fx.timeupT = 0;
    if (dragging) { dragging = false; chain = []; loop = false; }
    activeId = null;
    audio.timeUp(); buzz([40, 60, 80]);
    // the board spills away
    for (var c = 0; c < N; c++) for (var r = 0; r < N; r++) {
      var p = board[c][r];
      p.spill = { vx: (Math.random() - 0.5) * 260 + (c - 2.5) * 30, vy: -120 - Math.random() * 260, rot: 0, vr: (Math.random() - 0.5) * 8, x: 0, y: 0, delay: 0.55 + (N - 1 - r) * 0.06 + Math.random() * 0.1 };
    }
    // The score goes once TIME'S UP has played; a hidden tab draws no frames,
    // so a timer backs the frame clock up.
    setTimeout(finishRun, 3000);
  }
  function finishRun() {
    if (state !== 'timeup') return;
    state = 'over'; submitted = true;
    if (RP) RP.setStep(sim.step);
    try { if (typeof window.__kjSubmit === 'function') window.__kjSubmit(sim.score); } catch (_e) {}
    if (!EMBED) showOver();
  }
  function showOver() {
    state = 'over';
    var score = sim.score, isBest = score > best;
    if (isBest) { best = score; try { localStorage.setItem('pearlsConnectBest', String(best)); } catch (_e) {} }
    $('overNew').hidden = !isBest;
    $('overBest').textContent = isBest ? '' : 'BEST ' + best;
    $('stPearls').textContent = stats.pearls;
    $('stChain').textContent = stats.chain;
    $('stLoops').textContent = stats.loops;
    $('stMove').textContent = '+' + stats.move;
    refreshMenuBest();
    show('over', true);
    countUp($('overScore'), score, isBest);
  }
  function countUp(el, to, isBest) {
    var t0 = performance.now(), dur = Math.min(1400, 400 + to * 2), lastTick = 0;
    el.textContent = '0';
    function tick(now) {
      var k = Math.min(1, (now - t0 - 150) / dur);
      if (k < 0) { requestAnimationFrame(tick); return; }
      var e = 1 - (1 - k) * (1 - k) * (1 - k), v = Math.round(to * e);
      el.textContent = String(v);
      if (now - lastTick > 55 && k < 1) { lastTick = now; audio.count(k); }
      if (k < 1) requestAnimationFrame(tick);
      else { audio.final(isBest); if (isBest) confettiBurst(); }
    }
    requestAnimationFrame(tick);
  }
  function confettiBurst() {
    var cols = ['#ff3d6e', '#22d58a', '#3f8cff', '#ffbe2e', '#b265ff', '#ffffff'];
    for (var i = 0; i < 120; i++) {
      fx.confetti.push({ x: W / 2 + (Math.random() - 0.5) * 60, y: 230, vx: (Math.random() - 0.5) * 620, vy: -300 - Math.random() * 520,
        w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 14, col: cols[i % cols.length], t: 0 });
    }
  }
  function click() { audio.unlock(); audio.ui(); }
  // HOW TO PLAY is a static panel: it opens before the run, never inside it.
  $('playBtn').onclick = function () {
    click();
    if (shouldTutorial()) { window.KJTut.markSeen(); show('how', true); return; }
    start();
  };
  $('howBtn').onclick = function () { click(); show('how', true); };
  $('howPlayBtn').onclick = function () { click(); show('how', false); if (state === 'menu') start(); };   // start() waits for the session
  $('againBtn').onclick = function () { click(); start(); };
  $('homeBtn').onclick = function () { click(); state = 'menu'; fx.confetti = []; show('over', false); show('menu', true); };

  var muted = false;
  try { muted = localStorage.getItem('pearlsConnectMute') === '1'; } catch (_e) {}
  function applyMute() { $('mute').classList[muted ? 'add' : 'remove']('is-muted'); audio.setMuted(muted); }
  $('mute').onclick = function () {
    muted = !muted; try { localStorage.setItem('pearlsConnectMute', muted ? '1' : '0'); } catch (_e) {}
    audio.unlock(); applyMute(); if (!muted) audio.ui();
  };

  // ── audio: Web Audio only ──────────────────────────────────────────────────
  // Marimba-like notes climb a pentatonic scale as the chain grows, glassy
  // pops cascade when it clears, a shimmer marks a loop, a woodblock counts
  // down the last ten seconds and a gong ends the run. A short generated room
  // reverb gives everything space.
  var audio = (function () {
    var AC = null, master = null, dry = null, wet = null, noise = null;
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      master = AC.createGain(); master.gain.value = 0.85;
      var comp = AC.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 4;
      master.connect(comp); comp.connect(AC.destination);
      dry = AC.createGain(); dry.connect(master);
      var len = Math.floor(AC.sampleRate * 1.1), ir = AC.createBuffer(2, len, AC.sampleRate);
      for (var c = 0; c < 2; c++) { var d = ir.getChannelData(c); for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
      var conv = AC.createConvolver(); conv.buffer = ir;
      wet = AC.createGain(); wet.gain.value = 0.28; wet.connect(conv); conv.connect(master);
      noise = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
      var nd = noise.getChannelData(0); for (i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    } catch (_e) { AC = null; }
    var isMuted = false;
    function ok() { return !!AC && AC.state === 'running' && !isMuted; }
    function unlock() { if (AC && AC.state !== 'running') { try { AC.resume(); } catch (_e) {} } }
    ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (ev) { window.addEventListener(ev, unlock, true); });
    function osc(type, f, t, dur, peak, opts) {
      opts = opts || {};
      var o = AC.createOscillator(), g = AC.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + (opts.glide || dur));
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + (opts.attack || 0.004));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dry); if (opts.wet) g.connect(wet);
      o.start(t); o.stop(t + dur + 0.05);
    }
    function nz(t, dur, peak, type, freq, q, to, w) {
      var s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
      s.buffer = noise; f.type = type; f.frequency.setValueAtTime(freq, t); if (q) f.Q.value = q;
      if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(dry); if (w) g.connect(wet);
      s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
    }
    var SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36, 38, 40, 43];
    function hz(semi) { return 392 * Math.pow(2, semi / 12); }   // from G4
    function marimba(f, t, peak) {
      osc('sine', f, t, 0.45, peak, { wet: true });
      osc('sine', f * 4, t, 0.06, peak * 0.35);
      osc('triangle', f * 2, t, 0.12, peak * 0.15);
      nz(t, 0.02, peak * 0.4, 'highpass', 3000);
    }
    var lastCoin = 0;
    return {
      unlock: unlock,
      setMuted: function (m) { isMuted = m; },
      ui: function () { if (!ok()) return; var t = AC.currentTime; osc('sine', 880, t, 0.08, 0.12, { to: 1320, glide: 0.05 }); },
      note: function (i, back) {
        if (!ok()) return;
        var t = AC.currentTime, f = hz(SCALE[Math.min(i, SCALE.length - 1)]);
        if (back) { osc('sine', f, t, 0.15, 0.08); return; }
        marimba(f, t, 0.22);
      },
      cancel: function () { if (ok()) osc('sine', 300, AC.currentTime, 0.12, 0.06, { to: 200 }); },
      loop: function () {
        if (!ok()) return;
        var t = AC.currentTime, ch = [0, 4, 7, 12, 16, 19, 24];
        for (var i = 0; i < ch.length; i++) osc('triangle', hz(ch[i]) * 1.5, t + i * 0.035, 0.6, 0.09, { wet: true });
        nz(t, 0.5, 0.25, 'bandpass', 600, 2, 6000, true);
        osc('sine', 98, t, 0.5, 0.25);
      },
      // a pop per pearl, in step with the ghosts bursting on screen
      clearSeq: function (n, gap, wasLoop) {
        if (!ok()) return;
        var t = AC.currentTime + 0.03;
        for (var i = 0; i < n; i++) {
          var tt = t + i * gap, f = 700 + Math.min(i, 16) * 70 + Math.random() * 40;
          osc('sine', f * 1.8, tt, 0.09, 0.13, { to: f, glide: 0.06, wet: i % 3 === 0 });
          nz(tt, 0.05, 0.12, 'bandpass', 4000 + i * 150, 3);
        }
        if (n >= 6 || wasLoop) { osc('sine', 70, t, 0.45, 0.35, { to: 40 }); nz(t, 0.25, 0.2, 'lowpass', 900, 0, 200); }
      },
      praise: function (big) {
        if (!ok()) return;
        var t = AC.currentTime + 0.12, notes = big ? [12, 16, 19, 24] : [12, 19];
        for (var i = 0; i < notes.length; i++) osc('triangle', hz(notes[i]), t + i * 0.07, 0.4, 0.08, { wet: true });
      },
      coin: function () {
        if (!ok()) return;
        var t = AC.currentTime; if (t - lastCoin < 0.04) return; lastCoin = t;
        osc('sine', 1760 + Math.random() * 300, t, 0.05, 0.035);
      },
      shuffle: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        nz(t, 0.5, 0.2, 'bandpass', 300, 1.5, 3000, true);
        for (var i = 0; i < 6; i++) osc('sine', hz(SCALE[10 - i]), t + i * 0.05, 0.12, 0.06);
      },
      tick: function (last) {
        if (!ok()) return;
        var t = AC.currentTime;
        osc('sine', last ? 660 : 1050, t, last ? 0.15 : 0.06, last ? 0.2 : 0.11);
        nz(t, 0.03, last ? 0.25 : 0.15, 'bandpass', last ? 1500 : 2500, 4);
      },
      ready: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        nz(t, 0.9, 0.12, 'bandpass', 200, 1, 2500, true);
      },
      go: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        [0, 7, 12, 16].forEach(function (s, i) { osc('triangle', hz(s), t + i * 0.03, 0.5, 0.1, { wet: true }); });
        osc('sine', 98, t, 0.3, 0.2);
      },
      timeUp: function () {
        if (!ok()) return;
        var t = AC.currentTime, f = 110;
        [1, 2.41, 3.93, 5.4].forEach(function (m, i) { osc('sine', f * m, t, 2.2 - i * 0.4, 0.22 / (i + 1), { wet: true }); });
        nz(t, 0.4, 0.2, 'lowpass', 2000, 0, 300, true);
      },
      count: function (k) { if (ok()) osc('sine', 600 + k * 900, AC.currentTime, 0.04, 0.05); },
      final: function (isBest) {
        if (!ok()) return;
        var t = AC.currentTime, n = isBest ? [0, 4, 7, 12, 16, 19, 24] : [0, 7, 12];
        for (var i = 0; i < n.length; i++) osc('triangle', hz(n[i]), t + i * 0.08, 0.6, 0.1, { wet: true });
        if (isBest) nz(t + 0.3, 0.8, 0.12, 'highpass', 6000, 0, 0, true);
      },
    };
  })();
  applyMute();

  // ── effects ────────────────────────────────────────────────────────────────
  function burst(x, y, k, big) {
    var gm = GEMS[k], i, n = big ? 12 : 8;
    for (i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = 90 + Math.random() * (big ? 280 : 200);
      fx.parts.push({ type: 'shard', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, r: 2.5 + Math.random() * 3.5,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 18, col: i % 3 ? gm.base : gm.light, t: 0, dur: 0.55 + Math.random() * 0.35 });
    }
    for (i = 0; i < (big ? 3 : 2); i++) {
      var a2 = Math.random() * Math.PI * 2, s2 = 40 + Math.random() * 90;
      fx.parts.push({ type: 'star', x: x, y: y, vx: Math.cos(a2) * s2, vy: Math.sin(a2) * s2 - 40, r: 0.5 + Math.random() * 0.6,
        rot: Math.random(), vr: (Math.random() - 0.5) * 4, t: 0, dur: 0.5 + Math.random() * 0.3 });
    }
    fx.rings.push({ x: x, y: y, rgb: gm.glow, t: 0, dur: 0.38, r0: PR * 0.8, r1: PR * 2, w: 5 });
  }
  function spring(x, v, target, k, d, dt) {
    var a = -k * (x - target) - d * v;
    v += a * dt; x += v * dt;
    return [x, v];
  }
  function animate(dt) {
    var i, c, r, p;
    // pearls: fall, land with a squash, pop up when chained, flip on shuffle
    var k0 = chainKind();
    for (c = 0; c < board.length; c++) for (r = 0; r < N; r++) {
      p = board[c][r];
      if (!p.landed) {
        p.v += 3600 * dt; p.dy += p.v * dt;
        if (p.dy >= 0) { p.dy = 0; p.landed = true; p.sqv = Math.min(5, p.v / 260); p.v = 0; }
      }
      var sq = spring(p.sq, p.sqv, 0, 520, 16, dt); p.sq = sq[0]; p.sqv = sq[1];
      var want = inChain(c, r) || (loop && kindAt(c, r) === k0) ? 1 : 0;
      var ss = spring(p.s, p.sv, want, 700, 22, dt); p.s = ss[0]; p.sv = ss[1];
      if (p.flip > 0) p.flip = Math.max(0, p.flip - dt);
      if (p.spill && state === 'timeup') {
        var sp = p.spill;
        if (sp.delay > 0) sp.delay -= dt;
        else { sp.vy += 1400 * dt; sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.rot += sp.vr * dt; }
      }
    }
    for (i = fx.ghosts.length - 1; i >= 0; i--) {
      var g = fx.ghosts[i], was = g.t; g.t += dt;
      if (was < 0.12 && g.t >= 0.12) burst(g.x, g.y, g.k, g.big);
      if (g.t > 0.3) fx.ghosts.splice(i, 1);
    }
    for (i = fx.orbs.length - 1; i >= 0; i--) {
      var o = fx.orbs[i]; o.t += dt;
      if (o.t > 0) {
        var pos = orbPos(o);
        o.trail.unshift(pos); if (o.trail.length > 6) o.trail.pop();
      }
      if (o.t >= o.dur) { shownTarget += o.val; fx.scoreBump = 1; audio.coin(); fx.orbs.splice(i, 1); }
    }
    if (!fx.orbs.length) shownTarget = sim.score;
    for (i = fx.parts.length - 1; i >= 0; i--) {
      var q = fx.parts[i]; q.t += dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 620 * dt; q.vx *= 0.985; q.rot += q.vr * dt;
      if (q.t > q.dur) fx.parts.splice(i, 1);
    }
    for (i = fx.rings.length - 1; i >= 0; i--) { fx.rings[i].t += dt; if (fx.rings[i].t > fx.rings[i].dur) fx.rings.splice(i, 1); }
    for (i = fx.texts.length - 1; i >= 0; i--) { fx.texts[i].t += dt; if (fx.texts[i].t > (fx.texts[i].praise ? 1.0 : 0.95)) fx.texts.splice(i, 1); }
    for (i = fx.confetti.length - 1; i >= 0; i--) {
      var f = fx.confetti[i]; f.t += dt; f.vy += 700 * dt; f.vx *= 0.99; f.vy = Math.min(f.vy, 260); f.x += f.vx * dt; f.y += f.vy * dt; f.r += f.vr * dt;
      if (f.y > H + 200) fx.confetti.splice(i, 1);
    }
    if (fx.banner) { fx.banner.t += dt; if (fx.banner.t > 1.4) fx.banner = null; }
    if (fx.loopT > 0) fx.loopT += dt;
    fx.shake = Math.max(0, fx.shake - dt * 3.2);
    fx.flash = Math.max(0, fx.flash - dt * 1.6);
    fx.scoreBump = Math.max(0, fx.scoreBump - dt * 5);
    shown += (shownTarget - shown) * Math.min(1, dt * 16);
    if (Math.abs(shownTarget - shown) < 0.5) shown = shownTarget;
    // bokeh drifting up the sky
    while (fx.bokeh.length < 16) fx.bokeh.push({ x: Math.random() * W, y: H + Math.random() * H, s: 0.3 + Math.random() * 0.7, v: 6 + Math.random() * 16, k: Math.floor(Math.random() * KINDS), a: 0.05 + Math.random() * 0.12, ph: Math.random() * 6 });
    for (i = 0; i < fx.bokeh.length; i++) {
      var b = fx.bokeh[i]; b.y -= b.v * dt; b.x += Math.sin(clock * 0.4 + b.ph) * 4 * dt;
      if (b.y < -80) { b.y = H + 60; b.x = Math.random() * W; }
    }
    // a hint after a few quiet seconds
    if (state === 'play' && !dragging && clock - lastInput > 5 && !fx.hint && allLanded()) {
      var pr = findPair(); if (pr) fx.hint = { cells: pr, t: 0 };
    }
    if (fx.hint) fx.hint.t += dt;
  }
  function allLanded() { for (var c = 0; c < N; c++) for (var r = 0; r < N; r++) if (!board[c][r].landed) return false; return true; }
  function orbPos(o) {
    var k = Math.min(1, Math.max(0, o.t / o.dur)), e = k * k * (3 - 2 * k), u = 1 - e;
    return { x: u * u * o.x0 + 2 * u * e * o.cx + e * e * W / 2, y: u * u * o.y0 + 2 * u * e * o.cy + e * e * SCORE_Y };
  }

  // ── draw ───────────────────────────────────────────────────────────────────
  function text(t, x, y, size, col, alpha, edge, g2) {
    var g = g2 || ctx;
    g.globalAlpha = alpha == null ? 1 : alpha;
    g.font = size + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    if (edge) { g.lineWidth = size * 0.2; g.strokeStyle = edge; g.strokeText(t, x, y + size * 0.06); g.strokeText(t, x, y); }
    g.fillStyle = col; g.fillText(t, x, y);
    g.globalAlpha = 1;
  }
  function blit(img, x, y, s, sx, sy) {
    var w = img.width / (sc * dpr) * s * (sx || 1), h = img.height / (sc * dpr) * s * (sy || 1);
    ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
  }
  function popScale(t) {
    if (t < 0) return 0;
    if (t < 0.12) return 0.3 + (t / 0.12) * 1.0;
    if (t < 0.24) return 1.3 - ((t - 0.12) / 0.12) * 0.3;
    return 1;
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(SPR.bg, 0, 0);
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
    var i, c, r, p, k = chainKind();

    // bokeh (behind everything)
    for (i = 0; i < fx.bokeh.length; i++) {
      var b = fx.bokeh[i]; ctx.globalAlpha = b.a; blit(SPR.glow[b.k], b.x, b.y, b.s * 1.4);
    }
    ctx.globalAlpha = 1;

    if (state === 'menu') { drawNecklace(); return; }

    var shx = 0, shy = 0;
    if (fx.shake > 0) { shx = (Math.random() - 0.5) * fx.shake * 9; shy = (Math.random() - 0.5) * fx.shake * 9; }
    ctx.save(); ctx.translate(shx, shy);

    drawHud();

    // loop: the tray frame lights up in the colour
    if (loop && k >= 0) {
      var la = 0.55 + 0.35 * Math.sin(clock * 9);
      ctx.globalAlpha = la; var tg = SPR.tray[k], tw = tg.width / (sc * dpr);
      ctx.drawImage(tg, W / 2 - tw / 2, GY + BOARD / 2 - tw / 2, tw, tw); ctx.globalAlpha = 1;
    }
    drawChainLine(k);
    drawPearls(k);
    drawFx();
    ctx.restore();

    // chain preview chip under the board
    var pv = preview();
    if (pv && state === 'play') drawChip(pv, k);
    else if (fx.banner) {
      var bt = fx.banner.t, bs = popScale(bt), ba = Math.min(1, (1.4 - bt) * 4);
      ctx.save(); ctx.translate(W / 2, GY + BOARD + 54); ctx.scale(bs, bs); text(fx.banner.text, 0, 0, 24, '#ffd257', ba, '#2a1405'); ctx.restore();
    }

    // last seconds: red vignette pulse and a big count
    var left = RUN_STEPS - sim.step;
    if (state === 'play' && left <= WARN_STEPS) {
      var ph = (sim.step % 60) / 60, pulse = Math.max(0, 1 - ph * 2.5);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.25 + 0.45 * pulse * (1 - left / WARN_STEPS * 0.5);
      ctx.drawImage(SPR.vigRed, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
      if (left <= 180) {
        var sec = Math.ceil(left / 60), ss = 1.6 - ph * 0.6;
        ctx.save(); ctx.translate(W / 2, GY + BOARD / 2); ctx.scale(ss, ss);
        text(String(sec), 0, 0, 120, '#ffffff', 0.22 * (1 - ph * 0.7)); ctx.restore();
      }
    }
    if (state === 'ready') drawReady();
    if (state === 'timeup') drawTimeUp();

    if (fx.flash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = fx.flash * 0.45; ctx.fillStyle = 'rgb(' + fx.flashRGB + ')'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
    }
  }

  function drawHud() {
    // score
    var bump = 1 + fx.scoreBump * 0.14;
    text('SCORE', W / 2, SCORE_Y - 44, 13, 'rgba(255,240,215,0.6)');
    ctx.save(); ctx.translate(W / 2, SCORE_Y); ctx.scale(bump, bump);
    text(String(Math.round(shown)), 0, 0, 54, '#fff3c4', 1, '#3a1a00');
    ctx.restore();
    if (best > 0) {
      text('BEST', W - GX - 26, SCORE_Y - 20, 11, 'rgba(255,240,215,0.5)');
      text(String(Math.max(best, sim.score)), W - GX - 26, SCORE_Y + 2, 20, sim.score > best ? '#ffd257' : 'rgba(255,240,215,0.85)');
    }
    // timer bar
    var left = Math.max(0, RUN_STEPS - sim.step), frac = left / RUN_STEPS, warn = left <= WARN_STEPS && state === 'play';
    var bx = GX + 4, bw = BOARD - 100, bh = 16, by = BAR_Y;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; rrect(ctx, bx, by, bw, bh, 8); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,220,140,0.25)'; ctx.stroke();
    if (frac > 0) {
      var fw = Math.max(bh, bw * frac);
      var beat = warn ? 0.5 + 0.5 * Math.max(0, 1 - ((sim.step % 60) / 60) * 3) : 0;
      ctx.fillStyle = warn ? (beat > 0.6 ? '#ff6a85' : '#ff2d55') : frac < 0.33 ? '#ff9a2e' : '#ffc93c';
      rrect(ctx, bx + 2, by + 2, fw - 4, bh - 4, 6); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; rrect(ctx, bx + 5, by + 3.5, Math.max(0, fw - 10), 3.5, 2); ctx.fill();
      ctx.globalAlpha = 0.8; blit(SPR.glow[warn ? 0 : 3], bx + fw - 6, by + bh / 2, 0.55); ctx.globalAlpha = 1;
    }
    // the clock, mm:ss in a pill
    var cx = GX + BOARD - 42, cy = by + bh / 2, sec = Math.ceil(left / 60);
    var clockTxt = pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
    var sb = warn ? 1 + 0.14 * Math.max(0, 1 - ((sim.step % 60) / 60) * 4) : 1;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(sb, sb);
    rrect(ctx, -42, -20, 84, 40, 20); ctx.fillStyle = warn ? '#5a0f24' : '#24185a'; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = warn ? '#ff2d55' : '#ffc93c'; ctx.stroke();
    ctx.font = '20px ' + FONT; ctx.textBaseline = 'middle'; ctx.fillStyle = warn ? '#ffd0da' : '#ffffff';
    ctx.textAlign = 'center';
    // fixed slots so the digits do not jiggle as they change
    for (var ci = 0; ci < clockTxt.length; ci++) ctx.fillText(clockTxt[ci], -26 + ci * 13, 1);
    ctx.restore();
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pearlPos(c, r) {
    var p = board[c][r], x = cellCX(c), y = cellCY(r) + p.dy;
    if (p.spill && state === 'timeup') { x += p.spill.x; y += p.spill.y; }
    return { x: x, y: y - p.s * 4 };
  }
  function drawChainLine(k) {
    if (!chain.length || k < 0) return;
    var gm = GEMS[k], pts = [], i;
    for (i = 0; i < chain.length; i++) pts.push(pearlPos(chain[i].c, chain[i].r));
    var tail = dragging && !loop && finger ? finger : null;
    function path() { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y); }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (pts.length > 1) {
      path(); ctx.strokeStyle = 'rgba(' + gm.glow + ',0.22)'; ctx.lineWidth = 26; ctx.stroke();
      path(); ctx.strokeStyle = gm.base; ctx.lineWidth = 12; ctx.stroke();
      path(); ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 3.5; ctx.stroke();
      // light flowing along the chain
      var total = 0, segs = [];
      for (i = 1; i < pts.length; i++) { var L = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y); segs.push(L); total += L; }
      var gap = 28, off = (clock * 90) % gap;
      ctx.fillStyle = '#ffffff';
      for (var d = off; d < total; d += gap) {
        var acc = 0;
        for (i = 0; i < segs.length; i++) {
          if (d <= acc + segs[i]) { var f = (d - acc) / segs[i]; var x = pts[i].x + (pts[i + 1].x - pts[i].x) * f, y = pts[i].y + (pts[i + 1].y - pts[i].y) * f;
            ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill(); break; }
          acc += segs[i];
        }
      }
      ctx.globalAlpha = 1;
    }
    if (tail) {
      var lp = pts[pts.length - 1];
      ctx.beginPath(); ctx.moveTo(lp.x, lp.y); ctx.lineTo(tail.x, tail.y);
      ctx.strokeStyle = 'rgba(' + gm.glow + ',0.5)'; ctx.lineWidth = 8; ctx.stroke();
      ctx.globalAlpha = 0.7; blit(SPR.glow[k], tail.x, tail.y, 0.5); ctx.globalAlpha = 1;
    }
  }
  function drawPearls(k) {
    var c, r, p, sw = SPR.pearl[0].width / (sc * dpr), shw = SPR.shadow.width / (sc * dpr), shh = SPR.shadow.height / (sc * dpr);
    ctx.save();
    if (state !== 'timeup') { ctx.beginPath(); ctx.rect(GX - 14, GY - 120 - H, BOARD + 28, H + BOARD + 134); ctx.clip(); }
    // pearls above the tray fade in as they enter
    for (c = 0; c < board.length; c++) for (r = 0; r < N; r++) {
      p = board[c][r];
      var pos = pearlPos(c, r), x = pos.x, y = pos.y;
      if (state !== 'timeup' && y < GY - 30) continue;
      var lift = p.s, sx = 1 + p.sq * 0.08 + lift * 0.16, sy = 1 - p.sq * 0.08 + lift * 0.16;
      var kk = kindAt(c, r);
      if (p.flip > 0) { var fl = Math.min(1, p.flip / 0.5); var e = Math.abs(Math.cos(fl * Math.PI)); sx *= e; sy *= e; }
      if (p.spill && state === 'timeup' && p.spill.delay <= 0) { ctx.save(); ctx.translate(x, y); ctx.rotate(p.spill.rot); ctx.translate(-x, -y); }
      ctx.globalAlpha = 0.6 - lift * 0.25;
      ctx.drawImage(SPR.shadow, x - shw / 2 * sx, cellCY(r) + p.dy + PR * 0.55 - shh / 2 + lift * 4, shw * sx, shh);
      ctx.globalAlpha = 1;
      if (lift > 0.02) { ctx.globalAlpha = Math.min(1, lift) * (0.55 + 0.25 * Math.sin(clock * 10 + c + r)); blit(SPR.glow[kk], x, y, 0.85 + lift * 0.2); ctx.globalAlpha = 1; }
      // bottom-anchored squash
      var dw = sw * sx, dh = sw * sy;
      var yc = y + PR - PR * sy;
      ctx.drawImage(SPR.pearl[kk], x - dw / 2, yc - dh / 2, dw, dh);
      if (p.spill && state === 'timeup' && p.spill.delay <= 0) ctx.restore();
    }
    ctx.restore();
    // twinkles on idle pearls
    if (state === 'play' || state === 'ready') {
      for (var i = 0; i < 2; i++) {
        var seedT = Math.floor(clock * 1.3 + i * 0.5), cc = (seedT * 7 + i * 3) % N, rr = (seedT * 11 + i * 5) % N, ph = (clock * 1.3 + i * 0.5) % 1;
        if (board[cc] && board[cc][rr] && board[cc][rr].landed) {
          var tp = pearlPos(cc, rr);
          ctx.globalAlpha = Math.sin(ph * Math.PI) * 0.9;
          ctx.save(); ctx.translate(tp.x - PR * 0.35, tp.y - PR * 0.45); ctx.rotate(ph * 1.5); blit(SPR.star, 0, 0, 0.55 + 0.25 * Math.sin(ph * Math.PI)); ctx.restore();
          ctx.globalAlpha = 1;
        }
      }
    }
    // hint
    if (fx.hint && state === 'play' && !dragging) {
      var hp = 0.5 + 0.5 * Math.sin(fx.hint.t * 6);
      for (var h = 0; h < fx.hint.cells.length; h++) {
        var hc = fx.hint.cells[h]; var q = pearlPos(hc.c, hc.r);
        ctx.globalAlpha = Math.min(1, fx.hint.t * 2) * (0.35 + 0.5 * hp);
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(q.x, q.y, PR + 5 + hp * 3, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
  function drawFx() {
    var i, sw = SPR.pearl[0].width / (sc * dpr);
    // pearls swelling and vanishing where a chain cleared
    for (i = 0; i < fx.ghosts.length; i++) {
      var g = fx.ghosts[i];
      if (g.t < 0) { ctx.globalAlpha = 1; blit(SPR.glow[g.k], g.x, g.y, 0.8); blit(SPR.pearl[g.k], g.x, g.y, 1.12); continue; }
      var e = Math.min(1, g.t / 0.12);
      if (g.t < 0.12) { blit(SPR.glow[g.k], g.x, g.y, 0.9 + e * 0.6); blit(SPR.pearl[g.k], g.x, g.y, 1.12 + e * 0.3); }
      else { ctx.globalAlpha = Math.max(0, 1 - (g.t - 0.12) / 0.18); ctx.globalCompositeOperation = 'lighter'; blit(SPR.glow[g.k], g.x, g.y, 1.6); ctx.globalCompositeOperation = 'source-over'; }
      ctx.globalAlpha = 1;
    }
    for (i = 0; i < fx.rings.length; i++) {
      var rg = fx.rings[i], rk = rg.t / rg.dur, ee = 1 - (1 - rk) * (1 - rk);
      ctx.globalAlpha = 1 - rk; ctx.strokeStyle = 'rgba(' + rg.rgb + ',1)'; ctx.lineWidth = rg.w * (1 - rk) + 1;
      ctx.beginPath(); ctx.arc(rg.x, rg.y, rg.r0 + (rg.r1 - rg.r0) * ee, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (i = 0; i < fx.parts.length; i++) {
      var q = fx.parts[i], a = Math.max(0, 1 - q.t / q.dur);
      if (q.type === 'star') { ctx.globalAlpha = a; ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot); blit(SPR.star, 0, 0, q.r * (0.6 + a)); ctx.restore(); continue; }
      ctx.globalAlpha = a; ctx.fillStyle = q.col;
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot);
      ctx.beginPath(); ctx.moveTo(0, -q.r * 1.4); ctx.lineTo(q.r, 0); ctx.lineTo(0, q.r * 1.4); ctx.lineTo(-q.r, 0); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // orbs flying to the score
    for (i = 0; i < fx.orbs.length; i++) {
      var o = fx.orbs[i]; if (o.t <= 0) continue;
      for (var j = o.trail.length - 1; j >= 0; j--) {
        ctx.globalAlpha = 0.5 * (1 - j / o.trail.length); blit(SPR.glow[o.k], o.trail[j].x, o.trail[j].y, 0.32 - j * 0.03);
      }
      var pp = orbPos(o); ctx.globalAlpha = 1;
      blit(SPR.glow[o.k], pp.x, pp.y, 0.4);
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(pp.x, pp.y, 3.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // floating points and praise
    for (i = 0; i < fx.texts.length; i++) {
      var tx = fx.texts[i]; if (tx.t < 0) continue;
      var s = popScale(tx.t), life = tx.praise ? 1.0 : 0.95, al = Math.min(1, (life - tx.t) / 0.3);
      var yy = tx.y - (tx.praise ? Math.max(0, tx.t - 0.5) * 50 : tx.t * 44);
      ctx.save(); ctx.translate(tx.x, yy); ctx.scale(s, s);
      if (tx.praise) ctx.rotate(-0.06);
      text(tx.text, 0, 0, tx.size, tx.col, al, tx.edge);
      ctx.restore();
    }
  }
  function drawChip(pv, k) {
    var gm = GEMS[k], y = GY + BOARD + 54, label = (loop ? 'LOOP  ' : '') + 'x' + pv.n + '   +' + pv.pts;
    ctx.font = '22px ' + FONT; var w = ctx.measureText(label).width + 66;
    var pulse = loop ? 1 + 0.04 * Math.sin(clock * 10) : 1;
    ctx.save(); ctx.translate(W / 2, y); ctx.scale(pulse, pulse);
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; rrect(ctx, -w / 2, -22, w, 44, 22); ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = gm.base; ctx.stroke();
    blit(SPR.pearl[k], -w / 2 + 24, 0, 0.6);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff'; ctx.fillText(label, -w / 2 + 46, 1);
    ctx.restore();
  }
  function drawReady() {
    var t = fx.readyT, word = t < 1.0 ? 'READY' : 'GO!', lt = t < 1.0 ? t : t - 1.0;
    var s = popScale(lt), a = t < 1.0 ? Math.min(1, (1.0 - t) * 5) : Math.max(0, 1 - lt * 3);
    ctx.save(); ctx.translate(W / 2, GY + BOARD / 2); ctx.scale(s, s);
    text(word, 0, 0, t < 1.0 ? 58 : 84, t < 1.0 ? '#ffffff' : '#ffd257', a, '#2a1405');
    ctx.restore();
  }
  function drawTimeUp() {
    var t = fx.timeupT, s = popScale(t), a = Math.min(1, (2.3 - t) * 3);
    ctx.save(); ctx.translate(W / 2, GY + BOARD / 2 - 10); ctx.scale(s, s); ctx.rotate(-0.05);
    text("TIME'S UP!", 0, 0, 62, '#ffd257', a, '#2a1405');
    ctx.restore();
  }
  // The menu: a string of pearls swinging under the top of the screen.
  function drawNecklace() {
    var n = 15, x0 = 10, x1 = W - 10, sag = 150 + Math.sin(clock * 0.9) * 10, y0 = -10, i, pts = [];
    for (i = 0; i < n; i++) {
      var u = i / (n - 1), x = x0 + (x1 - x0) * u + Math.sin(clock * 0.9 + 1) * 8 * Math.sin(u * Math.PI), y = y0 + 4 * sag * u * (1 - u) + 30;
      pts.push({ x: x, y: y });
    }
    ctx.strokeStyle = 'rgba(255,214,120,0.55)'; ctx.lineWidth = 2; ctx.beginPath();
    for (i = 0; i < n; i++) { if (i) ctx.lineTo(pts[i].x, pts[i].y); else ctx.moveTo(pts[i].x, pts[i].y); } ctx.stroke();
    for (i = 0; i < n; i++) {
      var kk = [0, 3, 1, 2, 4][i % 5], s = 0.7 + 0.12 * Math.sin(i * 1.7);
      ctx.globalAlpha = 0.5; blit(SPR.glow[kk], pts[i].x, pts[i].y, s * 0.8); ctx.globalAlpha = 1;
      blit(SPR.pearl[kk], pts[i].x, pts[i].y, s);
    }
  }
  function renderTop() {
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, topCv.width, topCv.height);
    if (!fx.confetti.length) return;
    tctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
    for (var i = 0; i < fx.confetti.length; i++) {
      var f = fx.confetti[i];
      tctx.save(); tctx.translate(f.x, f.y); tctx.rotate(f.r); tctx.scale(1, Math.abs(Math.cos(f.r * 1.7)) * 0.8 + 0.2);
      tctx.fillStyle = f.col; tctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h); tctx.restore();
    }
  }

  // ── loop: fixed 1/60 s steps for the clock, real time for effects ──────────
  var STEP_MS = 1000 / 60, MAX_CATCHUP = 3, acc = 0, lastT = null;
  function frame(t) {
    requestAnimationFrame(frame);
    if (lastT === null) lastT = t;
    var dt = Math.max(0, Math.min(100, t - lastT)); lastT = t;
    var dts = Math.min(0.05, dt / 1000); clock += dts;
    if (state === 'ready') {
      var was = fx.readyT; fx.readyT += dts;
      if (was < 1.0 && fx.readyT >= 1.0) { state = 'play'; acc = 0; audio.go(); lastInput = clock; }
    }
    if (state === 'play') {
      if (fx.readyT < 1.6) fx.readyT += dts;
      acc += RP ? RP.elapsed(dt, STEP_MS * MAX_CATCHUP) : dt;
      var n = 0, cap = RP ? MAX_CATCHUP * Math.max(1, RP.speed()) : MAX_CATCHUP;
      while (acc >= STEP_MS && n < cap) {
        if (replayChains) { var due = replayChains.due(sim.step); for (var ri = 0; ri < due.length; ri++) applyChain(due[ri].cells, due[ri].down, false); }
        stepSim(sim); acc -= STEP_MS; n++;
        if (sim.over) break;
      }
      if (RP) RP.report(sim.step, sim.score);
      if (n >= cap && acc > STEP_MS) acc = 0;
      var left = RUN_STEPS - sim.step;
      if (left <= WARN_STEPS && !RP) {
        var sec = Math.ceil(left / 60);
        if (sec !== lastSec) { lastSec = sec; if (sec > 0) { audio.tick(sec <= 3); if (sec <= 3) buzz(20); } }
      }
      if (sim.over) timeUp();
    } else if (state === 'timeup') {
      fx.timeupT += dts;
      if (fx.timeupT >= 2.3) finishRun();
    }
    if (state === 'menu' && !board.length) newBoard(false);
    animate(dts);
    render();
    renderTop();
  }
  requestAnimationFrame(frame);

  if (typeof window.__kjOnSessionReady === 'function') window.__kjOnSessionReady(onSessionReady);
  else onSessionReady();

  // the harness (tests) reads the sim; standalone only otherwise
  if (!EMBED || window.__pcHarness) {
    window.__pc = { get sim() { return sim; }, get state() { return state; }, get board() { return board; } };
  }
})();
