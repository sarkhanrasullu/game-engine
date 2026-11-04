// Rate-limited haptics (engine /audio) over an injectable backend (ADR-0005 / HS-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHaptics, impactBackend, vibrateBackend } from '../../src/audio/haptics.js';
import { fakeNavigator } from '../fixtures/fake-audio.js';

test('haptics: feature-detected, rate-limited, stop() sends 0', () => {
  assert.equal(createHaptics({ nav: {}, enabled: true }).pulse(10, 0), false, 'no vibrate API: no-op');
  assert.equal(createHaptics({ nav: {}, enabled: true }).supported(), false);
  const nav = fakeNavigator();
  let t = 0;
  const h = createHaptics({ nav, enabled: true, minIntervalMs: 50, now: () => t });
  assert.ok(h.pulse(10, 2));
  t = 49;
  assert.equal(h.pulse(10, 2), false);
  t = 50;
  assert.ok(h.pulse(10, 2));
  h.stop();
  assert.deepEqual(nav.calls, [10, 10, 0]);
  assert.equal(createHaptics({ nav, enabled: 'true' }).enabled(), false, 'only a real true enables');
});

test('haptics: disabled by default', () => {
  const nav = fakeNavigator();
  assert.equal(createHaptics({ nav }).pulse(10, 0), false);
  assert.deepEqual(nav.calls, []);
});

test('vibrateBackend: null without the API, swallows WebView throws', () => {
  assert.equal(vibrateBackend(null), null);
  assert.equal(vibrateBackend({}), null);
  const be = vibrateBackend({ vibrate() { throw new Error('no gesture'); } });
  assert.doesNotThrow(() => be.vibrate(10));
  assert.doesNotThrow(() => be.stop());
});

test('impactBackend: on-segments become light/medium/heavy impacts, later segments are scheduled, stop() cancels', () => {
  const impacts = [];
  const timers = [];
  const be = impactBackend((s) => impacts.push(s), {
    lightMaxMs: 15, mediumMaxMs: 35,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  });
  assert.ok(be.vibrate(12));
  assert.ok(be.vibrate(28));
  assert.ok(be.vibrate(90));
  assert.deepEqual(impacts, ['light', 'medium', 'heavy']);
  impacts.length = 0;
  assert.ok(be.vibrate([40, 60, 90, 20, 10]));
  assert.deepEqual(impacts, ['heavy'], 'first segment fires at once');
  assert.deepEqual(timers.map((x) => x.ms), [100, 210], 'later segments after on + off');
  for (const x of timers) if (x.fn) x.fn();
  assert.deepEqual(impacts, ['heavy', 'heavy', 'light']);
  be.vibrate([10, 50, 10]);
  assert.equal(timers.length, 3);
  be.stop();
  assert.equal(timers[2].fn, null, 'stop cancels the pending segment');
  assert.equal(be.vibrate([]), false);
});

test('createHaptics: an injected backend wins over navigator and is gated the same way', () => {
  const nav = fakeNavigator();
  const impacts = [];
  const h = createHaptics({ nav, backend: impactBackend((s) => impacts.push(s)), enabled: true, minIntervalMs: 50, now: () => 0 });
  assert.equal(h.supported(), true);
  assert.ok(h.pulse(20, 2));
  assert.deepEqual(impacts, ['medium']);
  assert.deepEqual(nav.calls, [], 'navigator untouched');
  const off = createHaptics({ backend: null, enabled: true });
  assert.equal(off.supported(), false);
  assert.equal(off.pulse(20, 0), false, 'an explicit null backend is a no-op (native with no haptics plugin)');
});
