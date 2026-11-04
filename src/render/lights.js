// Light rig and shadow caster hooks (engine /render, game-feel audit LF-F13 / LF-F17). createScene
// builds its lights through a rig factory: the default below is the art-bible rig (hemisphere fill +
// key + front + rim, in that order, no ambient); a game passes its own factory through
// createScene(..., { lights }) to add lights, drive moods or flicker from the per-frame `state` it
// hands to view.render. configureShadowCaster turns one DirectionalLight into the scene's single
// shadow caster. Verified against node_modules/three/src (r187): DirectionalLightShadow wraps an
// OrthographicCamera(-5, 5, 5, -5, 0.5, 500); LightShadow has mapSize, bias, normalBias, radius,
// intensity; PCFSoftShadowMap is deprecated since r186 (PCFShadowMap replaces it); BasicShadowMap,
// PCFShadowMap and VSMShadowMap are current. Not thread-safe (main thread only).
import * as THREE from 'three';

/**
 * Shadow caster defaults (ADR-0001 keeps real-time shadows off by default on every tier; a game
 * enables them per tier through createScene's `shadows` option and the tier's `shadows` flag).
 * frustum: half-size of the orthographic shadow box around the caster target (world units).
 */
export const SHADOW_DEFAULTS = Object.freeze({
  enabled: false,
  mapSize: 1024,
  bias: -0.0005,
  normalBias: 0.02,
  radius: 1,
  type: 'pcf',
  caster: 'key',
  frustum: 4,
  near: 0.5,
  far: 30,
  /** Move the caster with the fighters' midpoint every frame (position = midpoint + offset). */
  follow: true,
  /** Caster offset from the midpoint when following; also the dedicated ('own') light's position. */
  offset: Object.freeze([0.6, 10, 1.5]),
  /** Intensity of the dedicated ('own') shadow-only light (0 = casts shadows, adds no light). */
  ownIntensity: 0,
});

const SHADOW_TYPES = Object.freeze({ basic: THREE.BasicShadowMap, pcf: THREE.PCFShadowMap, vsm: THREE.VSMShadowMap });

/**
 * The built-in rig: hemisphere fill, warm key, low front fill and back rim, added to `scene` in that
 * order (the order the shader receives them in). The rig object is what createScene keeps: call it
 * from your own `lights` factory to extend it rather than rebuild it.
 * @param {THREE.Scene} scene
 * @param {{lighting: {key:{color:number,intensity:number,position:readonly number[]}, front:object, rim:object,
 *   fill:{sky:number,ground:number,intensity:number}}}} o the game's lighting constants
 * @returns {{key: THREE.DirectionalLight, front: THREE.DirectionalLight, rim: THREE.DirectionalLight, fill: THREE.HemisphereLight,
 *   lights: THREE.Light[], update(dt:number, state:any):void, setMood(name:string):void, dispose():void}}
 * @example const view = createScene(app, specs, { ...look, lights: (scene, { lighting }) => {
 *     const rig = createDefaultLightRig(scene, { lighting });
 *     const lava = new THREE.DirectionalLight(0xff7a30, 2); lava.position.set(-4, 0.6, -5); scene.add(lava);
 *     return { ...rig, update(dt, state) { rig.key.intensity = state?.ko ? 1.6 : 2.2; },
 *       dispose() { scene.remove(lava); lava.dispose(); rig.dispose(); } };
 *   } });
 */
export function createDefaultLightRig(scene, { lighting }) {
  const fill = new THREE.HemisphereLight(lighting.fill.sky, lighting.fill.ground, lighting.fill.intensity);
  scene.add(fill);
  const key = new THREE.DirectionalLight(lighting.key.color, lighting.key.intensity);
  key.position.set(...lighting.key.position);
  scene.add(key);
  const front = new THREE.DirectionalLight(lighting.front.color, lighting.front.intensity);
  front.position.set(...lighting.front.position);
  scene.add(front);
  const rim = new THREE.DirectionalLight(lighting.rim.color, lighting.rim.intensity);
  rim.position.set(...lighting.rim.position);
  scene.add(rim);
  const lights = [fill, key, front, rim];
  return {
    key,
    front,
    rim,
    fill,
    lights,
    /** Per frame with the consumer's state object (createScene passes it through unchanged). No-op here. */
    update() {},
    /** Named mood (e.g. 'ko', 'victory'). No-op here; a game rig interpolates its own targets. */
    setMood() {},
    /** Remove and free the four lights. Idempotent. */
    dispose() {
      for (const l of lights) {
        if (l.parent) l.parent.remove(l);
        l.dispose();
      }
    },
  };
}

/**
 * Make `light` the scene's shadow caster: enables the renderer's shadow map (type per cfg), sets the
 * light's map size, bias, normal bias and radius, and sizes the orthographic shadow box. Adds the
 * light's target to `scene` so the caster can be aimed by moving `light.target.position`. Call once
 * at scene build (toggling shadows at runtime recompiles every receiving material).
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.DirectionalLight} light
 * @param {THREE.Scene} scene
 * @param {Partial<typeof SHADOW_DEFAULTS>} [cfg]
 * @returns {{restore: () => void}} restore: put the renderer's shadow-map flags back (view teardown)
 * @example const sh = configureShadowCaster(renderer, rig.key, scene, { mapSize: 2048, frustum: 3 });
 *   fighterRoot.traverse((o) => { if (o.isMesh) o.castShadow = true; }); // or view.setShadowCaster(root)
 */
export function configureShadowCaster(renderer, light, scene, cfg = SHADOW_DEFAULTS) {
  const c = { ...SHADOW_DEFAULTS, ...cfg };
  const wasEnabled = renderer.shadowMap.enabled;
  const wasType = renderer.shadowMap.type;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = SHADOW_TYPES[c.type] ?? THREE.PCFShadowMap;
  light.castShadow = true;
  const sh = light.shadow;
  sh.mapSize.set(c.mapSize, c.mapSize);
  sh.bias = c.bias;
  sh.normalBias = c.normalBias;
  sh.radius = c.radius;
  const cam = sh.camera;
  cam.left = -c.frustum;
  cam.right = c.frustum;
  cam.top = c.frustum;
  cam.bottom = -c.frustum;
  cam.near = c.near;
  cam.far = c.far;
  cam.updateProjectionMatrix();
  if (!light.target.parent) scene.add(light.target);
  return {
    restore() {
      renderer.shadowMap.enabled = wasEnabled;
      renderer.shadowMap.type = wasType;
    },
  };
}

/**
 * Set castShadow (or receiveShadow) on every mesh under `root`. Changing either flag changes the
 * mesh's shader program key, so do this before prewarm, not mid-fight.
 * @param {THREE.Object3D} root @param {'castShadow'|'receiveShadow'} flag @param {boolean} on
 * @example setShadowFlag(fighterView.root, 'castShadow', true); setShadowFlag(stageFloor, 'receiveShadow', true);
 */
export function setShadowFlag(root, flag, on) {
  root.traverse((o) => {
    if (o.isMesh) o[flag] = on;
  });
}
