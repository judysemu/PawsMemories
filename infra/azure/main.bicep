targetScope = 'subscription'

@description('Azure region for the platform. GPU quota and SKU capacity must be verified before deployment.')
param location string = 'eastus'

@description('Resource group that owns the Paws/TRELLIS platform.')
param resourceGroupName string = 'Trellis'

@description('Short lowercase prefix used for Azure resource names.')
@minLength(3)
@maxLength(12)
param prefix string = 'pawstrellis'

@description('Linux administrator account used for emergency access. Password login is disabled.')
param adminUsername string = 'pawsadmin'

@secure()
@description('SSH public key. This is a public key, but is marked secure to keep deployment output quiet.')
param sshPublicKey string

@description('Single trusted CIDR allowed to SSH to the public core VM, for example 203.0.113.4/32.')
param adminSourceCidr string

@description('Always-on API/orchestrator VM. This host does not run TRELLIS inference.')
param coreVmSize string = 'Standard_D8ads_v7'

@description('Single-GPU TRELLIS/Blender worker. H100 v5 is the preferred net-new Azure capacity.')
param gpuVmSize string = 'Standard_NC40ads_H100_v5'

@description('Set false to deploy only the low-cost foundation while GPU quota is pending.')
param deployGpuVm bool = false

@description('Enable a daily safety shutdown for the GPU VM. Azure deallocation is still verified after testing.')
param gpuAutoShutdownEnabled bool = true

@description('Daily GPU safety shutdown in UTC, HHmm format.')
param gpuAutoShutdownTime string = '0700'

@description('Optional separate GibiWorld application VM. Keep false until its backend deployment contract is ready.')
param deployGibiWorldVm bool = false

@description('GibiWorld application VM size when the optional isolated lane is enabled.')
param gibiWorldVmSize string = 'Standard_D4ads_v7'

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    workload: 'paws-platform'
    environment: 'production'
    managedBy: 'bicep'
  }
}

module platform './platform.bicep' = {
  name: 'paws-platform'
  scope: resourceGroup
  params: {
    location: location
    prefix: prefix
    adminUsername: adminUsername
    sshPublicKey: sshPublicKey
    adminSourceCidr: adminSourceCidr
    coreVmSize: coreVmSize
    gpuVmSize: gpuVmSize
    deployGpuVm: deployGpuVm
    gpuAutoShutdownEnabled: gpuAutoShutdownEnabled
    gpuAutoShutdownTime: gpuAutoShutdownTime
    deployGibiWorldVm: deployGibiWorldVm
    gibiWorldVmSize: gibiWorldVmSize
  }
}

output resourceGroupName string = resourceGroup.name
output corePublicIp string = platform.outputs.corePublicIp
output gpuPrivateIp string = platform.outputs.gpuPrivateIp
output gibiWorldPublicIp string = platform.outputs.gibiWorldPublicIp
output keyVaultName string = platform.outputs.keyVaultName
output storageAccountName string = platform.outputs.storageAccountName
