targetScope = 'subscription'

@description('The Azure region where GPU quota and the requested VM SKU are available.')
param gpuLocation string

@description('Subscription that owns the stable core/orchestrator resources. Defaults to the GPU deployment subscription.')
param coreSubscriptionId string = subscription().subscriptionId

@description('Existing resource group that owns the stable core/orchestrator resources.')
param coreResourceGroupName string = 'Trellis'

@description('Independent resource group for the replaceable regional GPU lane.')
param gpuResourceGroupName string = 'Trellis-GPU'

@description('Short lowercase prefix used for Azure resource names.')
@minLength(3)
@maxLength(12)
param prefix string = 'pawstrellis'

@description('Name of the existing core virtual network. This resource is referenced, not redeployed.')
param coreVnetName string = 'pawstrellis-vnet'

@description('Exact existing core subnet CIDR allowed to reach the private worker ports.')
param coreSubnetPrefix string = '10.42.1.0/24'

@description('Name of the existing platform Key Vault used by the GPU managed identity.')
param keyVaultName string

@description('Name of the existing private model/artifact storage account used by the GPU managed identity.')
param storageAccountName string

@description('Linux administrator account used only through the private core-to-GPU connection.')
param adminUsername string = 'pawsadmin'

@secure()
@description('SSH public key. Password login and a GPU public IP are both disabled.')
param sshPublicKey string

@description('Single-GPU TRELLIS/Blender worker sized to the quota granted in gpuLocation.')
param gpuVmSize string = 'Standard_NC24ads_A100_v4'

@description('Non-overlapping address space for the independently regional GPU virtual network.')
param gpuVnetAddressPrefix string = '10.43.0.0/16'

@description('Private subnet used only by GPU workers.')
param gpuSubnetPrefix string = '10.43.2.0/24'

@description('Static private address used by the worker inside gpuSubnetPrefix.')
param gpuPrivateIp string = '10.43.2.10'

@description('Enable a daily safety shutdown for the GPU VM. Explicit deallocation is still required after testing.')
param gpuAutoShutdownEnabled bool = true

@description('Daily GPU safety shutdown in UTC, HHmm format.')
param gpuAutoShutdownTime string = '0700'

resource coreResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' existing = {
  scope: subscription(coreSubscriptionId)
  name: coreResourceGroupName
}

resource coreVnet 'Microsoft.Network/virtualNetworks@2024-01-01' existing = {
  scope: coreResourceGroup
  name: coreVnetName
}

resource gpuResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: gpuResourceGroupName
  location: gpuLocation
  tags: {
    workload: 'paws-gpu-lane'
    environment: 'production'
    managedBy: 'bicep'
    coreRegionInvariant: 'true'
  }
}

module gpuLane './gpu-lane.bicep' = {
  name: 'paws-gpu-lane'
  scope: gpuResourceGroup
  params: {
    location: gpuLocation
    prefix: prefix
    adminUsername: adminUsername
    sshPublicKey: sshPublicKey
    gpuVmSize: gpuVmSize
    coreVnetId: coreVnet.id
    coreSubnetPrefix: coreSubnetPrefix
    gpuVnetAddressPrefix: gpuVnetAddressPrefix
    gpuSubnetPrefix: gpuSubnetPrefix
    gpuPrivateIp: gpuPrivateIp
    gpuAutoShutdownEnabled: gpuAutoShutdownEnabled
    gpuAutoShutdownTime: gpuAutoShutdownTime
  }
}

module coreIntegration './core-gpu-integration.bicep' = {
  name: 'paws-core-gpu-integration'
  scope: resourceGroup(coreSubscriptionId, coreResourceGroupName)
  params: {
    prefix: prefix
    coreVnetName: coreVnetName
    gpuVnetId: gpuLane.outputs.gpuVnetId
    gpuPrincipalId: gpuLane.outputs.gpuPrincipalId
    keyVaultName: keyVaultName
    storageAccountName: storageAccountName
  }
}

output coreResourceGroupName string = coreResourceGroup.name
output gpuResourceGroupName string = gpuResourceGroup.name
output gpuLocation string = gpuLocation
output gpuVmName string = gpuLane.outputs.gpuVmName
output gpuPrivateIp string = gpuLane.outputs.gpuPrivateIp
output gpuVnetId string = gpuLane.outputs.gpuVnetId
output coreToGpuPeeringName string = coreIntegration.outputs.coreToGpuPeeringName
