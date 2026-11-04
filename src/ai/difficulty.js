// CPU difficulty schema (story-004 AC 2): validates the game's difficulty data (levels + shared
// behaviour) at the data boundary and resolves a `?cpu=<level>` URL parameter. Pure: no DOM, no
// three.js, no data imports: the game passes its parsed JSON to buildDifficultySet.
import { numberTable } from '../core/data.js';

/**
 * Per-level keys (the only thing that differs between Easy, Normal and Hard).
 *   reactionFrames     ticks between the opponent doing something and the CPU seeing it
 *   decisionFrames     ticks a neutral plan (approach, poke, guard...) is kept before re-rolling
 *   blockChance        chance to guard an attack it sees coming in range (rolled once per attack);
 *                      also scales how often it guards pre-emptively in the opponent's range
 *   sidestepChance     chance to sidestep an unblocked incoming attack; also scales neutral sidesteps
 *   whiffPunishChance  chance to punish an attack it sees in recovery (rolled once per attack)
 *   throwChance        chance to throw a guarding opponent in throw range
 *   aggression         0..1 bias toward approaching and poking over waiting, guarding, backing off
 *   mistakeRate        chance a neutral decision ignores spacing and picks any plan at random
 *   specialShare       chance a neutral decision becomes a special when one fits by aiRole (story-009 §9.3)
 *   superPunishChance  chance a full-meter punish spends Overwind instead of the next punish key (§9.2)
 *   superBlockPunishChance  chance, with a full meter, to spend Overwind on the first free tick after
 *                      own blockstun when the blocked attack (already perceived, extrapolated from public
 *                      frame data) leaves an Overwind-sized window (story-011 Normal Overwind rule)
 *   superComebackHp    own HP fraction at or below which a full-meter punish (whiff punish or blocked-attack
 *                      reversal) always spends Overwind (comeback rule; 0 = never). Overwind is never
 *                      thrown out raw in neutral.
 */
export const DIFFICULTY_KEYS = Object.freeze([
  'reactionFrames', 'decisionFrames', 'blockChance', 'sidestepChance', 'whiffPunishChance',
  'throwChance', 'aggression', 'mistakeRate', 'specialShare', 'superPunishChance', 'superBlockPunishChance',
  'superComebackHp',
]);

/** Keys that are probabilities and must lie in 0..1. */
export const UNIT_KEYS = Object.freeze([
  'blockChance', 'sidestepChance', 'whiffPunishChance', 'throwChance', 'aggression', 'mistakeRate',
  'specialShare', 'superPunishChance', 'superBlockPunishChance', 'superComebackHp',
]);

/**
 * Shared decision tuning (same for every level).
 *   reachMargin       units shaved off the CPU's own reach before it pokes (avoids tip whiffs)
 *   threatMargin      units added to the opponent's reach when judging an attack a threat
 *   ringEdgeMargin    a back-off this close to the ring edge becomes a sidestep
 *   heavyPokeShare / lowPokeShare   share of pokes that are Heavy / crouching Light
 *   waitWeight, guardWeight, backOffWeight, sidestepWeight   neutral utility weights
 *   planJitterFrames  random extra ticks (0..n-1) added to a plan's length
 *   pokeKeys          (string list, not a number) move-input keys the CPU may poke with in neutral;
 *                     its poke range is the longest of these against the opponent's body radius
 */
export const BEHAVIOUR_KEYS = Object.freeze([
  'reachMargin', 'threatMargin', 'ringEdgeMargin', 'heavyPokeShare', 'lowPokeShare', 'waitWeight',
  'guardWeight', 'backOffWeight', 'sidestepWeight', 'planJitterFrames',
]);

/** Move-input keys allowed in behaviour.pokeKeys (neutral pokes; throws and Overwind are not pokes). */
export const POKEABLE_KEYS = Object.freeze(['light', 'heavy', 'crouchLight', 'crouchHeavy']);

/**
 * Validate one difficulty level. Throws on a missing/unknown key or an out-of-range value.
 * @param {Record<string, unknown>} src
 * @param {string} [label]
 * @returns {Readonly<Record<string, number>>}
 */
export function buildDifficulty(src, label = 'ai difficulty') {
  const t = numberTable(src, DIFFICULTY_KEYS, label);
  for (const k of UNIT_KEYS) {
    if (t[k] < 0 || t[k] > 1) throw new Error(`${label}: ${k} must be in 0..1`);
  }
  if (!Number.isInteger(t.reactionFrames) || t.reactionFrames < 0) throw new Error(`${label}: reactionFrames must be an integer >= 0`);
  if (!Number.isInteger(t.decisionFrames) || t.decisionFrames < 1) throw new Error(`${label}: decisionFrames must be an integer >= 1`);
  return t;
}

/**
 * Validate the shared behaviour section.
 * @param {Record<string, unknown>} src
 * @returns {Readonly<Record<string, number> & { pokeKeys: readonly string[] }>}
 */
export function buildBehaviour(src, label = 'ai behaviour') {
  if (!src || typeof src !== 'object') throw new Error(`${label}: missing section`);
  const { pokeKeys, ...numbers } = src;
  if (!Array.isArray(pokeKeys) || pokeKeys.length === 0) throw new Error(`${label}: pokeKeys must be a non-empty list`);
  for (const k of pokeKeys) {
    if (!POKEABLE_KEYS.includes(k)) throw new Error(`${label}: pokeKeys has unknown key ${k}`);
  }
  if (new Set(pokeKeys).size !== pokeKeys.length) throw new Error(`${label}: pokeKeys has a duplicate`);
  const t = numberTable(numbers, BEHAVIOUR_KEYS, label);
  for (const k of BEHAVIOUR_KEYS) {
    if (t[k] < 0) throw new Error(`${label}: ${k} must be >= 0`);
  }
  if (t.heavyPokeShare + t.lowPokeShare > 1) throw new Error(`${label}: heavyPokeShare + lowPokeShare must be <= 1`);
  if (!Number.isInteger(t.planJitterFrames) || t.planJitterFrames < 1) throw new Error(`${label}: planJitterFrames must be an integer >= 1`);
  return Object.freeze({ ...t, pokeKeys: Object.freeze([...pokeKeys]) });
}

/**
 * Validate a whole difficulty file: `{ behaviour, levels: {<name>: level}, default: <name> }`.
 * Every name in `names` must have a valid level; `default` must be one of `names`.
 * @example
 *   const ai = buildDifficultySet(aiJson, ['easy', 'normal', 'hard']);
 *   ai.levels[ai.defaultName].reactionFrames; ai.behaviour.pokeKeys;
 * @param {any} json parsed difficulty data
 * @param {readonly string[]} names level names in menu order
 * @returns {Readonly<{names: readonly string[], behaviour: ReturnType<typeof buildBehaviour>,
 *   levels: Readonly<Record<string, Readonly<Record<string, number>>>>, defaultName: string}>}
 */
export function buildDifficultySet(json, names) {
  const behaviour = buildBehaviour(json.behaviour);
  const levels = Object.freeze(Object.fromEntries(
    names.map((n) => [n, buildDifficulty(json.levels?.[n], `ai difficulty ${n}`)]),
  ));
  if (!names.includes(json.default)) throw new Error(`ai difficulty: default ${json.default} is not a level`);
  return Object.freeze({ names: Object.freeze([...names]), behaviour, levels, defaultName: json.default });
}

/**
 * Difficulty name from a URL query string (`?cpu=<name>`, case-insensitive).
 * Missing or unknown values fall back to `fallback`.
 * @example difficultyFromQuery('?cpu=HARD', ['easy', 'normal', 'hard'], 'normal') // 'hard'
 * @param {string} search e.g. location.search
 * @param {readonly string[]} names known level names
 * @param {string} fallback level used when the parameter is missing or unknown
 * @returns {string}
 */
export function difficultyFromQuery(search, names, fallback) {
  const v = (new URLSearchParams(search).get('cpu') ?? '').toLowerCase();
  return names.includes(v) ? v : fallback;
}
