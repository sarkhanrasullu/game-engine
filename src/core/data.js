// Data-boundary helpers for JSON tuning data. Pure: no DOM, no three.js. The game loads its JSON
// (e.g. `import X from '...json' with { type: 'json' }`, which both Vite and node:test on Node >= 22
// support) and these helpers copy, check and freeze it before it is injected into the engine.

/**
 * Recursively freeze an object graph in place and return it.
 * @template T
 * @param {T} o
 * @returns {T}
 */
export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/**
 * Copy `src[key]` for every key in `keys` into a new frozen object, throwing when a key is
 * missing or not a finite number. Unknown keys in `src` also throw (typos must not be ignored).
 * @param {Record<string, unknown>} src parsed JSON section
 * @param {readonly string[]} keys required numeric keys (the schema)
 * @param {string} label for error messages
 * @returns {Readonly<Record<string, number>>}
 */
export function numberTable(src, keys, label) {
  if (!src || typeof src !== 'object') throw new Error(`${label}: missing section`);
  for (const k of Object.keys(src)) {
    if (!keys.includes(k)) throw new Error(`${label}: unknown key ${k}`);
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label}: ${k} must be a finite number`);
    out[k] = v;
  }
  return Object.freeze(out);
}
