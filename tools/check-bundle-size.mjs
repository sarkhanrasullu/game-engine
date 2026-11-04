// JS bundle budget check for a Vite build (ADR-0004 A9.2, moved from the consuming game). After
// `vite build`, the boot bundle may grow at most `mainGrowthMax` bytes over `mainBaseline`, and one
// lazy chunk may be at most `lazyLoaderMax` bytes. Which files are the bundles is decided by the
// regexes in the limits object; the engine ships no numbers, the game does. Fails loudly when dist/ is
// missing or a chunk is not found, so a skipped build can never pass silently.
//
// CLI: node tools/check-bundle-size.mjs <distDir> <limits.mjs>
//   <limits.mjs> is an ES module exporting `BUNDLE_LIMITS` (or a default export) of the shape below.
//   Example limits module:
//     export const BUNDLE_LIMITS = Object.freeze({
//       mainBaseline: 800000, mainGrowthMax: 120 * 1000, lazyLoaderMax: 140 * 1000,
//       main: /^index-[\w-]+\.js$/, lazyLoader: /^loader-[\w-]+\.js$/,
//     });
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {object} BundleLimits
 * @property {number} mainBaseline bytes of the boot bundle the growth is measured from
 * @property {number} mainGrowthMax largest allowed growth over the baseline, in bytes
 * @property {number} lazyLoaderMax largest allowed size of the lazy chunk, in bytes
 * @property {RegExp} main matches exactly one dist/assets/*.js file: the boot bundle
 * @property {RegExp} lazyLoader matches exactly one dist/assets/*.js file: the lazy chunk
 */

/**
 * Check a dist/assets listing against the budgets. Pure.
 * @param {{name: string, bytes: number}[]} files the .js files of dist/assets
 * @param {BundleLimits} limits
 * @returns {{ok: boolean, lines: string[], main: number, lazy: number}}
 * @example
 * const limits = { mainBaseline: 800000, mainGrowthMax: 120000, lazyLoaderMax: 140000, main: /^index-.*\.js$/, lazyLoader: /^loader-.*\.js$/ };
 * checkBundleSizes([{ name: 'index-a.js', bytes: 879297 }, { name: 'loader-b.js', bytes: 131448 }], limits).ok // true
 */
export function checkBundleSizes(files, limits) {
  if (!limits || !(limits.main instanceof RegExp) || !(limits.lazyLoader instanceof RegExp)) {
    throw new Error('bundle check: limits must carry `main` and `lazyLoader` RegExps');
  }
  const lines = [];
  let ok = true;
  const one = (re, label) => {
    const hits = files.filter((f) => re.test(f.name));
    if (hits.length !== 1) {
      ok = false;
      lines.push(`FAIL ${label}: expected exactly one ${re} in dist/assets, found ${hits.length}`);
      return null;
    }
    return hits[0];
  };
  const main = one(limits.main, 'main bundle');
  const lazy = one(limits.lazyLoader, 'lazy loader chunk');
  if (main) {
    const growth = main.bytes - limits.mainBaseline;
    const pass = growth <= limits.mainGrowthMax;
    ok &&= pass;
    lines.push(`${pass ? 'ok  ' : 'FAIL'} main ${main.name} ${main.bytes} B, growth ${growth >= 0 ? '+' : ''}${growth} B (max +${limits.mainGrowthMax})`);
  }
  if (lazy) {
    const pass = lazy.bytes <= limits.lazyLoaderMax;
    ok &&= pass;
    lines.push(`${pass ? 'ok  ' : 'FAIL'} lazy ${lazy.name} ${lazy.bytes} B (max ${limits.lazyLoaderMax})`);
  }
  return { ok, lines, main: main?.bytes ?? 0, lazy: lazy?.bytes ?? 0 };
}

/**
 * List dist/assets/*.js with sizes. Throws when the folder is missing (no silent pass).
 * @param {string} distDir
 * @returns {{name: string, bytes: number}[]}
 * @example listDistJs('dist') // [{ name: 'index-a.js', bytes: 879297 }, ...]
 */
export function listDistJs(distDir) {
  const dir = join(distDir, 'assets');
  if (!existsSync(dir)) throw new Error(`bundle check: ${dir} not found; run vite build first`);
  return readdirSync(dir).filter((n) => n.endsWith('.js')).map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
}

/**
 * Load a limits module (`export const BUNDLE_LIMITS = {...}` or a default export).
 * @param {string} path file path of the .mjs/.js module, relative to cwd or absolute
 * @returns {Promise<BundleLimits>}
 * @example const limits = await loadLimits('tools/bundle-limits.mjs');
 */
export async function loadLimits(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`bundle check: limits module ${abs} not found`);
  const mod = await import(pathToFileURL(abs).href);
  const limits = mod.BUNDLE_LIMITS ?? mod.default;
  if (!limits) throw new Error(`bundle check: ${abs} exports neither BUNDLE_LIMITS nor a default`);
  return limits;
}

/**
 * The CLI body: check `distDir` against the limits module at `limitsPath`, print one line per bundle
 * and return the exit code (0 ok, 1 any failure). Prints and returns rather than exiting so a
 * wrapper can call it.
 * @param {string} distDir
 * @param {string} limitsPath
 * @returns {Promise<number>}
 * @example process.exit(await runBundleCheck('dist', 'tools/bundle-limits.mjs'));
 */
export async function runBundleCheck(distDir, limitsPath) {
  let res;
  try {
    res = checkBundleSizes(listDistJs(distDir), await loadLimits(limitsPath));
  } catch (e) {
    console.error(`bundle check FAILED: ${e.message}`);
    return 1;
  }
  for (const l of res.lines) (res.ok ? console.log : console.error)(`bundle check: ${l}`);
  return res.ok ? 0 : 1;
}

// Main-module guard through realpath: the package is usually reached through a node_modules symlink,
// and Node resolves the main entry's real path while argv[1] keeps the path as typed.
const isMain = (() => {
  try { return !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch { return false; }
})();

if (isMain) {
  const [distDir, limitsPath] = process.argv.slice(2);
  if (!distDir || !limitsPath) {
    console.error('usage: node check-bundle-size.mjs <distDir> <limits.mjs>');
    process.exit(2);
  }
  process.exit(await runBundleCheck(distDir, limitsPath));
}
