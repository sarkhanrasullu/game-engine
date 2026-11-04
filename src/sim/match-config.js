// Round / match tuning schema and validator. The game supplies the values (its tuning data,
// "round" section); the built table travels in the ruleset (ruleset.js).
// All times are seconds of real (unscaled) time.
//
// Schema (all numbers):
//   roundsToWin      round wins that take the match (2 = best of 3)
//   maxRounds        hard cap on rounds played (draws can push past 3); at the cap the higher
//                    win count takes the match, equal counts make the match a draw
//   drawScoresBoth   1: a drawn round scores a win for both fighters; 0: it scores for neither
//   introSeconds     wind-up countdown before each round; inputs are locked until it ends
//   roundSeconds     round timer; at 0 the higher HP% wins, equal HP% is a drawn round
//   koSlowMoSeconds  slow-motion window right after a KO (inside roundEndSeconds)
//   koSlowMoScale    sim time scale during that window (0 < scale <= 1)
//   roundEndSeconds  hold after a KO / time-out before the next round or the match end
//   matchEndSeconds  hold after the deciding round's end before the result screen
import { numberTable } from '../core/data.js';

/** Required keys of the "round" section. */
export const ROUND_KEYS = Object.freeze([
  'roundsToWin', 'maxRounds', 'drawScoresBoth', 'introSeconds', 'roundSeconds',
  'koSlowMoSeconds', 'koSlowMoScale', 'roundEndSeconds', 'matchEndSeconds',
]);

/**
 * Validate and freeze a "round" section. Throws on a missing/unknown key or an impossible value.
 * @example const round = buildRoundRules(tuning.round); round.roundsToWin // e.g. 2
 * @param {Record<string, unknown>} json
 * @returns {Readonly<Record<string, number>>}
 */
export function buildRoundRules(json) {
  const r = numberTable(json, ROUND_KEYS, 'round rules');
  const fail = (msg) => { throw new Error(`round rules: ${msg}`); };
  if (!Number.isInteger(r.roundsToWin) || r.roundsToWin < 1) fail('roundsToWin must be an integer >= 1');
  if (!Number.isInteger(r.maxRounds) || r.maxRounds < 2 * r.roundsToWin - 1) {
    fail('maxRounds must be an integer >= 2 * roundsToWin - 1');
  }
  if (r.drawScoresBoth !== 0 && r.drawScoresBoth !== 1) fail('drawScoresBoth must be 0 or 1');
  if (!(r.introSeconds > 0)) fail('introSeconds must be > 0');
  if (!(r.roundSeconds > 0)) fail('roundSeconds must be > 0');
  if (!(r.koSlowMoScale > 0 && r.koSlowMoScale <= 1)) fail('koSlowMoScale must be in (0, 1]');
  if (!(r.koSlowMoSeconds >= 0 && r.koSlowMoSeconds <= r.roundEndSeconds)) {
    fail('koSlowMoSeconds must be in [0, roundEndSeconds]');
  }
  if (!(r.matchEndSeconds >= 0)) fail('matchEndSeconds must be >= 0');
  return r;
}
