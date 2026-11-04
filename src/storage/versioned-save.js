// Versioned save core (engine /storage, ADR-0004): one JSON blob under an injected key on top of
// a never-throwing settings store (safe-storage.js). Corrupt, missing or unknown-version data loads
// the schema's defaults and never throws. Keys, defaults, field sanitising and migrations all come
// from the game's schema; nothing here names a game.

/**
 * @typedef {{
 *   key: string,
 *   version: number,
 *   defaults: () => object,
 *   sanitize: (raw: any) => object,
 *   migrations?: Record<number, (data: any, store: {get(k: string): string|null}) => any>,
 * }} SaveSchema
 *   key: storage key of the blob. version: current version (integer >= 1). defaults(): a fresh save.
 *   sanitize(raw): coerce a current-version object field by field onto defaults.
 *   migrations[v](data, store): data at version v (null for v0 = no blob) -> data at v + 1.
 */

/**
 * Parse + migrate whatever is stored under schema.key. Never throws.
 * @example const data = loadSave(store, schema);
 * @param {{get(k: string): string|null}} store
 * @param {SaveSchema} schema
 */
export function loadSave(store, schema) {
  const text = store.get(schema.key);
  let data = null;
  if (text != null) {
    try { data = JSON.parse(text); } catch { return schema.defaults(); }
    if (!data || typeof data !== 'object') return schema.defaults();
  }
  let v = data ? data.version : 0;
  if (!Number.isInteger(v) || v < 0 || v > schema.version) return schema.defaults(); // unknown version
  try {
    while (v < schema.version) {
      data = schema.migrations[v](data, store);
      v += 1;
    }
  } catch {
    return schema.defaults();
  }
  return schema.sanitize(data);
}

/**
 * Load (and migrate) the save, write it back once, and return accessors. The game builds its own
 * typed facade (setters that mutate data() then call write()) on top.
 * @example
 *   const core = createSave(store, { key: 'my.save', version: 1, defaults, sanitize, migrations });
 *   core.data().settings.sound = false; core.write();
 * @param {{get(k: string): string|null, set(k: string, v: string): void}} store
 * @param {SaveSchema} schema
 * @returns {{data: () => any, write: () => void, reload: () => void}}
 */
export function createSave(store, schema) {
  let data = loadSave(store, schema);
  const write = () => store.set(schema.key, JSON.stringify(data));
  write(); // defaults/migration written explicitly
  return {
    data: () => data,
    write,
    reload() { data = loadSave(store, schema); },
  };
}
