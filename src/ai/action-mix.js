// CPU action-mix stat (story-011 AC 2 "action mix differs by >= 20%"; AI debug readout). Counts what
// a CpuPilot chose to do, by category, from its onDecision hook. Non-choices (KO, hitstun,
// blockstun, walking in to punish) are not counted. Pure, DOM-free.
import { PLAN, REASON } from './cpu-controller.js';

/** Action categories, in report order. */
export const ACTIONS = Object.freeze([
  'wait', 'approach', 'backOff', 'guard', 'sidestep', 'poke', 'heavy', 'throw', 'special', 'punish', 'overwind',
]);

/**
 * Category of one CpuPilot decision, or null when it is not a choice.
 * @param {string} reason a PLAN or REASON value
 * @param {string|null} key poke / special / punish key behind the reason
 * @returns {string|null}
 */
export function actionOf(reason, key) {
  switch (reason) {
    case PLAN.WAIT: return 'wait';
    case PLAN.APPROACH: return 'approach';
    case PLAN.BACK_OFF: return 'backOff';
    case PLAN.GUARD: case REASON.BLOCK: return 'guard';
    case PLAN.SIDESTEP: case REASON.EVADE: return 'sidestep';
    case PLAN.POKE: return key === 'heavy' ? 'heavy' : 'poke';
    case PLAN.THROW: return 'throw';
    case PLAN.SPECIAL: return 'special';
    case REASON.PUNISH: return key === null ? null : key === 'overwind' ? 'overwind' : 'punish';
    default: return null;
  }
}

/** Running count of a CPU's decisions per ACTIONS category. */
export class ActionMix {
  constructor() {
    /** @type {Record<string, number>} */
    this.counts = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
    this.total = 0;
  }

  /** Count one decision; use as `onDecision: (frame, reason, key) => mix.add(reason, key)`. */
  add(reason, key) {
    const a = actionOf(reason, key);
    if (a === null) return;
    this.counts[a]++;
    this.total++;
  }

  /** @param {string} action @returns {number} share of all counted decisions, 0..1 */
  share(action) {
    return this.total > 0 ? this.counts[action] / this.total : 0;
  }

  /**
   * Total variation distance to `other` (0 = same mix, 1 = disjoint): the share of decisions that
   * would have to change category to turn one mix into the other.
   * @param {ActionMix} other
   */
  distance(other) {
    let sum = 0;
    for (const a of ACTIONS) sum += Math.abs(this.share(a) - other.share(a));
    return sum / 2;
  }
}
