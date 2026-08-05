#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 MODEL_DIRECTORY [MODEL_DIRECTORY ...]" >&2
  exit 2
fi

for dependency in file find grep; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "Missing required scanner dependency: $dependency" >&2
    exit 1
  fi
done

for root in "$@"; do
  if [[ ! -d "$root" ]]; then
    echo "Model directory does not exist" >&2
    exit 1
  fi
done

text_files=0
private_key_files=0
live_token_files=0
azure_connection_files=0
credential_url_files=0
email_files=0

while IFS= read -r -d '' candidate; do
  mime_type="$(file -b --mime-type "$candidate")"
  case "$mime_type" in
    text/*|application/json|application/x-empty) ;;
    *) continue ;;
  esac

  text_files=$((text_files + 1))
  grep -Eql -- '-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----' "$candidate" && \
    private_key_files=$((private_key_files + 1)) || true
  grep -Eql -- '(hf_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,})' "$candidate" && \
    live_token_files=$((live_token_files + 1)) || true
  grep -Eql -- '(DefaultEndpointsProtocol=|AccountKey=)' "$candidate" && \
    azure_connection_files=$((azure_connection_files + 1)) || true
  grep -Eql -- 'https?://[^[:space:]/:@]+:[^[:space:]@]+@' "$candidate" && \
    credential_url_files=$((credential_url_files + 1)) || true
  grep -Eql -- '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$candidate" && \
    email_files=$((email_files + 1)) || true
done < <(find "$@" -type f ! -path '*/.cache/*' -size -5M -print0)

printf 'text_files=%s private_key_files=%s live_token_files=%s azure_connection_files=%s credential_url_files=%s email_files=%s values_printed=false\n' \
  "$text_files" \
  "$private_key_files" \
  "$live_token_files" \
  "$azure_connection_files" \
  "$credential_url_files" \
  "$email_files"
