// The pilot and the fight-system proposals (design/quick-specs/fight-systems-gap-2026-11-05.md section 4):
// linkChance, stepPunishChance, throwTechChance, ventChance. Pure sim on the greybox kit; the fairness
// rule the whole file leans on is that the pilot fills an input snapshot and reads public state only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import COMBAT from '../fixtures/combat_tuning.json' with { type: 'json' };
import { createSnapshot } from '../fixtures/bound/input-snapshot.js';
import { AI_DIFFICULTY } from '../fixtures/bound/ai-data.js';
import { createRuleset, createDuel, stepDuel, startAttack, setState, sidestepCancellable, STATE, EVENT, CUE, buildMoves, COUNTER_TIER } from '../../src/sim/index.js';
import { CpuPilot, REASON, buildDifficulty, buildBehaviour, actionOf } from '../../src/ai/index.js';

const DT = 1 / 60;
const RULESET = createRuleset({
  rules: COMBAT.rules, movement: COMBAT.movement, moves: COMBAT.greyboxMoves, round: COMBAT.round, meter: COMBAT.meter,
});
const G = COMBAT.greyboxMoves;
const KIT = buildMoves({ ...G, light: { ...G.light, cancel: { into: 'light2', from: 10, to: 16, requiresContact: true } }, light2: { ...G.light, name: 'Second' } });
const SPEC = Object.freeze({ id: 'kit', hurtbox: { bodyRadius: 0.3, limbRadius: 0.1 } });
const B = AI_DIFFICULTY.behaviour;
const PASSIVE = buildBehaviour({ ...B, guardWeight: 0, backOffWeight: 0, sidestepWeight: 0, jumpWeight: 0, waitWeight: 1 });
/** Zero-delay pilot with every chance off, so only what a test switches on acts. */
const quiet = (over) => buildDifficulty({
  ...AI_DIFFICULTY.levels.hard, reactionFrames: 0, mistakeRate: 0, sidestepChance: 0, specialShare: 0, aggression: 0,
  blockChance: 0, whiffPunishChance: 0, throwChance: 0, stringConfirmChance: 0, pressureChance: 0, disadvantageRespect: 0,
  antiAirChance: 0, counterChance: 0, retreatChance: 0, jumpChance: 0, superPunishChance: 0, superBlockPunishChance: 0, superComebackHp: 0,
  ...over,
});

/** CPU drives `b`, `a` is scripted; `d` apart. */
function duel(d, difficulty, opts = {}) {
  const sim = createDuel(RULESET);
  const [a, b] = sim.fighters;
  for (const f of [a, b]) {
    f.moves = KIT;
    f.spec = SPEC;
  }
  a.x = a.prevX = -d / 2;
  b.x = b.prevX = d / 2;
  const cpu = new CpuPilot({ behaviour: PASSIVE, rules: RULESET.rules, seed: 1, difficulty, ...opts });
  return { sim, a, b, cpu, in0: createSnapshot(), in1: createSnapshot() };
}

/** One tick: the pilot samples b, then the sim steps. Returns the CPU's snapshot. */
function step(c) {
  c.cpu.sample(c.in1, c.b, c.a);
  stepDuel(c.sim, c.in0, c.in1, DT);
  c.in0.light = c.in0.heavy = c.in0.throw = false;
  c.in0.sidestep = 0;
  return c.in1;
}

const events = (c, type) => c.sim.events.slice(0, c.sim.eventCount).filter((e) => e.type === type);

// P1 ----------------------------------------------------------------------------------------------

/** Close enough that a Light still reaches after the Light's own pushback. */
const CLOSE = 0.92;

/** b lands a Light on a in its heavy's startup: a counter, with b's frames known. */
function counterHit(difficulty, d = CLOSE, opts = {}) {
  const c = duel(d, difficulty, opts);
  startAttack(c.a, c.b, 'heavy');
  c.a.stateFrame = 1;
  c.a.attackHasHit = true;
  startAttack(c.b, c.a, 'light');
  c.b.stateFrame = KIT.light.startup;
  step(c);
  const [hit] = events(c, EVENT.HIT);
  assert.equal(hit.counter, COUNTER_TIER.COUNTER);
  return c;
}

test('difficulty_linkChance_optionalDefaultZero', () => {
  assert.equal(buildDifficulty(AI_DIFFICULTY.levels.normal).linkChance, 0);
  assert.throws(() => buildDifficulty({ ...AI_DIFFICULTY.levels.normal, linkChance: 1.5 }), /linkChance/);
});

test('link_afterACounterHit_landsWhileTheDefenderIsStillStunned', () => {
  // greybox Light: +3 on hit, +8 on a counter; Light startup 7 fits (startup + 1 <= 8), true link.
  const c = counterHit(quiet({ linkChance: 1 }));
  const seen = [];
  let second = null;
  for (let i = 0; i < 60 && second === null; i++) {
    const wasStunned = c.a.state === STATE.HITSTUN;
    step(c);
    seen.push(c.cpu.reason);
    const [hit] = events(c, EVENT.HIT);
    if (hit) second = { hit: { ...hit }, wasStunned };
  }
  assert.ok(seen.includes(REASON.LINK), 'the pilot pressed the link');
  assert.ok(second, 'the link connected');
  assert.ok(second.wasStunned, 'the defender never got out: a true link');
  assert.equal(second.hit.moveId, 'light');
  assert.equal(second.hit.counter, COUNTER_TIER.NONE, 'links do not compound');
});

test('link_chanceZero_noLink', () => {
  const c = counterHit(quiet({ linkChance: 0 }));
  for (let i = 0; i < 40; i++) {
    step(c);
    assert.notEqual(c.cpu.reason, REASON.LINK);
    assert.equal(events(c, EVENT.HIT).length, 0);
  }
});

test('link_plainHit_noRollAndNoPress', () => {
  // A plain hit is +3: nothing fits, and no link is even rolled.
  const c = duel(1.0, quiet({ linkChance: 1 }));
  startAttack(c.b, c.a, 'light');
  c.b.stateFrame = KIT.light.startup;
  step(c);
  assert.equal(events(c, EVENT.HIT)[0].counter, COUNTER_TIER.NONE);
  for (let i = 0; i < 40; i++) {
    step(c);
    assert.notEqual(c.cpu.reason, REASON.LINK);
  }
});

test('link_outOfReach_afterThePushback_doesNotPress', () => {
  // The contact is at the tip: the hit's pushback carries the defender past any Light.
  const tip = KIT.light.hitbox.forward + KIT.light.hitbox.radius + SPEC.hurtbox.bodyRadius - 0.01;
  const c = counterHit(quiet({ linkChance: 1 }), tip);
  for (let i = 0; i < 40; i++) {
    step(c);
    assert.notEqual(c.cpu.reason, REASON.LINK);
  }
});

test('link_neverPicksAThrow_evenWhenItWouldFit', () => {
  // A very fast throw fits the stun; it would whiff on hitstun, so the pilot must not pick it.
  const fast = buildMoves({ ...KIT, throw: { ...G.throw, startup: 1 } });
  const c = duel(0.95, quiet({ linkChance: 1 }));
  c.b.moves = fast;
  startAttack(c.a, c.b, 'heavy');
  c.a.stateFrame = 1;
  c.a.attackHasHit = true;
  startAttack(c.b, c.a, 'light');
  c.b.stateFrame = KIT.light.startup;
  step(c);
  for (let i = 0; i < 40; i++) {
    const snap = step(c);
    assert.equal(snap.throw, false, 'never a throw link');
  }
});

test('link_readsNoHiddenStun_onlyPublicFrameData', () => {
  // Inflating the defender's hidden counter would make the slow Heavy "fit" for a pilot that read it. The
  // honest pilot computes the stun from public frame data, so it still presses the Light.
  const c = counterHit(quiet({ linkChance: 1 }));
  c.a.stunLeft = 200;
  let light = false;
  let heavy = false;
  for (let i = 0; i < 40; i++) {
    const snap = step(c);
    light ||= snap.light;
    heavy ||= snap.heavy;
  }
  assert.equal(light, true, 'the Light the public numbers allow');
  assert.equal(heavy, false, 'not the Heavy the hidden counter would allow');
  assert.equal('stunLeft' in c.cpu.view.perceived, false, 'the observation still hides it');
});

test('actionMix_linkCountsAsAString', () => {
  assert.equal(actionOf(REASON.LINK, 'light'), 'string');
});

// P4 ----------------------------------------------------------------------------------------------

/** a whiffs a Heavy and sits in recovery near b, which is `ticks` into a sidestep. */
function steppedPast(difficulty, ticks, behaviour = PASSIVE) {
  const c = duel(1.1, difficulty, { behaviour });
  startAttack(c.a, c.b, 'heavy');
  c.a.stateFrame = KIT.heavy.startup + KIT.heavy.active + 1; // first recovery frame: it whiffed
  c.b.sidestepT = c.b.movement.sidestepDuration - ticks / 60;
  c.b.sidestepDir = 1;
  setState(c.b, STATE.SIDESTEP);
  return c;
}
const CUT_TICKS = 8; // 0.13 s (the fixture's default) rounds up to 8 ticks

test('difficulty_stepPunishChance_optionalDefaultZero', () => {
  assert.equal(buildDifficulty(AI_DIFFICULTY.levels.normal).stepPunishChance, 0);
  assert.throws(() => buildDifficulty({ ...AI_DIFFICULTY.levels.normal, stepPunishChance: 2 }), /stepPunishChance/);
});

test('stepPunish_pastTheCut_attacksOutOfTheStep_andThePunishTierApplies', () => {
  const c = steppedPast(quiet({ stepPunishChance: 1 }), CUT_TICKS);
  assert.equal(sidestepCancellable(c.b), true);
  const snap = step(c);
  assert.equal(snap.heavy || snap.light, true, 'pressed out of the step');
  assert.equal(c.b.state, STATE.ATTACK);
  let hit = null;
  for (let i = 0; i < 20 && hit === null; i++) {
    step(c);
    hit = events(c, EVENT.HIT)[0] ?? null;
  }
  assert.ok(hit, 'the stepped punish connected');
  assert.equal(hit.counter, COUNTER_TIER.PUNISH);
});

test('stepPunish_anAttackThatConnected_isNotAStepWhiff', () => {
  const c = steppedPast(quiet({ stepPunishChance: 1 }), CUT_TICKS);
  c.a.attackHasHit = true;
  const snap = step(c);
  assert.equal(snap.light || snap.heavy || snap.throw, false);
});

test('stepPunish_beforeTheCut_doesNotPress', () => {
  const c = steppedPast(quiet({ stepPunishChance: 1 }), CUT_TICKS - 3);
  const snap = step(c);
  assert.equal(snap.light || snap.heavy || snap.throw, false);
  assert.equal(c.b.state, STATE.SIDESTEP);
});

test('stepPunish_chanceZero_theStepRunsOut', () => {
  const c = steppedPast(quiet({ stepPunishChance: 0, whiffPunishChance: 1 }), CUT_TICKS);
  const snap = step(c);
  assert.equal(snap.light || snap.heavy || snap.throw, false, 'whiffPunishChance does not act out of a step');
  assert.equal(c.b.state, STATE.SIDESTEP);
});

test('stepPunish_rolledOncePerAttack', () => {
  // A failed roll is not re-rolled on the next tick of the same recovery.
  let rolls = 0;
  const c = steppedPast(quiet({ stepPunishChance: 0 }), CUT_TICKS);
  const chance = c.cpu.rng.chance.bind(c.cpu.rng);
  c.cpu.rng.chance = (p) => { if (p === 0) rolls++; return chance(p); };
  step(c);
  const after = rolls;
  step(c);
  step(c);
  assert.equal(rolls, after, 'no further roll for this attack');
});

test('neutral_insideASidestep_neverPressesAttack', () => {
  // An aggressive neutral plan used to press through a step; past the cut that press would cancel it.
  const OFFENSIVE = buildBehaviour({ ...B, waitWeight: 0, guardWeight: 0, backOffWeight: 0, sidestepWeight: 0, jumpWeight: 0, rangeBias: 0, rangeBand: 0, tipPatience: 1 });
  const c = duel(1.0, quiet({ aggression: 1 }), { behaviour: OFFENSIVE });
  c.b.sidestepT = c.b.movement.sidestepDuration - CUT_TICKS / 60;
  c.b.sidestepDir = 1;
  setState(c.b, STATE.SIDESTEP);
  for (let i = 0; c.b.state === STATE.SIDESTEP && i < 20; i++) {
    const snap = step(c);
    assert.equal(snap.light || snap.heavy || snap.throw, false, `tick ${i}`);
  }
});

test('step_onlyTheStepPunishLeavesIt_noBlockNoArmourCounterNoAntiAir', () => {
  // Spec section 4 gives the CPU one way out of a chosen step. A human may still cancel into guard (sim test).
  const armoured = buildMoves({ ...KIT, heavy: { ...KIT.heavy, armor: { from: 1, to: KIT.heavy.startup, hits: 1, damageScale: 1, levels: ['high', 'mid'] } } });
  const c = duel(1.0, quiet({ blockChance: 1, counterChance: 1, antiAirChance: 1, stepPunishChance: 0 }));
  c.b.moves = armoured;
  c.b.sidestepT = c.b.movement.sidestepDuration - CUT_TICKS / 60;
  c.b.sidestepDir = 1;
  setState(c.b, STATE.SIDESTEP);
  startAttack(c.a, c.b, 'light');
  c.a.stateFrame = 1;
  for (let i = 0; i < 3; i++) {
    const snap = step(c);
    assert.equal(snap.guard || snap.light || snap.heavy || snap.throw, false, `tick ${i}`);
    if (c.b.state !== STATE.SIDESTEP) break;
  }
});

// P2 ----------------------------------------------------------------------------------------------

/** a throws the CPU b. Returns once the throw has connected (hitstop about to run). */
function grabbedCpu(difficulty, moves = KIT, seed = 1) {
  const c = duel(0.95, difficulty, { seed });
  c.a.moves = moves;
  c.in0.throw = true;
  for (let i = 0; i < moves.throw.startup + 1; i++) step(c);
  assert.equal(c.b.state, STATE.THROWN);
  return c;
}

test('difficulty_throwTechChance_optionalDefaultZero', () => {
  assert.equal(buildDifficulty(AI_DIFFICULTY.levels.normal).throwTechChance, 0);
  assert.throws(() => buildDifficulty({ ...AI_DIFFICULTY.levels.normal, throwTechChance: 1.1 }), /throwTechChance/);
});

test('tech_pressesOnce_afterTheReactionDelay_andBreaksTheThrow', () => {
  const REACT = 9; // inside hitstop 8 + window 10
  const c = grabbedCpu(quiet({ throwTechChance: 1, reactionFrames: REACT }));
  const presses = [];
  for (let i = 0; i < 30; i++) {
    const snap = step(c);
    if (snap.throw) presses.push(i + 1);
  }
  assert.deepEqual(presses, [REACT + 1], 'one press, reactionFrames after the grab');
  assert.equal(c.b.hp, c.b.maxHp, 'the throw was broken');
});

test('tech_chanceZero_neverPresses', () => {
  const c = grabbedCpu(quiet({ throwTechChance: 0 }));
  for (let i = 0; i < 30; i++) assert.equal(step(c).throw, false);
});

test('tech_isRolledOncePerGrab', () => {
  const c = grabbedCpu(quiet({ throwTechChance: 0.5, reactionFrames: 2 }));
  let rolls = 0;
  const chance = c.cpu.rng.chance.bind(c.cpu.rng);
  c.cpu.rng.chance = (p) => { if (p === 0.5) rolls++; return chance(p); };
  for (let i = 0; i < 30; i++) step(c);
  assert.equal(rolls, 1);
});

test('tech_untechableGrab_noRollNoPress', () => {
  const grab = buildMoves({ ...KIT, throw: { ...G.throw, techable: false } });
  const c = grabbedCpu(quiet({ throwTechChance: 1 }), grab);
  for (let i = 0; i < 30; i++) assert.equal(step(c).throw, false);
});

test('tech_neverReadsAnyBuffer_inTheControllerSource', () => {
  const src = readFileSync(new URL('../../src/ai/cpu-controller.js', import.meta.url), 'utf8');
  for (const hidden of ['bufAction', 'bufFrames', 'guardHeld', 'stunLeft']) assert.equal(src.includes(hidden), false, hidden);
});

test('afterATech_aCommandGrabIsPreferred_foundByData', () => {
  // Fixture kit with an untechable travelling grab as specialForward.
  const grabKit = buildMoves({ ...KIT, specialForward: { ...G.throw, name: 'Clamp', startup: 16, recovery: 22, techable: false, aiRole: 'gapClose' } });
  const THROWING = quiet({ throwChance: 1, aggression: 0 });
  const plan = (seen) => {
    const c = duel(0.95, THROWING);
    c.b.moves = grabKit;
    setState(c.a, STATE.GUARD);
    c.in0.guard = true;
    if (seen) c.cpu.techsSeen = 1;
    c.cpu.sample(c.in1, c.b, c.a);
    return c.cpu.plan;
  };
  assert.equal(plan(false), 'throw');
  assert.equal(plan(true), 'special');
});

test('afterATech_cpuCountsItsOwnBrokenThrow_oncePerTech', () => {
  const c = duel(0.95, quiet({ throwChance: 1 }));
  // The CPU is the thrower here: a is the defender and techs on the first free tick.
  startAttack(c.b, c.a, 'throw');
  c.b.stateFrame = KIT.throw.startup;
  step(c);
  assert.equal(c.a.state, STATE.THROWN);
  for (let i = 0; i < KIT.throw.hitstop; i++) step(c);
  c.in0.throw = true;
  step(c);
  assert.equal(c.b.state, STATE.TECH);
  step(c);
  step(c);
  assert.equal(c.cpu.techsSeen, 1);
});

// P3 ----------------------------------------------------------------------------------------------

/** The CPU b blocks a's `moveId` (kit data lets a test choose the frames); returns at the block tick. */
function blockedCpu(difficulty, moveId, { meter = RULESET.meter.ventCost, kit = KIT, d = 1.1, seed = 1 } = {}) {
  const c = duel(d, difficulty, { seed });
  c.a.moves = kit;
  c.b.meter = meter;
  startAttack(c.a, c.b, moveId);
  c.a.stateFrame = kit[moveId].startup;
  c.in1.guard = true;
  setState(c.b, STATE.GUARD);
  c.b.guardHeld = true;
  c.cpu.sample(c.in1, c.b, c.a); // the view sees the attack
  c.in1.guard = true;
  stepDuel(c.sim, c.in0, c.in1, DT);
  assert.equal(c.b.state, STATE.BLOCKSTUN);
  return c;
}
/** A move nothing in KIT punishes: plus on block. */
const PRESSURE = buildMoves({ ...KIT, light: { ...KIT.light, cancel: undefined, blockstun: 16 } });
const vents = (c) => c.sim.cues.slice(0, c.sim.cueCount).filter((x) => x.type === CUE.VENT).length;

/** Run up to `n` ticks, returning how many vents fired. */
function runVents(c, n = 30) {
  let total = 0;
  for (let i = 0; i < n && c.b.state !== STATE.IDLE; i++) {
    step(c);
    total += vents(c);
  }
  return total;
}

test('difficulty_ventChance_optionalDefaultZero', () => {
  assert.equal(buildDifficulty(AI_DIFFICULTY.levels.normal).ventChance, 0);
  assert.throws(() => buildDifficulty({ ...AI_DIFFICULTY.levels.normal, ventChance: 1.5 }), /ventChance/);
});

test('vent_pressureItCannotPunish_ventsWhenTheRollSays', () => {
  const c = blockedCpu(quiet({ ventChance: 1 }), 'light', { kit: PRESSURE });
  assert.equal(runVents(c), 1);
  assert.equal(c.b.meter < RULESET.meter.ventCost, true, 'the cost left');
});

test('vent_chanceZero_neverVents', () => {
  const c = blockedCpu(quiet({ ventChance: 0 }), 'light', { kit: PRESSURE });
  assert.equal(runVents(c), 0);
});

test('vent_belowTheCost_neverPresses', () => {
  const c = blockedCpu(quiet({ ventChance: 1 }), 'light', { kit: PRESSURE });
  c.b.meter = RULESET.meter.ventCost - 1; // after the block: its contact gain could have paid for it
  for (let i = 0; i < 6; i++) assert.equal(step(c).throw, false, `tick ${i}`);
});

test('vent_aMoveItCouldPunish_isPunishedInstead', () => {
  // Greybox heavy on block leaves a window a Light fits: the CPU keeps its meter for the punish.
  const c = blockedCpu(quiet({ ventChance: 1 }), 'heavy');
  assert.equal(runVents(c), 0);
});

test('vent_withinACostOfFull_savesItForOverwind_whenItWantsTheSuper', () => {
  const full = RULESET.meter.max - 1;
  const wants = blockedCpu(quiet({ ventChance: 1, superPunishChance: 1 }), 'light', { kit: PRESSURE, meter: full });
  assert.equal(runVents(wants), 0, 'saved');
  const free = blockedCpu(quiet({ ventChance: 1, superPunishChance: 0 }), 'light', { kit: PRESSURE, meter: full });
  assert.equal(runVents(free), 1, 'no super wanted: it vents');
});

test('vent_rolledOncePerAttack', () => {
  const c = blockedCpu(quiet({ ventChance: 0.5 }), 'light', { kit: PRESSURE });
  let rolls = 0;
  const chance = c.cpu.rng.chance.bind(c.cpu.rng);
  c.cpu.rng.chance = (p) => { if (p === 0.5) rolls++; return chance(p); };
  for (let i = 0; i < 12; i++) step(c);
  assert.equal(rolls <= 1, true, `rolled ${rolls} times`);
});

test('vent_keepsTheGuardHeld_soACrouchBlockStaysCrouched', () => {
  const c = blockedCpu(quiet({ ventChance: 1 }), 'light', { kit: PRESSURE });
  c.b.crouching = true;
  const snap = step(c);
  assert.equal(snap.throw, true);
  assert.equal(snap.guard, true);
  assert.equal(snap.stick.y, -1);
});
