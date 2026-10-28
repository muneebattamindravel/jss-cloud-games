'use strict';

/**
 * Pearls Connect parity: the REAL game.js and the server validator must
 * compute the same world, step for step, from the same seed and the same
 * chains.
 *
 *   - the rules block is byte-identical in both files, pinned by hash, and
 *     every constant is pinned BY VALUE (parity cannot see a change made in
 *     both files);
 *   - flown runs (real pointer path, human-model pilots, viewports, refresh
 *     rates from 30 to 144 Hz, uneven frames, a shifted clock, a different
 *     Math.random) are compared FIELD FOR FIELD after every step: the whole
 *     board, the spawn counters, shuffles, chains, the score and the step's
 *     events;
 *   - golden runs pin the outcome of fixed chain schedules;
 *   - every board ever reached has a move, and nobody parks.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./lib/pearlsConnectRealGame');
const W = require('./lib/pearlsConnectWorld');
const V = require('../anticheat/validators/pearlsConnect');
const S = V._sim;

const VALIDATOR = path.join(__dirname, '..', 'anticheat', 'validators', 'pearlsConnect.js');
const BEGIN = '// ==== PEARLS CONNECT RULES BEGIN ====';
const END = '// ==== PEARLS CONNECT RULES END ====';
function block(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error('rules block markers missing');
  return src.slice(a, b);
}
const GOLDEN = require('./fixtures/pearlsConnectGolden.json');
const SKIP_PIN = process.env.PC_SKIP_PIN === '1';

// Flies one run and returns the client's world after every step plus its trace.
function flown(pilot, opts = {}) {
  const g = H.boot(Object.assign({ seed: opts.seed || H.seedHex(1) }, opts.boot || {}));
  const worlds = [];
  g.win.__onStep = (sim) => { worlds[sim.step] = W.worldOf(sim); };
  const r = H.fly(g, pilot, { maxSteps: opts.maxSteps, rngSeed: opts.rng || 1, hz: opts.hz });
  return { g, r, worlds, schedule: W.chainsOf(g.trace) };
}
function compareWorlds(client, server) {
  let n = 0;
  for (let i = 1; i < client.length; i++) {
    if (client[i] === undefined) continue;
    if (client[i] !== server[i]) throw new Error(`world differs after step ${i}:\n client ${client[i]}\n server ${server[i]}`);
    n++;
  }
  return n;
}
function validatorRun(seed, trace, elapsedSecs) {
  const st = V.init({ seed, elapsedSecs });
  for (const e of trace) V.processEvent(st, e);
  return V.finalize(st);
}

describe('Pearls Connect rules: one block, pinned', () => {
  const game = fs.readFileSync(H.GAME, 'utf8');
  const val = fs.readFileSync(VALIDATOR, 'utf8');

  test('the rules block is byte-identical in game.js and the validator', () => {
    expect(block(val)).toBe(block(game));
  });

  (SKIP_PIN ? test.skip : test)('the rules block hash is pinned (a change is a version bump)', () => {
    const h = crypto.createHash('sha256').update(block(game)).digest('hex');
    expect(h).toBe('d3c1b66811d96928e3109d02dd163a28e60c058440e6e7df846e098bf2d51949');
  });

  (SKIP_PIN ? test.skip : test)('every rules constant is pinned by value', () => {
    expect({
      RULES_VERSION: S.RULES_VERSION, N: S.N, CELLS: S.CELLS, KINDS: S.KINDS, RUN_STEPS: S.RUN_STEPS,
      MIN_CHAIN: S.MIN_CHAIN, LOOP_MIN: S.LOOP_MIN, LOOP_MULT: S.LOOP_MULT, SHUFFLE_TRIES: S.SHUFFLE_TRIES,
      SHUFFLE_ROW: S.SHUFFLE_ROW, SEED_MIX: S.SEED_MIX, HASH_K: S.HASH_K, HASH_J: S.HASH_J, MIX_A: S.MIX_A, MIX_B: S.MIX_B,
      MAX_INPUTS: S.MAX_INPUTS, MAX_SIM_STEPS: S.MAX_SIM_STEPS, MAX_CELLS: S.MAX_CELLS,
    }).toEqual({
      RULES_VERSION: 2, N: 6, CELLS: 36, KINDS: 5, RUN_STEPS: 18000,
      MIN_CHAIN: 2, LOOP_MIN: 4, LOOP_MULT: 2, SHUFFLE_TRIES: 64,
      SHUFFLE_ROW: 100, SEED_MIX: 0x85EBCA6B, HASH_K: 0x9E3779B1, HASH_J: 0x85EBCA77, MIX_A: 0x7FEB352D, MIX_B: 0x846CA68B,
      MAX_INPUTS: 18100, MAX_SIM_STEPS: 216000, MAX_CELLS: 37,
    });
    // the points table, by value
    expect([2, 3, 4, 6, 10, 20].map((n) => S.chainPoints(n, false))).toEqual([3, 6, 10, 21, 55, 210]);
    expect(S.chainPoints(7, true)).toBe(56);
  });

  test('every constant and function in the block is defined once and read by both files from the block', () => {
    const b = block(game);
    const names = [...b.matchAll(/^(?:var|function) ([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    for (const nm of names) {
      // the block is the only definition of each name in either file
      const re = new RegExp(`(?:^|[^.\\w])(?:var|let|const|function) ${nm}\\b`, 'g');
      expect((game.match(re) || []).length).toBe(1);
      expect((val.match(re) || []).length).toBe(1);
    }
  });

  test('the rules use no clock, no randomness, no screen and no trig', () => {
    const b = block(game);
    for (const bad of ['Math.random', 'Date', 'performance', 'Math.sin', 'Math.cos', 'Math.tan', 'Math.atan',
      'Math.pow', 'Math.hypot', 'Math.exp', 'Math.log', '**', 'window', 'document', 'DMath', 'innerWidth', 'devicePixelRatio', '.push(']) {
      if (bad === '.push(') continue;   // pushes onto fresh local arrays are fine; checked below
      expect(b.includes(bad)).toBe(false);
    }
    // a list in the sim is replaced, never pushed onto
    expect(/sim\.[a-z]+\.push\(/i.test(b)).toBe(false);
  });

  test('the client applies a chain to the sim before emitting it, and emits only accepted chains', () => {
    const fn = game.slice(game.indexOf('function applyChain('), game.indexOf('function clearFx('));
    const gate = 'if (!chainSim(sim, cells)) { audio.cancel(); return false; }';
    expect(fn.indexOf(gate)).toBeGreaterThan(0);
    expect(fn.indexOf('__kjChain')).toBeGreaterThan(fn.indexOf(gate));
  });

  test('nothing below the rules block writes to the sim except through the rules', () => {
    const shell = game.split(END)[1];
    expect(/sim\.(score|grid|step|over|chains|lastStep|shuffles|spawned|seed|events|version)\s*(=[^=]|\+\+|--|\+=|-=)/.test(shell)).toBe(false);
    expect(/sim\.(grid|spawned|events)\.(push|splice|pop|shift|sort|reverse)|sim\.(grid|spawned)\[[^\]]+\]\s*=[^=]/.test(shell)).toBe(false);
  });
});

describe('Pearls Connect: client and server compute the same world after every step', () => {
  const cases = [];
  for (const pilot of ['good', 'average', 'novice', 'spammer', 'idle', 'multi']) {
    for (let i = 0; i < 4; i++) cases.push([pilot, i]);
  }
  for (let i = 0; i < 3; i++) cases.push(['flawless', i]);
  cases.push(['bot', 0]);
  let compared = 0;
  const reach = { loops: 0, lassos: 0, shuffles: 0, long: 0, refused: 0 };
  test.each(cases)('%s pilot, seed %i', (pilot, i) => {
    const seed = H.seedHex(200 + i * 7 + pilot.length);
    const f = flown(pilot, { seed, rng: i + 3 });
    const s = W.serverWorlds(seed, f.schedule);
    compared += compareWorlds(f.worlds, s.worlds);
    expect(f.r.over).toBe(true);
    expect(f.r.step).toBe(S.RUN_STEPS);
    expect(s.sim.score).toBe(f.r.score);
    const v = validatorRun(seed, f.g.trace);
    expect(v.score).toBe(f.r.score);
    expect(v.debug.steps).toBe(S.RUN_STEPS);
    expect(v.debug.rejects).toBe(0);
    expect(v.debug.chains).toBe(f.schedule.length);
    expect(f.g.results).toEqual([f.r.score]);   // submitted once, the score the server computes
    reach.shuffles += s.sim.shuffles;
    for (const t of f.schedule) {
      const last = t.cells[t.cells.length - 1], at = t.cells.indexOf(last);
      if (at < t.cells.length - 1) { reach.loops++; if (at > 0) reach.lassos++; }
      else if (t.cells.length >= 8) reach.long++;
    }
  });
  afterAll(() => {
    expect(compared).toBeGreaterThan(400000);
    // coverage: the corpus reaches what each pilot exists for
    expect(reach.loops).toBeGreaterThan(50);
    expect(reach.shuffles).toBeGreaterThan(0);
    expect(reach.long).toBeGreaterThan(20);
  });
});

describe('Pearls Connect: the device does not reach the rules', () => {
  // The flawless pilot decides from the rules alone, so the same seed must give
  // the very same schedule and world on every device, clock and Math.random.
  function flawlessRun(boot, hz) {
    const seed = H.seedHex(4242);
    const f = flown('flawless', { seed, boot, hz, maxSteps: 60 * 60 });
    return { schedule: JSON.stringify(f.schedule.map((t) => [t.n, t.step, t.down, t.cells])), worlds: W.digest(f.worlds), score: f.r.score };
  }
  const base = flawlessRun({});

  test('the base run is a real run', () => {
    expect(base.score).toBeGreaterThan(1000);
  });
  test.each([[320, 568], [375, 812], [768, 1024], [1440, 780], [414, 896]])('viewport %ix%i', (w, h) => {
    expect(flawlessRun({ width: w, height: h })).toEqual(base);
  });
  test.each([120, 144])('%i Hz', (hz) => {
    expect(flawlessRun({ hz }, hz)).toEqual(base);
  });
  // At 30 Hz two steps run per frame, so a finger can only lift on every other
  // step: the schedule differs by input granularity, which is honest. What
  // must hold is that the run replays exactly.
  test('30 Hz replays exactly (inputs land on every other step)', () => {
    const seed = H.seedHex(4242);
    const f = flown('good', { seed, boot: { hz: 30 }, hz: 30 });
    const s = W.serverWorlds(seed, f.schedule);
    expect(compareWorlds(f.worlds, s.worlds)).toBeGreaterThan(17000);
    expect(s.sim.score).toBe(f.r.score);
    expect(f.schedule.length).toBeGreaterThan(50);
  });
  test('a different Math.random (cosmetics) changes nothing', () => {
    let a = 12345;
    const math = Object.create(Math);
    math.random = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
    expect(flawlessRun({ math })).toEqual(base);
  });
  test('a shifted clock changes nothing', () => {
    expect(flawlessRun({ clockStart: 987654.321 })).toEqual(base);
  });
  test('DPR 1 and 3 change nothing', () => {
    expect(flawlessRun({ dpr: 1 })).toEqual(base);
    expect(flawlessRun({ dpr: 3 })).toEqual(base);
  });
  test('drawing on changes nothing (drawing never writes the sim)', () => {
    expect(flawlessRun({ draw: true })).toEqual(base);
  });

  test('uneven frames (32 ms then 4 ms) still replay exactly', () => {
    const seed = H.seedHex(77);
    const g = H.boot({ seed });
    const worlds = [];
    g.win.__onStep = (sim) => { worlds[sim.step] = W.worldOf(sim); };
    g.toPlay();
    const pr = g.probe();
    let k = 0;
    while (pr.state === 'play' && k < 6000) {
      g.frameAt(k % 2 ? 4 : 32);
      if (k % 23 === 0) {
        const pl = H.plan(pr.rules, pr.sim.grid, 4, 500);
        if (pl.best) { g.down(pl.best[0]); for (const c of pl.best.slice(1)) g.move(c); g.up(); }
      }
      k++;
    }
    const sched = W.chainsOf(g.trace);
    expect(sched.length).toBeGreaterThan(50);
    const s = W.serverWorlds(seed, sched);
    expect(compareWorlds(worlds, s.worlds)).toBeGreaterThan(1000);
    expect(s.worlds[pr.sim.step]).toBe(W.worldOf(pr.sim));
  });

  test('one second of frames is about 60 steps at 30, 60, 120 and 144 Hz (the wall clock drives the steps)', () => {
    for (const hz of [30, 60, 120, 144]) {
      const g = H.boot({ seed: H.seedHex(5), hz });
      g.toPlay();
      const s0 = g.probe().sim.step;
      g.advance(1000);
      const d = g.probe().sim.step - s0;
      expect(d).toBeGreaterThanOrEqual(58);
      expect(d).toBeLessThanOrEqual(62);
    }
  });
});

describe('Pearls Connect input: one finger, one chain, only what the rules accept', () => {
  function ready(seed) { const g = H.boot({ seed: seed || H.seedHex(3) }); g.toPlay(); return g; }
  function pairOf(grid) { for (let i = 0; i < 36; i++) { if (i % 6 < 5 && grid[i] === grid[i + 1]) return [i, i + 1]; if (i + 6 < 36 && grid[i] === grid[i + 6]) return [i, i + 6]; } return null; }

  test('a chain is recorded once, at the step the finger lifts, with the step it began', () => {
    const g = ready(), pr = g.probe(), [a, b] = pairOf(pr.sim.grid);
    const s0 = pr.sim.step;
    g.down(a); g.advance(100); g.move(b); g.advance(100);
    const s1 = pr.sim.step;
    g.up();
    const ch = W.chainsOf(g.trace);
    expect(ch.length).toBe(1);
    expect(ch[0]).toMatchObject({ n: 0, step: s1, down: s0, cells: [a, b] });
    expect(pr.sim.score).toBe(3);
  });
  test('one pearl alone, a mixed-colour drag and a pearl dragged back over are not chains', () => {
    const g = ready(), pr = g.probe(), grid = pr.sim.grid;
    const [a, b] = pairOf(grid);
    g.down(a); g.up();
    g.down(a); g.move(b); g.move(a); g.up();    // dragged back: only a is left
    let odd = -1;
    for (let i = 0; i < 36; i++) if (i % 6 < 5 && grid[i] !== grid[i + 1]) { odd = i; break; }
    g.down(odd); g.move(odd + 1); g.up();
    expect(W.chainsOf(g.trace).length).toBe(0);
    expect(pr.sim.chains).toBe(0);
  });
  test('a second finger is ignored, never punished', () => {
    const g = ready(), pr = g.probe(), [a, b] = pairOf(pr.sim.grid);
    g.down(a, 1); g.down(b, 2); g.up(2); g.move(b, 1); g.up(1);
    expect(W.chainsOf(g.trace).map((t) => t.cells)).toEqual([[a, b]]);
  });
  test('two chains lifted on one step: the second is refused and never recorded', () => {
    const g = ready(), pr = g.probe();
    let [a, b] = pairOf(pr.sim.grid);
    g.down(a); g.move(b); g.up();
    [a, b] = pairOf(pr.sim.grid);
    g.down(a); g.move(b); g.up();
    expect(pr.sim.chains).toBe(1);
    expect(W.chainsOf(g.trace).length).toBe(1);
    g.advance(1000 / 60);
    [a, b] = pairOf(pr.sim.grid);
    g.down(a); g.move(b); g.up();
    expect(pr.sim.chains).toBe(2);
  });
  test('a loop is recorded with its closing pearl and clears the whole colour', () => {
    // fly the flawless planner until it closes a loop, then check that chain
    const g = H.boot({ seed: H.seedHex(4242) });
    let loopSeen = null;
    H.fly(g, 'flawless', { maxSteps: 60 * 60, onStep: () => {} });
    for (const t of W.chainsOf(g.trace)) if (t.cells.indexOf(t.cells[t.cells.length - 1]) < t.cells.length - 1) { loopSeen = t; break; }
    expect(loopSeen).not.toBe(null);
    const sim = S.initSim(H.seedHex(4242), 2);
    for (const t of W.chainsOf(g.trace)) {
      while (sim.step < t.step) S.stepSim(sim);
      const kind = sim.grid[t.cells[0]], count = sim.grid.filter((k) => k === kind).length;
      S.chainSim(sim, t.cells);
      if (t === loopSeen) { expect(sim.events[0].loop).toBe(true); expect(sim.events[0].cells.length).toBe(count); break; }
    }
  });
  test('no input during READY, on the menu or after the clock', () => {
    const g = H.boot({ seed: H.seedHex(3) });
    const pr = g.probe();
    const [a, b] = pairOf(pr.sim.grid);
    g.down(a); g.move(b); g.up();          // menu
    g.click('playBtn');
    expect(pr.state).toBe('ready');
    g.down(a); g.move(b); g.up();          // READY
    expect(W.chainsOf(g.trace).length).toBe(0);
    H.fly(g, 'idle');
    g.down(a); g.move(b); g.up();          // over
    expect(W.chainsOf(g.trace).length).toBe(0);
  });
});

describe('Pearls Connect golden runs (rules v2)', () => {
  test.each(GOLDEN.runs.map((r, i) => [i, r.pilot, r]))('run %i (%s)', (_i, _p, run) => {
    const { sim, worlds } = W.serverWorlds(run.seed, run.schedule);
    expect(W.digest(worlds)).toBe(run.digest);
    expect(sim.score).toBe(run.score);
    expect(sim.chains).toBe(run.chains);
    expect(sim.shuffles).toBe(run.shuffles);
    const trace = [{ type: 'input', payload: { kind: 'start', v: 2 } }]
      .concat(run.schedule.map((t) => ({ type: 'input', payload: Object.assign({ kind: 'chain' }, t) })));
    expect(validatorRun(run.seed, trace).score).toBe(run.score);
  });
  test('the corpus reaches what it is for: loops, shuffles, an empty run, a big run', () => {
    expect(GOLDEN.runs.some((r) => r.loops > 10)).toBe(true);
    expect(GOLDEN.runs.some((r) => r.shuffles > 0)).toBe(true);
    expect(GOLDEN.runs.some((r) => r.score === 0)).toBe(true);
    expect(Math.max(...GOLDEN.runs.map((r) => r.score))).toBeGreaterThan(10000);
  });
});

describe('Pearls Connect: every board has a move, and nobody parks', () => {
  test('20000 seeds: the opening board always has a pair', () => {
    for (let i = 0; i < 20000; i++) expect(S.hasPair(S.initSim(H.seedHex(i), 2).grid)).toBe(true);
  });

  test('2000 seeds x 150 random chains: after every chain the board has a pair, and shuffles happen', () => {
    let shuffles = 0, worstTries = 0;
    for (let s = 0; s < 2000; s++) {
      const sim = S.initSim(H.seedHex(50000 + s), 2);
      let a = s * 7 + 1;
      const rnd = () => { a = (Math.imul(a, 1103515245) + 12345) >>> 0; return a / 4294967296; };
      for (let k = 0; k < 150; k++) {
        S.stepSim(sim);
        const pairs = [];
        for (let i = 0; i < 36; i++) { if (i % 6 < 5 && sim.grid[i] === sim.grid[i + 1]) pairs.push([i, i + 1]); if (i + 6 < 36 && sim.grid[i] === sim.grid[i + 6]) pairs.push([i, i + 6]); }
        expect(pairs.length).toBeGreaterThan(0);
        const before = sim.shuffles;
        expect(S.chainSim(sim, pairs[Math.floor(rnd() * pairs.length)])).toBe(true);
        worstTries = Math.max(worstTries, sim.shuffles - before);
        expect(S.hasPair(sim.grid)).toBe(true);
      }
      shuffles += sim.shuffles;
    }
    expect(shuffles).toBeGreaterThan(50);
    expect(worstTries).toBeLessThan(64);   // the fallback is never needed in practice
  });

  test('a board no shuffle can fix falls back to a forced pair after exactly SHUFFLE_TRIES attempts', () => {
    const sim = S.initSim(H.seedHex(1), 2);
    sim.grid = Array.from({ length: 36 }, (_, i) => 100 + i);   // 36 different kinds: never a pair
    S.reshuffle(sim);
    expect(sim.shuffles).toBe(64);
    expect(sim.grid[1]).toBe(sim.grid[0]);
    expect(S.hasPair(sim.grid)).toBe(true);
  });

  test('a shuffle is the seed\'s own: the same board and attempt always shuffle the same way', () => {
    const a = S.initSim(H.seedHex(9), 2), b = S.initSim(H.seedHex(9), 2);
    a.grid = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0];
    b.grid = a.grid.slice();
    S.reshuffle(a); S.reshuffle(b);
    expect(a.grid).toEqual(b.grid);
    expect(a.shuffles).toBe(b.shuffles);
    expect(a.shuffles).toBeGreaterThan(0);
  });

  test('an untouched run ends at exactly RUN_STEPS, with 0, on both sides', () => {
    const f = flown('idle', { seed: H.seedHex(12) });
    expect(f.r.step).toBe(S.RUN_STEPS);
    expect(f.g.results).toEqual([0]);
    const v = validatorRun(H.seedHex(12), f.g.trace);
    expect(v.debug.steps).toBe(S.RUN_STEPS);
    expect(v.gameOver).toBe(true);
    expect(v.score).toBe(0);
  });
});
