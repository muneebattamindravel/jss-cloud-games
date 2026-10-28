'use strict';

/**
 * Chal Cube (game id draw-climber) validator: SERVER-SIDE DETERMINISTIC
 * REPLAY, and nothing else. Built on replay from day one, so a trace without a
 * v2 start marker is not a run and scores zero.
 *
 * The game: a cube walks on a pair of legs the player DRAWS. The stroke's
 * first point sits on the cube's hub; the front leg is the stroke and the back
 * leg is the same stroke turned 180 degrees. The legs turn at a rate set by
 * their reach (big legs turn slowly), the planted foot carries the body, and
 * the cube climbs, bridges or stalls on seeded terrain. Score = distance in
 * metres + 5 per coin. A run ends at three minutes or when the cube falls.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed (section k is a pure function
 *      of (seed, k, x, y), drawn from hash(seed, k, j), never a running stream);
 *   2. applies each stroke { n, step, pts } before step `step` runs, through
 *      the same resampling the client used (makeLegs);
 *   3. runs the same fixed steps to the clock and reads the score.
 *
 * The client's own number is never read here. `require_claimed_match` in
 * submitSession compares the two. The rules block is carried WORD FOR WORD in
 * games/draw-climber/js/rules.js and shared/tests/drawClimberParity.test.js
 * fails the moment one copy changes without the other.
 */

// ==== RULES BLOCK: identical in games/draw-climber/js/rules.js and shared/anticheat/validators/drawClimber.js ====
  const RULES_VERSION = 6;
  const RUN_STEPS = 180 * 60;  // the run is three minutes of fixed steps
  const SEED_MIX = 0x9e3779b1;
  const SUB = 256;            // sub-units per design unit
  const ANG = 1024;           // angle units per turn
  const TRIG_ONE = 16384;     // table scale
  const SIN_Q = [0,101,201,302,402,503,603,704,804,904,1005,1105,1205,1306,1406,1506,1606,1706,1806,1906,2006,2105,2205,2305,2404,2503,2603,2702,2801,2900,2999,3098,3196,3295,3393,3492,3590,3688,3786,3883,3981,4078,4176,4273,4370,4467,4563,4660,4756,4852,4948,5044,5139,5235,5330,5425,5520,5614,5708,5803,5897,5990,6084,6177,6270,6363,6455,6547,6639,6731,6823,6914,7005,7096,7186,7276,7366,7456,7545,7635,7723,7812,7900,7988,8076,8163,8250,8337,8423,8509,8595,8680,8765,8850,8935,9019,9102,9186,9269,9352,9434,9516,9598,9679,9760,9841,9921,10001,10080,10159,10238,10316,10394,10471,10549,10625,10702,10778,10853,10928,11003,11077,11151,11224,11297,11370,11442,11514,11585,11656,11727,11797,11866,11935,12004,12072,12140,12207,12274,12340,12406,12472,12537,12601,12665,12729,12792,12854,12916,12978,13039,13100,13160,13219,13279,13337,13395,13453,13510,13567,13623,13678,13733,13788,13842,13896,13949,14001,14053,14104,14155,14206,14256,14305,14354,14402,14449,14497,14543,14589,14635,14680,14724,14768,14811,14854,14896,14937,14978,15019,15059,15098,15137,15175,15213,15250,15286,15322,15357,15392,15426,15460,15493,15525,15557,15588,15619,15649,15679,15707,15736,15763,15791,15817,15843,15868,15893,15917,15941,15964,15986,16008,16029,16049,16069,16088,16107,16125,16143,16160,16176,16192,16207,16221,16235,16248,16261,16273,16284,16295,16305,16315,16324,16332,16340,16347,16353,16359,16364,16369,16373,16376,16379,16381,16383,16384,16384];
  const HALF = 20;            // cube half size (units)
  const LEG_SCALE = 150;      // box width 1000 maps to this many units
  const BOX_W = 1000, BOX_H = 1000;
  const LEG_N = 24;           // resampled points per stroke
  const RAW_MAX = 240;        // most raw points a stroke may carry
  const MAX_SHAPES = 1500;    // most shapes a run may draw (bounds the trace)
  const MIN_LEN = 40;         // box units, shorter strokes are refused
  const GRAV = 95;            // sub-units per step per step
  const OMEGA_K = 1000;        // turn rate = OMEGA_K / reach, clamped: big legs turn slowly
  const OMEGA_MIN = 6, OMEGA_MAX = 28;
  const CARRY_K = 1000;        // most a foot carries per step = CARRY_K / reach units
  const CARRY_MIN = 3 * SUB / 4, CARRY_MAX = 6 * SUB;
  const SLIP_UP = 5 * SUB, SLIP_DN = 6 * SUB;
  const CARRY = 60;           // out of 256, momentum kept while gripping
  const TOUCH = 2 * SUB;      // a point this close above the terrain counts as planted
  const PASSES = 6;
  const MAX_PUSH = 9 * SUB;   // per pass
  const MU = 200;             // drive transfer out of 256
  const AIR_DAMP = 254, GROUND_DAMP = 215; // out of 256, on velocity
  const VMAX = 18 * SUB;
  const THICK = 60;           // track thickness (units)
  const FALL_DROP = 260;      // this far below the last footing the run is over
  const COIN_R = HALF + 14, COIN_POINTS = 5;
  const WALL_HP = 140;        // drive sub-units of push to shatter a wall

  function sinA(a) {
    a = ((a % ANG) + ANG) % ANG;
    const q = a >> 8, i = a & 255;
    if (q === 0) return SIN_Q[i];
    if (q === 1) return SIN_Q[256 - i];
    if (q === 2) return -SIN_Q[i] | 0;   // | 0 so the table never yields -0
    return -SIN_Q[256 - i] | 0;
  }
  function cosA(a) { return sinA(a + 256); }
  function isqrt(n) {
    if (n <= 0) return 0;
    let x = Math.floor(Math.sqrt(n));
    while (x * x > n) x--;
    while ((x + 1) * (x + 1) <= n) x++;
    return x;
  }
  function hash(a, b, c) {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
  }

  // Resample a raw stroke (box coords, by down) to LEG_N leg points (units,
  // y up) relative to the stroke's first point, which sits on the hub. Returns null if refused.
  function makeLegs(raw) {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const p = [];
    if (raw.length > RAW_MAX) return null;
    for (let i = 0; i < raw.length; i++) {
      const q = raw[i];
      if (!Array.isArray(q) || q.length !== 2 || !Number.isInteger(q[0]) || !Number.isInteger(q[1])) return null;
      const x = q[0], y = q[1];
      if (x < 0 || x > BOX_W || y < 0 || y > BOX_H) return null;
      if (p.length && p[p.length - 1][0] === x && p[p.length - 1][1] === y) continue;
      p.push([x, y]);
    }
    if (p.length < 2) return null;
    const cum = [0];
    for (let i = 1; i < p.length; i++) {
      const dx = p[i][0] - p[i - 1][0], dy = p[i][1] - p[i - 1][1];
      cum.push(cum[i - 1] + isqrt(dx * dx + dy * dy));
    }
    const L = cum[cum.length - 1];
    if (L < MIN_LEN) return null;
    const cx = 2 * p[0][0], cy = 2 * p[0][1]; // the stroke's first point is the hub (doubled)
    const out = [];
    let j = 0;
    for (let k = 0; k < LEG_N; k++) {
      const t = Math.floor(L * k / (LEG_N - 1));
      while (j < p.length - 2 && cum[j + 1] < t) j++;
      const seg = cum[j + 1] - cum[j];
      const f = seg > 0 ? Math.floor((t - cum[j]) * 1024 / seg) : 0;
      const bx2 = 2 * p[j][0] * 1024 + 2 * (p[j + 1][0] - p[j][0]) * f - cx * 1024;
      const by2 = 2 * p[j][1] * 1024 + 2 * (p[j + 1][1] - p[j][1]) * f - cy * 1024;
      // to sub-units: bx2/2048 box units * LEG_SCALE/BOX_W units * SUB
      out.push([Math.floor(bx2 * LEG_SCALE * SUB / (2048 * BOX_W)), -Math.floor(by2 * LEG_SCALE * SUB / (2048 * BOX_W))]);
    }
    return out;
  }

  // ── terrain: pieces {x0, x1, y0, y1, wall} in units, solid below the line.
  // Terrain. Each section is a short run-up then one or more obstacles back to
  // back. Obstacle types unlock in tiers as k grows, the number chained per
  // section grows, run-ups shorten and sizes grow, so the run keeps getting
  // harder. Every fourth section is a sprint lined with coins. Coins sit where
  // the right shape takes the cube. Coin ids are k * 16 + j.
  const TIERS = [
    [0, ['step', 'stairs', 'gap', 'ramp', 'wave', 'down', 'wall']],
    [5, ['stones', 'pit', 'teeth', 'tower', 'stairsDown']],
    [11, ['doubleWall', 'islands', 'castle', 'bigWave', 'cliff']],
    [18, ['pillars', 'zigzag', 'stepGap', 'gauntlet']],
  ];
  function typesFor(k) { let t = []; for (const [from, list] of TIERS) if (k >= from) t = t.concat(list); return t; }
  function section(seed, k, x, y) {
    const lvl = Math.min(k, 50);
    const out = [], coins = [];
    let n = 0;
    const R = () => hash(seed, k, 100 + n++);
    const coin = (cx, cy) => { if (coins.length < 16) coins.push({ id: k * 16 + coins.length, x: cx, y: cy }); };
    const run = (L) => { out.push({ x0: x, x1: x + L, y0: y, y1: y, wall: 0 }); x += L; };
    const slope = (L, h) => { out.push({ x0: x, x1: x + L, y0: y, y1: y + h, wall: 0 }); x += L; y += h; };
    const wall = (h) => { out.push({ x0: x, x1: x + 24, y0: y + h, y1: y + h, wall: 1, base: y }); coin(x + 12, y + h + 40); x += 24; };
    const gap = (g) => { coin(x + Math.floor(g / 2), y + 60); x += g; };
    const hump = (amp, L) => {
      for (let s = 0; s < 6; s++) {
        const f0 = s * 64, f1 = (s + 1) * 64, w = Math.floor(L / 6);
        const h0 = Math.floor(amp * f0 * (384 - f0) * 4 / (384 * 384)), h1 = Math.floor(amp * f1 * (384 - f1) * 4 / (384 * 384));
        out.push({ x0: x + s * w, x1: x + s * w + w, y0: y + h0, y1: y + h1, wall: 0 });
      }
      coin(x + Math.floor(L / 2), y + amp + HALF + 10); x += 6 * Math.floor(L / 6);
    };
    const g0 = 70 + lvl * 2; // gap scale
    function obstacle(t) {
      const r1 = R(), r2 = R(), r3 = R();
      switch (t) {
        case 'step': { y += 45 + r1 % (25 + lvl * 2); run(90); coin(x - 45, y + HALF + 40); break; }
        case 'stairs': { const c = 3 + r1 % 3, h = 26 + r2 % (12 + lvl), w = 34 + r3 % 22; for (let i = 0; i < c; i++) { run(w); y += h; } run(80); coin(x - 40, y + HALF); break; }
        case 'stairsDown': { const c = 3 + r1 % 4, h = 30 + r2 % (14 + lvl), w = 40 + r3 % 20; for (let i = 0; i < c; i++) { run(w); y -= h; } run(90); coin(x - 45, y + HALF); break; }
        case 'gap': { gap(g0 + r2 % (40 + lvl * 2)); run(110); break; }
        case 'ramp': { slope(130 + r1 % 70, 60 + r2 % (40 + lvl * 2)); run(70); coin(x - 35, y + HALF); break; }
        case 'down': { y -= 50 + r1 % 80; run(120); coin(x - 100, y + HALF); break; }
        case 'wave': { const c = 2 + r1 % 2; for (let i = 0; i < c; i++) hump(40 + r2 % (30 + lvl), 120); break; }
        case 'bigWave': { const c = 2 + r1 % 2; for (let i = 0; i < c; i++) hump(90 + r2 % (40 + lvl), 180); break; }
        case 'wall': { wall(110 + r1 % (50 + lvl * 2)); run(90); break; }
        case 'doubleWall': { wall(100 + r1 % (40 + lvl)); run(50 + r3 % 40); wall(110 + r2 % (50 + lvl)); run(90); break; }
        case 'stones': { const c = 3 + r1 % 3; for (let i = 0; i < c; i++) { gap(40 + r2 % 30 + lvl); run(40 + r3 % 20); } run(80); break; }
        case 'islands': { const c = 3 + r1 % 2; for (let i = 0; i < c; i++) { gap(50 + r2 % 40 + lvl); y += (i & 1 ? -1 : 1) * (30 + r3 % 40); run(60); } run(80); break; }
        case 'pit': { const d = 60 + r1 % (40 + lvl); y -= d; run(60 + r2 % 40); coin(x - 30, y + HALF); y += d + 20 + r3 % 30; run(100); break; }
        case 'teeth': { const c = 5 + r1 % 4, h = 18 + r2 % (12 + lvl / 2 | 0); for (let i = 0; i < c; i++) { slope(18, h); slope(18, -h); } run(80); break; }
        case 'zigzag': { const c = 4 + r1 % 3, h = 30 + r2 % (20 + lvl / 2 | 0); for (let i = 0; i < c; i++) { slope(30, h); slope(30, -h); } run(80); break; }
        case 'tower': { const h = 90 + r1 % (50 + lvl * 2); y += h; run(30 + r2 % 20); coin(x - 15, y + HALF + 30); y -= h; run(110); break; }
        case 'pillars': { const c = 3 + r1 % 2; for (let i = 0; i < c; i++) { gap(45 + r2 % 25); y += 30 + r3 % 30; run(30); } run(90); break; }
        case 'castle': { const c = 3 + r1 % 3, h = 40 + r2 % (30 + lvl); for (let i = 0; i < c; i++) { y += h; run(36); y -= h; run(36 + r3 % 20); } run(60); break; }
        case 'cliff': { y += 140 + r1 % (60 + lvl * 2); run(100); coin(x - 50, y + HALF); break; }
        case 'stepGap': { y += 50 + r1 % (30 + lvl); run(50); gap(g0 + r2 % 40); run(100); break; }
        case 'gauntlet': { wall(100 + r1 % 40); run(40); gap(60 + r2 % 40); run(60); y += 50 + r3 % 40; run(100); break; }
      }
    }
    if (k < 1) { run(220); return { pieces: out, coins, x, y }; }
    if (k % 4 === 3) { const L = 360 + R() % 160; const x0 = x; run(L); for (let j = 1; j <= 6; j++) coin(x0 + Math.floor(L * j / 7), y + HALF); return { pieces: out, coins, x, y }; }
    const types = typesFor(k), chain = 1 + (k >= 9 ? 1 : 0) + (k >= 22 ? 1 : 0);
    for (let c = 0; c < chain; c++) {
      run(Math.max(40, 90 + R() % 60 - lvl * 2));
      obstacle(types[R() % types.length]);
    }
    return { pieces: out, coins, x, y };
  }

  // ── v3 terrain (Oct 2026): everything above plus obstacles that each want a
  // DIFFERENT shape, so a couple of strokes cannot carry a run: low roofs
  // (tunnels) jam long legs, tall solid ledges and stepped walls need long
  // ones, kickers need speed to fly a gap, narrow pillars need a span, and
  // "switch" puts a tunnel straight before a ledge. Roofs are solid from
  // their bottom edge `yb` up ROOF_T, kept in sim.roofs (sorted by x).
  const ROOF_T = 400;           // roofs are tall overhangs: nothing climbs over one
  const TIERS_V3 = [
    [0, ['step', 'stairs', 'gap', 'ramp', 'wave', 'down', 'wall', 'tunnel', 'cobbles']],
    [4, ['ledge', 'kicker', 'stones', 'pit', 'tower', 'stairsDown']],
    [9, ['ledgeSteps', 'spanPillars', 'canyon', 'tunnelStep', 'doubleWall', 'islands', 'castle']],
    [15, ['switch', 'pyramid', 'bigWave', 'cliff', 'pillars', 'zigzag', 'stepGap', 'gauntlet', 'tunnel', 'ledge']],
  ];
  function typesForV3(k) { let t = []; for (const [from, list] of TIERS_V3) if (k >= from) t = t.concat(list); return t; }
  function sectionV3(seed, k, x, y, only) {   // `only`: tests force one obstacle type
    const lvl = Math.min(k, 50);
    const out = [], coins = [], roofs = [];
    let n = 0;
    const R = () => hash(seed, k, 100 + n++);
    const coin = (cx, cy) => { if (coins.length < 16) coins.push({ id: k * 16 + coins.length, x: cx, y: cy }); };
    const run = (L) => { out.push({ x0: x, x1: x + L, y0: y, y1: y, wall: 0 }); x += L; };
    const slope = (L, h) => { out.push({ x0: x, x1: x + L, y0: y, y1: y + h, wall: 0 }); x += L; y += h; };
    const wall = (h) => { out.push({ x0: x, x1: x + 24, y0: y + h, y1: y + h, wall: 1, base: y }); coin(x + 12, y + h + 40); x += 24; };
    const gap = (g) => { coin(x + Math.floor(g / 2), y + 60); x += g; };
    const roof = (L, c) => { roofs.push({ x0: x, x1: x + L, yb: y + c }); };
    const hump = (amp, L) => {
      for (let s = 0; s < 6; s++) {
        const f0 = s * 64, f1 = (s + 1) * 64, w = Math.floor(L / 6);
        const h0 = Math.floor(amp * f0 * (384 - f0) * 4 / (384 * 384)), h1 = Math.floor(amp * f1 * (384 - f1) * 4 / (384 * 384));
        out.push({ x0: x + s * w, x1: x + s * w + w, y0: y + h0, y1: y + h1, wall: 0 });
      }
      coin(x + Math.floor(L / 2), y + amp + HALF + 10); x += 6 * Math.floor(L / 6);
    };
    const g0 = 70 + lvl * 2;
    const clear = () => Math.max(74, 92 - (lvl >> 2));
    function tunnel(L, stepH) {
      const c = clear();
      if (!stepH) { roof(L, c); coin(x + (L >> 1), y + HALF + 4); run(L); return; }
      const a = L >> 1; roof(a, c); run(a); y += stepH; roof(L - a, c); coin(x + ((L - a) >> 1), y + HALF + 4); run(L - a);
    }
    function obstacle(t) {
      const r1 = R(), r2 = R(), r3 = R();
      switch (t) {
        case 'step': { y += 45 + r1 % (25 + lvl * 2); run(90); coin(x - 45, y + HALF + 40); break; }
        case 'stairs': { const c = 3 + r1 % 3, h = 60 + r2 % (12 + (lvl >> 2)), w = 34 + r3 % 22; for (let i = 0; i < c; i++) { run(w); y += h; } run(80); coin(x - 40, y + HALF); break; }
        case 'stairsDown': { const c = 3 + r1 % 3, h = 24 + r2 % 10, w = 50 + r3 % 20, cl = clear(); roof(c * w, cl); for (let i = 0; i < c; i++) { run(w); y -= h; } run(90); coin(x - 45, y + HALF); break; }
        case 'gap': { gap(g0 + r2 % (40 + lvl * 2)); run(110); break; }
        case 'ramp': { slope(130 + r1 % 70, 50 + r2 % 30); run(40); y += 70 + r3 % 25; run(70); coin(x - 35, y + HALF); break; }
        case 'down': { y -= 50 + r1 % 60; run(60); coin(x - 30, y + HALF); gap(75 + r2 % (25 + (lvl >> 1))); run(110); break; }
        case 'wave': { const c = 2 + r1 % 2, a = 26 + r2 % 12; roof(c * 120, a + clear()); for (let i = 0; i < c; i++) hump(a, 120); run(200); break; }
        case 'bigWave': { const c = 2 + r1 % 2; for (let i = 0; i < c; i++) hump(90 + r2 % (40 + lvl), 180); break; }
        case 'wall': { wall(110 + r1 % (40 + lvl)); run(40); tunnel(150 + r2 % 60, 0); run(200); break; }
        case 'doubleWall': { wall(100 + r1 % (30 + lvl)); run(30); gap(80 + r3 % (30 + (lvl >> 1))); run(30); wall(110 + r2 % (35 + lvl)); run(90); break; }
        case 'stones': { const c = 3 + r1 % 3; for (let i = 0; i < c; i++) { gap(40 + r2 % 30 + lvl); run(40 + r3 % 20); } run(80); break; }
        case 'islands': { const c = 3 + r1 % 2; for (let i = 0; i < c; i++) { gap(50 + r2 % 40 + lvl); y += (i & 1 ? -1 : 1) * (30 + r3 % 40); run(60); } run(80); break; }
        case 'pit': { const d = 60 + r1 % (40 + lvl); y -= d; run(60 + r2 % 40); coin(x - 30, y + HALF); y += d + 20 + r3 % 30; run(100); break; }
        case 'zigzag': { const c = 4 + r1 % 3, h = 30 + r2 % (20 + lvl / 2 | 0); for (let i = 0; i < c; i++) { slope(30, h); slope(30, -h); } run(80); break; }
        case 'tower': { const h = 90 + r1 % (50 + lvl * 2); y += h; run(30 + r2 % 20); coin(x - 15, y + HALF + 30); y -= h; run(110); break; }
        case 'pillars': { const c = 3 + r1 % 2; for (let i = 0; i < c; i++) { gap(45 + r2 % 25); y += 30 + r3 % 30; run(30); } run(90); break; }
        case 'castle': { const c = 3 + r1 % 3, h = 40 + r2 % (30 + lvl); for (let i = 0; i < c; i++) { y += h; run(36); y -= h; run(36 + r3 % 20); } run(60); break; }
        case 'cliff': { y += 140 + r1 % (60 + lvl * 2); run(100); coin(x - 50, y + HALF); break; }
        case 'stepGap': { y += 50 + r1 % (30 + lvl); run(50); gap(g0 + r2 % 40); run(100); break; }
        case 'gauntlet': { wall(100 + r1 % 40); run(40); gap(60 + r2 % 40); run(60); y += 50 + r3 % 40; run(100); break; }
        // ── new in v3
        case 'tunnel': { tunnel(170 + r1 % (80 + lvl * 3), 0); run(230); break; }
        case 'tunnelStep': { tunnel(220 + r1 % 90, 22 + r2 % 12); run(230); break; }
        case 'cobbles': { const c = 7 + r1 % 5, h = 10 + r2 % 6; roof(c * 22, h + clear()); for (let i = 0; i < c; i++) { slope(11, h); slope(11, -h); } run(200); coin(x - 100, y + HALF); break; }
        case 'ledge': { y += 105 + r1 % (35 + lvl); run(100); coin(x - 50, y + HALF + 30); break; }
        case 'ledgeSteps': { const c = 2 + r1 % 2, h = 58 + r2 % (16 + (lvl >> 1)), w = 26 + r3 % 10; for (let i = 0; i < c; i++) { y += h; run(w); } run(70); coin(x - 35, y + HALF); break; }
        case 'kicker': { slope(70, 34 + r1 % 14); run(16); gap(105 + r2 % 30); y -= 30 + r3 % 20; run(140); break; }
        case 'spanPillars': { const c = 3 + r1 % 2, g = 66 + r2 % (18 + (lvl >> 1)); for (let i = 0; i < c; i++) { gap(g); run(22); } gap(g); run(110); break; }
        case 'canyon': { y -= 80 + r1 % 30; run(90 + r2 % 40); coin(x - 45, y + HALF); y += 100 + r3 % (30 + lvl); run(100); break; }
        case 'switch': { tunnel(160 + r1 % 60, 0); run(170 + r3 % 30); y += 105 + r2 % (20 + (lvl >> 1)); run(100); break; }
        case 'pyramid': { const h = 56 + r1 % 14, w = 30 + r2 % 10; for (let i = 0; i < 3; i++) { y += h; run(w); } run(50); for (let i = 0; i < 3; i++) { y -= h; run(w); } run(70); coin(x - 230, y + 3 * h + HALF); break; }
      }
    }
    if (k < 1) { run(220); return { pieces: out, coins, roofs, x, y }; }
    if (k % 4 === 3) { const L = 360 + R() % 160; const x0 = x; run(L); for (let j = 1; j <= 6; j++) coin(x0 + Math.floor(L * j / 7), y + HALF); return { pieces: out, coins, roofs, x, y }; }
    if (only) { run(120); obstacle(only); run(400); return { pieces: out, coins, roofs, x, y }; }
    const types = typesForV3(k), chain = 1 + (k >= 9 ? 1 : 0) + (k >= 22 ? 1 : 0);
    const used = [];
    for (let c = 0; c < chain; c++) {
      run(Math.max(40, 90 + R() % 60 - lvl * 2));
      const t = types[R() % types.length]; used.push(t);
      obstacle(t);
    }
    return { pieces: out, coins: coins.sort((p, q) => p.x - q.x || p.id - q.id), roofs, x, y, types: used };
  }

  // ── v4 terrain (Oct 2026), modelled on the reference recordings: everything
  // in v3 plus MATERIALS and MEDIA. A piece may carry m: 1 ice (feet slip, the
  // body glides and slides back down a slope), m: 2 spikes (any touch sends
  // the cube back to its checkpoint). Zones are water (kind 1: the cube floats
  // and the legs paddle) and ball pits (kind 2: thick going), each from a floor
  // yb up to a surface yt. Every section starts with a checkpoint (cp).
  const TIERS_V4 = [
    [0, ['step', 'stairs', 'gap', 'ramp', 'wave', 'down', 'wall', 'tunnel', 'cobbles', 'pool', 'balls']],
    [4, ['ledge', 'kicker', 'stones', 'pit', 'tower', 'stairsDown', 'spikes', 'iceSlide', 'climb']],
    [9, ['ledgeSteps', 'spanPillars', 'canyon', 'tunnelStep', 'doubleWall', 'islands', 'castle', 'iceHill', 'blocks']],
    [15, ['switch', 'pyramid', 'bigWave', 'cliff', 'pillars', 'zigzag', 'stepGap', 'gauntlet', 'tunnel', 'ledge', 'spikes', 'pool']],
  ];
  function typesForV4(k) { let t = []; for (const [from, list] of TIERS_V4) if (k >= from) t = t.concat(list); return t; }
  function sectionV4(seed, k, x, y, only) {
    const lvl = Math.min(k, 50);
    const out = [], coins = [], roofs = [], zones = [];
    const cp = { x: x + 30, y };
    let n = 0;
    const R = () => hash(seed, k, 100 + n++);
    const coin = (cx, cy) => { if (coins.length < 16) coins.push({ id: k * 16 + coins.length, x: cx, y: cy }); };
    const run = (L, m) => { const p = { x0: x, x1: x + L, y0: y, y1: y, wall: 0 }; if (m) p.m = m; out.push(p); x += L; };
    const slope = (L, h, m) => { const p = { x0: x, x1: x + L, y0: y, y1: y + h, wall: 0 }; if (m) p.m = m; out.push(p); x += L; y += h; };
    const wall = (h) => { out.push({ x0: x, x1: x + 24, y0: y + h, y1: y + h, wall: 1, base: y }); coin(x + 12, y + h + 40); x += 24; };
    const gap = (g) => { coin(x + Math.floor(g / 2), y + 60); x += g; };
    const roof = (L, c) => { roofs.push({ x0: x, x1: x + L, yb: y + c }); };
    const zone = (L, depth, kind) => { zones.push({ x0: x, x1: x + L, yb: y, yt: y + depth, kind }); };
    const hump = (amp, L) => {
      for (let s = 0; s < 6; s++) {
        const f0 = s * 64, f1 = (s + 1) * 64, w = Math.floor(L / 6);
        const h0 = Math.floor(amp * f0 * (384 - f0) * 4 / (384 * 384)), h1 = Math.floor(amp * f1 * (384 - f1) * 4 / (384 * 384));
        out.push({ x0: x + s * w, x1: x + s * w + w, y0: y + h0, y1: y + h1, wall: 0 });
      }
      coin(x + Math.floor(L / 2), y + amp + HALF + 10); x += 6 * Math.floor(L / 6);
    };
    const g0 = 70 + lvl * 2;
    const clear = () => Math.max(74, 92 - (lvl >> 2));
    function tunnel(L, stepH) {
      const c = clear();
      if (!stepH) { roof(L, c); coin(x + (L >> 1), y + HALF + 4); run(L); return; }
      const a = L >> 1; roof(a, c); run(a); y += stepH; roof(L - a, c); coin(x + ((L - a) >> 1), y + HALF + 4); run(L - a);
    }
    function obstacle(t) {
      const r1 = R(), r2 = R(), r3 = R();
      switch (t) {
        case 'step': { y += 45 + r1 % (25 + lvl * 2); run(90); coin(x - 45, y + HALF + 40); break; }
        case 'stairs': { const c = 3 + r1 % 3, h = 60 + r2 % (12 + (lvl >> 2)), w = 34 + r3 % 22; for (let i = 0; i < c; i++) { run(w); y += h; } run(80); coin(x - 40, y + HALF); break; }
        case 'stairsDown': { const c = 3 + r1 % 3, h = 24 + r2 % 10, w = 50 + r3 % 20, cl = clear(); roof(c * w, cl); for (let i = 0; i < c; i++) { run(w); y -= h; } run(90); coin(x - 45, y + HALF); break; }
        case 'gap': { gap(g0 + r2 % (40 + lvl * 2)); run(110); break; }
        case 'ramp': { slope(130 + r1 % 70, 50 + r2 % 30); run(40); y += 70 + r3 % 25; run(70); coin(x - 35, y + HALF); break; }
        case 'down': { y -= 50 + r1 % 60; run(60); coin(x - 30, y + HALF); gap(75 + r2 % (25 + (lvl >> 1))); run(110); break; }
        case 'wave': { const c = 2 + r1 % 2, a = 26 + r2 % 12; roof(c * 120, a + clear()); for (let i = 0; i < c; i++) hump(a, 120); run(200); break; }
        case 'bigWave': { const c = 2 + r1 % 2; for (let i = 0; i < c; i++) hump(90 + r2 % (40 + lvl), 180); break; }
        case 'wall': { wall(110 + r1 % (40 + lvl)); run(40); tunnel(150 + r2 % 60, 0); run(200); break; }
        case 'doubleWall': { wall(100 + r1 % (30 + lvl)); run(30); gap(80 + r3 % (30 + (lvl >> 1))); run(30); wall(110 + r2 % (35 + lvl)); run(90); break; }
        case 'stones': { const c = 3 + r1 % 3; for (let i = 0; i < c; i++) { gap(40 + r2 % 30 + lvl); run(40 + r3 % 20); } run(80); break; }
        case 'islands': { const c = 3 + r1 % 2; for (let i = 0; i < c; i++) { gap(50 + r2 % 40 + lvl); y += (i & 1 ? -1 : 1) * (30 + r3 % 40); run(60); } run(80); break; }
        case 'pit': { const d = 60 + r1 % (40 + lvl); y -= d; run(60 + r2 % 40); coin(x - 30, y + HALF); y += d + 20 + r3 % 30; run(100); break; }
        case 'zigzag': { const c = 4 + r1 % 3, h = 30 + r2 % (20 + lvl / 2 | 0); for (let i = 0; i < c; i++) { slope(30, h); slope(30, -h); } run(80); break; }
        case 'tower': { const h = 90 + r1 % (50 + lvl * 2); y += h; run(30 + r2 % 20); coin(x - 15, y + HALF + 30); y -= h; run(110); break; }
        case 'pillars': { const c = 3 + r1 % 2; for (let i = 0; i < c; i++) { gap(45 + r2 % 25); y += 30 + r3 % 30; run(30); } run(90); break; }
        case 'castle': { const c = 3 + r1 % 3, h = 40 + r2 % (30 + lvl); for (let i = 0; i < c; i++) { y += h; run(36); y -= h; run(36 + r3 % 20); } run(60); break; }
        case 'cliff': { y += 140 + r1 % (60 + lvl * 2); run(100); coin(x - 50, y + HALF); break; }
        case 'stepGap': { y += 50 + r1 % (30 + lvl); run(50); gap(g0 + r2 % 40); run(100); break; }
        case 'gauntlet': { wall(100 + r1 % 40); run(40); gap(60 + r2 % 40); run(60); y += 50 + r3 % 40; run(100); break; }
        case 'tunnel': { tunnel(170 + r1 % (80 + lvl * 3), 0); run(230); break; }
        case 'tunnelStep': { tunnel(220 + r1 % 90, 22 + r2 % 12); run(230); break; }
        case 'cobbles': { const c = 7 + r1 % 5, h = 10 + r2 % 6; roof(c * 22, h + clear()); for (let i = 0; i < c; i++) { slope(11, h); slope(11, -h); } run(200); coin(x - 100, y + HALF); break; }
        case 'ledge': { y += 105 + r1 % (35 + lvl); run(100); coin(x - 50, y + HALF + 30); break; }
        case 'ledgeSteps': { const c = 2 + r1 % 2, h = 58 + r2 % (16 + (lvl >> 1)), w = 26 + r3 % 10; for (let i = 0; i < c; i++) { y += h; run(w); } run(70); coin(x - 35, y + HALF); break; }
        case 'kicker': { slope(70, 34 + r1 % 14); run(16); gap(105 + r2 % 30); y -= 30 + r3 % 20; run(140); break; }
        case 'spanPillars': { const c = 3 + r1 % 2, g = 66 + r2 % (18 + (lvl >> 1)); for (let i = 0; i < c; i++) { gap(g); run(22); } gap(g); run(110); break; }
        case 'canyon': { y -= 80 + r1 % 30; run(90 + r2 % 40); coin(x - 45, y + HALF); y += 100 + r3 % (30 + lvl); run(100); break; }
        case 'switch': { tunnel(160 + r1 % 60, 0); run(170 + r3 % 30); y += 105 + r2 % (20 + (lvl >> 1)); run(100); break; }
        case 'pyramid': { const h = 56 + r1 % 14, w = 30 + r2 % 10; for (let i = 0; i < 3; i++) { y += h; run(w); } run(50); for (let i = 0; i < 3; i++) { y -= h; run(w); } run(70); coin(x - 230, y + 3 * h + HALF); break; }
        // ── new in v4
        case 'pool': { const d = 84 + r1 % 16, L = 150 + r2 % (60 + lvl); y -= d; zone(L, d - 24, 1); coin(x + (L >> 1), y + d - 30); run(L); y += d; run(120); break; }
        case 'balls': { const d = 46 + r1 % 12, L = 110 + r2 % (40 + lvl); y -= d; zone(L, d - 8, 2); coin(x + (L >> 1), y + d + 10); run(L); y += d; run(110); break; }
        case 'spikes': { const d = 54 + r1 % 12, L = 70 + r2 % (30 + (lvl >> 1)); coin(x + (L >> 1), y + 90); y -= d; run(L, 2); y += d; run(120); break; }
        case 'iceSlide': { run(30, 1); slope(150 + r1 % 50, -(40 + r2 % 30), 1); run(90 + r3 % 60, 1); coin(x - 40, y + HALF); y += 30 + r3 % 16; run(110); break; }
        case 'iceHill': { slope(100 + r1 % 30, 44 + r2 % 20, 1); run(40, 1); coin(x - 20, y + HALF + 20); run(110); break; }
        case 'climb': { const c = 6 + r1 % 4, h = 30 + r2 % (10 + (lvl >> 2)), w = 30 + r3 % 12; for (let i = 0; i < c; i++) { run(w); y += h; } run(90); coin(x - 45, y + HALF); break; }
        case 'blocks': { const c = 2 + r1 % 2; for (let i = 0; i < c; i++) { wall(70 + r2 % (30 + (lvl >> 1))); run(50 + r3 % 30); } run(80); break; }
      }
    }
    const done = () => ({ pieces: out, coins: coins.sort((p, q) => p.x - q.x || p.id - q.id), roofs, zones, cp, x, y });
    if (k < 1) { run(260); return done(); }
    if (k % 4 === 3) { const L = 360 + R() % 160; const x0 = x; run(L); for (let j = 1; j <= 6; j++) coin(x0 + Math.floor(L * j / 7), y + HALF); return done(); }
    if (only) { run(120); obstacle(only); run(400); return done(); }
    const types = typesForV4(k), chain = 1 + (k >= 9 ? 1 : 0) + (k >= 22 ? 1 : 0);
    const used = [];
    for (let c = 0; c < chain; c++) {
      run(Math.max(60, 100 + R() % 60 - lvl * 2));
      const t = types[R() % types.length]; used.push(t);
      obstacle(t);
    }
    const s = done(); s.types = used; return s;
  }

  function seedToInt(seedHex) {
    if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
    return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
  }
  function initSim(seedHex, version) {
    const v = version || RULES_VERSION;
    if (v >= 4) {
      const y4 = (HALF + START_UP) * SUB;
      return { version: v, seed: seedToInt(seedHex), step: 0, over: 0, shapes: 0, x: 60 * SUB, y: y4, px: 60 * SUB, py: y4,
        ang: 0, gy: y4, legs: null, dlegs: null, roofs: [], zones: [], cps: [], cpI: -1, cpx: 60, cpy: 0, respawn: 0, falls: 0, jam: 0, lostX: 0, lostY: 0, spiked: 0,
        coinI: 0, coins: [], taken: [], score: 0, reach: 0, omega: 0, carry: 0, pieces: [], broken: [], nextK: 0, endX: 0, endY: 0, dist: 0, dead: 0, contact: 0, hits: 0, hold: 0 };
    }
    return { version: v, seed: seedToInt(seedHex), step: 0, over: 0, shapes: 0, x: 60 * SUB, y: (HALF + 4) * SUB, px: 60 * SUB, py: (HALF + 4) * SUB,
      ang: 0, gy: (HALF + 4) * SUB, legs: null, roofs: [], coinI: 0, coins: [], taken: [], score: 0, reach: 0, omega: 0, carry: 0, pieces: [], broken: [], nextK: 0, endX: 0, endY: 0, dist: 0, dead: 0, contact: 0, hits: 0 };
  }
  function ensureTerrain(sim) {
    const need = Math.floor(sim.x / SUB) + 1400;
    while (sim.endX < need) {
      const v3 = sim.version >= 3, v4 = sim.version >= 4;
      const s = v4 ? sectionV4(sim.seed, sim.nextK, sim.endX, sim.endY) : v3 ? sectionV3(sim.seed, sim.nextK, sim.endX, sim.endY) : section(sim.seed, sim.nextK, sim.endX, sim.endY);
      if (v4) { sim.zones = sim.zones.concat(s.zones); sim.cps = sim.cps.concat([s.cp]); }
      for (const p of s.pieces) sim.pieces.push(Object.assign({ k: sim.nextK, i: sim.pieces.length }, p));
      // v3: a section's coins all lie inside its own span, so appending the
      // section's sorted coins keeps the whole list sorted (no global sort).
      if (v3) { sim.coins = sim.coins.concat(s.coins); sim.roofs = sim.roofs.concat(s.roofs); }
      else sim.coins = sim.coins.concat(s.coins).sort((p, q) => p.x - q.x || p.id - q.id);
      sim.endX = s.x; sim.endY = s.y; sim.nextK++;
    }
  }
  function pieceIndexAt(sim, x) { // x in units*SUB
    const P = sim.pieces; let lo = 0, hi = P.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (P[m].x1 * SUB <= x) lo = m + 1; else if (P[m].x0 * SUB > x) hi = m - 1; else return m; }
    return -1;
  }
  function isBroken(sim, i) { return sim.broken.indexOf(i) >= 0; }
  function topAt(p, x) { // sub
    const dx = p.x1 - p.x0;
    return p.y0 * SUB + Math.floor((p.y1 - p.y0) * (x - p.x0 * SUB) / dx);
  }
  // Exit vector for a point inside solid, or null. Returns [ex, ey, kind, pieceIndex].
  function roofExit(sim, X, Y) {
    const F = sim.roofs; let lo = 0, hi = F.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, f = F[m];
      if (f.x1 * SUB <= X) lo = m + 1; else if (f.x0 * SUB > X) hi = m - 1;
      else {
        const yb = f.yb * SUB;
        if (Y <= yb || Y >= yb + ROOF_T * SUB) return null;
        let best = [0, yb - Y, 3, -1 - m], bm = Y - yb;
        const du = yb + ROOF_T * SUB - Y; if (du < bm) { bm = du; best = [0, du, 5, -1 - m]; }
        const dl = X - f.x0 * SUB + 1; if (dl < bm) { bm = dl; best = [-dl, 0, 4, -1 - m]; }
        return best;
      }
    }
    return null;
  }
  function exitOf(sim, X, Y) {
    if (sim.roofs.length) { const r = roofExit(sim, X, Y); if (r) return r; }
    const i = pieceIndexAt(sim, X);
    if (i < 0 || isBroken(sim, i)) return null;
    const p = sim.pieces[i];
    const top = topAt(p, X);
    const bot = (p.wall ? p.base : Math.min(p.y0, p.y1)) * SUB - THICK * SUB;
    if (Y >= top || Y <= bot) return null;
    let best = [0, top - Y, 0, i], bm = top - Y;
    // left face: neighbour on the left is lower (or absent)
    const L = i > 0 && sim.pieces[i - 1].x1 === p.x0 && !isBroken(sim, i - 1) ? sim.pieces[i - 1] : null;
    const lTop = L ? (L.y1 * SUB) : -1e15;
    if (Y > lTop) { const d = X - p.x0 * SUB + 1; if (d < bm) { bm = d; best = [-d, 0, 1, i]; } }
    const R = i + 1 < sim.pieces.length && sim.pieces[i + 1].x0 === p.x1 && !isBroken(sim, i + 1) ? sim.pieces[i + 1] : null;
    const rTop = R ? (R.y0 * SUB) : -1e15;
    if (Y > rTop) { const d = p.x1 * SUB - X; if (d < bm) { bm = d; best = [d, 0, 2, i]; } }
    return best;
  }

  function setShape(sim, raw) {
    if (sim.shapes >= MAX_SHAPES) return false;
    const legs = makeLegs(raw);
    if (!legs) return false;
    if (sim.version >= 4) return setShape4(sim, legs);
    let r2 = 0;
    for (const q of legs) { const d = q[0] * q[0] + q[1] * q[1]; if (d > r2) r2 = d; }
    const reach = Math.max(HALF, Math.floor(isqrt(r2) / SUB));
    sim.legs = legs; sim.reach = reach; sim.shapes++;
    sim.omega = Math.max(OMEGA_MIN, Math.min(OMEGA_MAX, Math.floor(OMEGA_K / reach)));
    sim.carry = Math.max(CARRY_MIN, Math.min(CARRY_MAX, Math.floor(CARRY_K * SUB / (reach * isqrt(reach)))));
    return true;
  }
  function legPoints(sim, ang) {
    const c = cosA(ang), s = sinA(ang), out = [];
    const L = sim.legs || [];
    for (let k = 0; k < L.length; k++) {
      const lx = L[k][0], ly = L[k][1];
      const rx = Math.floor((lx * c - ly * s) / TRIG_ONE), ry = Math.floor((lx * s + ly * c) / TRIG_ONE);
      out.push([rx, ry]); out.push([-rx, -ry]);
    }
    return out;
  }
  const CORNERS = [[-HALF * SUB, -HALF * SUB], [HALF * SUB, -HALF * SUB], [HALF * SUB, HALF * SUB], [-HALF * SUB, HALF * SUB], [0, -HALF * SUB]];

  // One step. The legs turn at a fixed rate. If a leg or cube point is on the
  // terrain, the body pivots about it (the foot grips, the cube swings over it),
  // limited by a bounded push so a fast spin slips instead of launching.
  // Otherwise the body flies ballistically. Penetration is then resolved by
  // moving the body without adding velocity.
  function deepest(sim, offs) {
    let best = null, bd = -1, bk = -1;
    // a planted leg point always wins over a cube corner, so a cube resting on
    // its belly still walks whenever any leg reaches the ground
    for (let k = offs.length - 1; k >= 0; k--) {
      if (k === CORNERS.length - 1 && best) break;
      const e = exitOf(sim, sim.x + offs[k][0], sim.y + offs[k][1] - TOUCH);
      if (!e) continue;
      const d = Math.abs(e[0]) + Math.abs(e[1]);
      if (d > bd) { bd = d; best = e; bk = k; }
    }
    return best ? [best, bk] : null;
  }
  function stepSim(sim) {
    if (sim.version >= 4) { if (!sim.over && !sim.dead) stepSim4(sim); return; }
    if (sim.dead || sim.over) return;
    ensureTerrain(sim);
    const a0 = sim.ang;
    sim.ang = ((sim.ang - (sim.omega || 0)) % ANG + ANG) % ANG;
    const prev = CORNERS.concat(legPoints(sim, a0)), cur = CORNERS.concat(legPoints(sim, sim.ang));
    const ox = sim.x, oy = sim.y;
    let vx = sim.x - sim.px, vy = sim.y - sim.py;
    const grip = deepest(sim, prev);
    if (grip && grip[1] >= CORNERS.length) {
      // pivot about the planted foot
      const k = grip[1];
      let dx = prev[k][0] - cur[k][0], dy = prev[k][1] - cur[k][1];
      if (dx > sim.carry) dx = sim.carry; if (dx < -sim.carry) dx = -sim.carry;
      if (dy > SLIP_UP) dy = SLIP_UP; if (dy < -SLIP_DN) dy = -SLIP_DN;
      vx = Math.floor((vx * CARRY + dx * (256 - CARRY)) / 256);
      vy = dy - GRAV;
      sim.contact = 1;
      const p = grip[0][3] >= 0 ? sim.pieces[grip[0][3]] : null;  // a roof grip has a negative index
      if (p && p.wall && grip[0][2] !== 0) {
        sim.hits += Math.abs(prev[k][0] - cur[k][0]) + Math.abs(prev[k][1] - cur[k][1]);
        if (sim.hits > WALL_HP * SUB) { sim.broken = sim.broken.concat([grip[0][3]]); sim.hits = 0; }
      }
    } else {
      vx = Math.floor(vx * (grip ? GROUND_DAMP : AIR_DAMP) / 256);
      vy = vy - GRAV;
      sim.contact = grip ? 1 : 0;
    }
    if (vx > VMAX) vx = VMAX; if (vx < -VMAX) vx = -VMAX; if (vy > VMAX) vy = VMAX; if (vy < -VMAX) vy = -VMAX;
    sim.x = ox + vx; sim.y = oy + vy;
    for (let pass = 0; pass < PASSES; pass++) {
      let best = null, bd = 0;
      for (let k = 0; k < cur.length; k++) {
        const e = exitOf(sim, sim.x + cur[k][0], sim.y + cur[k][1]);
        if (!e) continue;
        const d = Math.abs(e[0]) + Math.abs(e[1]);
        if (d > bd) { bd = d; best = e; }
      }
      if (!best) break;
      let ex = best[0], ey = best[1];
      if (ex > MAX_PUSH) ex = MAX_PUSH; if (ex < -MAX_PUSH) ex = -MAX_PUSH;
      if (ey > MAX_PUSH) ey = MAX_PUSH; if (ey < -MAX_PUSH) ey = -MAX_PUSH;
      sim.x += ex; sim.y += ey;
      if (best[3] >= 0 && sim.pieces[best[3]].wall && best[2] !== 0) {
        sim.hits += Math.abs(ex);
        if (sim.hits > WALL_HP * SUB) { sim.broken = sim.broken.concat([best[3]]); sim.hits = 0; }
      }
      if (ey > 0 && vy < 0) vy = Math.min(0, vy + ey);
      if (ex !== 0 && ((ex > 0 && vx < 0) || (ex < 0 && vx > 0))) vx = 0;
    }
    sim.px = sim.x - vx; sim.py = sim.y - vy;
    sim.step++;
    const cx = Math.floor(sim.x / SUB), cy = Math.floor(sim.y / SUB);
    for (const c of sim.coins) {
      if (c.x < cx - COIN_R) continue; if (c.x > cx + COIN_R) break;
      if (Math.abs(c.y - cy) <= COIN_R && sim.taken.indexOf(c.id) < 0) sim.taken = sim.taken.concat([c.id]);
    }
    const ux = Math.floor(sim.x / SUB) - 60;
    if (ux > sim.dist) sim.dist = ux;
    sim.score = Math.floor(sim.dist / 10) + COIN_POINTS * sim.taken.length;
    if (sim.contact) sim.gy = sim.y;
    if (sim.y < sim.gy - FALL_DROP * SUB) sim.dead = 1;
    if (sim.step >= RUN_STEPS) sim.over = 1;
  }

  // ── v4 physics (Oct 2026) ────────────────────────────────────────────────
  // A hard rule first: no part of the cube or its legs ever ends a step inside
  // a platform. Legs are tested densely (every leg point and the midpoint after
  // it) with their own radius, so a leg rests ON a surface. If the motor would
  // drive a leg into something it cannot push out of, the motor stalls (the leg
  // jams, as a real one would) and, failing that, the body holds still. A new
  // shape is fitted in place: the cube is lifted (or the shape turned) until
  // the new legs are clear. A fall or a spike sends the cube back to the last
  // checkpoint after RESPAWN steps; the run ends only at RUN_STEPS.
  const LEG_R = 3;                    // leg radius (units)
  const TOL4 = SUB;                   // the most a settled step may overlap terrain
  const OMEGA_K4 = 1300, OMEGA_MIN4 = 9, OMEGA_MAX4 = 22;
  const CARRY_K4 = 4200, CARRY_MIN4 = SUB, CARRY_MAX4 = 4 * SUB;
  const START_UP = 30;                // the cube hovers this far above the track until the first shape
  const RESPAWN = 75;                 // steps from a fall to reappearing at the checkpoint
  const ICE_GRIP = 64, ICE_KEEP = 250, ICE_PULL = 256; // out of 256: a foot on ice carries a quarter, the body glides, gravity pulls down the slope
  const WATER_G = 95, BUOY = 200, WATER_DAMP = 236, PADDLE = 150;
  const BALL_DAMP = 222, BALL_G = 80;
  const WALL_HP4 = 100;
  const SPIKE_H = 30;                 // spike height above the trench floor (units)
  const MIN_REACH6 = 30;              // v6: legs shorter than this are scaled up to it (units), or they never touch the ground
  const TIP6 = 40;                    // v6: sub-units per step per step a cube balanced past an edge tips toward it
  const LEVER = 8;                    // most a blocked leg lifts the body in one step (units)
  function zoneAt(sim, X, Y) {
    const Z = sim.zones || [];
    for (let i = 0; i < Z.length; i++) {
      const z = Z[i]; if (z.x0 * SUB > X) break;
      if (z.x1 * SUB > X && Y > z.yb * SUB && Y < z.yt * SUB) return z;
    }
    return null;
  }
  // pieceIndexAt with a memory of the last hit: neighbouring leg points are
  // nearly always over the same piece. Speed only.
  let LP = null, LI = 0;
  function pieceAt4(sim, X) {
    const P = sim.pieces;
    if (LP === P) {
      for (let j = LI - 1; j <= LI + 1; j++) if (j >= 0 && j < P.length && P[j].x0 * SUB <= X && X < P[j].x1 * SUB) { LI = j; return j; }
    }
    const i = pieceIndexAt(sim, X);
    if (i >= 0) { LP = P; LI = i; }
    return i;
  }
  // (PX, PY), when given, is where the same point was before this step: a
  // point that came in from above leaves through the top, one that came in
  // through a side leaves through that side. Pushing out of the NEAREST face
  // instead shoves a leg pressed down near an edge sideways, off the edge.
  function pieceExit4(sim, X, Y, PX, PY) {
    const i = pieceAt4(sim, X);
    if (i < 0) return null;
    const p = sim.pieces[i];
    // solid all the way down: nothing in the course is ever below a platform,
    // and a leg must not slip under one from a gap and wedge against it.
    // A wall stands on a floor at its base; once broken, the floor remains.
    const brk = isBroken(sim, i);
    if (brk && !p.wall) return null;
    const top = brk ? p.base * SUB : topAt(p, X);
    if (brk) { if (Y >= top) return null; return [0, top - Y, 0, i]; }
    if (Y >= top) return null;
    let best = [0, top - Y, 0, i], bm = top - Y;
    const L = i > 0 && sim.pieces[i - 1].x1 === p.x0 && !isBroken(sim, i - 1) ? sim.pieces[i - 1] : null;
    if (Y > (L ? L.y1 * SUB : -1e15)) { const d = X - p.x0 * SUB + 1; if (d < bm) { bm = d; best = [-d, 0, 1, i]; } }
    const Rn = i + 1 < sim.pieces.length && sim.pieces[i + 1].x0 === p.x1 && !isBroken(sim, i + 1) ? sim.pieces[i + 1] : null;
    const rOk = Y > (Rn ? Rn.y0 * SUB : -1e15), lOk = Y > (L ? L.y1 * SUB : -1e15);
    if (rOk) { const d = p.x1 * SUB - X; if (d < bm) best = [d, 0, 2, i]; }
    if (PY !== undefined) {
      if (PY >= top) return [0, top - Y, 0, i];
      if (lOk && PX < p.x0 * SUB) return [-(X - p.x0 * SUB + 1), 0, 1, i];
      if (rOk && PX >= p.x1 * SUB) return [p.x1 * SUB - X, 0, 2, i];
    }
    return best;
  }
  // Speed only, never a result: a point above every platform top and below
  // every roof bottom near the cube cannot be inside anything, so it is not
  // searched. env4 sets the envelope for an x range; outside a step it is off.
  let E_TOP = Infinity, E_ROOF = -Infinity;
  function env4(sim, xa, xb) {
    const P = sim.pieces; let lo = 0, hi = P.length, top = -Infinity, roof = Infinity;
    while (lo < hi) { const m = (lo + hi) >> 1; if (P[m].x1 * SUB <= xa) lo = m + 1; else hi = m; }
    for (let i = lo; i < P.length && P[i].x0 * SUB <= xb; i++) {
      const p = P[i], t = (p.wall ? (isBroken(sim, i) ? p.base : p.y0) : Math.max(p.y0, p.y1)) * SUB;
      if (t > top) top = t;
    }
    const F = sim.roofs; lo = 0; hi = F.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (F[m].x1 * SUB <= xa) lo = m + 1; else hi = m; }
    for (let i = lo; i < F.length && F[i].x0 * SUB <= xb; i++) if (F[i].yb * SUB < roof) roof = F[i].yb * SUB;
    E_TOP = top; E_ROOF = roof;
  }
  function envOff() { E_TOP = Infinity; E_ROOF = -Infinity; }
  function exitOf4(sim, X, Y, leg, PX, PY) {
    const r = leg ? LEG_R * SUB : 0;
    if (Y - r >= E_TOP && Y + r <= E_ROOF) return null;
    if (sim.roofs.length) {
      const e = roofExit(sim, X, Y + r);
      if (e) {
        // came up from below a roof: it leaves downward
        if (PY !== undefined && PY + r <= sim.roofs[-1 - e[3]].yb * SUB) return [0, sim.roofs[-1 - e[3]].yb * SUB - Y - r, 3, e[3]];
        return e;
      }
    }
    return pieceExit4(sim, X, Y - r, PX, PY === undefined ? undefined : PY - r);
  }
  // Collision points as one flat array [x0, y0, x1, y1, ...]: the cube's
  // corners first (NC of them), then every leg point and its mirror.
  const NC = CORNERS.length;
  function colPts4(sim, ang) {
    const c = cosA(ang), s = sinA(ang), L = sim.dlegs || [];
    const out = new Int32Array(2 * (NC + 2 * L.length));
    for (let k = 0; k < NC; k++) { out[2 * k] = CORNERS[k][0]; out[2 * k + 1] = CORNERS[k][1]; }
    for (let k = 0, o = 2 * NC; k < L.length; k++, o += 4) {
      const lx = L[k][0], ly = L[k][1];
      const rx = Math.floor((lx * c - ly * s) / TRIG_ONE), ry = Math.floor((lx * s + ly * c) / TRIG_ONE);
      out[o] = rx; out[o + 1] = ry; out[o + 2] = -rx; out[o + 3] = -ry;
    }
    return out;
  }
  // [deepest overlap (L1, sub), index of that point]
  function overlap4(sim, x, y, pts, ox, oy, prev) {
    let m = 0, mk = -1;
    for (let k = 0, n = pts.length >> 1; k < n; k++) {
      const e = prev ? exitOf4(sim, x + pts[2 * k], y + pts[2 * k + 1], k >= NC, ox + prev[2 * k], oy + prev[2 * k + 1])
        : exitOf4(sim, x + pts[2 * k], y + pts[2 * k + 1], k >= NC);
      if (!e) continue;
      const d = Math.abs(e[0]) + Math.abs(e[1]); if (d > m) { m = d; mk = k; }
    }
    return [m, mk];
  }
  // Spikes stand SPIKE_H tall on a trench floor. Legs reach the floor between
  // them; the cube itself must not come down among them.
  function spiked4(sim, x, y, pts) {
    for (let k = 0; k < NC; k++) {
      const X = x + pts[2 * k], i = pieceAt4(sim, X);
      if (i >= 0 && sim.pieces[i].m === 2 && y + pts[2 * k + 1] - TOUCH < topAt(sim.pieces[i], X) + SPIKE_H * SUB) return 1;
    }
    return 0;
  }
  function deepest4(sim, x, y, offs) {
    let best = null, bd = -1, bk = -1;
    for (let k = (offs.length >> 1) - 1; k >= 0; k--) {
      if (k === NC - 1 && best) break;
      const e = exitOf4(sim, x + offs[2 * k], y + offs[2 * k + 1] - TOUCH, k >= NC);
      if (!e) continue;
      const d = Math.abs(e[0]) + Math.abs(e[1]);
      if (d > bd) { bd = d; best = e; bk = k; }
    }
    return best ? [best, bk] : null;
  }
  // Lift the cube (or, under a roof, turn the shape) until nothing overlaps.
  // False when the shape cannot fit here at all.
  function fit4(sim) {
    ensureTerrain(sim);   // the course must exist before a shape is fitted to it
    const top = sim.reach + HALF + 8;
    env4(sim, sim.x - (sim.reach + HALF + 4) * SUB, sim.x + (sim.reach + HALF + 4) * SUB);
    sim.hold = 0;
    let q = colPts4(sim, sim.ang);
    for (let up = 0; up <= top; up += 2) if (overlap4(sim, sim.x, sim.y + up * SUB, q)[0] === 0) { sim.y += up * SUB; sim.py += up * SUB; envOff(); return true; }
    for (let da = 64; da <= 512; da += 64) for (let sg = 1; sg >= -1; sg -= 2) {
      const a = ((sim.ang + sg * da) % ANG + ANG) % ANG; q = colPts4(sim, a);
      for (let up = -8; up <= top; up += 4) if (overlap4(sim, sim.x, sim.y + up * SUB, q)[0] === 0) { sim.ang = a; sim.y += up * SUB; sim.py += up * SUB; envOff(); return true; }
    }
    envOff();
    return false;
  }
  function setShape4(sim, legs) {
    let r2 = 0;
    for (const q of legs) { const d = q[0] * q[0] + q[1] * q[1]; if (d > r2) r2 = d; }
    // v6: a drawing too small to reach past the cube is scaled up (same shape)
    // to the smallest legs that work, instead of spinning inside the cube
    if (sim.version >= 6) {
      const r = isqrt(r2);
      if (r > 0 && r < MIN_REACH6 * SUB) { legs = legs.map((q) => [Math.floor(q[0] * MIN_REACH6 * SUB / r), Math.floor(q[1] * MIN_REACH6 * SUB / r)]); r2 = 0; for (const q of legs) { const d = q[0] * q[0] + q[1] * q[1]; if (d > r2) r2 = d; } }
    }
    const reach = Math.max(HALF, Math.floor(isqrt(r2) / SUB));
    const dl = [];
    for (let k = 0; k < legs.length; k++) {
      dl.push(legs[k]);
      if (k + 1 < legs.length) dl.push([(legs[k][0] + legs[k + 1][0]) >> 1, (legs[k][1] + legs[k + 1][1]) >> 1]);
    }
    // a shape that cannot fit where the cube is (say, tall legs in a tunnel)
    // is refused and the old legs stay
    const was = [sim.legs, sim.dlegs, sim.reach, sim.y, sim.py, sim.ang];
    sim.legs = legs; sim.dlegs = dl; sim.reach = reach;
    if (!sim.respawn && !fit4(sim)) { sim.legs = was[0]; sim.dlegs = was[1]; sim.reach = was[2]; sim.y = was[3]; sim.py = was[4]; sim.ang = was[5]; return false; }
    sim.shapes++;
    sim.omega = Math.max(OMEGA_MIN4, Math.min(OMEGA_MAX4, Math.floor(OMEGA_K4 / reach)));
    sim.carry = Math.max(CARRY_MIN4, Math.min(CARRY_MAX4, Math.floor(CARRY_K4 * SUB / (reach * 16 + isqrt(reach) * 64))));
    return true;
  }
  // One attempt at a step with the motor turning w. force >= 0 pivots about
  // that point (a leg that is blocked carries the body instead).
  function tryStep4(sim, a0, w, force) {
    const ang = ((a0 - w) % ANG + ANG) % ANG;
    const prev = colPts4(sim, a0), cur = w ? colPts4(sim, ang) : prev;
    const ox = sim.x, oy = sim.y;
    let vx = sim.x - sim.px, vy = sim.y - sim.py, hits = sim.hits, brk = -1, contact = 0;
    const z = zoneAt(sim, ox, oy), zk = z ? z.kind : 0;
    const g = zk === 1 ? WATER_G : zk === 2 ? BALL_G : GRAV;
    let grip = deepest4(sim, ox, oy, prev);
    if (force >= NC) grip = [exitOf4(sim, ox + prev[2 * force], oy + prev[2 * force + 1] - TOUCH, true) || [0, 0, 0, -1], force];
    const gp = grip && grip[0][3] >= 0 ? sim.pieces[grip[0][3]] : null;
    const ice = gp && gp.m === 1;
    if (grip && grip[1] >= NC) {
      const k = grip[1];
      let dx = prev[2 * k] - cur[2 * k], dy = prev[2 * k + 1] - cur[2 * k + 1];
      const cm = ice ? Math.floor(sim.carry * ICE_GRIP / 256) : sim.carry;
      if (dx > cm) dx = cm; if (dx < -cm) dx = -cm;
      if (dy > SLIP_UP) dy = SLIP_UP; if (dy < -SLIP_DN) dy = -SLIP_DN;
      vx = Math.floor((vx * CARRY + dx * (256 - CARRY)) / 256); vy = dy - g;
      contact = 1;
      if (gp && gp.wall && grip[0][2] !== 0) {
        hits += Math.abs(prev[2 * k] - cur[2 * k]) + Math.abs(prev[2 * k + 1] - cur[2 * k + 1]);
        if (hits > WALL_HP4 * SUB) { brk = grip[0][3]; hits = 0; }
      }
    } else {
      vx = Math.floor(vx * (grip ? (ice ? ICE_KEEP : GROUND_DAMP) : AIR_DAMP) / 256);
      vy = vy - g;
      contact = grip ? 1 : 0;
      // v6: resting on one bottom corner with nothing under its centre, the cube
      // tips off the edge (a real one would; ours cannot rotate, so it slides)
      if (sim.version >= 6 && grip && (grip[1] === 0 || grip[1] === 1)) {
        const iu = pieceAt4(sim, ox), bottom = oy - HALF * SUB - TOUCH - 2 * SUB;
        const under = iu < 0 ? -1e15 : (isBroken(sim, iu) && sim.pieces[iu].wall ? sim.pieces[iu].base * SUB : topAt(sim.pieces[iu], ox));
        if (under < bottom) vx += grip[1] === 0 ? TIP6 : -TIP6;
      }
    }
    // ice: gravity pulls along the slope
    if (ice && gp.y1 !== gp.y0) vx -= Math.floor(GRAV * ICE_PULL * (gp.y1 - gp.y0) / (256 * (gp.x1 - gp.x0)));
    if (zk === 1) {
      // water: buoyancy toward floating with the top of the cube at the surface,
      // drag, and the legs paddle: each submerged leg point pushes the body
      // back against its own motion
      const depth = z.yt * SUB - oy;
      if (depth > 0) vy += Math.floor(BUOY * Math.min(depth, 40 * SUB) / (40 * SUB));
      vx = Math.floor(vx * WATER_DAMP / 256); vy = Math.floor(vy * WATER_DAMP / 256);
      let px = 0, py = 0, nsub = 0;
      for (let k = NC, n = cur.length >> 1; k < n; k++) if (oy + cur[2 * k + 1] < z.yt * SUB) { px += prev[2 * k] - cur[2 * k]; py += prev[2 * k + 1] - cur[2 * k + 1]; nsub++; }
      const N = (cur.length >> 1) - NC;
      if (nsub && N) { vx += Math.floor(px * PADDLE / (256 * N)); vy += Math.floor(py * PADDLE / (256 * 2 * N)); }
    } else if (zk === 2) { vx = Math.floor(vx * BALL_DAMP / 256); vy = Math.floor(vy * BALL_DAMP / 256); }
    if (vx > VMAX) vx = VMAX; if (vx < -VMAX) vx = -VMAX; if (vy > VMAX) vy = VMAX; if (vy < -VMAX) vy = -VMAX;
    let x = ox + vx, y = oy + vy;
    for (let pass = 0; pass < PASSES; pass++) {
      let best = null, bd = 0;
      for (let k = 0, n = cur.length >> 1; k < n; k++) {
        const e = exitOf4(sim, x + cur[2 * k], y + cur[2 * k + 1], k >= NC, ox + prev[2 * k], oy + prev[2 * k + 1]);
        if (!e) continue;
        const d = Math.abs(e[0]) + Math.abs(e[1]);
        if (d > bd) { bd = d; best = e; }
      }
      if (!best) break;
      let ex = best[0], ey = best[1];
      if (ex > MAX_PUSH) ex = MAX_PUSH; if (ex < -MAX_PUSH) ex = -MAX_PUSH;
      if (ey > MAX_PUSH) ey = MAX_PUSH; if (ey < -MAX_PUSH) ey = -MAX_PUSH;
      x += ex; y += ey;
      if (best[3] >= 0 && sim.pieces[best[3]].wall && best[2] !== 0) {
        hits += Math.abs(ex);
        if (hits > WALL_HP4 * SUB) { brk = best[3]; hits = 0; }
      }
      if (ey > 0 && vy < 0) vy = Math.min(0, vy + ey);
      if (ey < 0 && vy > 0) vy = Math.max(0, vy + ey);
      if (ex !== 0 && ((ex > 0 && vx < 0) || (ex < 0 && vx > 0))) vx = 0;
    }
    const ov = brk >= 0 ? [0, -1] : overlap4(sim, x, y, cur, ox, oy, prev);
    return { x, y, vx, vy, ang, hits, brk, contact, res: ov[0], deep: ov[1], w };
  }
  function respawn4(sim) {
    sim.x = sim.cpx * SUB; sim.y = (sim.cpy + HALF + START_UP) * SUB; sim.px = sim.x; sim.py = sim.y;
    sim.gy = sim.y; sim.hits = 0; sim.contact = 0;
    fit4(sim);
  }
  function stepSim4(sim) {
    ensureTerrain(sim);
    if (sim.respawn) { sim.respawn--; if (!sim.respawn) respawn4(sim); }
    else if (sim.legs) {
      const a0 = sim.ang;
      let best = null;
      const reachE = sim.reach + HALF + 18 + 54 + LEVER + 4;
      env4(sim, sim.x - reachE * SUB, sim.x + reachE * SUB);
      // a held step whose state has not changed holds again: the same inputs
      // give the same answer, so it is not recomputed
      const H = sim.hold;
      const same = H && H[0] === sim.x && H[1] === sim.y && H[2] === sim.ang && H[3] === sim.shapes && H[4] === sim.broken.length && sim.px === sim.x && sim.py === sim.y;
      // the motor at full turn; then the blocked leg carrying the body; then a
      // lever lift; then half a turn, no turn, and holding still
      // A blocked leg pushes the body back along its own motion (prev - cur of
      // the blocked point), or straight up: the first short shift that frees it.
      const lever = (r) => {
        const q = colPts4(sim, r.ang), p0 = colPts4(sim, a0);
        let rx = 0, ry = 0;
        if (r.deep >= NC) { rx = p0[2 * r.deep] - q[2 * r.deep]; ry = p0[2 * r.deep + 1] - q[2 * r.deep + 1]; }
        const n = Math.max(Math.abs(rx), Math.abs(ry)) || 1;
        const dirs = [[0, SUB]];
        if (rx || ry) dirs.unshift([Math.floor(rx * SUB / n), Math.floor(ry * SUB / n)], [rx ? (rx > 0 ? SUB : -SUB) : 0, 0]);
        // never faster than a foot can carry the body in a step
        const mmax = Math.min(LEVER, Math.max(2, Math.ceil(sim.carry / SUB)));
        for (let m = 1; m <= mmax; m++) for (const d of dirs) {
          if (!d[0] && !d[1]) continue;
          if (overlap4(sim, r.x + d[0] * m, r.y + d[1] * m, q)[0] <= TOL4) {
            r.x += d[0] * m; r.y += d[1] * m; r.res = 0;
            if (d[1] > 0 && r.vy < 0) r.vy = 0; if (d[1] < 0 && r.vy > 0) r.vy = 0;
            return;
          }
        }
      };
      const tries = [[sim.omega, -1], [sim.omega, -2], [sim.omega >> 1, -1], [0, -1]];
      let first = null;
      if (same) best = { x: sim.x, y: sim.y, vx: 0, vy: 0, ang: a0, hits: sim.hits, brk: -1, contact: sim.contact, res: 0, w: 0, stay: 1 };
      for (let t = 0; t < tries.length && !same; t++) {
        const force = tries[t][1] === -2 ? (first && first.deep >= NC ? first.deep : -3) : -1;
        if (force === -3) continue;
        const r = tryStep4(sim, a0, tries[t][0], force);
        if (!first) first = r;
        if (r.res > TOL4 && t < 2) lever(r);
        if (r.res <= TOL4) { best = r; break; }
        if (!best || r.res < best.res) best = r;
      }
      if (best.res > TOL4) {
        // hold still: the step before was settled
        const st = overlap4(sim, sim.x, sim.y, colPts4(sim, a0));
        if (st[0] <= best.res) best = { x: sim.x, y: sim.y, vx: 0, vy: 0, ang: a0, hits: sim.hits, brk: -1, contact: sim.contact, res: st[0], w: 0, stay: 1 };
      }
      // a leg straining against a block stack wears it down even when it is held back
      if (best !== first && first) { if (first.hits > best.hits) best.hits = first.hits; if (best.brk < 0) best.brk = first.brk; }
      // a step that changed nothing is a fixed point: mark it so the next one is not recomputed
      sim.hold = best.x === sim.x && best.y === sim.y && best.ang === a0 && best.vx === 0 && best.vy === 0 && best.hits === sim.hits && best.brk < 0
        ? [sim.x, sim.y, a0, sim.shapes, sim.broken.length] : 0;
      sim.x = best.x; sim.y = best.y; sim.ang = best.ang; sim.hits = best.hits; sim.contact = best.contact;
      sim.px = sim.x - best.vx; sim.py = sim.y - best.vy;
      sim.jam = best.w < sim.omega ? 1 : 0;
      if (best.brk >= 0) sim.broken = sim.broken.concat([best.brk]);
      const cx = Math.floor(sim.x / SUB), cy = Math.floor(sim.y / SUB);
      for (const c of sim.coins) {
        if (c.x < cx - COIN_R) continue; if (c.x > cx + COIN_R) break;
        if (Math.abs(c.y - cy) <= COIN_R && sim.taken.indexOf(c.id) < 0) sim.taken = sim.taken.concat([c.id]);
      }
      const ux = cx - 60;
      if (ux > sim.dist) sim.dist = ux;
      sim.score = Math.floor(sim.dist / 10) + COIN_POINTS * sim.taken.length;
      // a checkpoint counts once the cube stands past it
      const C = sim.cps;
      while (sim.cpI + 1 < C.length && C[sim.cpI + 1].x <= cx && sim.contact) { sim.cpI++; sim.cpx = C[sim.cpI].x; sim.cpy = C[sim.cpI].y; }
      if (sim.contact || zoneAt(sim, sim.x, sim.y)) sim.gy = sim.y;
      const sp = spiked4(sim, sim.x, sim.y, colPts4(sim, sim.ang));
      if (sp || sim.y < sim.gy - FALL_DROP * SUB) {
        // v5: a fall or a spike ends the run. v4 sent the cube back to a checkpoint.
        if (sim.version >= 5) { sim.dead = 1; sim.falls++; sim.lostX = cx; sim.lostY = cy; sim.spiked = sp; sim.hold = 0; }
        else { sim.respawn = RESPAWN; sim.falls++; sim.lostX = cx; sim.lostY = cy; sim.spiked = sp; sim.hold = 0; }
      }
      envOff();
    }
    sim.step++;
    if (sim.step >= RUN_STEPS) sim.over = 1;
  }

// ==== END RULES BLOCK ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it. The run itself stops at RUN_STEPS.
const MAX_SIM_STEPS = 60 * 60 * 60;

function isStep(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }

function init({ seed, maxDurationSecs, elapsedSecs, onStep } = {}) {
  return {
    mode: 'none', sim: null, onStep: typeof onStep === 'function' ? onStep : null,
    seed: typeof seed === 'string' ? seed : null, nextN: 0,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600, elapsedSecs: Number(elapsedSecs) || 0,
    stats: { pts: [], len: [], turns: [], gaps: [], lead: [], lastStep: -1, area: [] },
  };
}

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && !sim.over && sim.step < step && sim.step < MAX_SIM_STEPS) {
    stepSim(sim);
    if (state.onStep) state.onStep(sim);
  }
}
function reject(state, reason) { state.rejectCount++; return { accepted: true, newScore: state.score, reason }; }

// ── raw material for the bot detector: recorded, never gated ─────────────
// Per stroke: raw point count, length, direction reversals (a hand wobbles, a
// program draws clean curves), bounding area, steps since the last stroke, and
// how far ahead (units) the next obstacle was when it was drawn (a planner
// redraws at the same lead every time; a hand early or late and unevenly).
function noteStroke(state, pts) {
  const st = state.stats, sim = state.sim;
  let L = 0, turns = 0, pdx = 0, pdy = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    if (i) {
      const dx = p[0] - pts[i - 1][0], dy = p[1] - pts[i - 1][1];
      L += isqrt(dx * dx + dy * dy);
      if (i > 1 && dx * pdx + dy * pdy < 0) turns++;
      pdx = dx; pdy = dy;
    }
  }
  st.pts.push(pts.length); st.len.push(L); st.turns.push(turns); st.area.push((x1 - x0) * (y1 - y0));
  if (st.lastStep >= 0) st.gaps.push(sim.step - st.lastStep);
  st.lastStep = sim.step;
  const cx = Math.floor(sim.x / SUB);
  let ahead = null, lastY = null;
  for (const p of sim.pieces) {
    if (p.x1 <= cx) { lastY = p.y1; continue; }
    if (p.wall || p.y0 !== p.y1 || (lastY !== null && p.y0 !== lastY)) { ahead = Math.max(0, p.x0 - cx); break; }
    lastY = p.y1;
  }
  if (ahead !== null) st.lead.push(ahead);
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const payload = event.payload || {};
  if (payload.kind === 'start') {
    if (Number(payload.v) >= 2 && state.mode !== 'sim') { state.mode = 'sim'; state.sim = initSim(state.seed, Number(payload.v)); }
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim' || payload.kind !== 'shape') return { accepted: true, newScore: state.score };
  const sim = state.sim;
  const { n, step, pts } = payload;
  if (n !== state.nextN) return reject(state, 'out_of_order');
  if (!isStep(step) || !Array.isArray(pts) || pts.length < 2 || pts.length > RAW_MAX) return reject(state, 'bad_shape');
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  state.score = sim.score;
  if (sim.dead || sim.over) { state.dead = true; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  if (!setShape(sim, pts)) return reject(state, 'bad_shape');
  state.nextN++; state.inputCount++;
  noteStroke(state, pts);
  return { accepted: true, newScore: state.score };
}

function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) { if (xs.length < 2) return null; const m = mean(xs); let s = 0; for (const x of xs) s += (x - m) * (x - m); return Math.sqrt(s / (xs.length - 1)); }
function r3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out to the clock (the run always ends at RUN_STEPS), bounded
  // by how long the session really lasted.
  const cap = Math.min(MAX_SIM_STEPS, RUN_STEPS, elapsedCap(state, 60));
  if (sim.legs) advanceTo(state, cap);
  const st = state.stats;
  return {
    score: sim.score, gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, dead: !!sim.dead, over: !!sim.over, falls: sim.falls || 0, dist: sim.dist, coins: sim.taken.length, score: sim.score,
      shapes: state.inputCount, rejects: state.rejectCount,
      ptsMean: r3(mean(st.pts)), ptsSd: r3(sd(st.pts)), lenMean: r3(mean(st.len)), lenSd: r3(sd(st.len)),
      turnsMean: r3(mean(st.turns)), areaSd: r3(sd(st.area)),
      gapMean: r3(mean(st.gaps)), gapSd: r3(sd(st.gaps)), leadMean: r3(mean(st.lead)), leadSd: r3(sd(st.lead)),
      redrawsPer100m: sim.dist > 0 ? r3(state.inputCount / (sim.dist / 1000)) : null,
    },
  };
}

function simulate(seed, inputs) { const s = init({ seed }); for (const ev of inputs) processEvent(s, ev); return finalize(s).score; }

module.exports = {
  _limits: { MAX_SIM_STEPS, FPS: 60 },
  init, processEvent, finalize, simulate,
  _sim: { sectionV3, sectionV4, ROOF_T, RULES_VERSION, RUN_STEPS, RAW_MAX, MAX_SHAPES, initSim, stepSim, setShape, makeLegs, seedToInt, hash, sinA, cosA, isqrt, SIN_Q, MAX_SIM_STEPS },
};
