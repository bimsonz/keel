#!/usr/bin/env bash
# The error lines that prove the spike's Workers and bucket are gone (10007 /
# 10006). Appends to results/teardown-<tag>.txt.
#
#   CLOUDFLARE_ACCOUNT_ID=... SUBDOMAIN=... scripts/teardown-proof.sh <tag>
set -u
here=$(cd "$(dirname "$0")" && pwd)
root="$here/.."
out="$root/results/teardown-${1:?tag}.txt"
W="$root/node_modules/.bin/wrangler"
{
  echo "## proof, error lines captured ($(date -u +%FT%TZ))"
  for w in keel-spike-16-app keel-spike-16-router; do
    for c in "deployments list" "versions list" "secret list"; do
      echo "\$ wrangler $c --name $w"
      # $c is split on purpose: "deployments list" is two arguments.
      # shellcheck disable=SC2086
      "$W" $c --name "$w" 2>&1 | grep -E "ERROR|10007|does not exist" | head -2 | sed "s/^/    /"
    done
  done
  echo "\$ wrangler r2 bucket info keel-spike-16-bundles"
  "$W" r2 bucket info keel-spike-16-bundles 2>&1 | grep -E "ERROR|10006|not exist" | head -2 | sed "s/^/    /"
  echo "\$ wrangler r2 bucket list | grep -c keel-spike-16"
  echo "    $("$W" r2 bucket list 2>&1 | grep -c keel-spike-16)"
} | "$here/redact.sh" | tee -a "$out"
