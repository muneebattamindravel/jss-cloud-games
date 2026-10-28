'use strict';

/**
 * Oh Bhains validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Oh Bhains was built on replay, so there is no plausibility path: a trace
 * without a v2 start marker is not a run and scores zero.
 *
 * The game: a village runner chased by a buffalo through six kinds of section
 * (track, canal swim, rooftops, wall climb, kites, sugarcane). Tap to jump or
 * stroke, swipe up to vault, down to slide, left and right to change lane. The
 * score is metres run plus bonus; the buffalo catching the runner ends the run.
 *
 * What the server does with a trace:
 *   1. rebuilds the course from the session seed (CR.seedInt of its hex);
 *   2. applies each accepted input { n, a, step } before step `step` runs,
 *      exactly as the client does (at most two inputs on one step);
 *   3. runs the same fixed steps and reads the score the rules compute.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD from games/oh-bhains/js/rules.js
 * (between the OH BHAINS RULES markers). shared/tests/ohBhainsParity.test.js
 * fails the moment one copy changes without the other. A gameplay change is a
 * trace version bump, never an edit in place.
 *
 * Integer arithmetic only (+ - * / floor and Math.imul): no trig, no pow, no
 * Math.random, no clock and no screen, so no dmath is needed.
 */

/* eslint-disable no-var */
// OH BHAINS RULES BEGIN
var CR = (function () {
  var STEP_HZ = 60;
  var V_BASE = 88, V_RAMP_PER = 12000, V_RAMP_CAP = 70, V_PER_STREAK = 8, STREAK_CAP = 8, V_STUMBLE = 30, ACCEL = 2;
  var A_NONE = 0, A_JUMP = 1, A_SLIDE = 2, A_VAULT = 3, A_LEFT = 4, A_RIGHT = 5;
  // jump, slide, swipe-up jump. A tap on the track IS a swipe up: one jump for everything.
  var LEN = [0, 4000, 3000, 4000];
  var LANE_W = 1100, LANE_STEPS = 9;
  // sections: the run cycles track, swim, the village rooftops, climb, glide, the
  // sugarcane field. Rooftops and sugarcane are run sections like the track.
  var S_TRACK = 0, S_SWIM = 1, S_CLIMB = 2, S_GLIDE = 3, S_ROOF = 4, S_CANE = 5;
  var SEC_CYCLE = [S_TRACK, S_SWIM, S_ROOF, S_CLIMB, S_GLIDE, S_CANE];
  var TRACK_LEN = 170000, TRACK_SPREAD = 50000, SWIM_LEN = 75000, TOWER_H = 18000, GLIDE_LEN = 110000;
  var ROOF_LEN = 125000, ROOF_SPREAD = 30000, CANE_LEN = 105000, CANE_SPREAD = 25000;
  // the rooftops end with stairs down and open ground before the tower (ROOF_OUT), so
  // the climb camera never sits inside a house: no rows in the last 22 m
  var SEC_LEAD = [16000, 9000, 3500, 16000, 12000, 12000], SEC_TAIL = [16000, 7000, 3000, 12000, 22000, 10000];
  var CHASE_PCT = [100, 70, 22, 88, 100, 100];
  // rows: one row of obstacles across the three lanes, or one full-width obstacle
  var R_LANES = 1, R_GAP = 2, R_ROPE = 3, R_KABADDI = 4, R_SACK = 5, R_ROOF = 6, R_NONE = 0;
  var C_EMPTY = 0, C_HURDLE = 1, C_BAR = 2, C_WALL = 3, C_POT = 4, C_CART = 5, C_LOG = 6, C_DROP = 7, C_KITE = 8;
  // village obstacles: a haystack and a flock are soft (run into them and you only lose
  // speed), a charpai bounces a runner who lands on it high over the next row
  var C_HAY = 9, C_FLOCK = 10, C_CHARPAI = 11;
  // rooftops: a water tank to jump, washing to slide under, the gap between two roofs
  // (jump it or drop to the street and lose time climbing back); sugarcane: a wall of
  // cane that cannot be jumped, so the runner changes lane to the way through
  var C_TANK = 12, C_LINE = 13, C_CANE = 14;
  var ROOF_GAP = 2000, FALL_STEPS = 72, CANE_EXTRA = 4500;
  var HAY_V = 45, FLOCK_PCT = 60, CHARPAI_REACH = 900, BOUNCE_LEN = 7000, BOUNCE_MAX = 13000, BOUNCE_LAND = 1500;
  var GAP_LEN = 2200, GAP_CLEAR = 200, WALL_DEPTH = 600;
  var ROPE_LEN = 3000, SWING_STEPS = 34, MUD_V = 26;
  var SACK_LEN = 10000, HOP_V = 92, HOP_STEPS = 22, HOP_PERFECT = 6, HOP_PTS = 2, SACK_EXIT_V = 63;
  var M_RUN = 0, M_ACT = 1, M_STUN = 2, M_CLIMB = 3, M_SWIM = 4, M_OUT = 5, M_DEAD = 6, M_SWING = 7, M_MUD = 8, M_SACK = 9,
    M_SWIM2 = 10, M_CLIMB2 = 11, M_GLIDE = 12, M_FALL = 13;
  var STUN_STEPS = 26, CRASH_STEPS = 40, CLIMB_STEPS = 54, SWIM_V = 34, OUT_STEPS = 16, INPUT_GUARD = 20;
  // rhythm sections: one fixed beat grid for the whole run, locked to the music's
  // 130 BPM: beat k falls on step beatAt(k) = round(k * 360 / 13). Integers only.
  // a stroke counts within BEAT_OK steps of the beat (about 0.13 s), PERFECT within BEAT_P
  var BEAT_NUM = 360, BEAT_DEN = 13, BEAT_P = 4, BEAT_OK = 8;
  // water, tower and kite: TAP FAST. Every tap is a stroke (at most one every STROKE_GAP
  // steps), no timing to learn; tapping faster goes faster, up to the cap.
  var STROKE_GAP = 4;
  var SWIM_ENTER = 70, SWIM_MIN = 25, SWIM_CAP = 160, SWIM_TAP = 20;
  var REACH_STEPS = 8, REACH_TAP = 55, DROP_SLIP = 2400, DROP_SLIDE = 120, DROP_DAZE = 40;
  var GLIDE_BASE = 150, GLIDE_CAP = 230, GLIDE_TAP = 8, KITE_V = 90;
  var CV0 = 89, CV_MAX = 216, CV_EVERY = 600, CHASE_GUARD = 100, START_GAP = 8000, GAP_MAX = 14000, CATCH = 700;
  var CHARGE_EVERY = 600, CHARGE_WARN = 90, CHARGE_STEPS = 60, CHARGE_V = 45, TWO_AT = 2500000, TWO_V = 4, CHARGE_FIRST = 4;
  var SPACE_MIN = 5800, SPACE_SPREAD = 4000, SPACE_SHRINK = 60, SHRINK_CAP = 30, WALL_EXTRA = 1500;
  var COMBO_FROM = 10, COMBO_SPACE = 4600, COMBO_SPREAD = 600;
  // DIFFICULTY GROWS WITH DISTANCE (founder, 8 Oct 2026: the start was too busy, and the game
  // should keep getting harder). x is millimetres along the run.
  // extra room between rows at the start, shrinking to nothing by EASE_UNTIL
  var EASE_UNTIL = 900000, EASE_ROOM = 4500;
  // obstacle sets unlock by distance: hurdles only, then bars and mud, then walls and carts, then all
  var TIER_AT = [60000, 180000, 380000];
  // quick combos of rows: none before COMBO_AT, then 1, 2, 3 in 8 at COMBO_MORE
  var COMBO_AT = 250000, COMBO_MORE = [1000000, 2200000];
  // full-width rows (canal, rope, sack race): from FULL_AT, more often and more kinds with distance
  var FULL_AT = 60000;
  // speed keeps creeping up after the first ramp: +1 every V_RAMP2_PER, up to V_RAMP2_CAP more
  var V_RAMP2_PER = 50000, V_RAMP2_CAP = 30;
  // canal, tower and kites: hazard rows come 1% closer every SEC_TIGHT_PER, up to SEC_TIGHT_CAP %
  var SEC_TIGHT_PER = 100000, SEC_TIGHT_CAP = 30;
  var SPACE_SEC = [0, 9000, 2600, 11000], SPREAD_SEC = [0, 5000, 1600, 6000];
  var PICK_FROM = 3, PICK_GAP = 650, PICK_AFTER = 1800, PICK_BEFORE = 3800, PICK_PTS = 5, PICK_LO = 150, PICK_HI = 850;
  var PERFECT_PTS = 10, PERFECT_MULT_CAP = 5;
  var TURBO_EVERY = 5, TURBO_STEPS = 150, TURBO_V = 30, TURBO_PUSH = 5000;
  var WIN = {};
  // [from, to, perfect from, perfect to], in thousandths of the move: how far into
  // the jump or slide the runner may be when he reaches the obstacle
  WIN[C_HURDLE * 4 + A_VAULT] = [80, 920, 300, 700];
  WIN[C_POT * 4 + A_VAULT] = [80, 920, 300, 700];
  WIN[C_WALL * 4 + A_VAULT] = [80, 920, 300, 700];
  WIN[C_BAR * 4 + A_SLIDE] = [60, 900, 250, 650];
  WIN[C_HAY * 4 + A_VAULT] = [80, 920, 300, 700];
  WIN[C_FLOCK * 4 + A_VAULT] = [60, 940, 250, 750];
  WIN[C_CHARPAI * 4 + A_VAULT] = [80, 920, 300, 700];
  WIN[C_TANK * 4 + A_VAULT] = [80, 920, 300, 700];
  WIN[C_LINE * 4 + A_SLIDE] = [60, 900, 250, 650];
  // lane patterns [left, middle, right]; the middle lane is never empty, so a
  // runner who never moves meets something on every row
  var H = C_HURDLE, B = C_BAR, W = C_WALL, P = C_POT, X = C_CART, E = C_EMPTY, Y = C_HAY, F = C_FLOCK, C = C_CHARPAI;
  var T = C_TANK, L = C_LINE, K = C_CANE;
  var ROOFPAT = [[E, T, E], [T, T, T], [L, L, L], [T, L, T], [E, L, E], [L, T, L], [C, T, C], [F, T, F], [E, C, E], [T, E, L]];
  var CANEPAT = [[K, K, E], [K, E, K], [K, K, E], [K, Y, K], [K, F, K], [K, H, K], [E, K, K], [K, K, Y]];
  var PAT = [
    [2, [[E, H, E], [H, H, H], [E, H, H], [H, H, E]]],
    [6, [[E, H, E], [H, H, H], [B, B, B], [E, B, E], [X, H, E], [E, H, X], [H, B, H], [P, P, P], [E, Y, E], [F, F, F], [Y, H, Y]]],
    [12, [[H, H, H], [B, B, B], [X, H, E], [E, B, X], [H, B, H], [P, H, P], [W, W, W], [X, B, X], [E, X, E], [H, X, B], [X, W, E],
      [Y, Y, Y], [F, H, F], [E, C, E], [C, C, C], [Y, B, Y], [X, F, E]]],
    [0, [[H, H, H], [B, B, B], [X, H, E], [E, B, X], [H, B, H], [P, H, P], [W, W, W], [X, B, X], [E, X, E], [H, X, B], [X, W, E], [B, W, H], [X, P, X], [W, X, H],
      [Y, B, Y], [F, Y, F], [C, C, C], [X, C, X], [C, W, C], [Y, X, F], [H, C, H]]]
  ];
  // the kabaddi dive was removed (founder, 8 Oct 2026: too confusing); R_KABADDI stays
  // defined so nothing else breaks, but no row is ever made of it
  var FULL = [R_GAP, R_ROPE, R_GAP, R_SACK, R_ROPE, R_GAP];
  var EV_PERFECT = 1, EV_OK = 2, EV_STUMBLE = 4, EV_SPLASH = 8, EV_BONK = 16, EV_LAND = 32, EV_CAUGHT = 64, EV_ACT = 128, EV_UP = 256,
    EV_PICK = 512, EV_TURBO = 1024, EV_WARN = 2048, EV_CHARGE = 4096, EV_TWO = 8192, EV_MUD = 16384, EV_SACK = 32768,
    EV_HOP = 65536, EV_HOPPERFECT = 131072, EV_SWING = 262144, EV_SECTION = 524288, EV_BEAT = 1048576, EV_STROKE = 2097152,
    EV_MISSBEAT = 4194304, EV_CRASH = 8388608, EV_LANE = 16777216, EV_HIT = 33554432, EV_SOFT = 67108864, EV_BOUNCE = 134217728, EV_FALL = 268435456;

  function hash(s, k, j) {
    var h = (s ^ Math.imul((k + 1) | 0, 0x9e3779b1)) ^ Math.imul((j + 7) | 0, 0x85ebca6b);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
  }
  function secType(s) { return SEC_CYCLE[s % SEC_CYCLE.length]; }
  function isRun(t) { return t === S_TRACK || t === S_ROOF || t === S_CANE; }
  function secLen(seed, s) {
    var t = secType(s);
    if (t === S_TRACK) return TRACK_LEN + (hash(seed, s, 20) % TRACK_SPREAD) + (s === 0 ? 30000 : 0);
    if (t === S_ROOF) return ROOF_LEN + (hash(seed, s, 20) % ROOF_SPREAD);
    if (t === S_CANE) return CANE_LEN + (hash(seed, s, 20) % CANE_SPREAD);
    return t === S_SWIM ? SWIM_LEN : t === S_CLIMB ? TOWER_H : GLIDE_LEN;
  }
  // Row K is a pure function of (seed, K, its section): draw 0 kind, 1 pattern,
  // 2 mirror, 3 space, 4 combo, 5 pickups.
  function rowKind(s, k, sec, x) {
    if (sec === S_ROOF) return hash(s, k, 0) % 5 < 2 ? R_ROOF : R_LANES;
    if (sec !== S_TRACK) return R_LANES;
    var d = hash(s, k, 0);
    if (x >= FULL_AT && d % 8 < (x < 400000 ? 1 : x < 1000000 ? 2 : 3)) { var f = FULL[(d >>> 4) % (x >= 600000 ? 6 : x >= 250000 ? 3 : 2)]; return f; }
    return R_LANES;
  }
  function rowCells(s, k, sec, x) {
    var d = hash(s, k, 1), m = hash(s, k, 2) & 1, c;
    if (sec === S_ROOF || sec === S_CANE) {
      var lst = sec === S_ROOF ? ROOFPAT : CANEPAT;
      c = lst[d % lst.length];
    } else if (sec === S_TRACK) {
      var i = 0;
      while (i < TIER_AT.length && x >= TIER_AT[i]) i++;
      var list = PAT[i][1];
      c = list[d % list.length];
    } else {
      var hz = sec === S_SWIM ? C_LOG : sec === S_CLIMB ? C_DROP : C_KITE;
      var tl = x / 600000 | 0, free = d % 3, two = (d >>> 3) % 10 < 2 + (tl < 4 ? tl : 4);
      c = [hz, hz, hz]; c[free] = C_EMPTY;
      if (!two) c[(free + 1 + ((d >>> 5) & 1)) % 3] = C_EMPTY;
    }
    var a = m ? c[2] : c[0], b = m ? c[0] : c[2];
    return a | (c[1] << 4) | (b << 8);
  }
  function cellAt(cells, lane) { return (cells >>> (lane * 4)) & 15; }
  function rowEnd(kind) { return kind === R_GAP ? GAP_LEN : kind === R_ROPE ? ROPE_LEN : kind === R_SACK ? SACK_LEN : kind === R_ROOF ? ROOF_GAP : 0; }
  function rowHasWall(cells) { return cellAt(cells, 0) === C_WALL || cellAt(cells, 1) === C_WALL || cellAt(cells, 2) === C_WALL; }
  // carts and cane block a lane outright, so rows with them never come in quick combos
  function blocks(c) { return c === C_CART || c === C_CANE; }
  function rowHasCart(cells) { return blocks(cellAt(cells, 0)) || blocks(cellAt(cells, 1)) || blocks(cellAt(cells, 2)); }
  function spaceBefore(s, k, sec, prevKind, prevCells, kind, cells, x) {
    var d = hash(s, k, 3), c = hash(s, k, 4);
    if (!isRun(sec)) {
      var tight = x / SEC_TIGHT_PER | 0; if (tight > SEC_TIGHT_CAP) tight = SEC_TIGHT_CAP;
      return (SPACE_SEC[sec] + d % SPREAD_SEC[sec]) * (100 - tight) / 100 | 0;
    }
    var blockers = prevKind === R_LANES && rowHasCart(prevCells) || kind === R_LANES && rowHasCart(cells);
    var combos = x < COMBO_AT ? 0 : x < COMBO_MORE[0] ? 1 : x < COMBO_MORE[1] ? 2 : 3;
    if (k >= COMBO_FROM && (c % 8) < combos && prevKind === R_LANES && kind !== R_SACK && !blockers) return COMBO_SPACE + ((c >>> 4) % COMBO_SPREAD);
    var sh = k < SHRINK_CAP ? k : SHRINK_CAP;
    var extra = prevKind !== R_LANES || rowHasWall(prevCells) ? WALL_EXTRA : 0;
    if (x < EASE_UNTIL) extra += (EASE_UNTIL - x) * (EASE_ROOM / 1000) / (EASE_UNTIL / 1000) | 0;
    // in the cane a runner may need two lane changes between rows: give him the room
    if (sec === S_CANE) extra += CANE_EXTRA;
    return SPACE_MIN + (SHRINK_CAP - sh) * SPACE_SHRINK + (d % SPACE_SPREAD) + extra;
  }
  // Pickups in the space before row K: [count, first x, high, lane].
  function pickupsFor(s, k, sec, from, to) {
    if (k < PICK_FROM) return [0, 0, 0, 0];
    var d = hash(s, k, 5);
    var want = (d % 6) - 1;
    var after = sec === S_CLIMB ? 600 : PICK_AFTER, before = sec === S_CLIMB ? 900 : PICK_BEFORE, gap = sec === S_CLIMB ? 400 : PICK_GAP;
    var free = (to - before) - (from + after);
    if (want <= 0 || free < 0) return [0, 0, 0, 0];
    var fit = (free / gap | 0) + 1;
    var n = want < fit ? want : fit;
    return [n, from + after + ((free - (n - 1) * gap) / 2 | 0), isRun(sec) ? (d >>> 8) & 1 : 0, (d >>> 9) % 3];
  }

  function seedInt(hex) {
    var s = 0;
    for (var i = 0; i < hex.length && i < 8; i++) s = (s * 16 + parseInt(hex.charAt(i), 16)) >>> 0;
    return s;
  }

  function initSim(seed) {
    var sim = {
      seed: seed >>> 0, frames: 0, pos: 0, v: V_BASE, mode: M_RUN, act: A_NONE, actFrom: 0, actLen: 0, timer: 0,
      streak: 0, bestStreak: 0, perfects: 0, oks: 0, stumbles: 0, bonus: 0, score: 0, acts: 0,
      c: -START_GAP, cv: CV0, k: 0, ox: 0, ot: 0, cells: 0, wallX: 0, ev: 0, lastJudge: 0,
      pickN: 0, pickX0: 0, pickHi: 0, pickLane: 0, pickI: 0, coins: 0,
      turboT: 0, turbos: 0, chargeN: 0, chargeT: 0, chargePh: 0, two: 0,
      hopT: 0, sinceLand: 0, hops: 0, hopPerfects: 0,
      lane: 1, laneX: 0, laneFrom: 0, laneT: 0,
      sec: 0, secType: S_TRACK, secStart: 0, secEnd: 0, beatLen: 28, beatOrigin: 0, lastBeat: -1, strokeAt: -99, strokes: 0, bounce: 0, bounces: 0, landAt: -1000000, reachT: 0, reachV: 0, slip: 0, dazeT: 0, beats: 0
    };
    sim.secEnd = secLen(sim.seed, 0);
    sim.ot = rowKind(sim.seed, 0, S_TRACK, 0);
    sim.cells = rowCells(sim.seed, 0, S_TRACK, 0);
    sim.ox = SEC_LEAD[S_TRACK];
    return sim;
  }

  // how much faster the run has got with distance
  function rampAt(pos) {
    var r = pos / V_RAMP_PER | 0;
    if (r < V_RAMP_CAP) return r;
    var r2 = (pos - V_RAMP_CAP * V_RAMP_PER) / V_RAMP2_PER | 0;
    return V_RAMP_CAP + (r2 < V_RAMP2_CAP ? r2 : V_RAMP2_CAP);
  }
  function rampOf(sim) { return rampAt(sim.pos); }
  function nearestLane(sim) { var l = (sim.laneX + LANE_W * 3 / 2) / LANE_W | 0; return l < 0 ? 0 : l > 2 ? 2 : l; }
  function beatAt(k) { return (k * BEAT_NUM * 2 + BEAT_DEN) / (BEAT_DEN * 2) | 0; }
  // the beat at or before step f
  function beatFloor(f) {
    var k = f * BEAT_DEN / BEAT_NUM | 0;
    if (beatAt(k + 1) <= f) k++;
    if (beatAt(k) > f) k--;
    return k;
  }
  function beatIndex(sim) {
    var k = beatFloor(sim.frames);
    return sim.frames - beatAt(k) <= beatAt(k + 1) - sim.frames ? k : k + 1;
  }
  function beatOff(sim) {
    var k = beatFloor(sim.frames), a = sim.frames - beatAt(k), b = beatAt(k + 1) - sim.frames;
    return a < b ? a : b;
  }

  function act(sim, a) {
    if (sim.frames < INPUT_GUARD) return false;
    var m = sim.mode;
    if (a === A_LEFT || a === A_RIGHT) {
      if (m !== M_RUN && m !== M_ACT && m !== M_SWIM2 && m !== M_CLIMB2 && m !== M_GLIDE) return false;
      var to = sim.lane + (a === A_LEFT ? -1 : 1);
      if (to < 0 || to > 2) return false;
      sim.lane = to; sim.laneFrom = sim.laneX; sim.laneT = LANE_STEPS; sim.acts++;
      sim.ev |= EV_LANE;
      return true;
    }
    if (m === M_SACK) {
      if ((a !== A_JUMP && a !== A_VAULT) || sim.hopT > 0) return false;
      if (sim.hops > 0 && sim.sinceLand <= HOP_PERFECT) { sim.bonus += HOP_PTS; sim.hopPerfects++; sim.ev |= EV_HOPPERFECT; }
      sim.hopT = HOP_STEPS; sim.hops++; sim.acts++;
      sim.ev |= EV_HOP;
      return true;
    }
    if (m === M_SWIM2 || m === M_CLIMB2 || m === M_GLIDE) {
      if (a !== A_JUMP) return false;
      if (m === M_CLIMB2 && (sim.reachT > 0 || sim.dazeT > 0)) return false;
      if (sim.frames - sim.strokeAt < STROKE_GAP) return false;
      sim.strokeAt = sim.frames; sim.strokes++; sim.acts++;
      sim.lastJudge = 2; sim.ev |= EV_STROKE;
      if (m === M_SWIM2) { sim.v += SWIM_TAP; if (sim.v > SWIM_CAP) sim.v = SWIM_CAP; }
      else if (m === M_CLIMB2) { sim.reachT = REACH_STEPS; sim.reachV = REACH_TAP; }
      else { sim.v += GLIDE_TAP; if (sim.v > GLIDE_CAP) sim.v = GLIDE_CAP; }
      return true;
    }
    if (m !== M_RUN) return false;
    if (a === A_JUMP) a = A_VAULT;
    if (a !== A_SLIDE && a !== A_VAULT) return false;
    sim.mode = M_ACT; sim.act = a; sim.actFrom = sim.pos; sim.actLen = LEN[a]; sim.acts++;
    sim.ev |= EV_ACT;
    return true;
  }

  function miss(sim) { sim.streak = 0; sim.turboT = 0; sim.stumbles++; sim.act = A_NONE; sim.lastJudge = 3; }
  function stumble(sim, steps) {
    miss(sim);
    sim.mode = M_STUN; sim.timer = steps; sim.v = steps === CRASH_STEPS ? 10 : V_STUMBLE;
    sim.ev |= EV_STUMBLE;
  }
  function perfect(sim) {
    sim.streak++; sim.perfects++;
    if (sim.streak > sim.bestStreak) sim.bestStreak = sim.streak;
    sim.bonus += PERFECT_PTS * (sim.streak < PERFECT_MULT_CAP ? sim.streak : PERFECT_MULT_CAP);
    sim.lastJudge = 1; sim.ev |= EV_PERFECT;
    if (sim.streak % TURBO_EVERY === 0) { sim.turboT = TURBO_STEPS; sim.turbos++; sim.c -= TURBO_PUSH; sim.ev |= EV_TURBO; }
  }
  function ok(sim) { sim.oks++; sim.lastJudge = 2; sim.ev |= EV_OK; }

  function judgeSpecial(sim) {
    var cell = cellAt(sim.cells, nearestLane(sim));
    sim.lastJudge = 0;
    if (cell === C_EMPTY) return;
    miss(sim);
    sim.ev |= EV_HIT;
    if (sim.mode === M_SWIM2) { sim.v = SWIM_MIN; }
    else if (sim.mode === M_CLIMB2) { sim.slip = DROP_SLIP; sim.dazeT = DROP_DAZE; sim.reachT = 0; }
    else sim.v = KITE_V;
  }

  function judge(sim) {
    var t = sim.ot, x = sim.ox;
    var acting = sim.mode === M_ACT;
    sim.lastJudge = 0;
    if (t === R_SACK) {
      sim.mode = M_SACK; sim.act = A_NONE; sim.pos = x; sim.hopT = 0; sim.sinceLand = 0; sim.hops = 0;
      sim.ev |= EV_SACK;
      return;
    }
    if (t === R_GAP) {
      // in the air at the edge clears the canal: the jump stretches to the far bank
      if (acting && sim.act === A_VAULT) {
        var gf = (x - sim.actFrom) * 1000;
        if (gf >= 300 * sim.actLen && gf <= 700 * sim.actLen) perfect(sim); else ok(sim);
        var need = x + GAP_LEN + GAP_CLEAR - sim.actFrom;
        if (sim.actLen < need) sim.actLen = need;
      } else {
        miss(sim);
        sim.mode = M_SWIM; sim.pos = x; sim.v = SWIM_V;
        sim.ev |= EV_SPLASH;
      }
      return;
    }
    if (t === R_ROOF) {
      // in the air at the edge clears the gap to the next roof; otherwise down to the street
      if (acting && sim.act === A_VAULT) {
        var of = (x - sim.actFrom) * 1000;
        if (of >= 300 * sim.actLen && of <= 700 * sim.actLen) perfect(sim); else ok(sim);
        var needR = x + ROOF_GAP + GAP_CLEAR - sim.actFrom;
        if (sim.actLen < needR) sim.actLen = needR;
      } else {
        miss(sim);
        sim.mode = M_FALL; sim.pos = x; sim.timer = FALL_STEPS; sim.v = 0;
        sim.ev |= EV_FALL;
      }
      return;
    }
    if (t === R_ROPE) {
      // in the air at the edge of the mud catches the rope
      if (acting && sim.act === A_VAULT) {
        var rf = (x - sim.actFrom) * 1000;
        if (rf >= 300 * sim.actLen && rf <= 700 * sim.actLen) perfect(sim); else ok(sim);
        sim.mode = M_SWING; sim.act = A_NONE; sim.pos = x; sim.timer = SWING_STEPS;
        sim.ev |= EV_SWING;
      } else {
        miss(sim);
        sim.mode = M_MUD; sim.pos = x; sim.v = MUD_V;
        sim.ev |= EV_MUD;
      }
      return;
    }
    var cell = t === R_KABADDI ? C_BAR : cellAt(sim.cells, nearestLane(sim));
    if (cell === C_EMPTY) return;
    // high in a charpai bounce: everything in the lanes passes underneath
    if (acting && sim.bounce) { perfect(sim); return; }
    if (cell === C_CART) { stumble(sim, CRASH_STEPS); sim.ev |= EV_CRASH; return; }
    // a charpai bounces anyone who comes down on it: still in the air when he reaches it,
    // or landed on its near half just before (it is 1.6 m long, judged at its middle)
    if (cell === C_CHARPAI && ((acting && sim.act === A_VAULT) || (!acting && sim.landAt >= x - CHARPAI_REACH))) {
      var cf = (x - sim.actFrom) * 1000;
      if (acting && cf >= 300 * sim.actLen && cf <= 700 * sim.actLen) perfect(sim); else ok(sim);
      sim.mode = M_ACT; sim.act = A_VAULT; sim.actFrom = x; sim.actLen = BOUNCE_LEN; sim.bounce = 1; sim.bounces++; sim.ev |= EV_BOUNCE;
      return;
    }
    var w = acting ? WIN[cell * 4 + sim.act] : undefined;
    if (w) {
      var f = x - sim.actFrom, len = sim.actLen;
      if (f * 1000 >= w[0] * len && f * 1000 <= w[1] * len) {
        if (f * 1000 >= w[2] * len && f * 1000 <= w[3] * len) perfect(sim); else ok(sim);
        return;
      }
    }
    if (cell === C_CANE) { stumble(sim, STUN_STEPS); sim.ev |= EV_SOFT; return; }
    if (cell === C_HAY) { miss(sim); sim.mode = M_RUN; sim.v = HAY_V; sim.ev |= EV_SOFT; return; }
    if (cell === C_FLOCK) { sim.streak = 0; sim.turboT = 0; sim.lastJudge = 3; sim.mode = M_RUN; sim.act = A_NONE; sim.v = sim.v * FLOCK_PCT / 100 | 0; sim.ev |= EV_SOFT; return; }
    if (cell === C_WALL) {
      miss(sim);
      sim.mode = M_CLIMB; sim.timer = CLIMB_STEPS; sim.pos = x; sim.wallX = x; sim.v = 0;
      sim.ev |= EV_BONK;
      return;
    }
    stumble(sim, STUN_STEPS);
  }

  // the next row: in this section if it fits, otherwise none until the next section
  function nextRow(sim) {
    var prevKind = sim.ot, prevCells = sim.cells, from = sim.ox + rowEnd(prevKind);
    sim.k++;
    var sec = sim.secType;
    var kind = rowKind(sim.seed, sim.k, sec, from), cells = rowCells(sim.seed, sim.k, sec, from);
    var x = from + spaceBefore(sim.seed, sim.k, sec, prevKind, prevCells, kind, cells, from);
    if (x + rowEnd(kind) > sim.secEnd - SEC_TAIL[sec]) { sim.ot = R_NONE; sim.ox = sim.secEnd + 1; sim.pickN = 0; return; }
    sim.ot = kind; sim.cells = cells; sim.ox = x;
    var p = pickupsFor(sim.seed, sim.k, sec, from, x);
    sim.pickN = p[0]; sim.pickX0 = p[1]; sim.pickHi = p[2]; sim.pickLane = p[3]; sim.pickI = 0;
  }

  // the next section's bounds and its first row (shared with the drawing code)
  function advanceSection(g) {
    g.sec++;
    g.secType = secType(g.sec);
    g.secStart = g.secEnd;
    g.secEnd = g.secStart + secLen(g.seed, g.sec);
    g.k++;
    g.ot = rowKind(g.seed, g.k, g.secType, g.secStart); g.cells = rowCells(g.seed, g.k, g.secType, g.secStart);
    g.ox = g.secStart + SEC_LEAD[g.secType];
    g.pickN = 0;
  }
  function enterSection(sim) {
    advanceSection(sim);
    sim.lastBeat = beatFloor(sim.frames); sim.strokeAt = -99; sim.slip = 0; sim.dazeT = 0;
    sim.act = A_NONE; sim.timer = 0; sim.hopT = 0; sim.reachT = 0;
    var t = sim.secType;
    if (isRun(t)) { sim.mode = M_RUN; sim.v = V_BASE + rampOf(sim); } // back on the track at the speed the run has reached
    else if (t === S_SWIM) { sim.mode = M_SWIM2; sim.v = SWIM_ENTER; }
    else if (t === S_CLIMB) { sim.mode = M_CLIMB2; sim.v = 0; }
    else { sim.mode = M_GLIDE; sim.v = GLIDE_BASE; }
    sim.ev |= EV_SECTION;
  }
  // a generator for drawing: the same rows in the same order as the sim
  function makeGen(seed) {
    var g = { seed: seed >>> 0, k: 0, sec: 0, secType: S_TRACK, secStart: 0, secEnd: secLen(seed >>> 0, 0), ot: 0, cells: 0, ox: 0, pickN: 0, pickX0: 0, pickHi: 0, pickLane: 0, pickI: 0 };
    g.ot = rowKind(g.seed, 0, S_TRACK, 0); g.cells = rowCells(g.seed, 0, S_TRACK, 0); g.ox = SEC_LEAD[S_TRACK];
    return g;
  }
  function genNext(g) { nextRow(g); if (g.ot === R_NONE) advanceSection(g); }

  function collect(sim) {
    while (sim.pickI < sim.pickN) {
      var px = sim.pickX0 + sim.pickI * (sim.secType === S_CLIMB ? 400 : PICK_GAP);
      if (sim.pos < px) return;
      // being in the coin's lane always takes it: any move, and mid lane-change
      // either the lane you are leaving or the one you are heading for counts
      var got = sim.mode !== M_DEAD && (nearestLane(sim) === sim.pickLane || sim.lane === sim.pickLane);
      if (got) { sim.coins++; sim.bonus += PICK_PTS; sim.ev |= EV_PICK; }
      sim.pickI++;
    }
  }

  function stepSim(sim) {
    if (sim.mode === M_DEAD) return;
    sim.frames++;
    sim.ev = 0;
    if (sim.turboT > 0) sim.turboT--;
    if (sim.laneT > 0) {
      sim.laneT--;
      var target = (sim.lane - 1) * LANE_W;
      sim.laneX = target + ((sim.laneFrom - target) * sim.laneT / LANE_STEPS | 0);
    }
    if (!isRun(sim.secType)) {
      var bi = beatFloor(sim.frames);
      if (bi !== sim.lastBeat) { sim.lastBeat = bi; sim.beats++; sim.ev |= EV_BEAT; }
    }
    var m = sim.mode;
    if (m === M_RUN || m === M_ACT) {
      var tv = V_BASE + rampAt(sim.pos) + V_PER_STREAK * (sim.streak < STREAK_CAP ? sim.streak : STREAK_CAP) + (sim.turboT > 0 ? TURBO_V : 0);
      if (sim.v < tv) sim.v += sim.turboT > 0 ? ACCEL * 3 : ACCEL; else if (sim.v > tv) sim.v -= ACCEL;
      sim.pos += sim.v;
      if (m === M_ACT && sim.pos - sim.actFrom >= sim.actLen) { sim.mode = M_RUN; sim.act = A_NONE; sim.bounce = 0; sim.landAt = sim.pos; sim.ev |= EV_LAND; }
    } else if (m === M_STUN) {
      sim.pos += sim.v;
      sim.timer--;
      if (sim.timer <= 0) sim.mode = M_RUN;
    } else if (m === M_CLIMB) {
      sim.timer--;
      if (sim.timer <= 0) { sim.mode = M_RUN; sim.pos = sim.wallX + WALL_DEPTH + 100; sim.v = V_STUMBLE; sim.ev |= EV_UP; }
    } else if (m === M_SWIM) {
      sim.pos += SWIM_V;
      if (sim.pos >= sim.ox + GAP_LEN) { sim.pos = sim.ox + GAP_LEN; sim.mode = M_OUT; sim.timer = OUT_STEPS; }
    } else if (m === M_OUT) {
      sim.timer--;
      if (sim.timer <= 0) { sim.mode = M_RUN; sim.v = V_STUMBLE; sim.pos += 100; sim.ev |= EV_UP; nextRow(sim); }
    } else if (m === M_FALL) {
      // dropped to the street between two roofs: climb back up on the far side
      sim.timer--;
      if (sim.timer <= 0) { sim.mode = M_RUN; sim.pos = sim.ox + ROOF_GAP + 150; sim.v = V_STUMBLE; sim.ev |= EV_UP; nextRow(sim); }
    } else if (m === M_SWING) {
      sim.timer--;
      sim.pos = sim.ox + ((ROPE_LEN + 300) * (SWING_STEPS - sim.timer) / SWING_STEPS | 0);
      if (sim.timer <= 0) { sim.mode = M_RUN; sim.ev |= EV_LAND; nextRow(sim); }
    } else if (m === M_MUD) {
      sim.pos += MUD_V;
      if (sim.pos >= sim.ox + ROPE_LEN) { sim.pos = sim.ox + ROPE_LEN + 100; sim.mode = M_RUN; sim.v = V_STUMBLE; sim.ev |= EV_UP; nextRow(sim); }
    } else if (m === M_SACK) {
      if (sim.hopT > 0) {
        sim.pos += HOP_V + rampOf(sim); sim.hopT--; // hops speed up with the run, like the running does
        if (sim.hopT === 0) { sim.sinceLand = 0; sim.ev |= EV_LAND; }
      } else sim.sinceLand++;
      if (sim.pos >= sim.ox + SACK_LEN) { sim.mode = M_RUN; sim.hopT = 0; sim.v = SACK_EXIT_V + rampOf(sim); sim.ev |= EV_UP; nextRow(sim); }
    } else if (m === M_SWIM2) {
      if (sim.v > SWIM_MIN) sim.v--;
      sim.pos += sim.v;
    } else if (m === M_CLIMB2) {
      if (sim.dazeT > 0) sim.dazeT--;
      if (sim.slip > 0) {
        var d = sim.slip < DROP_SLIDE ? sim.slip : DROP_SLIDE;
        sim.slip -= d; sim.pos -= d;
        if (sim.pos < sim.secStart) { sim.pos = sim.secStart; sim.slip = 0; }
      } else if (sim.reachT > 0) { sim.pos += sim.reachV; sim.reachT--; }
    } else if (m === M_GLIDE) {
      if (sim.v > GLIDE_BASE && (sim.frames & 1) === 0) sim.v--;
      if (sim.v < GLIDE_BASE) sim.v++;
      sim.pos += sim.v;
    }
    collect(sim);
    if (sim.pos >= sim.ox && sim.ot !== R_NONE) {
      if (sim.mode === M_RUN || sim.mode === M_ACT || sim.mode === M_STUN) {
        judge(sim);
        if (sim.mode !== M_SWIM && sim.mode !== M_SWING && sim.mode !== M_MUD && sim.mode !== M_SACK && sim.mode !== M_FALL) nextRow(sim);
        // a fresh bounce reaches the next row when it can: past a row of lane obstacles,
        // or to the edge of a canal, the mud or the sacks, so it is never wasted landing
        // just short of one (up to BOUNCE_MAX; a row further away leaves room to jump it)
        if (sim.ev & EV_BOUNCE && sim.ot !== R_NONE) {
          var reach = sim.ox + (sim.ot === R_LANES ? BOUNCE_LAND : 300) - sim.actFrom;
          if (reach > sim.actLen && reach <= BOUNCE_MAX) sim.actLen = reach;
        }
      } else if (sim.mode === M_SWIM2 || sim.mode === M_CLIMB2 || sim.mode === M_GLIDE) {
        judgeSpecial(sim);
        nextRow(sim);
      }
    }
    if (sim.pos >= sim.secEnd && (sim.mode === M_RUN || sim.mode === M_ACT || sim.mode === M_STUN || sim.mode === M_SWIM2 || sim.mode === M_CLIMB2 || sim.mode === M_GLIDE)) enterSection(sim);
    // the chaser: speeds up, sometimes charges, gets a friend after a kilometre
    if (sim.frames > CHASE_GUARD) {
      var t = sim.frames - CHASE_GUARD;
      if (sim.chargePh === 0) {
        if (t % CHARGE_EVERY === 0 && t >= CHARGE_EVERY * CHARGE_FIRST && isRun(sim.secType)) {
          var n = sim.chargeN++;
          if (hash(sim.seed, n, 9) % 3 !== 0) { sim.chargePh = 1; sim.chargeT = CHARGE_WARN; sim.ev |= EV_WARN; }
        }
      } else {
        sim.chargeT--;
        if (sim.chargeT <= 0) {
          if (sim.chargePh === 1) { sim.chargePh = 2; sim.chargeT = CHARGE_STEPS; sim.ev |= EV_CHARGE; } else sim.chargePh = 0;
        }
      }
      if (!sim.two && sim.pos >= TWO_AT) { sim.two = 1; sim.ev |= EV_TWO; }
      // the bhains keeps pace with the runner's own speed-up, then gains on it
      var cv = CV0 + rampAt(sim.pos) + (t / CV_EVERY | 0);
      cv = (cv < CV_MAX ? cv : CV_MAX) + (sim.two ? TWO_V : 0) + (sim.chargePh === 2 ? CHARGE_V : 0);
      sim.cv = cv * CHASE_PCT[sim.secType] / 100 | 0;
      sim.c += sim.cv;
    }
    if (sim.c < sim.pos - GAP_MAX) sim.c = sim.pos - GAP_MAX;
    sim.score = (sim.pos / 1000 | 0) + sim.bonus;
    if (sim.c >= sim.pos - CATCH) { sim.mode = M_DEAD; sim.act = A_NONE; sim.ev |= EV_CAUGHT; }
  }

  return {
    STEP_HZ: STEP_HZ, V_BASE: V_BASE, V_STUMBLE: V_STUMBLE, LEN: LEN, GAP_LEN: GAP_LEN, WALL_DEPTH: WALL_DEPTH,
    ROPE_LEN: ROPE_LEN, SACK_LEN: SACK_LEN, HOP_STEPS: HOP_STEPS, SWING_STEPS: SWING_STEPS, PICK_GAP: PICK_GAP,
    GAP_MAX: GAP_MAX, CATCH: CATCH, CLIMB_STEPS: CLIMB_STEPS, OUT_STEPS: OUT_STEPS, STUN_STEPS: STUN_STEPS, CRASH_STEPS: CRASH_STEPS,
    TURBO_STEPS: TURBO_STEPS, CHARGE_WARN: CHARGE_WARN, TWO_AT: TWO_AT, COMBO_SPACE: COMBO_SPACE, COMBO_SPREAD: COMBO_SPREAD,
    LANE_W: LANE_W, LANE_STEPS: LANE_STEPS, TOWER_H: TOWER_H, REACH_STEPS: REACH_STEPS, DROP_DAZE: DROP_DAZE, SWIM_CAP: SWIM_CAP, GLIDE_BASE: GLIDE_BASE, GLIDE_CAP: GLIDE_CAP,
    A_JUMP: A_JUMP, A_SLIDE: A_SLIDE, A_VAULT: A_VAULT, A_LEFT: A_LEFT, A_RIGHT: A_RIGHT,
    S_TRACK: S_TRACK, S_SWIM: S_SWIM, S_CLIMB: S_CLIMB, S_GLIDE: S_GLIDE, S_ROOF: S_ROOF, S_CANE: S_CANE, isRun: isRun, ROOF_GAP: ROOF_GAP, FALL_STEPS: FALL_STEPS,
    R_NONE: R_NONE, R_LANES: R_LANES, R_GAP: R_GAP, R_ROPE: R_ROPE, R_KABADDI: R_KABADDI, R_SACK: R_SACK, R_ROOF: R_ROOF,
    C_EMPTY: C_EMPTY, C_TANK: C_TANK, C_LINE: C_LINE, C_CANE: C_CANE, C_HAY: C_HAY, C_FLOCK: C_FLOCK, C_CHARPAI: C_CHARPAI, C_HURDLE: C_HURDLE, C_BAR: C_BAR, C_WALL: C_WALL, C_POT: C_POT, C_CART: C_CART, C_LOG: C_LOG, C_DROP: C_DROP, C_KITE: C_KITE,
    M_RUN: M_RUN, M_ACT: M_ACT, M_STUN: M_STUN, M_CLIMB: M_CLIMB, M_SWIM: M_SWIM, M_OUT: M_OUT, M_DEAD: M_DEAD,
    M_SWING: M_SWING, M_MUD: M_MUD, M_SACK: M_SACK, M_SWIM2: M_SWIM2, M_CLIMB2: M_CLIMB2, M_GLIDE: M_GLIDE, M_FALL: M_FALL,
    EV_PERFECT: EV_PERFECT, EV_OK: EV_OK, EV_STUMBLE: EV_STUMBLE, EV_SPLASH: EV_SPLASH, EV_BONK: EV_BONK,
    EV_LAND: EV_LAND, EV_CAUGHT: EV_CAUGHT, EV_ACT: EV_ACT, EV_UP: EV_UP, EV_PICK: EV_PICK, EV_TURBO: EV_TURBO,
    EV_WARN: EV_WARN, EV_CHARGE: EV_CHARGE, EV_TWO: EV_TWO, EV_MUD: EV_MUD, EV_SACK: EV_SACK, EV_HOP: EV_HOP,
    EV_HOPPERFECT: EV_HOPPERFECT, EV_SWING: EV_SWING, EV_SECTION: EV_SECTION, EV_BEAT: EV_BEAT, EV_STROKE: EV_STROKE,
    EV_MISSBEAT: EV_MISSBEAT, EV_SOFT: EV_SOFT, EV_BOUNCE: EV_BOUNCE, EV_FALL: EV_FALL, EV_CRASH: EV_CRASH, EV_LANE: EV_LANE, EV_HIT: EV_HIT,
    secType: secType, secLen: secLen, rowKind: rowKind, rowCells: rowCells, cellAt: cellAt, rowEnd: rowEnd,
    spaceBefore: spaceBefore, pickupsFor: pickupsFor, nearestLane: nearestLane, beatOff: beatOff, beatAt: beatAt, beatFloor: beatFloor, BEAT_NUM: BEAT_NUM, BEAT_DEN: BEAT_DEN, BEAT_P: BEAT_P, BEAT_OK: BEAT_OK,
    seedInt: seedInt, initSim: initSim, act: act, stepSim: stepSim, makeGen: makeGen, genNext: genNext,
    SEC_LEAD: SEC_LEAD, SEC_TAIL: SEC_TAIL
  };
})();
// OH BHAINS RULES END

const RULES_VERSION = 2;
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A WORK bound far above any real run (rhythm sections take a stroke every few
// steps). It REFUSES further inputs, it never zeroes, and it stops a huge trace
// becoming a CPU sink.
const MAX_INPUTS = 60 * 60 * 20;
// The client collects at most two inputs between two steps (pending, pending2).
const MAX_PER_STEP = 2;
const ACTIONS = [CR.A_JUMP, CR.A_SLIDE, CR.A_VAULT, CR.A_LEFT, CR.A_RIGHT];

function dead(sim) { return sim.mode === CR.M_DEAD; }
function advanceTo(sim, step) {
  while (!dead(sim) && sim.frames < step && sim.frames < MAX_SIM_STEPS) CR.stepSim(sim);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function seedOf(seed) {
  return typeof seed === 'string' && /^[0-9a-f]+$/i.test(seed) ? CR.seedInt(seed) : 0;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, dead: false,
    lastStep: -1, onStep: 0, nextN: 0,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { steps: [], margins: [], beatOffs: [], counts: [0, 0, 0, 0, 0, 0] },
  };
}

// ── raw material for the bot detector ───────────────────────────────────
// Recorded, never gated. A run input notes how many steps the obstacle ahead
// was away (a planner acts at the same distance every time, a hand does not);
// a rhythm input notes how far off the beat it landed (a script lands on it).
const RHYTHM = [CR.M_SWIM2, CR.M_CLIMB2, CR.M_GLIDE, CR.M_SACK];
function noteAct(state, a) {
  const sim = state.sim, st = state.stats;
  st.steps.push(sim.frames);
  st.counts[a]++;
  if (RHYTHM.indexOf(sim.mode) >= 0) { if (a === CR.A_JUMP) st.beatOffs.push(CR.beatOff(sim)); return; }
  if (sim.ox > sim.pos && sim.v > 0) st.margins.push(Math.floor((sim.ox - sim.pos) / sim.v));
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }
function gapCv(steps) {
  if (steps.length < 3) return null;
  const g = [];
  for (let i = 1; i < steps.length; i++) g.push(steps[i] - steps[i - 1]);
  const m = mean(g); const s = sd(g);
  return m > 0 && s !== null ? s / m : null;
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
    if (payload.v === RULES_VERSION && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = CR.initSim(seedOf(state.seed));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim' || kind !== 'act') return { accepted: true, newScore: state.score };

  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;

  const { n, a, step } = payload;
  if (!isStep(n) || !isStep(step) || ACTIONS.indexOf(a) < 0) return reject(state, 'bad_act');

  const sim = state.sim;
  // Steps may never go BACKWARDS: a rewind would re-run a window and keep the
  // best outcome.
  if (step < sim.frames) return reject(state, 'frame_regressed');
  advanceTo(sim, step);
  if (dead(sim)) {
    state.dead = true;
    state.score = sim.score;
    return { accepted: false, newScore: state.score, reason: 'dead' };
  }
  if (sim.frames !== step) return reject(state, 'beyond_cap');
  // The input names its index among the run's accepted inputs.
  if (n !== state.nextN) return reject(state, 'out_of_order');
  if (step === state.lastStep && state.onStep >= MAX_PER_STEP) return reject(state, 'step_flood');
  // The client only records an input the rules applied, so a refused one is forged.
  if (!CR.act(sim, a)) return reject(state, 'refused');
  if (step !== state.lastStep) { state.lastStep = step; state.onStep = 0; }
  state.onStep++;
  state.nextN++;
  noteAct(state, a);
  state.score = sim.score;
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
  // Run the world out past the last input. A runner who stops acting is
  // caught by the buffalo within seconds, so this ends long before the bound.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!dead(sim) && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    CR.stepSim(sim);
    guard++;
  }
  const st = state.stats;
  const acts = st.steps.length;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.frames, score: sim.score, metres: sim.pos / 1000 | 0, bonus: sim.bonus,
      dead: dead(sim), section: sim.sec, inputs: state.inputCount, rejects: state.rejectCount, acts,
      jumps: st.counts[CR.A_JUMP], slides: st.counts[CR.A_SLIDE], vaults: st.counts[CR.A_VAULT],
      lanes: st.counts[CR.A_LEFT] + st.counts[CR.A_RIGHT],
      perfects: sim.perfects, oks: sim.oks, stumbles: sim.stumbles, bestStreak: sim.bestStreak,
      marginMean: round3(mean(st.margins)), marginSd: round3(sd(st.margins)),
      beatOffMean: round3(mean(st.beatOffs)), beatOffSd: round3(sd(st.beatOffs)),
      gapCv: round3(gapCv(st.steps)),
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
  _sim: { CR, RULES_VERSION, advanceTo, seedOf, MAX_INPUTS, MAX_SIM_STEPS, MAX_PER_STEP },
};
