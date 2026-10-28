'use strict';

/**
 * Mini Golf validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a 3 minute round of endless mini golf holes. Drag back and let go
 * to putt. Hole K (its shape, obstacles, gems and par) is a pure function of
 * (seed, K). A hole scores by strokes against par, times a streak multiplier;
 * a gem rolled over scores GEM_PTS.
 *
 * What the server does with a trace:
 *   1. rebuilds every hole from the session seed;
 *   2. applies each putt { n, dx, dy, step } before step `step`, exactly as the
 *      client does (a putt the rules refuse is refused here too);
 *   3. runs the same fixed 1/60 s steps to the end of the clock.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/mini-golf/js/rules.js.
 * shared/tests/miniGolfParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump, never an edit
 * in place.
 */

  // ==== MINI GOLF RULES BEGIN (word for word in games/mini-golf/js/rules.js and shared/anticheat/validators/miniGolf.js) ====
  // Integers only: +, -, *, /, Math.trunc, Math.floor, Math.sqrt (corrected
  // to an exact isqrt), bit operations and comparisons. No trig, no clock, no
  // screen, no Math.random. Positions and speeds are in 1/256 design units
  // (speeds per 1/60 s step). The ball is a circle. A hole is a grid of 40
  // unit cells: floor cells are felt, every other cell is solid wall.
  // Obstacles inside the floor are boxes, round bumpers, sand, water, slopes
  // and sliding blocks whose offset is a closed-form triangle wave of the step.
  var SU = 256;
  var CELL = 40, GW = 8, GH = 14;   // a hole fits in 320 x 560 design units
  var BR = 6 * SU;              // ball radius
  var CUP_R = 11 * SU;          // over the cup: the ball curls toward its centre
  var CAP_R = 8 * SU;           // a ball centre this close to the cup centre drops...
  var CAP_V = 5 * SU;           // ...when slower than this per step; faster, it lips out
  var CURL = 22;                // over the cup, out of 256 of the offset per step
  var VMAX = 12 * SU;           // the hardest putt, per step
  var SUB = 4;                  // substeps: at most 2.5 design units of travel each
  var PULL_MIN = 8, PULL_MAX = 110, PULL_LIM = 1000;   // design units of pull
  var DEC = 22, DEC_SAND = 130; // rolling loss, sub units per step (a steady stop)
  var E_WALL = 140, E_BUMP = 230;   // restitution, out of 256
  var IDLE_STEPS = 1200;        // 20 s at rest without a putt forfeits the hole
  var ROLL_MAX = 900;           // a roll is stopped after 15 s whatever it is doing
  var TRANS_STEPS = 84;         // the next hole comes in; putts are refused meanwhile
  var RUN_STEPS = 10800;        // 3 minutes
  var MAX_STROKES = 8;          // at rest after this many strokes, the hole is forfeited
  var FORFEIT_OVER = 2;         // a forfeited hole counts as par + 2
  var PTS_HIO = 50, PTS_BIRDIE = 30, PTS_PAR = 20, PTS_BOGEY = 10, PTS_WORSE = 5;
  var STREAK_CAP = 4;           // par or better in a row: x1, x1.5, x2, x2.5, x3
  var MAX_PUTTS = 2000;         // a work bound: a putt needs the ball at rest
  var GEM_PTS = 10;             // a gem on the course, picked up by rolling over it
  var GEM_R = 7 * SU;
  var JUMP_V = 5 * SU;          // a jump pad launches a ball at least this fast...
  var JUMP_STEPS = 34;          // ...for this long: no water, sand or slope underneath
  var WARP_R = 10 * SU;         // a tunnel mouth
  var RULES_VERSION = 2;
  function hash32(a, b, c) {
    var h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul(b | 0, 0x85EBCA6B) ^ Math.imul(c | 0, 0xC2B2AE35)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846CA68B) >>> 0; h ^= h >>> 16;
    return h >>> 0;
  }
  function seedToInt(seedHex) {
    return (typeof seedHex === 'string' && /^[0-9a-fA-F]{8}/.test(seedHex)) ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
  }
  function isqrt(v) {
    var s = Math.floor(Math.sqrt(v));
    while (s * s > v) s--;
    while ((s + 1) * (s + 1) <= v) s++;
    return s;
  }
  function tierOf(k) { return k < 2 ? 0 : (k < 5 ? 1 : (k < 9 ? 2 : 3)); }
  // ---- hole K, a pure function of (seed, K): 16 draws on every index ----
  // Shapes, in cells [col0, row0, cols, rows]. The tee is at the bottom of the
  // first box, the cup at the far end of the last.
  //   0 straight   1 dog-leg   2 zig-zag   3 hook (comes back down)   4 room
  function shapeOf(fam, d) {
    if (fam === 0) { var w = 3 + d[0] % 2; return [[Math.trunc((GW - w) / 2), 1 + d[1] % 2, w, 13 - d[1] % 2]]; }
    if (fam === 1) { var hb = 3 + d[0] % 2; return [[0, hb, 3, GH - hb], [0, 0, GW, hb]]; }
    if (fam === 2) return [[0, 9, 3, 5], [0, 5, GW, 4], [GW - 3, 0, 3, 5]];
    if (fam === 3) return [[0, 3, 3, 11], [0, 0, GW, 3], [GW - 3, 3, 3, 4 + d[1] % 3]];
    if (fam === 6) return [[2, 0, 4, GH]];
    if (fam === 9) return [[0, 10, 3, 4], [0, 7, GW, 3], [GW - 3, 4, 3, 3], [0, 1, GW, 3]];
    return [[1, 0, 6, GH]];                    // room, bowl, funnel, slalom
  }
  //   5 bowl (round, an island)   6 windmill   7 funnel   8 slalom
  //   9 s-curve   10 loop-around   11 split path   12 ramp jump
  //   13 moving bridge   14 pinball room   15 tunnel   16 spiral
  function famOf(tier, h) {
    if (tier === 0) return [0, 1, 5, 14][h % 4];
    if (tier === 1) return [0, 1, 2, 4, 5, 6, 7, 9, 10, 14, 15][h % 11];
    return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16][h % 17];
  }
  // A quarter sine wave in 257 steps, scaled to 4096: angles are integers out
  // of 1024 a turn, so a windmill turns without trig.
  var SIN_Q = [0,25,50,75,101,126,151,176,201,226,251,276,301,326,351,376,401,426,451,476,501,526,551,576,601,626,651,675,700,725,750,774,799,824,848,873,897,922,946,971,995,1020,1044,1068,1092,1117,1141,1165,1189,1213,1237,1261,1285,1309,1332,1356,1380,1404,1427,1451,1474,1498,1521,1544,1567,1591,1614,1637,1660,1683,1706,1729,1751,1774,1797,1819,1842,1864,1886,1909,1931,1953,1975,1997,2019,2041,2062,2084,2106,2127,2149,2170,2191,2213,2234,2255,2276,2296,2317,2338,2359,2379,2399,2420,2440,2460,2480,2500,2520,2540,2559,2579,2598,2618,2637,2656,2675,2694,2713,2732,2751,2769,2788,2806,2824,2843,2861,2878,2896,2914,2932,2949,2967,2984,3001,3018,3035,3052,3068,3085,3102,3118,3134,3150,3166,3182,3198,3214,3229,3244,3260,3275,3290,3305,3320,3334,3349,3363,3378,3392,3406,3420,3433,3447,3461,3474,3487,3500,3513,3526,3539,3551,3564,3576,3588,3600,3612,3624,3636,3647,3659,3670,3681,3692,3703,3713,3724,3734,3745,3755,3765,3775,3784,3794,3803,3812,3822,3831,3839,3848,3857,3865,3873,3881,3889,3897,3905,3912,3920,3927,3934,3941,3948,3954,3961,3967,3973,3979,3985,3991,3996,4002,4007,4012,4017,4022,4027,4031,4036,4040,4044,4048,4052,4055,4059,4062,4065,4068,4071,4074,4076,4079,4081,4083,4085,4087,4088,4090,4091,4092,4093,4094,4095,4095,4096,4096,4096];
  function sinI(i) { i = i & 1023; return i < 256 ? SIN_Q[i] : (i < 512 ? SIN_Q[512 - i] : (i < 768 ? -SIN_Q[i - 512] : -SIN_Q[1024 - i])); }
  function cosI(i) { return sinI(i + 256); }
  var LCACHE = {}, LCOUNT = 0;
  function layoutOf(seedInt, k) {
    var key = seedInt + ':' + k;
    if (LCACHE[key]) return LCACHE[key];
    if (++LCOUNT > 400) { LCACHE = {}; LCOUNT = 1; }   // a server replays many seeds
    var d = [], j, i, r, c;
    for (j = 0; j < 16; j++) d.push(hash32(seedInt, k, 101 + j));
    var tier = tierOf(k), fam = famOf(tier, d[0]), mir = d[1] & 1;
    var boxes = shapeOf(fam, [d[2], d[3]]);
    var grid = [];
    for (r = 0; r < GH; r++) { var row = []; for (c = 0; c < GW; c++) row.push(0); grid.push(row); }
    for (i = 0; i < boxes.length; i++) for (r = boxes[i][1]; r < boxes[i][1] + boxes[i][3]; r++) for (c = boxes[i][0]; c < boxes[i][0] + boxes[i][2]; c++) grid[r][mir ? GW - 1 - c : c] = 1;
    function bx(b, col, w) { return mir ? (GW - col - w) * CELL : col * CELL; }
    var first = boxes[0], last = boxes[boxes.length - 1];
    // tee: bottom of the first box; cup: the far end of the last (the bottom
    // for a hook, which comes back down)
    var teeX = bx(first, first[0], first[2]) + Math.trunc(first[2] * CELL / 2) + (d[4] % 3 - 1) * 10;
    var teeY = (first[1] + first[3]) * CELL - 28;
    var cupX = bx(last, last[0], last[2]) + Math.trunc(last[2] * CELL / 2) + (d[5] % 3 - 1) * 12;
    var cupY = fam === 3 ? (last[1] + last[3]) * CELL - 30 : last[1] * CELL + 30 + (d[6] % 2) * 10;
    var L = { k: k, tier: tier, fam: fam, mir: mir, grid: grid, boxes: [], pillars: [], sand: [], water: [], ramps: [], movers: [],
      tee: [teeX * SU, teeY * SU], cup: [cupX * SU, cupY * SU], par: 2, solids: [], rails: [], mills: [], corners: [], bridges: [], portals: [], gems: [] };
    function X(x) { return mir ? GW * CELL - x : x; }
    // obstacles: in the long box (the first, or the room), away from tee and cup
    var hz = 0, want = fam === 5 ? 80 : [20, 40, 40][d[12] % 3];
    var mb = boxes[0];
    var mx0 = bx(mb, mb[0], mb[2]), mw = mb[2] * CELL, my0 = mb[1] * CELL, mh = mb[3] * CELL;
    var midY = my0 + Math.trunc(mh / 2);
    if (tier >= 1 && fam < 5) {
      var kind = d[7] % (tier >= 2 ? 6 : 3);
      if (kind === 0) {   // a block across the middle, gaps both sides
        var bw = mw >= 160 ? 60 : 40;
        L.boxes.push([mx0 + Math.trunc((mw - bw) / 2) + (d[8] % 3 - 1) * 10, midY - 10, bw, 20]);
      } else if (kind === 1) {   // round bumpers
        var n = mw >= 160 ? 3 : 2;
        for (i = 0; i < n; i++) L.pillars.push([mx0 + Math.trunc(mw * (i + 1) / (n + 1)), midY + ((i + (d[8] & 1)) % 2) * 50 - 25, 13]);
      } else if (kind === 2) {   // sand across part of the way
        var sw = Math.trunc(mw * 2 / 3), sl = d[8] & 1;
        L.sand.push([sl ? mx0 + mw - sw : mx0, midY - 30, sw, 60]);
      } else if (kind === 3) {   // water on the line to the cup, a dry lane each side
        var lane = (mw - 80) / 2 > 32 ? Math.trunc((mw - 80) / 2) : 32;
        L.water.push([mx0 + lane, midY - 35, mw - 2 * lane, 70]); hz++;
      } else if (kind === 4) {   // a sliding gate across the way
        var gw = Math.trunc(mw / 2), rg = mw - gw - 32;
        L.movers.push({ x0: (mx0 + 16) * SU, y0: (midY - 8) * SU, x1: (mx0 + 16 + gw) * SU, y1: (midY + 8) * SU, ax: 0, r: rg * SU, p: 70 + d[8] % 40, ph: d[9] % 200 });
        hz++;
      } else {   // a slope: downhill toward the cup, or uphill against you
        var dn = d[8] & 1;
        L.ramps.push([mx0, midY - 30, mw, 60, 0, dn ? -8 : 7]);
        if (!dn) hz++;
      }
      if (tier >= 3 && fam !== 4 && boxes.length > 1) {   // a second obstacle in the cross box
        var cb = boxes[1], cx0 = bx(cb, cb[0], cb[2]), cw = cb[2] * CELL, cy0 = cb[1] * CELL, ch = cb[3] * CELL;
        if (d[10] & 1) L.pillars.push([cx0 + Math.trunc(cw / 2) + (d[11] % 3 - 1) * 20, cy0 + Math.trunc(ch / 2), 13]);
        else L.sand.push([cx0 + Math.trunc(cw / 3), cy0 + 8, Math.trunc(cw / 3), ch - 16]);
      }
    }
    // the set pieces
    if (fam === 5) L.pillars.push([mx0 + Math.trunc(mw / 2) + (d[8] % 3 - 1) * 16, midY + (d[9] % 3 - 1) * 30, 30, 1]);
    if (fam === 6) L.mills.push({ cx: (mx0 + Math.trunc(mw / 2)) * SU, cy: (midY + (d[8] % 3 - 1) * 40) * SU, la: 72 * SU, r: 5 * SU, p: 150 + d[9] % 70, ph: d[10] % 1024, dir: (d[11] & 1) ? 1 : -1 });
    if (fam === 7) {
      var fy = midY + (d[8] % 3 - 1) * 30, fg = 24 + (d[9] % 2) * 6;
      L.rails.push([mx0 + 6, fy + 80, mx0 + Math.trunc(mw / 2) - fg, fy, 5]);
      L.rails.push([mx0 + mw - 6, fy + 80, mx0 + Math.trunc(mw / 2) + fg, fy, 5]);
    }
    if (fam === 8) {
      for (i = 0; i < 3; i++) {
        var ry = 150 + i * 115 + (d[8 + i] % 3 - 1) * 10, left = ((i + d[11]) & 1) === 0, reach = 140 + d[9] % 20;
        if (left) L.rails.push([X(mx0 + 6), ry - 22, X(mx0 + reach), ry + 22, 5]);
        else L.rails.push([X(mx0 + mw - 6), ry - 22, X(mx0 + mw - reach), ry + 22, 5]);
      }
    }
    var mc = mx0 + Math.trunc(mw / 2), side = d[13] & 1;
    if (fam === 10) {   // the cup hides behind a wall: go round it
      L.boxes.push([mx0 + 34, 96, mw - 68, 14]);
      L.pillars.push([mc, 180 + (d[8] % 3 - 1) * 20, 13]);
    }
    if (fam === 11) {   // two ways up: short past the water, or long through sand
      var hw2 = Math.trunc(mw / 2);
      L.boxes.push([mc - 7, 120, 14, 330]);
      var wl = side ? mx0 : mc + 7, sl2 = side ? mc + 7 : mx0;
      L.water.push([side ? wl + 26 : wl, 200, hw2 - 7 - 26, 140]); hz++;
      L.sand.push([sl2 + 10, 240, hw2 - 27, 70]);
    }
    if (fam === 12) {   // a channel of water, a jump pad in front of it
      L.water.push([mx0, 230, mw, 64]); hz++;
      L.ramps.push([mc - 44 + (d[8] % 3 - 1) * 30, 310, 88, 44, 0, -7, 1]);
    }
    if (fam === 13) {   // a channel, a bridge sliding across it
      L.water.push([mx0, 240, mw, 60]); hz++;
      L.bridges.push({ x0: mx0 * SU, y0: 236 * SU, x1: (mx0 + 64) * SU, y1: 304 * SU, ax: 0, r: (mw - 64) * SU, p: 120 + d[8] % 50, ph: d[9] % 240 });
    }
    if (fam === 14) {   // pinball: a room of bumpers
      var pb = [[-60, 170], [60, 170], [0, 250], [-60, 330], [60, 330], [0, 410]];
      for (i = 0; i < pb.length; i++) L.pillars.push([mc + pb[i][0] + (d[8 + (i % 4)] % 3 - 1) * 8, pb[i][1], 13]);
    }
    if (fam === 15) {   // a wall right across; a tunnel goes under it
      L.boxes.push([mx0, 262, mw, 16]);
      var ex = side ? mx0 + 46 : mx0 + mw - 46;
      L.portals.push([mx0 + mw - (ex - mx0), 360, ex, 210]);
    }
    if (fam === 16) {   // a spiral: the cup in the middle, walled in, one way in
      var scx = mc, scy = 250;
      L.boxes.push([scx - 70, scy - 70, 140, 12], [scx - 70, scy - 70, 12, 140], [scx - 70, scy + 58, 140, 12], [scx + 58, scy - 24, 12, 82]);
      L.cup = [scx * SU, scy * SU];
    }
    if (fam === 9) want = 40;
    // round the outer corners of the floor: small, medium, or a big bowl
    function fl(r2, c2) { return r2 >= 0 && r2 < GH && c2 >= 0 && c2 < GW && grid[r2][c2] === 1; }
    for (r = 0; r < GH; r++) for (c = 0; c < GW; c++) if (grid[r][c]) {
      for (var qd = 0; qd < 4; qd++) {
        var sx = (qd & 1) ? 1 : -1, sy = (qd & 2) ? 1 : -1;
        if (fl(r, c + sx) || fl(r + sy, c)) continue;
        var rc = want;
        if (rc > 40 && !(fl(r, c - sx) && fl(r - sy, c) && fl(r - sy, c - sx))) rc = 40;
        var px = c * CELL + (sx > 0 ? CELL : 0), py = r * CELL + (sy > 0 ? CELL : 0);
        L.corners.push([(px - sx * rc) * SU, (py - sy * rc) * SU, rc * SU, sx, sy]);
      }
    }
    // gems: two or three on floor that is clear of everything else
    function clear(x, y) {
      var cc = Math.floor(x / CELL), rr2 = Math.floor(y / CELL), q2, ii;
      if (!fl(rr2, cc) || !fl(Math.floor((y - 14) / CELL), cc) || !fl(Math.floor((y + 14) / CELL), cc) || !fl(rr2, Math.floor((x - 14) / CELL)) || !fl(rr2, Math.floor((x + 14) / CELL))) return false;
      function far(px, py, dd) { return (x - px) * (x - px) + (y - py) * (y - py) >= dd * dd; }
      if (!far(L.tee[0] / SU, L.tee[1] / SU, 44) || !far(L.cup[0] / SU, L.cup[1] / SU, 40)) return false;
      for (ii = 0; ii < L.corners.length; ii++) { q2 = L.corners[ii]; var qx = x * SU - q2[0], qy = y * SU - q2[1]; if (qx * q2[3] > 0 && qy * q2[4] > 0 && qx * qx + qy * qy > (q2[2] - 16 * SU) * (q2[2] - 16 * SU)) return false; }
      var all = L.boxes.concat(L.water).concat(L.ramps);
      for (ii = 0; ii < all.length; ii++) { q2 = all[ii]; if (x > q2[0] - 14 && x < q2[0] + q2[2] + 14 && y > q2[1] - 14 && y < q2[1] + q2[3] + 14) return false; }
      for (ii = 0; ii < L.pillars.length; ii++) if (!far(L.pillars[ii][0], L.pillars[ii][1], L.pillars[ii][2] + 16)) return false;
      for (ii = 0; ii < L.mills.length; ii++) if (!far(L.mills[ii].cx / SU, L.mills[ii].cy / SU, 84)) return false;
      for (ii = 0; ii < L.portals.length; ii++) if (!far(L.portals[ii][0], L.portals[ii][1], 30) || !far(L.portals[ii][2], L.portals[ii][3], 30)) return false;
      for (ii = 0; ii < L.rails.length; ii++) { q2 = L.rails[ii]; var ddx = q2[2] - q2[0], ddy = q2[3] - q2[1], l2 = ddx * ddx + ddy * ddy, tt = ((x - q2[0]) * ddx + (y - q2[1]) * ddy) / l2; tt = tt < 0 ? 0 : (tt > 1 ? 1 : tt); if (!far(q2[0] + ddx * tt, q2[1] + ddy * tt, 18)) return false; }
      for (ii = 0; ii < L.movers.length; ii++) { var mm = L.movers[ii]; if (y > mm.y0 / SU - 18 && y < mm.y1 / SU + 18) return false; }
      for (ii = 0; ii < L.gems.length; ii++) if (!far(L.gems[ii][0], L.gems[ii][1], 50)) return false;
      return true;
    }
    var ng = tier >= 2 ? 3 : 2;
    for (j = 0; j < 40 && L.gems.length < ng; j++) {
      var gh = hash32(seedInt, k, 301 + j), gx = 16 + gh % (GW * CELL - 32), gy = 16 + (gh >>> 12) % (GH * CELL - 32);
      if (clear(gx, gy)) L.gems.push([gx, gy]);
    }
    L.par = (fam === 0 || fam === 4 || fam === 5 || fam === 14 || fam === 15 ? 2 : 3) + (hz > 0 ? 1 : 0) + (fam === 3 ? 1 : 0);
    if (L.par > 5) L.par = 5;
    // solid cells as boxes, merged along rows (sub units). The ring of cells
    // around the grid is solid too.
    for (r = -1; r <= GH; r++) {
      var run = -2;
      for (c = -1; c <= GW + 1; c++) {
        var solid = c <= GW && (r < 0 || r >= GH || c < 0 || c >= GW || !grid[r][c]);
        if (solid && run === -2) run = c;
        if (!solid && run !== -2) { L.solids.push([run * CELL * SU, r * CELL * SU, c * CELL * SU, (r + 1) * CELL * SU]); run = -2; }
      }
    }
    for (i = 0; i < L.boxes.length; i++) { var q = L.boxes[i]; L.solids.push([q[0] * SU, q[1] * SU, (q[0] + q[2]) * SU, (q[1] + q[3]) * SU]); }
    L.sandS = L.sand.map(function (q) { return [q[0] * SU, q[1] * SU, (q[0] + q[2]) * SU, (q[1] + q[3]) * SU]; });
    L.waterS = L.water.map(function (q) { return [q[0] * SU, q[1] * SU, (q[0] + q[2]) * SU, (q[1] + q[3]) * SU]; });
    L.rampsS = L.ramps.map(function (q) { return [q[0] * SU, q[1] * SU, (q[0] + q[2]) * SU, (q[1] + q[3]) * SU, q[4], q[5], q[6] || 0]; });
    L.portalsS = L.portals.map(function (q) { return [q[0] * SU, q[1] * SU, q[2] * SU, q[3] * SU]; });
    L.gemsS = L.gems.map(function (q) { return [q[0] * SU, q[1] * SU]; });
    L.pillarsS = L.pillars.map(function (q) { return [q[0] * SU, q[1] * SU, q[2] * SU, q[3] || 0]; });
    L.railsS = L.rails.map(function (q) { return [q[0] * SU, q[1] * SU, q[2] * SU, q[3] * SU, q[4] * SU]; });
    LCACHE[key] = L;
    return L;
  }
  function moverOff(m, t) {
    var q = (t + m.ph) % (2 * m.p), o = q < m.p ? q : 2 * m.p - q;
    return Math.trunc(m.r * o / m.p);
  }
  function moverRect(m, t) {
    var d = moverOff(m, t);
    return m.ax === 0 ? [m.x0 + d, m.y0, m.x1 + d, m.y1] : [m.x0, m.y0 + d, m.x1, m.y1 + d];
  }
  function inBox(r, x, y) { return x >= r[0] && x < r[2] && y >= r[1] && y < r[3]; }
  // in water, and not on a bridge over it
  function wetAt(L, x, y, t) {
    var i, w = 0;
    for (i = 0; i < L.waterS.length; i++) if (inBox(L.waterS[i], x, y)) w = 1;
    if (!w) return 0;
    for (i = 0; i < L.bridges.length; i++) if (inBox(moverRect(L.bridges[i], t), x, y)) return 0;
    return 1;
  }
  function splash(sim, ev) {
    ev.push({ k: 'water', x: sim.x, y: sim.y });
    sim.x = sim.rx; sim.y = sim.ry; sim.vx = 0; sim.vy = 0; sim.moving = 0; sim.idle = 0; sim.inLip = 0; sim.air = 0;
    sim.strokes = sim.strokes + 1;
  }
  function initSim(seedInt, version) {
    var sim = { seed: seedInt >>> 0, v: version === 2 ? 2 : RULES_VERSION, step: 0, n: 0, hole: 0, strokes: 0, idle: 0,
      roll: 0, trans: 0, x: 0, y: 0, vx: 0, vy: 0, moving: 0, rx: 0, ry: 0, inLip: 0, score: 0, sunk: 0, hio: 0, streak: 0, gm: 0, gems: 0, air: 0,
      dead: false, endReason: '', ev: [] };
    loadHole(sim, 0);
    return sim;
  }
  function loadHole(sim, k) {
    var L = layoutOf(sim.seed, k);
    sim.hole = k; sim.strokes = 0; sim.idle = 0; sim.roll = 0;
    sim.x = L.tee[0]; sim.y = L.tee[1]; sim.vx = 0; sim.vy = 0; sim.moving = 0; sim.inLip = 0; sim.gm = 0; sim.air = 0;
    sim.rx = sim.x; sim.ry = sim.y;
  }
  // The speed of a putt grows with the square root of the pull, so how far
  // it rolls grows in step with how far you pull.
  function puttSpeed(pc) { return isqrt(Math.trunc(pc * VMAX * VMAX / PULL_MAX)); }
  // Putt n with pull (dx, dy) in design units before step `step`. The ball
  // goes the other way. A refusal changes nothing.
  function puttSim(sim, dx, dy, step) {
    if (sim.dead) return 'dead';
    if (typeof dx !== 'number' || typeof dy !== 'number' || dx !== Math.floor(dx) || dy !== Math.floor(dy)) return 'bad_pull';
    if (dx < -PULL_LIM || dx > PULL_LIM || dy < -PULL_LIM || dy > PULL_LIM) return 'bad_pull';
    if (step !== sim.step) return step < sim.step ? 'frame_regressed' : 'not_yet';
    if (step >= RUN_STEPS) return 'time_up';
    if (sim.n >= MAX_PUTTS) return 'putt_cap';
    if (sim.trans > 0) return 'busy';
    if (sim.moving) return 'moving';
    var len = isqrt(dx * dx + dy * dy);
    if (len < PULL_MIN) return 'too_short';
    var pc = len > PULL_MAX ? PULL_MAX : len, sp = puttSpeed(pc);
    sim.vx = -Math.trunc(dx * sp / len);
    sim.vy = -Math.trunc(dy * sp / len);
    sim.moving = 1; sim.roll = 0; sim.idle = 0;
    sim.rx = sim.x; sim.ry = sim.y;
    sim.strokes = sim.strokes + 1;
    sim.n = sim.n + 1;
    sim.ev = sim.ev.concat([{ k: 'putt', p: pc }]);
    return 'ok';
  }
  // The ball against one box [x0,y0,x1,y1] moving at (mvx, mvy): pushed out,
  // the approach reflected. Returns the approach speed (0 when not touching).
  function hitBox(b, r, mvx, mvy) {
    var cx = b.x < r[0] ? r[0] : (b.x > r[2] ? r[2] : b.x);
    var cy = b.y < r[1] ? r[1] : (b.y > r[3] ? r[3] : b.y);
    var dx = b.x - cx, dy = b.y - cy, d2 = dx * dx + dy * dy, d;
    if (d2 >= BR * BR) return 0;
    if (d2 === 0) {
      var l = b.x - r[0], rt = r[2] - b.x, t = b.y - r[1], bo = r[3] - b.y;
      var mn = l < rt ? l : rt; if (t < mn) mn = t; if (bo < mn) mn = bo;
      if (mn === l) { dx = -1; dy = 0; b.x = r[0] - BR; }
      else if (mn === rt) { dx = 1; dy = 0; b.x = r[2] + BR; }
      else if (mn === t) { dx = 0; dy = -1; b.y = r[1] - BR; }
      else { dx = 0; dy = 1; b.y = r[3] + BR; }
      d = 1;
    } else {
      d = isqrt(d2); if (d === 0) d = 1;
      var push = BR - d;
      b.x = b.x + Math.trunc(dx * push / d); b.y = b.y + Math.trunc(dy * push / d);
    }
    return reflect(b, dx, dy, d, mvx, mvy, E_WALL);
  }
  // a rounded corner: the floor inside the quarter circle, solid outside it
  function hitCorner(b, q) {
    var dx = b.x - q[0], dy = b.y - q[1];
    if (dx * q[3] <= 0 || dy * q[4] <= 0) return 0;
    var lim = q[2] - BR, d2 = dx * dx + dy * dy;
    if (d2 <= lim * lim) return 0;
    var d = isqrt(d2);
    b.x = q[0] + Math.trunc(dx * lim / d); b.y = q[1] + Math.trunc(dy * lim / d);
    return reflect(b, -dx, -dy, d, 0, 0, E_WALL);
  }
  // a rail: a segment with a radius. A windmill arm passes its centre and
  // spin, so the ball takes the arm's speed where it is hit.
  function hitSeg(b, ax, ay, ex, ey, r, m) {
    var dx = ex - ax, dy = ey - ay, l2 = dx * dx + dy * dy, tt = (b.x - ax) * dx + (b.y - ay) * dy;
    if (tt < 0) tt = 0; if (tt > l2) tt = l2;
    var px = ax + (l2 > 0 ? Math.trunc(dx * tt / l2) : 0), py = ay + (l2 > 0 ? Math.trunc(dy * tt / l2) : 0);
    var ox = b.x - px, oy = b.y - py, rs = BR + r, d2 = ox * ox + oy * oy;
    if (d2 >= rs * rs) return 0;
    var dist = isqrt(d2), d = dist;
    if (d === 0) { ox = -dy; oy = dx; d = isqrt(ox * ox + oy * oy); if (d === 0) { ox = 0; oy = 1; d = 1; } }
    b.x = b.x + Math.trunc(ox * (rs - dist) / d); b.y = b.y + Math.trunc(oy * (rs - dist) / d);
    var mvx = 0, mvy = 0;
    if (m) { var rx = px - m.cx, ry = py - m.cy; mvx = -Math.trunc(ry * m.dir * 6283 / (1000 * m.p)); mvy = Math.trunc(rx * m.dir * 6283 / (1000 * m.p)); }
    return reflect(b, ox, oy, d, mvx, mvy, E_WALL);
  }
  function millArm(m, t) {
    var a = (Math.trunc(t * 1024 / m.p) * m.dir + m.ph) & 1023;
    var ex = Math.trunc(m.la * cosI(a) / 4096), ey = Math.trunc(m.la * sinI(a) / 4096);
    return [m.cx - ex, m.cy - ey, m.cx + ex, m.cy + ey];
  }
  function hitPillar(b, p) {
    var dx = b.x - p[0], dy = b.y - p[1], rs = BR + p[2], d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs) return 0;
    var d = isqrt(d2);
    if (d === 0) { dx = 0; dy = 1; d = 1; }
    var push = rs - d;
    b.x = b.x + Math.trunc(dx * push / d); b.y = b.y + Math.trunc(dy * push / d);
    return reflect(b, dx, dy, d, 0, 0, p[3] ? E_WALL : E_BUMP);
  }
  function reflect(b, dx, dy, d, mvx, mvy, e) {
    var rvx = b.vx - mvx, rvy = b.vy - mvy;
    var vn = Math.trunc((rvx * dx + rvy * dy) / d);
    if (vn >= 0) return 1;
    var imp = Math.trunc(-vn * (256 + e) / 256);
    b.vx = b.vx + Math.trunc(dx * imp / d); b.vy = b.vy + Math.trunc(dy * imp / d);
    return -vn;
  }
  function holeBase(strokes, par) {
    if (strokes === 1) return PTS_HIO;
    if (strokes < par) return PTS_BIRDIE;
    if (strokes === par) return PTS_PAR;
    if (strokes === par + 1) return PTS_BOGEY;
    return PTS_WORSE;
  }
  function finishHole(sim, ev, sunk) {
    var L = layoutOf(sim.seed, sim.hole);
    var strokes = sunk ? sim.strokes : L.par + FORFEIT_OVER;
    var base = holeBase(strokes, L.par), mult2 = 2;
    if (strokes <= L.par) {
      sim.streak = sim.streak + 1;
      mult2 = 2 + (sim.streak - 1 < STREAK_CAP ? sim.streak - 1 : STREAK_CAP);
    } else sim.streak = 0;
    var pts = Math.trunc(base * mult2 / 2);
    if (sunk) { sim.sunk = sim.sunk + 1; if (strokes === 1) sim.hio = sim.hio + 1; }
    sim.score = sim.score + pts;
    ev.push({ k: sunk ? 'sink' : 'forfeit', hole: sim.hole, strokes: strokes, par: L.par, base: base, mult2: mult2, pts: pts, streak: sim.streak });
    loadHole(sim, sim.hole + 1);
    sim.trans = TRANS_STEPS;
  }
  // One fixed 1/60 s step. Leaves the step's events in sim.ev.
  function stepSim(sim) {
    var ev = [];
    if (sim.dead) { sim.ev = ev; return; }
    var L = layoutOf(sim.seed, sim.hole), t = sim.step, i;
    if (sim.trans > 0) sim.trans = sim.trans - 1;
    else {
      var b = { x: sim.x, y: sim.y, vx: sim.vx, vy: sim.vy };
      if (!sim.moving) {
        // a sliding block that reaches a resting ball sets it rolling
        for (i = 0; i < L.movers.length; i++) {
          var m0 = L.movers[i], d0 = moverOff(m0, t + 1) - moverOff(m0, t);
          if (hitBox(b, moverRect(m0, t + 1), m0.ax === 0 ? d0 : 0, m0.ax === 1 ? d0 : 0) > 0) { sim.moving = 1; sim.roll = 0; }
        }
        for (i = 0; i < L.mills.length; i++) {
          var ma = millArm(L.mills[i], t + 1);
          if (hitSeg(b, ma[0], ma[1], ma[2], ma[3], L.mills[i].r, L.mills[i]) > 0) { sim.moving = 1; sim.roll = 0; }
        }
        if (!sim.moving) {
          sim.x = b.x; sim.y = b.y;
          if (L.bridges.length && wetAt(L, sim.x, sim.y, t + 1)) splash(sim, ev);
          sim.idle = sim.idle + 1;
          if (sim.idle >= IDLE_STEPS) finishHole(sim, ev, false);
        }
      }
      if (sim.moving) {
        var onRamp = 0;
        if (sim.air > 0) sim.air = sim.air - 1;
        else for (i = 0; i < L.rampsS.length; i++) if (inBox(L.rampsS[i], b.x, b.y)) {
          if (L.rampsS[i][6] && b.vx * b.vx + b.vy * b.vy >= JUMP_V * JUMP_V) { sim.air = JUMP_STEPS; ev.push({ k: 'jump' }); break; }
          b.vx = b.vx + L.rampsS[i][4]; b.vy = b.vy + L.rampsS[i][5]; onRamp = 1;
        }
        if (b.vx > VMAX) b.vx = VMAX; if (b.vx < -VMAX) b.vx = -VMAX;
        if (b.vy > VMAX) b.vy = VMAX; if (b.vy < -VMAX) b.vy = -VMAX;
        var mr = [], mv = [];
        for (i = 0; i < L.movers.length; i++) { mr.push(moverRect(L.movers[i], t + 1)); mv.push(moverOff(L.movers[i], t + 1) - moverOff(L.movers[i], t)); }
        var arms = [];
        for (i = 0; i < L.mills.length; i++) arms.push(millArm(L.mills[i], t + 1));
        var sunk = false, hitV = 0, bumpV = 0, cx = L.cup[0], cy = L.cup[1];
        for (var s = 0; s < SUB && !sunk; s++) {
          b.x = b.x + Math.trunc(b.vx / SUB); b.y = b.y + Math.trunc(b.vy / SUB);
          for (i = 0; i < L.solids.length; i++) { var h1 = hitBox(b, L.solids[i], 0, 0); if (h1 > hitV) hitV = h1; }
          for (i = 0; i < L.corners.length; i++) { var h4 = hitCorner(b, L.corners[i]); if (h4 > hitV) hitV = h4; }
          for (i = 0; i < L.railsS.length; i++) { var q5 = L.railsS[i], h5 = hitSeg(b, q5[0], q5[1], q5[2], q5[3], q5[4], null); if (h5 > hitV) hitV = h5; }
          for (i = 0; i < arms.length; i++) { var h6 = hitSeg(b, arms[i][0], arms[i][1], arms[i][2], arms[i][3], L.mills[i].r, L.mills[i]); if (h6 > hitV) hitV = h6; }
          for (i = 0; i < L.pillarsS.length; i++) { var h3 = hitPillar(b, L.pillarsS[i]); if (L.pillarsS[i][3]) { if (h3 > hitV) hitV = h3; } else if (h3 > bumpV) bumpV = h3; }
          for (i = 0; i < mr.length; i++) { var ax = L.movers[i].ax, h2 = hitBox(b, mr[i], ax === 0 ? mv[i] : 0, ax === 1 ? mv[i] : 0); if (h2 > hitV) hitV = h2; }
          for (i = 0; i < L.portalsS.length; i++) {
            var pq = L.portalsS[i], pdx = b.x - pq[0], pdy = b.y - pq[1];
            if (pdx * pdx + pdy * pdy <= WARP_R * WARP_R) { ev.push({ k: 'warp', x: b.x, y: b.y }); b.x = pq[2]; b.y = pq[3]; }
          }
          for (i = 0; i < L.gemsS.length; i++) {
            if (sim.gm & (1 << i)) continue;
            var gdx = b.x - L.gemsS[i][0], gdy = b.y - L.gemsS[i][1];
            if (gdx * gdx + gdy * gdy <= (BR + GEM_R) * (BR + GEM_R)) { sim.gm = sim.gm | (1 << i); sim.gems = sim.gems + 1; sim.score = sim.score + GEM_PTS; ev.push({ k: 'gem', i: i, pts: GEM_PTS, x: L.gemsS[i][0], y: L.gemsS[i][1] }); }
          }
          var ox = cx - b.x, oy = cy - b.y;
          if (ox * ox + oy * oy <= CAP_R * CAP_R && b.vx * b.vx + b.vy * b.vy <= CAP_V * CAP_V) sunk = true;
        }
        if (hitV > 1) ev.push({ k: 'wall', v: hitV });
        if (bumpV > 1) ev.push({ k: 'bump', v: bumpV });
        sim.x = b.x; sim.y = b.y; sim.vx = b.vx; sim.vy = b.vy;
        if (sunk) { sim.x = cx; sim.y = cy; sim.vx = 0; sim.vy = 0; sim.moving = 0; finishHole(sim, ev, true); }
        else {
          // over the cup and too fast: it curls round the rim toward the centre
          var lx = cx - sim.x, ly = cy - sim.y, over = lx * lx + ly * ly < CUP_R * CUP_R;
          if (over) {
            sim.vx = sim.vx + Math.trunc(lx * CURL / 256);
            sim.vy = sim.vy + Math.trunc(ly * CURL / 256);
            if (!sim.inLip) ev.push({ k: 'lip' });
          }
          sim.inLip = over ? 1 : 0;
          if (sim.air === 0 && wetAt(L, sim.x, sim.y, t + 1)) splash(sim, ev);
          else {
            var sand = 0;
            if (sim.air === 0) for (i = 0; i < L.sandS.length; i++) if (inBox(L.sandS[i], sim.x, sim.y)) sand = 1;
            var sp = isqrt(sim.vx * sim.vx + sim.vy * sim.vy);
            var s2 = sp - (sand ? DEC_SAND : DEC);
            sim.roll = sim.roll + 1;
            if ((s2 <= 0 && !onRamp) || sim.roll >= ROLL_MAX) {
              sim.vx = 0; sim.vy = 0; sim.moving = 0; sim.idle = 0; sim.inLip = 0; sim.air = 0;
              if (!wetAt(L, sim.x, sim.y, -1) || !L.bridges.length) { sim.rx = sim.x; sim.ry = sim.y; }
              ev.push({ k: 'rest' });
            } else if (s2 > 0) {
              sim.vx = Math.trunc(sim.vx * s2 / sp); sim.vy = Math.trunc(sim.vy * s2 / sp);
            }
          }
          if (!sim.moving && sim.strokes >= MAX_STROKES) finishHole(sim, ev, false);
        }
      }
    }
    sim.step = sim.step + 1;
    if (sim.step >= RUN_STEPS) { sim.dead = true; sim.endReason = 'time'; sim.vx = 0; sim.vy = 0; sim.moving = 0; ev.push({ k: 'time' }); }
    sim.ev = sim.ev.concat(ev);
  }
  // ==== MINI GOLF RULES END ====

// A work bound: the session hour. The round itself ends at RUN_STEPS.
const MAX_SIM_STEPS = 3600 * 60;
// A WORK bound far above any real run. It REFUSES further inputs, never zeroes.
const MAX_INPUTS = MAX_PUTTS + 100;

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }
function isInt(v) { return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v; }

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { steps: [], pulls: [], thinks: [], restAt: -1 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated: how hard each putt was pulled, and how long the
// player looked before putting after the ball came to rest.
function stepOnce(state) {
  const sim = state.sim;
  sim.ev = [];
  stepSim(sim);
  for (const e of sim.ev) if (e.k === 'rest' || e.k === 'sink' || e.k === 'forfeit' || e.k === 'water') state.stats.restAt = sim.step;
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

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(seedToInt(state.seed), Number(payload.v));
      state.sim.ev = [];
    }
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim' || kind !== 'putt') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, dx, dy, step } = payload;
  if (!isStep(n) || !isStep(step) || !isInt(dx) || !isInt(dy)) return reject(state, 'bad_putt');
  const sim = state.sim;
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  if (n !== sim.n) return reject(state, 'out_of_order');
  const r = puttSim(sim, dx, dy, step);
  if (r !== 'ok') return reject(state, r);
  state.stats.steps.push(step);
  state.stats.pulls.push(Math.min(PULL_MAX, isqrt(dx * dx + dy * dy)));
  if (state.stats.restAt >= 0) state.stats.thinks.push(step - state.stats.restAt);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out to the end of the clock: a rolling ball stops or drops.
  const capSteps = elapsedCap(state, 60);
  while (!sim.dead && sim.step < capSteps && sim.step < MAX_SIM_STEPS) stepOnce(state);
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, score: sim.score, dead: sim.dead, holes: sim.hole, sunk: sim.sunk, hio: sim.hio, gems: sim.gems,
      inputs: state.inputCount, rejects: state.rejectCount, putts: st.steps.length,
      pullMean: round3(mean(st.pulls)), pullSd: round3(sd(st.pulls)),
      thinkMean: round3(mean(st.thinks)), thinkSd: round3(sd(st.thinks)),
    },
  };
}

module.exports = {
  init, processEvent, finalize,
  _limits: { MAX_SIM_STEPS, MAX_INPUTS, FPS: 60, RUN_STEPS },
  _rules: { initSim, stepSim, puttSim, layoutOf, seedToInt, RUN_STEPS, RULES_VERSION, GEM_PTS },
};
