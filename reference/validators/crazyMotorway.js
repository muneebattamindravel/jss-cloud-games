'use strict';

/**
 * Crazy Motorway validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * The game was built on replay, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a car drives itself up a five-lane motorway. Swipes change lane
 * (left/right), boost (up) or brake (down); in the air after a ramp they are
 * tricks. Traffic, cones, oncoming lanes, toll plazas and ramp trucks come from
 * the session seed; one hit ends the run unless nitro is smashing.
 *
 * What the server does with a trace:
 *   1. rebuilds the road from the session seed: row K and section S take their
 *      draws from hash(seed, K, j), never from a running stream;
 *   2. applies each input { n, d, step } before step `step` runs, exactly as the
 *      client does;
 *   3. runs the same fixed steps and counts what the client would have scored.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/crazy-motorway/js/game.js.
 * shared/tests/crazyMotorwayParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump, never an edit
 * in place.
 *
 * Integer arithmetic only (+ - * / floor min max imul and bit ops): no trig,
 * no pow, no Math.random, no clock and no screen, so no dmath is needed.
 */

/* eslint-disable no-var */
  // ════════════════════════ RULES ════════════════════════
  // Carried WORD FOR WORD in shared/anticheat/validators/crazyMotorway.js, which
  // replays a run's inputs against the session seed to compute its score.
  // A gameplay change is a trace version bump, never an edit in place.
  var RULES_VERSION = 5;
  var STEP_HZ = 60;
  var LANES = 5, LANE_W = 340, SHIFT = 34;            // a lane change takes 10 steps
  var CAR_HW = 95, CAR_HL = 180;
  // types: car, van, lorry, coach, cones, barrier, ramp truck
  var TYPE_HW = [95, 105, 133, 130, 130, 160, 133];
  var TYPE_HL = [180, 240, 440, 520, 60, 60, 460];
  var V0 = 80, VMAX = 126, CRUISE_DIST = 4200;          // starts ~173 km/h and climbs smoothly (in 1/8 cm/step steps)
  var BOOST_PCT = 40, BRAKE_PCT = 30, NITRO_PCT = 65, ACCEL = 3;
  var BOOST_STEPS = 70, BRAKE_STEPS = 36, NITRO_STEPS = 300, GRACE_STEPS = 45;
  var KIND_V = [18, -22, 0, 18, 0, 6];                 // traffic, oncoming, roadworks, ramp trucks, toll plaza, crawling trucks
  var SPAWN = 26000, BREAK_REL = 7000;                 // rows appear 260 m ahead
  var GAP0 = 76, GAP_FLOOR = 26, GAP_DIST = 3000;      // wide gaps at the start, closing in      // spacing in steps at cruise
  var MAX_SAME = 3, MAX_UNBLOCKED = 4;
  var AIR_STEPS = 64, TRICK_STEPS = 26, RAMP_HL = 240;
  var PAD_AIR = 48, PAD_HW = 200, PAD_LIP = 260, PAD_PTS = 5, NITRO_PAD = 12; // ramp trucks: drive up the back, fly over
  var NEAR_CM = 120, COMBO_STEPS = 300, COMBO_PER = 3, MULT_MAX = 5;
  var CHG_TRIG = 7000, CHG_SPEED = 6, CHG_SIGNAL = 13000; // traffic lane change: blinks from 130 m, glides over from 70 m
  var NITRO_FULL = 100, NITRO_NEAR = 8, NITRO_TRICK = 15;
  var NITRO_FULL_V4 = 200, NITRO_STEPS_V4 = 420; // v4: the bar takes twice the charge and nitro lasts 2 s longer
  var NEAR_PTS = 2, TRICK_PTS = 10, SMASH_PTS = 3;
  // the route: 12 stages of 700 m, Peshawar to Karachi, the run starting at a city
  // chosen by the seed. Every second stage has a toll plaza; the Salt
  // Range's traffic is trucks crawling down the descent. From v3 a run starts
  // only at a big city (Peshawar, Islamabad, Lahore, Karachi); v2 at any stage.
  var STAGE_CM = 70000, ROUTE_N = 12, SALT_STAGE = 3, TOLL_AT = 25000, TOLL_PTS = 3;
  var START_CITIES = [0, 2, 4, 11];
  function routeStage(sim, D) { return (sim.start + Math.floor(D / STAGE_CM)) % ROUTE_N; }

  // the session seed (hex) as one 32-bit integer
  function seedToInt(seedHex) {
    if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
    return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, 0x85ebca6b)) | 0;
  }
  function hash(seed, a, b) {
    var h = (seed ^ Math.imul(a + 0x9e37, 0x85ebca6b) ^ Math.imul(b + 0x7f4a, 0xc2b2ae35)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function cruiseAt(P) { return Math.min(VMAX, V0 + Math.floor(P / CRUISE_DIST)); }
  function cruise8(P) { return Math.min(VMAX * 8, V0 * 8 + Math.floor(P * 8 / CRUISE_DIST)); } // eighths of a cm per step
  function relOf(sim, row) { return row.D + row.v * (sim.step - row.s0) - sim.P; }

  function nextSection(sim) {
    var S = sim.secIx++, h = hash(sim.seed, 900000 + S, 0), kind = 0, len = S === 0 ? 3 : S < 5 ? 3 + (h % 3) : 6 + (h % 5), r = (h >>> 8) % 100;
    if (S === 1 || S === 3) r = r % 70; // the opening always shows a special stretch early
    sim.ramp = false;
    if (S >= 1 && r < 24) { kind = 1; len = 4 + ((h >>> 16) % 3); }
    else if (S >= 1 && r < 40) { kind = 2; len = 3 + ((h >>> 16) % 3); }
    else if (S >= 1 && r < 56) { kind = 2; len = 2; sim.ramp = true; }
    else if (S >= 1 && r < 70) { kind = 3; len = 3 + ((h >>> 16) % 2); }
    var ahead = sim.P + SPAWN;
    if (S >= 1 && ahead >= sim.tollNext) { kind = 4; len = 1; sim.ramp = false; }
    else if (kind === 0 && routeStage(sim, ahead) === SALT_STAGE) kind = 5;
    sim.secKind = kind; sim.secLeft = len; sim.secS = S;
  }

  function addRow(sim, rel, kind, obs, free, extra) {
    var K = sim.rows.length, row = { k: K, D: sim.P + rel, s0: sim.step, v: KIND_V[kind], kind: kind, free: free, obs: obs,
      scored: false, newSec: false, ramp: -1, wall: false, launched: false };
    for (var key in extra) row[key] = extra[key];
    sim.rows.push(row); return row;
  }

  function gapFor(sim, prev, dlane, c) {
    var v = KIND_V[sim.secKind], rv = Math.max(8, c - v), hl = 0;
    for (var i = 0; i < prev.obs.length; i++) hl = Math.max(hl, TYPE_HL[prev.obs[i].type]);
    var base = Math.max(GAP_FLOOR, GAP0 - Math.floor(sim.P / GAP_DIST));
    return Math.max(rv * base, 2 * CAR_HL + hl + 520 + rv * (10 * dlane + 8));
  }

  // Spawns the next row when there is room for it within SPAWN; null if it must wait.
  function maybeSpawn(sim) {
    var prev = sim.rows.length ? sim.rows[sim.rows.length - 1] : null;
    var c = cruiseAt(sim.P);
    if (!prev) { nextSection(sim); sim.secKind = 0; sim.ramp = false; return spawnRow(sim, SPAWN, false); }
    var prel = relOf(sim, prev);
    if (sim.secLeft <= 0) {
      var oldV = KIND_V[sim.secKind], oldK = sim.secKind;
      nextSection(sim);
      // a slower section (or a ramp) waits until the last row is nearly passed, so gaps never shrink
      if (KIND_V[sim.secKind] < oldV || sim.ramp) {
        if (prel > BREAK_REL) { sim.secIx--; sim.secKind = oldK; sim.secLeft = 0; sim.ramp = false; return null; }
        return spawnRow(sim, SPAWN, true);
      }
      return spawnRow(sim, Math.max(SPAWN, prel + gapFor(sim, prev, 2, c)), true);
    }
    var want = prel + gapFor(sim, prev, 1, c);
    if (want > SPAWN) return null;
    return spawnRow(sim, want, false);
  }

  function spawnRow(sim, rel, newSec) {
    var K = sim.rows.length, prev = K ? sim.rows[K - 1] : null, kind = sim.secKind, c = cruiseAt(sim.P + rel);
    sim.secLeft--;
    var h0 = hash(sim.seed, K, 0), h1 = hash(sim.seed, K, 1), h2 = hash(sim.seed, K, 2);
    var f = prev ? prev.free : 2, d = (h0 % 3) - 1;
    if (prev && sim.same >= MAX_SAME && d === 0) d = (h0 & 4) ? 1 : -1;
    if (f + d < 0 || f + d >= LANES) d = -d;
    var nf = f + d, L;
    sim.same = nf === f ? sim.same + 1 : 0;

    if (kind === 4) {
      // toll plaza: booths across the road, the free lane and usually one beside it open
      var open = [0, 0, 0, 0, 0], o2 = nf + ((h1 & 1) ? 1 : -1);
      if (o2 < 0 || o2 >= LANES) o2 = 2 * nf - o2;
      open[nf] = 1; if (h1 % 3) open[o2] = 1;
      var tob = []; for (L = 0; L < LANES; L++) if (!open[L]) tob.push({ lane: L, type: 5, x: L * LANE_W, gone: false, to: -1 });
      if (sim.landClear && sim.P + rel < sim.landClear) rel = sim.landClear - sim.P;
      sim.landClear = 0;
      var tr = addRow(sim, rel, 4, tob, nf, { newSec: newSec, toll: true, open: open });
      sim.tollNext = (Math.floor(tr.D / STAGE_CM) + 2) * STAGE_CM + TOLL_AT; // every second stage sim.secLeft = 0;
      return tr;
    }
    if (kind === 3) {
      // a ramp truck driving in one lane with the traffic: drive up its ramp from behind
      // and fly over it; the other lanes are open, and clipping its side is a crash
      var vmaxP = Math.floor(c * (100 + NITRO_PCT) / 100), tl = h1 % LANES, fr = tl !== f ? f : (f > 0 ? f - 1 : f + 1);
      if (prev && prev.pad) rel = Math.max(rel, relOf(sim, prev) + vmaxP * (PAD_AIR + 20) + 2 * TYPE_HL[6]);
      if (sim.landClear && sim.P + rel < sim.landClear) rel = sim.landClear - sim.P;
      var pr = addRow(sim, rel, 3, [{ lane: tl, type: 6, x: tl * LANE_W, gone: false, to: -1 }], fr, { newSec: newSec, pad: { hit: false } });
      sim.landClear = pr.D + vmaxP * (PAD_AIR + 30) + 2 * CAR_HL + 600;
      return pr;
    }
    if (sim.ramp) {
      // ramp row: the free lane carries a ramp, every other lane is barriers;
      // then a full barrier wall that only the jump clears, then open road.
      var ob = [];
      for (L = 0; L < LANES; L++) if (L !== nf) ob.push({ lane: L, type: 5, x: L * LANE_W, gone: false, to: -1 });
      var r1 = addRow(sim, rel, 2, ob, nf, { ramp: nf, newSec: newSec });
      var vmin = Math.floor(c * (100 - BRAKE_PCT) / 100), wallAt = rel + RAMP_HL + Math.floor(vmin * AIR_STEPS / 2);
      var wob = []; for (L = 0; L < LANES; L++) wob.push({ lane: L, type: 5, x: L * LANE_W, gone: false, to: -1 });
      var w = addRow(sim, wallAt, 2, wob, nf, { wall: true });
      sim.secLeft = 0; sim.ramp = false;
      var vmax = Math.floor(c * (100 + NITRO_PCT) / 100);
      sim.landClear = r1.D + RAMP_HL + vmax * (AIR_STEPS + 30) + 2 * CAR_HL + 600; // the next row starts beyond the longest jump
      return w;
    }
    var maxb = Math.min(4, 3 + Math.floor(K / 14)), nb = 1 + (h1 % maxb), blocked = [0, 0, 0, 0, 0], cnt = 0;
    if (prev && nf !== f) blocked[f] = 1;
    for (L = 0; L < LANES; L++) if (L !== nf && K - sim.lastBlock[L] >= MAX_UNBLOCKED) blocked[L] = 1;
    for (L = 0; L < LANES; L++) cnt += blocked[L];
    for (var j = 0; j < LANES && cnt < nb; j++) { var cand = hash(sim.seed, K, 3 + j) % LANES; if (cand !== nf && !blocked[cand]) { blocked[cand] = 1; cnt++; } }
    var obs = [];
    for (L = 0; L < LANES; L++) {
      if (!blocked[L]) continue;
      sim.lastBlock[L] = K;
      var r = hash(sim.seed, K, 10 + L) % 100;
      var type = kind === 2 ? 4 : kind === 5 ? (r < 16 ? 0 : r < 28 ? 1 : r < 84 ? 2 : 3) : r < 48 ? 0 : r < 68 ? 1 : r < 86 ? 2 : 3;
      obs.push({ lane: L, type: type, x: L * LANE_W, gone: false, to: -1 });
    }
    // lane changers (cars and vans). A CUT-IN moves into the open lane, and the
    // lane it leaves becomes the way through; it is always next to the lane the
    // previous row left open, so the car is never asked to cross two lanes.
    if (kind === 0 && prev && K >= 2 && hash(sim.seed, K, 19) % 100 < Math.min(42, 18 + Math.floor(K / 2))) {
      for (var c2 = 0; c2 < obs.length; c2++) {
        var cq = obs[(c2 + (h1 >>> 4)) % obs.length];
        if (cq.type > 1 || Math.abs(cq.lane - nf) !== 1 || Math.abs(cq.lane - f) > 1) continue;
        cq.to = nf; blocked[nf] = 1; nf = cq.lane; break;
      }
    }
    if (kind === 0) {
      var pct = Math.min(55, 22 + Math.floor(K / 2));
      for (var o = 0; o < obs.length; o++) {
        var q = obs[o]; if (q.type > 1 || q.to >= 0 || hash(sim.seed, K, 20 + q.lane) % 100 >= pct) continue;
        var dir = hash(sim.seed, K, 30 + q.lane) & 1 ? 1 : -1, to = q.lane + dir;
        if (to < 0 || to >= LANES || blocked[to] || to === nf) { to = q.lane - dir; if (to < 0 || to >= LANES || blocked[to] || to === nf) continue; }
        q.to = to; blocked[to] = 1;
      }
    }
    if (sim.landClear && sim.P + rel < sim.landClear) rel = sim.landClear - sim.P;
    sim.landClear = 0;
    var row = addRow(sim, rel, kind, obs, nf, { newSec: newSec });
    return row;
  }

  function initSim(seedHex, version) {
    var seed = seedToInt(seedHex), ver = version === undefined ? RULES_VERSION : version;
    return { seed: seed, step: 0, inputs: 0, P: 0, speed: V0, v8: V0 * 8, P8: 0, x: 2 * LANE_W, target: 2, dead: false, deathStep: -1, score: 0,
      rows: [], first: 0, secIx: 0, secKind: 0, secLeft: 0, secS: 0, same: 0, lastBlock: [0, 0, 0, 0, 0], ramp: false, landClear: 0,
      start: ver >= 3 ? START_CITIES[hash(seed, 77, 7) % START_CITIES.length] : hash(seed, 77, 7) % ROUTE_N, tollNext: STAGE_CM + TOLL_AT,
      nfull: ver >= 4 ? NITRO_FULL_V4 : NITRO_FULL, nsteps: ver >= 4 ? NITRO_STEPS_V4 : NITRO_STEPS, safeLand: ver >= 5,
      boostT: 0, brakeT: 0, nitroT: 0, graceT: 0, nitro: 0, air: 0, airMax: AIR_STEPS, trickT: 0, trick: 0, tricks: 0,
      combo: 0, comboT: 0, events: [] };
  }
  function mult(sim) { return Math.min(MULT_MAX, 1 + Math.floor(sim.combo / COMBO_PER)); }

  // input d: 0 left, 1 right, 2 up, 3 down. In the air left/right/up are tricks.
  // An accepted input counts toward sim.inputs; a refused one changes nothing.
  function inputSim(sim, d) {
    if (sim.dead || d !== (d | 0) || d < 0 || d > 3) return false;
    if (sim.air) {
      if (sim.trickT || d === 3) return false;
      sim.trickT = TRICK_STEPS; sim.trick = d === 2 ? 1 : d === 0 ? 2 : 3; sim.inputs++; return true;
    }
    if (d <= 1) {
      var nt = sim.target + (d === 1 ? 1 : -1);
      if (nt < 0 || nt >= LANES) return false; sim.target = nt; sim.inputs++; return true;
    }
    if (d === 2) { sim.boostT = BOOST_STEPS; sim.brakeT = 0; sim.inputs++; return true; }
    sim.brakeT = BRAKE_STEPS; sim.boostT = 0; sim.inputs++; return true;
  }

  function gainNitro(sim, n) {
    if (sim.nitroT) return;
    sim.nitro = Math.min(sim.nfull, sim.nitro + n);
    if (sim.nitro >= sim.nfull) { sim.nitro = 0; sim.nitroT = sim.nsteps; sim.events.push({ kind: 'nitro' }); }
  }
  function bumpCombo(sim) { sim.combo++; sim.comboT = COMBO_STEPS; }
  function die(sim, rowK, type) { sim.dead = true; sim.deathStep = sim.step; sim.events.push({ kind: 'crash', row: rowK, type: type }); }

  function stepSim(sim) {
    sim.events = [];
    if (sim.dead) return;
    sim.step++;
    var c = cruiseAt(sim.P);
    var pct = 100 + (sim.nitroT ? NITRO_PCT : sim.boostT ? BOOST_PCT : 0) - (sim.brakeT ? BRAKE_PCT : 0);
    var want8 = Math.floor(cruise8(sim.P) * pct / 100);
    if (!sim.air) { if (sim.v8 < want8) sim.v8 = Math.min(want8, sim.v8 + ACCEL * 8); else sim.v8 = Math.max(want8, sim.v8 - ACCEL * 8); }
    sim.P8 += sim.v8; sim.P = Math.floor(sim.P8 / 8); sim.speed = Math.floor(sim.v8 / 8);
    if (sim.boostT) sim.boostT--;
    if (sim.brakeT) sim.brakeT--;
    if (sim.nitroT) { if (--sim.nitroT === 0) { sim.graceT = GRACE_STEPS; sim.events.push({ kind: 'nitroEnd' }); } }
    else if (sim.graceT) sim.graceT--;
    if (sim.comboT && --sim.comboT === 0) { if (sim.combo >= COMBO_PER) sim.events.push({ kind: 'comboEnd', combo: sim.combo }); sim.combo = 0; }
    var tx = sim.target * LANE_W;
    if (!sim.air) { if (sim.x < tx) sim.x = Math.min(tx, sim.x + SHIFT); else if (sim.x > tx) sim.x = Math.max(tx, sim.x - SHIFT); }
    if (sim.air) {
      if (sim.trickT && --sim.trickT === 0) {
        sim.tricks++; var tp = TRICK_PTS * mult(sim); sim.score += tp; bumpCombo(sim); gainNitro(sim, NITRO_TRICK);
        sim.events.push({ kind: 'trick', trick: sim.trick, pts: tp }); sim.trick = 0;
      }
      if (--sim.air === 0) {
        if (sim.trickT) {
          // v5: a stunt cut short by the landing lands whole and counts like one finished in the
          // air (up to v4, landing mid-stunt crashed the car)
          if (!sim.safeLand) { die(sim, -1, 6); return; }
          sim.tricks++; var tq = TRICK_PTS * mult(sim); sim.score += tq; bumpCombo(sim); gainNitro(sim, NITRO_TRICK);
          sim.events.push({ kind: 'trick', trick: sim.trick, pts: tq, landed: true }); sim.trick = 0; sim.trickT = 0;
        }
        sim.events.push({ kind: 'land', tricks: sim.tricks }); sim.tricks = 0;
      }
    }
    var guard = 0;
    while (guard++ < 4 && maybeSpawn(sim)) { /* fill the horizon */ }
    var smash = sim.nitroT || sim.graceT;
    for (var i = sim.first; i < sim.rows.length; i++) {
      var row = sim.rows[i], dz = relOf(sim, row);
      if (dz > 8000) break;
      // a ramp truck launches the car that meets its tail in its lane (checked before any collision)
      if (row.pad && !row.pad.hit && !sim.air) {
        var rk = row.obs[0], lip = CAR_HL + TYPE_HL[6];
        if (!rk.gone && Math.abs(sim.x - rk.x) < PAD_HW && dz <= lip + 80 && dz > lip - PAD_LIP) {
          row.pad.hit = true; sim.air = PAD_AIR; sim.airMax = PAD_AIR; var pp = PAD_PTS * mult(sim); sim.score += pp; gainNitro(sim, NITRO_PAD);
          sim.events.push({ kind: 'launch', pad: true, pts: pp });
        }
      }
      for (var o = 0; o < row.obs.length; o++) {
        var ob = row.obs[o];
        // traffic lane changes, triggered by distance to the car
        if (ob.to >= 0 && dz < CHG_TRIG) { var tx2 = ob.to * LANE_W; if (ob.x < tx2) ob.x = Math.min(tx2, ob.x + CHG_SPEED); else if (ob.x > tx2) ob.x = Math.max(tx2, ob.x - CHG_SPEED); }
        if (ob.gone || sim.air) continue;
        if (Math.abs(sim.x - ob.x) < CAR_HW + TYPE_HW[ob.type] && Math.abs(dz) < CAR_HL + TYPE_HL[ob.type]) {
          if (smash) { ob.gone = true; sim.score += SMASH_PTS; sim.events.push({ kind: 'smash', row: row.k, o: o, pts: SMASH_PTS }); }
          else { die(sim, row.k, ob.type); return; }
        }
      }
      if (row.ramp >= 0 && !sim.air && !row.launched && Math.abs(sim.x - row.ramp * LANE_W) < 150 && dz <= 0 && dz > -RAMP_HL - sim.speed) {
        row.launched = true; sim.air = AIR_STEPS; sim.airMax = AIR_STEPS; sim.x = row.ramp * LANE_W; sim.target = row.ramp; sim.events.push({ kind: 'launch' });
      }
      if (!row.scored && dz < -(CAR_HL + 600)) {
        row.scored = true;
        var near = 0, side = 0, lorry = false, passed = 0;
        for (var p = 0; p < row.obs.length; p++) {
          var q = row.obs[p]; if (q.gone || q.type >= 5) continue; passed++;
          if (!sim.air && Math.abs(sim.x - q.x) - CAR_HW - TYPE_HW[q.type] < NEAR_CM) { near++; side = q.x > sim.x ? 1 : -1; if (q.type === 2) lorry = true; }
        }
        if (row.kind === 2 && passed) passed = 1;
        sim.score += passed * mult(sim);
        if (near) { bumpCombo(sim); sim.score += NEAR_PTS * mult(sim); gainNitro(sim, NITRO_NEAR * near); }
        if (row.toll) { var tp2 = TOLL_PTS * mult(sim); sim.score += tp2; sim.events.push({ kind: 'toll', pts: tp2 }); }
        sim.events.push({ kind: 'pass', row: row.k, near: near, side: side, lorry: lorry, mult: mult(sim) });
        if (i === sim.first) sim.first++;
      }
    }
  }
  // ══════════════════════ END RULES ══════════════════════

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound far above any real run. It REFUSES further inputs, it never
// zeroes, and it stops a huge trace becoming a CPU sink.
const MAX_INPUTS = 4 * 60 * 60 * 20;

function advanceTo(sim, step) {
  while (!sim.dead && sim.step < step && sim.step < MAX_SIM_STEPS) stepSim(sim);
}

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
    stats: { margins: [], steps: [], shifts: 0, wrong: 0, boosts: 0, brakes: 0, tricks: 0 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. At each lane change: how many steps remain before the
// next row reaches the car (the reaction MARGIN: a planner moves early and
// evenly, a hand late and unevenly), and whether the move heads away from the
// lane that row leaves open (a hand wanders, a planner never does).
function nextRow(sim) {
  for (let i = sim.first; i < sim.rows.length; i++) {
    const row = sim.rows[i];
    if (relOf(sim, row) > 0) return row;
  }
  return null;
}
function noteInput(state, d, wasAir, fromLane) {
  const sim = state.sim;
  const st = state.stats;
  st.steps.push(sim.step);
  if (wasAir) { st.tricks++; return; }
  if (d === 2) { st.boosts++; return; }
  if (d === 3) { st.brakes++; return; }
  st.shifts++;
  const row = nextRow(sim);
  if (!row) return;
  const closing = Math.max(1, sim.speed - row.v);
  st.margins.push(Math.floor(relOf(sim, row) / closing));
  if (Math.abs(sim.target - row.free) > Math.abs(fromLane - row.free)) st.wrong++;
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
      state.sim = initSim(state.seed, Math.floor(Number(payload.v)));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'in') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, d, step } = payload;
  if (!isStep(n) || !isStep(step) || (d !== 0 && d !== 1 && d !== 2 && d !== 3)) return reject(state, 'bad_input');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would re-run a window and keep the
  // best outcome. Several inputs on one step are allowed (they apply in order).
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(sim, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  // The input names its index in the run; any other index is out of order.
  if (n !== sim.inputs) return reject(state, 'out_of_order');
  const wasAir = sim.air > 0, fromLane = sim.target;
  // The client only records an input the rules applied, so a refused one is forged.
  if (!inputSim(sim, d)) return reject(state, 'refused');
  noteInput(state, d, wasAir, fromLane);
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
  // Run the world out past the last input. A car that stops steering dies,
  // because every lane is blocked at least once in MAX_UNBLOCKED rows.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {
    stepSim(sim);
    guard++;
  }
  const st = state.stats;
  const inputs = st.steps.length;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, deathStep: sim.deathStep, dead: sim.dead,
      score: sim.score, distance: sim.P, speed: sim.speed,
      inputs: state.inputCount, rejects: state.rejectCount, accepted: inputs,
      shifts: st.shifts, boosts: st.boosts, brakes: st.brakes, tricks: st.tricks,
      marginMean: round3(mean(st.margins)), marginSd: round3(sd(st.margins)),
      gapCv: round3(gapCv(st.steps)),
      wrongShare: st.shifts ? round3(st.wrong / st.shifts) : null,
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
    RULES_VERSION, START_CITIES, initSim, stepSim, inputSim, relOf, seedToInt, hash, routeStage, cruiseAt, cruise8, mult,
    MAX_INPUTS, MAX_SIM_STEPS, LANES, LANE_W, SHIFT, CAR_HW, CAR_HL, TYPE_HW, TYPE_HL, KIND_V,
    V0, VMAX, CRUISE_DIST, BOOST_PCT, BRAKE_PCT, NITRO_PCT, ACCEL, BOOST_STEPS, BRAKE_STEPS, NITRO_STEPS, GRACE_STEPS,
    SPAWN, BREAK_REL, GAP0, GAP_FLOOR, GAP_DIST, MAX_SAME, MAX_UNBLOCKED, AIR_STEPS, TRICK_STEPS, RAMP_HL,
    PAD_AIR, PAD_HW, PAD_LIP, PAD_PTS, NITRO_PAD, NEAR_CM, COMBO_STEPS, COMBO_PER, MULT_MAX,
    CHG_TRIG, CHG_SPEED, CHG_SIGNAL, NITRO_FULL, NITRO_FULL_V4, NITRO_STEPS_V4, NITRO_NEAR, NITRO_TRICK, NEAR_PTS, TRICK_PTS, SMASH_PTS,
    STAGE_CM, ROUTE_N, SALT_STAGE, TOLL_AT, TOLL_PTS, STEP_HZ,
  },
};
