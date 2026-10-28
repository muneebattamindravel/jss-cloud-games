# Game brief: Bhookha Gola (bhookha-gola)

- **Display name / id (kebab-case):** Bhookha Gola / bhookha-gola
- **One-line pitch:** Drag to steer a hungry hole through a small geometric city; anything smaller than the hole falls in and makes it bigger.
- **Reference game(s) and links / full-size frames:** Mechanic of a well known hole io game, solo. Founder answered "no references" (28 Oct 2026); built from the brief. Never its name, art or sounds.
- **Core loop (one input, what it does, how you die, what scores):** One finger drags anywhere as a relative joystick. A prop falls in when it fits (pr <= ~0.92 R) and its centre is inside the rim; growth adds its footprint / 5. Too-big props block (light ones nudged, heavy ones push the hole). The hole is hungry: 1.5 s after its last swallow it loses 0.12% of its area every step, and shrinking below radius ~18.6 ends the run (STARVED). Score = sum of pr^2/40 per prop times a combo multiplier (x1 to x5). Clearing the city pays 1000 + 100 per second left. 90 s clock.
- **Recovery:** Yes. Nothing is lost on a mistake, only time. A slow route still grows.
- **Run length / end condition:** 5400 steps (1:30), a cleared city, or starving. A run with no input starves in about 8.6 s.
- **Input style:** drag (relative stick) -> path batches of the stick vector plus touch/lift markers (handbook section 7, Snake Blocks shape). Stage 2.
- **Art gate:** Neon night bazaar look (dark bodies, glowing edges, lit windows, fairy lights, bloom). Cones, bins, parcels, barrels, crates, benches, lollipop trees, pillars, kiosks, domes, toy blocks, containers, stacked-box houses and towers, tanks, a stadium dome, a skyscraper. All plain solids, code drawn, 3/4 view with lit tops, soft contact shadows. No people, animals or vehicles.
- **Audio:** All Web Audio: suction whoosh plus a material sound per prop (clay, wood, metal, leaves, plastic, stone), bass thump for big props, rising combo notes, a tabla groove that adds layers with the combo, hunger heartbeat, tier chime, last 10 s ticks, end gong, starve wail, new-best fanfare.
- **Randomness that affects score:** 3x3 blocks. Centre block: two quadrants of tiny props, two of small. Each side block holds one cluster of every level 1 to 4 in a seeded order. Corners hold one landmark each. Kinds, colours, cell fill, size and jitter are hash(seed, index, k) with fixed draws per cell.
- **Math needed:** Integer only plus Math.sqrt (positions in 1/16 units, squared distance checks).
- **Provably passable how:** Eating every prop in size order always fits the next one: 1000 seeds, 0 unreachable, tightest slack 12 units of radius. Hunger can still strand a slow player; that is the skill.
- **Difficulty ramp:** Centre is tiny props, sides climb through every size, corners need a big hole. A greedy seed-reading pilot clears the city in 40 to 63 s (10 seeds); the race to clear early is the top of the board.
- **Bot gap guess:** Large. A planner that reads the seed clears the city with 20 to 30 s to spare; a human will usually not clear it. The humanness layer has to carry this.
- **Icon / logo:** Rendered scene (hole swallowing a crate) unless the founder sends art.
- **Out of scope:** Rival holes (live or AI), power ups, skins, multiple cities per day.
