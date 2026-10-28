# Package report: Pearls Connect (pearls-connect)

Status: game approved for feel by the founder; anti-cheat stage built and tested
in the workshop. Scoring decided (section 12). The battery is being re-run on the
final scoring; see section 7.

## 1. The game
A 6 x 6 board of pearls in five colours. Drag through pearls of one colour, up,
down or sideways; lifting the finger clears the chain, and n pearls pay
n(n-1)/2 (2: 1, 4: 6, 6: 15, 10: 45). Closing a loop (back onto a pearl at
least four back) clears every pearl of that colour on the board and pays double.
Pearls above fall, new ones drop in (never the loop's colour right after a
loop), and a board with no pair reshuffles. Five minutes on the clock; the score
is the points. Code-drawn art (glossy pearls with a faint mark per colour for
colour-blind players), Web Audio only, Titan One (open licence, already shipped
on the platform). Renamed from Moti Jor.

Founder's verdict on feel (28 Oct): "amazing game"; asked for a 5 minute clock
shown as 00:00, then the new name. "Rest all is good."

## 2. Trace and versions
- `{ kind: 'start', v: 2, tHint }` then one `{ kind: 'chain', n, step, down, cells, tHint }`
  per chain the rules accepted: `n` its index, `step` the fixed step the finger
  lifted (applied before step + 1), `down` the step it began, `cells` the board
  cells (index r * 6 + c) in drag order, a loop ending on its closing pearl.
- Rules version 2 is the first (v1 is the platform's "not a replay" marker and
  scores 0). The points table changed from n(n+1)/2 to n(n-1)/2 on 28 Oct, in
  place, before any run was scored anywhere; from here a change is a bump.
- One chain at most a step; a second on the same step is refused on both sides.

## 3. The rules block
`// ==== PEARLS CONNECT RULES BEGIN/END ====`, byte-identical in
`games/pearls-connect/js/game.js` and `shared/anticheat/validators/pearlsConnect.js`,
pinned by sha256 and by a pin table of every constant (`PC_SKIP_PIN=1` turns the
pins off for the battery). Integers only; no trig, no dmath, no clock, no
randomness, no screen. Every pearl is `hash(seed, column, k)` for the k-th pearl
to enter that column; shuffle attempt t uses hash row 100 + t. Lists in the sim
are replaced, never pushed onto.

Audit while building: a `typeof` guard in `readChain` was masked by the
`a !== Math.floor(a)` check and was deleted. The off-board guards are NOT
masked: without them a forged `[36, 42]` reads as two neighbouring pearls of the
same (undefined) colour and scores. Both are now tested with that exploit.

## 4. Passable and parked
- 20000 seeds: every opening board has a pair.
- 2000 seeds x 150 random chains: every board after every chain has a pair;
  shuffles happen naturally (over 50 in that corpus); the worst shuffle needed
  fewer than 64 attempts, so the forced-pair fallback is never reached in play
  (it is tested on a hand-made board of 36 different kinds).
- Parked: a run with no input ends at exactly 18000 steps (5:00) with 0, on the
  client and the server. The clock is the only end; nothing can outlive it.

## 5. Parity
`pearlsConnectParity.test.js`, 70 tests: 29 full 5 minute runs (good, average,
novice, spammer, idle, multi-finger x 4 seeds, flawless x 3, bot x 1) compared
field for field after every step (board, spawn counters, shuffles, chains, last
step, score, the step's events), over 400000 step-worlds; the same flawless run
at 5 viewports (320x568 to 1440x780), 120 and 144 Hz, DPR 1/2/3, a shifted
clock, another Math.random and drawing on, all identical; 30 Hz and uneven
32/4 ms frames replay exactly; 58 to 62 steps a wall-clock second at 30/60/120/144
Hz; coverage counters (loops, shuffles, long chains) must stay above zero.

## 6. Other suites
- Adversarial: 45 tests (forged claims, no/v1/second start marker, stacking,
  rewind, wrong index, bad `down`, 10 malformed shapes, junk inside an honest run,
  chains after the clock, elapsed cap, input cap, the off-board exploit, machine
  vs hand fingerprint, the humanness extractor counting every chain, and the
  rules' edges on hand-placed boards with literal answers).
- Render: 21 tests (page contract, session gate with no timeout, one run per
  session, TIME'S UP before submit, hidden-tab submit, standalone vs embedded,
  QA switch dead inside the platform, HOW TO PLAY gating, strict canvas at 3
  screens, no gradient per frame, drawing never writes the sim).
- Replay: 8 tests (5 pilots, a flawless run at speed 8, real input ignored,
  speed 0 pauses).
- Goldens: `pearlsConnectGolden.json`, 8 runs, rules v2.

## 7. Mutation battery
`shared/tests/lib/pearlsConnectMutate.js`, 103 mutations, run from four scratch
copies (one per shard), pins on. Result: **103 live caught, 0 inert, 0 survivors.**
The first pass caught 99 and 4 survived, all holes in the tests, none in the
game; each was fixed and the 4 re-run and caught:
- `c: qa switches embedded` and `c: session not awaited`: the same check sat in
  two places (qp and start; the buttons and start), so neither could be broken
  alone. The duplicate was deleted; the one every path takes is tested.
- `v: skipped loops not recorded`: pinned with an exact case (1 when a 2 x 2
  loop is ignored, 0 when it is taken).
- `v: suspicious threshold`: pinned at its edge (9 refusals clean, 10 marked).
`LOOP_MIN 3` is behaviourally inert (cycles on a square grid are even, so a loop
cannot close 3 back) and is caught only by the pin table; 2 and 5 are caught by
behaviour. A `--nopin` pass (behaviour alone) has NOT been run yet.

## 8. Ladder and bound
24 seeds, full 5 minute runs, the real game.js flown by human-model pilots
(scoring n(n-1)/2):

| pilot | median | p25 | p75 | chains | best 60 s, /sec |
|---|---|---|---|---|---|
| idle | 0 | 0 | 0 | 0 | 0 |
| novice | 253 | 214 | 293 | 73 | 4.08 |
| average | 566 | 492 | 716 | 124 | 12.45 |
| good | 1433 | 1109 | 1894 | 208 | 33.48 |
| pairs (fast, no planning) | 678 | 675 | 683 | 678 | 2.47 |
| spammer (random pairs, not human-paced) | 284 | 262 | 309 | 284 | 1.58 |
| flawless (best move, fast hand) | 12444 | 10095 | 13962 | 1265 | 161.95 |
| bot (best move every step) | 165265 | 159248 | 176961 | 17995 | 865.57 |

good/average 2.53, average/novice 2.24: skill decides, with a wide spread inside
each style. A fast pair-swiper beats a slow average planner (678 vs 566) but a
good planner scores 2.1x the pair-swiper. Under the first table, n(n+1)/2, the
pair-swiper scored 2034 against good 2177; that is why the table changed.

`max_score_per_sec` = 486 = 3 x 161.95 (flawless pilot's best 60 s window).

## 9. Bot gap
The board is a pure function of the seed, so a program plays perfectly: the
flawless pilot scores 8.7x a good human, a one-chain-a-step bot 115x. Replay
cannot stop that. The validator records, never gates: decision time between
chains (gapMean, gapSd, gapCv), hand speed (dragMean, dragSd: steps a pearl),
chain length (lenMean, lenMax), loops taken, and loopSkipped (a 2 x 2 loop was
on the board and the player took something else; a planner never does). A
machine reads dragMean 0 and gapMean under 5 steps. Keep humanness in record
and the game out of paid rotation until there is real data.

## 10. Draw cost and size
Game folder 93 KB (game.js, index.html, one 11 KB font). Draw cost was NOT
measured on a throttled GPU or a real phone here; the strict-canvas suite only
proves every frame draws without a bad value. Measure at integration.

## 11. Integration
- Migration draft: `migrations-draft/NNN_register_pearls_connect.sql` (inactive,
  sort_order 62, bound 486, durations 1 to 3600, claimed-match off, humanness record).
- Icon: `web/public/games/pearls-connect.png`, 512 px, 256 colours, from the founder's artwork (28 Oct). Store
  screenshots in `packages/pearls-connect-media/` (not part of the package).
- The five hunks:
  1. `validators/index.js`: `'pearls-connect': require('./pearlsConnect'),`
  2. `humanness/features.js` GAME_INPUTS: `'pearls-connect': { kinds: ['chain'], time: 'step' },`
  3. `adminReplay.js` PLAYBACK_GAMES: `'pearls-connect'` (the replay suite passes)
  4. `sessionLifetime.test.js`: add the validator
  5. `seeds/index.js`: the seed entry, bound 486

## 12. Decisions and open items
1. Decided 28 Oct: pair-swiping nearly matched skill (2034 vs 2177); the founder
   chose option (a), n(n-1)/2. Now good scores 2.1x a pair-swiper (section 8).
2. The run starts with a 1 s READY / GO on the client; the server clock starts at
   GO. Fine for fairness, noted for the record.
3. Not measured here: a real phone, draw cost with GPU throttling.
