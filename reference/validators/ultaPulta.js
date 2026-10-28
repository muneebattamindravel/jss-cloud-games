'use strict';

/**
 * Ulta Pulta validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a cube runs on its own between a floor and a ceiling of pillars,
 * with floating ledges in between. A tap flips gravity. Walls and holes end
 * the run. Score: one point per section passed, times the combo multiplier
 * (clean landings in a row, up to x4; a flip in mid-air resets it), gold +2
 * times the multiplier, and +1 for a near miss.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed: section N is a pure function
 *      of (seed, N) with six index-addressed draws, never a running stream;
 *   2. applies each flip { n, step } before the step it landed on, exactly as
 *      the client does (at most one flip per step);
 *   3. runs the same fixed steps and reads the score the rules produce.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/ulta-pulta/js/game.js.
 * shared/tests/ultaPultaParity.test.js fails the moment the two differ. Edit
 * both or neither; a gameplay change is a trace version bump.
 *
 * Integers only: +, -, *, /, Math.floor, min, max, imul and comparisons.
 */

const R = (function () {
  // ULTA PULTA RULES BEGIN
  // integers only; world units, positions and velocities in 1/16 unit
  var RULES_VERSION = 4;
  var COL = 48;            // pillar width along the run (and its depth)
  var CUBE = 22;           // cube edge
  var STEP_UP = 4;         // surfaces are flat; any step up is a wall
  var F_MIN = 40, F_STEPS = 4, F_STEP = 60;      // floor tops 40, 100, 160, 220: every change is a clear step
  var C_MIN = 360, C_STEPS = 4, C_STEP = 60;     // ceiling bottoms 360, 420, 480, 540
  var GRAV = 48;           // 1/16 unit per step^2 (3 units)
  var KICK = 64;           // a flip starts moving at once
  var VY_MAX = 448;        // 1/16 unit per step (28 units)
  var V0 = 56, VMAX = 124, VINC = 1;  // run speed, 1/16 unit per step, +1 per section
  var LOW_DEATH = -170 * 16, HIGH_DEATH = 760 * 16;
  var LEDGE_T = 24;        // ledge slab thickness
  var ROOM = 48;           // clear space kept above and below a ledge
  var GOLD_POINTS = 2;
  var COMBO_PER = 4, COMBO_MAX = 4;   // every 4 clean landings in a row raise the multiplier, up to x4
  var NEAR = 10;           // clearing a step by this little or less is a near miss
  var NEAR_POINTS = 1;
  var ZONE_LEN = 25;       // the world changes character every 25 sections

  // 0 open, 1 tunnel (tight gaps, many walls), 2 sky (ledges over the void)
  function zoneOf(n) { return n < ZONE_LEN ? 0 : [1, 2, 0][Math.floor(n / ZONE_LEN) % 3]; }
  var GOLD_R = 10;

  function mix(a, b, c) {
    var h = (a ^ Math.imul(b, 0x9E3779B1) ^ Math.imul(c, 0x85EBCA77)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
    h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // Section n: a pure function of (seed, n, rules version). Six draws on every index.
  // v3: the opening is short and the first section is a forced floor hole, so the
  // first flip comes about two seconds in; the ramp then runs as v2's did from
  // section 4 (k = n + 4). v2 traces replay on v2's course exactly.
  function sectionRaw(seed, n, v) {
    var d0 = mix(seed, n, 1), d1 = mix(seed, n, 2), d2 = mix(seed, n, 3);
    var d3 = mix(seed, n, 4), d4 = mix(seed, n, 5), d5 = mix(seed, n, 6);
    if (v >= 3 && n < 1) return { len: 12, floor: true, ceil: true, F: 100, C: 480, L: null, sF: 0, sC: 0, gold: -1 };
    if (v >= 3 && n === 1) return { len: 5, floor: false, ceil: true, F: 100, C: 480, L: null, sF: 0, sC: 0, gold: -1 };
    if (!(v >= 3) && n < 3) return { len: 8, floor: true, ceil: true, F: 100, C: 480, L: null, sF: 0, sC: 0, gold: -1 };
    var k = v >= 3 ? n + 4 : n;
    // difficulty grows section by section: longer, flatter, hole-free sections first
    var len = k < 15 ? 5 + d0 % 4 : k < 40 ? 4 + d0 % 4 : 3 + d0 % 5;
    var zone = zoneOf(n);
    var holeOdds = Math.max(0, Math.min(55, (k - 5) * 3));
    if (zone === 1) holeOdds = Math.floor(holeOdds / 2);
    if (zone === 2) holeOdds = 70;
    var r = d1 % 100, floor = true, ceil = true;
    if (r < holeOdds) { if ((d1 >>> 8) % 2) floor = false; else ceil = false; }
    // how many height levels are in play: one at first, all four later
    var levels = k < 6 ? 1 : k < 14 ? 2 : k < 24 ? 3 : 4;
    var F = F_MIN + (1 + (d2 % levels) - (levels > 2 ? 1 : 0)) * F_STEP;
    var C = C_MIN + (2 - (d3 % levels) + (levels > 2 ? 1 : 0)) * C_STEP;
    if (zone === 1) { F = F_MIN + (2 + d2 % 2) * F_STEP; C = C_MIN + (d3 % 2) * C_STEP; }   // tunnel: floor high, ceiling low
    // a floating ledge: from section 10, more often later; from 16 it may be the only surface
    var L = null;
    var ledgeOdds = zone === 1 ? 0 : zone === 2 ? 85 : Math.min(45, (k - 8) * 3);
    if (k >= 10 && len >= 4 && (d4 % 100) < ledgeOdds) {
      var lo = (floor ? F : F_MIN) + ROOM, hi = (ceil ? C : C_MIN + 3 * C_STEP) - ROOM - LEDGE_T;
      var slots = Math.floor((hi - lo) / 20) + 1;
      if (slots > 0) {
        L = lo + ((d4 >>> 8) % slots) * 20;
        if (k >= 16 && ((d4 >>> 20) % (zone === 2 ? 2 : 4)) === 0) { floor = false; ceil = false; }
      }
    }
    var gold = k >= 3 && (d5 % 100) < 40 ? (d5 >>> 8) % len : -1;
    return { len: len, floor: floor, ceil: ceil, F: F, C: C, L: L, sF: 0, sC: 0, gold: gold };
  }

  // v4: a ledge is dropped when the cube running off its top would meet something
  // it cannot clear: a ceiling too low in the next section, or the next ledge too
  // close above or below this one's top. The check reads the next section's raw plan.
  var CLEAR_NEXT = 40;
  function section(seed, n, v) {
    var s = sectionRaw(seed, n, v);
    if (v >= 4 && s.L !== null) {
      var top = s.L + LEDGE_T, nx = sectionRaw(seed, n + 1, v), bad = false;
      if (nx.ceil && nx.C - top < CUBE + CLEAR_NEXT) bad = true;
      if (nx.floor && nx.F > top && nx.F - top < CUBE + CLEAR_NEXT && nx.F - top > STEP_UP) bad = true;
      if (nx.L !== null && nx.L + LEDGE_T > s.L - CLEAR_NEXT && nx.L < top + CUBE + CLEAR_NEXT) bad = true;
      if (bad) { s.L = null; if (!s.floor && !s.ceil) s.floor = true; }
    }
    return s;
  }

  function clampF(v) { return Math.max(F_MIN, Math.min(F_MIN + (F_STEPS - 1) * F_STEP, v)); }
  function clampC(v) { return Math.max(C_MIN, Math.min(C_MIN + (C_STEPS - 1) * C_STEP, v)); }

  // World: sections end to end. Each pillar gets a small climbable jitter.
  function World(seed, v) { this.seed = seed; this.v = v; this.secs = []; this.cols = []; }
  World.prototype.ensure = function (col) {
    while (this.cols.length <= col) {
      var n = this.secs.length, s = section(this.seed, n, this.v), start = this.cols.length;
      this.secs.push({ n: n, start: start, len: s.len });
      for (var i = 0; i < s.len; i++) {
        var jf = 0, jc = 0;
        if (n < 2) { jf = 0; jc = 0; }
        this.cols.push({
          sec: n,
          F: s.floor ? clampF(s.F + s.sF * i) + jf : null,
          C: s.ceil ? clampC(s.C + s.sC * i) - jc : null,
          L: s.L !== null && i > 0 && i < s.len - 1 ? s.L : null,   // ledges float: open space at both ends
          gold: s.gold === i
        });
      }
    }
    return this.cols[col];
  };

  // The session seed is hex; standalone play passes any hex string.
  function seedToInt(seedHex) {
    if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
    return (parseInt(seedHex.slice(0, 8), 16) ^ Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, 0x85EBCA6B)) | 0;
  }

  // The rules version comes from the trace's start marker: 2 or 3.
  function initSim(seedHex, version) {
    var v = version >= 4 ? 4 : version >= 3 ? 3 : 2;
    return { v: v, w: new World(seedToInt(seedHex), v), flips: 0, lastFlip: -1, x: 2 * COL * 16, y: 100 * 16, vy: 0, g: -1, on: true,
      alive: true, step: 0, score: 0, passed: 0, golds: 0, taken: {}, cause: '', ev: [],
      combo: 0, mult: 1, nears: 0, lastFront: -1 };
  }

  // A tap reverses gravity at once: the old fall is cancelled, the new one starts.
  // At most one flip per step, so a second finger on the same step mints nothing.
  function flip(sim) {
    if (!sim.alive || sim.lastFlip === sim.step) return false;
    sim.lastFlip = sim.step;
    sim.flips++;
    if (!sim.on) { sim.combo = 0; sim.mult = 1; sim.ev.push('break'); }   // reversing mid-air wastes the flip
    sim.g = -sim.g;
    sim.vy = sim.g * KICK;
    sim.on = false;
    sim.ev.push('flip');
    return true;
  }

  // solid spans of a column, bottom to top, in world units
  var FAR = 100000;
  function solids(c) {
    var out = [];
    if (c.F !== null) out.push([-FAR, c.F]);
    if (c.L !== null) out.push([c.L, c.L + LEDGE_T]);
    if (c.C !== null) out.push([c.C, FAR]);
    return out;
  }

  function landed(sim) {
    sim.combo++;
    var m = Math.min(COMBO_MAX, 1 + Math.floor(sim.combo / COMBO_PER));
    if (m > sim.mult) sim.ev.push('mult');
    sim.mult = m;
    sim.ev.push('land');
  }

  function die(sim, cause) { sim.alive = false; sim.cause = cause; sim.ev.push('die'); }

  function stepSim(sim) {
    sim.ev = [];
    if (!sim.alive) return;
    sim.step++;
    var w = sim.w, U = 16;
    var speed = Math.min(VMAX, V0 + sim.passed * VINC);
    // horizontal: the pillar the cube's front face enters
    var nx = sim.x + speed;
    var front = Math.floor((nx + CUBE * U - 1) / (COL * U));
    var c = w.ensure(front);
    var sol = solids(c);
    // near miss: entering a raised column in the air and clearing it by a hair
    if (front !== sim.lastFront) {
      var pc = sim.lastFront >= 0 ? solids(w.ensure(sim.lastFront)) : [];
      if (!sim.on && sim.lastFront >= 0) {
        for (var ni = 0; ni < sol.length; ni++) {
          var nlo = sol[ni][0], nhi = sol[ni][1], below = sim.y - nhi * U, above = nlo * U - (sim.y + CUBE * U);
          var raised = true, lowered = true;
          for (var pj = 0; pj < pc.length; pj++) { if (pc[pj][1] >= nhi && pc[pj][0] < nhi) raised = false; if (pc[pj][0] <= nlo && pc[pj][1] > nlo) lowered = false; }
          if ((nhi < FAR && raised && below >= 0 && below <= NEAR * U) || (nlo > -FAR && lowered && above >= 0 && above <= NEAR * U)) {
            sim.score += NEAR_POINTS; sim.nears++; sim.ev.push('near'); break;
          }
        }
      }
      sim.lastFront = front;
    }
    for (var si = 0; si < sol.length; si++) {
      var lo = sol[si][0] * U, hi = sol[si][1] * U;
      if (sim.y < hi && sim.y + CUBE * U > lo) {
        if (sim.g < 0 && hi - sim.y <= STEP_UP * U) sim.y = hi;
        else if (sim.g > 0 && sim.y + CUBE * U - lo <= STEP_UP * U) sim.y = lo - CUBE * U;
        else { die(sim, 'wall'); return; }
      }
    }
    sim.x = nx;
    // vertical
    var c0 = Math.floor(sim.x / (COL * U)), c1 = Math.floor((sim.x + CUBE * U - 1) / (COL * U));
    // the nearest surface below and above the cube, over both columns it straddles
    var fl = null, cl = null, both = solids(w.ensure(c0)).concat(c1 !== c0 ? solids(w.ensure(c1)) : []);
    for (var q = 0; q < both.length; q++) {
      var t = both[q][1], bo = both[q][0];
      if (t * U <= sim.y && (fl === null || t > fl)) fl = t;
      if (bo * U >= sim.y + CUBE * U && (cl === null || bo < cl)) cl = bo;
    }
    sim.vy = Math.max(-VY_MAX, Math.min(VY_MAX, sim.vy + sim.g * GRAV));
    var ny = sim.y + sim.vy, wasOn = sim.on;
    sim.on = false;
    if (fl !== null && sim.vy <= 0 && sim.y >= fl * U && ny <= fl * U) {
      ny = fl * U; sim.vy = 0; if (sim.g < 0) { sim.on = true; if (!wasOn) landed(sim); }
    }
    if (cl !== null && sim.vy >= 0 && sim.y + CUBE * U <= cl * U && ny + CUBE * U >= cl * U) {
      ny = cl * U - CUBE * U; sim.vy = 0; if (sim.g > 0) { sim.on = true; if (!wasOn) landed(sim); }
    }
    sim.y = ny;
    if (sim.y < LOW_DEATH || sim.y > HIGH_DEATH) { die(sim, 'fell'); return; }
    var cur = w.ensure(c0).sec;
    if (cur > sim.passed + 1) { sim.passed = cur - 1; sim.score += sim.mult; sim.ev.push('section'); }
    for (var k = c0; k <= c1; k++) {
      var col = w.ensure(k);
      if (!col.gold || sim.taken[k]) continue;
      var gy = goldY(col), gx = k * COL + COL / 2;
      var cx = sim.x / U + CUBE / 2, cy = sim.y / U + CUBE / 2;
      if (Math.abs(cx - gx) <= GOLD_R + CUBE / 2 && Math.abs(cy - gy) <= GOLD_R + CUBE / 2) {
        sim.taken[k] = true; sim.score += GOLD_POINTS * sim.mult; sim.golds++; sim.ev.push('gold');
      }
    }
  }
  function goldY(col) {
    var lo = col.F === null ? 80 : col.F, hi = col.C === null ? 520 : col.C;
    if (col.L !== null) { if (col.L - lo > hi - col.L - LEDGE_T) hi = col.L; else lo = col.L + LEDGE_T; }
    return Math.floor((lo + hi) / 2);
  }
  // ULTA PULTA RULES END

  return {
    RULES_VERSION: RULES_VERSION, COL: COL, CUBE: CUBE, VMAX: VMAX, V0: V0,
    initSim: initSim, stepSim: stepSim, flip: flip, section: section, solids: solids,
    zoneOf: zoneOf, seedToInt: seedToInt, goldY: goldY,
  };
})();

const { initSim, stepSim, flip, RULES_VERSION } = R;

// An hour of simulation: the session's own lifetime. A cap below it would
// silently TRUNCATE a legal run. shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// At most one flip per step. A WORK bound: it refuses further inputs, it never zeroes.
const MAX_INPUTS = MAX_SIM_STEPS;
// How far ahead the bot-detector probe looks when it asks "how long could
// this flip have waited?". Recorded only, never gated.
const PROBE_STEPS = 120;

function advanceTo(sim, step) {
  while (sim.alive && sim.step < step && sim.step < MAX_SIM_STEPS) stepSim(sim);
}

// `typeof` FIRST: Number(null) is 0, so coercing would apply a malformed step.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { slack: [], airFlips: 0, gaps: [], last: -1 },
  };
}

// A copy of the run that shares the (append-only) course, for the probe.
function probeClone(sim) {
  const c = Object.assign({}, sim);
  c.taken = Object.assign({}, sim.taken);
  c.ev = [];
  return c;
}

// The slack of a flip: how many more steps the cube would have survived had
// the player NOT flipped now (capped). A planner flips at a consistent, small
// slack; a hand scatters. Raw material for the humanness layer, never a rule.
function slackOf(sim) {
  const c = probeClone(sim);
  let k = 0;
  while (c.alive && k < PROBE_STEPS) { stepSim(c); k++; }
  return k;
}

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
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim' || kind !== 'flip') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, step } = payload;
  if (!isStep(n) || !isStep(step)) return reject(state, 'bad_flip');
  const sim = state.sim;
  // Steps may never go backwards: a rewind would re-run a window and keep the best outcome.
  if (step < sim.step) return reject(state, 'frame_regressed');

  advanceTo(sim, step);
  if (!sim.alive) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (n !== sim.flips) return reject(state, 'out_of_order');
  const st = state.stats;
  const wasOn = sim.on;
  const slack = slackOf(sim);
  // The client only records a flip it applied, so a refused one is forged.
  if (!flip(sim)) return reject(state, 'refused');
  if (wasOn) st.slack.push(slack); else st.airFlips++;
  if (st.last >= 0) st.gaps.push(sim.step - st.last);
  st.last = sim.step;
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function r3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out past the last input: a run that stops flipping meets a
  // wall or a hole within seconds, so this always ends.
  const runOut = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const cap = elapsedCap(state, 60);
  let guard = 0;
  while (sim.alive && guard < runOut && sim.step < cap && sim.step < MAX_SIM_STEPS) { stepSim(sim); guard++; }
  const st = state.stats;
  const gm = mean(st.gaps), gs = sd(st.gaps);
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, dead: !sim.alive, cause: sim.cause, score: sim.score,
      passed: sim.passed, golds: sim.golds, nears: sim.nears, flips: sim.flips,
      inputs: state.inputCount, rejects: state.rejectCount,
      // fingerprint raw material (recorded, never gated)
      slackMean: r3(mean(st.slack)), slackSd: r3(sd(st.slack)),
      slackMin: st.slack.length ? Math.min.apply(null, st.slack) : null,
      airFlipShare: sim.flips ? r3(st.airFlips / sim.flips) : null,
      gapMean: r3(gm), gapCv: gm && gs !== null ? r3(gs / gm) : null,
    },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  _limits: { MAX_SIM_STEPS, FPS: 60 },
  init, processEvent, finalize, simulate,
  _sim: Object.assign({}, R, { MAX_SIM_STEPS, MAX_INPUTS, PROBE_STEPS, advanceTo, slackOf }),
};
