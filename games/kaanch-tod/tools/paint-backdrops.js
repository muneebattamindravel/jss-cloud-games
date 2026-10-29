/* Paints the Kaanch Tod backdrops (tools/scenery.js) once and writes them to
   img/ as JPEGs, so the game ships pre-rendered images instead of painting at
   load. Run after changing tools/scenery.js:
     node games/kaanch-tod/tools/paint-backdrops.js
   Needs Playwright's Chromium. HORIZON must match game.js (camera pitch and fov). */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const HORIZON = 232.09, QUALITY = 0.86;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent('<body></body>');
  await p.addScriptTag({ path: path.join(__dirname, 'scenery.js') });
  for (const theme of ['meadow', 'beach']) {
    const url = await p.evaluate(([t, h, q]) => window.KTScenery.paint(t, h).toDataURL('image/jpeg', q), [theme, HORIZON, QUALITY]);
    const out = path.join(__dirname, '..', 'img', 'backdrop-' + theme + '.jpg');
    fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
    console.log(out, fs.statSync(out).size, 'bytes');
  }
  await b.close();
})();
