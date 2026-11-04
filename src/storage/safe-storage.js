// Fault-tolerant string key/value storage (engine /storage) for settings such as the render quality tier. localStorage
// can throw on access (Safari private mode, disabled cookies, sandboxed iframes) or on write
// (quota); a settings write must never break the game, so every failure falls back to an
// in-memory copy for this run.

/**
 * Wrap a localStorage-like store so reads and writes never throw. Single-threaded (main thread).
 * Pass `null` for memory only. With no argument, tries `globalThis.localStorage` (the access
 * itself is guarded: some browsers throw on the property read).
 * @example
 *   const store = createSettingsStorage();   // localStorage, or memory if unavailable
 *   store.set('mygame.quality.tier', 'medium');
 *   store.get('mygame.quality.tier');        // 'medium' (null when never set)
 * @param {{getItem(k: string): string|null, setItem(k: string, v: string): void} | null} [backing]
 * @returns {{get(key: string): string|null, set(key: string, value: string): void}}
 */
export function createSettingsStorage(backing) {
  let store = backing;
  if (store === undefined) {
    try {
      store = globalThis.localStorage ?? null;
    } catch {
      store = null;
    }
  }
  /** @type {Map<string, string>} */
  const memory = new Map();
  return {
    get(key) {
      if (memory.has(key)) return memory.get(key);
      if (!store) return null;
      try {
        const v = store.getItem(key);
        return typeof v === 'string' ? v : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      if (!store) return;
      try {
        store.setItem(key, value);
      } catch {
        /* quota / disabled: the memory copy stands for this run */
      }
    },
  };
}
