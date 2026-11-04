// Hero render pipeline (engine /render, ADR-0001 HERO-1, art bible R2-5): the PMREM arena environment baked once per
// renderer from a procedural emissive-panel scene (fighters only; the stage stays Lambert), and the
// high-tier composer (RenderPass into a 4x MSAA half-float target -> UnrealBloomPass -> OutputPass).
// Verified against node_modules/three/src (r187): PMREMGenerator.fromScene(scene, sigma, near, far,
// {size}), EffectComposer(renderer, renderTarget) / setPixelRatio / setSize / render / dispose,
// RenderPass, UnrealBloomPass(resolution, strength, radius, threshold) which halves the buffer for its
// first mip, OutputPass (reads renderer tone mapping + exposure), WebGLRenderTarget {type, samples},
// ShaderPass(shader, textureID) cloning the shader's uniforms, EffectComposer.render marking the last
// enabled pass renderToScreen each frame (a disabled grade pass hands the screen back to OutputPass),
// EffectComposer.dispose freeing its targets and copy pass only (added passes are disposed here).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { QUALITY_CONFIG } from './quality-config.js';

/**
 * Neutral colour grade (output identical to no grade). lift/gamma/gain per channel in display (sRGB)
 * space after tone mapping: out = pow(gain * (c + lift * (1 - c)), 1 / gamma); saturation 1 = as is;
 * vignette strength 0 = none (radius: where the darkening starts, softness: how far it ramps, both in
 * UV distance from the centre).
 */
export const GRADE_DEFAULTS = Object.freeze({
  lift: Object.freeze([0, 0, 0]),
  gamma: Object.freeze([1, 1, 1]),
  gain: Object.freeze([1, 1, 1]),
  saturation: 1,
  vignette: Object.freeze({ strength: 0, radius: 0.7, softness: 0.5 }),
});

/** One full-screen pass: lift/gamma/gain, saturation, radial vignette. ~6 ALU ops and one texture read per pixel. */
const GRADE_SHADER = Object.freeze({
  name: 'EngineGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uInvGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSaturation: { value: 1 },
    uVignette: { value: new THREE.Vector3(0, 0.7, 0.5) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uLift;
    uniform vec3 uInvGamma;
    uniform vec3 uGain;
    uniform float uSaturation;
    uniform vec3 uVignette;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = uGain * (tex.rgb + uLift * (1.0 - tex.rgb));
      c = pow(max(c, vec3(0.0)), uInvGamma);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - uVignette.x * smoothstep(uVignette.y, uVignette.y + uVignette.z, d);
      gl_FragColor = vec4(c, tex.a);
    }`,
});

/**
 * Write grade parameters into a grade pass's uniforms (missing keys keep GRADE_DEFAULTS). Allocation-free.
 * @param {ShaderPass} pass a createGradePass result
 * @param {Partial<typeof GRADE_DEFAULTS>} params
 * @example applyGrade(post.grade, { saturation: 1.05, vignette: { strength: 0.25 } });
 */
export function applyGrade(pass, params) {
  const u = pass.uniforms;
  const p = params ?? GRADE_DEFAULTS;
  const lift = p.lift ?? GRADE_DEFAULTS.lift;
  const gamma = p.gamma ?? GRADE_DEFAULTS.gamma;
  const gain = p.gain ?? GRADE_DEFAULTS.gain;
  const v = p.vignette ?? GRADE_DEFAULTS.vignette;
  u.uLift.value.set(lift[0], lift[1], lift[2]);
  u.uInvGamma.value.set(1 / gamma[0], 1 / gamma[1], 1 / gamma[2]);
  u.uGain.value.set(gain[0], gain[1], gain[2]);
  u.uSaturation.value = p.saturation ?? GRADE_DEFAULTS.saturation;
  u.uVignette.value.set(v.strength ?? GRADE_DEFAULTS.vignette.strength, v.radius ?? GRADE_DEFAULTS.vignette.radius, v.softness ?? GRADE_DEFAULTS.vignette.softness);
}

/**
 * The final colour-grade pass (lift/gamma/gain, saturation, vignette) for the composer path. Place it
 * after OutputPass: it works on display-referred sRGB values. No LUT textures; one fullscreen quad.
 * @param {Partial<typeof GRADE_DEFAULTS>} [params]
 * @returns {ShaderPass}
 * @example const grade = createGradePass({ lift: [0.015, 0.008, 0.006], saturation: 1.05 }); composer.addPass(grade);
 */
export function createGradePass(params = GRADE_DEFAULTS) {
  const pass = new ShaderPass(GRADE_SHADER);
  applyGrade(pass, params);
  return pass;
}

/**
 * Arena environment panels (art bible R2-5). dir = direction from the origin, size = angular width and
 * height in degrees, intensity multiplies the sRGB colour (HDR). Fighters only. These are defaults: a
 * game passes its own panel set to getHeroEnvironment (e.g. a stage tint that swaps `lava` and `kicker`).
 */
export const ENV_PANELS = Object.freeze({
  dome: Object.freeze({ color: '#0a0908' }),
  lava: Object.freeze({ color: '#ff6a1a', intensity: 5, count: 8, elevationDeg: 10, size: Object.freeze([30, 25]), gapDeg: 15 }),
  moon: Object.freeze({ color: '#cfe0ff', intensity: 14, dir: Object.freeze([0.35, 0.6, -0.7]), size: Object.freeze([20, 20]) }),
  softbox: Object.freeze({ color: '#9fb4e0', intensity: 1.2, dir: Object.freeze([0, 1, 0]), size: Object.freeze([70, 70]) }),
  kicker: Object.freeze({ color: '#ffc89a', intensity: 2.5, dir: Object.freeze([-0.6, 0.2, 0.75]), size: Object.freeze([16, 16]) }),
});

const RADIUS = 10;

/** One emissive panel looking at the origin. */
function panel(dir, wDeg, hDeg, hex, intensity) {
  const w = 2 * RADIUS * Math.tan((wDeg * Math.PI) / 360);
  const h = 2 * RADIUS * Math.tan((hDeg * Math.PI) / 360);
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(intensity), side: THREE.DoubleSide, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.copy(dir).normalize().multiplyScalar(RADIUS);
  mesh.lookAt(0, 0, 0);
  return mesh;
}

/**
 * The procedural arena environment scene (source for the PMREM bake; dispose it after the bake).
 * @param {typeof ENV_PANELS} [cfg]
 * @returns {THREE.Scene}
 */
export function createEnvScene(cfg = ENV_PANELS) {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS * 3, 16, 12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.dome.color), side: THREE.BackSide, toneMapped: false }),
  );
  scene.add(dome);
  const lava = cfg.lava;
  const pitch = 360 / lava.count;
  for (let i = 0; i < lava.count; i++) {
    const az = (i * pitch * Math.PI) / 180;
    const el = (lava.elevationDeg * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    scene.add(panel(dir, lava.size[0], lava.size[1], lava.color, lava.intensity));
  }
  for (const k of ['moon', 'softbox', 'kicker']) {
    const c = cfg[k];
    scene.add(panel(new THREE.Vector3(...c.dir), c.size[0], c.size[1], c.color, c.intensity));
  }
  return scene;
}

/** Free every geometry and material of a scene. */
function disposeScene(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

/** @type {WeakMap<THREE.WebGLRenderer, {texture: THREE.Texture, target: THREE.WebGLRenderTarget}>} */
const ENV_CACHE = new WeakMap();

/**
 * The baked PMREM environment of this renderer (built on first use, cached; 256 cube, sigma 0.04).
 * Set it as `envMap` on fighter materials only. The source scene and the generator are disposed after
 * the bake. Single-thread only. The cache is per renderer: the first bake's panel set wins until
 * disposeHeroEnvironment(renderer).
 * @param {THREE.WebGLRenderer} renderer
 * @param {typeof ENV_PANELS} [panels] arena panels (default ENV_PANELS)
 * @returns {THREE.Texture}
 * @example const envMap = getHeroEnvironment(renderer); createFighterView(spec, scene, { hero: { envMap } });
 */
export function getHeroEnvironment(renderer, panels = ENV_PANELS) {
  let env = ENV_CACHE.get(renderer);
  if (!env) {
    const source = createEnvScene(panels);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const target = pmrem.fromScene(source, 0.04, 0.1, 100, { size: 256 });
    pmrem.dispose();
    disposeScene(source);
    env = { texture: target.texture, target };
    ENV_CACHE.set(renderer, env);
  }
  return env.texture;
}

/** Free the renderer's baked environment (call when the renderer itself is disposed). */
export function disposeHeroEnvironment(renderer) {
  const env = ENV_CACHE.get(renderer);
  if (!env) return;
  env.target.dispose();
  ENV_CACHE.delete(renderer);
}

/**
 * High-tier composer: RenderPass into a half-float target with 4x MSAA, then bloom, then OutputPass
 * (tone mapping + sRGB from the renderer, one source of truth). Allocate only when the device can
 * reach the bloom tier. The target and the bloom mips are allocated lazily on the first render.
 * @param {THREE.WebGLRenderer} renderer @param {THREE.Scene} scene @param {THREE.Camera} camera
 * @param {typeof QUALITY_CONFIG.bloomParams} [params]
 * @param {Partial<typeof GRADE_DEFAULTS>|null} [grade] colour grade appended after OutputPass; null/omitted = no
 *   grade pass at all (output identical to before)
 * @returns {{composer: EffectComposer, bloom: UnrealBloomPass, grade: ShaderPass|null, setSize: (w:number,h:number,ratio:number)=>void,
 *   setGrade: (params: Partial<typeof GRADE_DEFAULTS>) => void, setGradeEnabled: (on: boolean) => void,
 *   sceneCalls: ()=>number, render: (dt:number)=>void, dispose: ()=>void}}
 * @example const post = createHeroComposer(renderer, scene, camera); post.render(dt);
 * @example const graded = createHeroComposer(renderer, scene, camera, undefined, { saturation: 1.05, vignette: { strength: 0.2 } });
 *   graded.setGradeEnabled(tier.grade); // the governor's tier flag
 */
export function createHeroComposer(renderer, scene, camera, params = QUALITY_CONFIG.bloomParams, grade = null) {
  const size = renderer.getSize(new THREE.Vector2());
  const ratio = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * ratio, size.y * ratio, { type: THREE.HalfFloatType, samples: params.samples });
  const composer = new EffectComposer(renderer, target);
  const renderPass = new RenderPass(scene, camera);
  // renderer.info resets on every pass; keep the scene pass's draw count (the later passes are fullscreen quads).
  let sceneCalls = 0;
  const passRender = renderPass.render.bind(renderPass);
  renderPass.render = (r, writeBuffer, readBuffer, deltaTime, maskActive) => {
    passRender(r, writeBuffer, readBuffer, deltaTime, maskActive);
    sceneCalls = r.info.render.calls;
  };
  composer.addPass(renderPass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x * ratio, size.y * ratio), params.strength, params.radius, params.threshold);
  composer.addPass(bloom);
  const output = new OutputPass();
  composer.addPass(output);
  const gradePass = grade ? createGradePass(grade) : null;
  if (gradePass) composer.addPass(gradePass);
  return {
    composer,
    bloom,
    grade: gradePass,
    /** Match the renderer's CSS size and pixel ratio. */
    setSize(w, h, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(w, h);
    },
    /** Retune the grade (no-op without a grade pass). Allocation-free. */
    setGrade(p) {
      if (gradePass) applyGrade(gradePass, p);
    },
    /** Toggle the grade pass (no-op without one); off hands the screen back to OutputPass. */
    setGradeEnabled(on) {
      if (gradePass) gradePass.enabled = on === true;
    },
    /** Draw calls of the scene pass of the last frame (renderer.info only keeps the final pass). */
    sceneCalls: () => sceneCalls,
    /** Render the scene through the passes to the canvas. */
    render(dt) {
      composer.render(dt);
    },
    /** Free the composer targets and every pass (EffectComposer.dispose frees only its own). */
    dispose() {
      composer.dispose();
      bloom.dispose();
      output.dispose();
      if (gradePass) gradePass.dispose();
    },
  };
}
