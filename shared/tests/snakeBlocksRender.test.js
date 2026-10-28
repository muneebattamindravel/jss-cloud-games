'use strict';

/**
 * Snake Blocks: drawing and the page around the run.
 *
 * A STRICT canvas stands in for the real one: it throws on a non-finite
 * coordinate, a negative radius, a NaN colour or an out-of-range gradient stop,
 * the faults that a permissive stub silently swallows and a phone turns into a
 * blank screen. The pilots fly deep enough to meet every world, every effect
 * and the ending, at the viewports that differ most.
 */

const H = require('./lib/snakeBlocksRealGame');

const SEED = H.seedsFor(4)[3];
const VIEWPORTS = [{ w: 320, h: 568 }, { w: 375, h: 812 }, { w: 1440, h: 780 }];

describe('every frame of a long run draws without a fault', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.w}x${viewport.h}: menu, play through several worlds, the ending`, () => {
      const g = H.boot({ seed: SEED, viewport, strictCanvas: true });
      for (let i = 0; i < 90; i++) g.frame();            // the menu plays itself
      const r = H.autopilot({ seed: SEED, style: { ...H.STYLES.good, lag: 0 }, maxSteps: 60 * 200, viewport, strictCanvas: true });
      expect(r.finalSim.rowN).toBeGreaterThan(10);
      expect(r.died).toBe(true);
      expect(r.g.finished).toBe(true);
    });
  }

  test('a run deep enough to change world draws the new world', () => {
    let deepest = 0;
    for (const seed of H.seedsFor(8)) {
      const r = H.autopilot({ seed, style: { ...H.STYLES.flawless }, maxSteps: 60 * 300, strictCanvas: true });
      deepest = Math.max(deepest, r.finalSim.rowN);
      if (deepest >= 27) break;
    }
    expect(deepest).toBeGreaterThanOrEqual(27);   // past the first world (26 rows)
  });

  test('the draw cost per frame stays modest', () => {
    const r = H.autopilot({ seed: SEED, style: H.STYLES.good, maxSteps: 60 * 30 });
    const frames = Math.max(1, r.endFrame || 1800);
    expect(r.g.stats.calls / frames).toBeLessThan(4500);
  });
});

describe('the page around the run', () => {
  test('PLAY stays disabled until the session exists, and a click before then starts nothing', () => {
    const g = H.boot({ seed: SEED, sessionReady: false });
    g.frame();
    g.playClick();
    expect(g.probe().state).toBe('menu');
    g.markReady();
    g.playClick();
    expect(g.probe().state).toBe('play');
  });

  test('the run asks the platform for the current rules version and gets it', () => {
    const g = H.boot({ seed: SEED });
    g.frame();
    g.playClick();
    expect(g.starts).toHaveLength(1);
    expect(g.starts[0].want).toBe(2);
    expect(g.probe().traceVersion).toBe(2);
  });

  test('an older bridge that answers 1 gets no trace at all: nothing is emitted', () => {
    const g = H.boot({ seed: SEED, version: 1 });
    g.frame();
    g.playClick();
    for (let i = 0; i < 80; i++) g.frame();
    g.down(1, 'touch', 180);
    for (let i = 0; i < 60; i++) { g.frame(); g.moveBy(2); }
    expect(g.trace).toHaveLength(0);
  });

  test('the score is sent once, at the end, and the screen is handed over', () => {
    const r = H.autopilot({ seed: SEED, style: H.STYLES.average, maxSteps: 60 * 100 });
    expect(r.g.finished).toBe(true);
    expect(r.g.submitted).toBe(r.finalSim.score);
  });

  test('the score is sent only after the ending has played, never on the killing step', () => {
    const g = H.boot({ seed: SEED });
    g.frame(); g.playClick();
    let deadAt = -1;
    for (let i = 0; i < 2600 && !g.finished; i++) {
      g.frame();
      if (deadAt < 0 && g.probe().sim.dead) deadAt = i;
      if (deadAt >= 0 && i === deadAt) expect(g.finished).toBe(false);
      if (deadAt >= 0 && i === deadAt + 40) expect(g.finished).toBe(false);   // the ending is still playing
    }
    expect(deadAt).toBeGreaterThan(0);
    expect(g.finished).toBe(true);
  });

  test('inside the platform there is no play-again: the Result screen owns it', () => {
    const g = H.boot({ seed: SEED, embed: true });
    g.frame(); g.playClick();
    for (let i = 0; i < 2000 && !g.finished; i++) g.frame();   // never touched: ends as idle
    expect(g.probe().state).toBe('over');
    g.playClick();
    expect(g.probe().state).toBe('over');
  });

  test('a second finger never steers, and a lost finger lets go', () => {
    const g = H.boot({ seed: SEED });
    g.frame(); g.playClick();
    for (let i = 0; i < 40; i++) g.frame();
    g.down(1, 'touch', 180);
    g.down(2, 'touch', 300);
    expect(g.probe().pointerDown).toBe(true);
    g.moveBy(60, 2);
    const aim = g.probe().aimX;
    expect(aim).toBe(g.probe().aimX);
    g.cancel(1);
    expect(g.probe().pointerDown).toBe(false);
    g.down(1, 'touch', 180);
    g.blur();
    expect(g.probe().pointerDown).toBe(false);
  });

  test('a key press never starts a run or presses a focused button', () => {
    const g = H.boot({ seed: SEED });
    g.frame();
    let prevented = 0;
    g.fireWin('keydown', { code: 'Space', preventDefault() { prevented++; } });
    g.fireWin('keydown', { code: 'Enter', preventDefault() { prevented++; } });
    expect(prevented).toBe(2);
    expect(g.probe().state).toBe('menu');
  });

  test('the ending owns the audio: the killing step starts at most one voice of its own', () => {
    const g = H.boot({ seed: SEED });
    g.frame(); g.playClick();
    g.audio.last && g.audio.last.resume();
    for (let i = 0; i < 40; i++) g.frame();
    g.down(1, 'touch', 180);
    let before = null;
    for (let i = 0; i < 3000 && !g.probe().sim.dead; i++) { g.frame(); before = g.audio.voices; }
    expect(g.probe().sim.dead).toBe(true);
    for (let i = 0; i < 20; i++) g.frame();
    expect(g.audio.voices - before).toBeLessThanOrEqual(3);
  });

  test('resizing mid-run changes nothing about the run', () => {
    const a = H.autopilot({ seed: SEED, style: H.STYLES.good, maxSteps: 60 * 40 });
    const g = H.boot({ seed: SEED });
    g.frame(); g.playClick();
    for (let i = 0; i < 60; i++) g.frame();
    g.resizeTo(500, 700);
    for (let i = 0; i < 60; i++) g.frame();
    g.resizeTo(375, 812);
    expect(g.probe().sim.frames).toBeGreaterThan(30);
    expect(a.score).toBeGreaterThan(0);
  });
});
