# jss-games

A separate workspace for building Jeeto Skill Se games, so game work can run in
cloud sessions without the main `kj-platform` repo.

Start here:

1. `CLAUDE.md`: the standing rules for any session in this repo.
2. `docs/HANDBOOK.md`: the full end-to-end process (replay, seed, parity,
   mutation, anti-cheat, anti-bot, where every file goes).
3. `docs/GAME_BRIEF_TEMPLATE.md`: fill in before building.
4. `docs/INTEGRATION.md`: how a finished package goes back into `kj-platform`.

Working references (complete, tests green here): `games/chakkar-chaku` (tap) and
`games/snake-blocks` (drag). More validators in `reference/validators/`.

```
npm install            # jest only
npx jest --runInBand shared/tests/chakkarChakuAdversarial
node scripts/check-game.js <game-id>
```

The platform snapshot (`games/_shared`, `sdk`, `shared/anticheat/*`) was copied
from `kj-platform` on 28 Oct 2026 and is read-only here. Re-copy it from
`kj-platform` when the platform changes; never edit it in this repo.
