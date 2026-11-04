// Pure checks of a skinned export against the ADR-0001 joint contract (ADR-0003 §Key Interfaces):
// joint names, hierarchy and rest offsets equal createRig's. Used by the consumer's rig-contract test and
// the engine's test/blender/ without Blender. The inputs are the <id>.rig.json that lib/armature.py read
// back from the Blender armature, and the JSON chunk of the exported .glb. Like glb-contract.mjs, it
// imports nothing from src/: the caller passes in the expected rig, which it builds with createRig.

export const JOINT_NAME = /^[A-Za-z0-9_]+$/;
const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const fmt = (v) => `[${v.map((x) => +x.toFixed(6)).join(', ')}]`;

/**
 * Violations of the joint contract in an armature manifest (rig.json). Returns [] when it holds.
 * @param {{joints: {name: string, parent: string|null, translation: number[], rotation: number[]}[], extraBones: string[]}} rig
 * @param {{names: string[], parent: Record<string, string|null>, translation: Record<string, number[]>,
 *          rotation: Record<string, number[]>}} expected  createRig's joints at the rig.json proportions,
 *   with the bind rotations as quaternions [x, y, z, w]
 * @param {number} [tol] metres / quaternion units
 * @example rigViolations(JSON.parse(text), expectedFromCreateRig(rig.proportions, rig.bindPose)) // []
 */
export function rigViolations(rig, expected, tol = 1e-5) {
  const out = [];
  const names = rig.joints.map((j) => j.name);
  if (names.join() !== expected.names.join()) out.push(`joint names ${names.join()} != createRig ${expected.names.join()}`);
  for (const n of names) if (!JOINT_NAME.test(n)) out.push(`joint "${n}" is not [A-Za-z0-9_]`);
  if ((rig.extraBones ?? []).length) out.push(`extra bones ${rig.extraBones.join()}`);
  for (const j of rig.joints) {
    if (!(j.name in expected.parent)) continue;
    if (j.parent !== expected.parent[j.name]) out.push(`${j.name}: parent ${j.parent} != ${expected.parent[j.name]}`);
    if (!near(j.translation, expected.translation[j.name], tol)) {
      out.push(`${j.name}: rest offset ${fmt(j.translation)} != ${fmt(expected.translation[j.name])}`);
    }
    const q = j.rotation;
    const e = expected.rotation[j.name];
    if (!near(q, e, tol) && !near(q.map((x) => -x), e, tol)) out.push(`${j.name}: bind rotation ${fmt(q)} != ${fmt(e)}`);
  }
  return out;
}

/**
 * Violations between the exported .glb's skins and its rig.json: every skin has exactly the rig's
 * joints, the same parent links between joint nodes, and the same node translation/rotation.
 * @param {object} json  glTF JSON chunk (glbJson)
 * @param {object} rig   rig.json
 */
export function glbSkinViolations(json, rig, tol = 1e-5) {
  const out = [];
  const skins = json.skins ?? [];
  if (!skins.length) return ['no skin'];
  // Blender writes one skin per skinned mesh object; all of them must share one joint list (one rig).
  for (const s of skins.slice(1)) {
    if (s.joints.join() !== skins[0].joints.join()) out.push('skins disagree on their joint list (more than one rig)');
  }
  const nodes = json.nodes ?? [];
  const jointNodes = skins[0].joints.map((i) => nodes[i]);
  const got = jointNodes.map((n) => n.name).sort();
  const want = rig.joints.map((j) => j.name).sort();
  if (got.join() !== want.join()) out.push(`skin joints ${got.join()} != rig.json ${want.join()}`);
  const parentOf = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
  const byName = new Map(skins[0].joints.map((i) => [nodes[i].name, i]));
  for (const j of rig.joints) {
    const i = byName.get(j.name);
    if (i === undefined) continue;
    const p = parentOf.get(i);
    const pName = p !== undefined && skins[0].joints.includes(p) ? nodes[p].name : null;
    if (pName !== j.parent) out.push(`glb ${j.name}: parent ${pName} != ${j.parent}`);
    const t = nodes[i].translation ?? [0, 0, 0];
    const r = nodes[i].rotation ?? [0, 0, 0, 1];
    if (!near(t, j.translation, tol)) out.push(`glb ${j.name}: translation ${fmt(t)} != ${fmt(j.translation)}`);
    if (!near(r, j.rotation, tol) && !near(r.map((x) => -x), j.rotation, tol)) out.push(`glb ${j.name}: rotation ${fmt(r)} != ${fmt(j.rotation)}`);
    if (nodes[i].scale && !near(nodes[i].scale, [1, 1, 1], tol)) out.push(`glb ${j.name}: scaled joint ${fmt(nodes[i].scale)}`);
  }
  return out;
}
