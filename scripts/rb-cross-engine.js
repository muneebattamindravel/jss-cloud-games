'use strict';
// Cross-engine probe (handbook 8.7): the rules block, fed the golden runs'
// move schedules, must hash identically in headless Chrome and in Node.
//   NODE_PATH=$(npm root -g) node scripts/rb-cross-engine.js
const fs = require('fs'), path = require('path');
const game = fs.readFileSync(path.join(__dirname, '..', 'games', 'rang-bharo', 'js', 'game.js'), 'utf8');
const block = game.slice(game.indexOf('// ==== RANG BHARO RULES BEGIN ===='), game.indexOf('// ==== RANG BHARO RULES END ===='));
const runs = require('../shared/tests/fixtures/rangBharoGolden.json').runs;
// Runs in either engine: replays every schedule, hashing the world after every step.
const PROBE = `(function (runs) {
${block}
  function fnv(h, s) { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h; }
  return runs.map((r) => {
    const sim = initSim(r.seed, 1); let h = 2166136261;
    const step = () => { stepSim(sim); h = fnv(h, sim.step + ':' + sim.score + ':' + sim.bx + ',' + sim.by + ':' + sim.dir + ':' + sim.sub + ':' + sim.queued + ':' + sim.pause + ':' + sim.n + ':' + sim.left + ':' + Array.from(sim.painted).join('')); };
    for (const t of r.schedule) { while (!sim.over && sim.step < t.step) step(); if (sim.over) break; if (sim.step === t.step && t.n === sim.inputs) inputDir(sim, t.dir); }
    while (!sim.over) step();
    return { score: sim.score, hash: h };
  });
})`;
(async () => {
  const node = eval(PROBE)(runs);
  const { chromium } = require('playwright');
  const b = await chromium.launch(); const p = await b.newPage();
  const chrome = await p.evaluate(([src, rr]) => (0, eval)(src)(rr), [PROBE, runs]);
  await b.close();
  let same = 0;
  node.forEach((x, i) => { const ok = x.hash === chrome[i].hash && x.score === chrome[i].score && x.score === runs[i].score; if (ok) same++; console.log(runs[i].pilot.padEnd(9), x.score, x.hash.toString(16), chrome[i].hash.toString(16), ok ? 'same' : 'DIFFERENT'); });
  console.log(`${same}/${runs.length} runs hash identically in Node and Chrome`);
  process.exit(same === runs.length ? 0 : 1);
})();
