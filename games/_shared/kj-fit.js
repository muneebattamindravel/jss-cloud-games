/**
 * FILL THE PHONE'S WIDTH, FAIRLY (27 Sep 2026).
 *
 * Every game plays in a fixed design field (e.g. 414 x 736) so the server can
 * replay it. Phones in a browser give a game a box that is WIDER than those
 * fields (about 0.65 wide to tall on an iPhone, 0.77 on a small one), so a
 * plain contain fit left a band down each side of every game.
 *
 * The rule here: every game declares the vertical BAND of its design that
 * holds all gameplay a player needs to see (hazards, look-ahead, death lines).
 * The fit scales the design so its full WIDTH fills the box whenever the band
 * still fits in the height; only when the box is wider than that does it fit
 * the band to the height and leave narrow side margins, which the game fills
 * with scenery. The band is therefore on screen, in full, on every device, and
 * it is the same band everywhere: a game must clip gameplay drawing to it, so
 * a taller screen that could show more of the design shows only scenery there.
 *
 * Presentation only. Nothing here may reach a game's rules, and nothing about
 * the rules changes with the screen.
 *
 *   var f = KJFit.compute({
 *     boxW, boxH,              // the element's own box, CSS px
 *     W, H,                    // the design field
 *     bandTop, bandBottom,     // design y of the gameplay band (0..H)
 *     anchor: 'top' | 'bottom' | 'center'   // where spare height goes
 *   });
 *   // f.s                 uniform scale, design units to CSS px
 *   // f.offX, f.offY      CSS px of design (0,0)
 *   // f.visLeft/visRight/visTop/visBottom   visible design rect (may exceed 0..W / 0..H)
 *   // f.fillsWidth        true when the design width spans the box edge to edge
 *   // f.clip              { x, y, w, h } the band in design units: clip gameplay to it
 *
 * `anchor` is only a preference. The visible window is always moved as little
 * as needed to keep the whole band on screen.
 */
(function (root) {
  'use strict';

  function num(v, d) { v = Number(v); return Number.isFinite(v) ? v : d; }

  function compute(o) {
    var W = num(o.W, 0), H = num(o.H, 0);
    var boxW = Math.max(1, num(o.boxW, W)), boxH = Math.max(1, num(o.boxH, H));
    var bandTop = Math.max(0, Math.min(H, num(o.bandTop, 0)));
    var bandBottom = Math.max(bandTop + 1, Math.min(H, num(o.bandBottom, H)));
    var bandH = bandBottom - bandTop;
    var anchor = o.anchor === 'top' || o.anchor === 'bottom' ? o.anchor : 'center';

    // Fill the width unless that would push part of the band off the screen.
    var s = Math.min(boxW / W, boxH / bandH);
    var visW = boxW / s, visH = boxH / s;

    // Where the spare height goes, then moved just enough to show the band.
    var pref = anchor === 'top' ? 0 : anchor === 'bottom' ? H - visH : (H - visH) / 2;
    var lo = bandBottom - visH;   // lowest visTop that still shows the band's bottom
    var hi = bandTop;             // highest visTop that still shows the band's top
    var visTop = Math.min(hi, Math.max(lo, pref));
    var visLeft = (W - visW) / 2;

    return {
      s: s,
      offX: -visLeft * s,
      offY: -visTop * s,
      visLeft: visLeft,
      visRight: visLeft + visW,
      visTop: visTop,
      visBottom: visTop + visH,
      fillsWidth: visW <= W + 1e-9,
      clip: { x: 0, y: bandTop, w: W, h: bandH },
    };
  }

  // Map a pointer position (CSS px within the element) into design units.
  function toDesign(f, px, py) {
    return { x: (px - f.offX) / f.s, y: (py - f.offY) / f.s };
  }

  var api = { compute: compute, toDesign: toDesign };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KJFit = api;
})(typeof window !== 'undefined' ? window : this);
