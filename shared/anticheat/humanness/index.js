'use strict';

/**
 * kj-shared/anticheat/humanness
 *
 * The humanness fingerprint: score-independent measures of HOW a run was
 * played, a population envelope per game, a personal baseline per player,
 * and a verdict that combines them. Pure functions only; storage, queues
 * and actions live in game-service (services/humannessService.js).
 */
const stats = require('./stats');
const { extractFeatures, GAME_INPUTS } = require('./features');
const verdict = require('./verdict');

// Build { feature: envelope } from an array of feature objects (honest runs).
function buildEnvelope(featureRows) {
  const keys = new Set();
  for (const f of featureRows) for (const k of Object.keys(f)) if (typeof f[k] === 'number') keys.add(k);
  const out = { __n: featureRows.length };
  for (const k of keys) {
    const env = stats.envelopeOf(featureRows.map((f) => f[k]));
    if (env) out[k] = env;
  }
  return out;
}

// Fold one run's features into a player's baseline {n, stats:{feat:{n,mean,m2}}}.
function updateBaseline(baseline, features) {
  const b = baseline ? { n: baseline.n || 0, stats: Object.assign({}, baseline.stats || {}) } : { n: 0, stats: {} };
  for (const k of verdict.BASELINE_FEATURES) {
    const x = features[k];
    if (x === null || x === undefined || !Number.isFinite(x)) continue;
    b.stats[k] = stats.welfordAdd(b.stats[k], x);
  }
  b.n += 1;
  return b;
}

module.exports = Object.assign({ extractFeatures, GAME_INPUTS, buildEnvelope, updateBaseline, stats }, verdict);
