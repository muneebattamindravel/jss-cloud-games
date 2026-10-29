/* Smash It rules (v2): everything that decides the score.
   Real rigid-body physics on Rapier's deterministic build, stepped at a fixed
   1/60 s. Inputs are integers (target point on the tower face in 1/100 world
   units) applied on step numbers. Layouts and colours come from a seeded,
   index-addressed hash. No engine trig: the fan uses an integer sine table.
   The 3D view only reads this. */
(function (root) {
  'use strict';
  var RULES_VERSION = 2;
  var DT = 1 / 60, GRAVITY = -20;
  var CELL = 1, ROW = 1.3, DEPTH = 0.98, FRONT = 0.5;
  var PLANK_H = 0.8;
  var BALL_R = 0.3, BALL_DENSITY = 10, BALL_SPEED = 44, FLIGHT_STEPS = 18;
  var CANNON = { x: 0, y: -1.2, z: 13 };
  var FALL_Y = -2.6;
  var JAR_BREAK_F = 800, CRUSH_F = 1e9;
  var SHOT_GAP = 10, PIERCE = 5;
  var BOMB_R = 2.6, BOMB_PUSH = 9;
  var SHIELD_W = 2.6, SHIELD_H = 0.5, SHIELD_Z = FRONT + 0.7;
  var FAN_LEN = 3.1, FAN_HALF = 0.16, FAN_Y = 5.2, FAN_Z = FRONT + 0.95;
  var PTS = { jar: 10, brick: 15, crate: 25, plank: 40, bomb: 30, ice: 20 };
  var FALL_PTS = { jar: 10, brick: 15, crate: 15, plank: 20, bomb: 15, ice: 10 };
  var HP = { jar: 1, brick: 0, crate: 2, plank: 3, bomb: 1, ice: 2 };
  var SINQ = [0,6136,12272,18407,24541,30675,36807,42938,49068,55195,61321,67444,73565,79682,85797,91909,98017,104122,110222,116319,122411,128498,134581,140658,146730,152797,158858,164913,170962,177004,183040,189069,195090,201105,207111,213110,219101,225084,231058,237024,242980,248928,254866,260794,266713,272621,278520,284408,290285,296151,302006,307850,313682,319502,325310,331106,336890,342661,348419,354164,359895,365613,371317,377007,382683,388345,393992,399624,405241,410843,416430,422000,427555,433094,438616,444122,449611,455084,460539,465976,471397,476799,482184,487550,492898,498228,503538,508830,514103,519356,524590,529804,534998,540171,545325,550458,555570,560662,565732,570781,575808,580814,585798,590760,595699,600616,605511,610383,615232,620057,624859,629638,634393,639124,643832,648514,653173,657807,662416,667000,671559,676093,680601,685084,689541,693971,698376,702755,707107,711432,715731,720003,724247,728464,732654,736817,740951,745058,749136,753187,757209,761202,765167,769103,773010,776888,780737,784557,788346,792107,795837,799537,803208,806848,810457,814036,817585,821103,824589,828045,831470,834863,838225,841555,844854,848120,851355,854558,857729,860867,863973,867046,870087,873095,876070,879012,881921,884797,887640,890449,893224,895966,898674,901349,903989,906596,909168,911706,914210,916679,919114,921514,923880,926210,928506,930767,932993,935184,937339,939459,941544,943593,945607,947586,949528,951435,953306,955141,956940,958703,960431,962121,963776,965394,966976,968522,970031,971504,972940,974339,975702,977028,978317,979570,980785,981964,983105,984210,985278,986308,987301,988258,989177,990058,990903,991710,992480,993212,993907,994565,995185,995767,996313,996820,997290,997723,998118,998476,998795,999078,999322,999529,999699,999831,999925,999981,1000000];
  function isin(i) { i &= 1023; if (i < 256) return SINQ[i]; if (i < 512) return SINQ[512 - i]; if (i < 768) return -SINQ[i - 512]; return -SINQ[1024 - i]; }
  function icos(i) { return isin(i + 256); }

  function hash(seed, a, b) {
    var h = (seed ^ Math.imul(a + 1, 0x9E3779B1) ^ Math.imul(b + 7, 0x85EBCA77)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7FEB352D) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846CA68B) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  var R = null;
  function ready() {
    if (R) return Promise.resolve();
    var lib = root.RAPIER;
    return lib.init({}).then(function () { R = lib; });
  }

  // ---------------------------------------------------------------- layouts
  // a layout is a list of tables, each with rows of cells: {t, col, span}
  // ---------------------------------------------------------------- level designs
  // Each design is a picture, top row first. Characters:
  //   . empty   0-6 crown brick (colour slot)   S castle stone   A-E jar (colour slot)
  //   c crate   i ice (2 hits)   T TNT barrel   = plank (runs join, up to 3 wide)
  //   P pillar: a brick two rows tall, the cell above it is |
  // Colour slots map to real colours through a seeded shuffle, so one design has many looks.
  // min: first tower it can appear on. twin: built on two tables (split at the space).
  var DESIGNS = [
    { min: 1, rows: ['AAABBB', 'AAABBB', 'AAABBB'] },
    { min: 1, rows: ['ABABAB', 'BABABA', 'ABABAB'] },
    { min: 2, rows: ['...A...', '..BBB..', '.AAAAA.', 'BBBBBBB'] },
    { min: 2, rows: ['0000111', '0000111', '0000111', '0000111'] },
    { min: 3, rows: ['00000000', '11111111', '22222222', '33333333', '44444444'] },
    { min: 3, rows: ['====', 'AcAc', 'cAcA', 'AcAc', '===='] },
    { min: 3, rows: ['AABB BBAA', 'AABB BBAA', 'AABB BBAA', 'AABB BBAA'], twin: true },
    { min: 4, rows: ['0000000', '0111110', '01AAA10', '01ABA10', '01AAA10', '0111110'] },
    { min: 4, rows: ['....A....', '...ABA...', '..ABCBA..', '.ABBCBBA.', 'AAAAAAAAA'] },
    { min: 4, rows: ['000A000', '000A000', 'AAAAAAA', '000A000', '000A000'] },
    { min: 5, rows: ['=======', 'P0P0P0P', '|A|A|A|', 'P0P0P0P', '|A|A|A|'] },
    { min: 5, rows: ['iiiiiii', 'i00000i', 'i0AAA0i', 'i0AAA0i', 'i00000i', 'iiiiiii'] },
    { min: 5, rows: ['0011 2233', '0011 2233', 'AABB CCDD', 'AABB CCDD', '0011 2233'], twin: true },
    { min: 6, rows: ['=========', 'AcAcAcAcA', 'cAcAcAcAc', 'AcAcTcAcA', 'cAcAcAcAc', '========='] },
    { min: 6, rows: ['S.S.S.S', 'SSSSSSS', 'SAAAAAS', 'SABBBAS', 'SAAAAAS', 'SSSSSSS'] },
    { min: 6, rows: ['.AA.AA.', 'ABBABBA', 'ABBBBBA', '.ABBBA.', '..ABA..', '...A...'] },
    { min: 7, rows: ['00000000', '0AAAAAA0', '0A1111A0', '0A1BB1A0', '0A1111A0', '0AAAAAA0', '00000000'] },
    { min: 7, rows: ['iii.iii', 'iAi.iAi', 'iii.iii', '=======', 'P0P0P0P', '|A|B|A|'] },
    { min: 8, rows: ['SSSSSSSS', 'S0T00T0S', 'SAAAAAAS', 'SBBBBBBS', 'SAAAAAAS', 'S0iiii0S', 'SSSSSSSS'] },
    { min: 8, rows: ['AB0 0BA', 'BA0 0AB', 'AB0 0BA', 'BA0 0AB', 'AB0 0BA', '=== ==='], twin: true },
    { min: 9, rows: ['=========', 'P1i1i1i1P', '|AAAAAAA|', 'P2i2i2i2P', '|BBBBBBB|', '========='] }
  ];
  var BRICK_COLS = 7, JAR_COLS = 5;

  function layout(seed, L) {
    var pool = [];
    for (var k = 0; k < DESIGNS.length; k++) if (DESIGNS[k].min <= L && DESIGNS[k].min >= Math.max(1, L - 6)) pool.push(k);
    var di = pool[hash(seed, L, 1) % pool.length], D = DESIGNS[di];
    // seeded colour slots
    function perm(n, salt) { var a = []; for (var q = 0; q < n; q++) a.push(q); for (q = n - 1; q > 0; q--) { var r = hash(seed, L, salt + q) % (q + 1), t = a[q]; a[q] = a[r]; a[r] = t; } return a; }
    var bp = perm(BRICK_COLS, 40), jp = perm(JAR_COLS, 60);
    function cellOf(ch) {
      if (ch >= '0' && ch <= '6') return { t: 'brick', col: bp[ch.charCodeAt(0) - 48], span: 1 };
      if (ch >= 'A' && ch <= 'E') return { t: 'jar', col: jp[ch.charCodeAt(0) - 65], span: 1 };
      if (ch === 'S') return { t: 'brick', col: 7, span: 1 };
      if (ch === 'c') return { t: 'crate', col: 0, span: 1 };
      if (ch === 'i') return { t: 'ice', col: 0, span: 1 };
      if (ch === 'T') return { t: 'bomb', col: 0, span: 1 };
      if (ch === 'P') return { t: 'brick', col: bp[(hash(seed, L, 80) % 3)], span: 1, tall: 1 };
      return null;
    }
    // split into tables, then turn each picture into bottom-up rows of cells
    var parts = D.twin ? [0, 1] : [0], tables = [];
    parts.forEach(function (pi) {
      var pic = D.rows.map(function (row) { return D.twin ? row.split(' ')[pi] : row; });
      var cols = pic[0].length, rows = [];
      for (var r = pic.length - 1; r >= 0; r--) {
        var line = pic[r], out = [], c = 0;
        while (c < cols) {
          var ch = line.charAt(c);
          if (ch === '=') { var run = 0; while (c + run < cols && line.charAt(c + run) === '=') run++; while (run > 0) { var sp = run >= 5 || run === 3 ? 3 : run >= 2 ? 2 : 1; out.push(sp === 1 ? { t: 'crate', col: 0, span: 1, x: c } : { t: 'plank', col: 0, span: sp, x: c }); c += sp; run -= sp; } continue; }
          if (ch === '|') out.push({ skip: 1, x: c });
          else { var cell = cellOf(ch); if (cell) { cell.x = c; out.push(cell); } else out.push({ gap: 1, x: c }); }
          c += 1;
        }
        rows.push(out);
      }
      tables.push({ cols: cols, rows: rows });
    });
    if (tables.length === 2) { var gap = 1.2, w0 = tables[0].cols, w1 = tables[1].cols; tables[0].cx = -(w1 + gap) / 2 - 0.3 + (w1 - w0) / 4; tables[1].cx = (w0 + gap) / 2 + 0.3 - (w1 - w0) / 4; tables[0].cx = -(w0 / 2 + gap / 2 + 0.25); tables[1].cx = w1 / 2 + gap / 2 + 0.25; }
    else tables[0].cx = 0;
    // TNT from tower 4 on designs that have none: swap one jar for a barrel
    if (L >= 4 && D.rows.join('').indexOf('T') < 0 && (hash(seed, L, 5) & 1)) {
      for (var tries = 0; tries < 30; tries++) {
        var hv = hash(seed, L, 600 + tries), tb = tables[hv % tables.length], rw = tb.rows[(hv >>> 4) % tb.rows.length], cl = rw[(hv >>> 12) % rw.length];
        if (cl && cl.t === 'jar') { cl.t = 'bomb'; break; }
      }
    }
    return { kind: 'd' + di, tables: tables, round: (hash(seed, L, 7) % 3) === 0 && !D.twin };
  }

  function rowHeight(row) { var plank = false, other = false; for (var i = 0; i < row.length; i++) { if (row[i].t === 'plank') plank = true; else if (row[i].t) other = true; } return plank && !other ? PLANK_H : ROW; }

  // ---------------------------------------------------------------- world
  function addBlock(S, t, col, cx, cy, span, h) {
    var W = S.world;
    var bd = R.RigidBodyDesc.dynamic().setTranslation(cx, cy, 0).setLinearDamping(0.05).setAngularDamping(0.15).setSleeping(true);
    var body = W.createRigidBody(bd);
    var cd, hw = span * CELL / 2 - 0.006, hh = h / 2 - 0.004;
    if (t === 'jar' || t === 'bomb') cd = R.ColliderDesc.cylinder(hh, 0.48).setDensity(t === 'bomb' ? 0.8 : 0.6);
    else if (t === 'brick') cd = R.ColliderDesc.roundCuboid(hw - 0.04, hh - 0.04, DEPTH / 2 - 0.04, 0.04).setDensity(1.1);
    else cd = R.ColliderDesc.roundCuboid(hw - 0.04, hh - 0.04, DEPTH / 2 - 0.04, 0.04).setDensity(0.7);
    cd.setFriction(0.75).setRestitution(0.08)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(t === 'jar' ? JAR_BREAK_F : CRUSH_F);
    var collider = W.createCollider(cd, body);
    var b = { id: S.nextId++, t: t, col: col, hp: HP[t], span: span, w: span * CELL, h: h, body: body, collider: collider, lastThud: -99, sp: 0 };
    S.blocks = S.blocks.concat([b]);
    S.byCollider[collider.handle] = b;
    return b;
  }

  function buildTower(S) {
    var L = S.level, lay = layout(S.seed, L), cost = 0;
    S.tables = []; var towerH = 0;
    for (var ti = 0; ti < lay.tables.length; ti++) {
      var tb = lay.tables[ti], tw = tb.cols * CELL + 0.5;
      var tbody = S.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(tb.cx, -0.15, 0));
      S.world.createCollider(R.ColliderDesc.cuboid(tw / 2, 0.15, 0.8).setFriction(0.8), tbody);
      S.tables.push({ cx: tb.cx, w: tw, body: tbody, round: !!lay.round });
      var hs = tb.rows.map(rowHeight), y = 0;
      for (var r = 0; r < tb.rows.length; r++) {
        var row = tb.rows[r], x0 = tb.cx - tb.cols * CELL / 2;
        for (var c = 0; c < row.length; c++) {
          var cell = row[c];
          if (cell.skip || cell.gap) continue;
          var span = cell.span, ch = cell.t === 'plank' ? PLANK_H : hs[r];
          if (cell.tall && r + 1 < hs.length) ch = hs[r] + hs[r + 1];
          addBlock(S, cell.t, cell.col, x0 + (cell.x + span / 2) * CELL, y + ch / 2, span, ch);
          cost += cell.t === 'jar' || cell.t === 'bomb' ? 10 : cell.t === 'brick' ? 12 : cell.t === 'ice' ? 16 : cell.t === 'crate' ? 22 : 30;
        }
        y += hs[r];
      }
      if (y > towerH) towerH = y;
    }
    S.layout = lay.kind;
    var per = 23 + L * 2, add = Math.max(5, ((cost + per - 1) / per) | 0) + (L === 1 ? 4 : 2);
    S.balls += add;
    // obstacles: a sliding shield from tower 3, the spinning fan from tower 5
    var ob = hash(S.seed, L, 6) % 4;
    if (L >= 3 && (L < 5 ? (ob & 1) === 0 : ob === 1 || ob === 3)) {
      var sy = (2 + (hash(S.seed, L, 9) % 3)) * ROW * 0.7;
      var sb = S.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, sy, SHIELD_Z));
      S.world.createCollider(R.ColliderDesc.roundCuboid(SHIELD_W / 2 - 0.08, SHIELD_H / 2 - 0.08, 0.1, 0.08).setRestitution(0.6), sb);
      S.shield = { body: sb, y: sy, k: hash(S.seed, L, 10) & 1023, spd: L >= 8 ? 6 : 4, range: 2.6 };
    }
    if (L >= 5 && ob >= 2) {
      var fb = S.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, Math.max(2.2, towerH * 0.55), FAN_Z));
      for (var k = 0; k < 4; k++) {
        var a = k * 256, cx = FAN_LEN / 2 * icos(a) / 1e6, cy = FAN_LEN / 2 * isin(a) / 1e6;
        var rot = { x: 0, y: 0, z: isin(a >> 1) / 1e6, w: icos(a >> 1) / 1e6 };
        S.world.createCollider(R.ColliderDesc.cuboid(FAN_LEN / 2, FAN_HALF, 0.12).setTranslation(cx, cy, 0).setRotation(rot).setRestitution(0.5), fb);
      }
      S.world.createCollider(R.ColliderDesc.cylinder(0.2, 0.42).setRotation({ x: isin(128) / 1e6, y: 0, z: 0, w: icos(128) / 1e6 }), fb);
      S.fan = { body: fb, k: hash(S.seed, L, 7) & 1023, spd: (L >= 9 ? 3 : 2) * ((hash(S.seed, L, 8) & 1) ? 1 : -1) };
    }
    S.events.push({ e: 'tower', add: add, level: L, kind: lay.kind, tables: S.tables.map(function (t) { return { cx: t.cx, w: t.w, round: t.round }; }) });
  }

  function clearWorld(S) {
    if (S.world) S.world.free();
    S.world = new R.World({ x: 0, y: GRAVITY, z: 0 });
    S.world.timestep = DT;
    S.queue = new R.EventQueue(true);
    S.blocks = []; S.byCollider = {}; S.ballsLive = []; S.fan = null; S.shield = null; S.tables = [];
  }

  function initSim(seed, startLevel) {          // startLevel: QA only, never used by a scored run
    var S = { v: RULES_VERSION, seed: seed >>> 0, step: 0, level: startLevel > 1 ? startLevel | 0 : 1, balls: 0, score: 0, nextId: 1, shots: 0, lastShot: -99,
      phase: 'play', timer: 0, events: [], world: null };
    clearWorld(S);
    buildTower(S);
    return S;
  }

  // ---------------------------------------------------------------- input
  function shoot(S, tx, ty) {
    if (S.phase !== 'play' || S.balls <= 0 || S.step - S.lastShot < SHOT_GAP) return false;
    if ((tx | 0) !== tx || (ty | 0) !== ty || tx < -700 || tx > 700 || ty < -150 || ty > 1300) return false;
    var x = tx / 100, y = ty / 100, z = FRONT;
    // straight like a bullet: no gravity until the ball first touches something
    var dx = x - CANNON.x, dy = y - CANNON.y, dz = z - CANNON.z, dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var vx = dx / dl * BALL_SPEED, vy = dy / dl * BALL_SPEED, vz = dz / dl * BALL_SPEED;
    var body = S.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(CANNON.x, CANNON.y, CANNON.z).setLinvel(vx, vy, vz).setGravityScale(0).setCcdEnabled(true).setAngularDamping(0.3));
    var col = S.world.createCollider(R.ColliderDesc.ball(BALL_R).setDensity(BALL_DENSITY).setRestitution(0.35).setFriction(0.4)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS), body);
    S.balls -= 1; S.lastShot = S.step; S.shots += 1;
    var ball = { n: S.shots, body: body, collider: col, age: 0, pierced: 0, slow: 0, free: false, pv: { x: vx, y: vy, z: vz } };
    S.ballsLive = S.ballsLive.concat([ball]);
    S.events.push({ e: 'fire', x: x, y: y, z: z, n: S.shots });
    return true;
  }

  // ---------------------------------------------------------------- step
  function removeBlock(S, b) {
    var p = b.body.translation();
    S.blocks = S.blocks.filter(function (o) { return o !== b; });
    delete S.byCollider[b.collider.handle];
    S.world.removeRigidBody(b.body);
    // wake whatever was touching it so stacks settle on the gap
    for (var i = 0; i < S.blocks.length; i++) {
      var q = S.blocks[i].body.translation(), dx = q.x - p.x, dy = q.y - p.y;
      if (dx * dx + dy * dy < 9) S.blocks[i].body.wakeUp();
    }
    return p;
  }
  function breakBlock(S, b, how) {
    var p = b.body.translation(), r = b.body.rotation(), v = b.body.linvel();
    removeBlock(S, b);
    S.score += PTS[b.t];
    S.events.push({ e: 'break', t: b.t, col: b.col, x: p.x, y: p.y, z: p.z, q: { x: r.x, y: r.y, z: r.z, w: r.w }, vx: v.x, vy: v.y, w: b.w, h: b.h, pts: PTS[b.t], how: how, id: b.id });
  }

  function explode(S, b, toBreak) {
    var p = b.body.translation();
    S.events.push({ e: 'boom', x: p.x, y: p.y, z: p.z });
    for (var i = 0; i < S.blocks.length; i++) {
      var o = S.blocks[i];
      if (o === b) continue;
      var q = o.body.translation(), dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
      if (d2 > BOMB_R * BOMB_R) continue;
      var d = Math.sqrt(d2) + 0.3, k = BOMB_PUSH * o.body.mass() / d;
      o.body.applyImpulse({ x: dx / d * k, y: (dy / d + 0.6) * k, z: -0.35 * k }, true);
      if ((o.t === 'jar' || o.t === 'bomb') && d < 1.6) toBreak.push([o, 'boom']);
    }
  }

  function stepSim(S) {
    S.step += 1;
    var i, b;
    if (S.fan) {
      S.fan.k = (S.fan.k + S.fan.spd) & 1023;
      S.fan.body.setNextKinematicRotation({ x: 0, y: 0, z: isin(S.fan.k) / 1e6, w: icos(S.fan.k) / 1e6 });
    }
    if (S.shield) {
      S.shield.k = (S.shield.k + S.shield.spd) & 1023;
      S.shield.body.setNextKinematicTranslation({ x: S.shield.range * isin(S.shield.k) / 1e6, y: S.shield.y, z: SHIELD_Z });
    }
    for (i = 0; i < S.ballsLive.length; i++) { var lv = S.ballsLive[i].body.linvel(); S.ballsLive[i].pv = { x: lv.x, y: lv.y, z: lv.z }; }
    S.world.step(S.queue);
    var toBreak = [], restore = [];
    S.queue.drainCollisionEvents(function (h1, h2, started) {
      if (!started) return;
      var ball = null, other = null;
      for (var k = 0; k < S.ballsLive.length; k++) {
        if (S.ballsLive[k].collider.handle === h1) { ball = S.ballsLive[k]; other = h2; }
        else if (S.ballsLive[k].collider.handle === h2) { ball = S.ballsLive[k]; other = h1; }
      }
      if (!ball) return;
      ball.hits = (ball.hits || 0) + 1;
      if (!ball.free) { ball.free = true; ball.body.setGravityScale(1, true); }
      var blk = S.byCollider[other];
      var sp2 = ball.pv.x * ball.pv.x + ball.pv.y * ball.pv.y + ball.pv.z * ball.pv.z;
      if (!blk) {
        if (sp2 > 16) {
          var oc = S.world.getCollider(other), par = oc && oc.parent();
          var what = par && S.fan && par.handle === S.fan.body.handle ? 'fan' : par && S.shield && par.handle === S.shield.body.handle ? 'shield' : 'table';
          S.events.push({ e: 'bonk', n: ball.n, v: Math.sqrt(sp2), what: what });
        }
        return;
      }
      if (blk.t === 'jar' || blk.t === 'bomb') {
        if (sp2 > 4) {
          toBreak.push([blk, 'ball']);
          if (ball.pierced < PIERCE && sp2 > 16) { ball.pierced += 1; restore.push([ball, 0.88]); }
        }
      } else if (blk.t === 'crate' || blk.t === 'plank' || blk.t === 'ice') {
        if (sp2 > 25) {
          blk.hp -= 1;
          if (blk.hp <= 0) { toBreak.push([blk, 'ball']); restore.push([ball, 0.7]); }
          else { S.events.push({ e: 'crack', t: blk.t, id: blk.id, hp: blk.hp, x: blk.body.translation().x, y: blk.body.translation().y }); restore.push([ball, 0.6]); }
        }
      } else if (sp2 > 9) { S.events.push({ e: 'knock', id: blk.id, v: Math.sqrt(sp2) }); restore.push([ball, 0.6]); }
    });
    S.queue.drainContactForceEvents(function (ev) {
      var f = ev.totalForceMagnitude();
      var b1 = S.byCollider[ev.collider1()], b2 = S.byCollider[ev.collider2()];
      if (b1 && b1.t === 'jar' && f > JAR_BREAK_F) toBreak.push([b1, 'crush']);
      if (b2 && b2.t === 'jar' && f > JAR_BREAK_F) toBreak.push([b2, 'crush']);
    });
    var done = [];
    for (i = 0; i < toBreak.length; i++) {
      b = toBreak[i][0];
      if (done.indexOf(b) >= 0 || S.blocks.indexOf(b) < 0) continue;
      done.push(b);
      if (b.t === 'bomb') explode(S, b, toBreak);
      breakBlock(S, b, toBreak[i][1]);
    }
    for (i = 0; i < restore.length; i++) {
      var bl = restore[i][0], k2 = restore[i][1];
      // the ball stays on the front of the tower: its push into the tower is spent on the break,
      // it keeps some sideways and vertical motion and drops down the face, like the reference
      bl.body.setLinvel({ x: bl.pv.x * k2 * 0.5, y: Math.min(bl.pv.y * k2 * 0.4, 3), z: 1.2 }, true);
    }
    // landing thuds: a block that was moving and suddenly stops (once, not while it rests)
    for (i = 0; i < S.blocks.length; i++) {
      b = S.blocks[i];
      if (b.body.isSleeping()) { b.sp = 0; continue; }
      var v = b.body.linvel(), sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (b.sp > 2.5 && sp < b.sp * 0.45 && S.step - b.lastThud > 20) {
        b.lastThud = S.step; var tp = b.body.translation();
        S.events.push({ e: 'thud', t: b.t, x: tp.x, y: tp.y, z: tp.z, f: b.sp * 60 });
      }
      b.sp = sp;
    }
    // knocked off the table
    for (i = S.blocks.length - 1; i >= 0; i--) {
      b = S.blocks[i];
      var p = b.body.translation();
      if (p.y < FALL_Y) {
        var fv = b.body.linvel(), fa = b.body.angvel(), fq = b.body.rotation();
        removeBlock(S, b);
        S.score += FALL_PTS[b.t];
        S.events.push({ e: 'fall', t: b.t, col: b.col, x: p.x, y: p.y, z: p.z, pts: FALL_PTS[b.t], id: b.id, v: { x: fv.x, y: fv.y, z: fv.z }, av: { x: fa.x, y: fa.y, z: fa.z }, q: { x: fq.x, y: fq.y, z: fq.z, w: fq.w } });
      }
    }
    // spent balls leave quietly: off the world, too old, or resting on the table
    var keep = [];
    for (i = 0; i < S.ballsLive.length; i++) {
      var bb = S.ballsLive[i];
      bb.age += 1;
      var bp = bb.body.translation(), bv = bb.body.linvel();
      bb.slow = (bv.x * bv.x + bv.y * bv.y + bv.z * bv.z < 1.5) ? bb.slow + 1 : 0;
      if (bp.y < -6 || bb.age > 300 || bp.z < -30 || bb.slow > 45) { S.events.push({ e: 'ballGone', n: bb.n, x: bp.x, y: bp.y, z: bp.z }); S.world.removeRigidBody(bb.body); continue; }
      keep.push(bb);
    }
    S.ballsLive = keep;

    if (S.phase === 'play') {
      if (!S.blocks.length) {
        var bonus = 100 + 50 * S.level;
        S.score += bonus; S.phase = 'clear'; S.timer = 90;
        S.events.push({ e: 'clear', bonus: bonus, level: S.level });
      } else if (S.balls <= 0 && !S.ballsLive.length) {
        var moving = false;
        for (i = 0; i < S.blocks.length; i++) if (!S.blocks[i].body.isSleeping()) { moving = true; break; }
        if (!moving || S.step - S.lastShot > 420) { S.phase = 'ending'; S.timer = 60; }
      }
    } else if (S.phase === 'clear') {
      if (--S.timer <= 0) {
        var keepBalls = S.balls;
        clearWorld(S); S.balls = keepBalls;
        S.level += 1; S.phase = 'play'; buildTower(S);
      }
    } else if (S.phase === 'ending') {
      if (!S.blocks.length) { S.phase = 'play'; }
      else if (--S.timer <= 0) { S.phase = 'over'; S.events.push({ e: 'over', score: S.score }); }
    }
  }

  root.KTRules = { RULES_VERSION: RULES_VERSION, ready: ready, initSim: initSim, stepSim: stepSim, shoot: shoot, hash: hash,
    DT: DT, GRAVITY: GRAVITY, CELL: CELL, ROW: ROW, DEPTH: DEPTH, FRONT: FRONT, PLANK_H: PLANK_H, BALL_R: BALL_R, CANNON: CANNON,
    FLIGHT_STEPS: FLIGHT_STEPS, FAN_LEN: FAN_LEN, FAN_HALF: FAN_HALF, FAN_Y: FAN_Y, FAN_Z: FAN_Z, SHIELD_W: SHIELD_W, SHIELD_H: SHIELD_H, SHIELD_Z: SHIELD_Z, layout: layout };
})(typeof window !== 'undefined' ? window : globalThis);
