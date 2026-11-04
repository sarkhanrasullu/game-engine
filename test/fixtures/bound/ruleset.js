// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
import COMBAT from '../combat_tuning.json' with { type: 'json' };
import { createRuleset } from '../../../src/sim/index.js';

/**
 * The fixture ruleset: rules, movement, fallback greybox moves, round and meter sections.
 * @example const sim = createDuel(RULESET); const flow = new MatchFlow({ rules: RULESET.round });
 */
export const RULESET = createRuleset({
  rules: COMBAT.rules,
  movement: COMBAT.movement,
  moves: COMBAT.greyboxMoves,
  round: COMBAT.round,
  meter: COMBAT.meter,
});

/**
 * Fill every `undefined` key of `opts` from `defaults` (default-parameter semantics: only
 * undefined falls back, null is kept). Used by the re-export shims that bind game defaults.
 * @example withDefaults({ rules: undefined, seed: 3 }, { rules: RULESET.rules }) // { rules: RULESET.rules, seed: 3 }
 * @template T
 * @param {Partial<T> | undefined} opts @param {T} defaults
 * @returns {T}
 */
export function withDefaults(opts, defaults) {
  const out = { ...defaults, ...(opts ?? {}) };
  for (const k of Object.keys(defaults)) if (out[k] === undefined) out[k] = defaults[k];
  return out;
}
