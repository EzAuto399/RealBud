#!/bin/sh
# Install the locked RealBud `property` profile. Does not launch Hermes.app.
# Does not edit Hermes source. Optional: pin the hermes-agent git checkout.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
PACK="$ROOT/pack/property"
HOME_HERMES="${HERMES_HOME:-$HOME/.hermes}"
COMMIT="${HERMES_PIN_COMMIT:-7339f5f160db5c96657a3bab60151227cc61f66c}"

if [ ! -f "$PACK/distribution.yaml" ]; then
  echo "missing pack at $PACK" >&2
  exit 1
fi

# Do not detach a personal hermes-agent checkout unless asked.
# Product installers set REALBUD_PIN_CHECKOUT=1. Desk fails closed if the pin does not match.
if [ "${REALBUD_PIN_CHECKOUT:-}" = "1" ] && [ -d "$HOME_HERMES/hermes-agent/.git" ]; then
  echo "pinning hermes-agent to $COMMIT"
  git -C "$HOME_HERMES/hermes-agent" fetch --tags origin "$COMMIT" 2>/dev/null || true
  git -C "$HOME_HERMES/hermes-agent" checkout --detach "$COMMIT"
fi

if command -v hermes >/dev/null 2>&1; then
  hermes profile install "$PACK" --name property --force -y
else
  echo "hermes CLI not on PATH — copying pack files only"
  dest="$HOME_HERMES/profiles/property"
  mkdir -p "$dest"
  cp "$PACK/SOUL.md" "$PACK/config.yaml" "$PACK/distribution.yaml" "$PACK/profile.yaml" "$dest/"
  mkdir -p "$dest/skills"
  cp -R "$PACK/skills/." "$dest/skills/"
fi

echo "property pack ready at $HOME_HERMES/profiles/property"
echo "headless only: hermes --profile property chat -Q -q '...'"
echo "attach a model: hermes -p property model"
echo "do not run: hermes desktop / hermes gui"
