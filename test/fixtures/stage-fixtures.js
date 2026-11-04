// Shared fixtures for the stage asset tests (engine /assets, ADR-0003 §Pipeline 2): a fake GLTFLoader
// result shaped like a stage-artist export (nodes arena[_fx|_embers]_lod<N>, shared glTF materials with
// compressed maps), a fake loader, the injected runtime contract (node pattern, groups, material names,
// material factory), a schema-1 stage manifest and a config shaped like a game's.
// Not a test file (no .test.js suffix).
import * as THREE from 'three';
import { loadStageAsset } from '../../src/assets/stage-asset.js';

/** A stage asset config shaped like a game's (where files live, the entry id, tier rules, fog, env). */
export const STAGE_CFG = Object.freeze({
  base: 'stage/',
  manifest: 'manifest.json',
  transcoderPath: 'basis/',
  id: 'arena',
  lodByTier: Object.freeze({ high: 0, medium: 1, low: 2 }),
  liteTiers: Object.freeze(['medium', 'low']),
  fog: Object.freeze({ color: 0x241210, density: 0.011 }),
  env: Object.freeze({ gain: 4, level: 2, probe: Object.freeze([0, 1.2, 0]), size: 256, sigma: 0.04, near: 0.1, far: 100, accents: Object.freeze(['moon']), accentRadius: 10 }),
});

/** The runtime material names of the fixture export. */
export const ARENA_MATS = Object.freeze(['ar_near', 'ar_props', 'ar_sky', 'ar_fx', 'ar_embers']);

/** A schema-1 stage manifest (`kind: "stage"`) with one three-LOD entry `arena`. */
export function stageManifestJson() {
  return {
    schema: 1,
    kind: 'stage',
    assets: [{
      id: 'arena', kind: 'stage', file: 'arena.glb', bytes: 1,
      lods: [{ level: 0, tris: 27352, bytes: 1 }, { level: 1, tris: 17966, bytes: 1 }, { level: 2, tris: 11848, bytes: 1 }],
      maps: [{ name: 'near', slots: ['map'], codec: 'etc1s', width: 2048, height: 2048, bytes: 1 }],
      rig: null, lite: null,
    }],
  };
}

const ktx = (name) => {
  const t = new THREE.CompressedTexture([], 4, 4);
  t.name = name;
  return t;
};

/**
 * @param {{levels?: number[], fxLevels?: number[], images?: string[], badMaterial?: boolean, plainMap?: boolean}} [o]
 * @returns {{scene: THREE.Group, parser: {json: object}, mats: Record<string, THREE.Material>}}
 */
export function fakeStageGltf(o = {}) {
  const { levels = [0, 1, 2], fxLevels = [0, 1], images = ['image/ktx2'], badMaterial = false, plainMap = false } = o;
  const std = (name, maps) => Object.assign(new THREE.MeshStandardMaterial({ name }), maps);
  const mats = {
    ar_near: std('ar_near', { map: plainMap ? new THREE.Texture() : ktx('near'), emissiveMap: ktx('near_emit') }),
    ar_props: std('ar_props', { map: ktx('props'), emissiveMap: ktx('props_emit') }),
    ar_sky: std('ar_sky', { map: ktx('sky') }),
    ar_fx: std('ar_fx', { map: ktx('fx') }),
    ar_embers: std('ar_embers', { emissive: new THREE.Color(0.9, 0.175, 0.027) }),
  };
  const scene = new THREE.Group();
  const mesh = (name, mat) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.name = name;
    return m;
  };
  for (const l of levels) {
    const g = new THREE.Group();
    g.name = `arena_lod${l}`;
    g.add(mesh(`arena_lod${l}_1`, mats.ar_near), mesh(`arena_lod${l}_2`, mats.ar_sky), mesh(`arena_lod${l}_3`, badMaterial ? std('mystery') : mats.ar_props));
    scene.add(g);
  }
  for (const l of fxLevels) {
    scene.add(mesh(`arena_fx_lod${l}`, mats.ar_fx));
    scene.add(mesh(`arena_embers_lod${l}`, mats.ar_embers));
  }
  return { scene, parser: { json: { extensionsUsed: ['EXT_meshopt_compression', 'KHR_texture_basisu'], images: images.map((mimeType) => ({ mimeType })) } }, mats };
}

/** A loader whose parseAsync resolves to `gltf` (or rejects with `error`). */
export function fakeLoader(gltf, error = null) {
  return { parseAsync: async () => { if (error) throw error; return gltf; } };
}

/**
 * The fixture's material factory (the hook a game binds): picks the contract maps through `need` and
 * returns unlit runtime materials keyed by glTF material name plus the maps dispose() frees.
 */
export function createArenaMaterials({ src, need }) {
  const tex = {
    near: need('ar_near', 'map'), nearEmit: need('ar_near', 'emissiveMap'),
    props: need('ar_props', 'map'), propsEmit: need('ar_props', 'emissiveMap'),
    sky: need('ar_sky', 'map'), fx: src.has('ar_fx') ? need('ar_fx', 'map') : null,
  };
  const unlit = (name, map, fog) => new THREE.MeshBasicMaterial({ name, map, fog });
  return {
    materials: {
      ar_near: unlit('ar_near', tex.near, true),
      ar_props: unlit('ar_props', tex.props, true),
      ar_sky: unlit('ar_sky', tex.sky, false),
      ar_fx: new THREE.MeshBasicMaterial({ name: 'ar_fx', map: tex.fx, transparent: true, depthWrite: false }),
      ar_embers: new THREE.MeshBasicMaterial({ name: 'ar_embers', color: src.get('ar_embers')?.emissive ?? 0xffffff, blending: THREE.AdditiveBlending }),
    },
    textures: Object.values(tex),
  };
}

/** The fixture export's runtime contract, as a game would bind it onto the engine core. */
export const ARENA_CONTRACT = Object.freeze({
  nodePattern: /^arena(?:_(fx|embers))?_lod(\d+)$/,
  groups: Object.freeze(['stage', 'fx', 'embers']),
  materialNames: ARENA_MATS,
  createMaterials: createArenaMaterials,
});

/** loadStageAsset with the fixture contract bound (what a game's wrapper does). */
export const loadArenaAsset = (bytes, o) => loadStageAsset(bytes, { ...ARENA_CONTRACT, ...o });
