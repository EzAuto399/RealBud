#!/bin/sh
# Developer helper for the same preserving profile repair used by RealBud.
# Upstream Hermes source and the personal ~/.hermes installation are untouched.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
if [ "${REALBUD_PIN_CHECKOUT:-}" = "1" ]; then
  echo "Use RealBud → You → Agent updates to select a verified runtime. This helper never changes Hermes source." >&2
  exit 2
fi
REALBUD_HERMES_HOME="${REALBUD_HERMES_HOME:-$HOME/.realbud/hermes}"
export REALBUD_HERMES_HOME
cd "$ROOT"
node --experimental-strip-types --input-type=module -e 'import { applyPropertyPack } from "./server/hermes-pack.ts"; applyPropertyPack(); console.log("Bud profile repaired. Existing model, memory and skills kept. Run the readiness check in RealBud.");'
