'use strict';

/**
 * Alien Hamla validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * The game is a vertical shoot-em-up: the player drags, the ship chases the
 * finger, and it FIRES BY ITSELF. So the trace carries exactly one thing, where
 * the finger was on each fixed step, and everything else (every wave, every
 * enemy path, every bullet, every drop, every boss attack) is the simulation's
 * own doing, rebuilt from the session seed.
 *
 * What the server does with a trace:
 *   1. rebuilds the invasion from the seed: wave W, enemy K of a wave, drop N,
 *      swoop N and boss pattern N are pure functions of (seed, index), never of
 *      a running stream;
 *   2. applies each dense positional batch { kind:'path', f, x[], y[] } sample
 *      by sample on the fixed steps it names, and each { kind:'touch'|'lift',
 *      step } marker on its own step;
 *   3. walks the same fixed steps the client walks and counts the score the
 *      kills, the gems, the wave clears and the bosses produce.
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in
 * games/alien-hamla/js/game.js. shared/tests/alienHamlaParity.test.js pulls
 * every constant and every rules function out of both files and fails the
 * moment one copy is edited without the other, and
 * shared/tests/fixtures/alienHamlaGolden.json pins the rules themselves, so a
 * change made in BOTH files still fails. A gameplay change is a trace version
 * bump, never an edit in place.
 *
 * Every position and velocity is an integer in 1/16 design units, so movement
 * is smooth without ever being a value an engine could round differently. There
 * is NO TRIG on this path: entry and swoop arcs are integer quadratic Beziers,
 * every sway is a triangle wave, and an aimed shot normalises with Math.sqrt,
 * which IEEE 754 requires to be correctly rounded in every engine.
 */

// ==== RULES BLOCK: identical in games/alien-hamla/js/game.js ====
//
// A vertical shoot-em-up. The player drags; the ship chases the finger and
// FIRES BY ITSELF. Everything else, including every bullet, is the simulation's
// own doing, so the trace carries one thing: where the finger was, step by step.
//
// All gameplay arithmetic is integer. Positions and velocities are in 1/POS
// design units so movement is smooth without ever being a float that an engine
// could round differently. No trig anywhere: entry and swoop paths are integer
// quadratic Beziers, the formation sways on a triangle wave, and an aimed shot
// normalises with Math.sqrt, which IEEE 754 requires to be correctly rounded.
const DESIGN_W = 414;
const DESIGN_H = 736;
const POS = 16;                       // fixed-point scale for positions
const HUD_H = 66;

// ── the ship ──
const SHIP_MIN_X = 22;
const SHIP_MAX_X = 392;
const SHIP_MIN_Y = 250;
const SHIP_MAX_Y = 694;
const SHIP_START_X = 207;
const SHIP_START_Y = 620;
const SHIP_SPEED = 224;               // 14 design units a step
const SHIP_HIT_R = 7;                 // the core: a shmup hitbox, far smaller than the art
const AIM_LIFT = 74;                  // the ship rides this far above the finger
const AIM_MAX_STEP = 40;              // a finger cannot teleport while it is down
const LIVES = 3;
const RESPAWN_STEPS = 54;
const INVULN_STEPS = 60;
const START_GUARD_STEPS = 27;

// ── the guns ──
const FIRE_EVERY = 7;
const DRONE_FIRE_EVERY = 11;
const DRONE_OFFSET = 34;
const DRONE_MAX = 2;
const WEAPON_MAX = 8;
const PB_R = 5;                       // player bullet radius, for hitting an enemy
// Each level is a list of [muzzle dx, vx, vy] in design units a step.
const WEAPON = [
  [[0, 0, -22]],
  [[-7, 0, -22], [7, 0, -22]],
  [[0, 0, -23], [-10, -3, -21], [10, 3, -21]],
  [[-11, 0, -22], [-4, 0, -23], [4, 0, -23], [11, 0, -22]],
  [[0, 0, -24], [-8, -3, -22], [8, 3, -22], [-15, -6, -20], [15, 6, -20]],
  [[-4, 0, -24], [4, 0, -24], [-10, -3, -22], [10, 3, -22], [-17, -6, -20], [17, 6, -20]],
  [[0, 0, -25], [-5, 0, -24], [5, 0, -24], [-12, -4, -22], [12, 4, -22], [-18, -8, -20], [18, 8, -20]],
  [[-4, 0, -25], [4, 0, -25], [-9, -2, -24], [9, 2, -24], [-15, -5, -22], [15, 5, -22], [-20, -9, -20], [20, 9, -20]],
];

// ── the enemies ──
// type: 0 grunt, 1 shooter, 2 diver, 3 tank, 4 boss
const E_GRUNT = 0;
const E_SHOOTER = 1;
const E_DIVER = 2;
const E_TANK = 3;
const E_BOSS = 4;
const E_SPLIT = 5;                    // breaks into two divers when it dies
const E_HP = [1, 2, 1, 6, 0, 3];
const E_R = [15, 16, 14, 22, 62, 18]; // collision radius in design units
const E_POINTS = [20, 50, 30, 150, 0, 60];
const SPLIT_FROM = 6;                 // the wave a splitter can first appear
const SPLIT_INTO = 2;                 // how many divers come out of one
const GRUNT_FIRE_FROM = 10;           // the wave a grunt starts taking shots
const GRUNT_FIRE_MULT = 2;            // and it fires on this much slower a clock
const ESCORT_FROM = 3;                // a wave carries a second type from here
const E_STRIDE = 9;                   // type, x, y, hp, state, t, slot, seq, phase
const ES_ENTER = 0;
const ES_FORM = 1;
const ES_SWOOP = 2;
const ES_RETURN = 3;
const ES_PASS = 4;
const ES_FALL = 5;                    // a split piece, dropping from where it broke
const FALL_SPEED = 6;
const MAX_ENEMIES = 28;

// ── projectiles and pickups ──
const PB_STRIDE = 5;                  // x, y, vx, vy, dmg
const EB_STRIDE = 4;                  // x, y, vx, vy
const PU_STRIDE = 4;                  // x, y, kind, t
const MAX_PBULLETS = 48;
const MAX_EBULLETS = 64;
const MAX_PICKUPS = 8;
const FIRE_FLOOR = 14;
const FIRE_BASE = 146;
const FIRE_RAMP = 6;
const SWOOP_FLOOR = 16;
const SWOOP_BASE = 120;
const SWOOP_RAMP = 7;
const EB_SPEED = 13;
const EB_SPEED_CAP = 19;
const EB_SPEED_PER = 6;               // +1 unit a step every 6 waves, then it holds
const HP_PER_WAVE = 4;                // every enemy grows a hit point this often
const EB_R = 5;
// ONE volley leaves the field at a time, and the next cannot follow for
// VOLLEY_GAP steps. Enemies still own their own fire clocks, so killing the
// shooters really does thin the fire; what this removes is the PILE-UP, three
// of them coming due on the same step and putting a wall in front of a player
// who did nothing wrong. ENEMY_TELL is the wind-up the client draws, so a shot
// is never the first you hear of it.
const VOLLEY_GAP = 14;
const ENEMY_TELL = 20;
const PU_FALL = 3;
const PU_R = 26;                      // how close the ship must be to take it
const PU_MAGNET = 58;                 // and how close before it starts coming to you
const PU_PULL = 4;
const PU_LIFE = 480;
// pickup kinds
const PU_WEAPON = 0;
const PU_SHIELD = 1;
const PU_DRONE = 2;
const PU_GEM = 3;
const GEM_POINTS = 100;
const DROP_CHANCE = 10;               // percent of kills that drop something
const DROP_TABLE = [PU_GEM, PU_GEM, PU_GEM, PU_WEAPON, PU_WEAPON, PU_WEAPON, PU_SHIELD, PU_DRONE];

// ── the formation ──
const FORM_DX = 48;
const FORM_DY = 46;
const FORM_Y0 = 132;
const FORM_COUNT = 6;
const FORM_BLOCK = 0;
const FORM_VEE = 1;
const FORM_ARROW = 2;
const FORM_COLUMNS = 3;
const FORM_DIAMOND = 4;
const FORM_ECHELON = 5;
const FORM_GUTTER = 34;               // the lane down the middle of COLUMNS
// However a formation is shaped, NO part of it hangs below this line: the
// block never comes down to the player, the player chooses to fly up into it.
const FORM_LOW = FORM_Y0 + 3 * FORM_DY;
const SWAY_AMP = 26;
const SWAY_PERIOD = 300;
const ENTRY_STEPS = 46;
const ENTRY_STAGGER = 5;
const SWOOP_STEPS = 96;
const SWOOP_AIM = 60;                 // a dive bends this much toward the ship, in percent
const RETURN_STEPS = 72;
const PASS_STEPS = 150;
const WAVE_GAP_STEPS = 72;
const WAVE_CLEAR_POINTS = 100;

// ── the boss ──
const BOSS_EVERY = 5;
const BOSS_HP_BASE = 78;
const BOSS_HP_STEP = 50;
const BOSS_ENTER_STEPS = 96;
const BOSS_Y = 190;
const BOSS_SWAY_AMP = 120;
const BOSS_SWAY_PERIOD = 260;
const BOSS_PATTERN_STEPS = 260;
const BOSS_FIRE_FAN = 40;             // steps between fans
const BOSS_FIRE_AIM = 36;             // steps between aimed bursts
const BOSS_FIRE_CALL = 66;            // steps between called-in divers
const BOSS_EB_DROP = 4;               // boss shots are this much slower than a wave's
const BOSS_EB_MIN = 9;
const BOSS_TELL = 16;                 // the wind-up the client draws before a shot
const BOSS_PATTERNS = 4;              // fan, aimed burst, called-in divers, wall
const BOSS_FIRE_WALL = 92;            // steps between walls
const WALL_BULLETS = 9;               // a row across the screen, with one gap
const BOSS_POINTS_BASE = 2000;
const BOSS_POINTS_STEP = 500;

const RULES_VERSION = 3;
const RNG_STRIDE = 0x9E3779B1;
const RNG_SALT_WAVE = 0x3C6EF35F;
const RNG_SALT_ENEMY = 0x6D2B79F5;
const RNG_SALT_DROP = 0x1B873593;
const RNG_SALT_SWOOP = 0x85EBCA6B;
const RNG_SALT_BOSS = 0xC2B2AE35;

const MAX_SIM_STEPS = 60 * 60 * 60;
const PATH_BATCH_MAX = 120;

// One seeded stream per (salt, index): wave N, enemy N of a wave, drop N and
// swoop N are pure functions of (seed, N), never of a running stream, so a
// branch that skips a draw cannot shift the course for anything else.
function specRng(seedInt, salt, index) {
  let a = (((seedInt ^ salt) >>> 0) + Math.imul(index + 1, RNG_STRIDE)) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedToInt(seedHex) {
  return (typeof seedHex === 'string' && seedHex.length >= 8)
    ? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;
}

function clampInt(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// A triangle wave in 0..amp*2 over `period` steps, integer throughout, used for
// every sway. A sine here would be a per-engine approximation.
function triWave(t, period, amp) {
  const half = period >> 1;
  const p = ((t % period) + period) % period;
  return p < half ? Math.floor(p * 2 * amp / half) - amp : amp - Math.floor((p - half) * 2 * amp / half);
}

// Integer smoothstep on 0..4096, and a quadratic Bezier through it. Every
// intermediate stays well inside 2^53, so both are exact in any engine.
function smooth01(u) {
  return Math.floor((3 * u * u * 4096 - 2 * u * u * u) / (4096 * 4096));
}

function bezier(a, c, b, u) {
  const v = 4096 - u;
  return Math.floor((v * v * a + 2 * v * u * c + u * u * b) / (4096 * 4096));
}

// Wave W: what flies in, how it is arranged, and how hard it presses.
// Six draws on every index, whichever branches use them.
function waveSpec(seedInt, w) {
  const rng = specRng(seedInt, RNG_SALT_WAVE, w);
  const kindRoll = rng();
  const colRoll = rng();
  const rowRoll = rng();
  const typeRoll = rng();
  const sideRoll = rng();
  const arcRoll = rng();
  // The escort rolls are ALWAYS taken, on every index, boss waves included, so
  // the stream position never depends on a branch.
  const escortRoll = rng();
  const escortEveryRoll = rng();
  const formRoll = rng();
  if (w % BOSS_EVERY === 0) {
    return { boss: true, cols: 0, rows: 0, type: E_BOSS, count: 1, side: sideRoll < 0.5 ? -1 : 1,
      arc: 0, fireEvery: 0, swoopEvery: 0, escort: E_BOSS, escortEvery: 0, form: FORM_BLOCK };
  }
  const pass = kindRoll < 0.28;
  const cols = 5 + Math.floor(colRoll * 4);
  const rows = pass ? 1 : 2 + Math.floor(rowRoll * Math.min(3, 1 + Math.floor(w / 3)));
  const tier = Math.floor(typeRoll * 100);
  let type = E_GRUNT;
  if (pass) type = E_DIVER;
  else if (w >= SPLIT_FROM && tier < 12) type = E_SPLIT;
  else if (w >= 4 && tier < 26 + Math.min(26, w * 2)) type = E_TANK;
  else if (w >= 1 && tier < 42 + Math.min(40, w * 6)) type = E_SHOOTER;
  // The share is CAPPED so a deep wave is still a mix: about 12 splitters, 40
  // tanks, 30 shooters and 18 grunts in every hundred. A board of nothing but
  // shooters is the saturation that made this game flat the first time.
  // EVERY wave carries something that shoots back: a block of grunts with no
  // escort is a wave the player can ignore, which is what made the pink ones
  // read as broken.
  let escort = type;
  let escortEvery = 0;
  if (!pass && w >= ESCORT_FROM && type !== E_SHOOTER && type !== E_TANK) {
    escort = escortRoll < 0.3 && w >= 4 ? E_TANK : E_SHOOTER;
    escortEvery = 3 + Math.floor(escortEveryRoll * 3);
  }
  // The shape it flies in. A sweep across the screen keeps its line; everything
  // else takes one of the six, and the first wave is always the plain block so
  // a new player meets the game before the game gets clever.
  const form = (pass || w < 2) ? FORM_BLOCK : Math.floor(formRoll * FORM_COUNT);
  let count = pass ? cols + 2 : cols * rows;
  if (form === FORM_DIAMOND) {
    count = 0;
    for (let r = 0; r < rows; r++) count += diamondWidth({ cols: cols, rows: rows }, r);
  }
  // The press ramps with the wave and then holds: a wave 40 board is hard, not
  // impossible, and every number below is an integer.
  const fireEvery = Math.max(FIRE_FLOOR, FIRE_BASE - w * FIRE_RAMP);
  const swoopEvery = pass ? 0 : Math.max(SWOOP_FLOOR, SWOOP_BASE - w * SWOOP_RAMP);
  return { boss: false, cols: cols, rows: rows, type: type, count: Math.min(MAX_ENEMIES, count),
    side: sideRoll < 0.5 ? -1 : 1, arc: Math.floor(arcRoll * 4), fireEvery: fireEvery,
    swoopEvery: swoopEvery, pass: pass, escort: escort, escortEvery: escortEvery,
    form: form };
}
// The type in a given slot: the wave's own, or its escort every escortEvery.
function slotType(spec, slot) {
  if (!spec.escortEvery) return spec.type;
  return (slot % spec.escortEvery === spec.escortEvery - 1) ? spec.escort : spec.type;
}

// Enemy K of a wave: where it flies in from, its sway phase and its fire phase.
// Four draws on every index.
function enemySpec(seedInt, w, k) {
  const rng = specRng(seedInt, RNG_SALT_ENEMY, w * 64 + k);
  const fromRoll = rng();
  const ctrlRoll = rng();
  const phaseRoll = rng();
  const laneRoll = rng();
  return {
    fromX: 40 + Math.floor(fromRoll * (DESIGN_W - 80)),
    ctrlX: 20 + Math.floor(ctrlRoll * (DESIGN_W - 40)),
    phase: Math.floor(phaseRoll * 600),
    lane: Math.floor(laneRoll * 5),
  };
}

// Drop N: what the Nth kill of the run leaves behind. Two draws on every index.
function dropSpec(seedInt, n) {
  const rng = specRng(seedInt, RNG_SALT_DROP, n);
  const hasRoll = rng();
  const kindRoll = rng();
  return {
    has: Math.floor(hasRoll * 100) < DROP_CHANCE,
    kind: DROP_TABLE[Math.floor(kindRoll * DROP_TABLE.length)],
  };
}

// Swoop N: which live formation enemy peels off, and the arc it takes.
// Three draws on every index.
function swoopSpec(seedInt, n) {
  const rng = specRng(seedInt, RNG_SALT_SWOOP, n);
  const pickRoll = rng();
  const ctrlRoll = rng();
  const exitRoll = rng();
  return {
    pick: pickRoll,
    ctrlX: 10 + Math.floor(ctrlRoll * (DESIGN_W - 20)),
    exitX: 40 + Math.floor(exitRoll * (DESIGN_W - 80)),
  };
}

// Boss pattern N: which attack it runs next. Two draws on every index.
// The boss's repertoire WIDENS with every boss beaten: the first has two
// patterns, the second three, the third and later all four. `count` is passed
// in so the roll stays one draw on every index.
function bossPatterns(idx) {
  const n = 1 + idx;
  return n < 2 ? 2 : (n > BOSS_PATTERNS ? BOSS_PATTERNS : n);
}
function bossSpec(seedInt, n, count) {
  const rng = specRng(seedInt, RNG_SALT_BOSS, n);
  const patRoll = rng();
  const offRoll = rng();
  const gapRoll = rng();
  const c = count || 3;
  return { pattern: Math.floor(patRoll * c), offset: Math.floor(offRoll * 40),
    gap: 1 + Math.floor(gapRoll * (WALL_BULLETS - 2)) };
}

// The press never stops climbing, because the run never ends: every enemy
// grows a hit point every HP_PER_WAVE waves and every shot gets faster, both
// integer, both capped where the game would stop being playable.
function waveHp(type, w) {
  return E_HP[type] + Math.floor(w / HP_PER_WAVE);
}

function waveEbSpeed(w) {
  return Math.min(EB_SPEED_CAP, EB_SPEED + Math.floor(w / EB_SPEED_PER));
}

function formOriginX(cols) {
  return Math.floor((DESIGN_W - (cols - 1) * FORM_DX) / 2);
}

// ── the formations ──────────────────────────────────────────────────────
// A wave is not a random scatter: it flies in as a SHAPE, one of these, and
// the shape is what makes a wave recognisable and satisfying to cut down.
// Every one of them is integer arithmetic on the slot index.
//   0 BLOCK    the grid
//   1 VEE      a shallow parabola, point toward the player
//   2 ARROW    the same, inverted, point away
//   3 COLUMNS  two blocks with a lane between them
//   4 DIAMOND  rows of 1, 3, 5, 3, 1
//   5 ECHELON  a staircase down one side
function diamondWidth(spec, row) {
  const mid = Math.floor((spec.rows - 1) / 2);
  const d = row > mid ? row - mid : mid - row;
  const w = spec.cols - d * 2;
  return w < 1 ? 1 : w;
}

function diamondBefore(spec, row) {
  let n = 0;
  for (let r = 0; r < row; r++) n += diamondWidth(spec, r);
  return n;
}

function diamondRow(spec, slot) {
  let n = 0;
  for (let r = 0; r < spec.rows; r++) {
    n += diamondWidth(spec, r);
    if (slot < n) return r;
  }
  return spec.rows - 1;
}

function slotRow(spec, slot) {
  if (spec.form === FORM_DIAMOND) return diamondRow(spec, slot);
  return Math.floor(slot / spec.cols);
}

function slotCol(spec, slot) {
  if (spec.form === FORM_DIAMOND) {
    const row = diamondRow(spec, slot);
    const w = diamondWidth(spec, row);
    const mid = Math.floor((spec.cols - 1) / 2);
    return mid - Math.floor((w - 1) / 2) + (slot - diamondBefore(spec, row));
  }
  return slot % spec.cols;
}

function slotX(spec, slot) {
  const col = slotCol(spec, slot);
  let x = formOriginX(spec.cols) + col * FORM_DX;
  if (spec.form === FORM_COLUMNS) {
    const mid = spec.cols - 1;
    x += 2 * col > mid ? FORM_GUTTER : (2 * col < mid ? -FORM_GUTTER : 0);
  } else if (spec.form === FORM_ECHELON) {
    x += slotRow(spec, slot) * Math.floor(FORM_DX / 2) - FORM_DX;
  }
  return clampInt(x, 26, DESIGN_W - 26);
}

function slotY(spec, slot) {
  let y = FORM_Y0 + slotRow(spec, slot) * FORM_DY;
  if (spec.form === FORM_VEE || spec.form === FORM_ARROW) {
    // an integer parabola across the columns: flat in the middle, deepest at
    // the edges, and the whole shape is one row deep
    const col = slotCol(spec, slot);
    const mid = spec.cols - 1;
    const d = 2 * col - mid;
    const span = mid * mid;
    const drop = span > 0 ? Math.floor(d * d * FORM_DY / span) : 0;
    y += spec.form === FORM_VEE ? -drop : drop;
  }
  return y > FORM_LOW ? FORM_LOW : y;
}

function initSim(seedHex, version) {
  const sim = {
    version: version >= RULES_VERSION ? RULES_VERSION : 2,
    seedInt: seedToInt(seedHex),
    frames: 0,
    phase: 'wave',                    // wave | gap | dying | dead
    phaseT: 0,
    wave: 0,
    waveStart: 0,
    spawned: 0,
    lives: LIVES,
    score: 0,
    lastGain: 0,
    shipX: SHIP_START_X * POS,
    shipY: SHIP_START_Y * POS,
    aimOn: 0,
    aimX: SHIP_START_X,
    aimY: SHIP_START_Y + AIM_LIFT,
    invuln: START_GUARD_STEPS,
    weapon: 1,
    drones: 0,
    shield: 0,
    fireT: 0,
    droneT: 0,
    enemies: [],
    pbullets: [],
    ebullets: [],
    pickups: [],
    bossHp: 0,
    bossMax: 0,
    bossPat: 0,
    bossPatT: 0,
    bossPatSeq: 0,
    bossFireT: 0,
    dropSeq: 0,
    swoopSeq: 0,
    swoopT: 0,
    volleyT: 0,
    kills: 0,
    splits: 0,
    bossKills: 0,
    wavesCleared: 0,
    gems: 0,
    dead: false,
    deathFrame: null,
    deathCause: null,
  };
  startWave(sim);
  return sim;
}

function killSim(sim, cause) {
  sim.dead = true;
  sim.deathFrame = sim.frames;
  sim.deathCause = cause;
  sim.phase = 'dead';
}

function startWave(sim) {
  sim.wave++;
  sim.waveStart = sim.frames;
  sim.spawned = 0;
  sim.swoopT = 0;
  sim.phase = 'wave';
  sim.phaseT = 0;
  const spec = waveSpec(sim.seedInt, sim.wave);
  if (spec.boss) {
    const idx = Math.floor(sim.wave / BOSS_EVERY);
    sim.bossMax = BOSS_HP_BASE + BOSS_HP_STEP * (idx - 1);
    sim.bossHp = sim.bossMax;
    sim.bossPat = 0;
    sim.bossPatT = 0;
    sim.bossFireT = 0;
    sim.enemies = [E_BOSS, Math.floor(DESIGN_W / 2) * POS, -110 * POS, sim.bossMax, ES_ENTER, 0, 0, 0, 0];
    sim.spawned = 1;                  // the boss IS the wave's spawn, or waveDone never fires
  } else {
    sim.bossHp = 0;
    sim.enemies = [];
  }
}

// Enemy K of the wave enters on its own quadratic Bezier and then belongs to a
// formation slot (or, in a pass wave, simply crosses and leaves).
function spawnDue(sim, spec) {
  while (sim.spawned < spec.count
      && sim.frames - sim.waveStart >= sim.spawned * ENTRY_STAGGER) {
    const k = sim.spawned;
    const es = enemySpec(sim.seedInt, sim.wave, k);
    const state = spec.pass ? ES_PASS : ES_ENTER;
    const t = slotType(spec, k);
    const next = sim.enemies.concat([t, es.fromX * POS, -40 * POS,
      waveHp(t, sim.wave), state, 0, k, k, es.phase]);
    sim.enemies = next.length > MAX_ENEMIES * E_STRIDE ? next.slice(0, MAX_ENEMIES * E_STRIDE) : next;
    sim.spawned++;
  }
}

function enemyTargetX(sim, spec, i) {
  const slot = sim.enemies[i + 6];
  return slotX(spec, slot) + triWave(sim.frames, SWAY_PERIOD, SWAY_AMP);
}

function stepEnemies(sim, spec) {
  const next = [];
  for (let i = 0; i < sim.enemies.length; i += E_STRIDE) {
    const type = sim.enemies[i];
    let x = sim.enemies[i + 1];
    let y = sim.enemies[i + 2];
    const hp = sim.enemies[i + 3];
    let state = sim.enemies[i + 4];
    let t = sim.enemies[i + 5] + 1;
    const slot = sim.enemies[i + 6];
    const seq = sim.enemies[i + 7];
    const phase = sim.enemies[i + 8];
    if (type === E_BOSS) {
      if (state === ES_ENTER) {
        const u = Math.min(4096, Math.floor(t * 4096 / BOSS_ENTER_STEPS));
        const e = smooth01(u);
        y = Math.floor((-110 * POS) + ((BOSS_Y * POS) - (-110 * POS)) * e / 4096);
        if (t >= BOSS_ENTER_STEPS) { state = ES_FORM; t = 0; }
      } else {
        x = (Math.floor(DESIGN_W / 2) + triWave(sim.frames, BOSS_SWAY_PERIOD, BOSS_SWAY_AMP)) * POS;
        y = BOSS_Y * POS;
      }
      next.push(type, x, y, hp, state, t, slot, seq, phase);
      continue;
    }
    const es = enemySpec(sim.seedInt, sim.wave, seq);
    if (state === ES_ENTER) {
      const u = Math.min(4096, Math.floor(t * 4096 / ENTRY_STEPS));
      const tx = slotX(spec, slot);
      const ty = slotY(spec, slot);
      x = bezier(es.fromX * POS, es.ctrlX * POS, tx * POS, u);
      y = bezier(-40 * POS, Math.floor((ty + 120) * POS), ty * POS, u);
      if (t >= ENTRY_STEPS) { state = ES_FORM; t = 0; }
    } else if (state === ES_FORM) {
      x = enemyTargetX(sim, spec, i) * POS;
      y = slotY(spec, slot) * POS;
    } else if (state === ES_SWOOP) {
      // A dive BENDS TOWARD THE SHIP, so standing still is never the safe play.
      // The end point is recomputed every step from the ship the sim already
      // has, so it needs no storage and both halves compute the same number.
      const ss = swoopSpec(sim.seedInt, phase);
      const u = Math.min(4096, Math.floor(t * 4096 / SWOOP_STEPS));
      const aimX = clampInt(Math.floor(sim.shipX / POS), 20, DESIGN_W - 20);
      const exX = ss.exitX + Math.floor((aimX - ss.exitX) * SWOOP_AIM / 100);
      x = bezier(slotX(spec, slot) * POS, ss.ctrlX * POS, exX * POS, u);
      y = bezier(slotY(spec, slot) * POS, Math.floor((DESIGN_H / 2) * POS), (DESIGN_H + 60) * POS, u);
      if (t >= SWOOP_STEPS) { state = ES_RETURN; t = 0; }
    } else if (state === ES_RETURN) {
      const ss = swoopSpec(sim.seedInt, phase);
      const u = Math.min(4096, Math.floor(t * 4096 / RETURN_STEPS));
      const tx = slotX(spec, slot);
      const ty = slotY(spec, slot);
      x = bezier(ss.exitX * POS, Math.floor((ss.ctrlX + tx) / 2) * POS, tx * POS, u);
      y = bezier(-50 * POS, Math.floor((ty - 20) * POS), ty * POS, u);
      if (t >= RETURN_STEPS) { state = ES_FORM; t = 0; }
    } else if (state === ES_FALL) {
      // It keeps the x it broke apart at and simply comes down.
      y = y + FALL_SPEED * POS;
      if (y > (DESIGN_H + 60) * POS) continue;
    } else {
      const u = Math.min(4096, Math.floor(t * 4096 / PASS_STEPS));
      const lane = FORM_Y0 + (seq % 3) * 40;
      x = bezier(es.fromX * POS, es.ctrlX * POS, (spec.side > 0 ? DESIGN_W + 50 : -50) * POS, u);
      y = bezier(-40 * POS, lane * POS, (DESIGN_H + 60) * POS, u);
      if (t >= PASS_STEPS) continue;                       // it left the screen
    }
    next.push(type, x, y, hp, state, t, slot, seq, phase);
  }
  sim.enemies = next;
}

// One enemy peels off the formation every spec.swoopEvery steps.
function launchSwoop(sim, spec) {
  if (!spec.swoopEvery) return;
  sim.swoopT++;
  if (sim.swoopT < spec.swoopEvery) return;
  sim.swoopT = 0;
  const live = [];
  for (let i = 0; i < sim.enemies.length; i += E_STRIDE) {
    if (sim.enemies[i + 4] === ES_FORM && sim.enemies[i] !== E_BOSS) live.push(i);
  }
  if (!live.length) return;
  const ss = swoopSpec(sim.seedInt, sim.swoopSeq);
  const i = live[Math.floor(ss.pick * live.length)];
  const next = sim.enemies.slice();
  next[i + 4] = ES_SWOOP;
  next[i + 5] = 0;
  next[i + 8] = sim.swoopSeq;
  sim.enemies = next;
  sim.swoopSeq++;
}

// An aimed shot. Math.sqrt is correctly rounded in every engine, so the
// direction is the same integer pair everywhere.
function aimedBullet(sim, ex, ey, speed) {
  const dx = Math.floor(sim.shipX / POS) - Math.floor(ex / POS);
  const dy = Math.floor(sim.shipY / POS) - Math.floor(ey / POS);
  const len = Math.max(1, Math.round(Math.sqrt(dx * dx + dy * dy)));
  return [Math.floor(dx * speed * POS / len), Math.floor(dy * speed * POS / len)];
}

function addEBullet(sim, list, x, y, vx, vy) {
  if (list.length >= MAX_EBULLETS * EB_STRIDE) return;
  list.push(x, y, vx, vy);
}

// True when this enemy's own clock says it is due to fire in `ahead` steps.
// The client draws its wind-up from the same test, so what the player sees is
// what the rules are about to do.
function enemyDue(sim, spec, i, ahead) {
  const type = sim.enemies[i];
  if (sim.enemies[i + 4] === ES_RETURN) return false;
  if (!spec.fireEvery) return false;
  // Deep in the run even a grunt takes the odd shot, on a much slower clock,
  // so nothing on the board is ever furniture.
  let every = spec.fireEvery;
  if (type === E_GRUNT || type === E_SPLIT) {
    if (sim.wave < GRUNT_FIRE_FROM) return false;
    every = spec.fireEvery * GRUNT_FIRE_MULT;
  } else if (type !== E_SHOOTER && type !== E_TANK) {
    return false;
  }
  return (sim.frames + ahead + sim.enemies[i + 8]) % every === 0;
}
function enemyFire(sim, spec) {
  if (!spec.fireEvery) return;
  if (sim.volleyT > 0) { sim.volleyT--; return; }
  const list = sim.ebullets.slice();
  for (let i = 0; i < sim.enemies.length; i += E_STRIDE) {
    if (!enemyDue(sim, spec, i, 0)) continue;
    const type = sim.enemies[i];
    const x = sim.enemies[i + 1];
    const y = sim.enemies[i + 2] + E_R[type] * POS;
    const v = aimedBullet(sim, x, y, waveEbSpeed(sim.wave));
    addEBullet(sim, list, x, y, v[0], v[1]);
    if (type === E_TANK) {
      addEBullet(sim, list, x, y, v[0] - 2 * POS, v[1]);
      addEBullet(sim, list, x, y, v[0] + 2 * POS, v[1]);
    }
    // ONE volley leaves the field, and the rest of this step's due shooters
    // lose their turn rather than stacking on top of it.
    sim.volleyT = VOLLEY_GAP;
    break;
  }
  sim.ebullets = list;
}

function bossEbSpeed(w) {
  const sp = waveEbSpeed(w) - BOSS_EB_DROP;
  return sp < BOSS_EB_MIN ? BOSS_EB_MIN : sp;
}
function bossFire(sim) {
  let bi = -1;
  for (let i = 0; i < sim.enemies.length; i += E_STRIDE) if (sim.enemies[i] === E_BOSS) bi = i;
  if (bi < 0 || sim.enemies[bi + 4] === ES_ENTER) return;
  sim.bossPatT++;
  if (sim.bossPatT >= BOSS_PATTERN_STEPS) {
    sim.bossPatT = 0;
    sim.bossPatSeq++;
    sim.bossPat = bossSpec(sim.seedInt, sim.bossPatSeq,
      bossPatterns(Math.floor(sim.wave / BOSS_EVERY))).pattern;
    sim.bossFireT = 0;
  }
  sim.bossFireT++;
  const x = sim.enemies[bi + 1];
  const y = sim.enemies[bi + 2] + 40 * POS;
  const list = sim.ebullets.slice();
  if (sim.bossPat === 0) {
    // A fan that OPENS: every bullet leaves on its own angle, so a step
    // sideways is always a way out of it.
    if (sim.bossFireT % BOSS_FIRE_FAN === 0) {
      const sp = bossEbSpeed(sim.wave);
      for (let k = -3; k <= 3; k++) {
        addEBullet(sim, list, x, y, k * 4 * POS, sp * POS);
      }
    }
  } else if (sim.bossPat === 1) {
    // An aimed burst, and the two flankers ANGLE AWAY from the aimed one, so
    // the three of them are a V with a gap rather than a wall 52 wide.
    if (sim.bossFireT % BOSS_FIRE_AIM === 0) {
      const v = aimedBullet(sim, x, y, bossEbSpeed(sim.wave));
      addEBullet(sim, list, x, y, v[0], v[1]);
      addEBullet(sim, list, x, y, v[0] - 4 * POS, v[1]);
      addEBullet(sim, list, x, y, v[0] + 4 * POS, v[1]);
    }
  } else if (sim.bossPat === 3) {
    // A WALL across the screen with exactly one gap: it says, plainly, go
    // there. Slower than the rest, because crossing to the gap takes time.
    if (sim.bossFireT % BOSS_FIRE_WALL === 0) {
      const bs = bossSpec(sim.seedInt, sim.bossPatSeq, BOSS_PATTERNS);
      const sp = bossEbSpeed(sim.wave) - 2;
      const step = Math.floor(DESIGN_W / WALL_BULLETS);
      for (let k = 0; k < WALL_BULLETS; k++) {
        if (k === bs.gap) continue;
        addEBullet(sim, list, (step / 2 + k * step) * POS, (BOSS_Y + 40) * POS, 0,
          (sp < BOSS_EB_MIN ? BOSS_EB_MIN : sp) * POS);
      }
    }
  } else if (sim.bossFireT % BOSS_FIRE_CALL === 0) {
    // it calls in help
    if (sim.enemies.length < MAX_ENEMIES * E_STRIDE - E_STRIDE * 2) {
      const es = enemySpec(sim.seedInt, sim.wave, sim.bossPatSeq * 4 + (sim.bossFireT % 7));
      const spawn = sim.enemies.concat([E_DIVER, x, y, waveHp(E_DIVER, sim.wave), ES_PASS, 0, 0,
        sim.spawned, es.phase]);
      sim.enemies = spawn;
      sim.spawned++;
    }
  }
  sim.ebullets = list;
}

function firePlayer(sim) {
  if (sim.phase === 'dying') return;
  sim.fireT++;
  const list = sim.pbullets.slice();
  if (sim.fireT >= FIRE_EVERY) {
    sim.fireT = 0;
    const pattern = WEAPON[clampInt(sim.weapon, 1, WEAPON_MAX) - 1];
    for (let i = 0; i < pattern.length; i++) {
      if (list.length >= MAX_PBULLETS * PB_STRIDE) break;
      list.push(sim.shipX + pattern[i][0] * POS, sim.shipY - 16 * POS,
        pattern[i][1] * POS, pattern[i][2] * POS, 1);
    }
  }
  if (sim.drones > 0) {
    sim.droneT++;
    if (sim.droneT >= DRONE_FIRE_EVERY) {
      sim.droneT = 0;
      for (let d = 0; d < sim.drones; d++) {
        if (list.length >= MAX_PBULLETS * PB_STRIDE) break;
        const off = (d === 0 ? -DRONE_OFFSET : DRONE_OFFSET) * POS;
        list.push(sim.shipX + off, sim.shipY - 4 * POS, 0, -20 * POS, 1);
      }
    }
  }
  sim.pbullets = list;
}

function hitEnemy(sim, i, dmg) {
  const type = sim.enemies[i];
  const next = sim.enemies.slice();
  next[i + 3] = next[i + 3] - dmg;
  if (type === E_BOSS) sim.bossHp = next[i + 3];
  if (next[i + 3] > 0) {
    sim.enemies = next;
    return false;
  }
  if (type === E_BOSS) {
    const idx = Math.floor(sim.wave / BOSS_EVERY);
    const gain = BOSS_POINTS_BASE + BOSS_POINTS_STEP * (idx - 1);
    sim.score += gain;
    sim.lastGain = gain;
    sim.bossKills++;
    sim.bossHp = 0;
  } else {
    sim.score += E_POINTS[type];
    sim.lastGain = E_POINTS[type];
  }
  sim.kills++;
  const drop = dropSpec(sim.seedInt, sim.dropSeq);
  sim.dropSeq++;
  if ((drop.has || type === E_BOSS || type === E_TANK)
      && sim.pickups.length < MAX_PICKUPS * PU_STRIDE) {
    const kind = type === E_BOSS ? PU_WEAPON : drop.kind;
    sim.pickups = sim.pickups.concat([next[i + 1], next[i + 2], kind, 0]);
  }
  let rest = next.slice(0, i).concat(next.slice(i + E_STRIDE));
  // A SPLITTER does not simply die: it comes apart into pieces that keep
  // coming down from where it broke.
  if (type === E_SPLIT) {
    for (let k = 0; k < SPLIT_INTO; k++) {
      if (rest.length >= MAX_ENEMIES * E_STRIDE) break;
      rest = rest.concat([E_DIVER, next[i + 1] + (k * 2 - 1) * 15 * POS, next[i + 2],
        waveHp(E_DIVER, sim.wave), ES_FALL, 0, next[i + 6], next[i + 7], next[i + 8]]);
    }
    sim.splits++;
  }
  sim.enemies = rest;
  return true;
}

function stepPBullets(sim) {
  const next = [];
  for (let i = 0; i < sim.pbullets.length; i += PB_STRIDE) {
    const x = sim.pbullets[i] + sim.pbullets[i + 2];
    const y = sim.pbullets[i + 1] + sim.pbullets[i + 3];
    if (y < (HUD_H - 20) * POS || x < -20 * POS || x > (DESIGN_W + 20) * POS) continue;
    const dmg = sim.pbullets[i + 4];
    let hit = -1;
    for (let e = 0; e < sim.enemies.length; e += E_STRIDE) {
      const r = (E_R[sim.enemies[e]] + PB_R) * POS;
      const dx = sim.enemies[e + 1] - x;
      const dy = sim.enemies[e + 2] - y;
      if (dx * dx + dy * dy <= r * r) { hit = e; break; }
    }
    if (hit >= 0) { hitEnemy(sim, hit, dmg); continue; }
    next.push(x, y, sim.pbullets[i + 2], sim.pbullets[i + 3], dmg);
  }
  sim.pbullets = next;
}

function loseShip(sim) {
  if (sim.shield > 0) {
    sim.shield--;
    sim.invuln = INVULN_STEPS;
    return;
  }
  sim.lives--;
  sim.phase = 'dying';
  sim.phaseT = 0;
  sim.ebullets = [];
}

function stepEBullets(sim) {
  const next = [];
  const live = sim.phase === 'wave' && sim.invuln === 0;
  for (let i = 0; i < sim.ebullets.length; i += EB_STRIDE) {
    const x = sim.ebullets[i] + sim.ebullets[i + 2];
    const y = sim.ebullets[i + 1] + sim.ebullets[i + 3];
    if (y > (DESIGN_H + 30) * POS || y < -30 * POS || x < -30 * POS || x > (DESIGN_W + 30) * POS) continue;
    if (live) {
      const dx = Math.floor((x - sim.shipX) / POS);
      const dy = Math.floor((y - sim.shipY) / POS);
      const r = SHIP_HIT_R + EB_R;
      if (dx * dx + dy * dy <= r * r) { loseShip(sim); return; }
    }
    next.push(x, y, sim.ebullets[i + 2], sim.ebullets[i + 3]);
  }
  sim.ebullets = next;
}

function shipVsEnemies(sim) {
  if (sim.phase !== 'wave' || sim.invuln > 0) return;
  for (let e = 0; e < sim.enemies.length; e += E_STRIDE) {
    const r = E_R[sim.enemies[e]] + SHIP_HIT_R;
    const dx = Math.floor((sim.enemies[e + 1] - sim.shipX) / POS);
    const dy = Math.floor((sim.enemies[e + 2] - sim.shipY) / POS);
    if (dx * dx + dy * dy <= r * r) { loseShip(sim); return; }
  }
}

function stepPickups(sim) {
  const next = [];
  const live = sim.phase === 'wave' || sim.phase === 'gap';
  for (let i = 0; i < sim.pickups.length; i += PU_STRIDE) {
    let x = sim.pickups[i];
    let y = sim.pickups[i + 1] + PU_FALL * POS;
    const kind = sim.pickups[i + 2];
    const t = sim.pickups[i + 3] + 1;
    if (y > (DESIGN_H + 30) * POS || t > PU_LIFE) continue;
    // Come close and it comes to YOU. A power-up that falls past a ship which
    // was clearly reaching for it is the most annoying thing this game can do.
    if (live) {
      const mx = sim.shipX - x;
      const my = sim.shipY - y;
      const adx = mx < 0 ? -mx : mx;
      const ady = my < 0 ? -my : my;
      if (adx <= PU_MAGNET * POS && ady <= PU_MAGNET * POS) {
        const step = PU_PULL * POS;
        x += mx > step ? step : (mx < -step ? -step : mx);
        y += my > step ? step : (my < -step ? -step : my);
      }
    }
    if (live) {
      const dx = Math.floor((x - sim.shipX) / POS);
      const dy = Math.floor((y - sim.shipY) / POS);
      if (dx * dx + dy * dy <= PU_R * PU_R) {
        if (kind === PU_WEAPON) sim.weapon = Math.min(WEAPON_MAX, sim.weapon + 1);
        else if (kind === PU_SHIELD) sim.shield = Math.min(3, sim.shield + 1);
        else if (kind === PU_DRONE) sim.drones = Math.min(DRONE_MAX, sim.drones + 1);
        else { sim.score += GEM_POINTS; sim.lastGain = GEM_POINTS; sim.gems++; }
        continue;
      }
    }
    next.push(x, y, kind, t);
  }
  sim.pickups = next;
}

function waveDone(sim, spec) {
  if (sim.spawned < spec.count) return false;
  return sim.enemies.length === 0;
}

function stepSim(sim) {
  if (sim.dead) return;
  sim.frames++;
  if (sim.phase === 'dying') {
    sim.phaseT++;
    if (sim.phaseT >= RESPAWN_STEPS) {
      if (sim.lives <= 0) { killSim(sim, 'shot'); return; }
      sim.shipX = SHIP_START_X * POS;
      sim.shipY = SHIP_START_Y * POS;
      sim.aimOn = 0;
      sim.invuln = INVULN_STEPS;
      sim.phase = 'wave';
      sim.phaseT = 0;
    }
    return;
  }
  if (sim.invuln > 0) sim.invuln--;

  // 1. the ship chases the finger
  if (sim.aimOn) {
    const tx = clampInt(sim.aimX, SHIP_MIN_X, SHIP_MAX_X) * POS;
    const ty = clampInt(sim.aimY - AIM_LIFT, SHIP_MIN_Y, SHIP_MAX_Y) * POS;
    const dx = tx - sim.shipX;
    const dy = ty - sim.shipY;
    sim.shipX += dx > SHIP_SPEED ? SHIP_SPEED : (dx < -SHIP_SPEED ? -SHIP_SPEED : dx);
    sim.shipY += dy > SHIP_SPEED ? SHIP_SPEED : (dy < -SHIP_SPEED ? -SHIP_SPEED : dy);
  }
  // 2. the guns
  firePlayer(sim);
  // Between waves the world DOES NOT STOP: the ship still flies, the guns
  // still fire and a pickup the last kill dropped can still be caught. Only
  // the next wave waits, for WAVE_GAP_STEPS.
  if (sim.phase === 'gap') {
    sim.phaseT++;
    if (sim.phaseT >= WAVE_GAP_STEPS) startWave(sim);
    stepPBullets(sim);
    stepEBullets(sim);
    stepPickups(sim);
    return;
  }
  // 3. the wave
  const spec = waveSpec(sim.seedInt, sim.wave);
  if (spec.boss) bossFire(sim);
  else { spawnDue(sim, spec); launchSwoop(sim, spec); enemyFire(sim, spec); }
  stepEnemies(sim, spec);
  // 4. projectiles and pickups
  stepPBullets(sim);
  stepEBullets(sim);
  if (sim.phase !== 'wave') return;
  shipVsEnemies(sim);
  if (sim.phase !== 'wave') return;
  stepPickups(sim);
  // 5. the wave ends
  if (waveDone(sim, spec)) {
    const gain = WAVE_CLEAR_POINTS * sim.wave;
    sim.score += gain;
    sim.lastGain = gain;
    sim.wavesCleared++;
    sim.phase = 'gap';
    sim.phaseT = 0;
    sim.ebullets = [];
  }
}

// The finger, sample by sample. `snap` is true only for the first sample after
// a touch: a finger that has just landed may be anywhere, but one already down
// cannot travel more than AIM_MAX_STEP in a step.
function aimSim(sim, x, y, snap) {
  if (sim.dead) return false;
  if (sim.frames < START_GUARD_STEPS) return false;
  if (!snap && sim.aimOn) {
    const dx = x - sim.aimX;
    const dy = y - sim.aimY;
    if (dx > AIM_MAX_STEP || dx < -AIM_MAX_STEP || dy > AIM_MAX_STEP || dy < -AIM_MAX_STEP) return false;
  }
  sim.aimOn = 1;
  sim.aimX = clampInt(x, 0, DESIGN_W);
  sim.aimY = clampInt(y, 0, DESIGN_H);
  return true;
}

function liftSim(sim) {
  if (sim.dead) return false;
  sim.aimOn = 0;
  return true;
}
// ==== END RULES BLOCK ====

// ── server-only bounds ──────────────────────────────────────────────────
//
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
// shared/tests/sessionLifetime.test.js pins it.
//
// A dragging finger emits one sample a step, so an hour of continuous drag is
// 216,000 samples. MAX_INPUTS is set above that: the bound is on WORK, and it
// REFUSES further input rather than zeroing a run.
const MAX_INPUTS = 260000;

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.frames < step && sim.frames < MAX_SIM_STEPS) stepSim(sim);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing would
// apply a malformed step as if it were real.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function isCoord(v, hi) {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= 0 && v <= hi;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    down: false,
    snapNext: false,
    lastStep: -1,
    inputCount: 0,
    rejectCount: 0,
    score: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
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
  if (state.dead) return { accepted: false, newScore: state.score, reason: 'dead' };
  if (!event || typeof event !== 'object' || event.type !== 'input') {
    return { accepted: true, newScore: state.score };
  }
  const payload = event.payload || {};
  const kind = payload.kind;

  if (kind === 'start') {
    if (Number(payload.v) >= 3 && state.mode !== 'sim') {
      state.mode = 'sim';
      state.sim = initSim(state.seed, Number(payload.v));
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  if (kind === 'touch' || kind === 'lift') return processMarker(state, kind, payload);
  if (kind === 'path') return processPath(state, payload);
  return { accepted: true, newScore: state.score };
}

// { kind: 'touch' | 'lift', step }: the finger went down (or came up) on that
// fixed step. A touch may land anywhere; what follows it may not teleport.
function processMarker(state, kind, payload) {
  const step = payload.step;
  if (!isStep(step)) return reject(state, 'bad_marker');
  if (step < state.lastStep) return reject(state, 'frame_regressed');
  const wantDown = kind === 'touch';
  if (state.down === wantDown) return reject(state, 'bad_marker');
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  advanceTo(state, step);
  if (state.sim.dead) return deadResult(state);
  state.down = wantDown;
  state.snapNext = wantDown;
  if (!wantDown) liftSim(state.sim);
  state.lastStep = step;
  state.score = state.sim.score;
  return { accepted: true, newScore: state.score };
}

// { kind: 'path', f, x: [...], y: [...] }: x[i], y[i] is where the finger
// pointed during step f+1+i. POSITIONAL and dense, applied WHOLE or not at all:
// a batch that stopped half way would leave the replay in a state the game
// never had, and would leave the step cursor behind samples already consumed.
function processPath(state, payload) {
  const f = payload.f;
  const xs = payload.x;
  const ys = payload.y;
  if (!isStep(f) || !Array.isArray(xs) || !Array.isArray(ys) || xs.length === 0
      || xs.length !== ys.length || xs.length > PATH_BATCH_MAX) {
    return reject(state, 'bad_batch');
  }
  // A later batch must start at or after the last step already addressed, so
  // batches never overlap and never rewind: a rewind would let an attacker
  // re-run the same window and keep the best outcome.
  if (f < state.lastStep) return reject(state, 'frame_regressed');
  if (!state.down) return reject(state, 'not_touching');
  if (state.inputCount + xs.length > MAX_INPUTS) return reject(state, 'input_cap');

  // VALIDATE THE WHOLE BATCH BEFORE APPLYING ANY OF IT.
  const sim = state.sim;
  let px = sim.aimX;
  let py = sim.aimY;
  let snap = state.snapNext;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!isCoord(x, DESIGN_W) || !isCoord(y, DESIGN_H)) return reject(state, 'bad_sample');
    if (!snap) {
      const dx = x - px;
      const dy = y - py;
      if (dx > AIM_MAX_STEP || dx < -AIM_MAX_STEP || dy > AIM_MAX_STEP || dy < -AIM_MAX_STEP) {
        return reject(state, 'teleport');
      }
    }
    snap = false;
    px = x;
    py = y;
  }

  state.inputCount += xs.length;
  state.lastStep = f + xs.length;
  for (let i = 0; i < xs.length; i++) {
    advanceTo(state, f + i);
    if (sim.dead) break;
    aimSim(sim, xs[i], ys[i], state.snapNext && i === 0);
    stepSim(sim);
  }
  state.snapNext = false;
  if (sim.dead) return deadResult(state);
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
  // Run the world out past the last input. A run that stopped emitting settles
  // here: with the finger lifted the ship holds still and the waves keep
  // coming, so it always ends.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.frames < capSteps && sim.frames < MAX_SIM_STEPS) {
    stepSim(sim);
    guard++;
  }
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', frames: sim.frames, deathFrame: sim.deathFrame, deathCause: sim.deathCause,
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      wave: sim.wave, lives: sim.lives, kills: sim.kills, bossKills: sim.bossKills,
      gems: sim.gems, weapon: sim.weapon, drones: sim.drones, wavesCleared: sim.wavesCleared,
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
    initSim, stepSim, aimSim, liftSim, advanceTo, killSim, startWave, spawnDue, stepEnemies,
    launchSwoop, aimedBullet, addEBullet, enemyFire, bossFire, firePlayer, hitEnemy,
    stepPBullets, loseShip, stepEBullets, shipVsEnemies, stepPickups, waveDone,
    specRng, seedToInt, clampInt, triWave, smooth01, bezier, waveSpec, enemySpec, dropSpec,
    swoopSpec, bossSpec, formOriginX, slotX, slotY, enemyTargetX, waveHp, waveEbSpeed,
    MAX_INPUTS, MAX_SIM_STEPS,
    DESIGN_W, DESIGN_H, POS, HUD_H, SHIP_MIN_X, SHIP_MAX_X, SHIP_MIN_Y, SHIP_MAX_Y,
    SHIP_START_X, SHIP_START_Y, SHIP_SPEED, SHIP_HIT_R, AIM_LIFT, AIM_MAX_STEP, LIVES,
    RESPAWN_STEPS, INVULN_STEPS, START_GUARD_STEPS, FIRE_EVERY, DRONE_FIRE_EVERY, DRONE_OFFSET,
    DRONE_MAX, WEAPON_MAX, PB_R, WEAPON, E_GRUNT, E_SHOOTER, E_DIVER, E_TANK, E_BOSS,
    E_HP, E_R, E_POINTS, E_STRIDE, ES_ENTER, ES_FORM, ES_FALL, FALL_SPEED, E_SPLIT, SPLIT_FROM, SPLIT_INTO,
    GRUNT_FIRE_FROM, GRUNT_FIRE_MULT, ESCORT_FROM, slotType, ES_SWOOP, ES_RETURN, ES_PASS,
    MAX_ENEMIES, PB_STRIDE, EB_STRIDE, PU_STRIDE, MAX_PBULLETS, MAX_EBULLETS, MAX_PICKUPS,
    FIRE_FLOOR, FIRE_BASE, FIRE_RAMP, SWOOP_FLOOR, SWOOP_BASE, SWOOP_RAMP,
    EB_SPEED, EB_SPEED_CAP, VOLLEY_GAP, ENEMY_TELL, enemyDue, EB_SPEED_PER, HP_PER_WAVE, EB_R, PU_FALL, PU_R, PU_MAGNET, PU_PULL, PU_LIFE, PU_WEAPON, PU_SHIELD, PU_DRONE, PU_GEM,
    GEM_POINTS, DROP_CHANCE, DROP_TABLE, FORM_DX, FORM_DY, FORM_Y0, FORM_COUNT, FORM_BLOCK, FORM_VEE, FORM_ARROW,
    FORM_COLUMNS, FORM_DIAMOND, FORM_ECHELON, FORM_GUTTER, FORM_LOW, slotRow, slotCol,
    diamondWidth, diamondBefore, diamondRow, SWAY_AMP, SWAY_PERIOD,
    ENTRY_STEPS, ENTRY_STAGGER, SWOOP_STEPS, SWOOP_AIM, RETURN_STEPS, PASS_STEPS, WAVE_GAP_STEPS,
    WAVE_CLEAR_POINTS, BOSS_EVERY, BOSS_HP_BASE, BOSS_HP_STEP, BOSS_ENTER_STEPS, BOSS_Y,
    BOSS_SWAY_AMP, BOSS_SWAY_PERIOD, BOSS_PATTERN_STEPS, BOSS_FIRE_FAN, BOSS_FIRE_AIM, BOSS_FIRE_CALL, BOSS_EB_DROP,
    BOSS_EB_MIN, BOSS_TELL, BOSS_PATTERNS, BOSS_FIRE_WALL, WALL_BULLETS, bossEbSpeed, bossPatterns, BOSS_POINTS_BASE, BOSS_POINTS_STEP,
    RULES_VERSION, RNG_STRIDE, RNG_SALT_WAVE, RNG_SALT_ENEMY, RNG_SALT_DROP, RNG_SALT_SWOOP,
    RNG_SALT_BOSS, PATH_BATCH_MAX,
  },
};
