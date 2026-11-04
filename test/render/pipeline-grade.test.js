// Game-feel audit LF-F16: the optional colour-grade pass on the composer path. Default off: the pass
// chain is RenderPass -> UnrealBloomPass -> OutputPass exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeroComposer, createGradePass, applyGrade, GRADE_DEFAULTS } from '../../src/render/pipeline.js';
import { fakeRenderer } from '../fixtures/fake-renderer.js';
import * as THREE from 'three';

const passTypes = (post) => post.composer.passes.map((p) => p.constructor.name);

test('composer_withoutGrade_hasThreePasses_andNoGradeHandle', () => {
  const post = createHeroComposer(fakeRenderer(), new THREE.Scene(), new THREE.PerspectiveCamera());
  assert.deepEqual(passTypes(post), ['RenderPass', 'UnrealBloomPass', 'OutputPass']);
  assert.equal(post.grade, null);
  assert.doesNotThrow(() => { post.setGrade({ saturation: 2 }); post.setGradeEnabled(false); });
  post.dispose();
});

test('composer_withGrade_appendsTheGradePassAfterOutput_andTogglesIt', () => {
  const post = createHeroComposer(fakeRenderer(), new THREE.Scene(), new THREE.PerspectiveCamera(), undefined, { saturation: 1.05 });
  assert.deepEqual(passTypes(post), ['RenderPass', 'UnrealBloomPass', 'OutputPass', 'ShaderPass']);
  assert.equal(post.grade.uniforms.uSaturation.value, 1.05);
  assert.equal(post.grade.enabled, true);
  post.setGradeEnabled(false);
  assert.equal(post.grade.enabled, false);
  post.setGradeEnabled(true);
  post.setGrade({ gain: [1.1, 1, 0.9] });
  assert.deepEqual(post.grade.uniforms.uGain.value.toArray(), [1.1, 1, 0.9]);
  assert.equal(post.grade.uniforms.uSaturation.value, 1, 'setGrade resets unspecified keys to the neutral defaults');
  post.dispose();
});

test('gradePass_neutralDefaults_mapToIdentityUniforms', () => {
  const pass = createGradePass();
  const u = pass.uniforms;
  assert.deepEqual(u.uLift.value.toArray(), [0, 0, 0]);
  assert.deepEqual(u.uInvGamma.value.toArray(), [1, 1, 1]);
  assert.deepEqual(u.uGain.value.toArray(), [1, 1, 1]);
  assert.equal(u.uSaturation.value, 1);
  assert.equal(u.uVignette.value.x, 0, 'vignette strength 0');
  assert.equal(GRADE_DEFAULTS.vignette.strength, 0);
  assert.match(pass.material.fragmentShader, /tDiffuse/);
  assert.equal(pass.textureID, 'tDiffuse');
});

test('applyGrade_writesEveryParameter_invertsGamma_allocationFree', () => {
  const pass = createGradePass();
  const before = [pass.uniforms.uLift.value, pass.uniforms.uInvGamma.value, pass.uniforms.uGain.value, pass.uniforms.uVignette.value];
  applyGrade(pass, { lift: [0.015, 0.008, 0.006], gamma: [2, 1, 0.5], gain: [1.02, 1, 0.98], saturation: 1.1, vignette: { strength: 0.3, radius: 0.6, softness: 0.4 } });
  const u = pass.uniforms;
  assert.deepEqual(u.uLift.value.toArray(), [0.015, 0.008, 0.006]);
  assert.deepEqual(u.uInvGamma.value.toArray(), [0.5, 1, 2]);
  assert.deepEqual(u.uGain.value.toArray(), [1.02, 1, 0.98]);
  assert.equal(u.uSaturation.value, 1.1);
  assert.deepEqual(u.uVignette.value.toArray(), [0.3, 0.6, 0.4]);
  assert.deepEqual([u.uLift.value, u.uInvGamma.value, u.uGain.value, u.uVignette.value], before, 'same Vector3 instances, mutated in place');
});

test('twoGradePasses_doNotShareUniformVectors', () => {
  const a = createGradePass({ saturation: 1.2 });
  const b = createGradePass();
  applyGrade(b, { lift: [0.1, 0.1, 0.1] });
  assert.deepEqual(a.uniforms.uLift.value.toArray(), [0, 0, 0]);
  assert.equal(b.uniforms.uSaturation.value, 1);
});

test('composer_dispose_freesBloomOutputAndGradePasses', () => {
  const post = createHeroComposer(fakeRenderer(), new THREE.Scene(), new THREE.PerspectiveCamera(), undefined, { saturation: 1 });
  let freed = 0;
  post.bloom.renderTargetBright.addEventListener('dispose', () => freed++);
  post.grade.material.addEventListener('dispose', () => freed++);
  post.composer.passes[2].material.addEventListener('dispose', () => freed++);
  post.dispose();
  assert.equal(freed, 3);
});
