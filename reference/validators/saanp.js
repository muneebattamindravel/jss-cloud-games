'use strict';
// Saanp: server-side deterministic REPLAY (Oct 2026, migration 253).
//
// A 15x21 grid snake. The rules block below is carried WORD FOR WORD in
// games/saanp/js/rules.js and pinned by sha256 in shared/tests/saanpParity.test.js.
//
// Trace v2: { kind: 'start', v: 2 } then one { kind: 'turn', n, dir, step } per
// turn the client accepted: n is its index, dir 0 up / 1 right / 2 down / 3 left,
// step the fixed step it was made on. The server runs the world up to that step,
// applies the turn through the same rules and computes the score itself. A turn
// the rules refuse changes nothing; refusals never zero a run. After the last
// turn the world runs out to the death, bounded by the session's real length.

  // ==== SAANP RULES BEGIN (word for word in games/saanp/js/rules.js and shared/anticheat/validators/saanp.js) ====
  // Integers only. No clock, no screen, no Math.random. The world advances in
  // fixed 1/60 s steps; the snake moves one cell when a step reaches nextMove.
  // A turn is queued on the step it was made on and applied at the next move.
  var COLS = 15;
  var ROWS = 21;
  var CELLS = 315;
  var RULES_VERSION = 2;
  var START_GUARD = 45;          // steps before the first move
  var TICK_START = 10;           // steps per move at level 1
  var TICK_MIN = 4;              // the fastest the snake ever moves
  var EATS_PER_LEVEL = 8;
  var GOLD_EVERY = 5;            // a gold orb after every 5th orb eaten
  var GOLD_STEPS = 360;          // and it lasts 6 seconds
  var GOLD_POINTS = 5;
  var BONUS_EVERY = 10;          // a row of 3 bonus orbs after every 10th orb
  var BONUS_STEPS = 480;
  var BLOCK_FROM = 3;            // wall blocks from level 3
  var BLOCKS_PER_LEVEL = 2;
  var BLOCK_MAX = 24;
  var PORTAL_FROM = 5;           // a pair of portals from level 5
  var PORTAL_APART = 10;         // manhattan distance between the two portals
  var QUEUE_MAX = 2;
  var ZONE_NEAR = 2;             // nothing new appears this close to the head
  var ZONE_AHEAD = 6;            // or this far along its heading
  var MAX_SIM_STEPS = 216000;    // the session hour
  var MAX_TURNS = 30000;         // a work bound
  var START_LEN = 4;
  var DX = [0, 1, 0, -1];
  var DY = [-1, 0, 1, 0];
  function hash32(a, b, c) {
    var h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul(b | 0, 0x85EBCA6B) ^ Math.imul(c | 0, 0xC2B2AE35)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846CA68B) >>> 0; h ^= h >>> 16;
    return h >>> 0;
  }
  function seedToInt(seedHex) {
    return (typeof seedHex === 'string' && /^[0-9a-fA-F]{8}/.test(seedHex)) ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
  }
  function cx(c) { return c % COLS; }
  function cy(c) { return (c - (c % COLS)) / COLS; }
  function cheb(a, b) { return Math.max(Math.abs(cx(a) - cx(b)), Math.abs(cy(a) - cy(b))); }
  function manh(a, b) { return Math.abs(cx(a) - cx(b)) + Math.abs(cy(a) - cy(b)); }
  function inner(c) { var x = cx(c), y = cy(c); return x >= 2 && x <= COLS - 3 && y >= 2 && y <= ROWS - 3; }
  function tickFor(level) { return Math.max(TICK_MIN, TICK_START - (level - 1)); }
  // Every cell something already stands on.
  function occupancy(sim) {
    var occ = [], i;
    for (i = 0; i < CELLS; i++) occ.push(0);
    for (i = 0; i < sim.snake.length; i++) occ[sim.snake[i]] = 1;
    for (i = 0; i < sim.blocks.length; i++) occ[sim.blocks[i]] = 2;
    for (i = 0; i < sim.portals.length; i++) occ[sim.portals[i]] = 3;
    for (i = 0; i < sim.bonus.length; i++) occ[sim.bonus[i]] = 4;
    if (sim.food >= 0) occ[sim.food] = 4;
    if (sim.gold >= 0) occ[sim.gold] = 4;
    return occ;
  }
  // Cells close to the head, or along the line it is heading (now or queued).
  function inHeadZone(sim, c) {
    var h = sim.snake[0];
    if (cheb(h, c) <= ZONE_NEAR) return true;
    var dirs = [sim.dir].concat(sim.queue), d, k, x, y;
    for (d = 0; d < dirs.length; d++) {
      x = cx(h); y = cy(h);
      for (k = 0; k < ZONE_AHEAD; k++) {
        x += DX[dirs[d]]; y += DY[dirs[d]];
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
        if (y * COLS + x === c) return true;
      }
    }
    return false;
  }
  function freeList(sim) {
    var occ = occupancy(sim), out = [], i;
    for (i = 0; i < CELLS; i++) if (!occ[i]) out.push(i);
    return out;
  }
  // Orb K is the (hash mod free)-th free cell in row-major order: one draw per K.
  function placeFood(sim) {
    var free = freeList(sim);
    sim.food = free.length ? free[hash32(sim.seed, sim.foodK, 1) % free.length] : -1;
    sim.foodK = sim.foodK + 1;
  }
  function placeGold(sim) {
    var free = freeList(sim);
    if (free.length) {
      sim.gold = free[hash32(sim.seed, 500000 + sim.goldK, 1) % free.length];
      sim.goldUntil = sim.frames + GOLD_STEPS;
    }
    sim.goldK = sim.goldK + 1;
  }
  // Three free cells in a row, away from the head.
  function placeBonus(sim) {
    var occ = occupancy(sim), starts = [], i;
    for (i = 0; i < CELLS; i++) {
      if (cx(i) > COLS - 3) continue;
      if (occ[i] || occ[i + 1] || occ[i + 2]) continue;
      if (inHeadZone(sim, i) || inHeadZone(sim, i + 1) || inHeadZone(sim, i + 2)) continue;
      starts.push(i);
    }
    if (starts.length) {
      var s = starts[hash32(sim.seed, 400000 + sim.bonusK, 1) % starts.length];
      sim.bonus = [s, s + 1, s + 2];
      sim.bonusUntil = sim.frames + BONUS_STEPS;
    }
    sim.bonusK = sim.bonusK + 1;
  }
  // An obstacle (block or portal) may stand only on an inner cell that is free,
  // outside the head zone, and at least 2 cells (king's move) from every other
  // obstacle. So every obstacle keeps a free ring of 8 cells around it, which
  // keeps the free board in one piece and gives every free cell 2 or more free
  // neighbours: no orb can ever be walled off, and no dead-end pocket exists.
  function obstacleOk(sim, occ, c) {
    if (!inner(c) || occ[c] || inHeadZone(sim, c)) return false;
    var i;
    for (i = 0; i < sim.blocks.length; i++) if (cheb(sim.blocks[i], c) < 2) return false;
    for (i = 0; i < sim.portals.length; i++) if (cheb(sim.portals[i], c) < 2) return false;
    return true;
  }
  function addBlock(sim, j) {
    var occ = occupancy(sim), cand = [], i;
    for (i = 0; i < CELLS; i++) if (obstacleOk(sim, occ, i)) cand.push(i);
    if (!cand.length) return -1;
    var c = cand[hash32(sim.seed, 200000 + sim.level * 64 + j, 1) % cand.length];
    sim.blocks = sim.blocks.concat([c]);
    return c;
  }
  function addPortals(sim) {
    var occ = occupancy(sim), cand = [], i;
    for (i = 0; i < CELLS; i++) if (obstacleOk(sim, occ, i)) cand.push(i);
    if (!cand.length) return;
    var a = cand[hash32(sim.seed, 300000, 1) % cand.length];
    var far = [];
    for (i = 0; i < cand.length; i++) if (manh(cand[i], a) >= PORTAL_APART) far.push(cand[i]);
    if (!far.length) return;
    var b = far[hash32(sim.seed, 300000, 2) % far.length];
    sim.portals = [a, b];
  }
  function initSim(seedInt) {
    var x = (COLS - 1) / 2, y = ROWS - 7, snake = [], i;
    for (i = 0; i < START_LEN; i++) snake.push((y + i) * COLS + x);
    var sim = {
      seed: seedInt >>> 0, frames: 0, snake: snake, dir: 0, queue: [], nextMove: START_GUARD,
      tick: TICK_START, level: 1, eats: 0, score: 0, grow: 0,
      food: -1, foodK: 0, gold: -1, goldUntil: 0, goldK: 0, bonus: [], bonusUntil: 0, bonusK: 0,
      blocks: [], portals: [], turns: 0, lastTurn: 0, moves: 0,
      dead: false, cause: '', events: []
    };
    placeFood(sim);
    return sim;
  }
  function levelUp(sim, ev) {
    var lv = 1 + Math.floor(sim.eats / EATS_PER_LEVEL), j, c;
    if (lv <= sim.level) return;
    sim.level = lv;
    sim.tick = tickFor(lv);
    ev.push({ k: 'level', level: lv });
    if (lv >= BLOCK_FROM) {
      for (j = 0; j < BLOCKS_PER_LEVEL && sim.blocks.length < BLOCK_MAX; j++) {
        c = addBlock(sim, j);
        if (c >= 0) ev.push({ k: 'block', c: c });
      }
    }
    if (lv === PORTAL_FROM && !sim.portals.length) {
      addPortals(sim);
      if (sim.portals.length) ev.push({ k: 'portals' });
    }
  }
  function die(sim, cause, ev) {
    sim.dead = true;
    sim.cause = cause;
    ev.push({ k: 'die', cause: cause });
  }
  // One fixed step. Fills sim.events with what happened (a new array each step).
  function stepSim(sim) {
    var ev = [];
    sim.events = ev;
    if (sim.dead) return;
    sim.frames = sim.frames + 1;
    if (sim.gold >= 0 && sim.frames >= sim.goldUntil) { sim.gold = -1; ev.push({ k: 'goldgone' }); }
    if (sim.bonus.length && sim.frames >= sim.bonusUntil) { sim.bonus = []; ev.push({ k: 'bonusgone' }); }
    if (sim.frames < sim.nextMove) return;
    sim.nextMove = sim.frames + sim.tick;
    var dir = sim.dir, q = sim.queue;
    if (q.length) { dir = q[0]; q = q.slice(1); }
    sim.dir = dir;
    sim.queue = q;
    var head = sim.snake[0], nx = cx(head) + DX[dir], ny = cy(head) + DY[dir];
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) { die(sim, 'wall', ev); return; }
    var nc = ny * COLS + nx, warped = false;
    if (sim.portals.length === 2) {
      if (nc === sim.portals[0]) { nc = sim.portals[1]; warped = true; }
      else if (nc === sim.portals[1]) { nc = sim.portals[0]; warped = true; }
    }
    if (sim.blocks.indexOf(nc) >= 0) { die(sim, 'block', ev); return; }
    var eatFood = nc === sim.food, eatGold = nc === sim.gold, bi = sim.bonus.indexOf(nc);
    var grow = sim.grow + (eatFood ? 1 : 0) + (eatGold ? 1 : 0) + (bi >= 0 ? 1 : 0);
    var tailStays = grow > 0;
    var bodyEnd = tailStays ? sim.snake.length : sim.snake.length - 1, i;
    for (i = 0; i < bodyEnd; i++) if (sim.snake[i] === nc) { die(sim, 'self', ev); return; }
    sim.snake = [nc].concat(tailStays ? sim.snake : sim.snake.slice(0, sim.snake.length - 1));
    sim.grow = tailStays ? grow - 1 : 0;
    sim.moves = sim.moves + 1;
    ev.push({ k: 'move', warped: warped });
    if (eatGold) { sim.score = sim.score + GOLD_POINTS; sim.gold = -1; ev.push({ k: 'gold', c: nc }); }
    if (bi >= 0) {
      sim.score = sim.score + 1;
      sim.bonus = sim.bonus.slice(0, bi).concat(sim.bonus.slice(bi + 1));
      ev.push({ k: 'bonus', c: nc });
    }
    if (eatFood) {
      sim.score = sim.score + 1;
      sim.eats = sim.eats + 1;
      sim.food = -1;
      ev.push({ k: 'eat', c: nc });
      levelUp(sim, ev);
      placeFood(sim);
      if (sim.eats % GOLD_EVERY === 0 && sim.gold < 0) placeGold(sim);
      if (sim.eats % BONUS_EVERY === 0 && !sim.bonus.length) placeBonus(sim);
    }
  }
  // A turn, made on step `step` (the world has run exactly `step` steps). It
  // is queued and applied at the next move. A refusal changes nothing.
  function turnSim(sim, dir, step) {
    if (sim.dead) return 'dead';
    if (dir !== 0 && dir !== 1 && dir !== 2 && dir !== 3) return 'bad_dir';
    if (step !== sim.frames || step < sim.lastTurn) return 'frame_regressed';
    if (sim.turns >= MAX_TURNS) return 'turn_cap';
    if (sim.queue.length >= QUEUE_MAX) return 'queue_full';
    var last = sim.queue.length ? sim.queue[sim.queue.length - 1] : sim.dir;
    if (dir === last) return 'same';
    if ((dir + 2) % 4 === last) return 'reverse';
    sim.queue = sim.queue.concat([dir]);
    sim.turns = sim.turns + 1;
    sim.lastTurn = step;
    return 'ok';
  }
  // ==== SAANP RULES END ====

const MAX_INPUTS = MAX_TURNS + 200;

function isInt(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0,
    maxDurationSecs: Number(maxDurationSecs) || 3600, elapsedSecs: Number(elapsedSecs) || 0,
    // humanness raw material (recorded, never gated)
    pending: [], lags: [], turnSteps: [], foodFrom: -1, foodPath: 0, effs: [],
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function manhattan(a, b) { return Math.abs(cx(a) - cx(b)) + Math.abs(cy(a) - cy(b)); }

// One step, with the fingerprint bookkeeping. Reads the sim, never writes it.
function stepOne(state) {
  const sim = state.sim;
  const qBefore = sim.queue.length;
  if (state.foodFrom < 0 && sim.food >= 0) { state.foodFrom = manhattan(sim.snake[0], sim.food); state.foodPath = 0; }
  stepSim(sim);
  for (const e of sim.events) {
    if (e.k !== 'move') continue;
    if (qBefore > 0 && state.pending.length) state.lags.push(sim.frames - state.pending.shift());
    state.foodPath++;
  }
  for (const e of sim.events) {
    if (e.k === 'eat') {
      if (state.foodPath > 0 && state.foodFrom > 0) state.effs.push(state.foodFrom / state.foodPath);
      state.foodFrom = -1;
    }
  }
}

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepOne(state);
}

function processEvent(state, event) {
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};
  if (p.kind === 'start') {
    if (p.v === RULES_VERSION && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(seedToInt(state.seed));
    }
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim' || p.kind !== 'turn') return { accepted: true, newScore: state.score };
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  const { n, dir, step } = p;
  if (!isInt(n) || !isInt(dir) || dir > 3 || !isInt(step) || step > MAX_SIM_STEPS) return reject(state, 'bad_turn');
  const sim = state.sim;
  if (sim.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (n !== sim.turns) return reject(state, 'out_of_order');
  if (step < sim.frames) return reject(state, 'frame_regressed');
  advanceTo(state, step);
  if (sim.dead) { state.score = sim.score; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  const r = turnSim(sim, dir, step);
  if (r !== 'ok') return reject(state, r);
  state.pending.push(step);
  state.turnSteps.push(step);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function r3(v) { return v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function sd(a) { const m = mean(a); return a.length ? Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length) : null; }
function gapCv(steps) {
  const g = [];
  for (let i = 1; i < steps.length; i++) g.push(steps[i] - steps[i - 1]);
  const m = mean(g);
  return m ? sd(g) / m : null;
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim;
  // Run the world out past the last turn. A snake that stops turning hits a
  // wall within one row or column, so this is short for any real run.
  const runOut = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const cap = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOut && sim.frames < cap && sim.frames < MAX_SIM_STEPS) { stepOne(state); guard++; }
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.frames, score: sim.score, dead: sim.dead, cause: sim.cause,
      level: sim.level, eats: sim.eats, length: sim.snake.length, turns: sim.turns,
      inputs: state.inputCount, rejects: state.rejectCount,
      turnLagMean: r3(mean(state.lags)), turnLagSd: r3(sd(state.lags)),
      pathEffMean: r3(mean(state.effs)), pathEffSd: r3(sd(state.effs)),
      gapCv: r3(gapCv(state.turnSteps)),
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
  _limits: { MAX_SIM_STEPS, FPS: 60 },
  init, processEvent, finalize, simulate,
  _sim: {
    COLS, ROWS, CELLS, RULES_VERSION, START_GUARD, TICK_START, TICK_MIN, EATS_PER_LEVEL, QUEUE_MAX,
    MAX_SIM_STEPS, MAX_TURNS, MAX_INPUTS, hash32, seedToInt, cx, cy, tickFor, initSim, stepSim, turnSim, freeList,
  },
};
