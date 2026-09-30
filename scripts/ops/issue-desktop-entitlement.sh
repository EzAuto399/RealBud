#!/usr/bin/env bash
# One-time, owner-run: issue the signed service entitlement for ONE linked
# desktop on the Fly gateway and install it into that desktop's RealBud data.
# Stopgap until the gateway delivers entitlements automatically on link.
#
#   scripts/ops/issue-desktop-entitlement.sh [RealBud data dir, default ~/.realbud]
#
# Reads companyId + hostInstallationId from <data>/service-installation.json,
# signs with the gateway's existing key, copies back only the public bundle,
# and installs it with the desktop's own verifier (pinned to the key digest).
set -euo pipefail
APP=realbud-managed-gateway
DATA="${1:-$HOME/.realbud}"
KEY_ID=realbud-20260926-a
KEY_FILE=/data/service-issuer/ed25519-20260926-a.pem
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

read -r COMPANY HOST < <(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d['companyId'],d['hostInstallationId'])" "$DATA/service-installation.json")
OUT="/data/service-issuer/bundle-${HOST:0:8}-$(date -u +%Y%m%d%H%M).json"
echo "Issuing for office $COMPANY, computer $HOST"

RESULT=$(fly ssh console -a "$APP" -C "node --experimental-strip-types /app/managed-gateway/service-entitlement-issuer.ts --company $COMPANY --installation $HOST --key-id $KEY_ID --key-file $KEY_FILE --out $OUT" 2>/dev/null | grep '"result"' | tail -1)
echo "$RESULT"
DIGEST=$(printf '%s' "$RESULT" | python3 -c "import json,sys;d=json.loads(sys.stdin.read());assert d['result']=='issued';print(d['publicKeySha256'])")

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT; chmod 700 "$TMP"
fly ssh sftp get -a "$APP" "$OUT" "$TMP/bundle.json" >/dev/null
chmod 600 "$TMP/bundle.json"

node --experimental-strip-types "$REPO/server/service-entitlement-install-cli.ts" \
  --data "$DATA" --bundle "$TMP/bundle.json" --public-key-sha256 "$DIGEST"
echo "Installed. RealBud picks it up on its next check; auto-setup retries the readiness check on its own."
