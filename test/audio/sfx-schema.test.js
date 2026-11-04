// SFX schema (engine /audio): snake_case -> camelCase, injected required cue list, layer validation,
// the ADR-0005 `sample` layer and optional mix sections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSfxData, validateLayer, dbToGain, LAYER_TYPES, BUSES, REQUIRED_BUSES } from '../../src/audio/sfx-schema.js';

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
  assert.deepEqual(LAYER_TYPES, ['tone', 'noise', 'partials', 'sample']);
  assert.throws(() => validateLayer({ type: 'tone', wave: 'kazoo', f0: 1, a: 0, d: 1 }, 't'), /wave/);
  assert.throws(() => validateLayer({ type: 'noise', a: 0, d: 1 }, 't'), /filter/);
  assert.throws(() => validateLayer({ type: 'partials', f0: 1, ratios: [1, 2], gainsDb: [0], decaysMs: [1, 1], a: 0 }, 't'), /partials/);
  assert.doesNotThrow(() => validateLayer({ type: 'tone', wave: 'sine', f0: 700, a: 1, d: 30 }, 't'));
});

test('sample layer: needs a bank id, optional a/d/jitter keys, synthesis-only fallback list', () => {
  const tone = { type: 'tone', wave: 'sine', f0: 700, a: 1, d: 30, db: 0 };
  assert.doesNotThrow(() => validateLayer({ type: 'sample', bank: 'impact_heavy' }, 's'), 'a and d are optional for samples');
  assert.doesNotThrow(() => validateLayer({ type: 'sample', bank: 'impact_heavy', db: -3, rateCents: 40, gainJitterDb: 1.5, startMs: 5, sendDb: -12, a: 0, d: 400, fallback: [tone] }, 's'));
  assert.throws(() => validateLayer({ type: 'sample' }, 's'), /bank/);
  assert.throws(() => validateLayer({ type: 'sample', bank: 'x', rateCents: -1 }, 's'), /rate_cents/);
  assert.throws(() => validateLayer({ type: 'sample', bank: 'x', startMs: -1 }, 's'), /start_ms/);
  assert.throws(() => validateLayer({ type: 'sample', bank: 'x', fallback: 'nope' }, 's'), /fallback/);
  assert.throws(() => validateLayer({ type: 'sample', bank: 'x', fallback: [{ type: 'sample', bank: 'y' }] }, 's'), /synthesis/);
  assert.throws(() => validateLayer({ type: 'sample', bank: 'x', fallback: [{ type: 'tone', wave: 'kazoo', f0: 1, a: 0, d: 1 }] }, 's'), /fallback\[0\].*wave/);
  // nested in a table: the walker validates the fallback through validateLayer
  const t = sfxFixture();
  t.events.cue_a.layers = [{ type: 'sample', bank: 'impact', db: 0, fallback: [{ type: 'noise', a: 0, d: 1 }] }];
  assert.throws(() => buildSfxData(t, ['cue_a']), /fallback\[0\].*filter/);
  t.events.cue_a.layers = [{ type: 'sample', bank: 'impact', db: 0, rate_cents: 30, fallback: [tone] }];
  const d = buildSfxData(t, ['cue_a']);
  assert.equal(d.events.cue_a.layers[0].rateCents, 30, 'wire keys are camelised inside sample layers too');
});

test('optional ambience bus: accepted in bus_db, events and ducks; the five base buses stay required', () => {
  assert.deepEqual(REQUIRED_BUSES, ['combat', 'movement', 'match', 'ui', 'music']);
  assert.deepEqual(BUSES, [...REQUIRED_BUSES, 'ambience']);
  const t = sfxFixture();
  t.events.cue_b.bus = 'ambience';
  assert.throws(() => buildSfxData(t, ['cue_b']), /no mix.bus_db level/, 'an ambience event needs the bus levelled');
  t.mix.bus_db.ambience = -10;
  t.ducks.big.buses = ['music', 'ambience'];
  assert.doesNotThrow(() => buildSfxData(t, ['cue_a', 'cue_b']));
  const missing = sfxFixture();
  delete missing.mix.bus_db.music;
  assert.throws(() => buildSfxData(missing, []), /bus_db.music missing/);
  const stray = sfxFixture();
  stray.mix.bus_db.kitchen = 0;
  assert.throws(() => buildSfxData(stray, []), /unknown bus kitchen/);
});

test('optional mix sections: reverb, bass_enhance, combat_comp are validated when present', () => {
  const t = sfxFixture();
  t.mix.reverb = { ir_seconds: 2.4, return_db: -6, send_db: { combat: -14, music: -30 } };
  t.mix.bass_enhance = { split_hz: 120, drive: 2.5, band_hz: [180, 360], mix_db: -8, buses: ['combat', 'movement'] };
  t.mix.combat_comp = { threshold_db: -18, ratio: 3, knee_db: 6, attack_ms: 6, release_ms: 120 };
  const d = buildSfxData(t, []);
  assert.equal(d.mix.reverb.sendDb.combat, -14, 'send_db keeps bus ids as keys');
  assert.equal(d.mix.bassEnhance.mixDb, -8);
  const badSend = sfxFixture();
  badSend.mix.reverb = { ir_seconds: 1, return_db: -6, send_db: { kitchen: -3 } };
  assert.throws(() => buildSfxData(badSend, []), /unknown bus kitchen/);
  const badIr = sfxFixture();
  badIr.mix.reverb = { return_db: -6 };
  assert.throws(() => buildSfxData(badIr, []), /ir_seconds/);
  const badLift = sfxFixture();
  badLift.mix.bass_enhance = { mix_db: -8 };
  assert.throws(() => buildSfxData(badLift, []), /bass_enhance/);
  const badComp = sfxFixture();
  badComp.mix.combat_comp = { threshold_db: -18, ratio: 0.5 };
  assert.throws(() => buildSfxData(badComp, []), /combat_comp/);
});

test('dbToGain', () => {
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(dbToGain(-6) - 0.501) < 0.001);
});
