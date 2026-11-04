// Stage manifest reader + tier choice (engine /assets, ADR-0003 §Key Interfaces).
import test from 'node:test';
import assert from 'node:assert/strict';
import { stageEntry, stageChoice } from '../../src/assets/stage-manifest.js';
import { STAGE_CFG, stageManifestJson } from '../fixtures/stage-fixtures.js';

const CFG = STAGE_CFG;

test('stageEntry_parsesStageManifest_lodsSortedMapsKtx2', () => {
  // Arrange
  const json = stageManifestJson();
  json.assets[0].lods.reverse();
  // Act
  const e = stageEntry(json, CFG.id);
  // Assert
  assert.deepEqual(e.lods.map((l) => l.level), [0, 1, 2]);
  assert.ok(e.maps.every((m) => m.codec === 'etc1s'));
  assert.equal(e.lite, null);
});

test('stageEntry_rejectsWrongKind_missingId_badSchema', () => {
  // Arrange
  const m = stageManifestJson();
  // Act / Assert
  assert.throws(() => stageEntry({ ...m, kind: 'hero' }, CFG.id), /kind/);
  assert.throws(() => stageEntry(m, 'other_stage'), /no entry/);
  assert.throws(() => stageEntry({ ...m, schema: 2 }, CFG.id), /schema/);
  assert.throws(() => stageEntry(null, CFG.id), /kind/);
  assert.throws(() => stageEntry({ ...m, assets: [{ ...m.assets[0], kind: 'hero' }] }, CFG.id), /kind hero/);
});

test('stageChoice_tierPicksLodAndLiteFile', () => {
  // Arrange
  const e = stageEntry(stageManifestJson(), CFG.id);
  const withLite = { ...e, lite: { file: 'arena.lite.glb' } };
  // Act / Assert
  assert.deepEqual(stageChoice(withLite, 'high', CFG), { level: 0, file: 'arena.glb', lite: false });
  assert.deepEqual(stageChoice(withLite, 'medium', CFG), { level: 1, file: 'arena.lite.glb', lite: true });
  assert.deepEqual(stageChoice(withLite, 'low', CFG), { level: 2, file: 'arena.lite.glb', lite: true });
  // Artifact (inline): lite even on high, LOD still by tier.
  assert.deepEqual(stageChoice(withLite, 'high', CFG, true), { level: 0, file: 'arena.lite.glb', lite: true });
  // No lite listed: the full file on every tier; unknown tier -> LOD 0.
  assert.deepEqual(stageChoice(e, 'low', CFG), { level: 2, file: 'arena.glb', lite: false });
  assert.equal(stageChoice(e, 'ultra', CFG).level, 0);
});
