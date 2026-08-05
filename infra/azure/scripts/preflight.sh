#!/usr/bin/env bash
set -euo pipefail

subscription_id="${AZURE_SUBSCRIPTION_ID:-}"
location="${AZURE_LOCATION:-eastus}"
gpu_family="StandardNCadsH100v5Family"

for required_command in az jq curl; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "FAIL missing command: $required_command"
    exit 1
  fi
done

if [[ -z "$subscription_id" ]]; then
  subscription_id="$(az account show --query id -o tsv)"
fi

account_state="$(az account show --query state -o tsv)"
if [[ "$account_state" != "Enabled" ]]; then
  echo "FAIL Azure subscription is not enabled: $account_state"
  exit 1
fi
echo "PASS Azure subscription is enabled"

blocked=0
for provider in Microsoft.Compute Microsoft.Network Microsoft.Storage Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.OperationalInsights Microsoft.DevTestLab Microsoft.Quota; do
  state="$(az provider show --namespace "$provider" --query registrationState -o tsv 2>/dev/null || true)"
  if [[ "$state" == "Registered" ]]; then
    echo "PASS provider $provider"
  else
    echo "BLOCKED provider $provider is $state"
    blocked=1
  fi
done

scope="/subscriptions/${subscription_id}/providers/Microsoft.Compute/locations/${location}"
gpu_limit="$(az quota show --resource-name "$gpu_family" --scope "$scope" --query properties.limit.value -o tsv 2>/dev/null || echo 0)"
if (( gpu_limit >= 40 )); then
  echo "PASS H100 family quota is $gpu_limit vCPUs in $location"
else
  echo "BLOCKED H100 family quota is $gpu_limit vCPUs in $location; 40 required"
  blocked=1
fi

regional_limit="$(az vm list-usage --location "$location" --query "[?name.value=='cores'].limit | [0]" -o tsv)"
if (( regional_limit >= 52 )); then
  echo "PASS regional vCPU quota is $regional_limit"
else
  echo "BLOCKED regional vCPU quota is $regional_limit; 52 required for H100 + core + GibiWorld"
  blocked=1
fi

h100_price="$(curl -fsSL "https://prices.azure.com/api/retail/prices?\$filter=serviceName%20eq%20%27Virtual%20Machines%27%20and%20priceType%20eq%20%27Consumption%27%20and%20armRegionName%20eq%20%27${location}%27%20and%20armSkuName%20eq%20%27Standard_NC40ads_H100_v5%27" | jq -r '[.Items[] | select((.productName|contains("Windows")|not) and (.skuName|contains("Spot")|not) and (.skuName|contains("Low Priority")|not))][0].retailPrice // "unknown"')"
echo "INFO Standard_NC40ads_H100_v5 retail rate: USD ${h100_price}/hour in $location"

if (( blocked != 0 )); then
  exit 2
fi

echo "PASS Azure platform preflight"
