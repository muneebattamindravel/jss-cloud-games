'use strict';

/**
 * Rang Bharo validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * The game: a ball sits in a maze of floor tiles and walls. A swipe sends it
 * sliding until a wall stops it, painting every tile it rolls over. Paint every
 * floor tile and the maze is cleared; the next one arrives CLEAR_PAUSE steps
 * later. A newly painted tile is 1 point, a clear pays MAZE_BASE x its number,
 * and clearing within par (the BFS shortest solution) adds PERFECT_BASE +
 * PERFECT_PER x its number. The run is TIME_STEPS (3 minutes) long.
 *
 * What the server does with a trace:
 *   1. rebuilds maze n from the session seed as a pure function of (seed, n);
 *   2. applies each move { n, dir, step } before step `step + 1` runs, exactly
 *      as the client does (a move the rules refuse is refused here too);
 *   3. runs the same fixed steps to the end of the clock and adds up the score.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block is carried WORD FOR WORD in games/rang-bharo/js/game.js.
 * shared/tests/rangBharoParity.test.js fails the moment one copy changes
 * without the other. A gameplay change is a trace version bump, never an edit
 * in place.
 */

  // ==== RANG BHARO RULES BEGIN ====
  // Everything that decides the score lives in this block. Integer only, fixed
  // 1/60 s steps, mazes are a pure function of (seed, n). No engine trig.
  const RULES_VERSION = 1;
  const STEP_HZ = 60;
  const TIME_STEPS = 10800;          // 3 minutes
  const STEPS_PER_TILE = 4;          // the ball crosses one tile in 4 steps
  const CLEAR_PAUSE = 54;            // steps between a clear and the next maze
  const MAZE_BASE = 10;              // a clear pays MAZE_BASE x its number
  const PERFECT_BASE = 25;           // PERFECT pays PERFECT_BASE + PERFECT_PER x n
  const PERFECT_PER = 5;
  const MAX_W = 11;
  const MAX_H = 13;
  const GEN_ATTEMPTS = 120;
  const SOLVE_CAP = 60000;           // BFS state cap; past it par is the designed length
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];

  function seedToInt(seed) {
    if (typeof seed === 'number') return seed | 0;
    const s = String(seed);
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); }
    return h | 0;
  }

  function hash3(a, b, c) {
    let h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x7F4A7C15, 0x85EBCA77) ^ Math.imul((c | 0) + 0x1B873593, 0xC2B2AE3D)) | 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D);
    h ^= h >>> 12; h = Math.imul(h, 0x297A2D39);
    h ^= h >>> 15;
    return h >>> 0;
  }

  function mazeDims(n) {
    return { w: Math.min(MAX_W, 4 + ((n - 1) >> 1)), h: Math.min(MAX_H, 4 + (n >> 1)) };
  }

  // The curve: tiny boards first (4x4, cleared in seconds), one row or column
  // more each maze up to 11x13 at maze 17, and past that the routes keep
  // getting longer and more bent (more moves, shorter slides, a higher par).
  function floorPercent(n) { return Math.min(62, 48 + n); }
  function moveBudget(n) { return Math.min(40, 3 + n + (n >> 1)); }
  function greed(n) { return n < 4 ? 2 : (n < 16 ? 1 : 0); }
  function twist(n) { return n < 20 ? 0 : Math.min(2, (n - 16) >> 2); }
  function minPar(n) { return n < 4 ? 2 : Math.min(20, 2 + (n >> 1) + (n >> 2)); }

  // The slide the ball makes from cell c in direction d: the cell it stops on.
  function slideEnd(cells, w, h, c, d) {
    let x = c % w, y = (c / w) | 0;
    for (;;) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || cells[ny * w + nx] === 0) break;
      x = nx; y = ny;
    }
    return y * w + x;
  }

  // True when no move can strand the ball: every stop the ball can reach from
  // the start can get back to it, so every tile stays reachable whatever the
  // player does. A maze that fails this could lock a run, and is never used.
  function trapFree(cells, w, h, start) {
    const N = w * h, seen = new Uint8Array(N), list = [start];
    seen[start] = 1;
    for (let i = 0; i < list.length; i++) {
      for (let d = 0; d < 4; d++) { const e = slideEnd(cells, w, h, list[i], d); if (!seen[e]) { seen[e] = 1; list.push(e); } }
    }
    const back = new Uint8Array(N), q = [start];
    back[start] = 1;
    for (let i = 0; i < q.length; i++) {
      for (let j = 0; j < list.length; j++) {
        const c = list[j];
        if (back[c]) continue;
        for (let d = 0; d < 4; d++) if (slideEnd(cells, w, h, c, d) === q[i]) { back[c] = 1; q.push(c); break; }
      }
    }
    return q.length === list.length;
  }

  // Shortest solution by BFS over (cell, painted set). Returns the move count,
  // or -1 if the state cap is hit first.
  function solvePar(cells, w, h, start, floors) {
    const N = w * h, W = (N + 31) >> 5;
    const dest = new Int32Array(N * 4);
    for (let c = 0; c < N; c++) {
      for (let d = 0; d < 4; d++) dest[c * 4 + d] = cells[c] ? slideEnd(cells, w, h, c, d) : c;
    }
    const sMask = new Int32Array(W);
    sMask[start >> 5] |= 1 << (start & 31);
    const seen = new Set();
    let frontier = [{ c: start, m: sMask }];
    seen.add(start + ':' + sMask.join(','));
    let depth = 0, states = 1;
    while (frontier.length) {
      depth++;
      const next = [];
      for (let i = 0; i < frontier.length; i++) {
        const st = frontier[i];
        for (let d = 0; d < 4; d++) {
          const e = dest[st.c * 4 + d];
          if (e === st.c) continue;
          const m = st.m.slice();
          let cc = st.c, cnt = 0;
          while (cc !== e) {
            cc += DX[d] + DY[d] * w;
            m[cc >> 5] |= 1 << (cc & 31);
          }
          for (let k = 0; k < W; k++) { let v = m[k] >>> 0; while (v) { v &= v - 1; cnt++; } }
          if (cnt === floors) return depth;
          const key = e + ':' + m.join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          if (++states > SOLVE_CAP) return -1;
          next.push({ c: e, m });
        }
      }
      frontier = next;
    }
    return -1;
  }

  // Maze n of a seed, grown by simulating the sliding ball itself, so every
  // maze is solvable by construction: carve the corridors the ball travels and
  // pin the wall that stops each slide so later carving cannot open it.
  const MAZE_MEMO = new Map();
  function genMaze(seed, n) {
    const sd = seedToInt(seed);
    const mk = sd + ':' + n;
    if (MAZE_MEMO.has(mk)) return MAZE_MEMO.get(mk);
    const made = genMazeRaw(sd, n);
    if (MAZE_MEMO.size > 64) MAZE_MEMO.clear();
    MAZE_MEMO.set(mk, made);
    return made;
  }

  function genMazeRaw(sd, n) {
    const dm = mazeDims(n), w = dm.w, h = dm.h, N = w * h;
    const want = Math.floor(N * floorPercent(n) / 100);
    const greedy = greed(n), bend = twist(n), budget = moveBudget(n);
    for (let attempt = 0; attempt < GEN_ATTEMPTS; attempt++) {
      let rs = hash3(sd, n, attempt) | 0;
      const rnd = function (k) {
        rs = (rs + 0x6D2B79F5) | 0;
        let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) % k;
      };
      const cells = new Uint8Array(N), pin = new Uint8Array(N);
      const start = rnd(N);
      cells[start] = 1;
      let pos = start, count = 1, moves = 0, stuck = 0;
      const path = [];
      while (count < want && moves < budget && stuck < 14) {
        const cands = [];
        const x = pos % w, y = (pos / w) | 0;
        const d0 = rnd(4);
        for (let q = 0; q < 4; q++) {
          const d = (d0 + q) & 3;
          let cx = x, cy = y;
          for (let L = 1; ; L++) {
            cx += DX[d]; cy += DY[d];
            if (cx < 0 || cy < 0 || cx >= w || cy >= h || pin[cy * w + cx]) break;
            const bx = cx + DX[d], by = cy + DY[d];
            const open = bx >= 0 && by >= 0 && bx < w && by < h && cells[by * w + bx] === 1;
            if (open) continue;
            let fresh = 0;
            for (let k = 1; k <= L; k++) { if (cells[(y + DY[d] * k) * w + x + DX[d] * k] === 0) fresh++; }
            cands.push({ d, L, fresh });
          }
        }
        let pool = [];
        for (let i = 0; i < cands.length; i++) if (cands[i].fresh > 0) pool.push(cands[i]);
        if (!pool.length) { pool = cands; stuck++; }
        if (!pool.length) break;
        let idx = rnd(pool.length);
        for (let b = 0; b < greedy; b++) { const j = rnd(pool.length); if (pool[j].fresh > pool[idx].fresh) idx = j; }
        for (let b = 0; b < bend; b++) { const j = rnd(pool.length); if (pool[j].L < pool[idx].L) idx = j; }
        const mv = pool[idx];
        let cx = x, cy = y;
        for (let k = 1; k <= mv.L; k++) {
          cx += DX[mv.d]; cy += DY[mv.d];
          if (cells[cy * w + cx] === 0) { cells[cy * w + cx] = 1; count++; }
        }
        const bx = cx + DX[mv.d], by = cy + DY[mv.d];
        if (bx >= 0 && by >= 0 && bx < w && by < h) pin[by * w + bx] = 1;
        pos = cy * w + cx;
        path.push(mv.d);
        moves++;
        if (mv.fresh > 0) stuck = 0;
      }
      if (count * 100 < N * 38) continue;
      if (!trapFree(cells, w, h, start)) continue;
      const par = solvePar(cells, w, h, start, count);
      const maze = { w, h, cells, start, floors: count, designed: moves, par: par < 0 ? moves : par, exact: par >= 0, path };
      if (maze.par >= minPar(n)) return maze;
    }
    // No measured seed gets here (0 of 4800 mazes): every maze passes within
    // the attempts. The ring keeps the function total all the same.
    return ringMaze(w, h);
  }

  // The fallback no seed has needed: a corridor round the edge, cleared in 4.
  function ringMaze(w, h) {
    const cells = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) { cells[x] = 1; cells[(h - 1) * w + x] = 1; }
    for (let y = 0; y < h; y++) { cells[y * w] = 1; cells[y * w + w - 1] = 1; }
    const floors = 2 * w + 2 * h - 4;
    return { w, h, cells, start: 0, floors, designed: 4, par: 4, exact: true, path: [1, 2, 3, 0] };
  }

  // The world a run starts from. `version` is the trace's rules version; v1 is
  // the only one so far.
  function initSim(seed, version) {
    const s = {
      v: version | 0, seed: seedToInt(seed), step: 0, over: false, inputs: 0,
      score: 0, n: 0, moves: 0, mazes: 0, perfects: 0, tiles: 0, totalMoves: 0,
      maze: null, painted: null, left: 0,
      bx: 0, by: 0, dir: -1, sub: 0, queued: -1, pause: 0, lastInput: -1,
      ev: [],
    };
    loadMaze(s, 1);
    return s;
  }

  function loadMaze(s, n) {
    const m = genMaze(s.seed, n);
    s.n = n; s.maze = m;
    s.painted = new Uint8Array(m.w * m.h);
    s.painted[m.start] = 1;
    s.left = m.floors - 1;
    s.bx = m.start % m.w; s.by = (m.start / m.w) | 0;
    s.dir = -1; s.sub = 0; s.moves = 0; s.pause = 0;
    s.ev = s.ev.concat([{ k: 'maze', n }]);
  }

  function blockedAt(s, x, y, d) {
    const m = s.maze, nx = x + DX[d], ny = y + DY[d];
    return nx < 0 || ny < 0 || nx >= m.w || ny >= m.h || m.cells[ny * m.w + nx] === 0;
  }

  // One swipe or key. At most one input is taken per step; later ones that
  // step change nothing. A swipe mid-slide replaces the buffered one.
  function inputDir(s, d) {
    if (s.over || d < 0 || d > 3 || (d | 0) !== d) return false;
    if (s.lastInput === s.step) return false;
    s.lastInput = s.step;
    s.inputs++;
    if (s.dir >= 0 || s.pause > 0) { s.queued = d; return true; }
    tryStart(s, d);
    return true;
  }

  function tryStart(s, d) {
    if (blockedAt(s, s.bx, s.by, d)) { s.ev = s.ev.concat([{ k: 'bump', d }]); return false; }
    s.dir = d; s.sub = 0; s.moves++; s.totalMoves++;
    s.ev = s.ev.concat([{ k: 'go', d }]);
    return true;
  }

  function stepSim(s) {
    s.ev = [];
    if (s.step >= TIME_STEPS) { s.over = true; s.ev = [{ k: 'end' }]; return; }
    s.step++;
    if (s.pause > 0) {
      s.pause--;
      if (s.pause === 0) {
        loadMaze(s, s.n + 1);
        if (s.queued >= 0) { const q = s.queued; s.queued = -1; tryStart(s, q); }
      }
      return;
    }
    // A buffered swipe is always taken at the wall or at the next maze, so a
    // ball at rest never has one waiting.
    if (s.dir < 0) return;
    s.sub++;
    if (s.sub < STEPS_PER_TILE) return;
    s.sub = 0;
    const m = s.maze;
    s.bx += DX[s.dir]; s.by += DY[s.dir];
    const c = s.by * m.w + s.bx;
    if (s.painted[c] === 0) {
      s.painted[c] = 1; s.left--; s.score++; s.tiles++;
      s.ev = s.ev.concat([{ k: 'paint', c }]);
    }
    if (s.left === 0) {
      const perfect = s.moves <= m.par;
      const bonus = MAZE_BASE * s.n + (perfect ? PERFECT_BASE + PERFECT_PER * s.n : 0);
      s.score += bonus; s.mazes++;
      if (perfect) s.perfects++;
      s.dir = -1; s.pause = CLEAR_PAUSE;
      s.ev = s.ev.concat([{ k: 'clear', bonus, perfect, moves: s.moves, par: m.par }]);
      return;
    }
    if (blockedAt(s, s.bx, s.by, s.dir)) {
      const d = s.dir;
      s.dir = -1;
      s.ev = s.ev.concat([{ k: 'hit', d }]);
      if (s.queued >= 0) { const q = s.queued; s.queued = -1; tryStart(s, q); }
    }
  }
  // ==== RANG BHARO RULES END ====

// ── the module interface ────────────────────────────────────────────────
const FPS = STEP_HZ;
const MAX_SIM_STEPS = 60 * 60 * 60;          // one hour of steps, the session ceiling
const MAX_INPUTS = TIME_STEPS + 100;         // at most one input a step, over the 3 minutes

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, over: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: newStats(),
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. A planner reads a maze at once and plays it at par
// with an even rhythm; a hand reads, hesitates, slips and recovers.
function newStats() {
  return {
    steps: [], waits: [], buffered: 0, reads: [], overPar: [], perfect: 0, cleared: 0,
    restAt: 0, mazeAt: 0, firstMove: true, lastN: 1,
  };
}
// Called after every step: notes when the ball comes to rest and when a maze
// begins, so the next input's thinking time can be measured.
function noteStep(state) {
  const sim = state.sim, st = state.stats;
  for (const e of sim.ev) {
    if (e.k === 'hit' || e.k === 'bump') st.restAt = sim.step;
    else if (e.k === 'maze') { st.mazeAt = sim.step; st.restAt = sim.step; st.firstMove = true; }
    else if (e.k === 'clear') { st.cleared++; if (e.perfect) st.perfect++; st.overPar.push(e.moves - e.par); }
  }
}
function noteInput(state, wasMoving) {
  const sim = state.sim, st = state.stats;
  st.steps.push(sim.step);
  if (wasMoving) st.buffered++;
  else if (st.firstMove) st.reads.push(sim.step - st.mazeAt);
  else st.waits.push(sim.step - st.restAt);
  st.firstMove = false;
}
function stepOnce(state) {
  stepSim(state.sim);
  noteStep(state);
}
function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.over && sim.step < step && sim.step < MAX_SIM_STEPS) stepOnce(state);
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }
function cv(xs) { const m = mean(xs), s = sd(xs); return m > 0 && s !== null ? s / m : null; }
function gaps(steps) { const g = []; for (let i = 1; i < steps.length; i++) g.push(steps[i] - steps[i - 1]); return g; }

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function processEvent(state, event) {
  if (state.over) return { accepted: false, newScore: state.score, reason: 'over' };
  if (!event || typeof event !== 'object' || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= 1 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, Math.min(RULES_VERSION, Number(payload.v) | 0));
      noteStep(state);
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'move') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, dir, step } = payload;
  // The direction is checked by the rules themselves (inputDir).
  if (!isStep(n) || !isStep(step)) return reject(state, 'bad_move');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would re-run a window and keep the
  // best outcome.
  if (step < sim.step) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.over) {
    state.over = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'over' };
  }
  if (sim.step !== step) return reject(state, 'beyond_cap');
  // The move names its index among accepted moves; any other is out of order.
  if (n !== sim.inputs) return reject(state, 'out_of_order');
  const wasMoving = sim.dir >= 0 || sim.pause > 0;
  if (!inputDir(sim, dir)) return reject(state, 'refused');
  noteInput(state, wasMoving);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always ends inside this bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const sim = state.sim;
  // Run the world out past the last input: a slide finishes, the clock runs
  // to zero. A run left alone ends at TIME_STEPS.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * FPS));
  const capSteps = elapsedCap(state, FPS);
  let guard = 0;
  while (!sim.over && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {
    stepOnce(state);
    guard++;
  }
  const st = state.stats;
  const g = gaps(st.steps);
  return {
    score: sim.score,
    gameOver: sim.over,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', v: sim.v, steps: sim.step, over: sim.over, score: sim.score,
      maze: sim.n, mazes: sim.mazes, perfects: sim.perfects, tiles: sim.tiles, moves: sim.totalMoves,
      inputs: state.inputCount, accepted: st.steps.length, rejects: state.rejectCount,
      // thinking time from the ball at rest to the next swipe, in steps
      waitMean: round3(mean(st.waits)), waitSd: round3(sd(st.waits)), waitCv: round3(cv(st.waits)),
      waitMin: st.waits.length ? Math.min(...st.waits) : null,
      // first look at each maze before the first swipe
      readMean: round3(mean(st.reads)), readCv: round3(cv(st.reads)),
      // swipes sent while the ball was still rolling (planned ahead)
      bufferedShare: st.steps.length ? round3(st.buffered / st.steps.length) : null,
      // moves over par per cleared maze, and the PERFECT share
      overParMean: round3(mean(st.overPar)), perfectShare: st.cleared ? round3(st.perfect / st.cleared) : null,
      gapCv: round3(cv(g)), gapMin: g.length ? Math.min(...g) : null,
    },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  // Pinned to the session lifetime by shared/tests/sessionLifetime.test.js.
  _limits: { MAX_SIM_STEPS, FPS },
  RULES_VERSION,
  init, processEvent, finalize, simulate,
  _sim: {
    RULES_VERSION, STEP_HZ, TIME_STEPS, STEPS_PER_TILE, CLEAR_PAUSE, MAZE_BASE, PERFECT_BASE, PERFECT_PER,
    MAX_W, MAX_H, GEN_ATTEMPTS, SOLVE_CAP, DX, DY, MAX_INPUTS, MAX_SIM_STEPS,
    seedToInt, hash3, mazeDims, floorPercent, moveBudget, greed, twist, minPar, slideEnd, solvePar, trapFree, ringMaze, genMaze, genMazeRaw,
    initSim, loadMaze, blockedAt, inputDir, tryStart, stepSim, MAZE_MEMO,
  },
};
