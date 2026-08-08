// infra/azure/pbr-worker-main.bicep
// Azure Container Apps foundation for the self-hosted PBR material worker.
//
// This is a separate, simpler deployment from the TRELLIS+Blender ACA stack.
// The PBR worker only runs during offline authoring (scripts/generate-wardrobe-pbr.ts)
// and scales to zero between runs.
//
// Deploy via: infra/azure/scripts/deploy-pbr-worker.sh apply-foundation

targetScope = 'resourceGroup'

param location string
param prefix string
param workerImageName string = ''
param workerImageTag string = 'latest'

var compactPrefix = toLower(replace(prefix, '-', ''))
var nameSuffix = uniqueString(subscription().id, resourceGroup().id)
var registryName = take('${compactPrefix}${nameSuffix}pbr', 50)
var storageAccountName = take('${compactPrefix}${nameSuffix}pbr', 24)
var keyVaultName = take('${prefix}-${nameSuffix}-pbr', 24)
var environmentName = '${prefix}-pbr-a100-env'
var containerAppName = '${prefix}-pbr-worker'
var gpuWorkloadProfileName = 'a100-serverless'
var gpuWorkloadProfileType = 'Consumption-GPU-NC24-A100'
var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var commonTags = {
  workload: 'paws-pbr-worker'
  lane: 'optional-serverless-gpu-pbr'
  isolation: 'target-local'
  managedBy: 'bicep'
}

// ── Log Analytics ──────────────────────────────────────────────────────────

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-pbr-logs'
  location: location
  properties: {
    retentionInDays: 30
    features: {
      disableLocalAuth: false
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    sku: {
      name: 'PerGB2018'
    }
  }
  tags: commonTags
}

// ── Managed Identity ──────────────────────────────────────────────────────

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-pbr-worker-id'
  location: location
  tags: commonTags
}

// ── Container Registry (Basic — no large model staging needed) ────────────

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
  }
  tags: commonTags
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, workerIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

// ── Storage (scratch space for jobs) ─────────────────────────────────────

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: true
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
  tags: union(commonTags, {
    contents: 'pbr-job-scratch'
  })
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource scratchShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'scratch'
  properties: {
    accessTier: 'TransactionOptimized'
    enabledProtocols: 'SMB'
    shareQuota: 32
  }
}

// ── Key Vault ────────────────────────────────────────────────────────────

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    accessPolicies: []
    enablePurgeProtection: true
    enableRbacAuthorization: true
    enableSoftDelete: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
  tags: commonTags
}

resource keyVaultSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, workerIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: keyVault
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

// ── Container Apps Environment ──────────────────────────────────────────

resource acaEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
      {
        name: gpuWorkloadProfileName
        workloadProfileType: gpuWorkloadProfileType
      }
    ]
  }
  tags: commonTags
}

resource storageLink 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: acaEnv
  name: 'scratch'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: scratchShare.name
      accessMode: 'ReadWrite'
    }
  }
}

// ── Container App (PBR Worker) ──────────────────────────────────────────

var hasImage = workerImageName != ''

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = if (hasImage) {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentity.id}': {}
    }
  }
  properties: {
    environmentId: acaEnv.id
    workloadProfileName: gpuWorkloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: workerIdentity.id
        }
      ]
      secrets: [
        {
          name: 'worker-secret'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/pbr-worker-secret'
          identity: workerIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'pbr-worker'
          image: '${registry.properties.loginServer}/${workerImageName}:${workerImageTag}'
          resources: {
            cpu: json('24')
            memory: '220Gi'
          }
          env: [
            {
              name: 'WORKER_SECRET'
              secretRef: 'worker-secret'
            }
            {
              name: 'PORT'
              value: '8080'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
  tags: commonTags
}

// ── Outputs ─────────────────────────────────────────────────────────────

output registryLoginServer string = registry.properties.loginServer
output keyVaultName string = keyVault.name
output environmentName string = acaEnv.name
output containerAppName string = hasImage ? containerApp.name : '(not deployed — no image)'
output containerAppFqdn string = hasImage ? containerApp.properties.configuration.ingress.fqdn : '(not deployed)'
