// SFX data schema (engine /audio; ADR-0004, ADR-0005). The wire format uses snake_case keys;
// this module maps them once to camelCase, validates every synthesis layer and deep-freezes the
// result. The list of sound ids that must exist is injected by the game (buildSfxData's
// requiredEvents), so no game cue is named here. Pure: no DOM, no WebAudio.
//
// Layer types: `tone` (oscillator), `noise` (filtered looped noise), `partials` (modal sine set) and,
// since ADR-0005, `sample` (a decoded clip from a sample bank, see sample-bank.js). A sample layer
// carries an optional `fallback` list of synthesis layers that plays when the bank is not available,
// so a game never goes silent on a missing or undecodable asset.
import { deepFreeze } from '../core/data.js';

/** Layer voice types (spec §1; `sample` since ADR-0005). */
export const LAYER_TYPES = Object.freeze(['tone', 'noise', 'partials', 'sample']);
const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];
const FILTERS = ['lowpass', 'highpass', 'bandpass'];
/** Buses every table must level (mix.bus_db). */
export const REQUIRED_BUSES = Object.freeze(['combat', 'movement', 'match', 'ui', 'music']);
/** Buses an event or duck may name: the required five plus the optional `ambience` bed bus. */
export const BUSES = Object.freeze([...REQUIRED_BUSES, 'ambience']);
/** Objects whose own keys are data ids (kept verbatim, not camelised). */
const ID_MAPS = new Set([
  'events', 'materials', 'ducks', 'transients', 'bus_db', 'stride_ms', 'ref_walk_speed', 'fc_by_count', 'recipe_by_second',
  'send_db', 'by_move', 'stingers',
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
 * Throw unless `l` is a well-formed synthesis or sample layer.
 * @example validateLayer({ type: 'tone', wave: 'sine', f0: 700, a: 1, d: 30, db: 0 }, 'x');
 * @example validateLayer({ type: 'sample', bank: 'impact_heavy', db: 0, rateCents: 40, fallback: [tone] }, 'y');
 * @param {any} l @param {string} label
 */
export function validateLayer(l, label) {
  const bad = (m) => { throw new Error(`sfx data ${label}: ${m}`); };
  if (!LAYER_TYPES.includes(l.type)) bad(`unknown layer type ${l.type}`);
  if (l.type !== 'sample' && (!fin(l.a) || l.a < 0)) bad('a must be >= 0 (ms)');
  if (l.type === 'sample' && l.a !== undefined && (!fin(l.a) || l.a < 0)) bad('a must be >= 0 (ms)');
  if (l.type !== 'partials' && l.type !== 'sample' && (!fin(l.d) || l.d <= 0)) bad('d must be > 0 (ms)');
  if (l.type === 'sample' && l.d !== undefined && (!fin(l.d) || l.d <= 0)) bad('d must be > 0 (ms)');
  if (l.db !== undefined && !fin(l.db)) bad('db must be a number');
  if (l.delayMs !== undefined && (!fin(l.delayMs) || l.delayMs < 0)) bad('delay_ms must be >= 0');
  if (l.sendDb !== undefined && !fin(l.sendDb)) bad('send_db must be a number');
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
  if (l.type === 'sample') {
    if (typeof l.bank !== 'string' || l.bank === '') bad('sample needs a bank clip id');
    if (l.rateCents !== undefined && !(l.rateCents >= 0)) bad('rate_cents must be >= 0');
    if (l.gainJitterDb !== undefined && !(l.gainJitterDb >= 0)) bad('gain_jitter_db must be >= 0');
    if (l.startMs !== undefined && !(l.startMs >= 0)) bad('start_ms must be >= 0');
    if (l.fallback !== undefined) {
      if (!Array.isArray(l.fallback)) bad('fallback must be a layer list');
      l.fallback.forEach((f, i) => {
        if (f.type === 'sample') bad('fallback layers must be synthesis layers');
        validateLayer(f, `${label}.fallback[${i}]`);
      });
    }
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

/** Optional mix sections (ADR-0005): reverb / harmonic lift / glue compressor. */
function validateMixExtras(mix, fail) {
  const r = mix.reverb;
  if (r !== undefined) {
    if (!(r.irSeconds > 0) || !fin(r.returnDb)) fail('mix.reverb needs ir_seconds > 0 and return_db');
    if (r.sendDb !== undefined) {
      for (const [b, v] of Object.entries(r.sendDb)) {
        if (!BUSES.includes(b)) fail(`mix.reverb.send_db: unknown bus ${b}`);
        if (!fin(v)) fail(`mix.reverb.send_db.${b} must be a number`);
      }
    }
  }
  const h = mix.bassEnhance;
  if (h !== undefined) {
    if (!fin(h.mixDb) || !(h.splitHz > 0) || !Array.isArray(h.buses)) fail('mix.bass_enhance needs mix_db, split_hz and buses');
    for (const b of h.buses) if (!BUSES.includes(b)) fail(`mix.bass_enhance: unknown bus ${b}`);
  }
  const c = mix.combatComp;
  if (c !== undefined && (!fin(c.thresholdDb) || !(c.ratio >= 1))) fail('mix.combat_comp needs threshold_db and ratio >= 1');
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
  for (const b of REQUIRED_BUSES) if (!fin(d.mix.busDb?.[b])) fail(`mix.bus_db.${b} missing`);
  for (const b of Object.keys(d.mix.busDb)) if (!BUSES.includes(b)) fail(`mix.bus_db: unknown bus ${b}`);
  validateMixExtras(d.mix, fail);
  if (!(d.voices.globalCap >= 1) || !(d.voices.ringSize >= 1)) fail('voices caps must be >= 1');
  for (const id of requiredEvents) {
    const e = d.events[id];
    if (!e) fail(`event ${id} missing`);
    for (const k of ['peakDb', 'pitchCents', 'maxVoices', 'cooldownMs', 'priority']) {
      if (!fin(e[k])) fail(`event ${id}: ${k} must be a number`);
    }
  }
  for (const [id, e] of Object.entries(/** @type {Record<string, any>} */ (d.events))) {
    if (!BUSES.includes(e.bus)) fail(`event ${id}: unknown bus ${e.bus}`);
    if (e.bus !== undefined && !fin(d.mix.busDb[e.bus])) fail(`event ${id}: bus ${e.bus} has no mix.bus_db level`);
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
