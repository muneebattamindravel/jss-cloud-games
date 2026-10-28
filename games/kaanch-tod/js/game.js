/* Kaanch Tod: Phase 1 playable core.
   Tap the tower to fire. Glass shatters, crates and logs crack then splinter,
   everything above falls. Clear the table to win balls and a taller tower.
   Endless: the run ends when the balls run out with blocks still standing.

   The sim already runs on fixed 1/60 s steps with integer positions (1/16 px)
   and a sine table, so Phase 2 can lift it into a rules block. Effects read
   S.events and never write the sim. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- sim
  var W = 414, H = 736, U = 16;              // design space, sub units per px
  var CELL = 46 * U, BH = 60 * U;            // block cell width / height
  var FLOOR = 478 * U;                       // table top
  var CX = 207 * U;                          // centre line
  var FLIGHT = 22;                           // steps from cannon to tower
  var GRAV = 6, VMAX = 240, CRUSH_V = 70, LAND_V = 30;
  var BALL_G = 5, BALL_R = 7 * U;
  var FAN_CY = 300 * U, FAN_LEN = 140, FAN_HALF = 15, FAN_HUB = 22;
  var SHOT_GAP = 9;
  var POW_GLASS = 4, POW_WOOD = 2;                          // steps between shots
  var PTS = { g: 10, c: 25, l: 40 };
  var HP = { g: 1, c: 2, l: 3 };
  var SINQ = [0,25,50,75,100,125,150,175,200,224,249,273,297,321,345,369,392,415,438,460,483,505,526,548,569,590,610,630,650,669,688,706,724,742,759,775,792,807,822,837,851,865,878,891,903,915,926,936,946,955,964,972,980,987,993,999,1004,1009,1013,1016,1019,1021,1023,1024,1024];
  function isin(a) { a &= 255; if (a < 64) return SINQ[a]; if (a < 128) return SINQ[128 - a]; if (a < 192) return -SINQ[a - 128]; return -SINQ[256 - a]; }
  function icos(a) { return isin(a + 64); }

  function hash(seed, a, b) {
    var h = (seed ^ Math.imul(a + 1, 0x9E3779B1) ^ Math.imul(b + 7, 0x85EBCA77)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7FEB352D) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846CA68B) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  function buildTower(S) {
    var L = S.level, sd = S.seed;
    var cols = 8;
    var hmax = Math.min(6, 2 + L);
    var left = CX - (cols * CELL) / 2;
    var hs = [], c, r;
    var shape = hash(sd, L, 1) % 3;          // 0 flat-ish, 1 castle, 2 steps
    for (c = 0; c < cols; c++) {
      var d = hash(sd, L, 10 + c) % 3;
      if (shape === 1) d = (c === 0 || c === cols - 1) ? 0 : (c % 2 ? 1 + (d & 1) : d & 1);
      if (shape === 2) d = Math.min(hmax - 2, Math.abs(c * 2 - (cols - 1)) >> 1);
      hs.push(Math.max(2, hmax - d));
    }
    var used = [], logP = Math.min(34, (L - 1) * 7), crateP = Math.min(40, 4 + L * 5);
    for (c = 0; c < cols; c++) used.push([]);
    var blocks = [], id = S.nextId;
    for (r = 0; r < hmax; r++) {
      for (c = 0; c < cols; c++) {
        if (r >= hs[c] || used[c][r]) continue;
        var hv = hash(sd, L, 100 + r * 16 + c) % 100;
        var y = FLOOR - r * BH;
        if (r % 2 === 1 && c + 1 < cols && r < hs[c + 1] && !used[c + 1][r] && hv < logP) {
          used[c][r] = used[c + 1][r] = 1;
          blocks.push({ id: id++, t: 'l', x: left + c * CELL, w: CELL * 2, h: BH, y: y, vy: 0, hp: HP.l, col: 0 });
          continue;
        }
        used[c][r] = 1;
        var t = (hash(sd, L, 300 + r * 16 + c) % 100) < crateP ? 'c' : 'g';
        // colour regions: the tower reads as a few big blocks of colour
        var col = hash(sd, L, 500 + ((c * 2 / cols) | 0) + ((r * 2 / hmax) | 0) * 2) % 5;
        var tall = t === 'g' && r + 1 < hs[c] && !used[c][r + 1] && (hash(sd, L, 700 + r * 16 + c) % 100) < 40;
        if (tall) used[c][r + 1] = 1;
        blocks.push({ id: id++, t: t, x: left + c * CELL, w: CELL, h: tall ? BH * 2 : BH, y: y, vy: 0, hp: HP[t], col: col });
      }
    }
    S.nextId = id;
    S.blocks = blocks;
    var cost = 0;
    for (var i = 0; i < blocks.length; i++) cost += blocks[i].t === 'g' ? 10 : blocks[i].t === 'c' ? 24 : 36;
    var add = Math.max(6, ((cost + 29) / 30) | 0) + (L === 1 ? 6 : 0);
    S.balls += add;
    S.fan = L >= 3 ? { ang: hash(sd, L, 2) & 255, spd: L >= 7 ? 2 : 1, dir: (hash(sd, L, 3) & 1) ? 1 : -1 } : null;
    S.events.push({ e: 'tower', add: add, level: L });
  }

  function initSim(seed) {
    var S = { seed: seed >>> 0, step: 0, level: 1, balls: 0, score: 0, blocks: [], flights: [], loose: [],
      fan: null, phase: 'play', timer: 0, nextId: 1, lastShot: -99, shots: 0, events: [] };
    buildTower(S);
    return S;
  }

  function fanBlocks(S, x, y) {
    if (!S.fan) return false;
    var px = ((x - CX) / U) | 0, py = ((y - FAN_CY) / U) | 0;
    if (px * px + py * py <= FAN_HUB * FAN_HUB) return true;
    for (var k = 0; k < 4; k++) {
      var a = S.fan.ang + k * 64, co = icos(a), si = isin(a);
      var along = (px * co + py * si) / 1024, perp = (py * co - px * si) / 1024;
      if (along >= 0 && along <= FAN_LEN && perp <= FAN_HALF && perp >= -FAN_HALF) return true;
    }
    return false;
  }

  function blockAt(S, x, y, pad) {
    for (var i = S.blocks.length - 1; i >= 0; i--) {
      var b = S.blocks[i];
      if (x >= b.x - pad && x < b.x + b.w + pad && y > b.y - b.h - pad && y <= b.y + pad) return b;
    }
    return null;
  }

  function damage(S, b, how) {
    b.hp -= 1;
    if (b.hp > 0) { S.events.push({ e: 'crack', t: b.t, x: b.x, y: b.y, w: b.w, h: b.h, hp: b.hp }); return false; }
    S.blocks = S.blocks.filter(function (o) { return o !== b; });
    S.score += PTS[b.t];
    S.events.push({ e: 'break', t: b.t, x: b.x, y: b.y, w: b.w, h: b.h, col: b.col, pts: PTS[b.t], how: how });
    return true;
  }

  function shoot(S, x, y) {
    if (S.phase !== 'play' || S.balls <= 0 || S.step - S.lastShot < SHOT_GAP) return false;
    if (y > FLOOR + 30 * U || y < 80 * U || x < 0 || x > W * U) return false;
    S.balls -= 1; S.lastShot = S.step; S.shots += 1;
    S.flights = S.flights.concat([{ x: x, y: y, t: 0, n: S.shots }]);
    S.events.push({ e: 'fire', x: x, y: y, n: S.shots });
    return true;
  }

  function impact(S, f) {
    if (fanBlocks(S, f.x, f.y)) {
      S.events.push({ e: 'fan', x: f.x, y: f.y, n: f.n });
      return;
    }
    var b = blockAt(S, f.x, f.y, 3 * U);
    if (!b) { S.events.push({ e: 'miss', x: f.x, y: f.y, n: f.n }); return; }
    var broke = damage(S, b, 'shot');
    // the ball keeps going: it pops off the hit and ricochets through the stack
    var hv = hash(S.seed, 900 + S.level, f.n);
    var side = f.x < b.x + (b.w >> 1) ? -1 : 1;
    var vx = side * (18 + (hv % 30)), vy = -(20 + ((hv >>> 8) % 40));
    S.loose = S.loose.concat([{ x: f.x, y: f.y, vx: vx, vy: broke ? vy : -30, pow: broke ? (b.t === 'g' ? POW_GLASS : POW_WOOD) : 0, n: f.n }]);
    S.events.push({ e: 'hit', x: f.x, y: f.y, n: f.n });
  }

  function stepBall(S, k) {
    k.vy = Math.min(VMAX, k.vy + BALL_G);
    var oy = k.y;
    k.x += k.vx; k.y += k.vy;
    if (k.pow > 0) {
      var b = blockAt(S, k.x, k.y, BALL_R);
      if (b) {
        if (b.t === 'g') { damage(S, b, 'ball'); k.pow -= 1; k.vy = (k.vy * 3 / 4) | 0; }
        else {
          var broke = damage(S, b, 'ball');
          k.pow -= broke ? 1 : 2;
          if (!broke) {
            if (oy <= b.y - b.h - BALL_R + 2 * U) { k.y = b.y - b.h - BALL_R; k.vy = -((Math.abs(k.vy) / 2) | 0); }
            else { k.vx = -((k.vx / 2) | 0) || (k.x < b.x + (b.w >> 1) ? -12 : 12); k.x += k.vx * 2; }
          }
        }
      }
    }
    var onTable = S.blocks.length ? true : true;
    if (onTable && k.vy > 0 && k.y >= FLOOR - BALL_R && oy < FLOOR - BALL_R + U && k.x > CX - 196 * U && k.x < CX + 196 * U) {
      S.events.push({ e: 'thud', x: k.x, y: FLOOR, v: k.vy, ball: 1 });
      k.y = FLOOR - BALL_R; k.vy = -((k.vy / 3) | 0); k.pow = 0;
      if (k.vy > -10) k.vx = k.vx || (k.x < CX ? -20 : 20);
    }
    return k.y < (H + 40) * U && k.x > -40 * U && k.x < (W + 40) * U;
  }

  function stepBlocks(S) {
    var bs = S.blocks.slice().sort(function (a, b) { return (b.y - a.y) || (a.id - b.id); });
    var crushed = [];
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (crushed.indexOf(b) >= 0) continue;
      var sup = FLOOR, under = [];
      for (var j = 0; j < bs.length; j++) {
        var o = bs[j];
        if (o === b || crushed.indexOf(o) >= 0) continue;
        if (o.x < b.x + b.w && b.x < o.x + o.w && o.y - o.h >= b.y - 4 * U) {
          var top = o.y - o.h;
          if (top < sup) { sup = top; under = [o]; } else if (top === sup) under.push(o);
        }
      }
      b.vy = Math.min(VMAX, b.vy + GRAV);
      var ny = b.y + b.vy;
      if (ny < sup) { b.y = ny; continue; }
      var allGlass = under.length > 0 && under.every(function (o) { return o.t === 'g'; });
      if (b.t !== 'g' && b.vy >= CRUSH_V && allGlass) {
        for (var q = 0; q < under.length; q++) { crushed.push(under[q]); damage(S, under[q], 'crush'); }
        b.y = sup; b.vy = (b.vy * 2 / 3) | 0;
        continue;
      }
      if (b.vy >= LAND_V) S.events.push({ e: 'thud', x: b.x + (b.w >> 1), y: sup, v: b.vy, t: b.t });
      b.y = sup; b.vy = 0;
    }
  }

  function settled(S) {
    for (var i = 0; i < S.blocks.length; i++) if (S.blocks[i].vy !== 0) return false;
    return true;
  }

  function stepSim(S) {
    S.step += 1;
    if (S.fan) S.fan.ang = (S.fan.ang + S.fan.spd * S.fan.dir) & 255;
    var fl = [];
    for (var i = 0; i < S.flights.length; i++) {
      var f = S.flights[i];
      if (f.t + 1 >= FLIGHT) impact(S, f); else fl.push({ x: f.x, y: f.y, t: f.t + 1, n: f.n });
    }
    S.flights = fl;
    var lo = [];
    for (i = 0; i < S.loose.length; i++) if (stepBall(S, S.loose[i])) lo.push(S.loose[i]);
    S.loose = lo;
    stepBlocks(S);
    var quiet = !S.flights.length && settled(S);
    if (S.phase === 'play') {
      if (!S.blocks.length && !S.flights.length) {
        var bonus = 100 + 50 * S.level;
        S.score += bonus; S.phase = 'clear'; S.timer = 80;
        S.events.push({ e: 'clear', bonus: bonus, level: S.level });
      } else if (S.balls <= 0 && quiet && !S.loose.length) {
        S.phase = 'ending'; S.timer = 70;
      }
    } else if (S.phase === 'clear') {
      if (--S.timer <= 0) { S.level += 1; S.phase = 'play'; buildTower(S); }
    } else if (S.phase === 'ending') {
      if (--S.timer <= 0) { S.phase = 'over'; S.events.push({ e: 'over', score: S.score }); }
    }
  }

  // ---------------------------------------------------------------- audio
  var AC = null, master = null, noiseBuf = null, lastPlay = {};
  function audioInit() {
    if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    AC = new C();
    master = AC.createGain(); master.gain.value = 0.7;
    var comp = AC.createDynamicsCompressor();
    master.connect(comp); comp.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function throttle(k, ms) {
    if (!AC) return false;
    var n = AC.currentTime * 1000;
    if (lastPlay[k] && n - lastPlay[k] < ms) return false;
    lastPlay[k] = n; return true;
  }
  function noise(t0, dur, type, freq, q, vol, attack) {
    var s = AC.createBufferSource(); s.buffer = noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    var f = AC.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    var g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (attack || 0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + 0.05);
  }
  function tone(t0, type, f0, f1, dur, vol) {
    var o = AC.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    var g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  var SFX = {
    glass: function (big) {
      if (!throttle('glass', 35)) return;
      var t = AC.currentTime;
      noise(t, 0.09, 'highpass', 2500, 0.7, 0.9);                 // the crack
      noise(t + 0.01, 0.35 + Math.random() * 0.2, 'bandpass', 5200, 1.2, 0.35);  // spray
      tone(t, 'triangle', 1900 + Math.random() * 400, 900, 0.06, 0.25);
      var n = big ? 9 : 6;
      for (var i = 0; i < n; i++) {                                // tinkles as shards land
        var dt = 0.03 + Math.random() * 0.45, f = 2600 + Math.random() * 4200;
        tone(t + dt, 'sine', f, f * 0.97, 0.08 + Math.random() * 0.18, 0.06 + Math.random() * 0.08);
      }
    },
    woodBreak: function (log) {
      if (!throttle('woodB', 40)) return;
      var t = AC.currentTime;
      noise(t, 0.05, 'bandpass', 1800, 1.5, 0.9);                  // snap
      noise(t + 0.015, log ? 0.4 : 0.28, 'bandpass', log ? 520 : 700, 1.4, 0.7, 0.01); // splinter crunch
      noise(t + 0.06, 0.12, 'bandpass', 1200, 2, 0.4);
      tone(t, 'triangle', log ? 140 : 190, 55, log ? 0.35 : 0.22, 0.6);  // body
      for (var i = 0; i < 4; i++) noise(t + 0.08 + Math.random() * 0.25, 0.04, 'bandpass', 900 + Math.random() * 900, 3, 0.2);
    },
    woodHit: function () {
      if (!throttle('woodH', 40)) return;
      var t = AC.currentTime;
      tone(t, 'sine', 260, 110, 0.14, 0.7);
      noise(t, 0.06, 'bandpass', 1100, 2.5, 0.6);
      noise(t + 0.01, 0.1, 'lowpass', 500, 1, 0.3);
    },
    thud: function (v, t0) {
      if (!throttle('thud', 45)) return;
      var t = AC.currentTime, k = Math.min(1, v / 160);
      tone(t, 'sine', 95 + Math.random() * 20, 40, 0.18 + 0.1 * k, 0.25 + 0.6 * k);
      noise(t, 0.08 + 0.08 * k, 'lowpass', t0 === 'g' ? 1600 : 700, 0.8, 0.15 + 0.35 * k);
      if (t0 === 'g') tone(t + 0.01, 'sine', 3200, 3100, 0.05, 0.05);
    },
    ballBounce: function (v) {
      if (!throttle('bb', 50)) return;
      var t = AC.currentTime, k = Math.min(1, v / 150);
      tone(t, 'sine', 420, 200, 0.07, 0.15 + 0.3 * k);
    },
    cannon: function () {
      var t = AC.currentTime;
      noise(t, 0.28, 'lowpass', 900, 0.8, 0.9);
      tone(t, 'sine', 140, 45, 0.25, 0.8);
      noise(t, 0.05, 'highpass', 3000, 0.5, 0.25);
    },
    fan: function () {
      var t = AC.currentTime;
      tone(t, 'square', 620, 540, 0.12, 0.12);
      tone(t, 'square', 910, 870, 0.1, 0.08);
      noise(t, 0.08, 'bandpass', 2400, 4, 0.4);
      tone(t, 'sine', 180, 90, 0.15, 0.4);
    },
    whoosh: function () {
      var t = AC.currentTime;
      noise(t, 0.3, 'bandpass', 900, 0.8, 0.12, 0.08);
    },
    clear: function () {
      var t = AC.currentTime, ns = [523, 659, 784, 1047, 1319];
      for (var i = 0; i < ns.length; i++) tone(t + i * 0.08, 'triangle', ns[i], ns[i], 0.35, 0.3);
    },
    over: function () {
      var t = AC.currentTime, ns = [523, 440, 349, 262];
      for (var i = 0; i < ns.length; i++) tone(t + i * 0.14, 'triangle', ns[i], ns[i] * 0.98, 0.4, 0.3);
    },
    reload: function () {
      var t = AC.currentTime;
      tone(t, 'triangle', 700, 1400, 0.12, 0.2);
      tone(t + 0.09, 'triangle', 900, 1800, 0.12, 0.2);
    }
  };
  function sfx(name, a, b) { if (AC && SFX[name]) try { SFX[name](a, b); } catch (e) { /* audio is best effort */ } }

  // ---------------------------------------------------------------- effects
  var GLASS = [
    { base: '#2f8cff', lite: '#9fd0ff', dark: '#1550b8' },
    { base: '#ff3d55', lite: '#ffb0b8', dark: '#b3132c' },
    { base: '#ffc21a', lite: '#fff0a0', dark: '#c98400' },
    { base: '#9a4dff', lite: '#d8b8ff', dark: '#5d1fc0' },
    { base: '#2fd06a', lite: '#b4f5c8', dark: '#138a3e' }
  ];
  var parts = [], floats = [], rings = [], shake = 0, flash = 0, banner = null, cannonKick = 0, aim = { x: 207, y: 300 };
  var MAXP = 900, crushCool = 0;

  function addPart(p) { if (parts.length < MAXP) parts.push(p); }

  function shardBurst(x, y, w, h, c, n, power) {
    for (var i = 0; i < n; i++) {
      var sx = x + Math.random() * w, sy = y - Math.random() * h;
      var a = Math.random() * Math.PI * 2, sp = (1.5 + Math.random() * 5) * power;
      var sz = 3 + Math.random() * 9;
      var pts = [];
      var k = 3 + (Math.random() * 2 | 0);
      for (var j = 0; j < k; j++) { var aa = j / k * Math.PI * 2 + Math.random() * 0.8; var rr = sz * (0.4 + Math.random() * 0.8); pts.push(Math.cos(aa) * rr, Math.sin(aa) * rr); }
      addPart({ k: 'shard', x: sx, y: sy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2.5 * power, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.6,
        pts: pts, col: Math.random() < 0.25 ? c.lite : Math.random() < 0.5 ? c.base : c.dark, life: 120 + Math.random() * 80, a: 0.95, bounce: 0 });
    }
    // the starburst: thin needles of coloured glass flying out from the hit
    var cx = x + w / 2, cy = y - h / 2;
    for (i = 0; i < 26; i++) {
      var aa2 = Math.random() * Math.PI * 2, sp2 = 6 + Math.random() * 9 * power;
      addPart({ k: 'spike', x: cx + Math.cos(aa2) * 6, y: cy + Math.sin(aa2) * h * 0.3, vx: Math.cos(aa2) * sp2, vy: Math.sin(aa2) * sp2 - 2,
        len: 10 + Math.random() * 18, col: Math.random() < 0.3 ? '#fff' : c.base, life: 16 + Math.random() * 14, a: 1 });
    }
    addPart({ k: 'ghost', x: x, y: y - h, w: w, h: h, life: 10, a: 0.9 });
    for (i = 0; i < 14; i++) {               // fine glitter
      addPart({ k: 'glint', x: x + Math.random() * w, y: y - Math.random() * h, vx: (Math.random() - 0.5) * 7, vy: -Math.random() * 6, life: 30 + Math.random() * 30, a: 1 });
    }
  }
  function woodBurst(x, y, w, h, log, n) {
    for (var i = 0; i < n; i++) {
      var big = i < (log ? 6 : 4);
      var len = big ? 14 + Math.random() * (log ? 26 : 16) : 4 + Math.random() * 10;
      var a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * (big ? 3.5 : 6);
      addPart({ k: 'wood', x: x + Math.random() * w, y: y - Math.random() * h, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3, r: Math.random() * 6,
        vr: (Math.random() - 0.5) * (big ? 0.25 : 0.6), len: len, th: big ? 5 + Math.random() * 4 : 1.5 + Math.random() * 2,
        col: Math.random() < 0.5 ? '#b8743a' : Math.random() < 0.5 ? '#8a4f22' : '#e0a764', life: 140 + Math.random() * 60, a: 1, bounce: 0 });
    }
    dust(x + w / 2, y - h / 2, 8, '#d9b48a');
  }
  function dust(x, y, n, col) {
    for (var i = 0; i < n; i++) addPart({ k: 'dust', x: x + (Math.random() - 0.5) * 30, y: y + (Math.random() - 0.5) * 10, vx: (Math.random() - 0.5) * 2.4, vy: -Math.random() * 1.2,
      s: 6 + Math.random() * 10, life: 35 + Math.random() * 25, a: 0.5, col: col || '#efe2cf' });
  }
  function floatText(x, y, txt, col) { floats.push({ x: x, y: y, txt: txt, col: col || '#fff', life: 55 }); }

  function handleEvents(S) {
    var ev = S.events; S.events = [];
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i], px = e.x / U, py = e.y / U;
      switch (e.e) {
        case 'fire': sfx('cannon'); cannonKick = 1; aim = { x: px, y: py }; shake = Math.max(shake, 3); break;
        case 'break': {
          var w = e.w / U, h = e.h / U, top = py;
          if (e.t === 'g') { shardBurst(px, top, w, h, GLASS[e.col], e.how === 'crush' ? 26 : 22, e.how === 'shot' ? 1.2 : 1); sfx('glass', e.how !== 'ball'); rings.push({ x: px + w / 2, y: top - h / 2, r: 6, life: 14 }); }
          else { woodBurst(px, top, w, h, e.t === 'l', e.t === 'l' ? 26 : 18); sfx('woodBreak', e.t === 'l'); }
          shake = Math.max(shake, e.t === 'l' ? 9 : e.how === 'crush' ? 7 : 5);
          floatText(px + w / 2, top - h / 2, '+' + e.pts, e.how === 'crush' ? '#ffe066' : '#fff');
          if (e.how === 'crush' && crushCool <= 0) { floatText(px + w / 2, top - h / 2 - 18, 'CRUSH!', '#ffe066'); crushCool = 25; }
          break;
        }
        case 'crack': {
          var cw = e.w / U;
          for (var j = 0; j < 6; j++) addPart({ k: 'wood', x: px + Math.random() * cw, y: py - Math.random() * e.h / U, vx: (Math.random() - 0.5) * 5, vy: -2 - Math.random() * 3,
            r: 0, vr: 0.4, len: 3 + Math.random() * 6, th: 1.5, col: '#e0a764', life: 60, a: 1, bounce: 0 });
          sfx('woodHit'); shake = Math.max(shake, 3);
          break;
        }
        case 'thud':
          if (e.ball) { sfx('ballBounce', e.v); break; }
          dust(px, py, e.v > 100 ? 7 : 3); sfx('thud', e.v, e.t); shake = Math.max(shake, Math.min(6, e.v / 30));
          break;
        case 'fan':
          sfx('fan'); flash = 0.25; floatText(px, py, 'BLOCKED', '#ffd0d0');
          for (j = 0; j < 8; j++) addPart({ k: 'glint', x: px, y: py, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8, life: 22, a: 1 });
          addPart({ k: 'ball', x: px, y: py, vx: (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 2), vy: -4, rad: 8, life: 120, a: 1 });
          break;
        case 'miss': addPart({ k: 'ballAway', x: px, y: py, s: 6, life: 30, a: 1 }); sfx('whoosh'); break;
        case 'clear': banner = { txt: 'SAAF!', sub: '+' + e.bonus, life: 110 }; sfx('clear'); confetti(); break;
        case 'tower': if (e.level > 1) { floatText(70, 120, '+' + e.add + ' balls', '#b8ffb0'); sfx('reload'); } break;
        case 'over': sfx('over'); break;
      }
    }
  }
  function confetti() {
    var cs = ['#ff3d55', '#ffc21a', '#2f8cff', '#9a4dff', '#3ddc84', '#fff'];
    for (var i = 0; i < 120; i++) addPart({ k: 'conf', x: 207 + (Math.random() - 0.5) * 60, y: 330, vx: (Math.random() - 0.5) * 14, vy: -6 - Math.random() * 9,
      r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.5, col: cs[i % cs.length], life: 140 + Math.random() * 40, a: 1 });
  }

  function tableRange() { return [207 - 196, 207 + 196]; }

  function stepParts() {
    var tr = tableRange(), floorY = FLOOR / U;
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life -= 1;
      if (p.k === 'dust') { p.x += p.vx; p.y += p.vy; p.s += 0.6; p.a *= 0.95; }
      else if (p.k === 'glint') { p.x += p.vx; p.y += p.vy; p.vy += 0.25; p.vx *= 0.96; }
      else if (p.k === 'ballAway') { p.s *= 0.9; p.y -= 2; }
      else if (p.k === 'spike') { p.x += p.vx; p.y += p.vy; p.vx *= 0.9; p.vy = p.vy * 0.9 + 0.3; }
      else if (p.k === 'ghost') { p.a *= 0.75; }
      else {
        p.vy += p.k === 'conf' ? 0.18 : 0.42; p.x += p.vx; p.y += p.vy;
        if (p.k === 'conf') { p.vx *= 0.98; p.vy = Math.min(p.vy, 3); }
        if (p.r !== undefined) p.r += p.vr;
        if (p.k !== 'conf' && p.vy > 0 && p.y >= floorY && p.y - p.vy < floorY + 1 && p.x > tr[0] && p.x < tr[1]) {
          p.y = floorY; p.vy = -p.vy * (p.bounce++ < 2 ? 0.35 : 0); p.vx *= 0.6; if (p.vr) p.vr *= 0.5;
          if (p.k === 'shard' && Math.random() < 0.15) addPart({ k: 'glint', x: p.x, y: p.y, vx: 0, vy: -1, life: 12, a: 1 });
        }
        if (p.y > H - 40 && p.k !== 'conf') { p.y = H - 40; p.vy = -p.vy * 0.25; p.vx *= 0.5; if (p.vr) p.vr *= 0.4; }
      }
      if (p.life < 30) p.a = Math.min(p.a, p.life / 30);
      if (p.life <= 0) parts.splice(i, 1);
    }
    for (i = floats.length - 1; i >= 0; i--) { floats[i].y -= 0.9; if (--floats[i].life <= 0) floats.splice(i, 1); }
    for (i = rings.length - 1; i >= 0; i--) { rings[i].r += 5; if (--rings[i].life <= 0) rings.splice(i, 1); }
    crushCool -= 1;
    shake *= 0.85; if (shake < 0.2) shake = 0;
    flash *= 0.85; cannonKick *= 0.82;
    if (banner && --banner.life <= 0) banner = null;
  }

  // ---------------------------------------------------------------- drawing
  var cv = document.getElementById('game'), ctx = cv.getContext('2d');
  var fit = { s: 1, ox: 0, oy: 0, dpr: 1 };
  function resize() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(window.innerWidth * dpr); cv.height = Math.round(window.innerHeight * dpr);
    var s = Math.min(cv.width / W, cv.height / H);
    fit = { s: s, ox: (cv.width - W * s) / 2, oy: (cv.height - H * s) / 2, dpr: dpr };
  }
  window.addEventListener('resize', resize); resize();

  var bgCache = null;
  function tree(b, x, y, s) {
    b.fillStyle = '#7a4a26'; b.fillRect(x - 5 * s, y - 10 * s, 10 * s, 50 * s);
    var cs = ['#e8742a', '#f39a32', '#d65a1c', '#ffb347'];
    var blobs = [[0, -40, 30], [-24, -26, 22], [24, -24, 24], [-12, -58, 20], [14, -56, 22], [0, -18, 20]];
    for (var i = 0; i < blobs.length; i++) {
      b.fillStyle = cs[i % cs.length];
      b.beginPath(); b.arc(x + blobs[i][0] * s, y + blobs[i][1] * s, blobs[i][2] * s, 0, 7); b.fill();
    }
    b.fillStyle = 'rgba(255,230,160,0.35)';
    b.beginPath(); b.arc(x - 8 * s, y - 52 * s, 10 * s, 0, 7); b.fill();
  }
  function drawBackground() {
    if (!bgCache) {
      bgCache = document.createElement('canvas'); bgCache.width = W * 2; bgCache.height = H * 2;
      var b = bgCache.getContext('2d'); b.scale(2, 2);
      var g = b.createLinearGradient(0, 0, 0, 230);
      g.addColorStop(0, '#4fa8f0'); g.addColorStop(1, '#cfeeff');
      b.fillStyle = g; b.fillRect(0, 0, W, H);
      b.fillStyle = 'rgba(255,255,255,0.9)';
      [[330, 52, 22], [370, 46, 16], [140, 92, 14], [170, 88, 10]].forEach(function (c) { b.beginPath(); b.arc(c[0], c[1], c[2], 0, 7); b.arc(c[0] + c[2], c[1] + 5, c[2] * 0.8, 0, 7); b.arc(c[0] - c[2], c[1] + 6, c[2] * 0.7, 0, 7); b.fill(); });
      b.fillStyle = '#8fb6c8';
      b.beginPath(); b.moveTo(0, 200); b.quadraticCurveTo(80, 160, 160, 190); b.quadraticCurveTo(260, 150, 330, 185); b.quadraticCurveTo(380, 170, 414, 180); b.lineTo(414, 230); b.lineTo(0, 230); b.fill();
      var gg = b.createLinearGradient(0, 190, 0, H);
      gg.addColorStop(0, '#9ed65a'); gg.addColorStop(0.35, '#6fbf3a'); gg.addColorStop(1, '#4e9e28');
      b.fillStyle = gg;
      b.beginPath(); b.moveTo(0, 225); b.quadraticCurveTo(120, 195, 230, 215); b.quadraticCurveTo(330, 230, 414, 205); b.lineTo(414, H); b.lineTo(0, H); b.fill();
      b.fillStyle = '#5ab0e0'; b.beginPath(); b.ellipse(300, 232, 60, 6, 0, 0, 7); b.fill();
      for (var i = 0; i < 26; i++) { b.fillStyle = Math.random() < 0.5 ? '#5aa82e' : '#86c94a'; b.beginPath(); b.ellipse(Math.random() * W, 250 + Math.random() * 450, 6, 2, 0, 0, 7); b.fill(); }
      tree(b, 22, 330, 1.1); tree(b, 392, 320, 1.0); tree(b, 70, 238, 0.55); tree(b, 350, 232, 0.5); tree(b, 200, 205, 0.35);
      b.fillStyle = '#ff8c1a'; b.beginPath(); b.ellipse(392, 372, 11, 8, 0, 0, 7); b.fill(); b.fillStyle = '#3c7a1e'; b.fillRect(391, 362, 2, 4);
      b.fillStyle = '#ff8c1a'; b.beginPath(); b.ellipse(14, 382, 9, 7, 0, 0, 7); b.fill();
      var dg = b.createRadialGradient(207, 575, 10, 207, 575, 150);
      dg.addColorStop(0, '#d9a467'); dg.addColorStop(0.8, '#c99257'); dg.addColorStop(1, 'rgba(201,146,87,0)');
      b.fillStyle = dg; b.beginPath(); b.ellipse(207, 575, 150, 40, 0, 0, 7); b.fill();
      b.fillStyle = 'rgba(120,80,40,0.35)';
      for (i = 0; i < 18; i++) { b.beginPath(); b.arc(100 + Math.random() * 214, 555 + Math.random() * 40, 1.5, 0, 7); b.fill(); }
    }
    ctx.drawImage(bgCache, 0, 0, W, H);
  }

  function rr(x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function drawTable() {
    var fy = FLOOR / U;
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(207, 590, 70, 12, 0, 0, 7); ctx.fill();
    var pg = ctx.createLinearGradient(196, 0, 218, 0);
    pg.addColorStop(0, '#b8641e'); pg.addColorStop(0.45, '#f0a24a'); pg.addColorStop(1, '#a8561a');
    ctx.fillStyle = pg; ctx.fillRect(198, fy + 12, 18, 560 - fy);
    ctx.fillStyle = '#7a2fd0'; ctx.fillRect(194, 556, 26, 8);
    ctx.fillStyle = '#f2b632'; ctx.beginPath(); ctx.moveTo(176, 588); ctx.lineTo(186, 562); ctx.lineTo(228, 562); ctx.lineTo(238, 588); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#7a2fd0'; ctx.beginPath(); ctx.moveTo(181, 584); ctx.lineTo(189, 566); ctx.lineTo(225, 566); ctx.lineTo(233, 584); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff3d6'; ctx.beginPath(); ctx.arc(207, 584, 9, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#5b22a8'; rr(11, fy + 2, 392, 13, 6); ctx.fill();
    var tg = ctx.createLinearGradient(0, fy - 2, 0, fy + 10);
    tg.addColorStop(0, '#c08cff'); tg.addColorStop(1, '#8b45e0');
    ctx.fillStyle = tg; rr(11, fy - 1, 392, 11, 5); ctx.fill();
  }

  function crackLines(x, y, w, h, n, seed) {
    ctx.strokeStyle = 'rgba(40,20,5,0.75)'; ctx.lineWidth = 1.4; ctx.beginPath();
    var r = seed;
    function rnd() { r = (r * 9301 + 49297) % 233280; return r / 233280; }
    for (var i = 0; i < n; i++) {
      var cx = x + w * (0.2 + rnd() * 0.6), cy = y + h * (0.2 + rnd() * 0.6);
      ctx.moveTo(cx, cy);
      for (var k = 0; k < 3; k++) { cx += (rnd() - 0.5) * w * 0.5; cy += (rnd() - 0.5) * h * 0.5; ctx.lineTo(cx, cy); }
    }
    ctx.stroke();
  }

  var jarCache = {};
  function jarSprite(w, h, ci) {
    var key = w + 'x' + h + 'c' + ci;
    if (jarCache[key]) return jarCache[key];
    var cvs = document.createElement('canvas'); cvs.width = w * 2; cvs.height = h * 2;
    var b = cvs.getContext('2d'); b.scale(2, 2);
    var c = GLASS[ci], save = ctx; ctx = b;
    // body: a glossy cylinder
    var g = b.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, c.dark); g.addColorStop(0.18, c.base); g.addColorStop(0.32, c.lite); g.addColorStop(0.42, c.base); g.addColorStop(0.85, c.base); g.addColorStop(1, c.dark);
    b.fillStyle = g; rr(1.5, 4, w - 3, h - 5, 10); b.fill();
    var sh = b.createLinearGradient(0, 4, 0, h);
    sh.addColorStop(0, 'rgba(255,255,255,0.18)'); sh.addColorStop(0.5, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.22)');
    b.fillStyle = sh; rr(1.5, 4, w - 3, h - 5, 10); b.fill();
    b.fillStyle = 'rgba(255,255,255,0.75)'; rr(w * 0.22, 14, 4.5, h - 28, 2.5); b.fill();
    b.fillStyle = 'rgba(255,255,255,0.35)'; rr(w * 0.72, 16, 3, h * 0.35, 1.5); b.fill();
    // lid: candy-striped band
    b.save(); rr(2, 0, w - 4, 9, 4); b.clip();
    b.fillStyle = '#fff'; b.fillRect(0, 0, w, 9);
    b.fillStyle = c.base;
    for (var i = -2; i < w / 5 + 2; i++) { b.beginPath(); b.moveTo(i * 5, 9); b.lineTo(i * 5 + 2.5, 9); b.lineTo(i * 5 + 6.5, 0); b.lineTo(i * 5 + 4, 0); b.closePath(); b.fill(); }
    b.fillStyle = 'rgba(0,0,0,0.15)'; b.fillRect(0, 6.5, w, 2.5);
    b.restore();
    ctx = save;
    jarCache[key] = cvs; return cvs;
  }
  function drawJar(x, y, w, h, ci) { ctx.drawImage(jarSprite(w, h, ci), x, y, w, h); }

  function drawCrate(x, y, w, h, hp, id) {
    ctx.fillStyle = '#6a3814'; rr(x + 1, y + 1, w - 2, h - 2, 5); ctx.fill();
    var g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#e09a52'); g.addColorStop(1, '#b06a2e');
    ctx.fillStyle = g; rr(x + 5, y + 5, w - 10, h - 10, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(90,45,15,0.45)'; ctx.lineWidth = 1;
    for (var i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x + 5, y + 5 + i * (h - 10) / 4); ctx.lineTo(x + w - 5, y + 5 + i * (h - 10) / 4); ctx.stroke(); }
    ctx.strokeStyle = '#8a4f22'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(x + 8, y + h - 8); ctx.lineTo(x + w - 8, y + 8); ctx.stroke();
    ctx.strokeStyle = '#d18a45'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + 8, y + h - 10); ctx.lineTo(x + w - 10, y + 8); ctx.stroke();
    ctx.fillStyle = 'rgba(255,220,170,0.5)'; ctx.fillRect(x + 5, y + 5, w - 10, 2);
    ctx.fillStyle = '#4a250c'; [[x + 4, y + 4], [x + w - 7, y + 4], [x + 4, y + h - 7], [x + w - 7, y + h - 7]].forEach(function (p) { ctx.beginPath(); ctx.arc(p[0] + 1.5, p[1] + 1.5, 1.6, 0, 7); ctx.fill(); });
    if (hp < 2) crackLines(x, y, w, h, 3, id * 77 + 13);
  }
  function drawLog(x, y, w, h, hp, id) {
    var m = 6, ly = y + m, lh = h - m * 2;
    var g = ctx.createLinearGradient(0, ly, 0, ly + lh);
    g.addColorStop(0, '#e09a52'); g.addColorStop(0.25, '#b8743a'); g.addColorStop(0.7, '#7a4219'); g.addColorStop(1, '#4e2a0e');
    ctx.fillStyle = g; rr(x + 2, ly, w - 4, lh, lh / 2); ctx.fill();
    ctx.strokeStyle = 'rgba(60,30,8,0.45)'; ctx.lineWidth = 1.3;
    for (var i = 0; i < 5; i++) { var yy = ly + 8 + i * (lh - 14) / 4; ctx.beginPath(); ctx.moveTo(x + 12 + (i * 7) % 15, yy); ctx.lineTo(x + w - 26 - (i * 11) % 18, yy); ctx.stroke(); }
    ctx.fillStyle = 'rgba(70,35,10,0.6)'; ctx.beginPath(); ctx.ellipse(x + w * 0.35, ly + lh * 0.55, 4, 2.5, 0, 0, 7); ctx.fill();
    var ex = x + w - 2 - lh * 0.3;
    ctx.fillStyle = '#f0c48a'; ctx.beginPath(); ctx.ellipse(ex, ly + lh / 2, lh * 0.3, lh / 2 - 1, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#b8743a'; ctx.lineWidth = 1;
    for (i = 1; i < 4; i++) { ctx.beginPath(); ctx.ellipse(ex, ly + lh / 2, lh * 0.3 * i / 4, (lh / 2 - 1) * i / 4, 0, 0, 7); ctx.stroke(); }
    ctx.strokeStyle = '#7a4219'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(ex, ly + lh / 2, lh * 0.3, lh / 2 - 1, 0, 0, 7); ctx.stroke();
    if (hp < 3) crackLines(x, y + 6, w, h - 12, hp === 2 ? 2 : 4, id * 31 + 7);
  }

  function drawBlocks(S) {
    for (var i = 0; i < S.blocks.length; i++) {
      var b = S.blocks[i], x = b.x / U, w = b.w / U, h = b.h / U, y = b.y / U - h;
      if (b.t === 'g') drawJar(x, y, w, h, b.col);
      else if (b.t === 'c') drawCrate(x, y, w, h, b.hp, b.id);
      else drawLog(x, y, w, h, b.hp, b.id);
    }
  }

  function drawFan(S) {
    if (!S.fan) return;
    var cx = CX / U, cy = FAN_CY / U;
    // striped hanging pole
    ctx.save(); ctx.beginPath(); ctx.rect(cx - 4, 0, 8, cy); ctx.clip();
    ctx.fillStyle = '#ffc21a'; ctx.fillRect(cx - 4, 0, 8, cy);
    ctx.fillStyle = '#9a4dff';
    for (var y = -10; y < cy; y += 14) { ctx.beginPath(); ctx.moveTo(cx - 4, y); ctx.lineTo(cx + 4, y + 7); ctx.lineTo(cx + 4, y + 13); ctx.lineTo(cx - 4, y + 6); ctx.fill(); }
    ctx.restore();
    ctx.save(); ctx.translate(cx, cy);
    ctx.rotate(S.fan.ang / 256 * Math.PI * 2);
    for (var k = 0; k < 4; k++) {
      ctx.save(); ctx.rotate(k * Math.PI / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.moveTo(10, -7 + 5); ctx.lineTo(FAN_LEN - 10, -FAN_HALF + 5); ctx.quadraticCurveTo(FAN_LEN + 4, 5, FAN_LEN - 10, FAN_HALF + 5); ctx.lineTo(10, 7 + 5); ctx.fill();
      var g = ctx.createLinearGradient(0, -FAN_HALF, 0, FAN_HALF);
      g.addColorStop(0, '#ffe680'); g.addColorStop(0.5, '#ffc21a'); g.addColorStop(1, '#d68f00');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(10, -7); ctx.lineTo(FAN_LEN - 10, -FAN_HALF); ctx.quadraticCurveTo(FAN_LEN + 4, 0, FAN_LEN - 10, FAN_HALF); ctx.lineTo(10, 7); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(150,90,0,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(26, -2); ctx.lineTo(FAN_LEN - 26, -4); ctx.moveTo(26, 3); ctx.lineTo(FAN_LEN - 26, 5); ctx.stroke();
      ctx.fillStyle = '#9a4dff'; ctx.beginPath(); ctx.moveTo(FAN_LEN - 20, -FAN_HALF); ctx.lineTo(FAN_LEN - 10, -FAN_HALF); ctx.quadraticCurveTo(FAN_LEN + 4, 0, FAN_LEN - 10, FAN_HALF); ctx.lineTo(FAN_LEN - 20, FAN_HALF); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(FAN_LEN - 30, 0, 2.5, 0, 7); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    ctx.fillStyle = '#f2b632'; ctx.beginPath(); ctx.arc(cx, cy, FAN_HUB, 0, 7); ctx.fill();
    ctx.fillStyle = '#7a2fd0'; ctx.beginPath(); ctx.arc(cx, cy, FAN_HUB - 5, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffd34d';
    ctx.beginPath(); ctx.moveTo(cx - 8, cy + 5); ctx.lineTo(cx - 9, cy - 5); ctx.lineTo(cx - 4, cy - 1); ctx.lineTo(cx, cy - 7); ctx.lineTo(cx + 4, cy - 1); ctx.lineTo(cx + 9, cy - 5); ctx.lineTo(cx + 8, cy + 5); ctx.fill();
  }

  function drawBall(x, y, r) {
    var g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, '#ffb0a0'); g.addColorStop(0.35, '#f23a3a'); g.addColorStop(1, '#a8101e');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.clip();
    ctx.fillStyle = '#ffd34d'; ctx.beginPath();
    var zz = 6;
    ctx.moveTo(x - r, y - r * 0.15);
    for (var i = 0; i <= zz; i++) ctx.lineTo(x - r + i * 2 * r / zz, y + (i % 2 ? -r * 0.4 : -r * 0.1));
    for (i = zz; i >= 0; i--) ctx.lineTo(x - r + i * 2 * r / zz, y + (i % 2 ? r * 0.05 : r * 0.35));
    ctx.fill(); ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.arc(x - r * 0.4, y - r * 0.45, r * 0.22, 0, 7); ctx.fill();
  }

  function drawFlights(S, frac) {
    var sx = 207, sy = 655;
    for (var i = 0; i < S.flights.length; i++) {
      var f = S.flights[i], t = Math.min(1, (f.t + frac) / FLIGHT);
      var tx = f.x / U, ty = f.y / U;
      var x = sx + (tx - sx) * t, y = sy + (ty - sy) * t - Math.sin(t * Math.PI) * 60;
      var r = 22 * (1 - t) + 8 * t;
      ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.beginPath(); ctx.ellipse(x, sy + (ty - sy) * t + 10, r, r * 0.3, 0, 0, 7); ctx.fill();
      drawBall(x, y, r);
    }
    for (i = 0; i < S.loose.length; i++) drawBall(S.loose[i].x / U, S.loose[i].y / U, 8);
  }

  function drawCannon() {
    var bx = 207, by = 690;
    ctx.fillStyle = '#7a2fd0'; ctx.beginPath(); ctx.ellipse(bx, H + 40, 250, 120, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#ffc21a'; ctx.beginPath(); ctx.ellipse(bx, H + 40, 236, 110, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#f7ead2'; ctx.beginPath(); ctx.ellipse(bx, H + 40, 222, 100, 0, Math.PI, 0); ctx.fill();
    ctx.strokeStyle = 'rgba(180,140,90,0.35)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(bx, H + 40, 170, 70, 0, Math.PI, 0); ctx.stroke();
    var ang = Math.atan2(aim.y - by, aim.x - bx) + Math.PI / 2;
    ang = Math.max(-0.6, Math.min(0.6, ang));
    ctx.save(); ctx.translate(bx, by); ctx.rotate(ang); ctx.translate(0, cannonKick * 12);
    var g = ctx.createLinearGradient(-30, 0, 30, 0);
    g.addColorStop(0, '#1a3f9e'); g.addColorStop(0.4, '#3d7bff'); g.addColorStop(1, '#16348a');
    ctx.fillStyle = g; rr(-27, -78, 54, 70, 16); ctx.fill();
    ctx.fillStyle = '#f2b632'; rr(-31, -84, 62, 16, 8); ctx.fill();
    ctx.fillStyle = '#2a0a12'; ctx.beginPath(); ctx.ellipse(0, -80, 20, 6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffd34d';
    ctx.beginPath(); ctx.moveTo(-10, -42); ctx.lineTo(-12, -54); ctx.lineTo(-5, -48); ctx.lineTo(0, -57); ctx.lineTo(5, -48); ctx.lineTo(12, -54); ctx.lineTo(10, -42); ctx.fill();
    var rg = ctx.createLinearGradient(-40, 0, 40, 0);
    rg.addColorStop(0, '#8a1020'); rg.addColorStop(0.4, '#ec3a4f'); rg.addColorStop(1, '#7a0c1a');
    ctx.fillStyle = rg; rr(-38, -26, 76, 40, 18); ctx.fill();
    ctx.fillStyle = '#f2b632'; rr(-38, -14, 76, 6, 3); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#2f6fe0'; rr(bx - 62, by + 4, 22, 46, 10); ctx.fill(); rr(bx + 40, by + 4, 22, 46, 10); ctx.fill();
    var bg = ctx.createRadialGradient(bx - 10, by + 20, 5, bx, by + 30, 46);
    bg.addColorStop(0, '#ff5a6a'); bg.addColorStop(1, '#a8101e');
    ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(bx, by + 40, 44, Math.PI, 0); ctx.fill();
    if (cannonKick > 0.3) {
      ctx.save(); ctx.translate(bx, by); ctx.rotate(ang);
      ctx.globalAlpha = (cannonKick - 0.3) * 1.4;
      ctx.fillStyle = '#fff2a8'; ctx.beginPath(); ctx.arc(0, -100, 26 * cannonKick, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.arc(0, -96, 16 * cannonKick, 0, 7); ctx.fill();
      ctx.restore(); ctx.globalAlpha = 1;
    }
  }

  function drawParts() {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      ctx.globalAlpha = Math.max(0, p.a);
      if (p.k === 'shard') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.col; ctx.beginPath(); ctx.moveTo(p.pts[0], p.pts[1]);
        for (var j = 2; j < p.pts.length; j += 2) ctx.lineTo(p.pts[j], p.pts[j + 1]);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.8; ctx.stroke();
        ctx.restore();
      } else if (p.k === 'wood') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.col; ctx.fillRect(-p.len / 2, -p.th / 2, p.len, p.th);
        if (p.th > 4) { ctx.fillStyle = 'rgba(60,30,8,0.35)'; ctx.fillRect(-p.len / 2, p.th / 2 - 1.5, p.len, 1.5); }
        ctx.restore();
      } else if (p.k === 'spike') {
        var sl = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1, ux = p.vx / sl, uy = p.vy / sl;
        ctx.fillStyle = p.col; ctx.beginPath();
        ctx.moveTo(p.x + ux * p.len * 0.5, p.y + uy * p.len * 0.5);
        ctx.lineTo(p.x - ux * p.len * 0.5 - uy * 2, p.y - uy * p.len * 0.5 + ux * 2);
        ctx.lineTo(p.x - ux * p.len * 0.5 + uy * 2, p.y - uy * p.len * 0.5 - ux * 2);
        ctx.closePath(); ctx.fill();
      } else if (p.k === 'ghost') {
        ctx.fillStyle = '#fff'; rr(p.x + 2, p.y + 2, p.w - 4, p.h - 4, 10); ctx.fill();
      } else if (p.k === 'glint') {
        ctx.fillStyle = '#fff'; ctx.fillRect(p.x - 1, p.y - 1, 2.5, 2.5);
      } else if (p.k === 'dust') {
        ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, 7); ctx.fill();
      } else if (p.k === 'conf') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.col; ctx.fillRect(-4, -2, 8, 4); ctx.restore();
      } else if (p.k === 'ball') {
        drawBall(p.x, p.y, p.rad);
      } else if (p.k === 'ballAway') {
        drawBall(p.x, p.y, Math.max(1, p.s));
      }
    }
    ctx.globalAlpha = 1;
    for (i = 0; i < rings.length; i++) {
      var g = rings[i];
      ctx.globalAlpha = g.life / 14; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function txt(s, x, y, size, col, align, stroke) {
    ctx.font = '900 ' + size + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
    if (stroke !== false) { ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, size / 5); ctx.strokeStyle = 'rgba(40,10,60,0.85)'; ctx.strokeText(s, x, y); }
    ctx.fillStyle = col || '#fff'; ctx.fillText(s, x, y);
  }

  function drawHud(S) {
    ctx.fillStyle = '#b3132c'; rr(12, 14, 64, 58, 12); ctx.fill();
    ctx.fillStyle = '#fff'; rr(17, 30, 54, 37, 9); ctx.fill();
    txt('BALLS', 44, 23, 10, '#fff', 'center', false);
    txt(String(S.balls), 44, 49, 24, S.balls <= 3 ? '#e8384f' : '#4a1d85', 'center', false);
    txt(String(S.score), 207, 40, 30, '#fff');
    ctx.fillStyle = 'rgba(40,10,60,0.55)'; rr(336, 22, 66, 32, 16); ctx.fill();
    txt('TOWER ' + S.level, 369, 38, 12, '#fff', 'center', false);
    for (var i = 0; i < floats.length; i++) {
      var f = floats[i];
      ctx.globalAlpha = Math.min(1, f.life / 20);
      txt(f.txt, f.x, f.y, 17, f.col);
    }
    ctx.globalAlpha = 1;
    if (banner) {
      var k = Math.min(1, (110 - banner.life) / 10);
      ctx.save(); ctx.translate(207, 250); ctx.scale(0.6 + 0.4 * k, 0.6 + 0.4 * k);
      txt(banner.txt, 0, 0, 56, '#ffe066'); txt(banner.sub, 0, 46, 26, '#fff');
      ctx.restore();
    }
  }

  function drawOver(S) {
    ctx.fillStyle = 'rgba(20,6,40,0.72)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#b3132c'; rr(47, 220, 320, 270, 22); ctx.fill();
    ctx.fillStyle = '#fff7e8'; rr(59, 268, 296, 140, 16); ctx.fill();
    txt('BALLS KHATAM!', 207, 245, 26, '#fff');
    txt('SCORE', 207, 292, 16, '#b3132c', 'center', false);
    txt(String(S.score), 207, 332, 44, '#4a1d85', 'center', false);
    txt('Towers cleared: ' + (S.level - 1), 207, 384, 15, '#7a2fd0', 'center', false);
    ctx.fillStyle = '#3ddc84'; rr(97, 422, 220, 52, 26); ctx.fill();
    txt('PLAY AGAIN', 207, 448, 22, '#fff');
  }

  function drawMenu() {
    ctx.fillStyle = 'rgba(20,6,40,0.55)'; ctx.fillRect(0, 0, W, H);
    txt('KAANCH', 207, 230, 64, '#9fd0ff');
    txt('TOD', 207, 292, 72, '#ffc21a');
    txt('Tap the tower to fire.', 207, 372, 18, '#fff');
    txt('Smash glass, split the wood,', 207, 398, 16, '#fff');
    txt('clear the table for more balls.', 207, 420, 16, '#fff');
    ctx.fillStyle = '#3ddc84'; rr(107, 470, 200, 56, 28); ctx.fill();
    txt('PLAY', 207, 498, 26, '#fff');
  }

  function render(S, frac) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1d7fc4'; ctx.fillRect(0, 0, cv.width, cv.height);
    var sx = shake ? (Math.random() - 0.5) * shake : 0, sy = shake ? (Math.random() - 0.5) * shake : 0;
    ctx.setTransform(fit.s, 0, 0, fit.s, fit.ox + sx * fit.s, fit.oy + sy * fit.s);
    ctx.save(); ctx.beginPath(); ctx.rect(-20, -20, W + 40, H + 40); ctx.clip();
    drawBackground();
    drawTable();
    drawBlocks(S);
    drawParts();
    drawFan(S);
    drawFlights(S, frac);
    drawCannon();
    if (flash > 0.02) { ctx.fillStyle = 'rgba(255,255,255,' + flash + ')'; ctx.fillRect(0, 0, W, H); }
    drawHud(S);
    if (mode === 'menu') drawMenu();
    if (mode === 'over') drawOver(S);
    ctx.restore();
  }

  // ---------------------------------------------------------------- loop + input
  var params = new URLSearchParams(location.search);
  var seedArg = params.get('seed');
  function newSeed() { return seedArg ? (parseInt(seedArg, 10) >>> 0) : ((Math.random() * 4294967296) >>> 0); }
  var S = initSim(newSeed());
  S.events = [];
  var mode = 'menu', acc = 0, last = null, STEP = 1000 / 60;

  function toDesign(ev) {
    var r = cv.getBoundingClientRect();
    var px = (ev.clientX - r.left) * fit.dpr, py = (ev.clientY - r.top) * fit.dpr;
    return { x: (px - fit.ox) / fit.s, y: (py - fit.oy) / fit.s };
  }
  cv.addEventListener('pointerdown', function (ev) {
    if (!ev.isPrimary) return;
    ev.preventDefault();
    audioInit();
    var p = toDesign(ev);
    if (mode === 'menu') { mode = 'play'; return; }
    if (mode === 'over') {
      if (p.y > 410 && p.y < 490) { S = initSim(newSeed()); S.events = []; parts = []; floats = []; mode = 'play'; }
      return;
    }
    shoot(S, Math.round(p.x * U), Math.round(p.y * U));
  });

  function frame(now) {
    if (last === null) last = now;
    acc += Math.min(now - last, STEP * 3); last = now;
    while (acc >= STEP) {
      acc -= STEP;
      if (mode === 'play') {
        stepSim(S);
        handleEvents(S);
        if (S.phase === 'over') mode = 'over';
      }
      stepParts();
    }
    render(S, acc / STEP);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__kt = { get S() { return S; }, initSim: initSim, stepSim: stepSim, shoot: shoot, U: U };
})();
