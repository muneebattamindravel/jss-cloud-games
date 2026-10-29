# Rang Bharo (`rang-bharo`): package report

## 1. The game
A ball sits in a maze of floor tiles and walls. A swipe (or an arrow key) sends
it sliding until a wall stops it, and every tile it rolls over floods with
colour. Paint every floor tile and the maze is cleared: the tiles ripple, burst
into confetti, a big "+N" rises, and the next maze slides in 0.9 s later. The
run is a 3 minute clock (00:00, red and ticking in the last 10 s). A newly
painted tile is 1 point, a cleared maze pays 10 x its number, and clearing
within par (the shortest solution, found by BFS) adds a PERFECT bonus of
25 + 5 x its number. Mazes grow from 6x6 to 11x13. One move at a time: a swipe
during a slide is buffered (only the latest). Code-drawn art (raised plateau,
carved corridors, truck-art lights and diamonds, five truck-art palettes),
Web Audio only. Mechanic of a well known sliding-paint maze game; no name, art
or sound taken. The founder's icon artwork is the platform icon.

Founder's feel verdict, after playing the build with the interactive
practice: **"okay i think this game is perfect."** One round of feedback came
before it: "the game has a pop up tutorial. i don't want pop up tutorials, i
want interactive tutorial". The fix was a removal (the HOW TO PLAY popup and
its demo) and a replacement inside the platform's rules: a guided practice
maze the player solves with real swipes before the first run (an arrow of
chevrons and a flicking finger show each swipe, a wrong one bumps and says
TRY RIGHT, SKIP any time), outside the run, never traced or scored, gated by
KJTut once per rotation; HOW TO PLAY on the menu replays it.

## 2. Trace and versions
- Trace v1: `{kind:'start', v:1, tHint}` then one `{kind:'move', n, dir, step, tHint}`
  per ACCEPTED swipe or key. `n` is the index among accepted moves, `dir` is
  0 up, 1 right, 2 down, 3 left, `step` is the fixed step it applies before
  (it runs before step `step + 1`). The action only, never its result.
- At most one move per step is accepted by the rules (`lastInput`).
- Rules version 1. No history yet. `initSim(seed, version)` takes the version
  from the start marker (clamped to `RULES_VERSION`), ready for a v2.
- Humanness: `GAME_INPUTS['rang-bharo'] = { kinds: ['move'], time: 'step' }`.
  The adversarial suite adds that entry and checks `features.inputs` equals the
  move count.

## 3. One rules block, pinned
`// ==== RANG BHARO RULES BEGIN ====` ... `END` is byte-identical in
`games/rang-bharo/js/game.js` and `shared/anticheat/validators/rangBharo.js`
(`node scripts/rb-sync-validator.js` copies it after a deliberate change). The
parity suite pins the block's sha256, every constant by value (RULES_VERSION,
STEP_HZ, TIME_STEPS, STEPS_PER_TILE, CLEAR_PAUSE, MAZE_BASE, PERFECT_BASE,
PERFECT_PER, MAX_W, MAX_H, GEN_ATTEMPTS, SOLVE_CAP, DX, DY, MAX_INPUTS,
MAX_SIM_STEPS) and the whole difficulty curve (grid size, floor share, move
budget, greed, minimum par) at 13 maze numbers. `RB_SKIP_PIN=1` turns the pins
off for the battery's behaviour-only pass. Integer rules only: no trig, no
clock, no screen, no randomness (asserted on the block text).

## 4. Passable, and nobody parks
- Maze n is a pure function of (seed, n). The generator simulates the sliding
  ball itself: it carves the corridor each slide travels and pins the wall
  that stops it so later carving cannot reopen it. Every floor tile lies on
  the designed route, so every maze is solvable by construction.
- **No traps.** Slides are not always reversible, so a careless move could
  strand the ball where the last tile can never be reached (found by the
  flawless pilot during stage 2: a run soft-locked on maze 15). The generator
  now refuses any maze where some stop the ball can reach cannot get back to
  the start (`trapFree`). With that, every tile stays reachable whatever the
  player does. A ring corridor is the deterministic fallback; no measured seed
  has needed it.
- Measured: 300 seeds x 16 mazes (4800), every maze trap-free, none empty;
  2000 seeds x 12 mazes before the trap rule, 0 unsolvable, 0 painted at the
  start, 4800 designed routes driven through the real sim with 0 failures. In
  the suite: 300 seeds x 14 mazes driven through the rules by their designed
  route; BFS par agrees with an independent BFS on 360 small mazes.
- Par is exact BFS up to 60000 states; past that it is the designed route's
  length, an upper bound (about 3% of mazes from maze 8, 12 to 18% at maze 12).
  On those few mazes PERFECT is a move or two easier than the true optimum.
- Parked: a run with no input ends exactly at TIME_STEPS (10800), in the game
  and on the server. A hidden tab does not stop the clock (timer pump).

## 5. Parity
Real game.js flown through the real input path (pointer events, keys) by 21
runs: good, average, novice, bot, greedy, spammer, cycler, multi-finger (2
seeds each), idle, flawless x2. The whole world (ball, slide, sub-step, buffer,
pause, painted set, maze cells and par, score, events) is compared after EVERY
step against the validator's rules: over 200000 step-worlds per pass. Coverage
counters must be non-zero: buffered moves, wall bumps, PERFECT and missed
clears, inputs during the clear pause, the largest grid, inexact-par mazes, a
run ending mid-slide. Same schedule and world digest at 320x568, 375x812,
768x1024, 1440x780, 414x896, 120 and 144 Hz, DPR 1 and 3, a shifted clock, a
different Math.random, drawing on; 30 Hz and uneven 32/4 ms frames replay
exactly; one second of frames is 58 to 62 steps at 30, 60, 120 and 144 Hz;
ten hidden seconds are 598 to 603 steps.

## 6. Suite counts
- Parity: 67 tests. Adversarial: 48. Render: 20 (page contract, session gate,
  one run per session, submit after the end screen, hidden-tab submit, QA
  switches, the practice, strict canvas at 3 viewports, gradients per frame).
  Replay: 9. Total 144, about 150 s with `npx jest --runInBand rangBharo`.
- Cross-engine: `scripts/rb-cross-engine.js` hashes the world after every step
  of the 10 golden schedules in Node and headless Chrome: 10/10 identical.
- Golden runs: 10 (v1, `shared/tests/fixtures/rangBharoGolden.json`):
  flawless, good x2, average, novice, bot, greedy, spammer, idle, cycler.
  Regenerate only with a version bump (`node shared/tests/lib/rangBharoGoldenGen.js`).
- Golden mazes: 9 (`shared/tests/fixtures/rangBharoGoldenMazes.json`), chosen by
  measurement because they sit on rare generator branches (the 38% floor gate,
  the minimum-par cap at maze 16): 8 and 1 of 4800 mazes change when those
  constants move.

## 7. Mutation battery
`shared/tests/lib/rangBharoMutate.js`, 125 mutations over the constants, the
seed and hash, the difficulty curve, the generator (stop pinning, trap check,
solver, fallback ring, memo key), the sim (buffering, one input a step, the
clock, scoring, PERFECT), the validator interface (rewind, index, typeof,
input cap, elapsed cap, start marker, claimed score, debug fields) and the
client (emit order and fields, swipe and flick thresholds, fingers, key
repeat, READY input, inbox, backup clock and catch-up, submit timing, one run
per session, session gate, ?seed, trace marker, replay, the practice). Run
from scratch copies only, 4 shards.

- With the pin tables: **124 live caught, 1 inert, 0 survivors.**
- Behaviour only (`--nopin`, pins and rules hash off): **121 live caught, 4 inert, 0 survivors.**
  The three extra inerts are measured on 4800 regenerated mazes (300 seeds x 16):
  `GEN_ATTEMPTS` 60 to 59, `stuck 13` and `SOLVE_CAP` 59999 change 0 mazes; their
  large variants (`GEN_ATTEMPTS small`, `stuck 3`, `SOLVE_CAP small`) are caught.
- Dead code found by the battery and removed (goldens unchanged): the 'best
  attempt' fallback (0 of 4800 mazes reach it; the ring stays as the total
  fallback), a queued-at-rest branch (a buffered swipe is always taken at the
  wall or the next maze) and the stepSim over guard (the clock check ends the
  run identically).
- Inert, with a measurement: `c: catch-up 6` (owed steps are never dropped,
  so a per-frame cap of 3 or 6 runs the same steps on the same wall clock;
  every suite passes with 6). Its large variant `c: catch-up 1` is caught.
  `GEN_ATTEMPTS` 60 to 59 is listed as possibly inert (no measured maze needs
  the 60th attempt); it was caught by the pin table, and `GEN_ATTEMPTS small`
  (1) is caught by behaviour.
- Survivors found and fixed on the way (all holes in the tests or guards that
  masked each other): the validator's direction check (duplicated the rules'
  own, removed); the client's end-of-run, replay-input and second-run guards
  (shadowed by one central guard each, removed); a swipe firing mid-move,
  two and three swipes inside one frame, a swipe in READY held over into the
  run, a wrong practice swipe in an open direction, the practice world
  stopping at its clear (tests added).

## 8. Ladder and `max_score_per_sec`
24 seeds, 3 minute runs, the real game.js, the validator agreeing on every run:

| pilot | median | p10 | p90 | mazes | perfects |
|---|---|---|---|---|---|
| idle | 0 | 0 | 0 | 0 | 0 |
| cycler (up, right, down, left forever) | 10 | 3 | 61 | 0 | 0 |
| spammer (random swipe every 4 steps) | 528 | 410 | 705 | 7 | 0 |
| novice | 706 | 649 | 921 | 8 | 1 |
| lazy human (most-paint way, human pace, no plan) | 1464 | 865 | 1938 | 12 | 4 |
| average | 2138 | 1901 | 2369 | 14 | 7 |
| greedy bot (the same, zero thinking time) | 2438 | 1243 | 3337 | 16 | 5 |
| good | 5095 | 4551 | 5259 | 21 | 19 |
| multi-finger (good plus resting fingers) | 5095 | 4551 | 5259 | 21 | 19 |
| bot (plans, a 10-step metronome) | 5291 | 5252 | 5662 | 21 | 21 |
| flawless (plans, zero think, buffers ahead) | 8162 | 8087 | 8630 | 27 | 27 |

good / average 2.38 (target 1.5 to 3.5). The lazy strategy (swipe whichever
way paints the most, never plan) at human pace scores 0.69 x average and
0.29 x good: it beats a novice but not a planner. Planning is what separates
the board's top from the middle.

`max_score_per_sec = 212`: the flawless pilot's best 60 s window over 24
seeds is 4233 points (70.55/sec, late in the run when clears pay most); x3.

## 9. Bot gap
The course is a pure function of the seed, so a program that reads it plays
every maze at par with no thinking time: flawless 8162 vs good 5095, **1.60 x a
good human**, and a planner with a fixed 10-step rhythm already matches a good
human (5291). Replay cannot see this. `finalize().debug` records, never
gates: `waitMean/waitSd/waitCv/waitMin` (steps from the ball at rest to the
next swipe), `readMean/readCv` (first look at each maze), `bufferedShare`
(swipes sent while rolling), `overParMean`, `perfectShare`, `gapCv`, `gapMin`.
A metronome bot shows `waitCv` near 0 (tested under 0.05; a hand is over 0.2)
and `readMean` 0; a flawless bot shows `perfectShare` 1 with `waitMean` 0.
Keep humanness in record mode and the game out of paid rotation until there
is real data.

## 10. Draw cost and size
Headless Chromium, GPU rasterization on, CPU throttled 6x, DPR 2, a run
playing (time inside each animation-frame callback):

| viewport | median | p95 | max |
|---|---|---|---|
| 375x812 | 6.2 ms | 13.1 ms | 319 ms |
| 320x568 | 4.2 ms | 9.8 ms | 25 ms |
| 1440x780 | 5.5 ms | 11.7 ms | 18 ms |

The one long frame is the maze change (the next maze and its board sprite are
built while the clear celebration plays); everything else fits a 60 Hz frame
with room. Generating a large maze takes up to about 0.2 s on a desktop core
(next maze is generated during the confetti).

Folder size: `games/rang-bharo` is 108 KB (index.html, js/game.js, the
Titan One subset). **A real phone was not measured.**

## 11. Registration and integration
- Draft: `migrations-draft/264_register_rang_bharo.sql` (re-check the number):
  id `rang-bharo`, name Rang Bharo, sort_order 62, `max_score_per_sec` 212,
  durations 1 to 3600, inactive, `anticheat.rang-bharo.require_claimed_match`
  false, `humanness.rang-bharo.mode` record.
- Icon: `web/public/games/rang-bharo.png`, the founder's artwork at 512 px,
  256 colours.
- The five one-line hunks in kj-platform:
  1. `shared/anticheat/validators/index.js`: `'rang-bharo': require('./rangBharo'),`
  2. `shared/anticheat/humanness/features.js` `GAME_INPUTS`: `'rang-bharo': { kinds: ['move'], time: 'step' },`
  3. `services/game-service/src/routes/adminReplay.js` `PLAYBACK_GAMES`: `'rang-bharo'`
  4. `shared/tests/sessionLifetime.test.js`: add the validator.
  5. `shared/db/seeds/index.js`: a seed entry with `max_score_per_sec: 212`.

## 12. Open items for the founder
1. The scoring numbers (tile 1, clear 10 x n, PERFECT 25 + 5 x n, 3 minutes)
   were proposed, not tuned with you.
2. The lazy no-plan strategy reaches 0.69 x average. If you want planning to
   matter more, options: a bigger PERFECT bonus, a small cost per move over
   par, or fewer floor tiles worth points (more of the score in clears).
3. The bot gap (1.6 x good) is the humanness layer's job; record mode first.
4. Big-maze par is an upper bound on a few percent of mazes (section 4).

## Platform snapshot notes
- `docs/HANDBOOK.md` and the session brief reference `games/pearls-connect`,
  which is not in this repo; Chakkar Chaku and Snake Blocks were the models.
- `npx jest` fetched jest on the fly; `npm ci --cache /tmp/npmcache` installs
  the devDependency properly (the battery needs `node_modules/.bin/jest`).
