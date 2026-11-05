// CPU personalities (story-011): data profiles (the game's personality JSON) that layer a
// play style on top of a difficulty level. A personality only rescales (scale) or replaces (set)
// the level and behaviour numbers the utility AI already reads, so it adds no new decision path
// and no new information: reaction delay, input-snapshot-only control and public-state perception
// stay exactly as the level defines them (LOCKED_KEYS). Pure: no DOM, no three.js; all work happens
// once when a pilot is built, never per tick.
import {
  DIFFICULTY_KEYS, BEHAVIOUR_KEYS, UNIT_KEYS, buildDifficulty, buildBehaviour,
} from './difficulty.js';

/**
 * Keys no personality may change: the fairness rules (reaction delay) and the level's skill tier
 * (decision tempo, mistakes, spacing calibration).
 */
export const LOCKED_KEYS = Object.freeze([
  'reactionFrames', 'decisionFrames', 'mistakeRate', 'hazardEvadeChance', 'matchupSkill', 'planJitterFrames',
  'reachMargin', 'threatMargin', 'ringEdgeMargin',
]);

/** Keys a personality may scale or set: every numeric AI key that is not locked (derived). */
export const STYLE_KEYS = Object.freeze(
  [...DIFFICULTY_KEYS, ...BEHAVIOUR_KEYS].filter((k) => !LOCKED_KEYS.includes(k)),
);

const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** JSON (snake_case) key -> AI (camelCase) key, for every numeric AI key. */
const FROM_JSON = Object.freeze(Object.fromEntries(
  [...DIFFICULTY_KEYS, ...BEHAVIOUR_KEYS].map((k) => [snake(k), k]),
));
const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Validate one key table of a personality (`scale` or `set`) and convert it to camelCase keys.
 * @param {unknown} src
 * @param {string} label
 * @param {boolean} isScale multipliers must be >= 0
 */
function keyTable(src, label, isScale) {
  if (src === undefined) return Object.freeze({});
  if (src === null || typeof src !== 'object' || Array.isArray(src)) throw new Error(`${label}: must be an object`);
  /** @type {Record<string, number>} */
  const out = {};
  for (const [jk, v] of Object.entries(src)) {
    const k = FROM_JSON[jk];
    if (k === undefined) throw new Error(`${label}: unknown key ${jk}`);
    if (LOCKED_KEYS.includes(k)) throw new Error(`${label}: ${jk} is locked (fairness / skill tier)`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label}: ${jk} must be a finite number`);
    if (isScale && v < 0) throw new Error(`${label}: ${jk} must be >= 0`);
    out[k] = v;
  }
  return Object.freeze(out);
}

/**
 * Validate one personality entry. The entry holds no display name: player-facing names belong in
 * the game's strings, keyed by id, so a `name` field is rejected as unknown.
 * @param {string} id personalityId (lowercase, digits, underscores)
 * @param {any} src
 * @returns {Readonly<{id: string, summary: string, scale: Readonly<Record<string, number>>,
 *   set: Readonly<Record<string, number>>}>}
 */
export function buildPersonality(id, src, label = `ai personality ${id}`) {
  if (!ID_PATTERN.test(id)) throw new Error(`${label}: id must match ${ID_PATTERN}`);
  if (!src || typeof src !== 'object') throw new Error(`${label}: missing entry`);
  for (const k of Object.keys(src)) {
    if (!['summary', 'scale', 'set'].includes(k)) throw new Error(`${label}: unknown field ${k}`);
  }
  if (typeof src.summary !== 'string' || src.summary.length === 0) throw new Error(`${label}: summary must be a non-empty string`);
  const scale = keyTable(src.scale, `${label} scale`, true);
  const set = keyTable(src.set, `${label} set`, false);
  for (const k of Object.keys(set)) {
    if (Object.hasOwn(scale, k)) throw new Error(`${label}: ${snake(k)} is in both scale and set`);
  }
  return Object.freeze({ id, summary: src.summary, scale, set });
}

/**
 * Layer personality `p` on a difficulty level and a behaviour table: each key is multiplied by
 * `scale`, then replaced by `set`; level probabilities are clamped to 0..1; both results are
 * re-validated (buildDifficulty / buildBehaviour throw on anything out of range). `p` null returns
 * the inputs unchanged. `weight` (0..1, default 1) blends the profile toward "no change": a scale s
 * becomes 1 + (s - 1) * weight, a set value moves that fraction of the way (the level's matchupSkill
 * uses it: an Easy CPU knows the matchup less).
 * @param {ReturnType<typeof buildPersonality> | null} p
 * @param {Readonly<Record<string, number>>} difficulty
 * @param {ReturnType<typeof buildBehaviour>} behaviour
 * @param {number} [weight] 0..1 share of the profile applied
 * @returns {{difficulty: Readonly<Record<string, number>>, behaviour: ReturnType<typeof buildBehaviour>}}
 * @example const { difficulty, behaviour } = applyPersonality(table.rushdown, ai.levels.normal, ai.behaviour);
 */
export function applyPersonality(p, difficulty, behaviour, weight = 1) {
  if (p === null || weight <= 0) return { difficulty, behaviour };
  const tune = (table, keys) => {
    const out = { ...table };
    for (const k of keys) {
      if (Object.hasOwn(p.scale, k)) out[k] *= 1 + (p.scale[k] - 1) * weight;
      if (Object.hasOwn(p.set, k)) out[k] += (p.set[k] - out[k]) * weight;
      if (UNIT_KEYS.includes(k)) out[k] = Math.min(1, Math.max(0, out[k]));
    }
    return out;
  };
  return {
    difficulty: buildDifficulty(tune(difficulty, DIFFICULTY_KEYS), `ai personality ${p.id}`),
    behaviour: buildBehaviour(tune(behaviour, BEHAVIOUR_KEYS), `ai personality ${p.id} behaviour`),
  };
}

/**
 * Validate a personality file (`{ personalities: {<id>: entry} }`) and freeze it as
 * personalityId -> personality, in data order. Every personality must produce a valid table on
 * every level of `difficulties` (checked here, at the data boundary).
 * @example
 *   const table = buildPersonalities(personalityJson, buildDifficultySet(aiJson, names));
 *   new CpuPilot({ ..., personalities: table, personalityId: Object.keys(table)[0] });
 * @param {any} json parsed personality data
 * @param {{names: readonly string[], levels: Readonly<Record<string, Readonly<Record<string, number>>>>,
 *   behaviour: ReturnType<typeof buildBehaviour>}} difficulties a buildDifficultySet result
 * @returns {Readonly<Record<string, ReturnType<typeof buildPersonality>>>}
 */
export function buildPersonalities(json, difficulties) {
  const table = Object.freeze(Object.fromEntries(
    Object.entries(json.personalities ?? {}).map(([id, src]) => [id, buildPersonality(id, src)]),
  ));
  for (const id of Object.keys(table)) {
    for (const n of difficulties.names) applyPersonality(table[id], difficulties.levels[n], difficulties.behaviour);
  }
  return table;
}

/**
 * Validate a matchup file (`{ matchups: {<selfKitId>: {<oppKitId>: entry}} }`, AI-DEPTH): a per-pairing
 * play plan in the personality entry shape (`summary`, `scale`, `set`; same keys, same locks), layered
 * by the pilot on top of its level and personality once it sees which kits are in the ring
 * (public: the character select). Kit ids are opaque to the engine (lowercase ids). Every entry must
 * produce a valid table on every level with every personality (and none), so a scale that only
 * overflows in one combination fails here, at the data boundary.
 * @example
 *   const matchups = buildMatchups(matchupJson, ai, personalities);
 *   new CpuPilot({ ..., matchups }); // applies matchups[self.spec.id][opp.spec.id] when kits are equipped
 * @param {any} json parsed matchup data
 * @param {{names: readonly string[], levels: Readonly<Record<string, Readonly<Record<string, number>>>>,
 *   behaviour: ReturnType<typeof buildBehaviour>}} difficulties a buildDifficultySet result
 * @param {Readonly<Record<string, ReturnType<typeof buildPersonality>>>} [personalities] a buildPersonalities result
 * @returns {Readonly<Record<string, Readonly<Record<string, ReturnType<typeof buildPersonality>>>>>}
 */
export function buildMatchups(json, difficulties, personalities = {}) {
  const table = {};
  const styles = [null, ...Object.values(personalities)];
  for (const [selfId, row] of Object.entries(json.matchups ?? {})) {
    if (!ID_PATTERN.test(selfId) || row === null || typeof row !== 'object') throw new Error(`ai matchup ${selfId}: bad entry`);
    const built = {};
    for (const [oppId, src] of Object.entries(row)) {
      if (!ID_PATTERN.test(oppId)) throw new Error(`ai matchup ${selfId}: bad opponent id ${oppId}`);
      const m = buildPersonality(`${selfId}_vs_${oppId}`, src, `ai matchup ${selfId} vs ${oppId}`);
      for (const n of difficulties.names) {
        for (const p of styles) {
          const t = applyPersonality(p, difficulties.levels[n], difficulties.behaviour);
          applyPersonality(m, t.difficulty, t.behaviour);
        }
      }
      built[oppId] = m;
    }
    table[selfId] = Object.freeze(built);
  }
  return Object.freeze(table);
}
