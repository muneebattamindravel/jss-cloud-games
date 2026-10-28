#!/usr/bin/env node
'use strict';

/**
 * Pearls Connect mutation battery.
 *
 * Writes a deliberate bug into the rules, the validator or the client, runs the
 * four suites, and requires them to go red. A survivor is a hole in the suites.
 *
 * RUN IT FROM A SCRATCH COPY OF THE TREE, NEVER THE WORKING TREE. It rewrites
 * source files in place and restores them afterwards. One copy per shard.
 *
 *   node shared/tests/lib/pearlsConnectMutate.js all --shard 1/4
 *   node shared/tests/lib/pearlsConnectMutate.js all --nopin   (pin table and rules
 *        hash off: what the BEHAVIOUR alone catches)
 *   node shared/tests/lib/pearlsConnectMutate.js --check       (read only)
 *
 * A suite past SUITE_TIMEOUT_MS counts as CAUGHT. An unknown flag EXITS 2.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../../..');
const FILES = {
  game: path.join(ROOT, 'games/pearls-connect/js/game.js'),
  validator: path.join(ROOT, 'shared/anticheat/validators/pearlsConnect.js'),
};
// fastest first: most mutations are caught before parity runs
const SUITES = ['shared/tests/pearlsConnectAdversarial.test.js', 'shared/tests/pearlsConnectReplay.test.js',
  'shared/tests/pearlsConnectRender.test.js', 'shared/tests/pearlsConnectParity.test.js'];
const SUITE_TIMEOUT_MS = 8 * 60 * 1000;
let NOPIN = false;

// [name, where ('both' | 'game' | 'validator'), find, replace]
const M = [
  // ── constants ────────────────────────────────────────────────────────────
  ['RULES_VERSION', 'both', 'var RULES_VERSION = 2; ', 'var RULES_VERSION = 3; '],
  ['N', 'both', 'var N = 6;', 'var N = 7;'],
  ['CELLS', 'both', 'var CELLS = 36;', 'var CELLS = 35;'],
  ['KINDS -1', 'both', 'var KINDS = 5;', 'var KINDS = 4;'],
  ['KINDS +1', 'both', 'var KINDS = 5;', 'var KINDS = 6;'],
  ['RUN_STEPS', 'both', 'var RUN_STEPS = 18000; ', 'var RUN_STEPS = 17999; '],
  ['MIN_CHAIN 3', 'both', 'var MIN_CHAIN = 2; ', 'var MIN_CHAIN = 3; '],
  ['MIN_CHAIN 1', 'both', 'var MIN_CHAIN = 2; ', 'var MIN_CHAIN = 1; '],
  ['LOOP_MIN 3', 'both', 'var LOOP_MIN = 4; ', 'var LOOP_MIN = 3; '],
  ['LOOP_MIN 2', 'both', 'var LOOP_MIN = 4; ', 'var LOOP_MIN = 2; '],
  ['LOOP_MIN 5', 'both', 'var LOOP_MIN = 4; ', 'var LOOP_MIN = 5; '],
  ['LOOP_MULT', 'both', 'var LOOP_MULT = 2; ', 'var LOOP_MULT = 3; '],
  ['SHUFFLE_TRIES', 'both', 'var SHUFFLE_TRIES = 64;', 'var SHUFFLE_TRIES = 63;'],
  ['SHUFFLE_ROW', 'both', 'var SHUFFLE_ROW = 100; ', 'var SHUFFLE_ROW = 101; '],
  ['SEED_MIX', 'both', 'var SEED_MIX = 0x85EBCA6B;', 'var SEED_MIX = 0x85EBCA6D;'],
  ['HASH_K', 'both', 'var HASH_K = 0x9E3779B1;', 'var HASH_K = 0x9E3779B3;'],
  ['HASH_J', 'both', 'var HASH_J = 0x85EBCA77;', 'var HASH_J = 0x85EBCA79;'],
  ['MIX_A', 'both', 'var MIX_A = 0x7FEB352D;', 'var MIX_A = 0x7FEB352F;'],
  ['MIX_B', 'both', 'var MIX_B = 0x846CA68B;', 'var MIX_B = 0x846CA68D;'],
  // ── seed and hash ────────────────────────────────────────────────────────
  ['seed ignored', 'both', 'version: version, seed: seedToInt(seedHex), step: 0,', 'version: version, seed: 7, step: 0,'],
  ['seed mix sign', 'both', 'return (parseInt(seedHex.slice(0, 8), 16) + Math.imul(', 'return (parseInt(seedHex.slice(0, 8), 16) - Math.imul('],
  ['seed: second half ignored', 'both', 'Math.imul(parseInt(seedHex.slice(8, 16), 16) >>> 0, SEED_MIX)', 'Math.imul(0, SEED_MIX)'],
  ['hash shift', 'both', 'h = Math.imul(h ^ (h >>> 15), MIX_B);', 'h = Math.imul(h ^ (h >>> 14), MIX_B);'],
  ['hash k not +1', 'both', 'var h = (seed ^ Math.imul(k + 1, HASH_K)', 'var h = (seed ^ Math.imul(k, HASH_K)'],
  // ── points ───────────────────────────────────────────────────────────────
  ['points linear', 'both', 'return n * (n + 1) / 2 * (loop ? LOOP_MULT : 1);', 'return n * (loop ? LOOP_MULT : 1);'],
  ['points +1', 'both', 'return n * (n + 1) / 2 * (loop ? LOOP_MULT : 1);', 'return (n * (n + 1) / 2 + 1) * (loop ? LOOP_MULT : 1);'],
  ['loop not doubled', 'both', 'var pts = chainPoints(clear.length, ch.loop);', 'var pts = chainPoints(clear.length, false);'],
  ['points on chain length not cleared', 'both', 'var pts = chainPoints(clear.length, ch.loop);', 'var pts = chainPoints(ch.n, ch.loop);'],
  // ── neighbours and pairs ─────────────────────────────────────────────────
  ['adjacent: whole row', 'both', 'if (ra === rb) return ca - cb === 1 || cb - ca === 1;', 'if (ra === rb) return ca !== cb;'],
  ['adjacent: diagonal', 'both', 'return ca === cb && (ra - rb === 1 || rb - ra === 1);', 'return (ca - cb) * (ca - cb) <= 1 && (ra - rb === 1 || rb - ra === 1);'],
  ['adjacent: by index (wraps rows)', 'both', 'var ra = Math.floor(a / N), rb = Math.floor(b / N), ca = a - ra * N, cb = b - rb * N;', 'if (a - b === 1 || b - a === 1) return true;\n  var ra = Math.floor(a / N), rb = Math.floor(b / N), ca = a - ra * N, cb = b - rb * N;'],
  ['pair across a row end', 'both', 'if (i % N < N - 1 && grid[i] === grid[i + 1]) return true;', 'if (grid[i] === grid[i + 1]) return true;'],
  ['pair: no vertical', 'both', 'if (i + N < CELLS && grid[i] === grid[i + N]) return true;', ''],
  ['pair: no horizontal', 'both', 'if (i % N < N - 1 && grid[i] === grid[i + 1]) return true;', ''],
  // ── spawning and shuffles ────────────────────────────────────────────────
  ['avoid ignored', 'both', 'if (avoid >= 0 && kind === avoid) kind =', 'if (false) kind ='],
  ['avoid can return avoid', 'both', '(h >>> 8) % (KINDS - 1)) % KINDS;', '(h >>> 8) % KINDS) % KINDS;'],
  ['loop refill not avoided', 'both', 'spawnKind(sim.seed, c, spawned[c], ch.loop ? ch.kind : -1);', 'spawnKind(sim.seed, c, spawned[c], -1);'],
  ['spawn counter not advanced', 'both', 'spawnKind(sim.seed, c, spawned[c], ch.loop ? ch.kind : -1); spawned[c]++; }', 'spawnKind(sim.seed, c, spawned[c], ch.loop ? ch.kind : -1); }'],
  ['spawn counters start at N-1', 'both', 'for (c = 0; c < N; c++) spawned.push(N);', 'for (c = 0; c < N; c++) spawned.push(N - 1);'],
  ['opening fills top first', 'both', 'grid.push(spawnKind(sim.seed, c, N - 1 - r, -1));', 'grid.push(spawnKind(sim.seed, c, r, -1));'],
  ['opening never shuffled', 'both', '  sim.grid = grid; sim.spawned = spawned;\n  if (!hasPair(sim.grid)) reshuffle(sim);\n  return sim;', '  sim.grid = grid; sim.spawned = spawned;\n  return sim;'],
  ['shuffle row fixed', 'both', 'var row = SHUFFLE_ROW + sim.shuffles;', 'var row = SHUFFLE_ROW;'],
  ['shuffle not counted', 'both', '    sim.shuffles++;\n', ''],
  ['shuffle never stops early', 'both', '    if (hasPair(grid)) break;\n', ''],
  ['shuffle modulo i', 'both', 'j = hash(sim.seed, row, i) % (i + 1);', 'j = hash(sim.seed, row, i) % i;'],
  ['shuffle fallback off', 'both', '  if (!hasPair(grid)) grid[1] = grid[0];\n', ''],
  ['no shuffle after a chain', 'both', '  var shuffled = !hasPair(sim.grid);', '  var shuffled = false;'],
  // ── reading a chain ──────────────────────────────────────────────────────
  ['chain: off the board below', 'both', 'if (a !== Math.floor(a) || a < 0 || a >= CELLS) return null;', 'if (a !== Math.floor(a) || a < 0) return null;'],
  ['chain: off the board above', 'both', 'if (a !== Math.floor(a) || a < 0 || a >= CELLS) return null;', 'if (a !== Math.floor(a) || a >= CELLS) return null;'],
  ['chain: fractions', 'both', 'if (a !== Math.floor(a) || a < 0 || a >= CELLS) return null;', 'if (a < 0 || a >= CELLS) return null;'],
  ['chain: not a list', 'both', 'if (!Array.isArray(cells) || cells.length < MIN_CHAIN) return null;', 'if (cells.length < MIN_CHAIN) return null;'],
  ['chain: neighbours not checked', 'both', 'else if (!adjacent(cells[i - 1], a) || grid[a] !== kind) return null;', 'else if (grid[a] !== kind) return null;'],
  ['chain: colour not checked', 'both', 'else if (!adjacent(cells[i - 1], a) || grid[a] !== kind) return null;', 'else if (!adjacent(cells[i - 1], a)) return null;'],
  ['chain: repeat anywhere', 'both', 'if (i !== cells.length - 1 || i - seen[a] < LOOP_MIN) return null;', 'if (i - seen[a] < LOOP_MIN) return null;'],
  ['chain: no repeat check', 'both', '    if (seen[a] >= 0) {\n', '    if (false) {\n'],
  ['chain: loop counts its closing pearl', 'both', 'n: loopAt >= 0 ? cells.length - 1 : cells.length', 'n: cells.length'],
  ['chain: loop not flagged', 'both', 'return { kind: kind, loop: loopAt >= 0,', 'return { kind: kind, loop: false,'],
  // ── applying a chain ─────────────────────────────────────────────────────
  ['two chains a step', 'both', 'if (sim.over || sim.step <= sim.lastStep) return false;', 'if (sim.over || sim.step < sim.lastStep) return false;'],
  ['chains after the clock', 'both', 'if (sim.over || sim.step <= sim.lastStep) return false;', 'if (sim.step <= sim.lastStep) return false;'],
  ['loop clears twice', 'both', 'if (ch.loop) for (i = 0; i < CELLS; i++) if (!gone[i] && sim.grid[i] === ch.kind)', 'if (ch.loop) for (i = 0; i < CELLS; i++) if (sim.grid[i] === ch.kind)'],
  ['loop clears only itself', 'both', 'if (ch.loop) for (i = 0; i < CELLS; i++) if (!gone[i] && sim.grid[i] === ch.kind)', 'if (false) for (i = 0; i < CELLS; i++) if (!gone[i] && sim.grid[i] === ch.kind)'],
  ['gravity: pearls do not fall', 'both', 'if (!gone[r * N + c]) { grid[to * N + c] = sim.grid[r * N + c]; from[to * N + c] = r * N + c; to--; }', 'if (!gone[r * N + c]) { grid[r * N + c] = sim.grid[r * N + c]; from[r * N + c] = r * N + c; to--; }'],
  ['gravity: from not recorded', 'both', 'from[to * N + c] = r * N + c; to--; }', 'to--; }'],
  ['last step not kept', 'both', 'sim.score += pts; sim.chains++; sim.lastStep = sim.step;', 'sim.score += pts; sim.chains++;'],
  ['chains not counted', 'both', 'sim.score += pts; sim.chains++; sim.lastStep = sim.step;', 'sim.score += pts; sim.lastStep = sim.step;'],
  ['score not added', 'both', 'sim.score += pts; sim.chains++; sim.lastStep = sim.step;', 'sim.chains++; sim.lastStep = sim.step;'],
  // ── the clock ────────────────────────────────────────────────────────────
  ['clock ends late', 'both', 'if (sim.step >= RUN_STEPS) sim.over = true;', 'if (sim.step > RUN_STEPS) sim.over = true;'],
  ['clock never ends', 'both', 'if (sim.step >= RUN_STEPS) sim.over = true;', ''],
  ['clock keeps running', 'both', '  sim.events = [];\n  if (sim.over) return;\n  sim.step++;', '  sim.events = [];\n  sim.step++;'],
  ['events kept across steps', 'both', '  sim.events = [];\n  if (sim.over) return;', '  if (sim.over) return;'],
  // ── validator only ───────────────────────────────────────────────────────
  ['v: rewind allowed', 'validator', "if (step < sim.step) return reject(state, 'frame_regressed');", ''],
  ['v: index not checked', 'validator', "if (n !== sim.chains) return reject(state, 'out_of_order');", ''],
  ['v: v1 replays', 'validator', 'if (Number(payload.v) >= 2 && state.mode', 'if (Number(payload.v) >= 1 && state.mode'],
  ['v: restart on second marker', 'validator', "if (Number(payload.v) >= 2 && state.mode !== 'sim') {", 'if (Number(payload.v) >= 2) {'],
  ['v: no run-out', 'validator', '  advanceTo(state, runOut);\n', ''],
  ['v: no elapsed cap', 'validator', 'const sim = state.sim, lim = stepLimit(state);', 'const sim = state.sim, lim = MAX_SIM_STEPS;'],
  ['v: elapsed cap 1x', 'validator', 'return Math.ceil((e * 1.2 + 10) * fps);', 'return Math.ceil((e * 1.0 + 10) * fps);'],
  ['v: input cap off', 'validator', "if (state.inputCount >= MAX_INPUTS) return reject(state, 'input_cap');", ''],
  ['v: input cap tiny', 'validator', 'const MAX_INPUTS = RUN_STEPS + 100;', 'const MAX_INPUTS = 100;'],
  ['v: fraction step', 'validator', 'v >= 0 && Math.floor(v) === v;', 'v >= 0;'],
  ['v: step beyond cap applied', 'validator', "if (sim.step !== step) return reject(state, sim.over ? 'over' : 'beyond_cap');", ''],
  ['v: down after the lift', 'validator', "if (down > step || down < sim.lastStep) return reject(state, 'bad_down');", "if (down < sim.lastStep) return reject(state, 'bad_down');"],
  ['v: down before the last chain', 'validator', "if (down > step || down < sim.lastStep) return reject(state, 'bad_down');", "if (down > step) return reject(state, 'bad_down');"],
  ['v: long cell lists read', 'validator', ' || cells.length > MAX_CELLS) return reject(state, ', ') return reject(state, '],
  ['v: suspicious threshold', 'validator', 'state.rejectCount >= 10 ?', 'state.rejectCount >= 11 ?'],
  ['v: drag not recorded', 'validator', 'state.stats.drags.push((step - down) / Math.max(1, cells.length - 1));', ''],
  ['v: skipped loops not recorded', 'validator', 'else if (loopOnBoard) state.stats.loopSkipped++;', ''],
  ['v: refused chain applied', 'validator', "if (!chainSim(sim, cells)) return reject(state, 'refused');", "if (!chainSim(sim, cells)) { sim.score += 3; return reject(state, 'refused'); }"],
  // ── client only ──────────────────────────────────────────────────────────
  ['c: emit before accept', 'game', "    if (!chainSim(sim, cells)) { audio.cancel(); return false; }\n    if (live) {", "    if (live) { try { if (typeof window.__kjChain === 'function') window.__kjChain(performance.now(), n, step, down, cells); } catch (_e) {} }\n    if (!chainSim(sim, cells)) { audio.cancel(); return false; }\n    if (false) {"],
  ['c: step emitted +1', 'game', 'window.__kjChain(performance.now(), n, step, down, cells); } catch (_e) {} }\n    clearFx', 'window.__kjChain(performance.now(), n, step + 1, down, cells); } catch (_e) {} }\n    clearFx'],
  ['c: down not recorded', 'game', 'fx.hint = null; downStep = sim.step;', 'fx.hint = null;'],
  ['c: frame delta steps', 'game', 'while (acc >= STEP_MS && n < cap) {', 'while (acc >= 0 && n < cap) {'],
  ['c: submit at once', 'game', '    setTimeout(finishRun, 3000);\n', '    finishRun();\n'],
  ['c: no submit timer', 'game', '    setTimeout(finishRun, 3000);\n', ''],
  ['c: a second run embedded', 'game', '    if (EMBED && submitted) return;   // one run per session', '    // one run per session'],
  ['c: qa seed embedded', 'game', 'sim = initSim(window.__kjSeed || (EMBED ? null : localSeed()), RULES_VERSION);', 'sim = initSim(window.__kjSeed || localSeed(), RULES_VERSION);'],
  ['c: session not awaited', 'game', "if (!sessionReady || state === 'ready' || state === 'play' || state === 'timeup') return;", "if (state === 'ready' || state === 'play' || state === 'timeup') return;"],
  ['c: tutorial never shown', 'game', 'function shouldTutorial() { return !RP && !!window.KJTut && window.KJTut.shouldShow(); }', 'function shouldTutorial() { return false; }'],
  ['c: a second finger takes over', 'game', "if (RP || state !== 'play' || activeId !== null) return;", "if (RP || state !== 'play') return;"],
  ['c: replay ignores the chains', 'game', 'for (var ri = 0; ri < due.length; ri++) applyChain(due[ri].cells, due[ri].down, false); }', '}'],
  ['c: replay takes real input', 'game', "if (RP || state !== 'play' || activeId !== null) return;", "if (state !== 'play' || activeId !== null) return;"],
  ['c: trace version not marked', 'game', '? (Number(window.__kjGameStart(performance.now(), RULES_VERSION)) || 0) : RULES_VERSION;', '? 0 : RULES_VERSION; if (false) window.__kjGameStart();'],
  ['c: world from a local seed', 'game', 'sim = initSim(window.__kjSeed || (EMBED ? null : localSeed()), RULES_VERSION);', 'sim = initSim(localSeed(), RULES_VERSION);'],
];

const INERT = {
  // On a grid, a path that comes back next to one of its own pearls has gone
  // round a cycle, and every cycle on a square grid has an even length, so the
  // closest a closing pearl can be is 4 back. LOOP_MIN 3 accepts exactly what 4
  // does. Measured: the whole corpus and every edge test agree; LOOP_MIN 2 and
  // 5 are the large variants and are caught.
  'LOOP_MIN 3': 'grid cycles are even, so a loop closing 3 back cannot exist; 2 and 5 are caught',
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
      { cwd: ROOT, encoding: 'utf8', timeout: SUITE_TIMEOUT_MS, env: Object.assign({}, process.env, { CI: '1' }, NOPIN ? { PC_SKIP_PIN: '1' } : {}) });
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
  if (shard && !(shard.k >= 1 && shard.x >= 1 && shard.x <= shard.k)) { console.error('bad --shard'); process.exit(2); }
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
  let caughtN = 0, inertN = 0;
  M.forEach(([name, where, find, rep], i) => {
    if (i < from) return;
    if (shard && (i % shard.k) !== shard.x - 1) return;
    if (only && !only.includes(name)) return;
    for (const f of targets(where)) fs.writeFileSync(FILES[f], originals[f].replace(find, rep));
    const caught = !runSuites();
    restore();
    const inert = Object.prototype.hasOwnProperty.call(INERT, name);
    if (caught) caughtN++; else if (inert) inertN++;
    console.log(`${caught ? 'caught  ' : inert ? 'inert   ' : 'SURVIVED'} ${i} ${name}`);
    if (!caught && !inert) survivors.push(name);
  });
  console.log(`${caughtN} live caught, ${inertN} inert, ${survivors.length} survivors`);
  console.log(survivors.length ? `SURVIVORS: ${survivors.join(', ')}` : 'zero survivors');
}

if (require.main === module) main();
module.exports = { M, INERT };
