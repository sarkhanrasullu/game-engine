// story-002 AC 2: upright-cylinder hitbox/hurtbox overlap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCylinder, cylindersOverlap } from '../../src/core/collision.js';

function cyl(x, z, r, y0, y1) {
  return Object.assign(createCylinder(), { x, z, r, y0, y1 });
}

test('overlapping circles at shared heights overlap', () => {
  assert.equal(cylindersOverlap(cyl(0, 0, 0.5, 0, 1), cyl(0.8, 0, 0.5, 0.5, 2)), true);
});
test('touching counts as overlap', () => {
  assert.equal(cylindersOverlap(cyl(0, 0, 0.5, 0, 1), cyl(1, 0, 0.5, 1, 2)), true);
});
test('apart on the ground plane does not overlap', () => {
  assert.equal(cylindersOverlap(cyl(0, 0, 0.5, 0, 1), cyl(0.7, 0.8, 0.5, 0, 1)), false);
});
test('vertically separated (high over a croucher, low under a jumper) does not overlap', () => {
  assert.equal(cylindersOverlap(cyl(0, 0, 0.5, 1.05, 1.45), cyl(0.2, 0, 0.35, 0, 0.96)), false);
  assert.equal(cylindersOverlap(cyl(0, 0, 0.5, 0, 0.4), cyl(0.2, 0, 0.35, 0.5, 2.1)), false);
});
