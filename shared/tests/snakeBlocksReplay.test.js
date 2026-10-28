'use strict';

/**
 * ADMIN RUN REPLAY for Snake Blocks (games/_shared/kj-replay.js): a stored trace
 * fed back into the REAL game.js reproduces the run, the same final score and
 * death step the validator computes from the same trace.
 */

const crypto = require('crypto');
const H = require('./lib/snakeBlocksRealGame');
const V = require('../anticheat/validators/snakeBlocks');

const seedOf = (i) => crypto.createHash('sha256').update(`replay:snake-blocks:${i}`).digest('hex');

function serverReplay(seed, events) {
  const st = V.init({ seed, maxDurationSecs: 3600 });
  for (const ev of events) V.processEvent(st, ev);
  return V.finalize(st);
}
function playBack(g, limit) {
  for (let i = 0; i < limit && !g.finished; i++) g.frame();
  return { score: g.submitted, step: g.sandbox.__kjReplay.lastStep };
}

describe('snake-blocks replay', () => {
  ['good', 'average', 'novice', 'jitter', 'lifter', 'dodger'].forEach((name, i) => {
    test(`${name}: replayed score and death step equal the validator's`, () => {
      const seed = seedOf(i);
      const run = H.autopilot({ seed, style: H.STYLES[name], maxSteps: 60 * 90 });
      const events = H.asEvents(run.trace);
      const srv = serverReplay(seed, events);
      const g = H.boot({ seed, replay: { events, version: 2, speed: 1, lastStep: null } });
      const got = playBack(g, 60 * 200);
      expect(got.score).toBe(srv.score);
      expect(got.step).toBe(srv.debug.deathFrame);
      expect(srv.debug.dead).toBe(true);
    });
  });

  test('real input is ignored during a replay, and nothing is emitted', () => {
    const seed = seedOf(9);
    const run = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 60 });
    const events = H.asEvents(run.trace);
    const srv = serverReplay(seed, events);
    const g = H.boot({ seed, replay: { events, version: 2, speed: 1, lastStep: null } });
    g.frame();
    for (let i = 0; i < 60 * 200 && !g.finished; i++) {
      if (i % 40 === 0) { g.down(1, 'touch', 187); }
      if (i % 40 === 20) { g.moveBy(300); g.up(1); }
      g.frame();
    }
    expect(g.submitted).toBe(srv.score);
    expect(g.trace.length).toBe(0);
  });
});
