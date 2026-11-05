// Sample bank (engine /audio; ADR-0005): decoded AudioBuffers for the schema's `sample` layer type.
// A bank is described by a manifest (written by tools/audio/render-bank.mjs) that lists, per clip
// id, its variant files, trim gain, optional sample-exact loop points, its load `group` and the recipe +
// seed that rendered it. Loading is lazy and explicit, results are cached, and every failure is
// contained: a clip whose fetch or decode fails is marked `failed` and `pick()` returns null for it, so
// the caller plays its synthesis fallback. The bank never rejects out of load() / prefetch() and never
// throws from the hot path.
//
// 0.5.2 (BOOT-NET): fetch and decode are two steps. `prefetch({ groups, priority })` downloads clip bytes
// — through a shared download lane (`opts.lane`, ../assets/download-lane.js) when the game gives one, so
// the bank streams in the gaps behind the hero downloads in group order, never beside them — and holds
// them until `load(decode)` decodes them (decoding needs an AudioContext, i.e. the first user gesture;
// fetching does not).
//
// Hot path (`pick`, `get`, `ready`): allocation-free; round-robin with no immediate repeat.
// Threading: main thread only (AudioBuffers are owned by the AudioContext).

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** Default lane priority of a bank clip (behind the heroes at 10 and the stage at 20). */
export const BANK_LANE_PRIORITY = 30;

/**
 * @typedef {object} BankClip
 * @property {string} id
 * @property {readonly string[]} files variant files, relative to the bank root
 * @property {number} gainDb trim applied by the player on top of the layer's db
 * @property {{start: number, end: number} | null} loop sample-exact loop points in seconds (loops only)
 * @property {string} group load group ('default' when the manifest gives none)
 * @property {(AudioBuffer | null)[]} buffers decoded variants (null until loaded / when failed)
 * @property {(ArrayBuffer | null)[]} raw fetched, not yet decoded variant bytes (freed on decode)
 * @property {number} ready decoded variant count
 * @property {boolean} failed true once every variant failed to fetch or decode
 * @property {number} last index of the variant played last (-1 = none)
 */

/**
 * Validate a bank manifest (snake_case wire keys) and return its clips.
 * @example parseBankManifest({ version: 1, clips: { hit: { files: ['hit_01.m4a'], gain_db: 0 } } }).hit.files
 * @param {any} manifest parsed manifest.json
 * @returns {Record<string, BankClip>}
 */
export function parseBankManifest(manifest) {
  const fail = (m) => { throw new Error(`sample bank manifest: ${m}`); };
  if (!manifest || typeof manifest !== 'object' || !manifest.clips || typeof manifest.clips !== 'object') fail('missing clips');
  /** @type {Record<string, BankClip>} */
  const clips = {};
  for (const [id, c] of Object.entries(manifest.clips)) {
    if (!c || !Array.isArray(c.files) || c.files.length === 0) fail(`clip ${id}: files must be a non-empty list`);
    if (!c.files.every((f) => typeof f === 'string' && f !== '')) fail(`clip ${id}: files must be strings`);
    if (c.gain_db !== undefined && !fin(c.gain_db)) fail(`clip ${id}: gain_db must be a number`);
    let loop = null;
    if (c.loop !== undefined && c.loop !== null) {
      if (!(c.loop.start >= 0) || !(c.loop.end > c.loop.start)) fail(`clip ${id}: loop needs 0 <= start < end (seconds)`);
      loop = Object.freeze({ start: c.loop.start, end: c.loop.end });
    }
    clips[id] = {
      id, files: Object.freeze([...c.files]), gainDb: c.gain_db ?? 0, loop, group: typeof c.group === 'string' ? c.group : 'default',
      buffers: c.files.map(() => null), raw: c.files.map(() => null), ready: 0, failed: false, last: -1,
    };
  }
  return clips;
}

/**
 * Create a sample bank from a manifest.
 * @example
 *   const bank = createSampleBank({ manifest, resolveUrl: (file) => `audio/banks/${file}` });
 *   // after the unlock gesture, when the context exists:
 *   bank.load((ab) => ctx.decodeAudioData(ab)).then(() => console.log(bank.status()));
 *   // hot path:
 *   const buf = bank.pick('impact_heavy', Math.random); // AudioBuffer or null (-> play the fallback layers)
 * @example
 *   // BOOT-NET: stream the bank in group order behind the heroes, decode at the gesture
 *   const bank = createSampleBank({ manifest, resolveUrl, lane });
 *   bank.prefetch({ groups: ['essential'], priority: 30 }); bank.prefetch({ groups: ['music'], priority: 33 });
 *   onFirstGesture(() => bank.load(decode, { groups: ['essential'] }));
 * @param {object} opts
 * @param {any} opts.manifest parsed manifest.json (see parseBankManifest)
 * @param {(file: string) => string} opts.resolveUrl bank-relative file -> URL (a game's bundler may hash names)
 * @param {(url: string) => Promise<{ok: boolean, status?: number, arrayBuffer: () => Promise<ArrayBuffer>}>} [opts.fetch] defaults to globalThis.fetch
 * @param {(msg: string) => void} [opts.warn] failure sink (default: console.warn)
 * @param {{add: Function, bump: Function} | null} [opts.lane] a download lane (../assets/download-lane.js); null = fetch directly, all clips in parallel
 * @param {number} [opts.priority] default lane priority of this bank's clips (BANK_LANE_PRIORITY)
 */
export function createSampleBank({ manifest, resolveUrl, fetch = globalThis.fetch?.bind(globalThis), warn = (m) => console.warn(m), lane = null, priority = BANK_LANE_PRIORITY }) {
  const clips = parseBankManifest(manifest);
  const ids = Object.freeze(Object.keys(clips));
  /** @type {Map<string, Promise<void>>} clip id -> decode in progress */
  const pending = new Map();
  /** @type {Map<string, Promise<ArrayBuffer | null>>} variant file -> fetch in progress */
  const fetching = new Map();
  /** variant file -> the most urgent lane priority asked so far (a later, lazier ask never demotes it) */
  const asked = new Map();
  /** variant files whose fetch or decode failed (not fetched again until unload()) */
  const fetchFailed = new Set();
  let decodeFn = null;

  const select = (only, groups) => (c) => !(only && !only.includes(c.id)) && !(groups && !groups.includes(c.group));

  /** Fetch one variant's bytes (once; through the lane when there is one). Resolves null on failure. */
  function fetchVariant(clip, i, prio) {
    const file = clip.files[i];
    if (clip.raw[i] || clip.buffers[i]) return Promise.resolve(clip.raw[i]);
    if (fetchFailed.has(file)) return Promise.resolve(null);
    const existing = fetching.get(file);
    if (existing) {
      if (lane && prio < asked.get(file)) {
        asked.set(file, prio);
        lane.bump(`bank:${file}`, prio);
      }
      return existing;
    }
    asked.set(file, prio);
    const go = async ({ signal = null } = {}) => {
      const res = await (signal ? fetch(resolveUrl(file), { signal }) : fetch(resolveUrl(file)));
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
      return res.arrayBuffer();
    };
    // A clip is cheap to repeat and never worth holding up a hero the player asked for: always preemptible.
    const p = (lane ? lane.add({ id: `bank:${file}`, priority: prio, run: go, preempt: () => true }) : go())
      .then((ab) => { clip.raw[i] = ab; return ab; }, (e) => {
        fetchFailed.add(file);
        warn(`sample bank: ${clip.id} variant ${file} unavailable (${e && e.message ? e.message : e}); synthesis fallback stays active`);
        return null;
      })
      .finally(() => fetching.delete(file));
    fetching.set(file, p);
    return p;
  }

  async function loadClip(clip, prio) {
    let ok = 0;
    for (let i = 0; i < clip.files.length; i++) {
      if (clip.buffers[i]) { ok++; continue; }
      const ab = await fetchVariant(clip, i, prio);
      if (!ab) continue;
      try {
        const buf = await decodeFn(ab);
        if (!buf) throw new Error('decode returned nothing');
        clip.buffers[i] = buf;
        ok++;
      } catch (e) {
        fetchFailed.add(clip.files[i]);
        warn(`sample bank: ${clip.id} variant ${clip.files[i]} unavailable (${e && e.message ? e.message : e}); synthesis fallback stays active`);
      } finally {
        clip.raw[i] = null;
      }
    }
    clip.ready = ok;
    clip.failed = ok === 0;
  }

  const api = {
    /** Clip ids in the manifest. */
    ids,
    /**
     * Download clip bytes (all, or the listed ids / groups) without decoding: the step that needs no
     * AudioContext, so it can start before the first gesture, behind the heroes in the lane. Idempotent per
     * file; a second call with a more urgent `priority` bumps the queued files (a lazier one changes nothing). Never rejects.
     * @param {{ids?: readonly string[], groups?: readonly string[], priority?: number}} [filter]
     * @returns {Promise<void>} when every selected file has arrived or failed
     */
    async prefetch({ ids: only, groups, priority: prio = priority } = {}) {
      if (!fetch) return;
      const jobs = [];
      for (const id of ids) {
        const c = clips[id];
        if (!select(only, groups)(c) || c.failed) continue;
        for (let i = 0; i < c.files.length; i++) if (!c.buffers[i]) jobs.push(fetchVariant(c, i, prio));
      }
      await Promise.all(jobs);
    },
    /**
     * Fetch (if not prefetched) and decode clips (all, or the listed ids / groups). Idempotent and shared:
     * concurrent calls for one clip await the same promise. Never rejects; failures are per clip (see status()).
     * @param {(data: ArrayBuffer) => Promise<AudioBuffer>} decode e.g. (ab) => ctx.decodeAudioData(ab)
     * @param {{ids?: readonly string[], groups?: readonly string[], priority?: number}} [filter]
     * @returns {Promise<string>} status() after the load
     */
    async load(decode, { ids: only, groups, priority: prio = priority } = {}) {
      if (typeof decode !== 'function') throw new TypeError('sample bank: load(decode) needs a decode function');
      if (!fetch) { for (const c of Object.values(clips)) c.failed = true; return api.status(); }
      decodeFn = decode;
      const jobs = [];
      for (const id of ids) {
        const c = clips[id];
        if (!select(only, groups)(c)) continue;
        if (c.ready === c.files.length || c.failed) continue;
        let p = pending.get(id);
        if (!p) {
          p = loadClip(c, prio).finally(() => pending.delete(id));
          pending.set(id, p);
        }
        jobs.push(p);
      }
      await Promise.all(jobs);
      return api.status();
    },
    /** Clip entry (files, gainDb, loop, buffers) or null. Hot path, no allocation. */
    get: (id) => clips[id] ?? null,
    /** True when at least one variant of `id` is decoded. */
    ready: (id) => { const c = clips[id]; return !!c && c.ready > 0; },
    /**
     * Next variant buffer of `id`: round-robin among decoded variants, never the same one twice in
     * a row (when more than one is decoded). null when the clip is unknown, failed or not loaded yet.
     * @param {string} id @param {() => number} [random] presentation RNG in [0, 1)
     */
    pick(id, random = Math.random) {
      const c = clips[id];
      if (!c || c.ready === 0) return null;
      const n = c.buffers.length;
      if (c.ready === 1) {
        for (let i = 0; i < n; i++) if (c.buffers[i]) { c.last = i; return c.buffers[i]; }
        return null;
      }
      // choose uniformly among ready variants other than the last one
      let k = Math.floor(random() * (c.ready - (c.last >= 0 ? 1 : 0)));
      for (let i = 0; i < n; i++) {
        if (!c.buffers[i] || i === c.last) continue;
        if (k === 0) { c.last = i; return c.buffers[i]; }
        k--;
      }
      return null;
    },
    /** 'idle' | 'loading' | 'ready' | 'partial' (some clips failed) | 'failed' (nothing decoded). */
    status() {
      if (pending.size > 0) return 'loading';
      let ready = 0; let failed = 0;
      for (const id of ids) { if (clips[id].ready > 0) ready++; else if (clips[id].failed) failed++; }
      if (ready === 0) return failed === 0 ? 'idle' : 'failed';
      return failed === 0 && ready === ids.length ? 'ready' : 'partial';
    },
    /** Decoded variant count over all clips (debug / tests). */
    loaded() { let n = 0; for (const id of ids) n += clips[id].ready; return n; },
    /** Decoded bytes (float32) over all clips: the bank's memory footprint. */
    bytes() {
      let b = 0;
      for (const id of ids) for (const buf of clips[id].buffers) if (buf) b += buf.length * buf.numberOfChannels * 4;
      return b;
    },
    /** Drop every decoded buffer and held byte (e.g. on a context loss); clips reload on the next load(). */
    unload() {
      for (const id of ids) { const c = clips[id]; c.buffers.fill(null); c.raw.fill(null); c.ready = 0; c.failed = false; c.last = -1; }
      fetchFailed.clear();
      asked.clear();
    },
  };
  return api;
}
