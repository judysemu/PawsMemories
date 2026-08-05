targetScope = 'subscription'

@description('Azure region in the explicitly selected target subscription. The region must advertise Consumption-GPU-NC24-A100.')
param targetLocation string

@description('Independent target-local resource group. The existing VM GPU lane and stable core are not referenced.')
param resourceGroupName string = 'Trellis-ACA-A100'

@description('Short lowercase prefix used for target-local resource names.')
@minLength(3)
@maxLength(16)
param prefix string = 'pawstrellis'

@description('False creates only the target-local foundation. Enable only after images, model files, and the Key Vault secret have passed the serving preflight.')
param deployServingApp bool = false

@description('Explicit acceptance gate for rebuilt images that implement aggregate TRELLIS plus Blender readiness. The previously cached image tags are intentionally rejected for serving.')
param aggregateReadinessImagesAccepted bool = false

@allowed([
  'external-allowlist'
  'internal'
])
@description('external-allowlist is suitable for a cross-tenant core with a fixed egress CIDR. internal requires separately provisioned private connectivity.')
param ingressMode string = 'external-allowlist'

@description('Single IPv4 CIDR allowed to reach external ingress. TEST-NET is the deliberately unusable direct-template default.')
param coreSourceCidr string = '192.0.2.0/32'

@description('Accepted TRELLIS image repository in the target-local ACR.')
param trellisImageRepository string = 'paws-trellis2'

@description('Accepted TRELLIS image manifest digest without the sha256 prefix. Foundation-only default is deliberately unusable.')
@minLength(64)
@maxLength(64)
param trellisImageDigest string = '0000000000000000000000000000000000000000000000000000000000000000'

@description('Accepted Blender worker image repository in the target-local ACR.')
param blenderImageRepository string = 'paws-blender-worker'

@description('Accepted Blender worker image manifest digest without the sha256 prefix. Foundation-only default is deliberately unusable.')
@minLength(64)
@maxLength(64)
param blenderImageDigest string = '0000000000000000000000000000000000000000000000000000000000000000'

@description('Full repository revision built into both aggregate-readiness images. The old default is deliberately foundation-only and rejected for serving.')
@minLength(40)
@maxLength(40)
param runtimeRepositoryRevision string = 'e2cb178e349f5907d354a1b597e24d7a4ee57438'

@description('Name of a secret that an operator must stage in the target-local Key Vault before deployServingApp is enabled.')
param workerSecretName string = 'worker-shared-secret'

resource laneResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: targetLocation
  tags: {
    workload: 'paws-aca-a100'
    lane: 'optional-serverless-gpu'
    isolation: 'target-local'
    managedBy: 'bicep'
  }
}

module lane './container-apps-gpu.bicep' = {
  name: 'paws-aca-a100-lane'
  scope: laneResourceGroup
  params: {
    location: targetLocation
    prefix: prefix
    deployServingApp: deployServingApp
    aggregateReadinessImagesAccepted: aggregateReadinessImagesAccepted
    ingressMode: ingressMode
    coreSourceCidr: coreSourceCidr
    trellisImageRepository: trellisImageRepository
    trellisImageDigest: trellisImageDigest
    blenderImageRepository: blenderImageRepository
    blenderImageDigest: blenderImageDigest
    runtimeRepositoryRevision: runtimeRepositoryRevision
    workerSecretName: workerSecretName
  }
}

output resourceGroupName string = laneResourceGroup.name
output containerAppsEnvironmentName string = lane.outputs.containerAppsEnvironmentName
output containerAppName string = lane.outputs.containerAppName
output registryName string = lane.outputs.registryName
output storageAccountName string = lane.outputs.storageAccountName
output keyVaultName string = lane.outputs.keyVaultName
output workerFqdn string = lane.outputs.workerFqdn
