'use strict';

/**
 * Shared by the Pearls Connect suites: the whole world after a step as one
 * string, and an independent server-side replay that records it after EVERY
 * step, built from the validator's own rules functions in the validator's
 * order (a chain { n, step } is applied before step `step + 1`).
 */
const crypto = require('crypto');
const V = require('../../anticheat/validators/pearlsConnect');
const S = V._sim;

function worldOf(sim) {
  return JSON.stringify({
    step: sim.step, score: sim.score, over: sim.over, chains: sim.chains, lastStep: sim.lastStep,
    shuffles: sim.shuffles, seed: sim.seed, version: sim.version,
    grid: sim.grid.join(''), spawned: sim.spawned, events: sim.events,
  });
}

function chainsOf(trace) {
  return trace.filter((e) => e.payload && e.payload.kind === 'chain').map((e) => e.payload);
}

// Replays a schedule on the validator's rules, recording the world after every step.
function serverWorlds(seed, schedule, opts = {}) {
  const limit = opts.limit || S.RUN_STEPS;
  const sim = S.initSim(seed, opts.version || 2);
  const worlds = [];
  const step = () => { S.stepSim(sim); worlds[sim.step] = worldOf(sim); };
  for (const t of schedule) {
    while (!sim.over && sim.step < t.step && sim.step < limit) step();
    if (sim.over) break;
    if (sim.step === t.step && t.n === sim.chains) S.chainSim(sim, t.cells);
  }
  while (!sim.over && sim.step < limit) step();
  return { sim, worlds };
}

function digest(worlds) {
  const h = crypto.createHash('sha256');
  for (let i = 1; i < worlds.length; i++) if (worlds[i] !== undefined) h.update(i + ':' + worlds[i] + '\n');
  return h.digest('hex').slice(0, 16);
}

module.exports = { worldOf, chainsOf, serverWorlds, digest };
