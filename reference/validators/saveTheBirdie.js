"use strict";

/**
 * Save The Birdie validator: server-side deterministic REPLAY (v2, v3, v4).
 *
 * v4 (1 Oct 2026): GEMS. See GEM_* below; a v3 trace replays on v3 rules.
 *
 * v3 (27 Sep 2026): the play area is 40 design units shorter. The ceiling and
 * floor kill lines moved in from y 70 / 1210 to y 90 / 1190 (the border spikes
 * and the side-spike placement range move with them), so the whole gameplay
 * band fits a typical phone's browser box at FULL WIDTH (0.65 wide to tall:
 * 720 / 0.65 = 1108 design units of height). The walls did not move, so the
 * wall-to-wall flight time, the rhythm of the game, is unchanged. A trace
 * marked v2 is still replayed on the v2 kill lines: that is what the player
 * of a run already in progress when v3 deployed was playing.
 *
 * The bird flies between two walls; a tap flaps it; every wall it reaches is
 * +1 and deals a fresh spike wall opposite; a spike, the floor or the ceiling
 * ends the run. On the replay path the SCORE IS COMPUTED: the trace carries
 * the player's flaps against the fixed 60 Hz step they landed on, the server
 * builds the same walls from the session seed, flies the same bird and counts
 * the walls it reaches before it dies.
 *
 * What had to change in the game for this to be possible (10 Sep 2026):
 *   - the spike walls were Math.random; wall N is now a pure function of
 *     (seed, N), five draws in a fixed order on every wall;
 *   - the moving spikes swung on a GLOBAL frame counter that had been ticking
 *     since page load (menu time included), so their phase depended on how
 *     long the player sat on the menu; they run on the run's own counter now;
 *   - the post-flap "touch" collision mask was a 240 ms WALL-CLOCK window; it
 *     is 14 fixed steps now;
 *   - the interactive tutorial (which restarted the bird inside the live
 *     session) is a static panel;
 *   - the one transcendental on the gameplay path, the moving-spike sine, goes
 *     through dmath (Math.sin differs by an ulp between engines).
 *
 * Every constant and the two collision masks below are copied from
 * games/save-the-birdie/js/game.js and must stay byte-identical to it —
 * saveTheBirdieParity.test.js pulls them out of both files and compares.
 *
 * A trace with no v2 start marker takes the pre-replay bounds path below
 * (mode 'v1'); the session layer refuses those unconditionally now, so it
 * exists only so an old trace decodes for review.
 */

const DMath = require('../dmath');

// ── constants (mirror game.js) ────────────────────────────────────────────
const DESIGN_W = 720;
const DESIGN_H = 1280;
const BORDER_BAND_V2 = 70;
const BORDER_BAND_V3 = 90;
const wallSpikeMargin = 110;
const RULES_VERSION = 4;
const left = 0;
const right = DESIGN_W;
const wallBouncePadding = 0;
const wallSpikeExitOffset = 120;
const sideSpikeWidth = 46;
const sideSpikeHeight = 82;
const movingSpikeAmplitude = 18;
const movingSpikeSpeed = 0.018;
const borderSpikeCount = 7;
const borderSpikeWidth = sideSpikeHeight;
const borderSpikeHeight = sideSpikeWidth;
const borderSpikeGap = 14;
const borderSpikeRowWidth = borderSpikeCount * borderSpikeWidth
  + (borderSpikeCount - 1) * borderSpikeGap;
const borderSpikeStartX = (DESIGN_W - borderSpikeRowWidth) / 2;
const TOUCH_MASK_FRAMES = 14;
const BIRD_W = 90;
const BIRD_H = 77;
const BIRD_START_X = 130;
const BIRD_START_Y = DESIGN_H / 2;
const FLAP_VY = -9.8;
const GRAVITY = 0.47;
const MAX_VY = 10.6;
const SPEED_BASE = 6.5;
const SPEED_PER_SCORE = 0.045;
const SPEED_CAP = 10.2;
const SPIKE_EASE = 0.28;
// v4 gems: from GEM_FROM_WALLS walls on, a wall has a gem with GEM_CHANCE
// odds, hung GEM_INSET units in front of it beside a spike edge. A bird whose
// centre comes within GEM_HIT of it banks GEM_POINTS.
const GEM_POINTS = 5;
const GEM_FROM_WALLS = 4;
const GEM_CHANCE = 0.55;
const GEM_INSET = 200;
const GEM_HIT = 46;
const GEM_EDGE = 48;

const wallSpikePatterns = {
  easy: [
    [0, 220], [0, 280], [0, 360], [0, 440], [0, 520], [0, 620], [0, 720], [0, 820], [0, 900],
  ],
  medium: [
    [0, 220, 440], [0, 220, 560], [0, 220, 760], [0, 260, 520], [0, 300, 620],
    [0, 360, 580], [0, 400, 800], [0, 520, 740], [0, 620, 840], [0, 280, 900],
  ],
  hard: [
    [0, 200, 400, 600], [0, 200, 400, 800], [0, 200, 600, 800], [0, 240, 480, 720],
    [0, 220, 540, 760], [0, 300, 520, 820], [0, 360, 580, 800], [0, 200, 680, 900],
    [0, 300, 700, 900], [0, 260, 520, 900],
  ],
};

const normalBirdMaskData = '54-58|53-59|52-59|51-59|51-60|44-45,51-60|42-47,50-59|42-48,50-59|41-48,50-59|41-59|41-58|41-58|42-57|42-57|43-56|26-66|23-68|21-70|20-71|19-72|18-73|17-74|17-74|16-75|16-75|16-75|16-75|16-75|15-75|15-75|15-75|15-76|15-77|15-78|15-79|16-80|0-81|0-82|2-83|2-84|4-85|5-86|6-87|7-88|8-89|9-89|10-88|11-87|12-86|13-85|14-84|15-83|16-82|15-81|15-80|15-79|15-78|15-77|15-76|15-75|15-75|15-75|15-75|15-75|16-75|16-75|16-75|16-75|16-74|17-74|18-73|18-72|19-71|20-70|22-68|25-65|';
const touchBirdMaskData = '59-63|58-64|56-65|55-65|54-65|54-65|53-65|46-48,53-64|44-50,52-64|43-50,52-63|43-62|43-62|43-61|43-60|44-59|45-57|26-68|24-70|22-72|21-73|20-74|19-75|19-75|18-76|18-76|17-76|17-76|17-77|17-79|17-81|17-83|17-85|17-87|17-89|2-89|2-87|4-85|5-83|6-81|7-79|8-76|9-78|10-80|11-83|13-85|14-87|15-87|16-85|17-83|17-81|17-80|17-78|17-76|17-76|17-76|17-76|17-77|17-77|17-77|17-76|17-76|18-76|18-76|19-75|19-74|20-73|21-72|23-71|25-68||||||||';

function decodeBirdCollisionMask(encodedRows) {
  const rows = encodedRows.split('|').map((encodedRow) => {
    if (!encodedRow) return [];
    return encodedRow.split(',').map((encodedRun) => {
      const separator = encodedRun.indexOf('-');
      return [Number(encodedRun.slice(0, separator)), Number(encodedRun.slice(separator + 1))];
    });
  });
  let minX = BIRD_W; let maxX = -1; let minY = BIRD_H; let maxY = -1;
  for (let y = 0; y < rows.length; y++) {
    const runs = rows[y];
    if (runs.length) {
      minX = Math.min(minX, runs[0][0]);
      maxX = Math.max(maxX, runs[runs.length - 1][1]);
      minY = Math.min(minY, y);
      maxY = y;
    }
  }
  return { rows, minX, maxX, minY, maxY };
}
const MASKS = { normal: decodeBirdCollisionMask(normalBirdMaskData), touch: decodeBirdCollisionMask(touchBirdMaskData) };

// killLines() in game.js: keep it byte-identical. The ceiling and the floor a
// run of this version dies on.
function killLines(version) {
  const band = version >= 3 ? BORDER_BAND_V3 : BORDER_BAND_V2;
  return { top: band, bottom: DESIGN_H - band };
}

function createBorderSpikeTriangles(top, bottom) {
  const triangles = [];
  for (let i = 0; i < borderSpikeCount; i++) {
    const x = borderSpikeStartX + i * (borderSpikeWidth + borderSpikeGap);
    const tipX = x + borderSpikeWidth / 2;
    const endX = x + borderSpikeWidth;
    triangles.push([{ x, y: top }, { x: tipX, y: top + borderSpikeHeight }, { x: endX, y: top }]);
    triangles.push([{ x, y: bottom }, { x: tipX, y: bottom - borderSpikeHeight }, { x: endX, y: bottom }]);
  }
  return triangles;
}
const BORDER_TRIANGLES = {
  2: createBorderSpikeTriangles(killLines(2).top, killLines(2).bottom),
  3: createBorderSpikeTriangles(killLines(3).top, killLines(3).bottom),
  4: createBorderSpikeTriangles(killLines(4).top, killLines(4).bottom),
};

// ── seed ──────────────────────────────────────────────────────────────────
function seedToInt(seedHex) {
  return (typeof seedHex === 'string' && seedHex.length >= 8)
    ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
}
// wallRng() in game.js — keep byte-identical.
function wallRng(seedInt, index) {
  let a = (seedInt + Math.imul(index + 1, 0x9E3779B1)) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t2 = a;
    t2 = Math.imul(t2 ^ (t2 >>> 15), t2 | 1);
    t2 ^= t2 + Math.imul(t2 ^ (t2 >>> 7), t2 | 61);
    return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
  };
}

// ── the simulation ────────────────────────────────────────────────────────
function initSim(seed, M = DMath, version = RULES_VERSION) {
  const v = version >= 4 ? 4 : version >= 3 ? 3 : 2;
  const bounds = killLines(v);
  const sim = {
    M,
    version: v,
    top: bounds.top,
    bottom: bounds.bottom,
    border: BORDER_TRIANGLES[v],
    seedInt: seedToInt(seed),
    frames: 0, score: 0, walls: 0, gem: null, gems: 0, dead: false, deathFrame: null,
    x: BIRD_START_X, y: BIRD_START_Y, vy: 0, dir: 1,
    spikesL: [], spikesR: [],
    wallIndex: 0,
    lastPattern: { easy: -1, medium: -1, hard: -1 },
    touchUntilFrame: -1,
    taps: 0,
    hb: { left: 0, right: 0 },
  };
  generateWallSpikes(sim, 'right');
  return sim;
}

// generateWallSpikes() in game.js — five draws, fixed order, every wall.
function generateWallSpikes(sim, side) {
  const arr = [];
  const enterOffset = side === 'right' ? wallSpikeExitOffset : -wallSpikeExitOffset;
  const exitOffset = side === 'right' ? -wallSpikeExitOffset : wallSpikeExitOffset;
  const difficulty = sim.walls < 8 ? 'easy' : sim.walls < 20 ? 'medium' : 'hard';
  const patterns = wallSpikePatterns[difficulty];
  const grnd = wallRng(sim.seedInt, sim.wallIndex);
  sim.wallIndex += 1;
  const patternRoll = grnd();
  const avoidRoll = grnd();
  const shiftRoll = grnd();
  const movingRoll = grnd();
  const phaseRoll = grnd();
  const gemRoll = grnd();
  const gemGapRoll = grnd();
  const gemEdgeRoll = grnd();
  let patternIndex = Math.floor(patternRoll * patterns.length);
  if (patternIndex === sim.lastPattern[difficulty]) {
    patternIndex = (patternIndex + 1 + Math.floor(avoidRoll * (patterns.length - 1))) % patterns.length;
  }
  sim.lastPattern[difficulty] = patternIndex;
  const pattern = patterns[patternIndex];
  const minY = sim.top + wallSpikeMargin;
  const maxY = sim.bottom - wallSpikeMargin;
  const patternHeight = pattern[pattern.length - 1];
  const availableShift = Math.max(0, maxY - minY - patternHeight);
  const startY = minY + Math.floor(shiftRoll * (availableShift + 1));
  const movingChance = difficulty === 'hard' ? 0.65 : difficulty === 'medium' ? 0.35 : 0;
  const isMovingPattern = movingRoll < movingChance;
  const motionPhase = phaseRoll * Math.PI * 2;
  for (const patternOffset of pattern) {
    const spikeY = startY + patternOffset;
    arr.push({
      side, y: spikeY, baseY: spikeY, h: sideSpikeHeight, w: sideSpikeWidth,
      offset: enterOffset, targetOffset: 0,
      motionAmplitude: isMovingPattern ? movingSpikeAmplitude : 0, motionPhase,
    });
  }
  // v4 gem: placement is a pure function of this wall's draws (all three are
  // taken on every wall). It hangs beside a spike edge of an inner gap, so
  // taking it means flying a slightly tighter line than the gap's middle.
  sim.gem = null;
  if (sim.version >= 4 && sim.walls >= GEM_FROM_WALLS && gemRoll < GEM_CHANCE && pattern.length >= 2) {
    const k = Math.floor(gemGapRoll * (pattern.length - 1));
    const gy = gemEdgeRoll < 0.5
      ? startY + pattern[k] + sideSpikeHeight / 2 + GEM_EDGE
      : startY + pattern[k + 1] - sideSpikeHeight / 2 - GEM_EDGE;
    sim.gem = { x: side === 'right' ? right - GEM_INSET : left + GEM_INSET, y: gy };
  }
  if (side === 'right') {
    sim.spikesL.forEach((spike) => { spike.targetOffset = exitOffset; });
    sim.spikesR = arr;
  } else {
    sim.spikesR.forEach((spike) => { spike.targetOffset = exitOffset; });
    sim.spikesL = arr;
  }
}

// updateSpikeAnimations() in game.js
function updateSpikeAnimations(sim) {
  const move = (spikes) => {
    for (let i = spikes.length - 1; i >= 0; i--) {
      const spike = spikes[i];
      const target = spike.targetOffset || 0;
      spike.offset += (target - spike.offset) * SPIKE_EASE;
      if (Math.abs(spike.offset - target) < 0.5) spike.offset = target;
      if (Math.abs(spike.offset) >= wallSpikeExitOffset - 1 && target !== 0) { spikes.splice(i, 1); continue; }
      spike.y = spike.baseY + sim.M.sin(sim.frames * movingSpikeSpeed + spike.motionPhase) * spike.motionAmplitude;
    }
  };
  move(sim.spikesL);
  move(sim.spikesR);
}

function activeMask(sim) {
  return sim.frames < sim.touchUntilFrame ? MASKS.touch : MASKS.normal;
}

const scan = { min: 0, max: 0 };
function edgeIntersectionXAtY(y, x1, y1, x2, y2) {
  if (y1 === y2 || y < Math.min(y1, y2) || y > Math.max(y1, y2)) return NaN;
  return x1 + (y - y1) * (x2 - x1) / (y2 - y1);
}
function updateTriangleRangeAtY(y, ax, ay, bx, by, cx, cy) {
  const x1 = edgeIntersectionXAtY(y, ax, ay, bx, by);
  const x2 = edgeIntersectionXAtY(y, bx, by, cx, cy);
  const x3 = edgeIntersectionXAtY(y, cx, cy, ax, ay);
  let minX = Infinity; let maxX = -Infinity;
  if (Number.isFinite(x1)) { minX = Math.min(minX, x1); maxX = Math.max(maxX, x1); }
  if (Number.isFinite(x2)) { minX = Math.min(minX, x2); maxX = Math.max(maxX, x2); }
  if (Number.isFinite(x3)) { minX = Math.min(minX, x3); maxX = Math.max(maxX, x3); }
  if (minX === Infinity || minX === maxX) return false;
  scan.min = minX; scan.max = maxX;
  return true;
}
function birdMaskIntersectsTriangle(sim, mask, ax, ay, bx, by, cx, cy) {
  const birdTop = sim.y - BIRD_H / 2;
  const triangleTop = Math.min(ay, by, cy);
  const triangleBottom = Math.max(ay, by, cy);
  const startRow = Math.max(mask.minY, Math.floor(triangleTop - birdTop));
  const endRow = Math.min(mask.maxY, Math.ceil(triangleBottom - birdTop));
  for (let y = startRow; y <= endRow; y++) {
    const runs = mask.rows[y];
    if (!runs || !runs.length) continue;
    const worldY = birdTop + y + 0.5;
    if (!updateTriangleRangeAtY(worldY, ax, ay, bx, by, cx, cy)) continue;
    for (const run of runs) {
      const localStart = run[0] + 0.5 - BIRD_W / 2;
      const localEnd = run[1] + 0.5 - BIRD_W / 2;
      const worldStart = sim.x + localStart * sim.dir;
      const worldEnd = sim.x + localEnd * sim.dir;
      const runMin = Math.min(worldStart, worldEnd);
      const runMax = Math.max(worldStart, worldEnd);
      if (runMax >= scan.min && runMin <= scan.max) return true;
    }
  }
  return false;
}
function birdTouchesHorizontalBounds(sim) {
  const mask = activeMask(sim);
  const birdTop = sim.y - BIRD_H / 2;
  return birdTop + mask.minY <= sim.top || birdTop + mask.maxY + 1 >= sim.bottom;
}
function updateBirdHorizontalBounds(sim, mask) {
  const localLeft = mask.minX - BIRD_W / 2;
  const localRight = mask.maxX + 1 - BIRD_W / 2;
  if (sim.dir > 0) { sim.hb.left = sim.x + localLeft; sim.hb.right = sim.x + localRight; }
  else { sim.hb.left = sim.x - localRight; sim.hb.right = sim.x - localLeft; }
}
function birdTouchesSpikes(sim) {
  const mask = activeMask(sim);
  const active = sim.dir > 0 ? sim.spikesR : sim.spikesL;
  for (const spike of active) {
    const offset = spike.offset || 0;
    const baseX = spike.side === 'right' ? right + offset : left + offset;
    const tipX = spike.side === 'right' ? baseX - spike.w : baseX + spike.w;
    if (birdMaskIntersectsTriangle(sim, mask, baseX, spike.y - spike.h / 2, tipX, spike.y, baseX, spike.y + spike.h / 2)) return true;
  }
  for (const tri of sim.border) {
    if (birdMaskIntersectsTriangle(sim, mask, tri[0].x, tri[0].y, tri[1].x, tri[1].y, tri[2].x, tri[2].y)) return true;
  }
  return false;
}

// One fixed step — update() in game.js, from `gameFrames++` on, same order.
function stepSim(sim) {
  if (sim.dead) return;
  sim.frames++;
  updateSpikeAnimations(sim);
  sim.vy += GRAVITY;
  sim.vy = Math.min(sim.vy, MAX_VY);
  sim.y += sim.vy;
  sim.x += sim.dir * Math.min(SPEED_CAP, SPEED_BASE + sim.walls * SPEED_PER_SCORE);
  if (birdTouchesHorizontalBounds(sim)) { sim.dead = true; sim.deathFrame = sim.frames; return; }
  if (birdTouchesSpikes(sim)) { sim.dead = true; sim.deathFrame = sim.frames; return; }
  updateBirdHorizontalBounds(sim, activeMask(sim));
  if (sim.gem) {
    const gdx = sim.x - sim.gem.x; const gdy = sim.y - sim.gem.y;
    if (gdx * gdx + gdy * gdy <= GEM_HIT * GEM_HIT) { sim.score += GEM_POINTS; sim.gems++; sim.gem = null; }
  }
  if (sim.hb.right >= right - wallBouncePadding) {
    sim.x -= sim.hb.right - (right - wallBouncePadding);
    sim.dir = -1;
    sim.score++; sim.walls++;
    generateWallSpikes(sim, 'left');
  }
  if (sim.hb.left <= left + wallBouncePadding) {
    sim.x += left + wallBouncePadding - sim.hb.left;
    sim.dir = 1;
    sim.score++; sim.walls++;
    generateWallSpikes(sim, 'right');
  }
}

// jump() in game.js: a flap between steps. Applied only while alive.
function tapSim(sim) {
  if (sim.dead) return;
  sim.vy = FLAP_VY;
  sim.touchUntilFrame = sim.frames + TOUCH_MASK_FRAMES;
  sim.taps++;
}

const MAX_SIM_FRAMES = 60 * 60 * 60;   // one hour, the session lifetime
function advanceTo(sim, frame) {
  let guard = 0;
  while (!sim.dead && sim.frames < frame && guard < MAX_SIM_FRAMES) { stepSim(sim); guard++; }
}

// ── legacy (v1) bounds path, verbatim, for traces with no marker ─────────
const DEFAULTS = {
  maxScorePerSec: 1.8,
  minBounceIntervalMs: 380,
  flatSlack: 4,
  dropTolerance: 3,
  hardEventCap: 20000,
};

function initLegacy({ seed, maxDurationSecs, tunables } = {}) {
  const t = { ...DEFAULTS, ...(tunables || {}) };
  return {
    score: 0,          // rate-bounded credited score (authoritative, maintained live)
    bounces: 0,        // accepted scoring bounce events
    claimed: 0,        // monotonic HUD high-water mark the client reported
    startT: null,      // tHint of the first bounce
    lastT: null,       // tHint of the latest bounce
    lastBounceT: null, // for the min-interval check
    events: 0,
    rejectCount: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 600,
    seed: seed || null,
    tunables: t,
  };
}

// Cap the credited score at max-rate × play-span + one-time slack.
function boundedScore(state) {
  const T = state.tunables || DEFAULTS;
  const spanSec = state.startT === null
    ? 0
    : Math.min(Math.max(0, (state.lastT - state.startT) / 1000), state.maxDurationSecs);
  const ceiling = T.maxScorePerSec * spanSec + T.flatSlack;
  // The bounce count is EXACT (+1 per accepted event), so it's the trusted
  // base. The HUD mark may only lift it by `dropTolerance` — enough to recover
  // events lost in flight, but not enough for a client that forges scoreAfter
  // to climb to the time-based ceiling. Then the rate bound caps everything.
  const recovered = Math.min(state.claimed, state.bounces + T.dropTolerance);
  return Math.min(Math.max(state.bounces, recovered), ceiling);
}

function processLegacyEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};

  // Flaps are streamed for trace texture only — they never score.
  if (payload.kind !== 'bounce') {
    return { accepted: true, newScore: state.score };
  }

  const T = state.tunables || DEFAULTS;

  if (state.events >= T.hardEventCap) {
    state.dead = true;
    return { accepted: false, newScore: state.score, reason: 'hard_cap' };
  }

  const tHint = Number(payload.tHint);
  const scoreAfter = Number(payload.scoreAfter);
  if (!Number.isFinite(tHint) || tHint < 0 || !Number.isFinite(scoreAfter) || scoreAfter < 0) {
    state.rejectCount++;
    return { accepted: false, newScore: state.score, reason: 'malformed' };
  }

  // Physically impossible bounce cadence → reject the event (it still can't
  // raise the score, and the HUD snapshot stays bounded by the rate ceiling).
  if (state.lastBounceT !== null && tHint - state.lastBounceT < T.minBounceIntervalMs) {
    state.rejectCount++;
    return { accepted: false, newScore: state.score, reason: 'too_fast' };
  }

  state.events += 1;
  state.bounces += 1;
  state.lastBounceT = tHint;
  if (state.startT === null) state.startT = tHint;
  state.lastT = state.lastT === null ? tHint : Math.max(state.lastT, tHint);
  if (scoreAfter > state.claimed) state.claimed = scoreAfter; // monotonic

  state.score = boundedScore(state);
  return { accepted: true, newScore: state.score };
}

function finalizeLegacy(state) {
  const score = Math.floor(boundedScore(state));
  const T = state.tunables || DEFAULTS;
  const spanSec = state.startT === null
    ? 0
    : Math.min(Math.max(0, (state.lastT - state.startT) / 1000), state.maxDurationSecs);
  return {
    // Authoritative = bounce count / HUD mark, capped at a max-speed run for
    // the elapsed play span. The session-level max_score_per_sec ceiling
    // (checkScore) is an independent second layer applied on top.
    score,
    gameOver: state.dead,
    suspicious: state.rejectCount >= 5 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      credited: score,
      bounces: state.bounces,
      hudSnapshot: Math.floor(state.claimed),
      ceiling: Math.floor(T.maxScorePerSec * spanSec + T.flatSlack),
      elapsedSec: Math.round(spanSec * 100) / 100,
      events: state.events,
    },
  };
}


// ── validator surface ─────────────────────────────────────────────────────
const MAX_INPUTS = 20000;

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
      // v4 = gems; v3 = the shorter play area; v2 = the original kill lines. The rules
      // follow the version the TRACE recorded, never this server's build.
      state.version = Number(payload.v) >= 4 ? 4 : Number(payload.v) >= 3 ? 3 : 2;
      state.sim = initSim(state.seed, DMath, state.version);
    }
    return { accepted: true, newScore: state.score };
  }

  if (state.mode === 'sim') {
    const sim = state.sim;
    if (kind === 'bounce') {
      const sa = Number(payload.scoreAfter);
      if (Number.isFinite(sa) && sa > state.claimedHud) state.claimedHud = sa;
      return { accepted: true, newScore: sim.score };
    }
    if (kind !== 'tap') return { accepted: true, newScore: sim.score };
    if (state.inputCount >= MAX_INPUTS) return { accepted: false, newScore: sim.score, reason: 'hard_cap' };
    const frame = payload.frame;
    if (typeof frame !== 'number' || !Number.isFinite(frame) || frame < 0 || Math.floor(frame) !== frame) {
      state.rejectCount++;
      return { accepted: true, newScore: sim.score, reason: 'bad_frame' };
    }
    // A repeated frame is tolerated (two taps between the same steps), a
    // rewind is refused: it would let an attacker re-run a window.
    if (frame < state.lastFrame) { state.rejectCount++; return { accepted: true, newScore: sim.score, reason: 'frame_regressed' }; }
    state.lastFrame = frame;
    state.inputCount++;
    advanceTo(sim, frame);
    tapSim(sim);
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
    // Run out: without another flap the bird falls; the run always ends.
    let guard = 0;
    const capFrames = elapsedCap(state, 60);
    while (!sim.dead && guard < MAX_SIM_FRAMES && sim.frames < capFrames) { stepSim(sim); guard++; }
    return {
      score: sim.score,
      gameOver: sim.dead,
      suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
      debug: {
        mode: 'sim', version: state.version, frames: sim.frames, deathFrame: sim.deathFrame,
        score: sim.score, dead: sim.dead, taps: sim.taps, gems: sim.gems, inputs: state.inputCount,
        claimedHud: state.claimedHud,
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
  DEFAULTS,
  _internal: { DEFAULTS },
  // Pinned to the session lifetime by shared/tests/sessionLifetime.test.js.
  _limits: { MAX_SIM_FRAMES, FPS: 60 },
  _sim: {
    initSim, stepSim, tapSim, advanceTo, generateWallSpikes, wallRng, seedToInt, DMath,
    DESIGN_W, DESIGN_H, TOUCH_MASK_FRAMES, MAX_SIM_FRAMES, wallSpikePatterns,
    killLines, RULES_VERSION, BORDER_BAND_V2, BORDER_BAND_V3, wallSpikeMargin,
    birdTouchesHorizontalBounds, birdTouchesSpikes, MASKS,
    GEM_POINTS, GEM_FROM_WALLS, GEM_CHANCE, GEM_INSET, GEM_HIT, GEM_EDGE,
  },
};
