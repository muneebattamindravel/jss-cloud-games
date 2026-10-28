/* Kaanch Tod sound: all synthesised with Web Audio, no files. */
(function () {
  'use strict';
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
    knock: function (v) {
      if (!throttle('kn', 50)) return;
      var t = AC.currentTime, k = Math.min(1, (v || 10) / 25);
      tone(t, 'sine', 210, 90, 0.16, 0.35 + 0.4 * k);
      noise(t, 0.07, 'bandpass', 900, 2, 0.35 + 0.3 * k);
      tone(t, 'triangle', 520, 300, 0.05, 0.15);
    },
    splash: function () {
      if (!throttle('sp', 70)) return;
      var t = AC.currentTime;
      noise(t, 0.45, 'lowpass', 1400, 0.7, 0.55, 0.01);
      noise(t + 0.02, 0.3, 'bandpass', 3000, 1, 0.25);
      tone(t, 'sine', 300, 120, 0.2, 0.3);
      for (var i = 0; i < 5; i++) tone(t + 0.08 + Math.random() * 0.3, 'sine', 900 + Math.random() * 900, 1500, 0.05, 0.06);
    },
    tinkle: function () {
      if (!throttle('tk', 60)) return;
      var t = AC.currentTime, f = 3000 + Math.random() * 3500;
      tone(t, 'sine', f, f * 0.98, 0.06 + Math.random() * 0.1, 0.04 + Math.random() * 0.05);
    },
    reload: function () {
      var t = AC.currentTime;
      tone(t, 'triangle', 700, 1400, 0.12, 0.2);
      tone(t + 0.09, 'triangle', 900, 1800, 0.12, 0.2);
    }
  };
  function sfx(name, a, b) { if (AC && SFX[name]) try { SFX[name](a, b); } catch (e) { /* audio is best effort */ } }

  window.KTAudio = { init: audioInit, play: sfx, mute: function (m) { if (master) master.gain.value = m ? 0 : 0.7; } };
})();
