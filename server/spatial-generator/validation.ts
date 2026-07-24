import crypto from "node:crypto";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";
import { MATH_LIMITS, type SpatialMathOutput } from "./types";
import type { GlbValidationMetrics } from "./schemas";

export const VALIDATOR_VERSION = "spatial-v1.0.0";

/**
 * Deterministic post-build GLB validation.
 *
 * Reopens the GLB from raw bytes using gltf-transform, runs all deterministic
 * checks, and returns metrics + pass/warn/fail status. Never claims real-world
 * scale from uncalibrated images.
 */
export async function validateGlb(
  glbBuffer: Buffer,
): Promise<{ status: "pass" | "warn" | "fail"; metrics: GlbValidationMetrics; metricsHash: string }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const actualLength = glbBuffer.length;

  // ── 1. Magic bytes ────────────────────────────────────────────────────────
  let magicValid = false;
  let versionValid = false;
  let declaredLength = 0;

  if (actualLength < 12) {
    errors.push("GLB too small: fewer than 12 bytes");
  } else {
    const magic = glbBuffer.readUInt32LE(0);
    magicValid = magic === 0x46546c67; // "glTF" little-endian
    if (!magicValid) errors.push(`Invalid GLB magic: 0x${magic.toString(16)}`);

    const version = glbBuffer.readUInt32LE(4);
    versionValid = version === 2;
    if (!versionValid) errors.push(`Unsupported GLB version: ${version}`);

    declaredLength = glbBuffer.readUInt32LE(8);
    if (declaredLength !== actualLength) {
      errors.push(`Declared length ${declaredLength} does not equal actual ${actualLength}`);
    }
  }

  if (actualLength > 200 * 1024 * 1024) {
    errors.push(`GLB exceeds maximum size: ${actualLength} > 200MB`);
  }

  // ── 2. Reopen through gltf-transform ──────────────────────────────────────
  let sceneCount = 0, nodeCount = 0, meshCount = 0, primitiveCount = 0;
  let triangleCount = 0, vertexCount = 0, materialCount = 0, textureCount = 0;
  let hasPositionAccessor = false, hasNormals = false, hasUVs = false;
  let hasSkin = false, hasAnimation = false;
  let containsNaN = false, containsInfinity = false;
  let hasExternalUris = false, hasEmptyGeometry = false;
  let boundingBox: { min: [number, number, number]; max: [number, number, number] } | null = null;
  let dimensions: { width: number; height: number; depth: number; unit: "unscaled" } | null = null;
  const textureDetails: Array<{ mimeType: string; width: number; height: number }> = [];

  if (magicValid && versionValid && actualLength >= 12) {
    try {
      const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
      const doc = await io.readBinary(new Uint8Array(glbBuffer));
      const root = doc.getRoot();

      sceneCount = root.listScenes().length;
      nodeCount = root.listNodes().length;

      const allMeshes = root.listMeshes();
      meshCount = allMeshes.length;
      materialCount = root.listMaterials().length;
      textureCount = root.listTextures().length;
      hasSkin = root.listSkins().length > 0;
      hasAnimation = root.listAnimations().length > 0;

      // Check for external URIs in buffers
      for (const buf of root.listBuffers()) {
        const uri = buf.getURI();
        if (uri && !uri.startsWith("data:")) {
          hasExternalUris = true;
          errors.push(`External buffer URI detected: ${uri.slice(0, 100)}`);
        }
      }

      // Mesh/primitive analysis
      for (const mesh of allMeshes) {
        const prims = mesh.listPrimitives();
        primitiveCount += prims.length;
        if (prims.length === 0) {
          hasEmptyGeometry = true;
          warnings.push(`Mesh "${mesh.getName() || "(unnamed)"}" has zero primitives`);
        }

        for (const prim of prims) {
          const position = prim.getAttribute("POSITION");
          if (position) {
            hasPositionAccessor = true;
            vertexCount += position.getCount();

            // Check for NaN/Infinity in positions
            const values = position.getArray();
            if (!values) {
              errors.push("POSITION accessor has no readable data");
            } else {
              for (const c of values) {
                if (Number.isNaN(c)) containsNaN = true;
                if (!Number.isFinite(c)) containsInfinity = true;
              }
            }
          } else {
            hasEmptyGeometry = true;
          }

          if (prim.getAttribute("NORMAL")) hasNormals = true;
          if (prim.getAttribute("TEXCOORD_0")) hasUVs = true;

          const indices = prim.getIndices();
          if (indices) {
            const indexValues = indices.getArray();
            const positionCount = position?.getCount() || 0;
            if (!indexValues || Array.from(indexValues).some((index) => Number(index) < 0 || Number(index) >= positionCount)) {
              errors.push("Primitive contains an out-of-range index");
            }
            triangleCount += Math.floor(indices.getCount() / 3);
          } else if (position) {
            triangleCount += Math.floor(position.getCount() / 3);
          }
        }
      }

      // Texture details
      for (const tex of root.listTextures()) {
        const uri = tex.getURI();
        if (uri && !uri.startsWith("data:")) {
          hasExternalUris = true;
          errors.push(`External image URI detected: ${uri.slice(0, 100)}`);
        }
        const mime = tex.getMimeType() || "image/unknown";
        const size = tex.getSize();
        textureDetails.push({
          mimeType: mime,
          width: size ? size[0] : 0,
          height: size ? size[1] : 0,
        });
      }

      // Bounding box via scene traversal
      try {
        const scene = root.getDefaultScene() || root.listScenes()[0];
        if (scene) {
          const bounds = getBounds(scene);
          const min = bounds.min as [number, number, number];
          const max = bounds.max as [number, number, number];
          const allFinite = [...min, ...max].every(v => Number.isFinite(v));
          if (allFinite) {
            boundingBox = { min, max };
            dimensions = {
              width: Math.abs(max[0] - min[0]),
              height: Math.abs(max[1] - min[1]),
              depth: Math.abs(max[2] - min[2]),
              unit: "unscaled",
            };
          }
        }
      } catch (err: any) {
        warnings.push(`Could not compute bounding box: ${err.message}`);
      }

      // Deterministic validation checks
      if (sceneCount === 0) errors.push("No scenes in GLB");
      if (meshCount === 0) errors.push("No meshes in GLB");
      if (!hasPositionAccessor) errors.push("No POSITION accessor found");
      if (containsNaN) errors.push("POSITION data contains NaN values");
      if (containsInfinity) errors.push("POSITION data contains Infinity values");
      if (hasEmptyGeometry) warnings.push("GLB contains empty geometry (meshes without primitives or POSITION)");

      // Budget warnings
      if (triangleCount > 500_000) warnings.push(`High triangle count: ${triangleCount}`);
      if (textureCount > 20) warnings.push(`Many textures: ${textureCount}`);
      for (const td of textureDetails) {
        if (td.width > 4096 || td.height > 4096) {
          warnings.push(`Large texture ${td.width}x${td.height} (${td.mimeType})`);
        }
      }
    } catch (err: any) {
      errors.push(`Failed to reopen GLB: ${(err.message || "unknown").slice(0, 200)}`);
    }
  }

  const metrics: GlbValidationMetrics = {
    magicValid,
    versionValid,
    declaredLength,
    actualLength,
    sceneCount,
    nodeCount,
    meshCount,
    primitiveCount,
    triangleCount,
    vertexCount,
    materialCount,
    textureCount,
    hasPositionAccessor,
    hasNormals,
    hasUVs,
    hasSkin,
    hasAnimation,
    boundingBox,
    dimensions,
    containsNaN,
    containsInfinity,
    hasExternalUris,
    hasEmptyGeometry,
    textureDetails,
    warnings: warnings.length > 0 ? warnings : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };

  // Deterministic report hash
  const metricsHash = crypto.createHash("sha256")
    .update(JSON.stringify({ validatorVersion: VALIDATOR_VERSION, metrics }))
    .digest("hex");

  const status = errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass";

  return { status, metrics, metricsHash };
}

/**
 * Validates the deterministic math output against the computed GLB bounds.
 * Per §2.6 amendment: deterministic server-side solver, tolerance 0.05mm or 0.5%.
 */
export function validateMathAgainstGlb(
  math: SpatialMathOutput,
  glbMetrics: GlbValidationMetrics,
): { pass: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!glbMetrics.boundingBox || !glbMetrics.dimensions) {
    errors.push("GLB missing bounding box for math validation");
    return { pass: false, errors };
  }

  const expectedMin = math.derived.boundsMinMm;
  const expectedMax = math.derived.boundsMaxMm;
  const actualMin = glbMetrics.boundingBox.min;
  const actualMax = glbMetrics.boundingBox.max;

  // Check each axis with tolerance (0.05mm or 0.5%)
  const tolerance = MATH_LIMITS.MATH_TOLERANCE_MM;

  const checkAxis = (axis: "x" | "y" | "z", expected: number, actual: number): boolean => {
    const diff = Math.abs(expected - actual);
    const percent = expected !== 0 ? (diff / Math.abs(expected)) * 100 : Infinity;
    return diff <= tolerance || percent <= 0.5;
  };

  if (!checkAxis("x", expectedMin.x, actualMin[0])) {
    errors.push(`Bounds min X mismatch: expected ${expectedMin.x.toFixed(3)}mm, got ${actualMin[0].toFixed(3)}mm`);
  }
  if (!checkAxis("y", expectedMin.y, actualMin[1])) {
    errors.push(`Bounds min Y mismatch: expected ${expectedMin.y.toFixed(3)}mm, got ${actualMin[1].toFixed(3)}mm`);
  }
  if (!checkAxis("z", expectedMin.z, actualMin[2])) {
    errors.push(`Bounds min Z mismatch: expected ${expectedMin.z.toFixed(3)}mm, got ${actualMin[2].toFixed(3)}mm`);
  }

  if (!checkAxis("x", expectedMax.x, actualMax[0])) {
    errors.push(`Bounds max X mismatch: expected ${expectedMax.x.toFixed(3)}mm, got ${actualMax[0].toFixed(3)}mm`);
  }
  if (!checkAxis("y", expectedMax.y, actualMax[1])) {
    errors.push(`Bounds max Y mismatch: expected ${expectedMax.y.toFixed(3)}mm, got ${actualMax[1].toFixed(3)}mm`);
  }
  if (!checkAxis("z", expectedMax.z, actualMax[2])) {
    errors.push(`Bounds max Z mismatch: expected ${expectedMax.z.toFixed(3)}mm, got ${actualMax[2].toFixed(3)}mm`);
  }

  return { pass: errors.length === 0, errors };
}