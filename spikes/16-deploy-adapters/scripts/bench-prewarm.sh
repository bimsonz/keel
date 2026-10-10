#!/usr/bin/env bash
# Pinned path with the warm-up folded into preview(): build, then one warm-up
# request (creates the Durable Object and loads the isolate), then the first
# probe request. "ready" = build round trip + warm-up; "probe" = what a probe
# sees as its first byte.
#
#   ROUTER_URL=... ADMIN_TOKEN_FILE=... BASE_DIR=... scripts/bench-prewarm.sh <tag>
set -u
here=$(cd "$(dirname "$0")" && pwd)
tag=${1:?tag}
out="$here/../results/router-$tag-prewarm.txt"
: >"$out"
probe=""
for i in 1 2 3 4 5; do
  t0=$(node -e 'process.stdout.write(String(Date.now()))')
  j=$(node "$here/build-candidate.ts" "$BASE_DIR" "prewarm-$tag-$i")
  id=$(echo "$j" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).id)')
  warm=$("$here/ttfb.sh" "$ROUTER_URL/pinned/$id/users/ghost" 1)
  t1=$(node -e 'process.stdout.write(String(Date.now()))')
  line=$("$here/ttfb.sh" "$ROUTER_URL/pinned/$id/users/ghost" 1)
  echo "$id ready=$((t1 - t0))ms warmup-line: $warm first-probe-line: $line" | tee -a "$out"
  probe+="$line"$'\n'
done
printf '%s' "$probe" | node "$here/stats.ts" pinned-first-probe-after-prewarm --max-ms 1000 | tee -a "$out"
