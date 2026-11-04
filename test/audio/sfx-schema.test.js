// SFX schema (engine /audio): snake_case -> camelCase, injected required cue list, layer validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSfxData, validateLayer, dbToGain, LAYER_TYPES } from '../../src/audio/sfx-schema.js';

/** Smallest valid SFX table: every bus, two cues, one duck, one material, one transient. */
function sfxFixture() {
  const tone = { type: 'tone', wave: 'sine', f0: 700, a: 1, d: 30, db: 0 };
  const cue = (bus) => ({ bus, peak_db: -6, pitch_cents: 0, max_voices: 1, cooldown_ms: 0, priority: 1, layers: [tone] });
  return {
    _comment: 'test fixture',
    mix: { bus_db: { combat: 0, movement: -6, match: -3, ui: -6, music: -12 } },
    voices: { global_cap: 8, ring_size: 8 },
    events: { cue_a: { ...cue('combat'), ducks: ['big'] }, cue_b: cue('ui') },
    materials: { metal: { brightness: 1 } },
    transients: { click: { type: 'noise', a: 0, d: 5, filter: { type: 'highpass', fc: 2000 } } },
    ducks: { big: { buses: ['music'], db: -6, ms: 200 } },
  };
}

test('buildSfxData maps keys, keeps id maps verbatim and freezes', () => {
  const d = buildSfxData(sfxFixture(), ['cue_a', 'cue_b']);
  assert.equal(d.events.cue_a.peakDb, -6);
  assert.equal(d.mix.busDb.music, -12);
  assert.equal(d.voices.globalCap, 8);
  assert.ok(!('comment' in d) && !('_comment' in d));
  assert.ok(Object.isFrozen(d.events.cue_a));
});

test('required cues are injected: a missing one throws, an unlisted one is optional', () => {
  assert.throws(() => buildSfxData(sfxFixture(), ['cue_c']), /cue_c missing/);
  assert.doesNotThrow(() => buildSfxData(sfxFixture(), []));
  const badBus = sfxFixture();
  badBus.events.cue_b.bus = 'nope';
  assert.throws(() => buildSfxData(badBus, ['cue_b']), /unknown bus/);
  const badDuck = sfxFixture();
  badDuck.events.cue_a.ducks = ['none'];
  assert.throws(() => buildSfxData(badDuck, ['cue_a']), /unknown duck/);
});

test('validateLayer rejects malformed layers', () => {
  assert.deepEqual(LAYER_TYPES, ['tone', 'noise', 'partials']);
  assert.throws(() => validateLayer({ type: 'tone', wave: 'kazoo', f0: 1, a: 0, d: 1 }, 't'), /wave/);
  assert.throws(() => validateLayer({ type: 'noise', a: 0, d: 1 }, 't'), /filter/);
  assert.throws(() => validateLayer({ type: 'partials', f0: 1, ratios: [1, 2], gainsDb: [0], decaysMs: [1, 1], a: 0 }, 't'), /partials/);
  assert.doesNotThrow(() => validateLayer({ type: 'tone', wave: 'sine', f0: 700, a: 1, d: 30 }, 't'));
});

test('dbToGain', () => {
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(dbToGain(-6) - 0.501) < 0.001);
});
