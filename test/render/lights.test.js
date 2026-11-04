// Game-feel audit LF-F13 / LF-F17: the default light rig, the shadow caster hook and the shadow flags.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDefaultLightRig, configureShadowCaster, setShadowFlag, SHADOW_DEFAULTS } from '../../src/render/lights.js';
import { FAKE_LOOK, fakeRenderer } from '../fixtures/fake-renderer.js';

test('defaultRig_addsFillKeyFrontRim_inThatOrder_withTheInjectedValues', () => {
  const scene = new THREE.Scene();
  const rig = createDefaultLightRig(scene, { lighting: FAKE_LOOK.lighting });
  assert.deepEqual(scene.children.map((l) => l.type), ['HemisphereLight', 'DirectionalLight', 'DirectionalLight', 'DirectionalLight']);
  assert.deepEqual(scene.children, rig.lights);
  assert.equal(rig.key.intensity, FAKE_LOOK.lighting.key.intensity);
  assert.deepEqual(rig.rim.position.toArray(), [...FAKE_LOOK.lighting.rim.position]);
  assert.equal(rig.fill.groundColor.getHex(), FAKE_LOOK.lighting.fill.ground);
  assert.doesNotThrow(() => { rig.update(0.016, { ko: true }); rig.setMood('ko'); });
});

test('defaultRig_dispose_removesAndFreesEveryLight_idempotent', () => {
  const scene = new THREE.Scene();
  const rig = createDefaultLightRig(scene, { lighting: FAKE_LOOK.lighting });
  const disposed = [];
  for (const l of rig.lights) {
    const orig = l.dispose.bind(l);
    l.dispose = () => { disposed.push(l.type); orig(); };
  }
  rig.dispose();
  assert.equal(scene.children.length, 0);
  assert.deepEqual(disposed, ['HemisphereLight', 'DirectionalLight', 'DirectionalLight', 'DirectionalLight']);
  assert.doesNotThrow(() => rig.dispose(), 'idempotent');
  assert.equal(rig.key.parent, null);
});

test('configureShadowCaster_enablesRendererMap_setsLightShadow_andRestores', () => {
  const renderer = fakeRenderer();
  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight();
  scene.add(light);
  const h = configureShadowCaster(renderer, light, scene, { mapSize: 512, bias: -0.001, normalBias: 0.03, radius: 2, frustum: 3, type: 'vsm' });
  assert.equal(renderer.shadowMap.enabled, true);
  assert.equal(renderer.shadowMap.type, THREE.VSMShadowMap);
  assert.equal(light.castShadow, true);
  assert.deepEqual(light.shadow.mapSize.toArray(), [512, 512]);
  assert.equal(light.shadow.bias, -0.001);
  assert.equal(light.shadow.normalBias, 0.03);
  assert.equal(light.shadow.radius, 2);
  assert.deepEqual([light.shadow.camera.left, light.shadow.camera.right, light.shadow.camera.top, light.shadow.camera.bottom], [-3, 3, 3, -3]);
  assert.equal(light.target.parent, scene, 'target added so the caster can be aimed');
  h.restore();
  assert.equal(renderer.shadowMap.enabled, false);
  assert.equal(renderer.shadowMap.type, THREE.PCFShadowMap);
});

test('configureShadowCaster_defaults_usePcfShadowMap_notTheDeprecatedSoftVariant', () => {
  const renderer = fakeRenderer();
  const light = new THREE.DirectionalLight();
  configureShadowCaster(renderer, light, new THREE.Scene());
  assert.equal(SHADOW_DEFAULTS.type, 'pcf');
  assert.equal(renderer.shadowMap.type, THREE.PCFShadowMap);
  assert.deepEqual(light.shadow.mapSize.toArray(), [SHADOW_DEFAULTS.mapSize, SHADOW_DEFAULTS.mapSize]);
});

test('setShadowFlag_marksEveryMeshUnderRoot_andOnlyMeshes', () => {
  const root = new THREE.Group();
  const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const inner = new THREE.Group();
  const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  inner.add(b);
  root.add(a, inner);
  setShadowFlag(root, 'castShadow', true);
  assert.deepEqual([a.castShadow, b.castShadow, inner.castShadow], [true, true, false]);
  setShadowFlag(root, 'castShadow', false);
  assert.deepEqual([a.castShadow, b.castShadow], [false, false]);
});
