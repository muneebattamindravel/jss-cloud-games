#!/usr/bin/env node
// Builds one self contained HTML file from games/<id>/index.html: inlines
// js/*.js scripts and fonts/*.woff2 as base64. For phone playtests only.
// Usage: node scripts/inline-game.js <id> <out.html>
'use strict';
const fs = require('fs');
const path = require('path');
const [id, out] = process.argv.slice(2);
if (!id || !out) { console.error('usage: inline-game.js <id> <out.html>'); process.exit(2); }
const dir = path.join(__dirname, '..', 'games', id);
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
html = html.replace(/url\('(fonts\/[^']+\.woff2)'\)/g, (m, f) =>
  "url('data:font/woff2;base64," + fs.readFileSync(path.join(dir, f)).toString('base64') + "')");
html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (m, f) =>
  '<script>\n' + fs.readFileSync(path.join(dir, f), 'utf8').replace(/<\/script/gi, '<\\/script') + '\n</script>');
if (/src="(?!data:)/.test(html)) { console.error('external src left in build'); process.exit(1); }
fs.writeFileSync(out, html);
console.log(out, html.length, 'bytes');
