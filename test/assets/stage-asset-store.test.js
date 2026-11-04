// Stage store (engine /assets): never rejects; any failure leaves get() null (fallback stage). Tier -> file/LOD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageAssetStore } from '../../src/assets/stage-asset-store.js';
import { STAGE_CFG, stageManifestJson } from '../fixtures/stage-fixtures.js';

const enc = (o) => new TextEncoder().encode(JSON.stringify(o)).buffer;

async function store({ manifest, loaderError = null, assetError = null, bakeError = null, inline = null, enabled } = {}) {
  const m = manifest === undefined ? { ...stageManifestJson() } : manifest;
  if (m && m.assets) m.assets = m.assets.map((a) => ({ ...a, lite: { file: 'arena.lite.glb', bytes: 1, maxMap: 1024 } }));
  const fetched = [];
  const calls = { bake: 0, loaderDisposed: 0, assetDisposed: 0, envDisposed: 0, levels: null };
  const s = createStageAssetStore({
    cfg: STAGE_CFG,
    enabled,
    inline,
    log: () => {},
    fetchBytes: async (url) => {
      fetched.push(url);
      if (url.endsWith('manifest.json')) {
        if (m === null) throw new Error('HTTP 404');
        return enc(m);
      }
      return new ArrayBuffer(16);
    },
    createLoader: async () => {
      if (loaderError) throw loaderError;
      return { loader: {}, dispose: () => calls.loaderDisposed++ };
    },
    loadAsset: async (bytes, o) => {
      calls.levels = o.levels;
      if (assetError) throw assetError;
      return { draws: (l) => (l < 2 ? 5 : 3), dispose: () => calls.assetDisposed++ };
    },
    bakeEnv: () => {
      calls.bake++;
      if (bakeError) throw bakeError;
      return { texture: { isTexture: true }, dispose: () => calls.envDisposed++ };
    },
  });
  return { s, fetched, calls };
}

test('stageStore_high_loadsFullFile_lod0_bakesEnv', async () => {
  const { s, fetched, calls } = await store();
  await s.preload({ tier: 'high', renderer: {} });
  assert.ok(s.get());
  assert.equal(s.level, 0);
  assert.ok(fetched.includes('stage/arena.glb'));
  assert.deepEqual(calls.levels, [0, 1, 2]);
  assert.equal(calls.bake, 1);
  assert.ok(s.env().isTexture);
  assert.equal(s.version, 1);
  assert.equal(s.stats[0].draws, 5);
  assert.equal(calls.loaderDisposed, 1, 'transcoder workers released after the load');
});

test('stageStore_mediumLow_loadLiteFile_withTierLod', async () => {
  for (const [tier, level, draws] of [['medium', 1, 5], ['low', 2, 3]]) {
    const { s, fetched } = await store();
    await s.preload({ tier, renderer: {} });
    assert.equal(s.level, level);
    assert.ok(fetched.includes('stage/arena.lite.glb'), tier);
    assert.equal(s.stats[0].draws, draws);
  }
});

test('stageStore_failures_fallBack_neverReject', async () => {
  const cases = [
    { manifest: null, err: /404/ },
    { manifest: { schema: 1, kind: 'hero', assets: [] }, err: /kind/ },
    { loaderError: new Error('no wasm'), err: /wasm/ },
    { assetError: new Error('stage: LOD 2 missing'), err: /LOD 2/ },
  ];
  for (const c of cases) {
    const { s, calls } = await store(c);
    await s.preload({ tier: 'high', renderer: {} });
    assert.equal(s.get(), null);
    assert.equal(s.env(), null);
    assert.equal(s.version, 0);
    assert.match(s.stats[0].error, c.err);
    assert.equal(calls.bake, 0);
  }
});

test('stageStore_bakeFailure_keepsStage_proceduralEnv', async () => {
  const { s } = await store({ bakeError: new Error('no half float') });
  await s.preload({ tier: 'high', renderer: {} });
  assert.ok(s.get());
  assert.equal(s.env(), null);
});

test('stageStore_disabled_and_whenReady', async () => {
  const { s, fetched } = await store({ enabled: false });
  assert.equal(await s.whenReady(10), false, 'not started');
  await s.preload({ tier: 'high', renderer: {} });
  assert.equal(fetched.length, 0);
  assert.equal(s.get(), null);
  assert.equal(await s.whenReady(10), true);
});

test('stageStore_dispose_freesAssetAndEnv_once', async () => {
  const { s, calls } = await store();
  await s.preload({ tier: 'high', renderer: {} });
  s.preload({ tier: 'low', renderer: {} }); // second call is a no-op
  s.dispose();
  s.dispose();
  assert.equal(calls.assetDisposed, 1);
  assert.equal(calls.envDisposed, 1);
  assert.equal(s.get(), null);
  assert.equal(s.env(), null);
});
