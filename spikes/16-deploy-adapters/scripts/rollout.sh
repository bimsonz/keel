#!/usr/bin/env bash
# (c) Versions and gradual rollout, from local wrangler.
#
#   BASE_DIR=<base copy> A_DIR=<A copy> APP_URL=https://keel-spike-16-app.<subdomain>.workers.dev \
#     scripts/rollout.sh <tag>
#
# deploy base -> upload A -> A 10% / base 90% (sample 200) -> override header
# -> A 100% -> rollback to base. Each wrangler step is timed, and so is the
# propagation after it (time until N consecutive responses show the target
# world). Output, redacted, goes to results/rollout-<tag>.txt.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root="$here/.."
tag=${1:?tag}
out="$root/results/rollout-$tag.txt"
: >"$out"
W="$root/node_modules/.bin/wrangler"
CFG="$root/wrangler.app.jsonc"
now() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
log() { echo "$*" | "$here/redact.sh" | tee -a "$out"; }
with_exit() { local o rc; o=$("$@" 2>&1); rc=$?; echo "$o exit=$rc"; }
# Runs wrangler, logs its last lines and the wall time; leaves output in $wout.
wr() {
  local label=$1; shift
  local t0 t1
  t0=$(now); wout=$("$W" "$@" 2>&1); local rc=$?; t1=$(now)
  log "### $label: wrangler $* -> exit=$rc in $((t1 - t0)) ms"
  log "$(echo "$wout" | grep -vE '^\s*$|wrangler 4|^─' | tail -8 | sed 's/^/    /')"
}
split() { node "$here/split.ts" "$@" 2>&1; }

log "# rollout $tag $(date -u +%FT%TZ)"

wr "deploy base (100%)" deploy "$BASE_DIR/src/index.ts" -c "$CFG" --message "base"
VB=$(echo "$wout" | sed -nE 's/.*Current Version ID: ([0-9a-f-]+).*/\1/p')
log "base version: $VB"
log "propagation to base: $(split wait "$APP_URL" base 10 120)"

wr "upload A as a version (0% traffic)" versions upload "$A_DIR/src/index.ts" -c "$CFG" --message "candidate A" --tag cand-a
VA=$(echo "$wout" | sed -nE 's/.*Worker Version ID: ([0-9a-f-]+).*/\1/p')
log "A version: $VA"
log "still base after upload (20 samples, expect 0% A): $(with_exit split sample "$APP_URL" 20 0)"

wr "deploy A 10% / base 90%" versions deploy "$VA@10%" "$VB@90%" -c "$CFG" -y --message "A at 10%"
log "time to first A response: $(split wait "$APP_URL" A 1 120)"
log "split, 200 samples, expect 10% A: $(with_exit split sample "$APP_URL" 200 10)"
log "CAN FAIL: a fresh 200 samples checked against a wrong expectation of 50% A: $(with_exit split sample "$APP_URL" 200 50)"
log "CAN FAIL: and against 0% A: $(with_exit split sample "$APP_URL" 200 0)"
log "override header -> A (20 samples, expect 100% A): $(with_exit split sample "$APP_URL" 20 100 --override "keel-spike-16-app=\"$VA\"")"
log "override header -> base (20 samples, expect 0% A): $(with_exit split sample "$APP_URL" 20 0 --override "keel-spike-16-app=\"$VB\"")"
log "override header naming a version not in the deployment (expect it to be ignored, ~10% A): $(with_exit split sample "$APP_URL" 40 10 --override "keel-spike-16-app=\"00000000-0000-0000-0000-000000000000\"")"

wr "deploy A 100%" versions deploy "$VA@100%" -c "$CFG" -y --message "A at 100%"
log "propagation to A: $(split wait "$APP_URL" A 20 120)"
log "after promote, 100 samples, expect 100% A: $(with_exit split sample "$APP_URL" 100 100)"

wr "rollback to base" rollback "$VB" -c "$CFG" -y -m "rollback to base"
log "propagation to base: $(split wait "$APP_URL" base 20 120)"
log "after rollback, 100 samples, expect 0% A: $(with_exit split sample "$APP_URL" 100 0)"
log "after rollback, revoke flow: $(node "$here/probe-world.ts" "$APP_URL" --flow --expect base 2>&1 | tr '\n' ' ')"

wr "deployments list" deployments list -c "$CFG"
log "$(echo "$wout" | grep -vE '^\s*$' | tail -40 | sed 's/^/    /')"
echo "VB=$VB VA=$VA" >"$root/build/versions.env"
