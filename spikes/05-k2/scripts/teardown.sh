#!/usr/bin/env bash
# Tear down everything S5 created, printing a listing after each step.
#   STREAM_ID=... SPIKE_HOST=... SPIKE_KEY=... scripts/teardown.sh
# Order: subscriptions (they need the consume token, which lives in the Worker), the
# Worker's secrets, the queue consumer (a consumer Worker cannot be deleted: 10064),
# the Worker with its DO namespaces, the fallback queue (a queue still bound by a
# Worker cannot be deleted: 11005), then the stream (its records and subscriptions go with it).
set -uo pipefail
: "${STREAM_ID:?}" "${SPIKE_HOST:?}" "${SPIKE_KEY:?}"
cd "$(dirname "$0")/.."
red() { sed -E 's/[0-9a-f]{16,}/<id>/g; s#[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev#keel-spike-05-log.<subdomain>.workers.dev#g'; }
w() { pnpm exec wrangler "$@" 2>&1 | grep -v 'WARN.*npmrc' | red; }
k2() { curl -s -X "$1" "https://${SPIKE_HOST}/k2$2" -H "x-spike-key: ${SPIKE_KEY}"; }

echo '$ GET /token (is a consume token set on the Worker?)'
tok=$(curl -s "https://${SPIKE_HOST}/token" -H "x-spike-key: ${SPIKE_KEY}")
echo "$tok"
if echo "$tok" | grep -q '"consumeTokenSet": true'; then
  echo '$ GET /subscriptions (before)'
  subs=$(k2 GET /subscriptions)
  echo "$subs" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps([s["name"] for s in (d.get("result") or [])]))'
  for id in $(echo "$subs" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(s["id"] for s in (d.get("result") or [])))'); do
    echo "\$ DELETE /subscriptions/<id> -> $(k2 DELETE "/subscriptions/${id}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("success"))')"
  done
  echo '$ GET /subscriptions (after)'
  k2 GET /subscriptions | red
  echo
else
  echo 'No consume token was ever set, so no subscription could have been created (subscriptions are a consume-plane call).'
fi

echo '$ wrangler secret list (before)'
w secret list -c wrangler.deploy.jsonc
for s in $(pnpm exec wrangler secret list -c wrangler.deploy.jsonc 2>/dev/null | python3 -c 'import json,sys; print(" ".join(x["name"] for x in json.load(sys.stdin)))'); do
  echo "\$ wrangler secret delete ${s}"
  echo y | w secret delete "$s" -c wrangler.deploy.jsonc
done
echo '$ wrangler secret list (after)'
w secret list -c wrangler.deploy.jsonc

echo '$ wrangler queues consumer remove keel-spike-05-fallback keel-spike-05-log'
w queues consumer remove keel-spike-05-fallback keel-spike-05-log
echo '$ wrangler delete keel-spike-05-log --force'
echo y | w delete -c wrangler.deploy.jsonc --force
echo '$ wrangler deployments list --name keel-spike-05-log (after)'
w deployments list --name keel-spike-05-log | tail -4

echo '$ wrangler queues delete keel-spike-05-fallback'
echo y | w queues delete keel-spike-05-fallback
echo '$ wrangler queues list | grep -c keel-spike-05 (after)'
pnpm exec wrangler queues list 2>/dev/null | grep -c keel-spike-05

echo '$ wrangler k2 streams delete <stream-id> --force'
w k2 streams delete "${STREAM_ID}" --force
echo '$ wrangler k2 streams list --json (after)'
w k2 streams list --json
echo '$ wrangler k2 streams list --name keel_spike_05 --json (after)'
w k2 streams list --name keel_spike_05 --json
