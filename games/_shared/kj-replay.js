/**
 * kj-replay.js: play a STORED run back inside the real game (admin run viewer).
 *
 * THE CONTRACT (read this before writing an adapter for another game)
 * --------------------------------------------------------------------
 * The admin viewer opens `/games/<id>/index.html?replay=1&tut=0&cb=<ts>` in an
 * iframe. The SDK (sdk/kj-sdk/kj-sdk-v2.js) sees `?replay=1` at parse time and
 * then sends NOTHING to the server: no session, events, heartbeat or submit.
 *
 *   parent -> game   KJ_REPLAY_LOAD  { seed, events, version, speed }
 *                    KJ_CONFIG       (the bridge's usual start signal)
 *                    KJ_REPLAY_SPEED { speed }        (0 pauses)
 *   game -> parent   KJ_GAME_LOADED  (as always)
 *                    KJ_REPLAY_READY { gameId }       (this game can play back)
 *                    KJ_REPLAY_STARTED { version }    (rules the run is played under)
 *                    KJ_REPLAY_PROGRESS { step, score }
 *                    KJ_REPLAY_DONE  { score, step }  (the run ended)
 *
 * On KJ_REPLAY_LOAD the SDK sets window.__kjReplay = { events, version, speed }
 * and resolves kjStartV2 with the recorded seed, so the bridge's session-ready
 * callbacks fire exactly as in a live run and window.__kjSeed is the run's seed.
 *
 * A game that supports replay (load this file BEFORE game.js) must, when
 * KJReplay.active():
 *   1. Announce itself: KJReplay.ready(gameId) at load.
 *   2. Ignore every real input (pointer, touch, keys). Nothing the admin does
 *      in the frame may reach the run.
 *   3. Skip HOW TO PLAY and the menu: start the run by itself once the session
 *      is ready (the viewer adds ?tut=0, and this file forces KJTut off too).
 *   4. Play the rules of the TRACE's version when the game still has them:
 *      clamp the negotiated version with KJReplay.capVersion(v), then call
 *      KJReplay.started(versionPlayed).
 *   5. Drive the fixed-step loop with KJReplay.elapsed(dtMs, capMs) instead of
 *      the raw frame delta, so speed (and 0 = pause) applies to the SIMULATION.
 *   6. Inside the fixed-step loop, BEFORE the step that the live game would
 *      have applied an input to, pull the recorded inputs for that step from a
 *      cursor (KJReplay.cursor(kinds, stepOf)) and apply them through the same
 *      code path a live input takes (without emitting anything new).
 *   7. KJReplay.report(step, score) every frame; the game's normal end path
 *      calls window.__kjSubmit, which in replay mode posts KJ_REPLAY_DONE (the
 *      game should call KJReplay.setStep(step) first so DONE carries the step).
 *
 * Drawing is untouched: a replay IS the real game, fed recorded inputs.
 */
(function (w) {
  'use strict';
  var active = false;
  try { active = new URLSearchParams(w.location.search).get('replay') === '1'; } catch (_e) { active = false; }

  function R() { return w.__kjReplay || null; }
  function post(msg) { try { (w.parent || w).postMessage(msg, '*'); } catch (_e) {} }

  // A replay never shows a tutorial.
  if (active) {
    try {
      if (w.KJTut) { w.KJTut.shouldShow = function () { return false; }; }
    } catch (_e) {}
  }

  var lastReport = -1000;

  var KJReplay = {
    active: function () { return active; },
    loaded: function () { return !!R(); },
    speed: function () { var r = R(); return active ? (r ? r.speed : 0) : 1; },
    version: function () { var r = R(); return r && r.version != null ? Number(r.version) : null; },
    // The negotiated version, lowered to the trace's own when replaying.
    capVersion: function (v) {
      var tv = KJReplay.version();
      if (!active || tv == null || !Number.isFinite(tv)) return v;
      return Math.min(Number(v), tv);
    },
    // The loop's elapsed time, scaled by the playback speed. `capMs` is the
    // game's own catch-up cap; it grows with speed so 4x can really run 4x.
    elapsed: function (dtMs, capMs) {
      if (!active) return Math.min(dtMs, capMs);
      var s = KJReplay.speed();
      if (!(s > 0)) return 0;
      return Math.min(dtMs * s, capMs * Math.max(1, s));
    },
    // Every recorded input payload, in order.
    events: function () {
      var r = R();
      if (!r) return [];
      var out = [];
      for (var i = 0; i < r.events.length; i++) {
        var e = r.events[i];
        if (e && e.payload && typeof e.payload === 'object') out.push(e.payload);
      }
      return out;
    },
    eventsOfKind: function (kinds) {
      var ks = [].concat(kinds);
      return KJReplay.events().filter(function (p) { return ks.indexOf(p.kind) >= 0; });
    },
    // A cursor over the recorded inputs of `kinds`, in trace order.
    // `stepOf(payload)` says the step an input belongs to. due(step) returns
    // (and consumes) every input whose step is <= step.
    cursor: function (kinds, stepOf) {
      var list = KJReplay.eventsOfKind(kinds);
      var i = 0;
      return {
        due: function (step) {
          var out = [];
          while (i < list.length && stepOf(list[i]) <= step) { out.push(list[i]); i++; }
          return out;
        },
        peek: function () { return i < list.length ? list[i] : null; },
        left: function () { return list.length - i; },
        all: function () { return list; },
      };
    },
    // The run began under rules `version`. The viewer warns when that is not
    // the trace's own version (playback may then differ from the run).
    started: function (version) { if (active) post({ type: 'KJ_REPLAY_STARTED', version: version }); },
    setStep: function (step) { var r = R(); if (r) r.lastStep = step; },
    ready: function (gameId) { if (active) post({ type: 'KJ_REPLAY_READY', gameId: gameId }); },
    report: function (step, score) {
      if (!active) return;
      KJReplay.setStep(step);
      // Throttled by STEP, not the clock: about 10 messages a second at 1x.
      if (Math.abs(step - lastReport) < 6) return;
      lastReport = step;
      post({ type: 'KJ_REPLAY_PROGRESS', step: step, score: score });
    },
    // Games normally end through window.__kjSubmit, which posts DONE through
    // the SDK. done() is for a game with no submit on its end path.
    done: function (score, step) {
      if (!active) return;
      KJReplay.setStep(step);
      post({ type: 'KJ_REPLAY_PROGRESS', step: step, score: score });
      post({ type: 'KJ_REPLAY_DONE', score: score, step: step });
    },
  };
  w.KJReplay = KJReplay;
  if (typeof module !== 'undefined' && module.exports) module.exports = KJReplay;
}(typeof window !== 'undefined' ? window : globalThis));
