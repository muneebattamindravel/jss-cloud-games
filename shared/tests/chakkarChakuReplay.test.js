'use strict';

/**
 * ADMIN RUN REPLAY for Chakkar Chaku (games/_shared/kj-replay.js): a stored trace
 * fed back into the REAL game.js reproduces the run, the same final score and
 * death step the validator computes, takes no real input and emits nothing.
 */
const H = require('./lib/chakkarChakuRealGame');
const V = require('../anticheat/validators/chakkarChaku');

function serverReplay(seed, events) {
  const st = V.init({ seed, maxDurationSecs: 3600 });
  for (const ev of events) V.processEvent(st, ev);
  return V.finalize(st);
}
function record(seed, pilot, rngSeed, maxSteps) {
  const g = H.boot({ seed });
  H.fly(g, pilot, { maxSteps: maxSteps || 60 * 600, rngSeed });
  return g.trace;
}
function playBack(seed, events, speed, onFrame) {
  const replay = { events, version: 3, speed: speed || 1, lastStep: null };
  const g = H.boot({ seed, replay });
  for (let i = 0; i < 60 * 900 && g.results.length === 0; i++) { if (onFrame) onFrame(g, i); g.advance(1000 / 60); }
  return { g, replay };
}

describe('chakkar-chaku replay', () => {
  [['good', 21], ['average', 22], ['novice', 23], ['spammer', 24], ['idle', 28]].forEach(([pilot, i]) => {
    test(`${pilot}: replayed score and death step equal the validator's`, () => {
      const seed = H.seedHex(i);
      const events = record(seed, pilot, i);
      const srv = serverReplay(seed, events);
      const { g, replay } = playBack(seed, events, pilot === 'good' ? 4 : 1);
      expect(srv.debug.dead).toBe(true);
      expect(g.results).toEqual([srv.score]);
      expect(replay.lastStep).toBe(srv.debug.deathStep);
    });
  });

  test('a long flawless run (throws on the first safe step) plays back exactly at speed 8', () => {
    const seed = H.seedHex(27);
    const events = record(seed, 'flawless', 27, 60 * 90);
    const srv = serverReplay(seed, events);
    const { g, replay } = playBack(seed, events, 8);
    expect(srv.score).toBeGreaterThan(500);
    expect(g.results).toEqual([srv.score]);
    expect(replay.lastStep).toBe(srv.debug.deathStep);
  });

  test('real input is ignored during a replay, and nothing is emitted', () => {
    const seed = H.seedHex(25);
    const events = record(seed, 'average', 25);
    const srv = serverReplay(seed, events);
    const { g } = playBack(seed, events, 1, (gg, i) => { if (i % 7 === 0) gg.tap(1); if (i % 11 === 0) gg.key('Space'); });
    expect(g.results).toEqual([srv.score]);
    expect(g.trace.filter((e) => e.payload.kind === 'throw').length).toBe(0);
  });

  test('speed 0 pauses the simulation', () => {
    const seed = H.seedHex(26);
    const replay = { events: record(seed, 'good', 26), version: 3, speed: 0, lastStep: null };
    const g = H.boot({ seed, replay });
    g.advance(3000);
    expect(g.probe().state).toBe('play');
    expect(g.probe().sim.step).toBe(0);
  });
});
