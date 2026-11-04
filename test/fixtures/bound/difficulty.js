// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  BEHAVIOUR_KEYS, DIFFICULTY_KEYS, POKEABLE_KEYS, UNIT_KEYS, buildBehaviour, buildDifficulty,
} from '../../../src/ai/index.js';
import { difficultyFromQuery as engineDifficultyFromQuery } from '../../../src/ai/index.js';
import { AI_DIFFICULTY, DIFFICULTY_NAMES } from './ai-data.js';

export { DIFFICULTY_NAMES };
/** Shared decision tuning. */
export const AI_BEHAVIOUR = AI_DIFFICULTY.behaviour;
/** @type {Readonly<Record<'easy'|'normal'|'hard', Readonly<Record<string, number>>>>} */
export const DIFFICULTIES = AI_DIFFICULTY.levels;
/** Level used when none (or an unknown one) is asked for. */
export const DEFAULT_DIFFICULTY = AI_DIFFICULTY.defaultName;
/** `?cpu=easy|normal|hard` -> level name; unknown -> DEFAULT_DIFFICULTY. */
export function difficultyFromQuery(search) {
  return engineDifficultyFromQuery(search, DIFFICULTY_NAMES, DEFAULT_DIFFICULTY);
}
