# Integrating a finished package into kj-platform

Done in a session whose working directory is the `kj-platform` checkout, after
the founder has played the package. The package is the set of files listed in
`CLAUDE.md` under Layout, on branch `game/<id>`.

## 0. Before anything
- `git status` in kj-platform. Other sessions share that tree. Never `git commit --amend`.
  Commit by explicit path (`git add` new files first, then `git commit -- <paths>`).
- Pick the migration number: `ls shared/db/migrations | tail -3`. Another session
  may have taken the one in the draft; re-check right before committing.
- Confirm no id collision: `grep -n "'<id>'" shared/anticheat/validators/index.js shared/db/seeds/index.js`.

## 1. Copy the package (same relative paths)
```
games/<id>/                         (exclude dev pages, showcase files, reference screenshots, node_modules)
shared/anticheat/validators/<camel>.js
shared/tests/<camel>*.test.js
shared/tests/lib/<camel>*.js
shared/tests/fixtures/<camel>Golden*.json
web/public/games/<id>.png
migrations-draft/NNN_register_<id>.sql  ->  shared/db/migrations/NNN_register_<id>.sql
```
Check what the asset files really are (`file -b`), that `games/<id>` has no
`node_modules`, no service worker, no manifest, and is about 1 MB or less.

## 2. The five one-line hunks (edit by hand, never overwrite the file)
1. `shared/anticheat/validators/index.js`: `'<id>': require('./<camel>'),`
2. `shared/anticheat/humanness/features.js`, `GAME_INPUTS`: `'<id>': { kinds: ['<kind>'], time: 'step' },`
   (path games: `{ path: true }`; look at how a same-shaped game is declared).
3. `services/game-service/src/routes/adminReplay.js`, `PLAYBACK_GAMES`: add `'<id>'`
   (only if the replay suite passes).
4. `shared/tests/sessionLifetime.test.js`: add the validator to the list.
5. `shared/db/seeds/index.js`: a seed entry matching the migration (same
   `max_score_per_sec`; the seed file and migrations are two records of one number).

Also add the id to the Game line-up table in CLAUDE.md.

## 3. Run the suites in kj-platform
```
cd /Users/muneebattakhan/Mindravel/Projects/kj-platform
npx jest --runInBand shared/tests/<camel> shared/tests/sessionLifetime
```
Parity can take minutes. Do not rerun the mutation battery here; it ran in the
workshop. If a suite differs here from there, the snapshot has drifted: stop and
find out why before touching anything.

## 4. Check on the real local platform (the /lab door)
- Apply the migration to the LOCAL database only; `docker compose restart game-service`
  (the `node --watch` watcher does not fire on macOS bind mounts).
- Write `redteam/lab-<id>.mjs` from a sibling (it is gitignored) and run: three
  honest runs must give claimed == replayed == stored with `lab = true`,
  `is_counted = false` and no leaderboard row; a forged 99,999 claim, a no-play
  claim, a flood and a rewind must all reduce to what their inputs earn.
- Decode a stored trace from `replay_traces.events_compressed` and replay it
  offline: same score and death step.
- Open the game in a browser at 375x812 and 1440x780; replay a stored run in
  the admin viewer if `PLAYBACK_GAMES` was updated.
- Check a real fingerprint: `features.inputs` equals the event count.

## 5. Commit and push
- Commit only the package paths plus your hunks. Message in the repo's style.
- Inactive new game, no production runs: backend and client in one push is fine.
- Apply the migration to RDS with `scripts/aws-migrate.sh dev` once the new image
  is up. (A column add must be applied BEFORE the push; a game registration need not be.)
- Grep the LIVE page for a string only the new code has. Do not trust CI status.
- Not within 10 minutes of 00:00 PKT.

## 6. After it is on /playtest
The game registers INACTIVE, `require_claimed_match` off, humanness in `record`.
The founder plays it from `/playtest` (SDK `?playtest=1`, nothing is sent).
Going live is his call, in this order: `is_active`, feature it in Admin, flip
`anticheat.<id>.require_claimed_match` once real devices show parity (compare
`replay_traces.summary` clientClaimedScore with validatorScore), and later
`humanness.<id>.mode` to `auto` once the game has a reference of honest runs
(backtest first: zero honest runs at hold). Do not feature a game whose bot gap
is large before that data exists.

## 7. Record it
Add a section to kj-platform's CLAUDE.md (model it on Chakkar Chaku's) and a
memory entry. Say plainly what was NOT done (real-phone draw cost, etc.).
