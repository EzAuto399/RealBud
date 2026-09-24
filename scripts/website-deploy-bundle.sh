#!/usr/bin/env bash
# Build the realbud.app deploy bundle from committed main only, so production is
# always traceable to two exact commits (website repo + RealBud repo).
#
#   scripts/website-deploy-bundle.sh            build the bundle and print the deploy command
#
# The Vercel project's Root Directory is `website`, and the website imports
# ../shared and ../src from this repo, so the bundle holds website/, shared/
# and src/ side by side plus the project link. Nothing uncommitted is included,
# no secret is read, and nothing is deployed by this script.
set -euo pipefail
# Run from the main RealBud checkout, which holds the website repo in website/.
ROOT="${REALBUD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
WEBSITE="$ROOT/website"
fail() { echo "$1" >&2; exit 1; }

[[ -d "$WEBSITE/.git" ]] || fail "Expected the website repo at $WEBSITE"
[[ -f "$WEBSITE/.vercel/project.json" ]] || fail "Link the website first: (cd website && vercel link)"

git -C "$ROOT" fetch -q origin main
git -C "$WEBSITE" fetch -q origin main
root_ref="$(git -C "$ROOT" rev-parse origin/main)"
site_ref="$(git -C "$WEBSITE" rev-parse origin/main)"

bundle="$(mktemp -d "${TMPDIR:-/tmp}/realbud-website-bundle.XXXXXX")"
mkdir -p "$bundle/website" "$bundle/.vercel"
git -C "$WEBSITE" archive "$site_ref" | tar -x -C "$bundle/website"
# The whole shared/ and src/ trees are small and keep future imports working.
git -C "$ROOT" archive "$root_ref" shared src | tar -x -C "$bundle"
cp "$WEBSITE/.vercel/project.json" "$bundle/.vercel/project.json"
printf '{"websiteCommit":"%s","realbudCommit":"%s","builtAt":"%s"}\n' \
  "$site_ref" "$root_ref" "$(date -u +%FT%TZ)" > "$bundle/website/public/deploy-source.json"

echo "Bundle: $bundle"
echo "  website main: ${site_ref:0:8}   RealBud main: ${root_ref:0:8}"
echo "Deploy it with:  vercel deploy --prod --cwd \"$bundle\""
echo "Then confirm:    curl -s https://realbud.app/deploy-source.json"
