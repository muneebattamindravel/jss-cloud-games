'use strict';

/**
 * ADMIN RUN REPLAY for Smash It (games/_shared/kj-replay.js): a stored trace fed
 * back into the REAL game.js reproduces the run (the same world after every
 * step, the same final score and end step the validator computes), takes no
 * real input and emits nothing.
 */
const H = require('./lib/smashItRealGame');
const W = require('./lib/smashItWorld');
const V = require('../anticheat/validators/smashIt');
const X = V._sim;

jest.setTimeout(600000);
beforeAll(() => V.ready);

function serverReplay(seed, events) {
  const st = V.init({ seed, maxDurationSecs: 3600, elapsedSecs: 2400 });
  for (const ev of events) V.processEvent(st, ev);
  return V.finalize(st);
}
async function record(seed, pilot, rngSeed, maxSteps) {
  const g = await H.boot({ seed });
  H.fly(g, pilot, { maxSteps: maxSteps || 40000, rngSeed });
  return g.trace.filter((e) => e.type === 'input');
}
async function playBack(seed, events, speed, onFrame) {
  const replay = { events, version: 1, speed: speed === undefined ? 1 : speed, lastStep: null };
  const g = await H.boot({ seed, replay });
  const worlds = [];
  g.win.__onStep = (S) => { worlds[S.step] = X.snapshot(S); };
  for (let i = 0; i < 60 * 2400 && g.results.length === 0; i++) { if (onFrame) onFrame(g, i); g.advance(1000 / 60); }
  return { g, replay, worlds };
}

describe('smash-it replay', () => {
  [['good', 21, 4], ['average', 22, 2], ['novice', 23, 1], ['spammer', 24, 1], ['thumbs', 29, 2], ['idle', 28, 1]].forEach(([pilot, i, speed]) => {
    test(`${pilot}: the replayed world, score and end step equal the validator's`, async () => {
      const seed = H.seedHex(i);
      const events = await record(seed, pilot, i);
      const srv = serverReplay(seed, events);
      const { g, replay, worlds } = await playBack(seed, events, speed);
      expect(srv.debug.over).toBe(true);
      expect(g.results).toEqual([srv.score]);
      expect(replay.lastStep).toBe(srv.debug.steps);
      const s = W.serverWorlds(seed, W.shotsOf(events), srv.debug.steps);
      let n = 0;
      for (let k = 1; k < worlds.length; k++) if (worlds[k] !== undefined) { expect(W.sameWorld(worlds[k], s[k - 1])).toBe(true); n++; }
      expect(n).toBeGreaterThan(srv.debug.steps - 70);
    });
  });

  test('a stored trace full of junk plays back to exactly what the validator scored', async () => {
    const seed = H.seedHex(32);
    const honest = await record(seed, 'good', 32);
    const junk = [];
    for (const e of honest) {
      junk.push(e);
      if (e.payload.kind === 'shot') {
        const p = e.payload;
        junk.push({ type: 'input', payload: { kind: 'shot', n: p.n + 5, x: 0, y: 300, step: p.step } });       // out of order
        junk.push({ type: 'input', payload: { kind: 'shot', n: p.n + 1, x: '0', y: 300, step: p.step } });     // string x
        junk.push({ type: 'input', payload: { kind: 'shot', n: p.n + 1, x: 0, y: 300, step: p.step - 3 } });   // a rewind
        junk.push({ type: 'input', payload: { kind: 'shot', n: p.n + 1, x: 0.5, y: 300, step: p.step } });     // fraction
        junk.push({ type: 'input', payload: { kind: 'shot', n: p.n + 1, x: 0, y: 300, step: p.step } });       // inside the reload gap
        junk.push({ type: 'input', payload: { kind: 'shot', n: null, x: 0, y: 0, step: null } });
      }
    }
    const srv = serverReplay(seed, junk);
    expect(srv.score).toBe(serverReplay(seed, honest).score);
    const { g } = await playBack(seed, junk, 2);
    expect(g.results).toEqual([srv.score]);
  });

  test('real input is ignored during a replay, and nothing is emitted', async () => {
    const seed = H.seedHex(25);
    const events = await record(seed, 'average', 25);
    const srv = serverReplay(seed, events);
    const { g } = await playBack(seed, events, 1, (gg, i) => { if (i % 7 === 0) gg.tap(180 + (i % 50), 300 + (i % 200)); });
    expect(g.results).toEqual([srv.score]);
    expect(g.trace.filter((e) => e.payload && e.payload.kind === 'shot').length).toBe(0);
  });

  test('a replay starts by itself, shows no pause, and speed 0 holds the simulation', async () => {
    const seed = H.seedHex(26);
    const replay = { events: await record(seed, 'good', 26, 1200), version: 1, speed: 0, lastStep: null };
    const g = await H.boot({ seed, replay });
    g.advance(3000);
    expect(g.probe().mode).toBe('play');
    expect(g.probe().S.step).toBe(0);
  });
});
