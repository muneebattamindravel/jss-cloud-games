# Game brief: Minar Tod (minar-tod)

- **Display name / id (kebab-case):** Minar Tod / `minar-tod`
- **One-line pitch:** A spinning tower of coloured blocks; tap any block and a ball smashes it, along with every same-colour block touching it.
- **Reference game(s) and links / full-size frames:** The founder named the Knock'em All / Tower Crash family (mechanic only) and answered "no references", so this is built from the written brief. No name, art or sound from those games is used.
- **Core loop (one input, what it does, how you die, what scores):**
  The tower is an integer grid on a cylinder: 8 columns around, 10 levels at first, up to 20 (see below).
  It spins on a seeded speed pattern. The player taps a block on the near side of the tower; a ball flies
  to it (12 steps, one ball in the air at a time, the target chunk glows while it flies), the block and its
  connected same-colour group break (flood fill, wrapping around), and blocks above fall down their columns.
  The skill is spotting the biggest chunk and tapping it accurately while it moves; the spin brings the far
  side round. (Round 1 used a moving aim frame and a timed tap; the founder chose tap-the-block instead.)
  New groups formed by the fall do not break by themselves. Points for a group of n are `5 n (n + 1)`
  (1 block 10, 10 blocks 550, 20 blocks 2,100), and they go INTO THE TOWER. Clearing every breakable
  block SMASHES the tower: its points are banked, plus 1,000 + 500 per tower index + 200 per spare ball.
  Out of balls with blocks left: the tower stands, its points are lost, and the next tower comes after 4 s.
  Nobody dies; the clock ends the run, and the tower in play is banked when time runs out.
- **Recovery:** Every tower is a fresh start with a fresh ball budget; a bad tower costs only that tower.
- **Run length / end condition:** 3 minutes (10,800 steps at 60 Hz). A parked run ends with the clock.
  Idle costs only time.
- **Input style:** tap a block (one press is one input, KJPress; the tap is raycast to a cell with a small
  fingertip tolerance). Trace in stage 2: `{ kind: 'fire', n, step, c, r }`. The rules refuse a tap while a ball
  flies, during a tower change, with no balls, on an empty cell or on a column facing away.
