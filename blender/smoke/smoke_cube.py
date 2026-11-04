"""Smoke asset: a bevelled cube with a baked normal map, through the full pipeline (ADR-0003 §Pipeline).

High poly: finely bevelled, subdivided cube with seeded "hammered" dents (Voronoi displacement).
Low poly: 2-segment bevelled cube, Smart-UV unwrapped. Cycles CPU bakes the high poly's normals
(tangent space) and AO onto the low poly; baseColor and ORM are filled procedurally. Two LODs.
It exists to prove the toolchain end to end, never to ship in a game.
"""
import math

import bpy
import numpy as np

from lib import bake, material
from lib import scene as sc

ASSET = {
    'id': 'smoke_cube',
    'seed': 1105,
    'map_size': 256,
    #: Decimate ratio per LOD; LOD0 is the bevelled low poly itself.
    'lods': [1.0, 0.5],
}

BEVEL_WIDTH = 0.06  # m, on a 1 m cube
DENT_STRENGTH = 0.012  # m, hammered displacement depth
AO_SAMPLES = 16
NORMAL_SAMPLES = 1  # normal bakes need one sample per texel


def _cube(name, *, bevel_segments):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.5))
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    mod = obj.modifiers.new('bevel', 'BEVEL')
    mod.width = BEVEL_WIDTH
    mod.segments = bevel_segments
    mod.limit_method = 'NONE'
    return obj


def _high_poly(rng):
    high = _cube('smoke_cube_high', bevel_segments=6)
    sub = high.modifiers.new('subdivide', 'SUBSURF')
    sub.subdivision_type = 'SIMPLE'
    sub.levels = sub.render_levels = 4
    tex = bpy.data.textures.new('hammered', 'VORONOI')
    tex.noise_scale = 0.09
    tex.distance_metric = 'DISTANCE'
    # The seed moves the dent pattern: the texture is sampled in the space of an offset empty.
    anchor = bpy.data.objects.new('dent_anchor', None)
    anchor.location = (rng.uniform(-5, 5), rng.uniform(-5, 5), rng.uniform(-5, 5))
    bpy.context.scene.collection.objects.link(anchor)
    disp = high.modifiers.new('hammered', 'DISPLACE')
    disp.texture = tex
    disp.texture_coords = 'OBJECT'
    disp.texture_coords_object = anchor
    disp.strength = -DENT_STRENGTH
    disp.mid_level = 1.0
    sc.apply_modifiers(high)
    sc.delete(anchor)
    bpy.ops.object.shade_smooth()
    return high


def _low_poly():
    low = _cube('smoke_cube_lod0', bevel_segments=2)
    sc.apply_modifiers(low)
    bpy.ops.object.shade_smooth()
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    return low


def _fill_base_color(image, size, rng):
    """Bronze with low-frequency seeded mottling (value noise on a 16x16 lattice, bilinear)."""
    lattice = np.array([[rng.random() for _ in range(17)] for _ in range(17)], dtype=np.float64)
    t = np.linspace(0.0, 16.0, size, endpoint=False)
    i0 = t.astype(int)
    f = t - i0
    a = lattice[np.ix_(i0, i0)] * (1 - f)[None, :] + lattice[np.ix_(i0, i0 + 1)] * f[None, :]
    b = lattice[np.ix_(i0 + 1, i0)] * (1 - f)[None, :] + lattice[np.ix_(i0 + 1, i0 + 1)] * f[None, :]
    noise = a * (1 - f)[:, None] + b * f[:, None]
    shade = 0.85 + 0.15 * noise
    rgba = np.empty((size, size, 4), dtype=np.float64)
    for c, v in enumerate((0.55, 0.36, 0.20)):
        rgba[..., c] = v * shade
    rgba[..., 3] = 1.0
    bake.set_pixels(image, rgba.ravel().tolist())


def _fill_orm(orm, ao, size):
    """R = baked AO, G = roughness 0.45, B = metallic 1.0."""
    px = np.array(bake.pixels(ao), dtype=np.float64).reshape(size, size, 4)
    out = np.empty_like(px)
    out[..., 0] = px[..., 0]
    out[..., 1] = 0.45
    out[..., 2] = 1.0
    out[..., 3] = 1.0
    bake.set_pixels(orm, out.ravel().tolist())


def build(ctx):
    """Build the smoke cube in the (empty) scene. Returns the object the turntable orbits."""
    rng = sc.rng(ASSET['seed'])
    size = ASSET['map_size']
    high = _high_poly(rng)
    low = _low_poly()

    base = bake.new_image('smoke_cube_basecolor', size, non_color=False)
    orm = bake.new_image('smoke_cube_orm', size, non_color=True)
    normal = bake.new_image('smoke_cube_normal', size, non_color=True, fill=(0.5, 0.5, 1.0, 1.0))
    ao = bake.new_image('smoke_cube_ao', size, non_color=True, fill=(1.0, 1.0, 1.0, 1.0))
    mat = material.pbr_material('smoke_cube', base_color=base, orm=orm, normal=normal)
    low.data.materials.append(mat)

    # Fixed bake order: normal, then AO.
    bake.bake('NORMAL', high, low, normal, samples=NORMAL_SAMPLES, extrusion=0.03, max_ray=0.06)
    bake.bake('AO', high, low, ao, samples=AO_SAMPLES, extrusion=0.03, max_ray=0.06)
    _fill_base_color(base, size, rng)
    _fill_orm(orm, ao, size)
    for img in (base, orm, normal):
        bake.save_png(img, ctx.work_dir / f'{img.name}.png')
    sc.delete(high)
    bpy.data.images.remove(ao)

    for level, ratio in enumerate(ASSET['lods']):
        if level == 0 or level not in ctx.lods:
            continue
        lod = sc.duplicate(low, f'smoke_cube_lod{level}')
        lod.hide_render = True  # same place as LOD0; the runtime shows one LOD, the turntable LOD0
        dec = lod.modifiers.new('decimate', 'DECIMATE')
        dec.ratio = ratio
        sc.apply_modifiers(lod)
    if 0 not in ctx.lods:
        sc.delete(low)
        return None
    return low
