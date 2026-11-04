// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  ROUND_KEYS, buildRoundRules,
} from '../../../src/sim/index.js';
import { RULESET } from './ruleset.js';

/** @type {Readonly<Record<string, number>>} the game's round rules (RULESET.round) */
export const ROUND_RULES = RULESET.round;
