# Rang Bharo (`rang-bharo`): package report

## 1. The game
A ball sits in a maze of floor tiles and walls. A swipe (or an arrow key) sends
it sliding until a wall stops it, and every tile it rolls over floods with
colour. Paint every floor tile and the maze is cleared: the tiles ripple, burst
into confetti, a big "+N" rises, and the next maze slides in 0.9 s later. The
run is a 3 minute clock (00:00, red and ticking in the last 10 s). A newly
painted tile is 1 point, a cleared maze pays 10 x its number less 3 for each
move over par (never below 0, taken at the clear so the score never drops
mid-maze), and clearing within par (the shortest solution, found by BFS) adds
a PERFECT bonus of 40 + 8 x its number. Mazes start at 4x4 (cleared in
seconds), grow a row or a column each maze to 11x13 at maze 18, and past that
keep getting longer and more bent (par about 3 at maze 1, 27 at 18, 38 from
24, the most an 11x13 phone board carries). One move at a time: a swipe
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

After that verdict, two founder asks changed the rules (v1 edited in place:
nothing has shipped): "the starting maze should be much smaller grid so that
initial few mazes, user can just boost through the levels really quickly and
they keep on increasing in size and difficulty", and, on the ladder that
followed, "do all 3. better players should get more rewards" (keep the tiny
start, raise PERFECT from 25 + 5n to 40 + 8n, charge 3 a move over par).

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
PERFECT_PER, OVER_COST, MAX_W, MAX_H, GEN_ATTEMPTS, SOLVE_CAP, DX, DY,
MAX_INPUTS, MAX_SIM_STEPS) and the whole difficulty curve (grid size, floor
share, move budget, greed, twist, minimum par) at 15 maze numbers. `RB_SKIP_PIN=1` turns the pins
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
  length, an upper bound: none before maze 14, about 1 in 6 at maze 16, and
  most mazes from maze 20 on, where routes are long. On those mazes PERFECT is
  par as designed rather than the true optimum, so it may be a move or two
  easier than perfect play, and the over-par cost is counted from that par.
- Curve measured on 100 seeds x 36 mazes: no maze falls back to the ring,
  generation averages under 0.13 s a maze (worst 0.22 s) and runs during the
  clear celebration.
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
- Parity: 67 tests. Adversarial: 49. Render: 20 (page contract, session gate,
  one run per session, submit after the end screen, hidden-tab submit, QA
  switches, the practice, strict canvas at 3 viewports, gradients per frame).
  Replay: 9. Total 145, about 200 s with `npx jest --runInBand rangBharo`.
- Cross-engine: `scripts/rb-cross-engine.js` hashes the world after every step
  of the 10 golden schedules in Node and headless Chrome: 10/10 identical.
- Golden runs: 10 (v1, `shared/tests/fixtures/rangBharoGolden.json`):
  flawless, good x2, average, novice, bot, greedy, spammer, idle, cycler.
  Regenerate only with a version bump (`node shared/tests/lib/rangBharoGoldenGen.js`).
- Golden mazes: 12 (`shared/tests/fixtures/rangBharoGoldenMazes.json`), chosen by
  measurement because they sit on rare generator branches (the 38% floor gate,
  the minimum-par cap at maze 16): 8 and 1 of 4800 mazes change when those
  constants move.

## 7. Mutation battery
`shared/tests/lib/rangBharoMutate.js`, 135 mutations over the constants, the
seed and hash, the difficulty curve, the generator (stop pinning, trap check,
solver, fallback ring, memo key), the sim (buffering, one input a step, the
clock, scoring, PERFECT), the validator interface (rewind, index, typeof,
input cap, elapsed cap, start marker, claimed score, debug fields) and the
client (emit order and fields, swipe and flick thresholds, fingers, key
repeat, READY input, inbox, backup clock and catch-up, submit timing, one run
per session, session gate, ?seed, trace marker, replay, the practice). Run
from scratch copies only, 4 shards.

- With the pin tables: **134 live caught, 1 inert, 0 survivors.**
- Behaviour only (`--nopin`, pins and rules hash off): **130 live caught, 5 inert, 0 survivors.**
  The four extra inerts are measured by regenerating the mazes each constant
  can reach: `GEN_ATTEMPTS` 120 to 119 (no maze needs the 120th attempt; no ring
  fallback in 3600 mazes), `SOLVE_CAP` 59999 (no BFS ends between the two),
  `minPar early` (no maze 3 in 400 seeds has par below 3) and `minPar cap` 19
  (no maze 24 to 30 in 400 seeds has par below 20). Their large variants
  (`GEN_ATTEMPTS small`, `SOLVE_CAP small`, `minPar not enforced`, `minPar base`)
  are caught.
- Rare generator branches that only a pin used to catch are now pinned by
  behaviour: 12 golden mazes (`rangBharoGoldenMazes.json`) found by measuring
  which mazes the floor gate, the minimum-par cap and the first shortened-slide
  mazes (19 and 23) change.
- Dead code found by the battery and removed (goldens unchanged): the 'best
  attempt' fallback, a queued-at-rest branch, the stepSim over guard, and a
  redundant guard in the twist formula.
- Inert in both passes, with a measurement: `c: catch-up 6` (owed steps are
  never dropped, so a per-frame cap of 3 or 6 runs the same steps on the same
  wall clock; every suite passes with 6). Its large variant `c: catch-up 1` is
  caught.
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
| cycler (up, right, down, left forever) | 3 | 2 | 70 | 0 | 0 |
| spammer (random swipe every 4 steps) | 386 | 231 | 591 | 10 | 0 |
| novice | 957 | 735 | 1151 | 11 | 2 |
| lazy human (most-paint way, human pace, no plan) | 1887 | 1376 | 2476 | 14 | 7 |
| greedy bot (the same, zero thinking time) | 2109 | 1532 | 2924 | 17 | 7 |
| average | 2653 | 2451 | 3201 | 16 | 8 |
| good | 6512 | 5817 | 6712 | 23 | 20 |
| multi-finger (good plus resting fingers) | 6512 | 5817 | 6712 | 23 | 20 |
| bot (plans, a 10-step metronome) | 6989 | 6543 | 7021 | 23 | 23 |
| flawless (plans, zero think, buffers ahead) | 13121 | 12457 | 13792 | 33 | 33 |

good / average 2.45 (target 1.5 to 3.5). The lazy strategy (swipe whichever
way paints the most, never plan) at human pace scores 0.71 x average and
0.29 x good. The tiny start had raised it to 0.80 x average; the bigger
PERFECT and the over-par cost brought it back down and widened good / average
from 2.25 to 2.45. Random mashing earns less than a novice (the over-par cost
halved it). Planning is what separates the board's top from the middle.

`max_score_per_sec = 340`: the flawless pilot's best 60 s window over 24
seeds is 6786 points (113.1/sec, late in the run when clears pay most); x3.

## 9. Bot gap
The course is a pure function of the seed, so a program that reads it plays
every maze at par with no thinking time: flawless 13121 vs good 6512, **2.0 x a
good human** (the tiny early mazes let a program race further), and a planner
with a fixed 10-step rhythm already beats a good human (6989). Replay cannot see this. `finalize().debug` records, never
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
  id `rang-bharo`, name Rang Bharo, sort_order 62, `max_score_per_sec` 340,
  durations 1 to 3600, inactive, `anticheat.rang-bharo.require_claimed_match`
  false, `humanness.rang-bharo.mode` record.
- Icon: `web/public/games/rang-bharo.png`, the founder's artwork at 512 px,
  256 colours.
- The five one-line hunks in kj-platform:
  1. `shared/anticheat/validators/index.js`: `'rang-bharo': require('./rangBharo'),`
  2. `shared/anticheat/humanness/features.js` `GAME_INPUTS`: `'rang-bharo': { kinds: ['move'], time: 'step' },`
  3. `services/game-service/src/routes/adminReplay.js` `PLAYBACK_GAMES`: `'rang-bharo'`
  4. `shared/tests/sessionLifetime.test.js`: add the validator.
  5. `shared/db/seeds/index.js`: a seed entry with `max_score_per_sec: 340`.

## 12. Open items for the founder
1. Scoring is the founder's chosen shape (tile 1, clear 10 x n less 3 a move
   over par, PERFECT 40 + 8 x n, 3 minutes); the exact numbers can still be
   tuned after real play.
2. The lazy no-plan strategy reaches 0.71 x average and 0.29 x good.
3. The bot gap (2.0 x good) is the humanness layer's job; record mode first.
4. From maze 20 on, par is the designed route on most mazes, an upper bound
   (section 4).

## Platform snapshot notes
- `docs/HANDBOOK.md` and the session brief reference `games/pearls-connect`,
  which is not in this repo; Chakkar Chaku and Snake Blocks were the models.
- `npx jest` fetched jest on the fly; `npm ci --cache /tmp/npmcache` installs
  the devDependency properly (the battery needs `node_modules/.bin/jest`).
