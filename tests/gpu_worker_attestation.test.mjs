import assert from "node:assert/strict";
import { test } from "node:test";

const {
  evaluateWorkerAttestation,
  signAttestation,
  canonicalAttestationPayload,
  providerMetadata,
  MIN_VRAM_BYTES,
  MAX_CLOCK_SKEW_MS,
} = await import("../server/gpu-workers/attestation.ts");

const SECRET = "enrollment-secret-under-test";
const NONCE = "b6f1c0d2e3a4958677889900aabbccdd";
const NOW = 1_785_900_000_000;

const POLICY = {
  imageDigest: "sha256:" + "a".repeat(64),
  imageRef: "paws-trellis2:75fbf018-b74ca0c",
  repositoryRevision: "b".repeat(40),
  trellisSourceRevision: "75fbf0183001ed9876c8dbb35de6b68552ee08bd",
  trellisModelRevision: "af44b45f2e35a493886929c6d786e563ec68364d",
  modelManifestSha256:
    "e3a4d702026090228807307c073f4171dbefd4db456a28a92e8a014669c0819c",
  blenderVersion: "5.1.2",
  blenderRevision: "e".repeat(40),
};

/** A worker that should be admitted. Every test mutates one thing from here. */
function goodAttestation(overrides = {}) {
  return {
    imageDigest: POLICY.imageDigest,
    imageRef: POLICY.imageRef,
    repositoryRevision: POLICY.repositoryRevision,
    trellisSourceRevision: POLICY.trellisSourceRevision,
    trellisModelRevision: POLICY.trellisModelRevision,
    modelManifestSha256: POLICY.modelManifestSha256,
    modelBundleVerified: true,
    cuda: { available: true, totalVramBytes: 80 * 1024 * 1024 * 1024 },
    blender: {
      version: POLICY.blenderVersion,
      revision: POLICY.blenderRevision,
      bridgeConnected: true,
    },
    strictInHouseMode: true,
    externalGeneratorsDisabled: true,
    runtimeNetworkPolicy: "offline",
    attestedAt: NOW,
    nonce: NONCE,
    provider: "modal",
    region: "us-east",
    instanceType: "H100",
    ...overrides,
  };
}

function sign(attestation, secret = SECRET, nonce = NONCE) {
  return { ...attestation, signature: signAttestation(attestation, nonce, secret) };
}

function evaluate(attestation, opts = {}) {
  return evaluateWorkerAttestation(attestation, POLICY, {
    nonce: NONCE,
    secret: SECRET,
    now: NOW,
    ...opts,
  });
}

test("a correctly attested worker is admitted", () => {
  const result = evaluate(sign(goodAttestation()));
  assert.deepEqual(result.violations, []);
  assert.equal(result.admitted, true);
});

// ── The portability property this whole connector exists for ────────────────
// Provider identity must not influence admission. If it did, the core would be
// coupled to a vendor and the Azure deadlock would simply repeat elsewhere.

test("admission is identical across every provider — the portability guarantee", () => {
  for (const provider of ["modal", "runpod", "vast.ai", "lambda", "bare-metal", "azure", "localhost"]) {
    const result = evaluate(sign(goodAttestation({ provider, region: "anywhere" })));
    assert.equal(result.admitted, true, `${provider} should be admitted on identical proof`);
  }
});

test("provider metadata cannot rescue a worker that fails the runtime proof", () => {
  const result = evaluate(sign(goodAttestation({ provider: "azure", cuda: { available: false } })));
  assert.equal(result.admitted, false);
  assert.ok(result.violations.includes("CUDA_UNAVAILABLE"));
});

test("provider metadata is sanitised and defaults to unknown", () => {
  assert.deepEqual(providerMetadata(goodAttestation()), {
    provider: "modal", region: "us-east", instanceType: "H100",
  });
  assert.deepEqual(
    providerMetadata({ provider: "<script>", region: 42, instanceType: "x".repeat(300) }),
    { provider: "unknown", region: "unknown", instanceType: "unknown" },
  );
});

// ── Every individual violation ──────────────────────────────────────────────

const CASES = [
  ["IMAGE_DIGEST_MISMATCH", { imageDigest: "sha256:" + "c".repeat(64) }],
  ["IMAGE_DIGEST_MISMATCH", { imageDigest: "not-a-digest" }],
  ["IMAGE_REF_MISMATCH", { imageRef: "paws-trellis2:someone-elses-build" }],
  ["REPOSITORY_REVISION_MISMATCH", { repositoryRevision: "c".repeat(40) }],
  ["REPOSITORY_REVISION_MISMATCH", { repositoryRevision: "b".repeat(7) }],
  ["TRELLIS_SOURCE_REVISION_MISMATCH", { trellisSourceRevision: "d".repeat(40) }],
  ["TRELLIS_MODEL_REVISION_MISMATCH", { trellisModelRevision: "d".repeat(40) }],
  ["MODEL_MANIFEST_MISMATCH", { modelManifestSha256: "f".repeat(64) }],
  ["MODEL_BUNDLE_UNVERIFIED", { modelBundleVerified: false }],
  ["CUDA_UNAVAILABLE", { cuda: { available: false, totalVramBytes: 80e9 } }],
  ["BLENDER_BRIDGE_NOT_CONNECTED", { blender: { version: "5.1.2", revision: "e".repeat(40), bridgeConnected: false } }],
  ["BLENDER_VERSION_MISMATCH", { blender: { version: "4.2.0", revision: "e".repeat(40), bridgeConnected: true } }],
  ["BLENDER_REVISION_MISMATCH", { blender: { version: "5.1.2", revision: "f".repeat(40), bridgeConnected: true } }],
  ["STRICT_INHOUSE_MODE_OFF", { strictInHouseMode: false }],
  ["EXTERNAL_GENERATOR_PATH_ENABLED", { externalGeneratorsDisabled: false }],
  ["RUNTIME_NETWORK_POLICY_NOT_OFFLINE", { runtimeNetworkPolicy: "egress" }],
];

for (const [code, override] of CASES) {
  const field = Object.keys(override)[0];
  test(`refuses a worker with a bad ${field} (${code})`, () => {
    const result = evaluate(sign(goodAttestation(override)));
    assert.equal(result.admitted, false);
    assert.ok(
      result.violations.includes(code),
      `expected ${code}, got ${JSON.stringify(result.violations)}`,
    );
  });
}

// ── VRAM floor ──────────────────────────────────────────────────────────────

test("refuses a GPU below the 24 GiB TRELLIS.2 floor", () => {
  const result = evaluate(sign(goodAttestation({
    cuda: { available: true, totalVramBytes: 16 * 1024 * 1024 * 1024 },
  })));
  assert.equal(result.admitted, false);
  assert.ok(result.violations.includes("INSUFFICIENT_VRAM"));
});

test("admits exactly the documented 24 GiB floor", () => {
  const result = evaluate(sign(goodAttestation({
    cuda: { available: true, totalVramBytes: MIN_VRAM_BYTES },
  })));
  assert.deepEqual(result.violations, []);
});

test("refuses a non-numeric or absent VRAM claim", () => {
  for (const bad of [{ available: true }, { available: true, totalVramBytes: "lots" }]) {
    assert.ok(evaluate(sign(goodAttestation({ cuda: bad }))).violations.includes("INSUFFICIENT_VRAM"));
  }
});

// ── Replay resistance ───────────────────────────────────────────────────────

test("refuses an attestation older than the clock-skew window", () => {
  const result = evaluate(sign(goodAttestation({ attestedAt: NOW - MAX_CLOCK_SKEW_MS - 1 })));
  assert.equal(result.admitted, false);
  assert.ok(result.violations.includes("ATTESTATION_STALE"));
});

test("refuses an attestation from the future beyond the window", () => {
  assert.ok(
    evaluate(sign(goodAttestation({ attestedAt: NOW + MAX_CLOCK_SKEW_MS + 1 })))
      .violations.includes("ATTESTATION_STALE"),
  );
});

test("refuses a signature bound to a different nonce — replay is blocked", () => {
  // A genuine, correctly-signed attestation captured from an EARLIER enrollment:
  // both its body nonce and its signature are bound to the old challenge.
  const earlier = "an-earlier-nonce";
  const captured = sign(goodAttestation({ nonce: earlier }), SECRET, earlier);
  // Replayed against a fresh challenge, it must be refused.
  const result = evaluate(captured);
  assert.equal(result.admitted, false);
  assert.ok(result.violations.includes("NONCE_MISMATCH"));
  assert.ok(result.violations.includes("SIGNATURE_INVALID"));
});

test("refuses a signature made with the wrong secret", () => {
  const result = evaluate(sign(goodAttestation(), "attacker-secret"));
  assert.equal(result.admitted, false);
  assert.ok(result.violations.includes("SIGNATURE_INVALID"));
});

test("refuses an absent or non-string signature", () => {
  for (const signature of [undefined, null, 12345, {}]) {
    const result = evaluate({ ...goodAttestation(), signature });
    assert.ok(result.violations.includes("SIGNATURE_INVALID"));
  }
});

test("a tampered field invalidates the signature even if the field looks valid", () => {
  // Sign a good body, then swap the image digest for another well-formed one.
  const signed = sign(goodAttestation());
  const tampered = { ...signed, imageDigest: "sha256:" + "9".repeat(64) };
  const result = evaluate(tampered);
  assert.ok(result.violations.includes("IMAGE_DIGEST_MISMATCH"));
  assert.ok(result.violations.includes("SIGNATURE_INVALID"));
});

// ── Fail-closed structure ───────────────────────────────────────────────────

test("an empty attestation is refused, not defaulted", () => {
  const result = evaluate({});
  assert.equal(result.admitted, false);
  // Every single rule should fire; nothing silently passes on absence.
  for (const code of [
    "IMAGE_DIGEST_MISMATCH", "IMAGE_REF_MISMATCH", "REPOSITORY_REVISION_MISMATCH",
    "TRELLIS_SOURCE_REVISION_MISMATCH", "TRELLIS_MODEL_REVISION_MISMATCH",
    "MODEL_MANIFEST_MISMATCH", "MODEL_BUNDLE_UNVERIFIED", "CUDA_UNAVAILABLE",
    "INSUFFICIENT_VRAM", "BLENDER_BRIDGE_NOT_CONNECTED", "BLENDER_VERSION_MISMATCH",
    "BLENDER_REVISION_MISMATCH", "STRICT_INHOUSE_MODE_OFF",
    "EXTERNAL_GENERATOR_PATH_ENABLED", "RUNTIME_NETWORK_POLICY_NOT_OFFLINE",
    "ATTESTATION_STALE", "NONCE_MISMATCH", "SIGNATURE_INVALID",
  ]) {
    assert.ok(result.violations.includes(code), `empty attestation must report ${code}`);
  }
});

test("all violations are reported at once, not just the first", () => {
  const result = evaluate(sign(goodAttestation({
    modelBundleVerified: false,
    strictInHouseMode: false,
    runtimeNetworkPolicy: "egress",
  })));
  assert.ok(result.violations.length >= 3);
});

test("the canonical payload excludes untrusted provider metadata", () => {
  const a = canonicalAttestationPayload(goodAttestation({ provider: "modal" }), NONCE);
  const b = canonicalAttestationPayload(goodAttestation({ provider: "azure" }), NONCE);
  assert.equal(a, b, "provider must not alter the signed payload");
  assert.doesNotMatch(a, /modal|azure/);
});

test("the canonical payload is stable regardless of key insertion order", () => {
  const forward = goodAttestation();
  const reversed = Object.fromEntries(Object.entries(forward).reverse());
  assert.equal(
    canonicalAttestationPayload(forward, NONCE),
    canonicalAttestationPayload(reversed, NONCE),
  );
});
