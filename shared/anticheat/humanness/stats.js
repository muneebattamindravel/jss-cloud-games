'use strict';

/**
 * Small, dependency-free statistics for the humanness fingerprint.
 *
 * Everything here is plain arithmetic on arrays of numbers. Quantiles use
 * linear interpolation on the sorted sample (the R-7 definition), which is
 * what most spreadsheet software does, so the admin graphs and a hand check
 * in Excel agree.
 */

function round(x, dp = 4) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const m = Math.pow(10, dp);
  return Math.round(x * m) / m;
}

function mean(a) {
  if (!a.length) return null;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

function sd(a, m) {
  if (a.length < 2) return null;
  const mu = m === undefined ? mean(a) : m;
  let s = 0;
  for (const v of a) s += (v - mu) * (v - mu);
  return Math.sqrt(s / a.length);
}

function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return quantile(s, 0.5);
}

/**
 * Describe a sample of gaps (or holds, or any positive measure):
 *   n, mean, sd, cv (sd / mean), min, p10, median,
 *   madRel (median absolute deviation / median: a robust cv that a few
 *           long pauses cannot inflate),
 *   tight  (fraction of values within +/- 8% of the median: the share of
 *           inputs that landed on the beat).
 * Returns null under `minN` samples: a distribution needs a sample.
 */
function describeGaps(a, minN = 6) {
  const vals = a.filter((v) => Number.isFinite(v) && v >= 0);
  if (vals.length < minN) return null;
  const sorted = vals.slice().sort((x, y) => x - y);
  const mu = mean(vals);
  const s = sd(vals, mu);
  const med = quantile(sorted, 0.5);
  const dev = vals.map((v) => Math.abs(v - med)).sort((x, y) => x - y);
  const mad = quantile(dev, 0.5);
  let tight = 0;
  if (med > 0) for (const v of vals) if (Math.abs(v - med) <= 0.08 * med) tight += 1;
  return {
    n: vals.length,
    mean: round(mu, 3),
    sd: round(s, 3),
    cv: mu > 0 ? round(s / mu, 4) : null,
    min: round(sorted[0], 3),
    p10: round(quantile(sorted, 0.1), 3),
    median: round(med, 3),
    madRel: med > 0 ? round(mad / med, 4) : null,
    tight: round(tight / vals.length, 4),
  };
}

/**
 * The quantile envelope of one feature over a population of runs.
 * `values` is the feature across honest runs (nulls dropped).
 */
function envelopeOf(values) {
  const vals = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (!vals.length) return null;
  const s = vals.slice().sort((x, y) => x - y);
  return {
    n: s.length,
    min: round(s[0], 4),
    p001: round(quantile(s, 0.001), 4),
    p1: round(quantile(s, 0.01), 4),
    p5: round(quantile(s, 0.05), 4),
    p25: round(quantile(s, 0.25), 4),
    p50: round(quantile(s, 0.5), 4),
    p75: round(quantile(s, 0.75), 4),
    p95: round(quantile(s, 0.95), 4),
    p99: round(quantile(s, 0.99), 4),
    p999: round(quantile(s, 0.999), 4),
    max: round(s[s.length - 1], 4),
  };
}

/**
 * Welford running mean / variance, stored as {n, mean, m2} so a baseline
 * can be updated from one new value without re-reading history.
 */
function welfordAdd(acc, x) {
  const a = acc || { n: 0, mean: 0, m2: 0 };
  if (x === null || x === undefined || !Number.isFinite(x)) return a;
  const n = a.n + 1;
  const delta = x - a.mean;
  const m = a.mean + delta / n;
  const m2 = a.m2 + delta * (x - m);
  return { n, mean: m, m2 };
}

function welfordSd(acc) {
  if (!acc || acc.n < 2) return null;
  return Math.sqrt(acc.m2 / acc.n);
}

module.exports = { round, mean, sd, median, quantile, describeGaps, envelopeOf, welfordAdd, welfordSd };
