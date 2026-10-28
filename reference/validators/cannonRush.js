'use strict';

/**
 * Cannon Rush validator: SERVER-SIDE DETERMINISTIC REPLAY (trace v2), with the
 * pre-replay bounds path (v1) kept for the rollout.
 *
 * The cannon fires by itself; the player's only input is WHERE the cannon is.
 * The rules below are one block, carried WORD FOR WORD here and in
 * games/cannon-rush/js/game.js. shared/tests/cannonRushParity.test.js pulls
 * the block out of both files and fails on any difference, and golden runs
 * pin the rules so a change made in BOTH files cannot pass either. A gameplay
 * change is a trace version bump, never an edit in place.
 *
 * Trace v2:
 *   { kind: 'start', v: 2 }
 *   { kind: 'path', f, x: [q, ...] }  q = cannon target x * 16 (integer,
 *        0..11520) during step f+1+i. POSITIONAL and dense, applied whole or
 *        refused whole, at most PATH_BATCH_MAX long. A step with no sample
 *        leaves the cannon where it is.
 * Steps never go backwards and batches never overlap. Steps 1..192 are the
 * 3-2-1 countdown (the cannon may move, nothing else does).
 *
 * Every spawn is a pure function of (seed, wave index); power-ups are a fixed
 * rotation on a fixed step timer. Arithmetic is +, -, x, /, Math.sqrt, floor,
 * round, min, max, abs and integer bit operations only (IEEE 754 exact in every
 * engine), so no DMath is needed; the parity suite asserts it. The difficulty
 * curve's t^1.35 is built from square roots (pow135).
 *
 * v1 (no start marker): the old bounds checker over client-reported `score`
 * events, byte-for-byte the same scoring, so a cached pre-replay client is
 * scored as before during the rollout. It reports no replay mode, so
 * submitSession's legacy_trace refusal does not fire for it. Once the drain is
 * measured at zero, report debug.mode 'v1' from finalizeV1 to refuse it.
 */

// ─────────────────────────────────────────────────────────────────────────
// v1: the pre-replay bounds checker (unchanged scoring)
// ─────────────────────────────────────────────────────────────────────────

// Largest legitimate single score event is the +500 wave-clear bonus; a big
// ball pop tops out near 480. 600 covers every single-event increment with
// headroom while still blocking a tampered "+100000" claim.
// Set from production: across 742 unflagged human cannon-rush sessions the
// event rate maxes at 12.44/sec and points-per-event at 30.00. The old pair
// (600 x 60) permitted 36,000 points/sec: no limit in practice.
// Derived from the game's own scoring, which is the authoritative answer for a
// SINGLE event (games/cannon-rush/js/game.js):
//     wave clear  = 150
//     ball pop    = b.size * 30, and pickBallSize caps size at 4  -> 120
//     damage hit  = damage * 3, damage is 1                       ->   3
// So 150 is the most one event can legitimately be worth. 200 keeps 33%
// headroom over that hard maximum.
//
// NOTE: do NOT set this from score/last_seq in the session data. That is the
// MEAN points per event over a session (30.00 at most), not the maximum single
// award: reading it as a per-event bound would have clipped every wave clear.
const MAX_POINTS_PER_EVENT = 200;
const MAX_EVENTS_PER_SEC   = 30;    // 2.4x the observed maximum of 12.44
const HARD_EVENT_CAP       = 30000; // marathon-run backstop
const RATE_WINDOW_MS       = 1000;

function initV1({ maxDurationSecs } = {}) {
  return {
    score: 0,
    events: 0,
    lastT: null,
    rateWindow: [],
    rejectCount: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 600,
    // HUD-snapshot self-correction (identical pattern to epicSlicer.js). The
    // game emits its cumulative `score` as payload.scoreAfter on every scoring
    // moment; finalize() returns max(accumulated, maxScoreAfter). Per-event
    // delta is bounded by MAX_POINTS_PER_EVENT so scoreAfter can't inflate.
    lastScoreAfter: 0,
    maxScoreAfter: 0,
  };
}

function processEventV1(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};
  if (payload.kind !== 'score') {
    return { accepted: true, newScore: state.score };
  }

  const tHint = Number(payload.tHint);
  if (!Number.isFinite(tHint) || tHint < 0) {
    state.rejectCount++;
    return { accepted: true, newScore: state.score, reason: 'bad_thint' };
  }

  // HUD-snapshot recording: BEFORE any rejection so rate-capped events still
  // feed the recovery ledger. Bounded to MAX_POINTS_PER_EVENT per event.
  const scoreAfterRaw = Number(payload.scoreAfter);
  if (Number.isFinite(scoreAfterRaw) && scoreAfterRaw >= 0) {
    const delta = scoreAfterRaw - state.lastScoreAfter;
    if (delta >= 0 && delta <= MAX_POINTS_PER_EVENT) {
      state.lastScoreAfter = scoreAfterRaw;
      if (scoreAfterRaw > state.maxScoreAfter) state.maxScoreAfter = scoreAfterRaw;
    }
  }

  if (state.events >= HARD_EVENT_CAP) {
    state.dead = true;
    return { accepted: false, newScore: state.score, reason: 'hard_cap' };
  }

  // Rolling rate cap over the last second.
  const refT = state.lastT !== null ? Math.max(tHint, state.lastT) : tHint;
  state.rateWindow = state.rateWindow.filter((t) => refT - t < RATE_WINDOW_MS);
  if (state.rateWindow.length >= MAX_EVENTS_PER_SEC) {
    state.rejectCount++;
    return { accepted: true, newScore: state.score, reason: 'rate_cap' };
  }
  state.rateWindow.push(refT);

  // Accumulate the reported delta, capped per event.
  let points = Number(payload.pointsHit);
  if (!Number.isFinite(points) || points < 0) points = 0;
  points = Math.min(Math.floor(points), MAX_POINTS_PER_EVENT);

  state.score += points;
  state.events += 1;
  state.lastT = state.lastT === null ? tHint : Math.max(tHint, state.lastT);
  return { accepted: true, newScore: state.score };
}

function finalizeV1(state) {
  const accumulated = state.score;
  const hudSnapshot = state.maxScoreAfter || 0;
  return {
    // Authoritative = max(accumulated, HUD snapshot). The session ceiling
    // check (max_score_per_sec × duration) runs on whatever we return.
    score: Math.max(accumulated, hudSnapshot),
    gameOver: state.dead || accumulated > 0 || hudSnapshot > 0,
    suspicious: state.rejectCount >= 8 ? `validator_rejects:${state.rejectCount}` : null,
    debug: { path: 'bounds', accumulated, hudSnapshot, diff: hudSnapshot - accumulated },
  };
}


// ─────────────────────────────────────────────────────────────────────────
// v2: deterministic replay
// ─────────────────────────────────────────────────────────────────────────

  // ==== RULES BLOCK: identical in shared/anticheat/validators/cannonRush.js ====
  function cannonRushCore() {
    'use strict';
    const W = 720;
    const DT = 1 / 60;
    const PLATFORM_Y = 1070;
    const CEIL_Y = 120;
    const WALL = 35;
    const PLAYER_Y = 1028;
    const PLAYER_W = 149;
    const PLAYER_H = 101;
    const X_MIN = PLAYER_W / 2;
    const X_MAX = W - PLAYER_W / 2;
    const X_QUANT = 16;
    const Q_MAX = W * X_QUANT;
    const MUZZLE_DY = 63;
    const COUNTDOWN_STEPS = 192;
    const GRAVITY = 420;
    const SLOW_FACTOR = 0.45;
    const BALL_BOUNCE_SPEED = [0, 610, 690, 770, 850];
    const BALL_R = [0, 28, 45, 66, 88];
    const BALL_BASE_HP = [0, 3, 6, 10, 16];
    const COLOR_COUNT = 7;
    const BORN_RATE = 3.2;
    const BORN_HITTABLE = 0.35;
    const BORN_DEADLY = 0.45;
    const SHOT_TOP = 70;
    const MAX_PISTOL_SHOTS = 42;
    const PISTOL_VY = -2400;
    const BULLET_VY = -2150;
    const NORMAL_VY = -2100;
    const COOL_PISTOL = 3;
    const COOL_BULLET = 4;
    const COOL_NORMAL = 5;
    const MAX_BULLET_SHOTS = 14;
    const MAX_NORMAL_SHOTS = 10;
    const HIT_POINTS = 3;
    const POP_POINTS = 30;
    const WAVE_BONUS = 150;
    const CHILD_OFFSET = 15;
    const CHILD_VY = -315;
    const CHILD_VX_MUL = 1.08;
    const CHILD_HP_MUL = 0.48;
    const CHILD_BORN = 0.2;
    const POWERUP_CYCLE = ['bullet', 'pistol', 'slow', 'shield'];
    const POWERUP_X_PATTERN = [0.22, 0.78, 0.50, 0.68, 0.32];
    const POWERUP_FIRST_STEPS = 360;
    const POWERUP_EVERY_STEPS = 480;
    const POWERUP_DURATION_STEPS = 300;
    const POWERUP_VY = 170;
    const POWERUP_Y0 = -40;
    const POWERUP_CATCH_X = 48;
    const POWERUP_CATCH_Y = 62;

    function mulberry32(a) {
      return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function seedInt(seed) {
      const s = typeof seed === 'string' ? seed : '';
      if (!/^[0-9a-fA-F]{8,}$/.test(s)) return 0;
      return (parseInt(s.slice(0, 8), 16) ^ Math.imul(parseInt(s.slice(8, 16) || '0', 16), 0x85EBCA6B)) >>> 0;
    }
    // Wave N draws from its own stream: a pure function of (seed, N).
    function waveRng(si, n) {
      return mulberry32((si ^ Math.imul(n + 1, 0x9E3779B1)) >>> 0);
    }
    // u^1.35 from square roots only (IEEE 754 exact in every engine):
    // 0.35 ~= 1/4 + 1/16 + 1/32 + 1/256 + 1/512 + 1/4096 + 1/8192.
    function pow135(u) {
      if (!(u > 0)) return 0;
      const r = [u];
      for (let k = 1; k <= 13; k++) r.push(Math.sqrt(r[k - 1]));
      return u * r[2] * r[4] * r[5] * r[8] * r[9] * r[12] * r[13];
    }
    function difficultyAt(play) {
      const t = play / 60;
      return 1 + t / 42 + pow135(t / 110);
    }
    function clampX(x) {
      return x < X_MIN ? X_MIN : x > X_MAX ? X_MAX : x;
    }
    function ballHealth(size, difficulty) {
      return Math.max(1, Math.round(BALL_BASE_HP[size] + difficulty * size * 1.4));
    }
    function pickBallSize(index, difficulty, rand) {
      const canHuge = difficulty > 3.4;
      const canLarge = difficulty > 1.8;
      if (canHuge && index % 5 === 0 && rand() < Math.min(0.35, (difficulty - 3.2) * 0.12)) return 4;
      if (canLarge && index % 3 === 0) return 3;
      return index % 3 === 0 ? 2 : index % 3 === 1 ? 1 : 3;
    }
    function spawnWave(s) {
      const rand = waveRng(s.si, s.wave);
      const d = s.difficulty;
      const count = Math.min(10, 3 + Math.floor(d * 0.72));
      const speedBoost = Math.min(210, d * 20);
      const out = s.balls.slice();
      let id = s.nextId;
      for (let i = 0; i < count; i++) {
        const size = pickBallSize(i, d, rand);
        const hp = ballHealth(size, d);
        const x = 80 + rand() * 560;
        const y = 180 + rand() * 520;
        const c = Math.floor(rand() * COLOR_COUNT);
        const vx = (rand() < 0.5 ? -1 : 1) * (100 + rand() * 90 + speedBoost);
        const vy = -135 - rand() * 165 - Math.min(150, d * 9);
        const angle = rand() * Math.PI * 2;
        const spin = (rand() < 0.5 ? -1 : 1) * (0.7 + rand() * 1.3);
        out.push({ id: id++, x, y, r: BALL_R[size], size, hp, maxHp: hp, c, vx, vy, angle, spin, born: 0, hitPulse: 0 });
      }
      s.balls = out;
      s.nextId = id;
      s.wave = s.wave + 1;
    }
    function create(seed) {
      const s = {
        si: seedInt(seed), steps: 0, play: 0, x: W / 2, difficulty: 1,
        score: 0, wave: 0, nextId: 1, cool: 0,
        shield: 0, bullet: 0, pistol: 0, slow: 0,
        powerupIndex: 0, balls: [], shots: [], powerups: [],
        dead: false, deathStep: null, events: [],
      };
      spawnWave(s);
      return s;
    }
    function nextPowerupAt(s) {
      return POWERUP_FIRST_STEPS + s.powerupIndex * POWERUP_EVERY_STEPS;
    }
    // One fixed step. `q` is where the player wants the cannon this step, in
    // 1/16 design units, or null (the cannon stays where it is). Returns a NEW
    // state; the old one is never written.
    function step(p, q) {
      const s = Object.assign({}, p);
      s.events = [];
      s.steps = p.steps + 1;
      if (q !== null && q !== undefined) s.x = clampX(q / X_QUANT);
      if (s.steps <= COUNTDOWN_STEPS) return s;
      s.play = p.play + 1;
      s.difficulty = difficultyAt(s.play);
      s.cool = Math.max(0, p.cool - 1);
      s.shield = Math.max(0, p.shield - 1);
      s.bullet = Math.max(0, p.bullet - 1);
      s.pistol = Math.max(0, p.pistol - 1);
      s.slow = Math.max(0, p.slow - 1);

      // Fire, before anything moves (as the game always has).
      let shots = p.shots.slice();
      if (s.cool <= 0) {
        let pistolShots = 0;
        for (let i = 0; i < shots.length; i++) if (shots[i].pistol) pistolShots++;
        const my = PLAYER_Y - MUZZLE_DY;
        if (s.pistol > 0 && pistolShots <= MAX_PISTOL_SHOTS - 3) {
          shots.push({ x: s.x - 16, y: my, vy: PISTOL_VY, r: 9, pistol: true, damage: 1 });
          shots.push({ x: s.x, y: my, vy: PISTOL_VY, r: 9, pistol: true, damage: 1 });
          shots.push({ x: s.x + 16, y: my, vy: PISTOL_VY, r: 9, pistol: true, damage: 1 });
          s.cool = COOL_PISTOL;
          s.events.push({ k: 'fire', t: 'pistol' });
        } else if (s.bullet > 0 && shots.length < MAX_BULLET_SHOTS) {
          shots.push({ x: s.x - 12, y: my, vy: BULLET_VY, r: 10, pistol: false, damage: 1 });
          shots.push({ x: s.x + 12, y: my, vy: BULLET_VY, r: 10, pistol: false, damage: 1 });
          s.cool = COOL_BULLET;
          s.events.push({ k: 'fire', t: 'bullet' });
        } else if (shots.length < MAX_NORMAL_SHOTS) {
          shots.push({ x: s.x, y: my, vy: NORMAL_VY, r: 10, pistol: false, damage: 1 });
          s.cool = COOL_NORMAL;
          s.events.push({ k: 'fire', t: 'normal' });
        }
      }
      shots = shots.map((o) => ({ x: o.x, y: o.y + o.vy * DT, vy: o.vy, r: o.r, pistol: o.pistol, damage: o.damage }));
      const shotDead = shots.map((o) => o.y < SHOT_TOP);

      // Balls move, bounce, and may reach the cannon.
      const bdt = s.slow > 0 ? DT * SLOW_FACTOR : DT;
      const balls = [];
      const px = s.x;
      const py = PLAYER_Y - 28;
      for (let i = 0; i < p.balls.length; i++) {
        const o = p.balls[i];
        const b = Object.assign({}, o);
        b.born = Math.min(1, o.born + DT * BORN_RATE);
        b.hitPulse = Math.max(0, o.hitPulse - DT * 8);
        b.vy = o.vy + GRAVITY * bdt;
        b.x = o.x + o.vx * bdt;
        b.y = o.y + b.vy * bdt;
        b.angle = o.angle + (o.spin + o.vx * 0.0025) * bdt;
        if (b.x - b.r < WALL) { b.x = WALL + b.r; b.vx = Math.abs(b.vx); }
        if (b.x + b.r > W - WALL) { b.x = W - WALL - b.r; b.vx = -Math.abs(b.vx); }
        if (b.y + b.r > PLATFORM_Y) {
          if (b.size > 1 && b.vy > 140 && b.born > BORN_DEADLY) s.events.push({ k: 'bounce', size: b.size });
          b.y = PLATFORM_Y - b.r;
          b.vy = -BALL_BOUNCE_SPEED[b.size];
        }
        if (b.y - b.r < CEIL_Y) { b.y = CEIL_Y + b.r; b.vy = Math.abs(b.vy); }
        balls.push(b);
        if (b.born < BORN_DEADLY) continue;
        const hitW = b.r + PLAYER_W * 0.42;
        const hitH = b.r + PLAYER_H * 0.35;
        const dx = b.x - px;
        const dy = b.y - py;
        if (dx * dx < hitW * hitW && dy * dy < hitH * hitH) {
          if (s.shield > 0) {
            s.events.push({ k: 'shield' });
          } else {
            for (let j = i + 1; j < p.balls.length; j++) balls.push(p.balls[j]);
            s.balls = balls.filter((x) => x !== b);
            s.shots = [];
            s.powerups = [];
            s.dead = true;
            s.deathStep = s.steps;
            s.events.push({ k: 'crash', x: s.x });
            return s;
          }
        }
      }

      // Shots strike balls, last ball first. A popped ball splits in two.
      let score = p.score;
      let nextId = p.nextId;
      for (let i = balls.length - 1; i >= 0; i--) {
        const b = balls[i];
        if (b.born < BORN_HITTABLE) continue;
        let strike = -1;
        for (let j = 0; j < shots.length; j++) {
          const o = shots[j];
          const dx = b.x - o.x;
          const dy = b.y - o.y;
          const rr = b.r + o.r;
          if (dx * dx + dy * dy < rr * rr) { strike = j; break; }
        }
        if (strike < 0) continue;
        shotDead[strike] = true;
        const dmg = shots[strike].damage;
        b.hp = b.hp - dmg;
        b.hitPulse = 1;
        score += HIT_POINTS * dmg;
        s.events.push({ k: 'hit', x: b.x, y: b.y, r: b.r, c: b.c, size: b.size, dmg });
        if (b.hp > 0) continue;
        balls.splice(i, 1);
        score += b.size * POP_POINTS;
        s.events.push({ k: 'pop', x: b.x, y: b.y, r: b.r, c: b.c, size: b.size });
        if (b.size > 1) {
          const ns = b.size - 1;
          const hp = Math.max(1, Math.round(b.maxHp * CHILD_HP_MUL));
          const spin = Math.abs(b.spin || 1.2);
          balls.push({ id: nextId++, x: b.x - CHILD_OFFSET, y: b.y, r: BALL_R[ns], size: ns, hp, maxHp: hp, c: b.c, vx: -Math.abs(b.vx) * CHILD_VX_MUL, vy: CHILD_VY, angle: b.angle, spin: -spin, born: CHILD_BORN, hitPulse: 0 });
          balls.push({ id: nextId++, x: b.x + CHILD_OFFSET, y: b.y, r: BALL_R[ns], size: ns, hp, maxHp: hp, c: b.c, vx: Math.abs(b.vx) * CHILD_VX_MUL, vy: CHILD_VY, angle: b.angle, spin, born: CHILD_BORN, hitPulse: 0 });
        }
      }
      s.shots = shots.filter((o, j) => !shotDead[j]);
      s.balls = balls;
      s.nextId = nextId;

      // Power-ups: a fixed rotation on a fixed timer at fixed places.
      let pups = p.powerups.slice();
      while (s.play >= nextPowerupAt(s)) {
        const n = s.powerupIndex;
        pups.push({ id: s.nextId, x: W * POWERUP_X_PATTERN[n % POWERUP_X_PATTERN.length], y: POWERUP_Y0, vy: POWERUP_VY, spin: 0, type: POWERUP_CYCLE[n % POWERUP_CYCLE.length] });
        s.nextId = s.nextId + 1;
        s.powerupIndex = n + 1;
        s.events.push({ k: 'release' });
      }
      const kept = [];
      for (let i = 0; i < pups.length; i++) {
        const o = pups[i];
        const u = { id: o.id, x: o.x, y: o.y + o.vy * DT, vy: o.vy, spin: o.spin + DT * 5, type: o.type };
        if (Math.abs(u.x - s.x) < POWERUP_CATCH_X && Math.abs(u.y - (PLAYER_Y - 25)) < POWERUP_CATCH_Y) {
          if (u.type === 'bullet') s.bullet = Math.max(s.bullet, POWERUP_DURATION_STEPS);
          if (u.type === 'shield') s.shield = Math.max(s.shield, POWERUP_DURATION_STEPS);
          if (u.type === 'pistol') s.pistol = Math.max(s.pistol, POWERUP_DURATION_STEPS);
          if (u.type === 'slow') s.slow = Math.max(s.slow, POWERUP_DURATION_STEPS);
          s.events.push({ k: 'power', t: u.type });
          continue;
        }
        if (u.y > PLATFORM_Y + 40) continue;
        kept.push(u);
      }
      s.powerups = kept;

      if (s.balls.length === 0) {
        score += WAVE_BONUS;
        s.events.push({ k: 'wave' });
        s.score = score;
        spawnWave(s);
      }
      s.score = score;
      return s;
    }
    const CONST = {
      W, DT, PLATFORM_Y, CEIL_Y, WALL, PLAYER_Y, PLAYER_W, PLAYER_H, X_MIN, X_MAX, X_QUANT, Q_MAX, MUZZLE_DY,
      COUNTDOWN_STEPS, GRAVITY, SLOW_FACTOR, BALL_BOUNCE_SPEED, BALL_R, BALL_BASE_HP, COLOR_COUNT, BORN_RATE,
      BORN_HITTABLE, BORN_DEADLY, SHOT_TOP, MAX_PISTOL_SHOTS, PISTOL_VY, BULLET_VY, NORMAL_VY, COOL_PISTOL,
      COOL_BULLET, COOL_NORMAL, MAX_BULLET_SHOTS, MAX_NORMAL_SHOTS, HIT_POINTS, POP_POINTS, WAVE_BONUS,
      CHILD_OFFSET, CHILD_VY, CHILD_VX_MUL, CHILD_HP_MUL, CHILD_BORN, POWERUP_CYCLE, POWERUP_X_PATTERN,
      POWERUP_FIRST_STEPS, POWERUP_EVERY_STEPS, POWERUP_DURATION_STEPS, POWERUP_VY, POWERUP_Y0,
      POWERUP_CATCH_X, POWERUP_CATCH_Y,
    };
    return { create, step, difficultyAt, pow135, seedInt, waveRng, nextPowerupAt, clampX, CONST, VERSION: 2 };
  }
  // ==== END RULES BLOCK ====

const CORE = cannonRushCore();
const { CONST } = CORE;

const FPS = 60;
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
const MAX_SIM_STEPS = FPS * 60 * 60;
const PATH_BATCH_MAX = 120;
// One sample per step for the whole hour. REFUSES further inputs, never zeroes.
const MAX_INPUTS = MAX_SIM_STEPS;

function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}
function isQ(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= CONST.Q_MAX;
}

function stepOne(state) {
  const q = state.pending;
  state.pending = null;
  state.sim = CORE.step(state.sim, q);
  if (state.onStep) state.onStep(state.sim);
}

// Run every step BEFORE `step`, so the sample for `step` can still be set.
function advanceTo(state, step) {
  while (!state.sim.dead && state.sim.steps + 1 < step && state.sim.steps < MAX_SIM_STEPS) stepOne(state);
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    version: null,
    seed: typeof seed === 'string' ? seed : null,
    sim: null,
    pending: null,
    lastSampleStep: 0,
    inputCount: 0,
    rejectCount: 0,
    score: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    v1: initV1({ maxDurationSecs }),
    // Raw material for the bot fingerprint, recorded and never gated.
    moves: 0,
    travel: 0,
    lastQ: null,
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function deadResult(state) {
  state.dead = true;
  state.score = state.sim.score;
  return { accepted: false, newScore: state.score, reason: 'dead' };
}

function processEvent(state, event) {
  if (state.mode === 'sim' && state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};
  const kind = payload.kind;
  if (kind === 'start') {
    if (payload.v === 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.version = 2;
      state.sim = CORE.create(state.seed == null ? '' : state.seed);
    }
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim') {
    const r = processEventV1(state.v1, event);
    state.score = state.v1.score;
    return r;
  }
  if (kind === 'path') return processPath(state, payload);
  return { accepted: true, newScore: state.score };
}

// { kind: 'path', f, x: [...] }: x[i] is the cannon target during step
// f+1+i. Validated whole before any of it is applied.
function processPath(state, payload) {
  const f = payload.f;
  const xs = payload.x;
  if (!isStep(f) || !Array.isArray(xs) || xs.length === 0 || xs.length > PATH_BATCH_MAX) {
    return reject(state, 'bad_batch');
  }
  const sim = state.sim;
  // Never rewind, never overlap: a rewind would let an attacker re-run a
  // window and keep the best outcome.
  if (f + 1 < sim.steps + 1 || f + 1 <= state.lastSampleStep) return reject(state, 'frame_regressed');
  if (f + xs.length > MAX_SIM_STEPS) return reject(state, 'bad_batch');
  for (let i = 0; i < xs.length; i++) if (!isQ(xs[i])) return reject(state, 'bad_sample');
  if (state.inputCount + xs.length > MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount += xs.length;
  state.lastSampleStep = f + xs.length;
  for (let i = 0; i < xs.length; i++) {
    advanceTo(state, f + 1 + i);
    if (state.sim.dead || state.sim.steps >= MAX_SIM_STEPS) break;
    const q = xs[i];
    state.pending = q;
    if (q !== state.lastQ) {
      if (state.lastQ !== null) { state.moves++; state.travel += Math.abs(q - state.lastQ); }
      state.lastQ = q;
    }
  }
  if (state.sim.dead) return deadResult(state);
  state.score = state.sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always dies inside this bound. Only
// the submit replay passes elapsedSecs; the live stream keeps the session bound.
function elapsedCap(state, fps) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * fps);
}

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return finalizeV1(state.v1);
  // Run the world out past the last sample with the cannon parked where the
  // trace left it. Balls always reach a parked cannon (the parity suite
  // measures how soon); the elapsed cap and the session bound stop the rest.
  const runOut = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * FPS));
  const cap = elapsedCap(state, FPS);
  let guard = 0;
  while (!state.sim.dead && guard < runOut && state.sim.steps < cap && state.sim.steps < MAX_SIM_STEPS) {
    stepOne(state);
    guard++;
  }
  const sim = state.sim;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', version: state.version, steps: sim.steps,
      deathStep: sim.dead ? sim.deathStep : null, dead: sim.dead,
      score: sim.score, waves: sim.wave, inputs: state.inputCount, rejects: state.rejectCount,
      // Not gated. Raw material for the bot fingerprint.
      moves: state.moves, travel: state.travel,
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
  _internal: { MAX_POINTS_PER_EVENT, MAX_EVENTS_PER_SEC, HARD_EVENT_CAP },
  _sim: { CORE, cannonRushCore, advanceTo, stepOne, isStep, isQ, elapsedCap, MAX_SIM_STEPS, PATH_BATCH_MAX, MAX_INPUTS, FPS },
};
