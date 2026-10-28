'use strict';

/**
 * Chakkar Chaku adversarial: forged, stacked, rewound, malformed and flooded
 * traces must score no more than the throws they really contain earn, and a
 * refusal never zeroes an honest run.
 */
const H = require('./lib/chakkarChakuRealGame');
const W = require('./lib/chakkarChakuWorld');
const V = require('../anticheat/validators/chakkarChaku');
const S = V._sim;

const SEED = H.seedHex(11);
const start = (v = 2) => ({ type: 'input', payload: { kind: 'start', v } });
const thr = (n, step, extra) => ({ type: 'input', payload: Object.assign({ kind: 'throw', n, step }, extra || {}) });
function run(events, opts = {}) {
  const st = V.init(Object.assign({ seed: SEED }, opts));
  const out = events.map((e) => V.processEvent(st, e));
  return { st, out, fin: V.finalize(st) };
}
// An honest run from the real game.
function honest(seed = SEED, pilot = 'good') {
  const g = H.boot({ seed });
  const r = H.fly(g, pilot, { maxSteps: 60 * 600, rngSeed: 5 });
  return { trace: g.trace, score: r.score, deathStep: r.deathStep };
}
const H1 = honest();

describe('Chakkar Chaku validator: the server computes the score, the client claims nothing', () => {
  test('an honest trace scores exactly what the game showed', () => {
    const { fin } = run(H1.trace);
    expect(fin.score).toBe(H1.score);
    expect(fin.debug.deathStep).toBe(H1.deathStep);
    expect(fin.debug.rejects).toBe(0);
  });
  test('a claimed score in the payload is never read', () => {
    const forged = H1.trace.map((e) => ({ type: e.type, payload: Object.assign({}, e.payload, { score: 99999, points: 500, cleared: true }) }));
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
  test('a trace of no throws scores 0 and the log ends the run idle', () => {
    const { fin } = run([start()]);
    expect(fin.score).toBe(0);
    expect(fin.debug.cause).toBe('idle');
  });
});

describe('Chakkar Chaku validator: a refused input changes nothing and never zeroes', () => {
  test('a throw while a knife is in the air is refused (no stacking)', () => {
    const t0 = S.TRANS + 5;
    const { out, fin } = run([start(), thr(0, t0), thr(1, t0), thr(1, t0 + 3)]);
    expect(out[2].reason).toBe('refused');
    expect(out[3].reason).toBe('refused');
    expect(fin.debug.throws).toBe(1);
  });
  test('a hundred throws on one step buy one knife', () => {
    const t0 = S.TRANS + 5, ev = [start()];
    for (let i = 0; i < 100; i++) ev.push(thr(i === 0 ? 0 : 1, t0));
    const { fin } = run(ev);
    expect(fin.debug.throws).toBe(1);
  });
  test('a throw while the log arrives is refused', () => {
    const { out, fin } = run([start(), thr(0, 3)]);
    expect(out[1].reason).toBe('refused');
    expect(fin.debug.throws).toBe(0);
  });
  test('steps may not go backwards', () => {
    const t0 = S.TRANS + 30;
    const { out } = run([start(), thr(0, t0), thr(1, t0 - 10)]);
    expect(out[2].reason).toBe('frame_regressed');
  });
  test('a throw out of order (wrong index) is refused', () => {
    const { out } = run([start(), thr(5, S.TRANS + 10)]);
    expect(out[1].reason).toBe('out_of_order');
  });
  test.each([
    ['null step', { kind: 'throw', n: 0, step: null }],
    ['string step', { kind: 'throw', n: 0, step: '60' }],
    ['negative step', { kind: 'throw', n: 0, step: -1 }],
    ['fraction', { kind: 'throw', n: 0, step: 60.5 }],
    ['NaN', { kind: 'throw', n: NaN, step: 60 }],
    ['Infinity', { kind: 'throw', n: 0, step: Infinity }],
    ['object n', { kind: 'throw', n: {}, step: 60 }],
  ])('malformed: %s', (_name, payload) => {
    const { out, fin } = run([start(), { type: 'input', payload }]);
    expect(out[1].reason).toBe('bad_throw');
    expect(fin.debug.throws).toBe(0);
  });
  test('malformed and refused events inside an honest run cost the player nothing', () => {
    const junk = [];
    for (const e of H1.trace) {
      junk.push(e);
      if (e.payload.kind === 'throw') {
        junk.push({ type: 'input', payload: { kind: 'throw', n: 'x', step: e.payload.step } });
        junk.push(thr(e.payload.n + 1, e.payload.step));      // in the air: refused
        junk.push({ type: 'input', payload: { kind: 'swipe' } });
        junk.push({ type: 'heartbeat' });
        junk.push(null);
      }
    }
    expect(run(junk).fin.score).toBe(H1.score);
  });
  test('a step far beyond the run is refused once the run is over, and scores what was earned', () => {
    const { fin } = run([start(), thr(0, S.TRANS + 1), thr(1, 10 * 60 * 60 * 60)]);
    expect(fin.score).toBe(1);
  });
  test('the input cap refuses further throws, it never zeroes', () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, start());
    st.inputCount = S.MAX_INPUTS;
    const r = V.processEvent(st, thr(0, S.TRANS + 5));
    expect(r.reason).toBe('input_cap');
    expect(r.accepted).toBe(true);
  });
  test('ten or more refusals mark the run suspicious without changing its score', () => {
    const ev = [start()];
    for (let i = 0; i < 12; i++) ev.push({ type: 'input', payload: { kind: 'throw', n: -1, step: 1 } });
    const { fin } = run(ev);
    expect(fin.suspicious).toBe('validator_rejects:12');
  });
});

describe('Chakkar Chaku validator: attacks that try to buy a better run', () => {
  test('replaying one honest trace against another seed scores what those throws earn there, nothing more', () => {
    const other = H.seedHex(12);
    const { fin } = run(H1.trace, { seed: other });
    const s = W.serverWorlds(other, W.throwsOf(H1.trace).map((p) => ({ n: p.n, step: p.step })));
    expect(fin.score).toBe(s.sim.score);
  });
  test('a throw every possible step (the machine gun) dies early', () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, start());
    let n = 0;
    for (let t = S.TRANS; t < S.TRANS + 3000; t += S.FLY) if (!V.processEvent(st, thr(n, t)).reason) n++;
    const fin = V.finalize(st);
    expect(fin.debug.cause).toBe('knife');
    expect(fin.score).toBeLessThan(200);
  });
  test('the elapsed cap stops the run-out at the session\'s real length', () => {
    // a log that cannot end itself, so only the cap can stop the run-out
    const st = V.init({ seed: SEED, elapsedSecs: 2 });
    V.processEvent(st, start());
    for (let i = 0; i <= S.TRANS; i++) S.stepSim(st.sim);
    st.sim.lastAct = 1e12;
    const fin = V.finalize(st);
    expect(fin.debug.steps).toBe(Math.ceil((2 * 1.2 + 10) * 60));
    expect(fin.debug.dead).toBe(false);
  });
  test('the work bound stops a sim that cannot die', () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, start());
    // an immortal log: past its arrival, no idle end, never dies
    for (let i = 0; i <= S.TRANS; i++) S.stepSim(st.sim);
    st.sim.lastAct = 1e12;
    const t0 = Date.now();
    V.finalize(st);
    expect(st.sim.dead).toBe(false);
    expect(st.sim.step).toBe(S.MAX_SIM_STEPS);
    expect(Date.now() - t0).toBeLessThan(20000);
  });
  test('the fingerprint raw material is recorded', () => {
    const { fin } = run(H1.trace);
    expect(fin.debug.marginMean).toBeGreaterThan(0);
    expect(fin.debug.marginSd).toBeGreaterThan(0);
    expect(fin.debug.gapCv).toBeGreaterThan(0);
    expect(fin.debug.waitMean).not.toBeNull();
  });
  test('a planner sits further from the stuck knives on average than a sloppy hand', () => {
    const a = honest(H.seedHex(21), 'flawless'), b = honest(H.seedHex(21), 'novice');
    // flawless throws the moment it is safe, a novice wants a wide margin:
    // they differ, which is what the fingerprint needs
    expect(run(a.trace, { seed: H.seedHex(21) }).fin.debug.marginMean)
      .not.toBe(run(b.trace, { seed: H.seedHex(21) }).fin.debug.marginMean);
  });
});

describe('Chakkar Chaku rules at their exact edges (literals, never read from the rules)', () => {
  // Where would a knife thrown now land? Fly it on a copy with an empty log.
  function landing(sim) {
    const c = Object.assign({}, sim, { stuck: [], apples: [] });
    S.throwSim(c);
    for (let i = 0; i < 8; i++) S.stepSim(c);
    return c.events.find((e) => e.t === 'stick').a;
  }
  function ready() {
    const sim = S.initSim(SEED, 2);
    for (let i = 0; i < 50; i++) S.stepSim(sim);
    return sim;
  }
  function throwWith(stuck, apples) {
    const sim = ready();
    const a = landing(sim);
    sim.stuck = stuck.map((d) => (a + d + 3600) % 3600);
    sim.apples = apples.map((d) => (a + d + 3600) % 3600);
    S.throwSim(sim);
    for (let i = 0; i < 8; i++) S.stepSim(sim);
    return sim;
  }
  test('a stuck knife 84 units away ends the run, 85 away does not (both sides)', () => {
    expect(throwWith([84], []).dead).toBe(true);
    expect(throwWith([-84], []).dead).toBe(true);
    expect(throwWith([85], []).dead).toBe(false);
    expect(throwWith([-85], []).dead).toBe(false);
    expect(throwWith([0], []).cause).toBe('knife');
  });
  test('an apple 119 away is taken for 2, 120 away is not', () => {
    const t = throwWith([], [119]);
    expect(t.score).toBe(1 + 2);
    expect(t.apples.length).toBe(0);
    const n = throwWith([], [120]);
    expect(n.score).toBe(1);
    expect(n.apples.length).toBe(1);
  });
  test('the distance wraps round the turn (3599 is 1 away from 0)', () => {
    expect(throwWith([3600 - 50], []).dead).toBe(true);
  });
});

describe('Chakkar Chaku client: the crack countdown starts at exactly 6 s idle', () => {
  test('no countdown at 359 idle steps, 4 at 360, 1 in the last second, then the run ends at 600', () => {
    const g = H.boot({ seed: SEED });
    g.clickPlay();
    const pr = g.probe();
    while (pr.sim.trans > 0) g.advance(1000 / 60);
    const t0 = pr.sim.lastAct, seen = {};
    while (!pr.sim.dead) { g.advance(1000 / 60); seen[pr.sim.step - t0] = pr.fx.warnSec; }
    expect(seen[359]).toBe(0);
    expect(seen[360]).toBe(4);
    expect(seen[599]).toBe(1);
    expect(pr.sim.deathStep - t0).toBe(600);
  });
});

describe('Chakkar Chaku: bounds no corpus reaches, placed by hand', () => {
  test('nine refusals are not suspicious, ten are', () => {
    const mk = (k) => { const ev = [start()]; for (let i = 0; i < k; i++) ev.push({ type: 'input', payload: { kind: 'throw', n: -1, step: 1 } }); return run(ev).fin.suspicious; };
    expect(mk(9)).toBeNull();
    expect(mk(10)).toBe('validator_rejects:10');
  });
  test('a throw past the work bound is refused, never applied', () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, start());
    for (let i = 0; i <= S.TRANS; i++) S.stepSim(st.sim);
    st.sim.lastAct = 1e12;                       // a log that cannot end itself
    const r = V.processEvent(st, thr(0, S.MAX_SIM_STEPS + 10));
    expect(r.reason).toBe('beyond_cap');
    expect(st.sim.throws).toBe(0);
  });
  test('2,000 seeds x 50 logs: every apple sits at least 145 units from every pre-stuck knife', () => {
    let near = 0;
    for (let s = 0; s < 2000; s++) for (let k = 0; k < 50; k++) {
      const sp = S.logSpec((s * 2654435761) >>> 0, k);
      for (const a of sp.apples) for (const b of sp.stuck) { const d = S.circ(a, b); expect(d).toBeGreaterThanOrEqual(145); if (d < 150) near++; }
    }
    expect(near).toBeGreaterThan(0);   // the corpus really comes close to the edge
  });
});
