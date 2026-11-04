// Pure checks on a written .glb (no encoders, no Blender), shared by compress.mjs and the consumer's
// stale-export test: GLB JSON parsing, per-LOD stats, and the ADR-0003 output contract
// (meshopt geometry, KTX2-only images, no Draco).
//   import { glbJson, contractViolations } from '@sarkhanrasullu/game-engine/blender/glb-contract.mjs';
//   contractViolations(glbJson(readFileSync('assets/x/y.glb'))) // [] when the export keeps the contract

/** Parse the JSON chunk of a .glb. */
export function glbJson(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const len = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len)));
}

/** Per-LOD triangle and compressed-geometry byte counts, from nodes named `<anything>_lod<N>`. */
export function lodStats(json) {
  const lods = new Map();
  for (const node of json.nodes ?? []) {
    const m = /_lod(\d+)$/.exec(node.name ?? '');
    if (!m || node.mesh === undefined) continue;
    const level = Number(m[1]);
    const entry = lods.get(level) ?? { level, tris: 0, views: new Set() };
    for (const prim of json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4) throw new Error(`${node.name}: only TRIANGLES primitives are supported`);
      const idx = json.accessors[prim.indices];
      entry.tris += idx ? idx.count / 3 : json.accessors[prim.attributes.POSITION].count / 3;
      for (const a of [prim.indices, ...Object.values(prim.attributes)]) {
        if (a !== undefined && json.accessors[a].bufferView !== undefined) entry.views.add(json.accessors[a].bufferView);
      }
    }
    lods.set(level, entry);
  }
  return [...lods.values()].sort((a, b) => a.level - b.level).map(({ level, tris, views }) => ({
    level,
    tris,
    bytes: [...views].reduce((sum, v) => {
      const bv = json.bufferViews[v];
      return sum + (bv.extensions?.EXT_meshopt_compression?.byteLength ?? bv.byteLength);
    }, 0),
  }));
}

/** ADR-0003 output rules, checked on the written file. Returns a list of violations (empty = ok). */
export function contractViolations(json) {
  const used = new Set(json.extensionsUsed ?? []);
  const out = [];
  if (used.has('KHR_draco_mesh_compression')) out.push('uses Draco (forbidden)');
  if ((json.meshes ?? []).length && !used.has('EXT_meshopt_compression')) out.push('geometry is not meshopt-compressed');
  for (const img of json.images ?? []) {
    if (img.mimeType !== 'image/ktx2') out.push(`image "${img.name ?? '?'}" is ${img.mimeType ?? img.uri}, not KTX2`);
  }
  if ((json.textures ?? []).some((t) => t.source !== undefined)) out.push('a texture has a non-KTX2 fallback source');
  if ((json.images ?? []).length && !used.has('KHR_texture_basisu')) out.push('KTX2 images without KHR_texture_basisu');
  return out;
}
