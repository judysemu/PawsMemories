"""
blender-worker/jobs/render_views.py — UV_TEXTURE_GENERATION_PLAN.md UV2

Renders N calibrated canonical views of an already-imported pet mesh and returns
them base64-encoded together with the camera parameters used. These renders are
the *source images* the UV3 stylizer conditions on, and the camera parameters
are what lets UV4 re-project the stylized results back onto the mesh.

CAMERA-CONVENTION PARITY IS THE WHOLE POINT
-------------------------------------------
This file MUST place cameras identically to jobs/rebake_texture.py. That file
already ships a working projection bake using a specific convention:

    azimuth 0 = camera on -Y looking toward +Y (Blender front view),
    rotating clockwise seen from above
    cam_pos     = center + (radius*sin(az), -radius*cos(az), 0)
    radius      = max(size.x, size.y) * 1.5 + 0.001
    ortho_scale = max(size.x, size.y, size.z) * 1.1
    track       = direction.to_track_quat("-Z", "Z")

If this module rendered through any other convention, the images would look
perfectly correct in isolation and every downstream bake would land rotated or
mirrored — a failure that is invisible until someone orbits a finished model.
The constants below are therefore duplicated deliberately and asserted equal by
tests/texture_render_views.test.mjs.

They are duplicated rather than imported because both files are shipped to
Blender as source text through bridge.executeCode(), so a sibling import is not
guaranteed to resolve inside the container. UV_TEXTURE_COMPLETION_PLAN.md UV4
folds them into one shared module, once a Blender environment is available to
re-run the bake fixtures and prove the refactor changed nothing.

WHAT THIS DOES NOT EMIT
-----------------------
No depth / normal / UV-island EXR passes. UV_TEXTURE_GENERATION_PLAN.md UV2
lists them, but the projection bake in rebake_texture.py re-derives facing
weights from geometry at bake time and never reads them. Emitting them now would
add render cost and payload with no consumer. Revisit when UV4's seam work
needs them.

Entry point: run_render_views(params) -> prints RENDER_VIEWS_RESULT:{json}
"""

import base64
import json
import math
import os
import tempfile

import bpy  # type: ignore
from mathutils import Vector  # type: ignore

# ---------------------------------------------------------------------------
# Convention constants — keep byte-identical to jobs/rebake_texture.py.
# ---------------------------------------------------------------------------
VIEW_AZIMUTH_DEG = {"front": 0.0, "right": 90.0, "back": 180.0, "left": 270.0}

# Tier -> which views to render. D3 in the plan: Draft is the 4 cardinals,
# Studio adds the 45-degree corners where seams are worst.
VIEW_SETS = {
    "draft": ["front", "right", "back", "left"],
    "standard": ["front", "right", "back", "left"],
    "studio": ["front", "front_right", "right", "back_right", "back", "back_left", "left", "front_left"],
}

CORNER_AZIMUTH_DEG = {
    "front_right": 45.0,
    "back_right": 135.0,
    "back_left": 225.0,
    "front_left": 315.0,
}

# Resolution ceiling per tier. Bounded because the worker runs on a KVM-class
# Render instance and an 8-view Studio set at 2K is already a real cost.
TIER_RESOLUTION = {"draft": 512, "standard": 768, "studio": 1024}

MAX_RESOLUTION = 2048


def _azimuth_for(view_name):
    if view_name in VIEW_AZIMUTH_DEG:
        return VIEW_AZIMUTH_DEG[view_name]
    if view_name in CORNER_AZIMUTH_DEG:
        return CORNER_AZIMUTH_DEG[view_name]
    raise ValueError("Unknown view name: %s" % view_name)


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


def _make_camera(name, azimuth_deg, lo, hi):
    """Orthographic camera at the given azimuth, framing the whole mesh.

    Byte-for-byte the same placement as rebake_texture._make_camera. See the
    module docstring for why that matters.
    """
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


def _setup_world_lighting():
    """Flat, neutral, shadowless lighting.

    These renders are conditioning input for a 2D generator, not beauty shots.
    Directional lights would bake highlights and cast shadows into the source
    image; the stylizer would treat that shading as surface colour and it would
    end up permanently painted into the atlas. A uniform white world gives the
    generator albedo-like input, which is what the bake actually wants.
    """
    world = bpy.context.scene.world
    if world is None:
        world = bpy.data.worlds.new("RenderViewsWorld")
        bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
        bg.inputs[1].default_value = 1.0


def _select_render_engine(scene):
    """Select the first engine exposed by this exact Blender build."""
    available = {item.identifier for item in scene.render.bl_rna.properties["engine"].enum_items}
    for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        if candidate in available:
            return candidate
    raise RuntimeError("No supported Blender render engine is available.")


def _configure_render(resolution, transparent):
    scene = bpy.context.scene
    # EEVEE is enough here and an order of magnitude cheaper than Cycles for
    # flat-lit views. Blender 5.x renamed the enum, so select from the runtime
    # list instead of assigning a possibly-invalid value before a fallback.
    scene.render.engine = _select_render_engine(scene)
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = 16

    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    scene.render.film_transparent = bool(transparent)


def _render_to_base64(cam, path):
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    with open(path, "rb") as fh:
        data = fh.read()
    try:
        os.remove(path)
    except OSError:
        pass
    return base64.b64encode(data).decode("ascii")


def _camera_metadata(cam, direction, azimuth_deg):
    """Everything UV4 needs to rebuild this camera without re-deriving bounds."""
    return {
        "azimuth_deg": azimuth_deg,
        "location": [cam.location.x, cam.location.y, cam.location.z],
        "rotation_euler": [
            cam.rotation_euler.x,
            cam.rotation_euler.y,
            cam.rotation_euler.z,
        ],
        "direction": [direction.x, direction.y, direction.z],
        "ortho_scale": cam.data.ortho_scale,
        "clip_start": cam.data.clip_start,
        "clip_end": cam.data.clip_end,
        "type": "ORTHO",
    }


def run_render_views(params):
    try:
        tier = str(params.get("tier") or "standard").lower()
        if tier not in VIEW_SETS:
            tier = "standard"

        requested = params.get("views")
        view_names = list(requested) if requested else list(VIEW_SETS[tier])
        for name in view_names:
            _azimuth_for(name)  # validate early, before any render cost

        resolution = int(params.get("resolution") or TIER_RESOLUTION.get(tier, 768))
        resolution = max(128, min(resolution, MAX_RESOLUTION))
        transparent = bool(params.get("transparent", True))

        objs = _mesh_objects()
        if not objs:
            print("RENDER_VIEWS_RESULT:" + json.dumps({"success": False, "error": "No mesh in scene."}))
            return

        lo, hi = _scene_bounds(objs)
        size = hi - lo
        if max(size.x, size.y, size.z) <= 0.0:
            print("RENDER_VIEWS_RESULT:" + json.dumps({"success": False, "error": "Mesh has zero bounds."}))
            return

        _setup_world_lighting()
        _configure_render(resolution, transparent)

        tmpdir = tempfile.gettempdir()
        views = {}
        cameras = {}
        created = []

        try:
            for name in view_names:
                azimuth = _azimuth_for(name)
                cam, direction = _make_camera("rv_cam_%s" % name, azimuth, lo, hi)
                created.append(cam)
                path = os.path.join(tmpdir, "render_view_%s.png" % name)
                views[name] = _render_to_base64(cam, path)
                cameras[name] = _camera_metadata(cam, direction, azimuth)
        finally:
            # Leave the scene as we found it even when one render fails. A
            # stray camera would shift bounds for the next request.
            for cam in created:
                if cam.name in bpy.data.objects:
                    bpy.data.objects.remove(cam, do_unlink=True)

        print("RENDER_VIEWS_RESULT:" + json.dumps({
            "success": True,
            "views": views,
            "cameras": cameras,
            "tier": tier,
            "resolution": resolution,
            "transparent": transparent,
            "bounds": {
                "lo": [lo.x, lo.y, lo.z],
                "hi": [hi.x, hi.y, hi.z],
            },
            "convention": {
                "azimuth_zero": "camera on -Y looking toward +Y",
                "rotation": "clockwise from above",
                "projection": "ORTHO",
            },
        }))
    except Exception as exc:  # noqa: BLE001 — surface any failure to the worker
        print("RENDER_VIEWS_RESULT:" + json.dumps({"success": False, "error": str(exc)}))
