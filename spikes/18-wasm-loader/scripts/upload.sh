#!/usr/bin/env bash
# Creates the R2 bucket (if needed) and uploads every blob from build/wasm/.
# Expects CLOUDFLARE_ACCOUNT_ID in the environment (never in wrangler.jsonc).
set -euo pipefail
cd "$(dirname "$0")/.."
BUCKET=keel-spike-18-wasm
pnpm exec wrangler r2 bucket create "$BUCKET" 2>&1 | grep -v "^\s*$" || true
for f in build/wasm/*.wasm; do
  key=$(basename "$f")
  pnpm exec wrangler r2 object put "$BUCKET/$key" --file "$f" --content-type application/wasm --remote >/dev/null
  printf '%-30s %12s B\n' "$key" "$(wc -c < "$f" | tr -d ' ')"
done
