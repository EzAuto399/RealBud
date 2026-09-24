#!/usr/bin/env bash
# Deploy managed-gateway to Fly Sydney. Requires: fly auth login
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.fly/bin:${PATH}"
cd "$ROOT/managed-gateway"
if ! fly auth whoami >/dev/null 2>&1; then
  echo "Run: fly auth login"
  exit 1
fi
fly apps list | grep -q realbud-managed-gateway || fly apps create realbud-managed-gateway
fly volumes list -a realbud-managed-gateway 2>/dev/null | grep -q gateway_data || \
  fly volumes create gateway_data --region syd --size 3 -a realbud-managed-gateway -y
if [[ -z "${REALBUD_GATEWAY_PORTAL_SECRET:-}" ]]; then
  echo "Export REALBUD_GATEWAY_PORTAL_SECRET (>=32 chars) before deploy"
  exit 1
fi

# Installation provisioning. Every one of these is a vendor credential or an
# identifier the operator holds; none has a safe default, and a deployment that
# omits one answers 503 on /ready and on both provisioning routes. Fail loudly
# here rather than shipping a gateway that looks healthy and cannot provision.
missing=()
for name in \
  REALBUD_GATEWAY_OPERATOR_SECRET \
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
  echo "Export these before deploy (values are never echoed): ${missing[*]}"
  exit 1
fi
# The operator secret must be its own value: a portal token must never pass as an operator token.
if (( ${#REALBUD_GATEWAY_OPERATOR_SECRET} < 32 )) || [[ "$REALBUD_GATEWAY_OPERATOR_SECRET" == "$REALBUD_GATEWAY_PORTAL_SECRET" ]]; then
  echo "REALBUD_GATEWAY_OPERATOR_SECRET must be at least 32 characters and differ from the portal secret"
  exit 1
fi
# Modelvia's verifier refuses a shorter operator secret outright.
if (( ${#REALBUD_MODELVIA_OPERATOR_SECRET} < 32 )); then
  echo "REALBUD_MODELVIA_OPERATOR_SECRET must be at least 32 characters"
  exit 1
fi

fly secrets set \
  REALBUD_GATEWAY_PORTAL_SECRET="$REALBUD_GATEWAY_PORTAL_SECRET" \
  REALBUD_GATEWAY_OPERATOR_SECRET="$REALBUD_GATEWAY_OPERATOR_SECRET" \
  REALBUD_ALLOWED_ORIGINS="https://realbud.app,https://www.realbud.app" \
  REALBUD_ENABLE_PROVIDER="1" \
  REALBUD_COMPOSIO_ORG_KEY="$REALBUD_COMPOSIO_ORG_KEY" \
  REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL="$REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL" \
  REALBUD_MODELVIA_OPERATOR_SECRET="$REALBUD_MODELVIA_OPERATOR_SECRET" \
  REALBUD_MODELVIA_OPERATOR_SUBJECT="$REALBUD_MODELVIA_OPERATOR_SUBJECT" \
  REALBUD_MODELVIA_CLIENT_ID="$REALBUD_MODELVIA_CLIENT_ID" \
  ${REALBUD_MODELVIA_MODELS:+REALBUD_MODELVIA_MODELS="$REALBUD_MODELVIA_MODELS"} \
  -a realbud-managed-gateway
# The public origin is a non-secret, but it differs per deployment, so it is set
# here rather than pinned in fly.toml.
fly config env set REALBUD_GATEWAY_PUBLIC_ORIGIN="$REALBUD_GATEWAY_PUBLIC_ORIGIN" -a realbud-managed-gateway 2>/dev/null || \
  fly secrets set REALBUD_GATEWAY_PUBLIC_ORIGIN="$REALBUD_GATEWAY_PUBLIC_ORIGIN" -a realbud-managed-gateway

fly deploy "$ROOT" --config "$ROOT/managed-gateway/fly.toml" --dockerfile "$ROOT/managed-gateway/Dockerfile" -a realbud-managed-gateway
echo "Set website REALBUD_GATEWAY_URL to the app URL from: fly status -a realbud-managed-gateway"
echo "Check provisioning: curl -fsS \"\$REALBUD_GATEWAY_URL/ready\" — 200 means composed, 503 names the variable still to set."
echo "Then create each office's service entitlement on the machine: see DEPLOY.md, 'Order of operations' step 3."
