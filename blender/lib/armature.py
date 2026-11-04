"""The hero armature: exactly the `createRig` joints of the engine's render/rig.js (ADR-0001 / ADR-0003).

The runtime matches glTF joints to the `createRig` bones BY NAME and keeps `applyPose` unchanged, so
this module is a contract, not a style choice:

- 18 joints, names and parents exactly as `createRig` (`JOINTS`, `PARENT`), all `[A-Za-z0-9_]`.
- Rest offsets are `createRig`'s local positions built from the fighter's proportions JSON. The one
  exception is `hips`: `applyPose` rewrites its position every frame, so the bind puts it at the
  standing hip height (`standHipY`) and the hero is modelled standing on the ground.
- Bone orientation: every bone's local frame equals the three.js frame of its `createRig` joint
  (the glTF exporter's +Y-up basis change included). At rest every joint is rotation-free, except
  the A-pose bind rotations in `bind_pose` (default: arms 40 deg out). A glTF joint's node rotation
  is therefore identity, or its A-pose rotation. The runtime must keep the glTF `inverseBindMatrices`.
  `createRig`'s rest has the arms straight down, and the inverse bind matrices map the A-posed mesh
  onto it.

Blender bones need a length, so each bone points along its joint's local +Y (three.js) with
`BONE_LENGTH`. That direction is useless for bone-heat weighting. `skin_auto` swaps in limb-shaped
"heat" segments for the weighting only, then restores the contract frames. Vertex groups do not
depend on bone orientation.

Example (inside a hero script's `build(ctx)`; the hero -> fighter-id map is the consumer's data):

    from lib import armature as rig
    from hero_data import HERO_FIGHTER                         # e.g. {'hero-a': 'fighter-a'}
    fighter = HERO_FIGHTER[ASSET['id']]
    entry = rig.fighter_entry(ctx, fighter)                    # that fighter's proportions JSON
    arm = rig.build_armature(entry, name='hero_a_rig', fighter=fighter)
    rig.skin_auto(suit_obj, arm)                               # bone heat + scripted fixes
    rig.bind_rigid(chest_plate, arm, 'torso')                  # armour plate: weight 1 on one bone
    rig.bind_blend(pauldron, arm, 'torso', 'armL', width=0.08) # 2-bone blend across a joint
    armour = rig.join([chest_plate, pauldron], 'armour_lod0')  # groups merge by name
    rig.joint_head(arm, 'handL')                               # bind-pose position, Blender space

Not thread-safe (bpy is single-threaded). Pure helpers (`rest_offsets`, `bind_world_three`) need
only `mathutils`.
"""
import json
import math

import bpy
from mathutils import Matrix, Vector

from . import scene as sc

#: createRig joint names, in createRig's key order (= THREE.Skeleton bone order in skin.js).
JOINTS = (
    'root', 'hips', 'torso', 'head',
    'armL', 'elbowL', 'handL', 'armR', 'elbowR', 'handR',
    'legL', 'kneeL', 'ankleL', 'legR', 'kneeR', 'ankleR',
    'keyMount', 'key',
)

#: Parent of each joint (createRig hierarchy). `root` has none.
PARENT = {
    'root': None, 'hips': 'root', 'torso': 'hips', 'head': 'torso',
    'armL': 'torso', 'elbowL': 'armL', 'handL': 'elbowL',
    'armR': 'torso', 'elbowR': 'armR', 'handR': 'elbowR',
    'legL': 'hips', 'kneeL': 'legL', 'ankleL': 'kneeL',
    'legR': 'hips', 'kneeR': 'legR', 'ankleR': 'kneeR',
    'keyMount': 'torso', 'key': 'keyMount',
}

#: Joints that never carry skin weights from bone heat (bind parts to them explicitly).
NON_DEFORM = ('root', 'keyMount', 'key')

#: Default A-pose arm angle (rad) away from straight down, in the applyPose roll sense.
A_POSE_ARM = math.radians(40.0)

#: Bind-pose rotations, three.js Euler XYZ (rad) per joint; missing joints are rotation-free.
#: armL rolls +z and armR -z, so both arms swing outward (the applyPose sign convention).
DEFAULT_BIND_POSE = {'armL': (0.0, 0.0, A_POSE_ARM), 'armR': (0.0, 0.0, -A_POSE_ARM)}

#: Display length of a contract bone (m). It has no effect on skinning or on the export.
BONE_LENGTH = 0.06

#: three.js (+Y up, +Z toward the camera) from Blender (+Z up, -Y front): (x, y, z) -> (x, z, -y).
#: The same matrix the glTF exporter applies (io_scene_gltf2 exp/skins.py, `axis_basis_change`).
THREE_FROM_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
BLENDER_FROM_THREE = THREE_FROM_BLENDER.inverted()

#: Max bone influences per vertex (glTF JOINTS_0 / three.js skinning).
MAX_INFLUENCES = 4


def fighter_entry(ctx, fighter):
    """The proportions JSON entry for fighter id `fighter` (a key of `ctx.proportions['fighters']`).

    Which hero asset maps to which fighter id is the consumer's data (its hero scripts pass it in).
    Returns `{'proportions': {...}, 'standHipY': float, 'legLength': float}` (metres).
    Example: `entry = fighter_entry(ctx, HERO_FIGHTER[ASSET['id']])`
    """
    if ctx.proportions is None:
        raise ValueError('armature: ctx.proportions is empty (only kinds listed in the config\'s proportionsFor get it)')
    fighters = ctx.proportions['fighters']
    if fighter not in fighters:
        raise KeyError(f'armature: unknown fighter {fighter!r}; the proportions JSON has {sorted(fighters)}')
    return fighters[fighter]


def rest_offsets(entry):
    """Local rest offset of every joint from its parent, three.js space (m), exactly as createRig.

    `hips` is the exception: (0, standHipY, 0) instead of createRig's origin (see module doc).
    Example: `rest_offsets(entry)['elbowL'] == (0.0, -upperArm, 0.0)`
    """
    p = entry['proportions']
    off = {name: (0.0, 0.0, 0.0) for name in JOINTS}
    off['hips'] = (0.0, float(entry['standHipY']), 0.0)
    off['head'] = (0.0, p['neckY'], 0.0)
    for s, arm, elbow, hand in ((1, 'armL', 'elbowL', 'handL'), (-1, 'armR', 'elbowR', 'handR')):
        off[arm] = (s * p['shoulderX'], p['shoulderY'], 0.0)
        off[elbow] = (0.0, -p['upperArm'], 0.0)
        off[hand] = (0.0, -p['foreArm'], 0.0)
    for s, leg, knee, ankle in ((1, 'legL', 'kneeL', 'ankleL'), (-1, 'legR', 'kneeR', 'ankleR')):
        off[leg] = (s * p['hipX'], 0.0, 0.0)
        off[knee] = (0.0, -p['thigh'], 0.0)
        off[ankle] = (0.0, -p['shin'], 0.0)
    off['keyMount'] = (0.0, p['keyY'], -p['torso'][2] / 2)
    return {k: tuple(float(c) for c in v) for k, v in off.items()}


def three_euler_matrix(xyz):
    """4x4 rotation for a three.js Euler (order 'XYZ': matrix = Rx @ Ry @ Rz)."""
    x, y, z = xyz
    return Matrix.Rotation(x, 4, 'X') @ Matrix.Rotation(y, 4, 'Y') @ Matrix.Rotation(z, 4, 'Z')


def bind_world_three(entry, bind_pose=None):
    """Bind-pose world matrix of every joint in three.js space (root at the origin).

    Example: `bind_world_three(entry)['handL'].translation`  # three.js metres
    """
    pose = DEFAULT_BIND_POSE if bind_pose is None else bind_pose
    off = rest_offsets(entry)
    world = {}
    for name in JOINTS:  # parents always precede children in JOINTS
        local = Matrix.Translation(Vector(off[name])) @ three_euler_matrix(pose.get(name, (0.0, 0.0, 0.0)))
        parent = PARENT[name]
        world[name] = local if parent is None else world[parent] @ local
    return world


def _heat_tails(entry, heads):
    """Limb-shaped bone tails (Blender space) used only while bone heat runs."""
    p = entry['proportions']
    up, fwd = Vector((0, 0, 1)), Vector((0, -1, 0))  # three +Y, three +Z (front) in Blender space
    tails = {
        'root': heads['root'] + up * 0.1,
        'hips': heads['hips'] - up * max(p['pelvis'][1], 0.05),
        'torso': heads['head'],
        'head': heads['head'] + up * p['head'][1],
        'keyMount': heads['keyMount'] - fwd * 0.05,
        'key': heads['key'] - fwd * 0.1,
    }
    for side in 'LR':
        tails[f'arm{side}'] = heads[f'elbow{side}']
        tails[f'elbow{side}'] = heads[f'hand{side}']
        fore = (heads[f'hand{side}'] - heads[f'elbow{side}']).normalized()
        tails[f'hand{side}'] = heads[f'hand{side}'] + fore * max(p['hand'] * 1.5, 0.05)
        tails[f'leg{side}'] = heads[f'knee{side}']
        tails[f'knee{side}'] = heads[f'ankle{side}']
        tails[f'ankle{side}'] = heads[f'ankle{side}'] + fwd * max(p['foot'][2] * 0.6, 0.05) - up * p['ankle']
    return tails


def _contract(arm):
    return json.loads(arm['rig_contract'])


def _set_axes(arm, mode):
    """Edit-mode bone frames: 'contract' (export) or 'heat' (bone-heat weighting only)."""
    c = _contract(arm)
    world = bind_world_three(c['entry'], {k: tuple(v) for k, v in c['bindPose'].items()})
    mats = {n: BLENDER_FROM_THREE @ world[n] for n in JOINTS}
    sc.activate(arm)
    bpy.ops.object.mode_set(mode='EDIT')
    bones = arm.data.edit_bones
    if mode == 'contract':
        for n in JOINTS:
            eb = bones[n]
            eb.head = mats[n].translation
            eb.tail = eb.head + mats[n].col[1].xyz.normalized() * BONE_LENGTH
            eb.matrix = mats[n]  # sets roll so the bone's X/Z axes match the three.js frame
    else:
        heads = {n: mats[n].translation.copy() for n in JOINTS}
        tails = _heat_tails(c['entry'], heads)
        for n in JOINTS:
            bones[n].head = heads[n]
            bones[n].tail = tails[n]
            bones[n].roll = 0.0
    bpy.ops.object.mode_set(mode='OBJECT')


def build_armature(entry, *, name='rig', fighter=None, bind_pose=None):
    """Create the contract armature for one fighter's proportions entry and return the object.

    `bind_pose` overrides DEFAULT_BIND_POSE (three.js Euler XYZ per joint, rad). `fighter` is recorded
    in the rig.json for the consumer's tests. The armature object sits at the world origin (= createRig
    `root`, at the fighter's feet, facing -Y in Blender = +Z in three.js). Example:
        arm = build_armature(fighter_entry(ctx, 'fighter-a'), name='hero_a_rig', fighter='fighter-a')
    """
    pose = DEFAULT_BIND_POSE if bind_pose is None else bind_pose
    data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(arm)
    arm['rig_contract'] = json.dumps({
        'fighter': fighter,
        'entry': {'proportions': entry['proportions'], 'standHipY': entry['standHipY'],
                  'legLength': entry.get('legLength')},
        'bindPose': {k: list(v) for k, v in sorted(pose.items())},
    }, sort_keys=True)
    sc.activate(arm)
    bpy.ops.object.mode_set(mode='EDIT')
    for n in JOINTS:
        eb = data.edit_bones.new(n)
        eb.head = (0.0, 0.0, 0.0)
        eb.tail = (0.0, 0.0, BONE_LENGTH)
        eb.use_connect = False
        eb.use_deform = n not in NON_DEFORM
    for n in JOINTS:
        if PARENT[n] is not None:
            data.edit_bones[n].parent = data.edit_bones[PARENT[n]]
    bpy.ops.object.mode_set(mode='OBJECT')
    _set_axes(arm, 'contract')
    return arm


def joint_head(arm, name):
    """Bind-pose world position of joint `name` in Blender space (copy). Example: model a glove at
    `joint_head(arm, 'handL')`."""
    return (arm.matrix_world @ arm.data.bones[name].head_local).copy()


def joint_matrix(arm, name):
    """Bind-pose world matrix of joint `name` in Blender space; its axes are the joint's three.js
    axes (col 1 = three +Y). Author a rigid part in joint space with `joint_matrix(...) @ local`."""
    return (arm.matrix_world @ arm.data.bones[name].matrix_local).copy()


def _ensure_modifier(obj, arm):
    mod = next((m for m in obj.modifiers if m.type == 'ARMATURE'), None) or obj.modifiers.new('rig', 'ARMATURE')
    mod.object = arm
    mod.use_vertex_groups = True
    mod.use_bone_envelopes = False
    if obj.parent is not arm:
        world = obj.matrix_world.copy()
        obj.parent = arm
        obj.matrix_world = world
    return obj


def _group(obj, name):
    return obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)


def bind_rigid(obj, arm, bone):
    """Bind every vertex of `obj` to `bone` with weight 1 (armour plates, the back-mounted `key` part).

    Replaces any weights `obj` had. Example: `bind_rigid(chest_plate, arm, 'torso')`
    """
    if bone not in JOINTS:
        raise KeyError(f'armature: unknown joint {bone!r}')
    obj.vertex_groups.clear()
    _group(obj, bone).add(list(range(len(obj.data.vertices))), 1.0, 'REPLACE')
    return _ensure_modifier(obj, arm)


def _smooth(t):
    return 0.0 if t <= 0 else 1.0 if t >= 1 else t * t * (3 - 2 * t)


def bind_blend(obj, arm, upper, lower, *, width):
    """Two-bone blend across the joint where `lower` starts (skin.js-style).

    Weight on `lower` rises with smoothstep over `width` (m) centred on `lower`'s head, measured
    along the upper->lower direction; the rest goes to `upper`. Example:
    `bind_blend(knee_guard, arm, 'legL', 'kneeL', width=0.06)`
    """
    if PARENT.get(lower) != upper:
        raise ValueError(f'armature: {lower!r} is not a child of {upper!r}')
    a, b = joint_head(arm, upper), joint_head(arm, lower)
    axis = b - a
    if axis.length < 1e-6:  # coincident joints (e.g. torso under hips): use the lower bone's +Y
        axis = joint_matrix(arm, lower).col[1].xyz
    axis.normalize()
    obj.vertex_groups.clear()
    gu, gl = _group(obj, upper), _group(obj, lower)
    mw = obj.matrix_world
    for v in obj.data.vertices:
        t = _smooth(((mw @ v.co) - b).dot(axis) / width + 0.5)
        if t < 1.0:
            gu.add([v.index], 1.0 - t, 'REPLACE')
        if t > 0.0:
            gl.add([v.index], t, 'REPLACE')
    return _ensure_modifier(obj, arm)


def skin_auto(obj, arm, *, exclude=NON_DEFORM, max_influences=MAX_INFLUENCES, min_weight=0.01):
    """Bone-heat weights for a deforming mesh (the under-suit), then `fix_weights`.

    Bones in `exclude` get no heat weights. Bone heat needs a closed, reasonably clean mesh;
    vertices it cannot solve are repaired by `fix_weights` (nearest bone). Example:
    `skin_auto(suit, arm)`
    """
    saved = {b.name: b.use_deform for b in arm.data.bones}
    for b in arm.data.bones:
        b.use_deform = b.name not in exclude
    _set_axes(arm, 'heat')
    try:
        obj.vertex_groups.clear()
        world = obj.matrix_world.copy()
        sc.activate(arm, also_select=(obj,))  # parent_set: selected children, active armature
        bpy.ops.object.parent_set(type='ARMATURE_AUTO', keep_transform=True)
        obj.matrix_world = world
    finally:
        _set_axes(arm, 'contract')
        for b in arm.data.bones:
            b.use_deform = saved[b.name]
    fix_weights(obj, arm, exclude=exclude, max_influences=max_influences, min_weight=min_weight)
    return _ensure_modifier(obj, arm)


def _nearest_joint(arm, point, candidates):
    """The candidate joint whose bind segment (head -> first child's head) is closest to `point`."""
    best, best_d = None, math.inf
    children = {n: [c for c in JOINTS if PARENT[c] == n] for n in JOINTS}
    for n in candidates:
        a = joint_head(arm, n)
        b = joint_head(arm, children[n][0]) if children[n] else a
        ab = b - a
        t = 0.0 if ab.length_squared < 1e-12 else max(0.0, min(1.0, (point - a).dot(ab) / ab.length_squared))
        d = (point - (a + ab * t)).length
        if d < best_d - 1e-9:  # strict: ties keep the earlier joint (JOINTS order) -> deterministic
            best, best_d = n, d
    return best


def fix_weights(obj, arm, *, exclude=NON_DEFORM, max_influences=MAX_INFLUENCES, min_weight=0.01):
    """Scripted weight fixes, deterministic: drop non-joint and excluded groups' weights below
    `min_weight`, keep the strongest `max_influences` (ties by JOINTS order), normalise to 1, and
    give unweighted vertices weight 1 on the nearest allowed joint. Example: `fix_weights(suit, arm)`
    """
    allowed = [n for n in JOINTS if n not in exclude]
    order = {n: i for i, n in enumerate(JOINTS)}
    names = {g.index: g.name for g in obj.vertex_groups}
    mw = obj.matrix_world
    plan = []
    for v in obj.data.vertices:
        ws = [(names[g.group], g.weight) for g in v.groups
              if names[g.group] in allowed and g.weight >= min_weight]
        ws.sort(key=lambda nw: (-nw[1], order[nw[0]]))
        ws = ws[:max_influences]
        total = sum(w for _, w in ws)
        if total <= 0:
            ws, total = [(_nearest_joint(arm, mw @ v.co, allowed), 1.0)], 1.0
        plan.append((v.index, [(n, w / total) for n, w in ws]))
    obj.vertex_groups.clear()
    groups = {n: obj.vertex_groups.new(name=n) for n in allowed}
    for index, ws in plan:
        for n, w in ws:
            groups[n].add([index], w, 'REPLACE')
    for n in allowed:  # drop empty groups so the export lists only used joints' weights
        g = groups[n]
        if not any(g.index == e.group for v in obj.data.vertices for e in v.groups):
            obj.vertex_groups.remove(g)
    return obj


def join(objs, name):
    """Join objects into one mesh named `name` (vertex groups merge by joint name, materials by
    slot). The first object keeps its modifiers. Example: `join([plate_a, plate_b], 'armour_lod0')`
    """
    first = objs[0]
    sc.activate(first, also_select=objs[1:])
    if len(objs) > 1:
        bpy.ops.object.join()
    first.name = name
    first.data.name = name
    return first


def contract_manifest(arm):
    """The armature as exported, read back from Blender, in three.js terms (the JSON the Node
    joint-name test reads). Values are rounded to 1e-6 m / 1e-6 so the file is stable. `generator` is
    the logical pipeline name (ADR-0004 A7.7), not a path on disk."""
    c = _contract(arm)
    r = lambda xs: [round(float(x), 6) + 0.0 for x in xs]  # noqa: E731  (+0.0 folds -0.0)
    world = {b.name: THREE_FROM_BLENDER @ arm.matrix_world @ b.matrix_local for b in arm.data.bones}
    joints = []
    for n in JOINTS:
        b = arm.data.bones[n]
        parent = b.parent.name if b.parent else None
        local = world[n] if parent is None else world[parent].inverted() @ world[n]
        t, q, _ = local.decompose()
        joints.append({
            'name': n,
            'parent': parent,
            'deform': bool(b.use_deform),
            'translation': r(t),
            'rotation': r((q.x, q.y, q.z, q.w)),
            'worldHead': r(world[n].translation),
        })
    extra = sorted(b.name for b in arm.data.bones if b.name not in JOINTS)
    return {
        'schema': 1,
        'generator': 'tools/blender/lib/armature.py',
        'fighter': c['fighter'],
        'proportions': c['entry'],
        'bindPose': c['bindPose'],
        'joints': joints,
        'extraBones': extra,
    }


def write_manifest(arm, path):
    """Write `contract_manifest(arm)` as canonical JSON (sorted keys, 2-space, trailing newline)."""
    path.write_text(json.dumps(contract_manifest(arm), indent=2, sort_keys=True) + '\n')
    return path


def find_armature():
    """The scene's single armature object, or None. More than one is an error (one rig per hero)."""
    arms = sorted((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), key=lambda o: o.name)
    if len(arms) > 1:
        raise ValueError(f'armature: one armature per asset, found {[a.name for a in arms]}')
    return arms[0] if arms else None
