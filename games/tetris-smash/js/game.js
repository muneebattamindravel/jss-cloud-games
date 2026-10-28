(function () {
  'use strict';
  var G = window.TS;
  // ===================== client (cosmetic below here; the rules are in rules.js) =====================
  // Full-screen well: a thin top bar, then the 10 x 20 well edge to edge.
  var W = 372, H = 820, CELL = 36, WX = 6, WY = 94, WW = G.COLS * CELL, WH = (G.ROWS - G.HIDDEN) * CELL;
  var SCORE_BOX = { x: 6, y: 8, w: 204, h: 76 };
  var NEXT_BOX = { x: 216, y: 8, w: 150, h: 76 };
  var TAP_MOVE = 14, SOFT_MS = 180, SWIPE_DY = 34, SWIPE_MS = 300, AXIS_PX = 12, MOVE_PX = 24;   // touch gestures, design px and ms
  var DAS_STEPS = 10, ARR_STEPS = 2;                                    // keyboard auto-repeat, in steps
  var EMBED = !!window.__kjEmbed;
  var Q = EMBED ? '' : location.search;       // testing switches work standalone only
  var canvas = document.getElementById('game'), ctx = canvas.getContext('2d');
  var menu = document.getElementById('menu'), over = document.getElementById('over');
  var playBtn = document.getElementById('playBtn'), howBtn = document.getElementById('howBtn');
  var skipBtn = document.getElementById('skipBtn'), readyBox = document.getElementById('readyBox'), readyBtn = document.getElementById('readyBtn');
  var RP = (window.KJReplay && window.KJReplay.active()) ? window.KJReplay : null;
  if (RP) RP.ready('tetris-smash');
  var standaloneSeed = Number((Q.match(/[?&]seed=(\d+)/) || [])[1]) || ((Math.random() * 1e9) >>> 0);
  var sessionReady = false, traceVersion = 0, replayCur = null, submitDone = true, runsStarted = 0;
  var mode = 'menu';                         // menu | tut | play | over
  var st = null, tut = null;
  var fit = null, K = 1, DPR = 1;
  var bricks = null, ghosts = null, minis = null, glows = null, backImg = null, wellImg = null, vig = null, handImg = null;
  var SPR = {};                              // pre-rendered effect sprites (ember, streak, heat, danger, shock)
  var parts = [], floats = [], trails = [], shocks = [], flashes = [], embers = null, banner = null, flashA = 0, flashCol = '#fff', shake = 0, nudgeX = 0;
  var pending = [], buffered = null, das = null, gesture = null, tapMark = null;

  // I O T S Z J L: our own kiln-glazed brick colours.
  var COLS_HEX = ['#2fb3a8', '#f2c14e', '#e0553a', '#72b852', '#b04f94', '#4f6fd6', '#f2892e'];
  var FONT = '"Titan One", "Arial Rounded MT Bold", sans-serif';
  var C_INK = '#f2f4f8', C_LABEL = '#6f7687', C_EMBER = '#ffb347', C_HOT = '#ff6a3d', C_GREEN = '#a6e39a';
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    function f(c) { return Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt); }
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }
  function rgba(hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function poly(c, pts) { c.beginPath(); c.moveTo(pts[0], pts[1]); for (var i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); c.closePath(); }
  function R(a, b) { return a + Math.random() * (b - a); }
  function ease(t) { return 1 - (1 - t) * (1 - t) * (1 - t); }
  function backOut(t) { var c = 2.2, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; }

  // ---- pre-rendered art (built once per scale, never per frame) ----
  // A canvas of w x h design units at the current device scale.
  function mk(w, h, draw) {
    var cv = document.createElement('canvas'); cv.width = Math.max(1, Math.ceil(w * K)); cv.height = Math.max(1, Math.ceil(h * K));
    var c = cv.getContext('2d'); c.scale(K, K); draw(c, w, h); return cv;
  }
  function buildBrick(col, s) {
    return mk(s, s, function (c) {
      var m = Math.max(1, s * 0.035), w = s - 2 * m, r = s * 0.17, ins = s * 0.17;
      // mortar shadow
      rr(c, m + s * 0.03, m + s * 0.05, w - s * 0.02, w - s * 0.03, r); c.fillStyle = 'rgba(8,2,0,.6)'; c.fill();
      var bw = w - s * 0.03, bh = w - s * 0.045;
      // fired body
      var g = c.createLinearGradient(0, m, s * 0.35, s - m); g.addColorStop(0, shade(col, 0.3)); g.addColorStop(0.5, col); g.addColorStop(1, shade(col, -0.34));
      rr(c, m, m, bw, bh, r); c.fillStyle = g; c.fill();
      c.save(); rr(c, m, m, bw, bh, r); c.clip();
      // bevels: light top and left, dark bottom and right
      c.fillStyle = 'rgba(255,255,255,.34)'; poly(c, [m, m, m + bw, m, m + bw - ins, m + ins, m + ins, m + ins]); c.fill();
      c.fillStyle = 'rgba(255,255,255,.14)'; poly(c, [m, m, m + ins, m + ins, m + ins, m + bh - ins, m, m + bh]); c.fill();
      c.fillStyle = 'rgba(20,4,0,.32)'; poly(c, [m, m + bh, m + ins, m + bh - ins, m + bw - ins, m + bh - ins, m + bw, m + bh]); c.fill();
      c.fillStyle = 'rgba(20,4,0,.2)'; poly(c, [m + bw, m, m + bw, m + bh, m + bw - ins, m + bh - ins, m + bw - ins, m + ins]); c.fill();
      // the raised glazed face
      var g2 = c.createLinearGradient(0, m + ins, 0, m + bh - ins); g2.addColorStop(0, shade(col, 0.16)); g2.addColorStop(1, shade(col, -0.1));
      rr(c, m + ins, m + ins, bw - 2 * ins, bh - 2 * ins, r * 0.5); c.fillStyle = g2; c.fill();
      // glaze gloss and a hot sparkle
      var gl = c.createLinearGradient(0, m, 0, s * 0.55); gl.addColorStop(0, 'rgba(255,255,255,.55)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
      c.beginPath(); c.ellipse(s * 0.44, s * 0.24, s * 0.3, s * 0.13, -0.25, 0, 6.2832); c.fillStyle = gl; c.fill();
      c.fillStyle = 'rgba(255,255,255,.9)'; c.beginPath(); c.arc(s * 0.27, s * 0.25, s * 0.04, 0, 6.2832); c.fill();
      // kiln speckles
      c.fillStyle = shade(col, -0.5);
      for (var i = 0; i < 5; i++) { c.globalAlpha = R(0.15, 0.32); c.beginPath(); c.arc(R(s * 0.25, s * 0.8), R(s * 0.4, s * 0.82), R(s * 0.015, s * 0.035), 0, 6.2832); c.fill(); }
      c.globalAlpha = 1; c.restore();
      c.lineWidth = Math.max(0.8, s * 0.03); c.strokeStyle = 'rgba(25,6,2,.6)'; rr(c, m, m, bw, bh, r); c.stroke();
    });
  }
  function buildGhost(col, s) {
    return mk(s, s, function (c) {
      var m = s * 0.09;
      rr(c, m, m, s - 2 * m, s - 2 * m, s * 0.16); c.fillStyle = rgba(col, 0.13); c.fill();
      c.lineWidth = s * 0.06; c.strokeStyle = rgba(col, 0.8); c.setLineDash([s * 0.17, s * 0.1]); c.stroke();
    });
  }
  // A soft halo in the brick's colour, drawn additively behind the falling piece.
  function buildGlow(col, s) {
    return mk(s * 2, s * 2, function (c) {
      var g = c.createRadialGradient(s, s, s * 0.2, s, s, s); g.addColorStop(0, rgba(col, 0.55)); g.addColorStop(1, rgba(col, 0));
      c.fillStyle = g; c.fillRect(0, 0, s * 2, s * 2);
    });
  }
  function buildSprites() {
    SPR.ember = mk(16, 16, function (c) {
      var g = c.createRadialGradient(8, 8, 0, 8, 8, 8);
      g.addColorStop(0, 'rgba(255,250,220,1)'); g.addColorStop(0.25, 'rgba(255,190,90,.9)'); g.addColorStop(0.6, 'rgba(255,90,30,.35)'); g.addColorStop(1, 'rgba(255,60,20,0)');
      c.fillStyle = g; c.fillRect(0, 0, 16, 16);
    });
    SPR.streak = mk(8, 64, function (c) {
      var g = c.createLinearGradient(0, 0, 0, 64); g.addColorStop(0, 'rgba(255,200,130,0)'); g.addColorStop(1, 'rgba(255,236,200,.9)');
      c.fillStyle = g; c.fillRect(0, 0, 8, 64);
    });
    SPR.dragH = mk(64, 8, function (c) {
      var g = c.createLinearGradient(0, 0, 64, 0); g.addColorStop(0, 'rgba(255,210,122,.9)'); g.addColorStop(1, 'rgba(255,210,122,0)');
      c.fillStyle = g; c.fillRect(0, 0, 64, 8);
    });
    SPR.heat = mk(WW, 200, function (c) {
      var g = c.createLinearGradient(0, 0, 0, 200); g.addColorStop(0, 'rgba(255,110,30,0)'); g.addColorStop(1, 'rgba(255,120,40,.32)');
      c.fillStyle = g; c.fillRect(0, 0, WW, 200);
    });
    SPR.danger = mk(WW, 130, function (c) {
      var g = c.createLinearGradient(0, 0, 0, 130); g.addColorStop(0, 'rgba(255,50,25,.6)'); g.addColorStop(1, 'rgba(255,50,25,0)');
      c.fillStyle = g; c.fillRect(0, 0, WW, 130);
    });
    SPR.shock = mk(WW, 40, function (c) {
      var g = c.createLinearGradient(0, 0, 0, 40); g.addColorStop(0, 'rgba(255,190,100,0)'); g.addColorStop(0.5, 'rgba(255,245,215,1)'); g.addColorStop(1, 'rgba(255,190,100,0)');
      c.fillStyle = g; c.fillRect(0, 0, WW, 40);
      var h = c.createLinearGradient(0, 0, WW, 0); h.addColorStop(0, 'rgba(0,0,0,1)'); h.addColorStop(0.2, 'rgba(0,0,0,0)'); h.addColorStop(0.8, 'rgba(0,0,0,0)'); h.addColorStop(1, 'rgba(0,0,0,1)');
      c.globalCompositeOperation = 'destination-out'; c.fillStyle = h; c.fillRect(0, 0, WW, 40);
    });
    SPR.hot = mk(CELL, CELL, function (c) { rr(c, 2, 2, CELL - 4, CELL - 4, CELL * 0.17); c.fillStyle = '#fff4dc'; c.fill(); });
  }
  function buildWell() {
    var M = 6;
    var cv = mk(WW + M * 2, WH + M * 2, function (c, w, h) {
      // a quiet charcoal well: soft rounded slab, faint grid
      rr(c, 0, 0, w, h, 16); c.fillStyle = '#1c1f27'; c.fill();
      c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,.05)'; rr(c, 0.5, 0.5, w - 1, h - 1, 15.5); c.stroke();
      c.fillStyle = 'rgba(255,255,255,.035)';
      for (var gx = 1; gx < G.COLS; gx++) c.fillRect(M + gx * CELL - 0.5, M, 1, WH);
      for (var gy = 1; gy < G.ROWS - G.HIDDEN; gy++) c.fillRect(M, M + gy * CELL - 0.5, WW, 1);
    });
    wellImg = { cv: cv, m: M };
  }
  // The kiln wall behind everything, lit from the fire below, at the canvas's own pixel size.
  function buildBack() {
    backImg = document.createElement('canvas'); backImg.width = canvas.width; backImg.height = canvas.height;
    var c = backImg.getContext('2d'), w = backImg.width, h = backImg.height;
    var g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#16181e'); g.addColorStop(1, '#101217');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    vig = document.createElement('canvas'); vig.width = 128; vig.height = 128;
    var v = vig.getContext('2d'), rg = v.createRadialGradient(64, 64, 30, 64, 64, 92);
    rg.addColorStop(0, 'rgba(255,40,20,0)'); rg.addColorStop(1, 'rgba(255,40,20,.85)'); v.fillStyle = rg; v.fillRect(0, 0, 128, 128);
  }
  // The approved flat hand: index finger up, three curled knuckles, thumb tucked, cuff.
  var HAND_W = 66, HAND_H = 100;
  function buildHand() {
    var k = 4, cv = document.createElement('canvas'); cv.width = HAND_W * k; cv.height = HAND_H * k;
    var g = cv.getContext('2d'); g.scale(k, k); g.lineWidth = 3.2; g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = '#3a1608';
    function shape(fill) { g.fillStyle = fill; g.fill(); g.stroke(); }
    rr(g, 8, 40, 50, 44, 14); shape('#fff6ea');
    rr(g, 16, 12, 17, 44, 8.5); shape('#fff6ea');
    rr(g, 32, 38, 13, 20, 6.5); shape('#fff6ea');
    rr(g, 44, 41, 12, 19, 6); shape('#fff6ea');
    rr(g, 54, 45, 7, 17, 3.5); shape('#fff6ea');
    g.save(); g.translate(26, 66); g.rotate(-0.35); rr(g, -15, -7, 30, 14, 7); shape('#fff6ea'); g.restore();
    rr(g, 12, 84, 42, 13, 4); shape('#e0553a');
    handImg = cv;
  }
  function resize() {
    var bw = Math.max(1, document.documentElement.clientWidth), bh = Math.max(1, document.documentElement.clientHeight);
    var d = Math.min(3, window.devicePixelRatio || 1);
    var cw = Math.round(bw * d), ch = Math.round(bh * d), sizeChanged = false;
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; sizeChanged = true; }
    fit = KJFit.compute({ boxW: bw, boxH: bh, W: W, H: H, bandTop: 0, bandBottom: H, anchor: 'center' });
    var k = fit.s * d; DPR = d;
    if (!bricks || Math.abs(k - K) > 0.001) {
      K = k; bricks = []; ghosts = []; minis = []; glows = [];
      for (var i = 0; i < 7; i++) { bricks.push(buildBrick(COLS_HEX[i], CELL)); ghosts.push(buildGhost(COLS_HEX[i], CELL)); minis.push(buildBrick(COLS_HEX[i], 16)); glows.push(buildGlow(COLS_HEX[i], CELL)); }
      buildWell(); buildSprites(); sizeChanged = true;
    }
    if (sizeChanged) { buildBack(); embers = null; }
  }
  function design() { ctx.setTransform(K, 0, 0, K, fit.offX * DPR, fit.offY * DPR); }
  // A pre-rendered image with its top-left at a design point, snapped to device pixels.
  function blitTL(img, x, y, a) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (a != null) ctx.globalAlpha = a;
    ctx.drawImage(img, Math.round(fit.offX * DPR + x * K), Math.round(fit.offY * DPR + y * K));
    if (a != null) ctx.globalAlpha = 1;
    design();
  }
  if (document.fonts && document.fonts.load) document.fonts.load('40px "Titan One"').then(function () {}, function () {});

  // ---- audio (Web Audio only, no files) ----
  var AC = null, master = null, wet = null, nbuf = null;
  function audio() {
    if (AC) return AC;
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      var comp = AC.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6; comp.connect(AC.destination);
      master = AC.createGain(); master.gain.value = 0.85; master.connect(comp);
      nbuf = AC.createBuffer(1, AC.sampleRate * 0.8, AC.sampleRate); var dd = nbuf.getChannelData(0); for (var i = 0; i < dd.length; i++) dd[i] = Math.random() * 2 - 1;
      // a small warm room: generated impulse, no files
      var len = Math.floor(AC.sampleRate * 1.4), ir = AC.createBuffer(2, len, AC.sampleRate);
      for (var ch = 0; ch < 2; ch++) { var id = ir.getChannelData(ch); for (var j = 0; j < len; j++) id[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 3); }
      var conv = AC.createConvolver(); conv.buffer = ir;
      var lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      wet = AC.createGain(); wet.gain.value = 0.32; wet.connect(conv); conv.connect(lp); lp.connect(master);
    } catch (e) { AC = null; }
    return AC;
  }
  audio();   // constructing costs the most and needs no gesture; resuming is cheap
  function unlock() { var a = audio(); if (a && a.state !== 'running') { try { a.resume(); } catch (e) {} } }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (n) { window.addEventListener(n, unlock, { passive: true }); });
  document.addEventListener('visibilitychange', function () { if (!AC) return; if (document.hidden) AC.suspend(); else AC.resume(); });
  function live() { return AC && AC.state === 'running'; }
  // pan: -1 left .. 1 right; a sound follows the piece's column
  function out(g, pan, rev) {
    var dst = master;
    if (pan && AC.createStereoPanner) { var p = AC.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(master); if (rev && wet) p.connect(wet); g.connect(p); return; }
    g.connect(dst); if (rev && wet) g.connect(wet);
  }
  function tone(f, d, type, vol, when, slideTo, rev, pan, atk) {
    if (!live()) return; var t = AC.currentTime + (when || 0), o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + (atk || 0.004)); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); out(g, pan, rev); o.start(t); o.stop(t + d + 0.03);
  }
  function noise(d, f0, f1, vol, when, type, q, rev, pan) {
    if (!live()) return; var t = AC.currentTime + (when || 0), s = AC.createBufferSource(); s.buffer = nbuf;
    var bp = AC.createBiquadFilter(); bp.type = type || 'bandpass'; bp.Q.value = q || 1; bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + d);
    var g = AC.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    s.connect(bp); bp.connect(g); out(g, pan, rev); s.start(t, Math.random() * 0.3); s.stop(t + d + 0.03);
  }
  // A soft FM bell: a sine whose brightness fades as it rings.
  function bell(f, d, vol, when, pan, ratio) {
    if (!live()) return; var t = AC.currentTime + (when || 0);
    var car = AC.createOscillator(), mod = AC.createOscillator(), mg = AC.createGain(), g = AC.createGain();
    car.frequency.value = f; mod.frequency.value = f * (ratio || 2.0);
    mg.gain.setValueAtTime(f * 1.6, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + d * 0.7);
    mod.connect(mg); mg.connect(car.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    car.connect(g); out(g, pan, 1); car.start(t); mod.start(t); car.stop(t + d + 0.05); mod.stop(t + d + 0.05);
  }
  function colPan(x) { return ((x == null ? 4.5 : x) + 1.5 - G.COLS / 2) / (G.COLS / 2) * 0.6; }
  var PENTA = [0, 2, 4, 7, 9];
  function noteHz(k) { var n = PENTA[k % 5] + 12 * Math.floor(k / 5); return 392 * Math.pow(2, Math.min(n, 30) / 12); }
  // glassy tick, a touch higher to the right
  function sMove(x) { var p = colPan(x); tone(1500 + (x || 0) * 40, 0.035, 'sine', 0.05, 0, 1100, 0, p); noise(0.012, 6000, 4000, 0.025, 0, 'highpass', 0.7, 0, p); }
  // a quick upward flick
  function sTurn(x) { var p = colPan(x); tone(900, 0.06, 'sine', 0.055, 0, 1500, 0, p); tone(1800, 0.04, 'sine', 0.02, 0.015, 2600, 0, p); noise(0.05, 2500, 6000, 0.02, 0, 'bandpass', 2, 0, p); }
  function sBlocked(x) { tone(220, 0.06, 'sine', 0.06, 0, 160, 0, colPan(x)); noise(0.03, 900, 500, 0.03, 0, 'lowpass', 1, 0, colPan(x)); }
  // the glossy clack of a block setting down
  function sLock(hard, x) {
    var p = colPan(x);
    tone(hard ? 140 : 190, hard ? 0.18 : 0.1, 'sine', hard ? 0.32 : 0.18, 0, hard ? 55 : 90, 0, p);
    noise(0.008, 5000, 3000, hard ? 0.09 : 0.06, 0, 'highpass', 0.7, 0, p);
    tone(hard ? 640 : 760, 0.07, 'triangle', hard ? 0.05 : 0.04, 0.002, null, 0, p);
    if (hard) noise(0.12, 900, 200, 0.12, 0, 'lowpass', 0.8, 0, p);
  }
  // a short air whoosh down the well
  function sHard(x) { noise(0.1, 4000, 500, 0.07, 0, 'bandpass', 1.1, 0, colPan(x)); }
  // rows clear: a rising run of bells, higher with each combo; a shimmer on top
  function sClear(n, combo) {
    var k = Math.min(16, 2 + Math.max(0, combo) * 2);
    noise(0.35, 1400, 300, 0.1, 0.01, 'lowpass', 0.7);
    for (var i = 0; i < n + 1; i++) bell(noteHz(k + i), 0.6, 0.075, i * 0.055, (i % 2 ? 0.25 : -0.25));
    noise(0.5, 9000, 6000, 0.025, 0.05, 'highpass', 0.6, 1);
  }
  function sSmash() {
    tone(90, 0.8, 'sine', 0.42, 0, 32); noise(0.7, 700, 90, 0.2, 0, 'lowpass', 0.6, 1);
    [0, 4, 7, 12, 16, 19].forEach(function (n, i) { bell(523 * Math.pow(2, n / 12), 1.1, 0.07, 0.06 + i * 0.05, (i % 2 ? 0.35 : -0.35)); });
    noise(0.9, 10000, 5000, 0.04, 0.1, 'highpass', 0.5, 1);
  }
  function sLevel() { [0, 4, 7, 12].forEach(function (n, i) { bell(659 * Math.pow(2, n / 12), 0.7, 0.07, i * 0.08); }); tone(330, 0.9, 'triangle', 0.04, 0.3, null, 1, 0, 0.12); }
  function sTick(hi) { tone(hi ? 1400 : 1000, 0.04, 'sine', 0.08); noise(0.01, 6000, 4000, 0.03, 0, 'highpass'); }
  function sWarn() { bell(784, 0.35, 0.08); bell(1047, 0.45, 0.08, 0.14); }
  function sStart() { bell(523, 0.4, 0.07); bell(659, 0.4, 0.07, 0.09); bell(784, 0.6, 0.08, 0.18); }
  function sEnd() { [784, 659, 523, 392].forEach(function (f, i) { bell(f, 0.8, 0.08, i * 0.15); }); }
  function sReady() { [523, 659, 784, 1047].forEach(function (f, i) { bell(f, 0.6, 0.07, i * 0.08); }); }

  // ---- particles ----
  // k: 0 brick chunk, 1 dust, 2 ember (drawn additively)
  var MAXP = 900;
  function cellX(c) { return WX + c * CELL; }
  function cellY(r) { return WY + (r - G.HIDDEN) * CELL; }
  function crumble(cx, cy, col, delay) {
    for (var i = 0; i < 3 && parts.length < MAXP; i++) parts.push({ k: 0, x: cx + R(-12, 12), y: cy + R(-12, 12), vx: R(-170, 170), vy: R(-300, -60), g: 1100, life: R(0.6, 1.1), age: -delay, sz: R(5, 10), col: col, rot: R(0, 6), vr: R(-10, 10) });
    for (var j = 0; j < 2 && parts.length < MAXP; j++) parts.push({ k: 2, x: cx + R(-10, 10), y: cy + R(-8, 8), vx: R(-90, 90), vy: R(-220, -60), g: -40, life: R(0.5, 1.2), age: -delay, sz: R(7, 13) });
    if (parts.length < MAXP) parts.push({ k: 1, x: cx + R(-8, 8), y: cy + R(-6, 6), vx: R(-40, 40), vy: R(-50, -10), g: -20, life: R(0.6, 1.0), age: -delay, sz: R(9, 16), col: '#c99a74' });
  }
  function dust(x, y, n) {
    for (var i = 0; i < n && parts.length < MAXP; i++) parts.push({ k: 1, x: x + R(-14, 14), y: y + R(-3, 2), vx: R(-70, 70), vy: R(-35, -5), g: -10, life: R(0.35, 0.6), age: 0, sz: R(6, 11), col: '#c99a74' });
  }
  function sparks(x, y, n, up) {
    for (var i = 0; i < n && parts.length < MAXP; i++) parts.push({ k: 2, x: x + R(-12, 12), y: y + R(-2, 2), vx: R(-160, 160), vy: up ? R(-260, -80) : R(-120, -20), g: 500, life: R(0.25, 0.55), age: 0, sz: R(5, 9) });
  }
  function burst(x, y, n, spd) {
    for (var i = 0; i < n && parts.length < MAXP; i++) { var a = R(0, 6.2832), v = R(spd * 0.3, spd); parts.push({ k: 2, x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, g: 160, life: R(0.6, 1.3), age: 0, sz: R(8, 15) }); }
  }

  // ---- runs ----
  function setPlayBtn() {
    var ok = sessionReady;
    [playBtn, readyBtn].forEach(function (b) { if (!b) return; b.disabled = !ok; b.textContent = ok ? 'PLAY' : 'PREPARING YOUR GAME'; });
  }
  function newRun() {
    if (!sessionReady) return;
    if (EMBED && runsStarted > 0) return;       // inside the platform one session is one run
    runsStarted++;
    traceVersion = (typeof window.__kjGameStart === 'function') ? (Number(window.__kjGameStart(performance.now(), G.RULES_VERSION)) || 0) : 0;
    if (RP) { traceVersion = RP.capVersion(traceVersion); replayCur = RP.cursor(['act'], function (p) { return Number(p.step); }); RP.started(traceVersion); }
    var seedInt = EMBED ? G.seedToInt(window.__kjSeed) : standaloneSeed;
    st = { sim: G.initSim(seedInt), over: false, endAt: 0, lastSec: 300, clearAnim: null, dispX: 0, dispY: 0, spawnAt: 0, comboPop: 0, levelPop: 0, scoreShown: 0, bump: 0 };
    syncDisp(true);
    pending = []; buffered = null; das = null;
    parts = []; floats = []; trails = []; shocks = []; flashes = []; banner = { t: performance.now(), txt: 'GO!', col: '#ffd27a' };
    mode = 'play'; submitDone = true;
    menu.classList.add('is-hidden'); over.classList.add('is-hidden'); readyBox.classList.add('is-hidden'); skipBtn.classList.add('is-hidden');
    sStart();
  }
  function syncDisp(snap) {
    var s = mode === 'tut' && tut ? tut.sim : (st && st.sim);
    if (!s || !s.cur) return;
    var tgt = st || tut;
    if (snap) { tgt.dispX = s.cur.x; tgt.dispY = s.cur.y; }
  }
  // Every action goes through here; a live one is queued for the next step.
  function act(a) {
    if (RP) return;
    if (mode === 'tut') { tutAct(a); return; }
    if (mode !== 'play' || !st || st.over) return;
    pending.push(a);
  }
  var BUFFERABLE = { 0: 1, 1: 1, 2: 1, 3: 1, 6: 1 };
  function applyAct(sim, a, live) {
    var n = sim.n, step = sim.frame;
    var r = G.actSim(sim, a);
    if (r === true) {
      // The ACTION only, never its result: the server replays it.
      if (live && traceVersion >= 2 && typeof window.__kjAct === 'function') { try { window.__kjAct(performance.now(), n, a, step); } catch (_e) {} }
      var px = sim.cur ? sim.cur.x : null;
      if (a === G.A_LEFT || a === G.A_RIGHT) sMove(px);
      else if (a === G.A_CW || a === G.A_CCW) sTurn(px);
      return true;
    }
    if (live && r === 'no_piece' && BUFFERABLE[a]) buffered = { a: a, until: step + G.CLEAR_STEPS + 4 };
    else if (r === 'blocked' && (a === G.A_LEFT || a === G.A_RIGHT)) { nudgeX = a === G.A_LEFT ? -3 : 3; sBlocked(sim.cur && sim.cur.x); }
    else if (r === 'blocked' || r === 'no_turn') sBlocked();
    return r;
  }
  function wholeNum(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v; }
  function processStep() {
    var sim = st.sim;
    G.beginStep(sim);
    if (replayCur) {
      // Exactly what the validator applies: whole numbers, this step, the next
      // index. Anything else in a stored trace is skipped, as the server refused it.
      var due = replayCur.due(sim.frame);
      for (var di = 0; di < due.length && !sim.dead; di++) {
        var rp = due[di];
        if (wholeNum(rp.n) && wholeNum(rp.a) && wholeNum(rp.step) && rp.step === sim.frame && rp.n === sim.n) applyAct(sim, rp.a, false);
      }
    } else {
      if (buffered && sim.cur) { var b = buffered; buffered = null; applyAct(sim, b.a, true); }
      else if (buffered && sim.frame > buffered.until) buffered = null;
      if (das && sim.frame >= das.next) { pending.push(das.a); das.next = sim.frame + ARR_STEPS; }
      var q = pending; pending = [];
      for (var i = 0; i < q.length && !sim.dead; i++) applyAct(sim, q[i], true);
    }
    if (!sim.dead) G.stepSim(sim);
    handleEvents(sim, st);
    if (RP) RP.report(sim.frame, sim.score);
    var secs = Math.ceil((G.RUN_STEPS - sim.frame) / 60);
    if (secs !== st.lastSec) {
      st.lastSec = secs;
      if (secs <= 10 && secs > 0) sTick(secs <= 3);
      if (secs === 60) { sWarn(); banner = { t: performance.now(), txt: '1 MINUTE LEFT', col: '#ffd27a', size: 34, dur: 1500 }; }
      if (secs === 30) { sWarn(); banner = { t: performance.now(), txt: '30 SECONDS LEFT', col: '#ff7a59', size: 32, dur: 1500 }; }
    }
    if (sim.dead) endRun(sim.end);
  }
  function handleEvents(sim, holder) {
    var now = performance.now();
    for (var i = 0; i < sim.ev.length; i++) {
      var e = sim.ev[i];
      if (e.e === 'spawn') { holder.dispX = sim.cur ? sim.cur.x : 0; holder.dispY = sim.cur ? sim.cur.y : 0; holder.spawnAt = now; if (holder.clearAnim) holder.clearAnim.done = true; }
      else if (e.e === 'lock') onLock(e, holder, now);
      else if (e.e === 'topout') { shake = 6; }
    }
  }
  function onLock(e, holder, now) {
    var cells = G.pieceCells(e.t, e.r), col = COLS_HEX[e.t], botY = 0, i;
    for (i = 0; i < 4; i++) botY = Math.max(botY, e.y + cells[i][1]);
    if (e.hard && holder.dropFrom != null) {
      for (i = 0; i < 4; i++) trails.push({ x: cellX(e.x + cells[i][0]), y0: cellY(holder.dropFrom + cells[i][1]), y1: cellY(e.y + cells[i][1]), col: col, t: now });
      shake = Math.max(shake, 3);
      sHard(e.x);
    }
    holder.dropFrom = null;
    sLock(e.hard, e.x);
    flashes.push({ t: now, cells: cells.map(function (q) { return [e.x + q[0], e.y + q[1]]; }) });
    for (i = 0; i < 4; i++) if (e.y + cells[i][1] === botY) {
      dust(cellX(e.x + cells[i][0]) + CELL / 2, cellY(botY) + CELL, 2);
      if (e.hard) sparks(cellX(e.x + cells[i][0]) + CELL / 2, cellY(botY) + CELL, 4, true);
    }
    if (e.rows.length) {
      for (i = 0; i < e.rows.length; i++) shocks.push({ y: cellY(e.rows[i]) + CELL / 2, t: now + 60 });
      // Rebuild the board as it was the moment the piece landed, for the crumble.
      var before = rebuildBefore(holder === tut ? tut.sim.board : st.sim.board, e);
      holder.clearAnim = { t: now, rows: e.rows, before: before, done: false };
      for (var r = 0; r < e.rows.length; r++) for (var c = 0; c < G.COLS; c++) {
        var v = before[e.rows[r] * G.COLS + c]; crumble(cellX(c) + CELL / 2, cellY(e.rows[r]) + CELL / 2, COLS_HEX[(v || 1) - 1], 0.12 + c * 0.012);
      }
      var cy = cellY(e.rows[0]) + CELL * e.rows.length / 2;
      floats.push({ x: WX + WW / 2, y: cy, txt: '+' + e.gained.toLocaleString('en-US'), t: now, size: e.rows.length === 4 ? 38 : 28, col: e.rows.length === 4 ? C_EMBER : C_INK });
      sClear(e.rows.length, e.combo);
      if (e.rows.length === 4) { sSmash(); shake = 11; flashA = 0.6; flashCol = '#ffb35c'; burst(WX + WW / 2, cy, 60, 520); banner = { t: now, txt: 'SMASH!', col: C_EMBER, size: 78, dur: 1300 }; }
      else if (e.rows.length === 3) { shake = Math.max(shake, 5); burst(WX + WW / 2, cy, 20, 320); }
      else if (e.rows.length === 2) shake = Math.max(shake, 2.5);
      if (e.combo >= 1) holder.comboPop = now;
      if (e.levelUp) { holder.levelPop = now; setTimeout(sLevel, 260); if (e.rows.length !== 4) banner = { t: now + 250, txt: 'LEVEL ' + e.level, col: C_GREEN, size: 50, dur: 1200 }; for (i = 0; i < 12; i++) { sparks(WX + 4, WY + WH - i * 60, 2, true); sparks(WX + WW - 4, WY + WH - i * 60, 2, true); } }
    }
  }
  // The board before the clear: the stored board has the full rows removed, so
  // put back the rows above and the full rows (all filled; colours come from
  // the rows we have, which is close enough for a crumble).
  function rebuildBefore(after, e) {
    var C = G.COLS, rows = e.rows, n = rows.length, out = [], r, c;
    var map = [];   // original row -> after row, or -1 for a cleared row
    var below = 0;
    for (r = G.ROWS - 1; r >= 0; r--) { if (rows.indexOf(r) >= 0) { map[r] = -1; below++; } else map[r] = r + below; }
    for (r = 0; r < G.ROWS; r++) for (c = 0; c < C; c++) out.push(map[r] >= 0 ? after[map[r] * C + c] : 0);
    // the full rows: the landed piece's colour where it sat, otherwise a stable pick
    var cells = G.pieceCells(e.t, e.r);
    for (var k = 0; k < n; k++) for (c = 0; c < C; c++) {
      var v = 0;
      for (var i = 0; i < 4; i++) if (e.x + cells[i][0] === c && e.y + cells[i][1] === rows[k]) v = e.t + 1;
      out[rows[k] * C + c] = v || (1 + ((c * 7 + rows[k] * 3) % 7));
    }
    return out;
  }
  function endRun(reason) {
    if (!st || st.over) return; st.over = true; mode = 'over'; st.endAt = performance.now(); st.endReason = reason === 'topout' ? 'topout' : 'time';
    das = null; pending = []; gesture = null; sEnd();
    submitDone = false;
    setTimeout(submitNow, EMBED ? 2200 : 0);   // the end card is seen before the Result screen
    document.getElementById('overKicker').textContent = st.endReason === 'topout' ? 'WELL FULL' : "TIME'S UP";
    if (EMBED || RP) return;
    setTimeout(function () {
      document.getElementById('finalScore').textContent = st.sim.score.toLocaleString('en-US');
      document.getElementById('finalLines').textContent = st.sim.lines;
      over.classList.remove('is-hidden');
    }, 1600);
  }
  function submitNow() {
    if (submitDone || !st) return; submitDone = true;
    if (RP) RP.setStep(st.sim.frame);
    if (typeof window.__kjSubmit === 'function') window.__kjSubmit(st.sim.score);
  }

  // ---- the practice (HOW TO PLAY): its own board, frozen, emits nothing ----
  function tutBoard(rows) {
    var b = []; for (var i = 0; i < G.COLS * G.ROWS; i++) b.push(0);
    rows.forEach(function (row) { for (var c = row.from; c <= row.to; c++) b[row.r * G.COLS + c] = 1 + ((c * 5 + row.r * 3) % 7); });
    return b;
  }
  function tutSim(board, piece) {
    var s = G.initSim(1);
    s.board = board; s.cur = piece; s.ev = []; s.wait = 0;
    return s;
  }
  function startTut(thenRun) {
    if (RP) return;
    try { if (window.KJTut) window.KJTut.markSeen(); } catch (e) {}
    mode = 'tut';
    tut = { step: 1, thenRun: thenRun, t: performance.now(), dispX: 0, dispY: 0, clearAnim: null, wait: 0, doneAt: 0 };
    tutStep1();
    menu.classList.add('is-hidden'); over.classList.add('is-hidden'); readyBox.classList.add('is-hidden'); skipBtn.classList.remove('is-hidden');
    parts = []; floats = []; trails = []; shocks = []; flashes = []; banner = null;
  }
  function tutStep1() {
    tut.sim = tutSim(tutBoard([{ r: 21, from: 3, to: 9 }, { r: 20, from: 4, to: 9 }, { r: 19, from: 7, to: 9 }]), { t: 6, r: 3, x: 2, y: 9 });
    tut.step = 1; tut.target = { t: 6, r: 0, x: 0, y: 20 }; tut.dispX = 2; tut.dispY = 9; tut.t = performance.now();
  }
  function tutStep4() {
    tut.sim = tutSim(tutBoard([{ r: 21, from: 4, to: 9 }, { r: 20, from: 5, to: 9 }, { r: 19, from: 8, to: 9 }]), { t: 0, r: 0, x: 4, y: 7 });
    tut.step = 4; tut.target = { t: 0, r: 0, x: 0, y: 20 }; tut.dispX = 4; tut.dispY = 7; tut.t = performance.now();
  }
  function tutAct(a) {
    if (!tut || tut.wait) return;
    var s = tut.sim; G.beginStep(s);
    if (a === G.A_SOFT_ON || a === G.A_SOFT_OFF) return;   // not taught here
    if (a === G.A_HARD) tut.dropFrom = s.cur ? s.cur.y : null;
    var r = applyAct(s, a, false);
    if (r !== true) return;
    if (a === G.A_HARD) {
      var e = s.ev[s.ev.length - 1];
      handleEvents(s, tut);
      var cleared = e && e.rows && e.rows.length;
      var now = performance.now();
      if (tut.step === 4 && cleared) { tut.wait = 1; setTimeout(tutReady, 900); }
      else if (tut.step === 4) { tut.wait = 1; setTimeout(function () { if (mode === 'tut') { tut.wait = 0; tutStep4(); } }, 700); }
      else { tut.wait = 1; setTimeout(function () { if (mode === 'tut') { tut.wait = 0; tutStep4(); } }, cleared ? 900 : 600); }
      return;
    }
    if (tut.step === 1 && s.cur.x === 0) { tut.step = 2; tut.t = performance.now(); }
    else if (tut.step === 2 && s.cur.r === 0) { tut.step = 3; tut.t = performance.now(); }
  }
  function tutReady() {
    if (mode !== 'tut') return;
    tut.step = 5; tut.sim.cur = null; skipBtn.classList.add('is-hidden');
    readyBox.classList.remove('is-hidden'); setPlayBtn(); sReady();
  }
  function endTut(play) {
    readyBox.classList.add('is-hidden'); skipBtn.classList.add('is-hidden');
    tut = null; mode = 'menu'; parts = []; floats = []; trails = []; shocks = []; flashes = [];
    if (play && sessionReady) newRun();
    else menu.classList.remove('is-hidden');
  }

  // ---- input ----
  function designPt(e) { return KJFit.toDesign(fit, e.clientX, e.clientY); }
  if (window.KJPress) {
    window.KJPress.bind(function (e) {
      if (mode !== 'play' && mode !== 'tut') return;
      var p = designPt(e);
      gesture = { id: e.pointerId, x: p.x, y: p.y, t: performance.now(), used: false, soft: false, travel: 0, axis: '', ax: p.x };
    }, { keys: [], ignore: function (e) { return e.target !== canvas; } });
  }
  window.addEventListener('pointermove', function (e) {
    if (!gesture || e.pointerId !== gesture.id || gesture.used) return;
    var p = designPt(e), dx = p.x - gesture.x, dy = p.y - gesture.y;
    gesture.travel = Math.max(gesture.travel, Math.sqrt(dx * dx + dy * dy));
    // A sideways drag moves the piece one column for every MOVE_PX the finger travels.
    if (!gesture.axis && !gesture.soft && Math.abs(dx) > AXIS_PX && Math.abs(dx) > Math.abs(dy)) gesture.axis = 'h';
    if (gesture.axis === 'h') {
      while (p.x - gesture.ax >= MOVE_PX) { gesture.ax += MOVE_PX; act(G.A_RIGHT); }
      while (gesture.ax - p.x >= MOVE_PX) { gesture.ax -= MOVE_PX; act(G.A_LEFT); }
      return;
    }
    if (!gesture.soft && dy > SWIPE_DY && dy > Math.abs(dx) * 1.4 && performance.now() - gesture.t < SWIPE_MS) {
      gesture.used = true; hardDrop();
    }
  });
  function hardDrop() {
    var s = mode === 'tut' ? (tut && tut.sim) : (st && st.sim);
    if (mode === 'play' && st && s && s.cur) st.dropFrom = s.cur.y;
    act(G.A_HARD);
  }
  function gestureEnd(e, cancelled) {
    if (!gesture || e.pointerId !== gesture.id) return;
    var g = gesture; gesture = null;
    if (g.soft) { act(G.A_SOFT_OFF); return; }
    if (g.used || g.axis || cancelled || g.travel > TAP_MOVE) return;
    tapMark = { t: performance.now(), x: g.x, y: g.y };
    act(G.A_CW);
  }
  window.addEventListener('pointerup', function (e) { gestureEnd(e, false); });
  window.addEventListener('pointercancel', function (e) { gestureEnd(e, true); });
  function checkSoftHold(now) {
    if (!gesture || gesture.used || gesture.soft) return;
    if (now - gesture.t >= SOFT_MS && gesture.travel <= TAP_MOVE) { gesture.soft = true; act(G.A_SOFT_ON); }
  }
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  var KEYMAP = { ArrowLeft: 'L', KeyA: 'L', ArrowRight: 'R', KeyD: 'R', ArrowUp: 'CW', KeyX: 'CW', KeyW: 'CW', KeyZ: 'CCW', ControlLeft: 'CCW', ControlRight: 'CCW', ArrowDown: 'SOFT', KeyS: 'SOFT', Space: 'HARD' };
  window.addEventListener('keydown', function (e) {
    var k = KEYMAP[e.code]; if (!k || e.metaKey) return;
    if (mode !== 'play' && mode !== 'tut') return;
    e.preventDefault(); if (e.repeat) return;
    var s = mode === 'tut' ? (tut && tut.sim) : (st && st.sim);
    if (k === 'L' || k === 'R') { var a = k === 'L' ? G.A_LEFT : G.A_RIGHT; act(a); if (mode === 'play' && s) das = { a: a, code: e.code, next: s.frame + DAS_STEPS }; }
    else if (k === 'CW') act(G.A_CW);
    else if (k === 'CCW') act(G.A_CCW);
    else if (k === 'SOFT') act(G.A_SOFT_ON);
    else if (k === 'HARD') hardDrop();
  });
  window.addEventListener('keyup', function (e) {
    var k = KEYMAP[e.code]; if (!k) return;
    if (das && das.code === e.code) das = null;
    if (k === 'SOFT') act(G.A_SOFT_OFF);
  });
  window.addEventListener('blur', function () { das = null; if (st && st.sim && st.sim.soft) act(G.A_SOFT_OFF); });
  playBtn.addEventListener('click', function () {
    unlock();
    // newRun itself waits for the session; the practice may open before it.
    var showTut = !RP && !Q.match(/[?&]tut=0/) && window.KJTut && window.KJTut.shouldShow();
    if (showTut) startTut(true); else newRun();
  });
  howBtn.addEventListener('click', function () { unlock(); startTut(false); });
  skipBtn.addEventListener('click', function () { var go = tut && tut.thenRun; endTut(!!go); });
  readyBtn.addEventListener('click', function () { unlock(); if (!sessionReady) return; endTut(true); });
  document.getElementById('againBtn').addEventListener('click', function () { standaloneSeed = (Math.random() * 1e9) >>> 0; unlock(); newRun(); });

  // ---- drawing ----
  function txt(s, x, y, size, col, align) {
    ctx.font = size + 'px ' + FONT; ctx.textAlign = align || 'center';
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillText(s, x, y + Math.max(2, size * 0.07));
    ctx.fillStyle = col; ctx.fillText(s, x, y);
  }
  function outlined(s, x, y, size, col) {
    ctx.font = size + 'px ' + FONT; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(5, size * 0.16); ctx.strokeStyle = '#0d0f13'; ctx.strokeText(s, x, y + size * 0.07); ctx.strokeText(s, x, y);
    ctx.fillStyle = col; ctx.fillText(s, x, y);
  }
  // A flat charcoal plate; it warms at the edge when something happens in it.
  function panel(x, y, w, h, hot) {
    rr(ctx, x, y, w, h, 16); ctx.fillStyle = '#1c1f27'; ctx.fill();
    if (hot) { ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,179,71,' + hot + ')'; rr(ctx, x + 1, y + 1, w - 2, h - 2, 15); ctx.stroke(); }
  }
  function label(s, x, y, col, align) { ctx.font = '11px ' + FONT; ctx.textAlign = align || 'center'; ctx.fillStyle = col || C_LABEL; ctx.letterSpacing = '1px'; ctx.fillText(s, x, y); }
  // A whole piece as small bricks, centred on (cx, cy).
  function drawMini(t, cx, cy, size, alpha) {
    var c = G.pieceCells(t, 0), minX = 9, maxX = -9, minY = 9, maxY = -9, i;
    for (i = 0; i < 4; i++) { minX = Math.min(minX, c[i][0]); maxX = Math.max(maxX, c[i][0]); minY = Math.min(minY, c[i][1]); maxY = Math.max(maxY, c[i][1]); }
    var w = (maxX - minX + 1) * size, h = (maxY - minY + 1) * size;
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    for (i = 0; i < 4; i++) ctx.drawImage(minis[t], cx - w / 2 + (c[i][0] - minX) * size, cy - h / 2 + (c[i][1] - minY) * size, size, size);
    ctx.globalAlpha = 1;
  }
  function drawBoard(board, skipRows) {
    for (var r = G.HIDDEN; r < G.ROWS; r++) {
      if (skipRows && skipRows.indexOf(r) >= 0) continue;
      for (var c = 0; c < G.COLS; c++) { var v = board[r * G.COLS + c]; if (v) blitTL(bricks[v - 1], cellX(c), cellY(r)); }
    }
  }
  function drawPiece(p, dx, dy, img) {
    var c = G.pieceCells(p.t, p.r);
    for (var i = 0; i < 4; i++) {
      var y = dy + c[i][1]; if (y < G.HIDDEN - 0.99) continue;
      blitTL(img[p.t], cellX(dx + c[i][0]), cellY(y));
    }
  }
  function stackTop(board) {
    for (var r = 0; r < G.ROWS; r++) for (var c = 0; c < G.COLS; c++) if (board[r * G.COLS + c]) return r;
    return G.ROWS;
  }
  function drawWell(holder, sim, now, dt) {
    blitTL(wellImg.cv, WX - wellImg.m, WY - wellImg.m);
    ctx.save(); ctx.beginPath(); ctx.rect(WX, WY, WW, WH); ctx.clip();
    // the kiln breathes: a slow glow at the floor
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3 + 0.12 * Math.sin(now / 900) + 0.05 * Math.sin(now / 263);
    ctx.drawImage(SPR.heat, WX, WY + WH - 200, WW, 200);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    var ca = holder.clearAnim;
    if (ca && !ca.done) {
      // The landed board: full rows go white-hot, then crumble away while the rest settles.
      var u = Math.min(1, (now - ca.t) / 400), fall = u < 0.45 ? 0 : ease((u - 0.45) / 0.55);
      for (var r = G.HIDDEN; r < G.ROWS; r++) {
        var gone = ca.rows.indexOf(r) >= 0, below = 0;
        for (var k = 0; k < ca.rows.length; k++) if (ca.rows[k] > r) below++;
        for (var c = 0; c < G.COLS; c++) {
          var v = ca.before[r * G.COLS + c]; if (!v) continue;
          if (gone) {
            if (u < 0.32) {
              blitTL(bricks[v - 1], cellX(c), cellY(r));
              ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.9 * Math.sin(u / 0.32 * Math.PI);
              ctx.drawImage(SPR.hot, cellX(c), cellY(r), CELL, CELL); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
            }
          } else blitTL(bricks[v - 1], cellX(c), cellY(r) + below * CELL * fall);
        }
      }
      if (u >= 1) ca.done = true;
    } else drawBoard(sim.board);
    // lock flashes: the cells a piece just landed on blink hot
    flashes = flashes.filter(function (f) { return now - f.t < 180; });
    if (flashes.length) {
      ctx.globalCompositeOperation = 'lighter';
      flashes.forEach(function (f) { ctx.globalAlpha = 0.6 * (1 - (now - f.t) / 180); for (var i = 0; i < f.cells.length; i++) ctx.drawImage(SPR.hot, cellX(f.cells[i][0]), cellY(f.cells[i][1]), CELL, CELL); });
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    // the ghost and the piece
    if (sim.cur) {
      var k2 = Math.min(1, dt * 28);
      holder.dispX += (sim.cur.x - holder.dispX) * k2; holder.dispY += (sim.cur.y - holder.dispY) * k2;
      if (Math.abs(sim.cur.x - holder.dispX) < 0.02 || Math.abs(sim.cur.x - holder.dispX) > 3) holder.dispX = sim.cur.x;
      if (Math.abs(sim.cur.y - holder.dispY) < 0.02 || Math.abs(sim.cur.y - holder.dispY) > 3) holder.dispY = sim.cur.y;
      var gd = G.dropDistance(sim.board, sim.cur);
      if (gd > 0) drawPiece(sim.cur, sim.cur.x, sim.cur.y + gd, ghosts);
      // a warm halo around the falling piece, brighter just after it spawns
      var cc = G.pieceCells(sim.cur.t, sim.cur.r), sp = Math.max(0, 1 - (now - (holder.spawnAt || 0)) / 250);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35 + 0.5 * sp;
      for (var q = 0; q < 4; q++) { var gy = holder.dispY + cc[q][1]; if (gy >= G.HIDDEN - 0.99) ctx.drawImage(glows[sim.cur.t], cellX(holder.dispX + cc[q][0]) - CELL / 2, cellY(gy) - CELL / 2, CELL * 2, CELL * 2); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      drawPiece(sim.cur, holder.dispX, holder.dispY, bricks);
      var lockGlow = sim.lockT > 0 ? sim.lockT / G.LOCK_STEPS : 0;
      if (lockGlow > 0) {   // a landed piece heats up as its lock wait runs out
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35 * lockGlow;
        for (var q2 = 0; q2 < 4; q2++) ctx.drawImage(SPR.hot, cellX(holder.dispX + cc[q2][0]), cellY(holder.dispY + cc[q2][1]), CELL, CELL);
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      }
    }
    // hard-drop streaks
    trails = trails.filter(function (t) { return now - t.t < 240; });
    if (trails.length) {
      ctx.globalCompositeOperation = 'lighter';
      trails.forEach(function (t) { ctx.globalAlpha = 0.75 * (1 - (now - t.t) / 240); ctx.drawImage(SPR.streak, t.x + 5, t.y0, CELL - 10, t.y1 - t.y0 + CELL); });
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    // shock lines across cleared rows
    shocks = shocks.filter(function (s) { return now - s.t < 380; });
    if (shocks.length) {
      ctx.globalCompositeOperation = 'lighter';
      shocks.forEach(function (s) { var su = (now - s.t) / 380; if (su < 0) return; var hh = CELL * (0.6 + 2.2 * ease(su)); ctx.globalAlpha = (1 - su) * 0.9; ctx.drawImage(SPR.shock, WX, s.y - hh / 2, WW, hh); });
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    // danger: the stack is close to the top
    var top = stackTop(sim.board);
    if (top < G.HIDDEN + 5 && mode === 'play') {
      ctx.globalAlpha = Math.min(1, (G.HIDDEN + 5 - top) / 5) * (0.55 + 0.45 * Math.sin(now / 180));
      ctx.drawImage(SPR.danger, WX, WY, WW, 130); ctx.globalAlpha = 1;
    }
    if (st && sim === st.sim && !st.over) {
      var left = Math.ceil((G.RUN_STEPS - sim.frame) / 60);
      if (left <= 10 && left > 0) {
        var cu2 = ((G.RUN_STEPS - sim.frame) % 60) / 60, cs2 = 0.85 + 0.25 * cu2;
        ctx.save(); ctx.globalAlpha = 0.12 + 0.2 * cu2; ctx.translate(WX + WW / 2, WY + WH * 0.5); ctx.scale(cs2, cs2);
        ctx.font = '200px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = C_HOT; ctx.fillText(String(left), 0, 0); ctx.restore();
      }
    }
    // combo badge, top right inside the well
    var hd = st && sim === st.sim ? st : tut;
    if (sim.combo >= 1 && hd) {
      var cu = Math.min(1, (now - (hd.comboPop || 0)) / 300), cs = 0.7 + 0.3 * backOut(cu);
      ctx.save(); ctx.translate(WX + WW - 58, WY + 44); ctx.scale(cs, cs);
      label('COMBO', 0, -20, C_EMBER);
      outlined('x' + sim.combo, 0, 14, 34, sim.combo >= 4 ? '#ff9ad0' : C_EMBER);
      ctx.restore();
    }
    ctx.restore();
    // the fuse: time left burns along the well's top rim
    if (st && sim === st.sim) {
      var frac = Math.max(0, G.RUN_STEPS - sim.frame) / G.RUN_STEPS, fx = WX + WW * frac, secs = Math.ceil((G.RUN_STEPS - sim.frame) / 60);
      ctx.fillStyle = 'rgba(255,255,255,.08)'; rr(ctx, WX, WY - 7, WW, 5, 2.5); ctx.fill();
      ctx.fillStyle = secs <= 30 ? C_HOT : C_EMBER; if (fx - WX > 1) { rr(ctx, WX, WY - 7, fx - WX, 5, 2.5); ctx.fill(); }
      if (frac > 0 && !st.over) {
        var fl = 1 + 0.35 * Math.sin(now / 45) + 0.2 * Math.sin(now / 17);
        ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(SPR.ember, fx - 10 * fl, WY - 4.5 - 10 * fl, 20 * fl, 20 * fl); ctx.globalCompositeOperation = 'source-over';
      }
    }
  }
  function drawHud(sim, now) {
    var holder = st && sim === st.sim ? st : tut;
    // score on the left, the clock on the right, level progress along the bottom
    var B = SCORE_BOX, L = B.x + 14, Rt = B.x + B.w - 14;
    panel(B.x, B.y, B.w, B.h);
    var sc = sim ? sim.score : 0;
    if (st && sim === st.sim) {
      if (sc !== st.scoreTarget) { st.scoreTarget = sc; st.bump = 1; }
      st.scoreShown += (sc - st.scoreShown) * 0.18; if (Math.abs(sc - st.scoreShown) < 1) st.scoreShown = sc; st.bump *= 0.88;
    }
    label('SCORE', L, B.y + 19, null, 'left');
    ctx.save(); ctx.translate(L, B.y + 49); var bs = 1 + 0.12 * (st && sim === st.sim ? st.bump : 0); ctx.scale(bs, bs);
    txt(Math.round(st && sim === st.sim ? st.scoreShown : sc).toLocaleString('en-US'), 0, 0, 25, C_INK, 'left'); ctx.restore();
    // the clock: big; amber at 1 minute, red at 30 seconds, pulsing at 10
    var rem = sim ? Math.max(0, G.RUN_STEPS - sim.frame) : G.RUN_STEPS, secs = Math.ceil(rem / 60);
    var tcol = secs <= 30 ? C_HOT : secs <= 60 ? C_EMBER : C_INK;
    var pulse = (mode === 'play' && secs <= 10) ? 1.08 + 0.08 * Math.abs(Math.sin(now / 160)) : 1;
    label('TIME', Rt, B.y + 19, null, 'right');
    ctx.save(); ctx.translate(Rt, B.y + 49); ctx.scale(pulse, pulse);
    txt(Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2), 0, 0, 25, tcol, 'right');
    ctx.restore();
    var lvl = sim ? sim.level : 1, lines = sim ? sim.lines : 0, prog = (lines % 10) / 10, pw = B.w - 28 - 44;
    rr(ctx, L, B.y + 60, pw, 5, 2.5); ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fill();
    if (prog > 0) { rr(ctx, L, B.y + 60, Math.max(5, pw * prog), 5, 2.5); ctx.fillStyle = C_GREEN; ctx.fill(); }
    var lp = Math.min(1, (now - ((holder && holder.levelPop) || 0)) / 400), ls = 1 + 0.35 * Math.sin(lp * Math.PI);
    ctx.save(); ctx.translate(Rt, B.y + 67); ctx.scale(ls, ls); txt('LV ' + lvl, 0, 0, 13, C_GREEN, 'right'); ctx.restore();
    // next three, sliding left when a piece is taken
    var N = NEXT_BOX; panel(N.x, N.y, N.w, N.h); label('NEXT', N.x + N.w / 2, N.y + 19);
    var slide = holder && holder.spawnAt ? (1 - ease(Math.min(1, (now - holder.spawnAt) / 200))) : 0;
    var slots = [{ x: N.x + 38, s: 14, a: 1 }, { x: N.x + 92, s: 10, a: 0.8 }, { x: N.x + 129, s: 8, a: 0.6 }];
    var ts = null;
    if (sim && st && sim === st.sim) ts = [G.pieceAt(sim.seed, sim.k), G.pieceAt(sim.seed, sim.k + 1), G.pieceAt(sim.seed, sim.k + 2)];
    else if (tut) ts = [2, 5, 3];
    if (ts) {
      ctx.save(); rr(ctx, N.x + 2, N.y + 22, N.w - 4, N.h - 24, 10); ctx.clip();
      for (var i = 0; i < 3; i++) drawMini(ts[i], slots[i].x + slide * 40, N.y + 50, slots[i].s, slots[i].a * (i === 2 ? 1 - slide : 1));
      ctx.restore();
    }
  }
  function drawHand(x, y, press, a) {
    if (!handImg) buildHand();
    var sc = 0.7; ctx.globalAlpha = a == null ? 1 : a;
    ctx.drawImage(handImg, x - 24.5 * sc, y - 12 * sc + press * 8, HAND_W * sc, HAND_H * sc);
    ctx.globalAlpha = 1;
  }
  function tapRipple(x, y, k) {
    if (k < 0.2 || k > 0.75) return; var q = (k - 0.2) / 0.55;
    ctx.strokeStyle = 'rgba(255,210,122,' + (0.8 * (1 - q)) + ')'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, 8 + q * 34, 0, 6.2832); ctx.stroke();
  }
  function caption(s, x, y) {
    ctx.font = '22px ' + FONT; var w = ctx.measureText(s).width + 28;
    rr(ctx, x - w / 2, y - 22, w, 36, 18); ctx.fillStyle = 'rgba(28,31,39,.95)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = C_EMBER; ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = C_INK; ctx.fillText(s, x, y + 4);
  }
  function drawTutorial(now) {
    var s = tut.sim, k = ((now - tut.t) % 1100) / 1100, press = k < 0.25 ? k / 0.25 : k < 0.5 ? 1 - (k - 0.25) / 0.25 : 0;
    var tg = tut.target, MX = W / 2;
    if (s.cur && tut.step <= 4 && !tut.wait) {   // where the piece should go, pulsing
      ctx.save(); ctx.beginPath(); ctx.rect(WX, WY, WW, WH); ctx.clip();
      var c = G.pieceCells(tg.t, tg.r), pa = 0.22 + 0.16 * Math.sin(now / 220);
      ctx.fillStyle = 'rgba(255,214,140,' + pa + ')';
      for (var i = 0; i < 4; i++) { rr(ctx, cellX(tg.x + c[i][0]) + 2, cellY(tg.y + c[i][1]) + 2, CELL - 4, CELL - 4, 6); ctx.fill(); }
      ctx.restore();
    }
    if (tut.wait || tut.step > 4) return;
    var pY = cellY(s.cur ? s.cur.y : 9);
    if (tut.step === 1) {
      // a sideways drag: the hand slides left and lifts
      var u1 = ((now - tut.t) % 1300) / 1300, hy = pY + 170, sx1 = W * 0.64, ex1 = W * 0.3, hx = sx1 + (ex1 - sx1) * ease(Math.min(1, u1 / 0.6));
      var a1 = u1 < 0.75 ? 1 : 1 - (u1 - 0.75) / 0.25;
      ctx.globalAlpha = a1 * 0.6; ctx.drawImage(SPR.dragH, hx, hy - 52, Math.max(1, sx1 - hx), 14); ctx.globalAlpha = 1;
      drawHand(hx, hy - 45, 0, a1);
      caption('Swipe to move', MX, hy + 70);
    } else if (tut.step === 2) {
      var my = pY + 170;
      tapRipple(MX, my, k); drawHand(MX, my, press);
      caption('Tap to rotate', MX, my + 96);
    } else if (tut.step === 3) {
      var u = ((now - tut.t) % 1300) / 1300, sy = pY + 100, ey = sy + 130, yy = sy + (ey - sy) * ease(Math.min(1, u / 0.6));
      var al = u < 0.75 ? 1 : 1 - (u - 0.75) / 0.25;
      ctx.globalAlpha = al * 0.6; ctx.drawImage(SPR.streak, MX - 7, sy, 14, Math.max(1, yy - sy)); ctx.globalAlpha = 1;
      drawHand(MX, yy, 0, al);
      caption('Swipe down to drop', MX, ey + 96);
    } else if (tut.step === 4) {
      caption('Fill a row', WX + 84, cellY(21) - 44);
      ctx.fillStyle = C_EMBER; ctx.beginPath(); var ax = WX + 66, ay = cellY(21) - 16 + 4 * Math.sin(now / 160);
      ctx.moveTo(ax - 10, ay - 7); ctx.lineTo(ax + 10, ay - 7); ctx.lineTo(ax, ay + 7); ctx.closePath(); ctx.fill();
    }
  }
  // Embers drifting up the kiln wall, behind the well.
  function drawAmbient(now, dt) {
    if (!embers) {
      embers = [];
      for (var i = 0; i < 34; i++) embers.push({ x: R(fit.visLeft, fit.visRight), y: R(fit.visTop, fit.visBottom), vy: R(-38, -14), ph: R(0, 6.28), sz: R(4, 10), a: R(0.25, 0.7) });
    }
    ctx.globalCompositeOperation = 'lighter';
    for (var j = 0; j < embers.length; j++) {
      var e = embers[j];
      e.y += e.vy * dt; e.x += Math.sin(now / 700 + e.ph) * 12 * dt;
      if (e.y < fit.visTop - 10) { e.y = fit.visBottom + 10; e.x = R(fit.visLeft, fit.visRight); }
      ctx.globalAlpha = 0.45 * e.a * (0.6 + 0.4 * Math.sin(now / 240 + e.ph));
      ctx.drawImage(SPR.ember, e.x - e.sz / 2, e.y - e.sz / 2, e.sz, e.sz);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  function drawEffects(now, dt) {
    ctx.globalCompositeOperation = 'source-over';
    parts = parts.filter(function (p) { p.age += dt; if (p.age >= p.life) return false; if (p.age < 0) return true; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.k === 0) p.rot += p.vr * dt; return true; });
    var i, p, u;
    for (i = 0; i < parts.length; i++) {
      p = parts[i]; if (p.age < 0 || p.k === 2) continue; u = p.age / p.life;
      if (p.k === 0) {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(1, (1 - u) * 1.4);
        ctx.fillStyle = p.col; ctx.fillRect(-p.sz / 2, -p.sz / 2, p.sz, p.sz * 0.75);
        ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.fillRect(-p.sz / 2, -p.sz / 2, p.sz, p.sz * 0.18);
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(-p.sz / 2, p.sz * 0.1, p.sz, p.sz * 0.15); ctx.restore();
      } else { ctx.globalAlpha = (1 - u) * 0.4; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.sz * (0.6 + u * 0.8), 0, 6.2832); ctx.fill(); }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < parts.length; i++) {
      p = parts[i]; if (p.age < 0 || p.k !== 2) continue; u = p.age / p.life;
      var sz = p.sz * (1 - u * 0.6); ctx.globalAlpha = 1 - u; ctx.drawImage(SPR.ember, p.x - sz / 2, p.y - sz / 2, sz, sz);
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    floats = floats.filter(function (f) { return now - f.t < 950; });
    floats.forEach(function (f) { var fu = (now - f.t) / 950; ctx.globalAlpha = fu > 0.6 ? (1 - fu) / 0.4 : 1; var s4 = fu < 0.15 ? 0.6 + 0.4 * backOut(fu / 0.15) : 1; ctx.save(); ctx.translate(f.x, f.y - 56 * ease(fu)); ctx.scale(s4, s4); outlined(f.txt, 0, 0, f.size, f.col || C_INK); ctx.restore(); });
    ctx.globalAlpha = 1;
    if (tapMark) {   // a soft ring where the tap landed
      var tu = (now - tapMark.t) / 220; if (tu >= 1) tapMark = null;
      else { ctx.strokeStyle = 'rgba(255,226,184,' + (0.5 * (1 - tu)) + ')'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(tapMark.x, tapMark.y, 10 + 26 * ease(tu), 0, 6.2832); ctx.stroke(); }
    }
    if (banner) {
      var bu = (now - banner.t) / (banner.dur || 1000);
      if (bu >= 1) banner = null;
      else if (bu >= 0) { var bs = backOut(Math.min(1, bu * 4)), ba = bu > 0.65 ? (1 - bu) / 0.35 : 1; ctx.globalAlpha = ba; ctx.save(); ctx.translate(WX + WW / 2, WY + WH * 0.4); ctx.scale(bs, bs); outlined(banner.txt, 0, 0, banner.size || 54, banner.col); ctx.restore(); ctx.globalAlpha = 1; }
    }
  }
  function drawEnd(now) {
    if (!st || !st.over) return;
    var eu = Math.min(1, (now - st.endAt) / 350), top = st.endReason === 'topout';
    ctx.globalAlpha = 0.8 * eu; ctx.fillStyle = '#0d0f13'; ctx.fillRect(WX, WY, WW, WH);
    ctx.globalAlpha = eu; ctx.save(); ctx.translate(WX + WW / 2, WY + WH / 2); var es = 0.7 + 0.3 * backOut(eu); ctx.scale(es, es);
    rr(ctx, -140, -92, 280, 190, 26); ctx.fillStyle = 'rgba(28,31,39,.97)'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = top ? C_HOT : C_EMBER; ctx.stroke();
    outlined(top ? 'WELL FULL' : "TIME'S UP", 0, -34, 40, top ? C_HOT : C_EMBER);
    ctx.font = '16px ' + FONT; ctx.textAlign = 'center'; ctx.fillStyle = '#9aa1b2'; ctx.fillText(st.sim.lines + ' rows cleared', 0, 4);
    outlined(st.sim.score.toLocaleString('en-US'), 0, 62, 44, C_INK);
    ctx.restore(); ctx.globalAlpha = 1;
  }
  var demoSim = null;
  function render(now, dt) {
    if (!bricks) resize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(backImg, 0, 0);
    nudgeX *= 0.7;
    var shx = 0, shy = 0; if (shake > 0.15) { shx = R(-shake, shake); shy = R(-shake, shake); shake *= 0.86; } else shake = 0;
    design(); drawAmbient(now, dt);
    ctx.setTransform(K, 0, 0, K, fit.offX * DPR + (shx + nudgeX) * K, fit.offY * DPR + shy * K);
    var origDesign = design;
    design = function () { ctx.setTransform(K, 0, 0, K, fit.offX * DPR + (shx + nudgeX) * K, fit.offY * DPR + shy * K); };
    var sim, holder;
    if (mode === 'tut' && tut) { sim = tut.sim; holder = tut; }
    else if (st) { sim = st.sim; holder = st; }
    else { if (!demoSim) demoSim = tutSim(tutBoard([{ r: 21, from: 0, to: 8 }, { r: 20, from: 0, to: 6 }, { r: 19, from: 1, to: 4 }, { r: 18, from: 2, to: 3 }]), null); sim = demoSim; holder = { dispX: 0, dispY: 0 }; }
    drawHud(sim === demoSim ? null : sim, now);
    drawWell(holder, sim, now, dt);
    if (mode === 'tut' && tut) drawTutorial(now);
    drawEffects(now, dt);
    drawEnd(now);
    design = origDesign;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (flashA > 0.01) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = flashA * 0.3; ctx.fillStyle = flashCol; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; flashA *= 0.88; }
    if (mode === 'play' && st && st.lastSec <= 10) { ctx.globalAlpha = 0.12 + 0.14 * Math.abs(Math.sin(now / 220)); ctx.drawImage(vig, 0, 0, canvas.width, canvas.height); ctx.globalAlpha = 1; }
  }
  // ---- the clock: fixed 1/60 s steps that follow the wall clock ----
  var acc = 0, lastT = null, lastFrame = null;
  function pump(now) {
    if (lastT === null) lastT = now;
    var dtr = (now - lastT) / 1000; lastT = now;
    // No catch-up cap: a hidden tab still counts down, and the timer below keeps it moving.
    acc += RP ? RP.elapsed(dtr * 1000, 1e9) / 1000 : dtr;
    if (mode === 'play' && st && !st.over) {
      while (acc >= 1 / 60) { acc -= 1 / 60; processStep(); if (st.over) break; }
    } else acc = 0;
  }
  function frame(now) {
    var dt = lastFrame === null ? 0.016 : Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
    checkSoftHold(now);
    pump(now); resize(); render(now, dt); requestAnimationFrame(frame);
  }
  setInterval(function () { if (document.hidden) pump(performance.now()); }, 1000);   // hidden tabs: the run still ends and submits
  function onSessionReady() {
    sessionReady = true; setPlayBtn();
    if (RP) { newRun(); }
  }
  setPlayBtn();
  if (typeof window.__kjOnSessionReady === 'function') window.__kjOnSessionReady(onSessionReady); else onSessionReady();
  if (RP) menu.classList.add('is-hidden');
  if (!EMBED) window.__ts = { get st() { return st; }, get tut() { return tut; }, get mode() { return mode; }, act: act, G: G,
    sfx: { move: sMove, turn: sTurn, blocked: sBlocked, lock: function () { sLock(false); }, hardDrop: function () { sHard(); sLock(true); }, clear1: function () { sClear(1, 0); }, clear2: function () { sClear(2, 0); }, clear3: function () { sClear(3, 0); }, combo3: function () { sClear(1, 3); }, smash: function () { sClear(4, 0); sSmash(); }, levelUp: sLevel, tick: function () { sTick(false); }, lastTicks: function () { sTick(true); }, warn: sWarn, start: sStart, end: sEnd, ready: sReady } };
  resize(); requestAnimationFrame(frame);
})();
