// Node fixtures for the runtime glTF hero tests (engine /assets, ADR-0003 §Key Interfaces): GLTFLoader
// with the real meshopt decoder and a stand-in KTX2 loader (no GPU / workers in node --test) that returns
// a tiny CompressedTexture per map, a synthetic skinned hero GLB built in memory (one triangle per
// primitive over the 18 createRig joints, KTX2-tagged maps) and a matching manifest + config.
// Not a test file (no .test.js suffix).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HERO_JOINTS } from '../../src/assets/hero-asset.js';

// GLTFLoader reads `self.URL` to make blob URLs for embedded images.
globalThis.self ??= globalThis;

/** A hero asset config shaped like a game's (tier -> LOD, lite tiers, fighter slot -> manifest id). */
export const HERO_CFG = Object.freeze({
  base: 'heroes/',
  manifest: 'manifest.json',
  transcoderPath: 'basis/',
  lodByTier: Object.freeze({ high: 0, medium: 1, low: 2 }),
  liteTiers: Object.freeze(['medium', 'low']),
  fighters: Object.freeze({ 'fighter-a': Object.freeze({ asset: 'hero-a' }), 'fighter-b': Object.freeze({ asset: 'hero-b' }) }),
  looks: Object.freeze({ 'hero-a': Object.freeze({ seamMask: 'ormAlpha', seamGain: 1.3, emissiveTemper: true }) }),
});

/** A schema-1 hero manifest listing `hero-a` (the synthetic GLB below, two LODs). */
export function heroManifestJson() {
  return {
    schema: 1,
    assets: [{
      id: 'hero-a', file: 'hero-a.glb', bytes: 1,
      lods: [{ level: 0, tris: 2, bytes: 1 }, { level: 1, tris: 2, bytes: 1 }],
      maps: [{ name: 'map', slots: ['map'], codec: 'etc1s', width: 4, height: 4, bytes: 16 }],
      rig: null, lite: null,
    }],
  };
}

/** Stand-in KTX2 loader: every map becomes a 4x4 CompressedTexture tagged with its source URL. */
export function fakeKtx2Loader() {
  return {
    load(url, onLoad) {
      const t = new THREE.CompressedTexture([{ data: new Uint8Array(16), width: 4, height: 4 }], 4, 4);
      t.userData.url = url;
      queueMicrotask(() => onLoad(t));
    },
  };
}

/** GLTFLoader with the real MeshoptDecoder and the stand-in KTX2 loader. */
export function nodeGltfLoader() {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(fakeKtx2Loader());
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const align4 = (n) => (n + 3) & ~3;

/** Pack a glTF JSON document and its binary views into a GLB ArrayBuffer. */
function packGlb(json, views) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = align4(jsonBytes.length);
  const binLen = json.buffers[0].byteLength;
  const out = new ArrayBuffer(12 + 8 + jsonLen + 8 + binLen);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.byteLength, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  u8.set(jsonBytes, 20);
  u8.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  const binStart = 20 + jsonLen;
  dv.setUint32(binStart, binLen, true);
  dv.setUint32(binStart + 4, CHUNK_BIN, true);
  for (const v of views) u8.set(new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength), binStart + 8 + v.byteOffset);
  return out;
}

/**
 * Build a skinned hero GLB in memory: per LOD an `armour_lod<N>` (and `suit_lod<N>`) SkinnedMesh of one
 * triangle, all weight on `root`, over the 18 createRig joints at identity (so IBM = W^-1 = identity);
 * three KTX2-tagged maps (base colour, metallic-roughness, normal) per material via KHR_texture_basisu.
 * @param {{lods?: number[], suit?: boolean, clamp?: boolean, emissive?: boolean, joints?: readonly string[], primitiveName?: (role: string, level: number) => string}} [o]
 *   joints: the skin's joint names (default HERO_JOINTS; pass a broken set to exercise the contract)
 * @returns {ArrayBuffer}
 * @example const asset = await loadHeroAsset(heroGlb({ lods: [0, 1] }), { loader: nodeGltfLoader(), cfg: HERO_CFG });
 */
export function heroGlb(o = {}) {
  const { lods = [0], suit = true, clamp = false, emissive = false, joints = HERO_JOINTS, primitiveName = (role, level) => `${role}_lod${level}` } = o;
  const views = [];
  let byteLength = 0;
  const view = (data) => {
    const byteOffset = byteLength;
    views.push({ byteOffset, byteLength: data.byteLength, data });
    byteLength = align4(byteLength + data.byteLength);
    return views.length - 1;
  };
  const accessors = [];
  const accessor = (data, componentType, type, count, extra = {}) => {
    accessors.push({ bufferView: view(data), componentType, type, count, ...extra });
    return accessors.length - 1;
  };
  const pos = accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 5126, 'VEC3', 3, { min: [0, 0, 0], max: [1, 1, 0] });
  const nrm = accessor(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 5126, 'VEC3', 3);
  const uv = accessor(new Float32Array([0, 0, 1, 0, 0, 1]), 5126, 'VEC2', 3);
  const jnt = accessor(new Uint16Array(12), 5123, 'VEC4', 3);
  const wgt = accessor(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 5126, 'VEC4', 3);
  const attributes = { POSITION: pos, NORMAL: nrm, TEXCOORD_0: uv, JOINTS_0: jnt, WEIGHTS_0: wgt };
  if (clamp) attributes._CLAMPDIR = accessor(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 5126, 'VEC3', 3);
  const ibmData = new Float32Array(16 * joints.length);
  for (let i = 0; i < joints.length; i++) ibmData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16);
  const ibm = accessor(ibmData, 5126, 'MAT4', joints.length);
  const mapNames = ['map', 'orm', 'normal', ...(emissive ? ['emissive'] : [])];
  const images = mapNames.map((name) => ({ name, mimeType: 'image/ktx2', bufferView: view(new Uint8Array(16)) }));
  const textures = images.map((_, i) => ({ extensions: { KHR_texture_basisu: { source: i } } }));
  const material = (name) => ({
    name,
    pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 } },
    normalTexture: { index: 2 },
    ...(emissive ? { emissiveTexture: { index: 3 }, emissiveFactor: [1, 1, 1] } : {}),
  });
  const materials = [material('armour'), material('suit')];
  const nodes = joints.map((name) => ({ name }));
  const sceneNodes = nodes.map((_, i) => i);
  const skins = [{ joints: sceneNodes.slice(), inverseBindMatrices: ibm }];
  const meshes = [];
  for (const level of lods) {
    for (const [role, mat] of [['armour', 0], ...(suit ? [['suit', 1]] : [])]) {
      const name = primitiveName(role, level);
      meshes.push({ name, primitives: [{ attributes, material: mat }] });
      nodes.push({ name, mesh: meshes.length - 1, skin: 0 });
      sceneNodes.push(nodes.length - 1);
    }
  }
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_texture_basisu'],
    extensionsRequired: ['KHR_texture_basisu'],
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes, meshes, skins, materials, textures, images, accessors,
    bufferViews: views.map(({ byteOffset, byteLength: len }) => ({ buffer: 0, byteOffset, byteLength: len })),
    buffers: [{ byteLength }],
  };
  return packGlb(json, views);
}
