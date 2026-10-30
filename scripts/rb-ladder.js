'use strict';
// The Rang Bharo difficulty ladder: flies the REAL game with every pilot over
// many seeds and reports median and spread, plus the flawless pilot's best
// 60 s window for max_score_per_sec.
//   node scripts/rb-ladder.js [seeds=24] [pilots=comma list]
const H = require('../shared/tests/lib/rangBharoRealGame');
const V = require('../shared/anticheat/validators/rangBharo');
const seeds = +process.argv[2] || 24;
const pilots = (process.argv[3] || 'idle,cycler,spammer,greedy,lazy,novice,average,good,multi,bot,flawless').split(',');
const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const out = {};
let bestWindow = 0;
for (const pilot of pilots) {
  const scores = [], mazes = [], perf = [], wait = [], cvs = [];
  for (let i = 0; i < seeds; i++) {
    const seed = H.seedHex(31000 + i);
    const g = H.boot({ seed });
    const series = [];
    const r = H.fly(g, pilot, { rngSeed: 100 + i, onStep: (s) => { if (s.step % 60 === 0) series[s.step / 60] = s.score; } });
    const st = V.init({ seed, elapsedSecs: 200 }); for (const e of g.trace) V.processEvent(st, e);
    const f = V.finalize(st);
    if (f.score !== r.score) throw new Error(`server ${f.score} != client ${r.score} (${pilot}, seed ${i})`);
    scores.push(r.score); mazes.push(r.mazes); perf.push(r.perfects);
    if (f.debug.waitMean != null) wait.push(f.debug.waitMean); if (f.debug.waitCv != null) cvs.push(f.debug.waitCv);
    if (pilot === 'flawless') {
      series[180] = r.score;
      for (let a = 0; a + 60 <= 180; a++) if (series[a] != null && series[a + 60] != null) bestWindow = Math.max(bestWindow, series[a + 60] - series[a]);
    }
  }
  out[pilot] = { median: q(scores, 0.5), p10: q(scores, 0.1), p90: q(scores, 0.9), mazes: q(mazes, 0.5), perfects: q(perf, 0.5), waitMean: wait.length ? q(wait, 0.5) : null, waitCv: cvs.length ? q(cvs, 0.5) : null };
  console.log(pilot.padEnd(9), JSON.stringify(out[pilot]));
}
if (out.good && out.average) console.log('good / average', (out.good.median / out.average.median).toFixed(2));
if (out.flawless && out.good) console.log('flawless / good', (out.flawless.median / out.good.median).toFixed(2));
if (bestWindow) console.log('flawless best 60 s window', bestWindow, '/60 s =', (bestWindow / 60).toFixed(2), 'per s; x3 =', (3 * bestWindow / 60).toFixed(2));
