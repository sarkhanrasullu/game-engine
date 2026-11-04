// Adaptive render quality defaults (ADR-0001 render tiers). Data only: the governor in quality.js
// reads these values. A game overrides any key, typically `storageKey`, by passing its own config:
//   const config = Object.freeze({ ...QUALITY_CONFIG, storageKey: 'mygame.quality.tier' });
//   new QualityGovernor({ deviceDpr, storage, config });

/**
 * Three render tiers, best first. pixelRatio is a cap; the effective ratio is
 * min(devicePixelRatio, pixelRatio), and tiers that resolve to the same ratio on a device collapse
 * into one. MSAA, rim light and hit sparks are the same in every tier (art-director sign-off needed
 * to reduce them).
 *
 * Hero pipeline (ADR-0001, art bible R2-5): `bloom` selects the composer path (MSAA half-float RT ->
 * UnrealBloomPass -> OutputPass; high only), `materialTier` the fighter material set ('physical' =
 * MeshPhysicalMaterial + clearcoat, 'standard' = MeshStandardMaterial, env map kept). The material tier
 * is read ONCE when a scene is built (no shader compiles mid-fight); at runtime the governor only
 * changes the pixel ratio and the bloom toggle.
 */
export const QUALITY_CONFIG = Object.freeze({
  tiers: Object.freeze([
    Object.freeze({ name: 'high', pixelRatio: 2, bloom: true, materialTier: 'physical' }),
    Object.freeze({ name: 'medium', pixelRatio: 1.5, bloom: false, materialTier: 'physical' }),
    Object.freeze({ name: 'low', pixelRatio: 1, bloom: false, materialTier: 'standard' }),
  ]),
  /**
   * High-tier bloom (art bible R2-5 / R2-8 item 8). threshold 1.0 so only HDR glow (> 1.0) blooms: lit
   * armour and suit are capped at 0.95 by the soft ceiling. UnrealBloomPass halves the drawing buffer
   * internally, so its first mip is half resolution. `samples` = MSAA on the half-float render target.
   * strength 0.3 / radius 0.4 (art bible R2-5 targets 0.6 / 0.55, unverified): at the hottest emissive
   * state the larger halo washed the whole body white in the reference captures ("the body never blooms").
   * `postBudgetMs` is the ADR GPU budget for the whole composer path (verify on a real phone).
   */
  bloomParams: Object.freeze({ strength: 0.3, radius: 0.4, threshold: 1.0, samples: 4, postBudgetMs: 3.0 }),
  /** Exponential moving average weight of each new frame interval (~0.1 = last ~10 frames). */
  emaWeight: 0.1,
  /** Intervals above this are ignored (tab switch, debugger, page load); ms. */
  ignoreAboveMs: 250,
  /** One interval counts at most this much toward the average (a lone GC hitch must not drop a tier); ms. */
  clampMs: 50,
  /** Step down when the average stays above this for downHoldMs; 60 Hz frame = 16.7 ms. */
  downAboveMs: 18.5,
  downHoldMs: 750,
  /**
   * The display's vsync hides headroom (a fast device still reads 16.7 ms), so upward moves are
   * probes: after the average stays at or below upBelowMs for upHoldMs, try one tier up.
   */
  upBelowMs: 17.5,
  upHoldMs: 10000,
  /** A probed tier that steps down again within this window is locked out for the session; ms. */
  probeFailMs: 5000,
  /** After any tier change, ignore samples for this long (resize hitch); ms. */
  settleMs: 500,
  /**
   * Per-device persistence key (value: tier name). Generic default: a game injects its own namespaced
   * key through the governor's `config` (see the header).
   */
  storageKey: 'quality.tier',
});
