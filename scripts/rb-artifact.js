'use strict';
// Build a self-contained Rang Bharo page (game.js and the font inlined): node scripts/rb-artifact.js <out.html>
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'games', 'rang-bharo');
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const font = fs.readFileSync(path.join(dir, 'fonts', 'titan-one-400-latin.woff2')).toString('base64');
const js = fs.readFileSync(path.join(dir, 'js', 'game.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
html = html.replace("url('fonts/titan-one-400-latin.woff2')", "url(data:font/woff2;base64," + font + ")");
html = html.replace('<script src="js/game.js"></script>', () => '<script>\n' + js + '\n</script>');
// The shared platform scripts are inlined; the SDK is dropped and the bridge
// is forced standalone (an artifact runs in an iframe with no platform).
const inline = (rel) => '<script>\n' + fs.readFileSync(path.join(dir, '..', '_shared', rel), 'utf8').replace(/<\/script/gi, '<\\/script') + '\n</script>';
html = html.replace('<script src="/games/_shared/no-touch-ui.js"></script>', () => inline('no-touch-ui.js'));
for (const f of ['mute.js', 'kj-tutorial-state.js', 'kj-replay.js']) html = html.replace('<script src="../_shared/' + f + '"></script>', () => inline(f));
html = html.replace('<script src="/sdk/kj-sdk/kj-sdk-v2.js"></script>', '');
const EMB = "window.__kjEmbed = (window.parent !== window) || /[?&]replay=1(&|$)/.test(location.search);";
if (!html.includes(EMB)) throw new Error('bridge embed line not found');
html = html.replace(EMB, 'window.__kjEmbed = false;   // artifact build: always standalone');
// the publish step supplies the document skeleton
html = html.replace(/<!DOCTYPE html>\s*<html[^>]*>\s*<head>\s*/i, '').replace(/<\/head>\s*<body>/i, '').replace(/<\/body>\s*<\/html>\s*$/i, '');
html = html.replace(/<meta charset="UTF-8" \/>\s*<meta name="viewport"[^>]*>\s*/i, '');
if (/<script[^>]*\ssrc=|<link[^>]*\shref=/i.test(html.replace(/<script>[\s\S]*?<\/script>/g, ''))) throw new Error('external reference left');
fs.writeFileSync(process.argv[2], html);
console.log('wrote', process.argv[2], html.length, 'bytes');
