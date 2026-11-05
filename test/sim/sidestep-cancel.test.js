// P4 sidestep attack-cancel (design/quick-specs/fight-systems-gap-2026-11-05.md P4): a sidestep becomes
// actionable (attack or guard) once sidestepDuration - sidestepT >= sidestepCancelSeconds. The attack locks
// facing as any attack does; no invulnerability is added. Fixture data ships no key: the default is the spec's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE, canTransition, sidestepCancellable } from '../fixtures/bound/state-machine.js';
import { EVENT } from '../fixtures/bound/duel-sim.js';
import { RULESET } from '../fixtures/bound/ruleset.js';
import { MOVEMENT_DEFAULTS, buildMovement, fighterMovement } from '../../src/sim/index.js';
import { duelAt, tick, run } from './duel-helpers.js';

const MV = RULESET.movement;
/** Ticks into a step at which its cut opens. */
const cutTicks = (seconds) => Math.ceil(seconds * 60 - 1e-9);
const CUT = cutTicks(MV.sidestepCancelSeconds);

/** Fighter 0 starts a sidestep; returns the context with `n` more ticks run after the tap tick. */
function stepping(n = 0, d = 1.2) {
  const ctx = duelAt(d);
  ctx.in0.sidestep = 1;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.SIDESTEP);
  run(ctx, n);
  return ctx;
}

test('movementKeys_cancelDefault_isTheSpecValue_andKitsMayOverrideIt', () => {
  assert.equal(MOVEMENT_DEFAULTS.sidestepCancelSeconds, 0.13);
  assert.equal(MV.sidestepCancelSeconds, 0.13);
  const { sidestepCancelSeconds, ...rest } = MV;
  assert.equal(buildMovement(rest).sidestepCancelSeconds, 0.13, 'a game shipping no key validates');
  assert.equal(fighterMovement({ sidestepCancelSeconds: 0.11 }, MV).sidestepCancelSeconds, 0.11);
  assert.throws(() => fighterMovement({ sidestepCancelSeconds: 0 }, MV), /sidestepCancelSeconds/);
  assert.throws(() => buildMovement({ ...MV, sidestepCancelSeconds: -1 }), /sidestepCancelSeconds/);
});

test('transitions_sidestepToAttackAndGuard_areLegal', () => {
  assert.equal(canTransition(STATE.SIDESTEP, STATE.ATTACK), true);
  assert.equal(canTransition(STATE.SIDESTEP, STATE.GUARD), true);
});

test('sidestepCancellable_opensExactlyAtTheCut', () => {
  const ctx = stepping();
  for (let k = 1; k < CUT; k++) {
    assert.equal(sidestepCancellable(ctx.a), false, `tick ${k}`);
    tick(ctx);
  }
  assert.equal(sidestepCancellable(ctx.a), true, `tick ${CUT}`);
});

test('attackPress_beforeTheCut_doesNotStart', () => {
  const ctx = stepping(1);
  ctx.in0.light = true;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.SIDESTEP);
});

test('attackPress_atTheCut_startsThisTick_stepEnds_facingLockedOnOpponent', () => {
  const ctx = stepping(CUT - 1);
  ctx.in0.light = true;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.ATTACK);
  assert.equal(ctx.a.moveId, 'light');
  assert.equal(ctx.a.sidestepT, 0, 'the arc stops');
  // Facing is the direction to the opponent at the cancel, and stays locked for the attack.
  const yaw = Math.atan2(ctx.b.x - ctx.a.x, ctx.b.z - ctx.a.z);
  assert.ok(Math.abs(ctx.a.attackYaw - yaw) < 0.02, 'locked on the opponent at the cancel');
  const locked = ctx.a.attackYaw;
  const x = ctx.a.x;
  const z = ctx.a.z;
  ctx.b.x += 0.3; // the opponent moves: the attack does not track, and the step no longer carries
  run(ctx, 3);
  assert.equal(ctx.a.attackYaw, locked);
  assert.ok(Math.hypot(ctx.a.x - x, ctx.a.z - z) < 1e-6, 'the step no longer moves the attacker');
});

test('guardHeld_atTheCut_entersGuard_stepEnds', () => {
  const ctx = stepping(CUT - 2);
  ctx.in0.guard = true;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.SIDESTEP, 'held before the cut: not yet');
  tick(ctx);
  assert.equal(ctx.a.state, STATE.GUARD);
  assert.equal(ctx.a.sidestepT, 0);
});

test('buffer_pressInTheLastBufferTicksBeforeTheCut_firesAtTheCut_earlierPressAgesOut', () => {
  // 6 f buffer (documented in the spec, not extended): a press too early ages out before the cut opens.
  const frames = RULESET.rules.inputBufferFrames;
  const early = stepping(CUT - frames - 1);
  early.in0.light = true;
  run(early, frames + 3);
  assert.equal(early.a.state, STATE.SIDESTEP, 'aged out');
  const late = stepping(CUT - frames);
  late.in0.light = true;
  run(late, frames + 1);
  assert.equal(late.a.state, STATE.ATTACK, 'still buffered at the cut');
});

test('noInvulnerability_steppingFighter_isStillHitAndThrown', () => {
  const hit = stepping(CUT + 1, 1.0);
  hit.b.state = STATE.ATTACK;
  hit.b.moveId = 'heavy';
  hit.b.move = hit.b.moves.heavy;
  hit.b.stateFrame = hit.b.move.startup;
  hit.b.attackDirX = -1;
  hit.b.attackDirZ = 0;
  // Re-aim at the stepper's current position: only the state is under test here.
  const dx = hit.a.x - hit.b.x;
  const dz = hit.a.z - hit.b.z;
  const d = Math.hypot(dx, dz);
  hit.b.attackDirX = dx / d;
  hit.b.attackDirZ = dz / d;
  tick(hit);
  assert.equal(hit.sim.events.slice(0, hit.sim.eventCount).some((e) => e.type === EVENT.HIT && e.defender === 0), true);
});

test('stepWithoutAPress_runsItsFullLength', () => {
  const total = Math.ceil(MV.sidestepDuration * 60);
  const ctx = stepping(total - 2);
  assert.equal(ctx.a.state, STATE.SIDESTEP);
  run(ctx, 3);
  assert.notEqual(ctx.a.state, STATE.SIDESTEP);
});

test('kitOverride_moveTheCut', () => {
  for (const seconds of [0.11, 0.15]) {
    const ctx = duelAt(1.2);
    ctx.a.movement = fighterMovement({ sidestepCancelSeconds: seconds }, MV);
    ctx.in0.sidestep = 1;
    tick(ctx);
    const cut = cutTicks(seconds);
    run(ctx, cut - 2);
    assert.equal(sidestepCancellable(ctx.a), false, `${seconds}: one before`);
    tick(ctx);
    assert.equal(sidestepCancellable(ctx.a), true, `${seconds}: at ${cut}`);
  }
});
