param location string
param prefix string
param adminUsername string
@secure()
param sshPublicKey string
param gpuVmSize string
param coreVnetId string
param coreSubnetPrefix string
param gpuVnetAddressPrefix string
param gpuSubnetPrefix string
param gpuPrivateIp string
param gpuAutoShutdownEnabled bool
param gpuAutoShutdownTime string

var gpuCloudInit = loadTextContent('./cloud-init/gpu.yaml')

resource gpuNsg 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
  name: '${prefix}-gpu-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowWorkerPortsFromExactCoreSubnet'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: coreSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: gpuPrivateIp
          destinationPortRanges: [
            '22'
            '8000'
            '10000'
          ]
        }
      }
      {
        name: 'DenyOtherVirtualNetworkInbound'
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
      {
        name: 'DenyInternetInboundExplicitly'
        properties: {
          priority: 210
          access: 'Deny'
          direction: 'Inbound'
          protocol: '*'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
  tags: {
    workload: 'paws-gpu-lane'
  }
}

// New Azure VNets no longer receive implicit default outbound access. The NAT
// gateway gives bootstrap, Azure control-plane, Key Vault, and Blob traffic an
// explicit egress path without attaching a public IP or inbound rule to the VM.
resource gpuEgressPublicIp 'Microsoft.Network/publicIPAddresses@2024-01-01' = {
  name: '${prefix}-gpu-egress-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
  tags: {
    workload: 'paws-gpu-lane'
    purpose: 'egress-only'
  }
}

resource gpuNatGateway 'Microsoft.Network/natGateways@2024-01-01' = {
  name: '${prefix}-gpu-nat'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 10
    publicIpAddresses: [
      {
        id: gpuEgressPublicIp.id
      }
    ]
  }
  tags: {
    workload: 'paws-gpu-lane'
    purpose: 'egress-only'
  }
}

resource gpuVnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: '${prefix}-gpu-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        gpuVnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'gpu-workers'
        properties: {
          addressPrefix: gpuSubnetPrefix
          defaultOutboundAccess: false
          natGateway: {
            id: gpuNatGateway.id
          }
          networkSecurityGroup: {
            id: gpuNsg.id
          }
        }
      }
    ]
  }
  tags: {
    workload: 'paws-gpu-lane'
  }
}

resource gpuToCorePeering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: gpuVnet
  name: '${prefix}-gpu-to-core'
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: {
      id: coreVnetId
    }
  }
}

resource gpuNic 'Microsoft.Network/networkInterfaces@2024-01-01' = {
  name: '${prefix}-gpu-nic'
  location: location
  properties: {
    enableAcceleratedNetworking: true
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          primary: true
          privateIPAllocationMethod: 'Static'
          privateIPAddress: gpuPrivateIp
          subnet: {
            id: resourceId('Microsoft.Network/virtualNetworks/subnets', gpuVnet.name, 'gpu-workers')
          }
        }
      }
    ]
  }
  tags: {
    workload: 'paws-gpu-lane'
  }
}

resource gpuVm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: '${prefix}-gpu-01'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: gpuVmSize
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: gpuNic.id
          properties: {
            deleteOption: 'Detach'
            primary: true
          }
        }
      ]
    }
    osProfile: {
      computerName: '${prefix}-gpu-01'
      adminUsername: adminUsername
      customData: base64(gpuCloudInit)
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
        name: '${prefix}-gpu-os'
        createOption: 'FromImage'
        deleteOption: 'Detach'
        diskSizeGB: 512
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
    }
  }
  tags: {
    role: 'trellis-blender-worker'
    workload: 'paws-gpu-lane'
    privateOnly: 'true'
  }
}

resource gpuDriver 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = {
  parent: gpuVm
  name: 'NvidiaGpuDriverLinux'
  location: location
  properties: {
    publisher: 'Microsoft.HpcCompute'
    type: 'NvidiaGpuDriverLinux'
    typeHandlerVersion: '1.10'
    autoUpgradeMinorVersion: true
  }
}

resource gpuShutdown 'Microsoft.DevTestLab/schedules@2018-09-15' = if (gpuAutoShutdownEnabled) {
  name: 'shutdown-computevm-${gpuVm.name}'
  location: location
  properties: {
    status: 'Enabled'
    taskType: 'ComputeVmShutdownTask'
    dailyRecurrence: {
      time: gpuAutoShutdownTime
    }
    timeZoneId: 'UTC'
    notificationSettings: {
      status: 'Disabled'
    }
    targetResourceId: gpuVm.id
  }
}

output gpuVnetId string = gpuVnet.id
output gpuPrincipalId string = gpuVm.identity.principalId
output gpuVmName string = gpuVm.name
output gpuPrivateIp string = gpuPrivateIp
output gpuToCorePeeringName string = gpuToCorePeering.name
