'use strict';

/**
 * Jelly Jhoom validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a jelly block runs down a track. Dragging up and down sets the
 * TARGET shape (tall and thin .. short and wide, constant area); the real shape
 * chases it at most RATE a step. Each gate has an opening; at the step the
 * jelly reaches it, |shape - opening| must be within TOL or the run ends.
 * PERFECTs build a streak and FEVER; coins between gates are caught by shape.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed (gate n takes five draws from
 *      hash(seed, n, j), never from a running stream);
 *   2. applies each path batch { f, x[] }: x[i] is the target during step
 *      f + 1 + i, set before that step runs, exactly as the client does;
 *   3. runs the same fixed steps and counts what the client would have scored.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/jelly-jhoom/js/rules.js.
 * shared/tests/jellyJhoomParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump.
 *
 * Integer arithmetic only: no trig, no pow, no Math.random, no clock and no
 * screen, so no dmath is needed.
 */

/* eslint-disable no-var */
// ==== RULES BLOCK: identical in games/jelly-jhoom/js/rules.js and shared/anticheat/validators/jellyJhoom.js ====
// Rules space: the jelly runs down a straight lane. Distance is in milli units,
// the jelly's shape is one integer, its aspect A (-1000 flat and wide .. +1000
// tall and thin), with width x height held at AREA. Everything is an integer.
// The 3D view, the track's bends, the wobble and every effect are DRAWING and
// never read or write anything here.
var RULES_VERSION = 4;
var A_MAX = 1000;
var RATE = 150;              // aspect units the shape may move in one step
var TOL = 150;               // |A - gate| within this fits the gate
var PERFECT_TOL = 50;        // within this is a PERFECT
var SPEED0 = 120;            // milli units a step at the start
var SPEED_PER_GATE = 2;
var SPEED_MAX = 260;
var FEVER_STREAK = 5;        // every 5th perfect in a row starts FEVER
var FEVER_STEPS = 300;
var FEVER_NUM = 7;
var FEVER_DEN = 5;
var REACT0 = 70;             // spare steps before gate n: one fewer every REACT_EVERY gates
var REACT_EVERY = 2;
var REACT_MIN = 30;          // never below this
var CLUSTER_STEPS = 24;      // a repeated gate follows this many steps later
var CLUSTER_MAX = 2;         // at most two repeats in a row
var CLUSTER_PCT = 30;
var CLUSTER_FROM = 3;        // no repeats among the first gates
var G_RANGE = 900;           // a gate's aspect lies in [-900, 900]
var MIN_JUMP = 2 * TOL + 1;  // a new gate never fits the shape the last one needed
var FIRST_GATE_Z = 14000;
var AHEAD_Z = 90000;         // gates exist this far ahead of the jelly
var POINTS_GATE = 10;
var POINTS_PERFECT = 5;
var POINTS_GEM = 25;
var POINTS_COIN = 5;
var STREAK_CAP = 5;
var GEM_PCT = 25;
var COIN_PCT = 55;
var COIN_GROUP = 4;
var COIN_SPACING = 700;
var COIN_MIN_GAP = 4500;
var COIN_X_PCT = 42;         // a side coin sits at 42% of the catching shape's width
var COIN_Y_PCT = 82;         // a high coin sits at 82% of the catching shape's height
var COIN_LOW_Y = 180;
var AREA = 810000;           // width x height, milli units squared
// Height at A = -1000, -900 .. +1000: round(900 * 3.2^(A / 1000)), interpolated
// linearly in between. A table, never pow: pow is not the same on every engine.
var H_KNOTS = [281, 316, 355, 399, 448, 503, 565, 635, 713, 801, 900, 1011, 1136, 1276, 1433, 1610, 1809, 2032, 2282, 2564, 2880];
var SEED_MIX = 0x85EBCA6B;
var HASH_K = 0x9E3779B1;
var HASH_J = 0x85EBCA77;
var MIX_A = 0x7FEB352D;
var MIX_B = 0x846CA68B;
// ---- v3: FEVER after four perfects (4 s, unbreakable, points doubled) and
// 36 kinds of obstacle in five tiers. A v2 trace still runs on the v2 rules
// above: every v3 rule is behind sim.version >= 3, and a v2 gate has no `t`.
//
// Every v3 obstacle is built from the same few parts, so the server replays
// all of them with one set of rules:
//   a CHECK   the shape must lie in [lo, hi] (or, for a union, [lo2, hi2])
//             at the step the jelly reaches it; lo = -A_MAX means "at most hi"
//             (duck), hi = A_MAX means "at least lo" (squeeze);
//   a HOLD    after the check, the shape must stay in [hlo, hhi] for `len`
//             of track (rails, tunnels, ceilings, bridges), optionally
//             shrinking by `shr` along it;
//   MOVEMENT  MV_TRI shifts the whole interval by a triangle wave of the step
//             number; MV_PULSE swaps between the A and B intervals;
//   a GROUP   one to five parts placed close together (combos).
var FEVER_STREAK_V3 = 3;     // three perfects in a row start FEVER
var FEVER_STEPS_V3 = 300;    // 5 s
var FEVER_SPEED_V3 = 2;      // FEVER runs at double speed
var FEVER_GRACE = 30;        // still unbreakable for half a second after
var FEVER_MULT = 2;          // every point earned in FEVER counts double
var EDGE_TOL = 100;          // how far a part must sit from the last PERFECT shape
var PERFECT_V3 = 80;         // v3: a two-sided part is PERFECT within this of its middle
var EDGE_PERFECT_V3 = 160;   // v3: a one-sided part is PERFECT within this of its edge
var COMBO_REACT = 26;        // spare steps between the parts of one group
var HOLD_STEPS = 48;         // a held section lasts this many steps at normal speed
var SHORT_HOLD_STEPS = 20;
var MV_NONE = 0, MV_TRI = 1, MV_PULSE = 2;
var POINTS_HOLD = 10, POINTS_RAMP = 5, POINTS_BOSS = 50, POINTS_SHRINK = 15;
var BOSS_EVERY = 25;         // every 25th group is a boss gate
// ---- v4: a PULSE obstacle stops swapping once the jelly is this many steps
// (at its current speed) from it. Its opening is then fixed, so it can never
// change shape just as the jelly reaches it, and what is drawn from then on is
// exactly what the crossing checks. v2 and v3 traces keep their own rules.
var PULSE_LOCK_STEPS = 45;
var K_GATE = 0, K_WIDE = 1, K_TALL = 2, K_COIN = 3, K_ARCH = 4,
  K_BAR = 5, K_SLIT = 6, K_LASER = 7, K_BEAM = 8, K_PILLARS = 9, K_RAMP = 10,
  K_RAILS = 11, K_TUNNEL = 12, K_CEIL = 13, K_BRIDGE = 14, K_BROKEN = 15, K_PAIR = 16, K_STAIRS = 17,
  K_MOVER = 18, K_SLIDERS = 19, K_CRUSHER = 20, K_RISER = 21, K_PENDULUM = 22, K_SPINNER = 23, K_PULSE = 24, K_MRAILS = 25,
  K_PLUS = 26, K_SPLIT = 27, K_ZIGZAG = 28, K_TRIPLE = 29, K_RAILHOOP = 30, K_TUNSLIT = 31, K_GRID = 32, K_SHRINK = 33,
  K_GAUNTLET = 34, K_BOSS = 35;
var KINDS = 36;
var TIER_OF = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
var TIER_FROM = [0, 6, 15, 30, 50];   // the group number each tier unlocks at

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

// Draw j of gate k: a pure function of (seed, k, j).
function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, HASH_K) ^ Math.imul(j + 7, HASH_J)) | 0;
  h = Math.imul(h ^ (h >>> 16), MIX_A);
  h = Math.imul(h ^ (h >>> 15), MIX_B);
  return (h ^ (h >>> 16)) >>> 0;
}

function clampA(a) { return Math.max(-A_MAX, Math.min(A_MAX, a)); }
function hOf(a) {
  var u = clampA(a) + A_MAX;
  var i = Math.floor(u / 100);
  if (i >= 20) return H_KNOTS[20];
  var f = u - i * 100;
  return H_KNOTS[i] + Math.floor((H_KNOTS[i + 1] - H_KNOTS[i]) * f / 100);
}
function wOf(a) { return Math.floor(AREA / hOf(a)); }

function speedAt(passed) { return Math.min(SPEED_MAX, SPEED0 + passed * SPEED_PER_GATE); }
function feverSpeed(s) { return Math.floor(s * FEVER_NUM / FEVER_DEN); }
function reactAt(n) { return Math.max(REACT_MIN, REACT0 - Math.floor(n / REACT_EVERY)); }

function initSim(seedHex, version) {
  var sim = {
    version: version, seed: seedToInt(seedHex), frames: 0, z: 0, A: 0, target: 0,
    passed: 0, streak: 0, fever: 0, score: 0, perfects: 0, gems: 0, coinsTaken: 0, coinSeq: 0,
    dead: false, deathStep: -1, gates: [], coins: [], events: [], hold: null, grace: 0, charge: 0,
    plock: version >= 4 ? {} : undefined,
    gen: version >= 3 ? { n: 0, lastG: 0, lastZ: 0, run: 0, gi: 0, lastEnd: 0, xl: 0, xh: 0, xl2: 0, xh2: 0, q: [] }
      : { n: 0, lastG: 0, lastZ: 0, run: 0 }
  };
  while (sim.gen.n === 0 || sim.gen.lastZ < AHEAD_Z) makeGate(sim);
  return sim;
}

// Gate n: five draws on every index, whatever the branch uses. Its distance is
// the last gate's plus enough steps to reshape, counted at the FASTEST speed
// the pair can be driven at (FEVER), so every gap can be made.
function makeGate(sim) {
  if (sim.version >= 3) { makeGate3(sim); return; }
  var g = sim.gen, n = g.n, s = sim.seed;
  var d0 = hash(s, n, 0), d1 = hash(s, n, 1), d2 = hash(s, n, 2), d3 = hash(s, n, 3), d4 = hash(s, n, 4);
  var repeat = n >= CLUSTER_FROM && g.run < CLUSTER_MAX && (d0 % 100) < CLUSTER_PCT;
  var G, steps, run;
  if (repeat) { G = g.lastG; steps = CLUSTER_STEPS; run = g.run + 1; }
  else {
    G = -G_RANGE + (d1 % (2 * G_RANGE + 1));
    if (Math.abs(G - g.lastG) < MIN_JUMP) {
      G = G >= g.lastG ? g.lastG + MIN_JUMP : g.lastG - MIN_JUMP;
      if (G > G_RANGE) G = g.lastG - MIN_JUMP;
      if (G < -G_RANGE) G = g.lastG + MIN_JUMP;
    }
    steps = reactAt(n) + Math.ceil(Math.abs(G - g.lastG) / RATE);
    run = 0;
  }
  var z = n === 0 ? FIRST_GATE_Z : g.lastZ + steps * feverSpeed(speedAt(n));
  var gate = { n: n, z: z, G: G, gem: !repeat && n > 0 && (d2 % 100) < GEM_PCT };
  sim.gates = sim.gates.concat([gate]);
  // A row of coins in the gap before this gate. The shape that catches them is
  // a detour the player may take or skip.
  if (n > 0 && z - g.lastZ >= COIN_MIN_GAP && (d3 % 100) < COIN_PCT) {
    var Ac = -G_RANGE + (d4 % (2 * G_RANGE + 1));
    var z0 = g.lastZ + Math.floor((z - g.lastZ) / 5), add = [];
    for (var k = 0; k < COIN_GROUP; k++) {
      var x = Ac >= 0 ? 0 : (k % 2 ? 1 : -1) * Math.floor(wOf(Ac) * COIN_X_PCT / 100);
      var y = Ac >= 0 ? Math.floor(hOf(Ac) * COIN_Y_PCT / 100) : COIN_LOW_Y;
      add.push({ id: sim.coinSeq + k, z: z0 + k * COIN_SPACING, x: x, y: y });
    }
    sim.coinSeq += COIN_GROUP;
    sim.coins = sim.coins.concat(add);
  }
  sim.gen = { n: n + 1, lastG: G, lastZ: z, run: run };
}

function rng(d, a, b) { return a + (d % (b - a + 1)); }
function cl(a) { return Math.max(-A_MAX, Math.min(A_MAX, a)); }
// a G at least MIN_JUMP from `from`, from draw d (the v2 rule)
function jumpFrom(d, from) {
  var G = -G_RANGE + (d % (2 * G_RANGE + 1));
  if (Math.abs(G - from) < MIN_JUMP) {
    G = G >= from ? from + MIN_JUMP : from - MIN_JUMP;
    if (G > G_RANGE) G = from - MIN_JUMP;
    if (G < -G_RANGE) G = from + MIN_JUMP;
  }
  return G;
}
function part(t, lo, hi) {
  return { t: t, lo: lo, hi: hi, lo2: lo, hi2: hi, u: 0, mv: MV_NONE, amp: 0, v: 0, ph: 0,
    len: 0, hlo: 0, hhi: 0, shr: 0, hmv: 0, bonus: 0, coin: 0 };
}
function pWin(t, G) { return part(t, G - TOL, G + TOL); }
function pBar(t, h) { return part(t, -A_MAX, h); }
function pSlit(t, l) { return part(t, l, A_MAX); }
function withHold(p, steps, speed) { p.len = steps * speed; p.hlo = p.lo; p.hhi = p.hi; return p; }
function withMove(p, amp, v, ph) { p.mv = MV_TRI; p.amp = amp; p.v = v; p.ph = ph % (4 * amp); return p; }
// the PERFECT shape of a part when it is still
function centreOf(p) {
  if (p.lo <= -A_MAX) return p.hi - PERFECT_TOL;
  if (p.hi >= A_MAX) return p.lo + PERFECT_TOL;
  return Math.floor((p.lo + p.hi) / 2);
}
function pickKind(gi, d) {
  if (gi < 1) return K_GATE;
  if (gi % BOSS_EVERY === BOSS_EVERY - 1) return K_BOSS;
  var top = 0, k, tot = 0;
  for (k = 0; k < 5; k++) if (gi >= TIER_FROM[k]) top = k;
  for (k = 0; k < KINDS - 1; k++) if (TIER_OF[k] <= top) tot += TIER_OF[k] === top ? 3 : 2;
  var r = d % tot;
  for (k = 0; k < KINDS - 1; k++) {
    if (TIER_OF[k] > top) continue;
    var w = TIER_OF[k] === top ? 3 : 2;
    if (r < w) return k;
    r -= w;
  }
  return K_GATE;
}
// Group gi: twelve draws, whatever the kind uses.
function buildGroup(sim, gi, pc, speed, forceK) {
  var s = sim.seed, d = [];
  for (var j = 0; j < 12; j++) d.push(hash(s, 50000 + gi, j));
  var k = forceK !== undefined ? forceK : pickKind(gi, d[0]), G, G2, G3, b, l, p, out;
  switch (k) {
    case K_WIDE: out = [pWin(k, rng(d[1], -900, -450))]; break;
    case K_TALL: out = [pWin(k, rng(d[1], 450, 900))]; break;
    case K_COIN: p = pWin(k, jumpFrom(d[1], pc)); p.coin = 1; out = [p]; break;
    case K_ARCH: out = [pWin(k, jumpFrom(d[1], pc))]; break;
    case K_BAR: out = [pBar(k, rng(d[1], -700, 200))]; break;
    case K_SLIT: out = [pSlit(k, rng(d[1], -200, 700))]; break;
    case K_LASER: out = [pBar(k, rng(d[1], -600, 400))]; break;
    case K_BEAM: out = [pBar(k, rng(d[1], 0, 600))]; break;
    case K_PILLARS: out = [pSlit(k, rng(d[1], 0, 800))]; break;
    case K_RAMP: p = pWin(k, jumpFrom(d[1], pc)); p.bonus = POINTS_RAMP; out = [p]; break;
    case K_RAILS: p = withHold(pBar(k, rng(d[1], -750, 0)), HOLD_STEPS, speed); p.bonus = POINTS_HOLD; out = [p]; break;
    case K_TUNNEL: p = withHold(pWin(k, jumpFrom(d[1], pc)), HOLD_STEPS, speed); p.bonus = POINTS_HOLD; out = [p]; break;
    case K_CEIL: p = withHold(pBar(k, rng(d[1], -700, 0)), HOLD_STEPS, speed); p.bonus = POINTS_HOLD; out = [p]; break;
    case K_BRIDGE: p = withHold(pSlit(k, rng(d[1], 0, 700)), HOLD_STEPS, speed); p.bonus = POINTS_HOLD; out = [p]; break;
    case K_BROKEN: p = withHold(pBar(k, rng(d[1], -600, 100)), SHORT_HOLD_STEPS, speed); p.bonus = POINTS_RAMP; out = [p]; break;
    case K_PAIR: G = jumpFrom(d[1], pc); G2 = jumpFrom(d[2], G); out = [pWin(k, G), pWin(k, G2)]; break;
    case K_STAIRS: G = rng(d[1], 300, 900); out = [pWin(k, G), pWin(k, G - 400), pWin(k, G - 800)]; break;
    case K_MOVER: out = [withMove(pWin(k, jumpFrom(d[1], pc)), 120, 4, d[2])]; break;
    case K_SLIDERS: out = [withMove(pSlit(k, rng(d[1], 0, 500)), 150, 3, d[2])]; break;
    case K_CRUSHER: out = [withMove(pBar(k, rng(d[1], -500, 0)), 150, 3, d[2])]; break;
    case K_RISER: out = [withMove(pBar(k, rng(d[1], -400, 300)), 200, 5, d[2])]; break;
    case K_PENDULUM: out = [withMove(pBar(k, rng(d[1], -300, 300)), 250, 6, d[2])]; break;
    case K_SPINNER: out = [withMove(pSlit(k, rng(d[1], 0, 500)), 200, 6, d[2])]; break;
    case K_PULSE:
      G = rng(d[1], 300, 900); G2 = rng(d[2], -900, -300);
      p = pWin(k, G); p.lo2 = G2 - TOL; p.hi2 = G2 + TOL; p.mv = MV_PULSE; p.v = 120; p.ph = d[3] % 120; out = [p]; break;
    case K_MRAILS:
      p = withMove(withHold(pBar(k, rng(d[1], -650, -100)), HOLD_STEPS, speed), 100, 2, d[2]);
      p.hmv = 1; p.bonus = POINTS_HOLD; out = [p]; break;
    case K_PLUS:
      G = rng(d[1], 450, 900); G2 = rng(d[2], -900, -450);
      p = pWin(k, G); p.u = 1; p.lo2 = G2 - TOL; p.hi2 = G2 + TOL; out = [p]; break;
    case K_SPLIT:
      G = rng(d[1], -900, 900); G2 = G >= 0 ? rng(d[2], -900, G - 600) : rng(d[2], G + 600, 900);
      p = pWin(k, G); p.u = 1; p.lo2 = G2 - TOL; p.hi2 = G2 + TOL; out = [p]; break;
    case K_ZIGZAG:
      G = rng(d[1], 0, 900); b = G - 400 - (d[2] % 300); l = Math.min(900, b + 500 + (d[3] % 300));
      out = [pWin(k, G), pBar(K_BAR, b), pSlit(K_SLIT, l)]; break;
    case K_TRIPLE: G = jumpFrom(d[1], pc); G2 = jumpFrom(d[2], G); G3 = jumpFrom(d[3], G2);
      out = [pWin(k, G), pWin(k, G2), pWin(k, G3)]; break;
    case K_RAILHOOP:
      b = rng(d[1], -750, -100); p = withHold(pBar(K_RAILS, b), HOLD_STEPS, speed); p.bonus = POINTS_HOLD;
      G = jumpFrom(d[2], b - PERFECT_TOL); var hp = pWin(K_RAMP, G); hp.bonus = POINTS_RAMP; out = [p, hp]; break;
    case K_TUNSLIT:
      G = rng(d[1], -900, 300); p = withHold(pWin(K_TUNNEL, G), HOLD_STEPS, speed); p.bonus = POINTS_HOLD;
      out = [p, pSlit(K_SLIT, Math.min(850, G + 250 + (d[2] % 300)))]; break;
    case K_GRID: out = [pWin(k, jumpFrom(d[1], pc))]; break;
    case K_SHRINK:
      p = withHold(pWin(k, jumpFrom(d[1], pc)), HOLD_STEPS, speed); p.shr = TOL; p.bonus = POINTS_SHRINK; out = [p]; break;
    case K_GAUNTLET:
      out = []; var c = pc;
      for (var i = 0; i < 5; i++) {
        var kind = d[2 + i] % 3, q;
        if (kind === 1 && c - EDGE_TOL - 1 >= -800) q = pBar(K_BAR, rng(d[7], -800, c - EDGE_TOL - 1));
        else if (kind === 2 && c + EDGE_TOL + 1 <= 800) q = pSlit(K_SLIT, rng(d[8], c + EDGE_TOL + 1, 800));
        else q = pWin(K_GATE, jumpFrom(d[2 + i] >>> 3, c));
        out.push(q); c = centreOf(q);
      }
      break;
    case K_BOSS: p = pWin(k, jumpFrom(d[1], pc)); p.bonus = POINTS_BOSS; out = [p]; break;
    default: out = [pWin(K_GATE, jumpFrom(d[1], pc))];
  }
  for (var m = 0; m < out.length; m++) { out[m].k = k; out[m].first = m === 0 ? 1 : 0; }
  return { parts: out, gem: d[9], coin: d[10], coinA: d[11] };
}
function partOff(p, f) {
  if (p.mv !== MV_TRI) return 0;
  var v = (f * p.v + p.ph) % (4 * p.amp);
  return Math.abs(v - 2 * p.amp) - p.amp;
}
function pulseB(p, f) { return p.mv === MV_PULSE && ((f + p.ph) % p.v) * 2 >= p.v; }
// does a still shape c already pass this part? (then it does not ask for a change)
function passesStill(p, c) {
  var a = p.mv === MV_TRI ? p.amp : 0;
  if (c >= p.lo - a && c <= p.hi + a) return true;
  return (p.u === 1 || p.mv === MV_PULSE) && c >= p.lo2 - a && c <= p.hi2 + a;
}
// what must be reached (both halves for a pulse: either may be live on arrival)
function reachOf(p) {
  var a = p.mv === MV_TRI ? p.amp : 0;
  var lo = p.lo > -A_MAX ? p.lo + a : p.lo, hi = p.hi < A_MAX ? p.hi - a : p.hi;
  if (p.u === 1 || p.mv === MV_PULSE) return [cl(lo), cl(hi), cl(p.lo2), cl(p.hi2)];
  return [cl(lo), cl(hi), cl(lo), cl(hi)];
}
// what the jelly may leave a part as
function exitOf(p) {
  var a = p.mv === MV_TRI ? p.amp : 0;
  if (p.len > 0) { var ha = p.hmv ? p.amp : 0; return [cl(p.hlo - ha), cl(p.hhi - p.shr + ha), cl(p.hlo - ha), cl(p.hhi - p.shr + ha)]; }
  if (p.u === 1 || p.mv === MV_PULSE) return [cl(p.lo - a), cl(p.hi + a), cl(p.lo2 - a), cl(p.hi2 + a)];
  return [cl(p.lo - a), cl(p.hi + a), cl(p.lo - a), cl(p.hi + a)];
}
// the largest move needed from anywhere in the exit set to the reach set
function gapNeed(x, r, all) {
  function to(lo, hi, a, b) { return Math.max(0, lo - a, b - hi); }
  function one(a, b) {
    var p = to(r[0], r[1], a, b), q = to(r[2], r[3], a, b);
    return all ? Math.max(p, q) : Math.min(p, q);
  }
  return Math.max(one(x[0], x[1]), one(x[2], x[3]));
}

// Gate n, v3: the next part of the current group (a new group when it runs out).
// A part that the last part's PERFECT shape would already pass, held still,
// becomes a plain gate, so every part asks the jelly to change and nobody parks.
// Every gap is sized from the furthest shape the jelly may leave the last part
// as to the nearest that passes this one, counted at FEVER speed.
function makeGate3(sim) {
  var g = sim.gen, n = g.n, s = sim.seed, pc = g.lastG;
  var q = g.q, gi = g.gi, grp = null;
  if (!q.length) { grp = buildGroup(sim, gi, pc, speedAt(n)); q = grp.parts; gi++; }
  var p = q[0];
  q = q.slice(1);
  if (n === 0 || passesStill(p, pc)) {
    var keepK = p.k, keepF = p.first;
    p = pWin(K_GATE, jumpFrom(hash(s, n, 9), pc)); p.k = keepK; p.first = keepF;
  }
  var steps = (p.first ? reactAt(n) : COMBO_REACT) + Math.ceil(gapNeed([g.xl, g.xh, g.xl2, g.xh2], reachOf(p), p.mv === MV_PULSE) / RATE);
  var z = n === 0 ? FIRST_GATE_Z : g.lastEnd + steps * feverSpeed(speedAt(n));
  var gate = Object.assign({}, p, { n: n, z: z, G: centreOf(p),
    gem: !!grp && n > 0 && p.len === 0 && (grp.gem % 100) < GEM_PCT });
  sim.gates = sim.gates.concat([gate]);
  if (grp && n > 0 && z - g.lastEnd >= COIN_MIN_GAP && (p.coin === 1 || (grp.coin % 100) < COIN_PCT)) {
    var Ac = p.coin === 1 ? gate.G : -G_RANGE + (grp.coinA % (2 * G_RANGE + 1));
    var z0 = g.lastEnd + Math.floor((z - g.lastEnd) / 5), add = [];
    for (var k = 0; k < COIN_GROUP; k++) {
      var x = Ac >= 0 ? 0 : (k % 2 ? 1 : -1) * Math.floor(wOf(Ac) * COIN_X_PCT / 100);
      var y = Ac >= 0 ? Math.floor(hOf(Ac) * COIN_Y_PCT / 100) : COIN_LOW_Y;
      add.push({ id: sim.coinSeq + k, z: z0 + k * COIN_SPACING, x: x, y: y });
    }
    sim.coinSeq += COIN_GROUP;
    sim.coins = sim.coins.concat(add);
  }
  var x = exitOf(p);
  sim.gen = { n: n + 1, lastG: gate.G, lastZ: z, run: 0, gi: gi, lastEnd: z + p.len, xl: x[0], xh: x[1], xl2: x[2], xh2: x[3], q: q };
}

function perfectIn(lo, hi, A, blo, bhi) {
  if (blo <= -A_MAX) return A >= hi - EDGE_PERFECT_V3;
  if (bhi >= A_MAX) return A <= lo + EDGE_PERFECT_V3;
  return Math.abs(A - Math.floor((lo + hi) / 2)) <= PERFECT_V3;
}
// -1 does not fit, 0 fits, 1 PERFECT. A v2 gate has no `t`.
function gateFit(gt, A, f, lockB) {
  var d;
  if (gt.t === undefined) { d = Math.abs(A - gt.G); return d > TOL ? -1 : (d <= PERFECT_TOL ? 1 : 0); }
  var o = partOff(gt, f), r = -1, useA = true, useB = gt.u === 1;
  if (gt.mv === MV_PULSE) { useB = lockB !== undefined ? lockB === 1 : pulseB(gt, f); useA = !useB; }
  if (useA && A >= gt.lo + o && A <= gt.hi + o) r = Math.max(r, perfectIn(gt.lo + o, gt.hi + o, A, gt.lo, gt.hi) ? 1 : 0);
  if (useB && A >= gt.lo2 + o && A <= gt.hi2 + o) r = Math.max(r, perfectIn(gt.lo2 + o, gt.hi2 + o, A, gt.lo2, gt.hi2) ? 1 : 0);
  return r;
}
// the PERFECT shape for a part at step f (the autopilot and the test pilots aim here)
function aimFor(gt, f, cur, lockB) {
  var o = partOff(gt, f);
  if (gt.mv === MV_PULSE && (lockB !== undefined ? lockB === 1 : pulseB(gt, f))) return Math.floor((gt.lo2 + gt.hi2) / 2);
  var a = centreOf({ lo: gt.lo, hi: gt.hi }) + o;
  if (gt.u === 1) { var b = Math.floor((gt.lo2 + gt.hi2) / 2); return Math.abs(cur - b) < Math.abs(cur - a) ? b : a; }
  return a;
}
// the band a hold allows at the jelly's position
function holdBand(hd, z, f) {
  var o = partOff(hd, f), sh = hd.shr ? Math.floor(hd.shr * (z - hd.z0) / hd.len) : 0;
  return [hd.lo + o, hd.hi + o - sh];
}
function feverStreakOf(sim) { return sim.version >= 3 ? FEVER_STREAK_V3 : FEVER_STREAK; }
function feverChargeOf(sim) { return sim.version >= 3 ? sim.charge : sim.streak % FEVER_STREAK; }
function feverStepsOf(sim) { return sim.version >= 3 ? FEVER_STEPS_V3 : FEVER_STEPS; }
function runSpeed(sim) { var s = speedAt(sim.passed); return sim.fever > 0 ? (sim.version >= 3 ? s * FEVER_SPEED_V3 : feverSpeed(s)) : s; }
function unbreakable(sim) { return sim.version >= 3 && (sim.fever > 0 || sim.grace > 0); }

function setTarget(sim, t) { sim.target = clampA(t | 0); }
// v4: the pulse state a gate is locked to (1 = the B opening), or undefined
function lockOf(sim, gt) { return sim.plock ? sim.plock[gt.n] : undefined; }
// v4: lock every pulse within PULSE_LOCK_STEPS of the jelly at this speed
function lockPulses(sim, speed, ev) {
  var lim = sim.z + PULSE_LOCK_STEPS * speed, add = null;
  for (var i = 0; i < sim.gates.length && sim.gates[i].z <= lim; i++) {
    var gt = sim.gates[i];
    if (gt.mv !== MV_PULSE || sim.plock[gt.n] !== undefined || (add && add[gt.n] !== undefined)) continue;
    if (!add) add = {};
    add[gt.n] = pulseB(gt, sim.frames) ? 1 : 0;
    ev.push({ k: 'lock', n: gt.n, b: add[gt.n] });
  }
  if (add) sim.plock = Object.assign({}, sim.plock, add);
}

function stepSim(sim) {
  var ev = [];
  sim.events = ev;
  if (sim.dead) return;
  sim.frames++;
  var d = sim.target - sim.A;
  sim.A += Math.max(-RATE, Math.min(RATE, d));
  var speed = speedAt(sim.passed);
  if (sim.fever > 0) {
    speed = sim.version >= 3 ? speed * FEVER_SPEED_V3 : feverSpeed(speed);
    sim.fever--;
    if (sim.fever === 0) { ev.push({ k: 'feverEnd' }); if (sim.version >= 3) sim.grace = FEVER_GRACE; }
  } else if (sim.grace > 0) sim.grace--;
  sim.z += speed;
  if (sim.version >= 4) lockPulses(sim, speed, ev);
  // coins first: a coin row always lies strictly between two gates
  while (sim.coins.length && sim.coins[0].z <= sim.z) {
    var c = sim.coins[0];
    sim.coins = sim.coins.slice(1);
    var hit = Math.abs(c.x) * 2 <= wOf(sim.A) && c.y <= hOf(sim.A);
    if (hit) { sim.score += POINTS_COIN * (sim.version >= 3 && sim.fever > 0 ? FEVER_MULT : 1); sim.coinsTaken++; }
    ev.push({ k: hit ? 'coin' : 'coinMiss', coin: c });
  }
  // a held section: the shape must stay in the band until it is off the far end
  if (sim.hold) {
    var hd = sim.hold;
    if (sim.z > hd.endZ) {
      var hb = hd.bonus * (sim.fever > 0 ? FEVER_MULT : 1);
      sim.score += hb; sim.hold = null; ev.push({ k: 'holdDone', n: hd.n, t: hd.t, bonus: hb });
    } else {
      var band = holdBand(hd, sim.z, sim.frames);
      if ((sim.A < band[0] || sim.A > band[1]) && !unbreakable(sim)) {
        sim.dead = true; sim.deathStep = sim.frames;
        ev.push({ k: 'crash', gate: { n: hd.n, z: sim.z, G: band[1] - PERFECT_TOL, t: hd.t }, fall: true });
        return;
      }
    }
  }
  while (sim.gates.length && sim.gates[0].z <= sim.z) {
    var gt = sim.gates[0];
    var fit = gateFit(gt, sim.A, sim.frames, lockOf(sim, gt)), smash = false;
    if (fit < 0) {
      if (!unbreakable(sim)) {
        sim.dead = true; sim.deathStep = sim.frames;
        ev.push({ k: 'crash', gate: gt });
        return;
      }
      smash = true;
    }
    var diff = Math.abs(sim.A - gt.G);
    sim.gates = sim.gates.slice(1);
    if (sim.plock && sim.plock[gt.n] !== undefined) { var pl = Object.assign({}, sim.plock); delete pl[gt.n]; sim.plock = pl; }
    sim.passed++;
    var pts = POINTS_GATE, perfect = fit === 1;
    if (perfect) {
      sim.streak++; sim.perfects++;
      pts += POINTS_PERFECT * Math.min(sim.streak, STREAK_CAP);
      if (sim.version >= 3) {
        // v3: the meter fills only while FEVER is off, and empties when it starts
        if (sim.fever === 0 && sim.grace === 0 && ++sim.charge >= FEVER_STREAK_V3) {
          sim.charge = 0; sim.fever = FEVER_STEPS_V3; ev.push({ k: 'fever' });
        }
      } else if (sim.streak % FEVER_STREAK === 0 && sim.fever === 0) { sim.fever = FEVER_STEPS; ev.push({ k: 'fever' }); }
    } else if (!smash) { sim.streak = 0; sim.charge = 0; }
    if (gt.gem) { pts += POINTS_GEM; sim.gems++; }
    if (gt.t !== undefined && gt.len === 0) pts += gt.bonus;
    if (gt.t !== undefined && gt.len > 0) {
      sim.hold = { n: gt.n, t: gt.t, z0: gt.z, endZ: gt.z + gt.len, len: gt.len, lo: gt.hlo, hi: gt.hhi, shr: gt.shr,
        mv: gt.hmv ? MV_TRI : MV_NONE, amp: gt.amp, v: gt.v, ph: gt.ph, bonus: gt.bonus };
    }
    if (sim.version >= 3 && sim.fever > 0) pts *= FEVER_MULT;
    sim.score += pts;
    ev.push({ k: 'pass', gate: gt, perfect: perfect, streak: sim.streak, gem: gt.gem, diff: diff, smash: smash });
  }
  while (sim.gen.lastZ < sim.z + AHEAD_Z) makeGate(sim);
}
// ==== END RULES BLOCK ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A path batch is at most this many samples (the client closes one at 120).
const MAX_BATCH = 120;
// A WORK bound far above any real run: one sample a step for the whole hour
// plus room for touch and lift markers. It REFUSES further inputs, never zeroes.
const MAX_INPUTS = MAX_SIM_STEPS + 20000;

// Every step the server runs goes through stepWatched, so the fingerprint and
// a test's per-step hook see the whole run, gaps between batches included.
function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepWatched(state);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}
function isAspect(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= -A_MAX && v <= A_MAX;
}

function init({ seed, maxDurationSecs, elapsedSecs, onStep } = {}) {
  return {
    mode: 'none', sim: null, onStep: typeof onStep === 'function' ? onStep : null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { fit: [], lead: [], travel: 0, need: 0, touches: 0, lifts: 0, samples: 0,
      lastT: 0, nextN: -1, settledAt: -1, overshoots: 0, lastDir: 0, peak: null },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. For each gate: the fit error |A - G| at the crossing
// (a program fits every opening dead centre), and how many steps BEFORE the
// crossing the shape had settled within PERFECT_TOL (a planner settles early
// and evenly, a hand late and unevenly). For the drag: total target travel
// against the travel the gates needed, and the overshoots (target turning back
// after passing the opening's aspect), which a thumb makes and a program does not.
function watchStep(state) {
  const sim = state.sim, st = state.stats;
  // The crossing first, against the gate it belongs to; then the next gate.
  for (const e of sim.events) {
    if (e.k === 'pass' || e.k === 'crash') {
      st.fit.push(Math.abs(sim.A - e.gate.G));
      if (e.gate.n === st.nextN && st.settledAt >= 0) st.lead.push(sim.frames - st.settledAt);
      st.need += Math.abs(e.gate.G - (st.prevG == null ? 0 : st.prevG));
      st.prevG = e.gate.G;
    }
  }
  const next = sim.gates[0];
  if (next && next.n !== st.nextN) { st.nextN = next.n; st.settledAt = -1; }
  if (next && st.settledAt < 0 && Math.abs(sim.A - next.G) <= PERFECT_TOL) st.settledAt = sim.frames;
}
function noteTarget(st, v) {
  const d = v - st.lastT;
  if (d !== 0) {
    st.travel += Math.abs(d);
    const dir = d > 0 ? 1 : -1;
    if (st.lastDir !== 0 && dir !== st.lastDir) st.overshoots++;
    st.lastDir = dir;
  }
  st.lastT = v;
  st.samples++;
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

function stepWatched(state) {
  stepSim(state.sim);
  watchStep(state);
  if (state.onStep) state.onStep(state.sim);
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
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  const sim = state.sim;

  if (kind === 'touch' || kind === 'lift') {
    // Markers only: the target persists between batches, so they change
    // nothing in the rules. Counted for the fingerprint, and never allowed to
    // name a step behind the run.
    if (!isStep(payload.step) || payload.step < sim.frames) return reject(state, 'bad_marker');
    if (kind === 'touch') state.stats.touches++; else state.stats.lifts++;
    return { accepted: true, newScore: state.score };
  }
  if (kind !== 'path') return { accepted: true, newScore: state.score };

  const { f, x } = payload;
  if (!isStep(f) || !Array.isArray(x) || x.length < 1 || x.length > MAX_BATCH) return reject(state, 'bad_path');
  for (let i = 0; i < x.length; i++) if (!isAspect(x[i])) return reject(state, 'bad_path');
  if (state.inputCount + x.length > MAX_INPUTS) return reject(state, 'input_cap');
  // A batch may never reach back into steps already run: a rewind would
  // re-run a window and keep the best outcome. Refused whole.
  if (f < sim.frames) return reject(state, 'frame_regressed');
  advanceTo(state, f);
  if (sim.dead) { state.dead = true; state.score = sim.score; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  if (sim.frames !== f) return reject(state, 'beyond_cap');
  state.inputCount += x.length;
  for (let i = 0; i < x.length && !sim.dead && sim.frames < MAX_SIM_STEPS; i++) {
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
  if (state.mode !== 'sim' || !state.sim) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const sim = state.sim;
  // Run the world out past the last input. A shape that stops changing dies at
  // the next gate it does not fit: every new gate is MIN_JUMP away from the last.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepWatched(state);
    guard++;
  }
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.frames, deathStep: sim.deathStep,
      score: sim.score, passed: sim.passed, perfects: sim.perfects, gems: sim.gems, coins: sim.coinsTaken, dead: sim.dead,
      inputs: state.inputCount, rejects: state.rejectCount,
      touches: st.touches, lifts: st.lifts, samples: st.samples,
      fitMean: round3(mean(st.fit)), fitSd: round3(sd(st.fit)),
      leadMean: round3(mean(st.lead)), leadSd: round3(sd(st.lead)),
      travelRatio: st.need > 0 ? round3(st.travel / st.need) : null,
      overshootsPerGate: sim.passed ? round3(st.overshoots / sim.passed) : null,
      perfectShare: sim.passed ? round3(sim.perfects / sim.passed) : null,
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
    RULES_VERSION, PULSE_LOCK_STEPS, lockOf, initSim, stepSim, makeGate3, buildGroup, gateFit, aimFor, holdBand, partOff, pulseB, centreOf, passesStill, reachOf, exitOf, gapNeed, pickKind, jumpFrom,
    feverStreakOf, feverChargeOf, feverStepsOf, unbreakable, FEVER_STREAK_V3, FEVER_STEPS_V3, FEVER_SPEED_V3, runSpeed, FEVER_GRACE, FEVER_MULT, EDGE_TOL, PERFECT_V3, EDGE_PERFECT_V3, COMBO_REACT,
    HOLD_STEPS, SHORT_HOLD_STEPS, MV_NONE, MV_TRI, MV_PULSE, POINTS_HOLD, POINTS_RAMP, POINTS_BOSS, POINTS_SHRINK, BOSS_EVERY, KINDS, TIER_OF, TIER_FROM,
    K_GATE, K_WIDE, K_TALL, K_COIN, K_ARCH, K_BAR, K_SLIT, K_LASER, K_BEAM, K_PILLARS, K_RAMP, K_RAILS, K_TUNNEL, K_CEIL, K_BRIDGE, K_BROKEN, K_PAIR, K_STAIRS,
    K_MOVER, K_SLIDERS, K_CRUSHER, K_RISER, K_PENDULUM, K_SPINNER, K_PULSE, K_MRAILS, K_PLUS, K_SPLIT, K_ZIGZAG, K_TRIPLE, K_RAILHOOP, K_TUNSLIT, K_GRID, K_SHRINK, K_GAUNTLET, K_BOSS,
    setTarget, makeGate, advanceTo, hash, seedToInt, hOf, wOf, clampA,
    speedAt, feverSpeed, reactAt, MAX_INPUTS, MAX_SIM_STEPS, MAX_BATCH,
    A_MAX, RATE, TOL, PERFECT_TOL, SPEED0, SPEED_PER_GATE, SPEED_MAX, FEVER_STREAK, FEVER_STEPS, FEVER_NUM, FEVER_DEN,
    REACT0, REACT_EVERY, REACT_MIN, CLUSTER_STEPS, CLUSTER_MAX, CLUSTER_PCT, CLUSTER_FROM, G_RANGE, MIN_JUMP, FIRST_GATE_Z, AHEAD_Z,
    POINTS_GATE, POINTS_PERFECT, POINTS_GEM, POINTS_COIN, STREAK_CAP, GEM_PCT, COIN_PCT, COIN_GROUP, COIN_SPACING,
    COIN_MIN_GAP, COIN_X_PCT, COIN_Y_PCT, COIN_LOW_Y, AREA, H_KNOTS, SEED_MIX, HASH_K, HASH_J, MIX_A, MIX_B,
  },
};
