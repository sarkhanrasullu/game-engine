// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  createFighter,
} from '../../../src/sim/index.js';
import * as E from '../../../src/sim/index.js';
import { RULESET } from './ruleset.js';

export function stepFighter(f, opp, input, dt, cfg = RULESET.movement) { return E.stepFighter(f, opp, input, dt, cfg); }
