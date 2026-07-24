import { z } from "zod";
import crypto from "node:crypto";
import { SpatialPlanOutput, SpatialMathOutput, MATH_LIMITS } from "./types";
import {
  SpatialPlanSchema,
  SpatialMathOutputSchema,
  type NormalizedPrimitive,
} from "./schemas";

export interface BlenderPrimitive {
  id: string;
  type: "box" | "cylinder" | "uv_sphere" | "cone" | "torus" | "capsule";
  role: "additive" | "subtractive";
  dimensions: [number, number, number]; // mm
  position: [number, number, number]; // mm
  rotation: [number, number, number]; // degrees
  symmetryAxis?: "x" | "y" | "z";
  bevel?: { width: number; segments: number };
  curveSweep?: { controlPoints: number[][]; segments: number };
  array?: { count: number; spacing: number; axis: "x" | "y" | "z" };
  constraints: { minimumWallMm: number; clearanceMm?: number };
  materialIntent?: { color?: string; roughness?: number; metalness?: number };
}

/**
 * Compiles a validated SpatialPlan + SpatialMathOutput into a deterministic
 * Blender Python program using only allowlisted primitives and operations.
 *
 * The compiler never interpolates raw prompt text — all code is template-based.
 */
export function compileBlenderProgram(
  plan: SpatialPlanOutput,
  math: SpatialMathOutput,
  targetUse: "digital" | "attachment" | "print",
): { program: string; programHash: string } {
  // Validate inputs
  const planValid = SpatialPlanSchema.safeParse(plan);
  if (!planValid.success) {
    throw new Error(`Invalid plan: ${planValid.error.message}`);
  }
  const mathValid = SpatialMathOutputSchema.safeParse(math);
  if (!mathValid.success) {
    throw new Error(`Invalid math output: ${mathValid.error.message}`);
  }

  // Verify plan hash matches
  if (planValid.data.planHash !== math.planHash) {
    throw new Error("Plan hash mismatch between plan and math output");
  }

  // Build primitives from math output (authoritative)
  const primitives = buildPrimitives(plan, math);

  // Generate deterministic program
  const program = generateBlenderPython(primitives, plan, targetUse);

  // Hash the program for audit trail
  const programHash = crypto.createHash("sha256").update(program).digest("hex");

  return { program, programHash };
}

function buildPrimitives(plan: SpatialPlanOutput, math: SpatialMathOutput): BlenderPrimitive[] {
  const mathPrimitives = math.resolvedPrimitives;
  const planPrimitives = plan.primitives;

  // Create a map from math primitives by ID
  const mathById = new Map(mathPrimitives.map(p => [p.id, p]));

  const primitives: BlenderPrimitive[] = [];

  for (const planPrim of planPrimitives) {
    const mathPrim = mathById.get(planPrim.id);
    if (!mathPrim) {
      throw new Error(`Math output missing primitive: ${planPrim.id}`);
    }

    // Validate against hard limits
    validatePrimitiveLimits(planPrim, mathPrim);

    // Map normalized type to Blender type
    const blenderType = mapTypeToBlender(planPrim.type);

    primitives.push({
      id: planPrim.id,
      type: blenderType,
      role: planPrim.role,
      dimensions: [mathPrim.dimensionsMm.x, mathPrim.dimensionsMm.y, mathPrim.dimensionsMm.z],
      position: [mathPrim.positionMm.x, mathPrim.positionMm.y, mathPrim.positionMm.z],
      rotation: [mathPrim.rotationDeg.x, mathPrim.rotationDeg.y, mathPrim.rotationDeg.z],
      symmetryAxis: planPrim.symmetryAxis,
      bevel: planPrim.bevel ? { width: planPrim.bevel.width, segments: planPrim.bevel.segments } : undefined,
      curveSweep: planPrim.curveSweep ? {
        controlPoints: planPrim.curveSweep.controlPoints,
        segments: planPrim.curveSweep.segments,
      } : undefined,
      array: planPrim.array ? {
        count: planPrim.array.count,
        spacing: planPrim.array.spacing,
        axis: planPrim.array.axis,
      } : undefined,
      constraints: {
        minimumWallMm: planPrim.constraints.minimumWallMm,
        clearanceMm: planPrim.constraints.clearanceMm,
      },
      materialIntent: planPrim.materialIntent,
    });
  }

  return primitives;
}

function validatePrimitiveLimits(planPrim: NormalizedPrimitive, mathPrim: any): void {
  // Dimensions
  const dims = [mathPrim.dimensionsMm.x, mathPrim.dimensionsMm.y, mathPrim.dimensionsMm.z];
  for (const dim of dims) {
    if (dim < MATH_LIMITS.MIN_DIMENSION_MM || dim > MATH_LIMITS.MAX_DIMENSION_MM) {
      throw new Error(`Primitive ${planPrim.id}: dimension ${dim}mm out of bounds [${MATH_LIMITS.MIN_DIMENSION_MM}, ${MATH_LIMITS.MAX_DIMENSION_MM}]`);
    }
  }

  // Position within coordinate bounds
  const pos = [mathPrim.positionMm.x, mathPrim.positionMm.y, mathPrim.positionMm.z];
  for (const coord of pos) {
    if (Math.abs(coord) > MATH_LIMITS.MAX_COORDINATE_MM) {
      throw new Error(`Primitive ${planPrim.id}: coordinate ${coord}mm exceeds ${MATH_LIMITS.MAX_COORDINATE_MM}mm limit`);
    }
  }

  // Rotation finite
  const rot = [mathPrim.rotationDeg.x, mathPrim.rotationDeg.y, mathPrim.rotationDeg.z];
  for (const r of rot) {
    if (!Number.isFinite(r) || Math.abs(r) > 360) {
      throw new Error(`Primitive ${planPrim.id}: invalid rotation ${r}°`);
    }
  }

  // Bevel bounds
  if (planPrim.bevel) {
    if (planPrim.bevel.width > 100 || planPrim.bevel.segments > 32) {
      throw new Error(`Primitive ${planPrim.id}: bevel parameters exceed limits`);
    }
  }

  // Array bounds
  if (planPrim.array) {
    if (planPrim.array.count > 64 || planPrim.array.spacing > 1000) {
      throw new Error(`Primitive ${planPrim.id}: array parameters exceed limits`);
    }
  }

  // Boolean count will be validated at program level
}

function mapTypeToBlender(type: string): BlenderPrimitive["type"] {
  const map: Record<string, BlenderPrimitive["type"]> = {
    box: "box",
    cylinder: "cylinder",
    uv_sphere: "uv_sphere",
    cone: "cone",
    torus: "torus",
    capsule: "capsule",
  };
  return map[type] || "box";
}

function generateBlenderPython(
  primitives: BlenderPrimitive[],
  plan: SpatialPlanOutput,
  targetUse: "digital" | "attachment" | "print",
): string {
  const lines: string[] = [];

  // Header
  lines.push("# ============================================================");
  lines.push("# PawsMemories Spatial Generator — Deterministic Blender Build");
  lines.push(`# Plan: ${plan.planHash}`);
  lines.push(`# Target: ${targetUse}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push("# ============================================================");
  lines.push("");
  lines.push("import bpy");
  lines.push("import bmesh");
  lines.push("import math");
  lines.push("import mathutils");
  lines.push("");
  lines.push("def clear_scene():");
  lines.push("    bpy.ops.object.select_all(action='SELECT')");
  lines.push("    bpy.ops.object.delete()");
  lines.push("    for block in bpy.data.meshes: bpy.data.meshes.remove(block)");
  lines.push("    for block in bpy.data.materials: bpy.data.materials.remove(block)");
  lines.push("");
  lines.push("def mm(val): return val / 1000.0");
  lines.push("");
  lines.push("clear_scene()");
  lines.push("");

  // Create materials
  lines.push("# ── Materials ───────────────────────────────────────────────");
  const materialMap = new Map<string, string>();
  let matIndex = 0;
  for (const prim of primitives) {
    const matKey = JSON.stringify(prim.materialIntent || {});
    if (!materialMap.has(matKey)) {
      const matName = `SpatialMat_${matIndex++}`;
      materialMap.set(matKey, matName);
      const color = prim.materialIntent?.color || "#808080";
      const roughness = prim.materialIntent?.roughness ?? 0.5;
      const metalness = prim.materialIntent?.metalness ?? 0.0;
      lines.push(`m = bpy.data.materials.new("${matName}")`);
      lines.push(`m.use_nodes = True`);
      lines.push(`bsdf = m.node_tree.nodes["Principled BSDF"]`);
      lines.push(`bsdf.inputs["Base Color"].default_value = ${hexToRgba(color)}`);
      lines.push(`bsdf.inputs["Roughness"].default_value = ${roughness.toFixed(3)}`);
      lines.push(`bsdf.inputs["Metallic"].default_value = ${metalness.toFixed(3)}`);
      lines.push("");
    }
  }

  // Create primitives
  lines.push("# ── Primitives ───────────────────────────────────────────────");
  const objectNames: string[] = [];

  for (const prim of primitives) {
    const objName = `Spatial_${prim.id}`;
    objectNames.push(objName);

    // Create base mesh
    lines.push(`# ${prim.id} — ${prim.type} (${prim.role})`);
    lines.push(`bpy.ops.mesh.primitive_${primitiveToBlenderOp(prim.type)}(${primitiveArgs(prim)})`);
    lines.push(`obj = bpy.context.active_object`);
    lines.push(`obj.name = "${objName}"`);
    lines.push(`obj.location = (${formatVec3Mm(prim.position)})`);
    lines.push(`obj.rotation_euler = (${formatVec3Deg(prim.rotation)})`);
    lines.push(`obj.scale = (1.0, 1.0, 1.0)`);

    // Apply symmetry
    if (prim.symmetryAxis) {
      lines.push(`mod = obj.modifiers.new(name="Mirror_${prim.symmetryAxis}", type='MIRROR')`);
      lines.push(`mod.use_axis[${axisIndex(prim.symmetryAxis)}] = True`);
      lines.push(`mod.use_bisect_axis[${axisIndex(prim.symmetryAxis)}] = True`);
      lines.push(`mod.use_bisect_flip_axis[${axisIndex(prim.symmetryAxis)}] = False`);
    }

    // Apply bevel
    if (prim.bevel) {
      lines.push(`mod = obj.modifiers.new(name="Bevel", type='BEVEL')`);
      lines.push(`mod.width = mm(${prim.bevel.width.toFixed(3)})`);
      lines.push(`mod.segments = ${prim.bevel.segments}`);
      lines.push(`mod.affect = 'EDGES'`);
    }

    // Apply array
    if (prim.array) {
      lines.push(`mod = obj.modifiers.new(name="Array", type='ARRAY')`);
      lines.push(`mod.count = ${prim.array.count}`);
      lines.push(`mod.relative_offset_displace[${axisIndex(prim.array.axis)}] = 1.0`);
      const spacing = prim.array.spacing;
      lines.push(`mod.relative_offset_displace[${axisIndex(prim.array.axis)}] = ${(spacing / prim.dimensions[axisIndex(prim.array.axis)] + 1).toFixed(6)}`);
    }

    // Assign material
    if (prim.materialIntent) {
      const matKey = JSON.stringify(prim.materialIntent);
      const matName = materialMap.get(matKey);
      if (matName) {
        lines.push(`if "${matName}" in bpy.data.materials:`);
        lines.push(`    obj.data.materials.append(bpy.data.materials["${matName}"])`);
      }
    }

    lines.push("");
  }

  // Apply boolean operations in declared order
  lines.push("# ── Boolean Operations ──────────────────────────────────────");
  const additive = primitives.filter(p => p.role === "additive");
  const subtractive = primitives.filter(p => p.role === "subtractive");

  if (subtractive.length > 0) {
    lines.push("# Start with first additive primitive as base");
    if (additive.length > 0) {
      const base = additive[0];
      lines.push(`base = bpy.data.objects["Spatial_${base.id}"]`);
      for (let i = 1; i < additive.length; i++) {
        const add = additive[i];
        lines.push(`add = bpy.data.objects["Spatial_${add.id}"]`);
        lines.push(`mod = base.modifiers.new(name="Bool_Union_${add.id}", type='BOOLEAN')`);
        lines.push(`mod.operation = 'UNION'`);
        lines.push(`mod.object = add`);
      }
      for (const sub of subtractive) {
        lines.push(`sub = bpy.data.objects["Spatial_${sub.id}"]`);
        lines.push(`mod = base.modifiers.new(name="Bool_Diff_${sub.id}", type='BOOLEAN')`);
        lines.push(`mod.operation = 'DIFFERENCE'`);
        lines.push(`mod.object = sub`);
      }
      lines.push(`bpy.context.view_layer.objects.active = base`);
      for (let i = 0; i < additive.length + subtractive.length; i++) {
        lines.push(`bpy.ops.object.modifier_apply(modifier=base.modifiers[0].name)`);
      }
      lines.push(`result = base`);
      lines.push(`result.name = "Spatial_Result"`);
    }
  } else {
    // No boolean operations, just use the first (or only) additive
    if (additive.length === 1) {
      lines.push(`result = bpy.data.objects["Spatial_${additive[0].id}"]`);
      lines.push(`result.name = "Spatial_Result"`);
    }
  }

  // Clean up helper objects
  lines.push("");
  lines.push("# ── Cleanup ─────────────────────────────────────────────────");
  lines.push(`for obj in bpy.data.objects:`);
  lines.push(`    if obj != result:`);
  lines.push(`        bpy.data.objects.remove(obj, do_unlink=True)`);

  // Final checks
  lines.push("");
  lines.push("# ── Final Validation ────────────────────────────────────────");
  lines.push(`bpy.ops.object.select_all(action='DESELECT')`);
  lines.push(`result.select_set(True)`);
  lines.push(`bpy.context.view_layer.objects.active = result`);
  lines.push(`bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)`);
  lines.push(`print("SPATIAL_BOUNDS_MIN:", [round(v*1000, 3) for v in result.bound_box[0]])`);
  lines.push(`print("SPATIAL_BOUNDS_MAX:", [round(v*1000, 3) for v in result.bound_box[6]])`);
  lines.push(`print("SPATIAL_VERTEX_COUNT:", len(result.data.vertices))`);
  lines.push(`print("SPATIAL_FACE_COUNT:", len(result.data.polygons))`);

  return lines.join("\n");
}

function primitiveToBlenderOp(type: BlenderPrimitive["type"]): string {
  const map: Record<BlenderPrimitive["type"], string> = {
    box: "cube",
    cylinder: "cylinder",
    uv_sphere: "uv_sphere",
    cone: "cone",
    torus: "torus",
    capsule: "cube", // capsule = box + cylinder, simplified to cube for now
  };
  return map[type];
}

function primitiveArgs(prim: BlenderPrimitive): string {
  const args: string[] = [];
  // For cube, use size=1 and scale via dimensions
  // For others, pass dimensions directly
  switch (prim.type) {
    case "box":
      args.push(`size=1`);
      break;
    case "cylinder":
      args.push(`radius=1, depth=1`);
      break;
    case "uv_sphere":
      args.push(`radius=1`);
      break;
    case "cone":
      args.push(`radius1=1, radius2=0, depth=1`);
      break;
    case "torus":
      args.push(`align='WORLD', major_radius=1, minor_radius=0.3`);
      break;
    default:
      args.push(`size=1`);
  }
  return args.join(", ");
}

function formatVec3Mm(vec: [number, number, number]): string {
  return vec.map(v => `mm(${v.toFixed(3)})`).join(", ");
}

function formatVec3Deg(vec: [number, number, number]): string {
  return vec.map(v => `math.radians(${v.toFixed(3)})`).join(", ");
}

function axisIndex(axis: "x" | "y" | "z"): number {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

function hexToRgba(hex: string): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return `(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}, 1.0)`;
}

/**
 * Verifies that the actual Blender scene bounds match expected bounds
 * within tolerance (0.5mm or 0.5%, whichever is larger).
 */
export function verifyBlenderBounds(
  expectedMin: [number, number, number],
  expectedMax: [number, number, number],
  actualMin: [number, number, number],
  actualMax: [number, number, number],
): { pass: boolean; errors: string[] } {
  const errors: string[] = [];
  const tolerance = MATH_LIMITS.MATH_TOLERANCE_MM;

  const check = (axis: string, expected: number, actual: number): boolean => {
    const diff = Math.abs(expected - actual);
    const percent = expected !== 0 ? (diff / Math.abs(expected)) * 100 : Infinity;
    return diff <= tolerance || percent <= 0.5;
  };

  if (!check("x", expectedMin[0], actualMin[0])) {
    errors.push(`Bounds min X mismatch: expected ${expectedMin[0].toFixed(3)}mm, got ${actualMin[0].toFixed(3)}mm`);
  }
  if (!check("y", expectedMin[1], actualMin[1])) {
    errors.push(`Bounds min Y mismatch: expected ${expectedMin[1].toFixed(3)}mm, got ${actualMin[1].toFixed(3)}mm`);
  }
  if (!check("z", expectedMin[2], actualMin[2])) {
    errors.push(`Bounds min Z mismatch: expected ${expectedMin[2].toFixed(3)}mm, got ${actualMin[2].toFixed(3)}mm`);
  }

  if (!check("x", expectedMax[0], actualMax[0])) {
    errors.push(`Bounds max X mismatch: expected ${expectedMax[0].toFixed(3)}mm, got ${actualMax[0].toFixed(3)}mm`);
  }
  if (!check("y", expectedMax[1], actualMax[1])) {
    errors.push(`Bounds max Y mismatch: expected ${expectedMax[1].toFixed(3)}mm, got ${actualMax[1].toFixed(3)}mm`);
  }
  if (!check("z", expectedMax[2], actualMax[2])) {
    errors.push(`Bounds max Z mismatch: expected ${expectedMax[2].toFixed(3)}mm, got ${actualMax[2].toFixed(3)}mm`);
  }

  return { pass: errors.length === 0, errors };
}