// Lite glTF tool (tools/hero-lite.mjs) on synthetic fixtures: KTX2 header/level-index rewriting for
// both supercompression schemes, GLB repacking that keeps every non-image region byte for byte, and
// the inline payload built from an injected asset-set config. A consumer proves the lossless property
// on its real exports with the basis transcoder; here the structure is what is under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropKtx2TopLevels, ktx2Info, makeLiteGlb, readGlb, writeGlb, rewriteGlbImages, buildInlinePayload } from '../../tools/hero-lite.mjs';

const KTX2_ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const align = (n, a) => Math.ceil(n / a) * a;

/**
 * A structurally valid 2D KTX2 file: `size`² base, full mip chain, each level's payload a run of its
 * own level index byte so copies can be told apart. Scheme 1 gets an SGD with one 20-byte image
 * descriptor per level (filled with the level index), scheme 2 none.
 */
function fakeKtx2(size, scheme, { kvdBytes = 8 } = {}) {
  const levelCount = Math.log2(size) + 1;
  const dfd = new Uint8Array(44).fill(0xdd);
  const kvd = new Uint8Array(kvdBytes).fill(0xee);
  const sgd = scheme === 1 ? new Uint8Array(20 + levelCount * 20 + 16) : new Uint8Array(0);
  if (scheme === 1) {
    sgd.fill(0x55, 0, 20);
    for (let i = 0; i < levelCount; i++) sgd.fill(0x80 + i, 20 + i * 20, 40 + i * 20);
    sgd.fill(0xcc, 20 + levelCount * 20);
  }
  let at = 80 + levelCount * 24;
  const dfdAt = align(at, 4); at = dfdAt + dfd.length;
  const kvdAt = kvd.length ? align(at, 4) : 0; if (kvd.length) at = kvdAt + kvd.length;
  const sgdAt = sgd.length ? align(at, 8) : 0; if (sgd.length) at = sgdAt + sgd.length;
  // Level data smallest first: level i has (size >> i)² / 16 bytes (min 4).
  const lengths = Array.from({ length: levelCount }, (_, i) => Math.max(4, ((size >> i) * (size >> i)) / 16));
  const offsets = new Array(levelCount);
  for (let i = levelCount - 1; i >= 0; i--) { offsets[i] = at; at += lengths[i]; }
  const out = new Uint8Array(at);
  out.set(KTX2_ID, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(20, size, true); dv.setUint32(24, size, true); dv.setUint32(28, 0, true);
  dv.setUint32(32, 0, true); dv.setUint32(36, 1, true); dv.setUint32(40, levelCount, true); dv.setUint32(44, scheme, true);
  dv.setUint32(48, dfdAt, true); dv.setUint32(52, dfd.length, true); dv.setUint32(56, kvdAt, true); dv.setUint32(60, kvd.length, true);
  dv.setBigUint64(64, BigInt(sgdAt), true); dv.setBigUint64(72, BigInt(sgd.length), true);
  for (let i = 0; i < levelCount; i++) {
    dv.setBigUint64(80 + i * 24, BigInt(offsets[i]), true);
    dv.setBigUint64(88 + i * 24, BigInt(lengths[i]), true);
    dv.setBigUint64(96 + i * 24, BigInt(lengths[i] * 4), true);
    out.fill(i, offsets[i], offsets[i] + lengths[i]);
  }
  out.set(dfd, dfdAt);
  if (kvd.length) out.set(kvd, kvdAt);
  if (sgd.length) out.set(sgd, sgdAt);
  return out;
}

const levelBytes = (bytes, i) => { const l = ktx2Info(bytes).levels[i]; return bytes.subarray(l.offset, l.offset + l.length); };

/** A GLB with one geometry view, one meshopt-compressed view, one KTX2 image view, in that BIN order. */
function fakeGlb(ktx2) {
  const geom = new Uint8Array(37).fill(0xa1);
  const packed = new Uint8Array(21).fill(0xb2);
  const g0 = 0; const p0 = align(geom.length, 4); const i0 = align(p0 + packed.length, 4);
  const bin = new Uint8Array(align(i0 + ktx2.length, 4));
  bin.set(geom, g0); bin.set(packed, p0); bin.set(ktx2, i0);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }, { byteLength: 64 }],
    bufferViews: [
      { buffer: 0, byteOffset: g0, byteLength: geom.length },
      { buffer: 1, byteLength: 64, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: p0, byteLength: packed.length, mode: 'ATTRIBUTES', count: 3, byteStride: 7 } } },
      { buffer: 0, byteOffset: i0, byteLength: ktx2.length },
    ],
    images: [{ name: 'base', mimeType: 'image/ktx2', bufferView: 2 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
  };
  return { glb: writeGlb(json, bin), geom, packed };
}

test('dropKtx2TopLevels_zstdScheme_cutsToMaxKeepsLowerLevelsByteForByte', () => {
  // Arrange
  const full = fakeKtx2(2048, 2);
  // Act
  const lite = dropKtx2TopLevels(full, 1024);
  // Assert
  const fi = ktx2Info(full); const li = ktx2Info(lite);
  assert.equal(fi.levelCount, 12);
  assert.deepEqual([li.width, li.height, li.levelCount, li.scheme, li.sgd[1]], [1024, 1024, 11, 2, 0]);
  for (let i = 0; i < li.levelCount; i++) {
    assert.equal(Buffer.compare(Buffer.from(levelBytes(lite, i)), Buffer.from(levelBytes(full, i + 1))), 0, `level ${i}`);
    assert.equal(li.levels[i].uncompressed, fi.levels[i + 1].uncompressed);
  }
  assert.equal(Buffer.compare(Buffer.from(lite.subarray(li.dfd[0], li.dfd[0] + li.dfd[1])), Buffer.from(full.subarray(fi.dfd[0], fi.dfd[0] + fi.dfd[1]))), 0, 'dfd');
  assert.equal(li.kvd[1], fi.kvd[1]);
  assert.ok(lite.length < full.length);
  // Two levels down when max is 512.
  assert.equal(ktx2Info(dropKtx2TopLevels(full, 512)).width, 512);
});

test('dropKtx2TopLevels_basisLzScheme_trimsOneImageDescriptorPerDroppedLevel', () => {
  // Arrange
  const full = fakeKtx2(1024, 1);
  // Act
  const lite = dropKtx2TopLevels(full, 256);
  // Assert
  const fi = ktx2Info(full); const li = ktx2Info(lite);
  assert.equal(li.levelCount, fi.levelCount - 2);
  assert.equal(li.sgd[1], fi.sgd[1] - 2 * 20);
  assert.equal(li.sgd[0] % 8, 0, 'sgd 8-aligned');
  const sgd = lite.subarray(li.sgd[0], li.sgd[0] + li.sgd[1]);
  assert.equal(sgd[0], 0x55, 'sgd header kept');
  assert.equal(sgd[20], 0x82, 'first kept descriptor is the one of old level 2');
  assert.equal(sgd[20 + li.levelCount * 20], 0xcc, 'codebooks follow the kept descriptors');
});

test('dropKtx2TopLevels_fitsOrUnsupported_returnsInputOrThrows', () => {
  // Arrange
  const small = fakeKtx2(512, 2);
  const raw = fakeKtx2(2048, 0);
  const notKtx = new Uint8Array(100);
  // Act / Assert
  assert.equal(dropKtx2TopLevels(small, 1024), small, 'already fits: same object back');
  assert.throws(() => dropKtx2TopLevels(raw, 1024), /uncompressed/);
  assert.throws(() => ktx2Info(notKtx), /not a KTX2/);
});

test('glb_roundTripAndRewriteImages_keepGeometryAndMeshoptBytesAndRealign', () => {
  // Arrange
  const { glb, geom, packed } = fakeGlb(fakeKtx2(2048, 2));
  const before = readGlb(glb);
  // Act
  const lite = makeLiteGlb(glb, 1024);
  const after = readGlb(lite);
  const untouched = rewriteGlbImages(glb, (b) => b);
  // Assert: round trip is stable, images shrink, everything else is byte-identical and 4-aligned.
  assert.deepEqual(readGlb(writeGlb(before.json, before.bin)).json, before.json);
  assert.deepEqual(after.json.accessors, before.json.accessors);
  const v = after.json.bufferViews;
  assert.equal(Buffer.compare(Buffer.from(after.bin.subarray(v[0].byteOffset, v[0].byteOffset + v[0].byteLength)), Buffer.from(geom)), 0, 'geometry');
  const ext = v[1].extensions.EXT_meshopt_compression;
  assert.equal(Buffer.compare(Buffer.from(after.bin.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength)), Buffer.from(packed)), 0, 'meshopt source');
  assert.equal(ktx2Info(after.bin.subarray(v[2].byteOffset, v[2].byteOffset + v[2].byteLength)).width, 1024);
  for (const x of [v[0].byteOffset, ext.byteOffset, v[2].byteOffset]) assert.equal(x % 4, 0);
  assert.equal(after.json.buffers[0].byteLength, after.bin.length);
  assert.deepEqual(after.json.buffers[1], before.json.buffers[1], 'other buffers untouched');
  assert.ok(lite.length < glb.length);
  assert.equal(Buffer.compare(Buffer.from(untouched), Buffer.from(glb)), 0, 'identity map reproduces the input');
});

test('buildInlinePayload_injectedSets_filtersIdsAndCarriesTranscoder', () => {
  // Arrange: two asset sets and a transcoder folder in a temp dir; no engine-side names.
  const dir = mkdtempSync(join(tmpdir(), 'engine-lite-'));
  try {
    const a = join(dir, 'a'); const b = join(dir, 'b'); const basis = join(dir, 'basis');
    for (const d of [a, b, basis]) mkdirSync(d);
    writeFileSync(join(a, 'one.glb'), fakeGlb(fakeKtx2(2048, 2)).glb);
    writeFileSync(join(a, 'two.glb'), fakeGlb(fakeKtx2(1024, 2)).glb);
    writeFileSync(join(a, 'manifest.json'), JSON.stringify({ assets: [{ id: 'one', file: 'one.glb' }, { id: 'two', file: 'two.glb' }] }));
    writeFileSync(join(b, 'arena.glb'), fakeGlb(fakeKtx2(2048, 1)).glb);
    writeFileSync(join(b, 'manifest.json'), JSON.stringify({ assets: [{ id: 'arena', file: 'arena.glb' }] }));
    writeFileSync(join(basis, 'basis_transcoder.js'), 'var BASIS = 1;');
    writeFileSync(join(basis, 'basis_transcoder.wasm'), new Uint8Array([0, 0x61, 0x73, 0x6d]));
    const cfg = { sets: [{ dir: a, prefix: 'chars', ids: ['one'] }, { dir: b, prefix: 'stage' }], basisDir: basis, maxSize: 1024 };
    // Act
    const p = buildInlinePayload(cfg);
    const m = JSON.parse(p['chars/manifest.json'].data);
    // Assert
    assert.deepEqual(Object.keys(p).sort(), ['basis/basis_transcoder.js', 'basis/basis_transcoder.wasm', 'chars/manifest.json', 'chars/one.lite.glb', 'stage/arena.lite.glb', 'stage/manifest.json']);
    assert.deepEqual(m.assets.map((x) => x.id), ['one']);
    assert.deepEqual(m.assets[0].lite, { file: 'one.lite.glb', bytes: Buffer.from(p['chars/one.lite.glb'].data, 'base64').length, maxMap: 1024 });
    assert.equal(JSON.parse(p['stage/manifest.json'].data).assets[0].lite.file, 'arena.lite.glb');
    assert.equal(p['basis/basis_transcoder.js'].type, 'text');
    assert.equal(p['basis/basis_transcoder.wasm'].type, 'base64');
    assert.ok(!Object.keys(buildInlinePayload({ ...cfg, sets: cfg.sets.slice(0, 1) })).some((k) => k.startsWith('stage/')));
    assert.throws(() => buildInlinePayload({ sets: cfg.sets }), /basisDir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyIdsOverride_replacesIdsOnHeroKindSetsOnly_leavesStageAndUnkindedSets', async () => {
  // ENGINE-SMALL (STAGE2-ART): `--ids` used to replace the ids of EVERY set that declared one, so a
  // hero pick on the CLI also dropped the stage set. It now scopes to `kind: 'heroes'`.
  const { applyIdsOverride } = await import('../../tools/hero-lite.mjs');
  // Arrange
  const sets = [
    { dir: 'h', prefix: 'heroes', kind: 'heroes', ids: ['a', 'b'] },
    { dir: 's', prefix: 'stage', kind: 'stage', ids: ['dais'] },
    { dir: 'x', prefix: 'extra', ids: ['one'] }, // no kind: not a hero set, untouched
    { dir: 'all', prefix: 'all', kind: 'heroes' }, // hero set without ids (= every asset): the pick narrows it
  ];
  // Act
  const out = applyIdsOverride(sets, ['c']);
  // Assert
  assert.deepEqual(out.map((s) => s.ids), [['c'], ['dais'], ['one'], ['c']]);
  assert.deepEqual(sets.map((s) => s.ids), [['a', 'b'], ['dais'], ['one'], undefined], 'input not mutated');
  assert.equal(applyIdsOverride(sets, undefined), sets, 'no override: same sets');
  assert.throws(() => applyIdsOverride(sets, []), /ids/);
  assert.throws(() => applyIdsOverride(sets, 'c'), /ids/);
});
