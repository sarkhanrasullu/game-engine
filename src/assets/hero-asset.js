// Runtime glTF hero asset (engine /assets, ADR-0003 §Pipeline 2 / §Key Interfaces): turns an exported
// hero .glb (meshopt + KHR_mesh_quantization geometry, KTX2 maps, one skin over the createRig joints)
// into session-shared bind-space LODs, so a game's builder can re-bind them to a fresh createRig and
// rig.applyPose and the sim are unchanged.
//
// Binding: the glTF bones are matched BY NAME to createRig(spec); a game's builder re-binds the
// skinned meshes to those rig bones. KHR_mesh_quantization stores positions as normalized int16 and
// folds the dequantization (uniform scale + offset, D) into every inverse bind matrix (IBM = W^-1 * D,
// W = joint bind world). At load the positions are expanded once to float bind space (D * p) and the
// bone inverses become W^-1, so `clampDir` (metres, bind space) adds straight to `position`, and the
// skin is checkable against createRig's A-pose.
//
// Loader-free: GLTFLoader/KTX2Loader/MeshoptDecoder are injected (./gltf-loader-stack.js, lazy chunk).
// Verified against node_modules/three (r187): GLTFLoader.parseAsync/loadAsync, binds skins with an
// identity bindMatrix (GLTFLoader.js L4378), custom attribute `_CLAMPDIR` -> `_clampdir` (L2027),
// multi-primitive meshes -> Group of SkinnedMesh, Skeleton(bones, boneInverses), SkinnedMesh.bind,
// CompressedTexture (KTX2Loader._createTextureFrom).
import * as THREE from 'three';
import { createRig } from '../render/rig.js';
import { lodForTier } from './manifest.js';

/** Largest allowed spread of D = W * IBM across joints (metres / matrix units) before a skin is rejected. */
const DEQUANT_TOL = 1e-4;
/** Joint names of the ADR-0001 rig (createRig's keys; proportions do not change the names). */
export const HERO_JOINTS = Object.freeze(Object.keys(createRig({ proportions: {
  neckY: 0, shoulderX: 0, shoulderY: 0, upperArm: 0, foreArm: 0, hipX: 0, thigh: 0, shin: 0, keyY: 0, torso: [0, 0, 0],
} }).joints));

/**
 * Sort a LOD's skinned parts into the ADR roles. Primitives named `armour*` / `suit*` (the contract)
 * win; then a `suit` material; then file order (first = armour), which is reported as a warning.
 * @param {THREE.SkinnedMesh[]} parts @param {string[]} warnings @param {number} level LOD level (for messages)
 * @returns {{armour: THREE.SkinnedMesh, suit: THREE.SkinnedMesh|null}}
 * @example assignRoles([suitMesh, armourMesh], warnings, 0).armour === armourMesh // true (by name)
 */
export function assignRoles(parts, warnings, level) {
  const sorted = [...parts].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let armour = sorted.find((p) => /^armour/.test(p.name)) ?? null;
  let suit = sorted.find((p) => /^suit/.test(p.name)) ?? null;
  if (!suit) suit = sorted.find((p) => p !== armour && p.material?.name === 'suit') ?? null;
  const rest = sorted.filter((p) => p !== armour && p !== suit);
  if ((!armour || !suit) && rest.length) warnings.push(`lod${level}: primitives not named armour/suit; assigned by order`);
  if (!armour) armour = rest.shift() ?? null;
  if (!suit) suit = rest.shift() ?? null;
  if (rest.length) warnings.push(`lod${level}: ${rest.length} extra skinned primitive(s) ignored`);
  if (!armour) throw new Error(`lod${level}: no skinned armour primitive`);
  return { armour, suit };
}

/**
 * Bind-space copy of one glTF skinned primitive: float positions (D * p), `_clampdir` renamed to
 * `clampDir`, every other attribute shared by reference; bone names in skin order and W^-1 inverses.
 * @param {THREE.SkinnedMesh} src glTF skinned mesh at its bind pose (scene.updateMatrixWorld done)
 * @returns {{geometry: THREE.BufferGeometry, boneNames: string[], boneInverses: THREE.Matrix4[], hasClamp: boolean, tris: number}}
 * @example const part = toBindSpace(skinnedMesh); new THREE.Skeleton(part.boneNames.map((n) => rig.joints[n]), part.boneInverses)
 */
export function toBindSpace(src) {
  const sk = src.skeleton;
  const boneNames = sk.bones.map((b) => b.name);
  for (const n of HERO_JOINTS) if (!boneNames.includes(n)) throw new Error(`${src.name}: skin lacks joint ${n}`);
  for (const n of boneNames) if (!HERO_JOINTS.includes(n)) throw new Error(`${src.name}: skin joint ${n} is not a createRig joint`);
  const r = boneNames.indexOf('root');
  const D = new THREE.Matrix4().multiplyMatrices(sk.bones[r].matrixWorld, sk.boneInverses[r]);
  const Di = new THREE.Matrix4();
  for (let i = 0; i < sk.bones.length; i++) {
    Di.multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i]);
    for (let k = 0; k < 16; k++) {
      if (Math.abs(Di.elements[k] - D.elements[k]) > DEQUANT_TOL) throw new Error(`${src.name}: IBM of ${boneNames[i]} disagrees with its bind node`);
    }
  }
  const g = src.geometry;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    if (name === 'position') continue;
    out.setAttribute(name === '_clampdir' ? 'clampDir' : name, attr);
  }
  const pos = g.getAttribute('position');
  const f = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(D);
    f[i * 3] = v.x;
    f[i * 3 + 1] = v.y;
    f[i * 3 + 2] = v.z;
  }
  out.setAttribute('position', new THREE.BufferAttribute(f, 3));
  if (g.index) out.setIndex(g.index);
  out.userData.heroAssetShared = true;
  const boneInverses = sk.bones.map((b) => b.matrixWorld.clone().invert());
  const tris = (g.index ? g.index.count : pos.count) / 3;
  return { geometry: out, boneNames, boneInverses, hasClamp: !!g.getAttribute('_clampdir'), tris };
}

/**
 * Load and validate one hero glTF (ADR-0003 §Key Interfaces). Rejects (so the caller falls back to a
 * procedural fighter) on Draco, non-KTX2 images, missing maps, a skin that is not the createRig joint
 * set, or IBMs that disagree with the bind nodes.
 * @param {ArrayBuffer|string} source GLB bytes or URL
 * @param {{tier?: string, loader: {parseAsync: Function, loadAsync?: Function}, id?: string,
 *   look?: {seamMask:'ormAlpha'|null, seamGain:number, emissiveTemper:boolean},
 *   cfg: {lodByTier: Record<string, number>, looks?: Record<string, object>}}} opts
 *   cfg: the game's hero asset config (tier -> LOD; optional per-asset `looks[id]` material data)
 * @returns {Promise<{id: string, scene: THREE.Group, skinned: {armour: THREE.SkinnedMesh, suit: THREE.SkinnedMesh|null},
 *   textures: {map: THREE.Texture, orm: THREE.Texture, normal: THREE.Texture, emissive: THREE.Texture|null,
 *   clearcoat: {clearcoat:number,clearcoatRoughness:number}|null, doubleSided: boolean},
 *   lods: Map<number, {armour: ReturnType<typeof toBindSpace>, suit: ReturnType<typeof toBindSpace>|null}>,
 *   look: object, warnings: string[], dispose: () => void}>}
 * @example const asset = await loadHeroAsset(bytes, { tier: 'high', loader, id: 'hero-a', cfg: HERO_CONFIG });
 */
export async function loadHeroAsset(source, opts) {
  const { tier = 'high', loader, id = 'hero', cfg } = opts;
  if (!loader) throw new Error('loadHeroAsset: no glTF loader (pass one from gltf-loader-stack.js)');
  const gltf = typeof source === 'string' ? await loader.loadAsync(source) : await loader.parseAsync(source, '');
  const json = gltf.parser?.json ?? {};
  const used = json.extensionsUsed ?? [];
  if (used.includes('KHR_draco_mesh_compression')) throw new Error(`${id}: Draco geometry is not allowed (meshopt only)`);
  for (const img of json.images ?? []) {
    if (img.mimeType !== 'image/ktx2') throw new Error(`${id}: image ${img.name ?? ''} is ${img.mimeType ?? 'a URI'}, not KTX2`);
  }
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const warnings = [];
  const byLevel = new Map();
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const m = /_lod(\d+)/.exec(o.name) ?? /_lod(\d+)/.exec(o.parent?.name ?? '');
    const level = m ? Number(m[1]) : 0;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(o);
  });
  if (!byLevel.size) throw new Error(`${id}: no skinned mesh`);
  const lods = new Map();
  const roles = new Map();
  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    const r = assignRoles(byLevel.get(level), warnings, level);
    roles.set(level, r);
    lods.set(level, { armour: toBindSpace(r.armour), suit: r.suit ? toBindSpace(r.suit) : null });
  }
  const first = roles.get([...roles.keys()][0]).armour.material;
  const textures = {
    map: first.map ?? null,
    orm: first.metalnessMap ?? first.roughnessMap ?? null,
    normal: first.normalMap ?? null,
    emissive: first.emissiveMap ?? null,
    clearcoat: first.clearcoat > 0 ? { clearcoat: first.clearcoat, clearcoatRoughness: first.clearcoatRoughness } : null,
    doubleSided: first.side === THREE.DoubleSide,
  };
  for (const k of ['map', 'orm', 'normal']) {
    if (!textures[k]) throw new Error(`${id}: ${k} map missing (KTX2 transcode failed?)`);
  }
  for (const [k, t] of Object.entries(textures)) {
    if (t && t.isTexture && !t.isCompressedTexture) throw new Error(`${id}: ${k} map is not a KTX2 (compressed) texture`);
  }
  const level = lodForTier({ lods: [...lods.keys()].map((l) => ({ level: l })) }, tier, cfg);
  const look = opts.look ?? cfg.looks?.[id] ?? { seamMask: null, seamGain: 0, emissiveTemper: true };
  // The glTF's own materials and quantized geometry are never drawn; free their CPU-side references.
  scene.traverse((o) => {
    if (o.isMesh && o.material && o.material !== first) o.material.dispose?.();
  });
  return {
    id, scene, skinned: roles.get(level), textures, lods, look, warnings,
    /** Free the GPU copies of the shared maps and bind-space geometry (session end; views never call this). */
    dispose() {
      for (const t of Object.values(textures)) if (t && t.isTexture) t.dispose();
      for (const l of lods.values()) for (const p of [l.armour, l.suit]) if (p) p.geometry.dispose();
    },
  };
}
