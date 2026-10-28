'use strict';

/**
 * Snake Blocks: the server's replay must compute exactly what the player's
 * screen showed.
 *
 * The pilots fly the REAL games/snake-blocks/js/game.js
 * (tests/lib/snakeBlocksRealGame.js) and plan with the game's OWN rules
 * functions, never the validator's, so a mutated server rule cannot move the
 * plan and the score together. Parity is checked on the whole SIMULATION after
 * every step, not just the final number: every row re-synchronises the run
 * (a broken block, a taken ball), so a wrong constant can wash out long before
 * it reaches a score.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./lib/snakeBlocksRealGame');
const V = require('../anticheat/validators/snakeBlocks');

const S = V._sim;
const VALIDATOR_PATH = path.join(H.ROOT, 'shared/anticheat/validators/snakeBlocks.js');
const GOLDEN = require('./fixtures/snakeBlocksGolden.json');

function rulesBlock(src) {
  const a = src.indexOf('// ==== RULES BLOCK');
  const b = src.indexOf('// ==== END RULES BLOCK ====');
  if (a < 0 || b < 0) throw new Error('rules block markers not found');
  return src.slice(src.indexOf('\n', a), b);
}

/** Replay a client trace through the validator, recording the run after every step. */
function serverReplay(seed, trace, opts = {}) {
  const st = V.init({ seed, ...opts });
  const rows = new Map();
  st.onStep = (sim) => rows.set(sim.frames, H.rowOf(sim));
  for (const ev of H.asEvents(trace)) V.processEvent(st, ev);
  const fin = V.finalize(st);
  return { st, fin, rows };
}

/** The first frame and field where the client and the server disagree, or null. */
function firstDiff(clientRows, serverRows) {
  const frames = [...clientRows.keys()].filter((f) => f > 0).sort((a, b) => a - b);
  for (const f of frames) {
    const a = clientRows.get(f);
    const b = serverRows.get(f);
    if (!b) return { frame: f, why: 'server never reached this step' };
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return { frame: f, field: i < H.STATE_FIELDS.length ? H.STATE_FIELDS[i] : 'rowVals', client: a[i], server: b[i] };
    }
  }
  return null;
}

const CORPUS = [];
const STYLE_NAMES = ['flawless', 'good', 'average', 'novice', 'dodger', 'jitter', 'lifter', 'idle', 'hold'];
const cov = { steps: 0, grinds: 0, breaks: 0, picks: 0, chain3: 0, chain6: 0, wallRows: 0, deaths: 0, lifts: 0, multiBatch: 0, fullRows: 0, walls: 0, maxRow: 0, armedSteps: 0 };
beforeAll(() => {
  for (const seed of H.seedsFor(6)) {
    for (const name of STYLE_NAMES) {
      const r = H.autopilot({ seed, style: H.STYLES[name], maxSteps: 60 * 100 });
      const srv = serverReplay(seed, r.trace);
      CORPUS.push({ seed, name, r, srv });
      const evI = H.STATE_FIELDS.indexOf('ev');
      const chI = H.STATE_FIELDS.indexOf('chain');
      const rnI = H.STATE_FIELDS.indexOf('rowN');
      const arI = H.STATE_FIELDS.indexOf('armed');
      for (const row of r.rows.values()) {
        cov.steps++;
        if (row[evI] & 1) cov.grinds++;
        if (row[evI] & 2) cov.breaks++;
        if (row[evI] & 4) cov.picks++;
        if (row[chI] >= 3) cov.chain3++;
        if (row[chI] >= 6) cov.chain6++;
        if (row[arI]) cov.armedSteps++;
        if (row[rnI] > cov.maxRow) cov.maxRow = row[rnI];
      }
      let lastRow = -1;
      for (const [f, row] of [...r.rows.entries()].sort((a, b) => a[0] - b[0])) {
        if (row[rnI] !== lastRow) { lastRow = row[rnI]; if (S.rowSpec(S.seedToInt(seed), row[rnI]).walls) cov.wallRows++; }
      }
      if (r.died) cov.deaths++;
      cov.lifts += r.trace.filter((t) => t.kind === 'lift').length;
      if (r.stats.batches > 1) cov.multiBatch++;
    }
  }
}, 900000);

describe('the two copies of the rules are one', () => {
  const client = fs.readFileSync(H.GAME_PATH, 'utf8');
  const server = fs.readFileSync(VALIDATOR_PATH, 'utf8');

  test('the rules block is identical, word for word, in game.js and the validator', () => {
    expect(rulesBlock(client)).toBe(rulesBlock(server));
    expect(rulesBlock(client).length).toBeGreaterThan(9000);
  });

  test('nothing on the rules path reads a clock, the screen, randomness or an engine transcendental', () => {
    const block = rulesBlock(server);
    for (const bad of ['Math.random', 'Math.sin', 'Math.cos', 'Math.tan', 'Math.atan', 'Math.pow',
      'Math.exp', 'Math.log', 'Math.hypot', 'Math.sqrt', '**', 'Date', 'performance', 'window',
      'document', 'innerWidth', 'devicePixelRatio', 'localStorage']) {
      expect(`${bad}:${block.includes(bad)}`).toBe(`${bad}:false`);
    }
  });

  test('the presentation layer never writes to the simulation', () => {
    const view = client.slice(client.indexOf('// ── effects'));
    const writes = view.match(/\bsim\.[A-Za-z]+\s*(=(?!=)|\+=|-=|\+\+|--)/g) || [];
    expect(writes).toEqual([]);
    // and it never builds a world of its own: the only rows it reads are the game's
    expect(view).not.toMatch(/\bsim\s*=\s*(?!initSim)/);
  });

  test('the bridge answers the same version the rules speak', () => {
    const html = fs.readFileSync(path.join(H.ROOT, 'games/snake-blocks/index.html'), 'utf8');
    expect(html).toMatch(/Number\(want\) >= 2 \? 2 : 1/);
    expect(S.RULES_VERSION).toBe(2);
    const m = client.match(/__kjGameStart\(performance\.now\(\), (\d+)\)/);
    expect(Number(m && m[1])).toBe(S.RULES_VERSION);
  });

  test('every rules constant is pinned by value (a change here is a trace version bump)', () => {
    expect({
      U: S.U, FIELD_W: S.FIELD_W, FIELD_H: S.FIELD_H, COLS: S.COLS, COL_W: S.COL_W, LANE_X: S.LANE_X,
      HEAD_Y: S.HEAD_Y, HEAD_R: S.HEAD_R, X_MIN: S.X_MIN, X_MAX: S.X_MAX, START_X: S.START_X,
      HEAD_MAX_STEP: S.HEAD_MAX_STEP, ROW_HQ: S.ROW_HQ, BLOCK_HQ: S.BLOCK_HQ, START_LEN: S.START_LEN,
      START_GUARD_STEPS: S.START_GUARD_STEPS, ARM_TIMEOUT_STEPS: S.ARM_TIMEOUT_STEPS, SPEED_BASE: S.SPEED_BASE,
      SPEED_CAP: S.SPEED_CAP, HIT_BASE: S.HIT_BASE, HIT_MIN: S.HIT_MIN, HIT_SPEEDUP: S.HIT_SPEEDUP,
      CHAIN_MAX: S.CHAIN_MAX, CHAIN_GAP: S.CHAIN_GAP, RULES_VERSION: S.RULES_VERSION, MIN_REPLAY_VERSION: S.MIN_REPLAY_VERSION,
      PATH_BATCH_MAX: S.PATH_BATCH_MAX,
    }).toEqual({
      U: 16, FIELD_W: 414, FIELD_H: 736, COLS: 5, COL_W: 80, LANE_X: 7, HEAD_Y: 556, HEAD_R: 15, X_MIN: 22, X_MAX: 392,
      START_X: 207, HEAD_MAX_STEP: 13, ROW_HQ: 2816, BLOCK_HQ: 1024, START_LEN: 4, START_GUARD_STEPS: 27,
      ARM_TIMEOUT_STEPS: 1800, SPEED_BASE: 54, SPEED_CAP: 128, HIT_BASE: 3, HIT_MIN: 1, HIT_SPEEDUP: 150,
      CHAIN_MAX: 8, CHAIN_GAP: 2, RULES_VERSION: 2, MIN_REPLAY_VERSION: 2, PATH_BATCH_MAX: 120,
    });
    // the economy that bleeds every run, by value
    expect([0, 35, 36, 119, 120, 399, 400, 2000].map(S.valFor)).toEqual([2, 13, 14, 25, 26, 41, 42, 71]);
    expect([0, 49, 50, 149, 150, 299, 300, 479, 480, 699, 700, 959, 960, 1220, 5000].map(S.taxFor))
      .toEqual([3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 10, 24]);
    expect([0, 59, 60, 219, 220, 479, 480].map(S.pickChanceFor)).toEqual([62, 62, 56, 56, 49, 49, 42]);
    expect([0, 149, 150, 299, 300, 9999].map(S.hitSteps)).toEqual([3, 3, 2, 2, 1, 1]);
  });

  test('the course is pinned: a digest of 600 rows on three seeds never moves', () => {
    const h = crypto.createHash('sha256');
    for (const seed of H.seedsFor(3)) {
      for (let n = 0; n < 600; n++) {
        const sp = S.rowSpec(S.seedToInt(seed), n);
        h.update(JSON.stringify([n, sp.full, sp.mask, sp.vals, sp.pick, sp.walls, sp.anchor, sp.cheap, sp.budget]) + '\n');
      }
    }
    expect(h.digest('hex')).toBe(GOLDEN.course);
  });
});

describe('the course is walkable and a pure function of (seed, row)', () => {
  const seeds = H.seedsFor(8).map(S.seedToInt);

  test('every row leaves its path lane open, and the path never jumps more than two lanes', () => {
    for (const seed of seeds) {
      for (let n = 0; n < 1200; n++) {
        const sp = S.rowSpec(seed, n);
        if (!sp.full) expect(sp.vals[sp.anchor]).toBe(0);
        const a = S.anchorAt(seed, n);
        const b = S.anchorAt(seed, n + 1);
        expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
      }
    }
  });

  test('no divider ever stands between the lane the path left and the lane it is going to', () => {
    for (const seed of seeds) {
      for (let n = 1; n < 1200; n++) {
        const sp = S.rowSpec(seed, n);
        const a = S.anchorAt(seed, n - 1);
        const b = S.anchorAt(seed, n);
        for (let k = Math.min(a, b) + 1; k <= Math.max(a, b); k++) expect(sp.walls & (1 << (k - 1))).toBe(0);
      }
    }
  });

  test('a full row has no gap, its cheap lane is the path lane, and every lane costs more than the pickups put there', () => {
    let fulls = 0;
    for (const seed of seeds) {
      for (let n = 0; n < 1200; n++) {
        const sp = S.rowSpec(seed, n);
        if (!sp.full) continue;
        fulls++;
        expect(sp.vals.every((v) => v > 0)).toBe(true);
        expect(sp.cheapCol).toBe(sp.anchor);
        for (let c = 0; c < 5; c++) if (c !== sp.cheapCol) expect(sp.vals[c]).toBeGreaterThan(sp.cheap);
      }
    }
    expect(fulls).toBeGreaterThan(400);
  });

  test('a row is the same whatever order the rows are asked for in', () => {
    const seed = seeds[0];
    const forward = [];
    for (let n = 0; n < 300; n++) forward.push(JSON.stringify(S.rowSpec(seed, n)));
    for (let n = 299; n >= 0; n--) expect(JSON.stringify(S.rowSpec(seed, n))).toBe(forward[n]);
  });

  test('two different seeds make two different courses', () => {
    const a = JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => S.rowSpec(seeds[0], n)));
    const b = JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => S.rowSpec(seeds[1], n)));
    expect(a).not.toBe(b);
  });
});

describe('the server replays exactly what the screen showed', () => {
  test('every step of every run matches, field for field', () => {
    for (const c of CORPUS) {
      const d = firstDiff(c.r.rows, c.srv.rows);
      expect(`${c.name}@${c.seed.slice(0, 6)} ${JSON.stringify(d)}`).toBe(`${c.name}@${c.seed.slice(0, 6)} null`);
    }
  });

  test('the score, the death step and the cause agree on every run that ended', () => {
    for (const c of CORPUS) {
      expect(`${c.name}: ${c.srv.fin.score}`).toBe(`${c.name}: ${c.r.score}`);
      if (c.r.died) {
        expect(c.srv.fin.debug.deathFrame).toBe(c.r.endFrame);
        expect(c.srv.fin.debug.deathCause).toBe(c.r.cause);
      }
    }
  });

  test('a run never scores before it is armed, and an unarmed run dies of idleness', () => {
    const idle = CORPUS.filter((c) => c.name === 'idle');
    for (const c of idle) {
      expect(c.r.score).toBe(0);
      expect(c.r.cause).toBe('idle');
      expect(c.r.endFrame).toBe(S.ARM_TIMEOUT_STEPS);
    }
  });

  test('nobody parks: a head that touches once and never moves is crushed well inside the idle bound', () => {
    for (const c of CORPUS.filter((x) => x.name === 'hold')) {
      expect(c.r.died).toBe(true);
      expect(c.r.cause).toBe('crushed');
      expect(c.r.endFrame).toBeLessThan(S.ARM_TIMEOUT_STEPS);
    }
  });

  test('the corpus actually reaches what the rules do (so a wrong constant has somewhere to show)', () => {
    expect(cov.steps).toBeGreaterThan(40000);
    expect(cov.grinds).toBeGreaterThan(1500);
    expect(cov.breaks).toBeGreaterThan(80);
    expect(cov.picks).toBeGreaterThan(100);
    expect(cov.chain3).toBeGreaterThan(30);
    expect(cov.wallRows).toBeGreaterThan(20);
    expect(cov.deaths).toBeGreaterThan(40);
    expect(cov.lifts).toBeGreaterThan(20);
    expect(cov.multiBatch).toBeGreaterThan(20);
    expect(cov.maxRow).toBeGreaterThan(40);
    process.stdout.write(`[snake-blocks parity] ${JSON.stringify(cov)}\n`);
  });

  test('the client and the server agree about what was sent: positional, dense, in order', () => {
    for (const c of CORPUS) {
      let down = false;
      let next = null;
      for (const t of c.r.trace) {
        if (t.kind === 'touch') { expect(down).toBe(false); down = true; next = t.step; }
        else if (t.kind === 'lift') { expect(down).toBe(true); expect(t.step).toBe(next); down = false; }
        else {
          expect(down).toBe(true);
          expect(t.x.length).toBeGreaterThan(0);
          expect(t.x.length).toBeLessThanOrEqual(S.PATH_BATCH_MAX);
          expect(t.f).toBe(next - 1);
          next += t.x.length;
          for (const x of t.x) { expect(Number.isInteger(x)).toBe(true); expect(x).toBeGreaterThanOrEqual(S.X_MIN); expect(x).toBeLessThanOrEqual(S.X_MAX); }
        }
      }
    }
  });
});

describe('nothing about the device reaches the run', () => {
  const seed = H.seedsFor(2)[1];

  test('every viewport, from a small phone to a wide desktop, replays to the score it showed', () => {
    for (const viewport of [{ w: 320, h: 568 }, { w: 375, h: 812 }, { w: 414, h: 896 }, { w: 768, h: 1024 }, { w: 1440, h: 780 }]) {
      const r = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50, viewport });
      const srv = serverReplay(seed, r.trace);
      expect(`${viewport.w}x${viewport.h} ${JSON.stringify(firstDiff(r.rows, srv.rows))}`).toBe(`${viewport.w}x${viewport.h} null`);
      expect(srv.fin.score).toBe(r.score);
    }
  });

  test('a 60, 120 and 144 Hz screen play the very same run', () => {
    const base = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50, hz: 60 });
    for (const hz of [120, 144]) {
      const r = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50, hz });
      expect(r.score).toBe(base.score);
      expect(H.schedOf(r.trace)).toBe(H.schedOf(base.trace));
    }
  });

  test('a 30 Hz screen still replays to the score it showed', () => {
    const r = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50, hz: 30 });
    expect(serverReplay(seed, r.trace).fin.score).toBe(r.score);
  });

  test('the clock and Math.random cannot reach a score', () => {
    const base = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50 });
    let a = 1;
    const r1 = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50, random: () => { a = (a * 16807) % 2147483647; return a / 2147483647; }, clockOffset: -123456.5 });
    const r2 = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50, random: () => 0.5, clockOffset: 987654.25 });
    for (const r of [r1, r2]) {
      expect(r.score).toBe(base.score);
      expect(H.schedOf(r.trace)).toBe(H.schedOf(base.trace));
    }
  });

  test('a second finger is ignored, never punished', () => {
    const base = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50 });
    const multi = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50, multi: true });
    expect(multi.stats.multi).toBeGreaterThan(0);
    expect(H.schedOf(multi.trace)).toBe(H.schedOf(base.trace));
    expect(multi.score).toBe(base.score);
  });

  test('the player is a clone of the same game on any seed that is not theirs: a different seed is a different run', () => {
    const other = H.autopilot({ seed: H.seedsFor(2)[0], style: H.STYLES.good, maxSteps: 60 * 50 });
    const mine = H.autopilot({ seed, style: H.STYLES.good, maxSteps: 60 * 50 });
    expect(H.schedOf(other.trace)).not.toBe(H.schedOf(mine.trace));
  });
});

describe('the rules themselves are pinned by recorded runs', () => {
  test('six recorded runs replay to the recorded scores, death steps and step-by-step digests', () => {
    for (const g of GOLDEN.runs) {
      const r = H.autopilot({ seed: g.seed, style: H.STYLES[g.style], maxSteps: 60 * 100 });
      const h = crypto.createHash('sha256');
      const fr = [...r.rows.keys()].sort((a, b) => a - b);
      for (const f of fr) h.update(`${f}:${r.rows.get(f).join('|')}\n`);
      expect(`${g.style} ${r.score} ${r.endFrame} ${r.cause} ${fr.length}`).toBe(`${g.style} ${g.score} ${g.endFrame} ${g.cause} ${g.steps}`);
      expect(h.digest('hex')).toBe(g.digest);
      expect(serverReplay(g.seed, r.trace).fin.score).toBe(g.score);
    }
  });

  test('a scoring table, by hand: a ball is a point, a break pays its face value times the chain', () => {
    // one block of 3 in the lane under the head, a chain of 1: 3 balls (3 points) plus 3 x 1
    const sim = S.initSim('00000000ab12cd34ef56');
    sim.armed = true;
    sim.len = 20;
    sim.rowN = 0;
    sim.rowVals = [0, 0, 3, 0, 0];
    sim.specs.set(0, { n: 0, full: false, vals: [0, 0, 3, 0, 0], mask: 4, pick: null, walls: 0, anchor: 0 });
    sim.hx = S.colMid(2);
    sim.scroll = 0 - S.HEAD_R * S.U * 0;
    let guard = 0;
    while (sim.score < 6 && guard++ < 4000) S.stepSim(sim, true, sim.hx);
    expect(sim.score).toBe(6);
    expect(sim.chain).toBe(1);
  });
});
