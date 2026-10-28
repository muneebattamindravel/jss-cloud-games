/* Kaanch Tod rules: everything that decides the score. Fixed 1/60 s steps,
   integer positions in 1/16 px of a 414x736 design plane, sine table, seeded
   index-addressed hash. The 3D view only reads this. */
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

  window.KTRules = { initSim: initSim, stepSim: stepSim, shoot: shoot, isin: isin, icos: icos,
    W: W, H: H, U: U, CELL: CELL, BH: BH, FLOOR: FLOOR, CX: CX, FLIGHT: FLIGHT, BALL_R: BALL_R,
    FAN_CY: FAN_CY, FAN_LEN: FAN_LEN, FAN_HALF: FAN_HALF, FAN_HUB: FAN_HUB };
})();
