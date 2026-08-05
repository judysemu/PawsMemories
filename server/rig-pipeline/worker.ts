import crypto from "node:crypto";
import { z } from "zod";
import { NodeIO, type Node } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  MAX_BONE_INFLUENCES,
  MOBILE_JOINT_BUDGET,
  MOBILE_TEXTURE_MAX,
  MOBILE_TRIANGLE_BUDGET,
} from "./types";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const Base64Schema = z.string().min(4).max(140_000_000);
const FUSED_PRINT_MAX_BYTES = 8 * 1024 * 1024;
const RuleSchema = z.object({
  rule: z.string().min(1).max(120),
  pass: z.boolean(),
  detail: z.string().min(1).max(2_000),
  measured: z.union([z.number().finite(), z.string().max(500)]).optional(),
}).strict();

const FacialTargetSchema = z.object({
  name: z.string().min(1).max(120),
  canonicalName: z.string().min(1).max(120).nullable(),
  displacedVertexCount: z.number().int().nonnegative(),
  maxDisplacement: z.number().finite().nonnegative(),
  localityPass: z.boolean(),
  deformationPass: z.boolean(),
}).strict();

const RenderSchema = z.object({
  role: z.enum(["facial_render_front", "facial_render_three_quarter"]),
  pngBase64: Base64Schema,
  sha256: Sha256Schema,
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
}).strict();

const FusedPrintSchema = z.object({
  glbBase64: Base64Schema,
  sha256: Sha256Schema,
  sizeBytes: z.number().int().positive().max(FUSED_PRINT_MAX_BYTES),
  validatorVersion: z.string().min(1).max(120),
  metrics: z.object({
    objectCount: z.literal(1),
    connectedComponents: z.literal(1),
    triangleCount: z.number().int().positive().max(1_000_000),
    nonManifoldEdges: z.literal(0),
    finiteGeometry: z.literal(true),
    volumeCubicMeters: z.number().finite().positive(),
  }).strict(),
  rules: z.array(RuleSchema).min(1).max(30),
  overallPass: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.rules.some((rule) => !rule.pass)) {
    ctx.addIssue({ code: "custom", path: ["rules"], message: "A fused print artifact may only be returned when every measured print rule passes" });
  }
});

const FusedPrintFailureSchema = z.object({
  code: z.string().regex(/^PRINT_[A-Z0-9_]+$/).max(120),
  message: z.string().min(1).max(500),
}).strict();

const AccessoryResultSchema = z.object({
  accessoryUuid: z.string().uuid(),
  attachmentBone: z.string().min(1).max(120),
  transform: z.object({
    position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
    rotation: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
    scale: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  }).strict(),
  floatingDistance: z.number().finite().nonnegative(),
  penetrationDepth: z.number().finite().nonnegative(),
  animationSweepPass: z.boolean(),
  polygonBudgetPass: z.boolean(),
  printClearanceMm: z.number().finite().nonnegative(),
  glbBase64: Base64Schema.optional(),
  sha256: Sha256Schema.optional(),
  sizeBytes: z.number().int().positive().max(100 * 1024 * 1024).optional(),
}).strict().superRefine((value, ctx) => {
  const outputParts = [value.glbBase64, value.sha256, value.sizeBytes].filter((part) => part !== undefined).length;
  if (outputParts !== 0 && outputParts !== 3) {
    ctx.addIssue({ code: "custom", message: "Accessory output bytes, hash, and size must be supplied together" });
  }
});

export const RigWorkerRequestSchema = z.object({
  contractVersion: z.literal(1),
  jobUuid: z.string().uuid(),
  attemptUuid: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(180),
  profileId: z.string().min(1).max(120),
  classification: z.enum(["biped", "quadruped"]),
  requestFacial: z.boolean(),
  requestedFacialTargets: z.array(z.string().min(1).max(120)).max(20),
  source: z.object({
    locator: z.string().url().max(4_096),
    sha256: Sha256Schema,
    sizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  }).strict(),
  budgets: z.object({
    maxJoints: z.number().int().positive().max(512),
    maxInfluences: z.number().int().positive().max(8),
    maxTriangles: z.number().int().positive().max(1_000_000),
    maxTextureDimension: z.number().int().positive().max(16_384),
  }).strict(),
  accessories: z.array(z.object({
    accessoryUuid: z.string().uuid(),
    attachmentBone: z.string().min(1).max(120),
    locator: z.string().url().max(4_096),
    sha256: Sha256Schema,
    sizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  }).strict()).max(20),
}).strict();

export type RigWorkerRequest = z.infer<typeof RigWorkerRequestSchema>;

export const RigWorkerResultSchema = z.object({
  contractVersion: z.literal(1),
  jobUuid: z.string().uuid(),
  attemptUuid: z.string().uuid(),
  sourceSha256: Sha256Schema,
  output: z.object({
    glbBase64: Base64Schema,
    sha256: Sha256Schema,
    sizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  }).strict(),
  rig: z.object({
    validatorVersion: z.string().min(1).max(120),
    metrics: z.object({
      boneCount: z.number().int().nonnegative(),
      skinnedVertexCount: z.number().int().nonnegative(),
      maxInfluences: z.number().int().nonnegative(),
      unweightedIslands: z.number().int().nonnegative(),
      bindMatrixValid: z.boolean(),
      animationSweepPass: z.boolean(),
      silhouetteDeviation: z.number().finite().nonnegative(),
      triangleCount: z.number().int().nonnegative(),
      textureMaxDimension: z.number().int().nonnegative(),
      jointCount: z.number().int().nonnegative(),
      boneNames: z.array(z.string().min(1).max(120)).max(512),
    }).strict(),
    rules: z.array(RuleSchema).min(1).max(100),
    overallPass: z.boolean(),
  }).strict(),
  facial: z.object({
    capability: z.enum(["full", "partial", "body_only", "unsupported"]),
    targets: z.array(FacialTargetSchema).max(256),
    canonicalMap: z.record(z.string(), z.string()),
    hasBlink: z.boolean(),
    hasJaw: z.boolean(),
    hasEyeControls: z.boolean(),
    rules: z.array(RuleSchema).max(100),
  }).strict(),
  renders: z.array(RenderSchema).max(2),
  accessories: z.array(AccessoryResultSchema).max(20),
  fusedPrint: FusedPrintSchema.optional(),
  fusedPrintFailure: FusedPrintFailureSchema.optional(),
  warnings: z.array(z.string().max(1_000)).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.rig.overallPass !== value.rig.rules.every((rule) => rule.pass)) {
    ctx.addIssue({ code: "custom", path: ["rig", "overallPass"], message: "overallPass must equal the measured rule aggregate" });
  }
  const passedTargets = value.facial.targets.filter((target) => target.deformationPass && target.localityPass);
  const canonical = new Set(passedTargets.map((target) => target.canonicalName).filter(Boolean));
  const fullVisemes = ["A", "B", "C", "D", "E", "F", "G", "H", "X"].every((name) => canonical.has(name));
  if (value.facial.capability === "full" && (!fullVisemes || !value.facial.hasBlink || !value.facial.hasJaw)) {
    ctx.addIssue({ code: "custom", path: ["facial", "capability"], message: "Full facial capability requires nine measured visemes, jaw, and bilateral blink" });
  }
  if (["full", "partial"].includes(value.facial.capability) && passedTargets.length === 0) {
    ctx.addIssue({ code: "custom", path: ["facial", "targets"], message: "Facial capability requires measured localized deformation" });
  }
  if (value.fusedPrint && value.fusedPrintFailure) {
    ctx.addIssue({ code: "custom", path: ["fusedPrint"], message: "A fused print result and failure are mutually exclusive" });
  }
});

export type RigWorkerResult = z.infer<typeof RigWorkerResultSchema>;

export interface RigWorkerPort {
  process(request: RigWorkerRequest): Promise<RigWorkerResult>;
}

const MAX_RESPONSE_BYTES = 150 * 1024 * 1024;

export class HttpRigWorkerClient implements RigWorkerPort {
  constructor(
    private readonly baseUrl = process.env.BLENDER_WORKER_URL || "http://localhost:8080",
    private readonly sharedSecret = process.env.WORKER_SHARED_SECRET || "",
  ) {}

  async process(input: RigWorkerRequest): Promise<RigWorkerResult> {
    const request = RigWorkerRequestSchema.parse(input);
    const endpoint = resolveWorkerEndpoint(this.baseUrl);
    if (!this.sharedSecret) throw new Error("WORKER_SHARED_SECRET is required for the rig worker");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": this.sharedSecret },
        body: JSON.stringify(request),
        signal: controller.signal,
        redirect: "error",
      });
      const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
      if (!response.ok) throw new Error(`Rig worker failed (${response.status}): ${safeWorkerError(text)}`);
      return RigWorkerResultSchema.parse(JSON.parse(text));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRigWorkerRequest(input: Omit<RigWorkerRequest, "contractVersion" | "requestedFacialTargets" | "budgets">): RigWorkerRequest {
  return RigWorkerRequestSchema.parse({
    ...input,
    contractVersion: 1,
    requestedFacialTargets: ["A", "B", "C", "D", "E", "F", "G", "H", "X", "jawOpen", "eyeBlinkLeft", "eyeBlinkRight"],
    budgets: {
      maxJoints: MOBILE_JOINT_BUDGET,
      maxInfluences: MAX_BONE_INFLUENCES,
      maxTriangles: MOBILE_TRIANGLE_BUDGET,
      maxTextureDimension: MOBILE_TEXTURE_MAX,
    },
  });
}

export function verifyWorkerOutput(request: RigWorkerRequest, result: RigWorkerResult): Buffer {
  if (result.jobUuid !== request.jobUuid || result.attemptUuid !== request.attemptUuid) throw new Error("Rig worker result identity mismatch");
  if (result.sourceSha256 !== request.source.sha256) throw new Error("Rig worker source hash mismatch");
  const output = Buffer.from(result.output.glbBase64, "base64");
  if (output.length !== result.output.sizeBytes) throw new Error("Rig worker output byte count mismatch");
  const hash = crypto.createHash("sha256").update(output).digest("hex");
  if (hash !== result.output.sha256) throw new Error("Rig worker output hash mismatch");
  if (output.length < 20 || output.subarray(0, 4).toString("ascii") !== "glTF" || output.readUInt32LE(4) !== 2) {
    throw new Error("Rig worker output is not a GLB v2 file");
  }
  if (output.readUInt32LE(8) !== output.length) throw new Error("Rig worker GLB declared length mismatch");
  if (request.accessories.length === 0 && (result.fusedPrint || result.fusedPrintFailure)) {
    throw new Error("Rig worker returned a fused print result without requested accessories");
  }
  if (request.accessories.length > 0 && !result.fusedPrint && !result.fusedPrintFailure) {
    throw new Error("Rig worker omitted the required fused print result or typed failure");
  }
  return output;
}

export interface FusedPrintInspection {
  sceneCount: number;
  meshCount: number;
  objectCount: number;
  connectedComponents: number;
  triangleCount: number;
  nonManifoldEdges: number;
  finiteGeometry: boolean;
  volumeCubicMeters: number;
}

export async function verifyFusedPrintOutput(
  request: RigWorkerRequest,
  result: RigWorkerResult,
  displayOutput: Buffer,
): Promise<{ buffer: Buffer; inspection: FusedPrintInspection } | null> {
  if (!result.fusedPrint) return null;
  if (request.accessories.length === 0) throw new Error("Fused print output requires at least one requested accessory");

  const bytes = Buffer.from(result.fusedPrint.glbBase64, "base64");
  if (bytes.length !== result.fusedPrint.sizeBytes) throw new Error("Fused print output byte count mismatch");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (hash !== result.fusedPrint.sha256) throw new Error("Fused print output hash mismatch");
  if (bytes.equals(displayOutput) || hash === result.output.sha256) {
    throw new Error("Fused print output reuses the rigged display GLB");
  }
  if (result.fusedPrint.rules.some((rule) => !rule.pass) || !result.fusedPrint.overallPass) {
    throw new Error("Fused print output has nonpassing print rules");
  }

  const inspection = await inspectFusedPrintGlb(bytes);
  const measured = result.fusedPrint.metrics;
  if (inspection.objectCount !== measured.objectCount
    || inspection.connectedComponents !== measured.connectedComponents
    || inspection.triangleCount !== measured.triangleCount
    || inspection.nonManifoldEdges !== measured.nonManifoldEdges
    || inspection.finiteGeometry !== measured.finiteGeometry
    || Math.abs(inspection.volumeCubicMeters - measured.volumeCubicMeters) > Math.max(1e-9, measured.volumeCubicMeters * 1e-5)) {
    throw new Error("Fused print measurements do not match the independently reopened GLB");
  }
  return { buffer: bytes, inspection };
}

export async function inspectFusedPrintGlb(output: Buffer): Promise<FusedPrintInspection> {
  let document;
  try {
    document = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(new Uint8Array(output));
  } catch (error) {
    throw new Error(`Fused print GLB could not be reopened: ${(error as Error).message}`);
  }

  const root = document.getRoot();
  const scenes = root.listScenes();
  const meshNodes = root.listNodes().filter((node) => node.getMesh());
  const meshes = root.listMeshes();
  if (scenes.length === 0 || meshNodes.length !== 1 || meshes.length !== 1) {
    throw new Error("Fused print GLB must contain exactly one printable mesh object");
  }
  if (root.listSkins().length > 0 || root.listAnimations().length > 0) {
    throw new Error("Fused print GLB must not depend on skins or animations");
  }
  const worldMatrix = meshNodes[0].getWorldMatrix();
  if (Array.from(worldMatrix).some((value) => !Number.isFinite(Number(value)))) {
    throw new Error("Fused print GLB contains a non-finite object transform");
  }

  let triangleCount = 0;
  let nonManifoldEdges = 0;
  let finiteGeometry = true;
  let signedVolume = 0;
  const adjacency = new Map<number, Set<number>>();
  let vertexOffset = 0;
  for (const mesh of meshes) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      if (!position) throw new Error("Fused print GLB primitive has no POSITION data");
      const positions = position.getArray();
      if (!positions || Array.from(positions).some((value) => !Number.isFinite(Number(value)))) finiteGeometry = false;
      const vertexCount = position.getCount();
      for (let index = 0; index < vertexCount; index++) adjacency.set(vertexOffset + index, new Set());
      const indices = primitive.getIndices()?.getArray();
      const sequence = indices ? Array.from(indices, Number) : Array.from({ length: vertexCount }, (_, index) => index);
      if (sequence.length % 3 !== 0) throw new Error("Fused print GLB contains non-triangle geometry");
      if (sequence.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
        throw new Error("Fused print GLB contains an out-of-range vertex index");
      }
      triangleCount += sequence.length / 3;
      const edgeUse = new Map<string, number>();
      for (let index = 0; index < sequence.length; index += 3) {
        const triangle = sequence.slice(index, index + 3).map((value) => value + vertexOffset);
        if (new Set(triangle).size !== 3) throw new Error("Fused print GLB contains a degenerate indexed triangle");
        for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
          adjacency.get(a)?.add(b);
          adjacency.get(b)?.add(a);
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
        }
        const local = sequence.slice(index, index + 3);
        const point = (vertex: number) => {
          const x = Number(positions[vertex * 3]);
          const y = Number(positions[vertex * 3 + 1]);
          const z = Number(positions[vertex * 3 + 2]);
          return [
            worldMatrix[0] * x + worldMatrix[4] * y + worldMatrix[8] * z + worldMatrix[12],
            worldMatrix[1] * x + worldMatrix[5] * y + worldMatrix[9] * z + worldMatrix[13],
            worldMatrix[2] * x + worldMatrix[6] * y + worldMatrix[10] * z + worldMatrix[14],
          ];
        };
        const [a, b, c] = local.map(point);
        signedVolume += (
          a[0] * (b[1] * c[2] - b[2] * c[1])
          - a[1] * (b[0] * c[2] - b[2] * c[0])
          + a[2] * (b[0] * c[1] - b[1] * c[0])
        ) / 6;
      }
      nonManifoldEdges += [...edgeUse.values()].filter((count) => count !== 2).length;
      vertexOffset += vertexCount;
    }
  }

  let connectedComponents = 0;
  const visited = new Set<number>();
  for (const vertex of adjacency.keys()) {
    if (visited.has(vertex)) continue;
    connectedComponents += 1;
    const stack = [vertex];
    while (stack.length) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbor of adjacency.get(current) || []) if (!visited.has(neighbor)) stack.push(neighbor);
    }
  }

  const volumeCubicMeters = Math.abs(signedVolume);
  if (!finiteGeometry || triangleCount <= 0 || nonManifoldEdges !== 0 || connectedComponents !== 1
    || !Number.isFinite(volumeCubicMeters) || volumeCubicMeters <= 1e-12) {
    throw new Error("Fused print GLB failed finite, watertight, connected, or solid-volume verification");
  }
  return {
    sceneCount: scenes.length,
    meshCount: meshes.length,
    objectCount: meshNodes.length,
    connectedComponents,
    triangleCount,
    nonManifoldEdges,
    finiteGeometry,
    volumeCubicMeters,
  };
}

export interface RigGlbInspection {
  sceneCount: number;
  meshCount: number;
  skinCount: number;
  jointCount: number;
  skinnedMeshCount: number;
  morphTargetCount: number;
  morphTargetNames: string[];
}

export async function inspectRiggedGlb(output: Buffer, result: RigWorkerResult): Promise<RigGlbInspection> {
  let document;
  try {
    document = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(new Uint8Array(output));
  } catch (error) {
    throw new Error(`Rig worker GLB could not be reopened: ${(error as Error).message}`);
  }

  const root = document.getRoot();
  const scenes = root.listScenes();
  const meshes = root.listMeshes();
  const skins = root.listSkins();
  const joints = new Set<Node>();
  for (const skin of skins) for (const joint of skin.listJoints()) joints.add(joint);
  const skinnedMeshCount = root.listNodes().filter((node) => node.getMesh() && node.getSkin()).length;
  let morphTargetCount = 0;
  const morphTargetNames = new Set<string>();

  for (const mesh of meshes) {
    const extras = mesh.getExtras() as Record<string, unknown>;
    const names = Array.isArray(extras?.targetNames) ? extras.targetNames : [];
    for (const name of names) if (typeof name === "string" && name.length > 0) morphTargetNames.add(name);
    for (const primitive of mesh.listPrimitives()) {
      if (!primitive.getAttribute("POSITION")) throw new Error("Rig worker GLB contains a primitive without POSITION data");
      if (primitive.getAttribute("JOINTS_0") && primitive.getAttribute("WEIGHTS_0")) {
        const weights = primitive.getAttribute("WEIGHTS_0")?.getArray();
        if (weights && Array.from(weights).some((value) => !Number.isFinite(Number(value)))) {
          throw new Error("Rig worker GLB contains non-finite skin weights");
        }
      }
      const targets = primitive.listTargets();
      morphTargetCount += targets.length;
      for (const target of targets) {
        const name = target.getAttribute("POSITION")?.getName();
        if (name) morphTargetNames.add(name);
      }
    }
  }

  for (const joint of joints) {
    const transform = [...joint.getTranslation(), ...joint.getRotation(), ...joint.getScale()];
    if (transform.some((value) => !Number.isFinite(value))) throw new Error("Rig worker GLB contains a non-finite joint transform");
  }

  if (scenes.length === 0 || meshes.length === 0) throw new Error("Rig worker GLB has no renderable scene geometry");
  if (skins.length === 0 || joints.size < 4 || skinnedMeshCount === 0) throw new Error("Rig worker GLB has no usable skin binding");
  if (joints.size !== result.rig.metrics.jointCount || result.rig.metrics.boneCount !== result.rig.metrics.jointCount) {
    throw new Error("Rig worker measured joint count does not match the reopened GLB");
  }

  if (["full", "partial"].includes(result.facial.capability)) {
    const reportedNames = result.facial.targets
      .filter((target) => target.deformationPass && target.localityPass)
      .map((target) => target.name);
    if (morphTargetCount === 0 || reportedNames.some((name) => !morphTargetNames.has(name))) {
      throw new Error("Rig worker facial targets did not survive GLB export");
    }
  }

  return {
    sceneCount: scenes.length,
    meshCount: meshes.length,
    skinCount: skins.length,
    jointCount: joints.size,
    skinnedMeshCount,
    morphTargetCount,
    morphTargetNames: [...morphTargetNames].sort(),
  };
}

export function canonicalWorkerHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resolveWorkerEndpoint(baseUrl: string): string {
  const url = new URL("/rig-pipeline/process", baseUrl);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("Rig worker must use HTTPS in production");
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Invalid rig worker protocol");
  return url.toString();
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("Rig worker response exceeds the configured byte limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Rig worker response exceeds the configured byte limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function safeWorkerError(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return String(parsed.error || parsed.code || "Worker request failed").slice(0, 500);
  } catch {
    return "Worker request failed";
  }
}
