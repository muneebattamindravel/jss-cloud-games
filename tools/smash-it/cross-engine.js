#!/usr/bin/env node
'use strict';
/* Cross-engine probe: plays Smash It in real Chromium (the shipped page, real
   pointer clicks), records every shot and the whole world at checkpoints, then
   replays the shots in the Node validator's rules and compares the worlds bit
   for bit. Needs a static server rooted at the repo on :8080:
     python3 -m http.server 8080 &   node tools/smash-it/cross-engine.js [runs]  */
const { chromium } = require('playwright');
const crypto = require('crypto');
const V = require('../../shared/anticheat/validators/smashIt');
const W = require('../../shared/tests/lib/smashItWorld');

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !/^\d+$/.test(args[0]))) { console.error('usage: cross-engine.js [runs]'); process.exit(2); }
const RUNS = Number(args[0] || 3);
const dig = (a) => crypto.createHash('sha256').update(Buffer.from(new Float64Array(a).buffer)).digest('hex').slice(0, 16);

(async () => {
  await V.ready;
  const browser = await chromium.launch();
  let bad = 0;
  for (let r = 0; r < RUNS; r++) {
    const seed = 7001 + r * 13;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await page.addInitScript(() => { window.__smashItHarness = {}; });
    await page.goto(`http://localhost:8080/games/smash-it/index.html?seed=${seed}`);
    await page.waitForFunction(() => window.__smashItHarness.game && window.__smashItHarness.game.engineReady, null, { timeout: 60000 });
    await page.evaluate(() => { window.__shots = []; window.__kjShot = function (t, n, x, y, step) { window.__shots.push({ kind: 'shot', n, x, y, step }); }; });
    await page.click('#playBtn', { force: true });
    const checks = [];
    for (let k = 0; k < 40; k++) {
      const st = await page.evaluate(() => { const G = window.__smashItHarness.game; return { mode: G.mode, step: G.S.step }; });
      if (st.mode !== 'play') break;
      const pt = await page.evaluate((k) => {
        const G = window.__smashItHarness.game, S = G.S;
        if (!S.blocks.length) return null;
        let best = S.blocks[(k * 7) % S.blocks.length].body.translation();
        for (const b of S.blocks) { const p = b.body.translation(); if (b.t === 'jar' && p.y < best.y) best = p; }
        return G.toScreen(best.x + ((k % 3) - 1) * 0.3, best.y);
      }, k);
      if (pt) await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(500 + (k % 4) * 150);
      checks.push(await page.evaluate(() => { const G = window.__smashItHarness.game; return { step: G.S.step, world: Array.from(G.R.snapshot(G.S)) }; }));
    }
    const shots = await page.evaluate(() => window.__shots);
    await page.close();
    const last = checks[checks.length - 1].step;
    const server = W.serverWorlds(seed, shots, last);
    let same = 0;
    for (const c of checks) {
      const s = server[c.step - 1];
      if (s && W.sameWorld(c.world, s)) same++;
      else { bad++; console.log(`run ${r} seed ${seed}: world differs at step ${c.step}`); break; }
    }
    console.log(`run ${r} seed ${seed}: ${shots.length} shots, ${checks.length} checkpoints to step ${last}, ${same} identical (last ${dig(checks[checks.length - 1].world)})`);
  }
  await browser.close();
  console.log(bad ? `${bad} runs DIFFER` : 'Chromium and Node agree bit for bit on every checkpoint');
  process.exit(bad ? 1 : 0);
})();
