'use strict';
// Copies the rules block from games/rang-bharo/js/game.js into the validator,
// byte for byte. Run after a deliberate rules change (and bump the version).
//   node scripts/rb-sync-validator.js
const fs = require('fs'), path = require('path');
const G = path.join(__dirname, '..', 'games', 'rang-bharo', 'js', 'game.js');
const VAL = path.join(__dirname, '..', 'shared', 'anticheat', 'validators', 'rangBharo.js');
const B = '  // ==== RANG BHARO RULES BEGIN ====', E = '  // ==== RANG BHARO RULES END ====';
const cut = (s) => { const a = s.indexOf(B), b = s.indexOf(E); if (a < 0 || b < 0) throw new Error('markers'); return [a, b + E.length]; };
const g = fs.readFileSync(G, 'utf8'), v = fs.readFileSync(VAL, 'utf8');
const [ga, gb] = cut(g), [va, vb] = cut(v);
fs.writeFileSync(VAL, v.slice(0, va) + g.slice(ga, gb) + v.slice(vb));
console.log('validator rules block synced');
