"""Smoke asset: a hard-surface chest plate through the full bake chain (ADR-0003 §Pipeline).

It exercises `lib.hardsurface` and the whole `lib.bake.bake_chain` (normal, AO, curvature, material
ID, seam mask), then composites it to baseColor + ORM with `lib.pbr`. The parts:
- a chamfered, wrapped chest plate, modelled as its left half and mirrored;
- a glowing panel line and a brass trim strip;
- seeded fasteners and hammered dents;
- a quilted under-suit panel behind the plate.
It proves the toolchain, never ships in a game. Two LODs. Its material table and PBR presets are its
own (`MATERIALS`, `PRESETS`): the library carries none (ADR-0004 A9.3).
"""
import math

import bpy

from lib import bake, material, pbr
from lib import hardsurface as hs
from lib import scene as sc

ASSET = {
    'id': 'smoke_plate',
    'seed': 1107,
    'map_size': 256,
    'lods': [1.0, 0.5],
}

#: Material ids of this asset (lib.hardsurface ints) and the look of each (lib.pbr presets).
MATERIALS = {'steel': 0, 'brass': 1, 'cloth': 4, 'glow': 5, 'trim': 7}
PRESETS = {
    MATERIALS['steel']: pbr.preset(base=(0.20, 0.20, 0.21), rough=0.55, metal=1.0, wear=(0.55, 0.55, 0.56), wear_rough=0.30, cavity=0.55),
    MATERIALS['brass']: pbr.preset(base=(0.55, 0.34, 0.16), rough=0.40, metal=1.0, wear=(0.85, 0.62, 0.38), wear_rough=0.25, cavity=0.50),
    MATERIALS['cloth']: pbr.preset(base=(0.04, 0.045, 0.05), rough=0.80, metal=0.0, wear=(0.06, 0.065, 0.07), wear_rough=0.85, cavity=0.30),
    MATERIALS['glow']: pbr.preset(base=(0.90, 0.35, 0.08), rough=0.50, metal=0.0, wear=(0.90, 0.35, 0.08), wear_rough=0.50, cavity=0.0),
    MATERIALS['trim']: pbr.preset(base=(0.70, 0.55, 0.20), rough=0.30, metal=1.0, wear=(0.95, 0.85, 0.55), wear_rough=0.20, cavity=0.45),
}

#: Left half of the chest plate outline (u = X from the centre line, v = Z up), metres.
HALF = [(0.0, 0.0), (0.16, 0.0), (0.22, 0.12), (0.22, 0.30), (0.12, 0.36), (0.0, 0.34)]
PLATE = dict(thickness=0.014, wrap_radius=0.28, location=(0.0, 0.0, 0.0))
EXTRUSION, MAX_RAY = 0.012, 0.03


def _plate(name, *, bevel_segments, slices, detail):
    outline = hs.chamfer_outline(HALF, 0.025)
    obj = hs.plate(name, outline, bevel=0.004, bevel_segments=bevel_segments, slices=slices, mat='steel',
                   materials=MATERIALS, **PLATE)
    if detail:
        hs.panel_line(obj, (0.0, 0.0, 0.2), (0.0, 0.0, 1.0), width=0.006, depth=0.0025, seam=True, mat='glow', materials=MATERIALS)
        hs.panel_line(obj, (0.1, 0.0, 0.0), (1.0, 0.0, 0.0), width=0.004, depth=0.0015, seam=False, mat='trim', materials=MATERIALS)
    hs.ensure_masks(obj, default=MATERIALS['steel'])
    return hs.mirror_half(obj, 'X')


def _suit_panel(name, *, detail):
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0.0, 0.05, 0.17))
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    obj.rotation_euler = (math.radians(90.0), 0.0, 0.0)
    obj.scale = (0.5, 0.42, 1.0)
    sc.apply_transform(obj)
    hs.assign_material_id(obj, 'cloth', materials=MATERIALS)
    hs.mark_seam(obj, None, 0.0)
    if detail:
        hs.densify(obj, 6)
        hs.quilt(obj, cell=0.06, depth=0.006)
    return obj


def _high(rng):
    plate = _plate('smoke_plate_high', bevel_segments=4, slices=16, detail=True)
    pts, nrm = hs.snap_to_surface(plate, hs.row((-0.18, 0.06), (0.18, 0.06), 7, inset=0.02))
    studs = hs.fasteners(pts, nrm, radius=0.007, height=0.005, kind='dome', rng=rng, jitter=0.1,
                         name='studs', mat='brass', materials=MATERIALS)
    pts, nrm = hs.snap_to_surface(plate, [(-0.17, 0.28), (0.17, 0.28)])
    bolts = hs.fasteners(pts, nrm, radius=0.009, height=0.006, kind='hex', rng=rng, name='bolts',
                         mat='steel', materials=MATERIALS)
    for o in (studs, bolts):
        hs.ensure_masks(o, default=MATERIALS['steel'])
    hs.densify(plate, 2)
    hs.hammered(plate, rng, strength=0.0012, scale=0.025)
    suit = _suit_panel('smoke_plate_suit_high', detail=True)
    sc.activate(plate, also_select=(studs, bolts, suit))
    bpy.ops.object.join()
    bpy.ops.object.shade_smooth()
    return plate


def _low():
    plate = _plate('smoke_plate_lod0', bevel_segments=1, slices=6, detail=False)
    suit = _suit_panel('smoke_plate_suit', detail=False)
    sc.activate(plate, also_select=(suit,))
    bpy.ops.object.join()
    bpy.ops.object.shade_smooth()
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    return plate


def build(ctx):
    """Plate high/low, full bake chain, procedural PBR. Returns LOD0 (the turntable target)."""
    rng = sc.rng(ASSET['seed'])
    size = ASSET['map_size']
    high = _high(rng)
    low = _low()
    low.data.materials.append(bpy.data.materials.new('__bake__'))
    maps = bake.bake_chain(high, low, size, prefix='smoke_plate', extrusion=EXTRUSION, max_ray=MAX_RAY)
    base, orm = pbr.compose(maps, rng, prefix='smoke_plate', presets=PRESETS)
    low.data.materials.clear()
    low.data.materials.append(material.pbr_material('smoke_plate', base_color=base, orm=orm, normal=maps['normal']))
    for img in (base, orm, maps['normal']):
        bake.save_png(img, ctx.work_dir / f'{img.name}.png')
    for key in ('ao', 'curvature', 'id', 'seam'):  # evidence of each pass, kept in .build/ only
        bake.save_png(maps[key], ctx.work_dir / f'{maps[key].name}.png')
    sc.delete(high)
    for key in ('ao', 'curvature', 'id', 'seam'):
        bpy.data.images.remove(maps[key])
    for attr in ('mat_id', 'id_color', 'seam'):  # bake inputs only; keep them out of the export
        if low.data.attributes.get(attr) is not None:
            low.data.attributes.remove(low.data.attributes[attr])

    for level, ratio in enumerate(ASSET['lods']):
        if level == 0 or level not in ctx.lods:
            continue
        lod = sc.duplicate(low, f'smoke_plate_lod{level}')
        lod.hide_render = True
        dec = lod.modifiers.new('decimate', 'DECIMATE')
        dec.ratio = ratio
        sc.apply_modifiers(lod)
    if 0 not in ctx.lods:
        sc.delete(low)
        return None
    return low
