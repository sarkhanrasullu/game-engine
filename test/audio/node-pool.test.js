// Node pool + wave warmer (engine /audio, AUDIO-PERF): incremental fill, reuse without creation,
// release with a free-at time (stolen voices keep fading), cancel-and-hold reset, overflow accounting,
// per-type wave-table warm-up, wave collection from a layer tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodePool, createWaveWarmer, collectOscillatorWaves, OSCILLATOR_WAVES, POOL_KINDS } from '../../src/audio/node-pool.js';
import { FakeAudioContext } from '../fixtures/fake-audio.js';

const SIZES = Object.freeze({ gain: 6, biquad: 2, panner: 1 });

test('nodePool_fillsIncrementally_thenReady_andCreatesNothingMore', () => {
  // Arrange
  const ctx = new FakeAudioContext();
  const pool = createNodePool(ctx, SIZES);
  const before = ctx.nodes.length;
  // Act
  const first = pool.fill(4);
  const readyAfterFirst = pool.ready();
  const rest = pool.fill();
  // Assert
  assert.equal(first, 4, 'at most `max` nodes per fill call');
  assert.equal(readyAfterFirst, false);
  assert.equal(rest, 5, 'the remaining 9 - 4');
  assert.equal(pool.ready(), true);
  assert.equal(ctx.nodes.length - before, 9);
  assert.equal(pool.fill(), 0, 'a full pool creates nothing');
  assert.deepEqual(POOL_KINDS, ['gain', 'biquad', 'panner']);
  assert.equal(ctx.count('gain'), SIZES.gain);
  assert.equal(ctx.count('biquad'), SIZES.biquad);
  assert.equal(ctx.count('panner'), SIZES.panner);
});

test('nodePool_acquireReleaseAcquire_reusesNodes_noNewCreation', () => {
  // Arrange
  const ctx = new FakeAudioContext();
  const pool = createNodePool(ctx, SIZES);
  pool.fill();
  const bus = ctx.createGain();
  const created = ctx.nodes.length;
  // Act: a voice that takes the whole pool (6 gains + 2 filters + 1 panner), released, then another one
  const take = () => [...Array.from({ length: 6 }, () => pool.gain()), pool.biquad(), pool.biquad(), pool.panner()];
  const first = take();
  for (const n of first) n.connect(bus);
  for (const n of first) pool.release(n);
  const second = take();
  // Assert
  assert.equal(ctx.nodes.length, created, 'no node created after warm-up');
  assert.deepEqual(new Set(second), new Set(first), 'the same nodes come back (rotating order)');
  assert.ok(first.every((n) => n.outputs.length === 0), 'release disconnects');
  const st = pool.stats();
  assert.equal(st.gain.busy, 6);
  assert.equal(st.gain.overflow, 0);
  // a partial cycle rotates: the nodes released longest ago are reused before fresh ones are needed
  for (const n of second) pool.release(n);
  const a = pool.gain();
  pool.release(a);
  assert.notEqual(pool.gain(), a, 'the cursor moves on; the just-released node waits its turn');
});

test('nodePool_release_cancelsAutomationFromFreeAt_andHoldsDefaults', () => {
  // Arrange
  const ctx = new FakeAudioContext();
  const pool = createNodePool(ctx, SIZES);
  pool.fill();
  ctx.currentTime = 2;
  const g = pool.gain();
  g.gain.setValueAtTime(0.0001, 2);
  g.gain.exponentialRampToValueAtTime(0.5, 2.001);
  g.gain.setTargetAtTime(0.0001, 2.02, 0.05);
  const f = pool.biquad();
  f.frequency.setValueAtTime(900, 2);
  f.Q.value = 2;
  const p = pool.panner();
  p.pan.value = 0.4;
  // Act: a stolen voice fades for 20 ms, so the nodes are free at 2.02
  pool.release(g, 2.02);
  pool.release(f, 2.02);
  pool.release(p, 2.02);
  // Assert: cancel-and-hold at freeAt, defaults restored there
  assert.deepEqual(g.gain.events.slice(-2), [['cancel', 2.02], ['set', 1, 2.02]]);
  assert.deepEqual(f.frequency.events.slice(-2), [['cancel', 2.02], ['set', 350, 2.02]]);
  assert.deepEqual(f.Q.events.slice(-2), [['cancel', 2.02], ['set', 1, 2.02]]);
  assert.deepEqual(f.detune.events.slice(-2), [['cancel', 2.02], ['set', 0, 2.02]]);
  assert.deepEqual(p.pan.events.slice(-2), [['cancel', 2.02], ['set', 0, 2.02]]);
  // a release time in the past is clamped to now
  const g2 = pool.gain();
  pool.release(g2, 1);
  assert.deepEqual(g2.gain.events.slice(-1), [['set', 1, 2]]);
});

test('nodePool_nodeStillFading_isNotHandedOutBeforeFreeAt_overflowCoversIt', () => {
  // Arrange: a 1-panner pool, the panner released with a fade still running
  const ctx = new FakeAudioContext();
  const pool = createNodePool(ctx, { panner: 1 });
  pool.fill();
  ctx.currentTime = 1;
  const p = pool.panner();
  pool.release(p, 1.02);
  // Act
  const early = pool.panner(); // at t = 1: the pooled one is still fading
  ctx.currentTime = 1.02;
  pool.release(early); // overflow node: dropped
  const late = pool.panner();
  // Assert
  assert.notEqual(early, p, 'the fading node stays out of circulation');
  assert.equal(late, p, 'free once the clock passed freeAt');
  const st = pool.stats().panner;
  assert.equal(st.overflow, 1);
  assert.equal(st.overflowLive, 0, 'the overflow node was released');
  assert.equal(st.built, 1, 'overflow never grows the pool');
});

test('nodePool_zeroSizeKind_alwaysOverflows_andDisposeForgetsEverything', () => {
  const ctx = new FakeAudioContext();
  const pool = createNodePool(ctx, { gain: 2 });
  pool.fill();
  const b = pool.biquad();
  assert.equal(pool.stats().biquad.overflow, 1, 'an unpooled kind is created fresh');
  const bus = ctx.createGain();
  b.connect(bus);
  pool.release(b);
  assert.deepEqual(b.outputs, [], 'overflow release still disconnects');
  const g = pool.gain();
  g.connect(bus);
  pool.dispose();
  assert.deepEqual(g.outputs, []);
  assert.equal(pool.ready(), false);
  assert.equal(pool.stats().gain.built, 0);
});

test('waveWarmer_oneTypePerStep_assignsEachWaveOnce_inOrder', () => {
  // Arrange
  const ctx = new FakeAudioContext();
  const warmer = createWaveWarmer(ctx, ['triangle', 'sawtooth']);
  // Act
  const a = warmer.step();
  const doneAfterOne = warmer.done();
  const b = warmer.step();
  const c = warmer.step();
  // Assert
  assert.equal(a, 'triangle');
  assert.equal(doneAfterOne, false);
  assert.equal(b, 'sawtooth');
  assert.equal(c, '', 'nothing left');
  assert.equal(warmer.done(), true);
  assert.equal(warmer.pending(), 0);
  const oscs = ctx.nodes.filter((n) => n.kind === 'osc');
  assert.deepEqual(oscs.map((o) => o.type), ['triangle', 'sawtooth'], 'one oscillator per type, type assigned');
  assert.ok(oscs.every((o) => o.startAt === undefined && o.outputs.length === 0), 'never started, never connected');
  assert.deepEqual(OSCILLATOR_WAVES, ['sine', 'triangle', 'sawtooth', 'square']);
  assert.equal(createWaveWarmer(ctx).pending(), 4, 'default: every spec wave');
});

test('collectOscillatorWaves_walksLayersAndFallbacks_specOrder_noDuplicates', () => {
  const tree = {
    hit: { tin: [{ type: 'sample', bank: 'x', fallback: [{ type: 'tone', wave: 'sawtooth' }, { type: 'noise' }] }, { type: 'partials' }] },
    jump: [{ type: 'tone', wave: 'triangle' }, { type: 'tone', wave: 'triangle' }, { type: 'tone', wave: 'sine' }],
    note: 'a comment, not a layer',
  };
  assert.deepEqual(collectOscillatorWaves(tree), ['sine', 'triangle', 'sawtooth']);
  assert.deepEqual(collectOscillatorWaves({ a: [{ type: 'noise' }] }), [], 'partials and noise use no oscillator type table');
});
