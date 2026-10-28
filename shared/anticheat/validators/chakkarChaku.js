'use strict';

/**
 * Chakkar Chaku validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a log spins in the upper half of the screen. A tap throws a knife
 * straight up; it lands FLY steps later at the bottom of the log and sticks.
 * Landing within TOL of a knife already stuck ends the run. Each log needs a
 * set number of knives; the last one clears it and the next log arrives.
 * Apples on the rim are taken by a knife landing near them. No throw for
 * IDLE_END steps ends the run.
 *
 * What the server does with a trace:
 *   1. rebuilds every log from the session seed: log K takes DRAWS draws from
 *      hash(seed, K, j), never from a running stream;
 *   2. applies each throw { n, step } before step `step + 1` runs, exactly as
 *      the client does (a throw the rules refuse is refused here too);
 *   3. runs the same fixed steps and adds up the score.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/chakkar-chaku/js/game.js.
 * shared/tests/chakkarChakuParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump, never an edit
 * in place.
 */

// ==== CHAKKAR CHAKU RULES BEGIN ====
// Angles are integers out of TURN (3600 a turn). The log's rotation is kept in
// SUB parts of an angle unit so slow speeds stay whole numbers. Screen angle 0
// is straight down, where every thrown knife lands. A knife that lands while
// the log reads rotation r sticks at log angle (TURN - r) mod TURN.
var RULES_VERSION = 3;
var TURN = 3600;
var SUB = 16;
var TURN_SUB = TURN * SUB;
var FLY = 8;                // steps a knife is in the air
var TOL = 85;               // closer than this to a stuck knife ends the run
var APPLE_TOL = 120;        // within this of an apple takes it
var TRANS = 42;             // steps a new log takes to arrive (no throws)
var IDLE_WARN = 360;        // the wood starts to crack after 6 s without a throw
var IDLE_END = 600;         // and the run ends at 10 s
var MAX_STUCK = 12;         // pre-stuck plus required knives never exceed this
var BOSS_EVERY = 5;         // every 5th log is a boss
var V_BASE = 190;           // spin speed, sub-units a step, on log 1
var V_STEP = 24;            // plus this per log
var V_CAP_K = 18;           // up to log 19
var ACC = 10;               // speed change per step toward a keyframe
var ACC_REV = 26;           // sharper for reversing logs
var ACC_BOSS = 20;
var V3_BASE = 180;          // v3 spin speed, sub-units a step, on log 1
var V3_STEP = 22;           // plus this per log
var V3_CAP_K = 22;          // up to log 23
var V3_LATE_STEP = 5;       // then +5 a log, slower, up to log 41
var V3_LATE_CAP_K = 40;
var ACC_PULSE = 8;          // v3: speed breathes smoothly
var ACC_REV3 = 18;          // v3: a reversal is a visible slowing, not a snap
var NET_MIN = 43200;         // three quarters of a turn, in sub-units
var DRAWS = 32;             // draws per log, every log, whatever is used
var KNIFE_PTS = 1;
var APPLE_PTS = 2;
var CLEAR_PTS = 5;          // times the log number
var MAX_THROWS = 20000;
var SEED_MIX = 0x85EBCA6B;
var HASH_K = 0x9E3779B1;
var HASH_J = 0x85EBCA77;
var MIX_A = 0x7FEB352D;
var MIX_B = 0x846CA68B;

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

// Draw j of log k: a pure function of (seed, k, j).
function hash(seed, k, j) {
  var h = (seed ^ Math.imul(k + 1, HASH_K) ^ Math.imul(j + 1, HASH_J)) | 0;
  h = Math.imul(h ^ (h >>> 16), MIX_A);
  h = Math.imul(h ^ (h >>> 15), MIX_B);
  return (h ^ (h >>> 16)) >>> 0;
}

function circ(a, b) {
  var d = (a - b) % TURN;
  if (d < 0) d += TURN;
  return d < TURN - d ? d : TURN - d;
}
function wrapSub(r) { r %= TURN_SUB; return r < 0 ? r + TURN_SUB : r; }
function isBoss(k) { return (k + 1) % BOSS_EVERY === 0; }
function speedOf(k) {
  var v = V_BASE + V_STEP * Math.min(k, V_CAP_K);
  return isBoss(k) ? Math.floor(v * 9 / 8) : v;
}

// v3: the spin patterns arrive gradually and repeat exactly. Logs 1 to 3 are
// steady. From log 4 the speed breathes (same direction). From log 7 a log
// may reverse, from log 11 it may stop and swing back. Every pattern is one
// fixed cycle of at most four keyframes, so a player can learn it in a turn
// or two; later logs shorten the holds and lengthen the stops.
function speedOf3(k) {
  var v = V3_BASE + V3_STEP * Math.min(k, V3_CAP_K) + V3_LATE_STEP * Math.max(0, Math.min(k, V3_LATE_CAP_K) - V3_CAP_K);
  return isBoss(k) ? Math.floor(v * 9 / 8) : v;
}
function spinPlan3(r, k, boss, dir, v) {
  var roll = r[1] % 100, kind, kf = [], acc = ACC, s = k < 6 ? 100 : Math.max(35, 100 - 2 * (k - 6));
  if (boss) kind = k < 9 ? 4 : k < 14 ? 1 : 2;
  else if (k < 3) kind = 0;
  else if (k < 6) kind = roll < 40 ? 0 : 4;
  else if (k < 10) kind = roll < 25 ? 0 : roll < 55 ? 4 : 1;
  else if (k < 15) kind = roll < 15 ? 0 : roll < 40 ? 4 : roll < 75 ? 1 : 2;
  else if (k < 30) kind = roll < 10 ? 0 : roll < 30 ? 4 : roll < 65 ? 1 : 2;
  else kind = roll < 15 ? 4 : roll < 50 ? 1 : 2;
  if (kind === 0) kf = [[dir * v, 600]];
  else if (kind === 4) {
    acc = ACC_PULSE;
    kf = [[dir * Math.floor(v * (135 + r[2] % 15) / 100), 70 + r[8] % 30], [dir * Math.floor(v * (55 + r[3] % 15) / 100), 70 + r[9] % 30]];
  } else if (kind === 1) {
    acc = boss ? ACC_BOSS : ACC_REV3;
    kf = [[dir * Math.floor(v * (95 + r[2] % 10) / 100), Math.floor((130 + r[8] % 50) * s / 100)],
          [-dir * Math.floor(v * (60 + r[3] % 10) / 100), Math.floor((40 + r[9] % 25) * s / 100)]];
    if (k >= 12) {
      kf.push([dir * Math.floor(v * (80 + r[4] % 10) / 100), Math.floor((70 + r[10] % 30) * s / 100)]);
      kf.push([-dir * Math.floor(v * (60 + r[5] % 10) / 100), Math.floor((50 + r[11] % 25) * s / 100)]);
    }
  } else {
    acc = boss ? ACC_BOSS : ACC;
    kf = [[dir * Math.floor(v * (130 + r[2] % 15) / 100), Math.floor((70 + r[8] % 30) * s / 100)],
          [0, 16 + r[9] % 12 + Math.min(34, k - 10)],
          [-dir * Math.floor(v * (25 + r[3] % 10) / 100), 35 + r[10] % 20]];
  }
  return { kind: kind, kf: kf, acc: acc };
}

function cycleNet(kf, acc) {
  var spd = kind0(kf) ? kf[0][0] : 0, net = 0;
  for (var pass = 0; pass < 2; pass++) {
    for (var i = 0; i < kf.length; i++) {
      for (var t = 0; t < kf[i][1]; t++) {
        if (spd < kf[i][0]) spd = Math.min(kf[i][0], spd + acc);
        else if (spd > kf[i][0]) spd = Math.max(kf[i][0], spd - acc);
        if (pass === 1) net += spd;
      }
    }
  }
  return net;
}
function kind0(kf) { return kf.length === 1; }

// Log k: its spin keyframes ([target speed, steps]), required knives,
// pre-stuck knives and apples. DRAWS draws on every index.
function logSpec(seed, k, version) {
  var r = [], j, i;
  for (j = 0; j < DRAWS; j++) r.push(hash(seed, k, j));
  var boss = isBoss(k), kind, kf, acc = ACC, dir = (r[0] & 1) ? 1 : -1;
  if (version >= 3) {
    var plan = spinPlan3(r, k, boss, dir, speedOf3(k));
    kind = plan.kind; kf = plan.kf; acc = plan.acc;
  } else {
  var v = speedOf(k), roll = r[1] % 100;
  // 0 steady (logs 1 and 2 only), 1 reversing, 2 surging (speed up, stop,
  // swing back), 3 boss. Patterns get longer and less regular with the log.
  kind = boss ? 3 : k < 2 ? 0 : k < 4 ? (roll < 60 ? 1 : 2) : (roll < 15 ? 0 : roll < 55 ? 1 : 2);
  var n = Math.min(6, 2 + Math.floor(k / 4));
  if (kind === 0) kf = [[dir * v, 600]];
  else if (kind === 1) {
    acc = ACC_REV; kf = [];
    for (i = 0; i < n; i++) {
      var back = i % 2 === 1;
      kf.push([(back ? -dir : dir) * Math.floor(v * (back ? 6 + r[2 + i] % 4 : 9 + r[2 + i] % 5) / 10), (back ? 35 : 60) + r[8 + i] % 60]);
    }
  } else if (kind === 2) {
    kf = [];
    for (i = 0; i < n; i++) {
      var ph = i % 3;
      kf.push([ph === 0 ? dir * Math.floor(v * (14 + r[2 + i] % 6) / 10) : ph === 1 ? 0 : -dir * Math.floor(v * (3 + r[2 + i] % 4) / 10),
               (ph === 1 ? 14 : 30) + r[8 + i] % (ph === 1 ? 26 : 50)]);
    }
  } else {
    acc = ACC_BOSS;
    var fast = Math.floor(v * 3 / 2);
    kf = [[dir * fast, 40 + r[2] % 40]];
    for (i = 0; i < 5; i++) kf.push([dir * Math.floor(v * ((r[4 + i] % 21) - 6) / 10), 20 + r[10 + i] % 45]);
  }
  }
  // Every cycle must carry the log at least NET_MIN forward, so every angle
  // comes round to the knife within a few seconds whatever the pattern.
  // Measured exactly: two passes of the cycle from rest, the second counted.
  for (var grow = 0; grow < 60 && cycleNet(kf, acc) * dir < NET_MIN; grow++) kf[0] = [kf[0][0], kf[0][1] + 20];
  var preMax = Math.min(5, 1 + Math.floor(k / 3));
  if (version >= 3 && k >= 20) preMax = k < 30 ? 6 : 7;   // crowded logs: pre-stuck + needed never exceed MAX_STUCK
  var pre = k === 0 ? 0 : k === 1 ? 1 : boss ? 1 + r[20] % 2 : 1 + r[20] % preMax;
  var need = boss ? 9 + Math.min(2, Math.floor(k / 10)) : 6 + Math.min(4, Math.floor(k / 3)) + (r[26] % 2);
  need = Math.min(need, MAX_STUCK - pre);
  var stuck = [], base = r[21] % TURN;
  for (i = 0; i < pre; i++) stuck.push((base + i * Math.floor(TURN / pre) + (r[22 + i] % 300) - 150 + TURN) % TURN);
  var nApples = boss ? r[27] % 2 : k === 0 ? r[27] % 2 : r[27] % 3, apples = [];
  for (i = 0; i < nApples; i++) {
    var a = r[28 + i] % TURN;
    for (var tries = 0; tries < 8; tries++) {
      var clear = true;
      for (j = 0; j < stuck.length; j++) if (circ(a, stuck[j]) < TOL + 60) clear = false;
      for (j = 0; j < apples.length; j++) if (circ(a, apples[j]) < APPLE_TOL * 2) clear = false;
      if (clear) break;
      a = (a + 450) % TURN;
    }
    apples.push(a);
  }
  return { k: k, boss: boss, kind: kind, kf: kf, acc: acc, need: need, stuck: stuck, apples: apples, rot0: (r[30] % TURN) * SUB };
}

function nextLog(sim) {
  var k = sim.log + 1, spec = logSpec(sim.seed, k, sim.version);
  sim.log = k; sim.spec = spec;
  sim.rot = spec.rot0; sim.spd = kind0(spec.kf) ? spec.kf[0][0] : 0;
  sim.kfi = 0; sim.kfLeft = spec.kf[0][1];
  sim.stuck = spec.stuck.slice(); sim.apples = spec.apples.slice(); sim.left = spec.need;
  sim.trans = TRANS;
}

function initSim(seedHex, version) {
  var sim = {
    version: version, seed: seedToInt(seedHex), step: 0, throws: 0, score: 0,
    dead: false, deathStep: -1, cause: '', log: -1, spec: null,
    rot: 0, spd: 0, kfi: 0, kfLeft: 0, stuck: [], apples: [], left: 0,
    fly: -1, trans: 0, lastAct: 0, events: []
  };
  nextLog(sim);
  return sim;
}

// Steps since the player could last have thrown and did not.
function idleSteps(sim) { return sim.trans > 0 || sim.fly >= 0 ? 0 : sim.step - sim.lastAct; }

// A throw leaves the hand at once. Refused (and never recorded) while a knife
// is in the air, while a log arrives, or once the run is over.
function throwSim(sim) {
  if (sim.dead || sim.fly >= 0 || sim.trans > 0 || sim.throws >= MAX_THROWS) return false;
  sim.fly = FLY; sim.throws++; sim.lastAct = sim.step;
  return true;
}

function stepSim(sim) {
  var ev = [];
  sim.events = ev;
  if (sim.dead) return;
  var t = ++sim.step;
  if (sim.trans > 0) {
    sim.trans--;
    if (sim.trans === 0) { sim.lastAct = t; ev.push({ t: 'ready', k: sim.log }); }
    return;
  }
  var spec = sim.spec, target = spec.kf[sim.kfi][0];
  if (sim.spd < target) sim.spd = Math.min(target, sim.spd + spec.acc);
  else if (sim.spd > target) sim.spd = Math.max(target, sim.spd - spec.acc);
  sim.rot = wrapSub(sim.rot + sim.spd);
  if (--sim.kfLeft <= 0) { sim.kfi = (sim.kfi + 1) % spec.kf.length; sim.kfLeft = spec.kf[sim.kfi][1]; }
  if (sim.fly >= 0 && --sim.fly === 0) {
    sim.fly = -1;
    var a = (TURN - Math.floor(sim.rot / SUB)) % TURN, i;
    for (i = 0; i < sim.stuck.length; i++) {
      if (circ(a, sim.stuck[i]) < TOL) {
        sim.dead = true; sim.deathStep = t; sim.cause = 'knife';
        ev.push({ t: 'clang', a: a, s: sim.stuck[i] });
        return;
      }
    }
    var keep = [];
    for (i = 0; i < sim.apples.length; i++) {
      if (circ(a, sim.apples[i]) < APPLE_TOL) { sim.score += APPLE_PTS; ev.push({ t: 'apple', a: sim.apples[i] }); }
      else keep.push(sim.apples[i]);
    }
    sim.apples = keep;
    sim.stuck = sim.stuck.concat([a]);
    sim.score += KNIFE_PTS; sim.left--;
    ev.push({ t: 'stick', a: a, left: sim.left, n: spec.need - sim.left });
    if (sim.left === 0) {
      var bonus = CLEAR_PTS * (sim.log + 1);
      sim.score += bonus;
      ev.push({ t: 'clear', k: sim.log, bonus: bonus, stuck: sim.stuck, rot: sim.rot, boss: spec.boss });
      nextLog(sim);
    }
    return;
  }
  if (sim.fly < 0 && t - sim.lastAct >= IDLE_END) {
    sim.dead = true; sim.deathStep = t; sim.cause = 'idle';
    ev.push({ t: 'idle' });
  }
}
// ==== CHAKKAR CHAKU RULES END ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound far above any real run (a throw lands at most every FLY steps).
// It REFUSES further inputs, it never zeroes.
const MAX_INPUTS = Math.ceil(MAX_SIM_STEPS / FLY) + 100;

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
    stats: { steps: [], margins: [], idles: [] },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. At every knife that sticks: the angular MARGIN to
// the nearest knife already in that log (a planner lands in the middle of
// the gap, a hand anywhere in it), and the steps the player waited since the
// log let them throw.
function noteStep(state, before) {
  const sim = state.sim;
  for (const e of sim.events) {
    if (e.t !== 'stick') continue;
    const others = before || [];
    let m = TURN;
    for (const s of others) m = Math.min(m, circ(e.a, s));
    if (others.length) state.stats.margins.push(m);
  }
}
function stepOnce(state) {
  const sim = state.sim;
  const before = sim.stuck;
  stepSim(sim);
  noteStep(state, before);
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
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'throw') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, step } = payload;
  if (!isStep(n) || !isStep(step)) return reject(state, 'bad_throw');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would re-run a window and keep the
  // best outcome.
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  // The throw names its index in the run; any other index is out of order.
  if (n !== sim.throws) return reject(state, 'out_of_order');
  const idle = idleSteps(sim);
  if (!throwSim(sim)) return reject(state, 'refused');
  state.stats.steps.push(sim.step);
  state.stats.idles.push(idle);
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
  // Run the world out past the last input: a knife in the air lands, and a
  // log left alone ends the run within IDLE_END steps.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {
    stepOnce(state);
    guard++;
  }
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, deathStep: sim.deathStep, cause: sim.cause,
      score: sim.score, dead: sim.dead, logs: sim.log,
      inputs: state.inputCount, rejects: state.rejectCount, throws: st.steps.length,
      marginMean: round3(mean(st.margins)), marginSd: round3(sd(st.margins)),
      waitMean: round3(mean(st.idles)), waitSd: round3(sd(st.idles)),
      gapCv: round3(gapCv(st.steps)),
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
    RULES_VERSION, initSim, stepSim, throwSim, nextLog, logSpec, cycleNet, kind0, idleSteps, hash, seedToInt,
    circ, wrapSub, isBoss, speedOf, MAX_INPUTS, MAX_SIM_STEPS,
    TURN, SUB, TURN_SUB, FLY, TOL, APPLE_TOL, TRANS, IDLE_WARN, IDLE_END, MAX_STUCK, BOSS_EVERY,
    V_BASE, V_STEP, V_CAP_K, V3_BASE, V3_STEP, V3_CAP_K, V3_LATE_STEP, V3_LATE_CAP_K, ACC_PULSE, ACC_REV3, speedOf3, spinPlan3, ACC, ACC_REV, ACC_BOSS, NET_MIN, DRAWS, KNIFE_PTS, APPLE_PTS, CLEAR_PTS, MAX_THROWS,
    SEED_MIX, HASH_K, HASH_J, MIX_A, MIX_B,
  },
};
