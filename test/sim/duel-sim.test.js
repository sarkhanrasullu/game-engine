// story-002 AC 2-6, 8: hit resolution, guard, throws, trades, punish, KO, hitstop, events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE, PHASE, attackPhase, setState } from '../fixtures/bound/state-machine.js';
import { EVENT } from '../fixtures/bound/duel-sim.js';
import { MOVES } from '../fixtures/bound/moves.js';
import { FIGHTER_RULES } from '../fixtures/bound/fighter-config.js';
import { duelAt, tick, run, runTo, dist } from './duel-helpers.js';

const L = MOVES.light;

function events(ctx) {
  return ctx.sim.events.slice(0, ctx.sim.eventCount).map((e) => ({ ...e }));
}

test('hit lands only on the first active tick and only once per attack', () => {
  const ctx = duelAt(1.2);
  ctx.in0.light = true;
  runTo(ctx, L.startup);
  assert.equal(ctx.b.hp, 100, 'no hit during startup');
  tick(ctx);
  assert.equal(ctx.b.hp, 100 - L.damage);
  const ev = events(ctx);
  assert.equal(ev[0].type, EVENT.HIT);
  assert.equal(ev[0].fx, 'light');
  run(ctx, 40);
  assert.equal(ctx.b.hp, 100 - L.damage, 'second active tick does not hit again');
});

test('on hit: hitstun, pushback, and hitstop freezes both fighters', () => {
  const ctx = duelAt(1.2);
  ctx.in0.light = true;
  runTo(ctx, L.startup + 1);
  assert.equal(ctx.b.state, STATE.HITSTUN);
  assert.equal(ctx.b.stunLeft, L.hitstun);
  const snap = [ctx.a.x, ctx.b.x, ctx.a.stateFrame, ctx.b.stunLeft];
  for (let i = 0; i < L.hitstop; i++) {
    tick(ctx);
    assert.deepEqual([ctx.a.x, ctx.b.x, ctx.a.stateFrame, ctx.b.stunLeft], snap, 'frozen');
  }
  run(ctx, FIGHTER_RULES.pushbackFrames);
  assert.ok(Math.abs(dist(ctx.a, ctx.b) - (1.2 + L.pushback)) < 1e-9);
});

test('standing guard blocks a high: blockstun, zero damage, smaller pushback, guard spark event', () => {
  const ctx = duelAt(1.2);
  ctx.in1.guard = true;
  ctx.in0.light = true;
  runTo(ctx, L.startup + 1);
  assert.equal(ctx.b.state, STATE.BLOCKSTUN);
  assert.equal(ctx.b.hp, 100);
  assert.equal(events(ctx)[0].type, EVENT.BLOCK);
  assert.equal(events(ctx)[0].damage, 0);
  run(ctx, L.blockHitstop + FIGHTER_RULES.pushbackFrames);
  assert.ok(Math.abs(dist(ctx.a, ctx.b) - (1.2 + L.blockPushback)) < 1e-9);
  assert.ok(L.blockPushback < L.pushback);
});

test('guard levels: low beats standing guard, crouch guard blocks low, mid beats crouch guard', () => {
  const cases = [
    { move: 'crouchLight', crouchGuard: false, want: STATE.HITSTUN },
    { move: 'crouchLight', crouchGuard: true, want: STATE.BLOCKSTUN },
    { move: 'heavy', crouchGuard: true, want: STATE.HITSTUN },
    { move: 'heavy', crouchGuard: false, want: STATE.BLOCKSTUN },
  ];
  for (const c of cases) {
    const ctx = duelAt(1.2);
    ctx.in1.guard = true;
    ctx.in1.stick.y = c.crouchGuard ? -1 : 0;
    const crouchMove = MOVES[c.move].crouching;
    ctx.in0.stick.y = crouchMove ? -1 : 0;
    tick(ctx);
    if (c.move === 'crouchLight') ctx.in0.light = true; else ctx.in0.heavy = true;
    run(ctx, MOVES[c.move].startup + 1);
    assert.equal(ctx.a.moveId, c.move);
    assert.equal(ctx.b.state, c.want, `${c.move} vs ${c.crouchGuard ? 'crouch' : 'stand'} guard`);
  }
});

test('throw beats guard and blockstun, is unblockable, and deals damage', () => {
  for (const pre of ['guard', 'blockstun']) {
    const ctx = duelAt(1.0);
    ctx.in1.guard = true;
    tick(ctx);
    if (pre === 'blockstun') { setState(ctx.b, STATE.BLOCKSTUN); ctx.b.stunLeft = 40; }
    ctx.in0.throw = true;
    run(ctx, MOVES.throw.startup + 1);
    assert.equal(ctx.b.state, STATE.THROWN, pre);
    assert.equal(ctx.b.hp, 100 - MOVES.throw.damage);
    assert.equal(events(ctx)[0].type, EVENT.THROW);
  }
});

test('throw whiffs on an opponent in hitstun or airborne', () => {
  const stun = duelAt(1.0);
  setState(stun.b, STATE.HITSTUN);
  stun.b.stunLeft = 60;
  stun.in0.throw = true;
  run(stun, MOVES.throw.startup + MOVES.throw.active);
  assert.equal(stun.b.state, STATE.HITSTUN);
  assert.equal(stun.b.hp, 100);

  const air = duelAt(1.0);
  air.in1.stick.y = 1;
  air.in0.throw = true;
  tick(air);
  air.in1.stick.y = 0;
  run(air, MOVES.throw.startup + MOVES.throw.active);
  assert.equal(air.b.hp, 100);
  assert.equal(attackPhase(air.a), PHASE.RECOVERY, 'thrower is left in whiff recovery');
});

test('simultaneous strikes trade: both take counter damage and both enter hitstun', () => {
  const ctx = duelAt(1.2);
  ctx.in0.light = true;
  ctx.in1.light = true;
  runTo(ctx, L.startup + 1);
  // A trade is two counters (both defenders were active): fight-systems-gap spec P1.
  const each = Math.round(L.damage * ctx.sim.rules.counterDamageScale);
  assert.equal(ctx.a.hp, 100 - each);
  assert.equal(ctx.b.hp, 100 - each);
  assert.equal(ctx.a.state, STATE.HITSTUN);
  assert.equal(ctx.b.state, STATE.HITSTUN);
});

test('strike beats a throw on the same tick; two throws clash and both whiff', () => {
  const ctx = duelAt(1.0);
  ctx.in0.light = true;
  tick(ctx);
  ctx.in1.throw = true; // throw active on the same tick as the Light
  runTo(ctx, L.startup + 1);
  assert.equal(ctx.b.state, STATE.HITSTUN);
  assert.equal(ctx.a.hp, 100);

  const clash = duelAt(1.0);
  clash.in0.throw = true;
  clash.in1.throw = true;
  run(clash, MOVES.throw.startup + MOVES.throw.active + 1);
  assert.equal(clash.a.hp, 100);
  assert.equal(clash.b.hp, 100);
  assert.equal(attackPhase(clash.a), PHASE.RECOVERY);
});

test('whiffed high over a croucher is punished by a Light during its recovery', () => {
  const ctx = duelAt(1.2);
  ctx.in1.stick.y = -1;
  ctx.in0.light = true;
  runTo(ctx, L.startup);
  ctx.in1.light = true; // crouching Light
  run(ctx, L.active + 1);
  assert.equal(ctx.b.hp, 100, 'high whiffed over the crouch');
  assert.equal(attackPhase(ctx.a), PHASE.RECOVERY);
  run(ctx, MOVES.crouchLight.startup + 1);
  assert.equal(ctx.a.state, STATE.HITSTUN, 'punished in recovery');
});

test('whiffed Heavy is punishable by a Light', () => {
  const ctx = duelAt(2.0); // out of Heavy reach
  ctx.in0.heavy = true;
  run(ctx, MOVES.heavy.startup + MOVES.heavy.active + 1);
  assert.equal(attackPhase(ctx.a), PHASE.RECOVERY);
  ctx.b.x = ctx.b.prevX = ctx.a.x + 1.2; // defender closes in
  ctx.in1.light = true;
  run(ctx, L.startup + 1);
  assert.ok(L.startup < MOVES.heavy.recovery);
  assert.equal(ctx.a.state, STATE.HITSTUN);
});

test('KO at 0 HP: KO state and events, no further hits, input ignored', () => {
  const ctx = duelAt(1.2);
  ctx.b.hp = 3;
  ctx.in0.light = true;
  runTo(ctx, L.startup + 1);
  assert.equal(ctx.b.hp, 0);
  assert.equal(ctx.b.state, STATE.KO);
  assert.deepEqual(events(ctx).map((e) => e.type), [EVENT.HIT, EVENT.KO]);
  assert.equal(ctx.sim.koFrame, L.startup + 1);
  assert.equal(ctx.sim.hitstop.remaining, FIGHTER_RULES.koHitstop);
  run(ctx, 60);
  ctx.in1.light = true;
  ctx.in0.light = true;
  run(ctx, 30);
  assert.equal(ctx.b.state, STATE.KO);
  assert.equal(ctx.b.hp, 0);
});

test('Overwind hit emits a super-class event with screen flash', () => {
  const ctx = duelAt(1.2);
  ctx.a.meter = ctx.a.meterMax;
  ctx.in0.guard = true;
  ctx.in0.heavy = true;
  runTo(ctx, MOVES.overwind.startup + 1 + ctx.sim.meter.superFreezeFrames);
  const e = events(ctx)[0];
  assert.equal(e.fx, 'super');
  assert.equal(e.super, 1);
  assert.ok(e.flash > 0 && e.shake > 0);
  assert.equal(ctx.b.hp, 100 - MOVES.overwind.damage);
});

test('the sim is deterministic: same inputs give identical state', () => {
  const play = () => {
    const ctx = duelAt(1.6);
    for (let i = 0; i < 600; i++) {
      ctx.in0.stick.x = (i % 50) < 25 ? 1 : -0.5;
      ctx.in1.stick.x = (i % 70) < 30 ? 1 : 0;
      ctx.in1.guard = (i % 90) > 60;
      ctx.in0.light = i % 23 === 0;
      ctx.in0.heavy = i % 41 === 0;
      ctx.in1.light = i % 31 === 0;
      ctx.in1.throw = i % 97 === 0;
      tick(ctx);
    }
    return JSON.stringify(ctx.sim.fighters);
  };
  assert.equal(play(), play());
});
