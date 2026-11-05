// story-002 AC 1, 5, 6, 7, 9: state machine, frame phases, lockout, buffer, Overwind, data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE, PHASE, TRANSITIONS, canTransition, setState, attackPhase, moveTotal, overwindReady,
} from '../fixtures/bound/state-machine.js';
import { createCombatant } from '../fixtures/bound/fighter.js';
import { MOVES, GUARD_TABLE } from '../fixtures/bound/moves.js';
import { FIGHTER_RULES } from '../fixtures/bound/fighter-config.js';
import { validateMoveTable } from '../fixtures/bound/duel-sim.js';
import { duelAt, tick, run, runTo } from './duel-helpers.js';

const ALL = Object.values(STATE);

test('transition table covers every state and only names known states', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...ALL].sort());
  for (const from of ALL) {
    for (const to of Object.keys(TRANSITIONS[from])) assert.ok(ALL.includes(to), `${from}->${to}`);
  }
});

test('every state is reachable from idle', () => {
  const seen = new Set([STATE.IDLE]);
  const queue = [STATE.IDLE];
  while (queue.length) {
    const s = queue.shift();
    for (const to of Object.keys(TRANSITIONS[s])) if (!seen.has(to)) { seen.add(to); queue.push(to); }
  }
  assert.deepEqual([...seen].sort(), [...ALL].sort());
});

test('KO is terminal', () => {
  for (const to of ALL) assert.equal(canTransition(STATE.KO, to), false, `ko->${to}`);
});

test('illegal transitions are rejected and leave the fighter unchanged', () => {
  const illegal = [
    [STATE.HITSTUN, STATE.ATTACK], [STATE.HITSTUN, STATE.GUARD], [STATE.HITSTUN, STATE.THROWN],
    [STATE.BLOCKSTUN, STATE.ATTACK], [STATE.JUMP, STATE.ATTACK], [STATE.JUMP, STATE.GUARD],
    [STATE.JUMP, STATE.THROWN], [STATE.ATTACK, STATE.ATTACK], [STATE.ATTACK, STATE.GUARD],
    [STATE.THROWN, STATE.ATTACK], [STATE.THROWN, STATE.HITSTUN], [STATE.KO, STATE.IDLE],
    [STATE.IDLE, STATE.BLOCKSTUN], [STATE.SIDESTEP, STATE.BLOCKSTUN],
  ];
  for (const [from, to] of illegal) {
    const f = createCombatant(0, 0, 0);
    f.state = from;
    f.stateFrame = 5;
    assert.equal(setState(f, to), false, `${from}->${to} should be rejected`);
    assert.equal(f.state, from);
    assert.equal(f.stateFrame, 5);
  }
});

test('legal transitions apply and reset the state frame; stun states may re-enter', () => {
  const f = createCombatant(0, 0, 0);
  f.stateFrame = 9;
  assert.equal(setState(f, STATE.GUARD), true);
  assert.equal(f.state, STATE.GUARD);
  assert.equal(f.stateFrame, 0);
  assert.equal(setState(f, STATE.BLOCKSTUN), true);
  f.stateFrame = 3;
  assert.equal(setState(f, STATE.BLOCKSTUN), true);
  assert.equal(f.stateFrame, 0);
  assert.equal(setState(f, STATE.HITSTUN), true);
  assert.equal(setState(f, STATE.HITSTUN), true);
  assert.equal(setState(f, STATE.KO), true);
});

test('attack runs startup -> active -> recovery for exactly the move frame counts', () => {
  const ctx = duelAt(2.5); // out of reach
  const m = MOVES.light;
  ctx.in0.light = true;
  const phases = [];
  for (let i = 0; i < moveTotal(m); i++) {
    tick(ctx);
    phases.push(attackPhase(ctx.a));
  }
  const count = (p) => phases.filter((x) => x === p).length;
  assert.equal(count(PHASE.STARTUP), m.startup);
  assert.equal(count(PHASE.ACTIVE), m.active);
  assert.equal(count(PHASE.RECOVERY), m.recovery);
  assert.equal(ctx.a.state, STATE.ATTACK);
  tick(ctx);
  assert.equal(ctx.a.state, STATE.IDLE);
});

test('attackers cannot walk; facing is locked for the attack', () => {
  const ctx = duelAt(2.5);
  ctx.in0.heavy = true;
  ctx.in0.stick.x = 1;
  tick(ctx);
  const x = ctx.a.x;
  const yaw = ctx.a.yaw;
  ctx.b.z = ctx.b.prevZ = 1; // opponent circles
  run(ctx, 5);
  assert.equal(ctx.a.state, STATE.ATTACK);
  assert.equal(ctx.a.x, x);
  assert.equal(ctx.a.yaw, yaw);
});

test('hitstun locks out input for the move hitstun after hitstop; presses outside the buffer are dropped', () => {
  const ctx = duelAt(1.2);
  const m = MOVES.light;
  ctx.in0.light = true;
  runTo(ctx, m.startup + 1); // first active tick connects
  assert.equal(ctx.b.state, STATE.HITSTUN);
  const resume = ctx.sim.frame + m.hitstop + 1;
  const free = resume + m.hitstun;
  runTo(ctx, resume);
  ctx.in1.light = true; // early press, long before hitstun ends
  for (let t = resume; t < free; t++) {
    assert.equal(ctx.b.state, STATE.HITSTUN, `tick ${ctx.sim.frame}`);
    tick(ctx);
  }
  tick(ctx); // first free tick
  assert.equal(ctx.b.state, STATE.IDLE);
});

test('a press inside the buffer window during hitstun comes out on the first free tick', () => {
  const ctx = duelAt(2.5);
  const b = ctx.b;
  setState(b, STATE.HITSTUN);
  b.stunLeft = 10;
  run(ctx, 10 - FIGHTER_RULES.inputBufferFrames + 1);
  ctx.in1.light = true;
  run(ctx, FIGHTER_RULES.inputBufferFrames - 1);
  assert.equal(b.state, STATE.HITSTUN);
  tick(ctx);
  assert.equal(b.state, STATE.ATTACK);
  assert.equal(b.moveId, 'light');
});

test('airborne fighters cannot attack or guard', () => {
  const ctx = duelAt(2.5);
  ctx.in0.stick.y = 1;
  tick(ctx);
  ctx.in0.stick.y = 0;
  run(ctx, 3);
  assert.equal(ctx.a.state, STATE.JUMP);
  ctx.in0.heavy = true;
  ctx.in0.guard = true;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.JUMP);
});

test('guard: held Guard enters guard, stick down crouch-guards, release returns to idle', () => {
  const ctx = duelAt(2.5);
  ctx.in0.guard = true;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.GUARD);
  assert.equal(ctx.a.crouching, false);
  ctx.in0.stick.y = -1;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.GUARD);
  assert.equal(ctx.a.crouching, true);
  ctx.in0.guard = false;
  ctx.in0.stick.y = 0;
  tick(ctx);
  assert.notEqual(ctx.a.state, STATE.GUARD);
});

test('crouching Light/Heavy pick the crouch moves', () => {
  const ctx = duelAt(2.5);
  ctx.in0.stick.y = -1;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.CROUCH);
  ctx.in0.light = true;
  tick(ctx);
  assert.equal(ctx.a.moveId, 'crouchLight');
  assert.equal(ctx.a.crouching, true);
});

test('locomotion states follow the body: walk, crouch, jump, sidestep', () => {
  const ctx = duelAt(2.5);
  ctx.in0.stick.x = 1;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.WALK);
  ctx.in0.stick.x = 0;
  ctx.in0.sidestep = 1;
  tick(ctx);
  assert.equal(ctx.a.state, STATE.SIDESTEP);
  run(ctx, 30);
  assert.equal(ctx.a.state, STATE.IDLE);
});

test('Overwind needs a full Wind meter and spends it on frame 1', () => {
  const empty = duelAt(2.5);
  empty.in0.guard = true;
  empty.in0.heavy = true;
  tick(empty);
  assert.equal(empty.a.moveId, 'heavy', 'meter not full: Guard+Heavy is a plain Heavy');

  const full = duelAt(2.5);
  full.a.meter = full.a.meterMax;
  assert.equal(overwindReady(full.a), true);
  full.in0.guard = true;
  full.in0.heavy = true;
  tick(full);
  assert.equal(full.a.moveId, 'overwind');
  assert.equal(full.a.meter, 0);
  assert.equal(overwindReady(full.a), false);

  const almost = createCombatant(0, 0, 0);
  almost.meter = almost.meterMax - 1;
  assert.equal(overwindReady(almost), false);
  const koed = createCombatant(0, 0, 0);
  koed.meter = koed.meterMax;
  koed.hp = 0;
  assert.equal(overwindReady(koed), false);
});

test('move data validates and every level has a guard rule', () => {
  assert.doesNotThrow(() => validateMoveTable(MOVES));
  for (const m of Object.values(MOVES)) assert.ok(GUARD_TABLE[m.level], m.name);
  assert.throws(() => validateMoveTable({ bad: { ...MOVES.light, startup: 0 } }), /startup/);
  assert.throws(() => validateMoveTable({ bad: { ...MOVES.light, damage: 1.5 } }), /damage/);
  assert.throws(() => validateMoveTable({ bad: { ...MOVES.light, level: 'overhead' } }), /level/);
});
