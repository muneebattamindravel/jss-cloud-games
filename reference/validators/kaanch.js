'use strict';

/**
 * Kaanch validator: full server-side deterministic REPLAY (trace v1).
 *
 * Kaanch is the partner's 3D glass-smashing runner. Its rules are
 * deterministic: a fixed 60 Hz step, a section layout drawn from the session
 * seed (mulberry32 per section index), the platform's DMath for every
 * transcendental, and an integer camera-plane aim for every throw. The server
 * re-runs the whole run from the seed and the recorded throws and scores it
 * itself. What the client claims is never read.
 *
 * The rules live in shared/anticheat/kaanch/engine.js: the game's own rule
 * code copied VERBATIM (Timeline, Director, Motion, Aim, DMath glue), plus a
 * headless port of the entities and the step. kaanchParity.test.js runs the
 * REAL bundle beside it and compares every field of the world after every step.
 *
 * The trace (what games/kaanch emits, see its INTEGRATION.md):
 *   { kind: 'start', v: 1, tHint }
 *   { kind: 'taps', n, data }   n (1..64) accepted throws, base64 of 16-byte
 *                               little-endian records: uint32 frame, int16 x,
 *                               int16 y, float64 tHint (metadata only)
 *   { kind: 'end', frame, reason }  the run ended at `frame` (the reason is
 *                               never trusted; the replay decides the score)
 * A throw at frame f is applied BEFORE step f + 1 runs, exactly as the game's
 * step() does. Frames strictly increase (the game records one per step at
 * most). A throw the rules refuse (no balls left) was never recorded by an
 * honest client, so it is a refusal. Refusals never zero a run.
 *
 * NOBODY PARKS: a run that stops throwing meets glass in its path and dies
 * (balls are finite, so even a hoarded supply runs out), and a paused run is
 * ended by the game after a minute (the bridge's pause rule), which arrives
 * here as an end marker. The run-out after the last event is still bounded by
 * the session's real length (elapsedCap).
 */

const Engine = require('../kaanch/engine');

const RULES_VERSION = 1;
const FPS = 60;
const MAX_SIM_STEPS = 60 * 60 * 60;         // one session hour of fixed steps
const MAX_INPUTS = Engine.TRACE_TAP_LIMIT + 64;
const RECORD_BYTES = 16;

// Seeds: what the platform hands the game (64 hex) or a plain uint32.
function seedToUint32(seed) {
  if (Number.isInteger(seed) && seed >= 0 && seed <= 4294967295) return seed;
  if (typeof seed === 'string' && /^[0-9a-f]{64}$/i.test(seed)) return parseInt(seed.slice(0, 8), 16) >>> 0;
  return null;
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v && v <= 4294967295;
}

function decodeTaps(payload) {
  const n = payload.n;
  if (!Number.isInteger(n) || n < 1 || n > 64 || typeof payload.data !== 'string') return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data)) return null;
  const buf = Buffer.from(payload.data, 'base64');
  if (buf.length !== n * RECORD_BYTES) return null;
  const out = [];
  for (let o = 0; o < buf.length; o += RECORD_BYTES) {
    out.push({ f: buf.readUInt32LE(o), x: buf.readInt16LE(o + 4), y: buf.readInt16LE(o + 6), tHint: buf.readDoubleLE(o + 8) });
  }
  return out;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    seed: seed == null ? null : seed,
    inputCount: 0, rejectCount: 0, score: 0, dead: false, ended: false, endFrame: null,
    lastFrame: -1,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { frames: [], ahead: [], off: [], kinds: { glass: 0, gem: 0, door: 0, none: 0 }, hits: 0 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. At each throw: what the aim ray met (glass, crystal,
// door button or nothing), how far ahead it was, and how far from the
// object's centre the ray passed (normalised: 0 is dead centre, 1 the edge).
// A program aims at centres at fixed distances; a thumb scatters.
function noteThrow(state, hit, cam, dir, p) {
  const st = state.stats;
  st.frames.push(state.eng.stepIndex);
  if (!hit) { st.kinds.none++; return; }
  if (hit.group) {
    st.kinds.glass++;
    const inv = hit.inverseMatrix;
    const lx = p.x * inv.elements[0] + p.y * inv.elements[4] + p.z * inv.elements[8] + inv.elements[12];
    const ly = p.x * inv.elements[1] + p.y * inv.elements[5] + p.z * inv.elements[9] + inv.elements[13];
    st.off.push(Math.hypot(lx / (hit.w / 2), ly / (hit.h / 2)));
    st.ahead.push(cam.z - hit.group.position.z);
  } else if (hit.userData && hit.userData.mesh) {
    st.kinds.gem++;
    const c = hit.position;
    const vx = c.x - cam.x, vy = c.y - cam.y, vz = c.z - cam.z;
    const along = vx * dir.x + vy * dir.y + vz * dir.z;
    st.off.push(Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - along * along)) / .714);
    st.ahead.push(cam.z - c.z);
  } else {
    st.kinds.door++;
    st.off.push(Math.hypot(p.x, p.y - 3.4) / .77);
    st.ahead.push(cam.z - hit.position.z);
  }
}

function startSim(state, v) {
  const seed = seedToUint32(state.seed);
  if (seed === null) return false;
  state.mode = 'sim';
  state.version = v;
  // Non-enumerable: the live event path keeps validator state as JSON in
  // Redis, and the engine is a graph of three.js-style objects with cycles.
  // JSON simply drops it; the submit-time replay (one pass over the whole
  // trace) is what scores the run.
  const eng = new Engine.Engine(seed);
  eng.onThrow = (hit, cam, dir, p) => noteThrow(state, hit, cam, dir, p);
  Object.defineProperty(state, 'eng', { value: eng, enumerable: false, writable: true, configurable: true });
  return true;
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

// Advance the replay with no throw until stepIndex reaches `frame`.
function advanceTo(state, frame) {
  const eng = state.eng;
  const cap = Math.min(MAX_SIM_STEPS, elapsedCap(state));
  while (eng.state === 'playing' && eng.stepIndex < frame && eng.stepIndex < cap) eng.step(null);
  state.score = eng.score;
  if (eng.state !== 'playing') state.dead = true;
}

function processEvent(state, event) {
  if (state.dead || state.ended) return { accepted: false, newScore: state.score, reason: state.ended ? 'ended' : 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (state.mode !== 'sim' && payload.v === RULES_VERSION) {
      if (!startSim(state, RULES_VERSION)) return reject(state, 'bad_seed');
    }
    return { accepted: true, newScore: state.score };
  }
  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  // State that went through JSON (the live event path) has no engine left.
  if (!state.eng) return { accepted: true, newScore: state.score };
  const eng = state.eng;

  if (kind === 'end') {
    if (!isStep(payload.frame)) return reject(state, 'bad_end');
    // The run ends here (or earlier, if the rules ended it first). Ending
    // early can only lower a score: distance and crystals never go down.
    if (payload.frame >= eng.stepIndex) advanceTo(state, payload.frame);
    state.ended = true;
    state.endFrame = eng.stepIndex;
    state.score = eng.score;
    return { accepted: true, newScore: state.score };
  }
  if (kind !== 'taps') return { accepted: true, newScore: state.score };

  const actions = decodeTaps(payload);
  if (!actions) return reject(state, 'bad_taps');
  for (const a of actions) {
    if (state.dead || state.ended) break;
    if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
    state.inputCount++;
    // One throw per step at most, in order: a repeated or earlier frame
    // would re-run a window.
    if (a.f <= state.lastFrame) { reject(state, 'frame_regressed'); continue; }
    if (!Engine.validAction(a) || !Number.isFinite(a.tHint) || a.tHint < 0) { reject(state, 'bad_action'); continue; }
    if (a.f < eng.stepIndex) { reject(state, 'frame_regressed'); continue; }
    advanceTo(state, a.f);
    if (state.dead) break;
    if (eng.stepIndex !== a.f) { reject(state, 'beyond_cap'); state.ended = true; break; }
    state.lastFrame = a.f;
    const r = eng.step({ x: a.x, y: a.y });
    if (r === 'refused') reject(state, 'refused');
    if (eng.state !== 'playing') state.dead = true;
    state.score = eng.score;
  }
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always ends inside this bound.
function elapsedCap(state) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * FPS);
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }
function gapCv(frames) {
  if (frames.length < 3) return null;
  const g = [];
  for (let i = 1; i < frames.length; i++) g.push(frames[i] - frames[i - 1]);
  const m = mean(g); const s = sd(g);
  return m > 0 && s !== null ? s / m : null;
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.eng) {
    return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  }
  const eng = state.eng;
  if (!state.ended) {
    // No end marker: run the world out. Glass in the path ends any run that
    // stops throwing, and balls are finite.
    const cap = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * FPS), elapsedCap(state));
    while (eng.state === 'playing' && eng.stepIndex < cap) eng.step(null);
  }
  const st = state.stats;
  const throws = st.frames.length;
  return {
    score: eng.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', version: state.version, steps: eng.stepIndex, ended: state.ended, endFrame: state.endFrame,
      over: eng.state !== 'playing' ? eng.overReason : null,
      score: eng.score, section: eng.section, gems: eng.gemsCollected, ammo: eng.ammo, level: eng.level,
      inputs: state.inputCount, rejects: state.rejectCount, throws,
      aimed: st.kinds,
      offMean: round3(mean(st.off)), offSd: round3(sd(st.off)),
      aheadMean: round3(mean(st.ahead)), aheadSd: round3(sd(st.ahead)),
      gapCv: round3(gapCv(st.frames)),
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
  init, processEvent, finalize, simulate,
  _sim: { RULES_VERSION, MAX_INPUTS, MAX_SIM_STEPS, seedToUint32, decodeTaps, Engine },
};
