'use strict';

/**
 * Chor Police validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * The game: a Mehran drives itself through an endless Pakistani city while
 * police chase it. Holding the left or right half of the screen steers. Police,
 * traffic, roadblocks, spike strips, the helicopter, ramps and pickups all come
 * from the session seed and the rules; the score is seconds survived plus
 * police crashes (with combos), near misses, jumps and cash.
 *
 * What the server does with a trace:
 *   1. rebuilds the city from the session seed: chunk (cx, cy) is a pure
 *      function of (seed, cx, cy), every chaser spawn of (seed, step);
 *   2. replays each hold { n, dir, pressStep, releaseStep }: the steps up to
 *      pressStep run straight, the steps up to releaseStep run steered;
 *   3. runs the same fixed steps and counts what the client would have scored.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/chor-police/js/rules.js.
 * shared/tests/chorPoliceParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump, never an edit
 * in place.
 *
 * Integer arithmetic only: + - * / (exact or truncated), floor/trunc, min/max,
 * imul and bit ops, Math.sqrt only inside isqrt (correctly rounded by IEEE),
 * angles from the SIN_Q table. No trig, no Math.random, no clock, no screen.
 */

/* eslint-disable no-var */
  // CHOR POLICE RULES BEGIN
  const RULES_VERSION = 4;
  const ANG = 1024, SC = 16384;      // a full turn; sine scale
  const M = 256;                     // units per metre
  const TILE = 1024, CH = 16;        // tile size (units), chunk size (tiles)
  const SAND = 0, GRASS = 1, ROAD = 2, WALK = 3, BLD = 4, WATER = 5, BRIDGE = 6, RAIL = 7;
  const SIN_Q = [0,101,201,302,402,503,603,704,804,904,1005,1105,1205,1306,1406,1506,1606,1706,1806,1906,2006,2105,2205,2305,2404,2503,2603,2702,2801,2900,2999,3098,3196,3295,3393,3492,3590,3688,3786,3883,3981,4078,4176,4273,4370,4467,4563,4660,4756,4852,4948,5044,5139,5235,5330,5425,5520,5614,5708,5803,5897,5990,6084,6177,6270,6363,6455,6547,6639,6731,6823,6914,7005,7096,7186,7276,7366,7456,7545,7635,7723,7812,7900,7988,8076,8163,8250,8337,8423,8509,8595,8680,8765,8850,8935,9019,9102,9186,9269,9352,9434,9516,9598,9679,9760,9841,9921,10001,10080,10159,10238,10316,10394,10471,10549,10625,10702,10778,10853,10928,11003,11077,11151,11224,11297,11370,11442,11514,11585,11656,11727,11797,11866,11935,12004,12072,12140,12207,12274,12340,12406,12472,12537,12601,12665,12729,12792,12854,12916,12978,13039,13100,13160,13219,13279,13337,13395,13453,13510,13567,13623,13678,13733,13788,13842,13896,13949,14001,14053,14104,14155,14206,14256,14305,14354,14402,14449,14497,14543,14589,14635,14680,14724,14768,14811,14854,14896,14937,14978,15019,15059,15098,15137,15175,15213,15250,15286,15322,15357,15392,15426,15460,15493,15525,15557,15588,15619,15649,15679,15707,15736,15763,15791,15817,15843,15868,15893,15917,15941,15964,15986,16008,16029,16049,16069,16088,16107,16125,16143,16160,16176,16192,16207,16221,16235,16248,16261,16273,16284,16295,16305,16315,16324,16332,16340,16347,16353,16359,16364,16369,16373,16376,16379,16381,16383,16384,16384];

  // Vehicle types: radius (units), mass, top speed on road / off road
  // (units per step), acceleration, turn per step, grip (of 256), the impact
  // that wrecks it against a wall / a vehicle, and the points its crash pays.
  const PLAYER = 0, POLICE = 1, SWAT = 2, JEEP = 3, RICKSHAW = 4, BUS = 5, CAR = 6, MOTO = 7;
  const TYPES = [
    { r: 256, off: 218, m: 2, vmax: 88, voff: 72, acc: 4, turn: 18, grip: 64, dgrip: 30, wreckWall: 9999, wreckCar: 9999, pts: 0 },
    { r: 268, off: 270, m: 2, vmax: 92, voff: 74, acc: 3, turn: 12, grip: 44, dgrip: 18, wreckWall: 40, wreckCar: 34, pts: 10 },
    { r: 307, off: 410, m: 5, vmax: 80, voff: 64, acc: 2, turn: 8, grip: 48, dgrip: 20, wreckWall: 60, wreckCar: 72, pts: 20 },
    { r: 260, off: 280, m: 3, vmax: 98, voff: 88, acc: 3, turn: 12, grip: 44, dgrip: 18, wreckWall: 46, wreckCar: 44, pts: 20 },
    { r: 205, off: 150, m: 1, vmax: 50, voff: 40, acc: 2, turn: 10, grip: 60, dgrip: 30, wreckWall: 9999, wreckCar: 30, pts: 0 },
    { r: 380, off: 560, m: 8, vmax: 44, voff: 36, acc: 1, turn: 6, grip: 70, dgrip: 40, wreckWall: 9999, wreckCar: 9999, pts: 0 },
    { r: 250, off: 210, m: 2, vmax: 58, voff: 44, acc: 2, turn: 10, grip: 60, dgrip: 30, wreckWall: 9999, wreckCar: 40, pts: 0 },
    { r: 150, off: 80, m: 1, vmax: 60, voff: 46, acc: 3, turn: 10, grip: 70, dgrip: 40, wreckWall: 9999, wreckCar: 9999, pts: 0 }
  ];
  const STEPS_PER_SEC = 60;
  const HEARTS = 5, INVULN = 80, WALL_DMG = 52, RAM_DMG = 30;
  const REST = 77;                   // bounce, of 256
  const WRECK_FRICTION = 10;         // of 256 per step
  const CAP_BY_LEVEL = [0, 2, 3, 4, 6, 7];
  const MAX_VEH = 26;                // live chasers + wrecks + player, for the rules
  const SPAWN_GAP = 50, SPAWN_MIN = 45 * M, SPAWN_SPREAD = 20 * M;
  const FRONT_COS = 12550;           // about 40 degrees: nobody spawns in front of you
  const DESPAWN_LIVE = 115 * M, DESPAWN_WRECK = 80 * M;
  const LEVEL_STEPS = 1500, LEVEL_WRECKS = 5;
  const BOX_SPEED = 22, BOX_STEPS = 120, BOX_NEAR = 6 * M;
  const NEAR_GAP = 300, NEAR_REL = 40, NEAR_CD = 90, NEAR_PTS = 3;
  const CASH_R = 410, CASH_PTS = 5;
  const START_GUARD = 150;
  const COMBO_STEPS = 180;            // steps with no chasers at all

  function sinA(a) {
    a = ((a % ANG) + ANG) % ANG;
    const q = a >> 8, i = a & 255;
    if (q === 0) return SIN_Q[i];
    if (q === 1) return SIN_Q[256 - i];
    if (q === 2) return -SIN_Q[i] | 0;
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
  function seedToInt(seedHex) {
    if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
    return (parseInt(seedHex.slice(0, 8), 16) ^ Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, 0x9e3779b1)) >>> 0;
  }

  // ── the city: chunk (cx, cy) is a pure function of (seed, cx, cy) ──
  // Roads run along the west (x 0..2) and north (y 0..2) edge of every chunk;
  // sidewalks at 3 and 15; the block interior 4..14 is four 5 x 5 quads.
  function districtOf(seed, cx, cy) {
    const rx = Math.floor(cx / 3), ry = Math.floor(cy / 3);
    if (rx === 0 && ry === 0) return 1;
    return hash(seed, rx * 7919 + ry, 11) % 4;  // 0 Lahore, 1 Karachi, 2 desert, 3 park
  }
  function isCanalRow(seed, cy) { return cy !== 0 && cy !== -1 && hash(seed, cy, 23) % 4 === 0; }
  function genChunk(seed, cx, cy) {
    const t = new Uint8Array(CH * CH), lots = [], trees = [];
    const d = districtOf(seed, cx, cy), canal = isCanalRow(seed, cy);
    const base = d === 3 ? GRASS : SAND;
    // Some streets dead-end: the west road (vertical) or the north road
    // (horizontal) of a chunk is missing and a building closes it, so no
    // avenue runs straight for ever. Never both, never at the start.
    const hr = hash(seed, cx * 389 + cy * 7, 41), start = cx === 0 && (cy === 0 || cy === -1);
    const noV = !start && !canal && hr % 4 === 0, noH = !start && !noV && (hr >>> 3) % 4 === 0;
    for (let y = 0; y < CH; y++) for (let x = 0; x < CH; x++) {
      let v = base;
      if ((x <= 2 && !(noV && y >= 3)) || (y <= 2 && !(noH && x >= 3))) v = ROAD;
      else if (x === 3 || x === 15 || y === 3 || y === 15 || x <= 2 || y <= 2) v = WALK;
      t[y * CH + x] = v;
    }
    if (noV) lots.push([0, 5, 2, 13, d === 0 ? 0 : 1, 2, (hr >>> 6) & 7]);
    if (noH) lots.push([5, 0, 13, 2, d === 0 ? 0 : 1, 2, (hr >>> 6) & 7]);
    if (canal) {
      for (let y = 7; y <= 10; y++) for (let x = 0; x < CH; x++) {
        t[y * CH + x] = x <= 2 ? BRIDGE : (x === 3 || x === 15) ? RAIL : WATER;
      }
      for (let x = 4; x <= 14; x++) { t[6 * CH + x] = GRASS; t[11 * CH + x] = GRASS; }
      for (let k = 0; k < 4; k++) { const h = hash(seed, cx * 131 + cy, 300 + k); trees.push([4 + (h % 11), (k & 1) ? 11 : 6, 1, h >>> 8]); }
    } else {
      for (let q = 0; q < 4; q++) {
        const qx = q & 1 ? 10 : 4, qy = q & 2 ? 10 : 4, h = hash(seed, cx * 977 + cy * 131, q);
        const col = (h >>> 4) & 7, fl = (h >>> 8) & 3;
        if (d === 0) {
          if (h % 3) lots.push([qx, qy, qx + 4, qy + 4, 0, 2 + fl % 3, col]);
          else { lots.push([qx, qy, qx + 4, qy + 1, 0, 2 + fl % 2, col]); lots.push([qx, qy + 3, qx + 4, qy + 4, 0, 3, col + 1]); }
        } else if (d === 1) {
          const ox = h & 1, oy = (h >>> 1) & 1;
          lots.push([qx + ox, qy + oy, qx + ox + 3, qy + oy + 3, 1, 2 + fl, col]);
          trees.push([qx + (ox ? 0 : 4), qy + (oy ? 0 : 4), 0, h >>> 12]);
        } else if (d === 2) {
          if (h % 5 < 2) lots.push([qx + 1, qy + 1, qx + 3, qy + 3, 2, 1, col]);
          trees.push([qx + (h >>> 3) % 5, qy + (h >>> 6) % 5, 0, h >>> 12]);
          if (h % 7 === 0) trees.push([qx + (h >>> 9) % 5, qy + (h >>> 11) % 5, 0, h >>> 14]);
        } else {
          if (q === 0 && h % 3 === 0) lots.push([qx, qy, qx + 4, qy + 4, 3, 1, col]);
          else { trees.push([qx + 1, qy + 1, 2, h >>> 12]); trees.push([qx + 3, qy + 3, 2, h >>> 15]); if (h % 2) trees.push([qx + 3, qy + 1, 1, h >>> 17]); }
        }
      }
      for (let i = 0; i < lots.length; i++) {
        const L = lots[i];
        for (let y = L[1]; y <= L[3]; y++) for (let x = L[0]; x <= L[2]; x++) t[y * CH + x] = BLD;
      }
    }
    // one cash note on the west road, away from the junction and the canal
    const hc = hash(seed, cx * 53 + cy * 17, 77);
    let cyT = 4 + hc % 11; if (canal && cyT >= 6 && cyT <= 11) cyT = 4;
    // a heart (an extra life) on the north road; heart[2] is the draw that
    // decides, by rules version, whether this chunk has one (heartOn)
    const hh = hash(seed, cx * 29 + cy * 61, 88);
    const heart = !start && !noH ? [4 + (hh >>> 4) % 10, 1, hh % 32] : null;
    // a ramp on the west road of one chunk in four, in one lane, facing along the road
    const hr2 = hash(seed, cx * 43 + cy * 97, 91);
    const rax = (hr2 >>> 9) & 1;
    const ramp = !start && hr2 % 2 === 0 && (rax ? !noH : (!noV && !canal)) ? [rax, ((hr2 >>> 3) & 1) ? 3 : 9, 6 + (hr2 >>> 5) % 7] : null;   // axis, lane metre, tile
    const hn = hash(seed, cx * 71 + cy * 13, 99);
    const nitro = !start && hn % 3 === 0 && !noV ? [1, 5 + (hn >>> 4) % 8] : null;   // on the west road, tile x 1
    return { t: t, d: d, canal: canal, lots: lots, trees: trees, cash: [hc % 3, cyT], heart: heart, ramp: ramp, nitro: nitro };
  }
  const CACHE = new Map();
  function chunk(seed, cx, cy) {
    const k = seed + ':' + cx + ':' + cy;
    let c = CACHE.get(k);
    if (!c) {
      c = genChunk(seed, cx, cy);
      if (CACHE.size > 600) CACHE.delete(CACHE.keys().next().value);
      CACHE.set(k, c);
    }
    return c;
  }
  function tileAt(seed, tx, ty) {
    const cx = Math.floor(tx / CH), cy = Math.floor(ty / CH);
    return chunk(seed, cx, cy).t[(ty - cy * CH) * CH + (tx - cx * CH)];
  }
  function solid(v) { return v === BLD || v === RAIL; }
  function tileUnder(seed, x, y) { return tileAt(seed, Math.floor(x / TILE), Math.floor(y / TILE)); }

  // ── vehicles ────────────────────────────────────────────────────
  function newVeh(sim, type, x, y, h) {
    const T = TYPES[type];
    return { id: sim.nextId++, type: type, x: x, y: y, vx: 0, vy: 0, h: h, r: T.r, m: T.m, wreck: 0, lat: 0, fwd: 0, nearCd: 0, hit: 0, sr: 0, aiTurn: 0, mode: 0, mt: 0, cool: 40, tgx: 0, tgy: 0, air: 0, airT: 0, spiked: 0, parked: 0 };
  }
  // v2: half the eligible chunks; v3: 19 in 32 (about 19% more hearts)
  function heartOn(k, version) {
    if (!k.heart) return false;
    return version >= 3 ? k.heart[2] < 19 : k.heart[2] % 2 === 0;
  }
  function initSim(seedHex, version) {
    const sim = {
      version: version || RULES_VERSION, seed: seedToInt(seedHex), step: 0, over: 0, cause: '',
      score: 0, bonus: 0, hearts: HEARTS, inv: 0, wanted: 1, wrecks: 0, nextId: 0, nextSpawn: START_GUARD,
      steer: 0, stuck: 0, veh: [], cash: {}, hearts_: {}, events: [], spawns: 0, hist: [], combo: 0, lastWreck: -9999, heli: null, drops: [], dramps: [], spikes: [], nitro: 0, nitro_: {}, nextBlock: 900, nextSpike: 600, boost: 0, strt: 0, jumps: 0, nears: 0, cashN: 0, bestCombo: 0, livesTaken: 0
    };
    const p = newVeh(sim, PLAYER, Math.floor(1.5 * TILE), Math.floor(12.5 * TILE), 0);
    p.vy = -88; p.fwd = 88;
    sim.veh.push(p);
    // the chase is already on: two police right behind you from the first step
    for (let k = 0; k < 2; k++) {
      const c = newVeh(sim, POLICE, Math.floor((0.9 + k * 1.2) * TILE), Math.floor((16.5 + k * 1.4) * TILE), 0);
      c.vy = -60; c.fwd = 60; sim.veh.push(c);
    }
    return sim;
  }
  function setSteer(sim, dir) { sim.steer = dir < 0 ? -1 : dir > 0 ? 1 : 0; }

  // A chaser steers at where the player will be, feels for walls and water
  // with three feelers, slows for a sharp turn, and rams when close.
  function blockedAt(seed, x, y) { const v = tileUnder(seed, x, y); return solid(v) || v === WATER; }
  // Police see you a moment LATE (REACT steps ago) and predict from that, so a
  // sudden turn buys you distance. Close in, they line up and LUNGE: a committed
  // burst at where you were heading. Dodge it and they overshoot, then need a
  // moment to recover. That rhythm is the game.
  const REACT = 9, LUNGE_RANGE = 15 * M, LUNGE_STEPS = 26, RECOVER_STEPS = 34;
  function aiSteer(sim, c, p) {
    const T = TYPES[c.type];
    const seen = sim.hist[Math.max(0, sim.hist.length - REACT)] || [p.x, p.y, p.vx, p.vy];
    const dx = p.x - c.x, dy = p.y - c.y, dist = isqrt(dx * dx + dy * dy);
    const S = sinA(c.h), C = cosA(c.h);
    let tx, ty;
    if (c.mode === 1) { tx = c.tgx - c.x; ty = c.tgy - c.y; }            // committed: no corrections
    else {
      const spd = Math.max(20, c.fwd), look = Math.min(40, Math.floor(dist / spd));
      tx = seen[0] + seen[2] * (look + REACT) - c.x; ty = seen[1] + seen[3] * (look + REACT) - c.y;
    }
    const side = tx * C + ty * S;             // > 0: target on the right
    const ahead = tx * S - ty * C;            // > 0: target in front
    let turn = side > 0 ? 1 : side < 0 ? -1 : 0;
    if (ahead > 0 && Math.abs(side) * 12 < ahead) turn = 0;
    const F = Math.max(8 * M, c.fwd * 26), FS = 6 * M;
    const fx = c.x + Math.trunc(S * F / SC), fy = c.y - Math.trunc(C * F / SC);
    const lS = sinA(c.h - 85), lC = cosA(c.h - 85), rS = sinA(c.h + 85), rC = cosA(c.h + 85);
    const lb = blockedAt(sim.seed, c.x + Math.trunc(lS * FS / SC), c.y - Math.trunc(lC * FS / SC));
    const rb = blockedAt(sim.seed, c.x + Math.trunc(rS * FS / SC), c.y - Math.trunc(rC * FS / SC));
    const fb = blockedAt(sim.seed, fx, fy);
    let slow = 0;
    if (c.mode !== 1) {
      if (fb) { turn = lb && !rb ? 1 : rb && !lb ? -1 : turn === 0 ? ((c.id & 1) ? 1 : -1) : turn; slow = 1; }
      else if (lb && turn < 0 && !rb) turn = 0;
      else if (rb && turn > 0 && !lb) turn = 0;
    }
    // the player's true position relative to this car, for lunging
    const pa = dx * S - dy * C, ps = dx * C + dy * S;
    if (c.mode === 0 && c.cool <= 0 && dist < LUNGE_RANGE && pa > 0 && Math.abs(ps) * 3 < pa) {
      c.mode = 1; c.mt = LUNGE_STEPS;
      c.tgx = p.x + p.vx * 14; c.tgy = p.y + p.vy * 14;                 // where you were heading, then committed
      sim.events.push(['lunge', c.id]);
    } else if (c.mode === 1 && (--c.mt <= 0 || pa < -4 * M)) { c.mode = 2; c.mt = RECOVER_STEPS; }
    else if (c.mode === 2 && --c.mt <= 0) { c.mode = 0; c.cool = 30; }
    if (c.cool > 0) c.cool--;
    c.aiTurn = turn;
    const surf = tileUnder(sim.seed, c.x, c.y);
    let vmax = surf === ROAD || surf === BRIDGE || surf === WALK ? T.vmax : T.voff;
    if (c.mode === 1) vmax += (vmax * 3) >> 3;                          // the lunge
    else if (c.mode === 2) vmax = (vmax * 13) >> 4;                     // shaken off, recovering
    else if (dist > 45 * M) vmax = sim.version >= 4 ? Math.max(vmax + (vmax >> 3), p.fwd + 4) : vmax + (vmax >> 3);   // catch up from far away (v4: keeps pace with a boosted player)
    else if (dist < 28 * M) vmax = Math.min(vmax, TYPES[PLAYER].vmax + 3); // close: creep up, then lunge
    if (slow && c.mode !== 1) vmax = (vmax * 5) >> 3;
    return vmax;
  }

  function drive(sim, v, steer, vmax) {
    const T = TYPES[v.type];
    if (v.air > 0) { if (steer) v.h = (v.h + steer * (T.turn >> 1) + ANG) % ANG; return; }   // in the air: no grip, a little spin
    // steering eases in (full lock in 6 steps) and lets go faster (3 steps)
    const want = steer * T.turn * 8;
    if (v.sr < want) v.sr = Math.min(want, v.sr + (v.sr < 0 ? 24 : 16));
    else if (v.sr > want) v.sr = Math.max(want, v.sr - (v.sr > 0 ? 24 : 16));
    // the nose may lead the direction of travel by at most ~35 degrees (lat <= 0.7 fwd):
    // past that the wheel stops rotating the body, so a drift never becomes a spin
    if (v.sr) {
      const dh = Math.trunc(v.sr / 8), S0 = sinA(v.h + dh), C0 = cosA(v.h + dh);
      const f0 = Math.trunc((v.vx * S0 - v.vy * C0) / SC), l0 = Math.trunc((v.vx * C0 + v.vy * S0) / SC);
      if (Math.abs(l0) * 10 <= Math.max(f0, 16) * 7 || (l0 > 0) === (dh > 0)) v.h = (v.h + dh + ANG) % ANG;
    }
    const S = sinA(v.h), C = cosA(v.h);
    let fwd = Math.trunc((v.vx * S - v.vy * C) / SC);
    let lat = Math.trunc((v.vx * C + v.vy * S) / SC);
    const off = Math.abs(lat);
    // a little drift: grip drops while the wheel is turned, back to full when straight
    // DRIFT: with the wheel turned the tyres hold only dgrip of the sideways speed,
    // so the body swings round and the car keeps sliding the way it was going;
    // straighten up and full grip catches it again.
    const lock = Math.abs(v.sr || 0), full = T.turn * 8;
    let grip = T.grip - Math.trunc((T.grip - T.dgrip) * lock / full);
    if (v.spiked > 0) { grip = Math.trunc(grip / 4); v.spiked--; }
    lat -= Math.trunc(lat * grip / 256);
    if (off > 40) fwd -= (off - 40) >> 4;             // only a wild slide scrubs speed
    if (fwd < vmax) fwd = Math.min(vmax, fwd + T.acc);
    else if (fwd > vmax) fwd = Math.max(vmax, fwd - 2);
    v.fwd = fwd; v.lat = lat;
    v.vx = Math.trunc((fwd * S + lat * C) / SC);
    v.vy = Math.trunc((-fwd * C + lat * S) / SC);
  }
  function surfaceVmax(sim, v) {
    const s = tileUnder(sim.seed, v.x, v.y), T = TYPES[v.type];
    return s === SAND || s === GRASS ? T.voff : T.vmax;
  }

  // Every vehicle is TWO circles along its heading (nose and tail), so a
  // long car collides along its whole length. Centres of circle k (0 front, 1 rear).
  function subX(v, k) { const o = TYPES[v.type].off; return v.x + Math.trunc(sinA(v.h) * (k ? -o : o) / SC); }
  function subY(v, k) { const o = TYPES[v.type].off; return v.y - Math.trunc(cosA(v.h) * (k ? -o : o) / SC); }
  // Vehicle against vehicle: push apart by mass, exchange momentum along the
  // normal. Returns the hardest closing speed (units per step), 0 if not touching.
  function collidePair(a, b) {
    let worst = 0;
    for (let ka = 0; ka < 2; ka++) for (let kb = 0; kb < 2; kb++) {
      const ax = subX(a, ka), ay = subY(a, ka), bx = subX(b, kb), by = subY(b, kb);
      const dx = bx - ax, dy = by - ay, rr = a.r + b.r, d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      let dist = isqrt(d2), nx, ny;
      if (dist === 0) { nx = 256; ny = 0; } else { nx = Math.trunc(dx * 256 / dist); ny = Math.trunc(dy * 256 / dist); }
      const pen = rr - dist, ms = a.m + b.m;
      a.x -= Math.trunc(nx * pen * b.m / ms / 256); a.y -= Math.trunc(ny * pen * b.m / ms / 256);
      b.x += Math.trunc(nx * pen * a.m / ms / 256); b.y += Math.trunc(ny * pen * a.m / ms / 256);
      const vrel = Math.trunc(((b.vx - a.vx) * nx + (b.vy - a.vy) * ny) / 256);
      if (worst < 1) worst = 1;
      if (vrel >= 0) continue;
      const j = -vrel * (256 + REST);
      a.vx -= Math.trunc(nx * j * b.m / ms / 65536); a.vy -= Math.trunc(ny * j * b.m / ms / 65536);
      b.vx += Math.trunc(nx * j * a.m / ms / 65536); b.vy += Math.trunc(ny * j * a.m / ms / 65536);
      if (-vrel > worst) worst = -vrel;
    }
    return worst;
  }
  // Vehicle against the solid tiles around it. Returns the hardest impact.
  function collideTiles(sim, v) {
    let worst = 0;
    for (let k = 0; k < 2; k++) {
      const cx = subX(v, k), cy = subY(v, k);
      const tx0 = Math.floor((cx - v.r) / TILE), tx1 = Math.floor((cx + v.r) / TILE);
      const ty0 = Math.floor((cy - v.r) / TILE), ty1 = Math.floor((cy + v.r) / TILE);
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        if (!solid(tileAt(sim.seed, tx, ty))) continue;
        const px = subX(v, k), py = subY(v, k);
        const x0 = tx * TILE, y0 = ty * TILE, x1 = x0 + TILE, y1 = y0 + TILE;
        const nxp = Math.max(x0, Math.min(px, x1)), nyp = Math.max(y0, Math.min(py, y1));
        const dx = px - nxp, dy = py - nyp, d2 = dx * dx + dy * dy;
        let nx, ny, pen;
        if (d2 >= v.r * v.r) continue;
        if (d2 === 0) {
          const l = px - x0, r = x1 - px, u = py - y0, b = y1 - py, m = Math.min(l, r, u, b);
          nx = m === l ? -256 : m === r ? 256 : 0; ny = m === u ? -256 : m === b ? 256 : 0;
          if (nx && ny) ny = 0;
          pen = m + v.r;
        } else {
          const dist = isqrt(d2); nx = Math.trunc(dx * 256 / dist); ny = Math.trunc(dy * 256 / dist); pen = v.r - dist;
        }
        v.x += Math.trunc(nx * pen / 256); v.y += Math.trunc(ny * pen / 256);
        const vn = Math.trunc((v.vx * nx + v.vy * ny) / 256);
        if (vn < 0) {
          v.vx -= Math.trunc(nx * vn * (256 + REST) / 65536); v.vy -= Math.trunc(ny * vn * (256 + REST) / 65536);
          if (-vn > worst) worst = -vn;
        }
      }
    }
    return worst;
  }

  function wreckIt(sim, v, cause, pay) {
    if (v.wreck) return;
    v.wreck = sim.step;
    if (pay) {
      let pts = TYPES[v.type].pts;
      const P0 = sim.veh[0], ddx = v.x - P0.x, ddy = v.y - P0.y, close = ddx * ddx + ddy * ddy < (30 * M) * (30 * M);
      if (pts && close) {
        // a chain of police crashes within 3 s multiplies them: x2, x3 ... x5
        sim.combo = sim.step - sim.lastWreck <= COMBO_STEPS ? Math.min(5, sim.combo + 1) : 1;
        sim.lastWreck = sim.step; pts *= sim.combo; sim.wrecks++; if (sim.combo > sim.bestCombo) sim.bestCombo = sim.combo;
      } else if (pts) sim.wrecks++;
      sim.bonus += pts;
      sim.events.push(['wreck', v.id, v.x, v.y, pts, cause, pts && close ? sim.combo : 0]);
    } else sim.events.push(['wreck', v.id, v.x, v.y, 0, cause]);
  }
  function hurt(sim, why, x, y) {
    if (sim.inv > 0 || sim.over) return;
    sim.hearts--; sim.inv = INVULN;
    sim.events.push(['hurt', why, x, y, sim.hearts]);
    if (sim.hearts <= 0) end(sim, 'wrecked');
  }
  function end(sim, cause) { if (!sim.over) { sim.over = sim.step; sim.cause = cause; sim.events.push(['end', cause]); } }

  function spawn(sim, p) {
    let live = 0;
    for (let i = 1; i < sim.veh.length; i++) if (!sim.veh[i].wreck && !sim.veh[i].parked && isChaser(sim.veh[i])) live++;
    if (sim.step < sim.nextSpawn || live >= CAP_BY_LEVEL[sim.wanted]) return;
    sim.nextSpawn = sim.step + SPAWN_GAP;
    const S = sinA(p.h), C = cosA(p.h);
    for (let k = 0; k < 8; k++) {
      const h = hash(sim.seed, sim.step, 900 + k);
      const a = h % ANG, dist = SPAWN_MIN + (h >>> 10) % SPAWN_SPREAD;
      const as = sinA(a), ac = cosA(a);
      if (as * S + ac * C > FRONT_COS * SC) continue;   // never in front of you
      const x = p.x + Math.trunc(as * dist / SC), y = p.y - Math.trunc(ac * dist / SC);
      if (tileUnder(sim.seed, x, y) !== ROAD) continue;
      const r = (h >>> 20) % 100;
      let type = POLICE;
      if (sim.wanted >= 5 && r < 35) type = JEEP;
      else if (sim.wanted >= 3 && r < 30) type = SWAT;
      const c = newVeh(sim, type, Math.floor(x / TILE) * TILE + 512, Math.floor(y / TILE) * TILE + 512, (a + 512) % ANG);
      sim.veh.push(c); sim.spawns++;
      sim.events.push(['spawn', c.id, type]);
      return;
    }
  }

  // ── traffic: rickshaws and buses that keep to the LEFT of the road ──
  const TRAFFIC_CAP = 6, TRAFFIC_GAP = 40, TRAFFIC_MIN = 28 * M, TRAFFIC_SPREAD = 34 * M, DESPAWN_TRAFFIC = 95 * M;
  function isTraffic(v) { return v.type >= RICKSHAW; }
  function isChaser(v) { return v.type === POLICE || v.type === SWAT || v.type === JEEP; }
  function trafficSteer(sim, v) {
    let dh = ((v.h - v.axisH + 512) % ANG + ANG) % ANG - 512;
    if (dh > 120 || dh < -120) v.stop = 1;                               // spun round by a hit: it stays put
    if (v.stop) return 0;
    let e;
    if (v.axisH === 0) e = v.x - v.lane; else if (v.axisH === 512) e = v.lane - v.x;
    else if (v.axisH === 256) e = v.y - v.lane; else e = v.lane - v.y;
    const score = e + dh * 12;
    v.aiTurn = score > 40 ? -1 : score < -40 ? 1 : 0;
    const S = sinA(v.h), C = cosA(v.h), F = 9 * M;
    if (blockedAt(sim.seed, v.x + Math.trunc(S * F / SC), v.y - Math.trunc(C * F / SC))) return 0;   // dead end: stop
    // brake for anything in the lane just ahead
    for (let i = 0; i < sim.veh.length; i++) {
      const o = sim.veh[i]; if (o === v || o.air) continue;
      const dx = o.x - v.x, dy = o.y - v.y, ah = Math.trunc((dx * S - dy * C) / SC), sd = Math.trunc((dx * C + dy * S) / SC);
      if (ah > 0 && ah < 9 * M && sd < 2 * M && sd > -2 * M) return 0;
    }
    return TYPES[v.type].vmax;
  }
  function spawnTraffic(sim, p) {
    if (sim.step % TRAFFIC_GAP !== 0) return;
    let n = 0;
    for (let i = 1; i < sim.veh.length; i++) if (isTraffic(sim.veh[i])) n++;
    if (n >= TRAFFIC_CAP) return;
    for (let k = 0; k < 6; k++) {
      const h = hash(sim.seed, sim.step, 1700 + k);
      const a = h % ANG, dist = TRAFFIC_MIN + (h >>> 10) % TRAFFIC_SPREAD;
      const x = p.x + Math.trunc(sinA(a) * dist / SC), y = p.y - Math.trunc(cosA(a) * dist / SC);
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE), lx = tx - Math.floor(tx / CH) * CH, ly = ty - Math.floor(ty / CH) * CH;
      if (tileAt(sim.seed, tx, ty) !== ROAD) continue;
      const vert = lx <= 2 && ly > 2, hor = ly <= 2 && lx > 2;
      if (!vert && !hor) continue;
      const fwd = (h >>> 21) & 1, tr = (h >>> 22) % 20, type = tr < 7 ? RICKSHAW : tr < 13 ? CAR : tr < 17 ? MOTO : BUS;
      const base = vert ? Math.floor(tx / CH) * CH * TILE : Math.floor(ty / CH) * CH * TILE;
      let axisH, lane;
      if (vert) { axisH = fwd ? 0 : 512; lane = base + (fwd ? 3 : 9) * M; } else { axisH = fwd ? 256 : 768; lane = base + (fwd ? 3 : 9) * M; }
      const vx2 = vert ? lane : tx * TILE + 512, vy2 = vert ? ty * TILE + 512 : lane;
      let clear = 1;
      for (let i = 0; i < sim.veh.length; i++) { const o = sim.veh[i], ddx = o.x - vx2, ddy = o.y - vy2; if (ddx * ddx + ddy * ddy < (10 * M) * (10 * M)) { clear = 0; break; } }
      if (!clear) continue;
      const v = newVeh(sim, type, vx2, vy2, axisH);
      v.axisH = axisH; v.lane = lane; v.stop = 0;
      const sp = TYPES[type].vmax; v.vx = Math.trunc(sinA(axisH) * sp / SC); v.vy = -Math.trunc(cosA(axisH) * sp / SC); v.fwd = sp;
      sim.veh.push(v);
      return;
    }
  }

  function pcx0(p) { return Math.floor(Math.floor(p.x / TILE) / CH); }
  function pcy0(p) { return Math.floor(Math.floor(p.y / TILE) / CH); }

  // ── ramps: hit one fast along the road and you fly ──
  const JUMP_PTS = 5, RAMP_HALF_W = 410, RAMP_SPEED = 40;
  // a ramp: centre (x, y) in units, axis 0 = along y, 1 = along x
  function onRamp(v, rx, ry, axis) {
    let along, cross;
    if (axis === 0) { if (v.y < ry - 512 || v.y >= ry + 512 || v.x < rx - RAMP_HALF_W || v.x > rx + RAMP_HALF_W) return 0; along = Math.abs(v.vy); cross = Math.abs(v.vx); }
    else { if (v.x < rx - 512 || v.x >= rx + 512 || v.y < ry - RAMP_HALF_W || v.y > ry + RAMP_HALF_W) return 0; along = Math.abs(v.vx); cross = Math.abs(v.vy); }
    return along >= RAMP_SPEED && cross * 2 <= along ? along : 0;
  }
  function launch(sim, v, along) {
    v.air = v.airT = 24 + Math.min(30, Math.floor(along / 3));
    if (v.type === PLAYER) { sim.bonus += JUMP_PTS; sim.jumps++; }
    sim.events.push(['jump', v.id, v.x, v.y, v.type === PLAYER ? JUMP_PTS : 0, v.airT]);
  }
  function ramps(sim) {
    for (let i = 0; i < sim.veh.length; i++) {
      const v = sim.veh[i];
      if (v.air || v.wreck || v.type === BUS) continue;
      let along = 0;
      const tx = Math.floor(v.x / TILE), ty = Math.floor(v.y / TILE), cx = Math.floor(tx / CH), cy = Math.floor(ty / CH);
      const k = chunk(sim.seed, cx, cy);
      if (k.ramp) {
        if (k.ramp[0] === 0) along = onRamp(v, cx * CH * TILE + k.ramp[1] * M, (cy * CH + k.ramp[2]) * TILE + 512, 0);
        else along = onRamp(v, (cx * CH + k.ramp[2]) * TILE + 512, cy * CH * TILE + k.ramp[1] * M, 1);
      }
      for (let r = 0; !along && r < sim.dramps.length; r++) along = onRamp(v, sim.dramps[r].x, sim.dramps[r].y, sim.dramps[r].axis);
      if (along) launch(sim, v, along);
    }
  }
  // landing on a police car flattens it
  function landing(sim, v) {
    sim.events.push(['land', v.id, v.x, v.y]);
    for (let i = 0; i < sim.veh.length; i++) {
      const c = sim.veh[i];
      if (c === v || c.wreck || c.air) continue;
      const dx = c.x - v.x, dy = c.y - v.y, rr = c.r + v.r + 128;
      if (dx * dx + dy * dy >= rr * rr) continue;
      if (isChaser(c)) wreckIt(sim, c, 'landed', v.type === PLAYER ? 1 : 0);
      else if (isTraffic(c) && c.type !== BUS) wreckIt(sim, c, 'landed', 0);
    }
  }

  // ── the helicopter: from wanted 3 it hunts you from the air, marks a spot
  // just ahead of you and drops on it. Dodge the mark. Police caught under it crash.
  const HELI_LEVEL = 3, HELI_ACC = 3, HELI_MAX = 104, DROP_LEAD = 80, DROP_TIME = 80, DROP_R = 3 * M + 384;
  function heli(sim, p) {
    if (!sim.heli) {
      if (sim.wanted < HELI_LEVEL || sim.over) return;
      sim.heli = { x: p.x + 50 * M, y: p.y + 50 * M, vx: 0, vy: 0, cd: 150 };
      sim.events.push(['heli']);
    }
    // it hangs back and off to one side of you, so it never sits over your car
    const H = sim.heli, tx = p.x - p.vx * 10 + p.vy * 6 - H.x, ty = p.y - p.vy * 10 - p.vx * 6 - H.y;
    H.vx += tx > 0 ? HELI_ACC : -HELI_ACC; H.vy += ty > 0 ? HELI_ACC : -HELI_ACC;
    H.vx = Math.max(-HELI_MAX, Math.min(HELI_MAX, H.vx - Math.trunc(H.vx / 24))); H.vy = Math.max(-HELI_MAX, Math.min(HELI_MAX, H.vy - Math.trunc(H.vy / 24)));
    H.x += H.vx; H.y += H.vy;
    if (--H.cd <= 0) {
      const dx = p.x - H.x, dy = p.y - H.y;
      if (dx * dx + dy * dy < (40 * M) * (40 * M)) {
        const d = { x: p.x + p.vx * DROP_LEAD, y: p.y + p.vy * DROP_LEAD, t: DROP_TIME };
        sim.drops = sim.drops.concat([d]); sim.events.push(['mark', d.x, d.y, DROP_TIME]);
        H.cd = sim.wanted >= 5 ? 170 : sim.wanted >= 4 ? 210 : 260;
      } else H.cd = 20;
    }
    const keep = [];
    for (let i = 0; i < sim.drops.length; i++) {
      const d = sim.drops[i];
      if (--d.t > 0) { keep.push(d); continue; }
      sim.events.push(['boom', d.x, d.y]);
      for (let j = 0; j < sim.veh.length; j++) {
        const v = sim.veh[j];
        if (v.air || v.wreck) continue;
        const dx = v.x - d.x, dy = v.y - d.y, rr = DROP_R + v.r;
        if (dx * dx + dy * dy >= rr * rr) continue;
        if (v.type === PLAYER) hurt(sim, 'heli', d.x, d.y);
        else if (isChaser(v)) wreckIt(sim, v, 'heli', 1);
        else if (v.type !== BUS) wreckIt(sim, v, 'heli', 0);
      }
    }
    sim.drops = keep;
  }

  // ── nitro: 3 s of extra speed; whatever you hit is smashed and you are not hurt ──
  const NITRO_STEPS = 180, NITRO_PLUS = 40;
  // v4: SPEED BUILDS ON THE STRAIGHT. Every BOOST_EVERY steps with the wheel
  // straight adds 1 to the top speed, up to BOOST_MAX; turning bleeds it off
  // BOOST_DROP a step, and the car then slows at its normal 2 a step.
  const BOOST_EVERY = 6, BOOST_MAX = 28, BOOST_DROP = 3;
  function boostStep(sim, p) {
    if (sim.version < 4) return 0;
    if (p.air > 0) return sim.boost;
    if (sim.steer === 0) { if (++sim.strt >= BOOST_EVERY) { sim.strt = 0; if (sim.boost < BOOST_MAX) sim.boost++; } }
    else { sim.strt = 0; sim.boost = Math.max(0, sim.boost - BOOST_DROP); }
    return sim.boost;
  }
  function pickNitro(sim, p) {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = pcx0(p) + ox, cy = pcy0(p) + oy, key = cx + ',' + cy, k = chunk(sim.seed, cx, cy);
      if (!k.nitro || sim.nitro_[key]) continue;
      const nx = (cx * CH + k.nitro[0]) * TILE + 512, ny = (cy * CH + k.nitro[1]) * TILE + 512, dx = nx - p.x, dy = ny - p.y;
      if (dx * dx + dy * dy < 560 * 560) { sim.nitro_[key] = sim.step; sim.nitro = NITRO_STEPS; sim.inv = Math.max(sim.inv, NITRO_STEPS); sim.events.push(['nitro', nx, ny]); }
    }
  }

  // The road the player is on, and which way: returns {dir, along, cross} or null.
  // dir 0 north, 1 east, 2 south, 3 west.
  function roadAhead(sim, p) {
    const dir = ((p.h + 128) >> 8) & 3;
    const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE), lx = tx - Math.floor(tx / CH) * CH, ly = ty - Math.floor(ty / CH) * CH;
    if ((dir & 1) === 0 && !(lx <= 2 && ly > 2)) return null;
    if ((dir & 1) === 1 && !(ly <= 2 && lx > 2)) return null;
    return dir;
  }
  // ── roadblocks (wanted 4+): two police cars parked across the road ahead,
  // just before a junction, leaving one gap. Sometimes a ramp in front of one.
  const BLOCK_LEVEL = 4, BLOCK_GAP_STEPS = 720;
  function roadblocks(sim, p) {
    if (sim.wanted < BLOCK_LEVEL || sim.step < sim.nextBlock || sim.over) return;
    const dir = roadAhead(sim, p);
    if (dir === null) { sim.nextBlock = sim.step + 30; return; }
    sim.nextBlock = sim.step + BLOCK_GAP_STEPS;
    const vert = (dir & 1) === 0, ax = vert ? p.y : p.x, sgn = dir === 0 || dir === 3 ? -1 : 1;
    // the next chunk edge ahead at least 45 m away
    let edge = Math.floor(ax / (CH * TILE)) * CH * TILE + (sgn > 0 ? CH * TILE : 3 * TILE);
    while ((edge - ax) * sgn < 45 * M) edge += sgn * CH * TILE;
    const line = edge - sgn * 1536;                                   // just before the junction
    const base = Math.floor((vert ? p.x : p.y) / (CH * TILE)) * CH * TILE;   // road from base to base + 12 m
    const bx = vert ? base + 6 * M : line, by = vert ? line : base + 6 * M;
    if (tileUnder(sim.seed, bx, by) !== ROAD && tileUnder(sim.seed, bx, by) !== BRIDGE) return;
    const h = hash(sim.seed, sim.step, 5150), gap = h % 3;                 // the open slot: 0, 1 or 2
    const slots = [2 * M, 6 * M, 10 * M];
    let n = 0;
    for (let k = 0; k < 3; k++) {
      if (k === gap) continue;
      const cx2 = vert ? base + slots[k] : line, cy2 = vert ? line : base + slots[k];
      const c = newVeh(sim, POLICE, cx2, cy2, vert ? 256 : 0);
      c.parked = 1; sim.veh.push(c); n++;
    }
    let rampAt = -1;
    if ((h >>> 4) % 2 === 0) {                                          // a ramp in front of one parked car
      rampAt = gap === 0 ? 1 : 0;
      const rx = vert ? base + slots[rampAt] : line - sgn * 9 * M, ry = vert ? line - sgn * 9 * M : base + slots[rampAt];
      sim.dramps = sim.dramps.concat([{ x: rx, y: ry, axis: vert ? 0 : 1, at: sim.step }]);
    }
    sim.events.push(['block', bx, by, n, rampAt]);
  }
  // ── spike strips (wanted 3+): thrown across your road ahead. Drive over
  // one and the tyres lose grip for 1.5 s.
  const SPIKE_LEVEL = 3, SPIKE_STEPS = 90, SPIKE_HALF = 5 * M, SPIKE_DEPTH = 300;
  function spikes(sim, p) {
    if (sim.version >= 3) return;   // v3: no spike strips
    if (sim.wanted >= SPIKE_LEVEL && sim.step >= sim.nextSpike && !sim.over) {
      const dir = roadAhead(sim, p);
      sim.nextSpike = sim.step + (dir === null ? 30 : 480 - sim.wanted * 40);
      if (dir !== null) {
        const vert = (dir & 1) === 0, sgn = dir === 0 || dir === 3 ? -1 : 1;
        const base = Math.floor((vert ? p.x : p.y) / (CH * TILE)) * CH * TILE;
        const along = (vert ? p.y : p.x) + sgn * 34 * M;
        const sx = vert ? base + 6 * M : along, sy = vert ? along : base + 6 * M;
        if (tileUnder(sim.seed, sx, sy) === ROAD) { sim.spikes = sim.spikes.concat([{ x: sx, y: sy, axis: vert ? 0 : 1, at: sim.step }]); sim.events.push(['spikes', sx, sy]); }
      }
    }
    const keep = [];
    for (let i = 0; i < sim.spikes.length; i++) {
      const sp = sim.spikes[i];
      if (sim.step - sp.at > 1200) continue;
      keep.push(sp);
      for (let j = 0; j < sim.veh.length; j++) {
        const v = sim.veh[j];
        if (v.air || v.wreck || v.spiked > SPIKE_STEPS - 20) continue;
        const dx = Math.abs(v.x - sp.x), dy = Math.abs(v.y - sp.y);
        if (sp.axis === 0 ? (dx < SPIKE_HALF && dy < SPIKE_DEPTH) : (dy < SPIKE_HALF && dx < SPIKE_DEPTH)) {
          v.spiked = SPIKE_STEPS; v.vx += Math.trunc(v.vy / 5); v.vy -= Math.trunc(v.vx / 5);   // a kick sideways
          sim.events.push(['spiked', v.id, v.x, v.y]);
        }
      }
    }
    sim.spikes = keep;
    if (sim.dramps.length && sim.step - sim.dramps[0].at > 1500) sim.dramps = sim.dramps.slice(1);
  }

  function stepSim(sim) {
    if (sim.over) return;
    sim.events = [];
    sim.step++;
    const p = sim.veh[0];
    sim.hist.push([p.x, p.y, p.vx, p.vy]); if (sim.hist.length > 32) sim.hist.shift();
    // drive
    const bst = boostStep(sim, p);
    drive(sim, p, sim.steer, (sim.nitro > 0 ? surfaceVmax(sim, p) + NITRO_PLUS : surfaceVmax(sim, p)) + bst);
    if (sim.nitro > 0) { sim.nitro--; if (p.fwd < surfaceVmax(sim, p) + NITRO_PLUS) { const S0 = sinA(p.h), C0 = cosA(p.h); p.vx += Math.trunc(S0 * 3 / SC); p.vy -= Math.trunc(C0 * 3 / SC); } }
    for (let i = 1; i < sim.veh.length; i++) {
      const c = sim.veh[i];
      if (c.wreck) {
        c.vx -= Math.trunc(c.vx * WRECK_FRICTION / 256); c.vy -= Math.trunc(c.vy * WRECK_FRICTION / 256);
        c.fwd = 0; c.lat = 0;
      } else if (isTraffic(c)) { const vm = trafficSteer(sim, c); drive(sim, c, c.stop ? 0 : c.aiTurn, vm); }
      else if (c.parked) { c.vx -= Math.trunc(c.vx / 8); c.vy -= Math.trunc(c.vy / 8); c.fwd = 0; c.lat = 0; }
      else { const vm = aiSteer(sim, c, p); drive(sim, c, c.aiTurn, vm); }
    }
    for (let i = 0; i < sim.veh.length; i++) {
      const v = sim.veh[i]; v.x += v.vx; v.y += v.vy; v.hit = 0; if (v.nearCd > 0) v.nearCd--;
      if (v.air > 0 && --v.air === 0) landing(sim, v);
    }
    ramps(sim);
    // vehicles against each other, two passes, in id order
    let touching = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < sim.veh.length; i++) for (let j = i + 1; j < sim.veh.length; j++) {
        const a = sim.veh[i], b = sim.veh[j];
        if (a.air || b.air) continue;
        const imp = collidePair(a, b);
        if (!imp) continue;
        if (pass === 1) continue;
        if (a.type === PLAYER && sim.nitro > 0) {
          if (!b.wreck && b.type !== BUS) wreckIt(sim, b, 'nitro', isChaser(b) ? 1 : 0);
          if (imp > 12) sim.events.push(['bump', b.id, imp, 1]);
        } else if (a.type === PLAYER && isTraffic(b)) {
          if (imp >= 44) hurt(sim, 'ram', b.x, b.y);
          if (!b.wreck && imp >= TYPES[b.type].wreckCar) wreckIt(sim, b, 'player', 0);
          if (imp > 12) sim.events.push(['bump', b.id, imp, 1]);
        } else if (a.type === PLAYER) {
          touching = 1;
          if (imp >= RAM_DMG && !b.wreck) { hurt(sim, 'ram', b.x, b.y); sim.events.push(['bump', b.id, imp, 1]); }
          if (!b.wreck && imp >= TYPES[b.type].wreckCar) wreckIt(sim, b, 'player', 0);
        } else {
          if (!a.wreck && imp >= TYPES[a.type].wreckCar) wreckIt(sim, a, 'car', 1);
          if (!b.wreck && imp >= TYPES[b.type].wreckCar) wreckIt(sim, b, 'car', 1);
          if (imp > 12) sim.events.push(['bump', a.id, imp, 0]);
        }
      }
    }
    // vehicles against buildings and rails
    for (let i = 0; i < sim.veh.length; i++) {
      const v = sim.veh[i], imp = collideTiles(sim, v);
      if (!imp) continue;
      v.hit = imp;
      if (v.type === PLAYER) { if (imp >= WALL_DMG) hurt(sim, 'wall', v.x, v.y); sim.events.push(['wall', v.id, imp]); }
      else if (!v.wreck && imp >= TYPES[v.type].wreckWall) wreckIt(sim, v, 'wall', 1);
      else if (imp > 12) sim.events.push(['wall', v.id, imp]);
    }
    // water
    for (let i = 0; i < sim.veh.length; i++) {
      const v = sim.veh[i];
      if (v.air || tileUnder(sim.seed, v.x, v.y) !== WATER) continue;
      if (v.type === PLAYER) { sim.events.push(['splash', v.id, v.x, v.y]); end(sim, 'water'); }
      else if (!v.wreck) { wreckIt(sim, v, 'water', 1); sim.events.push(['splash', v.id, v.x, v.y]); v.sunk = 1; }
    }
    // near misses
    for (let i = 1; i < sim.veh.length; i++) {
      const c = sim.veh[i];
      if (c.wreck || c.nearCd) continue;
      const dx = c.x - p.x, dy = c.y - p.y, gap = c.r + p.r + NEAR_GAP, d2 = dx * dx + dy * dy;
      if (d2 >= gap * gap || d2 <= (c.r + p.r) * (c.r + p.r)) continue;
      const rvx = c.vx - p.vx, rvy = c.vy - p.vy;
      if (rvx * rvx + rvy * rvy < NEAR_REL * NEAR_REL) continue;
      c.nearCd = NEAR_CD; sim.bonus += NEAR_PTS; sim.nears++; sim.events.push(['near', c.id, c.x, c.y, NEAR_PTS]);
    }
    // hearts: an extra life, only taken when one is missing
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = pcx0(p) + ox, cy = pcy0(p) + oy, key = cx + ',' + cy, k = chunk(sim.seed, cx, cy);
      if (!heartOn(k, sim.version) || sim.hearts_[key] || sim.hearts >= HEARTS) continue;
      const nx = (cx * CH + k.heart[0]) * TILE + 512, ny = (cy * CH + k.heart[1]) * TILE + 512, dx = nx - p.x, dy = ny - p.y;
      if (dx * dx + dy * dy < CASH_R * CASH_R) { sim.hearts_[key] = sim.step; sim.hearts++; sim.livesTaken++; sim.events.push(['life', nx, ny, sim.hearts]); }
    }
    heli(sim, p);
    pickNitro(sim, p);
    roadblocks(sim, p);
    spikes(sim, p);
    // cash notes
    const ptx = Math.floor(p.x / TILE), pty = Math.floor(p.y / TILE), pcx = Math.floor(ptx / CH), pcy = Math.floor(pty / CH);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = pcx + ox, cy = pcy + oy, key = cx + ',' + cy;
      if (sim.cash[key]) continue;
      const k = chunk(sim.seed, cx, cy), nx = (cx * CH + k.cash[0]) * TILE + 512, ny = (cy * CH + k.cash[1]) * TILE + 512;
      const dx = nx - p.x, dy = ny - p.y;
      if (dx * dx + dy * dy < CASH_R * CASH_R) { sim.cash[key] = sim.step; sim.bonus += CASH_PTS; sim.cashN++; sim.events.push(['cash', nx, ny, CASH_PTS]); }
    }
    // boxed in: barely moving with a chaser right on you
    let near = 0;
    for (let i = 1; i < sim.veh.length; i++) {
      const c = sim.veh[i], dx = c.x - p.x, dy = c.y - p.y, g = BOX_NEAR + c.r;
      if (isChaser(c) && dx * dx + dy * dy < g * g) { near = 1; break; }
    }
    const pspd2 = p.vx * p.vx + p.vy * p.vy;
    if (pspd2 < BOX_SPEED * BOX_SPEED && (near || touching)) sim.stuck++; else sim.stuck = 0;
    if (sim.stuck >= BOX_STEPS) end(sim, 'boxed');
    if (sim.inv > 0) sim.inv--;
    // the wanted level and new chasers
    const lvl = Math.min(5, 1 + Math.floor(sim.step / LEVEL_STEPS) + Math.floor(sim.wrecks / LEVEL_WRECKS));
    if (lvl > sim.wanted) { sim.wanted = lvl; sim.events.push(['wanted', lvl]); }
    if (!sim.over) { spawn(sim, p); spawnTraffic(sim, p); }
    // forget what is far behind; keep the rules' vehicle count bounded
    const keep = [p];
    for (let i = 1; i < sim.veh.length; i++) {
      const c = sim.veh[i], dx = c.x - p.x, dy = c.y - p.y, d2 = dx * dx + dy * dy;
      const lim = c.wreck ? DESPAWN_WRECK : isTraffic(c) ? DESPAWN_TRAFFIC : DESPAWN_LIVE;
      if (d2 > lim * lim) continue;
      keep.push(c);
    }
    while (keep.length > MAX_VEH) {
      let oldest = -1;
      for (let i = 1; i < keep.length; i++) if (keep[i].wreck && (oldest < 0 || keep[i].wreck < keep[oldest].wreck)) oldest = i;
      if (oldest < 0) oldest = 1;
      keep.splice(oldest, 1);
    }
    sim.veh = keep;
    sim.score = Math.floor(sim.step / STEPS_PER_SEC) + sim.bonus;
  }
  // CHOR POLICE RULES END

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound far above any real run (a hold per 6 steps for an hour). It
// REFUSES further inputs, it never zeroes, and it stops a huge trace becoming a CPU sink.
const MAX_INPUTS = 60 * 60 * 10;

function advanceTo(sim, step) {
  while (!sim.over && sim.step < step && sim.step < MAX_SIM_STEPS) stepSim(sim);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, holdN: 0,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { holds: [], presses: [], chaserGap: [], lungeReact: [], lastLunge: -1, sides: 0, switches: 0, lastDir: 0 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated: hold lengths and rhythm, how far the nearest live
// chaser was when a turn began, and how quickly a turn followed a police lunge
// (a hand reacts late and unevenly; a planner either ignores the lunge or
// answers it on the same few steps every time).
function nearestChaser(sim) {
  const p = sim.veh[0];
  let best = -1;
  for (let i = 1; i < sim.veh.length; i++) {
    const c = sim.veh[i];
    if (c.wreck || c.parked || c.type < 1 || c.type > 3) continue;
    const dx = c.x - p.x, dy = c.y - p.y, d = isqrt(dx * dx + dy * dy);
    if (best < 0 || d < best) best = d;
  }
  return best;
}
function noteLunges(state) {
  const ev = state.sim.events;
  for (let i = 0; i < ev.length; i++) if (ev[i][0] === 'lunge') state.stats.lastLunge = state.sim.step;
}
function stepNoting(state, sim, step) {
  while (!sim.over && sim.step < step && sim.step < MAX_SIM_STEPS) { stepSim(sim); noteLunges(state); }
}
function noteHold(state, dir, pressStep, releaseStep) {
  const st = state.stats, sim = state.sim;
  st.holds.push(releaseStep - pressStep);
  st.presses.push(pressStep);
  const g = nearestChaser(sim);
  if (g >= 0) st.chaserGap.push(g);
  if (st.lastLunge >= 0 && pressStep - st.lastLunge <= 60) { st.lungeReact.push(pressStep - st.lastLunge); st.lastLunge = -1; }
  if (st.lastDir && st.lastDir !== dir) st.switches++;
  st.lastDir = dir;
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
      state.sim = initSim(state.seed, Number(payload.v) >= 4 ? 4 : Number(payload.v) >= 3 ? 3 : 2);
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'hold') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, dir, pressStep, releaseStep } = payload;
  if (!isStep(n) || (dir !== 1 && dir !== -1) || !isStep(pressStep) || !isStep(releaseStep) || releaseStep <= pressStep) {
    return reject(state, 'bad_input');
  }
  const sim = state.sim;
  // Holds may never go BACKWARDS: a rewind would re-run a window and keep the
  // best outcome. A hold may start on the step the previous one ended.
  if (pressStep < sim.step) return reject(state, 'frame_regressed');
  if (n !== state.holdN) return reject(state, 'out_of_order');
  setSteer(sim, 0);
  stepNoting(state, sim, pressStep);
  if (sim.over) {
    state.dead = true; state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step !== pressStep) return reject(state, 'beyond_cap');
  state.holdN++;
  noteHold(state, dir, pressStep, releaseStep);
  setSteer(sim, dir);
  stepNoting(state, sim, releaseStep);
  setSteer(sim, 0);
  state.score = sim.score;
  if (sim.over) state.dead = true;
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
  if (state.mode !== 'sim' || !state.sim) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const sim = state.sim;
  // Run the world out past the last hold, driving straight. A car that stops
  // steering is caught: police lunge, roadblocks close the road, streets dead-end.
  setSteer(sim, 0);
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.over && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) { stepSim(sim); guard++; }
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, over: sim.over, cause: sim.cause, score: sim.score,
      wrecks: sim.wrecks, jumps: sim.jumps, nears: sim.nears, wanted: sim.wanted, hearts: sim.hearts,
      inputs: state.inputCount, rejects: state.rejectCount, holds: st.holds.length,
      holdMean: round3(mean(st.holds)), holdSd: round3(sd(st.holds)), gapCv: round3(gapCv(st.presses)),
      chaserGapMean: round3(mean(st.chaserGap)), chaserGapSd: round3(sd(st.chaserGap)),
      lungeReactMean: round3(mean(st.lungeReact)), lungeReactSd: round3(sd(st.lungeReact)), lungeReacts: st.lungeReact.length,
      switchShare: st.holds.length ? round3(st.switches / st.holds.length) : null,
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
  _sim: { RULES_VERSION, initSim, stepSim, setSteer, seedToInt, hash, sinA, cosA, isqrt, genChunk, tileAt, tileUnder, TYPES, SIN_Q, HEARTS, MAX_INPUTS, MAX_SIM_STEPS },
};
