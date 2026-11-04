// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
import AI from '../ai_difficulty.json' with { type: 'json' };
import AI_PERSONALITIES from '../ai_personalities.json' with { type: 'json' };
import { buildDifficultySet, buildPersonalities } from '../../../src/ai/index.js';

/** Level names in menu order. */
export const DIFFICULTY_NAMES = Object.freeze(['easy', 'normal', 'hard']);

/**
 * Validated difficulty set: { names, behaviour, levels, defaultName }.
 * @example new CpuPilot({ difficulty: AI_DIFFICULTY.levels.hard, behaviour: AI_DIFFICULTY.behaviour, rules });
 */
export const AI_DIFFICULTY = buildDifficultySet(AI, DIFFICULTY_NAMES);

/**
 * personalityId -> personality, in data order (what a consumer ladder may reference).
 * @example new CpuPilot({ ..., personalities: AI_PERSONALITY_TABLE, personalityId: 'brawler' });
 */
export const AI_PERSONALITY_TABLE = buildPersonalities(AI_PERSONALITIES, AI_DIFFICULTY);
