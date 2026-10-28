'use strict';

/**
 * ADMIN RUN REPLAY for Tetris Smash (games/_shared/kj-replay.js): a stored
 * trace fed back into the REAL game.js reproduces the run (the same world
 * after every step, the same final score and end step the validator computes),
 * takes no real input and emits nothing.
 */
const H = require('./lib/tetrisSmashRealGame');
const W = require('./lib/tetrisSmashWorld');
const V = require('../anticheat/validators/tetrisSmash');
const S = V._sim;

function serverReplay(seed, events) {
  const st = V.init({ seed, maxDurationSecs: 3600, elapsedSecs: 400 });
  for (const ev of events) V.processEvent(st, ev);
  return V.finalize(st);
}
function record(seed, pilot, rngSeed, maxSteps) {
  const g = H.boot({ seed });
  H.fly(g, pilot, { maxSteps: maxSteps || S.RUN_STEPS, rngSeed });
  return g.trace;
}
function playBack(seed, events, speed, onFrame) {
  const replay = { events, version: 2, speed: speed || 1, lastStep: null };
  const g = H.boot({ seed, replay });
  const worlds = [];
  g.win.__onStep = (sim) => { worlds[sim.frame] = W.worldOf(sim); };
  for (let i = 0; i < 60 * 900 && g.results.length === 0; i++) { if (onFrame) onFrame(g, i); g.advance(1000 / 60); }
  return { g, replay, worlds };
}

describe('tetris-smash replay', () => {
  [['good', 21], ['average', 22], ['novice', 23], ['spammer', 24], ['idle', 28], ['fiddler', 29], ['builder', 30]].forEach(([pilot, i]) => {
    test(`${pilot}: the replayed world, score and end step equal the validator's`, () => {
      const seed = H.seedHex(i);
      const events = record(seed, pilot, i);
      const srv = serverReplay(seed, events);
      const { g, replay, worlds } = playBack(seed, events, pilot === 'good' ? 4 : 1);
      expect(srv.debug.dead).toBe(true);
      expect(g.results).toEqual([srv.score]);
      expect(replay.lastStep).toBe(srv.debug.steps);
      const s = W.serverWorlds(seed, W.actsOf(events));
      let n = 0;
      for (let k = 1; k < worlds.length; k++) if (worlds[k] !== undefined) { expect(worlds[k]).toBe(s.worlds[k]); n++; }
      expect(n).toBe(srv.debug.steps);
    });
  });

  test('a long flawless run (several acts on one step) plays back exactly at speed 8', () => {
    const seed = H.seedHex(27);
    const events = record(seed, 'flawless', 27, S.RUN_STEPS);
    const srv = serverReplay(seed, events);
    const { g, replay } = playBack(seed, events, 8);
    expect(srv.score).toBeGreaterThan(500000);
    expect(srv.debug.maxActsPerStep).toBeGreaterThan(3);
    expect(g.results).toEqual([srv.score]);
    expect(replay.lastStep).toBe(S.RUN_STEPS);
  });

  test('a buffered act (pressed in the spawn gap) plays back on the step it was applied', () => {
    const seed = H.seedHex(31);
    const g = H.boot({ seed });
    g.clickPlay(); g.advance(50);
    for (let r = 0; r < 20; r++) {
      g.key('Space'); g.key('Space', true); g.advance(1000 / 60);
      g.key('ArrowLeft'); g.key('ArrowLeft', true); g.advance(1000 / 60 * 12);
    }
    while (!g.probe().sim.dead) g.advance(1000 / 60);
    g.advance(3000);
    const events = g.trace;
    const srv = serverReplay(seed, events);
    expect(srv.score).toBe(g.probe().sim.score);
    const { g: p } = playBack(seed, events, 1);
    expect(p.results).toEqual([srv.score]);
  });

  test('a stored trace full of junk plays back to exactly what the validator scored', () => {
    const seed = H.seedHex(32);
    const honest = record(seed, 'good', 32);
    const junk = [];
    for (const e of honest) {
      junk.push(e);
      if (e.payload.kind === 'act') {
        const p = e.payload;
        junk.push({ type: 'input', payload: { kind: 'act', n: p.n + 5, a: 6, step: p.step } });      // out of order
        junk.push({ type: 'input', payload: { kind: 'act', n: p.n + 1, a: '6', step: p.step } });    // string action
        junk.push({ type: 'input', payload: { kind: 'act', n: p.n + 1, a: 6, step: p.step - 3 } });  // a rewind
        junk.push({ type: 'input', payload: { kind: 'act', n: p.n + 1, a: 6.5, step: p.step } });    // fraction
        junk.push({ type: 'input', payload: { kind: 'act', n: null, a: 6, step: null } });
      }
    }
    const srv = serverReplay(seed, junk);
    expect(srv.score).toBe(serverReplay(seed, honest).score);
    const { g } = playBack(seed, junk, 2);
    expect(g.results).toEqual([srv.score]);
  });

  test('real input is ignored during a replay, and nothing is emitted', () => {
    const seed = H.seedHex(25);
    const events = record(seed, 'average', 25);
    const srv = serverReplay(seed, events);
    const { g } = playBack(seed, events, 1, (gg, i) => {
      if (i % 7 === 0) { const m = gg.client(186, 520); gg.down(m.x, m.y); gg.move(m.x + 80, m.y); gg.up(); }
      if (i % 11 === 0) { gg.key('Space'); gg.key('Space', true); gg.key('ArrowLeft'); gg.key('ArrowLeft', true); }
    });
    expect(g.results).toEqual([srv.score]);
    expect(g.trace.filter((e) => e.payload.kind === 'act').length).toBe(0);
  });

  test('a replay never shows the practice and starts by itself', () => {
    const seed = H.seedHex(26);
    const replay = { events: record(seed, 'good', 26), version: 2, speed: 1, lastStep: null };
    const g = H.boot({ seed, replay, tutorial: true });
    g.advance(100);
    expect(g.probe().mode).toBe('play');
  });

  test('speed 0 pauses the simulation', () => {
    const seed = H.seedHex(26);
    const replay = { events: record(seed, 'good', 26), version: 2, speed: 0, lastStep: null };
    const g = H.boot({ seed, replay });
    g.advance(3000);
    expect(g.probe().mode).toBe('play');
    expect(g.probe().sim.frame).toBe(0);
  });
});
