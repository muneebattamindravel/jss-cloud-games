/**
 * Shared "has this player seen the tutorial yet?" flag, scoped to the game's
 * current FEATURED ROTATION.
 *
 * Founder rule: the tutorial shows on a player's first launches of a game in
 * each featured rotation (twice since Oct 2026, see SHOWS below), not once
 * ever and not on every launch.
 *
 * The rotation comes from ?rot=<featured_games row id>, which the launcher puts
 * on the iframe URL. Re-featuring a game inserts a NEW featured_games row, so
 * the id changes on every rotation and is stable while the game stays live.
 *
 *   ?rot present  -> key is per-rotation; a new rotation shows the tutorial again
 *   ?rot absent   -> direct load, or a game that is not currently featured.
 *                    Falls back to a single un-scoped key, i.e. the old
 *                    once-ever behaviour. It deliberately does NOT fall back to
 *                    "show every time" — that is the behaviour being removed.
 *
 * The game id is read from the URL path, so no game needs to pass its own id
 * and there is nothing to keep in sync when a game is renamed.
 *
 * Load this BEFORE the game's own script.
 */
(function () {
  function param(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }
  function gameId() {
    try {
      var m = location.pathname.match(/\/games\/([^\/]+)\//);
      return (m && m[1]) || 'game';
    } catch (e) { return 'game'; }
  }
  function key() {
    var rot = param('rot');
    return 'kj_tut_' + gameId() + (rot ? '_r' + rot : '');
  }

  // Founder rule (Oct 2026): the tutorial shows TWICE per rotation, because
  // players told us once was not enough to learn a game. The stored value is a
  // count of runs the tutorial was shown on ('1' from the old rule reads as 1).
  // markSeen counts at most once per page load, so a game that calls it from
  // two places cannot spend both showings on one launch.
  var SHOWS = 2;
  var countedThisLoad = false;
  function count() {
    try { return parseInt(localStorage.getItem(key()) || '0', 10) || 0; } catch (e) { return 0; }
  }

  window.KJTut = {
    SHOWS: SHOWS,
    // ?tut=1 forces the tutorial (QA), ?tut=0 forces it off.
    seen: function () {
      var force = param('tut');
      if (force === '1') return false;
      if (force === '0') return true;
      return count() >= SHOWS;
    },
    markSeen: function () {
      if (countedThisLoad) return;
      countedThisLoad = true;
      try { localStorage.setItem(key(), String(count() + 1)); } catch (e) { /* private mode */ }
    },
    // Convenience for the common "should I run the guide on this run?" call.
    shouldShow: function () { return !window.KJTut.seen(); },
  };
})();
