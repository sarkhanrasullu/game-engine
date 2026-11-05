// Bundle budget checker (tools/check-bundle-size.mjs): generic behaviour against an injected limits
// object. The numbers and chunk names belong to a game; a consumer pins its own in its test suite.
// ENGINE-SMALL (2026-11-05): "main" is the eager TOTAL (every chunk no `lazy` regex matches), so a
// chunk the bundler hoists out of the entry is still counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundleSizes, listDistJs, loadLimits } from '../../tools/check-bundle-size.mjs';

/** Neutral limits for these tests only. `other-*.js` is a lazy chunk here, `hoisted-*.js` is eager. */
const L = Object.freeze({
  mainBaseline: 800000,
  mainGrowthMax: 100000,
  lazyLoaderMax: 50000,
  main: /^entry-[\w-]+\.js$/,
  lazyLoader: /^lazy-[\w-]+\.js$/,
  lazy: [/^other-[\w-]+\.js$/],
});
const HOISTED = 10000;
const files = (main, lazy) => [
  { name: 'entry-abc.js', bytes: main - HOISTED }, { name: 'hoisted-h.js', bytes: HOISTED },
  { name: 'lazy-x1.js', bytes: lazy }, { name: 'other-q.js', bytes: 2383 },
];

test('bundleCheck_withinBudgets_passes_atExactLimits', () => {
  // Act / Assert: the eager total (entry + hoisted) is what meets the limit exactly.
  assert.equal(checkBundleSizes(files(850000, 40000), L).ok, true);
  const r = checkBundleSizes(files(L.mainBaseline + L.mainGrowthMax, L.lazyLoaderMax), L);
  assert.equal(r.ok, true);
  assert.equal(r.main, L.mainBaseline + L.mainGrowthMax);
  assert.equal(r.lazy, L.lazyLoaderMax);
});

test('bundleCheck_eagerTotal_sumsEveryNonLazyChunkAndReportsBreakdown', () => {
  // Arrange: a hoisted chunk the entry regex does not match must count; the lazy ones must not.
  const r = checkBundleSizes(files(850000, 40000), L);
  // Assert
  assert.equal(r.main, 850000);
  assert.deepEqual(r.chunks, [
    { name: 'entry-abc.js', bytes: 840000, eager: true },
    { name: 'lazy-x1.js', bytes: 40000, eager: false },
    { name: 'hoisted-h.js', bytes: 10000, eager: true },
    { name: 'other-q.js', bytes: 2383, eager: false },
  ]);
  assert.match(r.lines[0], /^ok {3}main entry-abc\.js \+1 eager chunk\(s\) = 850000 B, growth \+50000 B/);
  assert.match(r.lines[1], /^ok {3}lazy lazy-x1\.js 40000 B/);
  assert.deepEqual(r.lines.slice(2), [
    '     eager entry-abc.js 840000 B', '     lazy  lazy-x1.js 40000 B', '     eager hoisted-h.js 10000 B', '     lazy  other-q.js 2383 B',
  ]);
});

test('bundleCheck_legacyLimitsWithoutLazyList_treatEveryOtherChunkAsEager', () => {
  // Arrange: the pre-ENGINE-SMALL shape (no `lazy`); only `lazyLoader` is excluded from the total.
  const { lazy: _omit, ...legacy } = L;
  // Act
  const r = checkBundleSizes(files(850000, 40000), legacy);
  // Assert
  assert.equal(r.main, 850000 + 2383);
  assert.equal(r.chunks.find((c) => c.name === 'other-q.js').eager, true);
  // A single RegExp (not an array) is accepted for `lazy` too.
  assert.equal(checkBundleSizes(files(850000, 40000), { ...legacy, lazy: /^other-/ }).main, 850000);
});

test('bundleCheck_overBudget_fails_andReportsTheLine', () => {
  // Act
  const main = checkBundleSizes(files(L.mainBaseline + L.mainGrowthMax + 1, 1000), L);
  const lazy = checkBundleSizes(files(850000, L.lazyLoaderMax + 1), L);
  // Assert
  assert.equal(main.ok, false);
  assert.match(main.lines[0], /^FAIL main .*growth \+100001 B/);
  assert.equal(lazy.ok, false);
  assert.match(lazy.lines[1], /^FAIL lazy /);
});

test('bundleCheck_missingChunkOrLimits_fails', () => {
  // Act
  const r = checkBundleSizes([{ name: 'entry-abc.js', bytes: 850000 }], L);
  // Assert
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /lazy loader chunk.*found 0/);
  assert.equal(checkBundleSizes([], L).ok, false);
  assert.equal(checkBundleSizes([], L).main, 0);
  assert.throws(() => checkBundleSizes(files(1, 1)), /limits/);
  assert.throws(() => checkBundleSizes(files(1, 1), { ...L, main: 'entry' }), /RegExp/);
  assert.throws(() => checkBundleSizes(files(1, 1), { ...L, lazy: ['other-'] }), /lazy.*RegExp/);
});

test('bundleCheck_missingDist_throws_andLimitsModuleLoads', async () => {
  // Arrange
  const dir = mkdtempSync(join(tmpdir(), 'engine-dist-'));
  try {
    const dist = join(dir, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'assets', 'entry-a.js'), 'x'.repeat(10));
    writeFileSync(join(dist, 'assets', 'entry-a.css'), 'y');
    const limitsPath = join(dir, 'limits.mjs');
    writeFileSync(limitsPath, 'export const BUNDLE_LIMITS = { mainBaseline: 1, mainGrowthMax: 2, lazyLoaderMax: 3, main: /^a$/, lazyLoader: /^b$/ };\n');
    // Act / Assert
    assert.throws(() => listDistJs(join(dir, 'nope')), /not found/);
    assert.deepEqual(listDistJs(dist), [{ name: 'entry-a.js', bytes: 10 }]);
    assert.equal((await loadLimits(limitsPath)).mainBaseline, 1);
    await assert.rejects(loadLimits(join(dir, 'missing.mjs')), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
