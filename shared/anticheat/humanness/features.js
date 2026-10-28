'use strict';

/**
 * Humanness fingerprint: feature extraction.
 *
 * Turns one decoded replay trace (the same events the validator replays)
 * into a flat set of numbers that describe HOW the run was played, not how
 * much it scored: the rhythm of the inputs, how it drifted over the run, the
 * hold lengths, the shape of the steering, and, where a validator measures
 * it, the accuracy of each input.
 *
 * None of these features depends on the score. That is the point: a bot
 * that stops just above the day's human top still taps with a machine's
 * rhythm and lands with a machine's error.
 *
 * Every feature is either a finite number or null (not measurable on this
 * run). Consumers must treat null as "no evidence", never as zero.
 */

const { describeGaps, round, mean } = require('./stats');

const FPS = 60;
const ACC_MIN_DROPS = 20;
const STEP_MS = 1000 / FPS;
const BRIDGE_STEPS = 2; // a still gap this short inside a drag is input rate, not a pause
const MAX_UPDATE_GAP = 8; // the slowest finger update rate we bridge: 60 / 9 = ~7 updates a second

// Per-game description of what an "input" is. Anything not listed falls
// back to the generic rule below, which is enough to RECORD a rhythm for
// every replayed game from day one.
const GAME_INPUTS = {
  'sky-tower':    { kinds: ['drop'], time: 'tHint' },
  'orbit-runner': { kinds: ['tap'], time: 'frame' },
  'smash-down':   { kinds: ['press'], time: 'frame', holds: { press: 'press', release: 'release' } },
  'twist-fall':   { rot: true },
  'stick-hero':   { kinds: ['hold'], time: 'pressStep', holds: { pair: ['pressStep', 'releaseStep'] } },
  'drifty-car':   { kinds: ['hold'], time: 'pressStep', holds: { pair: ['pressStep', 'releaseStep'] } },
  'hex-rush':     { kinds: ['hold'], time: 'pressStep', holds: { pair: ['pressStep', 'releaseStep'] } },
  'gannay-wala':  { kinds: ['chop'], time: 'step' },
  'bakri-dash':   { kinds: ['hop'], time: 'step' },
  'pulse':        { kinds: ['tap'], time: 'frame' },
  'save-the-birdie': { kinds: ['tap'], time: 'frame' },
  'patli-gali':   { kinds: ['turn'], time: 'frame' },
  // The game emits `shoot`; the first entry here said `shot` / `fire`, and
  // every Boom Patakha run was fingerprinted with 0 inputs for a week.
  'boom-patakha': { kinds: ['shoot', 'shot', 'fire'], time: 'tHint' },
  // Epic Slicer emits one `slice` per finger segment (thousands a run). The
  // player's input is the SWIPE: the first segment of each swipe id.
  'epic-slicer':  { kinds: ['slice'], time: 'tHint', group: 'swipe' },
  // Cannon Rush v2 steers the cannon with {f, x[]} batches (x = target * 16),
  // so its inputs are STROKES. A pre-replay v1 trace has no path; its one
  // `score` per hit is the nearest thing to an input it has.
  'cannon-rush':  { path: true, kinds: ['score'], time: 'tHint' },
  'block-blast':  { kinds: ['place'], time: 'tHint' },
  'bubble-shooter': { kinds: ['shot'], time: 'step' },
  'do-gaari':     { kinds: ['tap'], time: 'step' },
  'ulta-pulta':   { kinds: ['flip'], time: 'step' },
  'raftaar':      { kinds: ['tap'], time: 'step' },
  'saanp':        { kinds: ['turn'], time: 'step' },
  'jhoola':       { kinds: ['hold'], time: 'pressStep', holds: { pair: ['pressStep', 'releaseStep'] } },
  'bo-kaata':   { kinds: ['touch'], time: 'step', holds: { press: 'touch', release: 'lift', at: 'step' } },
  'mini-golf':    { kinds: ['putt'], time: 'step' },
  'lattoo':       { kinds: ['throw'], time: 'step' },
  // Oh Bhains: one { kind: 'act', n, a, step } per accepted tap or swipe (jump/stroke, slide, vault, lane).
  'oh-bhains':    { kinds: ['act'], time: 'step' },
  // Crazy Motorway: one { kind: 'in', n, d, step } per accepted swipe or key (lane, boost, brake, trick).
  'crazy-motorway': { kinds: ['in'], time: 'step' },
  // Chor Police: one { kind: 'hold', n, dir, pressStep, releaseStep } per held side (left or right).
  'chor-police': { kinds: ['hold'], time: 'pressStep', holds: { pair: ['pressStep', 'releaseStep'] } },
  // Tappa steers the same way: the ball's lateral path travels as dense
  // positional batches {f, x[]}, so its inputs are STROKES, not taps.
  'tappa':        { path: true },
  'duet':         { kinds: ['hold'], time: 'pressStep', holds: { pair: ['pressStep', 'releaseStep'] } },
  // Sky Racer steers a virtual stick: {f, x[], y[]} batches plus touch/lift.
  'sky-racer':    { path: true },
  // Galaxy Ride steers with {f, x[]} batches too (x = road target * 64) and
  // jumps as { kind: 'jump', step }. The jumps are the discrete inputs; a run
  // with enough steering to measure strokes counts those instead.
  'galaxy-ride':     { path: true, kinds: ['jump'], time: 'step' },
  'sky-ride':        { path: true, kinds: ['jump'], time: 'step' },
  // Stairs steers the ball's target: {f, x[]} batches, so its inputs are STROKES.
  'stairs':       { path: true },
  // Jelly Jhoom: the target shape travels as dense positional batches {f, x[]}
  // while a finger is down, so its inputs are STROKES.
  'jelly-jhoom':  { path: true },
  'color-dunk':   { path: true },
  'brick-breaker': { path: true },
  'roller-rani':  { path: true },
  // Ramp Ball: {f, x[], y[]} batches of how far the finger MOVED each step
  // (y = up/down, the push that drives the ball). They are integrated into a
  // finger position before the stroke measures read them.
  'ramp-ball':   { path: true, delta: 'y' },
  // Snake Blocks steers the head: {f, x[]} batches plus touch/lift, so its
  // inputs are STROKES.
  'snake-blocks': { path: true },
  // Kaanch: throws travel in binary batches { kind: 'taps', n, data }, each a
  // 16-byte record (uint32 frame, int16 x, int16 y, float64 tHint). One input
  // per throw, on the fixed step it was applied before.
  'kaanch':       { taps: true },
  // Rickshaw Run: one `in` (L/R/U/D) per input the game applied, on its fixed step.
  'rickshaw-run': { kinds: ['in'], time: 'step' },
  // 2048 Rush: one `move` per swipe, on the fixed step it was made on.
  'rush-2048':    { kinds: ['move'], time: 'step' },
  // Jelly Jump: one `tap` per press, on the fixed step it was applied on.
  'jelly-jump':   { kinds: ['tap'], time: 'step' },
  // Fruit Merge: one `drop` per fruit released, on the fixed step it was applied on.
  'fruit-merge':   { kinds: ['drop'], time: 'step' },
  // Dots Reflexes: one `tap` per press (a quarter turn), on the fixed step it lands before.
  'dots-reflexes': { kinds: ['tap'], time: 'step' },
  // Chakkar Chaku: one `throw` per knife thrown, on the fixed step it is applied before.
  'chakkar-chaku':    { kinds: ['throw'], time: 'step' },
  'rail-junction':    { kinds: ['flip'], time: 'step' },
  // Dart Champ: one `throw` per dart, on the fixed step it is thrown on.
  'dart-champ':       { kinds: ['throw'], time: 'step' },
  // Chal Cube: one `shape` per stroke drawn, on the fixed step it is applied before.
  'draw-climber':  { kinds: ['shape'], time: 'step' },
  // Into the Haze: one `tap` per turn, on the fixed step it is applied before.
  'into-the-haze': { kinds: ['tap'], time: 'step' },
  // Carrom King: one `shot` per flick, on the fixed step it is applied before.
  'carrom-king':   { kinds: ['shot'], time: 'step' },
};

// HUD / bookkeeping kinds that are never a player input.
const NOT_INPUT = new Set(['start', 'heartbeat', 'jump', 'pass', 'smash', 'bounce', 'score', 'lift', 'touch']);

function payloadOf(ev) {
  if (!ev) return null;
  const p = ev.payload;
  return p && typeof p === 'object' ? p : null;
}

function timeOf(p, field) {
  const v = p[field];
  if (!Number.isFinite(v)) return null;
  if (field === 'tHint') return v;
  return v * STEP_MS; // frames / steps to milliseconds
}

// Generic rule: the most frequent input kind that carries a frame, step or
// tHint and is not a HUD echo. Positional batches (path / aim / rot) are not
// discrete inputs and are skipped here.
function genericInputs(events) {
  const byKind = new Map();
  for (const ev of events) {
    const p = payloadOf(ev);
    if (!p || !p.kind || NOT_INPUT.has(p.kind)) continue;
    if (Array.isArray(p.q) || Array.isArray(p.x)) continue;
    if (p.scoreAfter !== undefined) continue;
    const field = ['frame', 'step', 'pressStep', 'tHint'].find((f) => Number.isFinite(p[f]));
    if (!field) continue;
    const list = byKind.get(p.kind) || [];
    list.push(timeOf(p, field));
    byKind.set(p.kind, list);
  }
  let best = null;
  for (const [kind, list] of byKind) if (!best || list.length > best.list.length) best = { kind, list };
  return best ? best.list : [];
}

function listedInputs(events, spec) {
  const out = [];
  const seen = spec.group ? new Set() : null;
  for (const ev of events) {
    const p = payloadOf(ev);
    if (!p || !spec.kinds.includes(p.kind)) continue;
    if (seen) {
      // One input per group (a swipe made of many segments): the first one.
      const g = p[spec.group];
      if (g === undefined || g === null) continue;
      if (seen.has(g)) continue;
      seen.add(g);
    }
    const t = timeOf(p, spec.time);
    if (t !== null) out.push(t);
  }
  return out;
}

// Kaanch's binary throw batches: the frame of every record, in milliseconds.
function tapRecordInputs(events) {
  const out = [];
  for (const ev of events) {
    const p = payloadOf(ev);
    if (!p || p.kind !== 'taps' || typeof p.data !== 'string') continue;
    let buf;
    try { buf = Buffer.from(p.data, 'base64'); } catch (_e) { continue; }
    for (let o = 0; o + 16 <= buf.length; o += 16) out.push(buf.readUInt32LE(o) * STEP_MS);
  }
  return out;
}

function gaps(times) {
  const g = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (Number.isFinite(d) && d >= 0) g.push(d);
  }
  return g;
}

// ── tap timing on a frame grid ──
// A tap or a press can only be recorded on a FRAME, and on a slow phone (Low
// Power Mode, a heavy game) frames are 33-67 ms apart. Every gap and hold then
// snaps to a few values, which reads as a metronome, and two taps in one frame
// get the same time, which reads as an impossible 0 ms gap (frame-rate audit,
// 15 Oct: Chor Police, Ulta Pulta, Bakri Dash, Smash Down). When a run's own
// gaps sit on a grid of 2-4 steps, taps in one frame count once and each time
// is spread across its frame (deterministically), putting back the detail the
// phone rounded away. A 60 Hz run is untouched.
function frameQuantum(values, minCounts = 4, maxTop = 0.6) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0.5);
  if (v.length < 10) return 0;
  for (const k of [4, 3, 2]) {
    const q = k * STEP_MS;
    let on = 0;
    const counts = new Map();
    for (const x of v) {
      const m = Math.max(1, Math.round(x / q));
      if (Math.abs(x - m * q) <= 3) { on += 1; counts.set(m, (counts.get(m) || 0) + 1); }
    }
    // A player on a slow phone lands on MANY frame counts; a metronome (or a bot
    // tapping every N steps) on one or two. Only the first is de-rounded, so a
    // machine's regularity is never blurred.
    const top = Math.max(0, ...counts.values());
    if (on >= 0.8 * v.length && counts.size >= minCounts && top < maxTop * on) return q;
  }
  return 0;
}
function spread(i, salt) {
  let h = Math.imul((i + 1) ^ salt, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function holdLengths(events, spec) {
  const holds = [];
  if (!spec || !spec.holds) return holds;
  if (spec.holds.pair) {
    const [a, b] = spec.holds.pair;
    for (const ev of events) {
      const p = payloadOf(ev);
      if (p && Number.isFinite(p[a]) && Number.isFinite(p[b]) && p[b] >= p[a]) holds.push((p[b] - p[a]) * STEP_MS);
    }
    return holds;
  }
  const at = spec.holds.at || 'frame';
  let down = null;
  for (const ev of events) {
    const p = payloadOf(ev);
    if (!p) continue;
    if (p.kind === spec.holds.press && Number.isFinite(p[at])) down = p[at];
    else if (p.kind === spec.holds.release && Number.isFinite(p[at]) && down !== null) {
      if (p[at] >= down) holds.push((p[at] - down) * STEP_MS);
      down = null;
    }
  }
  return holds;
}

// Twist Fall: rotation travels as dense positional batches {f, q[]}. Rebuild
// the per-step rotation over the run and describe the STROKES (runs of
// non-zero steps) and the PAUSES between them.
// ── steering, measured so the device's update rate cannot change it ──
// A drag or a turn reaches the game once per FRAME, and a phone's frame rate is
// not ours: 60 Hz, 30 Hz in Low Power Mode, ~15 Hz for a heavy 3D game on that
// phone. Read per step, a slow phone looks like one-step strokes and four times
// the force per update (buggy: Stairs 12 Oct, Galaxy Ride 15 Oct). Everything
// below is either bridged by the run's own update interval or measured over
// STEER_WIN-step windows, wider than the slowest update we accept.
const STEER_WIN = 8; // 133 ms: covers updates down to 7.5 a second

// d: signed per-step values (0 = no update). Strokes split only at a still gap
// longer than the run's own update interval.
function strokeSegments(d) {
  const nz = d.filter((v) => v !== 0);
  const gaps = [];
  for (let i = 0; i < d.length; i++) {
    if (d[i] !== 0) continue;
    let j = i;
    while (j < d.length && d[j] === 0) j += 1;
    if (i > 0 && j < d.length) gaps.push([i, j]);
    i = j - 1;
  }
  // The update interval is the most common short still gap between two moves,
  // trusted only when it follows most moves (at 15-30 Hz nearly every move is
  // followed by one; at 60 Hz short gaps are rare and real pauses must not be
  // mistaken for it). Gaps up to one step longer are part of the stroke.
  const freq = new Map();
  for (const [i, j] of gaps) if (j - i <= MAX_UPDATE_GAP) freq.set(j - i, (freq.get(j - i) || 0) + 1);
  let mode = 0, modeN = 0;
  for (const [len, n] of freq) if (n > modeN || (n === modeN && len < mode)) { mode = len; modeN = n; }
  if (modeN < 0.5 * nz.length) mode = 0;
  const bridge = Math.max(BRIDGE_STEPS, Math.min(MAX_UPDATE_GAP, mode + 1));
  const moving = d.map((v) => v !== 0);
  for (const [i, j] of gaps) if (j - i <= bridge) for (let k = i; k < j; k++) moving[k] = true;
  const strokes = [], pauses = [], speeds = [];
  let run = 0, zero = 0, dist = 0;
  for (let i = 0; i < d.length; i++) {
    if (moving[i]) {
      if (zero) { pauses.push(zero * STEP_MS); zero = 0; }
      run += 1; dist += Math.abs(d[i]);
    } else {
      if (run) { strokes.push(run * STEP_MS); speeds.push(dist / run); run = 0; dist = 0; }
      zero += 1;
    }
  }
  if (run) { strokes.push(run * STEP_MS); speeds.push(dist / run); }
  return { nz, moving, strokes, pauses, speeds, updateGap: mode };
}

// Window view of the same signal. A MOVE is a window where the player starts
// steering after stillness, or reverses direction: a continuous steerer who never
// pauses still makes many moves. FORCE is travel per step inside active windows.
function steerWindows(d) {
  const W = STEER_WIN;
  const nWin = Math.floor(d.length / W);
  if (nWin < 4) return null;
  let moves = 0, revs = 0, active = 0, prevActive = false, prevDir = 0;
  const force = [];
  for (let w = 0; w < nWin; w++) {
    let net = 0, abs = 0;
    for (let k = w * W; k < (w + 1) * W; k++) { net += d[k]; abs += Math.abs(d[k]); }
    if (abs === 0) { prevActive = false; continue; }
    active += 1;
    force.push(abs / W);
    const dir = net > 0 ? 1 : net < 0 ? -1 : prevDir;
    if (!prevActive) moves += 1;
    else if (dir !== 0 && prevDir !== 0 && dir !== prevDir) { moves += 1; revs += 1; }
    prevActive = true; if (dir !== 0) prevDir = dir;
  }
  const fo = describeGaps(force, 4);
  return {
    steerMoves: moves,
    steerActive: round(active / nWin),
    steerRevPerSec: round(revs / ((nWin * W) / FPS), 3),
    steerForce: fo ? round(fo.mean, 2) : null,
    steerForceCv: fo ? fo.cv : null,
  };
}

function rotFeatures(events) {
  const steps = new Map();
  let first = Infinity, last = -Infinity;
  for (const ev of events) {
    const p = payloadOf(ev);
    if (!p || p.kind !== 'rot' || !Array.isArray(p.q) || !Number.isFinite(p.f)) continue;
    for (let i = 0; i < p.q.length; i++) {
      const s = p.f + 1 + i;
      steps.set(s, Number(p.q[i]) || 0);
      if (s < first) first = s;
      if (s > last) last = s;
    }
  }
  if (!steps.size || last - first < 30) return null;
  const q = [];
  for (let s = first; s <= last; s++) q.push(steps.get(s) || 0);
  const seg = strokeSegments(q);
  const nz = seg.nz;
  if (nz.length < 10) return null;
  let flips = 0;
  for (let i = 1; i < nz.length; i++) if (Math.sign(nz[i]) !== Math.sign(nz[i - 1])) flips += 1;
  const win = steerWindows(q);
  const st = describeGaps(seg.strokes, 4);
  const pa = describeGaps(seg.pauses, 4);
  return Object.assign({
    rotSpanSec: round((last - first) / FPS, 2),
    rotActive: round(seg.moving.filter(Boolean).length / q.length),
    // Rotation per step INSIDE active windows. Per update it would grow with a
    // slow frame rate (a 15 fps phone delivers four steps of turning at once).
    rotAbsQMean: win ? win.steerForce : null,
    rotAbsQCv: win ? win.steerForceCv : null,
    rotFlipsPer100: round((100 * flips) / nz.length, 2),
    rotUniqQ: new Set(nz).size,
    rotUpdateGap: seg.updateGap,
    strokeN: seg.strokes.length,
    strokeMean: st ? st.mean : null,
    strokeCv: st ? st.cv : null,
    pauseMean: pa ? pa.mean : null,
    pauseCv: pa ? pa.cv : null,
  }, win || {});
}

// Positional path batches {f, x[]}: a steering game where the player's whole
// input is where a thing is, one sample per step. Rebuild the per-step travel
// over the run and describe the STROKES (runs of steps that moved) and the
// PAUSES between them. Generic: any game whose trace carries `path` batches
// can use it, and `touch` markers count as the discrete inputs.
// a game that records how far the finger moved each step: sum the moves into a
// position, as a stroke-based game would have recorded it
function integrateDeltas(events, key) {
  const steps = [];
  for (const ev of events) {
    const p = payloadOf(ev);
    if (!p || p.kind !== 'path' || !Array.isArray(p[key]) || !Number.isFinite(p.f)) continue;
    for (let i = 0; i < p[key].length; i++) steps.push([p.f + 1 + i, Number(p[key][i]) || 0]);
  }
  steps.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  const x = [];
  if (!steps.length) return [];
  const f0 = steps[0][0];
  let k = 0;
  for (let s = f0; s <= steps[steps.length - 1][0]; s++) {
    while (k < steps.length && steps[k][0] === s) { pos += steps[k][1]; k++; }
    x.push(pos);
  }
  return [{ type: 'input', payload: { kind: 'path', f: f0 - 1, x } }];
}
function pathFeatures(events, delta) {
  const steps = new Map();
  let first = Infinity, last = -Infinity, touches = 0;
  for (const ev of events) {
    const p = payloadOf(ev);
    if (!p) continue;
    if (p.kind === 'touch') { touches += 1; continue; }
    if (p.kind !== 'path' || !Array.isArray(p.x) || !Number.isFinite(p.f)) continue;
    const src = delta && Array.isArray(p[delta]) ? p[delta] : p.x;
    for (let i = 0; i < src.length; i++) {
      const s = p.f + 1 + i;
      const v = Number(src[i]);
      if (!Number.isFinite(v)) continue;
      steps.set(s, v);
      if (s < first) first = s;
      if (s > last) last = s;
    }
  }
  if (!steps.size || last - first < 30) return null;
  const d = [];
  let prev = null;
  for (let s = first; s <= last; s++) {
    const v = steps.get(s);
    if (v === undefined) { prev = null; continue; }
    if (prev !== null) d.push(v - prev);
    prev = v;
  }
  if (d.length < 20) return null;
  const seg = strokeSegments(d);
  const { nz, moving, strokes, pauses, speeds } = seg;
  let flips = 0;
  for (let i = 1; i < nz.length; i++) if (Math.sign(nz[i]) !== Math.sign(nz[i - 1])) flips += 1;
  const win = steerWindows(d);
  const abs = nz.map(Math.abs);
  const peak = abs.length ? Math.max.apply(null, abs) : 0;
  const atPeak = peak > 0 ? abs.filter((v) => v === peak).length / d.length : null;
  const st = describeGaps(strokes, 4);
  const pa = describeGaps(pauses, 4);
  const sp = describeGaps(speeds, 4);
  return Object.assign({
    pathSpanSec: round((last - first) / FPS, 2),
    pathActive: round(moving.filter(Boolean).length / d.length),
    pathAbsMean: round(mean(abs), 2),
    pathAtLimit: round(atPeak),
    pathFlipsPer100: nz.length ? round((100 * flips) / nz.length, 2) : null,
    pathUpdateGap: seg.updateGap,
    pathTouches: touches,
    strokeN: strokes.length,
    strokeMean: st ? st.mean : null,
    strokeCv: st ? st.cv : null,
    strokeSpeedMean: sp ? sp.mean : null,
    strokeSpeedCv: sp ? sp.cv : null,
    pauseMean: pa ? pa.mean : null,
    pauseCv: pa ? pa.cv : null,
  }, win || {});
}

function prefix(obj, pre) {
  const out = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) out[pre + k[0].toUpperCase() + k.slice(1)] = v;
  return out;
}

/**
 * extractFeatures(gameId, events, { score, elapsedSecs, fingerprint })
 *   events      decoded trace, [{type, payload, ts, seq}]
 *   score       the replayed (authoritative) score
 *   elapsedSecs session length in seconds
 *   fingerprint the validator's own accuracy block (Sky Tower today)
 */
function extractFeatures(gameId, events, ctx = {}) {
  const spec = GAME_INPUTS[gameId] || null;
  const f = { game: gameId, inputs: 0 };
  let times = [];
  if (spec && spec.taps) times = tapRecordInputs(events);
  else if (spec && spec.kinds) times = listedInputs(events, spec);
  else if (!spec || (!spec.rot && !spec.path)) times = genericInputs(events);
  times.sort((a, b) => a - b);
  const quantum = frameQuantum(gaps(times));
  let frameGaps = null;
  if (quantum) {
    const once = [];
    for (const t of times) if (!once.length || t - once[once.length - 1] >= quantum / 2) once.push(t);
    frameGaps = gaps(once);
    times = once.map((t, i) => t + (spread(i, 0x51) - 0.5) * quantum).sort((a, b) => a - b);
  }
  f.inputQuantumMs = quantum ? round(quantum, 1) : 0;
  f.inputs = times.length;
  const span = times.length >= 2 ? (times[times.length - 1] - times[0]) / 1000 : null;
  f.spanSec = round(span, 2);
  f.inputsPerSec = span > 0 ? round(times.length / span, 3) : null;

  const g = gaps(times);
  Object.assign(f, prefix(describeGaps(g), 'gap'));
  // On a frame grid the fastest gaps cannot be measured: two taps one frame
  // apart may really have been anywhere from 0 to two frames apart, and a fast
  // game (Gannay Wala: chops 110-200 ms apart, frames 67 ms) lives inside that
  // error. The floor measures are left unjudged rather than guessed.
  if (frameGaps) { f.gapMin = null; f.gapP10 = null; }
  if (g.length >= 18) {
    const third = Math.floor(g.length / 3);
    const early = describeGaps(g.slice(0, third), 4);
    const late = describeGaps(g.slice(g.length - third), 4);
    f.gapCvEarly = early ? early.cv : null;
    f.gapCvLate = late ? late.cv : null;
    f.tempoDrift = early && late && early.mean > 0 ? round(late.mean / early.mean) : null;
  } else {
    f.gapCvEarly = null; f.gapCvLate = null; f.tempoDrift = null;
  }

  let holds = holdLengths(events, spec);
  // honest holds cluster on fewer lengths than gaps; a bot's fixed hold is one
  const holdQuantum = frameQuantum(holds, 3, 0.7);
  if (holdQuantum) holds = holds.map((h, i) => Math.max(1, h + (spread(i, 0x77) - 0.5) * holdQuantum));
  Object.assign(f, prefix(describeGaps(holds), 'hold'));

  if (spec && spec.path) {
    const pth = pathFeatures(spec.delta ? integrateDeltas(events, spec.delta) : events);
    Object.assign(f, pth);
    // A steering game has no discrete taps: each STROKE is the input, and the
    // play span runs from the first sampled step to the last.
    if (pth) { f.inputs = Math.max(pth.steerMoves || 0, pth.strokeN || 0) || f.inputs; f.spanSec = pth.pathSpanSec; }
  }

  if (spec && spec.rot) {
    const rot = rotFeatures(events);
    Object.assign(f, rot);
    // A steering game has no discrete taps: each STROKE is the input, and
    // the play span runs from the first rotation step to the last.
    if (rot) { f.inputs = Math.max(rot.steerMoves || 0, rot.strokeN || 0) || f.inputs; f.spanSec = rot.rotSpanSec; }
  }

  // Landing accuracy needs a sample: eight perfect drops is a warm-up, twenty
  // is a statement. Below ACC_MIN_DROPS the numbers are recorded nowhere.
  const fp = ctx.fingerprint;
  if (fp && Number.isFinite(fp.drops) && fp.drops >= ACC_MIN_DROPS) {
    f.accDrops = fp.drops;
    f.perfectRate = round(fp.perfectRate);
    if (Number.isFinite(fp.perfectStreakMax)) f.perfectStreakMax = fp.perfectStreakMax;
    f.meanErr = round(fp.meanErr);
    f.sdErr = round(fp.sdErr);
    f.errSlope = round(fp.errSlope);
  }
  // How the inputs ARRIVED (from the SDK's provenance summary): pointer
  // types, the trusted flag, hold durations, coordinate repetition, movement
  // before a press, keyboard use. Absent on traces recorded before it existed.
  const pv = ctx.provenance;
  if (pv && Number.isFinite(pv.n) && pv.n > 0) {
    f.provN = pv.n;
    f.provTouchFrac = round((pv.touch || 0) / pv.n);
    f.provMouseFrac = round((pv.mouse || 0) / pv.n);
    f.provUntrustedFrac = round((pv.untrusted || 0) / pv.n);
    f.provKeys = pv.keys || 0;
    f.provTouchEv = pv.touchEv || 0;
    f.provMouseEv = pv.mouseEv || 0;
    if (Number.isFinite(pv.holdCv)) f.provHoldCv = pv.holdCv;
    if (Number.isFinite(pv.holdModeFrac)) f.provHoldModeFrac = pv.holdModeFrac;
    if (Number.isFinite(pv.holdMean)) f.provHoldMean = pv.holdMean;
    if (Number.isFinite(pv.coordUniq)) f.provCoordUniq = pv.coordUniq;
    if (Number.isFinite(pv.preMoveFrac)) f.provPreMoveFrac = pv.preMoveFrac;
    // 23 Sep 2026, RECORD-ONLY (no FEATURE_SPEC entry judges these yet): the
    // physics of each press and of the device. Absent on older clients and on
    // devices that do not report them; absence is never evidence.
    const num = (v) => (Number.isFinite(v) ? v : undefined);
    const put = (k, v) => { if (v !== undefined && v !== null) f[k] = v; };
    if (pv.area) { put('provAreaMean', num(pv.area.mean)); put('provAreaCv', num(pv.area.cv)); put('provAreaUniq', num(pv.area.uniq)); }
    if (pv.press) { put('provPressMean', num(pv.press.mean)); put('provPressCv', num(pv.press.cv)); put('provPressUniq', num(pv.press.uniq)); }
    put('provMultiFrac', num(pv.multiFrac));
    if (pv.coal) { put('provCoalMean', num(pv.coal.mean)); put('provCoalGt1Frac', num(pv.coal.gt1Frac)); }
    if (pv.raf) { put('provRafHz', num(pv.raf.hz)); put('provRafP90', num(pv.raf.p90)); }
    if (pv.motion) {
      const mo = pv.motion;
      f.provMotionPerm = typeof mo.perm === 'string' ? mo.perm : 'unknown';   // granted | denied | free | na | unasked | asking | error
      put('provMotionN', num(mo.n)); put('provMotionHz', num(mo.hz)); put('provTremor', num(mo.tremor));
      put('provJoltMean', num(mo.joltMean)); put('provJoltFrac', num(mo.joltFrac)); put('provJoltN', num(mo.joltN));
    }
    // 24 Sep 2026, RECORD-ONLY: up to 80 raw per-press samples, each
    // [hold ms, pressure, contact area, ms since last move, moves since the
    // last press, biggest move step px, jump to the press point px, pointer
    // type]. An array, so the envelope (numbers only) never reads it.
    if (Array.isArray(pv.samples)) {
      const rows = pv.samples.slice(0, 80).filter((r) => Array.isArray(r) && r.length === 8)
        .map((r) => r.map((v) => (Number.isFinite(v) ? v : null)));
      if (rows.length) f.provSamples = rows;
    }
  }
  if (Number.isFinite(ctx.score) && times.length > 0) f.pointsPerInput = round(ctx.score / times.length, 3);
  if (Number.isFinite(ctx.elapsedSecs)) f.elapsedSec = ctx.elapsedSecs;
  return f;
}

module.exports = { extractFeatures, GAME_INPUTS, STEP_MS, ACC_MIN_DROPS };
