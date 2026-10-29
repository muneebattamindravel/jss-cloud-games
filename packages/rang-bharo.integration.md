# Integration prompt for kj-platform: Rang Bharo

Paste the block below into a Claude Code session whose working directory is the
`kj-platform` checkout.

---

Integrate the game package **Rang Bharo** (`rang-bharo`) from the workshop repo
`muneebattamindravel/jss-cloud-games`, branch `game/rang-bharo`, following
`docs/INTEGRATION.md` from that repo step by step. Read
`packages/rang-bharo.md` there first: it is the package report (trace format,
bound, ladder, battery result, bot gap, open items).

The founder has played it and said: "okay i think this game is perfect."

1. Before anything: `git status`; never amend; commit by explicit path. Pick the
   migration number with `ls shared/db/migrations | tail -3` (the draft says
   264; renumber if taken, and rename the file). Check `'rang-bharo'` is not in
   `shared/anticheat/validators/index.js` or `shared/db/seeds/index.js`.
2. Copy, same relative paths:
   - `games/rang-bharo/` (index.html, js/game.js, fonts/titan-one-400-latin.woff2; nothing else)
   - `shared/anticheat/validators/rangBharo.js`
   - `shared/tests/rangBharo{Parity,Adversarial,Render,Replay}.test.js`
   - `shared/tests/lib/rangBharo{RealGame,World,Mutate,GoldenGen}.js`
   - `shared/tests/fixtures/rangBharoGolden.json`, `shared/tests/fixtures/rangBharoGoldenMazes.json`
   - `web/public/games/rang-bharo.png` (512 px, the founder's artwork)
   - `migrations-draft/264_register_rang_bharo.sql` to `shared/db/migrations/NNN_register_rang_bharo.sql`
   Do not copy the workshop's `scripts/rb-*.js` (dev tools). Check `file -b`
   on the font and icon; the game folder is about 108 KB.
3. The five one-line hunks, by hand:
   1. `shared/anticheat/validators/index.js`: `'rang-bharo': require('./rangBharo'),`
   2. `shared/anticheat/humanness/features.js`, `GAME_INPUTS`:
      `'rang-bharo': { kinds: ['move'], time: 'step' },`
      (one `{ kind: 'move', n, dir, step }` per accepted swipe or key)
   3. `services/game-service/src/routes/adminReplay.js`, `PLAYBACK_GAMES`: `'rang-bharo'`
   4. `shared/tests/sessionLifetime.test.js`: add the validator to the list
   5. `shared/db/seeds/index.js`: a seed entry matching the migration
      (`max_score_per_sec: 340`, sort_order 62, durations 1 to 3600, inactive)
   Also add Rang Bharo to the Game line-up table in CLAUDE.md.
4. Run `npx jest --runInBand shared/tests/rangBharo shared/tests/sessionLifetime`.
   In the workshop: 144 tests pass in about 150 s. Do not rerun the mutation
   battery (it ran in the workshop: zero survivors). If a suite differs here,
   the snapshot of `games/_shared` or the SDK has drifted: stop and find out
   why before touching anything. The adversarial suite adds and then removes
   the `GAME_INPUTS` entry itself; with hunk 2 in place that is harmless.
5. Lab check (local only): apply the migration to the LOCAL database,
   `docker compose restart game-service`, write `redteam/lab-rang-bharo.mjs`
   from a sibling script and confirm: three honest runs give claimed ==
   replayed == stored with `lab = true` and no leaderboard row; a forged
   99,999 claim, a no-play claim, a move flood and a rewind all reduce to what
   their inputs earn. Decode one stored trace and replay it offline (same
   score). Open the game at 375x812 and 1440x780; play the practice (it shows
   before the first run once per rotation and must emit nothing); replay a
   stored run in the admin viewer. A real fingerprint must have
   `features.inputs` equal to the move count.
6. Commit only the package paths plus the hunks; one push is fine (inactive new
   game). Apply the migration to RDS with `scripts/aws-migrate.sh dev` once the
   image is up. Grep the LIVE page for `RANG BHARO RULES BEGIN`. Not within 10
   minutes of 00:00 PKT.
7. It registers INACTIVE, `anticheat.rang-bharo.require_claimed_match` false,
   `humanness.rang-bharo.mode` record. Going live is the founder's call:
   `is_active`, feature it, then flip `require_claimed_match` once real devices
   show parity. The bot gap is 2.0 x a good human (report section 9): keep it
   out of paid rotation until humanness has real data.
8. Record it: a Rang Bharo section in kj-platform's CLAUDE.md modelled on
   Chakkar Chaku's, and say plainly what was not done (no real-phone draw cost).
