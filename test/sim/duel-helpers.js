// Shared helpers for story-002 sim tests (not a test file itself).
import { createSnapshot } from '../fixtures/bound/input-snapshot.js';
import { createDuel, stepDuel } from '../fixtures/bound/duel-sim.js';

export const DT = 1 / 60;

/** New duel with the two fighters `d` apart on the x axis, facing each other. */
export function duelAt(d) {
  const sim = createDuel();
  const [a, b] = sim.fighters;
  a.x = a.prevX = -d / 2;
  b.x = b.prevX = d / 2;
  a.z = a.prevZ = b.z = b.prevZ = 0;
  return { sim, a, b, in0: createSnapshot(), in1: createSnapshot() };
}

/** Step one tick, then clear the one-shot button events (as InputState.sample does). */
export function tick(ctx) {
  stepDuel(ctx.sim, ctx.in0, ctx.in1, DT);
  for (const s of [ctx.in0, ctx.in1]) {
    s.light = s.heavy = s.throw = false;
    s.sidestep = 0;
  }
}

/** Step `n` ticks. */
export function run(ctx, n) {
  for (let i = 0; i < n; i++) tick(ctx);
}

/** Step until sim.frame === frame (inclusive). */
export function runTo(ctx, frame) {
  while (ctx.sim.frame < frame) tick(ctx);
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
