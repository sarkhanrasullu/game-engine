// Session store for the runtime glTF stage (engine /assets, story PRO-3 / story-013): fetches the stage
// manifest and the tier's .glb (full or lite, lite always in a single-file artifact), decodes it once
// with the meshopt + KTX2 loader stack, binds the stage's node / material contract through the injected
// `loadAsset` and bakes the PMREM environment the fighters' metal reflects (injected `bakeEnv`). Never
// rejects: a stage that fails to fetch, decode or validate is recorded and the game keeps its fallback
// stage and procedural environment. 0.5.2 (BOOT-NET): the fetch runs through a download lane that may be
// shared with the hero store and the sample bank (`opts.lane`, priority 20 by default: behind the heroes,
// ahead of the audio), `lite` may be a function read when the fetch starts, `opts.preemptBelow` lets a
// promoted hero abort a barely-started stage download (it re-queues behind), and `opts.transcoder` routes
// the KTX2 transcoder to blobs fetched at boot. Not thread-safe (main thread only).
import * as THREE from 'three';
import { createInlineSource, fetchBytesWithProgress } from './hero-asset-store.js';
import { stageChoice, stageEntry } from './stage-manifest.js';
import { bakeStageEnvironment } from '../render/environment.js';
import { createDownloadLane } from './download-lane.js';

/** Default lane priority of the stage download (behind the heroes at 10, ahead of the sample bank at 30). */
export const STAGE_LANE_PRIORITY = 20;

/**
 * Create the stage asset store.
 * @param {{cfg: {id: string, base: string, manifest: string, transcoderPath: string, lodByTier: Record<string, number>,
 *     liteTiers: readonly string[], fog: object, env: object},
 *   loadAsset: (bytes: ArrayBuffer, o: {loader: any, levels: number[], cfg: object}) => Promise<any>,
 *   inline?: Record<string, any>|null, enabled?: boolean,
 *   fetchBytes?: (url: string, onBytes?: ((loaded: number, total: number) => void) | null, o?: {signal?: AbortSignal | null}) => Promise<ArrayBuffer>,
 *   createLoader?: (o: {renderer: any, transcoderPath: string, manager: THREE.LoadingManager}) => Promise<{loader: any, dispose: () => void}>,
 *   bakeEnv?: (renderer: any, asset: any, o: {cfg: object}) => {texture: any, dispose: () => void} | null,
 *   onProgress?: (p: {id: string, loaded: number, total: number}) => void,
 *   lane?: ReturnType<typeof createDownloadLane>, priority?: number, preemptBelow?: number,
 *   transcoder?: {urlModifier: (url: string) => string, start?: () => Promise<boolean>} | null,
 *   now?: () => number, log?: (msg: string) => void}} opts
 *   cfg: the game's stage asset config (where files are served from, tier rules, the id to load). loadAsset: the
 *   game's stage loader (loadStageAsset or a per-stage variant: validates the glTF and binds the stage's
 *   node pattern and materials bound). enabled: false skips the load (fallback stage). createLoader
 *   defaults to the lazy ./gltf-loader-stack.js; bakeEnv to ../render/environment.js. onProgress (0.5.1):
 *   download bytes as they stream (id = cfg.id). lane / priority / preemptBelow / transcoder (0.5.2): see above.
 * @example
 *   const stages = createStageAssetStore({ cfg: STAGE_CONFIG, loadAsset: loadStageAsset, inline: window.__INLINE_ASSETS__ ?? null });
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
  const lane = opts.lane ?? createDownloadLane();
  const priority = opts.priority ?? STAGE_LANE_PRIORITY;
  const preemptBelow = opts.preemptBelow ?? 0;
  const transcoder = opts.transcoder ?? null;
  const jobId = `stage:${cfg.id}`;
  let asset = null;
  let env = null;
  let level = 0;
  let pending = null;
  let version = 0;
  /** Fraction of the stage file that has arrived, while its bytes are on the wire (null otherwise: not preemptible). */
  let fraction = null;
  /** One row per load attempt: { asset, file, level, bytes, fetchMs, decodeMs, envMs, draws, ok, error, preempted } */
  const stats = [];

  /** The stage, as one lane job: manifest, loader, bytes, decode, bake. Rejects only on an abort (the lane re-queues it). */
  async function load({ tier, renderer, lite = false }, signal) {
    const row = { asset: cfg.id, file: '', level: 0, bytes: 0, fetchMs: 0, decodeMs: 0, envMs: 0, draws: 0, ok: false, error: '', preempted: false };
    stats.push(row);
    let stack = null;
    try {
      const entry = stageEntry(JSON.parse(new TextDecoder().decode(await fetchBytes(cfg.base + cfg.manifest))), cfg.id);
      const liteNow = typeof lite === 'function' ? lite() === true : lite === true;
      const pick = stageChoice(entry, tier, cfg, !!inline || liteNow); // lite: the game asked (slow link)
      row.file = pick.file;
      row.level = pick.level;
      const manager = new THREE.LoadingManager();
      if (inline || transcoder) {
        manager.setURLModifier((u) => {
          const v = inline ? inline.urlModifier(u) : u;
          return transcoder && v === u ? transcoder.urlModifier(u) : v;
        });
      }
      stack = await createLoader({ renderer, transcoderPath: cfg.transcoderPath, manager });
      const a = now();
      fraction = 0;
      const report = (loaded, total) => {
        const t = total || entry.bytes || 0;
        if (t > 0) fraction = loaded / t;
        if (onProgress) onProgress({ id: cfg.id, loaded, total: t });
      };
      const bytes = await fetchBytes(cfg.base + pick.file, report, { signal });
      fraction = null;
      row.bytes = bytes.byteLength;
      if (onProgress) onProgress({ id: cfg.id, loaded: row.bytes, total: row.bytes });
      row.fetchMs = now() - a;
      if (transcoder?.start) await transcoder.start();
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
      fraction = null;
      if (signal?.aborted) {
        row.preempted = true;
        row.error = 'preempted';
        throw e;
      }
      row.error = String(e.message ?? e);
    } finally {
      stack?.dispose();
    }
    log(`[stage] ${cfg.id} ${row.ok ? 'ok' : `FAILED (${row.error}), fallback stage`} ${row.file} lod${row.level} ${row.draws} draws ${row.bytes} B fetch ${row.fetchMs.toFixed(0)} ms decode ${row.decodeMs.toFixed(0)} ms env ${row.envMs.toFixed(0)} ms`);
  }

  /** Queue the load in the lane (only bytes on the wire can be preempted). */
  function enqueue(o) {
    return lane.add({
      id: jobId,
      priority,
      run: ({ signal }) => load(o, signal),
      preempt: preemptBelow > 0 ? () => fraction !== null && fraction < preemptBelow : null,
    });
  }

  return {
    /**
     * Start loading (once). The tier fixes the LOD and the full/lite file for the session (lite: true, or a
     * function read when the fetch starts, forces the lite file whatever the tier, e.g. on a slow link). Never rejects.
     * @param {{tier: string, renderer: any, lite?: boolean | (() => boolean)}} o
     */
    preload(o) {
      if (!pending) pending = opts.enabled === false ? Promise.resolve() : enqueue(o).catch((e) => log(`[stage] preload error ${e}`));
      return pending;
    },
    /**
     * Move a queued stage to the front of the lane (a fight is starting). No-op when not queued.
     * @param {{preempt?: boolean}} [how] preempt: false leaves the download in flight alone
     * @returns {boolean} true when the stage is still loading
     */
    promote: (how) => lane.promote(jobId, how),
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
    /** The download lane this store schedules on (shared or its own). */
    lane,
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
