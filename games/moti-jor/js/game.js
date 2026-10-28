/*
 * Moti Jor: drag through pearls of one colour to clear them. Close a loop and
 * every pearl of that colour goes. 90 seconds.
 *
 * Phase 1 playable core: no session, no seed from the platform, no trace.
 * The board logic is already integer and grid based, and the clock runs on
 * fixed 1/60 s steps, so the later rules block can be lifted out of here.
 */
(function () {
  'use strict';

  // ── rules (phase 1, not yet a deterministic block) ────────────────────────
  var N = 6;                  // 6 x 6 board
  var KINDS = 5;              // pearl colours
  var RUN_STEPS = 90 * 60;    // 90 s on fixed steps
  var WARN_STEPS = 10 * 60;   // the clock turns red for the last 10 s

  // A small seeded generator for the board. Phase 2 replaces it with the
  // platform seed, index-addressed per column.
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rand = rng(1);
  function pick(not) {
    var k = Math.floor(rand() * KINDS);
    if (not >= 0 && k === not) k = (k + 1 + Math.floor(rand() * (KINDS - 1))) % KINDS;
    return k;
  }
  function chainPoints(n) { return n * (n + 1) / 2; }   // 2:3, 4:10, 6:21, 10:55

  // ── layout, a fixed design space ──────────────────────────────────────────
  var W = 414, H = 736;
  var CELL = 62, GX = (W - N * CELL) / 2, GY = 214, PR = 21;
  var HIT_R = CELL * 0.43;
  var COLS = ['#ff4d6d', '#2fd47f', '#4a8cff', '#ffc23d', '#b46cff'];
  var DARK = ['#9e1634', '#11804a', '#1d4fb8', '#b57a00', '#6a2bb8'];

  var canvas = document.getElementById('scene');
  var ctx = canvas.getContext('2d');
  var dpr = 1, cw = 0, ch = 0, sc = 1, ox = 0, oy = 0;
  var sprites = [], bg = null;

  function mk(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function buildPearl(k) {
    var px = sc * dpr, s = PR * 2 + 8, c = mk(s * px, s * px), g = c.getContext('2d'), m = s / 2;
    g.scale(px, px);
    var gr = g.createRadialGradient(m - 6, m - 7, 2, m, m, PR);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.18, COLS[k]); gr.addColorStop(1, DARK[k]);
    g.beginPath(); g.arc(m, m, PR, 0, Math.PI * 2); g.fillStyle = gr; g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.beginPath(); g.ellipse(m - 7, m - 9, 6, 3.5, -0.6, 0, Math.PI * 2); g.fill();
    return c;
  }
  function buildBg() {
    var c = mk(canvas.width, canvas.height), g = c.getContext('2d');
    var gr = g.createLinearGradient(0, 0, 0, c.height);
    gr.addColorStop(0, '#171c3a'); gr.addColorStop(1, '#0a0d1e');
    g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
    // the board tray
    g.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
    g.fillStyle = 'rgba(255,255,255,0.045)';
    rrect(g, GX - 10, GY - 10, N * CELL + 20, N * CELL + 20, 22); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (var c2 = 0; c2 < N; c2++) for (var r = 0; r < N; r++) {
      g.beginPath(); g.arc(GX + c2 * CELL + CELL / 2, GY + r * CELL + CELL / 2, 4, 0, Math.PI * 2); g.fill();
    }
    return c;
  }
  function rrect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function resize() {
    var w = document.documentElement.clientWidth || 1, h = document.documentElement.clientHeight || 1;
    var d = Math.min(3, window.devicePixelRatio || 1);
    if (w === cw && h === ch && d === dpr) return;
    cw = w; ch = h; dpr = d;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    sc = Math.min(cw / W, ch / H); ox = (cw - W * sc) / 2; oy = (ch - H * sc) / 2;
    sprites = []; for (var k = 0; k < KINDS; k++) sprites.push(buildPearl(k));
    bg = buildBg();
  }
  window.addEventListener('resize', resize);
  setInterval(resize, 500);
  resize();

  // ── state ─────────────────────────────────────────────────────────────────
  // board[c][r], r = 0 at the top. Each pearl: { k, dy } where dy is its
  // drawing offset in design px while it falls into place (presentation).
  var board = [], state = 'menu', step = 0, score = 0, shown = 0, best = 0;
  var chain = [], loop = false, dragging = false, moves = 0;
  var fx = { parts: [], texts: [], rings: [], shake: 0, banner: null, flash: 0 };
  try { best = Number(localStorage.getItem('motiJorBest')) || 0; } catch (_e) {}

  function cellCX(c) { return GX + c * CELL + CELL / 2; }
  function cellCY(r) { return GY + r * CELL + CELL / 2; }

  function newBoard() {
    board = [];
    for (var c = 0; c < N; c++) {
      var col = [];
      for (var r = 0; r < N; r++) col.push({ k: pick(-1), dy: -(N + 2) * CELL - r * 6 - c * 14, v: 0 });
      board.push(col);
    }
    if (!hasMove()) shuffle();
  }
  function hasMove() {
    for (var c = 0; c < N; c++) for (var r = 0; r < N; r++) {
      var k = board[c][r].k;
      if (c + 1 < N && board[c + 1][r].k === k) return true;
      if (r + 1 < N && board[c][r + 1].k === k) return true;
    }
    return false;
  }
  function shuffle() {
    var all = [], c, r, i;
    for (c = 0; c < N; c++) for (r = 0; r < N; r++) all.push(board[c][r].k);
    do {
      for (i = all.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)), t = all[i]; all[i] = all[j]; all[j] = t; }
      for (c = 0; c < N; c++) for (r = 0; r < N; r++) board[c][r].k = all[c * N + r];
    } while (!hasMove());
    fx.banner = { text: 'SHUFFLE', t: 0 };
  }
  function settled() {
    for (var c = 0; c < N; c++) for (var r = 0; r < N; r++) if (board[c][r].dy !== 0) return false;
    return true;
  }

  // ── the chain ─────────────────────────────────────────────────────────────
  function at(x, y) {
    var c = Math.floor((x - GX) / CELL), r = Math.floor((y - GY) / CELL);
    if (c < 0 || r < 0 || c >= N || r >= N) return null;
    var dx = x - cellCX(c), dy = y - cellCY(r);
    if (dx * dx + dy * dy > HIT_R * HIT_R) return null;
    return { c: c, r: r };
  }
  function same(a, b) { return a.c === b.c && a.r === b.r; }
  function adj(a, b) { return Math.abs(a.c - b.c) + Math.abs(a.r - b.r) === 1; }
  function inChain(p) { for (var i = 0; i < chain.length; i++) if (same(chain[i], p)) return true; return false; }
  function chainKind() { return chain.length ? board[chain[0].c][chain[0].r].k : -1; }

  function begin(p) {
    if (!p || !settled()) return;
    chain = [p]; loop = false; dragging = true;
    audio.note(0, chainKind());
  }
  function extend(p) {
    if (!dragging || !p || !chain.length) return;
    var last = chain[chain.length - 1];
    if (same(p, last)) return;
    // backtrack onto the one before
    if (chain.length >= 2 && same(p, chain[chain.length - 2])) {
      chain.pop(); loop = false; audio.note(chain.length - 1, chainKind(), true); return;
    }
    if (loop || !adj(p, last) || board[p.c][p.r].k !== chainKind()) return;
    if (inChain(p)) {
      if (chain.length >= 4) { chain.push(p); loop = true; audio.loop(); fx.flash = 0.25; }
      return;
    }
    chain.push(p);
    audio.note(chain.length - 1, chainKind());
  }
  function release() {
    if (!dragging) return;
    dragging = false;
    var k = chainKind(), wasLoop = loop, gone = [], c, r;
    if (state === 'play') {
      if (wasLoop) {
        for (c = 0; c < N; c++) for (r = 0; r < N; r++) if (board[c][r].k === k) gone.push({ c: c, r: r });
      } else if (chain.length >= 2) gone = chain.slice();
    }
    chain = []; loop = false;
    if (gone.length) clear(gone, k, wasLoop);
  }

  function clear(cells, k, wasLoop) {
    var pts = chainPoints(cells.length) * (wasLoop ? 2 : 1);
    score += pts; moves++;
    var sx = 0, sy = 0, i;
    var dead = [];
    for (var c = 0; c < N; c++) { dead.push([]); for (var r = 0; r < N; r++) dead[c].push(false); }
    for (i = 0; i < cells.length; i++) {
      var p = cells[i]; dead[p.c][p.r] = true; sx += cellCX(p.c); sy += cellCY(p.r);
      popFx(cellCX(p.c), cellCY(p.r), k);
    }
    fx.texts.push({ text: '+' + pts, x: sx / cells.length, y: sy / cells.length, t: 0, big: pts >= 21 });
    fx.shake = Math.min(1, 0.15 + cells.length * 0.05);
    audio.pop(cells.length, wasLoop);
    // gravity: survivors fall, new pearls come in from above. After a loop the
    // refill avoids the colour just cleared.
    for (c = 0; c < N; c++) {
      var keep = [];
      for (r = N - 1; r >= 0; r--) if (!dead[c][r]) keep.push({ old: r, p: board[c][r] });
      var col = new Array(N), nr = N - 1;
      for (i = 0; i < keep.length; i++, nr--) {
        var q = keep[i].p; q.dy += (keep[i].old - nr) * CELL; col[nr] = q;
      }
      var fresh = nr + 1;
      for (; nr >= 0; nr--) col[nr] = { k: pick(wasLoop ? k : -1), dy: -fresh * CELL - 20, v: 0 };
      board[c] = col;
    }
    if (!hasMove()) shuffle();
  }

  // ── input ─────────────────────────────────────────────────────────────────
  function toDesign(e) {
    var rc = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rc.left) - ox) / sc, y: ((e.clientY - rc.top) - oy) / sc };
  }
  var activeId = null;
  canvas.addEventListener('pointerdown', function (e) {
    audio.unlock();
    if (state !== 'play' || activeId !== null) return;
    activeId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_e) {}
    var d = toDesign(e); begin(at(d.x, d.y));
  });
  canvas.addEventListener('pointermove', function (e) {
    if (e.pointerId !== activeId || !dragging) return;
    var list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (!list.length) list = [e];
    for (var i = 0; i < list.length; i++) { var d = toDesign(list[i]); extend(at(d.x, d.y)); }
  });
  function up(e) {
    if (e.pointerId !== activeId) return;
    activeId = null; release();
  }
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  ['touchstart', 'touchmove'].forEach(function (n) { canvas.addEventListener(n, function (e) { e.preventDefault(); }, { passive: false }); });

  // ── screens ───────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  function show(id, on) { $(id).classList[on ? 'remove' : 'add']('is-hidden'); }
  function start() {
    show('menu', false); show('how', false); show('over', false);
    rand = rng((Math.random() * 4294967296) >>> 0);
    newBoard();
    state = 'play'; step = 0; score = 0; shown = 0; moves = 0; chain = []; loop = false; dragging = false;
    fx.parts = []; fx.texts = []; fx.rings = []; fx.banner = null; lastSec = -1;
    audio.start();
  }
  function end() {
    state = 'over'; dragging = false; chain = []; loop = false; activeId = null;
    audio.end();
    if (score > best) { best = score; try { localStorage.setItem('motiJorBest', String(best)); } catch (_e) {} }
    setTimeout(function () {
      $('overScore').textContent = score;
      $('overBest').textContent = 'BEST ' + best;
      show('over', true);
    }, 900);
  }
  $('playBtn').onclick = function () { audio.unlock(); start(); };
  $('howBtn').onclick = function () { audio.unlock(); show('menu', false); show('how', true); };
  $('howPlayBtn').onclick = function () { audio.unlock(); start(); };
  $('againBtn').onclick = function () { audio.unlock(); start(); };
  $('homeBtn').onclick = function () { state = 'menu'; show('over', false); show('menu', true); };

  // ── audio: Web Audio only ─────────────────────────────────────────────────
  var audio = (function () {
    var AC = null, out = null;
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      var comp = AC.createDynamicsCompressor(); out = AC.createGain(); out.gain.value = 0.8;
      out.connect(comp); comp.connect(AC.destination);
    } catch (_e) { AC = null; }
    function ok() { return !!AC && AC.state === 'running'; }
    function unlock() { if (AC && AC.state !== 'running') { try { AC.resume(); } catch (_e) {} } }
    var PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36];
    var BASE = [523.25, 587.33, 659.25, 698.46, 783.99];
    function tone(f, t, dur, peak, type) {
      var o = AC.createOscillator(), g = AC.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
    }
    return {
      unlock: unlock,
      note: function (i, k, back) {
        if (!ok()) return;
        var f = BASE[k < 0 ? 0 : k] / 2 * Math.pow(2, PENTA[Math.min(i, PENTA.length - 1)] / 12), t = AC.currentTime;
        tone(f, t, back ? 0.12 : 0.25, back ? 0.08 : 0.18, 'triangle');
        tone(f * 2, t, 0.12, 0.05, 'sine');
      },
      loop: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        [0, 4, 7, 12].forEach(function (s, i) { tone(392 * Math.pow(2, s / 12), t + i * 0.04, 0.5, 0.12, 'triangle'); });
      },
      pop: function (n, wasLoop) {
        if (!ok()) return;
        var t = AC.currentTime, m = Math.min(n, 8);
        for (var i = 0; i < m; i++) tone(900 + i * 120 + Math.random() * 60, t + i * 0.025, 0.08, 0.1, 'sine');
        if (wasLoop) tone(196, t, 0.6, 0.2, 'sine');
      },
      tick: function () { if (ok()) tone(1400, AC.currentTime, 0.05, 0.08, 'square'); },
      start: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        tone(523, t, 0.15, 0.1, 'triangle'); tone(784, t + 0.08, 0.25, 0.1, 'triangle');
      },
      end: function () {
        if (!ok()) return;
        var t = AC.currentTime;
        tone(659, t, 0.2, 0.12, 'triangle'); tone(523, t + 0.15, 0.2, 0.12, 'triangle'); tone(392, t + 0.3, 0.5, 0.14, 'triangle');
      },
    };
  })();

  // ── effects ───────────────────────────────────────────────────────────────
  function popFx(x, y, k) {
    for (var i = 0; i < 7; i++) {
      var a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 160;
      fx.parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, r: 2 + Math.random() * 3, col: COLS[k], t: 0, dur: 0.5 + Math.random() * 0.3 });
    }
    fx.rings.push({ x: x, y: y, col: COLS[k], t: 0 });
  }
  var lastSec = -1;
  function animate(dts) {
    var i, c, r;
    for (c = 0; c < board.length; c++) for (r = 0; r < N; r++) {
      var p = board[c][r];
      if (p.dy < 0) { p.v += 3200 * dts; p.dy = Math.min(0, p.dy + p.v * dts); if (p.dy === 0) p.v = 0; }
    }
    for (i = fx.parts.length - 1; i >= 0; i--) {
      var q = fx.parts[i]; q.t += dts; q.x += q.vx * dts; q.y += q.vy * dts; q.vy += 500 * dts;
      if (q.t > q.dur) fx.parts.splice(i, 1);
    }
    for (i = fx.rings.length - 1; i >= 0; i--) { fx.rings[i].t += dts; if (fx.rings[i].t > 0.35) fx.rings.splice(i, 1); }
    for (i = fx.texts.length - 1; i >= 0; i--) { fx.texts[i].t += dts; if (fx.texts[i].t > 0.9) fx.texts.splice(i, 1); }
    if (fx.banner) { fx.banner.t += dts; if (fx.banner.t > 1.2) fx.banner = null; }
    fx.shake = Math.max(0, fx.shake - dts * 3);
    fx.flash = Math.max(0, fx.flash - dts * 1.5);
    shown += (score - shown) * Math.min(1, dts * 12);
    if (Math.abs(score - shown) < 0.5) shown = score;
  }

  // ── draw ──────────────────────────────────────────────────────────────────
  function text(t, x, y, size, col, alpha) {
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.font = '900 ' + size + 'px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = col; ctx.fillText(t, x, y);
    ctx.globalAlpha = 1;
  }
  function render(clock) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
    if (fx.shake > 0) ctx.translate((Math.random() - 0.5) * fx.shake * 6, (Math.random() - 0.5) * fx.shake * 6);
    var i, c, r, k = chainKind();

    // HUD: score and the clock bar
    var left = Math.max(0, RUN_STEPS - step), warn = state === 'play' && left <= WARN_STEPS;
    text(String(Math.round(shown)), W / 2, 96, 64, '#fff3d6');
    var bw = N * CELL, bx = GX, by = 150;
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; rrect(ctx, bx, by, bw, 10, 5); ctx.fill();
    ctx.fillStyle = warn ? '#ff4d6d' : '#ffc23d';
    if (left > 0) { rrect(ctx, bx, by, Math.max(10, bw * left / RUN_STEPS), 10, 5); ctx.fill(); }
    text(String(Math.ceil(left / 60)), W / 2, 180, 18, warn ? '#ff8aa0' : 'rgba(255,255,255,0.6)');

    // loop glow: the tray tints in the loop colour
    if (loop && k >= 0) {
      ctx.globalAlpha = 0.16 + 0.06 * Math.sin(clock * 10);
      ctx.fillStyle = COLS[k]; rrect(ctx, GX - 10, GY - 10, N * CELL + 20, N * CELL + 20, 22); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // the chain line, under the pearls
    if (chain.length && k >= 0) {
      ctx.strokeStyle = COLS[k]; ctx.lineWidth = 10; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(cellCX(chain[0].c), cellCY(chain[0].r));
      for (i = 1; i < chain.length; i++) ctx.lineTo(cellCX(chain[i].c), cellCY(chain[i].r));
      if (dragging && !loop && pointerD) ctx.lineTo(pointerD.x, pointerD.y);
      ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1;
    }

    // pearls
    ctx.save();
    ctx.beginPath(); ctx.rect(GX - 12, GY - 12, N * CELL + 24, N * CELL + 24); ctx.clip();
    var sw = sprites.length ? sprites[0].width / (sc * dpr) : 0;
    for (c = 0; c < board.length; c++) for (r = 0; r < N; r++) {
      var p = board[c][r], x = cellCX(c), y = cellCY(r) + p.dy, s = 1;
      var sel = inChain({ c: c, r: r }) || (loop && p.k === k);
      if (sel) s = 1.12 + (loop ? 0.04 * Math.sin(clock * 12 + c + r) : 0);
      if (sel) {
        ctx.globalAlpha = 0.35; ctx.fillStyle = COLS[p.k];
        ctx.beginPath(); ctx.arc(x, y, PR * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.drawImage(sprites[p.k], x - sw * s / 2, y - sw * s / 2, sw * s, sw * s);
    }
    ctx.restore();

    // effects
    for (i = 0; i < fx.rings.length; i++) {
      var g = fx.rings[i], gk = g.t / 0.35;
      ctx.globalAlpha = 1 - gk; ctx.strokeStyle = g.col; ctx.lineWidth = 4 * (1 - gk) + 1;
      ctx.beginPath(); ctx.arc(g.x, g.y, PR + gk * 22, 0, Math.PI * 2); ctx.stroke();
    }
    for (i = 0; i < fx.parts.length; i++) {
      var q = fx.parts[i];
      ctx.globalAlpha = Math.max(0, 1 - q.t / q.dur); ctx.fillStyle = q.col;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (i = 0; i < fx.texts.length; i++) {
      var tx = fx.texts[i], tp = tx.t / 0.9;
      text(tx.text, tx.x, tx.y - tp * 46, tx.big ? 40 : 28, '#ffffff', Math.min(1, (1 - tp) * 2));
    }
    if (fx.banner) text(fx.banner.text, W / 2, GY + N * CELL + 50, 24, '#ffc23d', Math.min(1, (1.2 - fx.banner.t) * 3));
    else if (chain.length >= 2 && state === 'play') {
      var n = loop ? countKind(k) : chain.length;
      text((loop ? 'LOOP  ' : '') + '+' + chainPoints(n) * (loop ? 2 : 1), W / 2, GY + N * CELL + 50, 24, COLS[k]);
    }
    if (fx.flash > 0) { ctx.globalAlpha = fx.flash; ctx.fillStyle = '#fff'; ctx.fillRect(-W, -H, W * 3, H * 3); ctx.globalAlpha = 1; }
  }
  function countKind(k) { var n = 0; for (var c = 0; c < N; c++) for (var r = 0; r < N; r++) if (board[c][r].k === k) n++; return n; }

  // the line follows the finger between pearls (drawing only)
  var pointerD = null;
  canvas.addEventListener('pointermove', function (e) { if (e.pointerId === activeId) pointerD = toDesign(e); });
  canvas.addEventListener('pointerdown', function (e) { pointerD = toDesign(e); });

  // ── loop: fixed 1/60 s steps for the clock, real time for effects ─────────
  var STEP_MS = 1000 / 60, acc = 0, lastT = null, clock = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (lastT === null) lastT = t;
    var dt = Math.max(0, Math.min(100, t - lastT)); lastT = t;
    var dts = dt / 1000; clock += dts;
    if (state === 'play') {
      acc += dt;
      var n = 0;
      while (acc >= STEP_MS && n < 3) { step++; acc -= STEP_MS; n++; }
      if (n >= 3 && acc > STEP_MS) acc = 0;
      var left = RUN_STEPS - step;
      if (left <= WARN_STEPS) { var sec = Math.ceil(left / 60); if (sec !== lastSec) { lastSec = sec; if (sec > 0) audio.tick(); } }
      if (step >= RUN_STEPS) end();
    }
    if (state === 'menu' && !board.length) newBoard();
    animate(Math.min(0.05, dts));
    render(clock);
  }
  requestAnimationFrame(frame);

  // standalone QA only: ?debug=1 lets a test read the board
  if (/[?&]debug=1(&|$)/.test(location.search)) window.__mj = { get board() { return board; }, get score() { return score; }, get state() { return state; } };
})();
