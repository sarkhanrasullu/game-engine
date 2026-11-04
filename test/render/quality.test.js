import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QualityGovernor, resolveTiers, materialTierFor, canReachBloom } from '../../src/render/quality.js';
import { createEnvScene, ENV_PANELS } from '../../src/render/pipeline.js';
import { QUALITY_CONFIG } from '../../src/render/quality-config.js';
import { createSettingsStorage } from '../../src/storage/safe-storage.js';

const feed = (q, ms, totalMs) => {
  let changed = 0;
  for (let t = 0; t < totalMs; t += ms) if (q.sample(ms)) changed++;
  return changed;
};

test('tiers collapse to distinct effective pixel ratios per device', () => {
  assert.deepEqual(resolveTiers(QUALITY_CONFIG.tiers, 3).map((t) => t.pixelRatio), [2, 1.5, 1]);
  assert.deepEqual(resolveTiers(QUALITY_CONFIG.tiers, 1.5).map((t) => t.name), ['high', 'low']);
  assert.equal(resolveTiers(QUALITY_CONFIG.tiers, 1).length, 1);
});

test('steps down one tier after a sustained slow average, not on a lone hitch', () => {
  const q = new QualityGovernor({ deviceDpr: 3 });
  feed(q, 16.7, 2000);
  q.sample(200); // single long frame: clamped, no drop
  feed(q, 16.7, 500);
  assert.equal(q.tier.name, 'high');
  feed(q, 33.3, 1500);
  assert.equal(q.tier.name, 'medium');
});

test('stays put inside the hysteresis band and probes up only after a long stable stretch', () => {
  const store = createSettingsStorage(null);
  const q = new QualityGovernor({ deviceDpr: 3, storage: store });
  feed(q, 33.3, 1500);
  assert.equal(q.tier.name, 'medium');
  assert.equal(store.get(QUALITY_CONFIG.storageKey), 'medium');
  feed(q, 18, 20000); // between upBelowMs and downAboveMs
  assert.equal(q.tier.name, 'medium');
  feed(q, 16.7, QUALITY_CONFIG.upHoldMs + 1000);
  assert.equal(q.tier.name, 'high');
});

test('a probe that fails locks that tier out for the session', () => {
  const q = new QualityGovernor({ deviceDpr: 3, storage: createSettingsStorage(null) });
  feed(q, 33.3, 1500); // -> medium
  feed(q, 16.7, QUALITY_CONFIG.upHoldMs + 1000); // probe -> high
  assert.equal(q.tier.name, 'high');
  feed(q, 33.3, 1500); // fails inside probeFailMs -> medium, high locked out
  assert.equal(q.tier.name, 'medium');
  feed(q, 16.7, QUALITY_CONFIG.upHoldMs * 3);
  assert.equal(q.tier.name, 'medium');
});

test('persisted tier is restored; forced tier pins and never persists', () => {
  const store = createSettingsStorage(null);
  store.set(QUALITY_CONFIG.storageKey, 'low');
  assert.equal(new QualityGovernor({ deviceDpr: 3, storage: store }).tier.pixelRatio, 1);
  const pinned = new QualityGovernor({ deviceDpr: 3, storage: store, forced: 'high' });
  assert.equal(feed(pinned, 50, 5000), 0);
  assert.equal(pinned.tier.name, 'high');
  assert.equal(store.get(QUALITY_CONFIG.storageKey), 'low');
});

test('settings storage tolerates a throwing localStorage', () => {
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const s = createSettingsStorage(boom);
  assert.equal(s.get('k'), null);
  assert.doesNotThrow(() => s.set('k', 'medium'));
  assert.equal(s.get('k'), 'medium'); // memory copy
  const q = new QualityGovernor({ deviceDpr: 2, storage: createSettingsStorage(boom) });
  assert.equal(q.tier.name, 'high');
});

test('tier config: bloom on high only, physical materials down to medium, standard on low', () => {
  const [high, medium, low] = QUALITY_CONFIG.tiers;
  assert.deepEqual([high.bloom, medium.bloom, low.bloom], [true, false, false]);
  assert.deepEqual([high.materialTier, medium.materialTier, low.materialTier], ['physical', 'physical', 'standard']);
});

test('resolveTiers carries bloom and materialTier to the kept tiers', () => {
  const t = resolveTiers(QUALITY_CONFIG.tiers, 3);
  assert.deepEqual(t.map((x) => [x.name, x.bloom, x.materialTier]), [['high', true, 'physical'], ['medium', false, 'physical'], ['low', false, 'standard']]);
  const dpr15 = resolveTiers(QUALITY_CONFIG.tiers, 1.5);
  assert.deepEqual(dpr15.map((x) => x.name), ['high', 'low']);
  assert.equal(dpr15[0].bloom, true);
});

test('no half-float render targets: the bloom tier is removed for the session', () => {
  const t = resolveTiers(QUALITY_CONFIG.tiers, 3, { halfFloat: false });
  assert.deepEqual(t.map((x) => x.name), ['medium', 'low']);
  assert.equal(canReachBloom(t), false);
  const q = new QualityGovernor({ deviceDpr: 3, halfFloat: false });
  assert.equal(q.tier.name, 'medium');
  assert.equal(q.tier.bloom, false);
  assert.equal(canReachBloom(new QualityGovernor({ deviceDpr: 3 }).levels), true);
});

test('materialTierFor maps a tier to its material set and defaults to physical', () => {
  assert.equal(materialTierFor({ materialTier: 'standard' }), 'standard');
  assert.equal(materialTierFor({ materialTier: 'physical' }), 'physical');
  assert.equal(materialTierFor(undefined), 'physical');
  assert.equal(materialTierFor(new QualityGovernor({ deviceDpr: 3, forced: 'low' }).tier), 'standard');
});

test('the governor steps high -> medium dropping bloom but not the material tier mapping', () => {
  const seen = [];
  const q = new QualityGovernor({ deviceDpr: 3, onChange: (t) => seen.push([t.name, t.bloom, t.materialTier]) });
  assert.equal(q.tier.bloom, true);
  feed(q, 33.3, 3000);
  assert.deepEqual(seen[0], ['medium', false, 'physical']);
});

test('arena environment scene: dome + 8 lava panels + moon, softbox and kicker, HDR emissive', () => {
  const scene = createEnvScene();
  assert.equal(scene.children.length, 1 + 8 + 3);
  const hdr = scene.children.filter((m) => m.material.color.r > 1 || m.material.color.g > 1 || m.material.color.b > 1);
  assert.equal(hdr.length, 8 + 3 - 1, 'every panel but the dim softbox exceeds 1.0 (the softbox is x1.2 of a dim blue)');
});

test('storageKey is injected through config; the engine default is generic', () => {
  assert.equal(QUALITY_CONFIG.storageKey, 'quality.tier');
  const config = Object.freeze({ ...QUALITY_CONFIG, storageKey: 'consumer.quality.tier' });
  const store = createSettingsStorage(null);
  store.set(config.storageKey, 'low');
  assert.equal(new QualityGovernor({ deviceDpr: 3, storage: store, config }).tier.name, 'low');
  const fresh = createSettingsStorage(null);
  const q = new QualityGovernor({ deviceDpr: 3, storage: fresh, config });
  feed(q, 33.3, 1500); // step down -> persisted under the injected key only
  assert.equal(fresh.get(config.storageKey), 'medium');
  assert.equal(fresh.get(QUALITY_CONFIG.storageKey), null);
});

test('createEnvScene takes an injected panel set', () => {
  const panels = { ...ENV_PANELS, lava: { ...ENV_PANELS.lava, count: 4 } };
  assert.equal(createEnvScene(panels).children.length, 1 + 4 + 3);
});
