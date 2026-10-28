'use strict';
// Jhoola (Jungle Baandar): server-side deterministic REPLAY (Oct 2026, migration 254).
//
// A rope-swing runner. The rules block below is carried WORD FOR WORD in
// games/jhoola/js/rules.js and pinned by sha256 in shared/tests/jhoolaParity.test.js.
//
// Trace v2: { kind: 'start', v: 2 } then one { kind: 'hold', n, pressStep, releaseStep }
// per finger hold: n is its index, pressStep the fixed step the press was applied
// before, releaseStep the step the release was applied before (a run that ends
// mid-hold closes the hold at its death step). The server runs the world up to
// pressStep, presses, runs up to releaseStep, releases, and computes the score
// itself. A hold the rules refuse changes nothing; refusals never zero a run.
// After the last hold the world runs out to the death, bounded by the session's
// real length. Integer rules, no dmath needed.

// ==== JHOOLA RULES BEGIN ====
// Rules space: a side view, x to the right, y DOWN, in sub-units of 1/256 of a
// design unit (the design field is 414 x 736). A point mass moves by Verlet
// steps of 1/60 s; on a rope it is held to a circle round the hook. The
// drawing, the camera, the sag of the rope and every effect never read or
// write anything here.
var RULES_VERSION = 3;
var P = 256;                    // sub-units per design unit
var TUNE_DEFAULTS = {
  g: 66,                        // gravity, sub-units per step per step
  boostNum: 9,                  // release boost, velocity x boostNum / 8
  reach: 220,                   // design units the rope can reach
  run: 3,                       // design units a step along the start roof
  vmax: 12,                     // design units a step, either axis
  pump: 6,                      // while on the rope, speed x (1024 + pump) / 1024 a step ...
  swingMax: 8,                  // ... up to this many design units a step
  ropeMax: 130                  // a longer rope is reeled in to this at once
};
// v3: no start roof and no awnings. The monkey starts swinging on the first hook,
// pressing throws a rope that catches any hook in reach (even one just behind or
// a little below), and a held press keeps looking until it finds one.
var V3_TUNE = { reach: 250, ropeMax: 150, pump: 10, swingMax: 9, g: 62 };
var BEHIND3 = 40;               // v3: a hook this far behind can still be caught
var BELOW3 = 30;                // v3: a hook this far below the monkey can still be caught
var BEHIND3_COST = 80;          // v3: a hook behind counts as this much farther
var START3_X = 40;              // v3: the monkey starts at the door of his home
var START3_Y = 415;
var RUN3_WAIT = 36;             // v3: steps before he steps out
var RUN3_SPEED = 2.8;           // design units a step along the platform
var JUMP3_X = 190;              // he jumps off the platform edge here
var JUMP3_VX = 4.2;             // and leaves at this speed, units a step
var JUMP3_VY = -6.2;
var HOOK0_X_V3 = 420;           // v3: the first ring hangs ahead of the jump, not beside the platform
var HOOK0_Y_V3 = 290;
var X1_V3 = 690;
var GAP0_V3 = 290;              // v3: base gap between rings (v2: 175)
var GAP_GROW_V3 = 4;
var GAP_CAP_K_V3 = 12;
var BANANA_PTS = 2;             // v3: bananas come in bunches and are worth less each
var BANANA_ID = 16;             // banana j of gap k is id k * BANANA_ID + j
var BOOST_DEN = 8;
var REEL = 4;                    // design units a step a long rope is reeled in
var HANG_MAX = 300;             // steps on one hook before the rope snaps (5 s)
var LEDGE_END = 150;            // design x where the start roof ends
var LEDGE_Y = 470;              // the runner's centre while on the roof
var START_X = 110;
var LEDGE_WAIT = 300;             // the runner waits on the roof this long, then walks off
var WATER_Y = 640;              // centre below this: in the river
var METRE = 24;                 // design units a metre
var KITE_POINTS = 5;
var KITE_R = 30;                // collect radius, design units
var KITE_PCT = 70;
var PAD_W0 = 160;               // awning width at the start, design units
var PAD_W_MIN = 90;
var PAD_Y = 572;                // top of an awning
var PAD_ALL_UNTIL = 6;          // every gap before this hook has an awning
var PAD_PCT_MIN = 22;           // later gaps: chance falls to this
var PAD_KICK = 11;              // design units a step, the least an awning throws you up
var PAD_FWD = 4;                // and the least it carries you forward
var AIR_FLIP = 45;              // steps in the air per flip
var FLIP_POINTS = 0;
var BEHIND = 0;                 // a hook this far behind can still be grabbed
var HOOK0_X = 205;
var HOOK0_Y = 330;
var X1 = 400;                   // hook 1's base x
var GAP0 = 175;                 // base gap from hook 1 to 2
var GAP_GROW = 3;               // the gap grows this much per hook ...
var GAP_CAP_K = 28;             // ... for this many hooks
var JIT = 22;                   // +- design units of jitter on each hook's x
var Y_MID = 250;
var Y_SPAN0 = 30;               // half range of hook heights at the start
var Y_SPAN_GROW = 6;
var Y_SPAN_MAX = 110;
var MOVE_FROM = 8;              // hooks from here may bob
var MOVE_PCT = 35;

function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, 0x9E3779B1) ^ Math.imul(j + 7, 0x85EBCA77)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
  return (h ^ (h >>> 16)) >>> 0;
}

function isqrt(n) {
  if (n <= 0) return 0;
  var r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

function idiv(a, b) { return Math.trunc(a / b); }

// sum over i < k of min(i, GAP_CAP_K), closed form
function capSum(k, cap) {
  if (k <= cap + 1) return (k * (k - 1)) / 2;
  return (cap * (cap + 1)) / 2 + (k - 1 - cap) * cap;
}

// Hook k, as a pure function of (seed, k): five draws, all taken on every index.
function hookSpec(seed, k, v) {
  if (k === 0) return v >= 3 ? { k: 0, x: HOOK0_X_V3 * P, y: HOOK0_Y_V3 * P, amp: 0, per: 1, ph: 0 } : { k: 0, x: HOOK0_X * P, y: HOOK0_Y * P, amp: 0, per: 1, ph: 0 };
  var a = hash(seed, k, 0), b = hash(seed, k, 1), c = hash(seed, k, 2);
  var d = hash(seed, k, 3), e = hash(seed, k, 4);
  var i = k - 1;
  var base = v >= 3 ? X1_V3 + i * GAP0_V3 + GAP_GROW_V3 * capSum(i, GAP_CAP_K_V3) : X1 + i * GAP0 + GAP_GROW * capSum(i, GAP_CAP_K);
  var jit = (a % (2 * JIT + 1)) - JIT;
  var span = Math.min(Y_SPAN_MAX, Y_SPAN0 + Y_SPAN_GROW * k);
  var y = Y_MID + (b % (2 * span + 1)) - span;
  var moves = k >= MOVE_FROM && (c % 100) < MOVE_PCT;
  var amp = moves ? 24 + (d % 30) : 0;
  var per = moves ? 150 + (e % 100) : 1;
  var ph = moves ? (d >>> 8) % per : 0;
  return { k: k, x: (base + jit) * P, y: y * P, amp: amp * P, per: per, ph: ph };
}

// A triangle wave in [-amp, amp] over `per` steps.
function hookPos(h, frame) {
  if (h.amp === 0) return { x: h.x, y: h.y };
  var t = (frame + h.ph) % h.per;
  var half = h.per >> 1;
  var u = t < half ? t : h.per - t;            // 0 .. half .. 0
  var off = idiv(h.amp * (4 * u - h.per), h.per);
  return { x: h.x, y: h.y + off };
}

// Kite in the gap after hook k (absent on some gaps), a pure function of (seed, k).
function kiteSpec(seed, k, v) {
  var a = hash(seed, k, 10), b = hash(seed, k, 11);
  if (k === 0 || (a % 100) >= KITE_PCT) return null;
  var h0 = hookSpec(seed, k, v), h1 = hookSpec(seed, k + 1, v);
  var x = idiv(h0.x + h1.x, 2);
  var y = Math.min(h0.y, h1.y) + ((b % 130) - 40) * P;
  return { k: k, x: x, y: y };
}

// v3: a bunch of bananas in the gap after hook k, laid out in a pattern, a pure function of (seed, k).
var BANANA_CACHE = {};
var BANANA_CACHE_N = 0;
function bananasFor(seed, k, v) {
  if (k < 1 || v < 3) return [];
  var key = (seed >>> 0) + ':' + k;
  var hit = BANANA_CACHE[key];
  if (hit) return hit;
  var a = hash(seed, k, 30), b = hash(seed, k, 31);
  var h0 = hookSpec(seed, k, v), h1 = hookSpec(seed, k + 1, v);
  var x0 = idiv(h0.x, P), x1 = idiv(h1.x, P);
  var y0 = idiv(h0.y, P), y1 = idiv(h1.y, P);
  var gap = x1 - x0;
  // the line a good release flies, from low behind the ring up to the next ring; the
  // patterns hug it, so how well you time the release is how many you take
  var yA = Math.max(330, Math.min(440, y0 + 130));
  var yB = y1 + 55;
  var pat = b % 6;
  var n = 7;
  var pts = [], i, u, f, bump, yy;
  for (i = 0; i < n; i++) {
    u = idiv(i * 1000, n - 1);
    f = 2 * u - idiv(u * u, 1000);
    bump = idiv(4 * u * (1000 - u), 1000);
    yy = yA + idiv((yB - yA) * f, 1000);
    if (pat === 1) yy -= 70;
    else if (pat === 2) yy -= idiv(70 * bump, 1000);
    else if (pat === 3) yy += idiv(55 * bump, 1000);
    else if (pat === 5) yy += (i % 2) ? 26 : -26;
    pts.push([x0 + 60 + idiv(u * (gap - 110), 1000), yy]);
    if (pat === 4) pts.push([x0 + 60 + idiv(u * (gap - 110), 1000), yy + 36]);
  }
  void a;
  var out = [];
  for (i = 0; i < pts.length; i++) {
    out.push({ id: k * BANANA_ID + i, x: pts[i][0] * P, y: Math.max(150, Math.min(500, pts[i][1])) * P });
  }
  if (BANANA_CACHE_N > 300) { BANANA_CACHE = {}; BANANA_CACHE_N = 0; }
  BANANA_CACHE[key] = out; BANANA_CACHE_N++;
  return out;
}

// Awning in the gap after hook k: under every early gap, fewer later on.
function padSpec(seed, k, v) {
  var a = hash(seed, k, 20), b = hash(seed, k, 21);
  var chance = k < PAD_ALL_UNTIL ? 100 : 0;
  if ((a % 100) >= chance) return null;
  var h0 = hookSpec(seed, k, v), h1 = hookSpec(seed, k + 1, v);
  var w = Math.max(PAD_W_MIN, PAD_W0 - k);
  var cx = idiv(h0.x + h1.x, 2) + ((b % 41) - 20) * P;
  // early on the awnings join into one net: nothing to fall through while learning
  if (k < PAD_ALL_UNTIL) return { k: k, x0: (k === 0 ? -400 * P : h0.x - 20 * P), x1: h1.x + 20 * P, y: PAD_Y * P };
  return { k: k, x0: cx - idiv(w * P, 2), x1: cx + idiv(w * P, 2), y: PAD_Y * P };
}

function initSim(seed, version, tune) {
  var t = {};
  for (var key in TUNE_DEFAULTS) t[key] = TUNE_DEFAULTS[key];
  var v3 = (version || RULES_VERSION) >= 3;
  if (v3) for (var key3 in V3_TUNE) t[key3] = V3_TUNE[key3];
  if (tune) for (var k2 in tune) if (typeof tune[k2] === 'number') t[k2] = tune[k2];
  var sx0 = v3 ? START3_X : START_X, sy0 = v3 ? START3_Y : LEDGE_Y;
  return {
    v: version || RULES_VERSION,
    intro: false,
    seed: seed >>> 0,
    t: t,
    frames: 0,
    x: sx0 * P, y: sy0 * P,
    px: sx0 * P, py: sy0 * P,
    onLedge: true,
    hook: -1,                    // index of the hook held, -1 = flying
    ropeL: 0,
    hang: 0,
    pressing: false,
    used: false,                 // this press has already grabbed a hook
    kLo: 0,                      // lowest hook still worth testing
    maxX: START_X * P,
    kites: [],                   // indices of kites collected, replaced not pushed
    kiteCount: 0,
    air: 0,                      // steps in the air since the last grab
    flips: 0,
    bounces: 0,
    lastBounce: -1,              // frame of the last awning bounce
    lastHook: -1,                // the hook just let go of cannot be grabbed again
    score: 0,
    dead: false,
    deathStep: -1,
    snaps: 0,
    lastRelease: null            // { frame, vx, vy } of the last release
  };
}

// The finger went down (true) or up (false), applied before the next step.
function setPress(sim, down) {
  if (down && sim.v >= 3 && sim.onLedge) return;     // v3: a press started before the jump does not count
  if (down && !sim.pressing) sim.used = false;
  if (down) sim.intro = false;
  sim.pressing = !!down;
}

function nearestHook(sim) {
  if (sim.v >= 3) return nearestHook3(sim);
  var reach = sim.t.reach * P;
  var best = -1, bestD = 0, bestPos = null;
  for (var k = sim.kLo; k < sim.kLo + 6; k++) {
    var hp = hookPos(hookSpec(sim.seed, k, sim.v), sim.frames);
    if (hp.x <= sim.x - BEHIND * P || k === sim.lastHook) continue;
    var dx = hp.x - sim.x, dy = hp.y - sim.y;
    if (dx > reach) break;
    if (dx < 0) dx = -dx;
    var d = isqrt(dx * dx + dy * dy);
    if (d <= reach && (best < 0 || d < bestD)) { best = k; bestD = d; bestPos = hp; }
  }
  return best < 0 ? null : { k: best, d: bestD, x: bestPos.x, y: bestPos.y };
}

function nearestHook3(sim) {
  var reach = sim.t.reach * P;
  var best = -1, bestD = 0, bestC = 0, bestPos = null;
  for (var k = sim.kLo; k < sim.kLo + 6; k++) {
    if (k === sim.lastHook) continue;
    var hp = hookPos(hookSpec(sim.seed, k, sim.v), sim.frames);
    var dx = hp.x - sim.x, dy = hp.y - sim.y;
    if (dx > reach) break;
    if (dx < -BEHIND3 * P || dy > BELOW3 * P) continue;
    var cost = dx < 0 ? BEHIND3_COST * P : 0;
    if (dx < 0) dx = -dx;
    var d = isqrt(dx * dx + dy * dy);
    if (d <= reach && (best < 0 || d + cost < bestC)) { best = k; bestD = d; bestC = d + cost; bestPos = hp; }
  }
  return best < 0 ? null : { k: best, d: bestD, x: bestPos.x, y: bestPos.y };
}

function vxOf(sim) { return sim.x - sim.px; }
function vyOf(sim) { return sim.y - sim.py; }

function clampV(v, m) { return v > m ? m : v < -m ? -m : v; }

function stepSim(sim) {
  if (sim.dead) return sim;
  var t = sim.t;
  // the lowest hook still ahead of reach
  while (hookSpec(sim.seed, sim.kLo, sim.v).x < sim.x - t.reach * P) sim.kLo++;

  // let go
  if (!sim.pressing && sim.hook >= 0 && !sim.intro) {
    var rvx = idiv((sim.x - sim.px) * t.boostNum, BOOST_DEN);
    var rvy = idiv((sim.y - sim.py) * t.boostNum, BOOST_DEN);
    sim.px = sim.x - rvx; sim.py = sim.y - rvy;
    sim.lastRelease = { frame: sim.frames, k: sim.hook, vx: rvx, vy: rvy };
    sim.lastHook = sim.hook;
    sim.hook = -1; sim.hang = 0;
  }
  // grab
  if (sim.pressing && sim.hook < 0 && !sim.used && !(sim.v >= 3 && sim.onLedge)) {
    var nh = nearestHook(sim);
    if (sim.v < 3) sim.used = true;  // v2: one throw per press; v3 keeps looking while held
    if (nh) {
      sim.hook = nh.k; sim.ropeL = nh.d; sim.used = true; sim.hang = 0; sim.air = 0;
      if (sim.onLedge) sim.onLedge = false;
    }
  }

  // move
  var vm = t.vmax * P;
  if (sim.onLedge && sim.v >= 3) {
    // v3: he runs out of his home and jumps off the platform; input starts once he is in the air
    sim.px = sim.x; sim.py = sim.y;
    if (sim.frames >= RUN3_WAIT) sim.x += idiv(RUN3_SPEED * 10 * P, 10);
    if (sim.x >= JUMP3_X * P) {
      sim.onLedge = false;
      sim.px = sim.x - JUMP3_VX * 10 * P / 10; sim.py = sim.y - JUMP3_VY * 10 * P / 10;
    }
  } else if (sim.onLedge) {
    sim.px = sim.x; sim.py = sim.y;
    if (sim.frames >= LEDGE_WAIT) sim.x += t.run * P;
    if (sim.x > LEDGE_END * P) sim.onLedge = false;
  } else {
    var vx = clampV(sim.x - sim.px, vm), vy = clampV(sim.y - sim.py + t.g, vm);
    sim.px = sim.x; sim.py = sim.y;
    sim.x += vx; sim.y += vy;
  }

  // the rope
  if (sim.hook >= 0) {
    var hp = hookPos(hookSpec(sim.seed, sim.hook, sim.v), sim.frames + 1);
    var target = t.ropeMax * P;
    if (sim.ropeL > target) sim.ropeL = Math.max(target, sim.ropeL - REEL * P);
    var dx = sim.x - hp.x, dy = sim.y - hp.y;
    var d = isqrt(dx * dx + dy * dy);
    if (d > sim.ropeL && d > 0) {
      // hold to the circle and keep only the velocity along it
      var ux = vxOf(sim), uy = vyOf(sim);
      var nx = idiv(dx * sim.ropeL, d), ny = idiv(dy * sim.ropeL, d);
      var dot = idiv(ux * nx + uy * ny, sim.ropeL);
      if (dot > 0) { ux -= idiv(dot * nx, sim.ropeL); uy -= idiv(dot * ny, sim.ropeL); }
      sim.x = hp.x + nx; sim.y = hp.y + ny;
      sim.px = sim.x - ux; sim.py = sim.y - uy;
    }
    // pumping: the swing gains speed while held, up to swingMax
    var wx = sim.x - sim.px, wy = sim.y - sim.py;
    var sp = isqrt(wx * wx + wy * wy), cap = t.swingMax * P;
    if (sp > 0 && sp < cap) {
      var nsp = Math.min(cap, idiv(sp * (1024 + t.pump), 1024));
      sim.px = sim.x - idiv(wx * nsp, sp);
      sim.py = sim.y - idiv(wy * nsp, sp);
    }
    sim.hang++;
    if (sim.hang >= HANG_MAX) { sim.lastHook = sim.hook; sim.hook = -1; sim.hang = 0; sim.snaps++; }
  }

  // awnings: falling onto one throws you back up
  if (sim.v < 3 && sim.hook < 0 && !sim.onLedge && sim.y > sim.py) {
    for (var pk = Math.max(0, sim.kLo - 4); pk < sim.kLo + 3; pk++) {
      var pad = padSpec(sim.seed, pk, sim.v);
      if (!pad || sim.x < pad.x0 || sim.x > pad.x1) continue;
      if (sim.py <= pad.y && sim.y > pad.y) {
        var bvy = sim.y - sim.py, bvx = sim.x - sim.px;
        var up = Math.max(PAD_KICK * P, idiv(bvy * 9, 10));
        var fwd = Math.max(PAD_FWD * P, bvx);
        sim.y = pad.y; sim.py = pad.y + up; sim.px = sim.x - fwd;
        sim.bounces++; sim.lastBounce = sim.frames; sim.lastHook = -1;
        break;
      }
    }
  }

  // air time: a flip every AIR_FLIP steps off the rope
  if (sim.hook < 0 && !sim.onLedge) {
    sim.air++;
    if (sim.air % AIR_FLIP === 0) sim.flips++;
  }

  // kites (v2) and banana bunches (v3)
  var kr = KITE_R * P;
  if (sim.v >= 3) {
    var got = null;
    for (var bk = Math.max(1, sim.kLo - 1); bk < sim.kLo + 4; bk++) {
      var bs = bananasFor(sim.seed, bk, sim.v);
      for (var bj = 0; bj < bs.length; bj++) {
        var bn = bs[bj];
        if (sim.kites.indexOf(bn.id) >= 0 || (got && got.indexOf(bn.id) >= 0)) continue;
        var bx = sim.x - bn.x, by = sim.y - bn.y;
        if (bx * bx + by * by <= kr * kr) got = (got || []).concat([bn.id]);
      }
    }
    if (got) {
      var keep = sim.kites.filter(function (id) { return id >= (sim.kLo - 3) * BANANA_ID; });
      sim.kites = keep.concat(got);
      sim.kiteCount += got.length;
    }
  } else
  for (var sk = Math.max(1, sim.kLo - 1); sk < sim.kLo + 4; sk++) {
    var st = kiteSpec(sim.seed, sk, sim.v);
    if (!st || sim.kites.indexOf(sk) >= 0) continue;
    var sx = sim.x - st.x, sy = sim.y - st.y;
    if (sx * sx + sy * sy <= kr * kr) {
      sim.kites = sim.kites.concat([sk]);
      sim.kiteCount++;
    }
  }

  if (sim.x > sim.maxX) sim.maxX = sim.x;
  sim.score = Math.floor((sim.maxX - START_X * P) / (METRE * P)) + (sim.v >= 3 ? BANANA_PTS : KITE_POINTS) * sim.kiteCount + FLIP_POINTS * sim.flips;
  sim.frames++;
  if (sim.y > WATER_Y * P) { sim.dead = true; sim.deathStep = sim.frames; sim.hook = -1; }
  return sim;
}
// ==== JHOOLA RULES END ====

var MAX_SIM_STEPS = 216000;    // the session hour
var MAX_HOLDS = 30000;         // a work bound
const MAX_INPUTS = MAX_HOLDS + 200;

function seedToInt(seedHex) {
  return (typeof seedHex === 'string' && /^[0-9a-fA-F]{8}/.test(seedHex)) ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
}
function isInt(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, holds: 0,
    maxDurationSecs: Number(maxDurationSecs) || 3600, elapsedSecs: Number(elapsedSecs) || 0,
    // humanness raw material (recorded, never gated)
    holdLens: [], pressSteps: [], grabs: 0, misses: 0,
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepSim(sim);
}

function processEvent(state, event) {
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};
  if (p.kind === 'start') {
    if ((p.v === 2 || p.v === RULES_VERSION) && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(seedToInt(state.seed), p.v, null);
    }
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim' || p.kind !== 'hold') return { accepted: true, newScore: state.score };
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  const { n, pressStep, releaseStep } = p;
  if (!isInt(n) || !isInt(pressStep) || !isInt(releaseStep) || pressStep > MAX_SIM_STEPS || releaseStep > MAX_SIM_STEPS || releaseStep < pressStep) return reject(state, 'bad_hold');
  const sim = state.sim;
  if (sim.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (n !== state.holds) return reject(state, 'out_of_order');
  if (pressStep < sim.frames) return reject(state, 'frame_regressed');
  if (state.holds >= MAX_HOLDS) return reject(state, 'hold_cap');
  advanceTo(state, pressStep);
  if (sim.dead) { state.score = sim.score; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  setPress(sim, true);
  advanceTo(state, releaseStep);
  setPress(sim, false);
  state.holds++;
  state.holdLens.push(releaseStep - pressStep);
  state.pressSteps.push(pressStep);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function r3(v) { return v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function sd(a) { const m = mean(a); return a.length ? Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length) : null; }
function gapCv(steps) {
  const g = [];
  for (let i = 1; i < steps.length; i++) g.push(steps[i] - steps[i - 1]);
  const m = mean(g);
  return m ? sd(g) / m : null;
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out past the last hold. A runner that lets go falls into the
  // river within seconds, so this is short for any real run.
  const runOut = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const cap = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOut && sim.frames < cap && sim.frames < MAX_SIM_STEPS) { stepSim(sim); guard++; }
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.frames, score: sim.score, dead: sim.dead, maxX: Math.floor(sim.maxX / P),
      kites: sim.kiteCount, bounces: sim.bounces, snaps: sim.snaps,
      holds: state.holds, inputs: state.inputCount, rejects: state.rejectCount,
      holdMean: r3(mean(state.holdLens)), holdSd: r3(sd(state.holdLens)),
      gapCv: r3(gapCv(state.pressSteps)),
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
  _sim: { RULES_VERSION, P, MAX_SIM_STEPS, MAX_HOLDS, MAX_INPUTS, hash, seedToInt, initSim, stepSim, setPress, hookSpec, hookPos, kiteSpec, padSpec, bananasFor },
};
