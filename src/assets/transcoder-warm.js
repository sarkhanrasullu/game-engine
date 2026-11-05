// Basis transcoder warm-up (engine /assets, 0.5.2 BOOT-NET). The KTX2Loader fetches its transcoder
// (basis_transcoder.js + .wasm, ~585 KB) lazily inside the FIRST texture transcode, i.e. after the first
// hero's bytes have landed — on a 3G link that is 3-11 s of "decode" that is really a download. This fetches
// both files at boot (in parallel with the data tables, `fetch(url, { priority: 'high' })` where supported),
// keeps them as blob: URLs and starts the lazy gltf-loader-stack chunk's import (a fetch, not a static import:
// the chunk stays out of the boot bundle); the stores route the loader's LoadingManager URL modifier through
// `urlModifier()`, so the KTX2Loader's own FileLoader reads the files from memory (FileLoader resolves every
// URL through manager.resolveURL — verified against three r187 KTX2Loader.init / FileLoader.load). Every later
// loader stack reuses the same blobs, so a bursty session never re-downloads the transcoder either. The stores
// wait for start() to settle before their first decode, so the loader cannot race the warm into a second
// download. Never rejects: a failed warm leaves the modifier transparent and the loader fetches as before.
// Main thread only.

/** The two transcoder files three's KTX2Loader loads from `transcoderPath`. */
export const TRANSCODER_FILES = Object.freeze(['basis_transcoder.js', 'basis_transcoder.wasm']);

/**
 * Create the warm-up. Nothing is fetched until `start()`.
 * @param {{transcoderPath: string, fetch?: typeof fetch, createObjectURL?: (blob: Blob) => string,
 *   revokeObjectURL?: (url: string) => void, loadStack?: (() => Promise<unknown>) | null}} opts
 *   transcoderPath: the same value the stores' cfg carries (e.g. 'basis/'); fetch / createObjectURL / loadStack: test seams.
 * @returns {{start: () => Promise<boolean>, urlModifier: (url: string) => string, dispose: () => void}}
 * @example
 *   const transcoder = createTranscoderWarm({ transcoderPath: 'basis/' });
 *   transcoder.start(); // at boot, beside the data tables
 *   const heroes = createHeroAssetStore({ cfg, fighters, transcoder }); // the store chains transcoder.urlModifier
 */
export function createTranscoderWarm({ transcoderPath, fetch = globalThis.fetch?.bind(globalThis), createObjectURL = (b) => URL.createObjectURL(b), revokeObjectURL = (u) => URL.revokeObjectURL(u), loadStack = () => import('./gltf-loader-stack.js') }) {
  /** file -> blob: URL, complete or empty */
  const blobs = new Map();
  let startP = null;

  function clear() {
    for (const u of blobs.values()) revokeObjectURL(u);
    blobs.clear();
  }
  async function warm() {
    // The chunk is an optimisation here: the store imports it again itself and reports a real failure.
    if (loadStack) loadStack().catch(() => {});
    if (typeof fetch !== 'function') return false;
    try {
      const urls = await Promise.all(TRANSCODER_FILES.map(async (file) => {
        const res = await fetch(transcoderPath + file, { priority: 'high' });
        if (!res?.ok) throw new Error(file);
        return createObjectURL(await res.blob());
      }));
      TRANSCODER_FILES.forEach((file, i) => blobs.set(file, urls[i]));
      return true;
    } catch {
      return false; // the loader fetches on demand, as before
    }
  }

  return {
    /** Fetch both files (once). Resolves true when both are held as blobs, false otherwise; never rejects. */
    start() {
      startP ??= warm();
      return startP;
    },
    /** LoadingManager URL modifier: a transcoder file's URL -> its blob: URL once warm, anything else unchanged. */
    urlModifier(url) {
      for (const [file, blob] of blobs) if (url === file || url.endsWith(`/${file}`)) return blob;
      return url;
    },
    /** Revoke the blob URLs (app teardown). */
    dispose: clear,
  };
}
