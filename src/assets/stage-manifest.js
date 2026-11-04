// Stage manifest reader (engine /assets, ADR-0003 §Key Interfaces). Pure, three-free: a stage manifest
// has the hero manifest's schema (schema 1, assets[] with lods/maps/lite) plus `kind: "stage"`, so it
// reuses the hero validator and tier rules.
import { parseHeroManifest, lodForTier, heroFileForTier } from './manifest.js';

/**
 * Validate a parsed stage manifest and return the entry `id`. Throws on a schema error, a non-stage
 * manifest or a missing entry (the stage store then shows the fallback floor).
 * @param {any} json parsed manifest.json @param {string} id
 * @returns {ReturnType<typeof parseHeroManifest> extends Map<string, infer E> ? E : never}
 * @example stageEntry(JSON.parse(text), 'stage-a').lods.map((l) => l.tris) // [27352, 17966, 11848]
 */
export function stageEntry(json, id) {
  if (!json || json.kind !== 'stage') throw new Error(`stage manifest: kind ${json?.kind} is not "stage"`);
  for (const a of Array.isArray(json.assets) ? json.assets : []) {
    if (a && a.kind !== undefined && a.kind !== 'stage') throw new Error(`stage manifest: ${a.id} kind ${a.kind} is not "stage"`);
  }
  const entry = parseHeroManifest(json).get(id);
  if (!entry) throw new Error(`stage manifest: no entry ${id}`);
  return entry;
}

/**
 * LOD level and file a quality tier uses: the configured LOD clamped to the levels present; the lite
 * copy on lite tiers when the manifest lists one, and always when the assets are inline (artifact).
 * @param {{file:string, lite:{file:string}|null, lods:{level:number}[]}} entry
 * @param {string} tierName @param {{lodByTier: Record<string, number>, liteTiers: readonly string[]}} cfg
 * @param {boolean} [inline]
 * @returns {{level: number, file: string, lite: boolean}}
 * @example stageChoice(entry, 'medium', STAGE_CONFIG) // { level: 1, file: 'stage-a.lite.glb', lite: true }
 */
export function stageChoice(entry, tierName, cfg, inline = false) {
  const level = lodForTier(entry, tierName, cfg);
  const pick = inline && entry.lite ? { file: entry.lite.file, lite: true } : heroFileForTier(entry, tierName, cfg);
  return { level, ...pick };
}
