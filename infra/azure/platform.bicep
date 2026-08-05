param location string
param prefix string
param adminUsername string
@secure()
param sshPublicKey string
param adminSourceCidr string
param coreVmSize string
param deployGibiWorldVm bool
param gibiWorldVmSize string

var coreSubnetPrefix = '10.42.1.0/24'
var gpuSubnetPrefix = '10.42.2.0/24'
var gibiWorldSubnetPrefix = '10.42.3.0/24'
var resourceSuffix = uniqueString(subscription().id, resourceGroup().id, prefix)
var storageName = take(toLower('st${replace(prefix, '-', '')}${resourceSuffix}'), 24)
var keyVaultName = take(toLower('${prefix}-kv-${resourceSuffix}'), 24)
var coreCloudInit = loadTextContent('./cloud-init/core.yaml')
var keyVaultSecretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var storageBlobContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
  tags: {
    workload: 'paws-platform'
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    publicNetworkAccess: 'Enabled'
  }
  tags: {
    workload: 'paws-platform'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
  tags: {
    workload: 'paws-platform'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 14
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource artifactsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'trellis-artifacts'
  properties: {
    publicAccess: 'None'
  }
}

resource modelsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'model-cache'
  properties: {
    publicAccess: 'None'
  }
}

resource coreNsg 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
  name: '${prefix}-core-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowSshFromAdmin'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: adminSourceCidr
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
      {
        name: 'AllowHttp'
        properties: {
          priority: 110
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '80'
        }
      }
      {
        name: 'AllowHttps'
        properties: {
          priority: 120
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'DenyVnetInbound'
        properties: {
          priority: 200
          access: 'Deny'
          direction: 'Inbound'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource gpuNsg 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
  name: '${prefix}-gpu-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowWorkersFromCoreOnly'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: coreSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRanges: [
            '22'
            '8000'
            '10000'
          ]
        }
      }
      {
        name: 'DenyOtherVnetInbound'
        properties: {
          priority: 200
          access: 'Deny'
          direction: 'Inbound'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource gibiWorldNsg 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
  name: '${prefix}-gibi-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowSshFromAdmin'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: adminSourceCidr
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
      {
        name: 'AllowWeb'
        properties: {
          priority: 110
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRanges: [
            '80'
            '443'
          ]
        }
      }
      {
        name: 'DenyVnetInbound'
        properties: {
          priority: 200
          access: 'Deny'
          direction: 'Inbound'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: '${prefix}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'core'
        properties: {
          addressPrefix: coreSubnetPrefix
          networkSecurityGroup: {
            id: coreNsg.id
          }
        }
      }
      {
        name: 'gpu-workers'
        properties: {
          addressPrefix: gpuSubnetPrefix
          networkSecurityGroup: {
            id: gpuNsg.id
          }
        }
      }
      {
        name: 'gibiworld'
        properties: {
          addressPrefix: gibiWorldSubnetPrefix
          networkSecurityGroup: {
            id: gibiWorldNsg.id
          }
        }
      }
    ]
  }
}

resource corePublicIp 'Microsoft.Network/publicIPAddresses@2024-01-01' = {
  name: '${prefix}-core-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource coreNic 'Microsoft.Network/networkInterfaces@2024-01-01' = {
  name: '${prefix}-core-nic'
  location: location
  properties: {
    enableAcceleratedNetworking: true
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          primary: true
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: {
            id: corePublicIp.id
          }
          subnet: {
            id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'core')
          }
        }
      }
    ]
  }
}

resource gibiWorldPublicIp 'Microsoft.Network/publicIPAddresses@2024-01-01' = if (deployGibiWorldVm) {
  name: '${prefix}-gibi-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource gibiWorldNic 'Microsoft.Network/networkInterfaces@2024-01-01' = if (deployGibiWorldVm) {
  name: '${prefix}-gibi-nic'
  location: location
  properties: {
    enableAcceleratedNetworking: true
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          primary: true
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: {
            id: gibiWorldPublicIp.id
          }
          subnet: {
            id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'gibiworld')
          }
        }
      }
    ]
  }
}

resource coreVm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: '${prefix}-core-01'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: coreVmSize
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: coreNic.id
          properties: {
            deleteOption: 'Detach'
            primary: true
          }
        }
      ]
    }
    osProfile: {
      computerName: '${prefix}-core-01'
      adminUsername: adminUsername
      customData: base64(coreCloudInit)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [
            {
              keyData: sshPublicKey
              path: '/home/${adminUsername}/.ssh/authorized_keys'
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        name: '${prefix}-core-os'
        createOption: 'FromImage'
        deleteOption: 'Detach'
        diskSizeGB: 256
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
    }
  }
  tags: {
    role: 'core-orchestrator'
    workload: 'paws-platform'
  }
}

resource gibiWorldVm 'Microsoft.Compute/virtualMachines@2024-03-01' = if (deployGibiWorldVm) {
  name: '${prefix}-gibi-01'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: gibiWorldVmSize
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: gibiWorldNic.id
          properties: {
            deleteOption: 'Detach'
            primary: true
          }
        }
      ]
    }
    osProfile: {
      computerName: '${prefix}-gibi-01'
      adminUsername: adminUsername
      customData: base64(coreCloudInit)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [
            {
              keyData: sshPublicKey
              path: '/home/${adminUsername}/.ssh/authorized_keys'
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        name: '${prefix}-gibi-os'
        createOption: 'FromImage'
        deleteOption: 'Detach'
        diskSizeGB: 128
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
    }
  }
  tags: {
    role: 'gibiworld-backend'
    workload: 'gibiworld'
  }
}

resource coreKeyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, coreVm.id, 'secrets-user')
  scope: keyVault
  properties: {
    principalId: coreVm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRole
  }
}

resource coreStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, coreVm.id, 'blob-contributor')
  scope: storage
  properties: {
    principalId: coreVm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobContributorRole
  }
}

resource gibiKeyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployGibiWorldVm) {
  name: guid(keyVault.id, gibiWorldVm.id, 'secrets-user')
  scope: keyVault
  properties: {
    principalId: gibiWorldVm!.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRole
  }
}

output corePublicIp string = corePublicIp.properties.ipAddress
output gibiWorldPublicIp string = deployGibiWorldVm ? gibiWorldPublicIp!.properties.ipAddress : ''
output keyVaultName string = keyVault.name
output storageAccountName string = storage.name
output logAnalyticsWorkspaceName string = logAnalytics.name
