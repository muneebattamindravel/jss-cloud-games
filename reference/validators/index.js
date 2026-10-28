'use strict';

/**
 * Per-game anti-cheat validator registry.
 *
 * Each game id maps to a validator module that exports:
 *   init({ seed, maxDurationSecs, range, gameMeta }) → state
 *   processEvent(state, event) → { accepted, newScore, reason? }
 *   finalize(state) → { score, gameOver, suspicious? }
 *   simulate(seed, inputs) → finalScore   (used by replay-trace re-verify)
 *
 * Games not in the map are unsupported. There is no fallback: the v1 session
 * path (a client score written straight to the leaderboard under an HMAC) was
 * deleted on 9 Sep 2026, so a game with no validator here has no way for a
 * score to become real at all. Registering one is part of adding a game.
 */

const validators = {
  'sky-tower':  require('./skyTower'),
  'patli-gali': require('./patliGali'),
  'epic-slicer':  require('./epicSlicer'),
  'orbit-runner':   require('./orbitRunner'),
  'boom-patakha':    require('./boomPatakha'),
  'pulse':        require('./pulse'),
  'twist-fall':   require('./twistFall'),
  'cannon-rush':   require('./cannonRush'),
  'smash-down':  require('./smashDown'),
  'rickshaw-run': require('./rickshawRun'),
  'save-the-birdie': require('./saveTheBirdie'),
  'block-blast': require('./blockBlast'),
  'bubble-shooter': require('./bubbleShooter'),
  'stick-hero': require('./stickHero'),
  'bakri-dash': require('./bakriDash'),
  'drifty-car': require('./driftyCar'),
  'gannay-wala': require('./gannayWala'),
  'hex-rush': require('./hexRush'),
  'do-gaari': require('./doGaari'),
  'tappa': require('./tappa'),
  'duet': require('./duet'),
  'sky-racer': require('./skyRacer'),
  'galaxy-ride': require('./galaxyRide'),
  // Old id, kept so a run started before migration 191 still scores. Remove later.
  'sky-ride': require('./galaxyRide'),
  'stairs': require('./stairs'),
  'snake-blocks': require('./snakeBlocks'),
  'ulta-pulta': require('./ultaPulta'),
  'kaanch': require('./kaanch'),
  'rush-2048': require('./rush2048'),
  'raftaar': require('./raftaar'),
  'saanp': require('./saanp'),
  'jhoola': require('./jhoola'),
  'bo-kaata': require('./boKaata'),
  'mini-golf': require('./miniGolf'),
  'lattoo': require('./lattoo'),
  'oh-bhains': require('./ohBhains'),
  'jelly-jump': require('./jellyJump'),
  'jelly-jhoom': require('./jellyJhoom'),
  'color-dunk': require('./colorDunk'),
  'brick-breaker': require('./brickBreaker'),
  'roller-rani': require('./rollerRani'),
  'fruit-merge': require('./fruitMerge'),
  'dots-reflexes': require('./dotsReflexes'),
  'draw-climber': require('./drawClimber'),
  'into-the-haze': require('./intoTheHaze'),
  'crazy-motorway': require('./crazyMotorway'),
  'chor-police': require('./chorPolice'),
  'chakkar-chaku': require('./chakkarChaku'),
  'dart-champ': require('./dartChamp'),
  'rail-junction': require('./railJunction'),
  'ramp-ball': require('./rampBall'),
  'carrom-king': require('./carromKing'),
};

function getValidator(gameId) {
  return validators[gameId] || null;
}

function requireValidator(gameId) {
  const v = validators[gameId];
  if (!v) throw new Error(`No validator registered for game: ${gameId}`);
  return v;
}

function listGameIds() {
  return Object.keys(validators);
}

module.exports = {
  getValidator,
  requireValidator,
  listGameIds,
};
