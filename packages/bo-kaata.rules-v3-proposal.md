# Bo Kaata: rules change (trace v3)

Status: APPROVED by the founder and APPLIED in this repo (2026-10-28). `games/bo-kaata/js/rules.js` now carries
the v3 block, byte-identical to `bo-kaata.rules-v3.proposed.js`. `js/game.js` starts runs as v3, and the bridge in
`index.html` now hands out v3 (one line: `Number(want) >= 3 ? 3 : Number(want) >= 2 ? 2 : 1`).
The platform side below is still to do in kj-platform.

sha256 of the block from `// BO KAATA RULES BEGIN` to `// BO KAATA RULES END` (markers included, as UTF-8):
`248ed95ca80fd2262afa8910a59f89a3e97a64a5cbe95c25587b4788708e3e6e`. Check this against however the parity
test slices the block before pasting it in.

Two changes, both inside the rules block, both gated on `sim.v >= 3` so v2 runs replay exactly as before:

1. **Walls turn a pulling kite away** instead of pinning it (founder report: "kites get stuck on the sides").
2. **A fierce kite** (new size 3): faster than you, weaves, quick to attack, worth x4.
   This is the patang/tukkal shape in the founder's three photos.

Files:
- `packages/bo-kaata.rules-v3.patch`: the diff against the current `rules.js`.
- `packages/bo-kaata.rules-v3.proposed.js`: the whole proposed file (only the block between the markers differs).

## 1. Wall pinning

Cause: `flyKite` clamps x and y to the field and sets speed to 0. A kite that keeps pulling toward a wall
restarts from speed 0 every step, so it goes nowhere until the player lets go (or, for a rival, until its dart ends).

Fix (v3 only): a pulling kite that meets a wall while heading into it has its heading mirrored
(`h -> TURN - h` for left and right walls, `h -> 512 - h` for the top). The nose now points away from the wall.

Measured over 60 seeds of 3600 steps (steps spent pulling into a wall at near-zero speed):

| | v2 | v3 |
|---|---|---|
| rivals | 1368 steps, longest 72 (1.2 s) | 0 |
| your kite | 1148 steps, longest 28 | 0 |

Side effect to judge by hand: holding into a wall now bounces the kite across the field
(holding nose-right for 3 s from the middle: x = 333, 380, 301, 152, 23, 77) instead of freezing at the edge.

## 2. The fierce kite (size 3)

- Never in the first 25 s of a run (`WILD_AFTER = 1500` steps). In a normal run the earliest is 42 s anyway
  (measured over 200 seeds with every rival cut the moment it arrives); the guard holds if the spawn pace is ever tuned.
- Appears from wave 4 (`WILD_WAVE`). Share of rivals: about 11% at wave 4, rising to about 40% from wave 9
  (`min(40, 12 + 6 * (wave - 4))`). The first rival of every 5th wave is still the tukkal (size 2).
- Top speed 7 px/step (`WILD_VMAX`), above your 6. Resting it sweeps at 4 px/step (`WILD_CRUISE`) against 2.5 for others.
- Weaves: while pulling, its nose swings with an integer sine (`wa` 5 to 8 units a step, `wf` 9 to 16, random phase),
  so its path wanders. Measured: about 89 px sideways wander per dart, against about 1 px for a patang.
- Quick to attack: warning 12 steps (others 14 to 50), darts 60 to 109 steps, rests 40 steps between attacks.
- Line: needs x1.5 the sawing of a patang (`SIZE_LINE[3] = 3`), pays x4 (`SIZE_PTS[3] = 4`).
- Measured while pulling: average speed 3.74 px/step against 2.92 for a patang, pulling 64% of the time against 51%.

New random draws use new indexes (15 to 18), so rivals that are not fierce are drawn exactly as before.

## What was tested (scratch copy, not the repo)

- v2 on the proposed file gives an identical run to v2 on today's file: 25 seeds x 3600 steps with a bot (new fields `wa`, `wf`, `ph` ignored).
- v3 is deterministic: 10 seeds, same inputs, byte-identical end state, twice.
- Every kite x, y, heading and speed stays an integer over 60 seeds.
- Only integer operations, the existing sine table, no clock, no screen, no randomness.

## What was NOT tested, and why it matters

- **Balance.** My bot is too weak to reach the fierce waves (it loses all its kites early), so I cannot say whether
  the fierce kite is fair or too hard. A fierce kite darting at you is faster than your top speed, so you win by
  hitting it while it rests or turns, not head on. This needs the founder to play it. Knobs: `WILD_WAVE`,
  the spawn formula, `WILD_VMAX`, `wa` (weave strength), `dart`, `restBase`.
- No server code was touched or run.

## Still to do in kj-platform (I cannot make these here)

1. `reference/validators/boKaata.js` (server): the same block word for word, and accept `{ kind: 'start', v: 3 }`.
2. `shared/tests/boKaataParity.test.js`: update the sha256 pin; regenerate golden fixtures for v3 (v2 goldens stay valid).
3. Session/trace version list on the platform: allow v3.
4. Done here: the bridge allows v3 and `startRun` asks for 3. The platform must accept `v: 3` starts.

## Client side, in `game.js`

Big kites (sizes 1 to 3) are drawn as the Lahori tukkal from the founder's photo. Fierce kites are drawn
0.95 to 1.25 times a patang (each its own size, drawing only) with an `x4` label, and a "FIERCE KITE!" banner
shows when one enters. The practice also runs on v3.
