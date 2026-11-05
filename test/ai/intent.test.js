// AI-DEPTH: the pilot's intent per situation on synthetic states (greybox kit extended with a string,
// an anti-air, an armoured special and a slow command grab), the matchup table lookup, the new data
// keys and seed determinism. Pure sim; no game data beyond the engine fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import COMBAT from '../fixtures/combat_tuning.json' with { type: 'json' };
import { createSnapshot } from '../fixtures/bound/input-snapshot.js';
import { AI_DIFFICULTY } from '../fixtures/bound/ai-data.js';
import { createRuleset, createDuel, stepDuel, STATE, buildMoves } from '../../src/sim/index.js';
import {
  CpuPilot, PLAN, REASON, buildDifficulty, buildBehaviour, buildDifficultySet, buildPersonality, buildMatchups,
  applyPersonality, frameAdvantage, spendable, moveReach, OPTIONAL_DIFFICULTY_KEYS, DIFFICULTY_KEYS, LOCKED_KEYS,
  ActionMix, actionOf,
} from '../../src/ai/index.js';

const DT = 1 / 60;
const RULESET = createRuleset({
  rules: COMBAT.rules, movement: COMBAT.movement, moves: COMBAT.greyboxMoves, round: COMBAT.round, meter: COMBAT.meter,
});
const G = COMBAT.greyboxMoves;
/**
 * Test kit: the greybox moves plus a two-hit Light string (hit confirm), an anti-air crouch heavy, an
 * armoured forward special (gapClose) and a slow travelling command grab as the back special.
 */
const KIT = buildMoves({
  ...G,
  light: { ...G.light, cancel: { into: 'light2', from: 10, to: 16, requiresContact: true } },
  light2: { ...G.light, name: 'Second' },
  crouchHeavy: { ...G.crouchHeavy, damage: 14, aiRole: 'antiAir' }, // the launcher out-damages the heavy (13)
  specialForward: {
    ...G.heavy, name: 'Charge', startup: 18, aiRole: 'gapClose',
    travel: { from: 4, to: 18, distance: 0.9 }, armor: { from: 4, to: 18, hits: 1, damageScale: 1, levels: ['high', 'mid'] },
  },
  specialBack: {
    ...G.throw, name: 'Clamp', startup: 16, active: 3, recovery: 22, aiRole: 'retreatPoke',
    travel: { from: 5, to: 14, distance: 0.55 },
  },
});
const SPEC_A = Object.freeze({ id: 'kit_a', hurtbox: { bodyRadius: 0.3, limbRadius: 0.1 } });
const SPEC_B = Object.freeze({ id: 'kit_b', hurtbox: { bodyRadius: 0.3, limbRadius: 0.1 } });
const B = AI_DIFFICULTY.behaviour;
/** A CPU that only pokes / approaches in neutral, preferring close range and poking the tip regardless of step-ins. */
const OFFENSIVE = buildBehaviour({
  ...B, waitWeight: 0, guardWeight: 0, backOffWeight: 0, sidestepWeight: 0, jumpWeight: 0, rangeBias: 0, rangeBand: 0, tipPatience: 1,
});
/** A CPU that only waits in neutral (with `passive`, aggression 0: reactions are the only thing that can move it). */
const PASSIVE = buildBehaviour({ ...B, guardWeight: 0, backOffWeight: 0, sidestepWeight: 0, jumpWeight: 0 });
/** Hard reactions with zero reaction delay and no mistakes: the rules alone decide. */
const sharp = (over) => buildDifficulty({
  ...AI_DIFFICULTY.levels.hard, reactionFrames: 0, mistakeRate: 0, sidestepChance: 0, specialShare: 0, aggression: 1, ...over,
});
/** `sharp` without any neutral offence. */
const passive = (over) => sharp({ aggression: 0, ...over });

/** Duel `d` apart, both fighters on the test kit; the CPU drives `b`. */
function duel(d, opts = {}) {
  const sim = createDuel(RULESET);
  const [a, b] = sim.fighters;
  for (const f of [a, b]) f.moves = KIT;
  a.spec = SPEC_A;
  b.spec = SPEC_B;
  a.x = a.prevX = -d / 2;
  b.x = b.prevX = d / 2;
  const cpu = new CpuPilot({ behaviour: PASSIVE, rules: RULESET.rules, seed: 1, ...opts, difficulty: opts.difficulty ?? sharp() });
  return { sim, a, b, cpu, in0: createSnapshot(), in1: createSnapshot() };
}

function poseAttack(f, moveId, n, hasHit = false) {
  f.state = STATE.ATTACK;
  f.moveId = moveId;
  f.move = f.moves[moveId];
  f.stateFrame = n;
  f.attackHasHit = hasHit;
}

const reachOf = (key, bodyR = 0.3) => moveReach(KIT[key], bodyR) - B.reachMargin;

// Data keys ---------------------------------------------------------------------------------------

test('difficulty_aiDepthKeys_optionalWithDerivedDefaults_andUnitRange', () => {
  const { stringConfirmChance, pressureChance, disadvantageRespect, antiAirChance, counterChance, retreatChance, jumpChance, matchupSkill, ...bare } = AI_DIFFICULTY.levels.normal;
  const d = buildDifficulty(bare);
  assert.deepEqual(Object.keys(d), [...DIFFICULTY_KEYS], 'key order is the schema order');
  assert.equal(d.stringConfirmChance, 1 - bare.mistakeRate);
  assert.equal(d.pressureChance, bare.aggression);
  assert.deepEqual([d.disadvantageRespect, d.antiAirChance], [bare.blockChance, bare.blockChance]);
  assert.deepEqual([d.counterChance, d.retreatChance, d.jumpChance, d.matchupSkill], [0, 0, 0, 1]);
  for (const k of OPTIONAL_DIFFICULTY_KEYS) assert.throws(() => buildDifficulty({ ...bare, [k]: 1.5 }), new RegExp(k));
  assert.ok(LOCKED_KEYS.includes('matchupSkill'), 'a personality may not change how much of the matchup a level knows');
});

test('behaviour_rangeBiasTipPatienceJumpWeight_optionalAndBounded', () => {
  const { rangeBias, rangeBand, jumpWeight, tipPatience, ...bare } = B;
  const b = buildBehaviour(bare);
  assert.deepEqual([b.rangeBias, b.rangeBand, b.jumpWeight, b.tipPatience], [1, 0.15, 0, 1]);
  assert.throws(() => buildBehaviour({ ...B, rangeBias: 1.2 }), /rangeBias/);
  assert.throws(() => buildBehaviour({ ...B, tipPatience: -0.1 }), /tipPatience/);
  // A personality scaling rangeBias past 1 is clamped (it is a unit key).
  const p = buildPersonality('tip', { summary: 'x', scale: { range_bias: 9 } });
  assert.equal(applyPersonality(p, AI_DIFFICULTY.levels.normal, B).behaviour.rangeBias, 1);
});

test('frameAdvantage_fromPublicFrameData', () => {
  // greybox light: hitstun 14, blockstun 9, active 2, recovery 10 -> +3 on hit, -2 on block
  assert.deepEqual([frameAdvantage(G.light, false), frameAdvantage(G.light, true)], [3, -2]);
});

test('spendable_savesTheLastCostOfMeterForOverwind', () => {
  const f = { meter: 50, meterMax: 100 };
  const costed = { meterCost: 20 };
  assert.equal(spendable(f, costed), true);
  f.meter = 80;
  assert.equal(spendable(f, costed), false, 'within one cost of full: saved');
  f.meter = 10;
  assert.equal(spendable(f, costed), false, 'cannot afford');
  assert.equal(spendable(f, {}), true, 'no cost: always');
});

// Intent per situation ----------------------------------------------------------------------------

test('poke_inLightRange_jabsNotHeavy_andBeyondItTipPokesOrWalksIn', () => {
  const lightR = reachOf('light');
  const heavyR = reachOf('heavy');
  const closeKeys = new Set();
  const farReasons = new Set();
  const farKeys = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const c = duel(lightR - 0.05, { behaviour: OFFENSIVE, seed, difficulty: sharp() });
    c.cpu.sample(c.in1, c.b, c.a);
    assert.equal(c.cpu.reason, PLAN.POKE, `close seed ${seed}`);
    closeKeys.add(c.cpu.pokeKey);
    const f = duel((lightR + heavyR) / 2, { behaviour: OFFENSIVE, seed, difficulty: sharp() });
    f.cpu.sample(f.in1, f.b, f.a);
    farReasons.add(f.cpu.reason);
    if (f.cpu.reason === PLAN.POKE) farKeys.add(f.cpu.pokeKey);
  }
  assert.ok(closeKeys.has('light'), 'the jab is the close-range poke');
  assert.ok([...closeKeys].every((k) => k !== 'heavy') || closeKeys.has('light'));
  assert.deepEqual([...farKeys], ['heavy'], 'only the heavy reaches from the tip');
  assert.ok(farReasons.has(PLAN.APPROACH) && farReasons.has(PLAN.POKE), `tip: walk in or tip poke (${[...farReasons]})`);
});

test('poke_vsStandingGuard_goesLow_vsCrouchingOpponent_goesMid', () => {
  const lightR = reachOf('light');
  const low = new Set();
  const mid = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const g = duel(lightR - 0.05, { behaviour: OFFENSIVE, seed, difficulty: sharp({ throwChance: 0 }) });
    g.a.state = STATE.GUARD;
    g.cpu.sample(g.in1, g.b, g.a);
    if (g.cpu.reason === PLAN.POKE) low.add(g.cpu.pokeKey);
    const c = duel(lightR - 0.05, { behaviour: OFFENSIVE, seed, difficulty: sharp() });
    c.a.crouching = true;
    c.cpu.sample(c.in1, c.b, c.a);
    if (c.cpu.reason === PLAN.POKE) mid.add(c.cpu.pokeKey);
  }
  assert.deepEqual([...low], ['crouchLight'], 'a low opens a standing guard');
  assert.deepEqual([...mid], ['heavy'], 'a mid hits a crouching opponent (highs miss, lows are crouch-blocked)');
});

test('string_openerConnected_pressesLightInsideTheCancelWindow_onceRolled', () => {
  const c = duel(1.0, { difficulty: passive({ stringConfirmChance: 1 }) });
  const m = KIT.light;
  // Opener at frame 5 (startup): not yet; connected at frame 10 (window 10..16 -> n = 11): press.
  poseAttack(c.b, 'light', 5, false);
  c.cpu.sample(c.in1, c.b, c.a);
  assert.equal(c.in1.light, false, 'before the window');
  poseAttack(c.b, 'light', 10, true);
  c.cpu.sample(c.in1, c.b, c.a);
  assert.deepEqual([c.cpu.reason, c.cpu.reasonKey, c.in1.light], [REASON.STRING, 'light2', true]);
  // Not connected (whiff): the string is not pressed.
  const w = duel(1.0, { difficulty: passive({ stringConfirmChance: 1 }) });
  poseAttack(w.b, 'light', 10, false);
  w.cpu.sample(w.in1, w.b, w.a);
  assert.notEqual(w.cpu.reason, REASON.STRING);
  // stringConfirmChance 0: never, even on contact.
  const z = duel(1.0, { difficulty: passive({ stringConfirmChance: 0 }) });
  poseAttack(z.b, 'light', 10, true);
  z.cpu.sample(z.in1, z.b, z.a);
  assert.notEqual(z.cpu.reason, REASON.STRING);
  assert.ok(m.cancel.from <= 11 && 11 <= m.cancel.to, 'fixture');
});

test('respect_ownHeavyBlockedAtMinusFrames_holdsGuardInsteadOfPressing', () => {
  // Own heavy (-9 on block: blockstun 12 - 2 - 20) just ended, the delayed view shows the opponent in blockstun.
  const c = duel(1.0, { behaviour: OFFENSIVE, difficulty: sharp({ disadvantageRespect: 1, retreatChance: 0 }) });
  poseAttack(c.b, 'heavy', KIT.heavy.startup + 1, true);
  c.a.state = STATE.BLOCKSTUN;
  c.cpu.sample(c.in1, c.b, c.a); // attacking, connected
  c.b.state = STATE.IDLE;
  c.b.move = null;
  c.b.moveId = null;
  const adv = frameAdvantage(KIT.heavy, true);
  assert.ok(adv < 0, 'fixture: the heavy is minus on block');
  let guarded = 0;
  for (let i = 0; i < -adv; i++) {
    c.cpu.sample(c.in1, c.b, c.a);
    assert.equal(c.cpu.reason, REASON.RESPECT, `tick ${i}`);
    assert.equal(c.in1.guard, true);
    assert.equal(c.in1.light || c.in1.heavy || c.in1.throw, false, 'no mashing');
    guarded++;
  }
  assert.equal(guarded, -adv);
  // disadvantageRespect 0: an offensive CPU presses right away.
  const z = duel(1.0, { behaviour: OFFENSIVE, difficulty: sharp({ disadvantageRespect: 0 }) });
  poseAttack(z.b, 'heavy', KIT.heavy.startup + 1, true);
  z.a.state = STATE.BLOCKSTUN;
  z.cpu.sample(z.in1, z.b, z.a);
  z.b.state = STATE.IDLE;
  z.b.move = null;
  z.cpu.sample(z.in1, z.b, z.a);
  assert.notEqual(z.cpu.reason, REASON.RESPECT);
});

test('pressure_ownLightLanded_plusFrames_throwsABlockerOrJabs', () => {
  const c = duel(0.95, { difficulty: passive({ pressureChance: 1, disadvantageRespect: 1 }) });
  poseAttack(c.b, 'light', KIT.light.startup + 1, true);
  c.a.state = STATE.HITSTUN;
  c.cpu.sample(c.in1, c.b, c.a);
  c.b.state = STATE.IDLE;
  c.b.move = null;
  c.cpu.sample(c.in1, c.b, c.a);
  assert.equal(c.cpu.reason, PLAN.POKE, 'a passive CPU still presses the advantage');
  assert.ok(['light', 'crouchLight'].includes(c.cpu.pokeKey), 'a jab or a low');
  assert.ok(c.in1.light || c.in1.stick.y === -1, 'the jab (or the crouch tick of the low)');
  // Blocked at plus frames (fixture: a move with blockstun above its recovery) in throw range: tick throw.
  const plus = buildMoves({ ...KIT, light: { ...KIT.light, blockstun: 20 } });
  const t = duel(0.95, { difficulty: passive({ pressureChance: 1 }) });
  t.b.moves = plus;
  poseAttack(t.b, 'light', plus.light.startup + 1, true);
  t.a.state = STATE.BLOCKSTUN;
  t.cpu.sample(t.in1, t.b, t.a);
  t.b.state = STATE.IDLE;
  t.b.move = null;
  t.cpu.sample(t.in1, t.b, t.a);
  assert.deepEqual([t.cpu.reason, t.in1.throw], [PLAN.THROW, true]);
});

test('antiAir_opponentAirborneInReach_crouchesThenPressesTheAntiAirMove', () => {
  const c = duel(1.0, { difficulty: passive({ antiAirChance: 1 }) });
  c.a.grounded = false;
  c.a.y = 0.6;
  c.cpu.sample(c.in1, c.b, c.a);
  assert.deepEqual([c.cpu.reason, c.cpu.reasonKey, c.in1.stick.y, c.in1.heavy], [REASON.ANTI_AIR, 'crouchHeavy', -1, false], 'crouch first');
  c.b.crouching = true;
  c.cpu.sample(c.in1, c.b, c.a);
  assert.deepEqual([c.in1.stick.y, c.in1.heavy], [-1, true], 'then the button');
  const z = duel(1.0, { difficulty: passive({ antiAirChance: 0 }) });
  z.a.grounded = false;
  z.cpu.sample(z.in1, z.b, z.a);
  assert.notEqual(z.cpu.reason, REASON.ANTI_AIR);
  const far = duel(3.0, { difficulty: passive({ antiAirChance: 1 }) });
  far.a.grounded = false;
  far.cpu.sample(far.in1, far.b, far.a);
  assert.notEqual(far.cpu.reason, REASON.ANTI_AIR, 'out of reach');
});

test('counter_armouredSpecialAbsorbsASeenMidInItsWindow_elseBlocks', () => {
  // Opponent heavy (mid, startup 14) seen at frame 2 with reaction 0: arrives in 13 ticks, inside the
  // Charge's armour 4..18, Charge reach covers 1.3.
  const c = duel(1.3, { difficulty: passive({ counterChance: 1, blockChance: 1 }) });
  poseAttack(c.a, 'heavy', 2);
  c.cpu.sample(c.in1, c.b, c.a);
  assert.deepEqual([c.cpu.reason, c.cpu.reasonKey, c.in1.heavy, c.in1.stick.x], [REASON.COUNTER, 'specialForward', true, 1]);
  const b = duel(1.3, { difficulty: passive({ counterChance: 0, blockChance: 1 }) });
  poseAttack(b.a, 'heavy', 2);
  b.cpu.sample(b.in1, b.b, b.a);
  assert.deepEqual([b.cpu.reason, b.in1.guard], [REASON.BLOCK, true]);
  // A low is outside the armour's levels: no counter even at chance 1.
  const low = duel(1.1, { difficulty: passive({ counterChance: 1, blockChance: 1 }) });
  poseAttack(low.a, 'crouchLight', 1);
  low.cpu.sample(low.in1, low.b, low.a);
  assert.equal(low.cpu.reason, REASON.BLOCK);
});

test('defence_slowThrowSeen_jumpsOverIt_andTipStrike_walksBackOutOfIt', () => {
  const j = duel(1.2, { difficulty: passive({ jumpChance: 1, blockChance: 1 }) });
  poseAttack(j.a, 'specialBack', 2); // the Clamp: a 16f command grab
  j.cpu.sample(j.in1, j.b, j.a);
  assert.deepEqual([j.cpu.reason, j.cpu.reasonKey, j.in1.stick.y], [REASON.EVADE, 'jump', 1]);
  // Tip-range heavy, block and sidestep failed: retreat.
  const heavyR = moveReach(KIT.heavy, 0.3);
  const r = duel(heavyR - 0.05, { difficulty: passive({ blockChance: 0, sidestepChance: 0, retreatChance: 1, counterChance: 0 }) });
  poseAttack(r.a, 'heavy', 2);
  r.cpu.sample(r.in1, r.b, r.a);
  assert.deepEqual([r.cpu.reason, r.in1.stick.x], [REASON.RETREAT, -1]);
});

test('punish_whiffInRecovery_insideTheWindow_crouchHeavyNeedsItsCrouchTick', () => {
  // Whiffed heavy with 16 ticks left at 1.25 (past throw reach): the crouch heavy (14 dmg, startup 13 + its
  // crouch tick = 15 < 16) out-damages the heavy (13) and is pressed over two ticks.
  const far = duel(1.25, { difficulty: passive({ whiffPunishChance: 1 }) });
  const m = KIT.heavy;
  poseAttack(far.a, 'heavy', m.startup + m.active + m.recovery - 16);
  far.cpu.sample(far.in1, far.b, far.a);
  assert.deepEqual([far.cpu.reason, far.cpu.reasonKey, far.in1.stick.y, far.in1.heavy], [REASON.PUNISH, 'crouchHeavy', -1, false], 'crouch tick first');
  far.b.crouching = true;
  far.a.stateFrame++;
  far.cpu.sample(far.in1, far.b, far.a);
  assert.deepEqual([far.in1.heavy, far.in1.stick.y], [true, -1]);
  // Too late for crouchHeavy (14 left: 13 + 2 >= 14) and the heavy (14 + 1 >= 14), but the light (7 + 1 < 14)
  // still lands from 1.2 (its reach is 1.22 against this body).
  const late = duel(1.2, { difficulty: passive({ whiffPunishChance: 1 }) });
  poseAttack(late.a, 'heavy', m.startup + m.active + m.recovery - 14);
  late.cpu.sample(late.in1, late.b, late.a);
  assert.deepEqual([late.cpu.reason, late.cpu.reasonKey], [REASON.PUNISH, 'light']);
});

test('super_neverRawInNeutral_onlyAsAPunish', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const c = duel(1.0, { behaviour: OFFENSIVE, seed, difficulty: sharp({ mistakeRate: 0.5, superPunishChance: 1, specialShare: 1 }) });
    c.b.meter = c.b.meterMax;
    for (let i = 0; i < 90; i++) {
      c.cpu.sample(c.in1, c.b, c.a);
      assert.equal(c.in1.guard && c.in1.heavy, false, `seed ${seed} tick ${i}`);
    }
  }
  const p = duel(1.0, { difficulty: passive({ whiffPunishChance: 1, superPunishChance: 1 }) });
  p.b.meter = p.b.meterMax;
  const m = KIT.heavy;
  poseAttack(p.a, 'heavy', m.startup + m.active + 1);
  p.cpu.sample(p.in1, p.b, p.a);
  assert.deepEqual([p.cpu.reason, p.cpu.reasonKey, p.in1.guard && p.in1.heavy], [REASON.PUNISH, 'overwind', true]);
});

test('specials_meterDiscipline_costedSpecialSavedNearFullMeter', () => {
  const costed = buildMoves({ ...KIT, specialBack: { ...KIT.heavy, name: 'Snap', aiRole: 'retreatPoke', meterCost: 20 } });
  const pick = (meter) => {
    const keys = new Set();
    for (let seed = 1; seed <= 30; seed++) {
      const c = duel(1.1, { behaviour: OFFENSIVE, seed, difficulty: sharp({ specialShare: 1 }) });
      c.b.moves = costed;
      c.b.meter = meter;
      c.cpu.sample(c.in1, c.b, c.a);
      if (c.cpu.reason === PLAN.SPECIAL) keys.add(c.cpu.reasonKey);
    }
    return keys;
  };
  assert.ok(pick(50).has('specialBack'), 'affordable and not near full: used');
  assert.equal(pick(85).has('specialBack'), false, 'within one cost of full: saved for Overwind');
  assert.equal(pick(10).has('specialBack'), false, 'unaffordable');
});

// Matchups ------------------------------------------------------------------------------------------

const SET = buildDifficultySet({ default: 'normal', behaviour: B, levels: AI_DIFFICULTY.levels }, ['easy', 'normal', 'hard']);

test('buildMatchups_validatesEntriesForEveryLevelAndPersonality', () => {
  const ok = buildMatchups({ matchups: { kit_a: { kit_b: { summary: 'plan', scale: { counter_chance: 1.5 } } } } }, SET);
  assert.equal(ok.kit_a.kit_b.id, 'kit_a_vs_kit_b');
  assert.throws(() => buildMatchups({ matchups: { kit_a: { kit_b: { summary: 'x', scale: { reaction_frames: 2 } } } } }, SET), /locked/);
  assert.throws(() => buildMatchups({ matchups: { kit_a: { kit_b: { summary: 'x', scale: { nope: 2 } } } } }, SET), /unknown key/);
  assert.throws(() => buildMatchups({ matchups: { 'Kit A': { kit_b: { summary: 'x' } } } }, SET), /bad entry/);
  // A scale that only overflows with a personality stacked on it fails at load.
  const lows = { trick: buildPersonality('trick', { summary: 'x', scale: { low_poke_share: 3 } }) };
  assert.throws(() => buildMatchups({ matchups: { kit_a: { kit_b: { summary: 'x', scale: { low_poke_share: 1.5 } } } } }, SET, lows), /PokeShare/);
  assert.deepEqual(buildMatchups({}, SET), {});
});

test('cpuPilot_matchupLookup_appliesThePlanForTheKitsInTheRing_weightedByMatchupSkill', () => {
  const matchups = buildMatchups({ matchups: { kit_b: { kit_a: { summary: 'x', scale: { throw_chance: 2 }, set: { aggression: 0.1 } } } } }, SET);
  const level = buildDifficulty({ ...AI_DIFFICULTY.levels.normal, throwChance: 0.3, aggression: 0.5, matchupSkill: 1 });
  const c = duel(2.0, { difficulty: level, matchups });
  assert.equal(c.cpu.matchupId, null, 'before the first sample');
  c.cpu.sample(c.in1, c.b, c.a);
  assert.equal(c.cpu.matchupId, 'kit_b_vs_kit_a');
  assert.ok(Math.abs(c.cpu.difficulty.throwChance - 0.6) < 1e-12);
  assert.ok(Math.abs(c.cpu.difficulty.aggression - 0.1) < 1e-12);
  // Half skill: half the scale, half the way to the set value.
  const half = duel(2.0, { difficulty: buildDifficulty({ ...level, matchupSkill: 0.5 }), matchups });
  half.cpu.sample(half.in1, half.b, half.a);
  assert.ok(Math.abs(half.cpu.difficulty.throwChance - 0.45) < 1e-12);
  assert.ok(Math.abs(half.cpu.difficulty.aggression - 0.3) < 1e-12);
  // The other side of the table has no entry: untouched. Kit swap re-tunes.
  const other = duel(2.0, { difficulty: level, matchups });
  other.cpu.sample(other.in1, other.a, other.b);
  assert.equal(other.cpu.matchupId, null);
  assert.equal(other.cpu.difficulty.throwChance, 0.3);
  other.cpu.sample(other.in1, other.b, other.a);
  assert.equal(other.cpu.matchupId, 'kit_b_vs_kit_a');
  // A kit range preference (spec.ai.rangeBias) is picked up at the same re-tune.
  const biased = duel(2.0, { difficulty: level });
  biased.b.spec = { ...SPEC_B, ai: { rangeBias: 0.1 } };
  biased.cpu.sample(biased.in1, biased.b, biased.a);
  assert.equal(biased.cpu.behaviour.rangeBias, 0.1);
});

// Determinism and the action mix ---------------------------------------------------------------------

test('determinism_sameSeedSameInputs_identicalDecisions_acrossAllNewRules', () => {
  const trace = (seed) => {
    const sim = createDuel(RULESET);
    const [a, b] = sim.fighters;
    for (const f of [a, b]) f.moves = KIT;
    a.spec = SPEC_A;
    b.spec = SPEC_B;
    const mk = (s) => new CpuPilot({ difficulty: AI_DIFFICULTY.levels.hard, behaviour: B, rules: RULESET.rules, seed: s });
    const c0 = mk(seed);
    const c1 = mk(seed + 1);
    const in0 = createSnapshot();
    const in1 = createSnapshot();
    const out = [];
    for (let t = 0; t < 1200 && sim.koFrame < 0; t++) {
      c0.sample(in0, a, b);
      c1.sample(in1, b, a);
      out.push(`${c0.reason}/${c0.reasonKey}|${c1.reason}/${c1.reasonKey}|${JSON.stringify(in1)}`);
      stepDuel(sim, in0, in1, DT);
    }
    return out;
  };
  assert.deepEqual(trace(5), trace(5));
  assert.notDeepEqual(trace(5), trace(6));
});

test('actionMix_newReasons_haveCategories', () => {
  assert.deepEqual(
    [actionOf(REASON.STRING, 'light2'), actionOf(REASON.COUNTER, 'heavy'), actionOf(REASON.ANTI_AIR, 'crouchHeavy'),
      actionOf(REASON.RESPECT, null), actionOf(REASON.RETREAT, null), actionOf(REASON.EVADE, 'jump'), actionOf(PLAN.JUMP, null)],
    ['string', 'counter', 'antiAir', 'guard', 'backOff', 'jump', 'jump'],
  );
  const mix = new ActionMix();
  mix.add(REASON.STRING, 'light2');
  mix.add(REASON.PUNISH, null);
  assert.deepEqual([mix.total, mix.share('string')], [1, 1]);
});
