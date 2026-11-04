"""Scene reset and determinism settings for headless Blender builds (ADR-0003 §Key Interfaces).

Determinism rules: every build starts from factory settings with an empty scene, uses Cycles CPU
with a fixed seed, a fixed sample count and no denoiser, and never reads the clock or the user's
preferences. Asset scripts get their randomness only from `rng(seed)`.
"""
import random

import bpy

#: Cycles CPU threads. Results do not depend on it (Cycles seeds per pixel); fixed so timings repeat.
RENDER_THREADS = 4


def reset_scene():
    """Start from Blender's factory settings with an empty scene (no default cube/camera/light)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = False
    scene.cycles.use_adaptive_sampling = False
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = RENDER_THREADS
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    return scene


def rng(seed):
    """A private, seeded RNG for an asset script. Never use the global `random` state."""
    return random.Random(seed)


def activate(obj, *, also_select=()):
    """Make `obj` the only active+selected object (plus `also_select`), as bpy operators expect."""
    bpy.context.view_layer.update()
    for o in bpy.context.view_layer.objects:
        if o is not None:
            o.select_set(False)
    for o in also_select:
        o.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    return obj


def apply_modifiers(obj):
    """Apply every modifier on `obj` in stack order (bakes and exports then see final geometry)."""
    activate(obj)
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def duplicate(obj, name):
    """Return a full copy of `obj` (object + mesh data) linked into the same collections."""
    copy = obj.copy()
    copy.data = obj.data.copy()
    copy.name = name
    copy.data.name = name
    for coll in obj.users_collection:
        coll.objects.link(copy)
    return copy


def triangle_count(obj):
    """Triangles in `obj`'s evaluated mesh (n-gons fan into n-2 triangles)."""
    mesh = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    try:
        return sum(len(p.vertices) - 2 for p in mesh.polygons)
    finally:
        obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()


def delete(obj):
    """Remove `obj` and its mesh data from the file."""
    data = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if data is not None and data.users == 0:
        bpy.data.meshes.remove(data)


def apply_transform(obj):
    """Bake `obj`'s location/rotation/scale into its mesh (identity object transform)."""
    activate(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj
