/**
 * ONE PHYSICAL PRESS IS ONE INPUT (11 Sep 2026).
 *
 * Players were scoring +4 or +5 on a single tap in Pulse and Patli Gali by
 * slapping the screen with several fingers, and +2 on desktop by pressing
 * Space and clicking at the same moment. Each finger, key and button was its
 * own event, and each one landed on a different frame, so each one scored.
 *
 * The rule here: a press counts only when NOTHING else is already held. Five
 * fingers landing together are one press; Space held while the mouse clicks is
 * one press. Releasing everything and pressing again is a new press, which is
 * exactly what a fast honest player does.
 *
 * It must never lock a game, so every way a release can go missing heals:
 *   - a mouse cannot be pressed twice, so a new mouse press clears a stale one,
 *     and a mouse move with no button down clears it too;
 *   - a touchend with no fingers left clears every touch;
 *   - blur, pagehide and a hidden tab clear everything;
 *   - anything held longer than STALE_MS is forgotten.
 *
 * This is a CLIENT rule. The server never sees the presses it drops, only the
 * inputs the game emits, so it changes no trace and needs no protocol version.
 *
 *   KJPress.bind(onPress, { keys: ['Space'], ignore: (event) => boolean })
 *
 * `overlapMs` (optional, off by default): a press that lands while another is
 * still held COUNTS if the last counted press was at least overlapMs ago. For
 * two-thumb games (Gannay Wala) where a fast player lands the next thumb before
 * the last one lifts; fingers slapped down together (within overlapMs) are still
 * one press.
 *
 * `ignore` runs before a press is recorded, so an ignored press (a tap on a
 * HOW TO PLAY button, say) neither fires nor blocks the next one.
 */
(function () {
  var STALE_MS = 1000;

  function now() {
    try { return performance.now(); } catch (e) { return Date.now(); }
  }

  function bind(onPress, opts) {
    opts = opts || {};
    var keys = opts.keys || ['Space'];
    var ignore = typeof opts.ignore === 'function' ? opts.ignore : null;
    var held = {};   // id -> time it went down
    var overlapMs = typeof opts.overlapMs === 'number' && opts.overlapMs > 0 ? opts.overlapMs : 0;
    var lastPress = -Infinity;

    function prune(t) {
      for (var id in held) if (t - held[id] > STALE_MS) delete held[id];
    }
    function isIdle() {
      for (var id in held) return false;
      return true;
    }
    function down(id, e) {
      var t = now();
      prune(t);
      if (held[id] !== undefined) return;   // already down: not a new press
      var idle = isIdle();
      held[id] = t;
      if (idle || (overlapMs && t - lastPress >= overlapMs)) { lastPress = t; onPress(e); }
    }
    function up(id) { delete held[id]; }
    function dropTouches() { for (var id in held) if (id.charAt(0) === 'p') delete held[id]; }
    function clear() { held = {}; }
    function pointerKey(e) { return e.pointerType === 'mouse' ? 'mouse' : 'p' + e.pointerId; }

    window.addEventListener('pointerdown', function (e) {
      if (ignore && ignore(e)) return;
      if (e.pointerType === 'mouse') up('mouse');   // a mouse cannot be down twice
      down(pointerKey(e), e);
    });
    window.addEventListener('pointerup', function (e) { up(pointerKey(e)); });
    window.addEventListener('pointercancel', function (e) { up(pointerKey(e)); });
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'mouse' && e.buttons === 0) up('mouse');
    });
    var touchGone = function (e) { if (e && e.touches && e.touches.length === 0) dropTouches(); };
    window.addEventListener('touchend', touchGone, { passive: true });
    window.addEventListener('touchcancel', touchGone, { passive: true });

    window.addEventListener('keydown', function (e) {
      if (keys.indexOf(e.code) < 0) return;
      if (e.preventDefault) e.preventDefault();
      if (e.repeat) return;                          // auto-repeat is not a press
      if (ignore && ignore(e)) return;
      down('k' + e.code, e);
    });
    window.addEventListener('keyup', function (e) {
      if (keys.indexOf(e.code) >= 0) up('k' + e.code);
    });

    window.addEventListener('blur', clear);
    window.addEventListener('pagehide', clear);
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') clear();
      });
    } catch (e) { /* no document: nothing to watch */ }

    return { reset: clear };
  }

  window.KJPress = { bind: bind, STALE_MS: STALE_MS };
})();
