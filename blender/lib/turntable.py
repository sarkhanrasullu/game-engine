"""Cycles CPU turntable renders for owner look gates (ADR-0003: retained in production/qa/evidence/).

Our own lights and a flat grey world only: no HDRI, MatCap or bundled content.
"""
import math

import bpy
from mathutils import Vector


def render_turntable(target, out_dir, *, frames=36, size=512, samples=32, distance=3.2, height=1.0):
    """Render `frames` PNGs orbiting `target` (an object) into `out_dir`/frame_NN.png. Returns paths."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = samples
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX'

    world = bpy.data.worlds.new('turntable_world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.05, 0.06, 1.0)
    scene.world = world

    centre = Vector(target.location)
    key = bpy.data.objects.new('key', bpy.data.lights.new('key', 'AREA'))
    key.data.energy = 400.0
    key.data.size = 2.0
    key.location = centre + Vector((2.5, -2.5, 3.0))
    rim = bpy.data.objects.new('rim', bpy.data.lights.new('rim', 'AREA'))
    rim.data.energy = 250.0
    rim.data.size = 1.5
    rim.location = centre + Vector((-2.5, 2.0, 2.0))
    cam = bpy.data.objects.new('turntable_cam', bpy.data.cameras.new('turntable_cam'))
    for obj in (key, rim, cam):
        scene.collection.objects.link(obj)
    for light in (key, rim):
        light.rotation_euler = (centre - light.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam

    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for i in range(frames):
        angle = 2.0 * math.pi * i / frames
        cam.location = centre + Vector((distance * math.sin(angle), -distance * math.cos(angle), height))
        cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
        path = out_dir / f'frame_{i:02d}.png'
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        paths.append(path)
    return paths
