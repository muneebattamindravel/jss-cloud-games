# CLAUDE.md for jss-games

This repo builds games for **Jeeto Skill Se (JSS)**, a Pakistan-first skill-game
platform where the top players of each daily board win real cash. The platform
lives in a different repo (`kj-platform`). This repo is the workshop where
games are built and verified, then handed back as packages.

Read `docs/HANDBOOK.md` fully before writing game code. It is the process.

## Standing rules

1. **Never use an em dash or an en dash** in any text: code comments, docs,
   commit messages, UI copy. Use a comma, colon, parentheses or a new sentence.
2. **Do not edit the platform snapshot**: `games/_shared/`, `sdk/`,
   `shared/anticheat/{dmath,prng,platform,sign,reasons}.js`, `shared/anticheat/humanness/`,
   `reference/`, `docs/GAME_DEVELOPER_GUIDE.md`. They are copies of the live
   platform. If one seems wrong, write it down in the package report; do not fix it here.
3. **No secrets, no AWS, no deploys, no database, no network calls to JSS.**
   None of that exists here and none of it is yours to recreate.
4. **Fun first.** Phase 1 of the handbook (a playable core, no validator, no
   suites) comes first and the founder judges it. Do not build the replay stack
   on a game nobody has called fun. When feedback names a problem, first ask
   whether the fix is a removal.
5. **Ask for references before building** when the founder names a known game,
   and **pass the art gate**: code-drawn art only for abstract games.
6. **Never use another game's name, logo, art or audio.** Everything shipped is
   original and in-house. Third-party assets need the founder's written say-so.
7. **Determinism is non-negotiable** (handbook section 4): fixed step, fixed
   design space, seed-addressed course, integer rules, no engine trig, one press
   one input, no timeout around session start.
8. **Test before claiming.** Say what was run and what it printed. Do not write
   "done" on a game whose mutation battery has survivors or whose parity suite
   compares only scores.
9. Mutation batteries run **only from a scratch copy** of the tree, never over
   the working tree. Unknown flags exit 2.
10. Jest: `npx jest --runInBand <pattern>`. If npm complains about its cache
    permissions use `--cache /tmp/npmcache`.

## Layout

The tree mirrors `kj-platform`, so a package copies over unchanged:

```
games/<id>/                         the game (index.html, js/, fonts/, img/, audio/)
shared/anticheat/validators/<camel>.js
shared/tests/<camel>{Parity,Adversarial,Render,Replay}.test.js
shared/tests/lib/<camel>{RealGame,Pilot,Mutate,GoldenGen}.js
shared/tests/fixtures/<camel>Golden*.json
web/public/games/<id>.png           512 px icon
migrations-draft/NNN_register_<id>.sql
packages/<id>.md                    the package report (handbook section 14)
```

Reference games to copy from: `games/chakkar-chaku` (tap) and `games/snake-blocks`
(drag/path). Other validators for patterns are in `reference/validators/`.

## Starting a game

1. `cp docs/GAME_BRIEF_TEMPLATE.md packages/<id>.brief.md` and fill it in.
2. Phase 1: write `games/<id>/index.html` + `js/game.js` as a plain playable
   game. Serve with `npx http-server games -p 8080` (or any static server);
   `/games/_shared/...` paths in the page need the server rooted so that
   `/games/` resolves, so serve the repo root: `npx http-server . -p 8080` and
   open `http://localhost:8080/games/<id>/index.html?`.
3. Show the founder; iterate by subtraction.
4. Continue with handbook phases 2 to 10.

`npm run check -- <id>` runs a quick structural check of a package.

## Handing back

When the package is complete, commit it on a branch named `game/<id>` with the
package report. Do not merge to main until the founder has played it. A session
in `kj-platform` integrates it using `docs/INTEGRATION.md`.
