#!/usr/bin/env bash
# STREAM_ID comes from `wrangler k2 streams create keel_spike_05_ops --json`.
#   STREAM_ID=... scripts/deploy.sh
# Writes wrangler.deploy.jsonc (gitignored) with the stream ID filled in, deploys,
# and redacts IDs and the workers.dev host from the output.
set -euo pipefail
: "${STREAM_ID:?}"
cd "$(dirname "$0")/.."
sed "s/__STREAM_ID__/${STREAM_ID}/g" wrangler.jsonc > wrangler.deploy.jsonc
pnpm exec wrangler deploy -c wrangler.deploy.jsonc 2>&1 | grep -v 'WARN.*npmrc' | sed -E 's/[0-9a-f]{16,}/<id>/g; s#https://[^ ]*workers\.dev#https://keel-spike-05-log.<subdomain>.workers.dev#g'
