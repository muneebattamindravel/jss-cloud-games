#!/usr/bin/env node
'use strict';

/**
 * Tetris Smash difficulty ladder and the max_score_per_sec derivation.
 *
 * Flies the REAL game with each pilot over N seeds and prints the median run
 * length and score (with the 25th and 75th percentiles, because the spread is
 * the point), then the flawless planner's best 60 s window of score.
 *
 *   node shared/tests/lib/tetrisSmashLadder.js            (20 seeds)
 *   node shared/tests/lib/tetrisSmashLadder.js --seeds 40
 *
 * An unknown flag exits 2.
 */
const H = require('./tetrisSmashRealGame');

const PILOTS = ['idle', 'spammer', 'novice', 'average', 'good', 'flawless'];
const WINDOW = 60 * 60;   // 60 s of steps

function pct(xs, p) { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; }

function ladder(nSeeds) {
  const rows = [];
  let peak = 0, peakSeed = null;
  for (const pilot of PILOTS) {
    const runs = [];
    for (let i = 0; i < nSeeds; i++) {
      const seed = H.seedHex(5000 + i);
      const g = H.boot({ seed });
      const scoreAt = [0];
      g.win.__onStep = (sim) => { scoreAt[sim.frame] = sim.score; };
      const r = H.fly(g, pilot, { maxSteps: 60 * 300, rngSeed: 100 + i });
      runs.push({ secs: r.frame / 60, score: r.score, lines: r.lines, full: r.end === 'time' });
      if (pilot === 'flawless') {
        for (let t = 1; t < scoreAt.length; t++) if (scoreAt[t] === undefined) scoreAt[t] = scoreAt[t - 1];
        for (let t = WINDOW; t < scoreAt.length; t++) {
          const w = scoreAt[t] - scoreAt[t - WINDOW];
          if (w > peak) { peak = w; peakSeed = seed; }
        }
      }
    }
    rows.push({
      pilot, seeds: nSeeds,
      secs: { p25: pct(runs.map((r) => r.secs), 0.25), med: pct(runs.map((r) => r.secs), 0.5), p75: pct(runs.map((r) => r.secs), 0.75) },
      score: { p25: pct(runs.map((r) => r.score), 0.25), med: pct(runs.map((r) => r.score), 0.5), p75: pct(runs.map((r) => r.score), 0.75) },
      lines: pct(runs.map((r) => r.lines), 0.5), full: runs.filter((r) => r.full).length,
    });
  }
  const perSec = peak / 60;
  return { rows, flawlessPeak60s: peak, peakSeed, perSec: Math.round(perSec * 1000) / 1000, maxScorePerSec: Math.ceil(3 * perSec) };
}

function main() {
  const args = process.argv.slice(2);
  let n = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seeds') n = Number(args[++i]);
    else { console.error(`unknown argument: ${args[i]}`); process.exit(2); }
  }
  if (!(n >= 1)) { console.error('--seeds needs a number'); process.exit(2); }
  const out = ladder(n);
  const f = (x) => String(Math.round(x)).padStart(8);
  console.log('pilot        med s   p25 s   p75 s   med score   p25 score   p75 score  lines  full');
  for (const r of out.rows) {
    console.log(r.pilot.padEnd(10), f(r.secs.med), f(r.secs.p25), f(r.secs.p75), f(r.score.med).padStart(11), f(r.score.p25).padStart(11), f(r.score.p75).padStart(11), String(r.lines).padStart(6), `${r.full}/${r.seeds}`.padStart(6));
  }
  console.log(`flawless best 60 s window: ${out.flawlessPeak60s} (${out.perSec}/s, seed ${out.peakSeed})`);
  console.log(`max_score_per_sec = 3 x ${out.perSec} = ${out.maxScorePerSec}`);
  console.log(JSON.stringify(out));
}

if (require.main === module) main();
module.exports = { ladder };
