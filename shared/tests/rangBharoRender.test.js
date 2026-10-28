'use strict';

/**
 * Rang Bharo presentation and platform contract: the page loads what it must
 * in order, the run waits for its session with no timeout, one session scores
 * one run, the end screen plays out before the score goes (a hidden tab still
 * submits), HOW TO PLAY records nothing, QA switches are dead inside the
 * platform, and every frame draws without NaN on three screens.
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/rangBharoRealGame');
const W = require('./lib/rangBharoWorld');
const V = require('../anticheat/validators/rangBharo');
const S = V._sim;

const HTML = fs.readFileSync(path.join(H.DIR, 'index.html'), 'utf8');
const GAME = fs.readFileSync(H.GAME, 'utf8');

describe('rang-bharo page', () => {
  test('shared scripts load first, in order, then the SDK and the game', () => {
    const order = ['no-touch-ui.js', 'mute.js', 'kj-tutorial-state.js', 'kj-replay.js', 'kj-sdk-v2.js', 'js/game.js'].map((f) => HTML.indexOf(f));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(HTML.indexOf('no-touch-ui.js')).toBeLessThan(HTML.indexOf('<meta charset'));
  });
  test('PLAY starts disabled as PREPARING YOUR GAME, the bridge has no session timeout, and emits moves', () => {
    expect(/id="playBtn"[^>]*disabled>PREPARING YOUR GAME/.test(HTML)).toBe(true);
    const bridge = HTML.slice(HTML.indexOf('KJ platform bridge'));
    expect(/setTimeout\([^)]*markReady/.test(bridge)).toBe(false);
    expect(bridge.includes("kind: 'move'")).toBe(true);
    expect(bridge.includes("var GAME_ID = 'rang-bharo';")).toBe(true);
  });
  test('no ad-blocker names, no third-party hosts, no em or en dashes, no desynchronized canvas, no setInterval', () => {
    const all = HTML + GAME;
    expect(/(class|id)="[^"]*\b(ad|banner|promo|sponsor|popup)\b/.test(all)).toBe(false);
    expect(/https?:\/\/(?!localhost)/.test(HTML.replace(/<!--[\s\S]*?-->/g, ''))).toBe(false);
    expect(/[–—]/.test(all)).toBe(false);
    expect(GAME.includes('desynchronized')).toBe(false);
    expect(GAME.includes('setInterval')).toBe(false);
    expect(/touch-action:\s*none/.test(HTML.slice(HTML.indexOf('canvas#scene')))).toBe(true);
  });
  test('the shipped page exposes no debug oracle unless a harness asked for one', () => {
    expect(/window\.__(game|sim|state)\b/.test(GAME)).toBe(false);
    expect(GAME.includes('const harness = window.__rbHarness || null;')).toBe(true);
  });
});

describe('rang-bharo session and submit', () => {
  test('PLAY does nothing until the session is ready, however long it takes', () => {
    const g = H.boot({ seed: H.seedHex(1), deferSession: true });
    g.clickPlay();
    g.advance(30000);
    expect(g.probe().mode).toBe('menu');
    expect(g.els.playBtn.textContent).not.toBe('PLAY');
    g.readySession();
    expect(g.els.playBtn.disabled).toBe(false);
    expect(g.els.playBtn.textContent).toBe('PLAY');
    g.clickPlay();
    expect(g.probe().mode).toBe('ready');
    expect(g.trace.filter((e) => e.payload.kind === 'start').length).toBe(1);
  });
  test('the end screen plays out before the score goes, and it goes once', () => {
    const g = H.boot({ seed: H.seedHex(2) });
    g.start();
    const pr = g.probe();
    while (!pr.sim.over) g.advance(1000);
    expect(g.results).toEqual([]);
    g.advance(2500);
    expect(g.results).toEqual([]);
    g.advance(2000);
    expect(g.results).toEqual([pr.sim.score]);
    g.advance(10000);
    expect(g.results.length).toBe(1);
  });
  test('a hidden tab still finishes the run and submits (timers, no frames)', () => {
    const g = H.boot({ seed: H.seedHex(3) });
    g.start();
    g.swipe(1);
    g.advanceHidden(200000);
    expect(g.probe().sim.over).toBe(true);
    expect(g.results).toEqual([g.probe().sim.score]);
  });
  test('one session scores one run: PLAY AGAIN, MENU and PLAY inside the platform do nothing', () => {
    const g = H.boot({ seed: H.seedHex(4) });
    g.start();
    const pr = g.probe();
    while (!pr.sim.over) g.advance(1000);
    g.advance(5000);
    expect(g.els.againBtn.hidden).toBe(true);
    g.click('againBtn'); g.click('homeBtn'); g.clickPlay();
    g.advance(3000);
    expect(pr.mode).toBe('end');
    expect(g.trace.filter((e) => e.payload.kind === 'start').length).toBe(1);
  });
  test('QA switches are dead inside the platform (?seed)', () => {
    const g = H.boot({ seed: H.seedHex(5), search: '?seed=0123456789abcdef' });
    g.start();
    expect(g.probe().sim.seed).toBe(S.seedToInt(H.seedHex(5)));
  });
  test('inside the platform a run never starts without a seed', () => {
    const g = H.boot({ seed: null });
    g.clickPlay();
    g.advance(3000);
    expect(g.probe().sim).toBe(null);
    expect(g.trace.length).toBe(0);
  });
  test('standalone, ?seed= picks the course, nothing is sent, and PLAY AGAIN works', () => {
    const g = H.boot({ embed: false, search: '?seed=abc' });
    g.start();
    expect(g.probe().sim.seed).toBe(S.seedToInt('abc'));
    const pr = g.probe();
    while (!pr.sim.over) g.advance(1000);
    g.advance(5000);
    expect(g.trace.length).toBe(0);
    g.click('againBtn');
    expect(pr.mode).toBe('ready');
  });
});

describe('rang-bharo HOW TO PLAY', () => {
  test('it shows before the first run, records nothing, and swipes on it are not moves', () => {
    const g = H.boot({ seed: H.seedHex(6), tutorial: true });
    g.clickPlay();
    expect(g.probe().mode).toBe('howto');
    g.advance(3000);
    g.swipe(1); g.key(2);
    g.advance(500);
    expect(g.trace.length).toBe(0);
    expect(g.probe().sim).toBe(null);
    g.click('howOk');
    expect(g.probe().mode).toBe('ready');
    expect(g.trace.length).toBe(1);   // the start marker only
    expect(g.win.KJTut.seen()).toBe(true);
  });
  test('it can be opened from the menu and closed back to it', () => {
    const g = H.boot({ seed: H.seedHex(6) });
    g.click('howBtn');
    expect(g.probe().mode).toBe('howto');
    g.advance(2000);
    g.click('howOk');
    expect(g.probe().mode).toBe('menu');
    expect(g.trace.length).toBe(0);
  });
});

describe('rang-bharo drawing', () => {
  test.each([[375, 812], [320, 568], [1440, 780]])('%ix%i: the menu, HOW TO PLAY, a run with clears, the clock and the end draw without NaN', (w, h) => {
    const g = H.boot({ seed: H.seedHex(7), width: w, height: h, draw: true, strict: true, tutorial: true });
    g.win.__draw = true;
    g.advance(1500);
    g.clickPlay(); g.advance(2500); g.click('howOk');
    const r = H.fly(g, 'flawless', { maxSteps: 60 * 25, rngSeed: 3 });
    expect(r.mazes).toBeGreaterThan(2);
    const pr = g.probe();
    while (!pr.sim.over) g.advance(500);
    g.advance(6000);
    expect(g.log.calls.drawImage).toBeGreaterThan(5000);
    expect(g.log.calls.fillText).toBeGreaterThan(1000);
  });
  test('no gradient is created per frame once the sprites exist', () => {
    const g = H.boot({ seed: H.seedHex(8), draw: true });
    g.win.__draw = true;
    g.start();
    g.advance(2000);
    const before = g.log.gradients;
    for (let i = 0; i < 300; i++) { g.advance(1000 / 60); if (i % 40 === 0) g.swipe(i % 4); }
    // a new maze builds its sprites (tens of gradients); never one per frame
    expect(g.log.gradients - before).toBeLessThan(200);
  });
});
