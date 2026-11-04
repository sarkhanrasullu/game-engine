"""Smoke asset: the contract armature with a skinned mannequin (ADR-0001 joint contract, ADR-0003).

Proves `lib.armature` end to end. It builds the 18 `createRig` joints for a frozen fighter-proportions
fixture and a voxel-fused mannequin suit with bone-heat weights. It adds a chest plate bound rigidly
to `torso`, a pauldron blended across the shoulder, and a back-mounted part bound to `key`. The export
carries `<kinds.smoke>/smoke_rig.rig.json`. The consumer's rig-contract test (and the engine's
test/blender/) checks it, and the .glb's joints, against `createRig` without Blender. It never ships in
a game.

The proportions are a frozen fixture: a smoke asset is not hashed against a game's fighter data, so a
balance tweak must not stale it. Hero scripts read the live JSON through `armature.fighter_entry`.
"""
import bpy
from mathutils import Vector

from lib import armature as rig
from lib import scene as sc

ASSET = {
    'id': 'smoke_rig',
    'seed': 1106,
    'lods': [1.0],
    'skinned': True,
}

#: Fighter id recorded in the rig.json (a fixture, not a game fighter).
FIGHTER = 'smoke_fixture'

#: A stocky fighter's proportions as exported by a consumer's proportions provider on 2026-11-04. Frozen on purpose.
FIXTURE = {
    'legLength': 0.7,
    'standHipY': 0.6913638008452997,
    'proportions': {
        'ankle': 0.08, 'armRadius': 0.07, 'foot': [0.18, 0.08, 0.28], 'foreArm': 0.24, 'hand': 0.13,
        'head': [0.32, 0.3, 0.3], 'hipX': 0.15, 'keyY': 0.36, 'legRadius': 0.085, 'neckY': 0.56,
        'pelvis': [0.46, 0.2, 0.32], 'shin': 0.3, 'shoulderX': 0.36, 'shoulderY': 0.48, 'thigh': 0.32,
        'torso': [0.6, 0.46, 0.4], 'torsoY': 0.33, 'upperArm': 0.26,
    },
}

VOXEL = 0.025  # m, mannequin remesh resolution (fuses the limbs into one closed shell)


def _flat_material(name, colour, metallic, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*colour, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


def _limb(a, b, radius):
    """A cylinder from point a to point b (Blender space)."""
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=radius, depth=max(d.length, 1e-3),
                                        location=(a + b) / 2)
    obj = bpy.context.active_object
    obj.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return obj


def _ball(at, radius):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=radius, location=at)
    return bpy.context.active_object


def _mannequin(arm, p):
    """Capsule limbs, a box torso and a ball head, voxel-fused into one closed suit shell."""
    h = {n: rig.joint_head(arm, n) for n in rig.JOINTS}
    parts = []
    for side in 'LR':
        parts.append(_limb(h[f'arm{side}'], h[f'elbow{side}'], p['armRadius']))
        parts.append(_limb(h[f'elbow{side}'], h[f'hand{side}'], p['armRadius'] * 0.9))
        parts.append(_ball(h[f'hand{side}'], p['hand'] * 0.5))
        parts.append(_limb(h[f'leg{side}'], h[f'knee{side}'], p['legRadius']))
        parts.append(_limb(h[f'knee{side}'], h[f'ankle{side}'], p['legRadius'] * 0.9))
        parts.append(_ball(h[f'ankle{side}'], p['ankle']))
        for n in (f'arm{side}', f'elbow{side}', f'leg{side}', f'knee{side}'):
            parts.append(_ball(h[n], p['armRadius'] if n.startswith(('arm', 'elbow')) else p['legRadius']))
    tx, ty, tz = p['torso']
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=h['torso'] + Vector((0, 0, p['torsoY'])))
    torso = bpy.context.active_object
    torso.scale = (tx * 0.8, tz * 0.8, ty + p['torsoY'] * 0.6)
    parts.append(torso)
    px, py, pz = p['pelvis']
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=h['hips'])
    pelvis = bpy.context.active_object
    pelvis.scale = (px, pz, py)
    parts.append(pelvis)
    parts.append(_ball(h['head'] + Vector((0, 0, p['head'][1] * 0.5)), p['head'][0] * 0.5))
    for o in parts:
        sc.apply_transform(o)
    suit = rig.join(parts, 'suit_lod0')
    remesh = suit.modifiers.new('fuse', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = VOXEL
    sc.apply_modifiers(suit)
    bpy.ops.object.shade_smooth()
    return suit


def _armour(arm, p):
    """Three rigid/blended parts joined into one `armour` mesh."""
    h = {n: rig.joint_head(arm, n) for n in rig.JOINTS}
    tx, ty, tz = p['torso']
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=h['torso'] + Vector((0, -tz * 0.45, p['torsoY'] + ty * 0.1)))
    chest = bpy.context.active_object
    chest.scale = (tx * 0.7, 0.05, ty * 0.7)
    bev = chest.modifiers.new('bevel', 'BEVEL')
    bev.width = 0.015
    bev.segments = 2
    sc.apply_modifiers(chest)
    sc.apply_transform(chest)
    rig.bind_rigid(chest, arm, 'torso')

    pauldron = _ball(h['armL'] + Vector((0.02, 0, 0.02)), p['armRadius'] * 1.6)
    sc.apply_transform(pauldron)
    rig.bind_blend(pauldron, arm, 'torso', 'armL', width=0.08)

    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.05, depth=0.02,
                                        location=h['key'] + Vector((0, 0.03, 0)), rotation=(1.5708, 0, 0))
    key = bpy.context.active_object
    sc.apply_transform(key)
    rig.bind_rigid(key, arm, 'key')
    armour = rig.join([chest, pauldron, key], 'armour_lod0')
    # No textures here, so no UVs (hero meshes get Smart UV instead).
    while armour.data.uv_layers:
        armour.data.uv_layers.remove(armour.data.uv_layers[0])
    return armour


def build(ctx):
    """Armature + skinned suit + armour. Returns the suit (the turntable target)."""
    arm = rig.build_armature(FIXTURE, name='smoke_rig', fighter=FIGHTER)
    p = FIXTURE['proportions']
    suit = _mannequin(arm, p)
    rig.skin_auto(suit, arm)
    suit.data.materials.append(_flat_material('suit', (0.08, 0.09, 0.11), 0.0, 0.7))
    armour = _armour(arm, p)
    armour.data.materials.clear()
    armour.data.materials.append(_flat_material('armour', (0.55, 0.36, 0.20), 1.0, 0.4))
    return suit if 0 in ctx.lods else None
