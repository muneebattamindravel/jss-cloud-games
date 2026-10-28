'use strict';

/**
 * Snake Blocks mutation battery. Each entry breaks the game or the validator
 * one way and runs the parity, adversarial and render suites; a mutation the
 * suites do not notice is a hole in the TESTS.
 *
 * It rewrites source files, so it only ever runs from a SCRATCH COPY of the tree
 * (games/snake-blocks, games/_shared, shared/, sdk/ and a node_modules link),
 * never the working tree other sessions share:
 *
 *   SB_MUTATE_SCRATCH=1 node shared/tests/lib/snakeBlocksMutate.js [NAME|all] [--shard i/k] [--only A|B]
 *   node shared/tests/lib/snakeBlocksMutate.js --check      (read-only: every find string must match once)
 *
 * NAME matches one mutation exactly (e.g. S2, R10). Anything unknown exits 2.
 *
 * Last full run (1 Oct 2026): 143 of 143 live mutations caught, 2 known-inert, 0
 * survivors. The first pass left 24 survivors, all edge-gated geometry or
 * bookkeeping a flown corpus never reaches; each is now pinned by hand in
 * snakeBlocksAdversarial.test.js. The two inert ones carry their proof:
 *   R64  `d < -HEAD_MAX_STEP + 1` for integers d returns px - 13 on d = -13 just as the
 *        original returns x (= px - 13), and for d >= -12 returns x, so it is the
 *        same function on every integer input.
 *   R76  `lo >= hi` differs from `lo > hi` only when the allowed span is a single
 *        point. Every limit is a multiple of the lane width plus a head or divider
 *        margin, so a span of exactly zero would need k * 80 to equal 30, 33 or 36;
 *        pinned by the 'one-lane channel' test.
 */

const fs = require('fs'); const { execSync } = require('child_process');
const VAL = 'shared/anticheat/validators/snakeBlocks.js', GAME = 'games/snake-blocks/js/game.js';
const BOTH = [VAL, GAME];
const M = [
  // ── server-only plumbing (outside the rules block) ──
  ['S1 rewind by one allowed', [VAL], 'if (f < sim.frames) return', 'if (f < sim.frames - 1) return'],
  ['S2 batch applied one step late', [VAL], '  advanceTo(state, f);\n  for (let i', '  advanceTo(state, f + 1);\n  for (let i'],
  ['S3 bad sample accepted', [VAL], "    if (!isHeadX(xs[i])) return reject(state, 'bad_sample');\n", ''],
  ['S4 head range widened', [VAL], 'v >= X_MIN && v <= X_MAX', 'v >= X_MIN - 1 && v <= X_MAX'],
  ['S5 elapsed cap loosened', [VAL], 'Math.ceil((e * 1.2 + 10) * fps)', 'Math.ceil((e * 2 + 10) * fps)'],
  ['S6 no start marker still replays', [VAL], "  if (state.mode !== 'sim') return { accepted: true, newScore: state.score };\n  if (kind === 'touch'", "  if (state.mode !== 'sim') { state.mode = 'sim'; state.sim = initSim(state.seed); }\n  if (kind === 'touch'"],
  ['S7 v1 marker replays', [VAL], 'if (Number(payload.v) >= MIN_REPLAY_VERSION && state.mode', 'if (Number(payload.v) >= 1 && state.mode'],
  ['S8 input cap never checked', [VAL], "  if (state.inputCount + xs.length > MAX_INPUTS) return reject(state, 'input_cap');\n", ''],
  ['S9 empty batch allowed', [VAL], 'xs.length === 0 || ', ''],
  ['S10 finalize does not run out', [VAL], '    stepWatch(state, state.down, state.lastX);\n    guard++;', '    guard++;'],
  ['S11 fractional step allowed', [VAL], "return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;", "return typeof v === 'number' && Number.isFinite(v) && v >= 0;"],
  ['S12 dead batch not reported', [VAL], '  if (sim.dead) return died(state);\n  state.score = sim.score;\n  return { accepted: true, newScore: state.score };\n}\n\n// Bounded', '  state.score = sim.score;\n  return { accepted: true, newScore: state.score };\n}\n\n// Bounded'],
  ['S13 too-late check off', [VAL], "  if (f >= MAX_SIM_STEPS) return reject(state, 'too_late');\n", ''],
  ['S14 path accepted while up', [VAL], "  if (!state.down) return reject(state, 'not_down');\n", ''],
  ['S15 touch while down allowed', [VAL], "    if (state.down) return reject(state, 'bad_marker');\n    advanceTo(state, step - 1);\n    if (sim.dead) return died(state);\n    state.down = true;", "    advanceTo(state, step - 1);\n    if (sim.dead) return died(state);\n    state.down = true;"],
  ['S16 lift without touch allowed', [VAL], "    if (!state.down) return reject(state, 'bad_marker');\n    advanceTo(state, step - 1);\n    if (sim.dead) return died(state);\n    state.down = false;", "    advanceTo(state, step - 1);\n    if (sim.dead) return died(state);\n    state.down = false;"],
  ['S17 marker rewind allowed', [VAL], "  if (step - 1 < sim.frames) return reject(state, 'frame_regressed');", ''],
  ['S18 touch does not advance the world', [VAL], "    if (state.down) return reject(state, 'bad_marker');\n    advanceTo(state, step - 1);", "    if (state.down) return reject(state, 'bad_marker');"],
  ['S19 lift does not advance the world', [VAL], "    if (!state.down) return reject(state, 'bad_marker');\n    advanceTo(state, step - 1);", "    if (!state.down) return reject(state, 'bad_marker');"],
  ['S20 gap before a batch not run', [VAL], '  advanceTo(state, f);\n  for (let i', '  for (let i'],
  ['S21 held position not kept across a gap', [VAL], 'state.lastX = xs[i];\n', ''],
  ['S22 down state lost at run-out', [VAL], "    stepWatch(state, state.down, state.lastX);\n    guard++;", "    stepWatch(state, false, state.lastX);\n    guard++;"],
  ['S23 batch length cap off', [VAL], 'xs.length > PATH_BATCH_MAX', 'xs.length > PATH_BATCH_MAX + 1'],
  ['S24 start resets a live run', [VAL], "if (Number(payload.v) >= MIN_REPLAY_VERSION && state.mode !== 'sim') {", "if (Number(payload.v) >= MIN_REPLAY_VERSION) {"],
  ['S25 marker step 0 allowed', [VAL], 'if (!isStep(step) || step < 1) return reject', 'if (!isStep(step)) return reject'],
  // ── rules block, changed identically in BOTH files (the cross-file check cannot see these) ──
  ['R1 HEAD_MAX_STEP 14', BOTH, 'const HEAD_MAX_STEP = 13;', 'const HEAD_MAX_STEP = 14;'],
  ['R2 HEAD_R 16', BOTH, 'const HEAD_R = 15;', 'const HEAD_R = 16;'],
  ['R3 COL_W 81', BOTH, 'const COL_W = 80;', 'const COL_W = 81;'],
  ['R4 ROW_HQ +16', BOTH, 'const ROW_HQ = 176 * U;', 'const ROW_HQ = 177 * U;'],
  ['R5 BLOCK_HQ +16', BOTH, 'const BLOCK_HQ = 64 * U;', 'const BLOCK_HQ = 65 * U;'],
  ['R6 WALL_GAPQ 9', BOTH, 'const WALL_GAPQ = 8 * U;', 'const WALL_GAPQ = 9 * U;'],
  ['R7 WALL_LENQ 97', BOTH, 'const WALL_LENQ = 96 * U;', 'const WALL_LENQ = 97 * U;'],
  ['R8 WALL_HALF 4', BOTH, 'const WALL_HALF = 3;', 'const WALL_HALF = 4;'],
  ['R9 PICK_R 15', BOTH, 'const PICK_R = 14;', 'const PICK_R = 15;'],
  ['R10 START_LEN 5', BOTH, 'const START_LEN = 4;', 'const START_LEN = 5;'],
  ['R11 START_GUARD_STEPS 28', BOTH, 'const START_GUARD_STEPS = 27;', 'const START_GUARD_STEPS = 28;'],
  ['R12 ARM_TIMEOUT_STEPS 1801', BOTH, 'const ARM_TIMEOUT_STEPS = 1800;', 'const ARM_TIMEOUT_STEPS = 1801;'],
  ['R13 SPEED_BASE 55', BOTH, 'const SPEED_BASE = 54;', 'const SPEED_BASE = 55;'],
  ['R14 SPEED_CAP 129', BOTH, 'const SPEED_CAP = 128;', 'const SPEED_CAP = 129;'],
  ['R15 HIT_BASE 4', BOTH, 'const HIT_BASE = 3;', 'const HIT_BASE = 4;'],
  ['R16 HIT_MIN 2', BOTH, 'const HIT_MIN = 1;', 'const HIT_MIN = 2;'],
  ['R17 HIT_SPEEDUP 151', BOTH, 'const HIT_SPEEDUP = 150;', 'const HIT_SPEEDUP = 151;'],
  ['R18 FULL_FROM 5', BOTH, 'const FULL_FROM = 4;', 'const FULL_FROM = 5;'],
  ['R19 FULL_SLACK 3', BOTH, 'const FULL_SLACK = 2;', 'const FULL_SLACK = 3;'],
  ['R20 PHASE_LENS entry', BOTH, 'const PHASE_LENS = [4, 3, 5, 4, 6, 3, 5, 4];', 'const PHASE_LENS = [4, 3, 5, 4, 6, 3, 5, 5];'],
  ['R21 PHASE_CYCLE 35', BOTH, 'const PHASE_CYCLE = 34;', 'const PHASE_CYCLE = 35;'],
  ['R22 SCATTER_FROM 3', BOTH, 'const SCATTER_FROM = 2;', 'const SCATTER_FROM = 3;'],
  ['R23 PICK_CHANCE 63', BOTH, 'const PICK_CHANCE = 62;', 'const PICK_CHANCE = 63;'],
  ['R24 PICK_MIN 3', BOTH, 'const PICK_MIN = 2;', 'const PICK_MIN = 3;'],
  ['R25 WALL_FROM 9', BOTH, 'const WALL_FROM = 8;', 'const WALL_FROM = 9;'],
  ['R26 RNG_STRIDE', BOTH, 'const RNG_STRIDE = 0x9E3779B1;', 'const RNG_STRIDE = 0x9E3779B3;'],
  ['R27 ROW_SALT', BOTH, 'const ROW_SALT = 0x5BF03635;', 'const ROW_SALT = 0x5BF03637;'],
  ['R28 FULL_SALT', BOTH, 'const FULL_SALT = 0x1B873593;', 'const FULL_SALT = 0x1B873595;'],
  ['R29 PATH_EASY_ROWS 25', BOTH, 'const PATH_EASY_ROWS = 24;', 'const PATH_EASY_ROWS = 25;'],
  ['R30 PATH_SALT', BOTH, 'const PATH_SALT = 0x27D4EB2F;', 'const PATH_SALT = 0x27D4EB31;'],
  ['R31 DENSE_FROM 41', BOTH, 'const DENSE_FROM = 40;', 'const DENSE_FROM = 41;'],
  ['R32 CHAIN_MAX 9', BOTH, 'const CHAIN_MAX = 8;', 'const CHAIN_MAX = 9;'],
  ['R33 CHAIN_GAP 3', BOTH, 'const CHAIN_GAP = 2;', 'const CHAIN_GAP = 3;'],
  ['R34 a path table entry', BOTH, '  [2, 1, 0, 1, 2, 3, 4, 3],\n  [2, 3, 4, 3, 2, 1, 0, 1],\n  [2, 0, 1, 2, 4, 3, 2, 1],', '  [2, 1, 0, 1, 2, 3, 4, 3],\n  [2, 3, 4, 3, 2, 1, 0, 1],\n  [2, 0, 1, 2, 4, 3, 1, 1],'],
  ['R35 valFor first band slope', BOTH, 'return 2 + Math.floor(n / 3);', 'return 2 + Math.floor(n / 4);'],
  ['R36 valFor second band', BOTH, 'return 14 + Math.floor((n - 36) / 7);', 'return 14 + Math.floor((n - 36) / 8);'],
  ['R37 valFor third band', BOTH, 'return 26 + Math.floor((n - 120) / 18);', 'return 26 + Math.floor((n - 120) / 19);'],
  ['R38 valFor tail', BOTH, 'return 42 + Math.floor((n - 400) / 55);', 'return 42 + Math.floor((n - 400) / 56);'],
  ['R39 taxFor early', BOTH, '  if (n < 50) return 3;', '  if (n < 50) return 2;'],
  ['R40 taxFor mid', BOTH, '  if (n < 300) return 5;', '  if (n < 300) return 6;'],
  ['R41 taxFor tail', BOTH, 'return 9 + Math.floor((n - 960) / 260);', 'return 9 + Math.floor((n - 960) / 261);'],
  ['R42 pickChanceFor late', BOTH, 'return PICK_CHANCE - 20;', 'return PICK_CHANCE - 21;'],
  ['R43 pickChanceFor mid', BOTH, 'if (n < 220) return PICK_CHANCE - 6;', 'if (n < 220) return PICK_CHANCE - 7;'],
  ['R44 hitSteps floor', BOTH, 'return s < HIT_MIN ? HIT_MIN : s;', 'return s <= HIT_MIN ? HIT_MIN + 1 : s;'],
  ['R45 fullRowAt phase rotation', BOTH, 'n += phaseLen(seedInt, i);', 'n += phaseLen(seedInt, i + 1);'],
  ['R46 fullIndexAt strict', BOTH, '    if (acc === d) return c * PHASE_N + i;', '    if (acc === d + 0 && i >= 0 && false) return c * PHASE_N + i;'],
  ['R47 anchorAt easy pool', BOTH, 'const pool = b * PATH_LEN < PATH_EASY_ROWS ? PATH_EASY : LANE_PATHS.length;', 'const pool = b * PATH_LEN < PATH_EASY_ROWS ? PATH_EASY + 1 : LANE_PATHS.length;'],
  ['R48 anchor row n < 0', BOTH, '  if (n < 0) return 2;', '  if (n < 0) return 1;'],
  ['R49 wallsValid boundary', BOTH, '  for (let b = lo + 1; b <= hi; b++) {\n    if (wmask', '  for (let b = lo + 1; b < hi; b++) {\n    if (wmask'],
  ['R50 wallsValid open lane', BOTH, 'if (!(bmask & (1 << c))) { open = true; break; }', 'if ((bmask & (1 << c))) { open = true; break; }'],
  ['R51 baseRow value spread', BOTH, 'vals[c] = 1 + Math.floor(rolls[j] * (v + 8));', 'vals[c] = 1 + Math.floor(rolls[j] * (v + 9));'],
  ['R52 baseRow cmax early', BOTH, '(n < 8 ? 1 : (n < 20 ? 2 :', '(n < 8 ? 1 : (n < 21 ? 2 :'],
  ['R53 baseRow dense phase', BOTH, '(n + (seedInt % 3)) % 3 === 0', '(n + (seedInt % 3)) % 4 === 0'],
  ['R54 baseRow pick value', BOTH, 'pick = { c: pc, v: PICK_MIN + Math.floor(pickValRoll * v) };', 'pick = { c: pc, v: PICK_MIN + Math.floor(pickValRoll * (v + 1)) };'],
  ['R55 baseRow wall max', BOTH, 'const wmax = n < WALL_FROM ? 0 : (n < 28 ? 1 : 2);', 'const wmax = n < WALL_FROM ? 0 : (n < 29 ? 1 : 2);'],
  ['R56 baseRow pick chance compare', BOTH, 'Math.floor(pickRoll * 100) < pickChanceFor(n)', 'Math.floor(pickRoll * 100) <= pickChanceFor(n)'],
  ['R57 fullRow cheap floor', BOTH, 'Math.max(sup[cheapCol] + 1, Math.min(', 'Math.max(sup[cheapCol], Math.min('],
  ['R58 fullRow cheap ceiling', BOTH, 'Math.min(Math.floor((budget * taxFor(n)) / 8) + FULL_SLACK, 2 * v)', 'Math.min(Math.floor((budget * taxFor(n)) / 8) + FULL_SLACK, 2 * v + 1)'],
  ['R59 fullRow other lanes', BOTH, 'vals[c] = Math.max(sup[c] + 1, cheap + 1 + Math.floor(extras[c] * (2 * v + 2)));', 'vals[c] = Math.max(sup[c] + 1, cheap + 1 + Math.floor(extras[c] * (2 * v + 3)));'],
  ['R60 fullRow supply accounting', BOTH, 'for (let m = prev + 1; m < n; m++) {', 'for (let m = prev + 2; m < n; m++) {'],
  ['R61 ensureRow chain reset', BOTH, 'if (sim.rowN - sim.chainRow > CHAIN_GAP) sim.chain = 0;', 'if (sim.rowN - sim.chainRow > CHAIN_GAP + 1) sim.chain = 0;'],
  ['R62 ensureRow pass test', BOTH, 'while (sim.rowN * ROW_HQ + BLOCK_HQ <= sim.scroll - HEAD_RQ) {', 'while (sim.rowN * ROW_HQ + BLOCK_HQ < sim.scroll - HEAD_RQ) {'],
  ['R63 travelTo up', BOTH, 'if (d > HEAD_MAX_STEP) return px + HEAD_MAX_STEP;', 'if (d >= HEAD_MAX_STEP) return px + HEAD_MAX_STEP + 1;'],
  ['R64 travelTo down', BOTH, 'if (d < -HEAD_MAX_STEP) return px - HEAD_MAX_STEP;', 'if (d < -HEAD_MAX_STEP + 1) return px - HEAD_MAX_STEP;'],
  ['R65 divider right margin', BOTH, 'const h = wx - HEAD_R - WALL_HALF;', 'const h = wx - HEAD_R - WALL_HALF + 1;'],
  ['R66 divider left margin', BOTH, 'const l = wx + HEAD_R + WALL_HALF;', 'const l = wx + HEAD_R + WALL_HALF - 1;'],
  ['R67 divider side test', BOTH, '      if (px < wx) {\n        const h', '      if (px <= wx) {\n        const h'],
  ['R68 divider span top', BOTH, 'if (sim.scroll + HEAD_RQ <= y0 || sim.scroll - HEAD_RQ >= y1) continue;', 'if (sim.scroll + HEAD_RQ < y0 || sim.scroll - HEAD_RQ >= y1) continue;'],
  ['R69 divider span bottom', BOTH, 'if (sim.scroll + HEAD_RQ <= y0 || sim.scroll - HEAD_RQ >= y1) continue;', 'if (sim.scroll + HEAD_RQ <= y0 || sim.scroll - HEAD_RQ > y1) continue;'],
  ['R70 divider look-ahead rows', BOTH, '  for (let k = 0; k < 2; k++) {\n    const m = n + k;', '  for (let k = 0; k < 1; k++) {\n    const m = n + k;'],
  ['R71 block band test', BOTH, 'if (sim.scroll + HEAD_RQ > nb && sim.scroll - HEAD_RQ < nb + BLOCK_HQ) {', 'if (sim.scroll + HEAD_RQ >= nb && sim.scroll - HEAD_RQ < nb + BLOCK_HQ) {'],
  ['R72 block band bottom', BOTH, 'sim.scroll - HEAD_RQ < nb + BLOCK_HQ) {', 'sim.scroll - HEAD_RQ <= nb + BLOCK_HQ) {'],
  ['R73 block edge right', BOTH, 'const h = colLeft(c) - HEAD_R;', 'const h = colLeft(c) - HEAD_R + 1;'],
  ['R74 block edge left', BOTH, 'const l = colRight(c) + HEAD_R;', 'const l = colRight(c) + HEAD_R - 1;'],
  ['R75 block side test', BOTH, '      if (px < colLeft(c)) {', '      if (px <= colLeft(c)) {'],
  ['R76 jammed head stays', BOTH, '  if (lo > hi) return px;', '  if (lo >= hi) return px;'],
  ['R77 slide-out bound up', BOTH, 'if (out - px > HEAD_MAX_STEP) out = px + HEAD_MAX_STEP;', 'if (out - px > HEAD_MAX_STEP + 1) out = px + HEAD_MAX_STEP;'],
  ['R78 slide-out bound down', BOTH, 'if (out - px < -HEAD_MAX_STEP) out = px - HEAD_MAX_STEP;', 'if (out - px < -HEAD_MAX_STEP - 1) out = px - HEAD_MAX_STEP;'],
  ['R79 firstBlocking right edge', BOTH, 'if (sim.hx + HEAD_R > colLeft(c) && sim.hx - HEAD_R < colRight(c)) return c;', 'if (sim.hx + HEAD_R >= colLeft(c) && sim.hx - HEAD_R < colRight(c)) return c;'],
  ['R80 firstBlocking left edge', BOTH, 'sim.hx - HEAD_R < colRight(c)) return c;', 'sim.hx - HEAD_R <= colRight(c)) return c;'],
  ['R81 pick radius', BOTH, 'if (dxq * dxq + dyq * dyq > PICK_RQ * PICK_RQ) return;', 'if (dxq * dxq + dyq * dyq >= PICK_RQ * PICK_RQ) return;'],
  ['R82 pick once per row', BOTH, '  if (n <= sim.lastPick) return;', '  if (n < sim.lastPick) return;'],
  ['R83 pick adds its value', BOTH, '  sim.len += g.v;\n  sim.picks++;', '  sim.len += g.v + 0 * 1 + (g.v > 8 ? 1 : 0);\n  sim.picks++;'],
  ['R84 pick centre y', BOTH, 'const dyq = sim.scroll - (n * ROW_HQ + PICK_YQ);', 'const dyq = sim.scroll - (n * ROW_HQ + PICK_YQ + 1);'],
  ['R85 arming guard', BOTH, 'if (down && sim.frames >= START_GUARD_STEPS) sim.armed = true;', 'if (down && sim.frames > START_GUARD_STEPS) sim.armed = true;'],
  ['R86 idle death', BOTH, 'if (!sim.armed && sim.frames >= ARM_TIMEOUT_STEPS) killSim(sim, \'idle\');', 'if (!sim.armed && sim.frames > ARM_TIMEOUT_STEPS) killSim(sim, \'idle\');'],
  ['R87 speed ramp', BOTH, 'sim.speed = Math.min(SPEED_CAP, SPEED_BASE + Math.floor(sim.rowN / SPEED_EVERY));', 'sim.speed = Math.min(SPEED_CAP, SPEED_BASE + Math.floor((sim.rowN + 1) / SPEED_EVERY));'],
  ['R88 head moves only when down', BOTH, 'let nx = down ? travelTo(px, x) : px;', 'let nx = travelTo(px, x);'],
  ['R89 head clamp low', BOTH, '  if (nx < X_MIN) nx = X_MIN;', '  if (nx < X_MIN + 1) nx = X_MIN + 1;'],
  ['R90 head clamp high', BOTH, '  if (nx > X_MAX) nx = X_MAX;', '  if (nx > X_MAX - 1) nx = X_MAX - 1;'],
  ['R91 contact test', BOTH, 'if (sim.scroll + HEAD_RQ <= nb && sim.scroll + sim.speed + HEAD_RQ > nb) hit = firstBlocking(sim);', 'if (sim.scroll + HEAD_RQ < nb && sim.scroll + sim.speed + HEAD_RQ > nb) hit = firstBlocking(sim);'],
  ['R92 contact lookahead', BOTH, 'sim.scroll + sim.speed + HEAD_RQ > nb) hit', 'sim.scroll + sim.speed + HEAD_RQ >= nb) hit'],
  ['R93 grind holds the world at the block', BOTH, 'sim.scroll = nb - HEAD_RQ;', 'sim.scroll = nb - HEAD_RQ + 1;'],
  ['R94 grind timer reset on new block', BOTH, 'if (sim.hitCol !== hit) { sim.hitCol = hit; sim.hitT = 0; }', 'if (sim.hitCol !== hit) { sim.hitCol = hit; }'],
  ['R95 grind tick', BOTH, 'if (sim.hitT >= hitSteps(sim.score)) {', 'if (sim.hitT > hitSteps(sim.score)) {'],
  ['R96 a ball per tick', BOTH, '      vals[hit] -= 1;', '      vals[hit] -= 1 + (vals[hit] > 40 ? 1 : 0);'],
  ['R97 a ball costs a point', BOTH, '      sim.len--;\n      sim.score++;', '      sim.len--;\n      sim.score += 1 + (sim.chain > 7 ? 1 : 0);'],
  ['R98 break chain gap', BOTH, 'sim.chain = (sim.rowN - sim.chainRow <= CHAIN_GAP) ? sim.chain + 1 : 1;', 'sim.chain = (sim.rowN - sim.chainRow < CHAIN_GAP) ? sim.chain + 1 : 1;'],
  ['R99 chain cap', BOTH, 'if (sim.chain > CHAIN_MAX) sim.chain = CHAIN_MAX;', 'if (sim.chain > CHAIN_MAX + 1) sim.chain = CHAIN_MAX + 1;'],
  ['R100 break bonus uses face value', BOTH, 'const orig = specFor(sim, sim.rowN).vals[hit];', 'const orig = sim.rowVals[hit] + 1;'],
  ['R101 break bonus times chain', BOTH, 'sim.score += orig * sim.chain;', 'sim.score += orig * (sim.chain + 0) + (sim.chain > 3 ? 1 : 0);'],
  ['R102 death at zero', BOTH, '      if (sim.len <= 0) { killSim(sim, \'crushed\'); return; }', '      if (sim.len < 0) { killSim(sim, \'crushed\'); return; }'],
  ['R103 free scroll', BOTH, '    sim.hitT = 0;\n    sim.scroll += sim.speed;', '    sim.hitT = 0;\n    sim.scroll += sim.speed + 0 * 1 + (sim.speed > 127 ? 1 : 0);'],
  ['R104 seed int', BOTH, '? (parseInt(seedHex.slice(0, 8), 16) >>> 0) : 0;', '? (parseInt(seedHex.slice(1, 9), 16) >>> 0) : 0;'],
  ['R105 rng step', BOTH, 'a = (a + 0x6D2B79F5) >>> 0;', 'a = (a + 0x6D2B79F7) >>> 0;'],
  ['R106 rng index mixing', BOTH, 'Math.imul(index + 1, RNG_STRIDE)', 'Math.imul(index + 2, RNG_STRIDE)'],
  // ── one side only: the cross-file check must catch it ──
  ['X1 validator alone drifts', [VAL], 'const HIT_BASE = 3;', 'const HIT_BASE = 2;'],
  ['X2 game alone drifts', [GAME], 'const START_LEN = 4;', 'const START_LEN = 5;'],
  // ── client-only plumbing ──
  ['C1 samples recorded after death', [GAME], '    if (down && sim.frames === step) {', '    if (down) {'],
  ['C2 batch starts one step late', [GAME], 'if (pathX.length === 0) pathF = step - 1;', 'if (pathX.length === 0) pathF = step;'],
  ['C3 records the target, not the head', [GAME], '      pathX.push(sim.hx);', '      pathX.push(aimX);'],
  ['C4 touch marker one step late', [GAME], "emitMarker(down ? 'touch' : 'lift', step);", "emitMarker(down ? 'touch' : 'lift', step + 1);"],
  ['C5 no flush before a marker', [GAME], '      flushPath();\n      emitMarker(', '      emitMarker('],
  ['C6 start answers an old version', [GAME], '__kjGameStart(performance.now(), 2)', '__kjGameStart(performance.now(), 1)'],
  ['C7 submits at once', [GAME], 'if (deathWait >= DEATH_SUBMIT_STEPS) endGame();', 'endGame();'],
  ['C8 platform restart allowed', [GAME], "if (state === 'over' && window.__kjEmbed) return;", ''],
  ['C9 aim gain', [GAME], 'const AIM_GAIN = 1.45;', 'const AIM_GAIN = 1.5;'],
  ['C10 time-based step', [GAME], 'while (accumulator >= FRAME_MS - STEP_EPSILON_MS && state === \'play\') {', 'while (accumulator >= 1 && state === \'play\') {'],
  ['C11 second finger steers', [GAME], 'if (activePointer !== null && activePointer !== id) return;', ''],
  ['C12 key press can start', [GAME], "if (e.code === 'Space' || e.code === 'Enter') { if (e.preventDefault) e.preventDefault(); }", ''],
];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--') && !/^\d+\/\d+$/.test(a)) || '';
const shardArg = args.indexOf('--shard') >= 0 ? args[args.indexOf('--shard') + 1] : null;
const known = new Set(M.map((m) => m[0].split(' ')[0]));
const flags = new Set(args.filter((a) => a.startsWith('--')));
for (const f of flags) if (!['--shard', '--check'].includes(f)) { console.error(`unknown flag "${f}"`); process.exit(2); }
if (!checkOnly && only !== 'all' && !known.has(only)) { console.error(`unknown mutation "${only}"`); process.exit(2); }

if (checkOnly) {
  // Read-only: every find string must match exactly once in every file it names.
  let bad = 0;
  for (const [name, files, find] of M) {
    for (const f of files) {
      const n = fs.readFileSync(f, 'utf8').split(find).length - 1;
      if (n !== 1) { bad++; console.log(`NOT UNIQUE (${n}x) ${name} in ${f}`); }
    }
  }
  console.log(`${M.length} mutations, ${bad} find strings that do not match exactly once`);
  process.exit(bad ? 1 : 0);
}

if (process.env.SB_MUTATE_SCRATCH !== '1') {
  console.error('refusing: run this from a scratch copy with SB_MUTATE_SCRATCH=1');
  process.exit(2);
}
let [si, sk] = shardArg ? shardArg.split('/').map(Number) : [1, 1];
let caught = 0; const survived = []; const skipped = [];
M.forEach(([name, files, find, repl], idx) => {
  if (only !== 'all' && name.split(' ')[0] !== only) return;
  if (idx % sk !== si - 1) return;
  const orig = files.map((f) => fs.readFileSync(f, 'utf8'));
  if (orig.some((s) => s.split(find).length !== 2)) { skipped.push(name); console.log('SKIPPED  ' + name); return; }
  files.forEach((f, i) => fs.writeFileSync(f, orig[i].replace(find, repl)));
  let failed = false;
  try {
    execSync('npx jest --runInBand --ci shared/tests/snakeBlocksParity.test.js shared/tests/snakeBlocksAdversarial.test.js shared/tests/snakeBlocksRender.test.js',
      { stdio: 'pipe', timeout: 900000 });
  } catch (_e) { failed = true; }
  files.forEach((f, i) => fs.writeFileSync(f, orig[i]));
  if (failed) caught++; else survived.push(name);
  console.log((failed ? 'CAUGHT   ' : 'SURVIVED ') + name);
});
console.log(`\n${caught} caught, ${survived.length} survived, ${skipped.length} skipped`);
if (survived.length) console.log('survivors:', survived.join('; '));
if (skipped.length) console.log('skipped (find string not unique):', skipped.join('; '));
