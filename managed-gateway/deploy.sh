#!/usr/bin/env bash
# Deploy managed-gateway to Fly Sydney. Requires: fly auth login
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.fly/bin:${PATH}"
cd "$ROOT/managed-gateway"

fail() { echo "$1" >&2; exit 1; }
require_hex_key() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[a-fA-F0-9]{64,}$ ]] && (( ${#value} % 2 == 0 )) ||
    fail "$name must be a persistent, even-length hex key of at least 32 bytes"
}

# Validate before creating an app/volume or changing staged secrets. Missing keys
# must be recovered from protected storage, never regenerated on redeploy.
portal_secret="${REALBUD_GATEWAY_PORTAL_SECRET:-}"
fingerprint_key="${REALBUD_FINGERPRINT_KEY:-}"
webhook_key="${REALBUD_PAYMENT_WEBHOOK_KEY:-}"
operator_secret="${REALBUD_GATEWAY_OPERATOR_SECRET:-}"
[[ ${#portal_secret} -ge 32 && "$portal_secret" != *$'\n'* && "$portal_secret" != *$'\r'* ]] ||
  fail "REALBUD_GATEWAY_PORTAL_SECRET must be a stable secret of at least 32 characters without line breaks"
require_hex_key REALBUD_FINGERPRINT_KEY "$fingerprint_key"
require_hex_key REALBUD_PAYMENT_WEBHOOK_KEY "$webhook_key"
if [[ -n "$operator_secret" ]]; then
  [[ ${#operator_secret} -ge 32 && "$operator_secret" != "$portal_secret" &&
    "$operator_secret" != *$'\n'* && "$operator_secret" != *$'\r'* ]] ||
    fail "REALBUD_GATEWAY_OPERATOR_SECRET must be at least 32 characters, distinct from the portal secret, and without line breaks"
fi
[[ $# -eq 0 || ( $# -eq 1 && "$1" == "--check" ) ]] || fail "Usage: deploy.sh [--check]"
if [[ "${1:-}" == "--check" ]]; then
  echo "Fly deployment secret preflight passed (no Fly changes made)"
  exit 0
fi

command -v fly >/dev/null 2>&1 || fail "Install flyctl before deploying"
if ! fly auth whoami >/dev/null 2>&1; then
  echo "Run: fly auth login"
  exit 1
fi
fly apps list | grep -q realbud-managed-gateway || fly apps create realbud-managed-gateway
fly volumes list -a realbud-managed-gateway 2>/dev/null | grep -q gateway_data || \
  fly volumes create gateway_data --region syd --size 3 -a realbud-managed-gateway -y
# Import over stdin so secret values do not appear in flyctl process arguments.
# Stage for the single deploy below; this does not rotate stable keys.
{
  printf 'REALBUD_GATEWAY_PORTAL_SECRET=%s\n' "$portal_secret"
  printf 'REALBUD_FINGERPRINT_KEY=%s\n' "$fingerprint_key"
  printf 'REALBUD_PAYMENT_WEBHOOK_KEY=%s\n' "$webhook_key"
  if [[ -n "$operator_secret" ]]; then
    printf 'REALBUD_GATEWAY_OPERATOR_SECRET=%s\n' "$operator_secret"
  fi
  printf 'REALBUD_ALLOWED_ORIGINS=https://realbud.app,https://www.realbud.app\n'
} | fly secrets import --stage -a realbud-managed-gateway
fly deploy -a realbud-managed-gateway
echo "Set website REALBUD_GATEWAY_URL to the app URL from: fly status -a realbud-managed-gateway"
