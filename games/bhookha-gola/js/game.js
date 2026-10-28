/*
 * Bhookha Gola: a hungry hole swallows a small city, smallest things first.
 *
 * Everything that decides the score lives in the rules block. It is integer,
 * fixed step (1/60 s), seed addressed and uses no engine trig. Drawing, audio,
 * particles and UI sit below it and may only READ the sim, never write it.
 */
(function () {
  'use strict';

// ==== BHOOKHA GOLA RULES BEGIN ====
// Positions are integers in 1/16 of a design unit. The hole's size is its AREA
// M (unit squared), so growth is "add the prop's footprint". R16 is its radius
// in 1/16 units. The arena is a fixed WORLD x WORLD square, never screen sized.
var RULES_VERSION = 1;
var RUN_STEPS = 7200;           // 2 minutes at 60 steps a second
var WORLD = 2800;
var BLOCKS = 5;                 // 5 x 5 city blocks split by roads
var BLOCK = 460;
var ROAD = 120;
var MARGIN = 10;
var PAD = 20;                   // sidewalk inside a block
var QUAD = 210;                 // a block is four quadrants, each one cluster
var START_AREA = 576;           // radius 24
var STICK_MAX = 64;             // stick components are integers within this
var STICK_DEAD = 10;
var STICK_FULL = 40;            // a stick this long is full speed
var SPD_BASE = 50;              // 1/16 units a step at the smallest size
var SPD_DIV = 40;               // plus R16 / SPD_DIV
var ACCEL_DIV = 6;              // velocity closes 1/6 of the gap each step
var FIT_PCT = 84;               // a prop fits when (pr)^2 * 100 <= R^2 * FIT_PCT
var CAP_PCT = 90;               // and falls in when its centre is within this of R^2
var REACH_PCT = 40;             // a prop that does not fit is touched at pr + 40% of R
var HEAVY_PR = 60;              // props this big never move, the hole is pushed out
var GROW_NUM = 1;               // the hole grows by pr^2 * 1 / 10
var GROW_DEN = 10;
var PTS_DIV = 40;               // a prop is worth pr^2 / 40 points
var COMBO_GAP = 48;             // steps a streak survives without a swallow
var CLEAR_BONUS = 2000;
var CLEAR_PER_SEC = 50;
var TIER_R = [30, 42, 58, 80, 110, 150, 200];
var LEVEL_FILL = [70, 72, 80, 90, 100];
var LEVEL_COLS = [5, 4, 3, 2, 1];
// [level, smallest pr, largest pr]. Levels 0 to 4 fill quadrants, level 5 is a
// landmark that takes a whole corner block.
var KINDS = [
  [0, 7, 9], [0, 9, 11], [0, 10, 12],
  [1, 14, 17], [1, 15, 19], [1, 17, 20], [1, 16, 20],
  [2, 22, 27], [2, 26, 33], [2, 24, 30], [2, 28, 33],
  [3, 38, 46], [3, 40, 48], [3, 40, 48], [3, 38, 48],
  [4, 72, 90], [4, 75, 90], [4, 80, 95],
  [5, 140, 160], [5, 150, 175], [5, 145, 170]
];

function hash(a, b, c) {
  var h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul(b | 0, 0x85EBCA77) ^ Math.imul(c | 0, 0xC2B2AE3D)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297A2D39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

function kindsOfLevel(lv) {
  var out = [];
  for (var k = 0; k < KINDS.length; k++) if (KINDS[k][0] === lv) out.push(k);
  return out;
}

function comboMult(streak) {
  return 1 + (streak >= 4 ? 1 : 0) + (streak >= 10 ? 1 : 0) + (streak >= 20 ? 1 : 0) + (streak >= 35 ? 1 : 0);
}

function tierOf(R16) {
  var r = Math.floor(R16 / 16), t = 0;
  for (var i = 0; i < TIER_R.length; i++) if (r >= TIER_R[i]) t = i + 1;
  return t;
}

function radius16(M) {
  return Math.floor(Math.sqrt(M * 256));
}

function propFits(R16, pr) {
  var p16 = pr * 16;
  return p16 * p16 * 100 <= R16 * R16 * FIT_PCT;
}

// The whole city is a pure function of the seed. Every cell draws the same
// number of hashes whether or not it ends up holding a prop.
function buildWorld(seed) {
  var PX = [], PY = [], PR = [], PK = [], PV = [];
  function put(cx, cy, pr, kind, variant) {
    PX.push(cx * 16); PY.push(cy * 16); PR.push(pr); PK.push(kind); PV.push(variant);
  }
  for (var bj = 0; bj < BLOCKS; bj++) {
    for (var bi = 0; bi < BLOCKS; bi++) {
      var id = bj * BLOCKS + bi;
      var ring = Math.max(Math.abs(bi - 2), Math.abs(bj - 2));
      var bx = MARGIN + bi * (BLOCK + ROAD);
      var by = MARGIN + bj * (BLOCK + ROAD);
      var corner = (bi === 0 || bi === BLOCKS - 1) && (bj === 0 || bj === BLOCKS - 1);
      if (corner) {
        var lk = kindsOfLevel(5);
        var kk = lk[hash(seed, id, 1) % lk.length];
        var kpr = KINDS[kk][1] + hash(seed, id, 2) % (KINDS[kk][2] - KINDS[kk][1] + 1);
        var room = Math.floor(BLOCK / 2) - kpr - PAD;
        if (room < 0) room = 0;
        var jx = hash(seed, id, 3) % (2 * room + 1) - room;
        var jy = hash(seed, id, 4) % (2 * room + 1) - room;
        put(bx + BLOCK / 2 + jx, by + BLOCK / 2 + jy, kpr, kk, hash(seed, id, 5) % 4);
        continue;
      }
      for (var q = 0; q < 4; q++) {
        var qid = id * 4 + q;
        var roll = hash(seed, qid, 7) % 100;
        var lq;
        if (ring === 0) lq = q === 3 ? 1 : 0;
        else if (ring === 1) lq = roll < 20 ? 0 : roll < 60 ? 1 : roll < 90 ? 2 : 3;
        else lq = roll < 20 ? 2 : roll < 60 ? 3 : 4;
        var list = kindsOfLevel(lq);
        var kind = list[hash(seed, qid, 8) % list.length];
        var vq = hash(seed, qid, 9) % 4;
        var cols = LEVEL_COLS[lq];
        var cell = Math.floor(QUAD / cols);
        var gx0 = bx + PAD + (q & 1) * QUAD + ((QUAD - cell * cols) >> 1);
        var gy0 = by + PAD + (q >> 1) * QUAD + ((QUAD - cell * cols) >> 1);
        for (var c = 0; c < cols * cols; c++) {
          var key = qid * 32 + c;
          var fill = hash(seed, key, 10) % 100 < LEVEL_FILL[lq];
          var pr = KINDS[kind][1] + hash(seed, key, 11) % (KINDS[kind][2] - KINDS[kind][1] + 1);
          var rm = (cell >> 1) - pr - 1;
          if (rm < 0) rm = 0;
          var ox = hash(seed, key, 12) % (2 * rm + 1) - rm;
          var oy = hash(seed, key, 13) % (2 * rm + 1) - rm;
          var v = (vq + (hash(seed, key, 14) % 3 === 0 ? 1 : 0)) % 4;
          if (!fill) continue;
          put(gx0 + (c % cols) * cell + (cell >> 1) + ox, gy0 + Math.floor(c / cols) * cell + (cell >> 1) + oy, pr, kind, v);
        }
      }
    }
  }
  return { PX: PX, PY: PY, PR: PR, PK: PK, PV: PV };
}

function initSim(seed) {
  var w = buildWorld(seed >>> 0);
  var n = w.PR.length;
  var alive = [], PT = [];
  for (var i = 0; i < n; i++) { alive.push(1); PT.push(Math.max(1, Math.floor(w.PR[i] * w.PR[i] / PTS_DIV))); }
  return {
    seed: seed >>> 0, n: n, PX: w.PX, PY: w.PY, PR: w.PR, PK: w.PK, PV: w.PV, PT: PT, alive: alive, left: n,
    hx: WORLD * 8, hy: WORLD * 8, vx: 0, vy: 0,
    M: START_AREA, R16: radius16(START_AREA), tier: 0,
    steps: 0, score: 0, streak: 0, comboT: 0, mult: 1,
    eaten: 0, bestStreak: 0, bestMult: 1, biggest: 0, biggestPts: 0, bonus: 0,
    over: false, cleared: false, ev: []
  };
}

function approach(v, t) {
  var d = t - v;
  if (d === 0) return v;
  var st = (d / ACCEL_DIV) | 0;
  if (st === 0) st = d > 0 ? 1 : -1;
  return v + st;
}

function stepSim(s, sx, sy) {
  if (s.over) return;
  s.ev.length = 0;
  if (sx > STICK_MAX) sx = STICK_MAX; else if (sx < -STICK_MAX) sx = -STICK_MAX;
  if (sy > STICK_MAX) sy = STICK_MAX; else if (sy < -STICK_MAX) sy = -STICK_MAX;
  var tx = 0, ty = 0;
  var len2 = sx * sx + sy * sy;
  if (len2 >= STICK_DEAD * STICK_DEAD) {
    var len = Math.sqrt(len2);
    var frac = len >= STICK_FULL ? 1 : len / STICK_FULL;
    var spd = SPD_BASE + Math.floor(s.R16 / SPD_DIV);
    tx = (sx / len * spd * frac) | 0;
    ty = (sy / len * spd * frac) | 0;
  }
  s.vx = approach(s.vx, tx);
  s.vy = approach(s.vy, ty);
  s.hx += s.vx;
  s.hy += s.vy;
  var lo = s.R16, hi = WORLD * 16 - s.R16;
  if (s.hx < lo) { s.hx = lo; s.vx = 0; } else if (s.hx > hi) { s.hx = hi; s.vx = 0; }
  if (s.hy < lo) { s.hy = lo; s.vy = 0; } else if (s.hy > hi) { s.hy = hi; s.vy = 0; }

  var R16 = s.R16, R2 = R16 * R16, i, dx, dy, d2;
  // props that do not fit block the hole (heavy) or get nudged (light)
  for (i = 0; i < s.n; i++) {
    if (!s.alive[i]) continue;
    dx = s.PX[i] - s.hx; dy = s.PY[i] - s.hy;
    var p16 = s.PR[i] * 16;
    if (p16 * p16 * 100 <= R2 * FIT_PCT) continue;
    var reach = p16 + Math.floor(R16 * REACH_PCT / 100);
    if (dx > reach || dx < -reach || dy > reach || dy < -reach) continue;
    d2 = dx * dx + dy * dy;
    if (d2 >= reach * reach) continue;
    var d = Math.sqrt(d2);
    var nx, ny;
    if (d < 1) { nx = 1; ny = 0; d = 0; } else { nx = dx / d; ny = dy / d; }
    var push = reach - d;
    if (s.PR[i] >= HEAVY_PR) {
      s.hx = Math.round(s.hx - nx * push);
      s.hy = Math.round(s.hy - ny * push);
      if (s.hx < lo) s.hx = lo; else if (s.hx > hi) s.hx = hi;
      if (s.hy < lo) s.hy = lo; else if (s.hy > hi) s.hy = hi;
    } else {
      var qx = Math.round(s.PX[i] + nx * push), qy = Math.round(s.PY[i] + ny * push);
      var edge = (s.PR[i] + 2) * 16;
      if (qx < edge) qx = edge; else if (qx > WORLD * 16 - edge) qx = WORLD * 16 - edge;
      if (qy < edge) qy = edge; else if (qy > WORLD * 16 - edge) qy = WORLD * 16 - edge;
      s.PX[i] = qx; s.PY[i] = qy;
    }
  }
  // props that fit and whose centre is over the hole fall in
  var grew = 0;
  for (i = 0; i < s.n; i++) {
    if (!s.alive[i]) continue;
    p16 = s.PR[i] * 16;
    if (p16 * p16 * 100 > R2 * FIT_PCT) continue;
    dx = s.PX[i] - s.hx; dy = s.PY[i] - s.hy;
    if (dx > R16 || dx < -R16 || dy > R16 || dy < -R16) continue;
    d2 = dx * dx + dy * dy;
    if (d2 * 100 > R2 * CAP_PCT) continue;
    s.alive[i] = 0;
    s.left--;
    s.eaten++;
    s.streak++;
    s.comboT = COMBO_GAP;
    s.mult = comboMult(s.streak);
    if (s.streak > s.bestStreak) s.bestStreak = s.streak;
    if (s.mult > s.bestMult) s.bestMult = s.mult;
    var gain = s.PT[i] * s.mult;
    s.score += gain;
    if (s.PR[i] > s.biggest) { s.biggest = s.PR[i]; s.biggestPts = gain; }
    grew += Math.floor(s.PR[i] * s.PR[i] * GROW_NUM / GROW_DEN);
    s.ev.push({ t: 'eat', i: i, pts: gain, mult: s.mult, pr: s.PR[i] });
  }
  if (grew > 0) {
    s.M += grew;
    s.R16 = radius16(s.M);
    var t = tierOf(s.R16);
    if (t > s.tier) { s.tier = t; s.ev.push({ t: 'tier', tier: t }); }
  }
  if (s.comboT > 0) {
    s.comboT--;
    if (s.comboT === 0) { s.streak = 0; s.mult = 1; }
  }
  s.steps++;
  if (s.left === 0) {
    s.cleared = true;
    s.bonus = CLEAR_BONUS + Math.floor((RUN_STEPS - s.steps) / 60) * CLEAR_PER_SEC;
    s.score += s.bonus;
    s.over = true;
    s.ev.push({ t: 'clear' });
  } else if (s.steps >= RUN_STEPS) {
    s.over = true;
    s.ev.push({ t: 'time' });
  }
}
// ==== BHOOKHA GOLA RULES END ====

  // ================= PRESENTATION (reads the sim, never writes it) =================
  var STEP_MS = 1000 / 60;
  var DESIGN_W = 414;
  var LIFT = 0.62;               // how much of a prop's height shows above its footprint
  var ACCENT = '#b44dff';
  var KIND_NAMES = ['cone', 'bin', 'parcel', 'barrel', 'crate', 'bench', 'sapling', 'pillar', 'tree',
    'crate stack', 'kiosk', 'dome', 'toy block', 'big tree', 'container', 'house', 'tank', 'hall',
    'tower', 'stadium', 'skyscraper'];
  var TIER_NAMES = ['CHHOTA GOLA', 'GOLA', 'BARA GOLA', 'MOTA GOLA', 'BHOOKHA GOLA', 'KHATARNAK', 'DAANAV', 'QAYAMAT'];
  var C = { red: '#ff5a5f', blue: '#3d8bfd', yellow: '#ffc531', teal: '#17c3b2', orange: '#ff8a30',
    purple: '#9b5de5', pink: '#ff6ba6', green: '#4cc66d', wood: '#d9a066', stone: '#ece6f5', navy: '#4a4e9a', mint: '#7fd8be' };
  var PAL = [
    [C.orange, C.yellow, C.pink, C.green],          // cone
    [C.teal, C.blue, C.green, C.navy],              // bin
    [C.wood, C.yellow, C.blue, C.pink],             // parcel
    [C.red, C.blue, C.yellow, C.teal],              // barrel
    [C.wood, '#c98b55', C.teal, C.red],             // crate
    [C.teal, C.orange, C.blue, C.pink],             // bench
    [C.green, C.pink, C.yellow, C.mint],            // sapling
    [C.stone, '#ffe1c2', '#d7ecff', '#ffd6e4'],     // pillar
    [C.green, '#36b37e', C.pink, C.yellow],         // tree
    [C.wood, '#c98b55', C.wood, '#e0b07a'],         // crate stack
    [C.red, C.blue, C.purple, C.teal],              // kiosk
    [C.blue, C.purple, C.teal, C.pink],             // dome
    [C.red, C.yellow, C.blue, C.green],             // toy block
    [C.green, '#36b37e', C.mint, C.pink],           // big tree
    [C.orange, C.blue, C.red, C.teal],              // container
    [C.yellow, C.pink, C.teal, C.orange],           // house
    [C.stone, C.teal, C.yellow, C.blue],            // tank
    [C.purple, C.teal, C.red, C.blue],              // hall
    [C.blue, C.purple, C.teal, C.navy],             // tower
    [C.pink, C.teal, C.yellow, C.purple],           // stadium
    [C.navy, C.blue, C.purple, C.teal]              // skyscraper
  ];
  var UP = [1.9, 1.7, 1.7, 1.8, 1.8, 1.8, 2.5, 2.3, 2.7, 2.1, 2.0, 1.9, 2.0, 2.9, 1.6, 2.3, 2.6, 2.3, 3.4, 2.0, 3.6];
  var BLOCK_TINTS = ['#d4f0d6', '#e4dbf7', '#d5e9f8', '#fff1c4', '#fcd9e4', '#d9f3ec'];

  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function shade(h, a) {
    var c = hexRgb(h), t = a < 0 ? 0 : 255, p = Math.abs(a);
    var o = '#';
    for (var i = 0; i < 3; i++) { var x = Math.round(c[i] + (t - c[i]) * p); o += (x < 16 ? '0' : '') + x.toString(16); }
    return o;
  }
  function rgba(h, a) { var c = hexRgb(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  // ---------- prop art: plain solids in a slight 3/4 view, lit top, darker sides ----------
  function shadowBlob(c, p, k) {
    var g = c.createRadialGradient(p * 0.22, p * 0.22, 0, p * 0.22, p * 0.22, p * 1.08 * k);
    g.addColorStop(0, 'rgba(40,30,70,0.34)'); g.addColorStop(0.6, 'rgba(40,30,70,0.16)'); g.addColorStop(1, 'rgba(40,30,70,0)');
    c.save(); c.translate(p * 0.22, p * 0.22); c.scale(1, 0.7); c.translate(-p * 0.22, -p * 0.22);
    c.fillStyle = g; c.beginPath(); c.arc(p * 0.22, p * 0.22, p * 1.08 * k, 0, Math.PI * 2); c.fill(); c.restore();
  }
  function box(c, cx, cy, w, d, h, col, lw) {
    var L = h * LIFT, fy = cy + d / 2 - L, ty = cy - d / 2 - L, r = Math.min(w, d) * 0.1;
    var g = c.createLinearGradient(0, fy, 0, fy + L);
    g.addColorStop(0, shade(col, -0.16)); g.addColorStop(1, shade(col, -0.36));
    c.fillStyle = g; rr(c, cx - w / 2, fy, w, L + r, r); c.fill();
    var gt = c.createLinearGradient(0, ty, 0, ty + d);
    gt.addColorStop(0, shade(col, 0.3)); gt.addColorStop(1, shade(col, 0.1));
    c.fillStyle = gt; rr(c, cx - w / 2, ty, w, d, r); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = lw || Math.max(0.6, w * 0.035);
    c.beginPath(); c.moveTo(cx - w / 2 + r, fy); c.lineTo(cx + w / 2 - r, fy); c.stroke();
    c.strokeStyle = 'rgba(30,20,60,0.22)'; c.lineWidth = Math.max(0.5, w * 0.02);
    rr(c, cx - w / 2, ty, w, d + L + r * 0.5, r); c.stroke();
    return { top: ty, front: fy, L: L };
  }
  function cyl(c, cx, cy, r, h, col) {
    var L = h * LIFT, ry = r * 0.62;
    var g = c.createLinearGradient(cx - r, 0, cx + r, 0);
    g.addColorStop(0, shade(col, -0.32)); g.addColorStop(0.3, shade(col, 0.1)); g.addColorStop(0.72, shade(col, -0.1)); g.addColorStop(1, shade(col, -0.4));
    c.fillStyle = g; c.beginPath(); c.moveTo(cx - r, cy - L); c.lineTo(cx - r, cy);
    c.ellipse(cx, cy, r, ry, 0, Math.PI, 0, true); c.lineTo(cx + r, cy - L); c.closePath(); c.fill();
    c.fillStyle = shade(col, 0.28); c.beginPath(); c.ellipse(cx, cy - L, r, ry, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = Math.max(0.5, r * 0.07);
    c.beginPath(); c.ellipse(cx, cy - L, r * 0.97, ry * 0.95, 0, 0, Math.PI * 2); c.stroke();
    return { top: cy - L, L: L, ry: ry };
  }
  function band(c, cx, y, r, col, lw) {
    c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.ellipse(cx, y, r, r * 0.62, 0, 0.05, Math.PI - 0.05); c.stroke();
  }
  function sphere(c, cx, cy, r, col) {
    var g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.08, cx, cy, r * 1.05);
    g.addColorStop(0, shade(col, 0.45)); g.addColorStop(0.45, col); g.addColorStop(1, shade(col, -0.38));
    c.fillStyle = g; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.45)'; c.beginPath(); c.ellipse(cx - r * 0.38, cy - r * 0.45, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2); c.fill();
  }
  function dome(c, cx, cy, r, col) {
    var ry = r * 0.62;
    var g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.7, r * 0.1, cx, cy - r * 0.2, r * 1.2);
    g.addColorStop(0, shade(col, 0.45)); g.addColorStop(0.5, col); g.addColorStop(1, shade(col, -0.4));
    c.fillStyle = g; c.beginPath(); c.ellipse(cx, cy, r, ry, 0, 0, Math.PI); c.ellipse(cx, cy, r, r * 0.92, 0, Math.PI, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.4)'; c.beginPath(); c.ellipse(cx - r * 0.35, cy - r * 0.55, r * 0.22, r * 0.12, -0.5, 0, Math.PI * 2); c.fill();
  }
  function windows(c, x, y, w, h, cols, rows, col) {
    var gx = w / cols, gy = h / rows;
    c.fillStyle = col;
    for (var j = 0; j < rows; j++) for (var i = 0; i < cols; i++) {
      rr(c, x + i * gx + gx * 0.2, y + j * gy + gy * 0.22, gx * 0.6, gy * 0.56, gx * 0.12); c.fill();
    }
  }
  var WIN = 'rgba(220,240,255,0.85)';

  function drawKind(c, k, p, v) {
    var col = PAL[k][v & 3], b, t;
    shadowBlob(c, p, k >= 15 ? 1.05 : 0.95);
    switch (k) {
      case 0: // cone
        box(c, 0, p * 0.1, p * 1.5, p * 1.5, p * 0.2, shade(col, -0.25));
        var gc = c.createLinearGradient(-p * 0.6, 0, p * 0.6, 0);
        gc.addColorStop(0, shade(col, -0.25)); gc.addColorStop(0.35, shade(col, 0.2)); gc.addColorStop(1, shade(col, -0.35));
        c.fillStyle = gc; c.beginPath(); c.moveTo(-p * 0.6, p * 0.15); c.lineTo(p * 0.6, p * 0.15); c.lineTo(p * 0.13, -p * 1.45);
        c.quadraticCurveTo(0, -p * 1.55, -p * 0.13, -p * 1.45); c.closePath(); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.92)';
        c.beginPath(); c.moveTo(-p * 0.46, -p * 0.3); c.lineTo(p * 0.46, -p * 0.3); c.lineTo(p * 0.38, -p * 0.62); c.lineTo(-p * 0.38, -p * 0.62); c.fill();
        c.beginPath(); c.moveTo(-p * 0.3, -p * 0.9); c.lineTo(p * 0.3, -p * 0.9); c.lineTo(p * 0.23, -p * 1.15); c.lineTo(-p * 0.23, -p * 1.15); c.fill();
        break;
      case 1: case 3: // bin, barrel
        b = cyl(c, 0, p * 0.2, p * 0.82, p * (k === 1 ? 1.25 : 1.45), col);
        band(c, 0, p * 0.2 - b.L * 0.3, p * 0.82, shade(col, -0.35), p * 0.1);
        band(c, 0, p * 0.2 - b.L * 0.72, p * 0.82, shade(col, -0.35), p * 0.1);
        c.fillStyle = shade(col, -0.12); c.beginPath(); c.ellipse(0, b.top, p * 0.6, b.ry * 0.72, 0, 0, Math.PI * 2); c.fill();
        if (k === 3) { c.fillStyle = shade(col, -0.4); c.beginPath(); c.ellipse(p * 0.3, b.top, p * 0.12, p * 0.08, 0, 0, Math.PI * 2); c.fill(); }
        break;
      case 2: // parcel
        b = box(c, 0, p * 0.15, p * 1.35, p * 1.35, p * 1.2, col);
        c.fillStyle = 'rgba(255,255,255,0.55)'; c.fillRect(-p * 0.14, b.top, p * 0.28, p * 1.35);
        c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(-p * 0.14, b.front, p * 0.28, b.L);
        break;
      case 4: // crate
        b = box(c, 0, p * 0.15, p * 1.42, p * 1.42, p * 1.35, col);
        c.strokeStyle = shade(col, -0.45); c.lineWidth = p * 0.1;
        c.strokeRect(-p * 0.62, b.front + p * 0.08, p * 1.24, b.L - p * 0.08);
        c.beginPath(); c.moveTo(-p * 0.62, b.front + p * 0.08); c.lineTo(p * 0.62, b.front + b.L); c.stroke();
        c.strokeStyle = shade(col, -0.2); c.lineWidth = p * 0.08;
        c.strokeRect(-p * 0.6, b.top + p * 0.1, p * 1.2, p * 1.22);
        break;
      case 5: // bench
        box(c, 0, -p * 0.38, p * 1.9, p * 0.22, p * 1.05, shade(col, -0.05));
        box(c, 0, p * 0.15, p * 1.9, p * 0.75, p * 0.55, col);
        c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(-p * 0.95, p * 0.15 - p * 0.13, p * 1.9, p * 0.05);
        break;
      case 6: case 8: // sapling, tree
        var th = k === 6 ? 0.95 : 1.15;
        b = cyl(c, 0, p * 0.15, p * (k === 6 ? 0.17 : 0.2), p * th, '#9a6a45');
        sphere(c, 0, b.top - p * (k === 6 ? 0.55 : 0.62), p * (k === 6 ? 0.78 : 0.9), col);
        break;
      case 7: // pillar
        b = cyl(c, 0, p * 0.15, p * 0.6, p * 2.0, col);
        band(c, 0, p * 0.15 - b.L * 0.5, p * 0.6, C.purple, p * 0.12);
        cyl(c, 0, b.top + p * 0.08, p * 0.8, p * 0.28, shade(col, -0.05));
        break;
      case 9: // crate stack
        box(c, -p * 0.45, -p * 0.2, p * 0.88, p * 0.88, p * 0.85, shade(col, -0.05));
        box(c, p * 0.45, -p * 0.2, p * 0.88, p * 0.88, p * 0.85, col);
        b = box(c, 0, p * 0.45, p * 0.88, p * 0.88, p * 0.85, shade(col, 0.05));
        box(c, -p * 0.05, -p * 0.2 - p * 0.85 * LIFT, p * 0.85, p * 0.85, p * 0.8, shade(col, 0.1));
        break;
      case 10: // kiosk
        b = box(c, 0, p * 0.15, p * 1.5, p * 1.2, p * 1.15, col);
        var aw = p * 0.32, n = 6, sw = p * 1.6 / n;
        for (var i = 0; i < n; i++) {
          c.fillStyle = i % 2 ? '#ffffff' : shade(col, 0.1);
          c.beginPath(); c.moveTo(-p * 0.8 + i * sw, b.front + p * 0.02); c.lineTo(-p * 0.8 + (i + 1) * sw, b.front + p * 0.02);
          c.lineTo(-p * 0.8 + (i + 1) * sw, b.front + aw); c.lineTo(-p * 0.8 + i * sw, b.front + aw); c.fill();
        }
        c.fillStyle = 'rgba(30,20,60,0.25)'; c.fillRect(-p * 0.55, b.front + aw + p * 0.06, p * 1.1, p * 0.22);
        c.fillStyle = C.yellow; rr(c, -p * 0.35, b.top + p * 0.3, p * 0.7, p * 0.4, p * 0.1); c.fill();
        break;
      case 11: // dome
        b = cyl(c, 0, p * 0.2, p * 0.95, p * 0.3, C.stone);
        dome(c, 0, b.top, p * 0.88, col);
        c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = p * 0.05;
        c.beginPath(); c.ellipse(0, b.top, p * 0.4, p * 0.8, 0, Math.PI, Math.PI * 2); c.stroke();
        break;
      case 12: // toy block
        b = box(c, 0, p * 0.15, p * 1.38, p * 1.38, p * 1.25, col);
        for (var sy = 0; sy < 2; sy++) for (var sx = 0; sx < 2; sx++) {
          cyl(c, (sx - 0.5) * p * 0.66, b.top + p * 0.36 + sy * p * 0.66, p * 0.2, p * 0.22, shade(col, 0.05));
        }
        break;
      case 13: // big tree
        b = cyl(c, 0, p * 0.25, p * 0.2, p * 1.1, '#9a6a45');
        sphere(c, -p * 0.38, b.top - p * 0.7, p * 0.66, shade(col, -0.12));
        sphere(c, p * 0.36, b.top - p * 0.62, p * 0.6, shade(col, -0.05));
        sphere(c, 0, b.top - p * 0.42, p * 0.72, col);
        break;
      case 14: // container
        b = box(c, 0, p * 0.15, p * 1.9, p * 0.95, p * 1.0, col);
        c.strokeStyle = shade(col, -0.42); c.lineWidth = p * 0.045;
        for (var r2 = 0; r2 < 9; r2++) { var xx = -p * 0.8 + r2 * p * 0.2; c.beginPath(); c.moveTo(xx, b.front + p * 0.06); c.lineTo(xx, b.front + b.L - p * 0.02); c.stroke(); }
        c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(-p * 0.95, b.top + p * 0.38, p * 1.9, p * 0.18);
        break;
      case 15: // house: stacked boxes
        b = box(c, 0, p * 0.2, p * 1.5, p * 1.3, p * 1.0, col);
        windows(c, -p * 0.62, b.front + p * 0.08, p * 1.24, b.L - p * 0.14, 4, 1, WIN);
        t = box(c, -p * 0.12, b.top + p * 0.62, p * 1.0, p * 0.9, p * 0.75, shade(col, 0.08));
        windows(c, -p * 0.55, t.front + p * 0.05, p * 0.86, t.L - p * 0.1, 3, 1, WIN);
        box(c, -p * 0.12, t.top + p * 0.45, p * 1.08, p * 0.98, p * 0.12, C.red);
        break;
      case 16: // tank
        b = cyl(c, 0, p * 0.2, p * 0.9, p * 1.5, col);
        band(c, 0, p * 0.2 - b.L * 0.45, p * 0.9, C.orange, p * 0.16);
        dome(c, 0, b.top, p * 0.9, shade(col, 0.05));
        c.strokeStyle = 'rgba(40,30,70,0.45)'; c.lineWidth = p * 0.04;
        c.beginPath(); c.moveTo(p * 0.55, p * 0.55); c.lineTo(p * 0.55, b.top + p * 0.4); c.moveTo(p * 0.72, p * 0.5); c.lineTo(p * 0.72, b.top + p * 0.45); c.stroke();
        break;
      case 17: // hall
        b = box(c, 0, p * 0.25, p * 1.8, p * 1.4, p * 0.6, C.stone);
        windows(c, -p * 0.8, b.front + p * 0.06, p * 1.6, b.L - p * 0.1, 6, 1, rgba(col, 0.55));
        dome(c, 0, b.top + p * 0.75, p * 0.72, col);
        break;
      case 18: // tower: three stacked boxes
        b = box(c, 0, p * 0.3, p * 1.45, p * 1.3, p * 0.95, col);
        windows(c, -p * 0.62, b.front + p * 0.06, p * 1.24, b.L - p * 0.1, 5, 2, WIN);
        t = box(c, 0, b.top + p * 0.6, p * 1.1, p * 1.0, p * 0.85, shade(col, 0.08));
        windows(c, -p * 0.48, t.front + p * 0.05, p * 0.96, t.L - p * 0.08, 4, 2, WIN);
        var u = box(c, 0, t.top + p * 0.48, p * 0.72, p * 0.66, p * 0.75, shade(col, 0.16));
        windows(c, -p * 0.3, u.front + p * 0.05, p * 0.6, u.L - p * 0.08, 3, 2, WIN);
        c.fillStyle = '#5a5f7a'; c.fillRect(-p * 0.025, u.top - p * 0.32, p * 0.05, p * 0.62);
        sphere(c, 0, u.top - p * 0.34, p * 0.07, C.red);
        break;
      case 19: // stadium
        b = cyl(c, 0, p * 0.25, p * 0.98, p * 0.42, C.stone);
        for (var a = 0; a < 10; a++) {
          c.fillStyle = a % 2 ? rgba(col, 0.6) : 'rgba(255,255,255,0.4)';
          c.fillRect(-p * 0.98 + a * p * 0.196, b.top + p * 0.6, p * 0.196, b.L * 0.5);
        }
        dome(c, 0, b.top, p * 0.9, col);
        c.strokeStyle = 'rgba(255,255,255,0.32)'; c.lineWidth = p * 0.04;
        for (var e = 0; e < 3; e++) { c.beginPath(); c.ellipse(0, b.top, p * (0.25 + e * 0.27), p * 0.84, 0, Math.PI, Math.PI * 2); c.stroke(); }
        break;
      case 20: // skyscraper
        b = box(c, 0, p * 0.3, p * 1.15, p * 1.05, p * 2.9, col);
        windows(c, -p * 0.5, b.front + p * 0.08, p * 1.0, b.L - p * 0.16, 4, 8, WIN);
        box(c, 0, b.top + p * 0.52, p * 0.8, p * 0.7, p * 0.25, C.yellow);
        c.fillStyle = '#5a5f7a'; c.fillRect(-p * 0.025, b.top - p * 0.25, p * 0.05, p * 0.6);
        sphere(c, 0, b.top - p * 0.27, p * 0.07, C.red);
        break;
    }
  }

  // ---------- sprite cache: each look is rendered once per zoom bucket at screen scale ----------
  var sprites = {}, latest = {}, buildBudget = 0;
  function qprOf(pr) { return Math.max(4, Math.round(Math.exp(Math.round(Math.log(pr) / 0.12) * 0.12))); }
  function getSprite(k, pr, v, ppu) {
    var q = qprOf(pr), bk = Math.round(Math.log(ppu) / Math.LN2 * 3), key = k + '|' + q + '|' + v;
    var id = key + '|' + bk, sp = sprites[id];
    if (sp) return sp;
    if (buildBudget <= 0 && latest[key]) return latest[key];
    buildBudget--;
    var pb = Math.pow(2, bk / 3), L = -1.45, R = 1.75, T = -UP[k], B = 1.35;
    var w = Math.min(900, Math.ceil((R - L) * q * pb) + 2), h = Math.min(1100, Math.ceil((B - T) * q * pb) + 2);
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var c = cv.getContext('2d');
    var sc = w / ((R - L) * q);
    c.setTransform(sc, 0, 0, sc, -L * q * sc, -T * q * sc);
    drawKind(c, k, q, v);
    sp = { cv: cv, L: L, T: T, uw: (R - L), uh: (B - T) * (h / ((B - T) * q * sc)), q: q };
    sprites[id] = sp; latest[key] = sp;
    return sp;
  }
  function drawSprite(c, k, pr, v, x, y, ppu) {
    var sp = getSprite(k, pr, v, ppu);
    c.drawImage(sp.cv, x + sp.L * pr, y + sp.T * pr, sp.uw * pr, sp.uh * pr);
  }
  var lastBucket = null;
  function flushSprites(ppu) {
    var bk = Math.round(Math.log(ppu) / Math.LN2 * 3);
    if (bk !== lastBucket) {
      if (lastBucket !== null) { for (var id in sprites) if (!id.endsWith('|' + bk)) delete sprites[id]; }
      lastBucket = bk;
    }
  }

  // ---------- hole sprites ----------
  var HOLE_PX = 320, holeWell, holeGlow;
  function buildHole() {
    holeWell = document.createElement('canvas'); holeWell.width = holeWell.height = HOLE_PX;
    var c = holeWell.getContext('2d'), m = HOLE_PX / 2, r = HOLE_PX * 0.41;
    // soft lip shadow on the ground
    var gs = c.createRadialGradient(m, m, r * 0.9, m, m, r * 1.2);
    gs.addColorStop(0, 'rgba(40,20,70,0.35)'); gs.addColorStop(1, 'rgba(40,20,70,0)');
    c.fillStyle = gs; c.beginPath(); c.arc(m, m, r * 1.2, 0, Math.PI * 2); c.fill();
    // the well: the far wall catches a little light, the bottom is black
    var g = c.createRadialGradient(m, m + r * 0.35, r * 0.05, m, m + r * 0.1, r * 1.05);
    g.addColorStop(0, '#000000'); g.addColorStop(0.55, '#0c0618'); g.addColorStop(0.85, '#2b1748'); g.addColorStop(1, '#4a2a78');
    c.fillStyle = g; c.beginPath(); c.arc(m, m, r, 0, Math.PI * 2); c.fill();
    // inner wall crescent at the top
    c.save(); c.beginPath(); c.arc(m, m, r, 0, Math.PI * 2); c.clip();
    var gw = c.createLinearGradient(0, m - r, 0, m);
    gw.addColorStop(0, 'rgba(160,110,230,0.55)'); gw.addColorStop(1, 'rgba(160,110,230,0)');
    c.fillStyle = gw; c.beginPath(); c.arc(m, m, r, Math.PI, Math.PI * 2); c.arc(m, m + r * 0.28, r * 1.02, Math.PI * 2, Math.PI, true); c.fill();
    c.restore();
    // glowing rim
    var gr = c.createLinearGradient(0, m - r, 0, m + r);
    gr.addColorStop(0, '#f6e6ff'); gr.addColorStop(0.5, '#d08bff'); gr.addColorStop(1, '#8b3dff');
    c.strokeStyle = gr; c.lineWidth = r * 0.085; c.beginPath(); c.arc(m, m, r, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = r * 0.025;
    c.beginPath(); c.arc(m, m, r * 1.0, Math.PI * 1.1, Math.PI * 1.65); c.stroke();
    holeGlow = document.createElement('canvas'); holeGlow.width = holeGlow.height = HOLE_PX;
    c = holeGlow.getContext('2d');
    var gg = c.createRadialGradient(m, m, r * 0.85, m, m, m);
    gg.addColorStop(0, rgba(ACCENT, 0)); gg.addColorStop(0.25, rgba(ACCENT, 0.75)); gg.addColorStop(1, rgba(ACCENT, 0));
    c.fillStyle = gg; c.fillRect(0, 0, HOLE_PX, HOLE_PX);
  }
  function drawHole(c, x, y, R, glow) {
    var k = R / (HOLE_PX * 0.41);
    if (glow > 0.01) { c.globalAlpha = Math.min(1, glow); c.drawImage(holeGlow, x - HOLE_PX / 2 * k, y - HOLE_PX / 2 * k, HOLE_PX * k, HOLE_PX * k); c.globalAlpha = 1; }
    c.drawImage(holeWell, x - HOLE_PX / 2 * k, y - HOLE_PX / 2 * k, HOLE_PX * k, HOLE_PX * k);
  }

  // ---------- ground ----------
  var tilePattern = null;
  function buildTile() {
    var t = document.createElement('canvas'); t.width = t.height = 40;
    var c = t.getContext('2d');
    c.fillStyle = 'rgba(70,60,110,0.07)'; c.fillRect(0, 0, 40, 1.2); c.fillRect(0, 0, 1.2, 40);
    tilePattern = t;
  }
  function blockTint(seed, id) {
    if (id === 12) return '#ffe9cc';
    return BLOCK_TINTS[hash(seed, id, 99) % BLOCK_TINTS.length];
  }
  function drawGround(c, S, vx0, vy0, vx1, vy1) {
    c.fillStyle = '#9c97c4';                 // outside the arena
    c.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    c.fillStyle = '#aab1c8';                 // road surface
    c.fillRect(0, 0, WORLD, WORLD);
    var pat = c.createPattern(tilePattern, 'repeat');
    for (var bj = 0; bj < BLOCKS; bj++) for (var bi = 0; bi < BLOCKS; bi++) {
      var bx = MARGIN + bi * (BLOCK + ROAD), by = MARGIN + bj * (BLOCK + ROAD);
      if (bx > vx1 || by > vy1 || bx + BLOCK < vx0 || by + BLOCK < vy0) continue;
      c.fillStyle = '#f4efe6'; rr(c, bx, by, BLOCK, BLOCK, 26); c.fill();
      c.fillStyle = blockTint(S.seed, bj * BLOCKS + bi); rr(c, bx + PAD * 0.6, by + PAD * 0.6, BLOCK - PAD * 1.2, BLOCK - PAD * 1.2, 18); c.fill();
      c.fillStyle = pat; c.fillRect(bx + PAD * 0.6, by + PAD * 0.6, BLOCK - PAD * 1.2, BLOCK - PAD * 1.2);
    }
    // lane dashes
    c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 5; c.setLineDash([28, 26]);
    c.beginPath();
    for (var r = 0; r < BLOCKS - 1; r++) {
      var m = MARGIN + (r + 1) * BLOCK + r * ROAD + ROAD / 2;
      c.moveTo(m, 0); c.lineTo(m, WORLD); c.moveTo(0, m); c.lineTo(WORLD, m);
    }
    c.stroke(); c.setLineDash([]);
    // crossings
    c.fillStyle = 'rgba(255,255,255,0.5)';
    for (var a = 0; a < BLOCKS - 1; a++) for (var b2 = 0; b2 < BLOCKS - 1; b2++) {
      var mx = MARGIN + (a + 1) * BLOCK + a * ROAD, my = MARGIN + (b2 + 1) * BLOCK + b2 * ROAD;
      if (mx > vx1 || my > vy1 || mx + ROAD < vx0 || my + ROAD < vy0) continue;
      for (var z = 0; z < 6; z++) { c.fillRect(mx + 10 + z * 18, my - 2, 9, 14); c.fillRect(mx + 10 + z * 18, my + ROAD - 12, 9, 14); }
    }
    c.strokeStyle = '#6f66a8'; c.lineWidth = 16; c.strokeRect(-8, -8, WORLD + 16, WORLD + 16);
  }

  // ---------- audio: Web Audio only ----------
  var AC = null, master = null, noiseBuf = null, muted = false;
  try { muted = localStorage.getItem('bhookha_muted') === '1'; } catch (_e) {}
  function audio() {
    if (AC) return AC;
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      AC = new Ctor();
      var comp = AC.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
      master = AC.createGain(); master.gain.value = muted ? 0 : 0.8;
      master.connect(comp); comp.connect(AC.destination);
      noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
      var d = noiseBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch (_e) { AC = null; }
    return AC;
  }
  function unlock() { var a = audio(); if (a && a.state === 'suspended') a.resume(); }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (e) { window.addEventListener(e, unlock, { passive: true }); });
  function tone(f0, f1, dur, type, vol, delay, attack) {
    if (!AC || muted) return;
    var t = AC.currentTime + (delay || 0), o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + (attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(f0, f1, q, dur, vol, type, delay) {
    if (!AC || muted) return;
    var t = AC.currentTime + (delay || 0), s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
    s.buffer = noiseBuf; f.type = type || 'bandpass'; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }
  var SFX = {
    swallow: function (size) {               // size 0..1
      var d = 0.16 + size * 0.32;
      noise(1500 - size * 900, 260 - size * 150, 3.5, d, 0.22 + size * 0.25);
      tone(300 - size * 150, 110 - size * 60, d * 0.9, 'sine', 0.12 + size * 0.2, 0.02);
      tone(700 + Math.random() * 120, 1100, 0.06, 'triangle', 0.05, 0);
    },
    thump: function (size) {
      tone(110, 36, 0.45 + size * 0.2, 'sine', 0.75, 0, 0.004);
      noise(380, 90, 1, 0.3, 0.35, 'lowpass');
    },
    combo: function (streak) {
      var sc = [0, 2, 4, 7, 9], n = Math.min(streak, 20), semi = sc[n % 5] + 12 * Math.floor(n / 5);
      tone(392 * Math.pow(2, semi / 12), 0, 0.14, 'triangle', 0.07, 0.03);
    },
    chime: function () {
      [523, 659, 784, 1047, 1319].forEach(function (f, i) { tone(f, 0, 0.5, 'sine', 0.16, i * 0.06); tone(f * 2, 0, 0.25, 'triangle', 0.04, i * 0.06); });
      noise(6000, 9000, 2, 0.5, 0.06, 'highpass', 0.05);
    },
    tick: function (last) { tone(last ? 1320 : 980, 0, 0.06, 'square', 0.05); },
    ready: function () { tone(523, 0, 0.18, 'triangle', 0.12); },
    go: function () { tone(523, 1046, 0.3, 'triangle', 0.16); tone(784, 1568, 0.3, 'sine', 0.08, 0.02); },
    gong: function () {
      [1, 2.01, 2.76, 4.07, 5.4].forEach(function (r, i) { tone(98 * r, 98 * r * 0.995, 2.6 - i * 0.35, 'sine', 0.32 / (i + 1), 0, 0.005); });
      noise(800, 200, 1, 0.5, 0.12, 'lowpass');
    },
    fanfare: function () {
      [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0, 0.32, 'triangle', 0.13, i * 0.11); });
      tone(1047, 0, 0.9, 'sine', 0.12, 0.44); tone(1319, 0, 0.9, 'sine', 0.08, 0.44);
      noise(5000, 9000, 2, 0.8, 0.05, 'highpass', 0.44);
    },
    click: function () { tone(660, 880, 0.07, 'triangle', 0.08); },
    bump: function () { tone(140, 90, 0.08, 'sine', 0.12); }
  };

  // ---------- DOM ----------
  var wrap = document.getElementById('wrap');
  var cv = document.getElementById('scene'), ctx = cv.getContext('2d');
  var fxc = document.getElementById('fx'), fx = fxc.getContext('2d');
  var $ = function (id) { return document.getElementById(id); };
  var cw = 414, ch = 736, dpr = 1, ui = 1;
  function resize() {
    var r = wrap.getBoundingClientRect();
    cw = Math.max(200, r.width); ch = Math.max(300, r.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    fxc.width = cv.width; fxc.height = cv.height;
    ui = cw / DESIGN_W;
  }
  window.addEventListener('resize', resize);

  // ---------- run state ----------
  var params = new URLSearchParams(location.search);
  var SEED = (Number(params.get('seed')) >>> 0) || 20261028;
  var mode = 'menu', S = null, demo = null, acc = 0, last = null;
  var prevHx = 0, prevHy = 0, dprevHx = 0, dprevHy = 0;
  var cam = { x: WORLD / 2, y: WORLD / 2, zr: 24, vr: 24, shake: 0 };
  var falls = [], parts = [], pops = [], rings = [], banners = [];
  var pulse = { x: 0, v: 0 }, glow = 0;
  var shownScore = 0, lastSec = -1, comboFlash = 0, prevMult = 1;
  var stick = { id: null, ox: 0, oy: 0, x: 0, y: 0, sx: 0, sy: 0 }, keys = {};
  var best = 0;
  try { best = Number(localStorage.getItem('bhookha_best')) || 0; } catch (_e) {}

  // ---------- input: one finger owns the hole, the stick is relative ----------
  var STICK_R = 54;   // design px for a full stick
  function stickUpdate() {
    var dx = (stick.x - stick.ox) / ui, dy = (stick.y - stick.oy) / ui, l = Math.sqrt(dx * dx + dy * dy);
    if (l > STICK_R) { stick.ox += dx * (1 - STICK_R / l) * ui; stick.oy += dy * (1 - STICK_R / l) * ui; dx *= STICK_R / l; dy *= STICK_R / l; }
    stick.sx = Math.round(dx / STICK_R * STICK_MAX); stick.sy = Math.round(dy / STICK_R * STICK_MAX);
  }
  function localXY(e) { var r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  cv.addEventListener('pointerdown', function (e) {
    if (stick.id !== null) return;                 // a second finger is ignored
    if (mode !== 'play' && mode !== 'ready') return;
    stick.id = e.pointerId; var p = localXY(e);
    stick.ox = stick.x = p[0]; stick.oy = stick.y = p[1]; stick.sx = stick.sy = 0;
    try { cv.setPointerCapture(e.pointerId); } catch (_e) {}
    e.preventDefault();
  });
  cv.addEventListener('pointermove', function (e) {
    if (e.pointerId !== stick.id) return;
    var p = localXY(e); stick.x = p[0]; stick.y = p[1]; stickUpdate();
  });
  function lift(e) { if (e.pointerId !== stick.id) return; stick.id = null; stick.sx = stick.sy = 0; }
  cv.addEventListener('pointerup', lift); cv.addEventListener('pointercancel', lift);
  window.addEventListener('keydown', function (e) { keys[e.key.toLowerCase()] = 1; if (e.key.indexOf('Arrow') === 0 || e.key === ' ') e.preventDefault(); });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = 0; });
  function currentStick() {
    if (stick.id !== null) return [stick.sx, stick.sy];
    var kx = (keys.arrowright || keys.d ? 1 : 0) - (keys.arrowleft || keys.a ? 1 : 0);
    var ky = (keys.arrowdown || keys.s ? 1 : 0) - (keys.arrowup || keys.w ? 1 : 0);
    if (kx || ky) { var l = Math.sqrt(kx * kx + ky * ky); return [Math.round(kx / l * STICK_MAX), Math.round(ky / l * STICK_MAX)]; }
    return [0, 0];
  }

  // ---------- attract mode pilot (menu background only) ----------
  var demoT = -1;
  function demoStick(s) {
    if (demoT < 0 || !s.alive[demoT] || s.steps % 20 === 0) {
      var bs = -1, hx = s.hx, hy = s.hy;
      demoT = -1;
      for (var i = 0; i < s.n; i++) {
        if (!s.alive[i] || !propFits(s.R16, s.PR[i])) continue;
        var dx = s.PX[i] - hx, dy = s.PY[i] - hy, sc = s.PT[i] / (Math.sqrt(dx * dx + dy * dy) / 16 + 150);
        if (sc > bs) { bs = sc; demoT = i; }
      }
    }
    if (demoT < 0) return [0, 0];
    var tx = s.PX[demoT] - s.hx, ty = s.PY[demoT] - s.hy, d = Math.sqrt(tx * tx + ty * ty) || 1;
    var sx = tx / d * 64, sy = ty / d * 64;
    for (var j = 0; j < s.n; j++) {
      if (!s.alive[j] || propFits(s.R16, s.PR[j])) continue;
      var bx = s.PX[j] - s.hx, by = s.PY[j] - s.hy, bd = Math.sqrt(bx * bx + by * by) / 16;
      if (bd < s.PR[j] + s.R16 / 40 + 30 && bx * sx + by * sy > 0) {
        var side = bx * sy - by * sx > 0 ? 1 : -1;
        sx += -by / (bd * 16) * 77 * side; sy += bx / (bd * 16) * 77 * side;
      }
    }
    var l = Math.sqrt(sx * sx + sy * sy) || 1;
    return [Math.round(sx / l * 64), Math.round(sy / l * 64)];
  }

  // ---------- effects from sim events ----------
  var lastSwallowSfx = 0, lastComboSfx = 0;
  function onEvents(s, live) {
    if (!s.ev.length) return;
    var sum = 0, big = 0, eats = 0, ax = 0, ay = 0, pts = 0, now = performance.now();
    var hx = s.hx / 16, hy = s.hy / 16;
    for (var i = 0; i < s.ev.length; i++) {
      var e = s.ev[i];
      if (e.t === 'eat') {
        var px = s.PX[e.i] / 16, py = s.PY[e.i] / 16;
        falls.push({ k: s.PK[e.i], pr: s.PR[e.i], v: s.PV[e.i], rx: px - hx, ry: py - hy, t0: now,
          dur: 380 + e.pr * 4, rot: (px < hx ? -1 : 1) * (0.5 + Math.random() * 0.5) });
        var col = PAL[s.PK[e.i]][s.PV[e.i] & 3];
        var nP = Math.min(12, 3 + (e.pr / 5) | 0);
        for (var p = 0; p < nP; p++) {
          var a = Math.random() * Math.PI * 2, sp = (40 + Math.random() * 90) * (0.6 + e.pr / 60);
          parts.push({ x: px, y: py, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0, max: 0.5 + Math.random() * 0.4,
            r: 1.5 + Math.random() * 2.5 + e.pr * 0.06, col: Math.random() < 0.3 ? '#ffffff' : col, star: Math.random() < 0.25 });
        }
        sum += e.pr * e.pr; if (e.pr > big) big = e.pr; eats++; ax += px; ay += py; pts += e.pts;
      } else if (e.t === 'tier' && live) {
        rings.push({ t0: now, col: ACCENT }); rings.push({ t0: now + 140, col: '#ffffff' });
        banners.push({ t0: now, a: 'SIZE UP!', b: TIER_NAMES[Math.min(e.tier, TIER_NAMES.length - 1)], dur: 1300 });
        SFX.chime();
      } else if ((e.t === 'time' || e.t === 'clear') && live) {
        endRun(e.t === 'clear');
      }
    }
    if (!eats) return;
    pulse.v += Math.min(1.2, 0.35 + Math.sqrt(sum) / (s.R16 / 16) * 0.6); glow = 1;
    if (eats >= 3) pops.push({ x: ax / eats, y: ay / eats, txt: '+' + pts, t0: now, big: pts > 200, mult: s.mult });
    else for (var j = 0; j < s.ev.length; j++) if (s.ev[j].t === 'eat') {
      var ee = s.ev[j]; pops.push({ x: s.PX[ee.i] / 16, y: s.PY[ee.i] / 16, txt: '+' + ee.pts, t0: now + j * 40, big: ee.pts > 200, mult: ee.mult });
    }
    // stack pops that would land on each other
    for (var a2 = pops.length - 1; a2 >= 0; a2--) {
      var pa = pops[a2];
      if (now - pa.t0 > 0 || pa.stacked) continue;
      pa.stacked = true;
      for (var b3 = 0; b3 < pops.length; b3++) {
        var pb = pops[b3];
        if (pb === pa || now - pb.t0 > 500) continue;
        if (Math.abs(pb.x - pa.x) < s.R16 / 16 * 0.9 && Math.abs(pb.y - pa.y) < s.R16 / 16 * 0.6) pa.lift = (pa.lift || 0) + 1;
      }
    }
    if (!live) return;
    if (now - lastSwallowSfx > 45) { SFX.swallow(clamp(Math.sqrt(sum) / 120, 0, 1)); lastSwallowSfx = now; }
    if (big >= 38) { SFX.thump(clamp(big / 170, 0, 1)); cam.shake = Math.max(cam.shake, Math.min(16, 4 + big / 12)); }
    if (s.streak >= 2 && now - lastComboSfx > 70) { SFX.combo(s.streak); lastComboSfx = now; }
    if (s.mult > prevMult) { comboFlash = 1; }
    prevMult = s.mult;
  }

  // ---------- flow ----------
  function show(id, on) {
    var el = $(id);
    if (on) { el.classList.remove('is-gone'); void el.offsetWidth; el.classList.remove('is-hidden'); }
    else { el.classList.add('is-hidden'); setTimeout(function () { if (el.classList.contains('is-hidden')) el.classList.add('is-gone'); }, 300); }
  }
  function resetFx() { falls = []; parts = []; pops = []; rings = []; banners = []; pulse.x = pulse.v = 0; glow = 0; }
  function newDemo() { demo = initSim(SEED ^ 0x5bd1e995); demoT = -1; dprevHx = demo.hx; dprevHy = demo.hy; }
  function startRun() {
    S = initSim(SEED); prevHx = S.hx; prevHy = S.hy; acc = 0; shownScore = 0; lastSec = -1; prevMult = 1; comboFlash = 0;
    resetFx();
    cam.x = S.hx / 16; cam.y = S.hy / 16; cam.zr = cam.vr = S.R16 / 16;
    mode = 'ready'; show('menu', false); show('over', false); show('how', false);
    var cd = $('cd');
    cd.textContent = 'READY'; cd.className = 'cd show'; SFX.ready();
    setTimeout(function () {
      cd.textContent = 'GO!'; cd.className = 'cd go'; void cd.offsetWidth; cd.className = 'cd go show'; SFX.go();
      mode = 'play'; acc = 0;
      setTimeout(function () { cd.className = 'cd'; }, 650);
    }, 1000);
  }
  var endInfo = null;
  function endRun(cleared) {
    mode = 'ending';
    endInfo = { cleared: cleared, t0: performance.now() };
    banners.push({ t0: performance.now(), a: cleared ? 'CITY CLEARED!' : 'TIME UP!', b: cleared ? '+' + S.bonus + ' BONUS' : '', dur: 1700, big: true });
    if (cleared) SFX.fanfare(); else SFX.gong();
    setTimeout(showOver, 1800);
  }
  function showOver() {
    mode = 'over';
    var s = S, isBest = s.score > best;
    if (isBest) { best = s.score; try { localStorage.setItem('bhookha_best', String(best)); } catch (_e) {} }
    $('overTitle').textContent = s.cleared ? 'CITY CLEARED!' : 'TIME UP!';
    $('stTier').textContent = TIER_NAMES[s.tier];
    $('stEaten').textContent = s.eaten + ' / ' + s.n;
    $('stCombo').textContent = 'x' + s.bestMult + '  (' + s.bestStreak + ' in a row)';
    $('stBig').textContent = s.biggest ? KIND_NAMES[biggestKind(s)] + '  +' + s.biggestPts : 'none';
    $('stBonus').textContent = s.cleared ? '+' + s.bonus : 'clear the city for a bonus';
    $('overBest').textContent = 'BEST ' + best;
    $('newBest').style.display = isBest && s.score > 0 ? '' : 'none';
    show('over', true);
    countUp($('overScore'), s.score, 1300, isBest && s.score > 0);
    $('menuBest').textContent = best ? 'BEST ' + best : '';
  }
  function biggestKind(s) {
    var k = 0, bp = -1;
    for (var i = 0; i < s.n; i++) if (!s.alive[i] && s.PR[i] > bp) { bp = s.PR[i]; k = s.PK[i]; }
    return k;
  }
  function countUp(el, to, ms, confettiOn) {
    var t0 = performance.now(), tickN = 0;
    function f(now) {
      var t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3), v = Math.round(to * e);
      el.textContent = v;
      if (((t * 14) | 0) > tickN && t < 1) { tickN = (t * 14) | 0; tone(500 + t * 700, 0, 0.04, 'triangle', 0.04); }
      if (t < 1) requestAnimationFrame(f);
      else { el.classList.add('land'); if (confettiOn) { confetti(); SFX.fanfare(); } }
    }
    el.classList.remove('land');
    requestAnimationFrame(f);
  }
  var conf = [];
  function confetti() {
    var cols = [C.red, C.yellow, C.blue, C.teal, C.pink, ACCENT, '#ffffff'];
    for (var i = 0; i < 160; i++) conf.push({ x: cw * (0.2 + Math.random() * 0.6), y: ch * 0.3, vx: (Math.random() - 0.5) * 520, vy: -200 - Math.random() * 520,
      r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14, w: 5 + Math.random() * 6, h: 3 + Math.random() * 4, col: cols[i % cols.length], life: 0 });
  }
  function drawConfetti(dt) {
    fx.setTransform(dpr, 0, 0, dpr, 0, 0); fx.clearRect(0, 0, cw, ch);
    for (var i = conf.length - 1; i >= 0; i--) {
      var p = conf[i]; p.life += dt; p.vy += 900 * dt; p.vx *= 0.99; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
      if (p.y > ch + 20 || p.life > 4) { conf.splice(i, 1); continue; }
      fx.save(); fx.translate(p.x, p.y); fx.rotate(p.r); fx.scale(1, Math.abs(Math.cos(p.r * 1.7)) + 0.15);
      fx.fillStyle = p.col; fx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); fx.restore();
    }
  }

  // ---------- drawing a frame ----------
  function fmtClock(steps) {
    var left = Math.max(0, RUN_STEPS - steps), sec = Math.ceil(left / 60), m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function viewW(r) { return 280 + 7 * r; }

  function drawWorldView(s, hx, hy, dt, live) {
    var targetR = s.R16 / 16;
    cam.vr += (targetR - cam.vr) * Math.min(1, dt * 9);
    cam.zr += (targetR - cam.zr) * Math.min(1, dt * 2.2);
    var vw = viewW(cam.zr), sc = cw / vw, vh = ch / sc;
    var lead = live ? 9 : 4;
    cam.x += (hx + s.vx / 16 * lead - cam.x) * Math.min(1, dt * 7);
    cam.y += (hy + s.vy / 16 * lead - cam.y) * Math.min(1, dt * 7);
    var m = 40, cx = cam.x, cy = cam.y;
    if (vw < WORLD + 2 * m) cx = clamp(cx, vw / 2 - m, WORLD - vw / 2 + m); else cx = WORLD / 2;
    if (vh < WORLD + 2 * m) cy = clamp(cy, vh / 2 - m, WORLD - vh / 2 + m); else cy = WORLD / 2;
    cam.shake *= Math.pow(0.0015, dt);
    var shx = (Math.random() - 0.5) * cam.shake * 2, shy = (Math.random() - 0.5) * cam.shake * 2;
    var ppu = sc * dpr;
    flushSprites(ppu); buildBudget = 14;
    ctx.setTransform(ppu, 0, 0, ppu, cv.width / 2 - cx * ppu + shx * dpr, cv.height / 2 - cy * ppu + shy * dpr);
    var x0 = cx - vw / 2 - 20, x1 = cx + vw / 2 + 20, y0 = cy - vh / 2 - 20, y1 = cy + vh / 2 + 20;
    drawGround(ctx, s, x0, y0, x1, y1);

    // spring on the rim
    pulse.v += (-160 * pulse.x - 11 * pulse.v) * dt; pulse.x += pulse.v * dt;
    glow = Math.max(0, glow - dt * 1.6);
    var R = cam.vr * (1 + pulse.x * 0.07);
    drawHole(ctx, hx, hy, R, 0.28 + glow * 0.7);

    // things falling in
    var now = performance.now();
    for (var i = falls.length - 1; i >= 0; i--) {
      var f = falls[i], t = (now - f.t0) / f.dur;
      if (t >= 1) { falls.splice(i, 1); continue; }
      if (t < 0) t = 0;
      var e = t * t * (3 - 2 * t), fx0 = hx + f.rx * (1 - e), fy0 = hy + f.ry * (1 - e);
      var scl = 1 - 0.9 * Math.pow(e, 1.3), clipR = R * (0.98 + 2.2 * Math.max(0, 0.45 - t));
      ctx.save(); ctx.beginPath(); ctx.arc(hx, hy, clipR, 0, Math.PI * 2); ctx.clip();
      ctx.translate(fx0, fy0); ctx.rotate(f.rot * Math.min(1, t * 2.4)); ctx.scale(scl, scl);
      ctx.globalAlpha = 1 - Math.pow(t, 2.2);
      drawSprite(ctx, f.k, f.pr, f.v, 0, 0, ppu * scl);
      ctx.globalAlpha = Math.min(0.85, t * 1.4); ctx.fillStyle = '#0c0618';
      ctx.beginPath(); ctx.arc(0, -f.pr * 0.4, f.pr * 1.7, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // props, back to front
    var vis = [];
    for (var j = 0; j < s.n; j++) {
      if (!s.alive[j]) continue;
      var px = s.PX[j] / 16, py = s.PY[j] / 16, pr = s.PR[j];
      if (px + pr * 1.8 < x0 || px - pr * 1.8 > x1 || py - pr * 1.5 > y1 || py + pr * 3.6 < y0) continue;
      vis.push(j);
    }
    vis.sort(function (a, b) { return s.PY[a] - s.PY[b]; });
    for (var q = 0; q < vis.length; q++) {
      var id = vis[q];
      drawSprite(ctx, s.PK[id], s.PR[id], s.PV[id], s.PX[id] / 16, s.PY[id] / 16, ppu);
    }

    // rings, particles
    for (var r = rings.length - 1; r >= 0; r--) {
      var rg = rings[r], rt = (now - rg.t0) / 700;
      if (rt >= 1) { rings.splice(r, 1); continue; }
      if (rt < 0) continue;
      ctx.strokeStyle = rgba(rg.col === '#ffffff' ? '#ffffff' : ACCENT, (1 - rt) * 0.9);
      ctx.lineWidth = R * 0.18 * (1 - rt) + 1;
      ctx.beginPath(); ctx.arc(hx, hy, R * (1 + rt * 1.8), 0, Math.PI * 2); ctx.stroke();
    }
    for (var k = parts.length - 1; k >= 0; k--) {
      var p = parts[k]; p.life += dt;
      if (p.life >= p.max) { parts.splice(k, 1); continue; }
      p.vx *= 0.94; p.vy = p.vy * 0.94 + 30 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      var a = 1 - p.life / p.max;
      ctx.globalAlpha = a; ctx.fillStyle = p.col;
      if (p.star) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.life * 6); ctx.fillRect(-p.r, -p.r * 0.3, p.r * 2, p.r * 0.6); ctx.fillRect(-p.r * 0.3, -p.r, p.r * 0.6, p.r * 2); ctx.restore(); }
      else { ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.5 + a * 0.5), 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    return { cx: cx, cy: cy, sc: sc, vw: vw, vh: vh, shx: shx, shy: shy };
  }

  function worldToScreen(v, x, y) { return [(x - v.cx) * v.sc + cw / 2 + v.shx, (y - v.cy) * v.sc + ch / 2 + v.shy]; }

  function text(c, str, x, y, size, fill, align, stroke) {
    c.font = size + 'px "Titan One", system-ui, sans-serif';
    c.textAlign = align || 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round';
    if (stroke !== false) { c.strokeStyle = 'rgba(40,20,80,0.55)'; c.lineWidth = size * 0.22; c.strokeText(str, x, y); }
    c.fillStyle = fill; c.fillText(str, x, y);
  }

  function drawOverlay(s, v, dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var now = performance.now();
    // +N pops
    for (var i = pops.length - 1; i >= 0; i--) {
      var p = pops[i], t = (now - p.t0) / 900;
      if (t >= 1) { pops.splice(i, 1); continue; }
      if (t < 0) continue;
      var sp = worldToScreen(v, p.x, p.y), k = t < 0.18 ? 0.4 + t / 0.18 * 0.9 : 1.3 - Math.min(0.3, (t - 0.18) * 1.2);
      ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
      var col = p.mult >= 4 ? '#ff6ba6' : p.mult >= 2 ? '#ffd23f' : '#ffffff';
      text(ctx, p.txt, sp[0], sp[1] - 30 * ui - t * 46 * ui - Math.min(4, p.lift || 0) * 22 * ui, (p.big ? 30 : 20) * ui * k, col);
    }
    ctx.globalAlpha = 1;
    if (mode === 'menu' || !s) return;
    var top = Math.max(14, safeTop) ;
    // score
    shownScore += (s.score - shownScore) * Math.min(1, dt * 10);
    if (Math.abs(s.score - shownScore) < 1) shownScore = s.score;
    text(ctx, 'SCORE', 18 * ui, top + 10 * ui, 12 * ui, 'rgba(255,255,255,0.9)', 'left');
    text(ctx, String(Math.round(shownScore)), 18 * ui, top + 36 * ui, 30 * ui, '#ffffff', 'left');
    // combo
    if (s.streak >= 2) {
      comboFlash = Math.max(0, comboFlash - dt * 2.5);
      var bx = 18 * ui, by = top + 62 * ui, w = 92 * ui, h = 24 * ui, ksc = 1 + comboFlash * 0.35;
      ctx.save(); ctx.translate(bx + w / 2, by + h / 2); ctx.scale(ksc, ksc); ctx.translate(-(bx + w / 2), -(by + h / 2));
      ctx.fillStyle = 'rgba(40,20,80,0.45)'; rr(ctx, bx, by, w, h, h / 2); ctx.fill();
      ctx.fillStyle = s.mult >= 4 ? '#ff6ba6' : '#ffc531'; rr(ctx, bx, by, w * s.comboT / COMBO_GAP, h, h / 2); ctx.fill();
      text(ctx, 'x' + s.mult + '  ' + s.streak, bx + w / 2, by + h / 2 + 1, 15 * ui, '#ffffff');
      ctx.restore();
    }
    // clock
    var secLeft = Math.ceil(Math.max(0, RUN_STEPS - s.steps) / 60);
    var hurry = secLeft <= 10 && mode === 'play';
    if (hurry && secLeft !== lastSec && s.steps > 0) { SFX.tick(secLeft <= 3); }
    lastSec = secLeft;
    var frac = ((RUN_STEPS - s.steps) % 60) / 60, kk = hurry ? 1 + 0.18 * frac * frac : 1;
    var cwid = 112 * ui, chh = 42 * ui, ccx = cw / 2;
    ctx.save(); ctx.translate(ccx, top + chh / 2 + 4 * ui); ctx.scale(kk, kk);
    ctx.fillStyle = hurry ? 'rgba(220,40,70,0.92)' : 'rgba(40,20,80,0.5)'; rr(ctx, -cwid / 2, -chh / 2, cwid, chh, chh / 2); ctx.fill();
    text(ctx, fmtClock(s.steps), 0, 2 * ui, 26 * ui, '#ffffff', 'center', false);
    ctx.restore();
    // size meter
    var t = s.tier, rNow = s.R16 / 16, lo = t === 0 ? 24 : TIER_R[t - 1], hi = t < TIER_R.length ? TIER_R[t] : lo;
    var pf = hi > lo ? clamp((rNow - lo) / (hi - lo), 0, 1) : 1;
    var mw = 170 * ui, mh = 14 * ui, mx = cw / 2 - mw / 2, my = ch - Math.max(18, safeBot) - 26 * ui;
    text(ctx, TIER_NAMES[t], cw / 2, my - 12 * ui, 14 * ui, '#ffffff');
    ctx.fillStyle = 'rgba(40,20,80,0.45)'; rr(ctx, mx, my, mw, mh, mh / 2); ctx.fill();
    ctx.fillStyle = ACCENT; rr(ctx, mx + 2, my + 2, Math.max(mh - 4, (mw - 4) * pf), mh - 4, (mh - 4) / 2); ctx.fill();
    // minimap
    var mm = 78 * ui, mx0 = cw - mm - 12 * ui, my0 = top + 58 * ui, k2 = mm / WORLD;
    ctx.fillStyle = 'rgba(40,20,80,0.4)'; rr(ctx, mx0 - 4, my0 - 4, mm + 8, mm + 8, 10 * ui); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(mx0, my0, mm, mm);
    for (var j = 0; j < s.n; j++) {
      if (!s.alive[j]) continue;
      var fit = propFits(s.R16, s.PR[j]), dsz = Math.max(1.4, s.PR[j] * k2 * 1.3);
      ctx.fillStyle = fit ? '#18a957' : 'rgba(70,50,120,0.45)';
      ctx.fillRect(mx0 + s.PX[j] / 16 * k2 - dsz / 2, my0 + s.PY[j] / 16 * k2 - dsz / 2, dsz, dsz);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(mx0, my0, mm, mm); ctx.clip();
    ctx.strokeStyle = 'rgba(60,40,110,0.7)'; ctx.lineWidth = 1;
    ctx.strokeRect(mx0 + (v.cx - v.vw / 2) * k2, my0 + (v.cy - v.vh / 2) * k2, v.vw * k2, v.vh * k2);
    ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(mx0 + s.hx / 16 * k2, my0 + s.hy / 16 * k2, Math.max(2.5, s.R16 / 16 * k2), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.restore();
    // stick
    if (stick.id !== null && mode === 'play') {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(stick.ox, stick.oy, STICK_R * ui, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.arc(stick.ox + stick.sx / STICK_MAX * STICK_R * ui, stick.oy + stick.sy / STICK_MAX * STICK_R * ui, 20 * ui, 0, Math.PI * 2); ctx.fill();
    }
    // banners
    for (var b = banners.length - 1; b >= 0; b--) {
      var bn = banners[b], bt = (now - bn.t0) / bn.dur;
      if (bt >= 1) { banners.splice(b, 1); continue; }
      var pop = bt < 0.15 ? bt / 0.15 : 1, spring = pop < 1 ? 0.3 + pop * 0.9 : 1.2 - Math.min(0.2, (bt - 0.15) * 2);
      ctx.globalAlpha = bt > 0.8 ? (1 - bt) / 0.2 : 1;
      var yb = ch * (bn.big ? 0.4 : 0.3);
      ctx.save(); ctx.translate(cw / 2, yb); ctx.scale(spring, spring);
      text(ctx, bn.a, 0, 0, (bn.big ? 46 : 34) * ui, bn.big ? '#ffd23f' : '#ffffff');
      if (bn.b) text(ctx, bn.b, 0, (bn.big ? 44 : 34) * ui, (bn.big ? 22 : 18) * ui, bn.big ? '#ffffff' : '#e8c6ff');
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  var safeTop = 0, safeBot = 0;
  function readSafe() {
    var cs = getComputedStyle(document.documentElement);
    safeTop = parseFloat(cs.getPropertyValue('--sat')) || 0; safeBot = parseFloat(cs.getPropertyValue('--sab')) || 0;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (last === null) last = now;
    var dtms = Math.min(250, now - last); last = now;
    var dt = dtms / 1000;
    if (mode === 'play') {
      acc += dtms;
      var n = 0;
      while (acc >= STEP_MS && n < 3) {
        prevHx = S.hx; prevHy = S.hy;
        var st = currentStick();
        stepSim(S, st[0], st[1]);
        onEvents(S, true);
        acc -= STEP_MS; n++;
        if (S.over) break;
      }
      if (acc > STEP_MS * 3) acc = STEP_MS * 3;
    } else if (mode === 'menu' || mode === 'how') {
      acc += dtms;
      var m2 = 0;
      while (acc >= STEP_MS && m2 < 3) {
        if (demo.over) newDemo();
        dprevHx = demo.hx; dprevHy = demo.hy;
        var ds = demoStick(demo);
        stepSim(demo, ds[0], ds[1]);
        onEvents(demo, false);
        acc -= STEP_MS; m2++;
      }
      if (acc > STEP_MS * 3) acc = STEP_MS * 3;
    }
    var s = (mode === 'menu' || mode === 'how') ? demo : S;
    var al = mode === 'play' ? acc / STEP_MS : 1;
    var px = s === demo ? dprevHx : prevHx, py = s === demo ? dprevHy : prevHy;
    var hx = (px + (s.hx - px) * al) / 16, hy = (py + (s.hy - py) * al) / 16;
    var v = drawWorldView(s, hx, hy, dt, s === S);
    drawOverlay(s === S ? S : null, v, dt);
    if (conf.length || fxDirty) { drawConfetti(dt); fxDirty = conf.length > 0; }
  }
  var fxDirty = false;

  // ---------- menu logo and how to play pictures ----------
  function drawLogo() {
    var lc = $('logo'), c = lc.getContext('2d'), W = lc.width, H = lc.height;
    c.clearRect(0, 0, W, H);
    var k = W / 640;
    c.save(); c.scale(k, k);
    function word(str, y, size, top, bot) {
      c.font = size + 'px "Titan One", system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
      c.strokeStyle = '#2a1150'; c.lineWidth = size * 0.26; c.strokeText(str, 320, y);
      var g = c.createLinearGradient(0, y - size / 2, 0, y + size / 2); g.addColorStop(0, top); g.addColorStop(1, bot);
      c.fillStyle = g; c.fillText(str, 320, y);
      c.fillStyle = 'rgba(255,255,255,0.35)'; c.save(); c.beginPath(); c.rect(0, y - size / 2, 640, size * 0.32); c.clip(); c.fillText(str, 320, y); c.restore();
    }
    word('BHOOKHA', 80, 104, '#ffe27a', '#ff8a30');
    word('GOLA', 196, 112, '#f4d4ff', '#b44dff');
    c.restore();
  }
  var howAnim = null;
  function drawHow(now) {
    var cvs = document.querySelectorAll('.howpic');
    for (var i = 0; i < cvs.length; i++) {
      var hc = cvs[i], c = hc.getContext('2d'), W = hc.width, H = hc.height, t = now / 1000;
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
      c.fillStyle = '#e4dbf7'; rr(c, 0, 0, W, H, 18); c.fill();
      c.save(); rr(c, 0, 0, W, H, 18); c.clip();
      c.fillStyle = 'rgba(70,60,110,0.07)';
      for (var g = 0; g < W; g += 24) c.fillRect(g, 0, 1.5, H);
      for (g = 0; g < H; g += 24) c.fillRect(0, g, W, 1.5);
      var k = H / 120;
      c.scale(k, k);
      var w = W / k;
      if (i === 0) {
        // drag anywhere: the hole follows the finger's drag, it never jumps
        var ph = (t % 3) / 3, ang = ph * Math.PI * 2;
        var hx = w * 0.32 + Math.cos(ang) * 26, hy = 62 + Math.sin(ang) * 18;
        drawHole(c, hx, hy, 22, 0.4);
        var fx0 = w * 0.74, fy0 = 64;
        c.strokeStyle = 'rgba(80,50,140,0.35)'; c.lineWidth = 2.5; c.beginPath(); c.arc(fx0, fy0, 26, 0, Math.PI * 2); c.stroke();
        var tx = fx0 + Math.cos(ang) * 18, ty = fy0 + Math.sin(ang) * 18;
        c.fillStyle = 'rgba(80,50,140,0.5)'; c.beginPath(); c.arc(tx, ty, 11, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#fff'; c.beginPath(); c.arc(tx, ty, 5, 0, Math.PI * 2); c.fill();
      } else if (i === 1) {
        // small things fall in, big ones block
        var p = (t % 2) / 2;
        drawHole(c, w * 0.3, 70, 26, 0.5);
        if (p < 0.75) {
          var e = Math.min(1, p / 0.75), x = w * 0.3 - 30 * (1 - e) + 0, sc = 1 - 0.85 * e * e;
          c.save(); c.beginPath(); c.arc(w * 0.3, 70, 26 + 40 * Math.max(0, 0.4 - e), 0, Math.PI * 2); c.clip();
          c.translate(x, 70 - 4 * e); c.rotate(-0.8 * e); c.scale(sc, sc); drawKind(c, 4, 14, 0); c.restore();
        } else {
          c.font = '18px "Titan One"'; c.fillStyle = '#ffffff'; c.strokeStyle = '#4a2a78'; c.lineWidth = 4; c.textAlign = 'center';
          c.strokeText('+5', w * 0.3, 30); c.fillText('+5', w * 0.3, 30);
        }
        c.save(); c.translate(w * 0.76, 92); drawKind(c, 15, 26, 1); c.restore();
        c.font = '13px "Titan One"'; c.fillStyle = '#d93a5e'; c.textAlign = 'center'; c.fillText('TOO BIG', w * 0.76, 16);
      } else {
        // chain quick swallows for a multiplier, grow, beat the clock
        var q = (t % 2.4) / 2.4, n = Math.min(4, Math.floor(q * 5));
        var R = 18 + n * 4;
        drawHole(c, w * 0.32, 66, R, 0.3 + n * 0.15);
        c.font = (16 + n * 3) + 'px "Titan One"'; c.textAlign = 'center'; c.lineWidth = 4; c.strokeStyle = '#4a2a78';
        c.fillStyle = n >= 3 ? '#ff6ba6' : '#ffc531';
        var label = 'x' + Math.max(1, n);
        c.strokeText(label, w * 0.32, 22); c.fillText(label, w * 0.32, 22);
        c.fillStyle = 'rgba(40,20,80,0.55)'; rr(c, w * 0.6, 48, 64, 30, 15); c.fill();
        c.font = '17px "Titan One"'; c.fillStyle = q > 0.8 ? '#ff4d6d' : '#fff'; c.fillText(q > 0.8 ? '00:00' : '01:59', w * 0.6 + 32, 69);
      }
      c.restore();
    }
    if (mode === 'how') howAnim = requestAnimationFrame(drawHow);
  }

  // ---------- buttons ----------
  function setMute(m) {
    muted = m;
    try { localStorage.setItem('bhookha_muted', m ? '1' : '0'); } catch (_e) {}
    if (master) master.gain.value = m ? 0 : 0.8;
    $('mute').classList.toggle('off', m);
  }
  $('mute').addEventListener('click', function () { setMute(!muted); if (!muted) SFX.click(); });
  $('playBtn').addEventListener('click', function () {
    SFX.click();
    var seen = false; try { seen = localStorage.getItem('bhookha_how') === '1'; } catch (_e) {}
    if (!seen) openHow(true); else startRun();
  });
  function openHow(thenPlay) {
    mode = 'how'; show('menu', false); show('how', true);
    $('howGo').textContent = thenPlay ? 'PLAY' : 'GOT IT';
    $('howGo').dataset.play = thenPlay ? '1' : '';
    cancelAnimationFrame(howAnim); howAnim = requestAnimationFrame(drawHow);
  }
  $('howBtn').addEventListener('click', function () { SFX.click(); openHow(false); });
  $('howGo').addEventListener('click', function () {
    SFX.click();
    try { localStorage.setItem('bhookha_how', '1'); } catch (_e) {}
    cancelAnimationFrame(howAnim);
    show('how', false);
    if ($('howGo').dataset.play) startRun(); else { mode = 'menu'; show('menu', true); }
  });
  $('againBtn').addEventListener('click', function () { SFX.click(); conf = []; fxDirty = true; startRun(); });
  $('homeBtn').addEventListener('click', function () {
    SFX.click(); conf = []; fxDirty = true; show('over', false); resetFx(); newDemo(); mode = 'menu'; show('menu', true);
  });

  // ---------- boot ----------
  resize(); readSafe(); buildHole(); buildTile(); setMute(muted); newDemo();
  cam.x = demo.hx / 16; cam.y = demo.hy / 16;
  $('menuBest').textContent = best ? 'BEST ' + best : '';
  drawLogo();
  if (document.fonts && document.fonts.load) document.fonts.load('40px "Titan One"').then(drawLogo, function () {});
  document.addEventListener('visibilitychange', function () { last = null; });
  requestAnimationFrame(frame);
  if (params.get('auto') === '1') window.__bgAuto = { get: function () { return S; }, start: startRun, stickFn: demoStick, setStick: function (x, y) { stick.id = -7; stick.sx = x; stick.sy = y; }, mode: function () { return mode; } };
})();
