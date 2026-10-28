# Tetris Smash (`tetris-smash`): package notes

Work in progress. The full package report (handbook section 14) is written when the package is complete.

## Founder decisions

- **Name (28 Oct 2026):** the founder chose "Tetris Smash", id `tetris-smash`, after being told that "Tetris" is a registered trademark whose owner enforces it against other games, and that this conflicts with standing rule 6 in `CLAUDE.md` and the founder's own brief ("do not use the name, logo or trade dress of any existing falling-block game"). The founder confirmed the name as final. Integration should flag this for whoever owns legal review before the game goes live.
- **Trade dress:** everything else stays original: our own glazed-block art, colours, charcoal frame, layout, logo treatment (Titan One, two lines), icon, sounds and copy. No logo, colour scheme, music or look of any other falling-block game is used.
- **Look:** the original glazed blocks on a dark charcoal frame (the brown "wooden" frame was removed). Full-width well under a thin top bar.
- **Sounds:** Web Audio only, glassy ticks and clacks with FM bells for clears; no audio files.
- **Previously named:** Girti Eentein (`girti-eentein`), built in kj-platform; renamed before any validator, golden run or migration existed, so nothing downstream carries the old id.

## Open questions for the founder

- HOLD: keep, teach it in HOW TO PLAY, or remove it (a rules change; cheapest before golden runs exist).
