import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const AZURE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(AZURE_ROOT, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(AZURE_ROOT, relativePath), "utf8");

function parseRenderedPipeline() {
  const templatePath = path.join(AZURE_ROOT, "azureml-job", "pipeline.template.yml");
  const replacements = {
    __INPUT_IMAGE__: "/tmp/consented-real-input.png",
    __MODELS_URI__: "azureml://datastores/models/paths/trellis/accepted",
    __MODELS_MANIFEST_SHA256__: "a".repeat(64),
    __TRELLIS_IMAGE__: `private.azurecr.io/trellis@sha256:${"b".repeat(64)}`,
    __BLENDER_IMAGE__: `private.azurecr.io/blender@sha256:${"c".repeat(64)}`,
    __RUNTIME_REPOSITORY_REVISION__: "d".repeat(40),
    __CODE_PATH__: path.join(AZURE_ROOT, "azureml-job", "code"),
  };
  let rendered = fs.readFileSync(templatePath, "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) rendered = rendered.replaceAll(placeholder, value);
  const parsed = spawnSync("python3", ["-c", [
    "import json, sys, yaml",
    "print(json.dumps(yaml.safe_load(sys.stdin.read())))",
  ].join("\n")], { input: rendered, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

test("pipeline is a finite two-step serverless Spot run with explicit identities and bounds", () => {
  const pipeline = parseRenderedPipeline();
  assert.equal(pipeline.type, "pipeline");
  assert.equal(pipeline.settings.default_compute, "azureml:serverless");
  assert.equal(pipeline.settings.continue_on_step_failure, false);
  assert.deepEqual(Object.keys(pipeline.jobs), ["trellis_generate", "blender_finalize"]);

  const trellis = pipeline.jobs.trellis_generate;
  const blender = pipeline.jobs.blender_finalize;
  assert.equal(trellis.identity.type, "managed");
  assert.equal(blender.identity.type, "managed");
  assert.equal(trellis.queue_settings.job_tier, "spot");
  assert.equal(blender.queue_settings.job_tier, "spot");
  assert.equal(trellis.resources.instance_count, 1);
  assert.equal(trellis.resources.instance_type, "Standard_NC24ads_A100_v4");
  assert.equal(blender.resources.instance_count, 1);
  assert.equal(blender.resources.instance_type, "Standard_A8m_v2");
  assert.equal(trellis.limits.timeout, 7200);
  assert.equal(blender.limits.timeout, 3600);
  assert.equal(blender.inputs.base_glb, "${{parent.jobs.trellis_generate.outputs.base_glb}}");
  assert.equal(blender.outputs.final_glb, "${{parent.outputs.final_glb}}");
  assert.equal(pipeline.tags.external_generative_calls, "0");
});

test("runtime images are immutable and lock-bound to one future shared revision", () => {
  const template = read("azureml-job/pipeline.template.yml");
  const preflight = read("scripts/preflight-azureml-spot-job.sh");
  const blender = read("azureml-job/code/blender_once.mjs");

  assert.match(preflight, /registryImageRef/);
  assert.match(preflight, /cacheState/);
  assert.match(preflight, /verified-private-readback/);
  assert.match(preflight, /repositoryRevision/);
  assert.match(preflight, /AZURE_ML_RUNTIME_REPOSITORY_REVISION/);
  assert.ok(preflight.includes("\\.azurecr\\.io"));
  assert.ok(preflight.includes("@sha256:"));
  assert.ok(preflight.includes('[[ "$resolved" == "${descriptor##*@}" ]]'));
  assert.match(template, /PAWS_RUNTIME_REPOSITORY_REVISION: __RUNTIME_REPOSITORY_REVISION__/);
  assert.match(blender, /runtimeRepositoryRevision/);

  const laneText = `${template}\n${preflight}\n${blender}`;
  assert.doesNotMatch(laneText, /BLENDER_WORKER_REVISION/);
  assert.doesNotMatch(laneText, /paws-blender-worker:/);
});

test("preflight is read-only, exact-account, identity-backed, and quota-authoritative", () => {
  const preflight = read("scripts/preflight-azureml-spot-job.sh");
  assert.match(preflight, /implicit Azure account context is forbidden/);
  assert.match(preflight, /Microsoft\.MachineLearningServices/);
  assert.match(preflight, /lowPriorityCores\/usages/);
  assert.match(preflight, /low_priority_remaining >= 24/);
  assert.match(preflight, /workspace_low_priority_remaining/);
  assert.match(preflight, /workspace low-priority quota has fewer than 24 vCPUs/);
  assert.match(preflight, /Standard_NC24ads_A100_v4/i);
  assert.match(preflight, /Standard_A8m_v2/i);
  assert.match(preflight, /primaryUserAssignedIdentity/);
  assert.match(preflight, /AcrPull/);
  assert.match(preflight, /adminUserEnabled/);
  assert.match(preflight, /acr manifest show-metadata/);
  assert.match(preflight, /extension show --name ml/);
  assert.doesNotMatch(preflight, /provider register|quota update|workspace create|role assignment create|acr import|acr build|ml job create/);
  assert.doesNotMatch(preflight, /set -x|account get-access-token[^\n]*--output (json|tsv)/);
});

test("submission has three spend/real-image gates and portable macOS output discovery", () => {
  const runner = read("scripts/run-azureml-spot-job.sh");
  const createIndex = runner.indexOf("ml job create");
  assert.ok(createIndex > 0);
  for (const gate of ["CONFIRM_AZURE_SPEND", "CONFIRM_AZURE_ML_SPOT_SPEND", "CONFIRM_ONE_REAL_IMAGE_E2E"]) {
    const gateIndex = runner.indexOf(gate);
    assert.ok(gateIndex > 0 && gateIndex < createIndex, `${gate} must precede submission`);
  }
  assert.match(runner, /Input must be an absolute local image path/);
  assert.match(runner, /Output path already exists/);
  assert.match(runner, /az ml job cancel/);
  assert.match(runner, /status" == "Completed"/);
  assert.match(runner, /validate-output\.mjs/);
  assert.doesNotMatch(runner, /mapfile|readarray/);
});

test("one-shot wrappers enforce model integrity and production rig/final acceptance", () => {
  const trellis = read("azureml-job/code/trellis_once.py");
  const blender = read("azureml-job/code/blender_once.mjs");
  const validator = read("azureml-job/validate-output.mjs");

  assert.match(trellis, /EXPECTED_LOCK_SHA256/);
  assert.match(trellis, /EXPECTED_MODELS/);
  assert.match(trellis, /MODEL_FILE_HASH_MISMATCH/);
  assert.match(trellis, /MODEL_FILE_SET_MISMATCH/);
  assert.match(trellis, /HF_HUB_OFFLINE/);
  assert.match(trellis, /TRANSFORMERS_OFFLINE/);
  assert.match(trellis, /worker\.generate_job/);
  assert.match(blender, /createRigPipelineProcessor/);
  assert.match(blender, /createBlenderPipelineRunner/);
  assert.match(blender, /buildSkeletalClipScript/);
  assert.match(blender, /FINAL_REQUIRED_CLIPS_MISSING/);
  assert.match(blender, /FINAL_PBR_OR_WEIGHTS_MISSING/);
  assert.match(blender, /FINAL_EXTERNAL_URI_REJECTED/);
  assert.match(validator, /validatePetGlbStage/);
  assert.match(validator, /operatorReady/);
  assert.doesNotMatch(`${trellis}\n${blender}`, /tripo|meshy|rodin|fetch\s*\(/i);
});

test("missing explicit account context fails before any Azure command", () => {
  const preflight = path.join(AZURE_ROOT, "scripts", "preflight-azureml-spot-job.sh");
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paws-aml-test-")), "azure-called");
  const fakeAzure = path.join(path.dirname(marker), "fake-az");
  fs.writeFileSync(fakeAzure, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o700 });
  const result = spawnSync(preflight, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      AZURE_CLI: fakeAzure,
      AZURE_ML_CONFIG_DIR: "",
      AZURE_ML_SUBSCRIPTION_ID: "",
      AZURE_ML_TENANT_ID: "",
    },
  });
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /implicit Azure account context is forbidden/);
  assert.equal(fs.existsSync(marker), false);
});
