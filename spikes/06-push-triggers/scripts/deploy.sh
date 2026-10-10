#!/usr/bin/env bash
# D1_ID comes from `wrangler d1 create keel-spike-06-log`.
#   D1_ID=... scripts/deploy.sh
set -euo pipefail
: "${D1_ID:?}"
cd "$(dirname "$0")/.."
sed "s/__D1_ID__/${D1_ID}/" wrangler.jsonc > wrangler.deploy.jsonc
pnpm exec wrangler deploy -c wrangler.deploy.jsonc 2>&1 | grep -v WARN | sed -E 's/[0-9a-f]{32}/<acct>/g; s#https://[^ ]*workers\.dev#https://<worker>.workers.dev#g'
