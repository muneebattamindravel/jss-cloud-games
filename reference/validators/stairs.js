'use strict';

/**
 * Stairs validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Stairs (a partner's game, integrated on replay from day one) is scored from
 * a v2 trace only: a start marker with v >= 2, then dense path batches. There is
 * no plausibility path (the session layer refuses markerless traces).
 *
 * The game: a ball bounces down a staircase by itself, one stair per bounce,
 * faster as it goes. The player drags left and right to steer it. Landing on a
 * spike or off the edge ends the run; every landing scores 1, a landing on the
 * stair's white pad scores the perfect streak (up to COMBO_MAX), and a gem +3.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed: stair N (its pad, spikes, gem
 *      and whether and how it slides) is a pure function of (seed, N);
 *   2. applies each path batch { f, x: [...] }, where x[i] is the ball's target
 *      during fixed step f+1+i, in thousandths of a world unit;
 *   3. walks the same 1/60 s steps as the client and scores its own landings.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/stairs/game.js.
 * shared/tests/stairsParity.test.js fails the moment one copy is edited without
 * the other, and shared/tests/fixtures/stairsGolden.json pins the rules
 * themselves, because a change made in BOTH files would pass a parity check.
 * A gameplay change is a trace version bump and a new golden corpus.
 *
 * No trig, no square roots and no exponentials on the rules path: +, -, *, /,
 * floor, round, trunc, min, max and comparisons are exact in every engine.
 *
 * ⚠ WHAT THIS CANNOT DO. The course is a pure function of a seed on the
 * player's device, so a bot that reads the seed can plan every landing. Replay
 * credits exactly what the inputs produce; the session hour,
 * games.max_score_per_sec and the humanness fingerprint (finalize's debug
 * block, RECORDED, never gated) are what bound that.
 */

  // ==== RULES BLOCK: identical in games/stairs/game.js ====
  //
  // One dimension. The rules know the ball's lateral position (an integer in
  // thousandths of a world unit), the bounce clock and the stairs. Height,
  // depth, the camera and every effect are DRAWING and live outside this
  // block. No trig, no square roots, no exponentials: +, -, *, /, floor,
  // round, trunc, min, max and comparisons are exact in every engine.
  const RULES_VERSION = 2;
  const MIN_REPLAY_VERSION = 2;
  const POSITION_SCALE = 1000;
  const GRID = [-2.64, -1.32, 0, 1.32, 2.64];
  const SAFE_HALF_WIDTH = 3.22;
  const SPIKE_HIT_RADIUS = 0.43;
  const PAD_HIT_RADIUS = 0.39;
  const GEM_HIT_RADIUS = 0.42;
  const MOVE_LIMIT_Q = 3620;
  const MOVE_AMPLITUDE = 1.05;
  const BOUNCE_MAX = 30;
  const BOUNCE_MIN = 19;
  const BOUNCE_RAMP = 140;
  const COMBO_MAX = 5;
  const GEM_POINTS = 3;
  const PATH_BATCH_MAX = 120;

  function rLerp(a, b, t) { return a + (b - a) * t; }
  function rClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function seedNumber(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
    const text = String(seed == null ? 'standalone' : seed);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function hash01(i, s, seed) {
    let x = (seedNumber(seed) ^ Math.imul((i + 1) | 0, 0x9e3779b1) ^ Math.imul((s + 1) | 0, 0x85ebca6b)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad); x = Math.imul(x ^ (x >>> 15), 0x735a2d97); x ^= x >>> 15;
    return (x >>> 0) / 4294967296;
  }
  function shuffledGrid(i, seed, salt) {
    const out = GRID.slice();
    for (let k = out.length - 1; k > 0; k--) {
      const j = Math.floor(hash01(i, salt + k, seed) * (k + 1));
      const v = out[k]; out[k] = out[j]; out[j] = v;
    }
    return out;
  }
  // Stair i is a pure function of (seed, i). Every stair has a perfect pad;
  // no spike ever sits on it, so a safe lane always exists.
  function makeStepData(i, seed) {
    const d = { i: i, spikes: [], padX: null, gemX: null, move: null };
    const order = shuffledGrid(i, seed, 10);
    d.padX = i === 0 ? 0 : order[0];
    if (i === 0) return d;
    let spikeCount = 0;
    const r = hash01(i, 1, seed);
    if (i <= 2) spikeCount = 0;
    else if (i < 9) spikeCount = r < 0.30 ? 1 : (r < 0.90 ? 2 : 3);
    else if (i < 22) spikeCount = r < 0.22 ? 1 : (r < 0.76 ? 2 : 3);
    else if (i < 50) spikeCount = r < 0.12 ? 1 : (r < 0.48 ? 2 : (r < 0.90 ? 3 : 4));
    else spikeCount = r < 0.10 ? 1 : (r < 0.43 ? 2 : (r < 0.86 ? 3 : 4));
    d.spikes = order.filter(function (x) { return Math.abs(x - d.padX) > 0.1; }).slice(0, Math.min(4, spikeCount));
    const free = GRID.filter(function (x) { return !d.spikes.some(function (s) { return Math.abs(s - x) < 0.1; }); });
    const rubyChoices = free.filter(function (x) { return Math.abs(x - d.padX) > 0.65; });
    if (i > 2 && rubyChoices.length && hash01(i, 40, seed) < 0.20) {
      d.gemX = rubyChoices[Math.floor(hash01(i, 41, seed) * rubyChoices.length) % rubyChoices.length];
    }
    if (i >= 12) {
      const difficulty = rClamp((i - 12) / 90, 0, 1);
      const chance = rLerp(0.16, 0.52, difficulty);
      if (hash01(i, 54, seed) < chance) {
        d.move = {
          phase: Math.floor(hash01(i, 55, seed) * 4096),
          period: Math.round(rLerp(126, 72, difficulty) - hash01(i, 56, seed) * 12),
          amplitude: Math.round((rLerp(0.68, 1.12, difficulty) + hash01(i, 57, seed) * 0.20) * 1000),
        };
      }
    }
    return d;
  }
  function movingStepOffset(d, frame) {
    if (!d || !d.move) return 0;
    const period = d.move.period, phase = d.move.phase % period, p = (frame + phase) % period, half = period / 2;
    const wave = p < half ? (-1 + 2 * p / half) : (3 - 2 * p / half);
    return wave * MOVE_AMPLITUDE * d.move.amplitude / POSITION_SCALE;
  }
  function bounceFramesForStep(step) {
    return BOUNCE_MAX - Math.floor((BOUNCE_MAX - BOUNCE_MIN) * Math.min(BOUNCE_RAMP, step) / BOUNCE_RAMP);
  }

  function initSim(seed, version) {
    return {
      version: version, seed: seedNumber(seed), frames: 0, step: 0, bounceFrame: 0,
      xQ: 0, targetQ: 0, score: 0, combo: 0, gems: 0, perfects: 0, landings: 0,
      bestCombo: 0, landed: 0, landGain: 0, landGem: 0, landX: 0,
      dead: false, deathFrame: -1, deathCause: '',
    };
  }
  // The player's whole input: where the ball should be heading. Clamped, never
  // refused, so an out-of-range target can only ever cost the player.
  function steerSim(sim, q) {
    if (sim.dead) return false;
    sim.targetQ = rClamp(q | 0, -MOVE_LIMIT_Q, MOVE_LIMIT_Q);
    return true;
  }
  function killSim(sim, cause) {
    sim.dead = true;
    sim.deathFrame = sim.frames;
    sim.deathCause = cause;
  }
  function landSim(sim) {
    const d = makeStepData(sim.step, sim.seed);
    const x = sim.xQ / POSITION_SCALE;
    const offset = movingStepOffset(d, sim.frames);
    sim.landX = x - offset;
    if (Math.abs(x - offset) > SAFE_HALF_WIDTH) { killSim(sim, 'fall'); return; }
    for (let k = 0; k < d.spikes.length; k++) {
      if (Math.abs(x - (d.spikes[k] + offset)) < SPIKE_HIT_RADIUS) { killSim(sim, 'spike'); return; }
    }
    let gain = 1;
    if (d.padX !== null && Math.abs(x - (d.padX + offset)) < PAD_HIT_RADIUS) {
      sim.combo = Math.min(COMBO_MAX, sim.combo + 1);
      gain = sim.combo;
      sim.perfects++;
      if (sim.combo > sim.bestCombo) sim.bestCombo = sim.combo;
    } else sim.combo = 0;
    sim.score += gain;
    sim.landGain = gain;
    sim.landings++;
    if (d.gemX !== null && Math.abs(x - (d.gemX + offset)) < GEM_HIT_RADIUS) {
      sim.gems++;
      sim.score += GEM_POINTS;
      sim.landGem = 1;
    }
  }
  // One fixed 1/60 s step. The ball eases toward its target (a whole number of
  // thousandths, Math.trunc of 65% of the gap) and bounces onto the next stair
  // when the bounce clock runs out.
  function stepSim(sim) {
    if (sim.dead) return;
    sim.landed = 0; sim.landGain = 0; sim.landGem = 0;
    sim.frames++;
    const delta = sim.targetQ - sim.xQ;
    sim.xQ += delta === 0 ? 0 : (Math.abs(delta) <= 2 ? delta : Math.trunc(delta * 0.65));
    sim.bounceFrame++;
    if (sim.bounceFrame >= bounceFramesForStep(sim.step)) {
      sim.bounceFrame = 0;
      sim.step++;
      sim.landed = 1;
      landSim(sim);
    }
  }
  // ==== END RULES BLOCK ====

// ── server-only bounds ──────────────────────────────────────────────────
//
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// One sample per step for an hour is 216,000. A little above it, so no honest
// trace can reach it; it REFUSES further input, never zeroes a run.
const MAX_INPUTS = 220000;

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing would
// apply a malformed step as if it were real.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}
function isTarget(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= -MOVE_LIMIT_Q && v <= MOVE_LIMIT_Q;
}

// ── the raw material the bot detector reads (recorded, never gated) ─────
// A hand and a planner differ in HOW they get through, not what they score:
//  - land*: where on the pad the ball came down (distance from the pad centre,
//    in thousandths). A planner lands dead centre; a hand scatters.
//  - stroke*: runs of steps in which the target moved, their length and speed.
//  - reversalsPerLanding: a hand overshoots and comes back.
function newStats() {
  return {
    landN: 0, landSum: 0, landSq: 0, centred: 0,
    moveSteps: 0, strokeN: 0, curDir: 0, curLen: 0, curDist: 0,
    strokeLenSum: 0, strokeLenSq: 0, strokeSpdSum: 0, strokeSpdSq: 0, reversals: 0,
    lastTarget: 0,
  };
}
function closeStroke(st) {
  if (st.curLen > 0) {
    st.strokeN++;
    st.strokeLenSum += st.curLen; st.strokeLenSq += st.curLen * st.curLen;
    const spd = st.curDist / st.curLen;
    st.strokeSpdSum += spd; st.strokeSpdSq += spd * spd;
  }
  st.curDir = 0; st.curLen = 0; st.curDist = 0;
}
function sdOf(n, sum, sq) {
  if (n < 2) return null;
  const m = sum / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

// One step, watched. The accounting reads the run and never writes it.
function stepWatch(state) {
  const sim = state.sim;
  const st = state.stats;
  const dq = sim.targetQ - st.lastTarget;
  st.lastTarget = sim.targetQ;
  if (dq === 0) closeStroke(st);
  else {
    st.moveSteps++;
    const dir = dq < 0 ? -1 : 1;
    if (st.curDir !== 0 && dir !== st.curDir) { st.reversals++; closeStroke(st); }
    st.curDir = dir; st.curLen++; st.curDist += dq < 0 ? -dq : dq;
  }
  stepSim(sim);
  if (sim.landed === 1 && !sim.dead && sim.combo > 0) {
    const d = makeStepData(sim.step, sim.seed);
    const off = Math.abs(sim.landX - d.padX) * POSITION_SCALE;
    st.landN++; st.landSum += off; st.landSq += off * off;
    if (off < 60) st.centred++;
  }
}

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepWatch(state);
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0,
    rejectCount: 0,
    score: 0,
    dead: false,
    lastStep: 0,
    stats: newStats(),
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function died(state) {
  state.dead = true;
  state.score = state.sim.score;
  return { accepted: false, newScore: state.score, reason: 'dead' };
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= MIN_REPLAY_VERSION && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, Math.min(RULES_VERSION, Number(payload.v)));
    }
    return { accepted: true, newScore: state.score };
  }

  // No marker at or above MIN_REPLAY_VERSION, no replay, no score.
  if (state.mode !== 'sim' || kind !== 'path') return { accepted: true, newScore: state.score };
  return processPath(state, payload);
}

// { kind: 'path', f, x: [...] }: x[i] is the ball's target during step
// f+1+i. POSITIONAL and dense, validated whole BEFORE any of it is applied,
// so a batch that would stop half way can never leave the replay in a state
// the game never had.
function processPath(state, payload) {
  const f = payload.f;
  const xs = payload.x;
  if (!isStep(f) || !Array.isArray(xs) || xs.length === 0 || xs.length > PATH_BATCH_MAX) {
    return reject(state, 'bad_batch');
  }
  // Batches never overlap and never rewind: a rewind would let an attacker
  // re-run the same window and keep the best outcome.
  if (f < state.lastStep) return reject(state, 'frame_regressed');
  if (f >= MAX_SIM_STEPS) return reject(state, 'too_late');
  for (let i = 0; i < xs.length; i++) {
    if (!isTarget(xs[i])) return reject(state, 'bad_sample');
  }
  if (state.inputCount + xs.length > MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount += xs.length;
  state.lastStep = f + xs.length;

  const sim = state.sim;
  advanceTo(state, f);
  for (let i = 0; i < xs.length; i++) {
    if (sim.dead || sim.frames >= MAX_SIM_STEPS) break;
    steerSim(sim, xs[i]);
    stepWatch(state);
  }
  if (sim.dead) return died(state);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always dies inside this bound. Only the
// submit replay passes elapsedSecs; the live stream keeps the session bound.
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
  const st = state.stats;
  // Run the world out past the last input, with the target where the trace
  // left it. A still ball meets a spike or a moving stair within a minute.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepWatch(state);
    guard++;
  }
  closeStroke(st);
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame, deathCause: sim.deathCause,
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      step: sim.step, landings: sim.landings, perfects: sim.perfects, gems: sim.gems, version: sim.version,
      // Not gated. Raw material for the bot fingerprint.
      fingerprint: {
        drops: st.landN,
        perfectRate: sim.landings > 0 ? sim.perfects / sim.landings : null,
        perfectStreakMax: sim.bestCombo,
        meanErr: st.landN > 0 ? st.landSum / st.landN : null,
        sdErr: sdOf(st.landN, st.landSum, st.landSq),
        centredShare: st.landN > 0 ? st.centred / st.landN : null,
        strokes: st.strokeN,
        strokeLenMean: st.strokeN > 0 ? st.strokeLenSum / st.strokeN : null,
        strokeLenSd: sdOf(st.strokeN, st.strokeLenSum, st.strokeLenSq),
        strokeSpdMean: st.strokeN > 0 ? st.strokeSpdSum / st.strokeN : null,
        strokeSpdSd: sdOf(st.strokeN, st.strokeSpdSum, st.strokeSpdSq),
        reversalsPerLanding: sim.landings > 0 ? st.reversals / sim.landings : null,
        moveFrac: sim.frames > 0 ? st.moveSteps / sim.frames : null,
      },
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
    initSim, stepSim, steerSim, killSim, landSim, makeStepData, movingStepOffset,
    bounceFramesForStep, seedNumber, hash01, shuffledGrid, advanceTo, stepWatch,
    MAX_INPUTS, MAX_SIM_STEPS, PATH_BATCH_MAX, RULES_VERSION, MIN_REPLAY_VERSION,
    POSITION_SCALE, GRID, SAFE_HALF_WIDTH, SPIKE_HIT_RADIUS, PAD_HIT_RADIUS, GEM_HIT_RADIUS,
    MOVE_LIMIT_Q, MOVE_AMPLITUDE, BOUNCE_MAX, BOUNCE_MIN, BOUNCE_RAMP, COMBO_MAX, GEM_POINTS,
  },
};
