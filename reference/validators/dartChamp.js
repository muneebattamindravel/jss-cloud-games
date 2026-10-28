// Dart Champ: server-side deterministic REPLAY (Oct 2026).
//
// Swipe-to-throw darts against a 3 minute clock. Every dart has a CALLED target
// (a pure function of the seed, the dart index and the combo); hitting it pays
// the board value plus a bonus times the combo multiplier, anything else pays
// the real board value and breaks the combo. A dart lands where the swipe sends
// it (slant sets left and right, speed sets the gravity drop) plus a small
// seeded hand wobble. The rules block below is carried WORD FOR WORD in
// games/dart-champ/js/rules.js and pinned in shared/tests/dartChampParity.test.js.
//
// Trace v2: { kind: 'start', v: 2 } then one { kind: 'throw', n, step, dx, dy, ms }
// per dart the client threw: n is its index, step the fixed 1/60 s step it was
// thrown on, (dx, dy, ms) the swipe in design px and milliseconds. The server
// runs the world up to that step, throws through the same rules and computes the
// score itself. A throw the rules refuse changes nothing; refusals never zero a
// run. Integer rules (one sine TABLE, no Math.sin), so no dmath is needed.

'use strict';

// ==== DART CHAMP RULES BEGIN ====
// Rules space: positions are integers in 1/16 of a design pixel, measured from
// the bull (x right, y DOWN). Time is the fixed 1/60 s step. A run is a 180 s
// clock: throw as many darts as you can. Every dart has a CALLED target; hit it
// and it pays its board value plus a bonus times the combo multiplier, miss it and the dart pays
// its real board value (a double 12 is 24) with no multiplier, and the combo resets. Where a dart lands is the
// swipe (slant aims left and right, speed sets how far gravity drops it) plus a small seeded hand wobble.
var RULES_VERSION = 2;
var U = 16;                    // rule units per design pixel
var START_GUARD = 45;          // the first dart is ready on this step
var RUN_STEPS = 10800;         // the clock: 180 s from the first ready dart
var READY_GAP = 48;            // steps from a throw to the next dart (0.8 s, and no throw while one is in the air)
// The board, design px (a pub board, rings widened for a phone).
var R_BULL = 9;
var R_OUTER_BULL = 22;
var R_TREB_IN = 94;
var R_TREB_OUT = 110;
var R_DBL_IN = 152;
var R_DBL_OUT = 170;
var SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
// Sector k (clockwise from the top) lies between boundary k and k + 1, each a
// direction at -9 + 18k degrees from straight up: cos and sin times 10000.
var BND_C = [9877, 9877, 8910, 7071, 4540, 1564, -1564, -4540, -7071, -8910, -9877, -9877, -8910, -7071, -4540, -1564, 1564, 4540, 7071, 8910, 9877];
var BND_S = [-1564, 1564, 4540, 7071, 8910, 9877, 9877, 8910, 7071, 4540, 1564, -1564, -4540, -7071, -8910, -9877, -9877, -8910, -7071, -4540, -1564];
// The throw: the swipe, design px (dx right, dy down, so up is negative) and ms.
var SWIPE_MIN = 40;            // a swipe shorter than this upward is not a throw
var DX_MAX = 600;
var DY_MAX = 900;
var MS_MAX = 3000;
var X_NUM = 8, X_DEN = 7;      // sideways aim: dx is the finger's px right of the board centre when it lets go
// (the board is drawn at 7/8 of rule px, so a finger straight under a spot sends it there)
// Height is physics: the dart leaves aimed AIM_UP px above the bull and gravity
// pulls it down on the way. Flight time falls with the swipe's speed, so the
// drop is DROP_K / speed^2: a soft throw lands low, a hard one high.
var MS_FLOOR = 40;             // the fastest a swipe is ever timed at
var V_MAX = 6000;              // px a second
var AIM_UP = 220;
var DROP_K = 635800000;        // px^3/s^2: a 1,700 px/s throw lands on the bull
var DROP_CAP = 700;            // px: a feeble throw falls off the board
// Called targets. Kind: 0 any part of a number, 1 its double, 2 its treble, 3 the bull.
var K_SEG = 0, K_DBL = 1, K_TRE = 2, K_BULL = 3;
var K_VALUE = [50, 100, 120, 150];  // a called hit pays its board value PLUS this times the multiplier
var MULT_MAX = 5;
// The harder targets come with the combo: odds out of 100 for SEG, DBL, TRE, BULL.
var TIER_ODDS = [[100, 0, 0, 0], [50, 25, 25, 0], [20, 35, 35, 10], [0, 40, 40, 20]];
var TIER_AT = [0, 2, 4, 7];    // the combo each tier starts at
// The hand wobble every throw carries, tenths of a px, grows with the tier.
var WOB0 = 30;
var WOB_TIER = 18;
var SEED_MIX = 0x85EBCA6B;
var HASH_K = 0x9E3779B1;
var HASH_J = 0x85EBCA77;
var MIX_A = 0x7FEB352D;
var MIX_B = 0x846CA68B;
// One quarter of a sine, 1024 table units a turn, values out of 16384.
var SIN_Q = [0,101,201,302,402,503,603,704,804,904,1005,1105,1205,1306,1406,1506,1606,1706,1806,1906,2006,2105,2205,2305,2404,2503,2603,2702,2801,2900,2999,3098,3196,3295,3393,3492,3590,3688,3786,3883,3981,4078,4176,4273,4370,4467,4563,4660,4756,4852,4948,5044,5139,5235,5330,5425,5520,5614,5708,5803,5897,5990,6084,6177,6270,6363,6455,6547,6639,6731,6823,6914,7005,7096,7186,7276,7366,7456,7545,7635,7723,7812,7900,7988,8076,8163,8250,8337,8423,8509,8595,8680,8765,8850,8935,9019,9102,9186,9269,9352,9434,9516,9598,9679,9760,9841,9921,10001,10080,10159,10238,10316,10394,10471,10549,10625,10702,10778,10853,10928,11003,11077,11151,11224,11297,11370,11442,11514,11585,11656,11727,11797,11866,11935,12004,12072,12140,12207,12274,12340,12406,12472,12537,12601,12665,12729,12792,12854,12916,12978,13039,13100,13160,13219,13279,13337,13395,13453,13510,13567,13623,13678,13733,13788,13842,13896,13949,14001,14053,14104,14155,14206,14256,14305,14354,14402,14449,14497,14543,14589,14635,14680,14724,14768,14811,14854,14896,14937,14978,15019,15059,15098,15137,15175,15213,15250,15286,15322,15357,15392,15426,15460,15493,15525,15557,15588,15619,15649,15679,15707,15736,15763,15791,15817,15843,15868,15893,15917,15941,15964,15986,16008,16029,16049,16069,16088,16107,16125,16143,16160,16176,16192,16207,16221,16235,16248,16261,16273,16284,16295,16305,16315,16324,16332,16340,16347,16353,16359,16364,16369,16373,16376,16379,16381,16383,16384,16384];

function sinA(a) {
  a = a & 1023;
  var q = a >> 8, i = a & 255;
  if (q === 0) return SIN_Q[i];
  if (q === 1) return SIN_Q[256 - i];
  if (q === 2) return -SIN_Q[i] | 0;
  return -SIN_Q[256 - i] | 0;
}
function cosA(a) { return sinA(a + 256); }

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}
// Draw j of index k: a pure function of (seed, k, j).
function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, HASH_K) ^ Math.imul(j + 1, HASH_J)) | 0;
  h = Math.imul(h ^ (h >>> 16), MIX_A);
  h = Math.imul(h ^ (h >>> 15), MIX_B);
  return (h ^ (h >>> 16)) >>> 0;
}

// Where a dart at (x, y) scores. ring: 0 miss, 1 single, 2 double, 3 treble,
// 4 outer bull, 5 bull.
function scoreAt(x, y) {
  var r2 = x * x + y * y;
  var u2 = function (px) { return px * U * px * U; };
  if (r2 <= u2(R_BULL)) return { pts: 50, ring: 5, num: 25 };
  if (r2 <= u2(R_OUTER_BULL)) return { pts: 25, ring: 4, num: 25 };
  if (r2 > u2(R_DBL_OUT)) return { pts: 0, ring: 0, num: 0 };
  var sec = 0;
  for (var k = 0; k < 20; k++) {
    if (x * BND_C[k] + y * BND_S[k] >= 0 && x * BND_C[k + 1] + y * BND_S[k + 1] < 0) { sec = k; break; }
  }
  var n = SECTORS[sec];
  if (r2 > u2(R_DBL_IN)) return { pts: n * 2, ring: 2, num: n };
  if (r2 > u2(R_TREB_IN) && r2 <= u2(R_TREB_OUT)) return { pts: n * 3, ring: 3, num: n };
  return { pts: n, ring: 1, num: n };
}
// The middle of sector n at radius rad px, in rule units.
function sectorPoint(n, rad) {
  var k = SECTORS.indexOf(n), a = Math.floor(k * 1024 / 20);
  return { x: Math.floor(rad * U * sinA(a) / 16384), y: -Math.floor(rad * U * cosA(a) / 16384) };
}

// Dart d's called target and wobble: pure functions of (seed, d, combo).
function tierOf(combo) { var t = 0; for (var i = 1; i < TIER_AT.length; i++) if (combo >= TIER_AT[i]) t = i; return t; }
function targetFor(seed, d, combo, lastNum) {
  var h0 = hash(seed, d, 0), h1 = hash(seed, d, 1), odds = TIER_ODDS[tierOf(combo)];
  var roll = h0 % 100, kind = 0, acc = 0;
  for (var k = 0; k < 4; k++) { acc += odds[k]; if (roll < acc) { kind = k; break; } }
  var idx = h1 % 20;
  if (SECTORS[idx] === lastNum) idx = (idx + 1 + (h1 >>> 8) % 19) % 20;
  return { kind: kind, num: kind === K_BULL ? 25 : SECTORS[idx] };
}
function wobbleFor(seed, d, combo) {
  var h2 = hash(seed, d, 2), h3 = hash(seed, d, 3);
  var wob = Math.floor((WOB0 + WOB_TIER * tierOf(combo)) * U * (h3 % 1001) / 10000);
  return { x: Math.floor(wob * sinA(h2 & 1023) / 16384), y: Math.floor(wob * cosA(h2 & 1023) / 16384) };
}
function hitsTarget(t, hit) {
  if (t.kind === K_BULL) return hit.ring >= 4;
  if (hit.num !== t.num || hit.ring < 1 || hit.ring > 3) return false;
  if (t.kind === K_DBL) return hit.ring === 2;
  if (t.kind === K_TRE) return hit.ring === 3;
  return true;
}
function multOf(combo) { return Math.min(MULT_MAX, 1 + combo); }
// Where a swipe sends the dart before wobble and wind, rule units from the bull.
function speedOf(dy, ms) { return Math.min(V_MAX, Math.floor(-dy * 1000 / Math.max(MS_FLOOR, ms))); }
function dropOf(v) { return Math.min(DROP_CAP * U, Math.floor(DROP_K * U / (v * v))); }
function aimOf(dx, dy, ms) {
  var len = -dy, v = speedOf(dy, ms);
  var x = Math.floor(dx * X_NUM * U / X_DEN);
  var y = -AIM_UP * U + dropOf(v);
  return { x: x, y: y, v: v };
}
function validSwipe(dx, dy, ms) {
  return Number.isInteger(dx) && Number.isInteger(dy) && Number.isInteger(ms) &&
    dx >= -DX_MAX && dx <= DX_MAX && dy <= -SWIPE_MIN && dy >= -DY_MAX && ms >= 0 && ms <= MS_MAX;
}

function initSim(seedHex, version) {
  var seed = seedToInt(seedHex);
  var sim = {
    version: version, seed: seed, step: 0, d: 0, ready: START_GUARD, end: START_GUARD + RUN_STEPS,
    combo: 0, best: 0, hits: 0, score: 0, lastNum: 0, target: null, throws: [], done: false, events: []
  };
  sim.target = targetFor(seed, 0, 0, 0);
  return sim;
}
function active(sim) { return !sim.done && sim.step >= sim.ready && sim.step < sim.end; }

// Throw the current dart now.
function throwSim(sim, dx, dy, ms) {
  if (!active(sim) || !validSwipe(dx, dy, ms)) return null;
  var a = aimOf(dx, dy, ms), w = wobbleFor(sim.seed, sim.d, sim.combo);
  var x = a.x + w.x, y = a.y + w.y, hit = scoreAt(x, y), tg = sim.target, called = hitsTarget(tg, hit), pts, mult = 1;
  if (called) { mult = multOf(sim.combo); pts = hit.pts + K_VALUE[tg.kind] * mult; sim.combo++; sim.hits++; if (sim.combo > sim.best) sim.best = sim.combo; }
  else { pts = hit.pts; sim.combo = 0; }
  var t = { d: sim.d, step: sim.step, x: x, y: y, pts: pts, ring: hit.ring, num: hit.num, called: called, mult: mult, kind: tg.kind, tnum: tg.num };
  sim.throws = sim.throws.concat([t]);
  sim.score += pts;
  sim.events = sim.events.concat([{ t: "throw", th: t }]);
  sim.d++;
  sim.lastNum = tg.num;
  sim.ready = sim.step + READY_GAP;
  sim.target = targetFor(sim.seed, sim.d, sim.combo, sim.lastNum);
  return t;
}

// One fixed step. The clock ends the run; a dart already thrown has counted.
function stepSim(sim) {
  sim.events = [];
  if (!sim.done && sim.step >= sim.end) { sim.done = true; sim.events = [{ t: "end" }]; }
  sim.step++;
}
// ==== DART CHAMP RULES END ====

const MAX_SIM_STEPS = 216000;     // the session hour
const MAX_THROWS = 2000;          // a work bound: a 3 minute round holds ~225 darts
const MAX_INPUTS = MAX_THROWS + 200;
const FPS = 60;

function isInt(v) { return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v; }

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0,
    maxDurationSecs: Number(maxDurationSecs) || 3600, elapsedSecs: Number(elapsedSecs) || 0,
    // humanness raw material (recorded, never gated)
    steps: [], waits: [], errs: [], speeds: [], mss: [], dxs: [], calledFlags: [],
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function advanceTo(state, step) {
  const sim = state.sim;
  while (sim.step < step && sim.step < MAX_SIM_STEPS) stepSim(sim);
}

function targetXY(t) {
  if (t.kind === K_BULL) return { x: 0, y: 0 };
  const rad = t.kind === K_DBL ? 161 : t.kind === K_TRE ? 102 : 131;
  const p = sectorPoint(t.num, rad);
  return { x: p.x / U, y: p.y / U };
}

function processEvent(state, event) {
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};
  if (p.kind === 'start') {
    if (p.v === RULES_VERSION && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, RULES_VERSION);
    }
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim' || p.kind !== 'throw') return { accepted: true, newScore: state.score };
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  const { n, step, dx, dy, ms } = p;
  if (!isInt(n) || n < 0 || !isInt(step) || step < 0 || step > MAX_SIM_STEPS || !isInt(dx) || !isInt(dy) || !isInt(ms)) return reject(state, 'bad_throw');
  const sim = state.sim;
  if (n !== sim.d) return reject(state, 'out_of_order');
  if (step < sim.step) return reject(state, 'frame_regressed');
  if (sim.d >= MAX_THROWS) return reject(state, 'throw_cap');
  advanceTo(state, step);
  if (!active(sim)) return reject(state, 'not_ready');
  if (!validSwipe(dx, dy, ms)) return reject(state, 'bad_swipe');
  const tg = sim.target, readyAt = sim.ready;
  const t = throwSim(sim, dx, dy, ms);
  if (!t) return reject(state, 'refused');
  sim.events = [];
  const aim = targetXY(tg);
  state.steps.push(step);
  state.waits.push(step - readyAt);
  state.errs.push(Math.hypot(t.x / U - aim.x, t.y / U - aim.y));
  state.speeds.push(speedOf(dy, ms));
  state.mss.push(ms);
  state.dxs.push(dx);
  state.calledFlags.push(t.called ? 1 : 0);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

function elapsedCap(state) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * FPS);
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
  // Run the clock out. Darts already thrown have counted; this only closes the run.
  const runOut = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * FPS));
  const cap = elapsedCap(state);
  let guard = 0;
  while (!sim.done && guard < runOut && sim.step < cap && sim.step < MAX_SIM_STEPS) { stepSim(sim); guard++; }
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, score: sim.score, done: sim.done, throws: sim.d, hits: sim.hits, best: sim.best,
      inputs: state.inputCount, rejects: state.rejectCount,
      errMean: r3(mean(state.errs)), errSd: r3(sd(state.errs)),
      waitMean: r3(mean(state.waits)), waitSd: r3(sd(state.waits)),
      speedMean: r3(mean(state.speeds)), speedSd: r3(sd(state.speeds)),
      msMean: r3(mean(state.mss)), msSd: r3(sd(state.mss)),
      dxSd: r3(sd(state.dxs)), hitShare: r3(mean(state.calledFlags)),
      gapCv: r3(gapCv(state.steps)),
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
  _limits: { MAX_SIM_STEPS, FPS },
  init, processEvent, finalize, simulate,
  _sim: {
    RULES_VERSION, U, START_GUARD, RUN_STEPS, READY_GAP, K_VALUE, MULT_MAX, MAX_SIM_STEPS, MAX_THROWS, MAX_INPUTS,
    seedToInt, hash, scoreAt, sectorPoint, tierOf, targetFor, wobbleFor, hitsTarget, multOf, speedOf, dropOf, aimOf,
    validSwipe, initSim, active, throwSim, stepSim, targetXY,
  },
};
