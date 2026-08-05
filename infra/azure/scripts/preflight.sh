#!/usr/bin/env bash
set -euo pipefail

gpu_subscription_id="${AZURE_GPU_SUBSCRIPTION_ID:-${AZURE_SUBSCRIPTION_ID:-}}"
gpu_location="${AZURE_GPU_LOCATION:-${AZURE_LOCATION:-}}"
gpu_vm_size="${AZURE_GPU_VM_SIZE:-Standard_NC24ads_A100_v4}"

if [[ -z "$gpu_location" ]]; then
  echo "FAIL AZURE_GPU_LOCATION is required; use the exact region where quota was granted"
  exit 1
fi

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

for required_command in az jq curl; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "FAIL missing command: $required_command"
    exit 1
  fi
done

if [[ -z "$gpu_subscription_id" ]]; then
  gpu_subscription_id="$(az account show --query id -o tsv)"
fi

account_state="$(az account show --subscription "$gpu_subscription_id" --query state -o tsv)"
if [[ "$account_state" != "Enabled" ]]; then
  echo "FAIL Azure GPU subscription is not enabled: $account_state"
  exit 1
fi
echo "PASS Azure GPU subscription is enabled"

blocked=0
for provider in Microsoft.Compute Microsoft.Network Microsoft.Storage Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.DevTestLab Microsoft.Quota; do
  state="$(az provider show --subscription "$gpu_subscription_id" --namespace "$provider" --query registrationState -o tsv 2>/dev/null || true)"
  if [[ "$state" == "Registered" ]]; then
    echo "PASS provider $provider"
  else
    echo "BLOCKED provider $provider is ${state:-unknown} in the GPU subscription"
    blocked=1
  fi
done

scope="/subscriptions/${gpu_subscription_id}/providers/Microsoft.Compute/locations/${gpu_location}"
gpu_limit="$(az quota show --subscription "$gpu_subscription_id" --resource-name "$gpu_family" --scope "$scope" --query properties.limit.value -o tsv 2>/dev/null || true)"
if [[ ! "$gpu_limit" =~ ^[0-9]+$ ]]; then
  gpu_limit=0
fi

usage_json="$(az vm list-usage --subscription "$gpu_subscription_id" --location "$gpu_location" -o json)"
gpu_usage="$(jq -r --arg family "$gpu_family" '[.[] | select((.name.value | ascii_downcase) == ($family | ascii_downcase))][0].currentValue // 0' <<<"$usage_json")"
if [[ ! "$gpu_usage" =~ ^[0-9]+$ ]]; then
  gpu_usage=0
fi
gpu_available=$((gpu_limit - gpu_usage))
if (( gpu_available >= gpu_required_vcpus )); then
  echo "PASS $gpu_family has $gpu_available available vCPUs in $gpu_location ($gpu_usage used / $gpu_limit applied)"
else
  echo "BLOCKED $gpu_family has $gpu_available available vCPUs in $gpu_location; $gpu_required_vcpus required for $gpu_vm_size"
  blocked=1
fi

regional_limit="$(jq -r '[.[] | select((.name.value | ascii_downcase) == "cores")][0].limit // 0' <<<"$usage_json")"
regional_usage="$(jq -r '[.[] | select((.name.value | ascii_downcase) == "cores")][0].currentValue // 0' <<<"$usage_json")"
if [[ ! "$regional_limit" =~ ^[0-9]+$ ]]; then regional_limit=0; fi
if [[ ! "$regional_usage" =~ ^[0-9]+$ ]]; then regional_usage=0; fi
regional_available=$((regional_limit - regional_usage))
if (( regional_available >= gpu_required_vcpus )); then
  echo "PASS regional quota has $regional_available available vCPUs in $gpu_location"
else
  echo "BLOCKED regional quota has $regional_available available vCPUs in $gpu_location; $gpu_required_vcpus required for the independent GPU lane"
  blocked=1
fi

sku_json="$(az vm list-skus --subscription "$gpu_subscription_id" --location "$gpu_location" --resource-type virtualMachines --size "$gpu_vm_size" --all -o json)"
sku_count="$(jq -r --arg size "$gpu_vm_size" '[.[] | select(.name == $size)] | length' <<<"$sku_json")"
location_restrictions="$(jq -r --arg size "$gpu_vm_size" '[.[] | select(.name == $size) | .restrictions[]? | select(.type == "Location")] | length' <<<"$sku_json")"
if (( sku_count == 0 || location_restrictions > 0 )); then
  echo "BLOCKED $gpu_vm_size is not offered to this subscription in $gpu_location"
  blocked=1
else
  echo "PASS $gpu_vm_size is listed without a region-wide subscription restriction in $gpu_location"
fi

gpu_price="$(curl -fsSL "https://prices.azure.com/api/retail/prices?\$filter=serviceName%20eq%20%27Virtual%20Machines%27%20and%20priceType%20eq%20%27Consumption%27%20and%20armRegionName%20eq%20%27${gpu_location}%27%20and%20armSkuName%20eq%20%27${gpu_vm_size}%27" | jq -r '[.Items[] | select((.productName|contains("Windows")|not) and (.skuName|contains("Spot")|not) and (.skuName|contains("Low Priority")|not))][0].retailPrice // "unknown"')"
echo "INFO $gpu_vm_size retail rate: USD ${gpu_price}/hour in $gpu_location"
echo "INFO quota and SKU listing do not guarantee a physical allocation; the first deployment remains a capacity test"

if (( blocked != 0 )); then
  exit 2
fi

echo "PASS independent GPU-lane preflight"
