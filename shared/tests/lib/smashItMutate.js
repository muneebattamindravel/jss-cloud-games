#!/usr/bin/env node
'use strict';

/**
 * Smash It mutation battery.
 *
 * Writes a deliberate bug into the rules, the validator, the client or the page
 * bridge, runs the four suites, and requires them to go red. A survivor is a
 * hole in the suites.
 *
 * RUN IT FROM A SCRATCH COPY OF THE TREE, NEVER THE WORKING TREE. It rewrites
 * source files in place and restores them afterwards. One copy per shard, at
 * most three shards.
 *
 *   node shared/tests/lib/smashItMutate.js all --shard 1/3
 *   node shared/tests/lib/smashItMutate.js all --nopin   (pin table and rules
 *        hash off: what the BEHAVIOUR alone catches)
 *   node shared/tests/lib/smashItMutate.js --check       (read only)
 *   node shared/tests/lib/smashItMutate.js --list
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
  rules: path.join(ROOT, 'games/smash-it/js/rules.js'),
  game: path.join(ROOT, 'games/smash-it/js/game.js'),
  html: path.join(ROOT, 'games/smash-it/index.html'),
  validator: path.join(ROOT, 'shared/anticheat/validators/smashIt.js'),
};
// cheapest first: the pin table and the hand-placed edges, then the short
// suites, then full parity. The first stage is skipped under --nopin.
const SUITES = [['shared/tests/smashItParity.test.js', '-t', 'one block, pinned|reload gap'], ['shared/tests/smashItRender.test.js'],
  ['shared/tests/smashItAdversarial.test.js'], ['shared/tests/smashItReplay.test.js'], ['shared/tests/smashItParity.test.js']];
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;
let NOPIN = false;

// [name, where ('both' = rules.js and the validator | 'rules' | 'game' | 'html' | 'validator'), find, replace]
const M = [
  // ── constants ────────────────────────────────────────────────────────────
  ['IDLE_STEPS', 'both', 'var IDLE_STEPS = 1800; ', 'var IDLE_STEPS = 1799; '],
  ['MAX_RUN_STEPS', 'both', 'var MAX_RUN_STEPS = 144000; ', 'var MAX_RUN_STEPS = 143999; '],
  ['MAX_SHOTS', 'both', 'var MAX_SHOTS = 6000; ', 'var MAX_SHOTS = 5999; '],
  ['GRAVITY', 'both', 'GRAVITY = -20;', 'GRAVITY = -19.9;'],
  ['ROW', 'both', 'ROW = 1.3, DEPTH', 'ROW = 1.31, DEPTH'],
  ['DEPTH', 'both', 'DEPTH = 0.98, FRONT', 'DEPTH = 0.97, FRONT'],
  ['FRONT', 'both', 'FRONT = 0.5;', 'FRONT = 0.51;'],
  ['PLANK_H', 'both', 'var PLANK_H = 0.8;', 'var PLANK_H = 0.79;'],
  ['BALL_R', 'both', 'var BALL_R = 0.4,', 'var BALL_R = 0.41,'],
  ['BALL_DENSITY', 'both', 'BALL_DENSITY = 4.2,', 'BALL_DENSITY = 4.3,'],
  ['BALL_SPEED', 'both', 'BALL_SPEED = 44,', 'BALL_SPEED = 43,'],
  ['CANNON z', 'both', 'var CANNON = { x: 0, y: -1.2, z: 13 };', 'var CANNON = { x: 0, y: -1.2, z: 13.1 };'],
  ['FALL_Y', 'both', 'var FALL_Y = -2.6;', 'var FALL_Y = -2.5;'],
  ['JAR_BREAK_F', 'both', 'var JAR_BREAK_F = 800,', 'var JAR_BREAK_F = 780,'],
  ['SHOT_GAP', 'both', 'var SHOT_GAP = 10,', 'var SHOT_GAP = 9,'],
  ['PIERCE', 'both', 'PIERCE = 5, CARRY_CAP', 'PIERCE = 4, CARRY_CAP'],
  ['CARRY_CAP', 'both', 'CARRY_CAP = 6;', 'CARRY_CAP = 7;'],
  ['BOMB_R', 'both', 'var BOMB_R = 2.6,', 'var BOMB_R = 2.5,'],
  ['BOMB_PUSH', 'both', 'BOMB_PUSH = 9;', 'BOMB_PUSH = 9.5;'],
  ['PEND_LEN', 'both', 'var PEND_LEN = 3.4,', 'var PEND_LEN = 3.3,'],
  ['SHIELD_W', 'both', 'var SHIELD_W = 2.6,', 'var SHIELD_W = 2.7,'],
  ['FAN_LEN', 'both', 'var FAN_LEN = 3.1,', 'var FAN_LEN = 3.2,'],
  ['PTS jar', 'both', 'var PTS = { jar: 10,', 'var PTS = { jar: 11,'],
  ['PTS plank', 'both', 'crate: 25, plank: 40,', 'crate: 25, plank: 41,'],
  ['PTS bomb', 'both', 'plank: 40, bomb: 30,', 'plank: 40, bomb: 31,'],
  ['PTS ice', 'both', 'bomb: 30, ice: 20 };', 'bomb: 30, ice: 21 };'],
  ['FALL_PTS brick', 'both', 'var FALL_PTS = { jar: 10, brick: 15,', 'var FALL_PTS = { jar: 10, brick: 16,'],
  ['FALL_PTS jar', 'both', 'var FALL_PTS = { jar: 10,', 'var FALL_PTS = { jar: 9,'],
  ['HP crate', 'both', 'brick: 0, crate: 2, plank: 3,', 'brick: 0, crate: 1, plank: 3,'],
  ['HP plank', 'both', 'crate: 2, plank: 3, bomb: 1', 'crate: 2, plank: 2, bomb: 1'],
  ['SINQ entry', 'both', '0,6136,12272,', '0,6137,12272,'],
  ['hash constant', 'both', 'Math.imul(a + 1, 0x9E3779B1)', 'Math.imul(a + 1, 0x9E3779B3)'],
  ['hash mix', 'both', 'h = Math.imul(h ^ (h >>> 15), 0x846CA68B)', 'h = Math.imul(h ^ (h >>> 14), 0x846CA68B)'],
  ['seedToInt basis', 'both', "h = 0x811C9DC5;", "h = 0x811C9DC4;"],
  // ── rules logic ──────────────────────────────────────────────────────────
  ['isin fold', 'both', 'if (i < 512) return SINQ[512 - i];', 'if (i < 512) return SINQ[511 - i];'],
  ['boss every 5', 'both', 'return L >= 10 && L % 5 === 0;', 'return L >= 10 && L % 4 === 0;'],
  ['shield unlock', 'both', "if (L >= 3) c.push('shield');", "if (L >= 4) c.push('shield');"],
  ['obstacles early', 'both', 'var maxN = L < 3 ? 0 : L < 8 ? 1 : 2;', 'var maxN = L < 3 ? 0 : L < 7 ? 1 : 2;'],
  ['obstacle shuffle', 'both', 'var r = hash(seed, L, 30 + i) % (i + 1)', 'var r = hash(seed, L, 30 + i) % i'],
  ['ball budget per', 'both', 'var per = 26 + L * 3,', 'var per = 26 + L * 2,'],
  ['first level bonus balls', 'both', '(L === 1 ? 5 : 1)', '(L === 1 ? 4 : 1)'],
  ['carry over not capped', 'both', 'S.balls = Math.min(S.balls, CARRY_CAP) + add;', 'S.balls = S.balls + add;'],
  ['second shield level', 'both', '(L >= 12 ? 2 : 1)', '(L >= 13 ? 2 : 1)'],
  ['shot gap off by one', 'both', 'S.step - S.lastShot < SHOT_GAP', 'S.step - S.lastShot <= SHOT_GAP'],
  ['shot x range', 'both', 'tx < -700 || tx > 700', 'tx < -700 || tx > 701'],
  ['shot y range', 'both', 'ty < -150 || ty > 1300', 'ty < -151 || ty > 1300'],
  ['shot integer check', 'both', '(tx | 0) !== tx || ', ''],
  ['shot cap', 'both', '|| S.shots >= MAX_SHOTS) return false;', ') return false;'],
  ['jar break speed', 'both', "if (blk.t === 'jar' || blk.t === 'bomb') {\n        if (sp2 > 4) {", "if (blk.t === 'jar' || blk.t === 'bomb') {\n        if (sp2 > 5) {"],
  ['pierce speed', 'both', 'if (ball.pierced < PIERCE && sp2 > 16)', 'if (ball.pierced < PIERCE && sp2 > 17)'],
  ['crack speed', 'both', 'if (sp2 > 25) {', 'if (sp2 > 24) {'],
  ['break restore', 'both', "toBreak.push([blk, 'ball']); restore.push([ball, 0.7]);", "toBreak.push([blk, 'ball']); restore.push([ball, 0.71]);"],
  ['pierce restore', 'both', 'restore.push([ball, 0.88]);', 'restore.push([ball, 0.9]);'],
  ['ball face bounce', 'both', 'z: 1.2 }, true);', 'z: 1.3 }, true);'],
  ['bomb jar radius', 'both', "&& d < 1.6) toBreak.push([o, 'boom']);", "&& d < 1.5) toBreak.push([o, 'boom']);"],
  ['break scores', 'both', '    S.score += PTS[b.t];\n', '    S.score += PTS[b.t] + 1;\n'],
  ['fall scores', 'both', '        S.score += FALL_PTS[b.t];\n', '        S.score += FALL_PTS[b.t] * 2;\n'],
  ['wake on removal', 'both', 'for (var i = 0; i < S.blocks.length; i++) S.blocks[i].body.wakeUp();', 'for (var i = 1; i < S.blocks.length; i++) S.blocks[i].body.wakeUp();'],
  ['wake cadence', 'both', 'if (S.step % 10 === 0) {', 'if (S.step % 11 === 0) {'],
  ['ball lifetime', 'both', 'bb.age > 300', 'bb.age > 299'],
  ['ball rest', 'both', 'bb.slow > 45', 'bb.slow > 44'],
  ['idle compare', 'both', 'S.step - Math.max(S.lastShot, S.towerAt) > IDLE_STEPS', 'S.step - Math.max(S.lastShot, S.towerAt) >= IDLE_STEPS'],
  ['clear bonus', 'both', 'var bonus = 100 + 50 * S.level;', 'var bonus = 100 + 51 * S.level;'],
  ['clear pause', 'both', "S.phase = 'clear'; S.timer = 40;", "S.phase = 'clear'; S.timer = 41;"],
  ['balls end wait', 'both', 'S.step - S.lastShot > 420', 'S.step - S.lastShot > 400'],
  ['ending wait', 'both', "S.phase = 'ending'; S.timer = 60; S.end = 'balls';", "S.phase = 'ending'; S.timer = 59; S.end = 'balls';"],
  ['level carries balls', 'both', 'clearWorld(S); S.balls = keepBalls;', 'clearWorld(S); S.balls = keepBalls + 1;'],
  ['time end', 'both', "if (S.phase === 'play' && S.step >= MAX_RUN_STEPS)", "if (S.phase === 'play' && S.step > MAX_RUN_STEPS)"],
  ['fan speed', 'both', 'S.fan = { body: fb, k: hash(S.seed, L, 7) & 1023, spd: Math.min(6,', 'S.fan = { body: fb, k: hash(S.seed, L, 7) & 1023, spd: Math.min(5,'],
  ['shield speed', 'both', 'spd: Math.min(10, 3 + (L >> 1))', 'spd: Math.min(10, 4 + (L >> 1))'],
  ['pend amplitude', 'both', 'amp: 150,', 'amp: 140,'],
  // ── validator ────────────────────────────────────────────────────────────
  ['v: start version', 'validator', 'if (Number(payload.v) >= RULES_VERSION && state.mode', 'if (Number(payload.v) >= 0 && state.mode'],
  ['v: second start resets', 'validator', "&& state.mode !== 'sim') {", ') {'],
  ['v: rewind allowed', 'validator', "if (sim.step !== step) return reject(state, step < sim.step ? 'frame_regressed' : 'beyond_cap');", ''],
  ['v: n not checked', 'validator', "if (n !== sim.shots) return reject(state, 'out_of_order');", ''],
  ['v: step type', 'validator', "  if (!isNat(step)) return reject(state, 'bad_shot');", ''],
  ['v: suspicious at 10', 'validator', 'state.rejectCount >= 10 ?', 'state.rejectCount >= 11 ?'],
  ['v: elapsed factor', 'validator', 'return Math.ceil((e * 1.2 + 10) * fps);', 'return Math.ceil((e * 1.25 + 10) * fps);'],
  ['v: elapsed cap off', 'validator', ' && sim.step < capSteps && ', ' && '],
  ['v: input cap', 'validator', "if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');", ''],
  ['v: score from payload', 'validator', '  state.score = sim.score;\n  return { accepted: true, newScore: state.score };', '  state.score = Math.max(sim.score, Number(payload.score) || 0);\n  return { accepted: true, newScore: state.score };'],
  ['v: finalize score', 'validator', '    score: sim.score,\n    gameOver: true,', '    score: Math.max(sim.score, state.score + 1),\n    gameOver: true,'],
  ['v: world kept', 'validator', '  sim.world = null;\n', ''],
  ['v: limits', 'validator', 'const MAX_SIM_STEPS = 60 * 60 * 60;', 'const MAX_SIM_STEPS = 60 * 60 * 61;'],
  // ── client ───────────────────────────────────────────────────────────────
  ['c: emit before shoot', 'game', '    if (R.shoot(S, x, y) !== true) return false;\n', '    var ok = R.shoot(S, x, y);\n'],
  ['c: shot after step', 'game', "        else if (pendingShot) { fireShot(pendingShot.x, pendingShot.y, true); pendingShot = null; }\n        R.stepSim(S); handleEvents(S);", "        R.stepSim(S); handleEvents(S);\n        if (pendingShot) { fireShot(pendingShot.x, pendingShot.y, true); pendingShot = null; }"],
  ['c: replay takes real input', 'game', "        else if (pendingShot) { fireShot(", "        if (pendingShot) { fireShot("],
  ['c: replay fires early', 'game', 'var due = replayCur.due(S.step);', 'var due = replayCur.due(S.step + 1);'],
  ['c: seed not the session', 'game', 'var seedInt = (EMBED || RP) ? R.seedToInt(window.__kjSeed) : newSeed();', 'var seedInt = newSeed();'],
  ['c: QA switches live', 'game', "var Q = EMBED ? '' : location.search;", "var Q = location.search;"],
  ['c: submit at once', 'game', 'setTimeout(submitNow, 1500);', 'submitNow();'],
  ['c: two runs a session', 'game', "addEventListener('click', function () { if (EMBED) return; mode = 'menu';", "addEventListener('click', function () { mode = 'menu';"],
  ['c: pause embedded', 'game', "if (mode === 'play' && !EMBED && !RP) { pausedFrom", "if (mode === 'play' && !RP) { pausedFrom"],
  ['h: start version', 'html', "var v = Number(want) >= 1 ? 1 : 0;", "var v = 1;"],
  ['h: shot step dropped', 'html', "step: typeof step === 'number' ? step : null,", "step: null,"],
  ['h: submit twice', 'html', '        if (_submitted) return;\n', ''],
];

// Measured equivalents: a mutation listed here was examined and changes no
// result the platform can see. Each entry says why.
const INERT = {
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
    if (NOPIN && suite.length > 1) continue;
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/jest'), ['--runInBand', '--silent', '--ci', '--bail'].concat(suite),
      { cwd: ROOT, encoding: 'utf8', timeout: SUITE_TIMEOUT_MS, env: Object.assign({}, process.env, { CI: '1' }, NOPIN ? { SMASHIT_SKIP_PIN: '1' } : {}) });
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
  const originals = {};
  for (const f of Object.keys(FILES)) originals[f] = read(f);
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
