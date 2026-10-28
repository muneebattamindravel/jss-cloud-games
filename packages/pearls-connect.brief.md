# Game brief: Pearls Connect (pearls-connect)

**Working agreement (founder, standing):** build the GAME first, until the founder
calls it ready. Seed wiring, the deterministic rules block, the validator, parity,
replay, adversarial, render and mutation suites, and all anti-cheat and anti-fraud
work come AFTER that, as a separate stage. This applies to every game here.

- **Display name / id:** Pearls Connect / pearls-connect (renamed from Moti Jor, 28 Oct)
- **One-line pitch:** drag through pearls of one colour to clear them; close a loop to clear every pearl of that colour.
- **Reference game(s):** the chain-and-loop mechanic of dot-connecting puzzles. No name, art or audio taken.
- **Core loop:** drag a chain of 2 or more same-colour pearls (up, down, sideways), release to clear. Chain of n scores n(n+1)/2; a loop scores double on every pearl of that colour. Refill falls from above; after a loop the refill avoids that colour.
- **Recovery:** nothing kills you; a weak move only costs time.
- **Run length / end:** 5 minute fixed clock (founder, 28 Oct). A parked run ends at 5:00.
- **Input style:** drag (later trace: one event per released chain, the list of cells).
- **Art gate:** coloured circles on a grid, code-drawn. Passes.
- **Audio:** Web Audio only.
- **Randomness that affects score:** board and refills (phase 1 uses a local generator; later index-addressed per column from the session seed).
- **Math:** integer grid only.
- **Provably passable:** a board with no adjacent pair reshuffles.
- **Difficulty ramp:** none yet beyond the clock. Open question for the founder.
- **Out of scope v1:** power-ups, levels, obstacles.
