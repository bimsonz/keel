#!/usr/bin/env bash
# Call the forker Worker. Prints "<http status> <client wall s>" then the body, redacted.
#   WORKER_URL=https://keel-spike-03-forker.<subdomain>.workers.dev SPIKE_KEY=... scripts/call.sh '/fork?src=src&name=fork1'
set -euo pipefail
: "${WORKER_URL:?}" "${SPIKE_KEY:?}"
out=$(curl -sS -X POST -H "x-spike-key: ${SPIKE_KEY}" -w '\n%{http_code} %{time_total}' "${WORKER_URL}$1")
printf '%s\n%s\n' "$(printf '%s' "$out" | tail -n1)" "$(printf '%s' "$out" | sed '$d')" |
  sed -E 's#art_v[0-9]+_[A-Za-z0-9_]+(\?expires=[0-9]+)?#<token>#g; s#[0-9a-f]{32}\.artifacts#<acct>.artifacts#g; s#[a-z0-9-]+\.workers\.dev#<subdomain>.workers.dev#g'
