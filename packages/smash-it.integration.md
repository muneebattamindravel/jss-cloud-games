# Integration prompt for kj-platform: Smash It

Paste the block below into a Claude Code session whose working directory is the
`kj-platform` checkout.

---

Integrate the game package **Smash It** (`smash-it`) from the workshop repo
`muneebattamindravel/jss-cloud-games`, branch `main`, following
`docs/INTEGRATION.md` from that repo step by step. Read `packages/smash-it.md`
there first: it is the package report (trace format, physics engine, bound,
ladder, battery result, bot gap, open items).

The founder asked for it to be made ready for integration, supplied the icon,
confirmed the 30 s idle end, and asked for it to be merged and integrated.

This game is different from every earlier one in two ways. Read these before
copying anything:

- **It uses a physics engine.** The validator requires the npm package
  `@dimforge/rapier3d-deterministic-compat` at exactly `0.19.0` (the
  deterministic, cross-platform bit-exact build; NOT `@dimforge/rapier3d`).
  Add it, pinned exactly, to every `package.json` whose code requires the
  validators (the root one used by jest, and the game-service one if it has
  its own), run `npm install`, and make sure the service's Docker image
  installs it. The page carries its own copy (`games/smash-it/js/vendor/rapier.js`
  embeds the npm `rapier.cjs` byte for byte; the render suite checks this, so
  the versions must stay identical).
- **The validator starts asynchronously.** Rapier compiles WebAssembly, so
  `shared/anticheat/validators/smashIt.js` exports `ready` (a promise) and
  `init()` throws `engine_not_ready` until it resolves. Find where the service
  loads validators and calls `init` (the replay/scoring path and the admin
  replay route) and make sure `await require('./smashIt').ready` (or a
  generic `await validator.ready` when a validator has one) happens before the
  first Smash It `init`, ideally once at service start-up. Do not make other
  validators async. `finalize()` frees the run's physics world; any code path
  that abandons a validator state without `finalize` leaks WebAssembly memory,
  so check there is none.

1. Before anything: `git status`; never amend; commit by explicit path. Pick the
   migration number with `ls shared/db/migrations | tail -3` and rename the
   draft. Check `'smash-it'` is not in `shared/anticheat/validators/index.js`
   or `shared/db/seeds/index.js`.
2. Copy, same relative paths:
   - `games/smash-it/` (the whole folder: `index.html`; `js/rules.js`,
     `js/game.js`, `js/audio.js`; `js/vendor/three.min.js`, `js/vendor/rapier.js`
     and their two `LICENSE` files; `img/backdrop-meadow.jpg`,
     `img/backdrop-beach.jpg`; `audio/cannon.mp3` and `audio/glass-{b1,c07,c13,m1,m2}.mp3`;
     `fonts/lilita-one.woff2` and its `LICENSE`. 18 files, nothing else)
   - `shared/anticheat/validators/smashIt.js`
   - `shared/tests/smashIt{Parity,Adversarial,Render,Replay}.test.js`
   - `shared/tests/lib/smashIt{RealGame,World,GoldenGen,Mutate,Ladder}.js`
   - `shared/tests/fixtures/smashItGolden.json`
   - `web/public/games/smash-it.png` (512 px, the founder's icon)
   - `migrations-draft/NNN_register_smash_it.sql` to `shared/db/migrations/<next>_register_smash_it.sql`
   Do not copy `tools/smash-it/` or `packages/` (workshop only). Check
   `file -b` on every asset (the mp3s are MPEG audio, the jpgs JPEG, the png
   PNG, the font woff2). The folder is about 3.9 MB, over the 1 MB guideline:
   most of it is the physics engine (about 2 MB), which the founder accepted
   with the game. Do not try to shrink it by swapping Rapier builds: parity
   depends on the exact build.
3. The five one-line hunks, by hand:
   1. `shared/anticheat/validators/index.js`: `'smash-it': require('./smashIt'),`
      (plus the `ready` await described above)
   2. `shared/anticheat/humanness/features.js`, `GAME_INPUTS`:
      `'smash-it': { kinds: ['shot'], time: 'step' },`
      (one `{ kind: 'shot', n, x, y, step }` per accepted tap)
   3. `services/game-service/src/routes/adminReplay.js`, `PLAYBACK_GAMES`: `'smash-it'`
   4. `shared/tests/sessionLifetime.test.js`: add the validator to the list
      (`_limits.MAX_SIM_STEPS` 216000, `FPS` 60, `MAX_INPUTS` 8000). If that
      test calls `init`, it must `await` the validator's `ready` first.
   5. `shared/db/seeds/index.js`: a seed entry matching the migration
      (`max_score_per_sec: 203`, sort_order 63 or the next free slot,
      durations 1 to 3600, inactive)
   Also add Smash It to the Game line-up table in CLAUDE.md.
4. Run `npx jest --runInBand shared/tests/smashIt shared/tests/sessionLifetime`.
   In the workshop: 130 Smash It tests pass in about 4 minutes. Do not rerun
   the mutation battery (it ran in the workshop: 96 caught, 0 survivors). If a
   suite differs here, the snapshot of `games/_shared`, the SDK or the Rapier
   version has drifted: stop and find out why before touching anything. The
   adversarial suite adds the `GAME_INPUTS` entry itself when it is missing;
   with hunk 2 in place that is harmless.
5. Lab check (local only): apply the migration to the LOCAL database,
   `docker compose restart game-service` (after `npm install` in the image),
   write `redteam/lab-smash-it.mjs` from a sibling script and confirm: three
   honest runs give claimed == replayed == stored with `lab = true` and no
   leaderboard row; a forged 99,999 claim, a no-play claim, a shot flood and a
   rewind all reduce to what their inputs earn. Decode one stored trace and
   replay it offline (same score and end step). Open the game at 375x812 and
   1440x780 (check the 3D scene, the backdrops and the sounds load from the
   platform's paths); replay a stored run in the admin viewer. A real
   fingerprint must have `features.inputs` equal to the shot count. Watch the
   game-service memory over a few replays (WebAssembly worlds are freed in
   `finalize`).
6. Commit only the package paths, the dependency change and the hunks; one
   push is fine (inactive new game). Apply the migration to RDS with
   `scripts/aws-migrate.sh dev` once the image is up. Grep the LIVE page for
   `SMASH IT RULES BEGIN`. Not within 10 minutes of 00:00 PKT.
7. It registers INACTIVE, `anticheat.smash-it.require_claimed_match` false,
   `humanness.smash-it.mode` record. Going live is the founder's call:
   `is_active`, feature it, then flip `require_claimed_match` once real devices
   show parity. Bot gap (report section 9): a patient perfect-aim planner
   scores about 2x to 4.5x the human models, and a bot that simulates shots
   with the public rules could do more; keep it out of paid rotation until
   humanness has real data.
8. Open items to carry into kj-platform's CLAUDE.md section (model it on
   Chakkar Chaku's): the licences of the two library glass clips and the
   cannon clip must be confirmed before launch; the 40 minute run cap is
   unconfirmed by the founder; no real-phone draw cost was measured; first
   load of a 3.9 MB game on a slow connection was not measured.
