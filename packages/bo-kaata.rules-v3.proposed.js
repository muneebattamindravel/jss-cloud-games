// Bo Kaata rules. Integers only: + - * floor-division, >>, min, max, abs,
// Math.imul, bit ops, a fixed sine table and one exact integer square root.
// No trig calls, no pow, no clock, no screen, no Math.random. Everything the
// server needs to replay a run lives between the markers below.
//
// How a real fighter kite (patang) flies, and so how this one does:
//   PULL (hold)   the kite flies straight where its NOSE points. The longer
//                 you pull, the faster it goes.
//   SLIP (let go) the line goes slack, the kite loses its shape and SPINS on
//                 the spot, and slowly sinks with the wind.
//   Steering is timing: let it spin until the nose points where you want to
//   go, then pull. A kite that comes down onto the rooftops is lost.
// A fight (pench): when two lines touch, the line moving FASTER through the
// contact saws through the slower one. A pulled line moves as fast as its kite
// flies; a slipping line pays out slowly. Hit their line at speed while they
// spin; never let them hit yours while you are spinning.
//
// BO KAATA RULES BEGIN
var PK = (function () {
  'use strict';

  // ── space: 1/256 of a design pixel; the design field is 414 x 736 ────────
  var U = 256;
  var FW = 414, FH = 736;
  var SPOOL_X = 207 * U, SPOOL_Y = 704 * U;
  var KX_MIN = 20 * U, KX_MAX = 394 * U, KY_MIN = 50 * U;
  var ROOF_Y = 622 * U;                         // come down here and the kite is lost

  // ── angles: 1024 to a turn; 0 is nose up, increasing clockwise ───────────
  var TURN = 1024;
  var SIN_Q = [
    0, 25, 50, 75, 101, 126, 151, 176, 201, 226, 251, 276, 301, 326, 351, 376,
    401, 426, 451, 476, 501, 526, 551, 576, 601, 626, 651, 675, 700, 725, 750, 774,
    799, 824, 848, 873, 897, 922, 946, 971, 995, 1020, 1044, 1068, 1092, 1117, 1141, 1165,
    1189, 1213, 1237, 1261, 1285, 1309, 1332, 1356, 1380, 1404, 1427, 1451, 1474, 1498, 1521, 1544,
    1567, 1591, 1614, 1637, 1660, 1683, 1706, 1729, 1751, 1774, 1797, 1819, 1842, 1864, 1886, 1909,
    1931, 1953, 1975, 1997, 2019, 2041, 2062, 2084, 2106, 2127, 2149, 2170, 2191, 2213, 2234, 2255,
    2276, 2296, 2317, 2338, 2359, 2379, 2399, 2420, 2440, 2460, 2480, 2500, 2520, 2540, 2559, 2579,
    2598, 2618, 2637, 2656, 2675, 2694, 2713, 2732, 2751, 2769, 2788, 2806, 2824, 2843, 2861, 2878,
    2896, 2914, 2932, 2949, 2967, 2984, 3001, 3018, 3035, 3052, 3068, 3085, 3102, 3118, 3134, 3150,
    3166, 3182, 3198, 3214, 3229, 3244, 3260, 3275, 3290, 3305, 3320, 3334, 3349, 3363, 3378, 3392,
    3406, 3420, 3433, 3447, 3461, 3474, 3487, 3500, 3513, 3526, 3539, 3551, 3564, 3576, 3588, 3600,
    3612, 3624, 3636, 3647, 3659, 3670, 3681, 3692, 3703, 3713, 3724, 3734, 3745, 3755, 3765, 3775,
    3784, 3794, 3803, 3812, 3822, 3831, 3839, 3848, 3857, 3865, 3873, 3881, 3889, 3897, 3905, 3912,
    3920, 3927, 3934, 3941, 3948, 3954, 3961, 3967, 3973, 3979, 3985, 3991, 3996, 4002, 4007, 4012,
    4017, 4022, 4027, 4031, 4036, 4040, 4044, 4048, 4052, 4055, 4059, 4062, 4065, 4068, 4071, 4074,
    4076, 4079, 4081, 4083, 4085, 4087, 4088, 4090, 4091, 4092, 4093, 4094, 4095, 4095, 4096, 4096,
    4096,
  ];
  function sinA(a) {
    a = ((a % TURN) + TURN) % TURN;
    if (a <= 256) return SIN_Q[a];
    if (a <= 512) return SIN_Q[512 - a];
    if (a <= 768) return -SIN_Q[a - 512];
    return -SIN_Q[TURN - a];
  }
  function cosA(a) { return sinA(a + 256); }

  // ── your kite ────────────────────────────────────────────────────────────
  var V0 = 3 * U;            // speed at the start of a pull (a sharp tug), a step
  var VACC = 20;             // speed gained a step while pulling
  var VMAX = 6 * U;          // top speed
  var SPIN = 11;             // heading change a step while slipping (about 230 degrees a second)
  var SINK = 120;            // a slipping kite sinks this much a step
  var SLIP_LINE = 300;       // a slipping line pays out this fast (it still saws, slowly)
  var RESPAWN = 75;          // a new kite goes up 1.25 s after you lose one
  var SAFE = 90;             // and nothing can touch it for 1.5 s
  var SPAWN_X = 207 * U, SPAWN_Y = 440 * U;
  var SUB = 4;               // substeps a step for every line test
  var CUT_AT = 50 * U;       // sawing needed to cut a line

  // ── wind, and gusts from wave 8 ──────────────────────────────────────────
  var WIND_SEG = 240, WIND_MAX = 50;
  var GUST_WAVE = 8, GUST_SEG = 300, GUST_RAMP = 20;

  // ── special rivals ───────────────────────────────────────────────────────
  var PENCH_WAVE = 6;        // from here some rivals are pench masters: they pull the moment you dart at them
  // kite sizes: 0 patang, 1 guddi (bigger), 2 tukkal (biggest). A bigger kite
  // flies slower on a thicker line: it takes longer holding to saw through, and pays more
  var SIZE_LINE = [2, 3, 5, 3]; // halves of CUT_AT its line needs: x1, x1.5, x2.5, x1.5
  var SIZE_PTS = [1, 2, 3, 4];
  var SIZE_SLOW = [0, 128, 256, 0];
  // trace v3: the fierce kite (size 3), and the kite turns away from a wall instead of pinning to it
  var WILD_WAVE = 4;         // from here some rivals are fierce: fast, weaving, quick to attack
  var WILD_VMAX = 7 * U;     // faster than your top speed (6 U): win by hitting it while it rests or turns
  var WILD_CRUISE = 4 * U;   // even resting it sweeps about this fast
  var WILD_AFTER = 1500;     // and never in the first 25 s of a run
  var TUKKAL_EVERY = 5;      // the first rival of every 5th wave is a tukkal

  // ── rivals ───────────────────────────────────────────────────────────────
  var FIRST_AT = 45;         // the first rival is in the sky within a second
  var PER_WAVE = 4;
  var LOW_Y = 470 * U;       // below this a rival climbs before anything else
  var HUNT_AFTER = 720;      // 12 s with no cut and a hunter comes for you
  var ANCHOR_X0 = -70 * U, ANCHOR_X1 = 484 * U;
  var ENTER_X0 = -16 * U, ENTER_X1 = 430 * U;
  var GONE_X0 = -60 * U, GONE_X1 = 474 * U;

  // ── scoring ──────────────────────────────────────────────────────────────
  var CUT_PTS = 10;
  var STREAK_MAX = 3;
  var KITES = 3;

  function u32(x) { return x >>> 0; }
  function mix(a, b, c) {
    var h = u32(a ^ Math.imul(b + 0x9e3779b9 | 0, 0x85ebca6b));
    h = u32(Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ c);
    h = u32(Math.imul(h ^ (h >>> 16), 0x27d4eb2f));
    h ^= h >>> 15;
    return u32(h);
  }
  function draw(seed, s, p, j, n) { return mix(seed, s * 1048576 + p * 64 + j, 0x51ed270b) % n; }
  function fdiv(a, b) { return Math.floor(a / b); }
  function isqrt(n) {
    if (n <= 0) return 0;
    var r = Math.floor(Math.sqrt(n));
    while (r * r > n) r--;
    while ((r + 1) * (r + 1) <= n) r++;
    return r;
  }
  function seedInt(hex) {
    var s = String(hex || '').replace(/[^0-9a-f]/gi, '').slice(0, 8);
    return s.length ? parseInt(s, 16) >>> 0 : 1;
  }
  function windVal(seed, j) { return draw(seed, 1, j, 0, 2 * WIND_MAX + 1) - WIND_MAX; }
  function windAt(seed, step) {
    var j = fdiv(step, WIND_SEG), r = step - j * WIND_SEG;
    var a = windVal(seed, j), b = windVal(seed, j + 1);
    return a + fdiv((b - a) * r, WIND_SEG);
  }

  // a gust: some 5 s windows carry one, ramping in and out
  function gustAt(seed, step) {
    var g = fdiv(step, GUST_SEG), t = step - g * GUST_SEG;
    if (draw(seed, 8, g, 0, 100) >= 45) return 0;
    var start = draw(seed, 8, g, 1, 120), len = 90 + draw(seed, 8, g, 2, 60);
    var amp = (220 + draw(seed, 8, g, 3, 180)) * (draw(seed, 8, g, 4, 2) ? 1 : -1);
    if (t < start || t >= start + len) return 0;
    var k = Math.min(GUST_RAMP, t - start, start + len - 1 - t);
    return fdiv(amp * k, GUST_RAMP);
  }

  // ── geometry, in 1/8 px (products stay well inside 2^53) ─────────────────
  function cross(ax, ay, bx, by, cx, cy) { return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); }
  function sgn(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function segCross(x1, y1, x2, y2, x3, y3, x4, y4) {
    x1 >>= 5; y1 >>= 5; x2 >>= 5; y2 >>= 5; x3 >>= 5; y3 >>= 5; x4 >>= 5; y4 >>= 5;
    var d1 = sgn(cross(x3, y3, x4, y4, x1, y1)), d2 = sgn(cross(x3, y3, x4, y4, x2, y2));
    var d3 = sgn(cross(x1, y1, x2, y2, x3, y3)), d4 = sgn(cross(x1, y1, x2, y2, x4, y4));
    return d1 * d2 < 0 && d3 * d4 < 0;
  }
  // is the nose (heading h) within the cone 1/k wide of the direction (dx, dy)
  function aimedAt(h, dx, dy, k) {
    var nx = sinA(h), ny = -cosA(h);
    dx >>= 5; dy >>= 5;
    var dot = nx * dx + ny * dy, cr = nx * dy - ny * dx;
    return dot > 0 && Math.abs(cr) * k < dot;
  }

  // ── one kite, one step. Shared by you and every rival: same physics. ─────
  // k: { x, y, h, s, pull }  returns a new object, never edits k
  function flyKite(k, pull, wind, vmax, v) {
    var x = k.x, y = k.y, h = k.h, s = k.s;
    if (pull) {
      s = k.pull ? Math.min(vmax, s + VACC) : V0;
      x = x + fdiv(s * sinA(h), 4096) + (wind >> 1);
      y = y - fdiv(s * cosA(h), 4096);
    } else {
      s = 0;
      h = (h + SPIN) % TURN;
      x = x + wind; y = y + SINK;
    }
    // v3: a pulling kite that meets a wall is turned away (mirrored), so it never sits pinned against it
    var bounce = v >= 3 && pull;
    if (x < KX_MIN) { x = KX_MIN; s = 0; if (bounce && sinA(h) < 0) h = (TURN - h) % TURN; }
    else if (x > KX_MAX) { x = KX_MAX; s = 0; if (bounce && sinA(h) > 0) h = (TURN - h) % TURN; }
    if (y < KY_MIN) { y = KY_MIN; s = 0; if (bounce && cosA(h) > 0) h = (512 - h + TURN) % TURN; }
    return { x: x, y: y, h: h, s: s, pull: pull ? 1 : 0 };
  }
  // how fast a line moves through a contact: a pulled line at its kite's speed,
  // a slipping one at the pay-out speed
  function lineSpeed(k) { return k.pull ? k.s : SLIP_LINE; }

  // ── the course: rival K is a pure function of (seed, K) ──────────────────
  function waveOf(K) { return fdiv(K, PER_WAVE) + 1; }
  function liveCap(w) { return w < 2 ? 1 : w < 4 ? 2 : 3; }
  function gapAfter(seed, K) { return Math.max(60, 200 - 12 * waveOf(K)) + draw(seed, 2, K, 0, 90); }
  function makeRival(seed, K, step, v) {
    var w = waveOf(K), side = draw(seed, 2, K, 2, 2);
    var sz = draw(seed, 2, K, 14, 100);
    var wild = v >= 3 && w >= WILD_WAVE && step >= WILD_AFTER && draw(seed, 2, K, 15, 100) < Math.min(40, 12 + 6 * (w - WILD_WAVE)) ? 1 : 0;
    var big = w % TUKKAL_EVERY === 0 && K % PER_WAVE === 0 ? 2 : wild ? 3 : w >= 3 && sz < 12 ? 2 : w >= 2 && sz < 32 ? 1 : 0;
    var pm = !big && w >= PENCH_WAVE && draw(seed, 2, K, 12, 100) < Math.min(60, 20 + 5 * (w - PENCH_WAVE)) ? 1 : 0;
    var fierce = big === 3;
    return {
      big: big, pm: pm, wp: 0,
      wa: fierce ? 5 + draw(seed, 2, K, 16, 4) : 0,      // how hard the weave turns the nose a step
      wf: 9 + draw(seed, 2, K, 17, 8), ph: draw(seed, 2, K, 18, TURN),   // how fast it weaves, and where in the weave it starts
      id: K, side: side, w: w,
      ax: side ? ANCHOR_X1 : ANCHOR_X0, ay: (610 + draw(seed, 2, K, 4, 240)) * U,
      x: side ? ENTER_X1 : ENTER_X0, y: (120 + draw(seed, 2, K, 3, 220)) * U,
      h: side ? 768 : 256, s: 3 * U, pull: 1,
      vmax: fierce ? WILD_VMAX : Math.min(7 * U, 4 * U + 70 * w + draw(seed, 2, K, 5, 220)) - SIZE_SLOW[big],
      aim: fierce ? 6 : Math.min(6, 2 + fdiv(w, 2)),  // how tightly it lines up before pulling
      react: fierce ? 12 : Math.max(14, 50 - 5 * w),  // the warning before it darts at you, in steps
      dart: fierce ? 60 + draw(seed, 2, K, 7, 50) : 34 + draw(seed, 2, K, 7, 40),   // how long it pulls at a time
      think: 0, run: 14, lock: 0, bal: 0,             // starts already flying in
      hx: (90 + draw(seed, 2, K, 9, 235)) * U, hy: (110 + draw(seed, 2, K, 10, 230)) * U,
      // first wave: targets only, they never attack; then they sweep about between attacks
      rest: fierce ? 30 + draw(seed, 2, K, 11, 40) : (K === 0 ? 200 : 90) + draw(seed, 2, K, 11, 90),
      restBase: fierce ? 40 : Math.max(70, 250 - 30 * w),
      until: step + 1200 + draw(seed, 2, K, 8, 900), hunter: 0,
    };
  }
  function makeHunter(seed, n, step, v) {
    var r = makeRival(seed, 100000 + n, step, v);
    return Object.assign(r, { id: 100000 + n, w: 8, vmax: 7 * U, aim: 6, react: 16, dart: 50, hunter: 1, big: 0, pm: 0, wa: 0, rest: 0, until: step + 2400 });
  }

  // A rival flies like a person would. Resting, it sweeps back and forth
  // between two points of its own patch of sky. Attacking, it lines its nose
  // up on the middle of your line and darts through it; it shows it is coming
  // (`think`, hovering with its nose held on you) for `react` steps first.
  // Low over the roofs it always climbs first. Returns [pull, think, hover].
  var PATROL_DX = 80 * U, PATROL_DY = 30 * U, ARRIVE = 36 * U;
  var CRUISE = 2 * U + 128;   // a resting rival sweeps no faster than this: hit it at speed and you win
  function waypoint(r) { return r.wp ? [r.hx + PATROL_DX, r.hy - PATROL_DY] : [r.hx - PATROL_DX, r.hy + PATROL_DY]; }
  function rivalDecide(r, me, left) {
    var tx, ty, k = r.aim, attack = 0;
    if (left <= 0) { tx = r.side ? 600 * U : -200 * U; ty = r.y - 60 * U; k = 2; }
    else if (r.y > LOW_Y) { tx = r.x; ty = r.y - 100 * U; k = 2; }
    else if (r.rest > 0) { var w = waypoint(r); tx = w[0]; ty = w[1]; k = 3; }
    else { tx = fdiv(SPOOL_X + me.x, 2); ty = fdiv(SPOOL_Y + me.y, 2); attack = 1; }
    if (r.pull) {
      if (r.run >= r.dart) return [0, 0];
      if (r.y > LOW_Y && cosA(r.h) < 0) return [0, 0];             // heading down near the roofs: let go
      if (!attack && left > 0 && r.y <= LOW_Y && Math.abs(tx - r.x) + Math.abs(ty - r.y) < ARRIVE) return [0, 0];
      return [1, 0];
    }
    // a pench master meets your dart: the moment you pull toward it, it pulls too
    if (r.pm && me.pull && aimedAt(me.h, r.x - me.x, r.y - me.y, 2)) return [1, 0];
    if (!attack) return [aimedAt(r.h, tx - r.x, ty - r.y, k) ? 1 : 0, 0];
    // attacking: once its nose points at your line it holds it there with a
    // light pull (hovering, red arrow showing) for `react` steps, then darts
    if (aimedAt(r.h, tx - r.x, ty - r.y, k) || r.think > 0) return r.think + 1 >= r.react ? [1, 0, 0] : [0, r.think + 1, 1];
    return [0, 0, 0];
  }

  // ── the run ──────────────────────────────────────────────────────────────
  function initSim(seedHex, version) {
    return {
      v: Number(version) || 2, seed: seedInt(seedHex), frames: 0,
      me: { x: SPAWN_X, y: 470 * U, h: 0, s: 0, pull: 0 },
      touching: 0, kites: KITES, score: 0, wins: 0, streak: 0, lastCut: 0, respawn: 0, safe: SAFE,
      rivals: [], nextK: 0, nextAt: FIRST_AT, hunts: 0, wave: 1,
      events: [], dead: '',
    };
  }
  function touch(sim) { if (sim.dead) return false; sim.touching = 1; return true; }
  function lift(sim) { if (sim.dead) return false; sim.touching = 0; return true; }

  function stepSim(sim) {
    if (sim.dead) return sim;
    var f = sim.frames, seed = sim.seed, ev = [], wind = windAt(seed, f) + (sim.wave >= GUST_WAVE ? gustAt(seed, f) : 0);

    var rivals = sim.rivals;
    if (f >= sim.nextAt && rivals.length < liveCap(waveOf(sim.nextK))) {
      rivals = rivals.concat([makeRival(seed, sim.nextK, f, sim.v)]);
      sim.nextAt = f + gapAfter(seed, sim.nextK);
      sim.wave = waveOf(sim.nextK);
      sim.nextK = sim.nextK + 1;
      ev = ev.concat([{ k: 'enter', id: sim.nextK - 1 }]);
    }
    var hunting = 0;
    for (var h = 0; h < rivals.length; h++) if (rivals[h].hunter) hunting = 1;
    if (!hunting && f - sim.lastCut >= HUNT_AFTER) {
      rivals = rivals.concat([makeHunter(seed, sim.hunts, f, sim.v)]);
      sim.hunts = sim.hunts + 1; sim.lastCut = f;
      ev = ev.concat([{ k: 'hunter' }]);
    }

    // your kite
    var me0 = sim.me, respawn = Math.max(0, sim.respawn - 1), safe = Math.max(0, sim.safe - 1);
    var me1 = sim.respawn > 0 ? me0 : flyKite(me0, sim.touching === 1, wind, VMAX, sim.v);

    // rivals fly by the same physics
    var moved = [];
    for (var i = 0; i < rivals.length; i++) {
      var r = rivals[i], left = r.until - f;
      var dc = rivalDecide(r, me0, left);
      var attacking = r.rest === 0 && left > 0 && r.y <= LOW_Y;
      var nr = Object.assign({}, r, dc[2] ? { s: 0, pull: 0 } : flyKite(r, dc[0] === 1, wind, attacking ? r.vmax : Math.min(r.vmax, r.big === 3 ? WILD_CRUISE : CRUISE), sim.v), {
        think: dc[1], run: dc[0] ? (r.pull ? r.run + 1 : 1) : 0,
        // a sweep that ends heads for the other point; an attack that ends goes back to resting
        wp: r.rest > 0 && r.pull && !dc[0] ? 1 - r.wp : r.wp,
        rest: r.rest > 0 ? r.rest - 1 : (r.pull && !dc[0] && r.run >= 8 ? r.restBase + draw(seed, 7, r.id, f & 1023, 60) : 0),
      });
      if (r.wa && nr.pull) nr.h = (nr.h + fdiv(cosA(f * r.wf + r.ph) * r.wa, 4096) + TURN) % TURN;   // the weave
      if (left <= 0 && (nr.x <= KX_MIN || nr.x >= KX_MAX)) { ev = ev.concat([{ k: 'gone', id: r.id }]); continue; }
      if (nr.y >= ROOF_Y) { ev = ev.concat([{ k: 'down', id: r.id, x: nr.x, y: nr.y }]); continue; }
      moved.push({ r0: r, r1: nr });
    }

    // lines in contact saw at the difference of their speeds
    var keep = [], lost = 0, lostBy = 0, cutPts = 0;
    var myLine = lineSpeed(me1);
    for (var j = 0; j < moved.length; j++) {
      var m = moved[j], c = m.r1, touchingLines = 0;
      if (sim.respawn === 0 && safe === 0) {
        for (var sub = 1; sub <= SUB && !touchingLines; sub++) {
          var kx = me0.x + fdiv((me1.x - me0.x) * sub, SUB), ky = me0.y + fdiv((me1.y - me0.y) * sub, SUB);
          var rx = m.r0.x + fdiv((c.x - m.r0.x) * sub, SUB), ry = m.r0.y + fdiv((c.y - m.r0.y) * sub, SUB);
          if (segCross(SPOOL_X, SPOOL_Y, kx, ky, c.ax, c.ay, rx, ry)) touchingLines = 1;
        }
      }
      if (!touchingLines) { keep.push(c.lock ? Object.assign({}, c, { lock: 0, bal: 0 }) : c); continue; }
      // one balance per contact: + while your line runs faster, - while theirs does
      if (!c.lock) ev = ev.concat([{ k: 'pench', id: c.id }]);
      var bal = (c.bal || 0) + myLine - lineSpeed(c);
      if (bal * 2 >= CUT_AT * SIZE_LINE[c.big]) {
        var st = Math.min(STREAK_MAX, sim.streak + 1), pts = CUT_PTS * st * SIZE_PTS[c.big];
        sim.streak = st; sim.wins = sim.wins + 1; cutPts = cutPts + pts; sim.lastCut = f;
        ev = ev.concat([{ k: 'cut', id: c.id, x: c.x, y: c.y, mult: st, pts: pts, big: c.big }]);
        continue;
      }
      if (bal <= -CUT_AT && !lost) { lost = 1; lostBy = c.id; bal = 0; }
      keep.push(Object.assign({}, c, { lock: 1, bal: bal }));
    }
    sim.score = sim.score + cutPts;

    if (!lost && sim.respawn === 0 && me1.y >= ROOF_Y) { lost = 2; }
    if (lost) {
      sim.streak = 0; sim.kites = sim.kites - 1;
      ev = ev.concat([{ k: 'lost', why: lost === 1 ? 'cut' : 'roof', by: lostBy, x: me1.x, y: me1.y }]);
      keep = keep.map(function (x) { return Object.assign({}, x, { lock: 0, bal: 0 }); });
      if (sim.kites <= 0) sim.dead = lost === 1 ? 'cut' : 'roof';
      else { me1 = { x: SPAWN_X, y: SPAWN_Y, h: 0, s: 0, pull: 0 }; respawn = RESPAWN; safe = RESPAWN + SAFE; }
    }

    sim.me = me1; sim.rivals = keep; sim.respawn = respawn; sim.safe = safe;
    sim.frames = f + 1;
    if (sim.dead) ev = ev.concat([{ k: 'dead', why: sim.dead }]);
    sim.events = ev;
    return sim;
  }

  return {
    U: U, FW: FW, FH: FH, SPOOL_X: SPOOL_X, SPOOL_Y: SPOOL_Y, ROOF_Y: ROOF_Y, TURN: TURN,
    VMAX: VMAX, V0: V0, SPIN: SPIN, CUT_AT: CUT_AT, KITES: KITES, RESPAWN: RESPAWN, SUB: SUB, LOW_Y: LOW_Y,
    seedInt: seedInt, windAt: windAt, gustAt: gustAt, GUST_WAVE: GUST_WAVE, SIZE_LINE: SIZE_LINE, SIZE_PTS: SIZE_PTS, waveOf: waveOf, makeRival: makeRival, segCross: segCross,
    sinA: sinA, cosA: cosA, aimedAt: aimedAt, flyKite: flyKite, lineSpeed: lineSpeed, rivalDecide: rivalDecide,
    initSim: initSim, touch: touch, lift: lift, stepSim: stepSim,
  };
})();
// BO KAATA RULES END
if (typeof module !== 'undefined' && module.exports) module.exports = PK;
