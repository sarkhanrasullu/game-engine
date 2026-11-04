// Vite plugin: serves exported glTF asset folders next to index.html, each with a lite copy per .glb
// (ADR-0004 A9.2, moved from the consuming game). For every configured set { dir, prefix }:
//   <prefix>/manifest.json        dir/manifest.json + a `lite` entry per asset
//   <prefix>/<file>.glb           the full export (high tier)
//   <prefix>/<file>.lite.glb      maps cut to liteMax² (medium/low tiers), made by tools/hero-lite.mjs
// plus <basisPrefix>/basis_transcoder.{js,wasm} copied from `basisDir` (no CDN).
// Dev: answered by a middleware for any URL ending in <prefix>/<file>. Build: emitted into dist/ unless
// `emit` is false (a single-file artifact build inlines its own payload instead; see hero-lite.mjs).
// It also blanks KTX2Loader's default `new URL('../libs/basis/…', import.meta.url)` transcoder URLs,
// which would otherwise make Vite emit a second, hashed copy of the transcoder (and a second .js file
// in dist/assets) that the app never loads: the app always sets an explicit transcoder path.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeLiteGlb } from './hero-lite.mjs';

const MIME = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.js': 'text/javascript', '.wasm': 'application/wasm' };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Add one asset folder (manifest.json + its .glb files) and a lite copy of each .glb to `files`
 * under `prefix/`; the served manifest gains a `lite` entry per asset.
 * @param {Map<string, Uint8Array|Buffer>} files @param {string} dir @param {string} prefix @param {number} liteMax
 * @example addLiteSet(files, 'assets/heroes', 'heroes', 1024); files.get('heroes/knight.lite.glb')
 */
export function addLiteSet(files, dir, prefix, liteMax) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const entry of manifest.assets) {
    const glb = readFileSync(join(dir, entry.file));
    const lite = makeLiteGlb(glb, liteMax);
    const liteFile = entry.file.replace(/\.glb$/, '.lite.glb');
    files.set(`${prefix}/${entry.file}`, glb);
    files.set(`${prefix}/${liteFile}`, lite);
    entry.lite = { file: liteFile, bytes: lite.length, maxMap: liteMax };
  }
  files.set(`${prefix}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)));
}

/**
 * @typedef {object} HeroAssetsOptions
 * @property {{dir: string, prefix: string}[]} sets asset folders to serve and the URL prefix of each
 * @property {string} basisDir folder holding basis_transcoder.js and basis_transcoder.wasm
 * @property {string} [basisPrefix] URL prefix of the transcoder files (default 'basis')
 * @property {number} [liteMax] largest map size of the lite copies (default 1024)
 * @property {boolean} [emit] emit the files into dist/ at build (default true)
 */

/**
 * The served file table: relative URL path -> bytes (lite copies made once and cached).
 * @param {HeroAssetsOptions} opts
 * @returns {Map<string, Uint8Array|Buffer>}
 * @example heroAssetFiles({ sets: [{ dir: 'assets/heroes', prefix: 'heroes' }], basisDir }).get('heroes/knight.lite.glb').length
 */
export function heroAssetFiles({ sets, basisDir, basisPrefix = 'basis', liteMax = 1024 }) {
  if (!Array.isArray(sets) || !basisDir) throw new Error('heroAssetFiles: `sets` and `basisDir` are required');
  const files = new Map();
  for (const { dir, prefix } of sets) addLiteSet(files, dir, prefix, liteMax);
  for (const f of readdirSync(basisDir)) if (/^basis_transcoder\.(js|wasm)$/.test(f)) files.set(`${basisPrefix}/${f}`, readFileSync(join(basisDir, f)));
  return files;
}

/**
 * The Vite plugin.
 * @param {HeroAssetsOptions} opts
 * @returns {import('vite').Plugin}
 * @example
 * plugins: [heroAssetsPlugin({
 *   sets: [{ dir: join(root, 'assets/heroes'), prefix: 'heroes' }],
 *   basisDir: join(root, 'node_modules/three/examples/jsm/libs/basis'),
 *   emit: process.env.SINGLE_BUNDLE !== '1',
 * })]
 */
export function heroAssetsPlugin(opts) {
  const { sets, basisPrefix = 'basis', emit = true } = opts;
  const prefixes = [...sets.map((s) => s.prefix), basisPrefix].map(escapeRe).join('|');
  const urlRe = new RegExp(`(?:^|/)((?:${prefixes})/[^/?#]+)(?:[?#].*)?$`);
  let cache = null;
  const files = () => (cache ??= heroAssetFiles(opts));
  return {
    name: 'engine-lite-assets',
    transform(code, id) {
      if (!/KTX2Loader\.js$/.test(id.split('?')[0])) return null;
      const out = code.replace(/new URL\(\s*'\.\.\/libs\/basis\/basis_transcoder\.(?:wasm|js)',\s*import\.meta\.url\s*\)\.toString\(\)/g, "''");
      return out === code ? null : { code: out, map: null };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = urlRe.exec(req.url ?? '');
        const body = m && files().get(m[1]);
        if (!body) return next();
        res.setHeader('Content-Type', MIME[m[1].slice(m[1].lastIndexOf('.'))] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(body);
      });
    },
    generateBundle() {
      if (!emit) return;
      for (const [fileName, source] of files()) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
