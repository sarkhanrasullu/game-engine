// blender/rig-contract.mjs (ADR-0001 joint names + ADR-0003 §Key Interfaces): the pure checks a consumer
// runs on its skinned exports, exercised here on a synthetic rig.json + glTF chunk built from createRig
// (test/fixtures/rig-fixture.js), so no Blender and no game asset is needed. Moved from the consumer
// with the pipeline (ADR-0004 A9.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glbSkinViolations, rigViolations, JOINT_NAME } from '../../blender/rig-contract.mjs';
import { FIXTURE_BIND_POSE, FIXTURE_ENTRY, expectedFromCreateRig, glbJsonFixture, rigJsonFixture } from '../fixtures/rig-fixture.js';

test('rigContract_fixtureRigAndGlb_holdAtBaseline', () => {
  // Arrange
  const rig = rigJsonFixture();
  const json = glbJsonFixture(rig);
  const expected = expectedFromCreateRig(FIXTURE_ENTRY, FIXTURE_BIND_POSE);
  // Act / Assert
  assert.equal(rig.joints.length, 18);
  assert.deepEqual(rigViolations(rig, expected), []);
  assert.deepEqual(glbSkinViolations(json, rig), []);
  for (const j of rig.joints) assert.match(j.name, JOINT_NAME);
});

test('rigContract_checksCatch_renamedReparentedAndMovedJoints', () => {
  // Arrange
  const rig = rigJsonFixture();
  const json = glbJsonFixture(rig);
  const expected = expectedFromCreateRig(rig.proportions, rig.bindPose);
  const renamed = structuredClone(rig);
  renamed.joints[4].name = 'arm.L';
  const reparented = structuredClone(rig);
  reparented.joints.find((j) => j.name === 'handL').parent = 'armL';
  const moved = structuredClone(rig);
  moved.joints.find((j) => j.name === 'kneeR').translation[1] -= 0.01;
  const rotated = structuredClone(rig);
  rotated.joints.find((j) => j.name === 'armL').rotation = [0, 0, 0, 1];
  const extra = structuredClone(rig);
  extra.extraBones = ['ik_target'];
  const glbRenamed = structuredClone(json);
  glbRenamed.nodes[glbRenamed.skins[0].joints[0]].name = 'Bone';
  const glbMoved = structuredClone(json);
  glbMoved.nodes[glbMoved.skins[0].joints[2]].translation[1] += 0.02;
  const glbScaled = structuredClone(json);
  glbScaled.nodes[glbScaled.skins[0].joints[1]].scale = [1, 1.5, 1];
  const glbTwoRigs = structuredClone(json);
  glbTwoRigs.skins.push({ joints: [...json.skins[0].joints].reverse() });
  // Act / Assert
  assert.ok(rigViolations(renamed, expected).some((v) => v.includes('joint names')));
  assert.ok(rigViolations(renamed, expected).some((v) => v.includes('[A-Za-z0-9_]')));
  assert.ok(rigViolations(reparented, expected).some((v) => v.startsWith('handL: parent')));
  assert.ok(rigViolations(moved, expected).some((v) => v.startsWith('kneeR: rest offset')));
  assert.ok(rigViolations(rotated, expected).some((v) => v.startsWith('armL: bind rotation')));
  assert.ok(rigViolations(extra, expected).some((v) => v.startsWith('extra bones')));
  assert.ok(glbSkinViolations(glbRenamed, rig).some((v) => v.startsWith('skin joints')));
  assert.ok(glbSkinViolations(glbMoved, rig).some((v) => v.startsWith('glb torso: translation')));
  assert.ok(glbSkinViolations(glbScaled, rig).some((v) => v.includes('scaled joint')));
  assert.ok(glbSkinViolations(glbTwoRigs, rig).some((v) => v.includes('more than one rig')));
  assert.deepEqual(glbSkinViolations({ nodes: [] }, rig), ['no skin']);
});

test('rigContract_quaternionSign_isNotAViolation', () => {
  // Arrange: q and -q are the same rotation; an exporter may write either.
  const rig = rigJsonFixture();
  const expected = expectedFromCreateRig(rig.proportions, rig.bindPose);
  const flipped = structuredClone(rig);
  const armL = flipped.joints.find((j) => j.name === 'armL');
  armL.rotation = armL.rotation.map((x) => -x);
  const json = glbJsonFixture(flipped);
  // Act / Assert
  assert.deepEqual(rigViolations(flipped, expected), []);
  assert.deepEqual(glbSkinViolations(json, rig), []);
});
