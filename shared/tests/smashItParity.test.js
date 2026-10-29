'use strict';

/**
 * Smash It parity: the REAL game.js and the server validator must compute the
 * same world, step for step, from the same seed and the same shots.
 *
 *   - the rules block is byte-identical in rules.js and the validator, pinned
 *     by hash, and the constants are pinned BY VALUE, because parity cannot see
 *     a change made in both files;
 *   - flown runs (real taps through the real three.js camera, human-model
 *     pilots, a spammer, two thumbs, an idle player, a flawless planner;
 *     viewports, refresh rates from 30 to 144 Hz, uneven frames, a shifted
 *     clock, a different Math.random) are compared on the WHOLE physics world
 *     after every step: every block's id, hp, position, rotation and velocity,
 *     every ball, every obstacle, the ball supply, the level and the score;
 *   - golden runs pin the outcome of fixed shot schedules;
 *   - a rules-level corpus reaches every event the scoring reads.
 */
const fs = require('fs');
const crypto = require('crypto');
const H = require('./lib/smashItRealGame');
const W = require('./lib/smashItWorld');
const V = require('../anticheat/validators/smashIt');
const X = V._sim;

const VALIDATOR = require.resolve('../anticheat/validators/smashIt');
const BEGIN = '// ==== SMASH IT RULES BEGIN ====';
const END = '// ==== SMASH IT RULES END ====';
function block(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error('rules block markers missing');
  return src.slice(a, b);
}
const GOLDEN = require('./fixtures/smashItGolden.json');
const SKIP_PIN = process.env.SMASHIT_SKIP_PIN === '1';

jest.setTimeout(600000);
beforeAll(() => V.ready);

// Flies one run; returns the client's world after every step and its trace.
async function flown(pilot, opts = {}) {
  const seed = opts.seed || H.seedHex(1);
  const g = await H.boot(Object.assign({ seed }, opts.boot || {}));
  const worlds = [];
  g.win.__onStep = (S) => { worlds[S.step] = X.snapshot.call(null, S); };
  const r = H.fly(g, pilot, { maxSteps: opts.maxSteps || 3600, rngSeed: opts.rng || 1 });
  const shots = W.shotsOf(g.trace.filter((e) => e.type === 'input'));
  return { g, r, worlds, shots, seed };
}
// client worlds[k] is the world after the step that made S.step === k;
// serverWorlds()[k - 1] is the same world on the server.
function compare(client, server) {
  let n = 0;
  for (let k = 1; k < client.length; k++) {
    if (client[k] === undefined) continue;
    const s = server[k - 1];
    if (!s) throw new Error(`server ended before step ${k}`);
    if (!W.sameWorld(client[k], s)) {
      let i = 0; while (Object.is(client[k][i], s[i])) i++;
      throw new Error(`world differs after step ${k} at value ${i}: client ${client[k][i]} server ${s[i]}`);
    }
    n += client[k].length;
  }
  return n;
}
async function parity(pilot, opts) {
  const f = await flown(pilot, opts);
  const server = W.serverWorlds(f.seed, f.shots, f.worlds.length + 1);
  const n = compare(f.worlds, server);
  const st = V.init({ seed: f.seed, elapsedSecs: f.g.now / 1000 + 5 });
  for (const e of f.g.trace) if (e.type === 'input') V.processEvent(st, { type: 'input', payload: e.payload });
  const out = V.finalize(st);
  return { f, n, out };
}

describe('Smash It rules: one block, pinned', () => {
  const rules = fs.readFileSync(H.RULES, 'utf8');
  const val = fs.readFileSync(VALIDATOR, 'utf8');

  test('the rules block is byte-identical in rules.js and the validator', () => {
    expect(block(val)).toBe(block(rules));
  });

  (SKIP_PIN ? test.skip : test)('the rules block hash is pinned (a change is a version bump)', () => {
    const h = crypto.createHash('sha256').update(block(rules)).digest('hex');
    expect(h).toBe(require('./fixtures/smashItGolden.json').blockHash);
  });

  (SKIP_PIN ? test.skip : test)('the constants are pinned by value', () => {
    expect([X.RULES_VERSION, X.IDLE_STEPS, X.MAX_RUN_STEPS, X.MAX_SHOTS, X.DT, X.GRAVITY, X.CELL, X.ROW, X.DEPTH, X.FRONT, X.PLANK_H])
      .toEqual([1, 1800, 144000, 6000, 1 / 60, -20, 1, 1.3, 0.98, 0.5, 0.8]);
    expect([X.BALL_R, X.BALL_DENSITY, X.BALL_SPEED, X.CANNON, X.FALL_Y, X.JAR_BREAK_F]).toEqual([0.4, 4.2, 44, { x: 0, y: -1.2, z: 13 }, -2.6, 800]);
    expect([X.SHOT_GAP, X.PIERCE, X.CARRY_CAP]).toEqual(GOLDEN.pins.gap);
    expect(X.PTS).toEqual({ jar: 10, brick: 15, crate: 25, plank: 40, bomb: 30, ice: 20 });
    expect(X.FALL_PTS).toEqual({ jar: 10, brick: 15, crate: 15, plank: 20, bomb: 15, ice: 10 });
    expect(X.HP).toEqual({ jar: 1, brick: 0, crate: 2, plank: 3, bomb: 1, ice: 2 });
    expect([X.BOMB_R, X.BOMB_PUSH, X.PEND_LEN, X.PEND_R, X.PEND_Z, X.SHIELD_W, X.SHIELD_H, X.SHIELD_Z, X.FAN_LEN, X.FAN_HALF, X.FAN_Z]).toEqual(GOLDEN.pins.obstacles);
    expect(crypto.createHash('sha256').update(JSON.stringify(X.DESIGNS)).digest('hex')).toBe(GOLDEN.pins.designs);
    expect(crypto.createHash('sha256').update(JSON.stringify(Array.from(X.SINQ))).digest('hex')).toBe(GOLDEN.pins.sinq);
  });

  test('the quarter sine table folds into a whole integer wave that matches its definition', () => {
    expect(X.SINQ.length).toBe(257);   // a quarter wave; isin folds the other three
    for (let i = 0; i < 1024; i++) expect(X.isin(i)).toBe(Math.round(Math.sin(i * 2 * Math.PI / 1024) * 1e6) || 0);
    for (let i = 0; i < 1024; i++) expect(X.icos(i)).toBe(X.isin(i + 256));
  });

  test('the seed hashes and the obstacle plan are pinned for fixed seeds', () => {
    expect([X.seedToInt('0123456789abcdef0123456789abcdef'), X.seedToInt(''), X.hash(1, 2, 3), X.hash(0xdeadbeef, 40, 7)]).toEqual(GOLDEN.pins.hashes);
    const plans = [];
    for (let L = 1; L <= 24; L++) plans.push(JSON.stringify(X.obstaclePlan(12345, L, !!X.isBoss(L))));
    expect(crypto.createHash('sha256').update(plans.join('|')).digest('hex')).toBe(GOLDEN.pins.plans);
  });

  test('the rules use no clock, no randomness, no screen and no engine trig', () => {
    const b = block(rules).replace(/\/\/.*$/gm, '');
    for (const bad of ['Math.random', 'Date', 'performance', 'window', 'document', 'Math.sin', 'Math.cos', 'Math.tan', 'Math.atan', 'Math.exp', 'Math.log', 'Math.pow', 'requestAnimationFrame', 'setTimeout']) {
      expect([bad, b.includes(bad)]).toEqual([bad, false]);
    }
  });

  test('game.js applies a shot to the sim before emitting it, and emits only accepted shots', () => {
    const g = fs.readFileSync(H.GAME, 'utf8');
    const i = g.indexOf('function fireShot');
    const body = g.slice(i, g.indexOf('\n  }\n', i));
    expect(body).toMatch(/R\.shoot\(S,[^)]*\)\s*!==\s*true\)\s*return/);
    expect(body.indexOf('R.shoot(')).toBeLessThan(body.indexOf('__kjShot'));
  });

  test('nothing in game.js writes physics state except through the rules', () => {
    const g = fs.readFileSync(H.GAME, 'utf8');
    for (const bad of ['setTranslation', 'setLinvel', 'applyImpulse', 'setRotation', 'createRigidBody', 'S.score =', 'S.score +=', 'S.balls =', 'S.balls +=', 'S.level =']) {
      expect([bad, g.includes(bad)]).toEqual([bad, false]);
    }
  });
});

describe('Smash It: client and server compute the same world after every step', () => {
  const cases = [];
  ['sharpshooter', 'good', 'average', 'novice', 'spammer', 'thumbs'].forEach((p, k) => {
    for (let i = 0; i < (p === 'good' || p === 'average' ? 4 : 3); i++) cases.push([p, 10 + k * 10 + i]);
  });
  test.each(cases)('%s pilot, seed %i', async (pilot, i) => {
    const { f, n, out } = await parity(pilot, { seed: H.seedHex(i), rng: i, maxSteps: 2400 });
    expect(f.shots.length).toBeGreaterThan(0);
    expect(n).toBeGreaterThan(10000);
    expect(f.g.results.length ? f.g.results[f.g.results.length - 1] : f.r.score).toBe(f.r.score);
    if (f.r.over) expect(out.score).toBe(f.r.score);
    else expect(out.score).toBeGreaterThanOrEqual(f.r.score);
  });

  test('an idle player: no shots, the idle rule ends the run, both sides agree', async () => {
    const { f, out } = await parity('idle', { seed: H.seedHex(3), maxSteps: 2400 });
    expect(f.shots.length).toBe(0);
    expect(f.r.over).toBe(true);
    expect(f.r.end).toBe('idle');
    expect(out.debug.end).toBe('idle');
    expect(out.score).toBe(0);
    expect(f.r.score).toBe(0);
  });

  test('a run flown to its end submits exactly the validator score', async () => {
    const f = await flown('good', { seed: H.seedHex(77), rng: 77, maxSteps: 40000 });
    expect(f.r.over).toBe(true);
    expect(f.g.results.length).toBe(1);
    const st = V.init({ seed: f.seed, elapsedSecs: f.g.now / 1000 });
    for (const e of f.g.trace) if (e.type === 'input') V.processEvent(st, { type: 'input', payload: e.payload });
    const out = V.finalize(st);
    expect(out.score).toBe(f.g.results[0]);
    expect(out.debug.end).toBe(f.r.end);
  });
});

describe('Smash It: the device does not reach the rules', () => {
  async function same(bootOpts, pilot = 'good', i = 5) {
    const { f, n } = await parity(pilot, { seed: H.seedHex(i), rng: i, boot: bootOpts, maxSteps: 1800 });
    expect(n).toBeGreaterThan(5000);
    return f;
  }
  test.each([[320, 568], [375, 812], [768, 1024], [1440, 780], [414, 896]])('viewport %ix%i', async (w, h) => { await same({ width: w, height: h }); });
  test.each([30, 120, 144])('%i Hz', async (hz) => { await same({ hz }); });
  test.each([1, 3])('DPR %i', async (dpr) => { await same({ dpr }); });
  test('a different Math.random (cosmetics) changes nothing', async () => {
    const r = W.mulberry(999);
    await same({ math: Object.assign(Object.create(Math), { random: r }) });
  });
  test('a shifted clock changes nothing', async () => { await same({ clockStart: 987654321.5 }); });

  test('uneven frames (33 ms then 5 ms) replay exactly', async () => {
    const seed = H.seedHex(8);
    const g = await H.boot({ seed });
    const worlds = [];
    g.win.__onStep = (S) => { worlds[S.step] = X.snapshot(S); };
    g.clickPlay();
    const G = g.probe();
    const rnd = W.mulberry(8);
    for (let k = 0; k < 900 && G.mode === 'play'; k++) {
      if (k % 9 === 0) { const t = H.pickTarget(G.S, rnd, 0.2); if (t) { const sc = G.toScreen(t.x, t.y); g.tap(sc.x, sc.y); } }
      g.frameAt(k % 2 ? 33 : 5);
    }
    const shots = W.shotsOf(g.trace.filter((e) => e.type === 'input'));
    expect(shots.length).toBeGreaterThan(5);
    expect(compare(worlds, W.serverWorlds(seed, shots, worlds.length + 1))).toBeGreaterThan(5000);
  });

  test('one second of frames is 58 to 62 steps at 30, 60, 120 and 144 Hz', async () => {
    for (const hz of [30, 60, 120, 144]) {
      const g = await H.boot({ hz });
      g.clickPlay();
      const G = g.probe();
      g.advance(1000);
      const a = G.S.step;
      g.advance(1000);
      const d = G.S.step - a;
      expect([hz, d >= 58 && d <= 62]).toEqual([hz, true]);
    }
  });

  test('a tap is one shot: two thumbs landing together fire once', async () => {
    const g = await H.boot({ seed: H.seedHex(4) });
    g.clickPlay();
    const G = g.probe();
    g.advance(500);
    const before = G.S.shots;
    const sc = G.toScreen(0, 1);
    const a = g.tap(sc.x, sc.y, { hold: true }); const b = g.tap(sc.x + 40, sc.y, { hold: true });
    g.release(a); g.release(b);
    g.advance(100);
    expect(G.S.shots - before).toBe(1);
  });
});

describe('Smash It golden runs (rules v1)', () => {
  test.each(GOLDEN.runs.map((r, i) => [i, r]))('run %i', (_i, run) => {
    const worlds = W.serverWorlds(run.seed, run.shots, run.steps, run.level);
    const marks = run.marks.map(([k]) => [k, W.digest(worlds[k])]);
    expect(marks).toEqual(run.marks);
  });

  test('every golden run also scores the pinned score through the validator', () => {
    for (const run of GOLDEN.runs.filter((r) => r.seedHex)) {
      const ev = [{ type: 'input', payload: { kind: 'start', v: 1 } }].concat(run.shots.map((p) => ({ type: 'input', payload: p })));
      expect(V.simulate(run.seedHex, ev)).toBe(run.score);
    }
  });
});

describe('Smash It corpus: the rules reach every event the score reads', () => {
  test('client copy and server agree over a deep corpus, and it reaches every event', async () => {
    const K = await W.clientRules();
    const seen = {};
    const runs = [];
    for (let lv = 1; lv <= 29; lv += 4) for (let r = 1; r <= 2; r++) runs.push({ lv, r, prefer: null });
    runs.push({ lv: 1, r: 3, prefer: 'plank' }, { lv: 17, r: 1, prefer: 'plank' }, { lv: 25, r: 1, prefer: 'plank' }, { lv: 15, r: 3, prefer: 'plank' });
    for (const c of runs) {
      const seedInt = 1000 + c.lv * 7 + c.r;
      const o = W.corpusRun(K, seedInt, c.lv, { rng: c.r, prefer: c.prefer, every: c.prefer ? 20 : 24, noise: c.prefer ? 0.05 : 0.2, steps: 1500 });
      for (const k in o.seen) seen[k] = (seen[k] || 0) + o.seen[k];
      const server = W.serverWorlds(seedInt, o.shots, o.worlds.length, c.lv);
      expect(server.length).toBe(o.worlds.length);
      for (let i = 0; i < o.worlds.length; i++) if (!W.sameWorld(o.worlds[i], server[i])) throw new Error(`corpus level ${c.lv} rng ${c.r}: world differs after step ${i + 1}`);
    }
    for (const k of ['break:jar', 'break:bomb', 'break:crate', 'break:ice', 'break:plank', 'crush', 'fall:brick', 'fall:jar', 'crack:plank', 'crack:crate', 'clear', 'boss', 'hasFan', 'hasPend', 'shields1', 'bonk:table', 'bonk:shield']) {
      expect([k, (seen[k] || 0) > 0]).toEqual([k, true]);
    }
  });

  test('the run ends on the clock at MAX_RUN_STEPS (end:time)', () => {
    const sim = X.initSim(7, 1);
    sim.events = [];
    // keep the run alive: a shot every IDLE_STEPS / 2, and a full ball supply
    while (sim.phase !== 'over' && sim.step < X.MAX_RUN_STEPS + 10) {
      if (sim.step % 900 === 0) { sim.balls = Math.max(sim.balls, 5); X.shoot(sim, 600, 1200); }
      X.stepSim(sim); sim.events = [];
    }
    expect(sim.end).toBe('time');
    expect(sim.step).toBe(X.MAX_RUN_STEPS);
    sim.world.free();
  });

  test('an untouched tower stands on every design (nothing falls with no shot)', () => {
    for (let L = 1; L <= 40; L++) {
      const sim = X.initSim(31 + L, L);
      sim.events = [];
      const before = sim.blocks.length;
      let falls = 0;
      for (let s = 0; s < 600; s++) { X.stepSim(sim); for (const e of sim.events) if (e.e === 'fall' || e.e === 'break') falls++; sim.events = []; }
      expect([L, falls, sim.blocks.length]).toEqual([L, 0, before]);
      sim.world.free();
    }
  });
});
