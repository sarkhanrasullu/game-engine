// Skinned part builder (ADR-0001 HERO-1): collects geometry authored in the local space of a rig
// bone (rigid, weight 1) or in bind space (2-bone blend across a joint) and merges it into one
// SkinnedMesh per material group, all sharing one THREE.Skeleton over the rig's joints.
// Verified against node_modules/three/src (r187): Bone, Skeleton (calculateInverses from bone
// matrixWorld), SkinnedMesh.bind(skeleton, bindMatrix) with bindMode 'attached', skinIndex/skinWeight
// attributes, BufferGeometryUtils.mergeGeometries (all parts must carry the same attributes).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Per-group attribute layout. Every part of a group must carry exactly these so they merge.
 * color: albedo (armour, suit) or (seamWeight, zoneGain, visorWeight) (glow); uv.x = surface id;
 * clampDir: armour-frame clamp displacement in bind space.
 */
const LAYOUT = Object.freeze({
  armour: Object.freeze({ normal: true, uv: true, clampDir: true }),
  suit: Object.freeze({ normal: true, uv: false, clampDir: false }),
  glow: Object.freeze({ normal: false, uv: false, clampDir: false }),
});

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Create a skinned part builder over a rig (call at bind pose: before any applyPose).
 * @param {{joints: Record<string, THREE.Bone>}} rig
 * @example
 *   const sk = createSkinnedBuilder(rig);
 *   sk.rigid('armour', slabGeometry, 'torso', { color: iron, surface: 0 });
 *   const { meshes, skeleton } = sk.build({ armour: armourMat, suit: suitMat, glow: glowMat });
 */
export function createSkinnedBuilder(rig) {
  const root = rig.joints.root;
  root.updateMatrixWorld(true);
  const names = Object.keys(rig.joints);
  const bones = names.map((n) => rig.joints[n]);
  const index = Object.fromEntries(names.map((n, i) => [n, i]));
  /** Bind-pose world position of each bone (the rig is rotation-free at bind). */
  const bindPos = {};
  for (const n of names) bindPos[n] = new THREE.Vector3().setFromMatrixPosition(rig.joints[n].matrixWorld);
  /** @type {Record<string, THREE.BufferGeometry[]>} */
  const parts = { armour: [], suit: [], glow: [] };

  /** Strip a source geometry to the group's layout and append the shared skin/colour attributes. */
  function prepare(group, src, attrs) {
    const lay = LAYOUT[group];
    const g = src.index ? src.toNonIndexed() : src.clone();
    const n = g.getAttribute('position').count;
    if (!lay.normal) g.deleteAttribute('normal');
    else if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (g.getAttribute('uv')) g.deleteAttribute('uv');
    const c = attrs.color;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r ?? c[0];
      col[i * 3 + 1] = c.g ?? c[1];
      col[i * 3 + 2] = c.b ?? c[2];
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (lay.uv) {
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        uv[i * 2] = ((attrs.surface ?? 0) + 0.5) / 8;
        uv[i * 2 + 1] = 0.5;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    if (lay.clampDir) {
      const cd = new Float32Array(n * 3);
      const d = attrs.clamp;
      if (d) for (let i = 0; i < n; i++) { cd[i * 3] = d[0]; cd[i * 3 + 1] = d[1]; cd[i * 3 + 2] = d[2]; }
      g.setAttribute('clampDir', new THREE.BufferAttribute(cd, 3));
    }
    return { g, n };
  }

  return {
    /** Bind-pose world position of a bone (a copy-safe reference: do not mutate). */
    bindPosition: (name) => bindPos[name],

    /**
     * Add geometry authored in `bone`'s local space; it follows that bone rigidly (weight 1).
     * @param {'armour'|'suit'|'glow'} group @param {THREE.BufferGeometry} geo @param {string} bone
     * @param {{color: any, surface?: number, clamp?: number[]}} attrs
     */
    rigid(group, geo, bone, attrs) {
      const { g, n } = prepare(group, geo, attrs);
      g.translate(bindPos[bone].x, bindPos[bone].y, bindPos[bone].z);
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { si[i * 4] = index[bone]; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
      parts[group].push(g);
      geo.dispose();
    },

    /**
     * Add geometry authored in BIND space that crosses a joint: vertices above `yHi` follow `boneHi`,
     * below `yLo` follow `boneLo`, smoothly blended between (a sleeve bends with no gap).
     * @param {'armour'|'suit'|'glow'} group @param {THREE.BufferGeometry} geo
     * @param {string} boneHi parent-side bone @param {string} boneLo child-side bone
     * @param {number} yHi @param {number} yLo bind-space heights, yHi > yLo
     * @param {{color: any, surface?: number, clamp?: number[]}} attrs
     */
    blend(group, geo, boneHi, boneLo, yHi, yLo, attrs) {
      const { g, n } = prepare(group, geo, attrs);
      const pos = g.getAttribute('position');
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const w = smooth((yHi - pos.getY(i)) / (yHi - yLo));
        si[i * 4] = index[boneHi];
        si[i * 4 + 1] = index[boneLo];
        sw[i * 4] = 1 - w;
        sw[i * 4 + 1] = w;
      }
      g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
      parts[group].push(g);
      geo.dispose();
    },

    /** Triangle count collected so far, per group. */
    triangles() {
      const out = {};
      for (const k of Object.keys(parts)) out[k] = parts[k].reduce((a, g) => a + g.getAttribute('position').count / 3, 0);
      return out;
    },

    /**
     * Merge each group into one SkinnedMesh (children of the rig root, frustumCulled false,
     * castShadow false) bound to one shared Skeleton.
     * @param {Record<'armour'|'suit'|'glow', THREE.Material>} materials
     * @returns {{meshes: Record<string, THREE.SkinnedMesh>, skeleton: THREE.Skeleton}}
     */
    build(materials) {
      root.updateMatrixWorld(true);
      const skeleton = new THREE.Skeleton(bones);
      const bindMatrix = new THREE.Matrix4();
      const meshes = {};
      for (const group of Object.keys(parts)) {
        const merged = mergeGeometries(parts[group]);
        for (const g of parts[group]) g.dispose();
        const mesh = new THREE.SkinnedMesh(merged, materials[group]);
        mesh.name = `hero-${group}`;
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        root.add(mesh);
        mesh.bind(skeleton, bindMatrix);
        meshes[group] = mesh;
      }
      return { meshes, skeleton };
    },
  };
}
