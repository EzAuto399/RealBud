#!/usr/bin/env bash
# Deploy managed-gateway to Fly Sydney. Requires: fly auth login
#
#   managed-gateway/deploy.sh            validate, stage secrets, deploy
#   managed-gateway/deploy.sh --check    validate only; no Fly change
#
# Every check runs before anything touches Fly, so a missing or malformed
# variable is named (never echoed) and no app, volume or secret is changed.
# Secrets are stable values recovered from protected storage: this script never
# generates one, so a redeploy never rotates a key the running service depends on.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.fly/bin:${PATH}"
cd "$ROOT/managed-gateway"

fail() { echo "$1" >&2; exit 1; }
one_line() { [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]]; }
[[ $# -eq 0 || ( $# -eq 1 && "$1" == "--check" ) ]] || fail "Usage: deploy.sh [--check]"

# --- Portal and operator secrets ------------------------------------------
portal_secret="${REALBUD_GATEWAY_PORTAL_SECRET:-}"
operator_secret="${REALBUD_GATEWAY_OPERATOR_SECRET:-}"
[[ ${#portal_secret} -ge 32 ]] && one_line "$portal_secret" ||
  fail "REALBUD_GATEWAY_PORTAL_SECRET must be a stable secret of at least 32 characters without line breaks"
# The operator secret must be its own value: a portal token must never pass as an operator token.
[[ ${#operator_secret} -ge 32 && "$operator_secret" != "$portal_secret" ]] && one_line "$operator_secret" ||
  fail "REALBUD_GATEWAY_OPERATOR_SECRET must be at least 32 characters, distinct from the portal secret, and without line breaks"

# --- Installation provisioning --------------------------------------------
# Every one of these is a vendor credential or an identifier the operator holds;
# none has a safe default, and a deployment that omits one answers 503 on /ready
# and on both provisioning routes. Fail loudly here rather than shipping a
# gateway that looks healthy and cannot provision.
missing=()
for name in \
  REALBUD_COMPOSIO_ORG_KEY \
  REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL \
  REALBUD_MODELVIA_OPERATOR_SECRET \
  REALBUD_MODELVIA_OPERATOR_SUBJECT \
  REALBUD_MODELVIA_CLIENT_ID \
  REALBUD_GATEWAY_PUBLIC_ORIGIN
do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
if (( ${#missing[@]} )); then
  fail "Export these before deploy (values are never echoed): ${missing[*]}"
fi
# Modelvia's verifier refuses a shorter operator secret outright.
(( ${#REALBUD_MODELVIA_OPERATOR_SECRET} >= 32 )) || fail "REALBUD_MODELVIA_OPERATOR_SECRET must be at least 32 characters"

# --- Care-fee collection through Square -----------------------------------
# REALBUD_PAYMENT_MODE is local (default: invoices close and read, no checkout),
# sandbox or live. A collection mode needs every Square variable and the explicit
# authorization flag; live also needs the reviewed seller-basis digest and the
# three approval references. The server refuses to start otherwise, so the same
# rule is applied here before any Fly change.
payment_mode="${REALBUD_PAYMENT_MODE:-local}"
square_names=(SQUARE_ACCESS_TOKEN SQUARE_MERCHANT_ID SQUARE_LOCATION_ID SQUARE_NOTIFICATION_URL SQUARE_WEBHOOK_SIGNATURE_KEY REALBUD_INTERNAL_COMPANY_ID)
live_names=(REALBUD_SELLER_BASIS_APPROVAL_REF REALBUD_PRODUCTION_INVOICE_APPROVAL_REF REALBUD_MANAGED_PROJECT_VERIFIED_REF)
case "$payment_mode" in
  local) ;;
  sandbox|live)
    [[ "${REALBUD_AUTHORIZE_COLLECTION:-}" == "1" ]] || fail "REALBUD_AUTHORIZE_COLLECTION=1 is required for REALBUD_PAYMENT_MODE=$payment_mode"
    missing=()
    for name in "${square_names[@]}"; do [[ -n "${!name:-}" ]] || missing+=("$name"); done
    if [[ "$payment_mode" == "live" ]]; then
      [[ "${REALBUD_SELLER_BASIS_DIGEST:-}" =~ ^[a-f0-9]{64}$ ]] || missing+=(REALBUD_SELLER_BASIS_DIGEST)
      for name in "${live_names[@]}"; do [[ -n "${!name:-}" ]] || missing+=("$name"); done
    fi
    if (( ${#missing[@]} )); then
      fail "REALBUD_PAYMENT_MODE=$payment_mode needs these (values are never echoed): ${missing[*]}"
    fi
    [[ "${SQUARE_NOTIFICATION_URL}" == https://*/v1/webhooks/square ]] ||
      fail "SQUARE_NOTIFICATION_URL must be this gateway's https origin followed by /v1/webhooks/square"
    ;;
  *) fail "REALBUD_PAYMENT_MODE must be local, sandbox or live" ;;
esac

if [[ "${1:-}" == "--check" ]]; then
  echo "Deployment preflight passed for REALBUD_PAYMENT_MODE=$payment_mode (no Fly changes made)"
  exit 0
fi

command -v fly >/dev/null 2>&1 || fail "Install flyctl before deploying"
if ! fly auth whoami >/dev/null 2>&1; then
  fail "Run: fly auth login"
fi
fly apps list | grep -q realbud-managed-gateway || fly apps create realbud-managed-gateway
fly volumes list -a realbud-managed-gateway 2>/dev/null | grep -q gateway_data || \
  fly volumes create gateway_data --region syd --size 3 -a realbud-managed-gateway -y

# Import over stdin so no secret value appears in a process argument. Staged for
# the single deploy below; this sets exactly what was exported and rotates nothing.
{
  printf 'REALBUD_GATEWAY_PORTAL_SECRET=%s\n' "$portal_secret"
  printf 'REALBUD_GATEWAY_OPERATOR_SECRET=%s\n' "$operator_secret"
  printf 'REALBUD_ALLOWED_ORIGINS=%s\n' "https://realbud.app,https://www.realbud.app"
  printf 'REALBUD_ENABLE_PROVIDER=1\n'
  printf 'REALBUD_COMPOSIO_ORG_KEY=%s\n' "$REALBUD_COMPOSIO_ORG_KEY"
  printf 'REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL=%s\n' "$REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL"
  printf 'REALBUD_MODELVIA_OPERATOR_SECRET=%s\n' "$REALBUD_MODELVIA_OPERATOR_SECRET"
  printf 'REALBUD_MODELVIA_OPERATOR_SUBJECT=%s\n' "$REALBUD_MODELVIA_OPERATOR_SUBJECT"
  printf 'REALBUD_MODELVIA_CLIENT_ID=%s\n' "$REALBUD_MODELVIA_CLIENT_ID"
  [[ -z "${REALBUD_MODELVIA_MODELS:-}" ]] || printf 'REALBUD_MODELVIA_MODELS=%s\n' "$REALBUD_MODELVIA_MODELS"
  printf 'REALBUD_PAYMENT_MODE=%s\n' "$payment_mode"
  # Modelvia commercial terms and the per-request cap: non-secret, set only when
  # exported (DEPLOY.md, "Live Modelvia integration values").
  for name in REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES REALBUD_MODELVIA_CLIENT_FUNDED_REFERENCE \
    REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS REALBUD_MODELVIA_RESALE_TERMS_REFERENCE REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD; do
    [[ -z "${!name:-}" ]] || printf '%s=%s\n' "$name" "${!name}"
  done
  if [[ "$payment_mode" != "local" ]]; then
    printf 'REALBUD_AUTHORIZE_COLLECTION=1\n'
    for name in "${square_names[@]}"; do printf '%s=%s\n' "$name" "${!name}"; done
    if [[ "$payment_mode" == "live" ]]; then
      printf 'REALBUD_SELLER_BASIS_DIGEST=%s\n' "$REALBUD_SELLER_BASIS_DIGEST"
      for name in "${live_names[@]}"; do printf '%s=%s\n' "$name" "${!name}"; done
    fi
  fi
} | fly secrets import --stage -a realbud-managed-gateway
# The public origin is a non-secret, but it differs per deployment, so it is set
# here rather than pinned in fly.toml.
fly config env set REALBUD_GATEWAY_PUBLIC_ORIGIN="$REALBUD_GATEWAY_PUBLIC_ORIGIN" -a realbud-managed-gateway 2>/dev/null || \
  fly secrets set REALBUD_GATEWAY_PUBLIC_ORIGIN="$REALBUD_GATEWAY_PUBLIC_ORIGIN" -a realbud-managed-gateway

fly deploy "$ROOT" --config "$ROOT/managed-gateway/fly.toml" --dockerfile "$ROOT/managed-gateway/Dockerfile" -a realbud-managed-gateway
echo "Set website REALBUD_GATEWAY_URL to the app URL from: fly status -a realbud-managed-gateway"
echo "Check provisioning: curl -fsS \"\$REALBUD_GATEWAY_URL/ready\" — 200 means composed, 503 names the variable still to set."
echo "Then create each office's service entitlement on the machine: see DEPLOY.md, 'Order of operations' step 3."
