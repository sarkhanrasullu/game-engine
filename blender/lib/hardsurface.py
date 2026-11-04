"""Hard-surface modelling helpers for hero armour and suits (ADR-0003 §Pipeline).

Every helper is deterministic. Randomness comes only from an `rng` the caller passes in
(`lib.scene.rng(seed)`). The global `random` state, the clock and bundled content are never used.
Units are metres, in Blender space (+Z up, the hero faces -Y = three.js +Z). Model the hero's left
(+X) half and mirror it.

Material ids are small integers `0 .. len(ID_COLOURS) - 1`. Their NAMES are the caller's data: pass a
`materials` dict (`{'steel': 0, 'cloth': 4, ...}`) wherever a `mat` argument accepts a string, or pass
the int directly. The library ships no material table (ADR-0004 A9.3).

Per-face/per-corner attributes the bake chain reads (lib.bake):
- `mat_id`   INT, FACE: material id. Survives join, mirror, subdivision and
  `remesh(preserve_attributes=True)`.
- `id_color` FLOAT_COLOR, CORNER: ID_COLOURS[mat_id], baked to the material-ID map.
- `seam`     FLOAT, POINT: 1 = emissive seam, baked to the seam mask.
- `wear`     FLOAT, POINT: optional geometric edge-wear mask (`edge_wear`).

Typical plate, one half:

    from lib import hardsurface as hs
    MATERIALS = {'steel': 0, 'brass': 1, 'cloth': 4, 'glow': 5}             # the asset's own table
    plate = hs.plate('chest_L', hs.chamfer_outline([(0, 0), (0.28, 0), (0.3, 0.32), (0, 0.36)], 0.03),
                     thickness=0.012, bevel=0.004, wrap_radius=0.25, location=(0, -0.2, 1.0),
                     mat='steel', materials=MATERIALS)
    hs.panel_line(plate, (0.1, 0, 0), (1, 0, 0), width=0.004, depth=0.002)  # groove + seam
    plate = hs.mirror_half(plate, 'X')                       # whole plate, seamless at x = 0
    pts, nrm = hs.snap_to_surface(plate, hs.row((0.05, 1.3), (0.25, 1.3), 5), toward=(0, 1, 0))
    studs = hs.fasteners(pts, nrm, radius=0.006, height=0.004, rng=rng, mat=MATERIALS['brass'])
    hs.densify(plate, 2); hs.hammered(plate, rng, strength=0.0015, scale=0.03)   # high poly only

Not thread-safe (bpy).
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

from . import scene as sc

#: Flat, well-separated ID colours (linear RGB). Index = material id. lib.pbr decodes by nearest.
ID_COLOURS = (
    (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (1.0, 1.0, 0.0),
    (1.0, 0.0, 1.0), (0.0, 1.0, 1.0), (1.0, 1.0, 1.0), (0.0, 0.0, 0.0),
)

#: Material id every untagged face gets (`ensure_masks`, `assign_material_id` with `faces`).
DEFAULT_MATERIAL = 0


def material_id(mat, materials=None):
    """Resolve `mat` to an int id: an int as-is, or a name looked up in the caller's `materials` dict.

    Example: `material_id('cloth', {'cloth': 4}) == 4`; `material_id(2) == 2`.
    """
    if isinstance(mat, str):
        if materials is None or mat not in materials:
            raise KeyError(f'hardsurface: material name {mat!r} needs a `materials` dict that defines it')
        mat = materials[mat]
    mid = int(mat)
    if not 0 <= mid < len(ID_COLOURS):
        raise ValueError(f'hardsurface: material id {mid} outside 0..{len(ID_COLOURS) - 1}')
    return mid


def _mat_id(mat, materials=None):
    return material_id(mat, materials)


def _new_object(name, mesh):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


# --- outlines ---------------------------------------------------------------------------------

def chamfer_outline(points, size):
    """Cut every corner of a closed 2D outline by `size` (m): one straight chamfer per corner.

    Example: `chamfer_outline([(0, 0), (0.3, 0), (0.3, 0.2), (0, 0.2)], 0.02)` -> 8 points.
    """
    out = []
    n = len(points)
    for i in range(n):
        p = Vector(points[i])
        a, b = Vector(points[i - 1]), Vector(points[(i + 1) % n])
        da, db = (a - p), (b - p)
        ka, kb = min(size, da.length / 2), min(size, db.length / 2)
        out.append(tuple(p + da.normalized() * ka))
        out.append(tuple(p + db.normalized() * kb))
    return out


def round_outline(points, radius, steps=4):
    """Fillet every corner of a closed 2D outline with an arc of `steps` segments (quadratic)."""
    out = []
    n = len(points)
    for i in range(n):
        p = Vector(points[i])
        a, b = Vector(points[i - 1]), Vector(points[(i + 1) % n])
        pa = p + (a - p).normalized() * min(radius, (a - p).length / 2)
        pb = p + (b - p).normalized() * min(radius, (b - p).length / 2)
        for s in range(steps + 1):
            t = s / steps
            q = pa * (1 - t) ** 2 + p * 2 * (1 - t) * t + pb * t * t
            out.append((q.x, q.y))
    return out


def outline_from_curve(curve_obj, resolution=12):
    """Sample the first spline of a 2D curve object into a closed outline (its local X/Y).

    Lets an artist author a profile as Bezier points in code, then `plate()` it.
    """
    mesh = curve_obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    try:
        pts = [(v.co.x, v.co.y) for v in mesh.vertices]
    finally:
        curve_obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    return pts


def bezier_profile(name, points, *, handle=0.33, resolution=12):
    """A closed 2D Bezier curve object through `points` (auto-smooth handles scaled by `handle`)."""
    data = bpy.data.curves.new(name, 'CURVE')
    data.dimensions = '2D'
    data.resolution_u = resolution
    spline = data.splines.new('BEZIER')
    spline.bezier_points.add(len(points) - 1)
    n = len(points)
    for i, (x, y) in enumerate(points):
        bp = spline.bezier_points[i]
        prev, nxt = Vector(points[i - 1]), Vector(points[(i + 1) % n])
        tangent = (nxt - prev) * handle * 0.5
        bp.co = (x, y, 0.0)
        bp.handle_left = (x - tangent.x, y - tangent.y, 0.0)
        bp.handle_right = (x + tangent.x, y + tangent.y, 0.0)
    spline.use_cyclic_u = True
    return _new_object(name, data)


# --- plates -----------------------------------------------------------------------------------

def plate(name, outline, *, thickness, bevel, bevel_segments=2, slices=12, wrap_radius=None,
          wrap_radius_v=None, location=(0.0, 0.0, 0.0), mat=DEFAULT_MATERIAL, materials=None):
    """A bevelled armour plate from a closed 2D outline (u, v): loft -> wrap -> solidify -> bevel.

    The outline lies in Blender X (u) / Z (v), and its outer face looks toward -Y (front). It is cut into
    `slices` strips along u and along v so it can bend: around a vertical cylinder of `wrap_radius`
    (curving back toward +Y at the sides), and over a horizontal one of `wrap_radius_v`. Thickness
    grows inward (+Y). The chamfer is a `bevel`-wide, `bevel_segments` bevel on edges sharper than 30°.
    The result is applied geometry with `mat_id` set to `mat` (int, or a name in `materials`). Example:
        plate('greave', round_outline([(-.06, 0), (.06, 0), (.07, .3), (-.07, .3)], .02), thickness=.01,
              bevel=.003, wrap_radius=.08, location=(0.15, -0.05, 0.1))
    """
    bm = bmesh.new()
    verts = [bm.verts.new((u, 0.0, v)) for u, v in outline]
    bm.faces.new(verts)
    us = [u for u, _ in outline]
    vs = [v for _, v in outline]
    for axis, lo, hi in ((Vector((1, 0, 0)), min(us), max(us)), (Vector((0, 0, 1)), min(vs), max(vs))):
        for k in range(1, slices):
            co = axis * (lo + (hi - lo) * k / slices)
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=axis)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = _new_object(name, mesh)
    _wrap(obj, wrap_radius, wrap_radius_v)
    solid = obj.modifiers.new('solidify', 'SOLIDIFY')
    solid.thickness = thickness
    solid.offset = -1.0 if _faces_front(obj) else 1.0  # grow toward +Y (inward) either way
    solid.use_even_offset = True
    bev = obj.modifiers.new('bevel', 'BEVEL')
    bev.width = bevel
    bev.segments = bevel_segments
    bev.limit_method = 'ANGLE'
    bev.angle_limit = math.radians(30.0)
    bev.harden_normals = False
    sc.apply_modifiers(obj)
    obj.location = location
    sc.apply_transform(obj)
    assign_material_id(obj, mat, materials=materials)
    return obj


def _faces_front(obj):
    """True when the (single-sided) plate faces -Y (a CCW outline), so solidify -1 grows to +Y."""
    obj.data.update()
    return sum(p.normal.y for p in obj.data.polygons) < 0


def _wrap(obj, radius_u, radius_v):
    """Bend the flat (y = 0) plate around a vertical (u) and/or horizontal (v) cylinder, toward +Y."""
    for v in obj.data.vertices:
        x, y, z = v.co
        if radius_u:
            a = x / radius_u
            x, y = radius_u * math.sin(a), y + radius_u * (1 - math.cos(a))
        if radius_v:
            b = z / radius_v
            z, y = radius_v * math.sin(b), y + radius_v * (1 - math.cos(b))
        v.co = (x, y, z)
    obj.data.update()


def shell(name, profiles, *, thickness, bevel, bevel_segments=2, cap=True, mat=DEFAULT_MATERIAL, materials=None):
    """Loft a closed shell through ring profiles (a helmet, a gauntlet cuff, a pauldron dome).

    `profiles`: list of rings, each a list of (x, y, z) points (same count per ring), bottom to top.
    The loft is solidified inward and bevelled. With `cap`, the last ring is closed with a fan.
    `mat` tags every face (int, or a name in `materials`).
    """
    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in ring] for ring in profiles]
    n = len(rings[0])
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((r0[i], r0[(i + 1) % n], r1[(i + 1) % n], r1[i]))
    if cap:
        top = rings[-1]
        centre = sum((v.co for v in top), Vector()) / n
        c = bm.verts.new(centre)
        for i in range(n):
            bm.faces.new((top[i], top[(i + 1) % n], c))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = _new_object(name, mesh)
    solid = obj.modifiers.new('solidify', 'SOLIDIFY')
    solid.thickness = thickness
    solid.offset = -1.0
    solid.use_even_offset = True
    bev = obj.modifiers.new('bevel', 'BEVEL')
    bev.width = bevel
    bev.segments = bevel_segments
    bev.limit_method = 'ANGLE'
    bev.angle_limit = math.radians(30.0)
    sc.apply_modifiers(obj)
    assign_material_id(obj, mat, materials=materials)
    return obj


def mirror_half(obj, axis='X', *, merge=0.0005):
    """Mirror a modelled half across the object's origin plane (bisect + clipping, applied).

    Model the +X (hero's left, three.js +X) half. Geometry past the plane is cut away first, and
    seam vertices within `merge` are welded. Attributes are mirrored with the faces.
    """
    mod = obj.modifiers.new('mirror', 'MIRROR')
    idx = 'XYZ'.index(axis)
    mod.use_axis = [i == idx for i in range(3)]
    mod.use_bisect_axis = [i == idx for i in range(3)]
    mod.use_clip = True
    mod.use_mirror_merge = True
    mod.merge_threshold = merge
    sc.apply_modifiers(obj)
    return obj


def mirror_copy(obj, name, axis='X'):
    """A mirrored duplicate (the right-side twin of a left-side part, e.g. a pauldron)."""
    twin = sc.duplicate(obj, name)
    s = [-1.0 if a == axis else 1.0 for a in 'XYZ']
    twin.data.transform(Matrix.Diagonal((*s, 1.0)))
    twin.data.flip_normals()
    twin.data.update()
    return twin


# --- cuts, fasteners ---------------------------------------------------------------------------

def panel_line(obj, plane_co, plane_no, *, width, depth, seam=True, mat=None, materials=None):
    """Cut a V-groove panel line where a plane crosses the mesh, and optionally mark it as a seam.

    Three bisects (at -width/2, 0, +width/2 along `plane_no`). The middle loop is pushed `depth` into
    the surface along the vertex normals. With `seam`, the groove's vertices get `seam` = 1, which is
    the emissive line. `mat` (int, or a name in `materials`) re-tags the groove faces. Returns the
    number of grooved vertices.
    """
    co, no = Vector(plane_co), Vector(plane_no).normalized()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for off in (-width / 2, width / 2, 0.0):
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co + no * off, plane_no=no)
    bm.normal_update()
    bm.verts.index_update()
    bm.faces.index_update()
    eps = width * 1e-3
    centre = [v for v in bm.verts if abs((v.co - co).dot(no)) <= eps]
    band = [v for v in bm.verts if abs((v.co - co).dot(no)) <= width / 2 + eps]
    for v in centre:
        v.co -= v.normal * depth
    centre_idx = {v.index for v in band}
    groove_faces = [f.index for f in bm.faces if all(v.index in centre_idx for v in f.verts)]
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    if seam:
        mark_seam(obj, sorted(centre_idx))
    if mat is not None and groove_faces:
        assign_material_id(obj, mat, faces=groove_faces, materials=materials)
    return len(centre)


def row(a, b, count, *, inset=0.0):
    """`count` evenly spaced points on segment a->b, shrunk by `inset` at both ends (2D or 3D)."""
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized() * inset
    a, b = a + d, b - d
    return [tuple(a.lerp(b, i / (count - 1) if count > 1 else 0.5)) for i in range(count)]


def snap_to_surface(obj, points, *, toward=(0.0, 1.0, 0.0), start=1.0):
    """Project points onto `obj` by ray casts along `toward` (world). Returns (points, normals).

    Each 2D point (x, z) is placed at y = -start (in front of the hero) before casting; a 3D point is
    cast from itself minus `toward` * start. Points whose ray misses are dropped (deterministically).
    """
    inv = obj.matrix_world.inverted()
    d_world = Vector(toward).normalized()
    d_local = (inv.to_3x3() @ d_world).normalized()
    out_p, out_n = [], []
    for p in points:
        origin = Vector((p[0], -start, p[1])) if len(p) == 2 else Vector(p) - d_world * start
        hit, loc, nrm, _ = obj.ray_cast(inv @ origin, d_local)
        if hit:
            out_p.append(tuple(obj.matrix_world @ loc))
            out_n.append(tuple((obj.matrix_world.to_3x3() @ nrm).normalized()))
    return out_p, out_n


def fasteners(points, normals, *, radius, height, kind='dome', segments=12, rng=None, jitter=0.0,
              name='fasteners', mat=DEFAULT_MATERIAL, materials=None):
    """Fastener heads (domed studs, hex bolts, countersunk discs) at `points`, oriented to `normals`, in one object.

    `kind`: 'dome' (half sphere), 'hex' (hex bolt with a chamfered top), 'flat' (countersunk disc).
    With `rng`, each head turns by a seeded random spin, and `jitter` scales its radius by up to
    +-jitter. `mat` tags the heads (int, or a name in `materials`). Example:
    `fasteners(*snap_to_surface(plate, row((0, 1), (0.2, 1), 5)), radius=0.006, height=0.004, rng=rng, mat=1)`
    """
    bm = bmesh.new()
    for p, n in zip(points, normals):
        r = radius * (1.0 + (rng.uniform(-jitter, jitter) if rng else 0.0))
        spin = rng.uniform(0.0, 2.0 * math.pi) if rng else 0.0
        frame = (Matrix.Translation(Vector(p)) @ Vector(n).to_track_quat('Z', 'Y').to_matrix().to_4x4()
                 @ Matrix.Rotation(spin, 4, 'Z'))
        if kind == 'dome':
            res = bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=max(4, segments // 2), radius=1.0)
            vs = res['verts']
            kill = [v for v in vs if v.co.z < -1e-6]
            bmesh.ops.delete(bm, geom=kill, context='VERTS')
            vs = [v for v in vs if v.is_valid]
            bmesh.ops.scale(bm, vec=(r, r, height), verts=vs)
        else:
            sides = 6 if kind == 'hex' else segments
            res = bmesh.ops.create_cone(bm, cap_ends=True, segments=sides, radius1=r,
                                        radius2=r * (0.8 if kind == 'hex' else 0.95), depth=height)
            vs = res['verts']
            bmesh.ops.translate(bm, vec=(0, 0, height / 2), verts=vs)
        bmesh.ops.transform(bm, matrix=frame, verts=vs)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = _new_object(name, mesh)
    assign_material_id(obj, mat, materials=materials)
    return obj


# --- density + surface detail (high poly) --------------------------------------------------------

def densify(obj, levels=2):
    """Simple (non-smoothing) subdivision, applied. Keeps every attribute (mat_id, seam...)."""
    sub = obj.modifiers.new('densify', 'SUBSURF')
    sub.subdivision_type = 'SIMPLE'
    sub.levels = sub.render_levels = levels
    sc.apply_modifiers(obj)
    return obj


def remesh(obj, voxel, *, preserve_attributes=True):
    """Voxel remesh (fuses overlapping parts into one closed shell). Keeps attributes by default."""
    obj.data.remesh_voxel_size = voxel
    obj.data.use_remesh_preserve_attributes = preserve_attributes
    obj.data.use_remesh_preserve_volume = False
    sc.activate(obj)
    bpy.ops.object.voxel_remesh()
    return obj


def _displace_along_normals(obj, fn):
    obj.data.update()
    mesh = obj.data
    for v in mesh.vertices:
        v.co = v.co + v.normal * fn(v.co)
    mesh.update()
    return obj


def _value_noise(rng, size=32):
    """A seeded 3D value-noise function (trilinear on a `size`^3 lattice, wraps)."""
    lattice = [rng.random() for _ in range(size ** 3)]

    def at(i, j, k):
        return lattice[(i % size) + size * ((j % size) + size * (k % size))]

    def noise(x, y, z):
        i, j, k = math.floor(x), math.floor(y), math.floor(z)
        fx, fy, fz = x - i, y - j, z - k
        sx, sy, sz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)
        c = [[[at(i + a, j + b, k + d) for d in (0, 1)] for b in (0, 1)] for a in (0, 1)]
        x0 = [[c[0][b][d] * (1 - sx) + c[1][b][d] * sx for d in (0, 1)] for b in (0, 1)]
        y0 = [x0[0][d] * (1 - sy) + x0[1][d] * sy for d in (0, 1)]
        return y0[0] * (1 - sz) + y0[1] * sz
    return noise


def hammered(obj, rng, *, strength, scale):
    """Seeded hammered dents: cellular (Worley-like) pits of `scale` m, `strength` m deep."""
    cell_pts = {}

    def feature(ci, cj, ck):
        key = (ci, cj, ck)
        if key not in cell_pts:
            h = (ci * 73856093) ^ (cj * 19349663) ^ (ck * 83492791) ^ seed
            r = random.Random(h)  # private per-cell RNG, derived from the asset seed only
            cell_pts[key] = Vector((ci + r.random(), cj + r.random(), ck + r.random()))
        return cell_pts[key]

    seed = rng.getrandbits(32)

    def depth(co):
        p = co / scale
        ci, cj, ck = math.floor(p.x), math.floor(p.y), math.floor(p.z)
        d = min((feature(ci + a, cj + b, ck + c) - p).length
                for a in (-1, 0, 1) for b in (-1, 0, 1) for c in (-1, 0, 1))
        return -strength * max(0.0, 1.0 - d) ** 2
    return _displace_along_normals(obj, depth)


def brushed(obj, rng, *, strength, scale, direction=(0.0, 0.0, 1.0), stretch=40.0):
    """Seeded brushed-metal streaks: noise stretched `stretch` x along `direction` (world)."""
    noise = _value_noise(rng)
    d = Vector(direction).normalized()
    basis = d.to_track_quat('Z', 'Y').to_matrix().inverted()

    def depth(co):
        q = basis @ co
        return strength * (noise(q.x / scale, q.y / scale, q.z / (scale * stretch)) - 0.5)
    return _displace_along_normals(obj, depth)


def quilt(obj, *, cell, depth, seam_width=0.15, axes=('X', 'Z'), mark=True):
    """Under-suit quilting: a diamond grid of `cell` m puffs; the stitch lines sink `depth` m.

    The grid runs on two world axes (default X/Z = front view). Stitch vertices (within `seam_width`
    of a cell edge, as a fraction of the cell) get `seam` = 1 when `mark` is set: the suit's
    glowing quilt lines. Needs a dense mesh (densify/remesh first).
    """
    ia, ib = ('XYZ'.index(axes[0]), 'XYZ'.index(axes[1]))
    stitched = []

    def edge_dist(co):
        u, v = co[ia] / cell, co[ib] / cell
        a, b = u + v, u - v  # diamond (45 deg) lattice
        return min(abs(a - round(a)), abs(b - round(b)))  # 0 on a stitch line, 0.5 mid-puff

    obj.data.update()
    for vert in obj.data.vertices:
        e = edge_dist(vert.co)
        puff = min(1.0, e / 0.5)
        vert.co = vert.co - vert.normal * depth * (1.0 - math.sin(puff * math.pi / 2))
        if e <= seam_width * 0.5:
            stitched.append(vert.index)
    obj.data.update()
    if mark:
        mark_seam(obj, stitched)
    return obj


# --- attributes ---------------------------------------------------------------------------------

def _attr(mesh, name, kind, domain):
    a = mesh.attributes.get(name)
    if a is None or a.domain != domain or a.data_type != kind:
        if a is not None:
            mesh.attributes.remove(a)
        a = mesh.attributes.new(name, kind, domain)
    return a


def assign_material_id(obj, mat, *, faces=None, materials=None):
    """Tag faces (all by default) with a material id: `mat_id` (FACE) and `id_color` (CORNER).

    `mat` is an int id or a name in `materials`. Example:
    `assign_material_id(plate, 'brass', faces=[0, 1], materials={'brass': 1})`
    """
    mid = _mat_id(mat, materials)
    mesh = obj.data
    fresh = mesh.attributes.get('mat_id') is None
    ids = _attr(mesh, 'mat_id', 'INT', 'FACE')
    cols = _attr(mesh, 'id_color', 'FLOAT_COLOR', 'CORNER')
    targets = range(len(mesh.polygons)) if faces is None else faces
    if fresh and faces is not None:  # untagged faces get the default id
        for i in range(len(mesh.polygons)):
            ids.data[i].value = DEFAULT_MATERIAL
    for f in targets:
        ids.data[f].value = mid
    for poly in mesh.polygons:
        c = ID_COLOURS[ids.data[poly.index].value % len(ID_COLOURS)]
        for li in poly.loop_indices:
            cols.data[li].color = (*c, 1.0)
    return obj


def mark_seam(obj, verts=None, value=1.0):
    """Set the `seam` mask (POINT) on `verts` (all when None). Unmarked vertices keep their value."""
    mesh = obj.data
    if mesh.attributes.get('seam') is None:
        _attr(mesh, 'seam', 'FLOAT', 'POINT')
    seam = mesh.attributes['seam']
    for i in (range(len(mesh.vertices)) if verts is None else verts):
        seam.data[i].value = value
    return obj


def ensure_masks(obj, *, default=DEFAULT_MATERIAL):
    """Make sure `mat_id`, `id_color` and `seam` exist (defaults: id `default`, no seam) before a join or bake."""
    if obj.data.attributes.get('mat_id') is None:
        assign_material_id(obj, default)
    if obj.data.attributes.get('seam') is None:
        mark_seam(obj, [], 0.0)
    return obj


def edge_wear(obj, rng, *, angle=math.radians(25.0), falloff=math.radians(60.0), breakup=0.5, scale=0.04):
    """Geometric edge-wear mask `wear` (POINT, 0..1): convex edges sharper than `angle` wear, ramped
    over `falloff`, broken up by seeded noise (`breakup` 0 = solid, 1 = patchy). The texture-space
    equivalent from the curvature bake is `lib.pbr.wear_mask`.
    """
    noise = _value_noise(rng)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.normal_update()
    convex = [0.0] * len(bm.verts)
    for e in bm.edges:
        if not e.is_manifold:
            continue
        a = e.calc_face_angle_signed(0.0)
        if a > 0:
            w = min(1.0, max(0.0, (a - angle) / falloff))
            for v in e.verts:
                convex[v.index] = max(convex[v.index], w)
    bm.free()
    wear = _attr(obj.data, 'wear', 'FLOAT', 'POINT')
    for v in obj.data.vertices:
        n = noise(*(v.co / scale))
        wear.data[v.index].value = convex[v.index] * (1.0 - breakup + breakup * n)
    return obj
