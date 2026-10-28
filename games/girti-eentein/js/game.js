(function () {
  'use strict';
  var G = window.GE;
  // ===================== client (cosmetic below here; the rules are in rules.js) =====================
  var W = 414, H = 736, CELL = 29, WX = 18, WY = 112, WW = G.COLS * CELL, WH = (G.ROWS - G.HIDDEN) * CELL;
  var PX = 320, PW = 82;                      // the right-hand panel
  var HOLD_BOX = { x: 14, y: 14, w: 82, h: 86 };
  var TAP_MOVE = 14, SOFT_MS = 180, SWIPE_DY = 34, SWIPE_MS = 300, AXIS_PX = 12, MOVE_PX = 24;   // touch gestures, design px and ms
  var DAS_STEPS = 10, ARR_STEPS = 2;                                    // keyboard auto-repeat, in steps
  var EMBED = !!window.__kjEmbed;
  var Q = EMBED ? '' : location.search;       // testing switches work standalone only
  var canvas = document.getElementById('game'), ctx = canvas.getContext('2d');
  var menu = document.getElementById('menu'), over = document.getElementById('over');
  var playBtn = document.getElementById('playBtn'), howBtn = document.getElementById('howBtn');
  var skipBtn = document.getElementById('skipBtn'), readyBox = document.getElementById('readyBox'), readyBtn = document.getElementById('readyBtn');
  var RP = (window.KJReplay && window.KJReplay.active()) ? window.KJReplay : null;
  if (RP) RP.ready('girti-eentein');
  var standaloneSeed = Number((Q.match(/[?&]seed=(\d+)/) || [])[1]) || ((Math.random() * 1e9) >>> 0);
  var sessionReady = false, traceVersion = 0, replayCur = null, submitDone = true, runsStarted = 0;
  var mode = 'menu';                         // menu | tut | play | over
  var st = null, tut = null;
  var fit = null, K = 1, DPR = 1;
  var bricks = null, ghosts = null, minis = null, backImg = null, wellImg = null, vig = null, handImg = null;
  var parts = [], floats = [], trails = [], banner = null, flashA = 0, flashCol = '#fff', shake = 0, nudgeX = 0;
  var pending = [], buffered = null, das = null, gesture = null, tapMark = null;

  // I O T S Z J L: our own glazed brick colours.
  var COLS_HEX = ['#2f9e9a', '#e3c27a', '#d2583a', '#6aa84f', '#9b4a86', '#4f63c4', '#ef9a2e'];
  var FONT = '"Titan One", "Arial Rounded MT Bold", sans-serif';
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    function f(c) { return Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt); }
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function R(a, b) { return a + Math.random() * (b - a); }
  function ease(t) { return 1 - (1 - t) * (1 - t) * (1 - t); }
  function backOut(t) { var c = 2.2, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; }

  // ---- pre-rendered art ----
  function buildBrick(col, size, px) {
    var cv = document.createElement('canvas'); cv.width = cv.height = Math.ceil(size * px); var c = cv.getContext('2d');
    c.scale(px, px);
    var s = size, m = Math.max(1, s * 0.05), r = s * 0.14;
    // mortar shadow, offset down-right
    rr(c, m + s * 0.04, m + s * 0.06, s - 2 * m, s - 2 * m, r); c.fillStyle = 'rgba(20,6,2,.55)'; c.fill();
    // body
    var g = c.createLinearGradient(0, m, 0, s - m); g.addColorStop(0, shade(col, 0.2)); g.addColorStop(0.55, col); g.addColorStop(1, shade(col, -0.18));
    rr(c, m, m, s - 2 * m - s * 0.03, s - 2 * m - s * 0.04, r); c.fillStyle = g; c.fill();
    c.save(); rr(c, m, m, s - 2 * m - s * 0.03, s - 2 * m - s * 0.04, r); c.clip();
    // bevel: light top and left, dark bottom and right
    var bw = s * 0.12;
    c.fillStyle = 'rgba(255,255,255,.38)'; c.fillRect(m, m, s, bw);
    c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(m, m, bw * 0.8, s);
    c.fillStyle = shade(col, -0.38); c.globalAlpha = 0.7; c.fillRect(m, s - m - s * 0.04 - bw, s, bw);
    c.globalAlpha = 0.35; c.fillRect(s - m - s * 0.03 - bw * 0.8, m, bw * 0.8, s);
    c.globalAlpha = 1;
    // glaze: a soft gloss in the top-left corner
    var gl = c.createRadialGradient(s * 0.32, s * 0.3, 0, s * 0.32, s * 0.3, s * 0.42);
    gl.addColorStop(0, 'rgba(255,255,255,.42)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gl; c.fillRect(0, 0, s, s);
    // kiln speckles
    c.fillStyle = shade(col, -0.45);
    for (var i = 0; i < 4; i++) { c.globalAlpha = R(0.18, 0.35); c.beginPath(); c.arc(R(s * 0.25, s * 0.8), R(s * 0.3, s * 0.8), R(s * 0.02, s * 0.045), 0, 6.2832); c.fill(); }
    c.globalAlpha = 1; c.restore();
    c.lineWidth = Math.max(0.8, s * 0.035); c.strokeStyle = 'rgba(30,10,4,.55)';
    rr(c, m, m, s - 2 * m - s * 0.03, s - 2 * m - s * 0.04, r); c.stroke();
    return cv;
  }
  function buildGhost(col, size, px) {
    var cv = document.createElement('canvas'); cv.width = cv.height = Math.ceil(size * px); var c = cv.getContext('2d');
    c.scale(px, px); var s = size, m = s * 0.1;
    rr(c, m, m, s - 2 * m, s - 2 * m, s * 0.14); c.fillStyle = shade(col, 0.1); c.globalAlpha = 0.14; c.fill();
    c.globalAlpha = 0.75; c.lineWidth = s * 0.07; c.strokeStyle = shade(col, 0.25); c.setLineDash([s * 0.18, s * 0.1]); c.stroke();
    return cv;
  }
  function buildWell(px) {
    var M = 8, cv = document.createElement('canvas'); cv.width = Math.ceil((WW + M * 2) * px); cv.height = Math.ceil((WH + M * 2) * px);
    var c = cv.getContext('2d'); c.scale(px, px);
    // terracotta frame
    rr(c, 0, 0, WW + M * 2, WH + M * 2, 12); c.fillStyle = '#4a1d0f'; c.fill();
    var g = c.createLinearGradient(0, 0, 0, WH + M * 2); g.addColorStop(0, '#c4673f'); g.addColorStop(1, '#8c3a1f');
    rr(c, 1, 1, WW + M * 2 - 2, WH + M * 2 - 2, 11); c.fillStyle = g; c.fill();
    c.fillStyle = 'rgba(255,220,180,.28)'; rr(c, 3, 2, WW + M * 2 - 6, 4, 2); c.fill();
    // the well floor: dark mortar with faint columns
    var g2 = c.createLinearGradient(0, M, 0, M + WH); g2.addColorStop(0, '#170905'); g2.addColorStop(1, '#2a120a');
    c.fillStyle = g2; c.fillRect(M, M, WW, WH);
    c.fillStyle = 'rgba(255,190,140,.045)';
    for (var x = 1; x < G.COLS; x++) c.fillRect(M + x * CELL - 0.5, M, 1, WH);
    for (var y = 1; y < G.ROWS - G.HIDDEN; y++) c.fillRect(M, M + y * CELL - 0.5, WW, 1);
    var sh = c.createLinearGradient(0, M, 0, M + 24); sh.addColorStop(0, 'rgba(0,0,0,.55)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = sh; c.fillRect(M, M, WW, 24);
    c.lineWidth = 1.5; c.strokeStyle = 'rgba(0,0,0,.6)'; c.strokeRect(M - 0.75, M - 0.75, WW + 1.5, WH + 1.5);
    wellImg = { cv: cv, m: M };
  }
  // The brick wall behind everything, at the canvas's own pixel size.
  function buildBack() {
    backImg = document.createElement('canvas'); backImg.width = canvas.width; backImg.height = canvas.height;
    var c = backImg.getContext('2d');
    c.fillStyle = '#3a170c'; c.fillRect(0, 0, backImg.width, backImg.height);
    c.setTransform(K, 0, 0, K, fit.offX * DPR, fit.offY * DPR);
    var BW = 46, BH = 22, x0 = fit.visLeft - BW, x1 = fit.visRight + BW, y0 = fit.visTop - BH, y1 = fit.visBottom + BH;
    for (var row = Math.floor(y0 / BH); row * BH < y1; row++) {
      var off = (row & 1) ? BW / 2 : 0;
      for (var bx = Math.floor((x0 - off) / BW); bx * BW + off < x1; bx++) {
        var x = bx * BW + off, y = row * BH, base = ['#7a2f19', '#86361d', '#6d2914', '#91401f', '#7f3318'][Math.floor(Math.random() * 5)];
        rr(c, x + 1.2, y + 1.2, BW - 2.4, BH - 2.4, 3); c.fillStyle = base; c.fill();
        c.fillStyle = 'rgba(255,200,160,.08)'; c.fillRect(x + 2, y + 2, BW - 4, 3);
        c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(x + 2, y + BH - 5, BW - 4, 3);
      }
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    var w = backImg.width, h = backImg.height, vg = c.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.2, w / 2, h * 0.45, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(20,6,2,.25)'); vg.addColorStop(1, 'rgba(20,6,2,.82)'); c.fillStyle = vg; c.fillRect(0, 0, w, h);
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
    rr(g, 12, 84, 42, 13, 4); shape('#d2583a');
    handImg = cv;
  }
  function resize() {
    var bw = Math.max(1, document.documentElement.clientWidth), bh = Math.max(1, document.documentElement.clientHeight);
    var d = Math.min(3, window.devicePixelRatio || 1);
    var cw = Math.round(bw * d), ch = Math.round(bh * d), sizeChanged = false;
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; sizeChanged = true; }
    fit = KJFit.compute({ boxW: bw, boxH: bh, W: W, H: H, bandTop: 8, bandBottom: 706, anchor: 'center' });
    var k = fit.s * d; DPR = d;
    if (!bricks || Math.abs(k - K) > 0.001) {
      K = k; bricks = []; ghosts = []; minis = [];
      for (var i = 0; i < 7; i++) { bricks.push(buildBrick(COLS_HEX[i], CELL, k)); ghosts.push(buildGhost(COLS_HEX[i], CELL, k)); minis.push(buildBrick(COLS_HEX[i], 16, k)); }
      buildWell(k); sizeChanged = true;
    }
    if (sizeChanged) buildBack();
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

  // ---- audio (Web Audio only) ----
  var AC = null, master = null, nbuf = null;
  function audio() {
    if (AC) return AC;
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      var comp = AC.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6; comp.connect(AC.destination);
      master = AC.createGain(); master.gain.value = 0.85; master.connect(comp);
      nbuf = AC.createBuffer(1, AC.sampleRate * 0.6, AC.sampleRate); var dd = nbuf.getChannelData(0); for (var i = 0; i < dd.length; i++) dd[i] = Math.random() * 2 - 1;
    } catch (e) { AC = null; }
    return AC;
  }
  audio();   // constructing costs the most and needs no gesture; resuming is cheap
  function unlock() { var a = audio(); if (a && a.state !== 'running') { try { a.resume(); } catch (e) {} } }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (n) { window.addEventListener(n, unlock, { passive: true }); });
  document.addEventListener('visibilitychange', function () { if (!AC) return; if (document.hidden) AC.suspend(); else AC.resume(); });
  function tone(f, d, type, vol, when, slideTo) {
    if (!AC || AC.state !== 'running') return; var t = AC.currentTime + (when || 0), o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.03);
  }
  function noise(d, f0, f1, vol, when, type, q) {
    if (!AC || AC.state !== 'running') return; var t = AC.currentTime + (when || 0), s = AC.createBufferSource(); s.buffer = nbuf;
    var bp = AC.createBiquadFilter(); bp.type = type || 'bandpass'; bp.Q.value = q || 1; bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + d);
    var g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    s.connect(bp); bp.connect(g); g.connect(master); s.start(t); s.stop(t + d + 0.03);
  }
  var PENTA = [0, 2, 4, 7, 9];
  function noteHz(k) { var n = PENTA[k % 5] + 12 * Math.floor(k / 5); return 293.66 * Math.pow(2, Math.min(n, 30) / 12); }
  function sMove() { tone(520, 0.03, 'triangle', 0.05); }
  function sTurn() { tone(640, 0.04, 'triangle', 0.06); tone(860, 0.04, 'triangle', 0.04, 0.025); }
  function sBlocked() { tone(150, 0.05, 'sine', 0.05, 0, 110); }
  function sLock(hard) { tone(hard ? 110 : 140, hard ? 0.16 : 0.11, 'sine', hard ? 0.3 : 0.2, 0, 60); noise(hard ? 0.14 : 0.08, 500, 160, hard ? 0.16 : 0.09, 0, 'lowpass', 0.8); }
  function sHold() { tone(440, 0.07, 'triangle', 0.08); tone(330, 0.09, 'triangle', 0.07, 0.05); }
  function sClear(n, combo) {
    var k = Math.min(14, 2 + Math.max(0, combo) * 2);
    for (var i = 0; i < n; i++) { tone(noteHz(k + i), 0.32, 'triangle', 0.13, i * 0.06); tone(noteHz(k + i) * 2, 0.2, 'sine', 0.04, i * 0.06 + 0.02); }
    noise(0.35, 2200, 400, 0.08, 0.06, 'bandpass', 0.7);
  }
  function sChaar() {
    tone(80, 0.5, 'sine', 0.34, 0, 40); noise(0.6, 900, 120, 0.22, 0, 'lowpass', 0.6);
    [0, 4, 7, 12].forEach(function (n, i) { tone(392 * Math.pow(2, n / 12), 0.55, 'triangle', 0.12, 0.08 + i * 0.06); });
  }
  function sLevel() { [0, 4, 7, 12].forEach(function (n, i) { tone(523 * Math.pow(2, n / 12), 0.3, 'sine', 0.1, i * 0.07); }); }
  function sTick(hi) { tone(hi ? 1250 : 900, 0.05, 'sine', 0.08); }
  function sWarn() { tone(660, 0.12, 'triangle', 0.12); tone(880, 0.16, 'triangle', 0.12, 0.12); }
  function sStart() { tone(392, 0.14, 'triangle', 0.13); tone(587, 0.24, 'triangle', 0.13, 0.1); }
  function sEnd() { [523, 440, 349, 262].forEach(function (f, i) { tone(f, 0.45, 'triangle', 0.14, i * 0.13); }); }
  function sReady() { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.35, 'triangle', 0.11, i * 0.08); }); }

  // ---- particles ----
  function cellX(c) { return WX + c * CELL; }
  function cellY(r) { return WY + (r - G.HIDDEN) * CELL; }
  function crumble(cx, cy, col, delay) {
    for (var i = 0; i < 3 && parts.length < 700; i++) parts.push({ k: 0, x: cx + R(-10, 10), y: cy + R(-10, 10), vx: R(-140, 140), vy: R(-230, -40), g: 900, life: R(0.6, 1.1), age: -delay, sz: R(4, 8), col: col, rot: R(0, 6), vr: R(-9, 9) });
    for (var j = 0; j < 2 && parts.length < 700; j++) parts.push({ k: 1, x: cx + R(-8, 8), y: cy + R(-6, 6), vx: R(-40, 40), vy: R(-50, -10), g: -20, life: R(0.6, 1.0), age: -delay, sz: R(8, 15), col: '#d9a77f' });
  }
  function dust(x, y, n) {
    for (var i = 0; i < n && parts.length < 700; i++) parts.push({ k: 1, x: x + R(-12, 12), y: y + R(-3, 2), vx: R(-60, 60), vy: R(-30, -5), g: -10, life: R(0.35, 0.6), age: 0, sz: R(5, 10), col: '#c99a74' });
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
    parts = []; floats = []; trails = []; banner = { t: performance.now(), txt: 'GO!', col: '#ffd27a' };
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
  var BUFFERABLE = { 0: 1, 1: 1, 2: 1, 3: 1, 6: 1, 7: 1 };
  function applyAct(sim, a, live) {
    var n = sim.n, step = sim.frame;
    var r = G.actSim(sim, a);
    if (r === true) {
      // The ACTION only, never its result: the server replays it.
      if (live && traceVersion >= 2 && typeof window.__kjAct === 'function') { try { window.__kjAct(performance.now(), n, a, step); } catch (_e) {} }
      if (a === G.A_LEFT || a === G.A_RIGHT) sMove();
      else if (a === G.A_CW || a === G.A_CCW) sTurn();
      return true;
    }
    if (live && r === 'no_piece' && BUFFERABLE[a]) buffered = { a: a, until: step + G.CLEAR_STEPS + 4 };
    else if (r === 'blocked' && (a === G.A_LEFT || a === G.A_RIGHT)) { nudgeX = a === G.A_LEFT ? -3 : 3; sBlocked(); }
    else if (r === 'blocked' || r === 'no_turn' || r === 'hold_used') sBlocked();
    return r;
  }
  function processStep() {
    var sim = st.sim;
    G.beginStep(sim);
    if (replayCur) {
      var due = replayCur.due(sim.frame);
      for (var di = 0; di < due.length && !sim.dead; di++) applyAct(sim, Number(due[di].a), false);
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
      else if (e.e === 'hold') sHold();
      else if (e.e === 'lock') onLock(e, holder, now);
      else if (e.e === 'topout') { shake = 6; }
    }
  }
  function onLock(e, holder, now) {
    var cells = G.pieceCells(e.t, e.r), col = COLS_HEX[e.t], botY = 0, i;
    for (i = 0; i < 4; i++) botY = Math.max(botY, e.y + cells[i][1]);
    if (e.hard && holder.dropFrom != null) {
      for (i = 0; i < 4; i++) trails.push({ x: cellX(e.x + cells[i][0]), y0: cellY(holder.dropFrom + cells[i][1]), y1: cellY(e.y + cells[i][1]), col: col, t: now });
      shake = Math.max(shake, 2.5);
    }
    holder.dropFrom = null;
    sLock(e.hard);
    for (i = 0; i < 4; i++) if (e.y + cells[i][1] === botY) dust(cellX(e.x + cells[i][0]) + CELL / 2, cellY(botY) + CELL, 2);
    if (e.rows.length) {
      // Rebuild the board as it was the moment the piece landed, for the crumble.
      var before = rebuildBefore(holder === tut ? tut.sim.board : st.sim.board, e);
      holder.clearAnim = { t: now, rows: e.rows, before: before, done: false };
      for (var r = 0; r < e.rows.length; r++) for (var c = 0; c < G.COLS; c++) {
        var v = before[e.rows[r] * G.COLS + c]; crumble(cellX(c) + CELL / 2, cellY(e.rows[r]) + CELL / 2, COLS_HEX[(v || 1) - 1], 0.12 + c * 0.012);
      }
      var cy = cellY(e.rows[0]) + CELL * e.rows.length / 2;
      floats.push({ x: WX + WW / 2, y: cy, txt: '+' + e.gained.toLocaleString('en-US'), t: now, size: e.rows.length === 4 ? 34 : 26 });
      sClear(e.rows.length, e.combo);
      if (e.rows.length === 4) { sChaar(); shake = 9; flashA = 0.55; flashCol = '#ffb35c'; banner = { t: now, txt: 'CHAAR!', col: '#ffd27a', size: 72, dur: 1200 }; }
      else if (e.rows.length === 3) shake = Math.max(shake, 4);
      if (e.combo >= 1) holder.comboPop = now;
      if (e.levelUp) { holder.levelPop = now; setTimeout(sLevel, 260); if (e.rows.length !== 4) banner = { t: now + 250, txt: 'LEVEL ' + e.level, col: '#9fe0a8', size: 46, dur: 1200 }; }
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
    parts = []; floats = []; trails = []; banner = null;
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
    if (a === G.A_HOLD || a === G.A_SOFT_ON || a === G.A_SOFT_OFF) return;   // not taught here
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
    tut = null; mode = 'menu'; parts = []; floats = []; trails = [];
    if (play && sessionReady) newRun();
    else menu.classList.remove('is-hidden');
  }

  // ---- input ----
  function designPt(e) { return KJFit.toDesign(fit, e.clientX, e.clientY); }
  function inHold(p) { return p.x >= HOLD_BOX.x && p.x <= HOLD_BOX.x + HOLD_BOX.w && p.y >= HOLD_BOX.y && p.y <= HOLD_BOX.y + HOLD_BOX.h; }
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
    if (inHold({ x: g.x, y: g.y })) { act(G.A_HOLD); return; }
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
  var KEYMAP = { ArrowLeft: 'L', KeyA: 'L', ArrowRight: 'R', KeyD: 'R', ArrowUp: 'CW', KeyX: 'CW', KeyW: 'CW', KeyZ: 'CCW', ControlLeft: 'CCW', ControlRight: 'CCW', ArrowDown: 'SOFT', KeyS: 'SOFT', Space: 'HARD', KeyC: 'HOLD', ShiftLeft: 'HOLD', ShiftRight: 'HOLD' };
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
    else if (k === 'HOLD') act(G.A_HOLD);
  });
  window.addEventListener('keyup', function (e) {
    var k = KEYMAP[e.code]; if (!k) return;
    if (das && das.code === e.code) das = null;
    if (k === 'SOFT') act(G.A_SOFT_OFF);
  });
  window.addEventListener('blur', function () { das = null; if (st && st.sim && st.sim.soft) act(G.A_SOFT_OFF); });
  playBtn.addEventListener('click', function () {
    unlock();
    if (!sessionReady) return;
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
    ctx.fillStyle = 'rgba(40,10,2,.55)'; ctx.fillText(s, x, y + Math.max(2, size * 0.07));
    ctx.fillStyle = col; ctx.fillText(s, x, y);
  }
  function outlined(s, x, y, size, col) {
    ctx.font = size + 'px ' + FONT; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(5, size * 0.16); ctx.strokeStyle = '#3a1206'; ctx.strokeText(s, x, y + size * 0.06); ctx.strokeText(s, x, y);
    ctx.fillStyle = col; ctx.fillText(s, x, y);
  }
  function panel(x, y, w, h) {
    rr(ctx, x, y + 3, w, h, 14); ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fill();
    rr(ctx, x, y, w, h, 14); ctx.fillStyle = '#4a1d0f'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#a24c2a'; rr(ctx, x + 1, y + 1, w - 2, h - 2, 13); ctx.stroke();
  }
  function label(s, x, y, col) { ctx.font = '12px ' + FONT; ctx.textAlign = 'center'; ctx.fillStyle = col || '#e9b48a'; ctx.fillText(s, x, y); }
  // A whole piece as small bricks, centred on (cx, cy).
  function drawMini(t, cx, cy, size, alpha) {
    var c = G.pieceCells(t, 0), minX = 9, maxX = -9, minY = 9, maxY = -9, i;
    for (i = 0; i < 4; i++) { minX = Math.min(minX, c[i][0]); maxX = Math.max(maxX, c[i][0]); minY = Math.min(minY, c[i][1]); maxY = Math.max(maxY, c[i][1]); }
    var sc = size / 16, w = (maxX - minX + 1) * size, h = (maxY - minY + 1) * size;
    for (i = 0; i < 4; i++) {
      var x = cx - w / 2 + (c[i][0] - minX) * size, y = cy - h / 2 + (c[i][1] - minY) * size;
      if (sc === 1) blitTL(minis[t], x, y, alpha);
      else { ctx.globalAlpha = alpha == null ? 1 : alpha; ctx.drawImage(minis[t], x, y, size, size); ctx.globalAlpha = 1; }
    }
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
  function drawWell(holder, sim, now, dt) {
    blitTL(wellImg.cv, WX - wellImg.m, WY - wellImg.m);
    ctx.save(); ctx.beginPath(); ctx.rect(WX, WY, WW, WH); ctx.clip();
    var ca = holder.clearAnim;
    if (ca && !ca.done) {
      // The landed board: full rows flash, then crumble away while the rest settles.
      var u = Math.min(1, (now - ca.t) / 400), fall = u < 0.45 ? 0 : ease((u - 0.45) / 0.55);
      for (var r = G.HIDDEN; r < G.ROWS; r++) {
        var gone = ca.rows.indexOf(r) >= 0, below = 0;
        for (var k = 0; k < ca.rows.length; k++) if (ca.rows[k] > r) below++;
        for (var c = 0; c < G.COLS; c++) {
          var v = ca.before[r * G.COLS + c]; if (!v) continue;
          if (gone) { if (u < 0.3) { blitTL(bricks[v - 1], cellX(c), cellY(r)); ctx.globalAlpha = 0.75 * Math.sin(u / 0.3 * Math.PI); ctx.fillStyle = '#fff4d8'; ctx.fillRect(cellX(c), cellY(r), CELL, CELL); ctx.globalAlpha = 1; } }
          else blitTL(bricks[v - 1], cellX(c), cellY(r) + below * CELL * fall);
        }
      }
      if (u >= 1) ca.done = true;
    } else drawBoard(sim.board);
    // the ghost and the piece
    if (sim.cur) {
      var k2 = Math.min(1, dt * 28);
      holder.dispX += (sim.cur.x - holder.dispX) * k2; holder.dispY += (sim.cur.y - holder.dispY) * k2;
      if (Math.abs(sim.cur.x - holder.dispX) < 0.02 || Math.abs(sim.cur.x - holder.dispX) > 3) holder.dispX = sim.cur.x;
      if (Math.abs(sim.cur.y - holder.dispY) < 0.02 || Math.abs(sim.cur.y - holder.dispY) > 3) holder.dispY = sim.cur.y;
      var gd = G.dropDistance(sim.board, sim.cur);
      if (gd > 0) drawPiece(sim.cur, sim.cur.x, sim.cur.y + gd, ghosts);
      var lockGlow = sim.lockT > 0 ? sim.lockT / G.LOCK_STEPS : 0;
      drawPiece(sim.cur, holder.dispX, holder.dispY, bricks);
      if (lockGlow > 0) {   // a landed piece brightens as its lock wait runs out
        var cc = G.pieceCells(sim.cur.t, sim.cur.r);
        ctx.globalAlpha = 0.28 * lockGlow; ctx.fillStyle = '#fff2d6';
        for (var q = 0; q < 4; q++) ctx.fillRect(cellX(holder.dispX + cc[q][0]) + 2, cellY(holder.dispY + cc[q][1]) + 2, CELL - 5, CELL - 5);
        ctx.globalAlpha = 1;
      }
    }
    // hard-drop trails
    trails = trails.filter(function (t) { return now - t.t < 220; });
    trails.forEach(function (t) {
      var a = 1 - (now - t.t) / 220, g = ctx.createLinearGradient(0, t.y0, 0, t.y1 + CELL);
      g.addColorStop(0, 'rgba(255,230,190,0)'); g.addColorStop(1, 'rgba(255,230,190,' + (0.5 * a) + ')');
      ctx.fillStyle = g; ctx.fillRect(t.x + 4, t.y0, CELL - 8, t.y1 - t.y0 + CELL);
    });
    // danger: the stack is close to the top
    var top = G.ROWS;
    for (var rr2 = 0; rr2 < G.ROWS && top === G.ROWS; rr2++) for (var c2 = 0; c2 < G.COLS; c2++) if (sim.board[rr2 * G.COLS + c2]) { top = rr2; break; }
    if (top < G.HIDDEN + 5 && mode === 'play') {
      var da = (G.HIDDEN + 5 - top) / 5, gg = ctx.createLinearGradient(0, WY, 0, WY + 90);
      gg.addColorStop(0, 'rgba(255,60,30,' + (0.35 * da * (0.6 + 0.4 * Math.sin(now / 180))) + ')'); gg.addColorStop(1, 'rgba(255,60,30,0)');
      ctx.fillStyle = gg; ctx.fillRect(WX, WY, WW, 90);
    }
    ctx.restore();
  }
  function drawHud(sim, now) {
    // hold
    panel(HOLD_BOX.x, HOLD_BOX.y, HOLD_BOX.w, HOLD_BOX.h); label('HOLD', HOLD_BOX.x + HOLD_BOX.w / 2, HOLD_BOX.y + 20);
    if (sim && sim.hold >= 0) drawMini(sim.hold, HOLD_BOX.x + HOLD_BOX.w / 2, HOLD_BOX.y + 54, 16, sim.holdUsed ? 0.35 : 1);
    // score
    var sx = 104, sw = 206;
    panel(sx, 14, sw, 86);
    var sc = sim ? sim.score : 0;
    if (st && sim === st.sim) {
      if (sc !== st.scoreTarget) { st.scoreTarget = sc; st.bump = 1; }
      st.scoreShown += (sc - st.scoreShown) * 0.18; if (Math.abs(sc - st.scoreShown) < 1) st.scoreShown = sc; st.bump *= 0.88;
    }
    label('SCORE', sx + sw / 2, 34);
    ctx.save(); ctx.translate(sx + sw / 2, 66); var bs = 1 + 0.08 * (st && sim === st.sim ? st.bump : 0); ctx.scale(bs, bs);
    txt(Math.round(st && sim === st.sim ? st.scoreShown : sc).toLocaleString('en-US'), 0, 0, 30, '#fff3e2'); ctx.restore();
    var lvl = sim ? sim.level : 1, lines = sim ? sim.lines : 0;
    ctx.font = '13px ' + FONT; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd27a';
    ctx.fillText('LEVEL ' + lvl + '    ROWS ' + lines, sx + sw / 2, 90);
    // timer
    var rem = sim ? Math.max(0, G.RUN_STEPS - sim.frame) : G.RUN_STEPS, secs = Math.ceil(rem / 60);
    var col = secs <= 30 ? '#ff7a59' : secs <= 60 ? '#ffd27a' : '#fff3e2';
    var pulse = (mode === 'play' && secs <= 10) ? 1.06 + 0.05 * Math.abs(Math.sin(now / 160)) : 1;
    panel(PX, 14, PW, 86); label('TIME', PX + PW / 2, 34);
    ctx.save(); ctx.translate(PX + PW / 2, 70); ctx.scale(pulse, pulse);
    txt(Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2), 0, 0, 26, col); ctx.restore();
    // next three
    panel(PX, WY - 6, PW, 236); label('NEXT', PX + PW / 2, WY + 14);
    if (sim && st && sim === st.sim) {
      for (var i = 0; i < 3; i++) drawMini(G.pieceAt(sim.seed, sim.k + i), PX + PW / 2, WY + 50 + i * 66, i === 0 ? 16 : 13, i === 0 ? 1 : 0.8);
    } else if (tut) {
      [2, 5, 3].forEach(function (t, i2) { drawMini(t, PX + PW / 2, WY + 50 + i2 * 66, i2 === 0 ? 16 : 13, 0.8); });
    }
    // combo
    var cb = sim ? sim.combo : -1, holder = st && sim === st.sim ? st : tut;
    if (cb >= 1 && holder) {
      var cu = Math.min(1, (now - (holder.comboPop || 0)) / 260), cs = 1 + 0.3 * Math.sin(cu * Math.PI);
      panel(PX, WY + 248, PW, 96); label('COMBO', PX + PW / 2, WY + 270);
      ctx.save(); ctx.translate(PX + PW / 2, WY + 318); ctx.scale(cs, cs); outlined('x' + cb, 0, 0, 38, cb >= 4 ? '#ff9ad0' : '#ffd27a'); ctx.restore();
    }
    // level progress
    if (sim) {
      var by = WY + WH - 150, bh = 140;
      panel(PX, by - 24, PW, bh + 30); label('LEVEL', PX + PW / 2, by - 6);
      var prog = (lines % 10) / 10;
      rr(ctx, PX + PW / 2 - 9, by + 4, 18, bh - 40, 9); ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fill();
      if (prog > 0) { var ph = (bh - 40) * prog; rr(ctx, PX + PW / 2 - 9, by + 4 + bh - 40 - ph, 18, ph, 9); ctx.fillStyle = '#9fe0a8'; ctx.fill(); }
      var lp = Math.min(1, (now - ((holder && holder.levelPop) || 0)) / 400), ls = 1 + 0.3 * Math.sin(lp * Math.PI);
      ctx.save(); ctx.translate(PX + PW / 2, by + bh - 6); ctx.scale(ls, ls); txt(String(lvl), 0, 0, 24, '#9fe0a8'); ctx.restore();
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
    rr(ctx, x - w / 2, y - 22, w, 36, 18); ctx.fillStyle = 'rgba(40,14,6,.86)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffd27a'; ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff3e2'; ctx.fillText(s, x, y + 4);
  }
  function drawTutorial(now) {
    var s = tut.sim, k = ((now - tut.t) % 1100) / 1100, press = k < 0.25 ? k / 0.25 : k < 0.5 ? 1 - (k - 0.25) / 0.25 : 0;
    var tg = tut.target;
    if (s.cur && tut.step <= 4 && !tut.wait) {   // where the piece should go, pulsing
      ctx.save(); ctx.beginPath(); ctx.rect(WX, WY, WW, WH); ctx.clip();
      var c = G.pieceCells(tg.t, tg.r), pa = 0.22 + 0.16 * Math.sin(now / 220);
      ctx.fillStyle = 'rgba(255,214,140,' + pa + ')';
      for (var i = 0; i < 4; i++) { rr(ctx, cellX(tg.x + c[i][0]) + 2, cellY(tg.y + c[i][1]) + 2, CELL - 4, CELL - 4, 5); ctx.fill(); }
      ctx.restore();
    }
    if (tut.wait || tut.step > 4) return;
    var pY = cellY(s.cur ? s.cur.y : 9);
    if (tut.step === 1) {
      // a sideways drag: the hand slides left and lifts
      var u1 = ((now - tut.t) % 1300) / 1300, hy = pY + 150, sx1 = 250, ex1 = 120, hx = sx1 + (ex1 - sx1) * ease(Math.min(1, u1 / 0.6));
      var a1 = u1 < 0.75 ? 1 : 1 - (u1 - 0.75) / 0.25;
      ctx.globalAlpha = a1 * 0.6; var g1 = ctx.createLinearGradient(sx1, 0, hx, 0); g1.addColorStop(0, 'rgba(255,210,122,0)'); g1.addColorStop(1, 'rgba(255,210,122,.9)');
      ctx.fillStyle = g1; rr(ctx, hx, hy - 52, Math.max(1, sx1 - hx), 14, 7); ctx.fill(); ctx.globalAlpha = 1;
      drawHand(hx, hy - 45, 0, a1);
      caption('Swipe to move', 207, hy + 70);
    } else if (tut.step === 2) {
      var mx = 207, my = pY + 150;
      tapRipple(mx, my, k); drawHand(mx, my, press);
      caption('Tap to rotate', 207, my + 96);
    } else if (tut.step === 3) {
      var u = ((now - tut.t) % 1300) / 1300, sy = pY + 90, ey = sy + 120, yy = sy + (ey - sy) * ease(Math.min(1, u / 0.6));
      var al = u < 0.75 ? 1 : 1 - (u - 0.75) / 0.25;
      ctx.globalAlpha = al * 0.6; var gr = ctx.createLinearGradient(0, sy, 0, yy); gr.addColorStop(0, 'rgba(255,210,122,0)'); gr.addColorStop(1, 'rgba(255,210,122,.9)');
      ctx.fillStyle = gr; rr(ctx, 200, sy, 14, Math.max(1, yy - sy), 7); ctx.fill(); ctx.globalAlpha = 1;
      drawHand(207, yy, 0, al);
      caption('Swipe down to drop', 207, ey + 96);
    } else if (tut.step === 4) {
      caption('Fill a row', WX + 74, cellY(21) - 40);
      ctx.fillStyle = '#ffd27a'; ctx.beginPath(); var ax = WX + 58, ay = cellY(21) - 14 + 4 * Math.sin(now / 160);
      ctx.moveTo(ax - 9, ay - 6); ctx.lineTo(ax + 9, ay - 6); ctx.lineTo(ax, ay + 6); ctx.closePath(); ctx.fill();
    }
  }
  function drawEffects(now, dt) {
    ctx.globalCompositeOperation = 'source-over';
    parts = parts.filter(function (p) { p.age += dt; if (p.age >= p.life) return false; if (p.age < 0) return true; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.k === 0) p.rot += p.vr * dt; return true; });
    parts.forEach(function (p) {
      if (p.age < 0) return; var u = p.age / p.life, al = 1 - u;
      if (p.k === 0) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(1, al * 1.4); ctx.fillStyle = p.col; ctx.fillRect(-p.sz / 2, -p.sz / 2, p.sz, p.sz * 0.75); ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(-p.sz / 2, p.sz * 0.1, p.sz, p.sz * 0.15); ctx.restore(); }
      else { ctx.globalAlpha = al * 0.45; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.sz * (0.6 + u * 0.8), 0, 6.2832); ctx.fill(); }
    });
    ctx.globalAlpha = 1;
    floats = floats.filter(function (f) { return now - f.t < 900; });
    floats.forEach(function (f) { var u = (now - f.t) / 900; ctx.globalAlpha = u > 0.6 ? (1 - u) / 0.4 : 1; var s4 = u < 0.15 ? 0.6 + 0.4 * backOut(u / 0.15) : 1; ctx.save(); ctx.translate(f.x, f.y - 46 * ease(u)); ctx.scale(s4, s4); outlined(f.txt, 0, 0, f.size, '#fff3e2'); ctx.restore(); });
    ctx.globalAlpha = 1;
    if (tapMark) {   // a soft flash on the side that was tapped
      var tu = (now - tapMark.t) / 220; if (tu >= 1) tapMark = null;
      else { ctx.strokeStyle = 'rgba(255,226,184,' + (0.5 * (1 - tu)) + ')'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(tapMark.x, tapMark.y, 10 + 26 * ease(tu), 0, 6.2832); ctx.stroke(); }
    }
    if (banner) {
      var bu = (now - banner.t) / (banner.dur || 1000);
      if (bu >= 1) banner = null;
      else if (bu >= 0) { var bs = backOut(Math.min(1, bu * 4)), ba = bu > 0.65 ? (1 - bu) / 0.35 : 1; ctx.globalAlpha = ba; ctx.save(); ctx.translate(WX + WW / 2, WY + WH * 0.42); ctx.scale(bs, bs); outlined(banner.txt, 0, 0, banner.size || 54, banner.col); ctx.restore(); ctx.globalAlpha = 1; }
    }
  }
  function drawEnd(now) {
    if (!st || !st.over) return;
    var eu = Math.min(1, (now - st.endAt) / 350), top = st.endReason === 'topout';
    ctx.globalAlpha = 0.8 * eu; ctx.fillStyle = '#1a0904'; ctx.fillRect(WX, WY, WW, WH);
    ctx.globalAlpha = eu; ctx.save(); ctx.translate(WX + WW / 2, WY + WH / 2); var es = 0.7 + 0.3 * backOut(eu); ctx.scale(es, es);
    rr(ctx, -128, -86, 256, 180, 24); ctx.fillStyle = '#5e2414'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = top ? '#ff7a59' : '#ffd27a'; ctx.stroke();
    outlined(top ? 'WELL FULL' : "TIME'S UP", 0, -30, 40, top ? '#ff7a59' : '#ffd27a');
    ctx.font = '16px ' + FONT; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd9a3'; ctx.fillText(st.sim.lines + ' rows cleared', 0, 6);
    outlined(st.sim.score.toLocaleString('en-US'), 0, 60, 40, '#fff3e2');
    ctx.restore(); ctx.globalAlpha = 1;
  }
  var demoSim = null;
  function render(now, dt) {
    if (!bricks) resize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(backImg, 0, 0);
    nudgeX *= 0.7;
    var shx = 0, shy = 0; if (shake > 0.15) { shx = R(-shake, shake); shy = R(-shake, shake); shake *= 0.86; } else shake = 0;
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
  if (!EMBED) window.__ge = { get st() { return st; }, get tut() { return tut; }, get mode() { return mode; }, act: act, G: G };
  resize(); requestAnimationFrame(frame);
})();
