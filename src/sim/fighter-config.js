// Fighter-wide combat rules: schema and validator. The game supplies the values (its tuning data,
// "rules" section) and passes the built table in through the ruleset (ruleset.js); no module here
// holds a default. Frames are 60 Hz sim ticks; distances are world units.
//
// Schema (all numbers):
//   maxHp                 HP at round start
//   hurtRadius            greybox hurtbox: upright cylinder radius at the feet
//   hurtHeightStand/Crouch greybox hurtbox height standing / crouching (kits use pose hurtboxes)
//   inputBufferFrames     ticks a Light/Heavy/Throw press is remembered while the fighter is busy
//   pushbackFrames        ticks a pushback/knockback distance is spread over
//   koHitstop             freeze ticks on a KO hit (replaces the move's hitstop when larger)
//   koShake / koFlash     camera-shake / screen-flash intensity (0..1) emitted with a KO
//   blockShakeScale       camera-shake scale on block relative to the move's hit shake
import { numberTable } from '../core/data.js';

/** Required keys of the "rules" section. */
export const RULE_KEYS = Object.freeze([
  'maxHp', 'hurtRadius', 'hurtHeightStand', 'hurtHeightCrouch', 'inputBufferFrames', 'pushbackFrames',
  'koHitstop', 'koShake', 'koFlash', 'blockShakeScale',
]);

/**
 * Validate and freeze a "rules" section.
 * @example const rules = buildRules(tuning.rules); rules.maxHp // e.g. 100
 * @param {Record<string, unknown>} json
 */
export function buildRules(json) {
  return numberTable(json, RULE_KEYS, 'combat rules');
}

// Super meter: schema and validator ("meter" section of the game's tuning data).
// gain per contact = max(minGain, round(rate * D)).
//   max                   full meter (Overwind needs meter >= max)
//   hitDealt / hitTaken   strike hit (and armour absorb) rates, attacker / defender
//   blockDealt / blockTaken strike blocked rates (D = the move's damage; no chip)
//   throwDealt / throwTaken throw rates
//   minGain               smallest gain of any contact
//   superFreezeFrames     ticks both fighters (and their timers) freeze on Overwind frame 1
//   specialDirThreshold   |stick.x| at the Heavy press that selects specialForward / specialBack
/** Required keys of the "meter" section. */
export const METER_KEYS = Object.freeze([
  'max', 'hitDealt', 'blockDealt', 'hitTaken', 'blockTaken', 'throwDealt', 'throwTaken', 'minGain',
  'superFreezeFrames', 'specialDirThreshold',
]);

/**
 * Validate and freeze a "meter" section.
 * @example const meter = buildMeter(tuning.meter); meter.max // e.g. 100
 * @param {Record<string, unknown>} json
 */
export function buildMeter(json) {
  const m = numberTable(json, METER_KEYS, 'meter');
  if (!Number.isInteger(m.max) || m.max < 1) throw new Error('meter: max must be an integer >= 1');
  if (!Number.isInteger(m.superFreezeFrames) || m.superFreezeFrames < 0) throw new Error('meter: superFreezeFrames must be an integer >= 0');
  return m;
}
