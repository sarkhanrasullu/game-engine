// Engine /storage: never-throwing settings store and the versioned JSON save core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStorage } from '../../src/storage/safe-storage.js';
import { createSave, loadSave } from '../../src/storage/versioned-save.js';

const backing = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m };
};

/** A two-version schema: v0 (no blob, legacy flat key) -> v1 -> v2. */
function schemaFixture() {
  const defaults = () => ({ version: 2, settings: { sound: true, hand: 'right' } });
  return {
    key: 'test.save',
    version: 2,
    defaults,
    sanitize: (raw) => {
      const d = defaults();
      if (typeof raw?.settings?.sound === 'boolean') d.settings.sound = raw.settings.sound;
      if (raw?.settings?.hand === 'left' || raw?.settings?.hand === 'right') d.settings.hand = raw.settings.hand;
      return d;
    },
    migrations: {
      0: (_data, store) => ({ version: 1, hand: store.get('test.legacy.hand') ?? 'right' }),
      1: (data) => ({ version: 2, settings: { sound: true, hand: data.hand } }),
    },
  };
}

test('settings storage: memory-only, throwing backing, round-trip', () => {
  const mem = createSettingsStorage(null);
  assert.equal(mem.get('k'), null);
  mem.set('k', 'v');
  assert.equal(mem.get('k'), 'v');
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const s = createSettingsStorage(boom);
  assert.equal(s.get('k'), null);
  assert.doesNotThrow(() => s.set('k', 'medium'));
  assert.equal(s.get('k'), 'medium');
  const b = backing();
  createSettingsStorage(b).set('a', '1');
  assert.equal(createSettingsStorage(b).get('a'), '1');
});

test('missing save: migrations run from v0 and the result is written back under the injected key', () => {
  const b = backing({ 'test.legacy.hand': 'left' });
  const save = createSave(createSettingsStorage(b), schemaFixture());
  assert.deepEqual(save.data(), { version: 2, settings: { sound: true, hand: 'left' } });
  assert.deepEqual(JSON.parse(b.m.get('test.save')), save.data());
});

test('corrupt JSON, wrong types, unknown versions and a throwing migration load defaults', () => {
  const schema = schemaFixture();
  for (const bad of ['{nope', 'null', '42', JSON.stringify({ version: 9 }), JSON.stringify({ version: -1 })]) {
    assert.deepEqual(loadSave(createSettingsStorage(backing({ 'test.save': bad })), schema), schema.defaults(), bad);
  }
  const throwing = { ...schema, migrations: { 0: () => { throw new Error('x'); } } };
  assert.deepEqual(loadSave(createSettingsStorage(backing()), throwing), schema.defaults());
});

test('write() persists mutations; reload() re-reads the store', () => {
  const b = backing();
  const store = createSettingsStorage(b);
  const save = createSave(store, schemaFixture());
  save.data().settings.sound = false;
  save.write();
  assert.equal(createSave(createSettingsStorage(backing(Object.fromEntries(b.m))), schemaFixture()).data().settings.sound, false);
  store.set('test.save', JSON.stringify({ version: 2, settings: { sound: true, hand: 'left' } }));
  save.reload();
  assert.equal(save.data().settings.hand, 'left');
});
