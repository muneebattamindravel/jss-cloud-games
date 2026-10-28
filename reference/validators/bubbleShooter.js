'use strict';

/**
 * Bubble Shooter validator: SERVER-SIDE DETERMINISTIC REPLAY.
 *
 * The score is never taken from the client. The server builds the same grid
 * from the session seed, flies each recorded shot through its own copy of the
 * board with integer arithmetic, snaps it to a cell, pops and drops what the
 * board says pops and drops, pushes rows on the same cadence and on the same
 * idle rule, and computes the points itself.
 *
 * What a client can assert is exactly two things: WHERE it aimed (an integer
 * direction vector scaled to 1e4) and WHEN (the shot index and the game step
 * it was fired on). An impossible shot, out of order, before the last bubble
 * landed, or with a vector that is not a unit direction pointing up the
 * field, is REFUSED rather than scored, and a refusal never zeroes the run.
 *
 * WHY THIS GAME IS EASY TO REPLAY. It is turn based: nothing on the board moves
 * between shots except the idle rule, and that is counted in whole game steps
 * carried on each event, so the trace is the whole clock. The flight is
 * integer stepped, wall bounces are sign flips, snapping is integer distance
 * comparison: + - * / floor and comparisons only, no trigonometry and no
 * engine transcendental anywhere on the path (see replay-game-checklist).
 *
 * THE CORE FUNCTIONS BELOW ARE A TRANSCRIPTION of games/bubble-shooter/js/game.js
 * and must stay textually identical to it: mix, baseColour, colourAt,
 * rowOffset, neighbours, hasNeighbour, pushRow, isDead, rowCadence,
 * queueColour, tracePath, findAttach, landBubble, launch, settle, applyIdle.
 * shared/tests/bubbleShooterParity.test.js pulls every shared constant and
 * every one of those function bodies out of BOTH files and requires a match,
 * then flies the real game and compares the whole grid after every shot.
 */

// ── design space and grid, verbatim from the game ────────────────────────
const DESIGN_W = 414;
const DESIGN_H = 736;
const COLS = 11;
const ROWS = 14;
const COLOURS = 6;
const R = 18;
const D = 36;
const ROW_H = 31;
const FIELD_L = 9;
const CEIL_Y = 102;
const DEATH_ROW = 12;
const INIT_ROWS = 6;
const LAUNCH_X = 207;
const LAUNCH_Y = 650;

// ── the shot ─────────────────────────────────────────────────────────────
// A direction is two integers scaled to 1e4. Its squared length must sit
// within rounding distance of 1e8 (each component rounds by at most 0.5, which
// moves the square by at most ~14,142), and it must point up the field by at
// least MIN_UP, or the flight could creep along a wall for thousands of steps.
const QUANT = 10000;
const MIN_UP = 1700;
const VEC_MIN2 = 99980000;
const VEC_MAX2 = 100020000;
const SUB_PX = 2;
const SUB_PER_STEP = 7;
const MAX_SUB = 4000;
const COLLIDE = 32;

// ── scoring ──────────────────────────────────────────────────────────────
const POP_MIN = 3;
const POP_POINTS = 10;
const DROP_POINTS = 20;
const STREAK_CAP = 4;

// ── rows and time ────────────────────────────────────────────────────────
const ROW_CADENCE_START = 8;
const ROW_CADENCE_FLOOR = 4;
const ROW_CADENCE_SCORE_STEP = 1000;
const STEP_FPS = 60;
const IDLE_STEPS = 720;

// ── the colour field ─────────────────────────────────────────────────────
const COPY_LEFT_PCT = 35;
const COPY_BELOW_PCT = 55;
const HASH_A = 0x9E3779B1;
const HASH_B = 0x85EBCA6B;
const HASH_C = 0xC2B2AE35;
const HASH_D = 0x27D4EB2F;
const HASH_E = 0x165667B1;
const HASH_F = 0x2C1B3C6D;

// A step cap on the replay, pinned to the session lifetime by
// shared/tests/sessionLifetime.test.js. A session lives one hour; this is a
// little past it so no honest run is ever refused by it. A shot stamped past
// it is refused, never the run.
const MAX_SIM_STEPS = STEP_FPS * 3900;

// WORK bound, not a scoring one: refuses further events rather than zeroing.
// A shot takes at least a few steps of flight plus a human aim, so an hour is
// a few thousand shots at most; this sits an order of magnitude past that.
const MAX_EVENTS = 60000;

const DEFAULTS = { maxEvents: MAX_EVENTS };

// ── shared core (textually identical to game.js) ─────────────────────────

function mix(sim, a, b, c) {
  let h = (sim.seedA ^ Math.imul(a + 1, HASH_A)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), HASH_B);
  h = (h ^ Math.imul(b + 7, HASH_C)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), HASH_D);
  h = (h ^ sim.seedB ^ Math.imul(c, HASH_E)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, HASH_F);
  h ^= h >>> 12;
  return h >>> 0;
}

function baseColour(sim, gen, col) {
  return (mix(sim, gen, col, 1) % COLOURS) + 1;
}

function colourAt(sim, gen, col) {
  const roll = mix(sim, gen, col, 2) % 100;
  if (col > 0 && roll < COPY_LEFT_PCT) return colourAt(sim, gen, col - 1);
  if (gen > 0 && roll < COPY_BELOW_PCT) return baseColour(sim, gen - 1, col);
  return baseColour(sim, gen, col);
}

function rowOffset(sim, r) {
  return (sim.topGen - r) & 1;
}

function neighbours(sim, r, c) {
  const out = [];
  const off = rowOffset(sim, r);
  const add = (rr, cc) => {
    if (rr < 0 || rr > ROWS - 1) return;
    const n = rowOffset(sim, rr) ? COLS - 1 : COLS;
    if (cc < 0 || cc > n - 1) return;
    out.push(rr * COLS + cc);
  };
  add(r, c - 1);
  add(r, c + 1);
  const a = off ? c : c - 1;
  const b = off ? c + 1 : c;
  add(r - 1, a);
  add(r - 1, b);
  add(r + 1, a);
  add(r + 1, b);
  return out;
}

function hasNeighbour(sim, r, c) {
  const nbs = neighbours(sim, r, c);
  for (let k = 0; k < nbs.length; k++) if (sim.cells[nbs[k]]) return true;
  return false;
}

function pushRow(sim) {
  const cells = sim.cells;
  for (let i = cells.length - 1; i >= COLS; i--) cells[i] = cells[i - COLS];
  sim.topGen += 1;
  const n = rowOffset(sim, 0) ? COLS - 1 : COLS;
  for (let c = 0; c < COLS; c++) cells[c] = c < n ? colourAt(sim, sim.topGen, c) : 0;
  sim.pushes += 1;
}

function isDead(sim) {
  for (let i = DEATH_ROW * COLS; i < ROWS * COLS; i++) if (sim.cells[i]) return true;
  return false;
}

function rowCadence(score) {
  const n = ROW_CADENCE_START - Math.floor(score / ROW_CADENCE_SCORE_STEP);
  return n < ROW_CADENCE_FLOOR ? ROW_CADENCE_FLOOR : n;
}

function queueColour(sim, k) {
  let mask = 0;
  for (let i = 0; i < ROWS * COLS; i++) if (sim.cells[i]) mask |= 1 << sim.cells[i];
  const list = [];
  for (let col = 1; col <= COLOURS; col++) if (mask & (1 << col)) list.push(col);
  const h = mix(sim, k, 0, 3);
  if (!list.length) return (h % COLOURS) + 1;
  return list[h % list.length];
}

function tracePath(sim, dx, dy, pts) {
  const XMIN = (FIELD_L + R) * QUANT;
  const XMAX = (FIELD_L + COLS * D - R) * QUANT;
  const TOP = CEIL_Y * QUANT;
  const RH = ROW_H * QUANT;
  const C2 = COLLIDE * QUANT * COLLIDE * QUANT;
  let x = LAUNCH_X * QUANT;
  let y = LAUNCH_Y * QUANT;
  let vx = dx * SUB_PX;
  const vy = dy * SUB_PX;
  for (let sub = 1; sub <= MAX_SUB; sub++) {
    x += vx;
    y += vy;
    if (x < XMIN) {
      x = 2 * XMIN - x;
      vx = -vx;
      if (pts) pts.push(x, y);
    } else if (x > XMAX) {
      x = 2 * XMAX - x;
      vx = -vx;
      if (pts) pts.push(x, y);
    }
    if (y <= TOP) return { x, y: TOP, sub };
    let rLo = Math.floor((y - TOP - COLLIDE * QUANT) / RH);
    let rHi = Math.floor((y - TOP + COLLIDE * QUANT) / RH) + 1;
    if (rLo < 0) rLo = 0;
    if (rHi > ROWS - 1) rHi = ROWS - 1;
    for (let r = rLo; r <= rHi; r++) {
      const off = rowOffset(sim, r);
      const n = off ? COLS - 1 : COLS;
      const ddy = y - (CEIL_Y + r * ROW_H) * QUANT;
      for (let c = 0; c < n; c++) {
        if (!sim.cells[r * COLS + c]) continue;
        const ddx = x - (FIELD_L + R + c * D + (off ? R : 0)) * QUANT;
        if (ddx * ddx + ddy * ddy < C2) return { x, y, sub };
      }
    }
  }
  return { x, y, sub: MAX_SUB };
}

function findAttach(sim, x, y) {
  const RH = ROW_H * QUANT;
  let rNear = Math.floor((y - CEIL_Y * QUANT + RH / 2) / RH);
  if (rNear < 0) rNear = 0;
  if (rNear > ROWS - 1) rNear = ROWS - 1;
  let best = -1;
  let bestD = 0;
  for (let pass = 0; pass < 2 && best < 0; pass++) {
    const lo = pass ? 0 : (rNear > 0 ? rNear - 1 : 0);
    const hi = pass ? ROWS - 1 : (rNear < ROWS - 1 ? rNear + 1 : ROWS - 1);
    for (let r = lo; r <= hi; r++) {
      const off = rowOffset(sim, r);
      const n = off ? COLS - 1 : COLS;
      const dyy = y - (CEIL_Y + r * ROW_H) * QUANT;
      for (let c = 0; c < n; c++) {
        const i = r * COLS + c;
        if (sim.cells[i]) continue;
        if (r > 0 && !hasNeighbour(sim, r, c)) continue;
        const dxx = x - (FIELD_L + R + c * D + (off ? R : 0)) * QUANT;
        const d2 = dxx * dxx + dyy * dyy;
        if (best < 0 || d2 < bestD) {
          best = i;
          bestD = d2;
        }
      }
    }
  }
  return best;
}

function landBubble(sim, idx, colour) {
  const cells = sim.cells;
  cells[idx] = colour;
  const seen = new Uint8Array(ROWS * COLS);
  const group = [idx];
  seen[idx] = 1;
  for (let k = 0; k < group.length; k++) {
    const g = group[k];
    const nbs = neighbours(sim, Math.floor(g / COLS), g % COLS);
    for (let j = 0; j < nbs.length; j++) {
      const nb = nbs[j];
      if (!seen[nb] && cells[nb] === colour) {
        seen[nb] = 1;
        group.push(nb);
      }
    }
  }
  const popList = [];
  const dropList = [];
  if (group.length >= POP_MIN) {
    for (let k = 0; k < group.length; k++) {
      popList.push(group[k], cells[group[k]]);
      cells[group[k]] = 0;
    }
    const anchored = new Uint8Array(ROWS * COLS);
    const stack = [];
    for (let c = 0; c < COLS; c++) {
      if (cells[c]) {
        anchored[c] = 1;
        stack.push(c);
      }
    }
    while (stack.length) {
      const g = stack.pop();
      const nbs = neighbours(sim, Math.floor(g / COLS), g % COLS);
      for (let j = 0; j < nbs.length; j++) {
        const nb = nbs[j];
        if (cells[nb] && !anchored[nb]) {
          anchored[nb] = 1;
          stack.push(nb);
        }
      }
    }
    for (let i = COLS; i < ROWS * COLS; i++) {
      if (cells[i] && !anchored[i]) {
        dropList.push(i, cells[i]);
        cells[i] = 0;
      }
    }
  }
  const popped = popList.length / 2;
  const dropped = dropList.length / 2;
  sim.streak = popped > 0 ? sim.streak + 1 : 0;
  const mult = sim.streak < STREAK_CAP ? sim.streak : STREAK_CAP;
  const gained = (popped * POP_POINTS + dropped * DROP_POINTS) * mult;
  sim.score += gained;
  sim.sinceRow += 1;
  let empty = true;
  for (let i = 0; i < ROWS * COLS; i++) {
    if (cells[i]) {
      empty = false;
      break;
    }
  }
  let pushed = 0;
  if (empty || sim.sinceRow >= rowCadence(sim.score)) {
    pushRow(sim);
    sim.sinceRow = 0;
    pushed = 1;
  }
  if (isDead(sim)) sim.dead = true;
  return { popped, dropped, gained, mult, pushed, popList, dropList };
}

function launch(sim, dx, dy, step, pts) {
  const path = tracePath(sim, dx, dy, pts);
  const idx = findAttach(sim, path.x, path.y);
  const colour = sim.cur;
  sim.cur = sim.nxt;
  sim.shots += 1;
  sim.idleAnchor = step;
  sim.landStep = step + Math.floor((path.sub + SUB_PER_STEP - 1) / SUB_PER_STEP);
  return { idx, colour, path };
}

function settle(sim, shot) {
  const res = shot.idx >= 0 ? landBubble(sim, shot.idx, shot.colour) : null;
  sim.nxt = queueColour(sim, sim.qIndex);
  sim.qIndex += 1;
  return res;
}

function applyIdle(sim, step) {
  let n = 0;
  while (!sim.dead && step >= sim.idleAnchor + IDLE_STEPS) {
    sim.idleAnchor += IDLE_STEPS;
    pushRow(sim);
    n += 1;
    if (isDead(sim)) sim.dead = true;
  }
  return n;
}

// ── validator-only ───────────────────────────────────────────────────────

function validSeed(seed) {
  return typeof seed === 'string' && /^[0-9a-fA-F]{16,}$/.test(seed);
}

function initSim(seed) {
  if (!validSeed(seed)) return null;
  const sim = {
    seedA: parseInt(seed.slice(0, 8), 16) >>> 0,
    seedB: parseInt(seed.slice(8, 16), 16) >>> 0,
    cells: new Uint8Array(ROWS * COLS),
    topGen: INIT_ROWS - 1,
    score: 0,
    streak: 0,
    shots: 0,
    sinceRow: 0,
    cur: 0,
    nxt: 0,
    qIndex: 2,
    idleAnchor: 0,
    landStep: 0,
    lastStep: 0,
    dead: false,
    pushes: 0,
    swaps: 0,
  };
  for (let r = 0; r < INIT_ROWS; r++) {
    const gen = sim.topGen - r;
    const n = rowOffset(sim, r) ? COLS - 1 : COLS;
    for (let c = 0; c < n; c++) sim.cells[r * COLS + c] = colourAt(sim, gen, c);
  }
  sim.cur = queueColour(sim, 0);
  sim.nxt = queueColour(sim, 1);
  return sim;
}

function validVector(dx, dy) {
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) return false;
  if (dx < -QUANT || dx > QUANT || dy > -MIN_UP || dy < -QUANT) return false;
  const m2 = dx * dx + dy * dy;
  return m2 >= VEC_MIN2 && m2 <= VEC_MAX2;
}

// The replay's run-out is bounded by how long the session REALLY lasted. Only
// the submit replay passes elapsedSecs; the live stream keeps the step cap.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function init({ seed, maxDurationSecs, elapsedSecs, tunables } = {}) {
  return {
    mode: 'none',
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs,
    tunables: { ...DEFAULTS, ...(tunables || {}) },
    events: 0,
    rejectCount: 0,
    score: 0,
  };
}

function reject(state, reason) {
  // A refused shot still happened on the client, so the boards have diverged
  // and a later pop is no longer known to follow a pop. Carrying the streak
  // across that gap would credit a bigger multiplier than the game gave.
  // Breaking it can only lower the score, the safe direction.
  if (state.sim) state.sim.streak = 0;
  state.rejectCount++;
  return { accepted: false, newScore: state.score, reason };
}

function processEvent(state, event) {
  if (!event || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};

  if (p.kind === 'start') {
    if (Number(p.v) >= 2 && !state.sim) {
      const sim = initSim(state.seed);
      if (sim) { state.sim = sim; state.mode = 'sim'; }
    }
    return { accepted: true, newScore: state.score };
  }
  if (p.kind !== 'shot' && p.kind !== 'swap') return { accepted: true, newScore: state.score };

  const sim = state.sim;
  if (!sim) return reject(state, 'no_replay');
  if (state.events >= state.tunables.maxEvents) return reject(state, 'event_cap');
  state.events += 1;

  // typeof FIRST: Number(null) is 0, so a coerced field would silently apply.
  const n = p.n;
  const step = p.step;
  if (typeof n !== 'number' || typeof step !== 'number') return reject(state, 'malformed');
  if (!Number.isInteger(n) || !Number.isInteger(step)) return reject(state, 'malformed');
  if (n !== sim.shots) return reject(state, 'out_of_order');
  if (step < sim.lastStep || step < sim.landStep) return reject(state, 'step_order');
  if (step > MAX_SIM_STEPS) return reject(state, 'step_cap');

  if (p.kind === 'shot') {
    if (!validVector(p.dx, p.dy)) return reject(state, 'bad_vector');
    applyIdle(sim, step);
    if (sim.dead) return reject(state, 'dead');
    sim.lastStep = step;
    settle(sim, launch(sim, p.dx, p.dy, step, null));
  } else {
    applyIdle(sim, step);
    if (sim.dead) return reject(state, 'dead');
    sim.lastStep = step;
    const t = sim.cur;
    sim.cur = sim.nxt;
    sim.nxt = t;
    sim.swaps += 1;
  }
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

function finalize(state) {
  const sim = state.sim;
  if (!sim) {
    return {
      score: 0, gameOver: false, unscorable: true, suspicious: null,
      debug: { mode: 'none', rejects: state.rejectCount },
    };
  }
  // Run-out: a parked run keeps pushing rows until it dies. Pushes never
  // score, so this can only settle gameOver; it is still bounded by the
  // session's real length.
  const cap = elapsedCap(state, STEP_FPS);
  const until = cap < MAX_SIM_STEPS ? cap : MAX_SIM_STEPS;
  if (!sim.dead && until >= sim.lastStep) applyIdle(sim, until);
  return {
    score: sim.score,
    gameOver: sim.dead,
    suspicious: state.rejectCount >= 5 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', score: sim.score, shots: sim.shots, swaps: sim.swaps, pushes: sim.pushes,
      streak: sim.streak, dead: sim.dead, lastStep: sim.lastStep, rejects: state.rejectCount,
    },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  init, processEvent, finalize, simulate, DEFAULTS,
  _limits: { MAX_SIM_STEPS, FPS: STEP_FPS },
  _sim: {
    initSim, launch, settle, applyIdle, tracePath, findAttach, landBubble, pushRow, isDead,
    queueColour, colourAt, rowCadence, rowOffset, neighbours, validVector, elapsedCap,
    DESIGN_W, DESIGN_H, COLS, ROWS, COLOURS, R, D, ROW_H, FIELD_L, CEIL_Y, DEATH_ROW, INIT_ROWS,
    LAUNCH_X, LAUNCH_Y, QUANT, MIN_UP, VEC_MIN2, VEC_MAX2, SUB_PX, SUB_PER_STEP, MAX_SUB, COLLIDE,
    POP_MIN, POP_POINTS, DROP_POINTS, STREAK_CAP, ROW_CADENCE_START, ROW_CADENCE_FLOOR,
    ROW_CADENCE_SCORE_STEP, STEP_FPS, IDLE_STEPS, MAX_SIM_STEPS, MAX_EVENTS,
  },
};
