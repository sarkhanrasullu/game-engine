// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  METER_KEYS, RULE_KEYS, buildMeter, buildRules,
} from '../../../src/sim/index.js';
import { RULESET } from './ruleset.js';

/** @type {Readonly<Record<string, number>>} the game's combat rules (RULESET.rules) */
export const FIGHTER_RULES = RULESET.rules;
/** @type {Readonly<Record<string, number>>} the game's meter config (RULESET.meter) */
export const METER_CONFIG = RULESET.meter;
