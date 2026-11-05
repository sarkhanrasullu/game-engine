// Session store for runtime glTF heroes (engine /assets, ADR-0003 §Pipeline 2): fetches the manifest
// and each enabled fighter's .glb, decodes it once (meshopt + KTX2 in workers), and hands the asset to
// every later scene build. Never rejects: a hero that fails to fetch, decode or validate is recorded
// and its fighter stays procedural. Download and decode times are measured per hero.
// 0.5.1 (UX-2, heroes on demand): heroes load ONE AT A TIME through a priority queue. `load(id)` enqueues a
// fighter (an id asked again moves to the front: the hero the player just swiped to downloads next),
// `preload()` enqueues every configured fighter in order (the 0.5.0 behaviour), `whenLoaded(id, ms)` is
// the per-hero bounded wait and `onProgress({ id, loaded, total })` reports download bytes as they stream.
// 0.5.2 (BOOT-NET): the queue is a download lane (./download-lane.js) that can be SHARED with the stage store
// and the sample bank (`opts.lane`), so every stream of the session is ordered by one scheduler. A hero holds
// the lane through its decode as in 0.5.1: the next hero starts when this one has settled, and at most one
// decode runs at a time across the stores sharing the lane. `load()` promotes its hero to the front and may PREEMPT the download in flight when it is barely started
// (`opts.preemptBelow`: the fraction below which an in-flight DOWNLOAD is aborted and re-queued behind the
// promoted one; a decode is never preempted); `lite` may be a function, read when the fetch starts (a throughput rule decided after the
// queue was built still applies to every hero not yet started); `opts.transcoder` (./transcoder-warm.js)
// routes the KTX2 transcoder files to blobs fetched at boot.
// Inline mode: when the page carries an inline asset table (a single-file artifact), files come from
// it and the basis transcoder is served from blob: URLs through the LoadingManager URL modifier.
// Not thread-safe (main thread only).
import * as THREE from 'three';
import { heroFileForTier, parseHeroManifest } from './manifest.js';
import { loadHeroAsset } from './hero-asset.js';
import { createDownloadLane } from './download-lane.js';

/** Decode one inline table entry ({type: 'text'|'base64', data}) to bytes. */
function inlineBytes(e) {
  if (e.type === 'text') return new TextEncoder().encode(e.data);
  const bin = atob(e.data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Inline asset source for a single-file artifact: fetchBytes for the table's paths and a URL
 * modifier that maps them to blob: URLs (the KTX2Loader fetches its transcoder through it).
 * @param {Record<string, {type: 'text'|'base64', data: string}>} table path (e.g. 'heroes/manifest.json') -> entry
 * @example const inline = createInlineSource(window.__INLINE_ASSETS__); manager.setURLModifier(inline.urlModifier);
 */
export function createInlineSource(table) {
  const blobs = new Map();
  const find = (url) => Object.keys(table).find((k) => url === k || url.endsWith(`/${k}`));
  return {
    has: (url) => !!find(url),
    /** @param {string} url @returns {Promise<ArrayBuffer>} */
    async fetchBytes(url) {
      const k = find(url);
      if (!k) throw new Error(`inline asset ${url} not found`);
      const b = inlineBytes(table[k]);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    /** LoadingManager URL modifier: inline paths -> blob: URLs (made once, kept for the session). */
    urlModifier(url) {
      const k = find(url);
      if (!k) return url;
      if (!blobs.has(k)) blobs.set(k, URL.createObjectURL(new Blob([inlineBytes(table[k])])));
      return blobs.get(k);
    },
  };
}

/**
 * Network fetch of a URL as an ArrayBuffer (rejects on HTTP errors). With `onBytes` the body is read as
 * a stream and `onBytes(loaded, total)` fires per chunk (total = Content-Length, or 0 when unknown);
 * without it (or without a readable body) it is one arrayBuffer() call, as before. `o.signal` (0.5.2) aborts
 * the request (the download lane's preemption); the rejection is the fetch's own AbortError.
 * @param {string} url
 * @param {((loaded: number, total: number) => void) | null} [onBytes]
 * @param {{signal?: AbortSignal | null}} [o]
 * @returns {Promise<ArrayBuffer>}
 * @example const bytes = await fetchBytesWithProgress('heroes/a.glb', (loaded, total) => bar.set(loaded / total));
 */
export async function fetchBytesWithProgress(url, onBytes = null, { signal = null } = {}) {
  const r = await fetch(url, signal ? { signal } : undefined);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  if (!onBytes || !r.body || typeof r.body.getReader !== 'function') return r.arrayBuffer();
  const total = Number(r.headers?.get?.('content-length')) || 0;
  const reader = r.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onBytes(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/** Load status of a fighter slot in the store. */
export const HERO_LOAD = Object.freeze({ IDLE: 'idle', LOADING: 'loading', OK: 'ok', FAILED: 'failed' });

/** Default lane priority of a hero download (lower = sooner; the stage store uses 20, the sample bank 30). */
export const HERO_LANE_PRIORITY = 10;

/**
 * Create the hero asset store.
 * @param {{cfg: {base: string, manifest: string, transcoderPath: string, lodByTier: Record<string, number>,
 *     liteTiers: readonly string[], fighters: Record<string, {asset: string}>, looks?: Record<string, object>},
 *   fighters: string[], inline?: Record<string, any>|null,
 *   fetchBytes?: (url: string, onBytes?: ((loaded: number, total: number) => void) | null, o?: {signal?: AbortSignal | null}) => Promise<ArrayBuffer>,
 *   createLoader?: (opts: {renderer: any, transcoderPath: string, manager: THREE.LoadingManager}) => Promise<{loader: any, dispose: () => void}>,
 *   loadAsset?: typeof loadHeroAsset,
 *   onProgress?: (p: {id: string, loaded: number, total: number}) => void,
 *   lane?: ReturnType<typeof createDownloadLane>, priority?: number, preemptBelow?: number,
 *   transcoder?: {urlModifier: (url: string) => string, start?: () => Promise<boolean>} | null,
 *   now?: () => number, log?: (msg: string) => void}} opts
 *   cfg: the game's hero asset config (where files are served from, tier rules, fighter id -> manifest id).
 *   fighters: fighter ids the store may load (preload() loads them all; load() one). createLoader: defaults
 *   to the lazy ./gltf-loader-stack.js. loadAsset: defaults to loadHeroAsset (a test seam). onProgress: download
 *   bytes per fighter id as they stream (total: Content-Length, else the manifest's `bytes`, else 0).
 *   lane: a shared download lane (default: the store's own); priority: this store's lane priority (10);
 *   preemptBelow: a hero load() promotes its hero and aborts the hero in flight when less than this fraction
 *   of it has arrived (0 = never, the default); transcoder: a createTranscoderWarm() (blob transcoder files; a
 *   decode waits for its start() to settle, so the loader never fetches the same files a second time).
 * @example
 *   const heroes = createHeroAssetStore({ cfg: HERO_CONFIG, fighters: ['fighter-a', 'fighter-b'], onProgress: (p) => bar.set(p) });
 *   heroes.load('fighter-b', { tier: 'high', renderer }); // the visible hero first
 *   await heroes.whenLoaded('fighter-b', 6000); heroes.get('fighter-b'); // asset or null (procedural fallback)
 *   heroes.preload({ tier: 'high', renderer }); // then everyone else, in config order
 * @example
 *   // BOOT-NET: one lane for heroes, stage and bank; lite decided by a throughput rule; swipes preempt
 *   const lane = createDownloadLane();
 *   const heroes = createHeroAssetStore({ cfg, fighters, lane, preemptBelow: 0.34, transcoder });
 *   heroes.preload({ tier: 'high', renderer, lite: () => net.lite() });
 */
export function createHeroAssetStore(opts) {
  const cfg = opts.cfg;
  if (!cfg) throw new Error('createHeroAssetStore: cfg is required');
  const inline = opts.inline ? createInlineSource(opts.inline) : null;
  const fetchBytes = opts.fetchBytes ?? (inline ? (u) => inline.fetchBytes(u) : fetchBytesWithProgress);
  const createLoader = opts.createLoader
    ?? (async (o) => (await import('./gltf-loader-stack.js')).createHeroGltfLoader(o));
  const loadAsset = opts.loadAsset ?? loadHeroAsset;
  const onProgress = opts.onProgress ?? null;
  const now = opts.now ?? (() => performance.now());
  const log = opts.log ?? ((m) => console.info(m));
  const lane = opts.lane ?? createDownloadLane();
  const priority = opts.priority ?? HERO_LANE_PRIORITY;
  const preemptBelow = opts.preemptBelow ?? 0;
  const transcoder = opts.transcoder ?? null;
  const jobId = (fighter) => `hero:${fighter}`;
  /** fighter id -> asset */
  const assets = new Map();
  /** One row per hero attempt: { fighter, asset, file, bytes, fetchMs, decodeMs, ok, error, warnings, preempted } */
  const stats = [];
  /** fighter id -> { status, promise, resolve } */
  const slots = new Map();
  /** fighter id -> fraction of the in-flight download that has arrived; present only while its bytes are on the wire */
  const fraction = new Map();
  let pending = null;
  let version = 0;
  let manifestP = null;
  let stack = null;
  let stackP = null;
  let queued = 0;
  let loadOpts = null;

  /** The manifest, fetched once per session (null when it failed: every hero stays procedural). */
  function manifest() {
    if (!manifestP) {
      manifestP = (async () => {
        try {
          return parseHeroManifest(JSON.parse(new TextDecoder().decode(await fetchBytes(cfg.base + cfg.manifest))));
        } catch (e) {
          stats.push({ fighter: '*', asset: 'manifest', ok: false, error: String(e.message ?? e) });
          log(`[heroes] manifest unavailable, procedural fighters: ${e.message ?? e}`);
          return null;
        }
      })();
    }
    return manifestP;
  }

  /** The loader stack, built once per burst of loads and freed when the queue drains (workers are not kept idle). */
  function ensureStack(renderer) {
    if (stack) return Promise.resolve(stack);
    if (!stackP) {
      const manager = new THREE.LoadingManager();
      if (inline || transcoder) {
        manager.setURLModifier((u) => {
          const v = inline ? inline.urlModifier(u) : u;
          return transcoder && v === u ? transcoder.urlModifier(u) : v;
        });
      }
      stackP = createLoader({ renderer, transcoderPath: cfg.transcoderPath, manager }).then((s) => { stack = s; return s; }, (e) => {
        stats.push({ fighter: '*', asset: 'loader', ok: false, error: String(e.message ?? e) });
        log(`[heroes] loader unavailable, procedural fighters: ${e.message ?? e}`);
        return null;
      }).finally(() => { stackP = null; });
    }
    return stackP;
  }
  /** Free the workers once no hero of this store is queued (the lane may still be busy with other stores' jobs). */
  function releaseStackIfIdle() {
    if (queued === 0 && stack) {
      stack.dispose();
      stack = null;
    }
  }

  /** One hero, as one lane job: manifest (first time), loader, bytes, decode. Rejects only on an abort (the lane re-queues it). */
  async function loadOne(fighter, { tier, renderer, lite = false }, signal) {
    const t0 = now();
    const m = await manifest();
    const assetId = cfg.fighters[fighter]?.asset;
    const entry = m && assetId ? m.get(assetId) : undefined;
    const row = { fighter, asset: assetId ?? '?', file: '', bytes: 0, fetchMs: 0, decodeMs: 0, ok: false, error: '', warnings: [], preempted: false };
    stats.push(row);
    if (!m) {
      row.error = 'manifest unavailable';
      return;
    }
    if (!entry) {
      row.error = 'not in manifest';
      return;
    }
    const s = await ensureStack(renderer);
    if (!s) {
      row.error = 'loader unavailable';
      return;
    }
    try {
      // Lite file (1024² maps) in an inline artifact, on a lite tier, or when the game asks (slow link: o.lite,
      // a boolean or a function read now, so a rule decided after the queue was built still applies).
      const liteNow = typeof lite === 'function' ? lite() === true : lite === true;
      const { file } = (inline || liteNow) && entry.lite ? { file: entry.lite.file } : heroFileForTier(entry, tier, cfg);
      row.file = file;
      const a = now();
      fraction.set(fighter, 0);
      const report = (loaded, total) => {
        const t = total || entry.bytes || 0;
        if (t > 0) fraction.set(fighter, loaded / t);
        if (onProgress) onProgress({ id: fighter, loaded, total: t });
      };
      const bytes = await fetchBytes(cfg.base + file, report, { signal });
      fraction.delete(fighter);
      row.bytes = bytes.byteLength;
      row.fetchMs = now() - a;
      if (onProgress) onProgress({ id: fighter, loaded: row.bytes, total: row.bytes });
      if (transcoder?.start) await transcoder.start();
      const b = now();
      const asset = await loadAsset(bytes, { tier, loader: s.loader, id: assetId, cfg });
      row.decodeMs = now() - b;
      row.warnings = asset.warnings;
      row.ok = true;
      assets.set(fighter, asset);
      version++;
    } catch (e) {
      fraction.delete(fighter);
      if (signal?.aborted) {
        row.preempted = true;
        row.error = 'preempted';
        throw e;
      }
      row.error = String(e.message ?? e);
    }
    log(`[heroes] ${fighter}/${row.asset} ${row.ok ? 'ok' : `FAILED (${row.error}), procedural`} ${row.file} ${row.bytes} B fetch ${row.fetchMs.toFixed(0)} ms decode ${row.decodeMs.toFixed(0)} ms (${(now() - t0).toFixed(0)} ms queued to done)`);
  }

  /** Queue a fighter's hero in the lane; its slot settles inside the job, before the lane moves on. */
  function schedule(fighter, slot) {
    queued++;
    const settle = () => {
      queued--;
      slot.status = assets.has(fighter) ? HERO_LOAD.OK : HERO_LOAD.FAILED;
      slot.resolve(assets.get(fighter) ?? null);
      releaseStackIfIdle();
    };
    lane.add({
      id: jobId(fighter),
      priority,
      run: async ({ signal }) => {
        try {
          await loadOne(fighter, loadOpts, signal);
        } catch (e) {
          if (signal?.aborted) throw e; // preempted: the lane re-queues this job, the slot stays open
          log(`[heroes] ${fighter} load error ${e}`);
        }
        settle();
      },
      // Only bytes on the wire can be preempted (not the manifest wait, not a decode).
      preempt: preemptBelow > 0 ? () => fraction.has(fighter) && fraction.get(fighter) < preemptBelow : null,
    }).catch((e) => { log(`[heroes] ${fighter} lane error ${e}`); settle(); });
  }

  /**
   * Queue one fighter's hero (front of the queue; asking again for a queued hero moves it to the front and,
   * with `preemptBelow`, aborts a barely-started download in flight). Resolves with the asset, or null when
   * it failed (never rejects). A settled fighter resolves at once.
   * @param {string} fighter fighter id (a cfg.fighters key)
   * @param {{tier: string, renderer: any, lite?: boolean | (() => boolean)}} [o] tier fixes LOD and lite/full maps (lite: true, or a
   *   function read when the fetch starts, forces the lite file whatever the tier, e.g. on a slow link); the first call's options stick for the session
   * @param {{preempt?: boolean}} [how] preempt: false moves the hero up without aborting the download in flight
   *   (a fight start promoting the rival must not abort the player's own hero)
   * @returns {Promise<object|null>}
   */
  function load(fighter, o = loadOpts, { preempt = true } = {}) {
    const slot = slots.get(fighter);
    if (slot) {
      if (slot.status === HERO_LOAD.LOADING) lane.promote(jobId(fighter), { preempt });
      return slot.promise;
    }
    return enqueue(fighter, o, true, preempt);
  }

  /** Make a fighter's slot and queue it (front or back). The lane starts on a microtask so a burst of calls keeps its order. */
  function enqueue(fighter, o, front, preempt = true) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const slot = { status: HERO_LOAD.LOADING, promise, resolve };
    slots.set(fighter, slot);
    if (!cfg.fighters[fighter] || !opts.fighters.includes(fighter)) {
      // Not a hero slot of this session (disabled or unknown): procedural, settled at once.
      slot.status = HERO_LOAD.FAILED;
      resolve(null);
      return promise;
    }
    if (!loadOpts) loadOpts = o ?? { tier: 'high', renderer: null };
    schedule(fighter, slot);
    if (front) lane.promote(jobId(fighter), { preempt });
    return promise;
  }

  return {
    load,
    /**
     * Queue every configured fighter in order (behind anything already queued) and resolve when all of them
     * have loaded or failed; never rejects. Same call twice returns the same promise.
     * @param {{tier: string, renderer: any, lite?: boolean | (() => boolean)}} o tier name fixes lite/full maps for the session (lite: force the lite file)
     */
    preload(o) {
      if (!pending) {
        if (!loadOpts) loadOpts = o;
        const all = [];
        for (const fighter of opts.fighters) {
          if (!slots.has(fighter)) enqueue(fighter, o, false);
          all.push(slots.get(fighter).promise);
        }
        pending = Promise.all(all).then(() => { log(`[heroes] preload done (${stats.filter((s) => s.ok).length}/${opts.fighters.length} ok)`); });
      }
      return pending;
    },
    /**
     * Wait for the preload, at most `ms` (also resolves at once if preload never started).
     * @param {number} ms @returns {Promise<boolean>} true when the preload finished in time
     */
    whenReady(ms) {
      if (!pending) return Promise.resolve(false);
      let done = false;
      return Promise.race([pending.then(() => (done = true)), new Promise((r) => setTimeout(() => r(done), ms))]);
    },
    /**
     * Wait for one fighter's load to settle (ok or failed), at most `ms` (no bound when omitted). Never
     * reorders the queue: the way to SUBSCRIBE to a hero without asking for it next (load() moves it to the
     * front). A fighter never asked for resolves false at once (nothing is loading it).
     * @param {string} fighter @param {number} [ms] @returns {Promise<boolean>} true when settled in time
     */
    whenLoaded(fighter, ms = Infinity) {
      const slot = slots.get(fighter);
      if (!slot) return Promise.resolve(false);
      if (!Number.isFinite(ms)) return slot.promise.then(() => true);
      let done = false;
      return Promise.race([slot.promise.then(() => (done = true)), new Promise((r) => setTimeout(() => r(done), ms))]);
    },
    /** Load status of a fighter: HERO_LOAD.IDLE (never asked), LOADING, OK or FAILED. @param {string} fighter */
    status: (fighter) => slots.get(fighter)?.status ?? HERO_LOAD.IDLE,
    /** The loaded asset of a fighter, or null (procedural fallback). @param {string} fighterId */
    get: (fighterId) => assets.get(fighterId) ?? null,
    /** The download lane this store schedules on (shared or its own). */
    lane,
    /** Bumps whenever an asset arrives: part of the scene key so the next build picks it up. */
    get version() { return version; },
    stats,
    /** Free every asset's maps and geometry (app teardown). */
    dispose() {
      for (const a of assets.values()) a.dispose();
      assets.clear();
    },
  };
}
