// P2 throw tech (design/quick-specs/fight-systems-gap-2026-11-05.md P2): a buffered Throw press on an unfrozen
// tick inside the window breaks a techable throw that already connected. Both fighters enter TECH, are pushed
// apart, the throw's damage and contact meter are undone, and both gain techMeter. Fixture ships no key: the
// defaults are the spec's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE, canTransition, setState, startAttack, techReady } from '../fixtures/bound/state-machine.js';
import { EVENT } from '../fixtures/bound/duel-sim.js';
import { MOVES, validateMoveTable } from '../fixtures/bound/moves.js';
import { RULESET } from '../fixtures/bound/ruleset.js';
import {
  RULE_DEFAULTS, METER_DEFAULTS, buildRules, buildMeter, createDuel as engineCreateDuel, createRuleset, FrameDataTracker, OUTCOME,
} from '../../src/sim/index.js';
import { createSnapshot } from '../fixtures/bound/input-snapshot.js';
import COMBAT from '../fixtures/combat_tuning.json' with { type: 'json' };
import { duelAt, tick, run, dist } from './duel-helpers.js';

const { rules: R, meter: M } = RULESET;
const T = MOVES.throw;
const events = (ctx, type) => ctx.sim.events.slice(0, ctx.sim.eventCount).filter((e) => e.type === type);

/** Fighter 0 throws fighter 1; returns at the connect tick (hitstop about to start). */
function grabbed(ctx = duelAt(0.95)) {
  ctx.in0.throw = true;
  run(ctx, T.startup + 1);
  assert.equal(ctx.b.state, STATE.THROWN, 'the throw connected');
  return ctx;
}

/** Run out the hitstop: the next tick is the first unfrozen one. */
const pastHitstop = (ctx) => run(ctx, T.hitstop);

test('techKeys_defaults_equalTheSpecValues', () => {
  assert.equal(RULE_DEFAULTS.throwTechWindow, 10);
  assert.equal(RULE_DEFAULTS.techFrames, 12);
  assert.equal(RULE_DEFAULTS.techPushback, 0.6);
  assert.equal(METER_DEFAULTS.techMeter, 3);
  assert.equal(R.throwTechWindow, 10);
  assert.equal(M.techMeter, 3);
  assert.throws(() => buildRules({ ...R, throwTechWindow: 1.5 }), /throwTechWindow/);
  assert.throws(() => buildRules({ ...R, techFrames: 0 }), /techFrames/);
  assert.throws(() => buildRules({ ...R, techPushback: -1 }), /techPushback/);
  assert.throws(() => buildMeter({ ...M, techMeter: -1 }), /techMeter/);
});

test('moveTable_techable_booleanAndThrowsOnly', () => {
  assert.doesNotThrow(() => validateMoveTable({ ...MOVES, throw: { ...T, techable: false } }));
  assert.throws(() => validateMoveTable({ ...MOVES, throw: { ...T, techable: 0 } }), /techable/);
  assert.throws(() => validateMoveTable({ ...MOVES, heavy: { ...MOVES.heavy, techable: false } }), /techable/);
});

test('transitions_thrownAndAttackToTech_techToIdleHitstunKoOnly', () => {
  assert.equal(canTransition(STATE.THROWN, STATE.TECH), true);
  assert.equal(canTransition(STATE.ATTACK, STATE.TECH), true);
  for (const to of [STATE.IDLE, STATE.HITSTUN, STATE.KO]) assert.equal(canTransition(STATE.TECH, to), true, to);
  for (const to of [STATE.ATTACK, STATE.GUARD, STATE.THROWN, STATE.TECH, STATE.WALK, STATE.BLOCKSTUN]) {
    assert.equal(canTransition(STATE.TECH, to), false, to);
  }
  // Only a grab enters it.
  for (const from of [STATE.IDLE, STATE.GUARD, STATE.HITSTUN, STATE.BLOCKSTUN, STATE.JUMP]) {
    assert.equal(canTransition(from, STATE.TECH), false, from);
  }
});

test('techInsideTheWindow_bothEnterTech_damageAndContactMeterUndone_techMeterGained', () => {
  const ctx = grabbed();
  assert.equal(ctx.b.hp, R.maxHp - T.damage, 'the throw hurts at connect, as ever');
  assert.ok(ctx.a.meter > M.techMeter && ctx.b.meter > M.techMeter, 'and gained contact meter');
  pastHitstop(ctx);
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.b.state, STATE.TECH);
  assert.equal(ctx.a.state, STATE.TECH);
  assert.equal(ctx.a.move, null, "the attacker's move ends");
  assert.equal(ctx.a.moveId, null);
  assert.equal(ctx.b.hp, R.maxHp, 'no damage');
  assert.equal(ctx.a.meter, M.techMeter);
  assert.equal(ctx.b.meter, M.techMeter);
  assert.equal(ctx.a.stunLeft, R.techFrames - 1);
  assert.equal(ctx.b.stunLeft, R.techFrames - 1);
  const [e] = events(ctx, EVENT.TECH);
  assert.ok(e, 'EVENT.TECH');
  assert.equal(e.attacker, 0);
  assert.equal(e.defender, 1);
  assert.equal(e.moveId, 'throw');
  assert.equal(e.damage, 0);
  assert.equal(e.refund, T.damage);
  assert.equal(e.counter, 0);
  assert.equal(e.defenderHp, R.maxHp);
});

test('tech_pressIsConsumed', () => {
  const ctx = grabbed();
  pastHitstop(ctx);
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.b.bufAction, 0);
  assert.equal(ctx.b.bufFrames, 0);
  run(ctx, R.techFrames + 1);
  assert.notEqual(ctx.b.state, STATE.ATTACK, 'no throw comes out afterwards');
});

test('tech_lastTickOfTheWindow_works_oneLaterDoesNot', () => {
  const inside = grabbed();
  pastHitstop(inside);
  run(inside, R.throwTechWindow - 1);
  inside.in1.throw = true;
  tick(inside);
  assert.equal(inside.b.state, STATE.TECH, `press on unfrozen tick ${R.throwTechWindow}`);

  const late = grabbed();
  pastHitstop(late);
  run(late, R.throwTechWindow);
  const hp = late.b.hp;
  late.in1.throw = true;
  tick(late);
  assert.equal(late.b.state, STATE.THROWN, `press on unfrozen tick ${R.throwTechWindow + 1}`);
  assert.equal(late.b.hp, hp);
  assert.equal(events(late, EVENT.TECH).length, 0);
});

test('tech_pressDuringHitstop_doesNotResolveUntilTheFirstUnfrozenTick', () => {
  const ctx = grabbed();
  ctx.in1.throw = true;
  tick(ctx); // frozen
  assert.equal(ctx.b.state, STATE.THROWN, 'not yet');
  assert.equal(ctx.b.hp, R.maxHp - T.damage);
  run(ctx, T.hitstop - 1); // still frozen, through the last frozen tick
  assert.equal(ctx.b.state, STATE.THROWN, 'still not');
  tick(ctx); // first unfrozen tick
  assert.equal(ctx.b.state, STATE.TECH);
});

test('tech_pressBeforeTheGrabConnects_isNotATech', () => {
  // The press is buffered while the defender recovers from its own whiff, and is still live at the connect.
  const ctx = duelAt(0.95);
  startAttack(ctx.b, ctx.a, 'light');
  ctx.b.stateFrame = MOVES.light.startup + MOVES.light.active + 1;
  ctx.b.attackHasHit = true;
  ctx.in0.throw = true;
  run(ctx, T.startup - 1);
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.b.bufAction, 3, 'the press is buffered: a throw attempt');
  tick(ctx); // connect tick
  assert.equal(ctx.b.state, STATE.THROWN);
  pastHitstop(ctx);
  tick(ctx);
  assert.equal(ctx.b.state, STATE.THROWN, 'no tech from a press made before the connect');
  assert.equal(events(ctx, EVENT.TECH).length, 0);
});

test('tech_untechableThrow_ignoresThePress', () => {
  const ctx = duelAt(0.95);
  ctx.a.moves = { ...MOVES, throw: { ...T, techable: false } };
  grabbed(ctx);
  pastHitstop(ctx);
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.b.state, STATE.THROWN);
  assert.equal(ctx.b.hp, R.maxHp - T.damage);
  assert.equal(events(ctx, EVENT.TECH).length, 0);
});

test('tech_lethalThrow_koesAtConnect_noWindow', () => {
  // Spec gap, decided: damage lands at connect, so a throw that kills ends the round there.
  const ctx = duelAt(0.95);
  ctx.b.hp = T.damage;
  ctx.in0.throw = true;
  run(ctx, T.startup + 1);
  assert.equal(ctx.b.state, STATE.KO);
  assert.equal(ctx.sim.koFrame >= 0, true);
  pastHitstop(ctx);
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.b.state, STATE.KO);
  assert.equal(ctx.a.state === STATE.TECH, false);
});

test('tech_bothPushedApartByTechPushback', () => {
  const ctx = grabbed();
  pastHitstop(ctx);
  const d0 = dist(ctx.a, ctx.b);
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.a.pushFrames > 0 && ctx.b.pushFrames > 0, true, 'both are sliding');
  run(ctx, R.pushbackFrames);
  assert.ok(Math.abs(dist(ctx.a, ctx.b) - d0 - 2 * R.techPushback) < 1e-6, `apart by ${dist(ctx.a, ctx.b) - d0}`);
});

test('tech_noMovementWhileLocked_thenBothActAfterTechFrames', () => {
  const ctx = grabbed();
  pastHitstop(ctx);
  ctx.in1.throw = true;
  tick(ctx);
  ctx.in0.stick.x = 1;
  ctx.in1.light = true;
  run(ctx, R.pushbackFrames);
  const ax = ctx.a.x;
  run(ctx, R.techFrames - R.pushbackFrames - 2);
  assert.equal(ctx.a.state, STATE.TECH);
  assert.equal(ctx.a.x, ax, 'no walking during tech');
  run(ctx, 2);
  assert.equal(ctx.a.state, STATE.WALK, 'free again');
  ctx.in1.light = true;
  tick(ctx);
  assert.equal(ctx.b.state, STATE.ATTACK, 'free again');
});

test('tech_cannotBeThrown_butAStrikeHits', () => {
  const t = duelAt(0.95);
  setState(t.b, STATE.THROWN);
  setState(t.b, STATE.TECH);
  t.b.stunLeft = 30;
  startAttack(t.a, t.b, 'throw');
  t.a.stateFrame = T.startup;
  tick(t);
  assert.equal(t.b.state, STATE.TECH, 'never grabbed out of a tech');
  assert.equal(t.b.hp, R.maxHp);

  const s = duelAt(0.95);
  setState(s.b, STATE.THROWN);
  setState(s.b, STATE.TECH);
  s.b.stunLeft = 30;
  startAttack(s.a, s.b, 'light');
  s.a.stateFrame = MOVES.light.startup;
  tick(s);
  assert.equal(s.b.state, STATE.HITSTUN);
  assert.equal(events(s, EVENT.HIT)[0].counter, 0, 'tech is not a counter state');
});

test('tech_struckByAHazard_goesToHitstun', () => {
  // The hazard's zone sits on fighter 1's start position; its first strike lands on the tick after the telegraph.
  const VENT = {
    id: 'vent', zone: { x0: 1.0, x1: 2.0 },
    cycle: { period_ms: 3000, telegraph_ms: 600, active_ms: 200, phase_ms: 100 },
    effect: { damage: 10, knockback: 0.5, hitstun_frames: 20 },
  };
  const ruleset = createRuleset({ rules: COMBAT.rules, movement: COMBAT.movement, moves: COMBAT.greyboxMoves, round: COMBAT.round, meter: COMBAT.meter, hazards: [VENT] });
  const sim = engineCreateDuel(ruleset);
  const [, b] = sim.fighters;
  const ctx = { sim, a: sim.fighters[0], b, in0: createSnapshot(), in1: createSnapshot() };
  setState(b, STATE.THROWN);
  setState(b, STATE.TECH);
  b.stunLeft = 600;
  for (let i = 0; i < 60 && b.hp === R.maxHp; i++) tick(ctx);
  assert.equal(b.hp, R.maxHp - VENT.effect.damage, 'the vent struck the fighter in tech');
  assert.equal(b.state, STATE.HITSTUN);
});

test('techReady_onlyInTheThrownStateWithAGrab', () => {
  const idle = duelAt(0.95);
  idle.b.bufAction = 3;
  assert.equal(techReady(idle.b, idle.a, R), false, 'idle');
  const ctx = grabbed();
  ctx.b.bufAction = 3;
  assert.equal(techReady(ctx.b, ctx.a, R), true);
  ctx.b.bufAction = 1;
  assert.equal(techReady(ctx.b, ctx.a, R), false, 'a Light press does not tech');
  ctx.b.bufAction = 3;
  ctx.a.state = STATE.KO;
  assert.equal(techReady(ctx.b, ctx.a, R), false, 'nobody left to break free from');
});

test('frameDataTracker_teched_reportsTheOutcome_noDamage', () => {
  const ctx = duelAt(0.95);
  const tracker = new FrameDataTracker(0);
  ctx.in0.throw = true;
  for (let i = 0; i < T.startup + 1 + T.hitstop; i++) {
    tick(ctx);
    tracker.observe(ctx.sim);
  }
  assert.equal(tracker.outcome, OUTCOME.THROW);
  ctx.in1.throw = true;
  tick(ctx);
  tracker.observe(ctx.sim);
  assert.equal(tracker.outcome, OUTCOME.TECH);
  assert.equal(tracker.damage, 0);
  assert.equal(tracker.comboDamage, 0);
});
