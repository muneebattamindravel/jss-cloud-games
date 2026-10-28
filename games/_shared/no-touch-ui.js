/**
 * KJ shared gameplay touch hardening.
 *
 * Load this FIRST in every game's <head>:
 *   <script src="/games/_shared/no-touch-ui.js"></script>
 *
 * Games are full-screen, canvas-driven and single-purpose: nothing in them
 * should ever scroll, rubber-band, zoom, flash a tap highlight, select text,
 * or pop the long-press callout / context menu. Browsers do all of that by
 * default, and the games had drifted into wildly inconsistent coverage (some
 * had touch-action but no callout suppression, some had neither), which is why
 * a long press could raise a system menu mid-run.
 *
 * This is deliberately CONSERVATIVE:
 *   - touch-action / overflow / overscroll are pinned on <html> and <body>
 *     ONLY. touch-action is not inherited, so a game that has its own
 *     scrollable panel keeps working; we only kill PAGE-level gestures.
 *   - We never preventDefault() touchmove — the games own their input and
 *     several rely on swipes/drags. `touch-action: none` already stops
 *     scrolling without touching event delivery.
 */
(function () {
  'use strict';

  var CSS = [
    /* Page-level gestures only. We deliberately do NOT touch margin/padding/
       height — those are each game's own layout. `!important` is used because
       this style is injected before the game's stylesheet, and hardening must
       win the cascade regardless of load order. */
    'canvas {',
    '  touch-action: none !important;',            /* not inherited — set explicitly */
    '  -ms-touch-action: none !important;',
    '}',
    'html, body {',
    '  overflow: hidden !important;',              /* no scrollbars / scrolling   */
    '  overscroll-behavior: none !important;',     /* no rubber-band / pull-refresh*/
    '  touch-action: none !important;',            /* no pan, pinch, double-tap    */
    '  -ms-touch-action: none !important;',
    '}',
    /* Inheritable comfort properties — safe to apply broadly. */
    'html, body {',
    '  -webkit-touch-callout: none !important;',   /* no long-press callout menu   */
    '  -webkit-user-select: none !important;',     /* no selection / blue handles  */
    '  -moz-user-select: none !important;',
    '  -ms-user-select: none !important;',
    '  user-select: none !important;',
    '  -webkit-tap-highlight-color: rgba(0,0,0,0) !important;', /* no tap flash    */
    '}',
    /* user-select / callout are inherited, but re-assert on the usual suspects
       so a game that sets `user-select: text` on a wrapper can't re-enable
       selection handles mid-run. */
    'canvas, img, button, .btn {',
    '  -webkit-touch-callout: none !important;',
    '  -webkit-user-select: none !important;',
    '  user-select: none !important;',
    '  -webkit-tap-highlight-color: rgba(0,0,0,0) !important;',
    '}',
    'img, canvas {',
    '  -webkit-user-drag: none !important;',       /* no drag-out ghost image      */
    '}'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById('kj-no-touch-ui')) return;
    var el = document.createElement('style');
    el.id = 'kj-no-touch-ui';
    el.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(el);
  }

  injectStyle();
  // <head> may not exist yet when this runs from a very early script tag.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectStyle, { once: true });
  }

  var stop = function (e) { e.preventDefault(); };

  // Long-press / right-click menu.
  document.addEventListener('contextmenu', stop, { passive: false });
  // Text-selection start (desktop drag-select, iOS selection handles).
  document.addEventListener('selectstart', stop, { passive: false });
  // Drag-out of images/canvas.
  document.addEventListener('dragstart', stop, { passive: false });

  // iOS pinch-zoom (Safari fires these instead of honouring touch-action in
  // some versions / when the page is embedded in a WebView).
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) {
    document.addEventListener(t, stop, { passive: false });
  });

  // NOTE: we deliberately do NOT preventDefault() on touchend to block
  // double-tap zoom. That suppresses the synthesized click, and several games
  // (epic-slicer, boom-patakha, rickshaw-run) drive gameplay from click — rapid
  // tapping would silently break. `touch-action: none` above already disables
  // double-tap zoom without interfering with event delivery.
})();
