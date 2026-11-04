// Offline sample-bank renderer (engine tools/audio; ADR-0005). Takes a recipe module, renders every
// clip variant deterministically with dsp.mjs (seed = hash(bank:id) + variant), writes PCM WAV to a
// scratch folder, encodes with ffmpeg (AAC in .m4a by default; .wav kept for tiny one-shots when a
// recipe says `format: 'wav'`) and writes a manifest the engine's createSampleBank reads:
//   { version, renderer, sample_rate, bank, rendered_at, total_bytes, clips: { id: { files, gain_db,
//     loop, group, seconds, channels, recipe, seed, params, peak_dbfs, rms_dbfs, centroid_hz,
//     bands_pct, bytes } } }
// Loops: a recipe with `loop: { bars, barSeconds }` (or `loop: { seconds }`) renders the loop body plus
// one roll of pre-roll (a copy of the body's tail) and one roll of post-roll (a copy of its head), so
// AAC encoder priming and decoder trimming differences cannot expose the seam; the manifest's
// sample-exact `loop.start/end` point at the body. Usage:
//   node tools/audio/render-bank.mjs <recipes.mjs> <outDir> [--only id,id] [--wav-only]
// The recipe module exports `BANK = { name, sampleRate, format, bitrateKbps, stereoBitrateKbps }` and
// `RECIPES = [{ id, group, variants, seconds, channels, loop?, peakDb?, rmsDb?, params?, render(dsp, rng, variant, params) -> Float64Array | Float64Array[] }]`.
import { mkdirSync, writeFileSync, rmSync, statSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as dsp from './dsp.mjs';

export const RENDERER_VERSION = '1.0.0';

/** Pick the best AAC encoder ffmpeg offers (AudioToolbox on macOS, else the native one). */
export function aacEncoder(ffmpeg = 'ffmpeg') {
  try {
    const list = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (/\baac_at\b/.test(list)) return 'aac_at';
    if (/\blibfdk_aac\b/.test(list)) return 'libfdk_aac';
  } catch { /* fall through */ }
  return 'aac';
}

/**
 * Render one recipe variant to channel arrays (normalised). Pure given (recipe, variant, bank).
 * @returns {{chs: Float64Array[], sr: number, seed: number, loop: {start: number, end: number} | null}}
 */
export function renderVariant(recipe, variant, bank) {
  const sr = recipe.sampleRate ?? bank.sampleRate ?? 48000;
  const seed = (dsp.hash32(`${bank.name}:${recipe.id}`) + variant * 7919 + (bank.seedBase ?? 0)) >>> 0;
  const r = dsp.rng(seed);
  let out = recipe.render(dsp, r, variant, recipe.params ?? {}, sr);
  let chs = Array.isArray(out) && out[0] instanceof Float64Array ? out : [out];
  if (recipe.channels === 2 && chs.length === 1) chs = [chs[0], Float64Array.from(chs[0])];
  let loop = null;
  if (recipe.loop) {
    const body = recipe.loop.seconds ?? recipe.loop.bars * recipe.loop.barSeconds;
    const roll = recipe.loop.rollSeconds ?? Math.min(body, recipe.loop.barSeconds ?? 1);
    const nb = dsp.sec(body, sr);
    const nr = dsp.sec(roll, sr);
    chs = chs.map((c) => {
      const b = c.subarray(0, nb);
      const o = new Float64Array(nr + nb + nr);
      o.set(b.subarray(nb - nr), 0); // pre-roll = tail of the body
      o.set(b, nr);
      o.set(b.subarray(0, nr), nr + nb); // post-roll = head of the body
      return o;
    });
    loop = { start: nr / sr, end: (nr + nb) / sr };
  }
  if (recipe.rmsDb !== undefined) dsp.normalizeRms(chs, recipe.rmsDb);
  else dsp.normalizePeak(chs, recipe.peakDb ?? -1);
  return { chs, sr, seed, loop };
}

function encode(wavPath, outPath, { codec, kbps, sr, ffmpeg }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-c:a', codec, '-b:a', `${kbps}k`, '-ar', String(sr)];
  if (codec === 'aac') args.push('-aac_coder', 'twoloop');
  args.push('-movflags', '+faststart', outPath);
  execFileSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

/**
 * Render a whole bank.
 * @param {{BANK: object, RECIPES: object[]}} mod the recipe module
 * @param {string} outDir where the encoded files + manifest.json go
 * @param {{only?: string[], wavOnly?: boolean, ffmpeg?: string, scratch?: string, log?: (s: string) => void}} [o]
 * @returns {object} the manifest
 */
export function renderBank(mod, outDir, { only = [], wavOnly = false, ffmpeg = 'ffmpeg', scratch = join(outDir, '.render'), log = console.log } = {}) {
  const { BANK, RECIPES } = mod;
  mkdirSync(outDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const codec = wavOnly ? null : aacEncoder(ffmpeg);
  const manifest = {
    version: 1, renderer: `render-bank ${RENDERER_VERSION}`, bank: BANK.name, sample_rate: BANK.sampleRate ?? 48000,
    rendered_at: new Date().toISOString().slice(0, 10), encoder: codec ?? 'pcm', total_bytes: 0, clips: {},
  };
  // A partial render (--only) merges into the existing manifest instead of replacing it.
  if (only.length && existsSync(join(outDir, 'manifest.json'))) {
    try { manifest.clips = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')).clips ?? {}; } catch { manifest.clips = {}; }
  }
  for (const recipe of RECIPES) {
    if (only.length && !only.includes(recipe.id)) continue;
    const files = [];
    let bytes = 0;
    let meta = null;
    for (let v = 0; v < (recipe.variants ?? 1); v++) {
      const { chs, sr, seed, loop } = renderVariant(recipe, v, BANK);
      const stem = recipe.variants > 1 ? `${recipe.id}_${String(v + 1).padStart(2, '0')}` : recipe.id;
      const wav = join(scratch, `${stem}.wav`);
      writeFileSync(wav, dsp.wavBytes(chs, sr, 24));
      const fmt = wavOnly ? 'wav' : (recipe.format ?? BANK.format ?? 'm4a');
      let file = `${stem}.${fmt}`;
      if (fmt === 'wav') writeFileSync(join(outDir, file), dsp.wavBytes(chs, sr, 16));
      else encode(wav, join(outDir, file), { codec, kbps: recipe.kbps ?? (chs.length === 2 ? BANK.stereoBitrateKbps ?? 112 : BANK.bitrateKbps ?? 64), sr, ffmpeg });
      const size = statSync(join(outDir, file)).size;
      bytes += size;
      files.push(file);
      if (v === 0) {
        const mono = chs.length === 2 ? chs[0].map((x, i) => 0.5 * (x + chs[1][i])) : chs[0];
        const sp = dsp.spectrum(mono, sr, recipe.loop ? 1.0 : 0.15);
        meta = {
          seconds: Math.round((chs[0].length / sr) * 1000) / 1000, channels: chs.length, sample_rate: sr, seed, loop,
          peak_dbfs: Math.round(dsp.gainToDb(dsp.peak(mono)) * 100) / 100, rms_dbfs: Math.round(dsp.gainToDb(dsp.rms(mono)) * 100) / 100,
          centroid_hz: Math.round(sp.centroidHz), bands_pct: sp.bandsPct.map((x) => Math.round(x * 10) / 10), flatness: Math.round(sp.flatness * 1e4) / 1e4,
        };
      }
      log(`${file}  ${(size / 1024).toFixed(1)} KB  seed ${seed}`);
    }
    manifest.clips[recipe.id] = {
      files, gain_db: recipe.gainDb ?? 0, loop: meta.loop, group: recipe.group ?? 'default',
      recipe: recipe.id, params: recipe.params ?? {}, ...meta, bytes,
    };
  }
  manifest.total_bytes = Object.values(manifest.clips).reduce((s, c) => s + (c.bytes ?? 0), 0);
  // remove encoded files no longer in the manifest (stale ids)
  if (!only.length) {
    const keep = new Set(Object.values(manifest.clips).flatMap((c) => c.files));
    for (const f of readdirSync(outDir)) if (/\.(m4a|mp3|wav|ogg)$/.test(f) && !keep.has(f)) rmSync(join(outDir, f));
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  rmSync(scratch, { recursive: true, force: true });
  log(`bank ${BANK.name}: ${Object.keys(manifest.clips).length} clips, ${(manifest.total_bytes / 1048576).toFixed(2)} MB`);
  return manifest;
}

if (process.argv[1] && basename(process.argv[1]) === 'render-bank.mjs') {
  const [recipesPath, outDir, ...rest] = process.argv.slice(2);
  if (!recipesPath || !outDir) {
    console.error('usage: node render-bank.mjs <recipes.mjs> <outDir> [--only id,id] [--wav-only]');
    process.exit(2);
  }
  const mod = await import(pathToFileURL(resolve(recipesPath)).href);
  const onlyIdx = rest.indexOf('--only');
  renderBank(mod, resolve(outDir), { only: onlyIdx >= 0 ? rest[onlyIdx + 1].split(',') : [], wavOnly: rest.includes('--wav-only') });
}
