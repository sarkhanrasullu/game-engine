// Haptics pairing for fight SFX (design/audio/sfx-spec.md §6): navigator.vibrate, feature-detected
// (a no-op on iOS Safari/WebView), gated by the player's hapticsEnabled setting and rate-limited.
// Main thread only.

/**
 * Create a rate-limited vibrator. Only an explicit `enabled === true` turns it on (spec §6: a missing
 * or invalid setting must never silently enable vibration).
 * @example
 *   const h = createHaptics({ enabled: true, minIntervalMs: 50 });
 *   h.pulse(12, 2);           // light hit
 *   h.pulse([40, 60, 90], 0); // KO: more important, so it overrides inside the window
 *   h.stop();                 // visibility hidden / match end
 * @param {{nav?: {vibrate?: (p: number|number[]) => boolean}, enabled?: boolean, minIntervalMs?: number, now?: () => number}} [opts]
 */
export function createHaptics({ nav = globalThis.navigator, enabled = false, minIntervalMs = 50, now = () => performance.now() } = {}) {
  const can = !!nav && typeof nav.vibrate === 'function';
  let on = enabled === true;
  let lastAt = -Infinity;
  let lastPriority = Infinity;
  const api = {
    /**
     * Vibrate `pattern` unless off, unsupported, or a pulse of equal/higher importance (lower
     * priority number) already fired in the last minIntervalMs.
     * @param {number | readonly number[] | null | undefined} pattern ms, or [on, off, on...]
     * @param {number} priority 0 = most important (spec §2.5 order)
     * @returns {boolean} true if vibrate was called
     */
    pulse(pattern, priority) {
      if (!on || !can || pattern === null || pattern === undefined) return false;
      const t = now();
      if (t - lastAt < minIntervalMs && priority >= lastPriority) return false;
      lastAt = t;
      lastPriority = priority;
      try {
        nav.vibrate(/** @type {any} */ (pattern));
      } catch {
        /* some WebViews throw without a gesture: haptics are optional */
      }
      return true;
    },
    /** Cancel any running pattern. */
    stop() {
      if (!can) return;
      try {
        nav.vibrate(0);
      } catch {
        /* ignore */
      }
    },
    /** @param {boolean} v */
    setEnabled(v) {
      on = v === true;
      if (!on) api.stop();
    },
    enabled: () => on,
  };
  return api;
}
