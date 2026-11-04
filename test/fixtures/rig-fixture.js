// Synthetic skinned-export fixtures for blender/rig-contract.mjs (ADR-0001 joint contract): a rig.json
// as blender/lib/armature.py writes it and the matching glTF JSON chunk (nodes + one skin), both derived
// from createRig at generic proportions so the contract holds at baseline and every mutation is a real
// violation. Not a test file (no .test.js suffix).
import * as THREE from 'three';
import { createRig } from '../../src/render/index.js';

/** Generic fighter proportions (metres) in the shape a consumer's proportions JSON entry has. */
export const FIXTURE_ENTRY = Object.freeze({
  legLength: 0.7,
  standHipY: 0.69,
  proportions: Object.freeze({
    ankle: 0.08, armRadius: 0.07, foot: [0.18, 0.08, 0.28], foreArm: 0.24, hand: 0.13,
    head: [0.32, 0.3, 0.3], hipX: 0.15, keyY: 0.36, legRadius: 0.085, neckY: 0.56,
    pelvis: [0.46, 0.2, 0.32], shin: 0.3, shoulderX: 0.36, shoulderY: 0.48, thigh: 0.32,
    torso: [0.6, 0.46, 0.4], torsoY: 0.33, upperArm: 0.26,
  }),
});

/** The default A-pose bind (lib/armature.py DEFAULT_BIND_POSE): arms 40 degrees out, three.js Euler XYZ. */
export const FIXTURE_BIND_POSE = Object.freeze({
  armL: [0, 0, (40 * Math.PI) / 180],
  armR: [0, 0, (-40 * Math.PI) / 180],
});

const NON_DEFORM = new Set(['root', 'keyMount', 'key']);

/**
 * createRig's joints for a proportions entry and bind pose: the `expected` side of rigViolations.
 * @example const expected = expectedFromCreateRig(FIXTURE_ENTRY, FIXTURE_BIND_POSE); expected.names.length // 18
 */
export function expectedFromCreateRig(entry, bindPose = {}) {
  const { joints } = createRig({ proportions: entry.proportions });
  const names = Object.keys(joints);
  const parent = {};
  const translation = {};
  const rotation = {};
  for (const n of names) {
    parent[n] = joints[n].parent ? joints[n].parent.name : null;
    // hips: applyPose writes its position each frame; the bind stands it at standHipY (lib/armature.py).
    translation[n] = n === 'hips' ? [0, entry.standHipY, 0] : joints[n].position.toArray();
    const e = bindPose[n] ?? [0, 0, 0];
    rotation[n] = new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'XYZ')).toArray();
  }
  return { names, parent, translation, rotation };
}

/**
 * A rig.json exactly as lib/armature.py `contract_manifest` would write it for `entry`.
 * @example rigJsonFixture().joints[0].name // 'root'
 */
export function rigJsonFixture(entry = FIXTURE_ENTRY, bindPose = FIXTURE_BIND_POSE, fighter = 'fixture') {
  const e = expectedFromCreateRig(entry, bindPose);
  return {
    schema: 1,
    generator: 'tools/blender/lib/armature.py',
    fighter,
    proportions: { proportions: { ...entry.proportions }, standHipY: entry.standHipY, legLength: entry.legLength },
    bindPose: Object.fromEntries(Object.entries(bindPose).map(([k, v]) => [k, [...v]])),
    joints: e.names.map((name) => ({
      name,
      parent: e.parent[name],
      deform: !NON_DEFORM.has(name),
      translation: e.translation[name],
      rotation: e.rotation[name],
      worldHead: [0, 0, 0],
    })),
    extraBones: [],
  };
}

/**
 * The glTF JSON chunk of a skinned export of `rig`: one node per joint (translation, rotation,
 * children), one skinned mesh node, one skin listing the joints in rig order.
 * @example glbJsonFixture(rigJsonFixture()).skins[0].joints.length // 18
 */
export function glbJsonFixture(rig) {
  const index = new Map(rig.joints.map((j, i) => [j.name, i]));
  const nodes = rig.joints.map((j) => ({ name: j.name, translation: [...j.translation], rotation: [...j.rotation] }));
  for (const j of rig.joints) {
    if (j.parent !== null) (nodes[index.get(j.parent)].children ??= []).push(index.get(j.name));
  }
  nodes.push({ name: 'suit_lod0', mesh: 0, skin: 0 });
  return {
    asset: { version: '2.0' },
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    skins: [{ joints: rig.joints.map((j) => index.get(j.name)), skeleton: index.get('root') }],
  };
}
