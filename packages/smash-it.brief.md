# Game brief: Smash It (smash-it)

- **Display name / id:** Smash It / `smash-it`
- **One-line pitch:** Fire a cannon at a tower of glass jars, crates and logs; smash it off the table before the balls run out.
- **Reference game:** a well known tower-smash cannon game (founder's screen recordings, branch `royal-smash-videos`, reference only, nothing copied). Name, art and audio here are original.
- **Core loop:** tap a point on the tower, a ball flies there. Glass shatters in one hit, crates take 2, logs take 3. The ball keeps its energy and ricochets through neighbours. Anything unsupported falls; a crate or log falling fast onto glass crushes it.
- **Recovery:** every cleared table adds balls for the next tower, so a good clear banks a cushion for a bad one.
- **Run length / end:** endless towers. Run ends when balls reach 0 with blocks still standing. A parked run never ends on its own yet (Phase 2 item: idle rule).
- **Input style:** tap -> one `{kind:'shot', step, x, y}` per press.
- **Art gate:** jars, crates, logs, a cannon, a fan, a ball: simple abstract objects, all code-drawn.
- **Audio:** all Web Audio, synthesised (glass crack plus tinkles, wood snap and crunch, thuds, cannon, fan clank).
- **Randomness that affects score:** tower layout and ricochet angle, both `hash(seed, level, k)` index-addressed.
- **Math:** integer sim in 1/16 px, 256-step integer sine table for the fan.
- **Provably passable:** every block is breakable; tower size grows to 8 x 9 and stops.
- **Difficulty ramp:** tower 1 small and all glass; crates and logs from tower 2; spinning fan in front from tower 3, faster from tower 7.
- **Bot gap guess:** high (a seed reader can plan perfect ricochets); to measure in Phase 6.
- **Out of scope for v1:** power-ups, continues, themes per level.

## Changes since the first brief

- Renamed from Kaanch Tod to Smash It at the founder's request.
- Real 3D with rigid-body physics (Rapier deterministic build); towers are designed pictures from a library of 21 designs.
- Backdrops: the founder supplied enhanced versions of the code-painted scenes (generated with ChatGPT from our originals) and asked for them to be used. Founder's say-so recorded here for rule 6.
- Glass break audio: recorded clips supplied by the founder (three files uploaded in the session, two of them from commercial libraries, IDs SDSGARN_34872 and ODY-1143-14). Cut, level-matched and mixed into `audio/glass-*.mp3`. Founder's say-so recorded here for rule 6; the library licences should be confirmed before launch.
