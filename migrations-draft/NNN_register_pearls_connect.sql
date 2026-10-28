-- NNN: Pearls Connect (in-house chain-the-pearls puzzle), on server-side replay from day one.
-- Pick the number at integration: `ls shared/db/migrations | tail -3`.
--
-- A 6 x 6 board of pearls in five colours. Drag through pearls of one colour,
-- up, down or sideways; lifting the finger clears the chain, and n pearls pay
-- n(n-1)/2 (a pair 1, six 15, ten 45). Closing a loop clears every pearl of that colour and pays double.
-- Pearls fall, new ones drop in, a board with no pair reshuffles. Five minutes.
--
-- The server replays the chains against the session seed
-- (shared/anticheat/validators/pearlsConnect.js), whose rules block is word for
-- word the one in games/pearls-connect/js/game.js. Integer rules, no trig, no
-- dmath. Trace v2: { kind: 'chain', n, step, down, cells }.
--
-- max_score_per_sec = 486: 3x the best 60 s window (161.95/sec) of a flawless
-- pilot that plays the best chain or loop on the board with a fast hand
-- (2 steps a pearl, 8 steps between chains), 24 seeds of full 5 minute runs.
-- A backstop: replay already computes the score from the inputs. Honest pilots
-- peak far lower (good 33.48/sec, average 12.45, novice 4.08).
--
-- Registered INACTIVE with require_claimed_match OFF and bot detection in RECORD
-- mode, for play test. Going live is the founder's call.

INSERT INTO games (id, name, description, thumbnail_url, game_url, daily_prize_pool, is_active, sort_order, max_score_per_sec, min_duration_secs, max_duration_secs)
VALUES (
  'pearls-connect',
  'Pearls Connect',
  'Drag through pearls of one colour to clear them. Longer chains score far more, and closing a loop clears every pearl of that colour for double. Five minutes.',
  '/games/pearls-connect.png',
  '/games/pearls-connect/index.html',
  1500000,   -- Rs. 15,000
  false,
  62,
  486,
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
  ('anticheat.pearls-connect.require_claimed_match', 'false'::jsonb, 'anticheat',
   'Reject a Pearls Connect run whose claimed score differs from the server replay.'),
  ('humanness.pearls-connect.mode', '"record"'::jsonb, 'humanness',
   'Pearls Connect bot detection: off | record | hold | auto. Starts at record until the game has a reference of honest runs.')
ON CONFLICT (key) DO NOTHING;
