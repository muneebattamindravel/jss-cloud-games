/* Copies the rules block from games/smash-it/js/rules.js into
   shared/anticheat/validators/smashIt.js, so the two copies stay word for word
   the same. The parity suite checks they match; this only saves retyping.
     node games/smash-it/tools/sync-validator.js */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const RULES = path.join(ROOT, 'games', 'smash-it', 'js', 'rules.js');
const VAL = path.join(ROOT, 'shared', 'anticheat', 'validators', 'smashIt.js');
const BEGIN = '  // ==== SMASH IT RULES BEGIN ====', END = '  // ==== SMASH IT RULES END ====';
function cut(s) { const a = s.indexOf(BEGIN), b = s.indexOf(END); if (a < 0 || b < 0) throw new Error('markers missing'); return [a, b + END.length]; }
const r = fs.readFileSync(RULES, 'utf8'), v = fs.readFileSync(VAL, 'utf8');
const [ra, rb] = cut(r), [va, vb] = cut(v);
fs.writeFileSync(VAL, v.slice(0, va) + r.slice(ra, rb) + v.slice(vb));
console.log('rules block copied (' + (rb - ra) + ' chars)');
