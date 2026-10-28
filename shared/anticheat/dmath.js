/*
 * dmath — DETERMINISTIC trigonometry for replayed gameplay.
 *
 * Math.sin / Math.cos / Math.atan2 / Math.pow are NOT the same function in
 * every JavaScript engine. They are correctly rounded nowhere and each engine
 * ships its own approximation: V8's changed between Node 20 (V8 11.3) and
 * Chrome 152 (V8 15.2) — measured on 20,000 inputs, atan2 differs on 18% of
 * them, sin and cos on 3%, pow on 10%, all by one ulp — and Safari's JavaScriptCore
 * uses the platform libm, which differs from both.
 *
 * One ulp is 4e-16. On 9 Sep 2026 that was the whole difference between a
 * player's 52 on Orbit Runner and the server's 39: every planet capture snaps
 * the rocket's angle from atan2 of its flight position, so nothing damps the
 * error and it compounds across captures until a ring that was 0.0016 units
 * inside the window on the phone was 0.0016 outside it on the server. The
 * player was flagged for cheating. A replayed physics game must therefore
 * never call the engine's transcendental functions on its gameplay path.
 *
 * This file is a port of fdlibm's sin, cos, atan and atan2 (Sun Microsystems,
 * 1993, the reference implementation most engines started from). It uses
 * only +, -, *, /, sqrt and integer bit operations, every one of which IEEE
 * 754 requires to be correctly rounded, so the result is the same bits on
 * every conforming engine. hypot is sqrt(x*x + y*y) for the same reason: the
 * native one is a scaling loop whose rounding is implementation-defined.
 *
 * ⚠ THE SAME BYTES RUN ON BOTH SIDES. shared/anticheat/dmath.js is the
 * canonical copy (the server requires it); games/_shared/dmath.js is the
 * copy the browser loads. shared/tests/dmath.test.js fails if they differ,
 * and pins the exact output bits for a fixed input set so an edit to the
 * arithmetic cannot land unnoticed — a change here is a PROTOCOL change for
 * every game that uses it, and needs a trace version bump.
 *
 * Range: argument reduction is fdlibm's medium path, exact for |x| below
 * 2^20 * pi/2 (~1,647,099 rad; verified bit-identical to V8 up to 8e5 on
 * 200,000 inputs). Beyond that it THROWS rather than fall back to the
 * engine's Math, because "usually deterministic" is the bug this file exists
 * to remove. Orbit Runner's largest possible angle inside a 60-minute session
 * is ~17,500 rad (4.85 rad/s for 3,600 s), ninety times below the limit.
 *
 * UMD on purpose: `module.exports` under Node, `window.DMath` in a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMath = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var f64 = new Float64Array(1);
  var u32 = new Uint32Array(f64.buffer);
  f64[0] = 1.0;
  var HI = u32[1] === 0x3ff00000 ? 1 : 0;   // word order of this machine
  var LO = 1 - HI;
  function hiWord(x) { f64[0] = x; return u32[HI] | 0; }     // signed int32
  function loWord(x) { f64[0] = x; return u32[LO] >>> 0; }
  function fromWords(h, l) { u32[HI] = h >>> 0; u32[LO] = l >>> 0; return f64[0]; }

  var one = 1.0, half = 0.5, zero = 0.0;

  // ── k_sin / k_cos: kernels on |x| <= pi/4 ─────────────────────────────
  var S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
      S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
      S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  function kSin(x, y, iy) {
    var ix = hiWord(x) & 0x7fffffff;
    if (ix < 0x3e400000) return x;                    // |x| < 2^-27
    var z = x * x, v = z * x;
    var r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if (iy === 0) return x + v * (S1 + z * r);
    return x - ((z * (half * y - v * r) - y) - v * S1);
  }

  var C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
      C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
      C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  function kCos(x, y) {
    var ix = hiWord(x) & 0x7fffffff;
    if (ix < 0x3e400000) return one;                  // |x| < 2^-27
    var z = x * x;
    var r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if (ix < 0x3FD33333) return one - (half * z - (z * r - x * y));   // |x| < 0.3
    var qx;
    if (ix > 0x3fe90000) qx = 0.28125;                // |x| > 0.78125
    else qx = fromWords(ix - 0x00200000, 0);          // x/4
    var hz = half * z - qx;
    var a = one - qx;
    return a - (hz - (z * r - x * y));
  }

  // ── rem_pio2: x = n*(pi/2) + (y0 + y1), medium path only ──────────────
  var npio2_hw = [
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C,
    0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C,
    0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A,
    0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
    0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB,
    0x404858EB, 0x404921FB,
  ];
  var invpio2 = 6.36619772367581382433e-01,
      pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11,
      pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21,
      pio2_3 = 2.02226624871116645580e-21, pio2_3t = 8.47842766036889956997e-32;
  var MAX_REDUCIBLE_HI = 0x413921fb;                  // |x| <= 2^20 * pi/2
  var y = [0, 0];

  function remPio2(x) {
    var hx = hiWord(x), ix = hx & 0x7fffffff, z, t, w, r, n, fn, i, j;
    if (ix <= 0x3fe921fb) { y[0] = x; y[1] = zero; return 0; }        // |x| <= pi/4
    if (ix < 0x4002d97c) {                                            // |x| < 3pi/4
      if (hx > 0) {
        z = x - pio2_1;
        if (ix !== 0x3ff921fb) { y[0] = z - pio2_1t; y[1] = (z - y[0]) - pio2_1t; }
        else { z -= pio2_2; y[0] = z - pio2_2t; y[1] = (z - y[0]) - pio2_2t; }
        return 1;
      }
      z = x + pio2_1;
      if (ix !== 0x3ff921fb) { y[0] = z + pio2_1t; y[1] = (z - y[0]) + pio2_1t; }
      else { z += pio2_2; y[0] = z + pio2_2t; y[1] = (z - y[0]) + pio2_2t; }
      return -1;
    }
    if (ix <= MAX_REDUCIBLE_HI) {
      t = x < 0 ? -x : x;
      n = (t * invpio2 + half) | 0;
      fn = n;
      r = t - fn * pio2_1;
      w = fn * pio2_1t;
      if (n < 32 && ix !== npio2_hw[n - 1]) {
        y[0] = r - w;
      } else {
        j = ix >> 20;
        y[0] = r - w;
        i = j - ((hiWord(y[0]) >> 20) & 0x7ff);
        if (i > 16) {                                   // 2nd iteration, good to 118 bits
          t = r;
          w = fn * pio2_2;
          r = t - w;
          w = fn * pio2_2t - ((t - r) - w);
          y[0] = r - w;
          i = j - ((hiWord(y[0]) >> 20) & 0x7ff);
          if (i > 49) {                                 // 3rd iteration, 151 bits
            t = r;
            w = fn * pio2_3;
            r = t - w;
            w = fn * pio2_3t - ((t - r) - w);
            y[0] = r - w;
          }
        }
      }
      y[1] = (r - y[0]) - w;
      if (hx < 0) { y[0] = -y[0]; y[1] = -y[1]; return -n; }
      return n;
    }
    throw new RangeError('DMath: |x| > 2^20*pi/2 is outside the deterministic range (' + x + ')');
  }

  function sin(x) {
    var ix = hiWord(x) & 0x7fffffff;
    if (ix <= 0x3fe921fb) return kSin(x, zero, 0);
    if (ix >= 0x7ff00000) return x - x;                // Inf or NaN
    var n = remPio2(x);
    switch (n & 3) {
      case 0: return kSin(y[0], y[1], 1);
      case 1: return kCos(y[0], y[1]);
      case 2: return -kSin(y[0], y[1], 1);
      default: return -kCos(y[0], y[1]);
    }
  }

  function cos(x) {
    var ix = hiWord(x) & 0x7fffffff;
    if (ix <= 0x3fe921fb) return kCos(x, zero);
    if (ix >= 0x7ff00000) return x - x;
    var n = remPio2(x);
    switch (n & 3) {
      case 0: return kCos(y[0], y[1]);
      case 1: return -kSin(y[0], y[1], 1);
      case 2: return -kCos(y[0], y[1]);
      default: return kSin(y[0], y[1], 1);
    }
  }

  // ── atan / atan2 ──────────────────────────────────────────────────────
  var atanhi = [4.63647609000806093515e-01, 7.85398163397448278999e-01,
                9.82793723247329054082e-01, 1.57079632679489655800e+00];
  var atanlo = [2.26987774529616870924e-17, 3.06161699786838301793e-17,
                1.39033110312309984516e-17, 6.12323399573676603587e-17];
  var aT = [3.33333333333329318027e-01, -1.99999999998764832476e-01,
            1.42857142725034663711e-01, -1.11111104054623557880e-01,
            9.09088713343650656196e-02, -7.69187620504482999495e-02,
            6.66107313738753120669e-02, -5.83357013379057348645e-02,
            4.97687799461593236017e-02, -3.65315727442169155270e-02,
            1.62858201153657823623e-02];
  var huge = 1.0e300;

  function atan(x) {
    var hx = hiWord(x), ix = hx & 0x7fffffff, id, z, w, s1, s2;
    if (ix >= 0x44100000) {                           // |x| >= 2^66
      if (ix > 0x7ff00000 || (ix === 0x7ff00000 && loWord(x) !== 0)) return x + x;   // NaN
      return hx > 0 ? atanhi[3] + atanlo[3] : -atanhi[3] - atanlo[3];
    }
    if (ix < 0x3fdc0000) {                            // |x| < 0.4375
      if (ix < 0x3e200000) {                          // |x| < 2^-29
        if (huge + x > one) return x;
      }
      id = -1;
    } else {
      x = x < 0 ? -x : x;
      if (ix < 0x3ff30000) {                          // |x| < 1.1875
        if (ix < 0x3fe60000) { id = 0; x = (2.0 * x - one) / (2.0 + x); }      // 7/16 <= |x| < 11/16
        else { id = 1; x = (x - one) / (x + one); }                            // 11/16 <= |x| < 19/16
      } else {
        if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (one + 1.5 * x); }      // |x| < 2.4375
        else { id = 3; x = -1.0 / x; }
      }
    }
    z = x * x;
    w = z * z;
    s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
    s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
    if (id < 0) return x - x * (s1 + s2);
    z = atanhi[id] - ((x * (s1 + s2) - atanlo[id]) - x);
    return hx < 0 ? -z : z;
  }

  var tiny = 1.0e-300,
      pi_o_4 = 7.8539816339744827900e-01, pi_o_2 = 1.5707963267948965580e+00,
      pi = 3.1415926535897931160e+00, pi_lo = 1.2246467991473531772e-16;

  function atan2(yv, x) {
    var hx = hiWord(x), ix = hx & 0x7fffffff, lx = loWord(x);
    var hy = hiWord(yv), iy = hy & 0x7fffffff, ly = loWord(yv);
    var k, z, m;
    if (((ix | ((lx | -lx) >>> 31)) > 0x7ff00000) || ((iy | ((ly | -ly) >>> 31)) > 0x7ff00000)) return x + yv;   // NaN
    if (((hx - 0x3ff00000) | lx) === 0) return atan(yv);                 // x == 1
    m = ((hy >> 31) & 1) | ((hx >> 30) & 2);                              // 2*sign(x) + sign(y)
    if ((iy | ly) === 0) {                                                // y == 0
      switch (m) {
        case 0: case 1: return yv;                                        // atan(+-0, +anything) = +-0
        case 2: return pi + tiny;                                         // atan(+0, -anything) = pi
        default: return -pi - tiny;                                       // atan(-0, -anything) = -pi
      }
    }
    if ((ix | lx) === 0) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;  // x == 0
    if (ix === 0x7ff00000) {                                              // x is +-Inf
      if (iy === 0x7ff00000) {
        switch (m) {
          case 0: return pi_o_4 + tiny;
          case 1: return -pi_o_4 - tiny;
          case 2: return 3.0 * pi_o_4 + tiny;
          default: return -3.0 * pi_o_4 - tiny;
        }
      }
      switch (m) {
        case 0: return zero;
        case 1: return -zero;
        case 2: return pi + tiny;
        default: return -pi - tiny;
      }
    }
    if (iy === 0x7ff00000) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;   // y is +-Inf
    k = (iy - ix) >> 20;
    if (k > 60) z = pi_o_2 + half * pi_lo;                                // |y/x| > 2^60
    else if (hx < 0 && k < -60) z = zero;                                 // |y|/x < -2^60
    else z = atan((yv < 0 ? -yv : yv) / (x < 0 ? -x : x));
    switch (m) {
      case 0: return z;
      case 1: return -z;
      case 2: return pi - (z - pi_lo);
      default: return (z - pi_lo) - pi;
    }
  }

  function hypot(a, b) { return Math.sqrt(a * a + b * b); }
  // x^3 as two multiplications: exact IEEE operations, so the same bits
  // everywhere. Math.pow(x, 3) is NOT — V8 11 and V8 15 disagree on 10% of
  // inputs — which is why Pulse's easing is a v3 change.
  function cube(x) { return x * x * x; }

  // The ENGINE's own functions, under the same names, for replaying a trace
  // that was played before dmath existed (a v2 trace). A validator picks
  // DMath or NATIVE from the trace's version marker and never mixes them.
  var NATIVE = {
    sin: Math.sin, cos: Math.cos, atan: Math.atan, atan2: Math.atan2, hypot: Math.hypot,
    cube: function (x) { return Math.pow(x, 3); },
  };

  return { sin: sin, cos: cos, atan: atan, atan2: atan2, hypot: hypot, cube: cube,
           NATIVE: NATIVE, MAX_ARG: 1647099 };
}));
