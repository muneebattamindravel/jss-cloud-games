'use strict';
// Regenerates shared/tests/fixtures/pearlsConnectGolden.json (rules v2). Only
// when the rules change on purpose, together with a trace version bump; the
// old file then stays frozen beside the new one.
//   node shared/tests/lib/pearlsConnectGoldenGen.js
const fs = require('fs');
const path = require('path');
const H = require('./pearlsConnectRealGame');
const W = require('./pearlsConnectWorld');

const runs = [];
const plan = [['flawless', 2], ['good', 3], ['average', 4], ['novice', 5], ['spammer', 6], ['idle', 7], ['good', 8], ['multi', 9]];
for (const [pilot, i] of plan) {
  const seed = H.seedHex(9000 + i);
  const g = H.boot({ seed });
  H.fly(g, pilot, { rngSeed: i });
  const schedule = W.chainsOf(g.trace).map((p) => ({ n: p.n, step: p.step, down: p.down, cells: p.cells }));
  const { sim, worlds } = W.serverWorlds(seed, schedule);
  let loops = 0;
  for (const t of schedule) if (t.cells.indexOf(t.cells[t.cells.length - 1]) < t.cells.length - 1) loops++;
  runs.push({ pilot, seed, schedule, score: sim.score, chains: sim.chains, shuffles: sim.shuffles, loops, digest: W.digest(worlds) });
  console.log(pilot, seed, sim.score, sim.chains, 'shuffles', sim.shuffles, 'loops', loops);
}
fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'pearlsConnectGolden.json'), JSON.stringify({ version: 2, runs }) + '\n');
