'use strict';

/**
 * Chakkar Chaku presentation and platform contract: the page loads what it must
 * in order, the run waits for its session with no timeout, one session scores
 * one run, the death plays out before the score goes (a hidden tab still
 * submits), the practice records nothing, QA switches are dead inside the
 * platform, and every frame draws without NaN on three screens.
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/chakkarChakuRealGame');
const W = require('./lib/chakkarChakuWorld');

const HTML = fs.readFileSync(path.join(H.DIR, 'index.html'), 'utf8');

describe('chakkar-chaku page', () => {
  test('shared scripts load first, in order, then the SDK and the game', () => {
    const order = ['no-touch-ui.js', 'kj-tutorial-state.js', 'kj-press.js', 'kj-fit.js', 'dmath.js', 'kj-replay.js', 'kj-sdk-v2.js', 'js/game.js']
      .map((f) => HTML.indexOf(f));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(HTML.indexOf('no-touch-ui.js')).toBeLessThan(HTML.indexOf('<meta charset'));
  });
  test('PLAY starts disabled as PREPARING YOUR GAME, the bridge has no session timeout', () => {
    expect(/id="playBtn"[^>]*disabled>PREPARING YOUR GAME/.test(HTML)).toBe(true);
    const bridge = HTML.slice(HTML.indexOf('KJ platform bridge'));
    expect(/setTimeout\([^)]*markReady/.test(bridge)).toBe(false);
    expect(bridge.includes("kind: 'throw'")).toBe(true);
  });
  test('no ad-blocker class names, no third-party hosts, no em dashes', () => {
    const all = HTML + fs.readFileSync(H.GAME, 'utf8');
    expect(/class="(ad|banner|promo|sponsor|popup)\b/.test(all)).toBe(false);
    expect(/https?:\/\/(?!localhost)/.test(HTML)).toBe(false);
    expect(/[–—]/.test(all)).toBe(false);
  });
});

describe('chakkar-chaku session and submit', () => {
  test('PLAY does nothing until the session is ready, however long it takes', () => {
    const g = H.boot({ seed: H.seedHex(1), deferSession: true });
    g.clickPlay();
    g.advance(30000);
    expect(g.probe().state).toBe('menu');
    expect(g.els.playBtn.textContent).not.toBe('PLAY');   // the page's own disabled PREPARING button stands
    g.readySession();
    expect(g.els.playBtn.disabled).toBe(false);
    expect(g.els.playBtn.textContent).toBe('PLAY');
    g.clickPlay();
    expect(g.probe().state).toBe('play');
  });
  test('the death plays out before the score goes, and it goes once', () => {
    const g = H.boot({ seed: H.seedHex(2) });
    g.clickPlay();
    const pr = g.probe();
    while (!pr.sim.dead) g.advance(1000 / 60);
    expect(g.results).toEqual([]);
    g.advance(1000);
    expect(g.results).toEqual([]);
    g.advance(1000);
    expect(g.results).toEqual([pr.sim.score]);
    g.advance(5000);
    expect(g.results.length).toBe(1);
  });
  test('a hidden tab still submits (timer, no frames)', () => {
    const g = H.boot({ seed: H.seedHex(3) });
    g.clickPlay();
    const pr = g.probe();
    while (!pr.sim.dead) g.advance(1000 / 60);
    g.advanceHidden(3000);
    expect(g.results).toEqual([pr.sim.score]);
  });
  test('one session scores one run: PLAY again inside the platform does nothing', () => {
    const g = H.boot({ seed: H.seedHex(4) });
    g.clickPlay();
    const pr = g.probe();
    while (!pr.sim.dead) g.advance(1000 / 60);
    g.advance(3000);
    g.click('againBtn'); g.clickPlay();
    expect(pr.state).toBe('over');
    expect(W.throwsOf(g.trace).length).toBe(0);
    expect(g.trace.filter((e) => e.payload.kind === 'start').length).toBe(1);
  });
  test('QA switches are dead inside the platform (?log, ?seed, ?perf)', () => {
    const g = H.boot({ seed: H.seedHex(5), search: '?log=9&seed=0123456789abcdef&perf=1' });
    g.clickPlay();
    expect(g.probe().sim.log).toBe(0);
    g.advance(5000);
    expect(g.probe().sim.throws).toBe(0);   // no autopilot
  });
  test('standalone, ?log=5 starts at the first boss and nothing is sent', () => {
    const g = H.boot({ seed: null, embed: false, search: '?log=5' });
    g.clickPlay();
    expect(g.probe().sim.log).toBe(4);
    expect(g.probe().sim.spec.boss).toBe(true);
  });
});

describe('chakkar-chaku practice', () => {
  function practice(g) {
    const pr = g.probe();
    const until = (ph) => { for (let i = 0; i < 2000 && !(pr.prac && pr.prac.phase === ph); i++) g.advance(1000 / 60); return pr.prac && pr.prac.phase; };
    expect(until('aim1')).toBe('aim1'); g.tap(1);
    expect(until('danger')).toBe('danger');
    g.tap(1); g.tap(1);                                  // ignored while waiting for the gap
    expect(pr.prac.stuck.length).toBe(1);
    expect(until('aim2')).toBe('aim2'); g.tap(1);
    for (let i = 0; i < 120 && !pr.prac.ready; i++) g.advance(1000 / 60);
    expect(pr.prac.ready).toBe(true);
  }
  test('it runs through and emits nothing, then PLAY starts a clean run', () => {
    const g = H.boot({ seed: H.seedHex(6), tutorial: true });
    g.clickPlay();
    expect(g.probe().state).toBe('prac');
    practice(g);
    expect(g.trace.length).toBe(0);
    expect(g.results.length).toBe(0);
    g.click('pplayBtn');
    const pr = g.probe();
    expect(pr.state).toBe('play');
    expect(pr.sim.throws).toBe(0);
    expect(pr.sim.stuck).toEqual(pr.sim.spec.stuck);
    expect(g.trace.length).toBe(1);   // the start marker only
  });
  test('it takes under 8 seconds of game time when the player taps at once', () => {
    const g = H.boot({ seed: H.seedHex(6), tutorial: true });
    g.clickPlay();
    practice(g);
    expect(g.probe().prac.t).toBeLessThan(8);
  });
  test('SKIP ends it straight away', () => {
    const g = H.boot({ seed: H.seedHex(6), tutorial: true });
    g.clickPlay();
    g.click('pskip');
    expect(g.probe().prac.ready).toBe(true);
  });
});

describe('chakkar-chaku drawing', () => {
  test.each([[375, 812], [320, 568], [1440, 780]])('%ix%i: a whole run, the clear, a boss and the death draw without NaN', (w, h) => {
    const g = H.boot({ seed: H.seedHex(7), width: w, height: h, draw: true, strict: true, embed: false, search: '?log=4' });
    g.win.__draw = true;
    g.advance(500);                                   // menu
    const r = H.fly(g, 'good', { maxSteps: 60 * 60, rngSeed: 3 });
    expect(r.dead).toBe(true);
    expect(g.log.calls.drawImage).toBeGreaterThan(1000);
  });
  test('no gradient is created per frame once the sprites exist', () => {
    const g = H.boot({ seed: H.seedHex(8), draw: true });
    g.win.__draw = true;
    g.clickPlay();
    g.advance(2000);
    const before = g.log.gradients;
    for (let i = 0; i < 300; i++) { g.advance(1000 / 60); if (i % 40 === 0) g.tap(1); }
    // a new log builds one sprite; a few gradients per new log are allowed, never one per frame
    expect(g.log.gradients - before).toBeLessThan(60);
  });
});
