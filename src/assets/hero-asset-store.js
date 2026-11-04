// Session store for runtime glTF heroes (engine /assets, ADR-0003 §Pipeline 2): fetches the manifest
// and each enabled fighter's .glb, decodes it once (meshopt + KTX2 in workers), and hands the asset to
// every later scene build. Never rejects: a hero that fails to fetch, decode or validate is recorded
// and its fighter stays procedural. Download and decode times are measured per hero.
// Inline mode: when the page carries an inline asset table (a single-file artifact), files come from
// it and the basis transcoder is served from blob: URLs through the LoadingManager URL modifier.
// Not thread-safe (main thread only).
import * as THREE from 'three';
import { heroFileForTier, parseHeroManifest } from './manifest.js';
import { loadHeroAsset } from './hero-asset.js';

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

/** Network fetch of a URL as an ArrayBuffer (rejects on HTTP errors). */
async function fetchNetwork(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

/**
 * Create the hero asset store.
 * @param {{cfg: {base: string, manifest: string, transcoderPath: string, lodByTier: Record<string, number>,
 *     liteTiers: readonly string[], fighters: Record<string, {asset: string}>, looks?: Record<string, object>},
 *   fighters: string[], inline?: Record<string, any>|null,
 *   fetchBytes?: (url: string) => Promise<ArrayBuffer>,
 *   createLoader?: (opts: {renderer: any, transcoderPath: string, manager: THREE.LoadingManager}) => Promise<{loader: any, dispose: () => void}>,
 *   loadAsset?: typeof loadHeroAsset,
 *   now?: () => number, log?: (msg: string) => void}} opts
 *   cfg: the game's hero asset config (where files are served from, tier rules, fighter id -> manifest id).
 *   fighters: fighter ids to load. createLoader: defaults to the lazy ./gltf-loader-stack.js.
 *   loadAsset: defaults to loadHeroAsset (a test seam).
 * @example
 *   const heroes = createHeroAssetStore({ cfg: HERO_CONFIG, fighters: ['fighter-a'] });
 *   heroes.preload({ tier: 'high', renderer });
 *   await heroes.whenReady(6000); heroes.get('fighter-a'); // asset or null (procedural fallback)
 */
export function createHeroAssetStore(opts) {
  const cfg = opts.cfg;
  if (!cfg) throw new Error('createHeroAssetStore: cfg is required');
  const inline = opts.inline ? createInlineSource(opts.inline) : null;
  const fetchBytes = opts.fetchBytes ?? (inline ? (u) => inline.fetchBytes(u) : fetchNetwork);
  const createLoader = opts.createLoader
    ?? (async (o) => (await import('./gltf-loader-stack.js')).createHeroGltfLoader(o));
  const loadAsset = opts.loadAsset ?? loadHeroAsset;
  const now = opts.now ?? (() => performance.now());
  const log = opts.log ?? ((m) => console.info(m));
  /** fighter id -> asset */
  const assets = new Map();
  /** One row per hero: { fighter, asset, file, bytes, fetchMs, decodeMs, ok, error, warnings } */
  const stats = [];
  let pending = null;
  let version = 0;

  async function loadAll({ tier, renderer }) {
    const t0 = now();
    let manifest;
    try {
      manifest = parseHeroManifest(JSON.parse(new TextDecoder().decode(await fetchBytes(cfg.base + cfg.manifest))));
    } catch (e) {
      stats.push({ fighter: '*', asset: 'manifest', ok: false, error: String(e.message ?? e) });
      log(`[heroes] manifest unavailable, procedural fighters: ${e.message ?? e}`);
      return;
    }
    const manager = new THREE.LoadingManager();
    if (inline) manager.setURLModifier((u) => inline.urlModifier(u));
    let stack = null;
    try {
      stack = await createLoader({ renderer, transcoderPath: cfg.transcoderPath, manager });
    } catch (e) {
      stats.push({ fighter: '*', asset: 'loader', ok: false, error: String(e.message ?? e) });
      log(`[heroes] loader unavailable, procedural fighters: ${e.message ?? e}`);
      return;
    }
    for (const fighter of opts.fighters) {
      const assetId = cfg.fighters[fighter]?.asset;
      const entry = assetId ? manifest.get(assetId) : undefined;
      const row = { fighter, asset: assetId ?? '?', file: '', bytes: 0, fetchMs: 0, decodeMs: 0, ok: false, error: '', warnings: [] };
      stats.push(row);
      if (!entry) {
        row.error = 'not in manifest';
        continue;
      }
      try {
        const { file } = inline && entry.lite ? { file: entry.lite.file } : heroFileForTier(entry, tier, cfg);
        row.file = file;
        const a = now();
        const bytes = await fetchBytes(cfg.base + file);
        row.bytes = bytes.byteLength;
        row.fetchMs = now() - a;
        const b = now();
        const asset = await loadAsset(bytes, { tier, loader: stack.loader, id: assetId, cfg });
        row.decodeMs = now() - b;
        row.warnings = asset.warnings;
        row.ok = true;
        assets.set(fighter, asset);
        version++;
      } catch (e) {
        row.error = String(e.message ?? e);
      }
      log(`[heroes] ${fighter}/${row.asset} ${row.ok ? 'ok' : `FAILED (${row.error}), procedural`} ${row.file} ${row.bytes} B fetch ${row.fetchMs.toFixed(0)} ms decode ${row.decodeMs.toFixed(0)} ms`);
    }
    stack.dispose();
    log(`[heroes] preload done in ${(now() - t0).toFixed(0)} ms`);
  }

  return {
    /**
     * Start loading (once). Resolves when every hero has loaded or failed; never rejects.
     * @param {{tier: string, renderer: any}} o tier name fixes lite/full maps for the session
     */
    preload(o) {
      if (!pending) pending = opts.fighters.length ? loadAll(o).catch((e) => log(`[heroes] preload error ${e}`)) : Promise.resolve();
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
    /** The loaded asset of a fighter, or null (procedural fallback). @param {string} fighterId */
    get: (fighterId) => assets.get(fighterId) ?? null,
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
