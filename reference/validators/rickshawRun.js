'use strict';

/**
 * Rickshaw Run validator: full server-side deterministic REPLAY (trace v2).
 *
 * Saad's rebuild (Oct 2026) follows the platform's game rules: a fixed 1/60 s
 * step, a course built from the session seed (index-addressed mulberry32
 * streams, one per patch, truck course, spawn and power-up), and inputs that
 * are queued and applied at the start of a step, at most one per step. The
 * rules are the game's OWN files, copied verbatim into shared/anticheat/rickshaw
 * and run headless (see engine.js); rickshawRunParity.test.js fails if the
 * copies and games/rickshaw-run/js ever differ. What the client claims is never
 * read: the server re-runs the whole run and scores it itself.
 *
 * The trace:
 *   { kind: 'start', v: 2, z, lane, coins, tHint }
 *        the run's start. A run that follows the tutorial starts mid-road, so
 *        the whole metre (z) and lane it starts on are recorded. z is an
 *        integer, lane 0..2. Coins can only add points, so `coins: false` is
 *        accepted (it can only lower a score).
 *   { kind: 'in', n, k, step, tHint }
 *        one input the game applied: k is L, R, U or D, `step` the fixed step it
 *        was applied on, n its index. Steps strictly increase (the game applies
 *        at most one input per step).
 * Refusals (malformed, out of order, rewound, past the input cap) never zero a
 * run. No start marker means no replay and no score.
 *
 * NOBODY PARKS: an untouched rickshaw crashes within seconds (worst measured
 * in rickshawRunParity), so a run can never outlive the session. The run-out
 * is still bounded by the session's real length (elapsedCap).
 */

const Engine = require('../rickshaw/engine');

const RULES_VERSION = 2;
const FPS = 60;
const MAX_SIM_STEPS = 60 * 60 * 60;            // one session hour of fixed steps
const MAX_INPUTS = 40000;                      // a work bound, ~11 inputs a second for the hour
const MAX_START_Z = 1000000;
const KEYS = new Set(['L', 'R', 'U', 'D']);
const LANES = [-2.4, 0, 2.4];

function isStep(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_SIM_STEPS; }

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    seed: seed == null ? null : String(seed),
    start: null, keys: [],
    inputCount: 0, rejectCount: 0, score: 0,
    lastStep: -1, nextN: 0,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function processEvent(state, event) {
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};
  if (p.kind === 'start') {
    if (state.mode === 'sim' || p.v !== RULES_VERSION) return { accepted: true, newScore: state.score };
    if (!/^[0-9a-fA-F]{8,}$/.test(state.seed || '')) return reject(state, 'bad_seed');
    const z = p.z, lane = p.lane;
    if (!Number.isInteger(z) || Math.abs(z) > MAX_START_Z || ![0, 1, 2].includes(lane)) return reject(state, 'bad_start');
    state.mode = 'sim';
    state.start = { z, lane, coins: p.coins !== false };
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim' || p.kind !== 'in') return { accepted: true, newScore: state.score };
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  if (!KEYS.has(p.k) || !isStep(p.step) || p.n !== state.nextN) return reject(state, 'bad_input');
  if (p.step <= state.lastStep) return reject(state, 'step_regressed');
  state.inputCount++;
  state.nextN++;
  state.lastStep = p.step;
  state.keys.push([p.step, p.k]);
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always ends inside this bound.
function elapsedCap(state) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * FPS);
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }

// Run the whole trace. Returns the finished game plus the bot-detector notes.
function replay(state) {
  const { RR, game } = Engine.createGame();
  const notes = { steps: [], ahead: [], needless: 0, keys: { L: 0, R: 0, U: 0, D: 0 } };
  // Recorded, never gated: at each input, how far ahead the nearest obstacle in
  // the rickshaw's lane was (metres), and whether the lane was clear anyway. A
  // program reacts at a fixed distance; a thumb scatters and overreacts.
  game.onTraceInput = (step, k) => {
    notes.steps.push(step);
    notes.keys[k]++;
    const p = game.player;
    let best = Infinity;
    for (const o of game.obstacles) {
      if (o.flyT >= 0 || !(o.z < p.z)) continue;
      const lane = LANES.findIndex((x) => Math.abs(o.x - x) < ((o.spec && o.spec.hw) || 1) + 0.7);
      if (lane !== -1 && Math.abs(LANES[lane] - p.x) > 1.3) continue;
      best = Math.min(best, p.z - o.z);
    }
    if (best === Infinity) notes.needless++; else notes.ahead.push(best);
  };
  game.startRun(state.seed, state.keys, state.start);
  const cap = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * FPS), elapsedCap(state));
  let guard = 0;
  while ((game.state === 'playing' || game.state === 'dying') && game.stepIndex < cap && guard++ < MAX_SIM_STEPS + 1000) {
    game.update(RR.STEP);
  }
  return { game, notes };
}

function finalize(state) {
  if (state.mode !== 'sim') return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const { game, notes } = replay(state);
  const gaps = [];
  for (let i = 1; i < notes.steps.length; i++) gaps.push(notes.steps[i] - notes.steps[i - 1]);
  const gm = mean(gaps), gs = sd(gaps);
  state.score = game.score;
  return {
    score: game.score,
    gameOver: game.state === 'dying' || game.state === 'gameover',
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', version: RULES_VERSION, steps: game.stepIndex, state: game.state,
      score: game.score, dist: Math.floor(game.dist), coins: game.coins, patches: game.patchCount,
      inputs: state.inputCount, rejects: state.rejectCount, keys: notes.keys,
      aheadMean: round3(mean(notes.ahead)), aheadSd: round3(sd(notes.ahead)),
      needlessShare: notes.steps.length ? round3(notes.needless / notes.steps.length) : null,
      gapCv: gm > 0 && gs !== null ? round3(gs / gm) : null,
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
  _sim: { RULES_VERSION, MAX_INPUTS, MAX_SIM_STEPS, Engine, replay },
};
