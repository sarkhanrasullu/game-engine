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
 *   superPunishChance  chance a full-meter punish spends Overwind instead of the next punish key (§9.2); with a
 *                      full meter this roll also opens the punish itself (a player holding a super looks for it)
 *   superBlockPunishChance  chance, with a full meter, to spend Overwind on the first free tick after
 *                      own blockstun when the blocked attack (already perceived, extrapolated from public
 *                      frame data) leaves an Overwind-sized window (story-011 Normal Overwind rule)
 *   superComebackHp    own HP fraction at or below which a full-meter punish (whiff punish or blocked-attack
 *                      reversal) always spends Overwind (comeback rule; 0 = never). Overwind is never
 *                      thrown out raw in neutral.
 *   hazardEvadeChance  (optional; default 1 - mistakeRate) chance, rolled once per hazard telegraph it
 *                      can see (reactionFrames late), that the CPU steps out of / stays out of a
 *                      telegraphed stage hazard zone (story-013; hazards.js)
 * AI-DEPTH keys (all optional; the default keeps a level file written before them valid):
 *   stringConfirmChance  (default 1 - mistakeRate) chance, rolled once per own attack, to continue a
 *                      Light string (move.cancel) once the opener connected (hit confirm)
 *   pressureChance     (default aggression) chance to press the advantage on the first free tick after
 *                      an own attack landed or was blocked at plus frames (throw a blocker, jab, close in)
 *   disadvantageRespect  (default blockChance) chance to hold guard, instead of pressing, after an own
 *                      attack was blocked at frame disadvantage (public frame data: blockstun vs recovery)
 *   antiAirChance      (default blockChance) chance, rolled once per jump it sees, to answer an airborne
 *                      opponent in reach with the kit's `antiAir` move
 *   counterChance      (default 0) chance, rolled once per incoming strike, to answer it with an own move
 *                      whose armour covers the strike's level and window, instead of blocking
 *   retreatChance      (default 0) chance, after block and sidestep fail, to walk back out of a tip-range
 *                      strike so it whiffs (then the whiff punish applies)
 *   jumpChance         (default 0) chance to jump over a slow throw it sees coming (airborne = unthrowable)
 *   matchupSkill       (default 1) 0..1 how much of the matchup plan (personalities.js buildMatchups) the level
 *                      applies: 1 = the full plan, 0 = none (an Easy CPU knows the matchup less); locked
 * Fight-system keys (optional, default 0 = the level does not use the system; design/quick-specs/
 * fight-systems-gap-2026-11-05.md section 4):
 *   linkChance         chance, rolled once per own counter or punish hit, to link the next move when the
 *                      defender's remaining stun (public frame data) covers its startup
 *   stepPunishChance   chance, rolled once per attack seen in recovery while the CPU is in a sidestep, to
 *                      attack out of the step (the whiff punish key choice); without it the step runs out
 *   throwTechChance    chance, rolled once per grab reactionFrames after it connects, to press Throw and
 *                      break it (never a move whose frame data says techable: false)
 *   ventChance         chance, rolled once per attack that has the CPU in blockstun, to Vent: only with the meter
 *                      for it and only against a move it could not punish instead
 */
export const DIFFICULTY_KEYS = Object.freeze([
  'reactionFrames', 'decisionFrames', 'blockChance', 'sidestepChance', 'whiffPunishChance',
  'throwChance', 'aggression', 'mistakeRate', 'specialShare', 'superPunishChance', 'superBlockPunishChance',
  'superComebackHp', 'hazardEvadeChance', 'stringConfirmChance', 'pressureChance', 'disadvantageRespect',
  'antiAirChance', 'counterChance', 'retreatChance', 'jumpChance', 'matchupSkill', 'linkChance', 'stepPunishChance', 'throwTechChance', 'ventChance',
]);

/** Default of each optional level key, from the required keys. */
const DIFFICULTY_DEFAULTS = Object.freeze({
  hazardEvadeChance: (t) => 1 - t.mistakeRate,
  stringConfirmChance: (t) => 1 - t.mistakeRate,
  pressureChance: (t) => t.aggression,
  disadvantageRespect: (t) => t.blockChance,
  antiAirChance: (t) => t.blockChance,
  counterChance: () => 0,
  retreatChance: () => 0,
  jumpChance: () => 0,
  matchupSkill: () => 1,
  linkChance: () => 0,
  stepPunishChance: () => 0,
  throwTechChance: () => 0,
  ventChance: () => 0,
});

/** Difficulty keys a level file may omit (filled with a derived default by buildDifficulty). */
export const OPTIONAL_DIFFICULTY_KEYS = Object.freeze(Object.keys(DIFFICULTY_DEFAULTS));
const REQUIRED_DIFFICULTY_KEYS = Object.freeze(DIFFICULTY_KEYS.filter((k) => !OPTIONAL_DIFFICULTY_KEYS.includes(k)));

/** Keys that are probabilities and must lie in 0..1. */
export const UNIT_KEYS = Object.freeze([
  'blockChance', 'sidestepChance', 'whiffPunishChance', 'throwChance', 'aggression', 'mistakeRate',
  'specialShare', 'superPunishChance', 'superBlockPunishChance', 'superComebackHp', ...OPTIONAL_DIFFICULTY_KEYS,
  'rangeBias', 'tipPatience',
]);

/**
 * Shared decision tuning (same for every level).
 *   reachMargin       units shaved off the CPU's own reach before it pokes (avoids tip whiffs)
 *   threatMargin      units added to the opponent's reach when judging an attack a threat
 *   ringEdgeMargin    a back-off this close to the ring edge becomes a sidestep
 *   heavyPokeShare / lowPokeShare   share of pokes that are Heavy / crouching Light
 *   waitWeight, guardWeight, backOffWeight, sidestepWeight   neutral utility weights
 *   planJitterFrames  random extra ticks (0..n-1) added to a plan's length
 *   rangeBias         (optional, default 1) 0..1 preferred neutral range between the kit's close range
 *                     (the longer of Light and throw reach) and its longest poke; the CPU walks in
 *                     above it and backs off below it (AI-DEPTH spacing; personalities rescale it)
 *   rangeBand         (optional, default 0.15) units either side of the preferred range it is content in
 *   jumpWeight        (optional, default 0) neutral utility weight of a jump
 *   tipPatience       (optional, default 1) 0..1 share of the tip-poke weight kept while nobody is stepping in
 *                     (1 = poke from the tip regardless; lower = wait at the tip for the step-in)
 *   pokeKeys          (string list, not a number) move-input keys the CPU may poke with in neutral;
 *                     its poke range is the longest of these against the opponent's body radius
 */
export const BEHAVIOUR_KEYS = Object.freeze([
  'reachMargin', 'threatMargin', 'ringEdgeMargin', 'heavyPokeShare', 'lowPokeShare', 'waitWeight',
  'guardWeight', 'backOffWeight', 'sidestepWeight', 'planJitterFrames', 'rangeBias', 'rangeBand', 'jumpWeight',
  'tipPatience',
]);

/** Behaviour keys a file may omit, with their defaults. */
export const BEHAVIOUR_DEFAULTS = Object.freeze({ rangeBias: 1, rangeBand: 0.15, jumpWeight: 0, tipPatience: 1 });

/** Move-input keys allowed in behaviour.pokeKeys (neutral pokes; throws and Overwind are not pokes). */
export const POKEABLE_KEYS = Object.freeze(['light', 'heavy', 'crouchLight', 'crouchHeavy']);

/**
 * Validate one difficulty level. Throws on a missing/unknown key or an out-of-range value.
 * Optional keys (OPTIONAL_DIFFICULTY_KEYS) are filled from the required ones.
 * @param {Record<string, unknown>} src
 * @param {string} [label]
 * @returns {Readonly<Record<string, number>>}
 */
export function buildDifficulty(src, label = 'ai difficulty') {
  if (!src || typeof src !== 'object') throw new Error(`${label}: missing section`);
  const required = {};
  const optional = {};
  for (const k of Object.keys(src)) (Object.hasOwn(DIFFICULTY_DEFAULTS, k) ? optional : required)[k] = src[k];
  const base = numberTable(required, REQUIRED_DIFFICULTY_KEYS, label);
  /** @type {Record<string, number>} */
  const t = {};
  for (const k of DIFFICULTY_KEYS) {
    if (!Object.hasOwn(DIFFICULTY_DEFAULTS, k)) t[k] = base[k];
    else if (optional[k] === undefined) t[k] = DIFFICULTY_DEFAULTS[k](base);
    else if (typeof optional[k] !== 'number' || !Number.isFinite(optional[k])) throw new Error(`${label}: ${k} must be a finite number`);
    else t[k] = optional[k];
  }
  for (const k of UNIT_KEYS) {
    if (Object.hasOwn(t, k) && (t[k] < 0 || t[k] > 1)) throw new Error(`${label}: ${k} must be in 0..1`);
  }
  if (!Number.isInteger(t.reactionFrames) || t.reactionFrames < 0) throw new Error(`${label}: reactionFrames must be an integer >= 0`);
  if (!Number.isInteger(t.decisionFrames) || t.decisionFrames < 1) throw new Error(`${label}: decisionFrames must be an integer >= 1`);
  return Object.freeze(t);
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
  const t = numberTable({ ...BEHAVIOUR_DEFAULTS, ...numbers }, BEHAVIOUR_KEYS, label);
  for (const k of BEHAVIOUR_KEYS) {
    if (t[k] < 0) throw new Error(`${label}: ${k} must be >= 0`);
  }
  if (t.rangeBias > 1) throw new Error(`${label}: rangeBias must be in 0..1`);
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
