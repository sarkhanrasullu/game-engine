// Rate-limited haptics (engine /audio).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHaptics } from '../../src/audio/haptics.js';

/** navigator stand-in that records vibrate() patterns. */
function fakeNavigator() {
  const calls = [];
  return { calls, vibrate: (p) => { calls.push(p); return true; } };
}

test('haptics: feature-detected, rate-limited, stop() sends 0', () => {
  assert.equal(createHaptics({ nav: {}, enabled: true }).pulse(10, 0), false, 'no vibrate API: no-op');
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
