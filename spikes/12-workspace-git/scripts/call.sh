#!/usr/bin/env bash
# Call the deployed spike Worker. Prints "<http status> <client wall ms>" then the body.
#   WORKER_URL=https://keel-spike-12-client.<subdomain>.workers.dev SPIKE_KEY=... scripts/call.sh /cycle?ws=...
set -euo pipefail
: "${WORKER_URL:?}" "${SPIKE_KEY:?}"
out=$(curl -sS -X POST -H "x-spike-key: ${SPIKE_KEY}" -w '\n%{http_code} %{time_total}' "${WORKER_URL}$1")
body=$(printf '%s' "$out" | sed '$d')
meta=$(printf '%s' "$out" | tail -n1)
printf '%s\n%s\n' "$meta" "$body" | sed -E 's#[0-9a-f]{32}\.artifacts#<account>.artifacts#g; s#art_v[0-9]+_[A-Za-z0-9_]+#art_<redacted>#g'
