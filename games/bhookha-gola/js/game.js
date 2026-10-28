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
var RUN_STEPS = 5400;           // 90 seconds at 60 steps a second
var WORLD = 1580;
var BLOCKS = 3;                 // 3 x 3 city blocks split by roads
var BLOCK = 460;
var ROAD = 90;
var MARGIN = 10;
var PAD = 20;                   // sidewalk inside a block
var QUAD = 210;                 // a block is four quadrants, each one cluster
var START_AREA = 576;           // radius 24
var STICK_MAX = 64;             // stick components are integers within this
var STICK_DEAD = 10;
var STICK_FULL = 40;            // a stick this long is full speed
var SPD_BASE = 40;              // 1/16 units a step at the smallest size
var SPD_DIV = 40;               // plus R16 / SPD_DIV
var ACCEL_DIV = 6;              // velocity closes 1/6 of the gap each step
var FIT_PCT = 84;               // a prop fits when (pr)^2 * 100 <= R^2 * FIT_PCT
var CAP_PCT = 90;               // and falls in when its centre is within this of R^2
var REACH_PCT = 40;             // a prop that does not fit is touched at pr + 40% of R
var HEAVY_PR = 60;              // props this big never move, the hole is pushed out
var GROW_NUM = 1;               // the hole grows by pr^2 * 1 / 5
var GROW_DEN = 5;
var PTS_DIV = 40;               // a prop is worth pr^2 / 40 points
var COMBO_GAP = 48;             // steps a streak survives without a swallow
var CLEAR_BONUS = 1000;
var CLEAR_PER_SEC = 100;
var HUNGER_GRACE = 90;          // steps after a swallow before the hole starts to shrink
var HUNGER_PER = 12;            // then it loses M * HUNGER_PER / 10000 of its area a step
var STARVE_AREA = 346;          // shrinking below this ends the run (radius about 18.6)
var TIER_R = [30, 42, 58, 80, 110, 150];
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
  [5, 96, 108], [5, 100, 115], [5, 98, 112]
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
  var PX = [], PY = [], PR = [], PK = [], PV = [], QK = [];
  function put(cx, cy, pr, kind, variant) {
    PX.push(cx * 16); PY.push(cy * 16); PR.push(pr); PK.push(kind); PV.push(variant);
  }
  for (var bj = 0; bj < BLOCKS; bj++) {
    for (var bi = 0; bi < BLOCKS; bi++) {
      var id = bj * BLOCKS + bi;
      var ring = Math.max(Math.abs(bi - 1), Math.abs(bj - 1));
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
        QK.push(-1, -1, -1, -1);
        continue;
      }
      for (var q = 0; q < 4; q++) {
        var qid = id * 4 + q;
        var lq;
        // the centre is small things; each side block holds one cluster of every size
        if (ring === 0) lq = q < 2 ? 0 : 1;
        else lq = 1 + (q + hash(seed, id, 6)) % 4;
        var list = kindsOfLevel(lq);
        var kind = list[hash(seed, qid, 8) % list.length];
        var vq = hash(seed, qid, 9) % 4;
        QK.push(kind);
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
  return { PX: PX, PY: PY, PR: PR, PK: PK, PV: PV, QK: QK };
}

function initSim(seed) {
  var w = buildWorld(seed >>> 0);
  var n = w.PR.length;
  var alive = [], PT = [];
  for (var i = 0; i < n; i++) { alive.push(1); PT.push(Math.max(1, Math.floor(w.PR[i] * w.PR[i] / PTS_DIV))); }
  return {
    seed: seed >>> 0, n: n, QK: w.QK, PX: w.PX, PY: w.PY, PR: w.PR, PK: w.PK, PV: w.PV, PT: PT, alive: alive, left: n,
    hx: WORLD * 8, hy: WORLD * 8, vx: 0, vy: 0,
    M: START_AREA, R16: radius16(START_AREA), tier: 0,
    steps: 0, score: 0, streak: 0, comboT: 0, mult: 1,
    hungerT: 0, drain: 0, starved: false,
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
  // a hungry hole shrinks when it has not eaten for a while
  if (grew > 0) s.hungerT = 0; else s.hungerT++;
  s.drain = 0;
  if (s.hungerT > HUNGER_GRACE) {
    s.drain = Math.max(1, Math.floor(s.M * HUNGER_PER / 10000));
    s.M -= s.drain;
    s.R16 = radius16(s.M);
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
  } else if (s.M < STARVE_AREA) {
    s.starved = true;
    s.over = true;
    s.ev.push({ t: 'starve' });
  } else if (s.steps >= RUN_STEPS) {
    s.over = true;
    s.ev.push({ t: 'time' });
  }
}
// ==== BHOOKHA GOLA RULES END ====

  // ================= PRESENTATION (reads the sim, never writes it) =================
  var STEP_MS = 1000 / 60;
  var DESIGN_W = 414;
  var LIFT = 0.82;               // a prop's height on screen, per unit of height
  var DEP = 0.8;                 // plan depth squash for props (the camera is tilted)
  var SK = 0.2;                  // tops lean left by this much of their lift: the right side shows
  var ACCENT = '#b44dff';
  var KIND_NAMES = ['cone', 'matka', 'parcel', 'barrel', 'crate', 'charpai', 'sapling', 'pillar', 'tree',
    'crate stack', 'chai stall', 'dome', 'toy block', 'big tree', 'container', 'house', 'water tower', 'hall',
    'tower', 'stadium', 'skyscraper'];
  var TIER_NAMES = ['CHHOTA GOLA', 'GOLA', 'BARA GOLA', 'MOTA GOLA', 'BHOOKHA GOLA', 'KHATARNAK', 'DAANAV', 'QAYAMAT'];
  var C = { red: '#ff5a5f', blue: '#3d8bfd', yellow: '#ffc531', teal: '#17c3b2', orange: '#ff8a30',
    purple: '#9b5de5', pink: '#ff6ba6', green: '#4cc66d', wood: '#d9a066', stone: '#8f7dff', navy: '#4a4e9a', mint: '#7fd8be',
    clay: '#cf6e3e', cream: '#f1dfb8', leaf: '#3fb86a' };
  var TRUCK = ['#ff3d6e', '#ffc531', '#17c3b2', '#3d8bfd', '#ff8a30', '#9b5de5'];
  var PAL = [
    [C.orange, C.yellow, C.pink, C.green],          // cone
    [C.clay, '#3b7fd1', C.cream, '#b44a2f'],        // matka
    [C.wood, C.yellow, C.blue, C.pink],             // parcel
    [C.red, C.blue, C.yellow, C.teal],              // barrel
    [C.wood, '#c98b55', C.teal, C.red],             // crate
    [C.teal, C.pink, C.orange, C.blue],             // charpai (rope colour)
    [C.leaf, C.pink, C.yellow, C.mint],             // sapling
    [C.stone, '#ff9d5c', '#5cc8ff', '#ff6fb5'],     // pillar
    [C.leaf, '#36b37e', C.pink, C.yellow],          // tree
    [C.wood, '#c98b55', C.wood, '#e0b07a'],         // crate stack
    [C.red, C.blue, C.purple, C.teal],              // chai stall
    [C.blue, C.purple, C.teal, C.pink],             // dome
    [C.red, C.yellow, C.blue, C.green],             // toy block
    [C.leaf, '#36b37e', C.mint, C.pink],            // big tree
    [C.orange, C.blue, C.red, C.teal],              // container
    ['#ffb347', '#ff6fb5', '#3de0c0', '#ff8a5c'],   // house plaster
    [C.stone, C.teal, C.yellow, C.blue],            // water tower
    [C.purple, C.teal, C.red, C.blue],              // hall
    [C.blue, C.purple, C.teal, C.navy],             // tower
    [C.pink, C.teal, C.yellow, C.purple],           // stadium
    [C.navy, C.blue, C.purple, C.teal]              // skyscraper
  ];
  // how far above its footprint a sprite reaches, in units of pr
  var UP = [1.9, 1.9, 1.7, 1.9, 1.9, 1.3, 2.7, 2.9, 3.0, 2.3, 2.3, 2.2, 2.0, 3.1, 1.5, 2.7, 3.2, 2.4, 3.9, 2.2, 4.0];
  // night ground: [fill, pattern line, neon edge]
  var THEME = { park: ['#10302b', '#164237', '#2fffb0'], bazaar: ['#2e1830', '#40223f', '#ff5fa2'], yard: ['#1c1d36', '#282a4a', '#ffb13d'],
    plaza: ['#1d1842', '#2a2358', '#9b7bff'], home: ['#11263f', '#183453', '#3dd8ff'], land: ['#26113a', '#36185a', '#ff4dd2'] };
  var KIND_THEME = ['bazaar', 'bazaar', 'bazaar', 'yard', 'yard', 'park', 'park', 'plaza', 'park', 'yard', 'bazaar',
    'plaza', 'plaza', 'park', 'yard', 'home', 'home', 'plaza', 'land', 'land', 'land'];

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
  function poly(c, pts) { c.beginPath(); c.moveTo(pts[0], pts[1]); for (var i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); c.closePath(); }

  // ---------- prop art: solids in a tilted 3/4 view, sun from the upper left ----------
  // ---------- neon night look: dark bodies, glowing edges, lit windows ----------
  function neon(col) { return shade(col, 0.28); }
  function glowStroke(c, col, lw) {        // a lit edge: wide soft pass, then a bright core
    c.save(); c.shadowColor = col; c.shadowBlur = lw * 5; c.strokeStyle = col; c.lineWidth = lw; c.stroke();
    c.shadowBlur = 0; c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = lw * 0.35; c.stroke(); c.restore();
  }
  function shadowBlob(c, p, k, col) {        // a pool of coloured light under the prop
    c.save(); c.translate(p * 0.1, p * 0.15); c.scale(1, 0.6);
    var g = c.createRadialGradient(0, 0, 0, 0, 0, p * 1.35 * k);
    g.addColorStop(0, rgba(col, 0.42)); g.addColorStop(0.5, rgba(col, 0.14)); g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, p * 1.35 * k, 0, Math.PI * 2); c.fill(); c.restore();
  }
  function box(c, cx, cy, w, d, h, col) {
    var d2 = d * DEP, L = h * LIFT, o = -L * SK, n = neon(col);
    var x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - d2 / 2, y1 = cy + d2 / 2;
    c.fillStyle = shade(col, -0.82);
    poly(c, [x1, y1, x1, y0, x1 + o, y0 - L, x1 + o, y1 - L]); c.fill();
    var g = c.createLinearGradient(0, y1 - L, 0, y1);
    g.addColorStop(0, shade(col, -0.62)); g.addColorStop(1, shade(col, -0.78));
    c.fillStyle = g; poly(c, [x0, y1, x1, y1, x1 + o, y1 - L, x0 + o, y1 - L]); c.fill();
    var gt = c.createLinearGradient(x0 + o, y0 - L, x1 + o, y1 - L);
    gt.addColorStop(0, shade(col, -0.35)); gt.addColorStop(1, shade(col, -0.52));
    c.fillStyle = gt; poly(c, [x0 + o, y0 - L, x1 + o, y0 - L, x1 + o, y1 - L, x0 + o, y1 - L]); c.fill();
    var lw = Math.max(0.6, Math.min(w, d2 + L) * 0.045);
    c.lineJoin = 'round'; c.lineCap = 'round';
    poly(c, [x0 + o, y0 - L, x1 + o, y0 - L, x1 + o, y1 - L, x0 + o, y1 - L]); glowStroke(c, n, lw);
    c.beginPath(); c.moveTo(x0 + o, y1 - L); c.lineTo(x0, y1); c.lineTo(x1, y1); c.lineTo(x1 + o, y1 - L);
    c.moveTo(x1, y1); c.lineTo(x1, y0); c.lineTo(x1 + o, y0 - L); glowStroke(c, shade(col, 0.05), lw * 0.7);
    return { tx: cx + o, ty: cy - L, fy: y1 - L, by: y1, x0: x0, x1: x1, o: o, L: L, d2: d2 };
  }
  function frontWin(c, b, cols, rows, col, frame) {
    var w = b.x1 - b.x0;
    c.save(); c.shadowColor = '#ffcf6b'; c.shadowBlur = w * 0.08;
    for (var j = 0; j < rows; j++) for (var i = 0; i < cols; i++) {
      var t0 = (j + 0.25) / rows, t1 = (j + 0.78) / rows, u0 = (i + 0.22) / cols, u1 = (i + 0.78) / cols;
      var pts = [b.x0 + w * u0 + b.o * t0, b.by - b.L * t0, b.x0 + w * u1 + b.o * t0, b.by - b.L * t0,
        b.x0 + w * u1 + b.o * t1, b.by - b.L * t1, b.x0 + w * u0 + b.o * t1, b.by - b.L * t1];
      var lit = ((i * 7 + j * 3 + cols) % 5) !== 0;
      c.fillStyle = lit ? (((i + j) % 3) ? '#ffe39a' : '#9fe8ff') : '#2a2550';
      poly(c, pts); c.fill();
    }
    c.restore();
  }
  function cyl(c, cx, cy, r, h, col) {
    var L = h * LIFT, ry = r * 0.62 * DEP, o = -L * SK, n = neon(col);
    var g = c.createLinearGradient(cx - r, 0, cx + r, 0);
    g.addColorStop(0, shade(col, -0.6)); g.addColorStop(0.3, shade(col, -0.45)); g.addColorStop(0.75, shade(col, -0.7)); g.addColorStop(1, shade(col, -0.85));
    c.fillStyle = g; c.beginPath(); c.moveTo(cx - r, cy);
    c.ellipse(cx, cy, r, ry, 0, Math.PI, 0, true); c.lineTo(cx + o + r, cy - L); c.lineTo(cx + o - r, cy - L); c.closePath(); c.fill();
    c.fillStyle = shade(col, -0.4); c.beginPath(); c.ellipse(cx + o, cy - L, r, ry, 0, 0, Math.PI * 2); c.fill();
    var lw = Math.max(0.6, r * 0.09);
    c.beginPath(); c.ellipse(cx + o, cy - L, r, ry, 0, 0, Math.PI * 2); glowStroke(c, n, lw);
    c.beginPath(); c.ellipse(cx, cy, r, ry, 0, 0.1, Math.PI - 0.1); glowStroke(c, shade(col, 0.05), lw * 0.7);
    return { tx: cx + o, ty: cy - L, L: L, ry: ry, o: o, r: r, cx: cx, cy: cy };
  }
  function hoop(c, b, t, col, lw) {
    c.beginPath(); c.ellipse(b.cx + b.o * t, b.cy - b.L * t, b.r * 1.01, b.ry, 0, 0.05, Math.PI - 0.05); glowStroke(c, neon(col), lw * 0.6);
  }
  function sphere(c, cx, cy, r, col) {
    var g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r * 1.05);
    g.addColorStop(0, shade(col, -0.1)); g.addColorStop(0.55, shade(col, -0.55)); g.addColorStop(1, shade(col, -0.8));
    c.fillStyle = g; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25); glowStroke(c, neon(col), Math.max(0.6, r * 0.09));
    c.fillStyle = 'rgba(255,255,255,0.55)'; c.beginPath(); c.ellipse(cx - r * 0.4, cy - r * 0.45, r * 0.18, r * 0.1, -0.6, 0, Math.PI * 2); c.fill();
  }
  function dome(c, cx, cy, r, col) {
    var ry = r * 0.62 * DEP;
    var g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.7, r * 0.1, cx, cy - r * 0.2, r * 1.25);
    g.addColorStop(0, shade(col, -0.15)); g.addColorStop(0.55, shade(col, -0.55)); g.addColorStop(1, shade(col, -0.82));
    c.fillStyle = g; c.beginPath(); c.ellipse(cx, cy, r, ry, 0, 0, Math.PI); c.ellipse(cx, cy, r, r * 1.0, 0, Math.PI, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(cx, cy, r, r * 1.0, 0, Math.PI, Math.PI * 2); glowStroke(c, neon(col), Math.max(0.6, r * 0.07));
    c.beginPath(); c.ellipse(cx, cy, r, ry, 0, 0.05, Math.PI - 0.05); glowStroke(c, shade(col, 0.05), Math.max(0.5, r * 0.05));
  }
  function crown(c, x, y, r, col) {             // a lollipop tree top: three lumps
    sphere(c, x - r * 0.42, y + r * 0.12, r * 0.68, shade(col, -0.14));
    sphere(c, x + r * 0.4, y + r * 0.16, r * 0.62, shade(col, -0.06));
    sphere(c, x, y - r * 0.1, r * 0.8, col);
  }
  function scallops(c, x0, x1, y, n, r, cols) { // truck art trim
    var w = (x1 - x0) / n;
    for (var i = 0; i < n; i++) {
      c.fillStyle = cols[i % cols.length];
      c.beginPath(); c.moveTo(x0 + i * w, y); c.arc(x0 + i * w + w / 2, y, w / 2, Math.PI, 0, true); c.closePath(); c.fill();
    }
  }
  var WIN = '#ffe39a', WIN_DARK = '#ffe39a';

  function drawKind(c, k, p, v) {
    var col = PAL[k][v & 3], b, t, u, i;
    shadowBlob(c, p, k >= 15 ? 1.1 : 0.95, col);
    switch (k) {
      case 0: { // traffic cone
        box(c, 0, p * 0.15, p * 1.5, p * 1.5, p * 0.18, shade(col, -0.3));
        var L = p * 1.6 * LIFT, ax = -L * SK;
        var gc = c.createLinearGradient(-p * 0.6, 0, p * 0.6, 0);
        gc.addColorStop(0, shade(col, -0.15)); gc.addColorStop(0.35, shade(col, 0.3)); gc.addColorStop(1, shade(col, -0.4));
        c.fillStyle = gc; c.beginPath(); c.moveTo(-p * 0.62, p * 0.05); c.lineTo(p * 0.62, p * 0.05); c.lineTo(ax + p * 0.12, -L);
        c.quadraticCurveTo(ax, -L - p * 0.12, ax - p * 0.12, -L); c.closePath(); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.95)';
        for (i = 0; i < 2; i++) {
          var f0 = 0.3 + i * 0.32, f1 = f0 + 0.14, w0 = 0.62 * (1 - f0) + 0.1, w1 = 0.62 * (1 - f1) + 0.1;
          poly(c, [ax * f0 - p * w0, p * 0.05 - (L + p * 0.05) * f0, ax * f0 + p * w0, p * 0.05 - (L + p * 0.05) * f0,
            ax * f1 + p * w1, p * 0.05 - (L + p * 0.05) * f1, ax * f1 - p * w1, p * 0.05 - (L + p * 0.05) * f1]); c.fill();
        }
        break;
      }
      case 1: { // matka: a clay pot with a painted band
        var my = -p * 0.55, mr = p * 0.82;
        var gm = c.createRadialGradient(-p * 0.35, my - p * 0.35, p * 0.1, 0, my, mr * 1.1);
        gm.addColorStop(0, shade(col, 0.4)); gm.addColorStop(0.5, col); gm.addColorStop(1, shade(col, -0.45));
        c.fillStyle = gm; c.beginPath(); c.ellipse(0, my, mr, mr * 0.9, 0, 0, Math.PI * 2); c.fill();
        c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = p * 0.07;
        c.beginPath(); c.ellipse(0, my - p * 0.05, mr * 0.98, mr * 0.3, 0, 0.15, Math.PI - 0.15); c.stroke();
        c.fillStyle = 'rgba(255,255,255,0.85)';
        for (i = -2; i <= 2; i++) { c.beginPath(); c.arc(i * p * 0.3, my + p * 0.3 - Math.abs(i) * p * 0.04, p * 0.06, 0, Math.PI * 2); c.fill(); }
        b = cyl(c, -p * 0.05, my - mr * 0.72, p * 0.36, p * 0.25, shade(col, -0.05));
        c.fillStyle = '#3a1c10'; c.beginPath(); c.ellipse(b.tx, b.ty, p * 0.26, b.ry * 0.7, 0, 0, Math.PI * 2); c.fill();
        break;
      }
      case 2: // parcel with tape
        b = box(c, 0, p * 0.2, p * 1.35, p * 1.35, p * 1.2, col);
        c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = p * 0.22;
        c.beginPath(); c.moveTo(b.tx, b.ty - b.d2 / 2); c.lineTo(b.tx, b.fy); c.lineTo(0, b.by); c.stroke();
        break;
      case 3: // barrel with hoops
        b = cyl(c, 0, p * 0.2, p * 0.8, p * 1.45, col);
        hoop(c, b, 0.22, shade(col, -0.4), p * 0.09); hoop(c, b, 0.72, shade(col, -0.4), p * 0.09);
        c.fillStyle = shade(col, -0.1); c.beginPath(); c.ellipse(b.tx, b.ty, p * 0.58, b.ry * 0.7, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = shade(col, -0.45); c.beginPath(); c.ellipse(b.tx + p * 0.3, b.ty, p * 0.11, p * 0.07, 0, 0, Math.PI * 2); c.fill();
        break;
      case 4: // crate with braces
        b = box(c, 0, p * 0.2, p * 1.42, p * 1.42, p * 1.35, col);
        c.strokeStyle = shade(col, -0.45); c.lineWidth = p * 0.09; c.lineJoin = 'round';
        poly(c, [b.x0 + p * 0.08, b.by - p * 0.05, b.x1 - p * 0.08, b.by - p * 0.05, b.x1 + b.o - p * 0.08, b.fy + p * 0.06, b.x0 + b.o + p * 0.08, b.fy + p * 0.06]); c.stroke();
        c.beginPath(); c.moveTo(b.x0 + p * 0.08, b.by - p * 0.05); c.lineTo(b.x1 + b.o - p * 0.08, b.fy + p * 0.06); c.stroke();
        c.strokeStyle = shade(col, -0.2); c.lineWidth = p * 0.07;
        poly(c, [b.x0 + b.o + p * 0.12, b.ty - b.d2 / 2 + p * 0.1, b.x1 + b.o - p * 0.12, b.ty - b.d2 / 2 + p * 0.1, b.x1 + b.o - p * 0.12, b.fy - p * 0.08, b.x0 + b.o + p * 0.12, b.fy - p * 0.08]); c.stroke();
        break;
      case 5: { // charpai: a woven cot on four legs
        var lh = p * 0.42 * LIFT, lo = -lh * SK;
        var legs = [[-0.85, 0.5], [0.85, 0.5], [-0.85, -0.4], [0.85, -0.4]];
        for (i = 2; i < 4; i++) box(c, legs[i][0] * p, legs[i][1] * p, p * 0.16, p * 0.16, p * 0.42, '#8a5a34');
        for (i = 0; i < 2; i++) box(c, legs[i][0] * p, legs[i][1] * p, p * 0.16, p * 0.16, p * 0.42, '#8a5a34');
        b = box(c, lo, p * 0.05 - lh, p * 1.95, p * 1.25, p * 0.14, '#b9824d');
        var ix0 = b.x0 + b.o + p * 0.1, ix1 = b.x1 + b.o - p * 0.1, iy0 = b.ty - b.d2 / 2 + p * 0.08, iy1 = b.fy - p * 0.08;
        c.fillStyle = C.cream; c.fillRect(ix0, iy0, ix1 - ix0, iy1 - iy0);
        c.save(); c.beginPath(); c.rect(ix0, iy0, ix1 - ix0, iy1 - iy0); c.clip();
        c.lineWidth = p * 0.07;
        for (i = -12; i < 12; i++) {
          c.strokeStyle = i % 3 === 0 ? col : 'rgba(150,100,60,0.55)';
          c.beginPath(); c.moveTo(ix0 + i * p * 0.17, iy0); c.lineTo(ix0 + i * p * 0.17 + (iy1 - iy0), iy1); c.stroke();
          c.beginPath(); c.moveTo(ix0 + i * p * 0.17, iy1); c.lineTo(ix0 + i * p * 0.17 + (iy1 - iy0), iy0); c.stroke();
        }
        c.restore();
        break;
      }
      case 6: // sapling
        b = cyl(c, 0, p * 0.15, p * 0.16, p * 1.0, '#9a6a45');
        crown(c, b.tx, b.ty - p * 0.5, p * 0.72, col);
        break;
      case 7: // pillar with a painted band
        box(c, 0, p * 0.2, p * 1.35, p * 1.35, p * 0.22, shade(col, -0.12));
        b = cyl(c, -p * 0.04, p * 0.12, p * 0.55, p * 2.0, col);
        for (i = 0; i < 6; i++) {
          c.strokeStyle = TRUCK[(i + v) % TRUCK.length]; c.lineWidth = p * 0.16;
          c.beginPath(); c.ellipse(b.cx + b.o * 0.6, b.cy - b.L * 0.6, b.r, b.ry, 0, i * Math.PI / 6, (i + 1) * Math.PI / 6); c.stroke();
        }
        u = cyl(c, b.tx, b.ty + p * 0.05, p * 0.78, p * 0.28, shade(col, -0.05));
        sphere(c, u.tx, u.ty - p * 0.12, p * 0.14, C.yellow);
        break;
      case 8: // tree
        b = cyl(c, 0, p * 0.15, p * 0.2, p * 1.2, '#9a6a45');
        crown(c, b.tx, b.ty - p * 0.55, p * 0.85, col);
        break;
      case 9: // crate stack
        box(c, -p * 0.46, -p * 0.2, p * 0.88, p * 0.88, p * 0.85, shade(col, -0.05));
        box(c, p * 0.46, -p * 0.2, p * 0.88, p * 0.88, p * 0.85, col);
        b = box(c, 0, p * 0.5, p * 0.88, p * 0.88, p * 0.85, shade(col, 0.05));
        t = box(c, -p * 0.15, -p * 0.2 - p * 0.85 * LIFT, p * 0.85, p * 0.85, p * 0.8, shade(col, 0.1));
        break;
      case 10: { // chai stall with a truck art awning and a kettle
        b = box(c, 0, p * 0.25, p * 1.55, p * 1.15, p * 1.1, col);
        c.fillStyle = C.cream;
        poly(c, [b.x0 + p * 0.1, b.by - p * 0.08, b.x1 - p * 0.1, b.by - p * 0.08, b.x1 - p * 0.1 + b.o * 0.45, b.by - b.L * 0.45, b.x0 + p * 0.1 + b.o * 0.45, b.by - b.L * 0.45]); c.fill();
        var aw0 = b.fy - p * 0.04, ax0 = b.x0 + b.o - p * 0.08, ax1 = b.x1 + b.o + p * 0.08;
        c.fillStyle = shade(col, -0.2); poly(c, [ax0, aw0, ax1, aw0, ax1 + p * 0.06, aw0 + p * 0.22, ax0 + p * 0.06, aw0 + p * 0.22]); c.fill();
        for (i = 0; i < 7; i++) { c.fillStyle = TRUCK[(i + v) % TRUCK.length]; c.fillRect(ax0 + p * 0.06 + i * (ax1 - ax0) / 7, aw0 + p * 0.02, (ax1 - ax0) / 7, p * 0.18); }
        scallops(c, ax0 + p * 0.06, ax1 + p * 0.06, aw0 + p * 0.2, 7, 0, ['#ffffff', C.yellow]);
        sphere(c, b.tx + p * 0.25, b.ty - p * 0.15, p * 0.2, '#d8dde8');
        c.strokeStyle = '#9aa1b5'; c.lineWidth = p * 0.06; c.beginPath(); c.moveTo(b.tx + p * 0.42, b.ty - p * 0.18); c.lineTo(b.tx + p * 0.6, b.ty - p * 0.32); c.stroke();
        box(c, b.tx - p * 0.35, b.ty + p * 0.05, p * 0.12, p * 0.12, p * 0.18, '#ffffff');
        box(c, b.tx - p * 0.12, b.ty + p * 0.05, p * 0.12, p * 0.12, p * 0.18, '#ffffff');
        break;
      }
      case 11: // dome on a drum
        b = cyl(c, 0, p * 0.25, p * 0.95, p * 0.36, C.stone);
        for (i = 0; i < 8; i++) { c.fillStyle = 'rgba(80,90,150,0.35)'; c.fillRect(-p * 0.85 + i * p * 0.23, p * 0.25 - b.L * 0.75, p * 0.1, b.L * 0.5); }
        dome(c, b.tx, b.ty, p * 0.86, col);
        sphere(c, b.tx - p * 0.05, b.ty - p * 0.92, p * 0.1, C.yellow);
        break;
      case 12: // toy block
        b = box(c, 0, p * 0.2, p * 1.38, p * 1.38, p * 1.25, col);
        for (var sy = 0; sy < 2; sy++) for (var sx = 0; sx < 2; sx++) {
          cyl(c, b.tx + (sx - 0.5) * p * 0.64, b.ty + (sy - 0.5) * b.d2 * 0.5, p * 0.2, p * 0.2, shade(col, 0.06));
        }
        break;
      case 13: // big tree
        b = cyl(c, 0, p * 0.25, p * 0.22, p * 1.3, '#9a6a45');
        crown(c, b.tx, b.ty - p * 0.55, p * 0.95, col);
        break;
      case 14: // container with truck art stripes
        b = box(c, 0, p * 0.2, p * 1.9, p * 0.95, p * 1.05, col);
        for (i = 0; i < 3; i++) {
          var tt0 = 0.18 + i * 0.22, tt1 = tt0 + 0.12;
          c.fillStyle = TRUCK[(i * 2 + v) % TRUCK.length];
          poly(c, [b.x0 + b.o * tt0, b.by - b.L * tt0, b.x1 + b.o * tt0, b.by - b.L * tt0, b.x1 + b.o * tt1, b.by - b.L * tt1, b.x0 + b.o * tt1, b.by - b.L * tt1]); c.fill();
        }
        c.strokeStyle = shade(col, -0.45); c.lineWidth = p * 0.035;
        for (i = 1; i < 10; i++) { var xx = b.x0 + (b.x1 - b.x0) * i / 10; c.beginPath(); c.moveTo(xx, b.by - p * 0.02); c.lineTo(xx + b.o, b.fy + p * 0.02); c.stroke(); }
        break;
      case 15: // mohalla house: plaster, shutters, parapet, a black water tank on the roof
        b = box(c, 0, p * 0.25, p * 1.5, p * 1.3, p * 1.05, col);
        frontWin(c, b, 3, 1, WIN_DARK, '#2fae7a');
        t = box(c, b.tx - p * 0.12, b.ty + p * 0.12, p * 1.05, p * 0.85, p * 0.8, shade(col, 0.08));
        frontWin(c, t, 2, 1, WIN_DARK, '#2fae7a');
        c.strokeStyle = shade(col, -0.3); c.lineWidth = p * 0.07;
        poly(c, [t.x0 + t.o + p * 0.05, t.ty - t.d2 / 2 + p * 0.05, t.x1 + t.o - p * 0.05, t.ty - t.d2 / 2 + p * 0.05, t.x1 + t.o - p * 0.05, t.fy - p * 0.05, t.x0 + t.o + p * 0.05, t.fy - p * 0.05]); c.stroke();
        u = cyl(c, t.tx + p * 0.22, t.ty - p * 0.05, p * 0.2, p * 0.32, '#3a3a48');
        break;
      case 16: { // water tower on stilts
        var sh = p * 1.3;
        for (i = 0; i < 4; i++) box(c, (i % 2 ? 0.5 : -0.5) * p, (i < 2 ? -0.3 : 0.45) * p, p * 0.12, p * 0.12, sh / p * p, '#8f95a8');
        var so = -sh * LIFT * SK;
        b = cyl(c, so, p * 0.1 - sh * LIFT, p * 0.85, p * 0.95, col);
        hoop(c, b, 0.5, C.orange, p * 0.14);
        dome(c, b.tx, b.ty, p * 0.85, shade(col, 0.06));
        break;
      }
      case 17: // hall
        b = box(c, 0, p * 0.3, p * 1.8, p * 1.4, p * 0.65, C.stone);
        frontWin(c, b, 6, 1, rgba(col, 0.75));
        dome(c, b.tx, b.ty, p * 0.7, col);
        sphere(c, b.tx - p * 0.05, b.ty - p * 0.75, p * 0.09, C.yellow);
        break;
      case 18: // tower: three stacked boxes with balconies
        b = box(c, 0, p * 0.35, p * 1.45, p * 1.3, p * 1.0, col);
        frontWin(c, b, 5, 2, WIN);
        t = box(c, b.tx, b.ty + p * 0.08, p * 1.1, p * 1.0, p * 0.95, shade(col, 0.08));
        frontWin(c, t, 4, 2, WIN);
        u = box(c, t.tx, t.ty + p * 0.06, p * 0.72, p * 0.66, p * 0.85, shade(col, 0.16));
        frontWin(c, u, 3, 2, WIN);
        c.fillStyle = '#5a5f7a'; c.fillRect(u.tx - p * 0.025, u.ty - p * 0.55, p * 0.05, p * 0.6);
        sphere(c, u.tx, u.ty - p * 0.56, p * 0.08, C.red);
        break;
      case 19: // stadium
        b = cyl(c, 0, p * 0.3, p * 0.98, p * 0.5, C.stone);
        for (i = 0; i < 10; i++) {
          c.fillStyle = i % 2 ? rgba(col, 0.7) : 'rgba(255,255,255,0.5)';
          c.fillRect(-p * 0.98 + i * p * 0.196, p * 0.3 - b.L * 0.8, p * 0.196, b.L * 0.55);
        }
        dome(c, b.tx, b.ty, p * 0.9, col);
        c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = p * 0.04;
        for (i = 0; i < 3; i++) { c.beginPath(); c.ellipse(b.tx, b.ty, p * (0.25 + i * 0.27), p * 0.9, 0, Math.PI, Math.PI * 2); c.stroke(); }
        break;
      case 20: // skyscraper
        b = box(c, 0, p * 0.35, p * 1.15, p * 1.05, p * 3.0, col);
        frontWin(c, b, 4, 9, WIN);
        t = box(c, b.tx, b.ty + p * 0.04, p * 0.85, p * 0.75, p * 0.28, C.yellow);
        c.fillStyle = '#5a5f7a'; c.fillRect(t.tx - p * 0.025, t.ty - p * 0.6, p * 0.05, p * 0.65);
        sphere(c, t.tx, t.ty - p * 0.6, p * 0.08, C.red);
        break;
    }
  }

  // ---------- sprite cache: each look rendered once per zoom bucket at screen scale ----------
  var sprites = {}, buildBudget = 0, centreBucket = 0;
  function qprOf(pr) { return Math.max(4, Math.round(Math.exp(Math.round(Math.log(pr) / 0.12) * 0.12))); }
  function bucketOf(ppu) { return Math.round(Math.log(ppu) / Math.LN2 * 3); }
  function getSprite(k, pr, v, ppu) {
    var q = qprOf(pr), bk = bucketOf(ppu), key = k + '|' + q + '|' + v;
    var id = key + '|' + bk, sp = sprites[id];
    if (sp) return sp;
    if (buildBudget <= 0) {
      for (var d = 1; d < 6; d++) { sp = sprites[key + '|' + (bk - d)] || sprites[key + '|' + (bk + d)]; if (sp) return sp; }
    }
    buildBudget--;
    var pb = Math.pow(2, bk / 3), L = -1.9, R = 1.8, T = -UP[k], B = 1.3;
    var w = Math.min(1000, Math.ceil((R - L) * q * pb) + 2), h = Math.min(1400, Math.ceil((B - T) * q * pb) + 2);
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var c = cv.getContext('2d');
    var sc = w / ((R - L) * q);
    c.setTransform(sc, 0, 0, sc, -L * q * sc, -T * q * sc);
    drawKind(c, k, q, v);
    sp = { cv: cv, L: L, T: T, uw: (R - L), uh: h / (q * sc), bk: bk };
    sprites[id] = sp;
    return sp;
  }
  // draws a prop whose footprint centre is at (x, y) in the current transform
  function drawSprite(c, k, pr, v, x, y, ppu) {
    var sp = getSprite(k, pr, v, ppu);
    c.drawImage(sp.cv, x + sp.L * pr, y + sp.T * pr, sp.uw * pr, sp.uh * pr);
  }
  function trimSprites(ppu) {
    var bk = bucketOf(ppu);
    if (bk === centreBucket) return;
    centreBucket = bk;
    for (var id in sprites) if (Math.abs(sprites[id].bk - bk) > 3) delete sprites[id];
  }

  // ---------- hole sprites ----------
  var HOLE_PX = 360, holeWell, holeGlow;
  function buildHole() {
    holeWell = document.createElement('canvas'); holeWell.width = holeWell.height = HOLE_PX;
    var c = holeWell.getContext('2d'), m = HOLE_PX / 2, r = HOLE_PX * 0.41;
    var gs = c.createRadialGradient(m, m, r * 0.9, m, m, r * 1.2);
    gs.addColorStop(0, 'rgba(40,20,70,0.4)'); gs.addColorStop(1, 'rgba(40,20,70,0)');
    c.fillStyle = gs; c.beginPath(); c.arc(m, m, r * 1.2, 0, Math.PI * 2); c.fill();
    var g = c.createRadialGradient(m, m + r * 0.4, r * 0.05, m, m + r * 0.15, r * 1.05);
    g.addColorStop(0, '#000000'); g.addColorStop(0.6, '#030108'); g.addColorStop(0.88, '#1a0b33'); g.addColorStop(1, '#3a1a6a');
    c.fillStyle = g; c.beginPath(); c.arc(m, m, r, 0, Math.PI * 2); c.fill();
    // the far inner wall, lit, with a few rings of depth
    c.save(); c.beginPath(); c.arc(m, m, r, 0, Math.PI * 2); c.clip();
    var gw = c.createLinearGradient(0, m - r, 0, m + r * 0.1);
    gw.addColorStop(0, 'rgba(176,120,240,0.75)'); gw.addColorStop(1, 'rgba(120,70,200,0)');
    c.fillStyle = gw; c.beginPath(); c.arc(m, m, r, Math.PI, Math.PI * 2); c.arc(m, m + r * 0.42, r * 1.02, Math.PI * 2, Math.PI, true); c.fill();
    c.strokeStyle = 'rgba(200,160,255,0.16)'; c.lineWidth = r * 0.03;
    for (var i = 1; i < 4; i++) { c.beginPath(); c.arc(m, m + r * 0.12 * i, r * (1 - 0.18 * i), Math.PI * 1.05, Math.PI * 1.95); c.stroke(); }
    c.restore();
    var gr = c.createLinearGradient(0, m - r, 0, m + r);
    gr.addColorStop(0, '#8ff8ff'); gr.addColorStop(0.5, '#c46bff'); gr.addColorStop(1, '#ff4dd2');
    c.strokeStyle = gr; c.lineWidth = r * 0.085; c.beginPath(); c.arc(m, m, r, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = r * 0.03;
    c.beginPath(); c.arc(m, m, r, Math.PI * 0.15, Math.PI * 0.85); c.stroke();
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

  // ---------- the camera: a tilted perspective over the fixed arena (presentation only) ----------
  var TILT_C = 0.26, TILT_Q = 0.966;  // sin and cos of the camera tilt (15 degrees)
  var V = { cx: 0, cy: 0, F: 1, Z0: 1, ox: 0, oy: 0 };
  var PX_ = 0, PY_ = 0, PK_ = 1;
  function P(x, y) {
    var v = y - V.cy, k = V.F / (V.Z0 - v * TILT_C);
    PX_ = V.ox + (x - V.cx) * k; PY_ = V.oy + v * TILT_Q * k; PK_ = k;
  }
  function vOfScreenY(Y) { var d = Y - V.oy; return d * V.Z0 / (TILT_Q * V.F + d * TILT_C); }
  function moveP(c, x, y) { P(x, y); c.moveTo(PX_, PY_); }
  function lineP(c, x, y) { P(x, y); c.lineTo(PX_, PY_); }
  function quadP(c, x0, y0, x1, y1) { c.beginPath(); moveP(c, x0, y0); lineP(c, x1, y0); lineP(c, x1, y1); lineP(c, x0, y1); c.closePath(); }
  function rrP(c, x, y, w, h, r) {
    c.beginPath();
    var cs = [[x + w - r, y + r, -0.5], [x + w - r, y + h - r, 0], [x + r, y + h - r, 0.5], [x + r, y + r, 1]];
    for (var i = 0; i < 4; i++) for (var j = 0; j <= 3; j++) {
      var a = (cs[i][2] + j / 6) * Math.PI;
      var px = cs[i][0] + Math.cos(a) * r, py = cs[i][1] + Math.sin(a) * r;
      if (i === 0 && j === 0) moveP(c, px, py); else lineP(c, px, py);
    }
    c.closePath();
  }
  // a raised slab: a darker face along its near edge, then the top
  function slab(c, x, y, w, h, r, hgt, top, face) {
    P(x, y + h); var k = PK_;
    c.save(); c.translate(0, hgt * TILT_Q * k * 0.9);
    c.fillStyle = face; rrP(c, x, y, w, h, r); c.fill(); c.restore();
    c.fillStyle = top; rrP(c, x, y, w, h, r); c.fill();
  }

  function drawGround(c, s, bx0, by0, bx1, by1, now) {
    c.fillStyle = '#06142a'; c.fillRect(0, 0, cw, ch);          // night water round the island
    c.strokeStyle = 'rgba(80,220,255,0.28)'; c.lineWidth = 2;
    var wt = (now / 1000) % 60, gx0 = Math.floor(bx0 / 90) * 90, gy0 = Math.floor(by0 / 70) * 70;
    c.beginPath();
    for (var wy = gy0; wy < by1; wy += 70) for (var wx = gx0; wx < bx1; wx += 90) {
      if (wx > -40 && wx < WORLD + 40 && wy > -40 && wy < WORLD + 40) continue;
      var off = ((wy / 70) % 2) * 45 + Math.sin(wt * 1.3 + wy * 0.05) * 10;
      moveP(c, wx + off, wy); lineP(c, wx + off + 26, wy);
    }
    c.stroke();
    slab(c, -34, -34, WORLD + 68, WORLD + 68, 40, 26, '#221c44', '#0d0a20');    // quay
    rrP(c, -34, -34, WORLD + 68, WORLD + 68, 40); neonLine(c, '#3dd8ff', 3);
    c.fillStyle = '#0e0b22'; quadP(c, 0, 0, WORLD, WORLD); c.fill();              // asphalt
    for (var bj = 0; bj < BLOCKS; bj++) for (var bi = 0; bi < BLOCKS; bi++) {
      var bx = MARGIN + bi * (BLOCK + ROAD), by = MARGIN + bj * (BLOCK + ROAD), id = bj * BLOCKS + bi;
      if (bx > bx1 || by > by1 || bx + BLOCK < bx0 || by + BLOCK < by0) continue;
      slab(c, bx, by, BLOCK, BLOCK, 24, 7, '#262048', '#120e2a');               // sidewalk with a curb
      for (var q = 0; q < 4; q++) {
        var qk = s.QK[id * 4 + q];
        var th = THEME[qk < 0 ? 'land' : KIND_THEME[qk]];
        var x = bx + PAD + (q & 1) * QUAD, y = by + PAD + (q >> 1) * QUAD, w = QUAD, h = QUAD;
        if (qk < 0) { if (q) continue; w = h = QUAD * 2; }
        x += 4; y += 4; w -= 8; h -= 8;
        c.fillStyle = th[0]; rrP(c, x, y, w, h, 14); c.fill(); neonLine(c, th[2], 2);
        var kind = qk < 0 ? 'land' : KIND_THEME[qk];
        if (kind === 'park') {
          c.fillStyle = th[1];
          for (var st = 0; st < w; st += 52) { quadP(c, x + st, y + 6, x + Math.min(w, st + 26), y + h - 6); c.fill(); }
        } else {
          var step = kind === 'bazaar' ? 30 : kind === 'yard' ? 70 : 42;
          c.strokeStyle = th[1]; c.lineWidth = kind === 'yard' ? 2.5 : 1.5;
          c.beginPath();
          for (var gx = x + step; gx < x + w - 2; gx += step) { moveP(c, gx, y + 4); lineP(c, gx, y + h - 4); }
          for (var gy = y + step; gy < y + h - 2; gy += step) { moveP(c, x + 4, gy); lineP(c, x + w - 4, gy); }
          c.stroke();
          if (kind === 'land') {
            c.strokeStyle = rgba(th[2], 0.45); c.lineWidth = 3;
            c.beginPath(); for (var ri = 1; ri < 4; ri++) { var rr0 = ri * 55; quadPath(c, x + w / 2 - rr0, y + h / 2 - rr0, x + w / 2 + rr0, y + h / 2 + rr0); } c.stroke();
          }
        }
      }
    }
    // centre dashes (lit) and zebra crossings
    c.fillStyle = '#ffd23f';
    for (var r = 0; r < BLOCKS - 1; r++) {
      var m = MARGIN + (r + 1) * BLOCK + r * ROAD + ROAD / 2;
      for (var d = 0; d < WORLD; d += 56) {
        if ((d + 28 < bx0 && d + 28 < by0) || d > Math.max(bx1, by1)) continue;
        if (m > bx0 && m < bx1 && d + 28 > by0 && d < by1) { quadP(c, m - 3, d, m + 3, d + 28); c.fill(); }
        if (m > by0 && m < by1 && d + 28 > bx0 && d < bx1) { quadP(c, d, m - 3, d + 28, m + 3); c.fill(); }
      }
    }
  }
  // a neon tube along the current path: a wide faint pass then a bright core
  function neonLine(c, col, lw) {
    c.strokeStyle = rgba(col, 0.22); c.lineWidth = lw * 4; c.stroke();
    c.strokeStyle = rgba(col, 0.9); c.lineWidth = lw; c.stroke();
  }
  function quadPath(c, x0, y0, x1, y1) { moveP(c, x0, y0); lineP(c, x1, y0); lineP(c, x1, y1); lineP(c, x0, y1); lineP(c, x0, y0); }

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
    bump: function () { tone(140, 90, 0.08, 'sine', 0.12); },
    // what a thing sounds like as it drops in, by what it is made of
    material: function (kind, size) {
      var m = MAT[kind], k = 1.25 - size * 0.6;
      if (m === 'clay') { tone(560 * k, 260 * k, 0.1, 'sine', 0.2); tone(1350 * k, 900 * k, 0.05, 'triangle', 0.07); noise(3200, 1600, 2, 0.06, 0.12, 'highpass'); }
      else if (m === 'wood') { tone(250 * k, 120 * k, 0.13, 'triangle', 0.24); noise(900, 300, 1.5, 0.09, 0.16); }
      else if (m === 'metal') { [523, 1247, 1871].forEach(function (f, i) { tone(f * k, f * k * 0.985, 0.4 - i * 0.08, 'sine', 0.08); }); }
      else if (m === 'leaf') { noise(4200, 2400, 0.8, 0.24, 0.14, 'highpass'); tone(300 * k, 180 * k, 0.1, 'sine', 0.06); }
      else if (m === 'plastic') { tone(760 * k, 1500 * k, 0.07, 'sine', 0.15); }
      else { noise(520, 110, 1, 0.38, 0.26, 'lowpass'); tone(95 * k, 48, 0.32, 'sine', 0.3); }
    },
    heart: function () { tone(70, 45, 0.16, 'sine', 0.35, 0, 0.005); tone(70, 45, 0.14, 'sine', 0.25, 0.17, 0.005); },
    starve: function () { tone(420, 90, 0.9, 'triangle', 0.18); tone(424, 92, 0.9, 'sine', 0.1, 0.02); noise(1200, 200, 2, 0.6, 0.08); },
    kick: function () { tone(160, 50, 0.22, 'sine', 0.5, 0, 0.004); }
  };
  var MAT = ['plastic', 'clay', 'wood', 'metal', 'wood', 'wood', 'leaf', 'stone', 'leaf', 'wood', 'wood', 'stone',
    'plastic', 'leaf', 'metal', 'stone', 'metal', 'stone', 'stone', 'stone', 'stone'];

  // A light tabla groove under the run. More layers join as the combo climbs.
  var Music = { on: false, level: 1, step: 0, next: 0, timer: null };
  var PENTA = [523, 587, 659, 784, 880, 1047, 880, 784];
  function musicNote(t, kind, i) {
    var d = t - AC.currentTime;
    if (kind === 'dha') { tone(150, 72, 0.34, 'sine', 0.2, d, 0.004); tone(330, 0, 0.12, 'sine', 0.06, d); }
    else if (kind === 'na') { tone(740, 0, 0.11, 'sine', 0.07, d, 0.003); noise(5200, 3800, 2, 0.04, 0.03, 'highpass', d); }
    else if (kind === 'ti') { noise(6500, 5000, 3, 0.035, 0.03, 'highpass', d); }
    else if (kind === 'ge') { tone(98, 58, 0.45, 'sine', 0.16, d, 0.006); }
    else if (kind === 'bell') { tone(PENTA[i % PENTA.length], 0, 0.3, 'triangle', 0.035, d); }
  }
  function musicTick() {
    if (!AC || !Music.on || muted) return;
    var spb = 60 / (100 + Music.level * 6) / 4;
    if (Music.next < AC.currentTime) Music.next = AC.currentTime + 0.05;
    while (Music.next < AC.currentTime + 0.14) {
      var st = Music.step % 16, L = Music.level, t = Music.next;
      if (st === 0 || st === 8) musicNote(t, 'dha');
      if (st === 4 || st === 12) musicNote(t, 'na');
      if (L >= 2 && st % 4 === 2) musicNote(t, 'ti');
      if (L >= 3 && (st === 3 || st === 11)) musicNote(t, 'ge');
      if (L >= 3 && st === 7) musicNote(t, 'na');
      if (L >= 4 && st % 2 === 1) musicNote(t, 'ti');
      if (L >= 5 && st % 4 === 0) musicNote(t, 'bell', (Music.step >> 2));
      Music.step++; Music.next += spb;
    }
  }
  function musicStart() { if (!AC) return; Music.on = true; Music.step = 0; Music.next = 0; clearInterval(Music.timer); Music.timer = setInterval(musicTick, 30); }
  function musicStop() { Music.on = false; clearInterval(Music.timer); }

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
    fogGrad = null;
  }
  window.addEventListener('resize', resize);

  // ---------- run state ----------
  var params = new URLSearchParams(location.search);
  var SEED = (Number(params.get('seed')) >>> 0) || 20261028;
  var mode = 'menu', S = null, demo = null, acc = 0, last = null;
  var prevHx = 0, prevHy = 0, dprevHx = 0, dprevHy = 0;
  var cam = { x: WORLD / 2, y: WORLD / 2, zr: 24, vr: 24, shake: 0, punch: 0, punchV: 0 };
  var falls = [], parts = [], pops = [], rings = [], banners = [], dusts = [], waves = [], streaks = [], puffs = [];
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
    var sum = 0, big = 0, eats = 0, ax = 0, ay = 0, pts = 0, now = performance.now(), bigKind = [0, 0];
    var hx = s.hx / 16, hy = s.hy / 16;
    for (var i = 0; i < s.ev.length; i++) {
      var e = s.ev[i];
      if (e.t === 'eat') {
        var px = s.PX[e.i] / 16, py = s.PY[e.i] / 16;
        falls.push({ k: s.PK[e.i], pr: s.PR[e.i], v: s.PV[e.i], rx: px - hx, ry: py - hy, t0: now,
          dur: 380 + e.pr * 4, rot: (px < hx ? -1 : 1) * (0.5 + Math.random() * 0.5) });
        var col = PAL[s.PK[e.i]][s.PV[e.i] & 3];
        var nP = Math.min(14, 4 + (e.pr / 4) | 0);
        for (var p = 0; p < nP; p++) {
          var a = Math.random() * Math.PI * 2, sp = (50 + Math.random() * 110) * (0.6 + e.pr / 60);
          parts.push({ x: px, y: py, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 50, life: 0, max: 0.55 + Math.random() * 0.4,
            r: 1.5 + Math.random() * 2.5 + e.pr * 0.07, col: Math.random() < 0.25 ? '#ffffff' : col, star: Math.random() < 0.2,
            chunk: Math.random() < 0.45, rot: Math.random() * 6, suck: true });
        }
        if (e.pr >= 12) dusts.push({ x: px, y: py, t0: now, r: e.pr });
        if (e.pr > bigKind[1]) bigKind = [s.PK[e.i], e.pr];
        sum += e.pr * e.pr; if (e.pr > big) big = e.pr; eats++; ax += px; ay += py; pts += e.pts;
      } else if (e.t === 'tier' && live) {
        rings.push({ t0: now, col: ACCENT }); rings.push({ t0: now + 140, col: '#ffffff' });
        waves.push({ x: hx, y: hy, t0: now, max: s.R16 / 16 * 5 }); cam.punchV += 3;
        for (var cf = 0; cf < 26; cf++) {
          var ca = Math.random() * Math.PI * 2, cs = 120 + Math.random() * 200;
          parts.push({ x: hx, y: hy, vx: Math.cos(ca) * cs, vy: Math.sin(ca) * cs - 80, life: 0, max: 0.9, r: 3 + Math.random() * 3,
            col: TRUCK[cf % TRUCK.length], chunk: true, rot: Math.random() * 6 });
        }
        banners.push({ t0: now, a: 'SIZE UP!', b: TIER_NAMES[Math.min(e.tier, TIER_NAMES.length - 1)], dur: 1300 });
        SFX.chime();
      } else if ((e.t === 'time' || e.t === 'clear' || e.t === 'starve') && live) {
        endRun(e.t);
      }
    }
    if (!eats) return;
    pulse.v += Math.min(1.2, 0.35 + Math.sqrt(sum) / (s.R16 / 16) * 0.6); glow = 1;
    // one running total per burst: a pop still rising near the hole takes the new points
    var merged = false, hr = s.R16 / 16;
    for (var a2 = pops.length - 1; a2 >= 0; a2--) {
      var pa = pops[a2];
      if (!pa.combo && now - pa.t0 < 380 && Math.abs(pa.x - ax / eats) < hr * 1.6 && Math.abs(pa.y - ay / eats) < hr * 1.6) {
        pa.val += pts; pa.txt = '+' + pa.val; pa.t0 = Math.max(pa.t0, now - 120); pa.big = pa.val > 200; pa.mult = s.mult; pa.bump = 1; merged = true; break;
      }
    }
    if (!merged) pops.push({ x: ax / eats, y: ay / eats, val: pts, txt: '+' + pts, t0: now, big: pts > 200, mult: s.mult, bump: 0 });
    if (!live) return;
    if (now - lastSwallowSfx > 45) {
      var sz = clamp(Math.sqrt(sum) / 120, 0, 1);
      SFX.swallow(sz * 0.8); SFX.material(bigKind[0], clamp(bigKind[1] / 110, 0, 1)); lastSwallowSfx = now;
    }
    if (big >= 38) {
      SFX.thump(clamp(big / 130, 0, 1)); cam.shake = Math.max(cam.shake, Math.min(18, 5 + big / 9));
      waves.push({ x: hx, y: hy, t0: now, max: s.R16 / 16 * 3.5 }); cam.punchV += 2 + big / 40;
    }
    if (s.streak >= 2 && now - lastComboSfx > 70) { SFX.combo(s.streak); lastComboSfx = now; }
    if (s.mult > prevMult) {
      comboFlash = 1;
      if (s.mult >= 3) pops.push({ x: hx, y: hy - s.R16 / 16 * 1.4, val: 0, txt: 'x' + s.mult + ' COMBO!', t0: now + 60, big: true, mult: s.mult, bump: 1, combo: true });
      tone(660 + s.mult * 110, 0, 0.18, 'triangle', 0.12); tone(990 + s.mult * 165, 0, 0.22, 'sine', 0.08, 0.06);
    }
    prevMult = s.mult;
    Music.level = s.mult;
  }

  // ---------- flow ----------
  function show(id, on) {
    var el = $(id);
    if (on) { el.classList.remove('is-gone'); void el.offsetWidth; el.classList.remove('is-hidden'); }
    else { el.classList.add('is-hidden'); setTimeout(function () { if (el.classList.contains('is-hidden')) el.classList.add('is-gone'); }, 300); }
  }
  function resetFx() { falls = []; parts = []; pops = []; rings = []; banners = []; dusts = []; waves = []; streaks = []; puffs = []; pulse.x = pulse.v = 0; glow = 0; }
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
      mode = 'play'; acc = 0; musicStart();
      setTimeout(function () { cd.className = 'cd'; }, 650);
    }, 1000);
  }
  var endInfo = null;
  function endRun(why) {
    var cleared = why === 'clear';
    mode = 'ending'; musicStop();
    endInfo = { cleared: cleared, t0: performance.now() };
    banners.push({ t0: performance.now(), a: cleared ? 'CITY CLEARED!' : why === 'starve' ? 'STARVED!' : 'TIME UP!',
      b: cleared ? '+' + S.bonus + ' BONUS' : why === 'starve' ? 'keep eating to stay big' : '', dur: 1700, big: true });
    if (cleared) SFX.fanfare(); else if (why === 'starve') SFX.starve(); else SFX.gong();
    setTimeout(showOver, 1800);
  }
  function showOver() {
    mode = 'over';
    var s = S, isBest = s.score > best;
    if (isBest) { best = s.score; try { localStorage.setItem('bhookha_best', String(best)); } catch (_e) {} }
    $('overTitle').textContent = s.cleared ? 'CITY CLEARED!' : s.starved ? 'STARVED!' : 'TIME UP!';
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
  function viewW(r) { return 210 + 6.4 * r; }

  var MULT_COL = ['#b44dff', '#3db8ff', '#2fd27a', '#ffc531', '#ff4d8d'];
  var fogGrad = null, vigGrad = null, vigRed = null, cloudSpr = null;
  function buildOverlays() {
    fogGrad = ctx.createLinearGradient(0, 0, 0, ch * 0.3);
    fogGrad.addColorStop(0, 'rgba(226,236,255,0.6)'); fogGrad.addColorStop(1, 'rgba(226,236,255,0)');
    vigGrad = ctx.createRadialGradient(cw / 2, ch * 0.55, Math.min(cw, ch) * 0.45, cw / 2, ch * 0.55, Math.max(cw, ch) * 0.8);
    vigGrad.addColorStop(0, 'rgba(5,2,20,0)'); vigGrad.addColorStop(1, 'rgba(5,2,20,0.6)');
    vigRed = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.35, cw / 2, ch / 2, Math.max(cw, ch) * 0.75);
    vigRed.addColorStop(0, 'rgba(255,40,70,0)'); vigRed.addColorStop(1, 'rgba(255,40,70,0.75)');
    if (!cloudSpr) {
      cloudSpr = document.createElement('canvas'); cloudSpr.width = cloudSpr.height = 256;
      var c = cloudSpr.getContext('2d');
      [[128, 128, 90], [80, 140, 60], [176, 136, 66], [120, 100, 58]].forEach(function (b) {
        var g = c.createRadialGradient(b[0], b[1], 0, b[0], b[1], b[2]);
        g.addColorStop(0, 'rgba(40,30,90,0.5)'); g.addColorStop(1, 'rgba(40,30,90,0)');
        c.fillStyle = g; c.fillRect(0, 0, 256, 256);
      });
    }
  }
  // overhead flag strings across the north to south roads (seen side on, they read best)
  var BUNTING = [];
  (function () {
    for (var r = 0; r < BLOCKS - 1; r++) {
      var m = MARGIN + (r + 1) * BLOCK + r * ROAD + ROAD / 2;
      for (var b = 0; b < BLOCKS; b++) {
        var c0 = MARGIN + b * (BLOCK + ROAD) + BLOCK / 2;
        BUNTING.push([m - ROAD / 2 - 8, c0 - 120, m + ROAD / 2 + 8, c0 - 120]);
        BUNTING.push([m - ROAD / 2 - 8, c0 + 120, m + ROAD / 2 + 8, c0 + 120]);
      }
    }
  })();
  var CLOUDS = [[200, 300, 1.0], [900, 1100, 1.3], [1400, 200, 0.9], [500, 1400, 1.2]];
  var lastPuff = 0;
  // soft bloom: the frame shrunk twice and added back on top, so bright edges glow
  var bloomA = null, bloomB = null;
  // Refreshed every third frame. A slow device (frames over 26 ms on average
  // for two seconds) turns it off for the rest of the visit.
  var bloomOn = location.search.indexOf('nobloom') < 0, bloomTick = 0, perfAcc = 0, perfN = 0;
  function perfGuard(dtms) {
    if (!bloomOn || mode !== 'play') return;
    perfAcc += dtms; perfN++;
    if (perfN >= 120) { if (perfAcc / perfN > 26) bloomOn = false; perfAcc = 0; perfN = 0; }
  }
  function bloom() {
    if (!bloomOn) return;
    if (!bloomA) { bloomA = document.createElement('canvas'); bloomB = document.createElement('canvas'); }
    var aw = Math.max(8, cv.width >> 3), ah = Math.max(8, cv.height >> 3);
    if (bloomA.width !== aw || bloomA.height !== ah) { bloomA.width = aw; bloomA.height = ah; bloomB.width = Math.max(4, aw >> 2); bloomB.height = Math.max(4, ah >> 2); bloomTick = 0; }
    if (bloomTick++ % 3 === 0) {
      var a = bloomA.getContext('2d'), b = bloomB.getContext('2d');
      a.globalCompositeOperation = 'copy'; a.drawImage(cv, 0, 0, aw, ah);
      b.globalCompositeOperation = 'copy'; b.drawImage(bloomA, 0, 0, bloomB.width, bloomB.height);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.22; ctx.drawImage(bloomA, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 0.32; ctx.drawImage(bloomB, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawWorldView(s, hx, hy, dt, live) {
    var targetR = s.R16 / 16, now = performance.now(), tsec = now / 1000;
    cam.vr += (targetR - cam.vr) * Math.min(1, dt * 9);
    cam.zr += (targetR - cam.zr) * Math.min(1, dt * 2.2);
    cam.punchV += (-220 * cam.punch - 16 * cam.punchV) * dt; cam.punch += cam.punchV * dt;
    var vw = viewW(cam.zr) * (1 - clamp(cam.punch, -0.5, 1) * 0.05), sc = cw / vw, vh = ch / sc;
    var lead = live ? 9 : 4;
    cam.x += (hx + s.vx / 16 * lead - cam.x) * Math.min(1, dt * 7);
    cam.y += (hy + s.vy / 16 * lead - cam.y) * Math.min(1, dt * 7);
    var cx = cam.x, cy = cam.y, lo, hi;
    lo = vw * 0.35 - 60; hi = WORLD - vw * 0.35 + 60;
    cx = lo < hi ? clamp(cx, lo, hi) : WORLD / 2;
    lo = vh * 0.42 - 60; hi = WORLD + 60 - vh * 0.26;
    cy = lo < hi ? clamp(cy, lo, hi) : (lo + hi) / 2;
    cam.shake *= Math.pow(0.0015, dt);
    var shx = (Math.random() - 0.5) * cam.shake * 2, shy = (Math.random() - 0.5) * cam.shake * 2;
    V.cx = cx; V.cy = cy; V.Z0 = vh * 2.4; V.F = V.Z0 * sc; V.ox = cw / 2 + shx; V.oy = ch * 0.6 + shy;
    var vt = vOfScreenY(-10), vb = vOfScreenY(ch + 10);
    P(cx, cy + vt); var halfT = (cw / 2 + 40) / PK_;
    var bx0 = cx - halfT, bx1 = cx + halfT, by0 = cy + vt - 60, by1 = cy + vb + 60;
    trimSprites(sc * dpr); buildBudget = 8;
    if (!fogGrad) buildOverlays();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGround(ctx, s, bx0, by0, bx1, by1, now);

    // dust rings and shockwaves on the ground (light adds up)
    ctx.globalCompositeOperation = 'lighter';
    for (var di = dusts.length - 1; di >= 0; di--) {
      var du = dusts[di], dtt = (now - du.t0) / 500;
      if (dtt >= 1) { dusts.splice(di, 1); continue; }
      P(du.x, du.y);
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.7 * (1 - dtt)) + ')'; ctx.lineWidth = Math.max(1, du.r * 0.18 * (1 - dtt) * PK_);
      ctx.beginPath(); ctx.ellipse(PX_, PY_, du.r * (0.8 + dtt * 1.6) * PK_, du.r * (0.8 + dtt * 1.6) * PK_ * TILT_Q, 0, 0, Math.PI * 2); ctx.stroke();
    }
    for (var wi = waves.length - 1; wi >= 0; wi--) {
      var wv = waves[wi], wt = (now - wv.t0) / 650;
      if (wt >= 1) { waves.splice(wi, 1); continue; }
      P(wv.x, wv.y); var wr = wv.max * wt;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 * (1 - wt)) + ')'; ctx.lineWidth = 10 * (1 - wt) * PK_ + 1;
      ctx.beginPath(); ctx.ellipse(PX_, PY_, wr * PK_, wr * PK_ * TILT_Q, 0, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';
    // the hole: well, swirling arms, a rim coloured by the combo, red when hungry
    pulse.v += (-160 * pulse.x - 11 * pulse.v) * dt; pulse.x += pulse.v * dt;
    glow = Math.max(0, glow - dt * 1.6);
    var R = cam.vr * (1 + pulse.x * 0.07);
    var hungry = s.drain > 0, mc = hungry ? '#ff3d5a' : MULT_COL[s.mult - 1];
    P(hx, hy); var HX = PX_, HY = PY_, HK = PK_;
    var holeT = function () { ctx.setTransform(HK * dpr, 0, 0, HK * TILT_Q * dpr, HX * dpr, HY * dpr); };
    holeT();
    drawHole(ctx, 0, 0, R, 0.3 + glow * 0.7);
    var spin = tsec * (1.4 + s.mult * 0.5);
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, R * 0.9, 0, Math.PI * 2); ctx.clip();
    ctx.lineCap = 'round'; ctx.lineWidth = R * 0.07;
    for (var arm = 0; arm < 4; arm++) {
      ctx.strokeStyle = rgba(mc, 0.2 + glow * 0.25);
      ctx.beginPath();
      for (var sj = 0; sj <= 16; sj++) {
        var an = spin + arm * Math.PI / 2 + sj * 0.3, rad = R * 0.92 * (1 - sj / 17);
        if (sj === 0) ctx.moveTo(Math.cos(an) * rad, Math.sin(an) * rad); else ctx.lineTo(Math.cos(an) * rad, Math.sin(an) * rad);
      }
      ctx.stroke();
    }
    ctx.restore();
    var hb = hungry ? 0.5 + 0.5 * Math.sin(tsec * 14) : 0;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(mc, 0.28 + glow * 0.3); ctx.lineWidth = R * (0.22 + hb * 0.1);
    ctx.beginPath(); ctx.arc(0, 0, R * 1.0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = rgba(mc, 0.85 + hb * 0.15); ctx.lineWidth = R * (0.07 + hb * 0.04);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = R * 0.02 + 0.5; ctx.stroke();
    ctx.fillStyle = '#ffffff';
    for (var sp2 = 0; sp2 < 6; sp2++) {
      var sa = -spin * 0.7 + sp2 * Math.PI / 3;
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(tsec * 6 + sp2);
      ctx.beginPath(); ctx.arc(Math.cos(sa) * R * 1.0, Math.sin(sa) * R * 1.0, R * 0.035 + 0.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // suction streaks flowing into the rim
    var spd = Math.sqrt(s.vx * s.vx + s.vy * s.vy) / 16;
    if (s === S && mode === 'play' && Math.random() < 0.35 + spd * 0.08 + glow * 0.5) {
      var sa2 = Math.random() * Math.PI * 2, sr = 1.5 + Math.random() * 0.8;
      streaks.push({ a: sa2, r: sr, t0: now });
    }
    ctx.lineCap = 'round';
    for (var si = streaks.length - 1; si >= 0; si--) {
      var stk = streaks[si], st = (now - stk.t0) / 380;
      if (st >= 1) { streaks.splice(si, 1); continue; }
      var r0 = R * (stk.r - (stk.r - 1) * st), r1 = R * (stk.r - (stk.r - 1) * Math.max(0, st - 0.25));
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 * Math.sin(st * Math.PI)) + ')'; ctx.lineWidth = R * 0.03 + 0.6;
      ctx.beginPath(); ctx.moveTo(Math.cos(stk.a + st * 0.5) * r0, Math.sin(stk.a + st * 0.5) * r0);
      ctx.lineTo(Math.cos(stk.a + st * 0.5 - 0.12) * r1, Math.sin(stk.a + st * 0.5 - 0.12) * r1); ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';
    // things falling in: clipped to the well, tilting, shrinking into the dark
    for (var i = falls.length - 1; i >= 0; i--) {
      var f = falls[i], t = (now - f.t0) / f.dur;
      if (t >= 1) { falls.splice(i, 1); continue; }
      if (t < 0) t = 0;
      var e = t * t * (3 - 2 * t), scl = 1 - 0.9 * Math.pow(e, 1.3), clipR = R * (0.98 + 2.2 * Math.max(0, 0.45 - t));
      ctx.save();
      holeT();
      ctx.beginPath(); ctx.arc(0, 0, clipR, 0, Math.PI * 2); ctx.clip();
      P(hx + f.rx * (1 - e), hy + f.ry * (1 - e) + f.pr * 0.25 * e);
      var k = PK_ * scl;
      ctx.setTransform(k * dpr, 0, 0, k * dpr, PX_ * dpr, PY_ * dpr);
      ctx.rotate(f.rot * Math.min(1, t * 2.4) + f.rot * e * 1.5);
      ctx.globalAlpha = 1 - Math.pow(t, 2.2);
      drawSprite(ctx, f.k, f.pr, f.v, 0, 0, k * dpr);
      ctx.globalAlpha = Math.min(0.85, t * 1.4); ctx.fillStyle = '#0c0618';
      ctx.beginPath(); ctx.arc(0, -f.pr * 0.5, f.pr * 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // props, back to front: things that fit lean toward the hole and shiver,
    // trees sway, shockwaves bounce what they pass
    var vis = [];
    for (var j = 0; j < s.n; j++) {
      if (!s.alive[j]) continue;
      var px = s.PX[j] / 16, py = s.PY[j] / 16, pr = s.PR[j];
      if (px + pr * 2 < bx0 || px - pr * 2 > bx1 || py - pr * 1.5 > by1 || py + pr * 5 < by0) continue;
      vis.push(j);
    }
    vis.sort(function (a, b) { return s.PY[a] - s.PY[b]; });
    var steamOK = now - lastPuff > 380;
    for (var q = 0; q < vis.length; q++) {
      var id = vis[q], kd = s.PK[id], ppx = s.PX[id] / 16, ppy = s.PY[id] / 16, ppr = s.PR[id];
      var ang = 0, bob = 0, sway = 0;
      var ddx = hx - ppx, ddy = hy - ppy, dd = Math.sqrt(ddx * ddx + ddy * ddy) || 1, lim = R * 1.9;
      if (dd < lim && propFits(s.R16, ppr)) {
        var lean = 1 - dd / lim; lean *= lean;
        ang = (ddx / dd) * lean * 0.45 + Math.sin(tsec * 38 + id) * lean * 0.06;
        ppx += ddx / dd * lean * R * 0.14; ppy += ddy / dd * lean * R * 0.14;
      } else if (dd < R + ppr * 1.2) {
        ang = Math.sin(tsec * 30 + id) * 0.03;           // bumped by the rim
      }
      if (kd === 6 || kd === 8 || kd === 13) sway = Math.sin(tsec * 1.6 + ppx * 0.013 + ppy * 0.007) * 0.05;
      for (var wj = 0; wj < waves.length; wj++) {
        var w2 = waves[wj], wt2 = (now - w2.t0) / 650, wdd = Math.abs(Math.sqrt((ppx - w2.x) * (ppx - w2.x) + (ppy - w2.y) * (ppy - w2.y)) - w2.max * wt2);
        if (wdd < 70) bob += (1 - wdd / 70) * 14 * (1 - wt2);
      }
      P(ppx, ppy);
      if (PX_ < -PK_ * ppr * 2 || PX_ > cw + PK_ * ppr * 2) continue;
      ctx.setTransform(PK_ * dpr, 0, 0, PK_ * dpr, PX_ * dpr, (PY_ - bob * PK_) * dpr);
      if (ang) ctx.rotate(ang);
      if (sway) ctx.transform(1, 0, sway, 1, 0, 0);
      drawSprite(ctx, kd, ppr, s.PV[id], 0, 0, PK_ * dpr);
      if (kd === 10 && steamOK && Math.random() < 0.5) puffs.push({ x: ppx - ppr * 0.1, y: ppy, z: ppr * 1.4, t0: now, r: ppr * 0.18 });
    }
    if (steamOK) lastPuff = now;

    // chai steam
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (var pi = puffs.length - 1; pi >= 0; pi--) {
      var pf = puffs[pi], pt = (now - pf.t0) / 1400;
      if (pt >= 1) { puffs.splice(pi, 1); continue; }
      P(pf.x + Math.sin(pt * 5 + pi) * pf.r, pf.y);
      ctx.fillStyle = 'rgba(200,220,255,' + (0.28 * (1 - pt)) + ')';
      ctx.beginPath(); ctx.arc(PX_, PY_ - (pf.z + pt * pf.r * 9) * PK_ * LIFT, pf.r * (1 + pt * 2) * PK_, 0, Math.PI * 2); ctx.fill();
    }

    // bunting over the roads
    ctx.lineWidth = 1;
    for (var bi = 0; bi < BUNTING.length; bi++) {
      var bu = BUNTING[bi];
      if (Math.max(bu[0], bu[2]) < bx0 || Math.min(bu[0], bu[2]) > bx1 || Math.max(bu[1], bu[3]) < by0 || Math.min(bu[1], bu[3]) > by1) continue;
      P(bu[0], bu[1]); var ax0 = PX_, ay0 = PY_, ak = PK_; P(bu[2], bu[3]); var ax1 = PX_, ay1 = PY_, bk = PK_;
      var hgt = 70 * LIFT;
      ctx.strokeStyle = '#6d5f86'; ctx.lineWidth = Math.max(1.5, 5 * ak); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ax0, ay0); ctx.lineTo(ax0, ay0 - hgt * ak); ctx.moveTo(ax1, ay1); ctx.lineTo(ax1, ay1 - hgt * bk); ctx.stroke();
      ctx.fillStyle = C.yellow;
      ctx.beginPath(); ctx.arc(ax0, ay0 - hgt * ak, Math.max(1.5, 5 * ak), 0, Math.PI * 2); ctx.arc(ax1, ay1 - hgt * bk, Math.max(1.5, 5 * bk), 0, Math.PI * 2); ctx.fill();
      var n = 9;
      ctx.strokeStyle = 'rgba(80,60,110,0.7)'; ctx.lineWidth = Math.max(0.6, 1 * ak);
      ctx.beginPath();
      for (var fi = 0; fi <= n; fi++) {
        var u = fi / n, kx = ax0 + (ax1 - ax0) * u, ky = ay0 - hgt * ak + (ay1 - hgt * bk - ay0 + hgt * ak) * u + Math.sin(u * Math.PI) * 14 * ak;
        if (fi === 0) ctx.moveTo(kx, ky); else ctx.lineTo(kx, ky);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      for (var fl = 0; fl <= n * 2; fl++) {
        var uu = fl / (n * 2);
        var lx = ax0 + (ax1 - ax0) * uu, ly = ay0 - hgt * ak + (ay1 - hgt * bk - ay0 + hgt * ak) * uu + Math.sin(uu * Math.PI) * 14 * ak;
        var tw = 0.55 + 0.45 * Math.sin(tsec * 4 + fl * 1.7 + bi);
        ctx.fillStyle = rgba(TRUCK[(fl + bi) % TRUCK.length], 0.3 * tw);
        ctx.beginPath(); ctx.arc(lx, ly + 3 * ak, 9 * ak, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgba(TRUCK[(fl + bi) % TRUCK.length], 0.95);
        ctx.beginPath(); ctx.arc(lx, ly + 3 * ak, 3 * ak + 0.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // rings, debris
    ctx.globalCompositeOperation = 'lighter';
    holeT();
    for (var r = rings.length - 1; r >= 0; r--) {
      var rg = rings[r], rt = (now - rg.t0) / 700;
      if (rt >= 1) { rings.splice(r, 1); continue; }
      if (rt < 0) continue;
      ctx.strokeStyle = rgba(rg.col === '#ffffff' ? '#ffffff' : mc, (1 - rt) * 0.9);
      ctx.lineWidth = R * 0.18 * (1 - rt) + 1;
      ctx.beginPath(); ctx.arc(0, 0, R * (1 + rt * 1.8), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (var kk = parts.length - 1; kk >= 0; kk--) {
      var p = parts[kk]; p.life += dt;
      if (p.life >= p.max) { parts.splice(kk, 1); continue; }
      if (p.suck && p.life > 0.16) { p.x += (hx - p.x) * Math.min(1, dt * 7); p.y += (hy - p.y) * Math.min(1, dt * 7); p.vx *= 0.8; p.vy *= 0.8; }
      p.vx *= 0.94; p.vy = p.vy * 0.94 + 30 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      var a = 1 - p.life / p.max;
      P(p.x, p.y);
      var pz = p.r * PK_ * (p.suck ? 0.4 + a * 0.6 : 1), X = PX_, Y = PY_ - Math.sin(Math.min(1, p.life / p.max) * Math.PI) * 40 * PK_;
      ctx.globalAlpha = Math.min(1, a * 1.5); ctx.fillStyle = p.col;
      if (p.chunk) { ctx.save(); ctx.translate(X, Y); ctx.rotate(p.rot + p.life * 9); ctx.fillRect(-pz, -pz * 0.6, pz * 2, pz * 1.2); ctx.restore(); }
      else if (p.star) { ctx.save(); ctx.translate(X, Y); ctx.rotate(p.life * 6); ctx.fillRect(-pz, -pz * 0.3, pz * 2, pz * 0.6); ctx.fillRect(-pz * 0.3, -pz, pz * 0.6, pz * 2); ctx.restore(); }
      else { ctx.beginPath(); ctx.arc(X, Y, pz * (0.5 + a * 0.5), 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;

    ctx.globalCompositeOperation = 'source-over';
    bloom();
    ctx.fillStyle = vigGrad; ctx.fillRect(0, 0, cw, ch);
    return { cx: cx, cy: cy, x0: bx0, x1: bx1, y0: cy + vt, y1: cy + vb };
  }

  function worldToScreen(v, x, y) { P(x, y); return [PX_, PY_]; }

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
      p.bump = Math.max(0, (p.bump || 0) - dt * 5);
      text(ctx, p.txt, sp[0], sp[1] - 34 * ui - t * 46 * ui, (p.big ? 30 : 22) * ui * k * (1 + p.bump * 0.25), col);
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
    ctx.fillStyle = hurry ? 'rgba(220,40,70,0.92)' : 'rgba(8,4,26,0.7)'; rr(ctx, -cwid / 2, -chh / 2, cwid, chh, chh / 2); ctx.fill();
    ctx.strokeStyle = hurry ? '#ffd0da' : 'rgba(61,216,255,0.75)'; ctx.lineWidth = 1.5; ctx.stroke();
    text(ctx, fmtClock(s.steps), 0, 2 * ui, 26 * ui, '#ffffff', 'center', false);
    ctx.restore();
    // size meter
    var t = tierOf(s.R16), rNow = s.R16 / 16, lo = t === 0 ? 18 : TIER_R[t - 1], hi = t < TIER_R.length ? TIER_R[t] : lo;
    var pf = hi > lo ? clamp((rNow - lo) / (hi - lo), 0, 1) : 1, hungry = s.drain > 0 && mode === 'play';
    var hp = hungry ? 0.5 + 0.5 * Math.sin(now / 90) : 0;
    var mw = 170 * ui, mh = 14 * ui, mx = cw / 2 - mw / 2, my = ch - Math.max(18, safeBot) - 26 * ui;
    text(ctx, hungry ? 'HUNGRY! EAT!' : TIER_NAMES[t], cw / 2, my - 12 * ui, (14 + hp * 2) * ui, hungry ? '#ff6b81' : '#ffffff');
    ctx.fillStyle = 'rgba(40,20,80,0.45)'; rr(ctx, mx, my, mw, mh, mh / 2); ctx.fill();
    ctx.fillStyle = hungry ? '#ff3d5a' : MULT_COL[s.mult - 1]; rr(ctx, mx + 2, my + 2, Math.max(mh - 4, (mw - 4) * pf), mh - 4, (mh - 4) / 2); ctx.fill();
    if (hungry && now - lastHeart > 760) { lastHeart = now; SFX.heart(); }
    if (hungry) { ctx.globalAlpha = 0.35 + hp * 0.3; ctx.fillStyle = vigRed; ctx.fillRect(0, 0, cw, ch); ctx.globalAlpha = 1; }
    else if (secLeft <= 10) { ctx.globalAlpha = 0.25 * frac * frac; ctx.fillStyle = vigRed; ctx.fillRect(0, 0, cw, ch); ctx.globalAlpha = 1; }
    // minimap
    var mm = 78 * ui, mx0 = cw - mm - 12 * ui, my0 = top + 58 * ui, k2 = mm / WORLD;
    ctx.fillStyle = 'rgba(8,4,26,0.75)'; rr(ctx, mx0 - 4, my0 - 4, mm + 8, mm + 8, 10 * ui); ctx.fill();
    ctx.strokeStyle = 'rgba(61,216,255,0.7)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#17123a'; ctx.fillRect(mx0, my0, mm, mm);
    for (var j = 0; j < s.n; j++) {
      if (!s.alive[j]) continue;
      var fit = propFits(s.R16, s.PR[j]), dsz = Math.max(1.4, s.PR[j] * k2 * 1.3);
      ctx.fillStyle = fit ? '#2fffb0' : 'rgba(170,150,255,0.45)';
      ctx.fillRect(mx0 + s.PX[j] / 16 * k2 - dsz / 2, my0 + s.PY[j] / 16 * k2 - dsz / 2, dsz, dsz);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(mx0, my0, mm, mm); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    ctx.strokeRect(mx0 + v.x0 * k2, my0 + v.y0 * k2, (v.x1 - v.x0) * k2, (v.y1 - v.y0) * k2);
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

  var safeTop = 0, safeBot = 0, lastHeart = 0;
  function readSafe() {
    var cs = getComputedStyle(document.documentElement);
    safeTop = parseFloat(cs.getPropertyValue('--sat')) || 0; safeBot = parseFloat(cs.getPropertyValue('--sab')) || 0;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (last === null) last = now;
    var dtms = Math.min(250, now - last); last = now;
    var dt = dtms / 1000;
    perfGuard(dtms);
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
    // a neon sign: soft halo, coloured tube, white hot core
    function word(str, y, size, col) {
      c.font = size + 'px "Titan One", system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
      c.save(); c.shadowColor = col; c.shadowBlur = size * 0.5;
      c.strokeStyle = col; c.lineWidth = size * 0.1; c.strokeText(str, 320, y); c.strokeText(str, 320, y);
      c.restore();
      c.fillStyle = 'rgba(10,4,30,0.85)'; c.fillText(str, 320, y);
      c.strokeStyle = col; c.lineWidth = size * 0.06; c.strokeText(str, 320, y);
      c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = size * 0.018; c.strokeText(str, 320, y);
    }
    word('BHOOKHA', 84, 104, '#ff4dd2');
    word('GOLA', 196, 112, '#3dd8ff');
    c.restore();
  }
  var howAnim = null;
  function drawHow(now) {
    var cvs = document.querySelectorAll('.howpic');
    for (var i = 0; i < cvs.length; i++) {
      var hc = cvs[i], c = hc.getContext('2d'), W = hc.width, H = hc.height, t = now / 1000;
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
      c.fillStyle = '#1a1438'; rr(c, 0, 0, W, H, 18); c.fill();
      c.save(); rr(c, 0, 0, W, H, 18); c.clip();
      c.fillStyle = 'rgba(155,123,255,0.18)';
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
        c.font = '17px "Titan One"'; c.fillStyle = q > 0.8 ? '#ff4d6d' : '#fff'; c.fillText(q > 0.8 ? '00:00' : '01:29', w * 0.6 + 32, 69);
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
    SFX.click(); musicStop(); conf = []; fxDirty = true; show('over', false); resetFx(); newDemo(); mode = 'menu'; show('menu', true);
  });

  // ---------- boot ----------
  resize(); readSafe(); buildHole(); setMute(muted); newDemo();
  cam.x = demo.hx / 16; cam.y = demo.hy / 16;
  $('menuBest').textContent = best ? 'BEST ' + best : '';
  drawLogo();
  if (document.fonts && document.fonts.load) document.fonts.load('40px "Titan One"').then(drawLogo, function () {});
  document.addEventListener('visibilitychange', function () { last = null; });
  requestAnimationFrame(frame);
  if (params.get('auto') === '1') window.__bgAuto = { get: function () { return S; }, start: startRun, stickFn: demoStick, setStick: function (x, y) { stick.id = -7; stick.sx = x; stick.sy = y; }, mode: function () { return mode; } };
})();
