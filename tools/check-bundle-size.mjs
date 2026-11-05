// JS bundle budget check for a Vite build (ADR-0004 A9.2, moved from the consuming game). After
// `vite build`, the boot JS may grow at most `mainGrowthMax` bytes over `mainBaseline`, and one lazy
// chunk may be at most `lazyLoaderMax` bytes. Which files are the bundles is decided by the regexes in
// the limits object; the engine ships no numbers, the game does. Fails loudly when dist/ is missing or
// a chunk is not found, so a skipped build can never pass silently.
//
// "Boot JS" is the SUM of every dist/assets/*.js chunk that no `lazy` regex matches, not the entry
// alone: a bundler hoists modules the entry shares with a lazy chunk (or splits them for a top-level
// await) into statically imported side chunks, and a check that measures `index-*.js` alone misses
// them. `main` must still match exactly one file (the entry) so a missing build fails loudly.
//
// CLI: node tools/check-bundle-size.mjs <distDir> <limits.mjs>
//   <limits.mjs> is an ES module exporting `BUNDLE_LIMITS` (or a default export) of the shape below.
//   Example limits module:
//     export const BUNDLE_LIMITS = Object.freeze({
//       mainBaseline: 800000, mainGrowthMax: 120 * 1000, lazyLoaderMax: 140 * 1000,
//       main: /^index-[\w-]+\.js$/, lazyLoader: /^loader-[\w-]+\.js$/,
//       lazy: [/^loader-[\w-]+\.js$/, /^ads-[\w-]+\.js$/],   // optional; `lazyLoader` alone still works
//     });
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {object} BundleLimits
 * @property {number} mainBaseline bytes of the boot JS (eager total) the growth is measured from
 * @property {number} mainGrowthMax largest allowed growth over the baseline, in bytes
 * @property {number} lazyLoaderMax largest allowed size of the capped lazy chunk, in bytes
 * @property {RegExp} main matches exactly one dist/assets/*.js file: the entry chunk
 * @property {RegExp} lazyLoader matches exactly one dist/assets/*.js file: the capped lazy chunk
 * @property {RegExp | RegExp[]} [lazy] every chunk reached only through a dynamic import(); none of
 *   these count toward the eager total. `lazyLoader` is always treated as lazy too, so a limits object
 *   without `lazy` behaves as before (entry + every other static chunk = boot JS).
 */

/**
 * @typedef {object} BundleReport
 * @property {boolean} ok every budget held and every required chunk was found
 * @property {string[]} lines verdict lines first (main, lazy), then one `eager`/`lazy` line per chunk
 * @property {number} main eager total in bytes (sum of every non-lazy chunk), 0 when the entry is missing
 * @property {number} lazy bytes of the capped lazy chunk, 0 when missing
 * @property {{name: string, bytes: number, eager: boolean}[]} chunks every .js chunk, largest first
 */

/** Normalise `lazy` + `lazyLoader` into one RegExp list (lazyLoader first). */
function lazyPatterns(limits) {
  const extra = limits.lazy === undefined ? [] : Array.isArray(limits.lazy) ? limits.lazy : [limits.lazy];
  for (const re of extra) if (!(re instanceof RegExp)) throw new Error('bundle check: `lazy` must be a RegExp or an array of RegExps');
  return [limits.lazyLoader, ...extra];
}

/**
 * Check a dist/assets listing against the budgets. Pure.
 * @param {{name: string, bytes: number}[]} files the .js files of dist/assets
 * @param {BundleLimits} limits
 * @returns {BundleReport}
 * @example
 * const limits = { mainBaseline: 800000, mainGrowthMax: 120000, lazyLoaderMax: 140000, main: /^index-.*\.js$/, lazyLoader: /^loader-.*\.js$/, lazy: [/^ads-.*\.js$/] };
 * const r = checkBundleSizes([{ name: 'index-a.js', bytes: 700000 }, { name: 'Utils-c.js', bytes: 100000 }, { name: 'loader-b.js', bytes: 131448 }, { name: 'ads-d.js', bytes: 20000 }], limits);
 * r.ok   // true
 * r.main // 800000: index + the hoisted Utils chunk; loader and ads are lazy
 */
export function checkBundleSizes(files, limits) {
  if (!limits || !(limits.main instanceof RegExp) || !(limits.lazyLoader instanceof RegExp)) {
    throw new Error('bundle check: limits must carry `main` and `lazyLoader` RegExps');
  }
  const lazyRes = lazyPatterns(limits);
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
  const entry = one(limits.main, 'main bundle');
  const lazy = one(limits.lazyLoader, 'lazy loader chunk');
  const chunks = files
    .map((f) => ({ name: f.name, bytes: f.bytes, eager: !lazyRes.some((re) => re.test(f.name)) }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const eager = chunks.filter((c) => c.eager);
  const total = eager.reduce((n, c) => n + c.bytes, 0);
  if (entry) {
    const growth = total - limits.mainBaseline;
    const pass = growth <= limits.mainGrowthMax;
    ok &&= pass;
    lines.push(`${pass ? 'ok  ' : 'FAIL'} main ${entry.name} +${eager.length - 1} eager chunk(s) = ${total} B, growth ${growth >= 0 ? '+' : ''}${growth} B (max +${limits.mainGrowthMax})`);
  }
  if (lazy) {
    const pass = lazy.bytes <= limits.lazyLoaderMax;
    ok &&= pass;
    lines.push(`${pass ? 'ok  ' : 'FAIL'} lazy ${lazy.name} ${lazy.bytes} B (max ${limits.lazyLoaderMax})`);
  }
  for (const c of chunks) lines.push(`     ${c.eager ? 'eager' : 'lazy '} ${c.name} ${c.bytes} B`);
  return { ok, lines, main: entry ? total : 0, lazy: lazy?.bytes ?? 0, chunks };
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
 * The CLI body: check `distDir` against the limits module at `limitsPath`, print the verdict lines
 * and the per-chunk breakdown, and return the exit code (0 ok, 1 any failure). Prints and returns
 * rather than exiting so a wrapper can call it.
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
