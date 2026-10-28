-- 263: Dart Champ (in-house swipe-to-throw darts), on server-side replay from day one.
--
-- A real dartboard. Flick up to throw: the slant aims left and right, a harder
-- flick lands higher (gravity drops a soft throw). A 3 minute round. Every dart
-- has a CALLED target (a number, its double, its treble or the bull) glowing on
-- the board. A dart pays its normal board value (a double 12 is 24); hitting the
-- called target pays a bonus on top (50 / 100 / 120 / 150) times a combo
-- multiplier that climbs to x5, and a miss breaks the combo. The called targets
-- get harder as the combo grows. The next dart appears 0.8 s after a throw, so
-- flinging at random earns a tenth of a careful throw.
--
-- The server replays the throws against the session seed
-- (shared/anticheat/validators/dartChamp.js), whose rules block is word for word
-- the one in games/dart-champ/js/rules.js. Integer rules with one sine TABLE, so
-- no dmath is needed. Trace v2: { kind: 'throw', n, step, dx, dy, ms }.
--
-- max_score_per_sec = 2458: 3x the best 60 s window (819.367/sec) of a flawless
-- pilot that compensates the seeded hand wobble exactly, 12 seeds. A backstop:
-- replay already computes the score from the inputs. Honest pilots peak far
-- lower (good 507/sec, average 210, novice 68, random flinging 7).
--
-- Registered INACTIVE with require_claimed_match OFF and bot detection in RECORD
-- mode, for play test. Going live is the founder's call.

INSERT INTO games (id, name, description, thumbnail_url, game_url, daily_prize_pool, is_active, sort_order, max_score_per_sec, min_duration_secs, max_duration_secs)
VALUES (
  'dart-champ',
  'Dart Champ',
  'Flick to throw real darts at a real board. Hit the glowing target for a big bonus and build your combo up to x5. Three minutes, as many darts as you can land.',
  '/games/dart-champ.png',
  '/games/dart-champ/index.html',
  1500000,   -- Rs. 15,000
  false,
  61,
  2458,
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
  ('anticheat.dart-champ.require_claimed_match', 'false'::jsonb, 'anticheat',
   'Reject a Dart Champ run whose claimed score differs from the server replay.'),
  ('humanness.dart-champ.mode', '"record"'::jsonb, 'humanness',
   'Dart Champ bot detection: off | record | hold | auto. Starts at record until the game has a reference of honest runs.')
ON CONFLICT (key) DO NOTHING;
