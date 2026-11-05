// Data boundary: JSON tuning loads, validates and freezes (story-003 tech debt: no hardcoded values).
import test from 'node:test';
import assert from 'node:assert/strict';
import COMBAT from '../fixtures/combat_tuning.json' with { type: 'json' };
import { numberTable, deepFreeze } from '../../src/core/data.js';
import { FIGHTER_RULES, RULE_DEFAULTS, RULE_KEYS, buildRules } from '../fixtures/bound/fighter-config.js';
import { MOVEMENT_CONFIG, MOVEMENT_DEFAULTS, MOVEMENT_KEYS } from '../fixtures/bound/movement-config.js';
import { MOVES } from '../fixtures/bound/moves.js';

test('numberTable_validSection_copiesAndFreezes', () => {
  // Arrange
  const src = { a: 1, b: 2.5 };
  // Act
  const t = numberTable(src, ['a', 'b'], 'x');
  // Assert
  assert.deepEqual(t, src);
  assert.ok(Object.isFrozen(t));
  assert.notEqual(t, src);
});

test('numberTable_missingUnknownOrNonNumeric_throws', () => {
  assert.throws(() => numberTable({ a: 1 }, ['a', 'b'], 'x'), /b must be a finite number/);
  assert.throws(() => numberTable({ a: 1, c: 2 }, ['a'], 'x'), /unknown key c/);
  assert.throws(() => numberTable({ a: '1' }, ['a'], 'x'), /a must be a finite number/);
  assert.throws(() => numberTable(undefined, ['a'], 'x'), /missing section/);
});

test('deepFreeze_freezesNestedObjects', () => {
  const o = deepFreeze({ a: { b: [1, 2] } });
  assert.ok(Object.isFrozen(o.a) && Object.isFrozen(o.a.b));
});

test('combatTuning_rulesAndMovement_comeFromJson', () => {
  // The fixture data ships only the required keys: optional ones must arrive as their defaults.
  for (const k of RULE_KEYS) assert.equal(FIGHTER_RULES[k], COMBAT.rules[k] ?? RULE_DEFAULTS[k], k);
  for (const k of MOVEMENT_KEYS) assert.equal(MOVEMENT_CONFIG[k], COMBAT.movement[k] ?? MOVEMENT_DEFAULTS[k], k);
  assert.deepEqual(MOVES, COMBAT.greyboxMoves);
  assert.ok(Object.isFrozen(MOVES.light.hitbox));
});

test('buildRules_typoKey_throws', () => {
  assert.throws(() => buildRules({ ...COMBAT.rules, maxHP: 100 }), /unknown key maxHP/);
});
