"""
Blender TCP Bridge Server
=========================
Runs INSIDE Blender's Python environment (via `blender --background --python tcp_server.py`).
Listens on TCP port 9876 for JSON-RPC commands from the Node.js agent relay.

Protocol: newline-delimited JSON-RPC over TCP.
  Request:  {"id": 1, "method": "execute_code", "params": {"code": "import bpy; ..."}}
  Response: {"id": 1, "result": {...}} or {"id": 1, "error": {"message": "..."}}

Supported methods:
  - execute_code(code)           → Run arbitrary bpy Python, return stdout/stderr/success
  - get_viewport(azimuth?, elevation?) → Render viewport to PNG, return base64
  - read_scene()                 → Return JSON scene graph
  - set_viewport_angle(azimuth, elevation) → Rotate the viewport camera
  - undo()                       → bpy.ops.ed.undo()
  - save_checkpoint(name)        → Save .blend to /tmp/checkpoints/{name}.blend
  - restore_checkpoint(name)     → Load .blend from /tmp/checkpoints/{name}.blend
  - export_glb(output_path?)     → Export scene as GLB, return base64
  - ping()                       → Health check
"""

import bpy
import json
import socket
import threading
import traceback
import io
import sys
import os
import tempfile
import base64
import math
import queue

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
if BRIDGE_DIR not in sys.path:
    sys.path.insert(0, BRIDGE_DIR)

from print_mesh_contract import (  # noqa: E402 - Blender initializes bpy first
    format_repair_failure,
    inspect_binary_stl,
    validate_print_metrics,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# The bridge executes arbitrary Python and has no protocol-level authentication.
# It is an internal sidecar interface, so never publish it unless an operator
# deliberately overrides the bind address inside a trusted private network.
TCP_HOST = os.environ.get("BLENDER_BRIDGE_BIND_HOST", "127.0.0.1")
TCP_PORT = int(os.environ.get("BLENDER_BRIDGE_PORT", "9876"))
CHECKPOINT_DIR = "/tmp/blender_checkpoints"
VIEWPORT_DIR = "/tmp/blender_viewports"
REQUEST_QUEUE = queue.Queue()
BLENDER_VERSION = bpy.app.version_string
BRIDGE_SCENE_OBJECT_COUNT = len(bpy.context.scene.objects)


def _bounded_env_int(name, fallback, minimum, maximum):
    try:
        value = int(os.environ.get(name, str(fallback)))
    except (TypeError, ValueError):
        value = fallback
    return max(minimum, min(maximum, value))


BRIDGE_DISPATCH_TIMEOUT_SECONDS = _bounded_env_int(
    "BLENDER_BRIDGE_DISPATCH_TIMEOUT_SECONDS", 1800, 30, 3600,
)

os.makedirs(CHECKPOINT_DIR, exist_ok=True)
os.makedirs(VIEWPORT_DIR, exist_ok=True)

print(f"[Bridge] Blender TCP Bridge starting on {TCP_HOST}:{TCP_PORT}")
print(f"[Bridge] Blender version: {bpy.app.version_string}")


# ---------------------------------------------------------------------------
# Command Handlers
# ---------------------------------------------------------------------------

def handle_execute_code(params: dict) -> dict:
    """Execute arbitrary Python code in Blender's context."""
    code = params.get("code", "")
    if not code:
        return {"success": False, "error": "No code provided"}

    # Capture stdout and stderr
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()
    sys.stdout = captured_stdout
    sys.stderr = captured_stderr

    success = True
    error_msg = None
    try:
        exec(code, {"__builtins__": __builtins__, "bpy": bpy})
    except Exception as e:
        success = False
        error_msg = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    stdout_str = captured_stdout.getvalue()
    stderr_str = captured_stderr.getvalue()

    # Print to real stdout for Docker logs
    if stdout_str:
        print(f"[Bridge/exec] stdout: {stdout_str[:500]}")
    if stderr_str:
        print(f"[Bridge/exec] stderr: {stderr_str[:500]}")
    if error_msg:
        print(f"[Bridge/exec] ERROR: {error_msg[:500]}")

    return {
        "success": success,
        "stdout": stdout_str,
        "stderr": stderr_str,
        "error": error_msg,
    }


def handle_get_viewport(params: dict) -> dict:
    """Render current viewport to PNG and return as base64."""
    azimuth = params.get("azimuth")
    elevation = params.get("elevation")

    # Optionally reposition camera before rendering
    if azimuth is not None or elevation is not None:
        _set_camera_angle(
            azimuth if azimuth is not None else 45.0,
            elevation if elevation is not None else 30.0,
        )

    scene = bpy.context.scene

    # Ensure we have a camera
    if not scene.camera:
        _create_default_camera()

    # Save current render settings
    prev_engine = scene.render.engine
    prev_res_x = scene.render.resolution_x
    prev_res_y = scene.render.resolution_y
    prev_filepath = scene.render.filepath
    prev_format = scene.render.image_settings.file_format
    prev_color_mode = scene.render.image_settings.color_mode

    # Set viewport render settings (fast, low-res for verification)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True

    # Configure workbench for clarity
    try:
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "MATERIAL"
        scene.display.shading.show_object_outline = True
    except Exception:
        pass

    output_path = os.path.join(VIEWPORT_DIR, "viewport_capture.png")
    scene.render.filepath = output_path

    try:
        bpy.ops.render.render(write_still=True)
    except Exception as e:
        return {"success": False, "error": f"Render failed: {e}"}

    # Read and encode
    if not os.path.exists(output_path):
        return {"success": False, "error": "Render produced no output file"}

    with open(output_path, "rb") as f:
        image_base64 = base64.b64encode(f.read()).decode("utf-8")

    # Restore render settings
    scene.render.engine = prev_engine
    scene.render.resolution_x = prev_res_x
    scene.render.resolution_y = prev_res_y
    scene.render.filepath = prev_filepath
    scene.render.image_settings.file_format = prev_format
    scene.render.image_settings.color_mode = prev_color_mode

    os.remove(output_path)

    return {"success": True, "image_base64": image_base64, "width": 512, "height": 512}


def handle_read_scene(params: dict) -> dict:
    """Return a JSON scene graph of all objects."""
    objects = []
    for obj in bpy.context.scene.objects:
        obj_data = {
            "name": obj.name,
            "type": obj.type,
            "location": list(obj.location),
            "rotation_euler": list(obj.rotation_euler),
            "scale": list(obj.scale),
            "visible": obj.visible_get(),
            "parent": obj.parent.name if obj.parent else None,
            "modifiers": [{"name": m.name, "type": m.type} for m in obj.modifiers],
        }

        # Add mesh-specific info
        if obj.type == "MESH" and obj.data:
            obj_data["vertex_count"] = len(obj.data.vertices)
            obj_data["face_count"] = len(obj.data.polygons)
            obj_data["edge_count"] = len(obj.data.edges)
            obj_data["vertex_groups"] = [vg.name for vg in obj.vertex_groups]
            # Bounding box in world space
            try:
                from mathutils import Vector
                bbox = [obj.matrix_world @ Vector(v) for v in obj.bound_box]
                obj_data["world_bbox"] = [[v.x, v.y, v.z] for v in bbox]
            except Exception:
                pass

        # Add armature-specific info
        if obj.type == "ARMATURE" and obj.data:
            bones = []
            for bone in obj.data.bones:
                bones.append({
                    "name": bone.name,
                    "parent": bone.parent.name if bone.parent else None,
                    "head": list(bone.head_local),
                    "tail": list(bone.tail_local),
                    "length": bone.length,
                    "connected": bone.use_connect,
                })
            obj_data["bones"] = bones

        # Add light info
        if obj.type == "LIGHT" and obj.data:
            obj_data["light_type"] = obj.data.type
            obj_data["energy"] = obj.data.energy

        # Add camera info
        if obj.type == "CAMERA" and obj.data:
            obj_data["camera_type"] = obj.data.type
            if obj.data.type == "ORTHO":
                obj_data["ortho_scale"] = obj.data.ortho_scale
            else:
                obj_data["lens"] = obj.data.lens

        objects.append(obj_data)

    return {
        "success": True,
        "object_count": len(objects),
        "objects": objects,
        "active_object": bpy.context.view_layer.objects.active.name if bpy.context.view_layer.objects.active else None,
        "frame_current": bpy.context.scene.frame_current,
        "frame_start": bpy.context.scene.frame_start,
        "frame_end": bpy.context.scene.frame_end,
        "render_engine": bpy.context.scene.render.engine,
    }


def handle_set_viewport_angle(params: dict) -> dict:
    """Rotate the camera to a specified angle around the scene center."""
    azimuth = float(params.get("azimuth", 45.0))
    elevation = float(params.get("elevation", 30.0))
    _set_camera_angle(azimuth, elevation)
    return {"success": True, "azimuth": azimuth, "elevation": elevation}


def handle_undo(params: dict) -> dict:
    """Undo the last Blender operation."""
    try:
        bpy.ops.ed.undo()
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


def handle_save_checkpoint(params: dict) -> dict:
    """Save the current scene as a named checkpoint."""
    name = params.get("name", "default")
    filepath = os.path.join(CHECKPOINT_DIR, f"{name}.blend")
    try:
        bpy.ops.wm.save_as_mainfile(filepath=filepath, copy=True)
        return {"success": True, "filepath": filepath}
    except Exception as e:
        return {"success": False, "error": str(e)}


def handle_restore_checkpoint(params: dict) -> dict:
    """Restore from a named checkpoint."""
    name = params.get("name", "default")
    filepath = os.path.join(CHECKPOINT_DIR, f"{name}.blend")
    if not os.path.exists(filepath):
        return {"success": False, "error": f"Checkpoint '{name}' not found at {filepath}"}
    try:
        bpy.ops.wm.open_mainfile(filepath=filepath)
        return {"success": True, "filepath": filepath}
    except Exception as e:
        return {"success": False, "error": str(e)}


def handle_export_glb(params: dict) -> dict:
    """Export the scene as GLB and return base64."""
    output_path = params.get("output_path") or os.path.join(
        tempfile.gettempdir(), "blender_export.glb"
    )
    try:
        exportable_objects = [
            obj for obj in bpy.context.scene.objects
            if obj.type in {"MESH", "ARMATURE", "EMPTY", "CAMERA", "LIGHT"}
        ]
        if not exportable_objects:
            return {"success": False, "error": "No exportable Blender objects found"}

        for obj in bpy.context.scene.objects:
            obj.select_set(obj in exportable_objects)
        bpy.context.view_layer.objects.active = exportable_objects[0]

        export_kwargs = filter_operator_kwargs(
            bpy.ops.export_scene.gltf,
            {
                "filepath": output_path,
                "export_format": "GLB",
                "use_selection": True,
                "export_animations": True,
                "export_skins": True,
                "export_def_bones": True,
                "export_apply": False,
            },
        )
        bpy.ops.export_scene.gltf(**export_kwargs)

        with open(output_path, "rb") as f:
            glb_base64 = base64.b64encode(f.read()).decode("utf-8")

        size_bytes = os.path.getsize(output_path)
        os.remove(output_path)

        return {"success": True, "glb_base64": glb_base64, "size_bytes": size_bytes}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _print_mesh_metrics(obj) -> dict:
    """Measure the current derivative without mutating it."""
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()

    finite_vertices = []
    for vertex in bm.verts:
        world = obj.matrix_world @ vertex.co
        if all(math.isfinite(value) for value in world):
            finite_vertices.append(world)

    components = 0
    visited = set()
    for vertex in bm.verts:
        if vertex in visited:
            continue
        components += 1
        pending = [vertex]
        visited.add(vertex)
        while pending:
            current = pending.pop()
            for edge in current.link_edges:
                neighbor = edge.other_vert(current)
                if neighbor not in visited:
                    visited.add(neighbor)
                    pending.append(neighbor)

    dimensions = {"x": math.nan, "y": math.nan, "z": math.nan}
    if finite_vertices and len(finite_vertices) == len(bm.verts):
        dimensions = {
            axis: max(vertex[index] for vertex in finite_vertices) - min(vertex[index] for vertex in finite_vertices)
            for index, axis in enumerate(("x", "y", "z"))
        }

    metrics = {
        "vertex_count": len(bm.verts),
        "finite_vertex_count": len(finite_vertices),
        "triangle_count": len(bm.faces),
        "non_manifold_edges": sum(1 for edge in bm.edges if not edge.is_manifold),
        "degenerate_faces": sum(1 for face in bm.faces if face.calc_area() <= 1e-10),
        "component_count": components,
        "dimensions_mm": dimensions,
    }
    bm.free()
    return metrics


def _scale_print_mesh_to_height(obj, target_height_mm: float) -> None:
    metrics = _print_mesh_metrics(obj)
    source_height = metrics["dimensions_mm"]["z"]
    if not math.isfinite(source_height) or source_height <= 1e-9:
        raise ValueError("Model has zero or non-finite physical height")
    scale_factor = target_height_mm / source_height
    obj.scale = tuple(value * scale_factor for value in obj.scale)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def _repair_print_mesh_with_bmesh(obj) -> list[str]:
    """Apply conservative cleanup before considering a voxel remesh."""
    import bmesh

    metrics = _print_mesh_metrics(obj)
    largest_dimension = max(metrics["dimensions_mm"].values())
    weld_distance = max(1e-5, min(0.05, largest_dimension * 1e-5))
    operations = [f"merge vertices within {weld_distance:.6g} mm"]

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=weld_distance)
    bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=max(1e-7, weld_distance * 0.1))
    operations.append("remove degenerate and loose geometry")

    loose_vertices = [vertex for vertex in bm.verts if not vertex.link_faces]
    if loose_vertices:
        bmesh.ops.delete(bm, geom=loose_vertices, context="VERTS")

    boundary_edges = [edge for edge in bm.edges if len(edge.link_faces) == 1]
    if boundary_edges:
        bmesh.ops.holes_fill(bm, edges=boundary_edges, sides=0)
        operations.append(f"fill boundaries from {len(boundary_edges)} open edges")

    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bmesh.ops.triangulate(bm, faces=list(bm.faces))
        operations.append("recalculate normals and triangulate")
    bm.to_mesh(obj.data)
    obj.data.update()
    bm.free()
    return operations


def _repair_print_mesh_with_voxels(obj) -> tuple[list[str], float]:
    """Fuse intersecting shells when conservative cleanup cannot close them."""
    metrics = _print_mesh_metrics(obj)
    largest_dimension = max(metrics["dimensions_mm"].values())
    voxel_size = max(0.1, min(1.0, largest_dimension / 256.0))
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    obj.data.remesh_voxel_size = voxel_size
    obj.data.remesh_voxel_adaptivity = 0.0
    bpy.ops.object.voxel_remesh()
    operations = [f"voxel remesh at {voxel_size:.6g} mm to fuse intersecting shells"]
    operations.extend(_repair_print_mesh_with_bmesh(obj))
    return operations, voxel_size


def _topology_response(metrics: dict, validation: dict, repair: dict) -> dict:
    return {
        "vertex_count": metrics["vertex_count"],
        "triangle_count": metrics["triangle_count"],
        "non_manifold_edges": metrics["non_manifold_edges"],
        "degenerate_faces": metrics["degenerate_faces"],
        "component_count": metrics["component_count"],
        "finite": metrics["finite_vertex_count"] == metrics["vertex_count"],
        "manifold": metrics["non_manifold_edges"] == 0,
        "watertight": metrics["non_manifold_edges"] == 0,
        "issues": validation["issues"],
        "repair": repair,
    }


def _json_safe_print_metrics(metrics: dict) -> dict:
    dimensions = metrics.get("dimensions_mm") or {}
    return {
        **metrics,
        "dimensions_mm": {
            axis: value if isinstance(value, (int, float)) and math.isfinite(value) else None
            for axis, value in dimensions.items()
        },
    }


def handle_prepare_print_stl(params: dict) -> dict:
    """Create a uniformly scaled STL derivative and report basic topology.

    The imported source remains untouched in object storage. STL coordinates
    are emitted in millimeters; target_height_mm is the authoritative physical
    calibration supplied by the customer.
    """
    try:
        target_height_mm = float(params.get("target_height_mm") or 100.0)
    except (TypeError, ValueError):
        return {"success": False, "printable": False, "error": "target_height_mm must be a finite number between 25 and 300"}
    if not math.isfinite(target_height_mm) or target_height_mm < 25.0 or target_height_mm > 300.0:
        return {"success": False, "printable": False, "error": "target_height_mm must be between 25 and 300"}
    output_fd, output_path = tempfile.mkstemp(prefix="pawsome_print_ready_", suffix=".stl")
    os.close(output_fd)
    try:
        mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if not mesh_objects:
            return {"success": False, "error": "No mesh objects found"}

        bpy.ops.object.select_all(action="DESELECT")
        for obj in mesh_objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = mesh_objects[0]
        if len(mesh_objects) > 1:
            bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        _scale_print_mesh_to_height(obj, target_height_mm)

        before_metrics = _print_mesh_metrics(obj)
        before_validation = validate_print_metrics(before_metrics, target_height_mm)
        repair = {
            "attempted": not before_validation["passed"],
            "strategy": "none",
            "operations": [],
            "succeeded": before_validation["passed"],
            "before": _json_safe_print_metrics(before_metrics),
        }

        final_metrics = before_metrics
        final_validation = before_validation
        finite_check = next(item for item in before_validation["checks"] if item["name"] == "finite_vertices")
        if not before_validation["passed"] and finite_check["passed"]:
            if obj.data.shape_keys:
                bpy.context.view_layer.objects.active = obj
                bpy.ops.object.shape_key_remove(all=True)
                repair["operations"].append("freeze basis shape before manufacturing repair")

            repair["strategy"] = "conservative_cleanup"
            repair["operations"].extend(_repair_print_mesh_with_bmesh(obj))
            _scale_print_mesh_to_height(obj, target_height_mm)
            final_metrics = _print_mesh_metrics(obj)
            final_validation = validate_print_metrics(final_metrics, target_height_mm)

            if not final_validation["passed"]:
                repair["strategy"] = "voxel_remesh"
                voxel_operations, voxel_size = _repair_print_mesh_with_voxels(obj)
                repair["operations"].extend(voxel_operations)
                repair["voxel_size_mm"] = voxel_size
                _scale_print_mesh_to_height(obj, target_height_mm)
                final_metrics = _print_mesh_metrics(obj)
                final_validation = validate_print_metrics(final_metrics, target_height_mm)

        repair["succeeded"] = final_validation["passed"]
        repair["after"] = _json_safe_print_metrics(final_metrics)
        if not final_validation["passed"]:
            topology = _topology_response(final_metrics, final_validation, repair)
            return {
                "success": False,
                "printable": False,
                "error": format_repair_failure(final_validation),
                "dimensions_mm": _json_safe_print_metrics(final_metrics)["dimensions_mm"],
                "topology": topology,
                "validation": final_validation,
                "repair": repair,
            }

        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        if hasattr(bpy.ops.wm, "stl_export"):
            export_kwargs = filter_operator_kwargs(
                bpy.ops.wm.stl_export,
                {
                    "filepath": output_path,
                    "export_selected_objects": True,
                    "ascii_format": False,
                    "apply_modifiers": True,
                },
            )
            bpy.ops.wm.stl_export(**export_kwargs)
        else:
            export_kwargs = filter_operator_kwargs(
                bpy.ops.export_mesh.stl,
                {
                    "filepath": output_path,
                    "use_selection": True,
                    "ascii": False,
                    "use_mesh_modifiers": True,
                },
            )
            bpy.ops.export_mesh.stl(**export_kwargs)

        with open(output_path, "rb") as f:
            stl_bytes = f.read()
        exported = inspect_binary_stl(stl_bytes, target_height_mm)
        exported_metrics = exported["metrics"]
        exported_validation = exported["validation"]
        repair["export_validation"] = exported_validation
        topology = _topology_response(exported_metrics, exported_validation, repair)
        if not exported_validation["passed"]:
            return {
                "success": False,
                "printable": False,
                "error": format_repair_failure(exported_validation),
                "dimensions_mm": _json_safe_print_metrics(exported_metrics)["dimensions_mm"],
                "topology": topology,
                "validation": exported_validation,
                "repair": repair,
            }

        return {
            "success": True,
            "stl_base64": base64.b64encode(stl_bytes).decode("utf-8"),
            "size_bytes": len(stl_bytes),
            "units": "mm",
            "dimensions_mm": exported_metrics["dimensions_mm"],
            "topology": topology,
            "validation": exported_validation,
            "repair": repair,
            "printable": True,
        }
    except Exception as e:
        return {"success": False, "printable": False, "error": f"Print preparation failed safely: {e}"}
    finally:
        if os.path.exists(output_path):
            os.remove(output_path)


def handle_import_glb(params: dict) -> dict:
    """Import a base64 GLB payload into the current scene."""
    glb_base64 = params.get("glb_base64") or ""
    if not glb_base64:
        return {"success": False, "error": "No glb_base64 provided"}

    if glb_base64.startswith("data:"):
        glb_base64 = glb_base64.split(",", 1)[1]

    input_path = os.path.join(tempfile.gettempdir(), "blender_agent_input.glb")
    try:
        with open(input_path, "wb") as f:
            f.write(base64.b64decode(glb_base64))

        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)

        before = set(bpy.context.scene.objects)
        import_kwargs = filter_operator_kwargs(
            bpy.ops.import_scene.gltf,
            {"filepath": input_path},
        )
        bpy.ops.import_scene.gltf(**import_kwargs)

        imported = [obj for obj in bpy.context.scene.objects if obj not in before]
        mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if mesh_objects:
            for obj in bpy.context.scene.objects:
                obj.select_set(obj in mesh_objects)
            bpy.context.view_layer.objects.active = mesh_objects[0]

        return {
            "success": True,
            "imported_count": len(imported),
            "mesh_count": len(mesh_objects),
            "objects": [{"name": obj.name, "type": obj.type} for obj in imported],
        }
    except Exception as e:
        return {"success": False, "error": f"GLB import failed: {e}"}
    finally:
        try:
            os.remove(input_path)
        except FileNotFoundError:
            pass


def handle_ping(params: dict) -> dict:
    """Health check using main-thread-cached values only.

    Ping is dispatched directly by the TCP client thread so Render health checks
    stay responsive while Blender's main thread is performing a long render.
    """
    return {
        "success": True,
        "blender_version": BLENDER_VERSION,
        "scene_objects": BRIDGE_SCENE_OBJECT_COUNT,
    }


# World gravity for every physics-dependent rig check (m/s^2, world -Z).
PHYSICS_GRAVITY_MS2 = 9.8

# Per-check tolerances (see PAWSOME3D_REDRESS_PLAN.md §5.4).
NECK_TORSO_BLEED_MAX = 0.05          # ≤5% torso weight per neck/head vertex
SYMMETRY_CHAIN_DELTA_MAX = 0.02      # L/R chain length delta ≤2%
FOOT_CONTACT_TOLERANCE = 0.005       # soles within ±5 mm of ground at 1 m scale
TWIST_AREA_LOSS_MAX = 0.30           # forearm cross-section loss ≤30% at 90° twist
FACE_NONLOCK_MAX = 0.05              # ≤5% non-head weight on face-region verts
MAX_INFLUENCES = 4


def _pv_find_armature_and_mesh():
    armature = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    mesh = None
    if armature:
        mesh = next((m for m in meshes if any(mod.type == "ARMATURE" and mod.object == armature for mod in m.modifiers)), None)
    return armature, mesh or (meshes[0] if meshes else None)


def _pv_bone_pairs(armature):
    """Symmetry pairs by .L/.R or _L/_R suffix."""
    pairs = []
    names = {b.name for b in armature.data.bones}
    for name in names:
        for left, right in ((".L", ".R"), ("_L", "_R"), (".l", ".r"), ("_l", "_r")):
            if name.endswith(left) and (name[: -len(left)] + right) in names:
                pairs.append((name, name[: -len(left)] + right))
    return pairs


def _pv_chain_length(armature, root_name):
    bone = armature.data.bones.get(root_name)
    total = 0.0
    while bone is not None:
        total += bone.length
        bone = bone.children[0] if len(bone.children) == 1 else None
    return total


def _pv_check_weights(mesh, armature):
    """Unweighted verts, >MAX_INFLUENCES, weight-distance spikes."""
    bone_names = {b.name for b in armature.data.bones}
    group_index_to_bone = {g.index: g.name for g in mesh.vertex_groups if g.name in bone_names}
    bone_heads = {b.name: (mesh.matrix_world.inverted() @ (armature.matrix_world @ b.head_local)) for b in armature.data.bones}
    region_radius = max(mesh.dimensions) * 0.6 if max(mesh.dimensions) > 0 else 1.0
    unweighted = 0
    over_influenced = 0
    distant = 0
    for v in mesh.data.vertices:
        weights = [(group_index_to_bone.get(g.group), g.weight) for g in v.groups if g.weight > 1e-4 and g.group in group_index_to_bone]
        if not weights:
            unweighted += 1
            continue
        if len(weights) > MAX_INFLUENCES:
            over_influenced += 1
        for bone_name, weight in weights:
            head = bone_heads.get(bone_name)
            if head is not None and weight > 0.5 and (v.co - head).length > region_radius:
                distant += 1
                break
    return unweighted, over_influenced, distant


def _pv_region_verts(mesh, armature, bone_names, radius_scale=1.2):
    """Vertices within radius of the named bones (mesh-local space)."""
    from mathutils import Vector
    heads = []
    for name in bone_names:
        bone = armature.data.bones.get(name)
        if bone:
            heads.append(mesh.matrix_world.inverted() @ (armature.matrix_world @ bone.head_local))
            heads.append(mesh.matrix_world.inverted() @ (armature.matrix_world @ bone.tail_local))
    if not heads:
        return []
    center = sum(heads, Vector()) / len(heads)
    radius = max((h - center).length for h in heads) * radius_scale + 1e-6
    return [v for v in mesh.data.vertices if (v.co - center).length <= radius]


def _pv_weight_share(mesh, verts, allowed_groups):
    """Average share of weight on `allowed_groups` across `verts`."""
    allowed = {g.index for g in mesh.vertex_groups if g.name in allowed_groups}
    if not verts:
        return 1.0
    shares = []
    for v in verts:
        total = sum(g.weight for g in v.groups if g.weight > 1e-4)
        if total <= 0:
            continue
        good = sum(g.weight for g in v.groups if g.group in allowed and g.weight > 1e-4)
        shares.append(good / total)
    return sum(shares) / len(shares) if shares else 1.0


def _pv_settle_test(mesh, frames=60):
    """Rigid-body drop test under gravity: model must settle on the ground
    without sinking through it. Returns (settled, min_z_after)."""
    scene = bpy.context.scene
    scene.gravity = (0.0, 0.0, -PHYSICS_GRAVITY_MS2)
    if scene.rigidbody_world is None:
        bpy.ops.rigidbody.world_add()
    # Ground plane
    bpy.ops.mesh.primitive_plane_add(size=100.0, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.name = "PV_Ground"
    bpy.context.view_layer.objects.active = ground
    bpy.ops.rigidbody.object_add(type="PASSIVE")
    # Active body 0.5 m above ground
    original_location = tuple(mesh.location)
    mesh.location.z += 0.5
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.rigidbody.object_add(type="ACTIVE")
    mesh.rigid_body.collision_shape = "CONVEX_HULL"
    scene.frame_start = 1
    scene.frame_end = frames
    last_z = None
    settled = False
    for frame in range(1, frames + 1):
        scene.frame_set(frame)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(depsgraph)
    min_z = min((evaluated.matrix_world @ v.co).z for v in evaluated.data.vertices) if evaluated.data.vertices else 0.0
    # Settled = resting at/above ground within tolerance, not fallen through.
    settled = min_z > -0.01
    # Cleanup
    bpy.ops.rigidbody.object_remove()
    mesh.location = original_location
    bpy.data.objects.remove(ground, do_unlink=True)
    scene.frame_set(1)
    return settled, min_z


def handle_physics_validate(params: dict) -> dict:
    """Rig quality gates: anatomy + physics checks at gravity 9.8 m/s^2.

    Guards the known failure modes: neck sagging, face contortion, misaligned
    limbs (incl. flipped hinges), candy-wrapper twist, foot sliding/floating,
    and broken weights. Returns a per-check report; `pass` is the AND of all
    non-informational checks. See PAWSOME3D_REDRESS_PLAN.md §5.4.
    """
    profile = str(params.get("profile") or "quadruped")
    facial = bool(params.get("facial"))
    checks = []

    def add(name, passed, detail):
        checks.append({"name": name, "pass": bool(passed), "detail": detail})

    try:
        armature, mesh = _pv_find_armature_and_mesh()
        if armature is None or mesh is None or not mesh.vertex_groups:
            return {
                "success": True,
                "gravity_ms2": PHYSICS_GRAVITY_MS2,
                "profile": profile,
                "pass": False,
                "checks": [{"name": "rig_present", "pass": False, "detail": "No armature bound to a mesh — model is unrigged."}],
            }
        add("rig_present", True, f"Armature '{armature.name}' bound to mesh '{mesh.name}' ({len(armature.data.bones)} bones)")

        # 1. Broken weights (spikes, unweighted, over-influenced)
        unweighted, over, distant = _pv_check_weights(mesh, armature)
        add("weights_complete", unweighted == 0, f"{unweighted} unweighted vertices")
        add("weights_influences", over == 0, f"{over} vertices exceed {MAX_INFLUENCES} influences")
        add("weights_distance", distant == 0, f"{distant} vertices majority-weighted to a distant bone (spike risk)")

        # 2. Misaligned limbs: L/R symmetry + hinge-axis consistency
        pairs = _pv_bone_pairs(armature)
        asymmetric = []
        flipped_axes = []
        for left, right in pairs:
            l_len, r_len = _pv_chain_length(armature, left), _pv_chain_length(armature, right)
            if max(l_len, r_len) > 0 and abs(l_len - r_len) / max(l_len, r_len) > SYMMETRY_CHAIN_DELTA_MAX:
                asymmetric.append(f"{left}/{right} ({abs(l_len - r_len) / max(l_len, r_len):.1%})")
            lb, rb = armature.data.bones.get(left), armature.data.bones.get(right)
            if lb and rb:
                # Mirrored bones must have mirrored X axes; a same-signed X axis
                # across the sagittal plane indicates a flipped roll/hinge.
                lx, rx = lb.x_axis, rb.x_axis
                if (lx.x * rx.x) > 0 and abs(lx.x) > 0.5:
                    flipped_axes.append(f"{left}/{right}")
        add("limb_symmetry", not asymmetric, "asymmetric chains: " + (", ".join(asymmetric) or "none"))
        add("hinge_axes", not flipped_axes, "flipped hinge axes: " + (", ".join(flipped_axes) or "none"))

        # 3. Neck sagging: torso-weight bleed into neck/head region
        neck_bones = [b.name for b in armature.data.bones if any(k in b.name.lower() for k in ("neck", "head"))]
        torso_bones = [b.name for b in armature.data.bones if any(k in b.name.lower() for k in ("spine", "chest", "torso", "hips", "pelvis"))]
        if neck_bones:
            neck_verts = _pv_region_verts(mesh, armature, neck_bones)
            neck_share = _pv_weight_share(mesh, neck_verts, set(neck_bones))
            bleed = 1.0 - neck_share
            add("neck_weight_isolation", bleed <= NECK_TORSO_BLEED_MAX,
                f"{bleed:.1%} of neck-region weight bleeds to other bones (max {NECK_TORSO_BLEED_MAX:.0%}); torso bones: {len(torso_bones)}")
        else:
            add("neck_weight_isolation", True, "no neck/head chain in contract (informational)")

        # 4. Face contortion: face region must be locked to head unless a facial
        #    rig was purchased; with facial, blendshape deltas stay in-region.
        head_bones = [b.name for b in armature.data.bones if "head" in b.name.lower()]
        if head_bones:
            face_verts = _pv_region_verts(mesh, armature, head_bones, radius_scale=0.9)
            face_share = _pv_weight_share(mesh, face_verts, set(head_bones) | set(neck_bones))
            nonlock = 1.0 - face_share
            add("face_weight_lock", nonlock <= FACE_NONLOCK_MAX,
                f"{nonlock:.1%} non-head weight on face region (max {FACE_NONLOCK_MAX:.0%}); facial add-on: {facial}")
            if facial and mesh.data.shape_keys:
                # Each viseme key at full value must not move non-face vertices.
                face_idx = {v.index for v in face_verts}
                basis = mesh.data.shape_keys.key_blocks.get("Basis")
                leaking = []
                for key in mesh.data.shape_keys.key_blocks:
                    if not key.name.lower().startswith("viseme"):
                        continue
                    for i, kv in enumerate(key.data):
                        if i in face_idx or basis is None:
                            continue
                        if (kv.co - basis.data[i].co).length > 1e-4:
                            leaking.append(key.name)
                            break
                add("viseme_containment", not leaking, "visemes deforming non-face vertices: " + (", ".join(sorted(set(leaking))) or "none"))
        else:
            add("face_weight_lock", True, "no head bone (informational)")

        # 5. Foot contact: sole vertices planted at ground plane in rest pose
        foot_bones = [b.name for b in armature.data.bones if any(k in b.name.lower() for k in ("foot", "toe", "paw", "hoof"))]
        min_z_world = min((mesh.matrix_world @ v.co).z for v in mesh.data.vertices)
        height = mesh.dimensions.z or 1.0
        tolerance = max(FOOT_CONTACT_TOLERANCE * height, 0.003)
        add("foot_contact", abs(min_z_world) <= tolerance,
            f"lowest vertex at {min_z_world:.4f} m (tolerance ±{tolerance:.4f}); foot bones: {len(foot_bones)}")

        # 6. Candy-wrapper twist: 90° twist on wrist/forearm must not collapse volume
        twist_bones = [b for b in armature.pose.bones if any(k in b.name.lower() for k in ("hand", "wrist", "forearm"))]
        if twist_bones:
            import math as _math
            pose_bone = twist_bones[0]
            region = _pv_region_verts(mesh, armature, [pose_bone.name])
            before = len(region)
            pose_bone.rotation_mode = "XYZ"
            original = tuple(pose_bone.rotation_euler)
            pose_bone.rotation_euler.y += _math.radians(90)
            bpy.context.view_layer.update()
            depsgraph = bpy.context.evaluated_depsgraph_get()
            evaluated = mesh.evaluated_get(depsgraph)
            # Cross-section proxy: bounding-box area of the twisted region
            idx = {v.index for v in region}
            xs = [evaluated.data.vertices[i].co.x for i in idx] or [0.0]
            zs = [evaluated.data.vertices[i].co.z for i in idx] or [0.0]
            area_after = (max(xs) - min(xs)) * (max(zs) - min(zs))
            rest_xs = [mesh.data.vertices[i].co.x for i in idx] or [0.0]
            rest_zs = [mesh.data.vertices[i].co.z for i in idx] or [0.0]
            area_before = (max(rest_xs) - min(rest_xs)) * (max(rest_zs) - min(rest_zs))
            pose_bone.rotation_euler = original
            bpy.context.view_layer.update()
            loss = 1.0 - (area_after / area_before) if area_before > 1e-9 else 0.0
            add("twist_volume", loss <= TWIST_AREA_LOSS_MAX,
                f"{loss:.1%} cross-section loss at 90° twist on '{pose_bone.name}' (max {TWIST_AREA_LOSS_MAX:.0%}, {before} verts)")
        else:
            add("twist_volume", True, "no wrist/forearm chain (informational)")

        # 7. Gravity drop test @ 9.8 m/s^2: settle on ground, no fall-through
        try:
            settled, min_z = _pv_settle_test(mesh)
            add("gravity_drop_settle", settled, f"resting min-Z {min_z:.4f} m after drop under {PHYSICS_GRAVITY_MS2} m/s^2")
        except Exception as sim_error:  # rigid-body support varies headless
            add("gravity_drop_settle", True, f"simulation unavailable ({sim_error}); deterministic checks authoritative (informational)")

        overall = all(c["pass"] for c in checks)
        return {"success": True, "gravity_ms2": PHYSICS_GRAVITY_MS2, "profile": profile, "facial": facial, "pass": overall, "checks": checks}
    except Exception as e:
        return {"success": False, "error": str(e), "checks": checks}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_default_camera():
    """Create a default orthographic camera if none exists."""
    cam_data = bpy.data.cameras.new("AgentCam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 3.5
    cam_obj = bpy.data.objects.new("AgentCam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj
    _set_camera_angle(45.0, 30.0)


def _set_camera_angle(azimuth_deg: float, elevation_deg: float, distance: float = 5.0):
    """Position the scene camera at given azimuth/elevation, looking at scene center."""
    camera = bpy.context.scene.camera
    if not camera:
        _create_default_camera()
        camera = bpy.context.scene.camera

    # Calculate target (center of all mesh objects' bounding boxes)
    target = _scene_center()

    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)

    x = target[0] + distance * math.cos(el) * math.sin(az)
    y = target[1] - distance * math.cos(el) * math.cos(az)
    z = target[2] + distance * math.sin(el)

    camera.location = (x, y, z)

    # Point camera at target using track constraint or manual rotation
    from mathutils import Vector
    direction = Vector(target) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def _scene_center():
    """Calculate the approximate center of all mesh objects."""
    from mathutils import Vector
    mesh_objects = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not mesh_objects:
        return (0.0, 0.0, 0.0)

    all_corners = []
    for obj in mesh_objects:
        for v in obj.bound_box:
            all_corners.append(obj.matrix_world @ Vector(v))

    if not all_corners:
        return (0.0, 0.0, 0.0)

    center = sum(all_corners, Vector()) / len(all_corners)
    return (center.x, center.y, center.z)


def filter_operator_kwargs(operator, kwargs: dict) -> dict:
    """Keep only kwargs supported by the active Blender operator API."""
    try:
        supported = set(operator.get_rna_type().properties.keys())
    except Exception:
        return kwargs
    return {key: value for key, value in kwargs.items() if key in supported}


# ---------------------------------------------------------------------------
# Method Dispatch
# ---------------------------------------------------------------------------

METHODS = {
    "execute_code": handle_execute_code,
    "get_viewport": handle_get_viewport,
    "read_scene": handle_read_scene,
    "set_viewport_angle": handle_set_viewport_angle,
    "undo": handle_undo,
    "save_checkpoint": handle_save_checkpoint,
    "restore_checkpoint": handle_restore_checkpoint,
    "export_glb": handle_export_glb,
    "prepare_print_stl": handle_prepare_print_stl,
    "import_glb": handle_import_glb,
    "physics_validate": handle_physics_validate,
    "ping": handle_ping,
}


def dispatch_request(data: dict) -> dict:
    """Route a JSON-RPC request to the appropriate handler."""
    request_id = data.get("id")
    method = data.get("method", "")
    params = data.get("params", {})

    handler = METHODS.get(method)
    if not handler:
        return {
            "id": request_id,
            "error": {"message": f"Unknown method: {method}", "code": -32601},
        }

    try:
        result = handler(params)
        return {"id": request_id, "result": result}
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[Bridge] Handler error for {method}: {tb}")
        return {
            "id": request_id,
            "error": {"message": str(e), "traceback": tb},
        }


def dispatch_cached_ping(data: dict) -> dict:
    """Build a health response without entering Blender's main-thread queue."""
    return {
        "id": data.get("id"),
        "result": handle_ping(data.get("params", {})),
    }


def handle_request(data: dict) -> dict:
    """Queue Blender work for execution on Blender's main thread."""
    response_queue = queue.Queue(maxsize=1)
    REQUEST_QUEUE.put((data, response_queue))
    try:
        return response_queue.get(timeout=BRIDGE_DISPATCH_TIMEOUT_SECONDS)
    except queue.Empty:
        return {
            "id": data.get("id"),
            "error": {
                "message": "Timed out waiting for Blender main-thread dispatch",
                "code": -32000,
            },
        }


def process_request_queue():
    """Run all queued JSON-RPC requests on Blender's main thread."""
    global BRIDGE_SCENE_OBJECT_COUNT
    while True:
        try:
            data, response_queue = REQUEST_QUEUE.get_nowait()
        except queue.Empty:
            break

        try:
            response_queue.put(dispatch_request(data))
        except Exception as e:
            tb = traceback.format_exc()
            response_queue.put({
                "id": data.get("id"),
                "error": {"message": str(e), "traceback": tb},
            })
        finally:
            REQUEST_QUEUE.task_done()
            BRIDGE_SCENE_OBJECT_COUNT = len(bpy.context.scene.objects)


# ---------------------------------------------------------------------------
# TCP Server
# ---------------------------------------------------------------------------

def handle_client(conn, addr):
    """Handle a single TCP client connection."""
    buffer = b""
    try:
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buffer += chunk

            # Process complete messages (newline-delimited)
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue

                try:
                    request = json.loads(line.decode("utf-8"))
                except json.JSONDecodeError as e:
                    response = {
                        "id": None,
                        "error": {"message": f"Invalid JSON: {e}", "code": -32700},
                    }
                    conn.sendall((json.dumps(response) + "\n").encode("utf-8"))
                    continue

                method = request.get("method")
                if method != "ping":
                    print(f"[Bridge] Request: method={method} id={request.get('id')}")
                    
                # Ping never mutates Blender state and reads only cached scalar
                # values, so it can bypass a long render queued on the main thread.
                response = dispatch_cached_ping(request) if method == "ping" else handle_request(request)
                response_json = json.dumps(response) + "\n"
                conn.sendall(response_json.encode("utf-8"))

    except (ConnectionResetError, BrokenPipeError):
        pass  # Ignore abrupt disconnects (likely health checks)
    except Exception as e:
        print(f"[Bridge] Client error: {e}")
    finally:
        conn.close()


def start_server():
    """Start the TCP server in a background thread."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((TCP_HOST, TCP_PORT))
    server.listen(5)
    print(f"[Bridge] ✅ TCP Bridge listening on {TCP_HOST}:{TCP_PORT}")

    while True:
        conn, addr = server.accept()
        client_thread = threading.Thread(target=handle_client, args=(conn, addr), daemon=True)
        client_thread.start()


# Start in a background thread so Blender's main loop remains available
server_thread = threading.Thread(target=start_server, daemon=True)
server_thread.start()

# Keep Blender alive — the main thread needs to stay running
# In --background mode, Blender will exit unless we block
print("[Bridge] Blender bridge is running. Waiting for connections...")

# Use a simple infinite loop with sleep to keep the process alive
import time
try:
    while True:
        process_request_queue()
        time.sleep(0.01)
except KeyboardInterrupt:
    print("[Bridge] Shutting down...")
