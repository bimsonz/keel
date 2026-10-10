#!/usr/bin/env bash
# teardown(candidate) on the stateless path: build a fresh candidate, warm it
# so several router isolates cache it, delete it, then poll for 25 s.
#
#   ROUTER_URL=... ADMIN_TOKEN_FILE=... BASE_DIR=... scripts/delete-check.sh <tag>
#
# Each token is <http>/<served-by>; "gone" means the router answered
# candidate-not-found. "asset0" flags a 200 asset with an empty body.
# Exit 1 if anything is still served after the 10 s revalidation window, or
# if an empty-body asset 200 is ever seen.
set -u
here=$(cd "$(dirname "$0")" && pwd)
tag=${1:?tag}
out="$here/../results/router-delete-$tag.txt"
: >"$out"
log() { echo "$*" | tee -a "$out"; }
now() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
probe() {
  curl -s -D - -o /dev/null "$1" | tr -d '\r' | awk '
    tolower($1)=="x-keel-served-by:"{s=$2} tolower($1)=="content-length:"{l=$2} /^HTTP/{c=$2}
    END{ if (s=="") s="gone"; if (s=="asset" && l=="0") s="asset0"; printf "%s/%s ", c, s }'
}

id=$(node "$here/build-candidate.ts" "$BASE_DIR" "delete-$tag" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).id)')
log "# delete check $tag, candidate $id $(date -u +%FT%TZ)"
log "warm-up api:   $(for _ in $(seq 15); do probe "$ROUTER_URL/cand/$id/users/ghost"; done)"
log "warm-up asset: $(for _ in $(seq 15); do probe "$ROUTER_URL/cand/$id/app.js"; done)"
t0=$(now)
log "DELETE: $(curl -s -X DELETE -H "authorization: Bearer $(cat "$ADMIN_TOKEN_FILE")" "$ROUTER_URL/admin/cand/$id" | tr -d '\n ')"
bad=0
while [ $(( $(now) - t0 )) -lt 25000 ]; do
  at=$(( $(now) - t0 ))
  line="$(for _ in 1 2 3 4 5; do probe "$ROUTER_URL/cand/$id/users/ghost"; probe "$ROUTER_URL/cand/$id/app.js"; done)"
  log "t+${at}ms: $line"
  case "$line" in *asset0*) bad=1 ;; esac
  if [ "$at" -gt 11000 ] && echo "$line" | grep -qE '/(isolate|asset)'; then bad=1; fi
done
if [ $bad -eq 0 ]; then log "verdict: ok (nothing served after the window, no empty 200s)"; else log "verdict: FAIL"; fi
exit $bad
