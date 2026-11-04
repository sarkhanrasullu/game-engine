// Adaptive render quality (pocket-ready story-002, hero pipeline ADR-0001): picks a tier (pixel ratio,
// bloom, material tier) from a moving average of the display frame interval, with hysteresis, and
// remembers the settled tier per device under `config.storageKey` (injected by the game).
// DOM-free and three-free so node --test runs it; the scene applies the pixel ratio and bloom toggle.
import { QUALITY_CONFIG } from './quality-config.js';

/**
 * A configured tier resolved for one device: effective pixel ratio plus every feature flag as a
 * boolean (missing flags read false, materialTier 'physical'), so older tier objects keep working.
 * @typedef {{name:string, pixelRatio:number, bloom:boolean, materialTier:'physical'|'standard', shadows:boolean, grade:boolean}} ResolvedTier
 */

/** The flags a tier carries besides its pixel ratio; two tiers equal on all of them (and ratio) collapse. */
const TIER_FLAGS = Object.freeze(['bloom', 'materialTier', 'shadows', 'grade']);

/**
 * Tiers that actually differ on this device: effective ratio = min(deviceDpr, tier cap); a tier is
 * kept when its ratio drops below the previous kept tier's OR any feature flag (bloom, materialTier,
 * shadows, grade) differs from it (LF-F21: a DPR-1 device keeps bloom -> physical -> standard steps);
 * a tier identical in effect to the previous kept one is dropped (keeps the better-named tier).
 * Without half-float colour attachments (`halfFloat: false`) every bloom tier is removed for the
 * session (ADR-0001: the composer needs a HalfFloatType render target).
 * @param {readonly {name:string,pixelRatio:number,bloom?:boolean,materialTier?:string,shadows?:boolean,grade?:boolean}[]} tiers best first
 * @param {number} deviceDpr window.devicePixelRatio
 * @param {{halfFloat?: boolean}} [caps] halfFloat: the device can render to half-float targets (default true)
 * @returns {ResolvedTier[]}
 * @example resolveTiers(QUALITY_CONFIG.tiers, 1.5).map((t) => t.name) // ['high', 'medium', 'low'] (bloom and material still differ)
 * @example resolveTiers(QUALITY_CONFIG.tiers, 3, { halfFloat: false }).map((t) => t.name) // ['medium', 'low']
 */
export function resolveTiers(tiers, deviceDpr, { halfFloat = true } = {}) {
  const dpr = deviceDpr > 0 ? deviceDpr : 1;
  const out = [];
  for (const t of tiers) {
    if (t.bloom && !halfFloat) continue;
    const next = {
      name: t.name,
      pixelRatio: Math.min(dpr, t.pixelRatio),
      bloom: t.bloom === true,
      materialTier: t.materialTier ?? 'physical',
      shadows: t.shadows === true,
      grade: t.grade === true,
    };
    const prev = out[out.length - 1];
    if (!prev || next.pixelRatio < prev.pixelRatio || TIER_FLAGS.some((k) => next[k] !== prev[k])) out.push(next);
  }
  return out;
}

/**
 * Fighter material set for a tier: 'physical' (MeshPhysicalMaterial + clearcoat) or 'standard'
 * (MeshStandardMaterial, env map kept). Read once when a scene is built; the governor never swaps it.
 * @param {{materialTier?: string}|null|undefined} tier
 * @returns {'physical'|'standard'}
 * @example materialTierFor(governor.tier) // 'physical'
 */
export function materialTierFor(tier) {
  return tier && tier.materialTier === 'standard' ? 'standard' : 'physical';
}

/**
 * Whether any tier of this device renders through the bloom composer (build and prewarm the
 * composer only then).
 * @param {readonly {bloom?: boolean}[]} levels governor.levels
 * @example canReachBloom(governor.levels) // true on a half-float capable device
 */
export function canReachBloom(levels) {
  return levels.some((t) => t.bloom === true);
}

/**
 * Frame-time governor. Feed it every display frame interval; it steps one tier down when the
 * average stays slow, and probes one tier up after a long stable stretch (vsync hides headroom).
 * A probe that fails inside cfg.probeFailMs locks that tier out for the session. Allocation-free
 * per sample. Single-thread only (main thread).
 * @example
 *   const q = new QualityGovernor({ deviceDpr: devicePixelRatio, storage: createSettingsStorage(),
 *     onChange: (tier) => view.setPixelRatio(tier.pixelRatio) });
 *   requestAnimationFrame(function tick(t) { q.sample(t - last); last = t; ... });
 */
export class QualityGovernor {
  /**
   * @param {{deviceDpr:number, storage?:{get(k:string):string|null,set(k:string,v:string):void}|null,
   *   onChange?:(tier:ResolvedTier)=>void,
   *   forced?:string|null, config?:typeof QUALITY_CONFIG, halfFloat?: boolean}} opts
   *   forced: a tier name that pins the tier (no adaptation, nothing persisted), e.g. from ?quality=
   *   halfFloat: false removes the bloom tier(s) for the session (no half-float render targets)
   */
  constructor({ deviceDpr, storage = null, onChange = null, forced = null, config = QUALITY_CONFIG, halfFloat = true }) {
    this.cfg = config;
    this.levels = resolveTiers(config.tiers, deviceDpr, { halfFloat });
    this.storage = storage;
    this.onChange = onChange;
    this.fixed = false;
    /** Best level index the governor may probe up to (raised after a failed probe). */
    this.ceiling = 0;
    this.level = 0;
    const pinned = forced ? this.indexOf(forced) : -1;
    if (pinned >= 0) {
      this.level = pinned;
      this.fixed = true;
    } else if (storage) {
      const saved = this.indexOf(storage.get(config.storageKey));
      if (saved >= 0) this.level = saved;
    }
    this.average = -1;
    this.slowFor = 0;
    this.fastFor = 0;
    this.settleLeft = config.settleMs;
    this.probeAge = -1;
  }

  /** Current tier {name, pixelRatio, bloom, materialTier, shadows, grade} (a ResolvedTier). */
  get tier() {
    return this.levels[this.level];
  }

  /**
   * Level index for a configured tier name, or -1 for an unknown name. A configured tier that
   * collapsed into a kept neighbour (same effect on this device) maps to the kept tier it merged
   * into: the last kept tier at or above it in config order; a tier removed for the session (bloom
   * without half-float) maps to the first kept tier below it.
   */
  indexOf(name) {
    const tiers = this.cfg.tiers;
    const want = tiers.findIndex((x) => x.name === name);
    if (want < 0) return -1;
    let best = -1;
    for (let i = 0; i < this.levels.length; i++) {
      const at = tiers.findIndex((x) => x.name === this.levels[i].name);
      if (at <= want) best = i;
      else if (best < 0) return i;
    }
    return best < 0 ? this.levels.length - 1 : best;
  }

  /**
   * One display frame interval in ms (rAF timestamp delta). Returns true when the tier changed.
   * @param {number} intervalMs
   */
  sample(intervalMs) {
    const c = this.cfg;
    if (this.fixed || !(intervalMs > 0) || intervalMs > c.ignoreAboveMs) return false;
    if (this.settleLeft > 0) {
      this.settleLeft -= intervalMs;
      return false;
    }
    const x = intervalMs < c.clampMs ? intervalMs : c.clampMs;
    this.average = this.average < 0 ? x : this.average + c.emaWeight * (x - this.average);
    if (this.probeAge >= 0) {
      this.probeAge += intervalMs;
      if (this.probeAge > c.probeFailMs) {
        this.probeAge = -1; // probe held: this tier is the device's tier now
        this.persist();
      }
    }
    if (this.average > c.downAboveMs) {
      this.slowFor += intervalMs;
      this.fastFor = 0;
      if (this.slowFor >= c.downHoldMs && this.level < this.levels.length - 1) {
        if (this.probeAge >= 0) this.ceiling = this.level + 1; // failed probe: lock this tier out
        this.probeAge = -1;
        this.go(this.level + 1);
        this.persist();
        return true;
      }
    } else if (this.average <= c.upBelowMs) {
      this.fastFor += intervalMs;
      this.slowFor = 0;
      if (this.fastFor >= c.upHoldMs && this.level > this.ceiling) {
        this.go(this.level - 1);
        this.probeAge = 0; // persisted only once it holds for probeFailMs
        return true;
      }
    } else {
      this.slowFor = 0;
      this.fastFor = 0;
    }
    return false;
  }

  /** @private */
  go(level) {
    this.level = level;
    this.average = -1;
    this.slowFor = 0;
    this.fastFor = 0;
    this.settleLeft = this.cfg.settleMs;
    if (this.onChange) this.onChange(this.levels[level]);
  }

  /** @private */
  persist() {
    if (this.storage) this.storage.set(this.cfg.storageKey, this.levels[this.level].name);
  }
}
