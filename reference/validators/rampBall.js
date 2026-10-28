'use strict';

/**
 * Ramp Ball validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one: a trace without a v2 start marker is not a run
 * and scores zero.
 *
 * The game: a cricket ball rolls down an endless course of track pieces high
 * in the sky. The player swipes: up pushes the ball on (a faster swipe pushes
 * harder and allows a higher top speed), down brakes, sideways steers. The
 * course behind collapses, a three-minute clock runs, falling off ends the run.
 * Score = distance x the speed multiplier + coins, close calls and air time.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed (section K draws from
 *      h32(seed, K, j), a pure function, never a running stream);
 *   2. applies each path batch { f, x[], y[] }: x[i], y[i] are the swipe during
 *      step f + 1 + i, exactly as the client fed its own step; every step with
 *      no batch has no input;
 *   3. runs the same fixed steps and reads the score the rules compute.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/ramp-ball/js/rules.js.
 * shared/tests/rampBallParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump.
 */

const GR = (function () {
  // RAMP BALL RULES BEGIN
  var P = 16384;            // sub-units per world unit
  var BR = 8192;            // ball radius (half a world unit)
  var TURN = 4096;          // angle units per turn (pieces)
  var PSI_TURN = 65536;     // camera heading units per turn
  var G_SLOPE = 104;        // gravity along a slope for a rolling ball, per step^2
  var G_FALL = 145;         // free fall, per step^2
  // the swipe: input is how far the finger MOVED this step, in thousandths of
  // the screen's width (up and right positive). Up speeds the ball along the
  // camera's heading, down brakes, sideways steers. A still finger does nothing.
  var IN_MAX = 600;         // the most one step's swipe can count for
  var KF = 160, KB = 210;   // speed per input unit, x100 (forward, brake)
  var KL = 500;             // sideways speed per input unit, x100
  // a faster swipe pushes harder and lets the ball go faster: control is the skill.
  // A swipe moving FLICK input units a step or more adds KF2 per unit beyond it, and
  // the top speed a swipe can reach is VMAX_LO plus KV per unit, up to VMAX.
  var FLICK = 25, KF2 = 420, VMAX_LO = 2185, KV = 30;
  var VMAX = 5461;          // the fastest any swipe can push (20 world units a second)
  // v3: a fast flick pushes harder and the top speed is a little higher (21 units a second);
  // v2 runs keep the v2 numbers above
  var KF2_V3 = 480, KV_V3 = 34, VMAX_V3 = 5800;
  var VREV = 1100;          // a brake can roll the ball back this fast
  var VLMAX = 4500;         // sideways speed cap
  var LAT_D = 250;          // sideways grip, per 4096 per step
  var COAST = 15;           // rolling drag, per 4096 per step
  var UPTOL = 2458;         // a deck this far above the ball still catches it
  var DOWNTOL = 3600;       // the ball follows a deck that drops this far in a step
  var BOUNCE_V = 1100;      // landing faster than this bounces
  var WALL_E = 30;          // wall restitution, percent
  var DECK = 11469;         // deck thickness
  var WALL_H = 10158, WALL_IN = 5243;   // wall height and thickness
  var RAIL_H = 6881, RAIL_IN = 3932;    // rail height and inset from the edge
  var PSI_K = 10, PSI_MAX = 520, PSI_VMIN = 260, PSI_VCAP = 2700;
  var KILL_DROP = 163840;   // ten world units below the lowest deck nearby
  var COIN_R = 6554, COIN_Y = 10158, COIN_PTS = 10;
  var SIN_Q = [
    0,25,50,75,101,126,151,176,201,226,251,276,302,327,352,377,402,427,452,477,503,528,553,578,603,628,653,678,704,729,754,779,
    804,829,854,879,904,929,955,980,1005,1030,1055,1080,1105,1130,1155,1180,1205,1230,1255,1280,1306,1331,1356,1381,1406,1431,1456,1481,1506,1531,1556,1581,
    1606,1631,1656,1681,1706,1731,1756,1781,1806,1831,1856,1881,1906,1931,1956,1981,2006,2031,2055,2080,2105,2130,2155,2180,2205,2230,2255,2280,2305,2329,2354,2379,
    2404,2429,2454,2479,2503,2528,2553,2578,2603,2628,2652,2677,2702,2727,2752,2776,2801,2826,2851,2875,2900,2925,2949,2974,2999,3024,3048,3073,3098,3122,3147,3172,
    3196,3221,3246,3270,3295,3320,3344,3369,3393,3418,3442,3467,3492,3516,3541,3565,3590,3614,3639,3663,3688,3712,3737,3761,3786,3810,3835,3859,3883,3908,3932,3957,
    3981,4005,4030,4054,4078,4103,4127,4151,4176,4200,4224,4249,4273,4297,4321,4346,4370,4394,4418,4442,4467,4491,4515,4539,4563,4587,4612,4636,4660,4684,4708,4732,
    4756,4780,4804,4828,4852,4876,4900,4924,4948,4972,4996,5020,5044,5068,5092,5115,5139,5163,5187,5211,5235,5259,5282,5306,5330,5354,5377,5401,5425,5449,5472,5496,
    5520,5543,5567,5591,5614,5638,5661,5685,5708,5732,5756,5779,5803,5826,5850,5873,5897,5920,5943,5967,5990,6014,6037,6060,6084,6107,6130,6154,6177,6200,6223,6247,
    6270,6293,6316,6339,6363,6386,6409,6432,6455,6478,6501,6524,6547,6570,6593,6616,6639,6662,6685,6708,6731,6754,6777,6800,6823,6846,6868,6891,6914,6937,6960,6982,
    7005,7028,7050,7073,7096,7118,7141,7164,7186,7209,7231,7254,7276,7299,7321,7344,7366,7389,7411,7434,7456,7478,7501,7523,7545,7568,7590,7612,7635,7657,7679,7701,
    7723,7746,7768,7790,7812,7834,7856,7878,7900,7922,7944,7966,7988,8010,8032,8054,8076,8098,8119,8141,8163,8185,8207,8228,8250,8272,8293,8315,8337,8358,8380,8401,
    8423,8445,8466,8488,8509,8531,8552,8573,8595,8616,8638,8659,8680,8702,8723,8744,8765,8787,8808,8829,8850,8871,8892,8914,8935,8956,8977,8998,9019,9040,9061,9082,
    9102,9123,9144,9165,9186,9207,9227,9248,9269,9290,9310,9331,9352,9372,9393,9413,9434,9455,9475,9496,9516,9537,9557,9577,9598,9618,9638,9659,9679,9699,9720,9740,
    9760,9780,9800,9820,9841,9861,9881,9901,9921,9941,9961,9981,10001,10020,10040,10060,10080,10100,10120,10139,10159,10179,10198,10218,10238,10257,10277,10296,10316,10336,10355,10374,
    10394,10413,10433,10452,10471,10491,10510,10529,10549,10568,10587,10606,10625,10644,10663,10683,10702,10721,10740,10759,10778,10796,10815,10834,10853,10872,10891,10909,10928,10947,10966,10984,
    11003,11021,11040,11059,11077,11096,11114,11133,11151,11169,11188,11206,11224,11243,11261,11279,11297,11316,11334,11352,11370,11388,11406,11424,11442,11460,11478,11496,11514,11532,11550,11567,
    11585,11603,11621,11638,11656,11674,11691,11709,11727,11744,11762,11779,11797,11814,11831,11849,11866,11883,11901,11918,11935,11952,11970,11987,12004,12021,12038,12055,12072,12089,12106,12123,
    12140,12157,12173,12190,12207,12224,12240,12257,12274,12290,12307,12324,12340,12357,12373,12390,12406,12423,12439,12455,12472,12488,12504,12520,12537,12553,12569,12585,12601,12617,12633,12649,
    12665,12681,12697,12713,12729,12744,12760,12776,12792,12807,12823,12839,12854,12870,12885,12901,12916,12932,12947,12963,12978,12993,13008,13024,13039,13054,13069,13085,13100,13115,13130,13145,
    13160,13175,13190,13205,13219,13234,13249,13264,13279,13293,13308,13323,13337,13352,13366,13381,13395,13410,13424,13439,13453,13467,13482,13496,13510,13524,13538,13553,13567,13581,13595,13609,
    13623,13637,13651,13665,13678,13692,13706,13720,13733,13747,13761,13774,13788,13802,13815,13829,13842,13856,13869,13882,13896,13909,13922,13935,13949,13962,13975,13988,14001,14014,14027,14040,
    14053,14066,14079,14092,14104,14117,14130,14143,14155,14168,14181,14193,14206,14218,14231,14243,14256,14268,14280,14293,14305,14317,14329,14341,14354,14366,14378,14390,14402,14414,14426,14438,
    14449,14461,14473,14485,14497,14508,14520,14531,14543,14555,14566,14578,14589,14601,14612,14623,14635,14646,14657,14668,14680,14691,14702,14713,14724,14735,14746,14757,14768,14779,14789,14800,
    14811,14822,14832,14843,14854,14864,14875,14885,14896,14906,14917,14927,14937,14948,14958,14968,14978,14989,14999,15009,15019,15029,15039,15049,15059,15069,15078,15088,15098,15108,15118,15127,
    15137,15146,15156,15166,15175,15184,15194,15203,15213,15222,15231,15240,15250,15259,15268,15277,15286,15295,15304,15313,15322,15331,15340,15349,15357,15366,15375,15383,15392,15401,15409,15418,
    15426,15435,15443,15451,15460,15468,15476,15485,15493,15501,15509,15517,15525,15533,15541,15549,15557,15565,15573,15581,15588,15596,15604,15611,15619,15627,15634,15642,15649,15656,15664,15671,
    15679,15686,15693,15700,15707,15715,15722,15729,15736,15743,15750,15757,15763,15770,15777,15784,15791,15797,15804,15810,15817,15824,15830,15837,15843,15849,15856,15862,15868,15875,15881,15887,
    15893,15899,15905,15911,15917,15923,15929,15935,15941,15946,15952,15958,15964,15969,15975,15980,15986,15991,15997,16002,16008,16013,16018,16024,16029,16034,16039,16044,16049,16054,16059,16064,
    16069,16074,16079,16084,16088,16093,16098,16103,16107,16112,16116,16121,16125,16130,16134,16138,16143,16147,16151,16156,16160,16164,16168,16172,16176,16180,16184,16188,16192,16195,16199,16203,
    16207,16210,16214,16218,16221,16225,16228,16232,16235,16238,16242,16245,16248,16251,16255,16258,16261,16264,16267,16270,16273,16276,16279,16281,16284,16287,16290,16292,16295,16298,16300,16303,
    16305,16308,16310,16312,16315,16317,16319,16321,16324,16326,16328,16330,16332,16334,16336,16338,16340,16341,16343,16345,16347,16348,16350,16352,16353,16355,16356,16358,16359,16360,16362,16363,
    16364,16365,16367,16368,16369,16370,16371,16372,16373,16374,16375,16375,16376,16377,16378,16378,16379,16380,16380,16381,16381,16382,16382,16382,16383,16383,16383,16384,16384,16384,16384,16384,
    16384,
  ];

  // the collapse: the track falls away behind the ball, from a front that
  // creeps along the course and quickens as the run goes on
  var FRONT_START = -98304, FRONT_WAIT = 150;          // six units behind, held for 2.5 s
  var FRONT_V0 = 1300, FRONT_VMAX = 2850, FRONT_RAMP = 5; // per step; +1 every FRONT_RAMP steps
  var FRONT_LEAD = 557056;                             // never more than 34 units behind the ball
  // the speed multiplier: heat builds while the ball runs fast, a level per 1000
  var HOT_V = 3300, WARM_V = 2200, HEAT_UP = 5, HEAT_DOWN = 7, HEAT_MAX = 4999;
  var HEAT_WALL = 600, HEAT_WALL_V = 700, HEAT_HIT = 1100;
  var NEAR = 11469, NEAR_PTS = 15, AIR_MIN = 36, AIR_DIV = 6;
  var HAMMER_R = 12288, HAMMER_KICK = 700, BUMP_KICK = 1700;
  var LAT_ICE = 18, KL_ICE = 160;   // ice: almost no sideways grip, and steering bites less
  var RUN_STEPS = 10800;            // a run lasts three minutes
  var SEC_PER_WORLD = 8;
  // a seeded integer hash: the same draws on every engine
  function fmix(h) { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
  function h32(a, b, c) {
    var h = fmix((a >>> 0) ^ 0x9e3779b9);
    h = fmix(((h ^ (b >>> 0)) + 0x632be5ab) | 0);
    return fmix(((h ^ (c >>> 0)) + 0x2545f491) | 0);
  }
  // the platform's session seed is hex; the course uses one 32-bit integer of it
  function seedToInt(seedHex) {
    if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
    return (parseInt(seedHex.slice(0, 8), 16) ^ Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, 0x2545f491)) >>> 0;
  }
  var RULES_VERSION = 3;
  function tdiv(a, b) { var q = a / b; return q < 0 ? Math.ceil(q) : Math.floor(q); }
  function isin(a) {
    a = ((a % TURN) + TURN) % TURN;
    var q = a >> 10, i = a & 1023;
    if (q === 0) return SIN_Q[i];
    if (q === 1) return SIN_Q[1024 - i];
    if (q === 2) return -SIN_Q[i];
    return -SIN_Q[1024 - i];
  }
  function icos(a) { return isin(a + 1024); }
  function isqrt(n) {
    if (n <= 0) return 0;
    var r = Math.floor(Math.sqrt(n));
    while (r * r > n) r--;
    while ((r + 1) * (r + 1) <= n) r++;
    return r;
  }
  // the angle a (0..4095) with sin a : cos a = s : c
  function iatan2(s, c) {
    if (s === 0 && c === 0) return 0;
    var as = s < 0 ? -s : s, ac = c < 0 ? -c : c, a;
    if (as <= ac) {
      var lo = 0, hi = 512;
      while (lo < hi) { var m = (lo + hi + 1) >> 1; if (SIN_Q[m] * ac <= as * SIN_Q[1024 - m]) lo = m; else hi = m - 1; }
      a = lo;
    } else {
      var lo2 = 0, hi2 = 512;
      while (lo2 < hi2) { var m2 = (lo2 + hi2 + 1) >> 1; if (SIN_Q[m2] * as <= ac * SIN_Q[1024 - m2]) lo2 = m2; else hi2 = m2 - 1; }
      a = 1024 - lo2;
    }
    if (c >= 0 && s >= 0) return a;
    if (c < 0 && s >= 0) return 2048 - a;
    if (c < 0) return 2048 + a;
    return (4096 - a) & 4095;
  }
  function wrap(a, n) { a = ((a % n) + n) % n; return a >= n / 2 ? a - n : a; }

  // ── pieces. yaw 0 faces -z; forward = (sin, -cos), right = (cos, sin) ──
  // side kinds: 0 open, 1 rail, 2 wall
  function sideH(k) { return k === 2 ? WALL_H : k === 1 ? RAIL_H : 0; }
  function sideIn(k) { return k === 2 ? WALL_IN : k === 1 ? RAIL_IN : 0; }

  function Builder(sim) { this.sim = sim; this.x = 0; this.z = 0; this.y = 0; this.yaw = 0; this.s = 0; }
  Builder.prototype.push = function (p) { p.idx = this.sim.pieces.length; p.s0 = this.s; this.s += p.L; this.sim.pieces.push(p); this.gapped = false; return p; };
  // never leave the outer lanes of a wide piece running off the end of a narrower one
  Builder.prototype.fit = function (w0) {
    var ps = this.sim.pieces, prev = ps[ps.length - 1];
    if (!prev || this.gapped) return;
    var pw = prev.t === 'S' ? (prev.w1 || prev.w) : prev.t === 'A' ? prev.w : 0;
    if (!pw || pw <= w0 + 1638) return;
    if (prev.t === 'S' && !prev.holes && !prev.split && !prev.tilt && !prev.mv && !prev.mvA && !prev.mvY && !prev.prof && !prev.fall && !prev.obs && prev.len >= 4 * P && !prev.w1) { prev.w1 = w0; return; }
    var fx = isin(this.yaw), fz = -icos(this.yaw), side = prev.sl === 1 || prev.sr === 1 ? 1 : 0;
    var t = this.push({ t: 'S', x0: this.x, z0: this.z, y0: this.y, yaw: this.yaw, len: 3 * P, w: pw, w1: w0, dy: 0, sl: side, sr: side, L: 3 * P, coins: [] });
    this.x += tdiv(fx * t.len, P); this.z += tdiv(fz * t.len, P);
  };
  Builder.prototype.straight = function (len, w, dy, sl, sr) {
    this.fit(w);
    var fx = isin(this.yaw), fz = -icos(this.yaw);
    var p = this.push({ t: 'S', x0: this.x, z0: this.z, y0: this.y, yaw: this.yaw, len: len, w: w, dy: dy, sl: sl, sr: sr, L: len, coins: [] });
    this.x += tdiv(fx * len, P); this.z += tdiv(fz * len, P); this.y += dy;
    return p;
  };
  // turn > 0 bends right
  Builder.prototype.arc = function (turn, rc, w, dy, sl, sr) {
    this.fit(w);
    var sg = turn > 0 ? 1 : -1, cx = this.x + tdiv(sg * icos(this.yaw) * rc, P), cz = this.z + tdiv(sg * isin(this.yaw) * rc, P);
    var L = tdiv((turn < 0 ? -turn : turn) * rc * 6434, 4194304);
    var p = this.push({ t: 'A', cx: cx, cz: cz, rc: rc, sg: sg, a0: this.yaw, turn: turn, y0: this.y, w: w, dy: dy, sl: sl, sr: sr, L: L, coins: [] });
    this.yaw = ((this.yaw + turn) % TURN + TURN) % TURN;
    this.x = cx - tdiv(sg * icos(this.yaw) * rc, P); this.z = cz - tdiv(sg * isin(this.yaw) * rc, P); this.y += dy;
    return p;
  };
  Builder.prototype.shift = function (lat) { this.x += tdiv(icos(this.yaw) * lat, P); this.z += tdiv(isin(this.yaw) * lat, P); };
  Builder.prototype.gap = function (dist, drop) {
    this.x += tdiv(isin(this.yaw) * dist, P); this.z += tdiv(-icos(this.yaw) * dist, P); this.y -= drop; this.s += dist; this.gapped = true;
  };
  // a turning disc: in at the near edge, out at the far edge, and it carries the ball round
  var DISC_OVL = 13107;   // the disc reaches 0.8 units over the track at each join, so its round edge leaves no gap
  Builder.prototype.disc = function (r, omega) {
    var fx = isin(this.yaw), fz = -icos(this.yaw), cx = this.x + tdiv(fx * (r - DISC_OVL), P), cz = this.z + tdiv(fz * (r - DISC_OVL), P);
    var p = this.push({ t: 'D', cx: cx, cz: cz, y0: this.y, yaw: this.yaw, R: r, om: omega, L: 2 * r, coins: [] });
    this.x = cx + tdiv(fx * (r - DISC_OVL), P); this.z = cz + tdiv(fz * (r - DISC_OVL), P);
    return p;
  };
  // a spiral maze plate. The way on is the hole in the middle, onto a track below.
  var PLATE_R = 157286, PLATE_HOLE = 20480, PLATE_R0 = 24576, PLATE_PITCH = 42598, PLATE_WT = 6881, PLATE_WH = 10158;
  var PLATE_TH = 8192, PLATE_EXT = 455, PLATE_GAP = 150, PLATE_DROP = 196608;
  Builder.prototype.plate = function () {
    var fx = isin(this.yaw), fz = -icos(this.yaw);
    var cx = this.x + tdiv(fx * PLATE_R, P), cz = this.z + tdiv(fz * PLATE_R, P), ae = (this.yaw + 1024) % TURN;
    var segs = [], prev = null;
    for (var k = 0; k <= PLATE_TH + PLATE_EXT; k += 32) {
      var r = PLATE_R0 + tdiv(PLATE_PITCH * k, TURN), ang = ae - (PLATE_TH - k);
      var px = cx + tdiv(icos(ang) * r, P), pz = cz + tdiv(isin(ang) * r, P);
      if (prev) segs.push(prev[0], prev[1], px, pz);
      prev = [px, pz];
    }
    // the rim's two ends beside the way in, as round posts (spiral walls use segs too)
    var rr = PLATE_R - (PLATE_WT >> 1);
    for (var e = -1; e <= 1; e += 2) {
      var ea = ae + e * PLATE_GAP, ex = cx + tdiv(icos(ea) * rr, P), ez = cz + tdiv(isin(ea) * rr, P);
      segs.push(ex, ez, ex, ez);
    }
    var p = this.push({ t: 'P', cx: cx, cz: cz, y0: this.y, yaw: this.yaw, R: PLATE_R, hole: PLATE_HOLE, ae: ae, segs: segs, segR: PLATE_WT >> 1, L: 63 * P, coins: [] });
    // the track below starts just before the hole, so the ball lands on it
    this.x = cx - tdiv(fx * 2 * P, P); this.z = cz - tdiv(fz * 2 * P, P); this.y -= PLATE_DROP;
    return p;
  };

  // a rectangular maze: a square-cell maze carved from the seed, or a zig-zag.
  // In at the middle of the near edge, out at a cell on the far edge.
  var CELL = 49152, MAZE_WT = 6554;
  Builder.prototype.rect = function (nx, ny, zig, seed, k) {
    var fx = isin(this.yaw), fz = -icos(this.yaw), rx = -fz, rz = fx;
    var w = nx * CELL, len = ny * CELL, hw = w >> 1, x0 = this.x, z0 = this.z;
    function W(a, l) { return [x0 + tdiv(fx * a + rx * l, P), z0 + tdiv(fz * a + rz * l, P)]; }
    var segs = [];
    function seg(a1, l1, a2, l2) { var p1 = W(a1, l1), p2 = W(a2, l2); segs.push(p1[0], p1[1], p2[0], p2[1]); }
    // cell walls: right wall of (i, j) and the wall across the top of (i, j)
    var right = [], top = [], i, j, entry = nx >> 1, exit;
    for (i = 0; i < nx * ny; i++) { right.push(1); top.push(1); }
    if (zig) {
      // rows joined at alternating ends
      for (j = 0; j < ny; j++) for (i = 0; i < nx - 1; i++) right[j * nx + i] = 0;
      var side = (h32(seed, k, 40) & 1) ? 0 : nx - 1;
      for (j = 0; j < ny - 1; j++) { top[j * nx + side] = 0; side = side === 0 ? nx - 1 : 0; }
      exit = side;
    } else {
      // depth-first carving with seeded choices, starting at the way in
      var seen = [], stack = [[entry, 0]], n = 0;
      for (i = 0; i < nx * ny; i++) seen.push(0);
      seen[entry] = 1;
      while (stack.length) {
        var c = stack[stack.length - 1], ci = c[0], cj = c[1], opts = [];
        if (ci > 0 && !seen[cj * nx + ci - 1]) opts.push(0);
        if (ci < nx - 1 && !seen[cj * nx + ci + 1]) opts.push(1);
        if (cj > 0 && !seen[(cj - 1) * nx + ci]) opts.push(2);
        if (cj < ny - 1 && !seen[(cj + 1) * nx + ci]) opts.push(3);
        if (!opts.length) { stack.pop(); continue; }
        var o = opts[h32(seed, k, 50 + n++) % opts.length];
        if (o === 0) { right[cj * nx + ci - 1] = 0; ci--; }
        else if (o === 1) { right[cj * nx + ci] = 0; ci++; }
        else if (o === 2) { top[(cj - 1) * nx + ci] = 0; cj--; }
        else { top[cj * nx + ci] = 0; cj++; }
        seen[cj * nx + ci] = 1; stack.push([ci, cj]);
      }
      exit = h32(seed, k, 49) % nx;
    }
    function L(ci) { return ci * CELL - hw; }
    for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
      if (i < nx - 1 && right[j * nx + i]) seg(j * CELL, L(i + 1), (j + 1) * CELL, L(i + 1));
      if (j < ny - 1 && top[j * nx + i]) seg((j + 1) * CELL, L(i), (j + 1) * CELL, L(i + 1));
    }
    // the outer walls, open at the way in and the way out
    seg(0, -hw, len, -hw); seg(0, hw, len, hw);
    if (entry > 0) seg(0, -hw, 0, L(entry)); if (entry < nx - 1) seg(0, L(entry + 1), 0, hw);
    if (exit > 0) seg(len, -hw, len, L(exit)); if (exit < nx - 1) seg(len, L(exit + 1), len, hw);
    var p = this.push({ t: 'R', x0: x0, z0: z0, y0: this.y, yaw: this.yaw, len: len, w: w, dy: 0, sl: 0, sr: 0, L: nx * ny * CELL, segs: segs, segR: MAZE_WT >> 1, zig: zig ? 1 : 0, coins: [] });
    var el = L(exit) + (CELL >> 1);
    this.x = x0 + tdiv(fx * len + rx * el, P); this.z = z0 + tdiv(fz * len + rz * el, P);
    return p;
  };

  // ── where a point sits on a piece ──
  var Q = { along: 0, lat: 0, h: 0, tx: 0, tz: 0, slope: 0, lslope: 0, nx: 0, nz: 0, rr: 0 };
  var HP_DEPTH = 13107;     // a half-pipe's edges stand this far above its middle
  function mvOff(sim, p, f) { return p.mv ? tdiv(p.mv.amp * isin(p.mv.ph + tdiv(f * TURN, p.mv.per)), P) : 0; }
  // 0..4096 easing in over the first R and out over the last R of a length L
  function ramp(a, L, R) {
    var k = Math.max(0, Math.min(4096, tdiv(a * 4096, R), tdiv((L - a) * 4096, R)));
    return tdiv(tdiv(k * k, 4096) * (12288 - 2 * k), 4096);
  }
  var EASE = 32768;   // two units to ease a bank, a tilt or a half-pipe in and out
  function osc(o, f) { return o ? tdiv(o.amp * isin(o.ph + tdiv(f * TURN, o.per)), P) : 0; }
  // a disc's turn at step f, in angle units
  function discAng(p, f) { return tdiv(p.om * f, 16); }
  function locate(p, x, z, sim) {
    var dx, dz;
    if (p.t === 'S' || p.t === 'R') {
      dx = x - p.x0; dz = z - p.z0;
      var fx = isin(p.yaw), fz = -icos(p.yaw), fr = sim ? sim.frames : 0;
      Q.along = tdiv(dx * fx + dz * fz, P); Q.lat = tdiv(dx * fz * -1 + dz * fx, P);
      if (p.mv) Q.lat -= mvOff(sim, p, fr);
      if (p.mvA) Q.along -= osc(p.mvA, fr);
      Q.tx = fx; Q.tz = fz; Q.nx = -fz; Q.nz = fx;
      var a = Math.max(0, Math.min(p.len, Q.along)), hw = p.w1 ? (p.w + tdiv((p.w1 - p.w) * a, p.len)) >> 1 : p.w >> 1;
      Q.h = p.y0 + tdiv(p.dy * a, p.len) + osc(p.mvY, fr);
      Q.slope = tdiv(p.dy * 4096, p.len); Q.lslope = 0;
      if (p.tilt) { var tl = tdiv(osc(p.tilt, fr) * ramp(a, p.len, 3 * P), 4096); Q.h += tdiv(tl * Math.max(-hw, Math.min(hw, Q.lat)), P); Q.lslope = tdiv(tl * 4096, P); }
      if (p.prof === 1) {
        var lt = Math.max(-hw, Math.min(hw, Q.lat)), hd = tdiv(HP_DEPTH * ramp(a, p.len, EASE), 4096);
        Q.h += tdiv(tdiv(hd * lt, hw) * lt, hw);
        Q.lslope = tdiv(tdiv(2 * hd * lt, hw) * 4096, hw);
      } else if (p.prof === 2) {
        var ph = tdiv(a * TURN, p.bL);
        Q.h += tdiv(p.bA * (P - icos(ph)), 2 * P);
        Q.slope += tdiv(tdiv(p.bA * isin(ph), 2 * P) * 25736, p.bL);
      }
      if (Q.along < 0 || Q.along > p.len || Q.lat < -hw || Q.lat > hw) return false;
      if (p.split && Q.along > 2 * P && Q.along < p.len - 2 * P && Q.lat > -(p.split >> 1) && Q.lat < (p.split >> 1)) return false;
      if (p.holes) for (var hi = 0; hi < p.holes.length; hi += 4) if (Q.along > p.holes[hi] && Q.along < p.holes[hi + 1] && Q.lat > p.holes[hi + 2] && Q.lat < p.holes[hi + 3]) return false;
      return true;
    }
    if (p.t === 'A') {
      dx = x - p.cx; dz = z - p.cz;
      var rr = isqrt(dx * dx + dz * dz);
      var phi = p.sg > 0 ? iatan2(-dz, -dx) : iatan2(dz, dx);
      var u = wrap((phi - p.a0) * p.sg, TURN), span = p.turn < 0 ? -p.turn : p.turn;
      Q.along = tdiv(u * p.rc * 6434, 4194304);
      Q.lat = p.sg * (p.rc - rr);
      Q.tx = isin(phi); Q.tz = -icos(phi);
      // the right-hand normal points at the centre on a right bend
      if (rr > 0) { Q.nx = tdiv(-p.sg * dx * P, rr); Q.nz = tdiv(-p.sg * dz * P, rr); } else { Q.nx = 0; Q.nz = 0; }
      Q.h = p.y0 + tdiv(p.dy * Math.max(0, Math.min(span, u)), span);
      Q.slope = p.L > 0 ? tdiv(p.dy * 4096, p.L) : 0; Q.lslope = 0;
      if (p.bank) { var bk = tdiv(p.bank * ramp(Math.max(0, Math.min(p.L, Q.along)), p.L, Math.min(3 * P, p.L >> 2)), 4096), bl = Math.max(-(p.w >> 1), Math.min(p.w >> 1, Q.lat)); Q.h += tdiv(-p.sg * bk * bl, p.w >> 1); Q.lslope = tdiv(-p.sg * bk * 4096, p.w >> 1); }
      return u >= 0 && u <= span && Q.lat >= -(p.w >> 1) && Q.lat <= (p.w >> 1);
    }
    if (p.t === 'D') {
      dx = x - p.cx; dz = z - p.cz;
      var fxd = isin(p.yaw), fzd = -icos(p.yaw);
      Q.rr = isqrt(dx * dx + dz * dz); Q.h = p.y0; Q.slope = 0; Q.lslope = 0; Q.tx = fxd; Q.tz = fzd; Q.nx = -fzd; Q.nz = fxd;
      Q.along = p.R + tdiv(dx * fxd + dz * fzd, P); Q.lat = tdiv(-dx * fzd + dz * fxd, P);
      return Q.rr <= p.R;
    }
    // plate
    dx = x - p.cx; dz = z - p.cz;
    Q.rr = isqrt(dx * dx + dz * dz); Q.h = p.y0; Q.slope = 0; Q.lslope = 0; Q.tx = 0; Q.tz = 0;
    Q.along = tdiv((p.R - Q.rr) * p.L, p.R - p.hole);
    return Q.rr <= p.R && Q.rr >= p.hole;
  }

  // the course position of the point Q just located on p: a maze falls whole,
  // a plate from its rim inward, everything else at the point itself
  function courseS(p) {
    if (p.t === 'R' || p.t === 'D') return p.s0 + p.L;
    if (p.t === 'P') return p.s0 + Q.along;
    return p.s0 + Math.max(0, Math.min(p.L, Q.along));
  }
  function gone(sim, p) { return (sim.crumble && sim.front >= p.s0 + p.L) || (p.fall && p.enter > 0 && sim.frames - p.enter > p.fall); }

  // the highest deck under (x, z) no higher than lim
  var S = { p: null, h: 0, along: 0, lat: 0, tx: 0, tz: 0, slope: 0, lslope: 0, nx: 0, nz: 0 };
  function support(sim, x, z, lim) {
    S.p = null;
    var a = Math.max(0, sim.pi - 2), b = Math.min(sim.pieces.length - 1, sim.pi + 3);
    for (var i = a; i <= b; i++) {
      var p = sim.pieces[i];
      if (gone(sim, p)) continue;
      if (locate(p, x, z, sim) && Q.h <= lim && (!S.p || Q.h > S.h) && !(sim.crumble && courseS(p) < sim.front) && !(p.fall && p.enter > 0 && sim.frames - p.enter > p.fall)) {
        S.p = p; S.h = Q.h; S.along = Q.along; S.lat = Q.lat; S.tx = Q.tx; S.tz = Q.tz; S.slope = Q.slope; S.lslope = Q.lslope; S.nx = Q.nx; S.nz = Q.nz;
      }
    }
    return S.p;
  }

  function hitWall(sim, nx, nz, push) {
    // push the ball back along the normal and take the speed out of it
    sim.x += tdiv(nx * push, P); sim.z += tdiv(nz * push, P);
    var vn = tdiv(sim.vx * nx + sim.vz * nz, P);
    if (vn < 0) {
      var k = tdiv(vn * (100 + WALL_E), 100);
      sim.vx -= tdiv(k * nx, P); sim.vz -= tdiv(k * nz, P);
      if (-vn > sim.evWall) sim.evWall = -vn;
    }
  }
  // a moving thing struck the ball: push it out and give it the thing's speed
  function knock(sim, nx, nz, push, kick) {
    hitWall(sim, nx, nz, push);
    if (kick > 0) { sim.vx += tdiv(nx * kick, P); sim.vz += tdiv(nz * kick, P); }
    sim.evHit = 1;
  }
  function walls(sim) {
    var a = Math.max(0, sim.pi - 2), b = Math.min(sim.pieces.length - 1, sim.pi + 3);
    for (var i = a; i <= b; i++) {
      var p = sim.pieces[i];
      if (gone(sim, p)) continue;
      if (p.t === 'P') { plateWalls(sim, p); continue; }
      if (p.t === 'D') continue;
      locate(p, sim.x, sim.z, sim);
      var span = p.t === 'A' ? p.L : p.len;
      if (Q.along < -BR || Q.along > span + BR) continue;
      if (Q.lat < -(p.w >> 1) - BR - 4 * P || Q.lat > (p.w >> 1) + BR + 4 * P) continue;
      var h = Q.h, lat = Q.lat, nx = Q.nx, nz = Q.nz;
      // the side of a deck standing higher than the ball is solid
      if (p.t === 'S') slabSide(sim, p);
      if (sim.y > h + 3 * P || sim.y < h - DECK) continue;
      if (p.segs) segWalls(sim, p);
      if (Q.along < 0 || Q.along > span) continue;
      var hwW = p.w1 ? (p.w + tdiv((p.w1 - p.w) * Math.max(0, Math.min(p.len, Q.along)), p.len)) >> 1 : p.w >> 1;
      if (p.sl && sim.y < h + sideH(p.sl)) {
        var lim = -hwW + sideIn(p.sl) + BR;
        if (lat < lim) hitWall(sim, nx, nz, lim - lat);
      }
      if (p.sr && sim.y < h + sideH(p.sr)) {
        var lim2 = hwW - sideIn(p.sr) - BR;
        if (lat > lim2) hitWall(sim, -nx, -nz, lat - lim2);
      }
      if (p.obs) for (var o = 0; o < p.obs.length; o++) { var ob = p.obs[o], al0 = Q.along, gp = obstacle(sim, p, ob); nearMiss(sim, ob, gp, al0); }
    }
  }
  function slabSide(sim, p) {
    var a = Q.along, l = Q.lat, hw = p.w1 ? (p.w + tdiv((p.w1 - p.w) * Math.max(0, Math.min(p.len, a)), p.len)) >> 1 : p.w >> 1;
    var inRect = a >= 0 && a <= p.len && l >= -hw && l <= hw;
    if (inRect || a < -BR || a > p.len + BR || l < -hw - BR || l > hw + BR) return;
    if (!(sim.y < Q.h - UPTOL && sim.y > Q.h - DECK - BR)) return;
    // push out through the nearest face
    var pa0 = a + BR, pa1 = p.len + BR - a, pl0 = l + hw + BR, pl1 = hw + BR - l, m = Math.min(pa0, pa1, pl0, pl1);
    var fx = Q.tx, fz = Q.tz;
    if (m === pa0) hitWall(sim, -fx, -fz, pa0); else if (m === pa1) hitWall(sim, fx, fz, pa1);
    else if (m === pl0) hitWall(sim, -Q.nx, -Q.nz, pl0); else hitWall(sim, Q.nx, Q.nz, pl1);
  }
  function segWalls(sim, p) {
    var s = p.segs, reach = BR + p.segR;
    for (var i = 0; i < s.length; i += 4) {
      var ax = s[i], az = s[i + 1], bx = s[i + 2], bz = s[i + 3];
      var ex = bx - ax, ez = bz - az, px = sim.x - ax, pz = sim.z - az, den = ex * ex + ez * ez, cx = ax, cz = az;
      if (den > 0) {
        var num = px * ex + pz * ez;
        if (num > 0) { if (num >= den) { cx = bx; cz = bz; } else { cx = ax + tdiv(ex * num, den); cz = az + tdiv(ez * num, den); } }
      }
      var qx = sim.x - cx, qz = sim.z - cz;
      if (qx > reach || qx < -reach || qz > reach || qz < -reach) continue;
      var d = isqrt(qx * qx + qz * qz);
      if (d < reach && d > 0) hitWall(sim, tdiv(qx * P, d), tdiv(qz * P, d), reach - d);
    }
  }

  // ── obstacles on a straight. Every position is a closed form of the step, so
  // nothing about them needs storing. Coordinates are along / across the piece.
  var OBS_H = 16384;
  function tri(f, per, ph) {   // -P..P triangle wave
    var t = ((f + ph) % per + per) % per, half = per >> 1;
    return t < half ? -P + tdiv(2 * P * t, half) : P - tdiv(2 * P * (t - half), per - half);
  }
  // where an obstacle is at step f: [along, lat, half-along, half-lat] for a box,
  // or [along, lat, radius] for a round one, or a bar [pa, pl, ang, half-length]
  function obsAt(sim, p, o, f) {
    if (o.k === 'ham') return [o.along, tdiv(o.amp * isin(o.ph + tdiv(f * TURN, o.per)), P), HAMMER_R];
    if (o.k === 'post' || o.k === 'bump') return [o.along, o.lat, o.r];
    if (o.k === 'slide') return [o.along, tdiv(o.amp * tri(f, o.per, o.ph), P), o.ha, o.hl];
    if (o.k === 'push') {
      var e = tri(f, o.per, o.ph), ext = e > 0 ? tdiv(o.ext * e, P) : 0;
      return [o.along, o.side * ((p.w >> 1) + o.hl - ext), o.ha, o.hl];
    }
    if (o.k === 'gate') {
      // two leaves closing from the sides; open is the gap between them
      var g = tri(f, o.per, o.ph), open = o.gmin + tdiv((o.gmax - o.gmin) * (g + P), 2 * P), hl = ((p.w >> 1) - (open >> 1)) >> 1;
      return [o.along, (open >> 1) + hl, o.ha, hl];
    }
    if (o.k === 'sweep') return [o.along, o.lat, o.ph + o.dir * tdiv(f * TURN, o.per), o.len];
    return null;
  }
  function toWorldN(p, na, nl) { var fx = isin(p.yaw), fz = -icos(p.yaw); return [tdiv(na * fx - nl * fz, P), tdiv(na * fz + nl * fx, P)]; }
  function boxHit(sim, p, a, l, ca, cl, ha, hl, va, vl) {
    var qa = Math.max(ca - ha, Math.min(ca + ha, a)), ql = Math.max(cl - hl, Math.min(cl + hl, l));
    var da = a - qa, dl = l - ql, d = isqrt(da * da + dl * dl), na, nl, push;
    if (d >= BR) return d - BR;
    if (d === 0) {
      // the centre got inside: leave by the nearest face
      var ea = ha - Math.abs(a - ca), el = hl - Math.abs(l - cl);
      if (ea < el) { na = a >= ca ? P : -P; nl = 0; push = ea + BR; } else { na = 0; nl = l >= cl ? P : -P; push = el + BR; }
    } else { na = tdiv(da * P, d); nl = tdiv(dl * P, d); push = BR - d; }
    var n = toWorldN(p, na, nl), kick = tdiv(va * na + vl * nl, P);
    knock(sim, n[0], n[1], push, kick > 0 ? kick + 200 : 0);
    return 0;
  }
  // returns how close the ball came: the gap between it and the thing, 0 on a touch
  function obstacle(sim, p, o) {
    var a = Q.along, l = Q.lat, now = obsAt(sim, p, o, sim.frames), was = obsAt(sim, p, o, sim.frames - 1);
    if (o.k === 'ham' || o.k === 'post' || o.k === 'bump') {
      var da = a - now[0], dl = l - now[1], reach = BR + now[2];
      if (da > reach + NEAR || da < -reach - NEAR || dl > reach + NEAR || dl < -reach - NEAR) return NEAR;
      var d = isqrt(da * da + dl * dl);
      if (d >= reach) return d - reach;
      if (d === 0) return 0;
      var n = toWorldN(p, tdiv(da * P, d), tdiv(dl * P, d));
      if (o.k === 'post') hitWall(sim, n[0], n[1], reach - d);
      else knock(sim, n[0], n[1], reach - d, o.k === 'bump' ? BUMP_KICK : HAMMER_KICK);
      return 0;
    }
    if (o.k === 'gate') {
      var g1 = boxHit(sim, p, a, l, now[0], now[1], now[2], now[3], 0, now[1] - was[1]);
      var g2 = boxHit(sim, p, a, l, now[0], -now[1], now[2], now[3], 0, was[1] - now[1]);
      return Math.min(g1, g2);
    }
    if (o.k === 'slide' || o.k === 'push') return boxHit(sim, p, a, l, now[0], now[1], now[2], now[3], 0, now[1] - was[1]);
    if (o.k === 'sweep') {
      var best = sweepBar(sim, p, o, a, l, now[2], now);
      if (o.arms === 2) best = Math.min(best, sweepBar(sim, p, o, a, l, now[2] + 1024, now));
      return best;
    }
    return NEAR;
  }
  function sweepBar(sim, p, o, a, l, ang, now) {
    {
      // a bar turning about a post; it bats the ball along its own motion
      var ca = icos(ang), sa = isin(ang), ea2 = tdiv(ca * now[3], P), el2 = tdiv(sa * now[3], P);
      var ax = now[0] - ea2, al = now[1] - el2, ex = 2 * ea2, el3 = 2 * el2, px = a - ax, pl = l - al, den = ex * ex + el3 * el3;
      var t = den > 0 ? Math.max(0, Math.min(den, px * ex + pl * el3)) : 0, qa = ax + (den > 0 ? tdiv(ex * t, den) : 0), ql = al + (den > 0 ? tdiv(el3 * t, den) : 0);
      var dd = isqrt((a - qa) * (a - qa) + (l - ql) * (l - ql)), rch = BR + 3277;
      if (dd >= rch) return dd - rch;
      if (dd === 0) return 0;
      var r = isqrt((qa - now[0]) * (qa - now[0]) + (ql - now[1]) * (ql - now[1]));
      var sp = tdiv(r * 6434, 1024 * o.per) * 2;
      var nw = toWorldN(p, tdiv((a - qa) * P, dd), tdiv((l - ql) * P, dd));
      knock(sim, nw[0], nw[1], rch - dd, sp + 300);
      return 0;
    }
  }
  // a close call pays once, when the ball is past the thing without touching it
  function nearMiss(sim, o, gap, along) {
    if (o.paid) return;
    if (gap <= 0) { o.hit = 1; return; }
    if (gap < NEAR && sim.y < Q.h + OBS_H) o.close = 1;
    if (o.close && !o.hit && along > o.along + 2 * P) {
      o.paid = 1;
      var pts = NEAR_PTS * sim.mult;
      sim.bonus += pts; sim.evNear = pts;
    }
  }
  function plateWalls(sim, p) {
    var dx = sim.x - p.cx, dz = sim.z - p.cz, rr = isqrt(dx * dx + dz * dz);
    if (rr > p.R + BR || sim.y > p.y0 + PLATE_WH || sim.y < p.y0 - DECK) return;
    // rim, except across the way in
    var lim = p.R - PLATE_WT - BR;
    if (rr > lim && rr > 0) {
      var ang = iatan2(dz, dx), off = wrap(ang - p.ae, TURN);
      if (off < -PLATE_GAP || off > PLATE_GAP) hitWall(sim, tdiv(-dx * P, rr), tdiv(-dz * P, rr), rr - lim);
    }
    segWalls(sim, p);
  }

  // ── pads: a speed pad drives the ball on; a jump pad throws it up ──
  var PAD_V = 4500, PAD_ACC = 200, JUMP_V = 3300, JUMP_VF = 3000;   // a jump carries 9.9 units before a 2-unit drop
  function pads(sim, p) {
    if (!p.pads || p.t !== 'S') return;
    for (var i = 0; i < p.pads.length; i++) {
      var pd = p.pads[i];
      if (S.along < pd.a0 || S.along > pd.a1) continue;
      if (pd.k === 'speed') {
        var vf = tdiv(sim.vx * S.tx + sim.vz * S.tz, P);
        if (vf < PAD_V) { sim.vx += tdiv(S.tx * PAD_ACC, P); sim.vz += tdiv(S.tz * PAD_ACC, P); sim.evPad = 1; }
      } else if (pd.k === 'belt') {
        sim.x += tdiv(S.tx * pd.v, P); sim.z += tdiv(S.tz * pd.v, P);
      } else if (pd.k === 'wind') {
        sim.x += tdiv(S.nx * pd.v, P); sim.z += tdiv(S.nz * pd.v, P); sim.evWind = 1;
      } else if (pd.k === 'jump' && sim.gr) {
        sim.gr = false; sim.vy = JUMP_V; sim.airFrames = 0; sim.evJump = 1;
        var vf2 = tdiv(sim.vx * S.tx + sim.vz * S.tz, P);
        if (vf2 < JUMP_VF) { sim.vx += tdiv(S.tx * (JUMP_VF - vf2), P); sim.vz += tdiv(S.tz * (JUMP_VF - vf2), P); }
      }
    }
  }

  // ── the endless course: section K is a pure function of (seed, K) ──
  var W_START = 75366, W_MIN = 40960;   // track width 4.6 narrowing to 2.5
  function widthAt(k) { return Math.max(W_MIN, W_START - k * 900); }
  function beamAt(k) { return Math.max(29491, 49152 - k * 600); }
  function coinLine(p, n, step, seed, k) {
    var fx = isin(p.yaw), fz = -icos(p.yaw), wv = (h32(seed, k, 90) % 3) - 1;
    for (var i = 0; i < n; i++) {
      var along = 3 * P + i * step;
      if (along > p.len - P) break;
      var lat = tdiv(wv * i * P, 2);
      lat = Math.max(-(p.w >> 1) + P, Math.min((p.w >> 1) - P, lat));
      if (p.split && lat > -(p.split >> 1) - P && lat < (p.split >> 1) + P) lat = lat < 0 ? -(p.split >> 1) - P : (p.split >> 1) + P;
      p.coins.push({ x: p.x0 + tdiv(fx * along - fz * lat, P), z: p.z0 + tdiv(fz * along + fx * lat, P), y: p.y0 + tdiv(p.dy * along, p.len) + COIN_Y, taken: 0 });
    }
  }
  // a coin at (along, lat) on a straight, `up` above the deck there
  function coinS(p, along, lat, up) {
    var fx = isin(p.yaw), fz = -icos(p.yaw), x = p.x0 + tdiv(fx * along - fz * lat, P), z = p.z0 + tdiv(fz * along + fx * lat, P);
    var mv = p.mv; p.mv = null; locate(p, x, z); p.mv = mv;
    p.coins.push({ x: x, z: z, y: Q.h + COIN_Y + up, taken: 0 });
  }
  // a coin on a bend, `along` units round it and `lat` across (positive = right)
  function coinA(p, along, lat) {
    var ang = p.a0 + p.sg * tdiv(along * 4194304, p.rc * 6434), rr = p.rc - p.sg * lat;
    var x = p.cx - p.sg * tdiv(icos(ang) * rr, P), z = p.cz - p.sg * tdiv(isin(ang) * rr, P);
    p.coins.push({ x: x, z: z, y: p.y0 + tdiv(p.dy * along, Math.max(1, p.L)) + COIN_Y, taken: 0 });
  }
  // which way to bend: keep the course heading roughly away from the start
  function turnSign(b, d) { var off = wrap(b.yaw, TURN); if (off > 700) return -1; if (off < -700) return 1; return (d & 1) ? 1 : -1; }
  function slopeSign(b) { return b.y < -8 * P ? 1 : b.y > 4 * P ? -1 : 0; }
  // the patches, with the section at which each one starts to appear
  // the patches by tier; how often each tier comes up depends on how far the run has got
  var TIER_EASY = [0, 1, 3, 4, 5, 8, 9, 10, 11, 12, 20, 23, 37, 42];
  var TIER_MED = [2, 6, 7, 13, 14, 15, 16, 17, 18, 19, 28, 29, 30, 31, 32, 33, 34, 38, 39, 40, 41, 44, 47, 51, 52, 53, 57];
  var TIER_HARD = [24, 25, 26, 27, 35, 36, 43, 45, 46, 48, 49, 50, 54, 55, 56];
  // combinations: two hazards at once, with no rest between them
  var TIER_COMBO = [58, 59, 60, 61, 62, 63, 64, 65];
  // per 100: [easy, medium, hard] (combinations are the rest), from section TIER_AT[i] on
  var TIER_AT = [0, 3, 7, 12, 18, 26], TIER_ODDS = [[100, 0, 0], [55, 45, 0], [25, 55, 20], [10, 50, 30], [5, 40, 35], [0, 30, 40]];
  function tierOf(kind) { return TIER_COMBO.indexOf(kind) >= 0 ? 4 : TIER_HARD.indexOf(kind) >= 0 ? 3 : TIER_MED.indexOf(kind) >= 0 ? 2 : 1; }
  // the shortest cycle any moving thing may have, in steps, however late the run
  var PER_MIN = 64, PER_MIN_SWEEP = 90;
  var SEC_MAZE = 7;
  function section(sim, k) {
    var b = sim.b, seed = sim.seed, d0 = h32(seed, k, 0), d1 = h32(seed, k, 1), d2 = h32(seed, k, 2), d3 = h32(seed, k, 3), d4 = h32(seed, k, 4);
    var w = widthAt(k), kind, n0 = sim.pieces.length, i, p;
    // obstacles quicken as the run goes on
    // (it keeps climbing to section 36, about where a good run is at three minutes)
    var quick = Math.max(0, Math.min(100, (k - 3) * 3));
    if (k === 0) kind = 0;
    else if (sim.forceKinds) kind = sim.forceKinds[(k - 1) % sim.forceKinds.length];   // testing only: a chosen sequence
    else if (k >= 9 && k % SEC_MAZE === 2) kind = [6, 21, 22][Math.floor(k / SEC_MAZE) % 3];
    else {
      var band = 0; for (i = 0; i < TIER_AT.length; i++) if (k >= TIER_AT[i]) band = i;
      var roll = d0 % 100, odds = TIER_ODDS[band];
      var menu = roll < odds[0] ? TIER_EASY : roll < odds[0] + odds[1] ? TIER_MED : roll < odds[0] + odds[1] + odds[2] ? TIER_HARD : TIER_COMBO;
      // a breather after two hard patches in a row
      if ((menu === TIER_HARD || menu === TIER_COMBO) && sim.hardRun >= 2) menu = TIER_EASY;
      kind = menu[(d0 >>> 8) % menu.length];
      // never the same patch twice running
      if (kind === sim.lastKind) kind = menu[((d0 >>> 8) + 1 + (d0 >>> 20) % (menu.length - 1)) % menu.length];
    }
    sim.hardRun = tierOf(kind) >= 3 ? (sim.hardRun || 0) + 1 : 0;
    sim.lastKind = kind;
    if (kind === 0) {           // a run with rails
      p = b.straight((k === 0 ? 18 : 12 + d1 % 10) * P, w, 0, 1, (k > 24 ? (d2 & 1) === 0 : k > 14 && (d2 & 3) === 0) ? 0 : 1);
      coinLine(p, 5, 3 * P, seed, k);
    } else if (kind === 1) {    // a walled bend, gently downhill
      b.arc(turnSign(b, d1) * (512 + d2 % 512), (9 + d3 % 6) * P, w, -(d4 % 3) * P, 2, 2);
    } else if (kind === 2) {    // a narrow beam, no walls
      p = b.straight((8 + d1 % 7) * P, Math.max(31130, 49152 - k * 500), -(d2 % 2) * P, 0, 0);
      coinLine(p, 3, 3 * P, seed, k);
    } else if (kind === 3) {    // an open bend: no walls at all
      p = b.arc(turnSign(b, d1) * (384 + d2 % 384), (12 + d3 % 5) * P, w, 0, 0, 0);
      // the outer edge pays
      for (i = 1; i <= 4; i++) coinA(p, tdiv(p.L * i, 5), -p.sg * ((p.w >> 1) - 9830));
    } else if (kind === 4) {    // a drop onto a lower track
      b.straight((6 + d1 % 4) * P, w, 0, 1, 1);
      b.gap(26214 + (d2 % 5) * 3277, (3 + d3 % 3) * P);
      p = b.straight(12 * P, W_START, 0, 1, 1);
      coinLine(p, 3, 3 * P, seed, k);
    } else if (kind === 5) {    // a climb or a descent between walls
      var sg = slopeSign(b) || ((d1 & 1) ? 1 : -1);
      p = b.straight((14 + d2 % 6) * P, w, sg * (P + (d3 % 3) * 8192), 2, 2);
      coinLine(p, 4, 3 * P, seed, k);
    } else if (kind === 6) {    // a spiral maze plate, out through the hole
      b.straight(6 * P, w, 0, 1, 1);
      b.plate();
      p = b.straight(12 * P, W_START, 0, 1, 1);
    } else if (kind === 7) {    // a swinging hammer over an open straight
      p = b.straight(16 * P, Math.max(w, 60000), 0, 0, 0);
      p.obs = [{ k: 'ham', along: 8 * P, amp: (p.w >> 1) + 4096, per: 150 - quick + d2 % 50, ph: d3 % TURN }];
      for (i = -1; i <= 1; i++) coinS(p, 8 * P + i * 24576, 0, 0);
    } else if (kind === 8) {    // a zig-zag of short walled bends
      var zs = turnSign(b, d1), n8 = 3 + (d2 & 1);
      for (i = 0; i < n8; i++) { b.arc(zs * 640, 7 * P, w, -(i & 1) * 8192, 2, 2); zs = -zs; }
    } else if (kind === 9) {    // an open S-bend
      var ss = turnSign(b, d1);
      var s1 = b.arc(ss * (448 + d2 % 192), 12 * P, w, 0, 0, 0), s2 = b.arc(-ss * (448 + d2 % 192), 12 * P, w, 0, 0, 0);
      for (i = 1; i <= 3; i++) { coinA(s1, tdiv(s1.L * i, 4), -s1.sg * ((s1.w >> 1) - 9830)); coinA(s2, tdiv(s2.L * i, 4), -s2.sg * ((s2.w >> 1) - 9830)); }
    } else if (kind === 10) {   // rollers: humps that throw a fast ball into the air
      var bL10 = (5 + d3 % 3) * P;
      p = b.straight(bL10 * Math.max(3, Math.round((16 + d1 % 8) * P / bL10)), w, 0, 1, 1); p.prof = 2; p.bA = 9830 + (d2 % 3) * 3277; p.bL = bL10;
      // coins high over the crests: only a fast ball gets airborne enough
      for (var cr = p.bL >> 1; cr < p.len - P; cr += p.bL) coinS(p, cr, 0, 0);
    } else if (kind === 11) {   // a half-pipe
      p = b.straight((16 + d1 % 8) * P, Math.max(w, 65536), -(d2 % 3) * P, 1, 1); p.prof = 1;
      // coins ride high up one wall of the pipe
      var hsd = (d3 & 1) ? 1 : -1;
      for (i = 0; i < 6; i++) coinS(p, 3 * P + i * 40960, hsd * ((p.w >> 1) - 21299), 0);
    } else if (kind === 12) {   // stairs down
      var n12 = 4 + d1 % 3;
      for (i = 0; i < n12; i++) { b.straight(4 * P, w, 0, 1, 1); b.gap(0, 9830); }
      b.straight(6 * P, w, 0, 1, 1);
    } else if (kind === 13) {   // two lanes with a gap between them
      p = b.straight((14 + d1 % 6) * P, Math.max(w, 72090), 0, 0, 0); p.split = Math.min(32768, 16384 + k * 300);
      // one lane's outer edge pays
      var lsd = (d3 & 1) ? 1 : -1;
      for (i = 0; i < 5; i++) coinS(p, 3 * P + i * 40960, lsd * ((p.w >> 1) - 11469), 0);
    } else if (kind === 14) {   // a sweeper bar turning across the track
      p = b.straight(16 * P, Math.max(w, 65536), 0, 1, 1);
      p.obs = [{ k: 'sweep', along: 8 * P, lat: 0, len: (p.w >> 1) - 6554, per: 200 - quick * 2 + d2 % 60, ph: d3 % TURN, dir: (d4 & 1) ? 1 : -1 }];
      coinS(p, 8 * P - 26214, 0, 0); coinS(p, 8 * P + 26214, 0, 0); coinS(p, 8 * P, 26214, 0); coinS(p, 8 * P, -26214, 0);
    } else if (kind === 15) {   // blocks sliding across
      p = b.straight(18 * P, Math.max(w, 60000), 0, 1, 1);
      p.obs = [];
      for (i = 0; i < 2; i++) { p.obs.push({ k: 'slide', along: (6 + i * 6) * P, ha: 9830, hl: 9830, amp: (p.w >> 1) - 9830 - 4096, per: 160 - quick + h32(seed, k, 20 + i) % 60, ph: h32(seed, k, 30 + i) % 160 }); coinS(p, (6 + i * 6) * P, 0, 0); }
    } else if (kind === 16) {   // gates that close and open
      p = b.straight(18 * P, w, 0, 2, 2);
      p.obs = [];
      for (i = 0; i < 2; i++) { p.obs.push({ k: 'gate', along: (6 + i * 7) * P, ha: 4915, gmin: 4096, gmax: p.w - 2 * 6554, per: 170 - quick + h32(seed, k, 20 + i) % 50, ph: h32(seed, k, 30 + i) % 170 }); coinS(p, (6 + i * 7) * P, 0, 0); }
    } else if (kind === 17) {   // pushers that shove from the sides of an open straight
      p = b.straight(20 * P, Math.max(w, 60000), 0, 0, 0);
      p.obs = [];
      for (i = 0; i < 3; i++) { p.obs.push({ k: 'push', along: (5 + i * 5) * P, ha: 8192, hl: 16384, side: (i & 1) ? 1 : -1, ext: (p.w >> 1) + 4096, per: 150 - quick + h32(seed, k, 20 + i) % 40, ph: h32(seed, k, 30 + i) % 150 }); coinS(p, (5 + i * 5) * P, ((i & 1) ? 1 : -1) * ((p.w >> 1) - 13107), 0); }
    } else if (kind === 18) {   // a moving platform across two gaps
      b.straight(6 * P, w, 0, 1, 1);
      b.gap(6554, 4096);
      p = b.straight(7 * P, 60000, 0, 0, 0); p.mv = { amp: 2 * P, per: 210 - quick + d2 % 60, ph: d3 % TURN };
      coinS(p, 3 * P, 0, 0); coinS(p, 5 * P, 0, 0);
      b.gap(6554, 4096);
      b.straight(10 * P, W_START, 0, 1, 1);
    } else if (kind === 19) {   // a slalom of posts
      p = b.straight((16 + d1 % 6) * P, w, 0, 0, 0);
      p.obs = [];
      for (i = 0; i < 4; i++) {
        var plat = ((i & 1) ? 1 : -1) * ((p.w >> 2) - 2048);
        p.obs.push({ k: 'post', along: (4 + i * 3) * P, lat: plat, r: 8192 });
        // a coin tucked in beside each post
        coinS(p, (4 + i * 3) * P, plat - ((i & 1) ? 1 : -1) * 21299, 0);
      }
    } else if (kind === 20) {   // a speed pad, then a jump pad over a gap
      p = b.straight(14 * P, w, 0, 1, 1);
      p.pads = [{ k: 'speed', a0: 4 * P, a1: 7 * P }, { k: 'jump', a0: 12 * P, a1: 13 * P }];
      // coins along the flight
      for (i = 1; i <= 5; i++) { var tt = i * 8; coinS(p, 12 * P + 8192 + 3600 * tt, 0, 3300 * tt - tdiv(145 * tt * (tt + 1), 2)); }
      b.gap((5 + d2 % 2) * P, 2 * P);
      p = b.straight(12 * P, W_START, 0, 1, 1);
      coinLine(p, 3, 3 * P, seed, k);
    } else if (kind === 21) {   // a square maze
      b.straight(5 * P, 49152, 0, 1, 1);
      b.rect(3, 3 + (d1 & 1), 0, seed, k);
      b.straight(8 * P, 49152, 0, 1, 1);
    } else if (kind === 22) {   // a zig-zag maze
      b.straight(5 * P, 49152, 0, 1, 1);
      b.rect(3, 4, 1, seed, k);
      b.straight(8 * P, 49152, 0, 1, 1);
    } else if (kind === 24) {   // a hammer over a narrow open beam
      p = b.straight(16 * P, beamAt(k), 0, 0, 0);
      p.obs = [{ k: 'ham', along: 8 * P, amp: (p.w >> 1) + 6554, per: 140 - (quick >> 1) + d2 % 40, ph: d3 % TURN }];
      for (i = -1; i <= 1; i++) coinS(p, 8 * P + i * 24576, 0, 0);
    } else if (kind === 25) {   // two hammers swinging against each other
      p = b.straight(20 * P, Math.max(w, 60000), 0, 0, 0);
      var hp = 150 - quick + d2 % 40, hph = d3 % TURN;
      p.obs = [{ k: 'ham', along: 7 * P, amp: (p.w >> 1) + 4096, per: hp, ph: hph }, { k: 'ham', along: 13 * P, amp: (p.w >> 1) + 4096, per: hp, ph: hph + 2048 }];
      coinS(p, 7 * P, 0, 0); coinS(p, 13 * P, 0, 0); coinS(p, 10 * P, 0, 0);
    } else if (kind === 26) {   // gates on a downhill run
      p = b.straight(20 * P, w, -2 * P, 2, 2);
      p.obs = [];
      for (i = 0; i < 3; i++) { p.obs.push({ k: 'gate', along: (5 + i * 6) * P, ha: 4915, gmin: 4096, gmax: p.w - 2 * 6554, per: 150 - quick + h32(seed, k, 20 + i) % 50, ph: h32(seed, k, 30 + i) % 150 }); coinS(p, (5 + i * 6) * P, 0, 0); }
    } else if (kind === 27) {   // a sweeper over split lanes
      p = b.straight(18 * P, Math.max(w, 72090), 0, 0, 0); p.split = Math.min(29491, 16384 + k * 300);
      p.obs = [{ k: 'sweep', along: 9 * P, lat: 0, len: (p.w >> 1) - 4096, per: 220 - quick * 2 + d2 % 50, ph: d3 % TURN, dir: (d4 & 1) ? 1 : -1 }];
      var ls2 = (d3 & 1) ? 1 : -1;
      for (i = 0; i < 5; i++) coinS(p, 3 * P + i * 49152, ls2 * ((p.w >> 1) - 11469), 0);
    } else if (kind === 28) {   // a field of holes: one per row, never two rows alike
      p = b.straight(20 * P, Math.max(w, 72090), 0, 1, 1); p.holes = [];
      var hcol = d2 % 3, third = tdiv(p.w, 3), hw2 = p.w >> 1;
      for (i = 0; i < 4; i++) {
        var ha = (4 + i * 4) * P;
        p.holes.push(ha, ha + 26214, -hw2 + hcol * third, -hw2 + (hcol + 1) * third);
        coinS(p, ha + 13107, -hw2 + hcol * third + (third >> 1), 13107);
        hcol = (hcol + 1 + (h32(seed, k, 60 + i) & 1)) % 3;
      }
    } else if (kind === 29) {   // stepping stones: keep your speed up or drop between them
      var nst = 4 + d1 % 3, sd = (d2 & 1) ? 1 : -1;
      b.straight(5 * P, w, 0, 1, 1);
      for (i = 0; i < nst; i++) {
        b.gap(9830, 0); b.shift(sd * 14746); sd = -sd;
        p = b.straight(3 * P, 40960, 0, 0, 0); coinS(p, 24576, 0, 0);
      }
      b.gap(9830, 0);
      b.straight(8 * P, W_START, 0, 1, 1);
    } else if (kind === 30) {   // tiles that drop away a moment after you touch them
      var nf = 5 + d1 % 3;
      for (i = 0; i < nf; i++) { p = b.straight(3 * P, w, 0, 0, 0); p.fall = Math.max(48, 80 - quick); coinS(p, 24576, ((i & 1) ? 1 : -1) * ((p.w >> 2)), 0); }
      b.straight(8 * P, W_START, 0, 1, 1);
    } else if (kind === 31) {   // an icy run, downhill, open edges
      p = b.straight(18 * P, Math.max(w, 60000), -P, 0, 0); p.ice = 1;
      for (i = 0; i < 5; i++) coinS(p, (3 + i * 3) * P, ((i & 1) ? 1 : -1) * ((p.w >> 1) - 13107), 0);
    } else if (kind === 32) {   // a belt running the wrong way
      p = b.straight(18 * P, w, 0, 2, 2);
      p.pads = [{ k: 'belt', a0: 0, a1: p.len, v: -Math.min(2100, 1000 + k * 25) }];
      coinLine(p, 5, 3 * P, seed, k);
    } else if (kind === 33) {   // gusts across an open straight
      p = b.straight(20 * P, w, 0, 0, 0); p.pads = [];
      var wd = (d2 & 1) ? 1 : -1, wv = Math.min(1200, 450 + k * 15);
      for (i = 0; i < 3; i++) { p.pads.push({ k: 'wind', a0: (3 + i * 5) * P, a1: (6 + i * 5) * P, v: wd * wv }); wd = -wd; }
      for (i = 0; i < 3; i++) coinS(p, (4.5 + i * 5) * P, ((i & 1) ? -1 : 1) * (d2 & 1 ? 1 : -1) * ((p.w >> 1) - 11469), 0);
    } else if (kind === 34) {   // a deck tilting side to side
      p = b.straight(18 * P, Math.max(w, 60000), 0, 0, 0);
      p.tilt = { amp: 3800 + Math.min(2400, k * 60), per: 220 - quick + d2 % 60, ph: d3 % TURN };
      coinLine(p, 5, 3 * P, seed, k);
    } else if (kind === 35) {   // pistons: steps that rise and sink in a wave
      b.straight(5 * P, w, 0, 1, 1);
      var pp = 170 - quick + d2 % 40;
      for (i = 0; i < 4; i++) { p = b.straight(3 * P, w, 0, 1, 1); p.mvY = { amp: 13107, per: pp, ph: (d3 + i * 900) % TURN }; coinS(p, 24576, 0, 4096); }
      b.straight(8 * P, W_START, 0, 1, 1);
    } else if (kind === 36) {   // a bridge sliding back and forth over a gap
      b.straight(6 * P, w, 0, 1, 1);
      var amp = 22938, mp = 200 - quick + d2 % 50;
      b.gap(amp - 3277, 0);
      p = b.straight(5 * P, 49152, 0, 0, 0); p.mvA = { amp: amp, per: mp, ph: d3 % TURN }; coinS(p, 40960, 0, 0);
      b.gap(amp - 3277, 0);
      b.straight(10 * P, W_START, 0, 1, 1);
    } else if (kind === 37) {   // a funnel: wide to narrow, no walls
      p = b.straight(16 * P, 81920, -P, 0, 0); p.w1 = 37683;
      for (i = 0; i < 4; i++) coinS(p, (4 + i * 3) * P, 0, 0);
    } else if (kind === 38) {   // a banked bend, open, fast
      p = b.arc(turnSign(b, d1) * (1024 + d2 % 512), (10 + d3 % 4) * P, Math.max(w, 60000), -2 * P, 0, 0); p.bank = 22938;
      for (i = 1; i <= 4; i++) coinA(p, tdiv(p.L * i, 5), -p.sg * ((p.w >> 1) - 11469));
    } else if (kind === 39) {   // a turning cross between walls
      p = b.straight(18 * P, Math.max(w, 65536), 0, 2, 2);
      p.obs = [{ k: 'sweep', along: 9 * P, lat: 0, len: (p.w >> 1) - 6554, per: 260 - quick * 2 + d2 % 60, ph: d3 % TURN, dir: (d4 & 1) ? 1 : -1, arms: 2 }];
      coinS(p, 9 * P - 26214, 26214, 0); coinS(p, 9 * P + 26214, -26214, 0);
    } else if (kind === 40) {   // bumpers that bat the ball away
      p = b.straight(18 * P, 78643, 0, 1, 1); p.obs = [];
      for (i = 0; i < 5; i++) { var bl2 = ((i & 1) ? 1 : -1) * (((h32(seed, k, 70 + i) % 3) * 8192) + 4096); p.obs.push({ k: 'bump', along: (3 + i * 3) * P, lat: bl2, r: 9830 }); coinS(p, (3 + i * 3) * P, bl2 > 0 ? bl2 - 24576 : bl2 + 24576, 0); }
    } else if (kind === 41) {   // a turning disc
      b.straight(5 * P, w, 0, 1, 1);
      p = b.disc(5 * P, ((d2 & 1) ? 1 : -1) * Math.min(300, 150 + k * 6));
      b.straight(8 * P, W_START, 0, 1, 1);
    } else if (kind === 42) {   // a kicker: up the ramp and over the gap
      p = b.straight(8 * P, w, 0, 1, 1); p.pads = [{ k: 'speed', a0: 2 * P, a1: 5 * P }];
      p = b.straight(3 * P, w, P, 1, 1);
      b.gap(3 * P, 2 * P);
      // coins on the flight path a ball off the ramp actually takes (centre heights measured)
      for (i = 1; i <= 3; i++) { coinS(p, p.len + i * 16384, 0, 0); p.coins[p.coins.length - 1].y = p.y0 + p.dy + [12124, 12780, 9994][i - 1]; }
      b.straight(12 * P, W_START, 0, 1, 1);
    } else if (kind === 43) {   // three hammers between walls
      p = b.straight(22 * P, w, 0, 2, 2); p.obs = [];
      for (i = 0; i < 3; i++) { p.obs.push({ k: 'ham', along: (6 + i * 5) * P, amp: (p.w >> 1) + 4096, per: 150 - quick + d2 % 30, ph: (d3 + i * 1365) % TURN }); coinS(p, (6 + i * 5) * P, 0, 0); }
    } else if (kind === 44) {   // a forest of posts
      p = b.straight(20 * P, Math.max(w, 72090), 0, 1, 1); p.obs = [];
      var q4 = p.w >> 2;
      for (i = 0; i < 6; i++) {
        var free = h32(seed, k, 80 + i) % 4, put = 0;
        for (var sl2 = 0; sl2 < 4 && put < 2; sl2++) if (sl2 !== free && sl2 !== (free + 2) % 4) { p.obs.push({ k: 'post', along: (3 + i * 3) * P, lat: -(p.w >> 1) + q4 * sl2 + (q4 >> 1), r: 6554 }); put++; }
        coinS(p, (3 + i * 3) * P, -(p.w >> 1) + q4 * free + (q4 >> 1), 0);
      }
    } else if (kind === 45) {   // sliding blocks over holes
      p = b.straight(18 * P, Math.max(w, 65536), 0, 1, 1); p.obs = []; p.holes = [];
      for (i = 0; i < 2; i++) { p.obs.push({ k: 'slide', along: (5 + i * 7) * P, ha: 9830, hl: 9830, amp: (p.w >> 1) - 9830 - 4096, per: 140 - quick + h32(seed, k, 20 + i) % 50, ph: h32(seed, k, 30 + i) % 140 }); coinS(p, (5 + i * 7) * P, 0, 0); }
      var hs2 = (d2 & 1) ? 1 : -1; p.holes.push(8 * P, 10 * P, hs2 > 0 ? 0 : -(p.w >> 1), hs2 > 0 ? (p.w >> 1) : 0);
    } else if (kind === 46) {   // narrow zig-zag, no walls
      var zz = turnSign(b, d1), nz = 3 + (d2 & 1);
      for (i = 0; i < nz; i++) { p = b.arc(zz * 576, 8 * P, beamAt(k), -(i & 1) * 4096, 0, 0); coinA(p, p.L >> 1, 0); zz = -zz; }
    } else if (kind === 47) {   // a belt that helps, to a jump over a gap
      p = b.straight(16 * P, w, 0, 2, 2);
      p.pads = [{ k: 'belt', a0: 0, a1: 12 * P, v: 1300 }, { k: 'jump', a0: 14 * P, a1: 15 * P }];
      b.gap((5 + d2 % 2) * P, 2 * P);
      for (i = 1; i <= 5; i++) { var tj = i * 8; coinS(p, 14 * P + 8192 + 3600 * tj, 0, 3300 * tj - tdiv(145 * tj * (tj + 1), 2)); }
      b.straight(12 * P, W_START, 0, 1, 1);
    } else if (kind === 48) {   // two moving platforms in a row
      b.straight(6 * P, w, 0, 1, 1);
      // a quarter turn apart: the two platforms always overlap somewhere
      var m1 = 220 - quick + d2 % 50;
      for (i = 0; i < 2; i++) { b.gap(6554, 4096); p = b.straight(6 * P, 57344, 0, 0, 0); p.mv = { amp: Math.min(2 * P, 22938 + k * 300), per: m1, ph: (d3 + i * 1024) % TURN }; coinS(p, 3 * P, 0, 0); }
      b.gap(6554, 4096);
      b.straight(10 * P, W_START, 0, 1, 1);
    } else if (kind === 49) {   // gates on a narrow beam
      p = b.straight(18 * P, Math.max(49152, beamAt(k) + 8192), 0, 2, 2); p.obs = [];
      for (i = 0; i < 3; i++) { p.obs.push({ k: 'gate', along: (4 + i * 6) * P, ha: 4915, gmin: 2048, gmax: p.w - 2 * 6554, per: 130 - (quick >> 1) + h32(seed, k, 20 + i) % 40, ph: h32(seed, k, 30 + i) % 130 }); coinS(p, (4 + i * 6) * P, 0, 0); }
    } else if (kind === 50) {   // pushers over holes
      p = b.straight(20 * P, Math.max(w, 60000), 0, 0, 0); p.obs = []; p.holes = [];
      for (i = 0; i < 3; i++) {
        var sd3 = (i & 1) ? 1 : -1;
        p.obs.push({ k: 'push', along: (5 + i * 5) * P, ha: 8192, hl: 16384, side: sd3, ext: (p.w >> 1) + 4096, per: 140 - quick + h32(seed, k, 20 + i) % 40, ph: h32(seed, k, 30 + i) % 140 });
        p.holes.push((7 + i * 5) * P, (8 + i * 5) * P, sd3 > 0 ? -(p.w >> 1) : (p.w >> 2), sd3 > 0 ? -(p.w >> 2) : (p.w >> 1));
        coinS(p, (5 + i * 5) * P, sd3 * ((p.w >> 1) - 13107), 0);
      }
    } else if (kind === 51) {   // rollers on a narrow open deck
      var bL51 = (5 + d3 % 2) * P;
      p = b.straight(bL51 * Math.max(3, Math.round((18 + d1 % 6) * P / bL51)), Math.max(49152, w - 8192), 0, 0, 0); p.prof = 2; p.bA = 13107; p.bL = bL51;
      for (var cr2 = p.bL >> 1; cr2 < p.len - P; cr2 += p.bL) coinS(p, cr2, 0, 0);
    } else if (kind === 52) {   // a half-pipe with posts down the middle: ride the walls
      p = b.straight(20 * P, 81920, -P, 1, 1); p.prof = 1; p.obs = [];
      for (i = 0; i < 3; i++) p.obs.push({ k: 'post', along: (5 + i * 5) * P, lat: 0, r: 8192 });
      var hs3 = (d3 & 1) ? 1 : -1;
      for (i = 0; i < 6; i++) coinS(p, 3 * P + i * 45875, (((i >> 1) & 1) ? 1 : -1) * hs3 * ((p.w >> 1) - 21299), 0);
    } else if (kind === 53) {   // split lanes with holes: switch lanes in time
      // one wide deck; the holes take the left half, then the right: weave between them
      p = b.straight(24 * P, Math.max(w, 72090), 0, 1, 1); p.holes = [];
      var ln = (d2 & 1) ? 1 : -1, hw3 = p.w >> 1;
      for (i = 0; i < 4; i++) { var ha3 = (4 + i * 5) * P; p.holes.push(ha3, ha3 + 2 * P, ln > 0 ? 1638 : -hw3, ln > 0 ? hw3 : -1638); coinS(p, ha3 + P, -ln * (hw3 >> 1), 0); ln = -ln; }
    } else if (kind === 54) {   // pistons over ice
      b.straight(5 * P, w, 0, 1, 1);
      var pp2 = 150 - quick + d2 % 40;
      for (i = 0; i < 5; i++) { p = b.straight(3 * P, w, 0, 0, 0); p.ice = 1; p.mvY = { amp: 13107, per: pp2, ph: (d3 + i * 820) % TURN }; coinS(p, 24576, 0, 4096); }
      b.straight(8 * P, W_START, 0, 1, 1);
    } else if (kind === 55) {   // an open helix down, no walls
      var hs4 = turnSign(b, d1);
      p = b.arc(hs4 * 2048, 9 * P, w, -3 * P, 0, 0); p.bank = 13107;
      p = b.arc(hs4 * 1536, 9 * P, w, -2 * P, 0, 0); p.bank = 13107;
    } else if (kind === 56) {   // a tilting deck with a hammer over it
      p = b.straight(18 * P, Math.max(w, 60000), 0, 0, 0);
      p.tilt = { amp: 3200, per: 240 - quick + d2 % 60, ph: d3 % TURN };
      p.obs = [{ k: 'ham', along: 9 * P, amp: (p.w >> 1) + 4096, per: 160 - quick + d4 % 40, ph: d2 % TURN }];
      for (i = -1; i <= 1; i++) coinS(p, 9 * P + i * 24576, 0, 0);
    } else if (kind === 57) {   // an icy bend, open edges
      p = b.arc(turnSign(b, d1) * (768 + d2 % 384), (12 + d3 % 4) * P, Math.max(w, 60000), -P, 0, 0); p.ice = 1; p.bank = 9830;
      for (i = 1; i <= 4; i++) coinA(p, tdiv(p.L * i, 5), -p.sg * ((p.w >> 1) - 11469));
    } else if (kind === 58) {   // gates with holes between them
      p = b.straight(20 * P, Math.max(w, 65536), 0, 2, 2); p.obs = []; p.holes = [];
      var gs = (d2 & 1) ? 1 : -1, hw5 = p.w >> 1;
      for (i = 0; i < 3; i++) { p.obs.push({ k: 'gate', along: (4 + i * 6) * P, ha: 4915, gmin: 4096, gmax: p.w - 2 * 6554, per: 150 - quick + h32(seed, k, 20 + i) % 50, ph: h32(seed, k, 30 + i) % 150 }); coinS(p, (4 + i * 6) * P, 0, 0); }
      for (i = 0; i < 2; i++) { var hg = (6 + i * 6) * P; p.holes.push(hg + 8192, hg + 3 * P - 8192, gs > 0 ? 0 : -hw5, gs > 0 ? hw5 : 0); coinS(p, hg + 3 * P / 2, -gs * (hw5 >> 1), 0); gs = -gs; }
    } else if (kind === 59) {   // an icy narrow beam, downhill
      p = b.straight((10 + d1 % 5) * P, beamAt(k) + 4096, -P, 0, 0); p.ice = 1;
      coinLine(p, 3, 3 * P, seed, k);
    } else if (kind === 60) {   // two hammers over ice
      p = b.straight(20 * P, Math.max(w, 60000), 0, 1, 1); p.ice = 1;
      var hp6 = 160 - quick + d2 % 40, hph6 = d3 % TURN;
      p.obs = [{ k: 'ham', along: 7 * P, amp: (p.w >> 1) + 4096, per: hp6, ph: hph6 }, { k: 'ham', along: 14 * P, amp: (p.w >> 1) + 4096, per: hp6, ph: hph6 + 1536 }];
      coinS(p, 7 * P, 0, 0); coinS(p, 14 * P, 0, 0);
    } else if (kind === 61) {   // pushers along a narrow open deck
      p = b.straight(18 * P, Math.max(45875, beamAt(k) + 16384), 0, 0, 0); p.obs = [];
      for (i = 0; i < 3; i++) { p.obs.push({ k: 'push', along: (4 + i * 5) * P, ha: 8192, hl: 13107, side: (i & 1) ? 1 : -1, ext: (p.w >> 1) + 4096, per: 160 - quick + h32(seed, k, 20 + i) % 40, ph: h32(seed, k, 30 + i) % 160 }); coinS(p, (4 + i * 5) * P + 2 * P, 0, 0); }
    } else if (kind === 62) {   // a sweeper with holes before and after it
      p = b.straight(20 * P, Math.max(w, 65536), 0, 1, 1); p.holes = [];
      p.obs = [{ k: 'sweep', along: 10 * P, lat: 0, len: (p.w >> 1) - 6554, per: 220 - quick * 2 + d2 % 60, ph: d3 % TURN, dir: (d4 & 1) ? 1 : -1 }];
      var hs6 = (d2 & 1) ? 1 : -1, hw6 = p.w >> 1;
      p.holes.push(4 * P, 6 * P, hs6 > 0 ? 0 : -hw6, hs6 > 0 ? hw6 : 0, 14 * P, 16 * P, hs6 > 0 ? -hw6 : 0, hs6 > 0 ? 0 : hw6);
      coinS(p, 5 * P, -hs6 * (hw6 >> 1), 0); coinS(p, 15 * P, hs6 * (hw6 >> 1), 0); coinS(p, 10 * P - 26214, 0, 0);
    } else if (kind === 63) {   // sliding blocks on ice
      p = b.straight(18 * P, Math.max(w, 60000), 0, 1, 1); p.ice = 1; p.obs = [];
      for (i = 0; i < 2; i++) { p.obs.push({ k: 'slide', along: (6 + i * 6) * P, ha: 9830, hl: 9830, amp: (p.w >> 1) - 9830 - 4096, per: 160 - quick + h32(seed, k, 20 + i) % 60, ph: h32(seed, k, 30 + i) % 160 }); coinS(p, (6 + i * 6) * P, 0, 0); }
    } else if (kind === 64) {   // a narrow deck tilting side to side
      p = b.straight(16 * P, Math.max(45875, beamAt(k) + 12288), 0, 0, 0);
      p.tilt = { amp: 3200, per: 220 - quick + d2 % 60, ph: d3 % TURN };
      coinLine(p, 4, 3 * P, seed, k);
    } else if (kind === 65) {   // a post slalom over holes: each hole opens on the side of the post before it
      p = b.straight(20 * P, Math.max(w, 65536), 0, 1, 1); p.obs = []; p.holes = [];
      var ps7 = (d2 & 1) ? 1 : -1, q7 = p.w >> 2, hw7 = p.w >> 1;
      for (i = 0; i < 4; i++) {
        p.obs.push({ k: 'post', along: (3 + i * 4) * P, lat: ps7 * (q7 - 2048), r: 8192 });
        if (i < 3) { var ha7 = (5 + i * 4) * P; p.holes.push(ha7, ha7 + 26214, ps7 > 0 ? (hw7 >> 1) - 4096 : -hw7, ps7 > 0 ? hw7 : -(hw7 >> 1) + 4096); }
        coinS(p, (3 + i * 4) * P, -ps7 * (q7 + 4096), 0);
        ps7 = -ps7;
      }
    } else {                    // kind 23: a helix down
      var hs = turnSign(b, d1);
      b.arc(hs * 2048, 8 * P, w, -3 * P, 2, 2); b.arc(hs * 1536, 8 * P, w, -2 * P, 2, 2);
    }
    // nothing moves faster than a hand can follow, however late the run
    for (i = n0; i < sim.pieces.length; i++) {
      var pc = sim.pieces[i];
      if (pc.obs) for (var oi = 0; oi < pc.obs.length; oi++) if (pc.obs[oi].per) pc.obs[oi].per = Math.max(pc.obs[oi].k === 'sweep' ? PER_MIN_SWEEP : PER_MIN, pc.obs[oi].per);
      if (pc.mv) pc.mv.per = Math.max(PER_MIN, pc.mv.per); if (pc.mvA) pc.mvA.per = Math.max(PER_MIN, pc.mvA.per);
      if (pc.mvY) pc.mvY.per = Math.max(PER_MIN, pc.mvY.per); if (pc.tilt) pc.tilt.per = Math.max(PER_MIN, pc.tilt.per);
    }
    for (i = n0; i < sim.pieces.length; i++) { sim.pieces[i].sec = k; sim.pieces[i].kind = kind; sim.pieces[i].world = Math.floor(k / SEC_PER_WORLD); }
  }
  function extend(sim) {
    while (sim.pieces.length < sim.pi + 9) { section(sim, sim.k); sim.k++; }
  }
  function courseEndless(b, sim) { sim.crumble = true; extend(sim); }

  function initSim(seed, course, version) {
    var sim = {
      seed: seed >>> 0, frames: 0, pieces: [], pi: 0,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, gr: true, psi: 0,
      dead: false, best: 0, coins: 0, score: 0, airFrames: 0,
      evWall: 0, evLand: 0, evCoin: 0, evFall: 0,
      front: FRONT_START, fv: FRONT_V0, heat: 0, mult: 1, pts: 0, bonus: 0
    };
    // the swipe's numbers follow the version the run was recorded under
    sim.version = version >= 3 ? 3 : 2;
    sim.kf2 = sim.version >= 3 ? KF2_V3 : KF2; sim.kv = sim.version >= 3 ? KV_V3 : KV; sim.vmax = sim.version >= 3 ? VMAX_V3 : VMAX;
    var b = new Builder(sim);
    sim.b = b; sim.k = 0; sim.lastKind = -1; sim.crumble = false; sim.evHit = 0;
    course(b, sim);
    var p0 = sim.pieces[0];
    locate(p0, p0.x0, p0.z0);
    sim.x = p0.x0 + tdiv(isin(p0.yaw) * 3 * P, P); sim.z = p0.z0 + tdiv(-icos(p0.yaw) * 3 * P, P);
    sim.y = p0.y0; sim.psi = p0.yaw * 16;
    return sim;
  }

  // one fixed step. sx, sy: the finger's movement this step (see IN_MAX)
  function stepSim(sim, sx, sy) {
    if (sim.dead) return;
    sim.frames++;
    sim.evWall = 0; sim.evLand = 0; sim.evCoin = 0; sim.evFall = 0; sim.evHit = 0; sim.evPad = 0; sim.evJump = 0;
    sim.evNear = 0; sim.evAir = 0; sim.evMult = 0; sim.evWind = 0;
    if (sim.crumble) extend(sim);
    sx = Math.max(-IN_MAX, Math.min(IN_MAX, sx | 0)); sy = Math.max(-IN_MAX, Math.min(IN_MAX, sy | 0));
    var yPrev = sim.y;
    if (sim.gr) {
      var cp = isin(sim.psi >> 4), cq = icos(sim.psi >> 4);
      // velocity in the camera's frame: forward = (sin, -cos), right = (cos, sin)
      var vf = tdiv(sim.vx * cp - sim.vz * cq, P), vl = tdiv(sim.vx * cq + sim.vz * cp, P);
      if (sy > 0) {
        var top = Math.max(vf, Math.min(sim.vmax, VMAX_LO + sy * sim.kv));
        vf = Math.min(top, vf + tdiv(sy * KF + Math.max(0, sy - FLICK) * sim.kf2, 100));
      }
      else if (sy < 0) { var floor = Math.min(vf, -VREV); vf = Math.max(floor, vf + tdiv(sy * KB, 100)); }
      var icy = sim.pieces[sim.pi].ice;
      if (sx !== 0) { var lt = Math.max(Math.abs(vl), VLMAX); vl = Math.max(-lt, Math.min(lt, vl + tdiv(sx * (icy ? KL_ICE : KL), 100))); }
      vl -= tdiv(vl * (icy ? LAT_ICE : LAT_D), 4096);
      vf -= tdiv(vf * COAST, 4096);
      sim.vx = tdiv(vf * cp + vl * cq, P); sim.vz = tdiv(-vf * cq + vl * cp, P);
      if (support(sim, sim.x, sim.z, sim.y + UPTOL)) {
        var a = tdiv(-G_SLOPE * S.slope, 4096), al = tdiv(-G_SLOPE * S.lslope, 4096);
        sim.vx += tdiv(a * S.tx + al * S.nx, P); sim.vz += tdiv(a * S.tz + al * S.nz, P);
        // a moving platform carries the ball with it
        if (S.p.mv) { var dm = mvOff(sim, S.p, sim.frames) - mvOff(sim, S.p, sim.frames - 1); sim.x += tdiv(dm * S.nx, P); sim.z += tdiv(dm * S.nz, P); }
        if (S.p.mvA) { var da = osc(S.p.mvA, sim.frames) - osc(S.p.mvA, sim.frames - 1); sim.x += tdiv(da * S.tx, P); sim.z += tdiv(da * S.tz, P); }
        // a turning disc carries the ball round its centre
        if (S.p.t === 'D') {
          var dpx = sim.x - S.p.cx, dpz = sim.z - S.p.cz, dA = discAng(S.p, sim.frames) - discAng(S.p, sim.frames - 1), cA = icos(dA), sA = isin(dA);
          sim.x = S.p.cx + tdiv(dpx * cA - dpz * sA, P); sim.z = S.p.cz + tdiv(dpx * sA + dpz * cA, P);
        }
        pads(sim, S.p);
      }
    } else {
      sim.vy -= G_FALL;
    }
    // move in two halves, walls after each
    var hx = tdiv(sim.vx, 2), hz = tdiv(sim.vz, 2);
    sim.x += hx; sim.z += hz; walls(sim);
    sim.x += sim.vx - hx; sim.z += sim.vz - hz; walls(sim);
    // height
    if (sim.gr) {
      if (support(sim, sim.x, sim.z, sim.y + UPTOL) && S.h >= sim.y - DOWNTOL) {
        sim.vy = S.h - sim.y; sim.y = S.h; sim.pi = S.p.idx;
        if (!S.p.enter) S.p.enter = sim.frames;
      } else {
        sim.gr = false; sim.evFall = 1; sim.airFrames = 0;
        sim.leftFront = sim.crumble && sim.lastS - sim.front < BR * 3;
        sim.y += sim.vy;
      }
    } else {
      sim.airFrames++;
      sim.y += sim.vy;
      if (support(sim, sim.x, sim.z, yPrev + UPTOL) && sim.y <= S.h) {
        sim.y = S.h; sim.pi = S.p.idx;
        if (!S.p.enter) S.p.enter = sim.frames;
        sim.evLand = -sim.vy;
        // time in the air pays, if it was real air
        if (sim.airFrames >= AIR_MIN) { var ap = tdiv(sim.airFrames, AIR_DIV) * sim.mult; sim.bonus += ap; sim.evAir = ap; }
        sim.airFrames = 0;
        if (sim.vy < -BOUNCE_V) { sim.vy = tdiv(-sim.vy * 22, 100); }
        else { sim.vy = 0; sim.gr = true; }
      }
    }
    // down a plate's hole: the tube keeps the ball in the middle
    var cur = sim.pieces[sim.pi];
    for (var j = Math.max(0, sim.pi - 1); j <= Math.min(sim.pieces.length - 1, sim.pi + 1); j++) {
      var pl = sim.pieces[j];
      if (pl.t !== 'P' || sim.gr || sim.y >= pl.y0) continue;
      var dx = sim.x - pl.cx, dz = sim.z - pl.cz, rr = isqrt(dx * dx + dz * dz), lim = pl.hole - BR;
      if (rr < pl.hole + BR && sim.y > pl.y0 - PLATE_DROP + 2 * P) {
        if (rr > lim && rr > 0) { sim.x = pl.cx + tdiv(dx * lim, rr); sim.z = pl.cz + tdiv(dz * lim, rr); }
        sim.vx -= tdiv(sim.vx * 12, 100); sim.vz -= tdiv(sim.vz * 12, 100);
        if (sim.pi < pl.idx + 1) sim.pi = pl.idx + 1;
      }
    }
    // the camera heading follows the ball's motion, gently
    var hs = isqrt(sim.vx * sim.vx + sim.vz * sim.vz);
    if (sim.gr && hs > PSI_VMIN) {
      var target = iatan2(sim.vx, -sim.vz) * 16, d = wrap(target - sim.psi, PSI_TURN);
      var st = tdiv(d * Math.min(hs, PSI_VCAP), PSI_VCAP * PSI_K);
      st = Math.max(-PSI_MAX, Math.min(PSI_MAX, st));
      sim.psi = ((sim.psi + st) % PSI_TURN + PSI_TURN) % PSI_TURN;
    }
    // coins
    for (var c = Math.max(0, sim.pi - 1); c <= Math.min(sim.pieces.length - 1, sim.pi + 2); c++) {
      var cs = sim.pieces[c].coins;
      for (var n = 0; n < cs.length; n++) {
        var co = cs[n]; if (co.taken) continue;
        var ex = sim.x - co.x, ez = sim.z - co.z, ey = sim.y + BR - co.y, rq = BR + COIN_R;
        if (ex * ex + ey * ey + ez * ez <= rq * rq) { co.taken = sim.frames; sim.coins++; sim.evCoin++; sim.bonus += COIN_PTS * sim.mult; }
      }
    }
    // progress: the furthest point reached along the course
    if (sim.gr) {
      cur = sim.pieces[sim.pi];
      locate(cur, sim.x, sim.z, sim);
      var prog = cur.s0 + Math.max(0, Math.min(cur.L, Q.along));
      sim.lastS = courseS(cur);
      if (prog > sim.best) { sim.pts += (prog - sim.best) * sim.mult; sim.best = prog; }
    }
    // the multiplier: running fast heats it, slowing or crashing cools it
    var oldMult = sim.mult;
    // mazes are slow by nature: the heat holds there
    var slowPiece = sim.pieces[sim.pi].t === 'P' || sim.pieces[sim.pi].t === 'R';
    if (sim.gr && !slowPiece) {
      if (hs >= HOT_V) sim.heat += HEAT_UP;
      else if (hs < WARM_V) sim.heat -= HEAT_DOWN;
    }
    if (sim.evWall > HEAT_WALL_V) sim.heat -= HEAT_WALL;
    if (sim.evHit) sim.heat -= HEAT_HIT;
    sim.heat = Math.max(0, Math.min(HEAT_MAX, sim.heat));
    sim.mult = 1 + tdiv(sim.heat, 1000);
    if (sim.mult !== oldMult) sim.evMult = sim.mult - oldMult;
    // the collapse creeps on behind the ball, and never falls too far back
    if (sim.crumble && !sim.noCollapse && sim.frames > FRONT_WAIT) {
      var fp = null;
      for (var fi = Math.max(0, sim.pi - 3); fi <= sim.pi; fi++) { var fq = sim.pieces[fi]; if (sim.front >= fq.s0 && sim.front < fq.s0 + fq.L) fp = fq; }
      if (sim.frames % FRONT_RAMP === 0 && sim.fv < FRONT_VMAX) sim.fv++;
      sim.front += fp && fp.t === 'P' ? tdiv(sim.fv, 3) : fp && fp.t === 'R' ? sim.fv >> 1 : sim.fv;
      if (sim.front < sim.best - FRONT_LEAD) sim.front = sim.best - FRONT_LEAD;
    }
    sim.score = tdiv(sim.pts, P) + sim.bonus;
    // three minutes and the run is over, whatever else is happening
    if (sim.crumble && !sim.noClock && sim.frames >= RUN_STEPS) { sim.dead = true; sim.timeUp = true; }
    // falling past every deck nearby ends the run
    if (!sim.gr) {
      var lo = 1e15;
      for (var k = Math.max(0, sim.pi - 2); k <= Math.min(sim.pieces.length - 1, sim.pi + 3); k++) {
        var pk = sim.pieces[k], y1 = pk.t === 'P' ? pk.y0 - PLATE_DROP : Math.min(pk.y0, pk.y0 + (pk.dy || 0));
        if (y1 < lo) lo = y1;
      }
      if (sim.y < lo - KILL_DROP) { sim.dead = true; sim.cause = sim.leftFront ? 'collapse' : 'fall'; }
    }
  }
  // RAMP BALL RULES END
  return {
    RULES_VERSION: RULES_VERSION, IN_MAX: IN_MAX, RUN_STEPS: RUN_STEPS, P: P,
    seedToInt: seedToInt, initSim: initSim, stepSim: stepSim, courseEndless: courseEndless, h32: h32
  };
})();

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// The rules end every run at RUN_STEPS (three minutes) long before this.
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
const MAX_BATCH = 120;
// A WORK bound far above any real run; it REFUSES further inputs, never zeroes.
const MAX_INPUTS = GR.RUN_STEPS + 20000;

function isStep(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }
function isSwipe(v) { return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= -GR.IN_MAX && v <= GR.IN_MAX; }

function init({ seed, maxDurationSecs, elapsedSecs, onStep } = {}) {
  return {
    mode: 'none', sim: null, onStep: typeof onStep === 'function' ? onStep : null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { swipeSteps: 0, up: 0, down: 0, side: 0, upSum: 0, upMax: 0, gaps: [], lastSwipe: -1, strokes: 0, inStroke: false, flicks: 0 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated: how many steps carried a swipe, how strong the
// pushes were and how they were spaced. A thumb swipes in strokes with
// irregular gaps; a program can feed a perfect push every step.
function noteInput(st, sx, sy, step) {
  if (!sx && !sy) { st.inStroke = false; return; }
  st.swipeSteps++;
  if (sy > 0) { st.up++; st.upSum += sy; if (sy > st.upMax) st.upMax = sy; if (sy > 25) st.flicks++; }
  else if (sy < 0) st.down++;
  if (sx) st.side++;
  if (!st.inStroke) { st.strokes++; if (st.lastSwipe >= 0) st.gaps.push(step - st.lastSwipe); st.inStroke = true; }
  st.lastSwipe = step;
}
function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) { if (xs.length < 2) return null; const m = mean(xs); let s = 0; for (const x of xs) s += (x - m) * (x - m); return Math.sqrt(s / (xs.length - 1)); }
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }

function reject(state, reason) { state.rejectCount++; return { accepted: true, newScore: state.score, reason }; }
function stepOnce(state, sx, sy) {
  const sim = state.sim;
  noteInput(state.stats, sx, sy, sim.frames + 1);
  GR.stepSim(sim, sx, sy);
  if (state.onStep) state.onStep(sim);
}
function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepOnce(state, 0, 0);
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= 2 && state.mode !== 'sim') { state.mode = 'sim'; state.sim = GR.initSim(GR.seedToInt(state.seed), GR.courseEndless, Math.min(3, Number(payload.v))); }
    return { accepted: true, newScore: state.score };
  }
  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  if (kind !== 'path') return { accepted: true, newScore: state.score };
  const sim = state.sim;

  const { f, x, y } = payload;
  if (!isStep(f) || !Array.isArray(x) || !Array.isArray(y) || x.length < 1 || x.length > MAX_BATCH || y.length !== x.length) return reject(state, 'bad_path');
  for (let i = 0; i < x.length; i++) if (!isSwipe(x[i]) || !isSwipe(y[i])) return reject(state, 'bad_path');
  if (state.inputCount + x.length > MAX_INPUTS) return reject(state, 'input_cap');
  // A batch may never reach back into steps already run: a rewind would re-run
  // a window and keep the best outcome. Refused whole.
  if (f < sim.frames) return reject(state, 'frame_regressed');
  advanceTo(state, f);
  if (sim.dead) { state.dead = true; state.score = sim.score; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  if (sim.frames !== f) return reject(state, 'beyond_cap');
  state.inputCount += x.length;
  for (let i = 0; i < x.length && !sim.dead && sim.frames < MAX_SIM_STEPS; i++) stepOnce(state, x[i], y[i]);
  state.score = sim.score;
  if (sim.dead) { state.dead = true; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always ends inside this bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out past the last input: with nobody swiping, the collapse
  // reaches the ball within seconds, and the clock ends every run at three minutes.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) { stepOnce(state, 0, 0); guard++; }
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.frames, score: sim.score, dead: !!sim.dead, cause: sim.timeUp ? 'time' : (sim.cause || null),
      distance: Math.floor(sim.best / GR.P), coins: sim.coins,
      inputs: state.inputCount, rejects: state.rejectCount,
      swipeSteps: st.swipeSteps, strokes: st.strokes, flicks: st.flicks,
      upShare: st.swipeSteps ? round3(st.up / st.swipeSteps) : null,
      upMean: st.up ? round3(st.upSum / st.up) : null, upMax: st.upMax,
      gapMean: round3(mean(st.gaps)), gapCv: st.gaps.length > 1 ? round3(sd(st.gaps) / mean(st.gaps)) : null,
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
  _sim: { GR, advanceTo, MAX_INPUTS, MAX_SIM_STEPS, MAX_BATCH },
};
