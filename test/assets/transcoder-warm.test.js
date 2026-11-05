// Transcoder warm-up (0.5.2 BOOT-NET): both files fetched at boot, served to the loader as blob: URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscoderWarm, TRANSCODER_FILES } from '../../src/assets/transcoder-warm.js';

function fakeFetch(files, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    if (!(url in files)) return { ok: false, status: 404, blob: async () => ({ size: 0 }) };
    return { ok: true, status: 200, blob: async () => ({ size: files[url] }) };
  };
}
const JS = 'basis/basis_transcoder.js';
const WASM = 'basis/basis_transcoder.wasm';

test('transcoderWarm_fetchesBothFilesWithHighPriority_andMapsTheirUrlsToBlobs', async () => {
  // Arrange
  const calls = [];
  let made = 0;
  const revoked = [];
  let stackImports = 0;
  const warm = createTranscoderWarm({ transcoderPath: 'basis/', fetch: fakeFetch({ [JS]: 100, [WASM]: 500 }, calls), createObjectURL: () => `blob:${++made}`, revokeObjectURL: (u) => revoked.push(u), loadStack: async () => { stackImports++; } });
  assert.equal(warm.urlModifier(JS), JS, 'transparent before the warm');
  assert.equal(calls.length, 0, 'nothing is fetched until start()');
  // Act
  const p = warm.start();
  assert.equal(warm.start(), p, 'start() is idempotent');
  const ok = await p;
  // Assert
  assert.equal(ok, true);
  assert.deepEqual(calls.map((c) => c.url), TRANSCODER_FILES.map((f) => `basis/${f}`));
  assert.ok(calls.every((c) => c.init?.priority === 'high'));
  assert.equal(stackImports, 1, 'the lazy loader chunk starts with the warm, once');
  assert.match(warm.urlModifier(JS), /^blob:/);
  assert.match(warm.urlModifier('https://host/app/basis/basis_transcoder.wasm'), /^blob:/, 'an absolute URL ending in the file maps too');
  assert.equal(warm.urlModifier('heroes/a.glb'), 'heroes/a.glb', 'other URLs pass through');
  warm.dispose();
  assert.equal(revoked.length, 2);
  assert.equal(warm.urlModifier(JS), JS, 'transparent after dispose');
});

test('transcoderWarm_aFailedFile_leavesTheModifierTransparent_andNeverRejects', async () => {
  // Arrange: the wasm is missing; half a transcoder must not be served
  const warm = createTranscoderWarm({ transcoderPath: 'basis/', fetch: fakeFetch({ [JS]: 100 }, []), createObjectURL: () => 'blob:x', revokeObjectURL: () => {}, loadStack: null });
  // Act
  const ok = await warm.start();
  // Assert
  assert.equal(ok, false);
  assert.equal(warm.urlModifier(JS), JS);
  assert.equal(warm.urlModifier(WASM), WASM);
});

test('transcoderWarm_withoutFetch_resolvesFalse_andAFailedChunkImportStaysContained', async () => {
  const warm = createTranscoderWarm({ transcoderPath: 'basis/', fetch: undefined, loadStack: async () => { throw new Error('chunk 404'); } });
  assert.equal(await warm.start(), false);
});
