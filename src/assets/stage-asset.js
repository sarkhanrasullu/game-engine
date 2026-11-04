// Runtime stage asset core (engine /assets, ADR-0003 §Pipeline 2): validates a stage-artist's glTF
// export (meshopt + quantized geometry, KTX2 maps, one node per LOD group) and turns it into
// session-shared LOD groups whose glTF materials are replaced by the game's runtime material set.
// The node naming, the material-name contract and the material factory are injected: the engine
// knows no stage. A game builds one view's stage from the result and bakes its PMREM environment
// with ../render/environment.js.
// Verified against node_modules/three (r187): GLTFLoader.parseAsync, Object3D.removeFromParent /
// traverse, CompressedTexture.isCompressedTexture (KTX2Loader._createTextureFrom).
// Not thread-safe (main thread only).

/**
 * Load and validate a stage glTF. Rejects (the caller shows its fallback floor) on Draco, non-KTX2
 * images, a missing LOD the manifest lists, an unknown material or a map that failed to transcode.
 * The glTF's own materials are replaced by the runtime set; geometry and maps are kept for the session.
 * @param {ArrayBuffer} bytes GLB
 * @param {{loader: {parseAsync: Function}, levels?: number[], cfg?: object,
 *   nodePattern: RegExp, groups?: readonly string[], materialNames: readonly string[],
 *   createMaterials: (o: {src: Map<string, import('three').Material>, need: (name: string, key: string) => import('three').Texture,
 *     uniforms: {uTime:{value:number}, uPulse:{value:number}, uGain:{value:number}}, cfg: object})
 *     => {materials: Record<string, import('three').Material>, textures: (import('three').Texture|null)[]}}} opts
 *   levels: the LODs the manifest lists (each must have a main group).
 *   nodePattern: matched against each top-level node name; group 1 is the group kind (empty = the main
 *   group, 'stage'), group 2 the LOD level. groups: every group kind (default ['stage']); each LOD
 *   entry carries one key per kind, null when the export has no such node at that level.
 *   materialNames: the glTF material names allowed (anything else rejects the export).
 *   createMaterials: builds the runtime materials (keyed by glTF material name) from the export's
 *   materials (`src`, by name) via `need(name, key)` (a transcoded KTX2 map or a rejection) and the shared
 *   uniforms; `textures` lists the maps dispose() frees. cfg is passed through to it.
 * @returns {Promise<{lods: Map<number, Record<string, import('three').Object3D|null>>,
 *   materials: Record<string, import('three').Material>, uniforms: {uTime:{value:number}, uPulse:{value:number}, uGain:{value:number}},
 *   draws: (level: number) => number, tris: (level: number) => number, dispose: () => void}>}
 * @example
 *   const stage = await loadStageAsset(bytes, {
 *     loader, levels: [0, 1, 2], nodePattern: /^arena(?:_(fx))?_lod(\d+)$/, groups: ['stage', 'fx'],
 *     materialNames: ['ar_near', 'ar_fx'],
 *     createMaterials: ({ need, uniforms }) => ({ materials: { ar_near: unlit(need('ar_near', 'map')), ar_fx: fx(need('ar_fx', 'map'), uniforms) }, textures: [...] }),
 *   });
 *   stage.draws(0) // 5
 */
export async function loadStageAsset(bytes, opts) {
  const { loader, levels = [], cfg, nodePattern, groups = ['stage'], materialNames, createMaterials } = opts;
  if (!loader) throw new Error('loadStageAsset: no glTF loader (gltf-loader-stack.js)');
  if (!nodePattern || !materialNames || !createMaterials) throw new Error('loadStageAsset: nodePattern, materialNames and createMaterials are required');
  const gltf = await loader.parseAsync(bytes, '');
  const json = gltf.parser?.json ?? {};
  if ((json.extensionsUsed ?? []).includes('KHR_draco_mesh_compression')) throw new Error('stage: Draco geometry is not allowed (meshopt only)');
  for (const img of json.images ?? []) {
    if (img.mimeType !== 'image/ktx2') throw new Error(`stage: image ${img.name ?? ''} is ${img.mimeType ?? 'a URI'}, not KTX2`);
  }
  const main = groups[0];
  const lods = new Map();
  const src = new Map();
  for (const node of [...gltf.scene.children]) {
    const m = nodePattern.exec(node.name);
    if (!m) continue;
    const level = Number(m[2]);
    if (!lods.has(level)) lods.set(level, Object.fromEntries(groups.map((k) => [k, null])));
    lods.get(level)[m[1] ?? main] = node;
    node.traverse((o) => {
      if (!o.isMesh) return;
      const name = o.material?.name;
      if (!materialNames.includes(name)) throw new Error(`stage: ${o.name} has unknown material ${name}`);
      src.set(name, o.material);
    });
  }
  for (const l of levels) if (!lods.get(l)?.[main]) throw new Error(`stage: LOD ${l} missing`);
  if (!lods.size) throw new Error(`stage: no LOD node matching ${nodePattern}`);
  const need = (name, key) => {
    const t = src.get(name)?.[key];
    if (!t || !t.isCompressedTexture) throw new Error(`stage: ${name}.${key} missing or not KTX2 (transcode failed?)`);
    return t;
  };
  const uniforms = { uTime: { value: 0 }, uPulse: { value: 1 }, uGain: { value: 1 } };
  const { materials, textures } = createMaterials({ src, need, uniforms, cfg });
  const geometries = new Set();
  const nodesOf = (l) => groups.map((k) => l[k]);
  for (const l of lods.values()) {
    for (const node of nodesOf(l)) {
      if (!node) continue;
      node.removeFromParent();
      node.traverse((o) => {
        if (!o.isMesh) return;
        geometries.add(o.geometry);
        o.material = materials[o.material.name];
      });
    }
  }
  for (const m of src.values()) m.dispose();
  const meshesOf = (level) => {
    const out = [];
    const l = lods.get(level);
    for (const node of l ? nodesOf(l) : []) node?.traverse((o) => o.isMesh && out.push(o));
    return out;
  };
  return {
    lods,
    materials,
    uniforms,
    /** Draw calls of a LOD (one per mesh primitive). */
    draws: (level) => meshesOf(level).length,
    /** Triangles of a LOD's main group (other groups excluded, as in the manifest). */
    tris: (level) => {
      let n = 0;
      lods.get(level)?.[main]?.traverse((o) => {
        if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position').count) / 3;
      });
      return n;
    },
    /** Free the session's geometry, maps and materials (app teardown; views never call this). */
    dispose() {
      for (const g of geometries) g.dispose();
      for (const t of textures) t?.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
  };
}
