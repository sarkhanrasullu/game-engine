// Camera framing math (moved from the consumer's loop tests with framing.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFraming, FRAMING_CONFIG } from '../../src/render/framing.js';

test('camera frames both fighters side-on, fighter 1 on the left', () => {
  const out = {};
  computeFraming(-1.4, 0, 1.4, 0, 50, 16 / 9, out);
  assert.ok(out.z > 0 && Math.abs(out.x) < 1e-9);
  // after circling 90 degrees the camera follows the line between fighters
  computeFraming(0, -1.4, 0, 1.4, 50, 16 / 9, out);
  assert.ok(out.x < 0 && Math.abs(out.z) < 1e-9);
});

test('camera backs off for portrait aspect and wide separation', () => {
  const a = {}, b = {}, c = {};
  computeFraming(-1, 0, 1, 0, 50, 16 / 9, a);
  computeFraming(-1, 0, 1, 0, 50, 9 / 16, b);
  computeFraming(-3, 0, 3, 0, 50, 16 / 9, c);
  assert.ok(b.z > a.z);
  assert.ok(c.z > a.z);
});

test('coincident fighters do not produce NaN', () => {
  const out = {};
  computeFraming(1, 1, 1, 1, 50, 1.5, out);
  assert.ok(Object.values(out).every(Number.isFinite));
});

test('an injected framing config changes the camera distance', () => {
  const a = {}, b = {};
  computeFraming(-1, 0, 1, 0, 50, 16 / 9, a);
  computeFraming(-1, 0, 1, 0, 50, 16 / 9, b, { ...FRAMING_CONFIG, margin: FRAMING_CONFIG.margin * 2 });
  assert.ok(b.z > a.z);
});
