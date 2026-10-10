#!/usr/bin/env bash
# Deploys keel-spike-18-static-pad with each given padded module and prints what
# the API says. Usage: scripts/static-pad.sh 10-active 30-passive ...
set -uo pipefail
cd "$(dirname "$0")/.."
for v in "$@"; do
  cp "build/wasm/pad-$v.wasm" build/wasm/pad-static.wasm
  echo "== pad-$v.wasm ($(wc -c < "build/wasm/pad-$v.wasm" | tr -d ' ') B)"
  pnpm exec wrangler deploy -c wrangler.static-pad.jsonc 2>&1 \
    | grep -E "Total Upload|Startup Time|Uploaded|ERROR|exceed|limit|too large|code: [0-9]+" \
    | sed -E 's#/accounts/[0-9a-f]+/#/accounts/<account>/#'
done
