'use strict';

/**
 * Sky Tower validator — server-side deterministic REPLAY (v2), with a legacy
 * count-drops fallback (v1) for rollout safety.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY REPLAY
 * ─────────────────────────────────────────────────────────────────────────
 * A signed event only ever proved "this came from a real session", never "a
 * human played". A beta tester posted 450 with a script that signed forged
 * `drop` events perfectly. The only defence that survives that is to stop
 * TRUSTING the score and instead COMPUTE it: replay the player's inputs
 * through the actual game and see what they really score.
 *
 * Sky Tower is the ideal first game: it has ZERO gameplay randomness (the one
 * historical Math.random for entry-side was removed — see game.js), so the
 * entire run is a deterministic function of the sequence of TAP TIMESTAMPS.
 * No seed is needed. Given when each tap happened, the server reconstructs
 * where the sweeping block was at that instant, whether it overlapped the
 * tower, how much got trimmed, and therefore the score and the game-over point.
 *
 * The block position is a closed-form triangle sweep of GAME-TIME — NOT
 * frame-delta accumulation. game.js was refactored to drive the block (and,
 * critically, the placement at the tap instant) from the identical closed
 * form, so the client the player sees and the server that scores them compute
 * bit-identical positions. `skyTowerParity.test.js` pins that equivalence.
 *
 * A forger who sends taps at arbitrary times gets whatever position the sweep
 * yields at those times — random taps miss within a few drops and the run
 * game-overs at ≈0. To score, an attacker must send taps at the real instants
 * the block is actually over the tower — i.e. write a real-time bot that
 * reimplements the game. That is a categorically harder attack than "post a
 * number", it cannot farm faster than real time, and a perfect-every-drop run
 * is a statistical outlier the timing fingerprint + payout review catch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ROLLOUT SAFETY (deploy skew)
 * ─────────────────────────────────────────────────────────────────────────
 * The backend deploys before the frontend. During that window a NEW server
 * would be replaying traces from an OLD client that doesn't emit the v2 `start`
 * marker. Re-scoring those under the strict simulator would zero honest
 * players — the exact deploy-skew hazard the platform has been burned by.
 *
 * So the validator stays in LEGACY mode (the old count-drops + HUD-snapshot
 * behaviour, byte-for-byte) unless the trace opens with a v2 `start` event.
 * Only v2 traces run the simulator. Once the game is fully deployed every
 * trace is v2 and the legacy path is dead weight (removable later).
 *
 * The whole thing is exposed through the same init/processEvent/finalize/
 * simulate interface the submit path already drives.
 */

// ── constants — MIRROR games/sky-tower/js/game.js EXACTLY ────────────
// If any of these drift from the game, honest placements stop matching the
// server and real players get mis-scored. skyTowerParity.test.js guards it.
const TRAVEL              = 165;   // sweep half-range (units)
const PERFECT_THRESHOLD   = 4;     // |offset| <= this ⇒ perfect (dead-centre)
const PERFECT_STREAK_CAP  = 10;    // streak bonus ceiling
const BASE_SIZE           = 110;   // base block width/depth
const BASE_POS            = -55;   // base block x/y
const BLOCK_HEIGHT        = 22;    // unused in scoring, kept for reference
const V_PER_SPEED_PER_MS  = 0.065; // pos += speed*moveDir*dt*0.065  (dt in ms)
const GUIDE_DROPS         = 3;     // tutorial drops — always perfect, capped

const { mulberry32 } = require('../prng');
const SPEED_CAP_INCREMENT = 2.4;   // max the speed can climb above its base

// ── Per-session gameplay params, derived from the seed ──────────────
// The server already mints a per-session seed; the client gets the same one.
// We wobble a few constants inside a SMALL range from it — imperceptible to a
// human, but every session's perfect-tap timing is different. Client and
// server derive IDENTICALLY (IEEE-754 +,*,/ are deterministic across engines),
// so replay parity holds exactly. This kills static / hardcoded-formula bots:
// a script using the fixed 165 / 1.65 / 0.055 lands off-centre and dies. A
// seed-aware bot that reimplements this derivation can still compute it — the
// seed is on the client — so this raises the bar, it is not a silver bullet
// (see the anticheat-replay-rollout memory).
//
// MUST stay byte-identical to deriveParams() in games/sky-tower/js/game.js.
function deriveParams(seedHex) {
  const base = { travel: TRAVEL, speedBase: 1.65, speedDelta: 0.055 };
  if (typeof seedHex !== 'string' || seedHex.length < 8) return base;
  let rnd;
  try { rnd = mulberry32(seedHex); } catch (_e) { return base; }
  return {
    travel:     150 + Math.floor(rnd() * 31),                    // 150..180 (int)
    speedBase:  Math.round((1.59 + rnd() * 0.12) * 1e4) / 1e4,   // 1.59..1.71
    speedDelta: Math.round((0.051 + rnd() * 0.008) * 1e5) / 1e5, // 0.051..0.059
  };
}

// Speed ramps with how far the tower has been CLIMBED, not with the score.
//   speed = speedBase + min(placements * speedDelta, SPEED_CAP_INCREMENT)
//
// It used to key off `score`, which was fine when a drop was worth 1 point. The
// perfect-streak bonus (up to x10) and FRENZY together make the score race far
// ahead of the block count, so the cap could be reached in a handful of blocks
// and the game slammed to top speed almost immediately. Difficulty should track
// the height you've built, and bonuses should never make the game harder.
function speedForPlacements(placements, p, cap) {
  const c = typeof cap === 'number' ? cap : SPEED_CAP_INCREMENT;
  return p.speedBase + Math.min(placements * p.speedDelta, c);
}

// Fire-tile crossing time. MUST match games/sky-tower/js/game.js exactly.
function bombDurationMs(p, placements, cap) {
  const speed = speedForPlacements(placements, p, cap) * BOMB_SPEED_MULT;
  return (2 * p.travel + BOMB_EXIT_MARGIN) / (speed * V_PER_SPEED_PER_MS);
}

// How long a normal tile takes to cross from its spawn edge to the far spikes.
// Under v4 that crossing is the player's ONE chance: past it the tile breaks.
function crossMs(speed, travel) {
  return (2 * travel) / (speed * V_PER_SPEED_PER_MS);
}

// ── Bomb + Frenzy schedule ──────────────────────────────────────────
// Pure deterministic functions of (seed, blockIndex). MUST stay byte-identical
// to the copies in games/sky-tower/js/game.js.
//
// A BOMB must be let past — tapping it ends the run. Because its lifetime is a
// FIXED constant, the server can advance the block timeline across a bomb with
// NO extra event from the client: the next block spawns at exactly
// (bombSpawn + BOMB_LIFETIME_MS). Nothing new is trusted.
//
// FRENZY multiplies score by FRENZY_MULT and the sweep speed by
// FRENZY_SPEED_MULT for a run of blocks.
const BOMB_START_BLOCK   = 5;
const BOMB_WINDOW        = 7;
const BOMB_GRACE_MS      = 200;
// A fire tile crosses the screen ONCE, edge to edge, then leaves. Its lifetime
// is that crossing time — derived from the same deterministic speed/travel the
// client uses, so the server still needs NO extra event to stay in step.
const BOMB_SPEED_MULT    = 1;
const BOMB_EXIT_MARGIN   = 40;
const FRENZY_START_BLOCK = 8;
const FRENZY_PERIOD      = 15;
const FRENZY_LEN         = 7;
const FRENZY_MULT        = 3;
const FRENZY_SPEED_MULT  = 1.35;

// ── RULE SETS BY TRACE VERSION ───────────────────────────────────────
// A gameplay change is a PROTOCOL change: the same taps score differently
// under different rules, so the rules must follow the TRACE, never this
// build. See CLAUDE.md "a gameplay change is a protocol change".
//
//   v2  the classic game: bounce sweep, no fire tiles, no frenzy
//   v3  fire tiles + frenzy added, still a bounce sweep
//   v4  ONE-WAY sweep with spikes: the tile crosses once and, if it is not
//       dropped, it hits the spikes and the run ends. One chance per tile.
//       The speed ceiling is raised so difficulty keeps climbing.
//   v5  the classic game again: no fire tiles, no frenzy, no spikes, and the
//       speed ramps steadily as in v2. ONE new rule: a tile that is left to
//       sweep (never dropped) BREAKS on its WALL_BREAK_HITS-th wall hit and the
//       run ends. A wall hit is the tile reaching either end of its sweep;
//       the third one is the far end on the way back out, i.e. 1.5 round trips.
//       Counted from the closed-form sweep distance, so client and server
//       compute the identical instant with no event.
const SPEED_CAP_V4 = 6.0;   // mirror games/sky-tower/js/game.js
const WALL_BREAK_HITS = 3;  // mirror games/sky-tower/js/game.js
const RULES = {
  2: { mechanics: false, oneWay: false, speedCap: SPEED_CAP_INCREMENT, wallHits: 0 },
  3: { mechanics: true,  oneWay: false, speedCap: SPEED_CAP_INCREMENT, wallHits: 0 },
  4: { mechanics: true,  oneWay: true,  speedCap: SPEED_CAP_V4, wallHits: 0 },
  5: { mechanics: false, oneWay: false, speedCap: SPEED_CAP_INCREMENT, wallHits: WALL_BREAK_HITS },
};
function rulesFor(v) { return RULES[Number(v)] || RULES[5]; }

// v5: the time at which the tile's WALL_BREAK_HITS-th wall hit lands. Hit k is
// at sweep distance k * 2 * travel. A drop AFTER this instant never happened.
function wallBreakMs(speed, travel, hits) {
  return (hits * 2 * travel) / (speed * V_PER_SPEED_PER_MS);
}

function _hash01(seedHex, n, salt) {
  let a = 0;
  if (typeof seedHex === 'string' && seedHex.length >= 8) {
    a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  }
  a = (a ^ Math.imul(n + 1, 0x9E3779B1) ^ Math.imul(salt, 0x85EBCA6B)) >>> 0;
  a = Math.imul(a ^ (a >>> 16), 0x85EBCA6B);
  a = Math.imul(a ^ (a >>> 13), 0xC2B2AE35);
  a = (a ^ (a >>> 16)) >>> 0;
  return a / 4294967296;
}

function isBombBlock(seedHex, i) {
  if (i < BOMB_START_BLOCK) return false;
  // FRENZY takes precedence — no fire tiles during a frenzy run.
  if (isFrenzyBlock(seedHex, i)) return false;
  const k = i - BOMB_START_BLOCK;
  const win = Math.floor(k / BOMB_WINDOW);
  const pos = k - win * BOMB_WINDOW;
  const chosen = 1 + Math.floor(_hash01(seedHex, win, 0x5A17) * (BOMB_WINDOW - 2));
  return pos === chosen;
}

function isFrenzyBlock(seedHex, i) {
  if (i < FRENZY_START_BLOCK) return false;
  const k = i - FRENZY_START_BLOCK;
  const win = Math.floor(k / FRENZY_PERIOD);
  const pos = k - win * FRENZY_PERIOD;
  const start = 1 + Math.floor(_hash01(seedHex, win, 0x3C9B) * (FRENZY_PERIOD - FRENZY_LEN - 1));
  return pos >= start && pos < start + FRENZY_LEN;
}

/**
 * Closed-form block position `sweepMs` after spawn. The block starts at
 * (center - travel), sweeps toward + at `speed*V_PER_SPEED_PER_MS` units/ms,
 * and bounces between [center-travel, center+travel]. Pure triangle wave —
 * MUST be identical to the client's sweepPos() in game.js. `travel` is now a
 * per-session param.
 */
function sweepPos(center, speed, sweepMs, travel, oneWay) {
  const v = speed * V_PER_SPEED_PER_MS;      // units/ms
  // v4: one crossing, no bounce and no wrap. The caller has already checked
  // the tile had not yet reached the spikes at this instant.
  if (oneWay) return (center - travel) + v * Math.max(0, sweepMs);
  const span = 2 * travel;                    // one-way distance
  const cycle = 2 * span;                     // there-and-back
  const d = v * Math.max(0, sweepMs);         // distance travelled
  const phase = d - Math.floor(d / cycle) * cycle; // d mod cycle, exact
  if (phase <= span) return (center - travel) + phase;
  return (center + travel) - (phase - span);
}

// ── legacy (v1) tunables — unchanged from the pre-replay validator ──
const MIN_DROP_INTERVAL_MS      = 200;
const MAX_DROPS_PER_SEC         = 6;
const MAX_DROPS                 = 2000;
const MAX_SCORE_DELTA_PER_EVENT = 10;

// Backstop ACTION-rate cap (placements/sec), NOT a score-rate cap. Score/sec
// is confounded by the perfect-streak bonus (a legit hot streak scores ~14
// pts/sec), so it clips honest play; the physical drop rate does not. Set just
// above the measured human maximum: across 338 real unflagged sessions the
// drop rate is 1.31/sec at p99 and 3.76/sec at the max, so 5 leaves margin.
// This is only a forensic backstop — the replay already makes drops that come
// faster than the block can sweep to a landing MISS, so a fast-tapping forger
// scores 0 with or without this. Tunable via anticheat.<gameId>.max_drops_per_sec.
const MAX_DROPS_PER_SEC_SIM = 5;

function init({ seed, maxDurationSecs, range, gameMeta, tunables } = {}) {
  const t = tunables || {};
  return {
    mode: 'none',                   // flips to 'sim' on a v2 start marker
    maxDurationSecs: Number(maxDurationSecs) || 600,
    maxDropsPerSec: Number(t.max_drops_per_sec) > 0
      ? Number(t.max_drops_per_sec) : MAX_DROPS_PER_SEC_SIM,
    // Per-session gameplay params, derived from the SAME seed the client got.
    params: deriveParams(seed),
    // Kept so the sim can compute the bomb / frenzy schedule per block index.
    seed: typeof seed === 'string' ? seed : null,

  };
}

// Fresh tower state for the simulator. The base block sits centred at
// (BASE_POS, BASE_POS) with size BASE_SIZE on both axes; placedCount starts at
// 1 (the base) so the axis parity matches the game.
function initSim(startTHint, params, seed, rules) {
  return {
    // TRACE VERSION GATE. v2 traces come from a client BUILD THAT HAS NO fire
    // tiles and no frenzy; v3 traces come from the build that does. The two
    // score differently for the same taps, so the schedule must follow the
    // CLIENT, never the server's own build — otherwise every deploy of a
    // gameplay change mis-scores somebody:
    //   old client + new server -> server invents a fire tile the player never
    //                              saw, and kills the run when they tap it
    //   new client + old server -> server misses the fire-tile pause, desyncs
    //                              on the next block and ends the run early
    // Both are live during an ECS/Amplify rollout (the frontend lands minutes
    // before the backend) and for anyone still holding a CDN-cached build.
    rules,
    mechanics: rules.mechanics === true,
    params: params || { travel: TRAVEL, speedBase: 1.65, speedDelta: 0.055 },
    seed: typeof seed === 'string' ? seed : null,
    // Counts EVERY block that appeared, bombs included — this is what drives
    // the bomb/frenzy schedule. placedCount only counts blocks that landed.
    spawnIndex: 0,
    top: { x: BASE_POS, y: BASE_POS, w: BASE_SIZE, d: BASE_SIZE },
    placedCount: 1,
    score: 0,
    perfectStreak: 0,
    spawnTHint: startTHint,   // when the CURRENT block was spawned
    guidedSeen: 0,
    dead: false,
    steps: 0,
    firstScoredTHint: null,   // action-rate window (scoring drops only)
    lastScoredTHint: null,

    // ── ACCURACY FINGERPRINT (measure-only; scores nothing) ──────────────
    // The replay already knows how far off-centre every block landed. A
    // human's hand jitters (reaction time wanders 50-100ms drop to drop) so
    // the landings scatter; a bot's capture loop is 20-35ms and steady, so
    // they cluster. The SCORE cannot tell those apart — a good human and a
    // bot both score high — but the SPREAD separates them cleanly.
    // Measured on production: real players average 12.96 units of error
    // (best run ever 4.4); a labelled bot run scored 368 at 2.39.
    //
    // Accumulated as running sums so this costs O(1) per drop and cannot
    // change any scoring decision — nothing below reads these back.
    fpN: 0,          // non-guided drops counted
    fpErrSum: 0,     // Σ|offset|
    fpErrSqSum: 0,   // Σ offset²  (spread, not just the mean)
    fpPerfect: 0,    // count of |offset| <= PERFECT_THRESHOLD
    // Least-squares terms for the error SLOPE over drop index. Humans get
    // WORSE as the block speeds up; a bot stays flat. Beating the mean by
    // adding jitter is easy — beating the slope means modelling human
    // degradation, which is a materially harder problem.
    fpIdxSum: 0,     // Σx
    fpIdxSqSum: 0,   // Σx²
    fpIdxErrSum: 0,  // Σxy
    fpStreak: 0,     // current run of consecutive perfect (non-guided) drops
    fpStreakMax: 0,  // longest such run: a rate can be diluted by late misses, a streak cannot
  };
}

// One simulated drop. Mirrors placeBlock() in game.js exactly.
function simDrop(sim, tHint, guided) {
  if (sim.dead) return;
  // This block's frenzy state comes from the index of the block now sweeping.
  const frenzy = sim.mechanics && isFrenzyBlock(sim.seed, sim.spawnIndex);
  const direction = sim.placedCount % 2 === 0 ? 'x' : 'y';
  const posKey  = direction;
  const sizeKey = direction === 'x' ? 'w' : 'd';
  const center = sim.top[posKey];
  const size   = sim.top[sizeKey];

  // Where was the block at the tap instant?
  let pos;
  if (guided && sim.guidedSeen < GUIDE_DROPS) {
    // Tutorial drops are snapped dead-centre and frozen until the tap — they
    // are always perfect by construction, capped at GUIDE_DROPS. Everyone
    // (honest or not) gets the same guide floor, so this is parity, not a hole.
    pos = center;
    sim.guidedSeen += 1;
  } else {
    // Frenzy blocks sweep faster — the same multiplier game.js applies at spawn.
    const speed = speedForPlacements(sim.placedCount - 1, sim.params, sim.rules.speedCap)
                  * (frenzy ? FRENZY_SPEED_MULT : 1);
    const sweepMs = tHint - sim.spawnTHint;
    // v4 — ONE CHANCE. If the tile has already crossed to the far spikes by the
    // time of this tap, it broke there and the run was over BEFORE this event.
    // The honest client never emits such a drop (it ended the game itself at
    // exactly this computed instant); a forger's late tap lands here.
    //
    // This is DELIBERATELY redundant with the geometry: a post-crossing tap
    // lands >= travel (150-180) from centre and the tower is never wider than
    // BASE_SIZE (110), so it would be scored a miss anyway. Stated explicitly
    // because it is the actual RULE, and because that equivalence is only true
    // while travel > BASE_SIZE — pinned by a test, so tuning either constant
    // cannot silently turn a death into a placement.
    if (sim.rules.oneWay && sweepMs > crossMs(speed, sim.params.travel)) {
      sim.dead = true;
      return;
    }
    // v5 — the tile broke on its Nth wall hit before this tap. The honest
    // client ended the run itself at exactly this computed instant.
    if (sim.rules.wallHits > 0
        && sweepMs > wallBreakMs(speed, sim.params.travel, sim.rules.wallHits)) {
      sim.dead = true;
      return;
    }
    pos = sweepPos(center, speed, sweepMs, sim.params.travel, sim.rules.oneWay);
  }

  const offset  = pos - center;
  const overlap = size - Math.abs(offset);

  if (overlap <= 0) {
    // The block missed the tower — game over. (The honest client never emits
    // this drop; a forger's random-timed taps land here fast.)
    sim.dead = true;
    return;
  }

  const isPerfect = Math.abs(offset) <= PERFECT_THRESHOLD;

  // Fingerprint sample. GUIDED (tutorial) drops are snapped dead-centre and
  // frozen until the tap — they are perfect by construction, so counting them
  // would drag every player's error toward zero and hand a bot cover.
  if (!guided) {
    const absErr = Math.abs(offset);
    const x = sim.fpN;                 // drop index within the run
    sim.fpN += 1;
    sim.fpErrSum += absErr;
    sim.fpErrSqSum += absErr * absErr;
    if (isPerfect) { sim.fpPerfect += 1; sim.fpStreak += 1; if (sim.fpStreak > sim.fpStreakMax) sim.fpStreakMax = sim.fpStreak; } else sim.fpStreak = 0;
    sim.fpIdxSum += x;
    sim.fpIdxSqSum += x * x;
    sim.fpIdxErrSum += x * absErr;
  }

  // Points — mirror the perfect-streak bonus exactly.
  let awarded = 1;
  if (isPerfect) {
    sim.perfectStreak += 1;
    awarded = Math.min(sim.perfectStreak + 1, PERFECT_STREAK_CAP);
  } else {
    sim.perfectStreak = 0;
  }
  // FRENZY — triple, exactly as game.js does before it emits.
  if (frenzy) awarded *= FRENZY_MULT;

  // Tower drift + shrink — mirror placeBlock()'s placed[posKey]/[sizeKey].
  const newSize = isPerfect ? size : overlap;
  let newPos;
  if (isPerfect)          newPos = center;      // snapped
  else if (offset > 0)    newPos = pos;         // block on the + side
  else                    newPos = center;      // block on the - side
  sim.top[sizeKey] = newSize;
  sim.top[posKey]  = newPos;

  sim.score += awarded;
  sim.placedCount += 1;
  sim.steps += 1;
  // Action-rate window: measured over SCORING placements, independent of the
  // streak bonus. Guided drops carry no meaningful tHint (snapped + frozen), so
  // skip them.
  if (!guided) {
    if (sim.firstScoredTHint === null) sim.firstScoredTHint = tHint;
    sim.lastScoredTHint = tHint;
  }
  sim.spawnTHint = tHint;   // the next block spawns at this placement
  sim.spawnIndex += 1;      // …and it is the next index in the schedule
}

/**
 * Advance the block timeline across any bomb that has already expired by
 * `tHint`. A bomb lives BOMB_LIFETIME_MS and then leaves on its own, and the
 * next block spawns at exactly that instant — the same computed value game.js
 * hands to spawnBlock() — so no event is needed to stay in step.
 */
function advanceBombs(sim, tHint) {
  let guard = 0;
  while (!sim.dead && guard < 4096) {
    guard += 1;
    if (!sim.mechanics || !isBombBlock(sim.seed, sim.spawnIndex)) return;
    const until = sim.spawnTHint + bombDurationMs(sim.params, sim.placedCount - 1, sim.rules.speedCap);
    if (tHint < until) return;        // the bomb is still live at this tap
    sim.spawnTHint = until;           // it passed safely
    sim.spawnIndex += 1;
  }
}

function processEvent(state, event) {
  if (!event || typeof event !== 'object') {
    return { accepted: true, newScore: currentScore(state) };
  }
  const { type, payload } = event;
  const kind = payload && payload.kind;

  // ── v2 start marker: switch to the simulator ──
  if (type === 'input' && kind === 'start' && payload && Number(payload.v) >= 2) {
    const tHint = Number(payload.tHint);
    state.mode = 'sim';
    state.sim = initSim(
      Number.isFinite(tHint) ? tHint : 0, state.params, state.seed,
      rulesFor(payload.v),             // v2 classic / v3 fire+frenzy / v4 one-way / v5 classic + wall break
    );
    return { accepted: true, newScore: 0 };
  }

  if (state.mode === 'sim') {
    if (type !== 'input' || kind !== 'drop') {
      return { accepted: true, newScore: state.sim.score };
    }
    const tHint = Number(payload.tHint);
    if (!Number.isFinite(tHint) || tHint < 0) {
      return { accepted: true, newScore: state.sim.score, reason: 'bad_thint' };
    }
    const sim = state.sim;
    const wasDead = sim.dead;

    // Step over any bomb whose window closed before this tap — the player let
    // it pass, which is the correct play.
    advanceBombs(sim, tHint);

    // Is a bomb live right now? Then this tap landed ON it.
    if (!sim.dead && sim.mechanics && isBombBlock(sim.seed, sim.spawnIndex)) {
      if (tHint - sim.spawnTHint < BOMB_GRACE_MS) {
        // Grace window — a stray double-tap straight after a placement. The
        // honest client never even emits here; ignore rather than kill.
        return { accepted: true, newScore: sim.score, reason: 'bomb_grace' };
      }
      sim.dead = true;                 // 💥 tapped the bomb — run over
      return { accepted: true, newScore: sim.score, terminated: true };
    }

    simDrop(sim, tHint, payload.guided === true);
    // A miss terminates the run, but we do NOT kill the session here — the
    // authoritative number is finalize()'s, and a late/miss drop should just
    // stop accruing, not tear down a session the player already finished.
    const terminated = state.sim.dead && !wasDead;
    return { accepted: true, newScore: state.sim.score, terminated };
  }

  // NO FALLBACK. Without a v2 start marker there is no clock origin, so the
  // run cannot be replayed and therefore cannot be scored. Accept the event so
  // the session is not killed mid-play, but score nothing — finalize() refuses.
  return { accepted: true, newScore: 0, reason: 'no_replay_marker' };
}

function currentScore(state) {
  return state.mode === 'sim' && state.sim ? state.sim.score : 0;
}

/**
 * ACCURACY FINGERPRINT — measure only. Returns null rather than guessing on a
 * run too short to say anything about.
 *
 * NOTHING reads this to make a decision yet, and that is deliberate. The first
 * threshold I proposed (`err < 3.0 AND perfect > 90%`) would have MISSED a
 * real labelled bot run that scored 368 at 85% perfect — mean error is the
 * strong signal and the perfect-rate clause is brittle. One labelled sample
 * corrected it, which is exactly why this ships as data before it ships as a
 * gate. Stage 2 gates the PAYOUT (flagged, unpaid, reviewed by a human);
 * stage 3 refuses the leaderboard write. Never auto-ban: a false positive on
 * a cash leaderboard costs more than missing a bot for a day.
 */
const FP_MIN_DROPS = 8;   // below this the statistics are noise, not evidence

function accuracyFingerprint(sim) {
  const n = sim.fpN;
  if (!n || n < FP_MIN_DROPS) return null;

  const mean = sim.fpErrSum / n;
  // Population SD of |offset|. Clamped at 0 because floating-point can push a
  // genuinely-zero variance a hair negative.
  const variance = Math.max(0, sim.fpErrSqSum / n - mean * mean);

  // Least-squares slope of |error| against drop index. Positive = getting
  // worse as the block speeds up, which is what a human does. Denominator is
  // zero only when every x is identical, impossible for n >= 2.
  const denom = n * sim.fpIdxSqSum - sim.fpIdxSum * sim.fpIdxSum;
  const slope = denom === 0
    ? null
    : (n * sim.fpIdxErrSum - sim.fpIdxSum * sim.fpErrSum) / denom;

  const r = (v) => (v === null ? null : Math.round(v * 1000) / 1000);
  return {
    drops: n,
    meanErr: r(mean),
    sdErr: r(Math.sqrt(variance)),
    perfectRate: r(sim.fpPerfect / n),
    perfectStreakMax: sim.fpStreakMax || 0,
    errSlope: r(slope),
  };
}

function finalize(state) {
  if (state.mode === 'sim' && state.sim) {
    const sim = state.sim;
    const score = sim.score;
    // Forensic ACTION-rate backstop (drops/sec), decoupled from scoring. Only
    // meaningful with a few scoring placements over a real window; flags for
    // payout review, never zeroes on its own (the replay is authoritative — a
    // physically impossible rate could only have MISSED and scored low anyway).
    let suspicious = null;
    if (sim.steps > 5 && sim.firstScoredTHint !== null && sim.lastScoredTHint > sim.firstScoredTHint) {
      const elapsedSec = (sim.lastScoredTHint - sim.firstScoredTHint) / 1000;
      const rate = sim.steps / elapsedSec;
      if (rate > state.maxDropsPerSec) suspicious = `drop_rate:${rate.toFixed(2)}/s`;
    }
    return {
      score,
      gameOver: sim.dead || score > 0,
      suspicious,
      fingerprint: accuracyFingerprint(sim),
      debug: { mode: 'sim', steps: sim.steps, dead: sim.dead, maxDropsPerSec: state.maxDropsPerSec },
    };
  }
  // ── UNSCORABLE ────────────────────────────────────────────────────
  // The legacy count path used to score these traces. It was written for the
  // PRE-REPLAY client and scores a modern trace WRONG — on 6 Sep it turned two
  // honest runs of 99 and 92 into 26 and 62, silently, because a slow
  // /session/start let the player begin before the `start` marker survived.
  // A wrong number is worse than a refusal on a cash leaderboard, so there is
  // no fallback any more: say plainly that this run cannot be verified.
  return {
    score: 0,
    gameOver: false,
    unscorable: true,
    suspicious: 'no_replay_marker',
    debug: { mode: 'none', reason: 'no v2 start marker — run cannot be replayed' },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  init,
  processEvent,
  finalize,
  simulate,
  // exported for the parity test + any client-side reuse
  _sim: {
    sweepPos, speedForPlacements, simDrop, initSim, deriveParams, SPEED_CAP_INCREMENT,
    GUIDE_DROPS, PERFECT_THRESHOLD, TRAVEL,
    isBombBlock, isFrenzyBlock, crossMs, rulesFor, SPEED_CAP_V4,
    WALL_BREAK_HITS, wallBreakMs,
    BOMB_START_BLOCK, BOMB_WINDOW, BOMB_GRACE_MS, bombDurationMs,
    FRENZY_START_BLOCK, FRENZY_PERIOD, FRENZY_LEN, FRENZY_MULT, FRENZY_SPEED_MULT,
  },
  _internal: { MIN_DROP_INTERVAL_MS, MAX_DROPS_PER_SEC, MAX_DROPS },
};
