#!/usr/bin/env bash
# (a) The isolate preview router, measured from this machine.
#
#   ROUTER_URL=... ADMIN_TOKEN_FILE=... BASE_DIR=<base copy> A_DIR=<A copy> \
#     scripts/bench-router.sh <tag> [cand|pinned]
#
# cand:   /cand/<id>/...   stateless: whichever router isolate takes the request
# pinned: /pinned/<id>/... via a Durable Object named by the id
#
# Cold: each sample is a new candidate id (a base build with a fresh salt
# asset), so no isolate anywhere has loaded it; its first request is timed.
# Warm: 20 sequential requests to an id that has already served.
# Writes results/router-<tag>-<mode>.txt (ids are content hashes, URLs are not kept).
set -u
here=$(cd "$(dirname "$0")" && pwd)
tag=${1:?tag}
mode=${2:-cand}
out="$here/../results/router-$tag-$mode.txt"
: >"$out"
log() { echo "$*" | tee -a "$out"; }

build() { node "$here/build-candidate.ts" "$1" "${2:-}"; }
id_of() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).id)'; }

# Runs a command; prints its combined output on one line plus its exit code.
with_exit() { local o rc; o=$("$@" 2>&1); rc=$?; echo "$(echo "$o" | tr '\n' ' ') exit=$rc"; }

log "# router bench $tag mode=$mode $(date -u +%FT%TZ)"
log "colo: $(curl -s -D - -o /dev/null "$ROUTER_URL/" | tr -d '\r' | awk -F'-' 'tolower($0) ~ /^cf-ray/ {print $NF}')"

base_json=$(build "$BASE_DIR"); log "build base: $base_json"
a_json=$(build "$A_DIR"); log "build A:    $a_json"
base=$(echo "$base_json" | id_of)
a=$(echo "$a_json" | id_of)

log "## network floor: GET / on the router (no candidate work) x20"
log "$("$here/ttfb.sh" "$ROUTER_URL/" 20 | node "$here/stats.ts" floor)"

log "## cold API (GET /users/ghost on a never-served id)"
cold_api=""
for i in 1 2 3 4 5; do
  j=$(build "$BASE_DIR" "cold-api-$tag-$i"); id=$(echo "$j" | id_of)
  line=$("$here/ttfb.sh" "$ROUTER_URL/$mode/$id/users/ghost" 1)
  log "  $id build=$(echo "$j" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(j.roundTripMs+"ms")') ttfb-line: $line"
  cold_api+="$line"$'\n'
done
log "$(printf '%s' "$cold_api" | node "$here/stats.ts" cold-api --max-ms 1000)"

log "## cold asset (GET /app.js on a never-served id)"
cold_asset=""
for i in 1 2 3 4 5; do
  j=$(build "$BASE_DIR" "cold-asset-$tag-$i"); id=$(echo "$j" | id_of)
  line=$("$here/ttfb.sh" "$ROUTER_URL/$mode/$id/app.js" 1)
  log "  $id ttfb-line: $line"
  cold_asset+="$line"$'\n'
done
log "$(printf '%s' "$cold_asset" | node "$here/stats.ts" cold-asset --max-ms 1000)"

log "## warm API x20 (base $base)"
"$here/ttfb.sh" "$ROUTER_URL/$mode/$base/users/ghost" 1 >/dev/null
log "$("$here/ttfb.sh" "$ROUTER_URL/$mode/$base/users/ghost" 20 | node "$here/stats.ts" warm-api --max-ms 1000)"
log "## warm asset x20 (base $base)"
"$here/ttfb.sh" "$ROUTER_URL/$mode/$base/app.js" 1 >/dev/null
log "$("$here/ttfb.sh" "$ROUTER_URL/$mode/$base/app.js" 20 | node "$here/stats.ts" warm-asset --max-ms 1000)"
log "## warm index.html x20 (base $base)"
log "$("$here/ttfb.sh" "$ROUTER_URL/$mode/$base/" 20 | node "$here/stats.ts" warm-index --max-ms 1000)"

log "## worlds: base and A behave differently"
log "base $base: $(with_exit node "$here/probe-world.ts" "$ROUTER_URL/$mode/$base" --flow --expect base)"
log "A    $a: $(with_exit node "$here/probe-world.ts" "$ROUTER_URL/$mode/$a" --flow --expect A)"

log "## can fail"
log "wrong expectation (base probed as A): $(with_exit node "$here/probe-world.ts" "$ROUTER_URL/$mode/$base" --expect A)"
missing=0000000000deadbeef00
log "unknown id $missing: $(curl -s -w ' http=%{http_code} ct=%{content_type}' "$ROUTER_URL/$mode/$missing/users/ghost" | tr -d '\n')"
log "unknown id, asset path: $(curl -s -w ' http=%{http_code}' "$ROUTER_URL/$mode/$missing/app.js" | tr -d '\n')"
log "malformed id: $(curl -s -w ' http=%{http_code}' "$ROUTER_URL/$mode/not-a-hash/users/ghost" | tr -d '\n')"
log "a 1-char change of a real id ($base -> ${base%?}0): $(curl -s -w ' http=%{http_code}' "$ROUTER_URL/$mode/${base%?}0/users/ghost" | tr -d '\n')"
log "admin without token: $(curl -s -w ' http=%{http_code}' -X POST "$ROUTER_URL/admin/build" | tr -d '\n')"
log "ttfb gate can fail (warm API with --max-ms 1): $(with_exit sh -c "'$here/ttfb.sh' '$ROUTER_URL/$mode/$base/users/ghost' 3 | node '$here/stats.ts' gate-check --max-ms 1")"
echo "BASE_ID=$base A_ID=$a" >"$here/../build/ids.env"
