#!/usr/bin/env node
'use strict';
// Quick structural check of a game package: node scripts/check-game.js <game-id>
// Not a substitute for the suites; it catches missing pieces fast.
const fs = require('fs');
const path = require('path');

const id = process.argv[2];
if (!id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
  console.error('usage: node scripts/check-game.js <game-id>   (kebab-case)');
  process.exit(2);
}
const camel = id.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
const root = path.join(__dirname, '..');
const p = (...a) => path.join(root, ...a);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

let fails = 0;
function check(ok, msg) { console.log((ok ? 'ok    ' : 'FAIL  ') + msg); if (!ok) fails++; }

const html = read(p('games', id, 'index.html'));
check(!!html, `games/${id}/index.html exists`);
if (html) {
  const order = ['no-touch-ui.js', 'kj-tutorial-state.js', 'kj-sdk-v2.js'];
  let last = -1, inOrder = true;
  for (const f of order) { const i = html.indexOf(f); if (i < 0 || i < last) inOrder = false; last = i; }
  check(inOrder, 'head scripts: no-touch-ui, kj-tutorial-state, then the SDK, in that order');
  check(/KJ_GAME_LOADED/.test(html), 'bridge posts KJ_GAME_LOADED');
  check(/__kjBeginSession/.test(html) && /kjStartV2/.test(html), 'bridge mints the session (kjStartV2)');
  check(/__kjSubmit/.test(html) && /kjSubmitV2/.test(html), 'bridge submits once (kjSubmitV2)');
  check(/PREPARING YOUR GAME/.test(html), 'PLAY reads PREPARING YOUR GAME until the seed exists');
  check(!/https?:\/\/(?!localhost)/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no third-party hosts in index.html');
  check(!/class="[^"]*\b(ad|banner|promo|sponsor|popup)\b/.test(html) && !/id="(ad|banner|promo|sponsor|popup)"/.test(html), 'no ad-blocker-bait class or id names');
  check(!/serviceWorker|manifest\.json/.test(html), 'no service worker or manifest');
}
const game = read(p('games', id, 'js', 'game.js'));
check(!!game, `games/${id}/js/game.js exists`);
if (game) check(!/desynchronized/.test(game), 'no desynchronized canvas');

const val = read(p('shared', 'anticheat', 'validators', camel + '.js'));
check(!!val, `validators/${camel}.js exists`);
if (val && game) {
  const m = /\/\/ ==== ([A-Z0-9 ]+) RULES BEGIN ====([\s\S]*?)\/\/ ==== \1 RULES END ====/.exec(val);
  check(!!m, 'validator has a RULES BEGIN/END block');
  if (m) {
    const norm = (s) => s.replace(/^\s+/gm, '').replace(/\s+$/gm, '').trim();
    const rulesJs = read(p('games', id, 'js', 'rules.js')) || '';
    const g = new RegExp(`// ==== ${m[1]} RULES BEGIN ====([\\s\\S]*?)// ==== ${m[1]} RULES END ====`).exec(game + '\n' + rulesJs);
    check(!!g, 'game has the same RULES block');
    if (g) check(norm(g[1]) === norm(m[2]), 'rules block identical in game and validator (ignoring indentation)');
    const bad = /Math\.(sin|cos|tan|atan2?|pow|hypot|exp|log)\b|\*\*/.exec(m[2]);
    check(!bad, 'no engine transcendental in the rules block' + (bad ? ` (found ${bad[0]})` : ''));
    check(!/Math\.random|Date\.now|performance\.now|innerWidth|innerHeight|devicePixelRatio/.test(m[2]), 'no random, clock or screen read in the rules block');
  }
  check(/module\.exports/.test(val) && /_limits/.test(val), 'validator exports _limits');
}
for (const s of ['Parity', 'Adversarial', 'Render']) check(!!read(p('shared', 'tests', camel + s + '.test.js')), `${camel}${s}.test.js exists`);
check(!!read(p('shared', 'tests', 'lib', camel + 'RealGame.js')), 'harness exists');
check(!!read(p('shared', 'tests', 'lib', camel + 'Mutate.js')), 'mutation battery exists');
check(fs.existsSync(p('shared', 'tests', 'fixtures')) && fs.readdirSync(p('shared', 'tests', 'fixtures')).some((f) => f.startsWith(camel + 'Golden')), 'golden fixture exists');
check(fs.existsSync(p('web', 'public', 'games', id + '.png')), 'icon web/public/games/' + id + '.png exists');
check(fs.existsSync(p('migrations-draft')) && fs.readdirSync(p('migrations-draft')).some((f) => f.includes(id.replace(/-/g, '_'))), 'migration draft exists');
check(fs.existsSync(p('packages', id + '.md')), `packages/${id}.md report exists`);

function size(d) { let t = 0; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, f.name); t += f.isDirectory() ? size(q) : fs.statSync(q).size; } return t; }
if (fs.existsSync(p('games', id))) { const kb = Math.round(size(p('games', id)) / 1024); check(kb <= 1500, `game folder ${kb} KB (aim for about 1 MB)`); }

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
