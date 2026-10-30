# Tetris Smash (`tetris-smash`): package report

## 1. The game and the founder's verdict

A falling-block line-clearing game in a 10 x 20 well (two hidden rows above;
the board is 10 x 22). Seven pieces from a seeded 7-bag; a next-3 preview.
Drag sideways to move (one column per 24 design px), tap to turn clockwise,
swipe down to drop, hold a finger still to soft-drop. 1/2/3/4 rows score
100/300/500/800 x level, a four right after a four x1.5, a combo of clearing
pieces +50 x combo x level, a hard drop +2 a row. Level up every 10 rows;
gravity per level from a fixed table. The run ends at 5 minutes or when a
piece cannot spawn. Look: glazed blocks on a dark charcoal well, full-width,
under one top bar (SCORE, TIME, level, NEXT). Web Audio only.

Founder's verdict (28 Oct 2026): **"It's fun now."** HOLD was removed at the
founder's request in the same message.

## Founder decisions

- **Name (28 Oct 2026):** "Tetris Smash", id `tetris-smash`, chosen as final
  after being told that "Tetris" is a registered trademark enforced against
  other games, and that it conflicts with standing rule 6 in `CLAUDE.md` and
  the founder's own brief. **Integration must flag this for legal review before
  the game goes live.** Everything else is original: our glazed-block art,
  colours, charcoal frame, layout, Titan One logo lettering, icon, sounds and
  copy. No logo, colour scheme, music or look of any other falling-block game.
- **HOLD removed** (28 Oct 2026). Action 7 no longer exists; the rules refuse it.
- **No catch-up cap on the step clock** (from the original brief): fixed 1/60 s
  steps follow the wall clock, plus a 1 s interval that keeps a hidden tab
  moving so the run still ends and submits. The handbook's usual cap is 2 to 3
  steps; this game deliberately has none so the 5 minute clock is real time.
- Previously named Girti Eentein (`girti-eentein`), built in kj-platform. It was
  renamed before any validator, golden run or migration existed, so nothing
  downstream carries the old id.

## 2. Trace format and versions

- `{ kind: 'start', v: 2 }`, then one `{ kind: 'act', n, a, step }` per
  ACCEPTED action: `n` its index in the run (`sim.n` before it applied), `a`
  the action (0 left, 1 right, 2 clockwise, 3 anticlockwise, 4 soft drop on,
  5 soft drop off, 6 hard drop), `step` the step it was applied before.
- Each step, on both sides: `beginStep`, then every act naming that step in
  trace order, then `stepSim`. Several acts on one step are legal (a fast drag
  crosses several columns in one frame); every act is still a real rules step.
- Rules version 2 is the first and only version (v1 means "no replay" and
  scores 0). A rules change is a trace version bump, never an edit in place.

## 3. The rules block

`// ==== TETRIS SMASH RULES BEGIN ====` to `END`, byte-identical in
`games/tetris-smash/js/rules.js` and `shared/anticheat/validators/tetrisSmash.js`,
sha256 `5ba02acf9782e3abe16359ea8acb62eb22925a19cb7de493b4a5954ca555a2b5`.
Integers only (`+ - * / floor min max imul`, bit ops); no trig, no
Math.random, no clock, no screen. The pin table in the parity suite pins every
constant by value, plus the GRAVITY, LINE_POINTS, BOX, BASE, KICKS and
KICKS_I tables (`TS_SKIP_PIN=1` turns the pins off for the mutation battery).

## 4. Passable and parked

- Every bag is a permutation of the seven pieces (2,000 seeds x 40 bags).
- Nobody parks: gravity never stops, a grounded piece locks after 30 steps,
  a move or turn on the ground restarts that wait at most 15 times a piece,
  and the clock ends every run at exactly 18,000 steps. An untouched run tops
  out by itself (worst of 40 seeds well under 5 minutes; 94 s median).
- A run is never longer than 5 minutes of steps, far inside the 60 minute
  session.

## 5. Parity

`shared/tests/tetrisSmashParity.test.js`: the WHOLE world is compared after
every step (all 220 cells, the piece, bag position `k`, gravity count, lock
wait, resets, soft, spawn wait, combo, back-to-back, score, lines, level, act
count, end and the step's events), bit-exact against an independent replay on
the validator's functions, for 23 flown runs (good, average, novice, spammer,
idle x 4 seeds, flawless x 3): more than 80,000 step-worlds compared. The
validator's final score, end step and act count match every run with zero
rejects, and the page submits exactly that score, once.

Device independence: five viewports (320x568 to 1440x780) for both a key
player and a TOUCH player (gestures sized in design px give the identical
schedule on every screen), 120 and 144 Hz, 30 Hz (exact replay), uneven
32/4 ms frames, DPR 1/2/3, a shifted clock, a different Math.random; one
second of frames is 58 to 62 steps at 30/60/120/144 Hz; a hidden tab still
ends at 5 minutes and submits.

Hand-placed edges: every kick test of every turn (6 pieces x 8 turns x 5
tests, each on a board built to refuse the tests before it), a turn refused
by all five tests, the lock-reset cap, landing to lock timing, spawn top-out,
the clock end, back-to-back fours, combos and their end, the level boundary
(scored at the old level), gravity per level and with soft drop, hard-drop
points, both spawn gaps, refusals changing nothing, and state replaced never
edited in place. Golden runs: 12 (v2) in `fixtures/tetrisSmashGolden.json`,
with a coverage check that the corpus reaches both endings, fours,
back-to-back, combos of 3+, level 57, kicks, the reset cap, soft drop,
anticlockwise turns and timer locks.

## 6. Suites

| Suite | Tests |
|---|---|
| tetrisSmashParity | 90 |
| tetrisSmashAdversarial | 51 |
| tetrisSmashRender | 22 |
| tetrisSmashReplay | 13 |
| **total** | **176**, all passing (`npx jest --runInBand shared/tests/tetrisSmash`, about 50 s) |

Admin replay: a stored trace played back through the real game.js reproduces
the world after every step, the score and the end step, for seven pilot
styles and a flawless run at speed 8. Fixed here: playback used to apply
every due act without the validator's checks, so a junk-laden trace would
have played back differently from what the server scored; it now applies
exactly what the validator applies (test: "a stored trace full of junk").

## 7. Mutation battery

`shared/tests/lib/tetrisSmashMutate.js`, 141 mutations (constants, every
table, rules logic, validator guards, client input and bridge paths), run from
scratch copies of the tree only, 3 shards, jest `--runInBand`, pins ON:

**139 caught, 2 inert, 0 survivors.**

The first pass left 15 survivors; each was a hole, now closed:
- two pairs of validator guards masked each other (the rewind check and the
  "act lands on its named step" check). Merged into one guard that still
  reports `frame_regressed` for a rewind;
- a malformed field (a fractional or string step) moved the server's clock
  forward before being refused, which could cost the player a real act. Now
  tested: a malformed event never moves the clock;
- test holes: the elapsed cap (the test's run topped out before the cap
  bound), the suspicious mark at exactly 10 refusals, a step's acts starting on
  a fresh event list, tap wander under 14 px, the 12 px axis lock, the 300 ms
  swipe limit, a second finger during a drag, and the practice opened after a
  run;
- the PLAY button's own session check and newRun's masked each other; the
  button's copy was removed, so newRun is the one gate and its removal is caught.

Inert, with measurements:
- `v: string accepted`: isInt's `Math.floor(v) === v` is a strict compare and
  refuses every string even with the typeof test loosened (`Math.floor('60')
  === '60'` is false). Large variant `v: fraction accepted` is caught.
- `c: replay takes real input`: in a replay processStep reads only the replay
  cursor, never the live input queue. Large variant `c: replay skips the guard`
  is caught.

Not yet run: the `--nopin` pass (pins off, behaviour alone). The pin table
catches the constant-only mutations; whether behaviour alone catches each of
them is not yet measured. Run it in kj-platform or here before going live.

## 8. Ladder and `max_score_per_sec`

`node shared/tests/lib/tetrisSmashLadder.js --seeds 20` (the real game, 20 seeds, 5 minute runs):

| pilot | median s | p25 to p75 s | median score | p25 to p75 score | median rows | full 5 min |
|---|---|---|---|---|---|---|
| idle | 94 | 90 to 97 | 0 | 0 | 0 | 0/20 |
| spammer | 6 | 5 to 7 | 334 | 286 to 352 | 0 | 0/20 |
| novice | 68 | 56 to 77 | 2,068 | 1,324 to 2,736 | 8 | 0/20 |
| average | 101 | 68 to 109 | 10,564 | 4,814 to 13,188 | 31 | 0/20 |
| good | 207 | 172 to 229 | 103,740 | 66,276 to 128,616 | 118 | 0/20 |
| flawless | 300 | 300 | 2,211,424 | 2.18M to 2.24M | 578 | 16/20 |

Good over average: 2.0x survival, 9.8x score (score grows with level, so it
is steeper than survival). No human model reaches the 5 minute clock: the
gravity ramp ends every human run by top-out (good median 3:27). The human
pilots are models (lag, timing gaps, judgement noise, slips, wasted moves);
they under-rate humans who learn. The founder should play and judge.

`max_score_per_sec = 44622`: 3 x the flawless planner's best 60 s window
(892,438 points = 14,873.967 a second, seed `ed837f26...`) over 20 seeds of
full runs.

## 9. Bot gap

The course is a pure function of the seed, so a program plays it perfectly:
the flawless planner scores 2.21M median against a good human model's 104k,
about **21x**. The validator records per run (never gates) the raw material
for the humanness layer: actions per piece, finesse (extra moves and turns
over the fewest that reach each final placement from spawn on an empty well,
mean and share of perfect pieces), placement time (steps from spawn to lock,
mean and sd), `gapCv` of the gaps between actions, and the most acts on one
step. The planner and a hand separate on finesse, placement time and acts per
step (adversarial suite). Keep the game in humanness `record` and out of paid
rotation until there is real data.

## 10. Draw cost

Headless Chromium in a container with NO GPU (ANGLE on SwiftShader, software
rasterisation; `--disable-gpu` was NOT used), DPR 2, 6x CPU throttle, the
time of every animation-frame callback (steps plus drawing), 12 s of play:

| screen | ordinary play, mean / p95 | a four every 1.2 s (worst case), mean / p95 |
|---|---|---|
| 375x812 | 8.2 / 17.6 ms | 21.0 / 58.1 ms |
| 320x568 | 5.7 / 10.1 ms | 10.4 / 19.8 ms |
| 1440x780 | 5.9 / 10.7 ms | 26.5 / 74.0 ms |

Unthrottled, the worst case is about 1.2 ms mean, 1.8 ms p95 at every size.
The cost is the clear burst (about 300 particles for a four, the chunks drawn
with rotate); ordinary play is cheap. If a real low-end phone stutters on a
four, the particle counts in `crumble` and `burst` are the knob (cosmetic, no
rules change). **No real phone was measured.**

Game folder: 5 files, about 90 KB (112 KB on disk).

## 11. Registration, icon, assets, integration hunks

- Draft migration: `migrations-draft/NNN_register_tetris_smash.sql` (number
  left for integration: 254 is taken and kj-platform was at 264 on 28 Oct
  2026). INACTIVE, `require_claimed_match` off, `humanness.tetris-smash.mode`
  record, `max_score_per_sec` 44622, durations 1 to 3600 s.
- Icon: `web/public/games/tetris-smash.png`, 512 x 512, 256-colour PNG, supplied by the founder (28 Oct 2026), with the "TETRIS SMASH" title on it.
- Game folder: 5 files, about 90 KB (font 11 KB).
- Red-team lab: `redteam/lab-tetris-smash.mjs`. **Unrun** (no platform here);
  its two platform calls are adapters to copy from a sibling lab script. The
  offline part (`--offline`) runs here and passes.

The one-line hunks for integration (edit by hand in kj-platform):

1. `shared/anticheat/validators/index.js`: `'tetris-smash': require('./tetrisSmash'),`
2. `shared/anticheat/humanness/features.js`, `GAME_INPUTS`:
   `'tetris-smash': { kinds: ['act'], time: 'step' },`
   (the adversarial suite checks `features.inputs` equals the act count for a
   human, a planner and a spammer; it registers this entry in memory when it is
   missing, so the same test passes before and after the hunk).
3. `services/game-service/src/routes/adminReplay.js`, `PLAYBACK_GAMES`: add `'tetris-smash'`
   (the replay suite passes).
4. `shared/tests/sessionLifetime.test.js`: add the `tetrisSmash` validator to the list
   (`_limits.MAX_SIM_STEPS` = 216000, `FPS` 60, `MAX_INPUTS` 60000).
5. `shared/db/seeds/index.js`: a seed entry matching the migration (same
   `max_score_per_sec` 44622).

Also add the id to the Game line-up table in kj-platform's CLAUDE.md.

Package paths:

```
games/tetris-smash/                         index.html, js/rules.js, js/game.js, css/styles.css, fonts/
shared/anticheat/validators/tetrisSmash.js
shared/tests/tetrisSmash{Parity,Adversarial,Render,Replay}.test.js
shared/tests/lib/tetrisSmash{RealGame,World,GoldenGen,Mutate,Ladder}.js
shared/tests/fixtures/tetrisSmashGolden.json
web/public/games/tetris-smash.png
migrations-draft/NNN_register_tetris_smash.sql
redteam/lab-tetris-smash.mjs
packages/tetris-smash.md
```

## 12. Open items and what is not verified

- **Legal:** the name (see Founder decisions).
- **Real phones:** nothing was measured or played on a real device; draw cost
  is headless Chromium with software rasterisation.
- **The lab** and **admin replay in a real browser** are unrun (they need the
  platform).
- **Snapshot drift:** suites ran against this workshop's snapshot of
  `games/_shared` and the humanness extractor; re-run in kj-platform.
- **Difficulty:** every human model tops out before the clock. If the founder
  wants good players to see the 5 minute end, the gravity table is the knob
  (a rules change: version bump, new goldens, new bound).
