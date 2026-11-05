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
//   sidestepCancelSeconds   (optional, MOVEMENT_DEFAULTS) time into a sidestep from which it may be cancelled
//                           into an attack or guard (s)                        [per fighter]
//   sidestepJumpCancelTime  a double-tap up also jumps on the first tap; a sidestep within this
//                           airtime cancels that jump
//   ringRadius, minSeparation, startOffset   arena geometry (shared so both fighters agree)
import { numberTable } from '../core/data.js';

/**
 * Keys of the "movement" section a game may omit, with their defaults
 * (design/quick-specs/fight-systems-gap-2026-11-05.md P4).
 */
export const MOVEMENT_DEFAULTS = Object.freeze({ sidestepCancelSeconds: 0.13 });

/** Every key of the "movement" section: the required ones plus MOVEMENT_DEFAULTS. */
export const MOVEMENT_KEYS = Object.freeze([
  'walkSpeed', 'backSpeed', 'deadzone', 'verticalThreshold', 'jumpSpeed', 'gravity', 'sidestepSpeed',
  'sidestepDuration', 'sidestepJumpCancelTime', 'ringRadius', 'minSeparation', 'startOffset',
  ...Object.keys(MOVEMENT_DEFAULTS),
]);

/** Keys a fighter may override; arena geometry and shared timings stay global. */
export const FIGHTER_MOVEMENT_KEYS = Object.freeze(['walkSpeed', 'backSpeed', 'sidestepSpeed', 'jumpSpeed', 'gravity', 'sidestepCancelSeconds']);

/**
 * Validate and freeze a shared "movement" section. Keys in MOVEMENT_DEFAULTS may be omitted.
 * @example const movement = buildMovement(tuning.movement); movement.ringRadius // e.g. 4
 * @param {Record<string, unknown>} json
 * @returns {Readonly<Record<string, number>>}
 */
export function buildMovement(json) {
  const m = numberTable(json && { ...MOVEMENT_DEFAULTS, ...json }, MOVEMENT_KEYS, 'combat movement');
  if (m.sidestepCancelSeconds <= 0) throw new Error('combat movement: sidestepCancelSeconds must be > 0');
  return m;
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
