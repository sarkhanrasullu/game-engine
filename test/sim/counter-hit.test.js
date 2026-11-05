// P1 counter-hit and punish-counter (design/quick-specs/fight-systems-gap-2026-11-05.md section 3, P1):
// a strike that hits a defender in its own attack earns a tier from the defender's phase read BEFORE
// any state change. Greybox fixture kit; the fixture ruleset ships no new keys, so these also prove the
// fighter-config defaults (the spec's values).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE, PHASE, attackPhase, setState, startAttack } from '../fixtures/bound/state-machine.js';
import { EVENT } from '../fixtures/bound/duel-sim.js';
import { RULESET } from '../fixtures/bound/ruleset.js';
import { COUNTER_TIER, counterTier, buildRules, buildMeter, RULE_DEFAULTS, METER_DEFAULTS, FrameDataTracker } from '../../src/sim/index.js';
import { duelAt, tick, run } from './duel-helpers.js';

const { rules: R, meter: M, moves: K } = RULESET;
const hitEvent = (ctx, attacker) => {
  for (let i = 0; i < ctx.sim.eventCount; i++) {
    const e = ctx.sim.events[i];
    if (e.type === EVENT.HIT && e.attacker === attacker) return e;
  }
  return null;
};
/** Tick until fighter `attacker` lands a hit event; returns it (the contact tick is the current one). */
function untilHit(ctx, attacker, limit = 40) {
  for (let i = 0; i < limit; i++) {
    tick(ctx);
    const e = hitEvent(ctx, attacker);
    if (e !== null) return { e: { ...e } };
  }
  throw new Error('no hit');
}

/**
 * Fighter 1 starts its attack first; fighter 0 presses `move` so it connects inside the wanted phase.
 * attackHasHit marks fighter 1's own move as spent so only fighter 0's strike can connect.
 */
function strikeDuring(oppMove, leadTicks, move = 'light') {
  const ctx = duelAt(1.0);
  startAttack(ctx.b, ctx.a, oppMove);
  ctx.b.stateFrame = 1 + leadTicks;
  ctx.b.attackHasHit = true;
  startAttack(ctx.a, ctx.b, move);
  ctx.a.stateFrame = 1;
  const { e } = untilHit(ctx, 0);
  return { ctx, e };
}

test('ruleKeys_defaults_equalTheSpecValues', () => {
  assert.equal(RULE_DEFAULTS.counterDamageScale, 1.15);
  assert.equal(RULE_DEFAULTS.counterHitstunBonus, 5);
  assert.equal(RULE_DEFAULTS.punishDamageScale, 1.2);
  assert.equal(RULE_DEFAULTS.punishHitstunBonus, 8);
  assert.equal(METER_DEFAULTS.counterMeterScale, 1.5);
  // The fixture data ships none of them, and still validates with the spec's numbers.
  assert.equal(R.counterDamageScale, 1.15);
  assert.equal(M.counterMeterScale, 1.5);
});

test('buildRules_counterKeys_rejectBadValues', () => {
  const base = { ...RULESET.rules };
  assert.throws(() => buildRules({ ...base, counterHitstunBonus: 1.5 }), /counterHitstunBonus/);
  assert.throws(() => buildRules({ ...base, punishHitstunBonus: -1 }), /punishHitstunBonus/);
  assert.throws(() => buildRules({ ...base, counterDamageScale: -0.1 }), /counterDamageScale/);
  assert.throws(() => buildRules({ ...base, punishDamageScale: 'x' }), /punishDamageScale/);
  assert.throws(() => buildMeter({ ...RULESET.meter, counterMeterScale: -1 }), /counterMeterScale/);
  assert.throws(() => buildRules(undefined), /missing section/);
});

test('counterTier_readsThePhase_throwAndNonAttackStatesAreNone', () => {
  const { a, b } = duelAt(1.0);
  assert.equal(counterTier(b), COUNTER_TIER.NONE, 'idle');
  startAttack(b, a, 'heavy');
  b.stateFrame = 1;
  assert.equal(attackPhase(b), PHASE.STARTUP);
  assert.equal(counterTier(b), COUNTER_TIER.COUNTER);
  b.stateFrame = K.heavy.startup + 1;
  assert.equal(attackPhase(b), PHASE.ACTIVE);
  assert.equal(counterTier(b), COUNTER_TIER.COUNTER);
  b.stateFrame = K.heavy.startup + K.heavy.active + 1;
  assert.equal(attackPhase(b), PHASE.RECOVERY);
  assert.equal(counterTier(b), COUNTER_TIER.PUNISH);
  const t = duelAt(1.0);
  startAttack(t.b, t.a, 'throw');
  for (const n of [1, K.throw.startup + 1, K.throw.startup + K.throw.active + 1]) {
    t.b.stateFrame = n;
    assert.equal(counterTier(t.b), COUNTER_TIER.NONE, `throw frame ${n}`);
  }
});

test('hitOnStartup_isACounter_scaledDamageAndBonusStun', () => {
  const { ctx, e } = strikeDuring('heavy', 0);
  assert.equal(e.counter, COUNTER_TIER.COUNTER);
  assert.equal(e.damage, Math.round(K.light.damage * R.counterDamageScale));
  assert.equal(ctx.b.state, STATE.HITSTUN);
  assert.equal(ctx.b.stunLeft, K.light.hitstun + R.counterHitstunBonus);
  assert.equal(ctx.b.hp, R.maxHp - e.damage);
  assert.equal(ctx.a.hitCounter, COUNTER_TIER.COUNTER);
});

test('hitOnActive_isACounter', () => {
  // Fighter 1's own hit is spent, so only fighter 0 connects, on a frame of fighter 1's active window.
  const ctx = duelAt(1.0);
  startAttack(ctx.a, ctx.b, 'light');
  ctx.a.stateFrame = K.light.startup; // active next tick
  startAttack(ctx.b, ctx.a, 'light');
  ctx.b.stateFrame = K.light.startup; // active next tick too, but its hit is spent
  ctx.b.attackHasHit = true;
  tick(ctx);
  const e = hitEvent(ctx, 0);
  assert.equal(e.counter, COUNTER_TIER.COUNTER);
  assert.equal(ctx.b.stunLeft, K.light.hitstun + R.counterHitstunBonus);
});

test('hitOnRecovery_isAPunish_scaledDamageAndBonusStun', () => {
  const ctx = duelAt(1.0);
  startAttack(ctx.b, ctx.a, 'light');
  ctx.b.stateFrame = K.light.startup + K.light.active; // recovery on the next tick
  ctx.b.attackHasHit = true;
  startAttack(ctx.a, ctx.b, 'heavy');
  ctx.a.stateFrame = K.heavy.startup;
  tick(ctx);
  const e = hitEvent(ctx, 0);
  assert.equal(e.counter, COUNTER_TIER.PUNISH);
  assert.equal(e.damage, Math.round(K.heavy.damage * R.punishDamageScale));
  assert.equal(ctx.b.stunLeft, K.heavy.hitstun + R.punishHitstunBonus);
  assert.equal(ctx.a.hitCounter, COUNTER_TIER.PUNISH);
});

test('hitOnIdleHitstunBlockstunSidestepJump_isNormal', () => {
  const stateSetups = {
    idle: () => {},
    hitstun: (b) => { setState(b, STATE.HITSTUN); b.stunLeft = 40; },
    blockstun: (b) => { setState(b, STATE.BLOCKSTUN); b.stunLeft = 40; }, // a stand block loses to the low below
    sidestep: (b) => { b.sidestepT = 0.3; b.sidestepDir = 1; setState(b, STATE.SIDESTEP); },
  };
  for (const [name, set] of Object.entries(stateSetups)) {
    const ctx = duelAt(1.0);
    set(ctx.b);
    startAttack(ctx.a, ctx.b, 'crouchLight');
    ctx.a.stateFrame = K.crouchLight.startup;
    tick(ctx);
    const e = hitEvent(ctx, 0);
    assert.ok(e, `${name}: connected`);
    assert.equal(e.counter, COUNTER_TIER.NONE, name);
    assert.equal(e.damage, K.crouchLight.damage, name);
    assert.equal(ctx.b.stunLeft, K.crouchLight.hitstun, name);
    assert.equal(ctx.a.hitCounter, COUNTER_TIER.NONE, name);
  }
  // Airborne: a mid reaches a rising fighter, and it is never a counter.
  const air = duelAt(1.0);
  air.b.grounded = false;
  air.b.y = 0.2;
  air.b.vy = 2;
  setState(air.b, STATE.JUMP);
  startAttack(air.a, air.b, 'heavy');
  air.a.stateFrame = K.heavy.startup;
  tick(air);
  const e = hitEvent(air, 0);
  assert.ok(e, 'jump: connected');
  assert.equal(e.counter, COUNTER_TIER.NONE);
});

test('trade_bothActive_bothCountersRegardlessOfOrder', () => {
  // Fighter 0 resolves first; the tier is read from the pre-hit state, so fighter 1's event matches.
  const ctx = duelAt(1.0);
  startAttack(ctx.a, ctx.b, 'light');
  startAttack(ctx.b, ctx.a, 'light');
  ctx.a.stateFrame = ctx.b.stateFrame = K.light.startup;
  tick(ctx);
  const e0 = hitEvent(ctx, 0);
  const e1 = hitEvent(ctx, 1);
  assert.equal(e0.counter, COUNTER_TIER.COUNTER);
  assert.equal(e1.counter, COUNTER_TIER.COUNTER);
  assert.equal(e0.damage, e1.damage);
  assert.equal(ctx.a.hp, ctx.b.hp);
  assert.equal(ctx.a.stunLeft, ctx.b.stunLeft);
  assert.equal(ctx.a.stunLeft, K.light.hitstun + R.counterHitstunBonus);
});

test('throw_neverCounters_andIsNeverCountered', () => {
  // A throw connecting on an attacker in startup: plain damage, no tier.
  const t = duelAt(0.95);
  startAttack(t.b, t.a, 'heavy');
  t.b.stateFrame = 1;
  startAttack(t.a, t.b, 'throw');
  t.a.stateFrame = K.throw.startup;
  tick(t);
  const thrown = [...t.sim.events.slice(0, t.sim.eventCount)].find((e) => e.type === EVENT.THROW);
  assert.ok(thrown);
  assert.equal(thrown.counter, COUNTER_TIER.NONE);
  assert.equal(thrown.damage, K.throw.damage);
  assert.equal(t.b.stunLeft, K.throw.thrownFrames);
  // A strike on a whiffed throw, startup and recovery alike: plain damage, no tier.
  for (const lead of [0, K.throw.startup + K.throw.active]) {
    const c = duelAt(1.0);
    startAttack(c.b, c.a, 'throw');
    c.b.stateFrame = lead + 1;
    c.b.attackHasHit = true;
    startAttack(c.a, c.b, 'light');
    c.a.stateFrame = K.light.startup;
    tick(c);
    const e = hitEvent(c, 0);
    assert.equal(e.counter, COUNTER_TIER.NONE, `throw lead ${lead}`);
    assert.equal(e.damage, K.light.damage, `throw lead ${lead}`);
  }
});

test('armourAbsorb_isNotACounter_armourBreakIs', () => {
  const armored = { ...K.heavy, armor: { from: 1, to: K.heavy.startup, hits: 1, damageScale: 0.5, levels: ['high', 'mid'] } };
  const kit = { ...K, heavy: armored };
  // Absorbed: damage scale from the armour, no stun, no tier.
  const c = duelAt(1.0);
  c.b.moves = kit;
  startAttack(c.b, c.a, 'heavy');
  c.b.stateFrame = 1;
  startAttack(c.a, c.b, 'light');
  c.a.stateFrame = K.light.startup;
  tick(c);
  const e = hitEvent(c, 0);
  assert.equal(e.armor, 1);
  assert.equal(e.counter, COUNTER_TIER.NONE);
  assert.equal(e.damage, Math.round(K.light.damage * 0.5));
  assert.equal(c.b.state, STATE.ATTACK);
  // A low the armour does not cover breaks through: that one is a counter.
  const l = duelAt(1.0);
  l.b.moves = kit;
  startAttack(l.b, l.a, 'heavy');
  l.b.stateFrame = 1;
  startAttack(l.a, l.b, 'crouchLight');
  l.a.stateFrame = K.crouchLight.startup;
  tick(l);
  const low = hitEvent(l, 0);
  assert.equal(low.armor, 0);
  assert.equal(low.counter, COUNTER_TIER.COUNTER);
});

test('counterMeter_attackerGainsScaledRate_defenderGainsNormalRate', () => {
  const { ctx, e } = strikeDuring('heavy', 0, 'heavy');
  assert.equal(e.counter, COUNTER_TIER.COUNTER);
  const dmg = Math.round(K.heavy.damage * R.counterDamageScale);
  assert.equal(ctx.a.meter, Math.round(M.hitDealt * M.counterMeterScale * dmg));
  assert.equal(ctx.b.meter, Math.round(M.hitTaken * dmg));
});

test('events_stalePoolEntries_doNotLeakATier', () => {
  // A counter fills an event slot; the next plain hit on the same slot must read 0.
  const { ctx } = strikeDuring('heavy', 0);
  run(ctx, 60);
  startAttack(ctx.a, ctx.b, 'light');
  ctx.a.stateFrame = K.light.startup;
  tick(ctx);
  const e = hitEvent(ctx, 0);
  assert.ok(e);
  assert.equal(e.counter, COUNTER_TIER.NONE);
});

test('beginMove_clearsTheAttackersTier', () => {
  const { ctx } = strikeDuring('heavy', 0);
  assert.equal(ctx.a.hitCounter, COUNTER_TIER.COUNTER);
  run(ctx, 60);
  startAttack(ctx.a, ctx.b, 'light');
  assert.equal(ctx.a.hitCounter, COUNTER_TIER.NONE);
});

test('frameDataTracker_counterHit_reportsTheRealAdvantage', () => {
  const ctx = duelAt(1.0);
  const tracker = new FrameDataTracker(0);
  startAttack(ctx.b, ctx.a, 'heavy');
  ctx.b.stateFrame = 1;
  ctx.b.attackHasHit = true;
  startAttack(ctx.a, ctx.b, 'light');
  ctx.a.stateFrame = K.light.startup;
  tracker.observe(ctx.sim);
  tick(ctx);
  tracker.observe(ctx.sim);
  const plain = K.light.hitstun - (K.light.startup + K.light.active + K.light.recovery - (K.light.startup + 1));
  assert.equal(tracker.advantage, plain + R.counterHitstunBonus);
});
