// Compress a raw Blender .glb into the shipped form and record it in the manifest (ADR-0003 §Pipeline).
//
//   node blender/compress.mjs --config <blender.config.mjs> --kind smoke --id smoke_cube \
//        --raw <buildDir>/smoke_cube/smoke_cube.raw.glb [--rig <buildDir>/smoke_cube/smoke_cube.rig.json]
//
// Steps, all with exact-pinned npm packages (see ENCODER_PACKAGES in config.mjs):
//   dedup + prune (glTF-Transform) -> KTX2 textures (ktx2-encoder, Basis Universal wasm: UASTC + zstd
//   for normal maps, ETC1S for colour / ORM) -> meshopt geometry (reorder + quantize +
//   EXT_meshopt_compression) -> <root>/<kinds[kind]>/<id>.glb + <root>/<kinds[kind]>/manifest.json.
// No Draco, no PNG/JPEG left in the output: both are checked after writing and fail the build.
//
// The encoder packages are the CONSUMER's devDependencies (their versions are part of the source hash),
// so they are resolved from the consumer's root, never from this package: the engine has no runtime
// dependencies. Why not `gltf-transform etc1s/uastc` (the CLI): it shells out to KTX-Software's `ktx`
// binary, which is not installable everywhere.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { GLTF_TRANSFORM_VERSION, loadConfig } from './config.mjs';
import { contractViolations, glbJson, lodStats } from './glb-contract.mjs';
import { encoderVersions, proportionsHash, sha256, sourceHash } from './source-hash.mjs';

/** Basis settings per texture role. Normal maps keep UASTC quality; colour and ORM take ETC1S. */
export const KTX2_PROFILES = Object.freeze({
  normal: { codec: 'uastc', isUASTC: true, isNormalMap: true, isSetKTX2SRGBTransferFunc: false, isPerceptual: false, uastcLDRQualityLevel: 2, needSupercompression: true, generateMipmap: true },
  color: { codec: 'etc1s', isUASTC: false, isSetKTX2SRGBTransferFunc: true, isPerceptual: true, qualityLevel: 128, compressionLevel: 2, generateMipmap: true },
  data: { codec: 'etc1s', isUASTC: false, isSetKTX2SRGBTransferFunc: false, isPerceptual: false, qualityLevel: 128, compressionLevel: 2, generateMipmap: true },
});
const SRGB_SLOTS = new Set(['baseColorTexture', 'emissiveTexture']);

/** The generator string written to the manifest and the glTF asset, e.g. `my-game tools/blender (bpy 5.2.3, glTF-Transform 4.5.1)`. */
export function generatorString(cfg) {
  return `${cfg.generator} (bpy ${cfg.bpyVersion}, glTF-Transform ${GLTF_TRANSFORM_VERSION})`;
}

/**
 * Import the consumer's pinned encoder packages from ITS root, not this package's node_modules. Bare
 * specifiers resolve relative to the importing file, and `require.resolve` cannot see ESM-only packages
 * (ktx2-encoder has no `require` export), so a one-line shim module is written into the consumer's build
 * folder (gitignored, excluded from the source hash) and imported from there.
 */
async function loadEncoders(cfg) {
  const shim = join(cfg.buildDir, '_encoders.mjs');
  mkdirSync(cfg.buildDir, { recursive: true });
  writeFileSync(shim, [
    '// Written by the engine\'s blender/compress.mjs on every run: resolves the encoder packages from this repo.',
    "export * as core from '@gltf-transform/core';",
    "export * as ext from '@gltf-transform/extensions';",
    "export * as fns from '@gltf-transform/functions';",
    "export * as ktx from 'ktx2-encoder';",
    "export * as meshoptimizer from 'meshoptimizer';",
    "export { default as sharp } from 'sharp';",
    '',
  ].join('\n'));
  const { core, ext, fns, ktx, meshoptimizer, sharp } = await import(pathToFileURL(shim).href);
  return {
    Document: core.Document, Logger: core.Logger, NodeIO: core.NodeIO,
    ALL_EXTENSIONS: ext.ALL_EXTENSIONS, KHRTextureBasisu: ext.KHRTextureBasisu,
    dedup: fns.dedup, meshopt: fns.meshopt, prune: fns.prune,
    encodeToKTX2: ktx.encodeToKTX2,
    MeshoptDecoder: meshoptimizer.MeshoptDecoder, MeshoptEncoder: meshoptimizer.MeshoptEncoder,
    sharp,
  };
}

/** The material slots (e.g. `normalTexture`) a texture is bound to. */
function textureSlots(Document, texture) {
  const root = Document.fromGraph(texture.getGraph()).getRoot();
  return [...new Set(texture.getGraph().listParentEdges(texture).filter((e) => e.getParent() !== root).map((e) => e.getName()))].sort();
}

/** Pick the KTX2 profile from a texture's slots. A texture in two incompatible roles is an error. */
export function profileFor(slots) {
  const normal = slots.includes('normalTexture');
  const srgb = slots.some((s) => SRGB_SLOTS.has(s));
  if (normal && slots.length > 1) throw new Error(`a normal map may not share an image with ${slots.join(', ')}`);
  if (srgb && slots.some((s) => !SRGB_SLOTS.has(s))) throw new Error(`sRGB and linear slots share one image: ${slots.join(', ')}`);
  return normal ? 'normal' : srgb ? 'color' : 'data';
}

/** Run `fn` with console.log muted: the Basis wasm prints per-slice progress even with debug off. */
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

/** Re-encode every texture to KTX2, in a fixed order, one at a time. Returns the manifest `maps`. */
async function encodeTextures(doc, enc) {
  const decodeRgba = async (buffer) => {
    const { data, info } = await enc.sharp(Buffer.from(buffer)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  };
  const maps = [];
  const textures = [...doc.getRoot().listTextures()].sort((a, b) => a.getName().localeCompare(b.getName()));
  for (const texture of textures) {
    const slots = textureSlots(enc.Document, texture);
    const profileName = profileFor(slots);
    const { codec, ...options } = KTX2_PROFILES[profileName];
    const src = texture.getImage();
    const { width, height } = await decodeRgba(src);
    const ktx2 = await quietly(() => enc.encodeToKTX2(src, { ...options, enableDebug: false, imageDecoder: decodeRgba }));
    texture.setImage(ktx2).setMimeType('image/ktx2').setURI('');
    maps.push({ name: texture.getName(), slots, codec, width, height, bytes: ktx2.byteLength });
  }
  if (textures.length) doc.createExtension(enc.KHRTextureBasisu).setRequired(true);
  return maps;
}

/**
 * Insert or replace one entry in <root>/<kinds[kind]>/manifest.json (sorted by id, no timestamps).
 * @example writeManifestEntry('smoke', { id: 'smoke_cube', ... }, cfg) // '/repo/assets/smoke/manifest.json'
 */
export function writeManifestEntry(kind, entry, cfg) {
  const generator = generatorString(cfg);
  const path = join(cfg.root, cfg.kinds[kind], 'manifest.json');
  const manifest = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema: 1, kind, generator, assets: [] };
  manifest.generator = generator;
  manifest.assets = [...manifest.assets.filter((a) => a.id !== entry.id), entry].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

async function main() {
  const { values } = parseArgs({
    options: { config: { type: 'string' }, kind: { type: 'string' }, id: { type: 'string' }, raw: { type: 'string' }, rig: { type: 'string' } },
  });
  const { config, kind, id, raw, rig } = values;
  const cfg = config ? await loadConfig(config) : null;
  if (!cfg || !cfg.kinds[kind] || !/^[A-Za-z0-9_]+$/.test(id ?? '') || !raw) {
    console.error('usage: node blender/compress.mjs --config <blender.config.mjs> --kind <kind> --id <id> --raw <file.glb> [--rig <rig.json>]');
    process.exit(2);
  }
  const enc = await loadEncoders(cfg);
  await enc.MeshoptEncoder.ready;
  await enc.MeshoptDecoder.ready;
  const io = new enc.NodeIO()
    .registerExtensions(enc.ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': enc.MeshoptEncoder, 'meshopt.decoder': enc.MeshoptDecoder });
  const doc = await io.read(raw);
  doc.setLogger(new enc.Logger(enc.Logger.Verbosity.WARN));
  await doc.transform(enc.dedup(), enc.prune());
  const maps = await encodeTextures(doc, enc);
  await doc.transform(enc.meshopt({ encoder: enc.MeshoptEncoder, level: 'medium' }), enc.prune());
  doc.getRoot().getAsset().generator = generatorString(cfg);
  const glb = await io.writeBinary(doc);

  const json = glbJson(glb);
  const violations = contractViolations(json);
  if (violations.length) throw new Error(`compress: ${id} breaks the ADR-0003 output contract: ${violations.join('; ')}`);

  const outRel = `${cfg.kinds[kind]}/${id}.glb`;
  mkdirSync(dirname(join(cfg.root, outRel)), { recursive: true });
  writeFileSync(join(cfg.root, outRel), glb);
  const entry = {
    id,
    kind,
    file: `${id}.glb`,
    sourceHash: sourceHash(kind, id, cfg),
    proportionsHash: proportionsHash(kind, cfg),
    outputHash: sha256(glb),
    bytes: glb.byteLength,
    lods: lodStats(json),
    maps,
    tools: { bpy: cfg.bpyVersion, ...encoderVersions(cfg) },
  };
  if (rig) {
    // Skinned assets: the armature contract read back from Blender (lib/armature.py), copied next to
    // the .glb and pinned by hash so the joint-name test reads exactly what this build exported.
    const rigBytes = readFileSync(rig);
    const rigRel = `${cfg.kinds[kind]}/${id}.rig.json`;
    writeFileSync(join(cfg.root, rigRel), rigBytes);
    entry.rig = { file: `${id}.rig.json`, sha256: sha256(rigBytes) };
  }
  const manifestPath = writeManifestEntry(kind, entry, cfg);
  console.log(`compress: ${outRel} ${glb.byteLength} B, lods ${JSON.stringify(entry.lods)}, maps ${maps.map((m) => `${m.name}:${m.codec}`).join(' ')}`);
  console.log(`compress: manifest ${manifestPath.slice(cfg.root.length)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.stack ?? err);
    process.exit(1);
  });
}
