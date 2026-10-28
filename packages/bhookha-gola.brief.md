# Game brief: Bhookha Gola (bhookha-gola)

- **Display name / id (kebab-case):** Bhookha Gola / bhookha-gola
- **One-line pitch:** Drag to steer a hungry hole through a small geometric city; anything smaller than the hole falls in and makes it bigger.
- **Reference game(s) and links / full-size frames:** Mechanic of a well known hole io game, solo. Founder answered "no references" (28 Oct 2026); built from the brief. Never its name, art or sounds.
- **Core loop (one input, what it does, how you die, what scores):** One finger drags anywhere as a relative joystick (max speed, never teleports; a second finger is ignored). A prop falls in when it fits (pr <= ~0.92 R) and its centre is inside the rim. Growth adds the prop's footprint area / 10. Props that do not fit block: light ones get nudged, heavy ones (pr >= 60) push the hole out. Score = sum of pr^2/40 per prop times a combo multiplier (x1 to x5, streak resets after 0.8 s with no swallow). Clearing the whole city pays 2000 + 50 per second left. No death; a 2:00 clock.
- **Recovery:** Yes. Nothing is lost on a mistake, only time. A slow route still grows.
- **Run length / end condition:** Timed, 7200 steps (2:00) or a cleared city. A parked run ends on the clock.
- **Input style:** drag (relative stick) -> path batches of the stick vector plus touch/lift markers (handbook section 7, Snake Blocks shape). Stage 2.
- **Art gate:** Cones, bins, parcels, barrels, crates, benches, lollipop trees, pillars, kiosks, domes, toy blocks, containers, stacked-box houses and towers, tanks, a stadium dome, a skyscraper. All plain solids, code drawn, 3/4 view with lit tops, soft contact shadows. No people, animals or vehicles.
- **Audio:** All Web Audio: suction whoosh scaled by size, bass thump for big props, rising combo notes, tier chime, last 10 s ticks, end gong, new-best fanfare.
- **Randomness that affects score:** The city: 5x5 blocks, each block four quadrant clusters; a quadrant's size level, kind, colour and each cell's fill, size and jitter are hash(seed, index, k), fixed draws per cell. Corner blocks hold one landmark (level 5).
- **Math needed:** Integer only plus Math.sqrt (positions in 1/16 units, squared distance checks).
- **Provably passable how:** Eating every prop in ascending size order from the start size always fits the next one: measured over 300 seeds, 0 unreachable, tightest slack 13 units of radius. Stage 2 makes it a test over thousands of seeds.
- **Difficulty ramp:** Centre block is all tiny props, ring 1 small to medium, ring 2 large, corners are landmarks that need a big hole. A greedy seed-reading pilot clears the city in about 90 to 99 s.
- **Bot gap guess:** Large. A planner that reads the seed clears the city with 20 to 30 s to spare; a human will usually not clear it. The humanness layer has to carry this.
- **Icon / logo:** Rendered scene (hole swallowing a crate) unless the founder sends art.
- **Out of scope:** Rival holes (live or AI), power ups, skins, multiple cities per day.
