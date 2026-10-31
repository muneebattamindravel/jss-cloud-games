#!/usr/bin/env node
'use strict';

/**
 * Rang Bharo mutation battery.
 *
 * Writes a deliberate bug into the rules, the validator or the client, runs the
 * four suites, and requires them to go red. A survivor is a hole in the suites.
 *
 * RUN IT FROM A SCRATCH COPY OF THE TREE, NEVER THE WORKING TREE. It rewrites
 * source files in place and restores them afterwards. One copy per shard.
 *
 *   node shared/tests/lib/rangBharoMutate.js all --shard 1/6
 *   node shared/tests/lib/rangBharoMutate.js all --nopin   (pin tables and rules
 *        hash off: what the BEHAVIOUR alone catches)
 *   node shared/tests/lib/rangBharoMutate.js --check       (read only)
 *   node shared/tests/lib/rangBharoMutate.js --list
 *   node shared/tests/lib/rangBharoMutate.js --only "name|name"
 *
 * A suite past SUITE_TIMEOUT_MS counts as CAUGHT. An unknown flag EXITS 2.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../../..');
const FILES = {
  game: path.join(ROOT, 'games/rang-bharo/js/game.js'),
  validator: path.join(ROOT, 'shared/anticheat/validators/rangBharo.js'),
};
const SUITES = ['shared/tests/rangBharoAdversarial.test.js', 'shared/tests/rangBharoRender.test.js',
  'shared/tests/rangBharoReplay.test.js', 'shared/tests/rangBharoParity.test.js'];
const SUITE_TIMEOUT_MS = 8 * 60 * 1000;
let NOPIN = false;

// [name, where ('both' | 'game' | 'validator'), find, replace]
const M = [
  // ── constants ────────────────────────────────────────────────────────────
  ['TIME_STEPS', 'both', 'const TIME_STEPS = 10800; ', 'const TIME_STEPS = 10799; '],
  ['STEPS_PER_TILE', 'both', 'const STEPS_PER_TILE = 4; ', 'const STEPS_PER_TILE = 5; '],
  ['CLEAR_PAUSE', 'both', 'const CLEAR_PAUSE = 54; ', 'const CLEAR_PAUSE = 53; '],
  ['MAZE_BASE', 'both', 'const MAZE_BASE = 10; ', 'const MAZE_BASE = 11; '],
  ['PERFECT_BASE', 'both', 'const PERFECT_BASE = 40; ', 'const PERFECT_BASE = 39; '],
  ['PERFECT_PER', 'both', 'const PERFECT_PER = 8;', 'const PERFECT_PER = 9;'],
  ['OVER_COST', 'both', 'const OVER_COST = 3; ', 'const OVER_COST = 2; '],
  ['over cost uncapped', 'both', 'const cost = Math.min(base, OVER_COST * Math.max(0, s.moves - m.par));', 'const cost = OVER_COST * Math.max(0, s.moves - m.par);'],
  ['over cost off by one', 'both', 'const cost = Math.min(base, OVER_COST * Math.max(0, s.moves - m.par));', 'const cost = Math.min(base, OVER_COST * Math.max(0, s.moves - m.par - 1));'],
  ['over cost not taken', 'both', 'const bonus = base - cost + (perfect', 'const bonus = base + (perfect'],
  ['MAX_W', 'both', 'const MAX_W = 11;', 'const MAX_W = 10;'],
  ['MAX_H', 'both', 'const MAX_H = 13;', 'const MAX_H = 12;'],
  ['GEN_ATTEMPTS', 'both', 'const GEN_ATTEMPTS = 120;', 'const GEN_ATTEMPTS = 119;'],
  ['GEN_ATTEMPTS small', 'both', 'const GEN_ATTEMPTS = 120;', 'const GEN_ATTEMPTS = 1;'],
  ['SOLVE_CAP', 'both', 'const SOLVE_CAP = 60000; ', 'const SOLVE_CAP = 59999; '],
  ['SOLVE_CAP small', 'both', 'const SOLVE_CAP = 60000; ', 'const SOLVE_CAP = 3000; '],
  ['DX', 'both', 'const DX = [0, 1, 0, -1];', 'const DX = [0, -1, 0, 1];'],
  ['STEP_HZ', 'both', 'const STEP_HZ = 60;', 'const STEP_HZ = 59;'],
  ['RULES_VERSION', 'both', 'const RULES_VERSION = 1;', 'const RULES_VERSION = 2;'],
  // ── seed and hash ────────────────────────────────────────────────────────
  ['fnv prime', 'both', 'Math.imul(h ^ s.charCodeAt(i), 0x01000193)', 'Math.imul(h ^ s.charCodeAt(i), 0x01000197)'],
  ['hash mult', 'both', 'Math.imul(a | 0, 0x9E3779B1)', 'Math.imul(a | 0, 0x9E3779B3)'],
  ['hash attempt ignored', 'both', 'Math.imul((c | 0) + 0x1B873593, 0xC2B2AE3D)', 'Math.imul(0x1B873593, 0xC2B2AE3D)'],
  ['rng step', 'both', 'rs = (rs + 0x6D2B79F5) | 0;', 'rs = (rs + 0x6D2B79F3) | 0;'],
  // ── difficulty curve ─────────────────────────────────────────────────────
  ['dims w', 'both', 'w: Math.min(MAX_W, 4 + ((n - 1) >> 1))', 'w: Math.min(MAX_W, 4 + (n >> 1))'],
  ['dims h', 'both', 'h: Math.min(MAX_H, 4 + (n >> 1))', 'h: Math.min(MAX_H, 4 + ((n + 1) >> 1))'],
  ['dims start 5', 'both', 'w: Math.min(MAX_W, 4 + ((n - 1) >> 1))', 'w: Math.min(MAX_W, 5 + ((n - 1) >> 1))'],
  ['floor% cap', 'both', 'return Math.min(62, 48 + n);', 'return Math.min(63, 48 + n);'],
  ['floor% base', 'both', 'return Math.min(62, 48 + n);', 'return Math.min(62, 47 + n);'],
  ['budget cap', 'both', 'return Math.min(40, 3 + n + (n >> 1));', 'return Math.min(39, 3 + n + (n >> 1));'],
  ['budget base', 'both', 'return Math.min(40, 3 + n + (n >> 1));', 'return Math.min(40, 2 + n + (n >> 1));'],
  ['greed early', 'both', 'return n < 4 ? 2 : (n < 16 ? 1 : 0);', 'return n < 3 ? 2 : (n < 16 ? 1 : 0);'],
  ['greed late', 'both', 'return n < 4 ? 2 : (n < 16 ? 1 : 0);', 'return n < 4 ? 2 : (n < 15 ? 1 : 0);'],
  ['twist start', 'both', 'return Math.min(2, Math.max(0, (n - 16) >> 2));', 'return Math.min(2, Math.max(0, (n - 15) >> 2));'],
  ['twist cap', 'both', 'return Math.min(2, Math.max(0, (n - 16) >> 2));', 'return Math.min(1, Math.max(0, (n - 16) >> 2));'],
  ['twist picks longer', 'both', 'if (pool[j].L < pool[idx].L) idx = j;', 'if (pool[j].L > pool[idx].L) idx = j;'],
  ['minPar early', 'both', 'return n < 4 ? 2 : Math.min(20, 2 + (n >> 1) + (n >> 2));', 'return n < 3 ? 2 : Math.min(20, 2 + (n >> 1) + (n >> 2));'],
  ['minPar base', 'both', 'return n < 4 ? 2 : Math.min(20, 2 + (n >> 1) + (n >> 2));', 'return n < 4 ? 2 : Math.min(20, 1 + (n >> 1) + (n >> 2));'],
  ['minPar cap', 'both', 'return n < 4 ? 2 : Math.min(20, 2 + (n >> 1) + (n >> 2));', 'return n < 4 ? 2 : Math.min(19, 2 + (n >> 1) + (n >> 2));'],
  // ── the generator ────────────────────────────────────────────────────────
  ['slide stops one short', 'both', "if (nx < 0 || ny < 0 || nx >= w || ny >= h || cells[ny * w + nx] === 0) break;\n      x = nx; y = ny;", "if (nx < 0 || ny < 0 || nx >= w || ny >= h || cells[ny * w + nx] === 0 || cells[(ny + DY[d]) * w + nx + DX[d]] === 0) break;\n      x = nx; y = ny;"],
  ['slideEnd edge', 'both', "if (nx < 0 || ny < 0 || nx >= w || ny >= h || cells[ny * w + nx] === 0) break;", "if (nx < 0 || ny < 0 || nx > w || ny >= h || cells[ny * w + nx] === 0) break;"],
  ['par off by one', 'both', 'if (cnt === floors) return depth;', 'if (cnt === floors) return depth + 1;'],
  ['solver has no cap', 'both', 'if (++states > SOLVE_CAP) return -1;', 'states++;'],
  ['inexact par +1', 'both', 'par: par < 0 ? moves : par,', 'par: par < 0 ? moves + 1 : par,'],
  ['minPar not enforced', 'both', 'if (maze.par >= minPar(n)) return maze;', 'return maze;'],
  ['minPar >', 'both', 'if (maze.par >= minPar(n)) return maze;', 'if (maze.par > minPar(n)) return maze;'],
  ['floor floor 38', 'both', 'if (count * 100 < N * 38) continue;', 'if (count * 100 < N * 37) continue;'],
  ['traps allowed', 'both', 'if (!trapFree(cells, w, h, start)) continue;', ''],
  ['trapFree always', 'both', 'return q.length === list.length;', 'return true;'],
  ['trapFree reverse wrong', 'both', 'if (slideEnd(cells, w, h, c, d) === q[i]) { back[c] = 1; q.push(c); break; }', 'if (slideEnd(cells, w, h, q[i], d) === c) { back[c] = 1; q.push(c); break; }'],
  ['stop wall not pinned', 'both', 'if (bx >= 0 && by >= 0 && bx < w && by < h) pin[by * w + bx] = 1;', ''],
  ['pin ignored', 'both', 'if (cx < 0 || cy < 0 || cx >= w || cy >= h || pin[cy * w + cx]) break;', 'if (cx < 0 || cy < 0 || cx >= w || cy >= h) break;'],
  ['stop on open cell', 'both', 'if (open) continue;', 'if (open && L > 2) continue;'],
  ['greedy picks shorter', 'both', 'if (pool[j].fresh > pool[idx].fresh) idx = j;', 'if (pool[j].fresh < pool[idx].fresh) idx = j;'],
  ['budget <=', 'both', 'while (count < want && moves < budget && stuck < 14) {', 'while (count < want && moves <= budget && stuck < 14) {'],
  ['stuck 13', 'both', 'while (count < want && moves < budget && stuck < 14) {', 'while (count < want && moves < budget && stuck < 13) {'],
  ['stuck 3', 'both', 'while (count < want && moves < budget && stuck < 14) {', 'while (count < want && moves < budget && stuck < 3) {'],
  ['ring when par is low', 'both', '      if (maze.par >= minPar(n)) return maze;\n    }', '      if (maze.par >= minPar(n)) return maze;\n      if (maze.par >= minPar(n) - 2) return ringMaze(w, h);\n    }'],
  ['the run goes on past the clock', 'both', 'if (s.step >= TIME_STEPS) { s.over = true; s.ev = [{ k: \'end\' }]; return; }', 'if (s.step >= TIME_STEPS + 1) { s.over = true; s.ev = [{ k: \'end\' }]; return; }'],
  ['revisit allowed always', 'both', 'if (!pool.length) { pool = cands; stuck++; }', 'if (!pool.length || moves % 3 === 2) { pool = cands; stuck++; }'],
  ['ring path', 'both', "path: [1, 2, 3, 0] };", "path: [1, 2, 0, 3] };"],
  ['ring floors', 'both', 'const floors = 2 * w + 2 * h - 4;', 'const floors = 2 * w + 2 * h - 3;'],
  ['memo wrong key', 'both', "const mk = sd + ':' + n;", "const mk = sd + ':' + (n >> 1);"],
  // ── the sim ──────────────────────────────────────────────────────────────
  ['start tile not painted', 'both', 's.painted[m.start] = 1;\n    s.left = m.floors - 1;', 's.left = m.floors - 1;'],
  ['left counts the start', 'both', 's.left = m.floors - 1;', 's.left = m.floors;'],
  ['moves not reset per maze', 'both', 's.dir = -1; s.sub = 0; s.moves = 0; s.pause = 0;', 's.dir = -1; s.sub = 0; s.pause = 0;'],
  ['two inputs a step', 'both', 'if (s.lastInput === s.step) return false;', ''],
  ['input index not counted', 'both', 's.lastInput = s.step;\n    s.inputs++;', 's.lastInput = s.step;'],
  ['dir range', 'both', 'if (s.over || d < 0 || d > 3 || (d | 0) !== d) return false;', 'if (s.over || d < 0 || d > 4 || (d | 0) !== d) return false;'],
  ['dir integer', 'both', 'if (s.over || d < 0 || d > 3 || (d | 0) !== d) return false;', 'if (s.over || d < 0 || d > 3) return false;'],
  ['input after the end', 'both', 'if (s.over || d < 0 || d > 3 || (d | 0) !== d) return false;', 'if (d < 0 || d > 3 || (d | 0) !== d) return false;'],
  ['no buffer in pause', 'both', 'if (s.dir >= 0 || s.pause > 0) { s.queued = d; return true; }', 'if (s.dir >= 0) { s.queued = d; return true; }'],
  ['buffer keeps the first', 'both', 'if (s.dir >= 0 || s.pause > 0) { s.queued = d; return true; }', 'if (s.dir >= 0 || s.pause > 0) { if (s.queued < 0) s.queued = d; return true; }'],
  ['bump counts as a move', 'both', "if (blockedAt(s, s.bx, s.by, d)) { s.ev = s.ev.concat([{ k: 'bump', d }]); return false; }", "if (blockedAt(s, s.bx, s.by, d)) { s.moves++; s.ev = s.ev.concat([{ k: 'bump', d }]); return false; }"],
  ['blocked edge', 'both', 'return nx < 0 || ny < 0 || nx >= m.w || ny >= m.h || m.cells[ny * m.w + nx] === 0;', 'return nx < 0 || ny < 0 || nx > m.w || ny >= m.h || m.cells[ny * m.w + nx] === 0;'],
  ['clock >', 'both', 'if (s.step >= TIME_STEPS) { s.over = true;', 'if (s.step > TIME_STEPS) { s.over = true;'],
  ['queued lost at a new maze', 'both', "        loadMaze(s, s.n + 1);\n        if (s.queued >= 0) { const q = s.queued; s.queued = -1; tryStart(s, q); }", "        loadMaze(s, s.n + 1);\n        s.queued = -1;"],
  ['queued lost at a wall', 'both', "      s.ev = s.ev.concat([{ k: 'hit', d }]);\n      if (s.queued >= 0) { const q = s.queued; s.queued = -1; tryStart(s, q); }", "      s.ev = s.ev.concat([{ k: 'hit', d }]);"],
  ['tile worth 2', 'both', 's.painted[c] = 1; s.left--; s.score++; s.tiles++;', 's.painted[c] = 1; s.left--; s.score += 2; s.tiles++;'],
  ['repaint pays', 'both', '    if (s.painted[c] === 0) {\n      s.painted[c] = 1;', '    if (s.painted[c] >= 0) {\n      s.painted[c] = 1;'],
  ['perfect <', 'both', 'const perfect = s.moves <= m.par;', 'const perfect = s.moves < m.par;'],
  ['perfect +1', 'both', 'const perfect = s.moves <= m.par;', 'const perfect = s.moves <= m.par + 1;'],
  ['clear pays n-1', 'both', '      const base = MAZE_BASE * s.n;', '      const base = MAZE_BASE * (s.n - 1);'],
  ['ball keeps rolling after clear', 'both', '      s.dir = -1; s.pause = CLEAR_PAUSE;', '      s.pause = CLEAR_PAUSE;'],
  ['sub not reset', 'both', '    if (s.sub < STEPS_PER_TILE) return;\n    s.sub = 0;', '    if (s.sub < STEPS_PER_TILE) return;\n    s.sub = 1;'],
  // ── the validator around the rules ───────────────────────────────────────
  ['v: rewind allowed', 'validator', "if (step < sim.step) return reject(state, 'frame_regressed');", ''],
  ['v: any index', 'validator', "if (n !== sim.inputs) return reject(state, 'out_of_order');", ''],
  ['v: step not checked', 'validator', "if (!isStep(n) || !isStep(step)) return reject(state, 'bad_move');", "if (!isStep(n)) return reject(state, 'bad_move');"],
  ['v: typeof dropped', 'validator', "return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;", 'return Number.isFinite(Number(v)) && Number(v) >= 0;'],
  ['v: input cap widened', 'validator', 'const MAX_INPUTS = TIME_STEPS + 100;', 'const MAX_INPUTS = TIME_STEPS * 10;'],
  ['v: elapsed 1.3', 'validator', 'return Math.ceil((e * 1.2 + 10) * fps);', 'return Math.ceil((e * 1.3 + 10) * fps);'],
  ['v: elapsed +11', 'validator', 'return Math.ceil((e * 1.2 + 10) * fps);', 'return Math.ceil((e * 1.2 + 11) * fps);'],
  ['v: elapsed ignored', 'validator', "if (!Number.isFinite(e) || e <= 0) return Infinity;", 'return Infinity;'],
  ['v: second start resets', 'validator', "if (Number(payload.v) >= 1 && state.mode !== 'sim') {", 'if (Number(payload.v) >= 1) {'],
  ['v: v0 accepted', 'validator', "if (Number(payload.v) >= 1 && state.mode !== 'sim') {", "if (Number(payload.v) >= 0 && state.mode !== 'sim') {"],
  ['v: no start needed', 'validator', "if (state.mode !== 'sim' || kind !== 'move') return { accepted: true, newScore: state.score };", "if (kind !== 'move') return { accepted: true, newScore: state.score };\n  if (!state.sim) { state.mode = 'sim'; state.sim = initSim(state.seed, 1); }"],
  ['v: no run out', 'validator', 'while (!sim.over && guard < runOutSteps && sim.step < capSteps && sim.step < MAX_SIM_STEPS) {', 'while (false) {'],
  ['v: reads the claim', 'validator', "if (!isStep(n) || !isStep(step)) return reject(state, 'bad_move');", "if (payload.score > state.score) state.sim.score = payload.score;\n  if (!isStep(n) || !isStep(step)) return reject(state, 'bad_move');"],
  ['v: buffered not noted', 'validator', '  if (wasMoving) st.buffered++;', ''],
  ['v: waits from the maze', 'validator', '  else st.waits.push(sim.step - st.restAt);', '  else st.waits.push(sim.step - st.mazeAt);'],
  // ── the client ───────────────────────────────────────────────────────────
  ['c: emits before the rules', 'game', '    if (!inputDir(sim, d)) return false;\n    if (live) {', '    if (live) {'],
  ['c: emits the index after', 'game', "window.__kjMove(performance.now(), n, d, step);", "window.__kjMove(performance.now(), sim.inputs, d, step);"],
  ['c: emits the step after', 'game', "window.__kjMove(performance.now(), n, d, step);", "window.__kjMove(performance.now(), n, d, step + 1);"],
  ['c: swipe threshold', 'game', 'if (dx * dx + dy * dy >= 16 * 16) { f.fired = true; fire(dirOf(dx, dy)); }', 'if (dx * dx + dy * dy >= 160 * 160) { f.fired = true; fire(dirOf(dx, dy)); }'],
  ['c: flick threshold', 'game', 'if (dx * dx + dy * dy >= 7 * 7) fire(dirOf(dx, dy));', 'if (dx * dx + dy * dy >= 10 * 10) fire(dirOf(dx, dy));'],
  ['c: jitter counts', 'game', 'if (dx * dx + dy * dy >= 7 * 7) fire(dirOf(dx, dy));', 'if (dx * dx + dy * dy >= 2 * 2) fire(dirOf(dx, dy));'],
  ['c: a swipe fires twice', 'game', '    if (!f || f.fired) return;\n    const dx', '    if (!f) return;\n    const dx'],
  ['c: up fires after a move fired', 'game', '    fingers.delete(e.pointerId);\n    if (f.fired) return;', '    fingers.delete(e.pointerId);'],
  ['c: one finger only', 'game', '    if (fingers.size >= 5) return;', '    if (fingers.size >= 1) return;'],
  ['c: dir axis swapped', 'game', 'return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);', 'return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 1) : (dy > 0 ? 2 : 0);'],
  ['c: key repeat', 'game', '      if (!e.repeat) fire(KEYS[e.key]);', '      fire(KEYS[e.key]);'],
  ['c: input in READY', 'game', '    if (mode !== \'play\' || !sim || sim.over) return;', '    if (!sim || sim.over) return;'],
  ['c: live input in replay', 'game', '    if (replayMoves) {\n      const due', '    if (replayMoves && false) {\n      const due'],
  ['c: inbox stacks', 'game', '    if (inbox.length > 2) inbox.splice(0, inbox.length - 2);', '    if (inbox.length > 2) inbox.splice(0, inbox.length - 1);'],
  ['c: two inputs a step', 'game', '    } else if (inbox.length) applyInput(inbox.shift(), true);', '    } else while (inbox.length) applyInput(inbox.shift(), true);'],
  ['c: no backup clock', 'game', '    if (lastFrameAt === null || t - lastFrameAt > 200) pump(t);', '    if (lastFrameAt === null) pump(t);'],
  ['c: no catch-up', 'game', '      const cap = big ? 60 * 60 * 2 : 3;', '      const cap = 3;'],
  ['c: catch-up 6', 'game', '      const cap = big ? 60 * 60 * 2 : 3;', '      const cap = big ? 60 * 60 * 2 : 6;'],
  ['c: catch-up 1', 'game', '      const cap = big ? 60 * 60 * 2 : 3;', '      const cap = big ? 60 * 60 * 2 : 1;'],
  ['c: frame delta used', 'game', '      while (acc >= STEP_MS && n < cap) { acc -= STEP_MS; stepOnce(); n++; if (sim.over) break; }', '      if (acc >= STEP_MS) { acc = 0; stepOnce(); n++; }'],
  ['c: submit at once', 'game', '  const SUBMIT_MS = 3600;', '  const SUBMIT_MS = 1000;'],
  ['c: submit never', 'game', '    submitTimer = setTimeout(submitOnce, SUBMIT_MS);', ''],
  ['c: two runs a session', 'game', '    if ((EMBED || RP) && runsStarted > 0) return;     // one session, one run', ''],
  ['c: run without a seed', 'game', '    if ((EMBED || RP) && window.__kjSeed == null) return;', ''],
  ['c: ?seed inside the platform', 'game', '    if (EMBED || RP) return window.__kjSeed;\n    const m', '    const m'],
  ['c: no session gate', 'game', '    if (!sessionReady || mode !== \'menu\') return;', '    if (mode !== \'menu\') return;'],
  ['c: trace version not marked', 'game', "? (Number(window.__kjGameStart(performance.now(), RULES_VERSION)) || 0) : RULES_VERSION;", '? 0 : RULES_VERSION; if (false) window.__kjGameStart();'],
  ['c: replay inputs not applied', 'game', '      for (let i = 0; i < due.length; i++) applyInput(Number(due[i].dir), false);', ''],
  ['c: replay emits', 'game', '      for (let i = 0; i < due.length; i++) applyInput(Number(due[i].dir), false);', '      for (let i = 0; i < due.length; i++) applyInput(Number(due[i].dir), true);'],
  ['c: replay not started', 'game', "    if (RP) { show(menuEl, false); logo.running = false; startRun(); return; }", ''],
  ['c: how-to not marked', 'game', "    if (window.KJTut) { try { window.KJTut.markSeen(); } catch (_e) {} return; }", "    if (window.KJTut) return;"],
  ['c: practice skipped', 'game', "    if (!seenHow()) { startPractice(); return; }", ''],
  ['c: practice traced', 'game', "    const ev0 = sim.ev;\n    inputDir(sim, d);\n    for (const e of sim.ev.slice(ev0.length))", "    const ev0 = sim.ev;\n    applyInput(d, true);\n    for (const e of sim.ev.slice(ev0.length))"],
  ['c: practice takes any swipe', 'game', "    if (d !== want) { prac.wrongT = nowMs;", "    if (d !== want && false) { prac.wrongT = nowMs;"],
  ['c: practice PLAY without a session', 'game', "    if (mode !== 'pready' || !sessionReady) return;", "    if (mode !== 'pready') return;"],
  ['c: practice runs on to maze 2', 'game', "          prac.doneT = nowMs; mode = 'pracdone';", "          prac.doneT = nowMs;"],
];

const INERT = {
  'GEN_ATTEMPTS': 'measured: no maze needs the 120th attempt (0 ring fallbacks in 3600 mazes); GEN_ATTEMPTS small is caught',
  // Measured by regenerating the mazes the constant can reach: 0 change.
  'minPar early': 'measured: no maze 3 in 400 seeds has par below 3, so 2 or 3 is the same; minPar not enforced is caught',
  'minPar cap': 'measured: no maze 24 to 30 in 400 seeds has par below 20; minPar base is caught',
  // The per-frame cap only spreads owed steps over frames (nothing is ever
  // dropped), so 3 or 6 give the same steps on the same wall clock; measured:
  // every suite passes with 6. 'c: catch-up 1' (cannot keep up at 30 Hz) is caught.
  // Measured by re-generating 4800 mazes (300 seeds x 16) under the mutation:
  // 0 change. 'stuck 3' and 'SOLVE_CAP small' are caught.
  'stuck 13': 'measured: 0 of 4800 mazes change (no carve ends on the 14th fruitless try); stuck 3 is caught',
  'SOLVE_CAP': 'measured: 0 of 4800 mazes change (no BFS ends between 59999 and 60000 states); SOLVE_CAP small is caught',
  'c: catch-up 6': 'owed steps are never dropped; the cap only spreads them; catch-up 1 is caught',
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
  const names = new Set();
  for (const [name] of M) { if (names.has(name)) { console.log('duplicate name: ' + name); bad++; } names.add(name); }
  console.log(bad ? `${bad} bad find strings` : `all ${M.length} mutations match exactly once`);
  return bad;
}

function runSuites() {
  for (const suite of SUITES) {
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/jest'), ['--runInBand', '--silent', '--ci', '--bail', suite],
      { cwd: ROOT, encoding: 'utf8', timeout: SUITE_TIMEOUT_MS, env: Object.assign({}, process.env, { CI: '1' }, NOPIN ? { RB_SKIP_PIN: '1' } : {}) });
    if (r.error && r.error.code === 'ETIMEDOUT') return false;   // a hang is a catch
    if (r.status !== 0) return false;
  }
  return true;
}

function main() {
  const args = process.argv.slice(2);
  let shard = null, only = null, list = false, doCheck = false, all = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'all') all = true;
    else if (a === '--shard') { const [x, k] = String(args[++i]).split('/').map(Number); if (!(x >= 1 && k >= x)) { console.error('bad --shard'); process.exit(2); } shard = { x, k }; }
    else if (a === '--only') only = String(args[++i]).split('|');
    else if (a === '--list') list = true;
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
  let caughtN = 0, inertN = 0;
  M.forEach(([name, where, find, rep], i) => {
    if (shard && (i % shard.k) !== shard.x - 1) return;
    if (only && !only.includes(name)) return;
    for (const f of targets(where)) fs.writeFileSync(FILES[f], originals[f].replace(find, rep));
    const caught = !runSuites();
    restore();
    const inert = Object.prototype.hasOwnProperty.call(INERT, name);
    console.log(`${caught ? 'caught  ' : inert ? 'inert   ' : 'SURVIVED'} ${i} ${name}`);
    if (caught) caughtN++; else if (inert) inertN++; else survivors.push(name);
  });
  console.log(`${caughtN} live caught, ${inertN} inert, ${survivors.length} survivors`);
  console.log(survivors.length ? `SURVIVORS: ${survivors.join(', ')}` : 'zero survivors');
}

if (require.main === module) main();
module.exports = { M, INERT };
