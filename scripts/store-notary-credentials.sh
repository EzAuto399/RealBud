#!/usr/bin/env bash
# Interactive one-shot: store Apple notary credentials in the login keychain.
# Never paste the app-specific password into chat or commit it.
#
#   ./scripts/store-notary-credentials.sh
#   APPLE_ID=you@example.com ./scripts/store-notary-credentials.sh
set -euo pipefail

PROFILE="${NOTARY_KEYCHAIN_PROFILE:-realbud-notary}"
APPLE_ID="${APPLE_ID:-justnewyodacc@gmail.com}"
TEAM_ID="${APPLE_TEAM_ID:-4F4SMS88P8}"

echo "Profile : $PROFILE"
echo "Apple ID: $APPLE_ID"
echo "Team ID : $TEAM_ID"
echo
echo "Use an app-specific password from appleid.apple.com → Sign-In & Security"
echo "(not your Apple Account login password)."
echo

xcrun notarytool store-credentials "$PROFILE" \
  --apple-id "$APPLE_ID" \
  --team-id "$TEAM_ID" \
  --validate

echo
echo "OK — verifying:"
xcrun notarytool history --keychain-profile "$PROFILE" | head -5
echo
echo "Next: pnpm package:mac:release && pnpm clean:release"
