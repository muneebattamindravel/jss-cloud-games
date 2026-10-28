-- 241: Chaku Maar (in-house knife throwing), on server-side replay from day one.
--
-- A log spins in the upper half of the screen. A tap throws a knife straight
-- up; it sticks in the wood. Hitting a knife already stuck ends the run. Each
-- log needs a set number of knives; the last one bursts it into slices and the
-- next log arrives. Spin speeds, reversals, surges, pre-stuck knives and apples
-- come from the session seed; every 5th log is a steel-banded boss. A knife
-- scores 1, an apple 2, a cleared log 5 x its number. No throw for 10 s ends
-- the run (the wood cracks from 6 s, with a countdown).
--
-- The server replays the throws against the session seed
-- (shared/anticheat/validators/chakuMaar.js), whose rules block is word for
-- word the one in games/chaku-maar/js/game.js. Integer rules, no dmath needed
-- (the drawing uses DMath for its sines, the rules use none).
--
-- max_score_per_sec = 2209: 3x a flawless planner's best 60 s window,
-- 736.317/sec (median 711.417) over 40 seeds flown for 10 minutes each on the
-- real game.js. It never died. The figure is high because the clear bonus
-- grows with the log number; it is a backstop, replay already computes the
-- score from the inputs.
--
-- Registered INACTIVE with require_claimed_match OFF (founder brief). Bot
-- detection starts in RECORD mode: the logs are a pure function of a seed the
-- device holds, so a program can throw into the middle of every gap. The
-- validator records the margin to the nearest stuck knife and the throw rhythm
-- for the fingerprint.

INSERT INTO games (id, name, description, thumbnail_url, game_url, daily_prize_pool, is_active, sort_order, max_score_per_sec, min_duration_secs, max_duration_secs)
VALUES (
  'chaku-maar',
  'Chaku Maar',
  'Throw knives into the spinning log. Hit a knife that is already stuck and it is over. Clear the log, smash the boss, grab the apples.',
  '/games/chaku-maar.png',
  '/games/chaku-maar/index.html',
  1500000,   -- Rs. 15,000
  false,
  45,
  2209,
  1,
  3600
)
ON CONFLICT (id) DO UPDATE SET
  name              = EXCLUDED.name,
  description       = EXCLUDED.description,
  thumbnail_url     = EXCLUDED.thumbnail_url,
  game_url          = EXCLUDED.game_url,
  is_active         = EXCLUDED.is_active,
  sort_order        = EXCLUDED.sort_order,
  max_score_per_sec = EXCLUDED.max_score_per_sec,
  min_duration_secs = EXCLUDED.min_duration_secs,
  max_duration_secs = EXCLUDED.max_duration_secs;

INSERT INTO platform_config (key, value, category, description)
VALUES
  ('anticheat.chaku-maar.require_claimed_match', 'false'::jsonb, 'anticheat',
   'Reject a Chaku Maar run whose claimed score differs from the server replay.'),
  ('humanness.chaku-maar.mode', '"record"'::jsonb, 'humanness',
   'Chaku Maar bot detection: off | record | hold | auto. Starts at record until the game has a reference of honest runs.')
ON CONFLICT (key) DO NOTHING;
