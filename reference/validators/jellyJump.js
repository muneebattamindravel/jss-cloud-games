'use strict';
// Jelly Jump: server-side deterministic REPLAY (Oct 2026, migration 204).
//
// A jelly cube climbs a shaft of rows that close under it. Tap to jump through
// a row while it hangs open and land on it as it shuts. The rules block below
// is carried WORD FOR WORD in games/jelly-jump/js/game.js; the cross-file test
// (shared/tests/jellyJumpParity.test.js) fails if the two ever differ, and the
// golden runs (shared/tests/fixtures/jellyJumpGolden.json) pin the rules
// themselves, because a change made in BOTH files would pass a parity check.
// A gameplay change is a trace version bump and a new golden corpus.
//
// Trace v2: { kind: 'start', v: 2 } then one { kind: 'tap', n, step } per tap:
// the tap was applied on fixed step `step` (the sim's step counter after that
// step ran). The server rebuilds every row from the seed, applies the taps on
// their steps and computes the score itself. A tap the rules refuse (out of
// order, on a step already played, after death) is REFUSED and changes
// nothing; refusals never zero the run.
//
// Integers only on the rules path (Math.imul / max / min, + - * / |), so no
// dmath is needed: they are exact in every engine.
//
// WHAT THIS CANNOT DO. The rows are a pure function of a seed on the player's
// device, so a bot that reads the seed can time every tap perfectly. Replay
// credits exactly what the taps produce; the goo (a run that stops jumping dies
// in about two seconds), games.max_score_per_sec and the humanness fingerprint
// (finalize's debug block, recorded, never gated) are what bound that.

// ==== JELLY JUMP RULES BEGIN (word for word in games/jelly-jump/js/game.js and shared/anticheat/validators/jellyJump.js) ====
var RULES_VERSION = 4;
var Q = 16;                 // positions are sixteenths of a design unit
var ROW_H = 160;            // vertical distance between rows
var SLAB = 18;              // row thickness
var CUBE = 46;              // jelly size
var HALF = 23;
var SHAFT = 150;            // hinge to centre
var EDGE_D = 127;           // SHAFT - HALF: hinge to the jelly's edge
var G = 13;                 // gravity, Q per step per step
var JUMP_V = 286;           // take-off speed, Q per step (apex ~196 up)
var A_OPEN = 180;           // flap angle in half degrees: 180 hanging, 0 shut
var A_EDGE = 64;            // at or below this the flaps reach the jelly's column
var F1 = 1024;              // a row's closing progress: 0 open, F1 shut
var GOO_KILL = 6;           // goo this far up the jelly ends the run
var BUFFER_STEPS = 6;       // a tap just before landing still jumps
var PULL_BASE = 4;          // a stuck jelly pulls free for this many steps
var PULL_DIV = 48;          // plus one step per this many Q it is sunk
var CATCH = 34;             // sunk deeper than this and the row closes over it
var RIDE = 10;              // landing on flaps this close to flat is a clean landing
var PIN_CLEAN = 4;          // gripped this shallowly, the landing still counts as clean
var PIN_SINK = 32;          // a jelly gripped by a closing row sinks into it this fast (Q/step)
var NO_SURF = 2147483647;
var SNAP_TELL = 36;         // a snap row shivers this long before it slams
var GOO_NEAR = 20;          // as the row above shuts, the goo is this far under the floor
var GOO_PACE = 24;          // ...and before that, this many Q lower for every step still to go
var GOO_FAR = 150;          // never further below the floor than this
var GOO_CREEP = 4;          // it always creeps up at least this much a step
var GOO_SURGE = 64;         // once the row above has shut, it surges
var DROP_Y = 50;            // a drop hangs this far above its row
var DROP_R = 14;

// row types
var T_CLASSIC = 0, T_SLOW = 1, T_SLIDE = 2, T_SNAP = 3, T_DOOR = 4;
// v3: four more, each built on an existing shape so the contact rules are shared
var T_SWIFT = 5;            // sliding doors that rush out, then ease in (late is fine, early is not)
var T_HEAVY = 6;            // a heavy single door: long wait, slow grinding close
var T_STEADY = 7;           // flaps that swing shut at one constant speed
var DOOR_CONTACT = 86;      // a single door has crossed the jelly's column once its gap value is this low

// tan(a / 2 degrees) * 4096 for a = 0..64
var TAN = [0,36,71,107,143,179,215,251,286,322,358,394,431,467,503,539,576,612,
  649,685,722,759,796,833,871,908,946,983,1021,1059,1098,1136,1175,1213,1252,1291,
  1331,1371,1410,1450,1491,1531,1572,1613,1655,1697,1739,1781,1824,1867,1910,1954,
  1998,2042,2087,2132,2178,2224,2270,2317,2365,2413,2461,2510,2559];

var EV_JUMP = 1, EV_LAND = 2, EV_PERFECT = 4, EV_CATCH = 8, EV_BUMP = 16,
    EV_DROP = 32, EV_DIE = 64, EV_CLOSE = 128, EV_PULL = 256, EV_FLOOR = 512, EV_STUCK = 1024,
    EV_TELL = 4096;

function mix(h, v) {
  h = Math.imul(h ^ v, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  h ^= h >>> 13;
  return h | 0;
}
function rnd(seed, r, k) { return mix(mix(seed | 0, r), k) >>> 0; }
function seedToInt(seedHex) {
  return (typeof seedHex === 'string' && /^[0-9a-fA-F]{8}/.test(seedHex)) ? (parseInt(seedHex.slice(0, 8), 16) | 0) : 0;
}

// steps until the active row shuts (the goo times itself by this)
function stepsToShut(R) {
  if (R.phase === 0) return R.hold - R.t + R.close;
  if (R.phase === 1) return R.close - R.t;
  return 0;
}

// which platform row r is: a pure function of (seed, r)
function typeFor(seed, r, v) {
  if (v >= 4 && r <= 5) return T_SLIDE;          // v4 opens on slow slabs
  if (r <= 3) return T_CLASSIC;
  var d = rnd(seed, r, 7) % 100;
  // v4: like the original game. Three platforms, each moving at one constant
  // speed from the moment it is active: no random wait, no easing, no warnings.
  if (v >= 4) {
    if (r < 8) return d < 30 ? T_CLASSIC : T_SLIDE;
    if (r < 16) return d < 32 ? T_CLASSIC : d < 86 ? T_SLIDE : T_DOOR;
    return d < 34 ? T_CLASSIC : d < 80 ? T_SLIDE : T_DOOR;
  }
  if (v >= 3) {
    if (r < 8) return d < 40 ? T_CLASSIC : d < 65 ? T_SLOW : d < 85 ? T_SLIDE : T_STEADY;
    if (r < 16) return d < 18 ? T_CLASSIC : d < 30 ? T_SLOW : d < 42 ? T_SLIDE : d < 54 ? T_STEADY :
      d < 66 ? T_SWIFT : d < 76 ? T_SNAP : d < 88 ? T_DOOR : T_HEAVY;
    return d < 12 ? T_CLASSIC : d < 21 ? T_SLOW : d < 32 ? T_SLIDE : d < 46 ? T_STEADY : d < 60 ? T_SWIFT :
      d < 74 ? T_SNAP : d < 86 ? T_DOOR : T_HEAVY;
  }
  if (r < 8) return d < 55 ? T_CLASSIC : d < 80 ? T_SLOW : T_SLIDE;
  if (r < 16) return d < 32 ? T_CLASSIC : d < 54 ? T_SLOW : d < 72 ? T_SLIDE : d < 84 ? T_SNAP : T_DOOR;
  return d < 20 ? T_CLASSIC : d < 34 ? T_SLOW : d < 54 ? T_SLIDE : d < 74 ? T_SNAP : T_DOOR;
}
// the whole game speeds up as you climb: every row's timings are scaled by
// speedPct, 100 at the start, falling a percent every 4 rows to a floor of
// SPEED_MIN (reached around row 180). Nothing jumps; it just keeps tightening.
var SPEED_MIN = 55;
function speedPct(r) { var p = 100 - ((r / 4) | 0); return p < SPEED_MIN ? SPEED_MIN : p; }
function scaled(n, r) { return (n * speedPct(r) / 100) | 0; }
// v4 timings, from the original game: a platform is never idle. The step it
// becomes active it starts sliding in from off screen (the hold), and moves
// on without stopping: slabs keep sliding at one constant speed until they
// meet. Flaps hang against the walls and start swinging the moment the row
// is active, gently picking up speed until flat.
// Every timing is fixed per type and row, never random, and shorter the
// higher you climb.
var ENTRY = 150;            // slabs and flaps start this far outside the shaft
// v4 steady climb: 1.75% faster every 4 rows (v2/v3 tighten 1% every 4),
// down to 40% of the base time
function speed4(r) { var p = 100 - ((r * 7) / 16 | 0); return p < 40 ? 40 : p; }
function close4(type, r) {
  // base pace: flaps quickest, double slabs 20% slower, the single slab the
  // slowest; all three speed up at the same relative rate (speed4)
  var base = type === T_DOOR ? 83 : type === T_SLIDE ? 52 : 87;
  // a slow opening that eases smoothly into the steady climb by row 30:
  // slabs and doors 1.5x slower at row 1, flaps (first at row 6) 1.25x
  if (r < 30) base = (base * (100 + (((30 - r) * (30 - r) * (type === T_CLASSIC ? 25 : 50)) / 841 | 0))) / 100 | 0;
  return Math.max(type === T_DOOR ? 38 : type === T_SLIDE ? 23 : 38, (base * speed4(r)) / 100 | 0);
}
// the slide-in runs at the slab's own speed, so the motion never changes pace
function hold4(type, C) {
  if (type === T_SLIDE) return ((ENTRY * C) / SHAFT) | 0;
  if (type === T_DOOR) return ((ENTRY * C) / (2 * SHAFT)) | 0;
  // flaps never slide: they hang against the walls and start swinging at once
  return 0;
}
// shapes and warnings, shared by old and new types
function isSlide(type) { return type === T_SLIDE || type === T_SWIFT; }
function isDoor(type) { return type === T_DOOR || type === T_HEAVY; }
function hasTell(type) { return type === T_SNAP; }
function closeFor(type, r) {
  var base = type === T_SNAP ? 30 : type === T_SLOW ? 100 : type === T_DOOR ? 62 :
    type === T_SWIFT ? 50 : type === T_HEAVY ? 110 : type === T_STEADY ? 40 : 58;
  return Math.max(hasTell(type) ? 18 : 34, scaled(base, r));
}
function holdFor(seed, r, type, att) {
  var mn, vr;
  if (r <= 4) { mn = 40; vr = 16; }
  else { mn = Math.max(30, scaled(40, r)); vr = scaled(Math.min(56, 12 + r), r); }
  if (hasTell(type)) mn += SNAP_TELL;
  if (type === T_HEAVY) mn += 16;
  if (type === T_STEADY) mn += 10;
  var h = mn + rnd(seed, r, 1 + att * 3) % (vr + 1);
  return h < 6 ? 6 : h;
}

// closing progress after t steps of a close lasting C (0..F1)
function closeFrac(type, t, C, lin) {
  if (t >= C) return F1;
  // v4 flaps: a gentle start that builds through the swing, so the jump
  // comes about a second after landing (as on slabs) while the last part,
  // where the flaps reach the jelly, stays quick enough to be fair
  if (lin === 2) return (F1 * (t * t * C + t * t * t) / (2 * C * C * C)) | 0;
  if (lin) return (F1 * t / C) | 0;                                     // v4: constant speed
  if (type === T_SLOW || type === T_HEAVY) return (F1 * t * t * t / (C * C * C)) | 0;   // lazy start, firm finish
  if (type === T_SWIFT) return (F1 * t * (2 * C - t) / (C * C)) | 0;   // rushes out, eases in
  if (type === T_STEADY) return (F1 * t / C) | 0;                      // one constant speed
  return (F1 * t * t / (C * C)) | 0;
}
function hasDrop(seed, r) { return r >= 3 && rnd(seed, r, 999) % 3 === 0; }
function rowTop(r) { return r * ROW_H * Q; }
function edgeLift(a) { return ((EDGE_D * Q * TAN[a]) / 4096) | 0; }

function setProgress(R, f) {
  R.f = f;
  R.ang = A_OPEN - ((A_OPEN * f / F1) | 0);
  R.gap = SHAFT - ((SHAFT * f / F1) | 0);
}
// does the closing row reach the jelly's column, and where is its surface there
function inContact(R) {
  if (isSlide(R.type)) return R.gap <= HALF;
  if (isDoor(R.type)) return R.gap <= DOOR_CONTACT;
  return R.ang <= A_EDGE;
}
function surfAt(R, h) { return isSlide(R.type) || isDoor(R.type) ? h : h - edgeLift(R.ang); }

function newRow(seed, r, att, v) {
  var type = typeFor(seed, r, v);
  var R = { idx: r, type: type, side: (rnd(seed, r, 5) & 1) ? 1 : -1, att: att, phase: 0, t: 0,
            hold: holdFor(seed, r, type, att), close: closeFor(type, r), f: 0, ang: A_OPEN, gap: SHAFT, lin: 0 };
  if (v >= 4) { R.lin = type === T_CLASSIC ? 2 : 1; R.close = close4(type, r); R.hold = hold4(type, R.close); }
  return R;
}

// version from the trace's start marker: a v2 run replays on v2 rules
function initSim(seed, version) {
  var v = version >= 4 ? 4 : version >= 3 ? 3 : 2;
  return {
    seed: seed | 0, version: v, step: 0, floorRow: 0, y: 0, vy: 0, grounded: true, alive: true,
    row: newRow(seed, 1, 0, v), goo: -GOO_FAR * Q, score: 0, rows: 0, streak: 0,
    drops: 0, dropTaken: -1, buffer: -1, pull: -1, stuck: 0, rise: 0,
    pin: -1, pinT: 0, under: 0, surfPrev: NO_SURF, ev: 0,
  };
}

function launch(s, v) {
  // a stuck jelly has squeezed itself out: it leaves from the row's surface
  if (s.stuck > 0) s.y = rowTop(s.floorRow);
  s.vy = v; s.grounded = false; s.stuck = 0; s.pull = -1;
  s.pin = -1; s.under = 0; s.surfPrev = NO_SURF; s.ev |= EV_JUMP;
}

function landRow(s, sunk) {
  var R = s.row;
  if (sunk === 0) { s.streak++; s.score += Math.min(s.streak, 5); s.ev |= EV_PERFECT; }
  else { s.streak = 0; s.score += 1; s.ev |= EV_STUCK; }
  s.rows++;
  s.floorRow = R.idx; s.stuck = sunk; s.y = rowTop(R.idx) - sunk;
  s.grounded = true; s.vy = 0; s.pin = -1; s.under = 0; s.surfPrev = NO_SURF;
  s.ev |= EV_LAND;
  s.row = newRow(s.seed, R.idx + 1, 0, s.version);
}

function stepSim(s, pressed) {
  s.ev = 0;
  if (!s.alive) return;
  s.step++;
  if (pressed) s.buffer = BUFFER_STEPS;

  // the active row
  var R = s.row, h = rowTop(R.idx);
  R.t++;
  if (R.phase === 0) {
    if (hasTell(R.type) && R.t === R.hold - SNAP_TELL) s.ev |= EV_TELL;
    if (R.t >= R.hold) { R.phase = 1; R.t = 0; }
  }
  if (R.phase === 1) {
    setProgress(R, closeFrac(R.type, R.t, R.close, R.lin));
    if (R.f === F1) { R.phase = 2; R.t = 0; s.ev |= EV_CLOSE; }
  }

  // a stuck jelly squeezing itself out of the row, a little each step
  if (s.pull >= 0) {
    if (s.pull === 0) launch(s, JUMP_V);
    else { s.pull--; s.y = Math.min(rowTop(s.floorRow), s.y + s.rise); }
  }
  // jump
  if (s.buffer >= 0) {
    if (s.grounded && s.pull < 0) {
      s.buffer = -1;
      if (s.stuck > 0) {
        s.pull = PULL_BASE + ((s.stuck / PULL_DIV) | 0);
        s.rise = ((s.stuck + s.pull - 1) / s.pull) | 0;
        s.ev |= EV_PULL;
      }
      else launch(s, JUMP_V);
    } else {
      s.buffer--;
    }
  }

  if (!s.grounded) {
    var prevY = s.y;
    if (s.pin >= 0) {
      // gripped by the closing row: carried up with it, sinking in a little
      s.vy = 0;
      if (s.pin < s.pinT) s.pin = Math.min(s.pinT, s.pin + PIN_SINK);
      s.y = (inContact(R) ? surfAt(R, h) : h) - s.pin;
      if (R.f === F1) landRow(s, s.pin <= PIN_CLEAN * Q ? 0 : s.pin);
    } else {
      s.vy -= G;
      s.y += s.vy;
      if (inContact(R)) {
        var surf = surfAt(R, h), under = surf - SLAB * Q;
        if (!s.under && s.y < surf) {
          if (prevY >= s.surfPrev) {
            // came down onto the closing row (or it rose to meet the jelly)
            var L = h - surf;
            if (L <= RIDE * Q) { s.y = surf; s.vy = 0; }               // nearly flat: stands on it
            else {
              // dropped into the half-open row: it sinks into the gap as it shuts
              s.pin = surf - s.y; s.pinT = Math.max(s.pin, Math.min(CATCH * Q, (L * 45 / 100) | 0));
              s.vy = 0; s.ev |= EV_CATCH;
            }
          } else if (s.y + CUBE * Q - surf >= (CUBE - CATCH) * Q) {
            // the row closes around it: gripped, and carried up with it
            s.pin = surf - s.y; s.pinT = s.pin; s.vy = 0; s.ev |= EV_CATCH;
          } else {
            s.under = 1;                                               // under it: a miss
          }
        }
        if (s.under && s.y + CUBE * Q > under) {
          s.y = under - CUBE * Q;
          if (s.vy > 0) s.vy = 0;
          s.ev |= EV_BUMP;
        }
        s.surfPrev = surf;
        if (s.pin < 0 && !s.under && R.f === F1 && s.y <= h && s.vy <= 0) { s.y = h; landRow(s, 0); }
      } else {
        s.surfPrev = NO_SURF;
      }
      if (!s.grounded && s.pin < 0) {
        var fl = rowTop(s.floorRow);
        if (s.y <= fl && s.vy < 0) { s.y = fl; s.vy = 0; s.grounded = true; s.ev |= EV_FLOOR; }
      }
    }
  }

  // a drop hanging in the gap
  var dR = s.row.idx;
  if (hasDrop(s.seed, dR) && s.dropTaken !== dR) {
    var dy = rowTop(dR) + DROP_Y * Q;
    if (s.y <= dy + DROP_R * Q && s.y + CUBE * Q >= dy - DROP_R * Q) {
      s.dropTaken = dR; s.drops++; s.score++; s.ev |= EV_DROP;
    }
  }

  // the goo keeps pace with the row above: just under the floor as it shuts,
  // and surging once it has, so each row is one chance
  var flr = rowTop(s.floorRow), R2 = s.row;
  var pace = flr - GOO_NEAR * Q - stepsToShut(R2) * GOO_PACE;
  if (pace < flr - GOO_FAR * Q) pace = flr - GOO_FAR * Q;
  if (s.goo < pace) s.goo = pace;
  s.goo += R2.phase === 2 ? GOO_SURGE : GOO_CREEP;
  if (s.goo >= s.y + GOO_KILL * Q) { s.alive = false; s.ev |= EV_DIE; }
}
// ==== JELLY JUMP RULES END ====

// ── server-only bounds ──────────────────────────────────────────────────
// An hour of simulation: the session's own lifetime. A cap below it would
// silently TRUNCATE a legal run. shared/tests/sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// A tap can land at most once a step, so an hour holds at most MAX_SIM_STEPS of
// them. A work bound that REFUSES further input, never zeroes a run.
const MAX_INPUTS = MAX_SIM_STEPS + 200;
const MIN_REPLAY_VERSION = 2;

function isInt(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v; }

function newStats() {
  return { taps: 0, gaps: [], lastTap: -1, airTaps: 0, landToTap: [], lastLand: -1, perfect: 0, stuck: 0 };
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none', sim: null, seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, rejectCount: 0, score: 0, version: 0, nextN: 0,
    maxDurationSecs: Number(maxDurationSecs) || 3600, elapsedSecs: Number(elapsedSecs) || 0,
    stats: newStats(),
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

// One step, watched. The accounting reads the run and never writes it.
function stepWatch(state, pressed) {
  const sim = state.sim, st = state.stats;
  if (pressed) {
    st.taps++;
    if (st.lastTap >= 0) st.gaps.push(sim.step + 1 - st.lastTap);
    st.lastTap = sim.step + 1;
    if (!sim.grounded) st.airTaps++;
    else if (st.lastLand >= 0) st.landToTap.push(sim.step + 1 - st.lastLand);
  }
  stepSim(sim, pressed);
  if (sim.ev & EV_LAND) { st.lastLand = sim.step; if (sim.ev & EV_PERFECT) st.perfect++; else st.stuck++; }
  if (state.onStep) state.onStep(sim);         // test-only: parity compares every step
}

function advanceTo(state, step) {
  const sim = state.sim;
  while (sim.alive && sim.step < step && sim.step < MAX_SIM_STEPS) stepWatch(state, false);
}

function processEvent(state, event) {
  if (!event || typeof event !== 'object' || event.type !== 'input') return { accepted: true, newScore: state.score };
  const p = event.payload || {};
  if (p.kind === 'start') {
    if (Number(p.v) >= MIN_REPLAY_VERSION && state.mode !== 'sim') {
      state.mode = 'sim';
      state.version = Number(p.v) >= 4 ? 4 : Number(p.v) >= 3 ? 3 : 2;
      state.sim = initSim(seedToInt(state.seed), state.version);
    }
    return { accepted: true, newScore: state.score };
  }
  // No start marker, no replay, no score.
  if (state.mode !== 'sim' || p.kind !== 'tap') return { accepted: true, newScore: state.score };
  const sim = state.sim;
  if (!sim.alive) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  // `typeof` first: Number(null) is 0, so coercing would apply a malformed step.
  const { n, step } = p;
  if (!isInt(n) || !isInt(step) || step < 1) return reject(state, 'bad_tap');
  if (n !== state.nextN) return reject(state, 'out_of_order');
  // A tap lands on a step not yet played; steps never repeat or rewind.
  if (step <= sim.step) return reject(state, 'frame_regressed');
  if (step > MAX_SIM_STEPS) return reject(state, 'too_late');
  state.nextN++;
  advanceTo(state, step - 1);
  if (!sim.alive) { state.score = sim.score; return { accepted: false, newScore: state.score, reason: 'dead' }; }
  stepWatch(state, true);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// Bounded by how long the session REALLY lasted. A fixed step only drops time,
// never adds it, so an honest run always dies inside this bound. Only the
// submit replay passes elapsedSecs; the live stream keeps the session bound.
function elapsedCap(state) {
  const e = Number(state.elapsedSecs);
  if (!Number.isFinite(e) || e <= 0) return Infinity;
  return Math.ceil((e * 1.2 + 10) * 60);
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
}
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }

function finalize(state) {
  if (state.mode !== 'sim' || !state.sim) return { score: 0, gameOver: false, suspicious: null, debug: { mode: 'none' } };
  const sim = state.sim, st = state.stats;
  // Run the world out past the last tap: a jelly that stops jumping is
  // swallowed by the goo within a couple of seconds.
  const runOut = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const cap = elapsedCap(state);
  let guard = 0;
  while (sim.alive && guard < runOut && sim.step < cap && sim.step < MAX_SIM_STEPS) { stepWatch(state, false); guard++; }
  const g = st.gaps, lt = st.landToTap;
  const gm = mean(g), lm = mean(lt);
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', steps: sim.step, dead: !sim.alive, score: sim.score, rows: sim.rows, drops: sim.drops,
      inputs: state.inputCount, rejects: state.rejectCount,
      // Not gated. Raw material for the bot fingerprint: a hand's timing
      // scatters around the PERFECT window; a planner hits it the same way
      // every time.
      fingerprint: {
        taps: st.taps,
        perfect: st.perfect, stuck: st.stuck,
        perfectShare: st.perfect + st.stuck > 0 ? r3(st.perfect / (st.perfect + st.stuck)) : null,
        gapMean: r3(gm), gapCv: gm ? r3(sd(g) / gm) : null,
        landToTapMean: r3(lm), landToTapCv: lm ? r3(sd(lt) / lm) : null,
        airTapShare: st.taps ? r3(st.airTaps / st.taps) : null,
      },
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
    initSim, stepSim, newRow, typeFor, closeFor, holdFor, closeFrac, hasDrop, rowTop, speedPct, scaled, rnd, mix,
    seedToInt, stepsToShut, inContact, surfAt, edgeLift, advanceTo, stepWatch,
    MAX_SIM_STEPS, MAX_INPUTS, RULES_VERSION, MIN_REPLAY_VERSION,
    T_CLASSIC, T_SLOW, T_SLIDE, T_SNAP, T_DOOR, EV_LAND, EV_PERFECT, EV_DIE, EV_JUMP, EV_STUCK,
  },
};
