#!/bin/bash
# Collects live P0 evidence without ever copying the repository .env file.

set -euo pipefail
umask 077

: "${P0_EVIDENCE_BASE_URL:?Set P0_EVIDENCE_BASE_URL to the running app origin.}"
: "${P0_EVIDENCE_TOKEN:?Set P0_EVIDENCE_TOKEN to a valid test-account JWT.}"
: "${P0_OPERATOR_RUNBOOK_PATH:?Set P0_OPERATOR_RUNBOOK_PATH to the reviewed operator runbook.}"

EVIDENCE_DIR="${P0_EVIDENCE_DIR:-./docs/P0_evidence}"
CAPS_SOURCE="${P0_CAPS_SOURCE:-./.env}"
mkdir -p "$EVIDENCE_DIR"

if [[ ! -f "$P0_OPERATOR_RUNBOOK_PATH" ]]; then
  echo "Operator runbook does not exist: $P0_OPERATOR_RUNBOOK_PATH" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for live evidence collection." >&2
  exit 1
fi

tmp_body="$(mktemp)"
trap 'rm -f "$tmp_body"' EXIT

status="$(curl --silent --show-error --max-time 20 \
  --output "$tmp_body" --write-out '%{http_code}' \
  --request POST "${P0_EVIDENCE_BASE_URL%/}/api/pets/p0-evidence-probe/rig" \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer ${P0_EVIDENCE_TOKEN}" \
  --data '{}')"

if [[ "$status" != "501" ]] \
  || ! grep -q '"featureFlag"[[:space:]]*:[[:space:]]*"PETSIM_RIG_ENABLED"' "$tmp_body" \
  || ! grep -q '"enabled"[[:space:]]*:[[:space:]]*false' "$tmp_body"; then
  echo "Live disabled-rig check failed with HTTP $status." >&2
  sed -E 's/(token|secret|key)"?[[:space:]]*:[[:space:]]*"[^"]+"/\1":"<REDACTED>"/Ig' "$tmp_body" >&2
  exit 1
fi

{
  echo "# Live disabled-rig endpoint evidence"
  echo
  echo "- Checked at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Origin: ${P0_EVIDENCE_BASE_URL%/}"
  echo "- HTTP status: $status"
  echo "- Result: PASS"
  echo
  echo '```json'
  sed -E 's/(token|secret|key)"?[[:space:]]*:[[:space:]]*"[^"]+"/\1":"<REDACTED>"/Ig' "$tmp_body"
  echo
  echo '```'
} > "$EVIDENCE_DIR/endpoint_disabled_test.md"

# Export only the explicitly allowlisted non-secret guard settings. The raw
# environment file is never copied, even temporarily.
if [[ -f "$CAPS_SOURCE" ]]; then
  grep -E '^PETSIM_(PAID_APIS|RIG|CLASSIFY|SEMANTIC_SCAN|VIDEO|TALKING_VIDEO|MODEL_3D|IMAGE_GENERATION|PAWPRINT)_(ENABLED|DAILY_CAP|GLOBAL_DAILY_CAP|GLOBAL_DAILY_COST_MICRO_USD)=' \
    "$CAPS_SOURCE" > "$EVIDENCE_DIR/configured_caps_allowlisted.env" || true
else
  : > "$EVIDENCE_DIR/configured_caps_allowlisted.env"
fi

{
  echo "# P0 evidence summary"
  echo
  echo "- Live endpoint check: PASS"
  echo "- Operator runbook: $P0_OPERATOR_RUNBOOK_PATH"
  echo "- Guard configuration: allowlisted keys only"
  echo "- Raw environment copied: no"
} > "$EVIDENCE_DIR/summary.md"

echo "P0 evidence checks passed. Sanitized evidence is in $EVIDENCE_DIR."
