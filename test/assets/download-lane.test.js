// Download lane (0.5.2 BOOT-NET): one in flight, priority then FIFO, bumps, promotion with preemption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadLane } from '../../src/assets/download-lane.js';

/** A job whose run resolves when the test releases it; records start order and honours the abort signal. */
function gated(order) {
  const gates = new Map();
  const make = (id, { honourAbort = true } = {}) => ({ signal }) => new Promise((resolve, reject) => {
    order.push(id);
    gates.set(id, () => resolve(`${id}:done`));
    if (honourAbort && signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const release = async (id) => {
    while (!gates.has(id)) await new Promise((r) => setTimeout(r, 0));
    gates.get(id)();
    gates.delete(id);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { make, release };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('lane_runsOneJobAtATime_inPriorityThenFifoOrder', async () => {
  // Arrange
  const order = [];
  const { make, release } = gated(order);
  const lane = createDownloadLane();
  // Act: three audio clips at 30, a stage at 20, a hero at 10, added in that order
  const done = [
    lane.add({ id: 'bank:a', priority: 30, run: make('bank:a') }),
    lane.add({ id: 'bank:b', priority: 30, run: make('bank:b') }),
    lane.add({ id: 'stage', priority: 20, run: make('stage') }),
    lane.add({ id: 'hero', priority: 10, run: make('hero') }),
  ];
  await tick();
  // Assert: only the most urgent started
  assert.deepEqual(order, ['hero']);
  assert.equal(lane.current(), 'hero');
  assert.deepEqual(lane.snapshot().map((j) => j.id), ['hero', 'stage', 'bank:a', 'bank:b']);
  await release('hero');
  await release('stage');
  await release('bank:a');
  await release('bank:b');
  assert.deepEqual(order, ['hero', 'stage', 'bank:a', 'bank:b']);
  assert.deepEqual(await Promise.all(done), ['bank:a:done', 'bank:b:done', 'stage:done', 'hero:done']);
  await lane.idle();
  assert.equal(lane.current(), null);
});

test('lane_addSameId_returnsTheSamePromise_andLowersItsPriorityWhenMoreUrgent', async () => {
  // Arrange
  const order = [];
  const { make, release } = gated(order);
  const lane = createDownloadLane();
  lane.add({ id: 'first', priority: 10, run: make('first') });
  await tick(); // first is in flight
  const p1 = lane.add({ id: 'clip', priority: 30, run: make('clip') });
  lane.add({ id: 'stage', priority: 20, run: make('stage') });
  // Act: the clip is asked again, more urgently (the picked pair's material at Ignite)
  const p2 = lane.add({ id: 'clip', priority: 15, run: make('clip-dup') });
  // Assert
  assert.equal(p1, p2, 'one promise per id');
  assert.deepEqual(lane.snapshot().map((j) => j.id), ['first', 'clip', 'stage']);
  assert.equal(lane.bump('stage', 5), true, 'a queued job can be re-prioritised');
  assert.deepEqual(lane.snapshot().map((j) => j.id), ['first', 'stage', 'clip']);
  assert.equal(lane.bump('first', 99), false, 'the running job is not re-prioritised');
  assert.equal(lane.bump('nope', 1), false);
  await release('first'); await release('stage'); await release('clip');
  assert.deepEqual(order, ['first', 'stage', 'clip'], 'the duplicate run never ran');
});

test('lane_promote_movesAQueuedJobToTheFront_aheadOfLowerPriorityNumbers', async () => {
  // Arrange: a hero in flight, two heroes and a clip queued
  const order = [];
  const { make, release } = gated(order);
  const lane = createDownloadLane();
  lane.add({ id: 'hero:a', priority: 10, run: make('hero:a'), preempt: () => false });
  await tick(); // a is in flight
  lane.add({ id: 'hero:b', priority: 10, run: make('hero:b') });
  lane.add({ id: 'stage', priority: 5, run: make('stage') });
  lane.add({ id: 'hero:c', priority: 10, run: make('hero:c') });
  // Act: the player swipes to c
  assert.equal(lane.promote('hero:c'), true);
  assert.equal(lane.promote('ghost'), false);
  // Assert: c is next, ahead of the stage (priority 5); a keeps downloading (preempt said no)
  assert.deepEqual(lane.snapshot().map((j) => j.id), ['hero:a', 'hero:c', 'stage', 'hero:b']);
  await release('hero:a');
  assert.equal(lane.current(), 'hero:c');
  await release('hero:c'); await release('stage'); await release('hero:b');
  assert.deepEqual(order, ['hero:a', 'hero:c', 'stage', 'hero:b'], 'a ran once: not preempted');
});

test('lane_promote_preemptsTheRunningJobWhenItSaysSo_andRequeuesItRightBehind_withTheSamePromise', async () => {
  // Arrange: a barely-started hero in flight (preempt: true), another queued
  const order = [];
  const { make, release } = gated(order);
  const lane = createDownloadLane();
  let fraction = 0.05;
  const pa = lane.add({ id: 'hero:a', priority: 10, run: make('hero:a'), preempt: () => fraction < 0.34 });
  const pb = lane.add({ id: 'hero:b', priority: 10, run: make('hero:b') });
  lane.add({ id: 'bank:x', priority: 30, run: make('bank:x') });
  await tick();
  assert.equal(lane.current(), 'hero:a');
  // Act: swipe to b
  lane.promote('hero:b');
  await tick();
  // Assert: a was aborted and sits right behind b; b is in flight; the promise of a is unchanged
  assert.equal(lane.current(), 'hero:b');
  assert.deepEqual(lane.snapshot().map((j) => j.id), ['hero:b', 'hero:a', 'bank:x']);
  await release('hero:b');
  assert.equal(await pb, 'hero:b:done');
  assert.equal(lane.current(), 'hero:a', 'the preempted hero runs again, from the start');
  fraction = 0.9;
  lane.promote('bank:x'); // too late to preempt a now
  await release('hero:a');
  assert.equal(await pa, 'hero:a:done');
  assert.deepEqual(order, ['hero:a', 'hero:b', 'hero:a', 'bank:x']);
  await release('bank:x');
  await lane.idle();
});

test('lane_promote_withPreemptFalse_leavesTheFlightAlone_andPromotingTheJobBeingAbortedPutsItFirst', async () => {
  // Arrange: the regression: at a fight start, promoting the rival aborted the player's own hero in flight
  const order = [];
  const { make, release } = gated(order);
  const lane = createDownloadLane();
  lane.add({ id: 'mine', priority: 10, run: make('mine'), preempt: () => true });
  lane.add({ id: 'rival', priority: 10, run: make('rival'), preempt: () => true });
  await tick();
  // Act: rival moves up without aborting; mine asks again: still running, nothing changes
  lane.promote('rival', { preempt: false });
  lane.promote('mine');
  await tick();
  // Assert
  assert.equal(lane.current(), 'mine');
  assert.deepEqual(order, ['mine'], 'still its first attempt: not preempted');
  // Act: a third job preempts mine, then mine is asked for in the same breath, before the abort has landed
  lane.add({ id: 'other', priority: 10, run: make('other') });
  lane.promote('other');
  assert.equal(lane.current(), 'mine', 'the abort has not landed yet');
  lane.promote('mine');
  await tick();
  // Assert: mine runs again first, once in the queue
  assert.equal(lane.current(), 'mine');
  assert.deepEqual(lane.snapshot().map((j) => j.id), ['mine', 'other', 'rival']);
  await release('mine'); await release('other'); await release('rival');
  assert.deepEqual(order, ['mine', 'mine', 'other', 'rival']);
});

test('lane_preemptedJobThatIgnoresTheSignal_finishesNormally_andIsNotRunTwice', async () => {
  // Arrange
  const order = [];
  const { make, release } = gated(order);
  const lane = createDownloadLane();
  const pa = lane.add({ id: 'a', priority: 10, run: make('a', { honourAbort: false }), preempt: () => true });
  const pb = lane.add({ id: 'b', priority: 10, run: make('b') });
  await tick();
  // Act
  lane.promote('b');
  await tick();
  assert.equal(lane.current(), 'a', 'a still running: it ignored the abort');
  await release('a');
  // Assert
  assert.equal(await pa, 'a:done');
  assert.equal(lane.current(), 'b');
  await release('b');
  assert.equal(await pb, 'b:done');
  assert.deepEqual(order, ['a', 'b']);
});

test('lane_yieldToFront_abortsThePreemptibleJobInFlight_onlyForSomethingMoreUrgent', async () => {
  // Arrange: a hero in flight (priority 10), another queued at the same priority
  const order = [];
  const { make, release } = gated(order);
  const lane = createDownloadLane();
  let allowed = true;
  lane.add({ id: 'hero', priority: 10, run: make('hero'), preempt: () => allowed });
  lane.add({ id: 'hero:b', priority: 10, run: make('hero:b') });
  await tick();
  // Act / Assert: nothing more urgent waits: the regression would throw the download away just to restart it
  lane.yieldToFront();
  await tick();
  assert.deepEqual(order, ['hero']);
  // Arrange: audio arrives ahead of it, but this download says no
  lane.add({ id: 'clip', priority: -1, run: make('clip') });
  allowed = false;
  lane.yieldToFront();
  await tick();
  assert.equal(lane.current(), 'hero', 'past the preempt line it finishes');
  // Act: now it allows it
  allowed = true;
  lane.yieldToFront();
  await tick();
  // Assert: the clip runs, the hero keeps its place and restarts ahead of hero:b
  assert.equal(lane.current(), 'clip');
  assert.deepEqual(lane.snapshot().map((j) => j.id), ['clip', 'hero', 'hero:b']);
  await release('clip'); await release('hero'); await release('hero:b');
  assert.deepEqual(order, ['hero', 'clip', 'hero', 'hero:b']);
});

test('lane_rejectionSettlesOnlyThatJob_andIdleResolvesWhenEmpty', async () => {
  // Arrange
  const lane = createDownloadLane();
  await lane.idle(); // at once when empty
  const bad = lane.add({ id: 'bad', priority: 1, run: async () => { throw new Error('boom'); } });
  const good = lane.add({ id: 'good', priority: 2, run: async () => 42 });
  // Act / Assert
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 42);
  await lane.idle();
  assert.equal(lane.promote('bad'), false, 'a settled job is gone');
  assert.deepEqual(lane.snapshot(), []);
});
