// Stage-lit PMREM environment (engine /render, ADR-0001, ADR-0003 §Pipeline 2): bakes the fighters'
// environment map from a loaded runtime stage asset (the static env LOD lifted into HDR, in the stage's
// fog, plus the art-bible R2-5 studio accent panels) so the heroes' metal reflects the arena they stand
// in. Every value comes from the injected config; the engine names no stage.
// Verified against node_modules/three (r187): PMREMGenerator.fromScene(scene, sigma, near, far,
// {size, position}) (PMREMGenerator.js L92); FogExp2(color, density). Not thread-safe (main thread only).
import * as THREE from 'three';
import { ENV_PANELS } from './pipeline.js';

/** One emissive accent panel looking at the probe (art bible R2-5 studio lights). */
function accentPanel(c, center, radius) {
  const w = 2 * radius * Math.tan((c.size[0] * Math.PI) / 360);
  const h = 2 * radius * Math.tan((c.size[1] * Math.PI) / 360);
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(c.color).multiplyScalar(c.intensity), side: THREE.DoubleSide, toneMapped: false, fog: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.set(...c.dir).normalize().multiplyScalar(radius).add(center);
  mesh.lookAt(center);
  return mesh;
}

/**
 * Bake the fighters' PMREM environment from a loaded stage asset: the env LOD of the stage (static:
 * pulse 1, no fx cards or embers) lifted by `env.gain`, in its fog, plus the studio accents, captured
 * from the probe (fighter chest height). Single-thread only.
 * @param {THREE.WebGLRenderer} renderer
 * @param {{lods: Map<number, {stage: THREE.Object3D}>, uniforms: {uGain: {value: number}, uPulse: {value: number}}}} asset
 *   a loadStageAsset result (./assets): `stage` is the main group of each LOD
 * @param {{cfg: {fog: {color: number, density: number}, env: {gain: number, level: number, probe: number[], size: number,
 *   sigma: number, near: number, far: number, accents: readonly string[], accentRadius: number}},
 *   panels?: typeof ENV_PANELS}} opts cfg: the game's stage config; panels: accent panel set (default ENV_PANELS)
 * @returns {{texture: THREE.Texture, dispose: () => void}}
 * @example const env = bakeStageEnvironment(renderer, asset, { cfg: STAGE_CONFIG }); createFighterView(spec, scene, { hero: { envMap: env.texture } });
 */
export function bakeStageEnvironment(renderer, asset, opts) {
  const { cfg, panels = ENV_PANELS } = opts;
  const e = cfg.env;
  const scene = new THREE.Scene();
  const level = asset.lods.has(e.level) ? e.level : Math.max(...asset.lods.keys());
  scene.add(asset.lods.get(level).stage.clone());
  scene.fog = new THREE.FogExp2(cfg.fog.color, cfg.fog.density);
  scene.background = new THREE.Color(cfg.fog.color).multiplyScalar(e.gain);
  const probe = new THREE.Vector3(...e.probe);
  const accents = e.accents.filter((k) => panels[k]).map((k) => accentPanel(panels[k], probe, e.accentRadius));
  for (const a of accents) scene.add(a);
  const u = asset.uniforms;
  const saved = { gain: u.uGain.value, pulse: u.uPulse.value };
  u.uGain.value = e.gain;
  u.uPulse.value = 1;
  const pmrem = new THREE.PMREMGenerator(renderer);
  let target;
  try {
    target = pmrem.fromScene(scene, e.sigma, e.near, e.far, { size: e.size, position: probe });
  } finally {
    u.uGain.value = saved.gain;
    u.uPulse.value = saved.pulse;
    pmrem.dispose();
    for (const a of accents) {
      a.geometry.dispose();
      a.material.dispose();
    }
  }
  return { texture: target.texture, dispose: () => target.dispose() };
}
