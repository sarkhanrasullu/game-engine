// Session store for a runtime stage (engine /assets, ADR-0003 §Pipeline 2): fetches the stage
// manifest and the tier's .glb (full or lite, lite always in a single-file artifact), decodes it once
// with the injected loader stack (meshopt + KTX2 in workers), bakes the fighters' PMREM environment
// from it, and hands both to every later scene build. Never rejects: any failure is recorded in `stats`
// and the game shows its fallback stage with its procedural PMREM (the game always runs).
// Not thread-safe (main thread only).
import * as THREE from 'three';
import { stageChoice, stageEntry } from './stage-manifest.js';
import { createInlineSource, fetchBytesWithProgress } from './hero-asset-store.js';
import { bakeStageEnvironment } from '../render/environment.js';

/**
 * Create the stage asset store.
 * @param {{cfg: {base: string, manifest: string, transcoderPath: string, id: string, lodByTier: Record<string, number>,
 *     liteTiers: readonly string[], fog: object, env: object},
 *   loadAsset: (bytes: ArrayBuffer, o: {loader: any, levels: number[], cfg: object}) => Promise<{draws: (level: number) => number, dispose: () => void}>,
 *   enabled?: boolean, inline?: Record<string, any>|null,
 *   fetchBytes?: (url: string, onBytes?: ((loaded: number, total: number) => void) | null) => Promise<ArrayBuffer>,
 *   createLoader?: (o: {renderer: any, transcoderPath: string, manager: THREE.LoadingManager}) => Promise<{loader: any, dispose: () => void}>,
 *   bakeEnv?: typeof bakeStageEnvironment,
 *   onProgress?: (p: {id: string, loaded: number, total: number}) => void,
 *   now?: () => number, log?: (msg: string) => void}} opts
 *   cfg: the game's stage asset config (where files are served from, the manifest entry id, tier rules,
 *   fog and env for the bake). loadAsset: the game's stage loader (the ./stage-asset.js core with its
 *   node pattern and materials bound). enabled: false skips the load (fallback stage). createLoader
 *   defaults to the lazy ./gltf-loader-stack.js; bakeEnv to ../render/environment.js. onProgress (0.5.1):
 *   download bytes of the stage file as they stream (id = cfg.id). The rest are test seams.
 * @example
 *   const stages = createStageAssetStore({ cfg: STAGE_CONFIG, loadAsset: loadArenaAsset, inline: window.__INLINE_ASSETS__ ?? null });
 *   stages.preload({ tier: 'high', renderer });
 *   await stages.whenReady(6000); stages.get(); // asset or null (fallback); stages.env() // PMREM or null
 */
export function createStageAssetStore(opts) {
  const cfg = opts.cfg;
  if (!cfg) throw new Error('createStageAssetStore: cfg is required');
  const loadAsset = opts.loadAsset;
  if (!loadAsset) throw new Error('createStageAssetStore: loadAsset is required');
  const inline = opts.inline ? createInlineSource(opts.inline) : null;
  const fetchBytes = opts.fetchBytes ?? (inline ? (u) => inline.fetchBytes(u) : fetchBytesWithProgress);
  const onProgress = opts.onProgress ?? null;
  const createLoader = opts.createLoader
    ?? (async (o) => (await import('./gltf-loader-stack.js')).createHeroGltfLoader(o));
  const bakeEnv = opts.bakeEnv ?? bakeStageEnvironment;
  const now = opts.now ?? (() => performance.now());
  const log = opts.log ?? ((m) => console.info(m));
  let asset = null;
  let env = null;
  let level = 0;
  let pending = null;
  let version = 0;
  /** One row per load: { asset, file, level, bytes, fetchMs, decodeMs, envMs, draws, ok, error } */
  const stats = [];

  async function load({ tier, renderer, lite = false }) {
    const row = { asset: cfg.id, file: '', level: 0, bytes: 0, fetchMs: 0, decodeMs: 0, envMs: 0, draws: 0, ok: false, error: '' };
    stats.push(row);
    let stack = null;
    try {
      const entry = stageEntry(JSON.parse(new TextDecoder().decode(await fetchBytes(cfg.base + cfg.manifest))), cfg.id);
      const pick = stageChoice(entry, tier, cfg, !!inline || lite === true); // lite: the game asked (slow link)
      row.file = pick.file;
      row.level = pick.level;
      const manager = new THREE.LoadingManager();
      if (inline) manager.setURLModifier((u) => inline.urlModifier(u));
      stack = await createLoader({ renderer, transcoderPath: cfg.transcoderPath, manager });
      const a = now();
      const report = onProgress ? (loaded, total) => onProgress({ id: cfg.id, loaded, total: total || entry.bytes || 0 }) : null;
      const bytes = await fetchBytes(cfg.base + pick.file, report);
      row.bytes = bytes.byteLength;
      if (onProgress) onProgress({ id: cfg.id, loaded: row.bytes, total: row.bytes });
      row.fetchMs = now() - a;
      const b = now();
      const loaded = await loadAsset(bytes, { loader: stack.loader, levels: entry.lods.map((l) => l.level), cfg });
      row.decodeMs = now() - b;
      row.draws = loaded.draws(pick.level);
      const c = now();
      try {
        env = renderer ? bakeEnv(renderer, loaded, { cfg }) : null;
      } catch (e) {
        log(`[stage] PMREM bake failed, procedural environment: ${e.message ?? e}`);
      }
      row.envMs = now() - c;
      asset = loaded;
      level = pick.level;
      row.ok = true;
      version++;
    } catch (e) {
      row.error = String(e.message ?? e);
    } finally {
      stack?.dispose();
    }
    log(`[stage] ${cfg.id} ${row.ok ? 'ok' : `FAILED (${row.error}), fallback stage`} ${row.file} lod${row.level} ${row.draws} draws ${row.bytes} B fetch ${row.fetchMs.toFixed(0)} ms decode ${row.decodeMs.toFixed(0)} ms env ${row.envMs.toFixed(0)} ms`);
  }

  return {
    /**
     * Start loading (once). The tier fixes the LOD and the full/lite file for the session (lite: true forces the
     * lite file whatever the tier, e.g. on a slow link). Never rejects.
     * @param {{tier: string, renderer: any, lite?: boolean}} o
     */
    preload(o) {
      if (!pending) pending = opts.enabled === false ? Promise.resolve() : load(o).catch((e) => log(`[stage] preload error ${e}`));
      return pending;
    },
    /** Wait for the preload, at most `ms`. @param {number} ms @returns {Promise<boolean>} true when done in time */
    whenReady(ms) {
      if (!pending) return Promise.resolve(false);
      let done = false;
      return Promise.race([pending.then(() => (done = true)), new Promise((r) => setTimeout(() => r(done), ms))]);
    },
    /** The loaded stage asset, or null (fallback stage). */
    get: () => asset,
    /** The LOD level chosen at preload. */
    get level() { return level; },
    /** The stage PMREM environment texture, or null (keep the procedural one). */
    env: () => env?.texture ?? null,
    /** Bumps when the stage arrives: part of the scene key so the next build picks it up. */
    get version() { return version; },
    stats,
    /** Free the stage asset and its environment (app teardown). Idempotent. */
    dispose() {
      asset?.dispose();
      env?.dispose();
      asset = null;
      env = null;
    },
  };
}
