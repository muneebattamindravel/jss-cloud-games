// Bo Kaata: the client. The rules (js/rules.js, PK) decide everything that
// can change a score; this file only feeds them the finger and draws.
(function () {
  'use strict';

  var EMBED = !!window.__kjEmbed;
  var Q = EMBED ? '' : location.search;            // testing switches: standalone only
  var U = PK.U, FW = PK.FW, FH = PK.FH;
  var STEP_MS = 1000 / 60, MAX_CATCHUP = 3;
  var SUBMIT_AFTER_MS = 1700;
  var RP = (window.KJReplay && window.KJReplay.active()) ? window.KJReplay : null, replayCur = null;   // admin run viewer
  if (RP) RP.ready('bo-kaata');                       // the cut kite falls, then the score goes

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var $ = function (id) { return document.getElementById(id); };
  var menuEl = $('menu'), playBtn = $('playBtn'), playLabel = $('playLabel'), learnBtn = $('learnBtn');
  var scoreEl = $('score'), heartsEl = $('hearts'), overEl = $('gameOver'), finalEl = $('finalScore');
  var pskip = $('pskip'), pplay = $('pplay');

  var state = 'menu';         // menu | prac | play | dying | over
  var sim = null, prev = null, acc = 0, fxAcc = 0, lastT = null;
  var fit = null, dpr = 1, boxW = 0, boxH = 0;

  function randomSeed() { var s = ''; for (var i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16); return s; }
  function qp(name) { try { return new URLSearchParams(Q).get(name); } catch (_e) { return null; } }

  // ── fit and layers ─────────────────────────────────────────────────────
  var sky = null, roof = null, farKites = null;
  function resize() {
    var w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    var d = Math.min(2, window.devicePixelRatio || 1);
    if (w === boxW && h === boxH && d === dpr && fit) return;
    boxW = w; boxH = h; dpr = d;
    canvas.width = Math.round(w * d); canvas.height = Math.round(h * d);
    fit = KJFit.compute({ boxW: w, boxH: h, W: FW, H: FH, bandTop: 30, bandBottom: FH, anchor: 'bottom' });
    buildLayers();
  }
  function layer(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }

  function buildLayers() {
    var s = fit.s * dpr, vw = (fit.visRight - fit.visLeft), vh = (fit.visBottom - fit.visTop);
    // sky: a warm Basant afternoon, painted once per resize at screen resolution
    sky = layer(vw * s, vh * s);
    var g = sky.getContext('2d'); g.scale(s, s); g.translate(-fit.visLeft, -fit.visTop);
    var gr = g.createLinearGradient(0, fit.visTop, 0, FH);
    gr.addColorStop(0, '#6fb4ea'); gr.addColorStop(0.42, '#a9d3ef'); gr.addColorStop(0.72, '#ffd7a8'); gr.addColorStop(1, '#ffab6e');
    g.fillStyle = gr; g.fillRect(fit.visLeft, fit.visTop, vw, vh);
    var sun = g.createRadialGradient(330, 520, 4, 330, 520, 170);
    sun.addColorStop(0, 'rgba(255,248,214,0.95)'); sun.addColorStop(0.18, 'rgba(255,236,170,0.6)'); sun.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = sun; g.fillRect(fit.visLeft, fit.visTop, vw, vh);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    [[70, 140, 1], [300, 90, 0.8], [220, 260, 0.6], [-30, 330, 0.7], [400, 210, 0.9]].forEach(function (c) { cloud(g, c[0], c[1], c[2]); });
    skyline(g);

    // far-off kites: a strip twice the field wide that drifts slowly
    farKites = layer(FW * 2 * s, 420 * s);
    var fk = farKites.getContext('2d'); fk.scale(s, s);
    var cols = ['#e63946', '#2a9d8f', '#f4a261', '#7b2cbf', '#118ab2', '#ef476f', '#06d6a0'];
    for (var i = 0; i < 30; i++) {
      var x = (i * 173) % (FW * 2), y = 20 + ((i * 97) % 380), k = 3 + (i % 4);
      fk.save(); fk.translate(x, y); fk.rotate(((i * 37) % 30 - 15) / 60);
      fk.globalAlpha = 0.2 + (i % 3) * 0.08;
      fk.fillStyle = cols[i % cols.length];
      fk.beginPath(); fk.moveTo(0, -k * 1.2); fk.lineTo(k, 0); fk.lineTo(0, k * 1.3); fk.lineTo(-k, 0); fk.closePath(); fk.fill();
      fk.strokeStyle = 'rgba(80,40,60,0.35)'; fk.lineWidth = 0.6; fk.beginPath(); fk.moveTo(0, k * 1.3); fk.lineTo(-2, k * 1.3 + 22 + (i % 5) * 8); fk.stroke();
      fk.restore();
    }

    // the rooftops in front: parapets, water tanks, a stair room, the spool
    roof = layer(vw * s, 110 * s);
    var r = roof.getContext('2d'); r.scale(s, s); r.translate(-fit.visLeft, -(FH - 110));
    var L = fit.visLeft - 10, R = fit.visRight + 10;
    r.fillStyle = '#7a3b52';
    r.beginPath(); r.moveTo(L, FH); r.lineTo(L, 668); r.lineTo(40, 668); r.lineTo(40, 650); r.lineTo(88, 650); r.lineTo(88, 676);
    r.lineTo(150, 676); r.lineTo(150, 690); r.lineTo(270, 690); r.lineTo(270, 672); r.lineTo(318, 672); r.lineTo(318, 640); r.lineTo(372, 640); r.lineTo(372, 664); r.lineTo(R, 664); r.lineTo(R, FH); r.closePath(); r.fill();
    r.fillStyle = '#5b2340';
    r.fillRect(L, 708, R - L, FH - 708);
    for (var px = Math.floor(L / 18) * 18; px < R; px += 18) { r.fillRect(px, 698, 10, 12); }
    r.fillStyle = '#4a1c34'; r.fillRect(328, 618, 34, 24); r.fillRect(324, 614, 42, 6);     // water tank
    r.fillStyle = '#d98c5f'; r.fillRect(52, 656, 6, 8); r.fillRect(66, 656, 6, 8);       // little windows lit by the sun
    // the spool (charkhi)
    r.save(); r.translate(PK.SPOOL_X / U, PK.SPOOL_Y / U);
    r.fillStyle = '#c0703a'; r.strokeStyle = '#5b2340'; r.lineWidth = 2;
    r.beginPath(); r.ellipse(0, 6, 16, 8, 0, 0, Math.PI * 2); r.fill(); r.stroke();
    r.fillStyle = '#ffe1c2'; r.beginPath(); r.ellipse(0, 3, 11, 5, 0, 0, Math.PI * 2); r.fill();
    r.fillStyle = '#e5243b'; r.beginPath(); r.ellipse(0, 2, 9, 3.5, 0, 0, Math.PI * 2); r.fill();
    r.restore();
  }
  function cloud(g, x, y, k) {
    g.beginPath();
    g.ellipse(x, y, 46 * k, 14 * k, 0, 0, Math.PI * 2); g.ellipse(x + 30 * k, y - 8 * k, 30 * k, 14 * k, 0, 0, Math.PI * 2);
    g.ellipse(x - 26 * k, y - 4 * k, 24 * k, 11 * k, 0, 0, Math.PI * 2); g.fill();
  }
  function skyline(g) {
    // distant Lahore: domes and minarets in a hazy purple
    g.fillStyle = 'rgba(160,96,128,0.42)';
    var base = 640;
    g.fillRect(fit.visLeft - 10, base - 18, fit.visRight - fit.visLeft + 20, 60);
    function minaret(x, h, w) {
      g.fillRect(x - w / 2, base - h, w, h);
      g.fillRect(x - w / 2 - 2, base - h * 0.62, w + 4, 3); g.fillRect(x - w / 2 - 2, base - h * 0.9, w + 4, 3);
      g.beginPath(); g.moveTo(x - w / 2 - 1, base - h); g.quadraticCurveTo(x, base - h - w * 1.6, x + w / 2 + 1, base - h); g.fill();
    }
    function dome(x, r) { g.beginPath(); g.arc(x, base - 18, r, Math.PI, 0); g.fill(); g.fillRect(x - 1, base - 18 - r - 8, 2, 8); }
    minaret(74, 118, 8); minaret(178, 104, 8); dome(126, 30); dome(96, 18); dome(156, 18);
    minaret(262, 70, 6); dome(292, 20); minaret(322, 74, 6);
    g.fillStyle = 'rgba(160,96,128,0.3)'; minaret(-10, 90, 7); minaret(400, 96, 7); dome(370, 22);
  }

  // ── kite sprites: bold two-tone patang patterns ─────────────────────────
  var PAL = [['#e63946', '#ffffff'], ['#2a9d8f', '#ffd23f'], ['#7b2cbf', '#ff9f1c'], ['#118ab2', '#ffffff'], ['#ef476f', '#06d6a0'], ['#1d3557', '#f1faee'], ['#ff7b00', '#3a0ca3'], ['#06a77d', '#ef476f']];
  var KW = 20, KH = 25;                       // half width and half height of a kite, design px
  var spriteCache = {};
  function kiteSprite(pal, pat, mine) {
    var key = pal + ':' + pat + ':' + (mine ? 1 : 0) + ':' + dpr;
    if (spriteCache[key]) return spriteCache[key];
    var k = 3 * dpr, pad = 8, c = layer((KW * 2 + pad * 2) * k, (KH * 2 + pad * 2) * k), g = c.getContext('2d');
    g.scale(k, k); g.translate(KW + pad, KH + pad);
    var a = PAL[pal][0], b = PAL[pal][1];
    var body = function () { g.beginPath(); g.moveTo(0, -KH); g.lineTo(KW, -KH * 0.18); g.lineTo(0, KH); g.lineTo(-KW, -KH * 0.18); g.closePath(); };
    body(); g.fillStyle = a; g.fill();
    g.save(); body(); g.clip(); g.fillStyle = b;
    if (pat === 0) { g.fillRect(-KW, -KH, KW, KH * 2); }                                     // split down the middle
    else if (pat === 1) { g.beginPath(); g.moveTo(0, -KH * 0.55); g.lineTo(KW * 0.5, -KH * 0.12); g.lineTo(0, KH * 0.45); g.lineTo(-KW * 0.5, -KH * 0.12); g.closePath(); g.fill(); }   // inset diamond
    else if (pat === 2) { g.fillRect(-KW, -KH * 0.32, KW * 2, KH * 0.3); }                   // a band across
    else if (pat === 3) { g.fillRect(-KW, -KH, KW * 2, KH * 0.82); }                         // the top half
    else { g.beginPath(); g.arc(0, -KH * 0.12, KW * 0.42, 0, Math.PI * 2); g.fill(); }       // the moon (chand)
    g.restore();
    // the spar and the bow
    g.strokeStyle = 'rgba(60,20,30,0.55)'; g.lineWidth = 1.1;
    g.beginPath(); g.moveTo(0, -KH); g.lineTo(0, KH); g.stroke();
    g.beginPath(); g.moveTo(-KW, -KH * 0.18); g.quadraticCurveTo(0, -KH * 0.72, KW, -KH * 0.18); g.stroke();
    body(); g.lineJoin = 'round';
    if (mine) { g.strokeStyle = '#5b2340'; g.lineWidth = 5.5; g.stroke(); body(); g.strokeStyle = '#ffd23f'; g.lineWidth = 3; g.stroke(); }
    else { g.strokeStyle = '#3a1d2e'; g.lineWidth = 1.8; g.stroke(); }
    // a small triangle tail-piece (phumman)
    g.fillStyle = mine ? '#ffd23f' : b; g.strokeStyle = mine ? '#5b2340' : '#3a1d2e'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(0, KH - 2); g.lineTo(6, KH + 7); g.lineTo(-6, KH + 7); g.closePath(); g.fill(); g.stroke();
    c.__ox = KW + pad; c.__oy = KH + pad; c.__k = k;
    spriteCache[key] = c;
    return c;
  }
  // The big kites (guddi, tukkal, fierce) are drawn like the real Lahori tukkal: a spire with curved
  // sides, a wide lens with pointed tips, a notch, a crescent wing below, yellow tie points and a tassel.
  // Traced from the founder's photo. Drawing only, the hit box is the rules'.
  var TUK = [
    { spire: '#26393b', lens: '#26393b', wing: '#26393b', tas: '#26393b' },     // dark green, as in the photo
    { spire: '#3b2a99', lens: '#f2e44a', wing: '#3b2a99', tas: '#3b2a99' },
    { spire: '#c8231b', lens: '#c8231b', wing: '#f3efe6', tas: '#c8231b' },
    { spire: '#1a1a1a', lens: '#f3f3f0', wing: '#1a1a1a', tas: '#1a1a1a' },
  ];
  var bigCache = {};
  function bigSprite(v) {
    var key = v + ':' + dpr;
    if (bigCache[key]) return bigCache[key];
    var k = 3 * dpr, c = layer(70 * k, 74 * k), g = c.getContext('2d'), T = TUK[v % TUK.length];
    g.scale(k, k); g.translate(35, 37); g.lineJoin = 'round'; g.lineCap = 'round';
    var edge = function () { g.strokeStyle = 'rgba(20,10,16,0.55)'; g.lineWidth = 1.1; g.stroke(); };
    var spire = function () { g.beginPath(); g.moveTo(0, -34); g.quadraticCurveTo(1.6, -22, 8.4, -18.4); g.lineTo(-8.4, -18.4); g.quadraticCurveTo(-1.6, -22, 0, -34); g.closePath(); };
    var lens = function () {
      g.beginPath(); g.moveTo(-8.4, -18.6); g.quadraticCurveTo(-26, -19, -31, -5.8);
      g.quadraticCurveTo(-22, 4, -11.4, 6.2); g.lineTo(11.4, 6.2); g.quadraticCurveTo(22, 4, 31, -5.8);
      g.quadraticCurveTo(26, -19, 8.4, -18.6); g.closePath();
    };
    var wing = function () {
      g.beginPath(); g.moveTo(-26.4, 8.6); g.quadraticCurveTo(-18, 6.4, -11.4, 6.2); g.lineTo(11.4, 6.2); g.quadraticCurveTo(18, 6.4, 26.4, 8.6);
      g.quadraticCurveTo(18, 22, 0, 20.6); g.quadraticCurveTo(-18, 22, -26.4, 8.6); g.closePath();
    };
    // the tassel: a knot and a short fringe
    g.fillStyle = T.tas; g.beginPath(); g.moveTo(0, 20); g.lineTo(2.2, 24); g.lineTo(-2.2, 24); g.closePath(); g.fill();
    g.strokeStyle = T.tas; g.lineWidth = 1.3; for (var f = -3; f <= 3; f++) { g.beginPath(); g.moveTo(f * 0.6, 23.5); g.lineTo(f * 1.1, 31); g.stroke(); }
    wing(); g.fillStyle = T.wing; g.fill(); edge();
    lens(); g.fillStyle = T.lens; g.fill(); edge();
    spire(); g.fillStyle = T.spire; g.fill(); edge();
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(0, -32); g.lineTo(0, 20); g.stroke();   // the spar
    g.fillStyle = '#e8cf3a';                                                                                                        // yellow tie points
    [[-8.4, -18.4], [8.4, -18.4], [-11.4, 6.2], [11.4, 6.2]].forEach(function (d) { g.beginPath(); g.arc(d[0], d[1], 1.5, 0, Math.PI * 2); g.fill(); });
    [[0, -17.6, 3.2], [0, 19.4, 2.6]].forEach(function (d) { g.beginPath(); g.moveTo(d[0] - d[2], d[1] - d[2] * 0.6); g.lineTo(d[0] + d[2], d[1] - d[2] * 0.6); g.lineTo(d[0], d[1] + d[2] * 0.7); g.closePath(); g.fill(); });
    [[-31, -5.8], [31, -5.8], [-26.4, 8.6], [26.4, 8.6]].forEach(function (d) { g.beginPath(); g.moveTo(d[0], d[1] - 1.6); g.lineTo(d[0] + 1.6, d[1]); g.lineTo(d[0], d[1] + 1.6); g.lineTo(d[0] - 1.6, d[1]); g.closePath(); g.fill(); });
    c.__ox = 35; c.__oy = 37; c.__k = k;
    bigCache[key] = c;
    return c;
  }
  function looksOf(id) { var h = ((id * 2654435761) >>> 0); return { pal: h % PAL.length, pat: (h >>> 8) % 5, tv: (h >>> 16) % TUK.length }; }

  // ── audio: Web Audio only, nothing to download ──────────────────────────
  // A Basant soundtrack (dhol, with a quiet shehnai line) and a shouted
  // "Bo Kaata!" when a line is cut. Drawing and sound never touch the run.
  var AC = null, master = null, musicGain = null, noiseBuf = null;
  function audio() {
    if (RP) return null;                                  // the admin viewer is silent
    if (AC) { if (AC.state !== 'running') AC.resume().catch(function () {}); return AC; }
    var Ctor = window.AudioContext || window.webkitAudioContext; if (!Ctor) return null;
    try { AC = new Ctor(); } catch (_e) { return null; }
    master = AC.createGain(); master.gain.value = 0.85; master.connect(AC.destination);
    musicGain = AC.createGain(); musicGain.gain.value = 0.5; musicGain.connect(master);
    noiseBuf = AC.createBuffer(1, Math.floor(AC.sampleRate * 0.5), AC.sampleRate);
    var nd = noiseBuf.getChannelData(0), ns = 12345;
    for (var i = 0; i < nd.length; i++) { ns = (Math.imul(ns, 1664525) + 1013904223) >>> 0; nd[i] = ns / 2147483648 - 1; }   // fixed noise, never Math.random
    loadSong(); loadClips();
    return AC;
  }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (t) { window.addEventListener(t, function () { audio(); }, { passive: true }); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopMusic(true);
    else { if (AC) AC.resume().catch(function () {}); if (state === 'play' || state === 'prac') startMusic(); }
  });
  // soft bell notes: a sine with a quiet octave, quick attack, gentle decay
  function note(freq, when, dur, vol) {
    if (!audio()) return;
    var t = AC.currentTime + (when || 0), g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(master);
    var o = AC.createOscillator(); o.type = 'sine'; o.frequency.value = freq; o.connect(g); o.start(t); o.stop(t + dur + 0.02);
    var g2 = AC.createGain(); g2.gain.value = 0.25; g2.connect(g);
    var o2 = AC.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2; o2.connect(g2); o2.start(t); o2.stop(t + dur + 0.02);
  }
  // a burst of noise through one filter (the click of a consonant, the slap of a dhol stick)
  function noiseHit(t, type, freq, q, dur, vol, dest) {
    var src = AC.createBufferSource(); src.buffer = noiseBuf;
    var f = AC.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    var g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest || master); src.start(t, 0, dur + 0.02);
  }
  // dhol: the big left head (dagga) is a pitch-dropping thump, the stick side (tilli) a sharp slap
  function dagga(t, vol, dest) {
    var o = AC.createOscillator(), g = AC.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(135, t); o.frequency.exponentialRampToValueAtTime(58, t + 0.11);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(g); g.connect(dest || master); o.start(t); o.stop(t + 0.36);
    noiseHit(t, 'lowpass', 500, 0.7, 0.05, vol * 0.5, dest);
  }
  function tilli(t, vol, dest) {
    noiseHit(t, 'bandpass', 2600, 1.3, 0.06, vol, dest);
    var o = AC.createOscillator(), g = AC.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(430, t); o.frequency.exponentialRampToValueAtTime(290, t + 0.05);
    g.gain.setValueAtTime(vol * 0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g); g.connect(dest || master); o.start(t); o.stop(t + 0.09);
  }
  // shehnai-like lead: a bright saw through a low-pass, with a little vibrato
  function shehnai(t, freq, dur, vol) {
    var o = AC.createOscillator(), f = AC.createBiquadFilter(), g = AC.createGain(), l = AC.createOscillator(), lg = AC.createGain();
    o.type = 'sawtooth'; o.frequency.value = freq; f.type = 'lowpass'; f.frequency.value = 1700; f.Q.value = 2;
    l.frequency.value = 5.5; lg.gain.value = freq * 0.012; l.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.04); g.gain.setValueAtTime(vol, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(musicGain); o.start(t); l.start(t); o.stop(t + dur + 0.02); l.stop(t + dur + 0.02);
  }
  // the loop: 16 sixteenths a bar at 150 bpm. Two bars of chaal, a fill every fourth bar.
  var D_A = [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,0,1,0], T_A = [0,0,1,0, 1,1,0,1, 0,1,1,0, 1,1,0,1];
  var D_B = [1,0,0,1, 0,0,1,0, 1,0,1,1, 0,0,1,0], T_B = [0,0,1,0, 1,0,0,1, 0,1,0,0, 1,1,0,1];
  var LEAD = [293.66, 369.99, 440, 466.16, 440, 369.99, 311.13, 293.66];     // a Bahar-flavoured phrase
  var STEP_S = 0.1, musicOn = false, musicTimer = 0, nextT = 0, stepNo = 0;
  function musicStep(t, n) {
    var bar = Math.floor(n / 16), k = n % 16, B = bar % 2, fill = bar % 4 === 3 && k >= 12;
    var dv = (B ? D_B : D_A)[k], tv = (B ? T_B : T_A)[k];
    if (fill) { if (k % 2 === 0) dagga(t, 0.7, musicGain); tilli(t, 0.4, musicGain); }
    else { if (dv) dagga(t, k === 0 ? 0.95 : 0.75, musicGain); if (tv) tilli(t, 0.3, musicGain); }
    if (bar >= 2 && k % 4 === 0 && bar % 2 === 0) { var li = (k / 4) * 2; shehnai(t, LEAD[li % 8], 0.36, 0.045); shehnai(t + 0.2, LEAD[(li + 1) % 8], 0.36, 0.045); }
  }
  function musicTick() {
    if (!musicOn || !AC) return;
    while (nextT < AC.currentTime + 0.3) { musicStep(nextT, stepNo); stepNo++; nextT += STEP_S; }
  }
  // The soundtrack is a recorded Punjabi dhol loop. It streams in after the first
  // gesture; until it has loaded (or if it never does) the synthesised dhol plays.
  var songBuf = null, songSrc = null, songAsked = false;
  function loadSong() {
    if (songAsked || !AC || typeof fetch !== 'function') return;
    songAsked = true;
    fetchAudio('audio/basant.mp3?v=1')
      .then(function (ab) { return new Promise(function (ok, no) { AC.decodeAudioData(ab, ok, no); }); })
      .then(function (buf) { songBuf = buf; if (musicOn && !songSrc) swapToSong(); })
      .catch(function () {});
  }
  function fetchAudio(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error('audio'); return r.arrayBuffer(); }); }
  // The shout is the founder's recorded "Bo Kaata!" (two takes, used in turn). Until they have
  // loaded, or if they never do, the synthesised shout below stands in.
  var clips = {}, clipsAsked = false, shoutNo = 0;
  function loadClips() {
    if (clipsAsked || !AC || typeof fetch !== 'function') return;
    clipsAsked = true;
    ['bokaata1', 'bokaata2'].forEach(function (n) {
      fetchAudio('audio/' + n + '.mp3?v=1')
        .then(function (ab) { return new Promise(function (ok, no) { AC.decodeAudioData(ab, ok, no); }); })
        .then(function (buf) { clips[n] = buf; })
        .catch(function () {});
    });
  }
  function playClip(n, when, vol, rate) {
    var buf = clips[n]; if (!buf || !audio()) return false;
    var src = AC.createBufferSource(), g = AC.createGain();
    src.buffer = buf; src.playbackRate.value = rate || 1; g.gain.value = vol;
    src.connect(g); g.connect(master); src.start(AC.currentTime + (when || 0));
    return true;
  }
  function playSong() {
    var src = AC.createBufferSource(); src.buffer = songBuf; src.loop = true;
    src.loopStart = 0.02; src.loopEnd = Math.max(0.5, songBuf.duration - 0.02);
    src.connect(musicGain); src.start(AC.currentTime + 0.05, 0.02); songSrc = src;
  }
  function swapToSong() {
    clearInterval(musicTimer); musicTimer = 0;            // the synthesised loop hands over
    musicGain.gain.cancelScheduledValues(AC.currentTime); musicGain.gain.setValueAtTime(0.6, AC.currentTime);
    playSong();
  }
  function startMusic() {
    if (RP || musicOn || !audio()) return;
    musicOn = true; stepNo = 0; nextT = AC.currentTime + 0.12;
    loadSong();
    musicGain.gain.cancelScheduledValues(AC.currentTime);
    if (songBuf) { musicGain.gain.setValueAtTime(0.6, AC.currentTime); playSong(); return; }
    musicGain.gain.setValueAtTime(0.5, AC.currentTime);
    musicTick(); musicTimer = setInterval(musicTick, 80);
  }
  function stopMusic(quick) {
    if (!musicOn) return;
    musicOn = false; clearInterval(musicTimer);
    if (AC) {
      var t = AC.currentTime; musicGain.gain.cancelScheduledValues(t); musicGain.gain.setValueAtTime(musicGain.gain.value, t); musicGain.gain.linearRampToValueAtTime(0.0001, t + (quick ? 0.05 : 0.5));
      if (songSrc) { var old = songSrc; songSrc = null; try { old.stop(t + (quick ? 0.08 : 0.55)); } catch (_e) {} }
    }
  }
  // the shout: a voiced saw through three formant filters, with consonant clicks. "Bo - Kaa - taa!"
  function vowel(t, f0a, f0b, dur, fa, fb, vol, mid) {
    var o = AC.createOscillator(), g = AC.createGain(), l = AC.createOscillator(), lg = AC.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0a, t);
    if (mid) { o.frequency.linearRampToValueAtTime(mid, t + dur * 0.35); }
    o.frequency.linearRampToValueAtTime(f0b, t + dur);
    l.frequency.value = 6; lg.gain.value = f0a * 0.025; l.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.setValueAtTime(vol, t + dur * 0.75); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (var i = 0; i < 3; i++) {
      var f = AC.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = i === 0 ? 7 : 9;
      f.frequency.setValueAtTime(fa[i], t); f.frequency.linearRampToValueAtTime(fb[i], t + dur);
      var fg = AC.createGain(); fg.gain.value = i === 0 ? 1 : i === 1 ? 0.7 : 0.35;
      o.connect(f); f.connect(fg); fg.connect(g);
    }
    g.connect(master); o.start(t); l.start(t); o.stop(t + dur + 0.03); l.stop(t + dur + 0.03);
  }
  function shout(when, pitch, vol) {
    if (!audio()) return;
    var t = AC.currentTime + (when || 0), P = pitch || 1, V = vol || 1;
    noiseHit(t, 'lowpass', 400, 0.8, 0.04, 0.3 * V);                                              // b
    vowel(t + 0.02, 190 * P, 205 * P, 0.17, [480, 880, 2500], [520, 900, 2500], 0.55 * V);        // bo
    noiseHit(t + 0.21, 'bandpass', 2200, 1.5, 0.04, 0.4 * V);                                     // k
    vowel(t + 0.235, 215 * P, 255 * P, 0.22, [760, 1250, 2600], [800, 1200, 2600], 0.6 * V);      // kaa
    noiseHit(t + 0.47, 'highpass', 4500, 1, 0.035, 0.35 * V);                                     // t
    vowel(t + 0.495, 255 * P, 200 * P, 0.5, [780, 1250, 2600], [700, 1150, 2600], 0.75 * V, 310 * P);   // taa!
  }
  function dholRoll(when, hits, vol) {
    if (!audio()) return;
    var t = AC.currentTime + (when || 0);
    for (var i = 0; i < hits; i++) { if (i % 2 === 0) dagga(t + i * 0.055, vol); tilli(t + i * 0.055 + 0.027, vol * 0.7); }
  }
  var SFX = {
    cut: function (mult, big) {
      var take = shoutNo++ % 2 ? 'bokaata2' : 'bokaata1', other = take === 'bokaata1' ? 'bokaata2' : 'bokaata1';
      if (playClip(take, 0, 1, 1)) { if (mult > 1 || big) playClip(other, 0.09, 0.45, 1.05); }   // a second voice joins in on a streak or a big kite
      else { shout(0, 1, 1); if (mult > 1 || big) shout(0.03, 1.06, 0.7); }
      dholRoll(0.1, big ? 12 : mult > 1 ? 8 : 5, 0.7);
      note(784, 0.05, 0.35, 0.1); note(1175, 0.12, 0.45, 0.09); if (mult > 1) note(1568, 0.19, 0.5, 0.08);
    },
    pench: function () { note(1320, 0, 0.12, 0.05); },
    warn: function () { note(440, 0, 0.18, 0.07); note(440, 0.16, 0.18, 0.07); },
    lost: function (why) {
      if (why !== 'roof' && !playClip(shoutNo % 2 ? 'bokaata2' : 'bokaata1', 0.12, 0.6, 0.92)) shout(0.12, 1.28, 0.55);   // the rival shouts it back at you
      note(392, 0, 0.4, 0.11); note(294, 0.14, 0.55, 0.1);
    },
    good: function () { note(1047, 0, 0.3, 0.1); note(1319, 0.08, 0.35, 0.09); },
    soft: function () { note(660, 0, 0.25, 0.06); },
  };

  // ── input: hold anywhere to pull, let go to let line slip ───────────────
  var held = {}, heldCount = 0, keyHeld = false, fingerDown = false, wantTouch = false, wantLift = false;
  function setDown(d) {
    if (d === fingerDown) return;
    fingerDown = d;
    if (d) { wantTouch = true; wantLift = false; } else { wantLift = true; }
  }
  function sync() { setDown(heldCount > 0 || keyHeld); }
  canvas.addEventListener('pointerdown', function (e) {
    if (RP) return;                           // a replay ignores every real input
    if (state !== 'play' && state !== 'prac') return;
    if (!held[e.pointerId]) { held[e.pointerId] = 1; heldCount++; }
    try { canvas.setPointerCapture(e.pointerId); } catch (_e) {}
    sync();
  });
  function up(e) { if (held[e.pointerId]) { delete held[e.pointerId]; heldCount--; } sync(); }
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('lostpointercapture', up);
  // nothing here relies on synthesized clicks, so cancelling touches is safe and stops the iOS magnifier
  ['touchstart', 'touchmove'].forEach(function (t) { canvas.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false }); });
  window.addEventListener('keydown', function (e) {
    if (RP) return;
    if (e.metaKey || e.ctrlKey) return;
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'Space' || e.code === 'ArrowUp') {
      if (state === 'play' || state === 'prac') { keyHeld = true; sync(); } e.preventDefault();
    }
    else if (e.target === document.body) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'Space' || e.code === 'ArrowUp') { keyHeld = false; sync(); } });
  window.addEventListener('blur', function () { held = {}; heldCount = 0; keyHeld = false; sync(); });
  function resetInput() { held = {}; heldCount = 0; keyHeld = false; fingerDown = false; wantTouch = false; wantLift = false; }

  // ── the trace: a mark when the finger goes down and when it comes up ────
  function feedInputs(record) {
    if (wantTouch) {
      wantTouch = false; if (record && window.__kjMark && state === 'play') window.__kjMark('touch', sim.frames); PK.touch(sim);
      if (wantLift && !fingerDown) return;            // a quick tap: the kite gets one step of pull, the lift lands on the next step
    }
    if (wantLift && !fingerDown) { wantLift = false; if (record && window.__kjMark && state === 'play') window.__kjMark('lift', sim.frames); PK.lift(sim); }
  }

  // ── effects: drawing only, never read by the rules ──────────────────────
  var VIEW = {};               // drawn positions of the rivals, never written into the sim
  var fx = [], texts = [], falling = [], trails = [], shake = 0, myFall = null, seenPm = false, seenGuddi = false, lastGust = 0;
  function snap(s) {
    var r = {};
    for (var i = 0; i < s.rivals.length; i++) r[s.rivals[i].id] = [s.rivals[i].x, s.rivals[i].y, s.rivals[i].h];
    return { x: s.me.x, y: s.me.y, h: s.me.h, r: r };
  }
  function intersect(ax, ay, bx, by, cx, cy, dx, dy) {
    var d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx); if (!d) return [cx, cy];
    var t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  }
  function burst(x, y, n, cols, sp) {
    for (var k = 0; k < n; k++) { var a = Math.random() * Math.PI * 2, v = (0.5 + Math.random()) * sp; fx.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: 20 + Math.random() * 18, c: cols[k % cols.length] }); }
  }
  function contactPoint(s, r) { return intersect(PK.SPOOL_X / U, PK.SPOOL_Y / U, s.me.x / U, s.me.y / U, r.ax / U, r.ay / U, r.x / U, r.y / U); }
  function onEvents(s, before) {
    for (var i = 0; i < s.events.length; i++) {
      var e = s.events[i];
      if (e.k === 'pench') {
        var rp = null; for (var a = 0; a < s.rivals.length; a++) if (s.rivals[a].id === e.id) rp = s.rivals[a];
        if (rp) { var cp = contactPoint(s, rp); burst(cp[0], cp[1], 10, ['#fff6c2', '#ffffff'], 2); texts.push({ x: cp[0], y: cp[1] - 20, s: 'PENCH!', sub: '', t: 0, big: 1, small: 1 }); }
        SFX.pench();
      } else if (e.k === 'cut') {
        var r0 = null;
        for (var j = 0; j < before.length; j++) if (before[j].id === e.id) r0 = before[j];
        var rx = e.x / U, ry = e.y / U, p = r0 ? intersect(PK.SPOOL_X / U, PK.SPOOL_Y / U, s.me.x / U, s.me.y / U, r0.ax / U, r0.ay / U, rx, ry) : [rx, ry];
        var lk = looksOf(e.id);
        falling.push({ x: rx, y: ry, vx: (r0 && r0.side ? -1 : 1) * (0.8 + Math.random()), vy: -0.5, rot: (r0 ? r0.h : 0) / 1024 * Math.PI * 2, vr: (Math.random() - 0.5) * 0.25, t: 0, pal: e.big ? lk.tv : lk.pal, pat: e.big ? 9 : lk.pat, sc: kiteScale({ big: e.big, id: e.id }) });
        burst(p[0], p[1], 26, ['#fff6c2', '#ffd23f', '#ffffff'], 3.4);
        texts.push({ x: p[0], y: p[1] - 18, s: 'BO KAATA!', sub: e.mult > 1 ? '+' + e.pts + '  x' + e.mult : '+' + e.pts, t: 0, big: e.mult });
        SFX.cut(e.mult, e.big);
        shake = Math.max(shake, 5);
      } else if (e.k === 'down') {
        var dl = looksOf(e.id);
        falling.push({ x: e.x / U, y: e.y / U, vx: 0, vy: 0.5, rot: 0.6, vr: 0.05, t: 60, pal: dl.pal, pat: dl.pat });
      } else if (e.k === 'lost') {
        myFall = { x: e.x / U, y: e.y / U, vx: (Math.random() - 0.5) * 2, vy: -0.4, rot: 0, vr: 0.18, t: 0 };
        burst(e.x / U, e.y / U, 18, ['#e5243b', '#ffd23f'], 2.6);
        texts.push({ x: 207, y: 300, s: e.why === 'roof' ? 'GIR GAYI!' : 'KAT GAYI!', sub: s.kites > 0 ? s.kites + (s.kites === 1 ? ' kite left' : ' kites left') : '', t: 0, big: 2, warn: 1 });
        SFX.lost(e.why); shake = 9;
      } else if (e.k === 'enter') {
        var nr2 = null; for (var b = 0; b < s.rivals.length; b++) if (s.rivals[b].id === e.id) nr2 = s.rivals[b];
        if (nr2 && nr2.big === 2) texts.push({ x: 207, y: 200, s: 'TUKKAL!', sub: 'thick line: hold longer, x3', t: 0, big: 2 });
        else if (nr2 && nr2.big === 1 && !seenGuddi) { seenGuddi = true; texts.push({ x: 207, y: 200, s: 'GUDDI', sub: 'bigger kite: hold longer, x2', t: 0, big: 1 }); }
        else if (nr2 && nr2.pm && !seenPm) { seenPm = true; texts.push({ x: 207, y: 200, s: 'PENCH MASTER', sub: 'pulls when you dart at it', t: 0, big: 1, warn: 1 }); }
      } else if (e.k === 'hunter') {
        texts.push({ x: 207, y: 200, s: 'HUNTER!', sub: '', t: 0, big: 1, warn: 1 });
        SFX.warn();
      }
    }
  }
  function stepFx() {
    for (var i = fx.length - 1; i >= 0; i--) { var p = fx[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.06; p.vx *= 0.96; p.t++; if (p.t > p.life) fx.splice(i, 1); }
    for (var j = texts.length - 1; j >= 0; j--) { texts[j].t++; if (texts[j].t > 70) texts.splice(j, 1); }
    for (var k = falling.length - 1; k >= 0; k--) { var f = falling[k]; f.x += f.vx; f.y += f.vy; f.vy = Math.min(2.2, f.vy + 0.035); f.rot += f.vr; f.t++; if (f.t > 160) falling.splice(k, 1); }
    for (var q = trails.length - 1; q >= 0; q--) { trails[q].t++; if (trails[q].t > 24) trails.splice(q, 1); }
    if (myFall) { myFall.x += myFall.vx; myFall.y += myFall.vy; myFall.vy = Math.min(3, myFall.vy + 0.05); myFall.rot += myFall.vr; myFall.t++; if (myFall.t > 110 && state !== 'dying' && state !== 'over') myFall = null; }
    shake *= 0.86;
  }
  // sounds that follow the state every step
  function stateSound(s) {
    // a rival starts holding its nose on you: a quiet heads-up
    for (var i = 0; i < s.rivals.length; i++) if (s.rivals[i].think === 1) { SFX.warn(); break; }
    if (s.me.pull && s.frames % 3 === 0) trails.push({ x: s.me.x / U, y: s.me.y / U, t: 0 });
  }
  function silence() {}

  // ── the run ─────────────────────────────────────────────────────────────
  var seedHex = null, lastWave = 1, waveBanner = null;
  function startRun() {
    seedHex = window.__kjSeed || (EMBED ? null : (qp('seed') || randomSeed()));
    var v = window.__kjGameStart ? window.__kjGameStart(performance.now(), 2) : 2;
    if (RP) { v = RP.capVersion(v); replayCur = RP.cursor(['touch', 'lift'], function (p) { return Number(p.step); }); RP.started(v); }
    sim = PK.initSim(seedHex, v); prev = snap(sim);
    seenPm = false; seenGuddi = false; lastGust = 0;
    fx = []; texts = []; falling = []; trails = []; myFall = null; lastWave = 1; waveBanner = { s: 'WAVE 1', t: 0 };
    resetInput();
    state = 'play'; acc = 0; lastT = null; startMusic();
    menuEl.classList.add('is-hidden'); scoreEl.classList.remove('is-hidden'); heartsEl.classList.remove('is-hidden');
    hud();
  }
  function hud() {
    scoreEl.textContent = String(sim.score);
    var h = ''; for (var i = 0; i < PK.KITES; i++) h += i < sim.kites ? '◆' : '◇';
    heartsEl.textContent = h;
  }
  function endRun() {
    state = 'dying'; silence(); stopMusic();
    setTimeout(function () {
      if (state !== 'dying') return;
      state = 'over';
      if (RP) RP.setStep(sim.frames);
      if (window.__kjSubmit) window.__kjSubmit(sim.score);
      if (!EMBED) { finalEl.textContent = String(sim.score); overEl.classList.remove('is-hidden'); }
    }, SUBMIT_AFTER_MS);                                // a timer, so a hidden tab still submits
  }
  function stepRun() {
    if (replayCur) { var due = replayCur.due(sim.frames); for (var di = 0; di < due.length; di++) { if (due[di].kind === 'touch') PK.touch(sim); else PK.lift(sim); } }
    feedInputs(true);
    var before = sim.rivals;
    prev = snap(sim);
    PK.stepSim(sim);
    onEvents(sim, before);
    stateSound(sim);
    if (sim.wave !== lastWave) { lastWave = sim.wave; waveBanner = { s: 'WAVE ' + sim.wave, t: 0 }; }
    var gu = sim.wave >= PK.GUST_WAVE ? PK.gustAt(sim.seed, sim.frames) : 0;
    if (gu !== 0 && lastGust === 0) { texts.push({ x: 207, y: 250, s: gu > 0 ? 'GUST \u2192' : '\u2190 GUST', sub: '', t: 0, big: 1, small: 1 }); SFX.soft(); }
    lastGust = gu;
    hud();
    if (RP) RP.report(sim.frames, sim.score);
    if (sim.dead) endRun();
  }

  // ── the hands-on practice: outside the scored run, emits nothing ────────
  // 0 hold to fly up to the ring · 1 let go and watch it spin · 2 hold when the nose
  // points at the ring · 3 cut their string · 4 ready. It freezes whenever it waits for
  // you, and nothing in it can fail for good: a miss just resets the same lesson.
  var prac = null, handImg = null;
  var HAND_W = 64, HAND_H = 100;
  var RINGS = { 0: { x: 207, y: 270 }, 2: { x: 320, y: 300 } };
  var SPIN_STEPS = 60;                                // lesson 1 is done after this much spinning
  function buildHandSprite() {
    var k = 4, c = layer(HAND_W * k, HAND_H * k), g = c.getContext('2d'); g.scale(k, k);
    g.lineWidth = 3.2; g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = '#5b2340';
    var rr = function (x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    var shape = function (fill) { g.fillStyle = fill; g.fill(); g.stroke(); };
    rr(8, 40, 50, 44, 14); shape('#ffffff');
    rr(16, 12, 17, 44, 8.5); shape('#ffffff');
    rr(32, 38, 13, 20, 6.5); shape('#ffffff');
    rr(44, 41, 12, 19, 6); shape('#ffffff');
    rr(54, 45, 7, 17, 3.5); shape('#ffffff');
    g.save(); g.translate(26, 66); g.rotate(-0.35); rr(-15, -7, 30, 14, 7); shape('#ffffff'); g.restore();
    rr(12, 84, 42, 13, 4); shape('#ffd23f');
    return c;
  }
  function startPractice() {
    state = 'prac'; startMusic(); menuEl.classList.add('is-hidden'); overEl.classList.add('is-hidden');
    sim = PK.initSim('0badc0de00000000', 2);
    sim.nextAt = 1e12; sim.lastCut = 1e12;            // nobody comes in uninvited
    prac = { i: 0 }; fx = []; texts = []; falling = []; trails = []; myFall = null;
    pskip.classList.remove('is-hidden'); pplay.classList.add('is-hidden');
    window.__kjTutorialOpen = true;
    pracSetup(0);
  }
  function pracSetup(i) {
    texts = []; falling = []; prac.i = i; prac.live = 0; prac.slip = 0; prac.hold = 0; prac.want = ''; prac.shownAt = performance.now(); prac.phase = 'run';
    var s = sim;
    s.dead = ''; s.events = []; s.kites = PK.KITES; s.respawn = 0; s.safe = 0; s.rivals = [];
    if (fingerDown) PK.touch(s); else PK.lift(s);
    wantTouch = false; wantLift = false;
    if (i === 0) s.me = { x: 207 * U, y: 470 * U, h: 0, s: 0, pull: 0 };
    if (i === 1) s.me = Object.assign({}, s.me, { pull: 1, s: 4 * U });
    if (i === 2) s.me = { x: 150 * U, y: 360 * U, h: 0, s: 0, pull: 0 };
    if (i === 3) {
      s.me = { x: 70 * U, y: 380 * U, h: 256, s: 0, pull: 0 };      // nose already toward their line, which stands mid screen with room to cross it
      s.rivals = [{ id: 7, big: 0, pm: 0, wp: 0, side: 1, w: 1, ax: 255 * U, ay: 650 * U, x: 215 * U, y: 200 * U, h: 0, s: 0, pull: 0, vmax: 0, aim: 9, react: 1e9, dart: 0, think: 0, run: 0, hx: 215 * U, hy: 200 * U, rest: 1e9, restBase: 1e9, until: 1e12, hunter: 0 }];
    }
    prev = snap(s); myFall = null;
    if (i === 4) { prac.phase = 'ready'; pplay.classList.remove('is-hidden'); pskip.classList.add('is-hidden'); syncPlay(); silence(); }
  }
  function endPractice() {
    prac = null; window.__kjTutorialOpen = false; silence();
    pskip.classList.add('is-hidden'); pplay.classList.add('is-hidden');
    try { KJTut.markSeen(); } catch (_e) {}
  }
  function pracNext(delay) { prac.phase = 'gap'; prac.nextAt = performance.now() + delay; }
  // what the practice is waiting for, or '' when it may run
  function pracWants() {
    var p = prac, me = sim.me, down = fingerDown || wantTouch || (p.hold > 0 && wantLift);       // a tap counts as a press
    if (p.i === 0) return down ? '' : 'hold';
    if (p.i === 1) return fingerDown ? 'let' : '';
    if (p.i === 2) {
      if (me.pull) return '';
      var aimed = PK.aimedAt(me.h, RINGS[2].x * U - me.x, RINGS[2].y * U - me.y, 6);
      if (fingerDown) return aimed ? '' : 'let';       // a hold before it is aimed would only fly it off
      if (!aimed) { wantTouch = false; return ''; }   // a tap while it still turns does nothing (the lift it brought still lands)
      return down ? '' : 'now';
    }
    if (p.i === 3) return down ? '' : 'cut';                 // the cut needs a hold the whole way: it waits for one
    return '';
  }
  // Once a frame, outside the step accumulator: the gap between lessons and what the practice
  // waits for are judged here. On a 120/144 Hz screen a frame is shorter than a step, so a wait
  // that was only judged inside a step (while the accumulator is held at zero) never ended.
  function pracSync() {
    var p = prac;
    if (p.phase === 'gap' && performance.now() >= p.nextAt) pracSetup(p.i + 1);
    if (p.phase !== 'run') return;
    var w = pracWants();
    if (w !== p.want) { p.want = w; if (w) p.shownAt = performance.now(); }
  }
  function stepPrac() {
    var p = prac;
    if (p.phase === 'ready') return false;
    if (p.phase === 'gap') { if (performance.now() >= p.nextAt) pracSetup(p.i + 1); return false; }
    var want = pracWants();
    if (want) { if (want !== p.want) { p.want = want; p.shownAt = performance.now(); } silence(); return false; }
    p.want = '';
    // on a trackpad a tap is over in a blink: in the flying lessons a press keeps pulling for a moment
    if (wantTouch && p.i !== 1) p.hold = p.i === 3 ? 140 : 45;
    if (p.hold > 0 && wantLift && !fingerDown) { p.hold--; var wl = wantLift; wantLift = false; feedInputs(false); wantLift = wl; }
    else feedInputs(false);
    var before = sim.rivals;
    prev = snap(sim);
    var pin = sim.rivals[0] ? { x: sim.rivals[0].x, y: sim.rivals[0].y } : null;
    PK.stepSim(sim);
    if (pin && sim.rivals[0] && sim.rivals[0].id === 7) sim.rivals = [Object.assign({}, sim.rivals[0], { x: pin.x, y: pin.y })];
    onEvents(sim, before);
    stateSound(sim);
    p.live++;
    var me = sim.me, lost = false, cut = false;
    for (var i = 0; i < sim.events.length; i++) { if (sim.events[i].k === 'lost') lost = true; if (sim.events[i].k === 'cut') cut = true; }
    if (lost || me.y > 590 * U) { sim.dead = ''; texts.push({ x: 207, y: 330, s: 'TRY AGAIN', sub: '', t: 0, big: 1, warn: 1 }); p.i = p.i - 1; pracNext(900); return true; }
    if (p.i === 1) {
      if (!me.pull) p.slip++;
      if (p.slip >= SPIN_STEPS) { SFX.good(); texts.push({ x: me.x / U, y: me.y / U - 50, s: 'NICE!', sub: '', t: 0, big: 1 }); pracNext(800); }
    }
    if (p.i === 0 || p.i === 2) {
      var ring = RINGS[p.i], dx = me.x / U - ring.x, dy = me.y / U - ring.y;
      if (dx * dx + dy * dy < 34 * 34 || (p.i === 0 && me.y / U < ring.y - 30)) { burst(ring.x, ring.y, 16, ['#ffd23f', '#fff6c2'], 2.4); SFX.good(); texts.push({ x: ring.x, y: ring.y - 30, s: 'NICE!', sub: '', t: 0, big: 1 }); pracNext(800); }
      else if (me.pull && p.live > 4 && (me.x <= 21 * U || me.x >= 393 * U || me.y <= 51 * U)) { p.i = p.i === 0 ? -1 : 1; pracNext(300); }   // flew off: same lesson again
    }
    if (p.i === 3 && cut) pracNext(2200);
    if (p.i === 3 && !cut && p.live > 150) { texts.push({ x: 207, y: 330, s: 'TRY AGAIN', sub: '', t: 0, big: 1, warn: 1 }); p.i = 2; pracNext(700); }
    return true;
  }

  // ── drawing ─────────────────────────────────────────────────────────────
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpA(a, b, t) { var d = ((b - a) % 1024 + 1536) % 1024 - 512; return a + d * t; }
  function drawString(g, x0, y0, x1, y1, col, halo, w, t, seedOff, sagK) {
    // a straight string with a slight sag: the curve stays within 2.5 px of the line the rules use
    var mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0, L = Math.sqrt(dx * dx + dy * dy) || 1;
    var sag = Math.min(5, L * 0.012) * (sagK == null ? 1 : sagK) * (0.8 + 0.2 * Math.sin(t / 700 + seedOff));
    var cx = mx + (-dy / L) * sag * (dx > 0 ? 1 : -1), cy = my + Math.abs(dx / L) * sag;
    g.lineCap = 'round';
    g.strokeStyle = halo; g.lineWidth = w + 2.4; g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(cx, cy, x1, y1); g.stroke();
    g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(cx, cy, x1, y1); g.stroke();
  }
  function drawTail(g, t, col, seedOff, wild) {
    g.strokeStyle = col; g.lineWidth = 2.2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0, KH + 6);
    for (var i = 1; i <= 6; i++) g.lineTo(Math.sin(t / 160 + i * 0.9 + seedOff) * (2 + i * 1.2) * wild, KH + 6 + i * 5.5);
    g.stroke();
  }
  // a kite drawn with its nose along heading h (0 up, 1024 a turn)
  function drawKite(g, x, y, h, pal, pat, mine, t, seedOff, alpha, slack, scale) {
    var sp = pat === 9 ? bigSprite(pal) : kiteSprite(pal, pat, mine), wob = slack ? Math.sin(t / 60 + seedOff) * 0.08 : 0;
    g.save(); g.globalAlpha = alpha == null ? 1 : alpha; g.translate(x, y); g.rotate(h / 1024 * Math.PI * 2 + wob); if (scale) g.scale(scale, scale);
    if (pat !== 9) drawTail(g, t, mine ? '#ffd23f' : PAL[pal][1], seedOff, slack ? 1.6 : 0.6);
    g.drawImage(sp, -sp.__ox, -sp.__oy, sp.width / sp.__k, sp.height / sp.__k);
    g.restore();
  }
  // which way it is spinning: a curved arrow around the kite
  function drawSpinArrow(g, x, y, dir, now) {
    var r = 38, a0 = -Math.PI / 2 - 0.9, a1 = -Math.PI / 2 + 0.9;
    g.save(); g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); g.arc(x, y, r, dir > 0 ? a0 : a1, dir > 0 ? a1 : a0, dir < 0); g.stroke();
    var ea = dir > 0 ? a1 : a0, ex = x + Math.cos(ea) * r, ey = y + Math.sin(ea) * r, tx = -Math.sin(ea) * dir, ty = Math.cos(ea) * dir;
    g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex - tx * 9 - ty * 6, ey - ty * 9 + tx * 6); g.moveTo(ex, ey); g.lineTo(ex - tx * 9 + ty * 6, ey - ty * 9 - tx * 6); g.stroke();
    g.restore();
  }
  // gusts: streaks across the sky in the gust's direction
  var streaks = [];
  function drawGust(g, now) {
    if (!sim || sim.wave < PK.GUST_WAVE) { streaks = []; return; }
    var gu = PK.gustAt(sim.seed, sim.frames);
    if (gu !== 0 && streaks.length < 22 && Math.random() < 0.5) streaks.push({ x: gu > 0 ? fit.visLeft - 40 : fit.visRight + 40, y: 60 + Math.random() * 500, v: (gu > 0 ? 1 : -1) * (6 + Math.random() * 4), l: 30 + Math.random() * 50 });
    g.save(); g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 2; g.lineCap = 'round';
    for (var i = streaks.length - 1; i >= 0; i--) {
      var st = streaks[i]; st.x += st.v;
      g.beginPath(); g.moveTo(st.x, st.y); g.lineTo(st.x - Math.sign(st.v) * st.l, st.y); g.stroke();
      if (st.x < fit.visLeft - 120 || st.x > fit.visRight + 120) streaks.splice(i, 1);
    }
    g.restore();
  }
  // where a pull will take you: a short dashed line from the nose
  function drawGuide(g, x, y, h, len, col, alpha) {
    var a = h / 1024 * Math.PI * 2, nx = Math.sin(a), ny = -Math.cos(a);
    g.save(); g.globalAlpha = alpha; g.strokeStyle = col; g.lineWidth = 3; g.lineCap = 'round'; g.setLineDash([7, 8]);
    g.beginPath(); g.moveTo(x + nx * 30, y + ny * 30); g.lineTo(x + nx * len, y + ny * len); g.stroke(); g.setLineDash([]);
    var ex = x + nx * len, ey = y + ny * len;
    g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex - nx * 10 - ny * 7, ey - ny * 10 + nx * 7); g.moveTo(ex, ey); g.lineTo(ex - nx * 10 + ny * 7, ey - ny * 10 - nx * 7); g.stroke();
    g.restore();
  }

  function render(now) {
    resize();
    var a = Math.max(0, Math.min(1, acc / STEP_MS));
    var g = ctx; g.setTransform(1, 0, 0, 1, 0, 0);
    var s = fit.s * dpr, ox = fit.offX * dpr, oy = fit.offY * dpr;
    var shx = shake > 0.3 ? (Math.random() - 0.5) * shake : 0, shy = shake > 0.3 ? (Math.random() - 0.5) * shake : 0;
    g.drawImage(sky, 0, 0, canvas.width, canvas.height);
    g.setTransform(s, 0, 0, s, ox + shx * s, oy + shy * s);
    var drift = (now / 120) % FW;
    g.drawImage(farKites, fit.visLeft - FW + drift, 40, FW * 2, 420);
    g.drawImage(farKites, fit.visLeft + drift, 40, FW * 2, 420);
    var showSim = sim && state !== 'menu';
    g.save(); g.beginPath(); g.rect(fit.clip.x, fit.clip.y, fit.clip.w, fit.clip.h); g.clip();
    if (showSim) drawWorld(g, now, a); else drawMenuKites(g, now);
    g.restore();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(roof, 0, (FH - 110 - fit.visTop) * s, canvas.width, 110 * s);
    g.setTransform(s, 0, 0, s, ox + shx * s, oy + shy * s);
    if (showSim) { drawGust(g, now); drawMine(g, now, a); drawPench(g, now); }
    drawTexts(g);
    if (state === 'prac') drawPrac(g, now);
    if (state === 'play' && waveBanner && waveBanner.t < 100) {
      var wa = waveBanner.t < 15 ? waveBanner.t / 15 : waveBanner.t > 80 ? (100 - waveBanner.t) / 20 : 1;
      g.save(); g.globalAlpha = wa; g.font = '28px PKTitan, sans-serif'; g.textAlign = 'center';
      g.lineWidth = 5; g.strokeStyle = '#5b2340'; g.strokeText(waveBanner.s, 207, 120); g.fillStyle = '#fff'; g.fillText(waveBanner.s, 207, 120); g.restore();
    }
  }
  var BIG_SCALE = [1, 1.2, 1.5, 1.1];
  function kiteScale(r) { return r.big === 3 ? 0.95 + ((((r.id * 2246822519) >>> 0) >>> 24) % 5) * 0.075 : BIG_SCALE[r.big] || 1; }   // fierce: 0.95 to 1.25
  function drawWorld(g, now, a) {
    var ring = state === 'prac' && prac && prac.phase !== 'gap' ? RINGS[prac.i] : null;
    if (ring) {   // the practice target
      g.save(); g.strokeStyle = '#ffd23f'; g.lineWidth = 5; g.beginPath(); g.arc(ring.x, ring.y, 26 + 2 * Math.sin(now / 160), 0, Math.PI * 2); g.stroke();
      g.strokeStyle = '#5b2340'; g.lineWidth = 2; g.beginPath(); g.arc(ring.x, ring.y, 30 + 2 * Math.sin(now / 160), 0, Math.PI * 2); g.stroke(); g.restore();
    }
    for (var f = 0; f < falling.length; f++) {
      var fk = falling[f], fa = Math.max(0, 1 - fk.t / 160);
      g.save(); g.globalAlpha = fa; g.strokeStyle = '#3a1d2e'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(fk.x, fk.y);
      for (var w = 1; w <= 8; w++) g.lineTo(fk.x + Math.sin(fk.t / 9 + w) * w * 1.6, fk.y + w * 11); g.stroke(); g.restore();
      drawKite(g, fk.x, fk.y, fk.rot / (Math.PI * 2) * 1024, fk.pal, fk.pat, false, now, f, fa, true, fk.sc);
    }
    VIEW = {};
    for (var r = 0; r < sim.rivals.length; r++) {
      var rv = sim.rivals[r], p0 = prev.r[rv.id] || [rv.x, rv.y, rv.h];
      VIEW[rv.id] = { x: lerp(p0[0], rv.x, a) / U, y: lerp(p0[1], rv.y, a) / U, h: lerpA(p0[2], rv.h, a) };
      var engaged = rv.lock;
      drawString(g, rv.ax / U, rv.ay / U, VIEW[rv.id].x, VIEW[rv.id].y, engaged ? '#5b2340' : '#2a1b3d', 'rgba(255,255,255,0.65)', (rv.pull ? 2 : 1.6) + rv.big * 0.9, now, rv.id, rv.pull ? 0.2 : 1.2);
    }
    for (var r2 = 0; r2 < sim.rivals.length; r2++) {
      var rr = sim.rivals[r2], lk = looksOf(rr.id);
      // the threat: lining up on your line (red guide), or darting (red streak)
      if (!rr.pull && rr.think > 0) drawGuide(g, VIEW[rr.id].x, VIEW[rr.id].y, VIEW[rr.id].h, 90, '#ff4d6d', 0.5 + 0.4 * Math.sin(now / 60));
      if (rr.pull) { g.save(); g.globalAlpha = 0.5; g.strokeStyle = '#ff4d6d'; g.lineWidth = 3; var ra = VIEW[rr.id].h / 1024 * Math.PI * 2; g.beginPath(); g.moveTo(VIEW[rr.id].x - Math.sin(ra) * 26, VIEW[rr.id].y + Math.cos(ra) * 26); g.lineTo(VIEW[rr.id].x - Math.sin(ra) * 52, VIEW[rr.id].y + Math.cos(ra) * 52); g.stroke(); g.restore(); }
      drawKite(g, VIEW[rr.id].x, VIEW[rr.id].y, VIEW[rr.id].h, rr.big ? lk.tv : lk.pal, rr.big ? 9 : lk.pat, false, now, rr.id, 1, !rr.pull, kiteScale(rr));
      if (rr.pm) { g.save(); g.strokeStyle = '#7b2cbf'; g.lineWidth = 2.5; g.globalAlpha = 0.8; g.beginPath(); g.arc(VIEW[rr.id].x, VIEW[rr.id].y, 30, 0, Math.PI * 2); g.stroke(); g.restore(); }
      if (rr.big) { var lb = 'x' + PK.SIZE_PTS[rr.big], ly = VIEW[rr.id].y - 40 * kiteScale(rr) - 8; g.save(); g.font = '14px PKTitan, sans-serif'; g.textAlign = 'center'; g.lineWidth = 4; g.strokeStyle = '#5b2340'; g.strokeText(lb, VIEW[rr.id].x, ly); g.fillStyle = '#ffd23f'; g.fillText(lb, VIEW[rr.id].x, ly); g.restore(); }
      if (rr.hunter) { g.save(); g.fillStyle = '#e5243b'; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(VIEW[rr.id].x, VIEW[rr.id].y - KH - 10, 5, 0, Math.PI * 2); g.fill(); g.stroke(); g.restore(); }
    }
    for (var q = 0; q < fx.length; q++) { var p = fx[q]; g.globalAlpha = Math.max(0, 1 - p.t / p.life); g.fillStyle = p.c; g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); }
    g.globalAlpha = 1;
  }
  function drawMine(g, now, a) {
    if (myFall) {
      g.save(); g.globalAlpha = Math.max(0, 1 - myFall.t / 90); g.strokeStyle = '#e5243b'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(myFall.x, myFall.y);
      for (var w = 1; w <= 8; w++) g.lineTo(myFall.x + Math.sin(myFall.t / 8 + w) * w * 1.8, myFall.y + w * 12); g.stroke(); g.restore();
      drawKite(g, myFall.x, myFall.y, myFall.rot / (Math.PI * 2) * 1024, 0, 4, true, now, 3, 1, true);
      if (state === 'dying' || state === 'over') return;
    }
    if (sim.respawn > 0) return;
    var me = sim.me, x = lerp(prev.x, me.x, a) / U, y = lerp(prev.y, me.y, a) / U, h = lerpA(prev.h, me.h, a);
    // speed trail while pulling
    for (var i = 0; i < trails.length; i++) { var tr = trails[i]; g.globalAlpha = (1 - tr.t / 24) * 0.45; g.fillStyle = '#fff6c2'; g.beginPath(); g.arc(tr.x, tr.y, 3 * (1 - tr.t / 24) + 1, 0, Math.PI * 2); g.fill(); }
    g.globalAlpha = 1;
    // the rooftops are close: the roofline warns you
    var low = Math.max(0, Math.min(1, (y - 540) / 70));
    if (low > 0 && !me.pull) { g.save(); g.globalAlpha = low * (0.5 + 0.5 * Math.sin(now / 90)); g.fillStyle = '#ff4d6d'; g.fillRect(fit.visLeft, PK.ROOF_Y / U - 4, fit.visRight - fit.visLeft, 6); g.restore(); }
    drawString(g, PK.SPOOL_X / U, PK.SPOOL_Y / U, x, y, me.pull ? '#ffb703' : '#e5243b', 'rgba(255,255,255,0.85)', me.pull ? 2.6 : 2, now, 7, me.pull ? 0.2 : 1.3);
    if (!me.pull) { drawGuide(g, x, y, h, 100, '#ffd23f', 0.85); drawSpinArrow(g, x, y, 1, now); }
    var blink = sim.safe > 0 ? (Math.floor(now / 110) % 2 ? 0.45 : 1) : 1;
    drawKite(g, x, y, h, 0, 4, true, now, 3, blink, !me.pull);
  }
  // a pench: sparks where the lines meet; a ring fills gold as you saw their line, red as they saw yours
  function drawPench(g, now) {
    for (var i = 0; i < sim.rivals.length; i++) {
      var r = sim.rivals[i]; if (!r.lock) continue;
      var cp = contactPoint(sim, r), win = Math.max(0, r.bal) * 2 / (PK.CUT_AT * PK.SIZE_LINE[r.big]), lose = Math.max(0, -r.bal) / PK.CUT_AT;
      for (var k = 0; k < 3; k++) fx.push({ x: cp[0], y: cp[1], vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 2, t: 0, life: 14, c: win >= lose ? '#ffd23f' : '#ff4d6d' });
      g.save();
      g.fillStyle = 'rgba(91,35,64,0.6)'; g.beginPath(); g.arc(cp[0], cp[1], 24, 0, Math.PI * 2); g.fill();
      g.lineWidth = 6; g.lineCap = 'round';
      if (win > 0) { g.strokeStyle = '#ffd23f'; g.beginPath(); g.arc(cp[0], cp[1], 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, win)); g.stroke(); }
      if (lose > 0) { g.strokeStyle = '#ff4d6d'; g.beginPath(); g.arc(cp[0], cp[1], 20, -Math.PI / 2, -Math.PI / 2 - Math.PI * 2 * Math.min(1, lose), true); g.stroke(); }
      g.fillStyle = '#fff'; g.beginPath(); g.arc(cp[0], cp[1], 3.5, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  }
  function drawTexts(g) {
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i], k = t.t < 8 ? 0.6 + t.t * 0.07 : 1.16 - Math.min(0.16, (t.t - 8) * 0.02), al = t.t > 50 ? 1 - (t.t - 50) / 20 : 1;
      g.save(); g.globalAlpha = al; g.translate(t.x, t.y - t.t * 0.5); g.scale(k, k); g.textAlign = 'center';
      g.font = (t.small ? 20 : t.big > 1 ? 34 : 28) + 'px PKTitan, sans-serif'; g.lineWidth = 6; g.strokeStyle = '#5b2340';
      g.strokeText(t.s, 0, 0); g.fillStyle = t.warn ? '#ff4d6d' : '#ffd23f'; g.fillText(t.s, 0, 0);
      if (t.sub) { g.font = '18px PKTitan, sans-serif'; g.lineWidth = 4; g.strokeText(t.sub, 0, 24); g.fillStyle = '#fff'; g.fillText(t.sub, 0, 24); }
      g.restore();
    }
  }
  var menuKites = null;
  function drawMenuKites(g, now) {
    if (!menuKites) menuKites = [[90, 300, 1, 0], [320, 250, 3, 1], [210, 420, 0, 4]];
    for (var i = 0; i < menuKites.length; i++) {
      var m = menuKites[i], x = m[0] + Math.sin(now / 1300 + i * 2) * 26, y = m[1] + Math.sin(now / 900 + i) * 14;
      drawString(g, i === 2 ? 207 : (i ? 484 : -70), i === 2 ? 704 : 700, x, y, i === 2 ? '#e5243b' : '#2a1b3d', 'rgba(255,255,255,0.6)', 1.8, now, i);
      drawKite(g, x, y, Math.sin(now / 700 + i) * 20, m[2], m[3], i === 2, now, i, 1, false);
    }
  }
  function caption(g, text, x, y, fade, col) {
    g.save(); g.globalAlpha = fade; g.font = '26px PKTitan, sans-serif'; g.textAlign = 'center';
    g.lineWidth = 6; g.strokeStyle = '#5b2340'; g.strokeText(text, x, y); g.fillStyle = col || '#fff'; g.fillText(text, x, y); g.restore();
  }
  function drawHand(g, x, y, fade, down) {
    if (!handImg) handImg = buildHandSprite();
    var sc = 60 / HAND_H;
    if (down) { g.save(); g.globalAlpha = fade * 0.7; g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.arc(x, y, 18, 0, Math.PI * 2); g.stroke(); g.restore(); }
    g.save(); g.globalAlpha = fade; g.drawImage(handImg, x - 24.5 * sc, y - 12 * sc + (down ? 5 : 0), HAND_W * sc, HAND_H * sc); g.restore();
  }
  // the cut lesson: their string glows and is named, a dashed arrow shows where to cross it,
  // and once the strings touch a big bar shows the sawing until it snaps
  function pill(g, text, x, y, fill) {
    g.save(); g.font = '15px PKTitan, sans-serif'; g.textAlign = 'center';
    var w = g.measureText(text).width + 22;
    g.fillStyle = fill; g.strokeStyle = '#fff'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(x - w / 2 + 11, y - 13); g.arcTo(x + w / 2, y - 13, x + w / 2, y + 13, 13); g.arcTo(x + w / 2, y + 13, x - w / 2, y + 13, 13); g.arcTo(x - w / 2, y + 13, x - w / 2, y - 13, 13); g.arcTo(x - w / 2, y - 13, x + w / 2, y - 13, 13); g.closePath();
    g.fill(); g.stroke(); g.fillStyle = '#fff'; g.fillText(text, x, y + 5); g.restore();
  }
  function drawCutCue(g, now, p) {
    var r = sim.rivals[0], me = sim.me, pulse = 0.5 + 0.5 * Math.sin(now / 170);
    var ax = r.ax / U, ay = r.ay / U, rx = r.x / U, ry = r.y / U;
    g.save(); g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,210,63,' + (0.28 + 0.3 * pulse) + ')'; g.lineWidth = 13;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(rx, ry); g.stroke();
    g.restore();
    var lx = rx + (ax - rx) * 0.14, ly = ry + (ay - ry) * 0.14;
    if (!r.lock) pill(g, 'THEIR STRING', lx + 70, ly, '#c0265f');
    if (!r.lock && p.live < 120) {
      var x = me.x / U, y = me.y / U, a = me.h / 1024 * Math.PI * 2, dx = Math.sin(a), dy = -Math.cos(a);
      var hit = intersect(x, y, x + dx * 100, y + dy * 100, ax, ay, rx, ry);
      g.save(); g.strokeStyle = '#ffd23f'; g.lineWidth = 4; g.lineCap = 'round'; g.setLineDash([9, 9]); g.lineDashOffset = -now / 40;
      g.beginPath(); g.moveTo(x + dx * 30, y + dy * 30); g.lineTo(hit[0], hit[1]); g.stroke(); g.setLineDash([]);
      g.lineWidth = 5; g.beginPath(); g.arc(hit[0], hit[1], 11 + 3 * pulse, 0, Math.PI * 2); g.stroke();
      g.restore();
    }
    if (r.lock) {
      var win = Math.max(0, r.bal) * 2 / (PK.CUT_AT * PK.SIZE_LINE[r.big]), lose = Math.max(0, -r.bal) / PK.CUT_AT;
      g.save(); g.fillStyle = '#3a1d2e'; g.strokeStyle = '#fff'; g.lineWidth = 3;
      g.beginPath(); g.rect(77, 150, 260, 20); g.fill(); g.stroke();
      g.fillStyle = lose > win ? '#ff4d6d' : '#ffd23f'; g.fillRect(79, 152, 256 * Math.min(1, Math.max(win, lose)), 16);
      g.restore();
      pill(g, 'KEEP HOLDING!', 207, 196, '#c0265f');
    }
  }
  var HEADS = [['HOLD TO FLY UP', 'Press and keep your finger down'], ['LET GO TO SPIN', 'Lift your finger: the kite turns'], ['POINT, THEN HOLD', 'The kite flies where its nose points'], ['HOLD TO CUT', 'Hold to pull across their string']];
  function drawPrac(g, now) {
    var p = prac; if (!p) return;
    if (p.phase === 'ready') {
      g.save(); g.globalAlpha = 0.25; g.fillStyle = '#5b2340'; g.fillRect(fit.visLeft, fit.visTop, fit.visRight - fit.visLeft, fit.visBottom - fit.visTop); g.restore();
      caption(g, "YOU'RE READY!", 207, 330, 1, '#ffd23f');
      return;
    }
    if (p.i === 3 && p.phase === 'run' && sim.rivals[0] && sim.rivals[0].id === 7) drawCutCue(g, now, p);
    var me = sim.me, aimed2 = p.i === 2 && !me.pull && PK.aimedAt(me.h, RINGS[2].x * U - me.x, RINGS[2].y * U - me.y, 6);
    var want = p.want, head = HEADS[p.i], sub = head[1], title = head[0], hot = '#ffffff';
    if (p.i === 0 && p.live > 0 && want === 'hold') title = 'KEEP HOLDING';
    if (p.i === 2 && !want && !me.pull && !fingerDown) { title = 'WAIT FOR THE ARROW'; sub = 'The kite is turning toward the star'; }
    if (p.i === 3) { title = want ? 'HOLD TO CUT' : 'KEEP HOLDING'; sub = want ? 'Hold to pull across their string' : 'Pull through their string until it snaps'; hot = '#ffd23f'; }
    if (p.i === 1) {
      if (want === 'let') { title = 'LET GO!'; sub = 'Take your finger off the screen'; }
      else { title = 'SEE IT SPIN'; sub = 'No pull: the kite spins on the spot'; hot = '#ffd23f'; }
    }
    if (want === 'now') { title = 'HOLD NOW!'; sub = 'The arrow faces the star'; hot = '#ffd23f'; }
    var rr = p.phase === 'run' || p.phase === 'gap';
    if (rr) {
      var al = p.phase === 'gap' ? 0.55 : 1;
      for (var d = 0; d < 4; d++) {                      // four dots: where you are
        g.save(); g.globalAlpha = al; g.lineWidth = 3; g.strokeStyle = '#5b2340'; g.fillStyle = d <= p.i ? '#ffd23f' : 'rgba(255,255,255,0.5)';
        g.beginPath(); g.arc(207 + (d - 1.5) * 22, 52, 6, 0, Math.PI * 2); g.stroke(); g.fill(); g.restore();
      }
      g.save(); g.globalAlpha = al; caption(g, title, 207, 94, 1, hot);
      g.font = '16px PKTitan, sans-serif'; g.textAlign = 'center'; g.lineWidth = 4; g.strokeStyle = '#5b2340'; g.strokeText(sub, 207, 120); g.fillStyle = '#fff'; g.fillText(sub, 207, 120); g.restore();
    }
    if (p.i === 1 && !want && !me.pull && rr) {          // how far round it has spun, filling gold
      var sx = lerp(prev.x, me.x, 1) / U, sy = me.y / U, fr = Math.min(1, p.slip / SPIN_STEPS);
      g.save(); g.lineCap = 'round'; g.lineWidth = 9; g.strokeStyle = 'rgba(91,35,64,0.7)'; g.beginPath(); g.arc(sx, sy, 50, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 6; g.strokeStyle = '#ffd23f'; g.beginPath(); g.arc(sx, sy, 50, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fr); g.stroke(); g.restore();
    }
    if (!want) return;
    var fade = Math.min(1, (now - p.shownAt) / 180), k = ((now - p.shownAt) % 1400) / 1400;
    var hx = 207, hy = 590;
    if (want === 'hold' || want === 'now' || want === 'cut') drawHand(g, hx, hy, fade, k > 0.3);
    else if (want === 'let') drawHand(g, hx, hy - (k > 0.3 ? Math.min(28, (k - 0.3) * 80) : 0), fade, k <= 0.3);
  }

  // ── the loop ────────────────────────────────────────────────────────────
  function frame(now) {
    requestAnimationFrame(frame);
    if (lastT === null) lastT = now;
    var dt = RP && state === 'play' ? RP.elapsed(now - lastT, 1e9) : Math.min(STEP_MS * MAX_CATCHUP, now - lastT); lastT = now;
    if (state === 'play') {
      acc += dt;
      while (acc >= STEP_MS && state === 'play') { acc -= STEP_MS; stepRun(); stepFx(); }
      if (waveBanner) waveBanner.t++;
    } else if (state === 'prac') {
      if (prac) pracSync();
      acc += dt;
      while (acc >= STEP_MS) { acc -= STEP_MS; stepPrac(); stepFx(); }
      // only a frozen practice (waiting for the player) drops its spare time, and then
      // the drawn kite is parked exactly on the simulated one, so nothing snaps back
      // The sparks, texts and shake still settle meanwhile, on a clock of their own: held at zero
      // with the rest they never ended on a fast screen (the screen shook for good after the cut).
      if (prac && (prac.want || prac.phase === 'ready' || prac.phase === 'gap')) {
        acc = 0; prev = snap(sim);
        fxAcc += dt; while (fxAcc >= STEP_MS) { fxAcc -= STEP_MS; stepFx(); }
      } else fxAcc = 0;
    } else if (state === 'dying' || state === 'over') {
      acc += dt; while (acc >= STEP_MS) { acc -= STEP_MS; stepFx(); }          // the remainder is kept: zeroing it each frame never let a fast screen reach a step
    }
    render(now);
  }

  // ── menu and buttons ────────────────────────────────────────────────────
  function syncPlay() {
    var ok = window.__kjSessionReady && window.__kjSessionReady();
    playBtn.disabled = !ok; playLabel.textContent = ok ? 'PLAY' : 'PREPARING YOUR GAME';
    pplay.disabled = !ok; pplay.textContent = ok ? 'PLAY' : 'PREPARING...';
    if (RP && ok && state === 'menu' && !ranOnce) { ranOnce = true; startRun(); }
  }
  if (window.__kjOnSessionReady) window.__kjOnSessionReady(syncPlay);
  syncPlay();
  var ranOnce = false;
  function pressPlay() {
    if (!(window.__kjSessionReady && window.__kjSessionReady())) return;
    if (EMBED && ranOnce) return;                     // one run per session
    if (state === 'prac') endPractice();
    ranOnce = true; startRun();
  }
  playBtn.addEventListener('click', function (e) {
    e.stopPropagation(); audio();
    if (state !== 'menu') return;
    var force = qp('tut');
    var show = force === '1' || (force !== '0' && !(window.KJTut && KJTut.seen()));
    if (show) startPractice(); else pressPlay();
  });
  learnBtn.addEventListener('click', function (e) { e.stopPropagation(); audio(); if (state === 'menu') startPractice(); });
  pplay.addEventListener('click', function (e) { e.stopPropagation(); pressPlay(); });
  pskip.addEventListener('click', function (e) { e.stopPropagation(); if (state === 'prac' && prac && prac.phase !== 'ready') pracSetup(4); });
  $('retryBtn').addEventListener('click', function (e) {
    e.stopPropagation(); if (EMBED) return;
    overEl.classList.add('is-hidden'); startRun();
  });

  window.addEventListener('resize', function () { boxW = 0; });
  setInterval(function () { if (canvas.clientWidth !== boxW || canvas.clientHeight !== boxH) boxW = 0; }, 500);
  resize();
  if (!EMBED || window.__pkHarness) window.__pk = { get shake() { return shake; }, get sim() { return sim; }, get state() { return state; }, get prac() { return prac; } };
  requestAnimationFrame(frame);
})();
