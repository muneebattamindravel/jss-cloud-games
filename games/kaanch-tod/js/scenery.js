/* Kaanch Tod scenery: painted backdrops drawn in code (no image files).
   Each painter draws one illustrated scene in design units (414 x 736 centre,
   with side margins so wide screens still see scenery). Purely cosmetic. */
(function () {
  'use strict';
  var MARGIN = 113, DW = 414 + MARGIN * 2, DH = 736, K = 2.5;

  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function lin(g, x0, y0, x1, y1, stops) { var gr = g.createLinearGradient(x0, y0, x1, y1); stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); }); return gr; }
  function rad(g, x, y, r0, r1, stops, ox, oy) { var gr = g.createRadialGradient(x + (ox || 0), y + (oy || 0), r0, x, y, r1); stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); }); return gr; }
  function blob(g, x, y, r, fill) { g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }

  function sky(g, hY, top, mid, low) {
    g.fillStyle = lin(g, 0, -10, 0, hY + 10, [[0, top], [0.6, mid], [1, low]]);
    g.fillRect(-MARGIN, 0, DW, hY + 20);
  }
  function cloud(g, x, y, s, R) {
    var parts = [];
    for (var i = 0; i < 9; i++) parts.push([x + (R() - 0.5) * 70 * s, y + (R() - 0.3) * 14 * s, (10 + R() * 18) * s]);
    parts.sort(function (a, b) { return a[1] - b[1]; });
    g.save(); g.globalAlpha = 0.95;
    parts.forEach(function (p) { blob(g, p[0], p[1] + 3 * s, p[2], 'rgba(150,190,225,0.35)'); });
    parts.forEach(function (p) { blob(g, p[0], p[1], p[2], rad(g, p[0], p[1], 1, p[2], [[0, '#ffffff'], [0.75, '#f6fbff'], [1, '#e2eef9']], -p[2] * 0.3, -p[2] * 0.4)); });
    g.restore();
  }
  function hills(g, y, amp, col1, col2, R, step) {
    g.fillStyle = lin(g, 0, y - amp, 0, y + amp * 2.5, [[0, col1], [1, col2]]);
    g.beginPath(); g.moveTo(-MARGIN, DH);
    var x = -MARGIN, yy = y;
    g.lineTo(x, yy);
    while (x < DW) { var nx = x + step * (0.6 + R() * 0.8), ny = y - R() * amp; g.quadraticCurveTo((x + nx) / 2, ny - amp * 0.6, nx, ny); x = nx; yy = ny; }
    g.lineTo(DW, DH); g.closePath(); g.fill();
  }

  // ---- autumn trees
  var LEAF = [['#ffd36b', '#f59a23', '#c9580f'], ['#ffc04d', '#ec7d1c', '#b54a0c'], ['#ffe08a', '#f2b233', '#c47a12'], ['#ffb35c', '#e8641e', '#a8360c']];
  function autumnTree(g, x, y, s, R, pal) {
    // trunk
    g.fillStyle = lin(g, x - 8 * s, 0, x + 8 * s, 0, [[0, '#5a3418'], [0.4, '#8a5428'], [1, '#4a2a12']]);
    g.beginPath(); g.moveTo(x - 7 * s, y); g.quadraticCurveTo(x - 4 * s, y - 40 * s, x - 10 * s, y - 70 * s); g.lineTo(x + 10 * s, y - 70 * s); g.quadraticCurveTo(x + 4 * s, y - 40 * s, x + 8 * s, y); g.fill();
    g.strokeStyle = '#6a3e1c'; g.lineWidth = 4 * s; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x - 4 * s, y - 50 * s); g.lineTo(x - 22 * s, y - 72 * s); g.moveTo(x + 4 * s, y - 55 * s); g.lineTo(x + 20 * s, y - 78 * s); g.stroke();
    // canopy: shaded clusters, dark ones first then lit ones
    var c = LEAF[pal % LEAF.length], blobs = [];
    for (var i = 0; i < 34; i++) {
      var a = R() * Math.PI * 2, d = Math.sqrt(R()) * 46 * s;
      blobs.push([x + Math.cos(a) * d * 1.15, y - 95 * s + Math.sin(a) * d * 0.8, (13 + R() * 12) * s]);
    }
    blobs.sort(function (p, q) { return q[1] - p[1]; });
    blobs.forEach(function (p) { blob(g, p[0] + 3 * s, p[1] + 5 * s, p[2], c[2]); });
    blobs.forEach(function (p) { blob(g, p[0], p[1], p[2], rad(g, p[0], p[1], 1, p[2], [[0, c[0]], [0.55, c[1]], [1, c[2]]], -p[2] * 0.4, -p[2] * 0.5)); });
    for (i = 0; i < 26; i++) { var lx = x + (R() - 0.5) * 90 * s, ly = y - 95 * s + (R() - 0.7) * 60 * s; blob(g, lx, ly, (1.5 + R() * 2.5) * s, 'rgba(255,240,180,0.55)'); }
  }
  function cypress(g, x, y, s) {
    g.fillStyle = lin(g, x - 8 * s, 0, x + 8 * s, 0, [[0, '#2f7a3a'], [0.4, '#4fa552'], [1, '#225e2b']]);
    g.beginPath(); g.moveTo(x, y - 60 * s); g.quadraticCurveTo(x + 10 * s, y - 25 * s, x + 6 * s, y); g.lineTo(x - 6 * s, y); g.quadraticCurveTo(x - 10 * s, y - 25 * s, x, y - 60 * s); g.fill();
  }
  function pumpkin(g, x, y, s, face) {
    blob(g, x, y + 3 * s, 14 * s, 'rgba(40,70,20,0.25)');
    for (var i = -2; i <= 2; i++) {
      g.fillStyle = rad(g, x + i * 6 * s, y - 9 * s, 1, 14 * s, [[0, '#ffb347'], [0.6, '#f07d14'], [1, '#b94f06']], -4 * s, -5 * s);
      g.beginPath(); g.ellipse(x + i * 6 * s, y - 9 * s, 8 * s, 11 * s, 0, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#5c7a22'; g.beginPath(); g.moveTo(x - 2 * s, y - 19 * s); g.quadraticCurveTo(x + 2 * s, y - 27 * s, x + 6 * s, y - 26 * s); g.lineTo(x + 2 * s, y - 18 * s); g.fill();
    if (face) {
      g.fillStyle = '#5a1e02';
      g.beginPath(); g.moveTo(x - 9 * s, y - 13 * s); g.lineTo(x - 4 * s, y - 13 * s); g.lineTo(x - 6.5 * s, y - 17 * s); g.fill();
      g.beginPath(); g.moveTo(x + 9 * s, y - 13 * s); g.lineTo(x + 4 * s, y - 13 * s); g.lineTo(x + 6.5 * s, y - 17 * s); g.fill();
      g.beginPath(); g.moveTo(x - 10 * s, y - 8 * s); g.quadraticCurveTo(x, y + 1 * s, x + 10 * s, y - 8 * s); g.quadraticCurveTo(x, y - 3 * s, x - 10 * s, y - 8 * s); g.fill();
    }
  }
  function grassStrokes(g, y0, y1, R, n, cols) {
    for (var i = 0; i < n; i++) {
      var x = -MARGIN + R() * DW, y = y0 + R() * (y1 - y0), h = 3 + R() * 6 * (0.5 + (y - y0) / (y1 - y0));
      g.strokeStyle = cols[i % cols.length]; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 1, y - h * 0.6, x + (R() - 0.5) * 3, y - h); g.stroke();
    }
  }

  function meadow(g, hY) {
    var R = rng(7);
    sky(g, hY, '#3f9ee9', '#8fcdf6', '#d7f1fd');
    cloud(g, -40, 70, 1.2, R); cloud(g, 300, 48, 1.4, R); cloud(g, 470, 110, 1, R); cloud(g, 150, 135, 0.7, R);
    hills(g, hY - 26, 22, '#a9c9d8', '#cfe3ea', R, 90);
    hills(g, hY - 8, 26, '#b4dc6c', '#8cc84a', R, 110);
    // far tree line
    for (var i = 0; i < 26; i++) {
      var tx = -MARGIN + i * 26 + R() * 12, ty = hY - 4 + R() * 8;
      if (R() < 0.3) cypress(g, tx, ty + 6, 0.55 + R() * 0.25); else autumnTree(g, tx, ty + 8, 0.28 + R() * 0.12, R, (R() * 4) | 0);
    }
    hills(g, hY + 14, 18, '#98d257', '#6fbb3a', R, 140);
    // river and bridge
    g.fillStyle = lin(g, 0, hY + 40, 0, hY + 80, [[0, '#7fd1ff'], [1, '#2c9be0']]);
    g.beginPath(); g.moveTo(80, hY + 44); g.bezierCurveTo(160, hY + 34, 220, hY + 58, 330, hY + 52); g.bezierCurveTo(420, hY + 48, 470, hY + 70, 527, hY + 66);
    g.lineTo(527, hY + 80); g.bezierCurveTo(460, hY + 86, 400, hY + 64, 320, hY + 70); g.bezierCurveTo(220, hY + 78, 160, hY + 56, 80, hY + 60); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1.5;
    for (i = 0; i < 12; i++) { var rx = 100 + R() * 400, ry = hY + 52 + R() * 18; g.beginPath(); g.moveTo(rx, ry); g.lineTo(rx + 8 + R() * 12, ry); g.stroke(); }
    g.fillStyle = '#c9c3b6'; g.beginPath(); g.moveTo(186, hY + 54); g.quadraticCurveTo(212, hY + 30, 240, hY + 56); g.lineTo(234, hY + 56); g.quadraticCurveTo(212, hY + 40, 192, hY + 56); g.fill();
    g.fillStyle = '#e6e1d6'; g.fillRect(186, hY + 40, 54, 3);
    // path
    g.fillStyle = lin(g, 0, hY, 0, hY + 60, [[0, '#e9d4a4'], [1, '#d9b981']]);
    g.beginPath(); g.moveTo(40, hY + 2); g.quadraticCurveTo(20, hY + 20, 70, hY + 40); g.lineTo(60, hY + 44); g.quadraticCurveTo(8, hY + 22, 34, hY + 2); g.fill();
    // foreground meadow
    g.fillStyle = lin(g, 0, hY + 60, 0, DH, [[0, '#86c947'], [0.5, '#6ab634'], [1, '#4f9a26']]);
    g.beginPath(); g.moveTo(-MARGIN, hY + 72); g.quadraticCurveTo(200, hY + 56, DW, hY + 78); g.lineTo(DW, DH); g.lineTo(-MARGIN, DH); g.fill();
    for (i = 0; i < 40; i++) { var px = -MARGIN + R() * DW, py = hY + 90 + R() * (DH - hY - 90); g.fillStyle = 'rgba(40,110,20,' + (0.08 + R() * 0.1) + ')'; g.beginPath(); g.ellipse(px, py, 30 + R() * 60, 6 + R() * 10, 0, 0, Math.PI * 2); g.fill(); }
    grassStrokes(g, hY + 80, DH, R, 900, ['#5aa42c', '#7cc444', '#4c9224', '#93d35a']);
    // big framing trees and pumpkins
    autumnTree(g, -30, hY + 150, 1.15, R, 1); autumnTree(g, 450, hY + 140, 1.2, R, 0);
    autumnTree(g, 20, hY + 100, 0.7, R, 2); autumnTree(g, 400, hY + 95, 0.65, R, 3);
    pumpkin(g, 22, hY + 170, 1.1, true); pumpkin(g, 50, hY + 176, 0.7, false); pumpkin(g, 396, hY + 166, 1, true); pumpkin(g, 420, hY + 172, 0.65, false);
    blob(g, -5, hY + 178, 9, '#9a9488'); blob(g, 440, hY + 175, 7, '#a59f93');
  }

  // ---- beach
  function palm(g, x, y, s, lean, R) {
    g.strokeStyle = '#8a5a2b'; g.lineWidth = 9 * s; g.lineCap = 'round';
    var tx = x + lean * 60 * s, ty = y - 140 * s;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + lean * 10 * s, y - 80 * s, tx, ty); g.stroke();
    g.strokeStyle = '#6a4220'; g.lineWidth = 2 * s;
    for (var i = 1; i < 12; i++) { var t = i / 12, bx = (1 - t) * (1 - t) * x + 2 * (1 - t) * t * (x + lean * 10 * s) + t * t * tx, by = (1 - t) * (1 - t) * y + 2 * (1 - t) * t * (y - 80 * s) + t * t * ty; g.beginPath(); g.moveTo(bx - 4.5 * s, by); g.lineTo(bx + 4.5 * s, by - 1.5 * s); g.stroke(); }
    var angs = [-2.7, -2.2, -1.7, -1.2, -0.6, -0.1, 0.4, -3.1];
    angs.forEach(function (a, k) {
      var len = (60 + R() * 20) * s, ex = tx + Math.cos(a) * len, ey = ty + Math.sin(a) * len * 0.6 + 26 * s;
      var mx = tx + Math.cos(a) * len * 0.5, my = ty + Math.sin(a) * len * 0.5 - 12 * s;
      g.fillStyle = k % 2 ? '#3f9a2e' : '#57b63b';
      g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(mx, my - 8 * s, ex, ey); g.quadraticCurveTo(mx, my + 8 * s, tx, ty); g.fill();
      g.strokeStyle = '#2d7420'; g.lineWidth = 1.2 * s; g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(mx, my, ex, ey); g.stroke();
    });
    blob(g, tx, ty + 4 * s, 6 * s, '#6b4a1e');
  }
  function cliff(g, x, w, top, base, R) {
    g.fillStyle = lin(g, x, 0, x + w, 0, [[0, '#9b5a2e'], [0.6, '#c9844a'], [1, '#a8643a']]);
    g.beginPath(); g.moveTo(x, base); g.lineTo(x, top + 10); g.quadraticCurveTo(x + w * 0.3, top - 6, x + w * 0.6, top + 4); g.quadraticCurveTo(x + w * 0.9, top + 8, x + w, base); g.fill();
    g.strokeStyle = 'rgba(90,45,15,0.45)'; g.lineWidth = 2;
    for (var i = 0; i < 9; i++) { var yy = top + 20 + i * (base - top - 20) / 9; g.beginPath(); g.moveTo(x, yy); g.quadraticCurveTo(x + w * 0.5, yy + (R() - 0.5) * 8, x + w * (0.85 + R() * 0.1), yy + 4); g.stroke(); }
    g.fillStyle = '#4caa3a'; g.beginPath(); g.moveTo(x - 4, top + 14); g.quadraticCurveTo(x + w * 0.3, top - 14, x + w * 0.62, top + 2); g.quadraticCurveTo(x + w * 0.8, top + 8, x + w * 0.9, top + 18); g.quadraticCurveTo(x + w * 0.5, top + 10, x - 4, top + 24); g.fill();
    for (i = 0; i < 14; i++) blob(g, x + R() * w * 0.8, top + 6 + R() * 10, 5 + R() * 6, i % 2 ? '#3f9a2e' : '#5cbc45');
  }
  function beach(g, hY) {
    var R = rng(11);
    sky(g, hY, '#3b98e6', '#86c9f5', '#cdeefc');
    cloud(g, 40, 40, 1.4, R); cloud(g, 380, 90, 1.1, R); cloud(g, 520, 30, 1.2, R);
    // distant mountains and islands
    g.fillStyle = '#9cc4dc'; g.beginPath(); g.moveTo(140, hY); g.lineTo(200, hY - 34); g.lineTo(230, hY - 22); g.lineTo(270, hY - 40); g.lineTo(330, hY); g.fill();
    g.fillStyle = '#b3d3e4'; g.beginPath(); g.moveTo(330, hY); g.lineTo(400, hY - 22); g.lineTo(470, hY); g.fill();
    // sea
    g.fillStyle = lin(g, 0, hY, 0, DH, [[0, '#9fe6f2'], [0.15, '#45c2e6'], [0.55, '#1f9ad8'], [1, '#147cc4']]);
    g.fillRect(-MARGIN, hY, DW, DH - hY);
    g.fillStyle = '#5fbf6a'; g.beginPath(); g.ellipse(212, hY + 2, 34, 9, 0, Math.PI, 0); g.fill();
    g.fillStyle = '#c9a26a'; g.beginPath(); g.moveTo(186, hY + 2); g.lineTo(204, hY - 12); g.lineTo(224, hY - 6); g.lineTo(240, hY + 2); g.fill();
    for (var i = 0; i < 220; i++) {
      var y = hY + 4 + Math.pow(R(), 1.4) * (DH - hY), w = 4 + (y - hY) * 0.08 * (0.5 + R());
      g.fillStyle = 'rgba(255,255,255,' + (0.15 + R() * 0.35) + ')';
      g.fillRect(-MARGIN + R() * DW, y, w, 1 + (y - hY) * 0.004);
    }
    for (i = 0; i < 60; i++) { var sx = -MARGIN + R() * DW, sy = hY + 10 + R() * (DH - hY - 10); blob(g, sx, sy, 0.8 + R() * 1.2, 'rgba(255,255,255,0.8)'); }
    // left cliff and beach, right rocks with palms
    g.fillStyle = '#f2d9a0'; g.beginPath(); g.moveTo(-MARGIN, hY + 70); g.quadraticCurveTo(40, hY + 50, 90, hY + 62); g.quadraticCurveTo(40, hY + 90, -MARGIN, hY + 96); g.fill();
    cliff(g, -MARGIN, 190, hY - 180, hY + 70, R);
    palm(g, 4, hY + 60, 0.8, 0.5, R); palm(g, -40, hY + 30, 0.7, 0.3, R);
    g.fillStyle = lin(g, 380, 0, 527, 0, [[0, '#a8643a'], [1, '#7a4220']]);
    g.beginPath(); g.moveTo(380, hY + 80); g.quadraticCurveTo(390, hY + 30, 430, hY + 24); g.quadraticCurveTo(480, hY + 10, 527, hY + 20); g.lineTo(527, hY + 90); g.fill();
    for (i = 0; i < 10; i++) blob(g, 400 + R() * 120, hY + 22 + R() * 8, 6 + R() * 8, i % 2 ? '#3f9a2e' : '#5cbc45');
    palm(g, 430, hY + 40, 0.95, -0.35, R); palm(g, 480, hY + 30, 0.8, -0.2, R);
  }

  function paint(theme, hY) {
    var c = document.createElement('canvas');
    c.width = Math.round(DW * K); c.height = Math.round(DH * K);
    var g = c.getContext('2d');
    g.scale(K, K); g.translate(MARGIN, 0);
    if (theme === 'beach') beach(g, hY); else meadow(g, hY);
    return c;
  }

  window.KTScenery = { paint: paint, MARGIN: MARGIN, DW: DW, DH: DH };
})();
