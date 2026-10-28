/**
 * Global sound mute for embedded games.
 *
 * Settings → "Game sounds" writes localStorage.kj_sfx_muted ('1' = muted), but
 * no game reads it: each ships its own `new Audio(...)` / AudioContext. Rather
 * than patching a dozen bespoke audio layers, this intercepts the two Web Audio
 * entry points every game ultimately goes through.
 *
 * Include it as the FIRST script in a game's <head>, before any game code
 * constructs an AudioContext or an Audio element.
 *
 * ── Why this does NOT use ctx.suspend() ──────────────────────────────────
 * It used to, and it never once worked. Browser autoplay policy requires an
 * AudioContext created before a user gesture to be resumed after one, so all
 * thirteen games call ctx.resume() on the first tap. The shim suspended the
 * context at construction and the game resumed it moments later — every game
 * played sound with the toggle off, which is exactly what was reported.
 *
 * Muting has to survive the game doing ordinary, correct things to its own
 * audio graph. So the mute now sits in the GRAPH, not in the context's
 * transport state: `ctx.destination` is replaced with a master GainNode whose
 * gain is 0 while muted. Everything the game routes to the destination — every
 * oscillator, buffer source and node, however the game wires them — passes
 * through that gain first. resume() is then free to do its job.
 *
 * Also honours a live KJ_SET_MUTED postMessage so flipping the setting takes
 * effect in an already-open game, not just on the next load.
 */
(function () {
  'use strict';
  var KEY = 'kj_sfx_muted';

  function readMuted() {
    try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; }
  }
  var muted = readMuted();

  // Master gain per context, so a later toggle can reach every one of them.
  var masters = [];
  // Media elements the game has tried to play, so muting mid-play silences
  // audio that is ALREADY running rather than only the next sound.
  var mediaEls = [];

  var NativeAC = window.AudioContext || window.webkitAudioContext;

  if (NativeAC) {
    var Patched = function () {
      var ctx = new (Function.prototype.bind.apply(
        NativeAC, [null].concat(Array.prototype.slice.call(arguments))))();
      try {
        // Read the REAL destination before shadowing the property, or the
        // master would end up connected to itself.
        var realDest = ctx.destination;
        var master = ctx.createGain();
        master.gain.value = muted ? 0 : 1;
        master.connect(realDest);
        masters.push(master);
        // configurable so a game that defines its own is not fought with.
        Object.defineProperty(ctx, 'destination', {
          get: function () { return master; },
          configurable: true,
        });
      } catch (_) { /* exotic context — leave it alone rather than break audio */ }
      return ctx;
    };
    Patched.prototype = NativeAC.prototype;
    window.AudioContext = Patched;
    if (window.webkitAudioContext) window.webkitAudioContext = Patched;
  }

  // <audio> / new Audio(). Patch the prototype so elements created later are
  // covered too; `muted` is what the browser actually honours, and the play()
  // guard stops a muted game burning decode work on sounds nobody hears.
  var mediaPlay = window.HTMLMediaElement && window.HTMLMediaElement.prototype.play;
  if (mediaPlay) {
    window.HTMLMediaElement.prototype.play = function () {
      if (mediaEls.indexOf(this) === -1) mediaEls.push(this);
      if (muted) {
        try { this.muted = true; this.volume = 0; } catch (_) {}
        return Promise.resolve();
      }
      try { this.muted = false; } catch (_) {}
      return mediaPlay.apply(this, arguments);
    };
  }

  function apply(next) {
    muted = !!next;
    for (var i = 0; i < masters.length; i++) {
      try {
        // setTargetAtTime rather than a hard assignment: an instant jump to or
        // from zero on a live graph is an audible click.
        var g = masters[i];
        var now = g.context.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setTargetAtTime(muted ? 0 : 1, now, 0.015);
      } catch (_) {
        try { masters[i].gain.value = muted ? 0 : 1; } catch (__) {}
      }
    }
    for (var j = 0; j < mediaEls.length; j++) {
      try { mediaEls[j].muted = muted; } catch (_) {}
    }
  }

  // Live toggle from the parent app while the game is open.
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (d && d.type === 'KJ_SET_MUTED') apply(!!d.muted);
  });

  // Another tab changing the setting.
  window.addEventListener('storage', function (e) {
    if (e && e.key === KEY) apply(e.newValue === '1');
  });

  // Let the game (and anything debugging this) see the state.
  window.__kjMuted = function () { return muted; };
  window.__kjSetMuted = apply;
})();
