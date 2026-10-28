// Minar Tod: the 3D view, effects, audio and screens. Everything here READS the
// sim in rules.js and never writes it. Math.random and Math.sin are fine here:
// nothing in this file can change a score.
(function () {
  'use strict';
  var THREE = window.THREE;
  var QS = location.search;
  var DW = 414, DH = 736, DA = DW / DH;
  var STEP = 1 / STEP_HZ;
  var ML = MAX_LEVELS;

  // World units. A block is BW wide around the ring, BH tall, BD deep.
  var BW = 1.0, BH = 0.84, BD = 0.94, R = 1.36;
  var GROUND_Y = -1.7;
  var CAP_S = 0.6;
  var PAL = [null, '#ef3b4f', '#ffb400', '#22b573', '#3d6bff', '#a64bf0'];
  var PAL_STEEL = '#9aa6b4', PAL_BOMB = '#ffffff';
  var TAU = Math.PI * 2;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ audio
  var Snd = (function () {
    var ctx = null, master = null, nbuf = null, lastTumble = 0;
    var muted = lsGet('minar-tod-muted') === '1';
    function init() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.ratio.value = 5;
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.85;
      master.connect(comp); comp.connect(ctx.destination);
      nbuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      var d = nbuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    function ok() { return ctx && ctx.state !== 'closed'; }
    function env(g, t, a, peak, dec) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
    }
    function tone(type, f0, f1, t, a, peak, dec) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + a + dec);
      env(g, t, a, peak, dec); o.connect(g); g.connect(master);
      o.start(t); o.stop(t + a + dec + 0.05);
    }
    function noise(t, dur, type, f0, f1, q, peak, a) {
      var s = ctx.createBufferSource(); s.buffer = nbuf;
      var f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q || 1;
      f.frequency.setValueAtTime(f0, t);
      if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
      var g = ctx.createGain(); env(g, t, a || 0.004, peak, dur);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t, Math.random() * 0.6); s.stop(t + dur + 0.1);
    }
    var api = {
      init: init,
      isMuted: function () { return muted; },
      setMuted: function (m) {
        muted = m; lsSet('minar-tod-muted', m ? '1' : '0');
        if (master) master.gain.setTargetAtTime(m ? 0 : 0.85, ctx.currentTime, 0.02);
      },
      thump: function () {
        if (!ok()) return; var t = ctx.currentTime;
        tone('sine', 190, 48, t, 0.004, 0.75, 0.16);
        noise(t, 0.06, 'lowpass', 1400, 300, 0.7, 0.35);
        noise(t + 0.02, 0.22, 'bandpass', 900, 2400, 1.2, 0.08, 0.05);
      },
      crunch: function (n) {
        if (!ok()) return; var t = ctx.currentTime;
        var k = Math.min(3 + (n >> 1), 12), big = Math.min(1, n / 14);
        tone('sine', 120, 40, t, 0.003, 0.5 + 0.4 * big, 0.18 + 0.25 * big);
        for (var i = 0; i < k; i++) {
          var dt = i * (0.018 + 0.012 * big) + Math.random() * 0.02;
          noise(t + dt, 0.05 + Math.random() * 0.07, 'bandpass', rand(700, 2600), 0, 1.4, rand(0.25, 0.45));
        }
        noise(t, 0.35 + 0.5 * big, 'lowpass', 2200, 180, 0.6, 0.25 + 0.25 * big, 0.01);
        if (n >= 6) tone('triangle', 520 + n * 14, 1040 + n * 28, t + 0.04, 0.01, 0.08, 0.25);
      },
      knock: function (v) {
        if (!ok()) return; var now = ctx.currentTime;
        if (now - lastTumble < 0.035) return; lastTumble = now;
        var p = clamp(v / 14, 0.05, 0.4);
        tone('sine', rand(150, 230), 70, now, 0.002, p, 0.07);
        noise(now, 0.04, 'bandpass', rand(400, 900), 0, 2, p * 0.8);
      },
      clang: function () {
        if (!ok()) return; var t = ctx.currentTime;
        [523, 1307, 2153, 2989, 3870].forEach(function (f, i) { tone('sine', f, f * 0.995, t, 0.002, 0.22 / (i * 0.6 + 1), 0.9 - i * 0.12); });
        noise(t, 0.05, 'highpass', 3000, 0, 0.7, 0.4);
      },
      boom: function () {
        if (!ok()) return; var t = ctx.currentTime;
        tone('sine', 90, 28, t, 0.005, 0.95, 0.9);
        noise(t, 1.1, 'lowpass', 1800, 60, 0.8, 0.9, 0.006);
        noise(t + 0.05, 0.5, 'bandpass', 600, 200, 0.8, 0.4);
      },
      whoosh: function () {
        if (!ok()) return; var t = ctx.currentTime;
        noise(t, 0.35, 'bandpass', 500, 2400, 2.5, 0.25, 0.08);
      },
      chord: function () {
        if (!ok()) return; var t = ctx.currentTime;
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach(function (f, i) {
          tone('triangle', f, 0, t + i * 0.07, 0.01, 0.2, 0.9 - i * 0.05);
          tone('sine', f * 2, 0, t + i * 0.07, 0.01, 0.05, 0.6);
        });
        [261.63, 329.63, 392].forEach(function (f) { tone('sawtooth', f, 0, t + 0.36, 0.04, 0.035, 1.0); });
        noise(t + 0.3, 0.8, 'highpass', 6000, 9000, 0.5, 0.06, 0.1);
      },
      lose: function () {
        if (!ok()) return; var t = ctx.currentTime;
        tone('triangle', 392, 370, t, 0.01, 0.2, 0.25);
        tone('triangle', 311, 262, t + 0.22, 0.01, 0.2, 0.55);
      },
      rumble: function () {
        if (!ok()) return; var t = ctx.currentTime;
        noise(t, 1.2, 'lowpass', 500, 80, 0.7, 0.55, 0.05);
        for (var i = 0; i < 9; i++) tone('sine', rand(90, 180), 50, t + i * 0.09 + Math.random() * 0.05, 0.003, 0.2, 0.1);
      },
      tick: function (hi) {
        if (!ok()) return; var t = ctx.currentTime;
        tone('square', hi ? 1760 : 1320, 0, t, 0.002, 0.07, 0.04);
      },
      gong: function () {
        if (!ok()) return; var t = ctx.currentTime;
        [110, 220.6, 277.2, 331, 440.9, 589].forEach(function (f, i) { tone('sine', f, f * 0.99, t, 0.01, 0.3 / (i + 1), 2.6 - i * 0.25); });
        noise(t, 0.12, 'lowpass', 1200, 200, 0.6, 0.3);
      },
      blip: function (f) {
        if (!ok()) return; var t = ctx.currentTime;
        tone('triangle', f || 660, (f || 660) * 1.5, t, 0.005, 0.18, 0.14);
      },
      count: function (i) {
        if (!ok()) return; var t = ctx.currentTime;
        tone('triangle', 700 + i * 30, 0, t, 0.002, 0.05, 0.05);
      },
    };
    return api;
  })();

  // ------------------------------------------------------------------ textures
  function canvasTex(w, h, draw) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  function rr(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  // Colour blocks: a white face multiplied by the instance colour.
  var faceTex = canvasTex(128, 128, function (g, w) {
    g.fillStyle = '#d9d9d9'; g.fillRect(0, 0, w, w);
    var gr = g.createLinearGradient(0, 0, 0, w); gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#ececec');
    g.fillStyle = gr; rr(g, 9, 9, w - 18, w - 18, 16); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.07)';
    for (var i = 0; i < 4; i++) { g.save(); g.translate(64, 64); g.rotate(i * Math.PI / 2 + Math.PI / 4);
      g.beginPath(); g.ellipse(0, -17, 8, 15, 0, 0, TAU); g.fill(); g.restore(); }
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(64, 64, 7, 0, TAU); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.06)';
    for (var k = 0; k < 8; k++) { var a = k * TAU / 8; g.beginPath(); g.arc(64 + Math.cos(a) * 40, 64 + Math.sin(a) * 40, 4, 0, TAU); g.fill(); }
  });
  var steelTex = canvasTex(128, 128, function (g, w) {
    var gr = g.createLinearGradient(0, 0, w, w); gr.addColorStop(0, '#e9eef3'); gr.addColorStop(0.5, '#a9b4c0'); gr.addColorStop(1, '#d4dbe3');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
    g.strokeStyle = 'rgba(40,50,60,0.45)'; g.lineWidth = 10; rr(g, 10, 10, w - 20, w - 20, 10); g.stroke();
    g.beginPath(); g.moveTo(18, 18); g.lineTo(w - 18, w - 18); g.moveTo(w - 18, 18); g.lineTo(18, w - 18); g.stroke();
    [[20, 20], [w - 20, 20], [20, w - 20], [w - 20, w - 20]].forEach(function (p) {
      g.fillStyle = '#5d6874'; g.beginPath(); g.arc(p[0], p[1], 7, 0, TAU); g.fill();
      g.fillStyle = '#f4f7fa'; g.beginPath(); g.arc(p[0] - 2, p[1] - 2, 3, 0, TAU); g.fill();
    });
  });
  var bombTex = canvasTex(128, 128, function (g, w) {
    g.fillStyle = '#ffcc00'; g.fillRect(0, 0, w, w);
    g.save(); rr(g, 0, 0, w, w, 0); g.clip(); g.fillStyle = '#1d1a22';
    for (var i = -w; i < w * 2; i += 26) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 13, 0); g.lineTo(i + 13 - w, w); g.lineTo(i - w, w); g.fill(); }
    g.restore();
    g.fillStyle = '#2a2430'; rr(g, 16, 16, w - 32, w - 32, 14); g.fill();
    g.fillStyle = '#0f0d12'; g.beginPath(); g.arc(60, 70, 26, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(51, 61, 7, 0, TAU); g.fill();
    g.strokeStyle = '#c99a5a'; g.lineWidth = 5; g.beginPath(); g.moveTo(74, 48); g.quadraticCurveTo(84, 34, 96, 38); g.stroke();
    g.fillStyle = '#ff7a1a'; g.beginPath(); g.arc(98, 37, 9, 0, TAU); g.fill();
    g.fillStyle = '#fff3a0'; g.beginPath(); g.arc(98, 37, 4, 0, TAU); g.fill();
  });

  // A box whose edges are rounded: vertices are pushed out from an inner box.
  function roundedBox(w, h, d, r) {
    var seg = 7, geo = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
    var pos = geo.attributes.position, nor = geo.attributes.normal;
    var half = [w / 2, h / 2, d / 2];
    function remap(v, hh) {
      var a = Math.abs(v) / hh, s = v < 0 ? -1 : 1, rr2 = r / hh, o;
      if (a > 0.99) o = 1; else if (a > 0.7) o = 1 - 0.35 * rr2; else if (a > 0.4) o = 1 - rr2; else if (a > 0.1) o = (1 - rr2) / 3; else o = 0;
      return s * o * hh;
    }
    var p = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (var i = 0; i < pos.count; i++) {
      p.set(remap(pos.getX(i), half[0]), remap(pos.getY(i), half[1]), remap(pos.getZ(i), half[2]));
      c.set(clamp(p.x, -half[0] + r, half[0] - r), clamp(p.y, -half[1] + r, half[1] - r), clamp(p.z, -half[2] + r, half[2] - r));
      n.subVectors(p, c);
      if (n.lengthSq() < 1e-9) n.set(nor.getX(i), nor.getY(i), nor.getZ(i)); else n.normalize();
      p.copy(c).addScaledVector(n, r);
      pos.setXYZ(i, p.x, p.y, p.z); nor.setXYZ(i, n.x, n.y, n.z);
    }
    return geo;
  }

  // ------------------------------------------------------------------ scene
  var canvas = $('scene');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);
  var scene = new THREE.Scene();
  var HORIZON = '#fbe3bd';
  scene.background = canvasTex(4, 256, function (g, w, h) {
    var gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#0d5f70'); gr.addColorStop(0.42, '#2f9fa3'); gr.addColorStop(0.72, '#9fd6c4'); gr.addColorStop(1, HORIZON);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  scene.fog = new THREE.Fog(HORIZON, 40, 110);
  var camera = new THREE.PerspectiveCamera(36, 1, 0.5, 300);
  var BASE_FOV = 36;

  scene.add(new THREE.HemisphereLight('#fff6e4', '#8a5a40', 1.5));
  var key = new THREE.DirectionalLight('#ffffff', 2.3); key.position.set(-5, 12, 9); scene.add(key);
  var fill = new THREE.DirectionalLight('#9ee6ff', 0.7); fill.position.set(7, 3, -4); scene.add(fill);
  var rim = new THREE.DirectionalLight('#ffd7a8', 0.6); rim.position.set(3, 6, -10); scene.add(rim);

  // Ground, blob shadow, distant skyline.
  var ground = new THREE.Mesh(new THREE.CircleGeometry(140, 48), new THREE.MeshLambertMaterial({
    map: canvasTex(256, 256, function (g, w) {
      var gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      gr.addColorStop(0, '#f6d8a6'); gr.addColorStop(0.08, '#efc893'); gr.addColorStop(0.3, '#e8bd88'); gr.addColorStop(1, '#f3d6a8');
      g.fillStyle = gr; g.fillRect(0, 0, w, w);
      g.strokeStyle = 'rgba(160,90,50,0.16)'; g.lineWidth = 2;
      [0.06, 0.075].forEach(function (r) { g.beginPath(); g.arc(w / 2, w / 2, r * w, 0, TAU); g.stroke(); });
    }) }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = GROUND_Y; scene.add(ground);
  var blobTex = canvasTex(128, 128, function (g, w) {
    var gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(60,25,10,0.55)'); gr.addColorStop(0.55, 'rgba(60,25,10,0.25)'); gr.addColorStop(1, 'rgba(60,25,10,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
  var blob = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = GROUND_Y + 0.01; scene.add(blob);

  (function skyline() {
    var mat = new THREE.MeshLambertMaterial({ color: '#c99f86' });
    var mat2 = new THREE.MeshLambertMaterial({ color: '#d9b29a' });
    for (var i = 0; i < 15; i++) {
      var t = i / 14, a = Math.PI * (0.6 + 0.8 * t) + rand(-0.04, 0.04), rad = rand(62, 80);
      if (Math.abs(t - 0.5) < 0.1) continue;   // keep the sky behind the tower clear
      var grp = new THREE.Group();
      if (i % 3 === 1) {
        var hgt = rand(10, 16);
        var shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, hgt, 8), mat); shaft.position.y = hgt / 2; grp.add(shaft);
        var bal = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.3, 0.6, 8), mat2); bal.position.y = hgt * 0.72; grp.add(bal);
        var top = new THREE.Mesh(new THREE.SphereGeometry(1.05, 10, 8, 0, TAU, 0, Math.PI / 2), mat2); top.position.y = hgt; grp.add(top);
        var sp = new THREE.Mesh(new THREE.ConeGeometry(0.25, 1.6, 6), mat); sp.position.y = hgt + 1.6; grp.add(sp);
      } else {
        var bw = rand(5, 9), bh = rand(3, 6);
        var base = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bw * 0.6), mat2); base.position.y = bh / 2; grp.add(base);
        var dome = new THREE.Mesh(new THREE.SphereGeometry(bw * 0.3, 12, 8, 0, TAU, 0, Math.PI / 2), mat); dome.position.y = bh; grp.add(dome);
      }
      grp.position.set(Math.sin(a) * rad, GROUND_Y, Math.cos(a) * rad);
      grp.rotation.y = a;
      scene.add(grp);
    }
  })();

  // Pedestal: plinth, a truck-art band, a turning gold top.
  var bandTex = canvasTex(1024, 128, function (g, w, h) {
    g.fillStyle = '#b3123e'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffcc1a'; g.fillRect(0, 0, w, 14); g.fillRect(0, h - 14, w, 14);
    var cols = ['#22b573', '#3d6bff', '#ffffff', '#ff7a1a'];
    for (var i = 0; i < 32; i++) {
      g.fillStyle = cols[i % 4]; var x = i * 32;
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x + 32, 14); g.lineTo(x + 16, 36); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x, h - 14); g.lineTo(x + 32, h - 14); g.lineTo(x + 16, h - 36); g.closePath(); g.fill();
    }
    for (var k = 0; k < 16; k++) {
      var cx = k * 64 + 32, cy = h / 2;
      g.fillStyle = '#ffffff';
      for (var p = 0; p < 6; p++) { var a = p * TAU / 6; g.beginPath(); g.ellipse(cx + Math.cos(a) * 10, cy + Math.sin(a) * 10, 7, 5, a, 0, TAU); g.fill(); }
      g.fillStyle = k % 2 ? '#22b573' : '#ffcc1a'; g.beginPath(); g.arc(cx, cy, 6, 0, TAU); g.fill();
    }
  });
  bandTex.wrapS = THREE.RepeatWrapping;
  var pedestal = new THREE.Group();
  var cream = new THREE.MeshPhongMaterial({ color: '#f4e4c6', shininess: 20 });
  var gold = new THREE.MeshPhongMaterial({ color: '#f2b233', shininess: 90, specular: '#fff1b0' });
  var plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.75, 0.5, 8), cream); plinth.position.y = GROUND_Y + 0.25; pedestal.add(plinth);
  var band = new THREE.Mesh(new THREE.CylinderGeometry(2.08, 2.08, 0.95, 8, 1), new THREE.MeshPhongMaterial({ map: bandTex, shininess: 30 }));
  band.position.y = GROUND_Y + 0.5 + 0.475; pedestal.add(band);
  var topSlab = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.25, 0.25, 8), gold); topSlab.position.y = -0.125; pedestal.add(topSlab);
  scene.add(pedestal);

  // The minaret cap that rides on top of the tower.
  var cap = new THREE.Group();
  (function buildCap() {
    var white = new THREE.MeshPhongMaterial({ color: '#fff6e6', shininess: 30 });
    var teal = new THREE.MeshPhongMaterial({ color: '#13a39a', shininess: 70, specular: '#9effef' });
    var balc = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.7, 0.24, 8), gold); balc.position.y = 0.12; cap.add(balc);
    var drumTex = canvasTex(512, 128, function (g, w, h) {
      g.fillStyle = '#fff6e6'; g.fillRect(0, 0, w, h);
      for (var i = 0; i < 8; i++) {
        var x = i * 64 + 14;
        g.fillStyle = '#13a39a'; g.beginPath(); g.moveTo(x, h - 12); g.lineTo(x, 50); g.quadraticCurveTo(x + 18, 14, x + 36, 50); g.lineTo(x + 36, h - 12); g.closePath(); g.fill();
        g.fillStyle = '#0b5f63'; g.beginPath(); g.moveTo(x + 7, h - 16); g.lineTo(x + 7, 56); g.quadraticCurveTo(x + 18, 32, x + 29, 56); g.lineTo(x + 29, h - 16); g.closePath(); g.fill();
      }
      g.fillStyle = '#f2b233'; g.fillRect(0, 0, w, 8); g.fillRect(0, h - 8, w, 8);
    });
    var drum = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.2, 0.95, 16), new THREE.MeshPhongMaterial({ map: drumTex, shininess: 25 }));
    drum.position.y = 0.24 + 0.475; cap.add(drum);
    var ring = new THREE.Mesh(new THREE.CylinderGeometry(1.32, 1.32, 0.14, 16), gold); ring.position.y = 1.24; cap.add(ring);
    var prof = [];
    var pts = [[1.22, 0], [1.38, 0.28], [1.36, 0.62], [1.12, 1.02], [0.7, 1.42], [0.32, 1.78], [0.12, 2.05], [0.0, 2.16]];
    for (var i = 0; i < pts.length; i++) prof.push(new THREE.Vector2(pts[i][0], pts[i][1]));
    var dome = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), teal); dome.position.y = 1.3; cap.add(dome);
    var fin1 = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), gold); fin1.position.y = 3.5; cap.add(fin1);
    var fin2 = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.7, 8), gold); fin2.position.y = 3.95; cap.add(fin2);
    var fin3 = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), gold); fin3.position.y = 3.25; cap.add(fin3);
    cap.scale.setScalar(CAP_S);
  })();
  scene.add(cap);

  // Instanced blocks: one mesh per kind.
  var CAP = COLS * ML;
  var blockGeo = roundedBox(BW * 0.96, BH * 0.96, BD, 0.13);
  function blockMesh(mat) {
    var m = new THREE.InstancedMesh(blockGeo, mat, CAP);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; m.count = 0; scene.add(m); return m;
  }
  var mColour = blockMesh(new THREE.MeshPhongMaterial({ map: faceTex, shininess: 55, specular: '#3a3a3a' }));
  mColour.setColorAt(0, new THREE.Color('#ffffff')); mColour.instanceColor.setUsage(THREE.DynamicDrawUsage);
  var mSteel = blockMesh(new THREE.MeshPhongMaterial({ map: steelTex, shininess: 110, specular: '#ffffff' }));
  var bombMat = new THREE.MeshPhongMaterial({ map: bombTex, shininess: 40, emissive: '#ff3000', emissiveIntensity: 0 });
  var mBomb = blockMesh(bombMat);

  // Debris: chunky little blocks with spin and gravity.
  var DEB = 700;
  var debGeo = roundedBox(0.36, 0.3, 0.34, 0.07);
  var mDeb = new THREE.InstancedMesh(debGeo, new THREE.MeshPhongMaterial({ shininess: 40, specular: '#2a2a2a' }), DEB);
  mDeb.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mDeb.frustumCulled = false; mDeb.count = 0;
  mDeb.setColorAt(0, new THREE.Color('#fff')); scene.add(mDeb);
  var debris = [];
  // Dust puffs.
  var DUST = 160;
  var mDust = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 1),
    new THREE.MeshLambertMaterial({ color: '#fff4e2', transparent: true, opacity: 0.4, depthWrite: false }), DUST);
  mDust.frustumCulled = false; mDust.count = 0; scene.add(mDust);
  var dust = [];

  // The ball.
  var ballMat = new THREE.MeshPhongMaterial({ color: '#28345e', shininess: 120, specular: '#c9d8ff' });
  var ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.36, 22, 16), ballMat);
  ballMesh.visible = false; scene.add(ballMesh);

  // ------------------------------------------------------------------ 2D fx layer
  var fx = $('fx'), fg = fx.getContext('2d');
  var confetti = [], popups = [];
  var VW = 1, VH = 1, UI = 1;

  function resize() {
    VW = window.innerWidth; VH = window.innerHeight;
    renderer.setSize(VW, VH, false);
    camera.aspect = VW / VH;
    camera.fov = camera.aspect < DA ? 2 * Math.atan(Math.tan(BASE_FOV * Math.PI / 360) * DA / camera.aspect) * 180 / Math.PI : BASE_FOV;
    camera.updateProjectionMatrix();
    fx.width = Math.round(VW * DPR); fx.height = Math.round(VH * DPR);
    UI = Math.min(VW / DW, VH / DH);
    $('stage').style.transform = 'scale(' + UI + ')';
  }
  window.addEventListener('resize', resize);
  resize();

  var tmpV = new THREE.Vector3();
  function toScreen(x, y, z) {
    tmpV.set(x, y, z).project(camera);
    return { x: (tmpV.x + 1) / 2 * VW, y: (1 - tmpV.y) / 2 * VH };
  }
  function popup(text, x, y, color, size, sub) {
    // Stack on top of any popup that is still young so they never overlap.
    for (var i = 0; i < popups.length; i++) if (popups[i].life < 0.5) y = Math.min(y, popups[i].y - (popups[i].size + 26) * UI);
    popups.push({ text: text, x: x, y: y, color: color, size: size, life: 0, max: 1.3, sub: sub });
  }
  function burstConfetti(n, x, y, spread) {
    var cols = ['#ef3b4f', '#ffb400', '#22b573', '#3d6bff', '#a64bf0', '#ffffff', '#ff7a1a'];
    for (var i = 0; i < n; i++) {
      var a = rand(-Math.PI, 0), s = rand(250, 750) * (spread || 1);
      confetti.push({ x: x, y: y, vx: Math.cos(a) * s * 0.8, vy: Math.sin(a) * s - 200, r: rand(0, TAU), vr: rand(-12, 12),
        w: rand(6, 11), h: rand(10, 18), c: cols[i % cols.length], life: 0, max: rand(2.2, 3.4), flip: rand(4, 10) });
    }
  }
  function drawFx(dt) {
    fg.setTransform(DPR, 0, 0, DPR, 0, 0);
    fg.clearRect(0, 0, VW, VH);
    var s = UI;
    for (var i = confetti.length - 1; i >= 0; i--) {
      var c = confetti[i];
      c.life += dt; if (c.life > c.max) { confetti.splice(i, 1); continue; }
      c.vy += 900 * dt; c.vx *= Math.pow(0.35, dt); c.vy *= Math.pow(0.6, dt);
      c.x += c.vx * dt; c.y += c.vy * dt; c.r += c.vr * dt;
      fg.save(); fg.translate(c.x, c.y); fg.rotate(c.r); fg.scale(Math.cos(c.life * c.flip), 1);
      fg.globalAlpha = clamp((c.max - c.life) * 2, 0, 1);
      fg.fillStyle = c.c; fg.fillRect(-c.w * s / 2, -c.h * s / 2, c.w * s, c.h * s); fg.restore();
    }
    fg.globalAlpha = 1;
    for (var j = popups.length - 1; j >= 0; j--) {
      var p = popups[j];
      p.life += dt; if (p.life > p.max) { popups.splice(j, 1); continue; }
      var k = p.life / p.max;
      var pop = p.life < 0.18 ? 0.4 + 0.75 * (p.life / 0.18) : 1.15 - 0.15 * Math.min(1, (p.life - 0.18) * 6);
      fg.save();
      fg.translate(p.x, p.y - 40 * s * Math.sqrt(k));
      fg.scale(pop * s, pop * s);
      fg.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
      fg.font = p.size + 'px "Titan One", system-ui, sans-serif';
      fg.textAlign = 'center'; fg.textBaseline = 'middle';
      fg.lineJoin = 'round'; fg.lineWidth = p.size * 0.22; fg.strokeStyle = 'rgba(40,10,30,0.85)';
      fg.strokeText(p.text, 0, 0); fg.fillStyle = p.color; fg.fillText(p.text, 0, 0);
      if (p.sub) {
        fg.font = (p.size * 0.5) + 'px "Titan One", system-ui, sans-serif';
        fg.lineWidth = p.size * 0.12; fg.strokeText(p.sub, 0, p.size * 0.78); fg.fillStyle = '#ffffff'; fg.fillText(p.sub, 0, p.size * 0.78);
      }
      fg.restore();
    }
  }

  // ------------------------------------------------------------------ tower visuals
  // The world being drawn: the run, the hands-on practice, or the menu tower.
  // All three have the same shape: { grid, angle }.
  var sim = null, menuSim = null, prac = null;
  function world() { return mode === 'prac' && prac ? prac : (sim && mode !== 'menu' ? sim : menuSim); }

  var V = { cols: [], camH: 10, capY: 10, capVY: 0, capFly: null, shake: 0, angle: 0, prevAngle: 0,
    ball: null, afterBall: null, timers: [] };

  function colourOf(t) { return t === STEEL ? PAL_STEEL : t === BOMB ? '#ffcc00' : PAL[t]; }

  function buildVis(grid, drop) {
    V.cols = [];
    for (var c = 0; c < COLS; c++) {
      var arr = [], h = colHeight(grid, c);
      for (var r = 0; r < h; r++) {
        var ty = BH * (r + 0.5);
        arr.push({ t: grid[c * ML + r], y: drop ? ty + 11 + r * 0.55 + ((c * 3) % 8) * 0.18 : ty, vy: 0, sq: 1 });
      }
      V.cols.push(arr);
    }
    if (drop) { V.capY = topHeight(grid) * BH + 22; V.capVY = 0; V.capFly = null; }
  }

  function colTheta(c, angle) { return (c * COL_ANG + angle) / ANG * TAU; }
  function blockPos(c, y, angle, out) {
    var th = colTheta(c, angle);
    out.set(Math.sin(th) * R, y, Math.cos(th) * R);
    return th;
  }
  // Where block (c, r) is drawn right now (its face centre).
  function blockFace(c, r, out) {
    var b = V.cols[c] && V.cols[c][r];
    var th = colTheta(c, V.angle), rad = R + BD / 2;
    out.set(Math.sin(th) * rad, b ? b.y : BH * (r + 0.5), Math.cos(th) * rad);
    return out;
  }

  function spawnDebris(x, y, z, colour, n, power) {
    var col = new THREE.Color(colour);
    for (var i = 0; i < n; i++) {
      if (debris.length >= DEB) debris.shift();
      var out = new THREE.Vector3(x, 0, z).normalize();
      var sp = rand(2, 5.5) * power;
      debris.push({ p: new THREE.Vector3(x + rand(-0.3, 0.3), y + rand(-0.25, 0.25), z + rand(-0.3, 0.3)),
        v: new THREE.Vector3(out.x * sp + rand(-2, 2), rand(2.5, 7.5) * power, out.z * sp * 0.6 + rand(-1, 1.5) * power),
        r: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)), w: new THREE.Vector3(rand(-12, 12), rand(-12, 12), rand(-12, 12)),
        s: rand(0.7, 1.25), life: 0, max: rand(1.4, 2.3), c: col.clone().offsetHSL(0, 0, rand(-0.06, 0.06)) });
    }
  }
  function spawnDust(x, y, z, n, size) {
    for (var i = 0; i < n; i++) {
      if (dust.length >= DUST) dust.shift();
      dust.push({ p: new THREE.Vector3(x + rand(-0.4, 0.4), y + rand(-0.3, 0.3), z + rand(-0.2, 0.5)),
        v: new THREE.Vector3(rand(-1.2, 1.2), rand(0.4, 1.8), rand(0, 1.6)), s0: rand(0.3, 0.6) * (size || 1), s1: rand(1.2, 2.0) * (size || 1),
        life: 0, max: rand(0.6, 1.1) });
    }
  }

  var vA = new THREE.Vector3(), vB = new THREE.Vector3();
  // Remove the broken cells from the visual columns (rows in the grid BEFORE the hit).
  function breakVis(cells, power) {
    var byCol = {};
    for (var i = 0; i < cells.length; i++) {
      var c = (cells[i] / ML) | 0, r = cells[i] - c * ML;
      (byCol[c] = byCol[c] || []).push(r);
    }
    var nDust = 0;
    Object.keys(byCol).forEach(function (k) {
      var c = +k, rows = byCol[k].sort(function (a, b) { return b - a; });
      rows.forEach(function (r) {
        var b = V.cols[c][r];
        if (!b) return;
        blockPos(c, b.y, V.angle, vA);
        spawnDebris(vA.x, vA.y, vA.z, colourOf(b.t), cells.length > 14 ? 3 : 5, power);
        if (nDust < 7 && (nDust === 0 || Math.random() < 0.4)) { spawnDust(vA.x, vA.y, vA.z, 1, 0.8); nDust++; }
        V.cols[c].splice(r, 1);
      });
    });
  }
  function crumbleAll(power) {
    for (var c = 0; c < COLS; c++) {
      var col = V.cols[c];
      for (var r = 0; r < col.length; r++) {
        blockPos(c, col[r].y, V.angle, vA);
        spawnDebris(vA.x, vA.y, vA.z, colourOf(col[r].t), 3, power);
        if (r % 3 === 0) spawnDust(vA.x, vA.y, vA.z, 1, 1.3);
      }
      V.cols[c] = [];
    }
  }
  // A safety net: if the picture ever disagrees with the world, the world wins.
  function resyncVis() {
    var w = world(); if (!w) return;
    for (var c = 0; c < COLS; c++) {
      var h = colHeight(w.grid, c), col = V.cols[c];
      var ok = col.length === h;
      for (var r = 0; ok && r < h; r++) if (col[r].t !== w.grid[c * ML + r]) ok = false;
      if (!ok) {
        var arr = [];
        for (var r2 = 0; r2 < h; r2++) arr.push({ t: w.grid[c * ML + r2], y: col[r2] ? col[r2].y : BH * (r2 + 0.5), vy: 0, sq: 1 });
        V.cols[c] = arr;
      }
    }
  }

  function later(sec, fn) { V.timers.push({ t: sec, fn: fn }); }
  // A timer that belongs to the tower in play: dropped if the next tower has arrived.
  function laterTower(sec, fn) { var k = sim.tower; later(sec, function () { if (sim && sim.tower === k && sim.phase === 'trans') fn(); }); }

  // ------------------------------------------------------------------ picking: which block is under a tap
  var raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  var pickMap = { colour: [], steel: [], bomb: [] };   // instance index -> c * ML + r, refreshed every frame
  function pickAt(x, y) {
    ndc.set(x / VW * 2 - 1, -(y / VH) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects([mColour, mSteel, mBomb], false);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i], m = h.object === mColour ? pickMap.colour : h.object === mSteel ? pickMap.steel : pickMap.bomb;
      var cell = m[h.instanceId];
      if (cell != null) return cell;
    }
    return -1;
  }
  // A fingertip is not a pixel: try the tap point, then a small ring around it.
  function pickCell(x, y) {
    var cell = pickAt(x, y);
    if (cell >= 0) return cell;
    var rad = 14 * Math.max(UI, 0.8);
    for (var k = 0; k < 8; k++) {
      var a = k * TAU / 8;
      cell = pickAt(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
      if (cell >= 0) return cell;
    }
    return -1;
  }

  // ------------------------------------------------------------------ HUD and banners
  var hud = $('hud'), hScore = $('hScore'), hPend = $('hPend'), hClock = $('hClock'), hTower = $('hTower'), hBalls = $('hBalls');
  var shownScore = 0, shownPend = 0, lastSec = -1, lastBalls = -1;
  var bannerEl = $('banner'), bannerTimer = null;
  function banner(text, cls, sub, subCls, hold) {
    clearTimeout(bannerTimer);
    bannerEl.innerHTML = '';
    var b = document.createElement('div');
    b.className = 'ban ' + (cls || '');
    b.textContent = text;
    bannerEl.appendChild(b);
    if (sub) { var s = document.createElement('span'); s.className = 'sub ' + (subCls || ''); s.textContent = sub; bannerEl.appendChild(s); }
    bannerTimer = setTimeout(function () {
      b.classList.add('out');
      var sEl = bannerEl.querySelector('.sub'); if (sEl) sEl.style.opacity = '0';
      bannerTimer = setTimeout(function () { bannerEl.innerHTML = ''; }, 300);
    }, hold || 1100);
  }
  function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); setTimeout(function () { el.classList.remove('bump'); }, 160); }

  function updateHud(dt) {
    if (!sim) return;
    shownScore += (sim.score - shownScore) * Math.min(1, dt * 6);
    if (Math.abs(sim.score - shownScore) < 1) shownScore = sim.score;
    hScore.textContent = fmt(shownScore);
    if (sim.pending !== shownPend) {
      if (sim.pending > shownPend) bump(hPend);
      shownPend = sim.pending;
      hPend.textContent = '+' + fmt(shownPend) + ' IN TOWER';
      hPend.classList.toggle('is-empty', shownPend === 0);
    }
    var left = Math.max(0, RUN_STEPS - sim.step);
    var sec = Math.ceil(left / STEP_HZ);
    if (sec !== lastSec) {
      if (lastSec !== -1 && sec <= 10 && sec > 0 && mode === 'play') Snd.tick(sec <= 3);
      lastSec = sec;
      var m = Math.floor(sec / 60), s2 = sec % 60;
      hClock.textContent = (m < 10 ? '0' : '') + m + ':' + (s2 < 10 ? '0' : '') + s2;
      hClock.classList.toggle('hot', sec <= 10 && mode === 'play');
    }
    if (sim.balls !== lastBalls) {
      hBalls.textContent = sim.balls;
      hBalls.classList.toggle('low', sim.balls <= 3);
      if (lastBalls !== -1) bump(hBalls);
      lastBalls = sim.balls;
    }
    hTower.textContent = 'TOWER ' + (sim.tower + 1);
  }

  // ------------------------------------------------------------------ a ball lands: the shared hit effects
  // Used by the run and by the practice. `hit` = { c, r, type, cells, pts, colour }.
  function hitFx(hit) {
    var face = blockFace(hit.c, hit.r, new THREE.Vector3());
    var out = new THREE.Vector3(face.x, 0, face.z).normalize();
    var ab = { p: face.clone().addScaledVector(out, 0.3), v: new THREE.Vector3(), life: 0 };
    var sp = toScreen(face.x, face.y, face.z);
    if (hit.type === 'steel') {
      ab.v.set(out.x * 7 + rand(-2, 2), 6, out.z * 7);
      Snd.clang();
      V.shake = Math.max(V.shake, 0.18);
      spawnDebris(face.x, face.y, face.z, '#fff3a0', 6, 0.6);
      var b0 = V.cols[hit.c] && V.cols[hit.c][hit.r]; if (b0) b0.sq = 0.8;
      popup('CLANG', sp.x, sp.y, '#dfe6ee', 22, 'steel wastes a ball');
    } else if (hit.type === 'miss') {
      ab.v.set(-out.x * 10, 1, -out.z * 10); Snd.whoosh();
    } else {
      var n = hit.cells.length, bomb = hit.type === 'bomb';
      ab.v.set(out.x * 5 + rand(-2, 2), 5, out.z * 5);
      breakVis(hit.cells, bomb ? 1.6 : 0.8 + Math.min(0.7, n / 20));
      if (bomb) { Snd.boom(); V.shake = Math.max(V.shake, 0.9); spawnDust(face.x, face.y, face.z, 10, 2.2); }
      else Snd.crunch(n);
      V.shake = Math.max(V.shake, Math.min(0.75, 0.12 + n * 0.035));
      var word = bomb ? 'BOOM' : n >= 16 ? 'MEGA!' : n >= 10 ? 'HUGE!' : n >= 6 ? 'NICE!' : null;
      popup('+' + fmt(hit.pts), sp.x, sp.y, bomb ? '#ffcc00' : PAL[hit.colour], 22 + Math.min(10, n * 0.6), word);
    }
    V.afterBall = ab;
    V.ball = null;
  }

  // ------------------------------------------------------------------ events from the sim
  var NEWS = { 1: 'NEW: a fourth colour', 2: 'NEW: the spin speeds up and slows', 3: 'NEW: steel never breaks',
    4: 'NEW: a fifth colour', 5: 'NEW: a bomb clears its ring', 6: 'NEW: the spin can reverse' };
  var resyncSoon = 0, resyncEvery = 1;

  function handleEvent(ev) {
    if (ev.type === 'over') { if (ev.prev) handleEvent(ev.prev); return; }
    if (ev.type === 'tower') {
      buildVis(sim.grid, true);
      V.prevAngle = V.angle = sim.angle;
      var n = NEWS[sim.tower];
      banner('TOWER ' + (sim.tower + 1), '', n || (sim.balls + ' balls'), '', 1400);
      Snd.blip(520); later(0.12, function () { Snd.blip(780); });
      return;
    }
    hitFx(ev);
    if (ev.type === 'break' || ev.type === 'bomb') resyncSoon = 0.9;
    if (ev.cleared) smashed(ev);
    else if (ev.stands) stands(ev);
  }

  function smashed(ev) {
    laterTower(0.25, function () {
      crumbleAll(1.3);
      V.capFly = { vy: 11, vx: rand(-2, 2), spin: rand(-6, 6), rot: 0 };
      V.shake = Math.max(V.shake, 0.8);
      Snd.boom(); Snd.chord();
      banner('SMASHED!', 'big', '+' + fmt(ev.banked) + ' banked  +' + fmt(ev.bonus) + ' bonus', '', 1500);
      burstConfetti(120, VW / 2, VH * 0.3, 1);
    });
  }
  function stands(ev) {
    later(0.35, function () {
      Snd.lose();
      banner('OUT OF BALLS', 'grey', ev.lost ? '-' + fmt(ev.lost) + ' lost' : 'the tower stands', 'red', 1600);
    });
    laterTower(2.2, function () {
      Snd.rumble(); crumbleAll(0.55);
      V.capFly = { vy: 2, vx: 0, spin: 0.5, rot: 0, sink: true };
    });
  }

  // ------------------------------------------------------------------ input
  var mode = 'menu', acc = 0, lastT = null, idleSince = 0;
  var autoPlay = /[?&]auto=1/.test(QS);
  var perfOn = /[?&]perf=1/.test(QS);
  var qaSpeed = +((/[?&]speed=(\d+)/.exec(QS) || [])[1] || 1);   // QA only: run the clock faster
  var perf = { n: 0, sum: 0, max: 0 };

  function seedForRun() {
    var m = /[?&]seed=(\d+)/.exec(QS);
    return m ? (+m[1] >>> 0) : ((Math.random() * 4294967296) >>> 0);
  }

  // Fire at block (c, r) of the run. Returns true if the sim took it.
  function fireAt(c, r) {
    if (!fire(sim, c, r)) return false;
    Snd.thump();
    idleSince = sim.step;
    V.ball = { from: launchPoint(), c: c, r: r, fireStep: sim.step, cells: sim.grid[c * ML + r] === STEEL ? [] : hitCells(sim.grid, c, r) };
    return true;
  }
  function launchPoint() { return new THREE.Vector3(rand(-0.4, 0.4), GROUND_Y + 0.6, camera.position.z * 0.55); }

  function onPress(e) {
    Snd.init();
    if (!e || e.clientX == null) return;            // keys do nothing: you must pick a block
    var cell = pickCell(e.clientX, e.clientY);
    if (cell < 0) return;
    var c = (cell / ML) | 0, r = cell - c * ML;
    if (mode === 'prac') { pracTap(c, r); return; }
    if (mode !== 'play' || !sim || sim.phase !== 'play') return;
    if (!fireAt(c, r) && sim.ball) { /* one ball at a time: the tap is ignored */ }
  }

  // ------------------------------------------------------------------ hands-on practice (outside the run)
  // Its own little tower and real seconds. Never touches `sim`, scores nothing.
  // 1 the tower stops with a yellow chunk in front: "Tap a block". 2 it turns to
  // show a big red chunk and drifts slowly: "Tap the biggest chunk". 3 what is
  // left crumbles: "Clear a tower to bank its points". Then YOU'RE READY.
  var PRAC_COLS = [[3, 2, 2, 2, 4], [4, 3, 2, 1, 3], [1, 4, 3, 3, 2], [2, 1, 1, 4, 2],
    [1, 1, 1, 1, 3], [3, 1, 1, 2, 4], [4, 2, 4, 3, 1], [1, 3, 2, 4, 2]];
  var pCap = $('pcap'), pHand = $('phand'), pSkip = $('pskip'), pReady = $('pready');
  function tutSeen() { return +(lsGet('minar-tod-tut') || 0); }

  function startPractice() {
    var g = new Array(COLS * ML);
    for (var i = 0; i < g.length; i++) g[i] = EMPTY;
    for (var c = 0; c < COLS; c++) for (var r = 0; r < PRAC_COLS[c].length; r++) g[c * ML + r] = PRAC_COLS[c][r];
    prac = { grid: g, angle: 6000, phase: 'intro', pt: 0, glide: null, spin: 0, target: null, ball: null };
    lsSet('minar-tod-tut', String(tutSeen() + 1));
    V.prevAngle = V.angle = prac.angle;
    buildVis(g, true);
    debris.length = 0; dust.length = 0; V.ball = null; V.afterBall = null; V.timers = [];
    mode = 'prac';
    hide(menu); hide(over); hud.classList.add('is-hidden');
    pSkip.hidden = false;
    pracGlide('intro', 0, 1.2);
  }
  function pracCaption(text) {
    pCap.textContent = text || '';
    pCap.classList.toggle('on', !!text);
  }
  function pracGlide(phase, to, dur) {
    var d = ((to - prac.angle + ANG / 2) % ANG + ANG) % ANG - ANG / 2;
    prac.phase = phase; prac.pt = 0; prac.target = null; prac.spin = 0;
    prac.glide = { from: prac.angle, d: d, dur: dur };
  }
  function pracTap(c, r) {
    var p = prac;
    if (!p || p.ball || (p.phase !== 'tap1' && p.phase !== 'tap2')) return;
    if (!colVisible(Math.round(p.angle) & (ANG - 1), c)) return;
    Snd.thump();
    var cells = p.grid[c * ML + r] === STEEL ? [] : hitCells(p.grid, c, r);
    p.ball = { c: c, r: r, t: 0 };
    V.ball = { from: launchPoint(), c: c, r: r, cells: cells };
    p.target = null;
    pracCaption('');
  }
  function pracLand() {
    var p = prac, b = p.ball;
    p.ball = null;
    var v = p.grid[b.c * ML + b.r];
    var cells = hitCells(p.grid, b.c, b.r);
    hitFx({ c: b.c, r: b.r, type: 'break', cells: cells, pts: groupPoints(cells.length), colour: v });
    p.grid = removeAndSettle(p.grid, cells);
    if (p.phase === 'tap1') {
      p.phase = 'after1'; p.pt = 0;
      pracCaption(cells.length > 1 ? 'Same colours touching it break too!' : 'Only that block broke. Aim for a chunk!');
    } else {
      p.phase = 'after2'; p.pt = 0;
      pracCaption(cells.length >= 6 ? 'Big chunk, far more points!' : 'Bigger chunks score far more points.');
    }
  }
  function pracUpdate(dt) {
    var p = prac;
    if (!p) return;
    p.pt += dt;
    if (p.glide) {
      var g = p.glide, k = Math.min(1, p.pt / g.dur), e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
      p.angle = g.from + g.d * e;
      if (k >= 1) {
        p.glide = null; p.pt = 0;
        if (p.phase === 'intro') { p.phase = 'tap1'; p.target = { c: 0, r: 2 }; pracCaption('Tap a block to hit it'); }
        else if (p.phase === 'turn') { p.phase = 'tap2'; p.spin = 1500; p.target = { c: 4, r: 1 }; pracCaption('The tower turns. Tap the biggest chunk!'); }
      }
    } else if (p.spin) p.angle += p.spin * dt;
    p.angle = ((p.angle % ANG) + ANG) % ANG;
    if (p.ball) { p.ball.t += dt; if (p.ball.t >= FLIGHT / STEP_HZ) pracLand(); return; }
    if (p.phase === 'after1' && p.pt > 1.3) pracGlide('turn', ANG - 4 * COL_ANG - 3000, 1.1);
    else if (p.phase === 'after2' && p.pt > 1.3) {
      p.phase = 'smash'; p.pt = 0;
      pracCaption('Clear a whole tower to bank its points');
      later(0.5, function () {
        if (mode !== 'prac') return;
        crumbleAll(1.2); Snd.boom(); Snd.chord(); V.shake = 0.6;
        V.capFly = { vy: 11, vx: rand(-2, 2), spin: rand(-6, 6), rot: 0 };
        for (var i = 0; i < prac.grid.length; i++) prac.grid[i] = EMPTY;
        banner('SMASHED!', 'big', '', '', 1100);
        burstConfetti(90, VW / 2, VH * 0.3, 0.9);
      });
    } else if (p.phase === 'smash' && p.pt > 2.4) pracReady();
  }
  function pracReady() {
    if (!prac || prac.phase === 'ready') return;
    prac.phase = 'ready'; prac.target = null; prac.ball = null;
    pracCaption(''); pSkip.hidden = true;
    show(pReady);
    Snd.blip(880);
  }
  function leavePractice() {
    prac = null; pSkip.hidden = true; pracCaption('');
    pHand.classList.remove('on');
    hide(pReady);
  }
  pSkip.addEventListener('click', function () { Snd.init(); Snd.blip(600); pracReady(); });
  $('pplayBtn').addEventListener('click', function () { leavePractice(); startGame(); });

  // The pointing ring over the block the practice wants tapped.
  function placeHand() {
    var t = prac && prac.target;
    var on = !!(t && mode === 'prac' && V.cols[t.c] && V.cols[t.c][t.r]);
    pHand.classList.toggle('on', on);
    if (!on) return;
    blockFace(t.c, t.r, vB);
    var sp = toScreen(vB.x, vB.y, vB.z);
    pHand.style.transform = 'translate(' + sp.x + 'px,' + sp.y + 'px) scale(' + UI + ')';
  }

  // ------------------------------------------------------------------ the loop
  function frameLoop(now) {
    requestAnimationFrame(frameLoop);
    var dt = lastT == null ? STEP : Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    var t0 = performance.now();
    if (mode === 'play') {
      acc += dt * qaSpeed;
      var n = 0;
      while (acc >= STEP && n < 4 * qaSpeed) {
        V.prevAngle = sim.angle;
        var ev = stepSim(sim);
        n++; acc -= STEP;
        if (ev) handleEvent(ev);
        if (sim.phase === 'over') { endRun(); break; }
        if (autoPlay) autoPilot();
      }
      if (n >= 4 * qaSpeed) acc = 0;
    }
    var alpha = mode === 'play' ? acc / STEP : 1;
    if (mode === 'prac' && prac) {
      pracUpdate(dt);
      V.angle = prac.angle;
    } else if (sim && (mode === 'play' || mode === 'ready' || mode === 'timeup')) {
      var d = ((sim.angle - V.prevAngle + ANG / 2) & (ANG - 1)) - ANG / 2;
      V.angle = V.prevAngle + d * alpha;
    } else {
      V.angle += dt * 900;
    }
    update(dt, alpha);
    renderer.render(scene, camera);
    placeHand();
    drawFx(dt);
    if (perfOn || window.__mtPerf) {
      var ms = performance.now() - t0;
      perf.n++; perf.sum += ms; perf.max = Math.max(perf.max, ms);
    }
  }

  var dummy = new THREE.Object3D(), tmpC = new THREE.Color(), white = new THREE.Color('#ffffff');
  var colCache = {};
  function colObj(hex) { return colCache[hex] || (colCache[hex] = new THREE.Color(hex)); }
  var timeAcc = 0;

  function update(dt, alpha) {
    timeAcc += dt;
    for (var ti2 = V.timers.length - 1; ti2 >= 0; ti2--) {
      var tm = V.timers[ti2]; tm.t -= dt;
      if (tm.t <= 0) { V.timers.splice(ti2, 1); tm.fn(); }
    }
    if (resyncSoon > 0) { resyncSoon -= dt; if (resyncSoon <= 0 && sim && mode === 'play') resyncVis(); }
    resyncEvery -= dt;
    if (resyncEvery <= 0) { resyncEvery = 1; if (sim && sim.phase === 'play' && mode === 'play') resyncVis(); }

    var w = world();
    var th = topHeight(w.grid);
    // Camera: framed on the tower in world units, eased as it shrinks.
    var menuView = mode === 'menu';
    var targetH = menuView ? 30 : mode === 'prac' ? 9 : Math.max(th, 6);
    V.camH += (targetH - V.camH) * Math.min(1, dt * 2.2);
    var yTop = V.camH * BH + 2.6, yBot = GROUND_Y - 0.2;
    var half = (yTop - yBot) / 2 / 0.8;
    var cy = (yTop + yBot) / 2 - 0.2;
    if (menuView) cy -= half * 0.12;
    var dist = half / Math.tan(BASE_FOV * Math.PI / 360) + R;
    V.shake *= Math.pow(0.004, dt);
    var sx = V.shake ? (Math.random() - 0.5) * V.shake * 0.6 : 0, sy = V.shake ? (Math.random() - 0.5) * V.shake * 0.6 : 0;
    camera.position.set(sx, cy + dist * 0.2 + sy, dist);
    camera.lookAt(sx * 0.5, cy + sy * 0.5, 0);

    // Blocks. The chunk a ball is flying at glows; so does the practice's target chunk.
    var hlSet = null, pulse = 0.5 + 0.5 * Math.sin(timeAcc * 9);
    var hlCells = V.ball ? V.ball.cells : (prac && prac.target && mode === 'prac') ? hitCells(prac.grid, prac.target.c, prac.target.r) : null;
    if (hlCells) { hlSet = {}; for (var hi = 0; hi < hlCells.length; hi++) hlSet[hlCells[hi]] = 1; }
    var nC = 0, nS = 0, nB = 0;
    var pmC = pickMap.colour, pmS = pickMap.steel, pmB = pickMap.bomb;
    var canPick = mode === 'play' || mode === 'prac';
    for (var c = 0; c < COLS; c++) {
      var col = V.cols[c];
      if (!col) continue;
      var thc = colTheta(c, V.angle), sn = Math.sin(thc), cs = Math.cos(thc);
      var tappable = canPick && colVisible(Math.round(V.angle) & (ANG - 1), c);
      for (var r = 0; r < col.length; r++) {
        var b = col[r], ty = BH * (r + 0.5);
        b.vy -= 40 * dt; b.y += b.vy * dt;
        if (b.y <= ty) {
          if (b.vy < -4) { b.sq = 1 - Math.min(0.22, -b.vy * 0.012); if (mode !== 'menu') Snd.knock(-b.vy); }
          b.y = ty; b.vy = b.vy < -4 ? -b.vy * 0.2 : 0;
        }
        b.sq += (1 - b.sq) * Math.min(1, dt * 12);
        dummy.position.set(sn * R, b.y, cs * R);
        dummy.rotation.set(0, thc, 0);
        dummy.scale.set(1 + (1 - b.sq) * 0.5, b.sq, 1 + (1 - b.sq) * 0.5);
        dummy.updateMatrix();
        var cell = tappable ? c * ML + r : null;
        if (b.t === STEEL) { pmS[nS] = cell; mSteel.setMatrixAt(nS++, dummy.matrix); }
        else if (b.t === BOMB) { pmB[nB] = cell; mBomb.setMatrixAt(nB++, dummy.matrix); }
        else {
          tmpC.copy(colObj(PAL[b.t]));
          if (hlSet && hlSet[c * ML + r]) tmpC.lerp(white, 0.2 + 0.25 * pulse);
          mColour.setColorAt(nC, tmpC);
          pmC[nC] = cell;
          mColour.setMatrixAt(nC++, dummy.matrix);
        }
      }
    }
    mColour.count = nC; mSteel.count = nS; mBomb.count = nB;
    mColour.instanceMatrix.needsUpdate = true; if (mColour.instanceColor) mColour.instanceColor.needsUpdate = true;
    mSteel.instanceMatrix.needsUpdate = true; mBomb.instanceMatrix.needsUpdate = true;
    // The raycaster tests bounds first; instances move, so refresh them.
    mColour.computeBoundingSphere(); mSteel.computeBoundingSphere(); mBomb.computeBoundingSphere();
    bombMat.emissiveIntensity = 0.12 + 0.3 * pulse;
    topSlab.rotation.y = V.angle / ANG * TAU;

    // Cap: rides the tallest column with a spring, or flies off.
    var capTarget = 0;
    for (var cc = 0; cc < COLS; cc++) if (V.cols[cc]) capTarget = Math.max(capTarget, V.cols[cc].length ? V.cols[cc][V.cols[cc].length - 1].y + BH / 2 : 0);
    if (V.capFly) {
      var f = V.capFly;
      if (f.sink) { V.capY -= dt * 2.5; cap.scale.setScalar(Math.max(0.01, cap.scale.x - dt * 0.5)); }
      else { f.vy -= 22 * dt; V.capY += f.vy * dt; cap.position.x += f.vx * dt; f.rot += f.spin * dt; cap.rotation.z = f.rot * 0.3; }
      cap.visible = V.capY > GROUND_Y - 4;
    } else {
      cap.visible = true; cap.position.x = 0; cap.rotation.z = 0; cap.scale.setScalar(CAP_S);
      V.capVY -= 40 * dt; V.capY += V.capVY * dt;
      if (V.capY <= capTarget) { if (V.capVY < -5) { V.capVY = -V.capVY * 0.25; } else V.capVY = 0; V.capY = capTarget; }
    }
    cap.position.y = V.capY;
    cap.rotation.y = V.angle / ANG * TAU;

    // Ball in flight: it homes on the block it was fired at.
    if (V.ball) {
      var u;
      if (mode === 'prac' && prac && prac.ball) u = clamp(prac.ball.t / (FLIGHT / STEP_HZ), 0, 1);
      else if (sim && sim.ball) u = clamp((sim.step + alpha - V.ball.fireStep) / FLIGHT, 0, 1);
      else u = 1;
      blockFace(V.ball.c, V.ball.r, vA);
      var f0 = V.ball.from;
      ballMesh.visible = true;
      ballMesh.position.set(f0.x + (vA.x - f0.x) * u, f0.y + (vA.y - f0.y) * u + Math.sin(u * Math.PI) * 1.6, f0.z + (vA.z - f0.z) * u);
      ballMesh.rotation.x -= dt * 20;
    } else if (V.afterBall) {
      var ab = V.afterBall;
      ab.life += dt; ab.v.y -= 22 * dt; ab.p.addScaledVector(ab.v, dt);
      if (ab.p.y < GROUND_Y + 0.36) { ab.p.y = GROUND_Y + 0.36; ab.v.y = Math.abs(ab.v.y) * 0.45; ab.v.x *= 0.8; ab.v.z *= 0.8; }
      ballMesh.visible = ab.life < 1.6;
      ballMesh.position.copy(ab.p);
      if (ab.life > 1.6) V.afterBall = null;
    } else ballMesh.visible = false;

    // Debris and dust.
    var nd = 0;
    for (var i = debris.length - 1; i >= 0; i--) {
      var p = debris[i];
      p.life += dt;
      if (p.life > p.max) { debris.splice(i, 1); continue; }
      p.v.y -= 24 * dt;
      p.p.addScaledVector(p.v, dt);
      var floor = (p.p.x * p.p.x + p.p.z * p.p.z < 2.2 * 2.2) ? 0.15 : GROUND_Y + 0.15;
      if (p.p.y < floor && p.v.y < 0) { p.p.y = floor; p.v.y *= -0.38; p.v.x *= 0.7; p.v.z *= 0.7; p.w.multiplyScalar(0.6); }
      p.r.x += p.w.x * dt; p.r.y += p.w.y * dt; p.r.z += p.w.z * dt;
    }
    for (var j = 0; j < debris.length; j++) {
      var q = debris[j], sc = q.s * Math.min(1, (q.max - q.life) / 0.35);
      dummy.position.copy(q.p); dummy.rotation.copy(q.r); dummy.scale.setScalar(sc); dummy.updateMatrix();
      mDeb.setMatrixAt(nd, dummy.matrix); mDeb.setColorAt(nd, q.c); nd++;
    }
    mDeb.count = nd; mDeb.instanceMatrix.needsUpdate = true; if (mDeb.instanceColor) mDeb.instanceColor.needsUpdate = true;
    var nu = 0;
    for (var di = dust.length - 1; di >= 0; di--) {
      var dd = dust[di]; dd.life += dt;
      if (dd.life > dd.max) { dust.splice(di, 1); continue; }
      dd.p.addScaledVector(dd.v, dt); dd.v.multiplyScalar(Math.pow(0.3, dt));
    }
    for (var dj = 0; dj < dust.length; dj++) {
      var e = dust[dj], kk = e.life / e.max;
      var ss = (e.s0 + (e.s1 - e.s0) * Math.sqrt(kk)) * (kk > 0.6 ? (1 - kk) / 0.4 : 1);
      dummy.position.copy(e.p); dummy.rotation.set(e.life, e.life * 0.7, 0); dummy.scale.setScalar(Math.max(0.001, ss)); dummy.updateMatrix();
      mDust.setMatrixAt(nu++, dummy.matrix);
    }
    mDust.count = nu; mDust.instanceMatrix.needsUpdate = true;

    updateHud(dt);
  }

  // QA only: a pilot that taps the biggest visible chunk after a short think.
  function autoPilot() {
    if (!sim || sim.phase !== 'play' || sim.ball || sim.balls <= 0) return;
    if (sim.step - idleSince < 30) return;
    var best = null;
    for (var c = 0; c < COLS; c++) {
      if (!colVisible(sim.angle, c)) continue;
      for (var r = 0; r < colHeight(sim.grid, c); r++) {
        if (sim.grid[c * ML + r] === STEEL) continue;
        var n = hitCells(sim.grid, c, r).length;
        if (!best || n > best.n) best = { c: c, r: r, n: n };
      }
    }
    if (best) fireAt(best.c, best.r);
  }

  // ------------------------------------------------------------------ screens
  var menu = $('menu'), over = $('over');
  var veil = $('veil');
  function syncVeil() { veil.classList.toggle('on', !over.classList.contains('is-hidden') || !pReady.classList.contains('is-hidden')); }
  function show(el) { el.classList.remove('is-gone'); void el.offsetWidth; el.classList.remove('is-hidden'); syncVeil(); }
  function hide(el) { el.classList.add('is-hidden'); syncVeil(); setTimeout(function () { if (el.classList.contains('is-hidden')) el.classList.add('is-gone'); }, 320); }
  function best() { return +(lsGet('minar-tod-best') || 0); }
  function refreshMenuBest() { var b = best(); $('menuBest').textContent = b ? 'BEST ' + fmt(b) : ''; }

  function toMenu() {
    mode = 'menu'; sim = null; leavePractice();
    menuSim = initSim((Math.random() * 4294967296) >>> 0);
    V.camH = 30;
    buildVis(menuSim.grid, true);
    hud.classList.add('is-hidden');
    refreshMenuBest();
    show(menu); hide(over);
  }

  function startGame() {
    Snd.init(); Snd.blip(660);
    hide(menu); hide(over);
    sim = initSim(seedForRun());
    var qaTower = /[?&]tower=(\d+)/.exec(QS);   // QA only: start on a later tower
    if (qaTower) startTower(sim, +qaTower[1]);
    window.__mtSeed = sim.seed;
    V.prevAngle = V.angle = sim.angle;
    buildVis(sim.grid, true);
    debris.length = 0; dust.length = 0; V.ball = null; V.afterBall = null; V.timers = [];
    shownScore = 0; shownPend = -1; lastSec = -1; lastBalls = -1;
    hud.classList.remove('is-hidden');
    mode = 'ready';
    later(0.35, function () { banner('READY', '', sim.balls + ' balls for this tower', '', 750); Snd.blip(520); });
    later(1.25, function () { banner('GO!', 'big', '', '', 500); Snd.blip(880); mode = 'play'; acc = 0; idleSince = 0; });
  }

  function endRun() {
    mode = 'timeup';
    hClock.classList.remove('hot');
    V.ball = null;
    Snd.gong();
    banner('TIME!', 'big', '', '', 1300);
    later(1.7, showOver);
  }

  function showOver() {
    mode = 'over';
    var score = sim.score, prev = best(), isNew = score > prev;
    if (isNew) lsSet('minar-tod-best', String(score));
    var stats = [['stTowers', sim.cleared], ['stBlocks', sim.broken], ['stChunk', sim.best], ['stAcc', sim.fired ? Math.round(100 * sim.hits / sim.fired) + '%' : '0%']];
    var ovScore = $('ovScore'), ovBest = $('ovBest');
    ovScore.textContent = '0';
    ovBest.className = 'ov-best'; ovBest.textContent = 'BEST ' + fmt(Math.max(prev, score));
    ovBest.style.visibility = 'hidden';
    var statEls = over.querySelectorAll('.stat');
    for (var i = 0; i < statEls.length; i++) statEls[i].classList.remove('in');
    stats.forEach(function (s) { $(s[0]).textContent = s[1]; });
    show(over);
    hud.classList.add('is-hidden');
    var t0 = performance.now(), dur = 1300, lastTick = 0;
    (function count() {
      var k = Math.min(1, (performance.now() - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      ovScore.textContent = fmt(score * e);
      var tk = Math.floor(k * 18); if (tk !== lastTick && k < 1) { lastTick = tk; Snd.count(tk); }
      if (k < 1) requestAnimationFrame(count);
      else {
        for (var j = 0; j < statEls.length; j++) (function (el, d) { setTimeout(function () { el.classList.add('in'); Snd.blip(500 + d * 60); }, d * 110); })(statEls[j], j);
        setTimeout(function () {
          ovBest.style.visibility = 'visible';
          if (isNew && score > 0) { ovBest.className = 'ov-best new'; ovBest.textContent = 'NEW BEST!'; Snd.chord(); burstConfetti(160, VW / 2, VH * 0.3, 1.1); }
        }, 520);
      }
    })();
  }

  // The practice shows on the first two launches, and any time from HOW TO PLAY.
  var noTut = /[?&]tut=0/.test(QS);
  $('playBtn').addEventListener('click', function () {
    Snd.init(); Snd.blip(660);
    if (!noTut && tutSeen() < 2) { startPractice(); return; }
    startGame();
  });
  $('howBtn').addEventListener('click', function () { Snd.init(); Snd.blip(600); startPractice(); });
  $('againBtn').addEventListener('click', function () { startGame(); });
  $('homeBtn').addEventListener('click', function () { Snd.init(); Snd.blip(600); toMenu(); });
  var muteBtn = $('muteBtn');
  muteBtn.classList.toggle('off', Snd.isMuted());
  muteBtn.addEventListener('click', function () { Snd.init(); Snd.setMuted(!Snd.isMuted()); muteBtn.classList.toggle('off', Snd.isMuted()); if (!Snd.isMuted()) Snd.blip(700); });

  function isButton(e) { var t = e && e.target; return !!(t && t.closest && t.closest('button')); }
  if (window.KJPress) KJPress.bind(onPress, { ignore: function (e) { return isButton(e) || (mode !== 'play' && mode !== 'prac'); } });
  else canvas.addEventListener('pointerdown', onPress);
  document.addEventListener('pointerdown', function () { Snd.init(); }, { passive: true });
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });

  // ------------------------------------------------------------------ 2D art: the logo
  function block2d(g, x, y, s, col) {
    var gr = g.createLinearGradient(0, y, 0, y + s);
    gr.addColorStop(0, shade(col, 0.25)); gr.addColorStop(1, shade(col, -0.18));
    g.fillStyle = gr; rr(g, x, y, s, s, s * 0.2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; rr(g, x + s * 0.12, y + s * 0.1, s * 0.76, s * 0.18, s * 0.09); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.12)'; rr(g, x + s * 0.1, y + s * 0.78, s * 0.8, s * 0.12, s * 0.06); g.fill();
  }
  function shade(hex, k) {
    var c = new THREE.Color(hex); var hsl = {}; c.getHSL(hsl);
    c.setHSL(hsl.h, hsl.s, clamp(hsl.l + k * 0.5, 0, 1)); return '#' + c.getHexString();
  }
  function drawLogo() {
    var c = $('logo'), g = c.getContext('2d'), w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    var cols = ['#ef3b4f', '#ffb400', '#22b573', '#3d6bff', '#a64bf0', '#ff7a1a'];
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 3; g.beginPath(); g.moveTo(20, 18); g.quadraticCurveTo(w / 2, 52, w - 20, 18); g.stroke();
    for (var i = 0; i < 13; i++) {
      var t = (i + 0.5) / 13, x = 20 + (w - 40) * t, y = 18 + 68 * t * (1 - t);
      g.fillStyle = cols[i % cols.length]; g.beginPath(); g.moveTo(x - 20, y); g.lineTo(x + 20, y); g.lineTo(x, y + 34); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.arc(x, y + 10, 4, 0, TAU); g.fill();
    }
    function word(s, y, size, rot) {
      g.save(); g.translate(w / 2, y); g.rotate(rot);
      g.font = size + 'px "Titan One", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.fillStyle = '#5a1530'; g.fillText(s, 0, size * 0.09);
      g.lineWidth = size * 0.2; g.strokeStyle = '#5a1530'; g.strokeText(s, 0, 0);
      g.lineWidth = size * 0.08; g.strokeStyle = '#ffffff'; g.strokeText(s, 0, 0);
      var gr = g.createLinearGradient(0, -size / 2, 0, size / 2); gr.addColorStop(0, '#fff2a0'); gr.addColorStop(0.55, '#ffc21a'); gr.addColorStop(1, '#ff8a1a');
      g.fillStyle = gr; g.fillText(s, 0, 0);
      g.restore();
    }
    word('MINAR', 150, 132, -0.03);
    word('TOD!', 282, 150, 0.03);
    block2d(g, 40, 300, 50, '#3d6bff'); block2d(g, 40, 248, 50, '#22b573');
    g.save(); g.translate(80, 214); g.rotate(-0.5); block2d(g, -22, -22, 44, '#ef3b4f'); g.restore();
    block2d(g, w - 92, 300, 50, '#a64bf0');
    g.save(); g.translate(w - 58, 240); g.rotate(0.45); block2d(g, -22, -22, 44, '#ffb400'); g.restore();
  }
  var fontReady = (document.fonts && document.fonts.load) ? document.fonts.load('60px "Titan One"') : Promise.resolve();
  fontReady.then(drawLogo, drawLogo);

  // QA hooks (phase 1 only): scripted play and frame timing.
  window.__mt = {
    sim: function () { return sim; }, mode: function () { return mode; }, start: startGame, practice: startPractice,
    prac: function () { return prac; }, fireAt: fireAt,
    // Screen point of block (c, r) right now, for scripted taps.
    screenOf: function (c, r) { blockFace(c, r, vB); return toScreen(vB.x, vB.y, vB.z); },
    perf: function () { var r = { frames: perf.n, avgMs: perf.n ? perf.sum / perf.n : 0, maxMs: perf.max }; perf.n = 0; perf.sum = 0; perf.max = 0; return r; },
  };

  toMenu();
  requestAnimationFrame(frameLoop);
})();
