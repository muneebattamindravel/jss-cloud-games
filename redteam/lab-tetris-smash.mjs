#!/usr/bin/env node
// Red-team lab for Tetris Smash. UNRUN: written in the jss-games workshop, which
// has no platform, database or /lab door. It runs in kj-platform after the
// package is copied over (redteam/ is gitignored there).
//
// What it proves on the real local platform (docs/INTEGRATION.md section 4):
//   1. three honest runs: claimed == replayed == stored, lab = true,
//      is_counted = false, no leaderboard row;
//   2. attacks reduce to what their acts earn: a forged 99,999 claim, a claim
//      with no play, a flood past the act cap, a rewind, out-of-order indices,
//      junk fields, and a second start marker;
//   3. a stored trace replays offline to the same score and end step.
//
// The two platform calls are ADAPTERS: copy their bodies from a sibling lab
// script (e.g. redteam/lab-dart-champ.mjs), which knows how this platform mints
// a /lab session and reads the stored row. Everything else here is complete.
//
//   node redteam/lab-tetris-smash.mjs           (all checks)
//   node redteam/lab-tetris-smash.mjs --offline (only the traces and the offline replay)
//
// An unknown flag exits 2.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const H = require('../shared/tests/lib/tetrisSmashRealGame.js');
const W = require('../shared/tests/lib/tetrisSmashWorld.js');
const V = require('../shared/anticheat/validators/tetrisSmash.js');
const S = V._sim;
const GAME_ID = 'tetris-smash';

// ── ADAPTERS: fill from a sibling lab script ──────────────────────────────
// Start a /lab session for GAME_ID and return { sessionId, seed }.
async function startLabSession() {
  throw new Error('adapter: copy startLabSession from a sibling redteam/lab-*.mjs');
}
// Upload a trace (array of { type: 'input', payload }) with a claimed score
// through the real submit path, then read the stored result. Return
// { replayedScore, storedScore, lab, isCounted, leaderboardRow, flagged }.
async function submitAndRead(_session, _events, _claimedScore, _elapsedSecs) {
  throw new Error('adapter: copy submitAndRead from a sibling redteam/lab-*.mjs');
}

// ── traces ────────────────────────────────────────────────────────────────
// A real run flown on the real game page for the session's own seed.
function honestTrace(seed, pilot, rng) {
  const g = H.boot({ seed });
  const r = H.fly(g, pilot, { maxSteps: S.RUN_STEPS, rngSeed: rng });
  return { events: g.trace.map((e) => ({ type: e.type, payload: e.payload })), score: r.score, frame: r.frame };
}
const start = () => ({ type: 'input', payload: { kind: 'start', v: 2 } });
const act = (n, a, step) => ({ type: 'input', payload: { kind: 'act', n, a, step } });
function offline(seed, events, elapsedSecs) {
  const st = V.init({ seed, elapsedSecs: elapsedSecs || 400, maxDurationSecs: 3600 });
  for (const e of events) V.processEvent(st, e);
  return V.finalize(st);
}
function attacks(seed, honest) {
  const flood = [start()];
  for (let i = 0; i < V._limits.MAX_INPUTS + 500; i++) flood.push(act(i, i % 2, 3));
  const rewind = honest.events.slice();
  const acts = rewind.filter((e) => e.payload.kind === 'act');
  if (acts.length > 10) rewind.push(act(acts.length, S.A_HARD, acts[5].payload.step));
  const junk = [];
  for (const e of honest.events) {
    junk.push(e);
    if (e.payload.kind === 'act') junk.push({ type: 'input', payload: { kind: 'act', n: e.payload.n + 9, a: 6, step: e.payload.step } }, { type: 'input', payload: { kind: 'act', n: 'x', a: '6', step: null } });
  }
  const restart = honest.events.slice();
  restart.splice(Math.floor(restart.length / 2), 0, start());
  return [
    { name: 'forged 99,999 claim', events: honest.events, claim: 99999 },
    { name: 'no play, big claim', events: [start()], claim: 50000 },
    { name: 'no start marker', events: honest.events.filter((e) => e.payload.kind !== 'start'), claim: honest.score },
    { name: 'flood past the input cap', events: flood, claim: 99999 },
    { name: 'rewind', events: rewind, claim: honest.score + 5000 },
    { name: 'junk fields and out-of-order indices', events: junk, claim: honest.score },
    { name: 'second start marker', events: restart, claim: honest.score },
  ].map((a) => Object.assign(a, { expect: offline(seed, a.events).score }));
}

// ── checks ────────────────────────────────────────────────────────────────
let fails = 0;
function check(ok, msg) { console.log((ok ? 'ok    ' : 'FAIL  ') + msg); if (!ok) fails++; }

async function main() {
  const args = process.argv.slice(2);
  let offlineOnly = false;
  for (const a of args) { if (a === '--offline') offlineOnly = true; else { console.error(`unknown argument: ${a}`); process.exit(2); } }

  if (offlineOnly) {
    const seed = H.seedHex(777);
    const h = honestTrace(seed, 'good', 3);
    const fin = offline(seed, h.events);
    check(fin.score === h.score && fin.debug.steps === h.frame, `offline replay of an honest run: ${fin.score} at step ${fin.debug.steps}`);
    for (const a of attacks(seed, h)) check(a.expect <= h.score, `${a.name}: reduces to ${a.expect} (honest ${h.score})`);
    process.exit(fails ? 1 : 0);
  }

  // 1. three honest runs on the real pipeline
  for (const [pilot, rng] of [['good', 1], ['average', 2], ['novice', 3]]) {
    const ses = await startLabSession();
    const h = honestTrace(ses.seed, pilot, rng);
    const r = await submitAndRead(ses, h.events, h.score, h.frame / 60 + 3);
    check(r.replayedScore === h.score && r.storedScore === h.score, `${pilot}: claimed ${h.score} == replayed ${r.replayedScore} == stored ${r.storedScore}`);
    check(r.lab === true && r.isCounted === false && !r.leaderboardRow, `${pilot}: lab run, not counted, no leaderboard row`);
    const fin = offline(ses.seed, h.events, h.frame / 60 + 3);
    check(fin.score === r.storedScore, `${pilot}: the stored trace replays offline to the same score`);
  }
  // 2. attacks reduce to what their acts earn
  const ses0 = await startLabSession();
  const h0 = honestTrace(ses0.seed, 'good', 9);
  for (const a of attacks(ses0.seed, h0)) {
    const ses = await startLabSession();
    // each attack is replayed against its own session's seed
    const events = a.events;
    const expect = offline(ses.seed, events).score;
    const r = await submitAndRead(ses, events, a.claim, 330);
    check(r.storedScore === expect && r.storedScore < a.claim + 1, `${a.name}: stored ${r.storedScore}, earned ${expect}, claimed ${a.claim}`);
    check(r.isCounted === false && !r.leaderboardRow, `${a.name}: not counted, no leaderboard row`);
  }
  console.log(fails ? `${fails} check(s) failed` : 'all lab checks passed');
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
