# JSS game handbook: building a game end to end

Read this whole file before writing any game code. It is the full process, in
the order you do it, with the reason for every rule. Companion files:

- `CLAUDE.md`: the short rules every session here follows.
- `docs/GAME_DEVELOPER_GUIDE.md`: the platform's own 11-section rulebook (kept verbatim).
- `docs/INTEGRATION.md`: how a finished game goes back into the main repo (`kj-platform`).
- `docs/GAME_BRIEF_TEMPLATE.md`: the one-page brief to fill in before building.
- `reference/`: every existing validator, the registration migrations, the deploy scripts.

## 0. What this repo is, and what it cannot do

This repo is a workshop. It holds a read-only snapshot of the platform pieces a
game touches (the SDK, `games/_shared`, the anti-cheat helpers, the humanness
extractor) plus two complete reference games: **Chakkar Chaku** (a tap game,
`games/chakkar-chaku`) and **Snake Blocks** (a drag game, `games/snake-blocks`),
each with its validator, tests, harness and fixtures.

A game built here is a **package**: game folder, validator, tests, fixtures,
icon and a draft registration migration. It becomes part of the platform only
when the package is copied into `kj-platform` (see `docs/INTEGRATION.md`).

It cannot: run the platform, talk to the database, deploy, touch AWS, or see
real devices. Everything that needs those happens back in `kj-platform`.
Do not try to recreate any of it here.

## 1. How the platform scores a run (the whole picture)

```
 player's phone                          our server
 ------------------                      ---------------------------------
 index.html bridge  --kjStartV2-------->  POST /session/start  (sealed call)
                    <--seed, secret-----  game_sessions row + Redis hash
 game.js plays on fixed 1/60 s steps
   each ACCEPTED input -> kjEmit('input')  (appended to a local trace)
 game over -> __kjSubmit(score)
                    --kjSubmitV2-------->  POST /session/submit (gz trace, <= 4 MB)
                                           1. replay the trace through the
                                              game's VALIDATOR (own copy of the rules)
                                           2. authoritative score = replay result
                                           3. compare with the claimed score
                                           4. max_score_per_sec backstop
                                           5. write score, leaderboard, fingerprint
                    <--score, flags-----
 humanness job (off the request): fingerprint -> verdict -> record/hold/auto
```

Consequences that drive every rule below:

- The score the client shows is a **claim**. The server computes its own from
  the seed and the inputs. They must agree (within `max(2, 5%)`) or the run
  fails when `require_claimed_match` is on.
- So the game must be **reproducible bit for bit** from (seed, inputs on step
  numbers). The validator is a second, separate transcription of the rules.
- Replay cannot tell a human from a program that plays legally. That gap is
  closed by the humanness layer, which only has what you record (section 10).

## 2. Where every file lives (here and in kj-platform)

The repo mirrors the platform tree, so a package is a plain copy.

| Piece | Path (same in both repos) | Notes |
|---|---|---|
| Game page + bridge | `games/<id>/index.html` | Copy the Chakkar Chaku bridge. |
| Rules block + drawing | `games/<id>/js/game.js` (or `js/rules.js` + `game.js`) | Rules block is carried word for word in the validator. |
| Assets | `games/<id>/{fonts,img,audio}` | Self-hosted only. Whole folder ideally under 1 MB. |
| Validator | `shared/anticheat/validators/<camelId>.js` | Server replay. Registered by id in `validators/index.js`. |
| Parity suite | `shared/tests/<camelId>Parity.test.js` | Flies the real game.js, compares the world after every step. |
| Adversarial suite | `shared/tests/<camelId>Adversarial.test.js` | Forged/stacked/rewound inputs. |
| Render suite | `shared/tests/<camelId>Render.test.js` | Strict canvas, page contract. |
| Replay suite | `shared/tests/<camelId>Replay.test.js` | Admin replay adapter. |
| Harness | `shared/tests/lib/<camelId>RealGame.js` | Loads the real page + game.js in a `vm`. |
| Pilots | `shared/tests/lib/<camelId>Pilot*.js` | Human-model players. |
| Mutation battery | `shared/tests/lib/<camelId>Mutate.js` | Breaks constants; suites must fail. |
| Golden runs | `shared/tests/fixtures/<camelId>Golden.json` | Pinned runs; a change is a version bump. |
| Icon | `web/public/games/<id>.png` | 512 px, 256-colour PNG. |
| Registration | `shared/db/migrations/NNN_register_<id>.sql` | Draft lives in `migrations-draft/` here. |
| Shared client modules | `games/_shared/*` | READ ONLY here. |
| SDK | `sdk/kj-sdk/kj-sdk-v2.js` | READ ONLY here. |

Game id is kebab-case (`chakkar-chaku`); file/camel names derive from it
(`chakkarChaku`). The id also drives `game_url = /games/<id>/index.html` and
`icon = /games/<id>.png`, so renaming an id later is a database migration.

Files in kj-platform that a new game touches by **one line each** (done at
integration, not here): `shared/anticheat/validators/index.js` (register),
`shared/anticheat/humanness/features.js` (`GAME_INPUTS`),
`services/game-service/src/routes/adminReplay.js` (`PLAYBACK_GAMES`),
`shared/tests/sessionLifetime.test.js` (validator list), `shared/db/seeds/index.js`
(seed entry), plus the migration and the icon.

## 3. The build order (do it in this order, do not skip)

### Phase 0: the brief and the two gates
Fill in `docs/GAME_BRIEF_TEMPLATE.md`. Then pass both gates:

1. **Reference gate.** If the founder named a game, get links or full-size
   frames of its core loop BEFORE building. A named game beats described
   mechanics (the first Alien Hamla was a faithful Space Invaders and was
   rejected outright). Confirm the mechanic from full-size frames, not thumbnails.
2. **Art gate.** Name the objects the player will look at. If a player would
   recognise them as things (a ball, a goat, a ship, a person), ask who is
   drawing them. Code-drawn art is fine for abstract games (blocks, rings,
   lines, balls on tracks) and is not fine for characters or craft. Alien Hamla,
   Hoop Shot, Nishana and Gilli Danda were all parked on this. If the answer is
   "Claude draws it in code" and the genre is art-led, propose an abstract game.

### Phase 1: a playable core in the first hour
No validator, no suites, no seed. A single `index.html` + `game.js` the founder
can open on a phone and judge: is it fun, is the loop recoverable (a loop with
no recovery only moves where the wall is), is the screen quiet. **Fun is a
judgement, not a number to tune at the end.** Replay work verifies a game; it
cannot make one. Stop and show the founder before Phase 2.

Feedback rounds: ask whether the fix is a REMOVAL before adding anything. Four
rounds of additions made Alien Hamla noise. Replay the whole game yourself
after each change, not just the part you touched.

### Phase 2: rewrite the rules as a deterministic block
Move everything that decides the score into one block, written to the
determinism rules in section 4, with markers:

```js
// ==== MY GAME RULES BEGIN ====
// constants, hash/seed helpers, initSim, input functions, stepSim
// ==== MY GAME RULES END ====
```

Drawing, audio, particles, UI stay outside the block ("effects"). Effects may
READ the sim and must never WRITE it (parity asserts it).

### Phase 3: the page bridge
Copy `games/chakkar-chaku/index.html`. Keep: the script order in `<head>`
(no-touch-ui, mute, kj-tutorial-state, kj-press, kj-fit, dmath if you use it,
kj-replay), the SDK script, the bridge IIFE. Change: `GAME_ID`, the input hook
name (`__kjThrow` -> yours), the title, the menu. The bridge's contract:

- `KJ_GAME_LOADED` posted at load.
- Session minted **on load**; the PLAY button reads `PREPARING YOUR GAME`
  (disabled) until `window.__kjOnSessionReady` fires. **No timeout.** A run
  begun without a seed can never count.
- `window.__kjSeed` exists only after the session resolves. Build the world then, once.
- `__kjGameStart(tHint, want)` records the trace version in a `{kind:'start', v}` event.
- One hook per input kind emitting `kjEmit('input', { kind, n, step, ... })`.
  The ACTION only, never its result.
- `__kjSubmit(score)` exactly once, with the 75 s safety timer, forwarding
  `flagged` and `notCounted` in `KJ_V2_RESULT`.
- HOW TO PLAY is a static panel (or an interactive practice that is OUTSIDE
  the run and emits nothing), gated on `KJTut.shouldShow()`, once per rotation.
  The session is minted before it but the clock/run does not start until it closes.
- One run per session. Send the score only after the death has played out
  (about 1 to 2.5 s), with a timer backup so a hidden tab still submits.
- Standalone (not embedded, no `parent`): everything works but nothing is sent.
  QA switches (`?auto=1`, `?seed=`, `?perf=1`) must be dead inside the platform.

### Phase 4: the validator
`shared/anticheat/validators/<camelId>.js`: a header comment, the rules block
copied word for word, then the module interface (section 5). Written as a
transcription, not by importing game.js.

### Phase 5: the test harness and the parity suite (section 8)
### Phase 6: pilots, difficulty ladder, and `max_score_per_sec` (section 9)
### Phase 7: adversarial and render suites, goldens, cross-file check
### Phase 8: the mutation battery (section 11)
### Phase 9: registration migration draft, humanness input kinds, icon, assets
### Phase 10: package report, then integration (docs/INTEGRATION.md)

Write the package report as `packages/<id>.md` at the end of the build: what
the game is, trace format, bound derivation, ladder, test counts, mutation
result, bot gap, open items. The Chakkar Chaku and Snake Blocks sections in the
platform CLAUDE.md are the model; the fields are listed in section 14.

## 4. The determinism rules (what "reproducible" means)

Same seed + same inputs on the same step numbers must give the identical state
on every device, every frame rate, every browser, and on Node.

**Time.** Fixed timestep: whole 1/60 s (some 1/120 s) steps drained from an
accumulator, catch-up cap of 2 to 3 steps. `update(dt)` with the real frame
delta is forbidden. Inputs are recorded against the step index, never
`performance.now()`/`Date.now()`. Anything timed in gameplay counts in steps.
The first-frame sentinel is `null`, never a number (the page may have been open
for minutes). A hidden tab must not run the game in slow motion for the sim:
let the wall clock catch up by steps, but remember `requestAnimationFrame`
stops in hidden tabs, so a death/submit that depends on frames needs a timer
backup.

**Draw interpolation.** If the sim is 60 Hz, draw interpolated between the last
two steps and pace frame delivery (see Drifty Car `pace()`), or 120 Hz screens
judder. Drawing never changes a step.

**Space.** Gameplay lives in a fixed design space (e.g. 414x736). Contain-fit
and centre it; paint the background across the whole canvas; never stretch.
Never read `innerWidth`, `innerHeight`, `devicePixelRatio`, canvas size or CSS
on the gameplay path, and do not let the camera or any death line depend on
them. What a player can SEE ahead (warning distance) is part of fairness: clip
the playfield to the design rect on every screen. This bug has shipped four
times.

**Randomness.** Every random that can change a score comes from the session
seed and is **index-addressed**: element N is a pure function of (seed, N),
with a fixed number of draws on every index even where a branch ignores some.
Cosmetic randomness stays on `Math.random`, proven by replaying one course under
two different `Math.random` streams. Never `sort(() => Math.random() - .5)`.
`shared/anticheat/prng.js` and the `hash(seed, k, j)` helpers in the reference
rules blocks are the pattern to copy.

**Arithmetic.** Only `+ - * /`, `Math.sqrt`, `floor/round/ceil/min/max/abs`,
comparisons and integer bit ops (`imul`, `|0`, `>>>`). Positions in 1/16 or
1/256 units as integers. Never `Math.sin/cos/tan/atan/atan2/pow/hypot/exp/log`
or `**` on the gameplay path: engines differ by an ulp and it compounds
(a real run scored 52 in Chrome and 39 on the server). If you need trig use
`DMath` (`games/_shared/dmath.js`, byte-identical copy in
`shared/anticheat/dmath.js`) or an integer sine TABLE (most games use a table).
Keep -0 out of anything that is JSON-serialised (`| 0`).

**State is immutable where lookahead can touch it.** Replace lists in sim state
(`concat`), never `push`; a pilot that plans with shallow copies leaks its
lookahead into the real game otherwise.

**Provably passable and nobody parks.** The generator must guarantee a path
through everything it makes (size gaps from the speed they will be DRIVEN at, a
three-pass fixed point if speed depends on position), and a run that gives no
input must end quickly (idle death, a lane that forces movement). A parked run
that outlives the 60-minute session loses a finished score. Prove both in tests
over thousands of seeds.

**One physical press is one input.** Bind taps/keys through
`KJPress.bind(onPress, { keys, ignore, overlapMs })`. Several fingers landing
together must count once. Set a flag while a popup is up and pass it as `ignore`.
Games that need side-switching (hold left, press right) use their own holder
list instead (Drifty Car pattern).

## 5. The validator interface

```js
module.exports = {
  RULES_VERSION,          // current rules version
  init({ seed, maxDurationSecs, elapsedSecs }) -> state,
  processEvent(state, event) -> { accepted, newScore, reason? },
  finalize(state) -> { score, gameOver, debug },   // runs the world out to its end
  simulate(seed, inputs) -> finalScore,
  _limits,                // { MAX_SIM_FRAMES, ... } read by sessionLifetime.test.js
};
```

Behaviour you must implement:

- A trace without `{kind:'start', v:N}` is not a run: score 0 (`legacy_trace`).
  There is no plausibility fallback and no "v1" path.
- The version comes from the start marker. **A gameplay change is a version
  bump, never an edit in place**: `initSim(seed, version)` keeps old versions on
  their own rules so a run already in progress when a deploy lands is scored by
  the rules it was played under. Old goldens stay frozen; new goldens are added.
- Inputs apply before step `step + 1`. Frames may repeat but never go backwards
  (a rewind lets an attacker re-run a window and keep the best outcome).
- **Refusals never zero a run.** A malformed, rewound, out-of-order, flooded or
  rules-refused input changes nothing and is counted in `state.rejects`.
  Batched inputs (`{kind:'path', f, x[]}`) are applied whole or refused whole.
- `finalize` runs the world out to its natural end, bounded by
  `elapsedCap(state)` = 1.2 x real elapsed + 10 s and never past the session
  maximum (`MAX_SIM_FRAMES` = one hour of steps).
- Put a hard cap on inputs (`MAX_INPUTS`); the trace cap is 4 MB gzipped, derive
  your worst case (an hour of dense input) and check it fits. Dense inputs
  (drags, rotation) travel as **positional batches**, 120 samples max, never one
  event per step.
- `finalize().debug` records the raw material for bot detection (section 10):
  margins, hold lengths, gap CV, accuracy. Recorded, never gated.
- Everything in the rules block must also exist as the identical text in
  `game.js`. The parity suite extracts every constant and function from BOTH
  files and requires a match.

## 6. The session, the seed and the trace (server side, for context)

You do not build these; you must know them because your game lives inside them.

- **Seed.** `sha256(gameId : PKT date : attempt)`. Every player's Nth run of the
  day is the same course (the fair arrangement for a board). It contains no
  secret, so a determined attacker can compute every future course offline.
  Consequence: a course that is a pure function of the seed can be solved by a
  program. Replay cannot stop that; section 10 is what bounds it.
- **Session.** `POST /session/start` (sealed call) creates a `game_sessions`
  row and a Redis hash `ac2:sess:{id}` holding the seed, the HMAC secret, the
  validator state and the clock anchors. It is gated by `requireNotBanned` and
  `requireSubscriptionOrFreePlay` (or `requireLabOrPass` for red-team lab runs).
  A session lives 60 minutes (`SESSION_LIFETIME_SECS` 3600). A submit after that
  is refused, so a run longer than the session is a destroyed run: every replay
  ceiling is pinned to an hour and `sessionLifetime.test.js` checks them all.
- **Envelope.** Every event is signed `HMAC(sessionId|seq|type|ts|payload)`.
  That proves "a real session", never "a human". `ts` is the device clock, which
  is attacker-controlled and often wrong, so it is anchored per session and
  never judged against server time.
- **Events and the trace.** `kjEmit` appends to a local trace; there are no
  per-tap network calls. A 30 s heartbeat is presence only. At game over the
  whole gzipped JSONL trace uploads once with `kjSubmitV2` (retried 3 x 20 s,
  4xx terminal). A duplicated submit is answered from the settled row.
- **Submit.** The server gunzips the trace and replays it through a FRESH
  validator with the session seed. That result is the authoritative score.
  Then, in order: the submit-time duration pin, `require_claimed_match`
  (`|claimed - replayed| <= max(2, 5%)`), the `max_score_per_sec` backstop
  (a flagged score is ZEROED, so it errs wide), the leaderboard write, and the
  humanness fingerprint (one insert; the verdict is a queued job).
- **Trace cap 4 MB gzipped** (derived: 600 s x 130 events/s x 40 B). The old
  256 KB cap refused the best players of the day. Never size a cap from an
  autopilot corpus.
- **Only FEATURED games pay.** Active and featured are different sets. Going
  live is: `is_active`, feature it in Admin, flip `require_claimed_match`.
- **Rank shown = rank paid.** Bots hold positions, are never paid; one ranking
  rule everywhere. Not your concern in a game, but never invent a second one.

## 7. Trace shapes (pick the one that fits your input)

All begin with `{kind:'start', v:N, tHint}`. Then one of:

| Input style | Event | Reference |
|---|---|---|
| Tap with an effect | `{kind:'throw', n, step}` (index and step it lands before) | Chakkar Chaku, Raftaar, Dots Reflexes |
| Hold and release | `{kind:'hold', n, dir, pressStep, releaseStep}`; a run ending mid-hold closes the pair at the death step | Drifty Car, Hex Rush, Chor Police, Jungle Baandar |
| Drag / continuous position | `{kind:'path', f, x[] (, y[])}` positional batches: `x[i]` is the value DURING step `f+1+i`, <= 120 per batch, opens when the target changes, closes after 30 still steps | Snake Blocks, Color Dunk, Cannon Rush |
| Finger down/up markers | `{kind:'touch'|'lift', step}` beside path batches | Snake Blocks, Bo Kaata |
| Discrete moves | `{kind:'move', n, dir, step}` | 2048 Rush, Block Blast |
| Board move | `{kind:'swap'|'place', n, ..., step}` | Match Three (removed), Block Blast |

Rules for every shape: indices strictly increase, steps never go backwards,
several inputs on one step are legal only if the rules say so and stacking buys
nothing, the client emits only inputs the rules ACCEPTED, and the emit carries
no outcome. Stamp the moment of the action, not when an animation pays out.

## 8. The tests (what must exist and what each proves)

### 8.1 The harness (`<camelId>RealGame.js`)
Loads the REAL `index.html` bridge and the REAL `game.js` into a Node `vm` with:
a fake clock (`setTimeout`/`setInterval` run on it, never stubbed to no-ops),
a fake `requestAnimationFrame`, a canvas stub (drawing OFF by default; the
strict canvas is for the render suite), `performance.now`, `window.parent`
capturing `postMessage`, and the SDK replaced by a recorder so the trace can be
read out. Copy `chakkarChakuRealGame.js` and adapt. It exposes the game's sim
only to a test hook (`window.__xxxHarness`), never to the shipped page.

Pilots (`*Pilot*.js` or inside the harness) plan using the REAL game's own
rules, never the validator under test ("never let the thing under test choose the
test's inputs"). They decide once per STEP, never per frame, and are bounded by
steps. Make several styles: a flawless planner, good/average/novice human models
(perception lag, timing spread, slips, the wrong-thumb mistake), a spammer, a
hugger, a multi-finger player, and one that never touches the screen.

### 8.2 Parity (`<camelId>Parity.test.js`): the main suite
- The rules block text is IDENTICAL in game.js and the validator.
- Every constant (by value) and every rules function is extracted from BOTH files
  by regex and compared. This catches "someone edited one file".
- A **pin table**: every rules constant asserted against a literal, because a
  change made in both files passes the cross-file check. `<X>_SKIP_PIN=1`
  switches it off so the mutation battery can measure behaviour alone.
- 20+ flown runs, **the whole world compared after every step** (every entity,
  position, velocity, timer, the score), bit-exact, against the validator's sim.
  Score-only parity is not parity: contacts reset state and hide wrong constants.
- Coverage assertions: the corpus must actually reach what each pilot style
  exists for (edge bounces, caps, cross-wave combos, crashes of every kind). If a
  counter drops to zero the suite fails, because that constant is untested again.
- The same schedule at 30, 60, 120 and 144 Hz, with uneven frames (32/4 ms),
  five viewports (320x568 to 1440x780), DPR 1 and 2, a shifted clock, and two
  different `Math.random` streams: all give the identical run.
- A wall-clock test: one second of frames is 58 to 62 steps at every refresh
  rate (a frame-indexed test cannot see a per-frame client).
- Goldens (section 8.4), passability over thousands of seeds, the parked bound.
- No engine transcendental on the physics path of EITHER file (read the bodies).
- Compare a run only when it really died; a cut-short run vs a `finalize` that
  runs the world out compares two different runs.

### 8.3 Adversarial (`<camelId>Adversarial.test.js`)
Forged claims, a start marker missing or wrong, malformed batches (refused
whole), rewound/out-of-order/duplicated inputs, stacked inputs on one step, an
input flood past `MAX_INPUTS`, the elapsed cap (an immortal sim must still stop
at exactly `ceil((elapsed * 1.2 + 10) * 60)`), values at the exact sub-unit edge
of every collision (hand-placed, because no corpus lands on them), and that the
humanness extractor reads the trace (`features.inputs` equals the event count).
Assert the PROPERTY, never a rejection count: a test that asserts a count becomes
the guardian of the bug.

### 8.4 Goldens (`fixtures/<camelId>Golden.json`)
Recorded runs with a digest of the state after every step (or move). A golden
failure means the physics changed, which means a version bump, never a fixture
refresh. One file per rules version; old versions stay frozen.

### 8.5 Render (`<camelId>Render.test.js`)
Strict canvas (a context whose methods throw on a wrong call, and returns
non-numbers for reads so `g.lineWidth` read-backs are caught), at 3 viewports:
the page contract (script order, no `ad`/`banner`/`popup` class names, no third
party hosts), the session gate (PLAY disabled until the seed exists), one run per
session, hidden-tab submit, standalone vs embedded, admin replay, no gradient
created per frame, drawing never writes the sim.

### 8.6 Replay (`<camelId>Replay.test.js`)
The `kj-replay.js` adapter (`?replay=1`) feeds a stored trace back through the
real game for the admin viewer and reaches the same score and step. Needed
before the game can be added to `PLAYBACK_GAMES`.

### 8.7 Cross-engine
A fixed probe (rules over a fixed input list) hashes identically in headless
Chrome and Node. Do this once per game; it is the cheapest way to prove a replay
is portable and needs no dmath if the rules are integer.

## 9. Pilots, the difficulty ladder and the score bound

**Ladder.** Fly the REAL game.js with human-model pilots over 12 to 40 seeds and
report the median run length and score for: never touches the screen, novice,
average, good, flawless. You want skill to decide the run: good/average of about
1.5x to 3.5x. A ladder where everyone dies at the same wall is flat, not hard
(measure the spread, not just the median). A gentle opening with a steep ramp
reads as fair; a hard opening collapses the spread. An endless game needs a ramp
with no top. The pilot model under-rates humans, who learn patterns; the founder
plays it and judges.

**`max_score_per_sec`** (games row, the universal backstop): 3x the best 60 s
window of a FLAWLESS pilot over many seeds and 10-minute runs. Window, not a
single event. It is a backstop: tight bounds belong in the validator. It errs
wide because a flagged score is zeroed and the best players find a tight bound
first. If a rules change makes points accrue faster, re-derive it and apply the
raised bound **before** the client ships.

**Bot gap, honestly.** If the course is a pure function of the seed, a program
that reads the seed plays it perfectly forever (the flawless pilot proves it).
State the multiple against a good human in the package report. That residual is
the humanness layer's job; keep the game in record mode and out of paid rotation
until there is real data.

## 10. The anti-cheat and anti-bot layers (so you record the right things)

1. **Server replay** (your validator): kills every forged-number attack.
2. **Claimed vs replayed** (`require_claimed_match`): catches a client that
   plays different rules than the server.
3. **`max_score_per_sec`**, the submit duration pin, the 60-minute session, the
   input cap and `elapsedCap`: bounds on work and rate.
4. **Humanness fingerprint** (`shared/anticheat/humanness/features.js`): ~30
   score-independent numbers from the trace (input rhythm cv, fastest gap,
   endurance, hold lengths, steering force, accuracy) compared with the game's
   honest envelope and the player's own baseline. Modes per game
   (`humanness.<id>.mode`): off, record, hold, auto. New games start in
   **record**. For YOUR game you must (a) add its input kinds to `GAME_INPUTS`
   (`{ kinds:['throw'], time:'step' }`, or `{ path:true }` for path games) and
   (b) check that a real fingerprint's `features.inputs` equals the event count.
   Four games once ran with zero inputs fingerprinted and nobody noticed.
5. **Provenance**: the SDK records pointer types, `isTrusted`, press hold
   lengths and device claims. A press hold under 15 ms or a synthetic share over
   10% is decisive; a phone claim contradicted by the browser is decisive.
   Your game must not break this: bind input through `KJPress`/real pointer
   events so honest play looks honest.
6. **No single measure settles a verdict.** A "past every honest run" signal
   alone cannot remove a score (an honest 611 was once removed for run length).
7. **Red-team lab** (`/lab`): the full pipeline with nothing counting, so testers
   can attack a new game. Works for inactive games. The tester is told nothing
   about the verdict.
8. **Phone-only play, sealed calls, SDK obfuscation at deploy**: platform-side.
   Never expose a debug oracle on `window` (no `window.__game` state in the
   shipped page; harness hooks only when `__xxxHarness` is defined).

Never judge a player by a value their own device controls (clock, timezone,
locale, user agent, screen size). Before adding any bound that can DELETE a
score, ask which population it selects for: a cap on how long you may play is a
cap on how good you may be.

## 11. The mutation battery

`shared/tests/lib/<camelId>Mutate.js` takes a list of mutations
`{id, file, find, replace}` (constants +/- 1, a guard removed, an operator
flipped, an order swapped, a cap widened), applies each to the source, runs the
suites, and requires every LIVE mutation to FAIL a suite. Result format:
`N live caught, M inert (with reasons), 0 survivors`.

Rules that cost real time to learn:
- **Run only from a scratch copy of the tree, one copy per shard, never over the
  working tree.** It rewrites source; a kill mid-run leaves a mutated constant.
  An unknown flag must exit 2, never mean "run everything". Handle SIGINT and
  SIGTERM by restoring files, guard `main()` with `require.main`.
- Run jest `--runInBand`, six shards at most. A per-suite timeout counts a hang
  as caught (a mutation that freezes the step counter spins `advanceTo` forever).
- The mutation must match exactly once in every file it touches. The rules block
  is top-level in the validator and inside an IIFE in the game, so a find string
  written for one file silently SKIPS in the other; try several indents and
  assert every mutation matched.
- Apply each mutation to BOTH files when it targets the shared block, otherwise
  the cross-file check is what catches it and tells you nothing about behaviour.
  Run once with the pin table off (`--nopin`) to measure behaviour alone.
- Survivors are almost always holes in the TESTS, not the game: edge-gated
  constants (add a hand-placed boundary test), score-gated caps (pin by value),
  guards implied by other code (count executions in a corpus), transport caps
  (an immortal sim, an over-length trace). Fix the test, re-run.
- A genuinely inert mutation stays in the list, labelled inert WITH a measurement
  (not an argument) and a LARGE variant that must be caught. Deleting it hides
  the analysis from the next reader.
- A first pass leaves 10 to 25 survivors; that is normal. Zero is the bar.

## 12. Versions, ordering and deploy (context for integration)

- Server first, then client. Amplify (~2 min) and ECS (~5 to 8 min) deploy in
  parallel, so one push can put a new-protocol client in front of an old
  validator. For an INACTIVE new game one push is fine (no production runs).
  For any rules bump on a live game: validator + migration (bound) first, wait
  for the single ECS task, then the client.
- Never hand-bump `?v=` busters; the deploy stamps content hashes. Page, game.js
  and SDK are one build; no client-side downgrades.
- Migrations are manual (`scripts/aws-migrate.sh dev`); CI does not run them.
  Apply a bound raise BEFORE the client that needs it.
- Do not deploy within 10 minutes of 00:00 PKT.
- Verify the LIVE file (grep a string only the new code has), not the pipeline.

## 13. Pitfall list (each one shipped once)

- Viewport reaching gameplay (camera, death line, warning distance, `ball.r`).
- A score-only parity suite; a corpus that never reaches a cap.
- Two guards masking each other (neither can be mutation-tested; delete one).
- A test that reads the constant it checks.
- Per-frame `update(dt)`; `performance.now()` in a rule; a CSS rule holding the
  geometry together (measure the SHIPPED artefact, not the source).
- `Math.sin/pow/hypot` anywhere on the rules path. `-0` in JSON.
- Pushing to a sim list; interpolating a field that is not a position (a TYPE).
- A numeric first-frame sentinel; a stubbed `setTimeout`; `test.each` rows with
  fewer values than the callback parameters (jest waits forever).
- Starting a run before the seed exists; a timeout around session start.
- Guided tutorial inside the live session; a popup's PLAY press becoming a game input.
- `getContext('2d', { desynchronized: true })` (black bands on Mali GPUs). Never.
- `touch-action` is not inherited (set on canvas too). Test at 375x812.
- Class/id names `ad`, `banner`, `promo`, `sponsor`, `popup`.
- Fonts or libraries from a third-party host; a service worker; a web manifest;
  ES module loading in a game that obfuscation must parse (ES modules are
  supported now, but plain scripts are safer).
- Audio files in the wrong format (`file -b` them); a looping MP3 without
  `loopStart/loopEnd`; sounds that need a gesture (constructing a context needs
  none, resuming does: unlock on pointerdown, touchend and click).
- Music that keeps playing under the Result screen; a sound played twice for one
  event; the score sent before the death animation.
- Ending the HUD delta and the emit delta with two expressions.
- A `?perf=1` or `?auto=1` switch that works inside the platform.
- Dev pages (`preview.html`, `showcase.*`), reference screenshots of other
  games, `node_modules`, and untracked art sources inside `games/<id>`: never
  ship them. A reference game's name or assets are never used.
- Hidden browser panes draw ~2 fps; a fixed-step game with a catch-up cap runs
  ~10x slow there. Do not conclude "the game is not advancing" from one.
- `--disable-gpu` measures a browser nobody has. Measure draw cost with GPU
  rasterization on, 6x CPU throttle, DPR 2.
- Adding a bound that deletes scores without asking which players it selects.
- Never use an em dash or an en dash in any text (the founder's standing rule).
  Use commas, colons, parentheses or a new sentence.

## 14. Definition of done (the package report must answer all of these)

1. One-paragraph game description and the founder's feel verdict (quote it).
2. Trace format, current rules version, and the version history.
3. The rules block is identical in both files; the pin table lists every constant.
4. Passable proof (pairs/seeds, tightest slack) and parked bound (worst steps).
5. Parity: runs, steps and fields compared; styles; Hz and viewport coverage.
6. Adversarial and render suite counts; golden run count and versions.
7. Mutation result: live caught, inert (with reasons), survivors (must be 0).
8. Ladder table (seeds, median run and score per pilot) and `max_score_per_sec`
   with its derivation (flawless 60 s window peak x 3).
9. Bot gap statement (flawless score vs good human, what debug fields record).
10. Draw cost (GPU on, 6x throttle, DPR 2) at 375x812, 320x568, 1440x780, and the
    folder size. Say plainly that a real phone was not measured.
11. Draft migration (id, name, description, sort_order, bound, durations,
    anticheat + humanness keys), icon, and the five one-line hunks for integration.
12. Open items and anything the founder must decide.
