-- NNN: Smash It (in-house cannon tower smash), on server-side replay from day one.
--
-- NUMBER: a placeholder. Integration picks the next free number
-- (`ls shared/db/migrations | tail -3`) and renames this file.
--
-- NAME: "Smash It", the founder's choice. The reference game's name, art and
-- audio are not used. The backdrops (ChatGPT-enhanced versions of our own
-- code-painted scenes), the glass clips and the cannon clip were supplied by
-- the founder with written say-so (packages/smash-it.brief.md); two glass
-- clips come from commercial libraries, so confirm those licences before launch.
--
-- Tap a point on the tower and a cannon ball flies there. Glass jars shatter
-- in one hit, crates take 2, logs 3, bricks never break but can be knocked
-- off; TNT blasts its neighbours. Breaks score 10 to 40, anything knocked off
-- the table scores too, and a cleared table adds 100 + 50 x level and a new
-- tower with fresh balls (up to 6 unused balls carry over). Moving shields, a
-- fan and a pendulum guard deeper towers. The run ends when the balls run out
-- with blocks standing, after 30 s with no shot, or at 40 minutes.
--
-- The server replays the shots against the session seed
-- (shared/anticheat/validators/smashIt.js), whose rules block is word for word
-- the one in games/smash-it/js/rules.js. Physics is the Rapier deterministic
-- build (@dimforge/rapier3d-deterministic-compat 0.19.0), bit-exact between
-- Chromium and Node; the validator needs it in the server's dependencies and
-- must be awaited (`await validator.ready`) before its first init. Trace v1:
-- { kind: 'start', v: 1 } then { kind: 'shot', n, x, y, step } per accepted
-- shot (x, y in 1/100 world units).
--
-- max_score_per_sec = 203: 3x the best 60 s window (4,060 points, 67.667 a
-- second) over 12 seeds x 7 pilots of full runs (a patient perfect-aim planner
-- included; its best window was 3,670). A backstop: replay already computes the
-- score from the shots. Median whole runs: patient planner 4,795, average 2,100,
-- good 1,055, novice 1,545 (the human models fire faster and waste balls).
--
-- Registered INACTIVE with require_claimed_match OFF and bot detection in RECORD
-- mode, for play test. Going live is the founder's call.

INSERT INTO games (id, name, description, thumbnail_url, game_url, daily_prize_pool, is_active, sort_order, max_score_per_sec, min_duration_secs, max_duration_secs)
VALUES (
  'smash-it',
  'Smash It',
  'Tap the tower to fire the cannon. Shatter the glass, crack the crates and knock every block off the table before your balls run out. Each cleared tower brings a bigger one.',
  '/games/smash-it.png',
  '/games/smash-it/index.html',
  1500000,   -- Rs. 15,000 (copied from Tetris Smash; the founder sets the real pool)
  false,
  63,        -- placeholder: integration sets the order beside the live line-up
  203,
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
  ('anticheat.smash-it.require_claimed_match', 'false'::jsonb, 'anticheat',
   'Reject a Smash It run whose claimed score differs from the server replay.'),
  ('humanness.smash-it.mode', '"record"'::jsonb, 'humanness',
   'Smash It bot detection: off | record | hold | auto. Starts at record until the game has a reference of honest runs.')
ON CONFLICT (key) DO NOTHING;
