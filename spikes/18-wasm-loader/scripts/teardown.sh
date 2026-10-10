#!/usr/bin/env bash
# Deletes tail objects (through the host, while it still exists), all three Workers,
# every uploaded blob, then the bucket, and prints what is left.
# Usage: HOST_URL=https://keel-spike-18-host.<subdomain>.workers.dev scripts/teardown.sh
set -uo pipefail
cd "$(dirname "$0")/.."
BUCKET=keel-spike-18-wasm
[ -n "${HOST_URL:-}" ] && curl -s "$HOST_URL/purge-tails" && echo
for w in keel-spike-18-host keel-spike-18-tools keel-spike-18-static-pad; do
  pnpm exec wrangler delete --name "$w" --force 2>&1 | grep -E "Successfully|not found|does not exist|ERROR" | head -2
done
for f in build/wasm/*.wasm; do
  pnpm exec wrangler r2 object delete "$BUCKET/$(basename "$f")" --remote >/dev/null 2>&1 && echo "deleted $(basename "$f")"
done
pnpm exec wrangler r2 bucket delete "$BUCKET" 2>&1 | grep -E "Deleted|ERROR|not" | head -3
