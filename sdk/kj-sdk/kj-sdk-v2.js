/**
 * KJ Platform SDK v2 — anti-cheat hardened.
 *
 * Replaces the 3-call v1 surface (kjInit / kjSubmitScore / kjEnd) with a
 * signed-event protocol. Games still call a small API:
 *
 *   await window.kjStartV2({ gameId, deviceFingerprint? })
 *   window.kjEmit(type, payload)         // every input event, score tick, etc.
 *   await window.kjSubmitV2({ clientClaimedScore })
 *
 * Every kjEmit / kjSubmitV2 call is wrapped in a signed envelope:
 *   { sessionId, type, seq, payload, ts, hmac }
 * Sent via WebSocket if connected; falls back to HTTP POST otherwise.
 *
 * Session secret is stored in sessionStorage ONLY (cleared on tab close).
 * Phase 1A: clientClaimedScore is advisory — the server still trusts it
 * subject to per-game ceilings. Phase 1B: server validators replace it.
 */
(function (window) {
  'use strict';

  // ── module state ───────────────────────────────────────────────────
  const SS_KEY = '_kj_v2_session';

  // Tracks every in-flight HTTP POST started by kjEmit so kjSubmitV2
  // can await them before sending the submit. Prevents the well-known
  // race where the last input event's POST is still on the wire when
  // /session/submit lands at the server → validator scores one event
  // short of the player's actual final score. Bounded — entries delete
  // themselves on resolve/reject.
  const _inflight = new Set();

  let _state = {
    preSession: [],   // emits before the session exists — see kjEmit
    lastSubmitResult: null,   // the server's answer once a submit settled — see _settled
    sessionId: null,
    sessionSecret: null,
    seed: null,
    gameId: null,
    seq: 0,
    hbSeq: 0,        // heartbeat envelope counter (separate from trace seq)
    hbTimer: null,   // presence heartbeat interval handle
    hbFailed: false, // last heartbeat was refused
    sessionLost: false, // the server has told us this session is gone
    seedRead: false, // the game has consumed __kjSeed, so its world exists
    owned: false,    // this frame minted the session (vs restored someone else's)
    ws: null,
    wsReady: false,
    eventLog: [],            // accumulator for the replay trace
    apiBase: _apiBaseFromUrl(),
  };

  /**
   * Where the API lives, read from the iframe URL at PARSE TIME.
   *
   * ⚠ This used to arrive only by postMessage (KJ_V2_API_BASE), sent by the
   * launcher in reply to KJ_GAME_LOADED, and the default until then was ''
   * (same-origin). postMessage is asynchronous and ten of the twelve games
   * call kjStartV2 SYNCHRONOUSLY at parse time when the player has already
   * seen the tutorial — so the two raced, and the only thing standing between
   * them was the device-fingerprint await inside kjStartV2.
   *
   * When the game won that race, /api/game/session/start went to the WEB
   * origin instead of the API one, hit Amplify's SPA rewrite, and came back
   * 200 OK with index.html. The session was never created, the player was let
   * through to play a full run that could never count, and the panel at the
   * end told them to check their internet.
   *
   * On the URL for exactly the reason `?rot=` is (see CLAUDE.md): anything a
   * game needs BEFORE the handshake lands cannot travel in the handshake.
   * KJ_V2_API_BASE still overrides this, so a host that cannot set the query
   * string keeps working.
   *
   * The auth token deliberately does NOT ride here. A URL leaks into
   * referrers, analytics and logs; the token is read per request from the
   * parent's storage instead.
   */
  // Red Team Lab: `?lab=1&intent=bot|hand` on the iframe URL, read at parse
  // time for the same reason `?api` is. The server decides whether the account
  // may run a lab session; this only says what the tester asked for.
  function _labFromUrl() {
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('lab') !== '1') return null;
      const intent = q.get('intent');
      return intent === 'bot' || intent === 'hand' ? { lab: true, intent } : { lab: true };
    } catch (_e) { return null; }
  }

  // PLAY TEST: `?playtest=1` on the iframe URL, read at parse time. The
  // owners' play-test page (/playtest) opens games this way to try them and
  // NOTHING reaches the server: no session, no events, no heartbeat, no
  // submit, so no leaderboard, no anti-cheat and no free play used. The seed
  // is made up locally. It grants nothing: a run here is worth nothing, the
  // same as opening a game's standalone link.
  function _playtestFromUrl() {
    try { return new URLSearchParams(location.search).get('playtest') === '1'; }
    catch (_e) { return false; }
  }
  // PLAY TEST, FULL PIPELINE: `?pt=1` on the iframe URL. The owners'
  // /playtest page opens games this way, and the run behaves EXACTLY like a
  // player's: a real session, real events, a real submit, the replay parity
  // check, the anti-cheat and the bot detector. The server excludes it from
  // every board, prize, stat and free play (game_sessions.playtest, migration
  // 216) — the testing is the point, so nothing is skipped on the client.
  // This is NOT the old `?playtest=1` above, which sends nothing at all and
  // is still what the admin replay viewer rides.
  function _ptFromUrl() {
    try { return new URLSearchParams(location.search).get('pt') === '1'; }
    catch (_e) { return false; }
  }

  // REPLAY: `?replay=1` on the iframe URL, read at parse time. The admin run
  // viewer opens a game this way to play a stored run back. Like play test,
  // NOTHING reaches the server; the seed and the recorded inputs arrive from
  // the parent in a KJ_REPLAY_LOAD message (never in the URL), and the run's
  // end is posted back as KJ_REPLAY_DONE. See games/_shared/kj-replay.js.
  function _replayFromUrl() {
    try { return new URLSearchParams(location.search).get('replay') === '1'; }
    catch (_e) { return false; }
  }
  const REPLAY = _replayFromUrl();
  const PLAYTEST = _playtestFromUrl() || REPLAY;
  const PT_FULL = _ptFromUrl();
  let _replayLoad = null;
  const _replayWaiters = [];
  function _waitReplayLoad() {
    if (_replayLoad) return Promise.resolve(_replayLoad);
    return new Promise((r) => _replayWaiters.push(r));
  }
  function _localSeedHex() {
    const b = new Uint8Array(32);
    try { crypto.getRandomValues(b); }
    catch (_e) { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
    return Array.prototype.map.call(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function _apiBaseFromUrl() {
    try {
      const v = new URLSearchParams(location.search).get('api');
      if (!v) return '';
      // Same-origin ('') and an absolute https origin are the only shapes we
      // accept. Anything else is ignored rather than trusted.
      return /^https:\/\/[^\s/]+$/.test(v) ? v : '';
    } catch (_e) { return ''; }
  }

  // Persist what we can to sessionStorage so a reload doesn't kill the
  // play (the server still has the session live). We never persist to
  // localStorage — that survives tab close and is a tamper surface.
  function _persist() {
    if (PLAYTEST) return;
    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify({
        sessionId: _state.sessionId,
        sessionSecret: _state.sessionSecret,
        seed: _state.seed,
        gameId: _state.gameId,
        seq: _state.seq,
      }));
    } catch (_e) { /* private mode */ }
  }
  function _restoreFromSession() {
    if (PLAYTEST) return;
    try {
      const raw = sessionStorage.getItem(SS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      Object.assign(_state, parsed);
      // Restored, not minted here. Nothing event-driven may act on it.
      _state.owned = false;
    } catch (_e) { /* swallow */ }
  }
  function _clearPersisted() {
    try { sessionStorage.removeItem(SS_KEY); } catch (_e) { /* swallow */ }
  }

  // ── Stable JSON (mirrors shared/anticheat/sign.js exactly) ────────
  function stableStringify(value) {
    if (value === null) return 'null';
    if (value === undefined) return undefined;
    const t = typeof value;
    if (t === 'string') return JSON.stringify(value);
    if (t === 'number' || t === 'boolean') return JSON.stringify(value);
    if (t === 'bigint') return value.toString();
    if (Array.isArray(value)) {
      const parts = value.map((v) => {
        const s = stableStringify(v);
        return s === undefined ? 'null' : s;
      });
      return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
      const keys = Object.keys(value).sort();
      const parts = [];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const s = stableStringify(value[k]);
        if (s === undefined) continue;
        parts.push(JSON.stringify(k) + ':' + s);
      }
      return '{' + parts.join(',') + '}';
    }
    return undefined;
  }

  function canonicalString({ sessionId, seq, type, ts, payload }) {
    const payloadStr = (payload === undefined || payload === null)
      ? 'null'
      : (stableStringify(payload) || 'null');
    return sessionId + '|' + seq + '|' + type + '|' + ts + '|' + payloadStr;
  }

  // ── HMAC (Web Crypto preferred; fall back to pure JS) ─────────────
  async function _hmacHex(data, secretHex) {
    // secretHex is a hex string — sign over it AS A STRING (UTF-8 bytes
    // of the hex chars) to match the server, which does
    // `crypto.createHmac('sha256', sessionSecret)` where sessionSecret
    // is the hex string itself.
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.importKey) {
      try {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw', enc.encode(secretHex),
          { name: 'HMAC', hash: 'SHA-256' },
          false, ['sign'],
        );
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
        return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch (_e) {
        /* fall through */
      }
    }
    return _hmacSha256JS(data, secretHex);
  }

  // ── SHA256 + HMAC JS fallback (lifted verbatim from kj-sdk v1) ────
  function _ror(n, b) { return ((n >>> b) | (n << (32 - b))) >>> 0; }
  const _SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  function _sha256Bytes(msg) {
    const H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const len = msg.length;
    const bitLen = len * 8;
    const padLen = ((len + 9 + 63) >>> 6) << 6;
    const padded = new Uint8Array(padLen);
    padded.set(msg);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padLen - 4, bitLen >>> 0, false);
    view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
    const W = new Uint32Array(64);
    for (let chunk = 0; chunk < padLen; chunk += 64) {
      for (let i = 0; i < 16; i++) W[i] = view.getUint32(chunk + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = _ror(W[i - 15], 7) ^ _ror(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = _ror(W[i - 2], 17) ^ _ror(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = _ror(e, 6) ^ _ror(e, 11) ^ _ror(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + _SHA256_K[i] + W[i]) >>> 0;
        const S0 = _ror(a, 2) ^ _ror(a, 13) ^ _ror(a, 22);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false);
    return out;
  }
  function _hmacSha256JS(data, key) {
    const enc = new TextEncoder();
    const blockSize = 64;
    let kBytes = enc.encode(key);
    if (kBytes.length > blockSize) kBytes = _sha256Bytes(kBytes);
    if (kBytes.length < blockSize) {
      const padded = new Uint8Array(blockSize);
      padded.set(kBytes);
      kBytes = padded;
    }
    const ipad = new Uint8Array(blockSize);
    const opad = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
      ipad[i] = kBytes[i] ^ 0x36;
      opad[i] = kBytes[i] ^ 0x5c;
    }
    const dataBytes = enc.encode(data);
    const innerInput = new Uint8Array(blockSize + dataBytes.length);
    innerInput.set(ipad);
    innerInput.set(dataBytes, blockSize);
    const innerHash = _sha256Bytes(innerInput);
    const outerInput = new Uint8Array(blockSize + 32);
    outerInput.set(opad);
    outerInput.set(innerHash, blockSize);
    const outerHash = _sha256Bytes(outerInput);
    return Array.from(outerHash).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ── device fingerprint ────────────────────────────────────────────
  // ── PROVENANCE: is this device what it claims to be? ────────────────
  // Two things travel beside the trace, both readable (the hashed
  // fingerprint above answers "same device as before", this answers "is the
  // claim consistent"):
  //   device      one snapshot at session start: touch points, hover /
  //               pointer media, platform, userAgentData presence, GPU,
  //               screen, viewport, DPR.
  //   provenance  a summary of how the inputs ARRIVED: pointer types, the
  //               trusted flag, hold durations, coordinate repetition,
  //               movement before a press, keyboard use.
  // A desktop program claiming to be an iPhone contradicts itself in these
  // whatever score it plays to. Everything is best-effort: a missing field
  // is "unknown", never evidence.
  function collectDeviceClaims() {
    const d = {};
    const g = (f) => { try { return f(); } catch (_e) { return undefined; } };
    d.tp   = g(() => navigator.maxTouchPoints);
    d.plat = g(() => navigator.platform);
    d.uad  = g(() => (navigator.userAgentData ? { m: !!navigator.userAgentData.mobile, p: navigator.userAgentData.platform, b: (navigator.userAgentData.brands || []).map((b) => b.brand).slice(0, 4) } : null));
    d.hover  = g(() => (window.matchMedia('(hover: hover)').matches ? 'hover' : window.matchMedia('(hover: none)').matches ? 'none' : 'unknown'));
    d.pointer = g(() => (window.matchMedia('(pointer: fine)').matches ? 'fine' : window.matchMedia('(pointer: coarse)').matches ? 'coarse' : 'unknown'));
    d.touchEv = g(() => ('ontouchstart' in window));
    d.sw = g(() => screen.width); d.sh = g(() => screen.height); d.dpr = g(() => window.devicePixelRatio);
    d.iw = g(() => window.innerWidth); d.ih = g(() => window.innerHeight);
    d.orient = g(() => (screen.orientation && screen.orientation.type) || null);
    d.hc = g(() => navigator.hardwareConcurrency); d.mem = g(() => navigator.deviceMemory);
    d.lang = g(() => navigator.language); d.tz = g(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    d.vendor = g(() => navigator.vendor);
    d.gl = g(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? { r: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), v: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) } : { r: gl.getParameter(gl.RENDERER), v: gl.getParameter(gl.VENDOR) };
    });
    d.electron = g(() => !!(window.process && window.process.versions && window.process.versions.electron) || /Electron/i.test(navigator.userAgent));
    // Automated browsers confess: Selenium / Playwright / Puppeteer set
    // navigator.webdriver, headless Chrome names itself in its user agent.
    d.wd = g(() => navigator.webdriver === true);
    d.ua = g(() => String(navigator.userAgent).slice(0, 200));
    // ── the hardware around the page (23 Sep 2026, record-only) ──────────
    // Everything below is self-reported and each is a hint, never evidence
    // on its own; together they have to AGREE with each other and with the
    // claim. A phone has cameras, a battery that drains, a coarse pointer, a
    // small storage quota and a mobile GPU; a desktop pretending to be one
    // has to fake all of them at once.
    d.cdepth = g(() => screen.colorDepth);
    d.conn = g(() => { const c = navigator.connection; return c ? { type: c.type || null, eff: c.effectiveType || null, save: !!c.saveData } : null; });
    d.apis = g(() => ({
      webkit: !!window.webkit,                                  // iOS WKWebView / Safari bridge object
      standalone: navigator.standalone === true,                // iOS home-screen app
      chrome: !!window.chrome,                                  // Chromium
      bt: 'bluetooth' in navigator,                             // Chromium (never Safari)
      share: typeof navigator.share === 'function',
      vib: 'vibrate' in navigator,                              // Android Chrome; iOS Safari has none
      touchForce: 'ontouchforcechange' in window,               // iOS only
      motionEv: 'ondevicemotion' in window,
      orientEv: 'ondeviceorientation' in window,
      wake: 'wakeLock' in navigator,
      xr: 'xr' in navigator,
      pdf: !!(navigator.pdfViewerEnabled),
      touchEvCtor: typeof window.TouchEvent === 'function',
    }));
    // Async probes started at load (see probeDeviceAsync); whatever has
    // resolved by session start is merged here.
    if (_asyncClaims) for (const k of Object.keys(_asyncClaims)) d[k] = _asyncClaims[k];
    return d;
  }
  let _asyncClaims = null;
  function probeDeviceAsync() {
    if (typeof navigator === 'undefined') return;
    const out = {};
    const set = (k, v) => { out[k] = v; _asyncClaims = out; };
    try {
      if (typeof navigator.getBattery === 'function') {
        navigator.getBattery().then((b) => set('bat', { lvl: Math.round(b.level * 100), chg: !!b.charging })).catch(() => {});
      }
    } catch (_e) { /* ignore */ }
    try {
      // Counts only, no labels: labels need a permission prompt and we do
      // not ask. A phone reports two cameras and a microphone.
      if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
        navigator.mediaDevices.enumerateDevices().then((list) => {
          const c = { cam: 0, mic: 0, out: 0 };
          for (const dev of list || []) { if (dev.kind === 'videoinput') c.cam++; else if (dev.kind === 'audioinput') c.mic++; else if (dev.kind === 'audiooutput') c.out++; }
          set('media', c);
        }).catch(() => {});
      }
    } catch (_e) { /* ignore */ }
    try {
      if (navigator.storage && typeof navigator.storage.estimate === 'function') {
        navigator.storage.estimate().then((e) => set('storeGB', e && e.quota ? Math.round(e.quota / 1e8) / 10 : null)).catch(() => {});
      }
    } catch (_e) { /* ignore */ }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { const ac = new AC(); set('audHz', ac.sampleRate); if (typeof ac.close === 'function') ac.close().catch(() => {}); }
    } catch (_e) { /* ignore */ }
  }

  const PROV_SAMPLES = 80;   // per-press samples kept for one run
  const _prov = { n: 0, touch: 0, mouse: 0, pen: 0, other: 0, untrusted: 0, keys: 0, touchEv: 0, mouseEv: 0, holds: [], coords: new Map(), preMove: 0, downs: {}, lastMove: {},
    lastPos: {}, moves: {}, pending: {}, samples: [],
    // 23 Sep 2026, record-only: the physics of each press and of the device.
    areas: [], press: [], multi: 0, coal: [], coalN: 0 };
  const PROV_CAP = 600;
  // ── motion: the phone in the hand (23 Sep 2026, record-only) ─────────
  // A real finger tap physically JOLTS a phone: a small accelerometer spike at
  // the instant of the touch. Injected input does not move the device. Each
  // press is scored as (peak deviation in the 200 ms round the press) / (the
  // sensor's own noise in the 600 ms before it), on the device; only per-run
  // aggregates leave it. Android Chrome listens with no prompt; iOS 13+ asks
  // once, and only from a user gesture, so the request rides the release of
  // the first tap (touchend / pointerup: a finger's pointerdown does not count
  // as activation in Safari). A refusal gives us no motion data, which is
  // never held against a player.
  const _motion = { support: false, perm: 'unasked', on: false, onAt: 0, waiters: [], buf: [], n: 0, first: 0, last: 0, jolts: [], sumSq: 0, sumM: 0, base: null };
  const MOTION_BUF = 240;
  const _raf = { gaps: [], last: 0, active: false };
  const RAF_SAMPLES = 240;
  function _motionSample(e) {
    if (!e || e.isTrusted === false) return;   // a page script can dispatch these; a sensor cannot be faked that way
    const a = (e.acceleration && e.acceleration.x !== null && e.acceleration.x !== undefined) ? e.acceleration : e.accelerationIncludingGravity;
    if (!a || !Number.isFinite(a.x)) return;
    const t = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const m = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    _motion.n += 1; if (!_motion.first) _motion.first = t; _motion.last = t;
    _motion.sumM += m; _motion.sumSq += m * m;
    const b = _motion.buf; b.push([t, m]); if (b.length > MOTION_BUF) b.shift();
    if (_motion.n === 1 && _motion.waiters.length) { const w = _motion.waiters.splice(0); w.forEach((f) => f()); }
  }
  function _listenMotion() {
    if (_motion.on || typeof window === 'undefined') return;
    try { window.addEventListener('devicemotion', _motionSample, { passive: true }); _motion.on = true; _motion.onAt = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()); } catch (_e) { /* ignore */ }
  }
  function _requestMotion() {
    if (_motion.perm !== 'unasked') return;
    try {
      if (typeof DeviceMotionEvent === 'undefined') { _motion.perm = 'na'; return; }
      // iOS and macOS Safari ask the player first. We no longer ask (founder,
      // 25 Sep 2026): about 68% of iPhone players refused, a Mac has no sensor
      // to give, and an iPhone claim is already checked by its GPU and its
      // missing Client Hints. Where no prompt is needed (Android), listen.
      if (typeof DeviceMotionEvent.requestPermission === 'function') { _motion.perm = 'skipped'; return; }
      _motion.perm = 'free'; _listenMotion();
    } catch (_e) { _motion.perm = 'error'; }
  }
  // A phone's motion sensor answers within a frame or two of the listener
  // going on. Give it up to MOTION_WAIT_MS before a session start so the
  // snapshot can say whether it answered at all: a real phone waits ~20 ms,
  // an emulator with no sensor waits the full time.
  const MOTION_WAIT_MS = 1500;
  function _waitMotion() {
    if (!_motion.on || _motion.n > 0) return Promise.resolve();
    // Only an Android claim is judged on this; nothing else pays the wait.
    let android = false;
    try { android = /Android/i.test(navigator.userAgent || ''); } catch (_e) { /* ignore */ }
    if (!android) return Promise.resolve();
    const now = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const left = MOTION_WAIT_MS - (now - _motion.onAt);
    if (left <= 0) return Promise.resolve();
    return new Promise((resolve) => { _motion.waiters.push(resolve); setTimeout(resolve, left); });
  }
  function _motionClaim() {
    if (!_motion.on) return { perm: _motion.perm };
    const now = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    return { perm: _motion.perm, n: Math.min(_motion.n, 9999), ms: Math.round(now - _motion.onAt) };
  }
  function _joltFor(t0) {
    // Called ~200 ms after a press: baseline = the 600 ms before it (minus the
    // last 60 ms, which may already hold the finger's approach), peak = the
    // largest deviation from the baseline mean in [-40, +160] ms.
    const b = _motion.buf; if (b.length < 12) return;
    let n = 0, s = 0, s2 = 0;
    for (const [t, m] of b) if (t >= t0 - 600 && t < t0 - 60) { n++; s += m; s2 += m * m; }
    if (n < 6) return;
    const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    let peak = 0;
    for (const [t, m] of b) if (t >= t0 - 40 && t <= t0 + 160) peak = Math.max(peak, Math.abs(m - mean));
    if (_motion.jolts.length < PROV_CAP) _motion.jolts.push(Math.round((peak / Math.max(sd, 0.02)) * 10) / 10);
  }
  function _rafTick(t) {
    if (_raf.last) { const gap = t - _raf.last; if (gap > 0 && gap < 500 && _raf.gaps.length < RAF_SAMPLES) _raf.gaps.push(Math.round(gap * 10) / 10); }
    _raf.last = t;
    if (_raf.gaps.length < RAF_SAMPLES) window.requestAnimationFrame(_rafTick); else _raf.active = false;
  }
  function installProvenance() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    try { _motion.support = typeof DeviceMotionEvent !== 'undefined'; } catch (_e) { /* ignore */ }
    // No prompt needed outside iOS: listen from load so the baseline exists
    // before the first tap. iOS waits for the gesture below.
    try { if (_motion.support && typeof DeviceMotionEvent.requestPermission !== 'function') _requestMotion(); } catch (_e) { /* ignore */ }
    window.addEventListener('pointermove', (e) => {
      _prov.lastMove[e.pointerId] = now();
      // How the pointer TRAVELS between presses: a hand on a mouse sends many
      // small steps; a script that teleports the cursor sends one big jump.
      try {
        const p0 = _prov.lastPos[e.pointerId], mv = _prov.moves[e.pointerId] || (_prov.moves[e.pointerId] = { n: 0, max: 0 });
        if (p0) { const step = Math.hypot(e.clientX - p0.x, e.clientY - p0.y); if (step > mv.max) mv.max = step; }
        mv.n += 1; _prov.lastPos[e.pointerId] = { x: e.clientX, y: e.clientY };
      } catch (_e) { /* ignore */ }
      // A real digitiser reports many sub-frame samples between two frames;
      // injected or synthesised movement carries none.
      if (_prov.coalN < PROV_CAP) { _prov.coalN += 1; let c = 1; try { if (typeof e.getCoalescedEvents === 'function') c = e.getCoalescedEvents().length || 1; } catch (_e) { /* ignore */ } _prov.coal.push(c); }
    }, { capture: true, passive: true });
    window.addEventListener('pointerdown', (e) => {
      _prov.n += 1;
      const t = e.pointerType;
      if (t === 'touch') _prov.touch += 1; else if (t === 'mouse') _prov.mouse += 1; else if (t === 'pen') _prov.pen += 1; else _prov.other += 1;
      if (e.isTrusted === false) _prov.untrusted += 1;
      const lm = _prov.lastMove[e.pointerId];
      if (lm !== undefined && now() - lm < 400) _prov.preMove += 1;
      const t0 = now();
      _prov.downs[e.pointerId] = t0;
      // One sample per press (first PROV_SAMPLES only), finished on release:
      // [hold ms, pressure, contact area, ms since the last move, moves since
      // the last press, biggest single move step px, jump from the last move to
      // the press point px, pointer type 0 touch / 1 mouse / 2 pen / 3 other].
      if (_prov.samples.length < PROV_SAMPLES) {
        try {
          const mv = _prov.moves[e.pointerId] || { n: 0, max: 0 };
          const p0 = _prov.lastPos[e.pointerId];
          const lmT = _prov.lastMove[e.pointerId];
          const w = Number(e.width), hh = Number(e.height), pr = Number(e.pressure);
          _prov.pending[e.pointerId] = [0,
            Number.isFinite(pr) ? Math.round(pr * 1000) / 1000 : null,
            Number.isFinite(w) && Number.isFinite(hh) ? Math.round(w * hh * 10) / 10 : null,
            lmT !== undefined ? Math.round(t0 - lmT) : null,
            mv.n, Math.round(mv.max),
            p0 ? Math.round(Math.hypot(e.clientX - p0.x, e.clientY - p0.y)) : null,
            t === 'touch' ? 0 : t === 'mouse' ? 1 : t === 'pen' ? 2 : 3];
        } catch (_e) { /* ignore */ }
      }
      _prov.moves[e.pointerId] = { n: 0, max: 0 };
      try { _prov.lastPos[e.pointerId] = { x: e.clientX, y: e.clientY }; } catch (_e) { /* ignore */ }
      if (_prov.n <= PROV_CAP) {
        const k = Math.round(e.clientX) + ',' + Math.round(e.clientY); _prov.coords.set(k, (_prov.coords.get(k) || 0) + 1);
        // Contact geometry and pressure of THIS press. A finger's contact
        // area varies press to press; a cheap digitiser reports a constant;
        // injected input reports 1x1 at pressure 0 or 1.
        if (t === 'touch') {
          const w = Number(e.width), h = Number(e.height), p = Number(e.pressure);
          if (Number.isFinite(w) && Number.isFinite(h)) _prov.areas.push(Math.round(w * h * 10) / 10);
          if (Number.isFinite(p)) _prov.press.push(Math.round(p * 1000) / 1000);
        }
      }
      if (_motion.on) window.setTimeout(() => _joltFor(t0), 200);
      if (!_raf.active && typeof window.requestAnimationFrame === 'function' && _raf.gaps.length < RAF_SAMPLES) { _raf.active = true; _raf.last = 0; window.requestAnimationFrame(_rafTick); }
    }, { capture: true, passive: true });
    const release = (e) => {
      const d0 = _prov.downs[e.pointerId];
      if (d0 !== undefined) { if (_prov.holds.length < PROV_CAP) _prov.holds.push(Math.round((now() - d0) * 10) / 10); delete _prov.downs[e.pointerId]; }
      const pend = _prov.pending[e.pointerId];
      if (pend && d0 !== undefined && _prov.samples.length < PROV_SAMPLES) { pend[0] = Math.round((now() - d0) * 10) / 10; _prov.samples.push(pend); }
      delete _prov.pending[e.pointerId];
      if (e.isTrusted !== false) _requestMotion();      // the iOS prompt needs a real gesture's release
    };
    window.addEventListener('pointerup', release, { capture: true, passive: true });
    window.addEventListener('pointercancel', release, { capture: true, passive: true });
    window.addEventListener('touchstart', (e) => { _prov.touchEv += 1; try { if (e.touches && e.touches.length > 1) _prov.multi += 1; } catch (_e) { /* ignore */ } }, { capture: true, passive: true });
    window.addEventListener('touchend', (e) => { if (e.isTrusted !== false) _requestMotion(); }, { capture: true, passive: true });
    window.addEventListener('mousedown', () => { _prov.mouseEv += 1; }, { capture: true, passive: true });
    window.addEventListener('keydown', (e) => { if (!e.repeat) _prov.keys += 1; }, { capture: true, passive: true });
    try { probeDeviceAsync(); } catch (_e) { /* ignore */ }
  }
  function _stats(a) {
    if (!a || a.length < 5) return null;
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
    const uniq = new Set(a.map((v) => Math.round(v * 100) / 100)).size / a.length;
    return { n: a.length, mean: Math.round(m * 1000) / 1000, cv: m > 0 ? Math.round((sd / m) * 1000) / 1000 : null, uniq: Math.round(uniq * 1000) / 1000 };
  }
  function summarizeProvenance() {
    const h = _prov.holds;
    let holdMean = null, holdCv = null, holdModeFrac = null;
    if (h.length >= 5) {
      const m = h.reduce((a, b) => a + b, 0) / h.length;
      const sd = Math.sqrt(h.reduce((a, b) => a + (b - m) * (b - m), 0) / h.length);
      holdMean = Math.round(m * 10) / 10; holdCv = m > 0 ? Math.round((sd / m) * 1000) / 1000 : null;
      const buckets = new Map(); let best = 0;
      for (const v of h) { const k = Math.round(v / 2); const c = (buckets.get(k) || 0) + 1; buckets.set(k, c); if (c > best) best = c; }
      holdModeFrac = Math.round((best / h.length) * 1000) / 1000;
    }
    const downs = Math.min(_prov.n, PROV_CAP);
    // 23 Sep 2026 additions, all record-only aggregates: contact geometry,
    // pressure, extra fingers, digitiser sub-frame samples, frame timing and
    // the motion sensors (with the tap-jolt correlation).
    const area = _stats(_prov.areas), press = _stats(_prov.press);
    let coal = null;
    if (_prov.coal.length >= 10) { const gt1 = _prov.coal.filter((c) => c > 1).length; coal = { n: _prov.coal.length, mean: Math.round((_prov.coal.reduce((a, b) => a + b, 0) / _prov.coal.length) * 100) / 100, gt1Frac: Math.round((gt1 / _prov.coal.length) * 1000) / 1000 }; }
    let raf = null;
    if (_raf.gaps.length >= 30) { const s = _raf.gaps.slice().sort((a, b) => a - b); raf = { n: s.length, hz: Math.round(1000 / s[Math.floor(s.length / 2)]), p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] }; }
    // A desktop browser defines DeviceMotionEvent and "grants" it without a
    // prompt, then never delivers a sample: say so rather than "granted".
    let motion = { support: _motion.support, perm: ((_motion.perm === 'granted' || _motion.perm === 'free') && _motion.n === 0) ? 'silent' : _motion.perm, n: _motion.n };
    if (_motion.n >= 30) {
      const mean = _motion.sumM / _motion.n, sd = Math.sqrt(Math.max(0, _motion.sumSq / _motion.n - mean * mean));
      const span = (_motion.last - _motion.first) / 1000;
      motion.hz = span > 0 ? Math.round(_motion.n / span) : null;
      motion.tremor = Math.round(sd * 1000) / 1000;                          // the sensor's overall noise while playing
      const j = _motion.jolts;
      if (j.length >= 5) { motion.joltN = j.length; motion.joltMean = Math.round((j.reduce((a, b) => a + b, 0) / j.length) * 10) / 10; motion.joltFrac = Math.round((j.filter((v) => v >= 3).length / j.length) * 1000) / 1000; }
    }
    return {
      n: _prov.n, touch: _prov.touch, mouse: _prov.mouse, pen: _prov.pen, other: _prov.other,
      untrusted: _prov.untrusted, keys: _prov.keys, touchEv: _prov.touchEv, mouseEv: _prov.mouseEv,
      holdN: h.length, holdMean, holdCv, holdModeFrac,
      coordUniq: downs > 0 ? Math.round((_prov.coords.size / downs) * 1000) / 1000 : null,
      preMoveFrac: _prov.n > 0 ? Math.round((_prov.preMove / _prov.n) * 1000) / 1000 : null,
      area, press, multiFrac: _prov.touchEv > 0 ? Math.round((_prov.multi / _prov.touchEv) * 1000) / 1000 : null,
      coal, raf, motion,
      samples: _prov.samples.slice(),
    };
  }

  async function computeDeviceFingerprint() {
    try {
      const bits = [];
      // canvas
      try {
        const c = document.createElement('canvas');
        c.width = 200; c.height = 50;
        const ctx = c.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(0, 0, 200, 50);
        ctx.fillStyle = '#069';
        ctx.fillText('KJ-fp \u{1F3AE} 0123', 2, 2);
        bits.push(c.toDataURL().slice(-256));
      } catch (_e) {}
      // screen + DPR
      try { bits.push(screen.width + 'x' + screen.height + '@' + (window.devicePixelRatio || 1)); } catch (_e) {}
      try { bits.push(navigator.userAgent); } catch (_e) {}
      try { bits.push(navigator.language); } catch (_e) {}
      try { bits.push(String(new Date().getTimezoneOffset())); } catch (_e) {}
      // audio fingerprint — render a short oscillator into an offline context
      try {
        const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (Ctx) {
          const ac = new Ctx(1, 44100, 44100);
          const osc = ac.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = 1000;
          const cmp = ac.createDynamicsCompressor();
          osc.connect(cmp);
          cmp.connect(ac.destination);
          osc.start();
          const buf = await ac.startRendering();
          const data = buf.getChannelData(0);
          let sum = 0;
          for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i] || 0);
          bits.push(sum.toFixed(8));
        }
      } catch (_e) {}
      const data = bits.join('|');
      return _hmacSha256JS(data, 'kj-fp-v1'); // hash for stability
    } catch (_e) {
      return null;
    }
  }

  // ── Sealed calls (shared/anticheat/seal.js is the other half) ─────
  // The critical calls leave as one opaque binary blob to /api/game/k, not as
  // readable JSON to readable paths. No secret lives here: the server
  // publishes a per-day PUBLIC key, each call makes a fresh key pair, and
  // ECDH + HKDF give an AES-256-GCM key for the request and its reply.
  // Anything that stops sealing from working (no Web Crypto on an insecure
  // origin, an engine without ECDH) falls back to the plain call, which the
  // server accepts unless anticheat.require_sealed is on.
  const _SEAL_OPS = { '/api/game/session/start': 1, '/api/game/session/event': 2, '/api/game/session/submit': 3, '/api/game/platform/check': 4 };
  let _sealKey = null;       // { k: day, raw: Uint8Array } for the server's public key
  let _sealOff = false;      // this engine cannot seal; stop trying
  const _subtle = () => { try { return (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.deriveBits === 'function') ? crypto.subtle : null; } catch (_e) { return null; } };
  function _b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  async function _serverSealKey(force, signal) {
    if (_sealKey && !force) return _sealKey;
    const res = await fetch(_state.apiBase + '/api/game/k', { method: 'GET', credentials: 'include', signal: signal || undefined });
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status + ': key'), { status: res.status });
    const j = await res.json();
    _sealKey = { k: j.data.k, raw: _b64ToBytes(j.data.p) };
    return _sealKey;
  }
  async function _sealRequest(op, body, sk) {
    const S = _subtle();
    const srv = await S.importKey('raw', sk.raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const eph = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const bits = await S.deriveBits({ name: 'ECDH', public: srv }, eph.privateKey, 256);
    const hk = await S.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const salt = new Uint8Array(4); new DataView(salt.buffer).setUint32(0, sk.k >>> 0);
    const aes = await S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('kj-seal-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const pub = new Uint8Array(await S.exportKey('raw', eph.publicKey));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify({ o: op, b: body }))));
    const frame = new Uint8Array(1 + 4 + pub.length + 12 + ct.length);
    frame[0] = 1; frame.set(salt, 1); frame.set(pub, 5); frame.set(iv, 5 + pub.length); frame.set(ct, 17 + pub.length);
    return { frame, aes };
  }
  async function _openReply(buf, aes) {
    const b = new Uint8Array(buf);
    if (b[0] !== 1 || b.length < 29) throw new Error('bad reply');
    const plain = await _subtle().decrypt({ name: 'AES-GCM', iv: b.slice(1, 13) }, aes, b.slice(13));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function _postSealed(path, body, signal, retried) {
    const sk = await _serverSealKey(false, signal);
    const { frame, aes } = await _sealRequest(_SEAL_OPS[path], body, sk);
    const headers = { 'Content-Type': 'application/octet-stream' };
    const token = _getAccessToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(_state.apiBase + '/api/game/k', { method: 'POST', headers, body: frame, credentials: 'include', signal: signal || undefined });
    const ctype = res.headers.get('content-type') || '';
    if (res.status === 409 && !retried) { _sealKey = null; return _postSealed(path, body, signal, true); }   // the day's key rolled over
    let payload = null;
    if (ctype.indexOf('application/octet-stream') !== -1) payload = await _openReply(await res.arrayBuffer(), aes);
    else if (ctype.indexOf('application/json') !== -1) payload = await res.json().catch(() => null);
    else {
      const err = new Error('HTTP ' + res.status + ': not ours (' + (ctype || 'no content-type') + ') from ' + (_state.apiBase || location.origin));
      err.status = res.status; err.notJson = true; throw err;
    }
    if (!res.ok) {
      const e = payload && payload.error ? payload.error : null;
      const err = new Error('HTTP ' + res.status + ': ' + (e ? e.code + ' ' + e.message : ''));
      err.status = res.status; err.code = e ? e.code || null : null; err.userMessage = e ? e.message || null : null;
      throw err;
    }
    return payload;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────
  async function _postJson(path, body, signal) {
    if (_SEAL_OPS[path] && !_sealOff && _subtle()) {
      // A network failure (including fetching the day's key) is thrown to the
      // caller's retry ladder like any other; only Web Crypto itself failing
      // marks this engine as unable to seal and falls through to plain.
      try { return await _postSealed(path, body, signal); }
      catch (e) {
        if (e && (e.status || e.name === 'AbortError' || e.name === 'TypeError')) throw e;
        _sealOff = true;
      }
    }
    const headers = { 'Content-Type': 'application/json' };
    const token = _getAccessToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(_state.apiBase + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'include',
      signal: signal || undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error('HTTP ' + res.status + ': ' + text);
      err.status = res.status;
      // Our error envelope { success:false, error:{ code, message } }: carry
      // the code and the player-facing message up, so the platform can show
      // the right panel (PLAY_ON_PHONE: "games are played on your phone").
      try { const j = JSON.parse(text); if (j && j.error) { err.code = j.error.code || null; err.userMessage = j.error.message || null; } } catch (_e) { /* not ours */ }
      throw err;
    }
    // A 200 is not an answer — it has to be OUR answer.
    //
    // Amplify's SPA rewrite serves index.html, 200 OK, for any path it does
    // not recognise. So a request that went to the WEB origin instead of the
    // API one came back "successful" and only failed at res.json(), as a bare
    // SyntaxError with no status on it. The panel classified that as a network
    // fault and told the player to check their connection, which is the one
    // thing that could not have helped: their request reached a server, it
    // just reached the wrong one.
    //
    // Name it instead. This is a routing fault and it is ours.
    const ctype = res.headers.get('content-type') || '';
    if (ctype.indexOf('application/json') === -1) {
      const err = new Error(
        'HTTP ' + res.status + ': not JSON (' + (ctype || 'no content-type')
        + ') from ' + (_state.apiBase || location.origin) + path,
      );
      err.status = res.status;
      err.notJson = true;
      throw err;
    }
    return res.json();
  }

  /**
   * Retry an async function with exponential backoff. Built for the
   * submit POST — mobile networks lose / re-route requests frequently
   * (Wi-Fi handover, cellular backoff, OS backgrounding the tab). Most
   * transient errors resolve within 1–2 retries.
   *
   * The per-attempt timeout ABORTS the request. It used to be a bare
   * Promise.race against a setTimeout, which stopped this function
   * LISTENING to a slow attempt while the browser kept SENDING it. On a
   * stalled connection that turned one submit into three identical
   * requests queued on the wire; when the network came back they all
   * landed within milliseconds, the first won and stored the score, and
   * the other two failed the server's seq compare-and-set. This function
   * was only awaiting the last one, so it reported HTTP 400 for a run
   * that was safely on the leaderboard (ahmad007, pulse, 8 Sep 2026 —
   * three submits inside 10ms after a 13.5s stall). The server now
   * answers a duplicated submit from the settled row; this is the other
   * half, which is to not create the duplicate in the first place.
   *
   * The per-attempt budget is deliberately generous. A trace can be tens
   * of KB and a slow cellular upload that IS making progress must not be
   * killed and restarted — that turns a slow success into a real
   * failure. Nothing is blocked while it runs: the game bridge shows the
   * result after 20s either way, and the run stays in memory for the
   * player to retry.
   *
   * Retries only on network errors (fetch rejects) and 5xx server
   * errors. 4xx (bad auth, unknown_session, score_invalid) are NOT
   * retried — those mean the request itself is wrong, not the network.
   */
  async function _withRetry(fn, { attempts = 3, perAttemptTimeoutMs = 20000 } = {}) {
    const backoff = [500, 1000, 2000]; // ms before retries 2, 3, 4
    let lastErr = null;
    let refreshed = false;   // one token refresh per call, not per attempt
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, backoff[i - 1] || 2000));
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      let timer = null;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            if (ctl) { try { ctl.abort(); } catch (_e) { /* already gone */ } }
            reject(new Error('client_timeout_' + perAttemptTimeoutMs));
          }, perAttemptTimeoutMs);
          Promise.resolve(fn(ctl ? ctl.signal : null)).then(resolve, reject);
        });
      } catch (e) {
        lastErr = e;
        const s = e && e.status;
        // A 401 at game over used to be terminal, which meant a finished game
        // scored nothing because the token aged out mid-play. Ask the parent to
        // refresh and try once more; everything else 4xx stays terminal.
        if (s === 401 && !refreshed) {
          refreshed = true;
          const t = await _requestTokenRefresh();
          if (t) { i -= 1; continue; }   // retry immediately with the new token
          throw e;
        }
        if (s && s >= 400 && s < 500) throw e; // don't retry client errors
        // network / 5xx / timeout — loop
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  // Resolves when the parent posts KJ_V2_RETRY_START (the Retry button on
  // the "couldn't start" panel). Exit closes the iframe, so no timeout.
  function _waitForRetryStart() {
    return new Promise((resolve) => {
      const onMsg = (e) => {
        if (e && e.data && e.data.type === 'KJ_V2_RETRY_START') {
          window.removeEventListener('message', onMsg);
          resolve();
        }
      };
      window.addEventListener('message', onMsg);
    });
  }

  // Where does the SDK get the auth token from? The player web stores it
  // in localStorage under 'accessToken' (see web/src/store/auth.jsx).
  // Same-origin iframes share localStorage with the parent so this works
  // in dev. For production (where the game is served from a separate
  // CDN/S3 origin) the launcher relays the token via postMessage at
  // init time (KJ_V2_AUTH) — see the handler below.
  // Token relayed by the launcher (production, cross-origin game host).
  let _relayedToken = null;

  function _getAccessToken() {
    // Re-read localStorage EVERY time rather than caching for the life of the
    // iframe. The old version resolved once at launch and kept that value, so
    // an access token that expired mid-game was still being sent at game over:
    // the submit 401'd and the score was thrown away. 22 finished games lost
    // that way in a single 8-hour window (game-service "Token expired" on
    // /api/game/session/submit).
    //
    // Same-origin games share localStorage with the player app, so whenever the
    // parent's axios interceptor refreshes, the new token is picked up here for
    // free. The relayed token is the fallback for a cross-origin game host.
    try {
      const fromStorage = localStorage.getItem('accessToken')
        || localStorage.getItem('kj_access_token');
      if (fromStorage) return fromStorage;
    } catch (_e) {}
    return _relayedToken;
  }

  /**
   * Ask the parent app to refresh the session, and resolve with the new token.
   *
   * Re-reading localStorage covers the common case, but not an idle tab: if
   * nothing else made a request, nobody has refreshed and the stored token is
   * expired too. The parent owns refresh (single-flight, rotates the refresh
   * token), so the SDK asks rather than trying to do it itself.
   *
   * Resolves null on timeout so the caller can fail the way it used to instead
   * of hanging at game over.
   */
  function _requestTokenRefresh(timeoutMs = 6000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; window.removeEventListener('message', onMsg); resolve(v); } };
      function onMsg(e) {
        if (!e.data || typeof e.data !== 'object') return;
        if (e.data.type === 'KJ_V2_AUTH' && typeof e.data.accessToken === 'string') {
          _relayedToken = e.data.accessToken;
          finish(e.data.accessToken);
        }
        if (e.data.type === 'KJ_V2_AUTH_FAILED') finish(null);
      }
      window.addEventListener('message', onMsg);
      try { (window.parent || window).postMessage({ type: 'KJ_V2_AUTH_REFRESH' }, '*'); }
      catch (_e) { finish(null); }
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  // ── envelope construction ─────────────────────────────────────────
  async function _envelope(type, payload) {
    if (!_state.sessionId || !_state.sessionSecret) {
      throw new Error('KJ SDK v2: session not started');
    }
    _state.seq += 1;
    const ts = Date.now();
    const data = canonicalString({
      sessionId: _state.sessionId, seq: _state.seq, type, ts, payload,
    });
    const hmac = await _hmacHex(data, _state.sessionSecret);
    _persist();
    return { sessionId: _state.sessionId, seq: _state.seq, type, payload, ts, hmac };
  }

  // ── public API ────────────────────────────────────────────────────

  async function kjStartV2(opts) {
    const gameId = opts && opts.gameId;
    if (!gameId) throw new Error('kjStartV2: gameId required');

    // Compute fingerprint asynchronously; non-fatal on failure.
    let deviceFingerprint = opts && opts.deviceFingerprint;
    if (!deviceFingerprint && !PLAYTEST) {
      try { deviceFingerprint = await computeDeviceFingerprint(); }
      catch (_e) { deviceFingerprint = null; }
    }

    // ⚠ A SESSION START THAT FAILS ONCE USED TO FAIL FOREVER. This was one
    // fetch with no retry: a connection reset during an ECS rollover, a
    // flaky cell handoff, one dropped packet — and the bridge, told to
    // "never trap the player behind a network fault", let them play a whole
    // run that could never count (ahmad007, 674 on Block Blast, 10 Sep 2026;
    // no request ever reached the server). Now: the same retry ladder the
    // submit uses (network / 5xx / timeout retried, 4xx terminal, one token
    // refresh on 401), and if that still fails INSIDE THE PLATFORM the
    // player is told BEFORE playing, with a Retry button, instead of after.
    let device = null;
    if (!PLAYTEST) {
      try { await _waitMotion(); } catch (_e) { /* never block a start on this */ }
      try { device = collectDeviceClaims(); } catch (_e) { device = null; }
      try { if (device) device.mo = _motionClaim(); } catch (_e) { /* ignore */ }
    }
    _state.lastStartOpts = { gameId, deviceFingerprint };
    let resp = null;
    if (REPLAY) {
      const rl = await _waitReplayLoad();
      resp = { sessionId: 'replay', sessionSecret: null, seed: rl.seed };
    } else if (PLAYTEST) {
      resp = { sessionId: 'playtest', sessionSecret: null, seed: _localSeedHex() };
    }
    while (!resp) {
      try {
        resp = await _withRetry(
          (signal) => _postJson('/api/game/session/start', Object.assign({ gameId, deviceFingerprint, device }, _labFromUrl() || {}, PT_FULL ? { playtest: true } : {}), signal),
          { attempts: 4, perAttemptTimeoutMs: 15000 },
        );
        break;
      } catch (err) {
        const embedded = (typeof window !== 'undefined' && window.parent && window.parent !== window);
        if (!embedded) throw err;   // standalone: behave as before
        try {
          window.parent.postMessage({
            type: 'KJ_V2_START_FAILED', gameId,
            error: String(err && err.message || err), status: err && err.status || null,
            code: err && err.code || null, message: err && err.userMessage || null,
          }, '*');
        } catch (_e) {}
        // Hold the bridge's promise open until the platform says retry. The
        // game is waiting on it, so nothing uncounted can start meanwhile.
        await _waitForRetryStart();
      }
    }
    const d = resp && resp.data ? resp.data : resp;
    _state.owned = true;          // minted HERE — see _checkSessionNow
    _state.sessionId = d.sessionId;
    _state.sessionSecret = d.sessionSecret;
    _state.seed = d.seed;
    _state.gameId = gameId;
    _state.seq = 0;
    _state.hbSeq = 0;
    // Anything the game emitted while the start was in flight leads the trace.
    _state.eventLog = _state.preSession.splice(0).map((e) => ({ ...e, seq: ++_state.seq }));
    _persist();
    if (!PLAYTEST) _startHeartbeat();   // keep presence alive without per-tap traffic

    // Phase 1B — expose the per-session seed to the game so its PRNG
    // (mulberry32 in shared/anticheat/prng.js) can derive deterministic
    // worlds the server-side validator can reproduce. The validator and
    // the game must agree on the seed bit-for-bit.
    // Exposed as an ACCESSOR so the SDK knows the moment a game consumes it.
    // That read is the only reliable, game-agnostic marker of "this world is
    // now built"; see _midRun(). Falls back to a plain assignment if the host
    // forbids defineProperty.
    _state.seedRead = false;
    try {
      Object.defineProperty(window, '__kjSeed', {
        configurable: true,
        enumerable: true,
        get() { _state.seedRead = true; return _state.seed; },
        set(v) { _state.seed = v; },
      });
    } catch (_e) {
      try { window.__kjSeed = d.seed; } catch (_e2) {}
    }

    // Notify parent (so the React app can hide loading state).
    try { window.parent.postMessage({ type: 'KJ_V2_READY', gameId }, '*'); } catch (_e) {}

    // The server no longer sends expiresAt / maxDurationSecs — the SDK never
    // read them, and they handed an attacker his runway for free.
    return {
      sessionId: d.sessionId,
      seed: d.seed,
    };
  }

  // Fire-and-forget. Buffers locally for the replay trace; sends over
  // WS if connected, falls back to HTTP. Phase 1A doesn't ack each
  // event back to the game — server enforces but doesn't block UX.
  //
  // CRITICAL ORDERING (bullet-proof scoring at scale):
  //   1. Push to eventLog SYNCHRONOUSLY (before any await). This
  //      guarantees the trace contains every input even if HMAC or
  //      network is still in flight when /session/submit fires.
  //   2. Track the FULL async lifecycle (envelope + POST) as a single
  //      promise in _inflight. kjSubmitV2 awaits the entire set, so
  //      live-stream events also have time to land server-side before
  //      submit (gives the live validator_state a chance to be the
  //      fallback when trace decode fails).
  // kjEmit now records an input into the LOCAL trace only. It does NOT send a
  // network request per tap.
  //
  // The whole run is captured in `_state.eventLog` and uploaded once, gzipped,
  // at kjSubmitV2. The server replays that trace deterministically — that is
  // the authoritative score. A per-tap POST used only to feed a live-scoring
  // fallback + the pace pin + presence; scoring moved to the trace replay, the
  // pace pin's job is covered by the submit-time duration check, and presence
  // is kept alive by a low-frequency heartbeat (see _startHeartbeat). So a
  // fast game that used to fire hundreds of POSTs now fires none until submit.
  function kjEmit(type, payload) {
    // An emit BEFORE the session exists used to be dropped on the floor — and
    // the very first emit of a run is the bridge's v2 start marker. If the
    // game began before /session/start resolved, the marker was lost, the
    // server saw v2 inputs with no marker, fell back to the v1 path, rejected
    // every one of them and stored 0 (Block Blast, 10 Sep 2026). Buffer it
    // instead; kjStartV2 seeds the trace from this buffer once it has a session.
    if (!_state.sessionId) {
      _state.preSession.push({ type, payload: payload || null, ts: Date.now() });
      return Promise.resolve();
    }
    const tsLocal = Date.now();
    const seqLocal = ++_state.seq;
    // Synchronous trace push — the complete, ordered record of the run.
    _state.eventLog.push({
      type, payload: payload || null, ts: tsLocal, seq: seqLocal,
    });
    _persist();
    return Promise.resolve();
  }

  // ── Presence heartbeat ──────────────────────────────────────────────
  // A single authenticated keepalive every HEARTBEAT_MS so the session stays
  // in the "live players" count on games longer than the presence TTL (75s).
  // It carries no gameplay and can never score — the server refreshes presence
  // and returns (see anticheatSession.validateMessage's heartbeat branch).
  const HEARTBEAT_MS = 30000;

  // ALWAYS THE LATEST BUILD. Every page is stamped at deploy with the build it
  // came from (window.__kjBuild / __kjBuildAt, see scripts/stamp-busters.js)
  // and games/build.json says what is deployed now. On every heartbeat, and
  // once at start, compare: a NEWER deploy while this game sits on its menu →
  // ask the platform to reload it (a fresh cb= URL, so a fresh page). Never
  // mid-run: a run in progress finishes under the rules it was played with,
  // and the next launch is fresh anyway. Compared by TIME, not equality, so a
  // CDN edge still serving yesterday's build.json cannot bounce a fresh page.
  let _staleReported = false;
  async function _checkBuild() {
    try {
      if (_staleReported || typeof window.__kjBuildAt !== 'number' || typeof fetch !== 'function') return;
      const res = await fetch(location.origin + '/games/build.json', { cache: 'no-store' });
      if (!res || !res.ok) return;
      const j = await res.json();
      if (!j || typeof j.at !== 'number' || j.at <= window.__kjBuildAt) return;
      if (_midRun()) return;
      _staleReported = true;
      (window.parent || window).postMessage({ type: 'KJ_V2_STALE_BUILD', current: window.__kjBuild, latest: j.build }, '*');
    } catch (_e) { /* a build check is never worth an error */ }
  }

  async function _sendHeartbeat() {
    _checkBuild();
    if (PLAYTEST || !_state.sessionId) return;
    try {
      const ts = Date.now();
      const seq = ++_state.hbSeq;               // own counter — keeps trace seqs clean
      const data = canonicalString({
        sessionId: _state.sessionId, seq, type: 'heartbeat', ts, payload: null,
      });
      const hmac = await _hmacHex(data, _state.sessionSecret);
      await _postJson('/api/game/session/event', {
        sessionId: _state.sessionId, seq, type: 'heartbeat', payload: null, ts, hmac,
      });
      _state.hbFailed = false;
    } catch (e) {
      // ⚠ THIS USED TO BE SWALLOWED, and that cost a beta tester a personal
      // best. On 9 Sep 2026 a session was swept at 09:31:00Z; every heartbeat
      // from 09:32:34 onward came back `reject:unknown_session`, and the player
      // kept playing until 09:36:32 and submitted a 177-point run into a
      // session we had known was dead for four minutes. The comment said
      // "presence is best-effort — never disturb gameplay". Presence is; the
      // knowledge that the round is over is not.
      //
      // A 400 naming a dead session is DEFINITIVE. Anything else (offline, a
      // 5xx, a timeout) is a blip and must not end anyone's round — the bar is
      // "the server told us this session is gone", never "we could not reach
      // the server".
      if (_isSessionGone(e)) _onSessionLost();
    }
  }

  // Distinguish "the session is gone" from "the network hiccuped". Only the
  // former may interrupt a player.
  function _isSessionGone(e) {
    if (!e || e.status !== 400) return false;
    const m = String(e.message || '');
    return m.indexOf('unknown_session') >= 0
        || m.indexOf('state_expired') >= 0
        || m.indexOf('state_submitted') >= 0;
  }

  // A run is in progress once the game has emitted anything at all. Before
  // that the player is on a menu or a how-to-play panel and has invested
  // nothing, so losing the session costs them nothing and they should never
  // find out.
  function _midRun() {
    if (!_state.sessionId) return false;
    // Two independent signals, because neither is sufficient alone:
    //
    //   eventLog — the game has reported something, so a run is under way.
    //   seedRead — the game has READ window.__kjSeed, so it may already have
    //              built its world from it. Swapping the seed under that is
    //              worse than the bug this fixes: the player would finish a run
    //              on a course the server never generated.
    //
    // The second exists because the first is NOT universal. Cannon Rush uses
    // the seed but emits nothing until the player's first score, so a run in
    // progress looked idle — and a "silent" re-mint would have quietly changed
    // the game underneath them. Any future game with that shape is covered
    // without anyone having to remember this.
    return (_state.eventLog && _state.eventLog.length > 0) || _state.seedRead === true;
  }

  function _onSessionLost() {
    if (_state.sessionLost) return;              // report once
    _state.sessionLost = true;
    _stopHeartbeat();

    if (!_midRun()) {
      // NOT mid-run: replace it silently. The player is looking at a menu and
      // will never know. kjStartV2 resets seq/eventLog and re-points
      // window.__kjSeed, so a game that builds its world at run start (they
      // all do) picks up the new seed with no idea anything happened.
      _state.sessionLost = false;
      _state.sessionId = null;
      const gameId = _state.gameId;
      if (!gameId) return;
      kjStartV2({ gameId }).catch(function () {
        // Could not re-mint. Do NOT nag: they still have not played. The next
        // heartbeat or the next visibility change will try again, and if they
        // start a run on a dead session the mid-run branch below catches it.
        _state.sessionId = null;
      });
      return;
    }

    // MID-RUN: this is the only case a player should ever see. Tell them now —
    // 30 seconds of interruption instead of a lost personal best at the end.
    try {
      (window.parent || window).postMessage({
        type: 'KJ_V2_SESSION_LOST', gameId: _state.gameId,
      }, '*');
    } catch (_e) {}
  }

  function _startHeartbeat() {
    _stopHeartbeat();
    _state.sessionLost = false;
    if (typeof setInterval === 'function') {
      _state.hbTimer = setInterval(_sendHeartbeat, HEARTBEAT_MS);
    }
  }
  function _stopHeartbeat() {
    if (_state.hbTimer) { clearInterval(_state.hbTimer); _state.hbTimer = null; }
  }

  // COMING BACK FROM AWAY IS THE COMMON CASE, and waiting up to 30s for the
  // next scheduled heartbeat is too slow — the player has already started
  // playing again. The game itself freezes while hidden (`if (document.hidden)
  // return` in every game loop) but the session clock does not, so "backgrounded
  // for a while" is precisely how a session dies underneath someone.
  //
  // The server is never told the expiry (see kjStartV2) and neither is the
  // client, deliberately — so we ASK, we do not compute.
  function _checkSessionNow() {
    // ⚠ ONLY a session THIS frame minted. `sessionStorage` is shared across
    // same-origin iframes, and _restoreFromSession() copies whatever is in it
    // into _state at load with no check that it belongs to this game — so a
    // freshly-opened game can be holding the PREVIOUS game's session before it
    // mints its own. That was harmless while nothing acted on a restored
    // session (the periodic heartbeat only starts inside kjStartV2), but this
    // check is event-driven and would have: a dead stale session would be
    // "recovered" by minting a new one for _state.gameId — the wrong game —
    // and handing this frame a seed from it.
    if (PLAYTEST || !_state.owned || !_state.sessionId) return;
    _sendHeartbeat();
  }
  try {
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) _checkSessionNow();
      });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('focus', _checkSessionNow);
      window.addEventListener('online', _checkSessionNow);
      window.addEventListener('pageshow', _checkSessionNow);
    }
  } catch (_e) { /* non-browser host */ }

  async function kjSubmitV2(opts) {
    if (!_state.sessionId) throw new Error('kjSubmitV2: no session');
    const clientClaimedScore = (opts && Number(opts.clientClaimedScore)) || 0;
    if (REPLAY) {
      const step = (window.__kjReplay && window.__kjReplay.lastStep) || null;
      _state.sessionId = null;
      _state.eventLog = [];
      try { (window.parent || window).postMessage({ type: 'KJ_REPLAY_DONE', score: clientClaimedScore, step }, '*'); } catch (_e) {}
      return { authoritativeScore: clientClaimedScore, counted: false, flaggedForReview: false, replay: true };
    }
    if (PLAYTEST) {
      // Nothing is sent. The game gets the answer a real submit would give a
      // run that did not count, so its bridge ends the run the normal way.
      _state.sessionId = null;
      _state.eventLog = [];
      return { authoritativeScore: clientClaimedScore, counted: false, flaggedForReview: false, playtest: true };
    }
    // Tell the platform the run is over and the save has started, so it can
    // show a saving state at once. On a slow radio the submit ladder can run
    // for a minute, and until now the player stared at a frozen game with no
    // sign that anything was happening.
    try { (window.parent || window).postMessage({ type: 'KJ_V2_SUBMITTING', score: clientClaimedScore, sessionId: _state.sessionId || null }, '*'); } catch (_e) {}

    // No per-tap POSTs to drain any more — the trace (built synchronously in
    // eventLog by every kjEmit) is already complete. Stop the presence
    // heartbeat; the session is settling.
    _stopHeartbeat();

    // Build trace: newline-delimited JSON, gzipped, base64'd.
    let traceB64 = null;
    try {
      const jsonl = _state.eventLog
        .map((e) => JSON.stringify(e))
        .join('\n');
      // Browser gzip via CompressionStream when available.
      if (typeof CompressionStream !== 'undefined') {
        const stream = new Blob([jsonl]).stream().pipeThrough(new CompressionStream('gzip'));
        const blob = await new Response(stream).blob();
        const buf = await blob.arrayBuffer();
        traceB64 = _arrayBufferToBase64(buf);
      } else {
        // No CompressionStream → send raw, server can ungzip-or-passthrough.
        traceB64 = btoa(unescape(encodeURIComponent(jsonl)));
      }
    } catch (_e) { /* no trace is fine */ }

    const env = await _envelope('submit', { clientClaimedScore });

    // Wrapped in retry-with-backoff. Mobile networks lose / re-route
    // submit POSTs frequently (Wi-Fi → cellular handover, mobile
    // browser backgrounding the tab between game-over and submit,
    // congested cellular). Without this, a transient network blip
    // surfaces as score:0 / blank Result screen — terrible UX.
    const submitBody = {
      sessionId: env.sessionId,
      seq: env.seq,
      ts: env.ts,
      hmac: env.hmac,
      clientClaimedScore,
      traceCompressedBase64: traceB64,
      provenance: (() => { try { return summarizeProvenance(); } catch (_e) { return null; } })(),
    };
    // Held in memory ONLY, for as long as this iframe lives. If the submit
    // fails the player app keeps the game modal open and offers a Retry, which
    // calls back in here — no persistence, nothing written to disk, and it all
    // disappears the moment the game closes.
    _state.lastSubmitBody = submitBody;

    const resp = await _withRetry(
      (signal) => _postJson('/api/game/session/submit', submitBody, signal),
      { attempts: 3, perAttemptTimeoutMs: 20000 },
    );
    const d = resp && resp.data ? resp.data : resp;
    _settled(d);
    return d;
  }

  // THE SERVER HAS THE RUN. This is the one place the SDK forgets a session,
  // and it now also (1) remembers the answer, so a later Try again returns
  // it instead of "nothing to retry", and (2) tells the platform directly.
  // On 10 Sep 2026 a Pulse submit took ~20s to reach us on a one-bar
  // connection: the bridge's 20s safety timer showed "couldn't save" first,
  // the SDK's retry then SUCCEEDED (the score was on the board), the bridge
  // discarded that late success behind its "already navigated" guard, the
  // state was wiped, Try again found nothing to retry, and the player was
  // told the run was never registered. Nothing about that was true.
  function _settled(d) {
    _state.lastSubmitBody = null;
    _state.lastSubmitResult = d || {};
    _clearPersisted();
    _state.sessionId = null;
    _state.sessionSecret = null;
    _state.eventLog = [];
    try {
      (window.parent || window).postMessage({
        type: 'KJ_V2_SUBMIT_SETTLED',
        sessionId: _state.sessionId || null,
        gameId: _state.gameId,
        score: (d && d.authoritativeScore) != null ? d.authoritativeScore : null,
        flagged: !!(d && d.flaggedForReview),
        notCounted: !!(d && d.counted === false),
        alreadyFinalSession: !!(d && d.alreadyFinalSession),
      }, '*');
    } catch (_e) {}
  }

  /**
   * Re-send the submit that just failed. Called by the player app when the
   * player taps Retry on the "couldn't save your score" panel.
   *
   * Only possible while the game iframe is alive — the payload lives in
   * memory, deliberately. Nothing is persisted, so there is no editable
   * envelope sitting on disk and no queue to go stale.
   */
  async function kjRetrySubmitV2() {
    // Already settled (a success that landed after the bridge gave up): the
    // answer is the answer. Retrying a settled session is a READ anyway.
    if (!_state.lastSubmitBody && _state.lastSubmitResult) return _state.lastSubmitResult;
    if (!_state.lastSubmitBody) throw new Error('kjRetrySubmitV2: nothing to retry');
    const resp = await _withRetry(
      (signal) => _postJson('/api/game/session/submit', _state.lastSubmitBody, signal),
      { attempts: 3, perAttemptTimeoutMs: 20000 },
    );
    const d = resp && resp.data ? resp.data : resp;
    _settled(d);
    return d;
  }

  function _arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  // ── window plumbing ───────────────────────────────────────────────
  _restoreFromSession();

  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'KJ_V2_AUTH' && typeof e.data.accessToken === 'string') {
      _relayedToken = e.data.accessToken;
    }
    if (e.data.type === 'KJ_V2_API_BASE' && typeof e.data.apiBase === 'string') {
      _state.apiBase = e.data.apiBase;
    }
    if (REPLAY && e.source === window.parent && e.data.type === 'KJ_REPLAY_LOAD' && !_replayLoad && typeof e.data.seed === 'string') {
      const sp = Number(e.data.speed);
      _replayLoad = { seed: e.data.seed };
      window.__kjReplay = {
        events: Array.isArray(e.data.events) ? e.data.events : [],
        version: e.data.version != null ? Number(e.data.version) : null,
        speed: Number.isFinite(sp) && sp >= 0 ? sp : 1,
        lastStep: null,
      };
      _replayWaiters.splice(0).forEach((r) => r(_replayLoad));
    }
    if (REPLAY && e.source === window.parent && e.data.type === 'KJ_REPLAY_SPEED' && window.__kjReplay) {
      const sp = Number(e.data.speed);
      if (Number.isFinite(sp) && sp >= 0) window.__kjReplay.speed = sp;
    }
    if (e.data.type === 'KJ_V2_RETRY_SUBMIT') {
      kjRetrySubmitV2()
        .then((r) => {
          try {
            (window.parent || window).postMessage({
              type: 'KJ_V2_RESULT',
              score: (r && r.authoritativeScore) != null ? r.authoritativeScore : (e.data.clientScore || 0),
              authoritative: !!r && !r.alreadyFinalSession,
              notCounted: !!(r && r.counted === false),
            }, '*');
          } catch (_e2) {}
        })
        .catch((err) => {
          try {
            (window.parent || window).postMessage({
              type: 'KJ_V2_RETRY_FAILED', error: (err && err.message) || 'retry_failed',
            }, '*');
          } catch (_e2) {}
        });
    }
  });

  try { installProvenance(); } catch (_e) { /* provenance is best-effort */ }
  window.kjStartV2 = kjStartV2;
  window.kjEmit = kjEmit;
  window.kjSubmitV2 = kjSubmitV2;
  window.kjRetrySubmitV2 = kjRetrySubmitV2;
  // exposed for tests / inspection
  window.__kjSdkV2 = {
    replay: REPLAY,
    checkBuild: _checkBuild,   // exposed for tests
    state: () => ({ ..._state, ws: undefined }),
    stableStringify,
    canonicalString,
  };
}(window));
