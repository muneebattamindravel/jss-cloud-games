# Game brief: Rang Bharo (rang-bharo)

- **Display name / id (kebab-case):** Rang Bharo / `rang-bharo`
- **One-line pitch:** Swipe a glossy ball through a maze; it slides until a wall stops it and paints every tile it rolls over. Paint them all, the next maze arrives at once.
- **Reference game(s) and links / full-size frames:** The founder named a well known sliding-paint maze game as the mechanic. Founder answer to the reference gate: "no references". Built from the founder's written brief; mechanic only, no name, art or sound taken.
- **Core loop:** One swipe (or arrow key) per move. The ball slides in that direction until the next cell is a wall. Each newly painted tile is 1 point. A cleared maze pays 10 x its number; clearing within par (the BFS shortest solution) adds a PERFECT bonus of 25 + 5 x its number. A swipe during a slide is buffered (only the latest one).
- **Recovery:** Total. There is no death and no fail state; a wasted move costs time and the PERFECT bonus, never the maze.
- **Run length / end condition:** A 3 minute clock (10800 fixed steps). A parked run simply ends when the clock does.
- **Input style:** discrete moves, trace shape `{kind:'move', n, dir, step}` (handbook section 7), one input per step at most.
- **Art gate:** Objects: tiles, walls, a ball, confetti squares. All abstract, code-drawn, truck-art palette as a skin (saffron, teal, magenta, lime, royal blue; dotted "lights" on the board frame, diamond motifs on walls). Passes the gate.
- **Audio:** All Web Audio, generated in code: rolling hum rising with distance, padded wall thunk, pentatonic paint shimmer, rising chord on clear, bell chime on PERFECT, last 10 s ticks, end gong.
- **Randomness that affects score:** Maze n is a pure function of (seed, n): a per-maze stream seeded by `hash3(seed, n, attempt)`. Nothing else is random in the rules. Cosmetics use Math.random.
- **Math needed:** integer only (grid cells, steps; the ball crosses a tile in 4 steps). No trig in the rules.
- **Provably passable how:** The generator simulates the sliding ball itself: it carves the corridor each slide travels and pins the wall that stops it so later carving cannot open it. Every floor tile lies on the designed route, so every maze is solvable by construction. Par comes from a BFS over (cell, painted set), capped at 60000 states; past the cap par is the designed route length (an upper bound, measured at 0 to 18% of mazes 8 to 12). Measured: 2000 seeds x 12 mazes, 0 unsolvable, 0 painted at start; 4800 designed routes driven through the real sim, 0 failures.
- **Difficulty ramp:** Grid 6x6 at maze 1 growing by about one row or column per maze to 11x13; par about 5 at maze 1, 9 at maze 4, 15 at maze 9, 18 at maze 12. Floor share grows from 47% to 58%. The clock and growing par give no top.
- **Bot gap guess:** Large. The course is a pure function of the seed, so a program can play every maze at par with zero think time. A human spends seconds reading each maze. Expect a flawless bot at 2x to 3x a good human; stated in the package report after the ladder.
- **Icon / logo:** Rendered scene (ball painting a corridor) unless the founder sends artwork.
- **Out of scope:** Undo, hints, lives, any between-run progress, music track.
