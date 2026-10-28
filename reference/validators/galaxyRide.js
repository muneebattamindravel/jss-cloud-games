'use strict';

/**
 * Galaxy Ride validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Galaxy Ride is a partner's game (a hover ship on a road in the sky: drag to
 * steer across seven lanes, tap a second finger to jump, avoid holes, blocks,
 * closed tunnels, sliding blocks and fire). It arrived with an independent
 * server transcription of its rules; on integration the rules were made ONE
 * block, carried WORD FOR WORD here and in games/galaxy-ride/js/core.js, so the
 * two cannot drift. shared/tests/galaxyRideParity.test.js pulls the block out of
 * both files and fails on any difference, and golden runs pin the rules so a
 * change made in BOTH files cannot pass either. A gameplay change is a trace
 * version bump, never an edit in place.
 *
 * Steps are 1/120 s (the partner's feel; the platform norm is 1/60). Every
 * rule counts in steps, so the frame rate never reaches a score.
 *
 * Trace v5 (and v4, v3 and v2, each replayed on its own rules and patch table;
 * there is no v1 path):
 *   { kind: 'start', v: 5 }        v5: top speed 14.4 (10% lower), the patch table drops
 *        FIRE CHECKER, FIRE STONES and FIRE THREAD, and contact is resolved at first touch
 *        (no more ending up inside an obstacle before the crash).
 *   { kind: 'start', v: 4 }        v4: a jump covers the same rows at every
 *        speed (airtime inversely proportional to speed, apex unchanged),
 *        rows that must be jumped over never stretch, and the patch table
 *        drops GRAND FINALE and fills the holes in NEEDLE TUBES and SLIDER
 *        HOPS.
 *   { kind: 'start', v: 3 }        v3: above JUMP_REF a jump runs faster in
 *        time, so the rows covered in the air stop growing with speed, and
 *        holes stop stretching at the same speed. A v2 marker replays on the
 *        v2 rules (the rules block reads the version), so a run in progress
 *        at deploy scores as it was played.
 *   { kind: 'path', f, x: [q, ...] }  the steering target during step f+1+i,
 *        q = road x * 64, an integer in [-250, 250]. POSITIONAL and dense,
 *        applied whole or refused whole, at most PATH_BATCH_MAX long.
 *   { kind: 'jump', step }            a jump press applied on that step.
 * Steps never go backwards; a second input of the same kind on one step
 * changes nothing.
 *
 * Score = floor(distance in rows), computed in one place (sim.score()). The
 * client's own number is never read; `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * Arithmetic: only +, -, x, /, Math.sqrt, floor, round, ceil, min, max and
 * abs (IEEE 754 exact in every engine) plus integer bit operations. No
 * transcendental, so no DMath is needed; the parity suite asserts it.
 */

// ==== RULES BLOCK: identical in games/galaxy-ride/js/core.js ====
function galaxyRideCore() {
  'use strict';

  /* ---------- constants (tile units) ---------- */
  const W = 7, C = 3;
  const STEP = 1 / 120;
  const ROW_LEN = 2.4;
  const G = 44, JUMP_V = 9.15;                 // apex ~0.95 tiles, airtime ~0.42 s
  // v3: above this speed a jump runs faster in time (launch x k, gravity x k*k, k = speed / JUMP_REF),
  // so the apex is unchanged and the rows covered in the air stop growing: a top-speed jump
  // lands where a JUMP_REF jump does. Holes stop stretching at the same speed.
  const JUMP_REF = 12;
  // v4: the jump covers the SAME rows at every speed: launch x k, gravity x k*k with k = speed / JUMP_ROWS_REF
  // (speeds below SPEED0 count as SPEED0), so the apex never changes and the airtime is JUMP_ROWS_REF / speed
  // times the reference airtime: about 4.16 rows on flat road at 8 and at 16. Rows that must be jumped over no
  // longer stretch at all (see rowCount), and the patch table is its own (see PATCHES_V4).
  const JUMP_ROWS_REF = 10;
  // v5: top speed is 10% lower (SPEED_MAX_V5), the patch table drops FIRE CHECKER, FIRE STONES and FIRE THREAD, and
  // contact is resolved at first touch: a falling ship that meets a lip, a ship sliding sideways into a moving block and
  // a descent into a block all crash at the moment of contact instead of a step or a slice later, inside the obstacle.
  const SPEED_MAX_V5 = 14.4;
  const RULES_VERSION = 5;                     // v4, v3 and v2 traces replay on their own rules and their own patch table
  const BOUNCE = 0.4, BOUNCE_MIN = 3.5;
  const SPEED0 = 8, SPEED_MAX = 16, SPEED_INC = 0.5, SPEED_EVERY = 53;
  const START_CRAWL = 0.4, START_RAMP_STEPS = 360;   // rolls off at a crawl, reaches pace after 3 s
  const PACE_EASE = 1.5;                       // rows/s² when easing up to each speed step
  const FLOOR_T = 0.18, BLOCK_H = 0.75;
  const TUBE_OUT = 0.5, TUBE_H = 0.6, TUBE_IN = 0.45, TUBE_IN_H = 0.5;
  const SHIP_HW = 0.3, SHIP_H = 0.24, SHIP_CORE = 0.2;
  const NOSE = 0.3 / ROW_LEN, TAIL = 0.25 / ROW_LEN, FOOT = 0.2 / ROW_LEN;
  const STEP_UP = 0.22, LAND_TOL = 0.05, BURN_SINK = 0.14;
  const SUPPORT_MIN = 0.1;                     // stays up while ≥10% of the ship is over a tile
  const BURN_MIN = 0.5;                        // burns when ≥50% of the ship is over fire
  const JUMP_BUF_STEPS = 36;                   // a jump pressed up to 0.3 s early still fires
  const COYOTE_STEPS = 14;                     // 0.12 s grace to jump after leaving an edge
  const LAT_MAX = 60, LAT_SUB = 0.1, X_LIMIT = 3.9;
  // steering feel: share of the remaining gap to the finger closed each step. 1 = instant; 0.3 ≈ 90% there in 55 ms.
  // Carried word for word in shared/anticheat/validators/galaxyRide.js.
  const STEER_EASE = 0.3, STEER_SNAP = 0.004;   // steering is 1:1: the ship sits exactly on the target (swept in 0.1 slices so walls still stop it)
  const X_QUANT = 64;                          // steering inputs are multiples of 1/64 tile
  const FALL_DEAD = -3.5, TERMINAL_VY = -24;
  const GEN_AHEAD = 74;                        // rows generated ahead of the ship
  const KEEP_BEHIND = 6;                       // rows kept behind the ship
  const SKY_EVERY = 5;
  const MOVER_PERIOD = 300;                    // a sliding block sweeps its lanes and back every 2.5 s
  const MOVER_PHASE = 40;                      // steps of phase shift per row index                         // patches per sky (cosmetic slot number only)

  const K = { EMPTY: 0, FLOOR: 1, SIDE: 2, ALT: 3, BLOCK: 4, BLOCK2: 5, TUNNEL: 6, BURN: 7, BOOST: 8, CAP: 9, DECK2: 10, DECK3: 11 };
  const CH = { '.': K.EMPTY, '=': K.FLOOR, '-': K.SIDE, '~': K.ALT, '#': K.BLOCK, '%': K.BLOCK2, 'T': K.TUNNEL, '*': K.BURN, '>': K.BOOST, 'U': K.CAP, 'M': K.FLOOR, '2': K.DECK2, '3': K.DECK3 };   // M: road under a sliding block

  /* =====================================================================
     PATCHES: hand-designed road sections, 7 columns wide (col 3 = centre).
       .  hole   =  road   -  side road   ~  crossing bar   #  block
       %  wall   T  tube tunnel   U  closed tube   *  fire pit
       M  road under a sliding block that sweeps the M lanes and back
       2  deck twice block height   3  deck three times block height
     'A|B' picks one variant (from the seed) each time the patch is built.
     Row count: a number is exact; 'sN' is N rows at starting speed and
     stretches with speed so reaction time stays the same.
     tier: easy / medium / hard, mixed by the difficulty schedule below.
     ===================================================================== */
  const PATCHES = [
    { name: 'GATEWAY', tier: 'easy', theme: 0, rows: [
      ['.=====.', 's4'], ['-.===.-', 's3'], ['#.===.#', 2], ['-.=.=.-', 's3'], ['-.===.-', 's3'], ['*******', 1],
      ['-.===.-', 's3'], ['-.#=#.-', 's3'], ['-.===.-', 's3'], ['#.===.#', 2], ['-.===.-', 's2'], ['.......', 1],
      ['-.===.-', 's7'], ['-.=.=.-', 's3'], ['-.===.-', 's3'], ['*******', 1], ['-.===.-', 's3'], ['#.===.#', 2], ['..===..', 's3']] },
    { name: 'TUBE TO SPINE', tier: 'medium', theme: 6, rows: [
      ['.=====.', 's4'], ['.-===-.', 's3'], ['..===..', 's3'], ['..%T%..', 4], ['...=...', 's5'],
      ['.......', 1], ['...=...', 's7'], ['..===..', 's2'], ['.=====.', 's3'], ['.T.U.U.', 3],
      ['.=====.', 's4'], ['.==.==.', 's4'], ['.=====.', 's3'], ['..=T=..', 3], ['..===..', 's3']] },
    { name: 'FIRE LANES', tier: 'easy', theme: 10, rows: [
      ['.=====.', 's4'], ['.*===*.', 's4'], ['.**=**.', 's4'], ['.*===*.', 's3'], ['.=====.', 's3'],
      ['.==.==.', 's4'], ['.=====.', 's3'], ['.=*=*=.', 's4'], ['.=====.', 's3'], ['.......', 1],
      ['.=====.', 's8'], ['.=***=.', 's4'], ['.=====.', 's3'], ['..===..', 's2']] },
    { name: 'STEPPING STONES', tier: 'medium', theme: 1, rows: [        // separate platforms: jump, jump, jump
      ['..===..', 's3'], ['.......', 2], ['..===..', 's2'], ['.......', 2], ['.===...', 's2'], ['.......', 2], ['...===.', 's2'],
      ['.......', 2], ['..===..', 's2'], ['.......', 2], ['.===...', 's2'], ['.......', 2], ['..===..', 's2'], ['.......', 2], ['..===..', 's3']] },
    { name: 'BLOCK SLALOM', tier: 'medium', theme: 2, rows: [
      ['.=====.', 's4'], ['.#===#.', 's3'], ['.=====.', 's2'], ['.==#==.', 's3'], ['.=====.', 's2'],
      ['.#=.=#.', 's3'], ['.=====.', 's2'], ['.#=#=#.', 's3'], ['.=====.', 's3'], ['.......', 1],
      ['.=====.', 's7'], ['.##=##.', 's4'], ['.=====.', 's4'], ['.=.#.=.', 's3'], ['.=====.', 's4']] },
    { name: 'SPLIT AND WALLS', tier: 'easy', theme: 4, rows: [
      ['..===..', 's4'], ['.=====.', 's2'], ['.==.==.', 's6'], ['.=====.', 's2'], ['.%===%.', 's5'],
      ['.=%=%=.', 's4'], ['.=====.', 's3'], ['.......', 1], ['.=====.', 's7'], ['.=...=.', 's4'],
      ['.=====.', 's4'], ['..%=%..', 's4'], ['..===..', 's3']] },
    { name: 'TUBE ROWS', tier: 'easy', theme: 9, rows: [
      ['.=====.', 's3'], ['-.===.-', 's3'], ['-TTTTT-|-UUTUU-', 2], ['-.===.-', 's3'], ['..~=~..', 's3'],
      ['.U~U~U.', 3], ['..~=~..', 's2'], ['..===..', 's2'], ['.......', 1], ['-.===.-', 's7'],
      ['-.UUU.-', 2], ['-..=..-', 's3'], ['..===..', 's3']] },
    { name: 'HIGH DECK', tier: 'easy', theme: 5, rows: [
      ['.=====.', 's4'], ['.#####.', 's6'], ['.=====.', 's5'], ['.##=##.', 's4'], ['.=====.', 's3'],
      ['.......', 2], ['.=====.', 's7'], ['.==.==.', 's4'], ['.=====.', 's3'], ['.=###=.', 's3'], ['.=====.', 's3']] },
    { name: 'LONG LEAP', tier: 'easy', theme: 11, rows: [
      ['.=====.', 's4'], ['.~~~~~.', 1], ['.=====.', 's2'], ['.......', 2], ['..===..', 's6'],
      ['..*=*..', 's4'], ['..===..', 's3'], ['.......', 1], ['.=====.', 's7'], ['.*=*=*.', 's3'],
      ['.=====.', 's3'], ['..=.=..', 's4'], ['..===..', 's3']] },
    { name: 'THE SPINE', tier: 'easy', theme: 3, rows: [
      ['..===..', 's3'], ['...=...', 's4'], ['-..=..-', 1], ['...=...', 's3'], ['..===..', 's3'], ['..=.=..', 's5'],
      ['..===..', 's3'], ['...=...', 's3'], ['--.=.--', 1], ['...=...', 's3'], ['.......', 1], ['...=...', 's7'],
      ['--.=.--', 1], ['...=...', 's3'], ['-..=..-', 1], ['...=...', 's2'], ['..===..', 's3']] },
    { name: 'LAUNCH PAD', tier: 'easy', theme: 0, lead: '-.===.-', rows: [
      ['-~===~-', 1], ['#~===~#', 2], ['-.===.-', 's4'], ['-~===~-', 1], ['#~===~#', 2], ['-.===.-', 's4'],
      ['-~===~-', 1], ['#~===~#', 2], ['-.===.-', 's4'], ['-.=.=.-', 's3'], ['-.===.-', 's3'],
      ['-~===~-', 1], ['#~===~#', 2], ['-.===.-', 's3'], ['..===..', 's2']] },
    { name: 'ARROWHEAD', tier: 'easy', theme: 5, rows: [
      ['.=====.', 's4'], ['.=...=.', 1], ['.==.==.', 1], ['.=====.', 's3'], ['..===..', 's2'], ['...~...', 's4'],
      ['.~~~~~.', 1], ['..~~~..', 1], ['...~...', 1], ['.......', 1], ['.=====.', 's7'], ['.=...=.', 1],
      ['.==.==.', 1], ['.=====.', 's3']] },
    { name: 'TUNNEL GATES', tier: 'medium', theme: 6, rows: [
      ['.=====.', 's4'], ['.=.=.=.', 's3'], ['.T%=%U.|.U%=%T.', 3], ['.=.=.=.', 's2'], ['.=====.', 's4'], ['.T%U%%.|.%%U%T.', 3],
      ['..===..', 's3'], ['.......', 1], ['.=====.', 's7'], ['.U%U%T.|.T%U%U.', 3], ['.=====.', 's4'], ['.U%T%U.|.T%U%T.', 3],
      ['.=====.', 's3']] },   // every gate mixes open and closed tubes (layout picked per run)
    { name: 'BLUE HIGHWAY', tier: 'easy', theme: 7, rows: [
      ['-=====~', 's4'], ['%==%%%%', 's3'], ['-=====~', 's3'], ['%%%%==%', 's3'], ['-=====~', 's3'], ['%%==%%%', 's3'],
      ['-=====~', 's2'], ['.......', 1], ['-=====~', 's6'], ['%%%%%==', 's3'], ['-=====~', 's3'], ['==%%%%%', 's3'], ['-=====~', 's3'],
      ['..===..', 's2']] },   // the gap in each wall moves: left, right, middle, far right, far left
    { name: 'WING BRIDGES', tier: 'easy', theme: 3, rows: [
      ['..===..', 's4'], ['-.===.-', 1], ['--===--', 's3'], ['--...--', 's8'], ['--===--', 's3'], ['..===..', 's3'],
      ['.......', 1], ['.=====.', 's5'], ['--===--', 's2'], ['--...--', 's3'], ['-.....-', 's5'], ['--...--', 's3'], ['--===--', 's2'],
      ['..===..', 's3']] },   // long voids between the wings: you have to ride them
    { name: 'MAROON CANYON', tier: 'medium', theme: 4, rows: [
      ['.=====.', 's4'], ['%===%..', 's4'], ['%=.=%..|%===%..', 's3'], ['%===%..', 's3'], ['.%=%...', 's3'],
      ['.===...', 's2'], ['.......', 1], ['.===...', 's7'], ['%===%..', 's3'], ['.%=%...', 's3'], ['.=====.', 's3']] },
    { name: 'T-JUNCTION', tier: 'easy', theme: 1, rows: [
      ['...=...', 's4'], ['..===..', 's2'], ['=======', 2], ['==...==', 's5'], ['=======', 2], ['..===..', 's3'],
      ['...=...', 's3'], ['.......', 1], ['..===..', 's5'], ['=======', 2], ['==...==', 's6'], ['=======', 2], ['..===..', 's3']] },

    /* ---------------- medium ---------------- */
    { name: 'SIDE LEAPS', tier: 'medium', theme: 3, rows: [
      ['..===..', 's3'], ['===....', 's3'], ['.......', 1], ['....===', 's3'], ['.......', 1], ['===....', 's3'], ['.......', 1],
      ['....===', 's3'], ['.......', 1], ['..===..', 's3'], ['.......', 2], ['===....', 's2'], ['.......', 1], ['....===', 's2'], ['.......', 1],
      ['..===..', 's3']] },
    { name: 'FIRE ZIGZAG', tier: 'medium', theme: 10, rows: [         // a two-lane path zig-zags through a field of fire
      ['.=====.', 's3'], ['.==***.', 's3'], ['.*==**.', 's3'], ['.**==*.', 's3'], ['.***==.', 's3'],
      ['.**==*.', 's3'], ['.*==**.', 's3'], ['.==***.', 's3'], ['.=====.', 's3'], ['.......', 1], ['.=====.', 's6']] },
    { name: 'NARROW ZIGZAG', tier: 'medium', theme: 2, rows: [
      ['..===..', 's3'], ['...=...', 's3'], ['..==...', 's2'], ['..=....', 's3'], ['.==....', 's2'], ['.=.....', 's3'], ['.==....', 's2'],
      ['..=....', 's3'], ['..==...', 's2'], ['...=...', 's3'], ['...==..', 's2'], ['....=..', 's3'], ['....==.', 's2'], ['.....=.', 's3'],
      ['....==.', 's2'], ['....=..', 's3'], ['...==..', 's2'], ['...=...', 's3'], ['..===..', 's3'], ['.......', 1], ['..===..', 's6']] },
    { name: 'CHECKER HOLES', tier: 'easy', theme: 8, rows: [
      ['.=====.', 's3'], ['.=.=.=.', 's3'], ['.=====.', 's2'], ['..=.=..', 's3'], ['.=====.', 's2'], ['.=.=.=.', 's3'],
      ['.=====.', 's2'], ['=.=.=.=', 's3'], ['.=====.', 's2'], ['..=.=..', 's3'], ['.=====.', 's3'], ['.......', 2], ['.=====.', 's6']] },
    { name: 'FIRE BRIDGE', tier: 'medium', theme: 4, rows: [
      ['.=====.', 's3'], ['.=***..', 's5'], ['.......', 1], ['.=***..', 's5'], ['.=****.', 's3'], ['.=====.', 's3']] },
    { name: 'TUNNEL RUN', tier: 'easy', theme: 9, rows: [          // one open tube per gate, and it moves
      ['.=====.', 's4'], ['.UUTUU.', 2], ['.=====.', 's3'], ['.UTUUU.|.UUUTU.', 2], ['.=====.', 's3'], ['.UUTUU.', 2],
      ['.=====.', 's3'], ['.......', 1], ['.=====.', 's6']] },
    { name: 'STAIR DECKS', tier: 'medium', theme: 5, rows: [
      ['.=====.', 's4'], ['.#####.', 's4'], ['.22222.', 's4'], ['.......', 1], ['.22222.', 's3'],
      ['.=====.', 's4'], ['.##=##.', 's3'], ['.==.==.', 's3'], ['.=====.', 's4']] },
    { name: 'SPLIT FIRE', tier: 'medium', theme: 7, rows: [
      ['.=====.', 's3'], ['.==.==.', 's3'], ['.......', 1], ['.*=.=*.', 's3'], ['.......', 1], ['.==.==.', 's3'], ['.......', 1],
      ['..*=*..', 's3'], ['.......', 1], ['.=====.', 's3'], ['.......', 2], ['.=====.', 's6']] },
    { name: 'WALL WEAVE', tier: 'medium', theme: 1, rows: [
      ['.=====.', 's3'], ['.%%%%=.', 's4'], ['.=====.', 's3'], ['.=%%%%.', 's4'], ['.=====.', 's3'], ['.%%%%=.', 's4'],
      ['.=====.', 's3'], ['.......', 1], ['.=====.', 's6']] },
    { name: 'GAUNTLET', tier: 'hard', theme: 6, rows: [
      ['.=====.', 's3'], ['.#===#.', 's2'], ['.=*=*=.', 's3'], ['.=====.', 's2'], ['.T%=%T.|.U%T%U.', 2], ['.=====.', 's4'],
      ['.......', 3], ['..===..', 's5'], ['.==.==.', 's3'], ['.=====.', 's3']] },
    /* ---------------- hard (tier 'expert' = the toughest ones, later in a run) ---------------- */
    { name: 'HOP STONES', tier: 'expert', theme: 3, rows: [
      ['..===..', 's3'], ['.=.....', 's2'], ['.......', 2], ['....=..', 's2'], ['.......', 2], ['..=....', 's2'], ['.......', 2],
      ['.....=.', 's2'], ['.......', 2], ['...=...', 's2'], ['.......', 2], ['.=.....', 's2'], ['.......', 2], ['..===..', 's4']] },
    { name: 'ZIGZAG HOPS', tier: 'expert', theme: 2, rows: [           // pads alternate left and right: hop across each time
      ['..===..', 's3'], ['..=....', 's2'], ['.......', 2], ['....=..', 's2'], ['.......', 2], ['..=....', 's2'], ['.......', 2],
      ['....=..', 's2'], ['.......', 2], ['...=...', 's2'], ['.......', 2], ['..===..', 's4']] },
    { name: 'CLOSED TRIO', tier: 'medium', theme: 9, rows: [           // three closed tubes: go over the top
      ['.=====.', 's3'], ['.UUUUU.', 's2'], ['.=====.', 's4'], ['.UUUUU.', 's2'], ['.=====.', 's4'], ['%UUUUU%', 's2'], ['.=====.', 's4']] },
    { name: 'LEFT TUBE', tier: 'medium', theme: 6, rows: [             // one tube on the left, fire everywhere else
      ['.=====.', 's3'], ['.===**.', 's2'], ['.==***.', 's2'], ['.T*****', 's8'], ['.=*****', 's1'], ['.=====.', 's4']] },
    { name: 'ROOF HATCH', tier: 'hard', theme: 4, rows: [
      ['..===..', 's3'], ['..%T%..', 's4'], ['..%=%..', 's3'], ['..UUU..', 's5'], ['..===..', 's4']] },
    { name: 'RAMP DROP', tier: 'medium', theme: 5, rows: [             // climb higher and higher, then the road drops away
      ['.=====.', 's3'], ['.UUUUU.', 's3'], ['.#####.', 's4'], ['.......', 2], ['.=====.', 's3'], ['..UUU..', 's2'],
      ['..###..', 's3'], ['.......', 2], ['..===..', 's4']] },
    { name: 'TRIPLE JUMP', tier: 'hard', theme: 11, rows: [          // hole, wall, hole, fire, pillars: jump jump jump
      ['.=====.', 's3'], ['.......', 2], ['.=====.', 's2'], ['.#####.', 1], ['.=====.', 's2'], ['.......', 2], ['.=====.', 's2'],
      ['.*****.', 's2'], ['.=====.', 's2'], ['.#.#.#.', 1], ['.=====.', 's4']] },
    { name: 'BLOCK STORM', tier: 'hard', theme: 1, rows: [
      ['.=====.', 's3'], ['.#=#=#.', 's2'], ['.=====.', 's3'], ['.=#=#=.', 's2'], ['.=====.', 's3'], ['.#=#=#.', 's2'], ['.=====.', 's3'],
      ['.##=##.', 's2'], ['.=====.', 's3'], ['.=#=#=.', 's2'], ['.=====.', 's3']] },
    { name: 'SLIDERS', tier: 'medium', theme: 7, rows: [               // blocks sweep across the road: time it or jump them
      ['.=====.', 's3'], ['.MMMMM.', 1], ['.=====.', 's4'], ['.MMMMM.', 1], ['.=====.', 's4'], ['..MMM..', 1], ['.=====.', 's4'],
      ['.MMMMM.', 1], ['.=====.', 's4']] },
    { name: 'FIRE STONES', tier: 'expert', theme: 10, rows: [          // stepping stones in a sea of fire
      ['.=====.', 's3'], ['.**=**.', 's2'], ['.*****.', 's2'], ['.*=***.', 's2'], ['.*****.', 's2'], ['.***=*.', 's2'], ['.*****.', 's2'],
      ['.**=**.', 's2'], ['.=====.', 's4']] },
    { name: 'THE NEEDLE', tier: 'hard', theme: 3, rows: [            // one lane, broken, fenced by fire and blocks
      ['..===..', 's3'], ['...=...', 's4'], ['.......', 1], ['...=...', 's3'], ['..*=*..', 's3'], ['.......', 1], ['...=...', 's3'],
      ['..#=#..', 's3'], ['...=...', 's2'], ['.......', 2], ['..===..', 's4']] },
    { name: 'SIDEWINDER', tier: 'medium', theme: 2, rows: [            // a one-tile path snaking across the void
      ['..===..', 's3'], ['...=...', 's2'], ['....=..', 's2'], ['.....=.', 's2'], ['....=..', 's2'], ['...=...', 's2'], ['..=....', 's2'],
      ['.=.....', 's2'], ['..=....', 's2'], ['...=...', 's2'], ['..===..', 's3']] },
    { name: 'TUBE HOPS', tier: 'hard', theme: 9, rows: [             // closed tubes over holes: hop from roof to roof
      ['.=====.', 's3'], ['.UUUUU.', 's2'], ['.......', 2], ['.UUUUU.', 's2'], ['.......', 2], ['.UUUUU.', 's3'], ['.......', 2], ['.=====.', 's4']] },
    { name: 'DECK HOPS', tier: 'expert', theme: 5, rows: [             // high decks with holes between
      ['.=====.', 's3'], ['.#####.', 's3'], ['.......', 2], ['.#####.', 's3'], ['.......', 2], ['..###..', 's3'], ['.......', 2],
      ['.#####.', 's3'], ['.=====.', 's3']] },
    { name: 'WALL SLOTS', tier: 'easy', theme: 4, rows: [            // one-lane slots in full walls, each in a new place
      ['.=====.', 's3'], ['%%%=%%%', 's3'], ['.=====.', 's4'], ['%=%%%%%', 's3'], ['.=====.', 's4'], ['%%%%%=%', 's3'], ['.=====.', 's4'],
      ['%%%=%%%', 's3'], ['.=====.', 's3']] },
    { name: 'FIRE CHECKER', tier: 'medium', theme: 10, rows: [         // fire checkerboard: weave or hop
      ['.=====.', 's3'], ['.*=*=*.', 's2'], ['.=*=*=.', 's2'], ['.*=*=*.', 's2'], ['.......', 1], ['.=*=*=.', 's2'], ['.*=*=*.', 's2'],
      ['.=*=*=.', 's2'], ['.=====.', 's4']] },
    { name: 'TUNNEL CHAIN', tier: 'hard', theme: 6, rows: [          // single tunnels that keep moving lanes
      ['.=====.', 's3'], ['.%T%...', 's4'], ['.=====.', 's3'], ['..%T%..', 's4'], ['.=====.', 's3'], ['...%T%.', 's4'], ['.=====.', 's3'],
      ['.%T%...', 's4'], ['.=====.', 's3']] },
    { name: 'BROKEN SPINE', tier: 'hard', theme: 3, rows: [          // a one-lane spine full of gaps
      ['...=...', 's3'], ['.......', 1], ['...=...', 's2'], ['.......', 1], ['...=...', 's2'], ['.......', 2], ['...=...', 's2'],
      ['.......', 1], ['...=...', 's2'], ['.......', 2], ['..===..', 's4']] },
    { name: 'EDGE WALK', tier: 'hard', theme: 11, rows: [            // ride the very edge of the road, then the other edge
      ['.=====.', 's3'], ['==.....', 's4'], ['=......', 's3'], ['==.....', 's2'], ['.......', 2], ['..===..', 's3'], ['.....==', 's4'],
      ['......=', 's3'], ['.....==', 's2'], ['.......', 2], ['..===..', 's4']] },
    { name: 'FIRE TUBE', tier: 'medium', theme: 8, rows: [             // a lone tube through a fire field
      ['.=====.', 's3'], ['.**=**.', 's2'], ['***T***', 's6'], ['.**=**.', 's2'], ['.=====.', 's2'], ['.......', 2], ['.=====.', 's4']] },
    { name: 'CANYON LEAPS', tier: 'expert', theme: 0, rows: [          // long jumps: take off from the very edge
      ['.=====.', 's3'], ['.......', 3], ['.=====.', 's2'], ['.......', 3], ['..===..', 's2'], ['.......', 3], ['.=====.', 's4']] },
    { name: 'PILLAR FIELD', tier: 'hard', theme: 1, rows: [          // rows of pillars and holes: nothing to do but jump
      ['.=====.', 's3'], ['.#.#.#.', 1], ['.=====.', 's2'], ['.=#.#=.', 1], ['.=====.', 's2'], ['.#.#.#.', 1], ['.=====.', 's2'],
      ['#.#.#.#', 1], ['.=====.', 's3']] },
    { name: 'CROSSFIRE', tier: 'medium', theme: 10, rows: [            // full-width fire lines between blocks
      ['.=====.', 's3'], ['*******', 's1'], ['.=====.', 's2'], ['.#===#.', 's1'], ['*******', 's1'], ['.=====.', 's2'], ['*******', 's2'],
      ['.=====.', 's2'], ['.==#==.', 's1'], ['.=====.', 's3']] },
    { name: 'SLIDER ALLEY', tier: 'hard', theme: 7, rows: [          // a narrow road with blocks sliding across it
      ['..===..', 's3'], ['..MMM..', 1], ['..===..', 's3'], ['.......', 1], ['..===..', 's3'], ['..MMM..', 1], ['..===..', 's2'],
      ['..MMM..', 1], ['..===..', 's4']] },
    { name: 'SLIDER FIRE', tier: 'hard', theme: 4, rows: [           // sliding blocks with fire at the edges
      ['.=====.', 's3'], ['.*MMM*.', 1], ['.*===*.', 's3'], ['.MMMMM.', 1], ['.*===*.', 's3'], ['.*MMM*.', 1], ['.=====.', 's4']] },
    { name: 'HATCH AND FIRE', tier: 'medium', theme: 6, rows: [        // out through the roof, then down between fire
      ['..===..', 's3'], ['.*%T%*.', 's4'], ['.*%=%*.', 's2'], ['.*UUU*.', 's4'], ['.**=**.', 's3'], ['..===..', 's3']] },
    { name: 'TOWER CLIMB', tier: 'hard', theme: 5, rows: [           // tube, deck, deck, tube: over the holes at height
      ['.=====.', 's3'], ['..UUU..', 's2'], ['..###..', 's3'], ['.......', 2], ['..###..', 's3'], ['.......', 2], ['..UUU..', 's2'],
      ['.......', 2], ['..===..', 's4']] },
    { name: 'FIRE THREAD', tier: 'hard', theme: 10, rows: [          // a single safe lane threading through fire
      ['.=====.', 's3'], ['**=****', 's2'], ['***=***', 's2'], ['****=**', 's2'], ['*****=*', 's2'], ['****=**', 's2'], ['***=***', 's2'],
      ['**=****', 's2'], ['*=*****', 's2'], ['**=****', 's2'], ['.=====.', 's3']] },
    { name: 'LEAP OF FAITH', tier: 'expert', theme: 11, rows: [        // long gap, one tiny pad, another gap
      ['.=====.', 's3'], ['.......', 3], ['...=...', 's2'], ['.......', 2], ['...=...', 's2'], ['.......', 3], ['.=====.', 's4']] },
    { name: 'FINAL EXAM', tier: 'expert', theme: 0, rows: [            // a bit of everything
      ['.=====.', 's3'], ['.#===#.', 's2'], ['.......', 2], ['..%T%..', 's3'], ['..%=%..', 's2'], ['..UUU..', 's3'], ['.......', 2],
      ['..=.=..', 's2'], ['.......', 1], ['.=====.', 's2'], ['.MMMMM.', 1], ['.=====.', 's3'], ['*******', 's1'], ['.=====.', 's4']] },
    /* ---------------- set 2: easy ---------------- */
    { name: 'DOUBLE TRACK', tier: 'easy', theme: 7, rows: [            // twin lanes, a split, one small gap
      ['.=====.', 's4'], ['.==.==.', 's6'], ['.=====.', 's3'], ['.=.=.=.', 's3'], ['.=====.', 's3'], ['.......', 1], ['.=====.', 's5']] },
    { name: 'SOFT FIRE', tier: 'easy', theme: 10, rows: [              // a first taste of fire at the edges
      ['.=====.', 's4'], ['.*===*.', 's4'], ['.=====.', 's3'], ['.==*==.', 's3'], ['.=====.', 's4']] },
    { name: 'LOW WALLS', tier: 'easy', theme: 1, rows: [               // single walls to steer past
      ['.=====.', 's4'], ['.%===%.', 's4'], ['.=====.', 's2'], ['.#====.', 's2'], ['.=====.', 's3'], ['.====#.', 's2'], ['.=====.', 's4']] },
    { name: 'OPEN TUBES', tier: 'medium', theme: 9, rows: [              // three open tubes, then one
      ['.=====.', 's4'], ['.T.T.T.', 3], ['.=====.', 's4'], ['..TTT..', 3], ['.=====.', 's4']] },
    { name: 'SKY STEPS', tier: 'easy', theme: 11, rows: [              // two easy hops
      ['..===..', 's4'], ['.......', 1], ['..===..', 's5'], ['.=====.', 's5'], ['.......', 1], ['.=====.', 's5']] },

    /* ---------------- set 2: medium ---------------- */
    { name: 'SLOW SLIDER', tier: 'medium', theme: 7, rows: [           // meet the sliding blocks
      ['.=====.', 's4'], ['..MMM..', 1], ['.=====.', 's5'], ['.MMMMM.', 1], ['.=====.', 's5']] },
    { name: 'FIRE GATES', tier: 'easy', theme: 4, rows: [            // one safe lane through each fire line
      ['.=====.', 's3'], ['.**=**.', 's2'], ['.=====.', 's3'], ['.*=***.', 's2'], ['.=====.', 's3'], ['.***=*.', 's2'], ['.=====.', 's4']] },
    { name: 'HOLE FIELD', tier: 'easy', theme: 8, rows: [            // holes scattered across the road
      ['.=====.', 's3'], ['.==.==.', 's3'], ['.=====.', 's2'], ['..=.=..', 's3'], ['.=====.', 's2'], ['.=.=.=.', 's3'], ['.=====.', 's4']] },
    { name: 'TUBE SLALOM', tier: 'medium', theme: 6, rows: [           // the open tube jumps from side to side
      ['.=====.', 's3'], ['.T%%%%.', 3], ['.=====.', 's4'], ['.%%%%T.', 3], ['.=====.', 's4'], ['.%%T%%.', 3], ['.=====.', 's4']] },
    { name: 'DECK AND DIVE', tier: 'medium', theme: 5, rows: [         // up on a deck, over a gap, round a channel
      ['.=====.', 's3'], ['.#####.', 's4'], ['.......', 1], ['.=====.', 's4'], ['.##=##.', 's3'], ['.=====.', 's4']] },
    { name: 'SPLIT RIDGE', tier: 'easy', theme: 3, rows: [           // the road splits into two thin edges
      ['..===..', 's3'], ['.==.==.', 's3'], ['.=...=.', 's4'], ['.==.==.', 's2'], ['..===..', 's3'], ['.......', 1], ['..===..', 's4']] },
    { name: 'CAP HOPS', tier: 'medium', theme: 9, rows: [              // jump the closed tubes
      ['.=====.', 's4'], ['.UUUUU.', 's2'], ['.=====.', 's4'], ['..UUU..', 's2'], ['.=====.', 's4']] },
    { name: 'FIRE RIBBON', tier: 'medium', theme: 10, rows: [          // a two-lane ribbon wiggling through fire
      ['.=====.', 's3'], ['.*==**.', 's3'], ['.**==*.', 's3'], ['.*==**.', 's3'], ['.=====.', 's3'], ['.......', 1], ['.=====.', 's4']] },

    /* ---------------- set 2: hard ---------------- */
    { name: 'SLIDER GATES', tier: 'medium', theme: 7, rows: [            // sliders back to back, then a narrow gap
      ['.=====.', 's3'], ['.MMMMM.', 1], ['.=====.', 's2'], ['.MMMMM.', 1], ['.=====.', 's3'], ['..MMM..', 1], ['..===..', 's3'], ['.......', 1], ['.=====.', 's4']] },
    { name: 'FIRE STAIRS', tier: 'expert', theme: 4, rows: [             // climb over fire: tube roof, fire, deck, fire
      ['.=====.', 's3'], ['.UUUUU.', 's2'], ['.*****.', 's3'], ['.#####.', 's3'], ['.*****.', 's2'], ['.=====.', 's4']] },
    { name: 'TWIN TUBES', tier: 'hard', theme: 6, rows: [              // pick a tube, then the next pair, then one over a gap
      ['.=====.', 's3'], ['.T%%%T.', 's4'], ['.=====.', 's2'], ['.%T%T%.', 's4'], ['.=====.', 's2'], ['..%T%..', 's4'], ['..===..', 's2'], ['.......', 1], ['.=====.', 's4']] },
    { name: 'HOLE WEAVE', tier: 'medium', theme: 2, rows: [              // a thin path swinging hard left then hard right
      ['..===..', 's3'], ['.==....', 's3'], ['.=.....', 's2'], ['.==....', 's2'], ['..===..', 's2'], ['....==.', 's3'], ['.....=.', 's2'], ['....==.', 's2'], ['..===..', 's3']] },
    { name: 'BURNING DECKS', tier: 'expert', theme: 10, rows: [          // high decks over fire
      ['.=====.', 's3'], ['.#####.', 's3'], ['.*****.', 's2'], ['.#####.', 's3'], ['.*****.', 's2'], ['.=====.', 's4']] },
    { name: 'CROSS SLIDERS', tier: 'medium', theme: 1, rows: [           // half-road sliders on alternating sides
      ['.=====.', 's3'], ['.MMM==.', 1], ['.=====.', 's2'], ['.==MMM.', 1], ['.=====.', 's2'], ['.MMM==.', 1], ['.=====.', 's2'], ['.==MMM.', 1], ['.=====.', 's4']] },
    { name: 'CANYON TUBE', tier: 'hard', theme: 8, rows: [             // leap a canyon, line up with the tube, leap again
      ['.=====.', 's3'], ['.......', 2], ['..===..', 's2'], ['..%T%..', 's4'], ['..===..', 's2'], ['.......', 2], ['.=====.', 's4']] },

    /* ---------------- set 2: expert ---------------- */
    { name: 'PIN POINTS', tier: 'expert', theme: 3, rows: [            // one-tile pads, left and right
      ['..===..', 's3'], ['...=...', 's1'], ['.......', 2], ['..=....', 's1'], ['.......', 2], ['....=..', 's1'], ['.......', 2], ['...=...', 's1'], ['.......', 2], ['..===..', 's4']] },
    { name: 'FIRE MAZE', tier: 'medium', theme: 10, rows: [            // a winding safe path through a fire field
      ['.=====.', 's3'], ['**=****', 's2'], ['**===**', 's2'], ['****=**', 's2'], ['**===**', 's2'], ['**=****', 's2'], ['.=====.', 's3']] },
    { name: 'SLIDER HOPS', tier: 'expert', theme: 7, rows: [          // sliders between holes: dodge while hopping
      ['.=====.', 's3'], ['.MMMMM.', 1], ['.......', 2], ['.MMMMM.', 1], ['.......', 2], ['.=====.', 's4']] },
    { name: 'NEEDLE TUBES', tier: 'hard', theme: 6, rows: [          // lone tubes over the void, jump out as they end
      ['..===..', 's3'], ['...T...', 's3'], ['.......', 1], ['...T...', 's3'], ['...=...', 's2'], ['.......', 2], ['..===..', 's4']] },
    { name: 'GRAND FINALE', tier: 'expert', theme: 0, rows: [          // v2 and v3 only (not in PATCHES_V4)          // blocks and fire, a gap, tube roof, deck, slider, fire
      ['.=====.', 's3'], ['.*#*#*.', 's2'], ['.=====.', 's2'], ['.......', 2], ['..UUU..', 's2'], ['..###..', 's2'], ['.......', 2], ['.MMMMM.', 1],
      ['.=====.', 's2'], ['**=*=**', 's2'], ['.=====.', 's4']] },
    /* ---------------- set 3: easy (single-tile paths, towers) ---------------- */
    { name: 'EDGE RUNNER', tier: 'easy', theme: 11, rows: [            // a two-to-three-tile path drifting to the left edge, then the right edge
      ['..===..', 's4'], ['.===...', 's4'], ['.==....', 's4'], ['===....', 's4'], ['==.....', 's5'], ['===....', 's3'], ['.===...', 's3'],
      ['..===..', 's3'], ['...===.', 's3'], ['....===', 's3'], ['.....==', 's5'], ['....===', 's3'], ['...===.', 's3'], ['..===..', 's4']] },
    { name: 'HIGH ROAD', tier: 'hard', theme: 0, rows: [              // the tile runs into fire: hop onto the raised block beside it, then drop back
      ['..===..', 's3'], ['..#=...', 's4'], ['..#*...', 's6'], ['..#=...', 's2'], ['...=...', 's4'], ['..===..', 's3'],
      ['...=#..', 's4'], ['...*#..', 's6'], ['...=#..', 's2'], ['...=...', 's3'], ['..===..', 's3']] },
    { name: 'BLOCK HOPS', tier: 'medium', theme: 2, rows: [             // walled edges, single blocks stepping left to right
      ['.=====.', 's3'], ['%=====%', 's2'], ['%#====%', 's2'], ['%=====%', 's2'], ['%=#===%', 's2'], ['%=====%', 's2'], ['%==#==%', 's2'],
      ['%=====%', 's2'], ['%===#=%', 's2'], ['%=====%', 's2'], ['%====#%', 's2'], ['%=====%', 's2'], ['%===#=%', 's2'], ['%=====%', 's2'],
      ['%==#==%', 's2'], ['%=====%', 's3'], ['.=====.', 's3']] },
    { name: 'SIDE TOWERS', tier: 'easy', theme: 5, rows: [            // raised strips on both edges: ride them over the gap or stay low
      ['.=====.', 's3'], ['##===##', 's5'], ['##...##', 's3'], ['##===##', 's4'], ['.=====.', 's3'], ['.......', 1], ['.=====.', 's3'],
      ['#=====#', 's4'], ['#=...=#', 's3'], ['#=====#', 's3'], ['.=====.', 's3']] },
    { name: 'EDGE TO EDGE', tier: 'easy', theme: 8, rows: [            // a two-tile path running diagonally edge to edge and back
      ['..===..', 's3'], ['.==....', 's3'], ['==.....', 's4'], ['.==....', 's2'], ['..==...', 's2'], ['...==..', 's2'], ['....==.', 's2'],
      ['.....==', 's4'], ['....==.', 's2'], ['...==..', 's2'], ['..==...', 's2'], ['.==....', 's2'], ['==.....', 's4'], ['.==....', 's2'],
      ['..===..', 's3']] },
  ];

  /* ---------- practice tutorial (never scored, never in a session) ---------- */
  const TUTORIAL = [
    { name: 'TUT OPEN', tier: 'tutorial', theme: 0, lead: '.=====.', rows: [['.=====.', 8]] },   // open road while a lesson waits for you
    { name: 'TUT GAPS', tier: 'tutorial', theme: 1, lead: '.=====.', rows: [
      ['.=====.', 's4'], ['.......', 1], ['.=====.', 's8'], ['.......', 1], ['.=====.', 's6']] },
    { name: 'TUT BLOCKS', tier: 'tutorial', theme: 2, lead: '.=====.', rows: [
      ['.=====.', 's4'], ['.###==.', 's2'], ['.=====.', 's7'], ['.==###.', 's2'], ['.=====.', 's6']] },
    { name: 'TUT FIRE', tier: 'tutorial', theme: 10, lead: '.=====.', rows: [
      ['.=====.', 's4'], ['.***==.', 's3'], ['.=====.', 's7'], ['.==***.', 's3'], ['.=====.', 's6']] },
  ];
  /* v4 patch table: GRAND FINALE is gone, NEEDLE TUBES has road (not holes) between its tubes, SLIDER HOPS is
     one continuous platform. Every other patch is the same object as in v2 and v3. */
  const V4_ROWS = {
    'NEEDLE TUBES': [['..===..', 's3'], ['...T...', 's3'], ['...=...', 1], ['...T...', 's3'], ['...=...', 's2'], ['.......', 2], ['..===..', 's4']],
    'SLIDER HOPS': [['.=====.', 's3'], ['.MMMMM.', 1], ['.=====.', 2], ['.MMMMM.', 1], ['.=====.', 2], ['.=====.', 's4']],
  };
  const PATCHES_V4 = PATCHES.filter(p => p.name !== 'GRAND FINALE').map(p => V4_ROWS[p.name] ? Object.assign({}, p, { rows: V4_ROWS[p.name] }) : p);
  const V5_GONE = ['FIRE CHECKER', 'FIRE STONES', 'FIRE THREAD'];
  const PATCHES_V5 = PATCHES_V4.filter(p => V5_GONE.indexOf(p.name) < 0);
  function makeTable(list) {
    const all = list.concat(TUTORIAL), idx = name => all.findIndex(p => p.name === name);
    const tier = { easy: [], medium: [], hard: [], expert: [] };
    list.forEach((p, i) => tier[p.tier].push(i));
    return { ALL: all, TIER: tier, OPENING: idx('LAUNCH PAD'), TUT_OPEN: idx('TUT OPEN') };
  }
  const TABLE_V3 = makeTable(PATCHES), TABLE_V4 = makeTable(PATCHES_V4), TABLE_V5 = makeTable(PATCHES_V5);
  const tableFor = v => v >= 5 ? TABLE_V5 : v >= 4 ? TABLE_V4 : TABLE_V3;     // v2 and v3 share the old table
  const ALL = TABLE_V5.ALL, TIER = TABLE_V5.TIER;

  /* difficulty schedule by patch number (0 = LAUNCH PAD). Each phase repeats its
     pattern: E easy, M medium, H hard, X expert. Hard ones are always followed by
     something lighter, and an easy breather keeps coming until the end. */
  const SCHEDULE = [
    [4, 'E'],          //  1 to 4    warm-up
    [10, 'EME'],       //  5 to 10   first mediums
    [18, 'MEM'],       // 11 to 18  mostly medium
    [28, 'MHME'],      // 19 to 28  first hards
    [40, 'HMXE'],      // 29 to 40  experts join
    [60, 'HXMXE'],     // 41 to 60  mostly hard
    [1e9, 'XHXXME'],   // 61+    peak (still 1 in 6 easy)
  ];
  const LETTER = { E: 'easy', M: 'medium', H: 'hard', X: 'expert' };
  // when a tier has no unplayed patches left, the nearest tier with some fills in
  const NEAREST = { easy: ['easy', 'medium', 'hard', 'expert'], medium: ['medium', 'easy', 'hard', 'expert'],
    hard: ['hard', 'medium', 'expert', 'easy'], expert: ['expert', 'hard', 'medium', 'easy'] };
  function tierAt(n) {
    let start = 1;
    for (const [until, pat] of SCHEDULE) { if (n <= until) return LETTER[pat[(n - start) % pat.length]]; start = until + 1; }
  }

  /* ---------- seeded randomness (index-addressed) ---------- */
  function hash32(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry32(a) {
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function rand(seedH, n, k) { return mulberry32((seedH ^ Math.imul(n + 1, 0x9E3779B1) ^ Math.imul(k + 1, 0x85EBCA77)) >>> 0)(); }

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const ease = k => k * k * (3 - 2 * k);
  const spdAt = (r, version) => Math.min(SPEED0 + Math.floor(Math.max(0, r) / SPEED_EVERY) * SPEED_INC, version >= 5 ? SPEED_MAX_V5 : SPEED_MAX);
  const colOf = x => Math.floor(x + 3.5);
  const cxOf = c => c - 3;
  // sliding block centre (road x) in row r at step n: a triangle wave between its first and last lane
  function moverX(k, r, n) {
    const lo = k[W + 4] - 1, hi = k[W + 5] - 1, half = MOVER_PERIOD / 2;
    const u = ((n + r * MOVER_PHASE) % MOVER_PERIOD + MOVER_PERIOD) % MOVER_PERIOD;
    const f = u < half ? u / half : (MOVER_PERIOD - u) / half;
    return lo + f * (hi - lo) - 3;
  }
  // rows a patch entry becomes when built at `speed`. v4: a row that must be jumped over (nothing but holes and
  // fire) is its written count at every speed; any other 'sN' row stretches with speed for reaction time.
  function rowCount(version, str, cnt, speed) {
    const f = speed / SPEED0, hazard = /^[.*]+$/.test(str);
    // v4: other 'sN' rows stretch as they did in v3 at JUMP_ROWS_REF and above (a pad between two jumps must hold one
    // landing and one take-off at the constant jump length, so below JUMP_ROWS_REF it keeps its JUMP_ROWS_REF length)
    if (version >= 4) return typeof cnt !== 'string' ? cnt : hazard ? +cnt.slice(1) : Math.max(1, Math.round(+cnt.slice(1) * Math.max(speed, JUMP_ROWS_REF) / SPEED0));
    // v3: what must be jumped over (a hole, or a row of nothing but holes and fire) stretches only as far as the jump does
    const fh = version >= 3 ? Math.min(f, JUMP_REF / SPEED0) : f;
    const fs = version >= 3 && hazard ? fh : f;
    return typeof cnt === 'string' ? Math.max(1, Math.round(+cnt.slice(1) * fs)) : str === '.......' ? Math.round(cnt * Math.sqrt(fh)) : cnt;
  }
  const deckH = k => k === K.DECK3 ? BLOCK_H * 3 : k === K.DECK2 ? BLOCK_H * 2 : BLOCK_H;
  const quantX = v => Math.round(clamp(v, -X_LIMIT, X_LIMIT) * X_QUANT) / X_QUANT;

  /* ---------- line planner (used by the test bot only; never affects state) ---------- */
  const COST = [20, 0, 0, 0, 3, 3, 0.2, 60, 0, 3, 3, 3];
  function planLine(rs) {
    const n = rs.length, cost = rs.map(() => new Float64Array(W));
    for (let i = n - 1; i >= 0; i--) for (let c = 0; c < W; c++) {
      let best = i === n - 1 ? Math.abs(c - C) * 0.1 : 1e9;
      if (i < n - 1) for (let d = -1; d <= 1; d++) { const cc = c + d; if (cc >= 0 && cc < W) best = Math.min(best, cost[i + 1][cc] + Math.abs(d) * 0.6); }
      cost[i][c] = COST[rs[i][c]] + best;
    }
    let s = C;
    for (let i = 0; i < n; i++) {
      let bc = s, bv = 1e18;
      for (let d = -1; d <= 1; d++) { const cc = s + d; if (cc < 0 || cc >= W) continue; const v = cost[i][cc] + Math.abs(d) * 0.6 + Math.abs(cc - C) * 0.01; if (v < bv) { bv = v; bc = cc; } }
      s = bc; rs[i][W] = s;
    }
    for (let pass = 0; pass < 8; pass++) for (let i = n - 2; i >= 1; i--) {
      const a = rs[i][W], b = rs[i + 1][W];
      if (a !== b && COST[rs[i][b]] <= 0.2 && Math.abs(rs[i - 1][W] - b) <= 1) rs[i][W] = b;
    }
  }

  /* =====================================================================
     create({ seed, testPatch, tutorial, tutorialPick, fixedSpeed })
     Row layout: [0..6] cells, [7] planned line, [8] theme, [9] sky slot, [10] patch index,
     [11] sliding block first lane + 1 (0 = none), [12] its last lane + 1
     ===================================================================== */
  function create(opts) {
    opts = opts || {};
    const seedH = hash32(String(opts.seed == null ? 0 : opts.seed));
    const testPatch = opts.testPatch == null ? -1 : opts.testPatch;
    const tutorial = !!opts.tutorial, fixedSpeed = opts.fixedSpeed || 0;
    const version = opts.version == null ? RULES_VERSION : opts.version;
    const genSpeed = opts.genSpeed || 0;             // test tooling only: build the road as if at this speed
    const T = tableFor(version), ALL = T.ALL, TIER = T.TIER, OPENING = T.OPENING, TUT_OPEN = T.TUT_OPEN;
    const rows = new Map();
    let gen = -6, patchNo = 0, lastChoice = -1;
    const used = new Set();                          // patches already played this cycle: none repeats until every patch has been

    const s = {
      state: 'play', steps: 0, dist: 0, x: 0, y: 0, vx: 0, vy: 0, targetX: 0,
      grounded: true, bouncing: false, lastTop: 0, jumpBuf: 0, airSteps: 0, jumped: false,
      runSteps: 0, cruise: START_CRAWL, speed: START_CRAWL, deathCause: '', deathMode: '', events: [],
    };

    function choose(n) {
      if (tutorial) { const p = opts.tutorialPick && opts.tutorialPick(n); return p >= 0 ? p : TUT_OPEN; }   // lessons are fed in by the page
      if (testPatch >= 0) return n === 0 ? TUT_OPEN : testPatch;   // short run-up, then only the chosen patch
      if (n === 0) { used.add(OPENING); lastChoice = OPENING; return OPENING; }
      let list = [];
      for (let pass = 0; pass < 2 && !list.length; pass++) {
        if (pass) used.clear();                        // every patch played: start a fresh cycle
        for (const t of NEAREST[tierAt(n)]) { list = TIER[t].filter(i => !used.has(i) && i !== lastChoice); if (list.length) break; }
      }
      const i = list[Math.floor(rand(seedH, n, 2) * list.length)];
      used.add(i); lastChoice = i;
      return i;
    }
    function appendPatch(lead) {
      const n = patchNo++, pi = choose(n), p = ALL[pi], sky = Math.floor(n / SKY_EVERY) & 255, out = [];
      const push = (str, cnt) => { for (let i = 0; i < cnt; i++) { const k = new Uint8Array(W + 6); for (let c = 0; c < W; c++) k[c] = CH[str[c]]; k[W + 1] = p.theme; k[W + 2] = sky; k[W + 3] = pi;
        const m = str.indexOf('M'); if (m >= 0) { k[W + 4] = m + 1; k[W + 5] = str.lastIndexOf('M') + 1; }
        out.push(k); } };
      push(p.lead || '.=====.', lead); push(p.lead || '..===..', 2);
      p.rows.forEach((row, ri) => {
        const alts = row[0].split('|'), cnt = row[1];
        const str = alts.length > 1 ? alts[Math.floor(rand(seedH, n, 100 + ri) * alts.length)] : alts[0];
        push(str, rowCount(version, str, cnt, genSpeed || spdAt(gen + out.length, version)));
      });
      planLine(out);
      for (const k of out) rows.set(gen++, k);
    }
    function ensure() {
      while (gen < s.dist + GEN_AHEAD) appendPatch(0);
      for (const r of rows.keys()) { if (r < s.dist - KEEP_BEHIND) rows.delete(r); else break; }
    }

    /* ---------- collision ---------- */
    function cell(r, c) { if (c < 0 || c >= W) return K.EMPTY; const k = rows.get(r); return k ? k[c] : K.EMPTY; }
    function solidAt(k, c, x, y) {
      if (k === K.EMPTY) return false;
      if (y + SHIP_H <= -FLOOR_T) return false;
      if (k === K.BLOCK || k === K.BLOCK2 || k === K.DECK2 || k === K.DECK3) return y < deckH(k) - STEP_UP;
      if (k === K.CAP) return y < TUBE_H - STEP_UP;
      if (k === K.BURN) return y < -BURN_SINK - LAND_TOL;
      if (k === K.TUNNEL) {
        if (y >= TUBE_H - STEP_UP) return false;
        if (Math.abs(x - cxOf(c)) <= TUBE_IN - SHIP_CORE && y + SHIP_H <= TUBE_IN_H + 0.05) return false;
        return true;
      }
      return y < -LAND_TOL;
    }
    function hitsAt(x, r, y) {
      const a = colOf(x - SHIP_HW * 0.9), b = colOf(x + SHIP_HW * 0.9);
      for (let c = a; c <= b; c++) { const k = cell(r, c); if (solidAt(k, c, x, y)) return k; }
      return 0;
    }
    function hitsSpan(x, d, y) { for (let r = Math.floor(d - TAIL); r <= Math.floor(d + NOSE); r++) if (hitsAt(x, r, y)) return true; return false; }
    function topOf(k, y) { return k === K.BLOCK || k === K.BLOCK2 || k === K.DECK2 || k === K.DECK3 ? deckH(k) : k === K.CAP ? TUBE_H : k === K.BURN ? -BURN_SINK : k === K.TUNNEL ? (y >= TUBE_H - STEP_UP ? TUBE_H : 0) : 0; }
    const colsBuf = new Float64Array(8);
    function supportTop(x, d, y) {
      const a = x - SHIP_HW, b = x + SHIP_HW, cols = colsBuf; let nc = 0;   // reused buffer: no garbage per step
      for (let c = colOf(a); c <= colOf(b); c++) {
        const ov = Math.min(b, c - 2.5) - Math.max(a, c - 3.5); if (ov <= 0.001) continue;
        let t = -99;
        for (let r = Math.floor(d - FOOT); r <= Math.floor(d + FOOT); r++) { const k = cell(r, c); if (k) t = Math.max(t, topOf(k, y)); }
        cols[nc++] = t; cols[nc++] = ov;
      }
      let best = -99;
      for (let i = 0; i < nc; i += 2) {
        const t = cols[i]; if (t <= best) continue;
        let cover = 0; for (let j = 0; j < nc; j += 2) if (cols[j] >= t - 0.01) cover += cols[j + 1];
        if (cover >= SUPPORT_MIN * 2 * SHIP_HW - 1e-6) best = t;
      }
      return best;
    }
    function burnFrac() {
      const a = s.x - SHIP_HW, b = s.x + SHIP_HW; let f = 0;
      for (let c = colOf(a); c <= colOf(b); c++) {
        let hot = false; for (let r = Math.floor(s.dist - FOOT); r <= Math.floor(s.dist + FOOT); r++) if (cell(r, c) === K.BURN) hot = true;
        if (hot) f += Math.max(0, Math.min(b, c - 2.5) - Math.max(a, c - 3.5));
      }
      return f / (b - a);
    }
    function touches(kind) {
      const a = colOf(s.x - SHIP_HW * 0.9), b = colOf(s.x + SHIP_HW * 0.9);
      for (let r = Math.floor(s.dist - TAIL); r <= Math.floor(s.dist + NOSE); r++) for (let c = a; c <= b; c++) if (cell(r, c) === kind) return true;
      return false;
    }
    function ceilAt(x, d, y) {
      if (y >= TUBE_H - STEP_UP) return 99;
      const a = colOf(x - SHIP_HW), b = colOf(x + SHIP_HW);
      for (let r = Math.floor(d - TAIL); r <= Math.floor(d + NOSE); r++) for (let c = a; c <= b; c++) if (cell(r, c) === K.TUNNEL) return TUBE_IN_H;
      return 99;
    }
    function moverHit(x, d, y) { // sliding blocks: full height, one lane wide
      if (y >= BLOCK_H - STEP_UP || y + SHIP_H <= -FLOOR_T) return false;
      for (let r = Math.floor(d - TAIL); r <= Math.floor(d + NOSE); r++) {
        const k = rows.get(r); if (!k || !k[W + 4]) continue;
        if (Math.abs(x - moverX(k, r, s.steps)) < 0.5 + SHIP_HW * 0.9) return true;
      }
      return false;
    }
    function die(cause, mode) { s.state = 'dead'; s.deathCause = cause; s.deathMode = mode; s.events.push('die'); }
    function canJump() { return s.grounded || (s.bouncing && s.y - s.lastTop < 0.25) || (!s.jumped && s.airSteps < COYOTE_STEPS && s.vy <= 0); }

    /* ---------- one fixed step ---------- */
    function step(inp) {
      if (s.state !== 'play') return;
      s.steps++;
      if (inp) { if (inp.x != null) s.targetX = quantX(inp.x); if (inp.jump) s.jumpBuf = JUMP_BUF_STEPS; }

      s.runSteps++;
      const pace = fixedSpeed || spdAt(s.dist, version);
      if (s.runSteps < START_RAMP_STEPS) s.cruise = Math.max(START_CRAWL, pace * ease(s.runSteps / START_RAMP_STEPS));
      else s.cruise = Math.min(pace, s.cruise + PACE_EASE * STEP);
      s.speed = s.cruise;
      if (s.jumpBuf > 0) s.jumpBuf--;
      const kv = version >= 4 ? Math.max(SPEED0, s.speed) / JUMP_ROWS_REF : version >= 3 ? Math.max(1, s.speed / JUMP_REF) : 1;   // vertical time scale

      if (s.jumpBuf > 0 && canJump()) { s.vy = JUMP_V * kv; s.grounded = false; s.bouncing = false; s.jumpBuf = 0; s.jumped = true; s.events.push('jump'); }

      // lateral: chase the steering target, with a gentle pull to a lane centre when close
      // lateral: straight to the target, no easing, no drift; a wall stops the ship where it touches
      const gap = s.targetX - s.x, eased = Math.abs(gap * (1 - STEER_EASE)) < STEER_SNAP ? gap : gap * STEER_EASE;   // snap onto the target when this close
      const x0 = s.x, dx = clamp(eased, -LAT_MAX * STEP, LAT_MAX * STEP);
      const n = Math.ceil(Math.abs(dx) / LAT_SUB);
      for (let i = 1; i <= n; i++) {
        const nx = x0 + dx * i / n; if (hitsSpan(nx, s.dist, s.y)) break;
        if (version >= 5 && moverHit(nx, s.dist, s.y)) {   // a slice that would put the ship inside a sliding block: close in on the contact point and crash there
          let lo = s.x, hi = nx; for (let j = 0; j < 12; j++) { const mid = (lo + hi) / 2; if (moverHit(mid, s.dist, s.y)) hi = mid; else lo = mid; }
          s.x = lo; s.vx = 0; return die('CRASHED', 'explode');
        }
        s.x = nx;
      }
      s.vx = (s.x - x0) / STEP;

      // forward: entering a row whose solid part we overlap destroys the ship (unless already falling below the road)
      const nd = s.dist + s.speed * STEP, rN = Math.floor(nd + NOSE);
      if ((version >= 5 || s.y >= -LAND_TOL) && rN !== Math.floor(s.dist + NOSE) && hitsAt(s.x, rN, s.y)) { s.dist = rN - NOSE - 0.01; return die('CRASHED', 'explode'); }
      s.dist = nd;
      if (moverHit(s.x, s.dist, s.y)) return die('CRASHED', 'explode');

      // vertical: gravity, landing with a small bounce, tunnel ceiling
      s.vy = Math.max(s.vy - G * kv * kv * STEP, TERMINAL_VY * kv);
      let ny = s.y + s.vy * STEP;
      const top = supportTop(s.x, s.dist, s.y);
      if (s.vy <= 0 && ny <= top && s.y >= top - LAND_TOL) {
        ny = top; s.grounded = true; s.lastTop = top;
        if (s.vy < -BOUNCE_MIN * kv) { s.vy = -s.vy * BOUNCE; s.bouncing = true; s.events.push('land'); }
        else { s.vy = 0; s.bouncing = false; }
      } else { s.grounded = false; if (s.y - s.lastTop > 0.3 || s.y < s.lastTop - 0.05) s.bouncing = false; }
      if (s.grounded) { s.airSteps = 0; s.jumped = false; } else s.airSteps++;
      const ceil = ceilAt(s.x, s.dist, s.y);
      if (ny + SHIP_H > ceil) { ny = ceil - SHIP_H; if (s.vy > 0) s.vy = 0; }
      s.y = ny;
      // v5: still inside something solid after the move (a descent into a block's side): that is the moment of impact
      if (version >= 5 && hitsSpan(s.x, s.dist, s.y)) return die('CRASHED', 'explode');

      if ((s.y < -0.01 && touches(K.BURN)) || (s.grounded && s.y < 0.02 && burnFrac() >= BURN_MIN)) return die('BURNED', 'burn');
      if (s.y < FALL_DEAD) return die('GAME OVER', 'fall');
      ensure();
    }

    if (testPatch >= 0) { s.runSteps = START_RAMP_STEPS; s.cruise = s.speed = spdAt(0, version); }   // test runs start at pace
    appendPatch(4);                                  // the first patch starts right under the ship
    ensure();
    return {
      s, rows, step, ensure, version, cell, supportTop, topOf, colOf,
      score: () => Math.floor(s.dist),
      patchAt: r => { const k = rows.get(r); return k ? k[W + 3] : -1; },
      // tutorial only (never scored): drop the road from row r on and build it again with the next lesson
      rebuildFrom: r => { if (!tutorial) return; for (const k of [...rows.keys()]) if (k >= r) rows.delete(k); gen = r; ensure(); },
      // test tooling only (solver): save / restore the whole run
      snapshot: () => ({ s: Object.assign({}, s, { events: [] }), rows: new Map(rows), gen, patchNo, lastChoice, used: [...used] }),
      restore: sn => { Object.assign(s, sn.s); s.events = []; rows.clear(); for (const [r, k] of sn.rows) rows.set(r, k); gen = sn.gen; patchNo = sn.patchNo; lastChoice = sn.lastChoice; used.clear(); for (const i of sn.used) used.add(i); },
    };
  }

  const CONST = { W, C, STEP, ROW_LEN, G, JUMP_V, BOUNCE, BOUNCE_MIN, SPEED0, SPEED_MAX, SPEED_INC, SPEED_EVERY, START_CRAWL, START_RAMP_STEPS,
    PACE_EASE, FLOOR_T, BLOCK_H, TUBE_OUT, TUBE_H, TUBE_IN, TUBE_IN_H, SHIP_HW, SHIP_H, SHIP_CORE, NOSE, TAIL, FOOT, STEP_UP, LAND_TOL, BURN_SINK,
    SUPPORT_MIN, BURN_MIN, JUMP_BUF_STEPS, COYOTE_STEPS, LAT_MAX, LAT_SUB, X_LIMIT, STEER_EASE, STEER_SNAP, X_QUANT, FALL_DEAD, TERMINAL_VY,
    GEN_AHEAD, KEEP_BEHIND, SKY_EVERY, MOVER_PERIOD, MOVER_PHASE, JUMP_REF, JUMP_ROWS_REF, SPEED_MAX_V5 };
  const api = { moverX, create, CONST, K, PATCHES: PATCHES_V5, PATCHES_V4, PATCHES_V3: PATCHES, TUTORIAL, ALL, TIER, tableFor, rowCount, tierAt, SCHEDULE, quantX, hash32, VERSION: RULES_VERSION };
  return api;
}
// ==== END RULES BLOCK ====

const CORE = galaxyRideCore();
const { K, CONST } = CORE;

// ── server-only bounds ──────────────────────────────────────────────────
const FPS = 120;
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
const MAX_SIM_STEPS = FPS * 60 * 60;
// The client cuts steering into batches of at most this many steps.
const PATH_BATCH_MAX = 120;
// One steering sample per step for the whole hour plus the jumps. REFUSES
// further inputs, never zeroes.
const MAX_INPUTS = MAX_SIM_STEPS + 60000;
// The steering target in 1/64 road units: quantX(3.9) * 64 rounds to 250.
const Q_MAX = Math.round(CONST.X_LIMIT * CONST.X_QUANT);

function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}
function isQ(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= -Q_MAX && v <= Q_MAX;
}

function simDead(sim) { return sim.s.state !== 'play'; }

// One fixed step with whatever is pending for it. The core only pushes
// cosmetic events; they are dropped here so an hour of play holds no list.
function stepOne(state) {
  const sim = state.sim;
  const inp = state.pending;
  state.pending = null;
  sim.step(inp || undefined);
  sim.s.events.length = 0;
  // Test-only observer (the parity suite compares the whole state per step).
  if (state.onStep) state.onStep(sim);
}

// Run every step BEFORE `step`, so inputs for `step` can still be collected.
function advanceTo(state, step) {
  const sim = state.sim;
  while (!simDead(sim) && sim.s.steps + 1 < step && sim.s.steps < MAX_SIM_STEPS) stepOne(state);
}

function pendingFor(state) {
  if (!state.pending) state.pending = {};
  return state.pending;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    version: null,
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    pending: null,
    lastSteerStep: 0,
    inputCount: 0,
    rejectCount: 0,
    score: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    // Raw material for the bot fingerprint, recorded and never gated.
    jumps: 0,
    jumpsWasted: 0,
    steerChanges: 0,
    steerTravel: 0,
    lastQ: 0,
  };
}

function reject(state, reason) {
  state.rejectCount++;
  return { accepted: true, newScore: state.score, reason };
}

function deadResult(state) {
  state.dead = true;
  state.score = state.sim.score();
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
    const v = payload.v;
    if ((v === 2 || v === 3 || v === 4 || v === 5) && state.mode !== 'sim') {
      state.mode = 'sim';
      state.version = v;
      state.sim = CORE.create({ seed: state.seed == null ? 0 : state.seed, version: v });
    }
    return { accepted: true, newScore: state.score };
  }
  // No start marker, no replay, no score.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  if (kind === 'path') return processPath(state, payload);
  if (kind === 'jump') return processJump(state, payload);
  return { accepted: true, newScore: state.score };
}

// { kind: 'jump', step }: the jump press lands on `step`.
function processJump(state, payload) {
  const step = payload.step;
  if (!isStep(step) || step < 1) return reject(state, 'bad_jump');
  const sim = state.sim;
  if (step < sim.s.steps + 1) return reject(state, 'frame_regressed');
  if (step > MAX_SIM_STEPS) return reject(state, 'bad_jump');
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  advanceTo(state, step);
  if (simDead(sim)) return deadResult(state);
  const p = pendingFor(state);
  if (p.jump) state.jumpsWasted++;
  p.jump = true;
  state.jumps++;
  state.score = sim.score();
  return { accepted: true, newScore: state.score };
}

// { kind: 'path', f, x: [...] }: x[i] is the steering target during step
// f+1+i. Validated whole before any of it is applied.
function processPath(state, payload) {
  const f = payload.f;
  const xs = payload.x;
  if (!isStep(f) || !Array.isArray(xs) || xs.length === 0 || xs.length > PATH_BATCH_MAX) {
    return reject(state, 'bad_batch');
  }
  const sim = state.sim;
  // Batches never overlap and never rewind: a rewind would let an attacker
  // re-run the same window and keep the best outcome.
  if (f + 1 < sim.s.steps + 1 || f + 1 <= state.lastSteerStep) return reject(state, 'frame_regressed');
  if (f + xs.length > MAX_SIM_STEPS) return reject(state, 'bad_batch');
  for (let i = 0; i < xs.length; i++) if (!isQ(xs[i])) return reject(state, 'bad_sample');
  if (state.inputCount + xs.length > MAX_INPUTS) return reject(state, 'input_cap');

  state.inputCount += xs.length;
  state.lastSteerStep = f + xs.length;
  for (let i = 0; i < xs.length; i++) {
    advanceTo(state, f + 1 + i);
    if (simDead(sim) || sim.s.steps >= MAX_SIM_STEPS) break;
    const q = xs[i];
    const p = pendingFor(state);
    if (p.x == null) {
      p.x = q / CONST.X_QUANT;
      if (q !== state.lastQ) { state.steerChanges++; state.steerTravel += Math.abs(q - state.lastQ); state.lastQ = q; }
    }
  }
  if (simDead(sim)) return deadResult(state);
  state.score = sim.score();
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
  // Run the world out past the last input with the steering target left where
  // the trace put it. The road always ends under a ship nobody steers (the
  // parity suite measures how soon), so every run ends by a rule the replay
  // models; the elapsed cap and the session bound stop the rest.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * FPS));
  const capSteps = elapsedCap(state, FPS);
  let guard = 0;
  while (!simDead(sim) && guard < runOutSteps && sim.s.steps < capSteps && sim.s.steps < MAX_SIM_STEPS) {
    stepOne(state);
    guard++;
  }
  const dead = simDead(sim);
  return {
    score: sim.score(),
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', version: state.version, steps: sim.s.steps,
      deathStep: dead ? sim.s.steps : null, deathCause: dead ? sim.s.deathCause : null,
      score: sim.score(), dead, inputs: state.inputCount, rejects: state.rejectCount,
      // Not gated. Raw material for the bot fingerprint.
      jumps: state.jumps, jumpsWasted: state.jumpsWasted,
      steerChanges: state.steerChanges, steerTravel: state.steerTravel,
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
  _sim: { CORE, galaxyRideCore, advanceTo, stepOne, isStep, isQ, elapsedCap, MAX_SIM_STEPS, PATH_BATCH_MAX, MAX_INPUTS, Q_MAX, FPS },
};
