'use strict';

/**
 * ADMIN RUN REPLAY for Pearls Connect (games/_shared/kj-replay.js): a stored
 * trace fed back into the REAL game.js reproduces the run, the same final
 * score and step the validator computes, takes no real input and emits
 * nothing.
 */
const H = require('./lib/pearlsConnectRealGame');
const V = require('../anticheat/validators/pearlsConnect');
const W = require('./lib/pearlsConnectWorld');

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
  const replay = { events, version: 2, speed: speed || 1, lastStep: null };
  const g = H.boot({ seed, replay });
  for (let i = 0; i < 60 * 900 && g.results.length === 0; i++) { if (onFrame) onFrame(g, i); g.advance(1000 / 60); }
  return { g, replay };
}

describe('pearls-connect replay', () => {
  [['good', 21], ['average', 22], ['novice', 23], ['spammer', 24], ['idle', 28]].forEach(([pilot, i]) => {
    test(`${pilot}: replayed score and final step equal the validator's`, () => {
      const seed = H.seedHex(i);
      const events = record(seed, pilot, i);
      const srv = serverReplay(seed, events);
      const { g, replay } = playBack(seed, events, pilot === 'good' ? 4 : 2);
      expect(srv.debug.over).toBe(true);
      expect(g.results).toEqual([srv.score]);
      expect(replay.lastStep).toBe(srv.debug.steps);
      expect(W.worldOf(g.probe().sim)).toBe(W.serverWorlds(seed, W.chainsOf(events)).worlds[srv.debug.steps]);
    });
  });

  test('a flawless run (a chain every few steps) plays back exactly at speed 8', () => {
    const seed = H.seedHex(27);
    const events = record(seed, 'flawless', 27);
    const srv = serverReplay(seed, events);
    const { g, replay } = playBack(seed, events, 8);
    expect(srv.score).toBeGreaterThan(5000);
    expect(g.results).toEqual([srv.score]);
    expect(replay.lastStep).toBe(srv.debug.steps);
  });

  test('real input is ignored during a replay, and nothing is emitted', () => {
    const seed = H.seedHex(25);
    const events = record(seed, 'average', 25);
    const srv = serverReplay(seed, events);
    const { g } = playBack(seed, events, 2, (gg, i) => { if (i % 7 === 0) { gg.down(0); gg.move(1); gg.move(7); gg.up(); } });
    expect(g.results).toEqual([srv.score]);
    expect(g.trace.filter((e) => e.payload.kind === 'chain').length).toBe(0);
  });

  test('speed 0 pauses the simulation', () => {
    const seed = H.seedHex(26);
    const replay = { events: record(seed, 'good', 26), version: 2, speed: 0, lastStep: null };
    const g = H.boot({ seed, replay });
    g.advance(3000);
    expect(g.probe().state).toBe('play');
    expect(g.probe().sim.step).toBe(0);
  });
});
