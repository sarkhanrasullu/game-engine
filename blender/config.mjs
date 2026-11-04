// Pipeline config for the headless Blender asset pipeline (ADR-0004 A9.3): the engine knows no asset
// folders, venv paths, fighter names or proportions. A consumer declares them in a `blender.config.mjs`
// that default-exports a plain object; `run.mjs`, `build.py` (through this file's CLI), `compress.mjs`
// and the stale-export hashing all read that one object.
//
// Consumer config (every key but `root` and `kinds` is optional; paths are relative to `root`):
//
//   // tools/blender/blender.config.mjs
//   import { fileURLToPath } from 'node:url';
//   import { proportionsText } from './export-proportions.mjs';
//   export default {
//     root: fileURLToPath(new URL('../../', import.meta.url)),
//     scriptsDir: 'tools/blender',                      // <kind>/<id>.py asset scripts live here
//     kinds: { heroes: 'assets/heroes', stage: 'assets/stage', smoke: 'assets/smoke' },
//     buildDir: 'tools/blender/.build',                 // intermediates (gitignored by the consumer)
//     evidenceDir: 'production/qa/evidence',            // --turntable frames
//     venv: process.env.MY_BPY_VENV ?? '~/.cache/my-game/bpy-5.2.3-py3.13',
//     python: process.env.MY_PYTHON ?? null,            // CPython 3.13 used to create the venv
//     niceness: 19,                                     // `nice -n` for the Blender process (POSIX)
//     generator: 'my-game tools/blender',               // manifest + glTF asset.generator prefix
//     proportions: () => proportionsText(),             // canonical JSON text the hero scripts read
//     proportionsFor: ['heroes'],                       // kinds that get (and are hashed with) it
//   };
//
// CLI (used by build.py, which cannot import ES modules):
//   node blender/config.mjs <config.mjs> --dump                 # resolved config as JSON (no functions)
//   node blender/config.mjs <config.mjs> --proportions <out>    # write the proportions text to <out>
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The engine's own `blender/` folder (the shared pipeline: lib/, smoke/, build.py, compress.mjs...). */
export const ENGINE_BLENDER_DIR = dirname(fileURLToPath(import.meta.url));

/** Repo-relative name the shared pipeline files are hashed under, wherever they live on disk (ADR-0004 A7.7). */
export const LOGICAL_PREFIX = 'tools/blender';

/** npm packages whose version changes the bytes of an export; the consumer pins them exactly. */
export const ENCODER_PACKAGES = Object.freeze([
  '@gltf-transform/core',
  '@gltf-transform/extensions',
  '@gltf-transform/functions',
  'ktx2-encoder',
  'meshoptimizer',
  'sharp',
]);

/** Exact glTF-Transform version named in the generator string (the consumer pins the same one). */
export const GLTF_TRANSFORM_VERSION = '4.5.1';

/** The `bpy==X.Y.Z` pin from blender/requirements.txt (the only place the Blender version is written). */
export function pinnedBpyVersion(requirements = join(ENGINE_BLENDER_DIR, 'requirements.txt')) {
  const m = readFileSync(requirements, 'utf8').match(/^bpy==([0-9][0-9A-Za-z.]*)/m);
  if (!m) throw new Error(`config: no "bpy==" pin in ${requirements}`);
  return m[1];
}

/** Expand a leading `~` and make `p` absolute against `root`. */
function absPath(p, root) {
  if (p == null) return null;
  const expanded = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(root, expanded);
}

/**
 * Resolve a raw consumer config object: apply defaults, make every path absolute, expand `~`.
 * `engineDir: null` is for fixtures that hash a single tree (no shared engine files).
 * @param {object} raw the consumer's default export (or an inline object in a test)
 * @returns {{root: string, scriptsDir: string, engineDir: string|null, kinds: Record<string, string>,
 *   buildDir: string, evidenceDir: string, venv: string, python: string|null, niceness: number|null,
 *   bpyVersion: string, generator: string, proportions: (() => string)|null, proportionsFor: string[],
 *   encoderPackages: string[], logicalPrefix: string, configPath: string|null}}
 * @example resolveConfig({ root: '/repo', kinds: { smoke: 'assets/smoke' } }).scriptsDir // '/repo/tools/blender'
 */
export function resolveConfig(raw, configPath = null) {
  if (!raw || typeof raw !== 'object') throw new Error('config: the config module must default-export an object');
  const root = raw.root instanceof URL || /^file:/.test(raw.root ?? '') ? fileURLToPath(raw.root) : raw.root;
  if (!root || !isAbsolute(root)) throw new Error('config: `root` must be an absolute path or file URL');
  if (!raw.kinds || typeof raw.kinds !== 'object' || !Object.keys(raw.kinds).length) {
    throw new Error('config: `kinds` must map each asset kind to its export folder, e.g. { smoke: "assets/smoke" }');
  }
  const scriptsRel = raw.scriptsDir ?? 'tools/blender';
  const bpyVersion = raw.bpyVersion ?? pinnedBpyVersion();
  const proportions = raw.proportions ?? null;
  if (proportions !== null && typeof proportions !== 'function') throw new Error('config: `proportions` must be a function returning text');
  return Object.freeze({
    root,
    scriptsDir: absPath(scriptsRel, root),
    engineDir: raw.engineDir === undefined ? ENGINE_BLENDER_DIR : raw.engineDir === null ? null : absPath(raw.engineDir, root),
    kinds: Object.freeze({ ...raw.kinds }),
    buildDir: absPath(raw.buildDir ?? `${scriptsRel}/.build`, root),
    evidenceDir: absPath(raw.evidenceDir ?? 'production/qa/evidence', root),
    venv: absPath(raw.venv ?? `~/.cache/game-engine/bpy-${bpyVersion}-py3.13`, root),
    python: raw.python ?? null,
    niceness: raw.niceness ?? null,
    bpyVersion,
    generator: raw.generator ?? 'game-engine blender',
    proportions,
    proportionsFor: Object.freeze([...(raw.proportionsFor ?? ['heroes'])]),
    encoderPackages: Object.freeze([...(raw.encoderPackages ?? ENCODER_PACKAGES)]),
    logicalPrefix: raw.logicalPrefix ?? LOGICAL_PREFIX,
    configPath,
  });
}

/**
 * Import a consumer config module and resolve it.
 * @param {string} path absolute or cwd-relative path to the config module
 * @example const cfg = await loadConfig('tools/blender/blender.config.mjs'); cfg.kinds.heroes
 */
export async function loadConfig(path) {
  const abs = resolve(path);
  const mod = await import(pathToFileURL(abs).href);
  return resolveConfig(mod.default ?? mod.config, abs);
}

/** The resolved config as plain JSON for build.py (functions become a `hasProportions` flag). */
export function dumpConfig(cfg) {
  const { proportions, ...rest } = cfg;
  return { ...rest, hasProportions: proportions !== null };
}

/** The proportions text for `kind`, or null when the config has none for it. */
export function proportionsTextFor(kind, cfg) {
  return cfg.proportions && cfg.proportionsFor.includes(kind) ? cfg.proportions() : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [configPath, flag, out] = process.argv.slice(2);
  const usage = 'usage: node blender/config.mjs <config.mjs> --dump | --proportions <out.json>';
  if (!configPath || !['--dump', '--proportions'].includes(flag) || (flag === '--proportions' && !out)) {
    console.error(usage);
    process.exit(2);
  }
  const cfg = await loadConfig(configPath);
  if (flag === '--dump') {
    process.stdout.write(`${JSON.stringify(dumpConfig(cfg))}\n`);
  } else {
    if (!cfg.proportions) {
      console.error('config: this config declares no `proportions` provider');
      process.exit(3);
    }
    writeFileSync(out, cfg.proportions());
    console.log(`config: wrote proportions to ${out}`);
  }
}
