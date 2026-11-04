// Asset manifest reader (engine /assets, ADR-0003 §Key Interfaces). Pure, three-free: validates an
// exported hero manifest (schema 1: assets[] with lods / maps / lite) and picks the file and LOD a
// quality tier loads. The tier -> LOD / lite rules come from the injected config.

/** Manifest schema this runtime reads. */
export const HERO_MANIFEST_SCHEMA = 1;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate a parsed hero manifest and index its entries by id. Throws with every problem found, so
 * a broken export fails loudly in tests instead of silently at runtime.
 * @param {any} json parsed manifest.json
 * @returns {Map<string, {id:string, file:string, bytes:number, lods:{level:number,tris:number,bytes:number}[],
 *   maps:{name:string,slots:string[],codec:string,width:number,height:number,bytes:number}[],
 *   rig:{file:string,sha256:string}|null, lite:{file:string,bytes:number,maxMap:number}|null}>}
 * @example parseHeroManifest(JSON.parse(text)).get('hero-a').lods[0].tris // 22356
 */
export function parseHeroManifest(json) {
  const errors = [];
  if (!json || typeof json !== 'object') throw new Error('hero manifest: not an object');
  if (json.schema !== HERO_MANIFEST_SCHEMA) errors.push(`schema ${json.schema} != ${HERO_MANIFEST_SCHEMA}`);
  if (!Array.isArray(json.assets)) errors.push('assets is not an array');
  const out = new Map();
  for (const [i, a] of (Array.isArray(json.assets) ? json.assets : []).entries()) {
    const at = `assets[${i}]${a && a.id ? ` (${a.id})` : ''}`;
    if (!a || typeof a.id !== 'string' || !a.id) { errors.push(`${at}: missing id`); continue; }
    if (out.has(a.id)) errors.push(`${at}: duplicate id`);
    if (typeof a.file !== 'string' || !a.file.endsWith('.glb')) errors.push(`${at}: file must be a .glb`);
    if (!Array.isArray(a.lods) || !a.lods.length) errors.push(`${at}: no lods`);
    else {
      a.lods.forEach((l, k) => {
        if (!isNum(l.level) || !isNum(l.tris)) errors.push(`${at}: lods[${k}] needs numeric level and tris`);
      });
    }
    if (!Array.isArray(a.maps)) errors.push(`${at}: maps is not an array`);
    else {
      for (const m of a.maps) {
        if (m.codec !== 'etc1s' && m.codec !== 'uastc') errors.push(`${at}: map ${m.name} codec ${m.codec} is not KTX2 (etc1s|uastc)`);
      }
    }
    if (a.lite && (typeof a.lite.file !== 'string' || !a.lite.file.endsWith('.glb'))) errors.push(`${at}: lite.file must be a .glb`);
    out.set(a.id, {
      id: a.id,
      file: a.file,
      bytes: isNum(a.bytes) ? a.bytes : 0,
      lods: Array.isArray(a.lods) ? [...a.lods].sort((x, y) => x.level - y.level) : [],
      maps: Array.isArray(a.maps) ? a.maps : [],
      rig: a.rig ?? null,
      lite: a.lite ?? null,
    });
  }
  if (errors.length) throw new Error(`hero manifest: ${errors.join('; ')}`);
  return out;
}

/**
 * LOD level a tier draws: the configured level, clamped to the levels the asset has.
 * @param {{lods:{level:number}[]}} entry @param {string} tierName @param {{lodByTier: Record<string, number>}} cfg
 * @example lodForTier(entry, 'medium', { lodByTier: { high: 0, medium: 1, low: 2 } }) // 1
 */
export function lodForTier(entry, tierName, cfg) {
  const want = cfg.lodByTier[tierName] ?? 0;
  const levels = entry.lods.map((l) => l.level);
  if (levels.includes(want)) return want;
  const lower = levels.filter((l) => l <= want);
  return lower.length ? Math.max(...lower) : Math.min(...levels);
}

/**
 * The file a tier downloads: the lite copy (1024² maps) on lite tiers when the manifest lists one,
 * else the full export.
 * @param {{file:string, lite:{file:string}|null}} entry @param {string} tierName
 * @param {{liteTiers: readonly string[]}} cfg
 * @returns {{file: string, lite: boolean}}
 * @example heroFileForTier(entry, 'low', { liteTiers: ['medium', 'low'] }) // { file: 'hero-a.lite.glb', lite: true }
 */
export function heroFileForTier(entry, tierName, cfg) {
  if (entry.lite && cfg.liteTiers.includes(tierName)) return { file: entry.lite.file, lite: true };
  return { file: entry.file, lite: false };
}
