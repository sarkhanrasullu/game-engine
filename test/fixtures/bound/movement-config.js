// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  FIGHTER_MOVEMENT_KEYS, MOVEMENT_KEYS,
} from '../../../src/sim/index.js';
import { fighterMovement as engineFighterMovement } from '../../../src/sim/index.js';
import { RULESET } from './ruleset.js';

/** @type {Readonly<Record<string, number>>} the game's shared movement (RULESET.movement) */
export const MOVEMENT_CONFIG = RULESET.movement;

/** Engine fighterMovement with the game's shared movement as the default base. */
export function fighterMovement(overrides, base = MOVEMENT_CONFIG, label = 'fighter movement') {
  return engineFighterMovement(overrides, base, label);
}
