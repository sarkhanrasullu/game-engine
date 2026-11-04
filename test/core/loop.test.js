import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixedStepLoop } from '../../src/core/loop.js';

function make(opts = {}) {
  const log = { steps: 0, alphas: [] };
  const loop = new FixedStepLoop({ step: () => log.steps++, render: (a) => log.alphas.push(a), ...opts });
  return { loop, log };
}

test('runs 60 steps per second regardless of frame rate', () => {
  const { loop, log } = make();
  for (let t = 0; t <= 1000; t += 1000 / 144) loop.frame(t);
  assert.ok(Math.abs(log.steps - 60) <= 1, `steps=${log.steps}`);
});

test('render alpha is within [0,1) and render is called every frame', () => {
  const { loop, log } = make();
  for (let t = 0; t < 200; t += 7) loop.frame(t);
  assert.ok(log.alphas.every((a) => a >= 0 && a < 1));
  assert.equal(log.alphas.length, Math.ceil(200 / 7));
});

test('long stalls are clamped and the backlog dropped', () => {
  const { loop, log } = make();
  loop.frame(0);
  loop.frame(60000);
  assert.ok(log.steps <= 5);
  assert.ok(loop.acc < loop.dt);
});
