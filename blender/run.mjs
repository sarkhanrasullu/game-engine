// Entry point of the headless Blender asset pipeline (ADR-0003 §Pipeline, ADR-0004 A9.3).
//
//   node blender/run.mjs --config <blender.config.mjs> [--setup] -- <build.py args>
//
// Reads the consumer's config (see config.mjs), makes sure the pinned bpy venv exists (setup.sh is
// idempotent, so a wiped ~/.cache rebuilds it), then runs build.py with that venv's Python in isolated
// mode (-I) under `nice -n <config.niceness>`. `--setup` stops after the venv check. The config path may
// also come from $ASSET_PIPELINE_CONFIG; without either, ./blender.config.mjs in the cwd is tried.
//
// A consumer's package.json typically has:
//   "art:setup": "node node_modules/@sarkhanrasullu/game-engine/blender/run.mjs --config tools/blender/blender.config.mjs --setup",
//   "art:build": "node node_modules/@sarkhanrasullu/game-engine/blender/run.mjs --config tools/blender/blender.config.mjs"
// and then: npm run art:build -- --only smoke_cube | --all | --list | --only x --turntable --frames 8
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ENGINE_BLENDER_DIR, loadConfig } from './config.mjs';

function parseArgs(argv) {
  let configPath = process.env.ASSET_PIPELINE_CONFIG ?? null;
  let setupOnly = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') configPath = argv[++i];
    else if (a.startsWith('--config=')) configPath = a.slice('--config='.length);
    else if (a === '--setup') setupOnly = true;
    else if (a === '--') rest.push(...argv.slice(i + 1)), (i = argv.length);
    else rest.push(a);
  }
  return { configPath: configPath ?? 'blender.config.mjs', setupOnly, rest };
}

const { configPath, setupOnly, rest } = parseArgs(process.argv.slice(2));
const cfg = await loadConfig(configPath);
const env = {
  ...process.env,
  ASSET_PIPELINE_VENV: cfg.venv,
  ASSET_PIPELINE_BPY_VERSION: cfg.bpyVersion,
  ASSET_PIPELINE_ROOT: cfg.root,
  ...(cfg.python ? { ASSET_PIPELINE_PYTHON: cfg.python } : {}),
};
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: cfg.root, env, encoding: 'utf8', ...opts });

const setupScript = join(ENGINE_BLENDER_DIR, 'setup.sh');
const setup = run('bash', [setupScript], { stdio: 'inherit' });
if (setup.status !== 0) process.exit(setup.status ?? 1);
if (setupOnly) process.exit(0);

const python = run('bash', [setupScript, '--print']).stdout.trim();
const cmd = [python, '-I', join(ENGINE_BLENDER_DIR, 'build.py'), '--config', cfg.configPath, ...rest];
const nice = cfg.niceness !== null && process.platform !== 'win32' ? ['nice', '-n', String(cfg.niceness)] : [];
const [exe, ...args] = [...nice, ...cmd];
const build = run(exe, args, { stdio: 'inherit' });
process.exit(build.status ?? 1);
