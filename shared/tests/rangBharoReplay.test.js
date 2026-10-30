'use strict';

/**
 * ADMIN RUN REPLAY for Rang Bharo (games/_shared/kj-replay.js): a stored trace
 * fed back into the REAL game.js reproduces the run, the same final score and
 * step the validator computes, takes no real input and emits nothing.
 */
const H = require('./lib/rangBharoRealGame');
const V = require('../anticheat/validators/rangBharo');

function serverReplay(seed, events) {
  const st = V.init({ seed, maxDurationSecs: 3600 });
  for (const ev of events) V.processEvent(st, ev);
  return V.finalize(st);
}
function record(seed, pilot, rngSeed) {
  const g = H.boot({ seed });
  H.fly(g, pilot, { rngSeed });
  return g.trace;
}
function playBack(seed, events, speed, onFrame) {
  const replay = { events, version: 1, speed: speed || 1, lastStep: null };
  const g = H.boot({ seed, replay });
  for (let i = 0; i < 60 * 400 && g.results.length === 0; i++) { if (onFrame) onFrame(g, i); g.advance(1000 / 60); }
  return { g, replay };
}

describe('rang-bharo replay', () => {
  [['good', 21, 4], ['average', 22, 1], ['novice', 23, 2], ['spammer', 24, 1], ['idle', 28, 8], ['flawless', 27, 8]].forEach(([pilot, i, speed]) => {
    test(`${pilot}: replayed score and final step equal the validator's (speed ${speed})`, () => {
      const seed = H.seedHex(i);
      const events = record(seed, pilot, i);
      const srv = serverReplay(seed, events);
      const { g, replay } = playBack(seed, events, speed);
      expect(srv.gameOver).toBe(true);
      expect(g.results).toEqual([srv.score]);
      expect(replay.lastStep).toBe(srv.debug.steps);
      expect(g.trace.filter((e) => e.payload.kind === 'move').length).toBe(0);
    });
  });

  test('real input is ignored during a replay, and nothing is emitted', () => {
    const seed = H.seedHex(25);
    const events = record(seed, 'average', 25);
    const srv = serverReplay(seed, events);
    const { g } = playBack(seed, events, 2, (gg, i) => { if (i % 7 === 0) gg.swipe(i % 4); if (i % 11 === 0) gg.key((i >> 1) % 4); });
    expect(g.results).toEqual([srv.score]);
    expect(g.trace.filter((e) => e.payload.kind === 'move').length).toBe(0);
  });

  test('the replay starts by itself, skipping the menu and HOW TO PLAY', () => {
    const seed = H.seedHex(26);
    const g = H.boot({ seed, tutorial: true, replay: { events: record(seed, 'good', 26), version: 1, speed: 1 } });
    g.advance(2500);
    expect(g.probe().mode).toBe('play');
  });

  test('speed 0 pauses the simulation', () => {
    const seed = H.seedHex(26);
    const g = H.boot({ seed, replay: { events: record(seed, 'good', 26), version: 1, speed: 0, lastStep: null } });
    g.advance(5000);
    expect(g.probe().mode).toBe('play');
    expect(g.probe().sim.step).toBe(0);
  });
});
