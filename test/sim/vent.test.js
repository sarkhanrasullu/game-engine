// P3 Vent (design/quick-specs/fight-systems-gap-2026-11-05.md P3): in own BLOCKSTUN on an unfrozen tick, a buffered
// Throw press with meter >= ventCost spends it and pushes the ATTACKER away. The defender's blockstun is unchanged:
// Vent is not a reversal. Below the cost the press stays a buffered throw. Fixture ships no key: defaults are the spec's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE, setState, startAttack, ventReady } from '../fixtures/bound/state-machine.js';
import { CUE } from '../fixtures/bound/duel-sim.js';
import { MOVES } from '../fixtures/bound/moves.js';
import { RULESET } from '../fixtures/bound/ruleset.js';
import { METER_DEFAULTS, buildMeter } from '../../src/sim/index.js';
import { duelAt, tick, run, dist } from './duel-helpers.js';

const { rules: R, meter: M } = RULESET;
const H = MOVES.heavy;
const cues = (ctx, type) => ctx.sim.cues.slice(0, ctx.sim.cueCount).filter((c) => c.type === type);

/** Fighter 0's heavy is blocked by fighter 1 (meter set); returns at the block tick, hitstop about to run. */
function blocking(meter = M.ventCost, d = 1.1) {
  const ctx = duelAt(d);
  ctx.b.meter = meter;
  ctx.in1.guard = true;
  tick(ctx);
  assert.equal(ctx.b.state, STATE.GUARD);
  startAttack(ctx.a, ctx.b, 'heavy');
  ctx.a.stateFrame = H.startup;
  tick(ctx);
  assert.equal(ctx.b.state, STATE.BLOCKSTUN, 'blocked');
  return ctx;
}

test('ventKeys_defaults_equalTheSpecValues', () => {
  assert.equal(METER_DEFAULTS.ventCost, 25);
  assert.equal(METER_DEFAULTS.ventPushback, 0.9);
  assert.equal(M.ventCost, 25);
  assert.equal(M.ventPushback, 0.9);
  assert.throws(() => buildMeter({ ...M, ventCost: 1.5 }), /ventCost/);
  assert.throws(() => buildMeter({ ...M, ventPushback: -1 }), /ventPushback/);
});

test('vent_withMeter_spendsTheCost_pushesTheAttacker_cuesTheSide_consumesThePress', () => {
  const ctx = blocking(M.ventCost + 7);
  const meter = ctx.b.meter;
  run(ctx, H.blockHitstop);
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.b.meter, meter - M.ventCost, 'cost spent');
  assert.equal(ctx.b.bufAction, 0, 'press consumed');
  assert.equal(ctx.b.bufFrames, 0);
  const [c] = cues(ctx, CUE.VENT);
  assert.ok(c, 'CUE.VENT');
  assert.equal(c.side, 1);
  assert.equal(ctx.a.state, STATE.ATTACK, "the attacker's move carries on");
  assert.equal(ctx.a.moveId, 'heavy');
});

test('vent_pushesTheAttackerByVentPushback_awayFromTheDefender', () => {
  const ctx = blocking();
  run(ctx, H.blockHitstop);
  // Let the block's own pushback finish so only the Vent's push is measured.
  ctx.in1.guard = true;
  run(ctx, R.pushbackFrames);
  const ax = ctx.a.x;
  const d0 = dist(ctx.a, ctx.b);
  ctx.in1.throw = true;
  tick(ctx);
  run(ctx, R.pushbackFrames - 1);
  assert.ok(ctx.a.x < ax, 'pushed away (fighter 0 starts on the -x side)');
  assert.ok(Math.abs(dist(ctx.a, ctx.b) - d0 - M.ventPushback) < 1e-6, `moved ${dist(ctx.a, ctx.b) - d0}`);
});

test('vent_blockstunUnchanged_notAReversal', () => {
  const plain = blocking();
  run(plain, H.blockHitstop);
  const vented = blocking();
  run(vented, H.blockHitstop);
  vented.in1.throw = true;
  for (let i = 0; i < H.blockstun + 2; i++) {
    tick(plain);
    tick(vented);
    assert.equal(vented.b.stunLeft, plain.b.stunLeft, `tick ${i}: the same stun`);
    assert.equal(vented.b.state, plain.b.state, `tick ${i}: the same state`);
  }
});

test('vent_belowTheCost_pressStaysABufferedThrow', () => {
  const ctx = blocking();
  ctx.b.meter = M.ventCost - 1; // after the block: the block's own contact gain could have paid for it
  run(ctx, H.blockHitstop);
  run(ctx, H.blockstun - 2);
  const meter = ctx.b.meter;
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.b.state, STATE.BLOCKSTUN);
  assert.equal(ctx.b.meter, meter, 'nothing spent');
  assert.equal(ctx.b.bufAction, 3, 'still buffered');
  assert.equal(cues(ctx, CUE.VENT).length, 0);
  ctx.in1.guard = false;
  run(ctx, 2);
  assert.equal(ctx.b.state, STATE.ATTACK, 'it comes out as the throw it always was');
  assert.equal(ctx.b.moveId, 'throw');
});

test('vent_pressDuringHitstop_doesNotResolveUntilTheFirstUnfrozenTick', () => {
  const ctx = blocking();
  const meter = ctx.b.meter;
  ctx.in1.throw = true;
  tick(ctx); // frozen
  assert.equal(ctx.b.meter, meter, 'not yet');
  assert.equal(ctx.sim.cueCount, 0);
  run(ctx, H.blockHitstop - 1); // through the last frozen tick
  assert.equal(ctx.b.meter, meter, 'still not');
  tick(ctx);
  assert.equal(ctx.b.meter, meter - M.ventCost, 'first unfrozen tick');
  assert.equal(cues(ctx, CUE.VENT).length, 1);
});

test('vent_notDuringASuperFreeze', () => {
  const ctx = blocking();
  run(ctx, H.blockHitstop);
  const meter = ctx.b.meter;
  ctx.sim.freezeLeft = 3;
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.b.meter, meter);
  run(ctx, 2);
  assert.equal(ctx.b.meter, meter, 'held through the freeze');
  tick(ctx);
  assert.equal(ctx.b.meter, meter - M.ventCost);
});

test('vent_onlyInBlockstun_notIdleHitstunThrownGuard', () => {
  const setups = {
    idle: () => {},
    guard: (f) => { setState(f, STATE.GUARD); },
    hitstun: (f) => { setState(f, STATE.HITSTUN); f.stunLeft = 20; },
    thrown: (f) => { setState(f, STATE.THROWN); f.stunLeft = 20; },
  };
  for (const [name, set] of Object.entries(setups)) {
    const ctx = duelAt(1.2);
    set(ctx.b);
    ctx.b.meter = M.ventCost;
    ctx.b.bufAction = 3;
    ctx.b.bufFrames = 6;
    assert.equal(ventReady(ctx.b, ctx.a, M), false, name);
  }
});

test('ventReady_conditions', () => {
  const ctx = blocking();
  ctx.b.bufAction = 3;
  assert.equal(ventReady(ctx.b, ctx.a, M), true);
  ctx.b.bufAction = 1;
  assert.equal(ventReady(ctx.b, ctx.a, M), false, 'a Light press is not a Vent');
  ctx.b.bufAction = 3;
  ctx.b.meter = M.ventCost - 1;
  assert.equal(ventReady(ctx.b, ctx.a, M), false, 'below the cost');
  ctx.b.meter = M.ventCost;
  ctx.b.stunLeft = 0;
  assert.equal(ventReady(ctx.b, ctx.a, M), false, 'leaving blockstun this tick: the press is a throw');
  ctx.b.stunLeft = 3;
  ctx.a.state = STATE.KO;
  assert.equal(ventReady(ctx.b, ctx.a, M), false, 'nobody to push');
});

test('vent_fullMeter_dropsBelowFull_noFullCue', () => {
  const ctx = blocking();
  ctx.b.meter = M.max;
  run(ctx, H.blockHitstop);
  ctx.in1.throw = true;
  tick(ctx);
  assert.equal(ctx.b.meter, ctx.b.meterMax - M.ventCost);
  assert.equal(cues(ctx, CUE.METER_FULL).length, 0);
});
