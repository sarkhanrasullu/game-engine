// "Lite" glTF assets (ADR-0004 A9.2, moved from the consuming game): a copy of an exported .glb whose
// KTX2 maps are cut to <= maxSize (default 1024²) by dropping their top mip levels. Lossless: level 1
// of a full mip chain IS the 1024² map the encoder made, so nothing is decoded or re-encoded;
// geometry, skins and the meshopt streams are copied byte for byte. Used by the Vite asset plugin
// (tools/vite-hero-assets.mjs) and by single-file artifact builds, which inline only lite maps.
//
// KTX2 layout (Khronos KTX 2.0 spec §3): 80-byte header, level index (levelCount x 3 u64), DFD, KVD,
// SGD, then mip data (stored smallest first). For BasisLZ/ETC1S (supercompressionScheme 1) the SGD
// holds one 20-byte image descriptor per level after a 20-byte header; its slice offsets are relative
// to the start of their own level, so dropping a level only removes its descriptor. UASTC + Zstd
// (scheme 2) has no SGD. Uncompressed (scheme 0) files are rejected: an asset pipeline never makes them.
//
// The engine knows no asset names: which folders, ids and prefixes make up the payload is injected
// through an `InlineConfig` (a module the game owns, passed with --config on the CLI).
//
// CLI:
//   node tools/hero-lite.mjs <in.glb> <out.glb> [--max 1024]
//   node tools/hero-lite.mjs --inline-json <out.json> --config <config.mjs> [--ids a,b] [--max 1024]
//     <config.mjs> exports `INLINE_CONFIG` (or a default) of the InlineConfig shape (see buildInlinePayload).
//     --ids replaces the `ids` of every set that declares one (sets without `ids` always take all assets).

import { readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KTX2_ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const SGD_HEADER = 20;
const IMAGE_DESC = 20;

const align = (n, a) => Math.ceil(n / a) * a;

/**
 * Parse the KTX2 header fields this tool needs.
 * @param {Uint8Array} bytes
 * @returns {{width:number,height:number,levelCount:number,layerCount:number,faceCount:number,scheme:number,
 *   dfd:[number,number], kvd:[number,number], sgd:[number,number], levels:{offset:number,length:number,uncompressed:number}[]}}
 * @example ktx2Info(bytes).width // 2048
 */
export function ktx2Info(bytes) {
  for (let i = 0; i < KTX2_ID.length; i++) if (bytes[i] !== KTX2_ID[i]) throw new Error('not a KTX2 file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const u64 = (o) => Number(dv.getBigUint64(o, true));
  const levelCount = Math.max(1, u32(40));
  const levels = [];
  for (let i = 0; i < levelCount; i++) levels.push({ offset: u64(80 + i * 24), length: u64(88 + i * 24), uncompressed: u64(96 + i * 24) });
  return {
    width: u32(20), height: u32(24), levelCount, layerCount: u32(32), faceCount: u32(36), scheme: u32(44),
    dfd: [u32(48), u32(52)], kvd: [u32(56), u32(60)], sgd: [u64(64), u64(72)], levels,
  };
}

/**
 * Drop the top mip levels of a supercompressed 2D KTX2 file until its base level is <= maxSize.
 * Returns the input unchanged when it already fits or has no smaller level to fall back to.
 * @param {Uint8Array} bytes KTX2 file
 * @param {number} maxSize largest allowed base width/height (e.g. 1024)
 * @returns {Uint8Array}
 * @example dropKtx2TopLevels(normal2048, 1024) // same texture, 1024² base, 11 levels
 */
export function dropKtx2TopLevels(bytes, maxSize) {
  const info = ktx2Info(bytes);
  let drop = 0;
  while (Math.max(info.width >> drop, info.height >> drop) > maxSize && drop + 1 < info.levelCount) drop++;
  if (drop === 0) return bytes;
  if (info.scheme === 0) throw new Error('uncompressed KTX2 is not supported (pipeline output is BasisLZ or Zstd)');
  if (info.faceCount !== 1 || info.layerCount > 1) throw new Error('only single-face, single-layer KTX2 is supported');
  const levels = info.levels.slice(drop);
  const nLevels = levels.length;
  const dfd = bytes.subarray(info.dfd[0], info.dfd[0] + info.dfd[1]);
  const kvd = bytes.subarray(info.kvd[0], info.kvd[0] + info.kvd[1]);
  let sgd = bytes.subarray(info.sgd[0], info.sgd[0] + info.sgd[1]);
  if (info.scheme === 1) {
    // BasisLZ: [header 20][imageDescs levelCount x 20][codebooks...]; keep the descriptors of kept levels.
    const out = new Uint8Array(sgd.length - drop * IMAGE_DESC);
    out.set(sgd.subarray(0, SGD_HEADER), 0);
    out.set(sgd.subarray(SGD_HEADER + drop * IMAGE_DESC), SGD_HEADER);
    sgd = out;
  }
  // Layout: header, level index, DFD (4-aligned), KVD, SGD (8-aligned), level data smallest first.
  let at = 80 + nLevels * 24;
  const dfdAt = align(at, 4);
  at = dfdAt + dfd.length;
  const kvdAt = kvd.length ? align(at, 4) : 0;
  if (kvd.length) at = kvdAt + kvd.length;
  const sgdAt = sgd.length ? align(at, 8) : 0;
  if (sgd.length) at = sgdAt + sgd.length;
  const order = levels.map((l, i) => i).sort((a, b) => levels[a].offset - levels[b].offset);
  const newOffset = new Array(nLevels);
  for (const i of order) {
    newOffset[i] = at;
    at += levels[i].length;
  }
  const out = new Uint8Array(at);
  out.set(bytes.subarray(0, 80), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(20, Math.max(1, info.width >> drop), true);
  dv.setUint32(24, Math.max(1, info.height >> drop), true);
  dv.setUint32(40, nLevels, true);
  dv.setUint32(48, dfdAt, true);
  dv.setUint32(52, dfd.length, true);
  dv.setUint32(56, kvdAt, true);
  dv.setUint32(60, kvd.length, true);
  dv.setBigUint64(64, BigInt(sgdAt), true);
  dv.setBigUint64(72, BigInt(sgd.length), true);
  for (let i = 0; i < nLevels; i++) {
    dv.setBigUint64(80 + i * 24, BigInt(newOffset[i]), true);
    dv.setBigUint64(88 + i * 24, BigInt(levels[i].length), true);
    dv.setBigUint64(96 + i * 24, BigInt(levels[i].uncompressed), true);
    out.set(bytes.subarray(levels[i].offset, levels[i].offset + levels[i].length), newOffset[i]);
  }
  out.set(dfd, dfdAt);
  if (kvd.length) out.set(kvd, kvdAt);
  if (sgd.length) out.set(sgd, sgdAt);
  return out;
}

/**
 * Split a GLB into its JSON and BIN chunk.
 * @param {Uint8Array} bytes @returns {{json: any, bin: Uint8Array}}
 * @example const { json } = readGlb(readFileSync('assets/heroes/knight.glb'));
 */
export function readGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB');
  let at = 12;
  let json = null;
  let bin = new Uint8Array(0);
  while (at < bytes.byteLength) {
    const len = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === CHUNK_BIN) bin = body;
    at += 8 + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

/**
 * Assemble a GLB from a glTF JSON object and its BIN chunk (both padded to 4 bytes).
 * @param {any} json @param {Uint8Array} bin @returns {Uint8Array}
 * @example writeFileSync('out.glb', writeGlb(json, bin))
 */
export function writeGlb(json, bin) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = align(text.length, 4);
  const binLen = align(bin.length, 4);
  const total = 12 + 8 + jsonLen + (bin.length ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  if (bin.length) {
    const b = 20 + jsonLen;
    dv.setUint32(b, binLen, true);
    dv.setUint32(b + 4, CHUNK_BIN, true);
    out.set(bin, b + 8);
  }
  return out;
}

/**
 * Rewrite a GLB's embedded images (bufferView-backed) through `map`, repacking the BIN chunk. Every
 * region of buffer 0 — plain bufferViews and EXT_meshopt_compression sources — keeps its bytes and
 * moves to a new 4-aligned offset; other buffers (the meshopt fallback buffer) are untouched.
 * @param {Uint8Array} glb
 * @param {(bytes: Uint8Array, image: any, index: number) => Uint8Array} map
 * @returns {Uint8Array}
 * @example rewriteGlbImages(glb, (b) => dropKtx2TopLevels(b, 1024))
 */
export function rewriteGlbImages(glb, map) {
  const { json, bin } = readGlb(glb);
  const views = json.bufferViews ?? [];
  const imageOfView = new Map();
  (json.images ?? []).forEach((img, i) => { if (img.bufferView !== undefined) imageOfView.set(img.bufferView, i); });
  /** Regions of buffer 0: { owner, offset, length, bytes } where owner gets the new offset/length. */
  const regions = [];
  views.forEach((v, vi) => {
    if (v.buffer === 0) {
      const src = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
      const img = imageOfView.get(vi);
      const bytes = img === undefined ? src : map(src, json.images[img], img);
      regions.push({ owner: v, offset: v.byteOffset ?? 0, bytes });
    }
    const ext = v.extensions?.EXT_meshopt_compression;
    if (ext && ext.buffer === 0) {
      regions.push({ owner: ext, offset: ext.byteOffset ?? 0, bytes: bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength) });
    }
  });
  regions.sort((a, b) => a.offset - b.offset);
  let at = 0;
  for (const r of regions) {
    at = align(at, 4);
    r.newOffset = at;
    at += r.bytes.length;
  }
  const out = new Uint8Array(align(at, 4));
  for (const r of regions) {
    out.set(r.bytes, r.newOffset);
    r.owner.byteOffset = r.newOffset;
    r.owner.byteLength = r.bytes.length;
  }
  json.buffers[0].byteLength = out.length;
  return writeGlb(json, out);
}

/**
 * The lite copy of a GLB: every KTX2 map cut to <= maxSize.
 * @param {Uint8Array} glb @param {number} [maxSize] @returns {Uint8Array}
 * @example writeFileSync('knight.lite.glb', makeLiteGlb(readFileSync('knight.glb')))
 */
export function makeLiteGlb(glb, maxSize = 1024) {
  return rewriteGlbImages(glb, (bytes, image) => (image.mimeType === 'image/ktx2' ? dropKtx2TopLevels(bytes, maxSize) : bytes));
}

/**
 * @typedef {object} AssetSet one folder of exported assets served under one URL prefix
 * @property {string} dir folder holding `manifest.json` ({ assets: [{ id, file, ... }] }) and the .glb files
 * @property {string} prefix URL prefix the files are served under, e.g. 'heroes' -> 'heroes/<file>'
 * @property {string[]} [ids] manifest ids to include; omitted = every asset in the manifest
 */

/**
 * @typedef {object} InlineConfig
 * @property {AssetSet[]} sets the asset folders to inline, in order
 * @property {string} basisDir folder holding basis_transcoder.js and basis_transcoder.wasm
 * @property {string} [basisPrefix] URL prefix of the transcoder files (default 'basis')
 * @property {number} [maxSize] largest allowed map size (default 1024)
 */

/**
 * The single-file artifact's inline asset table (URL path -> {type, data}): for each set, its manifest
 * (with a `lite` entry per included asset) and each included asset's lite GLB; plus the basis
 * transcoder (js text + wasm). A runtime serves these through blob: URLs instead of the network.
 * @param {InlineConfig} cfg
 * @returns {Record<string, {type: 'text'|'base64', data: string}>}
 * @example
 * const p = buildInlinePayload({ sets: [{ dir: 'assets/heroes', prefix: 'heroes', ids: ['knight'] }], basisDir: 'node_modules/three/examples/jsm/libs/basis' });
 * p['heroes/knight.lite.glb'].type // 'base64'
 */
export function buildInlinePayload({ sets, basisDir, basisPrefix = 'basis', maxSize = 1024 }) {
  if (!Array.isArray(sets) || !basisDir) throw new Error('buildInlinePayload: `sets` and `basisDir` are required');
  const out = {};
  for (const { dir, prefix, ids } of sets) {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const assets = [];
    for (const entry of manifest.assets) {
      if (ids && !ids.includes(entry.id)) continue;
      const lite = makeLiteGlb(readFileSync(join(dir, entry.file)), maxSize);
      const liteFile = entry.file.replace(/\.glb$/, '.lite.glb');
      out[`${prefix}/${liteFile}`] = { type: 'base64', data: Buffer.from(lite).toString('base64') };
      assets.push({ ...entry, lite: { file: liteFile, bytes: lite.length, maxMap: maxSize } });
    }
    out[`${prefix}/manifest.json`] = { type: 'text', data: JSON.stringify({ ...manifest, assets }) };
  }
  out[`${basisPrefix}/basis_transcoder.js`] = { type: 'text', data: readFileSync(join(basisDir, 'basis_transcoder.js'), 'utf8') };
  out[`${basisPrefix}/basis_transcoder.wasm`] = { type: 'base64', data: readFileSync(join(basisDir, 'basis_transcoder.wasm')).toString('base64') };
  return out;
}

/**
 * Load an InlineConfig module (`export const INLINE_CONFIG = {...}` or a default export).
 * @param {string} path module path, relative to cwd or absolute
 * @returns {Promise<InlineConfig>}
 * @example const cfg = await loadInlineConfig('tools/hero-lite.config.mjs');
 */
export async function loadInlineConfig(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`hero-lite: config module ${abs} not found`);
  const mod = await import(pathToFileURL(abs).href);
  const cfg = mod.INLINE_CONFIG ?? mod.default;
  if (!cfg) throw new Error(`hero-lite: ${abs} exports neither INLINE_CONFIG nor a default`);
  return cfg;
}

const USAGE = 'usage: node hero-lite.mjs <in.glb> <out.glb> [--max 1024] | --inline-json <out.json> --config <config.mjs> [--ids a,b] [--max 1024]';

const isMain = (() => {
  try { return !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const takeOpt = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] : undefined;
  };
  const maxOpt = takeOpt('--max');
  const idsOpt = takeOpt('--ids');
  const configPath = takeOpt('--config');
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  if (args[0] === '--inline-json') {
    if (!args[1] || !configPath) {
      console.error(USAGE);
      process.exit(2);
    }
    const cfg = await loadInlineConfig(configPath);
    const sets = idsOpt ? cfg.sets.map((s) => (s.ids ? { ...s, ids: idsOpt.split(',') } : s)) : cfg.sets;
    const payload = buildInlinePayload({ ...cfg, sets, maxSize: maxOpt !== undefined ? Number(maxOpt) : cfg.maxSize });
    writeFileSync(args[1], JSON.stringify(payload));
    console.log(`${args[1]}: ${Object.keys(payload).join(', ')}`);
  } else if (args.length === 2) {
    const lite = makeLiteGlb(readFileSync(args[0]), maxOpt !== undefined ? Number(maxOpt) : 1024);
    writeFileSync(args[1], lite);
    console.log(`${args[1]}: ${lite.length} bytes`);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}
