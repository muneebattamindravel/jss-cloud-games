/* Smash It scenery: painted backdrops, drawn in code once at load and used
   as a pre-rendered image behind the 3D scene (no image files). The painter
   works like an illustrator: silhouettes first, then soft shading clipped to
   each shape, then texture and rim light, with haze on anything far away.
   Purely cosmetic; Math.random is not used so every load paints the same. */
(function () {
  'use strict';
  var MARGIN = 113, DW = 414 + MARGIN * 2, DH = 736, K = 2.5;

  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function lin(g, x0, y0, x1, y1, stops) { var gr = g.createLinearGradient(x0, y0, x1, y1); stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); }); return gr; }
  function rad(g, x, y, r, stops, ox, oy) { var gr = g.createRadialGradient(x + (ox || 0), y + (oy || 0), 0, x, y, r); stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); }); return gr; }
  function circles(g, list) { g.beginPath(); list.forEach(function (c) { g.moveTo(c[0] + c[2], c[1]); g.arc(c[0], c[1], c[2], 0, Math.PI * 2); }); }
  // draw a shape, then paint shading clipped inside it
  function shaded(g, path, fill, shades) {
    g.save(); path(); g.fillStyle = fill; g.fill(); g.clip();
    shades.forEach(function (fn) { fn(); });
    g.restore();
  }
  function blurred(g, px, fn) { g.save(); g.filter = 'blur(' + px + 'px)'; fn(); g.restore(); }

  // ---------------------------------------------------------------- sky and clouds
  function sky(g, hY, top, mid, low, sunX, sunY) {
    g.fillStyle = lin(g, 0, 0, 0, hY + 40, [[0, top], [0.55, mid], [1, low]]);
    g.fillRect(-MARGIN, 0, DW, hY + 60);
    g.fillStyle = rad(g, sunX, sunY, 260, [[0, 'rgba(255,250,225,0.75)'], [0.3, 'rgba(255,245,215,0.25)'], [1, 'rgba(255,245,215,0)']]);
    g.fillRect(-MARGIN, 0, DW, hY + 60);
  }
  function cloud(g, x, y, s, R) {
    var list = [];
    for (var i = 0; i < 7; i++) list.push([x + (i - 3) * 13 * s + (R() - 0.5) * 8 * s, y - Math.sin(i / 6 * Math.PI) * 14 * s + (R() - 0.5) * 4 * s, (14 + Math.sin(i / 6 * Math.PI) * 12 + R() * 4) * s]);
    var flat = function () { circles(g, list); g.rect(x - 46 * s, y - 2 * s, 92 * s, 14 * s); };
    blurred(g, 6 * s, function () { g.globalAlpha = 0.35; g.fillStyle = '#ffffff'; circles(g, list.map(function (c) { return [c[0], c[1], c[2] * 1.25]; })); g.fill(); });
    shaded(g, flat, '#ffffff', [
      function () { g.fillStyle = lin(g, 0, y - 30 * s, 0, y + 14 * s, [[0, 'rgba(255,255,255,0)'], [0.55, 'rgba(205,225,245,0.25)'], [1, 'rgba(170,200,232,0.75)']]); g.fillRect(x - 80 * s, y - 40 * s, 160 * s, 60 * s); },
      function () { blurred(g, 3 * s, function () { g.fillStyle = 'rgba(255,255,255,0.9)'; circles(g, list.map(function (c) { return [c[0] - c[2] * 0.25, c[1] - c[2] * 0.3, c[2] * 0.55]; })); g.fill(); }); }
    ]);
  }

  // ---------------------------------------------------------------- terrain
  function ridge(g, y, amp, step, R) {
    var pts = [[-MARGIN - 20, y]], x = -MARGIN - 20;
    while (x < DW + 20) { x += step * (0.7 + R() * 0.6); pts.push([x, y - R() * amp]); }
    return function () {
      g.beginPath(); g.moveTo(pts[0][0], DH + 10); g.lineTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) { var a = pts[i - 1], b = pts[i]; g.quadraticCurveTo(a[0] + (b[0] - a[0]) * 0.5, Math.min(a[1], b[1]) - amp * 0.35, b[0], b[1]); }
      g.lineTo(pts[pts.length - 1][0], DH + 10); g.closePath();
    };
  }
  function hillLayer(g, y, amp, step, R, top, bottom, haze, lightX) {
    var p = ridge(g, y, amp, step, R);
    shaded(g, p, lin(g, 0, y - amp, 0, y + 120, [[0, top], [1, bottom]]), [
      function () { g.fillStyle = rad(g, lightX, y - amp, 260, [[0, 'rgba(255,250,210,0.35)'], [1, 'rgba(255,250,210,0)']]); g.fillRect(-MARGIN, y - amp * 2, DW, 300); },
      function () { if (haze) { g.fillStyle = lin(g, 0, y - amp, 0, y + 60, [[0, haze], [1, 'rgba(255,255,255,0)']]); g.fillRect(-MARGIN, y - amp * 2, DW, 200); } }
    ]);
  }

  // ---------------------------------------------------------------- trees
  var AUTUMN = [
    { base: '#f08a24', dark: '#b8470e', deep: '#8a2e08', lite: '#ffc75a', glow: '#fff0b0' },
    { base: '#f5a623', dark: '#c46a10', deep: '#8f4306', lite: '#ffd977', glow: '#fff4c4' },
    { base: '#e8621c', dark: '#a8350c', deep: '#741f05', lite: '#ffa85a', glow: '#ffe2b0' },
    { base: '#f2b230', dark: '#c27914', deep: '#8a4e08', lite: '#ffe28a', glow: '#fff8d8' }
  ];
  function canopyClusters(cx, cy, w, h, R, n) {
    var list = [];
    for (var i = 0; i < n; i++) {
      var a = R() * Math.PI * 2, d = Math.sqrt(R());
      var r = (0.18 + R() * 0.12) * w;
      list.push([cx + Math.cos(a) * d * (w * 0.5 - r * 0.6), cy + Math.sin(a) * d * (h * 0.5 - r * 0.6), r]);
    }
    return list;
  }
  function leafTexture(g, list, R, cols, n, size) {
    for (var i = 0; i < n; i++) {
      var c = list[(R() * list.length) | 0], a = R() * Math.PI * 2, d = R() * c[2];
      var x = c[0] + Math.cos(a) * d, y = c[1] + Math.sin(a) * d;
      g.fillStyle = cols[(R() * cols.length) | 0];
      g.beginPath(); g.ellipse(x, y, size * (0.6 + R() * 0.8), size * (0.4 + R() * 0.5), R() * Math.PI, 0, Math.PI * 2); g.fill();
    }
  }
  function trunk(g, x, y, s, h) {
    shaded(g, function () {
      g.beginPath(); g.moveTo(x - 9 * s, y); g.bezierCurveTo(x - 6 * s, y - h * 0.4, x - 9 * s, y - h * 0.7, x - 4 * s, y - h);
      g.lineTo(x + 5 * s, y - h); g.bezierCurveTo(x + 8 * s, y - h * 0.6, x + 6 * s, y - h * 0.4, x + 10 * s, y); g.closePath();
      g.moveTo(x - 3 * s, y - h * 0.55); g.quadraticCurveTo(x - 16 * s, y - h * 0.75, x - 26 * s, y - h * 0.95); g.lineTo(x - 22 * s, y - h * 0.98); g.quadraticCurveTo(x - 12 * s, y - h * 0.8, x + 1 * s, y - h * 0.62);
      g.moveTo(x + 3 * s, y - h * 0.6); g.quadraticCurveTo(x + 14 * s, y - h * 0.82, x + 22 * s, y - h * 1.0); g.lineTo(x + 18 * s, y - h * 1.02); g.quadraticCurveTo(x + 10 * s, y - h * 0.85, x, y - h * 0.68);
    }, '#7a4a24', [function () { g.fillStyle = lin(g, x - 10 * s, 0, x + 10 * s, 0, [[0, 'rgba(255,220,170,0.35)'], [0.45, 'rgba(0,0,0,0)'], [1, 'rgba(40,15,0,0.45)']]); g.fillRect(x - 30 * s, y - h * 1.1, 60 * s, h * 1.2); }]);
    g.fillStyle = 'rgba(30,60,10,0.3)'; g.beginPath(); g.ellipse(x + 6 * s, y, 26 * s, 5 * s, 0, 0, Math.PI * 2); g.fill();
  }
  function autumnTree(g, x, y, s, R, pal, detail) {
    var P = AUTUMN[pal % AUTUMN.length], w = 120 * s, h = 105 * s, cx = x, cy = y - 118 * s;
    trunk(g, x, y, s, 80 * s);
    var list = canopyClusters(cx, cy, w, h, R, 16);
    var path = function () { circles(g, list); };
    shaded(g, path, P.base, [
      function () { g.fillStyle = lin(g, cx - w * 0.4, cy - h * 0.5, cx + w * 0.35, cy + h * 0.55, [[0, 'rgba(0,0,0,0)'], [0.5, 'rgba(0,0,0,0)'], [1, P.deep]]); g.fillRect(cx - w, cy - h, w * 2, h * 2); },
      // each cluster: a dark underside and a lit cap, softly blurred so the clusters read as volumes
      function () { blurred(g, 3 * s, function () { list.forEach(function (c) { g.fillStyle = P.dark; g.globalAlpha = 0.55; g.beginPath(); g.ellipse(c[0] + c[2] * 0.15, c[1] + c[2] * 0.45, c[2] * 0.85, c[2] * 0.45, 0, 0, Math.PI * 2); g.fill(); }); }); },
      function () { blurred(g, 2.5 * s, function () { list.forEach(function (c) { g.globalAlpha = 0.85; g.fillStyle = P.lite; g.beginPath(); g.ellipse(c[0] - c[2] * 0.25, c[1] - c[2] * 0.35, c[2] * 0.62, c[2] * 0.45, -0.3, 0, Math.PI * 2); g.fill(); }); }); },
      function () { if (detail) { g.globalAlpha = 0.45; leafTexture(g, list, R, [P.dark, P.base, P.dark, P.lite], Math.round(220 * s), 3.4 * s); } },
      function () { g.globalAlpha = 1; g.fillStyle = rad(g, cx - w * 0.3, cy - h * 0.35, w * 0.45, [[0, 'rgba(255,250,215,0.45)'], [1, 'rgba(255,250,215,0)']]); g.fillRect(cx - w, cy - h, w * 2, h * 2); }
    ]);
    // falling leaves
    if (detail) for (var i = 0; i < 6; i++) { g.fillStyle = P.lite; g.beginPath(); g.ellipse(cx + (R() - 0.5) * w * 1.4, y - R() * 30 * s, 2.5 * s, 1.4 * s, R() * 3, 0, Math.PI * 2); g.fill(); }
  }
  function farTree(g, x, y, s, R, col, dark) {
    var list = canopyClusters(x, y - 26 * s, 40 * s, 36 * s, R, 7);
    g.fillStyle = dark; g.fillRect(x - 1.5 * s, y - 14 * s, 3 * s, 14 * s);
    shaded(g, function () { circles(g, list); }, col, [function () { g.fillStyle = lin(g, 0, y - 44 * s, 0, y - 8 * s, [[0, 'rgba(255,255,220,0.35)'], [1, 'rgba(0,0,0,0.25)']]); g.fillRect(x - 40 * s, y - 60 * s, 80 * s, 60 * s); }]);
  }
  function cypress(g, x, y, s) {
    shaded(g, function () { g.beginPath(); g.moveTo(x, y - 62 * s); g.bezierCurveTo(x + 12 * s, y - 40 * s, x + 9 * s, y - 8 * s, x + 4 * s, y); g.lineTo(x - 4 * s, y); g.bezierCurveTo(x - 9 * s, y - 8 * s, x - 12 * s, y - 40 * s, x, y - 62 * s); }, '#3f8f3e',
      [function () { g.fillStyle = lin(g, x - 10 * s, 0, x + 10 * s, 0, [[0, 'rgba(200,240,150,0.45)'], [0.5, 'rgba(0,0,0,0)'], [1, 'rgba(10,40,10,0.45)']]); g.fillRect(x - 12 * s, y - 64 * s, 24 * s, 64 * s); }]);
  }
  function pumpkin(g, x, y, s, face) {
    g.fillStyle = 'rgba(30,60,10,0.3)'; g.beginPath(); g.ellipse(x + 3 * s, y + 2 * s, 20 * s, 5 * s, 0, 0, Math.PI * 2); g.fill();
    var lobes = [[-10, 7, 11], [10, 7, 11], [-4, 8, 12], [4, 8, 12], [0, 8, 11]];
    lobes.forEach(function (l) {
      shaded(g, function () { g.beginPath(); g.ellipse(x + l[0] * s, y - 11 * s, l[1] * s, l[2] * s, 0, 0, Math.PI * 2); }, '#f07d14',
        [function () { g.fillStyle = rad(g, x + l[0] * s - 3 * s, y - 16 * s, 14 * s, [[0, '#ffc066'], [0.6, 'rgba(240,125,20,0)']]); g.fillRect(x - 30 * s, y - 30 * s, 60 * s, 40 * s); },
         function () { g.fillStyle = lin(g, 0, y - 20 * s, 0, y, [[0.5, 'rgba(0,0,0,0)'], [1, 'rgba(120,40,0,0.5)']]); g.fillRect(x - 30 * s, y - 30 * s, 60 * s, 40 * s); }]);
    });
    g.strokeStyle = '#4f6d1c'; g.lineWidth = 3 * s; g.lineCap = 'round'; g.beginPath(); g.moveTo(x, y - 21 * s); g.quadraticCurveTo(x + 2 * s, y - 28 * s, x + 6 * s, y - 29 * s); g.stroke();
    if (face) {
      g.fillStyle = '#5a1a02';
      g.beginPath(); g.moveTo(x - 9 * s, y - 14 * s); g.lineTo(x - 3 * s, y - 14 * s); g.lineTo(x - 6 * s, y - 19 * s); g.fill();
      g.beginPath(); g.moveTo(x + 9 * s, y - 14 * s); g.lineTo(x + 3 * s, y - 14 * s); g.lineTo(x + 6 * s, y - 19 * s); g.fill();
      g.beginPath(); g.moveTo(x - 10 * s, y - 9 * s); g.quadraticCurveTo(x, y - 1 * s, x + 10 * s, y - 9 * s); g.quadraticCurveTo(x, y - 5 * s, x - 10 * s, y - 9 * s); g.fill();
      g.fillStyle = 'rgba(255,190,60,0.6)'; g.beginPath(); g.moveTo(x - 7 * s, y - 15 * s); g.lineTo(x - 5 * s, y - 15 * s); g.lineTo(x - 6 * s, y - 17 * s); g.fill();
    }
  }
  function rock(g, x, y, s) {
    shaded(g, function () { g.beginPath(); g.moveTo(x - 14 * s, y); g.quadraticCurveTo(x - 15 * s, y - 12 * s, x - 3 * s, y - 14 * s); g.quadraticCurveTo(x + 13 * s, y - 13 * s, x + 15 * s, y); g.closePath(); }, '#a8a39a',
      [function () { g.fillStyle = lin(g, x - 10 * s, y - 14 * s, x + 10 * s, y, [[0, 'rgba(255,255,255,0.45)'], [1, 'rgba(40,40,40,0.35)']]); g.fillRect(x - 16 * s, y - 16 * s, 32 * s, 16 * s); }]);
  }
  function meadowFloor(g, y0, R) {
    // big soft mottling, then fine blades only near the bottom, then a vignette
    shaded(g, function () { g.beginPath(); g.moveTo(-MARGIN, y0 + 6); g.bezierCurveTo(60, y0 - 10, 260, y0 + 16, DW, y0 - 2); g.lineTo(DW, DH); g.lineTo(-MARGIN, DH); g.closePath(); },
      lin(g, 0, y0, 0, DH, [[0, '#9bd255'], [0.35, '#78c13d'], [1, '#4f9d26']]), [
      function () { blurred(g, 18, function () { for (var i = 0; i < 46; i++) { var x = -MARGIN + R() * DW, y = y0 + 20 + R() * (DH - y0); g.fillStyle = R() < 0.5 ? 'rgba(60,130,20,0.22)' : 'rgba(190,235,120,0.18)'; g.beginPath(); g.ellipse(x, y, 40 + R() * 80, 10 + R() * 18, 0, 0, Math.PI * 2); g.fill(); } }); },
      function () { for (var i = 0; i < 2200; i++) { var y = y0 + 30 + Math.pow(R(), 0.7) * (DH - y0 - 20), x = -MARGIN + R() * DW, t = (y - y0) / (DH - y0), h = 2 + t * 9 * (0.5 + R());
        g.strokeStyle = ['rgba(70,140,30,0.55)', 'rgba(150,215,90,0.5)', 'rgba(50,115,20,0.5)', 'rgba(185,235,120,0.4)'][i % 4]; g.lineWidth = 0.6 + t * 1.2;
        g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 1, y - h * 0.6, x + (R() - 0.5) * 4, y - h); g.stroke(); } },
      function () { g.fillStyle = lin(g, 0, DH - 220, 0, DH, [[0, 'rgba(20,60,10,0)'], [1, 'rgba(20,60,10,0.3)']]); g.fillRect(-MARGIN, DH - 220, DW, 220); }
    ]);
  }

  function meadow(g, hY) {
    var R = rng(7);
    sky(g, hY, '#3d93e4', '#86c6f2', '#dff4fd', 330, 70);
    cloud(g, 10, 80, 1.2, R); cloud(g, 330, 56, 1.35, R); cloud(g, 520, 120, 0.9, R); cloud(g, 190, 140, 0.6, R);
    blurred(g, 2, function () { hillLayer(g, hY - 30, 24, 120, R, '#a8c8d6', '#c7dde4', 'rgba(220,238,248,0.6)', 300); });
    blurred(g, 1.2, function () { hillLayer(g, hY - 12, 26, 140, R, '#b6d978', '#9ccc5c', 'rgba(220,240,230,0.45)', 250); });
    // far tree line in haze
    blurred(g, 0.8, function () {
      for (var i = 0; i < 30; i++) {
        var tx = -MARGIN + i * 23 + R() * 10, ty = hY - 2 + R() * 10;
        if (R() < 0.28) cypress(g, tx, ty + 4, 0.55 + R() * 0.2); else farTree(g, tx, ty + 6, 0.8 + R() * 0.3, R, ['#e98a2e', '#f2a83a', '#d9662a', '#c9a23a'][i % 4], '#6b4a2a');
      }
      g.fillStyle = 'rgba(225,240,248,0.28)'; g.fillRect(-MARGIN, hY - 70, DW, 90);
    });
    hillLayer(g, hY + 18, 16, 170, R, '#a2d65c', '#82c445', null, 200);
    // river with a stone bridge
    shaded(g, function () { g.beginPath(); g.moveTo(60, hY + 46); g.bezierCurveTo(150, hY + 34, 230, hY + 60, 340, hY + 52); g.bezierCurveTo(430, hY + 46, 480, hY + 66, 540, hY + 64); g.lineTo(540, hY + 84); g.bezierCurveTo(470, hY + 88, 410, hY + 66, 330, hY + 72); g.bezierCurveTo(230, hY + 80, 150, hY + 58, 60, hY + 60); g.closePath(); },
      lin(g, 0, hY + 36, 0, hY + 86, [[0, '#9ae2ff'], [1, '#2f9de2']]), [function () { for (var i = 0; i < 26; i++) { g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillRect(70 + R() * 460, hY + 48 + R() * 26, 6 + R() * 14, 1.2); } }]);
    shaded(g, function () { g.beginPath(); g.moveTo(178, hY + 58); g.quadraticCurveTo(212, hY + 26, 250, hY + 60); g.lineTo(240, hY + 60); g.quadraticCurveTo(213, hY + 40, 188, hY + 58); g.closePath(); g.rect(176, hY + 38, 76, 5); }, '#d6d0c4',
      [function () { g.fillStyle = lin(g, 0, hY + 30, 0, hY + 60, [[0, 'rgba(255,255,255,0.4)'], [1, 'rgba(60,50,40,0.3)']]); g.fillRect(170, hY + 20, 90, 50); }]);
    // winding path
    shaded(g, function () { g.beginPath(); g.moveTo(26, hY + 6); g.quadraticCurveTo(0, hY + 26, 74, hY + 44); g.lineTo(58, hY + 48); g.quadraticCurveTo(-18, hY + 28, 16, hY + 6); g.closePath(); }, '#e9d29e', []);
    meadowFloor(g, hY + 66, R);
    // big framing trees, pumpkins, rocks
    autumnTree(g, 420, hY + 70, 0.55, R, 3, true); autumnTree(g, -6, hY + 82, 0.6, R, 2, true);
    autumnTree(g, 470, hY + 170, 1.25, R, 0, true); autumnTree(g, -54, hY + 182, 1.35, R, 1, true);
    rock(g, -10, hY + 196, 1); rock(g, 448, hY + 190, 0.8);
    pumpkin(g, 12, hY + 196, 1.25, true); pumpkin(g, 44, hY + 200, 0.75, false); pumpkin(g, 402, hY + 186, 1.1, true); pumpkin(g, 428, hY + 192, 0.65, false);
  }

  // ---------------------------------------------------------------- beach
  function palm(g, x, y, s, lean, R) {
    var tx = x + lean * 60 * s, ty = y - 150 * s, mx = x + lean * 4 * s, my = y - 80 * s;
    for (var i = 0; i < 16; i++) {
      var t = i / 15, bx = (1 - t) * (1 - t) * x + 2 * (1 - t) * t * mx + t * t * tx, by = (1 - t) * (1 - t) * y + 2 * (1 - t) * t * my + t * t * ty, w = (9 - t * 3) * s;
      shaded(g, function () { g.beginPath(); g.ellipse(bx, by, w, 6 * s, lean * 0.3, 0, Math.PI * 2); }, i % 2 ? '#9a6a38' : '#8a5a2c',
        [function () { g.fillStyle = lin(g, bx - w, 0, bx + w, 0, [[0, 'rgba(255,220,170,0.4)'], [1, 'rgba(40,20,0,0.4)']]); g.fillRect(bx - w, by - 8 * s, w * 2, 16 * s); }]);
    }
    var angs = [-2.9, -2.45, -2.0, -1.55, -1.1, -0.65, -0.2, 0.25];
    angs.forEach(function (a, k) {
      var len = (66 + R() * 18) * s, ex = tx + Math.cos(a) * len, ey = ty + Math.sin(a) * len * 0.55 + 34 * s, cxp = tx + Math.cos(a) * len * 0.55, cyp = ty + Math.sin(a) * len * 0.5 - 16 * s;
      for (var j = 0; j < 22; j++) {
        var t = j / 21, px = (1 - t) * (1 - t) * tx + 2 * (1 - t) * t * cxp + t * t * ex, py = (1 - t) * (1 - t) * ty + 2 * (1 - t) * t * cyp + t * t * ey;
        var nx = -(cyp - ty), ny = cxp - tx, nl = Math.sqrt(nx * nx + ny * ny) || 1, fl = (1 - Math.abs(t - 0.45) * 1.6) * 14 * s;
        g.strokeStyle = k % 2 ? '#3a9a33' : '#4fb53e'; g.lineWidth = 2.2 * s; g.lineCap = 'round';
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + nx / nl * fl + 3 * s, py + ny / nl * fl + 6 * s); g.stroke();
        g.beginPath(); g.moveTo(px, py); g.lineTo(px - nx / nl * fl + 3 * s, py - ny / nl * fl + 6 * s); g.stroke();
      }
      g.strokeStyle = '#2e7a22'; g.lineWidth = 2.4 * s; g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(cxp, cyp, ex, ey); g.stroke();
      g.strokeStyle = 'rgba(210,255,150,0.5)'; g.lineWidth = 1 * s; g.beginPath(); g.moveTo(tx, ty - 1); g.quadraticCurveTo(cxp, cyp - 1, ex, ey - 1); g.stroke();
    });
    [[-5, 4], [4, 6], [0, -2]].forEach(function (c) { shaded(g, function () { g.beginPath(); g.arc(tx + c[0] * s, ty + c[1] * s + 4 * s, 5.5 * s, 0, Math.PI * 2); }, '#7a5222', [function () { g.fillStyle = 'rgba(255,220,150,0.4)'; g.beginPath(); g.arc(tx + c[0] * s - 2 * s, ty + c[1] * s + 2 * s, 2.5 * s, 0, 7); g.fill(); }]); });
  }
  function cliff(g, x, w, top, base, R) {
    var path = function () { g.beginPath(); g.moveTo(x, base); g.lineTo(x, top + 10); g.bezierCurveTo(x + w * 0.25, top - 10, x + w * 0.55, top - 4, x + w * 0.75, top + 14); g.bezierCurveTo(x + w * 0.9, top + 40, x + w * 0.88, base - 60, x + w, base); g.closePath(); };
    shaded(g, path, '#b8743f', [
      function () { g.fillStyle = lin(g, x, 0, x + w, 0, [[0, 'rgba(80,35,10,0.35)'], [0.55, 'rgba(255,200,140,0.25)'], [0.8, 'rgba(255,215,160,0.35)'], [1, 'rgba(90,40,10,0.4)']]); g.fillRect(x, top - 20, w, base - top + 40); },
      function () { for (var i = 0; i < 14; i++) { var yy = top + 26 + i * (base - top - 26) / 14; g.strokeStyle = 'rgba(110,50,15,0.45)'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(x, yy); g.bezierCurveTo(x + w * 0.3, yy + (R() - 0.5) * 10, x + w * 0.6, yy + (R() - 0.5) * 10, x + w, yy + 6); g.stroke();
        g.strokeStyle = 'rgba(255,215,160,0.35)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, yy - 3); g.bezierCurveTo(x + w * 0.3, yy - 3, x + w * 0.6, yy - 2, x + w, yy + 3); g.stroke(); } },
      function () { blurred(g, 4, function () { g.fillStyle = 'rgba(70,30,8,0.35)'; for (var i = 0; i < 8; i++) { g.beginPath(); g.ellipse(x + R() * w, top + 40 + R() * (base - top - 60), 10 + R() * 20, 3 + R() * 5, 0, 0, Math.PI * 2); g.fill(); } }); }
    ]);
    var bush = [];
    for (var i = 0; i < 18; i++) bush.push([x + R() * w * 0.82, top + 2 + R() * 14, 6 + R() * 9]);
    shaded(g, function () { circles(g, bush); g.rect(x, top + 6, w * 0.6, 14); }, '#4daa3c', [
      function () { blurred(g, 2, function () { g.fillStyle = 'rgba(160,230,110,0.8)'; bush.forEach(function (b) { g.beginPath(); g.ellipse(b[0] - 2, b[1] - 3, b[2] * 0.55, b[2] * 0.4, 0, 0, Math.PI * 2); g.fill(); }); }); },
      function () { g.fillStyle = 'rgba(20,80,20,0.35)'; g.fillRect(x, top + 16, w, 8); }
    ]);
  }
  function seaFloor(g, hY, R) {
    shaded(g, function () { g.beginPath(); g.rect(-MARGIN, hY, DW, DH - hY); }, lin(g, 0, hY, 0, DH, [[0, '#aeeaf2'], [0.08, '#5fcbe8'], [0.45, '#239fdc'], [1, '#1173bf']]), [
      function () { blurred(g, 10, function () { for (var i = 0; i < 40; i++) { var y = hY + 30 + R() * (DH - hY), x = -MARGIN + R() * DW; g.fillStyle = R() < 0.5 ? 'rgba(120,225,255,0.18)' : 'rgba(10,70,150,0.15)'; g.beginPath(); g.ellipse(x, y, 60 + R() * 120, 6 + R() * 12 * (y - hY) / 300, 0, 0, Math.PI * 2); g.fill(); } }); },
      function () { for (var i = 0; i < 520; i++) { var t = Math.pow(R(), 1.6), y = hY + 3 + t * (DH - hY), w = 3 + t * 30 * (0.4 + R()); g.strokeStyle = 'rgba(255,255,255,' + (0.18 + R() * 0.35) * (1 - t * 0.4) + ')'; g.lineWidth = 0.6 + t * 1.6; var x = -MARGIN + R() * DW; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + w / 2, y - 1 - t * 2, x + w, y); g.stroke(); } },
      function () { g.fillStyle = rad(g, 300, hY + 10, 220, [[0, 'rgba(255,255,230,0.45)'], [1, 'rgba(255,255,230,0)']]); g.fillRect(-MARGIN, hY, DW, 200); },
      function () { for (var i = 0; i < 70; i++) { var x = -MARGIN + R() * DW, y = hY + 6 + Math.pow(R(), 1.4) * (DH - hY); g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.moveTo(x, y - 2.5); g.lineTo(x + 0.7, y); g.lineTo(x, y + 2.5); g.lineTo(x - 0.7, y); g.fill(); g.fillRect(x - 2.5, y - 0.35, 5, 0.7); } }
    ]);
  }
  function beach(g, hY) {
    var R = rng(11);
    sky(g, hY, '#3a92e2', '#7fc1f0', '#d6f1fb', 240, 60);
    cloud(g, 60, 52, 1.45, R); cloud(g, 420, 96, 1.1, R); cloud(g, 540, 36, 1.25, R);
    blurred(g, 1.5, function () {
      shaded(g, function () { g.beginPath(); g.moveTo(110, hY + 1); g.bezierCurveTo(160, hY - 30, 200, hY - 40, 240, hY - 26); g.bezierCurveTo(270, hY - 40, 300, hY - 30, 360, hY + 1); g.closePath(); }, '#9cc3da', [function () { g.fillStyle = 'rgba(230,245,252,0.4)'; g.fillRect(100, hY - 50, 280, 60); }]);
      shaded(g, function () { g.beginPath(); g.moveTo(340, hY + 1); g.bezierCurveTo(380, hY - 18, 430, hY - 20, 490, hY + 1); g.closePath(); }, '#b0d1e2', []);
    });
    seaFloor(g, hY, R);
    // small island with a hill on the horizon
    shaded(g, function () { g.beginPath(); g.moveTo(176, hY + 3); g.bezierCurveTo(196, hY - 18, 226, hY - 22, 252, hY + 3); g.closePath(); }, '#64b45a', [function () { g.fillStyle = 'rgba(255,240,180,0.35)'; g.fillRect(170, hY - 25, 50, 30); }]);
    g.fillStyle = '#efd9a4'; g.beginPath(); g.ellipse(214, hY + 3, 42, 3, 0, 0, Math.PI * 2); g.fill();
    // left: cliff, beach, palms; right: rocky point with palms
    shaded(g, function () { g.beginPath(); g.moveTo(-MARGIN, hY + 54); g.bezierCurveTo(10, hY + 40, 70, hY + 46, 120, hY + 62); g.bezierCurveTo(70, hY + 86, 10, hY + 92, -MARGIN, hY + 100); g.closePath(); }, '#f1d8a0', [function () { g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(-MARGIN, hY + 60, 240, 1.5); }]);
    cliff(g, -MARGIN, 200, hY - 200, hY + 62, R);
    palm(g, 18, hY + 66, 0.9, 0.45, R); palm(g, -40, hY + 46, 0.75, 0.25, R);
    shaded(g, function () { g.beginPath(); g.moveTo(370, hY + 90); g.bezierCurveTo(380, hY + 34, 420, hY + 22, 470, hY + 18); g.bezierCurveTo(500, hY + 14, 520, hY + 18, 540, hY + 26); g.lineTo(540, hY + 100); g.closePath(); }, '#a7653a',
      [function () { g.fillStyle = lin(g, 370, 0, 540, 0, [[0, 'rgba(255,210,150,0.35)'], [1, 'rgba(60,25,5,0.35)']]); g.fillRect(360, hY, 190, 110); }]);
    var bush = []; for (var i = 0; i < 12; i++) bush.push([390 + R() * 140, hY + 20 + R() * 10, 7 + R() * 8]);
    shaded(g, function () { circles(g, bush); }, '#4daa3c', [function () { blurred(g, 2, function () { g.fillStyle = 'rgba(160,230,110,0.8)'; bush.forEach(function (b) { g.beginPath(); g.ellipse(b[0] - 2, b[1] - 3, b[2] * 0.55, b[2] * 0.4, 0, 0, Math.PI * 2); g.fill(); }); }); }]);
    palm(g, 440, hY + 32, 1.0, -0.35, R); palm(g, 492, hY + 24, 0.85, -0.15, R);
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.ellipse(455, hY + 92, 80, 3, 0, 0, Math.PI * 2); g.fill();
  }

  function paint(theme, hY) {
    var c = document.createElement('canvas');
    c.width = Math.round(DW * K); c.height = Math.round(DH * K);
    var g = c.getContext('2d');
    g.scale(K, K); g.translate(MARGIN, 0);
    g.lineJoin = 'round';
    if (theme === 'beach') beach(g, hY); else meadow(g, hY);
    return c;
  }

  window.KTScenery = { paint: paint, MARGIN: MARGIN, DW: DW, DH: DH };
})();
