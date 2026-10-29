'use strict';

/**
 * Smash It adversarial: forged, stacked, rewound, malformed and flooded traces
 * must score no more than the shots they really contain earn, and a refusal
 * never zeroes an honest run. Properties are asserted, never a count of
 * rejections.
 */
const H = require('./lib/smashItRealGame');
const W = require('./lib/smashItWorld');
const V = require('../anticheat/validators/smashIt');
const F = require('../anticheat/humanness/features');
const X = V._sim;

jest.setTimeout(600000);

const SEED = H.seedHex(11);
const start = (v = 1) => ({ type: 'input', payload: { kind: 'start', v } });
const shot = (n, x, y, step, extra) => ({ type: 'input', payload: Object.assign({ kind: 'shot', n, x, y, step }, extra || {}) });
function run(events, opts = {}) {
  const st = V.init(Object.assign({ seed: SEED, elapsedSecs: 2400 }, opts));
  const out = events.map((e) => V.processEvent(st, e));
  return { st, out, fin: V.finalize(st) };
}
// An honest run from the real page.
async function honest(seed = SEED, pilot = 'good', rng = 5, maxSteps = 40000) {
  const g = await H.boot({ seed });
  const r = H.fly(g, pilot, { maxSteps, rngSeed: rng });
  return { trace: g.trace.filter((e) => e.type === 'input'), score: r.score, step: r.step, end: r.end, over: r.over, submitted: g.results.slice() };
}
let H1;
beforeAll(async () => { await V.ready; H1 = await honest(); });

describe('Smash It validator: the server computes the score, the client claims nothing', () => {
  test('an honest trace scores exactly what the game showed and submitted', () => {
    const { fin } = run(H1.trace);
    expect(H1.over).toBe(true);
    expect(fin.score).toBe(H1.score);
    expect(H1.submitted).toEqual([H1.score]);
    expect(fin.debug.end).toBe(H1.end);
    expect(fin.debug.rejects).toBe(0);
    expect(H1.score).toBeGreaterThan(300);
  });
  test('a claimed score, level, hits or ball count in the payload is never read', () => {
    const forged = H1.trace.map((e) => ({ type: e.type, payload: Object.assign({}, e.payload, { score: 99999, level: 40, balls: 99, hits: 50, broke: [1, 2, 3] }) }));
    expect(run(forged).fin.score).toBe(H1.score);
  });
  test('no start marker: nothing scores', () => {
    const r = run(H1.trace.filter((e) => e.payload.kind !== 'start')).fin;
    expect(r.score).toBe(0);
    expect(r.debug.mode).toBe('none');
  });
  test.each([[0], [null], [undefined], ['x'], [-1]])('a start marker with v=%p is not a v1 replay', (v) => {
    expect(run([{ type: 'input', payload: { kind: 'start', v } }].concat(H1.trace.slice(1))).fin.score).toBe(0);
  });
  test('a second start marker cannot reset the run', () => {
    const ev = H1.trace.slice();
    ev.splice(Math.floor(ev.length / 2), 0, start());
    expect(run(ev).fin.score).toBe(H1.score);
  });
  test('a trace of no shots scores 0 and ends on the idle rule', () => {
    const { fin } = run([start()]);
    expect(fin.score).toBe(0);
    expect(fin.debug.end).toBe('idle');
  });
  test('the seed is the session\'s: the same shots on another seed score only what they earn there', () => {
    const other = run(H1.trace, { seed: H.seedHex(12) }).fin;
    expect(other.score).toBeLessThan(H1.score);
  });
  test('a missing or malformed session seed gives a fixed course, never a crash', () => {
    for (const seed of [undefined, null, 42, {}, '']) {
      const a = run(H1.trace, { seed }).fin, b = run(H1.trace, { seed }).fin;
      expect(a.score).toBe(b.score);
    }
  });
  test('the validator refuses to start before the physics engine is ready (the platform awaits V.ready)', () => {
    expect(typeof V.ready.then).toBe('function');
  });
});

describe('Smash It validator: a refused input changes nothing and never zeroes', () => {
  const first = () => H1.trace.find((e) => e.payload.kind === 'shot').payload;
  test.each([
    ['x not an integer', { x: 1.5 }], ['y not an integer', { y: '300' }], ['x off the field', { x: 701 }], ['x off the field left', { x: -701 }],
    ['y too low', { y: -151 }], ['y too high', { y: 1301 }], ['step negative', { step: -1 }], ['step not a number', { step: 'a' }], ['step a numeric string far ahead', { step: '9999' }], ['step a fraction', { step: 30.5 }],
    ['n not a number', { n: null }], ['n negative', { n: -1 }], ['x NaN', { x: NaN }], ['y Infinity', { y: Infinity }],
  ])('%s', (_name, bad) => {
    const p = first();
    const ev = [start(), shot(p.n, p.x, p.y, p.step, bad)].concat(H1.trace.slice(1));
    const { fin } = run(ev);
    expect(fin.score).toBe(H1.score);
    expect(fin.debug.rejects).toBe(1);
  });
  test('steps may not go backwards (a rewind would replay a window and keep the best)', () => {
    const shots = H1.trace.filter((e) => e.payload.kind === 'shot').map((e) => e.payload);
    const p = shots[3];
    const ev = H1.trace.slice(0, 5).concat([shot(p.n + 1, 0, 300, p.step - 5)]).concat(H1.trace.slice(5));
    const { fin } = run(ev);
    expect(fin.score).toBe(H1.score);
  });
  test('a shot out of order (wrong index) is refused, and so is a duplicated one', () => {
    const ev = H1.trace.slice();
    const i = 6, dup = ev[i];
    ev.splice(i + 1, 0, dup);
    const p = ev[i].payload;
    ev.splice(i + 1, 0, shot(p.n + 5, p.x, p.y, p.step));
    expect(run(ev).fin.score).toBe(H1.score);
  });
  test('a shot inside the reload gap is refused (never queued by the server) and costs nothing', () => {
    const p = H1.trace.find((e) => e.payload.kind === 'shot' && e.payload.n === 2).payload;
    const ev = H1.trace.slice();
    const at = ev.findIndex((e) => e.payload.n === 2);
    ev.splice(at + 1, 0, shot(3, 0, 200, p.step + X.SHOT_GAP - 1));
    expect(run(ev).fin.score).toBe(H1.score);
  });
  test('ten or more refusals mark the run suspicious without changing its score', () => {
    const ev = H1.trace.slice(0, 1);
    for (let i = 0; i < 9; i++) ev.push(shot(0, 0.5, 0, 0));
    const nine = run(ev.concat(H1.trace.slice(1))).fin;
    expect(nine.suspicious).toBe(null);
    ev.push(shot(0, 0.5, 0, 0));
    const ten = run(ev.concat(H1.trace.slice(1))).fin;
    expect(ten.suspicious).toBe('validator_rejects:10');
    expect(ten.score).toBe(H1.score);
    expect(nine.score).toBe(H1.score);
  });
});

describe('Smash It validator: work and time bounds', () => {
  test('a shot far beyond the run is refused once the run is over, and the run scores what was earned', () => {
    const ev = H1.trace.concat([shot(9999, 0, 300, 200000)]);
    const { fin, out } = run(ev);
    expect(fin.score).toBe(H1.score);
    expect(out[out.length - 1].accepted).toBe(false);
  });
  test('the run ends on its idle and ball rules however the trace goes on', () => {
    const ev = [start(), shot(0, 0, 300, 0)];
    for (let i = 1; i < 300; i++) ev.push(shot(i, 0, 300, 3000 + i * 12));
    const { fin } = run(ev);
    expect(fin.debug.end).toBe('idle');
    expect(fin.debug.shots).toBe(1);
  });
  test('a flood of shots on one step buys one shot', () => {
    const ev = [start()];
    for (let i = 0; i < 500; i++) ev.push(shot(i, 0, 300, 30));
    const { fin } = run(ev);
    expect(fin.debug.shots).toBe(1);
    expect(fin.debug.maxShotsPerStep).toBe(1);
  });
  test('the trace input cap refuses further events, it never zeroes', () => {
    const st = V.init({ seed: SEED, elapsedSecs: 2400 });
    for (const e of H1.trace) V.processEvent(st, e);
    st.inputCount = V._limits.MAX_INPUTS;
    const r = V.processEvent(st, shot(9999, 0, 300, 1e6));
    expect(r.reason).toBe('input_cap');
    expect(V.finalize(st).score).toBe(H1.score);
  });
  test('the rules\' shot cap refuses further shots: the 6000th applies, the 6001st does not', () => {
    const sim = X.initSim(5, 1);
    sim.shots = X.MAX_SHOTS - 1; sim.balls = 5;
    expect(X.shoot(sim, 0, 300)).toBe(true);
    for (let i = 0; i < X.SHOT_GAP; i++) X.stepSim(sim);
    sim.balls = 5;
    expect(X.shoot(sim, 0, 300)).toBe(false);
    sim.world.free();
  });
  test('the elapsed cap stops the run-out at exactly ceil((elapsed x 1.2 + 10) x 60) steps', () => {
    const natural = run([start()], { elapsedSecs: 0 }).fin.debug.steps;
    expect(natural).toBeGreaterThan(1800);
    for (const [e, steps] of [[5, 960], [15, 1680]]) {
      const { fin } = run([start()], { elapsedSecs: e });
      expect(fin.debug.steps).toBe(steps);
      expect(fin.debug.steps).toBeLessThan(natural);
    }
  });
  test('an elapsed time that lies short cannot buy more', () => {
    expect(run(H1.trace, { elapsedSecs: 10 }).fin.score).toBeLessThanOrEqual(H1.score);
  });
  test('the limits are pinned to the session lifetime', () => {
    expect(V._limits.MAX_SIM_STEPS).toBe(3600 * 60);
    expect(V._limits.FPS).toBe(60);
    expect(V._limits.MAX_INPUTS).toBeGreaterThan(X.MAX_SHOTS);
    expect(X.MAX_RUN_STEPS).toBeLessThan(V._limits.MAX_SIM_STEPS);
    const zlib = require('zlib');
    const lines = [];
    for (let i = 0; i < V._limits.MAX_INPUTS; i++) lines.push(JSON.stringify({ seq: i, type: 'input', ts: 1700000000000 + i * 160, payload: { kind: 'shot', n: i, x: -700 + (i % 1400), y: i % 1300, step: i * 10, tHint: i * 166.667 } }));
    expect(zlib.gzipSync(lines.join('\n')).length).toBeLessThan(4 * 1024 * 1024);
  });
  test('the validator frees the physics world once the run is scored', () => {
    const { st } = run(H1.trace);
    expect(st.sim.world).toBe(null);
  });
});

describe('Smash It rules: edges the suites pin by hand', () => {
  test('the rules themselves refuse a fractional or out-of-field target (not only the validator)', () => {
    const sim = X.initSim(5, 1);
    for (const [x, y] of [[1.5, 300], [0, 300.5], [701, 300], [-701, 300], [0, 1301], [0, -151]]) expect([x, y, X.shoot(sim, x, y)]).toEqual([x, y, false]);
    expect(X.shoot(sim, 700, 1300)).toBe(true);
    sim.world.free();
  });
  test('a run with no shots ends at exactly step 1860: idle on step 1801, and the 60 step ending counts that step', () => {
    const { fin } = run([start()]);
    expect(fin.debug.steps).toBe(1860);
    expect(fin.debug.end).toBe('idle');
  });
  test('at most 6 unused balls carry over to the next tower', () => {
    const sim = X.initSim(9, 1);
    sim.events = [];
    const add1 = 0;
    sim.balls = 20;
    while (sim.blocks.length) { const b = sim.blocks[0]; sim.blocks = sim.blocks.slice(1); delete sim.byCollider[b.collider.handle]; sim.world.removeRigidBody(b.body); }
    let tower = null;
    for (let i = 0; i < 80 && !tower; i++) { X.stepSim(sim); for (const e of sim.events) if (e.e === 'tower') tower = e; sim.events = []; }
    expect(tower).toBeTruthy();
    expect(tower.level).toBe(2);
    expect(sim.balls).toBe(6 + tower.add + add1);
    expect(sim.step).toBe(41);                      // cleared on step 1 (the pause counts it), built on step 41
    sim.world.free();
  });
  test('with no balls left and the tower still moving, the run ends 420 steps after the last shot, then 60 more', () => {
    const sim = X.initSim(9, 1);
    sim.events = [];
    sim.balls = 1;
    expect(X.shoot(sim, 600, 1200)).toBe(true);   // a miss, high and wide
    const b = sim.blocks[0];
    let endingAt = null;
    while (sim.phase !== 'over' && sim.step < 3000) {
      b.body.setLinvel({ x: 0, y: 0, z: 0.001 }, true);   // keep one block awake
      X.stepSim(sim); sim.events = [];
      if (sim.phase === 'ending' && endingAt === null) endingAt = sim.step;
    }
    expect(endingAt).toBe(421);
    expect(sim.end).toBe('balls');
    expect(sim.step).toBe(481);
    sim.world.free();
  });
});

describe('Smash It validator: attacks that try to buy a better run', () => {
  test('firing every ball the moment the gap allows (the machine gun) scores less than a player who aims', () => {
    const st = V.init({ seed: SEED, elapsedSecs: 2400 });
    V.processEvent(st, start());
    let n = 0;
    for (let t = 0; t < 20000 && !st.dead; t += X.SHOT_GAP) { const r = V.processEvent(st, shot(n, 0, 300, t)); if (!r.reason && r.accepted) n++; }
    expect(V.finalize(st).score).toBeLessThan(H1.score);
  });
  test('a shot from outside the field cannot hit a tower from behind', () => {
    const { fin } = run([start(), shot(0, 0, 300, 0), shot(1, 99999, 300, 20), shot(1, 0, -99999, 20)]);
    expect(fin.debug.shots).toBe(1);
  });
  test('the humanness extractor reads every shot (features.inputs equals the shot count)', async () => {
    if (!F.GAME_INPUTS['smash-it']) F.GAME_INPUTS['smash-it'] = { kinds: ['shot'], time: 'step' };   // the integration hunk
    for (const pilot of ['good', 'sharpshooter', 'spammer']) {
      const h = await honest(H.seedHex(15), pilot, 2, 3600);
      const f = F.extractFeatures('smash-it', h.trace);
      expect(f.inputs).toBe(W.shotsOf(h.trace).length);
    }
  });
  test('the debug record separates a planner from a hand (recorded, never gated)', async () => {
    const bot = run((await honest(H.seedHex(16), 'sharpshooter', 1, 3600)).trace, { seed: H.seedHex(16) }).fin.debug;
    const hand = run((await honest(H.seedHex(16), 'average', 3, 3600)).trace, { seed: H.seedHex(16) }).fin.debug;
    for (const k of ['hitsPerShot', 'gapCv', 'minGap', 'aimSdX', 'aimSdY', 'maxShotsPerStep']) {
      expect([k, typeof bot[k]]).toEqual([k, 'number']);
      expect([k, typeof hand[k]]).toEqual([k, 'number']);
    }
    // a planner fires the instant the reload allows, in bursts, and aims tighter in height
    expect(bot.gapCv).toBeGreaterThan(hand.gapCv);
    expect(bot.minGap).toBe(X.SHOT_GAP);
    expect(bot.aimSdY).toBeLessThan(hand.aimSdY);
  });
});
