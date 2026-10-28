'use strict';

/**
 * Lattoo validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one: a trace without a v2 start marker is not a run
 * and scores zero.
 *
 * The game: rival lattoos (tops) spin inside a chalk circle. You throw yours
 * from the line, with a pull as an integer vector, to knock them out. Round R's
 * rivals are a pure function of (seed, R). A knock-out scores, a cleared round
 * scores and refills your throws; three minutes on the clock.
 *
 * What the server does with a trace:
 *   1. rebuilds every round from the session seed;
 *   2. applies each throw { n, dx, dy, step } before step `step`, exactly as the
 *      client does (a throw the rules refuse is refused here too);
 *   3. runs the same fixed 1/60 s steps to the end of the clock.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/lattoo/js/game.js.
 * shared/tests/lattooParity.test.js fails the moment one copy changes without
 * the other. A gameplay change is a trace version bump, never an edit in place.
 */

  // ==== LATTOO RULES BEGIN (word for word in games/lattoo/js/game.js and shared/anticheat/validators/lattoo.js) ====
  // The street game: rival lattoos spin inside a chalk circle; you throw yours
  // from the line to knock them out. One input per throw: the pull, as an
  // integer vector. Integers only: +, -, *, /, Math.trunc, Math.floor,
  // Math.sqrt (inside isqrt only), Math.imul, bit ops and comparisons.
  // Positions and velocities are in 1/256 design units (velocity per step).
  // One step is 1/60 s, split into SUB moves with every pair tested after each.
  var SU = 256;
  var CX = 207 * SU, CY = 360 * SU;
  var RING_R = 150 * SU;          // a rival whose centre passes this is out
  var LX = 207 * SU, LY = 565 * SU;   // where you throw from, outside the circle
  var SUB = 4;
  var PULL_MIN = 14, PULL_MAX = 150;  // design units of pull
  var V_MAX = 2816;               // launch speed at full pull, 11 units a step
  var DRAG = 255;                 // speed kept per step, out of 256
  var FRIC = 14;                  // and this much less every step, so a top slows evenly to rest
  var STOP = 24;                  // |vx| + |vy| under this is at rest
  var REST = 216;                 // restitution, out of 256
  var AIM_STEPS = 720;            // 12 s to throw, or the throw is lost
  var ROLL_MAX = 900;             // a throw settles within 15 s at most
  var START_THROWS = 5, MULTI_THROWS = 1, FOUL_THROWS = 1;
  var KO_PTS = 10, CLEAR_PTS = 25;
  var RUN_STEPS = 10800;          // 3 minutes; a throw already rolling settles first
  var MAX_ROUNDS = 400, MAX_THROWS = 3000;   // work bounds
  var RULES_VERSION = 2;
  // kinds: 0 yours, 1 rival, 2 small rival, 3 heavy rival
  var K_R = [22, 20, 15, 28];
  var K_M = [3, 2, 1, 6];
  var DRIFT_P = 150;              // a drifting rival turns round every 2.5 s
  var DRIFT_K = 8, DRIFT_V = 160; // it eases toward its mark, at most 0.6 units a step
  var DIRS = [[256, 0], [181, 181], [0, 256], [-181, 181], [-256, 0], [-181, -181], [0, -256], [181, -181]];
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
  // The ramp. Early rounds: few rivals, all sitting near the chalk, so any
  // decent throw knocks them out. Later: more of them, nearer the middle (a
  // harder knock that risks a foul), more heavies, more drift, fewer refills.
  function roundKind(R, h) {
    if (R < 3) return 1;
    if (R < 5) return h < 70 ? 1 : 2;
    var heavy = Math.min(10 + (R - 5) * 5, 40), small = 25;
    return h < heavy ? 3 : (h < heavy + small ? 2 : 1);
  }
  function roundCount(R) { return Math.min(2 + Math.floor(R / 2), 8); }
  function roundBand(R) { var lo = Math.max(0, 100 - (R - 1) * 14); return [lo, Math.max(lo + 25, 125 - Math.max(0, R - 4) * 5)]; }
  function clearThrows(R) { return R <= 3 ? 3 : (R <= 6 ? 2 : 1); }
  // Round R's rivals: [kind, x, y], a pure function of (seed, R). Each takes
  // up to 8 tries for a spot clear of the ones before it.
  function layout(seed, R) {
    var n = roundCount(R), out = [], spread = 125, band = roundBand(R);
    for (var j = 0; j < n; j++) {
      var k = roundKind(R, hash32(seed, R, 100 + j) % 100), px = 0, py = 0, ok = false;
      for (var t = 0; t < 8 && !ok; t++) {
        var h = hash32(seed, R, j * 8 + t), w = spread * 2 + 1;
        px = (h % w) - spread; py = ((h >>> 10) % w) - spread;
        var pd = px * px + py * py;
        if (pd > band[1] * band[1] || (t < 6 && pd < band[0] * band[0])) continue;
        ok = true;
        for (var i = 0; i < out.length; i++) {
          var dx = px - out[i][1], dy = py - out[i][2], rr = K_R[k] + K_R[out[i][0]] + 6;
          if (dx * dx + dy * dy < rr * rr) { ok = false; break; }
        }
      }
      if (ok) out = out.concat([[k, px, py]]);
    }
    // a round is never empty: if no spot was found, one plain rival sits in the middle
    if (out.length === 0) out = [[1, 0, 0]];
    return out;
  }
  function mk(sim, k, x, y) {
    var h = hash32(sim.seed, sim.nextId, 7);
    var t = { id: sim.nextId, k: k, x: x, y: y, vx: 0, vy: 0, inn: 0, hx: x, hy: y, dir: h % 8, ph: (h >>> 3) % 2 };
    sim.nextId = sim.nextId + 1;
    return t;
  }
  function cloneTop(t) { return { id: t.id, k: t.k, x: t.x, y: t.y, vx: t.vx, vy: t.vy, inn: t.inn, hx: t.hx, hy: t.hy, dir: t.dir, ph: t.ph }; }
  // How far a rival drifts either side of its home, in design units: nothing
  // in round 1, more each round, small ones more, heavy ones never.
  function driftAmp(R, k) {
    if (k === 3 || R < 2) return 0;
    var a = Math.min(6 + (R - 2) * 4, 26);
    return k === 2 ? a + Math.trunc(a / 2) : a;
  }
  // A home the drift cannot carry over the chalk.
  function settleHome(sim, t) {
    var lim = RING_R - (K_R[t.k] + driftAmp(sim.round, t.k) + 8) * SU, dx = t.x - CX, dy = t.y - CY, d = isqrt(dx * dx + dy * dy);
    if (lim < 0) lim = 0;
    if (d > lim && d > 0) { t.hx = CX + Math.trunc(dx * lim / d); t.hy = CY + Math.trunc(dy * lim / d); }
    else { t.hx = t.x; t.hy = t.y; }
  }
  function startRound(sim) {
    var R = sim.round + 1, plan = layout(sim.seed, R), list = [];
    for (var j = 0; j < plan.length; j++) list = list.concat([mk(sim, plan[j][0], CX + plan[j][1] * SU, CY + plan[j][2] * SU)]);
    sim.round = R;
    for (j = 0; j < list.length; j++) settleHome(sim, list[j]);
    sim.tops = list;
  }
  function initSim(seedInt, version) {
    var sim = { seed: seedInt >>> 0, v: version === 2 ? 2 : RULES_VERSION, step: 0, phase: 0, aimT: 0, rollT: 0,
      throws: START_THROWS, n: 0, round: 0, score: 0, kos: 0, koThrow: 0, me: null, tops: [], nextId: 1,
      dead: false, endReason: '', ev: [] };
    startRound(sim);
    return sim;
  }
  // Throw n with pull (dx, dy) on step `step`. A refusal changes nothing.
  function throwSim(sim, n, dx, dy, step) {
    if (sim.dead) return 'dead';
    if (typeof dx !== 'number' || typeof dy !== 'number' || dx !== Math.floor(dx) || dy !== Math.floor(dy) || dx < -1000 || dx > 1000 || dy < -1000 || dy > 1000) return 'bad_pull';
    if (n !== sim.n) return 'bad_index';
    if (step !== sim.step) return step < sim.step ? 'frame_regressed' : 'not_yet';
    if (sim.phase !== 0) return 'busy';
    if (step >= RUN_STEPS) return 'time_up';
    if (sim.n >= MAX_THROWS) return 'throw_cap';
    var d = isqrt(dx * dx + dy * dy);
    if (d < PULL_MIN) return 'too_short';
    if (d > PULL_MAX) { dx = Math.trunc(dx * PULL_MAX / d); dy = Math.trunc(dy * PULL_MAX / d); d = PULL_MAX; }
    var me = mk(sim, 0, LX, LY);
    me.vx = Math.trunc(dx * V_MAX / PULL_MAX); me.vy = Math.trunc(dy * V_MAX / PULL_MAX);
    sim.me = me; sim.phase = 1; sim.rollT = 0; sim.koThrow = 0;
    sim.throws = sim.throws - 1; sim.n = sim.n + 1;
    return null;
  }
  function collide(a, b, ev) {
    var rs = (K_R[a.k] + K_R[b.k]) * SU, dx = b.x - a.x, dy = b.y - a.y;
    if (dx >= rs || dx <= -rs || dy >= rs || dy <= -rs) return;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs) return;
    var d = isqrt(d2);
    if (d === 0) { dx = SU; dy = 0; d = SU; }
    var ma = K_M[a.k], mb = K_M[b.k], mt = ma + mb;
    var over = rs - d, pa = Math.trunc(over * mb / mt), pb = over - pa;
    a.x = a.x - Math.trunc(dx * pa / d); a.y = a.y - Math.trunc(dy * pa / d);
    b.x = b.x + Math.trunc(dx * pb / d); b.y = b.y + Math.trunc(dy * pb / d);
    var vn = Math.trunc(((b.vx - a.vx) * dx + (b.vy - a.vy) * dy) / d);
    if (vn >= 0) return;
    var dv = -vn + Math.trunc(-vn * REST / 256);
    var ja = Math.trunc(dv * mb / mt), jb = dv - ja;
    a.vx = a.vx - Math.trunc(dx * ja / d); a.vy = a.vy - Math.trunc(dy * ja / d);
    b.vx = b.vx + Math.trunc(dx * jb / d); b.vy = b.vy + Math.trunc(dy * jb / d);
    ev.push({ e: 'hit', x: a.x + Math.trunc(dx * K_R[a.k] * SU / d), y: a.y + Math.trunc(dy * K_R[a.k] * SU / d), s: -vn });
  }
  // One steady slowdown along the direction of travel, so a throw neither
  // curves nor surges: a little drag, then a fixed amount of friction a step.
  function slow(t) {
    var sp = isqrt(t.vx * t.vx + t.vy * t.vy);
    if (sp === 0) return;
    var ns = Math.trunc(sp * DRAG / 256) - FRIC;
    if (ns <= 0) { t.vx = 0; t.vy = 0; return; }
    t.vx = Math.trunc(t.vx * ns / sp); t.vy = Math.trunc(t.vy * ns / sp);
  }
  function moving(t) { return (t.vx < 0 ? -t.vx : t.vx) + (t.vy < 0 ? -t.vy : t.vy) >= STOP; }
  function stepSim(sim) {
    if (sim.dead) return;
    var s = sim.step, ev = [], i, j, t;
    if (sim.phase === 0) {
      if (s >= RUN_STEPS) { sim.dead = true; sim.endReason = 'time'; sim.ev = ev; sim.step = s + 1; return; }
      sim.aimT = sim.aimT + 1;
      if (sim.aimT >= AIM_STEPS) {
        sim.aimT = 0; sim.throws = sim.throws - 1; ev.push({ e: 'lost' });
        if (sim.throws <= 0) { sim.dead = true; sim.endReason = 'throws'; }
      }
      // rivals drift slowly back and forth while you aim
      var dr = sim.tops.map(cloneTop);
      for (i = 0; i < dr.length; i++) {
        t = dr[i];
        var amp = driftAmp(sim.round, t.k);
        if (amp === 0) { t.vx = 0; t.vy = 0; continue; }
        var sg = (Math.floor((s + t.ph * DRIFT_P) / DRIFT_P) % 2 === 0) ? 1 : -1;
        var gx = t.hx + Math.trunc(DIRS[t.dir][0] * amp * SU * sg / 256), gy = t.hy + Math.trunc(DIRS[t.dir][1] * amp * SU * sg / 256);
        var vx = Math.trunc((gx - t.x) * DRIFT_K / 256), vy = Math.trunc((gy - t.y) * DRIFT_K / 256);
        t.vx = vx > DRIFT_V ? DRIFT_V : (vx < -DRIFT_V ? -DRIFT_V : vx);
        t.vy = vy > DRIFT_V ? DRIFT_V : (vy < -DRIFT_V ? -DRIFT_V : vy);
      }
      for (var m0 = 0; m0 < SUB; m0++) {
        for (i = 0; i < dr.length; i++) { t = dr[i]; t.x = t.x + Math.trunc(t.vx / SUB); t.y = t.y + Math.trunc(t.vy / SUB); }
        for (i = 0; i < dr.length; i++) for (j = i + 1; j < dr.length; j++) collide(dr[i], dr[j], ev);
      }
      sim.tops = dr;
      sim.ev = ev; sim.step = s + 1;
      return;
    }
    var tops = sim.tops.map(cloneTop), me = sim.me ? cloneTop(sim.me) : null;
    var all = me ? [me].concat(tops) : tops;
    for (i = 0; i < all.length; i++) slow(all[i]);
    for (var m = 0; m < SUB; m++) {
      for (i = 0; i < all.length; i++) { t = all[i]; t.x = t.x + Math.trunc(t.vx / SUB); t.y = t.y + Math.trunc(t.vy / SUB); }
      for (i = 0; i < all.length; i++) for (j = i + 1; j < all.length; j++) collide(all[i], all[j], ev);
    }
    // rivals past the chalk are out, and score more the more one throw takes
    var keep = [];
    for (i = 0; i < tops.length; i++) {
      t = tops[i];
      var rx = t.x - CX, ry = t.y - CY;
      var isOut = rx * rx + ry * ry > RING_R * RING_R;
      if (isOut) {
        sim.koThrow = sim.koThrow + 1; sim.kos = sim.kos + 1;
        var pts = KO_PTS * sim.koThrow;
        sim.score = sim.score + pts;
        ev.push({ e: 'out', x: t.x, y: t.y, vx: t.vx, vy: t.vy, k: t.k, n: pts, c: sim.koThrow });
      } else keep.push(t);
    }
    tops = keep;
    // your lattoo must stay in the circle: once in, leaving it is a foul
    if (me) {
      var mx = me.x - CX, my = me.y - CY, md = mx * mx + my * my;
      if (md <= RING_R * RING_R) me.inn = 1;
      else if (me.inn) {
        sim.throws = sim.throws - FOUL_THROWS;
        ev.push({ e: 'foul', x: me.x, y: me.y, vx: me.vx, vy: me.vy });
        me = null;
      }
    }
    sim.rollT = sim.rollT + 1;
    var still = !me || !moving(me);
    for (i = 0; i < tops.length && still; i++) if (moving(tops[i])) still = false;
    if (still || sim.rollT >= ROLL_MAX) {
      for (i = 0; i < tops.length; i++) { tops[i].vx = 0; tops[i].vy = 0; settleHome(sim, tops[i]); }
      if (me) ev.push({ e: 'rest', x: me.x, y: me.y });
      me = null; sim.phase = 0; sim.aimT = 0;
      if (sim.koThrow >= 2) { sim.throws = sim.throws + MULTI_THROWS; ev.push({ e: 'bonus', n: MULTI_THROWS }); }
      if (tops.length === 0) {
        var ct = clearThrows(sim.round);
        sim.score = sim.score + CLEAR_PTS; sim.throws = sim.throws + ct;
        ev.push({ e: 'clear', r: sim.round, n: CLEAR_PTS, t: ct });
        sim.tops = tops;
        if (sim.round < MAX_ROUNDS) { startRound(sim); tops = sim.tops; }
      } else if (sim.throws <= 0) { sim.throws = 0; sim.dead = true; sim.endReason = 'throws'; }
    }
    sim.tops = tops; sim.me = me; sim.ev = ev; sim.step = s + 1;
  }
  // ==== LATTOO RULES END ====

// A work bound: the session hour. The run itself ends at RUN_STEPS.
const MAX_SIM_STEPS = 3600 * 60;
// A WORK bound far above any real run. It REFUSES further inputs, never zeroes.
const MAX_INPUTS = MAX_THROWS + 100;

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }
function isInt(v) { return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v; }

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { steps: [], pulls: [], angs: [], rim: [], travel: [], aims: [], restAt: 0, lastThrowStep: -1 },
  };
}

// Raw material for the bot detector, recorded and never gated: how hard each
// throw was pulled, the spread of the aim angles, how near the rim a hit
// rival was, and how far the pull travelled (a program pulls straight).
function stepOnce(state) {
  const sim = state.sim;
  stepSim(sim);
  for (const e of sim.ev) {
    if (e.e === 'out') {
      const rx = e.x - CX, ry = e.y - CY;
      state.stats.rim.push(Math.max(0, RING_R - isqrt(rx * rx + ry * ry)) / SU);
    }
    if (e.e === 'rest') state.stats.restAt = sim.step;
  }
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

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(seedToInt(state.seed), Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim' || kind !== 'throw') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, dx, dy, step } = payload;
  if (!isStep(n) || !isStep(step) || !isInt(dx) || !isInt(dy)) return reject(state, 'bad_throw');
  const sim = state.sim;
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  if (n !== sim.n) return reject(state, 'out_of_order');
  const r = throwSim(sim, n, dx, dy, step);
  if (r !== null) return reject(state, r);
  const st = state.stats;
  const d = Math.min(PULL_MAX, isqrt(dx * dx + dy * dy));
  st.steps.push(step);
  st.pulls.push(d);
  st.angs.push(Math.atan2(dx, -dy));
  st.aims.push(step - st.restAt);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out to the end: a rolling throw settles, the clock runs out.
  const capSteps = elapsedCap(state, 60);
  while (!sim.dead && sim.step < capSteps && sim.step < MAX_SIM_STEPS) stepOnce(state);
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, score: sim.score, dead: sim.dead, end: sim.endReason, rounds: sim.round, kos: sim.kos,
      inputs: state.inputCount, rejects: state.rejectCount, throws: st.steps.length,
      pullMean: round3(mean(st.pulls)), pullSd: round3(sd(st.pulls)),
      angSd: round3(sd(st.angs)), rimMean: round3(mean(st.rim)), rimSd: round3(sd(st.rim)),
      aimMean: round3(mean(st.aims)), aimSd: round3(sd(st.aims)),
      travelRatio: st.pulls.length ? round3(mean(st.pulls) / PULL_MAX) : null,
    },
  };
}

module.exports = {
  init, processEvent, finalize,
  _limits: { MAX_SIM_STEPS, MAX_INPUTS, FPS: 60, RUN_STEPS },
  _rules: { initSim, stepSim, throwSim, layout, seedToInt, RUN_STEPS, RULES_VERSION, PULL_MAX },
};
