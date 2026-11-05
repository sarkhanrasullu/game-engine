// Ruleset: the one object every sim factory takes instead of reading module-level config.
// The game builds it once from its own tuning data and injects it (createDuel(ruleset),
// createCombatant(id, x, z, ruleset), new MatchFlow({ rules: ruleset.round }),
// new CpuPilot({ rules: ruleset.rules, ... })). Pure: no DOM, no three.js, no data imports.
import { buildRules, buildMeter } from './fighter-config.js';
import { buildMovement } from './movement-config.js';
import { buildMoves } from './moves.js';
import { buildRoundRules } from './match-config.js';
import { buildHazards } from './hazards.js';

/**
 * @typedef {{
 *   rules: Readonly<Record<string, number>>,
 *   movement: Readonly<Record<string, number>>,
 *   moves: Readonly<Record<string, import('./moves.js').MoveData>>,
 *   round: Readonly<Record<string, number>>,
 *   meter: Readonly<Record<string, number>>,
 *   hazards: ReadonlyArray<import('./hazards.js').HazardData>,
 * }} Ruleset
 */

/**
 * Validate every section through its builder and return a frozen Ruleset. Throws on a missing
 * section, an unknown or missing key, or an invalid value (the builders' messages). `hazards` is
 * the one optional section (stage hazards, hazards.js): omitted means none.
 * @example
 *   import tuning from './my-game/combat_tuning.json' with { type: 'json' };
 *   const ruleset = createRuleset({
 *     rules: tuning.rules, movement: tuning.movement, moves: tuning.greyboxMoves,
 *     round: tuning.round, meter: tuning.meter, hazards: stage.hazards,
 *   });
 *   const sim = createDuel(ruleset);
 * @param {{rules: object, movement: object, moves: object, round: object, meter: object, hazards?: object[]}} data
 * @returns {Readonly<Ruleset>}
 */
export function createRuleset({ rules, movement, moves, round, meter, hazards }) {
  return Object.freeze({
    rules: buildRules(rules),
    movement: buildMovement(movement),
    moves: buildMoves(moves),
    round: buildRoundRules(round),
    meter: buildMeter(meter),
    hazards: buildHazards(hazards),
  });
}
