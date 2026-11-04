// Bundle budget checker (tools/check-bundle-size.mjs): generic behaviour against an injected limits
// object. The numbers and chunk names belong to a game; a consumer pins its own in its test suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundleSizes, listDistJs, loadLimits } from '../../tools/check-bundle-size.mjs';

/** Neutral limits for these tests only. */
const L = Object.freeze({
  mainBaseline: 800000,
  mainGrowthMax: 100000,
  lazyLoaderMax: 50000,
  main: /^entry-[\w-]+\.js$/,
  lazyLoader: /^lazy-[\w-]+\.js$/,
});
const files = (main, lazy) => [
  { name: 'entry-abc.js', bytes: main }, { name: 'lazy-x1.js', bytes: lazy }, { name: 'other-q.js', bytes: 2383 },
];

test('bundleCheck_withinBudgets_passes_atExactLimits', () => {
  // Act / Assert
  assert.equal(checkBundleSizes(files(850000, 40000), L).ok, true);
  assert.equal(checkBundleSizes(files(L.mainBaseline + L.mainGrowthMax, L.lazyLoaderMax), L).ok, true);
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
  assert.throws(() => checkBundleSizes(files(1, 1)), /limits/);
  assert.throws(() => checkBundleSizes(files(1, 1), { ...L, main: 'entry' }), /RegExp/);
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
