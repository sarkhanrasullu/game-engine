// Game-feel audit hooks on createScene (F5, KD-10, LF-F13, LF-F16, LF-F17): every hook off by
// default, each wired when its option is given. Headless: fake renderer and window (test/fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FAKE_LOOK, fakeContainer, fakeFighters, fakeRenderer, installFakeWindow } from '../fixtures/fake-renderer.js';

installFakeWindow();
const { createScene } = await import('../../src/render/scene.js');
const { createDefaultLightRig } = await import('../../src/render/lights.js');

const SPECS = [{ id: 'a' }, { id: 'b' }];
const build = (extra = {}, renderer = fakeRenderer()) => ({ view: createScene(fakeContainer(), SPECS, { ...FAKE_LOOK, renderer, reducedMotion: false, ...extra }), renderer });
const lightTypes = (scene) => scene.children.filter((o) => o.isLight).map((o) => o.type);
/** The camera's world right vector (y stays 0 without roll). */
const right = (camera) => new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);

test('defaults_builtInRig_noShadows_noGrade_noRoll', () => {
  const { view, renderer } = build({ bloomCapable: true, tier: { name: 'high', pixelRatio: 2, bloom: true } });
  assert.deepEqual(lightTypes(view.scene), ['HemisphereLight', 'DirectionalLight', 'DirectionalLight', 'DirectionalLight']);
  assert.equal(view.lights.key.intensity, FAKE_LOOK.lighting.key.intensity);
  assert.equal(renderer.shadowMap.enabled, false);
  assert.equal(view.shadowsActive(), false);
  assert.equal(view.scene.children.some((o) => o.isLight && o.castShadow), false);
  assert.equal(view.post.grade, null);
  assert.equal(view.gradeActive(), false);
  const [f1, f2] = fakeFighters();
  view.prewarm(f1, f2, null);
  view.onEvent({ type: 'hit', fx: 'heavy', shake: 1, defender: 1 });
  view.render(f1, f2, 0.5, null, 0.016);
  assert.ok(Math.abs(right(view.camera).y) < 1e-9, 'no roll applied on the default path (camera right stays level)');
  view.setShadowCaster(view.views[0].root);
  assert.equal(view.views[0].flashMesh.castShadow, false, 'caster flags are a no-op while shadows are off');
  view.dispose();
  assert.equal(view.scene.children.length, 0);
});

test('lightsFactory_replacesTheRig_receivesLightingAndTier_updateGetsRenderState_disposeCalled', () => {
  const seen = { args: null, updates: [], disposed: 0, moods: [] };
  const tier = { name: 'medium', pixelRatio: 1.5, bloom: false };
  const lights = (scene, o) => {
    seen.args = o;
    const rig = createDefaultLightRig(scene, { lighting: o.lighting });
    const extra = new THREE.DirectionalLight(0xff7a30, 2);
    scene.add(extra);
    return {
      ...rig,
      extra,
      update(dt, state) { seen.updates.push([dt, state]); },
      setMood(name) { seen.moods.push(name); },
      dispose() { seen.disposed++; scene.remove(extra); extra.dispose(); rig.dispose(); },
    };
  };
  const { view } = build({ lights, tier });
  assert.equal(seen.args.lighting, FAKE_LOOK.lighting);
  assert.equal(seen.args.tier, tier);
  assert.equal(lightTypes(view.scene).length, 5, 'four built-in lights plus the factory\'s extra');
  const [f1, f2] = fakeFighters();
  const state = { ko: true, hitstop: false, meters: [0.5, 0.2] };
  view.render(f1, f2, 0, null, 0.016, state);
  view.render(f1, f2, 0.5, null, 0.016);
  assert.deepEqual(seen.updates, [[0.016, state], [0.016, null]], 'state passes through untouched; null when omitted');
  view.lights.setMood('ko');
  assert.deepEqual(seen.moods, ['ko']);
  view.dispose();
  assert.equal(seen.disposed, 1);
  assert.equal(view.scene.children.length, 0);
});

test('shadows_enabledWithKeyCaster_configuresRendererAndKey_flagsMeshes_followsMidpoint_restoresOnDispose', () => {
  const { view, renderer } = build({ shadows: { enabled: true, mapSize: 512, frustum: 3 }, tier: { name: 'high', pixelRatio: 2, bloom: false, shadows: true } });
  assert.equal(view.shadowsActive(), true);
  assert.equal(renderer.shadowMap.enabled, true);
  assert.equal(renderer.shadowMap.type, THREE.PCFShadowMap);
  assert.equal(view.lights.key.castShadow, true);
  assert.deepEqual(view.lights.key.shadow.mapSize.toArray(), [512, 512]);
  assert.equal(view.lights.front.castShadow, false, 'one caster only');
  view.setShadowCaster(view.views[0].root);
  view.setShadowReceiver(view.stage.floor);
  assert.equal(view.views[0].flashMesh.castShadow, true);
  assert.equal(view.stage.floor.receiveShadow, true);
  view.setShadowCaster(view.views[0].root, false);
  assert.equal(view.views[0].flashMesh.castShadow, false);
  const f = [{ x: 1, z: 2 }, { x: 3, z: 4 }];
  view.render(f[0], f[1], 0, null, 0.016);
  assert.deepEqual(view.lights.key.target.position.toArray().map((v) => +v.toFixed(3)), [2, 0.05, 3]);
  assert.deepEqual(view.lights.key.position.toArray(), [2.6, 10, 4.5], 'midpoint + default offset');
  view.dispose();
  assert.equal(renderer.shadowMap.enabled, false, 'renderer flags restored for the next view');
});

test('shadows_tierFlagFalse_vetoes_andEnabledFalseIsOff', () => {
  const a = build({ shadows: { enabled: true }, tier: { name: 'medium', pixelRatio: 1.5, bloom: false, shadows: false } });
  assert.equal(a.view.shadowsActive(), false);
  assert.equal(a.renderer.shadowMap.enabled, false);
  a.view.dispose();
  const b = build({ shadows: { enabled: false, mapSize: 2048 } });
  assert.equal(b.view.shadowsActive(), false);
  assert.equal(b.view.lights.key.castShadow, false);
  b.view.dispose();
});

test('shadows_ownCaster_addsAShadowOnlyLight_andRemovesItOnDispose', () => {
  const { view, renderer } = build({ shadows: { enabled: true, caster: 'own', offset: [0, 8, 0] } });
  const extra = view.scene.children.filter((o) => o.isDirectionalLight && o.castShadow);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].intensity, 0, 'casts shadows, adds no light');
  assert.deepEqual(extra[0].position.toArray(), [0, 8, 0]);
  assert.equal(view.lights.key.castShadow, false);
  view.dispose();
  assert.equal(view.scene.children.length, 0);
  assert.equal(renderer.shadowMap.enabled, false);
});

test('shadows_missingNamedCaster_fallsBackToOwnLight', () => {
  const lights = (scene, { lighting }) => {
    const rig = createDefaultLightRig(scene, { lighting });
    return { fill: rig.fill, lights: rig.lights, dispose: rig.dispose }; // no `key`
  };
  const { view } = build({ lights, shadows: { enabled: true, caster: 'key' } });
  assert.equal(view.scene.children.filter((o) => o.isDirectionalLight && o.castShadow).length, 1);
  view.dispose();
});

test('grade_params_onBloomPath_addPass_gatedByTier_toggledBySetQualityTier', () => {
  const { view } = build({ bloomCapable: true, tier: { name: 'high', pixelRatio: 2, bloom: true, grade: true }, grade: { saturation: 1.05 } });
  assert.equal(view.post.composer.passes.length, 4);
  assert.equal(view.gradeActive(), true);
  view.setQualityTier({ name: 'high', pixelRatio: 2, bloom: true, grade: false });
  assert.equal(view.gradeActive(), false, 'the tier flag turns the pass off at runtime');
  view.setQualityTier({ name: 'medium', pixelRatio: 1.5, bloom: false, grade: true });
  assert.equal(view.gradeActive(), false, 'no composer path, no grade');
  view.setQualityTier({ name: 'high', pixelRatio: 2, bloom: true, grade: true });
  assert.equal(view.gradeActive(), true);
  view.dispose();
});

test('grade_tierResolvedFalse_startsOff_andGradeOmitted_isNoPass', () => {
  const off = build({ bloomCapable: true, tier: { name: 'high', pixelRatio: 2, bloom: true, grade: false }, grade: { saturation: 1.05 } });
  assert.equal(off.view.post.composer.passes.length, 4, 'pass exists so the governor can turn it on');
  assert.equal(off.view.gradeActive(), false);
  off.view.dispose();
  const none = build({ bloomCapable: true, tier: { name: 'high', pixelRatio: 2, bloom: true, grade: true } });
  assert.equal(none.view.post.composer.passes.length, 3);
  assert.equal(none.view.gradeActive(), false);
  none.view.dispose();
});

test('impulseRoll_rotatesTheCameraAboutItsViewAxis_onlyWhileLive', () => {
  const { view } = build();
  const [f1, f2] = fakeFighters();
  view.render(f1, f2, 0, null, 0.016);
  const fwd0 = view.camera.getWorldDirection(new THREE.Vector3());
  assert.ok(Math.abs(right(view.camera).y) < 1e-9);
  view.director.impulse({ strength: 0.05, ms: 200, roll: 2 });
  view.render(f1, f2, 0, null, 0.001);
  const fwd1 = view.camera.getWorldDirection(new THREE.Vector3());
  assert.ok(fwd1.angleTo(fwd0) < 0.02, 'view direction barely moves (translation only)');
  assert.ok(Math.abs(right(view.camera).y) > 0.02, 'camera rolled about its view axis');
  for (let i = 0; i < 20; i++) view.render(f1, f2, 0, null, 0.016);
  assert.ok(Math.abs(right(view.camera).y) < 1e-9, 'roll returns to zero after the impulse');
  view.dispose();
});
