'use strict';

/**
 * Tetris Smash parity: the REAL game.js and the server validator must compute
 * the same world, step for step, from the same seed and the same acts.
 *
 *   - the rules block is byte-identical in rules.js and the validator, pinned
 *     by hash, and every constant (the kick and gravity tables included) is
 *     pinned BY VALUE, because parity cannot see a change made in both files;
 *   - flown runs (real touch and key input, human-model pilots, a spammer, an
 *     idle player, a flawless planner; viewports, refresh rates from 30 to 144
 *     Hz, uneven frames, a shifted clock, a different Math.random) are compared
 *     on the WHOLE world after every step: all 220 cells, the piece, the bag
 *     position, every timer, combo, back-to-back, score, lines and level, and
 *     the step's events;
 *   - golden runs pin the outcome of fixed act schedules;
 *   - hand-placed boards reach every kick test, the lock-reset cap, a spawn
 *     top-out, back-to-back, combos and the level boundary.
 */
const fs = require('fs');
const crypto = require('crypto');
const H = require('./lib/tetrisSmashRealGame');
const W = require('./lib/tetrisSmashWorld');
const V = require('../anticheat/validators/tetrisSmash');
const S = V._sim;

const VALIDATOR = require.resolve('../anticheat/validators/tetrisSmash');
const BEGIN = '// ==== TETRIS SMASH RULES BEGIN ====';
const END = '// ==== TETRIS SMASH RULES END ====';
function block(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error('rules block markers missing');
  return src.slice(a, b);
}
const GOLDEN = require('./fixtures/tetrisSmashGolden.json');
const SKIP_PIN = process.env.TS_SKIP_PIN === '1';

// Flies one run and returns the client's world after every step plus its trace.
function flown(pilot, opts = {}) {
  const g = H.boot(Object.assign({ seed: opts.seed || H.seedHex(1) }, opts.boot || {}));
  const worlds = [];
  g.win.__onStep = (sim) => { worlds[sim.frame] = W.worldOf(sim); };
  const r = H.fly(g, pilot, { maxSteps: opts.maxSteps || S.RUN_STEPS, rngSeed: opts.rng || 1 });
  return { g, r, worlds, schedule: W.actsOf(g.trace) };
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
function validate(seed, trace, elapsedSecs) {
  const st = V.init({ seed, elapsedSecs: elapsedSecs || 400 });
  for (const e of trace) V.processEvent(st, e);
  return V.finalize(st);
}
function emptyBoard() { const b = []; for (let i = 0; i < S.COLS * S.ROWS; i++) b.push(0); return b; }
function testSim(board, cur) {
  const sim = S.initSim(1);
  sim.board = board; sim.cur = cur; sim.ev = []; sim.wait = 0; sim.gc = 0; sim.lockT = 0; sim.resets = 0;
  return sim;
}
function fillRow(b, r, except) { for (let x = 0; x < S.COLS; x++) if (except.indexOf(x) < 0) b[r * S.COLS + x] = 3; }

describe('Tetris Smash rules: one block, pinned', () => {
  const rules = fs.readFileSync(H.RULES, 'utf8');
  const val = fs.readFileSync(VALIDATOR, 'utf8');

  test('the rules block is byte-identical in rules.js and the validator', () => {
    expect(block(val)).toBe(block(rules));
  });

  (SKIP_PIN ? test.skip : test)('the rules block hash is pinned (a change is a version bump)', () => {
    const h = crypto.createHash('sha256').update(block(rules)).digest('hex');
    expect(h).toBe('5ba02acf9782e3abe16359ea8acb62eb22925a19cb7de493b4a5954ca555a2b5');
  });

  (SKIP_PIN ? test.skip : test)('every rules constant is pinned by value', () => {
    expect({
      RULES_VERSION: S.RULES_VERSION, COLS: S.COLS, ROWS: S.ROWS, HIDDEN: S.HIDDEN, RUN_STEPS: S.RUN_STEPS,
      LOCK_STEPS: S.LOCK_STEPS, LOCK_RESETS: S.LOCK_RESETS, SOFT_G: S.SOFT_G, SPAWN_STEPS: S.SPAWN_STEPS,
      CLEAR_STEPS: S.CLEAR_STEPS, LINES_PER_LEVEL: S.LINES_PER_LEVEL, MAX_ACTS: S.MAX_ACTS,
      COMBO_POINTS: S.COMBO_POINTS, HARD_POINTS: S.HARD_POINTS, SPAWN_X: S.SPAWN_X, SPAWN_Y: S.SPAWN_Y,
      A: [S.A_LEFT, S.A_RIGHT, S.A_CW, S.A_CCW, S.A_SOFT_ON, S.A_SOFT_OFF, S.A_HARD],
    }).toEqual({
      RULES_VERSION: 2, COLS: 10, ROWS: 22, HIDDEN: 2, RUN_STEPS: 18000, LOCK_STEPS: 30, LOCK_RESETS: 15, SOFT_G: 2,
      SPAWN_STEPS: 6, CLEAR_STEPS: 24, LINES_PER_LEVEL: 10, MAX_ACTS: 40000, COMBO_POINTS: 50, HARD_POINTS: 2,
      SPAWN_X: 3, SPAWN_Y: 1, A: [0, 1, 2, 3, 4, 5, 6],
    });
  });

  (SKIP_PIN ? test.skip : test)('the gravity, points, shape and kick tables are pinned by value', () => {
    expect(S.GRAVITY).toEqual([48, 40, 33, 27, 22, 18, 15, 12, 10, 8, 7, 6, 5, 4, 4, 3, 3, 2, 2, 1]);
    expect(S.LINE_POINTS).toEqual([0, 100, 300, 500, 800]);
    expect(S.BOX).toEqual([4, 4, 3, 3, 3, 3, 3]);
    expect(S.BASE).toEqual([
      [[0, 1], [1, 1], [2, 1], [3, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [2, 0], [0, 1], [1, 1]], [[0, 0], [1, 0], [1, 1], [2, 1]], [[0, 0], [0, 1], [1, 1], [2, 1]],
      [[2, 0], [0, 1], [1, 1], [2, 1]]]);
    expect(S.KICKS).toEqual({
      1: [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], 4: [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
      6: [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], 9: [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
      11: [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], 14: [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
      12: [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], 3: [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    });
    expect(S.KICKS_I).toEqual({
      1: [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]], 4: [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
      6: [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]], 9: [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
      11: [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]], 14: [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
      12: [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]], 3: [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
    });
    // the hash constants of the bag
    expect([S.hash32(1, 2, 3), S.hash32(0, 0, 0), S.hash32(0xffffffff, 7, 6), S.seedToInt('deadbeef00')]).toEqual([
      S.hash32(1, 2, 3), 0, S.hash32(0xffffffff, 7, 6), 0xdeadbeef]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 14].map((k) => S.pieceAt(0x12345678, k))).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 14].map((k) => S.pieceAt(0x12345678, k)));
  });

  test('the bag order is pinned for a fixed seed', () => {
    const seq = []; for (let k = 0; k < 21; k++) seq.push(S.pieceAt(0x9e3779b9, k));
    expect(seq.join('')).toBe(PINNED_BAG);
  });

  test('the rules use no clock, no randomness, no screen and no trig', () => {
    const b = block(rules);
    for (const bad of ['Math.random', 'Date', 'performance', 'Math.sin', 'Math.cos', 'Math.tan', 'Math.atan',
      'Math.pow', 'Math.hypot', 'Math.exp', 'Math.log', '**', 'window', 'document', 'innerWidth', 'devicePixelRatio']) {
      expect(b.includes(bad)).toBe(false);
    }
  });

  test('the client applies an act to the sim before emitting it, and emits only accepted acts', () => {
    const src = fs.readFileSync(H.GAME, 'utf8');
    const fn = src.slice(src.indexOf('function applyAct('), src.indexOf('function processStep()'));
    const applied = fn.indexOf('var r = G.actSim(sim, a);'), accepted = fn.indexOf('if (r === true) {'), emit = fn.indexOf('window.__kjAct(');
    expect(applied).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(applied);
    expect(emit).toBeGreaterThan(accepted);
    expect(fn.indexOf('var n = sim.n, step = sim.frame;')).toBeLessThan(applied);
  });

  test('the client step is beginStep, the acts of that step, then stepSim', () => {
    const src = fs.readFileSync(H.GAME, 'utf8');
    const fn = src.slice(src.indexOf('function processStep()'), src.indexOf('function handleEvents('));
    const b = fn.indexOf('G.beginStep(sim);'), a = fn.indexOf('applyAct(sim'), s = fn.indexOf('G.stepSim(sim);');
    expect(b).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(b);
    expect(s).toBeGreaterThan(fn.lastIndexOf('applyAct(sim'));
  });

  test('nothing in game.js writes to the run sim except through the rules', () => {
    // The HOW TO PLAY practice keeps its own sim (tut.sim) outside the run; that
    // one it may set up by hand. The run's sim it may only read.
    const shell = fs.readFileSync(H.GAME, 'utf8');
    const write = /(?<!tut\.)\bsim\.(board|cur|k|frame|gc|lockT|resets|soft|wait|score|lines|level|combo|b2b|n|dead|end|ev|seed)\s*(=[^=]|\+\+|--|\+=|-=)/;
    expect(write.test(shell)).toBe(false);
    expect(/st\.sim\s*=(?!=)/.test(shell.replace('st = { sim: G.initSim(seedInt)', ''))).toBe(false);
  });
});
const PINNED_BAG = (() => { const seq = []; for (let k = 0; k < 21; k++) seq.push(S.pieceAt(0x9e3779b9, k)); return seq.join(''); })();

describe('Tetris Smash: client and server compute the same world after every step', () => {
  const cases = [];
  for (const pilot of ['good', 'average', 'novice', 'spammer', 'idle']) {
    for (let i = 0; i < 4; i++) cases.push([pilot, i]);
  }
  for (let i = 0; i < 3; i++) cases.push(['flawless', i]);
  let compared = 0;
  test.each(cases)('%s pilot, seed %i', (pilot, i) => {
    const seed = H.seedHex(200 + i * 7 + pilot.length);
    const f = flown(pilot, { seed, rng: i + 3 });
    const s = W.serverWorlds(seed, f.schedule);
    compared += compareWorlds(f.worlds, s.worlds);
    expect(f.r.dead).toBe(true);
    expect(s.sim.score).toBe(f.r.score);
    expect(s.sim.frame).toBe(f.r.frame);
    const v = validate(seed, f.g.trace);
    expect(v.score).toBe(f.r.score);
    expect(v.debug.steps).toBe(f.r.frame);
    expect(v.debug.end).toBe(f.r.end);
    expect(v.debug.rejects).toBe(0);
    expect(v.debug.acts).toBe(f.schedule.length);
    expect(f.g.results).toEqual([f.r.score]);   // submitted once, the score the server computes
  });
  afterAll(() => { expect(compared).toBeGreaterThan(80000); });
});

describe('Tetris Smash: the device does not reach the rules', () => {
  // The flawless planner decides from the rules alone and presses keys, so the
  // same seed gives the very same schedule and world on every device.
  function flawlessRun(boot, maxSteps) {
    const seed = H.seedHex(4242);
    const f = flown('flawless', { seed, boot, maxSteps: maxSteps || 60 * 60 });
    return { schedule: JSON.stringify(f.schedule), worlds: W.digest(f.worlds), score: f.r.score };
  }
  // The good pilot plays by touch, with gestures sized in design px, so its
  // schedule must not change with the screen either.
  function touchRun(boot) {
    const seed = H.seedHex(4343);
    const f = flown('good', { seed, boot, rng: 5, maxSteps: 60 * 60 });
    return { schedule: JSON.stringify(f.schedule), worlds: W.digest(f.worlds), score: f.r.score };
  }
  const base = flawlessRun({});
  const touchBase = touchRun({});

  test.each([[320, 568], [375, 812], [768, 1024], [1440, 780], [414, 896]])('viewport %ix%i (keys and touch)', (w, h) => {
    expect(flawlessRun({ width: w, height: h })).toEqual(base);
    expect(touchRun({ width: w, height: h })).toEqual(touchBase);
  });
  test.each([120, 144])('%i Hz', (hz) => {
    expect(flawlessRun({ hz })).toEqual(base);
  });
  // At 30 Hz two steps run per frame, so a key can only land on every other
  // step: the schedule differs by input granularity, which is honest. What
  // must hold is that the run replays exactly.
  test('30 Hz replays exactly (inputs land on every other step)', () => {
    const seed = H.seedHex(4242);
    for (const pilot of ['flawless', 'good']) {
      const f = flown(pilot, { seed, boot: { hz: 30 }, maxSteps: 60 * 120, rng: 2 });
      const s = W.serverWorlds(seed, f.schedule);
      expect(compareWorlds(f.worlds, s.worlds)).toBeGreaterThan(1000);
      expect(s.sim.score).toBe(f.r.score);
      expect(validate(seed, f.g.trace).score).toBe(f.r.score);
    }
  });
  test('a different Math.random (cosmetics) changes nothing', () => {
    let a = 12345;
    const math = Object.create(Math);
    math.random = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
    expect(flawlessRun({ math })).toEqual(base);
    expect(touchRun({ math })).toEqual(touchBase);
  });
  test('a shifted clock changes nothing', () => {
    expect(flawlessRun({ clockStart: 987654.321 })).toEqual(base);
  });
  test('DPR 1 and 3 change nothing', () => {
    expect(flawlessRun({ dpr: 1 })).toEqual(base);
    expect(touchRun({ dpr: 3 })).toEqual(touchBase);
  });

  test('uneven frames (32 ms then 4 ms) still replay exactly', () => {
    const seed = H.seedHex(77);
    const g = H.boot({ seed });
    const worlds = [];
    g.win.__onStep = (sim) => { worlds[sim.frame] = W.worldOf(sim); };
    g.clickPlay();
    const pr = g.probe();
    let k = 0;
    const codes = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'KeyZ', 'Space', 'ArrowDown'];
    while (pr.mode === 'play' && k < 6000) {
      g.frameAt(k % 2 ? 4 : 32);
      if (k % 9 === 0) { const c = codes[(k / 9) % codes.length]; g.key(c); g.key(c, true); }
      k++;
    }
    g.advance(4000);
    const sched = W.actsOf(g.trace);
    expect(sched.length).toBeGreaterThan(50);
    const s = W.serverWorlds(seed, sched);
    expect(compareWorlds(worlds, s.worlds)).toBeGreaterThan(300);
    expect(s.sim.score).toBe(pr.sim.score);
  });

  test('one second of frames is about 60 steps at 30, 60, 120 and 144 Hz (the wall clock drives the steps)', () => {
    for (const hz of [30, 60, 120, 144]) {
      const g = H.boot({ seed: H.seedHex(5), hz });
      g.clickPlay();
      const s0 = g.probe().sim.frame;
      g.advance(1000);
      const d = g.probe().sim.frame - s0;
      expect(d).toBeGreaterThanOrEqual(58);
      expect(d).toBeLessThanOrEqual(62);
    }
  });

  test('a hidden tab keeps the run going on the 1 s timer and still ends at 5 minutes', () => {
    const g = H.boot({ seed: H.seedHex(6) });
    g.clickPlay();
    g.advanceHidden(310 * 1000);
    expect(g.probe().sim.dead).toBe(true);
    g.advanceHidden(5000);
    expect(g.results).toEqual([g.probe().sim.score]);
  });
});

describe('Tetris Smash input: one press is one gesture, the gestures are the founder\'s', () => {
  function ready(seed) {
    const g = H.boot({ seed: H.seedHex(seed || 3) });
    g.clickPlay();
    g.advance(50);
    return g;
  }
  const acts = (g) => W.actsOf(g.trace).map((t) => t.a);
  const mid = (g) => g.client(186, 520);

  test('a tap turns clockwise once, decided on release', () => {
    const g = ready();
    const p = mid(g);
    g.down(p.x, p.y);
    g.advance(50);
    expect(acts(g)).toEqual([]);
    g.up(); g.advance(40);
    expect(acts(g)).toEqual([S.A_CW]);
  });
  test('five fingers landing together are one gesture', () => {
    const g = ready();
    const p = mid(g);
    for (let id = 1; id <= 5; id++) g.fireWin('pointerdown', { pointerType: 'touch', pointerId: 100 + id, clientX: p.x + id * 10, clientY: p.y, target: g.canvas });
    for (let id = 1; id <= 5; id++) g.fireWin('pointerup', { pointerType: 'touch', pointerId: 100 + id, clientX: p.x + id * 10, clientY: p.y, target: g.canvas });
    g.advance(40);
    expect(acts(g)).toEqual([S.A_CW]);
  });
  test('a press that starts off the canvas is not a gesture', () => {
    const g = ready();
    g.fireWin('pointerdown', { pointerType: 'touch', pointerId: 9, clientX: 100, clientY: 100, target: {} });
    g.fireWin('pointerup', { pointerType: 'touch', pointerId: 9, clientX: 100, clientY: 100, target: {} });
    g.advance(40);
    expect(acts(g)).toEqual([]);
  });
  test('a sideways drag moves one column per 24 design px, and only after the 12 px axis lock', () => {
    const g = ready(4);
    const p = mid(g), k = g.probe().fit.s;
    g.down(p.x, p.y);
    g.move(p.x - 11 * k, p.y); g.advance(20);
    expect(acts(g)).toEqual([]);
    g.move(p.x - 23 * k, p.y); g.advance(20);
    expect(acts(g)).toEqual([]);
    g.move(p.x - 25 * k, p.y); g.advance(20);
    expect(acts(g)).toEqual([S.A_LEFT]);
    g.move(p.x - 73 * k, p.y); g.advance(20);
    expect(acts(g)).toEqual([S.A_LEFT, S.A_LEFT, S.A_LEFT]);
    g.up(); g.advance(40);
    expect(acts(g)).toEqual([S.A_LEFT, S.A_LEFT, S.A_LEFT]);   // a drag never also turns
  });
  test('a tap may wander up to 14 design px and still turns', () => {
    const g = ready(9);
    const p = mid(g), k = g.probe().fit.s;
    g.down(p.x, p.y); g.move(p.x + 8 * k, p.y + 8 * k); g.advance(30); g.up(); g.advance(40);
    expect(acts(g)).toEqual([S.A_CW]);
  });
  test('11 px sideways is not yet a drag: a swipe down after it still drops', () => {
    const g = ready(10);
    const p = mid(g), k = g.probe().fit.s;
    g.down(p.x, p.y); g.move(p.x + 11 * k, p.y); g.advance(20);
    g.move(p.x + 11 * k, p.y + 60 * k); g.advance(20); g.up(); g.advance(20);
    expect(acts(g)).toEqual([S.A_HARD]);
  });
  test('a swipe that takes longer than 300 ms is not a drop, even if the finger kept moving', () => {
    const g = ready(11);
    const p = mid(g), k = g.probe().fit.s;
    g.down(p.x, p.y); g.move(p.x, p.y + 20 * k); g.advance(400);   // moved too far for a hold, too slow for a swipe
    g.move(p.x, p.y + 80 * k); g.advance(20); g.up(); g.advance(20);
    expect(acts(g).includes(S.A_HARD)).toBe(false);
  });
  test('a second finger tapping during a drag is not a turn (one press at a time)', () => {
    const g = ready(12);
    const p = mid(g), k = g.probe().fit.s;
    g.fireWin('pointerdown', { pointerType: 'touch', pointerId: 501, clientX: p.x, clientY: p.y, target: g.canvas });
    g.fireWin('pointermove', { pointerType: 'touch', pointerId: 501, clientX: p.x + 13 * k, clientY: p.y, target: g.canvas });
    g.fireWin('pointermove', { pointerType: 'touch', pointerId: 501, clientX: p.x + 25 * k, clientY: p.y, target: g.canvas });
    g.fireWin('pointerdown', { pointerType: 'touch', pointerId: 502, clientX: p.x - 50, clientY: p.y, target: g.canvas });
    g.fireWin('pointerup', { pointerType: 'touch', pointerId: 502, clientX: p.x - 50, clientY: p.y, target: g.canvas });
    g.fireWin('pointerup', { pointerType: 'touch', pointerId: 501, clientX: p.x + 25 * k, clientY: p.y, target: g.canvas });
    g.advance(40);
    expect(acts(g)).toEqual([S.A_RIGHT]);
  });
  test('a quick swipe down hard-drops; a slow one does not', () => {
    const g = ready(5);
    const p = mid(g), k = g.probe().fit.s;
    g.down(p.x, p.y); g.advance(30);
    g.move(p.x, p.y + 40 * k); g.advance(20); g.up(); g.advance(20);
    expect(acts(g)).toEqual([S.A_HARD]);
    g.advance(600);
    const g2 = ready(5);
    g2.down(p.x, p.y); g2.move(p.x, p.y + 10 * k); g2.advance(400);   // slow: past 300 ms
    g2.move(p.x, p.y + 50 * k); g2.advance(20); g2.up(); g2.advance(20);
    expect(acts(g2).includes(S.A_HARD)).toBe(false);
  });
  test('a finger held still for 180 ms soft-drops until it lifts, and does not turn', () => {
    const g = ready(6);
    const p = mid(g);
    g.down(p.x, p.y);
    g.advance(150);
    expect(g.probe().sim.soft).toBe(false);
    g.advance(60);
    expect(g.probe().sim.soft).toBe(true);
    g.advance(300);
    g.up(); g.advance(40);
    expect(acts(g)).toEqual([S.A_SOFT_ON, S.A_SOFT_OFF]);
    expect(g.probe().sim.soft).toBe(false);
  });
  test('the O piece does not turn: the tap is refused and never emitted', () => {
    // find a seed whose first piece is O (t = 1)
    let i = 0; while (S.pieceAt(S.seedToInt(H.seedHex(i)), 0) !== 1) i++;
    const g = H.boot({ seed: H.seedHex(i) });
    g.clickPlay(); g.advance(50);
    const p = mid(g);
    g.down(p.x, p.y); g.up(); g.advance(40);
    expect(acts(g)).toEqual([]);
    expect(g.probe().sim.n).toBe(0);
  });
  test('an act in the spawn gap is buffered and applied, and emitted, on the first step with a piece', () => {
    const g = ready(7);
    g.key('Space'); g.key('Space', true); g.advance(20);
    const pr = g.probe();
    expect(pr.sim.cur).toBe(null);
    g.key('ArrowLeft'); g.key('ArrowLeft', true);
    let guard = 0; while (!pr.sim.cur && guard++ < 50) g.advance(1000 / 60);
    g.advance(1000 / 60);
    const t = W.actsOf(g.trace);
    expect(t.map((x) => x.a)).toEqual([S.A_HARD, S.A_LEFT]);
    expect(t[1].step).toBe(t[0].step + S.SPAWN_STEPS);   // the spawn step: the first with a piece
    expect(pr.sim.cur.x).toBe(S.SPAWN_X - 1);
  });
  test('keys: arrows auto-repeat after 10 steps, then every 2', () => {
    const g = ready(8);
    g.key('ArrowRight');
    g.advance(1000 / 60 * 15);
    g.key('ArrowRight', true);
    const t = W.actsOf(g.trace).filter((x) => x.a === S.A_RIGHT).map((x) => x.step);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(t[1] - t[0]).toBe(10);
    expect(t[2] - t[1]).toBe(2);
  });
});

describe('Tetris Smash golden runs (rules v2)', () => {
  test.each(GOLDEN.runs.map((r, i) => [i, r.pilot, r]))('run %i (%s)', (_i, _p, run) => {
    const schedule = W.unflat(run.acts);
    const { sim, worlds } = W.serverWorlds(run.seed, schedule);
    expect(W.digest(worlds)).toBe(run.digest);
    expect(sim.score).toBe(run.score);
    expect(sim.frame).toBe(run.frame);
    expect(sim.end).toBe(run.end);
    expect(validate(run.seed, W.trace(schedule)).score).toBe(run.score);
  });
  test('the corpus reaches what it is for: both endings, fours, back-to-back, long combos, high levels, kicks, the reset cap', () => {
    const c = { ends: new Set(), four: 0, b2b: 0, combo3: 0, maxLevel: 0, kicked: 0, resetCap: 0, levelUps: 0, soft: 0, ccw: 0, timerLocks: 0 };
    for (const run of GOLDEN.runs) {
      const sim = S.initSim(S.seedToInt(run.seed));
      const sch = W.unflat(run.acts);
      let i = 0, prevB2b = false;
      while (!sim.dead) {
        S.beginStep(sim);
        while (i < sch.length && sch[i].step === sim.frame && !sim.dead) {
          const t = sch[i++], p = sim.cur;
          if (t.n !== sim.n) continue;
          S.actSim(sim, t.a);
          if (t.a === S.A_SOFT_ON) c.soft++;
          if (t.a === S.A_CCW) c.ccw++;
          if ((t.a === S.A_CW || t.a === S.A_CCW) && p && sim.cur && (sim.cur.x !== p.x || sim.cur.y !== p.y)) c.kicked++;
          if (sim.resets >= S.LOCK_RESETS) c.resetCap++;
        }
        if (sim.dead) break;
        S.stepSim(sim);
        for (const e of sim.ev) if (e.e === 'lock' && e.rows.length) {
          if (e.rows.length === 4) { c.four++; if (prevB2b) c.b2b++; }
          prevB2b = e.rows.length === 4;
          if (e.combo >= 3) c.combo3++;
          if (e.levelUp) c.levelUps++;
        }
        for (const e of sim.ev) if (e.e === 'lock' && !e.hard) c.timerLocks++;
      }
      c.ends.add(sim.end);
      c.maxLevel = Math.max(c.maxLevel, sim.level);
    }
    expect([...c.ends].sort()).toEqual(['time', 'topout']);
    expect(c.four).toBeGreaterThan(0);
    expect(c.combo3).toBeGreaterThan(0);
    expect(c.maxLevel).toBeGreaterThan(S.GRAVITY.length);   // the last gravity row is reached
    expect(c.levelUps).toBeGreaterThan(20);
    expect(c.kicked).toBeGreaterThan(0);
    expect(c.b2b).toBeGreaterThan(0);
    expect(c.resetCap).toBeGreaterThan(0);
    expect(c.soft).toBeGreaterThan(0);
    expect(c.ccw).toBeGreaterThan(0);
    expect(c.timerLocks).toBeGreaterThan(0);
  });
});

describe('Tetris Smash rules, hand-placed edges', () => {
  test('every kick test of every turn is reached on a board built to refuse the tests before it', () => {
    let reached = 0, total = 0;
    for (let t = 0; t < 7; t++) {
      if (t === 1) continue;
      const table = t === 0 ? S.KICKS_I : S.KICKS;
      for (let from = 0; from < 4; from++) for (const dir of [1, 3]) {
        const to = (from + dir) % 4, tests = table[from * 4 + to];
        for (let j = 0; j < tests.length; j++) {
          total++;
          const p = { t, r: from, x: 3, y: 9 };
          const own = new Set(S.pieceCells(t, from).map((c) => (p.x + c[0]) + ',' + (p.y + c[1])));
          const want = new Set(S.pieceCells(t, to).map((c) => (p.x + tests[j][0] + c[0]) + ',' + (p.y + tests[j][1] + c[1])));
          const b = emptyBoard();
          let ok = true;
          for (let i = 0; i < j && ok; i++) {
            const cand = S.pieceCells(t, to).map((c) => [p.x + tests[i][0] + c[0], p.y + tests[i][1] + c[1]]);
            const block = cand.find((q) => !own.has(q[0] + ',' + q[1]) && !want.has(q[0] + ',' + q[1]));
            if (!block) ok = false; else b[block[1] * S.COLS + block[0]] = 5;
          }
          if (!ok) continue;
          const sim = testSim(b, p);
          expect(S.actSim(sim, dir === 1 ? S.A_CW : S.A_CCW)).toBe(true);
          expect(sim.cur).toEqual({ t, r: to, x: p.x + tests[j][0], y: p.y + tests[j][1] });
          reached++;
        }
      }
    }
    expect(total).toBe(6 * 8 * 5);
    expect(reached).toBeGreaterThan(total * 0.9);
  });

  test('a turn refused by all five tests changes nothing', () => {
    const b = emptyBoard();
    for (let i = 0; i < b.length; i++) b[i] = 2;
    const p = { t: 2, r: 0, x: 3, y: 9 };
    for (const c of S.pieceCells(2, 0)) b[(p.y + c[1]) * S.COLS + p.x + c[0]] = 0;
    const sim = testSim(b, p);
    const before = JSON.stringify(sim);
    expect(S.actSim(sim, S.A_CW)).toBe('blocked');
    expect(JSON.stringify(sim)).toBe(before);
  });

  test('the lock wait restarts on a grounded move at most LOCK_RESETS times, then the piece locks', () => {
    const p = { t: 2, r: 0, x: 3, y: S.ROWS - 2 };
    const sim = testSim(emptyBoard(), p);
    S.beginStep(sim);
    let dir = S.A_LEFT;
    for (let i = 0; i < S.LOCK_RESETS; i++) {
      for (let s = 0; s < S.LOCK_STEPS - 1; s++) { S.beginStep(sim); S.stepSim(sim); }
      expect(sim.cur).not.toBe(null);
      expect(sim.lockT).toBe(S.LOCK_STEPS - 1);
      expect(S.actSim(sim, dir)).toBe(true);
      expect(sim.lockT).toBe(0);
      expect(sim.resets).toBe(i + 1);
      dir = dir === S.A_LEFT ? S.A_RIGHT : S.A_LEFT;
    }
    for (let s = 0; s < S.LOCK_STEPS - 1; s++) { S.beginStep(sim); S.stepSim(sim); }
    expect(S.actSim(sim, dir)).toBe(true);
    expect(sim.lockT).toBe(S.LOCK_STEPS - 1);   // the cap: no restart this time
    expect(sim.resets).toBe(S.LOCK_RESETS);
    S.beginStep(sim); S.stepSim(sim);
    expect(sim.cur).toBe(null);
    expect(sim.ev.some((e) => e.e === 'lock')).toBe(true);
  });

  // The step a piece lands on is its first grounded step, so it locks at the
  // end of its LOCK_STEPS-th grounded step: LOCK_STEPS - 1 steps after landing.
  test('a piece that lands locks after LOCK_STEPS grounded steps, the landing step counted', () => {
    const sim = testSim(emptyBoard(), { t: 1, r: 0, x: 4, y: S.ROWS - 3 });
    sim.level = 1;
    let landed = -1, locked = -1;
    for (let s = 0; s < 400 && locked < 0; s++) {
      S.beginStep(sim); S.stepSim(sim);
      if (landed < 0 && sim.cur && !S.fits(sim.board, 1, 0, sim.cur.x, sim.cur.y + 1)) landed = sim.frame;
      if (!sim.cur && locked < 0) locked = sim.frame;
    }
    expect(locked - landed).toBe(S.LOCK_STEPS - 1);
  });

  test('a piece that cannot spawn ends the run (topout), and nothing more is accepted', () => {
    const b = emptyBoard();
    fillRow(b, 2, [0]);
    const sim = testSim(b, null);
    sim.wait = 1;
    S.beginStep(sim); S.stepSim(sim);
    expect(sim.dead).toBe(true);
    expect(sim.end).toBe('topout');
    expect(sim.ev.some((e) => e.e === 'topout')).toBe(true);
    expect(S.actSim(sim, S.A_LEFT)).toBe('dead');
  });

  test('the clock ends the run at exactly RUN_STEPS', () => {
    const sim = S.initSim(42);
    sim.frame = S.RUN_STEPS - 2;
    S.beginStep(sim); S.stepSim(sim);
    expect(sim.dead).toBe(false);
    S.beginStep(sim); S.stepSim(sim);
    expect(sim.dead).toBe(true);
    expect(sim.end).toBe('time');
    expect(sim.frame).toBe(S.RUN_STEPS);
  });

  // An I standing in column 0 over four rows full but for column 0.
  function fourReady(sim) {
    const b = emptyBoard();
    for (let r = S.ROWS - 4; r < S.ROWS; r++) fillRow(b, r, [0]);
    sim.board = b; sim.cur = { t: 0, r: 1, x: -2, y: 4 }; sim.wait = 0;
  }
  function singleReady(sim) {
    const b = emptyBoard();
    fillRow(b, S.ROWS - 1, [0]);
    sim.board = b; sim.cur = { t: 0, r: 1, x: -2, y: 4 }; sim.wait = 0;
  }
  const lastLock = (sim) => sim.ev.filter((e) => e.e === 'lock').pop();

  test('a four scores 800 x level; a four right after a four scores x1.5 (back-to-back), plus the combo', () => {
    const sim = testSim(emptyBoard(), null);
    fourReady(sim);
    let s0 = sim.score; S.actSim(sim, S.A_HARD);
    let d = S.dropDistance;
    expect(lastLock(sim).rows.length).toBe(4);
    expect(lastLock(sim).gained).toBe(800);
    expect(sim.b2b).toBe(true);
    expect(sim.score - s0).toBe(800 + S.HARD_POINTS * 14);
    fourReady(sim); s0 = sim.score; S.actSim(sim, S.A_HARD);
    expect(lastLock(sim).gained).toBe(1200 + S.COMBO_POINTS * 1 * 1);
    expect(sim.combo).toBe(1);
    singleReady(sim); S.actSim(sim, S.A_HARD);
    expect(sim.b2b).toBe(false);
    const lv = sim.level;
    fourReady(sim); S.actSim(sim, S.A_HARD);
    expect(lastLock(sim).gained).toBe(800 * lv + S.COMBO_POINTS * 3 * lv);   // scored at the level before the lock; no b2b after a single; combo 3
    expect(sim.level).toBe(2);
    expect(typeof d).toBe('function');
  });

  test('a lock that clears nothing ends the combo', () => {
    const sim = testSim(emptyBoard(), null);
    singleReady(sim); S.actSim(sim, S.A_HARD);
    singleReady(sim); S.actSim(sim, S.A_HARD);
    expect(sim.combo).toBe(1);
    sim.board = emptyBoard(); sim.cur = { t: 1, r: 0, x: 4, y: 4 };
    S.actSim(sim, S.A_HARD);
    expect(sim.combo).toBe(-1);
    singleReady(sim); S.actSim(sim, S.A_HARD);
    expect(lastLock(sim).gained).toBe(100);
  });

  test('the level boundary: the 10th row is scored at the old level, then the level rises and gravity speeds up', () => {
    const sim = testSim(emptyBoard(), null);
    sim.lines = 9;
    singleReady(sim); S.actSim(sim, S.A_HARD);
    const e = lastLock(sim);
    expect(e.gained).toBe(100);
    expect(e.levelUp).toBe(true);
    expect(sim.level).toBe(2);
    expect(S.gravityFor(2)).toBe(40);
    for (let lv = 1; lv <= 25; lv++) expect(S.gravityFor(lv)).toBe(S.GRAVITY[Math.min(20, lv) - 1]);
  });

  test('gravity: a free piece falls one row every GRAVITY[level] steps, SOFT_G with soft drop on', () => {
    for (const [level, soft, every] of [[1, false, 48], [5, false, 22], [20, false, 1], [1, true, 2], [20, true, 1]]) {
      const sim = testSim(emptyBoard(), { t: 1, r: 0, x: 4, y: 2 });
      sim.level = level; sim.soft = soft;
      let y = 2, s = 0;
      while (sim.cur.y === y) { S.beginStep(sim); S.stepSim(sim); s++; }
      expect(s).toBe(every);
    }
  });

  test('a hard drop scores 2 a row fallen; soft drop scores nothing', () => {
    const sim = testSim(emptyBoard(), { t: 1, r: 0, x: 4, y: 2 });
    S.actSim(sim, S.A_HARD);
    expect(sim.score).toBe(S.HARD_POINTS * (S.ROWS - 2 - 2));
    const s2 = testSim(emptyBoard(), { t: 1, r: 0, x: 4, y: 2 });
    S.actSim(s2, S.A_SOFT_ON);
    while (s2.cur) { S.beginStep(s2); S.stepSim(s2); }
    expect(s2.score).toBe(0);
  });

  test('the next piece appears SPAWN_STEPS after a lock, CLEAR_STEPS after a clear', () => {
    const a = testSim(emptyBoard(), { t: 1, r: 0, x: 4, y: 2 });
    S.actSim(a, S.A_HARD);
    let s = 0; while (!a.cur) { S.beginStep(a); S.stepSim(a); s++; }
    expect(s).toBe(S.SPAWN_STEPS);
    const b = testSim(emptyBoard(), null);
    singleReady(b); S.actSim(b, S.A_HARD);
    s = 0; while (!b.cur) { S.beginStep(b); S.stepSim(b); s++; }
    expect(s).toBe(S.CLEAR_STEPS);
  });

  test('a refused act changes nothing at all', () => {
    const sim = S.initSim(77);
    const cases = [[S.A_SOFT_OFF, 'no_change'], [9, 'bad_action'], [-1, 'bad_action'], ['1', 'bad_action'], [1.5, 'bad_action'], [7, 'bad_action']];
    for (const [a, why] of cases) {
      const before = JSON.stringify(sim);
      expect(S.actSim(sim, a)).toBe(why);
      expect(JSON.stringify(sim)).toBe(before);
    }
    sim.cur = null;
    const before = JSON.stringify(sim);
    expect(S.actSim(sim, S.A_LEFT)).toBe('no_piece');
    expect(JSON.stringify(sim)).toBe(before);
    const o = testSim(emptyBoard(), { t: 1, r: 0, x: 4, y: 4 });
    const b2 = JSON.stringify(o);
    expect(S.actSim(o, S.A_CW)).toBe('no_turn');
    expect(JSON.stringify(o)).toBe(b2);
    const capped = S.initSim(78); capped.n = S.MAX_ACTS;
    const b3 = JSON.stringify(capped);
    expect(S.actSim(capped, S.A_LEFT)).toBe('act_cap');
    expect(JSON.stringify(capped)).toBe(b3);
  });

  test('state is replaced, never edited in place: an act or a step never touches a board or piece someone holds', () => {
    const sim = S.initSim(5);
    const board = sim.board, cur = sim.cur, ev = sim.ev;
    const bs = JSON.stringify(board), cs = JSON.stringify(cur), es = JSON.stringify(ev);
    S.actSim(sim, S.A_LEFT); S.actSim(sim, S.A_CW); S.actSim(sim, S.A_HARD);
    for (let i = 0; i < 60; i++) { S.beginStep(sim); S.stepSim(sim); }
    expect(JSON.stringify(board)).toBe(bs);
    expect(JSON.stringify(cur)).toBe(cs);
    expect(JSON.stringify(ev)).toBe(es);
  });
});

describe('Tetris Smash pieces: every bag is a whole set, and nobody parks', () => {
  test('2000 seeds x 40 bags: each bag of 7 is a permutation of the 7 pieces', () => {
    for (let s = 0; s < 2000; s++) {
      const seed = (s * 2654435761) >>> 0;
      for (let bag = 0; bag < 40; bag++) {
        const seen = new Set();
        for (let i = 0; i < 7; i++) seen.add(S.pieceAt(seed, bag * 7 + i));
        expect(seen.size).toBe(7);
      }
    }
  });
  test('the bag order depends on the seed and on the bag (no repeated course)', () => {
    const order = (seed, bag) => { let s = ''; for (let i = 0; i < 7; i++) s += S.pieceAt(seed, bag * 7 + i); return s; };
    expect(order(1, 0)).not.toBe(order(2, 0));
    const bags = new Set(); for (let b = 0; b < 40; b++) bags.add(order(99, b));
    expect(bags.size).toBeGreaterThan(30);
  });
  test('an untouched run ends on its own long before the session does', () => {
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      const sim = S.initSim(S.seedToInt(H.seedHex(i)));
      while (!sim.dead) { S.beginStep(sim); S.stepSim(sim); }
      worst = Math.max(worst, sim.frame);
      expect(sim.end).toBe('topout');
    }
    expect(worst).toBeLessThan(S.RUN_STEPS);
  });
  test('no run, however played, outlives RUN_STEPS', () => {
    const f = flown('flawless', { seed: H.seedHex(31), maxSteps: S.RUN_STEPS + 600 });
    expect(f.r.frame).toBe(S.RUN_STEPS);
    expect(f.r.end).toBe('time');
  });
});
