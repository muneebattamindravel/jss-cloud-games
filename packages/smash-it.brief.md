# Game brief: Smash It (smash-it)

- **Display name / id:** Smash It / `smash-it`
- **One-line pitch:** Fire a cannon at a tower of glass jars, crates and logs; smash it off the table before the balls run out.
- **Reference game:** a well known tower-smash cannon game (founder's screen recordings, branch `royal-smash-videos`, reference only, nothing copied). Name, art and audio here are original.
- **Core loop:** tap a point on the tower, a ball flies there. Glass shatters in one hit, crates take 2, logs take 3. The ball keeps its energy and ricochets through neighbours. Anything unsupported falls; a crate or log falling fast onto glass crushes it.
- **Recovery:** every cleared table adds balls for the next tower; up to 6 unused balls carry over, so a good clear banks a small cushion.
- **Run length / end:** endless towers. The run ends when the balls run out with blocks still standing, after 30 s with no shot, or at 40 minutes.
- **Input style:** tap -> one `{kind:'shot', n, x, y, step}` per press.
- **Art gate:** jars, crates, logs, a cannon, a fan, a ball: simple abstract objects, all code-drawn (three.js, unlit matcaps). Backdrops: see below.
- **Audio:** recorded glass and cannon clips (see below) plus synthesised wood, thuds and bonks. No tinkles (founder).
- **Randomness that affects score:** tower design and obstacle plan, both `hash(seed, level, k)` index-addressed; everything else is deterministic physics.
- **Math:** Rapier deterministic build (cross-platform bit-exact WebAssembly); obstacle rotations from an integer quarter-sine table.
- **Provably passable:** every block is breakable; tower size grows to 8 x 9 and stops.
- **Difficulty ramp:** 36 designs unlocked with depth; fewer balls per block as levels rise; a moving shield from level 3, the fan from 5, a pendulum from 9; at most one obstacle before level 8, two from 8, three on boss levels (every 5th from 10).
- **Bot gap guess:** high (a seed reader can plan perfect ricochets); to measure in Phase 6.
- **Out of scope for v1:** power-ups, continues, themes per level.

## Changes since the first brief

- Renamed from Kaanch Tod to Smash It at the founder's request.
- Real 3D with rigid-body physics (Rapier deterministic build); towers are designed pictures from a library of 21 designs.
- Backdrops: the founder supplied enhanced versions of the code-painted scenes (generated with ChatGPT from our originals) and asked for them to be used. Founder's say-so recorded here for rule 6.
- Glass break audio: recorded clips supplied by the founder (three files uploaded in the session, two of them from commercial libraries, IDs SDSGARN_34872 and ODY-1143-14). Cut, level-matched and mixed into `audio/glass-*.mp3`. Founder's say-so recorded here for rule 6; the library licences should be confirmed before launch.
- Cannon fire audio: `audio/cannon.mp3`, a recording the founder supplied in the session (Canon_Explosion.mp3), trimmed to 1.6 s and lowered about 12%. Founder's say-so recorded here for rule 6; confirm its licence before launch.
