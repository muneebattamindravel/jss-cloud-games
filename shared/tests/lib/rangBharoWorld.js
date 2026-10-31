'use strict';

/**
 * Shared by the Rang Bharo suites: the whole world after a step as one string,
 * and an independent server-side replay that records it after EVERY step,
 * built from the validator's own rules functions in the validator's order
 * (a move { n, dir, step } is applied before step `step + 1`).
 */
const crypto = require('crypto');
const V = require('../../anticheat/validators/rangBharo');
const S = V._sim;

function worldOf(sim) {
  const m = sim.maze;
  return JSON.stringify({
    v: sim.v, seed: sim.seed, step: sim.step, over: sim.over, inputs: sim.inputs, score: sim.score,
    n: sim.n, moves: sim.moves, mazes: sim.mazes, perfects: sim.perfects, tiles: sim.tiles, totalMoves: sim.totalMoves,
    left: sim.left, bx: sim.bx, by: sim.by, dir: sim.dir, sub: sim.sub, queued: sim.queued, pause: sim.pause,
    lastInput: sim.lastInput, ev: sim.ev, painted: Array.from(sim.painted).join(''),
    maze: { w: m.w, h: m.h, start: m.start, floors: m.floors, par: m.par, designed: m.designed, exact: m.exact, cells: Array.from(m.cells).join(''), path: m.path.join('') },
  });
}

function movesOf(trace) {
  return trace.filter((e) => e.payload && e.payload.kind === 'move').map((e) => ({ n: e.payload.n, dir: e.payload.dir, step: e.payload.step }));
}
function traceOf(schedule, v = 1) {
  return [{ type: 'input', payload: { kind: 'start', v } }].concat(schedule.map((t) => ({ type: 'input', payload: { kind: 'move', n: t.n, dir: t.dir, step: t.step } })));
}

// Replays a schedule on the validator's rules, recording the world after every step.
function serverWorlds(seed, schedule, opts = {}) {
  const limit = opts.limit || S.MAX_SIM_STEPS;
  const sim = S.initSim(seed, opts.version || 1);
  const worlds = [];
  const record = opts.record !== false;
  const step = () => { S.stepSim(sim); if (record) worlds[sim.step] = worldOf(sim); };
  for (const t of schedule) {
    while (!sim.over && sim.step < t.step && sim.step < limit) step();
    if (sim.over) break;
    if (sim.step === t.step && t.n === sim.inputs) S.inputDir(sim, t.dir);
  }
  while (!sim.over && sim.step < limit) step();
  return { sim, worlds };
}

function digest(worlds) {
  const h = crypto.createHash('sha256');
  for (let i = 1; i < worlds.length; i++) if (worlds[i] !== undefined) h.update(i + ':' + worlds[i] + '\n');
  return h.digest('hex').slice(0, 16);
}

module.exports = { worldOf, movesOf, traceOf, serverWorlds, digest };
