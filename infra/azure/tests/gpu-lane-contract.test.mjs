import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const AZURE_ROOT = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(AZURE_ROOT, relativePath), "utf8");

test("stable foundation no longer owns a GPU VM deployment", () => {
  const main = read("main.bicep");
  const platform = read("platform.bicep");
  const deploy = read("scripts/deploy.sh");

  assert.match(main, /param coreLocation string = 'eastus'/);
  assert.doesNotMatch(main, /deployGpuVm|gpuVmSize|gpuPrivateIp/);
  assert.doesNotMatch(platform, /resource gpuVm |resource gpuNic |NvidiaGpuDriverLinux/);
  assert.match(deploy, /GPU lane is intentionally separate/);
  assert.doesNotMatch(deploy, /deployGpuVm|gpuVmSize=/);
});

test("GPU lane can target a separate region and same-tenant subscription", () => {
  const entrypoint = read("gpu-lane-main.bicep");
  const lane = read("gpu-lane.bicep");
  const integration = read("core-gpu-integration.bicep");

  assert.match(entrypoint, /param gpuLocation string/);
  assert.match(entrypoint, /param coreSubscriptionId string = subscription\(\)\.subscriptionId/);
  assert.match(entrypoint, /scope: subscription\(coreSubscriptionId\)/);
  assert.match(entrypoint, /scope: resourceGroup\(coreSubscriptionId, coreResourceGroupName\)/);
  assert.match(entrypoint, /module gpuLane '\.\/gpu-lane\.bicep'/);
  assert.match(entrypoint, /module coreIntegration '\.\/core-gpu-integration\.bicep'/);

  assert.match(lane, /gpuVnetAddressPrefix/);
  assert.match(lane, /sourceAddressPrefix: coreSubnetPrefix/);
  assert.match(lane, /destinationAddressPrefix: gpuPrivateIp/);
  for (const port of ["22", "8000", "10000"]) {
    assert.match(lane, new RegExp(`'${port}'`));
  }
  assert.match(lane, /DenyInternetInboundExplicitly/);
  assert.match(lane, /resource gpuNatGateway/);
  assert.match(lane, /purpose: 'egress-only'/);
  assert.match(lane, /defaultOutboundAccess: false/);
  assert.match(lane, /natGateway:[\s\S]*id: gpuNatGateway\.id/);
  assert.doesNotMatch(lane, /resource gpuNic[\s\S]*?publicIPAddress:/);
  assert.match(lane, /remoteVirtualNetwork:[\s\S]*id: coreVnetId/);
  assert.match(lane, /type: 'SystemAssigned'/);

  assert.match(integration, /remoteVirtualNetwork:[\s\S]*id: gpuVnetId/);
  assert.match(integration, /scope: keyVault/);
  assert.match(integration, /scope: storage/);
  assert.match(integration, /principalId: gpuPrincipalId/);
});

test("GPU preflight and deploy operate only in the selected GPU subscription and region", () => {
  const preflight = read("scripts/preflight.sh");
  const deploy = read("scripts/deploy-gpu-lane.sh");

  assert.match(preflight, /AZURE_GPU_SUBSCRIPTION_ID/);
  assert.match(preflight, /AZURE_GPU_LOCATION/);
  assert.match(preflight, /regional_available=\$\(\(regional_limit - regional_usage\)\)/);
  assert.doesNotMatch(preflight, /gpu_required_vcpus \+ 12|GPU \+ core \+ GibiWorld/);
  assert.match(preflight, /quota and SKU listing do not guarantee a physical allocation/);

  assert.match(deploy, /gpu-lane-main\.bicep/);
  assert.match(deploy, /AZURE_CORE_SUBSCRIPTION_ID/);
  assert.match(deploy, /AZURE_GPU_SUBSCRIPTION_ID/);
  assert.match(deploy, /core_tenant_id/);
  assert.match(deploy, /core_network_state/);
  assert.match(deploy, /actual_core_subnet_prefix/);
  assert.match(deploy, /addressSpace\.addressPrefixes/);
  assert.match(deploy, /validate-gpu-network\.py/);
  assert.match(deploy, /az deployment sub what-if/);
  assert.match(deploy, /az deployment sub create/);
  assert.doesNotMatch(deploy, /infra\/azure\/main\.bicep|deploy\.sh core-gibi/);
});

test("network validator rejects overlap with any existing core VNet prefix", () => {
  const script = path.join(AZURE_ROOT, "scripts", "validate-gpu-network.py");
  const common = [
    script,
    "--core-vnet-prefixes-json", JSON.stringify(["10.42.0.0/16", "10.44.0.0/16"]),
    "--core-subnet-prefix", "10.42.1.0/24",
    "--gpu-subnet-prefix", "10.42.2.0/24",
    "--gpu-private-ip", "10.42.2.10",
  ];
  const overlap = spawnSync("python3", [
    ...common,
    "--gpu-vnet-prefix", "10.42.2.0/24",
  ], { encoding: "utf8" });
  assert.notEqual(overlap.status, 0);
  assert.match(`${overlap.stdout}${overlap.stderr}`, /VNet address spaces overlap/);

  const clean = spawnSync("python3", [
    script,
    "--core-vnet-prefixes-json", JSON.stringify(["10.42.0.0/16", "10.44.0.0/16"]),
    "--core-subnet-prefix", "10.42.1.0/24",
    "--gpu-vnet-prefix", "10.43.0.0/16",
    "--gpu-subnet-prefix", "10.43.2.0/24",
    "--gpu-private-ip", "10.43.2.10",
  ], { encoding: "utf8" });
  assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);
});

test("Compose uses the accepted base-environment image and readiness, not liveness", () => {
  const compose = read("compose/gpu.compose.yml");

  assert.match(compose, /paws-trellis2:75fbf018-b74ca0c/);
  assert.doesNotMatch(compose, /^\s+build:/m);
  assert.match(compose, /\/opt\/conda\/bin\/hf download/);
  assert.doesNotMatch(compose, /conda run|\-n trellis2|huggingface-cli/);
  assert.match(compose, /GPU_PRIVATE_IP:-10\.43\.2\.10}:8000:8000/);
  assert.match(compose, /GPU_PRIVATE_IP:-10\.43\.2\.10}:10000:10000/);
  assert.match(compose, /http:\/\/127\.0\.0\.1:8000\/readyz/);
  assert.match(compose, /os\.environ\["WORKER_SHARED_SECRET"\]/);
  assert.match(compose, /body\.get\("cuda"\) is not True/);
  assert.match(compose, /body\.bridge === "connected"/);
  assert.doesNotMatch(compose, /curl[^\n]*X-Worker-Secret|wget[^\n]*readyz/);
});
