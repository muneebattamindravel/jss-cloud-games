-- NNN: Tetris Smash (in-house falling-block line clearing), on server-side replay from day one.
--
-- NUMBER: a placeholder. 254 (the number first planned) is taken in kj-platform,
-- and the main repo was at 264 on 28 Oct 2026. Integration picks the next free
-- number (`ls shared/db/migrations | tail -3`) and renames this file.
--
-- NAME: "Tetris Smash" is the founder's final choice (28 Oct 2026), made after
-- being told that "Tetris" is a registered trademark enforced against other
-- games. Recorded in packages/tetris-smash.md; legal review before it goes live.
-- Everything else (art, colours, logo lettering, icon, sounds) is our own.
--
-- A 10 x 20 well. Pieces fall; drag sideways to move, tap to turn, swipe down
-- to drop, hold a finger still to soft-drop. 1/2/3/4 rows score 100/300/500/800
-- x level, a four right after a four x1.5, a combo of clearing pieces +50 x
-- combo x level, a hard drop +2 a row. Level up every 10 rows; gravity per
-- level from a fixed table. A 5 minute clock, or a piece that cannot spawn,
-- ends the run.
--
-- The server replays the acts against the session seed
-- (shared/anticheat/validators/tetrisSmash.js), whose rules block is word for
-- word the one in games/tetris-smash/js/rules.js. Integer rules, no trig, so no
-- dmath. Trace v2: { kind: 'start', v: 2 } then { kind: 'act', n, a, step } per
-- accepted action (a: 0 left, 1 right, 2 clockwise, 3 anticlockwise, 4 soft
-- drop on, 5 soft drop off, 6 hard drop).
--
-- max_score_per_sec = 44622: 3x the best 60 s window (892,438 points, 14,873.967
-- a second) of a flawless planner over 20 seeds of full 5 minute runs. A
-- backstop: replay already computes the score from the acts. Honest pilots
-- score far lower over a whole run (median good 103,740, average 10,564,
-- novice 2,068).
--
-- Registered INACTIVE with require_claimed_match OFF and bot detection in RECORD
-- mode, for play test. Going live is the founder's call.

INSERT INTO games (id, name, description, thumbnail_url, game_url, daily_prize_pool, is_active, sort_order, max_score_per_sec, min_duration_secs, max_duration_secs)
VALUES (
  'tetris-smash',
  'Tetris Smash',
  'Drag the falling blocks into place and fill rows to smash them. Clear four at once for a SMASH!, chain clears for combos, and climb the levels before the 5 minute clock runs out.',
  '/games/tetris-smash.png',
  '/games/tetris-smash/index.html',
  1500000,   -- Rs. 15,000 (copied from Dart Champ; the founder sets the real pool)
  false,
  62,        -- placeholder: integration sets the order beside the live line-up
  44622,
  1,
  3600
)
ON CONFLICT (id) DO UPDATE SET
  name              = EXCLUDED.name,
  description       = EXCLUDED.description,
  thumbnail_url     = EXCLUDED.thumbnail_url,
  game_url          = EXCLUDED.game_url,
  sort_order        = EXCLUDED.sort_order,
  max_score_per_sec = EXCLUDED.max_score_per_sec,
  min_duration_secs = EXCLUDED.min_duration_secs,
  max_duration_secs = EXCLUDED.max_duration_secs;

INSERT INTO platform_config (key, value, category, description)
VALUES
  ('anticheat.tetris-smash.require_claimed_match', 'false'::jsonb, 'anticheat',
   'Reject a Tetris Smash run whose claimed score differs from the server replay.'),
  ('humanness.tetris-smash.mode', '"record"'::jsonb, 'humanness',
   'Tetris Smash bot detection: off | record | hold | auto. Starts at record until the game has a reference of honest runs.')
ON CONFLICT (key) DO NOTHING;
