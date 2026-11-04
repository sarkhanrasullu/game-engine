// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  MATCH_EVENT, MATCH_STATE, ROUND_REASON, roundWinner,
} from '../../../src/sim/index.js';
import { MatchFlow as EngineMatchFlow } from '../../../src/sim/index.js';
import { RULESET } from './ruleset.js';

/** Engine MatchFlow with the game's round rules as the default. */
export class MatchFlow extends EngineMatchFlow {
  constructor({ rules = RULESET.round, onMatchEnd = null } = {}) {
    super({ rules, onMatchEnd });
  }
}
