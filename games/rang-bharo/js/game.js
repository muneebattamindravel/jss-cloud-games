/* Rang Bharo: swipe the ball, paint the maze. */
(function () {
  'use strict';
  // ==== RANG BHARO RULES BEGIN ====
  // Everything that decides the score lives in this block. Integer only, fixed
  // 1/60 s steps, mazes are a pure function of (seed, n). No engine trig.
  const RULES_VERSION = 1;
  const STEP_HZ = 60;
  const TIME_STEPS = 10800;          // 3 minutes
  const STEPS_PER_TILE = 4;          // the ball crosses one tile in 4 steps
  const CLEAR_PAUSE = 54;            // steps between a clear and the next maze
  const MAZE_BASE = 10;              // a clear pays MAZE_BASE x its number
  const PERFECT_BASE = 25;           // PERFECT pays PERFECT_BASE + PERFECT_PER x n
  const PERFECT_PER = 5;
  const MAX_W = 11;
  const MAX_H = 13;
  const GEN_ATTEMPTS = 60;
  const SOLVE_CAP = 60000;           // BFS state cap; past it par is the designed length
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];

  function seedToInt(seed) {
    if (typeof seed === 'number') return seed | 0;
    const s = String(seed);
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); }
    return h | 0;
  }

  function hash3(a, b, c) {
    let h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x7F4A7C15, 0x85EBCA77) ^ Math.imul((c | 0) + 0x1B873593, 0xC2B2AE3D)) | 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D);
    h ^= h >>> 12; h = Math.imul(h, 0x297A2D39);
    h ^= h >>> 15;
    return h >>> 0;
  }

  function mazeDims(n) {
    return { w: Math.min(MAX_W, 6 + ((n - 1) >> 1)), h: Math.min(MAX_H, 6 + (n >> 1)) };
  }

  // Floors wanted, in percent of the grid, and how hard the slides bend.
  function floorPercent(n) { return Math.min(60, 44 + n * 2); }
  function moveBudget(n) { return Math.min(22, 6 + n + (n >> 1)); }
  function greed(n) { return n < 4 ? 2 : 1; }
  function minPar(n) { return Math.min(10, 4 + (n >> 1)); }

  // The slide the ball makes from cell c in direction d: the cell it stops on.
  function slideEnd(cells, w, h, c, d) {
    let x = c % w, y = (c / w) | 0;
    for (;;) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || cells[ny * w + nx] === 0) break;
      x = nx; y = ny;
    }
    return y * w + x;
  }

  // Shortest solution by BFS over (cell, painted set). Returns the move count,
  // or -1 if the state cap is hit first.
  function solvePar(cells, w, h, start, floors) {
    const N = w * h, W = (N + 31) >> 5;
    const dest = new Int32Array(N * 4);
    for (let c = 0; c < N; c++) {
      for (let d = 0; d < 4; d++) dest[c * 4 + d] = cells[c] ? slideEnd(cells, w, h, c, d) : c;
    }
    const sMask = new Int32Array(W);
    sMask[start >> 5] |= 1 << (start & 31);
    const seen = new Set();
    let frontier = [{ c: start, m: sMask }];
    seen.add(start + ':' + sMask.join(','));
    let depth = 0, states = 1;
    while (frontier.length) {
      depth++;
      const next = [];
      for (let i = 0; i < frontier.length; i++) {
        const st = frontier[i];
        for (let d = 0; d < 4; d++) {
          const e = dest[st.c * 4 + d];
          if (e === st.c) continue;
          const m = st.m.slice();
          let cc = st.c, cnt = 0;
          while (cc !== e) {
            cc += DX[d] + DY[d] * w;
            m[cc >> 5] |= 1 << (cc & 31);
          }
          for (let k = 0; k < W; k++) { let v = m[k] >>> 0; while (v) { v &= v - 1; cnt++; } }
          if (cnt === floors) return depth;
          const key = e + ':' + m.join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          if (++states > SOLVE_CAP) return -1;
          next.push({ c: e, m });
        }
      }
      frontier = next;
    }
    return -1;
  }

  // Maze n of a seed, grown by simulating the sliding ball itself, so every
  // maze is solvable by construction: carve the corridors the ball travels and
  // pin the wall that stops each slide so later carving cannot open it.
  const MAZE_MEMO = new Map();
  function genMaze(seed, n) {
    const sd = seedToInt(seed);
    const mk = sd + ':' + n;
    if (MAZE_MEMO.has(mk)) return MAZE_MEMO.get(mk);
    const made = genMazeRaw(sd, n);
    if (MAZE_MEMO.size > 64) MAZE_MEMO.clear();
    MAZE_MEMO.set(mk, made);
    return made;
  }

  function genMazeRaw(sd, n) {
    const dm = mazeDims(n), w = dm.w, h = dm.h, N = w * h;
    const want = Math.floor(N * floorPercent(n) / 100);
    const greedy = greed(n), budget = moveBudget(n);
    let best = null;
    for (let attempt = 0; attempt < GEN_ATTEMPTS; attempt++) {
      let rs = hash3(sd, n, attempt) | 0;
      const rnd = function (k) {
        rs = (rs + 0x6D2B79F5) | 0;
        let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) % k;
      };
      const cells = new Uint8Array(N), pin = new Uint8Array(N);
      const start = rnd(N);
      cells[start] = 1;
      let pos = start, count = 1, moves = 0, stuck = 0;
      const path = [];
      while (count < want && moves < budget && stuck < 14) {
        const cands = [];
        const x = pos % w, y = (pos / w) | 0;
        const d0 = rnd(4);
        for (let q = 0; q < 4; q++) {
          const d = (d0 + q) & 3;
          let cx = x, cy = y;
          for (let L = 1; ; L++) {
            cx += DX[d]; cy += DY[d];
            if (cx < 0 || cy < 0 || cx >= w || cy >= h || pin[cy * w + cx]) break;
            const bx = cx + DX[d], by = cy + DY[d];
            const open = bx >= 0 && by >= 0 && bx < w && by < h && cells[by * w + bx] === 1;
            if (open) continue;
            let fresh = 0;
            for (let k = 1; k <= L; k++) { if (cells[(y + DY[d] * k) * w + x + DX[d] * k] === 0) fresh++; }
            cands.push({ d, L, fresh });
          }
        }
        let pool = [];
        for (let i = 0; i < cands.length; i++) if (cands[i].fresh > 0) pool.push(cands[i]);
        if (!pool.length) { pool = cands; stuck++; }
        if (!pool.length) break;
        let idx = rnd(pool.length);
        for (let b = 0; b < greedy; b++) { const j = rnd(pool.length); if (pool[j].fresh > pool[idx].fresh) idx = j; }
        const mv = pool[idx];
        let cx = x, cy = y;
        for (let k = 1; k <= mv.L; k++) {
          cx += DX[mv.d]; cy += DY[mv.d];
          if (cells[cy * w + cx] === 0) { cells[cy * w + cx] = 1; count++; }
        }
        const bx = cx + DX[mv.d], by = cy + DY[mv.d];
        if (bx >= 0 && by >= 0 && bx < w && by < h) pin[by * w + bx] = 1;
        pos = cy * w + cx;
        path.push(mv.d);
        moves++;
        if (mv.fresh > 0) stuck = 0;
      }
      if (count * 100 < N * 38) continue;
      const par = solvePar(cells, w, h, start, count);
      const maze = { w, h, cells, start, floors: count, designed: moves, par: par < 0 ? moves : par, exact: par >= 0, path };
      if (maze.par >= minPar(n)) return maze;
      if (!best || maze.par > best.par) best = maze;
    }
    return best;
  }

  function newSim(seed) {
    const s = {
      seed: seedToInt(seed), step: 0, over: false,
      score: 0, n: 0, moves: 0, mazes: 0, perfects: 0, tiles: 0, totalMoves: 0,
      maze: null, painted: null, left: 0,
      bx: 0, by: 0, dir: -1, sub: 0, queued: -1, pause: 0, lastInput: -1,
      ev: [],
    };
    loadMaze(s, 1);
    return s;
  }

  function loadMaze(s, n) {
    const m = genMaze(s.seed, n);
    s.n = n; s.maze = m;
    s.painted = new Uint8Array(m.w * m.h);
    s.painted[m.start] = 1;
    s.left = m.floors - 1;
    s.bx = m.start % m.w; s.by = (m.start / m.w) | 0;
    s.dir = -1; s.sub = 0; s.moves = 0; s.pause = 0;
    s.ev = s.ev.concat([{ k: 'maze', n }]);
  }

  function blockedAt(s, x, y, d) {
    const m = s.maze, nx = x + DX[d], ny = y + DY[d];
    return nx < 0 || ny < 0 || nx >= m.w || ny >= m.h || m.cells[ny * m.w + nx] === 0;
  }

  // One swipe or key. At most one input is taken per step; later ones that
  // step change nothing. A swipe mid-slide replaces the buffered one.
  function inputDir(s, d) {
    if (s.over || d < 0 || d > 3 || (d | 0) !== d) return false;
    if (s.lastInput === s.step) return false;
    s.lastInput = s.step;
    if (s.dir >= 0 || s.pause > 0) { s.queued = d; return true; }
    tryStart(s, d);
    return true;
  }

  function tryStart(s, d) {
    if (blockedAt(s, s.bx, s.by, d)) { s.ev = s.ev.concat([{ k: 'bump', d }]); return false; }
    s.dir = d; s.sub = 0; s.moves++; s.totalMoves++;
    s.ev = s.ev.concat([{ k: 'go', d }]);
    return true;
  }

  function stepSim(s) {
    if (s.over) return;
    s.ev = [];
    if (s.step >= TIME_STEPS) { s.over = true; s.ev = [{ k: 'end' }]; return; }
    s.step++;
    if (s.pause > 0) {
      s.pause--;
      if (s.pause === 0) {
        loadMaze(s, s.n + 1);
        if (s.queued >= 0) { const q = s.queued; s.queued = -1; tryStart(s, q); }
      }
      return;
    }
    if (s.dir < 0) {
      if (s.queued >= 0) { const q = s.queued; s.queued = -1; tryStart(s, q); }
      if (s.dir < 0) return;
    }
    s.sub++;
    if (s.sub < STEPS_PER_TILE) return;
    s.sub = 0;
    const m = s.maze;
    s.bx += DX[s.dir]; s.by += DY[s.dir];
    const c = s.by * m.w + s.bx;
    if (s.painted[c] === 0) {
      s.painted[c] = 1; s.left--; s.score++; s.tiles++;
      s.ev = s.ev.concat([{ k: 'paint', c }]);
    }
    if (s.left === 0) {
      const perfect = s.moves <= m.par;
      const bonus = MAZE_BASE * s.n + (perfect ? PERFECT_BASE + PERFECT_PER * s.n : 0);
      s.score += bonus; s.mazes++;
      if (perfect) s.perfects++;
      s.dir = -1; s.pause = CLEAR_PAUSE;
      s.ev = s.ev.concat([{ k: 'clear', bonus, perfect, moves: s.moves, par: m.par }]);
      return;
    }
    if (blockedAt(s, s.bx, s.by, s.dir)) {
      const d = s.dir;
      s.dir = -1;
      s.ev = s.ev.concat([{ k: 'hit', d }]);
      if (s.queued >= 0) { const q = s.queued; s.queued = -1; tryStart(s, q); }
    }
  }
  // ==== RANG BHARO RULES END ====

  // ======================================================================
  // Effects: drawing, audio, input and screens. They READ the sim and never
  // write it. Math.random is allowed here, and only here.
  // ======================================================================
  const DW = 414, DH = 736;
  const STEP_MS = 1000 / STEP_HZ;
  const qs = location.search;
  const harness = window.__rbHarness || null;

  const canvas = document.getElementById('scene');
  const g = canvas.getContext('2d');
  let dpr = 1, cw = 1, ch = 1, k = 1, ox = 0, oy = 0, px = 1;

  const PALS = [
    { a: '#ffd23f', b: '#ff7a00', c: '#fff1b8', glow: '255,186,64', bg: '#2a1408' },
    { a: '#45f0d6', b: '#0a96b4', c: '#d9fff8', glow: '64,236,214', bg: '#062328' },
    { a: '#ff6cc9', b: '#cf1380', c: '#ffe0f3', glow: '255,96,196', bg: '#2a0820' },
    { a: '#cdfb4a', b: '#55b814', c: '#f3ffd2', glow: '190,250,80', bg: '#132408' },
    { a: '#7da9ff', b: '#2c47e3', c: '#e2ebff', glow: '120,156,255', bg: '#0b1236' },
  ];
  const palOf = (n) => PALS[(n - 1) % PALS.length];
  const FONT = '"Titan One", system-ui, sans-serif';

  // ---------- sprites, cached at screen scale ----------
  function mk(wd, ht) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(wd)); c.height = Math.max(1, Math.ceil(ht));
    return c;
  }
  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }

  const spr = {};   // per maze: board, paint, white, ball, glow
  let glowCache = {};
  function glowSprite(rgb) {
    if (glowCache[rgb]) return glowCache[rgb];
    const c = mk(64, 64), x = c.getContext('2d');
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(' + rgb + ',1)'); gr.addColorStop(0.35, 'rgba(' + rgb + ',.45)'); gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    return (glowCache[rgb] = c);
  }

  function geomFor(m) {
    const T = Math.min(58, Math.floor(372 / m.w), Math.floor(536 / m.h));
    const F = Math.round(T * 0.38) + 7;
    const bw = m.w * T, bh = m.h * T;
    return { T, F, bw, bh, x: Math.round((DW - bw) / 2), y: Math.round(138 + (540 - bh) / 2) };
  }

  function buildBoard(m, n) {
    const G = geomFor(m), P = palOf(n), T = G.T, F = G.F;
    const S = px;
    const c = mk((G.bw + F * 2 + 24) * S, (G.bh + F * 2 + 30) * S), x = c.getContext('2d');
    x.scale(S, S); x.translate(12, 10);
    const W2 = G.bw + F * 2, H2 = G.bh + F * 2;
    // drop shadow and plateau
    x.save(); x.shadowColor = 'rgba(0,0,0,.55)'; x.shadowBlur = 22; x.shadowOffsetY = 10;
    rr(x, 0, 0, W2, H2, F * 0.9); x.fillStyle = '#1c1636'; x.fill(); x.restore();
    const pg = x.createLinearGradient(0, 0, 0, H2);
    pg.addColorStop(0, '#352b5e'); pg.addColorStop(1, '#1d1739');
    rr(x, 0, 0, W2, H2, F * 0.9); x.fillStyle = pg; x.fill();
    // bevel: light top lip, dark bottom lip
    x.save(); rr(x, 0, 0, W2, H2, F * 0.9); x.clip();
    x.strokeStyle = 'rgba(255,255,255,.16)'; x.lineWidth = 3; rr(x, 1.5, 1.5, W2 - 3, H2 - 3, F * 0.85); x.stroke();
    x.fillStyle = 'rgba(0,0,0,.28)'; x.fillRect(0, H2 - 5, W2, 5);
    x.restore();
    // truck-art lights along the frame
    const per = 2 * (W2 + H2 - 2 * F), sp = Math.max(14, T * 0.5), cnt = Math.round(per / sp);
    const inset = F * 0.5;
    for (let i = 0; i < cnt; i++) {
      let d = (i / cnt) * (2 * (W2 - 2 * inset) + 2 * (H2 - 2 * inset)), lx, ly;
      const aw = W2 - 2 * inset, ah = H2 - 2 * inset;
      if (d < aw) { lx = inset + d; ly = inset; } else if ((d -= aw) < ah) { lx = W2 - inset; ly = inset + d; }
      else if ((d -= ah) < aw) { lx = W2 - inset - d; ly = H2 - inset; } else { d -= aw; lx = inset; ly = H2 - inset - d; }
      const col = i % 2 ? P.a : P.b, r = Math.max(2, F * 0.13);
      x.fillStyle = 'rgba(0,0,0,.35)'; x.beginPath(); x.arc(lx, ly + 1, r + 1, 0, 6.283); x.fill();
      x.fillStyle = col; x.beginPath(); x.arc(lx, ly, r, 0, 6.283); x.fill();
      x.fillStyle = 'rgba(255,255,255,.6)'; x.beginPath(); x.arc(lx - r * 0.3, ly - r * 0.35, r * 0.35, 0, 6.283); x.fill();
    }
    // the grid: walls are the raised plateau, floors are carved corridors
    x.translate(F, F);
    const isF = (cx, cy) => cx >= 0 && cy >= 0 && cx < m.w && cy < m.h && m.cells[cy * m.w + cx] === 1;
    const I = Math.max(2, Math.round(T * 0.06)), R = T * 0.22;
    for (let cy = 0; cy < m.h; cy++) for (let cx = 0; cx < m.w; cx++) {
      const X = cx * T, Y = cy * T;
      if (!isF(cx, cy)) {
        const r = T * 0.1, mx = X + T / 2, my = Y + T / 2;
        x.fillStyle = (cx + cy) % 2 ? P.a : P.b; x.globalAlpha = 0.22;
        x.beginPath(); x.moveTo(mx, my - r); x.lineTo(mx + r, my); x.lineTo(mx, my + r); x.lineTo(mx - r, my); x.closePath(); x.fill();
        x.globalAlpha = 1;
      }
    }
    x.fillStyle = '#0b0818';
    for (let cy = 0; cy < m.h; cy++) for (let cx = 0; cx < m.w; cx++) {
      if (!isF(cx, cy)) continue;
      const X = cx * T, Y = cy * T;
      rr(x, X + I, Y + I, T - 2 * I, T - 2 * I, R); x.fill();
      if (isF(cx + 1, cy)) x.fillRect(X + T / 2, Y + I, T, T - 2 * I);
      if (isF(cx, cy + 1)) x.fillRect(X + I, Y + T / 2, T - 2 * I, T);
      if (isF(cx + 1, cy) && isF(cx, cy + 1) && isF(cx + 1, cy + 1)) x.fillRect(X + T / 2, Y + T / 2, T, T);
    }
    // the wall face: a shadow under every wall edge, a soft lit lip above every floor edge
    for (let cy = 0; cy < m.h; cy++) for (let cx = 0; cx < m.w; cx++) {
      if (!isF(cx, cy)) continue;
      const X = cx * T, Y = cy * T;
      if (!isF(cx, cy - 1)) {
        const sg = x.createLinearGradient(0, Y + I, 0, Y + I + T * 0.3);
        sg.addColorStop(0, 'rgba(0,0,0,.75)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = sg; x.fillRect(X + (isF(cx - 1, cy) ? 0 : I), Y + I, T - (isF(cx - 1, cy) ? 0 : I) - (isF(cx + 1, cy) ? 0 : I), T * 0.3);
        x.fillStyle = 'rgba(255,255,255,.14)'; x.fillRect(X + I + 2, Y + I - 2, T - 2 * I - 4, 1.5);
      }
      if (!isF(cx - 1, cy)) {
        const sg = x.createLinearGradient(X + I, 0, X + I + T * 0.14, 0);
        sg.addColorStop(0, 'rgba(0,0,0,.45)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = sg; x.fillRect(X + I, Y + I, T * 0.14, T - 2 * I);
      }
      if (!isF(cx, cy + 1)) { x.fillStyle = 'rgba(255,255,255,.06)'; x.fillRect(X + I + R * 0.5, Y + T - I - 1.5, T - 2 * I - R, 1.5); }
      x.fillStyle = 'rgba(255,255,255,.08)'; x.beginPath(); x.arc(X + T / 2, Y + T / 2, Math.max(1.5, T * 0.06), 0, 6.283); x.fill();
    }
    return { c, G, ox: 12 + 0, oy: 10 };
  }

  function buildTile(T, P, white) {
    const S = px, c = mk(T * S, T * S), x = c.getContext('2d');
    x.scale(S, S);
    const i = 2.5, r = T * 0.2;
    if (white) { rr(x, i, i, T - 2 * i, T - 2 * i, r); x.fillStyle = '#fff'; x.fill(); return c; }
    const gr = x.createLinearGradient(0, i, 0, T - i);
    gr.addColorStop(0, P.a); gr.addColorStop(1, P.b);
    rr(x, i, i, T - 2 * i, T - 2 * i, r); x.fillStyle = gr; x.fill();
    x.save(); rr(x, i, i, T - 2 * i, T - 2 * i, r); x.clip();
    x.fillStyle = 'rgba(255,255,255,.32)';
    x.beginPath(); x.ellipse(T * 0.5, T * 0.18, T * 0.46, T * 0.24, 0, 0, 6.283); x.fill();
    x.fillStyle = 'rgba(0,0,0,.16)'; x.fillRect(0, T - i - T * 0.12, T, T * 0.12);
    x.restore();
    x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1; rr(x, i + 0.5, i + 0.5, T - 2 * i - 1, T - 2 * i - 1, r); x.stroke();
    return c;
  }

  function buildBall(D, P) {
    const S = px, pad = 2, c = mk((D + pad * 2) * S, (D + pad * 2) * S), x = c.getContext('2d');
    x.scale(S, S); x.translate(pad + D / 2, pad + D / 2);
    const r = D / 2;
    const gr = x.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.05, 0, 0, r);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.35, P.c); gr.addColorStop(0.8, P.a); gr.addColorStop(1, P.b);
    x.fillStyle = gr; x.beginPath(); x.arc(0, 0, r, 0, 6.283); x.fill();
    x.strokeStyle = 'rgba(0,0,0,.25)'; x.lineWidth = 1.2; x.stroke();
    x.fillStyle = 'rgba(255,255,255,.9)'; x.beginPath(); x.ellipse(-r * 0.36, -r * 0.42, r * 0.26, r * 0.17, -0.6, 0, 6.283); x.fill();
    return { c, D, pad };
  }

  function sprites(n, m) {
    const key = n + ':' + px;
    if (spr.key === key) return spr;
    const P = palOf(n);
    spr.key = key; spr.n = n;
    spr.board = buildBoard(m, n);
    spr.G = spr.board.G;
    spr.paint = buildTile(spr.G.T, P, false);
    spr.white = buildTile(spr.G.T, P, true);
    spr.ball = buildBall(Math.round(spr.G.T * 0.7), P);
    spr.glow = glowSprite(P.glow);
    return spr;
  }

  // ---------- background ----------
  let bgCanvas = null;
  function buildBg() {
    bgCanvas = mk(canvas.width, canvas.height);
    const x = bgCanvas.getContext('2d');
    const gr = x.createLinearGradient(0, 0, 0, bgCanvas.height);
    gr.addColorStop(0, '#171032'); gr.addColorStop(1, '#07050f');
    x.fillStyle = gr; x.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
    // a faint lattice of diamonds, like a painted truck panel
    const s = 34 * k * dpr;
    x.fillStyle = 'rgba(255,255,255,.025)';
    for (let yy = 0, row = 0; yy < bgCanvas.height + s; yy += s * 0.5, row++) {
      for (let xx = (row % 2) * s * 0.5; xx < bgCanvas.width + s; xx += s) {
        x.beginPath(); x.moveTo(xx, yy - s * 0.16); x.lineTo(xx + s * 0.16, yy); x.lineTo(xx, yy + s * 0.16); x.lineTo(xx - s * 0.16, yy); x.closePath(); x.fill();
      }
    }
    const vg = x.createRadialGradient(bgCanvas.width / 2, bgCanvas.height * 0.45, 0, bgCanvas.width / 2, bgCanvas.height * 0.45, Math.max(bgCanvas.width, bgCanvas.height) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    x.fillStyle = vg; x.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  }

  function resize() {
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    cw = Math.max(1, window.innerWidth); ch = Math.max(1, window.innerHeight);
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    k = Math.min(cw / DW, ch / DH);
    ox = (cw - DW * k) / 2; oy = (ch - DH * k) / 2;
    px = k * dpr;
    spr.key = null; buildBg();
  }
  window.addEventListener('resize', resize);

  // ---------- audio: Web Audio only ----------
  const AC = window.AudioContext || window.webkitAudioContext;
  let actx = null, master = null, verb = null, rollV = null;
  let muted = false;
  try { muted = localStorage.getItem('kj_sfx_muted') === '1'; } catch (_e) {}
  function audio() {
    if (!AC) return null;
    if (!actx) {
      try { actx = new AC(); } catch (_e) { return null; }
      master = actx.createGain(); master.gain.value = muted ? 0 : 0.9;
      const comp = actx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      master.connect(comp); comp.connect(actx.destination);
      // a short generated room for the bells and chords
      const len = Math.floor(actx.sampleRate * 1.4), buf = actx.createBuffer(2, len, actx.sampleRate);
      for (let ch2 = 0; ch2 < 2; ch2++) { const d = buf.getChannelData(ch2); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
      const conv = actx.createConvolver(); conv.buffer = buf;
      verb = actx.createGain(); verb.gain.value = 0.28;
      verb.connect(conv); conv.connect(master);
    }
    if (actx.state === 'suspended') { try { actx.resume(); } catch (_e) {} }
    return actx;
  }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach((ev) => window.addEventListener(ev, () => audio(), { passive: true }));
  function setMuted(v) {
    muted = v;
    try { localStorage.setItem('kj_sfx_muted', v ? '1' : '0'); } catch (_e) {}
    if (master) master.gain.setTargetAtTime(v ? 0 : 0.9, actx.currentTime, 0.02);
    muteBtn.classList.toggle('off', v);
  }
  let noiseBuf = null;
  function noise() {
    if (noiseBuf) return noiseBuf;
    const len = actx.sampleRate; noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  function tone(f, dur, opt) {
    const c = audio(); if (!c || muted) return;
    opt = opt || {};
    const t = c.currentTime + (opt.at || 0);
    const o = c.createOscillator(), gg = c.createGain();
    o.type = opt.type || 'sine'; o.frequency.setValueAtTime(f, t);
    if (opt.to) o.frequency.exponentialRampToValueAtTime(opt.to, t + dur);
    if (opt.detune) o.detune.value = opt.detune;
    const v = opt.vol || 0.2;
    gg.gain.setValueAtTime(0.0001, t); gg.gain.exponentialRampToValueAtTime(v, t + (opt.atk || 0.005));
    gg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(gg); gg.connect(master); if (opt.wet) { const s2 = c.createGain(); s2.gain.value = opt.wet; gg.connect(s2); s2.connect(verb); }
    o.start(t); o.stop(t + dur + 0.05);
  }
  function burst(dur, opt) {
    const c = audio(); if (!c || muted) return;
    opt = opt || {};
    const t = c.currentTime + (opt.at || 0);
    const s = c.createBufferSource(); s.buffer = noise();
    const f = c.createBiquadFilter(); f.type = opt.ft || 'lowpass'; f.frequency.setValueAtTime(opt.f || 800, t);
    if (opt.fto) f.frequency.exponentialRampToValueAtTime(opt.fto, t + dur);
    f.Q.value = opt.q || 0.7;
    const gg = c.createGain(); gg.gain.setValueAtTime(opt.vol || 0.2, t); gg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(gg); gg.connect(master); if (opt.wet) { const s2 = c.createGain(); s2.gain.value = opt.wet; gg.connect(s2); s2.connect(verb); }
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }
  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];
  const SFX = {
    rollStart() {
      const c = audio(); if (!c || muted) return;
      SFX.rollStop(0.02);
      const t = c.currentTime;
      const o = c.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(92, t);
      const s = c.createBufferSource(); s.buffer = noise(); s.loop = true;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 340; f.Q.value = 1.4;
      const gg = c.createGain(); gg.gain.setValueAtTime(0.0001, t); gg.gain.exponentialRampToValueAtTime(0.11, t + 0.04);
      const ng = c.createGain(); ng.gain.value = 0.35;
      o.connect(gg); s.connect(f); f.connect(ng); ng.connect(gg); gg.connect(master);
      o.start(t); s.start(t, Math.random() * 0.5);
      rollV = { o, s, f, gg, tiles: 0 };
    },
    rollTile(i) {
      if (!rollV || !actx) return;
      const t = actx.currentTime;
      rollV.o.frequency.setTargetAtTime(92 * (1 + 0.075 * i), t, 0.03);
      rollV.f.frequency.setTargetAtTime(340 + 60 * i, t, 0.03);
    },
    rollStop(rel) {
      if (!rollV || !actx) return;
      const t = actx.currentTime, v = rollV; rollV = null;
      v.gg.gain.cancelScheduledValues(t); v.gg.gain.setTargetAtTime(0.0001, t, rel || 0.03);
      v.o.stop(t + 0.3); v.s.stop(t + 0.3);
    },
    paint(i) {
      const f = 523.25 * Math.pow(2, PENTA[Math.min(i, PENTA.length - 1)] / 12);
      tone(f, 0.16, { vol: 0.07, wet: 0.5 });
      tone(f * 2.01, 0.09, { vol: 0.025, type: 'triangle' });
    },
    thunk(len) {
      const v = Math.min(1, 0.45 + len * 0.08);
      tone(150, 0.16, { to: 52, vol: 0.42 * v, atk: 0.003 });
      burst(0.08, { f: 520, vol: 0.18 * v });
    },
    bump() { tone(120, 0.1, { to: 70, vol: 0.18 }); burst(0.05, { f: 400, vol: 0.08 }); },
    clear(n) {
      const root = 261.63 * Math.pow(2, ((n - 1) % 5) * 2 / 12);
      [0, 4, 7, 12, 16].forEach((st, i) => {
        const f = root * Math.pow(2, st / 12);
        tone(f, 0.9, { at: i * 0.065, vol: 0.12, type: 'triangle', wet: 0.6 });
        tone(f, 0.7, { at: i * 0.065, vol: 0.06, detune: 7, wet: 0.4 });
      });
      burst(0.6, { ft: 'highpass', f: 2500, fto: 9000, vol: 0.05, wet: 0.8 });
    },
    perfect() {
      [1567.98, 2093, 2637, 3136].forEach((f, i) => {
        tone(f, 1.4, { at: 0.32 + i * 0.09, vol: 0.06, wet: 1 });
        tone(f * 2.76, 0.5, { at: 0.32 + i * 0.09, vol: 0.015, wet: 1 });
      });
    },
    tick(hi) { tone(hi ? 1760 : 1320, 0.05, { vol: 0.09, type: 'square' }); },
    gong() {
      [98, 145, 196, 271, 382].forEach((f, i) => tone(f, 3.2 - i * 0.4, { vol: 0.22 / (i + 1), atk: 0.01, wet: 0.9 }));
      burst(0.4, { f: 900, fto: 200, vol: 0.18, wet: 0.6 });
    },
    ui() { tone(660, 0.08, { vol: 0.08 }); tone(990, 0.08, { at: 0.04, vol: 0.06 }); },
    ready() { tone(523.25, 0.18, { vol: 0.1, wet: 0.4 }); },
    go() { [523.25, 659.25, 783.99].forEach((f) => tone(f * 1.5, 0.4, { vol: 0.08, type: 'triangle', wet: 0.5 })); },
    count(i) { tone(880 + i * 6, 0.04, { vol: 0.03, type: 'triangle' }); },
    best() { [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, 0.6, { at: i * 0.08, vol: 0.08, type: 'triangle', wet: 0.7 })); },
  };

  // ---------- particles and floating text ----------
  let parts = [], texts = [], trail = [];
  function confetti(x, y, nAmt, P, spread) {
    const cols = [P.a, P.b, P.c, '#ffffff', PALS[(Math.random() * 5) | 0].a];
    for (let i = 0; i < nAmt; i++) {
      const a = Math.random() * 6.283, sp = (spread || 1) * (120 + Math.random() * 380);
      parts.push({ t: 'sq', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 220, g: 900, life: 0, max: 1.1 + Math.random() * 0.8,
        s: 4 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 18, col: cols[(Math.random() * cols.length) | 0] });
    }
  }
  function sparks(x, y, nAmt, rgb, dir) {
    for (let i = 0; i < nAmt; i++) {
      let a = Math.random() * 6.283;
      if (dir >= 0) a = Math.atan2(-DY[dir], -DX[dir]) + (Math.random() - 0.5) * 2.2;
      const sp = 60 + Math.random() * 200;
      parts.push({ t: 'gl', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0, life: 0, max: 0.25 + Math.random() * 0.3, s: 5 + Math.random() * 7, rgb });
    }
  }
  function floatText(str, x, y, size, col, dur, rise) {
    texts.push({ str, x, y, size, col, t: 0, dur: dur || 1.1, rise: rise == null ? 50 : rise });
  }
  function updParts(dt) {
    for (const p of parts) {
      p.life += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.t === 'sq') { p.vx *= 0.985; p.vy *= 0.985; p.rot += p.vr * dt; } else { p.vx *= 0.92; p.vy *= 0.92; }
    }
    parts = parts.filter((p) => p.life < p.max);
    for (const t of texts) t.t += dt;
    texts = texts.filter((t) => t.t < t.dur);
  }
  function drawParts() {
    for (const p of parts) {
      const q = p.life / p.max;
      if (p.t === 'sq') {
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.globalAlpha = Math.min(1, (1 - q) * 2);
        g.fillStyle = p.col; g.fillRect(-p.s / 2, -p.s * 0.3, p.s, p.s * 0.6); g.restore();
      } else {
        g.globalCompositeOperation = 'lighter'; g.globalAlpha = 1 - q;
        const s = p.s * (1 - q * 0.5);
        g.drawImage(glowSprite(p.rgb), p.x - s, p.y - s, s * 2, s * 2);
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      }
    }
    g.globalAlpha = 1;
  }
  function spring(t) { return 1 - Math.exp(-7 * t) * Math.cos(12 * t); }
  function drawTexts() {
    for (const t of texts) {
      const q = t.t / t.dur, sc = Math.max(0.01, spring(t.t * 1.6));
      const a = q < 0.7 ? 1 : 1 - (q - 0.7) / 0.3;
      g.save(); g.translate(t.x, t.y - t.rise * (1 - Math.pow(1 - q, 3))); g.scale(sc, sc); g.globalAlpha = a;
      g.font = t.size + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineJoin = 'round'; g.lineWidth = t.size * 0.18; g.strokeStyle = 'rgba(15,8,30,.85)'; g.strokeText(t.str, 0, 0);
      g.fillStyle = t.col; g.fillText(t.str, 0, 0);
      g.restore();
    }
  }

  // ---------- run state ----------
  let sim = null;
  let mode = 'menu';            // menu, howto, ready, play, end
  let acc = 0, lastT = null, nowMs = 0;
  let inbox = [];
  let prevB = { x: 0, y: 0 }, curB = { x: 0, y: 0 };
  let paintAt = null;           // per cell: ms painted (cosmetic)
  let ripple = null;            // { t0, cx, cy }
  let slideIn = null;           // board transition { t0, old }
  let shake = 0, flash = 0;
  let sq = 0, sqv = 0, sqDir = 0, slideTiles = 0;
  let shownScore = 0, scoreBump = 0, lastSecs = -1, secPulse = 0;
  let readyT0 = 0, endT0 = 0, endShown = false, firstMoveDone = false;
  let bestScore = 0;
  try { bestScore = +localStorage.getItem('rang-bharo.best') || 0; } catch (_e) {}

  function ballPosOf(s) {
    const f = s.dir >= 0 ? s.sub / STEPS_PER_TILE : 0;
    return { x: s.bx + (s.dir >= 0 ? DX[s.dir] * f : 0), y: s.by + (s.dir >= 0 ? DY[s.dir] * f : 0) };
  }

  function newRunSeed() {
    const m = /[?&]seed=([^&]+)/.exec(qs);
    if (window.__kjSeed != null) return window.__kjSeed;
    if (m) return decodeURIComponent(m[1]);
    return 'local-' + ((Math.random() * 1e9) | 0);
  }

  function startRun() {
    sim = newSim(newRunSeed());
    paintAt = new Float64Array(sim.maze.w * sim.maze.h);
    paintAt[sim.maze.start] = -1e9;
    prevB = ballPosOf(sim); curB = prevB;
    parts = []; texts = []; trail = []; inbox = [];
    ripple = null; shake = 0; flash = 0; sq = 0; sqv = 0;
    shownScore = 0; lastSecs = -1; endShown = false; firstMoveDone = false;
    slideIn = { t0: nowMs, old: null, dur: 520 };
    mode = 'ready'; readyT0 = nowMs; acc = 0;
    if (harness) harness.sim = sim;
  }

  // ---------- the fixed-step loop ----------
  function stepOnce() {
    prevB = curB;
    const wasMaze = sim.maze, wasPainted = sim.painted;
    sim.ev = [];
    if (inbox.length) { const d = inbox.shift(); inputDir(sim, d); }
    const fromInput = sim.ev;
    stepSim(sim);
    curB = ballPosOf(sim);
    for (const e of fromInput) onEvent(e, wasMaze, wasPainted);
    for (const e of sim.ev) onEvent(e, wasMaze, wasPainted);
  }

  function onEvent(e, oldMaze, oldPainted) {
    const S = sprites(sim.n, sim.maze), G = S.G, P = palOf(sim.n);
    const cxp = (c) => G.x + ((c % sim.maze.w) + 0.5) * G.T, cyp = (c) => G.y + (((c / sim.maze.w) | 0) + 0.5) * G.T;
    switch (e.k) {
      case 'go':
        firstMoveDone = true; slideTiles = 0; sqDir = e.d; SFX.rollStart();
        break;
      case 'bump':
        sqDir = e.d; sqv = 4; SFX.bump();
        break;
      case 'paint':
        slideTiles++;
        paintAt[e.c] = nowMs;
        SFX.paint(slideTiles - 1); SFX.rollTile(slideTiles);
        if (Math.random() < 0.6) sparks(cxp(e.c), cyp(e.c), 2, P.glow, -1);
        break;
      case 'hit': {
        SFX.rollStop(); SFX.thunk(slideTiles);
        sqDir = e.d; sqv = 6 + Math.min(8, slideTiles * 1.2);
        if (slideTiles >= 4) shake = Math.max(shake, 1.2 + slideTiles * 0.15);
        const bx = G.x + (sim.bx + 0.5 + DX[e.d] * 0.45) * G.T, by = G.y + (sim.by + 0.5 + DY[e.d] * 0.45) * G.T;
        sparks(bx, by, 4 + Math.min(6, slideTiles), P.glow, e.d);
        slideTiles = 0;
        break;
      }
      case 'clear': {
        SFX.rollStop(0.08); SFX.clear(sim.n);
        const cxw = G.x + G.bw / 2, cyw = G.y + G.bh / 2;
        ripple = { t0: nowMs, cx: sim.bx, cy: sim.by };
        shake = Math.max(shake, 4);
        confetti(cxw, cyw, 70, P, 1);
        floatText('+' + (e.bonus + 0), cxw, cyw, 64, P.a, 1.3, 70);
        if (e.perfect) {
          flash = 0.35; SFX.perfect();
          floatText('PERFECT!', cxw, cyw - 78, 46, '#fff6c8', 1.3, 30);
        } else {
          floatText(e.moves + ' MOVES, PAR ' + e.par, cxw, cyw - 70, 22, '#ffffff', 1.2, 20);
        }
        slideTiles = 0;
        // warm the next maze while the confetti flies
        setTimeout(() => { if (sim) genMaze(sim.seed, sim.n + 1); }, 30);
        break;
      }
      case 'maze':
        if (e.n > 1) {
          const G2 = geomFor(sim.maze);
          floatText('MAZE ' + e.n, DW / 2, G2.y - G2.F - 20, 22, palOf(e.n).a, 1.1, 8);
          const old = snapshotBoard(oldMaze, oldPainted, e.n - 1);
          paintAt = new Float64Array(sim.maze.w * sim.maze.h);
          paintAt[sim.maze.start] = nowMs;
          slideIn = { t0: nowMs, old, dur: 460 };
          ripple = null; trail = [];
          curB = ballPosOf(sim); prevB = curB;
        }
        break;
    }
  }

  function snapshotBoard(m, painted, n) {
    const S = sprites(n, m), G = S.G;
    const bw = G.bw + G.F * 2 + 24, bh = G.bh + G.F * 2 + 30;
    const c = mk(bw * px, bh * px), x = c.getContext('2d');
    x.drawImage(S.board.c, 0, 0);
    x.scale(px, px); x.translate(12 + G.F, 10 + G.F);
    for (let i = 0; i < m.w * m.h; i++) if (painted[i]) x.drawImage(S.paint, (i % m.w) * G.T, ((i / m.w) | 0) * G.T, G.T, G.T);
    return { c, G, w: bw, h: bh };
  }

  function frame(t) {
    requestAnimationFrame(frame);
    if (lastT === null) { lastT = t; }
    let dt = t - lastT; lastT = t;
    if (dt > 250) dt = 250;
    nowMs += dt;
    if (mode === 'ready') {
      const e = nowMs - readyT0;
      if (e > 380 && !readyPopped) { readyPopped = true; SFX.ready(); }
      if (e > 1150 && !goPopped) { goPopped = true; SFX.go(); }
      if (e > 1500) { mode = 'play'; acc = 0; readyPopped = goPopped = false; }
    }
    if (mode === 'play' && sim) {
      acc += dt;
      let n = 0;
      while (acc >= STEP_MS && n < 3) { acc -= STEP_MS; stepOnce(); n++; if (sim.over) break; }
      if (acc > STEP_MS * 3) acc = STEP_MS * 3;
      if (sim.over) onRunOver();
    }
    if (mode === 'end' && !endShown && nowMs - endT0 > 1500) showEnd();
    const sdt = dt / 1000;
    updParts(sdt);
    sqv += (-300 * sq - 15 * sqv) * sdt; sq += sqv * sdt;
    if (Math.abs(sq) < 0.0005 && Math.abs(sqv) < 0.001) { sq = 0; sqv = 0; }
    shake *= Math.pow(0.0015, sdt); flash *= Math.pow(0.02, sdt);
    scoreBump *= Math.pow(0.005, sdt); secPulse *= Math.pow(0.01, sdt);
    draw(mode === 'play' ? Math.min(1, acc / STEP_MS) : 1);
  }
  let readyPopped = false, goPopped = false;

  function onRunOver() {
    mode = 'end'; endT0 = nowMs;
    SFX.rollStop(0.05); SFX.gong();
    shake = 5;
    floatText("TIME'S UP!", DW / 2, DH * 0.42, 54, '#ffd23f', 1.6, 10);
    inbox = [];
  }

  // ---------- drawing ----------
  function rrFill(x, y, w, h, r, fill) { rr(g, x, y, w, h, r); g.fillStyle = fill; g.fill(); }

  function drawBoardLayer(S, offX, alphaPainted) {
    const G = S.G, m = sim.maze, T = G.T;
    g.drawImage(S.board.c, G.x - G.F - 12 + offX, G.y - G.F - 10, S.board.c.width / px, S.board.c.height / px);
    for (let i = 0; i < m.w * m.h; i++) {
      if (!sim.painted[i]) continue;
      const cx = i % m.w, cy = (i / m.w) | 0;
      let X = G.x + offX + cx * T, Y = G.y + cy * T, sc = 1, wh = 0;
      const age = nowMs - paintAt[i];
      if (age < 320) { const q = age / 320; sc = 0.35 + 0.65 * spring(q * 0.9); wh = (1 - q) * 0.75; }
      if (ripple) {
        const dly = (Math.abs(cx - ripple.cx) + Math.abs(cy - ripple.cy)) * 34;
        const q = (nowMs - ripple.t0 - dly) / 260;
        if (q > 0 && q < 1) { const b = Math.sin(q * Math.PI); sc *= 1 + 0.2 * b; wh = Math.max(wh, 0.55 * b); }
      }
      if (sc !== 1) { const d = T * (sc - 1) / 2; g.drawImage(S.paint, X - d, Y - d, T * sc, T * sc); } else g.drawImage(S.paint, X, Y, T, T);
      if (wh > 0.01) { g.globalAlpha = wh; const d = T * (sc - 1) / 2; g.drawImage(S.white, X - d, Y - d, T * sc, T * sc); g.globalAlpha = 1; }
    }
  }

  function drawBall(S, offX, alpha) {
    const G = S.G, T = G.T;
    const bx = prevB.x + (curB.x - prevB.x) * alpha, by = prevB.y + (curB.y - prevB.y) * alpha;
    const X = G.x + offX + (bx + 0.5) * T, Y = G.y + (by + 0.5) * T;
    const moving = sim.dir >= 0 && mode === 'play';
    if (moving) trail.push({ x: X, y: Y, t: nowMs });
    trail = trail.filter((p) => nowMs - p.t < 170);
    g.globalCompositeOperation = 'lighter';
    for (const p of trail) {
      const q = (nowMs - p.t) / 170, s = T * (0.55 - q * 0.25);
      g.globalAlpha = (1 - q) * 0.5; g.drawImage(S.glow, p.x - s, p.y - s, s * 2, s * 2);
    }
    g.globalAlpha = 0.35; const gs = T * 0.75; g.drawImage(S.glow, X - gs, Y - gs, gs * 2, gs * 2);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    // shadow
    g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(X + T * 0.05, Y + T * 0.24, T * 0.3, T * 0.1, 0, 0, 6.283); g.fill();
    // squash along the hit axis, stretch while rolling
    let sa = 1, sp = 1;
    const c = Math.max(-0.45, Math.min(0.45, sq * 0.06));
    sa = 1 - c; sp = 1 + c * 0.7;
    if (moving) { sa *= 1.1; sp *= 0.93; }
    const horiz = (moving ? sim.dir : sqDir) % 2 === 1;
    const D = S.ball.D, pad = S.ball.pad;
    const shiftA = (1 - sa) * D * 0.5;
    const sx = horiz ? sa : sp, sy = horiz ? sp : sa;
    const dd = moving ? -1 : sqDir;
    const offx = dd >= 0 ? DX[dd] * shiftA : 0, offy = dd >= 0 ? DY[dd] * shiftA : 0;
    g.save(); g.translate(X + offx, Y + offy); g.scale(sx, sy);
    g.drawImage(S.ball.c, -D / 2 - pad, -D / 2 - pad, D + pad * 2, D + pad * 2);
    g.restore();
  }

  function pill(x, y, w, label, val, col) {
    rrFill(x, y, w, 28, 14, 'rgba(255,255,255,.07)');
    g.strokeStyle = 'rgba(255,255,255,.1)'; g.lineWidth = 1; rr(g, x + 0.5, y + 0.5, w - 1, 27, 13.5); g.stroke();
    g.font = '11px ' + FONT; g.fillStyle = 'rgba(255,255,255,.55)'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(label, x + 12, y + 15);
    g.font = '17px ' + FONT; g.fillStyle = col; g.textAlign = 'right'; g.fillText(val, x + w - 12, y + 15);
  }

  function drawHud() {
    const P = palOf(sim.n);
    if (shownScore < sim.score) {
      const d = sim.score - shownScore;
      shownScore += Math.max(1, Math.ceil(d * 0.15));
      if (shownScore > sim.score) shownScore = sim.score;
      scoreBump = Math.min(1, scoreBump + 0.25);
    }
    g.textBaseline = 'middle';
    g.font = '12px ' + FONT; g.fillStyle = 'rgba(255,255,255,.5)'; g.textAlign = 'left';
    g.fillText('SCORE', 22, 32);
    g.save(); g.translate(22, 64); const sb = 1 + scoreBump * 0.12; g.scale(sb, sb);
    g.font = '38px ' + FONT; g.fillStyle = '#ffffff'; g.fillText(String(shownScore), 0, 0); g.restore();
    // clock
    const left = Math.max(0, TIME_STEPS - sim.step);
    const secs = Math.ceil(left / STEP_HZ);
    if (secs !== lastSecs) {
      if (lastSecs >= 0 && secs <= 10 && secs > 0 && mode === 'play') { secPulse = 1; SFX.tick(secs <= 3); }
      lastSecs = secs;
    }
    const red = secs <= 10;
    const mm = String(Math.floor(secs / 60)).padStart(2, '0'), ss = String(secs % 60).padStart(2, '0');
    g.font = '12px ' + FONT; g.fillStyle = red ? 'rgba(255,110,120,.85)' : 'rgba(255,255,255,.5)'; g.textAlign = 'right';
    g.fillText('TIME', DW - 22, 32);
    g.save(); g.translate(DW - 22, 64); const cs = 1 + secPulse * 0.18; g.scale(cs, cs);
    g.font = '34px ' + FONT; g.fillStyle = red ? '#ff4d5e' : '#ffffff'; g.fillText(mm + ':' + ss, 0, 0); g.restore();
    // maze number
    g.textAlign = 'center';
    g.font = '12px ' + FONT; g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText('MAZE', DW / 2, 32);
    g.font = '30px ' + FONT; g.fillStyle = P.a; g.fillText(String(sim.n), DW / 2, 63);
    // moves vs par
    const over = sim.moves > sim.maze.par;
    pill(DW / 2 - 128, 94, 122, 'MOVES', String(sim.moves), over ? '#ff9a5a' : '#9dffb0');
    pill(DW / 2 + 6, 94, 122, 'PAR', String(sim.maze.par), '#ffffff');
  }

  function draw(alpha) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (bgCanvas) g.drawImage(bgCanvas, 0, 0);
    const shx = shake > 0.05 ? (Math.random() - 0.5) * shake * 2 : 0, shy = shake > 0.05 ? (Math.random() - 0.5) * shake * 2 : 0;
    g.setTransform(px, 0, 0, px, (ox + shx * k) * dpr, (oy + shy * k) * dpr);
    if (sim && mode !== 'menu') {
      const P = palOf(sim.n);
      // soft colour wash behind the board
      g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.16;
      const gl = glowSprite(P.glow), bs = 300 + Math.sin(nowMs / 1400) * 20;
      g.drawImage(gl, DW / 2 - bs, 400 - bs, bs * 2, bs * 2);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      const S = sprites(sim.n, sim.maze);
      let offX = 0;
      if (slideIn) {
        const q = Math.min(1, (nowMs - slideIn.t0) / slideIn.dur), e = 1 - Math.pow(1 - q, 3);
        offX = (1 - e) * DW;
        if (slideIn.old) {
          const o = slideIn.old;
          g.globalAlpha = 1 - q;
          g.drawImage(o.c, o.G.x - o.G.F - 12 - e * DW, o.G.y - o.G.F - 10, o.w, o.h);
          g.globalAlpha = 1;
        }
        if (q >= 1) slideIn = null;
      }
      drawBoardLayer(S, offX);
      if (sim.pause === 0 || true) drawBall(S, offX, alpha);
      drawHud();
      if (!firstMoveDone && mode === 'play' && sim.n === 1) {
        g.globalAlpha = 0.55 + 0.35 * Math.sin(nowMs / 260);
        g.font = '15px ' + FONT; g.textAlign = 'center'; g.fillStyle = '#ffffff';
        g.fillText(touchSeen ? 'SWIPE TO ROLL THE BALL' : 'SWIPE OR USE THE ARROW KEYS', DW / 2, 712);
        g.globalAlpha = 1;
      }
      if (mode === 'ready') drawReady();
    }
    drawParts();
    drawTexts();
    if (flash > 0.01) { g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = 'rgba(255,250,225,' + flash + ')'; g.fillRect(0, 0, canvas.width, canvas.height); }
  }

  function drawReady() {
    const e = nowMs - readyT0;
    let str = null, t0 = 0;
    if (e > 380 && e < 1150) { str = 'READY'; t0 = 380; } else if (e >= 1150) { str = 'GO!'; t0 = 1150; }
    if (!str) return;
    const q = (e - t0) / 1000, sc = Math.max(0.01, spring(q * 1.4)) * (str === 'GO!' ? 1 + Math.max(0, (e - 1300) / 400) : 1);
    const a = str === 'GO!' ? Math.max(0, 1 - Math.max(0, e - 1300) / 200) : 1;
    g.save(); g.translate(DW / 2, 400); g.scale(sc, sc); g.globalAlpha = a;
    g.font = '64px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = 12; g.strokeStyle = 'rgba(15,8,30,.9)'; g.strokeText(str, 0, 0);
    g.fillStyle = str === 'GO!' ? '#9dffb0' : '#ffd23f'; g.fillText(str, 0, 0);
    g.restore();
  }

  // ---------- input: forgiving swipes, arrows, one gesture one move ----------
  let touchSeen = false;
  const gest = { id: null, x: 0, y: 0, fired: false };
  function fire(d) {
    if (mode !== 'play' || !sim || sim.over) return;
    inbox.push(d);
    if (inbox.length > 2) inbox.splice(0, inbox.length - 2);
  }
  function dirOf(dx, dy) { return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0); }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') touchSeen = true;
    if (gest.id !== null) return;
    gest.id = e.pointerId; gest.x = e.clientX; gest.y = e.clientY; gest.fired = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerId !== gest.id || gest.fired) return;
    const dx = e.clientX - gest.x, dy = e.clientY - gest.y;
    if (dx * dx + dy * dy >= 16 * 16) { gest.fired = true; fire(dirOf(dx, dy)); }
  });
  function endGesture(e) {
    if (e.pointerId !== gest.id) return;
    if (!gest.fired) {
      const dx = e.clientX - gest.x, dy = e.clientY - gest.y;
      if (dx * dx + dy * dy >= 7 * 7) fire(dirOf(dx, dy));
    }
    gest.id = null;
  }
  window.addEventListener('pointerup', endGesture);
  window.addEventListener('pointercancel', (e) => { if (e.pointerId === gest.id) gest.id = null; });
  const KEYS = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3, w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3 };
  window.addEventListener('keydown', (e) => {
    if (e.key in KEYS) {
      e.preventDefault();
      if (!e.repeat) fire(KEYS[e.key]);
    }
  });

  // ---------- screens ----------
  const $ = (id) => document.getElementById(id);
  const menuEl = $('menu'), howEl = $('howto'), overEl = $('over'), muteBtn = $('muteBtn');
  function show(el, on) {
    if (on) { el.classList.remove('is-gone'); requestAnimationFrame(() => el.classList.remove('is-hidden')); }
    else { el.classList.add('is-hidden'); setTimeout(() => { if (el.classList.contains('is-hidden')) el.classList.add('is-gone'); }, 300); }
  }
  muteBtn.classList.toggle('off', muted);
  muteBtn.addEventListener('click', (e) => { e.stopPropagation(); setMuted(!muted); if (!muted) SFX.ui(); });
  function seenHow() { try { return localStorage.getItem('rang-bharo.how') === '1'; } catch (_e) { return false; } }
  function markHow() { try { localStorage.setItem('rang-bharo.how', '1'); } catch (_e) {} }

  $('playBtn').addEventListener('click', () => {
    SFX.ui();
    show(menuEl, false); logo.running = false;
    if (!seenHow()) { openHow(true); return; }
    startRun();
  });
  $('howBtn').addEventListener('click', () => { SFX.ui(); show(menuEl, false); logo.running = false; openHow(false); });
  let howThenPlay = false;
  function openHow(thenPlay) { howThenPlay = thenPlay; mode = 'howto'; show(howEl, true); demo.start(); }
  $('howOk').addEventListener('click', () => {
    SFX.ui(); markHow(); show(howEl, false); demo.stop();
    if (howThenPlay) startRun(); else { mode = 'menu'; show(menuEl, true); logo.start(); }
  });
  $('againBtn').addEventListener('click', () => { SFX.ui(); show(overEl, false); startRun(); });
  $('homeBtn').addEventListener('click', () => { SFX.ui(); show(overEl, false); sim = null; mode = 'menu'; show(menuEl, true); logo.start(); refreshBest(); });

  function refreshBest() { $('menuBest').textContent = bestScore > 0 ? 'BEST ' + bestScore : ''; }

  function showEnd() {
    endShown = true;
    const s = sim, isBest = s.score > bestScore && s.score > 0;
    if (isBest) { bestScore = s.score; try { localStorage.setItem('rang-bharo.best', String(bestScore)); } catch (_e) {} }
    $('stMazes').textContent = String(s.mazes);
    $('stPerfect').textContent = String(s.perfects);
    $('stTiles').textContent = String(s.tiles);
    $('stMoves').textContent = String(s.totalMoves);
    $('overBest').textContent = 'BEST ' + bestScore;
    $('newBest').hidden = !isBest;
    const scEl = $('overScore'); scEl.textContent = '0';
    show(overEl, true);
    const t0 = performance.now(), dur = Math.min(1600, 500 + s.score * 3);
    let lastTick = 0;
    (function cnt() {
      const q = Math.min(1, (performance.now() - t0) / dur), v = Math.round(s.score * (1 - Math.pow(1 - q, 3)));
      scEl.textContent = String(v);
      if (v !== lastTick && q < 1) { if ((v & 3) === 0) SFX.count(v % 40); lastTick = v; }
      if (q < 1) requestAnimationFrame(cnt);
      else if (isBest) { SFX.best(); confetti(DW / 2, 230, 120, palOf(1), 1.3); confetti(DW / 2, 230, 60, palOf(3), 1); }
    })();
  }

  // ---------- menu logo: the ball paints the title ----------
  const logo = (function () {
    const cv = $('logo'), x = cv.getContext('2d');
    const LW = cv.width, LH = cv.height;
    const rows = [72, 148, 218, 292];
    const path = [];
    let pxp = 40;
    for (let i = 0; i < rows.length; i++) {
      const y = rows[i], fromX = i % 2 ? LW - 40 : 40, toX = i % 2 ? 40 : LW - 40;
      if (i === 0) path.push({ x: fromX, y }); else path.push({ x: pxp, y });
      path.push({ x: toX, y }); pxp = toX;
    }
    let segLen = [], total = 0;
    for (let i = 1; i < path.length; i++) { const l = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y); segLen.push(l); total += l; }
    let t = 0, last = null, running = false, hitSq = 0, prevSeg = -1, ltrail = [];
    let textC = null, paintC = null;
    function build() {
      textC = mk(LW, LH); paintC = mk(LW, LH);
      const a = textC.getContext('2d'), b = paintC.getContext('2d');
      for (const [c2, fill] of [[a, 0], [b, 1]]) {
        c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.lineJoin = 'round';
        const draw2 = (str, y, sz) => {
          c2.font = sz + 'px ' + FONT;
          c2.lineWidth = 16; c2.strokeStyle = fill ? '#1a0d2e' : '#140d26'; c2.strokeText(str, LW / 2, y);
          if (fill) {
            const gr = c2.createLinearGradient(40, 0, LW - 40, 0);
            gr.addColorStop(0, '#ffd23f'); gr.addColorStop(0.25, '#ff7a00'); gr.addColorStop(0.5, '#ff4fb8'); gr.addColorStop(0.75, '#2bd9c4'); gr.addColorStop(1, '#5d86ff');
            c2.fillStyle = gr;
          } else c2.fillStyle = '#2f2556';
          c2.fillText(str, LW / 2, y);
          if (fill) { c2.save(); c2.globalCompositeOperation = 'source-atop'; c2.fillStyle = 'rgba(255,255,255,.28)'; c2.fillRect(0, y - sz * 0.5, LW, sz * 0.32); c2.restore(); }
          else { c2.save(); c2.globalCompositeOperation = 'source-atop'; c2.fillStyle = 'rgba(255,255,255,.07)'; c2.fillRect(0, y - sz * 0.5, LW, sz * 0.3); c2.restore(); }
        };
        draw2('RANG', 112, 150); draw2('BHARO', 256, 132);
      }
    }
    function posAt(d) {
      let i = 0;
      while (i < segLen.length && d > segLen[i]) { d -= segLen[i]; i++; }
      if (i >= segLen.length) return { x: path[path.length - 1].x, y: path[path.length - 1].y, seg: segLen.length - 1 };
      const a = path[i], b = path[i + 1], q = d / segLen[i];
      return { x: a.x + (b.x - a.x) * q, y: a.y + (b.y - a.y) * q, seg: i };
    }
    const SPEED = 900, HOLD = 1.6;
    function tick(now) {
      if (!running) return;
      requestAnimationFrame(tick);
      if (last === null) last = now;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      t += dt;
      const travel = Math.min(total, t * SPEED);
      const p = posAt(travel);
      if (p.seg !== prevSeg) { if (prevSeg >= 0) hitSq = 1; prevSeg = p.seg; }
      hitSq *= Math.pow(0.002, dt);
      x.clearRect(0, 0, LW, LH);
      x.drawImage(textC, 0, 0);
      // reveal what the ball has rolled over
      const done = travel >= total, fade = done ? Math.max(0, 1 - Math.max(0, t - total / SPEED - HOLD) / 0.4) : 1;
      x.save(); x.beginPath();
      let d = travel;
      for (let i = 0; i < segLen.length && d > 0; i++) {
        const a = path[i], b = path[i + 1], q = Math.min(1, d / segLen[i]);
        const ex = a.x + (b.x - a.x) * q, ey = a.y + (b.y - a.y) * q;
        const hh = 40;
        x.rect(Math.min(a.x, ex) - hh, Math.min(a.y, ey) - hh, Math.abs(ex - a.x) + hh * 2, Math.abs(ey - a.y) + hh * 2);
        d -= segLen[i];
      }
      x.clip(); x.globalAlpha = fade; x.drawImage(paintC, 0, 0); x.restore();
      if (done && fade > 0) {
        const sx = ((t - total / SPEED) / HOLD) * (LW + 300) - 150;
        x.save(); x.globalCompositeOperation = 'source-atop';
        const sg = x.createLinearGradient(sx - 60, 0, sx + 60, 0);
        sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, 'rgba(255,255,255,.55)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
        x.globalAlpha = fade; x.fillStyle = sg; x.fillRect(0, 0, LW, LH); x.restore();
      }
      // the ball
      if (!done || fade > 0.5) {
        ltrail.push({ x: p.x, y: p.y, t });
        ltrail = ltrail.filter((q) => t - q.t < 0.18);
        x.globalCompositeOperation = 'lighter';
        for (const q of ltrail) { const a = 1 - (t - q.t) / 0.18; x.globalAlpha = a * 0.5; x.drawImage(glowSprite('255,200,90'), q.x - 34, q.y - 34, 68, 68); }
        x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
        const r = 26, sqz = hitSq * 0.3, horiz = path[p.seg + 1] && path[p.seg + 1].y === path[p.seg].y;
        x.save(); x.translate(p.x, p.y); x.scale(horiz ? 1 - sqz : 1 + sqz * 0.7, horiz ? 1 + sqz * 0.7 : 1 - sqz);
        const gr = x.createRadialGradient(-r * 0.35, -r * 0.4, 2, 0, 0, r);
        gr.addColorStop(0, '#fff'); gr.addColorStop(0.4, '#fff1b8'); gr.addColorStop(0.85, '#ffd23f'); gr.addColorStop(1, '#ff7a00');
        x.fillStyle = gr; x.beginPath(); x.arc(0, 0, r, 0, 6.283); x.fill();
        x.fillStyle = 'rgba(255,255,255,.9)'; x.beginPath(); x.ellipse(-r * 0.35, -r * 0.42, r * 0.26, r * 0.16, -0.6, 0, 6.283); x.fill();
        x.restore();
      }
      if (done && fade <= 0) { t = 0; prevSeg = -1; ltrail = []; }
    }
    return {
      get running() { return running; },
      set running(v) { running = v; },
      start() { if (!textC) build(); if (running) return; running = true; last = null; requestAnimationFrame(tick); },
      rebuild() { textC = null; build(); },
    };
  })();

  // ---------- HOW TO PLAY demo: a tiny maze that paints itself ----------
  const demo = (function () {
    const cv = $('demo'), x = cv.getContext('2d');
    const MAP = ['11110', '10010', '10111', '11100'];
    const w = 5, h = 4, cells = new Uint8Array(w * h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) cells[yy * w + xx] = MAP[yy][xx] === '1' ? 1 : 0;
    const MOVES = [1, 2, 1, 3, 2, 3, 0];
    const T = 44, X0 = (cv.width - w * T) / 2, Y0 = 18;
    let running = false, t0 = 0, painted, pos, mi, phase, ph0, from, to, hitT = -9;
    const P = PALS[0];
    let tile = null;
    function reset() { painted = new Uint8Array(w * h); pos = 0; painted[0] = 1; mi = 0; phase = 'swipe'; ph0 = performance.now(); }
    function tick(now) {
      if (!running) return;
      requestAnimationFrame(tick);
      if (!tile) { tile = (function () { const c = mk(T, T), y = c.getContext('2d'); const gr = y.createLinearGradient(0, 0, 0, T); gr.addColorStop(0, P.a); gr.addColorStop(1, P.b); rr(y, 2, 2, T - 4, T - 4, 8); y.fillStyle = gr; y.fill(); y.fillStyle = 'rgba(255,255,255,.3)'; y.beginPath(); y.ellipse(T / 2, T * 0.2, T * 0.45, T * 0.22, 0, 0, 6.283); y.fill(); return c; })(); }
      const e = now - ph0;
      let bx = pos % w, by = (pos / w) | 0;
      if (phase === 'swipe' && e > 520) { from = pos; to = slideEnd(cells, w, h, pos, MOVES[mi]); phase = 'roll'; ph0 = now; }
      else if (phase === 'roll') {
        const dist = Math.abs((to % w) - (from % w)) + Math.abs(((to / w) | 0) - ((from / w) | 0));
        const q = Math.min(1, e / (dist * 75));
        const fx = from % w, fy = (from / w) | 0, tx = to % w, ty = (to / w) | 0;
        bx = fx + (tx - fx) * q; by = fy + (ty - fy) * q;
        const cx = Math.round(bx), cy = Math.round(by); painted[cy * w + cx] = 1;
        if (q >= 1) { pos = to; mi++; hitT = now; phase = mi >= MOVES.length ? 'done' : 'swipe'; ph0 = now; }
      } else if (phase === 'done' && e > 1400) reset();
      x.clearRect(0, 0, cv.width, cv.height);
      rr(x, X0 - 10, Y0 - 10, w * T + 20, h * T + 20, 14); x.fillStyle = '#2c2452'; x.fill();
      for (let i = 0; i < w * h; i++) {
        const cx = i % w, cy = (i / w) | 0, X = X0 + cx * T, Y = Y0 + cy * T;
        if (cells[i]) { rr(x, X + 1.5, Y + 1.5, T - 3, T - 3, 8); x.fillStyle = '#0c0919'; x.fill(); if (painted[i]) x.drawImage(tile, X, Y); }
        else { rr(x, X + 1, Y + 1, T - 2, T - 2, 7); x.fillStyle = '#463a78'; x.fill(); }
      }
      const sqz = Math.max(0, 1 - (now - hitT) / 180) * 0.25;
      x.save(); x.translate(X0 + (bx + 0.5) * T, Y0 + (by + 0.5) * T); x.scale(1 + sqz * 0.5, 1 - sqz);
      const r = 15, gr = x.createRadialGradient(-5, -6, 1, 0, 0, r);
      gr.addColorStop(0, '#fff'); gr.addColorStop(0.5, '#fff1b8'); gr.addColorStop(1, '#ff9a1f');
      x.fillStyle = gr; x.beginPath(); x.arc(0, 0, r, 0, 6.283); x.fill(); x.restore();
      if (phase === 'swipe' && mi < MOVES.length) {
        // a finger flick showing the next swipe
        const d = MOVES[mi], q = Math.min(1, e / 420), cxp = cv.width / 2, cyp = Y0 + h * T + 52;
        const sx = cxp - DX[d] * 34 + DX[d] * 68 * q, sy = cyp - DY[d] * 20 + DY[d] * 40 * q;
        x.strokeStyle = 'rgba(255,255,255,' + (0.5 * q) + ')'; x.lineWidth = 5; x.lineCap = 'round';
        x.beginPath(); x.moveTo(cxp - DX[d] * 34, cyp - DY[d] * 20); x.lineTo(sx, sy); x.stroke();
        x.fillStyle = 'rgba(255,255,255,.9)'; x.beginPath(); x.arc(sx, sy, 11, 0, 6.283); x.fill();
        x.fillStyle = 'rgba(255,210,63,.9)'; x.beginPath(); x.arc(sx, sy, 6, 0, 6.283); x.fill();
      }
      if (phase === 'done') {
        x.font = '26px ' + FONT; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#ffd23f';
        x.fillText('CLEAR!', cv.width / 2, Y0 + h * T + 52);
      }
    }
    return { start() { if (running) return; running = true; reset(); requestAnimationFrame(tick); }, stop() { running = false; } };
  })();

  // ---------- boot ----------
  resize();
  refreshBest();
  const fontReady = (document.fonts && document.fonts.load) ? document.fonts.load('40px "Titan One"') : Promise.resolve();
  fontReady.then(() => { logo.rebuild(); spr.key = null; }, () => {}).then(() => logo.start());
  const playBtn = $('playBtn');
  playBtn.disabled = false; playBtn.textContent = 'PLAY'; playBtn.classList.add('play-pulse');
  requestAnimationFrame(frame);
  if (harness) {
    harness.fire = fire;
    harness.state = () => ({ mode, sim });
    harness.start = () => { show(menuEl, false); logo.running = false; markHow(); startRun(); };
  }
})();
