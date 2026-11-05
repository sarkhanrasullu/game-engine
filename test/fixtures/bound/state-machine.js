// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  PHASE, STATE, TRANSITIONS, attackPhase, canTransition, chainAttack, chainMoveId, inOwnOverwind, moveTotal, overwindReady, setState, sidestepCancellable, startAttack, techReady, ventReady,
} from '../../../src/sim/index.js';
import * as E from '../../../src/sim/index.js';
import { RULESET } from './ruleset.js';

const R = RULESET;
export function bufferInput(f, input, rules = R.rules) { return E.bufferInput(f, input, rules); }
export function bufferedMoveId(f, meter = R.meter) { return E.bufferedMoveId(f, meter); }
export function decideFighter(f, opp, input, rules = R.rules, meter = R.meter) { return E.decideFighter(f, opp, input, rules, meter); }
export function advanceFighter(f, rules = R.rules, mcfg = R.movement) { return E.advanceFighter(f, rules, mcfg); }
export function startPushback(f, from, distance, rules = R.rules) { return E.startPushback(f, from, distance, rules); }
export function applyTravel(f, opp, mcfg = R.movement) { return E.applyTravel(f, opp, mcfg); }
