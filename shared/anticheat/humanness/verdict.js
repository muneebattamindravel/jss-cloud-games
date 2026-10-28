'use strict';

/**
 * Humanness verdict.
 *
 * Given one run's features, the game's population envelope (quantiles of
 * every feature over honest runs) and the player's own baseline, produce a
 * confidence 0..100 that the run was not played by a hand, with every
 * contributing signal listed so the decision can be shown and disputed.
 *
 * The rules, in plain words:
 *
 *   - A feature only counts when it sits in the SUSPICIOUS direction beyond
 *     the honest population's p5 / p95 edge. Inside that band it scores 0.
 *   - Beyond the edge it rises to 0.8 at the most extreme honest run ever
 *     seen, and to 1.0 once it is past that by the same distance again.
 *   - Features are grouped by what they measure (rhythm, floor, accuracy,
 *     control, hold, personal). A group scores its strongest member, so ten
 *     ways of saying "regular rhythm" are still ONE piece of evidence.
 *   - Confidence = 100 * (0.55 * best group + 0.35 * second + 0.10 * third).
 *     Two groups at the honest extreme reach 90; one alone cannot.
 *   - A physical impossibility (an input gap below the game's own floor)
 *     is 95 on its own.
 *
 * Thresholds (hold 70, auto 90) are config, not code, and only the backtest
 * over real play can say whether they are safe for a given game.
 */

const { welfordSd } = require('./stats');

// feature -> { group, dir }  dir 'low' = suspicious when LOW, 'high' when HIGH,
// 'both' = suspicious either way. A group scores its strongest member, so
// three ways of saying "regular rhythm" are still ONE piece of evidence.
//
// Groups: rhythm (how regular), floor (how fast), endurance (how long a
// human has ever kept it up), accuracy (how precise), hold (press lengths),
// steerShape / steerForce (a steering game's strokes), personal (vs own past).
const FEATURE_SPEC = {
  gapCv:          { group: 'rhythm',     dir: 'low',  label: 'input rhythm variation' },
  gapMadRel:      { group: 'rhythm',     dir: 'low',  label: 'robust rhythm variation' },
  gapTight:       { group: 'rhythm',     dir: 'high', label: 'inputs on the beat' },
  gapCvLate:      { group: 'rhythm',     dir: 'low',  label: 'late-run rhythm variation' },
  gapMin:         { group: 'floor',      dir: 'low',  label: 'fastest input gap (ms)' },
  gapP10:         { group: 'floor',      dir: 'low',  label: '10th percentile gap (ms)' },
  inputs:         { group: 'endurance',  dir: 'high', label: 'inputs in one run', decisiveMul: 1.5, decisiveP99: 3 },
  perfectRate:    { group: 'accuracy',   dir: 'high', label: 'perfect landings', decisiveMul: 1.3 },
  // A rate is diluted by a few misses at the end of a bot run; the longest
  // streak of consecutive perfect landings is not.
  perfectStreakMax: { group: 'accuracy', dir: 'high', label: 'longest perfect streak', decisiveMul: 1.5 },
  meanErr:        { group: 'accuracy',   dir: 'low',  label: 'mean landing error', decisiveMul: 2 },
  errSlope:       { group: 'accuracy',   dir: 'low',  label: 'error growth over the run' },
  holdCv:         { group: 'hold',       dir: 'low',  label: 'hold length variation' },
  holdTight:      { group: 'hold',       dir: 'high', label: 'holds on the beat' },
  strokeMean:     { group: 'steerShape', dir: 'both', label: 'stroke length' },
  strokeCv:       { group: 'steerShape', dir: 'low',  label: 'stroke length variation' },
  pauseCv:        { group: 'steerShape', dir: 'low',  label: 'pause length variation' },
  // Direction changes and active fraction were tried here and removed: a
  // human nudging the tower with rapid taps has the bot's SHAPE (one-step
  // strokes, many flips) at a tenth of its force. The force is the tell.
  rotAbsQMean:    { group: 'steerForce', dir: 'both', label: 'rotation per step', decisiveMul: 2 },
  // Measured over 133 ms windows, so the phone's frame rate cannot change them.
  steerForce:     { group: 'steerForce', dir: 'both', label: 'steering per step' },
  steerForceCv:   { group: 'steerForce', dir: 'low',  label: 'steering force variation' },
  // Input shape, from the SDK's provenance summary. Calibrated by the
  // envelope like everything else; the hard contradictions are in
  // deviceContradictions() and need no envelope.
  provHoldModeFrac: { group: 'inputShape', dir: 'high', label: 'presses with one fixed hold length' },
  provHoldCv:       { group: 'inputShape', dir: 'low',  label: 'hold length variation (hardware)' },
  provCoordUniq:    { group: 'inputShape', dir: 'low',  label: 'distinct press positions' },
  provPreMoveFrac:  { group: 'inputShape', dir: 'low',  label: 'presses preceded by movement' },
};

// Features whose meaning is specific to one game.
// (Orbit Runner's points per launch was tried here and removed: a miss ends
// the run, so every long run has a 0.99 hit rate and it separated nothing.)
const GAME_FEATURE_SPEC = {
  // Sky Tower: points per drop IS landing accuracy (perfect-streak bonuses
  // and frenzy), so a run of 20+ drops far above what any human has earned
  // per drop is decisive. snk's bot: 304 points from 20 drops, 15.2 per
  // drop, against an honest tail of 5.6.
  'sky-tower': { pointsPerInput: { group: 'accuracy', dir: 'high', label: 'points per drop', decisiveMul: 1.5, minInputs: 20 } },
};

// Personal baseline: how the run compares with THIS player's own past.
// Supporting evidence only: it can raise a verdict, never carry one.
const PERSONAL_SPEC = {
  gapCv:       { dir: 'low',  label: 'rhythm variation vs own history' },
  gapMean:     { dir: 'low',  label: 'tempo vs own history (faster)' },
  holdCv:      { dir: 'low',  label: 'hold variation vs own history' },
  perfectRate: { dir: 'high', label: 'accuracy vs own history' },
  rotFlipsPer100: { dir: 'both', label: 'steering changes vs own history' },
};
const BASELINE_FEATURES = Object.keys(PERSONAL_SPEC);
const PERSONAL_CAP = 0.7;

// Physical floors: an input gap below this is not a fast human, it is not a
// human. NONE today. Sky Tower's 238 ms (from the block's travel time) was
// tried and two honest players measured 164 and 218 ms on real play, so it
// was removed: a floor must come from measurement, never from arithmetic.
const PHYSICAL_FLOOR_MS = {};

// DECISIVE: a measure past the honest 1-in-1000 run by this MULTIPLE settles
// the verdict alone at DECISIVE_CONF (high direction: x >= mul * p99.9; low
// direction: x <= p0.1 / mul). Set from the data, with room above the honest
// non-tester extreme on every game. The first version capped a single
// evidence group at 55, and a bot whose ONLY tell was accuracy (95.7% perfect
// against an honest maximum of 65.9%) walked through at 55. Set from the data, with room:
// 3x on run length (Orbit's longest human run is 1.9x its p99; the bots ran
// 5x to 50x), 4x on rotation per step (the honest non-builder maximum is
// under 3x; the Twist Fall bot is 5x).
const DECISIVE_CONF = 95;
// What a beyond-every-honest-run measure needs from a DIFFERENT population group
// before it may settle the verdict (0.5 = that group is at the honest 1-in-100).
const DECISIVE_CORROBORATION = 0.5;
// Past this multiple of the honest 1-in-1000 run, a measure needs no company:
// phechanotojano's Orbit Runner bot made 2,146 launches where the longest human
// run is 83 (26x). A person beating the record does it by a margin, not fivefold.
const DECISIVE_ALONE_MUL = 5;
const WEIGHTS = [0.55, 0.35, 0.10];
const DEFAULTS = { holdThreshold: 70, autoThreshold: 90, envelopeMinRuns: 50, baselineMinRuns: 5, minInputs: 20, minSpanSec: 10 };

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Distance past the honest edge, mapped onto 0..1:
//   0    inside the honest band (p5..p95)
//   0.5  at the honest extreme (p0.1 / p99.9: one honest run in a thousand)
//   1    past the extreme by the same distance again
// Quantiles rather than min/max, because one contaminated run in the corpus
// must not be able to move where "human" ends.
function oneSided(x, edge, ext, dir) {
  if (edge === null || edge === undefined || ext === null || ext === undefined) return 0;
  const past = dir === 'low' ? edge - x : x - edge;
  if (past <= 0) return 0;
  const span = Math.abs(edge - ext);
  if (span <= 0) return 1;
  const t = past / span;
  return 0.5 * Math.min(t, 1) + 0.5 * clamp01(t - 1);
}
function pick(env, keys) {
  for (const k of keys) if (env[k] !== undefined && env[k] !== null) return env[k];
  return null;
}
// The honest extreme is the 1-in-1000 run (p0.1 / p99.9), falling back to
// the 1-in-100 on a thin envelope. The p99 was tried first: Twist Fall's
// keyboard players (a fixed 24,000 units per step) all sat past it.
function extremeness(x, env, dir) {
  if (!env || x === null || x === undefined || !Number.isFinite(x)) return 0;
  const lo = oneSided(x, env.p5, pick(env, ['p001', 'p1', 'min']), 'low');
  const hi = oneSided(x, env.p95, pick(env, ['p999', 'p99', 'max']), 'high');
  if (dir === 'low') return lo;
  if (dir === 'high') return hi;
  return Math.max(lo, hi);
}

// Reference = the honest p99.9 (the longest human runs), falling back to
// p99 on a thin envelope. The p99 alone was tried: on Save The Birdie a
// top player's 637 taps was 3x the p99 and 1.06x his own previous run.
function tailRef(env) {
  for (const k of ['p999', 'p99', 'max']) if (env[k] !== undefined && env[k] !== null && env[k] > 0) return env[k];
  return null;
}
function endurance(x, env) {
  const ref = tailRef(env);
  if (!ref || !Number.isFinite(x)) return 0;
  return clamp01(x / ref - 1);
}

// ── PROVENANCE: is this device what it claims to be? ─────────────────────
// The user agent (parsed server-side into os / type) is the CLAIM. The
// device snapshot and the input summary are what the browser actually did.
// Each contradiction below has no innocent explanation on a real phone.
const UNTRUSTED_FRAC = 0.1;
const UNTRUSTED_MIN_N = 3;
const HOLD_FLOOR_MS = 15;
const HOLD_MIN_N = 20;
const MOBILE_OS = new Set(['iOS', 'Android']);
// Android Chrome reports "Linux armv8l" or "Linux aarch64" here, so ARM Linux is NOT a desktop tell.
const DESKTOP_PLATFORMS = /^(Win32|Win64|Linux x86_64|Linux i686|MacIntel)$/;
function deviceContradictions(device, features) {
  const out = [];
  if (!device) return out;
  const os = device.os || null;
  const claimsMobile = MOBILE_OS.has(os) || device.type === 'mobile' || device.type === 'tablet';
  const c = device.claims || null;
  // An iPad (iPadOS 13+) deliberately presents itself as a Mac: a Macintosh user
  // agent and navigator.platform "MacIntel", but with a touchscreen. That is the
  // browser's own design, not a lie (Anaya's iPad, 13 Oct: three honest runs voided).
  // A real Mac reports 0 touch points.
  const ipad = !!(c && c.plat === 'MacIntel' && Number.isFinite(c.tp) && c.tp > 1);
  // Any tablet, not only an iPad, may be driven with a trackpad or mouse: an
  // iPad with a Magic Keyboard, a Samsung tablet in a keyboard cover or in DeX.
  // Every phone and tablet plays (founder, 13 Oct 2026); only a computer is
  // the thing these checks exist to catch.
  const chMobile = c && c.ch && typeof c.ch === 'object' ? c.ch.mobile : null;
  const tablet = ipad || device.type === 'tablet' || (os === 'Android' && chMobile === '?0');
  if (c) {
    if (claimsMobile && Number.isFinite(c.tp) && c.tp === 0) out.push(`claims ${os || 'a phone'} but reports 0 touch points`);
    if (os === 'iOS' && c.uad) out.push('claims iOS but exposes userAgentData (no iOS browser has it)');
    if (claimsMobile && !ipad && typeof c.plat === 'string' && DESKTOP_PLATFORMS.test(c.plat)) out.push(`claims ${os || 'a phone'} but navigator.platform is ${c.plat}`);
    if (os === 'iOS' && c.gl && typeof c.gl.r === 'string' && c.gl.r && !/apple/i.test(c.gl.r) && !/webkit/i.test(c.gl.r)) out.push(`claims iOS but the GPU is "${String(c.gl.r).slice(0, 40)}"`);
    if (claimsMobile && !tablet && c.hover === 'hover' && c.pointer === 'fine') out.push(`claims ${os || 'a phone'} but the primary pointer is a fine hovering pointer (a mouse)`);
    if (c.electron === true) out.push('the page runs inside Electron');
    if (c.wd === true) out.push('the browser reports it is automated (navigator.webdriver)');
    if (typeof c.ua === 'string' && /HeadlessChrome|PhantomJS|SlimerJS/i.test(c.ua)) out.push('the browser is headless');
    // Client Hints (read by the server from the request headers). Every iOS
    // browser is WebKit and sends none; Android Chrome sends them and they
    // agree with the claim. A mismatch is the network layer contradicting
    // the user agent string.
    const ch = c.ch && typeof c.ch === 'object' ? c.ch : null;
    if (ch) {
      if (os === 'iOS' && (ch.ua || ch.platform || ch.mobile)) out.push('claims iOS but the request carried Chromium Client Hints (no iOS browser sends them)');
      if (claimsMobile && typeof ch.platform === 'string' && /^(Windows|macOS|Linux|Chrome OS|Chromium OS)$/i.test(ch.platform)) out.push(`claims ${os || 'a phone'} but Client Hints say the platform is ${ch.platform}`);
    }
    // Screen (CSS pixels, physical screen, never the viewport: inside the
    // game modal the viewport is the iframe). No iPhone reports more than
    // 932 in either dimension; iPads present a Mac user agent and are a
    // desktop claim; Android tablets are excluded by type.
    if (os === 'iOS' && device.type !== 'tablet' && Number.isFinite(c.sw) && Number.isFinite(c.sh) && Math.max(c.sw, c.sh) > 1100) out.push(`claims iPhone but the screen is ${c.sw}x${c.sh}`);
  }
  // A genuine client always sends the snapshot and the summary (the SDK is
  // always the latest build). From the cutover on, a run with inputs and NO
  // provenance at all did not come through our client.
  // "No snapshot" means no SDK fields; server-added Client Hints do not count as one.
  const sdkSnapshot = !!(c && (c.tp !== undefined || c.plat !== undefined || c.gl !== undefined || c.wd !== undefined));
  if (device.provenanceRequired && !sdkSnapshot && !(features && Number.isFinite(features.provN)) && features && (features.inputs || 0) >= 10) {
    out.push('no device snapshot and no input provenance from a client that must send both');
  }
  if (features && Number.isFinite(features.provN) && features.provN >= 10) {
    if (claimsMobile && !tablet && (features.provMouseFrac || 0) >= 0.9 && (features.provTouchEv || 0) === 0) out.push(`claims ${os || 'a phone'} but every input was a mouse event and no touch event was seen`);
    // Every honest run ever recorded (1,933 across 12 games, 22 Sep 2026) has
    // exactly zero synthetic inputs. The line was 50% and a bot author sat at
    // 40% by mixing real events in; it is a share AND a count now, so one
    // stray event on a short run decides nothing.
    const untrustedN = Math.round((features.provUntrustedFrac || 0) * features.provN);
    if ((features.provUntrustedFrac || 0) >= UNTRUSTED_FRAC && untrustedN >= UNTRUSTED_MIN_N) out.push(`${Math.round(features.provUntrustedFrac * 100)}% of inputs were synthetic (isTrusted false)`);
    // A button cannot be pressed and released by a hand in a few
    // milliseconds. Honest mean holds: 60 to 135 ms on tap games, 27 ms at the
    // lowest (fast mouse taps), hundreds on hold and drag games. An OS-level
    // auto-clicker sends TRUSTED events with holds of 0 to 10 ms. Pointer
    // presses only: the SDK does not time keys.
    const trustedN = features.provN - untrustedN;
    if (Number.isFinite(features.provHoldMean) && features.provHoldMean < HOLD_FLOOR_MS && trustedN >= HOLD_MIN_N) out.push(`presses were held ${features.provHoldMean} ms on average (no hand releases that fast)`);
  }
  return out;
}

function personalScore(x, acc, dir, minRuns) {
  if (!acc || acc.n < minRuns || x === null || !Number.isFinite(x)) return { score: 0, z: null };
  let s = welfordSd(acc);
  if (s === null) return { score: 0, z: null };
  s = Math.max(s, Math.abs(acc.mean) * 0.15, 1e-9); // never divide by a vanishing sd
  const z = (x - acc.mean) / s;
  let dev;
  if (dir === 'low') dev = -z;
  else if (dir === 'high') dev = z;
  else dev = Math.abs(z);
  // 3 sd is ordinary variation for a human; 6 sd is a different hand.
  return { score: clamp01((dev - 3) / 3), z };
}

/**
 * judge({ gameId, features, envelope, baseline, config })
 *   envelope  { feature: {n, min, p1, p5, ..., p95, p99, max} } for this game
 *   baseline  { n, stats: { feature: {n, mean, m2} } } for this player + game, or null
 */
function judge({ gameId, features, envelope, baseline, config, device }) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const signals = [];
  const groups = {};
  const envN = envelope && envelope.__n ? envelope.__n : (envelope && envelope.gapCv ? envelope.gapCv.n : 0);
  // Provenance contradictions are decisive whatever the score, whatever the
  // envelope, however short the run: a device that lies about what it is
  // has answered the question.
  const contradictions = deviceContradictions(device, features);
  if (contradictions.length) {
    for (const text of contradictions) signals.push({ feature: 'device', group: 'provenance', label: 'device contradiction', value: text, score: 1, dir: 'high' });
    return { confidence: DECISIVE_CONF, tier: cfg.autoThreshold <= DECISIVE_CONF ? 'bot' : 'suspicious', decisive: contradictions, contradictions, signals, groups: { provenance: 1 }, envelopeRuns: envN, baselineRuns: baseline ? baseline.n : 0 };
  }
  if (!envelope || envN < cfg.envelopeMinRuns) {
    return { confidence: null, tier: 'unjudged', reason: `envelope has ${envN} runs, needs ${cfg.envelopeMinRuns}`, signals, groups, envelopeRuns: envN };
  }
  // A handful of inputs is not a rhythm. Short runs are recorded and folded
  // into the baseline but never judged, unless one of them is physically
  // impossible, which needs no sample at all.
  const floorMs = PHYSICAL_FLOOR_MS[gameId];
  const impossibleNow = !!(floorMs && Number.isFinite(features.gapMin) && features.gapMin < floorMs);
  if ((features.inputs || 0) < cfg.minInputs && !impossibleNow) {
    return { confidence: null, tier: 'unjudged', reason: `${features.inputs || 0} inputs, needs ${cfg.minInputs}`, signals, groups, envelopeRuns: envN };
  }
  // Nor is a few seconds of play. A steering game has no input span, so its
  // session length stands in.
  const span = Number.isFinite(features.spanSec) ? features.spanSec : features.elapsedSec;
  if (Number.isFinite(span) && span < cfg.minSpanSec && !impossibleNow) {
    return { confidence: null, tier: 'unjudged', reason: `${span} s of play, needs ${cfg.minSpanSec}`, signals, groups, envelopeRuns: envN };
  }
  const decisive = [];
  const candidates = [];
  const specs = Object.assign({}, FEATURE_SPEC, GAME_FEATURE_SPEC[gameId] || {});
  for (const [feat, spec] of Object.entries(specs)) {
    const x = features[feat];
    const env = envelope[feat];
    if (x === null || x === undefined || !env) continue;
    if (spec.minInputs && (features.inputs || 0) < spec.minInputs) continue;
    // Endurance is heavy-tailed (the longest honest run is a few times the
    // p95), so it is scored on a RATIO: 0 up to the honest p99, 0.5 at 1.5x
    // it, 1 at 2x. The known bots ran 3x the longest human run ever seen.
    const score = spec.group === 'endurance' ? endurance(x, env) : extremeness(x, env, spec.dir);
    // Decisive needs BOTH a multiple of the p99 and a GAP above the longest
    // honest runs (1.5x the p99.9): a bot leaves a gap, a continuous human
    // tail does not.
    if (spec.decisiveMul && spec.dir !== 'low') {
      const ref = tailRef(env);
      // A heavy-tailed measure (run length) also needs a multiple of the p99,
      // or the single longest honest run can sit 1.5x above the second.
      const p99ok = !spec.decisiveP99 || (env.p99 > 0 && x >= spec.decisiveP99 * env.p99);
      if (ref && ref > 0 && x >= spec.decisiveMul * ref && p99ok) {
        // NO SINGLE MEASURE SETTLES A VERDICT (founder, 21 Sep 2026). "Longer, more
        // accurate or more efficient than the honest 1-in-1000 run" is also what
        // the best honest player looks like: buggy's 611 on Boom Patakha was
        // removed for run length alone, with a human rhythm on a real machine.
        // Every such finding is a CANDIDATE and is weighed below.
        candidates.push({ line: `${spec.label} ${x} is ${(x / ref).toFixed(2)}x the honest 1-in-1000 run (${ref})`, feat, spec, x, edge: ref, extreme: spec.decisiveMul * ref, dir: 'high', far: x >= DECISIVE_ALONE_MUL * ref });
      }
    }
    if (spec.decisiveMul && spec.dir === 'low') {
      const ref = pick(env, ['p001', 'p1', 'min']);
      if (ref && ref > 0 && x <= ref / spec.decisiveMul) {
        candidates.push({ line: `${spec.label} ${x} is under ${(ref / x).toFixed(2)}x below the honest 1-in-1000 run (${ref})`, feat, spec, x, edge: ref, extreme: ref / spec.decisiveMul, dir: 'low', far: x <= ref / DECISIVE_ALONE_MUL });
      }
    }
    if (score > 0) {
      const low = spec.dir === 'low' || (spec.dir === 'both' && x < env.p50);
      signals.push({ feature: feat, group: spec.group, label: spec.label, value: x, score: Math.round(score * 1000) / 1000, edge: low ? env.p5 : env.p95, extreme: low ? pick(env, ['p001', 'p1', 'min']) : pick(env, ['p999', 'p99', 'max']), dir: spec.dir });
      groups[spec.group] = Math.max(groups[spec.group] || 0, score);
    }
  }
  if (baseline && baseline.stats) {
    for (const [feat, spec] of Object.entries(PERSONAL_SPEC)) {
      const x = features[feat];
      const acc = baseline.stats[feat];
      const { score, z } = personalScore(x, acc, spec.dir, cfg.baselineMinRuns);
      if (score > 0) {
        signals.push({ feature: feat, group: 'personal', label: spec.label, value: x, score: Math.round(score * 1000) / 1000, z: Math.round(z * 100) / 100, own: { n: acc.n, mean: Math.round(acc.mean * 1000) / 1000 }, dir: spec.dir });
        groups.personal = Math.max(groups.personal || 0, score);
      }
    }
  }
  // A candidate stands when the run ALSO looks unlike a person some other way:
  // a SECOND measure past every honest run (snk's Sky Tower bot: perfect rate,
  // perfect streak and points per drop together, behind a human-looking rhythm),
  // or another population group at
  // DECISIVE_CORROBORATION or more, or when it is DECISIVE_ALONE_MUL times past
  // the longest honest runs (the Orbit Runner bot's 2,146 launches were 26x).
  // Alone, it stays an ordinary signal in its group: at most 55, under the hold
  // line, and shown to the reviewer as uncorroborated.
  for (const c of candidates) {
    const otherGroup = Math.max(0, ...Object.entries(groups).filter(([g]) => g !== c.spec.group && g !== 'personal').map(([, v]) => v));
    const otherCandidate = candidates.some((o) => o.feat !== c.feat);
    if (c.far || otherCandidate || otherGroup >= DECISIVE_CORROBORATION) {
      decisive.push(c.line);
      signals.push({ feature: c.feat, group: 'decisive', label: c.spec.label, value: c.x, score: 1, edge: c.edge, extreme: c.extreme, dir: c.dir });
    } else {
      signals.push({ feature: c.feat, group: 'uncorroborated', label: `${c.spec.label} (beyond every honest run, nothing else unusual)`, value: c.x, score: 0, edge: c.edge, extreme: c.extreme, dir: c.dir });
    }
  }
  let impossible = null;
  const floor = PHYSICAL_FLOOR_MS[gameId];
  if (floor && Number.isFinite(features.gapMin) && features.gapMin < floor) {
    impossible = `input gap ${features.gapMin} ms is below the physical floor of ${floor} ms`;
    signals.push({ feature: 'gapMin', group: 'impossible', label: 'below physical floor', value: features.gapMin, score: 1, edge: floor, dir: 'low' });
  }
  // Population groups carry the verdict; the personal group is capped and
  // can only ever fill the second or third slot, so a player's own hot
  // streak against their own past cannot be the main evidence.
  const personal = Math.min(PERSONAL_CAP, groups.personal || 0);
  const ranked = Object.entries(groups).filter(([g]) => g !== 'personal').map(([, v]) => v).sort((a, b) => b - a);
  const r1 = ranked[0] || 0, r2 = ranked[1] || 0, r3 = ranked[2] || 0;
  const slot2 = Math.max(r2, personal);
  const slot3 = r2 >= personal ? Math.max(r3, personal) : r3;
  let conf = Math.round(100 * (WEIGHTS[0] * r1 + WEIGHTS[1] * slot2 + WEIGHTS[2] * slot3));
  if (impossible) conf = Math.max(conf, DECISIVE_CONF);
  if (decisive.length) conf = Math.max(conf, DECISIVE_CONF);
  const tier = conf >= cfg.autoThreshold ? 'bot' : conf >= cfg.holdThreshold ? 'suspicious' : 'normal';
  signals.sort((a, b) => b.score - a.score);
  return { confidence: conf, tier, impossible, decisive: decisive.length ? decisive : null, contradictions: null, signals, groups, envelopeRuns: envN, baselineRuns: baseline ? baseline.n : 0 };
}

module.exports = { judge, extremeness, endurance, deviceContradictions, DECISIVE_CONF, DECISIVE_CORROBORATION, DECISIVE_ALONE_MUL, FEATURE_SPEC, GAME_FEATURE_SPEC, PERSONAL_SPEC, BASELINE_FEATURES, PHYSICAL_FLOOR_MS, PERSONAL_CAP, DEFAULTS, WEIGHTS };
