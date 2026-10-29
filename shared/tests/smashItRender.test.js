'use strict';

/**
 * Smash It presentation and platform contract: the page loads what it must in
 * order, the run waits for its session with no timeout, one session scores one
 * run, the end plays out before the score goes (a hidden tab still submits),
 * QA switches are dead inside the platform, standalone play sends nothing,
 * and the page keeps no game state on window.
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/smashItRealGame');
const V = require('../anticheat/validators/smashIt');
const X = V._sim;

jest.setTimeout(600000);
beforeAll(() => V.ready);

const HTML = fs.readFileSync(H.HTML, 'utf8');
async function toEnd(g, pilot = 'novice') {
  const r = H.fly(g, pilot, { maxSteps: 40000, rngSeed: 3 });
  return r;
}

describe('smash-it page', () => {
  test('shared scripts load first, in order, then the vendors, the SDK, the bridge, the rules, the audio and the game', () => {
    const order = ['no-touch-ui.js', 'mute.js', 'kj-press.js', 'kj-replay.js', 'vendor/three.min.js', 'vendor/rapier.js', 'kj-sdk-v2.js',
      "GAME_ID = 'smash-it'", 'js/rules.js', 'js/audio.js', 'js/game.js'].map((f) => HTML.indexOf(f));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(HTML.indexOf('<script')).toBe(HTML.indexOf('<script src="/games/_shared/no-touch-ui.js">'));
  });
  test('PLAY starts disabled, and the bridge has no session timeout', () => {
    expect(/id="playBtn"[^>]*disabled/.test(HTML)).toBe(true);
    const bridge = H.bridgeSource();
    expect(/setTimeout\([^)]*markReady/.test(bridge)).toBe(false);
    expect(bridge.includes("kind: 'shot'")).toBe(true);
    expect(bridge.includes('KJ_GAME_LOADED')).toBe(true);
  });
  test('no ad-blocker class names, no third-party hosts, no em or en dashes, no service worker', () => {
    const all = HTML + fs.readFileSync(H.GAME, 'utf8') + fs.readFileSync(H.RULES, 'utf8') + fs.readFileSync(path.join(H.DIR, 'js', 'audio.js'), 'utf8');
    expect(/(class|id)="[^"]*\b(ad|banner|promo|sponsor|popup)\b/.test(HTML)).toBe(false);
    expect(/https?:\/\/(?!localhost)/.test(HTML.replace(/<!--[\s\S]*?-->/g, ''))).toBe(false);
    expect(/url\(\s*['"]?https?:/.test(HTML)).toBe(false);
    expect(/[–—]/.test(all)).toBe(false);
    expect(/serviceWorker|manifest\.json/.test(HTML)).toBe(false);
  });
  test('the game folder ships only the game (no dev tools, no node_modules)', () => {
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(path.relative(H.DIR, p)); } };
    walk(H.DIR);
    expect(files.sort()).toEqual([
      'audio/cannon.mp3', 'audio/glass-b1.mp3', 'audio/glass-c07.mp3', 'audio/glass-c13.mp3', 'audio/glass-m1.mp3', 'audio/glass-m2.mp3',
      'fonts/lilita-one.LICENSE', 'fonts/lilita-one.woff2', 'img/backdrop-beach.jpg', 'img/backdrop-meadow.jpg', 'index.html',
      'js/audio.js', 'js/game.js', 'js/rules.js', 'js/vendor/rapier.LICENSE', 'js/vendor/rapier.js', 'js/vendor/three.LICENSE', 'js/vendor/three.min.js',
    ]);
    const bytes = files.reduce((s, f) => s + fs.statSync(path.join(H.DIR, f)).size, 0);
    expect(bytes).toBeLessThan(4.5 * 1024 * 1024);   // the physics engine alone is about 2 MB; see the package report
  });
  test('the vendored Rapier embeds the npm build the validator runs, byte for byte', () => {
    const page = fs.readFileSync(path.join(H.DIR, 'js', 'vendor', 'rapier.js'), 'utf8');
    const npm = fs.readFileSync(path.join(H.ROOT, 'node_modules', '@dimforge', 'rapier3d-deterministic-compat', 'rapier.cjs'), 'utf8');
    expect(page.includes(npm)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(H.ROOT, 'node_modules', '@dimforge', 'rapier3d-deterministic-compat', 'package.json'), 'utf8')).version).toBe('0.19.0');
  });
});

describe('smash-it session and submit', () => {
  test('PLAY does nothing until the session is ready, however long it takes', async () => {
    const g = await H.boot({ seed: H.seedHex(1), deferSession: true });
    expect(g.posted.some((m) => m && m.type === 'KJ_GAME_LOADED')).toBe(true);
    g.clickPlay();
    g.advance(30000);
    expect(g.probe().mode).toBe('menu');
    expect(g.els.playBtn.disabled).toBe(true);
    expect(g.trace.length).toBe(0);
    g.readySession();
    expect(g.els.playBtn.disabled).toBe(false);
    expect(g.els.playBtn.textContent).toBe('PLAY');
    g.clickPlay();
    expect(g.probe().mode).toBe('play');
    expect(g.trace[0].payload).toMatchObject({ kind: 'start', v: 1 });
    expect(g.probe().S.seed).toBe(X.seedToInt(H.seedHex(1)));
  });
  test('the end plays out before the score goes, and it goes once', async () => {
    const g = await H.boot({ seed: H.seedHex(2) });
    g.clickPlay();
    const G = g.probe();
    while (G.mode === 'play') g.advance(1000 / 60);
    expect(g.results).toEqual([]);
    g.advance(1200);
    expect(g.results).toEqual([]);
    g.advance(500);
    expect(g.results).toEqual([G.S.score]);
    g.advance(5000);
    expect(g.results.length).toBe(1);
  });
  test('a hidden tab still submits (timers, no frames)', async () => {
    const g = await H.boot({ seed: H.seedHex(3) });
    g.clickPlay();
    const G = g.probe();
    while (G.mode === 'play') g.advance(1000 / 60);
    g.advanceHidden(4000);
    expect(g.results).toEqual([G.S.score]);
  });
  test('one session scores one run: PLAY AGAIN inside the platform does nothing', async () => {
    const g = await H.boot({ seed: H.seedHex(4) });
    await toEnd(g);
    g.click('againBtn'); g.clickPlay();
    g.advance(2000);
    expect(g.probe().mode).toBe('over');
    expect(g.trace.filter((e) => e.payload && e.payload.kind === 'start').length).toBe(1);
    expect(g.results.length).toBe(1);
  });
  test('QA switches are dead inside the platform (?seed, ?level)', async () => {
    const g = await H.boot({ seed: H.seedHex(5), search: '?seed=7&level=20' });
    g.clickPlay();
    expect(g.probe().S.seed).toBe(X.seedToInt(H.seedHex(5)));
    expect(g.probe().S.level).toBe(1);
  });
  test('the gear never pauses an embedded run', async () => {
    const g = await H.boot({ seed: H.seedHex(6) });
    g.clickPlay();
    g.advance(500);
    g.click('gear');
    const a = g.probe().S.step;
    g.advance(1000);
    expect(g.probe().mode).toBe('play');
    expect(g.probe().S.step - a).toBeGreaterThan(55);
  });
  test('standalone: nothing is sent, and PLAY AGAIN starts a fresh run', async () => {
    const g = await H.boot({ seed: null, embed: false, search: '?seed=12345' });
    g.clickPlay();
    await toEnd(g);
    g.advance(3000);
    expect(g.results.length).toBe(0);
    expect(g.posted.filter((m) => m && m.type === 'KJ_V2_RESULT').length).toBe(0);
    g.click('againBtn');
    expect(g.probe().mode).toBe('play');
    expect(g.probe().S.step).toBe(0);
  });
  test('the page keeps no game state on window (only the test hook object, which the harness sets)', async () => {
    const g = await H.boot({ seed: H.seedHex(7) });
    g.clickPlay();
    g.advance(1000);
    for (const k of ['S', 'scene', 'camera', 'mode', 'fireShot', 'startRun', 'blockMeshes', 'pendingShot', 'traceVersion']) expect([k, k in g.win]).toEqual([k, false]);
    expect(g.win.__smashItHarness.game).toBeTruthy();
  });
});
