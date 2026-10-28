/*
 * KJTutorial — a lightweight, themeable, INTERACTIVE "How to Play" overlay.
 *
 * It shows the game's core rules AND makes the player rehearse the actual
 * input gesture (tap or swipe) before play begins — so it teaches by doing,
 * not by reading. It's a pure pre-game overlay: it sits on top of the game
 * and never touches the game's own start/score logic, so it can't break
 * gameplay OR the anti-cheat (no game events fire while it's up).
 *
 * Usage (in a game's index.html, after the game script):
 *   <script src="/games/_shared/kj-tutorial.js"></script>
 *   <script>
 *     window.addEventListener('load', function () {
 *       KJTutorial.play({
 *         gameId: 'sky-tower', title: 'SKY TOWER', accent: '#FFD23F',
 *         gesture: 'tap',                 // 'tap' | 'swipe'
 *         steps: [ { icon:'👆', title:'TAP TO DROP', text:'...' }, ... ],
 *       });
 *     });
 *   </script>
 *
 * KJTutorial.play(cfg)  → interactive, shown EVERY time. Resolves when the
 *                         player has completed the practice reps.
 * KJTutorial.maybeShow(cfg) → legacy static modal, shown once per game.
 *
 * `?tut=0` suppresses it (QA / automated tests). `?tut=1` forces the legacy
 * once-only path to re-show.
 */
(function () {
  'use strict';
  if (window.KJTutorial) return;

  var CSS = [
    '.kj-tut-overlay{',
    '  position:fixed; inset:0; z-index:2147483000;',
    '  display:flex; align-items:center; justify-content:center; padding:20px;',
    '  background:rgba(4,2,12,0.82); -webkit-backdrop-filter:blur(3px); backdrop-filter:blur(3px);',
    "  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
    '  -webkit-font-smoothing:antialiased; opacity:0; transition:opacity .22s ease;',
    '}',
    '.kj-tut-overlay.kj-tut-in{ opacity:1; }',
    '.kj-tut-card{',
    '  --a:var(--kj-tut-accent,#4EE53E);',
    '  width:100%; max-width:360px; box-sizing:border-box;',
    '  background:linear-gradient(180deg,#1c1030 0%,#140a26 100%);',
    '  border:1px solid rgba(255,255,255,0.12); border-radius:22px;',
    '  padding:22px 20px 20px; text-align:center;',
    '  box-shadow:0 24px 60px rgba(0,0,0,0.55); color:#fff;',
    '  transform:translateY(14px) scale(0.98); transition:transform .24s cubic-bezier(0.34,1.4,0.5,1);',
    '  max-height:calc(100dvh - 40px); overflow-y:auto;',
    '}',
    '.kj-tut-in .kj-tut-card{ transform:translateY(0) scale(1); }',
    '.kj-tut-eyebrow{ font-size:10.5px; font-weight:900; letter-spacing:2px; color:var(--a); margin-bottom:6px; }',
    '.kj-tut-title{ font-size:26px; font-weight:900; letter-spacing:-0.5px; line-height:1; margin-bottom:16px; }',
    '.kj-tut-steps{ display:flex; flex-direction:column; gap:11px; text-align:left; margin-bottom:16px; }',
    '.kj-tut-step{ display:flex; align-items:center; gap:12px;',
    '  background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.09);',
    '  border-radius:14px; padding:11px 12px; }',
    '.kj-tut-step-icon{ flex:0 0 auto; width:44px; height:44px; border-radius:12px;',
    '  display:flex; align-items:center; justify-content:center; font-size:24px; line-height:1;',
    '  background:color-mix(in srgb, var(--a) 20%, transparent); }',
    '.kj-tut-step-body{ min-width:0; }',
    '.kj-tut-step-title{ font-size:12.5px; font-weight:800; letter-spacing:0.4px; color:var(--a); margin-bottom:2px; }',
    '.kj-tut-step-text{ font-size:12.5px; font-weight:500; line-height:1.4; color:rgba(255,255,255,0.82); }',
    '.kj-tut-btn{ width:100%; height:52px; border:none; border-radius:14px; cursor:pointer;',
    '  background:var(--a); color:#0A2A04; font-size:15px; font-weight:900; letter-spacing:0.2px;',
    "  font-family:inherit; box-shadow:0 6px 0 rgba(0,0,0,0.28), 0 12px 24px color-mix(in srgb, var(--a) 30%, transparent);",
    '  transition:transform .08s ease; }',
    '.kj-tut-btn:active{ transform:translateY(3px); box-shadow:0 3px 0 rgba(0,0,0,0.28); }',
    /* ── interactive practice zone ── */
    '.kj-tut-practice{ margin-top:4px; }',
    '.kj-tut-plabel{ font-size:10.5px; font-weight:900; letter-spacing:1.8px; color:var(--a); margin-bottom:8px; }',
    '.kj-tut-prompt{ font-size:14px; font-weight:800; color:#fff; margin-bottom:14px; min-height:18px; }',
    '.kj-tut-target{ width:96px; height:96px; margin:0 auto 16px; border-radius:50%;',
    '  background:var(--a); color:#0A2A04; border:none; cursor:pointer; font-family:inherit;',
    '  display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:900;',
    '  letter-spacing:0.5px; touch-action:manipulation;',
    '  animation:kj-tut-pulse 1.25s ease-out infinite; transition:transform .1s ease; }',
    '.kj-tut-target:active,.kj-tut-target.kj-tut-hit{ transform:scale(0.88); }',
    '@keyframes kj-tut-pulse{',
    '  0%{ box-shadow:0 0 0 0 color-mix(in srgb,var(--a) 55%,transparent); }',
    '  70%{ box-shadow:0 0 0 24px rgba(0,0,0,0); }',
    '  100%{ box-shadow:0 0 0 0 rgba(0,0,0,0); } }',
    '.kj-tut-track{ position:relative; width:100%; height:96px; border-radius:16px; margin:0 0 16px;',
    '  background:rgba(255,255,255,0.05); border:1px dashed color-mix(in srgb,var(--a) 50%,transparent);',
    '  overflow:hidden; touch-action:none; cursor:grab; user-select:none; -webkit-user-select:none; }',
    '.kj-tut-swoosh{ position:absolute; top:0; bottom:0; width:2px; background:var(--a);',
    '  opacity:0; box-shadow:0 0 12px var(--a); pointer-events:none; }',
    '.kj-tut-fruit{ position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);',
    '  width:54px; height:54px; border-radius:50%;',
    '  background:radial-gradient(circle at 35% 30%, #fff5, transparent 60%), var(--a);',
    '  box-shadow:0 6px 16px rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center;',
    '  font-size:28px; pointer-events:none; transition:transform .14s ease, opacity .14s ease; }',
    '.kj-tut-fruit.kj-tut-sliced{ transform:translate(-50%,-50%) scale(0.15) rotate(30deg); opacity:0; }',
    '.kj-tut-progress{ display:flex; gap:9px; justify-content:center; }',
    '.kj-tut-dot{ width:10px; height:10px; border-radius:50%; background:rgba(255,255,255,0.18);',
    '  transition:background .18s ease, transform .18s ease; }',
    '.kj-tut-dot.kj-tut-on{ background:var(--a); transform:scale(1.25); }',
    '@media (prefers-reduced-motion:reduce){',
    '  .kj-tut-overlay,.kj-tut-card,.kj-tut-target{ transition:none; animation:none; } }',
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('kj-tut-css')) return;
    var s = document.createElement('style');
    s.id = 'kj-tut-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // Which featured rotation this play belongs to, from the launcher (?rot=).
  // Scoping the seen-flag to it means the tutorial shows ONCE PER ROTATION:
  // a player who saw it stays un-nagged while the game is in the lineup, and
  // sees it again the next time the game is rotated back in. Absent (direct
  // load, or a game that is not currently featured) falls back to the old
  // once-ever behaviour rather than showing it every single launch.
  function rotationTag() {
    try {
      var r = new URLSearchParams(location.search).get('rot');
      return r ? '_r' + r : '';
    } catch (e) { return ''; }
  }
  function seenKey(gameId, version) {
    return 'kj_tut_' + gameId + '_v' + (version || 1) + rotationTag();
  }
  function hasSeen(gameId, version) {
    try { return !!localStorage.getItem(seenKey(gameId, version)); } catch (e) { return false; }
  }
  function markSeen(gameId, version) {
    try { localStorage.setItem(seenKey(gameId, version), '1'); } catch (e) { /* private mode */ }
  }
  function forceParam() {
    try { return new URLSearchParams(location.search).get('tut'); } catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function stepsHtml(steps) {
    return (steps || []).map(function (s) {
      return '<div class="kj-tut-step">'
        + '<div class="kj-tut-step-icon">' + esc(s.icon || '▶') + '</div>'
        + '<div class="kj-tut-step-body">'
        + '<div class="kj-tut-step-title">' + esc(s.title || '') + '</div>'
        + '<div class="kj-tut-step-text">' + esc(s.text || '') + '</div>'
        + '</div></div>';
    }).join('');
  }

  function dotsHtml(reps) {
    var out = '';
    for (var i = 0; i < reps; i += 1) out += '<div class="kj-tut-dot"></div>';
    return out;
  }

  // Legacy static modal (once per game).
  function buildStatic(cfg) {
    var overlay = document.createElement('div');
    overlay.className = 'kj-tut-overlay';
    overlay.style.setProperty('--kj-tut-accent', cfg.accent || '#4EE53E');
    overlay.innerHTML =
      '<div class="kj-tut-card" role="dialog" aria-modal="true" aria-label="How to play">'
      + '<div class="kj-tut-eyebrow">HOW TO PLAY</div>'
      + '<div class="kj-tut-title">' + esc(cfg.title || '') + '</div>'
      + '<div class="kj-tut-steps">' + stepsHtml(cfg.steps) + '</div>'
      + '<button type="button" class="kj-tut-btn" id="kjTutBtn">' + esc(cfg.cta || 'GOT IT — PLAY!') + '</button>'
      + '</div>';
    return overlay;
  }

  // Interactive card: rules + a hands-on practice gate.
  function buildInteractive(cfg) {
    var gesture = cfg.gesture === 'swipe' ? 'swipe' : 'tap';
    var reps = Math.max(1, cfg.reps || 3);
    var prompt = gesture === 'swipe'
      ? (cfg.practicePrompt || 'Swipe across the target')
      : (cfg.practicePrompt || 'Tap the button to practise');
    var control = gesture === 'swipe'
      ? '<div class="kj-tut-track" id="kjTutTrack"><div class="kj-tut-swoosh" id="kjTutSwoosh"></div><div class="kj-tut-fruit" id="kjTutFruit">' + esc(cfg.practiceIcon || '🍉') + '</div></div>'
      : '<button type="button" class="kj-tut-target" id="kjTutTarget">TAP</button>';

    var overlay = document.createElement('div');
    overlay.className = 'kj-tut-overlay';
    overlay.style.setProperty('--kj-tut-accent', cfg.accent || '#4EE53E');
    overlay.innerHTML =
      '<div class="kj-tut-card" role="dialog" aria-modal="true" aria-label="How to play">'
      + '<div class="kj-tut-eyebrow">HOW TO PLAY</div>'
      + '<div class="kj-tut-title">' + esc(cfg.title || '') + '</div>'
      + '<div class="kj-tut-steps">' + stepsHtml(cfg.steps) + '</div>'
      + '<div class="kj-tut-practice">'
      + '<div class="kj-tut-plabel">NOW YOU TRY</div>'
      + '<div class="kj-tut-prompt" id="kjTutPrompt">' + esc(prompt) + '</div>'
      + control
      + '<div class="kj-tut-progress" id="kjTutProgress">' + dotsHtml(reps) + '</div>'
      + '</div></div>';
    overlay._gesture = gesture;
    overlay._reps = reps;
    return overlay;
  }

  // Wire up the interactive practice; call onComplete() once reps are done.
  function wireInteractive(overlay, cfg, onComplete) {
    var reps = overlay._reps;
    var done = 0;
    var finished = false;
    var promptEl = overlay.querySelector('#kjTutPrompt');
    var dots = overlay.querySelectorAll('.kj-tut-dot');

    function progress() {
      done += 1;
      if (dots[done - 1]) dots[done - 1].classList.add('kj-tut-on');
      if (done >= reps) {
        finished = true;
        if (promptEl) promptEl.textContent = "GREAT — YOU'VE GOT IT!";
        setTimeout(onComplete, 550);
      } else if (promptEl) {
        promptEl.textContent = (reps - done) + ' more to go';
      }
    }

    if (overlay._gesture === 'swipe') {
      var track = overlay.querySelector('#kjTutTrack');
      var fruit = overlay.querySelector('#kjTutFruit');
      var swoosh = overlay.querySelector('#kjTutSwoosh');
      var downX = null;
      var counted = false;
      function pt(e) { return (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX); }
      track.addEventListener('pointerdown', function (e) {
        if (finished) return;
        downX = pt(e); counted = false;
        try { track.setPointerCapture(e.pointerId); } catch (_e) {}
      });
      track.addEventListener('pointermove', function (e) {
        if (finished || downX === null || counted) return;
        var x = pt(e);
        if (swoosh) {
          var rect = track.getBoundingClientRect();
          swoosh.style.left = (x - rect.left) + 'px';
          swoosh.style.opacity = '0.9';
        }
        if (Math.abs(x - downX) >= 66) {
          counted = true;
          if (fruit) {
            fruit.classList.add('kj-tut-sliced');
            setTimeout(function () {
              fruit.classList.remove('kj-tut-sliced');
            }, 260);
          }
          progress();
        }
      });
      function end() {
        downX = null;
        if (swoosh) swoosh.style.opacity = '0';
      }
      track.addEventListener('pointerup', end);
      track.addEventListener('pointercancel', end);
      track.addEventListener('pointerleave', end);
    } else {
      var target = overlay.querySelector('#kjTutTarget');
      target.addEventListener('click', function () {
        if (finished) return;
        target.classList.add('kj-tut-hit');
        setTimeout(function () { target.classList.remove('kj-tut-hit'); }, 110);
        progress();
        if (done >= reps) target.textContent = 'GO!';
      });
    }
  }

  function show(cfg) {
    return new Promise(function (resolve) {
      try {
        injectCSS();
        var interactive = !!cfg.interactive;
        var overlay = interactive ? buildInteractive(cfg) : buildStatic(cfg);
        document.body.appendChild(overlay);
        // Some games apply a broad `transition` to top-level nodes, the ONE
        // cascade level that can override inline !important — it was slowly
        // ramping the overlay's opacity down. Pin opacity so nothing wins;
        // the card still animates in via its own transform transition.
        overlay.style.setProperty('transition', 'none', 'important');
        overlay.style.setProperty('opacity', '1', 'important');
        requestAnimationFrame(function () { overlay.classList.add('kj-tut-in'); });

        var closed = false;
        function close() {
          if (closed) return; closed = true;
          markSeen(cfg.gameId, cfg.version);
          overlay.style.setProperty('opacity', '0', 'important');
          setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve();
          }, 200);
        }

        if (interactive) {
          wireInteractive(overlay, cfg, close);
        } else {
          overlay.querySelector('#kjTutBtn').addEventListener('click', close);
        }
      } catch (e) { resolve(); /* never block the game on a tutorial error */ }
    });
  }

  // Interactive, shown EVERY time (unless ?tut=0 for QA).
  function play(cfg) {
    if (forceParam() === '0') return Promise.resolve();
    var c = {}; for (var k in cfg) if (Object.prototype.hasOwnProperty.call(cfg, k)) c[k] = cfg[k];
    c.interactive = true;
    return show(c);
  }

  // Legacy static modal, shown once per game (kept for back-compat).
  function maybeShow(cfg) {
    var force = forceParam();
    if (force === '0') return Promise.resolve();
    if (force !== '1' && hasSeen(cfg.gameId, cfg.version)) return Promise.resolve();
    return show(cfg);
  }

  window.KJTutorial = { play: play, show: show, maybeShow: maybeShow, hasSeen: hasSeen };
})();
