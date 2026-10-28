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
  var CELL = 40 * U, BH = 44 * U;            // block cell width / height
  var FLOOR = 560 * U;                       // table top
  var CX = 207 * U;                          // centre line
  var FLIGHT = 22;                           // steps from cannon to tower
  var GRAV = 6, VMAX = 240, CRUSH_V = 70, LAND_V = 30;
  var BALL_G = 5, BALL_R = 7 * U;
  var FAN_CY = 330 * U, FAN_LEN = 128, FAN_HALF = 13, FAN_HUB = 20;
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
    var cols = Math.min(8, 5 + (L >> 1));
    var hmax = Math.min(9, 3 + L);
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
        var col = hash(sd, L, 500 + (c >> 1) + (r >> 1) * 7) % 4;
        blocks.push({ id: id++, t: t, x: left + c * CELL, w: CELL, h: BH, y: y, vy: 0, hp: HP[t], col: col });
      }
    }
    S.nextId = id;
    S.blocks = blocks;
    var cost = 0;
    for (var i = 0; i < blocks.length; i++) cost += blocks[i].t === 'g' ? 10 : blocks[i].t === 'c' ? 24 : 36;
    var add = Math.max(6, ((cost + 29) / 30) | 0) + (L === 1 ? 4 : 0);
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
    if (y > FLOOR + 30 * U || y < 60 * U || x < 0 || x > W * U) return false;
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
    if (onTable && k.vy > 0 && k.y >= FLOOR - BALL_R && oy < FLOOR - BALL_R + U && k.x > CX - 190 * U && k.x < CX + 190 * U) {
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
    { base: '#9a4dff', lite: '#d8b8ff', dark: '#5d1fc0' }
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
    for (i = 0; i < 10; i++) {               // fine glitter
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
          addPart({ k: 'ball', x: px, y: py, vx: (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 2), vy: -4, r: 6, life: 120, a: 1 });
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

  function tableRange() { return [207 - 190, 207 + 190]; }

  function stepParts() {
    var tr = tableRange(), floorY = FLOOR / U;
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life -= 1;
      if (p.k === 'dust') { p.x += p.vx; p.y += p.vy; p.s += 0.6; p.a *= 0.95; }
      else if (p.k === 'glint') { p.x += p.vx; p.y += p.vy; p.vy += 0.25; p.vx *= 0.96; }
      else if (p.k === 'ballAway') { p.s *= 0.9; p.y -= 2; }
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
  function drawBackground() {
    if (!bgCache) {
      bgCache = document.createElement('canvas'); bgCache.width = W * 2; bgCache.height = H * 2;
      var b = bgCache.getContext('2d'); b.scale(2, 2);
      var g = b.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#5fb8ff'); g.addColorStop(0.42, '#bfe6ff'); g.addColorStop(0.43, '#2f9be0'); g.addColorStop(0.6, '#1d7fc4'); g.addColorStop(1, '#0f5a96');
      b.fillStyle = g; b.fillRect(0, 0, W, H);
      b.fillStyle = 'rgba(255,255,255,0.85)';
      [[60, 70, 30], [100, 62, 22], [320, 95, 26], [350, 88, 18], [250, 50, 16]].forEach(function (c) { b.beginPath(); b.arc(c[0], c[1], c[2], 0, 7); b.arc(c[0] + c[2], c[1] + 6, c[2] * 0.8, 0, 7); b.arc(c[0] - c[2], c[1] + 8, c[2] * 0.7, 0, 7); b.fill(); });
      b.fillStyle = '#7fb7d9';
      b.beginPath(); b.moveTo(0, 316); b.lineTo(40, 270); b.lineTo(90, 300); b.lineTo(150, 255); b.lineTo(210, 300); b.lineTo(260, 268); b.lineTo(330, 292); b.lineTo(414, 260); b.lineTo(414, 316); b.fill();
      b.fillStyle = 'rgba(255,255,255,0.18)';
      for (var i = 0; i < 40; i++) { var y = 330 + Math.random() * 380; b.fillRect(Math.random() * W, y, 10 + Math.random() * 40, 2); }
      b.fillStyle = '#e8c88f';
      b.beginPath(); b.ellipse(207, 655, 150, 26, 0, 0, 7); b.fill();
    }
    ctx.drawImage(bgCache, 0, 0, W, H);
  }

  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function drawTable() {
    var fy = FLOOR / U;
    ctx.fillStyle = '#6b2fb3'; ctx.fillRect(196, fy + 12, 22, 640 - fy);
    ctx.fillStyle = '#f2b632'; ctx.fillRect(196, fy + 12, 22, 6); ctx.fillRect(190, 628, 34, 10);
    ctx.fillStyle = '#4a1d85'; rr(17, fy + 3, 380, 14, 6); ctx.fill();
    ctx.fillStyle = '#8b45e0'; rr(17, fy, 380, 10, 5); ctx.fill();
    ctx.fillStyle = '#f2b632'; ctx.fillRect(22, fy + 10, 370, 3);
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

  function drawJar(x, y, w, h, c) {
    var g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, c.dark); g.addColorStop(0.25, c.base); g.addColorStop(0.45, c.lite); g.addColorStop(0.6, c.base); g.addColorStop(1, c.dark);
    ctx.globalAlpha = 0.93;
    ctx.fillStyle = g; rr(x + 2, y + 5, w - 4, h - 6, 7); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; rr(x + 7, y + 10, 4, h - 18, 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; rr(x + w - 11, y + 12, 3, h - 24, 2); ctx.fill();
    ctx.fillStyle = c.dark; rr(x + 3, y + 1, w - 6, 7, 3); ctx.fill();
    ctx.fillStyle = '#fff';
    for (var i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(x + 9 + i * (w - 18) / 3, y + 4.5, 1.6, 0, 7); ctx.fill(); }
  }
  function drawCrate(x, y, w, h, hp, id) {
    ctx.fillStyle = '#7a4219'; rr(x + 1, y + 1, w - 2, h - 2, 3); ctx.fill();
    ctx.fillStyle = '#c47a3a'; ctx.fillRect(x + 5, y + 5, w - 10, h - 10);
    ctx.fillStyle = '#a8612b'; ctx.fillRect(x + 5, y + h / 2 - 1, w - 10, 2);
    ctx.strokeStyle = '#8a4f22'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x + 7, y + h - 7); ctx.lineTo(x + w - 7, y + 7); ctx.stroke();
    ctx.fillStyle = '#e7a35c'; ctx.fillRect(x + 5, y + 5, w - 10, 2);
    ctx.fillStyle = '#5b3011'; [[x + 5, y + 5], [x + w - 7, y + 5], [x + 5, y + h - 7], [x + w - 7, y + h - 7]].forEach(function (p) { ctx.fillRect(p[0], p[1], 2, 2); });
    if (hp < 2) crackLines(x, y, w, h, 2, id * 77 + 13);
  }
  function drawLog(x, y, w, h, hp, id) {
    var m = 5, ly = y + m, lh = h - m * 2;
    var g = ctx.createLinearGradient(0, ly, 0, ly + lh);
    g.addColorStop(0, '#d18a45'); g.addColorStop(0.3, '#a8612b'); g.addColorStop(0.75, '#7a4219'); g.addColorStop(1, '#5b3011');
    ctx.fillStyle = g; rr(x + 2, ly, w - 4, lh, lh / 2); ctx.fill();
    ctx.strokeStyle = 'rgba(70,35,10,0.5)'; ctx.lineWidth = 1.2;
    for (var i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x + 14 + i * 3, ly + 7 + i * 7); ctx.lineTo(x + w - 20 - i * 5, ly + 7 + i * 7); ctx.stroke(); }
    ctx.fillStyle = '#e8b679'; ctx.beginPath(); ctx.ellipse(x + w - 2 - lh * 0.28, ly + lh / 2, lh * 0.28, lh / 2 - 1, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#a8612b'; ctx.lineWidth = 1;
    for (i = 1; i < 4; i++) { ctx.beginPath(); ctx.ellipse(x + w - 2 - lh * 0.28, ly + lh / 2, lh * 0.28 * i / 4, (lh / 2 - 1) * i / 4, 0, 0, 7); ctx.stroke(); }
    if (hp < 3) crackLines(x, y + 4, w, h - 8, hp === 2 ? 2 : 4, id * 31 + 7);
  }

  function drawBlocks(S) {
    for (var i = 0; i < S.blocks.length; i++) {
      var b = S.blocks[i], x = b.x / U, w = b.w / U, h = b.h / U, y = b.y / U - h;
      if (b.t === 'g') drawJar(x, y, w, h, GLASS[b.col]);
      else if (b.t === 'c') drawCrate(x, y, w, h, b.hp, b.id);
      else drawLog(x, y, w, h, b.hp, b.id);
    }
  }

  function drawFan(S) {
    if (!S.fan) return;
    var cx = CX / U, cy = FAN_CY / U;
    ctx.save(); ctx.translate(cx, cy);
    ctx.rotate(S.fan.ang / 256 * Math.PI * 2);
    for (var k = 0; k < 4; k++) {
      ctx.save(); ctx.rotate(k * Math.PI / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; rr(4, -FAN_HALF + 4, FAN_LEN, FAN_HALF * 2, FAN_HALF); ctx.fill();
      var g = ctx.createLinearGradient(0, -FAN_HALF, 0, FAN_HALF);
      g.addColorStop(0, '#ffe27a'); g.addColorStop(0.5, '#ffc21a'); g.addColorStop(1, '#d68f00');
      ctx.fillStyle = g; rr(0, -FAN_HALF, FAN_LEN, FAN_HALF * 2, FAN_HALF); ctx.fill();
      ctx.fillStyle = '#9a4dff'; rr(FAN_LEN - 18, -FAN_HALF, 18, FAN_HALF * 2, FAN_HALF); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fillRect(22, -FAN_HALF + 4, FAN_LEN - 50, 3);
      ctx.restore();
    }
    ctx.restore();
    ctx.fillStyle = '#7a2fd0'; ctx.beginPath(); ctx.arc(cx, cy, FAN_HUB, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffc21a'; ctx.beginPath(); ctx.arc(cx, cy, FAN_HUB - 6, 0, 7); ctx.fill();
  }

  function drawBall(x, y, r) {
    var g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, '#fff'); g.addColorStop(0.3, '#ff7a5a'); g.addColorStop(1, '#b3132c');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = Math.max(1, r * 0.25);
    ctx.beginPath(); ctx.arc(x, y, r * 0.62, -0.6, 0.9); ctx.stroke();
  }

  function drawFlights(S, frac) {
    var sx = 207, sy = 665;
    for (var i = 0; i < S.flights.length; i++) {
      var f = S.flights[i], t = Math.min(1, (f.t + frac) / FLIGHT);
      var tx = f.x / U, ty = f.y / U;
      var x = sx + (tx - sx) * t, y = sy + (ty - sy) * t - Math.sin(t * Math.PI) * 70;
      var r = 15 * (1 - t) + 7 * t;
      ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.beginPath(); ctx.ellipse(x, sy + (ty - sy) * t + 8, r, r * 0.3, 0, 0, 7); ctx.fill();
      drawBall(x, y, r);
    }
    for (i = 0; i < S.loose.length; i++) drawBall(S.loose[i].x / U, S.loose[i].y / U, 7);
  }

  function drawCannon() {
    var bx = 207, by = 690;
    ctx.fillStyle = '#7a2fd0'; ctx.beginPath(); ctx.ellipse(bx, H + 30, 230, 110, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#ffc21a'; ctx.beginPath(); ctx.ellipse(bx, H + 30, 200, 90, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#f4e3c3'; ctx.beginPath(); ctx.ellipse(bx, H + 30, 186, 80, 0, Math.PI, 0); ctx.fill();
    var ang = Math.atan2(aim.y - by, aim.x - bx) + Math.PI / 2;
    ang = Math.max(-0.7, Math.min(0.7, ang));
    ctx.save(); ctx.translate(bx, by); ctx.rotate(ang); ctx.translate(0, cannonKick * 10);
    var g = ctx.createLinearGradient(-26, 0, 26, 0);
    g.addColorStop(0, '#8a1020'); g.addColorStop(0.4, '#e8384f'); g.addColorStop(1, '#7a0c1a');
    ctx.fillStyle = g; rr(-24, -58, 48, 70, 14); ctx.fill();
    ctx.fillStyle = '#2f6fe0'; rr(-28, -64, 56, 14, 6); ctx.fill();
    ctx.fillStyle = '#ffc21a'; rr(-28, -30, 56, 7, 3); ctx.fill();
    ctx.fillStyle = '#3a0a10'; ctx.beginPath(); ctx.ellipse(0, -60, 17, 5, 0, 0, 7); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#2f6fe0'; ctx.beginPath(); ctx.arc(bx - 34, by + 22, 16, 0, 7); ctx.arc(bx + 34, by + 22, 16, 0, 7); ctx.fill();
    ctx.fillStyle = '#c41e36'; ctx.beginPath(); ctx.arc(bx, by + 24, 34, Math.PI, 0); ctx.fill();
    if (cannonKick > 0.3) {
      ctx.save(); ctx.translate(bx, by); ctx.rotate(ang);
      ctx.globalAlpha = (cannonKick - 0.3) * 1.4; ctx.fillStyle = '#ffe27a';
      ctx.beginPath(); ctx.arc(0, -78, 20 * cannonKick, 0, 7); ctx.fill();
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
      } else if (p.k === 'glint') {
        ctx.fillStyle = '#fff'; ctx.fillRect(p.x - 1, p.y - 1, 2.5, 2.5);
      } else if (p.k === 'dust') {
        ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, 7); ctx.fill();
      } else if (p.k === 'conf') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.col; ctx.fillRect(-4, -2, 8, 4); ctx.restore();
      } else if (p.k === 'ball') {
        drawBall(p.x, p.y, p.r);
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
