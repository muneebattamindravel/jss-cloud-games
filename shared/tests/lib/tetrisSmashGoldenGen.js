'use strict';
// Regenerates shared/tests/fixtures/tetrisSmashGolden.json. Only when the rules
// change on purpose, together with a trace version bump (then write a NEW file
// for the new version and keep this one frozen).
//   node shared/tests/lib/tetrisSmashGoldenGen.js
const fs = require('fs');
const path = require('path');
const H = require('./tetrisSmashRealGame');
const W = require('./tetrisSmashWorld');

const runs = [];
const plan = [['flawless', 2, 60 * 300], ['good', 3, 60 * 300], ['average', 4, 60 * 300], ['novice', 5, 60 * 300],
  ['spammer', 6, 60 * 300], ['idle', 7, 60 * 300], ['good', 8, 60 * 300], ['average', 9, 60 * 300],
  ['builder', 102, 60 * 300], ['builder', 104, 60 * 300], ['fiddler', 12, 60 * 300], ['fiddler', 13, 60 * 300]];
for (const [pilot, i, maxSteps] of plan) {
  const seed = H.seedHex(9000 + i);
  const g = H.boot({ seed });
  H.fly(g, pilot, { maxSteps, rngSeed: i });
  const schedule = W.actsOf(g.trace);
  const { sim, worlds } = W.serverWorlds(seed, schedule);
  const flat = [];
  schedule.forEach((t, j) => { if (t.n !== j) throw new Error('acts out of order'); flat.push(t.a, t.step); });
  runs.push({ pilot, seed, acts: flat, score: sim.score, frame: sim.frame, end: sim.end, lines: sim.lines, level: sim.level, digest: W.digest(worlds) });
  console.log(pilot, seed, sim.score, sim.frame, sim.end, sim.lines, schedule.length);
}
fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'tetrisSmashGolden.json'), JSON.stringify({ version: 2, runs }) + '\n');
