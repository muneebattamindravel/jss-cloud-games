'use strict';

/**
 * Chakkar Chaku parity: the REAL game.js and the server validator must compute
 * the same world, step for step, from the same seed and the same throws.
 *
 *   - the rules block is byte-identical in both files, pinned by hash, and
 *     every constant is pinned BY VALUE (parity cannot see a change made in
 *     both files);
 *   - flown runs (real input path, human-model pilots, viewports, refresh
 *     rates from 30 to 144 Hz, uneven frames, a shifted clock, a different
 *     Math.random) are compared FIELD FOR FIELD after every step: rotation,
 *     speed, keyframe, knives, apples, flight, transition, score, the log spec
 *     and the step's events;
 *   - golden runs pin the outcome of fixed throw schedules;
 *   - every log is provably clearable, and nobody parks.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./lib/chakkarChakuRealGame');
const W = require('./lib/chakkarChakuWorld');
const V = require('../anticheat/validators/chakkarChaku');
const S = V._sim;

const VALIDATOR = path.join(__dirname, '..', 'anticheat', 'validators', 'chakkarChaku.js');
const BEGIN = '// ==== CHAKKAR CHAKU RULES BEGIN ====';
const END = '// ==== CHAKKAR CHAKU RULES END ====';
function block(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error('rules block markers missing');
  return src.slice(a, b);
}
const GOLDEN = require('./fixtures/chakkarChakuGolden.json');          // v2 rules (frozen)
const GOLDEN3 = require('./fixtures/chakkarChakuGolden.v3.json');      // v3 rules
const SKIP_PIN = process.env.CK_SKIP_PIN === '1';

// Flies one run and returns the client's world after every step plus its trace.
function flown(pilot, opts = {}) {
  const g = H.boot(Object.assign({ seed: opts.seed || H.seedHex(1) }, opts.boot || {}));
  const worlds = [];
  g.win.__onStep = (sim) => { worlds[sim.step] = W.worldOf(sim); };
  const r = H.fly(g, pilot, { maxSteps: opts.maxSteps || 60 * 600, rngSeed: opts.rng || 1, hz: opts.hz, keys: opts.keys });
  return { g, r, worlds, schedule: W.throwsOf(g.trace).map((p) => ({ n: p.n, step: p.step })) };
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
function validatorScore(seed, trace, elapsedSecs) {
  const st = V.init({ seed, elapsedSecs });
  for (const e of trace) V.processEvent(st, e);
  return V.finalize(st);
}

describe('Chakkar Chaku rules: one block, pinned', () => {
  const game = fs.readFileSync(H.GAME, 'utf8');
  const val = fs.readFileSync(VALIDATOR, 'utf8');

  test('the rules block is byte-identical in game.js and the validator', () => {
    expect(block(val)).toBe(block(game));
  });

  (SKIP_PIN ? test.skip : test)('the rules block hash is pinned (a change is a version bump)', () => {
    const h = crypto.createHash('sha256').update(block(game)).digest('hex');
    expect(h).toBe('c581b7816a0d7afa05daaa7ed2b663e041142b1d5ddb69845fb6ee07e7302f45');
  });

  (SKIP_PIN ? test.skip : test)('every rules constant is pinned by value', () => {
    expect({
      RULES_VERSION: S.RULES_VERSION, TURN: S.TURN, SUB: S.SUB, TURN_SUB: S.TURN_SUB, FLY: S.FLY, TOL: S.TOL,
      APPLE_TOL: S.APPLE_TOL, TRANS: S.TRANS, IDLE_WARN: S.IDLE_WARN, IDLE_END: S.IDLE_END, MAX_STUCK: S.MAX_STUCK,
      BOSS_EVERY: S.BOSS_EVERY, V_BASE: S.V_BASE, V_STEP: S.V_STEP, V_CAP_K: S.V_CAP_K, V3_BASE: S.V3_BASE, V3_STEP: S.V3_STEP, V3_CAP_K: S.V3_CAP_K, V3_LATE_STEP: S.V3_LATE_STEP, V3_LATE_CAP_K: S.V3_LATE_CAP_K, ACC_PULSE: S.ACC_PULSE, ACC_REV3: S.ACC_REV3, ACC: S.ACC, ACC_REV: S.ACC_REV,
      ACC_BOSS: S.ACC_BOSS, NET_MIN: S.NET_MIN, DRAWS: S.DRAWS, KNIFE_PTS: S.KNIFE_PTS, APPLE_PTS: S.APPLE_PTS,
      CLEAR_PTS: S.CLEAR_PTS, MAX_THROWS: S.MAX_THROWS,
    }).toEqual({
      RULES_VERSION: 3, TURN: 3600, SUB: 16, TURN_SUB: 57600, FLY: 8, TOL: 85, APPLE_TOL: 120, TRANS: 42,
      IDLE_WARN: 360, IDLE_END: 600, MAX_STUCK: 12, BOSS_EVERY: 5, V_BASE: 190, V_STEP: 24, V_CAP_K: 18, V3_BASE: 180, V3_STEP: 22, V3_CAP_K: 22, V3_LATE_STEP: 5, V3_LATE_CAP_K: 40, ACC_PULSE: 8, ACC_REV3: 18,
      ACC: 10, ACC_REV: 26, ACC_BOSS: 20, NET_MIN: 43200, DRAWS: 32, KNIFE_PTS: 1, APPLE_PTS: 2, CLEAR_PTS: 5,
      MAX_THROWS: 20000,
    });
  });

  test('the rules use no clock, no randomness, no screen and no trig', () => {
    const b = block(game);
    for (const bad of ['Math.random', 'Date', 'performance', 'Math.sin', 'Math.cos', 'Math.tan', 'Math.atan',
      'Math.pow', 'Math.hypot', 'Math.exp', 'Math.log', '**', 'window', 'document', 'DMath', 'innerWidth', 'devicePixelRatio']) {
      expect(b.includes(bad)).toBe(false);
    }
  });

  test('the client applies a throw to the sim before emitting it, and emits only accepted throws', () => {
    const src = fs.readFileSync(H.GAME, 'utf8');
    const fn = src.slice(src.indexOf('function throwKnife(live)'), src.indexOf('function finishRun()'));
    expect(fn.indexOf('if (!throwSim(sim)) return false;')).toBeGreaterThan(0);
    expect(fn.indexOf('__kjThrow')).toBeGreaterThan(fn.indexOf('if (!throwSim(sim)) return false;'));
  });

  test('nothing below the rules block writes to the sim except through the rules', () => {
    const shell = fs.readFileSync(H.GAME, 'utf8').split(END)[1];
    expect(/sim\.(score|rot|spd|stuck|apples|left|fly|trans|throws|dead|lastAct|log|kfi|kfLeft)\s*(=[^=]|\+\+|--|\+=|-=)/.test(shell)).toBe(false);
  });
});

describe('Chakkar Chaku: client and server compute the same world after every step', () => {
  const cases = [];
  for (const pilot of ['good', 'average', 'novice', 'spammer', 'idle']) {
    for (let i = 0; i < 4; i++) cases.push([pilot, i]);
  }
  for (let i = 0; i < 3; i++) cases.push(['flawless', i]);
  let compared = 0;
  test.each(cases)('%s pilot, seed %i', (pilot, i) => {
    const seed = H.seedHex(200 + i * 7 + pilot.length);
    const f = flown(pilot, { seed, rng: i + 3, maxSteps: pilot === 'flawless' ? 60 * 120 : 60 * 600 });
    const s = W.serverWorlds(seed, f.schedule);
    compared += compareWorlds(f.worlds, s.worlds);
    expect(f.r.dead).toBe(true);
    expect(s.sim.score).toBe(f.r.score);
    expect(s.sim.deathStep).toBe(f.r.deathStep);
    const v = validatorScore(seed, f.g.trace);
    expect(v.score).toBe(f.r.score);
    expect(v.debug.deathStep).toBe(f.r.deathStep);
    expect(v.debug.rejects).toBe(0);
    expect(f.g.results).toEqual([f.r.score]);   // submitted once, the score the server computes
  });
  afterAll(() => { expect(compared).toBeGreaterThan(20000); });
});

describe('Chakkar Chaku: the device does not reach the rules', () => {
  // The flawless pilot decides from the rules alone, so the same seed must give
  // the very same schedule and world on every device, clock and Math.random.
  function flawlessRun(boot, hz) {
    const seed = H.seedHex(4242);
    const f = flown('flawless', { seed, boot, hz, maxSteps: 60 * 60 });
    return { schedule: JSON.stringify(f.schedule), worlds: W.digest(f.worlds), score: f.r.score };
  }
  const base = flawlessRun({});

  test.each([[320, 568], [375, 812], [768, 1024], [1440, 780], [414, 896]])('viewport %ix%i', (w, h) => {
    expect(flawlessRun({ width: w, height: h })).toEqual(base);
  });
  test.each([120, 144])('%i Hz', (hz) => {
    expect(flawlessRun({ hz }, hz)).toEqual(base);
  });
  // At 30 Hz two steps run per frame, so a finger can only land on every other
  // step: the schedule differs by input granularity, which is honest. What
  // must hold is that the run replays exactly.
  test('30 Hz replays exactly (inputs land on every other step)', () => {
    const seed = H.seedHex(4242);
    const f = flown('good', { seed, boot: { hz: 30 }, hz: 30, maxSteps: 60 * 300 });
    const s = W.serverWorlds(seed, f.schedule);
    expect(compareWorlds(f.worlds, s.worlds)).toBeGreaterThan(100);
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

  test('uneven frames (32 ms then 4 ms) still replay exactly', () => {
    const seed = H.seedHex(77);
    const g = H.boot({ seed });
    const worlds = [];
    g.win.__onStep = (sim) => { worlds[sim.step] = W.worldOf(sim); };
    g.clickPlay();
    const pr = g.probe();
    let k = 0;
    while (pr.state === 'play' && k < 4000) {
      g.frameAt(k % 2 ? 4 : 32);
      if (k % 11 === 0) g.tap(1);
      k++;
    }
    g.advance(4000);
    const sched = W.throwsOf(g.trace).map((p) => ({ n: p.n, step: p.step }));
    expect(sched.length).toBeGreaterThan(3);
    const s = W.serverWorlds(seed, sched);
    expect(compareWorlds(worlds, s.worlds)).toBeGreaterThan(100);
    expect(s.sim.score).toBe(pr.sim.score);
  });

  test('one second of frames is about 60 steps at 30, 60, 120 and 144 Hz (the wall clock drives the steps)', () => {
    for (const hz of [30, 60, 120, 144]) {
      const g = H.boot({ seed: H.seedHex(5), hz });
      g.clickPlay();
      const s0 = g.probe().sim.step;
      g.advance(1000);
      const d = g.probe().sim.step - s0;
      expect(d).toBeGreaterThanOrEqual(58);
      expect(d).toBeLessThanOrEqual(62);
    }
  });

  test('keys and taps are the same input', () => {
    const seed = H.seedHex(31);
    const f = flown('good', { seed, keys: true, rng: 9 });
    const s = W.serverWorlds(seed, f.schedule);
    compareWorlds(f.worlds, s.worlds);
    expect(s.sim.score).toBe(f.r.score);
  });
});

describe('Chakkar Chaku input: one knife in the air, one press one throw', () => {
  test('a press while a knife is in the air is dropped, never queued', () => {
    const g = H.boot({ seed: H.seedHex(3) });
    g.clickPlay();
    const pr = g.probe();
    while (pr.sim.trans > 0) g.advance(1000 / 60);
    g.tap(1);
    expect(pr.sim.fly).toBe(S.FLY);
    for (let i = 0; i < 4; i++) { g.advance(1000 / 60); g.tap(1); }
    expect(pr.sim.throws).toBe(1);
    while (pr.sim.fly >= 0) g.advance(1000 / 60);
    expect(pr.sim.throws).toBe(1);   // nothing was queued
    expect(W.throwsOf(g.trace).length).toBe(1);
  });
  test('five fingers landing together are one throw', () => {
    const g = H.boot({ seed: H.seedHex(3) });
    g.clickPlay();
    const pr = g.probe();
    while (pr.sim.trans > 0) g.advance(1000 / 60);
    for (let id = 1; id <= 5; id++) g.fire('pointerdown', { pointerType: 'touch', pointerId: 100 + id, clientX: 50 * id, clientY: 500 });
    expect(pr.sim.throws).toBe(1);
  });
  test('a throw during a log arriving is dropped', () => {
    const g = H.boot({ seed: H.seedHex(3) });
    g.clickPlay();
    expect(g.probe().sim.trans).toBeGreaterThan(0);
    g.tap(1);
    expect(g.probe().sim.throws).toBe(0);
    expect(W.throwsOf(g.trace).length).toBe(0);
  });
});

describe.each([[2, GOLDEN], [3, GOLDEN3]])('Chakkar Chaku golden runs (rules v%i)', (VER, GOLD) => {
  test.each(GOLD.runs.map((r, i) => [i, r.pilot, r]))('run %i (%s)', (_i, _p, run) => {
    const { sim, worlds } = W.serverWorlds(run.seed, run.schedule, { version: VER });
    expect(W.digest(worlds)).toBe(run.digest);
    expect(sim.score).toBe(run.score);
    expect(sim.deathStep).toBe(run.deathStep);
    const trace = [{ type: 'input', payload: { kind: 'start', v: VER } }]
      .concat(run.schedule.map((t) => ({ type: 'input', payload: { kind: 'throw', n: t.n, step: t.step } })));
    expect(validatorScore(run.seed, trace).score).toBe(run.score);
  });
  test('the corpus reaches what it is for: deaths by knife and idle, bosses, apples, a long run', () => {
    const causes = new Set(GOLD.runs.map((r) => r.cause));
    expect(causes.has('knife')).toBe(true);
    expect(causes.has('idle')).toBe(true);
    expect(Math.max(...GOLD.runs.map((r) => r.log))).toBeGreaterThan(30);
  });
});

describe('Chakkar Chaku: every log is clearable (rules v3)', () => {
  const SEEDS = 2000, LOGS = 50;
  test(`${SEEDS} seeds x ${LOGS} logs: pre-stuck + required never exceed MAX_STUCK, so the last throw always has a gap >= TOL + margin`, () => {
    let worst = 0;
    for (let s = 0; s < SEEDS; s++) {
      for (let k = 0; k < LOGS; k++) {
        const sp = S.logSpec((s * 2654435761) >>> 0, k, 3);
        worst = Math.max(worst, sp.stuck.length + sp.need);
        // pre-stuck knives are well apart
        for (let i = 0; i < sp.stuck.length; i++) for (let j = i + 1; j < sp.stuck.length; j++) {
          expect(S.circ(sp.stuck[i], sp.stuck[j])).toBeGreaterThanOrEqual(2 * S.TOL);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(S.MAX_STUCK);
    // With m knives in, the free arc for a knife's centre is TURN minus m arcs
    // of 2 TOL, split into at most m pieces: the largest is at least this.
    const m = S.MAX_STUCK - 1, gap = (S.TURN - m * 2 * S.TOL) / m;
    expect(gap).toBeGreaterThanOrEqual(2 * S.TOL - 20);   // 157 units: wider than one knife's whole no-go zone, less 2 degrees
  });

  test(`${SEEDS} seeds x ${LOGS} logs: every angle comes round to the knife well inside the idle limit, at the speeds involved`, () => {
    let worst = 0, fastest = 0;
    for (let s = 0; s < SEEDS; s++) {
      for (let k = 0; k < LOGS; k++) {
        const sp = S.logSpec((s * 2654435761) >>> 0, k, 3);
        const sim = { spec: sp, rot: sp.rot0, spd: S.kind0(sp.kf) ? sp.kf[0][0] : 0, kfi: 0, kfLeft: sp.kf[0][1] };
        const seen = new Uint8Array(360);
        let n = 0, t = 0;
        while (n < 360 && t < S.IDLE_END) {
          t++;
          const tg = sp.kf[sim.kfi][0];
          if (sim.spd < tg) sim.spd = Math.min(tg, sim.spd + sp.acc); else if (sim.spd > tg) sim.spd = Math.max(tg, sim.spd - sp.acc);
          fastest = Math.max(fastest, Math.abs(sim.spd));
          const a = Math.floor(sim.rot / S.SUB), r2 = S.wrapSub(sim.rot + sim.spd), c = Math.floor(r2 / S.SUB);
          let d = c - a; if (d > S.TURN / 2) d -= S.TURN; if (d < -S.TURN / 2) d += S.TURN;
          // every 10-unit bucket the landing angle passes this step
          const lo = Math.min(a, a + d), hi = Math.max(a, a + d);
          for (let b = Math.floor(lo / 10); b <= Math.floor(hi / 10); b++) {
            const bb = ((b % 360) + 360) % 360;
            if (!seen[bb]) { seen[bb] = 1; n++; }
          }
          sim.rot = r2;
          if (--sim.kfLeft <= 0) { sim.kfi = (sim.kfi + 1) % sp.kf.length; sim.kfLeft = sp.kf[sim.kfi][1]; }
        }
        expect(n).toBe(360);
        worst = Math.max(worst, t);
      }
    }
    expect(worst).toBeLessThan(S.IDLE_END - 100);
    // At the fastest spin, the guaranteed gap still lasts more than two steps.
    const gapUnits = (S.TURN - (S.MAX_STUCK - 1) * 2 * S.TOL) / (S.MAX_STUCK - 1);
    expect(gapUnits / (fastest / S.SUB)).toBeGreaterThan(2);
  });
});

describe('Chakkar Chaku: every log is clearable, and nobody parks', () => {
  const SEEDS = 2000, LOGS = 50;
  test(`${SEEDS} seeds x ${LOGS} logs: pre-stuck + required never exceed MAX_STUCK, so the last throw always has a gap >= TOL + margin`, () => {
    let worst = 0;
    for (let s = 0; s < SEEDS; s++) {
      for (let k = 0; k < LOGS; k++) {
        const sp = S.logSpec((s * 2654435761) >>> 0, k, 2);
        worst = Math.max(worst, sp.stuck.length + sp.need);
        // pre-stuck knives are well apart
        for (let i = 0; i < sp.stuck.length; i++) for (let j = i + 1; j < sp.stuck.length; j++) {
          expect(S.circ(sp.stuck[i], sp.stuck[j])).toBeGreaterThanOrEqual(2 * S.TOL);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(S.MAX_STUCK);
    // With m knives in, the free arc for a knife's centre is TURN minus m arcs
    // of 2 TOL, split into at most m pieces: the largest is at least this.
    const m = S.MAX_STUCK - 1, gap = (S.TURN - m * 2 * S.TOL) / m;
    expect(gap).toBeGreaterThanOrEqual(2 * S.TOL - 20);   // 157 units: wider than one knife's whole no-go zone, less 2 degrees
  });

  test(`${SEEDS} seeds x ${LOGS} logs: every angle comes round to the knife well inside the idle limit, at the speeds involved`, () => {
    let worst = 0, fastest = 0;
    for (let s = 0; s < SEEDS; s++) {
      for (let k = 0; k < LOGS; k++) {
        const sp = S.logSpec((s * 2654435761) >>> 0, k, 2);
        const sim = { spec: sp, rot: sp.rot0, spd: S.kind0(sp.kf) ? sp.kf[0][0] : 0, kfi: 0, kfLeft: sp.kf[0][1] };
        const seen = new Uint8Array(360);
        let n = 0, t = 0;
        while (n < 360 && t < S.IDLE_END) {
          t++;
          const tg = sp.kf[sim.kfi][0];
          if (sim.spd < tg) sim.spd = Math.min(tg, sim.spd + sp.acc); else if (sim.spd > tg) sim.spd = Math.max(tg, sim.spd - sp.acc);
          fastest = Math.max(fastest, Math.abs(sim.spd));
          const a = Math.floor(sim.rot / S.SUB), r2 = S.wrapSub(sim.rot + sim.spd), c = Math.floor(r2 / S.SUB);
          let d = c - a; if (d > S.TURN / 2) d -= S.TURN; if (d < -S.TURN / 2) d += S.TURN;
          // every 10-unit bucket the landing angle passes this step
          const lo = Math.min(a, a + d), hi = Math.max(a, a + d);
          for (let b = Math.floor(lo / 10); b <= Math.floor(hi / 10); b++) {
            const bb = ((b % 360) + 360) % 360;
            if (!seen[bb]) { seen[bb] = 1; n++; }
          }
          sim.rot = r2;
          if (--sim.kfLeft <= 0) { sim.kfi = (sim.kfi + 1) % sp.kf.length; sim.kfLeft = sp.kf[sim.kfi][1]; }
        }
        expect(n).toBe(360);
        worst = Math.max(worst, t);
      }
    }
    expect(worst).toBeLessThan(S.IDLE_END - 100);
    // At the fastest spin, the guaranteed gap still lasts more than two steps.
    const gapUnits = (S.TURN - (S.MAX_STUCK - 1) * 2 * S.TOL) / (S.MAX_STUCK - 1);
    expect(gapUnits / (fastest / S.SUB)).toBeGreaterThan(2);
  });

  test('an untouched log ends the run exactly IDLE_END steps after it arrives', () => {
    for (let i = 0; i < 20; i++) {
      const sim = S.initSim(H.seedHex(i), 3);
      while (!sim.dead) S.stepSim(sim);
      expect(sim.cause).toBe('idle');
      expect(sim.deathStep).toBe(S.TRANS + S.IDLE_END);
    }
  });

  test('a flawless planner survives ten minutes on 6 seeds (the rules never trap a perfect player)', () => {
    for (let i = 0; i < 6; i++) {
      const f = flown('flawless', { seed: H.seedHex(700 + i), maxSteps: 60 * 600 });
      expect(f.r.deathStep).toBeGreaterThanOrEqual(60 * 600);
    }
  });
});

describe('Chakkar Chaku rules v3: deception arrives gradually and repeats exactly', () => {
  const seeds = []; for (let s = 0; s < 1500; s++) seeds.push((s * 2654435761) >>> 0);
  const kindsAt = (k) => { const set = new Set(); for (const sd of seeds) { const sp = S.logSpec(sd, k, 3); set.add(sp.boss ? 'b' + sp.kind : sp.kind); } return set; };

  test('logs 1 to 3 are steady, and nothing reverses or stops before log 7', () => {
    for (let k = 0; k < 3; k++) expect([...kindsAt(k)]).toEqual([0]);
    for (let k = 0; k < 6; k++) for (const x of kindsAt(k)) expect([0, 4, 'b4']).toContain(x);
  });
  test('a log only stops and swings back from log 11, and the first boss does not deceive', () => {
    for (let k = 6; k < 10; k++) for (const x of kindsAt(k)) expect(x === 2 || x === 'b2').toBe(false);
    for (const x of kindsAt(4)) expect(x).toBe('b4');
    expect(kindsAt(10).has(2)).toBe(true);
  });
  test('every pattern is one short fixed cycle: at most four keyframes, speed ramps up to log 23', () => {
    for (const sd of seeds.slice(0, 300)) for (let k = 0; k < 40; k++) expect(S.logSpec(sd, k, 3).kf.length).toBeLessThanOrEqual(4);
    expect(S.speedOf3(22)).toBeGreaterThan(S.speedOf3(10));
    expect(S.speedOf3(40)).toBeGreaterThan(S.speedOf3(22));
    expect(S.speedOf3(60)).toBe(S.speedOf3(40));
    for (let k = 1; k < 40; k++) if (!S.isBoss(k) && !S.isBoss(k - 1)) expect(S.speedOf3(k)).toBeGreaterThan(S.speedOf3(k - 1));
  });
  test('stops get longer with the log, so deception grows by degrees', () => {
    const stop = (k) => { let m = 0, n = 0; for (const sd of seeds) { const sp = S.logSpec(sd, k, 3); if (sp.kind === 2 && !sp.boss) { m += sp.kf[1][1]; n++; } } return m / n; };
    expect(stop(25)).toBeGreaterThan(stop(11) + 6);
  });
  test('difficulty keeps rising well past log 30: longer stops, more crowding, faster spin, tighter holds', () => {
    const avg = (k, f) => { let m = 0; for (const sd of seeds) m += f(S.logSpec(sd, k, 3)); return m / seeds.length; };
    const stopLen = (sp) => (sp.kind === 2 && !sp.boss ? sp.kf[1][1] : 0);
    expect(avg(42, stopLen)).toBeGreaterThan(avg(30, stopLen) + 3);
    expect(avg(35, (sp) => sp.stuck.length)).toBeGreaterThan(avg(15, (sp) => sp.stuck.length) + 0.4);
    const hold = (sp) => (sp.kind === 1 && !sp.boss ? sp.kf[0][1] : 0);
    expect(avg(40, hold)).toBeLessThan(avg(28, hold));
    // the first 20 logs have no crowding beyond the old limit of 5 pre-stuck knives
    for (let k = 0; k < 20; k++) for (const sd of seeds.slice(0, 300)) expect(S.logSpec(sd, k, 3).stuck.length).toBeLessThanOrEqual(5);
    for (const sd of seeds.slice(0, 300)) for (let k = 0; k < 60; k++) { const sp = S.logSpec(sd, k, 3); expect(sp.stuck.length + sp.need).toBeLessThanOrEqual(S.MAX_STUCK); }
  });
  test('v2 logs are untouched by the new plan', () => {
    for (const sd of seeds.slice(0, 200)) for (let k = 0; k < 30; k++) expect(S.logSpec(sd, k)).toEqual(S.logSpec(sd, k, 2));
    expect(JSON.stringify(S.logSpec(7, 12, 2).kf)).not.toBe(JSON.stringify(S.logSpec(7, 12, 3).kf));
  });
  test('the client draws a knife in the air behind the log face, level with the stuck ones', () => {
    const src = fs.readFileSync(H.GAME, 'utf8');
    const fn = src.slice(src.indexOf('function drawLog('), src.indexOf('function drawWaitingKnife'));
    expect(fn.indexOf('flyY != null')).toBeGreaterThan(fn.indexOf('drawStuckKnife(cx, cy'));
    expect(fn.indexOf('flyY != null')).toBeLessThan(fn.indexOf('ctx.drawImage(img'));
    expect(src.includes('if (!flyDrawn)')).toBe(true);
  });
});
