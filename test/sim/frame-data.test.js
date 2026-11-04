// pocket-ready/008: frame-advantage calc checked against the sim tick by tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duelAt, tick } from '../sim/duel-helpers.js';
import { STATE } from '../fixtures/bound/state-machine.js';
import { frameAdvantage, FrameDataTracker, OUTCOME } from '../../src/sim/frame-data.js';

const move = { startup: 5, active: 3, recovery: 10, hitstun: 15, blockstun: 8, thrownFrames: 0, level: 'mid' };

test('frameAdvantage: stun minus remaining move ticks', () => {
  assert.equal(frameAdvantage(move, 6, 'hit'), 15 - (18 - 6));
  assert.equal(frameAdvantage(move, 6, 'block'), 8 - 12);
  // Later active frame = less recovery left = more advantage.
  assert.equal(frameAdvantage(move, 8, 'hit'), 15 - 10);
  assert.equal(frameAdvantage({ ...move, level: 'throw', thrownFrames: 30 }, 6, 'hit'), 30 - 12);
});

/** Press `button` for fighter 0 against a fighter 1 that holds `guard`; return measured vs tracked. */
function measure(button, guard) {
  const ctx = duelAt(0.9);
  const tr = new FrameDataTracker(0);
  ctx.in1.guard = guard;
  for (let i = 0; i < 5; i++) { tick(ctx); tr.observe(ctx.sim); }
  ctx.in0[button] = true;
  let atkFree = -1;
  let defFree = -1;
  let contact = false;
  for (let t = 0; t < 200 && (atkFree < 0 || defFree < 0); t++) {
    tick(ctx);
    ctx.in1.guard = guard;
    tr.observe(ctx.sim);
    const stun = guard ? STATE.BLOCKSTUN : STATE.HITSTUN;
    if (!contact && ctx.b.state === stun) contact = true;
    if (contact && atkFree < 0 && ctx.a.state !== STATE.ATTACK) atkFree = t;
    if (contact && defFree < 0 && ctx.b.state !== stun) defFree = t;
  }
  assert.ok(contact, `${button} must connect`);
  return { measured: defFree - atkFree, tr };
}

test('tracker advantage on hit matches the sim', () => {
  const { measured, tr } = measure('light', false);
  assert.equal(tr.outcome, OUTCOME.HIT);
  assert.equal(tr.advantage, measured);
  assert.ok(tr.startup > 0 && tr.active > 0 && tr.recovery >= 0);
  assert.equal(tr.comboHits, 1);
  assert.ok(tr.damage > 0);
});

test('tracker advantage on block matches the sim', () => {
  const { measured, tr } = measure('light', true);
  assert.equal(tr.outcome, OUTCOME.BLOCK);
  assert.equal(tr.advantage, measured);
});

test('frame values come from the fighter move data', () => {
  const { tr, } = measure('heavy', false);
  const m = duelAt(1).a.moves[tr.moveId];
  assert.deepEqual([tr.startup, tr.active, tr.recovery], [m.startup, m.active, m.recovery]);
  assert.equal(tr.onHit, frameAdvantage(m, m.startup + 1, 'hit'));
});
