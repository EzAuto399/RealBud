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
fly secrets set \
  REALBUD_GATEWAY_PORTAL_SECRET="$REALBUD_GATEWAY_PORTAL_SECRET" \
  REALBUD_PAYMENT_WEBHOOK_KEY="${REALBUD_PAYMENT_WEBHOOK_KEY:-$(openssl rand -hex 32)}" \
  REALBUD_FINGERPRINT_KEY="${REALBUD_FINGERPRINT_KEY:-$(openssl rand -hex 32)}" \
  REALBUD_ALLOWED_ORIGINS="https://realbud.app,https://www.realbud.app" \
  -a realbud-managed-gateway
fly deploy -a realbud-managed-gateway
echo "Set website REALBUD_GATEWAY_URL to the app URL from: fly status -a realbud-managed-gateway"
