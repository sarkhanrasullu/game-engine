// Headless stand-ins for the render tests (no WebGL): a renderer that records what createScene,
// PMREMGenerator, EffectComposer and the shadow hooks touch, a window with the listeners and media
// query createScene reads, a container, and the fighter-view / stage factories createScene injects.
// Not a test file (no .test.js suffix).
import * as THREE from 'three';

/**
 * A WebGLRenderer-shaped object whose GL calls are no-ops. `calls` counts render()/compile().
 * @param {{pixelRatio?: number, width?: number, height?: number}} [o]
 */
export function fakeRenderer(o = {}) {
  let ratio = o.pixelRatio ?? 2;
  const size = new THREE.Vector2(o.width ?? 844, o.height ?? 390);
  let target = null;
  const r = {
    isWebGLRenderer: true,
    coordinateSystem: THREE.WebGLCoordinateSystem,
    reversedDepthBuffer: false,
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    xr: { enabled: false },
    info: { render: { calls: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] },
    domElement: { remove() {} },
    state: { buffers: { depth: { getReversed: () => false } } },
    calls: { render: 0, compile: 0 },
    setPixelRatio(v) { ratio = v; },
    getPixelRatio: () => ratio,
    setSize(w, h) { size.set(w, h); },
    getSize: (v) => v.copy(size),
    render() { r.calls.render++; },
    compile() { r.calls.compile++; },
    setRenderTarget(t) { target = t; },
    getRenderTarget: () => target,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    clear() {},
    getClearColor: (c) => c.set(0),
    getClearAlpha: () => 1,
    setClearColor() {},
    dispose() {},
  };
  return r;
}

/** Install a minimal `window` (listeners, matchMedia, devicePixelRatio) when none exists. */
export function installFakeWindow({ devicePixelRatio = 2, reducedMotion = false } = {}) {
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
      devicePixelRatio,
      listeners: {},
      addEventListener(k, f) { (this.listeners[k] ??= []).push(f); },
      removeEventListener(k, f) { this.listeners[k] = (this.listeners[k] ?? []).filter((g) => g !== f); },
      matchMedia: () => ({ matches: reducedMotion }),
    };
  }
  return globalThis.window;
}

/** A container element: fixed CSS size, appendChild no-op. */
export const fakeContainer = (w = 844, h = 390) => ({ clientWidth: w, clientHeight: h, appendChild() {} });

/** Fighter view factory: one box mesh at the sim fighter's (x, z), the flags/ko/hold surface createScene reads. */
export function fakeFighterView(spec, scene) {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.4), new THREE.MeshStandardMaterial());
  root.add(mesh);
  scene.add(root);
  const out = { x: 0, z: 0 };
  return {
    spec,
    root,
    flashMesh: mesh,
    flags: { landed: false, koPop: false },
    ko: { spring: null },
    update(f, alpha, dt, floorY) {
      root.position.set(f.x, floorY, f.z);
      out.x = f.x;
      out.z = f.z;
      return out;
    },
    squash() {},
    hold() {},
    resetFeel() {},
    dispose() { scene.remove(root); mesh.geometry.dispose(); mesh.material.dispose(); },
  };
}

/** Stage factory: one floor plane, records update(dt) calls. */
export function fakeStage(scene) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshLambertMaterial());
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const stage = { floor, updates: 0, update() { stage.updates++; }, dispose() { scene.remove(floor); floor.geometry.dispose(); floor.material.dispose(); } };
  return stage;
}

/** The lighting and feel constants createScene requires (engine-neutral values). */
export const FAKE_LOOK = Object.freeze({
  lighting: Object.freeze({
    exposure: 1,
    key: Object.freeze({ color: 0xfff1dc, intensity: 2.2, position: Object.freeze([-4, 8, 5]) }),
    front: Object.freeze({ color: 0xdfe8ff, intensity: 0.7, position: Object.freeze([4, 1.5, 7]) }),
    rim: Object.freeze({ color: 0xffd9a8, intensity: 1.4, position: Object.freeze([1, 2, -7]) }),
    fill: Object.freeze({ sky: 0xcfe0ff, ground: 0x4a3a2c, intensity: 0.6 }),
  }),
  feel: Object.freeze({ squash: Object.freeze({ light: Object.freeze({ strength: 0.5, holdMs: 60 }) }), koHoldMs: 420 }),
  createStage: (scene) => fakeStage(scene),
  createFighterView: (spec, scene) => fakeFighterView(spec, scene),
});

/** Two sim fighters standing `sep` apart on the floor line. */
export const fakeFighters = (sep = 2) => [{ x: -sep / 2, z: 0 }, { x: sep / 2, z: 0 }];
