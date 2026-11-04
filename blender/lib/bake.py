"""Cycles CPU bakes from a high-poly source onto a low-poly target (ADR-0003 §Pipeline).

EEVEE aborts in this container (no libEGL), so every bake is Cycles CPU with fixed samples.
Bakes run one after another in a fixed order; the caller decides the order.
"""
import bpy

from . import scene as sc


def new_image(name, size, *, non_color, fill=(0.0, 0.0, 0.0, 1.0)):
    """Create a square 8-bit RGBA image. `non_color` for data maps (normal, ORM, masks)."""
    img = bpy.data.images.new(name, width=size, height=size, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    img.generated_color = fill
    return img


def _bake_target_node(low, image):
    """Point every material slot of `low` at `image` via an active, unconnected image node."""
    for slot in low.material_slots:
        nodes = slot.material.node_tree.nodes
        node = nodes.get('__bake_target__') or nodes.new('ShaderNodeTexImage')
        node.name = '__bake_target__'
        node.image = image
        nodes.active = node


def _clear_bake_target(low):
    for slot in low.material_slots:
        nodes = slot.material.node_tree.nodes
        node = nodes.get('__bake_target__')
        if node is not None:
            nodes.remove(node)


def bake(kind, high, low, image, *, samples, extrusion, max_ray):
    """Bake `kind` ('NORMAL' tangent space, or 'AO') from `high` onto `low`'s active UV into `image`.

    `extrusion` is the cage push (m) and `max_ray` the ray length (m); both must cover the
    high/low gap or the bake shows holes.
    """
    scene = bpy.context.scene
    scene.cycles.samples = samples
    bake_settings = scene.render.bake
    bake_settings.use_selected_to_active = True
    bake_settings.cage_extrusion = extrusion
    bake_settings.max_ray_distance = max_ray
    bake_settings.margin = 4
    bake_settings.margin_type = 'EXTEND'
    bake_settings.use_clear = True
    bake_settings.target = 'IMAGE_TEXTURES'
    if kind == 'NORMAL':
        bake_settings.normal_space = 'TANGENT'
    _bake_target_node(low, image)
    sc.activate(low, also_select=(high,))
    bpy.ops.object.bake(type=kind)
    _clear_bake_target(low)
    return image


def pixels(image):
    """The image as a flat list of RGBA floats (row 0 = bottom, Blender's order)."""
    buf = [0.0] * (image.size[0] * image.size[1] * 4)
    image.pixels.foreach_get(buf)
    return buf


def set_pixels(image, values):
    """Overwrite the image's RGBA floats (same layout as `pixels`)."""
    image.pixels.foreach_set(values)
    image.update()


def save_png(image, path):
    """Write `image` as an 8-bit RGBA PNG at `path` and keep it file-backed for the exporter."""
    image.filepath_raw = str(path)
    image.file_format = 'PNG'
    image.save()
    return path


# --- mask bakes (EMIT of a temporary shader on the high poly) -------------------------------------
# Curvature, material ID and the emissive seam mask have no native Cycles bake type. Each one swaps
# the high poly's materials for a temporary emission shader, bakes EMIT selected-to-active with one
# sample (crisp, deterministic), and restores the original materials.

#: The fixed order of `bake_chain`. Never reorder: the outputs must be byte-stable between runs.
CHAIN = ('normal', 'ao', 'curvature', 'id', 'seam')


def _emission_material(name, wire):
    """A material whose Emission colour comes from `wire(nodes, links) -> colour socket`."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for n in list(nodes):
        nodes.remove(n)
    out = nodes.new('ShaderNodeOutputMaterial')
    emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Strength'].default_value = 1.0
    links.new(wire(nodes, links), emit.inputs['Color'])
    links.new(emit.outputs['Emission'], out.inputs['Surface'])
    return mat


def _bake_emit_with(high, low, image, mat, *, extrusion, max_ray):
    """Bake EMIT of `mat` (temporarily on every slot of `high`) onto `low`'s UVs."""
    saved = [slot.material for slot in high.material_slots]
    if not saved:
        high.data.materials.append(mat)
    for slot in high.material_slots:
        slot.material = mat
    try:
        bake('EMIT', high, low, image, samples=1, extrusion=extrusion, max_ray=max_ray)
    finally:
        if saved:
            for slot, m in zip(high.material_slots, saved):
                slot.material = m
        else:
            high.data.materials.clear()
        bpy.data.materials.remove(mat)
    return image


def bake_curvature(high, low, image, *, contrast=4.0, extrusion, max_ray):
    """Curvature from Cycles Pointiness on the high poly: 0.5 = flat, > 0.5 convex (edges),
    < 0.5 concave (cavities, panel lines). `contrast` scales the deviation from 0.5 before clamping.
    Pointiness is per vertex, so the high poly must be dense (densify/remesh)."""
    def wire(nodes, links):
        geo = nodes.new('ShaderNodeNewGeometry')
        remap = nodes.new('ShaderNodeMapRange')
        remap.clamp = True
        half = 0.5 / contrast
        remap.inputs['From Min'].default_value = 0.5 - half
        remap.inputs['From Max'].default_value = 0.5 + half
        links.new(geo.outputs['Pointiness'], remap.inputs['Value'])
        return remap.outputs['Result']
    return _bake_emit_with(high, low, image, _emission_material('__bake_curvature__', wire),
                           extrusion=extrusion, max_ray=max_ray)


def bake_attribute(high, low, image, attribute, *, extrusion, max_ray):
    """Bake a mesh attribute of the high poly (colour or float) as-is, e.g. 'id_color' or 'seam'."""
    def wire(nodes, links):
        attr = nodes.new('ShaderNodeAttribute')
        attr.attribute_type = 'GEOMETRY'
        attr.attribute_name = attribute
        return attr.outputs['Color']
    return _bake_emit_with(high, low, image, _emission_material(f'__bake_{attribute}__', wire),
                           extrusion=extrusion, max_ray=max_ray)


def bake_chain(high, low, size, *, prefix, extrusion, max_ray, ao_samples=16, curvature_contrast=4.0):
    """Every map of the chain, in CHAIN order, from `high` onto `low` (which needs UVs and a material).

    The high poly needs `id_color` and `seam` (lib.hardsurface.ensure_masks). Returns
    {'normal', 'ao', 'curvature', 'id', 'seam'} -> image, all Non-Color, `size`^2. Example:
        maps = bake_chain(high, low, 1024, prefix='hero_a', extrusion=0.01, max_ray=0.02)
    """
    maps = {
        'normal': new_image(f'{prefix}_normal', size, non_color=True, fill=(0.5, 0.5, 1.0, 1.0)),
        'ao': new_image(f'{prefix}_ao', size, non_color=True, fill=(1.0, 1.0, 1.0, 1.0)),
        'curvature': new_image(f'{prefix}_curvature', size, non_color=True, fill=(0.5, 0.5, 0.5, 1.0)),
        'id': new_image(f'{prefix}_id', size, non_color=True),
        'seam': new_image(f'{prefix}_seam', size, non_color=True),
    }
    bake('NORMAL', high, low, maps['normal'], samples=1, extrusion=extrusion, max_ray=max_ray)
    bake('AO', high, low, maps['ao'], samples=ao_samples, extrusion=extrusion, max_ray=max_ray)
    bake_curvature(high, low, maps['curvature'], contrast=curvature_contrast, extrusion=extrusion, max_ray=max_ray)
    bake_attribute(high, low, maps['id'], 'id_color', extrusion=extrusion, max_ray=max_ray)
    bake_attribute(high, low, maps['seam'], 'seam', extrusion=extrusion, max_ray=max_ray)
    for img in maps.values():
        _opaque(img)
    return maps


def _opaque(image):
    """Force alpha to 1. Cycles left the alpha of unbaked texels (outside every UV island) at 0 or 1
    from run to run (seen 2026-11-04 on smoke_plate), so saved masks were not byte-stable."""
    px = pixels(image)
    px[3::4] = [1.0] * (len(px) // 4)
    set_pixels(image, px)
    return image
