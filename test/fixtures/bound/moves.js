// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  AI_ROLES, GUARD_TABLE, MOVE_INPUTS, chainLength, validateMoveTable,
} from '../../../src/sim/index.js';
import { RULESET } from './ruleset.js';

/** The game's greybox fallback move set (RULESET.moves). */
export const MOVES = RULESET.moves;
