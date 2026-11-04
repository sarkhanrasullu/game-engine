// Offline bank renderer + DSP kernels (engine tools/audio, ADR-0005): determinism, loop rolls,
// manifest shape (wav-only so the test needs no ffmpeg), and kernel sanity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as dsp from '../../tools/audio/dsp.mjs';
import { renderVariant, renderBank } from '../../tools/audio/render-bank.mjs';

const SR = 8000;

function recipes() {
  return {
    BANK: { name: 'test-bank', sampleRate: SR, format: 'wav' },
    RECIPES: [
      {
        id: 'impact', group: 'fight', variants: 3, seconds: 0.2, peakDb: -1,
        render(d, r, v, p, sr) {
          const modes = d.plateModes({ f0: 220, ratios: [1, 1.47, 2.09], count: 8, t60: 0.1, rng: r });
          const body = d.modalBody({ sr, seconds: 0.2, modes, excitation: d.contactPulse({ sr, ms: 1.5 }) });
          return d.mixInto(body, d.noiseBurst({ sr, seconds: 0.05, t60: 0.02, rng: r, filter: { type: 'bandpass', fc: 1500, q: 1 } }), 0, sr, 0.5);
        },
      },
      {
        id: 'loop', group: 'music', variants: 1, seconds: 0.5, channels: 2, rmsDb: -18, loop: { bars: 2, barSeconds: 0.25 },
        render(d, r, v, p, sr) {
          const L = d.tone({ sr, seconds: 0.5, wave: 'sine', f0: 200 });
          return [L, d.scale(Float64Array.from(L), 0.5)];
        },
      },
    ],
  };
}

test('renderVariant_isDeterministicPerSeed_andVariantsDiffer', () => {
  const mod = recipes();
  const a = renderVariant(mod.RECIPES[0], 0, mod.BANK);
  const b = renderVariant(mod.RECIPES[0], 0, mod.BANK);
  const c = renderVariant(mod.RECIPES[0], 1, mod.BANK);
  assert.equal(a.seed, b.seed);
  assert.deepEqual(Array.from(a.chs[0]), Array.from(b.chs[0]));
  assert.notEqual(a.seed, c.seed);
  assert.notDeepEqual(Array.from(a.chs[0].slice(0, 200)), Array.from(c.chs[0].slice(0, 200)));
  assert.ok(Math.abs(dsp.gainToDb(dsp.peak(a.chs[0])) + 1) < 0.01, 'peak-normalised to -1 dBFS');
  assert.equal(a.loop, null);
});

test('renderVariant_loop_addsPreAndPostRollAndSampleExactLoopPoints', () => {
  const mod = recipes();
  const { chs, loop, sr } = renderVariant(mod.RECIPES[1], 0, mod.BANK);
  assert.equal(chs.length, 2);
  const body = 0.5; const roll = 0.25;
  assert.deepEqual(loop, { start: roll, end: roll + body });
  assert.equal(chs[0].length, dsp.sec(body + 2 * roll, sr));
  const nr = dsp.sec(roll, sr); const nb = dsp.sec(body, sr);
  // pre-roll equals the body's tail, post-roll equals the body's head
  for (let i = 0; i < 50; i++) {
    assert.ok(Math.abs(chs[0][i] - chs[0][nb + i]) < 1e-12, 'pre-roll = tail');
    assert.ok(Math.abs(chs[0][nr + nb + i] - chs[0][nr + i]) < 1e-12, 'post-roll = head');
  }
  const r = Math.sqrt((dsp.rms(chs[0]) ** 2 + dsp.rms(chs[1]) ** 2) / 2);
  assert.ok(Math.abs(dsp.gainToDb(r) + 18) < 0.05, 'RMS-normalised loop');
});

test('renderBank_wavOnly_writesFilesAndManifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-'));
  try {
    const m = renderBank(recipes(), dir, { wavOnly: true, log: () => {} });
    assert.deepEqual(m.clips.impact.files, ['impact_01.wav', 'impact_02.wav', 'impact_03.wav']);
    assert.deepEqual(m.clips.loop.files, ['loop.wav']);
    assert.deepEqual(m.clips.loop.loop, { start: 0.25, end: 0.75 });
    assert.equal(m.clips.impact.group, 'fight');
    assert.equal(typeof m.clips.impact.seed, 'number');
    assert.equal(m.clips.impact.bands_pct.length, 6);
    assert.ok(m.total_bytes > 0);
    const disk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(disk.clips.impact.bytes, m.clips.impact.bytes);
    for (const f of [...m.clips.impact.files, ...m.clips.loop.files]) assert.ok(existsSync(join(dir, f)), f);
    assert.ok(!existsSync(join(dir, '.render')), 'scratch removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dsp kernels: biquad lowpass attenuates highs, modal body decays, flutter stays positive, loopify keeps length', () => {
  const r = dsp.rng(3);
  const hi = dsp.tone({ sr: SR, seconds: 0.5, f0: 3000 });
  const lo = dsp.tone({ sr: SR, seconds: 0.5, f0: 100 });
  const lp = dsp.biquad('lowpass', 300, 0.7, SR);
  assert.ok(dsp.rms(lp.run(hi), 1000) < dsp.rms(hi, 1000) * 0.05);
  assert.ok(dsp.rms(dsp.biquad('lowpass', 300, 0.7, SR).run(lo), 1000) > dsp.rms(lo, 1000) * 0.8);
  const body = dsp.modalBody({ sr: SR, seconds: 0.5, modes: [{ f: 300, t60: 0.1, amp: 1 }], excitation: dsp.contactPulse({ sr: SR, ms: 1 }) });
  assert.ok(dsp.rms(body, 0, 400) > 10 * dsp.rms(body, 3600, 4000), 't60 decay');
  const fl = dsp.flutter({ sr: SR, seconds: 0.5, rateHz: 9, depth: 0.5, rng: r });
  assert.ok(fl.every((v) => v >= 0));
  assert.ok(Math.abs(fl.reduce((a, b) => a + b, 0) / fl.length - 1) < 0.15, 'unity mean');
  const cr = dsp.crackle({ sr: SR, seconds: 1, rateHz: 40, rng: r });
  assert.ok(dsp.peak(cr) > 0);
  const loop = dsp.loopify(dsp.noise({ sr: SR, seconds: 1, rng: r }), 0.1, SR);
  assert.equal(loop.length, dsp.sec(0.9, SR));
  const sp = dsp.spectrum(dsp.tone({ sr: SR, seconds: 0.2, f0: 1000 }), SR, 0.1);
  assert.ok(Math.abs(sp.centroidHz - 1000) < 60, `centroid ${sp.centroidHz}`);
  assert.ok(sp.flatness < 0.05, 'a sine is not flat');
});
