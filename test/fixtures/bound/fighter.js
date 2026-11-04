// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  BUFFER, updateHitbox,
} from '../../../src/sim/index.js';
import * as E from '../../../src/sim/index.js';
import { RULESET } from './ruleset.js';

const R = RULESET;
export function createCombatant(id, x, z, rules = R.rules, meter = R.meter) {
  return E.createCombatant(id, x, z, rules === R.rules && meter === R.meter ? R : { ...R, rules, meter });
}
export function resetCombatant(f, x, z, rules = R.rules) { return E.resetCombatant(f, x, z, rules); }
export function updateHurtbox(f, rules = R.rules) { return E.updateHurtbox(f, rules); }
