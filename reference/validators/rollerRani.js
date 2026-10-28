'use strict';

/**
 * Roller Rani validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one: a trace without a v2 start marker is not a run
 * and scores zero.
 *
 * The game: a skater glides forward by herself; dragging left and right sets
 * the TARGET stance (0 closed .. 1000 full split) and the real spread
 * chases it at most RATE a step. Every obstacle (cone rows, a narrowing beam,
 * split rails) is an interval of spreads that survive it; one miss ends the run.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed (obstacle k draws from
 *      hash(seed, k, j), a pure function, never a running stream);
 *   2. applies each path batch { f, x[] }: x[i] is the target during step
 *      f + 1 + i, set before that step runs, exactly as the client does;
 *   3. runs the same fixed steps and counts what the client would have scored.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/roller-rani/js/rules.js.
 * shared/tests/rollerRaniParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump.
 */

// ==== RULES BLOCK: identical in games/roller-rani/js/rules.js and shared/anticheat/validators/rollerRani.js ====
var RULES_VERSION = 5;
var S = {
  SPREAD_MAX: 1000, RATE: 45,            // spread chases the target, per step
  FOOT_MIN: 75, FOOT_SPAN: 665,          // footX = FOOT_MIN + spread * SPAN / 1000
  HALF: 860,                             // normal track half width
  EDGE: 45,                              // a skate this close to an edge falls off
  CLEAR: 165,                            // skate half (55) + cone radius (110)
  V0: 140, VMAX: 300, V_EVERY: 2200,     // speed per step, +1 every V_EVERY sub of distance
  V_START: 30, EASE_Z: 9000,               // the start eases in
  START_Z: 16000,                        // first obstacle
  ROW_PTS: 5, STREAK_CAP: 10, UNIT: 1000
};

function footX(s) { return S.FOOT_MIN + Math.floor(s * S.FOOT_SPAN / 1000); }
// the smallest spread whose foot reaches x, the largest that stays under x
function sAtLeast(x) { return Math.max(0, Math.min(1000, Math.ceil((x - S.FOOT_MIN) * 1000 / S.FOOT_SPAN))); }
function sAtMost(x) { return Math.max(0, Math.min(1000, Math.floor((x - S.FOOT_MIN) * 1000 / S.FOOT_SPAN))); }
function speedAt(d) {                 // eases in over the first EASE_Z, then climbs gently
  if (d < S.EASE_Z) return S.V_START + Math.floor(d * (S.V0 - S.V_START) / S.EASE_Z);
  return Math.min(S.VMAX, S.V0 + Math.floor((d - S.EASE_Z) / S.V_EVERY));
}

var SEED_MIX = 0x9e3779b1;
function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}
// Draw j of obstacle k: a pure function of (seed, k, j).
function hash(a, b, c) {
  var h = (a ^ Math.imul(b + 0x9e3779b9 | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13) ^ Math.imul(c + 0x27d4eb2f | 0, 0xc2b2ae35), 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h >>> 0;
}
function draw(seed, k, j, n) { return hash(seed, k, j) % n; }

// Obstacle K: a pure function of (seed, K) and the one before it. Every
// obstacle is an interval of spreads that survive it, over a span of track:
//   cone rows   z0 == z1 (checked as the skates cross it)
//   narrow beam the track half width shrinks, so the split must stay small
//   split rails two rails with sky between, so the skates must stay on them
// Kinds: 0 middle cluster, 1 side pair, 2 window, 3 narrow, 4 rails.
function makeObstacle(seed, k, prev) {
  var r0 = draw(seed, k, 0, 1000), r1 = draw(seed, k, 1, 1000), r2 = draw(seed, k, 2, 1000);
  var r3 = draw(seed, k, 3, 1000), r4 = draw(seed, k, 4, 1000);
  var level = Math.min(40, Math.floor(k / 3));
  var kind;
  var wantWide = prev ? prev.hi < 500 : r3 < 500;   // alternate: a closed row is followed by a wide one
  if (k >= 5 && r0 < 160 + level * 6) kind = r1 < 500 ? 3 : 4;
  else if (k >= 2 && r0 < 400) kind = 2;
  else kind = wantWide ? 0 : 1;
  var o = { k: k, kind: kind, lo: 0, hi: 1000, cones: [], half: S.HALF, rIn: 0, rOut: 0, len: 0 };
  var minW = Math.max(150, 240 - level * 5);           // never a pinhole: at least ~10 cm of foot travel         // width of the safe interval, in spread
  if (kind === 0) {                                  // cones in the middle: go wide
    var c = [0, 140, 260, 380][r1 % (1 + Math.min(3, Math.floor(level / 3)))];
    o.lo = sAtLeast(c + S.CLEAR);
    o.cones = c === 0 ? [0] : c <= 140 ? [-c, c] : [-c, 0, c];
    if (c >= 260 && r2 < 500) o.cones = [-c, -Math.floor(c / 2), Math.floor(c / 2), c];
  } else if (kind === 1) {                           // cones at both sides: go narrow
    var x = 330 + r1 % (1 + Math.max(0, 330 - level * 8));
    o.hi = sAtMost(x - S.CLEAR);
    o.cones = [-x, x];
    if (r2 < 400) o.cones = [-x - 160, -x, x, x + 160];
  } else if (kind === 2) {                           // inner and outer cones: a window
    var w = minW + r2 % 90;
    var lo = 150 + r1 % Math.max(1, 850 - w - 150);
    var hi = lo + w;
    var inX = footX(lo) - S.CLEAR, outX = footX(hi) + S.CLEAR;
    if (inX >= 0) o.cones.push(-inX, inX);
    if (outX <= S.HALF - 40) o.cones.push(-outX, outX);
    o.lo = inX >= 0 ? sAtLeast(inX + S.CLEAR) : 0;
    o.hi = outX <= S.HALF - 40 ? sAtMost(outX - S.CLEAR) : 1000;
  } else if (kind === 3) {                           // the beam narrows
    o.half = 260 + r1 % 260;
    o.hi = sAtMost(o.half - S.EDGE);
    o.len = 8000 + r2 % 10000;
  } else {                                           // split rails
    var wR = 170 + r2 % 120;
    o.rIn = 200 + r1 % 300;
    o.rOut = o.rIn + wR + 140;
    o.lo = sAtLeast(o.rIn + S.EDGE); o.hi = sAtMost(o.rOut - S.EDGE);
    o.len = 9000 + r4 % 12000;
  }
  return o;
}

// the gap before obstacle o: time for the worst-case spread change at the
// speed actually reached there, plus a reaction allowance that shrinks
function gapBefore(seed, o, prev, z) {
  var react = Math.max(10, 40 - o.k);
  var travel = prev ? Math.max(0, o.lo - prev.lo, prev.hi - o.hi) : 0;
  var steps = Math.ceil(travel / S.RATE) + react + draw(seed, o.k, 5, 10);
  var v = speedAt(z + steps * S.VMAX);
  return Math.max(2200, steps * v);
}

function course(seed, upto, list) {   // extend list (pure in seed) until it reaches upto
  while (!list.length || list[list.length - 1].z0 < upto) {
    var prev = list.length ? list[list.length - 1] : null;
    var o = makeObstacle(seed, list.length, prev);
    var z = prev ? prev.z1 + gapBefore(seed, o, prev, prev.z1) : S.START_Z;
    o.z0 = z; o.z1 = z + o.len;
    list.push(o);
  }
  return list;
}

function initSim(seedHex, version) {
  var nv = Number(version) || RULES_VERSION, ver = nv >= 5 ? 5 : nv >= 4 ? 4 : nv >= 3 ? 3 : 2;
  var sim = { version: ver, seed: seedToInt(seedHex), step: 0, dist: 0, v: S.V_START,
           spread: 0, target: 0, next: 0, score: 0, rows: 0, streak: 0, dead: 0, deathStep: -1, cause: '',
           course: [], events: [] };
  if (ver >= 3) { sim.boost = 0; sim.slow = 0; sim.magnet = 0; sim.x2 = 0; sim.shield = 0; sim.ghost = -1; sim.gems = 0; }
  return sim;
}

function setTarget(sim, t) { sim.target = Math.max(0, Math.min(S.SPREAD_MAX, t | 0)); }

function stepSim2(sim) {
  if (sim.dead) return sim;
  var ev = [];
  var d = sim.spread - sim.target;
  sim.spread = d > S.RATE ? sim.spread - S.RATE : d < -S.RATE ? sim.spread + S.RATE : sim.target;
  var v = speedAt(sim.dist);
  var from = sim.dist, to = sim.dist + v;
  sim.v = v; sim.dist = to; sim.step++;
  course(sim.seed, to + 200000, sim.course);
  var c = sim.course, fx = footX(sim.spread);
  for (var i = sim.next; i < c.length && c[i].z0 <= to; i++) {
    var o = c[i];
    var inside = o.z1 > from;                      // any part of it under the skates this step
    if (!inside) continue;
    if (sim.spread < o.lo || sim.spread > o.hi) {
      sim.dead = sim.step; sim.deathStep = sim.step;
      sim.cause = o.kind <= 2 ? 'cone' : o.kind === 3 ? 'edge' : 'rail';
      ev.push({ t: 'die', k: o.k, cause: sim.cause });
      break;
    }
  }
  while (!sim.dead && sim.next < c.length && c[sim.next].z1 <= to) {   // cleared
    var p = c[sim.next];
    sim.rows++; sim.streak++;
    var gain = S.ROW_PTS + Math.min(sim.streak, S.STREAK_CAP);
    sim.score += gain;
    var margin = Math.min(sim.spread - p.lo, p.hi - sim.spread);
    ev.push({ t: 'row', k: p.k, gain: gain, streak: sim.streak, margin: margin });
    sim.next++;
  }
  if (!sim.dead && Math.floor(to / S.UNIT) > Math.floor(from / S.UNIT)) sim.score += Math.floor(to / S.UNIT) - Math.floor(from / S.UNIT);
  if (!sim.dead) {                                 // outside every obstacle: off the edge?
    if (fx > S.HALF - S.EDGE) { sim.dead = sim.step; sim.deathStep = sim.step; sim.cause = 'edge'; ev.push({ t: 'die', cause: 'edge' }); }
  }
  sim.events = ev;
  return sim;
}

// ---- v3: 36 obstacle kinds in five tiers, and pickups ----
// An obstacle is a list of SEGMENTS, each a span of track (a..b from the
// obstacle's z0; a == b is a single row) with a CORE interval of spreads that
// is always safe. A moving segment is a superset of its core that breathes
// (mv: amplitude, period, phase, which edge), so standing in the core is
// always enough. Contiguous segments overlap by at least OV and the earlier
// one is long enough to reach the overlap from anywhere it allows; separate
// rows get a run-up sized from the worst change. Every obstacle has one
// segment wholly on its BIAS side (narrow: <= 480, wide: >= 520) and the bias
// alternates, so a stance that never changes always meets one it cannot pass.
var S3 = {
  BOOST: 60, SLOW: 50, VCAP: 360, BOOST_STEPS: 150, SLOW_STEPS: 150, MAG_STEPS: 600, X2_STEPS: 600,
  RATE: 54,   // v3 stance speed: 20% faster than v2's 45 (founder, 6 Oct)
  GEM: 3, BIG: 15, OV: 120, IN_REACT: 4, ROW_REACT: 12, NARROW: 480, WIDE: 520, TIERS: [0, 6, 15, 30, 50],
  // v4: past D_HARD (about score 1,200) it keeps getting harder, slowly: +1 speed every
  // HARD_V_EVERY up to VMAX4, and one step less reaction time every HARD_REACT_EVERY
  D_HARD: 750000, HARD_V_EVERY: 12000, VMAX4: 335, HARD_REACT_EVERY: 150000
};
function speedOf(d, ver) {
  if (ver < 4 || d <= S3.D_HARD) return speedAt(d);
  return Math.min(S3.VMAX4, speedAt(d) + Math.floor((d - S3.D_HARD) / S3.HARD_V_EVERY));
}
function hardSteps(z, ver) { return ver >= 4 && z > S3.D_HARD ? Math.floor((z - S3.D_HARD) / S3.HARD_REACT_EVERY) : 0; }
// t: tier, b: bias mask (1 narrow, 2 wide)
var KINDS = [
  { n: 'cone row', t: 0, b: 2 }, { n: 'side cones', t: 0, b: 1 }, { n: 'cone window', t: 0, b: 3 },
  { n: 'pucks', t: 0, b: 2 }, { n: 'edge slabs', t: 0, b: 1 }, { n: 'centre block', t: 0, b: 2 },
  { n: 'narrow beam', t: 1, b: 1 }, { n: 'split rails', t: 1, b: 3 }, { n: 'single rail', t: 1, b: 1 },
  { n: 'wide rails', t: 1, b: 2 }, { n: 'pillar pairs', t: 1, b: 1 }, { n: 'barrels', t: 1, b: 2 },
  { n: 'post gate', t: 1, b: 3 }, { n: 'zigzag rails', t: 2, b: 3 }, { n: 'narrowing beam', t: 2, b: 1 },
  { n: 'widening rails', t: 2, b: 2 }, { n: 'merge and split', t: 2, b: 1 }, { n: 'stepping pads', t: 2, b: 3 },
  { n: 'double row', t: 2, b: 3 }, { n: 'slalom', t: 2, b: 3 }, { n: 'chasm bridge', t: 2, b: 3 },
  { n: 'laser line', t: 2, b: 2 }, { n: 'crusher walls', t: 3, b: 1 }, { n: 'pulsing block', t: 3, b: 2 },
  { n: 'pendulums', t: 3, b: 1 }, { n: 'swinging gate', t: 3, b: 3 }, { n: 'sweeping laser', t: 3, b: 2 },
  { n: 'sliding rails', t: 3, b: 3 }, { n: 'spinning bar', t: 3, b: 2 }, { n: 'pistons', t: 3, b: 1 },
  { n: 'crusher alley', t: 4, b: 3 }, { n: 'fast zigzag', t: 4, b: 3 }, { n: 'needle rail', t: 4, b: 1 },
  { n: 'gauntlet', t: 4, b: 3 }, { n: 'twin chasm', t: 4, b: 3 }, { n: 'laser grid', t: 4, b: 3 }
];
// vis: 0 track, 1 beam, 2 rails, 3 rails over a chasm, 4 single rail, 5 pads
// ob: 0 none, 1 cones, 2 pucks, 3 slabs, 4 blocks, 5 pillars, 6 barrels,
//     7 posts, 8 laser, 9 pendulum balls, 10 spinning bar, 11 pistons
// pickups: 0 gem, 1 gem trail, 2 big gem, 3 boost pad, 4 magnet, 5 shield, 6 x2, 7 slow
var PICKS = [[0, 1], [1, 3], [3, 4], [2, 8], [5, 14]];   // [type, from k]; x2, slow and magnet retired

function d3(seed, k, j, n) { return hash(seed, 100000 + k, j) % n; }
function tri(t, mv) {
  var u = (t + mv.ph) % mv.per, d = u * 2 < mv.per ? u : mv.per - u;
  return Math.floor(mv.amp * 2 * d / mv.per);
}
// A bound on open track must be one an obstacle can show: a window whose low
// edge is so narrow that no middle cone fits between the skates (footX(lo) <
// CLEAR) killed a skater standing feet together with nothing drawn, and a high
// edge past where side cones fit did the same at the outside. Such bounds open.
function sg(L, lo, hi, vis, ob, mv, sep) {
  if (vis === 0) {
    if (lo > 0 && footX(lo) < S.CLEAR) lo = 0;
    if (hi < 1000 && footX(hi) + S.CLEAR > S.HALF - 40) hi = 1000;
  }
  var s = { a: 0, b: 0, L: L, lo: lo, hi: hi, vis: vis, ob: ob, mv: mv || null, sep: !!sep, hl: lo, hh: hi };
  if (mv) { if (mv.e & 1) s.hl = Math.max(0, lo - mv.amp); if (mv.e & 2) s.hh = Math.min(1000, hi + mv.amp); }
  return s;
}
function mvOf(r, amp, per, e) { return { amp: amp, per: per, ph: r % per, e: e }; }
// narrow: [0, hi], hi <= 480 - room; wide: [lo, 1000], lo >= 520 + room
function nHi(r, room) { return 150 + r % (331 - room); }
function wLo(r, room) { return 520 + room + r % (331 - room); }
function win(bias, w, r, room) {
  room = room || 0;
  // r % 0 is NaN: a window exactly as wide as its side once gave the course a
  // NaN position and the generator stopped, leaving an empty track (Oct 2026)
  var m = 481 - room - w; if (m === 0) m = 1;
  if (bias === 0) { var hi = w + r % m; return [hi - w, hi]; }
  var lo = 520 + room + r % m; return [lo, lo + w];
}
// the far side of a window: a window on the other side of the middle that
// overlaps the bias window by at least OV
function shiftWin(a, bias, s) {
  var w = a[1] - a[0], d = Math.min(s, w - S3.OV);
  return bias === 0 ? [a[0] + d, a[1] + d] : [a[0] - d, a[1] - d];
}
function makeObstacle3(seed, k, prev, ver) {
  var r = []; for (var j = 0; j < 12; j++) r.push(d3(seed, k, j, 1000));
  var level = Math.min(60, Math.floor(k / 2));
  var bias = prev ? 1 - prev.bias : r[0] % 2;
  var tier = 0; while (tier < 4 && k >= S3.TIERS[tier + 1]) tier++;
  var kind = -1;
  if (k >= 50 && k % 25 === 24) kind = 35;
  else {
    var pool = [], fresh = [];
    for (var q = 0; q < KINDS.length; q++) if (KINDS[q].t <= tier && (KINDS[q].b >> bias) & 1) { pool.push(q); if (KINDS[q].t === tier) fresh.push(q); }
    var from = fresh.length && r[1] < 450 ? fresh : pool;
    kind = from[r[2] % from.length];
  }
  var w = Math.max(150, 260 - level * 3) + r[3] % 90;    // a window, never a pinhole
  var Ls = 6000 + r[4] % 8000;                          // a long stretch
  var a, b, lo, s = [];
  var M = function (amp, per, e) { return mvOf(r[9], amp, per, e); };
  switch (kind) {
    case 0: s.push(sg(0, wLo(r[5], 0), 1000, 0, 1)); break;
    case 1: s.push(sg(0, 0, nHi(r[5], 0), 0, 1)); break;
    case 2: a = win(bias, w, r[5]); s.push(sg(0, a[0], a[1], 0, 1)); break;
    case 3: s.push(sg(0, wLo(r[5], 0), 1000, 0, 2)); break;
    case 4: s.push(sg(2500 + r[6] % 4000, 0, nHi(r[5], 0), 0, 3)); break;
    case 5: s.push(sg(0, wLo(r[5], 0), 1000, 0, 4)); break;
    case 6: s.push(sg(Ls, 0, nHi(r[5], 0), 1, 0)); break;
    case 7: a = win(bias, w + 40, r[5]); s.push(sg(Ls, a[0], a[1], 2, 0)); break;
    case 8: s.push(sg(Ls, 0, 150 + r[5] % 80, 4, 0)); break;
    case 9: lo = 600 + r[5] % 200; s.push(sg(Ls, lo, Math.min(1000, lo + w + 60), 2, 0)); break;
    case 10: lo = nHi(r[5], 0); s.push(sg(0, 0, lo, 0, 5), sg(0, 0, lo, 0, 5, null, true)); break;
    case 11: s.push(sg(0, wLo(r[5], 0), 1000, 0, 6)); break;
    case 12: a = win(bias, w, r[5]); s.push(sg(0, a[0], a[1], 0, 7)); break;
    case 13: case 31:
      if (ver >= 5) {   // v5: one gentle step across and back, wide rails, long enough to read
        a = win(bias, w + 160, r[5]); b = shiftWin(a, bias, 90 + r[6] % 70);
        for (var z5 = 0; z5 < 3; z5++) { var c5 = z5 % 2 ? b : a; s.push(sg((kind === 13 ? 6500 : 5500) + r[7 + z5] % 2500, c5[0], c5[1], 2, 0)); }
        break;
      }
      a = win(bias, w + 60, r[5]); b = shiftWin(a, bias, 140 + r[6] % 160);
      for (var z = 0; z < (kind === 13 ? 3 : 5); z++) { var c = z % 2 ? b : a; s.push(sg((kind === 13 ? 5000 : 3500) + r[7 + z % 3] % 3000, c[0], c[1], 2, 0)); }
      break;
    case 14: s.push(sg(4000, 0, 700 + r[5] % 200, 1, 0), sg(4000, 0, 430 + r[6] % 50, 1, 0), sg(4000 + r[7] % 6000, 0, 260 + r[8] % 60, 1, 0)); break;
    case 15: lo = 360 + r[5] % 80; s.push(sg(4000, lo, lo + 260, 2, 0), sg(4000, lo + 120, lo + 400, 2, 0), sg(4000 + r[7] % 6000, 600, 600 + Math.min(400, w + 100), 2, 0)); break;
    case 16: s.push(sg(4000, 150, 430, 2, 0), sg(4000 + r[6] % 3000, 0, 330 + r[7] % 100, 1, 0), sg(4000, 150, 430, 2, 0)); break;
    case 17: a = win(bias, w + 40, r[5]); s.push(sg(Ls, a[0], a[1], 5, 0)); break;
    case 18:
      if (bias === 1) { lo = wLo(r[5], 0); s.push(sg(0, lo, 1000, 0, 1), sg(0, 0, Math.max(lo - 300, nHi(r[6], 0)), 0, 1, null, true)); }
      else { lo = nHi(r[5], 0); s.push(sg(0, 0, lo, 0, 1), sg(0, Math.min(lo + 300, wLo(r[6], 0)), 1000, 0, 1, null, true)); }
      break;
    case 19:
      for (var z2 = 0; z2 < 3; z2++) {
        var wide = (z2 % 2 === 0) === (bias === 1);
        s.push(wide ? sg(0, wLo(r[5 + z2], 0), 1000, 0, 1, null, z2 > 0) : sg(0, 0, nHi(r[5 + z2], 0), 0, 1, null, z2 > 0));
      }
      break;
    case 20: a = win(bias, w + 60, r[5]); s.push(sg(Ls, a[0], a[1], 3, 0)); break;
    case 21: s.push(sg(0, wLo(r[5], 0), 1000, 0, 8)); break;
    case 22: s.push(sg(3000 + r[6] % 3000, 0, nHi(r[5], 160), 0, 11, M(160, 90 + r[7] % 60, 2))); break;
    case 23: s.push(sg(2000 + r[6] % 2000, wLo(r[5], 180), 1000, 0, 4, M(180, 80 + r[7] % 60, 1))); break;
    case 24: s.push(sg(1500 + r[6] % 1500, 0, nHi(r[5], 170), 0, 9, M(170, 100 + r[7] % 60, 2))); break;
    case 25:
      a = win(bias, w, r[5], 120);
      s.push(sg(1200, a[0], a[1], 0, 7, M(110, 70 + r[7] % 50, 3)));
      break;
    case 26: s.push(sg(2500, wLo(r[5], 160), 1000, 0, 8, M(160, 90 + r[7] % 60, 1))); break;
    case 27:
      a = win(bias, w, r[5], 100);
      s.push(sg(Ls, a[0], a[1], 2, 0, M(90, 150 + r[7] % 90, 3)));
      break;
    case 28: s.push(sg(1500, wLo(r[5], 150), 1000, 0, 10, M(150, 60 + r[7] % 40, 1))); break;
    case 29: s.push(sg(1800, 0, nHi(r[5], 140), 0, 11, M(140, 50 + r[7] % 30, 2))); break;
    case 30:
      if (bias === 0) { lo = nHi(r[5], 150); s.push(sg(3000, 0, lo, 0, 11, M(150, 100, 2)), sg(3000, Math.max(0, lo - S3.OV - r[6] % 60), 1000, 0, 4, M(100, 90, 1)), sg(3000, 0, lo, 0, 11, M(150, 110, 2))); }
      else { lo = wLo(r[5], 150); s.push(sg(3000, lo, 1000, 0, 4, M(150, 100, 1)), sg(3000, 0, Math.min(1000, lo + S3.OV + r[6] % 60), 0, 11, M(100, 90, 2)), sg(3000, lo, 1000, 0, 4, M(150, 110, 1))); }
      break;
    case 32: s.push(sg(12000 + r[6] % 8000, 0, 150 + r[5] % 50, 4, 0)); break;
    case 33: a = win(bias, w, r[5]); for (var z3 = 0; z3 < 4; z3++) s.push(sg(0, a[0], a[1], 0, 1 + z3 % 2, null, z3 > 0)); break;
    case 34: a = win(bias, w + 60, r[5]); b = shiftWin(a, bias, 160 + r[6] % 120); s.push(sg(5000, a[0], a[1], 3, 0), sg(5000 + r[7] % 4000, b[0], b[1], 3, 0)); break;
    default: // 35 laser grid
      a = win(bias, w + 40, r[5]);
      s.push(bias === 1 ? sg(2000, wLo(r[6], 120), 1000, 0, 8, M(120, 70, 1)) : sg(2000, 0, nHi(r[6], 120), 0, 11, M(120, 70, 2)));
      s.push(sg(4000, a[0], a[1], 3, 0, null, true));
      s.push(bias === 1 ? sg(0, 0, nHi(r[7], 0), 0, 1, null, true) : sg(0, wLo(r[7], 0), 1000, 0, 1, null, true));
  }
  // lay the segments out
  for (var i = 1; i < s.length; i++) {
    var p = s[i - 1], c2 = s[i];
    var ol = Math.max(p.lo, c2.lo), oh = Math.min(p.hi, c2.hi);
    if (!c2.sep && oh - ol < S3.OV) c2.sep = true;      // no safe overlap: give it a run-up instead
    if (!c2.sep) {
      var tr = Math.max(0, ol - p.hl, p.hh - oh);
      p.L = Math.max(p.L, (Math.ceil(tr / S3.RATE) + S3.IN_REACT) * S3.VCAP);
    }
  }
  var zz = 0;
  for (i = 0; i < s.length; i++) {
    if (i > 0 && s[i].sep) {
      var pr = s[i - 1], t2 = Math.max(0, s[i].lo - pr.hl, pr.hh - s[i].hi);
      zz += (Math.ceil(t2 / S3.RATE) + S3.ROW_REACT) * S3.VCAP;
    }
    s[i].a = zz; zz += s[i].L; s[i].b = zz;
  }
  var o = { k: k, kind: kind, bias: bias, segs: s, len: zz, lo: s[0].lo, hi: s[0].hi, elo: s[s.length - 1].hl, ehi: s[s.length - 1].hh,
            pk: [], pkT: -1, pkLo: 0, pkHi: 0 };
  // a pickup in the gap before it
  if (k >= 1 && r[10] < 620) {
    var opts = [];
    for (var pq = 0; pq < PICKS.length; pq++) if (k >= PICKS[pq][1]) opts.push(PICKS[pq][0]);
    var rr = r[11];
    o.pkT = rr < 450 ? 0 : opts[rr % opts.length];
    var pw = 220 + rr % 120, plo = (rr * 7) % (1001 - pw);
    o.pkLo = plo; o.pkHi = plo + pw;
  }
  return o;
}
function gap3(seed, k, j, aLo, aHi, bLo, bHi, z, ver) {
  var hs = hardSteps(z, ver), react = Math.max(Math.max(6, 12 - hs), 40 - k);
  var travel = Math.max(0, bLo - aLo, aHi - bHi);
  var steps = Math.ceil(travel / S3.RATE) + react + d3(seed, k, 20 + j, Math.max(4, 10 - hs));
  var v = Math.min(S3.VCAP, speedOf(z + steps * S3.VCAP, ver) + S3.BOOST);
  return Math.max(2200, steps * v);
}
function course3(seed, upto, list, ver) {
  ver = ver || 3;
  while (!list.length || list[list.length - 1].z0 < upto) {
    var prev = list.length ? list[list.length - 1] : null;
    var o = makeObstacle3(seed, list.length, prev, ver);
    var z;
    if (!prev) z = S.START_Z;
    else if (o.pkT >= 0) {
      var zp = prev.z1 + gap3(seed, o.k, 0, prev.elo, prev.ehi, o.pkLo, o.pkHi, prev.z1, ver);
      var n = o.pkT === 1 ? 5 : 1;
      for (var j = 0; j < n; j++) o.pk.push({ z: zp + j * 600, lo: o.pkLo, hi: o.pkHi, t: o.pkT, j: j });
      var zl = zp + (n - 1) * 600;
      z = zl + gap3(seed, o.k, 1, o.pkLo, o.pkHi, o.lo, o.hi, zl, ver);
    } else z = prev.z1 + gap3(seed, o.k, 0, prev.elo, prev.ehi, o.lo, o.hi, prev.z1, ver);
    o.z0 = z; o.z1 = z + o.len;
    list.push(o);
  }
  return list;
}
function segAt(sg2, t) {
  var lo = sg2.lo, hi = sg2.hi;
  if (sg2.mv) { var m = tri(t, sg2.mv); if (sg2.mv.e & 1) lo = Math.max(0, lo - m); if (sg2.mv.e & 2) hi = Math.min(1000, hi + m); }
  return lo * 2048 + hi;    // packed, so nothing is allocated per step
}
// the target a flawless pilot holds: the next pickup if it is before the
// obstacle, else the overlap of the current segment with the next, else the
// core of the segment ahead. Rules-side so the client autopilot, the test
// pilots and the bound all aim the same way; the rules never call it.
function aim3(sim) {
  var c = sim.course, o = c[sim.next];
  if (!o) return sim.target;
  var d = sim.dist;
  for (var i = 0; i < o.pk.length; i++) if (o.pk[i].z > d) return (o.pk[i].lo + o.pk[i].hi) >> 1;
  var s = o.segs;
  for (i = 0; i < s.length; i++) {
    if (o.z0 + s[i].b < d) continue;
    var cur = s[i];
    if (o.z0 + cur.a <= d && i + 1 < s.length && !s[i + 1].sep) {
      var nx = s[i + 1];
      return (Math.max(cur.lo, nx.lo) + Math.min(cur.hi, nx.hi)) >> 1;
    }
    return (cur.lo + cur.hi) >> 1;
  }
  return (s[s.length - 1].lo + s[s.length - 1].hi) >> 1;
}
function stepSim3(sim) {
  if (sim.dead) return sim;
  var ev = [];
  var d = sim.spread - sim.target;
  sim.spread = d > S3.RATE ? sim.spread - S3.RATE : d < -S3.RATE ? sim.spread + S3.RATE : sim.target;
  var v = speedOf(sim.dist, sim.version);
  if (sim.boost > 0) { v += S3.BOOST; sim.boost--; }
  if (sim.version >= 4) v = Math.min(S3.VCAP, v);
  else if (sim.slow > 0) { v = Math.max(S.V_START, v - S3.SLOW); sim.slow--; }
  if (sim.magnet > 0) sim.magnet--;
  if (sim.x2 > 0) sim.x2--;
  var mul = sim.x2 > 0 ? 2 : 1;
  var from = sim.dist, to = sim.dist + v;
  sim.v = v; sim.dist = to; sim.step++;
  course3(sim.seed, to + 200000, sim.course, sim.version);
  var c = sim.course, sp = sim.spread;
  for (var i = sim.next; i < c.length && c[i].z0 <= to && !sim.dead; i++) {
    var o = c[i];
    if (o.k === sim.ghost) continue;
    for (var j = 0; j < o.segs.length; j++) {
      var s = o.segs[j];
      if (o.z0 + s.a > to || o.z0 + s.b <= from) continue;   // not under the skates this step
      var iv = segAt(s, sim.step), lo = Math.floor(iv / 2048), hi = iv % 2048;
      if (sp < lo || sp > hi) {
        if (sim.shield > 0) { sim.shield = 0; sim.ghost = o.k; ev.push({ t: 'shield', k: o.k }); break; }
        sim.dead = sim.step; sim.deathStep = sim.step;
        sim.cause = s.vis === 1 || s.vis === 4 ? 'edge' : s.vis === 0 ? 'cone' : 'rail';
        ev.push({ t: 'die', k: o.k, cause: sim.cause, seg: j });
        break;
      }
    }
  }
  if (!sim.dead) {
    for (i = Math.max(0, sim.next - 1); i < Math.min(c.length, sim.next + 2); i++) {
      var pk = c[i].pk;
      for (j = 0; j < pk.length; j++) {
        var p = pk[j];
        if (p.z <= from || p.z > to) continue;
        var gemT = p.t <= 2;
        if (!((gemT && sim.magnet > 0) || (sp >= p.lo && sp <= p.hi))) continue;
        if (p.t === 0 || p.t === 1) { sim.gems++; sim.score += S3.GEM * mul; }
        else if (p.t === 2) { sim.gems += 5; sim.score += S3.BIG * mul; }
        else if (p.t === 3) { sim.boost = S3.BOOST_STEPS; sim.slow = 0; }
        else if (p.t === 4) sim.magnet = S3.MAG_STEPS;
        else if (p.t === 5) sim.shield = 1;
        else if (p.t === 6) sim.x2 = S3.X2_STEPS;
        else { sim.slow = S3.SLOW_STEPS; sim.boost = 0; }
        ev.push({ t: 'pk', k: c[i].k, j: j, type: p.t });
      }
    }
  }
  while (!sim.dead && sim.next < c.length && c[sim.next].z1 <= to) {
    var q = c[sim.next];
    sim.rows++; sim.streak++;
    var gain = (S.ROW_PTS + Math.min(sim.streak, S.STREAK_CAP)) * mul;
    sim.score += gain;
    ev.push({ t: 'row', k: q.k, gain: gain, streak: sim.streak, margin: Math.min(sim.spread - q.segs[q.segs.length - 1].lo, q.segs[q.segs.length - 1].hi - sim.spread) });
    sim.next++;
  }
  if (!sim.dead && Math.floor(to / S.UNIT) > Math.floor(from / S.UNIT)) sim.score += Math.floor(to / S.UNIT) - Math.floor(from / S.UNIT);
  sim.events = ev;
  return sim;
}

// a v2 run replays on v2 rules, a v3 run on v3 rules
function stepSim(sim) { return sim.version >= 3 ? stepSim3(sim) : stepSim2(sim); }
// ==== END RULES BLOCK ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
const MAX_BATCH = 120;
// A WORK bound far above any real run; it REFUSES further inputs, never zeroes.
const MAX_INPUTS = MAX_SIM_STEPS + 20000;

function isStep(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }
function isSpread(v) { return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= 0 && v <= S.SPREAD_MAX; }

function init({ seed, maxDurationSecs, elapsedSecs, onStep } = {}) {
  return {
    mode: 'none', sim: null, onStep: typeof onStep === 'function' ? onStep : null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { margin: [], lead: [], travel: 0, need: 0, touches: 0, lifts: 0, samples: 0,
      lastT: 0, lastDir: 0, overshoots: 0, nextK: -1, settledAt: -1, prevMid: 500 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. For each obstacle: the clearance margin (how far the
// spread sat inside the safe interval; a program sits dead centre), and how
// many steps BEFORE reaching it the spread was already safe (a planner settles
// early and evenly, a thumb late and unevenly). For the drag: target travel
// against the travel the course needed, and overshoots (the target turning
// back), which a thumb makes and a program does not.
function watchStep(state) {
  const sim = state.sim, st = state.stats;
  for (const e of sim.events) {
    if (e.t === 'row') {
      st.margin.push(e.margin);
      if (e.k === st.nextK && st.settledAt >= 0) st.lead.push(sim.step - st.settledAt);
      const o = sim.course[e.k];
      const mid = (o.lo + o.hi) >> 1;
      st.need += Math.abs(mid - st.prevMid); st.prevMid = mid;
    }
  }
  const nx = sim.course[sim.next];
  if (nx && nx.k !== st.nextK) { st.nextK = nx.k; st.settledAt = -1; }
  if (nx && st.settledAt < 0 && sim.spread >= nx.lo && sim.spread <= nx.hi) st.settledAt = sim.step;
}
function noteTarget(st, v) {
  const d = v - st.lastT;
  if (d !== 0) {
    st.travel += Math.abs(d);
    const dir = d > 0 ? 1 : -1;
    if (st.lastDir !== 0 && dir !== st.lastDir) st.overshoots++;
    st.lastDir = dir;
  }
  st.lastT = v; st.samples++;
}
function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) { if (xs.length < 2) return null; const m = mean(xs); let s = 0; for (const x of xs) s += (x - m) * (x - m); return Math.sqrt(s / (xs.length - 1)); }
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }

function reject(state, reason) { state.rejectCount++; return { accepted: true, newScore: state.score, reason }; }
function stepWatched(state) { stepSim(state.sim); watchStep(state); if (state.onStep) state.onStep(state.sim); }
function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.step < step && sim.step < MAX_SIM_STEPS) stepWatched(state);
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= 2 && state.mode !== 'sim') { state.mode = 'sim'; state.sim = initSim(state.seed, Number(payload.v)); }
    return { accepted: true, newScore: state.score };
  }
  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  const sim = state.sim;

  if (kind === 'touch' || kind === 'lift') {
    // Markers only: they change nothing in the rules. Counted for the fingerprint.
    if (!isStep(payload.step) || payload.step < sim.step) return reject(state, 'bad_marker');
    if (kind === 'touch') state.stats.touches++; else state.stats.lifts++;
    return { accepted: true, newScore: state.score };
  }
  if (kind !== 'path') return { accepted: true, newScore: state.score };

  const { f, x } = payload;
  if (!isStep(f) || !Array.isArray(x) || x.length < 1 || x.length > MAX_BATCH) return reject(state, 'bad_path');
  for (let i = 0; i < x.length; i++) if (!isSpread(x[i])) return reject(state, 'bad_path');
  if (state.inputCount + x.length > MAX_INPUTS) return reject(state, 'input_cap');
  // A batch may never reach back into steps already run: a rewind would re-run
  // a window and keep the best outcome. Refused whole.
  if (f < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, f);
  if (sim.dead) { state.dead = true; state.score = sim.score; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  if (sim.step !== f) return reject(state, 'beyond_cap');
  state.inputCount += x.length;
  for (let i = 0; i < x.length && !sim.dead && sim.step < MAX_SIM_STEPS; i++) {
    setTarget(sim, x[i]);
    noteTarget(state.stats, sim.target);
    stepWatched(state);
  }
  state.score = sim.score;
  if (sim.dead) { state.dead = true; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always dies inside this bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out past the last input: a still skater meets an obstacle
  // she does not fit within seconds (the course never lets one spread survive long).
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) { stepWatched(state); guard++; }
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, deathStep: sim.deathStep, cause: sim.cause,
      score: sim.score, rows: sim.rows, dead: !!sim.dead,
      inputs: state.inputCount, rejects: state.rejectCount,
      touches: st.touches, lifts: st.lifts, samples: st.samples,
      marginMean: round3(mean(st.margin)), marginSd: round3(sd(st.margin)),
      leadMean: round3(mean(st.lead)), leadSd: round3(sd(st.lead)),
      travelRatio: st.need > 0 ? round3(st.travel / st.need) : null,
      overshootsPerRow: sim.rows ? round3(st.overshoots / sim.rows) : null,
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
  _sim: { RULES_VERSION, S, S3, KINDS, course3, aim3, segAt, initSim, stepSim, setTarget, footX, speedAt, course, hash, seedToInt, advanceTo, MAX_INPUTS, MAX_SIM_STEPS, MAX_BATCH },
};
