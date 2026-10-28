'use strict';

/**
 * Sky Racer validator: SERVER-SIDE DETERMINISTIC REPLAY, and nothing else.
 *
 * Sky Racer is a partner's game (a plane steered by dragging, homing missiles,
 * points for time in the air, near misses, missiles made to crash into each
 * other and a FRENZY that lets the plane smash them). It arrived as a
 * standalone build and was converted to replay before it was ever integrated,
 * so there is no v1 path: a trace without a v2 or v3 start marker is not a run
 * and scores zero.
 *
 * Trace versions. v2 is the original rules on a 576 x 1152 view of the sky.
 * v3 (27 Sep 2026) widened the view to 748 x 1152 so a phone's whole width is
 * play: missiles spawn just outside that view, so its width IS a rule, and a
 * run is replayed on the width its start marker names. A v2 run that was in
 * progress when v3 deployed is therefore scored exactly as it was flown.
 * v4 (28 Sep 2026) keeps the v3 view and replaces the plane's PLANE_R circle
 * with its silhouette (PLANE_HIT circles turned with the heading) and each
 * missile's circle with a capsule (MISSILE_HIT). v2 and v3 keep the circle.
 * v5 (29 Sep 2026) arms a missile only after it has been on screen for half a
 * second in a row (ARM_SEEN_STEPS inside the fair window) instead of 39 steps
 * after its off-screen spawn, and widens the FRENZY ring from 90 to 115.
 * v6 (30 Sep 2026) makes what the player SEES what hits: each plane collides
 * as its own drawn art (PLANE_MASKS, every plane the same area) and each
 * missile as its drawn polygon, swept between steps; a missile that may not
 * hurt yet is held off on the HOLD_R ring instead of flying through; and in
 * FRENZY any touch smashes. The plane's id rides in the start marker.
 *
 * What the server does with a trace:
 *   1. applies the virtual stick on the fixed steps it landed on. The stick is
 *      where the player's drag has put the steering control, relative to the
 *      plane, in integer design units inside a disc of radius STICK_MAX. It
 *      travels as a dense positional batch { f, x: [...], y: [...] } where
 *      x[i], y[i] is the stick during step f+1+i; { kind: 'touch', step } and
 *      { kind: 'lift', step } say when the finger came down and left;
 *   2. walks the same fixed steps as the client: the plane turns toward the
 *      stick at a bounded rate and flies on, missiles are spawned from the
 *      session seed (missile N is a pure function of the seed, N and the state
 *      at the moment it spawns, with a fixed number of draws), they home in,
 *      collide with each other and with the plane;
 *   3. counts the score: two points a second in the air plus five points per
 *      unit earned (a near miss is one unit, a missile crash is two units
 *      times the chain, a missile smashed in FRENZY is one unit).
 *
 * The client's own number is never read. `require_claimed_match` in
 * submitSession is the gate that compares the two.
 *
 * The rules block below is carried WORD FOR WORD in games/sky-racer/js/game.js.
 * shared/tests/skyRacerParity.test.js pulls every constant and every rules
 * function out of both files and fails the moment one copy is edited without
 * the other, and pins the rules with golden runs so a change made in BOTH files
 * cannot pass either. A gameplay change is a trace version bump, never an edit
 * in place.
 *
 * The physics is floating point on purpose: it is the partner's feel. What
 * keeps it portable is the arithmetic. Only +, -, x, /, Math.sqrt, floor,
 * ceil, min, max and abs, every one of which IEEE 754 makes identical in every
 * engine, plus DMath's sin, cos and atan2 (shared/anticheat/dmath.js, an
 * fdlibm port that gives the same bits everywhere). The partner's
 * `1 - Math.exp(-dt * k)` smoothing became expNeg below, a fixed Taylor
 * polynomial, for the same reason.
 */

const DMath = require('../dmath');

// ==== RULES BLOCK: identical in games/sky-racer/js/game.js ====
const VIEW_W = 748;
const VIEW_W_V2 = 576;
const VIEW_H = 1152;
const CAM_Y = 0.55;
const PI = 3.141592653589793;
const TAU = 6.283185307179586;
const PLANE_R = 18.72;
const PLANE_BASE = 6.8;
const PLANE_RAMP = 0.018;
const PLANE_RAMP_CAP = 1.8;
const SPEED_MUL = 1.26;
const MISSILE_SPEED_SCALE = 0.94;
const START_INV_STEPS = 60;
const FRENZY_END_INV_STEPS = 75;
const STICK_MAX = 190;
const STICK_TRAVEL = 240;
const STICK_DEAD = 18;
const STICK_FULL = 160;
const TURN_RESPONSE = 9;
const TURN_RESPONSE_GAIN = 3;
const TURN_RATE = 4.2;
const TURN_RATE_GAIN = 2.2;
const TURN_SLOW = 0.22;
const FRENZY_BOOST = 0.3;
const FRENZY_ZOOM = 0.2;
const FRENZY_RADIUS = 90;
// v5 (29 Sep 2026): the FRENZY ring is 115, not 90, a 28% larger radius and
// 63% more area to hold a missile in. The ring on screen is drawn at the same
// radius, so what the player sees is what charges.
const FRENZY_RADIUS_V5 = 115;
const FRENZY_CHARGE_STEPS = 120;
const FRENZY_COOLDOWN_STEPS = 9;
const FRENZY_MIN_STEPS = 300;
const FRENZY_SPAN_STEPS = 120;
const FRENZY_MAX_MISSILES = 12;
const FRENZY_GAP_MIN = 12;
const FRENZY_GAP_SPAN = 5;
const FRENZY_END_SPAWN_HOLD = 33;
const TRAIL_LEN = 15;
const TRAIL_LEN_FRENZY = 46;
const TRAIL_HIT_PAD = 9;
const FIRST_SPAWN_STEPS = 11;
const FIRST_WAVE_STEPS = 600;
const WAVE_EVERY_MIN = 720;
const WAVE_EVERY_SPAN = 240;
const WAVE_RETRY_STEPS = 84;
const WAVE_GAP_STEPS = 23;
const COMBO_STEPS = 129;
const COMBO_MAX = 4;
const NEAR_R = 55;
const NEAR_RESET_R = 90;
const ARM_LIFE_STEPS = 39;
// v5: a missile can only hurt the plane after it has been ON SCREEN for
// ARM_SEEN_STEPS steps in a row (half a second). ARM_LIFE_STEPS counted from
// the spawn, which is always 225+ units OFF screen, so it protected nothing: a
// missile crossing the narrow side of the view at a closing speed near 19
// units a step was on screen for 18 steps (0.3 s) before it hit. The fair
// window is the part of the view every device shows, in camera units scaled
// by the zoom: 340 either side of the plane (748 / 1.1 / 2) and the full 1152
// down, less FAIR_INSET, where a faded edge is still under half opacity.
const ARM_SEEN_STEPS = 30;
const FAIR_HALF_W = 340;
const FAIR_INSET = 50;
const SPAWN_ATTEMPTS = 16;
const SPAWN_MARGIN = 52;
const DESPAWN_VIEWS = 2.4;
const STEPS_PER_POINT = 30;
const POINTS_PER_UNIT = 5;
const MISSILE_SALT = 0x5A17C3E9;
const WAVE_SALT = 0x1D8F4B27;
const FRENZY_SALT = 0x6E2A90D3;
const RNG_STRIDE = 0x9E3779B1;
const K_AV = 1 - expNeg(12 / 60);
const K_FV_IN = 1 - expNeg(8 / 60);
const K_FV_OUT = 1 - expNeg(3.8 / 60);
const K_PRESSURE = 2.3 / 60;

// hunter, dart, viper, titan: [speed ratio, catch-up, turn rate, lead, accel, radius]
const MISSILES = [
  [0.995, 0.12, 2.12, 0.38, 6.2, 3.7],
  [1.025, 0.075, 1.84, 0.24, 7.1, 2.85],
  [0.965, 0.13, 2.48, 0.42, 5.9, 3.15],
  [0.93, 0.18, 1.68, 0.5, 4.8, 4.9],
];
const SECTORS = [PI - 0.7, PI + 0.7, PI - 1.38, PI + 1.38];
const LANES = [-1, -0.66, -0.33, 0.33, 0.66, 1];
// v4 (28 Sep 2026): the plane collides as its silhouette, not a circle.
// PLANE_HIT is the jet as circles [forward, across, radius] in world units,
// turned with the heading; all three jets share it, so the choice of jet never
// changes a run. MISSILE_HIT[kind] is each missile as a capsule along its own
// heading, [nose, tail, radius]. PLANE_HIT_REACH bounds the two together, so a
// missile further than that from the plane's centre cannot touch it. v2 and v3
// keep the PLANE_R circle.
const PLANE_HIT = [
  [33.17, 0, 2.76], [27.64, 0, 4.61], [16.59, 0, 6.91], [-35.02, 0, 5.99],
  [1.84, 1.84, 8.29], [-7.37, 5.53, 8.29], [-9.21, 9.21, 8.29], [-18.43, 5.53, 7.83], [-16.59, 20.27, 8.29], [-29.49, 5.53, 8.29], [-33.17, 12.9, 5.07],
  [1.84, -1.84, 8.29], [-7.37, -5.53, 8.29], [-9.21, -9.21, 8.29], [-18.43, -5.53, 7.83], [-16.59, -20.27, 8.29], [-29.49, -5.53, 8.29], [-33.17, -12.9, 5.07],
];
const MISSILE_HIT = [
  [3.7, 4.6, 2.6],
  [6, 6, 1.8],
  [3.2, 4.2, 3.2],
  [3.4, 4.7, 4],
];
const PLANE_HIT_REACH = 50;
const DEATH_CAUSES = ['none', 'missile'];

// v6 (30 Sep 2026): WHAT YOU SEE IS WHAT HITS. Players saw missiles pass
// clean through the plane, for two reasons, and v6 removes both.
//   1. A v5 missile was harmless until it had been on screen for half a
//      second, so one that crossed the plane sooner flew THROUGH it. A v6
//      missile that is not yet armed (or meets the plane while it is shielded)
//      cannot come nearer than HOLD_R: it is stopped on that ring, where it
//      is plainly outside the plane. A missile can still never hit before it
//      has been on screen for ARM_SEEN_STEPS in a row.
//   2. The collider was one jet silhouette for fourteen different drawings,
//      reaching up to 18 units past some and short of others. The plane now
//      collides as its OWN art: PLANE_MASKS is each plane's alpha on a grid of
//      one world unit (shared/tests/lib/skyRacerPlaneMasks.js makes it from
//      the webp), drawn at PLANE_K world units per pixel, a scale chosen so
//      every grid holds 2600 cells to within half a percent: no plane is
//      bigger to a missile than another. The missile collides as the polygon
//      it is drawn with (MISSILE_POLY at MISSILE_DRAW_SCALE, sampled every
//      MISSILE_SAMPLE). The plane's choice travels in the start marker.
//      The test is SWEPT from the last step to this one in steps of at most
//      SWEEP_STEP, the way the screen interpolates, so nothing tunnels.
const PLANE_IDS = ['stunt', 'bomber', 'twin', 'cruiser', 'sparrow', 'viper', 'falcon', 'raptor', 'phantom', 'desert', 'angel', 'typhoon', 'camo', 'arrow'];
const PLANE_K = [0.4449, 0.4469, 0.4398, 0.443, 0.4625, 0.4341, 0.4217, 0.3942, 0.475, 0.4104, 0.407, 0.4183, 0.3817, 0.4387];
const PLANE_MASKS = [
  [88, 78, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAA8AAAAAAAAAAAAAHwAAAAAAAAAAB/8fj/4AAAAAAAAf/////4AAAAAAAB//////AAAAAAAAB/////wAAAAAAAAAAP/+AAAAAAAAAAAB//AAAAAAAAAAAAH/+AAAAAAAAAAAAf/4AAAAAAAAAAAD//gAAAAAAAAAAAf//AAAAAAAAAAAB//+AAAAAAAAAAAH//4AAAAAAAAAAAf//gAAAAAAAAAAB//+AAAAAAAAAAAP//4AAAAAAAAAAA///gAAAAAAAAAAD//+AAAAAAAAAAAH//4AAAAAAAAAAAf//gAAAAAAAAAAD///AAAAAAAAAAP////8AAAAAAAB///////8AAAAAH/////////gAAAH//////////+AAP////////////AD/////////////Af////////////+D/////////////8P/////////////w//////////////D/////////////8P/////////////w//////////////B/////////////4H/////////////gP////////////8Af////////////AAP///////////wAAD//////////wAAAAP////////AAAAAAD///////AAAAAAAAf////+AAAAAAAAAD///8AAAAAAAAAAAf/4AAAAAAAAAAAB//gAAAAAAAAAAAH/+AAAAAAAAAAAAf/wAAAAAAAAAAAA//AAAAAAAAAAAAD/8AAAAAAAAAAAAP/wAAAAAAAAAAAA//AAAAAAAAAAAAD/4AAAAAAAAAAAAH/gAAAAAAAAAAAH//4AAAAAAAAAAH///+AAAAAAAAAD/////AAAAAAAAA//////AAAAAAAAH/////+AAAAAAAA//////8AAAAAAAH//////wAAAAAAAf//////gAAAAAAB//////+AAAAAAAH//////wAAAAAAAP//////AAAAAAAAf/////4AAAAAAAAP////8AAAAAAAAAAffPwAAAAAAAAAAAA8AAAAAAAAAAAAADwAAAAAAAAAAAAAOAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [88, 74, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAAAAAAAAAAH4AAAAAAAAAAAAA/wAAAAAAAAAAAAH/AAAAAAAAAAAAAf+AAAAAAAAAAAAB/4AAAAAAAAAAAAP/gAAAAAAAAAAAA//AAAAAAAAAAAAD/8AAAAAAAAAAAAP/wAAAAAAAAAAIB//gEAAAAAAAABwH/+A4AAAAAAAAPAf/4HgAAAAAAAD/h//h/wAAAAAAAH8H/+D+AAAAAA4A/wf/4P4AYAAADwD/h//h/wDwAAAPAP+P/+H/AfgAAH/A/4//4f8D/gAAP4D//////wP8AAA/wP//////A/wAAH/A//////8H/gAAf8////////f+AAB///////////4AAH///////////gAAf//////////+AAP////////////AD/////////////Af////////////+D/////////////4P/////////////w//////////////D/////////////8P/////////////w//////////////B/////////////4H/////////////gH////////////4AD///////////4AAAP/////////wAAAAAf//////8AAAAAAAAD///4AAAAAAAAAAAf/4AAAAAAAAAAAB//gAAAAAAAAAAAH/+AAAAAAAAAAAAf/4AAAAAAAAAAAB//gAAAAAAAAAAAH/8AAAAAAAAAAAAP/wAAAAAAAAAAAA//AAAAAAAAAAAAD/8AAAAAAAAAAAA//8AAAAAAAAAAAf//+AAAAAAAAAAH///+AAAAAAAAAD/////AAAAAAAAA//////AAAAAAAAP//////AAAAAAAA//////8AAAAAAAH//////4AAAAAAAf//////gAAAAAAB//////+AAAAAAAD//////wAAAAAAAH/////+AAAAAAAAD////+AAAAAAAAAAAP8AAAAAAAAAAAAAfgAAAAAAAAAAAAB+AAAAAAAAAAAAADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [88, 76, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAA8AAAAAAAAAAAAAH4AAAAAAAAAAAAA/wAAAAAAAAAAAAD/AAAAAAAAAAAAAf+AAAAAAAAAAAAB/4AAAAAAAAAAAAP/wAAAAAAAAAAAA//AAAAAAAAAAAAD/8AAAAAAAAAAAAf/wAAAAAAAAAAAB//gAAAAAAAAAAAH/+AAAAAAAAAAAA//4AAAAAAAAAAAD//wAAAAAAAAAAAP//AAAAAAAAAA4A//8AYAAAAAAAHwD//wDwAAAAAAAfAP//APgAAAAAA//w//8f/4AAAAAH//z//z//4AAAAAf//P//P//AAAAAAH/A//8D/gAAAAAAf8D//wP+AAAAAAB/wf//A/4AAAAAAH///////gAAAAAAf//////+AAAAAAf////////gAAAB//////////+AAB////////////gA/////////////gD/////////////Af////////////+B/////////////4H/////////////gf////////////+B/////////////4H/////////////gf////////////+B/////////////wD////////////+AD////////////wAAf//////////gAAAD/////////AAAAAAB//////gAAAAAAAAD///+AAAAAAAAAAA//8AAAAAAAAAAAD//wAAAAAAAAAAAP//AAAAAAAAAAAA//8AAAAAAAAAAAD//wAAAAAAAAAAAP//AAAAAAAAAAAA//8AAAAAAAAAAAD//wAAAAAAAAAAB///wAAAAAAAAAAf///4AAAAAAAAAH////4AAAAAAAAD/////8AAAAAAAA//////8AAAAAAAP//////8AAAAAAA///////wAAAAAAH///////gAAAAAAf//////+AAAAAAB///////4AAAAAAH///////gAAAAAAP//////8AAAAAAAf//////gAAAAAAAAAH/gAAAAAAAAAAAAP8AAAAAAAAAAAAAfgAAAAAAAAAAAAB+AAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [88, 76, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAHgAAAAAAAAH/g8H/wAAAAAAAB//37//gAAAAAAAD/////8AAAAAAAAH/////gAAAAAAAAH////4AAAAAAAAAAB/8AAAAAAAAAAAAP/wAAAAAAAAAAAB//gAAAAAAAAAAAH//AAAAAAAAAAAA//+AAAAAAAAAAAH//4AAAAAAAAAAAf//gAAAAAAAAAAB///AAAAAAAAAAAH//8AAAAAAAAAAAf//wAAAAAAAAAAB///AAAAAAAAAAAH//8AAAAAAAAAAAf//wAAAAAAAAAAB//+AAAAAAAAAAAP//+AAAAAAAAAB/////4AAAAAAAH///////wAAAAB//////////wAAD///////////8AB////////////+AP////////////8B/////////////4H/////////////w//////////////D/////////////8P/////////////w//////////////B/////////////8H/////////////gP////////////+Af////////////wA////////////8AA////////////AAAP//////////AAAAD/////////AAAAAA////////AAAAAAAP//////AAAAAAAAB////+AAAAAAAAAAP//8AAAAAAAAAAAH/+AAAAAAAAAAAAf/4AAAAAAAAAAAB//gAAAAAAAAAAAD/+AAAAAAAAAAAAP/wAAAAAAAAAAAA//AAAAAAAAAAAAD/8AAAAAAAAAAAAP/wAAAAAAAAAAAD//4AAAAAAAAAAD///8AAAAAAAAAB////+AAAAAAAAAP////8AAAAAAAAD/////8AAAAAAAAP/////wAAAAAAAB//////gAAAAAAAH/////+AAAAAAAAf/////4AAAAAAAB//////gAAAAAAAD/////8AAAAAAAAH/////gAAAAAAAAP////8AAAAAAAAAD/vP8AAAAAAAAAAAA8AAAAAAAAAAAAADwAAAAAAAAAAAAAPAAAAAAAAAAAAAAYAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [92, 78, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAPAAAAAAAAAAAAAAH4AAAAAAAAAAAAAD+AAAAAAAAAAAAAA/wAAAAAAAAAAAAAf8AAAAAAAAAAAAAH/gAAAAAAAAAAAAD/4AAAAAAAAAAAAA//AAAAAAAAAAAAAP/wAAAAAAAAAAAAH/8AAAAAAAAAAAAB//gAAAAAAAAAAAA//4AAAAAAAAAAAAP/+AAAAAAAAAAAAD//wAAAAAAAAAAAA//8AAAAAAAAAAAAP//AAAAAAAAAAAAD//wAAAAAAAAAAAB//8AAAAAAAAAAAAf//AAAAAAAAAAAAH//wAAAAAAAAAAAB//+AAAAAAAAAAAf////gAAAAAAAB////////gAAAAAf/////////8AAAH////////////AAf////////////+AP/////////////wH/////////////+B//////////////g//////////////8P//////////////D//////////////w//////////////8P/////////////+B//////////////gf/////////////4D/////////////8Af////////////8AAP///////////gAAAP/////////+AAAAAD////////gAAAAAAA//////8AAAAAAAAAP////AAAAAAAAAAAD//4AAAAAAAAAAAA//4AAAAAAAAAAAAP/+AAAAAAAAAAAAB//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH/+AAAAAAAAAAAAB//AAAAAAAAAAAAAf/wAAAAAAAAAAAAD/8AAAAAAAAAAAAA//AAAAAAAAAAAAAP/wAAAAAAAAAAAA///wAAAAAAAAAAH////4AAAAAAAAA//////8AAAAAAAAf//////AAAAAAAAP//////4AAAAAAAD///////AAAAAAAA///////wAAAAAAAP//////8AAAAAAAD///////AAAAAAAA///////wAAAAAAAP//////8AAAAAAAD//////+AAAAAAAAf//////AAAAAAAAB//////gAAAAAAAAAA/94AAAAAAAAAAAAAfAAAAAAAAAAAAAADwAAAAAAAAAAAAAA8AAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [82, 86, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAADAAAAAAAAAAAAAeAAAAAAAAAAAAB4AAAAAAAAAAAAPwAAAAAAAAAAAA/AAAAAAAAAAAAH8AAAAAAAAAAAAf4AAAAAAAAAAAB/gAAAAAAAAAAAP+AAAAAAAAAAAA/8AAAAAAAAAAAD/wAAAAAAAAAAAf/AAAAAAAAAAAB/+AAAAAAAAAAAH/4AAAAAAAAAAAf/gAAAAAAAAAAB/+AAAAAAAAAAAP/8AAAAAAAAAAAf/gAAAAAAAAAAB/+AAAAAAAAAAAP/8AAAAAAAAAAA//wAAAAAAAAAAD//AAAAAAAAAAAP/8AAAAAAAAAAA//wAAAAAAAAAAD//AAAAAAAAAAAP/+AAAAAAAAAAB//4AAAAAAAAAAf//4AAAAAAAAAD///wAAAAAAAAAP///gAAAAAAAAB///+AAAAAAAAAH///4AAAAAAAAAf///gAAAAAAAAB///+AAAAAAAAAP///8AAAAAAAAB////4AAAAAAAAf////4AAAAAAAD/////wAAAAAAA//////wAAAAAAH//////gAAAAAA///////gAAAAAP///////AAAAAD////////AAAIAf///////+AGBwH////////+A4PA/////////8Dw+H/////////8PD5//////////48Pv//////////7w/////////////D////////////8P////////////w/////////////D////////////8P////////////w/////////////D////////////8P////////////w/////////////D4AAAD//8AAAA8PgAAAP//wAAADwcAAAB///gAAAPAgAAAP///AAAAYAAAAB///+AAAAAAAAAP///8AAAAAAAAB////4AAAAAAAAP////wAAAAAAAB/////wAAAAAAAf/////gAAAAAAD//////AAAAAAAf/////+AAAAAAB//////4AAAAAAH//////gAAAAAAf/////+AAAAAAB//f/v/4AAAAAAH/9/+//gAAAAAAf/n/5/+AAAAAAAwAf/gAwAAAAAAAAB/8AAAAAAAAAAAD/wAAAAAAAAAAAH8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [82, 84, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAeAAAAAAAAAAAAB4AAAAAAAAAAAAPgAAAAAAAAAAAA/AAAAAAAAAAAAH8AAAAAAAAAAAAfwAAAAAAAAAAAB/gAAAAAAAAAAAH+AAAAAAAAAAAA/4AAAAAAAAAAAD/gAAAAAAAAAAAP/AAAAAAAAAAAA/8AAAAAAAAAAAH/wAAAAAAAAAAAf/AAAAAAAAAAAB/8AAAAAAAAAAAH/4AAAAAAAAAAAf/gAAAAAAAAAAB/+AAAAAAAAAAAP/8AAAAAAAAAAD//4AAAAAAAAAAP//wAAAAAAAAAA///AAAAAAAAAAD//8AAAAAAAAAAP//wAAAAAAAAAA///AAAAAAAAAAD//8AAAAAAAAAA///4AAAAAAAAAH///4AAAAAAAAA////wAAAAAAAAH////gAAAAAAAB/////AAAAAAAAH////+AAAAAAAB/////+AAAAAAAP/////8AAAAAAB//////wAAAAAAH//////gAAAAAAP3///78AAAAAAAA////wAAAAAAAAP////wAAAAAAAD/////gAAAAAAAf/////gAAAAAAH//////gAAAAAA///////AAAAAAP///////AAACAD////////ABAcAf///////+AOBwH////////8B4Hh/////////8HgeP/////////8eB7//////////54H////////////gf///////////+B////////////4H////////////gf///////////+B////////////4H////////////gf///////////+B////////////4H////////////gf///////////+B4AAA////4AAB4HAAAD////AAADgAAAAf///+AAAAAAAAD////8AAAAAAAAf////4AAAAAAAH/////wAAAAAAAf/////gAAAAAAD//////AAAAAAAP/////8AAAAAAA//f///wAAAAAAD/9/+//AAAAAAAP/3/z/8AAAAAAAf4f/D/gAAAAAAAAA/8AAAAAAAAAAAD/wAAAAAAAAAAAP/AAAAAAAAAAAAPwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [76, 78, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAA4AAAAAAAAAAADwAAAAAAAAAAAfAAAAAAAAAAAB+AAAAAAAAAAAH4AAAAAAAAAAA/wAAAAAAAAAAD/AAAAAAAAAAAf8AAAAAAAAAAB/4AAAAAAAAAAH/gAAAAAAAAAAf+AAAAAAAAAAD/4AAAAAAAAAAP/wAAAAAAAAAA//AAAAAAAAAAD/8AAAAAAAAAAP/wAAAAAAAAAB//gAAAAAAAAAH/+AAAAAAAAAAf/4AAAAAAAAAD//wAAAAAAAAAf//gAAAAAAAAH///gAAAAAAAA////AAAAAAAAH///8AAAAAAAAf///4AAAAAAAB////gAAAAAAAH///+AAAAAAAAf///4AAAAAAAD////wAAAAAAAf////gAAAAAAD/////AAAAAAA//////AAAAAAH/////+AAAAAA//////8AAAAAP//////8AAAAB///////4AAAAP///////wAAAD////////wAAAf////////gAAD/////////AAAf////////+AAH/////////+AA//////////8AP//////////4B///////////4P///////////w////////////D///////////8P///////////w////////////D///////////8H///////////wf//////////8Af//////////gAf/////////4AAf////////+AAAP////////AAAAP///////wAAAAP//////4AAAAAH/////+AAAAAA//////8AAAAAH//////4AAAAA///////wAAAAH///////gAAAA////////AAAAD///////8AAAAP//P/z//wAAAA//4+fP//AAAAD//BwwP/8AAAAH/4AAAf/gAAAAH+AAAA/4AAAAAPwAAAA/AAAAAAOAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [94, 60, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAHgAAAAAAAAAAAAAB/gAAAAAAAAAAAAAP/AAAAAAAAAAAAAD/+AAAAAAAAAAAAAf/8AAAAAAAAAAAAD//8AAAAAAAAAAAA///8AAAAAAAAAAAH///4AAAAAAAAAAA////wAAAAAAAAAAH////gAAAAAAAAAB/////gAAAAAAAAAP/////AAAAAAAAAD/////+AAAAAAAAAf/////+AAAAAAAAD//////8AAAAAAAA///////4AAAAAAAH///////4AAAAAAA////////wAAAAAAP////////gAAAAAB/////////gAAAAAf/////////AAAAAD/////////+AAAAAf/////////8AAAAH//////////8AAAA///////////4AAAH///////////4AAB////////////wAAP////////////gAB/////////////gAP////////////+AD/////////////+Af/////////////8D//////////////8P//////////////wP/////////////+Af/////////////wA/////////////+AB/////////////gAD////////////+AAD/H////////n/gAAH4P///////+H8AAAPAf///////gPgAAAYA///////8AcAAAAAB///////gAgAAAAAB//////8AAAAAAAAD//////gAAAAAAAAH/////4AAAAAAAAAP/////AAAAAAAAAAf3//P4AAAAAAAAAA+P/4fAAAAAAAAAAAgP/A4AAAAAAAAAAAAf4AAAAAAAAAAAAAA/AAAAAAAAAAAAAAB4AAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [82, 82, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAeAAAAAAAAAAAAB4AAAAAAAAAAAAPwAAAAAAAAAAAA/AAAAAAAAAAAAD8AAAAAAAAAAAAf4AAAAAAAAAAAB/gAAAAAAAAAAAH+AAAAAAAAAAAA/4AAAAAAAAAAAD/wAAAAAAAAAAAP/AAAAAAAAAAAA/8AAAAAAAAAAAH/wAAAAAAAAAAAf/gAAAAAAAAAAB/+AAAAAAAAAAAH/4AAAAAAAAAAA//gAAAAAAAAAAH//gAAAAAAAAAA///AAAAAAAAAAP//+AAAAAAAAAB///+AAAAAAAAAP///8AAAAAAAAD////4AAAAAAAAf////4AAAAAAAD/////wAAAAAAAf/////AAAAAAAB/////+AAAAAAAD/////wAAAAAAAAH//8AAAAAAAAAA///4AAAAAAAAAH///4AAAAAAAAA////wAAAAAAAAH////gAAAAAAAA/////AAAAAAAAH////+AAAAAAAA/////8AAAAAAAH/////4AAAAAAA//////wAAAAAAH//////gAAAAAB///////gAAAAAP//////+AAAAAB///////+AAAAAP///////8AAAAB////////4AABAP////////wCAOD/////////gcA4f/////////BwHz//////////PAff/////////+8B////////////4H////////////gf///////////+B////////////4H////////////gf///////////+B////////////4H////////////gf///////////+B////////////4H////////////ge//////////8eB4A////////gB4HAAP//////gADAAAAAf///8AAAAAAAAAP///AAAAAAAAAA///8AAAAAAAAAD///wAAAAAAAAAP///AAAAAAAAAA///8AAAAAAAAAD///wAAAAAAAAAA//wAAAAAAAAAAD//AAAAAAAAAAAP/8AAAAAAAAAAA//gAAAAAAAAAAB/+AAAAAAAAAAADzwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [80, 82, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAADwAAAAAAAAAAAA8AAAAAAAAAAAAfAAAAAAAAAAAAH4AAAAAAAAAAAD+AAAAAAAAAAAA/wAAAAAAAAAAAP8AAAAAAAAAAAD/AAAAAAAAAAAB/4AAAAAAAAAAAf+AAAAAAAAAAAH/gAAAAAAAAAAD/4AAAAAAAAAAA/+AAAAAAAAAAAP/wAAAAAAAAAAD/8AAAAAAAAAAA//AAAAAAAAAAAP/wAAAAAAAAAAH/8AAAAAAAAAAH//4AAAAAAAAAB//+AAAAAAAAAA///wAAAAAAAAAP//8AAAAAAAAAH///gAAAAAAAAB///4AAAAAAAAAf//+AAAAAAAAAH///gAAAAAAAAD///8AAAAAAAAA////AAAAAAAAAf///4AAAAAAAAH///+AAAAAAAAD////4AAAAAAAD/////AAAAAAAD/////8AAAAAAB//////gAAAAAB//////+AAAAAA///////wAAAwA////////ABAcAf///////4A4Hgf////////geB4P////////8HgeP/////////x4Hn//////////eB////////////w////////////8P////////////D////////////w////////////8P////////////D////////////w////////////8P////////////D////////////w////////////8PgAAP///+AAAfDwAAA///+AAADwcAAAP///wAAA4AAAAH///+AAAAAAAAD////wAAAAAAAB////+AAAAAAAA/////wAAAAAAAf////+AAAAAAAP/////wAAAAAAH/////+AAAAAAH//////4AAAAAD//f///+AAAAAB//3/+//4AAAAA//9//v//AAAAAP//f/7//wAAAAH//n/+f/8AAAAB//B//A//AAAAAf/Af/wD/wAAAAH/AH/8AP8AAAAA/AB//AA/AAAAAGAAP/wADgAAAAAAAD/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [82, 84, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAeAAAAAAAAAAAAB4AAAAAAAAAAAAPwAAAAAAAAAAAA/AAAAAAAAAAAAD+AAAAAAAAAAAAf4AAAAAAAAAAAB/gAAAAAAAAAAAP/AAAAAAAAAAAA/8AAAAAAAAAAAD/wAAAAAAAAAAAP/AAAAAAAAAAAA/8AAAAAAAAAAAH/4AAAAAAAAAAAf/gAAAAAAAAAAD//AAAAAAAAAAAf/+AAAAAAAAAAD//8AAAAAAAAAA///8AAAAAAAAAH///4AAAAAAAAA////wAAAAAAAAH////gAAAAAAAA/////AAAAAAAAD////8AAAAAAAAP////wAAAAAAAAcP/8OAAAAAAAAAB//8AAAAAAAAAAP//wAAAAAAAAAA///gAAAAAAAAAH//+AAAAAAAAAAf//4AAAAAAAAAD///wAAAAAAAAAf///gAAAAAAAAD////AAAAAAAAAf///+AAAAAAAAD////8AAAAAAAAf////8AAAAAAAD/////4AAAAAAAf/////wAAAAAAD//////gAAAAAAf//////AAAAAAH//////+AAAAAA///////8AAAAAH///////4AAAAA////////wAAAAH////////gAABA/////////AQAOH////////+DAB4/////////8eAHn/////////54Ae//////////3wD////////////AP///////////8A////////////wD////////////gf///////////+B////////////4H////////////gf////////////D////////////8P////////////w/////////////D///////////98PAD////////ADw8AAP/////8AAHAAAAAH///AAAAAAAAAAf//4AAAAAAAAAB///gAAAAAAAAAH//+AAAAAAAAAAf//4AAAAAAAAAB///gAAAAAAAAAD//8AAAAAAAAAAP//wAAAAAAAAAAf//AAAAAAAAAAB//8AAAAAAAAAAH//gAAAAAAAAAAf7+AAAAAAAAAAB/P4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [76, 74, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAYAAAAAAAAAAADwAAAAAAAAAAAfgAAAAAAAAAAB+AAAAAAAAAAAP8AAAAAAAAAAA/wAAAAAAAAAAD/AAAAAAAAAAAf+AAAAAAAAAAB/4AAAAAAAAAAP/gAAAAAAAAAA//AAAAAAAAAAD/8AAAAAAAAAAf/4AAAAAAAAAB//gAAAAAAAAAH/+AAAAAAAAAAf/4AAAAAAAAAD//wAAAAAAAAAf//gAAAAAAAAD///AAAAAAAAAf//+AAAAAAAAH///+AAAAAAAAf///4AAAAAAAD////wAAAAAAAP////AAAAAAAA////8AAAAAAAD////4AAAAAAAf////gAAAAAAD/////AAAAAAA//////AAAAAAH/////+AAAAAA//////8AAAAAH//////8AAAAB///////4AAAAP///////wAAAB////////gAAAP////////AAAB////////+AAAf////////+AAD/////////8AAf/////////4AD//////////4A///////////wH///////////g////////////D///////////8P///////////w////////////D///////////8P///////////wf//////////+Af//////////gAf/////////4AAf/////////AAA/////////wAAA////////8AAAA////////AAAAB///////4AAAAP///////wAAAB////////gAAAH///////+AAAAf///////4AAAB////////gAAAH///////+AAAAf///////4AAAA//P378//AAAAA/8/fnz/wAAAAA/gA8AH8AAAAAA8ABgAPAAAAAAAwAGAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  [84, 88, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAADgAAAAAAAAAAAADwAAAAAAAAAAAAHwAAAAAAAAAAAAHwAAAAAAAAAAAAH4AAAAAAAAAAAAH4AAAAAAAAAAAAP4AAAAAAAAAAAAP8AAAAAAAAAAAAf8AAAAAAAAAAAAf8AAAAAAAAAAAAf8AAAAAAAAAAAAf+AAAAAAAAAAAA/+AAAAAAAAAAAA/+AAAAAAAAAAAA//AAAAAAAAAAAA//AAAAAAAAAAAA//AAAAAAAAAAAA//AAAAAAAAAAAB//AAAAAAAAAAAD//wAAAAAAAAAAH//4AAAAAAAAAAH//4AAAAAAAAAAH//4AAAAAAAAAAP//4AAAAAAAAAAP//4AAAAAAAAAAP//8AAAAAAAAAAf//8AAAAAAAAAAf//+AAAAAAAAAA////AAAAAAAAAB////gAAAAAAAAD////wAAAAAAAAH////4AAAAAAAAP////8AAAAAAAAf////+AAAAAAAA//////AAAAAAAB//////gAAAAAAD//////wAAAAAAH//////4AAAAAAH//////4AAAAAAP//////8AAAAAAf//////+AAAAAA////////AAAAAB////////gAAAAD////////wAAAAH////////4AAAAP////////8AAAAf////////+AAAA//////////AAAB//////////gAAD//////////wABn//////////4gDv///////////wD////////////wD////////////wH////////////4H////////////4H////////////4H////////////4H////////////4H////////////8P////////////8P////////////8PD//////////w8HAA////////AA4AAAAD////wAAAAAAAAAD//wAAAAAAAAAAD//wAAAAAAAAAAD//wAAAAAAAAAAD//wAAAAAAAAAAD//wAAAAAAAAAAD//wAAAAAAAAAAB//wAAAAAAAAAAB//wAAAAAAAAAAB//gAAAAAAAAAAA//AAAAAAAAAAAA//AAAAAAAAAAAA//AAAAAAAAAAAA//AAAAAAAAAAAA//AAAAAAAAAAAAf/AAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
];
const MASK_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MISSILE_DRAW_SCALE = 0.46;
const MISSILE_POLY = [
  [[13, 0], [6, -5], [-10, -5], [-15, -10], [-14, 0], [-15, 10], [-10, 5], [6, 5]],
  [[17, 0], [5, -3], [-12, -3], [-17, -7], [-15, 0], [-17, 7], [-12, 3], [5, 3]],
  [[14, 0], [11.6563, -1.6094], [9.125, -2.9375], [6.4063, -3.9844], [3.5, -4.75], [0.4063, -5.2344], [-2.875, -5.4375], [-6.3437, -5.3594], [-10, -5], [-16, -11], [-14, 0], [-16, 11], [-10, 5], [-6.3437, 5.3594], [-2.875, 5.4375], [0.4063, 5.2344], [3.5, 4.75], [6.4063, 3.9844], [9.125, 2.9375], [11.6563, 1.6094]],
  [[16, 0], [8, -8], [-12, -8], [-19, -14], [-17, 0], [-19, 14], [-12, 8], [8, 8]],
];
const MISSILE_SAMPLE = 1.5;
const HOLD_R = 61;
const SWEEP_STEP = 1;
const SWEEP_MAX = 48;
const PLANE_GRIDS = PLANE_MASKS.map(unpackMask);
const PLANE_REACH = PLANE_GRIDS.map(gridReach);
const MISSILE_PTS = MISSILE_POLY.map(missilePoints);
const MISSILE_REACH = MISSILE_PTS.map(pointsReach);

// e^-x as its Taylor series in Horner form, for 0 <= x <= 0.25. Only + and x,
// so every engine gets the same bits; Math.exp does not promise that.
function expNeg(x) {
  let s = 1;
  for (let k = 12; k >= 1; k--) s = 1 - (x / k) * s;
  return s;
}

// Any angle into [-PI, PI).
function wrapAngle(a) {
  return a - TAU * Math.floor((a + PI) / TAU);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function segRng(seedInt, salt, index) {
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

// The difficulty ramp, by seconds in the air: easy until 14 s, medium until
// 36 s, then hard, which levels off a little over a minute in.
function difficultyAt(el) {
  if (el < 14) {
    return { key: 0, interval: Math.max(0.76, 0.96 - el * 0.014), max: el < 5 ? 3 : (el < 10 ? 4 : 5),
      boost: 0.02 + el * 0.0008, turn: 0.94 + el * 0.004 };
  }
  if (el < 36) {
    const t = el - 14;
    return { key: 1, interval: Math.max(0.56, 0.68 - t * 0.006), max: 6 + Math.min(2, Math.floor(t / 9)),
      boost: 0.035 + t * 0.0007, turn: 1 + t * 0.0018 };
  }
  const t = el - 36;
  return { key: 2, interval: Math.max(0.36, 0.5 - t * 0.0035), max: Math.min(11, 8 + Math.floor(t / 9)),
    boost: Math.min(0.085, 0.052 + t * 0.0005), turn: Math.min(1.16, 1.04 + t * 0.0012) };
}

// Seconds between spawns, stretched while the sky is busy and shortened while
// it is quiet, as whole steps.
function spawnSteps(sim, seconds) {
  const p = sim.pressure;
  const mul = p > 0.7 ? 1.24 : (p > 0.48 ? 1.1 : (p < 0.24 ? 0.88 : 1));
  return Math.ceil(seconds * mul * 60);
}

function cruiseSpeed(sim) {
  return (PLANE_BASE + Math.min(PLANE_RAMP_CAP, (sim.step / 60) * PLANE_RAMP)) * SPEED_MUL;
}

// ONE expression for the score. The HUD, the popups and the submit read it.
function scoreOf(sim) {
  return Math.floor(sim.step / STEPS_PER_POINT) + sim.earned * POINTS_PER_UNIT;
}

// The width of the sky the rules know. v3 widened it from 576 to 748 (the
// height, and so every warning above and below the plane, is unchanged) so a
// phone's whole width is play. A v2 trace keeps the width it was flown on.
function viewWidthFor(version) {
  return version >= 3 ? VIEW_W : VIEW_W_V2;
}

// The FRENZY ring's radius on this trace version's rules.
function frenzyRadiusFor(version) {
  return version >= 5 ? FRENZY_RADIUS_V5 : FRENZY_RADIUS;
}

// v6 carries the plane: an index into PLANE_IDS. Earlier versions have none.
function initSim(seedHex, version, plane) {
  const sim = {
    seedInt: seedToInt(seedHex),
    version: version,
    step: 0,
    dead: false,
    deathStep: null,
    deathCause: null,
    down: false,
    sx: 0,
    sy: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: -3,
    angle: -PI / 2,
    av: 0,
    diff: 0,
    inv: START_INV_STEPS,
    trail: [],
    earned: 0,
    score: 0,
    missiles: [],
    nextId: 0,
    spawnClock: FIRST_SPAWN_STEPS,
    waveClock: FIRST_WAVE_STEPS,
    waveLeft: 0,
    waveGap: 0,
    waveN: 0,
    combo: 0,
    comboLeft: 0,
    pressure: 0,
    phase: 0,
    fv: 0,
    frenzy: false,
    frenzyN: 0,
    frenzyLeft: 0,
    frenzyLen: 0,
    charge: 0,
    cooldown: 0,
    close: false,
    zoom: 1,
    camX: -viewWidthFor(version) / 2,
    camY: -VIEW_H * CAM_Y,
    events: [],
  };
  if (version >= 6) sim.plane = Number.isInteger(plane) && plane >= 0 && plane < PLANE_IDS.length ? plane : 0;
  return sim;
}

function killSim(sim, cause) {
  sim.dead = true;
  sim.deathStep = sim.step;
  sim.deathCause = cause;
  sim.score = scoreOf(sim);
  sim.events.push(['death', sim.x, sim.y]);
}

// Missile N. Every draw is taken on every call in this order, whichever
// branch uses it: 16 attempts of three, the kind, six lane draws, the lane
// width, the aim, the speed variation, the turn rate, the lead, and the gap
// to the next FRENZY spawn. Sixty-one in all.
function spawnMissile(sim, el) {
  const rng = segRng(sim.seedInt, MISSILE_SALT, sim.nextId);
  const zoom = sim.zoom;
  const viewW = viewWidthFor(sim.version) / zoom;
  const viewH = VIEW_H / zoom;
  const pvx = sim.x - sim.camX;
  const pvy = sim.y - sim.camY;
  const margin = SPAWN_MARGIN / zoom;
  const ca = DMath.cos(sim.angle);
  const sa = DMath.sin(sim.angle);
  const sector = SECTORS[sim.nextId % 4];
  let best = Infinity;
  let cx = 0;
  let cy = 0;
  let cf = 0;
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const ray = rng() * TAU;
    const rx = DMath.cos(ray);
    const ry = DMath.sin(ray);
    const front = Math.max(0, rx * ca + ry * sa);
    const ex = rx > 0 ? (viewW + margin - pvx) / rx : (rx < 0 ? (-margin - pvx) / rx : Infinity);
    const ey = ry > 0 ? (viewH + margin - pvy) / ry : (ry < 0 ? (-margin - pvy) / ry : Infinity);
    const dist = Math.min(ex, ey) + 225 + rng() * 175 + front * 110;
    const x = sim.x + rx * dist;
    const y = sim.y + ry * dist;
    const bearing = DMath.atan2(y - sim.y, x - sim.x);
    let pen = Math.abs(wrapAngle(bearing - sim.angle - sector)) * (sim.pressure > 0.65 ? 38 : 57);
    for (let i = 0; i < sim.missiles.length; i++) {
      const q = sim.missiles[i];
      const gap = Math.abs(wrapAngle(bearing - DMath.atan2(q.y - sim.y, q.x - sim.x)));
      const sdx = x - q.x;
      const sdy = y - q.y;
      const spacing = Math.sqrt(sdx * sdx + sdy * sdy);
      if (gap < 0.38) pen += (0.38 - gap) * 620;
      if (spacing < 250) pen += 250 - spacing;
    }
    const vx = x - sim.camX;
    const vy = y - sim.camY;
    if (!(vx <= -margin || vx >= viewW + margin || vy <= -margin || vy >= viewH + margin)) pen += 100000;
    if (el < 14 && front > 0.72) pen += (front - 0.72) * 900;
    else if (el < 36 && front > 0.86) pen += (front - 0.86) * 320;
    pen += rng() * 18;
    if (pen < best) {
      best = pen;
      cx = x;
      cy = y;
      cf = front;
    }
  }
  const kindRoll = rng();
  const pool = sim.frenzy ? 4 : (el < 7 ? 1 : (el < 14 ? 2 : (el < 27 ? 3 : 4)));
  const kind = Math.floor(kindRoll * pool);
  const def = MISSILES[kind];
  let laneSlot = LANES[0];
  let laneScore = -Infinity;
  for (let s = 0; s < LANES.length; s++) {
    let sep = 2;
    for (let i = 0; i < sim.missiles.length; i++) {
      const g = Math.abs(LANES[s] - sim.missiles[i].lane / 105);
      if (i === 0 || g < sep) sep = g;
    }
    const sc = sep + rng() * 0.16;
    if (sc > laneScore) {
      laneScore = sc;
      laneSlot = LANES[s];
    }
  }
  const lane = laneSlot * (92 + rng() * 24) * (1 + cf * 0.22);
  const itx = sim.x + sim.vx * 18 - sa * lane;
  const ity = sim.y + sim.vy * 18 + ca * lane;
  const a = wrapAngle(DMath.atan2(ity - cy, itx - cx) + (rng() - 0.5) * 0.08);
  const variation = 0.96 + rng() * 0.08;
  const planeSpeed = Math.sqrt(sim.vx * sim.vx + sim.vy * sim.vy);
  const start = planeSpeed * def[0] * variation * MISSILE_SPEED_SCALE
    * (sim.frenzy ? 1.08 : (el < 14 ? 0.98 : 1.02)) * (1 - cf * (sim.frenzy ? 0.05 : 0.14));
  const turnRate = def[2] * (0.94 + rng() * 0.12);
  const lead = def[3] * (0.9 + rng() * 0.2);
  const gapRoll = rng();
  const nm = {
    id: sim.nextId, kind: kind, x: cx, y: cy, vx: DMath.cos(a) * start, vy: DMath.sin(a) * start,
    angle: a, pursuit: sim.angle, av: 0, speed: start, life: 0, near: false,
    lane: lane, variation: variation, turnRate: turnRate, lead: lead,
  };
  if (sim.version >= 5) nm.seen = 0;
  sim.missiles = sim.missiles.concat([nm]);
  sim.events.push(['spawn', sim.nextId, kind]);
  sim.nextId++;
  return gapRoll;
}

function startFrenzy(sim) {
  const rng = segRng(sim.seedInt, FRENZY_SALT, sim.frenzyN);
  sim.frenzyN++;
  sim.frenzy = true;
  sim.frenzyLen = FRENZY_MIN_STEPS + Math.floor(rng() * (FRENZY_SPAN_STEPS + 1));
  sim.frenzyLeft = sim.frenzyLen;
  sim.charge = 0;
  sim.spawnClock = 0;
  sim.waveLeft = 0;
  sim.events.push(['frenzy', sim.frenzyLen]);
}

function endFrenzy(sim) {
  sim.frenzy = false;
  sim.frenzyLeft = 0;
  sim.frenzyLen = 0;
  sim.charge = 0;
  sim.cooldown = FRENZY_COOLDOWN_STEPS;
  sim.spawnClock = Math.max(sim.spawnClock, FRENZY_END_SPAWN_HOLD);
  sim.inv = Math.max(sim.inv, FRENZY_END_INV_STEPS);
  sim.events.push(['frenzyEnd']);
  // v6: FRENZY ends by smashing every missile inside the HOLD_R ring, so
  // no missile is ever left inside it: the hold then never has to move one
  // out across the plane.
  if (sim.version >= 6) {
    const keep = [];
    for (let i = 0; i < sim.missiles.length; i++) {
      const m = sim.missiles[i];
      const dx = m.x - sim.x;
      const dy = m.y - sim.y;
      if (dx * dx + dy * dy < HOLD_R * HOLD_R) {
        sim.earned++;
        sim.events.push(['smash', m.x, m.y, 2]);
      } else {
        keep.push(m);
      }
    }
    sim.missiles = keep;
  }
}

// Missiles flying side by side on nearly the same heading ease apart, so a
// pack reads as separate threats instead of one blob.
function separationTurn(sim, m) {
  let c = 0;
  const s = DMath.sin(m.angle);
  const co = DMath.cos(m.angle);
  for (let i = 0; i < sim.missiles.length; i++) {
    const q = sim.missiles[i];
    if (q === m) continue;
    const dx = q.x - m.x;
    const dy = q.y - m.y;
    const d2 = dx * dx + dy * dy;
    const clr = MISSILES[m.kind][5] + MISSILES[q.kind][5] + 9;
    if (d2 <= clr * clr || d2 > 11025) continue;
    const gap = Math.abs(wrapAngle(q.angle - m.angle));
    if (gap > 0.28) continue;
    const lateral = -s * dx + co * dy;
    const al = Math.abs(lateral);
    if (al > 34) continue;
    const side = al < 0.8 ? (m.id < q.id ? -1 : 1) : (lateral > 0 ? -1 : 1);
    c += side * (1 - Math.sqrt(d2) / 105) * (1 - gap / 0.28) * (1 - Math.min(1, al / 34)) * 0.16;
  }
  return clamp(c, -0.18, 0.18);
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  if (len <= 0.0001) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1);
  const x = ax + dx * t;
  const y = ay + dy * t;
  return (px - x) * (px - x) + (py - y) * (py - y);
}

// In FRENZY the plane's bright trail destroys a missile that touches it.
function hitsTrail(sim, m) {
  const tr = sim.trail;
  if (!sim.frenzy || tr.length < 12) return false;
  const r = MISSILES[m.kind][5] + TRAIL_HIT_PAD;
  for (let i = 7; i < tr.length - 2; i += 2) {
    if (segDist2(m.x, m.y, tr[i][0], tr[i][1], tr[i + 2][0], tr[i + 2][1]) <= r * r) return true;
  }
  return false;
}

// v4: does missile m touch the plane's silhouette? Each PLANE_HIT circle,
// turned with the heading, against the missile's capsule.
function hitsPlane(sim, m, pd) {
  if (pd > PLANE_HIT_REACH) return false;
  const ca = DMath.cos(sim.angle);
  const sa = DMath.sin(sim.angle);
  const mh = MISSILE_HIT[m.kind];
  const mc = DMath.cos(m.angle);
  const ms = DMath.sin(m.angle);
  const ax = m.x + mc * mh[0];
  const ay = m.y + ms * mh[0];
  const bx = m.x - mc * mh[1];
  const by = m.y - ms * mh[1];
  for (let i = 0; i < PLANE_HIT.length; i++) {
    const c = PLANE_HIT[i];
    const cx = sim.x + ca * c[0] - sa * c[1];
    const cy = sim.y + sa * c[0] + ca * c[1];
    const r = c[2] + mh[2];
    if (segDist2(cx, cy, ax, ay, bx, by) < r * r) return true;
  }
  return false;
}

// v6: a plane's grid from its packed string, six cells a character.
function unpackMask(m) {
  const cells = [];
  for (let i = 0; i < m[2].length; i++) {
    const v = MASK_ALPHABET.indexOf(m[2][i]);
    for (let q = 5; q >= 0; q--) cells.push(Math.floor(v / (1 << q)) % 2);
  }
  return { w: m[0], h: m[1], cells: cells.slice(0, m[0] * m[1]) };
}

// v6: the farthest corner of any solid cell from the plane's centre.
function gridReach(g) {
  let r2 = 0;
  for (let j = 0; j < g.h; j++) {
    for (let i = 0; i < g.w; i++) {
      if (g.cells[j * g.w + i] !== 1) continue;
      const a = Math.max(Math.abs(i - g.w / 2), Math.abs(i + 1 - g.w / 2));
      const f = Math.max(Math.abs(g.h / 2 - j), Math.abs(g.h / 2 - j - 1));
      if (a * a + f * f > r2) r2 = a * a + f * f;
    }
  }
  return Math.sqrt(r2);
}

function inPolygon(p, x, y) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > y) !== (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
}

// v6: sample points covering a missile's drawn body, in world units along
// its own heading: a grid inside the polygon, every corner and every edge's
// midpoint.
function missilePoints(poly) {
  const pts = [];
  for (let ix = -14; ix <= 14; ix++) {
    for (let iy = -10; iy <= 10; iy++) {
      if (inPolygon(poly, ix * MISSILE_SAMPLE, iy * MISSILE_SAMPLE)) pts.push([ix * MISSILE_SAMPLE, iy * MISSILE_SAMPLE]);
    }
  }
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length];
    pts.push([poly[i][0], poly[i][1]], [(poly[i][0] + q[0]) / 2, (poly[i][1] + q[1]) / 2]);
  }
  return pts.map(function (q) { return [q[0] * MISSILE_DRAW_SCALE, q[1] * MISSILE_DRAW_SCALE]; });
}

function pointsReach(pts) {
  let r2 = 0;
  for (let i = 0; i < pts.length; i++) r2 = Math.max(r2, pts[i][0] * pts[i][0] + pts[i][1] * pts[i][1]);
  return Math.sqrt(r2);
}

// v6: does a missile of `kind`, `rx, ry` from the plane's centre and heading
// `ma`, overlap plane `p` drawn at heading `pa`? Cell by cell, on the art.
function drawnTouch(p, pa, kind, rx, ry, ma) {
  const g = PLANE_GRIDS[p];
  const ca = DMath.cos(pa);
  const sa = DMath.sin(pa);
  const mc = DMath.cos(ma);
  const ms = DMath.sin(ma);
  const pts = MISSILE_PTS[kind];
  for (let k = 0; k < pts.length; k++) {
    const x = rx + pts[k][0] * mc - pts[k][1] * ms;
    const y = ry + pts[k][0] * ms + pts[k][1] * mc;
    const i = Math.floor(-x * sa + y * ca + g.w / 2);
    const j = Math.floor(g.h / 2 - (x * ca + y * sa));
    if (i >= 0 && j >= 0 && i < g.w && j < g.h && g.cells[j * g.w + i] === 1) return true;
  }
  return false;
}

// v6: did missile m touch the plane at any moment between the last step and
// this one? Both move in a straight line and turn at an even rate between
// steps, exactly as the screen interpolates them.
function sweepTouch(sim, m, x0, y0, a0, px0, py0, pa0) {
  const reach = PLANE_REACH[sim.plane] + MISSILE_REACH[m.kind];
  const rx0 = x0 - px0;
  const ry0 = y0 - py0;
  const drx = (m.x - sim.x) - rx0;
  const dry = (m.y - sim.y) - ry0;
  if (segDist2(0, 0, rx0, ry0, rx0 + drx, ry0 + dry) > reach * reach) return false;
  const dpa = wrapAngle(sim.angle - pa0);
  const dma = wrapAngle(m.angle - a0);
  const span = Math.sqrt(drx * drx + dry * dry) + Math.abs(dpa) * PLANE_REACH[sim.plane] + Math.abs(dma) * MISSILE_REACH[m.kind];
  const n = Math.min(SWEEP_MAX, Math.max(1, Math.ceil(span / SWEEP_STEP)));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const rx = rx0 + drx * t;
    const ry = ry0 + dry * t;
    if (rx * rx + ry * ry > reach * reach) continue;
    if (drawnTouch(sim.plane, pa0 + dpa * t, m.kind, rx, ry, a0 + dma * t)) return true;
  }
  return false;
}

// v6: a missile that may not hurt the plane yet is stopped on the HOLD_R
// ring. Coming from outside it stops where its path meets the ring; already
// on it, it slides round it. Both ends of every step are then on or outside
// the ring, and the ring is wider than any plane and any missile together.
function holdOff(sim, m, x0, y0, px0, py0) {
  const rx1 = m.x - sim.x;
  const ry1 = m.y - sim.y;
  const d1 = rx1 * rx1 + ry1 * ry1;
  if (d1 >= HOLD_R * HOLD_R) return;
  const rx0 = x0 - px0;
  const ry0 = y0 - py0;
  const c = rx0 * rx0 + ry0 * ry0 - HOLD_R * HOLD_R;
  let hx = 0;
  let hy = 0;
  if (c > 0.000001) {
    const dx = rx1 - rx0;
    const dy = ry1 - ry0;
    const a = dx * dx + dy * dy;
    const b = 2 * (rx0 * dx + ry0 * dy);
    const t = (-b - Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
    hx = rx0 + dx * t;
    hy = ry0 + dy * t;
  } else if (d1 > 0) {
    const s = HOLD_R / Math.sqrt(d1);
    hx = rx1 * s;
    hy = ry1 * s;
  } else {
    hx = -DMath.cos(sim.angle) * HOLD_R;
    hy = -DMath.sin(sim.angle) * HOLD_R;
  }
  m.x = sim.x + hx;
  m.y = sim.y + hy;
  sim.events.push(['hold', m.id]);
}

// One fixed step with the stick at (sx, sy) while the finger is down, or no
// stick at all. The stick only chooses a heading; the plane turns toward it at
// a bounded rate and never stops flying.
function stepSim(sim, down, sx, sy) {
  if (sim.dead) return;
  const px0 = sim.x;
  const py0 = sim.y;
  const pa0 = sim.angle;
  sim.events = [];
  sim.step++;
  sim.down = down;
  if (down) {
    sim.sx = sx;
    sim.sy = sy;
  }
  const el = sim.step / 60;
  if (sim.inv > 0) sim.inv--;

  // ── the plane ──
  const sd = Math.sqrt(sim.sx * sim.sx + sim.sy * sim.sy);
  const target = sim.down && sd > STICK_DEAD ? DMath.atan2(sim.sy, sim.sx) : sim.angle;
  const diff = wrapAngle(target - sim.angle);
  const g = Math.min(1, sd / STICK_FULL);
  const smooth = diff * (1 - expNeg((TURN_RESPONSE + g * TURN_RESPONSE_GAIN) / 60));
  const maxTurn = (TURN_RATE + g * TURN_RATE_GAIN) / 60;
  const turn = clamp(smooth, -maxTurn, maxTurn);
  sim.angle = wrapAngle(sim.angle + turn);
  sim.av += (turn * 60 - sim.av) * K_AV;
  sim.diff = diff;
  const ps = cruiseSpeed(sim) * (1 - Math.min(TURN_SLOW, Math.abs(diff) / PI * TURN_SLOW)) * (1 + sim.fv * FRENZY_BOOST);
  sim.vx = DMath.cos(sim.angle) * ps;
  sim.vy = DMath.sin(sim.angle) * ps;
  sim.x += sim.vx;
  sim.y += sim.vy;
  sim.trail = [[sim.x, sim.y, sim.angle]].concat(sim.trail.slice(0, (sim.frenzy ? TRAIL_LEN_FRENZY : TRAIL_LEN) - 1));

  // ── FRENZY ──
  sim.fv += ((sim.frenzy ? 1 : 0) - sim.fv) * (sim.frenzy ? K_FV_IN : K_FV_OUT);
  if (sim.frenzy) {
    sim.close = false;
    sim.frenzyLeft--;
    if (sim.frenzyLeft <= 0) endFrenzy(sim);
  } else {
    if (sim.cooldown > 0) sim.cooldown--;
    if (sim.cooldown > 0) {
      sim.close = false;
      sim.charge = 0;
    } else {
      let close = false;
      const fr = frenzyRadiusFor(sim.version);
      for (let i = 0; i < sim.missiles.length; i++) {
        const dx = sim.missiles[i].x - sim.x;
        const dy = sim.missiles[i].y - sim.y;
        if (dx * dx + dy * dy <= fr * fr) { close = true; break; }
      }
      sim.close = close;
      if (close) {
        sim.charge++;
        if (sim.charge >= FRENZY_CHARGE_STEPS) startFrenzy(sim);
      } else {
        sim.charge = 0;
      }
    }
  }

  // ── the sky around it ──
  const d = difficultyAt(el);
  if (d.key !== sim.phase) {
    sim.phase = d.key;
    sim.events.push(['phase', d.key]);
  }
  if (sim.comboLeft > 0) sim.comboLeft--;
  if (sim.comboLeft <= 0) sim.combo = 0;
  let near = 0;
  let mid = 0;
  for (let i = 0; i < sim.missiles.length; i++) {
    const dx = sim.missiles[i].x - sim.x;
    const dy = sim.missiles[i].y - sim.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 19600) near++;
    else if (d2 < 84100) mid++;
  }
  const pTarget = Math.min(1, sim.missiles.length * 0.065 + near * 0.25 + mid * 0.11) * (sim.comboLeft > 0 ? 0.82 : 1);
  sim.pressure += (pTarget - sim.pressure) * K_PRESSURE;

  sim.spawnClock--;
  if (sim.frenzy) {
    if (sim.spawnClock <= 0 && sim.missiles.length < FRENZY_MAX_MISSILES) {
      const gapRoll = spawnMissile(sim, el);
      sim.spawnClock = FRENZY_GAP_MIN + Math.floor(gapRoll * FRENZY_GAP_SPAN);
    }
  } else if (d.key !== 0) {
    sim.waveClock--;
    if (sim.waveClock <= 0 && sim.waveLeft === 0) {
      if (sim.missiles.length <= d.max - 2 && sim.pressure < 0.52) {
        const wr = segRng(sim.seedInt, WAVE_SALT, sim.waveN);
        sim.waveN++;
        sim.waveLeft = d.key === 2 ? 3 : 2;
        sim.waveGap = 0;
        sim.waveClock = WAVE_EVERY_MIN + Math.floor(wr() * (WAVE_EVERY_SPAN + 1));
        sim.events.push(['wave']);
      } else {
        sim.waveClock = WAVE_RETRY_STEPS;
      }
    }
  }
  if (!sim.frenzy) {
    if (sim.waveLeft > 0) {
      sim.waveGap--;
      if (sim.waveGap <= 0 && sim.missiles.length < d.max) {
        spawnMissile(sim, el);
        sim.waveLeft--;
        sim.waveGap = WAVE_GAP_STEPS;
        if (sim.waveLeft === 0) sim.spawnClock = Math.max(sim.spawnClock, spawnSteps(sim, d.interval * 0.7));
      }
    } else if (sim.spawnClock <= 0 && sim.missiles.length < d.max) {
      spawnMissile(sim, el);
      sim.spawnClock = spawnSteps(sim, d.interval);
    }
  }

  // ── the camera, which decides where missiles may appear ──
  sim.zoom = 1 - sim.fv * FRENZY_ZOOM;
  const viewW = viewWidthFor(sim.version) / sim.zoom;
  const viewH = VIEW_H / sim.zoom;
  sim.camX = sim.x - viewW / 2;
  sim.camY = sim.y - viewH * CAM_Y;

  // ── the missiles ──
  const cruise = cruiseSpeed(sim) * (1 + sim.fv * FRENZY_BOOST);
  const sharp = Math.min(1, Math.abs(sim.av) / 4.8);
  const despawn = Math.max(viewW, viewH) * DESPAWN_VIEWS;
  for (let i = sim.missiles.length - 1; i >= 0; i--) {
    const m = sim.missiles[i];
    const def = MISSILES[m.kind];
    const x0 = m.x;
    const y0 = m.y;
    const a0 = m.angle;
    m.life++;
    const ddx = sim.x - m.x;
    const ddy = sim.y - m.y;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);
    const far = clamp((dist - 120) / 360, 0, 1);
    const want = cruise * (def[0] + 0.07 + def[1] * far * 0.6 + d.boost + (sim.frenzy ? 0.06 : 0)) * m.variation * MISSILE_SPEED_SCALE;
    const sdiff = want - m.speed;
    const sstep = (sdiff > 0 ? def[4] : def[4] * 1.35) / 60;
    m.speed += clamp(sdiff, -sstep, sstep);
    const pr = (2.35 + sharp * 0.55) / 60;
    m.pursuit = wrapAngle(m.pursuit + clamp(wrapAngle(sim.angle - m.pursuit), -pr, pr));
    const intercept = Math.min(m.lead, dist / Math.max(1, m.speed * 60));
    const blend = clamp((dist - 45) / 190, 0, 1);
    const align = Math.max(0, DMath.cos(wrapAngle(DMath.atan2(ddy, ddx) - m.angle)));
    const look = intercept * 0.6 * blend * align * (1 - sharp * 0.68);
    const fade = clamp((dist - 28) / 230, 0, 1) * (1 - sharp * 0.52);
    const tx = sim.x + sim.vx * 60 * look - DMath.sin(m.pursuit) * m.lane * fade;
    const ty = sim.y + sim.vy * 60 * look + DMath.cos(m.pursuit) * m.lane * fade;
    const err = wrapAngle(DMath.atan2(ty - m.y, tx - m.x) + separationTurn(sim, m) - m.angle);
    const adaptive = 0.9 + Math.min(1, Math.abs(err) / (PI * 0.65)) * 0.26 + (1 - Math.min(1, dist / 300)) * 0.12;
    const maxRate = m.turnRate * adaptive * d.turn * (sim.frenzy ? 1.08 : 1);
    m.av += clamp(clamp(err * 3.6, -maxRate, maxRate) - m.av, -7.5 / 60, 7.5 / 60);
    m.angle = wrapAngle(m.angle + m.av / 60);
    m.vx = DMath.cos(m.angle) * m.speed;
    m.vy = DMath.sin(m.angle) * m.speed;
    m.x += m.vx;
    m.y += m.vy;
    if (sim.version >= 6 && !sim.frenzy && (m.seen < ARM_SEEN_STEPS || sim.inv > 0)) holdOff(sim, m, x0, y0, px0, py0);
    const pdx = m.x - sim.x;
    const pdy = m.y - sim.y;
    if (sim.version >= 5) {
      const ox = pdx * sim.zoom;
      const oy = pdy * sim.zoom + VIEW_H * CAM_Y;
      const inView = ox >= FAIR_INSET - FAIR_HALF_W && ox <= FAIR_HALF_W - FAIR_INSET && oy >= FAIR_INSET && oy <= VIEW_H - FAIR_INSET;
      m.seen = inView ? m.seen + 1 : 0;
    }
    const pd = Math.sqrt(pdx * pdx + pdy * pdy);
    if (pd < NEAR_R && !m.near) {
      m.near = true;
      sim.earned++;
      sim.events.push(['near', m.x, m.y]);
    }
    if (pd > NEAR_RESET_R) m.near = false;
    // v6: in FRENZY any touch smashes; otherwise only an armed missile
    // with the plane unshielded is tested, every other one was held off.
    const touches = sim.version >= 6
      ? (sim.frenzy || (m.seen >= ARM_SEEN_STEPS && sim.inv <= 0)) && sweepTouch(sim, m, x0, y0, a0, px0, py0, pa0)
      : (sim.version >= 4 ? hitsPlane(sim, m, pd) : pd < def[5] + PLANE_R);
    const armed = sim.version >= 6 ? true : (sim.version >= 5 ? m.seen >= ARM_SEEN_STEPS : m.life > ARM_LIFE_STEPS);
    const smash = hitsTrail(sim, m) ? 1 : (touches && armed ? 2 : 0);
    if (smash === 2 && !sim.frenzy) {
      if (sim.inv <= 0) {
        sim.missiles = sim.missiles.slice(0, i).concat(sim.missiles.slice(i + 1));
        killSim(sim, 'missile');
        return;
      }
    } else if (smash !== 0) {
      sim.missiles = sim.missiles.slice(0, i).concat(sim.missiles.slice(i + 1));
      sim.earned++;
      sim.events.push(['smash', m.x, m.y, smash]);
      continue;
    }
    if (pdx * pdx + pdy * pdy > despawn * despawn) {
      sim.missiles = sim.missiles.slice(0, i).concat(sim.missiles.slice(i + 1));
    }
  }

  // ── missiles that fly into each other ──
  const gone = [];
  for (let i = 0; i < sim.missiles.length; i++) {
    if (gone[i] === true) continue;
    const m = sim.missiles[i];
    for (let j = i + 1; j < sim.missiles.length; j++) {
      if (gone[j] === true) continue;
      const q = sim.missiles[j];
      const dx = m.x - q.x;
      const dy = m.y - q.y;
      const r = MISSILES[m.kind][5] + MISSILES[q.kind][5] + 2;
      if (dx * dx + dy * dy < r * r) {
        gone[i] = true;
        gone[j] = true;
        sim.combo = sim.comboLeft > 0 ? Math.min(COMBO_MAX, sim.combo + 1) : 1;
        sim.comboLeft = COMBO_STEPS;
        sim.earned += 2 * sim.combo;
        sim.events.push(['crash', (m.x + q.x) / 2, (m.y + q.y) / 2, sim.combo]);
        break;
      }
    }
  }
  if (gone.length > 0) sim.missiles = sim.missiles.filter(function (_m, k) { return gone[k] !== true; });
  sim.score = scoreOf(sim);
}
// ==== END RULES BLOCK ====

// ── server-only bounds ──────────────────────────────────────────────────
//
// An hour of simulation: the session's own lifetime (SESSION_LIFETIME_SECS).
// A cap below it would silently TRUNCATE a legal run rather than refuse it.
const MAX_SIM_STEPS = 60 * 60 * 60;
// The client ships one sample per step while the finger is down, cut into
// batches of at most PATH_BATCH_MAX. A path event longer than that is not one
// the client can produce.
const PATH_BATCH_MAX = 120;
// Samples and markers together. An hour of finger-down play is 216,000
// samples; this sits above it and stops a huge trace from turning one submit
// into a CPU sink. It REFUSES further inputs, it never zeroes.
const MAX_INPUTS = 240000;

function advanceTo(state, step) {
  const sim = state.sim;
  while (!sim.dead && sim.step < step && sim.step < MAX_SIM_STEPS) stepSim(sim, state.down, sim.sx, sim.sy);
}

// `typeof` FIRST: Number(null) is 0 and Number('400') is 400, so coercing would
// apply a malformed value as if it were real.
function isStep(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

// A stick sample: whole design units inside the stick's disc.
function isStick(x, y) {
  return typeof x === 'number' && typeof y === 'number' && Number.isInteger(x) && Number.isInteger(y)
    && x * x + y * y <= STICK_MAX * STICK_MAX;
}

function init({ seed, maxDurationSecs, elapsedSecs } = {}) {
  return {
    mode: 'none',
    version: null,
    sim: null,
    seed: typeof seed === 'string' ? seed : null,
    down: false,
    snapNext: false,
    lastStep: 0,
    inputCount: 0,
    rejectCount: 0,
    score: 0,
    dead: false,
    maxDurationSecs: Number(maxDurationSecs) || 3600,
    elapsedSecs: Number(elapsedSecs) || 0,
    badPlane: false,
    // Raw material for the bot fingerprint, recorded and never gated.
    touches: 0,
    downSteps: 0,
    moveSteps: 0,
    stickSum: 0,
    stickSq: 0,
    travelSum: 0,
    maxTravel: 0,
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
    // v2 (the 576 wide view), v3 (the 748 wide view), v4 (the silhouette
    // collider), v5 (armed only once seen, the larger FRENZY ring) and v6
    // (each plane collides as its own art, unarmed missiles held off) are each
    // replayed on their own rules. A marker this validator
    // does not know is not replayed on rules it was not played on. A v6
    // marker names the plane; one it does not name is the first plane, which
    // is exactly as large to a missile as any other.
    const v = Number(payload.v);
    if ((v === 2 || v === 3 || v === 4 || v === 5 || v === 6) && state.mode !== 'sim') {
      state.mode = 'sim';
      state.version = v;
      const plane = v >= 6 ? PLANE_IDS.indexOf(payload.plane) : -1;
      if (v >= 6 && plane < 0) state.badPlane = true;
      state.sim = initSim(state.seed, v, plane < 0 ? 0 : plane);
    }
    return { accepted: true, newScore: state.score };
  }

  // No start marker, no replay, no score. There is no plausibility path.
  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };
  if (kind === 'lift' || kind === 'touch') return processMarker(state, kind, payload);
  if (kind === 'path') return processPath(state, payload);
  return { accepted: true, newScore: state.score };
}

// { kind: 'lift' | 'touch', step }: the finger is up (or down) from `step` on.
function processMarker(state, kind, payload) {
  const step = payload.step;
  if (!isStep(step)) return reject(state, 'bad_marker');
  if (step <= state.lastStep) return reject(state, 'frame_regressed');
  const wantDown = kind === 'touch';
  if (state.down === wantDown) return reject(state, 'bad_marker');
  if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');
  state.inputCount++;
  advanceTo(state, step - 1);
  if (state.sim.dead) return deadResult(state);
  state.down = wantDown;
  // A fresh touch puts the stick wherever the finger's first sample says; from
  // then on the stick chases the finger at STICK_TRAVEL a step.
  state.snapNext = wantDown;
  if (wantDown) state.touches++;
  state.lastStep = wantDown ? step - 1 : step;
  state.score = state.sim.score;
  return { accepted: true, newScore: state.score };
}

// { kind: 'path', f, x: [...], y: [...] }: x[i], y[i] is the stick during
// step f+1+i. POSITIONAL and dense, applied whole or not at all.
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

  // VALIDATE THE WHOLE BATCH BEFORE APPLYING ANY OF IT. A batch that stopped
  // half way would leave the replay in a state the game never had.
  const sim = state.sim;
  let px = sim.sx;
  let py = sim.sy;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!isStick(x, y)) return reject(state, 'bad_sample');
    if (!(i === 0 && state.snapNext)) {
      const dx = x - px;
      const dy = y - py;
      if (dx > STICK_TRAVEL || dx < -STICK_TRAVEL || dy > STICK_TRAVEL || dy < -STICK_TRAVEL) {
        return reject(state, 'teleport');
      }
    }
    px = x;
    py = y;
  }

  state.inputCount += xs.length;
  state.lastStep = f + xs.length;
  state.snapNext = false;
  for (let i = 0; i < xs.length; i++) {
    advanceTo(state, f + i);
    if (sim.dead || sim.step >= MAX_SIM_STEPS) break;
    recordStick(state, sim, xs[i], ys[i]);
    stepSim(sim, true, xs[i], ys[i]);
  }
  if (sim.dead) return deadResult(state);
  state.score = sim.score;
  return { accepted: true, newScore: state.score };
}

// How the stick is worked: how far out it is held and how far it travels a
// step. Floating point is fine here: a debug statistic, never the score.
function recordStick(state, sim, x, y) {
  const r = Math.sqrt(x * x + y * y);
  const dx = x - sim.sx;
  const dy = y - sim.sy;
  const t = Math.sqrt(dx * dx + dy * dy);
  state.downSteps++;
  state.stickSum += r;
  state.stickSq += r * r;
  if (t > 0) state.moveSteps++;
  state.travelSum += t;
  if (t > state.maxTravel) state.maxTravel = t;
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
  // Run the world out past the last input, with the stick as the trace left
  // it. A plane nobody steers flies straight and the missiles run it down (the
  // parity suite measures how soon), so every run ends by a rule the replay
  // models; the elapsed cap and the session bound stop the rest.
  const runOutSteps = Math.min(MAX_SIM_STEPS, Math.ceil(state.maxDurationSecs * 60));
  const capSteps = elapsedCap(state, 60);
  let guard = 0;
  while (!sim.dead && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {
    stepSim(sim, state.down, sim.sx, sim.sy);
    guard++;
  }
  const n = state.downSteps;
  const mean = n > 0 ? state.stickSum / n : null;
  const sd = n > 1 ? Math.sqrt(Math.max(0, state.stickSq / n - mean * mean)) : null;
  return {
    score: sim.score,
    gameOver: true,
    suspicious: state.rejectCount >= 10 ? `validator_rejects:${state.rejectCount}` : null,
    debug: {
      mode: 'sim', version: state.version, steps: sim.step, deathStep: sim.deathStep, deathCause: sim.deathCause,
      score: sim.score, dead: sim.dead, inputs: state.inputCount, rejects: state.rejectCount,
      earned: sim.earned, missilesSpawned: sim.nextId, frenzies: sim.frenzyN,
      plane: sim.version >= 6 ? PLANE_IDS[sim.plane] : null, badPlane: state.badPlane === true,
      // Not gated. Raw material for the bot fingerprint: how the stick is held
      // and moved over every step the finger was down.
      stick: {
        touches: state.touches, downSteps: n, moveSteps: state.moveSteps,
        meanRadius: mean, sdRadius: sd,
        meanTravel: n > 0 ? state.travelSum / n : null, maxTravel: state.maxTravel,
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
  // Pinned to the session lifetime by shared/tests/sessionLifetime.test.js
  // once the coordinator registers this validator.
  _limits: { MAX_SIM_STEPS, FPS: 60 },
  init, processEvent, finalize, simulate,
  _sim: {
    initSim, stepSim, killSim, spawnMissile, startFrenzy, endFrenzy, separationTurn, segDist2, hitsTrail, hitsPlane, PLANE_HIT, MISSILE_HIT, PLANE_HIT_REACH,
    PLANE_IDS, PLANE_K, PLANE_MASKS, PLANE_GRIDS, PLANE_REACH, MISSILE_POLY, MISSILE_PTS, MISSILE_REACH, MISSILE_DRAW_SCALE, MISSILE_SAMPLE,
    HOLD_R, SWEEP_STEP, SWEEP_MAX, MASK_ALPHABET, drawnTouch, sweepTouch, holdOff, unpackMask, gridReach, missilePoints, pointsReach, inPolygon,
    difficultyAt, spawnSteps, cruiseSpeed, scoreOf, viewWidthFor, frenzyRadiusFor, expNeg, wrapAngle, clamp, segRng, seedToInt, advanceTo,
    isStick, isStep, elapsedCap, DMath,
    MISSILES, SECTORS, LANES, DEATH_CAUSES, MAX_INPUTS, MAX_SIM_STEPS, PATH_BATCH_MAX,
    VIEW_W, VIEW_W_V2, VIEW_H, CAM_Y, PI, TAU, PLANE_R, PLANE_BASE, PLANE_RAMP, PLANE_RAMP_CAP, SPEED_MUL, MISSILE_SPEED_SCALE,
    START_INV_STEPS, FRENZY_END_INV_STEPS, STICK_MAX, STICK_TRAVEL, STICK_DEAD, STICK_FULL, TURN_RESPONSE,
    TURN_RESPONSE_GAIN, TURN_RATE, TURN_RATE_GAIN, TURN_SLOW, FRENZY_BOOST, FRENZY_ZOOM, FRENZY_RADIUS, FRENZY_RADIUS_V5,
    FRENZY_CHARGE_STEPS, FRENZY_COOLDOWN_STEPS, FRENZY_MIN_STEPS, FRENZY_SPAN_STEPS, FRENZY_MAX_MISSILES,
    FRENZY_GAP_MIN, FRENZY_GAP_SPAN, FRENZY_END_SPAWN_HOLD, TRAIL_LEN, TRAIL_LEN_FRENZY, TRAIL_HIT_PAD,
    FIRST_SPAWN_STEPS, FIRST_WAVE_STEPS, WAVE_EVERY_MIN, WAVE_EVERY_SPAN, WAVE_RETRY_STEPS, WAVE_GAP_STEPS,
    COMBO_STEPS, COMBO_MAX, NEAR_R, NEAR_RESET_R, ARM_LIFE_STEPS, ARM_SEEN_STEPS, FAIR_HALF_W, FAIR_INSET, SPAWN_ATTEMPTS, SPAWN_MARGIN, DESPAWN_VIEWS,
    STEPS_PER_POINT, POINTS_PER_UNIT, MISSILE_SALT, WAVE_SALT, FRENZY_SALT, RNG_STRIDE,
    K_AV, K_FV_IN, K_FV_OUT, K_PRESSURE,
  },
};
