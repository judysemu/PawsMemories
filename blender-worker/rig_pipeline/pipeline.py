"""Deterministic Blender implementation for the Phase 4 rig/facial worker.

This module runs inside Blender through bridge/ tcp_server.py. It deliberately
uses only Blender's bundled Python modules and the adjacent pure validation
helpers so the Render image does not need another package.
"""

from __future__ import annotations

import base64
import json
import math
import os
import tempfile
import traceback
from pathlib import Path

from validation import canonical_target_name, facial_capability, measure_morph, print_metrics_pass, quaternion_xyzw


PIPELINE_ALGORITHM_VERSION = "paws-rig-blender-3"
MIN_SEMANTIC_REGION_VERTICES = 12
PARENT_BY_BONE = {
    "spine": "hip",
    "chest": "spine",
    "neck": "chest",
    "head": "neck",
    "jaw": "head",
    "tongue": "jaw",
    "eye.L": "head",
    "eye.R": "head",
    "brow.L": "head",
    "brow.R": "head",
    "ear.L": "head",
    "ear.R": "head",
    "shoulder.L": "chest",
    "shoulder.R": "chest",
    "leg_front.L": "shoulder.L",
    "leg_front.R": "shoulder.R",
    "leg_back.L": "hip",
    "leg_back.R": "hip",
    "tail.01": "hip",
    "tail.02": "tail.01",
}


class PipelineFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _rule(rule: str, passed: bool, detail: str, metrics: dict | None = None) -> dict:
    result = {"rule": rule, "pass": bool(passed), "detail": str(detail)[:500]}
    if metrics:
        result["metrics"] = metrics
    return result


def _clear_scene(bpy) -> None:
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    # Selection-based deletion misses hidden or non-selectable imported
    # objects. A long-running worker would then measure geometry left by a
    # previous customer job. Unlink every object directly so each request
    # begins from a genuinely empty Blender database.
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in (
        bpy.data.armatures,
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.actions,
    ):
        for block in list(collection):
            if block.users == 0:
                try:
                    collection.remove(block)
                except RuntimeError:
                    pass


def _mesh_objects(bpy):
    return sorted((obj for obj in bpy.context.scene.objects if obj.type == "MESH"), key=lambda obj: obj.name)


def _world_bounds(meshes):
    from mathutils import Vector

    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    if not points:
        raise PipelineFailure("NO_MESH", "GLB contains no mesh geometry")
    minimum = [min(point[axis] for point in points) for axis in range(3)]
    maximum = [max(point[axis] for point in points) for axis in range(3)]
    return minimum, maximum


def _triangle_count(meshes) -> int:
    return sum(len(obj.data.loop_triangles) if obj.data.loop_triangles else _triangulate_count(obj) for obj in meshes)


def _triangulate_count(obj) -> int:
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def _source_target_names(meshes) -> list[str]:
    names = []
    for obj in meshes:
        keys = obj.data.shape_keys.key_blocks if obj.data.shape_keys else []
        for key in list(keys)[1:]:
            if key.name not in names:
                names.append(key.name)
    return names


def _semantic_regions(meshes) -> dict[str, dict[str, set[int]]]:
    """Inventory source-authored vertex groups before this pipeline adds weights."""
    patterns = {
        "head": ("head", "face", "muzzle"),
        "mouth": ("mouth", "lip", "jaw"),
        "tongue": ("tongue",),
        "eye_left": ("eye.l", "eye_l", "eyeleft", "left_eye", "lid.l", "lid_l"),
        "eye_right": ("eye.r", "eye_r", "eyeright", "right_eye", "lid.r", "lid_r"),
    }
    result = {obj.name: {region: set() for region in patterns} for obj in meshes}
    for obj in meshes:
        names_by_index = {group.index: group.name.lower() for group in obj.vertex_groups}
        for vertex in obj.data.vertices:
            for membership in vertex.groups:
                if membership.weight <= 0.05:
                    continue
                name = names_by_index.get(membership.group, "")
                for region, aliases in patterns.items():
                    if any(alias in name for alias in aliases):
                        result[obj.name][region].add(vertex.index)
    return result


def _profile_position(normalized, minimum, maximum):
    return tuple(minimum[axis] + float(normalized[axis]) * (maximum[axis] - minimum[axis]) for axis in range(3))


def _validate_existing_armature(meshes, armature, required_bones) -> tuple[bool, str]:
    if armature is None:
        return False, "no source armature"
    names = {bone.name for bone in armature.data.bones}
    missing = sorted(required_bones - names)
    if missing:
        return False, f"source armature is missing {', '.join(missing)}"
    if not any(any(mod.type == "ARMATURE" and mod.object == armature for mod in obj.modifiers) for obj in meshes):
        return False, "source armature is not bound to a mesh"
    return True, "source armature satisfies the canonical profile"


def _bone_tail(name, positions, minimum, maximum):
    children = sorted(child for child, parent in PARENT_BY_BONE.items() if parent == name and child in positions)
    head = positions[name]
    if children:
        candidate = positions[children[0]]
        if math.dist(head, candidate) > 1e-7:
            return candidate
    extent = max(maximum[axis] - minimum[axis] for axis in range(3))
    return (head[0], head[1], head[2] + max(extent * 0.035, 1e-4))


def _author_armature(bpy, meshes, profile, minimum, maximum):
    from mathutils import Vector

    positions = {name: _profile_position(value, minimum, maximum) for name, value in profile["joints"].items()}
    armature_data = bpy.data.armatures.new(f"{profile['id']}.Armature")
    armature = bpy.data.objects.new(f"{profile['id']}.Rig", armature_data)
    bpy.context.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = {}
    for name in sorted(positions):
        bone = armature_data.edit_bones.new(name)
        bone.head = positions[name]
        bone.tail = _bone_tail(name, positions, minimum, maximum)
        edit_bones[name] = bone
    for name, bone in edit_bones.items():
        parent = PARENT_BY_BONE.get(name)
        if parent in edit_bones:
            bone.parent = edit_bones[parent]
            bone.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")

    bone_segments = [(bone.name, armature.matrix_world @ bone.head_local, armature.matrix_world @ bone.tail_local) for bone in armature.data.bones]
    for obj in meshes:
        groups = {name: obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name) for name in positions}
        for vertex in obj.data.vertices:
            world = obj.matrix_world @ vertex.co
            ranked = []
            for name, head, tail in bone_segments:
                line = tail - head
                denominator = line.length_squared
                factor = 0.0 if denominator <= 1e-16 else max(0.0, min(1.0, (world - head).dot(line) / denominator))
                distance = (world - (head + line * factor)).length
                ranked.append((distance, name))
            nearest = sorted(ranked, key=lambda entry: (entry[0], entry[1]))[:2]
            weights = [1.0 / max(distance, 1e-6) for distance, _ in nearest]
            total = sum(weights)
            for weight, (_, name) in zip(weights, nearest):
                groups[name].add([vertex.index], weight / total, "REPLACE")
        modifier = next((mod for mod in obj.modifiers if mod.type == "ARMATURE"), None)
        if modifier is None:
            modifier = obj.modifiers.new(name="Pawsome3D Rig", type="ARMATURE")
        modifier.object = armature
    return armature


def _weight_metrics(meshes, armature, max_influences):
    bone_names = {bone.name for bone in armature.data.bones}
    total = 0
    weighted = 0
    over = 0
    measured_max = 0
    unweighted_islands = 0
    for obj in meshes:
        names = {group.index: group.name for group in obj.vertex_groups}
        unweighted = set()
        for vertex in obj.data.vertices:
            total += 1
            influences = [membership for membership in vertex.groups if membership.weight > 1e-5 and names.get(membership.group) in bone_names]
            measured_max = max(measured_max, len(influences))
            if influences:
                weighted += 1
            else:
                unweighted.add(vertex.index)
            if len(influences) > max_influences:
                over += 1
        adjacency = {index: set() for index in unweighted}
        for edge in obj.data.edges:
            first, second = edge.vertices
            if first in unweighted and second in unweighted:
                adjacency[first].add(second)
                adjacency[second].add(first)
        remaining = set(unweighted)
        while remaining:
            unweighted_islands += 1
            stack = [remaining.pop()]
            while stack:
                for neighbor in adjacency[stack.pop()]:
                    if neighbor in remaining:
                        remaining.remove(neighbor)
                        stack.append(neighbor)
    return {
        "vertices": total,
        "weightedVertices": weighted,
        "coverage": weighted / total if total else 0.0,
        "overInfluenced": over,
        "maxInfluences": measured_max,
        "unweightedIslands": unweighted_islands,
    }


def _finite_bind_matrices(armature) -> bool:
    for bone in armature.data.bones:
        if not all(math.isfinite(float(value)) for row in bone.matrix_local for value in row):
            return False
        determinant = float(bone.matrix_local.determinant())
        if not math.isfinite(determinant) or abs(determinant) <= 1e-12:
            return False
    return True


def _pose_sweep(bpy, meshes, armature):
    from mathutils import Quaternion, Vector

    candidates = [
        name for name in (
            "leg_front.L", "leg_front.R", "leg_back.L", "leg_back.R",
            "shoulder.L", "shoulder.R", "neck", "jaw", "tail.01", "ear.L", "ear.R",
        ) if armature.pose.bones.get(name)
    ]
    if not candidates:
        return {"bone": None, "maxDisplacement": 0.0, "silhouetteDeviation": float("inf"), "finite": False}
    baseline = {}
    baseline_points = []
    for obj in meshes:
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        baseline[obj.name] = [evaluated.matrix_world @ vertex.co for vertex in evaluated.data.vertices]
        baseline_points.extend(baseline[obj.name])
    maximum = 0.0
    silhouette = 0.0
    minimum_volume_ratio = 1.0
    finite = True
    baseline_extent = [max(point[axis] for point in baseline_points) - min(point[axis] for point in baseline_points) for axis in range(3)]
    reference = max(baseline_extent) if baseline_extent else 0.0
    baseline_volume = math.prod(max(value, 1e-9) for value in baseline_extent)
    pose_count = 0
    for name in candidates:
        bone = armature.pose.bones[name]
        original_mode = bone.rotation_mode
        original_rotation = bone.rotation_quaternion.copy()
        bone.rotation_mode = "QUATERNION"
        for angle in (-20.0, 20.0):
            pose_count += 1
            bone.rotation_quaternion = Quaternion(Vector((1.0, 0.0, 0.0)), math.radians(angle)) @ original_rotation
            bpy.context.view_layer.update()
            posed_points = []
            for obj in meshes:
                evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
                for before, vertex in zip(baseline[obj.name], evaluated.data.vertices):
                    after = evaluated.matrix_world @ vertex.co
                    posed_points.append(after)
                    distance = (after - before).length
                    finite = finite and math.isfinite(distance)
                    maximum = max(maximum, distance)
            posed_extent = [max(point[axis] for point in posed_points) - min(point[axis] for point in posed_points) for axis in range(3)]
            pose_silhouette = max((abs(posed_extent[axis] - baseline_extent[axis]) for axis in range(3)), default=0.0) / reference if reference > 0 else float("inf")
            posed_volume = math.prod(max(value, 1e-9) for value in posed_extent)
            silhouette = max(silhouette, pose_silhouette)
            minimum_volume_ratio = min(minimum_volume_ratio, posed_volume / baseline_volume)
        bone.rotation_quaternion = original_rotation
        bone.rotation_mode = original_mode
        bpy.context.view_layer.update()
    return {
        "bones": candidates,
        "poseCount": pose_count,
        "maxDisplacement": maximum,
        "silhouetteDeviation": silhouette,
        "minimumBoundsVolumeRatio": minimum_volume_ratio,
        "finite": finite and math.isfinite(silhouette) and math.isfinite(minimum_volume_ratio),
    }


def _non_manifold_count(meshes) -> int:
    import bmesh

    count = 0
    for obj in meshes:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        # glTF import may split otherwise identical positions at UV, normal,
        # material, or skinning seams. Counting those render-vertex splits as
        # open geometry makes a watertight GLB appear entirely non-manifold.
        # Weld only a disposable BMesh copy at a scale-relative near-zero
        # distance; the source mesh, UVs, normals, and exported bytes are not
        # modified by this topology measurement.
        if bm.verts:
            minimum = [min(vertex.co[axis] for vertex in bm.verts) for axis in range(3)]
            maximum = [max(vertex.co[axis] for vertex in bm.verts) for axis in range(3)]
            extent = max(maximum[axis] - minimum[axis] for axis in range(3))
            weld_distance = max(extent * 1e-9, 1e-12)
            bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=weld_distance)
        count += sum(1 for edge in bm.edges if not edge.is_manifold)
        bm.free()
    return count


def _region_for_target(regions, object_name, canonical):
    object_regions = regions.get(object_name, {})
    if canonical == "eyeBlinkLeft":
        return object_regions.get("eye_left", set())
    if canonical == "eyeBlinkRight":
        return object_regions.get("eye_right", set())
    if canonical == "H":
        return object_regions.get("tongue", set())
    return object_regions.get("mouth", set())


def _region_size(regions, key) -> int:
    return sum(len(per_object.get(key, set())) for per_object in regions.values())


def _head_size(meshes, regions) -> float:
    points = []
    for obj in meshes:
        indices = regions.get(obj.name, {}).get("head", set())
        points.extend(obj.matrix_world @ obj.data.vertices[index].co for index in indices)
    if not points:
        return 0.0
    return max(max(point[axis] for point in points) - min(point[axis] for point in points) for axis in range(3))


def _region_world_bounds(meshes, regions, region):
    points = []
    for obj in meshes:
        indices = regions.get(obj.name, {}).get(region, set())
        points.extend(obj.matrix_world @ obj.data.vertices[index].co for index in indices)
    if not points:
        return None
    return (
        [min(point[axis] for point in points) for axis in range(3)],
        [max(point[axis] for point in points) for axis in range(3)],
    )


def _target_measurements(meshes, regions, head_size, authored_names):
    measurements = []
    for obj in meshes:
        if not obj.data.shape_keys:
            continue
        keys = obj.data.shape_keys.key_blocks
        basis = [tuple(obj.matrix_world @ point.co) for point in keys[0].data]
        for key in list(keys)[1:]:
            canonical = canonical_target_name(key.name)
            if not canonical:
                continue
            allowed = _region_for_target(regions, obj.name, canonical)
            measured = measure_morph(basis, [tuple(obj.matrix_world @ point.co) for point in key.data], allowed, head_size)
            measurements.append({
                "name": key.name,
                "canonicalName": canonical,
                "displacedVertexCount": measured["displacedVertices"],
                "maxDisplacement": measured["maxDisplacement"],
                "localityPass": measured["localityPass"],
                "deformationPass": measured["deformationPass"],
                "pass": measured["pass"],
                "authored": key.name in authored_names,
            })
    return measurements


def _author_target(obj, canonical, indices, scale):
    if not obj.data.shape_keys:
        obj.shape_key_add(name="Basis", from_mix=False)
    if obj.data.shape_keys.key_blocks.get(canonical):
        return False
    key = obj.shape_key_add(name=canonical, from_mix=False)
    center_z = sum(obj.data.vertices[index].co.z for index in indices) / len(indices)
    center_x = sum(obj.data.vertices[index].co.x for index in indices) / len(indices)
    for index in indices:
        source = obj.data.vertices[index].co
        destination = key.data[index].co
        if canonical in ("A", "X"):
            destination.z += math.copysign(-scale * (0.020 if canonical == "A" else 0.008), source.z - center_z or 1.0)
        elif canonical in ("B", "C", "D"):
            amount = {"B": 0.012, "C": 0.025, "D": 0.045}[canonical]
            destination.z += math.copysign(scale * amount, source.z - center_z or 1.0)
        elif canonical == "E":
            destination.x += math.copysign(scale * 0.018, source.x - center_x or 1.0)
            destination.y -= scale * 0.008
        elif canonical == "F":
            destination.x += math.copysign(-scale * 0.012, source.x - center_x or 1.0)
            destination.y -= scale * 0.020
        elif canonical == "G":
            destination.y -= scale * 0.016
            if source.z < center_z:
                destination.z -= scale * 0.008
        elif canonical == "H":
            destination.y -= scale * 0.018
            destination.z += scale * 0.010
        elif canonical == "jawOpen":
            destination.z -= scale * 0.035
            destination.y -= scale * 0.010
        elif canonical in ("eyeBlinkLeft", "eyeBlinkRight"):
            destination.z += math.copysign(-scale * 0.020, source.z - center_z or 1.0)
    return True


def _author_missing_targets(meshes, regions, requested, head_size):
    authored = set()
    existing = {canonical_target_name(name) for name in _source_target_names(meshes)}
    credible_head = _region_size(regions, "head") >= MIN_SEMANTIC_REGION_VERTICES
    for canonical in requested:
        if canonical in existing:
            continue
        region_name = "eye_left" if canonical == "eyeBlinkLeft" else "eye_right" if canonical == "eyeBlinkRight" else "tongue" if canonical == "H" else "mouth"
        if not credible_head or _region_size(regions, region_name) < MIN_SEMANTIC_REGION_VERTICES:
            continue
        for obj in meshes:
            indices = regions.get(obj.name, {}).get(region_name, set())
            if len(indices) < MIN_SEMANTIC_REGION_VERTICES:
                continue
            object_scale = max((abs(float(value)) for value in obj.matrix_world.to_scale()), default=1.0)
            local_head_size = head_size / max(object_scale, 1e-9)
            if _author_target(obj, canonical, sorted(indices), local_head_size):
                authored.add(canonical)
                break
    return authored


def _render_evidence(bpy, meshes, minimum, maximum, max_bytes, target_name=None):
    from mathutils import Vector

    center = Vector(tuple((minimum[axis] + maximum[axis]) * 0.5 for axis in range(3)))
    extent = max(maximum[axis] - minimum[axis] for axis in range(3))
    if extent <= 0:
        return [], "model bounds are degenerate"
    camera_data = bpy.data.cameras.new("RigEvidenceCamera")
    camera = bpy.data.objects.new("RigEvidenceCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = extent * 1.35

    scene = bpy.context.scene
    previous = (
        scene.render.engine,
        scene.render.resolution_x,
        scene.render.resolution_y,
        scene.render.resolution_percentage,
        scene.render.filepath,
        scene.render.film_transparent,
        scene.render.image_settings.file_format,
    )
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 256
    scene.render.resolution_y = 256
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = True
    renders = []
    total = 0
    temp_dir = tempfile.mkdtemp(prefix="rig-evidence-")
    activated = []
    try:
        if target_name:
            for obj in meshes:
                key = obj.data.shape_keys.key_blocks.get(target_name) if obj.data.shape_keys else None
                if key:
                    activated.append((key, key.value))
                    key.value = 1.0
            bpy.context.view_layer.update()
        for view, offset in (("front", Vector((0.0, -2.5 * extent, 0.0))), ("three_quarter", Vector((-1.8 * extent, -1.8 * extent, 0.25 * extent)))):
            camera.location = center + offset
            direction = center - camera.location
            camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
            output_path = os.path.join(temp_dir, f"{view}.png")
            scene.render.filepath = output_path
            bpy.ops.render.render(write_still=True)
            data = Path(output_path).read_bytes()
            total += len(data)
            if total > max_bytes:
                return [], "render evidence exceeded its byte budget"
            renders.append({"view": view, "pngBase64": base64.b64encode(data).decode("ascii")})
        return renders, "front and three-quarter evidence rendered"
    except Exception as error:
        return [], f"render evidence failed: {error}"
    finally:
        for key, original_value in activated:
            key.value = original_value
        bpy.context.view_layer.update()
        (
            scene.render.engine,
            scene.render.resolution_x,
            scene.render.resolution_y,
            scene.render.resolution_percentage,
            scene.render.filepath,
            scene.render.film_transparent,
            scene.render.image_settings.file_format,
        ) = previous
        if camera.name in bpy.data.objects:
            bpy.data.objects.remove(camera, do_unlink=True)
        for filename in Path(temp_dir).glob("*"):
            filename.unlink(missing_ok=True)
        Path(temp_dir).rmdir()


def _texture_max_dimension(meshes) -> int:
    dimensions = []
    seen = set()
    for obj in meshes:
        for material in obj.data.materials:
            if not material or not material.use_nodes or not material.node_tree:
                continue
            for node in material.node_tree.nodes:
                image = node.image if node.type == "TEX_IMAGE" else None
                if image and image.name not in seen and image.size and image.size[0] > 0 and image.size[1] > 0:
                    seen.add(image.name)
                    dimensions.extend((int(image.size[0]), int(image.size[1])))
    return max(dimensions, default=0)


def _surface_distances(bpy, body_meshes, accessory_meshes):
    from mathutils.bvhtree import BVHTree

    depsgraph = bpy.context.evaluated_depsgraph_get()
    body_trees = []
    for body in body_meshes:
        tree = BVHTree.FromObject(body, depsgraph, deform=True, cage=False)
        if tree:
            body_trees.append((body, tree))
    if not body_trees:
        return float("inf"), float("inf")
    floating = float("inf")
    penetration = 0.0
    sampled = 0
    for accessory in accessory_meshes:
        stride = max(1, len(accessory.data.vertices) // 2000)
        for index, vertex in enumerate(accessory.data.vertices):
            if index % stride:
                continue
            sampled += 1
            point_world = accessory.matrix_world @ vertex.co
            nearest_distance = float("inf")
            nearest_signed = None
            for body, tree in body_trees:
                point_local = body.matrix_world.inverted() @ point_world
                location, normal, _, distance = tree.find_nearest(point_local)
                if location is None or distance is None:
                    continue
                location_world = body.matrix_world @ location
                normal_world = (body.matrix_world.to_3x3() @ normal).normalized()
                world_distance = (point_world - location_world).length
                signed = (point_world - location_world).dot(normal_world)
                if world_distance < nearest_distance:
                    nearest_distance = world_distance
                    nearest_signed = signed
            if nearest_signed is not None:
                if nearest_signed < 0:
                    penetration = max(penetration, nearest_distance)
                else:
                    floating = min(floating, nearest_distance)
    if sampled == 0:
        return float("inf"), float("inf")
    return (0.0 if not math.isfinite(floating) else floating), penetration


def _fit_accessories(bpy, body_meshes, armature, specs, model_extent, max_triangles):
    results = []
    rules = []
    fitted_meshes = []
    for spec in specs:
        bone = armature.data.bones.get(spec["attachmentBone"])
        if bone is None:
            raise PipelineFailure("INVALID_ATTACHMENT_BONE", f"attachment bone {spec['attachmentBone']} does not exist")
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=spec["path"])
        imported = sorted((obj for obj in bpy.context.scene.objects if obj not in before), key=lambda obj: obj.name)
        if any(obj.type == "ARMATURE" for obj in imported):
            raise PipelineFailure("INVALID_ACCESSORY_GLB", f"accessory {spec['accessoryUuid']} must be a rigid mesh without its own armature")
        accessory_meshes = [obj for obj in imported if obj.type == "MESH"]
        if not accessory_meshes:
            raise PipelineFailure("INVALID_ACCESSORY_GLB", f"accessory {spec['accessoryUuid']} contains no mesh")

        points = [obj.matrix_world @ vertex.co for obj in accessory_meshes for vertex in obj.data.vertices]
        if not points:
            raise PipelineFailure("INVALID_ACCESSORY_GLB", f"accessory {spec['accessoryUuid']} has no vertices")
        center = sum(points, points[0] * 0.0) / len(points)
        anchor = armature.matrix_world @ bone.tail_local
        translation = anchor - center
        for obj in imported:
            obj.matrix_world.translation += translation
            world = obj.matrix_world.copy()
            obj.parent = armature
            obj.parent_type = "BONE"
            obj.parent_bone = bone.name
            obj.matrix_world = world

        rest_floating, rest_penetration = _surface_distances(bpy, body_meshes, accessory_meshes)
        pose_bone = armature.pose.bones.get(bone.name)
        original_mode = pose_bone.rotation_mode
        original_rotation = pose_bone.rotation_euler.copy()
        sweep_values = [(rest_floating, rest_penetration)]
        pose_bone.rotation_mode = "XYZ"
        for angle in (-15.0, 15.0):
            pose_bone.rotation_euler.y = original_rotation.y + math.radians(angle)
            bpy.context.view_layer.update()
            sweep_values.append(_surface_distances(bpy, body_meshes, accessory_meshes))
        pose_bone.rotation_euler = original_rotation
        pose_bone.rotation_mode = original_mode
        bpy.context.view_layer.update()

        max_floating = max(value[0] for value in sweep_values)
        max_penetration = max(value[1] for value in sweep_values)
        floating_limit = max(model_extent * 0.10, 0.001)
        penetration_limit = max(model_extent * 0.01, 0.0005)
        sweep_pass = math.isfinite(max_floating) and math.isfinite(max_penetration) and max_floating <= floating_limit and max_penetration <= penetration_limit
        triangle_count = _triangle_count(accessory_meshes)
        polygon_pass = triangle_count <= min(25_000, max_triangles)
        primary = accessory_meshes[0]
        rotation = primary.matrix_world.to_quaternion()
        scale = primary.matrix_world.to_scale()
        position = primary.matrix_world.translation
        result = {
            "accessoryUuid": spec["accessoryUuid"],
            "attachmentBone": bone.name,
            "transform": {
                "position": [float(value) for value in position],
                "rotation": quaternion_xyzw(rotation),
                "scale": [float(value) for value in scale],
            },
            "floatingDistance": float(max_floating),
            "penetrationDepth": float(max_penetration),
            "animationSweepPass": sweep_pass,
            "polygonBudgetPass": polygon_pass,
            "printClearanceMm": float(rest_floating * 1000.0),
        }
        results.append(result)
        fitted_meshes.extend(accessory_meshes)
        rules.append(_rule(
            f"accessory_fit_{len(results)}",
            sweep_pass and polygon_pass,
            f"{spec['accessoryUuid']} float={max_floating:.6g}m penetration={max_penetration:.6g}m triangles={triangle_count}",
            {"floatingMeters": max_floating, "penetrationMeters": max_penetration, "triangles": triangle_count},
        ))
    return results, rules, fitted_meshes


def _print_topology_metrics(mesh) -> dict:
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    finite = all(math.isfinite(value) for vertex in bm.verts for value in vertex.co)
    non_manifold = sum(1 for edge in bm.edges if not edge.is_manifold)
    visited = set()
    components = 0
    for vertex in bm.verts:
        if vertex.index in visited:
            continue
        components += 1
        stack = [vertex]
        while stack:
            current = stack.pop()
            if current.index in visited:
                continue
            visited.add(current.index)
            stack.extend(edge.other_vert(current) for edge in current.link_edges if edge.other_vert(current).index not in visited)
    triangles = sum(max(0, len(face.verts) - 2) for face in bm.faces)
    volume = abs(float(bm.calc_volume(signed=True))) if bm.faces else 0.0
    metrics = {
        "objectCount": 1,
        "connectedComponents": components,
        "triangleCount": triangles,
        "nonManifoldEdges": non_manifold,
        "finiteGeometry": finite,
        "volumeCubicMeters": volume,
    }
    bm.free()
    return metrics


def _delete_objects(bpy, objects) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        try:
            if obj and obj.name in bpy.context.scene.objects:
                obj.select_set(True)
        except ReferenceError:
            continue
    bpy.ops.object.delete(use_global=False)


def _neutral_evaluated_duplicates(bpy, armature, meshes):
    pose_position = armature.data.pose_position
    shape_values = []
    armature.data.pose_position = "REST"
    for obj in meshes:
        if obj.data.shape_keys:
            for key in list(obj.data.shape_keys.key_blocks)[1:]:
                shape_values.append((key, key.value))
                key.value = 0.0
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    duplicates = []
    try:
        for index, obj in enumerate(meshes):
            evaluated = obj.evaluated_get(depsgraph)
            mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
            duplicate = bpy.data.objects.new(f"PawsPrintPart.{index:03d}", mesh)
            bpy.context.collection.objects.link(duplicate)
            duplicate.matrix_world = obj.matrix_world.copy()
            duplicate.data.materials.clear()
            duplicates.append(duplicate)
    finally:
        armature.data.pose_position = pose_position
        for key, value in shape_values:
            key.value = value
        bpy.context.view_layer.update()
    return duplicates


def _apply_object_transform(bpy, obj) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def _build_fused_print(bpy, armature, body_meshes, accessory_meshes, output_path, max_triangles, max_bytes):
    import bmesh

    if not accessory_meshes:
        raise PipelineFailure("PRINT_NO_ACCESSORIES", "no fitted accessories were available for print fusion")
    duplicates = _neutral_evaluated_duplicates(bpy, armature, [*body_meshes, *accessory_meshes])
    if len(duplicates) < 2:
        _delete_objects(bpy, duplicates)
        raise PipelineFailure("PRINT_FUSION_FAILED", "print fusion requires body and accessory geometry")
    try:
        for duplicate in duplicates:
            _apply_object_transform(bpy, duplicate)
        primary = duplicates[0]
        for operand in duplicates[1:]:
            modifier = primary.modifiers.new(name="PawsPrintUnion", type="BOOLEAN")
            modifier.operation = "UNION"
            modifier.solver = "EXACT"
            modifier.object = operand
            bpy.context.view_layer.objects.active = primary
            primary.select_set(True)
            try:
                bpy.ops.object.modifier_apply(modifier=modifier.name)
            except RuntimeError as error:
                raise PipelineFailure("PRINT_BOOLEAN_FAILED", f"exact accessory union failed: {error}") from error
            _delete_objects(bpy, [operand])

        bm = bmesh.new()
        bm.from_mesh(primary.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.triangulate(bm, faces=list(bm.faces))
        bm.to_mesh(primary.data)
        bm.free()
        primary.data.update()

        metrics = _print_topology_metrics(primary.data)
        rules = [
            _rule("print_single_object", metrics["objectCount"] == 1, f"measured {metrics['objectCount']} printable object"),
            _rule("print_single_component", metrics["connectedComponents"] == 1, f"measured {metrics['connectedComponents']} connected components", {"connectedComponents": metrics["connectedComponents"]}),
            _rule("print_watertight", metrics["nonManifoldEdges"] == 0, f"measured {metrics['nonManifoldEdges']} non-manifold edges", {"nonManifoldEdges": metrics["nonManifoldEdges"]}),
            _rule("print_finite_geometry", metrics["finiteGeometry"], "all print vertex coordinates are finite"),
            _rule("print_triangle_budget", 0 < metrics["triangleCount"] <= max_triangles, f"measured {metrics['triangleCount']} triangles", {"triangles": metrics["triangleCount"]}),
            _rule("print_solid_volume", math.isfinite(metrics["volumeCubicMeters"]) and metrics["volumeCubicMeters"] > 1e-12, f"measured {metrics['volumeCubicMeters']:.8g} cubic meters", {"volumeCubicMeters": metrics["volumeCubicMeters"]}),
        ]
        if not print_metrics_pass(metrics, max_triangles) or any(not rule["pass"] for rule in rules):
            raise PipelineFailure("PRINT_VALIDATION_FAILED", "; ".join(rule["detail"] for rule in rules if not rule["pass"]))

        bpy.ops.object.select_all(action="DESELECT")
        primary.select_set(True)
        bpy.context.view_layer.objects.active = primary
        bpy.ops.export_scene.gltf(
            filepath=output_path,
            export_format="GLB",
            use_selection=True,
            export_skins=False,
            export_morph=False,
            export_animations=False,
            export_apply=True,
        )
        if not os.path.exists(output_path) or os.path.getsize(output_path) < 20:
            raise PipelineFailure("PRINT_EXPORT_FAILED", "Blender produced no fused print GLB")
        output_size = os.path.getsize(output_path)
        byte_rule = _rule("print_byte_budget", output_size <= max_bytes, f"print output is {output_size} bytes", {"sizeBytes": output_size})
        rules.append(byte_rule)
        if not byte_rule["pass"]:
            raise PipelineFailure("PRINT_OUTPUT_TOO_LARGE", byte_rule["detail"])

        _delete_objects(bpy, [primary])
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=output_path)
        reopened = [obj for obj in bpy.context.scene.objects if obj not in before]
        reopened_meshes = [obj for obj in reopened if obj.type == "MESH"]
        reopened_metrics = _print_topology_metrics(reopened_meshes[0].data) if len(reopened_meshes) == 1 else {
            "objectCount": len(reopened_meshes), "connectedComponents": 0, "triangleCount": 0,
            "nonManifoldEdges": -1, "finiteGeometry": False,
            "volumeCubicMeters": 0.0,
        }
        reopen_pass = reopened_metrics == metrics
        rules.append(_rule("print_glb_reopen", reopen_pass, f"reopened print measurements {reopened_metrics}", reopened_metrics))
        _delete_objects(bpy, reopened)
        if not reopen_pass:
            raise PipelineFailure("PRINT_REOPEN_FAILED", "fused print measurements changed after GLB reopen")
        return {
            "validatorVersion": "rig-pipeline-print-blender-v1",
            "metrics": metrics,
            "rules": rules,
            "overallPass": True,
        }
    finally:
        remaining = []
        for obj in duplicates:
            try:
                if obj and obj.name in bpy.context.scene.objects:
                    remaining.append(obj)
            except ReferenceError:
                continue
        if remaining:
            _delete_objects(bpy, remaining)


def _export_and_reopen(bpy, output_path, expected_bones, source_target_names):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        use_selection=True,
        export_skins=True,
        export_morph=True,
        export_animations=True,
        export_apply=False,
    )
    if not os.path.exists(output_path) or os.path.getsize(output_path) < 20:
        raise PipelineFailure("EXPORT_FAILED", "Blender produced no GLB output")
    _clear_scene(bpy)
    bpy.ops.import_scene.gltf(filepath=output_path)
    meshes = _mesh_objects(bpy)
    armatures = sorted((obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"), key=lambda obj: obj.name)
    output_targets = _source_target_names(meshes)
    bones = {bone.name for armature in armatures for bone in armature.data.bones}
    return {
        "meshCount": len(meshes),
        "armatureCount": len(armatures),
        "bonesPreserved": expected_bones.issubset(bones),
        "targetsPreserved": set(source_target_names).issubset(set(output_targets)),
        "outputTargetNames": output_targets,
        "triangleCount": _triangle_count(meshes) if meshes else 0,
    }


def _run(input_path: str, output_path: str, fused_print_path: str, config: dict) -> dict:
    import bpy

    request = config["request"]
    profile = config["profile"]
    budgets = request["budgets"]
    _clear_scene(bpy)
    bpy.ops.import_scene.gltf(filepath=input_path)
    meshes = _mesh_objects(bpy)
    if not meshes:
        raise PipelineFailure("NO_MESH", "GLB contains no mesh objects")

    minimum, maximum = _world_bounds(meshes)
    dimensions = [maximum[axis] - minimum[axis] for axis in range(3)]
    triangles = _triangle_count(meshes)
    source_targets = _source_target_names(meshes)
    semantic_regions = _semantic_regions(meshes)
    required_bones = set(profile["joints"])
    armatures = sorted((obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"), key=lambda obj: obj.name)
    source_armature = armatures[0] if len(armatures) == 1 else None
    existing_valid, existing_detail = _validate_existing_armature(meshes, source_armature, required_bones)
    warnings = []
    if source_armature and not existing_valid:
        raise PipelineFailure("INVALID_EXISTING_RIG", existing_detail)
    armature = source_armature if existing_valid else _author_armature(bpy, meshes, profile, minimum, maximum)

    actual_bones = {bone.name for bone in armature.data.bones}
    weight_metrics = _weight_metrics(meshes, armature, budgets["maxInfluences"])
    pose = _pose_sweep(bpy, meshes, armature)
    non_manifold = _non_manifold_count(meshes)
    bind_matrix_valid = _finite_bind_matrices(armature)
    animation_sweep_pass = (
        pose["finite"]
        and 1e-8 < pose["maxDisplacement"] <= max(dimensions) * 0.5
        and pose["silhouetteDeviation"] <= 0.35
        and pose["minimumBoundsVolumeRatio"] >= 0.5
    )
    has_eye_controls = bool(armature.data.bones.get("eye.L") and armature.data.bones.get("eye.R"))
    finite_bounds = all(math.isfinite(value) for value in minimum + maximum) and all(value > 0 for value in dimensions)
    hierarchy_errors = []
    for name in required_bones:
        expected_parent = PARENT_BY_BONE.get(name)
        bone = armature.data.bones.get(name)
        if expected_parent in required_bones and (bone is None or bone.parent is None or bone.parent.name != expected_parent):
            hierarchy_errors.append(name)
    hierarchy_ok = not hierarchy_errors
    rig_rules = [
        _rule("finite_source_bounds", finite_bounds, f"measured dimensions {[round(value, 8) for value in dimensions]}", {"dimensionsMeters": dimensions}),
        _rule("triangle_budget", triangles <= budgets["maxTriangles"], f"measured {triangles} triangles", {"triangles": triangles}),
        _rule("topology_manifold", non_manifold == 0, f"measured {non_manifold} non-manifold boundary edges", {"nonManifoldEdges": non_manifold}),
        _rule("required_bones", required_bones.issubset(actual_bones), f"{len(required_bones & actual_bones)}/{len(required_bones)} required bones present"),
        _rule("joint_budget", len(actual_bones) <= budgets["maxJoints"], f"measured {len(actual_bones)} joints", {"joints": len(actual_bones)}),
        _rule("parent_hierarchy", hierarchy_ok, "canonical hierarchy intact" if hierarchy_ok else f"invalid parents: {', '.join(sorted(hierarchy_errors))}"),
        _rule("unique_bone_names", len(actual_bones) == len(armature.data.bones), f"{len(actual_bones)} unique bones"),
        _rule("finite_inverse_bind", bind_matrix_valid, "all rest matrices contain finite values"),
        _rule("bounded_influences", weight_metrics["overInfluenced"] == 0, f"{weight_metrics['overInfluenced']} vertices exceed {budgets['maxInfluences']} influences", weight_metrics),
        _rule("weighted_coverage", weight_metrics["coverage"] >= 0.999, f"weighted coverage {weight_metrics['coverage']:.3%}", weight_metrics),
        _rule("pose_sweep", animation_sweep_pass, f"{pose['poseCount']} poses across {len(pose['bones'])} bones produced {pose['maxDisplacement']:.8g} m displacement, {pose['silhouetteDeviation']:.5g} silhouette deviation, and {pose['minimumBoundsVolumeRatio']:.5g} minimum bounds-volume ratio", pose),
    ]

    requested = request["requestedFacialTargets"] if request["requestFacial"] else []
    authored = set()
    head_size = _head_size(meshes, semantic_regions)
    if requested:
        authored = _author_missing_targets(meshes, semantic_regions, requested, head_size)
    measurements = _target_measurements(meshes, semantic_regions, head_size, authored)
    capability = facial_capability(measurements, requested) if requested else "body_only"
    facial_rules = []
    renders = []
    if not requested:
        facial_rules.append(_rule("facial_not_requested", True, "facial authoring was not requested"))
    elif capability == "body_only":
        facial_rules.append(_rule(
            "safe_body_only_fallback",
            True,
            f"no facial targets were accepted: head={_region_size(semantic_regions, 'head')} mouth={_region_size(semantic_regions, 'mouth')} eyes={_region_size(semantic_regions, 'eye_left')}/{_region_size(semantic_regions, 'eye_right')} tongue={_region_size(semantic_regions, 'tongue')}",
        ))
        warnings.append("Facial localization or measured deformation was insufficient; no facial targets were fabricated and the result is body-only.")
    else:
        passing_targets = [target for target in measurements if target["deformationPass"] and target["localityPass"]]
        passing = {target["canonicalName"] for target in passing_targets}
        facial_rules.append(_rule("localized_deformation", bool(passing_targets), f"{len(passing_targets)} targets passed finite, bounded, localized deformation"))
        facial_rules.append(_rule("capability_matches_measurements", capability in ("full", "partial"), f"measured capability is {capability}"))
        facial_rules.append(_rule("neutral_restoration", True, "targets were measured independently from Basis with no accumulated weights"))
        preferred = next((target["name"] for target in passing_targets if target["canonicalName"] == "D"), passing_targets[0]["name"])
        facial_bounds = _region_world_bounds(meshes, semantic_regions, "head")
        render_minimum, render_maximum = facial_bounds if facial_bounds else (minimum, maximum)
        renders, render_detail = _render_evidence(bpy, meshes, render_minimum, render_maximum, 40 * 1024 * 1024, preferred)
        facial_rules.append(_rule("facial_render_evidence", len(renders) == 2, render_detail, {"renderCount": len(renders), "target": preferred}))
        missing = sorted(set(requested) - passing)
        if missing:
            warnings.append(f"Facial output is partial; requested targets without accepted deformation: {', '.join(missing)}")

    accessory_results, accessory_rules, accessory_meshes = _fit_accessories(
        bpy,
        meshes,
        armature,
        config.get("accessoryPaths", []),
        max(dimensions),
        budgets["maxTriangles"],
    )
    rig_rules.extend(accessory_rules)
    fused_print = None
    fused_print_failure = None
    if accessory_meshes:
        try:
            fused_print = _build_fused_print(
                bpy,
                armature,
                meshes,
                accessory_meshes,
                fused_print_path,
                budgets["maxTriangles"],
                8 * 1024 * 1024,
            )
        except PipelineFailure as error:
            fused_print_failure = {"code": error.code if error.code.startswith("PRINT_") else "PRINT_FUSION_FAILED", "message": str(error)[:500]}
            warnings.append(f"Print-ready accessory fusion was omitted: {error}")
    output_meshes = _mesh_objects(bpy)
    output_triangles = _triangle_count(output_meshes)
    texture_max = _texture_max_dimension(output_meshes)
    rig_rules.append(_rule("total_triangle_budget", output_triangles <= budgets["maxTriangles"], f"output has {output_triangles} triangles", {"triangles": output_triangles}))
    rig_rules.append(_rule("texture_dimension_budget", texture_max <= budgets["maxTextureDimension"], f"largest texture dimension is {texture_max}px", {"pixels": texture_max}))

    expected_bones = set(actual_bones)
    reopen = _export_and_reopen(bpy, output_path, expected_bones, source_targets)
    output_size = os.path.getsize(output_path)
    rig_rules.append(_rule("glb_reopen", reopen["meshCount"] > 0 and reopen["armatureCount"] == 1 and reopen["bonesPreserved"] and reopen["targetsPreserved"], f"reopened {reopen['meshCount']} meshes, {reopen['armatureCount']} armatures; bones={reopen['bonesPreserved']} targets={reopen['targetsPreserved']}", reopen))
    rig_rules.append(_rule("output_byte_budget", output_size <= 100 * 1024 * 1024, f"output is {output_size} bytes", {"sizeBytes": output_size}))

    if source_targets and not reopen["targetsPreserved"]:
        warnings.append("Source morph target preservation failed; output cannot be accepted.")
    rig_pass = all(rule["pass"] for rule in rig_rules)
    result = {
        "algorithmVersion": PIPELINE_ALGORITHM_VERSION,
        "sourceTargetNames": source_targets,
        "outputTargetNames": reopen["outputTargetNames"],
        "rig": {
            "metrics": {
                "boneCount": len(actual_bones),
                "skinnedVertexCount": weight_metrics["weightedVertices"],
                "maxInfluences": weight_metrics["maxInfluences"],
                "unweightedIslands": weight_metrics["unweightedIslands"],
                "bindMatrixValid": bind_matrix_valid,
                "animationSweepPass": animation_sweep_pass,
                "silhouetteDeviation": pose["silhouetteDeviation"],
                "triangleCount": output_triangles,
                "textureMaxDimension": texture_max,
                "jointCount": len(actual_bones),
                "boneNames": sorted(actual_bones),
            },
            "rules": rig_rules,
            "overallPass": rig_pass,
        },
        "facial": {
            "capability": capability if rig_pass else "unsupported",
            "targets": measurements,
            "hasEyeControls": has_eye_controls,
            "rules": facial_rules,
        },
        "renders": renders,
        "accessories": accessory_results,
        "warnings": warnings,
    }
    if fused_print is not None:
        result["fusedPrint"] = fused_print
    elif fused_print_failure is not None:
        result["fusedPrintFailure"] = fused_print_failure
    return result


def run_pipeline(input_path: str, output_path: str, fused_print_path: str, config_path: str, result_path: str) -> None:
    """Run once and always write a bounded typed result for the Node boundary."""
    try:
        config = json.loads(Path(config_path).read_text(encoding="utf-8"))
        result = _run(input_path, output_path, fused_print_path, config)
    except PipelineFailure as error:
        result = {"failure": {"code": error.code, "message": str(error)[:500]}}
    except Exception as error:
        result = {
            "failure": {
                "code": "BLENDER_PIPELINE_FAILED",
                "message": str(error)[:500],
                "trace": traceback.format_exc(limit=8)[-2000:],
            }
        }
    Path(result_path).write_text(json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False), encoding="utf-8")
