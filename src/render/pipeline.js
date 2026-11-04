// Hero render pipeline (engine /render, ADR-0001 HERO-1, art bible R2-5): the PMREM arena environment baked once per
// renderer from a procedural emissive-panel scene (fighters only; the stage stays Lambert), and the
// high-tier composer (RenderPass into a 4x MSAA half-float target -> UnrealBloomPass -> OutputPass).
// Verified against node_modules/three/src (r187): PMREMGenerator.fromScene(scene, sigma, near, far,
// {size}), EffectComposer(renderer, renderTarget) / setPixelRatio / setSize / render / dispose,
// RenderPass, UnrealBloomPass(resolution, strength, radius, threshold) which halves the buffer for its
// first mip, OutputPass (reads renderer tone mapping + exposure), WebGLRenderTarget {type, samples}.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { QUALITY_CONFIG } from './quality-config.js';

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
 * @returns {{composer: EffectComposer, bloom: UnrealBloomPass, setSize: (w:number,h:number,ratio:number)=>void, sceneCalls: ()=>number, render: (dt:number)=>void, dispose: ()=>void}}
 * @example const post = createHeroComposer(renderer, scene, camera); post.render(dt);
 */
export function createHeroComposer(renderer, scene, camera, params = QUALITY_CONFIG.bloomParams) {
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
  composer.addPass(new OutputPass());
  return {
    composer,
    bloom,
    /** Match the renderer's CSS size and pixel ratio. */
    setSize(w, h, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(w, h);
    },
    /** Draw calls of the scene pass of the last frame (renderer.info only keeps the final pass). */
    sceneCalls: () => sceneCalls,
    /** Render the scene through the passes to the canvas. */
    render(dt) {
      composer.render(dt);
    },
    dispose() {
      composer.dispose();
    },
  };
}
