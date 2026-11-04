// story-002 AC 3: hitstop freeze counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hitstop } from '../../src/core/hitstop.js';

test('trigger(n) freezes exactly n ticks', () => {
  const h = new Hitstop();
  h.trigger(3);
  assert.deepEqual([h.tick(), h.tick(), h.tick(), h.tick()], [true, true, true, false]);
});
test('overlapping triggers keep the longer freeze without stacking', () => {
  const h = new Hitstop();
  h.trigger(5);
  h.trigger(2);
  assert.equal(h.remaining, 5);
  h.reset();
  assert.equal(h.tick(), false);
});
