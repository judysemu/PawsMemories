#!/usr/bin/env bash
set -euo pipefail

if [[ "${CONFIRM_AZURE_SPEND:-}" != "YES" ]]; then
  echo "Refusing deployment. Set CONFIRM_AZURE_SPEND=YES after reviewing current VM pricing."
  exit 2
fi

mode="${1:-foundation}"
if [[ "$mode" != "foundation" && "$mode" != "core-gibi" && "$mode" != "full" ]]; then
  echo "Usage: $0 [foundation|core-gibi|full]"
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
template_file="${repo_root}/infra/azure/main.bicep"
subscription_id="${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
location="${AZURE_LOCATION:-eastus}"
resource_group="${AZURE_RESOURCE_GROUP:-Trellis}"
prefix="${AZURE_PREFIX:-pawstrellis}"
gpu_vm_size="${AZURE_GPU_VM_SIZE:-Standard_NC40ads_H100_v5}"
ssh_key_file="${AZURE_SSH_PUBLIC_KEY_FILE:-${HOME}/.ssh/id_ed25519.pub}"

if [[ ! -f "$ssh_key_file" ]]; then
  echo "Missing SSH public key: $ssh_key_file"
  exit 1
fi

admin_ip="${AZURE_ADMIN_IP:-$(curl -fsSL https://api.ipify.org)}"
if [[ ! "$admin_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Could not resolve a valid IPv4 administrator address"
  exit 1
fi
IFS='.' read -r octet1 octet2 octet3 octet4 <<< "$admin_ip"
for octet in "$octet1" "$octet2" "$octet3" "$octet4"; do
  if (( 10#$octet > 255 )); then
    echo "Could not resolve a valid IPv4 administrator address"
    exit 1
  fi
done
admin_cidr="${admin_ip}/32"
ssh_public_key="$(<"$ssh_key_file")"

deploy_gpu=false
deploy_gibi=false
if [[ "$mode" == "core-gibi" ]]; then
  deploy_gibi=true
fi
if [[ "$mode" == "full" ]]; then
  deploy_gpu=true
  deploy_gibi=true
fi

az account set --subscription "$subscription_id"
az bicep build --file "$template_file" --stdout >/dev/null

az deployment sub create \
  --name "paws-platform" \
  --location "$location" \
  --template-file "$template_file" \
  --parameters \
    location="$location" \
    resourceGroupName="$resource_group" \
    prefix="$prefix" \
    gpuVmSize="$gpu_vm_size" \
    sshPublicKey="$ssh_public_key" \
    adminSourceCidr="$admin_cidr" \
    deployGpuVm="$deploy_gpu" \
    deployGibiWorldVm="$deploy_gibi" \
  --query 'properties.outputs' \
  -o json
