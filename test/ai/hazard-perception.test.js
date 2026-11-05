// Story-013 HAZARD-SIM: the CPU sees telegraphed hazard zones reactionFrames late and steps out of
// them with a difficulty-scaled roll (hazardEvadeChance); without hazards nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import COMBAT from '../fixtures/combat_tuning.json' with { type: 'json' };
import { createSnapshot } from '../fixtures/bound/input-snapshot.js';
import { AI_DIFFICULTY } from '../fixtures/bound/ai-data.js';
import { createRuleset, createDuel, stepDuel, msToFrames, HAZARD_EVENT, fighterInZone, STATE } from '../../src/sim/index.js';
import {
  CpuPilot, REASON, PLAN, buildDifficulty, buildBehaviour, createHazardObservation, observeHazards, DIFFICULTY_KEYS,
  LOCKED_KEYS,
} from '../../src/ai/index.js';

const DT = 1 / 60;
const VENT = Object.freeze({
  id: 'vent',
  zone: { x0: 1.0, x1: 2.0 },
  cycle: { period_ms: 4000, telegraph_ms: 900, active_ms: 200, phase_ms: 100 },
  effect: { damage: 10, knockback: 0.5, hitstun_frames: 20 },
});
const TEL = msToFrames(900);
const PHASE = msToFrames(100);
const RULESET = createRuleset({
  rules: COMBAT.rules, movement: COMBAT.movement, moves: COMBAT.greyboxMoves, round: COMBAT.round, meter: COMBAT.meter, hazards: [VENT],
});
const BEHAVIOUR = AI_DIFFICULTY.behaviour;
/** A CPU that only waits in neutral, so the hazard rule is the only thing that can move it. */
const PASSIVE = buildBehaviour({ ...BEHAVIOUR, guardWeight: 0, backOffWeight: 0, sidestepWeight: 0 });
const level = (over) => buildDifficulty({ ...AI_DIFFICULTY.levels.hard, aggression: 0, mistakeRate: 0, sidestepChance: 0, specialShare: 0, ...over });

test('difficulty_hazardEvadeChance_optionalDefaultsToOneMinusMistakeRate_andIsLocked', () => {
  assert.ok(DIFFICULTY_KEYS.includes('hazardEvadeChance'));
  for (const n of ['easy', 'normal', 'hard']) {
    const d = AI_DIFFICULTY.levels[n];
    assert.ok(Math.abs(d.hazardEvadeChance - (1 - d.mistakeRate)) < 1e-12, n);
  }
  assert.ok(AI_DIFFICULTY.levels.easy.hazardEvadeChance < AI_DIFFICULTY.levels.hard.hazardEvadeChance);
  assert.equal(buildDifficulty({ ...AI_DIFFICULTY.levels.easy, hazardEvadeChance: 0.5 }).hazardEvadeChance, 0.5);
  assert.throws(() => buildDifficulty({ ...AI_DIFFICULTY.levels.easy, hazardEvadeChance: 1.5 }), /hazardEvadeChance/);
  assert.ok(LOCKED_KEYS.includes('hazardEvadeChance'), 'a personality may not change it');
});

test('observeHazards_telegraphBecomesVisibleAfterTheReactionDelay_activeAlways', () => {
  const sim = createDuel(RULESET);
  const zones = [createHazardObservation(), createHazardObservation()];
  const in0 = createSnapshot();
  const in1 = createSnapshot();
  const delay = 9;
  const look = () => observeHazards(zones, sim.hazards, delay);
  assert.equal(look(), 1, 'one slot per hazard');
  assert.deepEqual([zones[0].visible, zones[0].inFrames], [false, -1]);
  for (let i = 0; i < PHASE; i++) stepDuel(sim, in0, in1, DT); // telegraph starts on this tick
  look();
  assert.deepEqual([zones[0].visible, zones[0].inFrames, zones[0].cycle, zones[0].id, zones[0].x0, zones[0].x1], [false, TEL, 1, 'vent', 1, 2]);
  for (let i = 0; i < delay - 1; i++) stepDuel(sim, in0, in1, DT);
  look();
  assert.equal(zones[0].visible, false, 'one tick short of the reaction delay');
  stepDuel(sim, in0, in1, DT);
  look();
  assert.deepEqual([zones[0].visible, zones[0].inFrames], [true, TEL - delay]);
  for (let i = 0; i < TEL - delay; i++) stepDuel(sim, in0, in1, DT);
  look();
  assert.deepEqual([zones[0].visible, zones[0].inFrames], [true, 0], 'active: visible, 0 frames to active');
  assert.equal(zones[1].visible, false, 'unused slot untouched');
});

/** Drive fighter 1 with `cpu` from the start until the vent has fired; returns the vent's hit events. */
function fight(cpu, { seeHazards = true } = {}) {
  const sim = createDuel(RULESET);
  const [p1, p2] = sim.fighters;
  const in0 = createSnapshot();
  const in1 = createSnapshot();
  const reasons = new Set();
  const hits = [];
  for (let f = 0; f < PHASE + TEL + 3; f++) {
    cpu.sample(in1, p2, p1, seeHazards ? sim.hazards : null);
    reasons.add(cpu.reason);
    stepDuel(sim, in0, in1, DT);
    for (let i = 0; i < sim.eventCount; i++) if (sim.events[i].type === HAZARD_EVENT.HIT) hits.push({ ...sim.events[i] });
  }
  return { sim, p2, hits, reasons };
}

test('cpu_hardAlwaysStepsOutOfATelegraphedZone_beforeItFires', () => {
  const cpu = new CpuPilot({ difficulty: level({ hazardEvadeChance: 1 }), behaviour: PASSIVE, rules: RULESET.rules, seed: 3 });
  const { sim, p2, hits, reasons } = fight(cpu);
  assert.equal(hits.length, 0, 'never struck');
  assert.equal(p2.hp, 100);
  assert.ok(!fighterInZone(p2, sim.hazards[0].data.zone, sim.rules), `out of the zone at x=${p2.x}`);
  assert.ok(p2.x < 1.0, 'walked toward the opponent (the nearer exit that stays on the ring)');
  assert.ok(reasons.has(REASON.HAZARD));
  assert.ok(p2.state !== STATE.HITSTUN);
});

test('cpu_zeroEvadeChanceOrNoHazardView_staysAndIsStruck', () => {
  const ignore = new CpuPilot({ difficulty: level({ hazardEvadeChance: 0 }), behaviour: PASSIVE, rules: RULESET.rules, seed: 3 });
  const a = fight(ignore);
  assert.equal(a.hits.length, 1);
  assert.equal(a.p2.hp, 90);
  assert.ok(!a.reasons.has(REASON.HAZARD));

  const blind = new CpuPilot({ difficulty: level({ hazardEvadeChance: 1 }), behaviour: PASSIVE, rules: RULESET.rules, seed: 3 });
  const b = fight(blind, { seeHazards: false });
  assert.equal(b.hits.length, 1, 'no hazard view (training / legacy host): unchanged behaviour');
});

test('cpu_evadeRollIsOncePerTelegraph_andSeedDeterministic', () => {
  const half = () => new CpuPilot({ difficulty: level({ hazardEvadeChance: 0.5 }), behaviour: PASSIVE, rules: RULESET.rules, seed: 11 });
  const a = fight(half());
  const b = fight(half());
  assert.equal(a.p2.hp, b.p2.hp, 'same seed, same decision');
  assert.equal(a.p2.x, b.p2.x);
  // Over many seeds the roll lands on both sides.
  const outcomes = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const cpu = new CpuPilot({ difficulty: level({ hazardEvadeChance: 0.5 }), behaviour: PASSIVE, rules: RULESET.rules, seed });
    outcomes.add(fight(cpu).p2.hp);
  }
  assert.deepEqual([...outcomes].sort(), [100, 90]);
});

test('cpu_approachHoldsInsteadOfWalkingIntoAVisibleZone', () => {
  // Zone between the fighters, the CPU on the far side of it, approaching an idle opponent.
  const between = { ...VENT, zone: { x0: -0.2, x1: 0.8 }, cycle: { ...VENT.cycle, telegraph_ms: 2000, period_ms: 5000 } };
  const rs = createRuleset({
    rules: COMBAT.rules, movement: COMBAT.movement, moves: COMBAT.greyboxMoves, round: COMBAT.round, meter: COMBAT.meter, hazards: [between],
  });
  const sim = createDuel(rs);
  const [p1, p2] = sim.fighters;
  p2.x = p2.prevX = 1.6;
  const aggressive = buildDifficulty({ ...AI_DIFFICULTY.levels.hard, aggression: 1, mistakeRate: 0, sidestepChance: 0, specialShare: 0, hazardEvadeChance: 1 });
  const cpu = new CpuPilot({ difficulty: aggressive, behaviour: buildBehaviour({ ...BEHAVIOUR, waitWeight: 0 }), rules: rs.rules, seed: 5 });
  const in0 = createSnapshot();
  const in1 = createSnapshot();
  let minX = Infinity;
  for (let f = 0; f < PHASE + msToFrames(2000); f++) {
    cpu.sample(in1, p2, p1, sim.hazards);
    stepDuel(sim, in0, in1, DT);
    if (f > PHASE + 20 && p2.x < minX) minX = p2.x;
  }
  assert.ok(minX > between.zone.x1, `held short of the zone (min x ${minX})`);
  assert.equal(p2.hp, 100);
  assert.ok([PLAN.APPROACH, PLAN.WAIT, PLAN.POKE, REASON.HAZARD].includes(cpu.reason));
});
