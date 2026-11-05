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

// ---- 0.5.2 BOOT-NET: prefetch through a download lane in group order, decode later

/** A fake lane that records adds / bumps and runs jobs in priority order when the test says so. */
function fakeLane() {
  const jobs = [];
  const bumps = [];
  const lane = {
    add({ id, priority, run }) {
      const existing = jobs.find((j) => j.id === id);
      if (existing) return existing.promise;
      const job = { id, priority, run };
      job.promise = new Promise((resolve, reject) => { job.start = () => run({ signal: null }).then(resolve, reject); });
      jobs.push(job);
      return job.promise;
    },
    bump(id, priority) { bumps.push([id, priority]); const j = jobs.find((x) => x.id === id); if (j) j.priority = priority; },
    async drain() { for (const j of [...jobs].sort((a, b) => a.priority - b.priority)) await j.start(); },
    jobs, bumps,
  };
  return lane;
}

test('prefetch_fetchesGroupsThroughTheLane_inPriorityOrder_andLoadDecodesTheHeldBytesWithoutRefetching', async () => {
  // Arrange
  const ctx = new FakeAudioContext();
  const fetch = fakeFetch(FILES);
  const lane = fakeLane();
  const bank = createSampleBank({ manifest: manifest(), resolveUrl: (f) => `b/${f}`, fetch, warn: () => {}, lane });
  // Act: fight first (30), music behind it (31); nothing goes over the wire until the lane runs
  const pf = bank.prefetch({ groups: ['fight'], priority: 30 });
  const pm = bank.prefetch({ groups: ['music'], priority: 31 });
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(lane.jobs.map((j) => j.id), ['bank:impact_heavy_01.m4a', 'bank:impact_heavy_02.m4a', 'bank:impact_heavy_03.m4a', 'bank:impact_light_01.m4a', 'bank:missing.m4a', 'bank:corrupt.m4a', 'bank:score_loop.m4a']);
  await lane.drain();
  await Promise.all([pf, pm]);
  // Assert: every file fetched once, fight before music; held, not decoded
  assert.equal(fetch.calls.at(-1), 'b/score_loop.m4a');
  assert.equal(bank.loaded(), 0);
  assert.equal(bank.status(), 'idle');
  assert.equal(bank.get('impact_heavy').raw.every((r) => r !== null), true);
  assert.deepEqual(bank.get('broken').raw.map((r) => r !== null), [false, true], 'missing.m4a (404) is not held');
  assert.notEqual(bank.get('score_loop').raw[0], null);
  // Act: the gesture arrives -> decode
  const before = fetch.calls.length;
  await bank.load((ab) => ctx.decodeAudioData(ab), { groups: ['fight'] });
  // Assert: nothing re-fetched, fight decoded, music still held
  assert.equal(fetch.calls.length, before);
  assert.equal(bank.ready('impact_heavy'), true);
  assert.equal(bank.get('impact_heavy').raw.every((r) => r === null), true, 'held bytes freed after decode');
  assert.equal(bank.ready('score_loop'), false);
  assert.notEqual(bank.get('score_loop').raw[0], null, 'music stays held until asked');
  await bank.load((ab) => ctx.decodeAudioData(ab));
  assert.equal(bank.ready('score_loop'), true);
  assert.equal(bank.status(), 'partial', 'broken stays failed; everything else decoded');
});

test('prefetch_again_moreUrgently_bumpsQueuedFiles_aLazierAskDoesNot', async () => {
  // Arrange
  const lane = fakeLane();
  const bank = createSampleBank({ manifest: manifest(), resolveUrl: (f) => `b/${f}`, fetch: fakeFetch(FILES), warn: () => {}, lane });
  bank.prefetch({ groups: ['music'], priority: 35 });
  // Act: the score is wanted sooner
  bank.prefetch({ ids: ['score_loop'], priority: 12 });
  // Assert
  assert.deepEqual(lane.bumps, [['bank:score_loop.m4a', 12]]);
  bank.prefetch({ groups: ['music'], priority: 40 }); // the regression: a lazier ask (load() at the gesture) demoted queued clips
  assert.deepEqual(lane.bumps, [['bank:score_loop.m4a', 12]], 'a lazier ask never demotes');
});
