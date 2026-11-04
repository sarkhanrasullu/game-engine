// Stage asset core (engine /assets, ADR-0003 §Pipeline 2): validation of a stage export against the
// injected contract, LOD groups, draws / tris, shared resources and dispose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStageAsset } from '../../src/assets/stage-asset.js';
import { ARENA_CONTRACT, fakeStageGltf, fakeLoader, loadArenaAsset } from '../fixtures/stage-fixtures.js';

const load = (o, levels = [0, 1, 2]) => loadArenaAsset(new ArrayBuffer(8), { loader: fakeLoader(fakeStageGltf(o)), levels });

test('loadStageAsset_rejectsBadExports', async () => {
  await assert.rejects(load({ images: ['image/png'] }), /not KTX2/);
  await assert.rejects(load({ levels: [0, 1] }), /LOD 2 missing/);
  await assert.rejects(load({ badMaterial: true }), /unknown material/);
  await assert.rejects(load({ plainMap: true }), /not KTX2/);
  await assert.rejects(loadArenaAsset(new ArrayBuffer(8), { loader: fakeLoader(null, new Error('meshopt decode')) }), /meshopt/);
  await assert.rejects(loadArenaAsset(new ArrayBuffer(8), {}), /no glTF loader/);
  await assert.rejects(loadStageAsset(new ArrayBuffer(8), { loader: fakeLoader(fakeStageGltf()) }), /nodePattern/);
  const draco = { scene: fakeStageGltf().scene, parser: { json: { extensionsUsed: ['KHR_draco_mesh_compression'] } } };
  await assert.rejects(loadArenaAsset(new ArrayBuffer(8), { loader: fakeLoader(draco) }), /Draco/);
});

test('loadStageAsset_buildsLods_injectedContract_drawsTrisDispose', async () => {
  // Arrange
  const gltf = fakeStageGltf();
  // Act
  const a = await loadArenaAsset(new ArrayBuffer(8), { loader: fakeLoader(gltf), levels: [0, 1, 2] });
  // Assert: LOD groups keyed by the injected group kinds, missing kinds null, nodes detached from the glTF scene.
  assert.deepEqual([...a.lods.keys()].sort(), [0, 1, 2]);
  assert.deepEqual(Object.keys(a.lods.get(0)), [...ARENA_CONTRACT.groups]);
  assert.equal(a.lods.get(2).fx, null);
  assert.equal(a.lods.get(2).embers, null);
  assert.equal(gltf.scene.children.length, 0, 'every contract node leaves the glTF scene');
  assert.deepEqual([0, 1, 2].map(a.draws), [5, 5, 3]);
  assert.deepEqual([0, 1, 2].map(a.tris), [6, 6, 6], 'main group only: 3 planes x 2 tris');
  assert.equal(a.draws(7), 0);
  // The glTF materials are replaced by the runtime set and freed.
  const used = new Set();
  for (const l of a.lods.values()) for (const n of Object.values(l)) n?.traverse((o) => o.isMesh && used.add(o.material));
  for (const m of used) assert.ok(Object.values(a.materials).includes(m), `${m.name} is a runtime material`);
  assert.equal(a.materials.ar_sky.fog, false);
  assert.deepEqual(a.uniforms, { uTime: { value: 0 }, uPulse: { value: 1 }, uGain: { value: 1 } });
  // dispose frees every geometry, map and runtime material once.
  let freed = 0;
  const shared = new Set();
  for (const l of a.lods.values()) for (const n of Object.values(l)) n?.traverse((o) => { if (o.isMesh) { shared.add(o.geometry); shared.add(o.material); } });
  for (const r of shared) r.addEventListener('dispose', () => freed++);
  let mapsFreed = 0;
  gltf.mats.ar_near.map.addEventListener('dispose', () => mapsFreed++);
  a.dispose();
  assert.equal(freed, shared.size);
  assert.equal(mapsFreed, 1);
});
