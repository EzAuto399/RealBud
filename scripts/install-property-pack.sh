#!/bin/sh
# Install the locked RealBud `property` profile. Does not launch Hermes.app.
# Does not edit Hermes source. Optional: pin the hermes-agent git checkout.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
PACK="$ROOT/pack/property"
DATA_REALBUD="${REALBUD_DATA_DIR:-${OMB_DATA_DIR:-$HOME/.realbud}}"
HOME_HERMES="${REALBUD_WORKER_HOME:-$DATA_REALBUD/worker}"
RUNTIME_HOME="$HOME_HERMES/runtime"
HERMES_CLI="$RUNTIME_HOME/.local/bin/hermes"
COMMIT="${HERMES_PIN_COMMIT:-7339f5f160db5c96657a3bab60151227cc61f66c}"

if [ ! -f "$PACK/distribution.yaml" ]; then
  echo "missing pack at $PACK" >&2
  exit 1
fi

# Only RealBud's private checkout may be pinned. A personal checkout is never
# discovered through PATH or ~/.hermes.
if [ "${REALBUD_PIN_CHECKOUT:-}" = "1" ] && [ -d "$RUNTIME_HOME/hermes-agent/.git" ]; then
  echo "pinning hermes-agent to $COMMIT"
  git -C "$RUNTIME_HOME/hermes-agent" fetch --tags origin "$COMMIT" 2>/dev/null || true
  git -C "$RUNTIME_HOME/hermes-agent" checkout --detach "$COMMIT"
fi

if [ -x "$HERMES_CLI" ]; then
  HOME="$RUNTIME_HOME" HERMES_HOME="$HOME_HERMES" "$HERMES_CLI" profile install "$PACK" --name property --force -y
else
  echo "RealBud worker is not installed — copying pack files only"
  dest="$HOME_HERMES/profiles/property"
  mkdir -p "$dest"
  cp "$PACK/SOUL.md" "$PACK/config.yaml" "$PACK/distribution.yaml" "$PACK/profile.yaml" "$dest/"
  mkdir -p "$dest/skills"
  cp -R "$PACK/skills/." "$dest/skills/"
fi

echo "property pack ready at $HOME_HERMES/profiles/property"
