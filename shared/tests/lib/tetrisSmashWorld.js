'use strict';

/**
 * Shared by the Tetris Smash suites: the WHOLE world after a step as one string
 * (all 220 cells, the piece, the bag position, every timer and counter, the
 * score and the step's events), and an independent server-side replay that
 * records it after EVERY step, built from the validator's own rules functions
 * in the client's order: beginStep, then the acts that name this step, then
 * stepSim.
 */
const crypto = require('crypto');
const V = require('../../anticheat/validators/tetrisSmash');
const S = V._sim;

function worldOf(sim) {
  return JSON.stringify({
    frame: sim.frame, n: sim.n, k: sim.k, seed: sim.seed, board: sim.board.join(''), cur: sim.cur,
    gc: sim.gc, lockT: sim.lockT, resets: sim.resets, soft: sim.soft, wait: sim.wait,
    score: sim.score, lines: sim.lines, level: sim.level, combo: sim.combo, b2b: sim.b2b,
    dead: sim.dead, end: sim.end, ev: sim.ev,
  });
}

function actsOf(trace) {
  return trace.filter((e) => e.payload && e.payload.kind === 'act').map((e) => ({ n: e.payload.n, a: e.payload.a, step: e.payload.step }));
}

// Replays a schedule on the validator's rules, recording the world after every step.
function serverWorlds(seedHex, schedule, opts = {}) {
  const limit = opts.limit || S.MAX_SIM_STEPS;
  const sim = S.initSim(S.seedToInt(seedHex));
  const worlds = [];
  let i = 0;
  while (!sim.dead && sim.frame < limit) {
    S.beginStep(sim);
    while (i < schedule.length && schedule[i].step < sim.frame) i++;
    while (i < schedule.length && schedule[i].step === sim.frame && !sim.dead) {
      const t = schedule[i++];
      if (t.n === sim.n) S.actSim(sim, t.a);
    }
    if (sim.dead) break;
    S.stepSim(sim);
    worlds[sim.frame] = worldOf(sim);
  }
  return { sim, worlds };
}

function digest(worlds) {
  const h = crypto.createHash('sha256');
  for (let i = 1; i < worlds.length; i++) if (worlds[i] !== undefined) h.update(i + ':' + worlds[i] + '\n');
  return h.digest('hex').slice(0, 16);
}

function trace(schedule, v = 2) {
  return [{ type: 'input', payload: { kind: 'start', v } }]
    .concat(schedule.map((t) => ({ type: 'input', payload: { kind: 'act', n: t.n, a: t.a, step: t.step } })));
}

// A golden run stores its acts as a flat [a, step, a, step, ...] list; the
// index n of each act is its position.
function unflat(flat) { const out = []; for (let i = 0; i < flat.length; i += 2) out.push({ n: i / 2, a: flat[i], step: flat[i + 1] }); return out; }

module.exports = { worldOf, actsOf, serverWorlds, digest, trace, unflat };
