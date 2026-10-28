'use strict';

/**
 * Rang Bharo parity: the REAL game.js and the server validator must compute
 * the same world, step for step, from the same seed and the same moves.
 *
 *   - the rules block is byte-identical in both files, pinned by hash, and
 *     every constant is pinned BY VALUE (parity cannot see a change made in
 *     both files);
 *   - flown runs (real input path, human-model and lazy pilots, viewports,
 *     refresh rates from 30 to 144 Hz, uneven frames, a shifted clock, a
 *     different Math.random, a hidden tab) are compared FIELD FOR FIELD after
 *     every step: ball, slide, buffer, pause, painted set, maze, score, events;
 *   - golden runs pin the outcome of fixed move schedules;
 *   - every maze is solvable by construction and nobody parks past the clock.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./lib/rangBharoRealGame');
const W = require('./lib/rangBharoWorld');
const V = require('../anticheat/validators/rangBharo');
const S = V._sim;

const VALIDATOR = path.join(__dirname, '..', 'anticheat', 'validators', 'rangBharo.js');
const BEGIN = '// ==== RANG BHARO RULES BEGIN ====';
const END = '// ==== RANG BHARO RULES END ====';
function block(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error('rules block markers missing');
  return src.slice(a, b);
}
const GOLDEN = require('./fixtures/rangBharoGolden.json');
const SKIP_PIN = process.env.RB_SKIP_PIN === '1';

// Flies one run and returns the client's world after every step plus its trace.
function flown(pilot, opts = {}) {
  const g = H.boot(Object.assign({ seed: opts.seed || H.seedHex(1) }, opts.boot || {}));
  const worlds = [];
  g.win.__onStep = (sim) => { worlds[sim.step] = W.worldOf(sim); };
  const r = H.fly(g, pilot, { maxSteps: opts.maxSteps, rngSeed: opts.rng || 1, hz: opts.hz, keys: opts.keys });
  return { g, r, worlds, schedule: W.movesOf(g.trace) };
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

describe('Rang Bharo rules: one block, pinned', () => {
  const game = fs.readFileSync(H.GAME, 'utf8');
  const val = fs.readFileSync(VALIDATOR, 'utf8');

  test('the rules block is byte-identical in game.js and the validator', () => {
    expect(block(val)).toBe(block(game));
  });

  (SKIP_PIN ? test.skip : test)('the rules block hash is pinned (a change is a version bump)', () => {
    const h = crypto.createHash('sha256').update(block(game)).digest('hex');
    expect(h).toBe('df1076a7eb87d04d05d96ee4cf7384f608b4f4fb29efd8e12d969100bf3a722d');
  });

  (SKIP_PIN ? test.skip : test)('every rules constant is pinned by value', () => {
    expect({
      RULES_VERSION: S.RULES_VERSION, STEP_HZ: S.STEP_HZ, TIME_STEPS: S.TIME_STEPS, STEPS_PER_TILE: S.STEPS_PER_TILE,
      CLEAR_PAUSE: S.CLEAR_PAUSE, MAZE_BASE: S.MAZE_BASE, PERFECT_BASE: S.PERFECT_BASE, PERFECT_PER: S.PERFECT_PER,
      MAX_W: S.MAX_W, MAX_H: S.MAX_H, GEN_ATTEMPTS: S.GEN_ATTEMPTS, SOLVE_CAP: S.SOLVE_CAP, DX: S.DX, DY: S.DY,
      MAX_INPUTS: S.MAX_INPUTS, MAX_SIM_STEPS: S.MAX_SIM_STEPS,
    }).toEqual({
      RULES_VERSION: 1, STEP_HZ: 60, TIME_STEPS: 10800, STEPS_PER_TILE: 4, CLEAR_PAUSE: 54, MAZE_BASE: 10,
      PERFECT_BASE: 25, PERFECT_PER: 5, MAX_W: 11, MAX_H: 13, GEN_ATTEMPTS: 60, SOLVE_CAP: 60000,
      DX: [0, 1, 0, -1], DY: [-1, 0, 1, 0], MAX_INPUTS: 10900, MAX_SIM_STEPS: 216000,
    });
  });

  (SKIP_PIN ? test.skip : test)('the difficulty curve is pinned by value', () => {
    const row = (n) => [S.mazeDims(n).w, S.mazeDims(n).h, S.floorPercent(n), S.moveBudget(n), S.greed(n), S.minPar(n)];
    expect([1, 2, 3, 4, 5, 8, 10, 11, 12, 13, 14, 20, 40].map(row)).toEqual([
      [6, 6, 46, 7, 2, 4], [6, 7, 48, 9, 2, 5], [7, 7, 50, 10, 2, 5], [7, 8, 52, 12, 1, 6], [8, 8, 54, 13, 1, 6],
      [9, 10, 60, 18, 1, 8], [10, 11, 60, 21, 1, 9], [11, 11, 60, 22, 1, 9], [11, 12, 60, 22, 1, 10],
      [11, 12, 60, 22, 1, 10], [11, 13, 60, 22, 1, 10], [11, 13, 60, 22, 1, 10], [11, 13, 60, 22, 1, 10],
    ]);
  });

  test('the rules use no clock, no randomness, no screen and no trig', () => {
    const b = block(game);
    for (const bad of ['Math.random', 'Date', 'performance', 'Math.sin', 'Math.cos', 'Math.tan', 'Math.atan',
      'Math.pow', 'Math.hypot', 'Math.exp', 'Math.log', '**', 'window', 'document', 'DMath', 'innerWidth', 'devicePixelRatio', 'setTimeout']) {
      expect(b.includes(bad)).toBe(false);
    }
  });

  test('the client applies a move to the sim before emitting it, and emits only accepted moves', () => {
    const fn = game.slice(game.indexOf('function applyInput(d, live)'), game.indexOf('function stepOnce()'));
    expect(fn.indexOf('if (!inputDir(sim, d)) return false;')).toBeGreaterThan(0);
    expect(fn.indexOf('__kjMove')).toBeGreaterThan(fn.indexOf('if (!inputDir(sim, d)) return false;'));
    expect(fn.indexOf('const step = sim.step, n = sim.inputs;')).toBeLessThan(fn.indexOf('inputDir(sim, d)'));
  });

  test('nothing below the rules block writes to the sim except through the rules', () => {
    const shell = game.split(END)[1];
    expect(/\bsim\.[a-zA-Z]+(\[[^\]]*\])?\s*(=[^=]|\+\+|--|\+=|-=)/.test(shell)).toBe(false);
    expect(/\bsim\.(painted|maze\.cells)\.(set|fill)\(/.test(shell)).toBe(false);
  });
});

describe('Rang Bharo: client and server compute the same world after every step', () => {
  const cases = [];
  for (const pilot of ['good', 'average', 'novice', 'bot', 'greedy', 'spammer', 'cycler', 'multi']) {
    for (let i = 0; i < 2; i++) cases.push([pilot, i]);
  }
  cases.push(['idle', 0], ['flawless', 0], ['flawless', 1]);
  let compared = 0;
  const seen = { buffered: 0, bump: 0, perfect: 0, imperfect: 0, pauseInput: 0, bigMaze: 0, inexact: 0, endMidSlide: 0 };
  test.each(cases)('%s pilot, seed %i', (pilot, i) => {
    const seed = H.seedHex(200 + i * 7 + pilot.length);
    const f = flown(pilot, { seed, rng: i + 3 });
    const s = W.serverWorlds(seed, f.schedule);
    compared += compareWorlds(f.worlds, s.worlds);
    expect(f.r.over).toBe(true);
    expect(s.sim.score).toBe(f.r.score);
    expect(s.sim.step).toBe(S.TIME_STEPS);
    const v = validatorRun(seed, f.g.trace, 200);
    expect(v.score).toBe(f.r.score);
    expect(v.debug.rejects).toBe(0);
    expect(v.debug.accepted).toBe(f.schedule.length);
    expect(f.g.results).toEqual([f.r.score]);   // submitted once, the score the server computes
    // what the corpus reaches
    for (let k = 1; k < f.worlds.length; k++) {
      const w = f.worlds[k]; if (!w) continue;
      if (w.includes('"k":"bump"')) seen.bump++;
      if (w.includes('"perfect":true')) seen.perfect++;
      if (w.includes('"perfect":false')) seen.imperfect++;
      if (w.includes('"exact":false')) seen.inexact++;
    }
    for (const t of f.schedule) {
      const before = f.worlds[t.step];
      if (!before) continue;
      const b = JSON.parse(before);
      if (b.dir >= 0) seen.buffered++;
      if (b.pause > 0) seen.pauseInput++;
    }
    if (f.r.sim.maze.w === S.MAX_W && f.r.sim.maze.h === S.MAX_H) seen.bigMaze++;
    const last = JSON.parse(f.worlds[S.TIME_STEPS]);
    if (last.dir >= 0) seen.endMidSlide++;
  });
  afterAll(() => {
    expect(compared).toBeGreaterThan(200000);
    // If a counter drops to zero, the constant behind it is untested again.
    for (const k of Object.keys(seen)) expect([k, seen[k] > 0]).toEqual([k, true]);
  });
});

describe('Rang Bharo: the device does not reach the rules', () => {
  // The flawless pilot decides from the rules alone, so the same seed must give
  // the very same schedule and world on every device, clock and Math.random.
  function flawlessRun(boot, hz) {
    const seed = H.seedHex(4242);
    const f = flown('flawless', { seed, boot, hz, maxSteps: 60 * 50 });
    return { schedule: JSON.stringify(f.schedule), worlds: W.digest(f.worlds), score: f.r.score };
  }
  const base = flawlessRun({});

  test.each([[320, 568], [375, 812], [768, 1024], [1440, 780], [414, 896]])('viewport %ix%i', (w, h) => {
    expect(flawlessRun({ width: w, height: h })).toEqual(base);
  });
  test.each([120, 144])('%i Hz', (hz) => {
    expect(flawlessRun({ hz }, hz)).toEqual(base);
  });
  test('30 Hz replays exactly (inputs land on every other step)', () => {
    const seed = H.seedHex(4242);
    const f = flown('good', { seed, boot: { hz: 30 }, hz: 30, maxSteps: 60 * 60 });
    const s = W.serverWorlds(seed, f.schedule);
    expect(compareWorlds(f.worlds, s.worlds)).toBeGreaterThan(1000);
    expect(s.sim.score).toBe(f.r.score);
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
  test('drawing on changes nothing (effects never write the sim)', () => {
    const f = (() => { const r = flawlessRun({ draw: true }); return r; })();
    expect(f).toEqual(base);
  });

  test('uneven frames (32 ms then 4 ms) still replay exactly', () => {
    const seed = H.seedHex(77);
    const g = H.boot({ seed });
    const worlds = [];
    g.win.__onStep = (sim) => { worlds[sim.step] = W.worldOf(sim); };
    g.start();
    const pr = g.probe();
    let k = 0;
    while (!pr.sim.over && k < 4000) {
      g.frameAt(k % 2 ? 4 : 32);
      if (k % 9 === 0) g.swipe(k % 4);
      k++;
    }
    const sched = W.movesOf(g.trace);
    expect(sched.length).toBeGreaterThan(50);
    const s = W.serverWorlds(seed, sched);
    expect(compareWorlds(worlds, s.worlds)).toBeGreaterThan(1000);
    expect(s.sim.score).toBe(pr.sim.score);
  });

  test('one second of frames is about 60 steps at 30, 60, 120 and 144 Hz (the wall clock drives the steps)', () => {
    for (const hz of [30, 60, 120, 144]) {
      const g = H.boot({ seed: H.seedHex(5), hz });
      g.start();
      const s0 = g.probe().sim.step;
      g.advance(1000);
      const d = g.probe().sim.step - s0;
      expect(d).toBeGreaterThanOrEqual(58);
      expect(d).toBeLessThanOrEqual(62);
    }
  });

  test('a hidden tab does not stop the clock: ten hidden seconds are about 600 steps', () => {
    const g = H.boot({ seed: H.seedHex(6) });
    g.start();
    const s0 = g.probe().sim.step;
    g.advanceHidden(10000);
    expect(g.probe().sim.step - s0).toBeGreaterThan(540);   // the backup clock pumps while hidden
    g.advance(1000 / 60);                                   // the tab comes back: one frame
    const d = g.probe().sim.step - s0;
    expect(d).toBeGreaterThanOrEqual(598);
    expect(d).toBeLessThanOrEqual(603);
  });

  test('keys and swipes are the same input', () => {
    const seed = H.seedHex(31);
    const f = flown('good', { seed, keys: true, rng: 9, maxSteps: 60 * 60 });
    const s = W.serverWorlds(seed, f.schedule);
    compareWorlds(f.worlds, s.worlds);
    expect(s.sim.score).toBe(f.r.score);
    expect(f.g.trace.length).toBeGreaterThan(50);
  });
});

describe('Rang Bharo input: one move at a time, one swipe one move', () => {
  function atRest() {
    const g = H.boot({ seed: H.seedHex(3) });
    g.start();
    const pr = g.probe(), R = pr.rules;
    const open = [0, 1, 2, 3].filter((d) => !R.blockedAt(pr.sim, pr.sim.bx, pr.sim.by, d));
    return { g, pr, R, open };
  }
  test('one swipe is one move, however long the finger keeps moving', () => {
    const { g, pr, open } = atRest();
    const d = open[0], DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
    g.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 400 });
    for (let k = 1; k <= 20; k++) g.fire('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 100 + DX[d] * 10 * k, clientY: 400 + DY[d] * 10 * k });
    g.fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 400 });
    g.advance(2000);
    expect(pr.sim.inputs).toBe(1);
    expect(W.movesOf(g.trace).length).toBe(1);
  });
  test('a swipe fires while the finger is still moving, before it lifts', () => {
    const { g, pr, open } = atRest();
    const d = open[0], DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
    g.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 400 });
    g.fire('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 100 + DX[d] * 20, clientY: 400 + DY[d] * 20 });
    g.advance(1000 / 60 * 2);
    expect(pr.sim.inputs).toBe(1);
    g.fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 100 + DX[d] * 20, clientY: 400 + DY[d] * 20 });
    g.advance(100);
    expect(pr.sim.inputs).toBe(1);
  });
  test('two swipes inside one frame are two moves on two steps, never one step', () => {
    const { g, pr, open } = atRest();
    g.swipe(open[0]); g.swipe((open[0] + 2) & 3);
    g.advance(1000 / 60 * 3);
    expect(pr.sim.inputs).toBe(2);
    const m = W.movesOf(g.trace);
    expect(m.length).toBe(2);
    expect(m[1].step).toBe(m[0].step + 1);
  });
  test('three swipes inside one frame keep the latest two (the first is dropped)', () => {
    const { g, pr, open } = atRest();
    const a = open[0], b = (open[0] + 1) & 3, c = (open[0] + 2) & 3;
    g.swipe(a); g.swipe(b); g.swipe(c);
    g.advance(1000 / 60 * 3);
    const m = W.movesOf(g.trace);
    expect(m.map((x) => x.dir)).toEqual([b, c]);
    expect(pr.sim.inputs).toBe(2);
  });
  test('a short flick counts, a jitter does not', () => {
    const { g, pr, open } = atRest();
    g.swipe(open[0], { flickOnly: true, len: 9 });
    g.advance(100);
    expect(pr.sim.inputs).toBe(1);
    g.advance(3000);
    g.swipe(open[0], { flickOnly: true, len: 5 });
    g.advance(100);
    expect(pr.sim.inputs).toBe(1);
  });
  test('four resting fingers and one swipe are one move', () => {
    const { g, pr, open } = atRest();
    for (let id = 1; id <= 4; id++) g.fire('pointerdown', { pointerType: 'touch', pointerId: 100 + id, clientX: 50 * id, clientY: 500 });
    g.swipe(open[0], { id: 200 });
    for (let id = 1; id <= 4; id++) g.fire('pointerup', { pointerType: 'touch', pointerId: 100 + id, clientX: 50 * id, clientY: 500 });
    g.advance(100);
    expect(pr.sim.inputs).toBe(1);
    const t = atRest();
    t.g.fire('pointerdown', { pointerType: 'touch', pointerId: 101, clientX: 50, clientY: 500 });
    t.g.swipe(t.open[0], { id: 300 });
    t.g.advance(100);
    expect(t.pr.sim.inputs).toBe(1);   // a resting thumb never blocks the swiping finger
  });
  test('swipes during a slide are buffered, only the latest kept, never stacked', () => {
    const { g, pr, R, open } = atRest();
    g.swipe(open[0]);
    g.advance(1000 / 60 * 2);
    expect(pr.sim.dir).toBe(open[0]);
    g.swipe(0); g.advance(1000 / 60);
    g.swipe(2); g.advance(1000 / 60);
    expect(pr.sim.queued).toBe(2);
    while (pr.sim.dir >= 0) g.advance(1000 / 60);
    g.advance(1000 / 60 * 2);
    expect(pr.sim.queued).toBe(-1);
    expect(pr.sim.totalMoves).toBeLessThanOrEqual(2);
    expect(R).toBeTruthy();
  });
  test('a key held down repeats nothing', () => {
    const { g, pr, open } = atRest();
    g.key(open[0]);
    for (let i = 0; i < 20; i++) { g.key(open[0], true); g.advance(1000 / 60); }
    expect(pr.sim.inputs).toBe(1);
  });
  test('a swipe during READY / GO is not a move', () => {
    const g = H.boot({ seed: H.seedHex(3) });
    g.clickPlay();
    expect(g.probe().mode).toBe('ready');
    g.swipe(1); g.key(2);
    g.advance(400);
    expect(W.movesOf(g.trace).length).toBe(0);
    while (g.probe().mode !== 'play') g.advance(1000 / 60);
    g.advance(500);
    expect(W.movesOf(g.trace).length).toBe(0);   // nothing was held over into the run
  });
});

describe('Rang Bharo golden runs (rules v1)', () => {
  test.each(GOLDEN.runs.map((r, i) => [i, r.pilot, r]))('run %i (%s)', (_i, _p, run) => {
    const { sim, worlds } = W.serverWorlds(run.seed, run.schedule, { version: 1 });
    expect(W.digest(worlds)).toBe(run.digest);
    expect(sim.score).toBe(run.score);
    expect(sim.mazes).toBe(run.mazes);
    expect(validatorRun(run.seed, W.traceOf(run.schedule)).score).toBe(run.score);
  });
  test('the corpus reaches what it is for: perfects, misses, the largest grid, idle', () => {
    expect(GOLDEN.runs.some((r) => r.perfects > 10)).toBe(true);
    expect(GOLDEN.runs.some((r) => r.mazes > r.perfects)).toBe(true);
    expect(GOLDEN.runs.some((r) => r.mazes >= 11)).toBe(true);
    expect(GOLDEN.runs.some((r) => r.schedule.length === 0)).toBe(true);
  });
});

describe('Rang Bharo: every maze is solvable by construction, and nobody parks', () => {
  const SEEDS = 300, MAZES = 14;
  test(`${SEEDS} seeds x ${MAZES} mazes: the designed route clears the maze in the real rules; nothing is painted at the start`, () => {
    let cleared = 0;
    for (let s = 0; s < SEEDS; s++) {
      const seed = H.seedHex(5000 + s);
      const sim = S.initSim(seed, 1);
      while (sim.n <= MAZES) {
        const n = sim.n, m = sim.maze;
        expect(m.floors).toBeGreaterThanOrEqual(2);
        expect(sim.left).toBe(m.floors - 1);
        expect(m.par).toBeLessThanOrEqual(m.designed);
        expect(m.par).toBeGreaterThanOrEqual(3);
        for (const d of m.path) {
          while (sim.dir >= 0) S.stepSim(sim);
          if (sim.n !== n || sim.pause > 0) break;
          expect(S.inputDir(sim, d)).toBe(true);
          S.stepSim(sim);
        }
        while (sim.dir >= 0) S.stepSim(sim);
        expect(sim.pause).toBeGreaterThan(0);
        expect(sim.moves).toBeLessThanOrEqual(m.designed);
        while (sim.pause > 0) S.stepSim(sim);
        cleared++;
      }
    }
    expect(cleared).toBe(SEEDS * MAZES);
  });
  test('par is the true shortest on small mazes (an independent BFS from the pilot agrees)', () => {
    for (let s = 0; s < 60; s++) {
      for (let n = 1; n <= 6; n++) {
        const m = S.genMaze(H.seedHex(7000 + s), n);
        const painted = new Uint8Array(m.w * m.h); painted[m.start] = 1;
        const plan = H.planBfs({ slideEnd: S.slideEnd, DX: S.DX, DY: S.DY }, m, m.start, painted, 1e6);
        expect(plan.length).toBe(m.par);
      }
    }
  });
  test('mazes on rare generator branches are pinned (the floor gate, the minimum-par cap)', () => {
    const G = require('./fixtures/rangBharoGoldenMazes.json');
    for (const g of G.mazes) {
      const m = S.genMazeRaw(S.seedToInt(g.seed), g.n);
      const d = crypto.createHash('sha256').update(m.w + 'x' + m.h + ':' + m.start + ':' + m.par + ':' + Array.from(m.cells).join('')).digest('hex').slice(0, 16);
      expect([g.seed, g.n, d]).toEqual([g.seed, g.n, g.digest]);
    }
  });
  test('the same seed and maze number always give the same maze, and different seeds differ', () => {
    const a = S.genMazeRaw(S.seedToInt('abc'), 5), b = S.genMazeRaw(S.seedToInt('abc'), 5), c = S.genMazeRaw(S.seedToInt('abd'), 5);
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
    expect(Array.from(a.cells).join('')).not.toBe(Array.from(c.cells).join(''));
  });
  test('a run with no input ends exactly at the clock, on the server and in the game', () => {
    for (let i = 0; i < 5; i++) {
      const sim = S.initSim(H.seedHex(i), 1);
      while (!sim.over) S.stepSim(sim);
      expect(sim.step).toBe(S.TIME_STEPS);
      expect(sim.score).toBe(0);
    }
    const f = flown('idle', { seed: H.seedHex(9) });
    expect(f.r.step).toBe(S.TIME_STEPS);
    expect(f.g.results).toEqual([0]);
  });
});
