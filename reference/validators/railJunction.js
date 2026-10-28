'use strict';

/**
 * Rail Junction validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: trains leave the tunnels on a schedule that is a pure function of
 * (seed, train index). Every switch has two ways on; the player flips them.
 * A train that reaches a station of its own colour scores, a wrong station
 * costs a heart (three hearts), and two trains meeting end the run.
 *
 * What the server does with a trace:
 *   1. rebuilds every train from the session seed;
 *   2. applies each flip { n, junction, step } before step `step + 1` runs,
 *      exactly as the client does (a flip the rules refuse, such as one on a
 *      switch a train is crossing, is refused here too);
 *   3. runs the same fixed steps and adds up the score.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/rail-junction/js/rules.js.
 * shared/tests/railJunctionParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump, never an edit
 * in place.
 */

// RAIL JUNCTION RULES BEGIN
var RULES_VERSION = 2;
var SUB = 256;                    // sub-units per design unit
var ENGINE_LEN = 24 * SUB;
var CAR_LEN = 20 * SUB;
var COUPLE = 3 * SUB;
var PLAN_MARGIN = 16 * SUB;       // the schedule keeps trains this far apart
var HIT_GAP = 2 * SUB;            // closer than this on one segment is a crash
var LOCK_PAD = 14 * SUB;          // a switch is locked while a train is this close
var CROSS_PAD = 11 * SUB;         // a crossing is occupied this far either side
var CROSS_GAP = 14;               // steps the schedule leaves between two trains on a crossing
var FLIP_WINDOW = 50;             // steps a player gets to flip between two trains
var HEARTS = 3;
var PER_LEVEL = 15;
var DELIVER_PTS = 10;
var COMBO_PTS = 5;
var COMBO_CAP = 6;
var FIRST_RELEASE = 80;
var LEVEL_PAUSE = 150;
// Speed rises a little with every level; within a level the trains come a
// little closer together with every release.
var V_BASE = 330;                 // sub-units a step (about 77 units a second)
var V_LEVEL = 16;
var V_CAP = 560;
var EXPRESS_FROM = 3;
var EXPRESS_PCT = 22;
var CARS_FROM = 1;                // three-carriage trains from this level
var GAP_START = 230;              // steps between releases at a level's start
var GAP_LEVEL = 14;
var GAP_TRAIN = 5;
var GAP_MIN = 64;
var GAP_SPREAD = 40;
var CYCLE_FROM = 2;               // after the last map, levels cycle from this map
// Past its last switch a train speeds up to its station: extra speed builds
// over BOOST_N steps to BOOST_PCT percent of its own.
var BOOST_N = 40;
var BOOST_PCT = 150;
// A level eases in: its first WARM_N trains are slower and further apart.
var WARM_N = 6;
var WARM_V = 60;
var WARM_GAP = 30;
var CORNER_R = 46;
var CORNER_N = 10;
var PLAN_TRIES = 64;
var SEED_MIX = 0x85EBCA6B;
var HASH_K = 0x9E3779B1;
var HASH_J = 0x85EBCA77;
var MIX_A = 0x7FEB352D;
var MIX_B = 0x846CA68B;

// Maps: segments are waypoint lists in design units. A segment ends at a
// switch (j), a merge (n: the segment it runs on into) or a station (s). A
// switch has one incoming segment and two outgoing ones, left first.
// Colours: 0 red, 1 blue, 2 yellow, 3 green, 4 purple, 5 orange.
// Level by level the first switch sits higher, so the warning gets shorter
// and more of the board is branching track and stations.
var MAPS = [
  { name: 'Rohri Junction', tunnels: [0],
    segs: [
      { w: [[207, 92], [207, 240]], j: 0 },
      { w: [[207, 240], [207, 270], [124, 350], [124, 415]], j: 1 },
      { w: [[207, 240], [207, 270], [330, 385], [330, 668]], s: 1 },
      { w: [[124, 415], [124, 445], [62, 520], [62, 668]], s: 0 },
      { w: [[124, 415], [124, 445], [192, 520], [192, 668]], s: 2 }
    ],
    junctions: [{ inp: 0, out: [1, 2] }, { inp: 1, out: [3, 4] }],
    stations: [{ seg: 3, col: 0 }, { seg: 2, col: 1 }, { seg: 4, col: 2 }] },
  { name: 'Khanewal Junction', tunnels: [0, 1],
    segs: [
      { w: [[110, 92], [110, 130], [207, 205], [207, 225]], n: 2 },
      { w: [[304, 92], [304, 130], [207, 205], [207, 225]], n: 2 },
      { w: [[207, 225], [207, 275]], j: 0 },
      { w: [[207, 275], [207, 300], [124, 380], [124, 440]], j: 1 },
      { w: [[207, 275], [207, 300], [330, 415], [330, 668]], s: 1 },
      { w: [[124, 440], [124, 470], [62, 540], [62, 668]], s: 2 },
      { w: [[124, 440], [124, 470], [192, 540], [192, 668]], s: 0 }
    ],
    junctions: [{ inp: 2, out: [3, 4] }, { inp: 3, out: [5, 6] }],
    stations: [{ seg: 6, col: 0 }, { seg: 4, col: 1 }, { seg: 5, col: 2 }] },
  { name: 'Multan Cantt', tunnels: [0],
    segs: [
      { w: [[207, 92], [207, 245]], j: 0 },
      { w: [[207, 245], [207, 270], [116, 345], [116, 400]], j: 1 },
      { w: [[207, 245], [207, 270], [298, 345], [298, 400]], j: 2 },
      { w: [[116, 400], [116, 425], [62, 485], [62, 668]], s: 0 },
      { w: [[116, 400], [116, 425], [160, 485], [160, 668]], s: 3 },
      { w: [[298, 400], [298, 425], [254, 485], [254, 668]], s: 1 },
      { w: [[298, 400], [298, 425], [352, 485], [352, 668]], s: 2 }
    ],
    junctions: [{ inp: 0, out: [1, 2] }, { inp: 1, out: [3, 4] }, { inp: 2, out: [5, 6] }],
    stations: [{ seg: 3, col: 0 }, { seg: 4, col: 3 }, { seg: 5, col: 1 }, { seg: 6, col: 2 }] },
  { name: 'Sukkur Junction', tunnels: [0],
    segs: [
      { w: [[207, 92], [207, 185]], j: 0 },
      { w: [[207, 185], [207, 210], [110, 290], [110, 320]], j: 1 },
      { w: [[207, 185], [207, 210], [304, 290], [304, 320]], j: 2 },
      { w: [[110, 320], [110, 345], [56, 420], [56, 668]], s: 3 },
      { w: [[110, 320], [110, 345], [254, 520], [254, 668]], s: 0 },
      { w: [[304, 320], [304, 345], [160, 520], [160, 668]], s: 1 },
      { w: [[304, 320], [304, 345], [358, 420], [358, 668]], s: 2 }
    ],
    junctions: [{ inp: 0, out: [1, 2] }, { inp: 1, out: [3, 4] }, { inp: 2, out: [5, 6] }],
    stations: [{ seg: 3, col: 3 }, { seg: 4, col: 0 }, { seg: 5, col: 1 }, { seg: 6, col: 2 }] },
  { name: 'Shikarpur Junction', tunnels: [0, 1],
    segs: [
      { w: [[110, 92], [110, 125], [207, 190], [207, 205]], n: 2 },
      { w: [[304, 92], [304, 125], [207, 190], [207, 205]], n: 2 },
      { w: [[207, 205], [207, 235]], j: 0 },
      { w: [[207, 235], [207, 260], [128, 320], [128, 335]], j: 1 },
      { w: [[207, 235], [207, 260], [325, 320], [325, 335]], j: 2 },
      { w: [[128, 335], [128, 360], [89, 405], [89, 425]], j: 3 },
      { w: [[128, 335], [128, 360], [207, 455], [207, 668]], s: 1 },
      { w: [[325, 335], [325, 360], [286, 430], [286, 668]], s: 4 },
      { w: [[325, 335], [325, 360], [364, 430], [364, 668]], s: 0 },
      { w: [[89, 425], [89, 450], [50, 510], [50, 668]], s: 2 },
      { w: [[89, 425], [89, 450], [128, 510], [128, 668]], s: 3 }
    ],
    junctions: [{ inp: 2, out: [3, 4] }, { inp: 3, out: [5, 6] }, { inp: 4, out: [7, 8] }, { inp: 5, out: [9, 10] }],
    stations: [{ seg: 9, col: 2 }, { seg: 10, col: 3 }, { seg: 6, col: 1 }, { seg: 7, col: 4 }, { seg: 8, col: 0 }] },
  { name: 'Jacobabad Junction', tunnels: [0],
    segs: [
      { w: [[207, 92], [207, 160]], j: 0 },
      { w: [[207, 160], [207, 185], [110, 255], [110, 275]], j: 1 },
      { w: [[207, 160], [207, 185], [304, 255], [304, 275]], j: 2 },
      { w: [[110, 275], [110, 300], [75, 360], [75, 380]], j: 3 },
      { w: [[110, 275], [110, 300], [286, 525], [286, 668]], s: 1 },
      { w: [[304, 275], [304, 300], [207, 450], [207, 668]], s: 4 },
      { w: [[304, 275], [304, 300], [364, 380], [364, 668]], s: 2 },
      { w: [[75, 380], [75, 405], [48, 460], [48, 668]], s: 0 },
      { w: [[75, 380], [75, 405], [128, 475], [128, 668]], s: 3 }
    ],
    junctions: [{ inp: 0, out: [1, 2] }, { inp: 1, out: [3, 4] }, { inp: 2, out: [5, 6] }, { inp: 3, out: [7, 8] }],
    stations: [{ seg: 7, col: 0 }, { seg: 8, col: 3 }, { seg: 5, col: 4 }, { seg: 4, col: 1 }, { seg: 6, col: 2 }] },
  { name: 'Karachi Cantt', tunnels: [0, 1],
    segs: [
      { w: [[110, 92], [110, 120], [207, 172], [207, 182]], n: 2 },
      { w: [[304, 92], [304, 120], [207, 172], [207, 182]], n: 2 },
      { w: [[207, 182], [207, 205]], j: 0 },
      { w: [[207, 205], [207, 228], [120, 285], [120, 300]], j: 1 },
      { w: [[207, 205], [207, 228], [294, 285], [294, 300]], j: 2 },
      { w: [[120, 300], [120, 322], [70, 380], [70, 398]], j: 3 },
      { w: [[120, 300], [120, 322], [242, 505], [242, 668]], s: 3 },
      { w: [[294, 300], [294, 322], [172, 505], [172, 668]], s: 5 },
      { w: [[294, 300], [294, 322], [344, 380], [344, 398]], j: 4 },
      { w: [[70, 398], [70, 420], [40, 470], [40, 668]], s: 0 },
      { w: [[70, 398], [70, 420], [106, 475], [106, 668]], s: 4 },
      { w: [[344, 398], [344, 420], [308, 475], [308, 668]], s: 1 },
      { w: [[344, 398], [344, 420], [374, 470], [374, 668]], s: 2 }
    ],
    junctions: [{ inp: 2, out: [3, 4] }, { inp: 3, out: [5, 6] }, { inp: 4, out: [7, 8] }, { inp: 5, out: [9, 10] }, { inp: 8, out: [11, 12] }],
    stations: [{ seg: 9, col: 0 }, { seg: 10, col: 4 }, { seg: 7, col: 5 }, { seg: 6, col: 3 }, { seg: 11, col: 1 }, { seg: 12, col: 2 }] },
  { name: 'Peshawar Cantt', tunnels: [0],
    segs: [
      { w: [[207, 92], [207, 140]], j: 0 },
      { w: [[207, 140], [207, 162], [110, 220], [110, 235]], j: 1 },
      { w: [[207, 140], [207, 162], [304, 220], [304, 235]], j: 2 },
      { w: [[110, 235], [110, 258], [62, 320], [62, 340]], j: 3 },
      { w: [[110, 235], [110, 258], [242, 470], [242, 668]], s: 5 },
      { w: [[304, 235], [304, 258], [172, 470], [172, 668]], s: 2 },
      { w: [[304, 235], [304, 258], [352, 320], [352, 340]], j: 4 },
      { w: [[62, 340], [62, 362], [40, 410], [40, 668]], s: 4 },
      { w: [[62, 340], [62, 362], [106, 425], [106, 668]], s: 1 },
      { w: [[352, 340], [352, 362], [308, 425], [308, 668]], s: 0 },
      { w: [[352, 340], [352, 362], [374, 410], [374, 668]], s: 3 }
    ],
    junctions: [{ inp: 0, out: [1, 2] }, { inp: 1, out: [3, 4] }, { inp: 2, out: [5, 6] }, { inp: 3, out: [7, 8] }, { inp: 6, out: [9, 10] }],
    stations: [{ seg: 7, col: 4 }, { seg: 8, col: 1 }, { seg: 5, col: 2 }, { seg: 4, col: 5 }, { seg: 9, col: 0 }, { seg: 10, col: 3 }] }
];

// The practice board (HOW TO PLAY) is index -1. Scored runs never reach it:
// levels are never negative.
var PRACTICE_MAPS = [
  { name: 'Practice', tunnels: [0],
    segs: [
      { w: [[207, 92], [207, 240]], j: 0 },
      { w: [[207, 240], [207, 270], [124, 350], [124, 415]], j: 1 },
      { w: [[207, 240], [207, 270], [330, 385], [330, 668]], s: 1 },
      { w: [[124, 415], [124, 445], [62, 520], [62, 668]], s: 0 },
      { w: [[124, 415], [124, 445], [192, 520], [192, 668]], s: 2 }
    ],
    junctions: [{ inp: 0, out: [1, 2] }, { inp: 1, out: [3, 4] }],
    stations: [{ seg: 3, col: 0 }, { seg: 2, col: 1 }, { seg: 4, col: 2 }] }
];

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

// Draw j of train k: a pure function of (seed, k, j).
function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, HASH_K) ^ Math.imul(j + 7, HASH_J)) | 0;
  h = Math.imul(h ^ (h >>> 16), MIX_A);
  h = Math.imul(h ^ (h >>> 15), MIX_B);
  return (h ^ (h >>> 16)) >>> 0;
}

function cdiv(a, b) { return Math.floor((a + b - 1) / b); }

// A segment's centre line: waypoints with rounded corners, sampled. Only
// + - * / and sqrt, so every engine computes the same points and length.
function buildSeg(w) {
  var pts = [[w[0][0], w[0][1]]], i, k;
  for (i = 1; i < w.length - 1; i++) {
    var ax = w[i][0] - w[i - 1][0], ay = w[i][1] - w[i - 1][1];
    var bx = w[i + 1][0] - w[i][0], by = w[i + 1][1] - w[i][1];
    var la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
    var r = Math.min(CORNER_R, la / 2, lb / 2);
    var p0x = w[i][0] - ax / la * r, p0y = w[i][1] - ay / la * r;
    var p2x = w[i][0] + bx / lb * r, p2y = w[i][1] + by / lb * r;
    pts.push([p0x, p0y]);
    for (k = 1; k <= CORNER_N; k++) {
      var t = k / CORNER_N, u = 1 - t;
      pts.push([u * u * p0x + 2 * u * t * w[i][0] + t * t * p2x, u * u * p0y + 2 * u * t * w[i][1] + t * t * p2y]);
    }
  }
  pts.push([w[w.length - 1][0], w[w.length - 1][1]]);
  var total = 0, cum = [0];
  for (i = 1; i < pts.length; i++) {
    var dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
    cum.push(total);
  }
  return { pts: pts, cum: cum, arc: total, len: Math.floor(total * SUB) };
}

// Where two segments' centre lines cross, as integer offsets along each.
// Segments that meet at a switch or a merge share an end point and are not
// crossings; a merge is added as a crossing of the two ends that meet.
function crossingsOf(segs, m) {
  var out = [], a, b, i, k;
  function touch(p, q) { return Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) < 0.5; }
  for (a = 0; a < segs.length; a++) {
    for (b = a + 1; b < segs.length; b++) {
      var A = segs[a], Bs = segs[b];
      var a0 = A.pts[0], a1 = A.pts[A.pts.length - 1], b0 = Bs.pts[0], b1 = Bs.pts[Bs.pts.length - 1];
      if (touch(a0, b0) || touch(a0, b1) || touch(a1, b0) || touch(a1, b1)) continue;
      for (i = 1; i < A.pts.length; i++) {
        for (k = 1; k < Bs.pts.length; k++) {
          var px = A.pts[i - 1][0], py = A.pts[i - 1][1], rx = A.pts[i][0] - px, ry = A.pts[i][1] - py;
          var qx = Bs.pts[k - 1][0], qy = Bs.pts[k - 1][1], sx = Bs.pts[k][0] - qx, sy = Bs.pts[k][1] - qy;
          var den = rx * sy - ry * sx;
          if (den === 0) continue;
          var t = ((qx - px) * sy - (qy - py) * sx) / den, u = ((qx - px) * ry - (qy - py) * rx) / den;
          if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
          var segA = A.cum[i] - A.cum[i - 1], segB = Bs.cum[k] - Bs.cum[k - 1];
          out.push({ a: a, oa: Math.floor((A.cum[i - 1] + t * segA) * SUB), b: b, ob: Math.floor((Bs.cum[k - 1] + u * segB) * SUB) });
        }
      }
    }
  }
  for (a = 0; a < m.segs.length; a++) {
    if (m.segs[a].n === undefined) continue;
    for (b = a + 1; b < m.segs.length; b++) {
      if (m.segs[b].n === m.segs[a].n) out.push({ a: a, oa: segs[a].len, b: b, ob: segs[b].len });
    }
  }
  return out;
}

var BUILT = {};
// Levels walk the maps once, then cycle from CYCLE_FROM with the speed still rising.
function mapOf(level) { return level < MAPS.length ? level : CYCLE_FROM + (level - CYCLE_FROM) % (MAPS.length - CYCLE_FROM); }
function board(mi) {
  var key = mi < 0 ? 'p' + (-1 - mi) : 'm' + mi;
  if (BUILT[key]) return BUILT[key];
  var m = mi < 0 ? PRACTICE_MAPS[-1 - mi] : MAPS[mi], segs = [], i;
  for (i = 0; i < m.segs.length; i++) {
    var b = buildSeg(m.segs[i].w), d = m.segs[i];
    segs.push({ len: b.len, pts: b.pts, cum: b.cum, arc: b.arc,
      j: d.j === undefined ? -1 : d.j, n: d.n === undefined ? -1 : d.n, s: d.s === undefined ? -1 : d.s });
  }
  // The intended route from each tunnel to each station it can reach, and the
  // colours each tunnel can send trains to.
  var routes = [], tcols = [];
  for (var t = 0; t < m.tunnels.length; t++) {
    var byCol = {};
    (function walk(seg, path) {
      var sg = segs[seg], p = path.concat([seg]);
      if (sg.s >= 0) { var c = m.stations[sg.s].col; if (!byCol[c]) byCol[c] = { segs: p }; return; }
      if (sg.n >= 0) { walk(sg.n, p); return; }
      var jn = m.junctions[sg.j];
      walk(jn.out[0], p); walk(jn.out[1], p);
    })(m.tunnels[t], []);
    var cs = [];
    for (var c = 0; c < 6; c++) if (byCol[c]) cs.push(c);
    routes.push(byCol); tcols.push(cs);
  }
  BUILT[key] = { mi: mi, name: m.name, segs: segs, junctions: m.junctions, stations: m.stations,
    tunnels: m.tunnels, routes: routes, tcols: tcols, crossings: crossingsOf(segs, m) };
  return BUILT[key];
}

function starts(B, route) {
  var out = [], d = 0;
  for (var i = 0; i < route.length; i++) { out.push(d); d += B.segs[route[i]].len; }
  return out;
}
function trainLen(cars) { return ENGINE_LEN + cars * (COUPLE + CAR_LEN); }
// Route distance after s steps for speed v, speeding up past b (b < 0: never).
function hOf(v, b, s) {
  var tb = b >= 0 ? cdiv(b, v) : 0;
  if (b < 0 || s <= tb) return v * s;
  var u = s - tb, k = Math.min(u, BOOST_N), g = k * (k + 1) / 2 + (u - k) * BOOST_N;
  return v * s + Math.floor(v * BOOST_PCT * g / (100 * BOOST_N));
}
// The first step offset at which the head has reached d.
function tTo(v, b, d) {
  if (b < 0 || d <= b) return cdiv(d, v);
  var lo = cdiv(b, v), hi = cdiv(d, v);
  while (lo < hi) { var m = Math.floor((lo + hi) / 2); if (hOf(v, b, m) >= d) hi = m; else lo = m + 1; }
  return lo;
}
// Where a route's station segment starts: the speed-up point.
function boostAt(B, route) { return starts(B, route)[route.length - 1]; }
function headAt(tr, step) { return hOf(tr.v, tr.b === undefined ? -1 : tr.b, step - tr.r); }

// Train k's draws: tunnel, colour, carriages, express and gap, always all five.
function trainSpec(sim, k) {
  var B = board(sim.map), s = sim.seed;
  var h0 = hash(s, k, 0), h1 = hash(s, k, 1), h2 = hash(s, k, 2), h3 = hash(s, k, 3), h4 = hash(s, k, 4);
  var lv = sim.level, nth = sim.released;
  var tun = h4 % B.tunnels.length, cs = B.tcols[tun];
  var col = cs[h0 % cs.length];
  // A colour the board adds comes first: the level's first train is the
  // newest colour, from a tunnel that can reach it.
  if (nth === 0) {
    var top = -1, t2;
    for (t2 = 0; t2 < B.tcols.length; t2++) for (var c2 = 0; c2 < B.tcols[t2].length; c2++) top = Math.max(top, B.tcols[t2][c2]);
    for (t2 = 0; t2 < B.tcols.length; t2++) {
      var ti = (tun + t2) % B.tcols.length;
      if (B.tcols[ti].indexOf(top) >= 0) { tun = ti; col = top; break; }
    }
  }
  var cars = 1 + (h1 % (lv >= CARS_FROM ? 3 : 2));
  var warm = Math.max(0, WARM_N - nth);
  var v = Math.min(V_CAP, V_BASE + lv * V_LEVEL) - Math.floor(WARM_V * warm / WARM_N);
  var express = lv >= EXPRESS_FROM && (h2 % 100) < EXPRESS_PCT;
  if (express) v = Math.floor(v * 3 / 2);
  var gap = Math.max(GAP_MIN, GAP_START - lv * GAP_LEVEL - nth * GAP_TRAIN) + (h3 % GAP_SPREAD) + WARM_GAP * warm;
  return { k: k, col: col, cars: cars, L: trainLen(cars), v: v, express: express, gap: gap, tun: tun };
}

// Is a release at step r for `n` (a planned train) clear of `f`, as both run
// their intended routes? Returns 0 when it is, or a later release that puts
// `n` safely behind `f` where they conflict.
function conflict(B, f, n, r) {
  var rf = f.iroute, rn = n.iroute, sf = starts(B, rf), sn = starts(B, rn), i, q, need = 0;
  // Segments both routes run on: the one behind keeps PLAN_MARGIN off the one
  // in front, and gets FLIP_WINDOW steps where their routes part at a switch.
  for (i = 0; i < rn.length; i++) {
    for (q = 0; q < rf.length; q++) if (rf[q] === rn[i]) break;
    if (q === rf.length) continue;
    var len = B.segs[rn[i]].len;
    var nIn = r + tTo(n.v, n.ib, sn[i]), fIn = f.r + tTo(f.v, f.ib, sf[q]);
    var nFirst = nIn < fIn;
    var A = nFirst ? { r: r, v: n.v, L: n.L, s: sn[i], b: n.ib } : { r: f.r, v: f.v, L: f.L, s: sf[q], b: f.ib };
    var K = nFirst ? { r: f.r, v: f.v, s: sf[q], b: f.ib } : { r: r, v: n.v, s: sn[i], b: n.ib };
    var nb = i + 1 < rn.length ? rn[i + 1] : -1, nf = q + 1 < rf.length ? rf[q + 1] : -1;
    var parts = B.segs[rn[i]].j >= 0 && nb !== nf;
    var bad = false;
    for (var e = 0; e < 2 && !bad; e++) {
      var x = e ? len : 0, t = K.r + tTo(K.v, K.b, K.s + x);
      if (hOf(A.v, A.b, t - A.r) - A.L < A.s + x + PLAN_MARGIN) bad = true;
    }
    if (!bad && parts) {
      var te = K.r + tTo(K.v, K.b, K.s + len) - FLIP_WINDOW;
      if (hOf(A.v, A.b, te - A.r) - A.L < A.s + len + LOCK_PAD) bad = true;
    }
    if (!bad) continue;
    // Put n behind f on this segment.
    for (var e2 = 0; e2 < 2; e2++) {
      var x2 = e2 ? len : 0, T = tTo(n.v, n.ib, sn[i] + x2);
      need = Math.max(need, f.r - T + tTo(f.v, f.ib, sf[q] + x2 + PLAN_MARGIN + f.L));
    }
    if (parts) need = Math.max(need, f.r - tTo(n.v, n.ib, sn[i] + len) + FLIP_WINDOW + tTo(f.v, f.ib, sf[q] + len + LOCK_PAD + f.L));
  }
  // Crossings and merges: the two never hold the crossing point at once.
  for (var c = 0; c < B.crossings.length; c++) {
    var X = B.crossings[c], qn = rn.indexOf(X.a), qf = rf.indexOf(X.b), pn, pf;
    if (qn >= 0 && qf >= 0) { pn = sn[qn] + X.oa; pf = sf[qf] + X.ob; }
    else {
      qn = rn.indexOf(X.b); qf = rf.indexOf(X.a);
      if (qn < 0 || qf < 0) continue;
      pn = sn[qn] + X.ob; pf = sf[qf] + X.oa;
    }
    var n0 = r + tTo(n.v, n.ib, pn - CROSS_PAD), n1 = r + tTo(n.v, n.ib, pn + CROSS_PAD + n.L);
    var f0 = f.r + tTo(f.v, f.ib, pf - CROSS_PAD), f1 = f.r + tTo(f.v, f.ib, pf + CROSS_PAD + f.L);
    if (n1 + CROSS_GAP <= f0 || f1 + CROSS_GAP <= n0) continue;
    need = Math.max(need, f1 + CROSS_GAP - tTo(n.v, n.ib, pn - CROSS_PAD));
  }
  return need > r ? need : 0;
}

// The next train's release: the base gap, then pushed later until it is clear
// of every train still on the board.
function schedule(sim) {
  if (sim.released >= PER_LEVEL) { sim.next = null; return; }
  var B = board(sim.map), sp = trainSpec(sim, sim.nextK);
  var ir = B.routes[sp.tun][sp.col].segs, n = { v: sp.v, L: sp.L, iroute: ir, ib: boostAt(B, ir) };
  var r = Math.max(sim.step + 1, sim.lastRelease + sp.gap);
  for (var tries = 0; tries < PLAN_TRIES; tries++) {
    var moved = false;
    for (var i = 0; i < sim.trains.length; i++) {
      var need = conflict(B, sim.trains[i], n, r);
      if (need) { r = need; moved = true; }
    }
    if (!moved) break;
  }
  sim.next = { k: sp.k, col: sp.col, cars: sp.cars, L: sp.L, v: sp.v, express: sp.express, tun: sp.tun, r: r };
}

function resetSwitches(mi) { var a = [], n = board(mi).junctions.length; for (var i = 0; i < n; i++) a.push(0); return a; }

function initSim(seedHex, version, level) {
  var lv = level > 0 ? level : 0;
  var sim = {
    version: version, seed: seedToInt(seedHex), step: 0, level: lv, map: mapOf(lv),
    sw: [], trains: [], next: null, nextK: 0, released: 0, levelDone: 0, lastRelease: FIRST_RELEASE - GAP_START,
    hearts: HEARTS, score: 0, combo: 0, delivered: 0, wrong: 0, flips: 0,
    dead: false, deathStep: -1, crash: null, events: []
  };
  sim.sw = resetSwitches(sim.map);
  sim.step = FIRST_RELEASE - 1;
  schedule(sim);
  sim.step = 0;
  return sim;
}

// Locked while any engine or carriage is within LOCK_PAD of the switch.
function isLocked(sim, j) {
  var B = board(sim.map), inp = B.junctions[j].inp;
  for (var i = 0; i < sim.trains.length; i++) {
    var tr = sim.trains[i], st = starts(B, tr.route), h = headAt(tr, sim.step);
    for (var q = 0; q < tr.route.length; q++) {
      if (tr.route[q] !== inp) continue;
      var P = st[q] + B.segs[inp].len;
      if (h - tr.L < P + LOCK_PAD && h > P - LOCK_PAD) return true;
    }
  }
  return false;
}

// A flip toggles switch j. False when it is refused (the client records
// nothing then): a dead run, no such switch, or a train on the switch.
function flipSim(sim, j) {
  if (sim.dead) return false;
  if (typeof j !== 'number' || j !== Math.floor(j) || j < 0 || j >= sim.sw.length) return false;
  if (isLocked(sim, j)) return false;
  var sw = sim.sw.slice(); sw[j] = 1 - sw[j]; sim.sw = sw;
  sim.flips++;
  return true;
}

// The part of a train on segment index q of its route, clipped to the segment.
function span(B, tr, st, q, h) {
  var len = B.segs[tr.route[q]].len;
  return [Math.max(0, h - tr.L - st[q]), Math.min(len, h - st[q])];
}
// Does the train cover route position seg+off, within CROSS_PAD?
function covers(B, tr, h, seg, off) {
  var q = tr.route.indexOf(seg);
  if (q < 0) return false;
  var P = starts(B, tr.route)[q] + off;
  return h - tr.L < P + CROSS_PAD && h > P - CROSS_PAD;
}

function crashAt(sim, ev, a, b, seg, at) {
  sim.dead = true; sim.deathStep = sim.step;
  sim.crash = { a: a, b: b, seg: seg, at: at };
  ev.push({ t: 'crash', a: a, b: b, seg: seg, at: at });
}

function stepSim(sim) {
  var ev = [];
  sim.events = ev;
  if (sim.dead) return;
  sim.step++;
  var B = board(sim.map), i, q;
  // A level change waits for the board to clear, then swaps the map.
  if (sim.levelDone >= PER_LEVEL && sim.trains.length === 0 && sim.next === null) {
    sim.level++; sim.map = mapOf(sim.level); B = board(sim.map);
    sim.sw = resetSwitches(sim.map); sim.released = 0; sim.levelDone = 0;
    sim.lastRelease = sim.step + LEVEL_PAUSE - GAP_START;
    var keep = sim.step; sim.step = sim.step + LEVEL_PAUSE - 1; schedule(sim); sim.step = keep;
    ev.push({ t: 'level', level: sim.level, map: sim.map });
  }
  if (sim.next && sim.step >= sim.next.r) {
    var n = sim.next;
    var tr = { k: n.k, col: n.col, cars: n.cars, L: n.L, v: n.v, express: n.express, r: sim.step,
      route: [B.tunnels[n.tun]], iroute: B.routes[n.tun][n.col].segs, scored: false };
    tr.ib = boostAt(B, tr.iroute);
    sim.trains = sim.trains.concat([tr]);
    sim.released++; sim.nextK++; sim.lastRelease = sim.step;
    ev.push({ t: 'spawn', k: tr.k, col: tr.col, tun: n.tun });
    schedule(sim);
  }
  // Move: extend each route as its engine runs off a segment; deliver at a station.
  var moved = [];
  for (i = 0; i < sim.trains.length; i++) {
    var t0 = sim.trains[i], h = headAt(t0, sim.step), route = t0.route, st = starts(B, route);
    var last = route.length - 1, end = st[last] + B.segs[route[last]].len, bst;
    while (h >= end && B.segs[route[last]].s < 0) {
      var sg = B.segs[route[last]];
      route = route.concat([sg.n >= 0 ? sg.n : B.junctions[sg.j].out[sim.sw[sg.j]]]);
      if (B.segs[route[last + 1]].s >= 0) bst = end;
      last++; end += B.segs[route[last]].len;
    }
    var t1 = { k: t0.k, col: t0.col, cars: t0.cars, L: t0.L, v: t0.v, express: t0.express, r: t0.r,
      route: route, iroute: t0.iroute, ib: t0.ib, scored: t0.scored };
    if (bst !== undefined) t1.b = bst; else if (t0.b !== undefined) t1.b = t0.b;
    var sseg = B.segs[route[last]];
    if (sseg.s >= 0 && h >= end && !t1.scored) {
      t1.scored = true;
      var stn = B.stations[sseg.s], ok = stn.col === t1.col;
      sim.levelDone++;
      if (ok) {
        sim.combo++; sim.delivered++;
        var pts = DELIVER_PTS + COMBO_PTS * Math.min(sim.combo - 1, COMBO_CAP);
        sim.score += pts;
        ev.push({ t: 'deliver', k: t1.k, ok: true, pts: pts, st: sseg.s, combo: sim.combo });
      } else {
        sim.combo = 0; sim.wrong++; sim.hearts--;
        ev.push({ t: 'deliver', k: t1.k, ok: false, pts: 0, st: sseg.s, combo: 0 });
      }
    }
    if (sseg.s >= 0 && h - t1.L >= end) { ev.push({ t: 'gone', k: t1.k }); continue; }
    moved.push(t1);
  }
  sim.trains = moved;
  // Collisions: two trains on one segment closer than HIT_GAP, or both on a
  // crossing (or the meeting point of a merge) at once.
  for (i = 0; i < moved.length; i++) {
    var a = moved[i], sa = starts(B, a.route), ha = headAt(a, sim.step);
    for (var b = i + 1; b < moved.length; b++) {
      var c = moved[b], sc = starts(B, c.route), hc = headAt(c, sim.step);
      for (q = 0; q < a.route.length; q++) {
        var qc = c.route.indexOf(a.route[q]);
        if (qc < 0) continue;
        var x = span(B, a, sa, q, ha), y = span(B, c, sc, qc, hc);
        if (x[1] <= x[0] || y[1] <= y[0]) continue;
        if (x[0] < y[1] + HIT_GAP && y[0] < x[1] + HIT_GAP) { crashAt(sim, ev, a.k, c.k, a.route[q], Math.max(x[0], y[0])); return; }
      }
      for (q = 0; q < B.crossings.length; q++) {
        var X = B.crossings[q];
        if ((covers(B, a, ha, X.a, X.oa) && covers(B, c, hc, X.b, X.ob)) ||
            (covers(B, a, ha, X.b, X.ob) && covers(B, c, hc, X.a, X.oa))) { crashAt(sim, ev, a.k, c.k, X.a, X.oa); return; }
      }
    }
  }
  if (sim.hearts <= 0) { sim.dead = true; sim.deathStep = sim.step; ev.push({ t: 'out' }); }
}
// RAIL JUNCTION RULES END

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound far above any real run. It REFUSES further inputs, it never zeroes.
const MAX_INPUTS = 20000;
// Steps ahead a train counts as "coming" to a switch for the fingerprint.
const ARRIVE_LOOK = 900;

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { steps: [], arrivals: [], noTrain: 0, needless: 0, open: {} },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. At every flip: the steps until the next train
// reaches that switch (a planner flips on the last safe step, evenly; a hand
// early or late), and flips undone before any train used them.
function arrivalSteps(sim, j) {
  const B = board(sim.map), inp = B.junctions[j].inp;
  let best = null;
  for (const tr of sim.trains) {
    const ir = tr.iroute, q = ir.indexOf(inp);
    if (q < 0) continue;
    let P = 0;
    for (let i = 0; i <= q; i++) P += B.segs[ir[i]].len;
    const h = headAt(tr, sim.step);
    if (h >= P) continue;
    const s = Math.ceil((P - h) / tr.v);
    if (s <= ARRIVE_LOOK && (best === null || s < best)) best = s;
  }
  return best;
}
function notePassages(state) {
  const sim = state.sim, B = board(sim.map);
  for (const tr of sim.trains) {
    const h = headAt(tr, sim.step), st = starts(B, tr.route);
    for (let q = 0; q < tr.route.length; q++) {
      const sg = B.segs[tr.route[q]];
      if (sg.j < 0 || sg.j === undefined) continue;
      const P = st[q] + sg.len;
      if (P <= h && P > h - tr.v) delete state.stats.open[sg.j];
    }
  }
}
function stepOnce(state) {
  const sim = state.sim, map = sim.map;
  stepSim(sim);
  if (sim.map !== map) state.stats.open = {};
  notePassages(state);
}
function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.step < step && sim.step < MAX_SIM_STEPS) stepOnce(state);
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
      state.sim = initSim(state.seed, RULES_VERSION, 0);
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'flip') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, junction, step } = payload;
  if (!isStep(n) || !isStep(junction) || !isStep(step)) return reject(state, 'bad_flip');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would re-run a window and keep the
  // best outcome.
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  // The flip names its index in the run; any other index is out of order.
  if (n !== sim.flips) return reject(state, 'out_of_order');
  const arr = junction < sim.sw.length ? arrivalSteps(sim, junction) : null;
  if (!flipSim(sim, junction)) return reject(state, 'refused');
  const st = state.stats;
  st.steps.push(sim.step);
  if (arr === null) st.noTrain++; else st.arrivals.push(arr);
  if (st.open[junction]) st.needless++;
  st.open[junction] = true;
  state.score = sim.score;
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
  if (state.mode !== 'sim' || !state.sim) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const sim = state.sim;
  // Run the world out past the last input: trains in flight arrive, and a
  // board left alone loses its hearts to wrong stations.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {
    stepOnce(state);
    guard++;
  }
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, deathStep: sim.deathStep, crash: sim.crash,
      score: sim.score, dead: sim.dead, level: sim.level, delivered: sim.delivered, wrong: sim.wrong,
      inputs: state.inputCount, rejects: state.rejectCount, flips: st.steps.length,
      arriveMean: round3(mean(st.arrivals)), arriveSd: round3(sd(st.arrivals)),
      arriveMin: st.arrivals.length ? Math.min(...st.arrivals) : null,
      noTrainFlips: st.noTrain, needlessFlips: st.needless,
      gapCv: round3(gapCv(st.steps)),
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
    RULES_VERSION, initSim, stepSim, flipSim, isLocked, board, mapOf, starts, headAt, trainSpec, hash, seedToInt,
    MAX_INPUTS, MAX_SIM_STEPS, SUB, HEARTS, PER_LEVEL, DELIVER_PTS, COMBO_PTS, COMBO_CAP, LOCK_PAD, HIT_GAP,
    CROSS_PAD, FIRST_RELEASE, LEVEL_PAUSE, V_BASE, V_LEVEL, V_CAP, GAP_START, GAP_MIN, MAPS,
  },
};
