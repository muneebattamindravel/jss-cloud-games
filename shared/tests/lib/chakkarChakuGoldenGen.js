'use strict';
// Regenerates shared/tests/fixtures/chakkarChakuGolden.v3.json (the v2 file is frozen). Only when the rules
// change on purpose, together with a trace version bump.
//   node shared/tests/lib/chakkarChakuGoldenGen.js
const fs = require('fs');
const path = require('path');
const H = require('./chakkarChakuRealGame');
const W = require('./chakkarChakuWorld');

const runs = [];
const plan = [['flawless', 2, 60 * 90], ['good', 3, 60 * 600], ['average', 4, 60 * 600], ['novice', 5, 60 * 600],
  ['spammer', 6, 60 * 600], ['idle', 7, 60 * 600], ['flawless', 8, 60 * 240], ['good', 9, 60 * 600]];
for (const [pilot, i, maxSteps] of plan) {
  const seed = H.seedHex(9000 + i);
  const g = H.boot({ seed });
  H.fly(g, pilot, { maxSteps, rngSeed: i });
  const schedule = W.throwsOf(g.trace).map((p) => ({ n: p.n, step: p.step }));
  const { sim, worlds } = W.serverWorlds(seed, schedule, { version: 3 });
  runs.push({ pilot, seed, schedule, score: sim.score, deathStep: sim.deathStep, cause: sim.cause, log: sim.log, digest: W.digest(worlds) });
  console.log(pilot, seed, sim.score, sim.deathStep, sim.cause, schedule.length);
}
fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'chakkarChakuGolden.v3.json'), JSON.stringify({ version: 3, runs }, null, 1) + '\n');
