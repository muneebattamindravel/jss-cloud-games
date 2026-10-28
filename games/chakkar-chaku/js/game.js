/*
 * Chakkar Chaku: throw knives into a spinning log. Never hit a knife already stuck.
 *
 * Scored by the SERVER, which replays the throws this file records against the
 * session seed (shared/anticheat/validators/chakkarChaku.js). The rules block below
 * is carried word for word in that validator. A gameplay change is a trace
 * version bump, never an edit in place.
 *
 * Everything below the rules block is presentation. None of it may write to
 * the sim; drawing may use DMath and Math.random, the rules never do.
 */
(function () {
  'use strict';

// ==== CHAKKAR CHAKU RULES BEGIN ====
// Angles are integers out of TURN (3600 a turn). The log's rotation is kept in
// SUB parts of an angle unit so slow speeds stay whole numbers. Screen angle 0
// is straight down, where every thrown knife lands. A knife that lands while
// the log reads rotation r sticks at log angle (TURN - r) mod TURN.
var RULES_VERSION = 3;
var TURN = 3600;
var SUB = 16;
var TURN_SUB = TURN * SUB;
var FLY = 8;                // steps a knife is in the air
var TOL = 85;               // closer than this to a stuck knife ends the run
var APPLE_TOL = 120;        // within this of an apple takes it
var TRANS = 42;             // steps a new log takes to arrive (no throws)
var IDLE_WARN = 360;        // the wood starts to crack after 6 s without a throw
var IDLE_END = 600;         // and the run ends at 10 s
var MAX_STUCK = 12;         // pre-stuck plus required knives never exceed this
var BOSS_EVERY = 5;         // every 5th log is a boss
var V_BASE = 190;           // spin speed, sub-units a step, on log 1
var V_STEP = 24;            // plus this per log
var V_CAP_K = 18;           // up to log 19
var ACC = 10;               // speed change per step toward a keyframe
var ACC_REV = 26;           // sharper for reversing logs
var ACC_BOSS = 20;
var V3_BASE = 180;          // v3 spin speed, sub-units a step, on log 1
var V3_STEP = 22;           // plus this per log
var V3_CAP_K = 22;          // up to log 23
var V3_LATE_STEP = 5;       // then +5 a log, slower, up to log 41
var V3_LATE_CAP_K = 40;
var ACC_PULSE = 8;          // v3: speed breathes smoothly
var ACC_REV3 = 18;          // v3: a reversal is a visible slowing, not a snap
var NET_MIN = 43200;         // three quarters of a turn, in sub-units
var DRAWS = 32;             // draws per log, every log, whatever is used
var KNIFE_PTS = 1;
var APPLE_PTS = 2;
var CLEAR_PTS = 5;          // times the log number
var MAX_THROWS = 20000;
var SEED_MIX = 0x85EBCA6B;
var HASH_K = 0x9E3779B1;
var HASH_J = 0x85EBCA77;
var MIX_A = 0x7FEB352D;
var MIX_B = 0x846CA68B;

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

// Draw j of log k: a pure function of (seed, k, j).
function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, HASH_K) ^ Math.imul(j + 1, HASH_J)) | 0;
  h = Math.imul(h ^ (h >>> 16), MIX_A);
  h = Math.imul(h ^ (h >>> 15), MIX_B);
  return (h ^ (h >>> 16)) >>> 0;
}

function circ(a, b) {
  var d = (a - b) % TURN;
  if (d < 0) d += TURN;
  return d < TURN - d ? d : TURN - d;
}
function wrapSub(r) { r %= TURN_SUB; return r < 0 ? r + TURN_SUB : r; }
function isBoss(k) { return (k + 1) % BOSS_EVERY === 0; }
function speedOf(k) {
  var v = V_BASE + V_STEP * Math.min(k, V_CAP_K);
  return isBoss(k) ? Math.floor(v * 9 / 8) : v;
}

// v3: the spin patterns arrive gradually and repeat exactly. Logs 1 to 3 are
// steady. From log 4 the speed breathes (same direction). From log 7 a log
// may reverse, from log 11 it may stop and swing back. Every pattern is one
// fixed cycle of at most four keyframes, so a player can learn it in a turn
// or two; later logs shorten the holds and lengthen the stops.
function speedOf3(k) {
  var v = V3_BASE + V3_STEP * Math.min(k, V3_CAP_K) + V3_LATE_STEP * Math.max(0, Math.min(k, V3_LATE_CAP_K) - V3_CAP_K);
  return isBoss(k) ? Math.floor(v * 9 / 8) : v;
}
function spinPlan3(r, k, boss, dir, v) {
  var roll = r[1] % 100, kind, kf = [], acc = ACC, s = k < 6 ? 100 : Math.max(35, 100 - 2 * (k - 6));
  if (boss) kind = k < 9 ? 4 : k < 14 ? 1 : 2;
  else if (k < 3) kind = 0;
  else if (k < 6) kind = roll < 40 ? 0 : 4;
  else if (k < 10) kind = roll < 25 ? 0 : roll < 55 ? 4 : 1;
  else if (k < 15) kind = roll < 15 ? 0 : roll < 40 ? 4 : roll < 75 ? 1 : 2;
  else if (k < 30) kind = roll < 10 ? 0 : roll < 30 ? 4 : roll < 65 ? 1 : 2;
  else kind = roll < 15 ? 4 : roll < 50 ? 1 : 2;
  if (kind === 0) kf = [[dir * v, 600]];
  else if (kind === 4) {
    acc = ACC_PULSE;
    kf = [[dir * Math.floor(v * (135 + r[2] % 15) / 100), 70 + r[8] % 30], [dir * Math.floor(v * (55 + r[3] % 15) / 100), 70 + r[9] % 30]];
  } else if (kind === 1) {
    acc = boss ? ACC_BOSS : ACC_REV3;
    kf = [[dir * Math.floor(v * (95 + r[2] % 10) / 100), Math.floor((130 + r[8] % 50) * s / 100)],
          [-dir * Math.floor(v * (60 + r[3] % 10) / 100), Math.floor((40 + r[9] % 25) * s / 100)]];
    if (k >= 12) {
      kf.push([dir * Math.floor(v * (80 + r[4] % 10) / 100), Math.floor((70 + r[10] % 30) * s / 100)]);
      kf.push([-dir * Math.floor(v * (60 + r[5] % 10) / 100), Math.floor((50 + r[11] % 25) * s / 100)]);
    }
  } else {
    acc = boss ? ACC_BOSS : ACC;
    kf = [[dir * Math.floor(v * (130 + r[2] % 15) / 100), Math.floor((70 + r[8] % 30) * s / 100)],
          [0, 16 + r[9] % 12 + Math.min(34, k - 10)],
          [-dir * Math.floor(v * (25 + r[3] % 10) / 100), 35 + r[10] % 20]];
  }
  return { kind: kind, kf: kf, acc: acc };
}

function cycleNet(kf, acc) {
  var spd = kind0(kf) ? kf[0][0] : 0, net = 0;
  for (var pass = 0; pass < 2; pass++) {
    for (var i = 0; i < kf.length; i++) {
      for (var t = 0; t < kf[i][1]; t++) {
        if (spd < kf[i][0]) spd = Math.min(kf[i][0], spd + acc);
        else if (spd > kf[i][0]) spd = Math.max(kf[i][0], spd - acc);
        if (pass === 1) net += spd;
      }
    }
  }
  return net;
}
function kind0(kf) { return kf.length === 1; }

// Log k: its spin keyframes ([target speed, steps]), required knives,
// pre-stuck knives and apples. DRAWS draws on every index.
function logSpec(seed, k, version) {
  var r = [], j, i;
  for (j = 0; j < DRAWS; j++) r.push(hash(seed, k, j));
  var boss = isBoss(k), kind, kf, acc = ACC, dir = (r[0] & 1) ? 1 : -1;
  if (version >= 3) {
    var plan = spinPlan3(r, k, boss, dir, speedOf3(k));
    kind = plan.kind; kf = plan.kf; acc = plan.acc;
  } else {
  var v = speedOf(k), roll = r[1] % 100;
  // 0 steady (logs 1 and 2 only), 1 reversing, 2 surging (speed up, stop,
  // swing back), 3 boss. Patterns get longer and less regular with the log.
  kind = boss ? 3 : k < 2 ? 0 : k < 4 ? (roll < 60 ? 1 : 2) : (roll < 15 ? 0 : roll < 55 ? 1 : 2);
  var n = Math.min(6, 2 + Math.floor(k / 4));
  if (kind === 0) kf = [[dir * v, 600]];
  else if (kind === 1) {
    acc = ACC_REV; kf = [];
    for (i = 0; i < n; i++) {
      var back = i % 2 === 1;
      kf.push([(back ? -dir : dir) * Math.floor(v * (back ? 6 + r[2 + i] % 4 : 9 + r[2 + i] % 5) / 10), (back ? 35 : 60) + r[8 + i] % 60]);
    }
  } else if (kind === 2) {
    kf = [];
    for (i = 0; i < n; i++) {
      var ph = i % 3;
      kf.push([ph === 0 ? dir * Math.floor(v * (14 + r[2 + i] % 6) / 10) : ph === 1 ? 0 : -dir * Math.floor(v * (3 + r[2 + i] % 4) / 10),
               (ph === 1 ? 14 : 30) + r[8 + i] % (ph === 1 ? 26 : 50)]);
    }
  } else {
    acc = ACC_BOSS;
    var fast = Math.floor(v * 3 / 2);
    kf = [[dir * fast, 40 + r[2] % 40]];
    for (i = 0; i < 5; i++) kf.push([dir * Math.floor(v * ((r[4 + i] % 21) - 6) / 10), 20 + r[10 + i] % 45]);
  }
  }
  // Every cycle must carry the log at least NET_MIN forward, so every angle
  // comes round to the knife within a few seconds whatever the pattern.
  // Measured exactly: two passes of the cycle from rest, the second counted.
  for (var grow = 0; grow < 60 && cycleNet(kf, acc) * dir < NET_MIN; grow++) kf[0] = [kf[0][0], kf[0][1] + 20];
  var preMax = Math.min(5, 1 + Math.floor(k / 3));
  if (version >= 3 && k >= 20) preMax = k < 30 ? 6 : 7;   // crowded logs: pre-stuck + needed never exceed MAX_STUCK
  var pre = k === 0 ? 0 : k === 1 ? 1 : boss ? 1 + r[20] % 2 : 1 + r[20] % preMax;
  var need = boss ? 9 + Math.min(2, Math.floor(k / 10)) : 6 + Math.min(4, Math.floor(k / 3)) + (r[26] % 2);
  need = Math.min(need, MAX_STUCK - pre);
  var stuck = [], base = r[21] % TURN;
  for (i = 0; i < pre; i++) stuck.push((base + i * Math.floor(TURN / pre) + (r[22 + i] % 300) - 150 + TURN) % TURN);
  var nApples = boss ? r[27] % 2 : k === 0 ? r[27] % 2 : r[27] % 3, apples = [];
  for (i = 0; i < nApples; i++) {
    var a = r[28 + i] % TURN;
    for (var tries = 0; tries < 8; tries++) {
      var clear = true;
      for (j = 0; j < stuck.length; j++) if (circ(a, stuck[j]) < TOL + 60) clear = false;
      for (j = 0; j < apples.length; j++) if (circ(a, apples[j]) < APPLE_TOL * 2) clear = false;
      if (clear) break;
      a = (a + 450) % TURN;
    }
    apples.push(a);
  }
  return { k: k, boss: boss, kind: kind, kf: kf, acc: acc, need: need, stuck: stuck, apples: apples, rot0: (r[30] % TURN) * SUB };
}

function nextLog(sim) {
  var k = sim.log + 1, spec = logSpec(sim.seed, k, sim.version);
  sim.log = k; sim.spec = spec;
  sim.rot = spec.rot0; sim.spd = kind0(spec.kf) ? spec.kf[0][0] : 0;
  sim.kfi = 0; sim.kfLeft = spec.kf[0][1];
  sim.stuck = spec.stuck.slice(); sim.apples = spec.apples.slice(); sim.left = spec.need;
  sim.trans = TRANS;
}

function initSim(seedHex, version) {
  var sim = {
    version: version, seed: seedToInt(seedHex), step: 0, throws: 0, score: 0,
    dead: false, deathStep: -1, cause: '', log: -1, spec: null,
    rot: 0, spd: 0, kfi: 0, kfLeft: 0, stuck: [], apples: [], left: 0,
    fly: -1, trans: 0, lastAct: 0, events: []
  };
  nextLog(sim);
  return sim;
}

// Steps since the player could last have thrown and did not.
function idleSteps(sim) { return sim.trans > 0 || sim.fly >= 0 ? 0 : sim.step - sim.lastAct; }

// A throw leaves the hand at once. Refused (and never recorded) while a knife
// is in the air, while a log arrives, or once the run is over.
function throwSim(sim) {
  if (sim.dead || sim.fly >= 0 || sim.trans > 0 || sim.throws >= MAX_THROWS) return false;
  sim.fly = FLY; sim.throws++; sim.lastAct = sim.step;
  return true;
}

function stepSim(sim) {
  var ev = [];
  sim.events = ev;
  if (sim.dead) return;
  var t = ++sim.step;
  if (sim.trans > 0) {
    sim.trans--;
    if (sim.trans === 0) { sim.lastAct = t; ev.push({ t: 'ready', k: sim.log }); }
    return;
  }
  var spec = sim.spec, target = spec.kf[sim.kfi][0];
  if (sim.spd < target) sim.spd = Math.min(target, sim.spd + spec.acc);
  else if (sim.spd > target) sim.spd = Math.max(target, sim.spd - spec.acc);
  sim.rot = wrapSub(sim.rot + sim.spd);
  if (--sim.kfLeft <= 0) { sim.kfi = (sim.kfi + 1) % spec.kf.length; sim.kfLeft = spec.kf[sim.kfi][1]; }
  if (sim.fly >= 0 && --sim.fly === 0) {
    sim.fly = -1;
    var a = (TURN - Math.floor(sim.rot / SUB)) % TURN, i;
    for (i = 0; i < sim.stuck.length; i++) {
      if (circ(a, sim.stuck[i]) < TOL) {
        sim.dead = true; sim.deathStep = t; sim.cause = 'knife';
        ev.push({ t: 'clang', a: a, s: sim.stuck[i] });
        return;
      }
    }
    var keep = [];
    for (i = 0; i < sim.apples.length; i++) {
      if (circ(a, sim.apples[i]) < APPLE_TOL) { sim.score += APPLE_PTS; ev.push({ t: 'apple', a: sim.apples[i] }); }
      else keep.push(sim.apples[i]);
    }
    sim.apples = keep;
    sim.stuck = sim.stuck.concat([a]);
    sim.score += KNIFE_PTS; sim.left--;
    ev.push({ t: 'stick', a: a, left: sim.left, n: spec.need - sim.left });
    if (sim.left === 0) {
      var bonus = CLEAR_PTS * (sim.log + 1);
      sim.score += bonus;
      ev.push({ t: 'clear', k: sim.log, bonus: bonus, stuck: sim.stuck, rot: sim.rot, boss: spec.boss });
      nextLog(sim);
    }
    return;
  }
  if (sim.fly < 0 && t - sim.lastAct >= IDLE_END) {
    sim.dead = true; sim.deathStep = t; sim.cause = 'idle';
    ev.push({ t: 'idle' });
  }
}
// ==== CHAKKAR CHAKU RULES END ====

  // ── shell ────────────────────────────────────────────────────────────────
  var STEP_MS = 1000 / 60, MAX_CATCHUP = 3;
  var W = 414, H = 736, BAND_TOP = 96, BAND_BOT = 704;
  var CX = 207, CY = 300, R = 100;           // the log
  var EMBED_PX = 30;                         // a stuck blade sinks this far into the wood
  var KNIFE_TIP_Y = 584;                     // the waiting knife's tip
  var KN_LEN = 100, BLADE = 56;              // knife length, blade part (tip at 0)
  var DEG = Math.PI * 2 / TURN;
  var FONT = "'Titan One', system-ui, sans-serif";
  var Q = /[?&]/.test(location.search) ? location.search : '';
  var EMBED = !!window.__kjEmbed;
  function qp(name) { if (EMBED) return null; var m = new RegExp('[?&]' + name + '=([^&]*)').exec(Q); return m ? decodeURIComponent(m[1]) : null; }
  var PERF = qp('perf') === '1';
  var ICON = qp('icon') === '1';
  var DM = window.DMath || Math;
  function sin(x) { return DM.sin(x); }
  function cos(x) { return DM.cos(x); }

  var canvas = document.getElementById('scene');
  var ctx = canvas.getContext('2d');
  var dpr = 1, cw = 0, ch = 0, fit = null, sc = 1, ox = 0, oy = 0;
  var bgCanvas = null, knifeImg = null, knifeIcon = null, appleImg = null, shadowImg = null, handImg = null;
  var logCache = {};

  function mk(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function rnd(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return (s >>> 8) / 16777216; }; }

  // ── sprites, all drawn once ──────────────────────────────────────────────
  // The log face: bark rim, light sapwood, growth rings, a few checks and the
  // dark pith. A boss is banded in steel. Built once per log at screen scale.
  function buildLog(k, boss) {
    var key = k + (boss ? 'b' : '');
    if (logCache[key]) return logCache[key];
    var px = sc * dpr, pad = 10, size = (R + pad) * 2, c = mk(size * px, size * px), g = c.getContext('2d');
    var rr = rnd(k * 7919 + 13), m = R + pad, i, a;
    g.scale(px, px);
    // bark: a rough edge
    g.beginPath();
    for (i = 0; i <= 72; i++) {
      a = i / 72 * Math.PI * 2;
      var br = R + 1.5 + (rr() - 0.5) * 3.2;
      if (i === 0) g.moveTo(m + Math.cos(a) * br, m + Math.sin(a) * br); else g.lineTo(m + Math.cos(a) * br, m + Math.sin(a) * br);
    }
    g.closePath();
    var bg = g.createRadialGradient(m - 20, m - 25, R * 0.6, m, m, R + 2);
    bg.addColorStop(0, '#6b3d1c'); bg.addColorStop(1, '#3a1f0c');
    g.fillStyle = bg; g.fill();
    g.lineWidth = 2.4; g.strokeStyle = '#24120a'; g.stroke();
    // bark grooves
    g.strokeStyle = 'rgba(25,12,4,0.55)'; g.lineWidth = 1.4;
    for (i = 0; i < 40; i++) {
      a = rr() * Math.PI * 2;
      g.beginPath(); g.moveTo(m + Math.cos(a) * (R - 9), m + Math.sin(a) * (R - 9)); g.lineTo(m + Math.cos(a) * (R + 1), m + Math.sin(a) * (R + 1)); g.stroke();
    }
    // the cut face
    var fr = R - 11;
    var fg = g.createRadialGradient(m - 18, m - 24, 6, m, m, fr);
    fg.addColorStop(0, '#f2cf93'); fg.addColorStop(0.7, '#dfaa66'); fg.addColorStop(1, '#c78c4a');
    g.beginPath(); g.arc(m, m, fr, 0, Math.PI * 2); g.fillStyle = fg; g.fill();
    g.lineWidth = 3; g.strokeStyle = '#a8692f'; g.stroke();
    // growth rings, slightly wobbly
    var ox2 = (rr() - 0.5) * 6, oy2 = (rr() - 0.5) * 6;
    for (var ring = 1; ring <= 9; ring++) {
      var rad = fr * ring / 10;
      g.beginPath();
      for (i = 0; i <= 48; i++) {
        a = i / 48 * Math.PI * 2;
        var wob = rad + Math.sin(a * 3 + ring) * 1.2 + (rr() - 0.5) * 0.8;
        var x = m + ox2 * (1 - ring / 10) + Math.cos(a) * wob, y = m + oy2 * (1 - ring / 10) + Math.sin(a) * wob;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.lineWidth = ring % 3 === 0 ? 2.2 : 1.2;
      g.strokeStyle = 'rgba(150,88,38,' + (ring % 3 === 0 ? 0.55 : 0.32) + ')';
      g.stroke();
    }
    // checks (cracks from the middle)
    g.strokeStyle = 'rgba(110,60,22,0.6)'; g.lineWidth = 1.6; g.lineCap = 'round';
    var nc = 2 + Math.floor(rr() * 3);
    for (i = 0; i < nc; i++) {
      a = rr() * Math.PI * 2;
      var len = fr * (0.35 + rr() * 0.4);
      g.beginPath(); g.moveTo(m + ox2 + Math.cos(a) * 6, m + oy2 + Math.sin(a) * 6);
      g.lineTo(m + Math.cos(a + 0.08) * len * 0.6, m + Math.sin(a + 0.08) * len * 0.6);
      g.lineTo(m + Math.cos(a - 0.03) * len, m + Math.sin(a - 0.03) * len); g.stroke();
    }
    // pith
    g.beginPath(); g.arc(m + ox2, m + oy2, 4.5, 0, Math.PI * 2); g.fillStyle = '#8c5420'; g.fill();
    // a soft top light
    var lg = g.createLinearGradient(0, m - fr, 0, m + fr);
    lg.addColorStop(0, 'rgba(255,240,200,0.18)'); lg.addColorStop(0.5, 'rgba(255,240,200,0)'); lg.addColorStop(1, 'rgba(60,25,5,0.18)');
    g.beginPath(); g.arc(m, m, fr, 0, Math.PI * 2); g.fillStyle = lg; g.fill();
    if (boss) {
      // a steel band round the rim and a strap across, riveted
      var steel = function (w) {
        var sg = g.createLinearGradient(0, m - R, 0, m + R);
        sg.addColorStop(0, '#e9eef2'); sg.addColorStop(0.45, '#8e98a1'); sg.addColorStop(1, '#4c545b');
        g.strokeStyle = sg; g.lineWidth = w;
      };
      steel(10); g.beginPath(); g.arc(m, m, R - 5, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = '#2b3036';
      g.beginPath(); g.arc(m, m, R, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(m, m, R - 10, 0, Math.PI * 2); g.stroke();
      g.save(); g.beginPath(); g.arc(m, m, fr, 0, Math.PI * 2); g.clip();
      var strap = g.createLinearGradient(m - 9, 0, m + 9, 0);
      strap.addColorStop(0, '#5a636b'); strap.addColorStop(0.4, '#d9e0e5'); strap.addColorStop(1, '#4c545b');
      g.fillStyle = strap; g.fillRect(m - 9, m - fr, 18, fr * 2);
      g.strokeStyle = '#2b3036'; g.lineWidth = 1.5; g.strokeRect(m - 9, m - fr - 2, 18, fr * 2 + 4);
      g.restore();
      var rivet = function (x, y) {
        g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fillStyle = '#c8d0d6'; g.fill();
        g.lineWidth = 1; g.strokeStyle = '#30363c'; g.stroke();
      };
      for (i = 0; i < 12; i++) { a = i / 12 * Math.PI * 2; rivet(m + Math.cos(a) * (R - 5), m + Math.sin(a) * (R - 5)); }
      for (i = -3; i <= 3; i++) rivet(m, m + i * fr / 4);
    }
    logCache[key] = c;
    return c;
  }
  // The knife, pointing up, tip at the top of the sprite.
  function buildKnife(scale) {
    var px = sc * dpr * scale, w = 30, c = mk(w * px, (KN_LEN + 4) * px), g = c.getContext('2d'), mx = w / 2;
    g.scale(px, px); g.translate(0, 2);
    // blade
    g.beginPath(); g.moveTo(mx, 0); g.quadraticCurveTo(mx + 8, 18, mx + 7, BLADE); g.lineTo(mx - 7, BLADE); g.quadraticCurveTo(mx - 7, 20, mx, 0); g.closePath();
    var bg = g.createLinearGradient(mx - 7, 0, mx + 8, 0);
    bg.addColorStop(0, '#9aa5ae'); bg.addColorStop(0.45, '#f5f8fa'); bg.addColorStop(0.55, '#c9d1d7'); bg.addColorStop(1, '#6d7880');
    g.fillStyle = bg; g.fill(); g.lineWidth = 1.6; g.strokeStyle = '#2f353a'; g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(mx + 0.5, 6); g.lineTo(mx + 1, BLADE - 3); g.stroke();
    // guard
    var gg = g.createLinearGradient(0, BLADE, 0, BLADE + 7);
    gg.addColorStop(0, '#ffd56a'); gg.addColorStop(1, '#a8701c');
    g.beginPath(); g.roundRect ? g.roundRect(mx - 12, BLADE, 24, 7, 3) : g.rect(mx - 12, BLADE, 24, 7);
    g.fillStyle = gg; g.fill(); g.lineWidth = 1.4; g.strokeStyle = '#4a2c08'; g.stroke();
    // handle
    var hy = BLADE + 7, hl = KN_LEN - hy - 6;
    var hg = g.createLinearGradient(mx - 6, 0, mx + 6, 0);
    hg.addColorStop(0, '#5a2e12'); hg.addColorStop(0.45, '#a8622c'); hg.addColorStop(1, '#4a250e');
    g.beginPath(); g.roundRect ? g.roundRect(mx - 6, hy, 12, hl, 4) : g.rect(mx - 6, hy, 12, hl);
    g.fillStyle = hg; g.fill(); g.lineWidth = 1.4; g.strokeStyle = '#2a1406'; g.stroke();
    g.strokeStyle = 'rgba(40,18,4,0.5)'; g.lineWidth = 1;
    for (var i = 1; i < 4; i++) { g.beginPath(); g.moveTo(mx - 5, hy + i * hl / 4); g.lineTo(mx + 5, hy + i * hl / 4 - 2); g.stroke(); }
    // pommel
    g.beginPath(); g.ellipse(mx, KN_LEN - 4, 7.5, 4.5, 0, 0, Math.PI * 2); g.fillStyle = gg; g.fill(); g.lineWidth = 1.4; g.strokeStyle = '#4a2c08'; g.stroke();
    return c;
  }
  function buildApple() {
    var px = sc * dpr, s = 34, c = mk(s * px, s * px), g = c.getContext('2d');
    g.scale(px, px);
    var ag = g.createRadialGradient(13, 15, 2, 17, 19, 14);
    ag.addColorStop(0, '#ff8a7a'); ag.addColorStop(0.5, '#e8262a'); ag.addColorStop(1, '#9e0f16');
    g.beginPath(); g.moveTo(17, 10);
    g.bezierCurveTo(24, 5, 31, 11, 30, 19); g.bezierCurveTo(29, 27, 22, 31, 17, 29);
    g.bezierCurveTo(12, 31, 5, 27, 4, 19); g.bezierCurveTo(3, 11, 10, 5, 17, 10); g.closePath();
    g.fillStyle = ag; g.fill(); g.lineWidth = 1.6; g.strokeStyle = '#5c0a0e'; g.stroke();
    g.strokeStyle = '#4a2a10'; g.lineWidth = 2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(17, 10); g.quadraticCurveTo(17, 5, 19, 2); g.stroke();
    g.beginPath(); g.moveTo(19, 5); g.quadraticCurveTo(25, 1, 28, 5); g.quadraticCurveTo(24, 8, 19, 5); g.fillStyle = '#4caf3a'; g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.ellipse(11, 15, 2.5, 4, -0.4, 0, Math.PI * 2); g.fill();
    return c;
  }
  function buildShadow() {
    var px = sc * dpr, s = (R + 40) * 2, c = mk(s * px, s * px), g = c.getContext('2d');
    g.scale(px, px);
    var sg = g.createRadialGradient(s / 2, s / 2, R * 0.7, s / 2, s / 2, R + 36);
    sg.addColorStop(0, 'rgba(0,0,0,0.55)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg; g.fillRect(0, 0, s, s);
    return c;
  }
  // Dark wooden planks with a warm spotlight on the log, at screen size.
  function buildBg() {
    var c = mk(canvas.width, canvas.height), g = c.getContext('2d'), rr = rnd(77);
    g.fillStyle = '#2a170b'; g.fillRect(0, 0, c.width, c.height);
    var pw = 66 * sc * dpr, x0 = ox * dpr + CX * sc * dpr - pw * 3.5;
    while (x0 > 0) x0 -= pw;
    for (var x = x0, n = 0; x < c.width; x += pw, n++) {
      var tone = 28 + Math.floor(rr() * 14);
      g.fillStyle = 'rgb(' + (tone + 22) + ',' + (tone + 6) + ',' + Math.floor(tone / 2) + ')';
      g.fillRect(x, 0, pw - 2 * dpr, c.height);
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1.2 * dpr;
      for (var l = 0; l < 6; l++) {
        var lx = x + rr() * pw, wav = 3 + rr() * 6;
        g.beginPath();
        for (var y = 0; y <= c.height; y += 30 * dpr) g.lineTo(lx + Math.sin(y / (40 * dpr) + l) * wav * dpr, y);
        g.stroke();
      }
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x + pw - 2 * dpr, 0, 2 * dpr, c.height);
    }
    var lx2 = ox * dpr + CX * sc * dpr, ly = oy * dpr + CY * sc * dpr, big = Math.max(c.width, c.height);
    var spot = g.createRadialGradient(lx2, ly, R * sc * dpr * 0.6, lx2, ly, big * 0.75);
    spot.addColorStop(0, 'rgba(255,190,110,0.32)'); spot.addColorStop(0.35, 'rgba(255,150,60,0.10)'); spot.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = spot; g.fillRect(0, 0, c.width, c.height);
    var vg = g.createLinearGradient(0, 0, 0, c.height);
    vg.addColorStop(0, 'rgba(0,0,0,0.35)'); vg.addColorStop(0.5, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vg; g.fillRect(0, 0, c.width, c.height);
    return c;
  }
  // The approved flat hand, in this game's palette. (24.5, 12) is the fingertip.
  var HAND_W = 64, HAND_H = 100;
  function buildHandSprite() {
    var k = 4, c = mk(HAND_W * k, HAND_H * k), g = c.getContext('2d'); g.scale(k, k);
    g.lineWidth = 3.2; g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = '#2a1406';
    var rr2 = function (x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    var shape = function (fill) { g.fillStyle = fill; g.fill(); g.stroke(); };
    rr2(8, 40, 50, 44, 14); shape('#fff6e6');
    rr2(16, 12, 17, 44, 8.5); shape('#fff6e6');
    rr2(32, 38, 13, 20, 6.5); shape('#fff6e6');
    rr2(44, 41, 12, 19, 6); shape('#fff6e6');
    rr2(54, 45, 7, 17, 3.5); shape('#fff6e6');
    g.save(); g.translate(26, 66); g.rotate(-0.35); rr2(-15, -7, 30, 14, 7); shape('#fff6e6'); g.restore();
    rr2(12, 84, 42, 13, 4); shape('#f4a62a');
    return c;
  }

  function resize() {
    var w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
    var d = Math.min(3, window.devicePixelRatio || 1);
    if (w === cw && h === ch && d === dpr) return;
    cw = w || 1; ch = h || 1; dpr = d;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    fit = window.KJFit.compute({ boxW: cw, boxH: ch, W: W, H: H, bandTop: BAND_TOP, bandBottom: BAND_BOT, anchor: 'center' });
    sc = fit.s; ox = fit.offX; oy = fit.offY;
    logCache = {}; bgCanvas = buildBg(); knifeImg = buildKnife(1); knifeIcon = buildKnife(0.32);
    appleImg = buildApple(); shadowImg = buildShadow();
  }
  window.addEventListener('resize', resize);
  setInterval(resize, 500);
  resize();

  // ── state ────────────────────────────────────────────────────────────────
  var state = 'menu';                 // menu | prac | play | dying | over
  var sim = initSim(null, RULES_VERSION);
  var traceVersion = 0, submitted = false;
  var acc = 0, lastT = null, frameAvg = 0, clockLag = 0, clock = 0;
  var scoreShown = 0;
  var fx = { chips: [], slices: [], flyers: [], texts: [], jolt: 0, shake: 0, flash: 0, flashCol: '#fff', wobble: 0, wobbleA: 0,
             reload: 1, arrive: 0, banner: null, warnSec: 0, crack: null };
  var death = null, dieAt = 0;
  var menuRot = 0;
  var MENU_STUCK = [300, 1250, 2500];

  var $ = function (id) { return document.getElementById(id); };
  function show(el, on) {
    if (on) { el.classList.remove('is-gone'); requestAnimationFrame(function () { el.classList.remove('is-hidden'); }); }
    else { el.classList.add('is-hidden'); setTimeout(function () { if (el.classList.contains('is-hidden')) el.classList.add('is-gone'); }, 300); }
  }
  $('playBtn').onclick = function () { audio.unlock(); if (shouldPractice()) startPractice(); else start(); };
  $('howBtn').onclick = function () { audio.unlock(); startPractice(); };
  $('againBtn').onclick = function () { audio.unlock(); start(); };
  $('homeBtn').onclick = function () {
    state = 'menu'; sim = initSim(null, RULES_VERSION); death = null;
    show($('over'), false); show($('menu'), true);
  };

  function drawLogo() {
    var c = $('logo'), g = c.getContext('2d');
    var go = function () {
      g.clearRect(0, 0, c.width, c.height);
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      var line = function (txt, y, size) {
        g.font = size + 'px ' + FONT;
        g.lineWidth = size * 0.2; g.strokeStyle = '#1a0b03'; g.strokeText(txt, 320, y + size * 0.07);
        g.strokeText(txt, 320, y);
        var gr = g.createLinearGradient(0, y - size / 2, 0, y + size / 2);
        gr.addColorStop(0, '#ffe7a8'); gr.addColorStop(0.55, '#f2a43a'); gr.addColorStop(1, '#b55e17');
        g.fillStyle = gr; g.fillText(txt, 320, y);
      };
      line('CHAKKAR', 76, 104);
      line('CHAKU', 228, 112);
      // a knife across the gap between the words
      g.save(); g.translate(320, 152); g.rotate(-0.08);
      g.beginPath(); g.moveTo(-150, 0); g.lineTo(40, -9); g.lineTo(52, 0); g.lineTo(40, 9); g.closePath();
      var bl = g.createLinearGradient(0, -9, 0, 9); bl.addColorStop(0, '#f5f8fa'); bl.addColorStop(1, '#7c878f');
      g.fillStyle = bl; g.fill(); g.lineWidth = 4; g.strokeStyle = '#1a0b03'; g.stroke();
      g.fillStyle = '#f2a43a'; g.fillRect(-162, -14, 12, 28); g.strokeRect(-162, -14, 12, 28);
      g.fillStyle = '#8a4a1c'; g.fillRect(-236, -8, 74, 16); g.strokeRect(-236, -8, 74, 16);
      g.restore();
    };
    if (document.fonts && document.fonts.load) document.fonts.load('116px "Titan One"').then(go, go); else go();
    go();
  }
  drawLogo();

  // ── platform ─────────────────────────────────────────────────────────────
  var RP = (window.KJReplay && window.KJReplay.active()) ? window.KJReplay : null;
  var replayThrows = null;
  if (RP) RP.ready('chakkar-chaku');
  var sessionReady = false;
  function onSessionReady() {
    sessionReady = true;
    var b = $('playBtn');
    b.disabled = false; b.textContent = 'PLAY'; b.classList.add('play-pulse');
    if (RP) start();
  }
  if (typeof window.__kjOnSessionReady === 'function') window.__kjOnSessionReady(onSessionReady);
  else onSessionReady();

  function localSeed() {
    var s = qp('seed');
    if (s && /^[0-9a-f]{16}/i.test(s)) return s;
    var h = '';
    for (var i = 0; i < 16; i++) h += Math.floor(Math.random() * 16).toString(16);
    return h;
  }

  function start() {
    if (!sessionReady || state === 'play') return;
    if (EMBED && submitted) return;
    traceVersion = (typeof window.__kjGameStart === 'function')
      ? (Number(window.__kjGameStart(performance.now(), RULES_VERSION)) || 0) : RULES_VERSION;
    if (RP) {
      traceVersion = RP.capVersion(traceVersion);
      replayThrows = RP.cursor('throw', function (e) { return Number(e.step); });
      RP.started(traceVersion);
    }
    // The rules follow the version the trace records (3 now; a replayed older run plays its own).
    var playVersion = traceVersion >= 3 ? 3 : traceVersion === 2 ? 2 : RULES_VERSION;
    sim = initSim(window.__kjSeed || (EMBED ? null : localSeed()), playVersion);
    // standalone QA: ?log=N starts at log N (never inside the platform)
    var skip = Number(qp('log')) || 0;
    while (skip-- > 1) nextLog(sim);
    leavePractice();
    show($('menu'), false); show($('over'), false);
    state = 'play'; acc = 0; submitted = false; scoreShown = 0; death = null;
    fx.chips = []; fx.slices = []; fx.flyers = []; fx.texts = []; fx.crack = null; fx.reload = 1; fx.arrive = 0;
    announceLog();
  }
  function announceLog() { fx.banner = sim.spec.boss ? { text: 'BOSS LOG', t: 0 } : null; if (sim.spec.boss) audio.boss(); }

  function press() {
    if (RP) return;
    if (state === 'prac') { pracTap(); return; }
    if (state !== 'play') return;
    throwKnife(true);
  }
  // One path for a live throw and a replayed one.
  function throwKnife(live) {
    var n = sim.throws, step = sim.step;
    if (!throwSim(sim)) return false;
    audio.whoosh();
    fx.reload = 0;
    if (live) { try { if (typeof window.__kjThrow === 'function') window.__kjThrow(performance.now(), n, step); } catch (_e) {} }
    return true;
  }
  function finishRun() {
    if (state !== 'dying') return;
    state = 'over'; submitted = true;
    if (RP) RP.setStep(sim.deathStep >= 0 ? sim.deathStep : sim.step);
    try { if (typeof window.__kjSubmit === 'function') window.__kjSubmit(sim.score); } catch (_e) {}
    if (!EMBED) { $('overScore').textContent = sim.score; show($('over'), true); }
  }
  window.KJPress.bind(press, {
    keys: ['Space', 'Enter', 'ArrowUp'],
    ignore: function (e) { return (state !== 'play' && state !== 'prac') || (e.target && e.target.closest && e.target.closest('button')); }
  });
  ['touchstart', 'touchmove'].forEach(function (n) {
    canvas.addEventListener(n, function (e) { e.preventDefault(); }, { passive: false });
  });

  // ── hands-on practice (outside the scored run) ───────────────────────────
  // Its own log, its own knives, real seconds. Never calls the bridge, never
  // touches `sim`. Quick on purpose: 1 the log freezes almost at once, "Tap to
  // throw". 2 the log whirls the knife just thrown round to the landing spot
  // and freezes, "Wait for the gap". 3 it glides on and freezes clear, "Tap now".
  var PRAC_SPD = 720;                  // angle units a second
  var prac = null;
  function shouldPractice() { return !RP && !!window.KJTut && window.KJTut.shouldShow() && !(EMBED && submitted); }
  function startPractice() {
    if (RP || state !== 'menu' || (EMBED && submitted)) return false;
    if (window.KJTut) window.KJTut.markSeen();
    prac = { phase: 'spin', t: 0, pt: 0, rot: 0, stuck: [], fly: -1, frozen: false, cap: '', hand: false, shownAt: 0, nudge: -9, ready: false, glide: null };
    fx.chips = []; fx.texts = []; fx.reload = 1;
    state = 'prac';
    show($('menu'), false); show($('over'), false);
    $('pskip').hidden = false;
    return true;
  }
  function pracScreenAngle(a) { var s2 = (a + prac.rot) % TURN; return s2 < 0 ? s2 + TURN : s2; }
  function pracFreeze(phase, cap, hand) { prac.phase = phase; prac.pt = 0; prac.frozen = true; prac.cap = cap; prac.hand = hand; prac.shownAt = prac.t; }
  // Turn the log so the stuck knife ends at screen angle `to`, eased, in `dur` s.
  function pracGlide(phase, to, dur) {
    var from = prac.rot, cur = pracScreenAngle(prac.stuck[0]), d = (to - cur) % TURN;
    if (d < 0) d += TURN;
    prac.phase = phase; prac.pt = 0; prac.frozen = false; prac.cap = ''; prac.hand = false;
    prac.glide = { from: from, d: d, dur: dur };
  }
  function pracTap() {
    var p = prac;
    if (!p || p.ready || p.fly >= 0) return;
    if (p.phase === 'aim1' || p.phase === 'aim2') {
      p.frozen = false; p.hand = false; p.cap = ''; p.fly = 0; fx.reload = 0;
      audio.whoosh();
      return;
    }
    if (p.phase === 'danger') { p.nudge = p.t; fx.flash = 0.25; fx.flashCol = '#ff4a3a'; }
  }
  function pracUpdate(dts) {
    var p = prac;
    if (!p || p.ready) return;
    p.t += dts; p.pt += dts;
    if (p.glide) {
      var g = p.glide, k = Math.min(1, p.pt / g.dur), e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
      p.rot = (g.from + g.d * e) % TURN;
      if (k >= 1) {
        p.glide = null;
        if (p.phase === 'whirl') pracFreeze('danger', 'Wait for the gap', false);
        else pracFreeze('aim2', 'Tap now', true);
      }
      return;
    }
    if (!p.frozen) p.rot = (p.rot + PRAC_SPD * dts) % TURN;
    if (p.fly >= 0) {
      p.fly += dts;
      if (p.fly >= FLY / 60) {
        p.fly = -1;
        p.stuck = p.stuck.concat([(TURN - Math.floor(p.rot)) % TURN]);
        hitFx(p.stuck.length);
        p.phase = p.phase === 'aim1' ? 'after1' : 'after2'; p.pt = 0;
      }
      return;
    }
    if (p.phase === 'spin' && p.pt > 0.45) pracFreeze('aim1', 'Tap to throw', true);
    else if (p.phase === 'after1' && p.pt > 0.25) pracGlide('whirl', TURN - 140, 0.85);
    else if (p.phase === 'danger' && p.pt > 1.3) pracGlide('pass', 1000, 0.6);
    else if (p.phase === 'after2' && p.pt > 0.45) pracReady();
  }
  function pracReady() {
    if (!prac || prac.ready) return;
    prac.ready = true; prac.cap = ''; prac.hand = false; prac.frozen = false;
    $('pskip').hidden = true;
    show($('pready'), true);
    audio.clear();
  }
  function leavePractice() {
    if (state === 'prac') state = 'menu';
    prac = null;
    $('pskip').hidden = true;
    var pr = $('pready'); if (!pr.classList.contains('is-gone')) show(pr, false);
    fx.chips = []; fx.texts = [];
  }
  $('pskip').onclick = function () { audio.unlock(); if (state === 'prac' && prac) pracReady(); };
  $('pplayBtn').onclick = function () {
    audio.unlock();
    if (state !== 'prac' || !prac || !prac.ready) return;
    leavePractice(); start();
  };

  // ── audio: Web Audio only ────────────────────────────────────────────────
  // Every hit is layered: a low body thump, a woody knock, and the knife's
  // twang, which climbs a pentatonic step with every knife in the log so a
  // log fills up audibly. A short generated room reverb gives it space.
  var audio = (function () {
    var AC = null, dry = null, wet = null, noise = null;
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      noise = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
      var nd = noise.getChannelData(0), i;
      for (i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      var comp = AC.createDynamicsCompressor(), master = AC.createGain();
      comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 5; comp.attack.value = 0.002; comp.release.value = 0.12;
      comp.connect(master); master.gain.value = 0.95; master.connect(AC.destination);
      var len = Math.floor(AC.sampleRate * 0.7), ir = AC.createBuffer(2, len, AC.sampleRate);
      for (var c = 0; c < 2; c++) { var d = ir.getChannelData(c); for (i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
      var conv = AC.createConvolver(); conv.buffer = ir;
      var wg = AC.createGain(); wg.gain.value = 0.22; conv.connect(wg); wg.connect(comp);
      dry = AC.createGain(); dry.connect(comp);
      wet = AC.createGain(); wet.connect(conv); wet.connect(comp);
    } catch (e) { AC = null; }
    function ok() { return !!AC && AC.state === 'running'; }
    function unlock() { if (AC && AC.state !== 'running') { try { AC.resume(); } catch (e) {} } }
    ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (ev) { window.addEventListener(ev, unlock, true); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') unlock(); });
    // send: 0 dry only, 1 into the room as well
    function osc(type, f0, f1, glide, t, dur, peak, attack, send) {
      var o = AC.createOscillator(), g = AC.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + (attack || 0.003));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(send ? wet : dry); o.start(t); o.stop(t + dur + 0.05);
      return o;
    }
    function nz(t, dur, peak, type, freq, q, f1, send) {
      var src = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
      src.buffer = noise; f.type = type; f.frequency.setValueAtTime(freq, t); if (q) f.Q.value = q;
      if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(send ? wet : dry); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
    }
    var PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26];
    function semi(n) { return Math.pow(2, n / 12); }
    // A plucked, slightly wobbling metal note: the knife quivering in the wood.
    function twang(f, t, peak) {
      var o = AC.createOscillator(), g = AC.createGain(), lfo = AC.createOscillator(), lg = AC.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(f * 1.03, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
      lfo.frequency.value = 24; lg.gain.value = f * 0.012; lfo.connect(lg); lg.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g); g.connect(wet); o.start(t); lfo.start(t); o.stop(t + 0.5); lfo.stop(t + 0.5);
    }
    return {
      unlock: unlock,
      whoosh: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        nz(t, 0.11, 0.32, 'bandpass', 3200, 1.6, 700);
        osc('sine', 3400, 2600, 0.05, t, 0.05, 0.035, 0.002);
      },
      // n = knives now in this log (1 for the first)
      thunk: function (n) {
        if (!ok()) return;
        var t = AC.currentTime, step = PENTA[Math.min(PENTA.length - 1, Math.max(0, (n || 1) - 1))], k = semi(step);
        osc('sine', 120, 52, 0.09, t, 0.17, 0.75, 0.002);                // body
        nz(t, 0.07, 0.55, 'bandpass', 620 * Math.sqrt(k), 3.5, 0, 0);     // woody knock
        nz(t, 0.016, 0.35, 'highpass', 3500);                             // bite
        osc('square', 880 * Math.sqrt(k), 440, 0.02, t, 0.03, 0.05, 0.001);
        twang(330 * k, t + 0.008, 0.13);
      },
      apple: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        nz(t, 0.22, 0.55, 'lowpass', 2600, 1.2, 280);
        osc('sine', 520, 170, 0.12, t, 0.16, 0.32, 0.002);
        for (var i = 0; i < 4; i++) osc('sine', 1400 + Math.random() * 1600, 0, 0, t + 0.05 + i * 0.035, 0.05, 0.05, 0.002, 1);
        [784, 1175].forEach(function (f, i) { osc('triangle', f, 0, 0, t + 0.08 + i * 0.07, 0.25, 0.09, 0.003, 1); });
      },
      clang: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        [1, 2.41, 3.98, 5.43, 7.12].forEach(function (m, i) { osc('sine', 690 * m, 0, 0, t, 1.4 - i * 0.2, 0.2 / (1 + i * 0.6), 0.001, 1); });
        nz(t, 0.06, 0.6, 'highpass', 2500);
        osc('triangle', 160, 70, 0.25, t, 0.32, 0.35, 0.002);
        osc('sine', 2300, 0, 0, t + 0.22, 0.25, 0.06, 0.002, 1);          // the bounce
      },
      clear: function () {
        if (!ok()) return;
        var t = AC.currentTime, i;
        osc('sine', 95, 38, 0.35, t, 0.45, 0.7, 0.003);
        nz(t, 0.35, 0.45, 'lowpass', 3000, 0, 250, 1);
        for (i = 0; i < 9; i++) nz(t + Math.random() * 0.22, 0.04, 0.3 + Math.random() * 0.25, 'bandpass', 900 + Math.random() * 2500, 2.5, 0, 1);
        [0, 4, 7, 12, 16].forEach(function (n, j) {
          var f = 523 * semi(n);
          osc('triangle', f, 0, 0, t + 0.14 + j * 0.055, 0.32, 0.1, 0.002, 1);
          osc('sine', f * 2, 0, 0, t + 0.14 + j * 0.055, 0.08, 0.04, 0.002, 1);
        });
      },
      crack: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        for (var i = 0; i < 6; i++) nz(t + i * 0.03, 0.05, 0.4, 'bandpass', 1800 + Math.random() * 1500, 3, 0, 1);
        nz(t + 0.12, 0.4, 0.4, 'lowpass', 900, 0, 150, 1);
        osc('sine', 80, 40, 0.3, t + 0.1, 0.4, 0.5);
      },
      tick: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        nz(t, 0.05, 0.5, 'bandpass', 1300, 6, 0, 1);
        osc('sine', 1300, 900, 0.04, t, 0.06, 0.1, 0.001);
      },
      arrive: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        osc('sine', 85, 55, 0.15, t, 0.25, 0.45);
        nz(t, 0.1, 0.3, 'bandpass', 500, 2);
      },
      boss: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        [1, 2.76, 5.4].forEach(function (m, i) { osc('sine', 98 * m, 0, 0, t, 1.6 - i * 0.4, 0.2 / (i + 1), 0.004, 1); });
        nz(t, 0.5, 0.12, 'highpass', 4000, 0, 0, 1);
      }
    };
  })();

  // ── what a step means on screen ──────────────────────────────────────────
  // Impact point, in design space: the bottom of the log.
  var HIT_X = CX, HIT_Y = CY + R;
  function hitFx(n) {
    var i;
    for (i = 0; i < 12; i++) {
      var a = Math.PI / 2 + (Math.random() - 0.5) * 2.2, sp = 90 + Math.random() * 200;
      fx.chips.push({ x: HIT_X + (Math.random() - 0.5) * 10, y: HIT_Y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        r: Math.random() * 6, vr: (Math.random() - 0.5) * 14, w: 3 + Math.random() * 5, h: 2 + Math.random() * 2,
        col: Math.random() < 0.5 ? '#e7b574' : '#a8692f', t: 0, dur: 0.6 + Math.random() * 0.4 });
    }
    if (fx.chips.length > 160) fx.chips.splice(0, fx.chips.length - 160);
    fx.jolt = 1; fx.wobble = 1; fx.shake = Math.max(fx.shake, 0.25);
    audio.thunk(n);
  }
  function appleFx(a) {
    var sa = (a + sim.rot / SUB) * DEG + Math.PI / 2, x = CX + cos(sa) * (R + 14), y = CY + sin(sa) * (R + 14), i;
    for (i = 0; i < 16; i++) {
      var d = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 180;
      fx.chips.push({ x: x, y: y, vx: cos(d) * sp, vy: sin(d) * sp - 60, r: 0, vr: 0, w: 4 + Math.random() * 4, h: 4 + Math.random() * 4,
        col: Math.random() < 0.6 ? '#e8262a' : '#fff1c8', t: 0, dur: 0.5 + Math.random() * 0.3, round: true });
    }
    for (i = 0; i < 2; i++) fx.flyers.push({ img: 'apple', x: x, y: y, vx: (i ? 1 : -1) * (80 + Math.random() * 60), vy: -160, rot: 0, vr: (i ? 1 : -1) * 6, t: 0, half: i });
    fx.texts.push({ text: '+2', x: x, y: y - 10, t: 0, col: '#ff6b5a' });
    audio.apple();
  }
  function handleEvents(t) {
    var ev = sim.events;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.t === 'stick') hitFx(e.n, false);
      else if (e.t === 'apple') appleFx(e.a);
      else if (e.t === 'clear') clearFx(e);
      else if (e.t === 'ready') audio.arrive();
      else if (e.t === 'clang') startDeath('knife', t);
      else if (e.t === 'idle') startDeath('idle', t);
    }
  }
  // The cleared log bursts into slices and its knives fly off.
  function clearFx(e) {
    var n = 7, base = Math.random() * Math.PI * 2, rotRad = e.rot / SUB * DEG, i;
    for (i = 0; i < n; i++) {
      var a0 = base + i / n * Math.PI * 2, a1 = a0 + Math.PI * 2 / n, mid = (a0 + a1) / 2, sp = 150 + Math.random() * 120;
      fx.slices.push({ k: e.k, boss: e.boss, a0: a0, a1: a1, x: 0, y: 0, vx: Math.cos(mid) * sp, vy: Math.sin(mid) * sp - 120,
        rot: rotRad, vr: (Math.random() - 0.5) * 6, t: 0 });
    }
    for (i = 0; i < e.stuck.length; i++) {
      var sa = (e.stuck[i] + e.rot / SUB) * DEG, d = sa + Math.PI / 2;
      fx.flyers.push({ img: 'knife', x: CX + Math.cos(d) * (R + 20), y: CY + Math.sin(d) * (R + 20), vx: Math.cos(d) * 220, vy: Math.sin(d) * 220 - 160,
        rot: sa, vr: (Math.random() - 0.5) * 14, t: 0 });
    }
    fx.texts.push({ text: '+' + e.bonus, x: CX, y: CY, t: 0, col: '#ffd36b', big: true });
    fx.shake = 0.6; fx.flash = 0.35; fx.flashCol = '#ffe2a8'; fx.arrive = 0; fx.crack = null;
    audio.clear();
    setTimeout(announceLog, 650);
  }
  function startDeath(cause, t) {
    state = 'dying'; dieAt = t;
    setTimeout(finishRun, 1500);
    if (cause === 'knife') {
      // the thrown knife bounces off and tumbles away
      fx.flyers.push({ img: 'knife', x: CX, y: HIT_Y + 40, vx: (Math.random() < 0.5 ? -1 : 1) * 120, vy: 260, rot: 0, vr: 16, t: 0 });
      for (var i = 0; i < 10; i++) {
        var a = Math.random() * Math.PI * 2;
        fx.chips.push({ x: HIT_X, y: HIT_Y, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, r: 0, vr: 0, w: 2, h: 2, col: '#fff7c0', t: 0, dur: 0.3, spark: true });
      }
      fx.shake = 1; fx.flash = 0.5; fx.flashCol = '#ff4a3a';
      audio.clang();
    } else {
      fx.shake = 0.8; fx.flash = 0.4; fx.flashCol = '#ff8a3a';
      audio.crack();
    }
    death = { cause: cause, t: 0 };
  }

  // ── loop ─────────────────────────────────────────────────────────────────
  function pace(dt) {
    if (!(frameAvg > 0)) frameAvg = dt > 0 ? Math.min(STEP_MS * MAX_CATCHUP, dt) : STEP_MS;
    frameAvg += (Math.max(1, Math.min(STEP_MS * MAX_CATCHUP, dt)) - frameAvg) * 0.2;
    clockLag = Math.max(-100, Math.min(100, clockLag + dt - frameAvg));
    var fix = Math.max(-6, Math.min(6, clockLag * 0.25));
    clockLag -= fix;
    return Math.max(0, frameAvg + fix);
  }
  // ?perf=1 standalone: a planner that throws whenever the throw is safe.
  var AUTO = PERF;
  function safeToThrow(s) {
    var c = Object.assign({}, s);
    if (!throwSim(c)) return false;
    for (var i = 0; i < FLY; i++) stepSim(c);
    return !c.dead;
  }
  var perfLog = [];
  if (PERF) window.__ckPerf = perfLog;
  function frame(t) {
    requestAnimationFrame(frame);
    if (lastT === null) lastT = t;
    var raw = t - lastT; if (!(raw >= 0)) raw = 0; lastT = t;
    var dt = pace(raw), dts = Math.min(0.05, dt / 1000);
    clock += dts;
    if (state === 'play') {
      acc += RP ? RP.elapsed(dt, STEP_MS * MAX_CATCHUP) : dt;
      var n = 0, cap = RP ? MAX_CATCHUP * Math.max(1, RP.speed()) : MAX_CATCHUP;
      while (acc >= STEP_MS && n < cap) {
        if (replayThrows) { var due = replayThrows.due(sim.step); for (var ri = 0; ri < due.length; ri++) throwKnife(false); }
        if (AUTO && sim.fly < 0 && sim.trans === 0 && Math.random() < 0.08 && safeToThrow(sim)) throwKnife(false);
        stepSim(sim); handleEvents(t); acc -= STEP_MS; n++;
        if (sim.dead) break;
      }
      if (RP) RP.report(sim.step, sim.score);
      if (n >= cap && acc > STEP_MS) acc = 0;
    } else if (state === 'dying' && t - dieAt > 1500) finishRun();
    else if (state === 'prac') pracUpdate(dts);
    animate(dts);
    var t0 = PERF ? performance.now() : 0;
    render(state === 'play' ? Math.min(1, acc / STEP_MS) : 0);
    if (PERF) { perfLog.push(performance.now() - t0); if (perfLog.length > 240) perfLog.shift(); }
  }

  function animate(dts) {
    var i;
    if (state === 'menu') menuRot = (menuRot + 380 * dts) % TURN;
    fx.jolt = Math.max(0, fx.jolt - dts * 7);
    fx.wobble = Math.max(0, fx.wobble - dts * 3.5);
    fx.shake = Math.max(0, fx.shake - dts * 2.2);
    fx.flash = Math.max(0, fx.flash - dts * 2);
    fx.reload = Math.min(1, fx.reload + dts * 7);
    if (state === 'play' && sim.trans > 0) fx.arrive = 1 - sim.trans / TRANS; else fx.arrive = 1;
    scoreShown += (sim.score - scoreShown) * Math.min(1, dts * 14);
    if (Math.abs(sim.score - scoreShown) < 0.5) scoreShown = sim.score;
    // the idle countdown, one tick a second
    if (state === 'play') {
      var idle = idleSteps(sim);
      var sec = idle >= IDLE_WARN ? Math.ceil((IDLE_END - idle) / 60) : 0;
      if (sec && sec !== fx.warnSec) { audio.tick(); if (!fx.crack) fx.crack = buildCrack(); }
      if (!sec) fx.crack = null;
      fx.warnSec = sec;
    }
    for (i = fx.chips.length - 1; i >= 0; i--) {
      var c = fx.chips[i]; c.t += dts; c.x += c.vx * dts; c.y += c.vy * dts; c.vy += 700 * dts; c.r += c.vr * dts;
      if (c.t > c.dur) fx.chips.splice(i, 1);
    }
    for (i = fx.slices.length - 1; i >= 0; i--) {
      var s = fx.slices[i]; s.t += dts; s.x += s.vx * dts; s.y += s.vy * dts; s.vy += 800 * dts; s.rot += s.vr * dts;
      if (s.t > 0.55) fx.slices.splice(i, 1);
    }
    for (i = fx.flyers.length - 1; i >= 0; i--) {
      var f = fx.flyers[i]; f.t += dts; f.x += f.vx * dts; f.y += f.vy * dts; f.vy += 900 * dts; f.rot += f.vr * dts;
      if (f.t > 1.6) fx.flyers.splice(i, 1);
    }
    for (i = fx.texts.length - 1; i >= 0; i--) { fx.texts[i].t += dts; if (fx.texts[i].t > 0.9) fx.texts.splice(i, 1); }
    if (fx.banner) { fx.banner.t += dts; if (fx.banner.t > 1.4) fx.banner = null; }
    if (death) death.t += dts;
  }
  // Cracks that grow over the log while the player waits too long.
  function buildCrack() {
    var lines = [], i, s;
    for (i = 0; i < 5; i++) {
      var a = Math.random() * Math.PI * 2, pts = [[Math.cos(a) * (R - 8), Math.sin(a) * (R - 8)]], px = pts[0][0], py = pts[0][1], dir = a + Math.PI;
      for (s = 0; s < 6; s++) { dir += (Math.random() - 0.5) * 0.9; px += Math.cos(dir) * 13; py += Math.sin(dir) * 13; pts.push([px, py]); }
      lines.push(pts);
    }
    return lines;
  }

  // ── draw ─────────────────────────────────────────────────────────────────
  function toDesign() { ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy); }
  function blit(img, x, y, k) {
    var w = img.width / (sc * dpr) * (k || 1), h = img.height / (sc * dpr) * (k || 1);
    ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
  }
  // A knife at screen angle `ang` (radians, 0 = straight down), its tip
  // `tipR` from the log centre, pointing at the centre.
  function drawStuckKnife(cx, cy, ang, tipR, wob) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang + (wob || 0));
    var w = knifeImg.width / (sc * dpr), h = knifeImg.height / (sc * dpr);
    ctx.translate(0, tipR);                                 // tip toward the centre, handle out
    ctx.drawImage(knifeImg, -w / 2, -2, w, h);
    ctx.restore();
  }
  function drawApple(cx, cy, ang) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
    var w = appleImg.width / (sc * dpr);
    ctx.translate(0, R + 13); ctx.rotate(Math.PI);
    ctx.drawImage(appleImg, -w / 2, -w / 2, w, w);
    ctx.restore();
  }
  // One whole log: its knives behind (blades hidden in the wood), the face,
  // apples on top, cracks if it is waiting too long.
  function drawLog(img, cx, cy, rotUnits, stuck, apples, newest, flyY) {
    var rot = rotUnits * DEG, i;
    blit(shadowImg, cx + 6, cy + 14);
    for (i = 0; i < stuck.length; i++) {
      var wob = (i === newest ? fx.wobble * 0.09 * sin(clock * 60) : 0);
      drawStuckKnife(cx, cy, stuck[i] * DEG + rot, R - EMBED_PX, wob);
    }
    // A knife in the air is drawn here, level with the stuck ones, so the log face covers its blade the moment it reaches the wood.
    if (flyY != null) { ctx.globalAlpha = 0.25; drawWaitingKnife(flyY + 24, false); ctx.globalAlpha = 1; drawWaitingKnife(flyY, false); }
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
    var w = img.width / (sc * dpr);
    ctx.drawImage(img, -w / 2, -w / 2, w, w);
    if (fx.crack && state === 'play') {
      var grow = Math.min(1, (idleSteps(sim) - IDLE_WARN) / (IDLE_END - IDLE_WARN));
      ctx.strokeStyle = 'rgba(40,15,3,0.85)'; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (i = 0; i < fx.crack.length; i++) {
        var pts = fx.crack[i], upto = Math.max(1, Math.floor(grow * (pts.length - 1)) + 1);
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (var p = 1; p < upto && p < pts.length; p++) ctx.lineTo(pts[p][0], pts[p][1]);
        ctx.stroke();
      }
    }
    ctx.restore();
    for (i = 0; i < apples.length; i++) drawApple(cx, cy, apples[i] * DEG + rot);
  }
  function drawWaitingKnife(y, glint) {
    var w = knifeImg.width / (sc * dpr), h = knifeImg.height / (sc * dpr);
    ctx.drawImage(knifeImg, CX - w / 2, y - 2, w, h);
    if (glint) {
      var g = (clock * 0.7) % 1.6;
      if (g < 1) {
        ctx.save(); ctx.beginPath(); ctx.rect(CX - 8, y, 16, BLADE); ctx.clip();
        ctx.globalAlpha = 0.7 * sin(g * Math.PI); ctx.fillStyle = '#fff';
        ctx.translate(CX, y + g * BLADE); ctx.rotate(-0.6); ctx.fillRect(-14, -2, 28, 4);
        ctx.restore();
      }
    }
  }
  function drawKnifeColumn(total, left) {
    var x = 30, y0 = Math.min(H - 20, fit.visBottom - 30), iw = knifeIcon.width / (sc * dpr), ih = knifeIcon.height / (sc * dpr);
    for (var i = 0; i < total; i++) {
      var y = y0 - i * 22, used = i >= left;
      ctx.save(); ctx.translate(x, y); ctx.rotate(-Math.PI / 2 + 0.0);
      ctx.globalAlpha = used ? 0.25 : 1;
      ctx.drawImage(knifeIcon, -iw / 2, -ih / 2, iw, ih);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  function text(t, x, y, size, col, alpha) {
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.font = size + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.18; ctx.strokeStyle = '#1a0b03'; ctx.strokeText(t, x, y);
    ctx.fillStyle = col; ctx.fillText(t, x, y);
    ctx.globalAlpha = 1;
  }

  function render(alpha) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bgCanvas, 0, 0);
    toDesign();
    if (fx.shake > 0) ctx.translate((Math.random() - 0.5) * fx.shake * 14, (Math.random() - 0.5) * fx.shake * 14);
    var i, top = fit.visTop;

    // A knife in the air (play or practice) is drawn with the log, behind its face, once it is there.
    var flyY = null, flyDrawn = false;
    if (state === 'play' || state === 'prac') {
      var inAir = state === 'play' ? sim.fly >= 0 : prac && prac.fly >= 0;
      if (inAir) {
        var fp = state === 'play' ? (FLY - sim.fly + alpha) / FLY : prac.fly / (FLY / 60);
        flyY = KNIFE_TIP_Y + (CY + R - EMBED_PX - KNIFE_TIP_Y) * Math.min(1, fp);
      }
    }
    // the log
    if (state === 'menu' && ICON) {
      // the platform icon (standalone only): a big log, knives in
      ctx.save(); ctx.translate(CX, CY + 150); ctx.scale(1.35, 1.35); ctx.translate(-CX, -CY);
      drawLog(buildLog(0, false), CX, CY, 520, [300, 1100, 2050, 2900], [1650], -1);
      ctx.restore();
    } else if (state === 'menu') {
      drawLog(buildLog(0, false), CX, CY + 30, menuRot, MENU_STUCK, [1800], -1);
    } else if (state === 'prac' && prac) {
      drawLog(buildLog(0, false), CX, CY, prac.rot, prac.stuck, [], prac.stuck.length - 1, flyY); flyDrawn = flyY != null;
    } else if (sim.spec) {
      var ar = Math.max(0, (fx.arrive - 0.3) / 0.7), arriveY = ar < 1 ? -300 * (1 - ar) * (1 - ar) : 0;
      var rotU = (sim.rot + (state === 'play' && sim.trans === 0 ? sim.spd * alpha : 0)) / SUB;
      if (!(death && death.cause === 'idle')) {
        drawLog(buildLog(sim.log, sim.spec.boss), CX, CY - fx.jolt * 7 + arriveY, rotU, sim.stuck, sim.apples, sim.stuck.length - 1, flyY); flyDrawn = flyY != null;
      } else {
        // a log that waited too long splits in two
        var d = Math.min(1, death.t * 2), img = buildLog(sim.log, sim.spec.boss), w = img.width / (sc * dpr);
        for (var hlf = 0; hlf < 2; hlf++) {
          ctx.save(); ctx.translate(CX + (hlf ? 1 : -1) * d * 40, CY + d * d * 160); ctx.rotate(rotU * DEG + (hlf ? 1 : -1) * d * 0.5);
          ctx.beginPath(); ctx.rect(hlf ? 0 : -w, -w, w, w * 2); ctx.clip();
          ctx.drawImage(img, -w / 2, -w / 2, w, w); ctx.restore();
        }
      }
    }

    // slices of a cleared log
    for (i = 0; i < fx.slices.length; i++) {
      var s = fx.slices[i], simg = buildLog(s.k, s.boss), sw = simg.width / (sc * dpr);
      ctx.save(); var sk = Math.min(1, s.t / 0.55); ctx.globalAlpha = Math.max(0, 1 - sk * sk);
      ctx.translate(CX + s.x, CY + s.y); ctx.rotate(s.rot);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R + 4, s.a0, s.a1); ctx.closePath(); ctx.clip();
      ctx.drawImage(simg, -sw / 2, -sw / 2, sw, sw);
      ctx.restore();
    }

    // the knife in the hand or in the air
    if (state === 'play' || state === 'prac') {
      if (flyY != null) {
        if (!flyDrawn) { ctx.globalAlpha = 0.25; drawWaitingKnife(flyY + 24, false); ctx.globalAlpha = 1; drawWaitingKnife(flyY, false); }
      } else if (!death && !(prac && prac.ready) && (state !== 'play' || sim.trans === 0 || fx.arrive > 0.5)) {
        drawWaitingKnife(KNIFE_TIP_Y + (1 - fx.reload) * 60, true);
      }
    }

    // flying debris
    for (i = 0; i < fx.flyers.length; i++) {
      var f = fx.flyers[i];
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - f.t / 1.6); ctx.translate(f.x, f.y); ctx.rotate(f.rot);
      if (f.img === 'knife') { var kw = knifeImg.width / (sc * dpr), kh = knifeImg.height / (sc * dpr); ctx.drawImage(knifeImg, -kw / 2, -kh / 2, kw, kh); }
      else { var aw = appleImg.width / (sc * dpr); ctx.beginPath(); ctx.rect(f.half ? 0 : -aw / 2, -aw / 2, aw / 2, aw); ctx.clip(); ctx.drawImage(appleImg, -aw / 2, -aw / 2, aw, aw); }
      ctx.restore();
    }
    for (i = 0; i < fx.chips.length; i++) {
      var c = fx.chips[i], ca = Math.max(0, 1 - c.t / c.dur);
      ctx.globalAlpha = ca; ctx.fillStyle = c.col;
      if (c.round || c.spark) { ctx.beginPath(); ctx.arc(c.x, c.y, c.w / 2, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.r); ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h); ctx.restore(); }
    }
    ctx.globalAlpha = 1;
    for (i = 0; i < fx.texts.length; i++) {
      var tx = fx.texts[i], tp = tx.t / 0.9;
      text(tx.text, tx.x, tx.y - tp * 50, tx.big ? 44 : 26, tx.col, Math.min(1, (1 - tp) * 2));
    }

    // HUD
    if (state === 'play' || state === 'dying' || state === 'over') {
      text(String(Math.round(scoreShown)), CX, top + 46, 48, '#ffe2a8');
      // five pips: the stage, the fifth is the boss
      var stagePos = sim.log % BOSS_EVERY;
      for (i = 0; i < BOSS_EVERY; i++) {
        var px2 = CX - 48 + i * 24, py2 = top + 84, boss = i === BOSS_EVERY - 1;
        ctx.beginPath(); ctx.arc(px2, py2, boss ? 7 : 5.5, 0, Math.PI * 2);
        ctx.fillStyle = i < stagePos ? (boss ? '#ff5a3c' : '#ffd36b') : i === stagePos ? (boss ? '#ff5a3c' : '#fff') : 'rgba(255,255,255,0.18)';
        ctx.fill();
        if (i === stagePos) { ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.stroke(); }
      }
      if (sim.spec) drawKnifeColumn(sim.spec.need, sim.left);
      if (fx.banner && state === 'play') {
        var bt = fx.banner.t, ba = Math.min(1, bt * 6) * (bt > 1 ? Math.max(0, 1 - (bt - 1) * 2.5) : 1);
        text(fx.banner.text, CX, top + 120, 30, '#ff7a4a', ba);
      }
      if (fx.warnSec && state === 'play') {
        var pulse = 1 + 0.15 * Math.max(0, 1 - ((clock * 60) % 60) / 20);
        ctx.save(); ctx.translate(CX, CY + R + 66); ctx.scale(pulse, pulse);
        text('THROW! ' + fx.warnSec, 0, 0, 26, '#ff7a4a');
        ctx.restore();
      }
    }

    // practice marks
    if (state === 'prac' && prac && !prac.ready) drawPracMarks();

    if (fx.flash > 0) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = fx.flash * 0.5; ctx.fillStyle = fx.flashCol; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.globalAlpha = 1; }
    if (state === 'over') { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.35; ctx.fillStyle = '#140b06'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.globalAlpha = 1; }
    if (PERF && perfLog.length) {
      var sum = 0; for (i = 0; i < perfLog.length; i++) sum += perfLog[i];
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.font = '12px monospace'; ctx.fillStyle = '#0f0'; ctx.textAlign = 'left';
      ctx.fillText('draw ' + (sum / perfLog.length).toFixed(2) + ' ms  log ' + (sim.log + 1), 8, ch - 10);
    }
  }

  function drawPracMarks() {
    var p = prac;
    if (!p.frozen) return;
    var since = p.t - p.shownAt, fade = Math.min(1, since / 0.12), nudge = Math.max(0, 1 - (p.t - p.nudge) / 0.35);
    var danger = p.phase === 'danger', col = danger ? '#ff5a46' : '#8ee06a', pul = 0.5 + 0.5 * sin(p.t * 9);
    ctx.save(); ctx.globalAlpha = fade;
    // the knife's path: dotted up to the caption, an arrow from there to the wood
    ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.setLineDash([2, 12]); ctx.lineDashOffset = -p.t * 40;
    ctx.beginPath(); ctx.moveTo(CX, KNIFE_TIP_Y - 10); ctx.lineTo(CX, HIT_Y + 112); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CX, HIT_Y + 54); ctx.lineTo(CX, HIT_Y + 14); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(CX, HIT_Y + 4); ctx.lineTo(CX - 9, HIT_Y + 18); ctx.lineTo(CX + 9, HIT_Y + 18); ctx.closePath(); ctx.fill();
    if (danger) {
      // the stuck knife that is in the way, ringed in red
      var sa = pracScreenAngle(p.stuck[0]) * DEG + Math.PI / 2, hx0 = CX + cos(sa) * (R + 36), hy0 = CY + sin(sa) * (R + 36);
      ctx.globalAlpha = fade * (0.6 + 0.4 * pul); ctx.strokeStyle = '#ff5a46'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(hx0, hy0, 34 + pul * 4, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = fade * 0.18; ctx.fillStyle = '#ff5a46'; ctx.beginPath(); ctx.arc(hx0, hy0, 34, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    if (p.hand) {
      if (!handImg) handImg = buildHandSprite();
      var hx = CX + 62, hy = KNIFE_TIP_Y + 54, k = (since % 0.8) / 0.8;
      var down = k < 0.18 ? k / 0.18 : k < 0.36 ? 1 - (k - 0.18) / 0.18 : 0, sz = 80 / HAND_H;
      if (k < 0.5) { ctx.globalAlpha = fade * (1 - k * 2); ctx.strokeStyle = '#fff6e6'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(hx, hy, 10 + k * 56, 0, 7); ctx.stroke(); }
      ctx.globalAlpha = fade;
      ctx.drawImage(handImg, hx - 24.5 * sz, hy - 12 * sz + down * 8, HAND_W * sz, HAND_H * sz);
    }
    var cs = 1 + Math.max(0, 0.2 - since) * 1.5;
    ctx.save(); ctx.translate(CX + nudge * 8 * sin(p.t * 50), HIT_Y + 84); ctx.scale(cs, cs);
    text(p.cap, 0, 0, 24, danger ? '#ffb3a8' : '#fff6e6', fade);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  requestAnimationFrame(frame);

  // the harness (tests) reads the rules and the sim; standalone only otherwise
  if (!EMBED || window.__ckHarness) {
    window.__ck = { get sim() { return sim; }, get state() { return state; }, get prac() { return prac; }, logSpec: logSpec, initSim: initSim, stepSim: stepSim, throwSim: throwSim };
  }
})();
