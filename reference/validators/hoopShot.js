'use strict';

/**
 * Hoop Shot validator: SERVER-SIDE DETERMINISTIC REPLAY.
 *
 * The score is never taken from the client. The server builds the same course
 * from the session seed (hoop N's side, offset, rise, rim width and motion are
 * a pure function of (seed, N)), flies each recorded launch velocity through
 * its own copy of the world with integer arithmetic, and works out itself
 * whether the ball went in, whether it touched a rim on the way, whether it
 * came off a wall, and what that is worth.
 *
 * What a client can assert is exactly two things: the LAUNCH VELOCITY (two
 * integers in 1/256 design units per substep) and WHEN (the shot index and the
 * game step it was fired on). A shot out of order, before the last one landed,
 * with a velocity outside the slingshot's band, or after the run is over, is
 * REFUSED rather than scored, and a refusal never zeroes the run.
 *
 * WHY THIS GAME IS EASY TO REPLAY. It is turn based: the whole flight is
 * resolved at the moment it is fired, nothing on the course moves except on a
 * closed form of the step clock, and that clock is carried on each event, so
 * the trace is the whole clock. The flight is integer stepped; a wall is a
 * sign flip and a rim is an integer reflection. There is exactly ONE
 * Math.sqrt on the path, in rimBounce, where it takes the length of an integer
 * vector: IEEE 754 requires sqrt to be correctly rounded, so it is the same
 * bits in every engine. No trigonometry, no engine transcendental, no dmath.
 *
 * THE CORE BELOW IS A TRANSCRIPTION of games/hoop-shot/js/game.js and must
 * stay textually identical to it: mix, scaleI, tri, shotSteps, makeHoop,
 * hoopX, hoopY, catchOff, rimBounce, flight, launch, advanceTo, validVector,
 * validSeed, initSim. shared/tests/hoopShotParity.test.js pulls every shared
 * constant and every one of those function bodies out of BOTH files and
 * requires a match, then flies the real game and compares the whole world
 * after every single event.
 */

// ── SHARED CORE: constants ───────────────────────────────────────────────
const RULES_VERSION = 2;
const DESIGN_W = 414;
const DESIGN_H = 736;
const CENTRE_X = 207;
const Q = 256;
const SUB = 4;
const STEP_FPS = 60;
const BALL_R = 11;
const RIM_R = 3;
const GRAV = 11;
const VY_MAX = 2600;
const VX_MAX = 2600;
const WALL_NUM = 96;
const WALL_DEN = 100;
const RIM_NUM = 30;
const RIM_DEN = 100;
const RIM_REST = 140;
const RIM_SLIDE = 90;
const NSCALE = 4096;
const POWER_MIN = 190;
const POWER_MAX = 1750;
const START_Y = 520;
const FALL_MARGIN = 300;
const MAX_FLIGHT_STEPS = 600;
const NO_CATCH = 1 << 28;

// ── the course ───────────────────────────────────────────────────────────
const STAY_PCT = 22;
const X_OFF_MIN = 40;
const X_OFF_SPAN = 62;
const EDGE_PAD = 4;
const RISE_BASE = 112;
const RISE_SPAN = 40;
const RISE_EVERY = 6;
const RISE_GROW = 4;
const RISE_GROW_CAP = 72;
const HW_START = 58;
const HW_EVERY = 3;
const HW_FLOOR = 38;
const HW_JIT_SPAN = 6;
const MOVE_FROM = 6;
const MOVE_H_PCT = 32;
const MOVE_V_PCT = 18;
const MOVE_RAMP_EVERY = 5;
const MOVE_RAMP_CAP = 10;
const MOVE_AMP_H_MIN = 18;
const MOVE_AMP_H_SPAN = 22;
const MOVE_AMP_H_GROW = 4;
const MOVE_AMP_H_CAP = 64;
const MOVE_AMP_V_MIN = 12;
const MOVE_AMP_V_SPAN = 14;
const MOVE_AMP_V_GROW = 2;
const MOVE_AMP_V_CAP = 30;
const MOVE_PER_MAX = 300;
const MOVE_PER_SPAN = 90;
const MOVE_PER_SHRINK = 12;
const MOVE_PER_MIN = 96;
const MOVE_PHASE_SPAN = 512;

// ── scoring and the shot clock ───────────────────────────────────────────
const PERFECT_CAP = 4;
const BANK_MULT = 2;
const SHOT_START = 600;
const SHOT_FLOOR = 300;
const SHOT_SCORE_STEP = 15;
const SHOT_SHRINK = 10;

// ── the hash ─────────────────────────────────────────────────────────────
const HASH_A = 0x9E3779B1;
const HASH_B = 0x85EBCA6B;
const HASH_C = 0xC2B2AE35;
const HASH_D = 0x27D4EB2F;
const HASH_E = 0x165667B1;
const HASH_F = 0x2C1B3C6D;

// ── SHARED CORE: functions ───────────────────────────────────────────────

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

// Symmetric integer scaling: Math.floor alone rounds toward -Infinity, which
// would make a leftward bounce lose a sub-unit a rightward one keeps.
function scaleI(v, num, den) {
  return v < 0 ? -Math.floor((-v * num) / den) : Math.floor((v * num) / den);
}

// Integer triangle wave over a FULL cycle of `period` steps, -amp .. +amp.
function tri(t, period, amp) {
  const h = period >> 1;
  if (h <= 0 || amp <= 0) return 0;
  let u = t % period;
  if (u < 0) u += period;
  if (u <= h) return -amp + Math.floor((2 * amp * u) / h);
  return amp - Math.floor((2 * amp * (u - h)) / h);
}

function shotSteps(score) {
  const n = SHOT_START - Math.floor(score / SHOT_SCORE_STEP) * SHOT_SHRINK;
  return n < SHOT_FLOOR ? SHOT_FLOOR : n;
}

// Hoop N: eight draws, all index addressed, all taken on every index whatever
// branch is chosen, so nothing can shift the stream.
function makeHoop(sim, n, prevBaseY) {
  const sideRoll = mix(sim, n, 0, 11) % 100;
  const offRoll = mix(sim, n, 1, 11) % X_OFF_SPAN;
  const riseRoll = mix(sim, n, 2, 11) % RISE_SPAN;
  const hwRoll = mix(sim, n, 3, 11) % HW_JIT_SPAN;
  const mkRoll = mix(sim, n, 4, 11) % 100;
  const maRoll = mix(sim, n, 5, 11) % 1000;
  const mpRoll = mix(sim, n, 6, 11) % MOVE_PER_SPAN;
  const mphRoll = mix(sim, n, 7, 11) % MOVE_PHASE_SPAN;
  if (n <= 0) {
    return { i: 0, bx: CENTRE_X, by: START_Y, hw: HW_START + 3, mk: 0, ma: 0, mp: MOVE_PER_MAX, mph: 0 };
  }
  const side = ((n & 1) ^ (sideRoll < STAY_PCT ? 1 : 0)) ? 1 : -1;
  let grow = Math.floor(n / RISE_EVERY) * RISE_GROW;
  if (grow > RISE_GROW_CAP) grow = RISE_GROW_CAP;
  const by = prevBaseY - (RISE_BASE + riseRoll + grow);
  let base = HW_START - Math.floor(n / HW_EVERY);
  if (base < HW_FLOOR) base = HW_FLOOR;
  const hw = base + hwRoll;
  const lim = hw + RIM_R + EDGE_PAD;
  let bx = CENTRE_X + side * (X_OFF_MIN + offRoll);
  if (bx < lim) bx = lim;
  if (bx > DESIGN_W - lim) bx = DESIGN_W - lim;
  let mk = 0;
  let ma = 0;
  let mp = MOVE_PER_MAX;
  let mph = 0;
  if (n >= MOVE_FROM) {
    if (mkRoll < MOVE_H_PCT) mk = 1;
    else if (mkRoll < MOVE_H_PCT + MOVE_V_PCT) mk = 2;
  }
  if (mk > 0) {
    let lvl = Math.floor((n - MOVE_FROM) / MOVE_RAMP_EVERY);
    if (lvl > MOVE_RAMP_CAP) lvl = MOVE_RAMP_CAP;
    if (mk === 1) {
      ma = MOVE_AMP_H_MIN + (maRoll % MOVE_AMP_H_SPAN) + lvl * MOVE_AMP_H_GROW;
      if (ma > MOVE_AMP_H_CAP) ma = MOVE_AMP_H_CAP;
      const room = Math.min(bx - lim, DESIGN_W - lim - bx);
      if (ma > room) ma = room;
    } else {
      ma = MOVE_AMP_V_MIN + (maRoll % MOVE_AMP_V_SPAN) + lvl * MOVE_AMP_V_GROW;
      if (ma > MOVE_AMP_V_CAP) ma = MOVE_AMP_V_CAP;
    }
    mp = MOVE_PER_MAX - mpRoll - lvl * MOVE_PER_SHRINK;
    if (mp < MOVE_PER_MIN) mp = MOVE_PER_MIN;
    mp = mp - (mp & 1);
    mph = mphRoll;
    if (ma <= 0) { mk = 0; ma = 0; mph = 0; mp = MOVE_PER_MAX; }
  }
  return { i: n, bx, by, hw, mk, ma, mp, mph };
}

function hoopX(h, step) {
  return h.mk === 1 ? h.bx + tri(step + h.mph, h.mp, h.ma) : h.bx;
}

function hoopY(h, step) {
  return h.mk === 2 ? h.by + tri(step + h.mph, h.mp, h.ma) : h.by;
}

// The ball's centre crossed the rim LINE downward, inside the free gap between
// the two rim points. Returns its offset from the hoop centre in Q units, or
// NO_CATCH. Only the centre is tested; a ball that grazes a rim point has
// already been turned by rimBounce in an earlier substep.
function catchOff(hx, hy, hw, x0, y0, x1, y1) {
  const hyQ = hy * Q;
  if (!(y0 < hyQ && y1 >= hyQ)) return NO_CATCH;
  const gap = (hw - RIM_R - BALL_R) * Q;
  if (gap <= 0) return NO_CATCH;
  const off = x0 + scaleI((x1 - x0) * (hyQ - y0), 1, y1 - y0) - hx * Q;
  if (off > gap || off < -gap) return NO_CATCH;
  return off;
}

// Reflect the ball off one rim point. b is a per-flight scratch, never sim.
function rimBounce(b, rxQ, ryQ) {
  const rr = (BALL_R + RIM_R) * Q;
  const dx = b.x - rxQ;
  const dy = b.y - ryQ;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr) return 0;
  let len = Math.floor(Math.sqrt(d2));
  let nx;
  let ny;
  if (len <= 0) { nx = 0; ny = -NSCALE; } else { nx = scaleI(dx * NSCALE, 1, len); ny = scaleI(dy * NSCALE, 1, len); }
  b.x = rxQ + scaleI(nx * rr, 1, NSCALE);
  b.y = ryQ + scaleI(ny * rr, 1, NSCALE);
  const dot = b.vx * nx + b.vy * ny;
  if (dot < 0) {
    b.vx -= scaleI(2 * dot * nx, 1, NSCALE * NSCALE);
    b.vy -= scaleI(2 * dot * ny, 1, NSCALE * NSCALE);
  }
  b.vx = scaleI(b.vx, RIM_NUM, RIM_DEN);
  b.vy = scaleI(b.vy, RIM_NUM, RIM_DEN);
  // A ball can come to rest exactly on top of a rim point, where gravity has
  // no tangential component to pull it off, and it perches there until the
  // flight's work bound expires. Nothing balances on a rim: roll it off down
  // the side it is already leaning to, and off the right if it is dead centre.
  if (b.vx * b.vx + b.vy * b.vy < RIM_REST * RIM_REST) b.vx += dx < 0 ? -RIM_SLIDE : RIM_SLIDE;
  return 1;
}

// One whole flight, resolved at the moment it is fired. Reads sim, never
// writes it. `pts` collects the drawn path one point per substep; `maxPts`
// stops early for the aim preview and is 0 for a real shot.
function flight(sim, vx0, vy0, startStep, pts, maxPts) {
  const curH = sim.cur;
  const nxtH = sim.nxt;
  const b = { x: hoopX(curH, startStep) * Q, y: hoopY(curH, startStep) * Q, vx: vx0, vy: vy0 };
  const wallL = BALL_R * Q;
  const wallR = (DESIGN_W - BALL_R) * Q;
  const deathY = (curH.by + FALL_MARGIN) * Q;
  let rim = 0;
  let bank = 0;
  let subs = 0;
  if (pts) pts.push(b.x, b.y);
  for (let k = 1; k <= MAX_FLIGHT_STEPS; k++) {
    const step = startStep + k;
    const cx = hoopX(curH, step);
    const cy = hoopY(curH, step);
    const nx = hoopX(nxtH, step);
    const ny = hoopY(nxtH, step);
    for (let s = 0; s < SUB; s++) {
      const x0 = b.x;
      const y0 = b.y;
      b.vy += GRAV;
      if (b.vy > VY_MAX) b.vy = VY_MAX;
      if (b.vy < -VY_MAX) b.vy = -VY_MAX;
      if (b.vx > VX_MAX) b.vx = VX_MAX;
      if (b.vx < -VX_MAX) b.vx = -VX_MAX;
      b.x += b.vx;
      b.y += b.vy;
      if (b.x < wallL) {
        b.x = 2 * wallL - b.x;
        b.vx = -scaleI(b.vx, WALL_NUM, WALL_DEN);
        bank += 1;
      } else if (b.x > wallR) {
        b.x = 2 * wallR - b.x;
        b.vx = -scaleI(b.vx, WALL_NUM, WALL_DEN);
        bank += 1;
      }
      subs += 1;
      const hitN = catchOff(nx, ny, nxtH.hw, x0, y0, b.x, b.y);
      if (hitN !== NO_CATCH) {
        if (pts) pts.push(nx * Q, ny * Q);
        return { caught: 2, endStep: step, subs, rim, bank, swish: rim === 0, off: hitN, x: nx * Q, y: ny * Q };
      }
      const hitC = catchOff(cx, cy, curH.hw, x0, y0, b.x, b.y);
      if (hitC !== NO_CATCH) {
        if (pts) pts.push(cx * Q, cy * Q);
        return { caught: 1, endStep: step, subs, rim, bank, swish: false, off: hitC, x: cx * Q, y: cy * Q };
      }
      rim += rimBounce(b, (nx - nxtH.hw) * Q, ny * Q);
      rim += rimBounce(b, (nx + nxtH.hw) * Q, ny * Q);
      rim += rimBounce(b, (cx - curH.hw) * Q, cy * Q);
      rim += rimBounce(b, (cx + curH.hw) * Q, cy * Q);
      if (pts) pts.push(b.x, b.y);
      if (maxPts > 0 && subs >= maxPts) {
        return { caught: 0, endStep: step, subs, rim, bank, swish: false, off: 0, x: b.x, y: b.y };
      }
    }
    if (b.y > deathY) {
      return { caught: 0, endStep: step, subs, rim, bank, swish: false, off: 0, x: b.x, y: b.y };
    }
  }
  return { caught: 0, endStep: startStep + MAX_FLIGHT_STEPS, subs, rim, bank, swish: false, off: 0, x: b.x, y: b.y };
}

function launch(sim, vx, vy, step, pts) {
  const f = flight(sim, vx, vy, step, pts, 0);
  sim.shots += 1;
  sim.lastStep = step;
  sim.flying = f;
  const gap = step - sim.clockAnchor;
  sim.gapN += 1;
  sim.gapSum += gap;
  sim.gapSum2 += gap * gap;
  return f;
}

// Bring the world up to `step`: resolve a landing that is due, then test the
// shot clock. Only ever called with a step that does not go backwards.
function advanceTo(sim, step) {
  if (sim.dead) return;
  if (sim.flying && step >= sim.flying.endStep) {
    const f = sim.flying;
    sim.flying = null;
    sim.rimHits += f.rim;
    if (f.caught === 2) {
      sim.streak = f.swish ? sim.streak + 1 : 0;
      let g = f.swish ? 1 + (sim.streak < PERFECT_CAP ? sim.streak : PERFECT_CAP) : 1;
      if (f.bank > 0) g = g * BANK_MULT;
      sim.score += g;
      sim.gained = g;
      sim.n += 1;
      sim.cur = sim.nxt;
      sim.nxt = makeHoop(sim, sim.n + 1, sim.cur.by);
      sim.catches += 1;
      sim.offSum += f.off;
      sim.offSum2 += f.off * f.off;
      if (f.swish) sim.swishes += 1;
      if (sim.streak > sim.bestStreak) sim.bestStreak = sim.streak;
      if (f.bank > 0) sim.banks += 1;
      sim.clockAnchor = f.endStep;
    } else if (f.caught === 1) {
      sim.streak = 0;
      sim.gained = 0;
      sim.fallBacks += 1;
      sim.clockAnchor = f.endStep;
    } else {
      sim.dead = true;
      sim.deadStep = f.endStep;
      return;
    }
  }
  if (!sim.flying && step >= sim.clockAnchor + shotSteps(sim.score)) {
    sim.dead = true;
    sim.deadStep = sim.clockAnchor + shotSteps(sim.score);
  }
}

function validVector(vx, vy) {
  if (!Number.isInteger(vx) || !Number.isInteger(vy)) return false;
  if (vx < -POWER_MAX || vx > POWER_MAX || vy < -POWER_MAX || vy > POWER_MAX) return false;
  const m2 = vx * vx + vy * vy;
  return m2 >= POWER_MIN * POWER_MIN && m2 <= POWER_MAX * POWER_MAX;
}

function validSeed(seed) {
  return typeof seed === 'string' && /^[0-9a-fA-F]{16,}$/.test(seed);
}

function initSim(seed) {
  if (!validSeed(seed)) return null;
  const sim = {
    seedA: parseInt(seed.slice(0, 8), 16) >>> 0,
    seedB: parseInt(seed.slice(8, 16), 16) >>> 0,
    n: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
    shots: 0,
    catches: 0,
    swishes: 0,
    banks: 0,
    fallBacks: 0,
    rimHits: 0,
    gained: 0,
    cur: null,
    nxt: null,
    flying: null,
    clockAnchor: 0,
    lastStep: 0,
    deadStep: 0,
    dead: false,
    offSum: 0,
    offSum2: 0,
    gapN: 0,
    gapSum: 0,
    gapSum2: 0,
  };
  sim.cur = makeHoop(sim, 0, 0);
  sim.nxt = makeHoop(sim, 1, sim.cur.by);
  return sim;
}

// A step cap on the replay, pinned to the session lifetime by
// shared/tests/sessionLifetime.test.js. A session lives one hour; this sits a
// little past it so no honest run is ever refused by it. A shot stamped past
// it is refused, never the run.
const MAX_SIM_STEPS = STEP_FPS * 3900;

// WORK bound, not a scoring one: it refuses further events rather than zeroing
// the run. A shot costs at least a short flight plus a human aim, so an hour is
// a few thousand shots at most; this sits an order of magnitude past that.
const MAX_EVENTS = 60000;

const DEFAULTS = { maxEvents: MAX_EVENTS };

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
    // Aim telemetry, straight off the payload. Raw material for the bot
    // detector: recorded, never gated, never allowed near the score.
    aim: { n: 0, durSum: 0, durSum2: 0, revSum: 0, revSum2: 0, lenSum: 0, lenSum2: 0 },
    powers: new Map(),
  };
}

function reject(state, reason) {
  // A refused shot still happened on the client, so the worlds have diverged
  // and a later clean shot is no longer known to follow one. Carrying the
  // perfect streak across that gap would credit a bigger multiplier than the
  // game gave. Breaking it can only lower the score, the safe direction.
  if (state.sim) state.sim.streak = 0;
  state.rejectCount++;
  return { accepted: false, newScore: state.score, reason };
}

function recordAim(state, p) {
  const a = p && typeof p.a === 'object' && p.a ? p.a : null;
  if (!a) return;
  const dur = Number(a.dur);
  const rev = Number(a.rev);
  const len = Number(a.len);
  if (!Number.isFinite(dur) || !Number.isFinite(rev) || !Number.isFinite(len)) return;
  const s = state.aim;
  s.n += 1;
  s.durSum += dur; s.durSum2 += dur * dur;
  s.revSum += rev; s.revSum2 += rev * rev;
  s.lenSum += len; s.lenSum2 += len * len;
}

function processEvent(state, event) {
  if (!event || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};

  if (p.kind === 'start') {
    if (Number(p.v) >= RULES_VERSION && !state.sim) {
      const sim = initSim(state.seed);
      if (sim) { state.sim = sim; state.mode = 'sim'; }
    }
    return { accepted: true, newScore: state.score };
  }
  if (p.kind !== 'shot') return { accepted: true, newScore: state.score };

  const sim = state.sim;
  if (!sim) return reject(state, 'no_replay');
  if (state.events >= state.tunables.maxEvents) return reject(state, 'event_cap');
  state.events += 1;

  // typeof FIRST: Number(null) is 0, so a coerced field would silently apply.
  const n = p.n;
  const step = p.step;
  const vx = p.vx;
  const vy = p.vy;
  if (typeof n !== 'number' || typeof step !== 'number') return reject(state, 'malformed');
  if (!Number.isInteger(n) || !Number.isInteger(step)) return reject(state, 'malformed');
  if (n !== sim.shots) return reject(state, 'out_of_order');
  if (step < sim.lastStep) return reject(state, 'step_order');
  if (step > MAX_SIM_STEPS) return reject(state, 'step_cap');
  if (typeof vx !== 'number' || typeof vy !== 'number') return reject(state, 'malformed');
  if (!validVector(vx, vy)) return reject(state, 'bad_vector');

  advanceTo(sim, step);
  if (sim.dead) return reject(state, 'dead');
  if (sim.flying) return reject(state, 'still_flying');

  recordAim(state, p);
  const m2 = vx * vx + vy * vy;
  state.powers.set(m2, (state.powers.get(m2) || 0) + 1);
  launch(sim, vx, vy, step, null);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

function mean(sum, n) { return n > 0 ? sum / n : null; }

function sd(sum, sum2, n) {
  if (n < 2) return null;
  const v = sum2 / n - (sum / n) * (sum / n);
  return v > 0 ? Math.sqrt(v) : 0;
}

function round(v, d) {
  if (v === null || !Number.isFinite(v)) return null;
  const k = Math.pow(10, d === undefined ? 3 : d);
  return Math.round(v * k) / k;
}

function finalize(state) {
  const sim = state.sim;
  if (!sim) {
    return {
      score: 0, gameOver: false, unscorable: true, suspicious: null,
      debug: { mode: 'none', rejects: state.rejectCount },
    };
  }
  // Run-out: a run that stops shooting dies on its shot clock, and a flight
  // still in the air lands. Neither can raise a score the trace did not
  // already earn, and it is still bounded by the session's real length.
  const cap = elapsedCap(state, STEP_FPS);
  const until = cap < MAX_SIM_STEPS ? cap : MAX_SIM_STEPS;
  if (!sim.dead && until >= sim.lastStep) advanceTo(sim, until);

  const a = state.aim;
  let topPower = 0;
  for (const c of state.powers.values()) if (c > topPower) topPower = c;

  return {
    score: sim.score,
    gameOver: sim.dead,
    suspicious: state.rejectCount >= 5 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim',
      score: sim.score,
      shots: sim.shots,
      catches: sim.catches,
      fallBacks: sim.fallBacks,
      rimHits: sim.rimHits,
      banks: sim.banks,
      swishes: sim.swishes,
      // A bot that never touches a rim, or one whose entry is always dead
      // centre, looks nothing like a hand. Recorded, never gated.
      swishRate: sim.catches > 0 ? round(sim.swishes / sim.catches) : null,
      bestSwishStreak: sim.bestStreak,
      entryOffMean: sim.catches > 0 ? round(mean(sim.offSum, sim.catches) / Q, 2) : null,
      entryOffSd: sim.catches > 1 ? round(sd(sim.offSum, sim.offSum2, sim.catches) / Q, 2) : null,
      // Steps between the ball landing and the next shot leaving.
      gapMean: round(mean(sim.gapSum, sim.gapN), 2),
      gapSd: round(sd(sim.gapSum, sim.gapSum2, sim.gapN), 2),
      aimDurMean: round(mean(a.durSum, a.n), 2),
      aimDurSd: round(sd(a.durSum, a.durSum2, a.n), 2),
      aimRevMean: round(mean(a.revSum, a.n), 2),
      aimRevSd: round(sd(a.revSum, a.revSum2, a.n), 2),
      aimLenMean: round(mean(a.lenSum, a.n), 2),
      aimLenSd: round(sd(a.lenSum, a.lenSum2, a.n), 2),
      // A hand does not fire the identical power twice by accident.
      equalPowerShare: sim.shots > 0 ? round(topPower / sim.shots) : null,
      dead: sim.dead,
      lastStep: sim.lastStep,
      rejects: state.rejectCount,
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
    initSim, makeHoop, hoopX, hoopY, flight, launch, advanceTo, catchOff, rimBounce, tri,
    scaleI, shotSteps, validVector, validSeed, mix, elapsedCap,
    RULES_VERSION, DESIGN_W, DESIGN_H, CENTRE_X, Q, SUB, STEP_FPS, BALL_R, RIM_R, GRAV, VY_MAX,
    VX_MAX, WALL_NUM, WALL_DEN, RIM_NUM, RIM_DEN, NSCALE, POWER_MIN, POWER_MAX, START_Y,
    FALL_MARGIN, MAX_FLIGHT_STEPS, NO_CATCH, STAY_PCT, X_OFF_MIN, X_OFF_SPAN, EDGE_PAD,
    RISE_BASE, RISE_SPAN, RISE_EVERY, RISE_GROW, RISE_GROW_CAP, HW_START, HW_EVERY, HW_FLOOR,
    HW_JIT_SPAN, MOVE_FROM, MOVE_H_PCT, MOVE_V_PCT, MOVE_RAMP_EVERY, MOVE_RAMP_CAP,
    MOVE_AMP_H_MIN, MOVE_AMP_H_SPAN, MOVE_AMP_H_GROW, MOVE_AMP_H_CAP, MOVE_AMP_V_MIN,
    MOVE_AMP_V_SPAN, MOVE_AMP_V_GROW, MOVE_AMP_V_CAP, MOVE_PER_MAX, MOVE_PER_SPAN,
    MOVE_PER_SHRINK, MOVE_PER_MIN, MOVE_PHASE_SPAN, PERFECT_CAP, BANK_MULT, SHOT_START,
    SHOT_FLOOR, SHOT_SCORE_STEP, SHOT_SHRINK, MAX_SIM_STEPS, MAX_EVENTS,
  },
};
