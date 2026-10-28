# Game brief: Minar Tod (minar-tod)

- **Display name / id (kebab-case):** Minar Tod / `minar-tod`
- **One-line pitch:** A spinning tower of coloured blocks; one tap fires a ball at the block in the glowing frame, and every same-colour block touching it shatters.
- **Reference game(s) and links / full-size frames:** The founder named the Knock'em All / Tower Crash family (mechanic only) and answered "no references", so this is built from the written brief. No name, art or sound from those games is used.
- **Core loop (one input, what it does, how you die, what scores):**
  The tower is an integer grid on a cylinder: 8 columns around, 10 levels at first, up to 20 (see below).
  It spins on a seeded speed pattern, and an aim ring sweeps up and down it. A glowing frame shows
  exactly which block the ball will hit (the facing column when the ball lands 16 steps later, at the aimed level),
  and the whole group that would break is lit. Tap: the ball flies, the block and its connected
  same-colour group break (flood fill, wrapping around), and blocks above fall down their columns.
  New groups formed by the fall do not break by themselves. Points for a group of n are `5 n (n + 1)`
  (1 block 10, 10 blocks 550, 20 blocks 2,100), and they go INTO THE TOWER. Clearing every breakable
  block SMASHES the tower: its points are banked, plus 1,000 + 500 per tower index + 200 per spare ball.
  Out of balls with blocks left: the tower stands, its points are lost, and the next tower comes after 4 s.
  Nobody dies; the clock ends the run, and the tower in play is banked when time runs out.
- **Recovery:** Every tower is a fresh start with a fresh ball budget; a bad tower costs only that tower.
- **Run length / end condition:** 3 minutes (10,800 steps at 60 Hz). A parked run ends with the clock.
  Idle for 3 s: the ring and frame glow, nothing punishes it.
- **Input style:** tap (one press is one input, KJPress). Trace in stage 2: `{ kind: 'fire', n, step }`.
  One ball in the air at a time; a tap while a ball flies, during a tower change or with no balls is refused.
- **Art gate:** abstract and drawn in code: rounded blocks (instanced), a ball, a pedestal with a
  truck-art band, a minaret-like cap (balcony, drum with arches, onion dome, finial), a distant skyline of
  domes and minarets as plain silhouettes. No landmark, logo or character.
- **Audio:** Web Audio only, synthesised: fire thump, crunch sized by the chunk, stone knocks as blocks
  land, steel clang, bomb boom, rising chord on SMASHED, falling notes when a tower stands, ticks in the
  last 10 s, end gong, UI blips.
- **Randomness that affects score:** the seed decides each tower's cells (one hash per cell,
  `hash(seed, 100 + k, r * 8 + c)`, neighbour copying for clusters), its start angle, spin direction,
  wobble rate and phase, aim start and aim speed (`hash(seed, k, 9001..9003)`). Tower k is a pure
  function of (seed, k). Debris, dust, confetti and shake use Math.random and never touch the sim.
- **Math needed:** integers only. Spin uses a 65-entry quarter sine table (amplitude 1024); angles are
  65,536 units per turn; the aim moves in 1/256 of a level per step.
- **Provably passable how:** every (column, level) can be framed (the tower turns, the aim sweeps every
  level), so a greedy solver that always takes the biggest chunk is a real line of play. The budget is
  `greedy + 3 + 40% of greedy`, computed when the tower is built. Stage 2 proves it over thousands of seeds.
- **Difficulty ramp:** one new thing per tower. T1: 3 colours, steady spin. T2: 4 colours. T3: the spin
  breathes (speeds up and slows). T4: steel blocks. T5: 5 colours. T6: bombs (clear their ring).
  T7+: the spin can reverse; towers grow by 2 levels each time and spin faster.
- **Bot gap guess:** a seed-reading bot knows where every frame will land and can always take the biggest
  chunk; scripted greedy pilots score about the same as a fast careful human model today, so the gap is mostly
  reaction time. The ladder in stage 2 measures it.
- **Icon / logo:** rendered scene (tower, cap, flying blocks) unless the founder sends art.
- **Out of scope:** physics deciding anything, power-ups, more than one ball in the air, chain reactions
  after falls, bombs set off by neighbours.

## Decisions to confirm with the founder
1. **Points are banked only when a tower is smashed.** The brief said a standing tower loses only the
   spare-ball bonus. Measured over 16 seeds, with that rule blind spamming scored MORE than careful play
   (spam 66k against good 57k), because failing fast hands out fresh balls. With banking: careful about 60k,
   a fixed tap rhythm about 11k, spam about 5k.
2. **Tallest tower is 20 levels, not 30.** At 24 the blocks are already about 13 px tall on a 375 px phone; 20 keeps colours readable. Later towers get harder through colours, steel, bombs and spin instead.
3. **8 columns** throughout.
