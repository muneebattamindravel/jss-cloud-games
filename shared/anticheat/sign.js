'use strict';

/**
 * Canonical message signing for the anti-cheat v2 protocol.
 *
 * The SAME module is loaded server-side by Node and (eventually) by the
 * browser SDK via the JS-fallback HMAC path in kj-sdk-v2.js. The string
 * format and serialization rules MUST produce identical bytes on both
 * sides, otherwise legitimate messages get rejected.
 *
 * Canonical message-to-sign:
 *   `${sessionId}|${seq}|${type}|${ts}|${stableStringify(payload)}`
 *
 * Then HMAC-SHA256 with the session secret (hex). Lowercase hex output.
 *
 * `stableStringify` MUST:
 *   - Sort object keys lexicographically at every level.
 *   - Produce no extra whitespace.
 *   - Use the same number-to-string semantics as JSON.stringify
 *     (which is what the browser will use).
 *   - Treat undefined values like JSON.stringify does (omitted).
 */

const crypto = require('crypto');

// ── Stable JSON ────────────────────────────────────────────────────

function stableStringify(value) {
  if (value === null) return 'null';
  if (value === undefined) return undefined; // signal: caller drops the key
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    const parts = value.map((v) => {
      const s = stableStringify(v);
      return s === undefined ? 'null' : s;
    });
    return `[${parts.join(',')}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const s = stableStringify(value[k]);
      if (s === undefined) continue; // mirror JSON.stringify semantics
      parts.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  }
  // functions, symbols, etc — drop
  return undefined;
}

// ── Canonical signing string ───────────────────────────────────────

function canonicalString({ sessionId, seq, type, ts, payload }) {
  const payloadStr = payload === undefined || payload === null
    ? 'null'
    : (stableStringify(payload) ?? 'null');
  return `${sessionId}|${seq}|${type}|${ts}|${payloadStr}`;
}

// ── HMAC ───────────────────────────────────────────────────────────

function computeMessageHmac({ sessionId, seq, type, ts, payload, sessionSecret }) {
  const data = canonicalString({ sessionId, seq, type, ts, payload });
  return crypto.createHmac('sha256', sessionSecret).update(data).digest('hex');
}

function verifyMessageHmac({ sessionId, seq, type, ts, payload, expectedHmac, sessionSecret }) {
  if (typeof expectedHmac !== 'string' || expectedHmac.length === 0) return false;
  let expected;
  try {
    expected = computeMessageHmac({ sessionId, seq, type, ts, payload, sessionSecret });
  } catch (_e) {
    return false;
  }
  if (expected.length !== expectedHmac.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(expectedHmac));
  } catch (_e) {
    return false;
  }
}

module.exports = {
  stableStringify,
  canonicalString,
  computeMessageHmac,
  verifyMessageHmac,
};
