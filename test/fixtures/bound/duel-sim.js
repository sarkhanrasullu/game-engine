// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  CONNECT, CUE, EVENT, armorAbsorbs, resetDuel, resetMeters, resolveHits, stepDuel, validateMoveTable,
} from '../../../src/sim/index.js';
import * as E from '../../../src/sim/index.js';
import { RULESET, withDefaults } from './ruleset.js';

/** createDuel with the game's ruleset filling any section not given ({rules, movement, meter}). */
export function createDuel(opts) {
  return E.createDuel(opts === undefined ? RULESET : withDefaults(opts, RULESET));
}
export function connectResult(a, b, rules = RULESET.rules) { return E.connectResult(a, b, rules); }
