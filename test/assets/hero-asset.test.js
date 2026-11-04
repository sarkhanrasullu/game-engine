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
