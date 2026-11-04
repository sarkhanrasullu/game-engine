// Haptics pairing for fight SFX (design/audio/sfx-spec.md §6): a rate-limited vibrator over an
// injectable backend. Default backend: navigator.vibrate, feature-detected (WebKit and the iOS
// WKWebView do not implement it). A native wrapper supplies its own backend (ADR-0005 / HS-15):
// impactBackend() maps vibrate patterns onto an impact-style API (light / medium / heavy) such as
// Capacitor's Haptics plugin or UIImpactFeedbackGenerator, so iPhone players feel hits too.
// Gated by the player's hapticsEnabled setting. Main thread only.

/**
 * @typedef {object} HapticsBackend
 * @property {(pattern: number | readonly number[]) => boolean} vibrate play a pattern (ms, or [on, off, on...])
 * @property {() => void} stop cancel anything running
 */

/**
 * Backend over navigator.vibrate, or null when the API is missing.
 * @example const be = vibrateBackend(navigator); be && be.vibrate(20);
 * @param {{vibrate?: (p: number | number[]) => boolean} | null | undefined} nav
 * @returns {HapticsBackend | null}
 */
export function vibrateBackend(nav) {
  if (!nav || typeof nav.vibrate !== 'function') return null;
  return {
    vibrate(pattern) {
      try { nav.vibrate(/** @type {any} */ (pattern)); } catch { /* some WebViews throw without a gesture */ }
      return true;
    },
    stop() {
      try { nav.vibrate(0); } catch { /* ignore */ }
    },
  };
}

/**
 * Backend over an impact-style API: each "on" segment of a pattern becomes one impact whose style is
 * chosen by its length (<= lightMaxMs light, <= mediumMaxMs medium, else heavy); later segments are
 * scheduled after the preceding on + off time. stop() cancels pending segments.
 * @example
 *   // Capacitor: const { Haptics, ImpactStyle } = Capacitor.Plugins ...
 *   const be = impactBackend((style) => Haptics.impact({ style: style === 'heavy' ? ImpactStyle.Heavy : style === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light }));
 *   const h = createHaptics({ backend: be, enabled: true });
 * @param {(style: 'light' | 'medium' | 'heavy') => unknown} impact
 * @param {{lightMaxMs?: number, mediumMaxMs?: number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout}} [o]
 * @returns {HapticsBackend}
 */
export function impactBackend(impact, { lightMaxMs = 15, mediumMaxMs = 35, setTimeout: st = globalThis.setTimeout, clearTimeout: ct = globalThis.clearTimeout } = {}) {
  const timers = [];
  const styleOf = (ms) => (ms <= lightMaxMs ? 'light' : ms <= mediumMaxMs ? 'medium' : 'heavy');
  const fire = (style) => { try { impact(style); } catch { /* optional */ } };
  return {
    vibrate(pattern) {
      if (typeof pattern === 'number') { fire(styleOf(pattern)); return true; }
      if (!Array.isArray(pattern) || pattern.length === 0) return false;
      fire(styleOf(pattern[0]));
      let at = 0;
      for (let i = 2; i < pattern.length; i += 2) {
        at += pattern[i - 2] + pattern[i - 1];
        const style = styleOf(pattern[i]);
        timers.push(st(() => fire(style), at));
      }
      return true;
    },
    stop() {
      for (const t of timers) ct(t);
      timers.length = 0;
    },
  };
}

/**
 * Create a rate-limited vibrator. Only an explicit `enabled === true` turns it on (spec §6: a missing
 * or invalid setting must never silently enable vibration).
 * @example
 *   const h = createHaptics({ enabled: true, minIntervalMs: 50 });
 *   h.pulse(20, 2);           // light hit
 *   h.pulse([40, 60, 90], 0); // KO: more important, so it overrides inside the window
 *   h.stop();                 // visibility hidden / match end
 * @example
 *   // native wrapper: an impact-style backend instead of navigator.vibrate
 *   const h = createHaptics({ backend: impactBackend((style) => native.impact(style)), enabled: true });
 * @param {{nav?: {vibrate?: (p: number|number[]) => boolean}, backend?: HapticsBackend | null, enabled?: boolean, minIntervalMs?: number, now?: () => number}} [opts]
 *   `backend` wins over `nav`; with neither available every call is a no-op.
 */
export function createHaptics({ nav = globalThis.navigator, backend = undefined, enabled = false, minIntervalMs = 50, now = () => performance.now() } = {}) {
  const be = backend !== undefined ? backend : vibrateBackend(nav);
  const can = !!be;
  let on = enabled === true;
  let lastAt = -Infinity;
  let lastPriority = Infinity;
  const api = {
    /**
     * Vibrate `pattern` unless off, unsupported, or a pulse of equal/higher importance (lower
     * priority number) already fired in the last minIntervalMs.
     * @param {number | readonly number[] | null | undefined} pattern ms, or [on, off, on...]
     * @param {number} priority 0 = most important (spec §2.5 order)
     * @returns {boolean} true if the backend was called
     */
    pulse(pattern, priority) {
      if (!on || !can || pattern === null || pattern === undefined) return false;
      const t = now();
      if (t - lastAt < minIntervalMs && priority >= lastPriority) return false;
      lastAt = t;
      lastPriority = priority;
      be.vibrate(/** @type {any} */ (pattern));
      return true;
    },
    /** Cancel any running pattern. */
    stop() {
      if (can) be.stop();
    },
    /** @param {boolean} v */
    setEnabled(v) {
      on = v === true;
      if (!on) api.stop();
    },
    enabled: () => on,
    /** True when a backend exists (navigator.vibrate or an injected one). */
    supported: () => can,
  };
  return api;
}
