param prefix string
param coreVnetName string
param gpuVnetId string
param gpuPrincipalId string
param keyVaultName string
param storageAccountName string

var keyVaultSecretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var storageBlobContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource coreVnet 'Microsoft.Network/virtualNetworks@2024-01-01' existing = {
  name: coreVnetName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource coreToGpuPeering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: coreVnet
  name: '${prefix}-core-to-gpu'
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: {
      id: gpuVnetId
    }
  }
}

resource gpuKeyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, gpuPrincipalId, 'secrets-user')
  scope: keyVault
  properties: {
    principalId: gpuPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRole
  }
}

resource gpuStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, gpuPrincipalId, 'blob-contributor')
  scope: storage
  properties: {
    principalId: gpuPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobContributorRole
  }
}

output coreToGpuPeeringName string = coreToGpuPeering.name
