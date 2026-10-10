#!/usr/bin/env bash
# (d) Teardown: previews, candidates (R2 objects), Workers (and with them their
# versions, secrets and Durable Object namespace), the bucket. Then proof that
# nothing is left: listings, 10007s, and a 404 for every URL used in the spike.
#
#   ROUTER_URL=... ADMIN_TOKEN_FILE=... SUBDOMAIN=... scripts/teardown.sh <tag>
#
# REST calls (previews list/delete, DO namespace list) use the wrangler OAuth
# token, read per call from wrangler's config and never printed.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root="$here/.."
tag=${1:?tag}
out="$root/results/teardown-$tag.txt"
: >"$out"
W="$root/node_modules/.bin/wrangler"
APP=keel-spike-16-app
ROUTER=keel-spike-16-router
BUCKET=keel-spike-16-bundles
log() { echo "$*" | "$here/redact.sh" | tee -a "$out"; }
now() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
oauth() { "$W" whoami >/dev/null 2>&1; sed -nE 's/^oauth_token = "(.*)"$/\1/p' "$HOME/Library/Preferences/.wrangler/config/default.toml"; }
rest() { CLOUDFLARE_API_TOKEN=$(oauth) node "$here/rest-preview.ts" "$@" 2>&1 | grep -vE '^\s+at |^Node.js|^\s*$|throw new' | tail -2 | tr '\n' ' '; }
admin() { curl -s -X "$1" -H "authorization: Bearer $(cat "$ADMIN_TOKEN_FILE")" "$ROUTER_URL$2"; }
wr() { local t0 rc o; t0=$(now); o=$("$W" "$@" 2>&1); rc=$?; log "\$ wrangler $* -> exit=$rc in $(( $(now) - t0 )) ms"; log "$(echo "$o" | grep -vE '^\s*$|wrangler 4\.|^─' | tail -${TAIL:-4} | sed 's/^/    /')"; }

# Every workers.dev hostname the spike used, recovered from the (redacted) results.
urls=$({ { grep -ohE 'https://[a-z0-9-]+\.<subdomain>\.workers\.dev' "$root"/results/*.txt; echo "https://$APP.<subdomain>.workers.dev"; echo "https://$ROUTER.<subdomain>.workers.dev"; } | sed "s/<subdomain>/$SUBDOMAIN/"
  # plus the raw `wrangler preview --json` outputs (gitignored), which hold the p1 URLs
  cat "$root"/build/preview-*.json 2>/dev/null | grep -ohE "https://[a-z0-9-]+\.$SUBDOMAIN\.workers\.dev"; } | sort -u)

log "# teardown $tag $(date -u +%FT%TZ)"
log "## inventory before"
log "previews: $(rest list $APP)"
log "router bundles: $(admin GET /admin/all | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.objects+" objects, "+j.candidates+" candidates")')"
log "urls used: $(echo "$urls" | wc -l | tr -d ' ')"

log "## previews"
for name in p1-a p1-base p2-a p2-base; do wr preview delete --name "$name" --worker-name "$APP" -y; done
for name in rest-a rest-base; do log "REST delete $name: $(rest delete $name $APP)"; done
log "previews after: $(rest list $APP)"

log "## candidates (R2 objects)"
log "DELETE /admin/all: $(admin DELETE /admin/all | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.objects+" objects, "+j.candidates+" candidates deleted")')"
log "GET /admin/all after: $(admin GET /admin/all | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.objects+" objects")')"

log "## Workers"
log "versions of $APP before delete: $("$W" versions list --name $APP 2>&1 | grep -cE '^Version ID') listed"
log "secrets of $ROUTER before delete: $("$W" secret list --name $ROUTER 2>&1 | grep -oE '"name": "[A-Z_]+"' | tr '\n' ' ')"
wr delete --name "$APP" --force
wr delete --name "$ROUTER" --force

log "## bucket"
wr r2 bucket delete "$BUCKET"

log "## proof: nothing left"
for w in $APP $ROUTER; do
  TAIL=2 wr deployments list --name "$w"
  TAIL=2 wr versions list --name "$w"
  TAIL=2 wr secret list --name "$w"
done
log "previews list on the deleted Worker: $(rest list $APP)"
log "r2 buckets named keel-spike-16-*: $("$W" r2 bucket list 2>&1 | grep -c 'keel-spike-16') (0 = none)"
log "r2 bucket info: $("$W" r2 bucket info $BUCKET 2>&1 | grep -iE 'not exist|error|10006' | head -1)"
ns=$(curl -s -H "authorization: Bearer $(oauth)" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/durable_objects/namespaces?per_page=1000" |
  node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const m=(j.result||[]).filter(n=>/keel-spike-16/.test(n.script||"")||/keel-spike-16/.test(n.name||""));console.log(j.success?m.length+" Durable Object namespaces for keel-spike-16-* (0 = none)":"DO namespace list failed: "+JSON.stringify(j.errors))')
log "$ns"
log "## every URL used, until it answers 404 (max 60 s each)"
for u in $urls; do
  t0=$(now); code=""
  while [ $(( $(now) - t0 )) -lt 60000 ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$u/")
    [ "$code" = 404 ] && break
    sleep 2
  done
  log "$u -> $code after $(( $(now) - t0 )) ms"
done
