'use strict';

/**
 * Shared by the Chakkar Chaku suites: the whole world after a step as one string,
 * and an independent server-side replay that records it after EVERY step,
 * built from the validator's own rules functions in the validator's order
 * (a throw { n, step } is applied before step `step + 1`).
 */
const crypto = require('crypto');
const V = require('../../anticheat/validators/chakkarChaku');
const S = V._sim;

function worldOf(sim) {
  return JSON.stringify({
    step: sim.step, throws: sim.throws, score: sim.score, dead: sim.dead, deathStep: sim.deathStep,
    cause: sim.cause, log: sim.log, rot: sim.rot, spd: sim.spd, kfi: sim.kfi, kfLeft: sim.kfLeft,
    stuck: sim.stuck, apples: sim.apples, left: sim.left, fly: sim.fly, trans: sim.trans,
    lastAct: sim.lastAct, events: sim.events, spec: sim.spec,
  });
}

function throwsOf(trace) {
  return trace.filter((e) => e.payload && e.payload.kind === 'throw').map((e) => e.payload);
}

// Replays a schedule on the validator's rules, recording the world after every step.
function serverWorlds(seed, schedule, opts = {}) {
  const limit = opts.limit || S.MAX_SIM_STEPS;
  const sim = S.initSim(seed, opts.version || 3);
  const worlds = [];
  const step = () => { S.stepSim(sim); worlds[sim.step] = worldOf(sim); };
  for (const t of schedule) {
    while (!sim.dead && sim.step < t.step && sim.step < limit) step();
    if (sim.dead) break;
    if (sim.step === t.step && t.n === sim.throws) S.throwSim(sim);
  }
  while (!sim.dead && sim.step < limit) step();
  return { sim, worlds };
}

function digest(worlds) {
  const h = crypto.createHash('sha256');
  for (let i = 1; i < worlds.length; i++) if (worlds[i] !== undefined) h.update(i + ':' + worlds[i] + '\n');
  return h.digest('hex').slice(0, 16);
}

module.exports = { worldOf, throwsOf, serverWorlds, digest };
