'use strict';

/**
 * Brick Breaker validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Built on replay from day one: a trace without a v2 start marker is not a run
 * and scores zero. One mode: ENDLESS, one ball, one life.
 *
 * What the server does with a trace:
 *   1. rebuilds every wall from the session seed (wall K is a pure function of
 *      (seed, K));
 *   2. applies each path batch { f, x[] }: x[i] is the paddle's TARGET during
 *      step f + 1 + i, set before that step runs;
 *   3. applies each { kind: 'launch', step }: the serve is launched before
 *      step `step` runs;
 *   4. runs the same fixed 1/60 s steps and scores every brick itself.
 *
 * The rules block below is the client's js/rules.js between the markers, word
 * for word; shared/tests/brickBreakerParity.test.js fails if the two differ.
 * Integers only, so no dmath.
 */

// BRICK BREAKER RULES BEGIN
var ET = (function () {
  'use strict';

  // ── geometry (design units; positions are stored in 1/256 of one) ───────
  var P = 256;
  var W = 414, H = 736;
  var TOP = 58;              // the ceiling: the HUD sits above it
  var COLS = 9, ROWS = 8;    // the wall grid
  var BW = 44, BH = 22;      // one brick cell
  var GX = 9;                // left edge of the grid ((414 - 9 * 44) / 2)
  var WALL_TOP = 96;         // top of row 0 before the wall has moved down
  var PAD_Y = 590;           // top of the paddle, high enough that a thumb below it never hides it
  var PAD_H = 12;
  var PAD_W = 76, PAD_W_WIDE = 116, PAD_W_SHRINK = 48;
  var DEATH_Y = 570;         // a brick whose bottom reaches this ends the run
  var BALL_R = 6;
  var RATE = 30;             // the paddle chases its target at most this far a step
  var SUB = 8;               // ball substeps a step

  // ── speed (sub-units a substep, along a direction of length 1024) ────────
  // A ball starts at 250 * 8 / 256 = 7.8 design units a step (470 a second),
  // gains SPD_HIT for every paddle return in a wall (up to HITS_CAP) and
  // SPD_WALL for every wall cleared. At SPD_MAX it moves 420 sub-units (1.64
  // design units) on an axis in a substep. The thinnest thing it can hit is a
  // brick row or the paddle grown by the ball's diameter (22 + 12, 12 + 12),
  // so it can never step over one.
  var SPD0 = 250, SPD_WALL = 12, SPD_HIT = 3, HITS_CAP = 20, SPD_MAX = 440;
  // The clock ramps it too: +5 every 10 s of the run, up to SPD_MAX. At
  // SPD_MAX 440 a ball still moves at most 1.72 design units on an axis in a
  // substep.
  var SPD_TIME = 5, TIME_EVERY = 600;

  // ── timers (steps of 1/60 s) ─────────────────────────────────────────────
  var RUN_STEPS = 54000;     // ENDLESS ends after 15 minutes of steps, so no run can outlast the session
  var SHIFT_STEPS = 1800;    // at the start, 30 s without a clear moves the wall down a row
  var SHIFT_LESS = 50;       // that wait shortens by 50 steps every 10 s of the run
  var SHIFT_MIN = 900;       // to no less than 15 s
  var SERVE_AUTO = 180;      // a ball not launched in 3 s launches itself
  var POWER_STEPS = 540;     // WIDE and FIRE last 9 s
  var LASER_STEPS = 300;     // LASER lasts 5 s
  var FRENZY_AT = 30;        // bricks broken without losing a ball to start FRENZY
  var FRENZY_STEPS = 480;    // FRENZY lasts 8 s: fire, lasers, wide, double points
  var CLEAN_LEFT = 3;        // this few bricks left: the paddle's lasers switch on
  var LASER_EVERY = 18;      // a pair of bolts every 18 steps (0.3 s)
  var BOLT_V = 14;           // a bolt climbs 14 units a step (two substeps of 7)
  var CAP_V = 3;             // a capsule falls 3 units a step
  var CAP_W = 36, CAP_H = 20;
  var LIVES = 1;             // one ball, one life
  var MAX_SIM_STEPS = 216000;

  // ── scoring ──────────────────────────────────────────────────────────────
  var PTS_NORMAL = 10, PTS_TOUGH = 25, PTS_BOMB = 10, PTS_ROW = 10, PTS_GEM = 100, CLEAR_PTS = 100;
  var COMBO_EVERY = 5, COMBO_MAX = 5, FRENZY_MULT = 2;

  // kinds of brick and power-up
  var K_NONE = 0, K_NORMAL = 1, K_TOUGH = 2, K_STEEL = 3, K_BOMB = 4, K_ROW = 5, K_GEM = 6;
  var PU_WIDE = 1, PU_SHRINK = 2, PU_FIRE = 3, PU_LASER = 4;

  // The paddle bounce: the ball leaves at 7.5 degree steps either side of
  // straight up, picked by where it struck. Directions have length 1024.
  var DIR_X = [-887, -812, -724, -623, -512, -392, -265, -134, 0, 134, 265, 392, 512, 623, 724, 812, 887];
  var DIR_Y = [-512, -623, -724, -812, -887, -946, -989, -1015, -1024, -1015, -989, -946, -887, -812, -724, -623, -512];

  function u32(x) { return x >>> 0; }
  function hash(seed, a, b, c) {
    var h = u32(seed ^ Math.imul(a + 0x9e3779b9 | 0, 0x85ebca6b));
    h = u32(Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ Math.imul(b + 0x27d4eb2f | 0, 0x165667b1));
    h = u32(Math.imul(h ^ (h >>> 16), 0x27d4eb2f) ^ c);
    h = u32(Math.imul(h ^ (h >>> 15), 0x85ebca6b));
    h ^= h >>> 13;
    return h >>> 0;
  }
  // a / b truncated toward zero, for integers
  function tr(a, b) { return (a - a % b) / b; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ── the wall: a pure function of (seed, wall number, cell) ───────────────
  // Presence and kind are drawn from the MIRRORED cell, so every wall is
  // symmetric; drops from the real cell. Four draws on every cell, always.
  function buildWall(seed, k) {
    var kind = [], hp = [], drop = [];
    var shape = k === 0 ? 0 : hash(seed, k, 9999, 0) % 6;
    var rows = Math.min(ROWS, 5 + Math.min(3, k));
    var holeP = 12;
    var toughP = Math.min(36, 8 + 5 * k);
    var steelP = k < 2 ? 0 : Math.min(8, 1 + 2 * k);
    var bombP = 9, rowP = k === 0 ? 3 : 5, gemP = 3;
    var any = false;
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var mc = Math.min(c, COLS - 1 - c), cell = r * COLS + c, mcell = r * COLS + mc;
        var h0 = hash(seed, k, mcell, 0), h1 = hash(seed, k, mcell, 1);
        var h2 = hash(seed, k, cell, 2), h3 = hash(seed, k, cell, 3);
        var on = r < rows && h0 % 100 >= holeP;
        if (on && shape === 1) on = (r + c) % 2 === 0 || r % 3 === 0;
        if (on && shape === 2) on = mc >= Math.min(4, Math.floor(r / 2));
        if (on && shape === 3) on = c % 4 !== 2;
        if (on && shape === 4) on = mc <= 1 || mc >= 3 || r % 2 === 0;
        if (on && shape === 5) on = r < 2 || mc !== 4 - (r % 5);
        var t = h1 % 100, kd = K_NONE;
        if (on) {
          if (t < steelP && r < rows - 1) kd = K_STEEL;
          else if ((t -= steelP) < bombP) kd = K_BOMB;
          else if ((t -= bombP) < rowP) kd = K_ROW;
          else if ((t -= rowP) < gemP) kd = K_GEM;
          else if ((t -= gemP) < toughP) kd = K_TOUGH;
          else kd = K_NORMAL;
        }
        kind.push(kd);
        hp.push(kd === K_NONE ? 0 : (kd === K_TOUGH ? 2 : 1));
        var d = 0;
        if (kd !== K_NONE && kd !== K_STEEL && h2 % 1000 < 56) {         // about one brick in eighteen carries a power-up

          var p = h3 % 20;
          d = p < 6 ? PU_WIDE : (p < 10 ? PU_SHRINK : (p < 16 ? PU_FIRE : PU_LASER));
        }
        drop.push(d);
        if (kd !== K_NONE && kd !== K_STEEL) any = true;
      }
    }
    if (!any) { kind[4] = K_NORMAL; hp[4] = 1; }
    return { kind: kind, hp: hp, drop: drop };
  }

  // One mode: ENDLESS. One ball, one life, no clock.
  function initSim(seed, version) {
    var w = buildWall(seed, 0);
    return {
      version: version | 0, seed: seed >>> 0, frames: 0,
      wall: 0, kind: w.kind, hp: w.hp, drop: w.drop, shift: 0, quiet: 0,
      px: (W >> 1) * P, target: (W >> 1) * P,
      balls: [], caps: [], bolts: [], nextId: 1,
      serve: true, serveT: 0, launches: 0,
      lives: LIVES, score: 0, combo: 0, bestCombo: 0, bricks: 0, hits: 0,
      wide: 0, shrink: 0, fire: 0, laser: 0, laserT: 0, meter: 0, frenzy: 0, frenzies: 0,
      dead: false, events: [],
    };
  }

  function padW(sim) { return sim.shrink > 0 ? PAD_W_SHRINK : PAD_W; }
  function halfW(sim) { return ((sim.wide > 0 || sim.frenzy > 0) ? PAD_W_WIDE : padW(sim)) >> 1; }
  function speed(sim) {
    return Math.min(SPD_MAX, SPD0 + SPD_WALL * sim.wall + SPD_HIT * Math.min(sim.hits, HITS_CAP) +
      SPD_TIME * Math.floor(sim.frames / TIME_EVERY));
  }
  function shiftSteps(sim) { return Math.max(SHIFT_MIN, SHIFT_STEPS - SHIFT_LESS * Math.floor(sim.frames / TIME_EVERY)); }
  function fireOn(sim) { return sim.fire > 0 || sim.frenzy > 0; }
  function rowTop(sim, r) { return WALL_TOP + (r + sim.shift) * BH; }
  function mult(combo) { return Math.min(COMBO_MAX, 1 + Math.floor(combo / COMBO_EVERY)); }
  function left(sim) { var n = 0; for (var i = 0; i < sim.hp.length; i++) if (sim.hp[i] > 0 && sim.kind[i] !== K_STEEL) n++; return n; }
  function laserOn(sim) { return sim.laser > 0 || sim.frenzy > 0 || left(sim) <= CLEAN_LEFT; }

  // Inputs. Both are part of a step: the target is set and a launch made
  // before the world moves.
  function setTarget(sim, x) {
    if (typeof x !== 'number' || !(x === Math.floor(x))) return false;
    sim.target = clamp(x, 0, W) * P;
    return true;
  }
  function launch(sim) {
    if (!sim.serve || sim.dead) return false;
    var i = (sim.launches & 1) ? 6 : 10;
    sim.launches++;
    sim.serve = false; sim.serveT = 0;
    sim.balls = [{ id: sim.nextId++, x: sim.px, y: (PAD_Y - BALL_R) * P, dx: DIR_X[i], dy: DIR_Y[i] }];
    return true;
  }

  // One brick takes one hit. Writes sim.hp (already owned by this step),
  // score, capsules and events; blasts (bombs, row bricks) are queued.
  function hitCell(sim, cell, outright, ev, blasts, src) {
    var kd = sim.kind[cell];
    if (sim.hp[cell] <= 0) return;
    if (kd === K_STEEL) { ev.push({ t: 'steel', cell: cell, src: src }); return; }
    sim.combo++;
    if (sim.combo > sim.bestCombo) sim.bestCombo = sim.combo;
    var m = mult(sim.combo) * (sim.frenzy > 0 ? FRENZY_MULT : 1);
    if (!outright && kd === K_TOUGH && sim.hp[cell] === 2) {
      sim.hp[cell] = 1;
      ev.push({ t: 'crack', cell: cell, combo: sim.combo, src: src });
      return;
    }
    sim.hp[cell] = 0;
    sim.bricks++;
    var base = kd === K_TOUGH ? PTS_TOUGH : (kd === K_BOMB ? PTS_BOMB : (kd === K_ROW ? PTS_ROW : (kd === K_GEM ? PTS_GEM : PTS_NORMAL)));
    var pts = base * m;
    sim.score += pts;
    ev.push({ t: 'break', cell: cell, kind: kd, pts: pts, combo: sim.combo, m: m, src: src });
    if (sim.frenzy <= 0) {
      sim.meter++;
      if (sim.meter >= FRENZY_AT) { sim.meter = 0; sim.frenzy = FRENZY_STEPS; sim.frenzies++; ev.push({ t: 'frenzy' }); }
    }
    var d = sim.drop[cell];
    if (d > 0) {
      var c = cell % COLS, r = (cell - c) / COLS;
      sim.caps = sim.caps.concat([{ id: sim.nextId++, p: d, x: (GX + c * BW + (BW >> 1)) * P, y: (rowTop(sim, r) + (BH >> 1)) * P }]);
    }
    if (kd === K_BOMB || kd === K_ROW) blasts.push(cell);
  }
  function blast(sim, cell, ev, blasts) {
    var c = cell % COLS, r = (cell - c) / COLS;
    if (sim.kind[cell] === K_ROW) {
      ev.push({ t: 'row', cell: cell, row: r });
      for (var cc = 0; cc < COLS; cc++) if (cc !== c) hitCell(sim, r * COLS + cc, true, ev, blasts, 'row');
      return;
    }
    ev.push({ t: 'bomb', cell: cell });
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        var rr = r + dr, c2 = c + dc;
        if ((dr === 0 && dc === 0) || rr < 0 || rr >= ROWS || c2 < 0 || c2 >= COLS) continue;
        hitCell(sim, rr * COLS + c2, true, ev, blasts, 'bomb');
      }
    }
  }

  // One ball, one step. Returns the moved ball, or null when it falls out.
  function moveBall(sim, b, spd, hw, ev, blasts) {
    var x = b.x, y = b.y, dx = b.dx, dy = b.dy;
    var R = BALL_R * P, fire = fireOn(sim);
    var shiftY = (WALL_TOP + sim.shift * BH) * P;
    for (var s = 0; s < SUB; s++) {
      var nx = x + tr(dx * spd, 1024), ny = y + tr(dy * spd, 1024);
      if (nx < R) { nx = 2 * R - nx; dx = -dx; ev.push({ t: 'side', x: R, y: ny }); }
      if (nx > W * P - R) { nx = 2 * (W * P - R) - nx; dx = -dx; ev.push({ t: 'side', x: W * P - R, y: ny }); }
      if (ny < TOP * P + R) { ny = 2 * (TOP * P + R) - ny; dy = -dy; ev.push({ t: 'side', x: nx, y: TOP * P + R }); }
      // bricks: the ball as a square of side 2R against whole cells
      var c0 = Math.floor((nx - R - GX * P) / (BW * P)), c1 = Math.floor((nx + R - GX * P) / (BW * P));
      var r0 = Math.floor((ny - R - shiftY) / (BH * P)), r1 = Math.floor((ny + R - shiftY) / (BH * P));
      var solid = -1, hits = [];
      for (var r = Math.max(0, r0); r <= Math.min(ROWS - 1, r1); r++) {
        for (var c = Math.max(0, c0); c <= Math.min(COLS - 1, c1); c++) {
          var cell = r * COLS + c;
          if (sim.hp[cell] <= 0) continue;
          var bx0 = (GX + c * BW) * P, by0 = shiftY + r * BH * P;
          var bx1 = bx0 + BW * P, by1 = by0 + BH * P;
          var inX = x + R > bx0 && x - R < bx1, inY = y + R > by0 && y - R < by1;
          if (inX && inY) continue;       // already inside (the wall moved onto it): pass out
          hits.push(cell);
          if (solid < 0 && (!fire || sim.kind[cell] === K_STEEL)) solid = hits.length - 1;
        }
      }
      if (hits.length) {
        for (var i = 0; i < hits.length; i++) hitCell(sim, hits[i], fire, ev, blasts, 'ball');
        if (solid >= 0) {
          var sc = hits[solid], scc = sc % COLS, sr = (sc - scc) / COLS;
          var sx0 = (GX + scc * BW) * P, sy0 = shiftY + sr * BH * P;
          var pinX = x + R > sx0 && x - R < sx0 + BW * P;
          var pinY = y + R > sy0 && y - R < sy0 + BH * P;
          if (pinX) dy = -dy; else if (pinY) dx = -dx; else { dx = -dx; dy = -dy; }
          nx = x; ny = y;
        }
      }
      // the paddle: only from above
      var py = PAD_Y * P;
      if (dy > 0 && ny + R >= py && y + R <= py + (PAD_H >> 1) * P && ny - R < py + PAD_H * P &&
          nx >= sim.px - hw * P - R && nx <= sim.px + hw * P + R) {
        // never straight up: a dead-centre hit leans to the side it was on
        var idx = clamp(tr((nx - sim.px) * 8, hw * P), -8, 8);
        if (idx === 0) idx = nx < sim.px ? -1 : 1;
        dx = DIR_X[idx + 8]; dy = DIR_Y[idx + 8];
        ny = py - R;
        sim.combo = 0;
        sim.hits++;
        ev.push({ t: 'paddle', off: idx, x: nx });
      }
      x = nx; y = ny;
      if (y - R > H * P) return null;
    }
    return { id: b.id, x: x, y: y, dx: dx, dy: dy };
  }

  // Laser bolts climb from the paddle's two cannons and hit the first brick.
  function moveBolts(sim, ev, blasts) {
    var keep = [];
    var shiftY = (WALL_TOP + sim.shift * BH) * P;
    for (var i = 0; i < sim.bolts.length; i++) {
      var bt = sim.bolts[i], y = bt.y, gone = false;
      for (var s = 0; s < 2 && !gone; s++) {
        y -= (BOLT_V >> 1) * P;
        if (y < TOP * P) { gone = true; break; }
        var c = Math.floor((bt.x - GX * P) / (BW * P)), r = Math.floor((y - shiftY) / (BH * P));
        if (c >= 0 && c < COLS && r >= 0 && r < ROWS && sim.hp[r * COLS + c] > 0) {
          hitCell(sim, r * COLS + c, false, ev, blasts, 'laser');
          ev.push({ t: 'boltHit', x: bt.x, y: y });
          gone = true;
        }
      }
      if (!gone) keep.push({ id: bt.id, x: bt.x, y: y });
    }
    sim.bolts = keep;
  }

  function applyPower(sim, p, ev) {
    if (p === PU_WIDE) { sim.wide = POWER_STEPS; sim.shrink = 0; }
    else if (p === PU_SHRINK) { sim.shrink = POWER_STEPS; sim.wide = 0; }
    else if (p === PU_FIRE) sim.fire = POWER_STEPS;
    else if (p === PU_LASER) sim.laser = LASER_STEPS;
    ev.push({ t: 'power', p: p });
  }

  function stepSim(sim) {
    if (sim.dead) return;
    sim.frames++;
    var ev = [], blasts = [];
    sim.hp = sim.hp.slice();            // this step owns its own copy
    if (sim.wide > 0) sim.wide--;
    if (sim.shrink > 0) sim.shrink--;
    if (sim.fire > 0) sim.fire--;
    if (sim.laser > 0) sim.laser--;
    if (sim.frenzy > 0) { sim.frenzy--; if (sim.frenzy === 0) ev.push({ t: 'frenzyEnd' }); }
    var hw = halfW(sim);

    // the paddle chases its target
    var t = clamp(sim.target, hw * P, (W - hw) * P);
    if (sim.px < hw * P) sim.px = hw * P;
    if (sim.px > (W - hw) * P) sim.px = (W - hw) * P;
    sim.px += clamp(t - sim.px, -RATE * P, RATE * P);

    if (sim.serve) {
      sim.serveT++;
      if (sim.serveT >= SERVE_AUTO && launch(sim)) ev.push({ t: 'launch', auto: true });
    } else {
      var spd = speed(sim), next = [];
      for (var i = 0; i < sim.balls.length; i++) {
        var nb = moveBall(sim, sim.balls[i], spd, hw, ev, blasts);
        if (nb) next.push(nb);
      }
      sim.balls = next;
      // lasers: a pair of bolts every LASER_EVERY steps while they are on
      if (laserOn(sim)) {
        sim.laserT++;
        if (sim.laserT >= LASER_EVERY) {
          sim.laserT = 0;
          var off = (hw - 7) * P, by = (PAD_Y - 4) * P;
          sim.bolts = sim.bolts.concat([{ id: sim.nextId++, x: sim.px - off, y: by }, { id: sim.nextId++, x: sim.px + off, y: by }]);
          ev.push({ t: 'zap' });
        }
      } else sim.laserT = 0;
    }
    moveBolts(sim, ev, blasts);
    for (var q = 0; q < blasts.length; q++) blast(sim, blasts[q], ev, blasts);

    // capsules fall; the paddle catches them
    var keep = [], caught = [];
    for (var j = 0; j < sim.caps.length; j++) {
      var cp = sim.caps[j], cy = cp.y + CAP_V * P;
      var hitPad = cy + (CAP_H >> 1) * P >= PAD_Y * P && cy - (CAP_H >> 1) * P <= (PAD_Y + PAD_H) * P &&
        cp.x + (CAP_W >> 1) * P >= sim.px - hw * P && cp.x - (CAP_W >> 1) * P <= sim.px + hw * P;
      if (hitPad) caught.push(cp.p);
      else if (cy - (CAP_H >> 1) * P <= H * P) keep.push({ id: cp.id, p: cp.p, x: cp.x, y: cy });
    }
    sim.caps = keep;
    for (var k = 0; k < caught.length; k++) applyPower(sim, caught[k], ev);

    // the wall is cleared: a bonus and the next wall, served from the paddle
    if (left(sim) === 0) {
      var bonus = CLEAR_PTS * (sim.wall + 1);
      sim.score += bonus;
      sim.wall++;
      var w = buildWall(sim.seed, sim.wall);
      sim.kind = w.kind; sim.hp = w.hp; sim.drop = w.drop;
      sim.shift = 0; sim.quiet = 0; sim.hits = 0;
      sim.balls = []; sim.caps = []; sim.bolts = []; sim.serve = true; sim.serveT = 0;
      sim.combo = 0; sim.fire = 0; sim.laser = 0;
      ev.push({ t: 'clear', bonus: bonus, wall: sim.wall });
    } else {
      // the one ball is lost: the run is over
      if (!sim.serve && sim.balls.length === 0) {
        sim.lives--;
        ev.push({ t: 'lost', lives: sim.lives });
        sim.dead = true; ev.push({ t: 'dead', why: 'balls' });
      }
      // nobody parks: 30 s without a clear moves the wall down a row
      sim.quiet++;
      if (sim.quiet >= shiftSteps(sim)) { sim.quiet = 0; sim.shift++; ev.push({ t: 'shift' }); }
      var low = -1;
      for (var n = 0; n < sim.hp.length; n++) if (sim.hp[n] > 0) low = Math.floor(n / COLS);
      if (!sim.dead && low >= 0 && rowTop(sim, low) + BH >= DEATH_Y) { sim.dead = true; ev.push({ t: 'dead', why: 'wall' }); }
    }
    // the clock: the run ends after RUN_STEPS steps whatever is happening
    if (!sim.dead && sim.frames >= RUN_STEPS) { sim.dead = true; ev.push({ t: 'dead', why: 'time' }); }
    sim.events = ev;
  }

  // One full step as the trace describes it: an optional new target, an
  // optional launch, then the world moves.
  function tick(sim, target, doLaunch) {
    if (target != null) setTarget(sim, target);
    var launched = doLaunch ? launch(sim) : false;
    stepSim(sim);
    if (launched) sim.events = [{ t: 'launch' }].concat(sim.events);
    return launched;
  }

  return {
    P: P, W: W, H: H, TOP: TOP, COLS: COLS, ROWS: ROWS, BW: BW, BH: BH, GX: GX, WALL_TOP: WALL_TOP,
    PAD_Y: PAD_Y, PAD_H: PAD_H, PAD_W: PAD_W, PAD_W_WIDE: PAD_W_WIDE, PAD_W_SHRINK: PAD_W_SHRINK, DEATH_Y: DEATH_Y, BALL_R: BALL_R,
    RATE: RATE, SUB: SUB, RUN_STEPS: RUN_STEPS, SPD0: SPD0, SPD_MAX: SPD_MAX, SHIFT_STEPS: SHIFT_STEPS,
    SERVE_AUTO: SERVE_AUTO, POWER_STEPS: POWER_STEPS, LASER_STEPS: LASER_STEPS, FRENZY_AT: FRENZY_AT, FRENZY_STEPS: FRENZY_STEPS,
    CLEAN_LEFT: CLEAN_LEFT, CAP_W: CAP_W, CAP_H: CAP_H, LIVES: LIVES,
    MAX_SIM_STEPS: MAX_SIM_STEPS, K_NORMAL: K_NORMAL, K_TOUGH: K_TOUGH, K_STEEL: K_STEEL, K_BOMB: K_BOMB,
    K_ROW: K_ROW, K_GEM: K_GEM, PU_WIDE: PU_WIDE, PU_SHRINK: PU_SHRINK, PU_FIRE: PU_FIRE, PU_LASER: PU_LASER,
    shiftSteps: shiftSteps,
    padW: padW, hash: hash, buildWall: buildWall, initSim: initSim, setTarget: setTarget, launch: launch,
    stepSim: stepSim, tick: tick, halfW: halfW, speed: speed, fireOn: fireOn, laserOn: laserOn,
    left: left, rowTop: rowTop, mult: mult,
  };
})();
// BRICK BREAKER RULES END

const { initSim, stepSim, setTarget, launch } = ET;

// An hour of simulation: the session's own lifetime. sessionLifetime.test.js pins it.
const MAX_SIM_STEPS = 60 * 60 * 60;
const MAX_BATCH = 120;
const MAX_INPUTS = MAX_SIM_STEPS + 20000;
const MAX_LAUNCHES = 20000;
const TARGET_MAX = 1 << 20;

function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}
function isTarget(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= -TARGET_MAX && v <= TARGET_MAX;
}
function seedToInt(h) {
  return (typeof h === 'string' && /^[0-9a-fA-F]{8}/.test(h)) ? (parseInt(h.slice(0, 8), 16) >>> 0) : 0;
}

function init({ seed, maxDurationSecs, elapsedSecs, onStep } = {}) {
  return {
    mode: 'none', sim: null, onStep: typeof onStep === 'function' ? onStep : null,
    seed: typeof seed === 'string' ? seed : null,
    inputCount: 0, launchCount: 0, rejectCount: 0, score: 0, dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    stats: { offs: [], waits: [], travel: 0, lastT: 0, lastDir: 0, reversals: 0, samples: 0, paddles: 0, centre: 0 },
  };
}

function mean(xs) { if (!xs.length) return null; let s = 0; for (const x of xs) s += x; return s / xs.length; }
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs); let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}
function round3(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }

function watchStep(state) {
  const st = state.stats;
  for (const e of state.sim.events) {
    if (e.t === 'paddle') { st.paddles++; st.offs.push(Math.abs(e.off)); if (Math.abs(e.off) <= 1) st.centre++; }
  }
}
function stepWatched(state) {
  stepSim(state.sim);
  watchStep(state);
  if (state.onStep) state.onStep(state.sim);
}
function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepWatched(state);
}
function noteTarget(st, v) {
  const d = v - st.lastT;
  if (d !== 0) {
    st.travel += Math.abs(d);
    const dir = d > 0 ? 1 : -1;
    if (st.lastDir !== 0 && dir !== st.lastDir) st.reversals++;
    st.lastDir = dir;
  }
  st.lastT = v;
  st.samples++;
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
      state.sim = initSim(seedToInt(state.seed), 2);
    }
    return { accepted: true, newScore: state.score };
  }
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  const sim = state.sim;

  if (kind === 'launch') {
    const step = payload.step;
    if (!isStep(step)) return reject(state, 'bad_launch');
    if (state.launchCount >= MAX_LAUNCHES) return reject(state, 'input_cap');
    // a launch for a step already run is refused by the frame check below
    advanceTo(state, step - 1);
    if (sim.dead) { state.dead = true; state.score = sim.score; return { accepted: false, newScore: state.score, reason: 'dead' }; }
    if (sim.frames !== step - 1) return reject(state, 'beyond_cap');
    state.launchCount++;
    const waited = sim.serveT;
    if (!launch(sim)) return reject(state, 'no_serve');
    state.stats.waits.push(waited);
    return { accepted: true, newScore: state.score };
  }
  if (kind !== 'path') return { accepted: true, newScore: state.score };

  const { f, x } = payload;
  if (!isStep(f) || !Array.isArray(x) || x.length < 1 || x.length > MAX_BATCH) return reject(state, 'bad_path');
  for (let i = 0; i < x.length; i++) if (!isTarget(x[i])) return reject(state, 'bad_path');
  if (state.inputCount + x.length > MAX_INPUTS) return reject(state, 'input_cap');
  // A batch may never reach back into steps already run. Refused whole.
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
  // Run the world out past the last input: a paddle that stops moving loses
  // its balls, and the clock ends the rest.
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
      mode: 'sim', steps: sim.frames, score: sim.score, wall: sim.wall, bricks: sim.bricks,
      bestCombo: sim.bestCombo, frenzies: sim.frenzies, dead: !!sim.dead,
      inputs: state.inputCount, launches: state.launchCount, rejects: state.rejectCount, samples: st.samples,
      paddles: st.paddles, offMean: round3(mean(st.offs)), offSd: round3(sd(st.offs)),
      centreShare: st.paddles ? round3(st.centre / st.paddles) : null,
      waitMean: round3(mean(st.waits)), waitSd: round3(sd(st.waits)),
      travel: st.travel, reversals: st.reversals,
    },
  };
}

function simulate(seed, inputs) {
  const s = init({ seed });
  processEvent(s, { type: 'input', payload: { kind: 'start', v: 2 } });
  for (const ev of inputs) processEvent(s, ev);
  return finalize(s).score;
}

module.exports = {
  // Pinned to the session lifetime by shared/tests/sessionLifetime.test.js.
  _limits: { MAX_SIM_STEPS, FPS: 60 },
  init, processEvent, finalize, simulate,
  _sim: { ET, initSim, stepSim, setTarget, launch, advanceTo, seedToInt, MAX_SIM_STEPS, MAX_BATCH, MAX_INPUTS, TARGET_MAX },
};
