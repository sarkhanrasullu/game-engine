// Fighter-wide combat rules: schema and validator. The game supplies the values (its tuning data,
// "rules" section) and passes the built table in through the ruleset (ruleset.js). Only the optional
// fight-system keys below hold a default, so a game that ships no data for them still validates.
// Frames are 60 Hz sim ticks; distances are world units.
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
// Optional (RULE_DEFAULTS), design/quick-specs/fight-systems-gap-2026-11-05.md:
//   counterDamageScale / counterHitstunBonus  strike on a defender in its attack's startup or active
//                         frames: damage * scale (rounded), hitstun + bonus ticks
//   punishDamageScale / punishHitstunBonus    the same on a defender in its attack's recovery frames
//   throwTechWindow       unfrozen ticks after a techable throw's hitstop in which the defender may tech it
//   techFrames / techPushback  both fighters' lock (ticks) and push apart (units) on a tech
import { numberTable } from '../core/data.js';

/** Keys of the "rules" section a game may omit, with their defaults. */
export const RULE_DEFAULTS = Object.freeze({
  counterDamageScale: 1.15,
  counterHitstunBonus: 5,
  punishDamageScale: 1.2,
  punishHitstunBonus: 8,
  throwTechWindow: 10,
  techFrames: 12,
  techPushback: 0.6,
});

/** Every key of the "rules" section: the required ones plus RULE_DEFAULTS. */
export const RULE_KEYS = Object.freeze([
  'maxHp', 'hurtRadius', 'hurtHeightStand', 'hurtHeightCrouch', 'inputBufferFrames', 'pushbackFrames',
  'koHitstop', 'koShake', 'koFlash', 'blockShakeScale', ...Object.keys(RULE_DEFAULTS),
]);

/** Throw unless t[k] is >= 0, for each key. */
function requireNonNegative(t, keys, label) {
  for (const k of keys) if (t[k] < 0) throw new Error(`${label}: ${k} must be >= 0`);
}

/** Throw unless t[k] is an integer >= 0, for each key. */
function requireTicks(t, keys, label) {
  for (const k of keys) if (!Number.isInteger(t[k]) || t[k] < 0) throw new Error(`${label}: ${k} must be an integer >= 0`);
}

/**
 * Validate and freeze a "rules" section. Keys in RULE_DEFAULTS may be omitted.
 * @example const rules = buildRules(tuning.rules); rules.maxHp // e.g. 100
 * @param {Record<string, unknown>} json
 */
export function buildRules(json) {
  const r = numberTable(json && { ...RULE_DEFAULTS, ...json }, RULE_KEYS, 'combat rules');
  requireNonNegative(r, ['counterDamageScale', 'punishDamageScale', 'techPushback'], 'combat rules');
  requireTicks(r, ['counterHitstunBonus', 'punishHitstunBonus', 'throwTechWindow'], 'combat rules');
  if (!Number.isInteger(r.techFrames) || r.techFrames < 1) throw new Error('combat rules: techFrames must be an integer >= 1');
  return r;
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
// Optional (METER_DEFAULTS):
//   counterMeterScale     hitDealt multiplier for the attacker on a counter or punish hit
//   techMeter             flat meter each fighter gains on a throw tech
//   ventCost / ventPushback  Vent (a Throw press in own blockstun): meter it spends, units it pushes the attacker
/** Keys of the "meter" section a game may omit, with their defaults. */
export const METER_DEFAULTS = Object.freeze({
  counterMeterScale: 1.5,
  techMeter: 3,
  ventCost: 25,
  ventPushback: 0.9,
});

/** Every key of the "meter" section: the required ones plus METER_DEFAULTS. */
export const METER_KEYS = Object.freeze([
  'max', 'hitDealt', 'blockDealt', 'hitTaken', 'blockTaken', 'throwDealt', 'throwTaken', 'minGain',
  'superFreezeFrames', 'specialDirThreshold', ...Object.keys(METER_DEFAULTS),
]);

/**
 * Validate and freeze a "meter" section. Keys in METER_DEFAULTS may be omitted.
 * @example const meter = buildMeter(tuning.meter); meter.max // e.g. 100
 * @param {Record<string, unknown>} json
 */
export function buildMeter(json) {
  const m = numberTable(json && { ...METER_DEFAULTS, ...json }, METER_KEYS, 'meter');
  requireNonNegative(m, ['counterMeterScale', 'ventPushback'], 'meter');
  requireTicks(m, ['techMeter', 'ventCost'], 'meter');
  if (!Number.isInteger(m.max) || m.max < 1) throw new Error('meter: max must be an integer >= 1');
  if (!Number.isInteger(m.superFreezeFrames) || m.superFreezeFrames < 0) throw new Error('meter: superFreezeFrames must be an integer >= 0');
  return m;
}
