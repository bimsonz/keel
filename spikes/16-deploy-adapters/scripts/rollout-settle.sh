#!/usr/bin/env bash
# (c) second pass: how long until a promote or a rollback has fully settled.
# Reuses the versions from rollout.sh (build/versions.env).
#
#   APP_URL=... scripts/rollout-settle.sh <tag>
#
# The trace is "<ms since the wrangler command returned>:<% target>" per batch
# of 50. Settled = 3 batches in a row at 100%.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root="$here/.."
tag=${1:?tag}
out="$root/results/rollout-$tag.txt"
: >"$out"
# shellcheck disable=SC1091
. "$root/build/versions.env"
W="$root/node_modules/.bin/wrangler"
CFG="$root/wrangler.app.jsonc"
now() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
log() { echo "$*" | "$here/redact.sh" | tee -a "$out"; }
with_exit() { local o rc; o=$("$@" 2>&1); rc=$?; echo "$o exit=$rc"; }
step() {
  local label=$1; shift
  local t0 t1 rc
  t0=$(now); "$W" "$@" -c "$CFG" -y >/dev/null 2>&1; rc=$?; t1=$(now)
  log "### $label: wrangler $* -> exit=$rc in $((t1 - t0)) ms"
}

log "# rollout settle $tag $(date -u +%FT%TZ) base=$VB A=$VA"
log "start state, 100 samples, expect 0% A: $(with_exit node "$here/split.ts" sample "$APP_URL" 100 0)"

step "deploy A 10% / base 90%" versions deploy "$VA@10%" "$VB@90%" --message "A at 10% (settle run)"
log "ramp, 8 batches of 50 (trace = ms:%A): $(node "$here/split.ts" settle "$APP_URL" A 50 99 25 2>&1 | sed -E 's/.*"trace":"([^"]*)".*/\1/')"
log "split after ramp, 400 samples, expect 10% A: $(with_exit node "$here/split.ts" sample "$APP_URL" 400 10)"

step "deploy A 100%" versions deploy "$VA@100%" --message "A at 100% (settle run)"
log "settle to A: $(with_exit node "$here/split.ts" settle "$APP_URL" A 50 3 180)"

step "rollback to base" rollback "$VB" -m "rollback to base (settle run)"
log "settle to base: $(with_exit node "$here/split.ts" settle "$APP_URL" base 50 3 180)"
log "after settle, 300 samples, expect 0% A: $(with_exit node "$here/split.ts" sample "$APP_URL" 300 0)"
