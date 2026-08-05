#!/usr/bin/env bash
set -euo pipefail
umask 077

printf 'Paste Hugging Face fine-grained READ token (input hidden): '
IFS= read -rs hf_token
printf '\n'

if [[ "$hf_token" != hf_* ]]; then
  unset hf_token
  echo "No valid Hugging Face token was received; nothing changed."
  exit 2
fi

echo "Token format accepted locally; resolving the private Azure staging host."

core_ip="$(az vm show \
  --resource-group Trellis \
  --name pawstrellis-core-01 \
  --show-details \
  --query publicIps \
  --output tsv)"

if [[ -z "$core_ip" ]]; then
  unset hf_token
  echo "The Azure core VM address could not be resolved."
  exit 1
fi

printf '%s\n' "$hf_token" | ssh \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  -o LogLevel=QUIET \
  "pawsadmin@${core_ip}" \
  'set -euo pipefail
   IFS= read -r HF_TOKEN
   if [[ "$HF_TOKEN" != hf_* ]]; then
     unset HF_TOKEN
     echo "Azure did not receive a valid token; nothing changed."
     exit 2
   fi
   export HF_TOKEN
   trap "unset HF_TOKEN" EXIT
   echo "Token received by Azure; starting private model staging."
   cd /opt/paws-model-tools/current
   ./infra/azure/scripts/stage-trellis-models.sh complete'

unset hf_token
echo "Approved TRELLIS dependencies finished staging on Azure."
