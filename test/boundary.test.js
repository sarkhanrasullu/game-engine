// Boundary guard (ADR-0004): the engine names no game and never reaches outside the package.
// Scans every shipped source file (src/) plus the package metadata and docs. Test fixtures are
// scanned for game names too, so a copied consumer test cannot smuggle one in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** Words that belong to a game built on the engine, never to the engine itself. */
export const GAME_LEXICON = /molten|obduran|skadra|rivet|\bpell\b|caldera|nursery|quenchwell|\bwk\./i;

/** Bare specifiers the engine may import (peer dependencies). Everything else must be relative. */
const ALLOWED_BARE = [/^three$/, /^three\/addons\//];

const IMPORT_RE = /^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]([^;\n]*)|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

/**
 * Boundary violations in one file's text. Pure, so it can be shown failing on a planted sample.
 * @example findViolations("import X from '../../assets/x.json' with { type: 'json' };", '/pkg/src/a/b.js', '/pkg/src')
 * @param {string} text file contents
 * @param {string} file absolute path of the file (resolves relative imports)
 * @param {string|null} srcRoot when set, imports are checked and must stay inside this directory
 * @returns {string[]} human-readable violations; empty when the file is clean
 */
export function findViolations(text, file, srcRoot) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(GAME_LEXICON);
    if (m) out.push(`${file}:${i + 1} names the game ("${m[0]}")`);
  });
  if (srcRoot === null) return out;
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[3] ?? m[4];
    const attrs = m[2] ?? '';
    if (/type\s*:\s*['"]json['"]/.test(attrs) || spec.endsWith('.json')) {
      out.push(`${file} imports JSON data (${spec}); data must be injected`);
    }
    if (/actiongame/i.test(spec)) out.push(`${file} imports from a game repo (${spec})`);
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      if (target !== srcRoot && !target.startsWith(srcRoot + sep)) {
        out.push(`${file} imports outside the package source (${spec})`);
      }
    } else if (!ALLOWED_BARE.some((re) => re.test(spec))) {
      out.push(`${file} imports a non-peer package (${spec})`);
    }
  }
  return out;
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

test('boundary_guard_catchesPlantedViolations', () => {
  // The guard must be seen failing: each planted line below is a violation it has to report.
  const file = join(SRC, 'sim', 'planted.js');
  const planted = [
    "import KIT from '../../../assets/data/fighters/kit.json' with { type: 'json' };",
    "import { thing } from '../../../src/fighters/fighter-data.js';",
    "import { x } from 'some-game-lib';",
    "export const NAME = 'Rivet';",
    "const key = 'wk.save';",
  ].join('\n');
  const v = findViolations(planted, file, SRC);
  assert.ok(v.some((s) => s.includes('imports JSON data')), v.join('\n'));
  assert.ok(v.some((s) => s.includes('imports outside the package source')), v.join('\n'));
  assert.ok(v.some((s) => s.includes('non-peer package')), v.join('\n'));
  assert.ok(v.some((s) => s.includes('"Rivet"')), v.join('\n'));
  assert.ok(v.some((s) => s.includes('"wk."')), v.join('\n'));
  assert.deepEqual(findViolations("import { a } from '../core/index.js';\nimport * as T from 'three';", file, SRC), []);
});

test('boundary_engineSource_namesNoGameAndStaysInPackage', () => {
  const files = walk(SRC).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'no engine source found');
  const v = files.flatMap((f) => findViolations(readFileSync(f, 'utf8'), f, SRC));
  assert.deepEqual(v, []);
});

test('boundary_metadataDocsAndTests_nameNoGame', () => {
  const self = fileURLToPath(import.meta.url);
  const files = [
    ...['package.json', 'README.md', 'CHANGELOG.md'].map((f) => join(ROOT, f)),
    ...walk(join(ROOT, 'test')).filter((f) => f !== self),
  ];
  const v = files.flatMap((f) => findViolations(readFileSync(f, 'utf8'), f, null));
  assert.deepEqual(v, []);
});
