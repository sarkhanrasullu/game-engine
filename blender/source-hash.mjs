// Source hashing for the Blender asset pipeline (ADR-0003: "a node --test stale-export test must fail
// when manifest.sourceHash != the hash of the pipeline sources + proportions"). One implementation, used
// by compress.mjs when it writes a manifest entry and by the consumer's stale-export test, so the two can
// never disagree. Needs no Blender.
//
// Two trees feed one hash (ADR-0004 A7.7): the engine's `blender/` (lib, smoke, build/compress/run, this
// file) and the consumer's `scriptsDir` (its <kind>/<id>.py scripts, config and proportions exporter).
// Every file is hashed under the LOGICAL name `<logicalPrefix>/<path inside its tree>` — by default
// `tools/blender/X` — so moving a file between the two trees byte for byte keeps every recorded hash.
//
//   import { resolveConfig } from '@sarkhanrasullu/game-engine/blender/config.mjs';
//   import { sourceHash } from '@sarkhanrasullu/game-engine/blender/source-hash.mjs';
//   const cfg = resolveConfig((await import('./tools/blender/blender.config.mjs')).default);
//   sourceHash('heroes', 'hero-a', cfg)   // === assets/heroes/manifest.json -> assets[hero-a].sourceHash
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { proportionsTextFor } from './config.mjs';

export { ENCODER_PACKAGES, LOGICAL_PREFIX } from './config.mjs';

const SKIP_DIRS = new Set(['.build', '__pycache__', 'node_modules']);
const TEXT_EXT = /\.(py|mjs|js|json|txt|sh|md)$/;

/** sha256 hex of a string or bytes. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** File bytes for hashing; text files have CRLF folded to LF so a Windows checkout hashes the same. */
function hashableBytes(absPath) {
  const buf = readFileSync(absPath);
  return TEXT_EXT.test(absPath) ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : buf;
}

function walkTree(dir, prefix, out) {
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(d, entry.name));
      } else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
        const abs = join(d, entry.name);
        out.push({ logical: `${prefix}/${relative(dir, abs).split(sep).join('/')}`, abs });
      }
    }
  };
  walk(dir);
}

/**
 * Every pipeline file from both trees, as `{ logical, abs }` sorted by logical name, minus build output
 * and caches. Two files with the same logical name in different places is an error (the hash could
 * not say which one an export used).
 * @param {ReturnType<import('./config.mjs').resolveConfig>} cfg
 */
export function listPipelineFiles(cfg) {
  const files = [];
  const trees = [cfg.engineDir, cfg.scriptsDir].filter(Boolean);
  const seen = new Set();
  for (const dir of trees) {
    const real = realpathSync(dir);
    if (seen.has(real)) continue; // engine and scripts in one folder (a fixture): list it once
    seen.add(real);
    walkTree(dir, cfg.logicalPrefix, files);
  }
  files.sort((a, b) => (a.logical < b.logical ? -1 : a.logical > b.logical ? 1 : 0));
  for (let i = 1; i < files.length; i++) {
    if (files[i].logical === files[i - 1].logical) {
      throw new Error(`source-hash: ${files[i].logical} exists in both trees (${files[i - 1].abs}, ${files[i].abs})`);
    }
  }
  return files;
}

/**
 * The files one asset's export depends on: the shared pipeline (everything outside the per-kind
 * asset folders) plus that asset's own script. Another asset's script never stales this one.
 */
export function assetInputFiles(kind, id, cfg) {
  const kindDirs = Object.keys(cfg.kinds).map((k) => `${cfg.logicalPrefix}/${k}/`);
  const own = `${cfg.logicalPrefix}/${kind}/${id}.py`;
  return listPipelineFiles(cfg).filter((f) => f.logical === own || !kindDirs.some((d) => f.logical.startsWith(d)));
}

/** Exact versions of the encoder packages from the consumer's package.json (dependencies + devDependencies). */
export function encoderVersions(cfg) {
  const pkg = JSON.parse(readFileSync(join(cfg.root, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.fromEntries(cfg.encoderPackages.map((name) => [name, deps[name] ?? null]));
}

/** sha256 of the canonical proportions text for `kind`; null for kinds without proportions. */
export function proportionsHash(kind, cfg) {
  const text = proportionsTextFor(kind, cfg);
  return text === null ? null : sha256(text);
}

/**
 * The source hash recorded in the manifest: input file logical names + content hashes, encoder
 * versions, and (where configured) the proportions hash, in a fixed text form.
 * @example sourceHash('smoke', 'smoke_cube', cfg) // 64 hex chars
 */
export function sourceHash(kind, id, cfg) {
  const lines = assetInputFiles(kind, id, cfg).map((f) => `file ${f.logical} ${sha256(hashableBytes(f.abs))}`);
  lines.push(`encoders ${JSON.stringify(encoderVersions(cfg))}`);
  const prop = proportionsHash(kind, cfg);
  if (prop) lines.push(`proportions ${prop}`);
  return sha256(`${lines.join('\n')}\n`);
}

/** Asset scripts present on disk: [{ kind, id, script, logical }] for <scriptsDir>/<kind>/<id>.py (no `_` prefix). */
export function listAssetScripts(cfg) {
  const out = [];
  const files = listPipelineFiles(cfg);
  for (const kind of Object.keys(cfg.kinds)) {
    for (const f of files) {
      const m = f.logical.match(new RegExp(`^${cfg.logicalPrefix}/${kind}/([A-Za-z0-9_]+)\\.py$`));
      if (m && !m[1].startsWith('_')) out.push({ kind, id: m[1], script: f.abs, logical: f.logical });
    }
  }
  return out;
}
