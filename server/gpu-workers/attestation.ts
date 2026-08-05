import crypto from "node:crypto";

/**
 * Provider-agnostic GPU worker attestation.
 *
 * See docs/GPU_WORKER_CONNECTOR.md. The core admits a GPU runner from ANY
 * provider — Modal, RunPod, Vast, bare metal, a local workstation, or Azure once
 * a Pay-As-You-Go subscription exists — but only if the runner proves it is the
 * exact locked TRELLIS/Blender runtime.
 *
 * Provider identity (`provider`, `region`, `instanceType`) is recorded for cost
 * attribution and NEVER consulted by the admission decision. That is precisely
 * what makes the connector portable: a laptop and an H100 are judged by the same
 * rules.
 *
 * This module is deliberately PURE — no fs, no network, no clock beyond an
 * injected `now`. Every rule is therefore exhaustively testable, which matters
 * because each rule is the only thing standing between a customer charge and an
 * unverified binary producing their pet.
 */

const HEX64 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

/** TRELLIS.2-4B documented floor. Below 24 GiB the model cannot load. */
export const MIN_VRAM_BYTES = 24 * 1024 * 1024 * 1024;

/** Attestation is rejected if the worker clock differs by more than this. */
export const MAX_CLOCK_SKEW_MS = 300_000;

export interface WorkerAttestation {
  imageDigest?: unknown;
  imageRef?: unknown;
  repositoryRevision?: unknown;
  trellisSourceRevision?: unknown;
  trellisModelRevision?: unknown;
  modelManifestSha256?: unknown;
  modelBundleVerified?: unknown;
  cuda?: unknown;
  blender?: unknown;
  strictInHouseMode?: unknown;
  externalGeneratorsDisabled?: unknown;
  runtimeNetworkPolicy?: unknown;
  attestedAt?: unknown;
  nonce?: unknown;
  signature?: unknown;
  /** Recorded for cost attribution only. Never an admission input. */
  provider?: unknown;
  region?: unknown;
  instanceType?: unknown;
}

export interface AttestationPolicy {
  imageDigest: string;
  imageRef: string;
  repositoryRevision: string;
  trellisSourceRevision: string;
  trellisModelRevision: string;
  modelManifestSha256: string;
  blenderVersion: string;
  blenderRevision: string;
  minVramBytes?: number;
}

export interface AttestationResult {
  admitted: boolean;
  /** Stable machine-readable codes, in evaluation order. */
  violations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical signing payload. Key order is FIXED and explicit rather than derived
 * from Object.keys, because insertion order would silently change the signature
 * when a field is added. Provider metadata is excluded: it is untrusted and must
 * not be able to alter a valid signature.
 */
export function canonicalAttestationPayload(
  attestation: WorkerAttestation,
  nonce: string,
): string {
  const cuda = isRecord(attestation.cuda) ? attestation.cuda : {};
  const blender = isRecord(attestation.blender) ? attestation.blender : {};
  return JSON.stringify([
    ["imageDigest", attestation.imageDigest ?? null],
    ["imageRef", attestation.imageRef ?? null],
    ["repositoryRevision", attestation.repositoryRevision ?? null],
    ["trellisSourceRevision", attestation.trellisSourceRevision ?? null],
    ["trellisModelRevision", attestation.trellisModelRevision ?? null],
    ["modelManifestSha256", attestation.modelManifestSha256 ?? null],
    ["modelBundleVerified", attestation.modelBundleVerified ?? null],
    ["cuda.available", cuda.available ?? null],
    ["cuda.totalVramBytes", cuda.totalVramBytes ?? null],
    ["blender.version", blender.version ?? null],
    ["blender.revision", blender.revision ?? null],
    ["blender.bridgeConnected", blender.bridgeConnected ?? null],
    ["strictInHouseMode", attestation.strictInHouseMode ?? null],
    ["externalGeneratorsDisabled", attestation.externalGeneratorsDisabled ?? null],
    ["runtimeNetworkPolicy", attestation.runtimeNetworkPolicy ?? null],
    ["attestedAt", attestation.attestedAt ?? null],
    ["nonce", nonce],
  ]);
}

export function signAttestation(
  attestation: WorkerAttestation,
  nonce: string,
  secret: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(canonicalAttestationPayload(attestation, nonce))
    .digest("hex");
}

/**
 * Constant-time signature comparison.
 *
 * timingSafeEqual throws on length mismatch, which would itself leak length via
 * the exception path, so both sides are hashed to a fixed 32 bytes first.
 */
export function signatureMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(actual).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Evaluate a worker attestation against core policy.
 *
 * FAIL-CLOSED by construction: every rule is expressed as "add a violation
 * unless X is exactly right". A missing field, a wrong type, or an unexpected
 * value all produce a violation. There is no branch that admits by default, and
 * no field whose absence is tolerated.
 *
 * All rules are evaluated (rather than short-circuiting on the first failure) so
 * an operator debugging a new provider sees every problem at once.
 */
export function evaluateWorkerAttestation(
  attestation: WorkerAttestation,
  policy: AttestationPolicy,
  options: { nonce: string; secret: string; now?: number },
): AttestationResult {
  const violations: string[] = [];
  const now = options.now ?? Date.now();
  const minVram = policy.minVramBytes ?? MIN_VRAM_BYTES;

  const exact = (value: unknown, expected: string, shape: RegExp, code: string) => {
    if (typeof value !== "string" || !shape.test(value) || value !== expected) {
      violations.push(code);
    }
  };

  exact(attestation.imageDigest, policy.imageDigest, IMAGE_DIGEST, "IMAGE_DIGEST_MISMATCH");
  if (typeof attestation.imageRef !== "string" || attestation.imageRef !== policy.imageRef) {
    violations.push("IMAGE_REF_MISMATCH");
  }
  exact(attestation.repositoryRevision, policy.repositoryRevision, GIT_SHA, "REPOSITORY_REVISION_MISMATCH");
  exact(attestation.trellisSourceRevision, policy.trellisSourceRevision, GIT_SHA, "TRELLIS_SOURCE_REVISION_MISMATCH");
  exact(attestation.trellisModelRevision, policy.trellisModelRevision, GIT_SHA, "TRELLIS_MODEL_REVISION_MISMATCH");
  exact(attestation.modelManifestSha256, policy.modelManifestSha256, HEX64, "MODEL_MANIFEST_MISMATCH");

  if (attestation.modelBundleVerified !== true) violations.push("MODEL_BUNDLE_UNVERIFIED");

  // CUDA. A GPU that cannot hold the 4B model is refused before it can accept a
  // paid job and OOM halfway through.
  const cuda = isRecord(attestation.cuda) ? attestation.cuda : null;
  if (!cuda || cuda.available !== true) {
    violations.push("CUDA_UNAVAILABLE");
  }
  const vram = cuda?.totalVramBytes;
  if (typeof vram !== "number" || !Number.isFinite(vram) || vram < minVram) {
    violations.push("INSUFFICIENT_VRAM");
  }

  const blender = isRecord(attestation.blender) ? attestation.blender : null;
  if (!blender || blender.bridgeConnected !== true) {
    violations.push("BLENDER_BRIDGE_NOT_CONNECTED");
  }
  if (!blender || typeof blender.version !== "string" || blender.version !== policy.blenderVersion) {
    violations.push("BLENDER_VERSION_MISMATCH");
  }
  if (!blender
    || typeof blender.revision !== "string"
    || !GIT_SHA.test(blender.revision)
    || blender.revision !== policy.blenderRevision) {
    violations.push("BLENDER_REVISION_MISMATCH");
  }

  // In-house guarantees. These are the promise that no customer pet was quietly
  // routed through Tripo or any other external generator.
  if (attestation.strictInHouseMode !== true) violations.push("STRICT_INHOUSE_MODE_OFF");
  if (attestation.externalGeneratorsDisabled !== true) violations.push("EXTERNAL_GENERATOR_PATH_ENABLED");
  if (attestation.runtimeNetworkPolicy !== "offline") violations.push("RUNTIME_NETWORK_POLICY_NOT_OFFLINE");

  // Freshness. Without this a captured attestation from a good worker can be
  // replayed indefinitely by a bad one.
  const attestedAt = attestation.attestedAt;
  if (typeof attestedAt !== "number"
    || !Number.isFinite(attestedAt)
    || Math.abs(now - attestedAt) > MAX_CLOCK_SKEW_MS) {
    violations.push("ATTESTATION_STALE");
  }

  if (typeof attestation.nonce !== "string" || attestation.nonce !== options.nonce) {
    violations.push("NONCE_MISMATCH");
  }

  // Signature last: it is the most expensive check and the least informative on
  // its own. It is still mandatory — a correct body with a bad signature is
  // refused exactly like a malformed one.
  const expectedSignature = signAttestation(attestation, options.nonce, options.secret);
  if (!signatureMatches(expectedSignature, attestation.signature)) {
    violations.push("SIGNATURE_INVALID");
  }

  return { admitted: violations.length === 0, violations };
}

/**
 * Cost-attribution metadata. Extracted only AFTER admission and never consulted
 * during it. Values are clamped and type-checked because they originate from the
 * worker and may be attacker-controlled if the enrollment secret ever leaks.
 */
export function providerMetadata(attestation: WorkerAttestation): {
  provider: string;
  region: string;
  instanceType: string;
} {
  const safe = (value: unknown): string =>
    typeof value === "string" && /^[\w .:-]{1,64}$/.test(value) ? value : "unknown";
  return {
    provider: safe(attestation.provider),
    region: safe(attestation.region),
    instanceType: safe(attestation.instanceType),
  };
}
