import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const lockPath = path.join(ROOT, "infra/azure/models/trellis2.lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

test("TRELLIS source and model bundle uses immutable upstream revisions", () => {
  assert.equal(lock.schemaVersion, 1);
  assert.match(lock.source.revision, /^[a-f0-9]{40}$/);
  assert.equal(lock.models.length, 4);

  for (const model of lock.models) {
    assert.match(model.revision, /^[a-f0-9]{40}$/);
    assert.match(model.repoId, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.ok(["public", "auto", "manual"].includes(model.access));
  }

  const byId = new Map(lock.models.map((model) => [model.repoId, model]));
  assert.equal(byId.get("microsoft/TRELLIS.2-4B")?.access, "public");
  assert.deepEqual(
    byId.get("microsoft/TRELLIS-image-large")?.files,
    [
      "README.md",
      "ckpts/ss_dec_conv3d_16l8_fp16.json",
      "ckpts/ss_dec_conv3d_16l8_fp16.safetensors",
    ],
  );
  assert.equal(byId.get("facebook/dinov3-vitl16-pretrain-lvd1689m")?.access, "manual");
  assert.ok(byId.get("facebook/dinov3-vitl16-pretrain-lvd1689m")?.files.includes("model.safetensors"));
  assert.equal(byId.get("briaai/RMBG-2.0")?.access, "auto");
  assert.ok(byId.get("briaai/RMBG-2.0")?.files.includes("birefnet.py"));
});

test("runtime compose and worker build stay aligned with the model lock", () => {
  const compose = fs.readFileSync(path.join(ROOT, "infra/azure/compose/gpu.compose.yml"), "utf8");
  const dockerfile = fs.readFileSync(path.join(ROOT, "trellis-worker/Dockerfile"), "utf8");

  assert.match(dockerfile, new RegExp(lock.source.revision));
  assert.match(dockerfile, /^FROM nvidia\/cuda:12\.4\.1-devel-ubuntu22\.04@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^ARG MINICONDA_SHA256=[a-f0-9]{64}$/m);
  assert.match(dockerfile, /sha256sum -c -/);
  for (const model of lock.models) {
    assert.match(compose, new RegExp(model.revision));
  }
  assert.match(compose, /HF_HUB_OFFLINE:\s*"1"/);
  assert.match(compose, /TRANSFORMERS_OFFLINE:\s*"1"/);
});

test("staging code never embeds a Hugging Face credential", () => {
  const stagingFiles = [
    lockPath,
    path.join(ROOT, "infra/azure/scripts/stage-trellis-models.sh"),
    path.join(ROOT, "infra/azure/scripts/stage_trellis_models.py"),
  ];
  const combined = stagingFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(combined, /hf_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(combined, /HF_TOKEN\s*=\s*[^$\s]/);
});
