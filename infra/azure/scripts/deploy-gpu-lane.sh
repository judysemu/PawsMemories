#!/usr/bin/env bash
set -euo pipefail

mode="${1:-what-if}"
if [[ "$mode" != "what-if" && "$mode" != "apply" ]]; then
  echo "Usage: $0 [what-if|apply]"
  exit 2
fi
if [[ "$mode" == "apply" && "${CONFIRM_AZURE_SPEND:-}" != "YES" ]]; then
  echo "Refusing deployment. Set CONFIRM_AZURE_SPEND=YES after reviewing current GPU VM pricing."
  exit 2
fi

gpu_location="${AZURE_GPU_LOCATION:-}"
if [[ -z "$gpu_location" ]]; then
  echo "AZURE_GPU_LOCATION is required; use the exact region where quota was granted"
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
template_file="${repo_root}/infra/azure/gpu-lane-main.bicep"
core_subscription_id="${AZURE_CORE_SUBSCRIPTION_ID:-${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}}"
gpu_subscription_id="${AZURE_GPU_SUBSCRIPTION_ID:-$core_subscription_id}"
core_resource_group="${AZURE_CORE_RESOURCE_GROUP:-${AZURE_RESOURCE_GROUP:-Trellis}}"
gpu_resource_group="${AZURE_GPU_RESOURCE_GROUP:-${core_resource_group}-GPU}"
prefix="${AZURE_PREFIX:-pawstrellis}"
core_vnet_name="${AZURE_CORE_VNET_NAME:-${prefix}-vnet}"
core_subnet_name="${AZURE_CORE_SUBNET_NAME:-core}"
core_subnet_prefix="${AZURE_CORE_SUBNET_PREFIX:-10.42.1.0/24}"
gpu_vnet_address_prefix="${AZURE_GPU_VNET_ADDRESS_PREFIX:-10.43.0.0/16}"
gpu_subnet_prefix="${AZURE_GPU_SUBNET_PREFIX:-10.43.2.0/24}"
gpu_private_ip="${AZURE_GPU_PRIVATE_IP:-10.43.2.10}"
gpu_vm_size="${AZURE_GPU_VM_SIZE:-Standard_NC24ads_A100_v4}"
ssh_key_file="${AZURE_SSH_PUBLIC_KEY_FILE:-${HOME}/.ssh/id_ed25519.pub}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to validate that the private network ranges do not overlap"
  exit 1
fi

if [[ ! -f "$ssh_key_file" ]]; then
  echo "Missing SSH public key: $ssh_key_file"
  exit 1
fi

core_tenant_id="$(az account show --subscription "$core_subscription_id" --query tenantId -o tsv)"
gpu_tenant_id="$(az account show --subscription "$gpu_subscription_id" --query tenantId -o tsv)"
if [[ -z "$core_tenant_id" || "$core_tenant_id" != "$gpu_tenant_id" ]]; then
  echo "Core and GPU subscriptions must be enabled in the same Microsoft Entra tenant for private peering and managed-identity access"
  exit 1
fi

core_network_state="$(az provider show --subscription "$core_subscription_id" --namespace Microsoft.Network --query registrationState -o tsv 2>/dev/null || true)"
if [[ "$core_network_state" != "Registered" ]]; then
  echo "Microsoft.Network must be Registered in the core subscription before peering; current state is ${core_network_state:-unknown}"
  exit 1
fi

actual_core_subnet_prefix="$(az network vnet subnet show \
  --subscription "$core_subscription_id" \
  --resource-group "$core_resource_group" \
  --vnet-name "$core_vnet_name" \
  --name "$core_subnet_name" \
  --query 'addressPrefix' -o tsv)"
if [[ "$actual_core_subnet_prefix" != "$core_subnet_prefix" ]]; then
  echo "Configured core subnet prefix does not match the existing core subnet"
  exit 1
fi

core_vnet_prefixes_json="$(az network vnet show \
  --subscription "$core_subscription_id" \
  --resource-group "$core_resource_group" \
  --name "$core_vnet_name" \
  --query 'addressSpace.addressPrefixes' -o json)"
python3 "${repo_root}/infra/azure/scripts/validate-gpu-network.py" \
  --core-vnet-prefixes-json "$core_vnet_prefixes_json" \
  --core-subnet-prefix "$core_subnet_prefix" \
  --gpu-vnet-prefix "$gpu_vnet_address_prefix" \
  --gpu-subnet-prefix "$gpu_subnet_prefix" \
  --gpu-private-ip "$gpu_private_ip"

key_vault_name="${AZURE_CORE_KEY_VAULT_NAME:-$(az keyvault list --subscription "$core_subscription_id" --resource-group "$core_resource_group" --query "[?tags.workload=='paws-platform'].name | [0]" -o tsv)}"
storage_account_name="${AZURE_CORE_STORAGE_ACCOUNT:-$(az storage account list --subscription "$core_subscription_id" --resource-group "$core_resource_group" --query "[?tags.workload=='paws-platform'].name | [0]" -o tsv)}"
if [[ -z "$key_vault_name" || -z "$storage_account_name" ]]; then
  echo "Could not resolve the existing platform Key Vault and storage account; set AZURE_CORE_KEY_VAULT_NAME and AZURE_CORE_STORAGE_ACCOUNT"
  exit 1
fi

AZURE_GPU_SUBSCRIPTION_ID="$gpu_subscription_id" \
AZURE_GPU_LOCATION="$gpu_location" \
AZURE_GPU_VM_SIZE="$gpu_vm_size" \
  "${repo_root}/infra/azure/scripts/preflight.sh"

ssh_public_key="$(<"$ssh_key_file")"
az bicep build --file "$template_file" --stdout >/dev/null

deployment_arguments=(
  --subscription "$gpu_subscription_id"
  --name "paws-gpu-lane"
  --location "$gpu_location"
  --template-file "$template_file"
  --parameters
    gpuLocation="$gpu_location"
    coreSubscriptionId="$core_subscription_id"
    coreResourceGroupName="$core_resource_group"
    gpuResourceGroupName="$gpu_resource_group"
    prefix="$prefix"
    coreVnetName="$core_vnet_name"
    coreSubnetPrefix="$core_subnet_prefix"
    gpuVnetAddressPrefix="$gpu_vnet_address_prefix"
    gpuSubnetPrefix="$gpu_subnet_prefix"
    gpuPrivateIp="$gpu_private_ip"
    keyVaultName="$key_vault_name"
    storageAccountName="$storage_account_name"
    gpuVmSize="$gpu_vm_size"
    sshPublicKey="$ssh_public_key"
)

if [[ "$mode" == "what-if" ]]; then
  az deployment sub what-if "${deployment_arguments[@]}" --result-format ResourceIdOnly
  exit 0
fi

az deployment sub create "${deployment_arguments[@]}" --query 'properties.outputs' -o json
