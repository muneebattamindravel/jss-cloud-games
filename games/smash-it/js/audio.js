/* Smash It sound: all synthesised with Web Audio, no files. */
(function () {
  'use strict';
  // ---------------------------------------------------------------- audio
  var AC = null, master = null, verb = null, noiseBuf = null, lastPlay = {};
  function audioInit() {
    if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    AC = new C();
    master = AC.createGain(); master.gain.value = 0.7;
    var comp = AC.createDynamicsCompressor();
    master.connect(comp); comp.connect(AC.destination);
    // a small, bright room: a generated impulse response, sent at a low level
    var len = Math.floor(AC.sampleRate * 1.4), ir = AC.createBuffer(2, len, AC.sampleRate);
    for (var ch = 0; ch < 2; ch++) { var dd = ir.getChannelData(ch); for (var k = 0; k < len; k++) dd[k] = (Math.random() * 2 - 1) * Math.pow(1 - k / len, 3.2); }
    var conv = AC.createConvolver(); conv.buffer = ir;
    verb = AC.createGain(); verb.gain.value = 0.22;
    verb.connect(conv); conv.connect(comp);
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
  // struck-object synthesis: a set of decaying sine modes, optionally sent to the room
  function modes(t0, fs, ds, gs, vol, wet) {
    for (var i = 0; i < fs.length; i++) {
      var o = AC.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(fs[i], t0);
      var g = AC.createGain();
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol * gs[i], t0 + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t0 + ds[i]);
      o.connect(g); g.connect(master); if (wet && verb) g.connect(verb);
      o.start(t0); o.stop(t0 + ds[i] + 0.05);
    }
  }
  function burst(t0, dur, type, freq, q, vol, wet, sweepTo) {
    var s = AC.createBufferSource(); s.buffer = noiseBuf;
    var f = AC.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    var g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(master); if (wet && verb) g.connect(verb);
    s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + 0.05);
  }
  function sweep(t0, f0, f1, dur, vol, wet) {
    var o = AC.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    var g = AC.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master); if (wet && verb) g.connect(verb); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function rv(a, b) { return a + Math.random() * (b - a); }
  function bell(t0, f, dur, vol) { modes(t0, [f, f * 2.76, f * 5.4, f * 8.93], [dur, dur * 0.6, dur * 0.35, dur * 0.2], [1, 0.4, 0.2, 0.08], vol, true); }

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
      var t = AC.currentTime, k = log ? 0.7 : 1;
      for (var i = 0; i < 5; i++) burst(t + i * rv(0.008, 0.016), 0.02, 'bandpass', rv(2200, 3600), 3, rv(0.35, 0.6));
      modes(t, [210 * k, 520 * k, 1050 * k, 1730 * k], [0.16, 0.1, 0.06, 0.04], [1, 0.55, 0.3, 0.15], 0.55, true);
      burst(t + 0.01, 0.12, 'bandpass', 900 * k, 1.2, 0.25);
      for (i = 0; i < 9; i++) burst(t + rv(0.05, 0.35), 0.015, 'bandpass', rv(1400, 4200), 4, rv(0.08, 0.2));
    },
    woodHit: function () {
      if (!throttle('woodH', 40)) return;
      var t = AC.currentTime;
      tone(t, 'sine', 260, 110, 0.14, 0.7);
      noise(t, 0.06, 'bandpass', 1100, 2.5, 0.6);
      noise(t + 0.01, 0.1, 'lowpass', 500, 1, 0.3);
    },
    thud: function (v, kind) {
      if (!throttle('thud', 60)) return;
      var t = AC.currentTime, k = Math.min(1, v / 160);
      if (kind === 'g') { modes(t, [1450, 2900, 4300], [0.09, 0.06, 0.04], [1, 0.4, 0.2], 0.12 + 0.18 * k, false); burst(t, 0.03, 'highpass', 3000, 0.7, 0.08 + 0.1 * k); return; }
      modes(t, [rv(85, 105), rv(190, 220), rv(380, 430)], [0.16, 0.1, 0.06], [1, 0.5, 0.25], 0.3 + 0.5 * k, false);
      burst(t, 0.05, 'lowpass', 600, 0.7, 0.12 + 0.25 * k);
    },
    ballBounce: function (v) {
      if (!throttle('bb', 70)) return;
      var t = AC.currentTime, k = Math.min(1, v / 150);
      modes(t, [rv(260, 300), rv(640, 700)], [0.07, 0.04], [1, 0.35], 0.12 + 0.25 * k, false);
      burst(t, 0.015, 'bandpass', 1800, 2, 0.08 * k + 0.01);
    },
    cannon: function () {
      var t = AC.currentTime;
      sweep(t, 150, 48, 0.22, 0.75, false);
      burst(t, 0.16, 'lowpass', 1400, 0.8, 0.55, true, 300);
      burst(t, 0.05, 'bandpass', 2600, 1, 0.18);
      burst(t + 0.02, 0.35, 'bandpass', 700, 0.7, 0.12, true, 2400);
    },
    fan: function () {
      var t = AC.currentTime;
      modes(t, [520, 1340, 2210, 3170], [0.45, 0.32, 0.2, 0.14], [1, 0.6, 0.4, 0.25], 0.16, true);
      burst(t, 0.02, 'highpass', 2500, 0.7, 0.2);
      modes(t, [140, 300], [0.12, 0.08], [1, 0.5], 0.25, false);
    },
    whoosh: function () {
      var t = AC.currentTime;
      burst(t, 0.3, 'bandpass', 600, 0.8, 0.12, false, 2000);
    },
    clear: function () {
      var t = AC.currentTime, ns = [523.25, 659.25, 783.99, 1046.5];
      for (var i = 0; i < ns.length; i++) bell(t + i * 0.09, ns[i], 1.1, 0.1);
      bell(t + 0.42, 1318.5, 1.4, 0.09);
    },
    over: function () {
      var t = AC.currentTime, ns = [659.25, 523.25, 440, 349.23];
      for (var i = 0; i < ns.length; i++) bell(t + i * 0.18, ns[i], 1.2, 0.09);
    },
    knock: function (v) {
      if (!throttle('kn', 50)) return;
      var t = AC.currentTime, k = Math.min(1, (v || 10) / 25);
      tone(t, 'sine', 210, 90, 0.16, 0.35 + 0.4 * k);
      noise(t, 0.07, 'bandpass', 900, 2, 0.35 + 0.3 * k);
      tone(t, 'triangle', 520, 300, 0.05, 0.15);
    },
    splash: function (big) {
      if (!throttle('sp', 160)) return;
      var t = AC.currentTime, v = big ? 1 : 0.55;
      burst(t, 0.28, 'bandpass', 2600, 0.9, 0.22 * v, true, 700);
      burst(t, 0.06, 'lowpass', 500, 0.7, 0.25 * v);
      for (var i = 0; i < 4; i++) sweep(t + rv(0.05, 0.3), rv(450, 700), rv(1100, 1700), 0.06, 0.06 * v, true);
    },
    boom: function () {
      var t = AC.currentTime;
      sweep(t, 90, 30, 0.9, 1.0, false);
      burst(t, 1.3, 'lowpass', 500, 0.6, 0.9, true, 120);
      burst(t, 0.25, 'lowpass', 3000, 0.6, 0.5, true, 600);
      for (var i = 0; i < 10; i++) burst(t + rv(0.08, 0.7), 0.02, 'bandpass', rv(800, 2600), 3, rv(0.08, 0.2));
    },
    tinkle: function () {
      if (!throttle('tk', 60)) return;
      var t = AC.currentTime, f = 3000 + Math.random() * 3500;
      tone(t, 'sine', f, f * 0.98, 0.06 + Math.random() * 0.1, 0.04 + Math.random() * 0.05);
    },
    reload: function () {
      var t = AC.currentTime;
      modes(t, [900, 2100], [0.05, 0.03], [1, 0.4], 0.15, false);
      modes(t + 0.09, [1100, 2500], [0.05, 0.03], [1, 0.4], 0.15, false);
      bell(t + 0.18, 1567.98, 0.7, 0.1);
    },
    _end: function () {}
  };
  function sfx(name, a, b) { if (AC && SFX[name]) try { SFX[name](a, b); } catch (e) { /* audio is best effort */ } }

  window.KTAudio = { init: audioInit, play: sfx, mute: function (m) { if (master) master.gain.value = m ? 0 : 0.7; } };
})();
