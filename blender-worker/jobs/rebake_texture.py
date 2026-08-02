"""
blender-worker/jobs/rebake_texture.py — UV_TEXTURE_GENERATION_PLAN.md UV8
(with the minimal UV1 audit and UV4 projection-bake it depends on).

"rebake-texture" job: re-project the avatar's approved multiview reference
images (front/left/back/right, produced by the create flow with the palette
lock) onto the already-imported pet mesh and bake them into a fresh base-color
atlas. This is the likeness-repair path: no generation step, the user's own
approved views are the ground truth. Muddy Tripo textures are the target.

How the bake works (deliberately no ray-casting, no modifiers):
  1. For each view, an orthographic camera is fitted to the mesh bounds at its
     canonical azimuth (front = Blender's front view, looking along +Y).
  2. Each mesh loop is projected through each camera with
     bpy_extras.object_utils.world_to_camera_view and written to a dedicated
     UV layer (proj_front, proj_left, ...). Loops behind the camera are parked
     far outside [0,1] so the in-frame mask kills them.
  3. A temporary bake material blends: the ORIGINAL base-color texture as the
     floor (occluded texels keep the original look — natural inpaint fallback
     and likeness-safe), plus each view image weighted by facing^2
     (max(dot(world normal, camera direction), 0)^2) and an in-frame mask.
     Weighted sum is normalized and baked to the atlas via Cycles EMIT.
  4. Original materials get their base-color image swapped to the baked atlas;
     geometry, UVs, rig, and every non-color map are untouched (plan rule D4).

Entry point: run_rebake(params) -> prints REBAKE_RESULT:{json} for the worker.
params = {
  "views":        {"front": url, "left": url, "back": url, "right": url},  # >=1
  "texture_size": 1024,          # clamped 256..2048
  "front_axis_deg": 0,           # yaw offset if the model does not face front
}

Runs inside Blender's Python (bpy). Not importable in Node/CI — mirrored
contracts are asserted by tests/texture_rebake.test.mjs at the source level.
"""

import bpy  # type: ignore
import json
import math
import os
import tempfile
import urllib.request

from bpy_extras.object_utils import world_to_camera_view  # type: ignore
from mathutils import Vector  # type: ignore

# Camera azimuths (degrees around Z, Blender front-view convention: the front
# camera sits on -Y looking toward +Y).
VIEW_AZIMUTH_DEG = {"front": 0.0, "right": 90.0, "back": 180.0, "left": 270.0}
FACING_EXPONENT = 2.0
BASE_WEIGHT = 0.35  # original texture floor weight — keeps likeness under weak coverage


def _mesh_objects():
    return [o for o in bpy.data.objects if o.type == "MESH" and o.visible_get()]


def _scene_bounds(objs):
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    for obj in objs:
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, world))
            hi = Vector(map(max, hi, world))
    return lo, hi


def _download_image(name, url):
    suffix = ".png" if ".png" in url.lower() else ".jpg"
    path = os.path.join(tempfile.gettempdir(), f"rebake_view_{name}{suffix}")
    req = urllib.request.Request(url, headers={"User-Agent": "pawsome3d-blender-worker"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(path, "wb") as out:
        out.write(resp.read())
    img = bpy.data.images.load(path, check_existing=False)
    img.name = f"rebake_view_{name}"
    return img


def _find_base_color_image(objs):
    """First Base Color image found across the meshes' materials."""
    for obj in objs:
        for slot in obj.material_slots:
            mat = slot.material
            if not mat or not mat.use_nodes:
                continue
            for node in mat.node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    base = node.inputs.get("Base Color")
                    if base:
                        for link in base.links:
                            if link.from_node.type == "TEX_IMAGE" and link.from_node.image:
                                return link.from_node.image
    return None


def _uv_audit(objs):
    """UV1-minimal: report enough to know whether a bake can land."""
    audit = {"meshes": 0, "faces": 0, "uv_layers": 0, "missing_uv": [], "repaired": []}
    for obj in objs:
        audit["meshes"] += 1
        audit["faces"] += len(obj.data.polygons)
        if obj.data.uv_layers:
            audit["uv_layers"] += len(obj.data.uv_layers)
        else:
            # Repair: an atlas bake is meaningless without UVs. Smart-project
            # is deterministic enough for a fallback and never touches verts.
            audit["missing_uv"].append(obj.name)
            bpy.context.view_layer.objects.active = obj
            for other in bpy.data.objects:
                other.select_set(other is obj)
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02)
            bpy.ops.object.mode_set(mode="OBJECT")
            audit["repaired"].append(obj.name)
    return audit


def _make_camera(name, azimuth_deg, lo, hi):
    """Orthographic camera at the given azimuth, framing the whole mesh."""
    center = (lo + hi) / 2.0
    size = hi - lo
    radius = max(size.x, size.y) * 1.5 + 0.001
    az = math.radians(azimuth_deg)
    # Azimuth 0 = camera on -Y (Blender front view), rotating clockwise from above.
    cam_pos = center + Vector((radius * math.sin(az), -radius * math.cos(az), 0.0))
    cam_data = bpy.data.cameras.new(name)
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(size.x, size.y, size.z) * 1.1
    cam_data.clip_start = 0.001
    cam_data.clip_end = radius * 4.0
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.scene.collection.objects.link(cam)
    direction = (center - cam_pos).normalized()
    cam.location = cam_pos
    # Blender cameras look down local -Z and use local Y as their vertical
    # axis. Using Z as both tracking and up makes side/rear views roll 90/180°.
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return cam, direction


def _write_projection_uvs(obj, cam, layer_name):
    """Project every loop through the camera into a dedicated UV layer."""
    scene = bpy.context.scene
    mesh = obj.data
    layer = mesh.uv_layers.get(layer_name) or mesh.uv_layers.new(name=layer_name)
    in_frame = 0
    total = 0
    for poly in mesh.polygons:
        for loop_idx in poly.loop_indices:
            vert = mesh.vertices[mesh.loops[loop_idx].vertex_index]
            world = obj.matrix_world @ vert.co
            ndc = world_to_camera_view(scene, cam, world)
            total += 1
            if ndc.z <= 0.0:
                layer.data[loop_idx].uv = (-10.0, -10.0)  # behind camera: masked out
            else:
                layer.data[loop_idx].uv = (ndc.x, ndc.y)
                if 0.0 <= ndc.x <= 1.0 and 0.0 <= ndc.y <= 1.0:
                    in_frame += 1
    return (in_frame / total) if total else 0.0


def _in_frame_mask(nodes, links, uv_node):
    """Node cluster: 1.0 when the projected UV is inside [0,1]^2, else 0.0."""
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(uv_node.outputs["UV"], sep.inputs["Vector"])
    result = None
    for axis in ("X", "Y"):
        gte = nodes.new("ShaderNodeMath"); gte.operation = "GREATER_THAN"; gte.inputs[1].default_value = -0.0001
        lte = nodes.new("ShaderNodeMath"); lte.operation = "LESS_THAN"; lte.inputs[1].default_value = 1.0001
        links.new(sep.outputs[axis], gte.inputs[0])
        links.new(sep.outputs[axis], lte.inputs[0])
        band = nodes.new("ShaderNodeMath"); band.operation = "MULTIPLY"
        links.new(gte.outputs[0], band.inputs[0])
        links.new(lte.outputs[0], band.inputs[1])
        if result is None:
            result = band
        else:
            combined = nodes.new("ShaderNodeMath"); combined.operation = "MULTIPLY"
            links.new(result.outputs[0], combined.inputs[0])
            links.new(band.outputs[0], combined.inputs[1])
            result = combined
    return result


def _facing_weight(nodes, links, cam_dir):
    """max(dot(world normal, -camera direction), 0) ** FACING_EXPONENT."""
    geom = nodes.new("ShaderNodeNewGeometry")
    dot = nodes.new("ShaderNodeVectorMath"); dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = (-cam_dir.x, -cam_dir.y, -cam_dir.z)
    links.new(geom.outputs["Normal"], dot.inputs[0])
    clamped = nodes.new("ShaderNodeMath"); clamped.operation = "MAXIMUM"; clamped.inputs[1].default_value = 0.0
    links.new(dot.outputs["Value"], clamped.inputs[0])
    powed = nodes.new("ShaderNodeMath"); powed.operation = "POWER"; powed.inputs[1].default_value = FACING_EXPONENT
    links.new(clamped.outputs[0], powed.inputs[0])
    return powed


def _build_bake_material(view_images, cam_dirs, base_image, atlas_image, mesh_uv_name):
    """
    Emission = ( base*W_base + Σ view_i * w_i ) / ( W_base + Σ w_i )
    with w_i = facing^2 * in_frame_mask. Baked via EMIT into atlas_image.
    """
    mat = bpy.data.materials.new("RebakeBakeMat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    links.new(emit.outputs["Emission"], out.inputs["Surface"])

    # Base floor: original texture through the mesh's own UV map.
    base_uv = nodes.new("ShaderNodeUVMap"); base_uv.uv_map = mesh_uv_name
    base_tex = nodes.new("ShaderNodeTexImage"); base_tex.image = base_image
    links.new(base_uv.outputs["UV"], base_tex.inputs["Vector"])
    base_w = nodes.new("ShaderNodeValue"); base_w.outputs[0].default_value = BASE_WEIGHT

    color_terms = []  # (color_socket_owner_node, weight_node)
    color_terms.append((base_tex, base_w))

    for view_name, image in view_images.items():
        uv_node = nodes.new("ShaderNodeUVMap"); uv_node.uv_map = f"proj_{view_name}"
        tex = nodes.new("ShaderNodeTexImage"); tex.image = image; tex.extension = "CLIP"
        links.new(uv_node.outputs["UV"], tex.inputs["Vector"])
        facing = _facing_weight(nodes, links, cam_dirs[view_name])
        mask = _in_frame_mask(nodes, links, uv_node)
        weight = nodes.new("ShaderNodeMath"); weight.operation = "MULTIPLY"
        links.new(facing.outputs[0], weight.inputs[0])
        links.new(mask.outputs[0], weight.inputs[1])
        color_terms.append((tex, weight))

    # Weighted sum of colors and sum of weights.
    weighted_sum = None
    weight_sum = None
    for tex, weight in color_terms:
        scaled = nodes.new("ShaderNodeVectorMath"); scaled.operation = "SCALE"
        links.new(tex.outputs["Color"], scaled.inputs[0])
        links.new(weight.outputs[0], scaled.inputs["Scale"])
        if weighted_sum is None:
            weighted_sum = scaled
            weight_sum = weight
        else:
            add_c = nodes.new("ShaderNodeVectorMath"); add_c.operation = "ADD"
            links.new(weighted_sum.outputs[0], add_c.inputs[0])
            links.new(scaled.outputs[0], add_c.inputs[1])
            weighted_sum = add_c
            add_w = nodes.new("ShaderNodeMath"); add_w.operation = "ADD"
            links.new(weight_sum.outputs[0], add_w.inputs[0])
            links.new(weight.outputs[0], add_w.inputs[1])
            weight_sum = add_w

    # Normalize: guard the divisor so an all-zero weight can never NaN the bake.
    safe = nodes.new("ShaderNodeMath"); safe.operation = "MAXIMUM"; safe.inputs[1].default_value = 1e-4
    links.new(weight_sum.outputs[0], safe.inputs[0])
    inv = nodes.new("ShaderNodeMath"); inv.operation = "DIVIDE"; inv.inputs[0].default_value = 1.0
    links.new(safe.outputs[0], inv.inputs[1])
    normalized = nodes.new("ShaderNodeVectorMath"); normalized.operation = "SCALE"
    links.new(weighted_sum.outputs[0], normalized.inputs[0])
    links.new(inv.outputs[0], normalized.inputs["Scale"])
    links.new(normalized.outputs[0], emit.inputs["Color"])

    # Bake target: the ACTIVE image node must be the atlas.
    atlas_node = nodes.new("ShaderNodeTexImage")
    atlas_node.image = atlas_image
    atlas_node.select = True
    nodes.active = atlas_node
    return mat


def _swap_base_color(objs, atlas_image):
    swapped = 0
    for obj in objs:
        for slot in obj.material_slots:
            mat = slot.material
            if not mat or not mat.use_nodes:
                continue
            for node in mat.node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    base = node.inputs.get("Base Color")
                    if not base:
                        continue
                    for link in base.links:
                        if link.from_node.type == "TEX_IMAGE":
                            link.from_node.image = atlas_image
                            swapped += 1
    return swapped


def run_rebake(params):
    views = params.get("views") or {}
    texture_size = max(256, min(int(params.get("texture_size") or 1024), 2048))
    yaw_offset = float(params.get("front_axis_deg") or 0.0)

    objs = _mesh_objects()
    if not objs:
        print("REBAKE_RESULT:" + json.dumps({"success": False, "error": "No mesh in scene."}))
        return

    audit = _uv_audit(objs)

    view_images = {}
    for name, url in views.items():
        if name in VIEW_AZIMUTH_DEG and url:
            view_images[name] = _download_image(name, url)
    if not view_images:
        print("REBAKE_RESULT:" + json.dumps({"success": False, "error": "No usable views supplied."}))
        return

    lo, hi = _scene_bounds(objs)
    cam_dirs = {}
    coverage = {}
    cams = []
    for name in view_images:
        cam, direction = _make_camera(f"rebake_cam_{name}", VIEW_AZIMUTH_DEG[name] + yaw_offset, lo, hi)
        cams.append(cam)
        cam_dirs[name] = direction
        for obj in objs:
            coverage[f"{obj.name}:{name}"] = round(_write_projection_uvs(obj, cam, f"proj_{name}"), 4)

    base_image = _find_base_color_image(objs)
    if base_image is None:
        base_image = bpy.data.images.new("rebake_neutral", 8, 8)
        base_image.pixels = [0.5, 0.45, 0.4, 1.0] * 64

    atlas = bpy.data.images.new("rebake_atlas", texture_size, texture_size, alpha=False)

    # Bake with a temporary material on every slot; originals restored after.
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16  # EMIT bake needs almost none
    scene.render.bake.use_clear = True
    scene.render.bake.margin = 8

    originals = {}
    for obj in objs:
        mesh_uv = obj.data.uv_layers[0].name
        # active UV must be the mesh's own map — that is where the bake lands.
        obj.data.uv_layers.active = obj.data.uv_layers[mesh_uv]
        bake_mat = _build_bake_material(view_images, cam_dirs, base_image, atlas, mesh_uv)
        originals[obj.name] = [slot.material for slot in obj.material_slots]
        if not obj.material_slots:
            obj.data.materials.append(bake_mat)
        else:
            for slot in obj.material_slots:
                slot.material = bake_mat

    for other in bpy.data.objects:
        other.select_set(other.type == "MESH")
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type="EMIT")

    # Restore originals, then point their base color at the new atlas.
    for obj in objs:
        saved = originals.get(obj.name) or []
        for i, slot in enumerate(obj.material_slots):
            if i < len(saved) and saved[i] is not None:
                slot.material = saved[i]
    swapped = _swap_base_color(objs, atlas)

    # Clean up projection UV layers and cameras so the export stays lean.
    for obj in objs:
        for name in list(view_images):
            layer = obj.data.uv_layers.get(f"proj_{name}")
            if layer:
                obj.data.uv_layers.remove(layer)
    for cam in cams:
        bpy.data.objects.remove(cam, do_unlink=True)

    atlas.pack()

    print("REBAKE_RESULT:" + json.dumps({
        "success": True,
        "audit": audit,
        "views_used": sorted(view_images.keys()),
        "coverage": coverage,
        "texture_size": texture_size,
        "materials_retargeted": swapped,
    }))
