// Runtime glTF hero (engine /assets, ADR-0003 §Key Interfaces): manifest validation, tier -> LOD / file,
// loadHeroAsset validation and bind-space LODs, the createRig joint contract, the never-rejecting store
// and the inline (single-file artifact) source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { heroFileForTier, lodForTier, parseHeroManifest } from '../../src/assets/manifest.js';
import { HERO_JOINTS, loadHeroAsset, toBindSpace } from '../../src/assets/hero-asset.js';
import { createHeroAssetStore, createInlineSource } from '../../src/assets/hero-asset-store.js';
import { HERO_CFG, heroGlb, heroManifestJson, nodeGltfLoader } from '../fixtures/gltf-fixture.js';

// ---- manifest + tiers (pure)

test('manifest: a broken manifest throws and names every problem', () => {
  // Arrange
  const bad = { schema: 2, assets: [{ id: 'x', file: 'x.gltf', lods: [], maps: [{ name: 'a', codec: 'png' }] }, { file: 'y.glb' }] };
  // Act / Assert
  assert.throws(() => parseHeroManifest(bad), (e) => /schema 2/.test(e.message) && /\.glb/.test(e.message)
    && /no lods/.test(e.message) && /codec png/.test(e.message) && /missing id/.test(e.message));
});

test('tiers: high/medium/low draw LOD 0/1/2; a missing level clamps down; lite file only on lite tiers', () => {
  // Arrange
  const entry = { file: 'h.glb', lite: { file: 'h.lite.glb' }, lods: [{ level: 0 }, { level: 1 }] };
  // Act / Assert
  assert.equal(lodForTier(entry, 'high', HERO_CFG), 0);
  assert.equal(lodForTier(entry, 'medium', HERO_CFG), 1);
  assert.equal(lodForTier(entry, 'low', HERO_CFG), 1);
  assert.deepEqual(heroFileForTier(entry, 'high', HERO_CFG), { file: 'h.glb', lite: false });
  assert.deepEqual(heroFileForTier(entry, 'low', HERO_CFG), { file: 'h.lite.glb', lite: true });
  assert.deepEqual(heroFileForTier({ ...entry, lite: null }, 'low', HERO_CFG), { file: 'h.glb', lite: false });
});

// ---- loadHeroAsset

test('loadHeroAsset: rejects Draco, non-KTX2 images, and a missing loader', async () => {
  // Arrange
  const fake = (json) => ({ parseAsync: async () => ({ parser: { json }, scene: new THREE.Group() }) });
  // Act / Assert
  await assert.rejects(loadHeroAsset(new ArrayBuffer(4), { loader: fake({ extensionsUsed: ['KHR_draco_mesh_compression'] }), cfg: HERO_CFG }), /Draco/);
  await assert.rejects(loadHeroAsset(new ArrayBuffer(4), { loader: fake({ images: [{ name: 'a', mimeType: 'image/png' }] }), cfg: HERO_CFG }), /not KTX2/);
  await assert.rejects(loadHeroAsset(new ArrayBuffer(4), { cfg: HERO_CFG }), /no glTF loader/);
  await assert.rejects(loadHeroAsset(new ArrayBuffer(4), { loader: fake({}), cfg: HERO_CFG }), /no skinned mesh/);
});

test('loadHeroAsset: a skinned GLB yields bind-space LODs (float positions, clampDir renamed), KTX2 maps, the tier LOD', async () => {
  // Arrange
  const bytes = heroGlb({ lods: [0, 1], suit: true, clamp: true, emissive: true });
  // Act
  const asset = await loadHeroAsset(bytes, { tier: 'medium', loader: nodeGltfLoader(), id: 'hero-a', cfg: HERO_CFG });
  // Assert
  assert.deepEqual(asset.warnings, []);
  assert.deepEqual([...asset.lods.keys()], [0, 1]);
  for (const level of [0, 1]) {
    const lod = asset.lods.get(level);
    assert.ok(lod.armour && lod.suit, `lod${level}`);
    assert.equal(lod.armour.tris, 1);
    assert.equal(lod.armour.hasClamp, true);
    assert.ok(lod.armour.geometry.getAttribute('clampDir'), 'clampDir renamed from _clampdir');
    assert.equal(lod.armour.geometry.getAttribute('position').array.constructor, Float32Array);
    assert.deepEqual(lod.armour.boneNames, [...HERO_JOINTS]);
  }
  for (const k of ['map', 'orm', 'normal', 'emissive']) assert.equal(asset.textures[k].isCompressedTexture, true, k);
  assert.equal(asset.skinned.armour.name, 'armour_lod1', 'medium tier -> LOD 1');
  assert.deepEqual(asset.look, HERO_CFG.looks['hero-a']);
  // Dispose frees the shared maps and bind-space geometry.
  let freed = 0;
  asset.lods.get(0).armour.geometry.addEventListener('dispose', () => freed++);
  asset.textures.map.addEventListener('dispose', () => freed++);
  asset.dispose();
  assert.equal(freed, 2);
});

test('joint contract: a skin missing a createRig joint, or with a foreign joint, is rejected', () => {
  // Arrange
  const skin = (names) => {
    const bones = names.map((n) => Object.assign(new THREE.Bone(), { name: n }));
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
    m.name = 'armour_lod0';
    m.bind(new THREE.Skeleton(bones), new THREE.Matrix4());
    return m;
  };
  // Act / Assert
  assert.equal(HERO_JOINTS.length, 18);
  assert.throws(() => toBindSpace(skin(HERO_JOINTS.filter((n) => n !== 'key'))), /lacks joint key/);
  assert.throws(() => toBindSpace(skin([...HERO_JOINTS, 'tail'])), /tail is not a createRig joint/);
});

// ---- asset store: fetch, inline, failure -> null

test('store: loads a hero through injected fetch + loader, records bytes and timings', async () => {
  // Arrange
  const files = { 'heroes/manifest.json': new TextEncoder().encode(JSON.stringify(heroManifestJson())).buffer, 'heroes/hero-a.glb': heroGlb({ lods: [0, 1] }) };
  let t = 0;
  const store = createHeroAssetStore({
    cfg: HERO_CFG, fighters: ['fighter-a'], fetchBytes: async (u) => files[u], now: () => (t += 5), log: () => {},
    createLoader: async () => ({ loader: nodeGltfLoader(), dispose() {} }),
  });
  // Act
  await store.preload({ tier: 'high', renderer: null });
  // Assert
  assert.ok(store.get('fighter-a'));
  assert.equal(store.get('fighter-b'), null);
  assert.equal(store.version, 1);
  assert.equal(store.stats[0].ok, true);
  assert.equal(store.stats[0].bytes, files['heroes/hero-a.glb'].byteLength);
  assert.ok(store.stats[0].decodeMs > 0 && store.stats[0].fetchMs > 0);
});

test('store: a missing file, a broken glb or no manifest never rejects and leaves the fighter procedural', async () => {
  // Arrange
  const manifest = new TextEncoder().encode(JSON.stringify(heroManifestJson())).buffer;
  const loader = async () => ({ loader: nodeGltfLoader(), dispose() {} });
  const cases = [
    async (u) => { if (u.endsWith('manifest.json')) return manifest; throw new Error('HTTP 404'); },
    async (u) => (u.endsWith('manifest.json') ? manifest : new ArrayBuffer(64)),
    async () => { throw new Error('offline'); },
  ];
  for (const fetchBytes of cases) {
    const store = createHeroAssetStore({ cfg: HERO_CFG, fighters: ['fighter-a'], fetchBytes, createLoader: loader, log: () => {} });
    // Act
    await store.preload({ tier: 'high', renderer: null });
    // Assert
    assert.equal(store.get('fighter-a'), null);
    assert.equal(store.version, 0);
    assert.ok(store.stats.some((s) => !s.ok && s.error));
  }
});

test('store: whenReady is bounded (false while a load is pending, at once when nothing started)', async () => {
  // Arrange
  const store = createHeroAssetStore({ cfg: HERO_CFG, fighters: ['fighter-a'], fetchBytes: () => new Promise(() => {}), log: () => {} });
  // Act
  const idle = await store.whenReady(1000);
  store.preload({ tier: 'high', renderer: null });
  const late = await store.whenReady(20);
  // Assert
  assert.equal(idle, false);
  assert.equal(late, false);
});

// ---- 0.5.1 heroes on demand: one download lane, front-of-queue load(), per-hero wait, byte progress

/** Two-hero manifest / file table, with fetches that resolve only when the test releases them. */
function gatedFiles() {
  const manifest = heroManifestJson();
  manifest.assets.push({ ...manifest.assets[0], id: 'hero-b', file: 'hero-b.glb', bytes: 64 });
  const files = {
    'heroes/manifest.json': new TextEncoder().encode(JSON.stringify(manifest)).buffer,
    'heroes/hero-a.glb': heroGlb({ lods: [0] }),
    'heroes/hero-b.glb': heroGlb({ lods: [0] }),
  };
  const order = [];
  const gates = new Map();
  const fetchBytes = (u, onBytes) => new Promise((resolve) => {
    order.push(u);
    if (u.endsWith('manifest.json')) return resolve(files[u]);
    gates.set(u, () => {
      if (onBytes) { onBytes(10, 100); onBytes(100, 100); }
      resolve(files[u]);
    });
  });
  const release = async (u) => { while (!gates.has(u)) await new Promise((r) => setTimeout(r, 0)); gates.get(u)(); gates.delete(u); };
  return { files, order, fetchBytes, release };
}
const twoHeroCfg = { ...HERO_CFG, fighters: { ...HERO_CFG.fighters, 'fighter-b': { asset: 'hero-b' } } };

test('store: load() downloads one hero at a time, a later load() of the visible hero jumps the queue, the manifest is fetched once', async () => {
  // Arrange
  const { order, fetchBytes, release } = gatedFiles();
  const store = createHeroAssetStore({ cfg: twoHeroCfg, fighters: ['fighter-a', 'fighter-b'], fetchBytes, log: () => {}, createLoader: async () => ({ loader: nodeGltfLoader(), dispose() {} }) });
  // Act: preload queues a then b; the player swipes to b before anything downloaded
  const all = store.preload({ tier: 'high', renderer: null });
  const b = store.load('fighter-b');
  assert.equal(store.status('fighter-b'), 'loading');
  await release('heroes/hero-b.glb');
  const assetB = await b;
  // Assert: b came first and alone; a follows; the manifest went over the wire once
  assert.ok(assetB && store.get('fighter-b') === assetB);
  assert.equal(store.get('fighter-a'), null, 'a has not downloaded while b was in the lane');
  assert.deepEqual(order, ['heroes/manifest.json', 'heroes/hero-b.glb']);
  await release('heroes/hero-a.glb');
  await all;
  assert.ok(store.get('fighter-a'));
  assert.equal(order.filter((u) => u.endsWith('manifest.json')).length, 1);
  assert.equal(store.version, 2);
  assert.equal(store.status('fighter-a'), 'ok');
});

test('store: whenLoaded() is bounded per hero; status() reports idle / loading / ok / failed; an unknown slot settles null', async () => {
  // Arrange
  const { fetchBytes, release } = gatedFiles();
  const store = createHeroAssetStore({ cfg: twoHeroCfg, fighters: ['fighter-a'], fetchBytes, log: () => {}, createLoader: async () => ({ loader: nodeGltfLoader(), dispose() {} }) });
  // Act / Assert
  assert.equal(store.status('fighter-a'), 'idle');
  assert.equal(await store.whenLoaded('fighter-a', 10), false, 'never asked: nothing to wait for');
  const p = store.load('fighter-a', { tier: 'high', renderer: null });
  assert.equal(await store.whenLoaded('fighter-a', 10), false, 'still downloading after 10 ms');
  await release('heroes/hero-a.glb');
  await p;
  assert.equal(await store.whenLoaded('fighter-a', 10), true);
  assert.equal(store.status('fighter-a'), 'ok');
  // fighter-b is not in this session's fighter list: procedural, settled at once, never fetched
  assert.equal(await store.load('fighter-b'), null);
  assert.equal(store.status('fighter-b'), 'failed');
});

test('store: onProgress reports streamed bytes per hero id (manifest bytes as the total when the response has none)', async () => {
  // Arrange
  const { fetchBytes, release } = gatedFiles();
  const seen = [];
  const store = createHeroAssetStore({
    cfg: twoHeroCfg, fighters: ['fighter-b'], fetchBytes, log: () => {}, onProgress: (p) => seen.push({ ...p }),
    createLoader: async () => ({ loader: nodeGltfLoader(), dispose() {} }),
  });
  // Act
  const p = store.load('fighter-b', { tier: 'high', renderer: null });
  await release('heroes/hero-b.glb');
  await p;
  // Assert: the two streamed chunks (total from the fake response) then the final byte count
  assert.deepEqual(seen.slice(0, 2), [{ id: 'fighter-b', loaded: 10, total: 100 }, { id: 'fighter-b', loaded: 100, total: 100 }]);
  assert.equal(seen[2].id, 'fighter-b');
  assert.equal(seen[2].loaded, seen[2].total);
  assert.ok(seen[2].loaded > 100, 'final report carries the real byte length');
});

test('store: whenLoaded() without a bound subscribes to a queued hero WITHOUT moving it to the front', async () => {
  // Arrange: a queued in config order, b behind it; a host subscribes to every slot (the regression: subscribing
  // with load() made the last-subscribed hero download first).
  const { order, fetchBytes, release } = gatedFiles();
  const store = createHeroAssetStore({ cfg: twoHeroCfg, fighters: ['fighter-a', 'fighter-b'], fetchBytes, log: () => {}, createLoader: async () => ({ loader: nodeGltfLoader(), dispose() {} }) });
  store.preload({ tier: 'high', renderer: null });
  const subs = [store.whenLoaded('fighter-a'), store.whenLoaded('fighter-b')];
  // Act
  await release('heroes/hero-a.glb');
  await release('heroes/hero-b.glb');
  // Assert: a still went first; both subscriptions resolve true
  assert.deepEqual(order.slice(1), ['heroes/hero-a.glb', 'heroes/hero-b.glb']);
  assert.deepEqual(await Promise.all(subs), [true, true]);
});

test('store: load({ lite: true }) downloads the lite file on a full tier when the manifest lists one', async () => {
  // Arrange
  const manifest = heroManifestJson();
  manifest.assets[0].lite = { file: 'hero-a.lite.glb' };
  const files = { 'heroes/manifest.json': new TextEncoder().encode(JSON.stringify(manifest)).buffer, 'heroes/hero-a.glb': heroGlb({ lods: [0] }), 'heroes/hero-a.lite.glb': heroGlb({ lods: [0] }) };
  const order = [];
  const store = createHeroAssetStore({ cfg: HERO_CFG, fighters: ['fighter-a'], log: () => {}, fetchBytes: async (u) => { order.push(u); return files[u]; }, createLoader: async () => ({ loader: nodeGltfLoader(), dispose() {} }) });
  // Act
  await store.load('fighter-a', { tier: 'high', renderer: null, lite: true });
  // Assert
  assert.ok(store.get('fighter-a'));
  assert.equal(store.stats.at(-1).file, 'hero-a.lite.glb');
  assert.ok(order.includes('heroes/hero-a.lite.glb') && !order.includes('heroes/hero-a.glb'));
});

test('store: a streamed fetch without Content-Length falls back to the manifest bytes as the total', async () => {
  // Arrange: a fetch that reports chunks with total 0 (unknown length)
  const manifest = heroManifestJson();
  manifest.assets[0].bytes = 4096;
  const files = { 'heroes/manifest.json': new TextEncoder().encode(JSON.stringify(manifest)).buffer, 'heroes/hero-a.glb': heroGlb({ lods: [0] }) };
  const seen = [];
  const store = createHeroAssetStore({
    cfg: HERO_CFG, fighters: ['fighter-a'], log: () => {}, onProgress: (p) => seen.push(p.total),
    fetchBytes: async (u, onBytes) => { if (onBytes) onBytes(7, 0); return files[u]; },
    createLoader: async () => ({ loader: nodeGltfLoader(), dispose() {} }),
  });
  // Act
  await store.load('fighter-a', { tier: 'high', renderer: null });
  // Assert
  assert.equal(seen[0], 4096);
});

test('inline source: artifact table entries decode to bytes and map to blob: URLs for the transcoder', async () => {
  // Arrange
  const src = createInlineSource({ 'basis/basis_transcoder.js': { type: 'text', data: 'x=1' }, 'heroes/a.glb': { type: 'base64', data: 'AAEC' } });
  // Act
  const bytes = new Uint8Array(await src.fetchBytes('heroes/a.glb'));
  const url = src.urlModifier('basis/basis_transcoder.js');
  // Assert
  assert.deepEqual([...bytes], [0, 1, 2]);
  assert.match(url, /^blob:/);
  assert.equal(src.urlModifier('other.js'), 'other.js');
  await assert.rejects(src.fetchBytes('heroes/missing.glb'), /not found/);
});
