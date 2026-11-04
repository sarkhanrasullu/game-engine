// Vite asset plugin (tools/vite-hero-assets.mjs): the file table is built from injected sets and the
// plugin's dev middleware / emit behaviour follow the options. No Vite instance needed: the hooks
// are plain functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heroAssetFiles, heroAssetsPlugin } from '../../tools/vite-hero-assets.mjs';
import { writeGlb } from '../../tools/hero-lite.mjs';

const imagelessGlb = () => writeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }] }, new Uint8Array([1, 2, 3, 4]));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-vite-assets-'));
  const chars = join(dir, 'chars'); const basis = join(dir, 'basis');
  mkdirSync(chars); mkdirSync(basis);
  writeFileSync(join(chars, 'one.glb'), imagelessGlb());
  writeFileSync(join(chars, 'manifest.json'), JSON.stringify({ assets: [{ id: 'one', file: 'one.glb' }] }));
  writeFileSync(join(basis, 'basis_transcoder.js'), 'var BASIS = 1;');
  writeFileSync(join(basis, 'basis_transcoder.wasm'), new Uint8Array(4));
  writeFileSync(join(basis, 'README.md'), 'not served');
  return { dir, opts: { sets: [{ dir: chars, prefix: 'chars' }], basisDir: basis } };
}

test('heroAssetFiles_injectedSets_servesFullLiteManifestAndTranscoderOnly', () => {
  // Arrange
  const { dir, opts } = fixture();
  try {
    // Act
    const files = heroAssetFiles(opts);
    // Assert
    assert.deepEqual([...files.keys()].sort(), ['basis/basis_transcoder.js', 'basis/basis_transcoder.wasm', 'chars/manifest.json', 'chars/one.glb', 'chars/one.lite.glb']);
    const m = JSON.parse(files.get('chars/manifest.json').toString());
    assert.deepEqual(m.assets[0].lite, { file: 'one.lite.glb', bytes: files.get('chars/one.lite.glb').length, maxMap: 1024 });
    assert.throws(() => heroAssetFiles({ sets: opts.sets }), /basisDir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('heroAssetsPlugin_middlewareAndEmit_followPrefixesAndEmitOption', async () => {
  // Arrange
  const { dir, opts } = fixture();
  try {
    const plugin = heroAssetsPlugin(opts);
    let handler = null;
    plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
    const request = (url) => new Promise((done) => {
      const headers = {};
      handler({ url }, { setHeader: (k, v) => { headers[k] = v; }, end: (body) => done({ hit: true, headers, body }) }, () => done({ hit: false }));
    });
    // Act
    const glb = await request('/app/chars/one.lite.glb?v=1');
    const wasm = await request('/basis/basis_transcoder.wasm');
    const miss = await request('/other/one.glb');
    const emitted = [];
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f.fileName) });
    const silent = [];
    heroAssetsPlugin({ ...opts, emit: false }).generateBundle.call({ emitFile: (f) => silent.push(f.fileName) });
    // Assert
    assert.equal(glb.hit, true);
    assert.equal(glb.headers['Content-Type'], 'model/gltf-binary');
    assert.equal(wasm.headers['Content-Type'], 'application/wasm');
    assert.equal(miss.hit, false, 'unknown prefix falls through');
    assert.equal(emitted.length, 5);
    assert.deepEqual(silent, [], 'emit: false emits nothing');
    // KTX2Loader's default transcoder URLs are blanked; other modules are left alone.
    const src = "a = new URL('../libs/basis/basis_transcoder.wasm', import.meta.url).toString();";
    assert.equal(plugin.transform(src, '/x/KTX2Loader.js').code, "a = '';");
    assert.equal(plugin.transform(src, '/x/Other.js'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
