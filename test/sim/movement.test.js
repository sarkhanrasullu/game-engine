import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFighter, stepFighter } from '../fixtures/bound/movement.js';
import { MOVEMENT_CONFIG as C } from '../fixtures/bound/movement-config.js';
import { createSnapshot } from '../fixtures/bound/input-snapshot.js';

const DT = 1 / 60;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function run(f, o, snap, secs) {
  for (let i = 0; i < Math.round(secs * 60); i++) stepFighter(f, o, snap, DT);
}
function setup() {
  return { a: createFighter(-C.startOffset, 0), b: createFighter(C.startOffset, 0), s: createSnapshot() };
}

test('forward walks toward opponent, back walks away more slowly', () => {
  const { a, b, s } = setup();
  s.stick.x = 1;
  run(a, b, s, 0.2);
  assert.ok(a.x > -C.startOffset);
  const fwd = a.x + C.startOffset;
  const a2 = createFighter(-C.startOffset, 0);
  s.stick.x = -1;
  run(a2, b, s, 0.2);
  assert.ok(C.startOffset - -a2.x < 0.001 + fwd); // back distance <= forward distance
  assert.ok(a2.x < -C.startOffset);
});

test('deadzone ignores tiny stick input', () => {
  const { a, b, s } = setup();
  s.stick.x = 0.1;
  run(a, b, s, 1);
  assert.equal(a.x, -C.startOffset);
});

test('fighters never overlap and face each other', () => {
  const { a, b, s } = setup();
  s.stick.x = 1;
  run(a, b, s, 3);
  assert.ok(dist(a, b) >= C.minSeparation - 1e-9);
  assert.ok(Math.abs(a.yaw - Math.PI / 2) < 1e-9);
  stepFighter(b, a, createSnapshot(), DT);
  assert.ok(Math.abs(b.yaw + Math.PI / 2) < 1e-9);
});

test('crouch stops walking and releases when stick returns', () => {
  const { a, b, s } = setup();
  s.stick.y = -1;
  s.stick.x = 1;
  run(a, b, s, 0.2);
  assert.equal(a.crouching, true);
  assert.equal(a.x, -C.startOffset);
  s.stick.y = 0;
  run(a, b, s, 0.05);
  assert.equal(a.crouching, false);
});

test('jump rises then lands', () => {
  const { a, b, s } = setup();
  s.stick.y = 1;
  stepFighter(a, b, s, DT);
  s.stick.y = 0;
  run(a, b, s, 0.2);
  assert.ok(a.y > 0.3 && !a.grounded);
  run(a, b, s, 1);
  assert.equal(a.y, 0);
  assert.ok(a.grounded);
});

test('sidestep circles the opponent keeping distance (3D axis)', () => {
  const { a, b, s } = setup();
  const d0 = dist(a, b);
  s.sidestep = 1;
  stepFighter(a, b, s, DT);
  s.sidestep = 0;
  run(a, b, s, C.sidestepDuration);
  assert.ok(Math.abs(dist(a, b) - d0) < 1e-6);
  assert.ok(a.z < -0.3, `z=${a.z}`); // moved along the depth axis (away from camera = -z)
  assert.equal(b.x, C.startOffset);
  const c = createFighter(-C.startOffset, 0);
  s.sidestep = -1;
  stepFighter(c, b, s, DT);
  s.sidestep = 0;
  run(c, b, s, C.sidestepDuration);
  assert.ok(c.z > 0.3);
});

test('after a sidestep forward still means toward the opponent', () => {
  const { a, b, s } = setup();
  s.sidestep = 1;
  stepFighter(a, b, s, DT);
  s.sidestep = 0;
  run(a, b, s, 0.4);
  const d1 = dist(a, b);
  s.stick.x = 1;
  run(a, b, s, 0.2);
  assert.ok(dist(a, b) < d1);
});

test('double-tap-up sidestep cancels the first-tap jump', () => {
  const { a, b, s } = setup();
  s.stick.y = 1;
  stepFighter(a, b, s, DT);
  s.stick.y = 0;
  run(a, b, s, 0.15);
  assert.ok(!a.grounded);
  s.sidestep = 1;
  stepFighter(a, b, s, DT);
  assert.ok(a.grounded && a.y === 0 && a.sidestepT > 0);
});

test('fighters stay inside the ring', () => {
  const { a, b, s } = setup();
  s.stick.x = -1;
  run(a, b, s, 10);
  assert.ok(Math.hypot(a.x, a.z) <= C.ringRadius + 1e-9);
});

test('coincident fighters resolve without NaN', () => {
  const a = createFighter(0, 0);
  const b = createFighter(0, 0);
  stepFighter(a, b, createSnapshot(), DT);
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.z) && Number.isFinite(a.yaw));
});
