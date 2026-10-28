'use strict';

/**
 * Patli Gali validator: server-side deterministic REPLAY (v2).
 *
 * A ball rolls along an isometric path of tiles that only ever goes +x or +y;
 * a tap turns it 90 degrees (+1 point); a gem on a tile is +2; leaving the
 * path ends the run. On the replay path the SCORE IS COMPUTED: the trace
 * carries the player's turns against the fixed 60 Hz step each one was
 * applied on, the server lays the same path and gems from the session seed,
 * rolls the same ball and counts what it earns before it runs off the edge.
 *
 * What had to change in the game for this to be possible (10 Sep 2026):
 *   - the path and the gems were Math.random; tile N's corner and gem are now
 *     a pure function of (seed, N), two draws in a fixed order on every tile;
 *   - the physics step was 1/120 s on desktop and 1/60 s on iOS, so the same
 *     taps rolled a different ball on a different phone; it is 1/60 s
 *     everywhere now, with the run's own frame counter;
 *   - the launch ramp used Math.pow, which differs by an ulp between engines;
 *     it is a plain cube now, so there is NO transcendental on this path and
 *     dmath is not needed;
 *   - the turn is recorded with the step it was applied on, and the guided
 *     tutorial code (which froze the ball inside a live run) is gone.
 *
 * Every constant below is copied from games/patli-gali/js/game.js and must
 * stay byte-identical to it: patliGaliParity.test.js pulls them out of both
 * files and compares.
 *
 * A trace with no v2 start marker takes the pre-replay bounds path (mode
 * 'v1'); the session layer refuses those unconditionally now, so it exists
 * only so an old trace decodes for review.
 */

// ── constants (mirror game.js) ────────────────────────────────────────────
const FIXED_DT = 1 / 60;
const TILE_KEEP_DISTANCE = 8;
const TILE_TARGET_COUNT = 58;
const GEM_SCORE = 2;
const START_SPEED = 2.4;
const SPEED_RAMP = 0.040;
const LAUNCH_RAMP = 1.1;
const LAUNCH_START_FACTOR = 0.45;
const SUBSTEP_MOVE = 0.16;
const TURN_CHANCE = 0.45;
const GEM_CHANCE = 0.34;
const FIRST_TURN_TILE = 5;      // corners only after tile 5
const FIRST_GEM_TILE = 7;       // gems only after tile 7
const START_TILE = 4;           // the ball starts on tile 4, facing tile 5
const TILE_HIT = 0.52;
const GEM_HIT_SQ = 0.1764;
const TILE_FALL_GRAVITY = 900;
const TILE_FADE_SPEED = 1.8;
const MIN_TURN_GAP_FRAMES = 3;

const MAX_SIM_FRAMES = 60 * 60 * 60;   // the session lifetime, pinned by sessionLifetime.test.js
const MAX_INPUTS = 20000;

// ── seed ──────────────────────────────────────────────────────────────────
function seedToInt(seedHex) {
  return (typeof seedHex === 'string' && seedHex.length >= 8)
    ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
}
// tileRng() in game.js: keep byte-identical.
function tileRng(seedInt, index) {
  let a = (seedInt + Math.imul(index + 1, 0x9E3779B1)) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t2 = a;
    t2 = Math.imul(t2 ^ (t2 >>> 15), t2 | 1);
    t2 ^= t2 + Math.imul(t2 ^ (t2 >>> 7), t2 | 61);
    return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
  };
}
// Tile N's two decisions, in this order: does the path turn AFTER this tile,
// and does this tile carry a gem. Mirrors tileDecisions() in game.js.
function tileDecisions(seedInt, index) {
  const r = tileRng(seedInt, index);
  const turnRoll = r();
  const gemRoll = r();
  return {
    turn: index > FIRST_TURN_TILE && turnRoll < TURN_CHANCE,
    gem: index > FIRST_GEM_TILE && gemRoll < GEM_CHANCE,
  };
}

function tileKey(x, y) { return Math.round(x) + ',' + Math.round(y); }

// ── the simulation ────────────────────────────────────────────────────────
function addTile(sim) {
  const i = sim.nextIndex;
  const x = sim.cursorX; const y = sim.cursorY;
  sim.path.push({ x, y, i, falling: false, fallOffset: 0, fallVelocity: 0, alpha: 1 });
  sim.tileKeys.add(tileKey(x, y));
  const d = tileDecisions(sim.seedInt, i);
  if (d.gem) sim.gems.push({ x, y, taken: false });
  if (d.turn) sim.pathDir = sim.pathDir.x === 1 ? { x: 0, y: 1 } : { x: 1, y: 0 };
  sim.cursorX += sim.pathDir.x; sim.cursorY += sim.pathDir.y;
  sim.nextIndex = i + 1;
}
function activeTileCount(sim) {
  let n = 0;
  for (let i = 0; i < sim.path.length; i++) if (!sim.path[i].falling) n++;
  return n;
}
function extendPath(sim) {
  while (activeTileCount(sim) < TILE_TARGET_COUNT) addTile(sim);
}
function tileAt(sim, x, y) {
  const rx = Math.round(x); const ry = Math.round(y);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const tx = rx + ox; const ty = ry + oy;
      if (sim.tileKeys.has(tileKey(tx, ty)) && Math.abs(tx - x) < TILE_HIT && Math.abs(ty - y) < TILE_HIT) {
        return true;
      }
    }
  }
  return false;
}
function collectGems(sim) {
  for (const g of sim.gems) {
    const dx = sim.x - g.x; const dy = sim.y - g.y;
    if (!g.taken && dx * dx + dy * dy < GEM_HIT_SQ) {
      g.taken = true;
      sim.totalGems++;
      sim.score += GEM_SCORE;
    }
  }
}
function updateFallingTiles(sim, dt) {
  for (let i = 0; i < sim.path.length; i++) {
    const t = sim.path[i];
    if (!t.falling) continue;
    t.fallVelocity += TILE_FALL_GRAVITY * dt;
    t.fallOffset += t.fallVelocity * dt;
    t.alpha = Math.max(0, t.alpha - TILE_FADE_SPEED * dt);
  }
}
function compactTiles(sim) {
  const minTrack = sim.x + sim.y - TILE_KEEP_DISTANCE;
  let write = 0;
  sim.tileKeys.clear();
  for (let read = 0; read < sim.path.length; read++) {
    const t = sim.path[read];
    if (!t.falling && t.x + t.y <= minTrack) { t.falling = true; t.fallOffset = 0; t.fallVelocity = 120; t.alpha = 1; }
    if (t.falling && t.alpha <= 0) continue;
    if (!t.falling) sim.tileKeys.add(tileKey(t.x, t.y));
    if (t.falling || t.x + t.y > minTrack) sim.path[write++] = t;
  }
  sim.path.length = write;
}
function compactGems(sim) {
  const minTrack = sim.x + sim.y - TILE_KEEP_DISTANCE;
  let write = 0;
  for (let read = 0; read < sim.gems.length; read++) {
    const g = sim.gems[read];
    if (g.x + g.y > minTrack && !g.taken) sim.gems[write++] = g;
  }
  sim.gems.length = write;
}

function initSim(seed) {
  const sim = {
    seedInt: seedToInt(seed),
    frames: 0, score: 0, totalGems: 0, turns: 0,
    dead: false, deathFrame: null,
    x: 0, y: 0, dir: { x: 1, y: 0 },
    speed: START_SPEED, launchT: 0,
    path: [], gems: [], tileKeys: new Set(),
    cursorX: 0, cursorY: 0, pathDir: { x: 1, y: 0 }, nextIndex: 0,
    turnRequested: false, lastTurnFrame: -1000,
  };
  for (let i = 0; i < TILE_TARGET_COUNT; i++) addTile(sim);
  const start = sim.path[START_TILE]; const next = sim.path[START_TILE + 1];
  sim.x = start.x; sim.y = start.y;
  sim.dir = { x: next.x - start.x, y: next.y - start.y };
  return sim;
}
function applyRequestedTurn(sim) {
  if (!sim.turnRequested) return;
  sim.turnRequested = false;
  // Inside the gap the turn is dropped, never queued (mirrors game.js): a
  // queued one made a quick double tap two turns, +2 for a harmless wiggle.
  if (sim.frames - sim.lastTurnFrame < MIN_TURN_GAP_FRAMES) return;
  sim.lastTurnFrame = sim.frames;
  sim.dir = sim.dir.x !== 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
  sim.score += 1;
  sim.turns++;
}
// One fixed step. Mirrors the "playing" branch of update() in game.js.
function stepSim(sim) {
  if (sim.dead) return;
  const dt = FIXED_DT;
  sim.frames++;
  applyRequestedTurn(sim);

  sim.launchT = Math.min(LAUNCH_RAMP, sim.launchT + dt);
  const lp = sim.launchT / LAUNCH_RAMP;
  const inv = 1 - lp;
  const launchFactor = LAUNCH_START_FACTOR + (1 - LAUNCH_START_FACTOR) * (1 - inv * inv * inv);
  const effSpeed = sim.speed * launchFactor;
  const stepCount = Math.max(1, Math.ceil((effSpeed * dt) / SUBSTEP_MOVE));
  const stepDt = dt / stepCount;
  for (let i = 0; i < stepCount; i++) {
    const move = effSpeed * stepDt;
    sim.x += sim.dir.x * move;
    sim.y += sim.dir.y * move;
    collectGems(sim);
    if (!tileAt(sim, sim.x, sim.y)) { sim.dead = true; sim.deathFrame = sim.frames; return; }
  }
  sim.speed += dt * SPEED_RAMP;
  updateFallingTiles(sim, dt);
  compactTiles(sim);
  compactGems(sim);
  extendPath(sim);
}
// A turn applied on step `frame`: the client sets turnRequested on the tap
// and applies it at the START of the next step, which is the frame it emits.
function turnSim(sim, frame) {
  if (sim.dead) return;
  advanceTo(sim, frame - 1);
  if (sim.dead) return;
  sim.turnRequested = true;      // a second request on the same frame is one turn
}
function advanceTo(sim, frame) {
  let guard = 0;
  while (!sim.dead && sim.frames < frame && guard < MAX_SIM_FRAMES) { stepSim(sim); guard++; }
}

// ── the legacy bounds path (pre-replay), kept only so an old trace decodes ──
const MIN_TURN_INTERVAL_MS = 90;
const MAX_TURNS_PER_SEC = 8;
const RATE_WINDOW_MS = 1000;
const HARD_TURN_CAP = 5000;
const MAX_SCORE_DELTA_PER_EVENT = 2;
const HUD_DROP_TOLERANCE = 10;

function initLegacy({ seed, maxDurationSecs } = {}) {
  return {
    score: 0, turns: 0, lastTurnT: null, rateWindow: [], rejectCount: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 600, seed: seed || null,
    lastScoreAfter: 0, maxScoreAfter: 0,
  };
}
function processLegacyEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  const payload = event.payload || {};
  const scoreAfterRaw = Number(payload.scoreAfter);
  if (Number.isFinite(scoreAfterRaw) && scoreAfterRaw >= 0) {
    const delta = scoreAfterRaw - state.lastScoreAfter;
    if (delta >= 0 && delta <= MAX_SCORE_DELTA_PER_EVENT) {
      state.lastScoreAfter = scoreAfterRaw;
      if (scoreAfterRaw > state.maxScoreAfter) state.maxScoreAfter = scoreAfterRaw;
    }
  }
  if (payload.kind === 'gem') {
    const tHint = Number(payload.tHint);
    if (!Number.isFinite(tHint) || tHint < 0) { state.rejectCount++; return { accepted: false, newScore: state.score, reason: 'bad_thint' }; }
    state.score += 2; state.gems = (state.gems || 0) + 1;
    return { accepted: true, newScore: state.score };
  }
  if (payload.kind !== 'turn') return { accepted: true, newScore: state.score };
  const tHint = Number(payload.tHint);
  if (!Number.isFinite(tHint) || tHint < 0) { state.rejectCount++; return { accepted: false, newScore: state.score, reason: 'bad_thint' }; }
  if (state.lastTurnT !== null && tHint <= state.lastTurnT) { state.rejectCount++; return { accepted: false, newScore: state.score, reason: 'non_monotonic' }; }
  if (state.lastTurnT !== null && (tHint - state.lastTurnT) < MIN_TURN_INTERVAL_MS) { state.rejectCount++; state.lastTurnT = tHint; return { accepted: false, newScore: state.score, reason: 'too_fast' }; }
  if (state.turns >= HARD_TURN_CAP) { state.dead = true; return { accepted: false, newScore: state.score, reason: 'hard_cap' }; }
  state.rateWindow = state.rateWindow.filter((t) => tHint - t < RATE_WINDOW_MS);
  if (state.rateWindow.length >= MAX_TURNS_PER_SEC) { state.rejectCount++; return { accepted: false, newScore: state.score, reason: 'rate_cap' }; }
  state.rateWindow.push(tHint);
  if (tHint / 1000 > state.maxDurationSecs + 5) { state.dead = true; return { accepted: false, newScore: state.score, reason: 'over_time' }; }
  state.score += 1; state.turns += 1; state.lastTurnT = tHint;
  return { accepted: true, newScore: state.score };
}
function finalizeLegacy(state) {
  const accumulated = state.score;
  const hudCeiling = state.turns * MAX_SCORE_DELTA_PER_EVENT + HUD_DROP_TOLERANCE;
  const hudSnapshot = Math.min(state.maxScoreAfter || 0, hudCeiling);
  const finalScore = Math.max(accumulated, hudSnapshot);
  return {
    score: finalScore, gameOver: state.dead,
    suspicious: state.rejectCount >= 5 ? `validator_rejects:${state.rejectCount}` : null,
    debug: { accumulated, hudSnapshot, diff: hudSnapshot - accumulated },
  };
}

// ── validator surface ─────────────────────────────────────────────────────
function init(opts = {}) {
  const st = initLegacy(opts);
  st.elapsedSecs = Number(opts.elapsedSecs) || 0;
  st.mode = 'v1';
  st.version = null;
  st.sim = null;
  st.lastFrame = -1;
  st.inputCount = 0;
  st.claimedHud = 0;
  return st;
}

function processEvent(state, event) {
  if (!event || event.type !== 'input') return { accepted: true, newScore: state.score };
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.version = 2;
      state.sim = initSim(state.seed);
    }
    return { accepted: true, newScore: state.score };
  }

  if (state.mode === 'sim') {
    const sim = state.sim;
    if (kind === 'gem') {
      // Forensics only: the HUD value the client showed. Never scored on v2.
      const sa = Number(payload.scoreAfter);
      if (Number.isFinite(sa) && sa > state.claimedHud) state.claimedHud = sa;
      return { accepted: true, newScore: sim.score };
    }
    if (kind !== 'turn') return { accepted: true, newScore: sim.score };
    const sa = Number(payload.scoreAfter);
    if (Number.isFinite(sa) && sa > state.claimedHud) state.claimedHud = sa;
    if (state.inputCount >= MAX_INPUTS) return { accepted: false, newScore: sim.score, reason: 'hard_cap' };
    const frame = payload.frame;
    if (typeof frame !== 'number' || !Number.isFinite(frame) || frame < 1 || Math.floor(frame) !== frame) {
      state.rejectCount++;
      return { accepted: true, newScore: sim.score, reason: 'bad_frame' };
    }
    // A repeated frame is one turn (the client's request flag is a boolean);
    // a rewind is refused: it would let an attacker re-run a window.
    if (frame < state.lastFrame) { state.rejectCount++; return { accepted: true, newScore: sim.score, reason: 'frame_regressed' }; }
    state.lastFrame = frame;
    state.inputCount++;
    turnSim(sim, frame);
    return { accepted: true, newScore: sim.score };
  }

  return processLegacyEvent(state, event);
}


// The replay's run-out is bounded by how long the session REALLY lasted. A
// run cannot hold more steps than real time allowed (the fixed step only ever
// drops time, never adds it), so an honest run always dies inside this bound;
// without it, a run the client ended by a rule the replay does not model spun
// on to the session maximum. Only the submit replay passes elapsedSecs; the
// live stream does not, and keeps the old bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode === 'sim') {
    const sim = state.sim;
    // Run out: without another turn the ball leaves the path at the next
    // corner; the run always ends.
    let guard = 0;
    const capFrames = elapsedCap(state, 60);
    while (!sim.dead && guard < MAX_SIM_FRAMES && sim.frames < capFrames) { stepSim(sim); guard++; }
    return {
      score: sim.score,
      gameOver: sim.dead,
      suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
      debug: {
        mode: 'sim', version: state.version, frames: sim.frames, deathFrame: sim.deathFrame,
        score: sim.score, dead: sim.dead, turns: sim.turns, gems: sim.totalGems,
        inputs: state.inputCount, claimedHud: state.claimedHud,
      },
    };
  }
  const f = finalizeLegacy(state);
  f.unscorable = true;
  f.debug = { ...(f.debug || {}), mode: 'v1' };
  return f;
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  init, processEvent, finalize, simulate,
  _internal: { MIN_TURN_INTERVAL_MS, MAX_TURNS_PER_SEC, RATE_WINDOW_MS },
  // Pinned to the session lifetime by shared/tests/sessionLifetime.test.js.
  _limits: { MAX_SIM_FRAMES, FPS: 60 },
  _sim: {
    initSim, stepSim, turnSim, advanceTo, tileRng, tileDecisions, seedToInt,
    FIXED_DT, TILE_TARGET_COUNT, TURN_CHANCE, GEM_CHANCE, MAX_SIM_FRAMES,
  },
};
