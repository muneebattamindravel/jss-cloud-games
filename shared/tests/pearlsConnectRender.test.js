'use strict';

/**
 * Pearls Connect presentation and platform contract: the page loads what it
 * must in order, the run waits for its session with no timeout, one session
 * scores one run, TIME'S UP plays out before the score goes (a hidden tab
 * still submits), HOW TO PLAY records nothing, QA switches are dead inside the
 * platform, and every frame draws without NaN on three screens.
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/pearlsConnectRealGame');
const W = require('./lib/pearlsConnectWorld');

const HTML = fs.readFileSync(path.join(H.DIR, 'index.html'), 'utf8');
const GAME_SRC = fs.readFileSync(H.GAME, 'utf8');

describe('pearls-connect page', () => {
  test('shared scripts load first, in order, then the SDK and the game', () => {
    const order = ['no-touch-ui.js', 'mute.js', 'kj-tutorial-state.js', 'kj-replay.js', 'kj-sdk-v2.js', 'js/game.js']
      .map((f) => HTML.indexOf(f));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(HTML.indexOf('no-touch-ui.js')).toBeLessThan(HTML.indexOf('<meta charset'));
  });
  test('PLAY starts disabled as PREPARING YOUR GAME, the bridge has no session timeout', () => {
    expect(/id="playBtn"[^>]*disabled>PREPARING YOUR GAME/.test(HTML)).toBe(true);
    const bridge = HTML.slice(HTML.indexOf('KJ platform bridge'));
    expect(/setTimeout\([^)]*markReady/.test(bridge)).toBe(false);
    expect(bridge.includes("kind: 'chain'")).toBe(true);
    expect(bridge.includes("var GAME_ID = 'pearls-connect'")).toBe(true);
  });
  test('no ad-blocker class names, no third-party hosts, no em or en dashes, no modules or workers', () => {
    const all = HTML + GAME_SRC;
    expect(/(class|id)="[^"]*\b(ad|banner|promo|sponsor|popup)\b/.test(all)).toBe(false);
    expect(/https?:\/\/(?!localhost)/.test(HTML)).toBe(false);
    expect(/[–—]/.test(all)).toBe(false);
    expect(/serviceWorker|manifest\.json|type="module"|desynchronized/.test(all)).toBe(false);
  });
  test('the canvas takes no browser gestures, and fonts ship with the game', () => {
    expect(/canvas#scene \{[^}]*touch-action: none/.test(HTML)).toBe(true);
    expect(HTML.includes("url('fonts/titan-one-400-latin.woff2')")).toBe(true);
    expect(fs.existsSync(path.join(H.DIR, 'fonts', 'titan-one-400-latin.woff2'))).toBe(true);
  });
  test('the game folder is small', () => {
    let bytes = 0;
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else bytes += fs.statSync(p).size; } };
    walk(H.DIR);
    expect(bytes).toBeLessThan(400 * 1024);
  });
});

describe('pearls-connect session and submit', () => {
  test('PLAY does nothing until the session is ready, however long it takes', () => {
    const g = H.boot({ seed: H.seedHex(1), deferSession: true });
    g.click('playBtn');
    g.advance(30000);
    expect(g.probe().state).toBe('menu');
    expect(g.trace.length).toBe(0);
    g.readySession();
    expect(g.els.playBtn.disabled).toBe(false);
    expect(g.els.playBtn.textContent).toBe('PLAY');
    g.click('playBtn');
    expect(g.probe().state).toBe('ready');
  });
  test('the world is built from the session seed when the run starts', () => {
    const g = H.boot({ seed: H.seedHex(1) });
    g.toPlay();
    expect(g.probe().sim.grid).toEqual(g.probe().rules.initSim(H.seedHex(1), 2).grid);
    expect(g.trace[0].payload).toMatchObject({ kind: 'start', v: 2 });
  });
  test('TIME\'S UP plays out before the score goes, and it goes once', () => {
    const g = H.boot({ seed: H.seedHex(2) });
    H.fly(g, 'idle', { maxSteps: 1 });
    const pr = g.probe();
    while (!pr.sim.over) g.advance(1000 / 60);
    expect(pr.state).toBe('timeup');
    expect(g.results).toEqual([]);
    g.advance(1500);
    expect(g.results).toEqual([]);
    g.advance(1500);
    expect(g.results).toEqual([pr.sim.score]);
    g.advance(5000);
    expect(g.results.length).toBe(1);
  });
  test('a hidden tab still submits (timer, no frames)', () => {
    const g = H.boot({ seed: H.seedHex(3) });
    g.toPlay();
    const pr = g.probe();
    while (!pr.sim.over) g.advance(1000 / 60);
    g.advanceHidden(3100);
    expect(g.results).toEqual([pr.sim.score]);
  });
  test('one session scores one run: PLAY again inside the platform does nothing', () => {
    const g = H.boot({ seed: H.seedHex(4) });
    H.fly(g, 'average', { rngSeed: 2 });
    const pr = g.probe();
    expect(pr.state).toBe('over');
    g.click('againBtn'); g.click('playBtn');
    expect(pr.state).toBe('over');
    expect(g.trace.filter((e) => e.payload.kind === 'start').length).toBe(1);
    expect(g.els.over.classList.contains('is-hidden')).toBe(true);   // the platform shows the result
  });
  test('standalone: the result screen shows, PLAY AGAIN starts a fresh run', () => {
    const g = H.boot({ seed: null, embed: false, search: '?seed=00112233445566778899' });
    g.toPlay();
    expect(g.probe().sim.grid).toEqual(g.probe().rules.initSim('00112233445566778899', 2).grid);
    const pr = g.probe();
    while (!pr.sim.over) g.advance(1000 / 60);
    g.advance(3000);
    expect(pr.state).toBe('over');
    expect(g.els.over.classList.contains('is-hidden')).toBe(false);
    g.click('againBtn');
    expect(pr.state).toBe('ready');
  });
  test('QA switches are dead inside the platform (?seed)', () => {
    const g = H.boot({ seed: H.seedHex(5), search: '?seed=00112233445566778899' });
    g.toPlay();
    expect(g.probe().sim.grid).toEqual(g.probe().rules.initSim(H.seedHex(5), 2).grid);
  });
  test('a run with no session seed inside the platform never borrows one, not even from ?seed', () => {
    const g = H.boot({ seed: null, search: '?seed=00112233445566778899' });
    g.toPlay();
    expect(g.probe().sim.seed).toBe(0);
  });
});

describe('pearls-connect how to play', () => {
  test('first PLAY of a rotation shows the panel; the run starts only from GOT IT, and the panel emits nothing', () => {
    const g = H.boot({ seed: H.seedHex(6), tutorial: true });
    g.click('playBtn');
    expect(g.probe().state).toBe('menu');
    expect(g.els.how.classList.contains('is-hidden')).toBe(false);
    g.advance(5000);
    expect(g.trace.length).toBe(0);
    g.click('howPlayBtn');
    expect(g.probe().state).toBe('ready');
    expect(g.trace.length).toBe(1);   // the start marker only
  });
  test('a second PLAY in the rotation goes straight to the run', () => {
    const g = H.boot({ seed: H.seedHex(6), tutorial: true });
    g.click('playBtn'); g.click('howPlayBtn');
    expect(g.win.KJTut.seen()).toBe(true);
  });
});

describe('pearls-connect drawing', () => {
  test.each([[375, 812], [320, 568], [1440, 780]])('%ix%i: menu, a whole run, loops, shuffles and TIME\'S UP draw without NaN', (w, h) => {
    const g = H.boot({ seed: H.seedHex(7), width: w, height: h, draw: true, strict: true, embed: false });
    g.advance(500);                                   // menu
    const r = H.fly(g, 'flawless', { rngSeed: 3, maxSteps: 60 * 90 });
    expect(r.chains).toBeGreaterThan(100);
    for (let i = 0; i < 400; i++) g.advance(1000 / 60);   // TIME'S UP and the results
    expect(g.log.calls.drawImage).toBeGreaterThan(10000);
  });
  test('a drag in progress (chain line, finger tail, loop glow) draws without NaN', () => {
    const g = H.boot({ seed: H.seedHex(4242), draw: true, strict: true });
    g.toPlay();
    const pr = g.probe();
    const pl = H.plan(pr.rules, pr.sim.grid, 14, 40000);
    const cells = pl.bestLoop || pl.best;
    g.down(cells[0]);
    for (const c of cells.slice(1)) { g.move(c); g.advance(50); }
    g.moveTo(10, 10);
    g.advance(500);
    g.up();
    g.advance(1000);
    expect(pr.sim.chains).toBe(1);
  });
  test('no gradient is created per frame once the sprites exist', () => {
    const g = H.boot({ seed: H.seedHex(8), draw: true });
    g.toPlay();
    g.advance(500);
    const before = g.log.gradients;
    H.fly(g, 'good', { rngSeed: 2, maxSteps: 60 * 30 });
    expect(g.log.gradients - before).toBe(0);
  });
  test('drawing never writes the sim', () => {
    const run = (draw) => { const g = H.boot({ seed: H.seedHex(9), draw }); H.fly(g, 'good', { rngSeed: 4, maxSteps: 60 * 60 }); return W.worldOf(g.probe().sim); };
    expect(run(true)).toBe(run(false));
  });
});
