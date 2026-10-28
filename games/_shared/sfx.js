/* KJ Platform — shared sound-effects helper.
 *
 * Pure Web Audio (no audio file deps), exposed as window.kjSfx so any game
 * can do `kjSfx.tap()`, `kjSfx.win()`, etc. AudioContext is created lazily
 * on the first user gesture so iOS/Safari don't block it.
 *
 * Include in a game with: <script src="/games/_shared/sfx.js"></script>
 */
(function () {
  'use strict';

  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) { window.kjSfx = noopSfx(); return; }

  var ctx = null;
  var muted = false;

  // Lazy-init on the first user gesture so Safari/iOS don't refuse to start.
  function ensureCtx() {
    if (!ctx) {
      try { ctx = new AudioCtx(); } catch (_) { return null; }
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(function () {});
    }
    return ctx;
  }

  // Read mute pref (so users can flip it via localStorage if they want)
  try { muted = localStorage.getItem('kj_sfx_muted') === '1'; } catch (_) {}

  // Core: play a single tone
  function tone(opts) {
    if (muted) return;
    var c = ensureCtx();
    if (!c) return;
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.freq, c.currentTime);
    if (opts.slideTo != null) {
      o.frequency.exponentialRampToValueAtTime(opts.slideTo, c.currentTime + (opts.duration || 0.15));
    }
    var vol = opts.vol != null ? opts.vol : 0.18;
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + (opts.duration || 0.15));
    o.connect(g); g.connect(c.destination);
    o.start();
    o.stop(c.currentTime + (opts.duration || 0.15) + 0.02);
  }

  // Sequence of tones with per-step delay
  function seq(steps) {
    if (muted) return;
    var t = 0;
    steps.forEach(function (s) {
      setTimeout(function () { tone(s); }, t);
      t += s.gap != null ? s.gap : ((s.duration || 0.15) * 1000 * 0.7);
    });
  }

  // Public preset library
  var sfx = {
    // Quick UI feedback
    tap:    function () { tone({ freq: 800,  duration: 0.04, type: 'square',   vol: 0.10 }); },
    pop:    function () { tone({ freq: 880,  duration: 0.08, type: 'square',   vol: 0.14 }); },
    select: function () { tone({ freq: 660,  duration: 0.06, type: 'triangle', vol: 0.12 }); },

    // Game events
    correct: function () {
      seq([
        { freq: 660, duration: 0.08, type: 'sine', vol: 0.16 },
        { freq: 880, duration: 0.10, type: 'sine', vol: 0.16 },
      ]);
    },
    wrong: function () {
      tone({ freq: 220, slideTo: 110, duration: 0.18, type: 'sawtooth', vol: 0.18 });
    },
    perfect: function () {
      seq([
        { freq: 523, duration: 0.06, type: 'triangle', vol: 0.18 },
        { freq: 659, duration: 0.06, type: 'triangle', vol: 0.18 },
        { freq: 784, duration: 0.06, type: 'triangle', vol: 0.18 },
        { freq: 1046, duration: 0.10, type: 'triangle', vol: 0.18 },
      ]);
    },
    streak: function () {
      seq([
        { freq: 523, duration: 0.05, type: 'sine', vol: 0.14 },
        { freq: 659, duration: 0.05, type: 'sine', vol: 0.14 },
        { freq: 784, duration: 0.05, type: 'sine', vol: 0.14 },
      ]);
    },

    // Big moments
    win: function () {
      seq([
        { freq: 523, duration: 0.10, type: 'square', vol: 0.20 },
        { freq: 659, duration: 0.10, type: 'square', vol: 0.20 },
        { freq: 784, duration: 0.10, type: 'square', vol: 0.20 },
        { freq: 1046, duration: 0.25, type: 'square', vol: 0.20 },
      ]);
    },
    lose: function () {
      seq([
        { freq: 392, duration: 0.15, type: 'sawtooth', vol: 0.18 },
        { freq: 311, duration: 0.18, type: 'sawtooth', vol: 0.18 },
        { freq: 233, duration: 0.30, type: 'sawtooth', vol: 0.18 },
      ]);
    },
    countdown: function () {
      tone({ freq: 440, duration: 0.10, type: 'sine', vol: 0.14 });
    },
    powerup: function () {
      tone({ freq: 200, slideTo: 1500, duration: 0.30, type: 'sawtooth', vol: 0.16 });
    },

    // Toggle
    setMuted: function (m) {
      muted = !!m;
      try { localStorage.setItem('kj_sfx_muted', muted ? '1' : '0'); } catch (_) {}
    },
    isMuted: function () { return muted; },
  };

  function noopSfx() {
    // No Web Audio support → silent no-ops so games don't crash.
    var noop = function () {};
    return {
      tap: noop, pop: noop, select: noop,
      correct: noop, wrong: noop, perfect: noop, streak: noop,
      win: noop, lose: noop, countdown: noop, powerup: noop,
      setMuted: noop, isMuted: function () { return true; },
    };
  }

  window.kjSfx = sfx;
})();
