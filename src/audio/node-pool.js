// Hit-frame cost control for Web Audio voices (engine /audio; AUDIO-PERF 2026-11-05). Two tools, both
// game-agnostic and data-free:
//
// 1. createNodePool: pre-built, reusable processing nodes (GainNode, BiquadFilterNode, StereoPannerNode).
//    Source nodes are one-shot by spec and must be created per play, but every gain / filter / panner
//    around them can be reused: a voice acquires nodes from the pool, connects them, schedules its
//    automation, and releases them when it ends. Measured in Chrome at a 6x CPU throttle, a hit-sized
//    graph (10 sources, 14 gains, 2 filters, 1 panner) costs 0.60-0.64 ms created fresh and 0.39-0.42 ms
//    from the pool (-35 %); the garbage of ~17 nodes per hit (and its GC) is gone with it.
//    Release semantics ("cancel-and-hold"): the node is disconnected, every AudioParam is cancelled from
//    `freeAt` and set back to the node's default there, and the node is handed out again only once the
//    context clock has passed `freeAt`, so a voice that is still fading (a stolen one) is never cut.
//    The pool fills incrementally (`fill(n)` per frame) so no single frame pays for all of it; a request
//    the pool cannot serve creates a fresh node, counts it in `stats().overflow`, and drops it on release.
//
// 2. createWaveWarmer: Chromium builds the band-limited PeriodicWave tables of each OscillatorNode type
//    (sine, triangle, sawtooth, square) lazily, on the first `type` assignment in a context, at about
//    1.5 ms of main-thread work per type (8-11 ms at a 6x throttle) - measured as the only 7-12 ms audio
//    spike of a phone-class fight. The warmer assigns each type once, one per call, during a quiet
//    frame (an intro, a menu) so no in-fight sound pays it.
//
// Pure Web Audio graph code: nothing here reads game data. Main thread only (nodes are not shareable).

/** Oscillator wave types whose tables a context builds lazily (every type of the spec). */
export const OSCILLATOR_WAVES = Object.freeze(['sine', 'triangle', 'sawtooth', 'square']);

/** Node kinds a pool manages, with their factory and the params reset on release (name -> default). */
const KINDS = Object.freeze({
  gain: { create: (ctx) => ctx.createGain(), params: Object.freeze({ gain: 1 }) },
  biquad: { create: (ctx) => ctx.createBiquadFilter(), params: Object.freeze({ frequency: 350, Q: 1, detune: 0, gain: 0 }) },
  panner: { create: (ctx) => ctx.createStereoPanner(), params: Object.freeze({ pan: 0 }) },
});

/** Pool kinds in the order `fill` creates them. */
export const POOL_KINDS = Object.freeze(Object.keys(KINDS));

/**
 * Cancel a param's automation from `at` and hold its default from there (the release reset).
 * @param {AudioParam} p @param {number} value default @param {number} at ctx time
 */
function resetParam(p, value, at) {
  p.cancelScheduledValues(at);
  p.setValueAtTime(value, at);
}

/**
 * Create a node pool for one AudioContext.
 * @example
 *   const pool = createNodePool(ctx, { gain: 96, biquad: 24, panner: 16 });
 *   // quiet frames (intro / menu): build the nodes a few at a time
 *   loop.onTick(() => { if (!pool.ready()) pool.fill(24); });
 *   // a voice:
 *   const out = pool.gain();            // cancel-and-hold already applied; set what you need
 *   out.gain.value = 0.5;
 *   const f = pool.biquad(); f.type = 'bandpass'; f.frequency.setValueAtTime(900, t);
 *   src.connect(f); f.connect(out); out.connect(bus);
 *   src.onended = () => { pool.release(f); pool.release(out); };
 *   // a stolen voice fading out over 20 ms: hand the nodes back once the fade is over
 *   pool.release(out, ctx.currentTime + 0.02);
 * @param {BaseAudioContext} ctx
 * @param {{gain?: number, biquad?: number, panner?: number}} [sizes] nodes per kind (0 = that kind is never pooled)
 */
export function createNodePool(ctx, sizes = {}) {
  /** @type {Record<string, {size: number, recs: object[], byNode: Map<AudioNode, object>, cursor: number, overflow: number, overflowLive: number}>} */
  const kinds = {};
  for (const k of POOL_KINDS) {
    const size = Math.max(0, Math.floor(sizes[k] ?? 0));
    kinds[k] = { size, recs: [], byNode: new Map(), cursor: 0, overflow: 0, overflowLive: 0 };
  }
  let total = 0;
  for (const k of POOL_KINDS) total += kinds[k].size;
  let created = 0;

  function make(k) {
    const K = kinds[k];
    const node = KINDS[k].create(ctx);
    const rec = { node, kind: k, busy: false, freeAt: 0 };
    K.recs.push(rec);
    K.byNode.set(node, rec);
    created++;
    return rec;
  }

  function acquire(k) {
    const K = kinds[k];
    const n = K.recs.length;
    if (n > 0) {
      const now = ctx.currentTime;
      // rotating cursor: the node released longest ago tends to be found first
      for (let i = 0; i < n; i++) {
        const idx = (K.cursor + i) % n;
        const r = K.recs[idx];
        if (!r.busy && r.freeAt <= now) {
          r.busy = true;
          K.cursor = (idx + 1) % n;
          return r.node;
        }
      }
    }
    // pool empty (or not filled yet): a fresh node, counted; dropped on release
    K.overflow++;
    K.overflowLive++;
    return KINDS[k].create(ctx);
  }

  return {
    /**
     * Create up to `max` more pooled nodes (all remaining by default). Returns how many were created.
     * Call it from quiet frames until `ready()`; a pool used before it is full simply overflows.
     * @param {number} [max]
     */
    fill(max = Infinity) {
      let n = 0;
      for (const k of POOL_KINDS) {
        const K = kinds[k];
        while (K.recs.length < K.size && n < max) {
          make(k);
          n++;
        }
      }
      return n;
    },
    /** True once every configured node exists. */
    ready: () => created >= total,
    /** A pooled GainNode (default gain 1 held from its release). */
    gain: () => acquire('gain'),
    /** A pooled BiquadFilterNode (set `type`, `frequency`, `Q`, `detune` yourself). */
    biquad: () => acquire('biquad'),
    /** A pooled StereoPannerNode (pan 0 held from its release). */
    panner: () => acquire('panner'),
    /**
     * Hand a node back: disconnected now, automation cancelled from `freeAt` and the defaults held from
     * there, reusable once ctx.currentTime >= freeAt. Overflow (or foreign) nodes are just disconnected.
     * @param {AudioNode} node @param {number} [freeAt] ctx time the node may be reused (default: now)
     */
    release(node, freeAt = ctx.currentTime) {
      node.disconnect();
      let rec = null;
      for (const k of POOL_KINDS) {
        rec = kinds[k].byNode.get(node);
        if (rec) break;
      }
      if (!rec) {
        for (const k of POOL_KINDS) {
          if (node instanceof Object && kinds[k].overflowLive > 0 && isKind(node, k)) {
            kinds[k].overflowLive--;
            break;
          }
        }
        return;
      }
      const at = Math.max(freeAt, ctx.currentTime);
      const defaults = KINDS[rec.kind].params;
      for (const name in defaults) {
        const p = node[name];
        if (p && typeof p.cancelScheduledValues === 'function') resetParam(p, defaults[name], at);
      }
      rec.freeAt = at;
      rec.busy = false;
    },
    /**
     * Per-kind counters (debug / tests): configured size, nodes built, busy now, nodes handed out beyond
     * the pool so far (`overflow`) and how many of those are still out (`overflowLive`).
     */
    stats() {
      const out = {};
      for (const k of POOL_KINDS) {
        const K = kinds[k];
        let busy = 0;
        for (const r of K.recs) if (r.busy) busy++;
        out[k] = { size: K.size, built: K.recs.length, busy, overflow: K.overflow, overflowLive: K.overflowLive };
      }
      return out;
    },
    /** Disconnect every pooled node and forget them (context teardown). */
    dispose() {
      for (const k of POOL_KINDS) {
        const K = kinds[k];
        for (const r of K.recs) r.node.disconnect();
        K.recs.length = 0;
        K.byNode.clear();
      }
      created = 0;
    },
  };
}

/** Best-effort kind test for a node the pool did not create (overflow bookkeeping only). */
function isKind(node, k) {
  if (k === 'gain') return 'gain' in node && !('frequency' in node) && !('pan' in node);
  if (k === 'biquad') return 'frequency' in node && 'Q' in node;
  return 'pan' in node;
}

/**
 * Warm the lazily built oscillator wave tables of a context, one wave type per `step()` call.
 * Each step creates one OscillatorNode of the next type and assigns `type` (nothing starts, nothing
 * connects): that assignment is what builds the context's PeriodicWave for the type, so later
 * oscillators of that type are free. Spread the steps over quiet frames.
 * @example
 *   const warmer = createWaveWarmer(ctx, ['sine', 'triangle', 'sawtooth']);
 *   // intro ticks:
 *   if (!warmer.done()) warmer.step(); // ~1.5 ms once per type, never on a hit frame
 * @param {BaseAudioContext} ctx
 * @param {readonly string[]} [waves] wave types to warm, in order (default: all four)
 */
export function createWaveWarmer(ctx, waves = OSCILLATOR_WAVES) {
  let i = 0;
  return {
    /** Warm the next wave type; returns its name, or '' when every type is done. */
    step() {
      if (i >= waves.length) return '';
      const w = waves[i++];
      const o = ctx.createOscillator();
      o.type = w;
      return w;
    },
    /** True once every listed wave has been warmed. */
    done: () => i >= waves.length,
    /** Waves still to warm. */
    pending: () => waves.length - i,
  };
}

/**
 * Oscillator wave types used anywhere in a layer tree (walks arrays / objects for `{type: 'tone', wave}`
 * layers and their `fallback` lists), in OSCILLATOR_WAVES order. Feed it to createWaveWarmer so only the
 * waves a table actually uses are warmed.
 * @example collectOscillatorWaves(sfx.events) // ['sine', 'triangle', 'sawtooth']
 * @param {unknown} tree
 * @returns {string[]}
 */
export function collectOscillatorWaves(tree) {
  const found = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (v.type === 'tone' && typeof v.wave === 'string') found.add(v.wave);
    for (const k in v) walk(v[k]);
  };
  walk(tree);
  return OSCILLATOR_WAVES.filter((w) => found.has(w));
}
