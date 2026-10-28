'use strict';
// Regenerates shared/tests/fixtures/rangBharoGolden.json. Only when the rules
// change on purpose, together with a trace version bump (and then into a new
// file: the v1 file stays frozen).
//   node shared/tests/lib/rangBharoGoldenGen.js
const fs = require('fs');
const path = require('path');
const H = require('./rangBharoRealGame');
const W = require('./rangBharoWorld');

const runs = [];
const plan = [['flawless', 2], ['good', 3], ['average', 4], ['novice', 5], ['bot', 6], ['greedy', 7], ['spammer', 8], ['idle', 9], ['cycler', 10], ['good', 11]];
for (const [pilot, i] of plan) {
  const seed = H.seedHex(9000 + i);
  const g = H.boot({ seed });
  H.fly(g, pilot, { rngSeed: i });
  const schedule = W.movesOf(g.trace);
  const { sim, worlds } = W.serverWorlds(seed, schedule, { version: 1 });
  runs.push({ pilot, seed, schedule, score: sim.score, mazes: sim.mazes, perfects: sim.perfects, digest: W.digest(worlds) });
  console.log(pilot, seed, sim.score, sim.mazes, sim.perfects, schedule.length);
}
fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'rangBharoGolden.json'), JSON.stringify({ version: 1, runs }) + '\n');
