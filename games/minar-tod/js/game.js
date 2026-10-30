// Minar Tod: the 3D view, effects, audio and screens. Everything here READS the
// sim in rules.js and only changes it through the rules' own inputs (fire,
// turn, flick). Math.random and Math.sin are fine here: nothing in this file
// can change a score.
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
  var LAUNCH_Z = R + 6.2;
  var PAL = [null, '#f0364d', '#ffb200', '#1fbf6e', '#3a6dff', '#a54cf2'];
  var NOTE_PAL = ['#ffffff', '#ff8a96', '#ffe08a', '#8af0bb', '#9cb8ff', '#d7a4ff'];
  var TAU = Math.PI * 2;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function $(id) { return document.getElementById(id); }

  // ================================================================== audio
  // Everything is synthesised: modal "marimba" notes for breaking blocks (a
  // pentatonic run that climbs as a chunk pops), FM bells for steel and the
  // fanfare, filtered noise for cracks, booms and the cannon, and one shared
  // convolution reverb so it all sits in the same courtyard.
  var Snd = (function () {
    var ctx = null, master = null, dry = null, wet = null, nbuf = null;
    var muted = lsGet('minar-tod-muted') === '1';
    var last = {};
    var PENT = [0, 2, 4, 7, 9];
    var VOL = 0.5;   // master level: the founder found 0.9 a tad loud
    function note(i) { var o = Math.floor(i / 5), p = PENT[((i % 5) + 5) % 5]; return 293.66 * Math.pow(2, (o * 12 + p) / 12); }

    function init() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.002; comp.release.value = 0.18;
      master = ctx.createGain(); master.gain.value = muted ? 0 : VOL;
      master.connect(comp); comp.connect(ctx.destination);
      dry = ctx.createGain(); dry.connect(master);
      var conv = ctx.createConvolver(); conv.buffer = impulse(2.6, 3.2);
      var damp = ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 5200;
      wet = ctx.createGain(); wet.gain.value = 0.9;
      wet.connect(conv); conv.connect(damp); damp.connect(master);
      nbuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      var d = nbuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    function impulse(sec, decay) {
      var len = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
      for (var ch = 0; ch < 2; ch++) {
        var d = b.getChannelData(ch), lp = 0;
        for (var i = 0; i < len; i++) { lp += ((Math.random() * 2 - 1) - lp) * 0.35; d[i] = lp * Math.pow(1 - i / len, decay) * (i < 90 ? i / 90 : 1); }
      }
      return b;
    }
    function ok() { return ctx && ctx.state !== 'closed'; }
    function route(node, rev) {
      node.connect(dry);
      if (rev) { var s = ctx.createGain(); s.gain.value = rev; node.connect(s); s.connect(wet); }
    }
    function env(g, t, a, peak, dec) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
    }
    function tone(type, f0, f1, t, a, peak, dec, rev) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + a + dec);
      env(g, t, a, peak, dec); o.connect(g); route(g, rev);
      o.start(t); o.stop(t + a + dec + 0.05);
    }
    function noise(t, dur, type, f0, f1, q, peak, a, rev) {
      var s = ctx.createBufferSource(); s.buffer = nbuf;
      var f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q || 0.8;
      f.frequency.setValueAtTime(f0, t);
      if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + (a || 0.004) + dur);
      var g = ctx.createGain(); env(g, t, a || 0.003, peak, dur);
      s.connect(f); f.connect(g); route(g, rev);
      s.start(t, Math.random() * 1.2); s.stop(t + (a || 0.004) + dur + 0.1);
    }
    // FM bell: carrier at f, modulator at f * ratio with a decaying index.
    function bell(f, t, dur, ratio, index, peak, rev) {
      var car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain();
      car.frequency.value = f; mod.frequency.value = f * ratio;
      mg.gain.setValueAtTime(f * index, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur);
      mod.connect(mg); mg.connect(car.frequency);
      env(g, t, 0.004, peak, dur); car.connect(g); route(g, rev);
      car.start(t); mod.start(t); car.stop(t + dur + 0.1); mod.stop(t + dur + 0.1);
    }
    // A wooden bar: fundamental plus the bar's 4x partial, a little click.
    function marimba(f, t, peak, rev) {
      tone('sine', f, 0, t, 0.002, peak, 0.55, rev);
      if (f * 3.93 < 16000) tone('sine', f * 3.93, 0, t, 0.001, peak * 0.32, 0.09, rev);
      if (f * 9.6 < 16000) tone('sine', f * 9.6, 0, t, 0.001, peak * 0.08, 0.03, rev);
      noise(t, 0.012, 'bandpass', Math.min(f * 6, 12000), 0, 2, peak * 0.4);
    }
    function throttle(k, ms) { var n = ctx.currentTime; if (last[k] && n - last[k] < ms / 1000) return false; last[k] = n; return true; }

    return {
      init: init,
      isMuted: function () { return muted; },
      setMuted: function (m) {
        muted = m; lsSet('minar-tod-muted', m ? '1' : '0');
        if (master) master.gain.setTargetAtTime(m ? 0 : VOL, ctx.currentTime, 0.02);
      },
      cannon: function () {
        if (!ok()) return; var t = ctx.currentTime;
        tone('sine', 120, 38, t, 0.003, 0.9, 0.28, 0.12);
        tone('triangle', 70, 40, t, 0.002, 0.35, 0.18);
        noise(t, 0.22, 'lowpass', 1600, 160, 0.7, 0.55, 0.002, 0.2);
        noise(t, 0.03, 'highpass', 3500, 0, 0.7, 0.35);
        noise(t + 0.02, 0.28, 'bandpass', 700, 2600, 1.4, 0.07, 0.05, 0.3);
      },
      // One block of a chunk pops: a climbing note plus a ceramic crack.
      pop: function (i, n) {
        if (!ok()) return; var t = ctx.currentTime;
        var big = Math.min(1, n / 14);
        marimba(note(Math.min(i, 16) + 2), t, 0.24 + 0.08 * big, 0.28);
        if (throttle('crack', 28)) {
          noise(t, 0.045, 'bandpass', rand(1800, 3400), 0, 1.1, 0.32);
          noise(t, 0.09, 'lowpass', 900, 200, 0.7, 0.22);
        }
      },
      // The moment a ball lands on a chunk: weight scaled by its size.
      impact: function (n) {
        if (!ok()) return; var t = ctx.currentTime, big = Math.min(1, n / 16);
        tone('sine', 150, 52, t, 0.002, 0.55 + 0.35 * big, 0.2 + 0.3 * big, 0.15);
        noise(t, 0.16 + 0.3 * big, 'lowpass', 2600, 220, 0.6, 0.35 + 0.2 * big, 0.002, 0.25);
        if (n >= 10) {
          noise(t + 0.04, 0.6, 'highpass', 5000, 9000, 0.5, 0.05 + 0.05 * big, 0.08, 0.5);
          for (var k = 0; k < 4; k++) tone('sine', rand(2200, 3800), 0, t + 0.08 + k * 0.05, 0.002, 0.04, 0.3, 0.6);
        }
      },
      knock: function (v) {
        if (!ok() || !throttle('knock', 45)) return; var t = ctx.currentTime;
        var p = clamp(v / 16, 0.04, 0.22);
        tone('sine', rand(380, 560), 0, t, 0.001, p, 0.06, 0.12);
        noise(t, 0.025, 'bandpass', rand(900, 1500), 0, 2.4, p * 0.8);
      },
      clang: function () {
        if (!ok()) return; var t = ctx.currentTime;
        bell(1180, t, 1.3, 1.41, 3.2, 0.22, 0.5);
        bell(1730, t, 0.9, 2.76, 2, 0.12, 0.5);
        bell(395, t, 0.7, 3.1, 1.2, 0.1, 0.3);
        noise(t, 0.03, 'highpass', 4000, 0, 0.7, 0.35);
      },
      boom: function () {
        if (!ok()) return; var t = ctx.currentTime;
        tone('sine', 80, 24, t, 0.004, 1.0, 1.1, 0.2);
        noise(t, 1.3, 'lowpass', 2400, 70, 0.7, 0.85, 0.004, 0.45);
        for (var i = 0; i < 12; i++) noise(t + rand(0.05, 0.7), 0.03, 'highpass', rand(2000, 5000), 0, 1, rand(0.05, 0.14), 0.002, 0.3);
      },
      fanfare: function () {
        if (!ok()) return; var t = ctx.currentTime;
        var seq = [293.66, 369.99, 440, 587.33, 739.99];
        seq.forEach(function (f, i) { bell(f * 2, t + i * 0.075, 1.1, 3.5, 1.4, 0.13, 0.5); marimba(f, t + i * 0.075, 0.2, 0.4); });
        [293.66, 369.99, 440, 587.33].forEach(function (f) {
          var o = ctx.createOscillator(), o2 = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
          o.type = 'sawtooth'; o2.type = 'sawtooth'; o.frequency.value = f; o2.frequency.value = f * 1.006;
          lp.type = 'lowpass'; lp.frequency.setValueAtTime(600, t + 0.35); lp.frequency.exponentialRampToValueAtTime(2600, t + 0.9);
          g.gain.setValueAtTime(0.0001, t + 0.35); g.gain.exponentialRampToValueAtTime(0.045, t + 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
          o.connect(lp); o2.connect(lp); lp.connect(g); route(g, 0.5);
          o.start(t + 0.35); o2.start(t + 0.35); o.stop(t + 2.1); o2.stop(t + 2.1);
        });
        noise(t + 0.3, 1.2, 'highpass', 6000, 9000, 0.4, 0.09, 0.25, 0.6);
        tone('sine', 90, 40, t, 0.004, 0.6, 0.5, 0.2);
      },
      combo: function (lv) {
        if (!ok()) return; var t = ctx.currentTime, b = note(8 + lv * 2);
        bell(b, t, 0.5, 2, 1.2, 0.12, 0.45); bell(b * 1.5, t + 0.07, 0.6, 2, 1.2, 0.12, 0.45);
        marimba(b / 2, t, 0.18, 0.3);
      },
      lose: function () {
        if (!ok()) return; var t = ctx.currentTime;
        [[330, 300], [262, 196]].forEach(function (p, i) {
          var o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), s = t + i * 0.24;
          o.type = 'sawtooth'; o.frequency.setValueAtTime(p[0], s); o.frequency.exponentialRampToValueAtTime(p[1], s + 0.4);
          lp.type = 'lowpass'; lp.Q.value = 6; lp.frequency.setValueAtTime(1800, s); lp.frequency.exponentialRampToValueAtTime(260, s + 0.42);
          env(g, s, 0.01, 0.12, 0.42); o.connect(lp); lp.connect(g); route(g, 0.3);
          o.start(s); o.stop(s + 0.5);
        });
      },
      rumble: function () {
        if (!ok()) return; var t = ctx.currentTime;
        noise(t, 1.3, 'lowpass', 600, 70, 0.7, 0.5, 0.05, 0.3);
        for (var i = 0; i < 10; i++) tone('sine', rand(120, 260), 60, t + i * 0.08 + Math.random() * 0.05, 0.002, 0.12, 0.08, 0.2);
      },
      drop: function () {
        if (!ok()) return; var t = ctx.currentTime;
        noise(t, 0.5, 'bandpass', 300, 1400, 1.5, 0.12, 0.25, 0.3);
        [0, 2, 4, 5].forEach(function (k, i) { marimba(note(k + 5), t + 0.25 + i * 0.06, 0.12, 0.35); });
      },
      tick: function (hi) {
        if (!ok()) return; var t = ctx.currentTime;
        tone('sine', hi ? 2100 : 1500, 0, t, 0.001, 0.14, 0.04, 0.15);
        noise(t, 0.02, 'bandpass', hi ? 3200 : 2500, 0, 3, 0.15);
      },
      gong: function () {
        if (!ok()) return; var t = ctx.currentTime;
        bell(98, t, 3.6, 1.4, 4.5, 0.5, 0.5);
        bell(196.5, t, 2.6, 2.31, 2.5, 0.2, 0.5);
        bell(311, t, 1.8, 1.7, 1.5, 0.08, 0.5);
        noise(t, 0.15, 'lowpass', 1500, 200, 0.6, 0.3);
      },
      ui: function (k) {
        if (!ok()) return; var t = ctx.currentTime;
        tone('sine', 520 + (k || 0) * 90, 880 + (k || 0) * 120, t, 0.003, 0.18, 0.09, 0.15);
        noise(t, 0.015, 'bandpass', 3000, 0, 2, 0.1);
      },
      count: function (i) { if (ok() && throttle('count', 50)) marimba(note(6 + (i % 10)), ctx.currentTime, 0.07, 0.2); },
      swish: function (v) {
        if (!ok() || !throttle('swish', 140)) return; var t = ctx.currentTime;
        noise(t, 0.22, 'bandpass', 500, 1500, 2, clamp(v, 0.04, 0.16), 0.05, 0.1);
      },
    };
  })();

  // ================================================================== textures
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
  function star(g, cx, cy, n, r1, r2, rot) {
    g.beginPath();
    for (var i = 0; i < n * 2; i++) { var a = rot + i * Math.PI / n, r = i % 2 ? r2 : r1; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    g.closePath();
  }
  // Colour blocks: a white glazed tile with a pressed eight-point star, multiplied by the instance colour.
  var faceTex = canvasTex(256, 256, function (g, w) {
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, w, w);
    var gr = g.createLinearGradient(0, 0, 0, w); gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#eaeaea');
    g.fillStyle = gr; rr(g, 16, 16, w - 32, w - 32, 34); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.075)'; star(g, w / 2, w / 2, 8, 70, 46, Math.PI / 8); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)'; star(g, w / 2, w / 2, 8, 50, 33, Math.PI / 8); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.06)'; g.beginPath(); g.arc(w / 2, w / 2, 15, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.7)'; rr(g, 34, 26, w - 68, 16, 8); g.fill();
  });
  var steelTex = canvasTex(256, 256, function (g, w) {
    var gr = g.createLinearGradient(0, 0, w, w); gr.addColorStop(0, '#eef2f6'); gr.addColorStop(0.5, '#9aa6b4'); gr.addColorStop(1, '#d6dde5');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
    for (var i = 0; i < 70; i++) { g.fillStyle = 'rgba(255,255,255,' + rand(0.02, 0.08) + ')'; g.fillRect(0, rand(0, w), w, 1); }
    g.strokeStyle = 'rgba(40,50,62,0.55)'; g.lineWidth = 18; rr(g, 20, 20, w - 40, w - 40, 18); g.stroke();
    g.lineWidth = 16; g.beginPath(); g.moveTo(36, 36); g.lineTo(w - 36, w - 36); g.moveTo(w - 36, 36); g.lineTo(36, w - 36); g.stroke();
    [[38, 38], [w - 38, 38], [38, w - 38], [w - 38, w - 38]].forEach(function (p) {
      g.fillStyle = '#4f5a66'; g.beginPath(); g.arc(p[0], p[1], 13, 0, TAU); g.fill();
      g.fillStyle = '#f6f9fc'; g.beginPath(); g.arc(p[0] - 4, p[1] - 4, 5, 0, TAU); g.fill();
    });
  });
  var bombTex = canvasTex(256, 256, function (g, w) {
    g.fillStyle = '#ffcc00'; g.fillRect(0, 0, w, w);
    g.fillStyle = '#1d1a22';
    for (var i = -w; i < w * 2; i += 52) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 26, 0); g.lineTo(i + 26 - w, w); g.lineTo(i - w, w); g.fill(); }
    g.fillStyle = '#2a2430'; rr(g, 30, 30, w - 60, w - 60, 28); g.fill();
    g.fillStyle = '#0f0d12'; g.beginPath(); g.arc(120, 140, 54, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(102, 120, 14, 0, TAU); g.fill();
    g.strokeStyle = '#d9a866'; g.lineWidth = 10; g.beginPath(); g.moveTo(150, 94); g.quadraticCurveTo(168, 66, 192, 74); g.stroke();
    g.fillStyle = '#ff7a1a'; g.beginPath(); g.arc(196, 72, 18, 0, TAU); g.fill();
    g.fillStyle = '#fff3a0'; g.beginPath(); g.arc(196, 72, 8, 0, TAU); g.fill();
  });
  var glowTex = canvasTex(128, 128, function (g, w) {
    var gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.75)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.15)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
  var raysTex = canvasTex(256, 256, function (g, w) {
    g.translate(w / 2, w / 2);
    for (var i = 0; i < 16; i++) {
      g.rotate(TAU / 16);
      var gr = g.createLinearGradient(0, 0, w / 2, 0); gr.addColorStop(0, 'rgba(255,250,220,0.9)'); gr.addColorStop(1, 'rgba(255,250,220,0)');
      g.fillStyle = gr; g.beginPath(); g.moveTo(0, 0); g.lineTo(w / 2, -10); g.lineTo(w / 2, 10); g.closePath(); g.fill();
    }
  });
  var puffTex = canvasTex(128, 128, function (g) {
    [[64, 70, 40], [40, 76, 28], [88, 76, 30], [56, 52, 30], [80, 56, 26]].forEach(function (p) {
      var gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], p[2]);
      gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(p[0], p[1], p[2], 0, TAU); g.fill();
    });
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

  // ================================================================== scene
  var canvas = $('scene');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);
  renderer.toneMapping = THREE.NoToneMapping;
  var scene = new THREE.Scene();
  var HORIZON = new THREE.Color('#ffc98f');
  scene.fog = new THREE.Fog(HORIZON, 70, 190);
  var camera = new THREE.PerspectiveCamera(36, 1, 0.5, 400);
  var BASE_FOV = 36;
  var SUN_DIR = new THREE.Vector3(-0.55, 0.32, -0.77).normalize();

  // Sky: a gradient dome with a soft sun, drawn in world space so the horizon sits on the ground.
  var skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color('#163a8c') }, mid: { value: new THREE.Color('#4a92de') }, hor: { value: HORIZON.clone() },
      sun: { value: SUN_DIR.clone() } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 hor; uniform vec3 sun; varying vec3 vD;' +
      'void main(){ float h = vD.y; vec3 c = mix(hor, mid, smoothstep(0.0, 0.28, h)); c = mix(c, top, smoothstep(0.25, 0.85, h));' +
      'float s = max(dot(vD, sun), 0.0); c += vec3(1.0,0.92,0.7) * (pow(s, 400.0) * 1.6 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.12);' +
      'gl_FragColor = vec4(c, 1.0); }',
  });
  var sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), skyMat);
  scene.add(sky);

  // Image-based light: a small studio of soft panels baked once into a PMREM.
  (function envMap() {
    var envScene = new THREE.Scene();
    var g = new THREE.SphereGeometry(10, 24, 12), cols = [];
    var pos = g.attributes.position;
    var top = new THREE.Color('#cfe4ff'), bot = new THREE.Color('#e8b58a'), c = new THREE.Color();
    for (var i = 0; i < pos.count; i++) { c.copy(bot).lerp(top, clamp(pos.getY(i) / 10 * 0.5 + 0.5, 0, 1)); cols.push(c.r, c.g, c.b); }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    envScene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    [[[-5, 6, 5], 5, '#ffffff', 3], [[6, 3, 4], 3, '#fff1d6', 1.6], [[0, 8, -6], 6, '#ffe7c4', 1.4], [[0, -6, 6], 4, '#ffcf9e', 0.6]].forEach(function (p) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(p[1], p[1]), new THREE.MeshBasicMaterial({ color: new THREE.Color(p[2]).multiplyScalar(p[3]), side: THREE.DoubleSide }));
      m.position.set(p[0][0], p[0][1], p[0][2]); m.lookAt(0, 0, 0); envScene.add(m);
    });
    var pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(envScene, 0.02).texture;
    scene.environment.userData = {};
    pm.dispose();
  })();

  scene.add(new THREE.HemisphereLight('#fff4e0', '#b07a52', 0.55));
  var key = new THREE.DirectionalLight('#fff3e2', 1.7); key.position.set(-6, 12, 9); scene.add(key);
  var rim = new THREE.DirectionalLight('#ffd29a', 1.2); rim.position.copy(SUN_DIR).multiplyScalar(20); scene.add(rim);

  // Ground: warm sandstone with a tiled courtyard ring around the pedestal.
  var groundTex = canvasTex(1024, 1024, function (g, w) {
    var c = w / 2;
    var gr = g.createRadialGradient(c, c, 0, c, c, c);
    gr.addColorStop(0, '#e9b47c'); gr.addColorStop(0.5, '#dfa66d'); gr.addColorStop(1, '#e8b887');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
    var R0 = 70, R1 = 150, R2 = 170;
    g.fillStyle = '#c96b4a'; g.beginPath(); g.arc(c, c, R2, 0, TAU); g.fill();
    g.fillStyle = '#f7ead2'; g.beginPath(); g.arc(c, c, R1 + 6, 0, TAU); g.fill();
    g.fillStyle = '#2f8f8a'; g.beginPath(); g.arc(c, c, R1, 0, TAU); g.fill();
    g.fillStyle = '#f7ead2'; g.beginPath(); g.arc(c, c, R1 - 6, 0, TAU); g.fill();
    for (var i = 0; i < 16; i++) {
      var a = i * TAU / 16, x = c + Math.cos(a) * (R0 + R1) / 2, y = c + Math.sin(a) * (R0 + R1) / 2;
      g.fillStyle = i % 2 ? '#c96b4a' : '#2f8f8a'; star(g, x, y, 8, 26, 16, a); g.fill();
      g.fillStyle = '#ffcf5a'; g.beginPath(); g.arc(x, y, 6, 0, TAU); g.fill();
    }
    g.strokeStyle = 'rgba(150,80,40,0.25)'; g.lineWidth = 3;
    for (var k = 0; k < 64; k++) { var b = k * TAU / 64; g.beginPath(); g.moveTo(c + Math.cos(b) * R2, c + Math.sin(b) * R2); g.lineTo(c + Math.cos(b) * (R2 + 60), c + Math.sin(b) * (R2 + 60)); g.stroke(); }
    [R2 + 60, R2 + 120].forEach(function (r) { g.beginPath(); g.arc(c, c, r, 0, TAU); g.stroke(); });
  });
  groundTex.anisotropy = 8;
  var ground = new THREE.Mesh(new THREE.CircleGeometry(160, 64), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.92, metalness: 0 }));
  // Map the courtyard texture so its tiled ring hugs the pedestal (the rest clamps to plain sand).
  (function () { var uv = ground.geometry.attributes.uv; for (var i = 0; i < uv.count; i++) uv.setXY(i, 0.5 + (uv.getX(i) - 0.5) * 22, 0.5 + (uv.getY(i) - 0.5) * 22); })();
  ground.rotation.x = -Math.PI / 2; ground.position.y = GROUND_Y; scene.add(ground);
  var blobTex = canvasTex(128, 128, function (g, w) {
    var gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(70,30,10,0.6)'); gr.addColorStop(0.5, 'rgba(70,30,10,0.3)'); gr.addColorStop(1, 'rgba(70,30,10,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
  var blob = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = GROUND_Y + 0.02; scene.add(blob);

  // Distant skyline in the haze, clouds and kites.
  (function skyline() {
    var mat = new THREE.MeshLambertMaterial({ color: '#e7b996' }), mat2 = new THREE.MeshLambertMaterial({ color: '#f0c9a8' });
    for (var i = 0; i < 14; i++) {
      var t = i / 13; if (Math.abs(t - 0.5) < 0.09) continue;
      var a = Math.PI * (0.55 + 0.9 * t) + rand(-0.03, 0.03), rad = rand(85, 110), grp = new THREE.Group();
      if (i % 3 === 1) {
        var hgt = rand(16, 24);
        var shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.5, hgt, 8), mat); shaft.position.y = hgt / 2; grp.add(shaft);
        var bal = new THREE.Mesh(new THREE.CylinderGeometry(2, 1.6, 0.8, 8), mat2); bal.position.y = hgt * 0.72; grp.add(bal);
        var top = new THREE.Mesh(new THREE.SphereGeometry(1.35, 10, 8, 0, TAU, 0, Math.PI / 2), mat2); top.position.y = hgt; grp.add(top);
        var sp = new THREE.Mesh(new THREE.ConeGeometry(0.3, 2.2, 6), mat); sp.position.y = hgt + 2.2; grp.add(sp);
      } else {
        var bw = rand(8, 13), bh = rand(4, 8);
        var base = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bw * 0.6), mat2); base.position.y = bh / 2; grp.add(base);
        var dome = new THREE.Mesh(new THREE.SphereGeometry(bw * 0.3, 14, 8, 0, TAU, 0, Math.PI / 2), mat); dome.position.y = bh; grp.add(dome);
      }
      grp.position.set(Math.sin(a) * rad, GROUND_Y, Math.cos(a) * rad); grp.rotation.y = a; scene.add(grp);
    }
  })();
  var clouds = [];
  for (var ci = 0; ci < 7; ci++) {
    var cl = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, opacity: rand(0.55, 0.85), depthWrite: false, fog: false }));
    cl.scale.set(rand(26, 42), rand(12, 18), 1);
    cl.position.set(rand(-90, 90), rand(28, 60), rand(-150, -110));
    cl.userData.v = rand(0.4, 1.1); scene.add(cl); clouds.push(cl);
  }
  var kites = [];
  (function () {
    var kc = [['#f0364d', '#ffb200'], ['#1fbf6e', '#ffffff'], ['#a54cf2', '#3a6dff']];
    kc.forEach(function (cc, i) {
      var tex = canvasTex(128, 128, function (g, w) {
        g.translate(w / 2, w / 2); g.rotate(Math.PI / 4);
        g.fillStyle = cc[0]; g.fillRect(-44, -44, 44, 44); g.fillRect(0, 0, 44, 44);
        g.fillStyle = cc[1]; g.fillRect(0, -44, 44, 44); g.fillRect(-44, 0, 44, 44);
        g.strokeStyle = 'rgba(60,20,20,0.6)'; g.lineWidth = 3; g.strokeRect(-44, -44, 88, 88);
        g.beginPath(); g.moveTo(-44, -44); g.lineTo(44, 44); g.moveTo(44, -44); g.lineTo(-44, 44); g.stroke();
      });
      var k = new THREE.Group();
      k.add(new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })));
      var tailPts = []; for (var j = 0; j < 12; j++) tailPts.push(new THREE.Vector3(0, -2 - j * 0.7, 0));
      var tg = new THREE.BufferGeometry().setFromPoints(tailPts);
      k.add(new THREE.Line(tg, new THREE.LineBasicMaterial({ color: cc[0] })));
      k.position.set([-38, 30, -12][i], [30, 38, 46][i], [-80, -95, -120][i]);
      k.userData = { base: k.position.clone(), ph: rand(0, 6), tail: tg };
      scene.add(k); kites.push(k);
    });
  })();

  // Pedestal: stepped plinth, a truck-art band, a turning gold top.
  var bandTex = canvasTex(1024, 128, function (g, w, h) {
    g.fillStyle = '#b3123e'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffcc1a'; g.fillRect(0, 0, w, 12); g.fillRect(0, h - 12, w, 12);
    var cols = ['#1fbf6e', '#3a6dff', '#ffffff', '#ff7a1a'];
    for (var i = 0; i < 32; i++) {
      g.fillStyle = cols[i % 4]; var x = i * 32;
      g.beginPath(); g.moveTo(x, 12); g.lineTo(x + 32, 12); g.lineTo(x + 16, 34); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x, h - 12); g.lineTo(x + 32, h - 12); g.lineTo(x + 16, h - 34); g.closePath(); g.fill();
    }
    for (var k = 0; k < 16; k++) {
      var cx = k * 64 + 32, cy = h / 2;
      g.fillStyle = '#ffffff';
      for (var p = 0; p < 6; p++) { var a = p * TAU / 6; g.beginPath(); g.ellipse(cx + Math.cos(a) * 11, cy + Math.sin(a) * 11, 8, 5, a, 0, TAU); g.fill(); }
      g.fillStyle = k % 2 ? '#1fbf6e' : '#ffcc1a'; g.beginPath(); g.arc(cx, cy, 7, 0, TAU); g.fill();
    }
  });
  bandTex.wrapS = THREE.RepeatWrapping;
  var cream = new THREE.MeshStandardMaterial({ color: '#f6e7cc', roughness: 0.75 });
  var gold = new THREE.MeshStandardMaterial({ color: '#f5b93a', metalness: 1, roughness: 0.28 });
  var pedestal = new THREE.Group();
  var plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.85, 0.45, 8), cream); plinth.position.y = GROUND_Y + 0.225; pedestal.add(plinth);
  var trim1 = new THREE.Mesh(new THREE.CylinderGeometry(2.42, 2.5, 0.12, 8), gold); trim1.position.y = GROUND_Y + 0.51; pedestal.add(trim1);
  var band = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 0.92, 8, 1), new THREE.MeshStandardMaterial({ map: bandTex, roughness: 0.45 }));
  band.position.y = GROUND_Y + 0.57 + 0.46; pedestal.add(band);
  var topSlab = new THREE.Mesh(new THREE.CylinderGeometry(2.24, 2.3, 0.24, 8), gold); topSlab.position.y = -0.12; pedestal.add(topSlab);
  scene.add(pedestal);

  // The minaret cap that rides on top of the tower.
  var cap = new THREE.Group();
  (function buildCap() {
    var teal = new THREE.MeshStandardMaterial({ color: '#10a69a', roughness: 0.22, metalness: 0.15 });
    var balc = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.7, 0.24, 8), gold); balc.position.y = 0.12; cap.add(balc);
    var drumTex = canvasTex(512, 128, function (g, w, h) {
      g.fillStyle = '#fff6e6'; g.fillRect(0, 0, w, h);
      for (var i = 0; i < 8; i++) {
        var x = i * 64 + 14;
        g.fillStyle = '#10a69a'; g.beginPath(); g.moveTo(x, h - 12); g.lineTo(x, 50); g.quadraticCurveTo(x + 18, 14, x + 36, 50); g.lineTo(x + 36, h - 12); g.closePath(); g.fill();
        g.fillStyle = '#0a5a60'; g.beginPath(); g.moveTo(x + 7, h - 16); g.lineTo(x + 7, 56); g.quadraticCurveTo(x + 18, 32, x + 29, 56); g.lineTo(x + 29, h - 16); g.closePath(); g.fill();
      }
      g.fillStyle = '#f2b233'; g.fillRect(0, 0, w, 8); g.fillRect(0, h - 8, w, 8);
    });
    var drum = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.2, 0.95, 16), new THREE.MeshStandardMaterial({ map: drumTex, roughness: 0.6 }));
    drum.position.y = 0.24 + 0.475; cap.add(drum);
    var ring = new THREE.Mesh(new THREE.CylinderGeometry(1.32, 1.32, 0.14, 16), gold); ring.position.y = 1.24; cap.add(ring);
    var pts = [[1.22, 0], [1.38, 0.28], [1.36, 0.62], [1.12, 1.02], [0.7, 1.42], [0.32, 1.78], [0.12, 2.05], [0.0, 2.16]], prof = [];
    for (var i = 0; i < pts.length; i++) prof.push(new THREE.Vector2(pts[i][0], pts[i][1]));
    var dome = new THREE.Mesh(new THREE.LatheGeometry(prof, 24), teal); dome.position.y = 1.3; cap.add(dome);
    var fin1 = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), gold); fin1.position.y = 3.5; cap.add(fin1);
    var fin2 = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.7, 10), gold); fin2.position.y = 3.95; cap.add(fin2);
    var fin3 = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), gold); fin3.position.y = 3.25; cap.add(fin3);
    cap.scale.setScalar(CAP_S);
  })();
  scene.add(cap);

  // The cannon: a brass barrel on a painted wooden carriage.
  var cannon = new THREE.Group(), barrelPivot = new THREE.Group(), barrel = new THREE.Group();
  (function buildCannon() {
    var wood = new THREE.MeshStandardMaterial({ map: bandTex, roughness: 0.5 });
    var dark = new THREE.MeshStandardMaterial({ color: '#5a2a1a', roughness: 0.7 });
    var carriage = new THREE.Mesh(roundedBox(1.3, 0.55, 1.5, 0.12), wood); carriage.position.y = 0.42; cannon.add(carriage);
    [-0.78, 0.78].forEach(function (x) {
      var wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.16, 18), dark); wheel.rotation.z = Math.PI / 2; wheel.position.set(x, 0.55, 0.15); cannon.add(wheel);
      var rimM = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.06, 6, 20), gold); rimM.rotation.y = Math.PI / 2; rimM.position.set(x * 1.06, 0.55, 0.15); cannon.add(rimM);
      var hub = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), gold); hub.position.set(x * 1.12, 0.55, 0.15); cannon.add(hub);
    });
    var tube = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.9, 20, 1, true), gold); tube.rotation.x = Math.PI / 2; tube.position.z = -0.55; barrel.add(tube);
    var back = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 10), gold); back.position.z = 0.4; barrel.add(back);
    [-0.05, -0.75, -1.42].forEach(function (z, i) {
      var t = new THREE.Mesh(new THREE.TorusGeometry(i === 2 ? 0.36 : 0.4, 0.07, 8, 22), gold); t.position.z = z; barrel.add(t);
    });
    var bore = new THREE.Mesh(new THREE.CircleGeometry(0.25, 16), new THREE.MeshBasicMaterial({ color: '#140a05' })); bore.position.z = -1.5; bore.rotation.y = Math.PI; barrel.add(bore);
    barrelPivot.position.set(0, 0.95, 0.1); barrelPivot.add(barrel); cannon.add(barrelPivot);
    cannon.position.set(0, GROUND_Y, LAUNCH_Z);
  })();
  scene.add(cannon);
  var cannonShadow = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
  cannonShadow.rotation.x = -Math.PI / 2; cannonShadow.position.set(0, GROUND_Y + 0.02, LAUNCH_Z); scene.add(cannonShadow);

  // Instanced blocks: one mesh per kind.
  var CAPN = COLS * ML;
  var blockGeo = roundedBox(BW * 0.96, BH * 0.96, BD, 0.14);
  function blockMesh(mat) {
    var m = new THREE.InstancedMesh(blockGeo, mat, CAPN);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; m.count = 0; scene.add(m); return m;
  }
  var mColour = blockMesh(new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.32, metalness: 0, envMapIntensity: 0.55 }));
  mColour.setColorAt(0, new THREE.Color('#ffffff')); mColour.instanceColor.setUsage(THREE.DynamicDrawUsage);
  var mSteel = blockMesh(new THREE.MeshStandardMaterial({ map: steelTex, roughness: 0.28, metalness: 0.85 }));
  var bombMat = new THREE.MeshStandardMaterial({ map: bombTex, roughness: 0.4, emissive: '#ff3000', emissiveIntensity: 0 });
  var mBomb = blockMesh(bombMat);

  // Debris: glazed shards with spin and gravity.
  var DEB = 520;
  var mDeb = new THREE.InstancedMesh(roundedBox(0.34, 0.28, 0.32, 0.07), new THREE.MeshStandardMaterial({ roughness: 0.3 }), DEB);
  mDeb.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mDeb.frustumCulled = false; mDeb.count = 0;
  mDeb.setColorAt(0, new THREE.Color('#fff')); scene.add(mDeb);
  var debris = [];
  // Dust puffs.
  var DUST = 120;
  var mDust = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 1),
    new THREE.MeshLambertMaterial({ color: '#fff1dc', transparent: true, opacity: 0.38, depthWrite: false }), DUST);
  mDust.frustumCulled = false; mDust.count = 0; scene.add(mDust);
  var dust = [];
  // Sparks: additive points.
  var SPK = 420;
  var spkGeo = new THREE.BufferGeometry();
  var spkPos = new Float32Array(SPK * 3), spkCol = new Float32Array(SPK * 3);
  spkGeo.setAttribute('position', new THREE.BufferAttribute(spkPos, 3).setUsage(THREE.DynamicDrawUsage));
  spkGeo.setAttribute('color', new THREE.BufferAttribute(spkCol, 3).setUsage(THREE.DynamicDrawUsage));
  var sparksPts = new THREE.Points(spkGeo, new THREE.PointsMaterial({ size: 0.32, map: glowTex, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
  sparksPts.frustumCulled = false; scene.add(sparksPts);
  var sparks = [];
  // Glow flashes, shockwave rings and the smash rays.
  var glows = [];
  function glowSprite() {
    var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
    s.visible = false; scene.add(s); return s;
  }
  for (var gi = 0; gi < 10; gi++) glows.push({ s: glowSprite(), life: 1, max: 1, size: 1 });
  var rings = [];
  for (var ri = 0; ri < 6; ri++) {
    var rm = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    rm.visible = false; scene.add(rm); rings.push({ m: rm, life: 1, max: 1, size: 1 });
  }
  var rays = new THREE.Sprite(new THREE.SpriteMaterial({ map: raysTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0, fog: false }));
  rays.scale.set(18, 18, 1); scene.add(rays);
  var raysLife = 0;

  // The ball, its trail and the one waiting in the muzzle.
  var ballMat = new THREE.MeshStandardMaterial({ color: '#25336e', roughness: 0.12, metalness: 0.55 });
  var ballGeo = new THREE.SphereGeometry(0.34, 24, 16);
  var ballMesh = new THREE.Mesh(ballGeo, ballMat); ballMesh.visible = false; scene.add(ballMesh);
  var loaded = new THREE.Mesh(ballGeo, ballMat); scene.add(loaded);
  var trail = [];
  for (var tj = 0; tj < 10; tj++) {
    var ts = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: '#bcd0ff', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
    ts.scale.setScalar(0.7); ts.visible = false; scene.add(ts); trail.push(ts);
  }
  var trailHist = [];

  // ================================================================== 2D fx layer
  var fx = $('fx'), fg = fx.getContext('2d');
  var confetti = [], popups = [];
  var VW = 1, VH = 1, UI = 1, baseFov = BASE_FOV;

  function resize() {
    VW = window.innerWidth; VH = window.innerHeight;
    renderer.setSize(VW, VH, false);
    camera.aspect = VW / VH;
    baseFov = camera.aspect < DA ? 2 * Math.atan(Math.tan(BASE_FOV * Math.PI / 360) * DA / camera.aspect) * 180 / Math.PI : BASE_FOV;
    camera.fov = baseFov;
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
  function pendTarget() { var r = $('hPend').getBoundingClientRect(); return { x: r.left + Math.min(60, r.width / 2), y: r.top + r.height / 2 }; }
  // A score popup rises, holds, then (in a run) flies into the "in tower" pill.
  function popup(text, x, y, color, size, sub, fly) {
    for (var i = 0; i < popups.length; i++) if (popups[i].life < 0.4) y = Math.min(y, popups[i].y0 - (popups[i].size + 24) * UI);
    popups.push({ text: text, x0: x, y0: y, x: x, y: y, color: color, size: size, life: 0, max: fly ? 1.15 : 1.1, sub: sub, fly: fly });
  }
  function burstConfetti(n, x, y, spread) {
    var cols = ['#f0364d', '#ffb200', '#1fbf6e', '#3a6dff', '#a54cf2', '#ffffff', '#ff7a1a'];
    for (var i = 0; i < n; i++) {
      var a = rand(-Math.PI, 0), s = rand(250, 780) * (spread || 1);
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
    var tgt = null;
    for (var j = popups.length - 1; j >= 0; j--) {
      var p = popups[j];
      p.life += dt;
      if (p.life > p.max) { if (p.fly) bump(hPend); popups.splice(j, 1); continue; }
      var k = p.life / p.max, sc, alpha = 1;
      if (p.fly && p.life > 0.6) {
        tgt = tgt || pendTarget();
        var u = clamp((p.life - 0.6) / (p.max - 0.6), 0, 1), e = u * u;
        var sy0 = p.y0 - 34 * s;
        p.x = p.x0 + (tgt.x - p.x0) * e; p.y = sy0 + (tgt.y - sy0) * e - Math.sin(u * Math.PI) * 40 * s;
        sc = 1 - 0.55 * e;
      } else {
        p.x = p.x0; p.y = p.y0 - 34 * s * Math.min(1, p.life / 0.35);
        sc = p.life < 0.16 ? 0.4 + 0.8 * (p.life / 0.16) : 1.2 - 0.2 * Math.min(1, (p.life - 0.16) * 6);
        if (!p.fly && k > 0.7) alpha = (1 - k) / 0.3;
      }
      fg.save();
      fg.translate(p.x, p.y); fg.scale(sc * s, sc * s); fg.globalAlpha = alpha;
      fg.font = p.size + 'px "Titan One", system-ui, sans-serif';
      fg.textAlign = 'center'; fg.textBaseline = 'middle';
      fg.lineJoin = 'round'; fg.lineWidth = p.size * 0.24; fg.strokeStyle = 'rgba(40,10,32,0.9)';
      fg.strokeText(p.text, 0, 0); fg.fillStyle = p.color; fg.fillText(p.text, 0, 0);
      if (p.sub) {
        fg.font = Math.round(p.size * 0.52) + 'px "Titan One", system-ui, sans-serif';
        fg.lineWidth = p.size * 0.14; fg.strokeText(p.sub, 0, -p.size * 0.82); fg.fillStyle = '#ffffff'; fg.fillText(p.sub, 0, -p.size * 0.82);
      }
      fg.restore();
    }
  }

  // ================================================================== tower visuals
  // The world being drawn: the run, the hands-on practice, or the menu tower.
  var sim = null, menuSim = null, prac = null;
  var mode = 'menu';
  function world() { return mode === 'prac' && prac ? prac : (sim && mode !== 'menu' ? sim : menuSim); }

  var V = { cols: [], camH: 10, capY: 10, capVY: 0, capFly: null, shake: 0, punch: 0, angle: 0, prevAngle: 0,
    ball: null, afterBall: null, timers: [], recoil: 0, aimYaw: 0, aimPitch: 0.2, slow: 0, popN: 0, preview: null, towerTotal: 1, lastMult: 1 };
  var timeAcc = 0;

  function colourOf(t) { return t === STEEL ? '#9aa6b4' : t === BOMB ? '#ffcc00' : PAL[t]; }

  function buildVis(grid, drop) {
    V.cols = [];
    for (var c = 0; c < COLS; c++) {
      var arr = [], h = colHeight(grid, c);
      for (var r = 0; r < h; r++) {
        var ty = BH * (r + 0.5);
        arr.push({ t: grid[c * ML + r], y: drop ? ty + 12 + r * 0.7 + ((c * 3) % 8) * 0.22 : ty, vy: 0, sq: 1, flash: 0, die: 0 });
      }
      V.cols.push(arr);
    }
    if (drop) { V.capY = topHeight(grid) * BH + 26; V.capVY = 0; V.capFly = null; cap.scale.setScalar(CAP_S); }
    var n = 0; for (var i = 0; i < grid.length; i++) if (grid[i] !== EMPTY && grid[i] !== STEEL) n++;
    V.towerTotal = Math.max(1, n);
  }

  function colTheta(c, angle) { return (c * COL_ANG + angle) / ANG * TAU; }
  function blockPos(c, y, angle, out) {
    var th = colTheta(c, angle);
    out.set(Math.sin(th) * R, y, Math.cos(th) * R);
    return th;
  }
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
      var sp = rand(2.5, 6.5) * power;
      debris.push({ p: new THREE.Vector3(x + rand(-0.3, 0.3), y + rand(-0.25, 0.25), z + rand(-0.3, 0.3)),
        v: new THREE.Vector3(out.x * sp + rand(-2, 2), rand(3, 8) * power, out.z * sp * 0.7 + rand(-1, 1.5) * power),
        r: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)), w: new THREE.Vector3(rand(-14, 14), rand(-14, 14), rand(-14, 14)),
        s: rand(0.6, 1.2), life: 0, max: rand(1.4, 2.4), c: col.clone().offsetHSL(0, 0, rand(-0.05, 0.08)) });
    }
  }
  function spawnSparks(x, y, z, colour, n, speed) {
    var col = new THREE.Color(colour), wh = new THREE.Color('#ffffff');
    for (var i = 0; i < n; i++) {
      if (sparks.length >= SPK) sparks.shift();
      var a = rand(0, TAU), b = rand(-1, 1), sp = rand(3, 9) * (speed || 1), q = Math.sqrt(1 - b * b);
      sparks.push({ p: new THREE.Vector3(x, y, z), v: new THREE.Vector3(Math.cos(a) * sp * q, b * sp + 3, Math.sin(a) * sp * q + 2),
        c: col.clone().lerp(wh, rand(0.2, 0.7)), life: 0, max: rand(0.35, 0.8) });
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
  function glowAt(x, y, z, colour, size, life) {
    var g = glows.shift(); glows.push(g);
    g.s.position.set(x, y, z); g.s.material.color.set(colour); g.size = size; g.life = 0; g.max = life; g.s.visible = true;
  }
  function ringAt(x, y, z, colour, size, life) {
    var r = rings.shift(); rings.push(r);
    r.m.position.set(x, y, z); r.m.lookAt(camera.position); r.m.material.color.set(colour); r.size = size; r.life = 0; r.max = life; r.m.visible = true;
  }

  var vA = new THREE.Vector3(), vB = new THREE.Vector3();
  // A chunk breaks as a ripple from the block the ball hit: each block flashes
  // white, swells, then bursts, a little after its neighbour nearer the hit.
  function breakVis(cells, hitC, hitR, bomb) {
    var set = {}; for (var i = 0; i < cells.length; i++) set[cells[i]] = 1;
    var dist = {}, q = [hitC * ML + hitR], maxD = 0;
    dist[q[0]] = 0;
    while (q.length) {
      var cur = q.shift(), cc = (cur / ML) | 0, cr = cur - cc * ML;
      var nb = [((cc + 1) % COLS) * ML + cr, ((cc + COLS - 1) % COLS) * ML + cr];
      if (!bomb) nb.push(cur + 1, cur - 1);
      for (var k = 0; k < nb.length; k++) if (set[nb[k]] && dist[nb[k]] == null) { dist[nb[k]] = dist[cur] + 1; maxD = Math.max(maxD, dist[cur] + 1); q.push(nb[k]); }
    }
    var stepT = Math.min(0.05, 0.5 / Math.max(1, maxD));
    V.popN = 0;
    for (var j = 0; j < cells.length; j++) {
      var c = (cells[j] / ML) | 0, r = cells[j] - c * ML, b = V.cols[c] && V.cols[c][r];
      if (!b) continue;
      b.die = timeAcc + (dist[cells[j]] || 0) * stepT + 0.03;
      b.flash = 1; b.n = cells.length; b.bomb = bomb;
    }
  }
  function burstBlock(c, b) {
    blockPos(c, b.y, V.angle, vA);
    var colour = colourOf(b.t), power = b.bomb ? 1.6 : 0.85 + Math.min(0.7, (b.n || 1) / 20);
    spawnDebris(vA.x, vA.y, vA.z, colour, (b.n || 1) > 14 ? 3 : 4, power);
    spawnSparks(vA.x, vA.y, vA.z, colour, (b.n || 1) > 14 ? 4 : 7, 1);
    if (V.popN < 8 || Math.random() < 0.3) spawnDust(vA.x, vA.y, vA.z, 1, 0.8);
    if (V.popN % 2 === 0) glowAt(vA.x * 1.15, vA.y, vA.z * 1.15, NOTE_PAL[b.t] || '#ffffff', 1.6, 0.25);
    Snd.pop(V.popN++, b.n || 1);
  }
  function crumbleAll(power) {
    for (var c = 0; c < COLS; c++) {
      var col = V.cols[c];
      for (var r = 0; r < col.length; r++) {
        blockPos(c, col[r].y, V.angle, vA);
        spawnDebris(vA.x, vA.y, vA.z, colourOf(col[r].t), 3, power);
        if (r % 2 === 0) spawnSparks(vA.x, vA.y, vA.z, colourOf(col[r].t), 3, 1);
        if (r % 3 === 0) spawnDust(vA.x, vA.y, vA.z, 1, 1.3);
      }
      V.cols[c] = [];
    }
  }
  function anyDying() {
    for (var c = 0; c < COLS; c++) { var col = V.cols[c]; if (!col) continue; for (var r = 0; r < col.length; r++) if (col[r].die) return true; }
    return false;
  }
  // A safety net: if the picture ever disagrees with the world, the world wins.
  function resyncVis() {
    var w = world(); if (!w || anyDying()) return;
    for (var c = 0; c < COLS; c++) {
      var h = colHeight(w.grid, c), col = V.cols[c];
      var ok = col.length === h;
      for (var r = 0; ok && r < h; r++) if (col[r].t !== w.grid[c * ML + r]) ok = false;
      if (!ok) {
        var arr = [];
        for (var r2 = 0; r2 < h; r2++) arr.push({ t: w.grid[c * ML + r2], y: col[r2] ? col[r2].y : BH * (r2 + 0.5), vy: 0, sq: 1, flash: 0, die: 0 });
        V.cols[c] = arr;
      }
    }
  }

  function later(sec, fn) { V.timers.push({ t: sec, fn: fn }); }
  function laterTower(sec, fn) { var k = sim.tower; later(sec, function () { if (sim && sim.tower === k && sim.phase === 'trans') fn(); }); }
  function flashScreen() { var f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }

  // ================================================================== picking
  var raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  var pickMap = { colour: [], steel: [], bomb: [] };
  function pickAt(x, y) {
    ndc.set(x / VW * 2 - 1, -(y / VH) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects([mColour, mSteel, mBomb], false);
    if (!hits.length) return -1;
    var h = hits[0], m = h.object === mColour ? pickMap.colour : h.object === mSteel ? pickMap.steel : pickMap.bomb;
    var cell = m[h.instanceId];
    return cell == null ? -1 : cell;   // the nearest block decides: never reach through it
  }
  function pickCell(x, y) {
    var cell = pickAt(x, y);
    if (cell >= 0) return cell;
    var rad = 13 * Math.max(UI, 0.8);
    for (var k = 0; k < 8; k++) {
      var a = k * TAU / 8;
      cell = pickAt(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
      if (cell >= 0) return cell;
    }
    return -1;
  }

  // ================================================================== HUD
  var hud = $('hud'), hScore = $('hScore'), hPend = $('hPend'), hClock = $('hClock'), hTower = $('hTower'), hBalls = $('hBalls');
  var hBar = $('hBar'), hCombo = $('hCombo'), hComboX = $('hComboX');
  var shownScore = 0, pendShown = 0, lastSec = -1, lastBalls = -1, lastCombo = 0;
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
  function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); setTimeout(function () { el.classList.remove('bump'); }, 170); }

  function updateHud(dt) {
    if (!sim) return;
    shownScore += (sim.score - shownScore) * Math.min(1, dt * 5);
    if (Math.abs(sim.score - shownScore) < 1) shownScore = sim.score;
    hScore.textContent = fmt(shownScore);
    // The pill counts what has landed in it, so it lags the popups flying in.
    if (!hPend.classList.contains('lost')) {
      var flying = 0; for (var i = 0; i < popups.length; i++) if (popups[i].fly) flying += popups[i].fly;
      var target = sim.pending === 0 ? 0 : Math.max(0, sim.pending - flying);
      if (target !== pendShown) { pendShown = target; hPend.textContent = '+' + fmt(target) + ' IN TOWER'; }
      hPend.classList.toggle('is-empty', target === 0);
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
    var remain = 0; for (var k = 0; k < sim.grid.length; k++) if (sim.grid[k] !== EMPTY && sim.grid[k] !== STEEL) remain++;
    hBar.style.width = Math.round(100 * (1 - remain / V.towerTotal)) + '%';
    hTower.textContent = 'TOWER ' + (sim.tower + 1);
    if (sim.combo !== lastCombo) {
      var c = sim.combo;
      hCombo.classList.toggle('on', c >= 2);
      hCombo.classList.toggle('x3', c === 3); hCombo.classList.toggle('x4', c >= 4);
      if (c >= 2) { hComboX.textContent = 'x' + c; hCombo.classList.remove('pop'); void hCombo.offsetWidth; hCombo.classList.add('pop'); }
      lastCombo = c;
    }
  }

  // ================================================================== a ball lands
  // Used by the run and by the practice. hit = { c, r, type, cells, pts, colour, mult, fly }.
  function hitFx(hit) {
    var face = blockFace(hit.c, hit.r, new THREE.Vector3());
    var out = new THREE.Vector3(face.x, 0, face.z).normalize();
    var ab = { p: face.clone().addScaledVector(out, 0.3), v: new THREE.Vector3(), life: 0 };
    var sp = toScreen(face.x, face.y, face.z);
    if (hit.type === 'steel') {
      ab.v.set(out.x * 7 + rand(-2, 2), 6, out.z * 7);
      Snd.clang();
      V.shake = Math.max(V.shake, 0.2);
      spawnSparks(face.x, face.y, face.z, '#fff3a0', 24, 1.3);
      glowAt(face.x, face.y, face.z, '#fff6c0', 2.4, 0.18);
      var b0 = V.cols[hit.c] && V.cols[hit.c][hit.r]; if (b0) { b0.sq = 0.8; b0.flash = 1; }
      popup('CLANG', sp.x, sp.y, '#e6edf4', 22, V.lastMult > 1 ? 'combo lost' : 'wasted ball', 0);
      V.lastMult = 1;
    } else if (hit.type !== 'miss') {
      var n = hit.cells.length, bomb = hit.type === 'bomb';
      ab.v.set(out.x * 5 + rand(-2, 2), 5, out.z * 5);
      breakVis(hit.cells, hit.c, hit.r, bomb);
      Snd.impact(n);
      if (bomb) { Snd.boom(); V.shake = Math.max(V.shake, 0.9); spawnDust(face.x, face.y, face.z, 10, 2.2); flashScreen(); }
      V.shake = Math.max(V.shake, Math.min(0.7, 0.1 + n * 0.03));
      V.punch = Math.max(V.punch, Math.min(1, n / 14));
      glowAt(face.x, face.y, face.z, NOTE_PAL[hit.colour] || '#ffffff', 3 + Math.min(4, n * 0.25), 0.3);
      ringAt(face.x, face.y, face.z, PAL[hit.colour] || '#ffcc00', 1.5 + Math.min(4, n * 0.3), 0.45);
      var word = bomb ? 'BOOM!' : n >= 16 ? 'MEGA!' : n >= 10 ? 'HUGE!' : n >= 6 ? 'NICE!' : null;
      var mult = hit.mult > 1 ? ' x' + hit.mult : '';
      popup('+' + fmt(hit.pts), sp.x, sp.y - 10 * UI, bomb ? '#ffcc00' : PAL[hit.colour], 22 + Math.min(8, n * 0.5),
        word ? word + mult : (mult ? 'COMBO' + mult : null), hit.fly ? hit.pts : 0);
      if (hit.mult >= 2 && hit.mult > V.lastMult) Snd.combo(hit.mult);
      V.lastMult = hit.mult || 1;
    }
    V.afterBall = ab;
    V.ball = null;
  }

  // ================================================================== events from the sim
  var NEWS = { 1: 'NEW: a fourth colour', 2: 'NEW: the drift speeds up and slows', 3: 'NEW: steel never breaks',
    4: 'NEW: a fifth colour', 5: 'NEW: a bomb clears its ring', 6: 'NEW: the drift can reverse' };
  var resyncSoon = 0, resyncEvery = 1;

  function handleEvent(ev) {
    if (ev.type === 'over') { if (ev.prev) handleEvent(ev.prev); return; }
    if (ev.type === 'tower') {
      buildVis(sim.grid, true);
      V.prevAngle = V.angle = sim.angle;
      hPend.classList.remove('lost');
      var n = NEWS[sim.tower];
      banner('TOWER ' + (sim.tower + 1), '', n || (sim.balls + ' balls'), '', 1400);
      Snd.drop();
      return;
    }
    ev.fly = true;
    hitFx(ev);
    if (ev.type === 'break' || ev.type === 'bomb') resyncSoon = 1.2;
    if (ev.cleared) smashed(ev);
    else if (ev.stands) stands(ev);
  }

  function smashed(ev) {
    laterTower(0.55, function () {
      crumbleAll(1.4);
      V.capFly = { vy: 12, vx: rand(-2, 2), spin: rand(-6, 6), rot: 0 };
      V.shake = Math.max(V.shake, 0.9); V.punch = 1; V.slow = 0.6;
      raysLife = 1.6;
      flashScreen();
      Snd.boom(); Snd.fanfare();
      banner('SMASHED!', 'big', '+' + fmt(ev.banked) + ' banked  +' + fmt(ev.bonus) + ' bonus', '', 1600);
      burstConfetti(140, VW / 2, VH * 0.3, 1);
    });
  }
  // Out of balls ends the run: the tower's unbanked points are lost.
  function stands(ev) {
    if (ev.lost) { hPend.classList.add('lost'); hPend.classList.remove('is-empty'); hPend.textContent = '-' + fmt(ev.lost) + ' LOST'; }
  }

  // ================================================================== input: swipe to turn, tap to fire
  var autoPlay = /[?&]auto=1/.test(QS);
  var perfOn = /[?&]perf=1/.test(QS);
  var qaSpeed = +((/[?&]speed=(\d+)/.exec(QS) || [])[1] || 1);   // QA only: run the clock faster
  var perf = { n: 0, sum: 0, max: 0 };
  var acc = 0, lastT = null;
  var pendingTurn = 0, pendingFlick = null;

  function seedForRun() {
    var m = /[?&]seed=(\d+)/.exec(QS);
    return m ? (+m[1] >>> 0) : ((Math.random() * 4294967296) >>> 0);
  }
  function launchPoint() { return barrel.localToWorld(new THREE.Vector3(0, 0, -1.55)); }

  function fireAt(c, r) {
    if (!fire(sim, c, r)) return false;
    afterFire(c, r, sim.grid[c * ML + r] === STEEL ? [] : hitCells(sim.grid, c, r), sim.step);
    return true;
  }
  function afterFire(c, r, cells, step) {
    Snd.cannon();
    var from = launchPoint();
    V.ball = { from: from, c: c, r: r, fireStep: step, cells: cells };
    V.recoil = 1;
    glowAt(from.x, from.y, from.z, '#ffd27a', 2.6, 0.16);
    spawnDust(from.x, from.y + 0.1, from.z - 0.4, 3, 0.7);
    spawnSparks(from.x, from.y, from.z, '#ffb340', 10, 0.6);
    trailHist.length = 0;
    V.preview = null;
  }

  // World angle units per screen pixel, so a drag moves the tower's face with the finger.
  function turnPerPx() {
    var dist = camera.position.length();
    var pxPerUnit = VH / (2 * dist * Math.tan(camera.fov * Math.PI / 360));
    return ANG / (TAU * (R + BD / 2) * pxPerUnit);
  }
  var ptr = null;
  function canGesture() { return mode === 'play' || (mode === 'prac' && prac && prac.input); }
  canvas.addEventListener('pointerdown', function (e) {
    Snd.init();
    if (ptr || !canGesture()) return;                // one finger at a time: extra fingers do nothing
    ptr = { id: e.pointerId, x0: e.clientX, lx: e.clientX, lt: performance.now(), v: 0, drag: false };
    ptr.cell = pickCell(e.clientX, e.clientY);
    setPreview(ptr.cell);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!ptr || e.pointerId !== ptr.id) return;
    var now = performance.now(), dx = e.clientX - ptr.lx;
    if (!ptr.drag && Math.abs(e.clientX - ptr.x0) > 9 * Math.max(UI, 0.8)) { ptr.drag = true; setPreview(-1); }
    if (ptr.drag) {
      var u = dx * turnPerPx();
      pendingTurn += u;
      var steps = Math.max(0.25, (now - ptr.lt) / (1000 / STEP_HZ));
      ptr.v = ptr.v * 0.5 + (u / steps) * 0.5;   // angle units per step
    }
    ptr.lx = e.clientX; ptr.lt = now;
  });
  function endPtr(e, cancel) {
    if (!ptr || e.pointerId !== ptr.id) return;
    var p = ptr; ptr = null;
    if (cancel) { setPreview(-1); return; }
    if (p.drag) {
      var v = performance.now() - p.lt > 80 ? 0 : Math.round(p.v);
      pendingFlick = Math.abs(v) > 40 ? v : 0;
      if (Math.abs(v) > 300) Snd.swish(Math.abs(v) / 6000);
      return;
    }
    var cell = pickCell(e.clientX, e.clientY);
    if (cell < 0) cell = p.cell;
    setPreview(-1);
    if (cell < 0) return;
    var c = (cell / ML) | 0, r = cell - c * ML;
    if (mode === 'prac') { pracTap(c, r); return; }
    if (mode === 'play' && sim && sim.phase === 'play') fireAt(c, r);
  }
  canvas.addEventListener('pointerup', function (e) { endPtr(e, false); });
  canvas.addEventListener('pointercancel', function (e) { endPtr(e, true); });
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });

  // While a finger rests on a block, its chunk lights up: "this is what you will break".
  function setPreview(cell) {
    var w = world();
    if (cell < 0 || !w || (mode === 'play' && sim && sim.ball) || (mode === 'prac' && prac && prac.ball)) { V.preview = null; return; }
    var c = (cell / ML) | 0, r = cell - c * ML;
    V.preview = w.grid[c * ML + r] === STEEL ? [cell] : hitCells(w.grid, c, r);
  }

  // Feed the drag into the sim, one step at a time.
  function applyInputs() {
    if (pendingTurn) {
      var d = Math.round(clamp(pendingTurn, -MAX_TURN, MAX_TURN));
      if (d && turn(sim, d)) pendingTurn -= d; else pendingTurn = 0;
      if (Math.abs(pendingTurn) < 1) pendingTurn = 0;
    }
    if (pendingFlick !== null && !pendingTurn) { flick(sim, pendingFlick); pendingFlick = null; }
  }

  // ================================================================== hands-on practice (outside the run)
  // Its own little tower and real seconds. Never touches `sim`, scores nothing.
  // 1 tap a block. 2 swipe to turn the tower. 3 tap the big red chunk.
  // 4 combos. 5 the rest crumbles: SMASHED. Then YOU'RE READY.
  var PRAC_COLS = [[3, 2, 2, 2, 4], [4, 3, 2, 1, 3], [1, 4, 3, 3, 2], [2, 1, 1, 4, 2],
    [1, 1, 1, 1, 3], [3, 1, 1, 2, 4], [4, 2, 4, 3, 1], [1, 3, 2, 4, 2]];
  var pCap = $('pcap'), pHand = $('phand'), pSkip = $('pskip'), pReady = $('pready'), pSwipe = $('pswipe');
  function tutSeen() { return +(lsGet('minar-tod-tut') || 0); }

  function startPractice() {
    var g = new Array(COLS * ML);
    for (var i = 0; i < g.length; i++) g[i] = EMPTY;
    for (var c = 0; c < COLS; c++) for (var r = 0; r < PRAC_COLS[c].length; r++) g[c * ML + r] = PRAC_COLS[c][r];
    prac = { grid: g, angle: 9000, phase: 'intro', pt: 0, glide: null, target: null, ball: null, input: false, swiped: 0, turnV: 0 };
    lsSet('minar-tod-tut', String(tutSeen() + 1));
    V.prevAngle = V.angle = prac.angle;
    buildVis(g, true);
    debris.length = 0; dust.length = 0; sparks.length = 0; V.ball = null; V.afterBall = null; V.timers = []; V.preview = null;
    mode = 'prac';
    hide(menu); hide(over); hud.classList.add('is-hidden');
    pSkip.hidden = false;
    Snd.drop();
    pracGlide('intro', 0, 1.3);
  }
  function pracCaption(text) { pCap.textContent = text || ''; pCap.classList.toggle('on', !!text); }
  function pracGlide(phase, to, dur) {
    var d = ((to - prac.angle + ANG / 2) % ANG + ANG) % ANG - ANG / 2;
    prac.phase = phase; prac.pt = 0; prac.target = null; prac.input = false;
    prac.glide = { from: prac.angle, d: d, dur: dur };
  }
  function pracTap(c, r) {
    var p = prac;
    if (!p || p.ball || (p.phase !== 'tap1' && p.phase !== 'tap2')) return;
    if (!colVisible(Math.round(p.angle) & (ANG - 1), c)) return;
    p.ball = { c: c, r: r, t: 0 };
    afterFire(c, r, hitCells(p.grid, c, r), 0);
    p.target = null;
    pracCaption('');
  }
  function pracLand() {
    var p = prac, b = p.ball;
    p.ball = null;
    var v = p.grid[b.c * ML + b.r];
    var cells = hitCells(p.grid, b.c, b.r);
    hitFx({ c: b.c, r: b.r, type: 'break', cells: cells, pts: groupPoints(cells.length), colour: v, mult: 1 });
    p.grid = removeAndSettle(p.grid, cells);
    p.pt = 0; p.input = false;
    if (p.phase === 'tap1') { p.phase = 'after1'; pracCaption(cells.length > 1 ? 'Same colours touching it break too!' : 'Only one broke. Aim for a chunk!'); }
    else { p.phase = 'after2'; pracCaption(cells.length >= 6 ? 'Big chunk, far more points!' : 'Bigger chunks score far more.'); }
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
        if (p.phase === 'intro') { p.phase = 'tap1'; p.input = true; p.target = { c: 0, r: 2 }; pracCaption('Tap a block to fire at it'); }
      }
    } else if (p.input) {
      // The player turns the practice tower the same way as the real one.
      if (pendingTurn) { p.angle += pendingTurn; p.swiped += Math.abs(pendingTurn); pendingTurn = 0; p.turnV = 0; }
      if (pendingFlick !== null) { p.turnV = pendingFlick; pendingFlick = null; }
      if (p.turnV) { p.angle += p.turnV * dt * STEP_HZ; p.swiped += Math.abs(p.turnV * dt * STEP_HZ); p.turnV *= Math.pow(15 / 16, dt * STEP_HZ); if (Math.abs(p.turnV) < 1) p.turnV = 0; }
    }
    p.angle = ((p.angle % ANG) + ANG) % ANG;
    pSwipe.classList.toggle('on', p.phase === 'swipe' || (p.phase === 'tap2' && !p.ball && !colVisible(Math.round(p.angle) & (ANG - 1), 4)));
    if (p.ball) { p.ball.t += dt; if (p.ball.t >= FLIGHT / STEP_HZ) pracLand(); return; }
    if (p.phase === 'after1' && p.pt > 1.3) { p.phase = 'swipe'; p.pt = 0; p.input = true; p.swiped = 0; pracCaption('Swipe sideways to turn the tower'); }
    else if (p.phase === 'swipe' && p.swiped > COL_ANG * 2.5) {
      p.phase = 'tap2'; p.pt = 0; p.target = { c: 4, r: 1 };
      pracCaption('Find the big red chunk and tap it!');
    } else if (p.phase === 'after2' && p.pt > 1.2) {
      p.phase = 'combo'; p.pt = 0;
      pracCaption('Chunks of 5 or more in a row build a COMBO: x2, x3, x4');
    } else if (p.phase === 'combo' && p.pt > 2.6) {
      p.phase = 'smash'; p.pt = 0;
      pracCaption('Clear the whole tower to bank its points');
      later(0.9, function () {
        if (mode !== 'prac' || !prac) return;
        crumbleAll(1.3); Snd.boom(); Snd.fanfare(); V.shake = 0.7; V.punch = 1; raysLife = 1.4; flashScreen();
        V.capFly = { vy: 12, vx: rand(-2, 2), spin: rand(-6, 6), rot: 0 };
        for (var i = 0; i < prac.grid.length; i++) prac.grid[i] = EMPTY;
        banner('SMASHED!', 'big', '', '', 1200);
        burstConfetti(100, VW / 2, VH * 0.3, 0.9);
      });
    } else if (p.phase === 'smash' && p.pt > 3.2) pracReady();
  }
  function pracReady() {
    if (!prac || prac.phase === 'ready') return;
    prac.phase = 'ready'; prac.target = null; prac.ball = null; prac.input = false;
    pracCaption(''); pSkip.hidden = true; pSwipe.classList.remove('on');
    show(pReady);
    Snd.ui(3);
  }
  function leavePractice() {
    prac = null; pSkip.hidden = true; pracCaption('');
    pHand.classList.remove('on'); pSwipe.classList.remove('on');
    hide(pReady);
  }
  pSkip.addEventListener('click', function () { Snd.init(); Snd.ui(1); pracReady(); });
  $('pplayBtn').addEventListener('click', function () { leavePractice(); startGame(); });

  function placeHand() {
    var t = prac && prac.target;
    var on = !!(t && mode === 'prac' && !prac.ball && V.cols[t.c] && V.cols[t.c][t.r] && colVisible(Math.round(V.angle) & (ANG - 1), t.c));
    if (on) { blockPos(t.c, 0, V.angle, vB); on = vB.z > 0.4; }
    pHand.classList.toggle('on', on);
    if (!on) return;
    blockFace(t.c, t.r, vB);
    var sp = toScreen(vB.x, vB.y, vB.z);
    pHand.style.transform = 'translate(' + sp.x + 'px,' + sp.y + 'px) scale(' + UI + ')';
  }

  // ================================================================== the loop
  function frameLoop(now) {
    requestAnimationFrame(frameLoop);
    var dt = lastT == null ? STEP : Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    var t0 = performance.now();
    adaptQuality(dt);
    if (mode === 'play') {
      acc += dt * qaSpeed;
      var n = 0;
      while (acc >= STEP && n < 4 * qaSpeed) {
        V.prevAngle = sim.angle;
        applyInputs();
        var ev = stepSim(sim);
        n++; acc -= STEP;
        if (ev) handleEvent(ev);
        if (sim.phase === 'over') { endRun(); break; }
        if (autoPlay) autoPilot();
      }
      if (n >= 4 * qaSpeed) acc = 0;
    } else if (mode !== 'prac') { pendingTurn = 0; pendingFlick = null; }
    var alpha = mode === 'play' ? acc / STEP : 1;
    if (mode === 'prac' && prac) {
      pracUpdate(dt);
      V.angle = prac.angle;
    } else if (sim && (mode === 'play' || mode === 'ready' || mode === 'timeup')) {
      var d = ((sim.angle - V.prevAngle + ANG / 2) & (ANG - 1)) - ANG / 2;
      V.angle = V.prevAngle + d * alpha;
    } else {
      V.angle += dt * 700;
    }
    update(dt, alpha);
    var t1 = performance.now();
    renderer.render(scene, camera);
    perf.upd = (perf.upd || 0) + (t1 - t0);
    placeHand();
    drawFx(dt);
    if (perfOn || window.__mtPerf) {
      var ms = performance.now() - t0;
      perf.n++; perf.sum += ms; perf.max = Math.max(perf.max, ms);
    }
  }

  // Cheap phones: if frames stay slow for two seconds, render fewer pixels.
  // Cosmetic only: the picture gets softer, nothing about play changes.
  var slowT = 0, frameAvg = 1 / 60;
  function adaptQuality(dt) {
    frameAvg += (dt - frameAvg) * 0.05;
    if (frameAvg > 1 / 40 && DPR > 1) { slowT += dt; if (slowT > 2) { DPR = Math.max(1, DPR - 0.5); renderer.setPixelRatio(DPR); resize(); slowT = 0; frameAvg = 1 / 60; } }
    else slowT = 0;
  }

  var dummy = new THREE.Object3D(), tmpC = new THREE.Color(), white = new THREE.Color('#ffffff');
  var colCache = {};
  function colObj(hex) { return colCache[hex] || (colCache[hex] = new THREE.Color(hex)); }

  function update(dtReal, alpha) {
    // Effects can run in slow motion for a moment (the smash); the sim never does.
    V.slow = Math.max(0, V.slow - dtReal);
    var dt = dtReal * (V.slow > 0 ? 0.35 + 0.65 * (1 - V.slow / 0.6) : 1);
    timeAcc += dtReal;
    for (var ti = V.timers.length - 1; ti >= 0; ti--) {
      var tm = V.timers[ti]; tm.t -= dtReal;
      if (tm.t <= 0) { V.timers.splice(ti, 1); tm.fn(); }
    }
    if (resyncSoon > 0) { resyncSoon -= dtReal; if (resyncSoon <= 0 && sim && mode === 'play') resyncVis(); }
    resyncEvery -= dtReal;
    if (resyncEvery <= 0) { resyncEvery = 1; if (sim && sim.phase === 'play' && mode === 'play') resyncVis(); }

    var w = world();
    var th = topHeight(w.grid);
    // Camera: framed on the tower in world units, eased as it shrinks.
    var menuView = mode === 'menu';
    var targetH = menuView ? 30 : mode === 'prac' ? 9 : Math.max(th, 6);
    V.camH += (targetH - V.camH) * Math.min(1, dtReal * 2.2);
    var yTop = V.camH * BH + 2.6, yBot = GROUND_Y - 0.4;
    var half = (yTop - yBot) / 2 / 0.8;
    var cy = (yTop + yBot) / 2 - 0.3;
    if (menuView) cy -= half * 0.12;
    var dist = half / Math.tan(BASE_FOV * Math.PI / 360) + R;
    V.shake *= Math.pow(0.004, dtReal);
    V.punch *= Math.pow(0.02, dtReal);
    var sx = V.shake ? (Math.random() - 0.5) * V.shake * 0.6 : 0, sy = V.shake ? (Math.random() - 0.5) * V.shake * 0.6 : 0;
    var sway = Math.sin(timeAcc * 0.35) * 0.35;
    camera.position.set(sx + sway, cy + dist * 0.24 + sy, dist);
    camera.lookAt(sx * 0.5, cy + sy * 0.5, 0);
    camera.fov = baseFov * (1 - 0.035 * V.punch);
    camera.updateProjectionMatrix();

    // Blocks.
    var pulse = 0.5 + 0.5 * Math.sin(timeAcc * 9);
    var hlSet = null;
    var hlCells = V.ball ? V.ball.cells : V.preview ? V.preview : (prac && prac.target && mode === 'prac' && !prac.ball) ? hitCells(prac.grid, prac.target.c, prac.target.r) : null;
    if (hlCells) { hlSet = {}; for (var hi = 0; hi < hlCells.length; hi++) hlSet[hlCells[hi]] = 1; }
    var nC = 0, nS = 0, nB = 0;
    var pmC = pickMap.colour, pmS = pickMap.steel, pmB = pickMap.bomb;
    var canPick = mode === 'play' || mode === 'prac';
    var ia = Math.round(V.angle) & (ANG - 1);
    for (var c = 0; c < COLS; c++) {
      var col = V.cols[c];
      if (!col) continue;
      // Blocks that have finished their ripple burst and leave; the rest fall.
      for (var rr0 = col.length - 1; rr0 >= 0; rr0--) {
        var bd = col[rr0];
        if (bd.die && timeAcc >= bd.die) { burstBlock(c, bd); col.splice(rr0, 1); }
      }
      var thc = colTheta(c, V.angle), sn = Math.sin(thc), cs = Math.cos(thc);
      var tappable = canPick && colVisible(ia, c);
      for (var r = 0; r < col.length; r++) {
        var b = col[r], ty = BH * (r + 0.5);
        b.vy -= 42 * dt; b.y += b.vy * dt;
        if (b.y <= ty) {
          if (b.vy < -4) { b.sq = 1 - Math.min(0.24, -b.vy * 0.013); if (mode !== 'menu') Snd.knock(-b.vy); }
          b.y = ty; b.vy = b.vy < -4 ? -b.vy * 0.22 : 0;
        }
        b.sq += (1 - b.sq) * Math.min(1, dt * 12);
        b.flash = Math.max(0, b.flash - dt * 3);
        var lit = hlSet && hlSet[c * ML + r];
        var grow = b.die ? 1 + 0.2 * clamp(1 - (b.die - timeAcc) / 0.5, 0, 1) : lit ? 1.04 + 0.03 * pulse : 1;
        dummy.position.set(sn * R, b.y, cs * R);
        dummy.rotation.set(0, thc, 0);
        dummy.scale.set((1 + (1 - b.sq) * 0.5) * grow, b.sq * grow, (1 + (1 - b.sq) * 0.5) * grow);
        dummy.updateMatrix();
        var cell = tappable && !b.die ? c * ML + r : null;
        if (b.t === STEEL) { pmS[nS] = cell; mSteel.setMatrixAt(nS++, dummy.matrix); }
        else if (b.t === BOMB) { pmB[nB] = cell; mBomb.setMatrixAt(nB++, dummy.matrix); }
        else {
          tmpC.copy(colObj(PAL[b.t]));
          if (lit) tmpC.lerp(white, 0.16 + 0.2 * pulse);
          if (b.die) tmpC.lerp(white, 0.55);
          if (b.flash) tmpC.lerp(white, b.flash * 0.8);
          mColour.setColorAt(nC, tmpC);
          pmC[nC] = cell;
          mColour.setMatrixAt(nC++, dummy.matrix);
        }
      }
    }
    mColour.count = nC; mSteel.count = nS; mBomb.count = nB;
    mColour.instanceMatrix.needsUpdate = true; if (mColour.instanceColor) mColour.instanceColor.needsUpdate = true;
    mSteel.instanceMatrix.needsUpdate = true; mBomb.instanceMatrix.needsUpdate = true;
    mColour.computeBoundingSphere(); mSteel.computeBoundingSphere(); mBomb.computeBoundingSphere();
    bombMat.emissiveIntensity = 0.15 + 0.35 * pulse;
    topSlab.rotation.y = V.angle / ANG * TAU;

    // Cap: rides the tallest column with a spring, or flies off.
    var capTarget = 0;
    for (var cc = 0; cc < COLS; cc++) if (V.cols[cc] && V.cols[cc].length) capTarget = Math.max(capTarget, V.cols[cc][V.cols[cc].length - 1].y + BH / 2);
    if (V.capFly) {
      var f = V.capFly;
      if (f.sink) { V.capY -= dt * 2.5; cap.scale.setScalar(Math.max(0.01, cap.scale.x - dt * 0.5)); }
      else { f.vy -= 22 * dt; V.capY += f.vy * dt; cap.position.x += f.vx * dt; f.rot += f.spin * dt; cap.rotation.z = f.rot * 0.3; }
      cap.visible = V.capY > GROUND_Y - 4;
    } else {
      cap.visible = true; cap.position.x = 0; cap.rotation.z = 0; cap.scale.setScalar(CAP_S);
      V.capVY -= 40 * dt; V.capY += V.capVY * dt;
      if (V.capY <= capTarget) { if (V.capVY < -5) V.capVY = -V.capVY * 0.25; else V.capVY = 0; V.capY = capTarget; }
    }
    cap.position.y = V.capY;
    cap.rotation.y = V.angle / ANG * TAU;

    // Cannon: aims at the lit chunk (or the ball's target), recoils on fire.
    var aimC = null, aimR = 0;
    if (V.ball) { aimC = V.ball.c; aimR = V.ball.r; }
    else if (hlCells && hlCells.length) { aimC = (hlCells[0] / ML) | 0; aimR = hlCells[0] - aimC * ML; }
    var yaw = 0, pitch = 0.18;
    if (aimC != null) {
      blockFace(aimC, aimR, vA);
      var dx = vA.x - cannon.position.x, dz = vA.z - cannon.position.z, dy = vA.y - (GROUND_Y + 0.95);
      yaw = Math.atan2(dx, -dz); pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
    }
    V.aimYaw += (yaw - V.aimYaw) * Math.min(1, dtReal * 10);
    V.aimPitch += (pitch - V.aimPitch) * Math.min(1, dtReal * 10);
    V.recoil *= Math.pow(0.0015, dtReal);
    barrelPivot.rotation.set(V.aimPitch, -V.aimYaw, 0, 'YXZ');
    barrel.position.z = V.recoil * 0.45;
    cannon.visible = cannonShadow.visible = mode !== 'menu';
    var hasBall = (mode === 'play' && sim && sim.phase === 'play' && !sim.ball && sim.balls > 0) || (mode === 'prac' && prac && prac.input && !prac.ball);
    loaded.visible = hasBall && cannon.visible;
    if (loaded.visible) { loaded.position.copy(launchPoint()); loaded.scale.setScalar(Math.min(1, loaded.scale.x + dtReal * 6)); } else loaded.scale.setScalar(0.01);

    // Ball in flight: it homes on the block it was fired at, with a glowing trail.
    if (V.ball) {
      var u;
      if (mode === 'prac' && prac && prac.ball) u = clamp(prac.ball.t / (FLIGHT / STEP_HZ), 0, 1);
      else if (sim && sim.ball) u = clamp((sim.step + alpha - V.ball.fireStep) / FLIGHT, 0, 1);
      else u = 1;
      blockFace(V.ball.c, V.ball.r, vA);
      var f0 = V.ball.from;
      ballMesh.visible = true; ballMesh.scale.setScalar(1);
      ballMesh.position.set(f0.x + (vA.x - f0.x) * u, f0.y + (vA.y - f0.y) * u + Math.sin(u * Math.PI) * 1.4, f0.z + (vA.z - f0.z) * u);
      ballMesh.rotation.x -= dtReal * 20;
      trailHist.unshift(ballMesh.position.clone()); if (trailHist.length > trail.length) trailHist.pop();
    } else if (V.afterBall) {
      var ab = V.afterBall;
      ab.life += dt; ab.v.y -= 22 * dt; ab.p.addScaledVector(ab.v, dt);
      if (ab.p.y < GROUND_Y + 0.34) { ab.p.y = GROUND_Y + 0.34; ab.v.y = Math.abs(ab.v.y) * 0.45; ab.v.x *= 0.8; ab.v.z *= 0.8; }
      ballMesh.visible = ab.life < 1.4;
      ballMesh.scale.setScalar(ab.life > 1.1 ? Math.max(0.01, (1.4 - ab.life) / 0.3) : 1);
      ballMesh.position.copy(ab.p);
      if (trailHist.length) trailHist.pop();
      if (ab.life > 1.4) { V.afterBall = null; ballMesh.scale.setScalar(1); }
    } else { ballMesh.visible = false; trailHist.length = 0; }
    for (var tk = 0; tk < trail.length; tk++) {
      var tsp = trail[tk], hp = trailHist[tk];
      tsp.visible = !!hp;
      if (hp) { tsp.position.copy(hp); tsp.material.opacity = 0.45 * (1 - tk / trail.length); tsp.scale.setScalar(0.75 * (1 - tk / trail.length * 0.6)); }
    }

    // Debris, sparks, dust, glows, rings, rays, sky.
    var nd = 0;
    for (var i = debris.length - 1; i >= 0; i--) {
      var p = debris[i];
      p.life += dt;
      if (p.life > p.max) { debris.splice(i, 1); continue; }
      p.v.y -= 24 * dt;
      p.p.addScaledVector(p.v, dt);
      var floor = (p.p.x * p.p.x + p.p.z * p.p.z < 2.25 * 2.25) ? 0.14 : GROUND_Y + 0.14;
      if (p.p.y < floor && p.v.y < 0) { p.p.y = floor; p.v.y *= -0.4; p.v.x *= 0.7; p.v.z *= 0.7; p.w.multiplyScalar(0.6); }
      p.r.x += p.w.x * dt; p.r.y += p.w.y * dt; p.r.z += p.w.z * dt;
    }
    for (var j = 0; j < debris.length; j++) {
      var q = debris[j], sc = q.s * Math.min(1, (q.max - q.life) / 0.35);
      dummy.position.copy(q.p); dummy.rotation.copy(q.r); dummy.scale.setScalar(sc); dummy.updateMatrix();
      mDeb.setMatrixAt(nd, dummy.matrix); mDeb.setColorAt(nd, q.c); nd++;
    }
    mDeb.count = nd; mDeb.instanceMatrix.needsUpdate = true; if (mDeb.instanceColor) mDeb.instanceColor.needsUpdate = true;
    for (var si = sparks.length - 1; si >= 0; si--) {
      var spk = sparks[si]; spk.life += dt;
      if (spk.life > spk.max) { sparks.splice(si, 1); continue; }
      spk.v.y -= 16 * dt; spk.v.multiplyScalar(Math.pow(0.25, dt)); spk.p.addScaledVector(spk.v, dt);
    }
    for (var sj = 0; sj < SPK; sj++) {
      var sk = sparks[sj];
      if (sk) {
        var fade = 1 - sk.life / sk.max;
        spkPos[sj * 3] = sk.p.x; spkPos[sj * 3 + 1] = sk.p.y; spkPos[sj * 3 + 2] = sk.p.z;
        spkCol[sj * 3] = sk.c.r * fade; spkCol[sj * 3 + 1] = sk.c.g * fade; spkCol[sj * 3 + 2] = sk.c.b * fade;
      } else { spkPos[sj * 3 + 1] = -999; }
    }
    spkGeo.attributes.position.needsUpdate = true; spkGeo.attributes.color.needsUpdate = true;
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
    for (var gk = 0; gk < glows.length; gk++) {
      var gl = glows[gk]; if (!gl.s.visible) continue;
      gl.life += dt; var gu = gl.life / gl.max;
      if (gu >= 1) { gl.s.visible = false; continue; }
      gl.s.scale.setScalar(gl.size * (0.5 + gu)); gl.s.material.opacity = 1 - gu;
    }
    for (var rk = 0; rk < rings.length; rk++) {
      var rg = rings[rk]; if (!rg.m.visible) continue;
      rg.life += dt; var ru = rg.life / rg.max;
      if (ru >= 1) { rg.m.visible = false; continue; }
      rg.m.scale.setScalar(rg.size * (0.2 + 0.8 * Math.sqrt(ru))); rg.m.material.opacity = 0.9 * (1 - ru);
    }
    raysLife = Math.max(0, raysLife - dtReal);
    rays.material.opacity = raysLife > 0 ? Math.min(1, raysLife) * 0.8 : 0;
    rays.position.set(0, Math.max(3, V.camH * BH * 0.55), -3);
    rays.material.rotation += dtReal * 0.6;
    rays.scale.setScalar(16 + (1.6 - raysLife) * 8);
    for (var ck = 0; ck < clouds.length; ck++) { clouds[ck].position.x += clouds[ck].userData.v * dtReal; if (clouds[ck].position.x > 120) clouds[ck].position.x = -120; }
    for (var kk2 = 0; kk2 < kites.length; kk2++) {
      var kt = kites[kk2], ud = kt.userData, tt = timeAcc + ud.ph;
      kt.position.set(ud.base.x + Math.sin(tt * 0.4) * 4, ud.base.y + Math.sin(tt * 0.9) * 1.6, ud.base.z);
      kt.rotation.z = Math.sin(tt * 1.3) * 0.35;
      var tp = ud.tail.attributes.position;
      for (var tq = 0; tq < tp.count; tq++) tp.setX(tq, Math.sin(tt * 3 - tq * 0.6) * 0.18 * tq);
      tp.needsUpdate = true;
    }

    updateHud(dtReal);
  }

  // QA only: a pilot that turns to the biggest chunk and fires.
  function autoPilot() {
    if (!sim || sim.phase !== 'play' || sim.ball || sim.balls <= 0) return;
    if (sim.step - (V.lastAuto || 0) < 40) return;
    var bestM = null;
    for (var c = 0; c < COLS; c++) {
      for (var r = 0; r < colHeight(sim.grid, c); r++) {
        if (sim.grid[c * ML + r] === STEEL) continue;
        var n = hitCells(sim.grid, c, r).length;
        if (!bestM || n > bestM.n) bestM = { c: c, r: r, n: n };
      }
    }
    if (!bestM) return;
    var front = (ANG - bestM.c * COL_ANG) & (ANG - 1);
    var d = ((front - sim.angle + ANG / 2) & (ANG - 1)) - ANG / 2;
    while (d) { var k = clamp(d, -MAX_TURN, MAX_TURN); turn(sim, k); d -= k; }
    V.lastAuto = sim.step;
    fireAt(bestM.c, bestM.r);
  }

  // ================================================================== screens
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
    Snd.init(); Snd.ui(2);
    hide(menu); hide(over);
    sim = initSim(seedForRun());
    var qaTower = /[?&]tower=(\d+)/.exec(QS);   // QA only: start on a later tower
    if (qaTower) startTower(sim, +qaTower[1]);
    window.__mtSeed = sim.seed;
    V.prevAngle = V.angle = sim.angle;
    buildVis(sim.grid, true);
    debris.length = 0; dust.length = 0; sparks.length = 0; V.ball = null; V.afterBall = null; V.timers = []; V.preview = null; V.lastMult = 1;
    shownScore = 0; pendShown = -1; lastSec = -1; lastBalls = -1; lastCombo = 0;
    hCombo.classList.remove('on', 'x3', 'x4'); hPend.classList.remove('lost');
    hud.classList.remove('is-hidden');
    mode = 'ready';
    Snd.drop();
    later(0.4, function () { banner('READY', '', sim.balls + ' balls for this tower', '', 750); Snd.ui(0); });
    later(1.3, function () { banner('GO!', 'big', '', '', 500); Snd.ui(4); mode = 'play'; acc = 0; });
  }

  function endRun() {
    mode = 'timeup';
    hClock.classList.remove('hot');
    if (sim.step < RUN_STEPS) {
      // The cannon is empty: let the last hit land, then the tower crumbles.
      later(0.6, function () { Snd.lose(); banner('OUT OF BALLS', 'grey', 'game over', 'red', 1500); });
      later(1.5, function () { Snd.rumble(); crumbleAll(0.55); V.capFly = { vy: 2, vx: 0, spin: 0.5, rot: 0, sink: true }; });
      later(2.4, function () { Snd.gong(); });
      later(3.2, showOver);
      return;
    }
    V.ball = null;
    Snd.gong();
    banner('TIME!', 'big', '', '', 1300);
    later(1.7, showOver);
  }

  function showOver() {
    mode = 'over';
    var score = sim.score, prev = best(), isNew = score > prev;
    if (isNew) lsSet('minar-tod-best', String(score));
    var stats = [['stTowers', sim.cleared], ['stChunk', sim.best], ['stCombo', 'x' + Math.max(1, sim.bestCombo)], ['stBlocks', sim.broken]];
    var ovScore = $('ovScore'), ovBest = $('ovBest');
    ovScore.textContent = '0';
    ovBest.className = 'ov-best'; ovBest.textContent = 'BEST ' + fmt(Math.max(prev, score));
    ovBest.style.visibility = 'hidden';
    var statEls = over.querySelectorAll('.stat');
    for (var i = 0; i < statEls.length; i++) statEls[i].classList.remove('in');
    stats.forEach(function (s) { $(s[0]).textContent = s[1]; });
    show(over);
    hud.classList.add('is-hidden');
    var t0 = performance.now(), dur = 1400, lastTick = 0;
    (function count() {
      var k = Math.min(1, (performance.now() - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      ovScore.textContent = fmt(score * e);
      var tk = Math.floor(k * 20); if (tk !== lastTick && k < 1) { lastTick = tk; Snd.count(tk); }
      if (k < 1) requestAnimationFrame(count);
      else {
        for (var j = 0; j < statEls.length; j++) (function (el, d) { setTimeout(function () { el.classList.add('in'); Snd.ui(d); }, d * 120); })(statEls[j], j);
        setTimeout(function () {
          ovBest.style.visibility = 'visible';
          if (isNew && score > 0) { ovBest.className = 'ov-best new'; ovBest.textContent = 'NEW BEST!'; Snd.fanfare(); burstConfetti(170, VW / 2, VH * 0.3, 1.1); }
        }, 560);
      }
    })();
  }

  // The practice shows on the first two launches, and any time from HOW TO PLAY.
  var noTut = /[?&]tut=0/.test(QS);
  $('playBtn').addEventListener('click', function () {
    Snd.init(); Snd.ui(2);
    if (!noTut && tutSeen() < 2) { startPractice(); return; }
    startGame();
  });
  $('howBtn').addEventListener('click', function () { Snd.init(); Snd.ui(1); startPractice(); });
  $('againBtn').addEventListener('click', function () { startGame(); });
  $('homeBtn').addEventListener('click', function () { Snd.init(); Snd.ui(1); toMenu(); });
  var muteBtn = $('muteBtn');
  muteBtn.classList.toggle('off', Snd.isMuted());
  muteBtn.addEventListener('click', function () { Snd.init(); Snd.setMuted(!Snd.isMuted()); muteBtn.classList.toggle('off', Snd.isMuted()); if (!Snd.isMuted()) Snd.ui(2); });
  document.addEventListener('pointerdown', function () { Snd.init(); }, { passive: true });

  // ================================================================== the logo
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
    var cols = ['#f0364d', '#ffb200', '#1fbf6e', '#3a6dff', '#a54cf2', '#ff7a1a'];
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 3; g.beginPath(); g.moveTo(20, 18); g.quadraticCurveTo(w / 2, 52, w - 20, 18); g.stroke();
    for (var i = 0; i < 13; i++) {
      var t = (i + 0.5) / 13, x = 20 + (w - 40) * t, y = 18 + 68 * t * (1 - t);
      g.fillStyle = cols[i % cols.length]; g.beginPath(); g.moveTo(x - 21, y); g.lineTo(x + 21, y); g.lineTo(x, y + 36); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(x, y + 10, 4, 0, TAU); g.fill();
    }
    function word(s, y, size, rot) {
      g.save(); g.translate(w / 2, y); g.rotate(rot);
      g.font = size + 'px "Titan One", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.fillStyle = '#3a0f2a'; g.fillText(s, 0, size * 0.1);
      g.lineWidth = size * 0.22; g.strokeStyle = '#3a0f2a'; g.strokeText(s, 0, 0);
      g.lineWidth = size * 0.09; g.strokeStyle = '#ffffff'; g.strokeText(s, 0, 0);
      var gr = g.createLinearGradient(0, -size / 2, 0, size / 2); gr.addColorStop(0, '#fff6b8'); gr.addColorStop(0.5, '#ffc23a'); gr.addColorStop(1, '#ff7a1a');
      g.fillStyle = gr; g.fillText(s, 0, 0);
      g.restore();
    }
    word('MINAR', 158, 138, -0.03);
    word('TOD!', 296, 158, 0.03);
    block2d(g, 34, 318, 54, '#3a6dff'); block2d(g, 34, 262, 54, '#1fbf6e');
    g.save(); g.translate(78, 226); g.rotate(-0.5); block2d(g, -24, -24, 48, '#f0364d'); g.restore();
    block2d(g, w - 92, 318, 54, '#a54cf2');
    g.save(); g.translate(w - 58, 256); g.rotate(0.45); block2d(g, -24, -24, 48, '#ffb200'); g.restore();
  }
  var fontReady = (document.fonts && document.fonts.load) ? document.fonts.load('60px "Titan One"') : Promise.resolve();
  fontReady.then(drawLogo, drawLogo);

  // QA hooks (phase 1 only): scripted play and frame timing.
  window.__mt = {
    sim: function () { return sim; }, mode: function () { return mode; }, start: startGame, practice: startPractice,
    prac: function () { return prac; }, fireAt: fireAt,
    screenOf: function (c, r) { blockFace(c, r, vB); return toScreen(vB.x, vB.y, vB.z); },
    perf: function () { var r = { frames: perf.n, avgMs: perf.n ? perf.sum / perf.n : 0, maxMs: perf.max, updMs: perf.n ? perf.upd / perf.n : 0 }; perf.n = 0; perf.sum = 0; perf.max = 0; perf.upd = 0; return r; },
  };

  toMenu();
  requestAnimationFrame(frameLoop);
})();
