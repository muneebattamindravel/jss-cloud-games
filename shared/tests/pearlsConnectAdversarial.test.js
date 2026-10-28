'use strict';

/**
 * Pearls Connect adversarial: forged, stacked, rewound, malformed and flooded
 * traces must score no more than the chains they really contain earn, and a
 * refusal never zeroes an honest run. The rules' edges are tested on
 * hand-placed boards with literal answers, because no corpus lands on them.
 */
const H = require('./lib/pearlsConnectRealGame');
const W = require('./lib/pearlsConnectWorld');
const V = require('../anticheat/validators/pearlsConnect');
const F = require('../anticheat/humanness/features');
const S = V._sim;

const SEED = H.seedHex(11);
const start = (v = 2) => ({ type: 'input', payload: { kind: 'start', v } });
const chn = (n, step, cells, down, extra) => ({ type: 'input', payload: Object.assign({ kind: 'chain', n, step, down: down == null ? step : down, cells }, extra || {}) });
function run(events, opts = {}) {
  const st = V.init(Object.assign({ seed: SEED }, opts));
  const out = events.map((e) => V.processEvent(st, e));
  return { st, out, fin: V.finalize(st) };
}
// An honest run from the real game.
function honest(seed = SEED, pilot = 'good') {
  const g = H.boot({ seed });
  const r = H.fly(g, pilot, { rngSeed: 5 });
  return { trace: g.trace, score: r.score };
}
const H1 = honest();
function pairOf(grid) { for (let i = 0; i < 36; i++) { if (i % 6 < 5 && grid[i] === grid[i + 1]) return [i, i + 1]; if (i + 6 < 36 && grid[i] === grid[i + 6]) return [i, i + 6]; } return null; }
const firstPair = pairOf(S.initSim(SEED, 2).grid);
function chainedGrid(cells) { const s = S.initSim(SEED, 2); for (let i = 0; i < 10; i++) S.stepSim(s); S.chainSim(s, cells); return s.grid; }

describe('Pearls Connect validator: the server computes the score, the client claims nothing', () => {
  test('an honest trace scores exactly what the game showed', () => {
    const { fin } = run(H1.trace);
    expect(H1.score).toBeGreaterThan(500);
    expect(fin.score).toBe(H1.score);
    expect(fin.debug.rejects).toBe(0);
  });
  test('a claimed score in the payload is never read', () => {
    const forged = H1.trace.map((e) => ({ type: e.type, payload: Object.assign({}, e.payload, { score: 99999, points: 500, pts: 900, loop: true }) }));
    expect(run(forged).fin.score).toBe(H1.score);
  });
  test('no start marker: nothing scores', () => {
    expect(run(H1.trace.filter((e) => e.payload.kind !== 'start')).fin.score).toBe(0);
  });
  test('a v1 marker is not a replay and scores zero', () => {
    expect(run([start(1)].concat(H1.trace.slice(1))).fin.score).toBe(0);
  });
  test('a second start marker cannot reset the run', () => {
    const ev = H1.trace.slice();
    ev.splice(Math.floor(ev.length / 2), 0, start(2));
    expect(run(ev).fin.score).toBe(H1.score);
  });
  test('a trace of no chains scores 0 and the clock still runs out', () => {
    const { fin } = run([start()]);
    expect(fin.score).toBe(0);
    expect(fin.gameOver).toBe(true);
    expect(fin.debug.steps).toBe(18000);
  });
});

describe('Pearls Connect validator: a refused input changes nothing and never zeroes', () => {
  test('a second chain on the same step is refused (no stacking)', () => {
    const sim = S.initSim(SEED, 2);
    const a = firstPair;
    const { out, fin } = run([start(), chn(0, 10, a), chn(1, 10, pairOf(chainedGrid(a)))]);
    expect(out[1].reason).toBeUndefined();
    expect(out[2].reason).toBe('refused');
    expect(fin.debug.chains).toBe(1);
    expect(sim.grid.length).toBe(36);
  });
  test('a hundred chains on one step buy one chain', () => {
    const ev = [start(), chn(0, 10, firstPair)];
    const g2 = chainedGrid(firstPair), p2 = pairOf(g2);
    for (let i = 0; i < 100; i++) ev.push(chn(1, 10, p2));
    const { fin } = run(ev);
    expect(fin.debug.chains).toBe(1);
    expect(fin.score).toBe(3);
  });
  test('steps may not go backwards', () => {
    const { out } = run([start(), chn(0, 30, firstPair), chn(1, 20, pairOf(chainedGrid(firstPair)))]);
    expect(out[2].reason).toBe('frame_regressed');
  });
  test('a chain out of order (wrong index) is refused', () => {
    const { out } = run([start(), chn(5, 10, firstPair)]);
    expect(out[1].reason).toBe('out_of_order');
  });
  test('the step a chain began must lie between the last chain and its own lift', () => {
    const p2 = pairOf(chainedGrid(firstPair));
    expect(run([start(), chn(0, 10, firstPair, 11)]).out[1].reason).toBe('bad_down');
    expect(run([start(), chn(0, 10, firstPair, 10)]).out[1].reason).toBeUndefined();
    expect(run([start(), chn(0, 10, firstPair, 0)]).out[1].reason).toBeUndefined();
    expect(run([start(), chn(0, 10, firstPair, 2), chn(1, 30, p2, 9)]).out[2].reason).toBe('bad_down');
    expect(run([start(), chn(0, 10, firstPair, 2), chn(1, 30, p2, 10)]).out[2].reason).toBeUndefined();
  });
  test.each([
    ['null step', { kind: 'chain', n: 0, step: null, down: 0, cells: [0, 1] }],
    ['string step', { kind: 'chain', n: 0, step: '60', down: 0, cells: [0, 1] }],
    ['negative step', { kind: 'chain', n: 0, step: -1, down: 0, cells: [0, 1] }],
    ['fraction', { kind: 'chain', n: 0, step: 60.5, down: 0, cells: [0, 1] }],
    ['NaN n', { kind: 'chain', n: NaN, step: 60, down: 0, cells: [0, 1] }],
    ['Infinity', { kind: 'chain', n: 0, step: Infinity, down: 0, cells: [0, 1] }],
    ['object n', { kind: 'chain', n: {}, step: 60, down: 0, cells: [0, 1] }],
    ['no down', { kind: 'chain', n: 0, step: 60, cells: [0, 1] }],
    ['cells not a list', { kind: 'chain', n: 0, step: 60, down: 0, cells: '0,1' }],
    ['cells too long', { kind: 'chain', n: 0, step: 60, down: 0, cells: new Array(38).fill(0) }],
  ])('malformed: %s', (_name, payload) => {
    const { out, fin } = run([start(), { type: 'input', payload }]);
    expect(out[1].reason).toBe('bad_chain');
    expect(fin.debug.chains).toBe(0);
  });
  test('malformed and refused events inside an honest run cost the player nothing', () => {
    const junk = [];
    for (const e of H1.trace) {
      junk.push(e);
      if (e.payload.kind === 'chain') {
        junk.push({ type: 'input', payload: { kind: 'chain', n: 'x', step: e.payload.step, down: 0, cells: [] } });
        junk.push(chn(e.payload.n + 1, e.payload.step, e.payload.cells));    // same step: refused
        junk.push(chn(e.payload.n + 1, e.payload.step, [0, 35]));
        junk.push({ type: 'input', payload: { kind: 'swipe' } });
        junk.push({ type: 'heartbeat' });
        junk.push(null);
      }
    }
    expect(run(junk).fin.score).toBe(H1.score);
  });
  test('a chain after the clock is refused, and the run scores what was earned', () => {
    const { out, fin } = run([start(), chn(0, 10, firstPair), chn(1, 18000, pairOf(chainedGrid(firstPair))), chn(1, 10 * 60 * 60 * 60, [0, 1])]);
    expect(out[2].reason).toBe('refused');    // the step the clock ends on: the rules refuse it
    expect(out[3].reason).toBe('over');       // past it: there is no such step
    expect(fin.score).toBe(3);
  });
  test('the input cap refuses further chains, it never zeroes', () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, start());
    st.inputCount = S.MAX_INPUTS;
    const r = V.processEvent(st, chn(0, 10, firstPair));
    expect(r.reason).toBe('input_cap');
    expect(r.accepted).toBe(true);
    expect(S.MAX_INPUTS).toBeGreaterThan(S.RUN_STEPS);   // above one chain on every step of a run
  });
  test('ten or more refusals mark the run suspicious without changing its score', () => {
    const ev = [start()];
    for (let i = 0; i < 12; i++) ev.push({ type: 'input', payload: { kind: 'chain', n: -1, step: 1, down: 0, cells: [] } });
    const { fin } = run(ev);
    expect(fin.suspicious).toBe('validator_rejects:12');
  });
});

describe('Pearls Connect validator: attacks that try to buy a better run', () => {
  test('replaying one honest trace against another seed scores what those chains earn there, nothing more', () => {
    const other = H.seedHex(12);
    const { fin } = run(H1.trace, { seed: other });
    const s = W.serverWorlds(other, W.chainsOf(H1.trace));
    expect(fin.score).toBe(s.sim.score);
    expect(fin.score).toBeLessThan(H1.score);
  });
  test('the elapsed cap stops the run-out, and refuses chains, past the session\'s real length', () => {
    const cap = Math.ceil((60 * 1.2 + 10) * 60);   // 4920 steps for a 60 s session
    const { out, fin } = run([start(), chn(0, 10, firstPair), chn(1, cap + 5, pairOf(chainedGrid(firstPair)))], { elapsedSecs: 60 });
    expect(out[2].reason).toBe('beyond_cap');
    expect(fin.debug.steps).toBe(cap);
    expect(fin.gameOver).toBe(false);
    expect(fin.score).toBe(3);
  });
  test('the work bound: a run-out never goes past the run\'s own end', () => {
    const st = V.init({ seed: SEED, maxDurationSecs: 3600 });
    V.processEvent(st, start());
    const t0 = Date.now();
    const fin = V.finalize(st);
    expect(fin.debug.steps).toBe(S.RUN_STEPS);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  test('a chain on every step (the machine) is accepted only as the rules allow, one a step', () => {
    const g = H.boot({ seed: SEED });
    const r = H.fly(g, 'bot', { rngSeed: 1 });
    const { fin } = run(g.trace);
    expect(fin.score).toBe(r.score);
    expect(fin.debug.chains).toBeLessThanOrEqual(S.RUN_STEPS);
    const steps = W.chainsOf(g.trace).map((t) => t.step);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
  });
  test('the fingerprint raw material is recorded, and a machine looks different from a hand', () => {
    const hand = run(H1.trace).fin.debug;
    expect(hand.gapMean).toBeGreaterThan(20);
    expect(hand.gapCv).toBeGreaterThan(0.1);
    expect(hand.dragMean).toBeGreaterThan(2);
    expect(hand.lenMean).toBeGreaterThan(2);
    const g = H.boot({ seed: SEED });
    H.fly(g, 'bot', { rngSeed: 1 });
    const bot = run(g.trace).fin.debug;
    expect(bot.dragMean).toBe(0);
    expect(bot.gapMean).toBeLessThan(5);
    expect(bot.loopSkipped).toBe(0);
    expect(hand.loopSkipped + hand.loops).toBeGreaterThan(0);
  });
  test('a loop left on the board is recorded, exactly once per chain that ignored it', () => {
    // find an opening board with a 2 x 2 loop, then take a pair of another colour
    for (let i = 0; i < 2000; i++) {
      const seed = H.seedHex(70000 + i), g = S.initSim(seed, 2).grid;
      if (!S.squareLoop(g)) continue;
      let sq = -1;
      for (let r = 0; r < 5 && sq < 0; r++) for (let c = 0; c < 5; c++) { const j = r * 6 + c; if (g[j] === g[j + 1] && g[j] === g[j + 6] && g[j] === g[j + 7]) { sq = j; break; } }
      let pr = null;
      for (let j = 0; j < 36 && !pr; j++) { if (g[j] === g[sq]) continue; if (j % 6 < 5 && g[j] === g[j + 1]) pr = [j, j + 1]; else if (j + 6 < 36 && g[j] === g[j + 6]) pr = [j, j + 6]; }
      if (!pr) continue;
      const st = V.init({ seed });
      V.processEvent(st, start());
      V.processEvent(st, chn(0, 10, pr));
      expect(V.finalize(st).debug.loopSkipped).toBe(1);
      const st2 = V.init({ seed });
      V.processEvent(st2, start());
      V.processEvent(st2, chn(0, 10, [sq, sq + 1, sq + 7, sq + 6, sq]));
      const d2 = V.finalize(st2).debug;
      expect(d2.loopSkipped).toBe(0);
      expect(d2.loops).toBe(1);
      return;
    }
    throw new Error('no opening board with a 2 x 2 loop in 2000 seeds');
  });
  test('the humanness extractor reads every chain as one input', () => {
    const prev = F.GAME_INPUTS['pearls-connect'];
    F.GAME_INPUTS['pearls-connect'] = { kinds: ['chain'], time: 'step' };   // the one-line hunk for integration
    try {
      const f = F.extractFeatures('pearls-connect', H1.trace, { score: H1.score, elapsedSecs: 305 });
      expect(f.inputs).toBe(W.chainsOf(H1.trace).length);
    } finally { if (prev) F.GAME_INPUTS['pearls-connect'] = prev; else delete F.GAME_INPUTS['pearls-connect']; }
  });
});

describe('Pearls Connect rules at their exact edges (literals, never read from the rules)', () => {
  // A hand-placed board: `rows` are six strings of six kinds, top row first.
  function board(rows) {
    const sim = S.initSim(SEED, 2);
    sim.grid = rows.join('').split('').map(Number);
    sim.step = 5;
    return sim;
  }
  const ALL0 = ['000000', '000000', '000000', '000000', '000000', '000000'];
  const CHECK = ['010101', '101010', '010101', '101010', '010101', '101010'];

  test('neighbours are up, down, left and right; never diagonal, never across a row end', () => {
    expect(S.readChain(board(ALL0).grid, [0, 1])).not.toBe(null);
    expect(S.readChain(board(ALL0).grid, [0, 6])).not.toBe(null);
    expect(S.readChain(board(ALL0).grid, [0, 7])).toBe(null);
    expect(S.readChain(board(ALL0).grid, [5, 6])).toBe(null);     // row 0 end to row 1 start
    expect(S.readChain(board(ALL0).grid, [6, 5])).toBe(null);
    expect(S.readChain(board(ALL0).grid, [35, 29])).not.toBe(null);
    expect(S.readChain(board(ALL0).grid, [30, 35])).toBe(null);
  });
  test('cells off the board, fractions, strings and a lone pearl are not chains', () => {
    for (const bad of [[-1, 0], [35, 36], [0, 1.5], ['0', '1'], [0], [], [0, null], [true, 1], [0, Infinity], [NaN, 0]]) expect(S.readChain(board(ALL0).grid, bad)).toBe(null);
  });
  test('a chain off the board (cells that line up below or above it) scores nothing', () => {
    // off the board two cells read as one "colour" (nothing) and as neighbours
    for (const bad of [[36, 42], [42, 48, 54], [-6, -12], [-1, -7]]) {
      const b = board(ALL0);
      expect(S.chainSim(b, bad)).toBe(false);
      expect(b.score).toBe(0);
      expect(b.grid.length).toBe(36);
    }
    const { out, fin } = run([start(), chn(0, 10, [36, 42]), chn(0, 11, [-6, -12])]);
    expect(out[1].reason).toBe('refused');
    expect(out[2].reason).toBe('refused');
    expect(fin.score).toBe(0);
  });
  test('one colour only', () => {
    const b = board(['010000', '000000', '000000', '000000', '000000', '000000']);
    expect(S.readChain(b.grid, [0, 1])).toBe(null);
    expect(S.readChain(b.grid, [2, 3])).not.toBe(null);
  });
  test('a pearl twice is refused, except a last pearl closing a loop of four or more', () => {
    const g = board(ALL0).grid;
    expect(S.readChain(g, [0, 1, 0])).toBe(null);                 // straight back: not a loop
    expect(S.readChain(g, [0, 1, 7, 6, 0])).toEqual({ kind: 0, loop: true, n: 4 });
    expect(S.readChain(g, [2, 0, 1, 7, 6, 0])).toBe(null);        // 2 is not next to 0
    expect(S.readChain(g, [12, 6, 0, 1, 7, 6])).toEqual({ kind: 0, loop: true, n: 5 });   // a lasso: tail, then a loop
    expect(S.readChain(g, [0, 1, 7, 6, 0, 1])).toBe(null);        // nothing after the closing pearl
    expect(S.readChain(g, [0, 1, 2, 8, 7, 1, 0])).toBe(null);     // a repeat that is not last
    expect(S.readChain(g, [0, 1, 2, 3, 9, 8, 7, 6, 0])).toEqual({ kind: 0, loop: true, n: 8 });
  });
  test('points: n pearls pay n(n+1)/2; a loop pays double on every pearl of its colour', () => {
    const b = board(['110000', '112222', '333333', '444444', '222222', '333344']);
    expect(S.chainSim(b, [0, 1])).toBe(true);
    expect(b.score).toBe(3);
    const l = board(['110000', '112222', '333333', '444444', '222222', '333344']);
    expect(S.chainSim(l, [0, 1, 7, 6, 0])).toBe(true);
    expect(l.score).toBe(20);                                      // 4 pearls: 10, doubled
    expect(l.events[0].cells).toEqual([0, 1, 7, 6]);
    const z = board(['110000', '112222', '333333', '444444', '222222', '333344']);
    expect(S.chainSim(z, [2, 3, 4, 5])).toBe(true);
    expect(z.score).toBe(10);
    const w = board(['110001', '112222', '333333', '444444', '222222', '333344']);
    expect(S.chainSim(w, [0, 1, 7, 6, 0])).toBe(true);
    expect(w.score).toBe(30);                                      // the 1 at cell 5 goes too: 5 pearls, 15, doubled
    expect(w.events[0].cells).toEqual([0, 1, 7, 6, 5]);
  });
  test('gravity: pearls fall straight down in order, new ones come in at the top', () => {
    const b = board(['012340', '123401', '234012', '340123', '401234', '012341']);
    expect(S.chainSim(b, [24, 30])).toBe(false);                   // 4 and 0: not one colour
    const c = board(['012340', '123401', '234012', '340123', '400234', '012341']);
    // column 1 cells 25 (0) and 31 (1) are not a pair; take the 0s at 24, 25 and 30
    expect(S.chainSim(c, [24, 25])).toBe(false);                   // 24 is 4
    const d = board(['012340', '123401', '234012', '340123', '000234', '012341']);
    expect(S.chainSim(d, [25, 24, 30])).toBe(true);
    expect(d.score).toBe(6);
    // column 0: rows 4 and 5 cleared; 0,1,2,3 fall two rows
    expect([0, 6, 12, 18, 24, 30].map((i) => d.grid[i]).slice(2)).toEqual([0, 1, 2, 3]);
    expect([0, 6, 12, 18, 24, 30].map((i) => d.events[0].from[i])).toEqual([-1, -1, 0, 6, 12, 18]);
    // column 1: row 4 cleared; 1,2,3,4 fall one row, row 5 stays
    expect([1, 7, 13, 19, 25, 31].map((i) => d.events[0].from[i])).toEqual([-1, 1, 7, 13, 19, 31]);
    expect(d.spawned).toEqual([8, 7, 6, 6, 6, 6]);
  });
  test('after a loop no new pearl is the loop\'s colour; after a chain it may be', () => {
    for (let s = 0; s < 400; s++) {
      for (let k = 0; k < 40; k++) expect(S.spawnKind(s * 977, k % 6, k, 2)).not.toBe(2);
    }
    let twos = 0;
    for (let s = 0; s < 400; s++) for (let k = 0; k < 40; k++) if (S.spawnKind(s * 977, k % 6, k, -1) === 2) twos++;
    expect(twos).toBeGreaterThan(2000);
    // every kind is still reachable while avoiding one
    const seen = new Set();
    for (let k = 0; k < 400; k++) seen.add(S.spawnKind(12345, 0, k, 2));
    expect([...seen].sort()).toEqual([0, 1, 3, 4]);
  });
  test('a pair: across the last column and the last row too, never across a row end', () => {
    expect(S.hasPair(board(CHECK).grid)).toBe(false);
    const g = board(CHECK).grid.slice(); g[35] = g[34]; expect(S.hasPair(g)).toBe(true);
    const h = board(CHECK).grid.slice(); h[35] = h[29]; expect(S.hasPair(h)).toBe(true);
    const k = board(CHECK).grid.slice(); k[0] = 7; k[35] = 7; expect(S.hasPair(k)).toBe(false);
    const m = board(['010102', '201010', '010101', '101010', '010101', '101010']).grid;   // 5 and 6 are both 2
    expect(S.hasPair(m)).toBe(false);
  });
  test('the clock: a chain on the last step counts, on the step the clock ends it does not', () => {
    const b = board(ALL0);
    b.step = 17999;
    expect(S.chainSim(b, [0, 1])).toBe(true);
    S.stepSim(b);
    expect(b.step).toBe(18000);
    expect(b.over).toBe(true);
    expect(S.chainSim(b, [6, 7])).toBe(false);
    S.stepSim(b);
    expect(b.step).toBe(18000);
  });
  test('one chain a step: the next step is free again', () => {
    const b = board(ALL0);
    expect(S.chainSim(b, [0, 1])).toBe(true);
    expect(S.chainSim(b, [6, 7])).toBe(false);
    S.stepSim(b);
    expect(S.chainSim(b, [6, 7])).toBe(true);
    expect(b.chains).toBe(2);
    expect(b.lastStep).toBe(6);
  });
  test('a board left with no pair is reshuffled at once, by the seed', () => {
    // Five checkered rows over a row of 2s: taking the 2s drops every column
    // one row, so the checker survives and only the six new top pearls can
    // make a pair. Some seed's refill makes none, and the board must shuffle.
    const sim = S.initSim(SEED, 2);
    let found = null;
    for (let a = 0; a < 400 && !found; a++) {
      const b = board(CHECK.slice(0, 5).concat(['222222']));
      b.seed = a * 7919;
      expect(S.chainSim(b, [30, 31, 32, 33, 34, 35])).toBe(true);
      if (b.events[0].shuffled) found = b;
    }
    expect(found).not.toBe(null);
    expect(found.shuffles).toBeGreaterThan(0);
    expect(S.hasPair(found.grid)).toBe(true);
    expect(sim.shuffles).toBe(0);
  });
});
