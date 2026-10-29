'use strict';

/**
 * Writes shared/tests/fixtures/smashItGolden.json: the pinned rules block hash,
 * the constants pinned by value, and golden runs (fixed shot schedules with a
 * world digest every 300 steps and the validator's score).
 *
 * Run ONLY when the rules change on purpose (and RULES_VERSION goes up):
 *   node shared/tests/lib/smashItGoldenGen.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const V = require('../../anticheat/validators/smashIt');
const W = require('./smashItWorld');
const H = require('./smashItRealGame');

const BEGIN = '// ==== SMASH IT RULES BEGIN ====';
const END = '// ==== SMASH IT RULES END ====';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  if (process.argv.length > 2) { console.error('unknown flag ' + process.argv[2]); process.exit(2); }
  await V.ready;
  const X = V._sim;
  const src = fs.readFileSync(W.RULES, 'utf8');
  const out = {
    rulesVersion: X.RULES_VERSION,
    blockHash: sha(src.slice(src.indexOf(BEGIN), src.indexOf(END))),
    pins: {
      gap: [X.SHOT_GAP, X.PIERCE, X.CARRY_CAP],
      obstacles: [X.BOMB_R, X.BOMB_PUSH, X.PEND_LEN, X.PEND_R, X.PEND_Z, X.SHIELD_W, X.SHIELD_H, X.SHIELD_Z, X.FAN_LEN, X.FAN_HALF, X.FAN_Z],
      designs: sha(JSON.stringify(X.DESIGNS)),
      sinq: sha(JSON.stringify(Array.from(X.SINQ))),
      hashes: [X.seedToInt('0123456789abcdef0123456789abcdef'), X.seedToInt(''), X.hash(1, 2, 3), X.hash(0xdeadbeef, 40, 7)],
      plans: (() => { const p = []; for (let L = 1; L <= 24; L++) p.push(JSON.stringify(X.obstaclePlan(12345, L, !!X.isBoss(L)))); return sha(p.join('|')); })(),
    },
    runs: [],
  };
  const specs = [[1, 1, 1], [2, 2, 1], [3, 3, 1], [4, 1, 9], [5, 2, 16], [6, 3, 24]];
  for (const [i, rng, level] of specs) {
    const seedHex = H.seedHex(500 + i);
    const seed = X.seedToInt(seedHex);
    const o = W.corpusRun(X, seed, level, { rng, steps: 1800 });
    const worlds = W.serverWorlds(seed, o.shots, o.worlds.length, level);
    const marks = [];
    for (let k = 299; k < worlds.length; k += 300) marks.push([k, W.digest(worlds[k])]);
    marks.push([worlds.length - 1, W.digest(worlds[worlds.length - 1])]);
    const run = { seed, level, steps: o.worlds.length, shots: o.shots, marks, clientScore: o.score };
    if (level === 1) {
      const ev = [{ type: 'input', payload: { kind: 'start', v: 1 } }].concat(o.shots.map((p) => ({ type: 'input', payload: p })));
      run.seedHex = seedHex;
      run.score = V.simulate(seedHex, ev);
    }
    out.runs.push(run);
    console.log('run', i, 'level', level, 'shots', o.shots.length, 'score', o.score, run.score === undefined ? '' : 'validator ' + run.score);
  }
  fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'smashItGolden.json'), JSON.stringify(out, null, 1) + '\n');
})();
