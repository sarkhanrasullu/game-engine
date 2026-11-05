// moves.js `meterCost`: a move that spends Wind meter on its frame 1 and cannot start without it.
// A Heavy that would resolve to an unaffordable special falls back to heavy; the CPU never picks
// an unaffordable special or punish move. Fixture: the greybox kit plus a specialBack built from
// its heavy (no consumer data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE, bufferedMoveId } from '../fixtures/bound/state-machine.js';
import { MOVES, validateMoveTable } from '../fixtures/bound/moves.js';
import { RULESET } from '../fixtures/bound/ruleset.js';
import { AI_DIFFICULTY } from '../fixtures/bound/ai-data.js';
import { CpuPilot, PLAN, buildDifficulty, buildBehaviour } from '../../src/ai/index.js';
import { createSnapshot } from '../../src/input/input-snapshot.js';
import { duelAt, tick } from './duel-helpers.js';

const COST = 30;

/** Greybox kit plus a specialBack (heavy's data, retreatPoke role) that costs COST meter. */
function costedKit(meterCost = COST) {
  const kit = { ...MOVES, specialBack: { ...MOVES.heavy, aiRole: 'retreatPoke', meterCost } };
  validateMoveTable(kit);
  return kit;
}

/** Fighter 1 presses Heavy with the stick held away (specialBack) at distance d. */
function pressBackHeavy(ctx) {
  ctx.in1.heavy = true;
  ctx.in1.stick.x = -1; // stick x is relative: +1 toward the opponent, -1 away
  tick(ctx);
  ctx.in1.stick.x = 0;
}

test('validateMoveTable_meterCost_rejectsNegativeOrFractional', () => {
  // Arrange / Act / Assert
  assert.throws(() => validateMoveTable({ ...MOVES, heavy: { ...MOVES.heavy, meterCost: -1 } }), /meterCost/);
  assert.throws(() => validateMoveTable({ ...MOVES, heavy: { ...MOVES.heavy, meterCost: 1.5 } }), /meterCost/);
  assert.doesNotThrow(() => validateMoveTable({ ...MOVES, heavy: { ...MOVES.heavy, meterCost: 0 } }));
});

test('bufferedMoveId_unaffordableSpecialBack_fallsBackToHeavy', () => {
  // Arrange: a fighter with the costed kit and an empty meter, Heavy buffered with the stick away
  const { b } = duelAt(1.0);
  b.moves = costedKit();
  b.bufAction = 2; // BUFFER.HEAVY
  b.bufDir = -1;
  b.meter = COST - 1;
  // Act / Assert
  assert.equal(bufferedMoveId(b), 'heavy');
  b.meter = COST;
  assert.equal(bufferedMoveId(b), 'specialBack');
});

test('startAttack_affordableSpecial_spendsExactlyMeterCostOnFrame1', () => {
  // Arrange
  const ctx = duelAt(3.0);
  ctx.b.moves = costedKit();
  ctx.b.meter = COST + 15;
  // Act
  pressBackHeavy(ctx);
  // Assert: the special started and the cost left the meter on its first tick
  assert.equal(ctx.b.state, STATE.ATTACK);
  assert.equal(ctx.b.moveId, 'specialBack');
  assert.equal(ctx.b.stateFrame, 1);
  assert.equal(ctx.b.meter, 15);
});

test('startAttack_emptyMeter_pressBecomesHeavyAndMeterStaysZero', () => {
  // Arrange
  const ctx = duelAt(3.0);
  ctx.b.moves = costedKit();
  ctx.b.meter = 0;
  // Act
  pressBackHeavy(ctx);
  // Assert
  assert.equal(ctx.b.state, STATE.ATTACK);
  assert.equal(ctx.b.moveId, 'heavy');
  assert.equal(ctx.b.meter, 0);
});

test('startAttack_costAboveMeterOnNonSpecialId_isRefusedAndMeterNeverNegative', () => {
  // Arrange: a costed Light (no heavy fallback path) and a meter below the cost
  const ctx = duelAt(3.0);
  ctx.b.moves = { ...MOVES, light: { ...MOVES.light, meterCost: COST } };
  ctx.b.meter = COST - 1;
  // Act
  ctx.in1.light = true;
  tick(ctx);
  // Assert: refused, press still buffered, meter untouched
  assert.notEqual(ctx.b.state, STATE.ATTACK);
  assert.equal(ctx.b.meter, COST - 1);
  assert.ok(ctx.b.bufFrames > 0);
});

/** CPU (fighter 1) with every neutral weight but offence zeroed and specials always chosen. */
function offensivePilot(seed = 1) {
  const b = AI_DIFFICULTY.behaviour;
  const behaviour = buildBehaviour({ ...b, waitWeight: 0, guardWeight: 0, backOffWeight: 0, sidestepWeight: 0 });
  const difficulty = buildDifficulty({
    ...AI_DIFFICULTY.levels.hard, aggression: 1, mistakeRate: 0, sidestepChance: 0, reactionFrames: 0, specialShare: 1,
  });
  return new CpuPilot({ difficulty, behaviour, rules: RULESET.rules, seed });
}

test('cpuNeutral_retreatPokeSpecialUnaffordable_neverPicked_affordablePicked', () => {
  // Arrange: inside the opponent's threat range (retreatPoke fits), kit costed
  const out = createSnapshot();
  for (const [meter, expectSpecial] of [[COST - 1, false], [COST, true]]) {
    let picked = false;
    for (let seed = 1; seed <= 10; seed++) {
      const { a, b } = duelAt(1.0);
      b.moves = costedKit();
      b.meter = meter;
      const cpu = offensivePilot(seed);
      // Act
      cpu.sample(out, b, a);
      if (cpu.reason === PLAN.SPECIAL) picked = true;
      // Assert (unaffordable): no special ever
      if (!expectSpecial) assert.notEqual(cpu.reason, PLAN.SPECIAL, `meter ${meter} seed ${seed}`);
    }
    if (expectSpecial) assert.ok(picked, 'affordable special was never picked');
  }
});
