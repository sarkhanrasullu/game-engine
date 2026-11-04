"""PBR materials the Blender glTF exporter maps 1:1 onto glTF metallic-roughness (ADR-0003).

Layout (per the glTF spec): baseColor sRGB; ORM = R occlusion, G roughness, B metallic (linear);
tangent-space normal (linear). Occlusion reaches the exporter through the "glTF Material Output"
node group, which is how the exporter recognises it.
"""
import bpy

GLTF_OUTPUT_GROUP = 'glTF Material Output'


def _gltf_output_group():
    group = bpy.data.node_groups.get(GLTF_OUTPUT_GROUP)
    if group is None:
        group = bpy.data.node_groups.new(GLTF_OUTPUT_GROUP, 'ShaderNodeTree')
        group.interface.new_socket('Occlusion', socket_type='NodeSocketFloat', in_out='INPUT')
        group.nodes.new('NodeGroupInput')
        group.nodes.new('NodeGroupOutput')
    return group


def pbr_material(name, *, base_color=None, orm=None, normal=None, base_factor=(1, 1, 1, 1)):
    """Build a Principled material from optional baseColor / ORM / normal images.

    Missing images leave the matching factor at Principled defaults. Returns the material.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True  # still required in 5.2.3; "removed in 6.0" is why bpy is pinned
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = base_factor
    if base_color is not None:
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = base_color
        links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    if orm is not None:
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = orm
        split = nodes.new('ShaderNodeSeparateColor')
        links.new(tex.outputs['Color'], split.inputs['Color'])
        links.new(split.outputs['Green'], bsdf.inputs['Roughness'])
        links.new(split.outputs['Blue'], bsdf.inputs['Metallic'])
        out = nodes.new('ShaderNodeGroup')
        out.node_tree = _gltf_output_group()
        links.new(split.outputs['Red'], out.inputs['Occlusion'])
    if normal is not None:
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = normal
        nmap = nodes.new('ShaderNodeNormalMap')
        nmap.space = 'TANGENT'
        links.new(tex.outputs['Color'], nmap.inputs['Color'])
        links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
    return mat
