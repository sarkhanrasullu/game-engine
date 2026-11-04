"""Headless Blender asset build (ADR-0003 §Key Interfaces; engine package, ADR-0004 A9.3).

Run with the pinned venv (blender/setup.sh), normally via the consumer's `npm run art:build`, which is
`node blender/run.mjs --config <blender.config.mjs> -- <args>`. Directly:

    <venv>/bin/python -I blender/build.py --config tools/blender/blender.config.mjs --only smoke_cube [--turntable] [--lod all]

The config (blender/config.mjs) names the consumer's repo root, its asset-script folder (`<kind>/<id>.py`),
the export folder per kind, the build and evidence folders and, for the kinds that need it, a
proportions provider. Per asset: (kinds in `proportionsFor`) Node writes the proportions JSON ->
factory-reset scene -> the asset script's build(ctx) models and bakes -> raw .glb in <buildDir>/<id>/ ->
Node (compress.mjs) applies meshopt + KTX2 + prune and writes <root>/<kinds[kind]>/<id>.glb plus its
manifest entry. Skinned assets also get <id>.rig.json (lib.armature's joint contract, read back from
Blender) for the consumer's joint-name test. Deterministic: seeded scripts, fixed bake order and samples,
pinned encoders.

An asset script is a Python module with `ASSET = {'id': ..., 'lods': [...], 'skinned': bool, ...}` and
`build(ctx)`; it imports the shared `lib` package (this folder is on sys.path) and anything in the
consumer's script folder (also on sys.path, for hero data such as a fighter map). `ctx` carries `id`,
`kind`, `work_dir` (Path), `proportions` (dict or None), `lods` (list of LOD indices to build), `root`
(Path, consumer repo) and `config` (the dumped config dict).

`--lod N` builds one LOD as a preview in the build folder only; committed exports always hold every LOD.
"""
import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # `python -I` drops the script dir; the asset scripts import `lib`


def node_exe():
    exe = shutil.which('node')
    if exe is None:
        raise SystemExit('build.py: node not found on PATH')
    return exe


def load_config(path):
    """Resolve the consumer config through config.mjs (Python cannot import ES modules)."""
    out = subprocess.run([node_exe(), str(HERE / 'config.mjs'), str(path), '--dump'], check=True,
                         capture_output=True, text=True)
    cfg = json.loads(out.stdout)
    cfg['configPath'] = str(Path(path).resolve())
    return cfg


def discover(cfg):
    """Map asset id -> (kind, script path) for every <kind>/<id>.py (no `_` prefix) in both trees: this
    folder (the engine's smoke/ assets) and the consumer's scriptsDir, the same two trees source-hash.mjs
    hashes under one logical name."""
    found = {}
    trees = []
    for tree in (HERE, Path(cfg['scriptsDir'])):
        if tree.resolve() not in [t.resolve() for t in trees]:
            trees.append(tree)
    for kind in cfg['kinds']:
        for tree in trees:
            for path in sorted((tree / kind).glob('*.py')):
                if path.name.startswith('_'):
                    continue
                if path.stem in found:
                    raise SystemExit(f'build.py: duplicate asset id {path.stem!r}: {found[path.stem][1]} and {path}')
                found[path.stem] = (kind, path)
    return found


def node(cfg, *args):
    """Run a Node helper from this folder in the consumer's root and fail loudly on a non-zero exit."""
    subprocess.run([node_exe(), *map(str, args)], cwd=cfg['root'], check=True)


def load_script(asset_id, path):
    spec = importlib.util.spec_from_file_location(f'asset_{asset_id}', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if getattr(module, 'ASSET', {}).get('id') != asset_id:
        raise SystemExit(f'build.py: {path} must declare ASSET["id"] == {asset_id!r}')
    return module


def clean_dir(path):
    """Empty `path` (our own build folder) and recreate it."""
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)


def build_one(asset_id, kind, script, args, cfg):
    import bpy  # noqa: F401  (import here so --list works without the venv)
    from lib import export, turntable
    from lib import scene as sc

    root = Path(cfg['root'])
    work = Path(cfg['buildDir']) / asset_id
    clean_dir(work)
    proportions = None
    if cfg['hasProportions'] and kind in cfg['proportionsFor']:
        prop_path = work / 'proportions.json'
        node(cfg, HERE / 'config.mjs', cfg['configPath'], '--proportions', prop_path)
        proportions = json.loads(prop_path.read_text())

    sc.reset_scene()
    module = load_script(asset_id, script)
    lod_count = len(module.ASSET.get('lods', [1.0]))
    lods = list(range(lod_count)) if args.lod == 'all' else [int(args.lod)]
    if any(level >= lod_count for level in lods):
        raise SystemExit(f'build.py: {asset_id} has {lod_count} LOD(s); --lod {args.lod} is out of range')
    ctx = SimpleNamespace(id=asset_id, kind=kind, work_dir=work, proportions=proportions, lods=lods,
                          root=root, config=cfg)
    target = module.build(ctx)

    raw = work / f'{asset_id}.raw.glb'
    skinned = bool(module.ASSET.get('skinned'))
    export.export_glb(raw, skins=skinned, animations=bool(module.ASSET.get('animated')))
    rig_args = []
    if skinned:
        from lib import armature
        arm = armature.find_armature()
        if arm is None:
            raise SystemExit(f'build.py: {asset_id} is skinned but built no armature (use lib.armature)')
        rig_json = armature.write_manifest(arm, work / f'{asset_id}.rig.json')
        rig_args = ['--rig', rig_json]
    if args.lod == 'all':
        node(cfg, HERE / 'compress.mjs', '--config', cfg['configPath'], '--kind', kind, '--id', asset_id,
             '--raw', raw, *rig_args)
    else:
        print(f'build.py: preview LOD {args.lod} only, raw export at {raw} (exports untouched)')

    if args.turntable:
        if target is None:
            raise SystemExit('build.py: --turntable needs LOD0 (the asset returned no target)')
        out = Path(cfg['evidenceDir']) / f'{asset_id}-turntable'
        clean_dir(out)
        frames = turntable.render_turntable(target, out, frames=args.frames, size=args.size)
        print(f'build.py: {len(frames)} turntable frames in {out}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config', required=True, metavar='CONFIG.mjs', help="the consumer's blender.config.mjs")
    pick = parser.add_mutually_exclusive_group(required=True)
    pick.add_argument('--only', action='append', metavar='ID', help='asset id to build (repeatable)')
    pick.add_argument('--all', action='store_true', help='build every asset script')
    pick.add_argument('--list', action='store_true', help='list asset ids and exit')
    parser.add_argument('--turntable', action='store_true', help='render Cycles turntable frames to the evidence folder')
    parser.add_argument('--frames', type=int, default=36, help='turntable frame count (default 36)')
    parser.add_argument('--size', type=int, default=512, help='turntable frame size in px (default 512)')
    parser.add_argument('--lod', default='all', help="'all' (default) or one LOD index as a preview")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    sys.path.insert(1, cfg['scriptsDir'])  # consumer-side modules the asset scripts import (hero data)
    assets = discover(cfg)
    if args.list:
        for asset_id, (kind, _) in assets.items():
            print(f'{kind}/{asset_id}')
        return 0
    ids = list(assets) if args.all else args.only
    unknown = [i for i in ids if i not in assets]
    if unknown:
        raise SystemExit(f'build.py: unknown asset id(s) {unknown}; known: {sorted(assets)}')
    if args.lod != 'all' and not args.lod.isdigit():
        raise SystemExit("build.py: --lod takes 'all' or a LOD index")
    for asset_id in ids:
        kind, script = assets[asset_id]
        print(f'build.py: building {kind}/{asset_id}')
        build_one(asset_id, kind, script, args, cfg)
    return 0


if __name__ == '__main__':
    sys.exit(main())
