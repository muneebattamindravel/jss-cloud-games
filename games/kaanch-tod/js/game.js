/* Kaanch Tod: the 3D view, effects, HUD and input.
   The rules live in rules.js (window.KTRules) and run on fixed 1/60 s steps
   in a flat 414x736 design plane. This file only READS the sim: it maps the
   plane onto the front face of a 3D tower, and maps taps back onto the plane.
   Everything random here is cosmetic (Math.random). */
(function () {
  'use strict';
  var R = window.KTRules, A = window.KTAudio, T = window.THREE;
  var U = R.U, PX = 46;                              // design px per world unit (one cell)
  function wx(sx) { return (sx / U - 207) / PX; }    // sim x (sub units) -> world x
  function wy(sy) { return (R.FLOOR - sy) / U / PX; } // sim y -> world y (table top = 0)
  var CELLW = R.CELL / U / PX, ROWH = R.BH / U / PX; // 1 x 1.3
  var DEPTH = 0.96;                                  // block depth in world units
  var FRONT = DEPTH / 2;                             // tower front face z

  // ---------------------------------------------------------------- renderer
  var canvas = document.getElementById('game');
  var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;

  var scene = new T.Scene();
  var camera = new T.PerspectiveCamera(36, 414 / 736, 0.1, 400);
  var CAM = new T.Vector3(0, 5.4, 24.5), LOOK = new T.Vector3(0, 1.0, 0);
  camera.position.copy(CAM); camera.lookAt(LOOK);
  var pickCam = camera.clone();                      // design-rect camera used for taps
  pickCam.updateMatrixWorld(true); pickCam.updateProjectionMatrix();
  var fitRect = { x: 0, y: 0, w: 414, h: 736 };

  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    // contain-fit the 414x736 design rect, show extra scenery around it
    var s = Math.min(w / 414, h / 736), dw = 414 * s, dh = 736 * s;
    camera.aspect = 414 / 736;
    camera.setViewOffset(dw, dh, -(w - dw) / 2, -(h - dh) / 2, w, h);
    camera.updateProjectionMatrix();
    fitRect = { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
    layoutHud();
  }

  // ---------------------------------------------------------------- textures
  function canvasTex(w, h, draw, repeat) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    var t = new T.CanvasTexture(c);
    t.encoding = T.sRGBEncoding; t.anisotropy = 4;
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    return t;
  }
  function stripeTex(col) {
    return canvasTex(256, 32, function (g, w, h) {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.fillStyle = col;
      for (var i = -2; i < 24; i++) { g.beginPath(); g.moveTo(i * 12, h); g.lineTo(i * 12 + 6, h); g.lineTo(i * 12 + 18, 0); g.lineTo(i * 12 + 12, 0); g.fill(); }
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, h - 6, w, 6);
      g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(0, 2, w, 3);
    });
  }
  function woodGrain(g, w, h, base, dark, n) {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (var i = 0; i < n; i++) {
      g.strokeStyle = 'rgba(' + dark + ',' + (0.08 + Math.random() * 0.18) + ')';
      g.lineWidth = 1 + Math.random() * 2.5;
      var y = Math.random() * h;
      g.beginPath(); g.moveTo(0, y);
      for (var x = 0; x <= w; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 3);
      g.stroke();
    }
  }
  function cracks(g, w, h, n) {
    g.strokeStyle = 'rgba(30,12,2,0.9)'; g.lineWidth = 3; g.lineCap = 'round';
    for (var i = 0; i < n; i++) {
      var x = w * (0.25 + Math.random() * 0.5), y = h * (0.2 + Math.random() * 0.6);
      g.beginPath(); g.moveTo(x, y);
      for (var k = 0; k < 4; k++) { x += (Math.random() - 0.5) * w * 0.35; y += (Math.random() - 0.5) * h * 0.3; g.lineTo(x, y); }
      g.stroke();
    }
  }
  function crateTex(cracked) {
    return canvasTex(256, 320, function (g, w, h) {
      woodGrain(g, w, h, '#c98845', '90,45,12', 40);
      g.fillStyle = 'rgba(70,35,8,0.55)';
      for (var i = 1; i < 4; i++) g.fillRect(0, i * h / 4 - 2, w, 4);
      g.fillStyle = '#a35f26'; g.fillRect(0, 0, w, 28); g.fillRect(0, h - 28, w, 28); g.fillRect(0, 0, 28, h); g.fillRect(w - 28, 0, 28, h);
      g.fillStyle = 'rgba(255,220,160,0.35)'; g.fillRect(0, 0, w, 5); g.fillRect(0, 0, 5, h);
      g.fillStyle = 'rgba(60,25,5,0.5)'; g.fillRect(0, h - 5, w, 5); g.fillRect(w - 5, 0, 5, h);
      g.save(); g.translate(w / 2, h / 2); g.rotate(-Math.atan2(h - 56, w - 56));
      g.fillStyle = '#9a5520'; g.fillRect(-w * 0.62, -15, w * 1.24, 30);
      g.fillStyle = 'rgba(255,210,150,0.35)'; g.fillRect(-w * 0.62, -15, w * 1.24, 5);
      g.restore();
      g.fillStyle = '#3d1f08';
      [[14, 14], [w - 14, 14], [14, h - 14], [w - 14, h - 14]].forEach(function (p) { g.beginPath(); g.arc(p[0], p[1], 5, 0, 7); g.fill(); });
      if (cracked) cracks(g, w, h, 5);
    });
  }
  function barkTex(cr) {
    return canvasTex(512, 128, function (g, w, h) {
      woodGrain(g, w, h, '#9a5a26', '50,22,5', 60);
      var gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, 'rgba(255,200,140,0.25)'); gr.addColorStop(0.5, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.25)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(50,22,5,0.6)';
      for (var i = 0; i < 6; i++) { g.beginPath(); g.ellipse(Math.random() * w, Math.random() * h, 10, 5, 0, 0, 7); g.fill(); }
      if (cr) cracks(g, w, h, cr);
    });
  }
  var endTex = canvasTex(128, 128, function (g, w, h) {
    g.fillStyle = '#f2c98e'; g.fillRect(0, 0, w, h);
    for (var i = 8; i > 0; i--) { g.strokeStyle = i % 2 ? '#c98a4a' : '#dca468'; g.lineWidth = 3; g.beginPath(); g.arc(64, 64, i * 7.5, 0, 7); g.stroke(); }
    g.strokeStyle = '#7a4219'; g.lineWidth = 6; g.beginPath(); g.arc(64, 64, 61, 0, 7); g.stroke();
  });
  var ballTex = canvasTex(256, 128, function (g, w, h) {
    g.fillStyle = '#e8243a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffd34d'; g.beginPath(); g.moveTo(0, 52);
    for (var i = 0; i <= 16; i++) g.lineTo(i * 16, i % 2 ? 40 : 58);
    for (i = 16; i >= 0; i--) g.lineTo(i * 16, i % 2 ? 70 : 88);
    g.fill();
    g.fillStyle = '#ffffff'; for (i = 0; i < 8; i++) { g.beginPath(); g.arc(16 + i * 32, 20, 5, 0, 7); g.fill(); g.beginPath(); g.arc(i * 32, 108, 5, 0, 7); g.fill(); }
  });
  var softTex = canvasTex(64, 64, function (g) {
    var gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
  var starTex = canvasTex(64, 64, function (g) {
    var gr = g.createRadialGradient(32, 32, 0, 32, 32, 30);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.15, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#fff'; g.fillRect(30, 2, 4, 60); g.fillRect(2, 30, 60, 4);
  });

  // ---------------------------------------------------------------- environment (reflections)
  (function makeEnv() {
    var es = new T.Scene();
    var geo = new T.SphereGeometry(50, 32, 16);
    var cols = [], pos = geo.attributes.position, top = new T.Color('#8fd0ff'), mid = new T.Color('#ffffff'), bot = new T.Color('#5f9e35');
    for (var i = 0; i < pos.count; i++) {
      var y = pos.getY(i) / 50, c = y > 0 ? mid.clone().lerp(top, y) : mid.clone().lerp(bot, Math.min(1, -y * 2.5));
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
    es.add(new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
    function panel(x, y, z, w, h, k) {
      var m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(k, k, k), side: T.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); es.add(m);
    }
    panel(-20, 25, 25, 18, 10, 2.2); panel(25, 15, 20, 10, 18, 1.4); panel(0, 30, -20, 30, 8, 1); panel(-30, 5, -10, 8, 20, 0.8);
    var pm = new T.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(es, 0.02).texture;
  })();

  // ---------------------------------------------------------------- world
  var SKY_HOR = '#cdeeff';
  scene.background = canvasTex(16, 512, function (g, w, h) {
    var gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#3d9be9'); gr.addColorStop(0.55, '#9fd6ff'); gr.addColorStop(1, SKY_HOR);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  scene.fog = new T.Fog(SKY_HOR, 45, 150);

  var hemi = new T.HemisphereLight(0xdff2ff, 0x7aa548, 0.35); scene.add(hemi);
  var sun = new T.DirectionalLight(0xfff0d8, 1.25);
  sun.position.set(-7, 14, 12); sun.target.position.set(0, 2, 0);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  var sc = sun.shadow.camera; sc.left = -9; sc.right = 9; sc.top = 11; sc.bottom = -7; sc.near = 1; sc.far = 50;
  sun.shadow.bias = -0.0004; sun.shadow.radius = 4;
  scene.add(sun); scene.add(sun.target);
  var fill = new T.DirectionalLight(0xbfd8ff, 0.15); fill.position.set(8, 4, 10); scene.add(fill);

  function std(col, rough, extra) {
    var o = { color: col, roughness: rough === undefined ? 0.6 : rough, metalness: 0 };
    for (var k in extra) o[k] = extra[k];
    return new T.MeshStandardMaterial(o);
  }
  function shadowy(m, cast, recv) { m.castShadow = cast !== false; m.receiveShadow = recv !== false; return m; }

  var GROUND_Y = -4.1;
  var grassTex = canvasTex(512, 512, function (g, w, h) {
    g.fillStyle = '#62b336'; g.fillRect(0, 0, w, h);
    for (var i = 0; i < 2600; i++) {
      g.fillStyle = ['#56a52c', '#74c444', '#4e9a28', '#86d153'][i % 4];
      g.fillRect(Math.random() * w, Math.random() * h, 2, 5 + Math.random() * 6);
    }
  }, [30, 30]);
  var ground = shadowy(new T.Mesh(new T.PlaneGeometry(400, 400), std(0xffffff, 0.95, { map: grassTex })), false, true);
  ground.rotation.x = -Math.PI / 2; ground.position.y = GROUND_Y; scene.add(ground);

  var dirt = shadowy(new T.Mesh(new T.CircleGeometry(1, 48), std(0xffffff, 1, { map: canvasTex(256, 256, function (g, w, h) {
    var gr = g.createRadialGradient(128, 128, 20, 128, 128, 128);
    gr.addColorStop(0, '#d7a466'); gr.addColorStop(0.75, '#c99256'); gr.addColorStop(1, 'rgba(201,146,86,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (var i = 0; i < 300; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(120,75,35,0.4)' : 'rgba(240,200,150,0.5)'; g.beginPath(); g.arc(30 + Math.random() * 196, 30 + Math.random() * 196, 1 + Math.random() * 2.5, 0, 7); g.fill(); }
  }), transparent: true })), false, true);
  dirt.rotation.x = -Math.PI / 2; dirt.scale.set(5.5, 3.6, 1); dirt.position.set(0, GROUND_Y + 0.02, 0.5); scene.add(dirt);

  function hill(x, z, r, h, col) {
    var m = new T.Mesh(new T.SphereGeometry(1, 32, 16), std(col, 0.95));
    m.scale.set(r, h, r * 0.6); m.position.set(x, GROUND_Y - 0.5, z); m.receiveShadow = true; scene.add(m);
  }
  hill(-40, -90, 45, 18, 0x7fbf4d); hill(30, -100, 55, 22, 0x6db343); hill(85, -80, 40, 14, 0x88c757); hill(-95, -70, 40, 16, 0x79bb49);
  var mtn = std(0x8fb5cf, 1);
  [[-60, -140, 30, 30], [0, -150, 40, 38], [60, -145, 32, 28], [110, -140, 25, 22], [-110, -135, 28, 24]].forEach(function (p) {
    var m = new T.Mesh(new T.ConeGeometry(p[2], p[3], 6), mtn); m.position.set(p[0], GROUND_Y + p[3] / 2 - 4, p[1]); scene.add(m);
  });
  var leafCols = [0xf08a2c, 0xe8641e, 0xffb13b, 0xd9541a, 0xf5a03a];
  function tree(x, z, s) {
    var g = new T.Group();
    var trunk = shadowy(new T.Mesh(new T.CylinderGeometry(0.25, 0.4, 3, 8), std(0x7a4a26, 0.9)));
    trunk.position.y = 1.5; g.add(trunk);
    for (var i = 0; i < 7; i++) {
      var b = shadowy(new T.Mesh(new T.IcosahedronGeometry(1 + Math.random() * 0.7, 1), std(leafCols[i % leafCols.length], 0.8, { flatShading: true })));
      b.position.set((Math.random() - 0.5) * 2.4, 3.3 + Math.random() * 1.8, (Math.random() - 0.5) * 1.6);
      g.add(b);
    }
    g.scale.setScalar(s); g.position.set(x, GROUND_Y, z); scene.add(g);
  }
  tree(-12.5, -9, 1.2); tree(12.5, -10, 1.3); tree(-18, -18, 1.5); tree(17, -20, 1.6); tree(-5, -26, 1.2); tree(5, -32, 1.1); tree(-24, -30, 1.8); tree(25, -28, 1.7);
  function pumpkin(x, z, s) {
    var m = shadowy(new T.Mesh(new T.SphereGeometry(0.5, 16, 12), std(0xff8a1a, 0.5)));
    m.scale.set(s * 1.2, s * 0.85, s * 1.2); m.position.set(x, GROUND_Y + 0.4 * s, z); scene.add(m);
    var st = new T.Mesh(new T.CylinderGeometry(0.06, 0.08, 0.3, 6), std(0x3c7a1e)); st.position.set(x, GROUND_Y + 0.85 * s, z); scene.add(st);
  }
  pumpkin(-7.5, 1, 1); pumpkin(7.2, -1, 1.2); pumpkin(8.4, 0.2, 0.8);
  var cloudMat = std(0xffffff, 1, { emissive: 0xdde8f2, emissiveIntensity: 0.5 });
  function cloud(x, y, z, s) {
    var g = new T.Group();
    for (var i = 0; i < 5; i++) { var b = new T.Mesh(new T.SphereGeometry(1, 16, 12), cloudMat); b.position.set(i * 1.4 - 2.8, Math.sin(i) * 0.4, 0); b.scale.setScalar(1.3 + Math.sin(i * 1.7) * 0.4); g.add(b); }
    g.position.set(x, y, z); g.scale.setScalar(s); scene.add(g); return g;
  }
  var clouds = [cloud(-30, 30, -80, 2.5), cloud(25, 38, -100, 3), cloud(55, 24, -90, 2), cloud(-60, 34, -110, 3)];

  // ---------------------------------------------------------------- table
  var TABLE_W = 8.9;
  function roundedSlab(w, h, d, r) {
    var s = new T.Shape(), x = -w / 2, y = -d / 2;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + d - r);
    s.quadraticCurveTo(x + w, y + d, x + w - r, y + d); s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    var g = new T.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 3, curveSegments: 8 });
    g.rotateX(Math.PI / 2); g.translate(0, h, 0);
    return g;
  }
  var purple = new T.MeshPhysicalMaterial({ color: 0x8a3df0, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.15 });
  var gold = new T.MeshPhysicalMaterial({ color: 0xffbe2e, roughness: 0.25, metalness: 0.35, clearcoat: 0.8 });
  var table = new T.Group(); scene.add(table);
  var slab = shadowy(new T.Mesh(roundedSlab(TABLE_W, 0.28, 2.1, 0.3), purple)); slab.position.y = -0.28; table.add(slab);
  var trim = shadowy(new T.Mesh(new T.BoxGeometry(TABLE_W - 0.2, 0.07, 0.05), gold)); trim.position.set(0, -0.2, 1.1); table.add(trim);
  var poleMat = new T.MeshPhysicalMaterial({ color: 0xe8933c, roughness: 0.35, clearcoat: 0.6 });
  var pole = shadowy(new T.Mesh(new T.CylinderGeometry(0.28, 0.34, -GROUND_Y - 0.3, 24), poleMat)); pole.position.y = (GROUND_Y - 0.3) / 2 - 0.15; table.add(pole);
  var collar = shadowy(new T.Mesh(new T.CylinderGeometry(0.45, 0.45, 0.25, 24), purple)); collar.position.y = -0.45; table.add(collar);
  var basePts = [[0, 0], [1.4, 0], [1.4, 0.18], [1.15, 0.3], [0.75, 0.62], [0.5, 0.75], [0.5, 0.95], [0, 0.95]].map(function (p) { return new T.Vector2(p[0], p[1]); });
  var base = shadowy(new T.Mesh(new T.LatheGeometry(basePts, 40), gold)); base.position.y = GROUND_Y; table.add(base);
  var baseBand = shadowy(new T.Mesh(new T.CylinderGeometry(0.98, 1.2, 0.22, 40), purple)); baseBand.position.y = GROUND_Y + 0.42; table.add(baseBand);

  // ---------------------------------------------------------------- blocks
  var GLASS = [0x1f86ff, 0xff2e48, 0xffc114, 0x9b47ff, 0x22cc5e];
  var GLASS_CSS = ['#1f86ff', '#ff2e48', '#ffc114', '#9b47ff', '#22cc5e'];
  var glassMats = GLASS.map(function (c) {
    var m = new T.MeshPhysicalMaterial({ color: L(c), roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 0.3,
      emissive: L(c).multiplyScalar(0.22) });
    m.userData.lin = 1; return m;
  });
  var lidMats = GLASS_CSS.map(function (c) {
    return [new T.MeshPhysicalMaterial({ map: stripeTex(c), roughness: 0.3, clearcoat: 0.6 }), new T.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.35, clearcoat: 0.5 }), new T.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.35 })];
  });
  var jarGeoCache = {};
  function jarGeo(h) {
    var key = h.toFixed(3);
    if (jarGeoCache[key]) return jarGeoCache[key];
    var r = 0.47, b = 0.12, pts = [], i, a;
    pts.push(new T.Vector2(0, 0));
    for (i = 0; i <= 6; i++) { a = -Math.PI / 2 + i / 6 * Math.PI / 2; pts.push(new T.Vector2(r - b + Math.cos(a) * b, b + Math.sin(a) * b)); }
    for (i = 0; i <= 6; i++) { a = i / 6 * Math.PI / 2; pts.push(new T.Vector2(r - b + Math.cos(a) * b, h - 0.14 - b + Math.sin(a) * b)); }
    pts.push(new T.Vector2(r - 0.06, h - 0.12)); pts.push(new T.Vector2(0, h - 0.12));
    jarGeoCache[key] = new T.LatheGeometry(pts, 40);
    return jarGeoCache[key];
  }
  var lidGeo = new T.CylinderGeometry(0.44, 0.45, 0.17, 40);
  var crateGeo = new T.BoxGeometry(CELLW * 0.97, ROWH * 0.97, DEPTH * 0.97);
  var crateMats = [crateTex(false), crateTex(true)].map(function (t) { return new T.MeshStandardMaterial({ map: t, roughness: 0.75 }); });
  var logGeo = new T.CylinderGeometry(0.56, 0.56, CELLW * 2 - 0.06, 32, 1);
  logGeo.rotateZ(Math.PI / 2);
  var logMats = [0, 2, 5].map(function (n) { return [new T.MeshStandardMaterial({ map: barkTex(n), roughness: 0.8 }), new T.MeshStandardMaterial({ map: endTex, roughness: 0.7 }), new T.MeshStandardMaterial({ map: endTex, roughness: 0.7 })]; });

  var blockMeshes = {};
  var perfT = 0;
  function makeBlockMesh(b) {
    var g = new T.Group(), h = b.h / U / PX;
    if (b.t === 'g') {
      var body = shadowy(new T.Mesh(jarGeo(h - 0.03), glassMats[b.col])); body.position.y = 0.015; g.add(body);
      var lid = shadowy(new T.Mesh(lidGeo, lidMats[b.col])); lid.position.y = h - 0.1; g.add(lid);
    } else if (b.t === 'c') {
      var c = shadowy(new T.Mesh(crateGeo, crateMats[0])); c.position.y = h / 2; g.add(c); g.userData.mesh = c;
    } else {
      var l = shadowy(new T.Mesh(logGeo, logMats[0])); l.position.y = h / 2; g.add(l); g.userData.mesh = l;
    }
    scene.add(g);
    return { g: g, h: h, tilt: 0, tdir: (b.id % 2 ? 1 : -1), squash: 0, wob: 0, hitWob: 0, lastV: 0, wasFalling: false, drop: 0 };
  }
  function syncBlocks(S, dt) {
    var seen = {};
    for (var i = 0; i < S.blocks.length; i++) {
      var b = S.blocks[i], m = blockMeshes[b.id];
      if (!m) {
        m = blockMeshes[b.id] = makeBlockMesh(b);
        // new towers drop in from the sky, higher rows a little later
        m.drop = 9 + wy(b.y) * 1.3 + Math.random() * 0.8;
      }
      seen[b.id] = 1;
      var x = wx(b.x + b.w / 2), y = wy(b.y);
      var falling = b.vy !== 0;
      m.tilt += ((falling ? m.tdir * Math.min(0.1, b.vy / 1800) : 0) - m.tilt) * 0.15;
      if (m.wasFalling && !falling) { m.squash = Math.min(0.14, 0.04 + m.lastV / 1500); m.wob = 1; }
      m.wasFalling = falling; if (b.vy) m.lastV = b.vy;
      if (m.drop > 0) {
        var od = m.drop; m.drop = Math.max(0, m.drop - (27 + (12 - m.drop) * 1.2) * dt);
        if (od > 0 && m.drop === 0) { m.squash = 0.1; m.wob = 1; }
      }
      m.squash *= 0.86; m.wob *= 0.9;
      var sq = m.squash * Math.cos((1 - m.wob) * 14);
      m.g.position.set(x, y + m.drop, 0);
      m.g.rotation.z = m.tilt + (m.hitWob ? m.hitWob * Math.sin(perfT * 45) : 0);
      m.g.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
      if (m.hitWob) { m.hitWob *= 0.88; if (m.hitWob < 0.002) m.hitWob = 0; }
      if (b.t !== 'g' && m.g.userData.mesh) {
        var mats = b.t === 'c' ? crateMats[b.hp >= 2 ? 0 : 1] : logMats[Math.max(0, Math.min(2, 3 - b.hp))];
        if (m.g.userData.mesh.material !== mats) m.g.userData.mesh.material = mats;
      }
    }
    for (var id in blockMeshes) if (!seen[id]) { scene.remove(blockMeshes[id].g); delete blockMeshes[id]; }
  }

  // ---------------------------------------------------------------- fan
  var fan = new T.Group(), FAN_Z = FRONT + 0.75; scene.add(fan);
  var bladeShape = (function () {
    var s = new T.Shape(), L = R.FAN_LEN / PX, hw = R.FAN_HALF / PX;
    s.moveTo(0.3, -hw * 0.55); s.lineTo(L - 0.35, -hw); s.quadraticCurveTo(L + 0.1, 0, L - 0.35, hw); s.lineTo(0.3, hw * 0.55); s.closePath();
    return s;
  })();
  var bladeGeo = new T.ExtrudeGeometry(bladeShape, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 3 });
  bladeGeo.translate(0, 0, -0.06);
  var tipGeo = new T.SphereGeometry(R.FAN_HALF / PX * 1.05, 20, 12);
  var fanRot = new T.Group(); fan.add(fanRot);
  for (var k = 0; k < 4; k++) {
    var arm = new T.Group(); arm.rotation.z = k * Math.PI / 2;
    arm.add(shadowy(new T.Mesh(bladeGeo, gold)));
    var tip = shadowy(new T.Mesh(tipGeo, purple)); tip.position.x = R.FAN_LEN / PX - 0.3; tip.scale.set(0.9, 1, 0.5); arm.add(tip);
    fanRot.add(arm);
  }
  var hub = shadowy(new T.Mesh(new T.CylinderGeometry(R.FAN_HUB / PX, R.FAN_HUB / PX, 0.3, 32), gold)); hub.rotation.x = Math.PI / 2; fan.add(hub);
  var hubIn = new T.Mesh(new T.CylinderGeometry(R.FAN_HUB / PX * 0.7, R.FAN_HUB / PX * 0.7, 0.32, 32), purple); hubIn.rotation.x = Math.PI / 2; fan.add(hubIn);
  var fanPoleTex = canvasTex(32, 256, function (g, w, h) { g.fillStyle = '#ffc114'; g.fillRect(0, 0, w, h); g.fillStyle = '#8a3df0'; for (var i = -2; i < 20; i++) { g.beginPath(); g.moveTo(0, i * 16); g.lineTo(w, i * 16 + 10); g.lineTo(w, i * 16 + 18); g.lineTo(0, i * 16 + 8); g.fill(); } }, [1, 6]);
  var fanPole = shadowy(new T.Mesh(new T.CylinderGeometry(0.09, 0.09, 30, 12), new T.MeshStandardMaterial({ map: fanPoleTex, roughness: 0.5 })));
  fanPole.position.set(0, 15, -0.1); fan.add(fanPole);
  fan.position.set(0, wy(R.FAN_CY), FAN_Z); fan.visible = false;
  var fanShown = 0;

  // ---------------------------------------------------------------- cannon
  var cannon = new T.Group(); scene.add(cannon);
  // sit the cannon at the bottom centre of the design view, 9 units from the camera
  var CANNON_POS = (function () {
    var c = new T.PerspectiveCamera(36, 414 / 736, 0.1, 400); c.position.copy(CAM); c.lookAt(LOOK); c.updateMatrixWorld(true);
    var dir = new T.Vector3(0, -0.98, 0.5).unproject(c).sub(CAM).normalize();
    return CAM.clone().addScaledVector(dir, 11);
  })();
  cannon.position.copy(CANNON_POS); cannon.scale.setScalar(0.72);
  var blueMat = new T.MeshPhysicalMaterial({ color: 0x2f6fe8, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1 });
  var redMat = new T.MeshPhysicalMaterial({ color: 0xe0223a, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1 });
  var platPts = [[0, 0], [5, 0], [5, 0.35], [4.6, 0.55], [0, 0.55]].map(function (p) { return new T.Vector2(p[0], p[1]); });
  var plat = shadowy(new T.Mesh(new T.LatheGeometry(platPts, 64), new T.MeshStandardMaterial({ color: 0xf6e7cc, roughness: 0.6 }))); plat.position.y = -1.6; cannon.add(plat);
  var platRim = shadowy(new T.Mesh(new T.TorusGeometry(4.95, 0.22, 12, 64), gold)); platRim.rotation.x = Math.PI / 2; platRim.position.y = -1.15; cannon.add(platRim);
  var platRim2 = shadowy(new T.Mesh(new T.TorusGeometry(5.25, 0.2, 12, 64), purple)); platRim2.rotation.x = Math.PI / 2; platRim2.position.y = -1.3; cannon.add(platRim2);
  var yoke = new T.Group(); cannon.add(yoke);
  var bodyBall = shadowy(new T.Mesh(new T.SphereGeometry(1.15, 32, 24), redMat)); bodyBall.scale.set(1, 0.85, 1); bodyBall.position.y = -0.4; yoke.add(bodyBall);
  [-1, 1].forEach(function (s) {
    var wheel = shadowy(new T.Mesh(new T.CylinderGeometry(0.85, 0.85, 0.35, 32), blueMat)); wheel.rotation.z = Math.PI / 2; wheel.position.set(s * 1.25, -0.55, 0); yoke.add(wheel);
    var cap = new T.Mesh(new T.CylinderGeometry(0.3, 0.3, 0.38, 20), gold); cap.rotation.z = Math.PI / 2; cap.position.set(s * 1.27, -0.55, 0); yoke.add(cap);
  });
  var barrel = new T.Group(); barrel.position.y = 0.1; yoke.add(barrel);
  var barPts = [[0, -0.6], [0.78, -0.6], [0.82, -0.3], [0.7, 0.8], [0.62, 1.9], [0.78, 2.0], [0.8, 2.35], [0.5, 2.38], [0.42, 1.6], [0, 1.6]].map(function (p) { return new T.Vector2(p[0], p[1]); });
  barrel.add(shadowy(new T.Mesh(new T.LatheGeometry(barPts, 40), blueMat)));
  var band1 = shadowy(new T.Mesh(new T.TorusGeometry(0.69, 0.07, 10, 40), gold)); band1.rotation.x = Math.PI / 2; band1.position.y = 0.9; barrel.add(band1);
  var band2 = shadowy(new T.Mesh(new T.TorusGeometry(0.8, 0.08, 10, 40), gold)); band2.rotation.x = Math.PI / 2; band2.position.y = 2.18; barrel.add(band2);
  var muzzleDark = new T.Mesh(new T.CircleGeometry(0.5, 32), new T.MeshBasicMaterial({ color: 0x1a0508 })); muzzleDark.rotation.x = -Math.PI / 2; muzzleDark.position.y = 2.36; barrel.add(muzzleDark);
  var crown = new T.Mesh(new T.CylinderGeometry(0.28, 0.22, 0.25, 5), gold); crown.position.set(0, 1.25, 0.66); crown.rotation.x = Math.PI / 2; barrel.add(crown);
  var muzzleFlash = new T.Sprite(new T.SpriteMaterial({ map: softTex, color: 0xffe08a, blending: T.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  muzzleFlash.scale.set(3, 3, 1); scene.add(muzzleFlash);
  var aimTarget = new T.Vector3(0, 2, 0), aimNow = new T.Vector3(0, 2, 0), kick = 0;
  function muzzleWorld() { barrel.updateMatrixWorld(true); return barrel.localToWorld(new T.Vector3(0, 2.5, 0)); }
  function aimCannon() {
    aimNow.lerp(aimTarget, 0.35);
    var d = aimNow.clone().sub(CANNON_POS);
    var yaw = Math.atan2(d.x, -d.z);
    var pitch = Math.atan2(Math.sqrt(d.x * d.x + d.z * d.z), d.y);
    yoke.rotation.y = -yaw;
    barrel.rotation.x = -Math.min(1.35, Math.max(0.5, pitch));
    barrel.position.y = 0.1 - kick * 0.45;
  }

  // ---------------------------------------------------------------- balls
  var ballGeo = new T.SphereGeometry(0.3, 32, 20);
  var ballMat = new T.MeshPhysicalMaterial({ map: ballTex, roughness: 0.25, clearcoat: 1 });
  var flightMeshes = {}, looseMeshes = [];
  function syncBalls(S, frac) {
    var seen = {};
    for (var i = 0; i < S.flights.length; i++) {
      var f = S.flights[i], m = flightMeshes[f.n];
      if (!m) { m = flightMeshes[f.n] = shadowy(new T.Mesh(ballGeo, ballMat)); m.userData.from = muzzleWorld(); scene.add(m); }
      seen[f.n] = 1;
      var t = Math.min(1, (f.t + frac) / R.FLIGHT), from = m.userData.from;
      var to = new T.Vector3(wx(f.x), wy(f.y), FRONT + 0.15);
      m.position.lerpVectors(from, to, t);
      m.position.y += Math.sin(t * Math.PI) * 2.2;
      m.rotation.x -= 0.35; m.rotation.z += 0.12;
      m.scale.setScalar(1.25 - 0.25 * t);
      if (Math.random() < 0.8) spawnSoft(m.position, 0.35, 0xffffff, 0.35, 0.25, 0);
    }
    for (var n in flightMeshes) if (!seen[n]) { scene.remove(flightMeshes[n]); delete flightMeshes[n]; }
    while (looseMeshes.length < S.loose.length) { var lm = shadowy(new T.Mesh(ballGeo, ballMat)); scene.add(lm); looseMeshes.push(lm); }
    for (i = 0; i < looseMeshes.length; i++) {
      var lmm = looseMeshes[i], kk = S.loose[i];
      lmm.visible = !!kk;
      if (kk) { lmm.position.set(wx(kk.x), wy(kk.y), FRONT + 0.1); lmm.rotation.z -= kk.vx / 300; lmm.rotation.x += 0.2; }
    }
  }

  // ---------------------------------------------------------------- particles
  var G = -22;
  var TABLE_TOP = 0, TABLE_HALF = TABLE_W / 2, TABLE_Z = 1.05;
  function makePool(geo, mat, n) {
    var im = new T.InstancedMesh(geo, mat, n);
    im.instanceMatrix.setUsage(T.DynamicDrawUsage);
    im.castShadow = true;
    var col = new T.Color(1, 1, 1);
    for (var i = 0; i < n; i++) im.setColorAt(i, col);
    im.count = 0; im.frustumCulled = false; scene.add(im);
    return { im: im, items: [], max: n };
  }
  var shardGeo = (function () {
    var g = new T.BufferGeometry();
    var v = [0, 0.5, 0, -0.35, -0.4, 0.06, 0.4, -0.35, -0.04, 0, 0.5, 0, 0.4, -0.35, -0.04, -0.35, -0.4, 0.06];
    g.setAttribute('position', new T.Float32BufferAttribute(v, 3)); g.computeVertexNormals(); return g;
  })();
  var shardMat = new T.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, clearcoat: 1, side: T.DoubleSide, envMapIntensity: 1.8, emissive: 0x151515 });
  var shards = makePool(shardGeo, shardMat, 900);
  var needles = makePool(new T.BoxGeometry(1, 0.09, 0.09), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }), 500);
  needles.im.castShadow = false;
  var woodMat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, map: canvasTex(64, 64, function (g, w, h) { woodGrain(g, w, h, '#d29655', '80,40,10', 14); }) });
  var woods = makePool(new T.BoxGeometry(1, 1, 1), woodMat, 500);
  var confs = makePool(new T.PlaneGeometry(0.22, 0.12), new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide }), 260);
  confs.im.castShadow = false;
  var softs = [];
  var tmpM = new T.Matrix4(), tmpQ = new T.Quaternion(), tmpS = new T.Vector3(), XAX = new T.Vector3(1, 0, 0), tmpD = new T.Vector3();

  function addItem(pool, it) { if (pool.items.length >= pool.max) pool.items.shift(); pool.items.push(it); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function L(c) { return new T.Color(c).convertSRGBToLinear(); }
  function spawnSoft(pos, size, color, alpha, life, grow, additive, tex) {
    if (softs.length > 240) return null;
    var s = new T.Sprite(new T.SpriteMaterial({ map: tex || softTex, color: color, transparent: true, opacity: alpha, depthWrite: false, blending: additive ? T.AdditiveBlending : T.NormalBlending }));
    s.position.copy(pos); s.scale.setScalar(size); scene.add(s);
    var o = { s: s, life: life, max: life, grow: grow, a0: alpha, v: new T.Vector3() };
    softs.push(o); return o;
  }
  function glassBreak(cx, cy, w, h, col, power) {
    var c = L(GLASS[col]), lite = c.clone().lerp(new T.Color(1, 1, 1), 0.55), white = new T.Color(1, 1, 1);
    var n = Math.round(60 * power), i;
    for (i = 0; i < n; i++) {
      var p = new T.Vector3(cx + rnd(-w / 2, w / 2), cy + rnd(-h / 2, h / 2), rnd(-0.3, FRONT));
      var dir = new T.Vector3(p.x - cx, p.y - cy + 0.3, p.z + 0.6).normalize();
      addItem(shards, { p: p, v: dir.multiplyScalar(rnd(2.5, 8) * power).add(new T.Vector3(0, rnd(1, 4), 0)), r: new T.Euler(rnd(0, 6), rnd(0, 6), rnd(0, 6)),
        w: new T.Vector3(rnd(-14, 14), rnd(-14, 14), rnd(-14, 14)), s: rnd(0.12, 0.42), life: rnd(1.6, 2.8), col: Math.random() < 0.3 ? lite : Math.random() < 0.12 ? white : c, rest: 0 });
    }
    for (i = 0; i < 36; i++) {      // starburst of needles out of the hit point
      var a = Math.random() * Math.PI * 2, el = rnd(-0.5, 0.9);
      var d = new T.Vector3(Math.cos(a) * Math.cos(el), Math.sin(a) * Math.cos(el) * 0.9, Math.sin(el) * 0.8 + 0.3);
      addItem(needles, { p: new T.Vector3(cx, cy, FRONT * 0.8), v: d.multiplyScalar(rnd(9, 20)), len: rnd(0.4, 1.1), life: rnd(0.22, 0.45), col: Math.random() < 0.35 ? white : lite });
    }
    spawnSoft(new T.Vector3(cx, cy, FRONT + 0.2), 1.2, 0xffffff, 0.95, 0.18, 9, true);
    spawnSoft(new T.Vector3(cx, cy, FRONT + 0.1), 2.6, GLASS[col], 0.85, 0.35, 5, true);
    for (i = 0; i < 6; i++) { var sp3 = spawnSoft(new T.Vector3(cx, cy, FRONT + 0.2), rnd(0.5, 0.9), GLASS[col], 0.9, rnd(0.3, 0.5), 1.5); if (sp3) sp3.v.set(rnd(-5, 5), rnd(-1, 5), rnd(1, 3)); }
    for (i = 0; i < 12; i++) {
      var sp = spawnSoft(new T.Vector3(cx + rnd(-0.4, 0.4), cy + rnd(-0.5, 0.5), FRONT + 0.2), rnd(0.25, 0.5), 0xffffff, 1, rnd(0.4, 0.9), -0.2, true, starTex);
      if (sp) sp.v.set(rnd(-3, 3), rnd(0, 4), rnd(0, 2));
    }
  }
  var plankCols = [0xc98845, 0xa86a30, 0xdba062, 0x8f5523];
  function woodBreak(cx, cy, w, h, isLog) {
    var i, big = isLog ? 5 : 6;
    for (i = 0; i < big; i++) {      // the crate's own planks / log chunks fly apart
      var p = new T.Vector3(cx + rnd(-w / 2.5, w / 2.5), cy + rnd(-h / 3, h / 3), rnd(-0.3, 0.3));
      var v = new T.Vector3((p.x - cx) * 5 + rnd(-2, 2), rnd(3, 7), rnd(1, 4));
      var s = isLog ? new T.Vector3(rnd(0.5, 0.9), rnd(0.28, 0.45), rnd(0.3, 0.5)) : new T.Vector3(rnd(0.75, 0.95), rnd(0.18, 0.28), 0.07);
      addItem(woods, { p: p, v: v, r: new T.Euler(rnd(0, 3), rnd(0, 3), rnd(0, 3)), w: new T.Vector3(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8)), sv: s, life: rnd(2.2, 3.2),
        col: L(plankCols[i % 4]), rest: 0 });
    }
    for (i = 0; i < (isLog ? 30 : 22); i++) {
      addItem(woods, { p: new T.Vector3(cx + rnd(-w / 2, w / 2), cy + rnd(-h / 2, h / 2), rnd(0, FRONT)), v: new T.Vector3(rnd(-6, 6), rnd(1, 8), rnd(0, 5)),
        r: new T.Euler(rnd(0, 3), rnd(0, 3), rnd(0, 3)), w: new T.Vector3(rnd(-20, 20), rnd(-20, 20), rnd(-20, 20)),
        sv: new T.Vector3(rnd(0.15, 0.45), 0.04, 0.04), life: rnd(1.2, 2.2), col: L(plankCols[i % 4]), rest: 0 });
    }
    puff(cx, cy, 10, 0xe2c49a, 1.2);
  }
  function chips(cx, cy) {
    for (var i = 0; i < 10; i++) addItem(woods, { p: new T.Vector3(cx + rnd(-0.3, 0.3), cy + rnd(-0.3, 0.3), FRONT), v: new T.Vector3(rnd(-4, 4), rnd(1, 6), rnd(1, 4)),
      r: new T.Euler(0, 0, 0), w: new T.Vector3(rnd(-20, 20), rnd(-20, 20), 0), sv: new T.Vector3(rnd(0.08, 0.2), 0.04, 0.04), life: 1, col: L(0xdba062), rest: 0 });
    puff(cx, cy, 4, 0xe2c49a, 0.7);
  }
  function puff(cx, cy, n, col, s) {
    for (var i = 0; i < n; i++) {
      var d = spawnSoft(new T.Vector3(cx + rnd(-0.5, 0.5) * s, cy + rnd(-0.3, 0.3) * s, rnd(0, FRONT + 0.3)), rnd(0.6, 1.1) * s, col, 0.55, rnd(0.6, 1.1), 1.6);
      if (d) d.v.set(rnd(-1.2, 1.2), rnd(0.2, 1.2), rnd(-0.3, 0.6));
    }
  }
  function confetti() {
    var cs = [0xff2e48, 0xffc114, 0x1f86ff, 0x9b47ff, 0x22cc5e, 0xffffff];
    for (var i = 0; i < 220; i++) {
      var side = i % 2 ? 1 : -1;
      addItem(confs, { p: new T.Vector3(side * 4.5, 1, 2), v: new T.Vector3(-side * rnd(2, 9), rnd(8, 16), rnd(-2, 4)), r: new T.Euler(rnd(0, 6), rnd(0, 6), rnd(0, 6)),
        w: new T.Vector3(rnd(-10, 10), rnd(-10, 10), rnd(-10, 10)), life: rnd(2.5, 3.5), col: L(cs[i % cs.length]), conf: 1 });
    }
  }
  var tinkle = 0;
  function stepPool(pool, dt, opts) {
    var items = pool.items, out = [], i, it;
    for (i = 0; i < items.length; i++) {
      it = items[i];
      it.life -= dt;
      if (it.life <= 0) continue;
      if (opts.needle) { it.p.addScaledVector(it.v, dt); it.v.multiplyScalar(0.9); out.push(it); continue; }
      if (it.conf) {
        it.v.y += G * 0.25 * dt; it.v.multiplyScalar(0.985); if (it.v.y < -2.5) it.v.y = -2.5;
        it.p.addScaledVector(it.v, dt); it.r.x += it.w.x * dt; it.r.y += it.w.y * dt; it.r.z += it.w.z * dt; out.push(it); continue;
      }
      if (it.rest < 3) {
        it.v.y += G * dt;
        it.p.addScaledVector(it.v, dt);
        it.r.x += it.w.x * dt; it.r.y += it.w.y * dt; it.r.z += it.w.z * dt;
        var onTable = Math.abs(it.p.x) < TABLE_HALF && it.p.z < TABLE_Z && it.p.z > -TABLE_Z && it.p.y > TABLE_TOP - 0.3;
        var floorY = onTable ? TABLE_TOP : GROUND_Y;
        if (it.p.y < floorY + 0.03 && it.v.y < 0) {
          it.p.y = floorY + 0.03;
          if (it.v.y < -4 && opts.glass && Math.random() < 0.25) tinkle = Math.min(tinkle + 1, 6);
          it.v.y = -it.v.y * 0.32; it.v.x *= 0.55; it.v.z *= 0.55; it.w.multiplyScalar(0.45);
          it.rest += 1;
          if (it.rest >= 3) { it.v.set(0, 0, 0); it.w.set(0, 0, 0); }
        }
      }
      out.push(it);
    }
    pool.items = out;
    var im = pool.im;
    im.count = out.length;
    for (i = 0; i < out.length; i++) {
      it = out[i];
      var fade = Math.min(1, it.life / 0.4);
      if (opts.needle) {
        tmpS.set(it.len * Math.min(1, it.life * 5), 1, 1);
        tmpQ.setFromUnitVectors(XAX, tmpD.copy(it.v).normalize());
      } else {
        if (it.sv) tmpS.copy(it.sv).multiplyScalar(fade); else tmpS.setScalar((it.s || 1) * fade);
        tmpQ.setFromEuler(it.r);
      }
      tmpM.compose(it.p, tmpQ, tmpS);
      im.setMatrixAt(i, tmpM);
      im.setColorAt(i, it.col);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }
  function stepSofts(dt) {
    for (var i = softs.length - 1; i >= 0; i--) {
      var o = softs[i];
      o.life -= dt;
      if (o.life <= 0) { scene.remove(o.s); o.s.material.dispose(); softs.splice(i, 1); continue; }
      o.s.position.addScaledVector(o.v, dt);
      o.s.scale.multiplyScalar(1 + o.grow * dt);
      o.s.material.opacity = o.a0 * (o.life / o.max);
    }
  }

  // ---------------------------------------------------------------- HUD (DOM)
  var hud = document.getElementById('hud');
  var elBalls = document.getElementById('ballsN'), elScore = document.getElementById('score'), elTower = document.getElementById('tower');
  var elBanner = document.getElementById('banner'), elFloats = document.getElementById('floats');
  var elMenu = document.getElementById('menu'), elOver = document.getElementById('over'), elFinal = document.getElementById('finalScore'), elCleared = document.getElementById('cleared');
  var elMute = document.getElementById('mute');
  function layoutHud() {
    hud.style.left = fitRect.x + 'px'; hud.style.top = fitRect.y + 'px';
    hud.style.transform = 'scale(' + (fitRect.w / 414) + ')';
  }
  function toHud(v) {
    var p = v.clone().project(pickCam);
    return { x: (p.x + 1) / 2 * 414, y: (1 - p.y) / 2 * 736 };
  }
  function floatText(world, txt, cls) {
    var p = toHud(world), d = document.createElement('div');
    d.className = 'float ' + (cls || ''); d.textContent = txt;
    d.style.left = p.x + 'px'; d.style.top = p.y + 'px';
    elFloats.appendChild(d);
    setTimeout(function () { d.remove(); }, 1100);
  }
  var shownScore = 0, shownBalls = -1;
  function updateHud(S) {
    if (shownScore < S.score) shownScore = Math.min(S.score, shownScore + Math.max(1, Math.ceil((S.score - shownScore) / 8)));
    if (shownScore > S.score) shownScore = S.score;
    elScore.textContent = shownScore;
    if (shownBalls !== S.balls) {
      elBalls.textContent = S.balls; elBalls.parentNode.classList.toggle('low', S.balls <= 3);
      elBalls.parentNode.classList.remove('bump'); void elBalls.offsetWidth; elBalls.parentNode.classList.add('bump');
      shownBalls = S.balls;
    }
    elTower.textContent = 'TOWER ' + S.level;
  }
  function banner(txt, sub) {
    elBanner.innerHTML = '<b>' + txt + '</b><span>' + sub + '</span>';
    elBanner.classList.remove('show'); void elBanner.offsetWidth; elBanner.classList.add('show');
  }

  // ---------------------------------------------------------------- events -> effects
  var shake = 0, crushCool = 0;
  function handleEvents(S) {
    var ev = S.events; S.events = [];
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i], q;
      switch (e.e) {
        case 'fire': {
          A.play('cannon'); kick = 1; shake = Math.max(shake, 0.12);
          aimTarget.set(wx(e.x), wy(e.y), FRONT); aimNow.copy(aimTarget); aimCannon();
          var mz = muzzleWorld();
          muzzleFlash.position.copy(mz); muzzleFlash.material.opacity = 1;
          for (q = 0; q < 7; q++) { var sm = spawnSoft(mz.clone(), rnd(0.8, 1.4), 0xf4ecdf, 0.75, rnd(0.5, 0.9), 1.4); if (sm) sm.v.set(rnd(-1.5, 1.5), rnd(0.5, 2.5), rnd(-1, 1)); }
          break;
        }
        case 'break': {
          var w = e.w / U / PX, h = e.h / U / PX, cx = wx(e.x + e.w / 2), cy = wy(e.y) + h / 2;
          if (e.t === 'g') { glassBreak(cx, cy, w, h, e.col, e.how === 'shot' ? 1.15 : 0.9); A.play('glass', e.how !== 'ball'); }
          else { woodBreak(cx, cy, w, h, e.t === 'l'); A.play('woodBreak', e.t === 'l'); }
          shake = Math.max(shake, e.t === 'l' ? 0.3 : e.how === 'crush' ? 0.22 : 0.16);
          floatText(new T.Vector3(cx, cy, FRONT), '+' + e.pts, e.how === 'crush' ? 'gold' : '');
          if (e.how === 'crush' && crushCool <= 0) { floatText(new T.Vector3(cx, cy + 0.7, FRONT), 'CRUSH!', 'gold big'); crushCool = 0.4; }
          break;
        }
        case 'crack': {
          var ccx = wx(e.x + e.w / 2), ccy = wy(e.y) + e.h / U / PX / 2;
          chips(ccx, ccy); A.play('woodHit'); shake = Math.max(shake, 0.1);
          for (var id in blockMeshes) { var bm = blockMeshes[id]; if (Math.abs(bm.g.position.x - ccx) < 0.9 && Math.abs(bm.g.position.y + bm.h / 2 - ccy) < 0.7) bm.hitWob = 0.06; }
          break;
        }
        case 'thud':
          if (e.ball) { A.play('ballBounce', e.v); break; }
          puff(wx(e.x), wy(e.y), e.v > 100 ? 6 : 3, 0xf0e2cc, 0.8);
          A.play('thud', e.v, e.t); shake = Math.max(shake, Math.min(0.2, e.v / 900));
          break;
        case 'fan': {
          A.play('fan');
          var fp = new T.Vector3(wx(e.x), wy(e.y), FAN_Z);
          floatText(fp, 'BLOCKED', 'red');
          for (q = 0; q < 10; q++) { var sp = spawnSoft(fp, 0.4, 0xffffff, 1, 0.4, 0, true, starTex); if (sp) sp.v.set(rnd(-4, 4), rnd(-2, 4), rnd(0, 3)); }
          addItem(woods, { p: fp.clone(), v: new T.Vector3(rnd(-4, 4), 5, 6), r: new T.Euler(), w: new T.Vector3(5, 5, 5), sv: new T.Vector3(0.5, 0.5, 0.5), life: 1.6, col: L(0xe8243a), rest: 0 });
          break;
        }
        case 'miss': A.play('whoosh'); break;
        case 'clear': banner('SAAF!', '+' + e.bonus); A.play('clear'); confetti(); break;
        case 'tower':
          if (e.level > 1) { floatText(new T.Vector3(0, 6.2, 0), '+' + e.add + ' BALLS', 'green big'); A.play('reload'); }
          break;
        case 'over': A.play('over'); break;
      }
    }
  }

  // ---------------------------------------------------------------- loop + input
  var params = new URLSearchParams(location.search);
  var seedArg = params.get('seed');
  function newSeed() { return seedArg ? (parseInt(seedArg, 10) >>> 0) : ((Math.random() * 4294967296) >>> 0); }
  var S = R.initSim(newSeed()); S.events = [];
  var mode = 'menu', acc = 0, last = null, STEP = 1000 / 60;

  var ray = new T.Raycaster(), plane = new T.Plane(new T.Vector3(0, 0, 1), -FRONT), hitP = new T.Vector3();
  function tapToSim(cx, cy) {
    var nx = (cx - fitRect.x) / fitRect.w * 2 - 1, ny = -((cy - fitRect.y) / fitRect.h * 2 - 1);
    ray.setFromCamera({ x: nx, y: ny }, pickCam);
    if (!ray.ray.intersectPlane(plane, hitP)) return null;
    return { x: Math.round((hitP.x * PX + 207) * U), y: Math.round(R.FLOOR - hitP.y * PX * U) };
  }
  canvas.addEventListener('pointerdown', function (ev) {
    if (!ev.isPrimary || mode !== 'play') return;
    ev.preventDefault();
    A.init();
    var p = tapToSim(ev.clientX, ev.clientY);
    if (p) R.shoot(S, p.x, p.y);
  });
  document.getElementById('playBtn').addEventListener('click', function () { A.init(); mode = 'play'; elMenu.classList.add('hide'); });
  document.getElementById('againBtn').addEventListener('click', function () {
    A.init(); S = R.initSim(newSeed()); S.events = []; shownScore = 0; mode = 'play'; elOver.classList.add('hide');
  });
  var muted = false;
  elMute.addEventListener('click', function () { muted = !muted; A.mute(muted); elMute.classList.toggle('off', muted); });

  function frame(now) {
    if (last === null) last = now;
    var dtMs = Math.min(now - last, STEP * 3); last = now;
    acc += dtMs;
    var dt = dtMs / 1000;
    perfT += dt;
    while (acc >= STEP) {
      acc -= STEP;
      if (mode === 'play') {
        R.stepSim(S);
        handleEvents(S);
        if (S.phase === 'over') {
          mode = 'over'; elFinal.textContent = S.score; elCleared.textContent = S.level - 1;
          setTimeout(function () { elOver.classList.remove('hide'); }, 300);
        }
      }
    }
    var frac = acc / STEP;
    syncBlocks(S, dt);
    syncBalls(S, frac);
    fanShown += ((S.fan ? 1 : 0) - fanShown) * Math.min(1, dt * 3.5);
    fan.visible = fanShown > 0.02;
    if (S.fan) fanRot.rotation.z = -S.fan.ang / 256 * Math.PI * 2;
    fan.position.y = wy(R.FAN_CY) + (1 - fanShown) * 14;
    stepPool(shards, dt, { glass: 1 });
    stepPool(needles, dt, { needle: 1 });
    stepPool(woods, dt, {});
    stepPool(confs, dt, {});
    stepSofts(dt);
    if (tinkle > 0 && Math.random() < 0.3) { A.play('tinkle'); tinkle -= 1; }
    crushCool -= dt;
    kick *= 0.86; aimCannon();
    muzzleFlash.material.opacity *= 0.78;
    for (var c = 0; c < clouds.length; c++) { clouds[c].position.x += dt * (0.4 + c * 0.15); if (clouds[c].position.x > 100) clouds[c].position.x = -100; }
    shake *= 0.86;
    camera.position.set(CAM.x + (Math.random() - 0.5) * shake, CAM.y + (Math.random() - 0.5) * shake, CAM.z);
    camera.lookAt(LOOK);
    updateHud(S);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  // material colours are written as sRGB hex; convert once to the linear space three.js lights in
  scene.traverse(function (o) {
    var ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    ms.forEach(function (m) {
      if (m.userData.lin || o.isInstancedMesh) return; m.userData.lin = 1;
      if (m.envMapIntensity === 1) m.envMapIntensity = 0.45;
      if (m.color && !m.map) m.color.convertSRGBToLinear();
      if (m.emissive) m.emissive.convertSRGBToLinear();
    });
  });
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);

  window.__kt = { get S() { return S; }, initSim: R.initSim, stepSim: R.stepSim, shoot: R.shoot, U: U, tapToSim: tapToSim,
    simToScreen: function (x, y) { var p = new T.Vector3(wx(x), wy(y), FRONT).project(pickCam); return { x: fitRect.x + (p.x + 1) / 2 * fitRect.w, y: fitRect.y + (1 - p.y) / 2 * fitRect.h }; } };
})();
