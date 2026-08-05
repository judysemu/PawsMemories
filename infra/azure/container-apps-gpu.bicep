param location string
param prefix string
param deployServingApp bool
param aggregateReadinessImagesAccepted bool

@allowed([
  'external-allowlist'
  'internal'
])
param ingressMode string

param coreSourceCidr string
param trellisImageRepository string
@minLength(64)
@maxLength(64)
param trellisImageDigest string
param blenderImageRepository string
@minLength(64)
@maxLength(64)
param blenderImageDigest string
@minLength(40)
@maxLength(40)
param runtimeRepositoryRevision string
param workerSecretName string

var compactPrefix = toLower(replace(prefix, '-', ''))
var nameSuffix = uniqueString(subscription().id, resourceGroup().id)
var registryName = take('${compactPrefix}${nameSuffix}aca', 50)
var storageAccountName = take('${compactPrefix}${nameSuffix}aca', 24)
var keyVaultName = take('${prefix}-${nameSuffix}-aca', 24)
var environmentName = '${prefix}-aca-a100-env'
var containerAppName = '${prefix}-trellis-a100'
var gpuWorkloadProfileName = 'a100-serverless'
var gpuWorkloadProfileType = 'Consumption-GPU-NC24-A100'
var emptyImageDigest = '0000000000000000000000000000000000000000000000000000000000000000'
var previousRuntimeRepositoryRevision = 'e2cb178e349f5907d354a1b597e24d7a4ee57438'
var servingImagePinsReady = aggregateReadinessImagesAccepted && trellisImageDigest != emptyImageDigest && blenderImageDigest != emptyImageDigest && runtimeRepositoryRevision != previousRuntimeRepositoryRevision
var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var commonTags = {
  workload: 'paws-aca-a100'
  lane: 'optional-serverless-gpu'
  isolation: 'target-local'
  managedBy: 'bicep'
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-aca-a100-logs'
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

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-aca-worker-id'
  location: location
  tags: commonTags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
    policies: {
      quarantinePolicy: {
        status: 'disabled'
      }
      retentionPolicy: {
        days: 14
        status: 'enabled'
      }
      trustPolicy: {
        status: 'disabled'
        type: 'Notary'
      }
    }
  }
  tags: union(commonTags, {
    imageSource: 'accepted-images-only'
  })
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
    contents: 'offline-models-and-job-artifacts'
  })
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource modelShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'models'
  properties: {
    accessTier: 'TransactionOptimized'
    enabledProtocols: 'SMB'
    shareQuota: 1024
  }
}

resource jobsShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'jobs'
  properties: {
    accessTier: 'TransactionOptimized'
    enabledProtocols: 'SMB'
    shareQuota: 512
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
  tags: union(commonTags, {
    contents: 'references-only-no-template-secret-values'
  })
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

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
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
        name: gpuWorkloadProfileName
        workloadProfileType: gpuWorkloadProfileType
      }
    ]
    zoneRedundant: false
  }
  tags: union(commonTags, {
    gpuProfile: gpuWorkloadProfileType
  })
}

// Azure Container Apps currently requires an Azure Files account key for the
// environment-level SMB mount. The key is resolved inside ARM and is never an
// input, output, command-line argument, or repository value.
resource modelStorageMount 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'models'
  properties: {
    azureFile: {
      accessMode: 'ReadOnly'
      accountKey: storage.listKeys().keys[0].value
      accountName: storage.name
      shareName: modelShare.name
    }
  }
}

resource jobsStorageMount 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'jobs'
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: storage.listKeys().keys[0].value
      accountName: storage.name
      shareName: jobsShare.name
    }
  }
}

resource worker 'Microsoft.App/containerApps@2025-01-01' = if (deployServingApp && servingImagePinsReady) {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: gpuWorkloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: ingressMode == 'external-allowlist'
        ipSecurityRestrictions: ingressMode == 'external-allowlist' ? [
          {
            action: 'Allow'
            description: 'Only the fixed core egress CIDR may call the authenticated worker.'
            ipAddressRange: coreSourceCidr
            name: 'allow-core-egress'
          }
        ] : []
        targetPort: 8000
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        transport: 'http'
      }
      registries: [
        {
          identity: workerIdentity.id
          server: registry.properties.loginServer
        }
      ]
      secrets: [
        {
          identity: workerIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${workerSecretName}'
          name: 'worker-shared-secret'
        }
      ]
    }
    template: {
      // Azure assigns the sole GPU to the first container. Keep TRELLIS first.
      containers: [
        {
          name: 'trellis-api'
          image: '${registry.properties.loginServer}/${trellisImageRepository}@sha256:${trellisImageDigest}'
          env: [
            {
              name: 'WORKER_SHARED_SECRET'
              secretRef: 'worker-shared-secret'
            }
            {
              name: 'HF_HUB_OFFLINE'
              value: '1'
            }
            {
              name: 'TRANSFORMERS_OFFLINE'
              value: '1'
            }
            {
              name: 'TRELLIS_MODEL_PATH'
              value: '/models/TRELLIS.2-4B'
            }
            {
              name: 'TRELLIS_MODEL_MANIFEST'
              value: '/models/trellis2-staging-manifest.json'
            }
            {
              name: 'TRELLIS_MODEL_REVISION'
              value: 'af44b45f2e35a493886929c6d786e563ec68364d'
            }
            {
              name: 'TRELLIS_SOURCE_REVISION'
              value: '75fbf0183001ed9876c8dbb35de6b68552ee08bd'
            }
            {
              name: 'TRELLIS_PRELOAD'
              value: 'true'
            }
            {
              name: 'TRELLIS_JOBS_DIR'
              value: '/jobs'
            }
            {
              name: 'BLENDER_WORKER_URL'
              value: 'http://127.0.0.1:10000'
            }
            {
              name: 'BLENDER_INTERNAL_HOSTS'
              value: '127.0.0.1,localhost'
            }
            {
              name: 'BLENDER_VERSION'
              value: '5.1.2'
            }
            {
              name: 'BLENDER_WORKER_REVISION'
              value: runtimeRepositoryRevision
            }
          ]
          probes: [
            {
              type: 'Startup'
              tcpSocket: {
                port: 8000
              }
              failureThreshold: 10
              initialDelaySeconds: 60
              periodSeconds: 30
              timeoutSeconds: 5
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8000
                scheme: 'HTTP'
              }
              failureThreshold: 5
              initialDelaySeconds: 30
              periodSeconds: 30
              timeoutSeconds: 5
            }
          ]
          resources: {
            cpu: 22
            memory: '200Gi'
          }
          volumeMounts: [
            {
              mountPath: '/models'
              volumeName: 'models'
            }
            {
              mountPath: '/jobs'
              volumeName: 'jobs'
            }
          ]
        }
        {
          name: 'blender-worker'
          image: '${registry.properties.loginServer}/${blenderImageRepository}@sha256:${blenderImageDigest}'
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '10000'
            }
            {
              name: 'WORKER_SHARED_SECRET'
              secretRef: 'worker-shared-secret'
            }
            {
              name: 'BLENDER_WORKER_REVISION'
              value: runtimeRepositoryRevision
            }
            {
              name: 'RIG_PIPELINE_SHARED_ARTIFACTS_DIR'
              value: '/shared-model-artifacts'
            }
          ]
          probes: [
            {
              type: 'Startup'
              tcpSocket: {
                port: 10000
              }
              failureThreshold: 10
              initialDelaySeconds: 30
              periodSeconds: 15
              timeoutSeconds: 5
            }
          ]
          resources: {
            cpu: 2
            memory: '20Gi'
          }
          volumeMounts: [
            {
              mountPath: '/shared-model-artifacts'
              volumeName: 'jobs'
            }
          ]
        }
      ]
      // Current worker jobs run in-process and keep SQLite state on /jobs.
      // Scale-to-zero or concurrent replicas are unsafe until dispatch is externalized.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'models'
          storageName: modelStorageMount.name
          storageType: 'AzureFile'
        }
        {
          name: 'jobs'
          storageName: jobsStorageMount.name
          storageType: 'AzureFile'
        }
      ]
    }
  }
  tags: union(commonTags, {
    gpuProfile: gpuWorkloadProfileType
    requestedTrellisImageDigest: trellisImageDigest
  })
  dependsOn: [
    registryPull
    keyVaultSecretReader
  ]
}

output containerAppsEnvironmentName string = environment.name
output containerAppName string = containerAppName
output registryName string = registry.name
output storageAccountName string = storage.name
output keyVaultName string = keyVault.name
output servingImagePinsReady bool = servingImagePinsReady
output workerFqdn string = worker.?properties.configuration.ingress.fqdn ?? ''
