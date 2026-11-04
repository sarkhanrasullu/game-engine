"""The single glTF export every asset uses: a raw, uncompressed .glb (ADR-0003 §Pipeline).

Compression (meshopt geometry, KTX2 textures, prune) happens afterwards in Node
(blender/compress.mjs) so one pinned encoder set is used for every asset. Draco is never on.
"""
import bmesh
import bpy


def _sort_faces(obj):
    """Put faces in a canonical order (material, then sorted vertex indices). Some operators (seen with
    joins of bevelled primitives in smoke_rig) emitted the same faces in a different order on two
    identical runs, and the index buffer follows face order. Vertices, groups and UVs are untouched."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.index_update()
    bm.faces.index_update()
    order = sorted(bm.faces, key=lambda f: (f.material_index, tuple(sorted(v.index for v in f.verts)),
                                            tuple(v.index for v in f.verts)))
    rank = {f.index: r for r, f in enumerate(order)}
    bm.faces.sort(key=lambda f: rank[f.index])  # bmesh sort keys must be numbers
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def _triangulate_all():
    """Give every mesh a last Triangulate modifier (fixed quad split, ear-clip n-gons). Without it the
    exporter's own n-gon split gave a different index order on two identical runs (smoke_rig,
    2026-11-04). export_apply applies it; the Armature modifier is still left to the skin."""
    for obj in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        if obj.type != 'MESH':
            continue
        _sort_faces(obj)
        if any(m.type == 'TRIANGULATE' for m in obj.modifiers):
            continue
        mod = obj.modifiers.new('export_triangulate', 'TRIANGULATE')
        mod.quad_method = 'FIXED'
        mod.ngon_method = 'CLIP'
        mod.keep_custom_normals = True


def export_glb(path, *, skins=False, animations=False):
    """Export every mesh/armature in the scene to `path` (.glb, PNG images, tangents, +Y up).

    Meshes are triangulated deterministically first (`_triangulate_all`)."""
    _triangulate_all()
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format='GLB',
        export_image_format='AUTO',
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials='EXPORT',
        export_vertex_color='NONE',
        export_attributes=True,  # keeps custom `_ATTR` layers such as ADR-0003's `_CLAMPDIR`
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_yup=True,
        export_apply=True,
        export_skins=skins,
        export_animations=animations,
        export_morph=False,
        export_draco_mesh_compression_enable=False,
        export_meshopt_compression_enable=False,
        export_use_gltfpack=False,
        export_copyright='',
    )
    return path
