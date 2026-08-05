import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const AZURE_ROOT = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(AZURE_ROOT, relativePath), "utf8");

test("optional Container Apps lane is isolated from the stable core and VM lane", () => {
  const entrypoint = read("container-apps-gpu-main.bicep");
  const lane = read("container-apps-gpu.bicep");
  const vmEntrypoint = read("gpu-lane-main.bicep");

  assert.match(entrypoint, /targetScope = 'subscription'/);
  assert.match(entrypoint, /module lane '\.\/container-apps-gpu\.bicep'/);
  assert.match(entrypoint, /param deployServingApp bool = false/);
  assert.match(entrypoint, /param aggregateReadinessImagesAccepted bool = false/);
  assert.match(entrypoint, /param runtimeRepositoryRevision string = 'e2cb178e349f5907d354a1b597e24d7a4ee57438'/);
  assert.doesNotMatch(entrypoint, /coreSubscriptionId|coreResourceGroupName|coreVnetName|module coreIntegration/);
  assert.doesNotMatch(lane, /Microsoft\.Compute|Microsoft\.Network|virtualMachines|virtualNetworks/);

  assert.match(vmEntrypoint, /module gpuLane '\.\/gpu-lane\.bicep'/);
  assert.match(vmEntrypoint, /module coreIntegration '\.\/core-gpu-integration\.bicep'/);
  assert.doesNotMatch(vmEntrypoint, /container-apps-gpu|Microsoft\.App/);
});

test("target-local foundation uses identity-backed ACR and Key Vault plus offline Azure Files", () => {
  const lane = read("container-apps-gpu.bicep");

  for (const resourceType of [
    "Microsoft.ContainerRegistry/registries",
    "Microsoft.Storage/storageAccounts",
    "Microsoft.KeyVault/vaults",
    "Microsoft.ManagedIdentity/userAssignedIdentities",
    "Microsoft.OperationalInsights/workspaces",
    "Microsoft.App/managedEnvironments",
  ]) {
    assert.match(lane, new RegExp(resourceType.replaceAll(".", "\\.")));
  }

  assert.match(lane, /adminUserEnabled: false/);
  assert.match(lane, /allowBlobPublicAccess: false/);
  assert.match(lane, /enableRbacAuthorization: true/);
  assert.match(lane, /roleDefinitionId: acrPullRoleDefinitionId/);
  assert.match(lane, /roleDefinitionId: keyVaultSecretsUserRoleDefinitionId/);
  assert.match(lane, /accessMode: 'ReadOnly'[\s\S]*shareName: modelShare\.name/);
  assert.match(lane, /accessMode: 'ReadWrite'[\s\S]*shareName: jobsShare\.name/);
  assert.match(lane, /keyVaultUrl: '\$\{keyVault\.properties\.vaultUri\}secrets\/\$\{workerSecretName\}'/);
  assert.match(lane, /secretRef: 'worker-shared-secret'/);
  assert.doesNotMatch(lane, /passwordSecretRef|WORKER_SHARED_SECRET[^\n]*value:/);
});

test("A100 app keeps TRELLIS first and requires immutable rebuilt image digests", () => {
  const entrypoint = read("container-apps-gpu-main.bicep");
  const lane = read("container-apps-gpu.bicep");
  const runtimeLock = JSON.parse(read("runtime/gpu-runtime.lock.json"));
  const trellis = runtimeLock.images.find((image) => image.component === "trellis2");
  const blender = runtimeLock.images.find((image) => image.component === "blender-worker");

  assert.equal(trellis.imageRef, "paws-trellis2:75fbf018-b74ca0c");
  assert.equal(blender.imageRef, "paws-blender-worker:e2cb178");
  assert.equal("repositoryRevision" in runtimeLock, false);
  assert.match(entrypoint, /param trellisImageDigest string = '0{64}'/);
  assert.match(entrypoint, /param blenderImageDigest string = '0{64}'/);
  assert.match(lane, /emptyImageDigest = '0{64}'/);
  assert.match(lane, /previousRuntimeRepositoryRevision = 'e2cb178e349f5907d354a1b597e24d7a4ee57438'/);
  assert.match(lane, /servingImagePinsReady = aggregateReadinessImagesAccepted/);
  assert.match(lane, /trellisImageDigest != emptyImageDigest/);
  assert.match(lane, /blenderImageDigest != emptyImageDigest/);
  assert.match(lane, /runtimeRepositoryRevision != previousRuntimeRepositoryRevision/);
  assert.match(lane, /\$\{trellisImageRepository\}@sha256:\$\{trellisImageDigest\}/);
  assert.match(lane, /\$\{blenderImageRepository\}@sha256:\$\{blenderImageDigest\}/);
  assert.match(lane, /if \(deployServingApp && servingImagePinsReady\)/);
  assert.match(lane, /Consumption-GPU-NC24-A100/);
  assert.ok(lane.indexOf("name: 'trellis-api'") < lane.indexOf("name: 'blender-worker'"));
  assert.match(lane, /name: 'HF_HUB_OFFLINE'[\s\S]*value: '1'/);
  assert.match(lane, /name: 'TRANSFORMERS_OFFLINE'[\s\S]*value: '1'/);
  assert.match(lane, /name: 'TRELLIS_MODEL_REVISION'[\s\S]*value: 'af44b45f2e35a493886929c6d786e563ec68364d'/);
  assert.match(lane, /name: 'TRELLIS_SOURCE_REVISION'[\s\S]*value: '75fbf0183001ed9876c8dbb35de6b68552ee08bd'/);
  assert.match(lane, /name: 'TRELLIS_MODEL_MANIFEST'[\s\S]*value: '\/models\/trellis2-staging-manifest\.json'/);
  assert.match(lane, /name: 'TRELLIS_JOBS_DIR'[\s\S]*value: '\/jobs'/);
  assert.match(lane, /name: 'BLENDER_WORKER_URL'[\s\S]*value: 'http:\/\/127\.0\.0\.1:10000'/);
  assert.match(lane, /name: 'BLENDER_VERSION'[\s\S]*value: '5\.1\.2'/);
  assert.equal(lane.match(/name: 'BLENDER_WORKER_REVISION'[\s\S]{0,100}value: runtimeRepositoryRevision/g)?.length, 2);
  assert.match(lane, /name: 'RIG_PIPELINE_SHARED_ARTIFACTS_DIR'[\s\S]*value: '\/shared-model-artifacts'/);
  assert.match(lane, /mountPath: '\/shared-model-artifacts'[\s\S]*volumeName: 'jobs'/);
  assert.doesNotMatch(lane, /hf download|huggingface-cli|model-init|TRELLIS_JOB_ROOT|SHARED_MODEL_DIR/);
});

test("authenticated readiness is lock-bound while startup remains a secret-free process probe", () => {
  const lane = read("container-apps-gpu.bicep");
  const worker = fs.readFileSync(path.resolve(AZURE_ROOT, "..", "..", "trellis-worker", "app", "main.py"), "utf8");
  const blender = fs.readFileSync(path.resolve(AZURE_ROOT, "..", "..", "blender-worker", "server.js"), "utf8");

  assert.match(lane, /type: 'Startup'[\s\S]*tcpSocket:[\s\S]*port: 8000/);
  assert.doesNotMatch(lane, /httpHeaders:[\s\S]*X-Worker-Secret/);
  assert.match(worker, /@app\.get\("\/readyz", dependencies=\[Depends\(require_worker_secret\)\]\)/);
  assert.match(worker, /actual_revision == EXPECTED_BLENDER_REVISION/);
  assert.match(worker, /actual_version == EXPECTED_BLENDER_VERSION/);
  assert.match(worker, /"modelRevision": MODEL_REVISION/);
  assert.match(worker, /"sourceRevision": SOURCE_REVISION/);
  assert.match(blender, /workerRevision: WORKER_REVISION/);
});

test("ingress is allowlisted or internal and replicas remain fixed at one", () => {
  const entrypoint = read("container-apps-gpu-main.bicep");
  const lane = read("container-apps-gpu.bicep");

  assert.match(entrypoint, /'external-allowlist'[\s\S]*'internal'/);
  assert.match(entrypoint, /param coreSourceCidr string = '192\.0\.2\.0\/32'/);
  assert.match(lane, /external: ingressMode == 'external-allowlist'/);
  assert.match(lane, /ipSecurityRestrictions: ingressMode == 'external-allowlist'/);
  assert.match(lane, /ipAddressRange: coreSourceCidr/);
  assert.match(lane, /minReplicas: 1/);
  assert.match(lane, /maxReplicas: 1/);
  assert.doesNotMatch(lane, /minReplicas: 0|maxReplicas: [2-9]/);
});

test("preflight is explicit, read-only, provider-aware, and fail-closed for serving", () => {
  const preflight = read("scripts/preflight-container-apps-gpu.sh");
  const deploy = read("scripts/deploy-container-apps-gpu.sh");

  assert.match(preflight, /AZURE_ACA_SUBSCRIPTION_ID/);
  assert.match(preflight, /AZURE_ACA_TENANT_ID/);
  assert.match(preflight, /AZURE_ACA_LOCATION/);
  assert.match(preflight, /Microsoft\.App/);
  assert.match(preflight, /Microsoft\.Quota/);
  assert.match(preflight, /workload-profile list-supported/);
  assert.match(preflight, /Consumption-GPU-NC24-A100/);
  assert.match(preflight, /managedEnvironments\/\$\{environment_name\}\/usages\?api-version=2026-01-01/);
  assert.match(preflight, /AZURE_ACA_MODELS_MANIFEST_SHA256/);
  assert.match(preflight, /trellis2-staging\.lock\.json/);
  assert.match(preflight, /az storage file download/);
  assert.match(preflight, /worker readiness rehashes every file/);
  assert.match(preflight, /AZURE_ACA_AGGREGATE_READINESS_IMAGES_ACCEPTED/);
  assert.match(preflight, /AZURE_ACA_RUNTIME_REPOSITORY_REVISION/);
  assert.match(preflight, /runtime\/gpu-runtime\.lock\.json/);
  assert.match(preflight, /repository revision must match a fully private-readback-verified runtime lock/);
  assert.match(preflight, /requires two non-placeholder lowercase sha256 image digests/);
  assert.match(preflight, /keyvault secret show/);
  assert.match(preflight, /acr manifest show-metadata/);
  assert.match(preflight, /registryImageRef/);
  assert.doesNotMatch(preflight, /provider register|quota update|quota create|keyvault secret set|acr build|hf download/);

  assert.match(deploy, /mode="\$\{1:-what-if\}"/);
  assert.match(deploy, /CONFIRM_AZURE_SPEND/);
  assert.match(deploy, /CONFIRM_AZURE_ACA_A100_SPEND/);
  assert.match(deploy, /runtimeRepositoryRevision="\$runtime_repository_revision"/);
  assert.match(deploy, /az deployment sub what-if/);
  assert.match(deploy, /az deployment sub create/);
  assert.doesNotMatch(deploy, /az account set|provider register|quota update|keyvault secret set|hf download/);
});

test("local guards refuse implicit account context and unconfirmed spend before Azure calls", () => {
  const preflightPath = path.join(AZURE_ROOT, "scripts", "preflight-container-apps-gpu.sh");
  const deployPath = path.join(AZURE_ROOT, "scripts", "deploy-container-apps-gpu.sh");
  const cleanEnv = {
    ...process.env,
    AZURE_ACA_SUBSCRIPTION_ID: "",
    AZURE_ACA_TENANT_ID: "",
    AZURE_ACA_LOCATION: "",
    CONFIRM_AZURE_SPEND: "",
    CONFIRM_AZURE_ACA_A100_SPEND: "",
    AZURE_ACA_AGGREGATE_READINESS_IMAGES_ACCEPTED: "",
    AZURE_ACA_RUNTIME_REPOSITORY_REVISION: "",
  };

  const preflight = spawnSync(preflightPath, ["plan"], { encoding: "utf8", env: cleanEnv });
  assert.equal(preflight.status, 1, `${preflight.stdout}${preflight.stderr}`);
  assert.match(preflight.stdout, /never falls back to the core account context/);

  const deploy = spawnSync(deployPath, ["apply-serving"], { encoding: "utf8", env: cleanEnv });
  assert.equal(deploy.status, 2, `${deploy.stdout}${deploy.stderr}`);
  assert.match(deploy.stdout, /Refusing Azure changes/);

  const missingSourceCidr = spawnSync(preflightPath, ["serving"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      AZURE_ACA_SUBSCRIPTION_ID: "target-subscription-placeholder",
      AZURE_ACA_TENANT_ID: "target-tenant-placeholder",
      AZURE_ACA_LOCATION: "eastus",
      AZURE_ACA_CORE_SOURCE_CIDR: "",
    },
  });
  assert.equal(missingSourceCidr.status, 2, `${missingSourceCidr.stdout}${missingSourceCidr.stderr}`);
  assert.match(missingSourceCidr.stdout, /external serving requires the core's exact fixed egress CIDR/);

  const broadSourceCidr = spawnSync(preflightPath, ["serving"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      AZURE_ACA_SUBSCRIPTION_ID: "target-subscription-placeholder",
      AZURE_ACA_TENANT_ID: "target-tenant-placeholder",
      AZURE_ACA_LOCATION: "eastus",
      AZURE_ACA_CORE_SOURCE_CIDR: "0.0.0.0/0",
    },
  });
  assert.equal(broadSourceCidr.status, 2, `${broadSourceCidr.stdout}${broadSourceCidr.stderr}`);
  assert.match(broadSourceCidr.stdout, /must be one exact IPv4 \/32 CIDR/);

  const missingA100Confirmation = spawnSync(deployPath, ["apply-serving"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      CONFIRM_AZURE_SPEND: "YES",
      CONFIRM_AZURE_ACA_A100_SPEND: "",
    },
  });
  assert.equal(missingA100Confirmation.status, 2, `${missingA100Confirmation.stdout}${missingA100Confirmation.stderr}`);
  assert.match(missingA100Confirmation.stdout, /Refusing A100 activation/);

  const previousImages = spawnSync(preflightPath, ["serving"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      AZURE_ACA_SUBSCRIPTION_ID: "target-subscription-placeholder",
      AZURE_ACA_TENANT_ID: "target-tenant-placeholder",
      AZURE_ACA_LOCATION: "eastus",
      AZURE_ACA_CORE_SOURCE_CIDR: "198.51.100.1/32",
      AZURE_ACA_AGGREGATE_READINESS_IMAGES_ACCEPTED: "YES",
    },
  });
  assert.equal(previousImages.status, 2, `${previousImages.stdout}${previousImages.stderr}`);
  assert.match(previousImages.stdout, /requires two non-placeholder lowercase sha256 image digests/);

  const previousRevision = spawnSync(preflightPath, ["serving"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      AZURE_ACA_SUBSCRIPTION_ID: "target-subscription-placeholder",
      AZURE_ACA_TENANT_ID: "target-tenant-placeholder",
      AZURE_ACA_LOCATION: "eastus",
      AZURE_ACA_CORE_SOURCE_CIDR: "198.51.100.1/32",
      AZURE_ACA_AGGREGATE_READINESS_IMAGES_ACCEPTED: "YES",
      AZURE_ACA_TRELLIS_DIGEST: "1".repeat(64),
      AZURE_ACA_BLENDER_DIGEST: "2".repeat(64),
    },
  });
  assert.equal(previousRevision.status, 2, `${previousRevision.stdout}${previousRevision.stderr}`);
  assert.match(previousRevision.stdout, /previous repository revision predates aggregate-readiness images/);

  const invalidRevision = spawnSync(preflightPath, ["serving"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      AZURE_ACA_SUBSCRIPTION_ID: "target-subscription-placeholder",
      AZURE_ACA_TENANT_ID: "target-tenant-placeholder",
      AZURE_ACA_LOCATION: "eastus",
      AZURE_ACA_CORE_SOURCE_CIDR: "198.51.100.1/32",
      AZURE_ACA_AGGREGATE_READINESS_IMAGES_ACCEPTED: "YES",
      AZURE_ACA_TRELLIS_DIGEST: "1".repeat(64),
      AZURE_ACA_BLENDER_DIGEST: "2".repeat(64),
      AZURE_ACA_RUNTIME_REPOSITORY_REVISION: "not-a-revision",
    },
  });
  assert.equal(invalidRevision.status, 2, `${invalidRevision.stdout}${invalidRevision.stderr}`);
  assert.match(invalidRevision.stdout, /must be one full lowercase 40-hex Git revision/);

  const mismatchedLock = spawnSync(preflightPath, ["serving"], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      AZURE_ACA_SUBSCRIPTION_ID: "target-subscription-placeholder",
      AZURE_ACA_TENANT_ID: "target-tenant-placeholder",
      AZURE_ACA_LOCATION: "eastus",
      AZURE_ACA_CORE_SOURCE_CIDR: "198.51.100.1/32",
      AZURE_ACA_AGGREGATE_READINESS_IMAGES_ACCEPTED: "YES",
      AZURE_ACA_TRELLIS_DIGEST: "1".repeat(64),
      AZURE_ACA_BLENDER_DIGEST: "2".repeat(64),
      AZURE_ACA_RUNTIME_REPOSITORY_REVISION: "1111111111111111111111111111111111111111",
      AZURE_ACA_MODELS_MANIFEST_SHA256: "e3a4d702026090228807307c073f4171dbefd4db456a28a92e8a014669c0819c",
    },
  });
  assert.equal(mismatchedLock.status, 2, `${mismatchedLock.stdout}${mismatchedLock.stderr}`);
  assert.match(mismatchedLock.stdout, /must match a fully private-readback-verified runtime lock/);
});
