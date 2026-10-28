'use strict';

/**
 * Which rejection reasons are an ACCUSATION, and which are housekeeping.
 *
 * One definition, because the two were being shown side by side with equal
 * weight and that made ordinary players look like cheats. A profile listing
 * "51 flagged sessions" reads as damning right up until you notice 45 of them
 * are "closed the tab" and "quit within five seconds".
 *
 * TAMPER means: the client submitted a score its own recorded inputs provably
 * do not produce. There is no innocent explanation — replaying the player's own
 * taps through the real game logic is not a heuristic, and an honest client
 * matches within the buffer every time. This is the only class that pages ops
 * and the only class that should ever inform a ban.
 *
 * Everything else is NOISE: a quit, a closed tab, a chatty validator, a tuning
 * artifact. It is worth keeping (it feeds the flag-rate metric and sometimes
 * explains a support ticket) and worth showing, but it must never be presented
 * as evidence of cheating. Cannon Rush's `validator_rejects` fires on honest
 * play; `duration_too_short` fires when someone opens a game and changes their
 * mind.
 */

// TAMPER — the claim is impossible, not merely odd.
const TAMPER_REASONS = [
  // Replaying their own recorded taps through the real game produces a
  // different score. Not a heuristic: 120 sessions from 10 real players
  // replayed to their on-screen score EXACTLY on the day this was written.
  'claimed_mismatch',
  // Claimed more game time than the session was open for. tHint LAGGING is the
  // honest failure mode (a queued or retried event carries the time it
  // happened); claiming more time than has elapsed cannot happen honestly.
  'claimed_duration_exceeds_session',
  'ts_ahead_of_server',
];

// REVIEW — worth a human's eyes, but NOT an accusation.
//
// `no_replay_marker` was in TAMPER for about an hour, and production said no.
// A trace arrives without the v2 marker whenever a STALE CACHED BUILD submits
// during a rollout — the exact skew the replay rollout is designed to tolerate
// — and one of these already carries an admin's own annotation, "(session
// race, 6 Sep)", i.e. a human looked and judged it benign. It also showed up
// as claimed=99 / server=26: a partial score, not the zero a forgery produces.
//
// Calling that tampering would accuse players for having an old build cached.
// It still surfaces, because a run of them on one account is a real signal —
// it just does not get to call anyone a cheat on its own.
const REVIEW_REASONS = [
  'no_replay_marker',
];

/**
 * True when ANY reason on the session is a tamper reason. Reasons arrive
 * comma-joined and sometimes carry a human suffix an admin typed
 * ("no_replay_marker (session race, 6 Sep)"), so match on the prefix of each
 * part rather than the whole string.
 */
const hasAny = (reason, list) =>
  !!reason && list.some((r) => String(reason).includes(r));

/** Impossible-to-do-honestly. The only class that may inform a ban. */
function isTamper(rejectedReason) {
  return hasAny(rejectedReason, TAMPER_REASONS);
}

/** Ambiguous — surface it, but never as an accusation. */
function isReview(rejectedReason) {
  return !isTamper(rejectedReason) && hasAny(rejectedReason, REVIEW_REASONS);
}

/** tamper | review | noise — one word for what a row actually means. */
function classify(rejectedReason) {
  if (isTamper(rejectedReason)) return 'tamper';
  if (isReview(rejectedReason)) return 'review';
  return 'noise';
}

/** Plain English for the admin panel — the reason codes are ours, not theirs. */
const REASON_LABELS = {
  claimed_mismatch: 'Score does not match their own recorded inputs',
  no_replay_marker: 'Submitted without the replay marker',
  claimed_duration_exceeds_session: 'Claimed more game time than the session lasted',
  ts_ahead_of_server: 'Claimed game time ran ahead of real time',
  duration_too_short: 'Quit inside the minimum duration',
  duration_too_long: 'Session ran past the maximum duration',
  expired_by_sweeper: 'Never submitted — tab closed or app backgrounded',
  score_ceiling: 'Score above the per-second ceiling',
};

/**
 * Plain English for a reason string.
 *
 * Do NOT split on commas. Admins annotate these by hand and the annotations
 * contain commas — "no_replay_marker (session race, 6 Sep)" split into
 * "no_replay_marker (session race" and " 6 Sep)", and the second half rendered
 * in the admin table as a reason called "6 Sep)". Reasons are also repeated in
 * the raw string, which printed the same sentence twice in a row.
 *
 * So: scan for the codes we know, de-duplicate, and fall back to the raw
 * string when none match — never invent a reason out of punctuation.
 */
function labelFor(rejectedReason) {
  if (!rejectedReason) return null;
  const raw = String(rejectedReason);
  const out = [];
  for (const [code, label] of Object.entries(REASON_LABELS)) {
    if (raw.includes(code) && !out.includes(label)) out.push(label);
  }
  if (/validator_rejects/.test(raw)) {
    const l = 'Validator refused some events (tuning noise)';
    if (!out.includes(l)) out.push(l);
  }
  return out.length ? out.join(' · ') : raw;
}

module.exports = {
  TAMPER_REASONS, REVIEW_REASONS,
  isTamper, isReview, classify,
  REASON_LABELS, labelFor,
};
