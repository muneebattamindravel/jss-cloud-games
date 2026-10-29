/* Smash It sound: all synthesised with Web Audio, no files. */
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
    },
    groundGlass: function () {
      // a jar landing on grass: a soft, short crunch, well under the main smash
      if (!throttle('gg', 90)) return;
      var t = AC.currentTime;
      noise(t, 0.12, 'bandpass', 3200, 0.9, 0.12);
      noise(t, 0.06, 'lowpass', 900, 0.7, 0.1);
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
    splash: function (big) {
      // a soft water "plop": a bubble tone that drops in pitch, a hushed wash, a few droplets
      if (!throttle('sp', 140)) return;
      var t = AC.currentTime, v = big ? 1 : 0.6;
      tone(t, 'sine', 520 + Math.random() * 120, 180, 0.12, 0.22 * v);
      tone(t + 0.03, 'sine', 900 + Math.random() * 200, 420, 0.08, 0.08 * v);
      noise(t + 0.01, 0.32, 'lowpass', 900, 0.5, 0.12 * v, 0.03);
      for (var i = 0; i < 3; i++) { var f = 1100 + Math.random() * 900; tone(t + 0.12 + Math.random() * 0.25, 'sine', f, f * 1.35, 0.05, 0.035 * v); }
    },
    boom: function () {
      var t = AC.currentTime;
      noise(t, 1.2, 'lowpass', 600, 0.7, 1.0, 0.005);
      noise(t, 0.5, 'lowpass', 2400, 0.6, 0.6, 0.002);
      tone(t, 'sine', 90, 28, 0.9, 1.0);
      tone(t, 'triangle', 160, 40, 0.4, 0.5);
      for (var i = 0; i < 6; i++) noise(t + 0.1 + Math.random() * 0.5, 0.08, 'bandpass', 600 + Math.random() * 1200, 2, 0.25);
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
