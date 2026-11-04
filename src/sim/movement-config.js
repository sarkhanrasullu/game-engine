// Movement tuning schema. Units: world units, seconds. The game supplies the shared values (its
// tuning data, "movement" section) and per-fighter overrides; the built table travels in the
// ruleset (ruleset.js).
//
// Schema (all numbers):
//   walkSpeed / backSpeed   forward / backward walk speed (units/s)           [per fighter]
//   deadzone                |stick.x| below this is ignored
//   verticalThreshold       stick.y beyond this crouches (down) or jumps (up)
//   jumpSpeed / gravity     jump launch speed (units/s) and fall acceleration  [per fighter]
//   sidestepSpeed           sidestep arc speed (units/s)                       [per fighter]
//   sidestepDuration        sidestep length (s); shared, the pose arc reads it
//   sidestepJumpCancelTime  a double-tap up also jumps on the first tap; a sidestep within this
//                           airtime cancels that jump
//   ringRadius, minSeparation, startOffset   arena geometry (shared so both fighters agree)
import { numberTable } from '../core/data.js';

/** Required keys of the "movement" section. */
export const MOVEMENT_KEYS = Object.freeze([
  'walkSpeed', 'backSpeed', 'deadzone', 'verticalThreshold', 'jumpSpeed', 'gravity', 'sidestepSpeed',
  'sidestepDuration', 'sidestepJumpCancelTime', 'ringRadius', 'minSeparation', 'startOffset',
]);

/** Keys a fighter may override; arena geometry and shared timings stay global. */
export const FIGHTER_MOVEMENT_KEYS = Object.freeze(['walkSpeed', 'backSpeed', 'sidestepSpeed', 'jumpSpeed', 'gravity']);

/**
 * Validate and freeze a shared "movement" section.
 * @example const movement = buildMovement(tuning.movement); movement.ringRadius // e.g. 4
 * @param {Record<string, unknown>} json
 * @returns {Readonly<Record<string, number>>}
 */
export function buildMovement(json) {
  return numberTable(json, MOVEMENT_KEYS, 'combat movement');
}

/**
 * A fighter's full movement config: the shared config with the fighter's overrides applied.
 * Throws on an unknown/shared key or a value that is not a positive finite number.
 * @example const kitMovement = fighterMovement(kitJson.movement, ruleset.movement, 'kit movement');
 * @param {Record<string, unknown>} overrides fighter JSON "movement" section
 * @param {Readonly<Record<string, number>>} base shared movement (ruleset.movement)
 * @param {string} [label]
 */
export function fighterMovement(overrides, base, label = 'fighter movement') {
  const out = { ...base };
  for (const k of Object.keys(overrides ?? {})) {
    if (!FIGHTER_MOVEMENT_KEYS.includes(k)) throw new Error(`${label}: ${k} is not a per-fighter movement key`);
    const v = overrides[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${label}: ${k} must be a positive number`);
    out[k] = v;
  }
  return Object.freeze(out);
}
