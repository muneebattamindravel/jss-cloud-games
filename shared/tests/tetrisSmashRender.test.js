'use strict';

/**
 * Tetris Smash presentation and platform contract: the page loads what it must
 * in order, the run waits for its session with no timeout, HOW TO PLAY is a
 * practice outside the run that emits nothing, one session scores one run, the
 * end plays out before the score goes (a hidden tab still submits), QA
 * switches are dead inside the platform, and every frame draws without NaN on
 * three screens with no gradient built per frame.
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/tetrisSmashRealGame');
const W = require('./lib/tetrisSmashWorld');
const V = require('../anticheat/validators/tetrisSmash');
const S = V._sim;

const HTML = fs.readFileSync(H.HTML, 'utf8');
const CSS = fs.readFileSync(path.join(H.DIR, 'css', 'styles.css'), 'utf8');

describe('tetris-smash page', () => {
  test('shared scripts load first, in order, then the rules, the game, the SDK and the bridge', () => {
    const order = ['no-touch-ui.js', 'mute.js', 'kj-tutorial-state.js', 'kj-press.js', 'kj-replay.js', 'kj-fit.js',
      'js/rules.js', 'js/game.js', 'kj-sdk-v2.js', "var GAME_ID = 'tetris-smash'"].map((f) => HTML.indexOf(f));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(HTML.indexOf('<script')).toBe(HTML.indexOf('<script src="/games/_shared/no-touch-ui.js">'));
  });
  test('PLAY starts disabled as PREPARING YOUR GAME, and the bridge has no session timeout', () => {
    expect(/id="playBtn"[^>]*disabled>PREPARING YOUR GAME/.test(HTML)).toBe(true);
    const bridge = H.bridgeSource();
    expect(/setTimeout\([^)]*markReady/.test(bridge)).toBe(false);
    expect(bridge.includes("kind: 'act'")).toBe(true);
    expect(bridge.includes('KJ_GAME_LOADED')).toBe(true);
    expect(bridge.includes('75000')).toBe(true);   // the submit safety timer
    expect(bridge.includes('flagged') && bridge.includes('notCounted')).toBe(true);
  });
  test('no ad-blocker class names, no third-party hosts, no em or en dashes, no desynchronized canvas', () => {
    const all = HTML + fs.readFileSync(H.GAME, 'utf8') + fs.readFileSync(H.RULES, 'utf8') + CSS;
    expect(/(class|id)="[^"]*\b(ad|banner|promo|sponsor|popup)\b/.test(HTML)).toBe(false);
    expect(/https?:\/\/(?!localhost)/.test(HTML.replace(/<!--[\s\S]*?-->/g, ''))).toBe(false);
    expect(/url\(\s*['"]?https?:/.test(CSS)).toBe(false);
    expect(/[–—]/.test(all)).toBe(false);
    expect(/desynchronized/.test(all)).toBe(false);
    expect(/serviceWorker|manifest\.json/.test(HTML)).toBe(false);
  });
  test('the game folder ships only the game (no dev pages, no node_modules) and stays small', () => {
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(path.relative(H.DIR, p)); } };
    walk(H.DIR);
    expect(files.sort()).toEqual(['css/styles.css', 'fonts/titan-one-400-latin.woff2', 'index.html', 'js/game.js', 'js/rules.js']);
    const bytes = files.reduce((s, f) => s + fs.statSync(path.join(H.DIR, f)).size, 0);
    expect(bytes).toBeLessThan(1024 * 1024);
  });
  test('the canvas takes no touch actions of its own', () => {
    expect(/canvas\{[^}]*touch-action:none/.test(CSS)).toBe(true);
  });
});

describe('tetris-smash session and submit', () => {
  test('PLAY does nothing until the session is ready, however long it takes', () => {
    const g = H.boot({ seed: H.seedHex(1), deferSession: true });
    expect(g.posted.some((m) => m.type === 'KJ_GAME_LOADED')).toBe(true);
    g.clickPlay();
    g.advance(30000);
    expect(g.probe().mode).toBe('menu');
    expect(g.els.playBtn.disabled).toBe(true);
    expect(g.els.playBtn.textContent).toBe('PREPARING YOUR GAME');
    expect(g.trace.length).toBe(0);
    g.readySession();
    expect(g.els.playBtn.disabled).toBe(false);
    expect(g.els.playBtn.textContent).toBe('PLAY');
    g.clickPlay();
    expect(g.probe().mode).toBe('play');
    expect(g.trace[0].payload).toMatchObject({ kind: 'start', v: 2 });
  });
  test('the end plays out before the score goes, and it goes once', () => {
    const g = H.boot({ seed: H.seedHex(2) });
    g.clickPlay();
    const pr = g.probe();
    while (!pr.sim.dead) g.advance(1000 / 60);
    expect(g.results).toEqual([]);
    g.advance(1500);
    expect(g.results).toEqual([]);
    g.advance(1000);
    expect(g.results).toEqual([pr.sim.score]);
    g.advance(5000);
    expect(g.results.length).toBe(1);
    expect(g.posted.filter((m) => m.type === 'KJ_V2_RESULT').length).toBe(1);
  });
  test('a hidden tab still submits (timers, no frames)', () => {
    const g = H.boot({ seed: H.seedHex(3) });
    g.clickPlay();
    const pr = g.probe();
    while (!pr.sim.dead) g.advance(1000 / 60);
    g.advanceHidden(4000);
    expect(g.results).toEqual([pr.sim.score]);
  });
  test('one session scores one run: PLAY again inside the platform does nothing', () => {
    const g = H.boot({ seed: H.seedHex(4) });
    g.clickPlay();
    const pr = g.probe();
    while (!pr.sim.dead) g.advance(1000 / 60);
    g.advance(4000);
    g.click('againBtn'); g.clickPlay();
    g.advance(2000);
    expect(pr.mode).toBe('over');
    expect(g.trace.filter((e) => e.payload.kind === 'start').length).toBe(1);
    expect(g.results.length).toBe(1);
  });
  test('QA switches are dead inside the platform (?seed, ?tut, window.__ts)', () => {
    // The game's own ?tut=0 must not skip a practice the platform says is due,
    // and ?seed must not replace the session's seed.
    const g = H.boot({ seed: H.seedHex(5), search: '?seed=7&tut=0', tutorial: true });
    expect(g.win.__ts).toBeUndefined();
    g.clickPlay();
    expect(g.probe().mode).toBe('tut');
    g.click('skipBtn');
    expect(g.probe().mode).toBe('play');
    expect(g.probe().sim.seed).toBe(S.seedToInt(H.seedHex(5)));
  });
  test('standalone: ?seed picks the course, ?tut=1 forces the practice, nothing is sent', () => {
    const g = H.boot({ seed: null, embed: false, search: '?seed=12345&tut=0' });
    expect(typeof g.win.__ts).toBe('object');
    g.clickPlay();
    expect(g.probe().sim.seed).toBe(12345);
    const pr = g.probe();
    while (!pr.sim.dead) g.advance(1000 / 60);
    g.advance(3000);
    expect(g.results.length).toBe(0);                                         // no submit
    expect(g.posted.filter((m) => m.type === 'KJ_V2_RESULT').length).toBe(0); // no result is ever posted
    const g2 = H.boot({ seed: null, embed: false, search: '?tut=1', realTut: true });
    g2.clickPlay();
    expect(g2.probe().mode).toBe('tut');
  });
});

describe('tetris-smash HOW TO PLAY practice', () => {
  // Plays the practice through with real gestures: drag the L home, tap it
  // upright, swipe it down, then drag the I into the gap and drop it.
  function practise(g) {
    const pr = g.probe(), k = pr.fit.s, mid = g.client(186, 520);
    const drag = (cols) => { g.down(mid.x, mid.y); g.move(mid.x + Math.sign(cols) * 13 * k, mid.y); g.move(mid.x + (cols * 24 + Math.sign(cols)) * k, mid.y); g.up(); g.advance(40); };
    const tap = () => { g.down(mid.x, mid.y); g.up(); g.advance(40); };
    const swipe = () => { g.down(mid.x, mid.y); g.advance(20); g.move(mid.x, mid.y + 60 * k); g.up(); g.advance(40); };
    expect(pr.tut.step).toBe(1);
    drag(-2);
    expect(pr.tut.step).toBe(2);
    tap();
    expect(pr.tut.step).toBe(3);
    swipe();
    g.advance(1200);
    expect(pr.tut.step).toBe(4);
    drag(-4);
    swipe();
    g.advance(1200);
    expect(pr.tut.step).toBe(5);
  }
  test('it runs through and emits nothing, then PLAY starts a clean run', () => {
    const g = H.boot({ seed: H.seedHex(6), tutorial: true });
    g.clickPlay();
    expect(g.probe().mode).toBe('tut');
    practise(g);
    expect(g.trace.length).toBe(0);
    expect(g.results.length).toBe(0);
    expect(g.els.readyBox.classList.contains('is-hidden')).toBe(false);
    g.click('readyBtn');
    const pr = g.probe();
    expect(pr.mode).toBe('play');
    expect(pr.sim.n).toBe(0);
    expect(pr.sim.score).toBe(0);
    expect(pr.sim.board.every((v) => v === 0)).toBe(true);
    expect(g.trace.length).toBe(1);   // the start marker only
  });
  test('SKIP ends it and starts the run at once', () => {
    const g = H.boot({ seed: H.seedHex(6), tutorial: true });
    g.clickPlay();
    g.click('skipBtn');
    expect(g.probe().mode).toBe('play');
    expect(g.trace.length).toBe(1);
  });
  test('"How to play" from the menu returns to the menu, and never starts a run', () => {
    const g = H.boot({ seed: H.seedHex(6) });
    g.clickHow();
    expect(g.probe().mode).toBe('tut');
    g.click('skipBtn');
    expect(g.probe().mode).toBe('menu');
    expect(g.trace.length).toBe(0);
  });
  test('the practice opened after a run (standalone) still emits nothing', () => {
    const g = H.boot({ seed: null, embed: false, search: '?seed=5&tut=0' });
    g.clickPlay();
    const pr = g.probe();
    while (!pr.sim.dead) g.advance(1000 / 60);
    g.advance(3000);
    const n = g.trace.length;
    g.clickHow();
    expect(pr.mode).toBe('tut');
    const m = g.client(186, 520);
    for (let i = 0; i < 6; i++) { g.down(m.x, m.y); g.up(); g.advance(40); g.key('ArrowLeft'); g.key('ArrowLeft', true); }
    g.advance(1000);
    expect(g.trace.length).toBe(n);
  });
  test('the practice shows once per rotation (KJTut), then PLAY goes straight to the run', () => {
    const g = H.boot({ seed: H.seedHex(6), tutorial: true });
    g.clickPlay();
    expect(g.win.KJTut.seen()).toBe(true);
  });
});

describe('tetris-smash drawing', () => {
  test.each([[375, 812], [320, 568], [1440, 780]])('%ix%i: menu, practice, a whole run, clears, a four and the end draw without NaN', (w, h) => {
    const g = H.boot({ seed: H.seedHex(7), width: w, height: h, draw: true, strict: true, tutorial: true });
    g.win.__draw = true;
    g.advance(500);                                   // menu
    g.clickHow(); g.advance(800); g.click('skipBtn'); g.advance(300);
    const r = H.fly(g, 'builder', { maxSteps: 60 * 90 });
    expect(r.dead).toBe(true);
    g.advance(3000);
    expect(g.log.calls.drawImage).toBeGreaterThan(5000);
    expect(g.log.badAlpha).toBe(0);
  });
  test('the last ten seconds (red clock, countdown, vignette) draw without NaN', () => {
    const g = H.boot({ seed: H.seedHex(9), draw: true, strict: true, embed: false, search: '?tut=0' });
    g.win.__draw = true;
    g.clickPlay();
    const pr = g.probe();
    while (!pr.sim.dead) { g.advance(1000); if (pr.sim.frame > 100 && pr.sim.cur) { g.key('Space'); g.key('Space', true); } }
    expect(g.log.badAlpha).toBe(0);
  });
  test('no gradient is created per frame once the sprites exist', () => {
    const g = H.boot({ seed: H.seedHex(8), draw: true });
    g.win.__draw = true;
    g.clickPlay();
    g.advance(2000);
    const before = g.log.gradients;
    H.fly(g, 'builder', { maxSteps: 60 * 30 });
    expect(g.log.gradients - before).toBe(0);
  });
  test('drawing never changes the run: the same run with and without drawing is identical', () => {
    const once = (draw) => {
      const g = H.boot({ seed: H.seedHex(10), draw, strict: false });
      g.win.__draw = draw;
      const worlds = [];
      g.win.__onStep = (sim) => { worlds[sim.frame] = W.worldOf(sim); };
      const r = H.fly(g, 'good', { maxSteps: 60 * 60, rngSeed: 4 });
      return { d: W.digest(worlds), s: r.score, t: JSON.stringify(W.actsOf(g.trace)) };
    };
    expect(once(true)).toEqual(once(false));
  });
});
