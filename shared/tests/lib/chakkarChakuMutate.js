#!/usr/bin/env node
'use strict';

/**
 * Chakkar Chaku mutation battery.
 *
 * Writes a deliberate bug into the rules, the validator or the client, runs the
 * four suites, and requires them to go red. A survivor is a hole in the suites.
 *
 * ⚠ RUN IT FROM A SCRATCH COPY OF THE TREE, NEVER THE WORKING TREE. It rewrites
 * source files in place and restores them afterwards. One copy per shard.
 *
 *   node shared/tests/lib/chakkarChakuMutate.js all --shard 1/4
 *   node shared/tests/lib/chakkarChakuMutate.js all --nopin   (pin table and rules
 *        hash off: what the BEHAVIOUR alone catches)
 *   node shared/tests/lib/chakkarChakuMutate.js --check       (read only)
 *
 * A suite past SUITE_TIMEOUT_MS counts as CAUGHT. An unknown flag EXITS 2.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../../..');
const FILES = {
  game: path.join(ROOT, 'games/chakkar-chaku/js/game.js'),
  validator: path.join(ROOT, 'shared/anticheat/validators/chakkarChaku.js'),
};
const SUITES = ['shared/tests/chakkarChakuAdversarial.test.js', 'shared/tests/chakkarChakuReplay.test.js',
  'shared/tests/chakkarChakuRender.test.js', 'shared/tests/chakkarChakuParity.test.js'];
const SUITE_TIMEOUT_MS = 6 * 60 * 1000;
let NOPIN = false;

// [name, where ('both' | 'game' | 'validator'), find, replace]
const M = [
  // ── constants ────────────────────────────────────────────────────────────
  ['FLY', 'both', 'var FLY = 8; ', 'var FLY = 9; '],
  ['TOL', 'both', 'var TOL = 85; ', 'var TOL = 84; '],
  ['TOL big', 'both', 'var TOL = 85; ', 'var TOL = 120; '],
  ['APPLE_TOL', 'both', 'var APPLE_TOL = 120; ', 'var APPLE_TOL = 119; '],
  ['TRANS', 'both', 'var TRANS = 42; ', 'var TRANS = 41; '],
  ['IDLE_WARN', 'both', 'var IDLE_WARN = 360; ', 'var IDLE_WARN = 359; '],
  ['IDLE_END', 'both', 'var IDLE_END = 600; ', 'var IDLE_END = 599; '],
  ['MAX_STUCK', 'both', 'var MAX_STUCK = 12; ', 'var MAX_STUCK = 13; '],
  ['BOSS_EVERY', 'both', 'var BOSS_EVERY = 5; ', 'var BOSS_EVERY = 6; '],
  ['V_BASE', 'both', 'var V_BASE = 190; ', 'var V_BASE = 191; '],
  ['V_STEP', 'both', 'var V_STEP = 24; ', 'var V_STEP = 23; '],
  ['V_CAP_K', 'both', 'var V_CAP_K = 18; ', 'var V_CAP_K = 17; '],
  ['ACC', 'both', 'var ACC = 10; ', 'var ACC = 11; '],
  ['V3_BASE', 'both', 'var V3_BASE = 180; ', 'var V3_BASE = 181; '],
  ['V3_STEP', 'both', 'var V3_STEP = 22; ', 'var V3_STEP = 21; '],
  ['V3_CAP_K', 'both', 'var V3_CAP_K = 22; ', 'var V3_CAP_K = 21; '],
  ['V3_LATE_STEP', 'both', 'var V3_LATE_STEP = 5; ', 'var V3_LATE_STEP = 4; '],
  ['V3_LATE_CAP_K', 'both', 'var V3_LATE_CAP_K = 40;', 'var V3_LATE_CAP_K = 39;'],
  ['v3: late kinds never steady', 'both', 'else kind = roll < 15 ? 4 : roll < 50 ? 1 : 2;', 'else kind = roll < 15 ? 0 : roll < 50 ? 1 : 2;'],
  ['v3: crowding stops at 5', 'both', 'if (version >= 3 && k >= 20) preMax = k < 30 ? 6 : 7;', 'if (version >= 3 && k >= 20) preMax = 5;'],
  ['v3: hold floor 55', 'both', 'Math.max(35, 100 - 2 * (k - 6))', 'Math.max(55, 100 - 2 * (k - 6))'],
  ['v3: stop cap 20', 'both', 'Math.min(34, k - 10)', 'Math.min(20, k - 10)'],
  ['ACC_REV3', 'both', 'var ACC_REV3 = 18; ', 'var ACC_REV3 = 17; '],
  ['ACC_REV', 'both', 'var ACC_REV = 26; ', 'var ACC_REV = 25; '],
  ['ACC_BOSS', 'both', 'var ACC_BOSS = 20;', 'var ACC_BOSS = 21;'],
  ['NET_MIN', 'both', 'var NET_MIN = 43200; ', 'var NET_MIN = 43000; '],
  ['KNIFE_PTS', 'both', 'var KNIFE_PTS = 1;', 'var KNIFE_PTS = 2;'],
  ['APPLE_PTS', 'both', 'var APPLE_PTS = 2;', 'var APPLE_PTS = 3;'],
  ['CLEAR_PTS', 'both', 'var CLEAR_PTS = 5; ', 'var CLEAR_PTS = 4; '],
  ['MAX_THROWS', 'both', 'var MAX_THROWS = 20000;', 'var MAX_THROWS = 200;'],
  ['SUB', 'both', 'var SUB = 16;', 'var SUB = 15;'],
  ['HASH_K', 'both', 'var HASH_K = 0x9E3779B1;', 'var HASH_K = 0x9E3779B3;'],
  // ── rules logic ──────────────────────────────────────────────────────────
  ['circ: wrong half', 'both', 'return d < TURN - d ? d : TURN - d;', 'return d;'],
  ['hit: <= instead of <', 'both', 'if (circ(a, sim.stuck[i]) < TOL) {', 'if (circ(a, sim.stuck[i]) <= TOL) {'],
  ['hit: no collision', 'both', 'if (circ(a, sim.stuck[i]) < TOL) {', 'if (false) {'],
  ['apple: <=', 'both', 'if (circ(a, sim.apples[i]) < APPLE_TOL) {', 'if (circ(a, sim.apples[i]) <= APPLE_TOL) {'],
  ['apple: kept after taken', 'both', 'sim.score += APPLE_PTS; ev.push({ t: \'apple\', a: sim.apples[i] }); }', 'sim.score += APPLE_PTS; ev.push({ t: \'apple\', a: sim.apples[i] }); keep.push(sim.apples[i]); }'],
  ['land angle off by one', 'both', 'var a = (TURN - Math.floor(sim.rot / SUB)) % TURN, i;', 'var a = (TURN + 1 - Math.floor(sim.rot / SUB)) % TURN, i;'],
  ['flight lands a step early', 'both', 'if (sim.fly >= 0 && --sim.fly === 0) {', 'if (sim.fly >= 0 && --sim.fly <= 1) {'],
  ['throw allowed in flight', 'both', 'if (sim.dead || sim.fly >= 0 || sim.trans > 0 || sim.throws >= MAX_THROWS) return false;', 'if (sim.dead || sim.trans > 0 || sim.throws >= MAX_THROWS) return false;'],
  ['throw allowed in transition', 'both', 'if (sim.dead || sim.fly >= 0 || sim.trans > 0 || sim.throws >= MAX_THROWS) return false;', 'if (sim.dead || sim.fly >= 0 || sim.throws >= MAX_THROWS) return false;'],
  ['throw does not reset idle', 'both', 'sim.fly = FLY; sim.throws++; sim.lastAct = sim.step;', 'sim.fly = FLY; sim.throws++;'],
  ['idle >', 'both', 'if (sim.fly < 0 && t - sim.lastAct >= IDLE_END) {', 'if (sim.fly < 0 && t - sim.lastAct > IDLE_END) {'],
  ['idle off', 'both', 'if (sim.fly < 0 && t - sim.lastAct >= IDLE_END) {', 'if (false) {'],
  ['idle counts in flight', 'both', 'if (sim.fly < 0 && t - sim.lastAct >= IDLE_END) {', 'if (t - sim.lastAct >= IDLE_END) {'],
  ['trans end does not reset idle', 'both', 'if (sim.trans === 0) { sim.lastAct = t; ev.push', 'if (sim.trans === 0) { ev.push'],
  ['trans spins the log', 'both', "ev.push({ t: 'ready', k: sim.log }); }\n    return;", "ev.push({ t: 'ready', k: sim.log }); }\n    sim.rot = wrapSub(sim.rot + 1);\n    return;"],
  ['accel overshoot', 'both', 'if (sim.spd < target) sim.spd = Math.min(target, sim.spd + spec.acc);', 'if (sim.spd < target) sim.spd = sim.spd + spec.acc;'],
  ['decel overshoot', 'both', 'else if (sim.spd > target) sim.spd = Math.max(target, sim.spd - spec.acc);', 'else if (sim.spd > target) sim.spd = sim.spd - spec.acc;'],
  ['keyframe <', 'both', 'if (--sim.kfLeft <= 0) { sim.kfi', 'if (--sim.kfLeft < 0) { sim.kfi'],
  ['rot not wrapped', 'both', 'sim.rot = wrapSub(sim.rot + sim.spd);', 'sim.rot = sim.rot + sim.spd;'],
  ['score: no knife point', 'both', 'sim.score += KNIFE_PTS; sim.left--;', 'sim.left--;'],
  ['clear bonus wrong log', 'both', 'var bonus = CLEAR_PTS * (sim.log + 1);', 'var bonus = CLEAR_PTS * sim.log;'],
  ['clear never happens', 'both', 'if (sim.left === 0) {', 'if (sim.left === -1) {'],
  ['next log not reset trans', 'both', '  sim.trans = TRANS;\n}', '  sim.trans = 0;\n}'],
  ['next log keeps old knives', 'both', 'sim.stuck = spec.stuck.slice(); sim.apples', 'sim.stuck = sim.stuck.concat(spec.stuck); sim.apples'],
  // v3 spin plans
  ['v3: log 4 may reverse', 'both', "else if (k < 6) kind = roll < 40 ? 0 : 4;", "else if (k < 6) kind = roll < 40 ? 0 : 1;"],
  ['v3: logs 1-3 not steady', 'both', "else if (k < 3) kind = 0;", "else if (k < 3) kind = 4;"],
  ['v3: stops from log 7', 'both', "else if (k < 10) kind = roll < 25 ? 0 : roll < 55 ? 4 : 1;", "else if (k < 10) kind = roll < 25 ? 0 : roll < 55 ? 2 : 1;"],
  ['v3: first boss reverses', 'both', "if (boss) kind = k < 9 ? 4 : k < 14 ? 1 : 2;", "if (boss) kind = k < 9 ? 1 : k < 14 ? 1 : 2;"],
  ['v3: speed ramp frozen', 'both', "var v = V3_BASE + V3_STEP * Math.min(k, V3_CAP_K) +", "var v = V3_BASE + V3_STEP * Math.min(k, 10) +"],
  ['v3: stop never grows', 'both', "[0, 16 + r[9] % 12 + Math.min(34, k - 10)]", "[0, 16 + r[9] % 12]"],
  ['v3: holds never shorten', 'both', "s = k < 6 ? 100 : Math.max(35, 100 - 2 * (k - 6))", "s = 100"],
  ['v3: version ignored', 'both', "if (version >= 3) {\n    var plan", "if (false) {\n    var plan"],
  ['v3: pulse cycle shifts', 'both', "acc = ACC_PULSE;", "acc = 20;"],
  ['first log is 1', 'both', 'var k = sim.log + 1, spec = logSpec(sim.seed, k, sim.version);', 'var k = sim.log + 2, spec = logSpec(sim.seed, k, sim.version);'],
  ['seed ignored', 'both', 'version: version, seed: seedToInt(seedHex), step: 0,', 'version: version, seed: 7, step: 0,'],
  ['seed mix', 'both', "return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(", "return (parseInt(seedHex.slice(0, 8), 16) - Math.imul("],
  ['hash mix', 'both', 'h = Math.imul(h ^ (h >>> 15), MIX_B);', 'h = Math.imul(h ^ (h >>> 14), MIX_B);'],
  ['boss every 5th off by one', 'both', 'function isBoss(k) { return (k + 1) % BOSS_EVERY === 0; }', 'function isBoss(k) { return k % BOSS_EVERY === 0 && k > 0; }'],
  ['boss not faster', 'both', 'var v = V_BASE + V_STEP * Math.min(k, V_CAP_K);\n  return isBoss(k) ? Math.floor(v * 9 / 8) : v;', 'var v = V_BASE + V_STEP * Math.min(k, V_CAP_K);\n  return v;'],
  ['v3: boss not faster', 'both', '* Math.max(0, Math.min(k, V3_LATE_CAP_K) - V3_CAP_K);\n  return isBoss(k) ? Math.floor(v * 9 / 8) : v;', '* Math.max(0, Math.min(k, V3_LATE_CAP_K) - V3_CAP_K);\n  return v;'],
  ['kind: steady stays', 'both', "kind = boss ? 3 : k < 2 ? 0 :", "kind = boss ? 3 : k < 3 ? 0 :"],
  ['kf count', 'both', 'n = Math.min(6, 2 + Math.floor(k / 4));', 'n = Math.min(6, 2 + Math.floor(k / 5));'],
  ['net fix off', 'both', 'for (var grow = 0; grow < 60 && cycleNet(kf, acc) * dir < NET_MIN; grow++)', 'for (var grow = 0; grow < 0 && cycleNet(kf, acc) * dir < NET_MIN; grow++)'],
  ['cycleNet counts first pass', 'both', 'if (pass === 1) net += spd;', 'net += spd;'],
  ['pre-stuck: log 2 empty', 'both', 'var pre = k === 0 ? 0 : k === 1 ? 1 :', 'var pre = k === 0 ? 0 : k === 1 ? 0 :'],
  ['pre-stuck spacing', 'both', "stuck.push((base + i * Math.floor(TURN / pre) + (r[22 + i] % 300) - 150 + TURN) % TURN);", "stuck.push((base + i * Math.floor(TURN / pre) + (r[22 + i] % 300) - 149 + TURN) % TURN);"],
  ['need +1', 'both', ': 6 + Math.min(4, Math.floor(k / 3)) + (r[26] % 2);', ': 7 + Math.min(4, Math.floor(k / 3)) + (r[26] % 2);'],
  ['need cap off', 'both', 'need = Math.min(need, MAX_STUCK - pre);', 'need = need;'],
  ['apples: none', 'both', "var nApples = boss ? r[27] % 2 : k === 0 ? r[27] % 2 : r[27] % 3, apples = [];", "var nApples = 0, apples = [];"],
  ['apple clear of knives', 'both', 'if (circ(a, stuck[j]) < TOL + 60) clear = false;', 'if (circ(a, stuck[j]) < TOL + 59) clear = false;'],
  ['rot0 draw', 'both', 'rot0: (r[30] % TURN) * SUB', 'rot0: (r[31] % TURN) * SUB'],
  ['steady starts at speed', 'both', 'sim.spd = kind0(spec.kf) ? spec.kf[0][0] : 0;', 'sim.spd = 0;'],
  // ── validator only ───────────────────────────────────────────────────────
  ['v: rewind allowed', 'validator', "if (step < sim.step) return reject(state, 'frame_regressed');", ''],
  ['v: index not checked', 'validator', "if (n !== sim.throws) return reject(state, 'out_of_order');", ''],
  ['v: v1 replays', 'validator', 'if (Number(payload.v) >= 2 && state.mode', 'if (Number(payload.v) >= 1 && state.mode'],
  ['v: restart on second marker', 'validator', "if (Number(payload.v) >= 2 && state.mode !== 'sim') {", 'if (Number(payload.v) >= 2) {'],
  ['v: no run-out', 'validator', 'while (!sim.dead && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {', 'while (false) {'],
  ['v: no elapsed cap', 'validator', 'while (!sim.dead && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {', 'while (!sim.dead && guard < runOutSteps && sim.step < MAX_SIM_STEPS) {'],
  ['v: elapsed cap 1x', 'validator', 'return Math.ceil((e * 1.2 + 10) * fps);', 'return Math.ceil((e * 1.0 + 10) * fps);'],
  ['v: input cap off', 'validator', "if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');", ''],
  ['v: fraction step', 'validator', 'v >= 0 && Math.floor(v) === v;', 'v >= 0;'],
  ['v: step beyond cap applied', 'validator', "if (sim.step !== step) return reject(state, 'beyond_cap');", ''],
  ['v: suspicious threshold', 'validator', 'state.rejectCount >= 10 ?', 'state.rejectCount >= 11 ?'],
  ['v: margin not recorded', 'validator', 'if (others.length) state.stats.margins.push(m);', ''],
  ['v: refused throw applied', 'validator', "if (!throwSim(sim)) return reject(state, 'refused');", 'throwSim(sim);'],
  // ── client only ──────────────────────────────────────────────────────────
  ['c: emit before accept', 'game', "    if (!throwSim(sim)) return false;\n    audio.whoosh();", "    try { if (live && typeof window.__kjThrow === 'function') window.__kjThrow(performance.now(), n, step); } catch (_e) {}\n    if (!throwSim(sim)) return false;\n    audio.whoosh();"],
  ['c: step emitted +1', 'game', "window.__kjThrow(performance.now(), n, step); } catch (_e) {} }\n    return true;", "window.__kjThrow(performance.now(), n, step + 1); } catch (_e) {} }\n    return true;"],
  ['c: frame delta physics', 'game', 'while (acc >= STEP_MS && n < cap) {', 'while (acc >= 0 && n < cap) {'],
  ['c: submit at once', 'game', 'setTimeout(finishRun, 1500);', 'finishRun();'],
  ['c: no submit timer', 'game', 'setTimeout(finishRun, 1500);', ''],
  ['c: replay a run twice embedded', 'game', 'if (EMBED && submitted) return;\n    traceVersion', 'traceVersion'],
  ['c: qa switches embedded', 'game', 'function qp(name) { if (EMBED) return null;', 'function qp(name) {'],
  ['c: practice emits', 'game', "      p.frozen = false; p.hand = false; p.cap = ''; p.fly = 0; fx.reload = 0;", "      p.frozen = false; p.hand = false; p.cap = ''; p.fly = 0; fx.reload = 0; if (window.__kjThrow) window.__kjThrow(0, 0, 0);"],
  ['c: session not awaited', 'game', 'if (!sessionReady || state === \'play\') return;', "if (state === 'play') return;"],
  ['c: multi-press counts', 'game', 'window.KJPress.bind(press, {', 'window.addEventListener(\'pointerdown\', press); window.KJPress.bind(function () {}, {'],
  ['c: replay ignores inputs', 'game', 'for (var ri = 0; ri < due.length; ri++) throwKnife(false); }', '}'],
  ['c: replay takes real input', 'game', '  function press() {\n    if (RP) return;', '  function press() {'],
  ['c: trace version not marked', 'game', "? (Number(window.__kjGameStart(performance.now(), RULES_VERSION)) || 0) : RULES_VERSION;", '? 0 : RULES_VERSION; if (false) window.__kjGameStart();'],
];

const INERT = {
  // A throw sets lastAct to the current step and a flight lasts FLY (8) steps,
  // so t - lastAct is at most 8 while a knife is in the air: the idle test can
  // only bind with no knife flying, with or without the guard.
  'idle counts in flight': 'a flight is 8 steps and a throw resets idle; 600 is unreachable mid-flight',
  // A second simultaneous press always lands while the first knife is in the
  // air and throwSim refuses it, so counting it as a press changes nothing.
  'c: multi-press counts': 'one knife in the air already drops every extra press',
};

function read(f) { return fs.readFileSync(FILES[f], 'utf8'); }
function targets(where) { return where === 'both' ? ['game', 'validator'] : [where]; }

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
      { cwd: ROOT, encoding: 'utf8', timeout: SUITE_TIMEOUT_MS, env: Object.assign({}, process.env, { CI: '1' }, NOPIN ? { CK_SKIP_PIN: '1' } : {}) });
    if (r.error && r.error.code === 'ETIMEDOUT') return false;   // a hang is a catch
    if (r.status !== 0) return false;
  }
  return true;
}

function main() {
  const args = process.argv.slice(2);
  let shard = null, only = null, list = false, doCheck = false, all = false, from = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'all') all = true;
    else if (a === '--shard') { const [x, k] = String(args[++i]).split('/').map(Number); shard = { x, k }; }
    else if (a === '--only') only = String(args[++i]).split(/[|,]/);
    else if (a === '--list') list = true;
    else if (a === '--from') from = Number(args[++i]);
    else if (a === '--check') doCheck = true;
    else if (a === '--nopin') NOPIN = true;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (list) { M.forEach((m, i) => console.log(i, m[0])); return; }
  if (doCheck) process.exit(check() ? 1 : 0);
  if (!all && !only) { console.error('say "all" or --only'); process.exit(2); }
  if (check()) process.exit(1);
  const originals = { game: read('game'), validator: read('validator') };
  const restore = () => { for (const f of Object.keys(FILES)) fs.writeFileSync(FILES[f], originals[f]); };
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('SIGTERM', () => { restore(); process.exit(143); });
  if (!runSuites()) { console.error('ABORT: the suites fail with no mutation'); process.exit(1); }
  const survivors = [];
  M.forEach(([name, where, find, rep], i) => {
    if (i < from) return;
    if (shard && (i % shard.k) !== shard.x - 1) return;
    if (only && !only.includes(name)) return;
    for (const f of targets(where)) fs.writeFileSync(FILES[f], originals[f].replace(find, rep));
    const caught = !runSuites();
    restore();
    const inert = Object.prototype.hasOwnProperty.call(INERT, name);
    console.log(`${caught ? 'caught  ' : inert ? 'inert   ' : 'SURVIVED'} ${i} ${name}`);
    if (!caught && !inert) survivors.push(name);
  });
  console.log(survivors.length ? `SURVIVORS: ${survivors.join(', ')}` : 'zero survivors');
}

if (require.main === module) main();
module.exports = { M, INERT };
