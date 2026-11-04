// blender/source-hash.mjs + config.mjs (ADR-0003 stale-export rule, ADR-0004 A7.7): the engine tree and
// the consumer's scripts tree are hashed under ONE logical prefix, so a byte-for-byte move between the
// two keeps every recorded hash; a consumer config resolves with neutral defaults. Throwaway temp trees
// only, no repo files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENCODER_PACKAGES, ENGINE_BLENDER_DIR, pinnedBpyVersion, resolveConfig } from '../../blender/config.mjs';
import { assetInputFiles, listAssetScripts, listPipelineFiles, proportionsHash, sha256, sourceHash } from '../../blender/source-hash.mjs';

const KINDS = { smoke: 'assets/smoke', heroes: 'assets/heroes' };
const PKG = JSON.stringify({ devDependencies: { meshoptimizer: '1.2.0' } });

/** A temp consumer root with a `put(rel, text)` helper. */
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'source-hash-'));
  const put = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('package.json', PKG);
  return { root, put };
}

/** Engine files in `engine/`, consumer scripts in `tools/blender/` (the shipped layout). */
function splitLayout() {
  const t = tempRoot();
  t.put('engine/build.py', 'print("build")\n');
  t.put('engine/lib/bake.py', 'SAMPLES = 16\n');
  t.put('engine/smoke/smoke_cube.py', 'ASSET = {"id": "smoke_cube"}\n');
  t.put('tools/blender/blender.config.mjs', 'export default {}\n');
  t.put('tools/blender/heroes/hero_a.py', 'ASSET = {"id": "hero_a"}\n');
  t.put('tools/blender/heroes/_evidence.py', '# helper, not an asset\n');
  t.put('tools/blender/.build/hero_a/raw.glb', 'intermediate');
  t.cfg = resolveConfig({ root: t.root, kinds: KINDS, engineDir: 'engine' });
  return t;
}

/** The same bytes with everything under tools/blender/ (the pre-ADR-0004 layout). */
function singleLayout() {
  const t = tempRoot();
  t.put('tools/blender/build.py', 'print("build")\n');
  t.put('tools/blender/lib/bake.py', 'SAMPLES = 16\n');
  t.put('tools/blender/smoke/smoke_cube.py', 'ASSET = {"id": "smoke_cube"}\n');
  t.put('tools/blender/blender.config.mjs', 'export default {}\n');
  t.put('tools/blender/heroes/hero_a.py', 'ASSET = {"id": "hero_a"}\n');
  t.put('tools/blender/heroes/_evidence.py', '# helper, not an asset\n');
  t.cfg = resolveConfig({ root: t.root, kinds: KINDS, engineDir: null });
  return t;
}

test('sourceHash_logicalNames_mergeBothTreesUnderToolsBlender', () => {
  const t = splitLayout();
  try {
    // Act
    const files = listPipelineFiles(t.cfg);
    // Assert
    assert.deepEqual(files.map((f) => f.logical), [
      'tools/blender/blender.config.mjs',
      'tools/blender/build.py',
      'tools/blender/heroes/_evidence.py',
      'tools/blender/heroes/hero_a.py',
      'tools/blender/lib/bake.py',
      'tools/blender/smoke/smoke_cube.py',
    ]);
    assert.ok(files.find((f) => f.logical === 'tools/blender/build.py').abs.startsWith(join(t.root, 'engine')));
    assert.deepEqual(listAssetScripts(t.cfg).map((s) => `${s.kind}/${s.id}`), ['smoke/smoke_cube', 'heroes/hero_a']);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('sourceHash_byteForByteMoveBetweenTrees_keepsEveryHash', () => {
  const split = splitLayout();
  const single = singleLayout();
  try {
    // Act / Assert: the ADR-0004 A7.7 rule
    assert.equal(sourceHash('heroes', 'hero_a', split.cfg), sourceHash('heroes', 'hero_a', single.cfg));
    assert.equal(sourceHash('smoke', 'smoke_cube', split.cfg), sourceHash('smoke', 'smoke_cube', single.cfg));
  } finally {
    rmSync(split.root, { recursive: true, force: true });
    rmSync(single.root, { recursive: true, force: true });
  }
});

test('sourceHash_sharedEngineFileAndOwnScript_staleTheExport_otherScriptsAndBuildDirDoNot', () => {
  const t = splitLayout();
  try {
    const before = sourceHash('heroes', 'hero_a', t.cfg);
    // Act / Assert
    assert.ok(assetInputFiles('heroes', 'hero_a', t.cfg).every((f) => !f.logical.startsWith('tools/blender/smoke/')));
    t.put('engine/smoke/smoke_cube.py', 'ASSET = {"id": "smoke_cube", "seed": 2}\n');
    t.put('tools/blender/.build/hero_a/raw.glb', 'other intermediate');
    t.put('engine/build.py', 'print("build")\r\n');
    assert.equal(sourceHash('heroes', 'hero_a', t.cfg), before, 'other kinds, intermediates and CRLF must not stale');
    t.put('engine/lib/bake.py', 'SAMPLES = 32\n');
    const afterLib = sourceHash('heroes', 'hero_a', t.cfg);
    assert.notEqual(afterLib, before, 'a shared engine lib edit must stale');
    t.put('tools/blender/heroes/hero_a.py', 'ASSET = {"id": "hero_a", "seed": 9}\n');
    assert.notEqual(sourceHash('heroes', 'hero_a', t.cfg), afterLib, 'own script edit must stale');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('sourceHash_sameLogicalNameInBothTrees_throws', () => {
  const t = splitLayout();
  try {
    // Arrange: a consumer that kept a stale copy of a moved file
    t.put('tools/blender/lib/bake.py', 'SAMPLES = 16\n');
    // Act / Assert
    assert.throws(() => listPipelineFiles(t.cfg), /tools\/blender\/lib\/bake\.py exists in both trees/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('sourceHash_proportionsProvider_hashesOnlyConfiguredKinds', () => {
  const t = splitLayout();
  try {
    const text = '{"schema": 1}\n';
    const withProps = resolveConfig({ root: t.root, kinds: KINDS, engineDir: 'engine', proportions: () => text });
    // Act / Assert
    assert.equal(proportionsHash('heroes', withProps), sha256(text));
    assert.equal(proportionsHash('smoke', withProps), null);
    assert.equal(proportionsHash('heroes', t.cfg), null, 'no provider -> no proportions line');
    assert.notEqual(sourceHash('heroes', 'hero_a', withProps), sourceHash('heroes', 'hero_a', t.cfg));
    assert.equal(sourceHash('smoke', 'smoke_cube', withProps), sourceHash('smoke', 'smoke_cube', t.cfg));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('resolveConfig_defaults_areNeutralAndAbsolute', () => {
  // Act
  const cfg = resolveConfig({ root: '/repo', kinds: { smoke: 'assets/smoke' } });
  // Assert
  assert.equal(cfg.scriptsDir, '/repo/tools/blender');
  assert.equal(cfg.buildDir, '/repo/tools/blender/.build');
  assert.equal(cfg.evidenceDir, '/repo/production/qa/evidence');
  assert.equal(cfg.engineDir, ENGINE_BLENDER_DIR);
  assert.equal(cfg.bpyVersion, pinnedBpyVersion());
  assert.match(cfg.bpyVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(cfg.venv, join(homedir(), `.cache/game-engine/bpy-${cfg.bpyVersion}-py3.13`));
  assert.equal(cfg.python, null);
  assert.equal(cfg.niceness, null);
  assert.equal(cfg.generator, 'game-engine blender');
  assert.deepEqual([...cfg.proportionsFor], ['heroes']);
  assert.deepEqual([...cfg.encoderPackages], [...ENCODER_PACKAGES]);
  assert.equal(cfg.logicalPrefix, 'tools/blender');
});

test('resolveConfig_consumerValues_expandTildeAndRejectBadShapes', () => {
  // Act
  const cfg = resolveConfig({ root: '/repo', kinds: { a: 'x' }, venv: '~/.cache/my-game/venv', niceness: 19, generator: 'my-game tools' });
  // Assert
  assert.equal(cfg.venv, join(homedir(), '.cache/my-game/venv'));
  assert.equal(cfg.niceness, 19);
  assert.equal(cfg.generator, 'my-game tools');
  assert.throws(() => resolveConfig({ kinds: { a: 'x' } }), /`root`/);
  assert.throws(() => resolveConfig({ root: '/repo' }), /`kinds`/);
  assert.throws(() => resolveConfig({ root: '/repo', kinds: { a: 'x' }, proportions: 'text' }), /`proportions`/);
});
