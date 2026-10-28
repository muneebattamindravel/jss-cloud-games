'use strict';

/**
 * Into the Haze validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a bar runs forward on its own along one of two diagonals; a tap
 * flips it to the other. Blue blocks (some sliding) end the run on contact;
 * gems score in chains. Score = whole units travelled + gem points.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed (every leg, section and
 *      obstacle is a pure function of hash(seed, k, j), drawn in a fixed order);
 *   2. applies each { kind: 'tap', n, step } at the start of step `step`,
 *      exactly as the client does (n must be the next turn's index);
 *   3. runs the same fixed steps and scores what the client would have scored.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/into-the-haze/js/rules.js.
 * shared/tests/intoTheHazeParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump.
 *
 * Integer arithmetic only: no trig, no pow, no Math.random, no clock and no
 * screen, so no dmath is needed.
 */

/* eslint-disable no-var */
// ==== INTO THE HAZE RULES BEGIN ====
// Rules space: the ground seen from above. x is across (negative left), f is
// forward distance; both in 1/256 of a world unit. The bar's head moves along
// one of two diagonals: every step it adds v to f and dir * v to x. A tap
// flips dir. Obstacles are axis-aligned boxes; touching one ends the run.
var RULES_VERSION = 3;
var U = 256;                 // one world unit
var HW = 51;                 // half the bar's width (0.2 units)
var XW = 2304;               // inner face of the edge walls (9 units from the middle)
var EDGE_T = 768;            // edge wall thickness
var ROUTE_MARGIN = 768;      // the safe route keeps this far inside the edge walls
var V_START = 6;             // the bar sets off slowly ...
var RAMP_EVERY = 115;        // ... gaining 1 speed every 0.45 units, so it reaches V0 in about 2 s
var V0 = 17;                 // the cruising speed after the ramp, per step on each axis (v3)
var VMAX = 40;
var V_EVERY = 36 * 256;      // +1 speed every 36 units forward (v3): top speed after about 135 s
var V0_V2 = 22;              // v2 cruised at 22 ...
var V_EVERY_V2 = 30 * 256;   // ... and gained 1 every 30 units (top speed after about 79 s)
var TURN_GAP = 4;            // a tap this soon after the last turn is dropped
var START_CLEAR = 7 * 256;   // no obstacle (bar the edges) in the first 7 units
var CLEAR0 = 150;            // the safe route's clearance at the start
var CLEAR_MIN = 100;         // and its floor
var CLEAR_EVERY = 8 * 256;   // clearance shrinks by 1 every 8 units
var ORB_R = 115;             // a gem is taken inside this box around its centre
var ORB_POINTS = 5;          // a gem's worth, times its place in the chain
var ORB_CHAIN_MAX = 5;       // the chain multiplier tops out here
var ORB_PCT = 30;            // share of legs that carry a gem
var CORNER_PCT = 85;         // share of route turns guarded by a corner piece
var MOVER_PCT = 22;          // share of field blocks that slide
var AHEAD = 64 * 256;        // the course exists this far ahead of the head
var BEHIND = 24 * 256;       // and is forgotten this far behind
var MAX_SIM_STEPS = 216000;  // one session hour
// Section types (block patterns).
var T_OPEN = 0, T_BLOCKS = 1, T_CORRIDOR = 2, T_GATES = 3, T_SLIDE = 4,
  T_GRID = 5, T_PILLARS = 6, T_ROWS = 7, T_DIAG = 8, T_STACKS = 9;
// Leg lengths (forward extent) per section type, in 1/256 units.
var LEG_MIN = [307, 256, 179, 256, 307, 256, 230, 307, 256, 256];
var LEG_MAX = [819, 666, 358, 666, 666, 614, 512, 666, 614, 614];
// The course runs in chapters. Each chapter draws its sections from one theme,
// a set of three patterns; the next chapter picks a different theme. The
// drawing changes the colour scheme at the same boundary.
var CHAPTER = 150 * 256;
var THEMES = [
  [T_OPEN, T_BLOCKS, T_ROWS],
  [T_GRID, T_SLIDE, T_OPEN],
  [T_PILLARS, T_GATES, T_DIAG],
  [T_ROWS, T_STACKS, T_SLIDE],
  [T_CORRIDOR, T_GRID, T_PILLARS],
  [T_DIAG, T_STACKS, T_CORRIDOR],
  [T_GATES, T_ROWS, T_PILLARS]
];
var SLIDE_FROM = 30 * 256;
var GATE_EVERY = 640;        // a gate row every 2.5 units in a gate section
var GATE_DEPTH = 154;        // a gate row's depth
var SLIDE_EVERY = 640;       // a slider row every 2.5 units in a slider section
// Obstacle kinds. The drawn height of each is cosmetic; the rules only see the footprint.
var K_EDGE = 0, K_SLAB = 1, K_BLOCK = 2, K_WALL = 3, K_GATE = 4, K_PILLAR = 5, K_STACK = 6, K_CUBE = 7;

function h32(a, b, c) {
  var h = (a ^ 0x9e3779b9) | 0;
  h = Math.imul(h ^ (b | 0), 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h ^ (c | 0), 0xc2b2ae35); h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2d); h ^= h >>> 15;
  return h >>> 0;
}
function draw(seed, k, j, n) { return h32(seed, k, j) % n; }

// The session seed (hex from the server) as one 32-bit integer.
var SEED_MIX = 0x2545f491;
function seedToInt(seed) {
  if (typeof seed === 'number') return seed >>> 0;
  if (typeof seed !== 'string' || !/^[0-9a-f]{16}/i.test(seed)) return 0;
  return (parseInt(seed.slice(0, 8), 16) + Math.imul(parseInt(seed.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

// The speed curve a run is played on, chosen by its trace version: a run is
// always replayed on the curve it was played on.
function speedProfile(version) {
  var v0 = version === 2 ? V0_V2 : V0, every = version === 2 ? V_EVERY_V2 : V_EVERY;
  return { v0: v0, every: every, rampEnd: (v0 - V_START) * RAMP_EVERY };
}
function speedAt(f, p) {
  if (f < p.rampEnd) return V_START + Math.floor(f / RAMP_EVERY);
  return Math.min(VMAX, p.v0 + Math.floor(f / p.every));
}
// The next distance at which the speed can change.
function bandEnd(f, p) {
  if (f < p.rampEnd) return (Math.floor(f / RAMP_EVERY) + 1) * RAMP_EVERY;
  return (Math.floor(f / p.every) + 1) * p.every;
}
function clearAt(f) { return Math.max(CLEAR_MIN, CLEAR0 - Math.floor(f / CLEAR_EVERY)); }

// Speed depends only on distance, never on the taps, so the step at which the
// head first reaches any distance is fixed in advance. That is what lets a
// sliding block be proved clear of the safe route at the moment it is passed.
function stepAtF(f, p) {
  var n = 0, cur = 0;
  while (cur < f) {
    var v = speedAt(cur, p);
    if (v === VMAX && cur >= p.rampEnd) { n += Math.floor((f - cur + v - 1) / v); break; }
    var end = Math.min(f, bandEnd(cur, p));
    var k = Math.floor((end - cur + v - 1) / v);
    cur += k * v; n += k;
  }
  return n;
}

// A slider's offset across at step n: a triangle wave from -A to +A, period P (even).
function moveOff(o, n) {
  if (!o.mA) return 0;
  var P = o.mP, h = P >> 1, u = (n + o.mPh) % P;
  var t = u < h ? u : P - u;
  return Math.floor((2 * o.mA * t) / h) - o.mA;
}

function newCourse(seed, sp) {
  return { seed: seed >>> 0, sp: sp, legs: [], secs: [], obs: [], orbs: [], themes: [0],
    x: 0, f: 0, dir: 1, legLo: 0, secLo: 0, built: 0 };
}

// The theme of chapter z: chapter 0 is always the gentle one; after that a
// seeded pick among the rest, never the same theme twice running.
function themeOf(c, z) {
  while (c.themes.length <= z) {
    var k = c.themes.length, t = 1 + draw(c.seed, 700000 + k, 1, THEMES.length - 1);
    if (t === c.themes[k - 1]) t = 1 + (t % (THEMES.length - 1));
    c.themes.push(t);
  }
  return c.themes[z];
}

// One section of the safe route: its legs alternate direction and stay inside
// the edge walls. Fixed draws per leg, always taken, whatever the section type.
function addSection(c) {
  var s = c.secs.length, seed = c.seed;
  var t = THEMES[themeOf(c, Math.floor(c.f / CHAPTER))][draw(seed, s, 1, 3)];
  if (s === 0) t = T_OPEN;
  var n = 5 + draw(seed, s, 2, 5);
  var sec = { t: t, legA: c.legs.length, legB: 0, f0: c.f, f1: 0, obA: 0, obB: 0 };
  var lim = XW - ROUTE_MARGIN;
  for (var i = 0; i < n; i++) {
    var k = c.legs.length;
    var L = LEG_MIN[t] + draw(seed, k, 3, LEG_MAX[t] - LEG_MIN[t] + 1);
    if (k === 0) L = 640;
    var d = c.dir;
    if (d > 0 && c.x + L > lim) L = Math.max(LEG_MIN[t], lim - c.x);
    if (d < 0 && c.x - L < -lim) L = Math.max(LEG_MIN[t], c.x + lim);
    var orb = k > 1 && draw(seed, k, 4, 100) < ORB_PCT;
    c.legs.push({ x: c.x, f: c.f, d: d, L: L });
    if (orb) {
      var hm = Math.floor(L / 2);
      c.orbs.push({ id: k, x: c.x + d * hm, f: c.f + hm, taken: 0 });
    }
    c.x += d * L; c.f += L; c.dir = -d;
  }
  sec.legB = c.legs.length; sec.f1 = c.f;
  c.secs.push(sec);
}

// Does the safe route pass within m of the box? Exact: a 45 degree leg clipped
// to the box's forward range is a segment whose x range is an interval.
function nearRoute(c, x0, x1, f0, f1, m) {
  var legs = c.legs;
  for (var i = c.legLo; i < legs.length; i++) {
    var g = legs[i];
    if (g.f > f1 + m) break;
    var fa = Math.max(g.f, f0 - m), fb = Math.min(g.f + g.L, f1 + m);
    if (fa > fb) continue;
    var xa = g.x + g.d * (fa - g.f), xb = g.x + g.d * (fb - g.f);
    var lo = Math.min(xa, xb), hi = Math.max(xa, xb);
    if (hi >= x0 - m && lo <= x1 + m) return true;
  }
  return false;
}

// A box's whole sweep (a slider covers its range either side).
function clashes(c, sec, x0, x1, f0, f1) {
  for (var i = sec.obA; i < c.obs.length; i++) {
    var o = c.obs[i];
    if (o.k === K_EDGE) continue;
    if (o.x0 - o.mA < x1 && o.x1 + o.mA > x0 && o.f0 < f1 && o.f1 > f0) return true;
  }
  return false;
}

// Place a still box if it keeps the route's clearance and does not overlap another obstacle.
function place(c, sec, kind, x0, x1, f0, f1) {
  if (x1 <= x0 || f1 <= f0) return false;
  if (f0 < START_CLEAR) return false;
  if (nearRoute(c, x0, x1, f0, f1, HW + clearAt(f0))) return false;
  if (clashes(c, sec, x0, x1, f0, f1)) return false;
  c.obs.push({ k: kind, x0: x0, x1: x1, f0: f0, f1: f1, mA: 0, mP: 2, mPh: 0 });
  return true;
}

// Place a slider. It may sweep right across the safe route, but over the exact
// steps the head spends level with it, its whole reach keeps the clearance.
// Four phases are tried in a fixed order; if none is clear it is not placed.
function placeMover(c, sec, kind, x0, x1, f0, f1, A, P, ph) {
  if (x1 <= x0 || f1 <= f0 || f0 < START_CLEAR) return false;
  if (x0 - A < -XW || x1 + A > XW) return false;
  if (clashes(c, sec, x0 - A, x1 + A, f0, f1)) return false;
  var m = HW + clearAt(f0);
  var na = stepAtF(f0 - m, c.sp) - 2, nb = stepAtF(f1 + m + 1, c.sp) + 2;
  var o = { k: kind, x0: x0, x1: x1, f0: f0, f1: f1, mA: A, mP: P, mPh: 0 };
  for (var tr = 0; tr < 4; tr++) {
    o.mPh = (ph + tr * (P >> 2)) % P;
    var lo = A, hi = -A;
    for (var n = na; n <= nb; n++) { var off = moveOff(o, n); if (off < lo) lo = off; if (off > hi) hi = off; }
    if (!nearRoute(c, x0 + lo, x1 + hi, f0, f1, m)) { c.obs.push(o); return true; }
  }
  return false;
}

// The obstacles of one section. Fixed draws per candidate index, always taken.
function fillSection(c, si) {
  var sec = c.secs[si], seed = c.seed;
  sec.obA = c.obs.length;
  c.obs.push({ k: K_EDGE, x0: -XW - EDGE_T, x1: -XW, f0: sec.f0, f1: sec.f1, mA: 0, mP: 2, mPh: 0 });
  c.obs.push({ k: K_EDGE, x0: XW, x1: XW + EDGE_T, f0: sec.f0, f1: sec.f1, mA: 0, mP: 2, mPh: 0 });
  var span = sec.f1 - sec.f0, base = 10000 + si * 64;
  var dens = Math.min(12, Math.floor(sec.f0 / (30 * U)));
  var j, n, w, dd, cx, cf, A, P;
  var corners = sec.t === T_OPEN || sec.t === T_BLOCKS || sec.t === T_SLIDE || sec.t === T_ROWS || sec.t === T_STACKS;
  if (corners) {
    // Corner pieces first: a slab or block straight on past each turn of the
    // route, so missing the turn runs into it. This is what makes timing count.
    for (var q = sec.legA; q < sec.legB; q++) {
      var cg = c.legs[q];
      var cr = draw(seed, base + q, 8, 100), cs = 154 + draw(seed, base + q, 9, 110), ca = 200 + draw(seed, base + q, 10, 160);
      if (cr >= CORNER_PCT) continue;
      var ex = cg.x + cg.d * cg.L, ef = cg.f + cg.L;
      var px = ex + cg.d * ca, pf = ef + ca, kk = sec.t === T_OPEN ? K_SLAB : sec.t === T_STACKS ? K_STACK : K_BLOCK;
      // too close to where the route goes next: try it smaller, then smaller again
      if (!place(c, sec, kk, px - cs, px + cs, pf - cs, pf + cs)) {
        var c2 = (cs * 2) >> 2;
        if (!place(c, sec, kk, px - cs + c2, px + cs - c2, pf - cs + c2, pf + cs - c2)) {
          var c3 = (cs * 3) >> 2;
          place(c, sec, kk, px - cs + c3, px + cs - c3, pf - cs + c3, pf + cs - c3);
        }
      }
    }
  }
  if (sec.t === T_SLIDE) {
    // Rows of sliders sweeping across the route's line: each is proved clear
    // of the safe route at the moment the head passes it.
    for (cf = sec.f0 + SLIDE_EVERY, j = 0; cf + 256 < sec.f1; cf += SLIDE_EVERY, j++) {
      w = 205 + draw(seed, base + j, 11, 154); dd = 154 + draw(seed, base + j, 12, 100);
      A = 384 + draw(seed, base + j, 13, 385); P = 2 * (40 + draw(seed, base + j, 14, 40));
      cx = routeX(c, cf) + draw(seed, base + j, 15, 2 * A + 1) - A;
      placeMover(c, sec, K_SLAB, cx - (w >> 1), cx + (w >> 1), cf, cf + dd, A, P, draw(seed, base + j, 16, P));
    }
  }
  if (sec.t === T_OPEN || sec.t === T_BLOCKS || sec.t === T_SLIDE) {
    n = (sec.t === T_OPEN ? 14 : sec.t === T_BLOCKS ? 11 : 6) + dens;
    for (j = 0; j < n; j++) {
      var big = sec.t === T_OPEN;
      w = big ? 256 + draw(seed, base + j, 1, 370) : 230 + draw(seed, base + j, 1, 130);
      dd = big ? 230 + draw(seed, base + j, 2, 280) : w + 0 * draw(seed, base + j, 2, 2);
      cx = -XW + draw(seed, base + j, 3, 2 * XW + 1);
      cf = sec.f0 + draw(seed, base + j, 4, span + 1);
      var mv = sec.f0 >= SLIDE_FROM && draw(seed, base + j, 5, 100) < MOVER_PCT;
      A = 205 + draw(seed, base + j, 6, 256); P = 2 * (45 + draw(seed, base + j, 7, 45));
      var kind = big ? K_SLAB : K_BLOCK;
      if (mv) placeMover(c, sec, kind, cx - (w >> 1), cx + (w >> 1), cf - (dd >> 1), cf + (dd >> 1), A, P, draw(seed, base + j, 9, P));
      else place(c, sec, kind, cx - (w >> 1), cx + (w >> 1), cf - (dd >> 1), cf + (dd >> 1));
    }
  } else if (sec.t === T_GRID || sec.t === T_PILLARS) {
    // A regular field: square slabs on a grid, or thin tall pillars staggered
    // row by row. The safe route carves its own way through.
    var pil = sec.t === T_PILLARS;
    var sz = pil ? 102 + draw(seed, base, 20, 79) : 154 + draw(seed, base, 20, 129);
    var gap = pil ? 230 + draw(seed, base, 21, 151) : 102 + draw(seed, base, 22, 129);
    var pitch = sz + gap, chk = !pil && draw(seed, base, 23, 100) < 40, stag = pil || draw(seed, base, 24, 100) < 50;
    var ox = draw(seed, base, 25, pitch), row = 0;
    for (cf = sec.f0 + draw(seed, base, 26, pitch); cf + sz < sec.f1; cf += pitch, row++) {
      var sx = -XW + ox + (stag && (row & 1) ? pitch >> 1 : 0), col = 0;
      for (cx = sx; cx + sz <= XW; cx += pitch, col++) {
        if (chk && ((row + col) & 1)) continue;
        place(c, sec, pil ? K_PILLAR : K_SLAB, cx, cx + sz, cf, cf + sz);
      }
    }
  } else if (sec.t === T_ROWS) {
    // Rows of evenly spaced blocks across the whole band, each row shifted.
    var rk = draw(seed, base, 20, 2) ? K_BLOCK : K_SLAB;
    var rgap = 460 + draw(seed, base, 21, 201), r2 = 0;
    for (cf = sec.f0 + (rgap >> 1); cf + 256 < sec.f1; cf += rgap, r2++) {
      var cnt = 3 + draw(seed, base + r2, 27, 3), spc = Math.floor((2 * XW) / cnt);
      w = 205 + draw(seed, base + r2, 28, 129);
      var off = draw(seed, base + r2, 29, spc);
      for (var b2 = 0; b2 < cnt; b2++) {
        cx = -XW + off + b2 * spc;
        place(c, sec, rk, cx - (w >> 1), cx + (w >> 1), cf, cf + w);
      }
    }
  } else if (sec.t === T_DIAG) {
    // Chains of little cubes laid along the diagonals, like walls of stepping stones.
    n = 6 + (dens >> 1);
    for (j = 0; j < n; j++) {
      var len = 4 + draw(seed, base + j, 30, 6), dd2 = draw(seed, base + j, 31, 2) ? 1 : -1;
      cx = -XW + draw(seed, base + j, 32, 2 * XW + 1);
      cf = sec.f0 + draw(seed, base + j, 33, span + 1);
      for (var e2 = 0; e2 < len; e2++) {
        var qx = cx + dd2 * e2 * 141, qf = cf + e2 * 141;
        if (qf + 115 > sec.f1) break;
        place(c, sec, K_CUBE, qx, qx + 115, qf, qf + 115);
      }
    }
  } else if (sec.t === T_STACKS) {
    // Cubes stacked two or three high, scattered.
    n = 10 + dens;
    for (j = 0; j < n; j++) {
      w = 154 + draw(seed, base + j, 1, 77);
      cx = -XW + draw(seed, base + j, 3, 2 * XW + 1);
      cf = sec.f0 + draw(seed, base + j, 4, span + 1);
      place(c, sec, K_STACK, cx - (w >> 1), cx + (w >> 1), cf - (w >> 1), cf + (w >> 1));
    }
  } else if (sec.t === T_CORRIDOR) {
    // Walls hugging each leg on both sides, as close as the clearance allows
    // plus a seeded slack, so the corridor follows the zig-zag.
    for (var k = sec.legA; k < sec.legB; k++) {
      var g = c.legs[k], m = HW + clearAt(g.f) + 1;
      var lo = Math.min(g.x, g.x + g.d * g.L), hi = Math.max(g.x, g.x + g.d * g.L);
      var sl = draw(seed, base + k, 5, 90), sr = draw(seed, base + k, 6, 90);
      place(c, sec, K_WALL, -XW, lo - m - sl, g.f, g.f + g.L);
      place(c, sec, K_WALL, hi + m + sr, XW, g.f, g.f + g.L);
    }
  } else {
    // Gate rows across the band with one opening where the route crosses.
    for (cf = sec.f0 + GATE_EVERY; cf + GATE_DEPTH < sec.f1; cf += GATE_EVERY) {
      var gx = routeX(c, cf), gm = HW + clearAt(cf) + 30 + draw(seed, base + (cf >> 6), 7, 70);
      place(c, sec, K_GATE, -XW, gx - gm - GATE_DEPTH, cf, cf + GATE_DEPTH);
      place(c, sec, K_GATE, gx + gm + GATE_DEPTH, XW, cf, cf + GATE_DEPTH);
    }
    n = 4 + (dens >> 1);
    for (j = 0; j < n; j++) {
      w = 230 + draw(seed, base + j, 1, 130);
      cx = -XW + draw(seed, base + j, 3, 2 * XW + 1);
      cf = sec.f0 + draw(seed, base + j, 4, span + 1);
      place(c, sec, K_BLOCK, cx - (w >> 1), cx + (w >> 1), cf - (w >> 1), cf + (w >> 1));
    }
  }
  sec.obB = c.obs.length;
}

// The route's x at forward distance f (the route must already reach f).
function routeX(c, f) {
  for (var i = c.legLo; i < c.legs.length; i++) {
    var g = c.legs[i];
    if (f <= g.f + g.L) return g.x + g.d * (Math.max(f, g.f) - g.f);
  }
  return c.x;
}

// Grow the course ahead of f and forget what lies far behind it. A section's
// obstacles are made only once the route runs a whole section past it.
function ensureCourse(c, f) {
  while (c.f < f + AHEAD) addSection(c);
  while (c.built < c.secs.length - 1 && c.secs[c.built + 1].f0 < f + AHEAD) { fillSection(c, c.built); c.built++; }
  while (c.legLo < c.legs.length && c.legs[c.legLo].f + c.legs[c.legLo].L < f - BEHIND) c.legLo++;
  while (c.secLo < c.built && c.secs[c.secLo].f1 < f - BEHIND) c.secLo++;
}

function initSim(seed, version) {
  var ver = version === 2 ? 2 : RULES_VERSION;
  var c = newCourse(seedToInt(seed), speedProfile(ver));
  ensureCourse(c, 0);
  return { version: ver, course: c, x: 0, f: 0, dir: 1, v: V_START, steps: 0,
    lastTurn: -TURN_GAP, turns: 0, orbs: 0, orbIdx: 0, chain: 0, orbPts: 0,
    alive: true, deathStep: -1, deathBy: -1, score: 0 };
}

// A tap: flips the heading, unless the bar turned less than TURN_GAP steps ago.
function tapSim(sim) {
  if (!sim.alive || sim.steps - sim.lastTurn < TURN_GAP) return false;
  sim.dir = -sim.dir;
  sim.lastTurn = sim.steps;
  sim.turns++;
  return true;
}

function hitTest(sim) {
  var c = sim.course, x0 = sim.x - HW, x1 = sim.x + HW, f0 = sim.f - HW, f1 = sim.f + HW;
  for (var s = c.secLo; s < c.built; s++) {
    var sec = c.secs[s];
    if (sec.f0 > f1) break;
    if (sec.f1 < f0) continue;
    for (var i = sec.obA; i < sec.obB; i++) {
      var o = c.obs[i], off = moveOff(o, sim.steps);
      if (o.x0 + off < x1 && o.x1 + off > x0 && o.f0 < f1 && o.f1 > f0) return i;
    }
  }
  return -1;
}

function stepSim(sim) {
  if (!sim.alive) return;
  sim.v = speedAt(sim.f, sim.course.sp);
  sim.x += sim.dir * sim.v;
  sim.f += sim.v;
  sim.steps++;
  ensureCourse(sim.course, sim.f);
  var orbs = sim.course.orbs;
  // a gem left behind untaken breaks the chain
  while (sim.orbIdx < orbs.length && orbs[sim.orbIdx].f < sim.f - ORB_R) {
    if (!orbs[sim.orbIdx].taken) sim.chain = 0;
    sim.orbIdx++;
  }
  for (var i = sim.orbIdx; i < orbs.length && orbs[i].f <= sim.f + ORB_R; i++) {
    var o = orbs[i];
    if (!o.taken && Math.abs(o.x - sim.x) <= ORB_R && Math.abs(o.f - sim.f) <= ORB_R) {
      o.taken = sim.steps; sim.orbs++;
      sim.chain = Math.min(ORB_CHAIN_MAX, sim.chain + 1);
      sim.orbPts += ORB_POINTS * sim.chain;
    }
  }
  var hit = hitTest(sim);
  if (hit >= 0 || sim.steps >= MAX_SIM_STEPS) { sim.alive = false; sim.deathStep = sim.steps; sim.deathBy = hit; }
  sim.score = Math.floor(sim.f / U) + sim.orbPts;
}
// ==== INTO THE HAZE RULES END ====

// A WORK bound far above any real run: a turn needs TURN_GAP steps, so an hour
// holds at most MAX_SIM_STEPS / TURN_GAP of them. It REFUSES further taps, never zeroes.
const MAX_INPUTS = Math.ceil(MAX_SIM_STEPS / TURN_GAP) + 100;

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs, onStep } = {}) {
  return {
    mode: 'none', sim: null, onStep: typeof onStep === 'function' ? onStep : null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { gaps: [], lastStep: -1, err: [], offRoute: 0 },
  };
}

function stepWatched(state) {
  stepSim(state.sim);
  if (state.onStep) state.onStep(state.sim);
}

// Every step the server runs goes through stepWatched, so a test's per-step
// hook sees the whole run, gaps between taps included.
function advanceTo(state, step) {
  const sim = state.sim;
  while (sim.alive && sim.steps < step && sim.steps < MAX_SIM_STEPS) stepWatched(state);
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. At each turn: how far the head sits off the course's
// own safe line (a program that reads the seed turns on it, a hand scatters
// around it), whether the turn heads away from the safe line's heading, and
// the gap in steps since the last turn (rhythm).
function routeDirAt(c, f) {
  for (let i = c.legLo; i < c.legs.length; i++) {
    const g = c.legs[i];
    if (f <= g.f + g.L) return g.d;
  }
  return 0;
}
function noteTap(state) {
  const sim = state.sim, st = state.stats, c = sim.course;
  if (sim.f <= c.f) st.err.push(Math.abs(sim.x - routeX(c, sim.f)));
  if (st.lastStep >= 0) st.gaps.push(sim.steps - st.lastStep);
  st.lastStep = sim.steps;
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
      // the run is replayed on the rules it was played on: v2 on v2's speed curve
      state.sim = initSim(state.seed, Number(payload.v) === 2 ? 2 : RULES_VERSION);
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  if (kind !== 'tap') return { accepted: true, newScore: state.score };
  const sim = state.sim;

  const { n, step } = payload;
  if (!isStep(step) || !isStep(n)) return reject(state, 'bad_tap');
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  // A tap may never name a step already run: a rewind would re-run a window
  // and keep the best outcome.
  if (step < sim.steps) return reject(state, 'frame_regressed');
  // Taps arrive in order, each naming the turn it makes.
  if (n !== sim.turns) return reject(state, 'bad_n');
  advanceTo(state, step);
  if (!sim.alive) { state.dead = true; state.score = sim.score; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  if (sim.steps !== step) return reject(state, 'beyond_cap');
  noteTap(state);
  if (!tapSim(sim)) return reject(state, 'turn_gap');
  if (routeDirAt(sim.course, sim.f) !== sim.dir) state.stats.offRoute++;
  state.inputCount++;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always dies inside this bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const sim = state.sim;
  // Run the world out past the last tap. A bar that stops turning hits
  // something within a couple of seconds (the edges bound every course).
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (sim.alive && guard < runOutSteps && sim.steps < capSteps && sim.steps < MAX_SIM_STEPS) {
    stepWatched(state);
    guard++;
  }
  const st = state.stats, gm = mean(st.gaps), gs = sd(st.gaps);
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.steps, deathStep: sim.deathStep, deathBy: sim.deathBy,
      score: sim.score, turns: sim.turns, gems: sim.orbs, alive: sim.alive,
      inputs: state.inputCount, rejects: state.rejectCount,
      gapMean: round3(gm), gapCv: gm && gs !== null ? round3(gs / gm) : null,
      routeErrMean: round3(mean(st.err)), routeErrSd: round3(sd(st.err)),
      offRouteShare: sim.turns ? round3(st.offRoute / sim.turns) : null,
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
  _sim: {
    RULES_VERSION, initSim, tapSim, stepSim, speedAt, speedProfile, clearAt, stepAtF, moveOff, routeX, seedToInt, h32,
    advanceTo, MAX_INPUTS, MAX_SIM_STEPS, U, HW, XW, TURN_GAP, CHAPTER,
  },
};
