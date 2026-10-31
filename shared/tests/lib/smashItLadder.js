#!/usr/bin/env node
'use strict';

/**
 * Smash It difficulty ladder and the max_score_per_sec derivation.
 *
 * Flies the REAL page with each pilot over N seeds and prints the median run
 * length, level reached and score (with the 25th and 75th percentiles), then
 * the sharpshooter's best 60 s window of score (a run shorter than 60 s counts
 * whole).
 *
 *   node shared/tests/lib/smashItLadder.js            (12 seeds)
 *   node shared/tests/lib/smashItLadder.js --seeds 30
 *   node shared/tests/lib/smashItLadder.js --pilot patient
 *
 * An unknown flag exits 2.
 */
const H = require('./smashItRealGame');

const PILOTS = ['idle', 'spammer', 'novice', 'average', 'good', 'sharpshooter', 'patient'];
const WINDOW = 60 * 60;

function pct(xs, p) { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; }

async function ladder(nSeeds) {
  let peak = 0, peakSeed = null;
  console.log('| pilot | median secs | median level | score p25 / median / p75 | best |');
  console.log('|---|---|---|---|---|');
  for (const pilot of PILOTS) {
    const runs = [];
    for (let i = 0; i < nSeeds; i++) {
      const seed = H.seedHex(5000 + i);
      const g = await H.boot({ seed });
      const scoreAt = [0];
      g.win.__onStep = (S) => { scoreAt[S.step] = S.score; };
      const r = H.fly(g, pilot, { maxSteps: 144000, rngSeed: 100 + i });
      runs.push({ secs: r.step / 60, score: r.score, level: r.level });
      for (let t = 1; t < scoreAt.length; t++) if (scoreAt[t] === undefined) scoreAt[t] = scoreAt[t - 1];
      for (let t = 1; t < scoreAt.length; t++) {
        const w = scoreAt[t] - scoreAt[Math.max(0, t - WINDOW)];
        if (w > peak) { peak = w; peakSeed = seed + ' (' + pilot + ')'; }
      }
    }
    const sc = runs.map((r) => r.score);
    console.log(`| ${pilot} | ${pct(runs.map((r) => r.secs), 0.5).toFixed(1)} | ${pct(runs.map((r) => r.level), 0.5)} | ${pct(sc, 0.25)} / ${pct(sc, 0.5)} / ${pct(sc, 0.75)} | ${Math.max(...sc)} |`);
  }
  console.log(`\nbest 60 s window: ${peak} points (${(peak / 60).toFixed(3)} a second), seed ${peakSeed}`);
  console.log(`max_score_per_sec = ceil(3 x ${(peak / 60).toFixed(3)}) = ${Math.ceil(3 * peak / 60)}`);
}

const args = process.argv.slice(2);
let n = 12;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seeds') n = Number(args[++i]);
  else if (args[i] === '--pilot') PILOTS.splice(0, PILOTS.length, args[++i]);
  else { console.error('unknown argument: ' + args[i]); process.exit(2); }
}
if (!(n >= 1)) { console.error('--seeds needs a number'); process.exit(2); }
ladder(n);
