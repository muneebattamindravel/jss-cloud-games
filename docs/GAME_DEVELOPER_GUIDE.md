# Building a game for Jeeto Skill Se — what you must know

Our games compete for real cash. The server does not trust a score it is sent;
it **replays the player's inputs** through its own copy of the game's rules and
pays out on what that replay computes. Your game therefore has to be
reproducible, bit for bit, on a Node server from nothing but a seed and a
list of inputs. Everything below follows from that one fact. Games that do
not meet it are not integrated.

## 1. The rule that decides everything

Given the same **seed** and the same **inputs on the same step numbers**, your
game must reach the identical state on every device, browser and frame rate,
and on our server. Not "close": identical to the last bit. Design for this
from day one; it cannot be bolted on.

## 2. Time

- **Fixed timestep.** Physics runs in whole steps of 1/60 s (or 1/120 s),
  drained from an accumulator with a catch-up cap (usually 3 steps). Never
  `update(dt)` with the frame's real delta. A 144 Hz laptop and a stuttering
  phone must produce the same sequence of steps; only how much wall-clock
  each step took may differ.
- **Inputs are recorded against the step index**, never against
  `performance.now()` or `Date.now()`. The player's clock is theirs to change.
- Anything gameplay-relevant that is timed (a swing, an entry animation, an
  easing, a spawn) counts in steps. Cosmetics may use real time.
- Any camera, scroll or bound that can kill the player is gameplay and must
  move per step, not per frame.

## 3. Space

- Gameplay lives in a **fixed design space** (e.g. 420×760). Positions, sizes,
  speeds, hitboxes and death lines are constants in that space. The canvas is
  fitted and centred around it for drawing only.
- Never read `innerWidth`, `innerHeight`, `devicePixelRatio`, the canvas size
  or a CSS rule on the gameplay path. If a value would change when the window
  is resized, it is not allowed to touch physics.
- Test at phone size (375×812) as well as desktop.

## 4. Randomness

- **Every random that can affect a score comes from the session seed**
  (`window.__kjSeed`, provided by the platform), through the platform's
  seeded generator, and is **index-addressed** where possible: "planet N" is
  a pure function of (seed, N), never of how many draws happened before it.
- Draw the same number of randoms in the same order on every code path; a
  branch that skips a draw desynchronises the server silently.
- Cosmetic randomness (particles, trails, colours, audio) stays on
  `Math.random` and must never feed back into gameplay. We prove this by
  replaying one run under two different `Math.random` streams.
- `Array.sort(() => Math.random() - 0.5)` is not a shuffle. Use seeded
  Fisher–Yates.

## 5. Arithmetic

- On the gameplay path use only `+ - * /`, `Math.sqrt`, `Math.floor / round /
  ceil / min / max / abs`, comparisons and integer bit operations. These are
  exact and identical in every JavaScript engine.
- **Never** `Math.sin / cos / tan / atan / atan2 / pow / hypot / exp / log` or
  the `**` operator on the gameplay path. They differ by an ulp between
  Chrome, Safari, Firefox and Node, and one ulp compounds into a different
  score. Use `DMath` from `games/_shared/dmath.js` (sin, cos, atan2, hypot,
  cube), which produces identical bits everywhere. Cosmetics may use `Math`.
- Sum the same numbers in the same order on both sides; `a + b + c` and
  `a + (b + c)` are different doubles.

## 6. What you emit

- The trace carries the player's **actions**, not their results. Send the
  tap and the step it landed on, the move and the cell it went to; never
  "I cleared two rows" or "I scored 6". The server works that out.
- Stamp an action with the moment it was **taken**, not when its points land
  after an animation.
- One line computes a score change; the HUD and the emit both read that one
  value. Never write the delta twice.
- Emit at most what fits: a run is uploaded once at the end as a gzipped
  trace under 256 KB. Batch dense inputs (see Twist Fall's rotation batches).
- **One physical press is one input.** Bind taps and keys through
  `KJPress.bind(onPress, { keys, ignore })` from `games/_shared/kj-press.js`,
  never raw `pointerdown`/`keydown`. Several fingers landing together, or
  Space held while the mouse clicks, must count once. Players scored +4 a tap
  in Pulse this way.
- A press on a popup is not a game input. If your input listener covers the
  whole window, set a flag while HOW TO PLAY is open and pass it as `ignore`,
  or the popup's PLAY button starts the run before the player is ready.

## 7. The session

- Nothing gameplay starts until the platform has a session. Call
  `window.__kjBeginSession()` when the player dismisses HOW TO PLAY and
  **wait for it, with no timeout**. The SDK retries, and the platform shows
  the player a Retry/Exit panel if it cannot connect. A run started before
  its session exists can never count.
- Build the world **after** the seed arrives, and build it once. Do not read
  `__kjSeed` before the session promise resolves.
- Static HOW TO PLAY panels only. No guided tutorial that runs inside a live
  session, freezes physics, or hands out free points.
- Do not restart in place inside the platform; the Result screen owns
  "play again".
- Call `__kjSubmit(score)` exactly once at game over and let the bridge do the
  rest.

## 8. Cheating is assumed

- The seed, the session secret and your whole source are on the player's
  device. Nothing you hide is hidden. Security is the replay, not secrecy.
- A second input on the same step must change nothing. A repeated frame is
  tolerated; a frame going backwards is refused.
- Every bound the server enforces must exist in your game too; a mismatch is
  an honest player zeroed.

## 9. Platform hygiene

- Load `games/_shared/no-touch-ui.js` first in `<head>`, then
  `kj-tutorial-state.js`, then `kj-press.js`, then (if you use trig)
  `dmath.js`, then your game.
  Set `touch-action: none` on the canvas.
- Never name a class or id `ad`, `banner`, `promo`, `sponsor`, `popup`. Ad
  blockers hide them.
- Never load anything from a third-party host. Fonts and libraries ship with
  the game.
- Every asset is loaded through `index.html` references; do not hand-edit
  `?v=` cache busters, the deploy stamps them from file hashes.
- Check what an asset *is* (`file -b`), not what it is called; keep the game
  under ~1 MB.

## 10. What we will run before it goes live

- A parity suite that flies your real `game.js` in Node with several player
  styles and compares the **entire state after every step**, bit-exact,
  against the server's replay. A score-only comparison is not accepted.
- A cross-file check that every shared constant matches between `game.js`
  and the validator.
- A mutation battery: constants and guards are deliberately broken and the
  suite must fail each time.
- An adversarial suite: forged inputs, stacked inputs, replayed seeds,
  inflated claims, all scoring nothing.
- A real-browser run whose trace replays on the server to the same score.

Write your validator alongside your game, as a separate transcription of the
same rules, not by importing your game's code; a shared module proves nothing.
When in doubt, ask: "if the server ran this line with the same inputs, would
it get the same bits?" If the answer is not an immediate yes, it does not
belong on the gameplay path.

## 11. Lessons from the 13 to 15 Sep builds

Seven games were built or integrated in two days (Bubble Shooter, Stick Hero,
Bakri Dash, Match Three, Drifty Car, Finger Maze, and Gannay Wala from a
partner). These came up more than once.

**The page and the platform**
- Copy an existing game's `index.html` bridge (Stick Hero is the reference)
  instead of writing one. Mint the session on load and show PREPARING YOUR GAME
  until it is ready; never start a run before it.
- Send the score only after the death has played out. Sending it is what hands
  the screen to the platform's result, so the crying farmer, the falling stalk or
  the bleat has to finish first (Gannay Wala waits 2.5 s, on the frame clock and a
  timer, whichever fires first).
- Stop the run's music at death and let nothing play past the moment the score is
  sent. One event plays its sound once.
- If the game has no keyboard controls, swallow key events so a key cannot press
  a focused button.
- Never stretch the canvas. Fill the game box, contain-fit the design, and extend
  the background around it; on wide screens keep play in a phone-width column.

**The files you ship**
- No service worker, no web manifest, no ES module loading, no fonts from a
  third-party host. Subset a font to the glyphs you use (an Urdu title needs a
  few dozen, not the whole script).
- Look for waste before anything else: Gannay Wala arrived at 21 MB with a base64
  sound bank that repeated its MP3s byte for byte, MP3s carrying embedded cover
  art, and 1254 px sprites drawn at 224 px. It shipped at 640 KB.
- The platform icon is 512 px.

**The rules and the tests**
- Keep every rule in one block carried word for word in the validator. A change
  made in both files still passes parity, so pin the rules with golden runs.
- A test harness must run timers on its fake clock. A stubbed `setTimeout` hid a
  delayed submit from every test.
- A mutation must never freeze the step counter: the replay's advance loop spins
  forever and the battery hangs instead of failing.

**The web app around your game**
- Every web and admin build now fails on a name used but never defined
  (`scripts/check-undefined-names.js`). The rule exists because a handler that
  only runs at midnight crashed Home at a rotation.
