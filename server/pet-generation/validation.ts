import crypto from "node:crypto";
import type { MeshProfile, PetGlbModelStageKind } from "./types";
import { meshProfilePolicy } from "./contracts";

/**
 * Deterministic GLB validators for CUSTOM_RIGGED_PET_GLB_V1.
 *
 * Real binary parsing — glTF 2.0 container + JSON chunk. No heuristics, no
 * placeholder passes. Every check either measures or reports UNMEASURED.
 *
 * Each result is tagged with the SALTI channel it will belong to at G10
 * (§4B.3 forward-compatibility). Tagging now makes G10 a wiring exercise.
 */

export type SaltiChannel = "G" | "T" | "P" | "S" | "M" | "R" | "A" | "X" | "Z";

export interface CheckResult {
  id: string;
  channel: SaltiChannel;
  critical: boolean;
  /** true = pass, false = fail, null = UNMEASURED (never a fabricated number) */
  passed: boolean | null;
  detail: string;
  measured?: Record<string, number | string>;
}

export interface ValidationReport {
  schemaVersion: "pawsome.pet-glb-validation.v1" | "pawsome.pet-glb-validation.v2";
  fileHash: string;
  fileSize: number;
  checks: CheckResult[];
  /** Independent hard gates — evaluated OUTSIDE any aggregate score. B-HDSR precursor. */
  hardGates: Record<string, boolean>;
  operatorReady: boolean;
  reasonCodes: string[];
  unmeasuredCount: number;
  createdAt: string;
  stage?: PetGlbModelStageKind;
  meshProfile?: MeshProfile;
  triangleCount?: number;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export interface ParsedGlb {
  json: any;
  binLength: number;
}

export class GlbParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlbParseError";
  }
}

/** Real GLB container parse. Throws GlbParseError on anything malformed. */
export function parseGlb(buf: Buffer): ParsedGlb {
  if (buf.length < 12) throw new GlbParseError("Buffer shorter than GLB header");
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new GlbParseError("Bad magic — not a GLB");
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new GlbParseError(`Unsupported glTF container version ${version}`);
  const declared = buf.readUInt32LE(8);
  if (declared !== buf.length) {
    throw new GlbParseError(`Declared length ${declared} != actual ${buf.length}`);
  }

  let offset = 12;
  let json: any = null;
  let binLength = 0;

  while (offset + 8 <= buf.length) {
    const chunkLen = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkLen;
    if (end > buf.length) throw new GlbParseError("Chunk overruns buffer");

    if (chunkType === JSON_CHUNK) {
      try {
        json = JSON.parse(buf.subarray(start, end).toString("utf8"));
      } catch (e: any) {
        throw new GlbParseError(`JSON chunk is not valid JSON: ${e.message}`);
      }
    } else if (chunkType === BIN_CHUNK) {
      binLength = chunkLen;
    }
    offset = end + ((4 - (chunkLen % 4)) % 4);
  }

  if (!json) throw new GlbParseError("No JSON chunk present");
  return { json, binLength };
}

function clipNames(json: any): string[] {
  return (json.animations || []).map((a: any, i: number) => a.name || `clip_${i}`);
}

function findClip(json: any, needle: string): any | undefined {
  return (json.animations || []).find((a: any) =>
    String(a.name || "").toLowerCase().includes(needle),
  );
}

/**
 * Runs the full deterministic validator suite.
 * `rigProfileJoints` comes from bonemap.json; pass [] to mark rig joint
 * coverage UNMEASURED rather than silently passing it.
 */
export function validatePetGlb(
  buf: Buffer,
  opts: { rigProfileJoints?: string[]; maxTriangles?: number } = {},
): ValidationReport {
  const checks: CheckResult[] = [];
  const reasonCodes: string[] = [];
  const fileHash = crypto.createHash("sha256").update(buf).digest("hex");

  const add = (c: CheckResult) => checks.push(c);

  let parsed: ParsedGlb | null = null;
  try {
    parsed = parseGlb(buf);
    add({ id: "glb_parses", channel: "X", critical: true, passed: true, detail: "glTF 2.0 container parsed" });
  } catch (e: any) {
    add({ id: "glb_parses", channel: "X", critical: true, passed: false, detail: e.message });
    reasonCodes.push("EXPORT_INVALID");
  }

  const json = parsed?.json;

  if (!json) {
    // Everything downstream is genuinely unmeasurable, not failed.
    for (const [id, channel] of [
      ["scene_exists", "X"], ["mesh_exists", "T"], ["materials_resolve", "M"],
      ["skin_exists", "R"], ["skeleton_nodes_exist", "S"], ["idle_clip_exists", "A"],
      ["walk_clip_exists", "A"], ["animation_targets_resolve", "A"],
      ["buffers_resolve", "X"], ["rig_joint_coverage", "R"], ["triangle_budget", "T"],
    ] as const) {
      add({ id, channel: channel as SaltiChannel, critical: true, passed: null, detail: "UNMEASURED — GLB did not parse" });
    }
  } else {
    const meshes = json.meshes || [];
    const nodes = json.nodes || [];
    const skins = json.skins || [];
    const materials = json.materials || [];
    const accessors = json.accessors || [];

    add({
      id: "scene_exists", channel: "X", critical: true,
      passed: Array.isArray(json.scenes) && json.scenes.length > 0,
      detail: `${(json.scenes || []).length} scene(s)`,
    });

    const triangleCount = meshes.reduce((sum: number, m: any) => {
      for (const p of m.primitives || []) {
        const idx = p.indices !== undefined ? accessors[p.indices] : null;
        if (idx?.count) sum += Math.floor(idx.count / 3);
      }
      return sum;
    }, 0);

    const meshOk = meshes.length > 0 && triangleCount > 0;
    add({
      id: "mesh_exists", channel: "T", critical: true, passed: meshOk,
      detail: meshOk ? `${meshes.length} mesh(es), ${triangleCount} triangles` : "empty geometry",
      measured: { meshes: meshes.length, triangles: triangleCount },
    });
    if (!meshOk) reasonCodes.push("TOPO_DEFORMATION");

    add({
      id: "materials_resolve", channel: "M", critical: false,
      passed: materials.length > 0,
      detail: `${materials.length} material(s)`,
      measured: { materials: materials.length },
    });
    if (!materials.length) reasonCodes.push("MATERIAL_UV");

    const skinOk = skins.length > 0;
    add({ id: "skin_exists", channel: "R", critical: true, passed: skinOk, detail: `${skins.length} skin(s)` });
    if (!skinOk) reasonCodes.push("RIG_HIERARCHY");

    const jointCount = skins.reduce((s: number, sk: any) => s + (sk.joints?.length || 0), 0);
    add({
      id: "skeleton_nodes_exist", channel: "S", critical: true,
      passed: jointCount > 0, detail: `${jointCount} joint node(s)`,
      measured: { joints: jointCount },
    });

    // Skin weights: every skinned primitive must carry JOINTS_0 + WEIGHTS_0.
    let skinnedPrims = 0, weightedPrims = 0;
    for (const m of meshes) {
      for (const p of m.primitives || []) {
        if (p.attributes?.JOINTS_0 !== undefined) {
          skinnedPrims++;
          if (p.attributes?.WEIGHTS_0 !== undefined) weightedPrims++;
        }
      }
    }
    const weightsOk = skinnedPrims > 0 && skinnedPrims === weightedPrims;
    add({
      id: "skin_weights_present", channel: "R", critical: true, passed: weightsOk,
      detail: `${weightedPrims}/${skinnedPrims} skinned primitives carry WEIGHTS_0`,
      measured: { skinnedPrims, weightedPrims },
    });
    if (!weightsOk) reasonCodes.push("RIG_WEIGHTS");

    const idle = findClip(json, "idle");
    const walk = findClip(json, "walk");
    add({
      id: "idle_clip_exists", channel: "A", critical: true, passed: Boolean(idle),
      detail: idle ? `idle clip "${idle.name}"` : `no idle clip; found [${clipNames(json).join(", ")}]`,
    });
    add({
      id: "walk_clip_exists", channel: "A", critical: true, passed: Boolean(walk),
      detail: walk ? `walk clip "${walk.name}"` : `no walk clip; found [${clipNames(json).join(", ")}]`,
    });
    if (!idle || !walk) reasonCodes.push("ANIM_RETARGET");

    // Every animation channel must target a node that exists.
    let badTargets = 0, totalChannels = 0;
    for (const anim of json.animations || []) {
      for (const ch of anim.channels || []) {
        totalChannels++;
        const t = ch.target?.node;
        if (t === undefined || !nodes[t]) badTargets++;
      }
    }
    add({
      id: "animation_targets_resolve", channel: "A", critical: true,
      passed: totalChannels > 0 && badTargets === 0,
      detail: `${totalChannels - badTargets}/${totalChannels} channels resolve`,
      measured: { totalChannels, badTargets },
    });
    if (badTargets > 0) reasonCodes.push("ANIM_RETARGET");

    // Buffers: GLB-embedded buffer must match the BIN chunk length.
    const buffers = json.buffers || [];
    const embedded = buffers.filter((b: any) => b.uri === undefined);
    const external = buffers.filter((b: any) => typeof b.uri === "string" && !b.uri.startsWith("data:"));
    const buffersOk = external.length === 0 && (embedded.length === 0 || (parsed!.binLength >= (embedded[0]?.byteLength ?? 0)));
    add({
      id: "buffers_resolve", channel: "X", critical: true, passed: buffersOk,
      detail: external.length ? `${external.length} external buffer dependency` : "all buffers self-contained",
      measured: { binLength: parsed!.binLength, external: external.length },
    });
    if (!buffersOk) reasonCodes.push("EXPORT_INVALID");

    // Rig joint coverage against the profile — UNMEASURED if no profile given.
    const profile = opts.rigProfileJoints ?? [];
    if (!profile.length) {
      add({ id: "rig_joint_coverage", channel: "R", critical: true, passed: null, detail: "UNMEASURED — no rig profile supplied" });
    } else {
      const present = new Set<string>();
      for (const sk of skins) for (const j of sk.joints || []) {
        const n = nodes[j]?.name;
        if (n) present.add(String(n).toLowerCase());
      }
      const missing = profile.filter((j) => !present.has(j.toLowerCase()));
      add({
        id: "rig_joint_coverage", channel: "R", critical: true, passed: missing.length === 0,
        detail: missing.length ? `missing joints: ${missing.join(", ")}` : `all ${profile.length} profile joints present`,
        measured: { required: profile.length, missing: missing.length },
      });
      if (missing.length) reasonCodes.push("RIG_HIERARCHY");
    }

    const maxTri = opts.maxTriangles ?? 250_000;
    add({
      id: "triangle_budget", channel: "T", critical: false,
      passed: triangleCount <= maxTri,
      detail: `${triangleCount} / ${maxTri}`,
      measured: { triangles: triangleCount, budget: maxTri },
    });
  }

  // ── Hard gates: independent booleans, evaluated outside any aggregate ──
  const by = (id: string) => checks.find((c) => c.id === id)?.passed;
  const hardGates: Record<string, boolean> = {
    glb_valid: by("glb_parses") === true,
    mesh_present: by("mesh_exists") === true,
    skeleton_present: by("skeleton_nodes_exist") === true,
    weights_intact: by("skin_weights_present") === true,
    idle_present: by("idle_clip_exists") === true,
    walk_present: by("walk_clip_exists") === true,
    animation_targets_valid: by("animation_targets_resolve") === true,
    buffers_self_contained: by("buffers_resolve") === true,
  };

  // An UNMEASURED critical check BLOCKS. It is never treated as a pass.
  const unmeasuredCritical = checks.filter((c) => c.critical && c.passed === null);
  const operatorReady =
    Object.values(hardGates).every(Boolean) && unmeasuredCritical.length === 0;

  if (unmeasuredCritical.length) reasonCodes.push("REPEATED_UNKNOWN");

  return {
    schemaVersion: "pawsome.pet-glb-validation.v1",
    fileHash,
    fileSize: buf.length,
    checks,
    hardGates,
    operatorReady,
    reasonCodes: [...new Set(reasonCodes)],
    unmeasuredCount: checks.filter((c) => c.passed === null).length,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Stage-aware validator for the customer-gated product.
 *
 * A correct blank base must not be rejected for lacking textures or a skin,
 * and a rig must not be accepted merely because a GLB parsed. Each stage adds
 * requirements without borrowing requirements from later products such as
 * animation.
 */
export function validatePetGlbStage(
  buf: Buffer,
  opts: {
    stage: PetGlbModelStageKind;
    meshProfile: MeshProfile;
    rigProfileJoints?: string[];
    /** A rigged output only needs texture evidence when this order purchased Texture. */
    requireTexture?: boolean;
  },
): ValidationReport {
  const checks: CheckResult[] = [];
  const reasonCodes: string[] = [];
  const fileHash = crypto.createHash("sha256").update(buf).digest("hex");
  const policy = meshProfilePolicy(opts.meshProfile);

  let parsed: ParsedGlb | null = null;
  try {
    parsed = parseGlb(buf);
    checks.push({
      id: "glb_parses", channel: "X", critical: true, passed: true,
      detail: "glTF 2.0 container parsed",
    });
  } catch (error: any) {
    checks.push({
      id: "glb_parses", channel: "X", critical: true, passed: false,
      detail: error.message,
    });
    reasonCodes.push("EXPORT_INVALID");
  }

  let triangleCount = 0;
  const json = parsed?.json;
  if (json) {
    const meshes = Array.isArray(json.meshes) ? json.meshes : [];
    const accessors = Array.isArray(json.accessors) ? json.accessors : [];
    const nodes = Array.isArray(json.nodes) ? json.nodes : [];
    const skins = Array.isArray(json.skins) ? json.skins : [];
    const materials = Array.isArray(json.materials) ? json.materials : [];
    const textures = Array.isArray(json.textures) ? json.textures : [];
    const images = Array.isArray(json.images) ? json.images : [];

    const positionAccessors: any[] = [];

    for (const mesh of meshes) {
      for (const primitive of mesh.primitives || []) {
        const indexAccessor = primitive.indices !== undefined ? accessors[primitive.indices] : null;
        const positionAccessor = primitive.attributes?.POSITION !== undefined
          ? accessors[primitive.attributes.POSITION]
          : null;
        if (positionAccessor) positionAccessors.push(positionAccessor);
        const vertexOrIndexCount = Number(indexAccessor?.count || positionAccessor?.count || 0);
        const mode = primitive.mode ?? 4;
        if (mode === 4) triangleCount += Math.floor(vertexOrIndexCount / 3);
        else if (mode === 5 || mode === 6) triangleCount += Math.max(0, vertexOrIndexCount - 2);
      }
    }

    const scenePass = Array.isArray(json.scenes) && json.scenes.length > 0;
    checks.push({
      id: "scene_exists", channel: "X", critical: true, passed: scenePass,
      detail: `${(json.scenes || []).length} scene(s)`,
    });
    const meshPass = meshes.length > 0 && triangleCount > 0;
    checks.push({
      id: "mesh_exists", channel: "T", critical: true, passed: meshPass,
      detail: `${meshes.length} mesh(es), ${triangleCount} measured triangles`,
      measured: { meshes: meshes.length, triangles: triangleCount },
    });
    const budgetPass = triangleCount > 0 && triangleCount <= policy.maxTriangles;
    checks.push({
      id: "triangle_budget", channel: "T", critical: false, passed: budgetPass,
      detail: `${triangleCount} / ${policy.maxTriangles} advisory target for ${opts.meshProfile}`,
      measured: { triangles: triangleCount, budget: policy.maxTriangles },
    });

    const finiteVector = (value: unknown, length: number): value is number[] =>
      Array.isArray(value) && value.length === length && value.every((item) => Number.isFinite(item));
    const boundedPositions = positionAccessors.filter((accessor) =>
      finiteVector(accessor?.min, 3) && finiteVector(accessor?.max, 3));
    const boundsLo = [0, 1, 2].map((axis) =>
      Math.min(...boundedPositions.map((accessor) => Number(accessor.min[axis]))));
    const boundsHi = [0, 1, 2].map((axis) =>
      Math.max(...boundedPositions.map((accessor) => Number(accessor.max[axis]))));
    const boundsSize = boundsHi.map((value, axis) => value - boundsLo[axis]);
    const boundsPass = boundedPositions.length === positionAccessors.length
      && boundedPositions.length > 0
      && boundsSize.every((value) => Number.isFinite(value) && value > 0);
    checks.push({
      id: "geometry_bounds", channel: "G", critical: true, passed: boundsPass,
      detail: boundsPass
        ? `local bounds ${boundsSize.map((value) => value.toFixed(4)).join(" × ")} glTF units`
        : "position accessors do not contain finite, non-zero bounds",
      measured: boundsPass ? {
        width: boundsSize[0], height: boundsSize[1], depth: boundsSize[2],
      } : undefined,
    });
    if (!boundsPass) reasonCodes.push("BOUNDS_UNMEASURED");

    let invalidTransforms = 0;
    for (const node of nodes) {
      if (node.translation !== undefined && !finiteVector(node.translation, 3)) invalidTransforms++;
      if (node.rotation !== undefined && !finiteVector(node.rotation, 4)) invalidTransforms++;
      if (node.scale !== undefined && !finiteVector(node.scale, 3)) invalidTransforms++;
      if (node.matrix !== undefined && !finiteVector(node.matrix, 16)) invalidTransforms++;
    }
    checks.push({
      id: "finite_transforms", channel: "X", critical: true, passed: invalidTransforms === 0,
      detail: invalidTransforms === 0 ? `${nodes.length} node transform(s) are finite` : `${invalidTransforms} invalid node transform(s)`,
      measured: { nodes: nodes.length, invalidTransforms },
    });
    if (invalidTransforms) reasonCodes.push("INVALID_TRANSFORM");

    const buffers = Array.isArray(json.buffers) ? json.buffers : [];
    const externalBuffers = buffers.filter((buffer: any) =>
      typeof buffer.uri === "string" && !buffer.uri.startsWith("data:"));
    const buffersPass = externalBuffers.length === 0;
    checks.push({
      id: "buffers_self_contained", channel: "X", critical: true, passed: buffersPass,
      detail: buffersPass ? "all buffers are embedded" : `${externalBuffers.length} external buffers`,
    });
    if (!buffersPass) reasonCodes.push("EXTERNAL_BUFFER");

    if (opts.stage === "texture" || (opts.stage === "rig" && opts.requireTexture === true)) {
      const texturePass = materials.length > 0 && (textures.length > 0 || images.length > 0);
      checks.push({
        id: "texture_present", channel: "M", critical: true, passed: texturePass,
        detail: `${materials.length} material(s), ${textures.length} texture(s), ${images.length} image(s)`,
        measured: { materials: materials.length, textures: textures.length, images: images.length },
      });
      if (!texturePass) reasonCodes.push("TEXTURE_MISSING");
    }

    if (opts.stage === "rig") {
      const jointCount = skins.reduce((sum: number, skin: any) => sum + (skin.joints?.length || 0), 0);
      const skinPass = skins.length > 0 && jointCount > 0;
      checks.push({
        id: "skin_exists", channel: "R", critical: true, passed: skinPass,
        detail: `${skins.length} skin(s), ${jointCount} joint(s)`,
        measured: { skins: skins.length, joints: jointCount },
      });

      let skinnedPrimitives = 0;
      let weightedPrimitives = 0;
      for (const mesh of meshes) {
        for (const primitive of mesh.primitives || []) {
          if (primitive.attributes?.JOINTS_0 !== undefined) {
            skinnedPrimitives++;
            if (primitive.attributes?.WEIGHTS_0 !== undefined) weightedPrimitives++;
          }
        }
      }
      const weightsPass = skinnedPrimitives > 0 && skinnedPrimitives === weightedPrimitives;
      checks.push({
        id: "skin_weights_present", channel: "R", critical: true, passed: weightsPass,
        detail: `${weightedPrimitives}/${skinnedPrimitives} skinned primitives include weights`,
        measured: { skinnedPrimitives, weightedPrimitives },
      });

      const profile = opts.rigProfileJoints || [];
      if (profile.length) {
        const present = new Set<string>();
        for (const skin of skins) {
          for (const joint of skin.joints || []) {
            const name = nodes[joint]?.name;
            if (name) present.add(String(name).toLowerCase());
          }
        }
        const missing = profile.filter((joint) => !present.has(joint.toLowerCase()));
        checks.push({
          id: "rig_joint_coverage", channel: "R", critical: true,
          passed: missing.length === 0,
          detail: missing.length ? `missing joints: ${missing.join(", ")}` : `all ${profile.length} required joints present`,
          measured: { required: profile.length, missing: missing.length },
        });
      }

      if (!skinPass) reasonCodes.push("RIG_HIERARCHY");
      if (!weightsPass) reasonCodes.push("RIG_WEIGHTS");

      const animations = Array.isArray(json.animations) ? json.animations : [];
      const animationNames = animations.map((animation: any) => String(animation?.name || "").toLowerCase());
      const idlePass = animationNames.some((name: string) => name.includes("idle"));
      const walkPass = animationNames.some((name: string) => name.includes("walk"));
      checks.push({
        id: "idle_clip_exists", channel: "A", critical: true, passed: idlePass,
        detail: idlePass ? "idle clip present" : "idle clip missing",
      });
      checks.push({
        id: "walk_clip_exists", channel: "A", critical: true, passed: walkPass,
        detail: walkPass ? "walk clip present" : "walk clip missing",
      });
      let animationChannels = 0;
      let invalidAnimationTargets = 0;
      for (const animation of animations) {
        for (const channel of animation?.channels || []) {
          animationChannels++;
          const targetNode = channel?.target?.node;
          if (!Number.isInteger(targetNode) || !nodes[targetNode]) invalidAnimationTargets++;
        }
      }
      const animationTargetsPass = animationChannels > 0 && invalidAnimationTargets === 0;
      checks.push({
        id: "animation_targets_resolve", channel: "A", critical: true, passed: animationTargetsPass,
        detail: `${animationChannels - invalidAnimationTargets}/${animationChannels} animation channel target(s) resolve`,
        measured: { animationChannels, invalidAnimationTargets },
      });
      if (!idlePass || !walkPass || !animationTargetsPass) reasonCodes.push("ANIM_RETARGET");
    }
  } else {
    for (const id of ["scene_exists", "mesh_exists", "buffers_self_contained"]) {
      checks.push({
        id, channel: id.includes("mesh") || id.includes("triangle") ? "T" : "X",
        critical: true, passed: null, detail: "UNMEASURED — GLB did not parse",
      });
    }
  }

  const criticalFailures = checks.filter((check) => check.critical && check.passed !== true);
  const hardGates = Object.fromEntries(
    checks.filter((check) => check.critical).map((check) => [check.id, check.passed === true]),
  );
  if (criticalFailures.some((check) => check.passed === null)) reasonCodes.push("UNMEASURED");

  return {
    schemaVersion: "pawsome.pet-glb-validation.v2",
    stage: opts.stage,
    meshProfile: opts.meshProfile,
    triangleCount,
    fileHash,
    fileSize: buf.length,
    checks,
    hardGates,
    operatorReady: criticalFailures.length === 0,
    reasonCodes: [...new Set(reasonCodes)],
    unmeasuredCount: checks.filter((check) => check.passed === null).length,
    createdAt: new Date().toISOString(),
  };
}
