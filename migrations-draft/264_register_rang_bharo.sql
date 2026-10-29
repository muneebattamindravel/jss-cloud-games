-- 264: Rang Bharo (in-house sliding-ball paint maze), on server-side replay from day one.
-- (Re-check the number in kj-platform before committing: ls shared/db/migrations | tail -3.)
--
-- A ball sits in a maze. A swipe sends it sliding until a wall stops it,
-- painting every tile it rolls over; paint every tile and the next maze comes
-- at once. A 3 minute clock. A newly painted tile is 1 point, a cleared maze
-- pays 10 x its number less 3 for each move over par (never below 0), and
-- clearing within par (the shortest solution, found by BFS) adds a PERFECT
-- bonus of 40 + 8 x its number. Mazes start at 4x4, grow to 11x13 by maze 18
-- and keep getting longer and more bent after that. Every maze is a pure
-- function of (seed, maze number). The generator carves
-- the ball's own route, so every maze is solvable, and refuses any maze where
-- a move could strand the ball.
--
-- The server replays the moves against the session seed
-- (shared/anticheat/validators/rangBharo.js), whose rules block is word for
-- word the one in games/rang-bharo/js/game.js. Integer rules, no trig, no
-- dmath. Trace v1: { kind: 'move', n, dir, step }.
--
-- max_score_per_sec = 340: 3x the best 60 s window (6786 points, 113.1/sec) of
-- a flawless pilot (plans every maze at par, zero thinking time), 24 seeds. A
-- backstop: replay already computes the score from the inputs. Whole-run rates
-- (24 seeds, medians): flawless 73/sec, good 36, average 15, novice 5.
--
-- Registered INACTIVE with require_claimed_match OFF and bot detection in RECORD
-- mode, for play test. Going live is the founder's call.

INSERT INTO games (id, name, description, thumbnail_url, game_url, daily_prize_pool, is_active, sort_order, max_score_per_sec, min_duration_secs, max_duration_secs)
VALUES (
  'rang-bharo',
  'Rang Bharo',
  'Swipe the ball through the maze. It rolls until it hits a wall and paints every tile it crosses. Clear a maze in par moves for a PERFECT bonus; extra moves cost points. Three minutes, as many mazes as you can.',
  '/games/rang-bharo.png',
  '/games/rang-bharo/index.html',
  1500000,   -- Rs. 15,000
  false,
  62,
  340,
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
  ('anticheat.rang-bharo.require_claimed_match', 'false'::jsonb, 'anticheat',
   'Reject a Rang Bharo run whose claimed score differs from the server replay.'),
  ('humanness.rang-bharo.mode', '"record"'::jsonb, 'humanness',
   'Rang Bharo bot detection: off | record | hold | auto. Starts at record until the game has a reference of honest runs.')
ON CONFLICT (key) DO NOTHING;
