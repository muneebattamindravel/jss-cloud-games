/* Smash It: the 3D view, effects, HUD and input.
   Rules and physics live in rules.js (window.KTRules, Rapier deterministic).
   This file only READS the sim: block meshes follow their rigid bodies, the
   painted backdrop is a pre-rendered image (tools/scenery.js), and every effect here is cosmetic
   (Math.random is fine). A tap is raycast onto the tower face and sent to the
   rules as an integer target point. */
(function () {
  'use strict';
  // a local handle on Math: the texture painters call it per pixel, and a closure lookup is cheap everywhere
  var Math = window.Math;
  var R = window.KTRules, A = window.KTAudio, T = window.THREE;
  // pre-rendered backdrops (painted by tools/scenery.js): 640 x 736 design px, 113 px of side margin, horizon at 232
  var SC = { MARGIN: 113, DW: 640, DH: 736 };
  var GROUND_Y = -3.3, PITCH = 0.12, FOV = 36, TANH = Math.tan(FOV / 2 * Math.PI / 180), ASPECT = 414 / 736;

  // ---------------------------------------------------------------- renderer
  var canvas = document.getElementById('game');
  var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2.5, window.devicePixelRatio || 1));
  renderer.outputEncoding = T.sRGBEncoding;
  // every asset is unlit: shading is baked into matcap and colour textures, so no lights or shadow maps
  renderer.toneMapping = T.NoToneMapping;
  renderer.autoClear = false;

  var scene = new T.Scene();
  var camera = new T.PerspectiveCamera(FOV, ASPECT, 0.1, 300);
  var pickCam = new T.PerspectiveCamera(FOV, ASPECT, 0.1, 300);
  var camState = { d: 24, look: 2.2, d0: 24, look0: 2.2, t: 1 };
  var fitRect = { x: 0, y: 0, w: 414, h: 736 };
  function placeCam(cam, d, lookY) {
    var dir = new T.Vector3(0, -PITCH, -1).normalize();
    cam.position.set(0, lookY - dir.y * d, -dir.z * d);
    cam.lookAt(0, lookY, 0);
    cam.updateMatrixWorld(true);
  }

  // painted backdrop: a full-screen quad drawn first, mapped so the 414x736 design rect lines up
  var bgScene = new T.Scene(), bgCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  var bgGeo = new T.PlaneGeometry(2, 2);
  var bgMat = new T.MeshBasicMaterial({ depthWrite: false, depthTest: false, toneMapped: false });
  bgScene.add(new T.Mesh(bgGeo, bgMat));
  var bgTex = {}, bgLoader = new T.TextureLoader();
  function backdrop(theme) {
    if (!bgTex[theme]) {
      var t = bgLoader.load('img/backdrop-' + theme + '.jpg');
      t.encoding = T.sRGBEncoding; t.minFilter = T.LinearFilter; t.generateMipmaps = false;
      bgTex[theme] = t;
    }
    return bgTex[theme];
  }
  // the painted backdrop covers the whole screen at one scale, with its horizon pinned to the
  // 3D horizon, so tall and wide screens get more picture instead of stretched edge pixels
  var HORIZON = 232;
  function layoutBackdrop(w, h) {
    var uv = bgGeo.attributes.uv, k = fitRect.w / 414;
    var hs = fitRect.y + HORIZON * k;                                  // screen y of the horizon
    var sc = Math.max(k, w / SC.DW, hs / HORIZON, (h - hs) / (SC.DH - HORIZON));
    function u(sx) { return ((sx - w / 2) / sc + SC.DW / 2) / SC.DW; }
    function v(sy) { return 1 - ((sy - hs) / sc + HORIZON) / SC.DH; }
    uv.setXY(0, u(0), v(0)); uv.setXY(1, u(w), v(0)); uv.setXY(2, u(0), v(h)); uv.setXY(3, u(w), v(h));
    uv.needsUpdate = true;
  }

  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    var s = Math.min(w / 414, h / 736), dw = 414 * s, dh = 736 * s;
    fitRect = { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
    camera.aspect = ASPECT;
    camera.setViewOffset(dw, dh, -fitRect.x, -fitRect.y, w, h);
    camera.updateProjectionMatrix();
    layoutBackdrop(w, h);
    layoutHud();
  }

  // ---------------------------------------------------------------- texture helpers
  function canvasEl(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function tex(c, srgb, rep) {
    var t = new T.CanvasTexture(c);
    if (srgb) t.encoding = T.sRGBEncoding;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (rep) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(rep[0], rep[1]); }
    return t;
  }
  // normal map from a height canvas (white = high)
  function normalFrom(hc, strength) {
    var w = hc.width, h = hc.height, src = hc.getContext('2d').getImageData(0, 0, w, h).data;
    var out = canvasEl(w, h), og = out.getContext('2d'), img = og.createImageData(w, h), d = img.data;
    function H(x, y) { x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y)); return src[(y * w + x) * 4] / 255; }
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      var nx = -dx, ny = dy, nz = 1, l = Math.sqrt(nx * nx + ny * ny + nz * nz), i = (y * w + x) * 4;
      d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
    og.putImageData(img, 0, 0);
    return tex(out, false);
  }
  function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function crownPath(g, cx, cy, s) {
    g.beginPath();
    g.moveTo(cx - 22 * s, cy + 14 * s); g.lineTo(cx - 26 * s, cy - 12 * s); g.lineTo(cx - 12 * s, cy - 1 * s); g.lineTo(cx, cy - 18 * s);
    g.lineTo(cx + 12 * s, cy - 1 * s); g.lineTo(cx + 26 * s, cy - 12 * s); g.lineTo(cx + 22 * s, cy + 14 * s); g.closePath();
  }
  // a face: raised frame, recessed panel, optional embossed crown
  function panelHeight(w, h, crown, blur) {
    var c = canvasEl(w, h), g = c.getContext('2d');
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, w, h);
    g.filter = 'blur(' + blur + 'px)';
    var m = Math.round(Math.min(w, h) * 0.14);
    g.fillStyle = '#5a5a5a'; rrect(g, m, m, w - 2 * m, h - 2 * m, m * 0.6); g.fill();
    if (crown) { g.fillStyle = '#c8c8c8'; crownPath(g, w / 2, h * 0.38, w / 140); g.fill(); }
    g.filter = 'none';
    // soft outer bevel
    var gr = g.createLinearGradient(0, 0, 0, 6);
    return c;
  }
  function paintPanel(base, light, dark, w, h, crown) {
    var c = canvasEl(w, h), g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    var m = Math.round(Math.min(w, h) * 0.14);
    var gr = g.createLinearGradient(0, m, 0, h - m);
    gr.addColorStop(0, dark); gr.addColorStop(0.5, base); gr.addColorStop(1, dark);
    g.fillStyle = gr; rrect(g, m, m, w - 2 * m, h - 2 * m, m * 0.6); g.fill();
    g.globalAlpha = 0.35; g.fillStyle = light; rrect(g, 3, 3, w - 6, m * 0.5, m * 0.3); g.fill(); g.globalAlpha = 1;
    if (crown) { g.fillStyle = light; g.globalAlpha = 0.45; crownPath(g, w / 2, h * 0.38, w / 140); g.fill(); g.globalAlpha = 1; }
    return c;
  }
  function woodPanel(w, h, cells) {
    var c = canvasEl(w, h), g = c.getContext('2d');
    g.fillStyle = '#e08a3c'; g.fillRect(0, 0, w, h);
    var m = Math.round(Math.min(w, h) * 0.13);
    // grain on the frame and the inset
    function grain(x, y, ww, hh, vertical, col) {
      g.save(); g.beginPath(); g.rect(x, y, ww, hh); g.clip();
      for (var i = 0; i < 26; i++) {
        g.strokeStyle = col.replace('A', (0.10 + Math.random() * 0.18).toFixed(2)); g.lineWidth = 1 + Math.random() * 2.5;
        g.beginPath();
        if (vertical) { var gx = x + Math.random() * ww; g.moveTo(gx, y); g.bezierCurveTo(gx + 6, y + hh * 0.3, gx - 6, y + hh * 0.6, gx + 3, y + hh); }
        else { var gy = y + Math.random() * hh; g.moveTo(x, gy); g.bezierCurveTo(x + ww * 0.3, gy + 5, x + ww * 0.6, gy - 5, x + ww, gy + 2); }
        g.stroke();
      }
      // a couple of grain arcs like the reference's cartoon wood
      g.strokeStyle = 'rgba(150,70,20,0.35)'; g.lineWidth = 2.5;
      for (i = 0; i < 2; i++) { var ax = x + ww * (0.3 + i * 0.35), ay = y + hh * 0.55; g.beginPath(); g.ellipse(ax, ay, ww * 0.08, hh * 0.28, 0, Math.PI * 1.05, Math.PI * 1.95); g.stroke(); }
      g.restore();
    }
    grain(0, 0, w, h, cells === 1, 'rgba(160,80,25,A)');
    g.fillStyle = '#c86f28'; rrect(g, m, m, w - 2 * m, h - 2 * m, m * 0.4); g.fill();
    grain(m, m, w - 2 * m, h - 2 * m, cells === 1, 'rgba(120,55,15,A)');
    g.fillStyle = 'rgba(255,220,160,0.35)'; g.fillRect(0, 0, w, 4); g.fillRect(m, h - m - 3, w - 2 * m, 3);
    g.fillStyle = 'rgba(90,40,10,0.35)'; g.fillRect(m, m, w - 2 * m, 3);
    return c;
  }
  function crackOverlay(c, n) {
    var o = canvasEl(c.width, c.height), g = o.getContext('2d');
    g.drawImage(c, 0, 0);
    g.strokeStyle = 'rgba(60,25,5,0.85)'; g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round';
    for (var i = 0; i < n; i++) {
      var x = c.width * (0.25 + Math.random() * 0.5), y = c.height * (0.2 + Math.random() * 0.6);
      g.beginPath(); g.moveTo(x, y);
      for (var k = 0; k < 4; k++) { x += (Math.random() - 0.5) * c.width * 0.3; y += (Math.random() - 0.5) * c.height * 0.3; g.lineTo(x, y); }
      g.stroke();
    }
    return o;
  }

  // ---------------------------------------------------------------- geometry helpers
  function roundedBox(w, h, d, r, seg) {
    var g = new T.BoxGeometry(w, h, d, seg, seg, seg), p = g.attributes.position, n = g.attributes.normal;
    var hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r, v = new T.Vector3(), c = new T.Vector3();
    for (var i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      c.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
      v.sub(c).normalize();
      n.setXYZ(i, v.x, v.y, v.z);
      p.setXYZ(i, c.x + v.x * r, c.y + v.y * r, c.z + v.z * r);
    }
    p.needsUpdate = true; n.needsUpdate = true;
    return g;
  }
  // ---- matcaps: a painted sphere per material holds all of its shading and shine
  var mcCache = {};
  function matcapTex(css, gloss, kind) {
    var key = css + '|' + gloss + '|' + (kind || '');
    if (mcCache[key]) return mcCache[key];
    var N = 256, c = canvasEl(N, N), g = c.getContext('2d'), img = g.createImageData(N, N), d = img.data;
    var base = new T.Color(css), lx = -0.42, ly = 0.62, lz = 0.66, hx = lx, hy = ly, hz = lz + 1, hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    hx /= hl; hy /= hl; hz /= hl;
    var shin = 10 + gloss * 70;
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) {
      var x = (i + 0.5) / N * 2 - 1, y = 1 - (j + 0.5) / N * 2, r2 = x * x + y * y, k = (j * N + i) * 4;
      if (r2 > 1) { x /= Math.sqrt(r2) * 1.0001; y /= Math.sqrt(r2) * 1.0001; r2 = 0.9999; }
      var z = Math.sqrt(1 - r2);
      var dif = Math.max(0, x * lx + y * ly + z * lz);
      var shade = 0.76 + 0.42 * dif;
      shade += 0.12 * Math.max(0, -y) * (1 - z);                    // warm bounce from below
      shade *= 1 - 0.24 * Math.pow(1 - z, 2.2);                      // soft rim falloff
      var sky = gloss * 0.3 * Math.pow(Math.max(0, y), 1.6) * Math.pow(1 - z, 0.8);   // sky reflection on the upper side
      var spec = Math.pow(Math.max(0, x * hx + y * hy + z * hz), shin) * (0.35 + gloss * 1.1) + sky;
      if (kind === 'jar') {                                          // two vertical glints like a glossy jar
        spec += 0.75 * Math.exp(-Math.pow((x + 0.5) / 0.07, 2)) * (1 - Math.abs(y) * 0.6);
        spec += 0.3 * Math.exp(-Math.pow((x - 0.55) / 0.05, 2)) * (1 - Math.abs(y) * 0.6);
      }
      var rim = kind === 'jar' ? 0.18 * Math.pow(1 - z, 3) : 0.08 * Math.pow(1 - z, 3);
      var cr = base.r * shade, cg = base.g * shade, cb = base.b * shade, lum = (cr + cg + cb) / 3, sat = kind === 'neutral' ? 1 : 1.18;
      cr = lum + (cr - lum) * sat; cg = lum + (cg - lum) * sat; cb = lum + (cb - lum) * sat;
      d[k] = Math.max(0, Math.min(255, (cr + spec + rim) * 255));
      d[k + 1] = Math.max(0, Math.min(255, (cg + spec + rim) * 255));
      d[k + 2] = Math.max(0, Math.min(255, (cb + spec + rim) * 255));
      d[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    var t = tex(c, true); mcCache[key] = t; return t;
  }
  function srgbStyle(col) { var c = new T.Color(col); if (c.r <= 1 && col && col.isColor) c = col.clone().convertLinearToSRGB(); return '#' + c.getHexString(); }
  // one material factory for everything: textured or coloured, always unlit (matcap)
  function mat(o) {
    var gloss = o.clearcoat !== undefined ? Math.min(1, o.clearcoat * 0.8 + (1 - (o.roughness || 0.5)) * 0.4) : (1 - (o.roughness === undefined ? 0.6 : o.roughness)) * 0.6;
    var p = { matcap: o.map ? matcapTex('#ffffff', Math.max(0.45, gloss), 'neutral') : matcapTex(srgbStyle(o.color === undefined ? 0xffffff : o.color), gloss, o.kind) };
    if (o.map) p.map = o.map;
    if (o.normalMap) { p.normalMap = o.normalMap; p.normalScale = o.normalScale; }
    ['transparent', 'opacity', 'side', 'depthWrite'].forEach(function (k) { if (o[k] !== undefined) p[k] = o[k]; });
    return new T.MeshMatcapMaterial(p);
  }
  var phys = mat;
  function L(c) { return new T.Color(c).convertSRGBToLinear(); }

  // ---------------------------------------------------------------- environment light
  // ground: shadow catcher on the painted grass / sea
  var blobTex = (function () { var c = canvasEl(128, 128), g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 64); gr.addColorStop(0, 'rgba(20,40,10,0.55)'); gr.addColorStop(0.6, 'rgba(20,40,10,0.28)'); gr.addColorStop(1, 'rgba(20,40,10,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return tex(c, false); })();
  var slabShadowTex = (function () { var c = canvasEl(256, 256), g = c.getContext('2d'); g.filter = 'blur(14px)'; g.fillStyle = 'rgba(20,45,10,0.42)'; g.fillRect(40, 40, 176, 176); return tex(c, false); })();
  function blob(w, d, map, op) { var m = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: map || blobTex, transparent: true, depthWrite: false, opacity: op || 1 })); m.rotation.x = -Math.PI / 2; m.scale.set(w, d, 1); return m; }
  var shadowGround = new T.Group(); scene.add(shadowGround);
  var dirtTex = (function () {
    var c = canvasEl(512, 512), g = c.getContext('2d');
    var gr = g.createRadialGradient(256, 256, 30, 256, 256, 256);
    gr.addColorStop(0, '#d9a868'); gr.addColorStop(0.7, '#cd9a5c'); gr.addColorStop(0.86, 'rgba(160,130,60,0.9)'); gr.addColorStop(1, 'rgba(110,150,50,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
    for (var i = 0; i < 500; i++) { var a = Math.random() * Math.PI * 2, d = Math.random() * 200; g.fillStyle = Math.random() < 0.5 ? 'rgba(130,85,40,0.35)' : 'rgba(245,215,170,0.45)'; g.beginPath(); g.ellipse(256 + Math.cos(a) * d, 256 + Math.sin(a) * d, 2 + Math.random() * 4, 1.5 + Math.random() * 2, 0, 0, 7); g.fill(); }
    for (i = 0; i < 60; i++) { var a2 = Math.random() * Math.PI * 2; g.strokeStyle = '#5ea42e'; g.lineWidth = 2; var x = 256 + Math.cos(a2) * 222, y = 256 + Math.sin(a2) * 222; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 6, y - 10); g.stroke(); }
    return tex(c, true);
  })();
  var dirt = new T.Mesh(new T.CircleGeometry(1, 64), mat({ map: dirtTex, transparent: true, roughness: 1, depthWrite: false }));
  dirt.rotation.x = -Math.PI / 2; dirt.position.y = GROUND_Y + 0.01; dirt.receiveShadow = true; scene.add(dirt);
  var water = new T.Mesh(new T.PlaneGeometry(80, 60), phys({ color: L('#1aa3e0'), transparent: true, opacity: 0.55, roughness: 0.1, clearcoat: 1, depthWrite: false }));
  water.rotation.x = -Math.PI / 2; water.position.y = GROUND_Y + 0.02; water.receiveShadow = true; scene.add(water);

  // ---------------------------------------------------------------- materials
  var GLASS = ['#1677ff', '#ee1a32', '#ffae00', '#8f2cff', '#16c043'];
  // crown bricks in seven colours, plus slot 7: castle stone (blue-grey with a gold battlement band)
  var panelHeightMap = normalFrom(panelHeight(256, 340, true, 3), 7);
  var BRICK = ['#e21a2c', '#ffb80a', '#8a2ef0', '#2a7ff0', '#22b84a', '#ff7a1a', '#f04ab0'];
  function stonePanel(w, h) {
    var c = canvasEl(w, h), g = c.getContext('2d');
    g.fillStyle = '#9db3e0'; g.fillRect(0, 0, w, h);
    var m = Math.round(w * 0.1);
    g.fillStyle = '#b8cbef'; rrect(g, m, m, w - 2 * m, h - 2 * m, m * 0.5); g.fill();
    var by = h * 0.36, bh = h * 0.28;
    g.fillStyle = '#ffc72c'; g.fillRect(0, by, w, bh);
    g.fillStyle = '#9db3e0';
    for (var i = 0; i < 4; i++) { var x = (i + 0.25) * w / 4; g.fillRect(x, by + bh * 0.3, w / 8, bh * 0.7); }
    g.fillStyle = '#d98a00'; g.fillRect(0, by + bh - 6, w, 6);
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillRect(0, by, w, 5);
    return c;
  }
  var brickTex = {};
  function brickMat(col, tall) {
    var key = col + (tall ? 't' : '');
    if (brickTex[key]) return brickTex[key];
    var w = 256, h = tall ? 680 : 340, c;
    if (col === 7) c = stonePanel(w, h);
    else { var base = new T.Color(BRICK[col]), lite = base.clone().lerp(new T.Color(1, 1, 1), 0.38).getStyle(), dark = base.clone().multiplyScalar(0.84).getStyle(); c = paintPanel(BRICK[col], lite, dark, w, h, true); }
    brickTex[key] = phys({ map: tex(c, true), normalMap: tall ? panelHeightTall() : panelHeightMap, normalScale: new T.Vector2(1.1, 1.1), roughness: 0.3, clearcoat: 0.7 });
    return brickTex[key];
  }
  var tallNormal = null;
  function panelHeightTall() { return tallNormal || (tallNormal = normalFrom(panelHeight(256, 680, true, 3), 7)); }
  // ice: pale translucent blocks with a wave pattern, cracked after the first hit
  function icePanel(cracks) {
    var c = canvasEl(256, 340), g = c.getContext('2d');
    g.fillStyle = '#d6f2ff'; g.fillRect(0, 0, 256, 340);
    g.strokeStyle = '#ffffff'; g.lineWidth = 7; g.lineCap = 'round';
    for (var r = 0; r < 3; r++) { var y = 90 + r * 80; g.beginPath(); for (var x = 20; x <= 236; x += 4) { var yy = y + Math.sin(x / 18) * 10; if (x === 20) g.moveTo(x, yy); else g.lineTo(x, yy); } g.stroke(); }
    g.strokeStyle = 'rgba(120,190,230,0.7)'; g.lineWidth = 6; rrect(g, 12, 12, 232, 316, 24); g.stroke();
    if (cracks) { g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 4; for (var i = 0; i < 5; i++) { var px = 60 + Math.random() * 140, py = 60 + Math.random() * 220; g.beginPath(); g.moveTo(px, py); for (var k = 0; k < 4; k++) { px += (Math.random() - 0.5) * 90; py += (Math.random() - 0.5) * 90; g.lineTo(px, py); } g.stroke(); } }
    return c;
  }
  var iceMats = [0, 1].map(function (k) { return mat({ map: tex(icePanel(k), true), clearcoat: 1, roughness: 0.05, transparent: true, opacity: 0.88 }); });
  var woodCanvas = { 1: woodPanel(256, 340, 1), 2: woodPanel(512, 220, 2), 3: woodPanel(768, 220, 3) };
  var woodNormal = { 1: normalFrom(panelHeight(256, 340, false, 4), 5), 2: normalFrom(panelHeight(512, 220, false, 4), 5), 3: normalFrom(panelHeight(768, 220, false, 4), 5) };
  function woodMat(span, cracks) {
    var c = cracks ? crackOverlay(woodCanvas[span], cracks) : woodCanvas[span];
    return mat({ map: tex(c, true), normalMap: woodNormal[span], normalScale: new T.Vector2(1, 1), roughness: 0.62, envMapIntensity: 0.5 });
  }
  var woodMats = { 1: [woodMat(1, 0), woodMat(1, 4)], 2: [woodMat(2, 0), woodMat(2, 3), woodMat(2, 6)], 3: [woodMat(3, 0), woodMat(3, 4), woodMat(3, 8)] };
  // painted glints: an emissive map adds the two bright vertical highlights the reference jars have
  var jarGlint = (function () {
    var c = canvasEl(256, 64), g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 256, 64);
    function band(u, w, a) { var x = u * 256, gr = g.createLinearGradient(x - w, 0, x + w, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,' + a + ')'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x - w, 6, w * 2, 52); }
    band(0.18, 9, 0.85); band(0.30, 5, 0.35); band(0.43, 14, 0.12);
    return tex(c, true);
  })();
  var glassMats = GLASS.map(function (c) {
    return mat({ color: c, clearcoat: 1, roughness: 0.1, kind: 'jar' });
  });
  function stripeLid(c) {
    var cv = canvasEl(512, 64), g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 64);
    g.fillStyle = c; for (var i = 0; i < 32; i++) g.fillRect(i * 16, 0, 8, 64);
    var sh = g.createLinearGradient(0, 0, 0, 64); sh.addColorStop(0, 'rgba(255,255,255,0.4)'); sh.addColorStop(0.4, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.25)');
    g.fillStyle = sh; g.fillRect(0, 0, 512, 64);
    return tex(cv, true);
  }
  var lidMats = GLASS.map(function (c) { return [phys({ map: stripeLid(c), roughness: 0.35, clearcoat: 0.6 }), phys({ color: 0xffffff, roughness: 0.4, clearcoat: 0.5 }), phys({ color: 0xffffff, roughness: 0.4 })]; });

  // ---------------------------------------------------------------- block geometry
  var geoCache = {};
  function jarGeo(h) {
    var key = 'j' + h.toFixed(3);
    if (geoCache[key]) return geoCache[key];
    var r = 0.47, b = 0.13, pts = [], i, a, lid = 0.17;
    pts.push(new T.Vector2(0, -h / 2));
    for (i = 0; i <= 8; i++) { a = -Math.PI / 2 + i / 8 * Math.PI / 2; pts.push(new T.Vector2(r - b + Math.cos(a) * b, -h / 2 + b + Math.sin(a) * b)); }
    for (i = 0; i <= 8; i++) { a = i / 8 * Math.PI / 2; pts.push(new T.Vector2(r - b + Math.cos(a) * b, h / 2 - lid - b + Math.sin(a) * b)); }
    pts.push(new T.Vector2(r - 0.08, h / 2 - lid + 0.02)); pts.push(new T.Vector2(0, h / 2 - lid + 0.02));
    geoCache[key] = new T.LatheGeometry(pts, 48);
    return geoCache[key];
  }
  var lidGeo = new T.CylinderGeometry(0.455, 0.47, 0.19, 48);
  function boxGeo(w, h) { var key = 'b' + w.toFixed(2) + 'x' + h.toFixed(2); return geoCache[key] || (geoCache[key] = roundedBox(w - 0.012, h - 0.008, R.DEPTH - 0.01, 0.07, 5)); }

  function makeBlockMesh(b) {
    var g = new T.Group(), m;
    if (b.t === 'jar') {
      m = new T.Mesh(jarGeo(b.h - 0.01), glassMats[b.col]); m.castShadow = m.receiveShadow = true; g.add(m);
      var lid = new T.Mesh(lidGeo, lidMats[b.col]); lid.position.y = b.h / 2 - 0.1; lid.castShadow = true; g.add(lid);
    } else if (b.t === 'bomb') {
      m = new T.Mesh(barrelGeo(b.h - 0.02), bombMats); g.add(m);
      var fuse = new T.Mesh(new T.CylinderGeometry(0.035, 0.035, 0.3, 8), mat({ color: '#3a2a1a' })); fuse.position.set(0.12, b.h / 2 + 0.12, 0); fuse.rotation.z = -0.4; g.add(fuse);
      var spark = new T.Sprite(new T.SpriteMaterial({ map: starTex, color: 0xffd060, blending: T.AdditiveBlending, depthWrite: false, transparent: true }));
      spark.position.set(0.19, b.h / 2 + 0.27, 0.05); spark.scale.setScalar(0.45); g.add(spark); g.userData.spark = spark;
    } else if (b.t === 'brick') {
      m = new T.Mesh(boxGeo(b.w, b.h), brickMat(b.col, b.h > 2)); g.add(m);
    } else if (b.t === 'ice') {
      m = new T.Mesh(boxGeo(b.w, b.h), iceMats[0]); g.add(m);
    } else {
      m = new T.Mesh(boxGeo(b.w, b.h), woodMats[b.span][0]); m.castShadow = m.receiveShadow = true; g.add(m);
    }
    g.userData.main = m;
    scene.add(g);
    return { g: g, b: b, drop: 0, hitWob: 0 };
  }

  // TNT barrel: red staves, dark hoops, a hazard label
  var bombMats = (function () {
    var c = canvasEl(512, 256), g = c.getContext('2d');
    g.fillStyle = '#d8202f'; g.fillRect(0, 0, 512, 256);
    for (var i = 0; i < 16; i++) { g.fillStyle = i % 2 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)'; g.fillRect(i * 32, 0, 32, 256); }
    g.fillStyle = '#2b1d22'; g.fillRect(0, 18, 512, 22); g.fillRect(0, 216, 512, 22);
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(0, 20, 512, 4); g.fillRect(0, 218, 512, 4);
    for (var k = 0; k < 2; k++) {
      var cx = 128 + k * 256;
      g.fillStyle = '#ffd23a'; g.beginPath(); g.moveTo(cx, 62); g.lineTo(cx + 62, 128); g.lineTo(cx, 194); g.lineTo(cx - 62, 128); g.closePath(); g.fill();
      g.strokeStyle = '#2b1d22'; g.lineWidth = 6; g.stroke();
      g.fillStyle = '#2b1d22'; g.font = 'bold 40px Arial Black, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('TNT', cx, 130);
    }
    var side = mat({ map: tex(c, true), clearcoat: 0.6, roughness: 0.3 }), cap = mat({ color: '#8a1420', clearcoat: 0.5, roughness: 0.4 });
    return [side, cap, cap];
  })();
  function barrelGeo(h) { var key = 'k' + h.toFixed(3); return geoCache[key] || (geoCache[key] = new T.CylinderGeometry(0.46, 0.46, h, 40)); }

  // dark cartoon outline (inverted hull) so obstacles read against any backdrop
  var outlineMat = new T.MeshBasicMaterial({ color: 0x2b0b4a, side: T.BackSide });
  function outline(geo, grow) { var o = new T.Mesh(geo, outlineMat); o.scale.setScalar(1);
    var g2 = geo.clone(); g2.computeBoundingBox(); var bb = g2.boundingBox, sx = (bb.max.x - bb.min.x), sy = (bb.max.y - bb.min.y), sz = (bb.max.z - bb.min.z);
    o.scale.set((sx + grow * 2) / sx, (sy + grow * 2) / sy, (sz + grow * 2) / Math.max(sz, 0.01)); return o; }
  // sliding steel shield
  var shield = new T.Group(); scene.add(shield); shield.visible = false;
  var shield2 = null;
  (function () {
    var c = canvasEl(512, 128), g = c.getContext('2d');
    g.fillStyle = '#5ec8ff'; g.fillRect(0, 0, 512, 128);
    for (var i = 0; i < 2; i++) { var x0 = i ? 448 : 0; g.save(); g.beginPath(); g.rect(x0, 0, 64, 128); g.clip(); g.fillStyle = '#ffd23a'; g.fillRect(x0, 0, 64, 128); g.fillStyle = '#2b1d22'; for (var k = -3; k < 6; k++) { g.beginPath(); g.moveTo(x0 + k * 28, 128); g.lineTo(x0 + k * 28 + 14, 128); g.lineTo(x0 + k * 28 + 14 + 40, 0); g.lineTo(x0 + k * 28 + 40, 0); g.fill(); } g.restore(); }
    g.fillStyle = '#d4f1ff'; g.fillRect(64, 10, 384, 14);
    for (i = 0; i < 6; i++) { g.fillStyle = '#1d6fb8'; g.beginPath(); g.arc(96 + i * 64, 64, 9, 0, 7); g.fill(); g.fillStyle = '#e8f0f8'; g.beginPath(); g.arc(93 + i * 64, 61, 3, 0, 7); g.fill(); }
    var m = new T.Mesh(roundedBox(R.SHIELD_W, R.SHIELD_H, 0.22, 0.08, 4), new T.MeshMatcapMaterial({ map: tex(c, true), matcap: matcapTex('#ffffff', 1, 'neutral') }));
    shield.add(m); shield.add(outline(roundedBox(R.SHIELD_W, R.SHIELD_H, 0.22, 0.08, 4), 0.06));
  })();

  // ---------------------------------------------------------------- tables
  var tableMeshes = [], ringTex = null;
  function ringTexture() { if (!ringTex) { var c = canvasEl(128, 128), g = c.getContext('2d'); g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 8; g.beginPath(); g.arc(64, 64, 52, 0, 7); g.stroke(); ringTex = tex(c, false); } return ringTex; }
  var creamMat = phys({ color: L('#f7ead2'), roughness: 0.45, clearcoat: 0.4 });
  var purpleMat = phys({ color: L('#8a2ef0'), roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.15 });
  var goldMat = phys({ color: L('#ffb52a'), roughness: 0.28, metalness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.12 });
  var poleOrange = phys({ color: L('#f39a3a'), roughness: 0.3, clearcoat: 0.8 });
  function octo(w, d, cut) {
    var s = new T.Shape(), x = w / 2, z = d / 2;
    s.moveTo(-x + cut, -z); s.lineTo(x - cut, -z); s.lineTo(x, -z + cut); s.lineTo(x, z - cut); s.lineTo(x - cut, z); s.lineTo(-x + cut, z); s.lineTo(-x, z - cut); s.lineTo(-x, -z + cut); s.closePath();
    return s;
  }
  function slab(shape, h, mat, bev) {
    var g = new T.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 4, curveSegments: 4 });
    g.rotateX(Math.PI / 2);
    var m = new T.Mesh(g, mat); m.castShadow = m.receiveShadow = true; return m;
  }
  function buildTables(list, theme) {
    tableMeshes.forEach(function (m) { scene.remove(m); });
    tableMeshes = [];
    list.forEach(function (t) {
      var g = new T.Group();
      if (t.round) {                    // a round table: stacked discs, squashed in depth
        var disc = function (r, h, m, y) { var d = new T.Mesh(new T.CylinderGeometry(r, r, h, 64), m); d.scale.z = 2.4 / t.w; d.position.y = y; g.add(d); };
        disc(t.w / 2 + 0.25, 0.12, creamMat, -0.06); disc(t.w / 2 + 0.3, 0.09, goldMat, -0.16); disc(t.w / 2 + 0.15, 0.16, purpleMat, -0.28); disc(t.w / 2 + 0.25, 0.08, goldMat, -0.4);
      } else {
        var top = slab(octo(t.w, 1.5, 0.25), 0.1, creamMat, 0.04); top.position.y = 0.0; g.add(top);
        var gold1 = slab(octo(t.w + 0.08, 1.58, 0.27), 0.08, goldMat, 0.03); gold1.position.y = -0.12; g.add(gold1);
        var band = slab(octo(t.w - 0.1, 1.4, 0.24), 0.14, purpleMat, 0.02); band.position.y = -0.22; g.add(band);
        var gold2 = slab(octo(t.w + 0.04, 1.54, 0.26), 0.07, goldMat, 0.03); gold2.position.y = -0.34; g.add(gold2);
      }
      var poleH = -GROUND_Y - 0.4;
      var pole = new T.Mesh(new T.CylinderGeometry(0.3, 0.3, poleH, 32), theme === 'beach' ? purpleMat : poleOrange);
      pole.position.y = -0.4 - poleH / 2; pole.castShadow = pole.receiveShadow = true; g.add(pole);
      if (theme !== 'beach') {
        var collar = new T.Mesh(new T.CylinderGeometry(0.42, 0.42, 0.22, 32), purpleMat); collar.position.y = GROUND_Y + 1.35; collar.castShadow = true; g.add(collar);
        var pts = [[0, 0], [1.25, 0], [1.25, 0.16], [1.05, 0.3], [0.7, 0.95], [0.48, 1.1], [0.48, 1.24], [0, 1.24]].map(function (p) { return new T.Vector2(p[0], p[1]); });
        var base = new T.Mesh(new T.LatheGeometry(pts, 48), goldMat); base.position.y = GROUND_Y; base.castShadow = base.receiveShadow = true; g.add(base);
        var band2 = new T.Mesh(new T.CylinderGeometry(0.86, 1.08, 0.36, 48), purpleMat); band2.position.y = GROUND_Y + 0.5; g.add(band2);
      }
      if (theme === 'beach') {           // where the pole meets the sea
        for (var k = 0; k < 2; k++) {
          var rg = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: ringTexture(), transparent: true, depthWrite: false, opacity: 0.55 - k * 0.2 }));
          rg.rotation.x = -Math.PI / 2; rg.position.y = GROUND_Y + 0.04; rg.scale.setScalar(1.1 + k * 0.7); g.add(rg);
        }
      }
      // painted shadows: under the base, the tower's long shadow on the ground behind, contact shade on the top
      if (theme !== 'beach') { var dp = new T.Mesh(new T.CircleGeometry(1, 48), dirt.material); dp.rotation.x = -Math.PI / 2; dp.scale.set(2.6, 1.5, 1); dp.position.y = GROUND_Y + 0.015; g.add(dp); }
      var sb = blob(3.2, 1.7, null, 1); sb.position.y = GROUND_Y + 0.03; g.add(sb);
      var sc2 = blob(1.9, 1.0, null, 1); sc2.position.y = GROUND_Y + 0.035; g.add(sc2);
      var ts = blob(t.w * 1.15, 9, slabShadowTex, theme === 'beach' ? 0.5 : 0.8); ts.position.set(0.6, GROUND_Y + 0.025, -4.6); g.add(ts);
      var cs = blob(t.w * 0.98, 1.3, slabShadowTex, 0.55); cs.position.y = 0.012; g.add(cs);
      g.position.x = t.cx;
      scene.add(g); tableMeshes.push(g);
    });
  }

  // ---------------------------------------------------------------- fan
  var fan = new T.Group(); scene.add(fan); fan.visible = false;
  (function buildFan() {
    var Lb = R.FAN_LEN, hw = R.FAN_HALF * 1.6;
    var s = new T.Shape();
    s.moveTo(0.35, -hw * 0.5); s.lineTo(Lb - 0.45, -hw); s.quadraticCurveTo(Lb + 0.05, 0, Lb - 0.45, hw); s.lineTo(0.35, hw * 0.5); s.closePath();
    var bg = new T.ExtrudeGeometry(s, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 4 }); bg.translate(0, 0, -0.07);
    var woodY = mat({ color: '#ffd84a', roughness: 0.1, clearcoat: 1 });
    for (var k = 0; k < 4; k++) {
      var arm = new T.Group(); arm.rotation.z = k * Math.PI / 2;
      var bl = new T.Mesh(bg, woodY); bl.castShadow = true; arm.add(bl);
      var blo = new T.Mesh(bg, outlineMat); blo.scale.set(1.03, 1.45, 1.9); arm.add(blo);
      var tip = new T.Mesh(new T.SphereGeometry(hw * 1.1, 24, 16), purpleMat); tip.position.x = Lb - 0.38; tip.scale.set(0.8, 1, 0.55); tip.castShadow = true; arm.add(tip);
      fan.add(arm);
    }
    var hub = new T.Mesh(new T.CylinderGeometry(0.42, 0.42, 0.34, 40), goldMat); hub.rotation.x = Math.PI / 2; fan.add(hub);
    var hubo = new T.Mesh(new T.CylinderGeometry(0.48, 0.48, 0.3, 40), outlineMat); hubo.rotation.x = Math.PI / 2; fan.add(hubo);
    var hub2 = new T.Mesh(new T.CylinderGeometry(0.3, 0.3, 0.36, 40), purpleMat); hub2.rotation.x = Math.PI / 2; fan.add(hub2);
  })();
  var fanPole = (function () {
    var c = canvasEl(64, 512), g = c.getContext('2d'); g.fillStyle = '#ffd04a'; g.fillRect(0, 0, 64, 512); g.fillStyle = '#8a2ef0';
    for (var i = -2; i < 20; i++) { g.beginPath(); g.moveTo(0, i * 32); g.lineTo(64, i * 32 + 22); g.lineTo(64, i * 32 + 38); g.lineTo(0, i * 32 + 16); g.fill(); }
    var m = new T.Mesh(new T.CylinderGeometry(0.1, 0.1, 30, 16), mat({ map: tex(c, true, [1, 8]), roughness: 0.5 }));
    m.position.y = 15; m.castShadow = true; return m;
  })();

  // pendulum: a striped wrecking ball on a gold rod, hanging from a purple pivot
  var pend = new T.Group(); scene.add(pend); pend.visible = false;
  (function () {
    var rod = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, R.PEND_LEN, 12), goldMat); rod.position.y = -R.PEND_LEN / 2; pend.add(rod);
    var c = canvasEl(256, 128), g = c.getContext('2d'); g.fillStyle = '#8b3ff2'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#ffd23a'; for (var i = 0; i < 8; i++) g.fillRect(i * 32, 0, 14, 128);
    var ball = new T.Mesh(new T.SphereGeometry(R.PEND_R, 32, 20), new T.MeshMatcapMaterial({ map: tex(c, true), matcap: matcapTex('#ffffff', 1, 'neutral') }));
    ball.position.y = -R.PEND_LEN; pend.add(ball);
    var ol = new T.Mesh(new T.SphereGeometry(R.PEND_R + 0.06, 24, 16), outlineMat); ol.position.y = -R.PEND_LEN; pend.add(ol);
    var piv = new T.Mesh(new T.SphereGeometry(0.22, 20, 12), purpleMat); pend.add(piv);
    var pol = new T.Mesh(new T.SphereGeometry(0.27, 16, 10), outlineMat); pend.add(pol);
  })();

  // ---------------------------------------------------------------- cannon
  var cannon = new T.Group(); scene.add(cannon);
  var blueMat = phys({ color: L('#2a63e8'), roughness: 0.25, clearcoat: 0.5, clearcoatRoughness: 0.08 });
  var redMat = phys({ color: L('#e0203a'), roughness: 0.25, clearcoat: 0.5, clearcoatRoughness: 0.08 });
  var marble = (function () {
    var c = canvasEl(512, 512), g = c.getContext('2d'); g.fillStyle = '#f6ecdb'; g.fillRect(0, 0, 512, 512);
    for (var i = 0; i < 40; i++) { g.strokeStyle = 'rgba(200,180,150,' + (0.1 + Math.random() * 0.2) + ')'; g.lineWidth = 1 + Math.random() * 2; g.beginPath(); var x = Math.random() * 512, y = Math.random() * 512; g.moveTo(x, y); g.bezierCurveTo(x + 60, y + 30, x + 100, y - 40, x + 200, y + 20); g.stroke(); }
    return tex(c, true);
  })();
  (function buildCannon() {
    var plat = new T.Mesh(new T.CylinderGeometry(5.2, 5.2, 0.5, 96), mat({ map: marble, roughness: 0.4 })); plat.position.y = -1.85; plat.receiveShadow = true; cannon.add(plat);
    var r1 = new T.Mesh(new T.TorusGeometry(5.2, 0.16, 16, 96), goldMat); r1.rotation.x = Math.PI / 2; r1.position.y = -1.6; cannon.add(r1);
    var r2 = new T.Mesh(new T.TorusGeometry(5.45, 0.2, 16, 96), purpleMat); r2.rotation.x = Math.PI / 2; r2.position.y = -1.78; cannon.add(r2);
  })();
  var yoke = new T.Group(); cannon.add(yoke);
  (function () {
    var body = new T.Mesh(new T.SphereGeometry(1.15, 48, 32), redMat); body.scale.set(1, 0.9, 1.05); body.position.y = -0.55; body.castShadow = true; yoke.add(body);
    [-1, 1].forEach(function (s) {
      var wh = new T.Mesh(new T.CylinderGeometry(0.95, 0.95, 0.42, 48), blueMat); wh.rotation.z = Math.PI / 2; wh.position.set(s * 1.3, -0.75, 0.1); wh.castShadow = true; yoke.add(wh);
      var hubc = new T.Mesh(new T.CylinderGeometry(0.32, 0.32, 0.46, 24), goldMat); hubc.rotation.z = Math.PI / 2; hubc.position.set(s * 1.32, -0.75, 0.1); yoke.add(hubc);
    });
  })();
  var barrel = new T.Group(); barrel.position.y = 0.0; yoke.add(barrel);
  (function () {
    var pts = [[0, -0.7], [0.86, -0.7], [0.9, -0.35], [0.8, 0.6], [0.7, 1.75], [0.86, 1.85], [0.9, 2.3], [0.62, 2.34], [0.52, 1.7], [0, 1.7]].map(function (p) { return new T.Vector2(p[0], p[1]); });
    var b = new T.Mesh(new T.LatheGeometry(pts, 64), blueMat); b.castShadow = true; barrel.add(b);
    var band = new T.Mesh(new T.CylinderGeometry(0.86, 0.9, 0.55, 64), redMat); band.position.y = -0.2; barrel.add(band);
    var bandG = new T.Mesh(new T.TorusGeometry(0.88, 0.06, 12, 64), goldMat); bandG.rotation.x = Math.PI / 2; bandG.position.y = 0.08; barrel.add(bandG);
    var muzzle = new T.Mesh(new T.TorusGeometry(0.78, 0.17, 16, 64), goldMat); muzzle.rotation.x = Math.PI / 2; muzzle.position.y = 2.2; barrel.add(muzzle);
    var hole = new T.Mesh(new T.CircleGeometry(0.62, 48), new T.MeshBasicMaterial({ color: 0x14060a })); hole.rotation.x = -Math.PI / 2; hole.position.y = 2.33; barrel.add(hole);
    var crownS = new T.Shape(); crownS.moveTo(-0.3, -0.16); crownS.lineTo(-0.36, 0.16); crownS.lineTo(-0.16, 0.02); crownS.lineTo(0, 0.24); crownS.lineTo(0.16, 0.02); crownS.lineTo(0.36, 0.16); crownS.lineTo(0.3, -0.16); crownS.closePath();
    var crown = new T.Mesh(new T.ExtrudeGeometry(crownS, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3 }), goldMat);
    crown.position.set(0, 1.25, 0.74); crown.rotation.x = -0.08; barrel.add(crown);
    for (var i = 0; i < 6; i++) { var a = -0.9 + i * 0.36; var dot = new T.Mesh(new T.SphereGeometry(0.07, 12, 8), goldMat); dot.position.set(Math.sin(a) * 0.9, -0.2, Math.cos(a) * 0.9); barrel.add(dot); }
  })();
  var muzzleFlash = new T.Sprite(new T.SpriteMaterial({ color: 0xffe9a0, blending: T.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  scene.add(muzzleFlash);
  var cannonPos = new T.Vector3(), aimTarget = new T.Vector3(0, 3, 0), aimNow = new T.Vector3(0, 3, 0), kick = 0;
  function placeCannon() {
    // anchor to the real bottom of the screen (tall phones show more below the design rect)
    var ndcBottom = -1 - 2 * fitRect.y / fitRect.h;
    var dir = new T.Vector3(0, ndcBottom, 0.5).unproject(pickCam).sub(pickCam.position).normalize();
    cannonPos.copy(pickCam.position).addScaledVector(dir, 10.5);
    cannon.position.copy(cannonPos); cannon.scale.setScalar(0.5);
  }
  function muzzleWorld() { barrel.updateMatrixWorld(true); return barrel.localToWorld(new T.Vector3(0, 2.4, 0)); }
  function aimCannon() {
    aimNow.lerp(aimTarget, 0.3);
    var d = aimNow.clone().sub(cannonPos);
    yoke.rotation.y = -Math.atan2(d.x, -d.z);
    barrel.rotation.x = -Math.min(1.45, Math.max(0.55, Math.atan2(Math.sqrt(d.x * d.x + d.z * d.z), d.y)));
    barrel.position.y = -kick * 0.5;
  }

  // ---------------------------------------------------------------- balls
  // the ball must read against sky, grass, sea and every jar colour: bright white with a hot
  // magenta zigzag band, drawn unshaded (full brightness), with a dark cartoon outline around it
  var ballTex = (function () {
    var c = canvasEl(512, 256), g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#ff1f8e'; g.beginPath(); g.moveTo(0, 92);
    for (var i = 0; i <= 16; i++) g.lineTo(i * 32, i % 2 ? 70 : 104);
    for (i = 16; i >= 0; i--) g.lineTo(i * 32, i % 2 ? 150 : 184);
    g.fill();
    g.fillStyle = '#ff1f8e'; for (i = 0; i < 8; i++) { g.beginPath(); g.arc(32 + i * 64, 30, 9, 0, 7); g.fill(); g.beginPath(); g.arc(i * 64, 226, 9, 0, 7); g.fill(); }
    return tex(c, true);
  })();
  var ballGeo = new T.SphereGeometry(R.BALL_R, 40, 28);   // drawn at the collider size so it sits on surfaces exactly
  var ballMat = new T.MeshMatcapMaterial({ map: ballTex, matcap: matcapTex('#ffffff', 1, 'neutral') });
  var ballLine = new T.MeshBasicMaterial({ color: 0x2b0b4a, side: T.BackSide });
  var ballLineGeo = new T.SphereGeometry(R.BALL_R + 0.04, 32, 20);
  var ballMeshes = {};
  function syncBalls(S) {
    var seen = {};
    for (var i = 0; i < S.ballsLive.length; i++) {
      var bl = S.ballsLive[i], m = ballMeshes[bl.n];
      if (!m) {
        m = ballMeshes[bl.n] = new T.Group();
        var core = new T.Mesh(ballGeo, ballMat); m.add(core); m.userData.core = core;
        m.add(new T.Mesh(ballLineGeo, ballLine));
        m.userData.off = muzzleWorld().sub(new T.Vector3(R.CANNON.x, R.CANNON.y, R.CANNON.z)); scene.add(m);
      }
      seen[bl.n] = 1;
      var p = bl.body.translation(), q = bl.body.rotation();
      var k = Math.max(0, 1 - bl.age / 10);          // blend from the drawn muzzle into the physics path
      m.position.set(p.x, p.y, p.z).addScaledVector(m.userData.off, k * k);
      m.userData.core.quaternion.set(q.x, q.y, q.z, q.w);
    }
    for (var n in ballMeshes) if (!seen[n]) { scene.remove(ballMeshes[n]); delete ballMeshes[n]; }
  }

  // ---------------------------------------------------------------- particles
  var softTex = (function () { var c = canvasEl(64, 64), g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return tex(c, false); })();
  var starTex = (function () { var c = canvasEl(64, 64), g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 28); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(32, 0); g.lineTo(35, 29); g.lineTo(64, 32); g.lineTo(35, 35); g.lineTo(32, 64); g.lineTo(29, 35); g.lineTo(0, 32); g.lineTo(29, 29); g.fill(); return tex(c, false); })();
  muzzleFlash.material.map = softTex;
  var G = -20;
  function makePool(geo, mat, n, shadow) {
    var im = new T.InstancedMesh(geo, mat, n);
    im.instanceMatrix.setUsage(T.DynamicDrawUsage);
    im.castShadow = !!shadow; im.frustumCulled = false;
    for (var i = 0; i < n; i++) im.setColorAt(i, new T.Color(1, 1, 1));
    im.count = 0; scene.add(im);
    return { im: im, items: [], max: n };
  }
  var shardGeo = (function () {   // a curved, jagged piece of jar wall
    var g = new T.BufferGeometry(), v = [], ring = [[-0.5, -0.45], [0.05, -0.55], [0.5, -0.3], [0.42, 0.2], [0.1, 0.55], [-0.35, 0.4], [-0.55, 0.0]];
    function at(u, y) { return [Math.sin(u * 0.9) * 0.6, y, Math.cos(u * 0.9) * 0.6 - 0.6]; }
    for (var i = 0; i < ring.length; i++) { var a = ring[i], b = ring[(i + 1) % ring.length]; v.push.apply(v, at(0, 0).concat(at(a[0], a[1]), at(b[0], b[1]))); }
    g.setAttribute('position', new T.Float32BufferAttribute(v, 3)); g.computeVertexNormals(); return g;
  })();
  var shards = makePool(shardGeo, mat({ color: 0xffffff, roughness: 0.05, clearcoat: 1, side: T.DoubleSide, kind: 'jar' }), 1200, true);
  var petalGeo = new T.SphereGeometry(0.5, 10, 6);
  var petals = makePool(petalGeo, mat({ color: 0xffffff, roughness: 0.05, clearcoat: 1, kind: 'jar' }), 900, false);
  var plates = makePool(shardGeo, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: T.DoubleSide, depthWrite: false }), 200, false);
  var needles = makePool(new T.BoxGeometry(1, 0.07, 0.07), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }), 900, false);
  var chipMat = mat({ map: tex(woodCanvas[1], true), roughness: 0.65 });
  var chips = makePool(roundedBox(1, 1, 1, 0.12, 2), chipMat, 600, true);
  var drops = makePool(new T.SphereGeometry(0.5, 16, 12), phys({ color: 0xffffff, roughness: 0.1, clearcoat: 1, transparent: true, opacity: 0.9 }), 500, false);
  var confs = makePool(new T.PlaneGeometry(0.24, 0.13), new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide }), 300, false);
  var softs = [], fallers = [], ripples = [];
  var tmpM = new T.Matrix4(), tmpQ = new T.Quaternion(), tmpS = new T.Vector3(), XAX = new T.Vector3(1, 0, 0), tmpD = new T.Vector3();
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function addItem(pool, it) { if (pool.items.length >= pool.max) pool.items.shift(); pool.items.push(it); }
  function spawnSoft(pos, size, color, alpha, life, grow, additive, map) {
    if (softs.length > 260) return null;
    var s = new T.Sprite(new T.SpriteMaterial({ map: map || softTex, color: color, transparent: true, opacity: alpha, depthWrite: false, blending: additive ? T.AdditiveBlending : T.NormalBlending }));
    s.position.copy(pos); s.scale.setScalar(size); scene.add(s);
    var o = { s: s, life: life, max: life, grow: grow, a0: alpha, v: new T.Vector3(), g: 0 };
    softs.push(o); return o;
  }
  var theme = 'meadow';
  function floorAt(p) {
    for (var i = 0; i < curTables.length; i++) { var t = curTables[i]; if (Math.abs(p.x - t.cx) < t.w / 2 && Math.abs(p.z) < 0.75 && p.y > -0.4) return 0; }
    return GROUND_Y;
  }
  var ICE = '#bfe9ff';
  // the reference's jar break: a dense spray of small glossy drops in the jar colour
  // (rice-grain shaped, flying along their path) plus a few clear glass plates
  function glassBreak(p, q, col, power) {
    var gcol = col < 0 ? ICE : GLASS[col];
    var c = L(gcol), lite = c.clone().lerp(new T.Color(1, 1, 1), 0.35), i;
    for (i = 0; i < Math.round(80 * power); i++) {
      var a = Math.random() * Math.PI * 2, sp = rnd(3, 11) * power;
      addItem(petals, { p: new T.Vector3(p.x + rnd(-0.3, 0.3), p.y + rnd(-0.45, 0.45), p.z + 0.45),
        v: new T.Vector3(Math.cos(a) * sp, Math.sin(a) * sp * 0.9 + rnd(1, 4), rnd(0.5, 3)),
        len: rnd(0.14, 0.3), th: rnd(0.05, 0.09), life: rnd(0.6, 1.1), col: Math.random() < 0.25 ? lite : c });
    }
    for (i = 0; i < 9; i++) {
      var dir = new T.Vector3(rnd(-1, 1), rnd(-0.3, 1), rnd(0.2, 1)).normalize();
      addItem(plates, { p: new T.Vector3(p.x + rnd(-0.3, 0.3), p.y + rnd(-0.4, 0.4), p.z + 0.4), v: dir.multiplyScalar(rnd(2, 5)).add(new T.Vector3(0, 2, 0)),
        r: new T.Euler(rnd(0, 6), rnd(0, 6), rnd(0, 6)), w: new T.Vector3(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8)), s: rnd(0.16, 0.3), life: rnd(0.8, 1.3), col: new T.Color(1, 1, 1), rest: 0 });
    }
  }
  var plankCols = ['#e08a3c', '#c86f28', '#f0a458', '#b8601f'].map(L);
  function woodBreak(p, q, w, h, span) {
    var rot = new T.Quaternion(q.x, q.y, q.z, q.w), i, n = span === 1 ? 6 : 4 + span;
    for (i = 0; i < n; i++) {
      var local = new T.Vector3(rnd(-w / 2.6, w / 2.6), rnd(-h / 3, h / 3), rnd(-0.3, 0.3)).applyQuaternion(rot);
      var sv = span === 1 ? new T.Vector3(rnd(0.75, 0.95), rnd(0.16, 0.26), 0.12) : new T.Vector3(rnd(0.6, 1.1), rnd(0.25, 0.4), rnd(0.3, 0.5));
      addItem(chips, { p: new T.Vector3(p.x, p.y, p.z).add(local), v: new T.Vector3(local.x * 5 + rnd(-2, 2), rnd(3, 8), rnd(1, 5)), r: new T.Euler(rnd(0, 3), rnd(0, 3), rnd(0, 3)),
        w: new T.Vector3(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8)), sv: sv, life: rnd(2.2, 3.2), col: plankCols[i % 4], rest: 0 });
    }
    for (i = 0; i < 26 + span * 6; i++) {
      addItem(chips, { p: new T.Vector3(p.x + rnd(-w / 2, w / 2), p.y + rnd(-h / 2, h / 2), p.z + rnd(0, 0.5)), v: new T.Vector3(rnd(-7, 7), rnd(1, 9), rnd(0, 5)),
        r: new T.Euler(rnd(0, 3), rnd(0, 3), rnd(0, 3)), w: new T.Vector3(rnd(-20, 20), rnd(-20, 20), rnd(-20, 20)), sv: new T.Vector3(rnd(0.15, 0.5), 0.05, 0.05), life: rnd(1.2, 2.2), col: plankCols[i % 4], rest: 0 });
    }
    puff(p, 10, 0xeed9b8, 1.2);
  }
  function iceChips(p) {
    for (var i = 0; i < 14; i++) addItem(shards, { p: new T.Vector3(p.x + rnd(-0.3, 0.3), p.y + rnd(-0.3, 0.3), 0.55), v: new T.Vector3(rnd(-4, 4), rnd(1, 6), rnd(1, 4)),
      r: new T.Euler(rnd(0, 6), rnd(0, 6), rnd(0, 6)), w: new T.Vector3(rnd(-15, 15), rnd(-15, 15), rnd(-15, 15)), s: rnd(0.1, 0.25), life: 1.2, col: L(ICE), rest: 0 });
  }
  function chipsAt(p) {
    for (var i = 0; i < 12; i++) addItem(chips, { p: new T.Vector3(p.x + rnd(-0.3, 0.3), p.y + rnd(-0.3, 0.3), 0.55), v: new T.Vector3(rnd(-4, 4), rnd(1, 6), rnd(1, 4)),
      r: new T.Euler(0, 0, rnd(0, 3)), w: new T.Vector3(rnd(-20, 20), rnd(-20, 20), 0), sv: new T.Vector3(rnd(0.1, 0.25), 0.05, 0.05), life: 1.1, col: plankCols[2], rest: 0 });
    puff(p, 4, 0xeed9b8, 0.7);
  }
  function puff(p, n, col, s) {
    for (var i = 0; i < n; i++) {
      var d = spawnSoft(new T.Vector3(p.x + rnd(-0.5, 0.5) * s, p.y + rnd(-0.3, 0.3) * s, (p.z || 0) + rnd(0, 0.6)), rnd(0.5, 0.9) * s, col, 0.35, rnd(0.4, 0.7), 1.2);
      if (d) d.v.set(rnd(-1.2, 1.2), rnd(0.2, 1.4), rnd(-0.3, 0.6));
    }
  }
  function splash(x, z, big) {
    for (var i = 0; i < (big ? 34 : 14); i++) addItem(drops, { p: new T.Vector3(x + rnd(-0.3, 0.3), GROUND_Y + 0.1, z + rnd(-0.3, 0.3)), v: new T.Vector3(rnd(-2.5, 2.5), rnd(4, big ? 11 : 7), rnd(-2, 2)), r: new T.Euler(), w: new T.Vector3(), s: rnd(0.06, 0.16), life: rnd(0.6, 1.1), col: L('#e9fbff'), rest: 0 });
    for (i = 0; i < 2; i++) {
      var rg = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: ringTexture(), transparent: true, depthWrite: false, opacity: 0.8 }));
      rg.rotation.x = -Math.PI / 2; rg.position.set(x, GROUND_Y + 0.05, z); scene.add(rg);
      ripples.push({ m: rg, life: 1.1 + i * 0.4, max: 1.1 + i * 0.4, s: big ? 2.2 : 1.2 });
    }
    spawnSoft(new T.Vector3(x, GROUND_Y + 0.4, z), big ? 2 : 1.2, 0xffffff, 0.7, 0.4, 2);
  }
  function confetti() {
    var cs = ['#ff2e48', '#ffc114', '#1f86ff', '#9b47ff', '#22cc5e', '#ffffff'].map(L);
    for (var i = 0; i < 260; i++) {
      var side = i % 2 ? 1 : -1;
      addItem(confs, { p: new T.Vector3(side * 5, 1, 3), v: new T.Vector3(-side * rnd(2, 10), rnd(9, 18), rnd(-2, 4)), r: new T.Euler(rnd(0, 6), rnd(0, 6), rnd(0, 6)),
        w: new T.Vector3(rnd(-10, 10), rnd(-10, 10), rnd(-10, 10)), life: rnd(2.6, 3.6), col: cs[i % cs.length], conf: 1 });
    }
  }
  var tinkle = 0;
  function stepPool(pool, dt, kind) {
    var out = [], i, it;
    for (i = 0; i < pool.items.length; i++) {
      it = pool.items[i]; it.life -= dt;
      if (it.life <= 0) continue;
      if (kind === 'needle') { it.p.addScaledVector(it.v, dt); it.v.multiplyScalar(0.9); out.push(it); continue; }
      if (kind === 'petal') { it.v.y += G * 0.8 * dt; it.v.multiplyScalar(0.985); it.p.addScaledVector(it.v, dt); if (it.p.y < floorAt(it.p)) continue; out.push(it); continue; }
      if (it.conf) { it.v.y += G * 0.22 * dt; it.v.multiplyScalar(0.985); if (it.v.y < -2.6) it.v.y = -2.6; it.p.addScaledVector(it.v, dt); it.r.x += it.w.x * dt; it.r.y += it.w.y * dt; it.r.z += it.w.z * dt; out.push(it); continue; }
      if (it.rest < 3) {
        it.v.y += G * dt; it.p.addScaledVector(it.v, dt);
        it.r.x += it.w.x * dt; it.r.y += it.w.y * dt; it.r.z += it.w.z * dt;
        var fy = floorAt(it.p);
        if (it.p.y < fy + 0.03 && it.v.y < 0) {
          if (fy === GROUND_Y && theme === 'beach') { if (kind !== 'drop' && Math.random() < 0.2) splash(it.p.x, it.p.z, false); it.life = 0; continue; }
          it.p.y = fy + 0.03;
          if (kind === 'glass' && it.v.y < -5 && Math.random() < 0.3) tinkle = Math.min(tinkle + 1, 8);
          if (kind === 'drop') { it.life = 0; continue; }
          it.v.y = -it.v.y * 0.3; it.v.x *= 0.5; it.v.z *= 0.5; it.w.multiplyScalar(0.4); it.rest += 1;
          if (it.rest >= 3) { it.v.set(0, 0, 0); it.w.set(0, 0, 0); }
        }
      }
      out.push(it);
    }
    pool.items = out;
    var im = pool.im; im.count = out.length;
    for (i = 0; i < out.length; i++) {
      it = out[i];
      var fade = Math.min(1, it.life / 0.45);
      if (kind === 'petal') { var pf = Math.min(1, it.life / 0.25); tmpS.set(it.len * pf, it.th * pf, it.th * pf); tmpQ.setFromUnitVectors(XAX, tmpD.copy(it.v).normalize()); }
      else if (kind === 'needle') { tmpS.set(it.len * Math.min(1, it.life * 4), (it.th || 0.07) / 0.07, (it.th || 0.07) / 0.07); tmpQ.setFromUnitVectors(XAX, tmpD.copy(it.v).normalize()); }
      else { if (it.sv) tmpS.copy(it.sv).multiplyScalar(fade); else tmpS.setScalar((it.s || 1) * fade); tmpQ.setFromEuler(it.r); }
      tmpM.compose(it.p, tmpQ, tmpS); im.setMatrixAt(i, tmpM); im.setColorAt(i, it.col);
    }
    im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }
  function stepSofts(dt) {
    for (var i = softs.length - 1; i >= 0; i--) {
      var o = softs[i]; o.life -= dt;
      if (o.life <= 0) { scene.remove(o.s); o.s.material.dispose(); softs.splice(i, 1); continue; }
      if (o.g) o.v.y -= o.g * dt;
      o.s.position.addScaledVector(o.v, dt); o.s.scale.multiplyScalar(1 + o.grow * dt);
      o.s.material.opacity = o.a0 * (o.life / o.max);
    }
    for (i = ripples.length - 1; i >= 0; i--) {
      var r = ripples[i]; r.life -= dt;
      if (r.life <= 0) { scene.remove(r.m); r.m.material.dispose(); ripples.splice(i, 1); continue; }
      var k = 1 - r.life / r.max; r.m.scale.setScalar(0.3 + k * r.s * 2); r.m.material.opacity = 0.8 * (1 - k);
    }
  }
  // blocks knocked off the table keep flying as cosmetic pieces, then land or splash
  function stepFallers(dt) {
    for (var i = fallers.length - 1; i >= 0; i--) {
      var f = fallers[i], g = f.m.g;
      f.life -= dt;
      if (!f.sunk) {
        f.v.y += G * dt; g.position.addScaledVector(f.v, dt);
        var aq = new T.Quaternion().setFromAxisAngle(f.avAxis, f.avMag * dt); g.quaternion.premultiply(aq);
        if (g.position.y - f.h * 0.35 < GROUND_Y && f.v.y < 0) {
          if (theme === 'beach') { splash(g.position.x, g.position.z, true); A.play('splash', f.t !== 'jar'); f.sunk = true; f.v.set(f.v.x * 0.2, -1.5, f.v.z * 0.2); f.avMag *= 0.2; }
          else if (f.t === 'jar' || f.t === 'ice') {         // glass and ice that hit the ground shatter
            var gq = g.quaternion; glassBreak({ x: g.position.x, y: g.position.y, z: g.position.z }, { x: gq.x, y: gq.y, z: gq.z, w: gq.w }, f.t === 'ice' ? -1 : f.m.b.col, 0.55);
            A.play('groundGlass'); scene.remove(g); fallers.splice(i, 1); continue;
          } else {
            g.position.y = GROUND_Y + f.h * 0.35;
            if (f.v.y < -4) { puff(g.position, 5, 0xe6cfa0, 1); A.play('land', Math.min(200, -f.v.y * 12)); }
            f.v.y = -f.v.y * 0.25; f.v.x *= 0.5; f.v.z *= 0.5; f.avMag *= 0.5;
          }
        }
      } else { g.position.addScaledVector(f.v, dt); }
      if (f.life < 0.6) g.scale.setScalar(Math.max(0.01, f.life / 0.6));
      if (f.life <= 0) { scene.remove(g); fallers.splice(i, 1); }
    }
  }

  // ---------------------------------------------------------------- HUD
  var hud = document.getElementById('hud');
  var elBalls = document.getElementById('ballsN'), elScore = document.getElementById('score'), elTower = document.getElementById('tower');
  var elFloats = document.getElementById('floats');
  var elMenu = document.getElementById('menu'), elOver = document.getElementById('over'), elFinal = document.getElementById('finalScore'), elCleared = document.getElementById('cleared');
  var elPlay = document.getElementById('playBtn'), elFill = document.getElementById('towerFill'), elSet = document.getElementById('settings'), elSound = document.getElementById('soundTog');
  var towerTotal = 1;
  // zoom (not a transform) so text is laid out at the screen's own resolution and stays crisp
  var useZoom = 'zoom' in document.documentElement.style;
  // the HUD spans the full screen height (top bar at the top, menu filling the screen);
  // things tied to the scene are offset by --oy, the design rect's top in HUD units
  var hudOY = 0;
  function layoutHud() {
    var k = fitRect.w / 414, H = window.innerHeight / k;
    hudOY = fitRect.y / k;
    hud.style.height = H + 'px'; hud.style.setProperty('--oy', hudOY + 'px');
    if (useZoom) { hud.style.zoom = k; hud.style.left = fitRect.x / k + 'px'; hud.style.top = '0px'; hud.style.transform = 'none'; }
    else { hud.style.left = fitRect.x + 'px'; hud.style.top = '0px'; hud.style.transform = 'scale(' + k + ')'; }
  }
  function toHud(v) { var p = new T.Vector3(v.x, v.y, v.z).project(pickCam); return { x: (p.x + 1) / 2 * 414, y: (1 - p.y) / 2 * 736 + hudOY }; }
  var floatsLive = 0;
  function floatText(world, txt, cls) {
    if (floatsLive > 10 && !/big/.test(cls || '')) return;
    var p = toHud(world), d = document.createElement('div');
    d.className = 'float ' + (cls || ''); d.textContent = txt;
    d.style.left = Math.max(30, Math.min(384, p.x)) + 'px'; d.style.top = Math.max(120 + hudOY, p.y) + 'px';
    d.style.setProperty('--tilt', (Math.random() * 10 - 5).toFixed(1) + 'deg');
    elFloats.appendChild(d); floatsLive++;
    setTimeout(function () { d.remove(); floatsLive--; }, 1000);
  }
  var shownScore = 0, shownBalls = -1;
  function updateHud(S) {
    if (shownScore < S.score) shownScore = Math.min(S.score, shownScore + Math.max(1, Math.ceil((S.score - shownScore) / 8)));
    if (shownScore > S.score) shownScore = S.score;
    elScore.textContent = shownScore;
    if (shownBalls !== S.balls) {
      elBalls.textContent = S.balls; elBalls.parentNode.classList.toggle('low', S.balls <= 3);
      elBalls.parentNode.classList.remove('bump'); void elBalls.offsetWidth; elBalls.parentNode.classList.add('bump'); shownBalls = S.balls;
    }
    var label = (S.boss ? 'BOSS ' : 'LEVEL ') + S.level;
    if (elTower.textContent !== label) elTower.textContent = label;
    var pct = Math.round((1 - S.blocks.length / towerTotal) * 100);
    if (elFill.dataset.p !== String(pct)) { elFill.dataset.p = pct; elFill.style.width = 'calc(' + pct + '% - ' + (pct ? 6 * pct / 100 : 0) + 'px)'; }
  }
  var lastScore = 0;
  function bumpScore(S) { if (S.score !== lastScore) { lastScore = S.score; elScore.classList.remove('pop'); void elScore.offsetWidth; elScore.classList.add('pop'); } }
  function bestScore(v) { try { if (v !== undefined) localStorage.setItem('smashItBest', String(v)); return parseInt(localStorage.getItem('smashItBest'), 10) || 0; } catch (e) { return 0; } }

  // ---------------------------------------------------------------- tower framing and theme
  var curTables = [];
  function themeFor(level) { return ((level - 1) >> 1) % 2 ? 'beach' : 'meadow'; }
  function frameTower(S, instant) {
    var minX = 1e9, maxX = -1e9, top = 0;
    S.tables.forEach(function (t) { minX = Math.min(minX, t.cx - t.w / 2); maxX = Math.max(maxX, t.cx + t.w / 2); });
    S.blocks.forEach(function (b) { var p = b.body.translation(); top = Math.max(top, p.y + b.h / 2); });
    if (S.fan) top = Math.max(top, S.fan.body.translation().y + 1);
    if (S.pend) top = Math.max(top, S.pend.y + 0.4);
    // table top sits a little below the middle of the screen, tower top stays under the HUD
    var halfW = Math.max(Math.abs(minX), Math.abs(maxX)) + 0.4;
    var d = Math.max(halfW / (TANH * ASPECT * 0.96), top / (0.74 * TANH), 15);
    camState.d0 = instant ? d : camState.d; camState.look0 = instant ? 0 : camState.look;
    camState.dT = d; camState.lookT = 0.14 * d * TANH;
    camState.t = instant ? 1 : 0;
    if (instant) { camState.d = d; camState.look = camState.lookT; }
  }
  function setTheme(t) {
    theme = t;
    bgMat.map = backdrop(t); bgMat.needsUpdate = true;
    dirt.visible = false; water.visible = t === 'beach';
  }

  // ---------------------------------------------------------------- events -> effects
  var blockMeshes = {}, shake = 0, crushCool = 0;
  function handleEvents(S) {
    var ev = S.events; S.events = [];
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i], q, m;
      switch (e.e) {
        case 'tower':
          towerTotal = Math.max(1, S.blocks.length); lastScore = S.score;
          shield.visible = !!S.shield;
          if (!shield2) { shield2 = shield.clone(); scene.add(shield2); }
          shield2.visible = S.shields.length > 1;
          curTables = e.tables;
          setTheme(themeFor(e.level));
          buildTables(e.tables, theme);
          frameTower(S, e.level === 1);
          for (var id in blockMeshes) { scene.remove(blockMeshes[id].g); delete blockMeshes[id]; }
          S.blocks.forEach(function (b, k) { var bm = blockMeshes[b.id] = makeBlockMesh(b); bm.drop = 10 + b.body.translation().y * 1.2 + k * 0.05; });
          if (e.boss) { floatText({ x: 0, y: 8.2, z: 0 }, 'BOSS LEVEL!', 'gold big'); }
          if (e.level > 1) { floatText({ x: 0, y: 7, z: 0 }, '+' + e.add + ' BALLS', 'green big'); A.play('reload'); }
          break;
        case 'fire': {
          document.getElementById('hint').classList.add('hide');
          A.play('cannon'); kick = 1; shake = Math.max(shake, 0.1);
          aimTarget.set(e.x, e.y, e.z); aimNow.copy(aimTarget); aimCannon();
          var mz = muzzleWorld(); 
          for (q = 0; q < 4; q++) { var sm = spawnSoft(mz.clone(), rnd(0.5, 0.9), 0xf7efe2, 0.5, rnd(0.35, 0.6), 1.2); if (sm) sm.v.set(rnd(-1.5, 1.5), rnd(0.5, 2.5), rnd(-1, 1)); }
          break;
        }
        case 'break': {
          m = blockMeshes[e.id];
          if (m) { scene.remove(m.g); delete blockMeshes[e.id]; }
          var pos = { x: e.x, y: e.y, z: e.z };
          if (e.t === 'bomb') { /* the boom event draws this */ }
          else if (e.t === 'jar') { glassBreak(pos, e.q, e.col, e.how === 'crush' ? 0.85 : 1.15); A.play('glass', e.how !== 'ball'); }
          else if (e.t === 'ice') { glassBreak(pos, e.q, -1, 1); A.play('glass', true); }
          else { woodBreak(pos, e.q, e.w, e.h, e.w > 1.5 ? (e.w > 2.5 ? 3 : 2) : 1); A.play('woodBreak', e.t === 'plank'); }
          shake = Math.max(shake, e.t === 'plank' ? 0.32 : e.how === 'crush' ? 0.22 : 0.18);
          floatText(pos, '+' + e.pts, e.how === 'crush' ? 'gold' : '');
          if (e.how === 'crush' && crushCool <= 0) { floatText({ x: e.x, y: e.y + 0.8, z: e.z }, 'CRUSH!', 'gold big'); crushCool = 0.5; }
          break;
        }
        case 'fall': {
          m = blockMeshes[e.id];
          if (m) {
            delete blockMeshes[e.id];
            var av = new T.Vector3(e.av.x, e.av.y, e.av.z), mag = av.length();
            fallers.push({ m: m, v: new T.Vector3(e.v.x, e.v.y, e.v.z), avAxis: mag > 1e-4 ? av.normalize() : new T.Vector3(0, 0, 1), avMag: mag, h: m.b.h, t: e.t, life: 3, sunk: false });
          }
          floatText({ x: e.x, y: Math.max(-1, e.y), z: e.z }, '+' + e.pts, 'blue');
          break;
        }
        case 'crack': {
          m = blockMeshes[e.id];
          if (m && m.b.t === 'ice') { m.g.userData.main.material = iceMats[1]; m.hitWob = 1; iceChips({ x: e.x, y: e.y }); A.play('glass', false); shake = Math.max(shake, 0.1); break; }
          if (m) { var mats = m.b.t === 'crate' ? woodMats[1] : woodMats[m.b.span]; m.g.userData.main.material = mats[Math.min(mats.length - 1, (m.b.t === 'crate' ? 2 : 3) - e.hp)]; m.hitWob = 1; }
          chipsAt({ x: e.x, y: e.y }); A.play('woodHit'); shake = Math.max(shake, 0.1);
          break;
        }
        case 'knock': A.play('knock', e.v); m = blockMeshes[e.id]; if (m) m.hitWob = 0.6; break;
        case 'thud':
          if (e.f > 400) { puff({ x: e.x, y: e.y - 0.5, z: e.z }, 2, 0xf3e6cf, 0.6); }
          A.play('land', Math.min(220, e.f / 8));
          break;
        case 'bonk':
          if (e.what === 'fan' || e.what === 'shield') { A.play('fan'); shake = Math.max(shake, 0.08); }
          else A.play('ballBounce', e.v * 6);
          break;
        case 'boom': {
          var bp = new T.Vector3(e.x, e.y, e.z + 0.4);
          A.play('boom'); shake = Math.max(shake, 0.7);
          spawnSoft(bp, 2, 0xffffff, 1, 0.2, 14, true);
          spawnSoft(bp, 3.6, 0xffa020, 0.95, 0.45, 4, true);
          for (q = 0; q < 14; q++) { var fb = spawnSoft(bp.clone(), rnd(0.9, 1.6), [0xffd040, 0xff8a1a, 0xff5010][q % 3], 0.95, rnd(0.3, 0.6), 2, true); if (fb) fb.v.set(rnd(-5, 5), rnd(-2, 6), rnd(0, 3)); }
          for (q = 0; q < 12; q++) { var smk = spawnSoft(bp.clone(), rnd(1.2, 2), 0x5a5560, 0.7, rnd(1, 1.8), 1.2); if (smk) smk.v.set(rnd(-1.5, 1.5), rnd(1.5, 3.5), rnd(-0.5, 0.5)); }
          for (q = 0; q < 30; q++) addItem(chips, { p: bp.clone(), v: new T.Vector3(rnd(-10, 10), rnd(2, 12), rnd(0, 6)), r: new T.Euler(rnd(0, 3), rnd(0, 3), rnd(0, 3)), w: new T.Vector3(rnd(-20, 20), rnd(-20, 20), rnd(-20, 20)), sv: new T.Vector3(rnd(0.15, 0.4), 0.08, 0.06), life: rnd(1.2, 2), col: L(q % 3 ? '#d8202f' : '#2b1d22'), rest: 0 });
          floatText({ x: e.x, y: e.y + 1, z: e.z }, 'BOOM!', 'gold big');
          break;
        }
        case 'ballGone': if (e.y > -2) spawnSoft(new T.Vector3(e.x, e.y, e.z), 0.8, 0xffffff, 0.7, 0.35, 2); break;
        case 'clear': floatText({ x: 0, y: 2.5, z: 0.5 }, 'CLEAR! +' + e.bonus, 'gold big'); A.play('clear'); confetti(); break;
        case 'over': A.play('over'); break;
      }
    }
  }

  function syncBlocks(dt) {
    for (var id in blockMeshes) {
      var m = blockMeshes[id], b = m.b, p = b.body.translation(), q = b.body.rotation();
      if (m.drop > 0) m.drop = Math.max(0, m.drop - (22 + (14 - Math.min(14, m.drop)) * 2) * dt);
      m.g.position.set(p.x, p.y + m.drop, p.z);
      m.g.quaternion.set(q.x, q.y, q.z, q.w);
      if (m.hitWob > 0) { m.hitWob = Math.max(0, m.hitWob - dt * 4); var s = 1 + Math.sin(m.hitWob * 30) * 0.05 * m.hitWob; m.g.scale.set(s, 2 - s, s); }
      else m.g.scale.set(1, 1, 1);
    }
  }

  // ---------------------------------------------------------------- loop + input
  // Platform contract: the seed comes from the session (window.__kjSeed), one session is one
  // run, each ACCEPTED shot is emitted as {kind:'shot', n, x, y, step}, the score is sent once
  // after the run has played out. QA switches (seed, level) work standalone only.
  var EMBED = !!window.__kjEmbed;
  var Q = EMBED ? '' : location.search;
  var params = new URLSearchParams(Q), seedArg = params.get('seed');
  var RP = (window.KJReplay && window.KJReplay.active()) ? window.KJReplay : null;
  if (RP) RP.ready('smash-it');
  function newSeed() { return seedArg ? (parseInt(seedArg, 10) >>> 0) : ((Math.random() * 4294967296) >>> 0); }
  var menuLift = 1;
  var S = null, mode = 'loading', acc = 0, last = null, STEP = 1000 / 60, perfT = 0;
  var engineReady = false, sessionReady = false, runsStarted = 0, traceVersion = 0, submitted = false, replayCur = null, pendingShot = null;
  var ray = new T.Raycaster(), plane = new T.Plane(new T.Vector3(0, 0, 1), -R.FRONT), hitP = new T.Vector3();
  function tapToTarget(cx, cy) {
    var nx = (cx - fitRect.x) / fitRect.w * 2 - 1, ny = -((cy - fitRect.y) / fitRect.h * 2 - 1);
    ray.setFromCamera({ x: nx, y: ny }, pickCam);
    if (!ray.ray.intersectPlane(plane, hitP)) return null;
    return { x: Math.max(-700, Math.min(700, Math.round(hitP.x * 100))), y: Math.max(-150, Math.min(1300, Math.round(hitP.y * 100))) };
  }
  // one physical press is one tap; the shot is queued and fired before the next fixed step
  function onPress(ev) {
    if (mode !== 'play' || RP) return;
    A.init();
    var p = tapToTarget(ev.clientX, ev.clientY);
    if (p) pendingShot = p;
  }
  function onCanvas(ev) { return !ev || ev.target === canvas; }
  if (window.KJPress) window.KJPress.bind(onPress, { keys: [], ignore: function (ev) { return !onCanvas(ev); } });
  else canvas.addEventListener('pointerdown', function (ev) { if (ev.isPrimary) onPress(ev); });
  function fireShot(x, y, live) {
    var n = S.shots, step = S.step;
    if (R.shoot(S, x, y) !== true) return false;
    // the ACTION only, never its result: the server replays it
    if (live && traceVersion >= 1 && typeof window.__kjShot === 'function') { try { window.__kjShot(performance.now(), n, x, y, step); } catch (_e) {} }
    return true;
  }
  function clearScene() {
    if (S && S.world) S.world.free();
    for (var id in blockMeshes) { scene.remove(blockMeshes[id].g); delete blockMeshes[id]; }
    fallers.forEach(function (f) { scene.remove(f.m.g); }); fallers = [];
  }
  // the title screen shows a preview tower (not a run: nothing is emitted or scored)
  function previewTower() { clearScene(); S = R.initSim(newSeed(), 1); shownScore = 0; handleEvents(S); }
  function startRun() {
    if (!engineReady || !sessionReady) return false;
    if (EMBED && runsStarted > 0) return false;          // inside the platform one session is one run
    runsStarted++; submitted = false;
    traceVersion = (typeof window.__kjGameStart === 'function') ? (Number(window.__kjGameStart(performance.now(), R.RULES_VERSION)) || 0) : 0;
    if (RP) { traceVersion = RP.capVersion(traceVersion); replayCur = RP.cursor(['shot'], function (p) { return Number(p.step); }); RP.started(traceVersion); }
    clearScene();
    var seedInt = (EMBED || RP) ? R.seedToInt(window.__kjSeed) : newSeed();
    S = R.initSim(seedInt, parseInt(params.get('level'), 10) || 1);   // params are empty inside the platform (Q)
    shownScore = 0; pendingShot = null; handleEvents(S);
    return true;
  }
  function submitNow() {
    if (submitted || !S) return; submitted = true;
    if (RP) RP.setStep(S.step);
    if (typeof window.__kjSubmit === 'function') window.__kjSubmit(S.score);
  }
  function setPlay() {
    var ok = engineReady && sessionReady;
    elPlay.disabled = !ok; elPlay.textContent = ok ? 'PLAY' : 'PREPARING YOUR GAME';
  }
  function play() {
    if (mode !== 'menu') return;
    A.init();
    if (!startRun()) return;
    mode = 'play'; elMenu.classList.add('hide'); hud.classList.remove('inmenu');
    if (S && S.shots === 0) document.getElementById('hint').classList.remove('hide');
  }
  elPlay.addEventListener('click', play);
  document.getElementById('againBtn').addEventListener('click', function () { if (EMBED) return; mode = 'menu'; elOver.classList.add('hide'); play(); });
  var muted = false;
  var pausedFrom = null;
  document.getElementById('gear').addEventListener('click', function () { A.init(); if (mode === 'play' && !EMBED && !RP) { pausedFrom = 'play'; mode = 'paused'; } elSet.classList.remove('hide'); });
  function closeSettings() { elSet.classList.add('hide'); if (pausedFrom) { mode = pausedFrom; pausedFrom = null; last = null; } }
  document.getElementById('closeSet').addEventListener('click', closeSettings);
  document.getElementById('resumeBtn').addEventListener('click', closeSettings);
  elSound.addEventListener('click', function () { muted = !muted; A.mute(muted); elSound.classList.toggle('off', muted); });

  // the run is over: let the last pieces fall, then send the score once (a timer backs up a hidden tab)
  function endRun() {
    mode = 'over';
    setTimeout(submitNow, 1500);
    if (EMBED || RP) return;
    var prev = bestScore(); elFinal.textContent = S.score; elCleared.textContent = S.level - 1;
    document.getElementById('best').textContent = Math.max(prev, S.score);
    document.getElementById('newBest').classList.toggle('on', S.score > prev && S.score > 0);
    if (S.score > prev) bestScore(S.score);
    setTimeout(function () { elOver.classList.remove('hide'); }, 600);
  }

  function frame(now) {
    if (last === null) last = now;
    var dtMs = RP ? RP.elapsed(now - last, STEP * 3) : Math.min(now - last, STEP * 3); last = now; acc += dtMs;
    var dt = dtMs / 1000; perfT += dt;
    while (acc >= STEP) {
      acc -= STEP;
      if (mode === 'play') {
        if (RP) { var due = replayCur.due(S.step); for (var di = 0; di < due.length; di++) fireShot(Number(due[di].x), Number(due[di].y), false); }
        else if (pendingShot) { fireShot(pendingShot.x, pendingShot.y, true); pendingShot = null; }
        R.stepSim(S); handleEvents(S);
        if (S.phase === 'over') endRun();
      }
    }
    if (camState.t < 1) {
      camState.t = Math.min(1, camState.t + dt / 1.2);
      var k = camState.t * camState.t * (3 - 2 * camState.t);
      camState.d = camState.d0 + (camState.dT - camState.d0) * k; camState.look = camState.look0 + (camState.lookT - camState.look0) * k;
    }
    menuLift += ((mode === 'menu' || mode === 'loading' ? 1 : 0) - menuLift) * Math.min(1, dt * 2.5);
    placeCam(pickCam, camState.d, camState.look + menuLift * camState.d * TANH * 0.2);
    placeCannon();
    syncBlocks(dt);
    if (S) syncBalls(S);
    fan.visible = !!(S && S.fan);
    pend.visible = !!(S && S.pend);
    if (S && S.pend) { var pp = S.pend.body.translation(), pq = S.pend.body.rotation(); pend.position.set(pp.x, pp.y, pp.z); pend.quaternion.set(pq.x, pq.y, pq.z, pq.w); }
    if (S && S.shield) { var sp = S.shield.body.translation(); shield.position.set(sp.x, sp.y, sp.z); }
    if (S && shield2 && S.shields.length > 1) { var sp2 = S.shields[1].body.translation(); shield2.position.set(sp2.x, sp2.y, sp2.z); }
    for (var bid in blockMeshes) { var sk = blockMeshes[bid].g.userData.spark; if (sk) { sk.scale.setScalar(0.35 + Math.random() * 0.25); sk.material.rotation = Math.random() * 6; } }
    if (S && S.fan) { var fp = S.fan.body.translation(), fq = S.fan.body.rotation(); fan.position.set(fp.x, fp.y, fp.z); fan.quaternion.set(fq.x, fq.y, fq.z, fq.w); }
    stepPool(shards, dt, 'glass'); stepPool(petals, dt, 'petal'); stepPool(plates, dt, 'glass'); stepPool(chips, dt, 'wood'); stepPool(drops, dt, 'drop'); stepPool(confs, dt, 'conf');
    stepSofts(dt); stepFallers(dt);
    crushCool -= dt; kick *= 0.85; aimCannon();
    muzzleFlash.material.opacity *= 0.75;
    shake *= 0.86;
    camera.position.copy(pickCam.position); camera.quaternion.copy(pickCam.quaternion);
    camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake;
    if (S) { updateHud(S); bumpScore(S); if (RP && mode === 'play') RP.report(S.step, S.score); }
    renderer.clear();
    renderer.render(bgScene, bgCam);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  setTheme('meadow'); backdrop('beach');
  placeCam(pickCam, camState.d, camState.look);
  resize();
  requestAnimationFrame(frame);
  setPlay();
  R.ready().then(function () {
    engineReady = true;
    previewTower();
    mode = 'menu';
    setPlay();
    if (RP && sessionReady) play();
  });
  function onSessionReady() { sessionReady = true; setPlay(); if (RP && engineReady) play(); }
  if (typeof window.__kjOnSessionReady === 'function') window.__kjOnSessionReady(onSessionReady); else onSessionReady();

  // test hook only: the shipped page exposes no game state
  if (window.__smashItHarness) window.__smashItHarness.game = { fxGlass: function (x, y, col) { glassBreak({ x: x, y: y, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, col, 1.15); }, get S() { return S; }, R: R, tapToTarget: tapToTarget, get mode() { return mode; }, get pendingShot() { return pendingShot; }, get acc() { return acc; },
    get sessionReady() { return sessionReady; }, get engineReady() { return engineReady; }, get runsStarted() { return runsStarted; }, get traceVersion() { return traceVersion; }, get submitted() { return submitted; }, get fit() { return fitRect; },
    toScreen: function (x, y, z) { var p = new T.Vector3(x, y, z === undefined ? R.FRONT : z).project(pickCam); return { x: fitRect.x + (p.x + 1) / 2 * fitRect.w, y: fitRect.y + (1 - p.y) / 2 * fitRect.h }; } };
})();
