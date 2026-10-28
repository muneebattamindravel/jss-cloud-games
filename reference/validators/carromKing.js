'use strict';
// Carrom King: server-side deterministic REPLAY (Oct 2026, migration 240).
//
// Top-down carrom against a 3 minute clock, no opponent. The striker sits on
// the baseline; the player places it and flicks it into the pieces to pocket
// them in the four corner pockets. Every piece is a circle moved by a small
// integer physics engine: positions in 1/256 design units, SUB substeps a
// fixed step so the fastest striker never passes through a piece, integer
// restitution and friction, Math.sqrt only inside isqrt (exact everywhere).
// The rules block below is carried WORD FOR WORD in
// games/carrom-king/js/game.js; shared/tests/carromKingParity.test.js fails if
// the two ever differ.
//
// v3 (Oct 2026, playtest feedback): a longer pull (150 units) on a power
// curve, and every rack a real rosette round the queen. v2 traces keep the
// v2 rules (sim.v).
//
// Trace: { kind: 'start', v: 3 } then one { kind: 'shot', n, x, dx, dy, step }
// per shot the client applied: the shot index, the striker's baseline x and
// the shot vector (striker minus finger), all integers in 1/16 design units,
// and the fixed step it was applied before. The server steps the world to
// that step and plays the same shot. A shot the rules refuse (while pieces
// still move, on top of a piece, backwards, too weak, out of order, rewound,
// after the clock) is REFUSED and changes nothing; refusals never zero a run.
//
// The block keeps the game's two-space indent so it is byte-identical.

  // ==== CARROM KING RULES BEGIN (word for word in games/carrom-king/js/game.js and shared/anticheat/validators/carromKing.js) ====
  // Integers only: +, -, *, /, Math.trunc, Math.floor, Math.sqrt (inside isqrt,
  // correctly rounded everywhere), Math.imul and comparisons. No trig, no clock,
  // no screen, no Math.random. Positions are in 1/256 design units; velocities
  // are 1/256 design units per SUBSTEP, and every fixed 1/60 s step runs SUB
  // substeps so the fastest striker never passes through a piece.
  var SU = 256;
  var SUB = 8;
  var L = 30 * SU, R = 384 * SU, T = 126 * SU, B = 480 * SU;   // the playing surface
  var CX = 207 * SU, CY = 303 * SU;                             // the centre of the board
  var BASE_Y = 434 * SU;                                        // the striker's baseline
  var BASE_L16 = 96 * 16, BASE_R16 = 318 * 16;                  // striker x range, 1/16 units
  var R_COIN = 9 * SU, R_STRIKER = 12 * SU;
  var R_STRIKER_V4 = 16 * SU;                                   // v4: a bigger striker
  var M_COIN = 4, M_STRIKER = 10;
  var POCKET_IN = 13 * SU;                                      // pocket centre, in from each corner
  var POCKET_R = 15 * SU;                                       // a centre inside this drops...
  var POCKET_DEEP = 9 * SU;                                     // ...but over the lip only if it is slow
  var LIP_V = 640;                                              // faster than this skims the lip (per substep)
  var E_PAIR = 230;                                             // restitution between discs, out of 256
  var E_WALL = 205;                                             // restitution off the cushion, out of 256
  var WALL_GRIP = 232;                                          // speed along the cushion kept on a bounce, out of 256
  var PAIR_THROW = 24;                                          // sliding between two discs removed on impact, out of 256
  var DRAG = 255;                                               // speed kept per step, out of 256
  var DEC = 8;                                                  // speed lost per step (sliding friction)
  var DEC_V4 = 3;                                               // v4: slipperier, pieces slide about 40% further
  var VMAX = 4 * SU;                                            // the hardest shot, per substep (32 units a step)
  var VMAX_V4 = 1640;                                           // v4: 20% less power
  var PULL_MAX16 = 80 * 16;                                     // v2: a longer pull is clamped to this
  var PULL_MAX16_V3 = 150 * 16;                                 // v3: a longer pull, so a thumb has room to be gentle
  var PULL_MIN16 = 6 * 16;                                      // a shorter pull is not a shot
  var SHOT_MAX_STEPS = 900;                                     // a shot still rolling after 15 s is stopped
  var RUN_STEPS = 10800;                                        // 3 minutes at 60 steps a second
  var RUN_STEPS_V4 = 18000;                                     // v4: 5 minutes
  var MAX_SHOTS = 600;                                          // a work bound
  var PTS_COIN = 10, PTS_QUEEN = 50, FOUL_PTS = 20;
  var STREAK_STEP = 5;                                          // a scoring shot in a row adds +5, +10, then +15 at most
  var STREAK_CAP = 3;
  var S_HEX = 19 * SU, S_HALF = 2432, HEX_DY = 4212;            // rosette spacing (19 units, rows 19*sqrt(3)/2)
  var GRID = 26 * SU;                                           // slots for racks 2 and up
  var RULES_VERSION = 4;
  // The rosette: ring 1 then ring 2 of a hex lattice, in angular order (axial q, r).
  var RING1 = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  var RING2 = [[2, 0], [1, 1], [0, 2], [-1, 2], [-2, 2], [-2, 1], [-2, 0], [-1, -1], [0, -2], [1, -2], [2, -2], [2, -1]];
  var POCKETS = [[L + POCKET_IN, T + POCKET_IN], [R - POCKET_IN, T + POCKET_IN], [L + POCKET_IN, B - POCKET_IN], [R - POCKET_IN, B - POCKET_IN]];
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
  function hexX(q, r) { return CX + q * S_HEX + r * S_HALF; }
  function hexY(r) { return CY + r * HEX_DY; }
  function radiusOf(k, rs) { return k === 0 ? (rs || R_STRIKER) : R_COIN; }
  function strikerR(sim) { return sim.v >= 4 ? R_STRIKER_V4 : R_STRIKER; }
  function vmaxOf(sim) { return sim.v >= 4 ? VMAX_V4 : VMAX; }
  function decOf(sim) { return sim.v >= 4 ? DEC_V4 : DEC; }
  function runSteps(sim) { return sim.v >= 4 ? RUN_STEPS_V4 : RUN_STEPS; }
  function massOf(k) { return k === 0 ? M_STRIKER : M_COIN; }
  function valueOf(k) { return k === 3 ? PTS_QUEEN : PTS_COIN; }
  function makePiece(sim, k, x, y) {
    var b = { id: sim.nextId, k: k, x: x, y: y, vx: 0, vy: 0 };
    sim.nextId = sim.nextId + 1;
    return b;
  }
  // Rack 1: the classic rosette, queen in the middle. The seed turns the
  // colour pattern (six ways) and may swap white and black.
  function rosette(sim) {
    var h = hash32(sim.seed, 1, 3), rot = h % 6, flip = (h >>> 8) & 1;
    var out = [makePiece(sim, 3, CX, CY)], i, c;
    for (i = 0; i < 6; i++) { c = RING1[(i + rot) % 6]; out.push(makePiece(sim, ((i & 1) ^ flip) ? 2 : 1, hexX(c[0], c[1]), hexY(c[1]))); }
    for (i = 0; i < 12; i++) { c = RING2[(i + rot * 2) % 12]; out.push(makePiece(sim, ((i & 1) ^ flip) ? 1 : 2, hexX(c[0], c[1]), hexY(c[1]))); }
    return out;
  }
  // Slots for racks 2 and up: a 26 unit grid round the centre, clear of the
  // pockets and of the striker's baseline. Easy slots sit near the middle,
  // above the baseline; the rest need angles or banks.
  function slots() {
    var easy = [], hard = [], i, j, p;
    for (j = -6; j <= 6; j++) {
      for (i = -6; i <= 6; i++) {
        var x = CX + i * GRID, y = CY + j * GRID, near = false;
        if (x - R_COIN < L || x + R_COIN > R || y - R_COIN < T || y + R_COIN > B) continue;
        for (p = 0; p < 4; p++) {
          var dx = x - POCKETS[p][0], dy = y - POCKETS[p][1];
          if (dx * dx + dy * dy < (32 * SU) * (32 * SU)) near = true;
        }
        if (near) continue;
        if (y > BASE_Y - 24 * SU && y < BASE_Y + 24 * SU) continue;
        var ex = x - CX, ey = y - CY;
        if (ex * ex + ey * ey <= (110 * SU) * (110 * SU) && y <= 400 * SU) easy.push([x, y]); else hard.push([x, y]);
      }
    }
    return [easy, hard];
  }
  function shuffled(seed, rack, salt, list) {
    var a = list.slice(), i;
    for (i = a.length - 1; i > 0; i--) {
      var j = hash32(seed, rack * 1000 + i, salt) % (i + 1), t = a[i];
      a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function rackCount(rack, v) { if (v >= 4) return 19;
    var n = 19 - 3 * (rack - 1); return n < 7 ? 7 : n; }
  function rackEasyPct(rack) { var e = 70 - 20 * (rack - 2); return e < 10 ? 10 : e; }
  // v3: every rack is a real rack, a rosette round the queen in the centre,
  // with fewer pieces each time (the outer ring thins out first). The seed
  // turns it and picks which outer spots stay empty.
  function rackFormation(sim, rack) {
    var n = rackCount(rack, sim.v), h = hash32(sim.seed, rack, 19), r1 = h % 6, r2 = (h >>> 8) % 12;
    var out = [makePiece(sim, 3, CX, CY)], i, c, k = 1;
    for (i = 0; i < 6 && k < n; i++, k++) { c = RING1[(i + r1) % 6]; out.push(makePiece(sim, (i & 1) ? 2 : 1, hexX(c[0], c[1]), hexY(c[1]))); }
    for (i = 0; i < 12 && k < n; i++, k++) { c = RING2[(i * 5 + r2) % 12]; out.push(makePiece(sim, (i & 1) ? 1 : 2, hexX(c[0], c[1]), hexY(c[1]))); }
    return out;
  }
  function buildRack(sim, rack) {
    if (rack === 1) return rosette(sim);
    if (sim.v >= 3) return rackFormation(sim, rack);
    var sl = slots(), n = rackCount(rack);
    var easy = shuffled(sim.seed, rack, 11, sl[0]), hard = shuffled(sim.seed, rack, 13, sl[1]);
    var ne = Math.trunc(n * rackEasyPct(rack) / 100);
    if (ne > easy.length) ne = easy.length;
    var picks = easy.slice(0, ne).concat(hard.slice(0, n - ne));
    var q = hash32(sim.seed, rack, 17) % picks.length, out = [], i;
    for (i = 0; i < picks.length; i++) out.push(makePiece(sim, i === q ? 3 : ((i & 1) ? 2 : 1), picks[i][0], picks[i][1]));
    return out;
  }
  function initSim(seedInt, version) {
    var sim = { seed: seedInt >>> 0, v: version === 2 ? 2 : (version === 3 ? 3 : RULES_VERSION), bodies: [], nextId: 1, step: 0, n: 0, rack: 1, moving: false,
      shotSteps: 0, shotPots: [], foul: false, potted: [], score: 0, coins: 0, queens: 0, fouls: 0, best: 0,
      streak: 0, qPending: false,
      dead: false, endReason: '', ev: [] };
    sim.bodies = buildRack(sim, 1);
    return sim;
  }
  function overlapsAny(bs, x, y, r) {
    for (var i = 0; i < bs.length; i++) {
      var o = bs[i], rs = r + radiusOf(o.k), dx = o.x - x, dy = o.y - y;
      if (dx < rs && dx > -rs && dy < rs && dy > -rs && dx * dx + dy * dy < rs * rs) return true;
    }
    return false;
  }
  function pullMax(sim) { return sim.v >= 3 ? PULL_MAX16_V3 : PULL_MAX16; }
  function isInt(v) { return typeof v === 'number' && v === Math.floor(v) && v >= -100000 && v <= 100000; }
  // A shot: striker baseline x and the shot vector (striker minus finger),
  // all in 1/16 design units, applied before step `step`. A refusal changes
  // nothing.
  function shotSim(sim, x, dx, dy, step) {
    if (sim.dead) return 'dead';
    if (!isInt(x) || !isInt(dx) || !isInt(dy)) return 'bad_shot';
    if (step !== sim.step) return step < sim.step ? 'frame_regressed' : 'not_yet';
    if (sim.moving) return 'busy';
    if (step >= runSteps(sim)) return 'time_up';
    if (sim.n >= MAX_SHOTS) return 'shot_cap';
    if (dy >= 0) return 'backward';
    var len = isqrt(dx * dx + dy * dy), pm = pullMax(sim);
    if (len < PULL_MIN16) return 'weak';
    if (len > pm) { dx = Math.trunc(dx * pm / len); dy = Math.trunc(dy * pm / len); len = pm; }
    var sx = x < BASE_L16 ? BASE_L16 : (x > BASE_R16 ? BASE_R16 : x);
    if (overlapsAny(sim.bodies, sx * 16, BASE_Y, strikerR(sim))) return 'blocked';
    // v2: speed in proportion to the pull. v3: a curve, so a soft pull is a
    // soft shot (half the pull is 3/8 of the speed, full pull is full speed).
    var vm = vmaxOf(sim);
    var vx = sim.v >= 3 ? Math.trunc(dx * (len + pm) * vm / (2 * pm * pm)) : Math.trunc(dx * vm / pm);
    var vy = sim.v >= 3 ? Math.trunc(dy * (len + pm) * vm / (2 * pm * pm)) : Math.trunc(dy * vm / pm);
    var st = { id: 0, k: 0, x: sx * 16, y: BASE_Y, vx: vx, vy: vy };
    sim.bodies = [st].concat(sim.bodies);
    sim.n = sim.n + 1;
    sim.moving = true;
    sim.shotSteps = 0;
    sim.shotPots = [];
    sim.foul = false;
    return st;
  }
  function collide(a, b, ev, rS) {
    var ra = radiusOf(a.k, rS), rb = radiusOf(b.k, rS), rs = ra + rb;
    var dx = b.x - a.x, dy = b.y - a.y;
    if (dx >= rs || dx <= -rs || dy >= rs || dy <= -rs) return;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs) return;
    var d = isqrt(d2);
    if (d === 0) { dx = SU; dy = 0; d = SU; }
    var ma = massOf(a.k), mb = massOf(b.k);
    var vn = Math.trunc(((b.vx - a.vx) * dx + (b.vy - a.vy) * dy) / d);
    if (vn < 0) {
      var k = Math.trunc(-vn * (256 + E_PAIR) / 256), da = Math.trunc(k * mb / (ma + mb)), db = k - da;
      a.vx = a.vx - Math.trunc(da * dx / d); a.vy = a.vy - Math.trunc(da * dy / d);
      b.vx = b.vx + Math.trunc(db * dx / d); b.vy = b.vy + Math.trunc(db * dy / d);
      // throw: the discs grip for an instant and drag each other sideways a little
      var vt = Math.trunc(((b.vx - a.vx) * -dy + (b.vy - a.vy) * dx) / d), jt = Math.trunc(vt * PAIR_THROW / 256);
      var lim = Math.trunc(k / 4);
      if (jt > lim) jt = lim;
      if (jt < -lim) jt = -lim;
      var ta = Math.trunc(jt * mb / (ma + mb)), tb = jt - ta;
      a.vx = a.vx - Math.trunc(ta * dy / d); a.vy = a.vy + Math.trunc(ta * dx / d);
      b.vx = b.vx + Math.trunc(tb * dy / d); b.vy = b.vy - Math.trunc(tb * dx / d);
      ev.push({ k: 'hit', a: a.id, b: b.id, p: k, x: a.x + Math.trunc(dx * ra / d), y: a.y + Math.trunc(dy * ra / d) });
    }
    var over = rs - d, pa = Math.trunc(over * mb / (ma + mb)), pb = over - pa;
    a.x = a.x - Math.trunc(pa * dx / d); a.y = a.y - Math.trunc(pa * dy / d);
    b.x = b.x + Math.trunc(pb * dx / d); b.y = b.y + Math.trunc(pb * dy / d);
  }
  function walls(b, ev, rS) {
    var r = radiusOf(b.k, rS), hit = 0;
    if (b.x < L + r) { b.x = L + r; if (b.vx < 0) { hit = -b.vx; b.vx = Math.trunc(-b.vx * E_WALL / 256); b.vy = Math.trunc(b.vy * WALL_GRIP / 256); } }
    if (b.x > R - r) { b.x = R - r; if (b.vx > 0) { hit = b.vx; b.vx = Math.trunc(-b.vx * E_WALL / 256); b.vy = Math.trunc(b.vy * WALL_GRIP / 256); } }
    if (b.y < T + r) { b.y = T + r; if (b.vy < 0) { hit = -b.vy; b.vy = Math.trunc(-b.vy * E_WALL / 256); b.vx = Math.trunc(b.vx * WALL_GRIP / 256); } }
    if (b.y > B - r) { b.y = B - r; if (b.vy > 0) { hit = b.vy; b.vy = Math.trunc(-b.vy * E_WALL / 256); b.vx = Math.trunc(b.vx * WALL_GRIP / 256); } }
    if (hit) ev.push({ k: 'wall', a: b.id, p: hit, x: b.x, y: b.y });
  }
  function pocketOf(b) {
    for (var p = 0; p < 4; p++) {
      var dx = b.x - POCKETS[p][0], dy = b.y - POCKETS[p][1];
      var d2 = dx * dx + dy * dy;
      if (d2 < POCKET_R * POCKET_R && (d2 < POCKET_DEEP * POCKET_DEEP || b.vx * b.vx + b.vy * b.vy <= LIP_V * LIP_V)) return p;
    }
    return -1;
  }
  function friction(b, dec) {
    var s2 = b.vx * b.vx + b.vy * b.vy;
    if (s2 === 0) return;
    var s = isqrt(s2), ns = Math.trunc(s * DRAG / 256) - dec;
    if (ns <= 0 || s === 0) { b.vx = 0; b.vy = 0; return; }
    b.vx = Math.trunc(b.vx * ns / s); b.vy = Math.trunc(b.vy * ns / s);
  }
  // A fouled shot returns the last piece pocketed to the first free spot of
  // the rosette, centre first.
  function returnSpot(bs) {
    if (!overlapsAny(bs, CX, CY, R_COIN)) return [CX, CY];
    var i, c;
    for (i = 0; i < 6; i++) { c = RING1[i]; if (!overlapsAny(bs, hexX(c[0], c[1]), hexY(c[1]), R_COIN)) return [hexX(c[0], c[1]), hexY(c[1])]; }
    for (i = 0; i < 12; i++) { c = RING2[i]; if (!overlapsAny(bs, hexX(c[0], c[1]), hexY(c[1]), R_COIN)) return [hexX(c[0], c[1]), hexY(c[1])]; }
    return null;
  }
  // The end of a shot, once every piece has stopped:
  //   combo  x2 for two pieces in the shot, x3 for three or more;
  //   streak a scoring shot that follows another adds a small flat bonus,
  //          +5, +10, then +15 at most; an empty shot or a foul starts again;
  //   queen  she counts only once COVERED: another piece pocketed in the same
  //          shot or the very next one (or nothing else left to pocket).
  //          Otherwise, or on a foul, she goes back to the centre unpaid;
  //   foul   the striker in a pocket costs 20 and returns the queen if she
  //          was waiting for cover, else the last piece pocketed.
  function endShot(sim, bs, ev) {
    var i, n = sim.shotPots.length, coinPts = 0, coinsIn = 0, queen = false;
    for (i = 0; i < n; i++) {
      if (sim.shotPots[i] === 3) queen = true; else { coinPts = coinPts + PTS_COIN; coinsIn = coinsIn + 1; }
    }
    bs = bs.filter(function (o) { return o.k !== 0; });
    for (i = 0; i < bs.length; i++) { bs[i].vx = 0; bs[i].vy = 0; }
    var coinsLeft = 0;
    for (i = 0; i < bs.length; i++) if (bs[i].k !== 3) coinsLeft = coinsLeft + 1;
    var foul = sim.foul, cover = '', queenPts = 0, queenBack = false;
    if (sim.qPending) {
      if (coinsIn > 0 && !foul) { queenPts = PTS_QUEEN; cover = 'covered'; }
      else { queenBack = true; cover = 'back'; }
      sim.qPending = false;
    }
    if (queen) {
      if (foul) { queenBack = true; cover = 'back'; }
      else if (coinsIn > 0 || coinsLeft === 0) { queenPts = PTS_QUEEN; cover = 'covered'; }
      else { sim.qPending = true; cover = 'pending'; }
    }
    if (cover === 'covered') sim.queens = sim.queens + 1;
    var mult = n >= 3 ? 3 : (n === 2 ? 2 : 1);
    if (n > 0 && !foul) sim.streak = sim.streak + 1; else sim.streak = 0;
    var sbonus = n > 0 && !foul ? STREAK_STEP * (sim.streak - 1 > STREAK_CAP ? STREAK_CAP : sim.streak - 1) : 0;
    var gain = (coinPts + queenPts) * mult + sbonus;
    sim.score = sim.score + gain;
    if (n > sim.best) sim.best = n;
    var ret = null, retK = 0;
    if (foul) {
      sim.fouls = sim.fouls + 1;
      sim.score = sim.score - FOUL_PTS < 0 ? 0 : sim.score - FOUL_PTS;
      if (!queenBack && sim.potted.length) {
        retK = sim.potted[sim.potted.length - 1];
        sim.potted = sim.potted.slice(0, sim.potted.length - 1);
      }
    }
    if (queenBack) retK = 3;
    if (retK) {
      var spot = returnSpot(bs);
      if (spot) { var back = makePiece(sim, retK, spot[0], spot[1]); bs = bs.concat([back]); ret = back.id; }
    }
    ev.push({ k: 'end', n: n, gain: gain, mult: mult, streak: sim.streak, sbonus: sbonus, cover: cover, foul: foul, ret: ret, retK: retK });
    if (bs.length === 0) {
      sim.rack = sim.rack + 1;
      bs = buildRack(sim, sim.rack);
      ev.push({ k: 'rack', rack: sim.rack });
    }
    sim.moving = false;
    sim.shotPots = [];
    sim.foul = false;
    return bs;
  }
  // One fixed 1/60 s step. Leaves the step's events in sim.ev.
  function stepSim(sim) {
    if (sim.dead) return;
    var ev = [], i, j, s, b, rS = strikerR(sim), dec = decOf(sim);
    if (sim.moving) {
      var bs = sim.bodies.map(function (o) { return { id: o.id, k: o.k, x: o.x, y: o.y, vx: o.vx, vy: o.vy }; });
      for (s = 0; s < SUB; s++) {
        for (i = 0; i < bs.length; i++) { b = bs[i]; b.x = b.x + b.vx; b.y = b.y + b.vy; }
        var kept = [];
        for (i = 0; i < bs.length; i++) {
          b = bs[i];
          var p = pocketOf(b);
          if (p < 0) { kept.push(b); continue; }
          ev.push({ k: 'pocket', id: b.id, kind: b.k, p: p, x: b.x, y: b.y });
          if (b.k === 0) { sim.foul = true; }
          else {
            sim.shotPots = sim.shotPots.concat([b.k]);
            if (b.k !== 3) { sim.potted = sim.potted.concat([b.k]); sim.coins = sim.coins + 1; }
          }
        }
        bs = kept;
        for (i = 0; i < bs.length; i++) for (j = i + 1; j < bs.length; j++) collide(bs[i], bs[j], ev, rS);
        for (i = 0; i < bs.length; i++) walls(bs[i], ev, rS);
      }
      var any = false;
      for (i = 0; i < bs.length; i++) { friction(bs[i], dec); if (bs[i].vx !== 0 || bs[i].vy !== 0) any = true; }
      sim.shotSteps = sim.shotSteps + 1;
      if (!any || sim.shotSteps >= SHOT_MAX_STEPS) bs = endShot(sim, bs, ev);
      sim.bodies = bs;
    }
    sim.step = sim.step + 1;
    if (sim.step >= runSteps(sim) && !sim.moving) { sim.dead = true; sim.endReason = 'time'; ev.push({ k: 'time' }); }
    sim.ev = ev;
  }
  // ==== CARROM KING RULES END ====

const MAX_SIM_STEPS = 3600 * 60;   // a work bound: the session hour
const MAX_INPUTS = MAX_SHOTS + 200;

function isStep(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }
function round3(v) { return v === null || v === undefined ? null : Math.round(v * 1000) / 1000; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function sd(a) { const m = mean(a); return m === null ? null : Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length); }

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600, elapsedSecs: Number(elapsedSecs) || 0,
    // humanness raw material (recorded, never gated)
    stats: { shotSteps: [], thinkSteps: [], pulls: [], xs: [], pots: 0, scoring: 0, readyStep: 0 },
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

// One step, plus the first step the board was still again (for the fingerprint).
function step1(state) {
  const sim = state.sim, st = state.stats;
  const was = sim.moving;
  stepSim(sim);
  if (was && !sim.moving) st.readyStep = sim.step;
  for (const e of sim.ev) {
    if (e.k === 'end') { st.pots += e.n; if (e.n > 0 && !e.foul) st.scoring++; }
  }
}

function advanceTo(state, target) {
  const sim = state.sim;
  while (!sim.dead && sim.step < target && sim.step < MAX_SIM_STEPS) step1(state);
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};
  if (p.kind === 'start') {
    // each version replays on its own rules: v2 linear power and scattered racks, v3, v4 (bigger striker, slipperier, 5 minutes, full racks).
    if ((p.v === 2 || p.v === 3 || p.v === 4) && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(seedToInt(state.seed), p.v);
    }
    return { accepted: true, newScore: state.score };
  }
  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || p.kind !== 'shot') return { accepted: true, newScore: state.score };
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  const { n, step } = p;
  if (!isStep(n) || !isStep(step)) return reject(state, 'bad_shot');
  const sim = state.sim;
  // Steps never go backwards: a rewind would re-run a window and keep the best
  // outcome. The rules refuse it (shotSim: frame_regressed); advanceTo never moves back.
  advanceTo(state, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step < step) return reject(state, 'beyond_cap');
  if (n !== sim.n) return reject(state, 'out_of_order');
  const r = shotSim(sim, p.x, p.dx, p.dy, step);
  // The client only records a shot the rules applied, so a refused one is forged.
  if (typeof r === 'string') return reject(state, r);
  const st = state.stats;
  st.shotSteps.push(step);
  st.thinkSteps.push(step - st.readyStep);
  st.pulls.push(Math.sqrt(p.dx * p.dx + p.dy * p.dy) / 16);
  st.xs.push(r.x / SU);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always ends inside this bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function fingerprint(state) {
  const st = state.stats, shots = st.shotSteps.length;
  const think = st.thinkSteps, tm = mean(think), ts = sd(think);
  return {
    shots,
    thinkMeanSteps: round3(tm),
    thinkCv: tm ? round3(ts / tm) : null,
    thinkMin: think.length ? Math.min.apply(null, think) : null,
    pullMean: round3(mean(st.pulls)),
    pullSd: round3(sd(st.pulls)),
    xSd: round3(sd(st.xs)),
    potsPerShot: shots ? round3(st.pots / shots) : null,
    scoringShare: shots ? round3(st.scoring / shots) : null,
  };
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out past the last shot, so pieces still moving score. The
  // clock is a rule (RUN_STEPS), so nobody parks: the run ends by then.
  const capSteps = elapsedCap(state, 60);
  while (!sim.dead && sim.step < capSteps && sim.step < MAX_SIM_STEPS) step1(state);
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, shots: sim.n, score: sim.score, dead: sim.dead, endReason: sim.endReason,
      rack: sim.rack, coins: sim.coins, queens: sim.queens, fouls: sim.fouls, inputs: state.inputCount, rejects: state.rejectCount,
      fingerprint: fingerprint(state),
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
  _limits: { MAX_SIM_STEPS, FPS: 60, RUN_STEPS: RUN_STEPS_V4 },
  init, processEvent, finalize, simulate,
  _sim: {
    SU, SUB, L, R, T, B, CX, CY, BASE_Y, BASE_L16, BASE_R16, R_COIN, R_STRIKER, M_COIN, M_STRIKER, POCKET_IN, POCKET_R,
    POCKET_DEEP, LIP_V, E_PAIR, E_WALL, WALL_GRIP, PAIR_THROW, DRAG, DEC, DEC_V4, VMAX, VMAX_V4, R_STRIKER_V4, PULL_MAX16, PULL_MAX16_V3, PULL_MIN16, SHOT_MAX_STEPS,
    RUN_STEPS, RUN_STEPS_V4, MAX_SHOTS, PTS_COIN, PTS_QUEEN, FOUL_PTS, STREAK_STEP, STREAK_CAP, S_HEX, S_HALF, HEX_DY, GRID,
    RULES_VERSION, RING1, RING2, POCKETS, MAX_SIM_STEPS, MAX_INPUTS,
    hash32, seedToInt, isqrt, hexX, hexY, radiusOf, massOf, valueOf, makePiece, rosette, slots, shuffled, rackCount,
    rackEasyPct, rackFormation, pullMax, buildRack, initSim, overlapsAny, isInt, shotSim, collide, walls, pocketOf, friction, returnSpot, endShot,
    stepSim, elapsedCap,
  },
};
