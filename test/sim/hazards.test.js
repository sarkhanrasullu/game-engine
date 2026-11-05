// Stage hazards (story-013 HAZARD-SIM): schema, telegraph timing, strikes, guard / armour rules,
// KO reason, toggle, schedules, determinism and the freeze rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import COMBAT from '../fixtures/combat_tuning.json' with { type: 'json' };
import { createSnapshot } from '../fixtures/bound/input-snapshot.js';
import {
  createRuleset, createDuel, stepDuel, resetDuel, setHazardsEnabled, buildHazards, msToFrames, isHazardEvent,
  HAZARD_EVENT, HAZARD_PHASE, KO_BY, EVENT, STATE, MatchFlow, ROUND_REASON, isKoReason, fighterInZone,
} from '../../src/sim/index.js';

const DT = 1 / 60;
/** A lane-edge vent over fighter 1's start position (startOffset 1.4, hurtRadius 0.35). */
const VENT = Object.freeze({
  id: 'vent',
  zone: { x0: 1.0, x1: 2.0 },
  cycle: { period_ms: 3000, telegraph_ms: 600, active_ms: 200, phase_ms: 100 },
  effect: { damage: 10, knockback: 0.5, hitstun_frames: 20 },
});
const TEL = msToFrames(600); // 36
const ACT = msToFrames(200); // 12
const PERIOD = msToFrames(3000); // 180
const PHASE = msToFrames(100); // 6

function rulesetWith(hazards) {
  return createRuleset({
    rules: COMBAT.rules, movement: COMBAT.movement, moves: COMBAT.greyboxMoves, round: COMBAT.round, meter: COMBAT.meter, hazards,
  });
}

/** Duel with `hazards`; `log` collects every hazard / KO event with the frame it fired on. */
function arena(hazards = [VENT], opts = undefined) {
  const sim = createDuel(rulesetWith(hazards), opts);
  const ctx = { sim, a: sim.fighters[0], b: sim.fighters[1], in0: createSnapshot(), in1: createSnapshot(), log: [] };
  return ctx;
}

function tick(ctx) {
  stepDuel(ctx.sim, ctx.in0, ctx.in1, DT);
  for (let i = 0; i < ctx.sim.eventCount; i++) {
    const e = ctx.sim.events[i];
    if (isHazardEvent(e.type) || e.type === EVENT.KO) ctx.log.push({ ...e, frame: ctx.sim.frame });
  }
  for (const s of [ctx.in0, ctx.in1]) {
    s.light = s.heavy = s.throw = false;
    s.sidestep = 0;
  }
}

function run(ctx, n) {
  for (let i = 0; i < n; i++) tick(ctx);
}

const ofType = (ctx, type) => ctx.log.filter((e) => e.type === type);

test('hazards_schema_rejectsBadDataAndFillsDefaults', () => {
  const ok = buildHazards([VENT]);
  assert.equal(ok.length, 1);
  assert.deepEqual([ok[0].telegraphFrames, ok[0].activeFrames, ok[0].periodFrames, ok[0].phaseFrames], [TEL, ACT, PERIOD, PHASE]);
  assert.deepEqual(ok[0].zone, { x0: 1, x1: 2, y0: -Infinity, y1: Infinity });
  assert.deepEqual(ok[0].effect, {
    damage: 10, knockback: 0.5, hitstunFrames: 20, launch: 0, ignoresGuard: false, armorBreaks: false, guardScale: 0.25,
    hitstop: 0, shake: 0.5, flash: 0.2, fx: 'heavy',
  });
  assert.equal(ok[0].schedule, 'periodic');
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok[0].zone));
  assert.deepEqual(buildHazards(undefined), []);
  const v = (over) => buildHazards([{ ...VENT, ...over }]);
  assert.throws(() => buildHazards({}), /must be a list/);
  assert.throws(() => v({ id: '' }), /id must be/);
  assert.throws(() => buildHazards([VENT, VENT]), /duplicate id/);
  assert.throws(() => v({ extra: 1 }), /unknown key extra/);
  assert.throws(() => v({ zone: { x0: 2, x1: 1 } }), /x0 < x1/);
  assert.throws(() => v({ zone: { x0: 1, x1: 2, y0: 0 } }), /y band/);
  assert.throws(() => v({ cycle: { ...VENT.cycle, telegraph_ms: 499 } }), /telegraph_ms must be >= 500/);
  assert.throws(() => v({ cycle: { ...VENT.cycle, period_ms: 800 } }), /period_ms must exceed/);
  assert.throws(() => v({ cycle: { ...VENT.cycle, active_ms: 0 } }), /active_ms/);
  assert.throws(() => v({ cycle: { ...VENT.cycle, jitter_ms: 2200 }, schedule: 'random' }), /jitter_ms must be smaller/);
  assert.throws(() => v({ effect: { ...VENT.effect, damage: 1.5 } }), /damage must be an integer/);
  assert.throws(() => v({ effect: { ...VENT.effect, hitstun_frames: 0 } }), /hitstun_frames/);
  assert.throws(() => v({ effect: { ...VENT.effect, guard_scale: 2 } }), /guard_scale/);
  assert.throws(() => v({ effect: { ...VENT.effect, ignores_guard: 1 } }), /ignores_guard/);
  assert.throws(() => v({ effect: { ...VENT.effect, fx: 'lava' } }), /effect.fx/);
  assert.throws(() => v({ schedule: 'daily' }), /schedule must be one of/);
  assert.throws(() => v({ schedule: 'scripted' }), /times_ms/);
  assert.throws(() => v({ schedule: 'scripted', times_ms: [0, 700] }), /apart/);
  assert.throws(() => v({ times_ms: [0] }), /only valid with schedule/);
  assert.doesNotThrow(() => v({ schedule: 'scripted', times_ms: [0, 1000] }));
});

test('hazards_telegraphFires500msOrMoreBeforeActive_oncePerCycle', () => {
  const ctx = arena();
  run(ctx, PERIOD * 2 + PHASE + 1);
  const tel = ofType(ctx, HAZARD_EVENT.TELEGRAPH);
  const act = ofType(ctx, HAZARD_EVENT.ACTIVE);
  const end = ofType(ctx, HAZARD_EVENT.END);
  assert.deepEqual(tel.map((e) => e.frame), [PHASE, PHASE + PERIOD, PHASE + 2 * PERIOD]);
  assert.deepEqual(act.map((e) => e.frame), [tel[0].frame + TEL, tel[1].frame + TEL], 'the third telegraph is still showing when the run ends');
  assert.ok(TEL >= msToFrames(500), 'telegraph >= 500 ms');
  assert.deepEqual(end.map((e) => e.frame), act.map((e) => e.frame + ACT));
  assert.equal(tel[0].id, 'vent');
  assert.equal(tel[0].in_frames, TEL);
  assert.equal(tel[0].zone, ctx.sim.hazards[0].data.zone, 'zone is the frozen data reference (no allocation)');
  assert.equal(tel[0].target, -1);
  assert.equal(act[0].in_frames, 0);
});

test('hazards_fighterInZoneTakesTheEffectOncePerActivation_otherUntouched', () => {
  const ctx = arena();
  assert.ok(fighterInZone(ctx.b, ctx.sim.hazards[0].data.zone, ctx.sim.rules));
  assert.ok(!fighterInZone(ctx.a, ctx.sim.hazards[0].data.zone, ctx.sim.rules));
  run(ctx, PHASE + TEL);
  assert.equal(ctx.b.hp, 90);
  assert.equal(ctx.b.state, STATE.HITSTUN);
  assert.equal(ctx.b.stunLeft, 20);
  assert.equal(ctx.b.pushDirX, -1, 'knocked along the lane away from the zone centre (1.4 < centre 1.5)');
  assert.equal(ctx.b.pushLeft, 0.5);
  const hit = ofType(ctx, HAZARD_EVENT.HIT);
  assert.equal(hit.length, 1);
  assert.deepEqual([hit[0].target, hit[0].defender, hit[0].attacker, hit[0].damage, hit[0].knockback, hit[0].blocked, hit[0].armor],
    [1, 1, -1, 10, 0.5, 0, 0]);
  assert.equal(hit[0].defenderHp, 90);
  run(ctx, ACT + 5);
  assert.equal(ctx.b.hp, 90, 'one strike per activation');
  assert.equal(ctx.a.hp, 100);
  run(ctx, PERIOD - ACT - 5);
  assert.equal(ctx.b.hp, 80, 'the next cycle strikes again');
});

test('hazards_yBandZone_isClearedByAJump_andLaunchLiftsTheVictim', () => {
  const low = { ...VENT, zone: { x0: 1.0, x1: 2.0, y0: 0, y1: 0.3 } };
  const ctx = arena([low]);
  run(ctx, PHASE + TEL - 10);
  ctx.in1.stick.y = 1; // jump 10 ticks before the vent fires
  run(ctx, 10);
  assert.ok(ctx.b.y > 0.3, `airborne at ${ctx.b.y}`);
  assert.equal(ctx.b.hp, 100, 'a jump clears a floor hazard');
  assert.equal(ofType(ctx, HAZARD_EVENT.HIT).length, 0);

  const launcher = { ...VENT, effect: { ...VENT.effect, launch: 3 } };
  const l = arena([launcher]);
  run(l, PHASE + TEL);
  assert.equal(l.b.hp, 90);
  assert.equal(l.b.grounded, false);
  run(l, 1);
  assert.ok(l.b.y > 0, 'launched upward');
});

test('hazards_guardReducesUnlessIgnoresGuard_blockedFlagOnTheEvent', () => {
  const ctx = arena();
  ctx.in1.guard = true;
  run(ctx, PHASE + TEL);
  assert.equal(ctx.b.hp, 97, 'round(10 * guard_scale 0.25)');
  assert.equal(ctx.b.state, STATE.BLOCKSTUN);
  assert.equal(ofType(ctx, HAZARD_EVENT.HIT)[0].blocked, 1);

  const piercing = arena([{ ...VENT, effect: { ...VENT.effect, ignores_guard: true } }]);
  piercing.in1.guard = true;
  run(piercing, PHASE + TEL);
  assert.equal(piercing.b.hp, 90);
  assert.equal(piercing.b.state, STATE.HITSTUN);
  assert.equal(ofType(piercing, HAZARD_EVENT.HIT)[0].blocked, 0);
});

/** Put `f` on frame 0 of an armoured (synthetic) heavy, armour window 1..30 at half damage. */
function poseArmoured(f) {
  f.state = STATE.ATTACK;
  f.moveId = 'heavy';
  f.move = { ...f.moves.heavy, armor: { from: 1, to: 30, hits: 1, damageScale: 0.5, levels: ['mid'] } };
  f.stateFrame = 0;
  f.armorLeft = 1;
  f.attackDirX = -1;
  f.attackDirZ = 0;
}

test('hazards_armourAbsorbsUnlessArmorBreaks', () => {
  const ctx = arena();
  run(ctx, PHASE + TEL - 1);
  poseArmoured(ctx.b);
  run(ctx, 1);
  assert.equal(ctx.b.hp, 95, 'armour damageScale');
  assert.equal(ctx.b.state, STATE.ATTACK, 'the move survives');
  assert.equal(ctx.b.armorLeft, 0);
  assert.equal(ofType(ctx, HAZARD_EVENT.HIT)[0].armor, 1);

  const breaker = arena([{ ...VENT, effect: { ...VENT.effect, armor_breaks: true } }]);
  run(breaker, PHASE + TEL - 1);
  poseArmoured(breaker.b);
  run(breaker, 1);
  assert.equal(breaker.b.hp, 90);
  assert.equal(breaker.b.state, STATE.HITSTUN);
});

test('hazards_koThroughHazard_isAKoWithKoByHazard_andMatchFlowRecordsReasonHazard', () => {
  const ctx = arena();
  ctx.b.hp = 10;
  run(ctx, PHASE + TEL);
  assert.equal(ctx.b.hp, 0);
  assert.equal(ctx.b.state, STATE.KO);
  assert.equal(ctx.sim.koBy, KO_BY.HAZARD);
  assert.equal(ctx.sim.koFrame, PHASE + TEL);
  const types = ctx.log.map((e) => e.type);
  assert.deepEqual(types, [HAZARD_EVENT.TELEGRAPH, HAZARD_EVENT.ACTIVE, HAZARD_EVENT.HIT, EVENT.KO]);
  const ko = ctx.log.at(-1);
  assert.deepEqual([ko.defender, ko.attacker, ko.fx, ko.shake, ko.flash], [1, -1, 'heavy', COMBAT.rules.koShake, COMBAT.rules.koFlash]);
  assert.ok(ctx.sim.hitstop.remaining >= COMBAT.rules.koHitstop - 1, 'KO hitstop applies');
  // i-frames: the KO'd fighter is never struck again, even inside the still-active zone.
  run(ctx, ACT);
  assert.equal(ofType(ctx, HAZARD_EVENT.HIT).length, 1);

  const flow = new MatchFlow({ rules: ctx.sim.rules && rulesetWith([]).round });
  flow.startMatch();
  for (let i = 0; i < Math.round(flow.rules.introSeconds / DT) + 1; i++) flow.update(DT, 1, 1);
  flow.update(DT, 1, 0, ctx.sim.koBy === KO_BY.HAZARD ? ROUND_REASON.HAZARD : ROUND_REASON.KO);
  assert.equal(flow.lastRound.reason, ROUND_REASON.HAZARD);
  assert.equal(flow.lastRound.winner, 0);
  assert.ok(isKoReason(flow.lastRound.reason) && !isKoReason(ROUND_REASON.TIME));
  assert.equal(flow.timeScale, flow.rules.koSlowMoScale, 'a hazard KO gets the KO slow-mo');
});

test('hazards_attackKo_setsKoByAttack_andThrownFightersAreNotStruck', () => {
  const ctx = arena();
  ctx.b.hp = 1;
  ctx.a.x = ctx.a.prevX = 0.2; // light reach: 0.7 forward + 0.25 + 0.35 hurt
  ctx.in0.light = true;
  run(ctx, COMBAT.greyboxMoves.light.startup + 1);
  assert.equal(ctx.b.state, STATE.KO);
  assert.equal(ctx.sim.koBy, KO_BY.ATTACK);

  const t = arena();
  run(t, PHASE + TEL - 1);
  t.b.state = STATE.THROWN;
  t.b.stunLeft = 30;
  run(t, 1);
  assert.equal(t.b.hp, 100, 'thrown = i-frames');
});

test('hazards_toggleOff_noEventsNoDamage_resetRewindsClocks', () => {
  const off = arena([VENT], { hazards: false });
  assert.equal(off.sim.hazardsEnabled, false);
  run(off, PERIOD + PHASE + TEL + 1);
  assert.equal(off.log.length, 0);
  assert.equal(off.b.hp, 100);
  setHazardsEnabled(off.sim, true);
  assert.equal(off.sim.hazardsEnabled, true);
  const from = off.sim.frame;
  run(off, PHASE + TEL);
  assert.deepEqual(ofType(off, HAZARD_EVENT.TELEGRAPH).map((e) => e.frame - from), [PHASE]);
  assert.equal(off.b.hp, 90);

  const none = createDuel(rulesetWith([]));
  assert.equal(none.hazardsEnabled, false, 'no data: off even when asked for');
  const legacy = createDuel({ ...rulesetWith([]), hazards: undefined });
  assert.deepEqual(legacy.hazards, [], 'a ruleset without the section still builds a duel');

  const ctx = arena();
  run(ctx, PHASE + TEL + 3);
  resetDuel(ctx.sim);
  assert.equal(ctx.sim.hazards[0].phase, HAZARD_PHASE.IDLE);
  assert.equal(ctx.sim.koBy, KO_BY.NONE);
  const at = ctx.sim.frame;
  ctx.log.length = 0;
  run(ctx, PHASE + TEL);
  assert.deepEqual(ctx.log.map((e) => [e.type, e.frame - at]), [[HAZARD_EVENT.TELEGRAPH, PHASE], [HAZARD_EVENT.ACTIVE, PHASE + TEL], [HAZARD_EVENT.HIT, PHASE + TEL]]);
});

test('hazards_clocksPauseWithHitstopAndSuperFreeze', () => {
  const ctx = arena();
  run(ctx, 2);
  ctx.sim.hitstop.trigger(10);
  const clock = ctx.sim.hazardClock;
  run(ctx, 10);
  assert.equal(ctx.sim.hazardClock, clock, 'frozen ticks do not advance the hazard clock');
  ctx.sim.freezeLeft = 5;
  run(ctx, 5);
  assert.equal(ctx.sim.hazardClock, clock);
  run(ctx, PHASE + TEL - 2);
  assert.equal(ofType(ctx, HAZARD_EVENT.ACTIVE)[0].frame, PHASE + TEL + 15);
});

test('hazards_randomSchedule_isDeterministicPerSeed_scriptedFiresOnceEach', () => {
  const rnd = { ...VENT, schedule: 'random', cycle: { ...VENT.cycle, jitter_ms: 500 } };
  const frames = (seed) => {
    const ctx = arena([rnd], { seed });
    run(ctx, 60 * 60);
    return ofType(ctx, HAZARD_EVENT.TELEGRAPH).map((e) => e.frame);
  };
  const a = frames(7);
  assert.deepEqual(a, frames(7), 'same seed, same cycles');
  assert.notDeepEqual(a, frames(8), 'another seed, other gaps');
  assert.ok(a.length >= 15);
  for (let i = 1; i < a.length; i++) {
    const gap = a[i] - a[i - 1];
    assert.ok(gap >= PERIOD - msToFrames(500) && gap <= PERIOD + msToFrames(500), `gap ${gap} within jitter`);
  }

  const scripted = { ...VENT, schedule: 'scripted', cycle: { telegraph_ms: 600, active_ms: 200 }, times_ms: [1000, 3000] };
  const s = arena([scripted]);
  run(s, 60 * 60);
  assert.deepEqual(ofType(s, HAZARD_EVENT.TELEGRAPH).map((e) => e.frame), [60, 180]);
  assert.equal(s.sim.hazards[0].phase, HAZARD_PHASE.DORMANT);
});

test('hazards_twoZones_oneTickEmitsBoth_withinThePool', () => {
  const left = { ...VENT, id: 'left', zone: { x0: -2.0, x1: -1.0 } };
  const ctx = arena([left, VENT]);
  run(ctx, PHASE + TEL);
  assert.equal(ctx.a.hp, 90);
  assert.equal(ctx.b.hp, 90);
  const hits = ofType(ctx, HAZARD_EVENT.HIT);
  assert.deepEqual(hits.map((e) => [e.id, e.target]), [['left', 0], ['vent', 1]]);
  assert.ok(ctx.sim.events.length >= 12, 'pool fits two telegraphs + two activations + two hits + a KO pair');
});
