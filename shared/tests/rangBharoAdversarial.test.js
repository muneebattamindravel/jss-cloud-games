'use strict';

/**
 * Rang Bharo adversarial: forged, stacked, rewound, malformed and flooded
 * traces must score no more than the moves they really contain earn, and a
 * refusal never zeroes an honest run. Properties are asserted, never counts of
 * rejections.
 */
const H = require('./lib/rangBharoRealGame');
const W = require('./lib/rangBharoWorld');
const V = require('../anticheat/validators/rangBharo');
const F = require('../anticheat/humanness/features');
const S = V._sim;

const SEED = H.seedHex(11);
const start = (v = 1) => ({ type: 'input', payload: { kind: 'start', v } });
const mv = (n, dir, step, extra) => ({ type: 'input', payload: Object.assign({ kind: 'move', n, dir, step }, extra || {}) });
function run(events, opts = {}) {
  const st = V.init(Object.assign({ seed: SEED }, opts));
  const out = events.map((e) => V.processEvent(st, e));
  return { st, out, fin: V.finalize(st) };
}
function honest(seed = SEED, pilot = 'good', rng = 5) {
  const g = H.boot({ seed });
  const r = H.fly(g, pilot, { rngSeed: rng });
  return { trace: g.trace, score: r.score, sim: r.sim };
}
const H1 = honest();
// The first maze's designed route, played as fast as the rules allow: a known
// good schedule built by hand from the rules (the validator never picks it).
function routeSchedule(seed, upto) {
  const sim = S.initSim(seed, 1), out = [];
  while (sim.n <= upto && !sim.over) {
    const n = sim.n;
    for (const d of sim.maze.path) {
      while (sim.dir >= 0 || sim.pause > 0) S.stepSim(sim);
      if (sim.n !== n) break;
      out.push({ n: sim.inputs, dir: d, step: sim.step });
      S.inputDir(sim, d); S.stepSim(sim);
    }
    while (sim.dir >= 0 || sim.pause > 0) S.stepSim(sim);
  }
  return { out, sim };
}

describe('Rang Bharo validator: the server computes the score, the client claims nothing', () => {
  test('an honest trace scores exactly what the game showed', () => {
    const { fin } = run(H1.trace, { elapsedSecs: 200 });
    expect(fin.score).toBe(H1.score);
    expect(fin.debug.rejects).toBe(0);
    expect(fin.gameOver).toBe(true);
  });
  test('a claimed score, a claimed clear or a claimed cell in the payload is never read', () => {
    const forged = H1.trace.map((e) => ({ type: e.type, payload: Object.assign({}, e.payload, { score: 99999, cleared: true, painted: 999, c: 3, par: 0 }) }));
    expect(run(forged).fin.score).toBe(H1.score);
  });
  test('no start marker: nothing scores', () => {
    expect(run(H1.trace.filter((e) => e.payload.kind !== 'start')).fin.score).toBe(0);
  });
  test('a v0 marker is not a replay and scores zero', () => {
    expect(run([start(0)].concat(H1.trace.slice(1))).fin.score).toBe(0);
  });
  test('a second start marker cannot reset the run', () => {
    const ev = H1.trace.slice();
    ev.splice(Math.floor(ev.length / 2), 0, start(1));
    expect(run(ev).fin.score).toBe(H1.score);
  });
  test('a trace of no moves scores 0 and the clock still runs out', () => {
    const { fin } = run([start()]);
    expect(fin.score).toBe(0);
    expect(fin.debug.steps).toBe(S.TIME_STEPS);
    expect(fin.gameOver).toBe(true);
  });
  test('events of other types or kinds change nothing', () => {
    const ev = [start(), { type: 'heartbeat' }, { type: 'input', payload: { kind: 'tap', step: 5 } }, null, 7, { type: 'input' }].concat(H1.trace.slice(1));
    expect(run(ev).fin.score).toBe(H1.score);
  });
});

describe('Rang Bharo validator: a refused move changes nothing and never zeroes', () => {
  const R = routeSchedule(SEED, 2);
  const routeTrace = W.traceOf(R.out);
  const routeScore = run(routeTrace).fin.score;
  test('the hand-built route clears mazes 1 and 2 at par', () => {
    const { fin } = run(routeTrace);
    expect(fin.debug.mazes).toBeGreaterThanOrEqual(2);
    expect(fin.debug.rejects).toBe(0);
  });
  test('a second move on the same step is refused: stacking buys nothing', () => {
    const ev = [start()];
    for (const t of R.out) { ev.push(mv(t.n, t.dir, t.step)); ev.push(mv(t.n + 1, (t.dir + 1) & 3, t.step)); }
    const { fin, out } = run(ev);
    expect(fin.score).toBe(routeScore);
    expect(out.filter((o) => o.reason).length).toBeGreaterThan(0);
  });
  test('a hundred moves on one step buy one move', () => {
    const t0 = 5, ev = [start()];
    for (let i = 0; i < 100; i++) ev.push(mv(i === 0 ? 0 : 1, i & 3, t0));
    const { fin } = run(ev);
    expect(fin.debug.accepted).toBe(1);
  });
  test('steps may not go backwards', () => {
    const { out } = run([start(), mv(0, 1, 40), mv(1, 2, 30)]);
    expect(out[2].reason).toBe('frame_regressed');
  });
  test('a move must name its index among accepted moves', () => {
    const { out, fin } = run([start(), mv(3, 1, 40)]);
    expect(out[1].reason).toBe('out_of_order');
    expect(fin.debug.accepted).toBe(0);
  });
  test.each([[4], [-1], [1.5], ['1'], [null], [NaN], [Infinity], [{}]])('a direction of %p is refused', (d) => {
    const { out, fin } = run([start(), mv(0, d, 40)]);
    expect(out[1].reason).toBe('refused');
    expect(fin.debug.moves).toBe(0);
    expect(fin.debug.accepted).toBe(0);
  });
  test.each([[-1], [2.5], ['40'], [null], [1e400]])('a step of %p is refused', (st) => {
    const { out } = run([start(), mv(0, 1, st)]);
    expect(out[1].reason).toBe('bad_move');
  });
  test('junk spliced between honest moves never zeroes the honest run', () => {
    const ev = [];
    H1.trace.forEach((e, i) => {
      ev.push(e);
      if (e.payload.kind === 'move' && i % 5 === 0) {
        ev.push(mv(e.payload.n, 9, e.payload.step));
        ev.push(mv(-4, 1, e.payload.step));
        ev.push(mv(e.payload.n + 7, 1, e.payload.step));
      }
    });
    const { fin } = run(ev);
    expect(fin.score).toBe(H1.score);
    expect(fin.debug.rejects).toBeGreaterThan(0);
  });
  test('moves after the clock score nothing more', () => {
    const late = H1.trace.concat([mv(H1.sim.inputs, 1, S.TIME_STEPS + 5), mv(H1.sim.inputs + 1, 2, S.TIME_STEPS + 900)]);
    expect(run(late).fin.score).toBe(H1.score);
  });
  test('a move on the very last step is taken, one past it is not', () => {
    const a = run([start(), mv(0, R.out[0].dir, S.TIME_STEPS)]);
    expect(a.fin.debug.accepted).toBe(1);
    const b = run([start(), mv(0, R.out[0].dir, S.TIME_STEPS + 1)]);
    expect(b.fin.debug.accepted).toBe(0);
  });
  test('an input flood past MAX_INPUTS is capped and changes nothing more', () => {
    const ev = [start()];
    for (let i = 0; i < S.MAX_INPUTS + 500; i++) ev.push(mv(Math.floor(i / 3), i & 3, Math.floor(i / 3)));
    const { fin } = run(ev);
    expect(fin.debug.inputs).toBe(10900);
    // the capped run equals the same trace cut at the cap
    expect(fin.score).toBe(run(ev.slice(0, S.MAX_INPUTS + 1)).fin.score);
  });
  test('a swipe mid-slide is buffered: only the latest is kept, and buffering buys no extra move', () => {
    const t = R.out[0];
    const ev = [start(), mv(0, t.dir, t.step), mv(1, 0, t.step + 1), mv(2, 1, t.step + 2), mv(3, 2, t.step + 3)];
    const st = V.init({ seed: SEED });
    ev.forEach((e) => V.processEvent(st, e));
    expect(st.sim.queued).toBe(2);
    expect(st.sim.totalMoves).toBe(1);
  });
});

describe('Rang Bharo rules on their own (every caller checks these too)', () => {
  test('a finished run takes no input and steps no further', () => {
    const sim = S.initSim(SEED, 1);
    while (!sim.over) S.stepSim(sim);
    const before = JSON.stringify(W.worldOf(sim));
    expect(S.inputDir(sim, 1)).toBe(false);
    S.stepSim(sim);
    expect(JSON.stringify(W.worldOf(sim))).toBe(before);
  });
  test.each([[4], [-1], [1.5], ['1'], [null], [NaN]])('inputDir refuses a direction of %p', (d) => {
    const sim = S.initSim(SEED, 1);
    expect(S.inputDir(sim, d)).toBe(false);
    expect(sim.inputs).toBe(0);
  });
  test('the ball never leaves the grid: every edge of every maze is a wall', () => {
    for (let n = 1; n <= 14; n++) {
      const m = S.genMaze(SEED, n), sim = { maze: m };
      for (let x = 0; x < m.w; x++) { expect(S.blockedAt(sim, x, 0, 0)).toBe(true); expect(S.blockedAt(sim, x, m.h - 1, 2)).toBe(true); }
      for (let y = 0; y < m.h; y++) { expect(S.blockedAt(sim, 0, y, 3)).toBe(true); expect(S.blockedAt(sim, m.w - 1, y, 1)).toBe(true); }
    }
  });
  test('the fallback maze (a ring) is valid at every size, though no seed has needed it', () => {
    for (let w = 6; w <= S.MAX_W; w++) for (let h = 6; h <= S.MAX_H; h++) {
      const r = S.ringMaze(w, h);
      expect(r.floors).toBe(Array.from(r.cells).reduce((a, b) => a + b, 0));
      expect(S.trapFree(r.cells, w, h, r.start)).toBe(true);
      expect(S.solvePar(r.cells, w, h, r.start, r.floors)).toBe(r.par);
      let c = r.start; const seen = new Set([c]);
      for (const d of r.path) { const e = S.slideEnd(r.cells, w, h, c, d); while (c !== e) { c += S.DX[d] + S.DY[d] * w; seen.add(c); } }
      expect(seen.size).toBe(r.floors);
    }
  });
  test('trapFree tells a trap from a maze with none', () => {
    // a ring: every stop gets back to every other
    expect(S.trapFree(new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3, 0)).toBe(true);
    // a row of three with the ball in the middle: after any slide it can never
    // stop in the middle again
    expect(S.trapFree(new Uint8Array([1, 1, 1]), 3, 1, 1)).toBe(false);
    expect(S.trapFree(new Uint8Array([1, 1, 1]), 3, 1, 0)).toBe(true);
  });
});

describe('Rang Bharo validator: bounds on work', () => {
  test('finalize stops at exactly ceil((elapsed x 1.2 + 10) x 60) steps when the session was short', () => {
    for (const e of [3, 20, 61.7]) {
      const { fin } = run([start()], { elapsedSecs: e });
      expect(fin.debug.steps).toBe(Math.ceil((e * 1.2 + 10) * 60));
      expect(fin.gameOver).toBe(false);
    }
  });
  test('the session ceiling is one hour of steps, and the clock ends every run long before', () => {
    expect(V._limits.MAX_SIM_STEPS).toBe(3600 * 60);
    expect(S.TIME_STEPS).toBeLessThan(V._limits.MAX_SIM_STEPS);
  });
  test('the worst trace fits the 4 MB cap: one move a step for the whole run', () => {
    const lines = [];
    for (let i = 0; i < S.MAX_INPUTS; i++) lines.push(JSON.stringify({ type: 'input', seq: i, ts: 1700000000000 + i * 17, payload: { kind: 'move', n: i, dir: i & 3, step: i, tHint: 123456.789 + i } }));
    const gz = require('zlib').gzipSync(lines.join('\n'));
    expect(gz.length).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('Rang Bharo scoring edges (hand-placed)', () => {
  test('PERFECT at exactly par, none at par + 1', () => {
    // maze 1 by its designed route takes `designed` moves; find a seed where
    // that is par, and one where a wasted opening move makes it par + 1
    let hit = 0;
    for (let s = 0; s < 200 && hit < 2; s++) {
      const seed = H.seedHex(800 + s);
      const m = S.genMaze(seed, 1);
      if (m.designed !== m.par) continue;
      const R = routeSchedule(seed, 1);
      const a = run(W.traceOf(R.out), { seed }).fin;
      expect(a.debug.perfects).toBe(1);
      // a wasted first move, then the shortest route from there
      const sim = S.initSim(seed, 1);
      const open = [0, 1, 2, 3].filter((d) => !S.blockedAt(sim, sim.bx, sim.by, d));
      for (const d of open) {
        const t = S.initSim(seed, 1);
        S.inputDir(t, d); while (t.dir >= 0) S.stepSim(t);
        if (t.pause > 0) continue;
        const plan = H.planBfs({ slideEnd: S.slideEnd, DX: S.DX, DY: S.DY }, t.maze, t.by * t.maze.w + t.bx, t.painted, 1e6);
        if (!plan || plan.length !== m.par) continue;   // exactly par + 1 in all
        const sched = [{ n: 0, dir: d, step: 0 }];
        const u = S.initSim(seed, 1); S.inputDir(u, d);
        for (const p of plan) { while (u.dir >= 0) S.stepSim(u); sched.push({ n: u.inputs, dir: p, step: u.step }); S.inputDir(u, p); S.stepSim(u); }
        const b = run(W.traceOf(sched), { seed }).fin;
        expect(b.debug.mazes).toBe(1);
        expect(b.debug.perfects).toBe(0);
        expect(b.score).toBe(a.score - (40 + 8) - 3);   // no PERFECT at maze 1, and one move over par costs 3
        hit++;
        break;
      }
    }
    expect(hit).toBeGreaterThan(0);
  });
  test('a swipe into a wall is not a move and does not count against par', () => {
    const seed = H.seedHex(12);
    const sim = S.initSim(seed, 1);
    const shut = [0, 1, 2, 3].find((d) => S.blockedAt(sim, sim.bx, sim.by, d));
    expect(shut).toBeDefined();
    S.inputDir(sim, shut);
    expect(sim.moves).toBe(0);
    expect(sim.ev.some((e) => e.k === 'bump')).toBe(true);
  });
  test('each move over par costs 3, taken from the clear and never more than the clear pays', () => {
    let partial = 0, capped = 0;
    for (let i = 0; i < 6; i++) {
      const seed = H.seedHex(60 + i);
      const g = H.boot({ seed });
      H.fly(g, i % 2 ? 'novice' : 'lazy', { rngSeed: i, maxSteps: 60 * 90 });
      const sched = W.movesOf(g.trace);
      const sim = S.initSim(seed, 1);
      const check = () => {
        for (const e of sim.ev) if (e.k === 'clear') {
          const n = sim.n, base = 10 * n, over = Math.max(0, e.moves - e.par);
          const cost = Math.min(base, 3 * over);
          expect(e.cost).toBe(cost);
          expect(e.bonus).toBe(base - cost + (e.perfect ? 40 + 8 * n : 0));
          expect(e.perfect).toBe(e.moves <= e.par);
          if (cost > 0 && cost < base) partial++;
          if (cost === base) capped++;
        }
      };
      for (const t of sched) { while (!sim.over && sim.step < t.step) { S.stepSim(sim); check(); } if (sim.over) break; if (sim.step === t.step && t.n === sim.inputs) S.inputDir(sim, t.dir); }
    }
    expect(partial).toBeGreaterThan(0);
    expect(capped).toBeGreaterThan(0);
  });
  test('a clear pays MAZE_BASE x n plus the PERFECT bonus, once', () => {
    const R = routeSchedule(SEED, 3);
    const fin = run(W.traceOf(R.out)).fin;
    let want = fin.debug.tiles;
    for (let n = 1; n <= fin.debug.mazes; n++) want += 10 * n;
    want += fin.debug.perfects ? (40 * fin.debug.perfects + 8 * [1, 2, 3].slice(0, fin.debug.perfects).reduce((a, b) => a + b, 0)) : 0;
    expect(fin.debug.perfects).toBe(3);
    expect(fin.score).toBe(want);
  });
});

describe('Rang Bharo humanness: the extractor reads the trace and the debug records the rhythm', () => {
  test('features.inputs equals the move count once GAME_INPUTS has the entry', () => {
    F.GAME_INPUTS['rang-bharo'] = { kinds: ['move'], time: 'step' };
    const events = H1.trace.map((e, i) => Object.assign({ seq: i, ts: 1700000000000 + i * 300 }, e));
    const f = F.extractFeatures('rang-bharo', events);
    expect(f.inputs).toBe(W.movesOf(H1.trace).length);
    delete F.GAME_INPUTS['rang-bharo'];
  });
  test('a metronome bot and a hand look different in the recorded debug', () => {
    const bot = honest(H.seedHex(41), 'bot', 3), hand = honest(H.seedHex(41), 'good', 3);
    const b = run(bot.trace, { seed: H.seedHex(41) }).fin.debug, h = run(hand.trace, { seed: H.seedHex(41) }).fin.debug;
    expect(b.waitCv).toBeLessThan(0.05);
    expect(h.waitCv).toBeGreaterThan(0.2);
    expect(b.readMean).toBeLessThan(h.readMean);
  });
});
