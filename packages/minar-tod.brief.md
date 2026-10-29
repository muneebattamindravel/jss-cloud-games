# Game brief: Minar Tod (minar-tod)

- **Display name / id (kebab-case):** Minar Tod / `minar-tod`
- **One-line pitch:** Swipe to turn a tower of coloured blocks, tap a block, and a cannon ball smashes it along with every same-colour block touching it.
- **Reference game(s) and links / full-size frames:** The founder named the Knock'em All / Tower Crash family (mechanic only) and answered "no references", so this is built from the written brief. No name, art or sound from those games is used.
- **Core loop (one input, what it does, how you die, what scores):**
  The tower is an integer grid on a cylinder: 8 columns around, 10 levels at first, up to 20 (see below).
  It drifts on a seeded speed pattern and the player swipes to turn it (a flick keeps it spinning and fades).
  Tapping a block on the near side fires the cannon; the ball flies 12 steps (one in the air at a time; the
  target chunk glows, and a finger resting on a block previews its chunk). The block and its connected
  same-colour group break (flood fill, wrapping around) as a ripple from the hit, and blocks above fall.
  Skill: reading the tower for the biggest chunk, setting up merges, keeping a combo. (Round 1 used a timed
  aim frame; round 2 tap-the-block; round 3 added swipe to turn and the combo, both chosen by the founder.)
  New groups formed by the fall do not break by themselves. Points for a group of n are `5 n (n + 1)`
  (1 block 10, 10 blocks 550, 20 blocks 2,100), times the combo: chunks of 5 or more in a row raise it x2, x3, x4;
  a smaller chunk or a steel hit resets it. Points go INTO THE TOWER. Clearing every breakable
  block SMASHES the tower: its points are banked, plus 1,000 + 500 per tower index + 200 per spare ball.
  Out of balls with blocks left: the tower stands, its points are lost, and the next tower comes after 4 s.
  Nobody dies; the clock ends the run, and the tower in play is banked when time runs out.
- **Recovery:** Every tower is a fresh start with a fresh ball budget; a bad tower costs only that tower.
- **Run length / end condition:** 3 minutes (10,800 steps at 60 Hz). A parked run ends with the clock.
  Idle costs only time.
- **Input style:** swipe and tap. One finger at a time. A drag turns the tower (sent to the rules as integer turns,
  at most 4,096 units a step), a release sets a flick speed that decays by 15/16 a step, and a tap without a drag
  fires at the block under the finger (raycast, small fingertip tolerance). Stage 2 trace:
  `{ kind: 'turn', step, d }`, `{ kind: 'flick', step, v }`, `{ kind: 'fire', n, step, c, r }`; turns batch per step.
