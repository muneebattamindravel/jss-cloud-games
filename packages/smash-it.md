# Smash It (`smash-it`): package report

## 1. The game and the founder's verdict

A cannon tower smash in real 3D. A tower of glass jars, crates, logs, bricks,
ice and TNT stands on a table in front of a painted backdrop (meadow or beach).
Tap a point on the tower and a ball flies there in a straight line. Glass
shatters in one hit, crates take 2 hits, logs 3, ice 2; bricks never break but
can be knocked off. TNT blasts its neighbours. A crate or log falling hard onto
glass crushes it. Breaks score 10 to 40, anything knocked off the table scores
too, and a cleared table pays 100 + 50 x level, then the next tower is built
with a fresh ball budget (up to 6 unused balls carry over). Deeper towers come
from a library of 36 designs, with moving shields from level 3, a spinning fan
from 5 and a pendulum from 9 (one obstacle at most before level 8, two from 8,
three on boss levels, every 5th from 10). The run ends when the balls run out
with blocks standing, after 30 s with no shot, or at 40 minutes. Look: unlit
matcap blocks with ink outlines, the white and hot-pink ball, a sticker logo.

Founder's verdict: after the last round of feedback (moving tables removed,
obstacle counts capped, sounds settled: "glass sounds are now perfect") the
founder asked for icon screenshots and said **"Make it ready for integration"**.
The founder has not yet played the build with the full anti-cheat stack; the
branch must not be merged before they do.

## Founder decisions

- **Name:** "Smash It" (renamed from Kaanch Tod). Nothing from the reference
  game is used: no name, logo, art or audio.
- **Assets with written say-so (rule 6)**, recorded in `packages/smash-it.brief.md`:
  the two backdrops (ChatGPT-enhanced versions of our own code-painted scenes),
  five glass clips cut from the founder's uploads (two from commercial
  libraries, IDs SDSGARN_34872 and ODY-1143-14), and the cannon clip.
  **Confirm those licences before launch.**
- Removed at the founder's request: moving and turning tables, the level clear
  banner, tinkle sounds, the fire effect on the ball.
- **Run end rules (founder to confirm):** 30 s with no shot ends the run (a
  parked run must end so the server's run-out is bounded); a 40 minute cap
  keeps every run inside the 60 minute session.

## 2. Trace format and versions

- `{ kind: 'start', v: 1 }`, then one `{ kind: 'shot', n, x, y, step }` per
  ACCEPTED shot: `n` its index in the run (`S.shots` before it), `x` and `y` the
  target on the tower face in 1/100 world units (integers, x in -700..700,
  y in -150..1300), `step` the step it was fired before.
- Each step, on both sides: the shot (if any) for that step, then `stepSim`.
  A tap is queued and fired before the next fixed step; one press is one shot
  (KJPress), and the reload gap is 10 steps.
- Rules version 1 is the first and only version. A rules change is a trace
  version bump, never an edit in place.

## 3. The rules block

`// ==== SMASH IT RULES BEGIN ====` to `END`, byte-identical in
`games/smash-it/js/rules.js` and `shared/anticheat/validators/smashIt.js`
(`node tools/smash-it/sync-validator.js` copies it), sha256 pinned in
`shared/tests/fixtures/smashItGolden.json` (`blockHash`).

Physics is Rapier, the **deterministic** build
`@dimforge/rapier3d-deterministic-compat` 0.19.0 (cross-platform bit-exact
WebAssembly). The page vendors it as `js/vendor/rapier.js`, which embeds the
npm `rapier.cjs` byte for byte (the render suite checks this). Outside Rapier
the rules use no trig: obstacle rotations come from an integer quarter-sine
table (`SINQ`, 257 entries, scale 1e6). Every random choice is
`hash(seed, level, k)`. No Math.random, no clock, no screen in the block (the
parity suite greps for them).

The pin table pins every constant by value (field, ball, cannon, gaps, caps,
points, hit points, obstacle sizes), the 36 designs and the sine table by
hash, the seed hashes and the obstacle plan for 24 levels.
`SMASHIT_SKIP_PIN=1` turns the pins off for the mutation battery.

## 4. Passable and parked

- Passable: every block can leave the table. Jars, crates, logs, ice and TNT
  break; bricks are knocked off. Unsupported design cells are dropped when a
  tower is built, and an untouched tower stands for 10 s on every design for
  levels 1 to 40 with nothing falling (parity suite). Planks (logs) do break in
  play: 15 breaks over 45 aimed corpus runs, and the corpus asserts it.
- Parked: a run with no shots ends on the idle rule at 1,800 steps after the
  tower appeared plus the 60 step ending (about 31 s; adversarial and parity
  suites). A run kept alive by a shot every 15 s ends at exactly
  `MAX_RUN_STEPS` = 144,000 steps with `end: 'time'` (parity suite). The
  validator's run-out is bounded by `MAX_SIM_STEPS` = 216,000 and the elapsed
  cap `ceil((elapsed x 1.2 + 10) x 60)`.

## 5. Parity

The REAL page (real three.js; only the WebGL renderer is a stand-in, so the
camera and raycast that turn a tap into a shot are real) is flown in a Node
sandbox with real pointer events, and the WHOLE world is compared with the
validator after every step: step, level, balls, score, shots, last shot,
timer, phase, every block's id, hit points, position, rotation and velocity,
every ball's index, age, pierce count, position and velocity, and every
obstacle phase. Bit-exact (`Object.is` on every value).

- 20 pilot runs: sharpshooter x3, good x4, average x4, novice x3, spammer x3,
  two thumbs x3; each compares more than 10,000 values.
- An idle run (no shots, `end: 'idle'`, score 0 on both sides) and a run flown
  to its end whose submitted score equals the validator's.
- Device: viewports 320x568, 375x812, 768x1024, 1440x780, 414x896; 30, 120 and
  144 Hz; DPR 1 and 3; a different Math.random; a shifted clock; uneven frames
  (33 ms then 5 ms). One second of frames is 58 to 62 steps at 30, 60, 120 and
  144 Hz. Two thumbs landing together fire one shot.
- A rules-level corpus (client copy of `rules.js` against the validator,
  levels 1 to 29, 20 runs, 30,000 steps) agrees on every step and
  reaches every scoring event: breaks of jars, TNT, crates, ice and logs, a
  crush, falls, cracks, clears, a boss level, the fan, the pendulum, shields,
  table and shield bonks.
- **Cross-engine** (`tools/smash-it/cross-engine.js`): the shipped page in real
  Chromium (Playwright, real mouse clicks), 3 runs, 56 shots, 120 whole-world
  checkpoints, every one bit-identical to the Node validator's world.

## 6. Suites

`npx jest --runInBand smashIt` runs 130 tests in four suites, all passing
(about 4 minutes):

- `smashItParity.test.js` (56): the block, the pins, flown parity, device
  independence, golden runs, the corpus, the time end and standing towers.
- `smashItAdversarial.test.js` (51): forged score fields, no or bad start
  markers, a second start, another seed, malformed shots (12 kinds), rewinds,
  wrong or duplicate indexes, shots inside the reload gap, the suspicious mark
  at exactly 10 refusals, the input cap, the shot cap (6,000th applies, 6,001st
  refused), the elapsed cap at exact step counts, the trace size at the cap,
  the machine gun, the humanness extractor's input count, and the debug record.
- `smashItRender.test.js` (14): script order, PLAY disabled until the session,
  no session timeout, no ad-blocker names, no third-party hosts, no dashes, the
  shipped file list, the vendored Rapier equals the npm build, the end plays
  out before the score goes (1.5 s) and goes once, a hidden tab still submits,
  one run per session, QA switches dead inside the platform, the gear never
  pauses an embedded run, standalone sends nothing, no game state on window.
- `smashItReplay.test.js` (9): six pilots replayed through `kj-replay` give the
  validator's world on every step, its score and its end step; a trace full of
  junk; real taps ignored during a replay; speed 0 holds.

Golden runs: 6 (rules v1), fixed shot schedules at levels 1, 1, 1, 9, 16 and
24 with a world digest every 300 steps; the three level-1 runs also pin the
validator's score. `node shared/tests/lib/smashItGoldenGen.js` rewrites the
fixture (only on a deliberate rules change).

## 7. Mutation battery

`shared/tests/lib/smashItMutate.js`, 96 mutations: 71 in the shared rules
(applied to both files), 13 in the validator, 9 in the client and 3 in the page
bridge. Run from three scratch copies of the tree, never the working tree; an
unknown flag exits 2, and so does a run inside a git tree.

Stages run cheapest first (the pin table, render, adversarial, replay, then
full parity); a suite past 10 minutes counts as caught.

**Result: 96 live caught, 0 inert, 0 survivors.** The first pass left 5
survivors, all holes in the tests or guards masking each other:

- rewind and skipped index (validator): my tests were stopped by the 10 step
  reload first. New tests get past the reload so each guard stands alone.
- score from payload: only the final score was checked, not `newScore` per
  event. Now checked.
- replay takes real input and `?level` live in the platform: two guards each.
  The tap handler's replay check and `game.js`'s own `?level` gate were removed;
  the step loop and `Q` (empty inside the platform) are the single guards, and
  the mutations target them.

Earlier, before the battery ran, the validator's own x, y and n type checks
were removed for the same reason (the rules and the index check refuse them,
now pinned by a direct rules test); the step check stays, since a string step
would otherwise advance the sim. After the fixes all 5 re-ran caught, and the
four suites pass (130 tests). A `--nopin` pass was not run.

## 8. Ladder and `max_score_per_sec`

`node shared/tests/lib/smashItLadder.js --seeds 12` flies the real page, full
runs, 12 seeds per pilot:

| pilot | median secs | median level | score p25 / median / p75 | best |
|---|---|---|---|---|
| idle | 31.0 | 1 | 0 / 0 / 0 | 0 |
| spammer | 6.0 | 1 | 80 / 120 / 140 | 150 |
| novice | 53.0 | 4 | 840 / 1545 / 2145 | 3005 |
| average | 41.0 | 4 | 870 / 2100 / 2305 | 4060 |
| good | 19.9 | 3 | 860 / 1055 / 1360 | 2350 |
| sharpshooter | 13.8 | 3 | 630 / 890 / 1145 | 1450 |
| patient | 183.8 | 9 | 3800 / 4795 / 5950 | 9565 |

The human models differ in reaction lag and aim noise; the faster they fire,
the more balls they waste on a tower that is still moving, so "good" (short
lag) scores below "average". The patient planner aims perfectly and waits for
the tower to settle: it is the strongest player we have.

Best 60 s window over all 84 runs: 4,060 points (67.667 a second, an average
pilot's lucky run; the patient planner's best window is 3,670).
**`max_score_per_sec` = ceil(3 x 67.667) = 203.** A backstop only: the
server already computes the score from the shots. Deep levels pay larger
clear bonuses (100 + 50 x level), so revisit the bound once real runs reach
level 20+.

## 9. Bot gap

A patient perfect-aim planner scores about 2x to 4.5x the human models
(median 4,795 vs 2,100 average, 1,055 good). A seed reader can do better
still: the rules are deterministic, so a bot that simulates candidate shots
could pick the best one each time. Nothing in the score stops that; the
humanness layer and the debug record are the defence. The validator records,
never gates: `hitsPerShot`, `gapCv` (rhythm of shots), `minGap` (a planner
fires on the 10-step reload exactly), `aimSdX` and `aimSdY` (a planner's aim
is tighter in height), `maxShotsPerStep`, plus `shots`, `hits`, `breaks`,
`falls`, `clears`, `end`. The adversarial suite checks that a planner's
`gapCv` is higher, its `minGap` is the reload and its `aimSdY` lower than a
human model's.

## 10. Draw cost and folder size

Measured in headless Chromium with SOFTWARE WebGL (SwiftShader; no GPU here),
DPR 2, 6x CPU throttle, during play with shots: 375x812 median 300 ms a frame
(p95 717), 320x568 233 ms (p95 500), 1440x780 483 ms (p95 950). That is a CPU
rasteriser at one sixth speed and says almost nothing about a phone GPU; the
handbook's GPU-on measure could not be taken here. **A real phone was not
measured**; the founder's own play on phones is the evidence so far.

Folder size: 18 files, about 3.9 MB, over the 1 MB guideline. Rapier (with its
WebAssembly inlined) is about 2 MB, three.js about 0.6 MB, the two backdrops
and six audio clips the rest. A real phone was not measured.

## 11. Registration, icon, assets, integration hunks

- Draft migration: `migrations-draft/NNN_register_smash_it.sql` (number left
  for integration). INACTIVE, `require_claimed_match` off,
  `humanness.smash-it.mode` record, `max_score_per_sec` 203, durations 1 to
  3600 s.
- Icon: `web/public/games/smash-it.png`, 512 x 512, a crop of our own
  screenshot. **A placeholder**: the founder is having the real icon made from
  `packages/smash-it-screenshots/` (five 1075 x 2330 screenshots).
- Red-team lab script: not written (no platform here).

**Two platform changes this game needs that no earlier game did:**

1. The validator requires `@dimforge/rapier3d-deterministic-compat` at exactly
   `0.19.0` (pinned in this repo's `package.json`). Add it to the game-service
   dependencies.
2. Rapier starts asynchronously. The validator exports `ready` (a promise);
   `init()` throws `engine_not_ready` until it resolves. The service must
   `await require('./smashIt').ready` at start-up (or before the first Smash It
   replay). The validator frees each run's physics world in `finalize`; a
   caller that abandons a state without `finalize` leaks WebAssembly memory.

The one-line hunks (edit by hand in kj-platform):

1. `shared/anticheat/validators/index.js`: `'smash-it': require('./smashIt'),`
   (and the `ready` await above).
2. `shared/anticheat/humanness/features.js`, `GAME_INPUTS`:
   `'smash-it': { kinds: ['shot'], time: 'step' },`
   (the adversarial suite checks `features.inputs` equals the shot count for a
   human, a planner and a spammer; it registers the entry in memory when it is
   missing).
3. `services/game-service/src/routes/adminReplay.js`, `PLAYBACK_GAMES`: add
   `'smash-it'` (the replay suite passes).
4. `shared/tests/sessionLifetime.test.js`: add the `smashIt` validator
   (`_limits.MAX_SIM_STEPS` = 216000, `FPS` 60, `MAX_INPUTS` 8000). It must
   await `ready` before it calls `init`.
5. `shared/db/seeds/index.js`: a seed entry matching the migration
   (`max_score_per_sec` 203).

Also add the id to the Game line-up table in kj-platform's CLAUDE.md.

Package paths:

```
games/smash-it/                             index.html, js/{rules,game,audio}.js, js/vendor/{three.min,rapier}.js (+ LICENSE files), img/, audio/, fonts/
shared/anticheat/validators/smashIt.js
shared/tests/smashIt{Parity,Adversarial,Render,Replay}.test.js
shared/tests/lib/smashIt{RealGame,World,GoldenGen,Mutate,Ladder}.js
shared/tests/fixtures/smashItGolden.json
web/public/games/smash-it.png
migrations-draft/NNN_register_smash_it.sql
packages/smash-it.md
```

Dev tools that stay in this repo: `tools/smash-it/` (rules sync, backdrop
painter, cross-engine probe).

## 12. Open items and what is not verified

- **The founder has not played this build** with the bridge and one run per
  session. Do not merge to main before they do.
- Licences of the two library glass clips and the cannon clip.
- The 30 s idle end and the 40 minute cap are my choices; the founder should
  confirm them.
- Folder size (3.9 MB) is far over the 1 MB guideline, mostly the physics
  engine. First load on a slow connection was not measured.
- Draw cost on a real phone was not measured.
- A shot-searching bot (one that simulates candidate shots with the public
  rules) was not built; its score ceiling is unknown. `max_score_per_sec`
  will not catch it; the humanness layer must.
- Real three.js draws were not checked for NaN in Node (the renderer is a
  stand-in); the Chromium probe ran the real renderer without errors.
- Platform snapshot issues: none found.
