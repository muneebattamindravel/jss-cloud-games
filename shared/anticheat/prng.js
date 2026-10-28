'use strict';

/**
 * Mulberry32 — 32-bit deterministic PRNG.
 *
 * Identical bit-for-bit output in Node and the browser, so a server-side
 * validator and the client-side game can both reconstruct the same world
 * (planet positions, spawn pattern, etc.) from the same hex seed.
 *
 * Usage:
 *   const rand = mulberry32('a3f8b21c...'); // hex seed >= 8 chars
 *   rand(); // → [0, 1)
 *
 * We slice only the first 8 hex chars (32 bits) for the seed itself.
 * Game-specific subkeys can be derived by taking later slices of the
 * full 64-char session seed (e.g. seed.slice(8, 16) for a "bombs" stream).
 */

function mulberry32(seedHex) {
  if (typeof seedHex !== 'string' || seedHex.length < 8) {
    throw new Error('mulberry32: seed must be a hex string of length >= 8');
  }
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { mulberry32 };
