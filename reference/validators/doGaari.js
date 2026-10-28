'use strict';

/**
 * Do Gaari validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Do Gaari (two vehicles) was built on replay, so there is no plausibility
 * path: a trace without a v2 start marker is not a run and scores zero.
 *
 * The game: two roads side by side, two lanes each, a vehicle on each. Tap the
 * left half of the screen and the left vehicle switches lane, tap the right
 * half and the right one does. Round things must be COLLECTED, square things
 * must be AVOIDED. Hitting a square, or letting a round one go by, ends the run.
 *
 * What the server does with a trace:
 *   1. rebuilds both roads from the session seed: item K of road R takes three
 *      draws from its own index-addressed stream, never from a running one;
 *   2. applies each tap { n, side, step } on the fixed step it landed on,
 *      before that step runs, exactly as the client does;
 *   3. runs the same fixed steps and counts the round items the vehicle reached.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/do-gaari/js/game.js.
 * shared/tests/doGaariParity.test.js pulls every constant and every rules
 * function out of both files and fails the moment one copy is edited without
 * the other. Edit both or neither; a gameplay change is a trace version bump,
 * never an edit in place.
 *
 * Integer arithmetic only. No trig, no pow, no sqrt, no Math.random, no clock
 * and no screen on the rules path, so the replay is the same on every engine
 * and dmath is not needed.
 */

// ==== RULES BLOCK: identical in games/do-gaari/js/game.js ====
// Field, in design units. Nothing here reads the viewport.
const DESIGN_W = 414;
const DESIGN_H = 736;
// Positions are integers. Scroll is kept in SUB-ths of a design unit so the
// speed can ramp finely without ever leaving integer arithmetic.
const SUB = 16;
// The two roads. Lane 0 of each road is at LANE_X; lane 1 is LANE_GAP to its
// right. A road is 176 wide, they are 18 apart, and the field is 414.
const LANE_X = [66, 260];
const LANE_GAP = 88;
// A lane change takes SWITCH_STEPS steps and moves LANE_STEP per step.
// LANE_STEP * SWITCH_STEPS === LANE_GAP, so the two ends are exact.
const SWITCH_STEPS = 8;
const LANE_STEP = 11;
// The vehicle's fixed band down the screen, and the half-widths that decide a
// hit. CAR_HALF + ITEM_HALF is 45, and half a lane change is 44 — the tightest
// this can go and still hold the invariant below. CAR_HALF was 26 (the truck
// sprite's own widest visible pixels, its wheels, only reach ±24 within that
// box, so the collider was 2 units wider on each side than anything drawn —
// "the car hits when it looks like it should have dodged"). 25 is as far as
// it can come down without also touching ITEM_HALF or LANE_GAP.
// HIT_SPAN's floor is fixed: a vehicle caught mid-switch must be inside BOTH
// lanes, never inside neither — there is no step of the switch on which it
// is untouchable.
const CAR_TOP = 556;
const CAR_H = 80;
const CAR_BOT = 636;
const CAR_HALF = 25;
const ITEM_H = 40;
const ITEM_HALF = 20;
const HIT_SPAN = 45;
const START_GUARD_STEPS = 27;
// Speed, in SUB-ths of a design unit per step, as a function of the distance
// already scrolled. A closed form of the POSITION, never of a running count,
// so the generator can ask what the speed will be where an item is driven.
// There is no top to the difficulty; SPEED_MAX is a WORK bound, set so an item
// can never jump the whole band in one step (the band is GAP_SPAN units and
// SPEED_MAX is 100 units a step). It sits at a scroll no human run reaches.
const SPEED_BASE = 60;
const SPEED_RAMP_UNITS = 240;
const SPEED_MAX = 1600;
// The band an item sweeps while it can touch the vehicle: ITEM_H + CAR_H.
const GAP_SPAN = 120;
// The gap between two items on ONE road, measured in STEPS of free time after
// the earlier one has cleared the vehicle. TURN is used when the pair asks for
// different lanes, HOLD when it does not. Both tighten with distance to a
// floor; TURN's floor is twice a lane change, so every run stays passable.
const GAP_STEPS_HOLD = 16;
const GAP_STEPS_TURN = 26;
const GAP_FLOOR_HOLD = 8;
const GAP_FLOOR_TURN = 18;
const GAP_RAMP_UNITS = 3000;
// Road 1 starts about half a gap after road 0, so the opening items alternate
// roads and a new player is never asked for both thumbs at once.
const FIRST_Y = [700, 790];
// The first items on each road are round and in the lane the vehicle starts
// in: the opening is a free collect that teaches which shape is which.
const WARM_ITEMS = 2;
// A road never asks for the same lane more than this many times running. It
// keeps a stretch from going monotonous, and it is what makes a parked run
// die: a missed medallion is harmless, but every other ask is a barrier in
// the lane a parked vehicle sits in (worst of 2000 seeds: 1328 steps).
const MAX_SAME_REQ = 5;
const SQ_SCALE = 100;
const SQ_CHANCE = 45;
// An item is generated once its world position is within this of the scroll,
// which is a little above the top of the screen.
const SPAWN_AHEAD = 120;
const ROUND = 0;
const SQUARE = 1;
const RNG_STRIDE = 0x9E3779B1;
const RNG_SALT = 0x6A77A1E5;
const ROAD_SALT = 0x27D4EB2F;
const SEED_MIX = 0x85EBCA6B;
const RULES_VERSION = 2;

// Item K of road R draws from its OWN index-addressed stream, never from a
// running one, so no rule can change which numbers a later item gets.
function itemRng(seedInt, road, index) {
  let a = (((seedInt ^ RNG_SALT) >>> 0) + Math.imul(road + 1, ROAD_SALT) + Math.imul(index + 1, RNG_STRIDE)) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function seedToInt(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{16}/i.test(seedHex)) return 0;
  return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)) >>> 0;
}

function speedAt(u) {
  return Math.min(SPEED_MAX, SPEED_BASE + Math.floor(u / SPEED_RAMP_UNITS));
}

function gapStepsFor(u, turn) {
  const base = turn ? GAP_STEPS_TURN : GAP_STEPS_HOLD;
  const floor = turn ? GAP_FLOOR_TURN : GAP_FLOOR_HOLD;
  return Math.max(floor, base - Math.floor(u / GAP_RAMP_UNITS));
}

// The world distance that buys `steps` of free time after the earlier item has
// cleared the vehicle. speedAt only ever rises with distance, so a gap sized at
// the speed where it is GENERATED would be too short at the speed it is DRIVEN
// at. Iterating up from that lower bound converges (each pass moves the answer
// by a small fraction of the last move) and the last pass asks past the far end
// of the pair, so the answer is never an under-estimate.
function gapUnits(fromY, steps) {
  let g = GAP_SPAN + Math.ceil(steps * speedAt(fromY) / SUB);
  g = GAP_SPAN + Math.ceil(steps * speedAt(fromY + g) / SUB);
  g = GAP_SPAN + Math.ceil(steps * speedAt(fromY + g + CAR_BOT) / SUB);
  return g;
}

function laneX(road, lane) {
  return LANE_X[road] + lane * LANE_GAP;
}

function carX(sim, road) {
  return LANE_X[road] + sim.prog[road] * LANE_STEP;
}

// The lane the vehicle must be in when this item arrives. A round one must be
// collected, so its own lane; a square one must be avoided, so the other.
function reqLane(kind, lane) {
  return kind === ROUND ? lane : 1 - lane;
}

// One item of one road: three draws, always, whichever branch is taken.
function makeItem(sim, road) {
  const k = sim.made[road];
  const rng = itemRng(sim.seedInt, road, k);
  const laneRoll = rng() >>> 31;
  const kindRoll = rng() % SQ_SCALE;
  const gapRoll = rng();
  const warm = k < WARM_ITEMS;
  const kind = warm ? ROUND : (kindRoll < SQ_CHANCE ? SQUARE : ROUND);
  let lane = warm ? 0 : (laneRoll === 1 ? 1 : 0);
  let req = reqLane(kind, lane);
  if (!warm && sim.reqRun[road] >= MAX_SAME_REQ) {
    req = 1 - sim.lastReq[road];
    lane = kind === ROUND ? req : 1 - req;
  }
  const prevY = sim.lastY[road];
  const turn = sim.lastReq[road] >= 0 && req !== sim.lastReq[road];
  let wy;
  if (prevY < 0) {
    wy = FIRST_Y[road];
  } else {
    const base = gapStepsFor(prevY, turn);
    wy = prevY + gapUnits(prevY, base + (gapRoll % (1 + Math.floor(base / 2))));
  }
  sim.made = sim.made.slice();
  sim.made[road] = k + 1;
  sim.lastY = sim.lastY.slice();
  sim.lastY[road] = wy;
  sim.reqRun = sim.reqRun.slice();
  sim.reqRun[road] = sim.lastReq[road] === req ? sim.reqRun[road] + 1 : 1;
  sim.lastReq = sim.lastReq.slice();
  sim.lastReq[road] = req;
  sim.items = sim.items.map(function (list, i) {
    return i === road ? list.concat([{ wy: wy, lane: lane, kind: kind, req: req, n: k }]) : list;
  });
}

function killSim(sim, cause) {
  sim.dead = true;
  sim.deathFrame = sim.frames;
  sim.deathCause = cause;
}

// Items on a road are in order of world position and all move together, so only
// the one at the front of the list can resolve. A round one overlapping the
// vehicle is collected, a square one ends the run. Only a barrier is fatal:
// a round one that goes by untouched is just a miss, not a death, so the
// penalty for a bad decision on one road is losing a point, not the run.
function resolveRoad(sim, road) {
  const list = sim.items[road];
  const vx = carX(sim, road);
  let cut = 0;
  sim.outcome = sim.outcome.slice();
  sim.outcome[road] = null;
  while (cut < list.length) {
    const it = list[cut];
    const top = sim.scrollSub - it.wy * SUB;
    if (top <= (CAR_TOP - ITEM_H) * SUB) break;
    if (top < CAR_BOT * SUB) {
      if (Math.abs(laneX(road, it.lane) - vx) >= HIT_SPAN) break;
      if (it.kind === SQUARE) { killSim(sim, 'barrier'); return; }
      sim.score++;
      sim.taken++;
      sim.outcome[road] = 'taken';
      cut++;
      continue;
    }
    if (it.kind === ROUND) { sim.missed++; sim.outcome[road] = 'missed'; cut++; continue; }
    sim.dodged++;
    cut++;
  }
  if (cut > 0) {
    sim.items = sim.items.map(function (l, i) { return i === road ? l.slice(cut) : l; });
  }
}

function initSim(seedHex, version) {
  const sim = {
    version: version >= RULES_VERSION ? RULES_VERSION : version,
    seedInt: seedToInt(seedHex), frames: 0, score: 0, scrollSub: 0,
    lane: [0, 0], prog: [0, 0], items: [[], []], made: [0, 0], lastY: [-1, -1],
    reqRun: [0, 0], lastReq: [-1, -1], taps: 0, lastTap: [-1, -1],
    taken: 0, dodged: 0, missed: 0, outcome: [null, null], dead: false, deathFrame: 0, deathCause: '',
  };
  for (let r = 0; r < 2; r++) {
    while (sim.lastY[r] < SPAWN_AHEAD) makeItem(sim, r);
  }
  return sim;
}

// One fixed step, in this order on both sides: scroll, move both vehicles,
// generate whatever has come into range, then resolve road 0 and road 1.
function stepSim(sim) {
  if (sim.dead) return;
  sim.scrollSub += speedAt(Math.floor(sim.scrollSub / SUB));
  const prog = sim.prog.slice();
  for (let r = 0; r < 2; r++) {
    const want = sim.lane[r] * SWITCH_STEPS;
    if (prog[r] < want) prog[r]++;
    else if (prog[r] > want) prog[r]--;
  }
  sim.prog = prog;
  const u = Math.floor(sim.scrollSub / SUB);
  for (let r = 0; r < 2; r++) {
    while (sim.lastY[r] < u + SPAWN_AHEAD) makeItem(sim, r);
  }
  resolveRoad(sim, 0);
  if (!sim.dead) resolveRoad(sim, 1);
  sim.frames++;
}

// A tap flips that road's target lane, even in the middle of a switch: the
// vehicle turns back from wherever it is, so a tap is never dropped or queued.
// It lands BEFORE the step it names runs. One tap per side per step; the two
// sides never block each other. A tap inside the start guard is refused, so
// the press that started the run can never be a move.
function tapSim(sim, road) {
  if (sim.dead || (road !== 0 && road !== 1)) return false;
  if (sim.frames < START_GUARD_STEPS) return false;
  if (sim.lastTap[road] === sim.frames) return false;
  sim.lastTap = sim.lastTap.slice();
  sim.lastTap[road] = sim.frames;
  sim.lane = sim.lane.slice();
  sim.lane[road] = 1 - sim.lane[road];
  sim.taps++;
  return true;
}
// ==== END RULES BLOCK ====

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// The rules allow at most one tap PER SIDE per step, so an hour of play is at
// most two taps a step. A WORK bound far above any real run: it REFUSES further
// inputs, it never zeroes, and it stops a huge trace becoming a CPU sink.
const MAX_INPUTS = 2 * MAX_SIM_STEPS;
// A tap that leaves this little time before the next item on that road reaches
// the vehicle could not have been a plan. Recorded for the bot detector, never
// gated.
const LATE_TAP_STEPS = SWITCH_STEPS + 1;
// Two taps this close together are one two-thumbed movement, not two decisions.
const CROSS_STEPS = 2;

function advanceTo(sim, step) {
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepSim(sim);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing would
// apply a malformed step as if it were real.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0,
    rejectCount: 0,
    score: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: newStats(),
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// None of this is a rule and none of it gates anything. It is computed from
// the replay's own state at each tap, so it cannot be forged separately from
// the trace, and it is recorded in finalize().debug for the humanness layer.
function newStats() {
  return {
    taps: [0, 0], late: [0, 0], needless: [0, 0],
    margins: [[], []], steps: [[], []], sinceResolve: [0, 0], laneAtResolve: [0, 0],
    resolved: [0, 0], cross: 0, lastAny: -1, noItem: [0, 0],
  };
}

// Steps until the front item of this road reaches the vehicle's band, at the
// speed the world is scrolling now. Null when that road is empty.
function marginSteps(sim, road) {
  const list = sim.items[road];
  if (!list.length) return null;
  const target = (list[0].wy + CAR_TOP - ITEM_H) * SUB;
  const left = target - sim.scrollSub;
  if (left < 0) return 0;
  const v = speedAt(Math.floor(sim.scrollSub / SUB));
  return Math.floor(left / v);
}

function noteResolves(state) {
  const sim = state.sim;
  const st = state.stats;
  for (let r = 0; r < 2; r++) {
    const done = sim.made[r] - sim.items[r].length;
    if (done !== st.resolved[r]) {
      st.resolved[r] = done;
      st.sinceResolve[r] = 0;
      st.laneAtResolve[r] = sim.lane[r];
    }
  }
}

function noteTap(state, road) {
  const sim = state.sim;
  const st = state.stats;
  st.taps[road]++;
  const m = marginSteps(sim, road);
  if (m === null) st.noItem[road]++;
  else {
    st.margins[road].push(m);
    if (m <= LATE_TAP_STEPS) st.late[road]++;
  }
  st.steps[road].push(sim.frames);
  st.sinceResolve[road]++;
  // A flip and a flip back with nothing resolving in between changed nothing.
  if (st.sinceResolve[road] >= 2 && sim.lane[road] === st.laneAtResolve[road]) st.needless[road]++;
  if (st.lastAny >= 0 && sim.frames - st.lastAny <= CROSS_STEPS) st.cross++;
  st.lastAny = sim.frames;
}

function mean(xs) {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

function round3(v) {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
}

function gapCv(steps) {
  if (steps.length < 3) return null;
  const g = [];
  for (let i = 1; i < steps.length; i++) g.push(steps[i] - steps[i - 1]);
  const m = mean(g);
  const s = sd(g);
  return m > 0 && s !== null ? s / m : null;
}

function sideStats(st, road) {
  const n = st.taps[road];
  return {
    taps: n,
    marginMean: round3(mean(st.margins[road])),
    marginSd: round3(sd(st.margins[road])),
    lateShare: n ? round3(st.late[road] / n) : null,
    gapCv: round3(gapCv(st.steps[road])),
    needless: st.needless[road],
    noItem: st.noItem[road],
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function processEvent(state, event) {
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= 2 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'tap') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, side, step } = payload;
  if (!isStep(n) || !isStep(step) || (side !== 0 && side !== 1)) return reject(state, 'bad_tap');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would let an attacker re-run the
  // same window and keep the best outcome. A repeat of the current step is
  // allowed through to tapSim, which refuses a second tap on that SIDE.
  if (step < sim.frames) return reject(state, 'frame_regressed');

  advanceTo(sim, step);
  noteResolves(state);
  if (sim.dead) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  // The tap names its index in the run. Any other index is out of order (a
  // stolen or reshuffled trace) and is refused whole.
  if (n !== sim.taps) return reject(state, 'out_of_order');
  noteTap(state, side);
  // The client only records a tap it applied, so a refused one is forged.
  if (!tapSim(sim, side)) return reject(state, 'refused');
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always dies inside this bound. Only the
// submit replay passes elapsedSecs; the live stream keeps the session bound.
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
  // Run the world out past the last input. A run that stops acting dies within
  // MAX_SAME_REQ items, because a road never asks for the same lane longer.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepSim(sim);
    guard++;
  }
  const st = state.stats;
  const totalTaps = st.taps[0] + st.taps[1];
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame, deathCause: sim.deathCause,
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      taps: totalTaps, taken: sim.taken, dodged: sim.dodged,
      scroll: Math.floor(sim.scrollSub / SUB), endSpeed: speedAt(Math.floor(sim.scrollSub / SUB)),
      left: sideStats(st, 0), right: sideStats(st, 1),
      crossShare: totalTaps ? round3(st.cross / totalTaps) : null,
      needless: st.needless[0] + st.needless[1],
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
    RULES_VERSION, initSim, stepSim, tapSim, killSim, makeItem, resolveRoad, advanceTo,
    itemRng, seedToInt, speedAt, gapStepsFor, gapUnits, laneX, carX, reqLane,
    MAX_INPUTS, MAX_SIM_STEPS, LATE_TAP_STEPS, CROSS_STEPS, marginSteps,
    DESIGN_W, DESIGN_H, SUB, LANE_X, LANE_GAP, SWITCH_STEPS, LANE_STEP,
    CAR_TOP, CAR_H, CAR_BOT, CAR_HALF, ITEM_H, ITEM_HALF, HIT_SPAN, START_GUARD_STEPS,
    SPEED_BASE, SPEED_RAMP_UNITS, SPEED_MAX, GAP_SPAN, GAP_STEPS_HOLD, GAP_STEPS_TURN,
    GAP_FLOOR_HOLD, GAP_FLOOR_TURN, GAP_RAMP_UNITS, FIRST_Y, WARM_ITEMS, MAX_SAME_REQ,
    SQ_SCALE, SQ_CHANCE, SPAWN_AHEAD, ROUND, SQUARE,
    RNG_STRIDE, RNG_SALT, ROAD_SALT, SEED_MIX,
  },
};
