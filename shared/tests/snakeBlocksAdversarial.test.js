'use strict';

/**
 * Snake Blocks: what a cheat can send, and what the replay does with it.
 *
 * Every attack here is a trace a hostile client could post. The replay scores
 * only what the inputs produce, refuses what is malformed WHOLE (never half
 * applied), never lets a head teleport, never lets a trace outlive its session,
 * and never reads a number the client claims. An honest control must always be
 * PAID: a validator that scores everything zero would pass half of this file.
 */

const H = require('./lib/snakeBlocksRealGame');
const V = require('../anticheat/validators/snakeBlocks');

const S = V._sim;
const SEED = H.seedsFor(3)[1];
const ev = (payload) => ({ type: 'input', payload });
const START = ev({ kind: 'start', v: 2 });
const touch = (step) => ev({ kind: 'touch', step });
const lift = (step) => ev({ kind: 'lift', step });
const path = (f, x) => ev({ kind: 'path', f, x });

function run(events, opts = {}) {
  const st = V.init({ seed: SEED, ...opts });
  const out = events.map((e) => V.processEvent(st, e));
  return { st, out, fin: V.finalize(st) };
}

let HONEST;
beforeAll(() => {
  const r = H.autopilot({ seed: SEED, style: H.STYLES.good, maxSteps: 60 * 60 });
  HONEST = { r, events: H.asEvents(r.trace) };
});

describe('the honest control is paid', () => {
  test('a recorded run replays to exactly the score the player saw', () => {
    expect(HONEST.r.score).toBeGreaterThan(50);
    expect(run(HONEST.events).fin.score).toBe(HONEST.r.score);
    expect(V.simulate(SEED, HONEST.events)).toBe(HONEST.r.score);
  });

  test('replaying the same trace twice scores the same, and a second start changes nothing', () => {
    const doubled = [HONEST.events[0], HONEST.events[1], START, ...HONEST.events.slice(2)];
    expect(run(doubled).fin.score).toBe(HONEST.r.score);
    expect(run(HONEST.events).fin.score).toBe(run(HONEST.events).fin.score);
  });
});

describe('a claimed score is never read', () => {
  test('events that carry a number, with a huge one, add nothing', () => {
    const forged = [START];
    for (const k of ['score', 'break', 'pick', 'jump', 'hit', 'submit', 'heartbeat', 'weird']) {
      forged.push(ev({ kind: k, score: 9999999, value: 9999999, n: 9999999, scoreAfter: 9999999, tHint: 1 }));
    }
    const r = run(forged);
    expect(r.fin.score).toBe(0);
    expect(r.st.rejectCount).toBe(0);
  });

  test('a score field on a real marker or batch is ignored too', () => {
    const e = HONEST.events.map((x) => ({ ...x, payload: { ...x.payload, score: 123456, scoreAfter: 123456 } }));
    expect(run(e).fin.score).toBe(HONEST.r.score);
  });

  test('a trace with no start marker, a v1 marker, or a malformed one is not scored at all', () => {
    for (const bad of [undefined, ev({ kind: 'start', v: 1 }), ev({ kind: 'start', v: 0 }), ev({ kind: 'start', v: null }), ev({ kind: 'start' })]) {
      const e = bad ? [bad, ...HONEST.events.slice(1)] : HONEST.events.slice(1);
      expect(run(e).fin.score).toBe(0);
    }
  });

  test('events of the wrong shape are ignored, not thrown on', () => {
    const e = [null, undefined, 5, 'x', {}, { type: 'other', payload: {} }, { type: 'input' }, { type: 'input', payload: null }, ...HONEST.events];
    expect(() => run(e)).not.toThrow();
    expect(run(e).fin.score).toBe(HONEST.r.score);
  });
});

describe('malformed input is refused WHOLE', () => {
  const armed = () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, START);
    V.processEvent(st, touch(30));
    return st;
  };
  const refused = (st, e) => {
    const before = st.sim.frames;
    const r = V.processEvent(st, e);
    expect(r.reason).toBeDefined();
    return before === st.sim.frames;
  };

  test('a path batch with ANY bad sample moves nothing', () => {
    const base = Array.from({ length: 10 }, () => 207);
    for (const bad of [1.5, NaN, Infinity, -Infinity, '207', null, undefined, S.X_MIN - 1, S.X_MAX + 1, -5, 1e9]) {
      const st = armed();
      const x = base.slice();
      x[7] = bad;
      expect(refused(st, path(29, x))).toBe(true);
      expect(st.sim.frames).toBeLessThan(30);
    }
  });

  test('a path batch with a bad frame, a bad length or a bad shape is refused', () => {
    for (const f of [-1, 1.5, NaN, '29', null, undefined, Infinity]) { const st = armed(); expect(refused(st, path(f, [207]))).toBe(true); }
    for (const x of [[], null, undefined, 'abc', 5, {}, new Array(S.PATH_BATCH_MAX + 1).fill(207)]) { const st = armed(); expect(refused(st, path(29, x))).toBe(true); }
  });

  test('a batch before any touch, or after a lift, is refused', () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, START);
    expect(V.processEvent(st, path(0, [207])).reason).toBe('not_down');
    V.processEvent(st, touch(30));
    V.processEvent(st, path(29, [207, 207]));
    V.processEvent(st, lift(32));
    expect(V.processEvent(st, path(32, [207])).reason).toBe('not_down');
  });

  test('markers with a bad step, a repeat or the wrong order are refused', () => {
    for (const step of [0, -3, 1.5, NaN, '30', null, undefined]) {
      const st = V.init({ seed: SEED }); V.processEvent(st, START);
      expect(V.processEvent(st, touch(step)).reason).toBe('bad_marker');
    }
    const st = V.init({ seed: SEED }); V.processEvent(st, START);
    expect(V.processEvent(st, lift(5)).reason).toBe('bad_marker');          // lift with no touch
    V.processEvent(st, touch(30));
    expect(V.processEvent(st, touch(40)).reason).toBe('bad_marker');        // touch while down
  });

  test('nothing can rewind: a batch or a marker for a step already run is refused', () => {
    const st = armed();
    V.processEvent(st, path(29, Array.from({ length: 40 }, () => 207)));
    const frames = st.sim.frames;
    expect(V.processEvent(st, path(frames - 10, [207, 207])).reason).toBe('frame_regressed');
    expect(V.processEvent(st, lift(frames - 10)).reason).toBe('frame_regressed');
    expect(st.sim.frames).toBe(frames);
  });

  test('re-sending a batch cannot score it twice', () => {
    const e = HONEST.events;
    const dup = [];
    for (const x of e) { dup.push(x); if (x.payload.kind === 'path') dup.push(x); }
    const r = run(dup);
    expect(r.fin.score).toBe(HONEST.r.score);
    expect(r.st.rejectCount).toBeGreaterThan(0);
  });

  test('rejections are counted, and a run with many of them is flagged, never zeroed', () => {
    const e = [HONEST.events[0]];
    for (let i = 0; i < 12; i++) e.push(path(-1, [1]));
    e.push(...HONEST.events.slice(1));
    const r = run(e);
    expect(r.fin.score).toBe(HONEST.r.score);
    expect(r.fin.suspicious).toMatch(/^validator_rejects:/);
  });
});

describe('a head cannot teleport, and a trace cannot outlive its session', () => {
  test('a target thrown from one wall to the other every step moves the head 13 units at most', () => {
    const st = V.init({ seed: SEED });
    const moves = [];
    let last = null;
    st.onStep = (sim) => { if (last !== null) moves.push(Math.abs(sim.hx - last)); last = sim.hx; };
    V.processEvent(st, START);
    V.processEvent(st, touch(30));
    const x = [];
    for (let i = 0; i < 100; i++) x.push(i % 2 ? S.X_MAX : S.X_MIN);
    V.processEvent(st, path(29, x));
    expect(moves.length).toBeGreaterThan(50);
    expect(Math.max(...moves)).toBeLessThanOrEqual(S.HEAD_MAX_STEP);
  });

  test('a flick across the whole field takes at least 14 steps', () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, START);
    V.processEvent(st, touch(30));
    V.processEvent(st, path(29, Array.from({ length: 13 }, () => S.X_MAX)));
    expect(st.sim.hx).toBeLessThan(S.X_MAX);
    expect(st.sim.hx).toBe(S.START_X + 12 * S.HEAD_MAX_STEP);   // the arming step itself does not move
  });

  test('a trace that claims far more play than the session lasted is cut at the session', () => {
    // a still, immortal-looking head, claimed against a 60 s session
    const e = [START, touch(30), path(29, new Array(120).fill(207))];
    const r = run(e, { elapsedSecs: 60 });
    expect(r.st.sim.frames).toBeLessThanOrEqual(Math.ceil((60 * 1.2 + 10) * 60));
  });

  test('a run that never touches the screen is ended as idle, scoring nothing', () => {
    const r = run([START]);
    expect(r.fin.score).toBe(0);
    expect(r.fin.debug.deathCause).toBe('idle');
    expect(r.fin.debug.deathFrame).toBe(S.ARM_TIMEOUT_STEPS);
  });

  test('a head that touches once and never moves is crushed, however long the run is allowed', () => {
    const r = run([START, touch(30)], { maxDurationSecs: 3600 });
    expect(r.fin.debug.dead).toBe(true);
    expect(r.fin.debug.deathCause).toBe('crushed');
    expect(r.fin.debug.deathFrame).toBeLessThan(S.ARM_TIMEOUT_STEPS);
  });

  test('the input cap refuses further samples and keeps what was earned', () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, START);
    V.processEvent(st, touch(30));
    st.inputCount = S.MAX_INPUTS - 5;
    const r = V.processEvent(st, path(29, new Array(10).fill(207)));
    expect(r.reason).toBe('input_cap');
    expect(st.score).toBe(0);
    expect(V.finalize(st).gameOver).toBe(true);
  });

  test('once the run is over nothing more is accepted', () => {
    const e = [...HONEST.events];
    const st = V.init({ seed: SEED });
    for (const x of e) V.processEvent(st, x);
    expect(st.dead).toBe(true);
    const r = V.processEvent(st, path(HONEST.r.endFrame, [207]));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('dead');
    expect(V.finalize(st).score).toBe(HONEST.r.score);
  });

  test('a trace that stops early is scored as the run it was: the world runs out from where it left off', () => {
    const half = HONEST.events.slice(0, Math.ceil(HONEST.events.length / 2));
    const r = run(half);
    expect(r.fin.score).toBeLessThanOrEqual(HONEST.r.score + 0);
    expect(r.fin.gameOver).toBe(true);
  });
});

describe('dividers and blocks hold the head, they never kill it', () => {
  function findWallRow(seed) {
    for (let n = 8; n < 400; n++) {
      const sp = S.rowSpec(seed, n);
      if (sp.walls) return { n, sp };
    }
    return null;
  }

  test('a head against a divider is stopped at its line, on whichever side it started', () => {
    const seed = S.seedToInt(SEED);
    const w = findWallRow(seed);
    expect(w).not.toBeNull();
    const sim = S.initSim(SEED);
    sim.armed = true;
    sim.rowN = w.n;
    sim.rowVals = [0, 0, 0, 0, 0];
    sim.specs.set(w.n, { ...w.sp, vals: [0, 0, 0, 0, 0] });
    const b = [1, 2, 3, 4].find((k) => w.sp.walls & (1 << (k - 1)));
    const wx = S.LANE_X + b * S.COL_W;
    // inside the divider's span: y1 is the top end, so stand in the middle of it
    const y1 = w.n * S.ROW_HQ - 8 * S.U;
    sim.scroll = y1 - 48 * S.U;
    sim.hx = wx - 30;
    for (let i = 0; i < 20; i++) { sim.scroll = y1 - 48 * S.U; S.stepSim(sim, true, S.X_MAX); }
    expect(sim.hx).toBeLessThan(wx);
    expect(sim.dead).toBe(false);
    sim.hx = wx + 30;
    for (let i = 0; i < 20; i++) { sim.scroll = y1 - 48 * S.U; S.stepSim(sim, true, S.X_MIN); }
    expect(sim.hx).toBeGreaterThan(wx);
    expect(sim.dead).toBe(false);
  });

  test('a head cannot slide sideways into a standing block, it is held at its edge', () => {
    const sim = S.initSim(SEED);
    sim.armed = true;
    sim.rowN = 0;
    sim.rowVals = [0, 9, 0, 0, 0];
    sim.specs.set(0, { n: 0, full: false, mask: 2, vals: [0, 9, 0, 0, 0], pick: null, walls: 0, anchor: 0 });
    sim.scroll = 0 * S.ROW_HQ - S.HEAD_R * S.U + 100;   // inside the engaged band
    sim.hx = S.colMid(3);
    for (let i = 0; i < 40; i++) { sim.scroll = -S.HEAD_R * S.U + 100; S.stepSim(sim, true, S.X_MIN); }
    expect(sim.hx).toBeGreaterThanOrEqual(S.colRight(1) + S.HEAD_R);
    expect(sim.dead).toBe(false);
  });
});

describe('the economy cannot be skipped', () => {
  test('a full row cannot be passed without breaking a block: it has no gap', () => {
    for (let n = 0; n < 300; n++) {
      const sp = S.rowSpec(S.seedToInt(SEED), n);
      if (sp.full) expect(sp.vals.filter((v) => v > 0)).toHaveLength(5);
    }
  });

  test('an honest game of any skill always ends: the bleed has no floor', () => {
    for (const name of ['flawless', 'good', 'average', 'dodger']) {
      const r = H.autopilot({ seed: SEED, style: H.STYLES[name], maxSteps: 60 * 400 });
      expect(r.died).toBe(true);
    }
  });
});

describe('the bot detector can read the trace', () => {
  const F = require('../anticheat/humanness/features');

  test('Snake Blocks is registered as a steering game, so its inputs are strokes, not zero', () => {
    expect(F.GAME_INPUTS['snake-blocks']).toEqual({ path: true });
    const f = F.extractFeatures('snake-blocks', HONEST.events);
    expect(f.inputs).toBeGreaterThan(5);
    expect(f.spanSec).toBeGreaterThan(5);
    expect(f.strokeN).toBeGreaterThan(5);
  });

  test('the validator records the lane-accuracy raw material and never gates on it', () => {
    const fin = run(HONEST.events).fin;
    const fp = fin.debug.fingerprint;
    expect(fp.rowsEntered).toBeGreaterThan(5);
    expect(fp.meanLaneErr).toBeGreaterThanOrEqual(0);
    expect(fp.strokes).toBeGreaterThan(5);
    expect(fp.touches).toBe(1);
    expect(fin.suspicious).toBeNull();
  });
});

describe('the replay bookkeeping is exact', () => {
  const armed = () => {
    const st = V.init({ seed: SEED });
    V.processEvent(st, START);
    V.processEvent(st, touch(30));
    return st;
  };

  test('a batch for a step already run is refused even by ONE step (no overlap, no second chance)', () => {
    const st = armed();
    V.processEvent(st, path(29, new Array(20).fill(207)));
    const frames = st.sim.frames;
    expect(V.processEvent(st, path(frames - 1, [207])).reason).toBe('frame_regressed');
    expect(st.sim.frames).toBe(frames);
    expect(V.processEvent(st, path(frames, [207])).reason).toBeUndefined();
  });

  test('a step beyond the simulation bound is refused as too late, for a batch and for a marker', () => {
    const st = armed();
    expect(V.processEvent(st, path(S.MAX_SIM_STEPS, [207])).reason).toBe('too_late');
    expect(V.processEvent(st, path(S.MAX_SIM_STEPS + 50, [207])).reason).toBe('too_late');
    expect(V.processEvent(st, lift(S.MAX_SIM_STEPS + 2)).reason).toBe('too_late');
    expect(st.sim.frames).toBeLessThan(40);
  });

  test('a lift that names a later step runs the world up to it, holding where the head was', () => {
    const st = armed();
    V.processEvent(st, path(29, new Array(6).fill(207)));
    V.processEvent(st, lift(120));
    expect(st.sim.frames).toBe(119);
    expect(st.down).toBe(false);
  });

  test('a batch that names a later step runs the world up to it first', () => {
    const st = armed();
    V.processEvent(st, path(100, [207, 207]));
    expect(st.sim.frames).toBe(102);
  });

  test('the head holds the last place it was steered to across a gap and after the trace ends', () => {
    const st = armed();
    const xs = [];
    st.onStep = (sim) => xs.push(sim.hx);
    V.processEvent(st, path(29, new Array(12).fill(100)));
    expect(st.sim.hx).toBe(100);
    V.processEvent(st, path(80, [100]));
    expect(xs[xs.length - 8]).toBe(100);   // still there, deep inside the gap
    expect(st.sim.hx).toBe(100);
  });

  test('a second start marker in the middle of a run changes nothing about it', () => {
    const e = HONEST.events.slice();
    e.splice(Math.floor(e.length / 2), 0, START, START);
    const r = run(e);
    expect(r.fin.score).toBe(HONEST.r.score);
    expect(r.fin.debug.deathFrame).toBe(HONEST.r.endFrame);
  });

  test('a session that lasted a minute cannot be replayed for longer than a minute and a bit', () => {
    const st = V.init({ seed: SEED, elapsedSecs: 60, maxDurationSecs: 3600 });
    V.processEvent(st, START);
    V.processEvent(st, touch(30));
    V.processEvent(st, path(29, new Array(10).fill(207)));
    st.sim.len = 1e7;                  // a head that cannot be crushed, so only the cap can stop the run-out
    V.finalize(st);
    expect(st.sim.frames).toBe(Math.ceil((60 * 1.2 + 10) * 60));
  });
});

// Geometry that only shows at one exact value. A flown corpus meets these edges
// by luck or never, and a change made in BOTH files passes the parity suite, so
// every edge is pinned here by hand, one sub-unit either side.
describe('the edges of the rules, pinned by hand', () => {
  const n = 12;
  const HEAD_RQ = S.HEAD_R * S.U;
  const b = 2;                                           // a divider between lanes 1 and 2
  const wx = S.LANE_X + b * S.COL_W;
  const wallTop = (row) => row * S.ROW_HQ - 8 * S.U;      // y1: the end the head meets last
  const mk = (vals, walls, nextWalls) => {
    const sim = S.initSim(SEED);
    sim.armed = true;
    sim.rowN = n;
    sim.rowVals = vals.slice();
    sim.specs.set(n, { n, full: false, mask: 0, vals: vals.slice(), pick: null, walls: walls || 0, anchor: 0 });
    sim.specs.set(n + 1, { n: n + 1, full: false, mask: 0, vals: [0, 0, 0, 0, 0], pick: null, walls: nextWalls || 0, anchor: 0 });
    return sim;
  };
  const bit = 1 << (b - 1);

  test('a divider holds the head from the first sub-unit of its span to the last, and not one more', () => {
    const y1 = wallTop(n);
    const y0 = y1 - 96 * S.U;
    const held = (scroll) => { const s = mk([0, 0, 0, 0, 0], bit); s.scroll = scroll; return S.clampLateral(s, 145, 155); };
    expect(held(y0 - HEAD_RQ)).toBe(155);              // the head's front just touches the far end: free
    expect(held(y0 - HEAD_RQ + 1)).toBe(wx - S.HEAD_R - 3);   // one sub-unit inside: held at the line
    expect(held(y1 + HEAD_RQ)).toBe(155);              // the head's back just leaves: free
    expect(held(y1 + HEAD_RQ - 1)).toBe(wx - S.HEAD_R - 3);
  });

  test('the next row\'s dividers hold the head while it is still on this row', () => {
    const y1 = wallTop(n + 1);
    const y0 = y1 - 96 * S.U;
    const s = mk([0, 0, 0, 0, 0], 0, bit);
    s.scroll = y0 - HEAD_RQ + 1;
    expect(S.clampLateral(s, 145, 155)).toBe(wx - S.HEAD_R - 3);
    s.scroll = y0 - HEAD_RQ;
    expect(S.clampLateral(s, 145, 155)).toBe(155);
  });

  test('a head exactly on a divider line is pushed to the RIGHT, and no sideways push exceeds one step of the hand', () => {
    const y1 = wallTop(n);
    const s = mk([0, 0, 0, 0, 0], bit);
    s.scroll = y1 - 48 * S.U;
    expect(S.clampLateral(s, wx, wx)).toBe(wx + S.HEAD_MAX_STEP);          // on the line: right side
    expect(S.clampLateral(s, wx + 4, wx + 4)).toBe(wx + 4 + S.HEAD_MAX_STEP); // would be 14 to clear: bounded to 13
    expect(S.clampLateral(s, wx - 4, wx - 4)).toBe(wx - 4 - S.HEAD_MAX_STEP);
    expect(S.clampLateral(s, wx + 5, wx + 5)).toBe(wx + 18);               // exactly 13 to clear: allowed
  });

  test('a block band holds the head from its first sub-unit to its last, and not one more', () => {
    const nb = n * S.ROW_HQ;
    const held = (scroll) => { const s = mk([0, 5, 0, 0, 0]); s.scroll = scroll; return S.clampLateral(s, 190, 180); };
    expect(held(nb - HEAD_RQ)).toBe(180);               // just touching: free
    expect(held(nb - HEAD_RQ + 1)).toBe(S.colRight(1) + S.HEAD_R);
    expect(held(nb + S.BLOCK_HQ + HEAD_RQ)).toBe(180);  // just clear: free
    expect(held(nb + S.BLOCK_HQ + HEAD_RQ - 1)).toBe(S.colRight(1) + S.HEAD_R);
  });

  test('a head exactly on a block\'s left edge is pushed to the RIGHT of it', () => {
    const s = mk([0, 5, 0, 0, 0]);
    s.scroll = n * S.ROW_HQ;
    expect(S.clampLateral(s, S.colLeft(1), S.colLeft(1))).toBe(S.colLeft(1) + S.HEAD_MAX_STEP);
  });

  test('a head touches a block only when it overlaps it: a sub-unit short is clear', () => {
    const s = mk([0, 5, 0, 0, 0]);
    expect(S.firstBlocking({ ...s, hx: S.colLeft(1) - S.HEAD_R, rowVals: s.rowVals })).toBe(-1);
    expect(S.firstBlocking({ ...s, hx: S.colLeft(1) - S.HEAD_R + 1, rowVals: s.rowVals })).toBe(1);
    expect(S.firstBlocking({ ...s, hx: S.colRight(1) + S.HEAD_R, rowVals: s.rowVals })).toBe(-1);
    expect(S.firstBlocking({ ...s, hx: S.colRight(1) + S.HEAD_R - 1, rowVals: s.rowVals })).toBe(1);
  });

  test('the head arms on exactly the 27th step with a finger down, and not before', () => {
    const sim = S.initSim(SEED);
    for (let i = 1; i <= S.START_GUARD_STEPS - 1; i++) { S.stepSim(sim, true, 207); expect(sim.armed).toBe(false); }
    S.stepSim(sim, true, 207);
    expect(sim.frames).toBe(S.START_GUARD_STEPS);
    expect(sim.armed).toBe(true);
    const lifted = S.initSim(SEED);
    for (let i = 1; i <= 60; i++) S.stepSim(lifted, false, 207);
    expect(lifted.armed).toBe(false);
  });

  test('the idle death falls on exactly step 1800, not 1799 and not 1801', () => {
    const sim = S.initSim(SEED);
    for (let i = 1; i < S.ARM_TIMEOUT_STEPS; i++) S.stepSim(sim, false, 207);
    expect(sim.dead).toBe(false);
    S.stepSim(sim, false, 207);
    expect(sim.dead).toBe(true);
    expect(sim.deathCause).toBe('idle');
    expect(sim.deathFrame).toBe(S.ARM_TIMEOUT_STEPS);
  });

  test('a pickup is taken at exactly its radius and not one sub-unit beyond', () => {
    const take = (dy) => {
      const sim = mk([0, 0, 0, 0, 0]);
      sim.specs.set(n, { n, full: false, mask: 0, vals: [0, 0, 0, 0, 0], pick: { c: 3, v: 7 }, walls: 0, anchor: 0 });
      sim.hx = S.colMid(3);
      sim.scroll = n * S.ROW_HQ + S.PICK_YQ + dy;
      sim.lastPick = n - 1;
      return sim;
    };
    const R = (S.HEAD_R + 14) * S.U;
    const at = (dy) => { const sim = take(dy); S.takePick(sim); return sim.picks; };
    expect(at(R)).toBe(1);
    expect(at(R + 1)).toBe(0);
    expect(at(-R)).toBe(1);
    expect(at(-R - 1)).toBe(0);
    const sim = take(0); S.takePick(sim);
    expect(sim.len).toBe(S.START_LEN + 7);
    S.takePick(sim);
    expect(sim.len).toBe(S.START_LEN + 7);          // once per row
  });

  test('the head reaches both walls of the field exactly, and no further', () => {
    for (const [target, edge] of [[S.X_MAX, S.X_MAX], [S.X_MIN, S.X_MIN], [S.X_MAX + 500, S.X_MAX], [S.X_MIN - 500, S.X_MIN]]) {
      const sim = S.initSim(SEED);
      sim.armed = true;
      sim.rowN = 0;
      for (let i = 0; i < 40; i++) S.stepSim(sim, true, target);
      expect(sim.hx).toBe(edge);
    }
  });

  test('a block starts to bite on the step the head\'s front reaches it, not the step before', () => {
    const nb = n * S.ROW_HQ;
    const sim = mk([0, 0, 7, 0, 0]);
    sim.hx = S.colMid(2);
    const speed = Math.min(S.SPEED_CAP, S.SPEED_BASE + n);   // the rules recompute it every step
    sim.scroll = nb - HEAD_RQ - speed;               // exactly one step of travel from touching
    S.stepSim(sim, true, sim.hx);
    expect(sim.scroll).toBe(nb - HEAD_RQ);
    expect(sim.hitCol).toBe(-1);
    expect(sim.hitT).toBe(0);
    S.stepSim(sim, true, sim.hx);
    expect(sim.hitCol).toBe(2);
    expect(sim.hitT).toBe(1);
  });

  test('a ball is one unit off a block whatever its size: a block of fifty loses exactly one', () => {
    const sim = mk([0, 0, 50, 0, 0]);
    sim.hx = S.colMid(2);
    sim.len = 100;
    sim.scroll = n * S.ROW_HQ - HEAD_RQ - 5;
    let guard = 0;
    while (!(sim.ev & 1) && guard++ < 50) S.stepSim(sim, true, sim.hx);
    expect(sim.rowVals[2]).toBe(49);
    expect(sim.len).toBe(99);
    expect(sim.score).toBe(1);
  });

  test('a one-lane channel is never exactly as wide as the head, so a jammed head is a real case', () => {
    // every lower and upper limit is a multiple of the lane width plus a head or divider margin
    const lows = [S.HEAD_R, S.HEAD_R + 3 + 0, S.HEAD_R + 3];
    for (const k of [0, 1, 2, 3, 4, 5]) for (const a of [S.HEAD_R, S.HEAD_R + 3]) for (const b of [S.HEAD_R, S.HEAD_R + 3]) {
      expect(k * S.COL_W - a - b === 0).toBe(false);
    }
    expect(lows.length).toBe(3);
  });

  test('the open lane before row zero is the middle one', () => {
    expect(S.anchorAt(S.seedToInt(SEED), -1)).toBe(2);
    expect(S.anchorAt(S.seedToInt(SEED), 0)).toBe(2);
  });
});
