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
  assert.match(dockerfile, /conda activate base/);
  assert.doesNotMatch(dockerfile, /conda create/);
  assert.doesNotMatch(dockerfile, /conda run/);
  assert.match(dockerfile, /torch==2\.6\.0/);
  assert.match(dockerfile, /torchvision==0\.21\.0/);
  assert.match(dockerfile, /download\.pytorch\.org\/whl\/cu124/);
  assert.match(dockerfile, /huggingface-hub==1\.26\.0/);
  assert.match(dockerfile, /transformers==5\.14\.1/);
  assert.match(dockerfile, /pip check/);
  assert.match(dockerfile, /^ENV PYTHONPATH=\/opt\/trellis2$/m);
  assert.match(dockerfile, /strings \/usr\/lib\/x86_64-linux-gnu\/libstdc\+\+\.so\.6 \| grep -qx GLIBCXX_3\.4\.30/);
  assert.match(dockerfile, /ln -s \/usr\/lib\/x86_64-linux-gnu\/libstdc\+\+\.so\.6 \/opt\/conda\/lib\/libstdc\+\+\.so\.6/);
  assert.doesNotMatch(dockerfile, /^ENV LD_LIBRARY_PATH=/m);
  assert.doesNotMatch(dockerfile, /setup\.sh --new-env/);
  for (const model of lock.models) {
    assert.match(compose, new RegExp(model.revision));
  }
  assert.match(compose, /HF_HUB_OFFLINE:\s*"1"/);
  assert.match(compose, /TRANSFORMERS_OFFLINE:\s*"1"/);
});

test("authenticated TRELLIS readiness aggregates pinned Blender bridge readiness", () => {
  const worker = fs.readFileSync(path.join(ROOT, "trellis-worker/app/main.py"), "utf8");
  const blender = fs.readFileSync(path.join(ROOT, "blender-worker/server.js"), "utf8");
  const trellisDockerfile = fs.readFileSync(path.join(ROOT, "trellis-worker/Dockerfile"), "utf8");
  const blenderDockerfile = fs.readFileSync(path.join(ROOT, "blender-worker/Dockerfile"), "utf8");
  assert.match(worker, /BLENDER_WORKER_REVISION/);
  assert.match(worker, /BLENDER_VERSION/);
  assert.match(worker, /IMAGE_RUNTIME_REVISION == EXPECTED_BLENDER_REVISION/);
  assert.match(worker, /health\.get\("revisionVerified"\) is True/);
  assert.match(worker, /runtimeRevisionVerified/);
  assert.match(worker, /blender\.request_json\([\s\S]*?"\/health"/);
  assert.match(worker, /and blender_ready/);
  assert.match(worker, /"blender": blender_status/);
  assert.equal((worker.match(/require_aggregate_readiness\(\)/g) || []).length >= 4, true);
  assert.match(blender, /workerRevision:\s*WORKER_REVISION/);
  assert.match(blender, /revisionVerified:\s*REVISION_VERIFIED/);
  assert.match(trellisDockerfile, /PAWS_RUNTIME_REPOSITORY_REVISION/);
  assert.match(trellisDockerfile, /PAWS_RUNTIME_REVISION/);
  assert.match(blenderDockerfile, /PAWS_RUNTIME_REPOSITORY_REVISION/);
  assert.match(blenderDockerfile, /PAWS_RUNTIME_REVISION/);
});

test("staging code never embeds a Hugging Face credential", () => {
  const stagingFiles = [
    lockPath,
    path.join(ROOT, "infra/azure/scripts/stage-trellis-models.sh"),
    path.join(ROOT, "infra/azure/scripts/stage_trellis_models.py"),
    path.join(ROOT, "infra/azure/scripts/complete-trellis-gated-staging.sh"),
    path.join(ROOT, "infra/azure/scripts/scan-model-sensitive-strings.sh"),
    path.join(ROOT, "infra/azure/scripts/cache-trellis-worker-image.sh"),
  ];
  const combined = stagingFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(combined, /hf_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(combined, /HF_TOKEN\s*=\s*[^$\s]/);
  assert.match(combined, /IFS= read -r HF_TOKEN/);
  assert.match(combined, /--interactive/);
  assert.doesNotMatch(combined, /docker_environment\+?=.*--env HF_TOKEN/);
});

test("worker image cache uses managed identity and verifies a private readback", () => {
  const cacheScript = fs.readFileSync(
    path.join(ROOT, "infra/azure/scripts/cache-trellis-worker-image.sh"),
    "utf8",
  );

  assert.match(cacheScript, /AZCOPY_AUTO_LOGIN_TYPE=MSI/);
  assert.match(cacheScript, /--from-to=LocalBlob --overwrite=false/);
  assert.match(cacheScript, /--from-to=BlobLocal --overwrite=true/);
  assert.match(cacheScript, /sha256sum "\$archive_part"/);
  assert.match(cacheScript, /cmp --silent "\$manifest_path" "\$manifest_part"/);
  assert.match(cacheScript, /valuesPrinted: false/);
  assert.doesNotMatch(cacheScript, /[?&](?:sig|se|sp|sv)=/i);
  assert.doesNotMatch(cacheScript, /echo .*storage_account/);
});
