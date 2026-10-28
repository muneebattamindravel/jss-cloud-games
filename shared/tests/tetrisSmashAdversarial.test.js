'use strict';

/**
 * Tetris Smash adversarial: forged, stacked, rewound, malformed and flooded
 * traces must score no more than the acts they really contain earn, and a
 * refusal never zeroes an honest run. Properties are asserted, never a count
 * of rejections.
 */
const H = require('./lib/tetrisSmashRealGame');
const W = require('./lib/tetrisSmashWorld');
const V = require('../anticheat/validators/tetrisSmash');
const F = require('../anticheat/humanness/features');
const S = V._sim;

const SEED = H.seedHex(11);
const start = (v = 2) => ({ type: 'input', payload: { kind: 'start', v } });
const act = (n, a, step, extra) => ({ type: 'input', payload: Object.assign({ kind: 'act', n, a, step }, extra || {}) });
function run(events, opts = {}) {
  const st = V.init(Object.assign({ seed: SEED, elapsedSecs: 400 }, opts));
  const out = events.map((e) => V.processEvent(st, e));
  return { st, out, fin: V.finalize(st) };
}
// An honest run from the real game.
function honest(seed = SEED, pilot = 'good', rng = 5) {
  const g = H.boot({ seed });
  const r = H.fly(g, pilot, { maxSteps: S.RUN_STEPS, rngSeed: rng });
  return { trace: g.trace, score: r.score, frame: r.frame, end: r.end };
}
const H1 = honest();

describe('Tetris Smash validator: the server computes the score, the client claims nothing', () => {
  test('an honest trace scores exactly what the game showed', () => {
    const { fin } = run(H1.trace);
    expect(fin.score).toBe(H1.score);
    expect(fin.debug.steps).toBe(H1.frame);
    expect(fin.debug.end).toBe(H1.end);
    expect(fin.debug.rejects).toBe(0);
    expect(H1.score).toBeGreaterThan(1000);
  });
  test('a claimed score, lines or level in the payload is never read', () => {
    const forged = H1.trace.map((e) => ({ type: e.type, payload: Object.assign({}, e.payload, { score: 99999, lines: 400, level: 30, rows: [1, 2, 3, 4], gained: 9999 }) }));
    expect(run(forged).fin.score).toBe(H1.score);
  });
  test('no start marker: nothing scores', () => {
    expect(run(H1.trace.filter((e) => e.payload.kind !== 'start')).fin.score).toBe(0);
    expect(run(H1.trace.filter((e) => e.payload.kind !== 'start')).fin.debug.mode).toBe('none');
  });
  test.each([[1], [0], ['2'], [null], [undefined], ['x']])('a start marker with v=%p is not a v2 replay', (v) => {
    const fin = run([{ type: 'input', payload: { kind: 'start', v } }].concat(H1.trace.slice(1))).fin;
    if (Number(v) >= 2) expect(fin.score).toBe(H1.score);
    else expect(fin.score).toBe(0);
  });
  test('a second start marker cannot reset the run', () => {
    const ev = H1.trace.slice();
    ev.splice(Math.floor(ev.length / 2), 0, start(2));
    expect(run(ev).fin.score).toBe(H1.score);
  });
  test('a trace of no acts scores 0 and the well tops out on its own', () => {
    const { fin } = run([start()]);
    expect(fin.score).toBe(0);
    expect(fin.debug.end).toBe('topout');
  });
  test('the seed is the session\'s: another seed scores what those acts earn there, nothing more', () => {
    const other = H.seedHex(12);
    const { fin } = run(H1.trace, { seed: other });
    const s = W.serverWorlds(other, W.actsOf(H1.trace));
    expect(fin.score).toBe(s.sim.score);
    expect(fin.score).toBeLessThan(H1.score);
  });
  test('a missing or malformed session seed gives the zero-seed course, never a crash', () => {
    for (const seed of [null, undefined, 42, '', 'zz', {}]) {
      const st = V.init({ seed });
      V.processEvent(st, start());
      V.processEvent(st, act(0, S.A_HARD, 3));
      expect(Number.isFinite(V.finalize(st).score)).toBe(true);
    }
  });
});

describe('Tetris Smash validator: a refused input changes nothing and never zeroes', () => {
  test.each([
    ['null step', { kind: 'act', n: 0, a: 6, step: null }],
    ['string step', { kind: 'act', n: 0, a: 6, step: '60' }],
    ['negative step', { kind: 'act', n: 0, a: 6, step: -1 }],
    ['fraction step', { kind: 'act', n: 0, a: 6, step: 60.5 }],
    ['NaN n', { kind: 'act', n: NaN, a: 6, step: 60 }],
    ['Infinity step', { kind: 'act', n: 0, a: 6, step: Infinity }],
    ['object n', { kind: 'act', n: {}, a: 6, step: 60 }],
    ['string a', { kind: 'act', n: 0, a: '6', step: 60 }],
    ['fraction a', { kind: 'act', n: 0, a: 5.5, step: 60 }],
    ['negative a', { kind: 'act', n: 0, a: -1, step: 60 }],
    ['missing a', { kind: 'act', n: 0, step: 60 }],
  ])('malformed: %s', (_name, payload) => {
    const { out, fin } = run([start(), { type: 'input', payload }]);
    expect(out[1].accepted).toBe(true);
    expect(fin.debug.acts).toBe(0);
    expect(fin.score).toBe(0);
  });
  test.each([[7], [8], [99], [1e6]])('an action code the rules do not have (%i) is refused', (a) => {
    const { fin } = run([start(), act(0, a, 10)]);
    expect(fin.debug.acts).toBe(0);
    expect(fin.score).toBe(run([start()]).fin.score);
  });
  test('steps may not go backwards (a rewind would replay a window and keep the best)', () => {
    const { fin } = run([start(), act(0, S.A_LEFT, 30), act(1, S.A_HARD, 10)]);
    expect(fin.debug.acts).toBe(1);
    const alone = run([start(), act(0, S.A_LEFT, 30)]).fin;
    expect(fin.score).toBe(alone.score);
  });
  test('an act out of order (wrong index) is refused, and so is a duplicated one', () => {
    expect(run([start(), act(5, S.A_HARD, 10)]).fin.debug.acts).toBe(0);
    const dup = run([start(), act(0, S.A_LEFT, 10), act(0, S.A_LEFT, 10), act(0, S.A_LEFT, 11)]).fin;
    expect(dup.debug.acts).toBe(1);
  });
  test('a turn refused by the rules (the O piece) is refused here too and costs nothing', () => {
    let i = 0; while (S.pieceAt(S.seedToInt(H.seedHex(i)), 0) !== 1) i++;
    const st = V.init({ seed: H.seedHex(i), elapsedSecs: 400 });
    V.processEvent(st, start());
    const r = V.processEvent(st, act(0, S.A_CW, 5));
    expect(r.reason).toMatch(/^refused/);
    expect(st.sim.n).toBe(0);
    const r2 = V.processEvent(st, act(0, S.A_HARD, 6));
    expect(r2.reason).toBeUndefined();
    expect(st.sim.score).toBeGreaterThan(0);
  });
  test('an act while no piece is in the well (the spawn gap) is refused, never queued by the server', () => {
    const base = run([start(), act(0, S.A_HARD, 5)]).fin;
    const { fin } = run([start(), act(0, S.A_HARD, 5), act(1, S.A_LEFT, 6), act(1, S.A_LEFT, 8)]);
    expect(fin.debug.acts).toBe(1);
    expect(fin.score).toBe(base.score);
  });
  test('malformed and refused events inside an honest run cost the player nothing', () => {
    const junk = [];
    for (const e of H1.trace) {
      junk.push(e);
      if (e.payload.kind === 'act') {
        junk.push({ type: 'input', payload: { kind: 'act', n: 'x', a: 6, step: e.payload.step } });
        junk.push(act(e.payload.n + 7, S.A_HARD, e.payload.step));      // out of order
        junk.push(act(e.payload.n + 1, 7, e.payload.step));             // no such action
        junk.push({ type: 'input', payload: { kind: 'swipe' } });
        junk.push({ type: 'heartbeat' });
        junk.push(null);
      }
    }
    const { fin } = run(junk);
    expect(fin.score).toBe(H1.score);
    expect(fin.debug.steps).toBe(H1.frame);
  });
  test('ten or more refusals mark the run suspicious without changing its score', () => {
    const ev = H1.trace.slice();
    for (let i = 0; i < 12; i++) ev.push({ type: 'input', payload: { kind: 'act', n: -1, a: 0, step: 1 } });
    const { fin } = run(ev);
    expect(fin.suspicious).toMatch(/^validator_rejects:/);
    expect(fin.score).toBe(H1.score);
  });
});

describe('Tetris Smash validator: work and time bounds', () => {
  test('an act far beyond the run is refused once the run is over, and the run scores what was earned', () => {
    const early = run([start(), act(0, S.A_HARD, 5)]).fin;
    const { fin } = run([start(), act(0, S.A_HARD, 5), act(1, S.A_HARD, 10 * 60 * 60 * 60)]);
    expect(fin.score).toBe(early.score);
  });
  test('the run ends at RUN_STEPS however the trace goes on', () => {
    // A trace that keeps the well clear-ish forever: the flawless planner.
    const f = honest(H.seedHex(13), 'flawless');
    const tail = [];
    let n = W.actsOf(f.trace).length;
    for (let s = S.RUN_STEPS; s < S.RUN_STEPS + 600; s += 3) tail.push(act(n++, S.A_LEFT, s));
    const { fin } = run(f.trace.concat(tail), { seed: H.seedHex(13) });
    expect(f.end).toBe('time');
    expect(fin.debug.steps).toBe(S.RUN_STEPS);
    expect(fin.debug.end).toBe('time');
    expect(fin.score).toBe(f.score);
  });
  test('the rules\' act cap refuses further acts, it never zeroes', () => {
    const st = V.init({ seed: SEED, elapsedSecs: 400 });
    V.processEvent(st, start());
    V.processEvent(st, act(0, S.A_HARD, 3));
    const sc = st.sim.score;
    st.sim.n = S.MAX_ACTS;
    const r = V.processEvent(st, act(S.MAX_ACTS, S.A_HARD, 20));
    expect(r.accepted).toBe(true);
    expect(r.reason).toBe('refused:act_cap');
    expect(st.sim.score).toBe(sc);
  });
  test('the act cap is 40000 acts a run: the 40000th is applied, the 40001st refused', () => {
    const st = V.init({ seed: SEED, elapsedSecs: 400 });
    V.processEvent(st, start());
    st.sim.n = 39999;                                    // literal, so a changed cap shows
    expect(V.processEvent(st, act(39999, S.A_LEFT, 3)).reason).toBeUndefined();
    expect(V.processEvent(st, act(40000, S.A_RIGHT, 3)).reason).toBe('refused:act_cap');
    expect(V._limits.MAX_INPUTS).toBe(60000);
  });
  test('the trace input cap refuses further events, it never zeroes', () => {
    const st = V.init({ seed: SEED, elapsedSecs: 400 });
    V.processEvent(st, start());
    V.processEvent(st, act(0, S.A_HARD, 3));
    const sc = st.sim.score;
    st.inputCount = S.MAX_INPUTS;
    const r = V.processEvent(st, act(1, S.A_HARD, 20));
    expect(r.reason).toBe('input_cap');
    expect(r.accepted).toBe(true);
    expect(V.finalize(st).score).toBeGreaterThanOrEqual(sc);
  });
  test('a flood of acts on one step buys only what the rules allow', () => {
    // 2000 lefts and turns on one step: the piece ends at the wall, nothing more.
    const ev = [start()];
    let n = 0;
    const st = V.init({ seed: SEED, elapsedSecs: 400 });
    V.processEvent(st, start());
    for (let i = 0; i < 2000; i++) { const r = V.processEvent(st, act(n, i % 3 ? S.A_LEFT : S.A_CW, 4)); if (!r.reason) n++; ev.push(act(i, S.A_LEFT, 4)); }
    expect(st.sim.cur.x).toBeGreaterThanOrEqual(-2);
    expect(S.fits(st.sim.board, st.sim.cur.t, st.sim.cur.r, st.sim.cur.x - 1, st.sim.cur.y)).toBe(false);
    expect(st.sim.score).toBe(0);
    expect(V.finalize(st).debug.maxActsPerStep).toBeGreaterThan(5);   // recorded for the bot detector
  });
  test('the elapsed cap stops the run-out at exactly ceil((elapsed x 1.2 + 10) x 60) steps', () => {
    for (const e of [5, 30, 100]) {
      const { fin } = run([start(), act(0, S.A_SOFT_ON, 0)], { elapsedSecs: e, seed: H.seedHex(14) });
      const cap = Math.ceil((e * 1.2 + 10) * 60);
      // the idle run tops out on its own after ~90 s; below that the cap is what stops it
      const natural = run([start(), act(0, S.A_SOFT_ON, 0)], { elapsedSecs: 0, seed: H.seedHex(14) }).fin.debug.steps;
      expect(fin.debug.steps).toBe(Math.min(cap, natural));
    }
  });
  test('an elapsed time that lies short cannot buy more: the run-out stops earlier, it never scores more', () => {
    const full = run(H1.trace, { elapsedSecs: 400 }).fin.score;
    const short = run(H1.trace, { elapsedSecs: 10 }).fin.score;
    expect(short).toBeLessThanOrEqual(full);
  });
  test('the limits are pinned to the session lifetime', () => {
    expect(V._limits.MAX_SIM_STEPS).toBe(3600 * 60);
    expect(V._limits.FPS).toBe(60);
    expect(V._limits.MAX_INPUTS).toBeGreaterThan(S.MAX_ACTS);
    // a trace at the input cap stays inside the 4 MB gzip limit by a wide margin
    const zlib = require('zlib');
    const lines = [];
    for (let i = 0; i < V._limits.MAX_INPUTS; i++) lines.push(JSON.stringify({ seq: i, type: 'input', ts: 1700000000000 + i * 16, payload: { kind: 'act', n: i, a: i % 7, step: i, tHint: i * 16.6667 } }));
    expect(zlib.gzipSync(lines.join('\n')).length).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('Tetris Smash validator: attacks that try to buy a better run', () => {
  test('hard-dropping every piece on its first step (the machine gun) tops out early and scores little', () => {
    const st = V.init({ seed: SEED, elapsedSecs: 400 });
    V.processEvent(st, start());
    let n = 0;
    for (let t = 0; t < 4000; t++) { const r = V.processEvent(st, act(n, S.A_HARD, t)); if (!r.reason) n++; if (st.dead) break; }
    const fin = V.finalize(st);
    expect(fin.debug.end).toBe('topout');
    expect(fin.score).toBeLessThan(H1.score);
  });
  test('soft drop on and off a thousand times buys nothing', () => {
    const ev = [start()];
    for (let i = 0; i < 1000; i++) ev.push(act(i, i % 2 ? S.A_SOFT_OFF : S.A_SOFT_ON, 2));
    const { fin } = run(ev);
    expect(fin.score).toBe(0);
  });
  test('a lock that keeps being reset cannot park the piece: the reset cap locks it', () => {
    // a piece on the floor wiggled left and right every 5 steps for ever
    const st = V.init({ seed: SEED, elapsedSecs: 400 });
    V.processEvent(st, start());
    let n = 0;
    const r0 = V.processEvent(st, act(n, S.A_SOFT_ON, 0)); if (!r0.reason) n++;
    const k0 = st.sim.k;
    for (let t = 1; t < 1200 && st.sim.k === k0; t += 5) { const r = V.processEvent(st, act(n, t % 2 ? S.A_LEFT : S.A_RIGHT, t)); if (!r.reason) n++; }
    expect(st.sim.k).toBeGreaterThan(k0);   // the next piece came: the first one locked
  });
  test('the humanness extractor reads every act (features.inputs equals the act count)', () => {
    if (!F.GAME_INPUTS['tetris-smash']) F.GAME_INPUTS['tetris-smash'] = { kinds: ['act'], time: 'step' };   // the integration hunk
    for (const pilot of ['good', 'flawless', 'spammer']) {
      const h = honest(H.seedHex(15), pilot, 2);
      const f = F.extractFeatures('tetris-smash', h.trace);
      expect(f.inputs).toBe(W.actsOf(h.trace).length);
    }
  });
  test('the debug record separates a planner from a hand (recorded, never gated)', () => {
    const bot = run(honest(H.seedHex(16), 'flawless').trace, { seed: H.seedHex(16) }).fin.debug;
    const hand = run(honest(H.seedHex(16), 'average', 3).trace, { seed: H.seedHex(16) }).fin.debug;
    for (const k of ['actsPerPiece', 'finesseMean', 'placeMean', 'placeSd', 'gapCv', 'maxActsPerStep']) {
      expect(typeof bot[k]).toBe('number');
      expect(typeof hand[k]).toBe('number');
    }
    // the planner turns clockwise only, so it is not finesse-perfect, but it wastes far less than a hand
    expect(bot.finesseMean).toBeLessThan(hand.finesseMean);
    expect(bot.maxActsPerStep).toBeGreaterThan(hand.maxActsPerStep);
    expect(bot.placeMean).toBeLessThan(hand.placeMean);
  });
});
