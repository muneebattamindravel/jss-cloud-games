#!/usr/bin/env node
'use strict';

/**
 * Tetris Smash mutation battery.
 *
 * Writes a deliberate bug into the rules, the validator or the client, runs the
 * four suites, and requires them to go red. A survivor is a hole in the suites.
 *
 * RUN IT FROM A SCRATCH COPY OF THE TREE, NEVER THE WORKING TREE. It rewrites
 * source files in place and restores them afterwards. One copy per shard, at
 * most three shards.
 *
 *   node shared/tests/lib/tetrisSmashMutate.js all --shard 1/3
 *   node shared/tests/lib/tetrisSmashMutate.js all --nopin   (pin table and rules
 *        hash off: what the BEHAVIOUR alone catches)
 *   node shared/tests/lib/tetrisSmashMutate.js --check       (read only)
 *   node shared/tests/lib/tetrisSmashMutate.js --list
 *
 * A suite past SUITE_TIMEOUT_MS counts as CAUGHT. An unknown flag EXITS 2, and
 * so does a run started inside a git working tree (unless --scratch-ok says the
 * caller made a throwaway copy).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../../..');
const FILES = {
  rules: path.join(ROOT, 'games/tetris-smash/js/rules.js'),
  game: path.join(ROOT, 'games/tetris-smash/js/game.js'),
  validator: path.join(ROOT, 'shared/anticheat/validators/tetrisSmash.js'),
};
const SUITES = ['shared/tests/tetrisSmashAdversarial.test.js', 'shared/tests/tetrisSmashReplay.test.js',
  'shared/tests/tetrisSmashRender.test.js', 'shared/tests/tetrisSmashParity.test.js'];
const SUITE_TIMEOUT_MS = 6 * 60 * 1000;
let NOPIN = false;

// [name, where ('both' = rules.js and the validator | 'rules' | 'game' | 'validator'), find, replace]
const M = [
  // ── constants ────────────────────────────────────────────────────────────
  ['RUN_STEPS', 'both', 'var RUN_STEPS = 18000; ', 'var RUN_STEPS = 17999; '],
  ['LOCK_STEPS -1', 'both', 'var LOCK_STEPS = 30; ', 'var LOCK_STEPS = 29; '],
  ['LOCK_STEPS +1', 'both', 'var LOCK_STEPS = 30; ', 'var LOCK_STEPS = 31; '],
  ['LOCK_RESETS -1', 'both', 'var LOCK_RESETS = 15; ', 'var LOCK_RESETS = 14; '],
  ['LOCK_RESETS +1', 'both', 'var LOCK_RESETS = 15; ', 'var LOCK_RESETS = 16; '],
  ['SOFT_G', 'both', 'var SOFT_G = 2; ', 'var SOFT_G = 3; '],
  ['SPAWN_STEPS', 'both', 'var SPAWN_STEPS = 6; ', 'var SPAWN_STEPS = 5; '],
  ['CLEAR_STEPS', 'both', 'var CLEAR_STEPS = 24; ', 'var CLEAR_STEPS = 23; '],
  ['LINES_PER_LEVEL', 'both', 'var LINES_PER_LEVEL = 10;', 'var LINES_PER_LEVEL = 9;'],
  ['MAX_ACTS', 'both', 'var MAX_ACTS = 40000; ', 'var MAX_ACTS = 39999; '],
  ['GRAVITY level 1', 'both', 'var GRAVITY = [48, 40,', 'var GRAVITY = [47, 40,'],
  ['GRAVITY level 10', 'both', '12, 10, 8, 7, 6,', '12, 10, 9, 7, 6,'],
  ['GRAVITY level 20', 'both', '3, 3, 2, 2, 1];', '3, 3, 2, 2, 2];'],
  ['LINE_POINTS single', 'both', 'var LINE_POINTS = [0, 100, 300, 500, 800];', 'var LINE_POINTS = [0, 99, 300, 500, 800];'],
  ['LINE_POINTS double', 'both', 'var LINE_POINTS = [0, 100, 300, 500, 800];', 'var LINE_POINTS = [0, 100, 301, 500, 800];'],
  ['LINE_POINTS triple', 'both', 'var LINE_POINTS = [0, 100, 300, 500, 800];', 'var LINE_POINTS = [0, 100, 300, 501, 800];'],
  ['LINE_POINTS four', 'both', 'var LINE_POINTS = [0, 100, 300, 500, 800];', 'var LINE_POINTS = [0, 100, 300, 500, 801];'],
  ['COMBO_POINTS', 'both', 'var COMBO_POINTS = 50;', 'var COMBO_POINTS = 49;'],
  ['HARD_POINTS', 'both', 'var HARD_POINTS = 2; ', 'var HARD_POINTS = 3; '],
  ['HIDDEN', 'both', 'var HIDDEN = 2;', 'var HIDDEN = 1;'],
  ['ROWS', 'both', 'var ROWS = 22; ', 'var ROWS = 23; '],
  ['SPAWN_X', 'both', 'var SPAWN_X = 3, SPAWN_Y = 1;', 'var SPAWN_X = 4, SPAWN_Y = 1;'],
  ['SPAWN_Y', 'both', 'var SPAWN_X = 3, SPAWN_Y = 1;', 'var SPAWN_X = 3, SPAWN_Y = 0;'],
  ['BOX I', 'both', 'var BOX = [4, 4, 3, 3, 3, 3, 3];', 'var BOX = [3, 4, 3, 3, 3, 3, 3];'],
  ['BASE T', 'both', '    [[1, 0], [0, 1], [1, 1], [2, 1]],\n', '    [[1, 0], [0, 1], [1, 1], [1, 2]],\n'],
  ['KICKS 0>1 test 3', 'both', '    1: [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],\n    4:', '    1: [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 1]],\n    4:'],
  ['KICKS 1>2 test 2', 'both', '    6: [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],\n    9:', '    6: [[0, 0], [1, 0], [1, 0], [0, -2], [1, -2]],\n    9:'],
  ['KICKS 3>0 test 1', 'both', '    12: [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],\n    3:', '    12: [[0, 0], [1, 0], [-1, 1], [0, -2], [-1, -2]],\n    3:'],
  ['KICKS_I 0>1 test 4', 'both', '    1: [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],\n    4: [[0, 0], [2, 0], [-1, 0]', '    1: [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -1]],\n    4: [[0, 0], [2, 0], [-1, 0]'],
  ['KICKS_I 2>3 test 1', 'both', '    11: [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],\n    14: [[0, 0], [-2, 0]', '    11: [[0, 0], [1, 0], [-1, 0], [2, -1], [-1, 2]],\n    14: [[0, 0], [-2, 0]'],
  ['hash constant', 'both', 'Math.imul(a | 0, 0x9E3779B1)', 'Math.imul(a | 0, 0x9E3779B3)'],
  ['hash mix', 'both', 'h ^= h >>> 15; h = Math.imul(h, 0x846CA68B)', 'h ^= h >>> 14; h = Math.imul(h, 0x846CA68B)'],
  // ── rules logic ──────────────────────────────────────────────────────────
  ['seed: 7 hex digits', 'both', 'parseInt(seedHex.slice(0, 8), 16)', 'parseInt(seedHex.slice(0, 7), 16)'],
  ['seed ignored', 'both', 'seed: seedInt >>> 0, board: b,', 'seed: 7, board: b,'],
  ['bag of 8', 'both', 'var bag = Math.floor(k / 7), arr', 'var bag = Math.floor(k / 8), arr'],
  ['shuffle skips a draw', 'both', 'for (i = 6; i >= 1; i--) {', 'for (i = 6; i >= 2; i--) {'],
  ['shuffle range', 'both', 'var j = hash32(seedInt, bag, i) % (i + 1);', 'var j = hash32(seedInt, bag, i) % i;'],
  ['O turns', 'both', 'if (t !== 1) for (k = 0; k < r; k++)', 'for (k = 0; k < r; k++)'],
  ['turn direction', 'both', 'var nx = n - 1 - y; y = x; x = nx;', 'var nx = y; y = n - 1 - x; x = nx;'],
  ['fits: floor open', 'both', 'if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return false;', 'if (cx < 0 || cx >= COLS || cy < 0 || cy > ROWS) return false;'],
  ['fits: right wall open', 'both', 'if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return false;', 'if (cx < 0 || cx > COLS || cy < 0 || cy >= ROWS) return false;'],
  ['fits: ceiling open', 'both', 'if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return false;', 'if (cx < 0 || cx >= COLS || cy >= ROWS) return false;'],
  ['fits: cells overlap', 'both', 'if (board[cy * COLS + cx]) return false;', ''],
  ['dropDistance +1', 'both', 'while (fits(board, p.t, p.r, p.x, p.y + d + 1)) d++;\n    return d;', 'while (fits(board, p.t, p.r, p.x, p.y + d + 1)) d++;\n    return d > 0 ? d - 1 : d;'],
  ['gravity clamp', 'both', 'return GRAVITY[Math.min(GRAVITY.length, level) - 1];', 'return GRAVITY[Math.min(GRAVITY.length - 1, level) - 1];'],
  ['spawn: bag index frozen', 'both', '    sim.k = sim.k + 1;\n', '    sim.k = sim.k + 0;\n'],
  ['spawn: no top-out', 'both', "if (!fits(sim.board, p.t, p.r, p.x, p.y)) { sim.cur = null; sim.dead = true;", "if (false) { sim.cur = null; sim.dead = true;"],
  ['spawn keeps gravity count', 'both', '    sim.gc = 0; sim.lockT = 0; sim.resets = 0;\n', '    sim.lockT = 0; sim.resets = 0;\n'],
  ['spawn keeps resets', 'both', '    sim.gc = 0; sim.lockT = 0; sim.resets = 0;\n', '    sim.gc = 0; sim.lockT = 0;\n'],
  ['reset cap <=', 'both', '&& sim.resets < LOCK_RESETS) { sim.lockT = 0;', '&& sim.resets <= LOCK_RESETS) { sim.lockT = 0;'],
  ['reset off the ground', 'both', 'if ((wasGround || grounded(sim)) && sim.resets', 'if ((true) && sim.resets'],
  ['reset only from ground before', 'both', 'if ((wasGround || grounded(sim)) && sim.resets', 'if ((grounded(sim)) && sim.resets'],
  ['reset does not restart wait', 'both', 'sim.resets < LOCK_RESETS) { sim.lockT = 0; sim.resets', 'sim.resets < LOCK_RESETS) { sim.resets'],
  ['b2b x2', 'both', 'base = Math.floor(base * 3 / 2);', 'base = Math.floor(base * 2);'],
  ['b2b on triples', 'both', 'if (full.length === 4 && sim.b2b) base', 'if (full.length >= 3 && sim.b2b) base'],
  ['b2b never set', 'both', '      sim.b2b = full.length === 4;\n', '      sim.b2b = false;\n'],
  ['b2b kept through a no-clear', 'both', '    } else {\n      sim.combo = -1;\n    }', '    } else {\n      sim.combo = -1; sim.b2b = false;\n    }'],
  ['combo bonus from first clear', 'both', 'if (sim.combo > 0) gained = gained + COMBO_POINTS', 'if (sim.combo >= 0) gained = gained + COMBO_POINTS'],
  ['combo not by level', 'both', 'COMBO_POINTS * sim.combo * level;', 'COMBO_POINTS * sim.combo;'],
  ['combo never ends', 'both', '    } else {\n      sim.combo = -1;\n    }', '    } else {\n    }'],
  ['clear scored at new level', 'both', 'var base = LINE_POINTS[full.length] * level;', 'var base = LINE_POINTS[full.length] * (1 + Math.floor((sim.lines + full.length) / LINES_PER_LEVEL));'],
  ['level formula', 'both', 'sim.level = 1 + Math.floor(sim.lines / LINES_PER_LEVEL);', 'sim.level = 1 + Math.floor((sim.lines + 1) / LINES_PER_LEVEL);'],
  ['lines not counted', 'both', 'sim.lines = sim.lines + full.length;', 'sim.lines = sim.lines + 1;'],
  ['row test misses a column', 'both', 'for (x = 0; x < COLS; x++) if (!nb[r * COLS + x]) { all = false; break; }', 'for (x = 1; x < COLS; x++) if (!nb[r * COLS + x]) { all = false; break; }'],
  ['cleared rows go to the bottom', 'both', 'nb = fresh.concat(kept);', 'nb = kept.concat(fresh);'],
  ['lock writes wrong colour', 'both', 'nb[(p.y + c[i][1]) * COLS + p.x + c[i][0]] = p.t + 1;', 'nb[(p.y + c[i][1]) * COLS + p.x + c[i][0]] = 1;'],
  ['wait swapped', 'both', 'sim.wait = full.length ? CLEAR_STEPS : SPAWN_STEPS;', 'sim.wait = full.length ? SPAWN_STEPS : CLEAR_STEPS;'],
  ['score lost on lock', 'both', '    sim.score = sim.score + gained;\n', ''],
  ['action 7 allowed', 'both', 'a !== 5 && a !== 6) return \'bad_action\';', 'a !== 5 && a !== 6 && a !== 7) return \'bad_action\';'],
  ['act cap >', 'both', "if (sim.n >= MAX_ACTS) return 'act_cap';", "if (sim.n > MAX_ACTS) return 'act_cap';"],
  ['soft on not counted', 'both', "if (a === A_SOFT_ON) { if (sim.soft) return 'no_change'; sim.soft = true; sim.n = sim.n + 1; return true; }", "if (a === A_SOFT_ON) { if (sim.soft) return 'no_change'; sim.soft = true; return true; }"],
  ['soft on twice accepted', 'both', "if (a === A_SOFT_ON) { if (sim.soft) return 'no_change';", "if (a === A_SOFT_ON) {"],
  ['soft off ignored', 'both', "if (!sim.soft) return 'no_change'; sim.soft = false;", "if (!sim.soft) return 'no_change'; sim.soft = true;"],
  ['move through blocks', 'both', "if (!fits(sim.board, p.t, p.r, p.x + dx, p.y)) return 'blocked';", ''],
  ['left is right', 'both', 'var dx = a === A_LEFT ? -1 : 1, g0', 'var dx = a === A_LEFT ? 1 : -1, g0'],
  ['move not counted', 'both', '      touched(sim, g0);\n      sim.n = sim.n + 1;', '      touched(sim, g0);'],
  ['O allowed to turn', 'both', "if (p.t === 1) return 'no_turn';", ''],
  ['anticlockwise is clockwise', 'both', 'var to = (p.r + (a === A_CW ? 1 : 3)) % 4,', 'var to = (p.r + (a === A_CW ? 1 : 1)) % 4,'],
  ['I uses JLSTZ kicks', 'both', 'table = p.t === 0 ? KICKS_I : KICKS,', 'table = KICKS,'],
  ['only the first kick', 'both', 'for (var i = 0; i < tests.length; i++) {', 'for (var i = 0; i < 1; i++) {'],
  ['kick y sign', 'both', 'var nx = p.x + tests[i][0], ny = p.y + tests[i][1];', 'var nx = p.x + tests[i][0], ny = p.y - tests[i][1];'],
  ['turn does not touch', 'both', '          touched(sim, g1);\n', ''],
  ['hard drop +1 point', 'both', 'sim.score = sim.score + HARD_POINTS * d;', 'sim.score = sim.score + HARD_POINTS * (d + 1);'],
  ['hard drop not counted', 'both', '    sim.score = sim.score + HARD_POINTS * d;\n    sim.n = sim.n + 1;', '    sim.score = sim.score + HARD_POINTS * d;'],
  ['beginStep keeps events', 'both', 'function beginStep(sim) { sim.ev = []; }', 'function beginStep(sim) { }'],
  ['spawn wait <', 'both', 'if (sim.wait > 0) sim.wait = sim.wait - 1;\n      if (sim.wait === 0) spawn(sim);', 'if (sim.wait > 0) sim.wait = sim.wait - 1;\n      if (sim.wait <= 1) spawn(sim);'],
  ['soft equals gravity', 'both', 'if (sim.soft && SOFT_G < g) g = SOFT_G;', 'if (sim.soft && SOFT_G <= g) g = SOFT_G;'],
  ['soft off', 'both', 'if (sim.soft && SOFT_G < g) g = SOFT_G;', ''],
  ['gravity >', 'both', '      if (sim.gc >= g) {\n', '      if (sim.gc > g) {\n'],
  ['gravity count kept', 'both', '        sim.gc = 0;\n        if (!grounded(sim)) {', '        if (!grounded(sim)) {'],
  ['lock >', 'both', 'if (sim.lockT >= LOCK_STEPS) lockPiece(sim, false);', 'if (sim.lockT > LOCK_STEPS) lockPiece(sim, false);'],
  ['lock wait kept in the air', 'both', '      } else {\n        sim.lockT = 0;\n      }', '      } else {\n      }'],
  ['clock end >', 'both', 'if (!sim.dead && sim.frame >= RUN_STEPS) {', 'if (!sim.dead && sim.frame > RUN_STEPS) {'],
  ['clock end off', 'both', 'if (!sim.dead && sim.frame >= RUN_STEPS) {', 'if (false) {'],
  // ── validator only ───────────────────────────────────────────────────────
  ['v: rewind allowed', 'validator', "if (sim.frame !== step) return reject(state, step < sim.frame ? 'frame_regressed' : 'beyond_cap');", "if (sim.frame > step) return reject(state, 'beyond_cap');"],
  ['v: index not checked', 'validator', "if (n !== sim.n) return reject(state, 'out_of_order');", ''],
  ['v: v1 replays', 'validator', 'if (Number(payload.v) >= 2 && state.mode', 'if (Number(payload.v) >= 1 && state.mode'],
  ['v: restart on second marker', 'validator', "if (Number(payload.v) >= 2 && state.mode !== 'sim') {", 'if (Number(payload.v) >= 2) {'],
  ['v: no run-out', 'validator', 'while (!sim.dead && guard < runOutSteps && sim.frame < capSteps && sim.frame < MAX_SIM_STEPS) {', 'while (false) {'],
  ['v: no elapsed cap', 'validator', 'while (!sim.dead && guard < runOutSteps && sim.frame < capSteps && sim.frame < MAX_SIM_STEPS) {', 'while (!sim.dead && guard < runOutSteps && sim.frame < MAX_SIM_STEPS) {'],
  ['v: elapsed cap 1x', 'validator', 'return Math.ceil((e * 1.2 + 10) * fps);', 'return Math.ceil((e * 1.0 + 10) * fps);'],
  ['v: input cap off', 'validator', "if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');", ''],
  ['v: input cap small', 'validator', 'const MAX_INPUTS = MAX_ACTS + 20000;', 'const MAX_INPUTS = MAX_ACTS - 1;'],
  ['v: fraction accepted', 'validator', 'v >= 0 && Math.floor(v) === v;', 'v >= 0;'],
  ['v: string accepted', 'validator', "return typeof v === 'number' && Number.isFinite(v)", "return v !== null && Number.isFinite(Number(v))"],
  ['v: step guard off', 'validator', "if (sim.frame !== step) return reject(state, step < sim.frame ? 'frame_regressed' : 'beyond_cap');", ''],
  ['v: suspicious threshold', 'validator', 'state.rejectCount >= 10 ?', 'state.rejectCount >= 11 ?'],
  ['v: refused act counted', 'validator', "if (r !== true) return reject(state, 'refused:' + r);", ''],
  ['v: acts after the step', 'validator', '  while (!sim.dead && sim.frame < step && sim.frame < MAX_SIM_STEPS) stepOnce(state);', '  while (!sim.dead && sim.frame <= step && sim.frame < MAX_SIM_STEPS) stepOnce(state);'],
  ['v: step not opened before acts', 'validator', '  openStep(state);\n  const piece = sim.cur;', '  const piece = sim.cur;'],
  ['v: finesse not recorded', 'validator', 'if (min !== null) st.finesse.push(Math.max(0, p.moves - min));', ''],
  ['v: placement not recorded', 'validator', '      st.place.push(sim.frame - p.at);\n', ''],
  ['v: acts per step not recorded', 'validator', 'if (st.perStep > st.maxPerStep) st.maxPerStep = st.perStep;', ''],
  ['v: wrong seed parse', 'validator', 'state.sim = initSim(seedToInt(state.seed));', 'state.sim = initSim(0);'],
  // ── client only ──────────────────────────────────────────────────────────
  ['c: emit before accept', 'game', "    var r = G.actSim(sim, a);\n    if (r === true) {\n      // The ACTION only, never its result: the server replays it.\n      if (live && traceVersion >= 2 && typeof window.__kjAct === 'function') { try { window.__kjAct(performance.now(), n, a, step); } catch (_e) {} }",
    "    if (live && traceVersion >= 2 && typeof window.__kjAct === 'function') { try { window.__kjAct(performance.now(), n, a, step); } catch (_e) {} }\n    var r = G.actSim(sim, a);\n    if (r === true) {"],
  ['c: step emitted +1', 'game', 'window.__kjAct(performance.now(), n, a, step); }', 'window.__kjAct(performance.now(), n, a, step + 1); }'],
  ['c: n emitted after the act', 'game', 'window.__kjAct(performance.now(), n, a, step); }', 'window.__kjAct(performance.now(), sim.n, a, step); }'],
  ['c: stepSim before the acts', 'game', '    var sim = st.sim;\n    G.beginStep(sim);\n', '    var sim = st.sim;\n    G.beginStep(sim);\n    if (!sim.dead) G.stepSim(sim);\n'],
  ['c: buffered act dropped', 'game', 'if (buffered && sim.cur) { var b = buffered; buffered = null; applyAct(sim, b.a, true); }', 'if (buffered && sim.cur) { buffered = null; }'],
  ['c: buffered act not emitted', 'game', 'if (buffered && sim.cur) { var b = buffered; buffered = null; applyAct(sim, b.a, true); }', 'if (buffered && sim.cur) { var b = buffered; buffered = null; applyAct(sim, b.a, false); }'],
  ['c: no buffering', 'game', "if (live && r === 'no_piece' && BUFFERABLE[a]) buffered", "if (false) buffered"],
  ['c: DAS 9', 'game', 'var DAS_STEPS = 10, ARR_STEPS = 2;', 'var DAS_STEPS = 9, ARR_STEPS = 2;'],
  ['c: ARR 3', 'game', 'var DAS_STEPS = 10, ARR_STEPS = 2;', 'var DAS_STEPS = 10, ARR_STEPS = 3;'],
  ['c: MOVE_PX 23', 'game', 'AXIS_PX = 12, MOVE_PX = 24;', 'AXIS_PX = 12, MOVE_PX = 23;'],
  ['c: AXIS_PX 10', 'game', 'AXIS_PX = 12, MOVE_PX = 24;', 'AXIS_PX = 10, MOVE_PX = 24;'],
  ['c: SOFT_MS 120', 'game', 'SOFT_MS = 180,', 'SOFT_MS = 120,'],
  ['c: SWIPE_MS 500', 'game', 'SWIPE_MS = 300,', 'SWIPE_MS = 500,'],
  ['c: SWIPE_DY 70', 'game', 'SWIPE_DY = 34,', 'SWIPE_DY = 70,'],
  ['c: TAP_MOVE 4', 'game', 'var TAP_MOVE = 14,', 'var TAP_MOVE = 4,'],
  ['c: frame delta physics', 'game', 'while (acc >= 1 / 60) { acc -= 1 / 60; processStep();', 'while (acc >= 0) { acc -= 1 / 60; processStep();'],
  ['c: submit at once', 'game', 'setTimeout(submitNow, EMBED ? 2200 : 0);', 'submitNow();'],
  ['c: no hidden-tab timer', 'game', 'setInterval(function () { if (document.hidden) pump(performance.now()); }, 1000);', ''],
  ['c: two runs a session', 'game', 'if (EMBED && runsStarted > 0) return;', ''],
  ['c: qa switches embedded', 'game', "var Q = EMBED ? '' : location.search;", 'var Q = location.search;'],
  ['c: debug hook embedded', 'game', 'if (!EMBED) window.__ts = {', 'if (true) window.__ts = {'],
  ['c: practice emits', 'game', '    var r = applyAct(s, a, false);', '    var r = applyAct(s, a, true);'],
  ['c: session not awaited', 'game', '  function newRun() {\n    if (!sessionReady) return;', '  function newRun() {'],
  ['c: session not awaited anywhere', 'game', "    if (!sessionReady) return;\n    var showTut", '    var showTut'],
  ['c: multi-press counts', 'game', 'window.KJPress.bind(function (e) {', "window.addEventListener('pointerdown', function (e) { if (e.target !== canvas) return;"],
  ['c: replay skips the guard', 'game', 'if (wholeNum(rp.n) && wholeNum(rp.a) && wholeNum(rp.step) && rp.step === sim.frame && rp.n === sim.n) applyAct(sim, rp.a, false);', 'applyAct(sim, Number(rp.a), false);'],
  ['c: replay takes real input', 'game', '  function act(a) {\n    if (RP) return;', '  function act(a) {'],
  ['c: trace version not marked', 'game', "traceVersion = (typeof window.__kjGameStart === 'function') ? (Number(window.__kjGameStart(performance.now(), G.RULES_VERSION)) || 0) : 0;", 'traceVersion = 2;'],
];

const INERT = {
  // HIDDEN is read only by the drawing (where the well starts); the rules block
  // declares it but never uses it, so the world cannot change. Measured: the
  // block has one occurrence of HIDDEN (the declaration). The pin table catches
  // it; under --nopin it is expected to survive. ROWS 23 is its large variant.
  'HIDDEN': 'declared in the rules block, never read by a rule (drawing only)',
  // Every caller of newRun already checks sessionReady (PLAY, the practice's
  // PLAY, SKIP via endTut), and PLAY AGAIN only exists after a session. Measured:
  // 4 call sites, each guarded. 'c: session not awaited anywhere' (PLAY's own
  // check removed too) is its large variant and must be caught.
  'c: session not awaited': 'every caller already waits for the session',
  // In a replay processStep reads only the replay cursor and never the pending
  // queue, so a real input that slips past act() is still never applied.
  // Measured: the replay branch of processStep has no read of `pending`.
  // 'c: replay ignores acts' style large variant: the cursor guard removal is caught.
  'c: replay takes real input': 'the replay step never reads the live input queue',
};

function read(f) { return fs.readFileSync(FILES[f], 'utf8'); }
function targets(where) { return where === 'both' ? ['rules', 'validator'] : [where]; }

function check() {
  let bad = 0;
  for (const [name, where, find] of M) {
    for (const f of targets(where)) {
      const n = read(f).split(find).length - 1;
      if (n !== 1) { console.log(`MATCH ${n}x in ${f}: ${name}`); bad++; }
    }
  }
  console.log(bad ? `${bad} bad find strings` : `all ${M.length} mutations match exactly once`);
  return bad;
}

function runSuites() {
  for (const suite of SUITES) {
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/jest'), ['--runInBand', '--silent', '--ci', '--bail', suite],
      { cwd: ROOT, encoding: 'utf8', timeout: SUITE_TIMEOUT_MS, env: Object.assign({}, process.env, { CI: '1' }, NOPIN ? { TS_SKIP_PIN: '1' } : {}) });
    if (r.error && r.error.code === 'ETIMEDOUT') return false;   // a hang is a catch
    if (r.status !== 0) return false;
  }
  return true;
}

function insideGitTree() {
  let d = ROOT;
  for (;;) { if (fs.existsSync(path.join(d, '.git'))) return true; const up = path.dirname(d); if (up === d) return false; d = up; }
}

function main() {
  const args = process.argv.slice(2);
  let shard = null, only = null, list = false, doCheck = false, all = false, from = 0, scratchOk = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'all') all = true;
    else if (a === '--shard') { const [x, k] = String(args[++i]).split('/').map(Number); if (!(x >= 1 && k >= 1 && k <= 3 && x <= k)) { console.error('--shard x/k with k at most 3'); process.exit(2); } shard = { x, k }; }
    else if (a === '--only') only = String(args[++i]).split(/[|,]/);
    else if (a === '--list') list = true;
    else if (a === '--from') from = Number(args[++i]);
    else if (a === '--check') doCheck = true;
    else if (a === '--nopin') NOPIN = true;
    else if (a === '--scratch-ok') scratchOk = true;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (list) { M.forEach((m, i) => console.log(i, m[0])); return; }
  if (doCheck) process.exit(check() ? 1 : 0);
  if (!all && !only) { console.error('say "all" or --only'); process.exit(2); }
  if (insideGitTree() && !scratchOk) { console.error('refusing to rewrite a git working tree: copy the tree to a scratch directory and run there'); process.exit(2); }
  if (check()) process.exit(1);
  const originals = { rules: read('rules'), game: read('game'), validator: read('validator') };
  const restore = () => { for (const f of Object.keys(FILES)) fs.writeFileSync(FILES[f], originals[f]); };
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('SIGTERM', () => { restore(); process.exit(143); });
  if (!runSuites()) { console.error('ABORT: the suites fail with no mutation'); process.exit(1); }
  const survivors = [];
  let caughtN = 0, inertN = 0;
  M.forEach(([name, where, find, rep], i) => {
    if (i < from) return;
    if (shard && (i % shard.k) !== shard.x - 1) return;
    if (only && !only.includes(name)) return;
    for (const f of targets(where)) fs.writeFileSync(FILES[f], originals[f].replace(find, rep));
    const caught = !runSuites();
    restore();
    const inert = Object.prototype.hasOwnProperty.call(INERT, name);
    console.log(`${caught ? 'caught  ' : inert ? 'inert   ' : 'SURVIVED'} ${i} ${name}`);
    if (caught) caughtN++; else if (inert) inertN++; else survivors.push(name);
  });
  console.log(`${caughtN} caught, ${inertN} inert, ${survivors.length} survivors` + (survivors.length ? `: ${survivors.join(', ')}` : ''));
}

if (require.main === module) main();
module.exports = { M, INERT };
