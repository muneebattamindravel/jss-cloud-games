'use strict';

/**
 * Color Dunk validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a row of hoops in three repeating colours slides left and right
 * under the player's finger. Balls are thrown in from behind the row and land
 * at seeded spots; the hoop under a ball must be its colour. Dead centre is a
 * swish (1 + streak, five in a row start FRENZY), off centre but inside the
 * rim is a basket (1, the streak resets), anything else ends the run.
 *
 * What the server does with a trace:
 *   1. rebuilds the ball stream from the session seed (every ball and fireball
 *      is index-addressed draws from mix(seed, ...), never a running stream);
 *   2. applies each path batch { f, x[] }: x[i] is the row's TARGET during step
 *      f + 1 + i, set before that step runs, exactly as the client does;
 *   3. runs the same fixed 1/60 s steps (the row chases the target at most
 *      RATE a step) and scores every landing itself.
 *
 * The rules block below is the client's js/rules.js between the markers, word
 * for word; shared/tests/colorDunkParity.test.js fails if the two differ.
 * Integers only: + - * / floor min max imul and bit ops. No trig, no clock,
 * no screen, no Math.random, so no dmath.
 */

// COLOR DUNK RULES BEGIN
var CD = (function () {
  'use strict';

  // ── geometry (units: 1000 = one hoop spacing) ────────────────────────────
  var S = 1000;              // hoop to hoop
  var NCOL = 3;              // colours in the row, repeating
  var PERIOD = S * NCOL;     // the row repeats every 3 hoops
  var RIM_R = 400;           // inner rim radius
  var BALL_R = 300;          // ball radius: three quarters of the rim's
  // measured from the rim physics (rimphys.js): rim tube centre 410, tube 36,
  // ball 300. A ball clears the tube only within 70 of the centre; with its
  // centre inside the tube's line it rolls in; past it, it bounces off.
  var SWISH = 70;            // |d| <= 70: a clean swish, no rim
  var BASKET = 405;          // |d| <= 405: hits the rim and rolls in
  var RATE = 260;            // the row chases the finger at most this far a step

  // ── scoring (counted frame by frame from the 2018 game) ──────────────────
  // A swish scores 1 + streak and raises the streak (+2, +3, +4, +5 ...); a rim
  // touch scores 1 and resets it. The 5th swish in a row (+6) starts FRENZY:
  // every hoop wears that colour and fireballs pour in; each catch carries the
  // streak on (+7, +8 ... no cap). When the frenzy clock runs out the streak
  // restarts for the last few fireballs still in the air (+2, +3, +4), and it
  // restarts again when normal play returns. A missed fireball costs nothing.
  var BASKET_PTS = 1;
  var FRENZY_STREAK = 5;
  // Measured from the 2018 recording's own sounds and score counter: the
  // first fireball lands 1.9 s after the trigger, the next 0.52 s later, then
  // one every 0.42 s, the same beat in every frenzy. Nine carry the streak
  // (+7 ... +15), three more land after it (+2 +3 +4): about 6.5 s in all.
  var FRENZY_STEPS = 330;    // the streak-carrying part of frenzy (5.5 s)
  var FRENZY_TAIL = 66;      // fireballs still landing after it (1.1 s)
  var FRENZY_OFF = 110;      // the lights (and, the first time, the music) come back
  var FRENZY_FIRST = 114;    // the first fireball lands 1.9 s after the trigger
  var FRENZY_GAP1 = 31;      // then the second, 0.52 s later
  var FRENZY_GAP = 25;       // then one every 0.42 s
  var PAUSE_STEPS = 168;     // after the first frenzy: the next ball leaves 2.9 s after the music starts

  // ── pacing (measured from the 2018 game) ─────────────────────────────────
  // Balls come in runs of one colour. Each ball is a real throw from behind
  // the row: 1.33 s at the start, 1.0 s by the 16th ball. A ball of the same
  // colour lands about 1.45 s after the last one at the start; a new colour
  // gets about 1.4 s more. Both gaps close as the game goes on, until two balls
  // share the air. Stacks (two or three of one colour in a column, 0.2 s
  // apart) appear from the start; triples (three colours side by side, into
  // three neighbouring hoops) from the middle of a run.
  var START_STEPS = 200;     // the first ball lands 3.3 s after the start
  var LOOKAHEAD = 300;       // balls are generated this far ahead of now
  var LVL_MAX = 30;
  var X_MAX = 750;           // a ball lands anywhere within 3/4 of a hoop of the centre
  var X_SIDE = 250;          // the middle ball of a side-by-side pattern
  var STACK_STEPS = 12;      // balls in a stack land 0.2 s apart

  // ── RAPID FIRE (rules v3) ────────────────────────────────────────────────
  // A wave of about 10 s where every ball is a new colour, at a fresh spot.
  // The gap between landings shrinks with the level: 1.5 to 2 s early, 1 to
  // 1.5 s mid game, 0.7 to 1 s late. It first comes after a few patterns and
  // then every 8 to 12 patterns. v3 also drops 'mixstack' (three colours in
  // one column 0.2 s apart), which no hand could follow.
  var RAPID_LV = 4;          // first possible at ball 8
  var RAPID_STEPS = 600;     // the wave lasts about 10 s of landings
  var RAPID_FIRST = 5;       // the first wave comes at pattern 5..7
  var RAPID_EVERY = 8;       // then every 8..11 patterns
  // r in [0, 31) spreads the gap across its band (steps of 1/60 s)
  function rapidGap(lv, r) {
    if (lv < 10) return 90 + r;                      // 1.5 to 2 s
    if (lv < 20) return 60 + r;                      // 1 to 1.5 s
    return 42 + Math.floor(r * 18 / 30);             // 0.7 to 1 s
  }

  function u32(x) { return x >>> 0; }
  function mix(a, b, c) {
    var h = u32(a ^ Math.imul(b + 0x9e3779b9 | 0, 0x85ebca6b));
    h = u32(Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ c);
    h = u32(Math.imul(h ^ (h >>> 16), 0x27d4eb2f));
    h ^= h >>> 15;
    return u32(h);
  }
  // draw j of block p, in [0, n); index-addressed, so unused draws cost nothing
  function draw(seed, p, j, n) { return mix(seed, p * 64 + j, 0x51ed270b) % n; }

  function mod(a, n) { var r = a % n; return r < 0 ? r + n : r; }
  // the carousel offset at which hoop colour c sits exactly under x = L
  function reqOffset(L, c) { return mod(c * S - L, PERIOD); }
  // shortest travel between two offsets on the repeating row
  function travel(a, b) { var d = mod(b - a, PERIOD); return d > PERIOD / 2 ? PERIOD - d : d; }

  // the level climbs every two balls of normal play (fireballs do not count)
  function level(nBalls) { return Math.min(LVL_MAX, Math.floor(nBalls / 2)); }
  function flightSteps(lv) { return Math.max(58, 80 - 3 * lv); }
  function sameGap(lv) { return Math.max(40, 87 - Math.floor(8 * lv / 5)); }
  function changeExtra(lv) { return Math.max(18, 84 - Math.floor(12 * lv / 5)); }
  function frenzyGap(i) { return i === 1 ? FRENZY_GAP1 : FRENZY_GAP; }

  function addBall(sim, c, L, land, lv) {
    var f = flightSteps(lv);
    // never launch a ball in the past: it would appear mid-air
    land = Math.max(land, sim.frames + f + 1);
    var b = { n: sim.nextBall, colour: c, landX: L, launchX: L, land: land, launch: land - f, arc: 0 };
    sim.nextBall = sim.nextBall + 1;
    sim.balls = sim.balls.concat([b]);
    sim.genLand = land;
    return b;
  }

  // ── patterns ─────────────────────────────────────────────────────────────
  // The stream is a chain of short patterns. Early on they are long runs of
  // one colour; as the level climbs, patterns that change colour more often
  // unlock and win more of the draws, and runs get shorter. A breather (an
  // easy run) is still slipped in now and then, so the rhythm keeps breaking.
  // Steps: [colour, x, kind]  colour 0 = A (the pattern's colour), 1 = B, 2 = C
  //   (B and C are the other two, in a random order); x: 0 a fresh spot,
  //   1 the spot of the step before; kind: 0 a single, 1 lands with the step
  //   before (side by side), 2 lands 0.2 s after it (a stack).
  var PATTERNS = [
    // [name, unlock level, weight early, weight late, hard, steps]
    ['run3',     0, 40,  6, 0, [[0,0,0],[0,0,0],[0,0,0]]],
    ['run4',     0, 30,  2, 0, [[0,0,0],[0,0,0],[0,0,0],[0,0,0]]],
    ['run2',     1, 20, 14, 0, [[0,0,0],[0,0,0]]],
    ['stack2',   3, 14, 10, 0, [[0,0,0],[0,1,2]]],
    ['stack3',   6, 10, 10, 1, [[0,0,0],[0,1,2],[0,1,2]]],
    ['swap',     5, 14, 16, 0, [[0,0,0],[0,0,0],[1,0,0],[1,0,0]]],
    ['zigzag',   8,  6, 16, 1, [[0,0,0],[1,0,0],[0,0,0],[1,0,0]]],
    ['rainbow', 10,  6, 16, 1, [[0,0,0],[1,0,0],[2,0,0]]],
    ['double',  12,  4, 14, 1, [[0,0,0],[1,0,1]]],
    ['triple',  14,  4, 12, 1, [[0,0,0],[1,0,1],[2,0,1]]],
    ['stacks',  16,  4, 12, 1, [[0,0,0],[0,1,2],[1,0,0],[1,1,2]]],
    ['chase',   20,  2, 16, 1, [[0,0,0],[1,0,0],[2,0,0],[0,0,0],[1,0,0]]],
    ['mixstack',22,  2, 10, 1, [[0,0,0],[1,1,2],[2,1,2]]],
  ];
  var NPAT = PATTERNS.length;
  var LATE = 26;             // weights slide from "early" to "late" by this level

  function pickPattern(sim, lv) {
    var seed = sim.seed, i = sim.genItem;
    // after two hard patterns in a row, half the time an easy one
    if (sim.genHard >= 2 && draw(seed, i, 50, 2) === 0) return draw(seed, i, 51, 2) === 0 ? 0 : 2;
    var t = Math.min(LATE, lv), total = 0, k, w = [];
    for (k = 0; k < NPAT; k++) {
      var P = PATTERNS[k], wk = 0;
      if (P[1] <= lv && k !== sim.genLastPat && !(sim.version >= 3 && P[0] === 'mixstack')) wk = Math.floor((P[2] * (LATE - t) + P[3] * t) / LATE) + 1;
      w.push(wk); total = total + wk;
    }
    var r = draw(seed, i, 52, total);
    for (k = 0; k < NPAT; k++) { if (r < w[k]) return k; r = r - w[k]; }
    return 0;
  }

  // RAPID FIRE: every ball a new colour, a fresh spot, a short gap (v3)
  function genRapid(sim, lv) {
    var seed = sim.seed, i = sim.genItem, prev = sim.genColour, land = sim.genLand, j = 0, end = -1;
    sim.genItem = i + 1;
    sim.genLastPat = -1;
    sim.genHard = 0;
    sim.rfNext = i + 1 + RAPID_EVERY + draw(seed, i, 61, 4);
    sim.rapids = sim.rapids + 1;
    while (end < 0 || land < end) {
      var c = prev < 0 ? draw(seed, i, 0, NCOL) : mod(prev + 1 + draw(seed, i, 100 + j, 2), NCOL);
      var x = draw(seed, i, 200 + j, X_MAX * 2 + 1) - X_MAX;
      var gap = j === 0 ? sameGap(lv) + changeExtra(lv) : rapidGap(lv, draw(seed, i, 300 + j, 31));
      if (sim.genFresh) { gap = sim.nextBall ? flightSteps(lv) + 6 : 0; sim.genFresh = 0; }
      var b = addBall(sim, c, x, land + gap, lv);
      b.rf = j === 0 ? 2 : 1;
      land = b.land;
      if (j === 0) end = land + RAPID_STEPS;
      prev = c;
      sim.waveBalls = sim.waveBalls + 1;
      j = j + 1;
    }
    sim.genColour = prev;
    sim.genLevel = lv;
  }

  function genItem(sim) {
    var seed = sim.seed, i = sim.genItem, lv = level(sim.waveBalls);
    if (sim.version >= 3 && lv >= RAPID_LV && i >= sim.rfNext) { genRapid(sim, lv); return; }
    var pk = pickPattern(sim, lv), P = PATTERNS[pk], steps = P[5];
    sim.genItem = i + 1;
    sim.genLastPat = pk;
    sim.genHard = P[4] ? sim.genHard + 1 : 0;
    // A: a new colour for the pattern (later on, a calm run may carry the last one on)
    var A = sim.genColour < 0 ? draw(seed, i, 0, NCOL)
      : P[4] === 0 && lv >= 10 && draw(seed, i, 1, 4) === 0 ? sim.genColour : mod(sim.genColour + 1 + draw(seed, i, 0, 2), NCOL);
    var flip = draw(seed, i, 2, 2);
    var cols = [A, mod(A + 1 + flip, NCOL), mod(A + 2 - flip, NCOL)];
    var x = 0, land = sim.genLand, prev = sim.genColour, j;
    for (j = 0; j < steps.length; j++) {
      var st = steps[j], c = cols[st[0]];
      // a pattern with balls side by side stays near the centre, so its neighbours are on screen
      var xr = steps.length > 1 && steps[1][2] === 1 ? X_SIDE : X_MAX;
      if (st[1] === 0 && st[2] !== 1) x = draw(seed, i, 10 + j, xr * 2 + 1) - xr;
      var bx = x;
      if (st[2] === 1) {
        // side by side: the neighbouring hoop of this colour, on the side that stays on screen
        var dk = mod(c - prev, NCOL) === 1 ? 1 : -1;
        bx = x + dk * S;
      } else if (st[2] === 2) {
        land = land + STACK_STEPS;
      } else {
        var gap = sameGap(lv) + (c !== prev ? changeExtra(lv) : 0);
        if (sim.genFresh) { gap = sim.nextBall ? flightSteps(lv) + 6 : 0; sim.genFresh = 0; }
        land = land + gap;
      }
      var b = addBall(sim, c, bx, land, lv);
      land = b.land;
      if (st[2] !== 1) { prev = c; }
      sim.waveBalls = sim.waveBalls + 1;
    }
    sim.genColour = prev;
    sim.genLevel = lv;
  }

  // the frenzy stream: fireballs anywhere along the row, a few a second
  function genFrenzyBall(sim) {
    var seed = sim.seed;
    var p = 1000000 + sim.frenzyN * 4096 + sim.frenzyI;
    var L = draw(seed, p, 0, X_MAX * 2 + 1) - X_MAX;
    var land = sim.frenzyI === 0 ? sim.frenzyStart + FRENZY_FIRST : sim.genLand + frenzyGap(sim.frenzyI);
    var b = addBall(sim, sim.frenzyColour, L, land, 12);
    b.fz = 1;
    sim.frenzyI = sim.frenzyI + 1;
  }

  // drop every ball that has not left yet, and restart generation after `from`
  function cutQueue(sim, f, from) {
    var keep = [], last = f, i;
    for (i = 0; i < sim.balls.length; i++) {
      var b = sim.balls[i];
      if (b.launch > f) { b.cut = 1; continue; }
      keep.push(b);
      if (b.land > last) last = b.land;
    }
    sim.balls = keep;
    sim.genLand = Math.max(last, from);
  }

  function generate(sim, f) {
    while (sim.genLand < f + LOOKAHEAD) {
      if (sim.frenzy && !sim.frenzyDone) {
        if (sim.frenzyI === 0 || sim.genLand + frenzyGap(sim.frenzyI) <= sim.frenzyEnd + FRENZY_TAIL) { genFrenzyBall(sim); continue; }
        // the stream is out: the lights come back, then normal play
        sim.frenzyDone = 1;
        sim.genLand = Math.max(sim.genLand, sim.frenzyOff) + (sim.frenzies === 1 ? PAUSE_STEPS : 0);
        sim.genFresh = 1;
        continue;
      }
      genItem(sim);
    }
  }

  function seedToInt(seedHex) {
    var h = 2166136261 >>> 0, s = String(seedHex || '');
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  function initSim(seedHex, version) {
    return {
      version: version || 2, seed: seedToInt(seedHex),
      frames: 0, offset: 0, target: 0,
      score: 0, streak: 0, best: 0, swishes: 0, baskets: 0, catches: 0,
      dead: 0, deathStep: -1, deathBall: -1,
      balls: [], nextBall: 0, waveBalls: 0,
      genLand: START_STEPS, genColour: -1, genItem: 0, genLevel: 0, genFresh: 1, genLastPat: -1, genHard: 0,
      frenzy: 0, frenzyStart: 0, frenzyEnd: 0, frenzyOff: 0, frenzyN: 0, frenzyI: 0, frenzyDone: 1,
      frenzyColour: 0, frenzies: 0, fzTail: 0,
      rfNext: RAPID_FIRST + draw(seedToInt(seedHex), 0, 60, 3), rapids: 0,
      events: [],
    };
  }

  function setTarget(sim, x) { sim.target = Math.floor(x); }

  function stepSim(sim) {
    if (sim.dead) { sim.events = []; return; }
    var ev = [];
    // the row chases the finger, at most RATE a step
    var diff = sim.target - sim.offset;
    sim.offset = sim.offset + Math.max(-RATE, Math.min(RATE, diff));
    var f = sim.frames + 1;
    sim.frames = f;
    if (sim.frenzy && !sim.fzTail && f >= sim.frenzyEnd) { sim.fzTail = 1; sim.streak = 0; }
    if (sim.frenzy && f >= sim.frenzyOff) {
      sim.frenzy = 0; sim.fzTail = 0;
      sim.streak = 0;
      ev.push({ type: 'frenzy', on: 0, step: f, pause: sim.frenzies === 1 ? 1 : 0 });
    }
    generate(sim, f);

    var keep = [], i, startFrenzy = -1;
    for (i = 0; i < sim.balls.length; i++) {
      var b = sim.balls[i];
      if (b.rf === 2 && b.launch === f && !b.fz) ev.push({ type: 'rapid', step: f, n: b.n });
      if (b.land !== f) { if (b.land > f) keep.push(b); continue; }
      // which hoop is under the ball, and how far off centre
      var pos = b.landX + sim.offset;
      var k = Math.floor((pos + S / 2) / S);
      var d = pos - k * S;
      var ad = d < 0 ? -d : d;
      var hc = mod(k, NCOL);
      var r = { n: b.n, colour: b.colour, hoop: k, hoopColour: hc, d: d, step: f, pts: 0 };
      if (b.fz) {
        // every hoop is the frenzy colour: any hoop catches a fireball
        if (ad <= BASKET) {
          sim.streak = sim.streak + 1;
          r.type = ad <= SWISH ? 'fswish' : 'fbasket';
          r.pts = 1 + sim.streak;
          sim.catches = sim.catches + 1;
        } else {
          r.type = 'fmiss';
        }
      } else if (hc === b.colour && ad <= SWISH) {
        sim.streak = sim.streak + 1;
        r.type = 'swish'; r.pts = 1 + sim.streak;
        sim.swishes = sim.swishes + 1;
        if (sim.streak >= FRENZY_STREAK && startFrenzy < 0 && !sim.frenzy) startFrenzy = b.colour;
      } else if (hc === b.colour && ad <= BASKET) {
        sim.streak = 0;
        r.type = 'basket'; r.pts = BASKET_PTS;
        sim.baskets = sim.baskets + 1;
      } else {
        r.type = hc === b.colour ? 'rimout' : 'wrong';
        sim.dead = 1; sim.deathStep = f; sim.deathBall = b.n;
      }
      sim.score = sim.score + r.pts;
      if (sim.streak > sim.best) sim.best = sim.streak;
      r.streak = sim.streak; r.score = sim.score;
      ev.push(r);
      if (sim.dead) break;
    }
    if (!sim.dead) {
      sim.balls = keep;
      if (startFrenzy >= 0) {
        sim.frenzies = sim.frenzies + 1;
        sim.frenzy = 1; sim.frenzyDone = 0; sim.frenzyColour = startFrenzy; sim.fzTail = 0;
        sim.frenzyStart = f; sim.frenzyEnd = f + FRENZY_STEPS; sim.frenzyOff = f + FRENZY_STEPS + FRENZY_OFF;
        sim.frenzyN = sim.frenzies; sim.frenzyI = 0;
        cutQueue(sim, f, f);
        // balls already in the air turn into fireballs too
        for (i = 0; i < sim.balls.length; i++) { sim.balls[i].colour = startFrenzy; sim.balls[i].fz = 1; }
        ev.push({ type: 'frenzy', on: 1, step: f, end: sim.frenzyOff, colour: startFrenzy });
        generate(sim, f);
      }
    }
    sim.events = ev;
  }

  return {
    S: S, NCOL: NCOL, PERIOD: PERIOD, RIM_R: RIM_R, BALL_R: BALL_R, SWISH: SWISH, BASKET: BASKET,
    X_MAX: X_MAX, RATE: RATE, RAPID_LV: RAPID_LV, RAPID_STEPS: RAPID_STEPS, START_STEPS: START_STEPS, LOOKAHEAD: LOOKAHEAD,
    FRENZY_STREAK: FRENZY_STREAK, FRENZY_STEPS: FRENZY_STEPS, PAUSE_STEPS: PAUSE_STEPS,
    mod: mod, reqOffset: reqOffset, travel: travel, level: level, flightSteps: flightSteps,
    initSim: initSim, stepSim: stepSim, setTarget: setTarget, seedToInt: seedToInt,
  };
})();
// COLOR DUNK RULES END

const { initSim, stepSim, setTarget, reqOffset, travel, mod, level, flightSteps } = CD;

// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A path batch is at most this many samples (the client closes one at 120).
const MAX_BATCH = 120;
// A WORK bound far above any real run: one sample a step for the whole hour.
// It REFUSES further inputs, never zeroes.
const MAX_INPUTS = MAX_SIM_STEPS + 20000;
// A target is a row offset in rules units. It moves at most RATE a step, so an
// honest one never leaves +-RATE * MAX_SIM_STEPS (56 million).
const TARGET_MAX = 1 << 30;

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepWatched(state);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}
function isTarget(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= -TARGET_MAX && v <= TARGET_MAX;
}

function init({ seed, maxDurationSecs, elapsedSecs, onStep } = {}) {
  return {
    mode: 'none', sim: null, onStep: typeof onStep === 'function' ? onStep : null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { err: [], lead: [], nextN: -1, settledAt: -1, travel: 0, need: 0, prevReq: null,
      overshoots: 0, lastDir: 0, lastT: 0, samples: 0, landings: 0 },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. For each ordinary ball: how far off centre it landed
// (a program lands every ball dead centre) and how many steps BEFORE landing the
// row had settled within SWISH of the right hoop (a planner settles early and
// evenly, a hand late and unevenly). For the drag: the target's travel against
// the travel the balls needed, and how often it turned back (a thumb overshoots).
function nextOrdinary(sim) {
  let nb = null;
  for (const b of sim.balls) if (!b.fz && b.land > sim.frames && (!nb || b.land < nb.land || (b.land === nb.land && b.n < nb.n))) nb = b;
  return nb;
}
function watchStep(state) {
  const sim = state.sim, st = state.stats;
  for (const e of sim.events) {
    if (e.type === 'swish' || e.type === 'basket' || e.type === 'rimout' || e.type === 'wrong') {
      st.landings++;
      st.err.push(Math.abs(e.d));
      if (e.n === st.nextN && st.settledAt >= 0) st.lead.push(sim.frames - st.settledAt);
    }
  }
  if (sim.dead) return;
  const nb = nextOrdinary(sim);
  if (!nb) return;
  if (nb.n !== st.nextN) {
    st.nextN = nb.n; st.settledAt = -1;
    const req = reqOffset(nb.landX, nb.colour);
    if (st.prevReq !== null) st.need += travel(st.prevReq, req);
    st.prevReq = req;
  }
  if (st.settledAt < 0 && travel(mod(sim.offset, CD.PERIOD), reqOffset(nb.landX, nb.colour)) <= CD.SWISH) st.settledAt = sim.frames;
}
function noteTarget(st, v) {
  const d = v - st.lastT;
  if (d !== 0) {
    st.travel += Math.abs(d);
    const dir = d > 0 ? 1 : -1;
    if (st.lastDir !== 0 && dir !== st.lastDir) st.overshoots++;
    st.lastDir = dir;
  }
  st.lastT = v;
  st.samples++;
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function stepWatched(state) {
  stepSim(state.sim);
  watchStep(state);
  if (state.onStep) state.onStep(state.sim);
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
      // the rules the run was played under: v2 runs keep the v2 stream
      state.sim = initSim(state.seed, Number(payload.v) >= 3 ? 3 : 2);
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  const sim = state.sim;
  if (kind !== 'path') return { accepted: true, newScore: state.score };

  const { f, x } = payload;
  if (!isStep(f) || !Array.isArray(x) || x.length < 1 || x.length > MAX_BATCH) return reject(state, 'bad_path');
  for (let i = 0; i < x.length; i++) if (!isTarget(x[i])) return reject(state, 'bad_path');
  if (state.inputCount + x.length > MAX_INPUTS) return reject(state, 'input_cap');
  // A batch may never reach back into steps already run: a rewind would
  // re-run a window and keep the best outcome. Refused whole.
  if (f < sim.frames) return reject(state, 'frame_regressed');
  advanceTo(state, f);
  if (sim.dead) { state.dead = true; state.score = sim.score; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  if (sim.frames !== f) return reject(state, 'beyond_cap');
  state.inputCount += x.length;
  for (let i = 0; i < x.length && !sim.dead && sim.frames < MAX_SIM_STEPS; i++) {
    setTarget(sim, x[i]);
    noteTarget(state.stats, sim.target);
    stepWatched(state);
  }
  state.score = sim.score;
  if (sim.dead) { state.dead = true; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only ever drops
// time, never adds it, so an honest run always dies inside this bound.
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
  // Run the world out past the last input. A row that stops moving dies at
  // the next ball that does not land in its own colour.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepWatched(state);
    guard++;
  }
  const st = state.stats;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.frames, deathStep: sim.deathStep, deathBall: sim.deathBall,
      score: sim.score, swishes: sim.swishes, baskets: sim.baskets, catches: sim.catches,
      frenzies: sim.frenzies, best: sim.best, dead: !!sim.dead,
      inputs: state.inputCount, rejects: state.rejectCount, samples: st.samples,
      errMean: round3(mean(st.err)), errSd: round3(sd(st.err)),
      leadMean: round3(mean(st.lead)), leadSd: round3(sd(st.lead)),
      travelRatio: st.need > 0 ? round3(st.travel / st.need) : null,
      overshootsPerBall: st.landings ? round3(st.overshoots / st.landings) : null,
      swishShare: st.landings ? round3(sim.swishes / st.landings) : null,
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
  _sim: { CD, initSim, stepSim, setTarget, reqOffset, travel, mod, level, flightSteps, advanceTo,
    MAX_SIM_STEPS, MAX_BATCH, MAX_INPUTS, TARGET_MAX },
};
