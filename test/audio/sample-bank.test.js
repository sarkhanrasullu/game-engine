// Sample bank (engine /audio, ADR-0005): manifest parsing, lazy shared loading, per-clip failure
// containment (synthesis fallback stays possible), round-robin without immediate repeats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSampleBank, parseBankManifest } from '../../src/audio/sample-bank.js';
import { FakeAudioContext, fakeFetch } from '../fixtures/fake-audio.js';

function manifest() {
  return {
    version: 1,
    clips: {
      impact_heavy: { files: ['impact_heavy_01.m4a', 'impact_heavy_02.m4a', 'impact_heavy_03.m4a'], gain_db: -2, group: 'fight' },
      impact_light: { files: ['impact_light_01.m4a'], group: 'fight' },
      score_loop: { files: ['score_loop.m4a'], loop: { start: 1.5, end: 9.5 }, group: 'music' },
      broken: { files: ['missing.m4a', 'corrupt.m4a'], group: 'fight' },
    },
  };
}

/** URL -> byte length; 0 bytes makes the fake decoder reject; absent = 404. */
const FILES = {
  'b/impact_heavy_01.m4a': 400, 'b/impact_heavy_02.m4a': 400, 'b/impact_heavy_03.m4a': 400,
  'b/impact_light_01.m4a': 200, 'b/score_loop.m4a': 8000, 'b/corrupt.m4a': 0,
};

function setup() {
  const ctx = new FakeAudioContext();
  const fetch = fakeFetch(FILES);
  const warnings = [];
  const bank = createSampleBank({ manifest: manifest(), resolveUrl: (f) => `b/${f}`, fetch, warn: (m) => warnings.push(m) });
  return { ctx, fetch, warnings, bank, decode: (ab) => ctx.decodeAudioData(ab) };
}

test('parseBankManifest_validatesClips_rejectsMalformed', () => {
  const clips = parseBankManifest(manifest());
  assert.deepEqual(clips.impact_heavy.files, ['impact_heavy_01.m4a', 'impact_heavy_02.m4a', 'impact_heavy_03.m4a']);
  assert.equal(clips.impact_heavy.gainDb, -2);
  assert.deepEqual(clips.score_loop.loop, { start: 1.5, end: 9.5 });
  assert.equal(clips.impact_light.loop, null);
  assert.throws(() => parseBankManifest({}), /missing clips/);
  assert.throws(() => parseBankManifest({ clips: { x: { files: [] } } }), /non-empty/);
  assert.throws(() => parseBankManifest({ clips: { x: { files: ['a'], loop: { start: 2, end: 1 } } } }), /loop/);
});

test('load_isLazySharedAndContained_failedClipsFallBackWithoutRejecting', async () => {
  const { bank, fetch, warnings, decode } = setup();
  assert.equal(bank.status(), 'idle');
  assert.equal(fetch.calls.length, 0, 'nothing fetched at creation');
  assert.equal(bank.pick('impact_heavy'), null, 'not loaded: caller plays the fallback');
  const p1 = bank.load(decode);
  const p2 = bank.load(decode);
  assert.equal(bank.status(), 'loading');
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1, 'partial');
  assert.equal(s2, 'partial');
  assert.equal(fetch.calls.length, 7, 'each file fetched once despite two concurrent loads');
  assert.equal(bank.ready('impact_heavy'), true);
  assert.equal(bank.ready('broken'), false);
  assert.equal(bank.get('broken').failed, true);
  assert.equal(bank.pick('broken'), null);
  assert.equal(warnings.length, 2, 'one warning per unavailable variant');
  assert.ok(warnings.every((w) => /fallback/.test(w)));
  assert.equal(bank.loaded(), 5);
  const before = fetch.calls.length;
  await bank.load(decode);
  assert.equal(fetch.calls.length, before, 'a second load re-fetches nothing');
});

test('load_filtersByGroupOrIds', async () => {
  const { bank, fetch, decode } = setup();
  await bank.load(decode, { groups: ['music'] });
  assert.deepEqual(fetch.calls, ['b/score_loop.m4a']);
  assert.equal(bank.ready('score_loop'), true);
  assert.equal(bank.ready('impact_light'), false);
  await bank.load(decode, { ids: ['impact_light'] });
  assert.equal(bank.ready('impact_light'), true);
  assert.equal(bank.get('score_loop').loop.end, 9.5);
});

test('pick_roundRobinNeverRepeatsTheLastVariant', async () => {
  const { bank, decode } = setup();
  await bank.load(decode, { ids: ['impact_heavy', 'impact_light'] });
  const seq = [];
  let r = 0.01;
  for (let i = 0; i < 30; i++) {
    seq.push(bank.pick('impact_heavy', () => { r = (r + 0.37) % 1; return r; }));
  }
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `repeat at ${i}`);
  assert.equal(new Set(seq).size, 3, 'all three variants get played');
  const only = bank.pick('impact_light');
  assert.equal(bank.pick('impact_light'), only, 'a single-variant clip repeats (nothing else to play)');
  assert.equal(bank.pick('unknown'), null);
});

test('unload_dropsBuffersAndAllowsReload; bytes() reports the footprint', async () => {
  const { bank, decode, ctx } = setup();
  await bank.load(decode, { ids: ['impact_light'] });
  assert.equal(bank.bytes(), (200 >> 2) * 4);
  bank.unload();
  assert.equal(bank.status(), 'idle');
  assert.equal(bank.pick('impact_light'), null);
  await bank.load(decode, { ids: ['impact_light'] });
  assert.equal(bank.ready('impact_light'), true);
  assert.equal(ctx.decoded.length, 2);
});

test('load_withoutFetchMarksEverythingFailed_andRequiresADecoder', async () => {
  const bank = createSampleBank({ manifest: manifest(), resolveUrl: (f) => f, fetch: undefined, warn: () => {} });
  await assert.rejects(() => bank.load(/** @type {any} */ (null)), TypeError);
  assert.equal(await bank.load(async () => null), 'failed');
});
