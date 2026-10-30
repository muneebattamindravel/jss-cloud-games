'use strict';
// Measure the Rang Bharo generator: node scripts/rb-measure.js [seeds] [maxN]
const fs = require('fs');
const all = fs.readFileSync(__dirname + '/../games/rang-bharo/js/game.js', 'utf8');
const src = all.slice(all.indexOf('// ==== RANG BHARO RULES BEGIN ===='), all.indexOf('// ==== RANG BHARO RULES END ===='));
const api = new Function(src + '\nreturn { genMaze, slideEnd, mazeDims, DX, DY, newSim, stepSim, inputDir };')();
const seeds = +process.argv[2] || 200, maxN = +process.argv[3] || 14;
const { genMaze, slideEnd, DX, DY } = api;
const stat = {};
let bad = 0, t0 = Date.now(), worst = 0;
for (let sd = 0; sd < seeds; sd++) {
  for (let n = 1; n <= maxN; n++) {
    const t = Date.now();
    const m = genMaze('seed' + sd, n);
    const dt = Date.now() - t; if (dt > worst) worst = dt;
    const st = stat[n] || (stat[n] = { cnt: 0, par: 0, floors: 0, cells: 0, des: 0, inexact: 0, ms: 0, minPar: 99 });
    st.cnt++; st.par += m.par; st.floors += m.floors; st.cells += m.w * m.h; st.des += m.designed; st.ms += dt;
    if (!m.exact) st.inexact++; if (m.par < st.minPar) st.minPar = m.par;
    if (m.floors < 2) bad++;
  }
}
for (const n in stat) { const s = stat[n]; console.log('n=' + n, 'avgPar', (s.par / s.cnt).toFixed(1), 'minPar', s.minPar, 'floor%', (100 * s.floors / s.cells).toFixed(0), 'designed', (s.des / s.cnt).toFixed(1), 'inexact', s.inexact, 'avgMs', (s.ms / s.cnt).toFixed(1)); }
console.log('bad', bad, 'worstMs', worst, 'total s', (Date.now() - t0) / 1000);
// Drive the real sim with each maze's designed path: it must clear every maze.
const { newSim, stepSim, inputDir, mazeDims } = api;
let runs = 0, fails = 0, prePainted = 0;
for (let sd = 0; sd < Math.min(seeds, 400); sd++) {
  const s = newSim('drive' + sd);
  while (!s.over && s.n <= maxN) {
    const n = s.n, m = s.maze;
    if (m.floors <= 1) prePainted++;
    for (const d of m.path) {
      while (s.dir >= 0 || s.pause > 0) stepSim(s);
      if (s.n !== n) break;
      inputDir(s, d); stepSim(s);
    }
    while (s.dir >= 0) stepSim(s);
    if (s.n === n && s.pause === 0) { fails++; break; }
    while (s.pause > 0) stepSim(s);
    runs++;
  }
}
console.log('designed paths driven through the sim:', runs, 'mazes, failures', fails, 'pre-painted', prePainted);
