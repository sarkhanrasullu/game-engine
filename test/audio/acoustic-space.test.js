// Acoustic space + harmonic lift (engine /audio, ADR-0005): procedural IR properties, the convolver
// bus wiring, sends, and the phone-speaker bass guard insert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeImpulseResponse, createAcousticSpace, createSend, createHarmonicLift, makeTanhCurve } from '../../src/audio/acoustic-space.js';
import { FakeAudioContext } from '../fixtures/fake-audio.js';

const energy = (d) => d.reduce((s, v) => s + v * v, 0);

test('makeImpulseResponse_isStereoDecorrelatedUnitEnergyDeterministic', () => {
  const ctx = new FakeAudioContext();
  const ir = makeImpulseResponse(ctx, { seconds: 1.0, predelayMs: 20, seed: 3 });
  assert.equal(ir.numberOfChannels, 2);
  assert.equal(ir.length, ctx.sampleRate);
  const L = ir.getChannelData(0);
  const R = ir.getChannelData(1);
  assert.ok(Math.abs(energy(L) + energy(R) - 1) < 1e-6, 'unit total energy');
  // pre-delay: silent before the first reflection (7 ms) and the tail (20 ms)
  for (let i = 0; i < Math.floor(0.006 * ctx.sampleRate); i++) assert.equal(L[i], 0);
  // decorrelated channels
  let dot = 0;
  for (let i = 0; i < L.length; i++) dot += L[i] * R[i];
  const corr = dot / Math.sqrt(energy(L) * energy(R));
  assert.ok(Math.abs(corr) < 0.3, `L/R correlation ${corr}`);
  // decays: the last 10% holds far less energy than the first 10% after the pre-delay
  const n = L.length;
  const head = energy(L.slice(Math.floor(0.03 * n), Math.floor(0.13 * n)));
  const tail = energy(L.slice(Math.floor(0.9 * n)));
  assert.ok(tail < head * 0.05, 'tail decays');
  const again = makeImpulseResponse(ctx, { seconds: 1.0, predelayMs: 20, seed: 3 });
  assert.deepEqual(Array.from(again.getChannelData(0).slice(0, 2000)), Array.from(L.slice(0, 2000)), 'same seed, same IR');
  const other = makeImpulseResponse(ctx, { seconds: 1.0, predelayMs: 20, seed: 4 });
  assert.notDeepEqual(Array.from(other.getChannelData(0).slice(2000, 2100)), Array.from(L.slice(2000, 2100)));
});

test('createAcousticSpace_wiresInputConvolverReturn_andSends', () => {
  const ctx = new FakeAudioContext();
  const master = ctx.createGain();
  const ir = makeImpulseResponse(ctx, { seconds: 0.2 });
  const space = createAcousticSpace(ctx, { ir, returnDb: -6 });
  space.connect(master);
  assert.equal(space.convolver.normalize, false);
  assert.equal(space.convolver.buffer, ir);
  assert.deepEqual(space.input.outputs, [space.convolver]);
  assert.deepEqual(space.convolver.outputs, [space.output]);
  assert.deepEqual(space.output.outputs, [master]);
  assert.ok(Math.abs(space.output.gain.value - 10 ** (-6 / 20)) < 1e-9);
  const bus = ctx.createGain();
  const send = createSend(ctx, bus, space, -14);
  assert.deepEqual(bus.outputs, [send]);
  assert.deepEqual(send.outputs, [space.input]);
  assert.ok(Math.abs(send.gain.value - 10 ** (-14 / 20)) < 1e-9);
  space.setReturnDb(-12, 60);
  assert.deepEqual(space.output.gain.events.at(-1).slice(0, 2), ['target', 10 ** (-12 / 20)]);
  space.setIr(null);
  assert.equal(space.convolver.buffer, null, 'null IR = bypass on the low tier');
  space.dispose();
  assert.deepEqual(space.output.outputs, []);
});

test('createHarmonicLift_dryUnityPlusShapedBand_fourNodesPerBus', () => {
  const ctx = new FakeAudioContext();
  const before = ctx.nodes.length;
  const lift = createHarmonicLift(ctx, { splitHz: 120, drive: 2.5, bandHz: [180, 360], mixDb: -8 });
  assert.equal(ctx.nodes.length - before, 6, 'input, lowpass, shaper, bandpass, mix, output');
  assert.ok(lift.input.outputs.includes(lift.output), 'dry path');
  const lp = lift.input.outputs.find((n) => n.kind === 'biquad');
  assert.equal(lp.type, 'lowpass');
  assert.equal(lp.frequency.value, 120);
  const shaper = lp.outputs[0];
  assert.equal(shaper.kind, 'shaper');
  assert.equal(shaper.oversample, '2x');
  assert.equal(shaper.curve.length, 1024);
  const bp = shaper.outputs[0];
  assert.equal(bp.type, 'bandpass');
  assert.ok(Math.abs(bp.frequency.value - Math.sqrt(180 * 360)) < 1e-9);
  const mix = bp.outputs[0];
  assert.ok(Math.abs(mix.gain.value - 10 ** (-8 / 20)) < 1e-9);
  assert.deepEqual(mix.outputs, [lift.output]);
  lift.setMixDb(-20);
  assert.ok(Math.abs(mix.gain.value - 10 ** (-20 / 20)) < 1e-9);
});

test('makeTanhCurve_isOddSymmetricAndSaturatesToUnity', () => {
  const c = makeTanhCurve(2.5, 101);
  assert.equal(c[0], -1);
  assert.equal(c[100], 1);
  assert.ok(Math.abs(c[50]) < 1e-6, 'zero at the centre');
  assert.ok(Math.abs(c[70] + c[30]) < 1e-6, 'odd symmetry');
  assert.ok(c[60] > 0.2 / 1, 'drive: small inputs are amplified relative to a straight line');
});
