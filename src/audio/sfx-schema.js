// SFX data schema (engine /audio; ADR-0004, story-007). The wire format uses snake_case keys;
// this module maps them once to camelCase, validates every synthesis layer and deep-freezes the
// result. The list of sound ids that must exist is injected by the game (buildSfxData's
// requiredEvents), so no game cue is named here. Pure: no DOM, no WebAudio.
import { deepFreeze } from '../core/data.js';

/** Layer voice types (spec §1). */
export const LAYER_TYPES = Object.freeze(['tone', 'noise', 'partials']);
const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];
const FILTERS = ['lowpass', 'highpass', 'bandpass'];
const BUSES = ['combat', 'movement', 'match', 'ui', 'music'];
/** Objects whose own keys are data ids (kept verbatim, not camelised). */
const ID_MAPS = new Set([
  'events', 'materials', 'ducks', 'transients', 'bus_db', 'stride_ms', 'ref_walk_speed', 'fc_by_count', 'recipe_by_second',
]);

const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Snake_case wire keys -> camelCase, except the keys of id maps. */
function mapKeys(v, keepKeys = false) {
  if (Array.isArray(v)) return v.map((x) => mapKeys(x));
  if (!v || typeof v !== 'object') return v;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('_')) continue; // comments
    out[keepKeys ? k : camel(k)] = mapKeys(x, ID_MAPS.has(k));
  }
  return out;
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Throw unless `l` is a well-formed synthesis layer.
 * @example validateLayer({ type: 'tone', wave: 'sine', f0: 700, a: 1, d: 30, db: 0 }, 'x');
 * @param {any} l @param {string} label
 */
export function validateLayer(l, label) {
  const bad = (m) => { throw new Error(`sfx data ${label}: ${m}`); };
  if (!LAYER_TYPES.includes(l.type)) bad(`unknown layer type ${l.type}`);
  if (!fin(l.a) || l.a < 0) bad('a must be >= 0 (ms)');
  if (l.type !== 'partials' && (!fin(l.d) || l.d <= 0)) bad('d must be > 0 (ms)');
  if (l.db !== undefined && !fin(l.db)) bad('db must be a number');
  if (l.delayMs !== undefined && (!fin(l.delayMs) || l.delayMs < 0)) bad('delay_ms must be >= 0');
  if (l.filter !== undefined) {
    if (!FILTERS.includes(l.filter.type)) bad(`unknown filter ${l.filter.type}`);
    if (!(l.filter.fc > 0) || (l.filter.fc1 !== undefined && !(l.filter.fc1 > 0))) bad('filter fc must be > 0');
  }
  if (l.type === 'tone') {
    if (!WAVES.includes(l.wave)) bad(`unknown wave ${l.wave}`);
    if (!(l.f0 > 0) || (l.f1 !== undefined && !(l.f1 > 0))) bad('f0/f1 must be > 0');
  }
  if (l.type === 'noise' && l.filter === undefined) bad('noise needs a filter');
  if (l.type === 'partials') {
    const n = Array.isArray(l.ratios) ? l.ratios.length : 0;
    if (!(l.f0 > 0) || n === 0 || l.gainsDb?.length !== n || l.decaysMs?.length !== n) {
      bad('partials need f0 > 0 and equal-length ratios / gains_db / decays_ms');
    }
    if (!l.decaysMs.every((d) => d > 0)) bad('decays_ms must be > 0');
  }
  if (l.lfo !== undefined && (!(l.lfo.rateHz > 0) || !(l.lfo.depthHz >= 0))) bad('lfo needs rate_hz > 0, depth_hz >= 0');
  if (l.gate !== undefined && !(l.gate.rateHz > 0)) bad('gate needs rate_hz > 0');
}

/** Validate every object that looks like a layer (has a string `type` that is not a filter). */
function walkLayers(v, path) {
  if (Array.isArray(v)) {
    v.forEach((x, i) => walkLayers(x, `${path}[${i}]`));
    return;
  }
  if (!v || typeof v !== 'object') return;
  if (typeof v.type === 'string' && !FILTERS.includes(v.type)) {
    validateLayer(v, path);
    return;
  }
  for (const [k, x] of Object.entries(v)) walkLayers(x, `${path}.${k}`);
}

/**
 * Map, validate and freeze the SFX table. Throws on missing events, unknown buses/ducks or a bad layer.
 * @example const sfx = buildSfxData(JSON.parse(text), ['hit_light', 'ko']); sfx.events.hit_light.peakDb; // -6
 * @param {unknown} json parsed SFX data
 * @param {readonly string[]} requiredEvents sound ids that must exist in `events` (the game's cue list)
 */
export function buildSfxData(json, requiredEvents) {
  const d = /** @type {any} */ (mapKeys(json));
  const fail = (m) => { throw new Error(`sfx data: ${m}`); };
  if (!d.mix || !d.events || !d.voices || !d.materials || !d.transients || !d.ducks) fail('missing section');
  for (const b of BUSES) if (!fin(d.mix.busDb?.[b])) fail(`mix.bus_db.${b} missing`);
  if (!(d.voices.globalCap >= 1) || !(d.voices.ringSize >= 1)) fail('voices caps must be >= 1');
  for (const id of requiredEvents) {
    const e = d.events[id];
    if (!e) fail(`event ${id} missing`);
    if (!BUSES.includes(e.bus)) fail(`event ${id}: unknown bus ${e.bus}`);
    for (const k of ['peakDb', 'pitchCents', 'maxVoices', 'cooldownMs', 'priority']) {
      if (!fin(e[k])) fail(`event ${id}: ${k} must be a number`);
    }
    for (const duck of e.ducks ?? []) if (!d.ducks[duck]) fail(`event ${id}: unknown duck ${duck}`);
  }
  for (const [id, duck] of Object.entries(d.ducks)) {
    for (const b of /** @type {any} */ (duck).buses) if (!BUSES.includes(b)) fail(`duck ${id}: unknown bus ${b}`);
  }
  walkLayers(d.transients, 'transients');
  walkLayers(d.events, 'events');
  return deepFreeze(d);
}

/** Linear gain for a dB value. @example dbToGain(-6) // ~0.501 */
export function dbToGain(db) {
  return 10 ** (db / 20);
}
