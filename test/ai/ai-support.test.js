// Story-004 support modules: seeded RNG, difficulty data, delayed perception.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeededRng } from '../../src/core/rng.js';
import {
  DIFFICULTIES, DIFFICULTY_KEYS, DIFFICULTY_NAMES, DEFAULT_DIFFICULTY, AI_BEHAVIOUR, buildDifficulty,
  buildBehaviour, difficultyFromQuery,
} from '../fixtures/bound/difficulty.js';
import { DelayedView, createObservation, observe } from '../../src/ai/perception.js';
import { createDuel } from '../fixtures/bound/duel-sim.js';

test('rng_sameSeed_sameSequenceInUnitRange', () => {
  const a = new SeededRng(42);
  const b = new SeededRng(42);
  for (let i = 0; i < 1000; i++) {
    const x = a.next();
    assert.equal(x, b.next());
    assert.ok(x >= 0 && x < 1);
  }
});

test('rng_differentSeeds_differentSequences', () => {
  const a = new SeededRng(1);
  const b = new SeededRng(2);
  let same = 0;
  for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
  assert.ok(same < 5);
});

test('difficulty_threeLevels_sameKeysOnlyNumbersDiffer', () => {
  assert.deepEqual([...DIFFICULTY_NAMES], ['easy', 'normal', 'hard']);
  for (const n of DIFFICULTY_NAMES) assert.deepEqual(Object.keys(DIFFICULTIES[n]), [...DIFFICULTY_KEYS]);
});

test('difficulty_harderLevels_reactFasterBlockAndPunishMore', () => {
  const { easy, normal, hard } = DIFFICULTIES;
  assert.ok(easy.reactionFrames > normal.reactionFrames && normal.reactionFrames > hard.reactionFrames);
  assert.ok(easy.blockChance < normal.blockChance && normal.blockChance < hard.blockChance);
  assert.ok(easy.whiffPunishChance < normal.whiffPunishChance && normal.whiffPunishChance < hard.whiffPunishChance);
  assert.ok(easy.mistakeRate > normal.mistakeRate && normal.mistakeRate > hard.mistakeRate);
});

test('difficultyFromQuery_cpuParam_picksLevelElseNormal', () => {
  assert.equal(DEFAULT_DIFFICULTY, 'normal');
  assert.equal(difficultyFromQuery('?cpu=easy'), 'easy');
  assert.equal(difficultyFromQuery('?cpu=HARD'), 'hard');
  assert.equal(difficultyFromQuery('?foo=1&cpu=normal'), 'normal');
  assert.equal(difficultyFromQuery(''), 'normal');
  assert.equal(difficultyFromQuery('?cpu=insane'), 'normal');
});

test('buildDifficulty_badValues_throw', () => {
  const ok = { ...DIFFICULTIES.normal };
  assert.doesNotThrow(() => buildDifficulty(ok));
  assert.throws(() => buildDifficulty({ ...ok, blockChance: 1.5 }), /blockChance/);
  assert.throws(() => buildDifficulty({ ...ok, reactionFrames: 2.5 }), /reactionFrames/);
  assert.throws(() => buildDifficulty({ ...ok, decisionFrames: 0 }), /decisionFrames/);
  assert.throws(() => buildDifficulty({ ...ok, blokChance: 0.5 }), /unknown key/);
  const { aggression, ...missing } = ok;
  assert.throws(() => buildDifficulty(missing), /aggression/);
});

test('buildBehaviour_pokeSharesOverOne_throws', () => {
  assert.doesNotThrow(() => buildBehaviour({ ...AI_BEHAVIOUR }));
  assert.throws(() => buildBehaviour({ ...AI_BEHAVIOUR, heavyPokeShare: 0.8, lowPokeShare: 0.5 }), /PokeShare/);
});

test('observe_copiesVisibleStateOnly_noHiddenInputFields', () => {
  const [f] = createDuel().fighters;
  f.bufAction = 2;
  f.guardHeld = true;
  const o = observe(createObservation(), f, 0);
  assert.equal(o.x, f.x);
  assert.equal(o.state, 'idle');
  for (const hidden of ['bufAction', 'bufFrames', 'guardHeld', 'stunLeft', 'intent']) assert.equal(hidden in o, false);
});

test('delayedView_delay3_perceivesStateFrom3PushesAgo', () => {
  const [f] = createDuel().fighters;
  const v = new DelayedView(3);
  const seen = [];
  for (let i = 0; i < 8; i++) {
    f.x = i;
    seen.push(v.push(f).x);
  }
  // first 3 ticks repeat the first observation, then lag exactly 3 behind
  assert.deepEqual(seen, [0, 0, 0, 0, 1, 2, 3, 4]);
});

test('delayedView_delay0_perceivesPresent', () => {
  const [f] = createDuel().fighters;
  const v = new DelayedView(0);
  f.x = 5;
  assert.equal(v.push(f).x, 5);
  f.x = 6;
  assert.equal(v.push(f).x, 6);
});
