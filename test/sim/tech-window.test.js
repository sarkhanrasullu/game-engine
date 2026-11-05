// FIGHT-PRESENT: the read a presentation layer takes on a throw's tech window (techWindowOpen), the rule built on it
// (techReady), the kit's optional tech recoil pose and the frame-data tier. Fixture ships no key: spec defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTER_TIER, createPose, computePose, createPoseContext, FrameDataTracker, STATE, techReady, techWindowOpen } from '../../src/sim/index.js';
import { BUFFER } from '../../src/sim/fighter.js';
import { hitKind } from '../../src/render/scene.js';
import { MOVES } from '../fixtures/bound/moves.js';
import { RULESET } from '../fixtures/bound/ruleset.js';
import { duelAt, tick, run } from './duel-helpers.js';

const { rules: R } = RULESET;
const T = MOVES.throw;

function grabbed() {
  const ctx = duelAt(0.95);
  ctx.in0.throw = true;
  run(ctx, T.startup + 1);
  assert.equal(ctx.b.state, STATE.THROWN);
  return ctx;
}

test('techWindowOpen_coversTheHitstopAndExactlyTheWindowTicks_thenCloses', () => {
  const ctx = grabbed();
  let open = 0;
  for (let i = 0; i < T.hitstop + R.throwTechWindow + 10; i++) {
    assert.equal(ctx.sim.fighters[1].state, STATE.THROWN);
    if (techWindowOpen(ctx.b, ctx.a, R)) open++;
    tick(ctx);
  }
  assert.equal(open, T.hitstop + R.throwTechWindow, 'open on the connect tick, through the freeze and the window');
  assert.equal(techWindowOpen(ctx.b, ctx.a, R), false);
});

test('techWindowOpen_falseWithoutAGrab_forAnUntechableGrab_andOnAKoThrower', () => {
  const ctx = grabbed();
  assert.equal(techWindowOpen(ctx.a, ctx.b, R), false, 'the thrower is not held');
  ctx.b.grabMove = null;
  assert.equal(techWindowOpen(ctx.b, ctx.a, R), false, 'nothing techable holds it');
  const ko = grabbed();
  ko.a.state = STATE.KO;
  assert.equal(techWindowOpen(ko.b, ko.a, R), false);
});

test('techReady_isTheWindowPlusABufferedThrow', () => {
  const ctx = grabbed();
  assert.equal(techWindowOpen(ctx.b, ctx.a, R), true);
  assert.equal(techReady(ctx.b, ctx.a, R), false, 'no press');
  ctx.b.bufAction = BUFFER.THROW;
  assert.equal(techReady(ctx.b, ctx.a, R), true);
  ctx.b.stateFrame = R.throwTechWindow;
  assert.equal(techReady(ctx.b, ctx.a, R), false, 'too late');
});

test('computePose_tech_usesTheKitsTechDelta_elseItsBlockRecoil', () => {
  const blockstun = { ...createPose(), torsoPitch: -0.1 };
  const tech = { ...createPose(), torsoPitch: -0.5 };
  const stand = createPose();
  const spec = {
    poses: { stand, neutral: stand }, deltas: { blockstun }, legLength: 0.8, standHipY: 0.8, proportions: { thigh: 0.4, shin: 0.4 },
    anim: { stunPeakFrames: 2, keySpin: { stun: 0 } },
  };
  const f = { state: STATE.TECH, stateFrame: 2, stunLeft: 8, grounded: true, y: 0 };
  const out = createPose();
  computePose(spec, f, createPoseContext(), out);
  assert.ok(Math.abs(out.torsoPitch - blockstun.torsoPitch) < 1e-9, 'no tech pose: the block recoil at full weight');
  computePose({ ...spec, deltas: { blockstun, tech } }, f, createPoseContext(), out);
  assert.ok(Math.abs(out.torsoPitch - tech.torsoPitch) < 1e-9, 'the kit tech pose wins');
});

test('hitKind_aTechIsNotTheThrowItBroke', () => {
  assert.equal(hitKind({ type: 'tech', fx: 'throw', armor: 0 }), 'tech');
  assert.equal(hitKind({ type: 'throw', fx: 'throw', armor: 0 }), 'throw');
});

test('frameData_recordsTheCounterTier_clearsItOnANewMove', () => {
  const t = new FrameDataTracker(0);
  const ctx = duelAt(0.95);
  // Fighter 1 in its heavy's startup: fighter 0's jab lands as a counter.
  ctx.in0.light = true;
  ctx.b.state = STATE.ATTACK;
  ctx.b.moveId = 'heavy';
  ctx.b.move = ctx.b.moves.heavy;
  ctx.b.attackHasHit = true;
  for (let i = 0; i < 20 && !ctx.a.attackHasHit; i++) {
    ctx.b.stateFrame = 1;
    tick(ctx);
    t.observe(ctx.sim);
  }
  assert.equal(ctx.a.hitCounter, COUNTER_TIER.COUNTER);
  assert.equal(t.counter, COUNTER_TIER.COUNTER);
  run(ctx, 60);
  ctx.b.state = STATE.IDLE;
  ctx.in0.light = true;
  tick(ctx);
  t.observe(ctx.sim);
  assert.equal(t.counter, 0, 'a new move starts clean');
});
