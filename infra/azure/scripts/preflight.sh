#!/usr/bin/env bash
set -euo pipefail

subscription_id="${AZURE_SUBSCRIPTION_ID:-}"
location="${AZURE_LOCATION:-eastus}"
gpu_vm_size="${AZURE_GPU_VM_SIZE:-Standard_NC40ads_H100_v5}"

case "$gpu_vm_size" in
  Standard_NC40ads_H100_v5)
    default_gpu_family="StandardNCadsH100v5Family"
    default_gpu_vcpus=40
    ;;
  Standard_NC24ads_A100_v4)
    default_gpu_family="StandardNCADSA100v4Family"
    default_gpu_vcpus=24
    ;;
  Standard_NC16ads_A10_v4)
    default_gpu_family="StandardNCADSA10v4Family"
    default_gpu_vcpus=16
    ;;
  Standard_NV36ads_A10_v5|Standard_NV36adms_A10_v5)
    default_gpu_family="StandardNVADSA10v5Family"
    default_gpu_vcpus=36
    ;;
  *)
    if [[ -z "${AZURE_GPU_FAMILY:-}" || -z "${AZURE_GPU_REQUIRED_VCPUS:-}" ]]; then
      echo "FAIL unknown GPU size $gpu_vm_size; set AZURE_GPU_FAMILY and AZURE_GPU_REQUIRED_VCPUS"
      exit 1
    fi
    default_gpu_family="$AZURE_GPU_FAMILY"
    default_gpu_vcpus="$AZURE_GPU_REQUIRED_VCPUS"
    ;;
esac

gpu_family="${AZURE_GPU_FAMILY:-$default_gpu_family}"
gpu_required_vcpus="${AZURE_GPU_REQUIRED_VCPUS:-$default_gpu_vcpus}"
if [[ ! "$gpu_required_vcpus" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIL AZURE_GPU_REQUIRED_VCPUS must be a positive integer"
  exit 1
fi
regional_required_vcpus=$((gpu_required_vcpus + 12))

for required_command in az jq curl; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "FAIL missing command: $required_command"
    exit 1
  fi
done

if [[ -z "$subscription_id" ]]; then
  subscription_id="$(az account show --query id -o tsv)"
fi

account_state="$(az account show --subscription "$subscription_id" --query state -o tsv)"
if [[ "$account_state" != "Enabled" ]]; then
  echo "FAIL Azure subscription is not enabled: $account_state"
  exit 1
fi
echo "PASS Azure subscription is enabled"

blocked=0
for provider in Microsoft.Compute Microsoft.Network Microsoft.Storage Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.OperationalInsights Microsoft.DevTestLab Microsoft.Quota; do
  state="$(az provider show --subscription "$subscription_id" --namespace "$provider" --query registrationState -o tsv 2>/dev/null || true)"
  if [[ "$state" == "Registered" ]]; then
    echo "PASS provider $provider"
  else
    echo "BLOCKED provider $provider is $state"
    blocked=1
  fi
done

scope="/subscriptions/${subscription_id}/providers/Microsoft.Compute/locations/${location}"
gpu_limit="$(az quota show --resource-name "$gpu_family" --scope "$scope" --query properties.limit.value -o tsv 2>/dev/null || true)"
if [[ ! "$gpu_limit" =~ ^[0-9]+$ ]]; then
  gpu_limit=0
fi
if (( gpu_limit >= gpu_required_vcpus )); then
  echo "PASS $gpu_family quota is $gpu_limit vCPUs in $location"
else
  echo "BLOCKED $gpu_family quota is $gpu_limit vCPUs in $location; $gpu_required_vcpus required for $gpu_vm_size"
  blocked=1
fi

regional_limit="$(az vm list-usage --subscription "$subscription_id" --location "$location" --query "[?name.value=='cores'].limit | [0]" -o tsv)"
if (( regional_limit >= regional_required_vcpus )); then
  echo "PASS regional vCPU quota is $regional_limit"
else
  echo "BLOCKED regional vCPU quota is $regional_limit; $regional_required_vcpus required for GPU + core + GibiWorld"
  blocked=1
fi

gpu_price="$(curl -fsSL "https://prices.azure.com/api/retail/prices?\$filter=serviceName%20eq%20%27Virtual%20Machines%27%20and%20priceType%20eq%20%27Consumption%27%20and%20armRegionName%20eq%20%27${location}%27%20and%20armSkuName%20eq%20%27${gpu_vm_size}%27" | jq -r '[.Items[] | select((.productName|contains("Windows")|not) and (.skuName|contains("Spot")|not) and (.skuName|contains("Low Priority")|not))][0].retailPrice // "unknown"')"
echo "INFO $gpu_vm_size retail rate: USD ${gpu_price}/hour in $location"

if (( blocked != 0 )); then
  exit 2
fi

echo "PASS Azure platform preflight"
