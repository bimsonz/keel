#!/usr/bin/env bash
# (b) Workers Previews from local wrangler (`wrangler preview`, open beta).
#
#   BASE_DIR=... A_DIR=... scripts/previews.sh <tag>
#
# Creates one Preview per world on keel-spike-16-app, times creation, then
# measures first byte (first request ever to the Preview URL) and 20 warm
# requests, and checks each Preview serves its own world.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root="$here/.."
tag=${1:?tag}
out="$root/results/previews-$tag.txt"
: >"$out"
W="$root/node_modules/.bin/wrangler"
CFG="$root/wrangler.app.jsonc"
now() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
log() { echo "$*" | "$here/redact.sh" | tee -a "$out"; }
with_exit() { local o rc; o=$("$@" 2>&1); rc=$?; echo "$o exit=$rc"; }

log "# previews $tag $(date -u +%FT%TZ)"
for pair in "a:$A_DIR:A" "base:$BASE_DIR:base"; do
  name="$tag-${pair%%:*}"; rest=${pair#*:}; dir=${rest%%:*}; world=${rest##*:}
  t0=$(now)
  json=$("$W" preview "$dir/src/index.ts" -c "$CFG" --name "$name" --message "keel spike 16 $world" --json 2>"$root/build/preview-$name.stderr")
  rc=$?; t1=$(now)
  # --json still prints asset-sync progress lines first; the JSON starts at the first "{" line.
  json=$(echo "$json" | sed -n '/^{/,$p')
  echo "$json" >"$root/build/preview-$name.json"
  log "### wrangler preview --name $name ($world): exit=$rc in $((t1 - t0)) ms"
  purl=$(echo "$json" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((j.preview.urls||[])[0]||"")' 2>/dev/null)
  durl=$(echo "$json" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((j.deployment.urls||[])[0]||"")' 2>/dev/null)
  log "preview url: $purl"
  log "deployment url: $durl"
  log "preview resource: $(echo "$json" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=j.preview,d=j.deployment;console.log(JSON.stringify({preview:{id:p.id,name:p.name,slug:p.slug,keys:Object.keys(p)},deployment:{id:d.id,keys:Object.keys(d),annotations:d.annotations}}))' 2>&1)"
  [ -z "$purl" ] && { log "no preview URL; stderr: $(tail -5 "$root/build/preview-$name.stderr" | tr '\n' ' ')"; continue; }
  log "first byte, first request to the preview URL (API): $("$here/ttfb.sh" "$purl/users/ghost" 1)"
  log "first byte, first request (asset /app.js): $("$here/ttfb.sh" "$purl/app.js" 1)"
  log "warm API x20: $("$here/ttfb.sh" "$purl/users/ghost" 20 | node "$here/stats.ts" "preview-$world-warm-api" --max-ms 1000)"
  log "warm asset x20: $("$here/ttfb.sh" "$purl/app.js" 20 | node "$here/stats.ts" "preview-$world-warm-asset" --max-ms 1000)"
  log "world via preview url: $(with_exit node "$here/probe-world.ts" "$purl" --expect "$world")"
  log "world via deployment url: $(with_exit node "$here/probe-world.ts" "$durl" --expect "$world")"
  log "x-robots-tag on workers.dev preview: $(curl -s -D - -o /dev/null "$purl/" | tr -d '\r' | grep -i '^x-robots-tag' || echo none)"
done
log "production still serves base (preview did not touch it): $(with_exit node "$here/probe-world.ts" "$APP_URL" --expect base)"
