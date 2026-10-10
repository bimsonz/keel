#!/usr/bin/env bash
# The consume side, run once the K2 Consume token exists.
#   K2_CONSUME_TOKEN=... SPIKE_HOST=... SPIKE_KEY=... scripts/consume-suite.sh [--baseline-first]
# The token goes to the Worker as a secret through stdin; it is never printed or
# written to a file. --baseline-first is for a backlog whose oldest records may
# already have passed retention (the first seq seen per entity is then accepted).
set -euo pipefail
: "${K2_CONSUME_TOKEN:?}" "${SPIKE_HOST:?}" "${SPIKE_KEY:?}"
cd "$(dirname "$0")/.."
BASE="${1:-}"
log() { echo "== $(date -u +%T) $*" >&2; }

log "secret put K2_CONSUME_TOKEN (stdin)"
printf '%s' "$K2_CONSUME_TOKEN" | pnpm exec wrangler secret put K2_CONSUME_TOKEN -c wrangler.deploy.jsonc 2>&1 | grep -E 'Success|ERROR' >&2
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://${SPIKE_HOST}/k2/subscriptions" -H "x-spike-key: ${SPIKE_KEY}")
  [ "$code" = 200 ] && break
  sleep 2
done
log "GET /subscriptions through the Worker -> ${code}"

log "nack probe"
node scripts/lease.ts --phase nack 2> results/lease-nack.log
log "lease-expiry probe (background, ~6 min)"
node scripts/lease.ts --phase expiry 2> results/lease-expiry.log &
EXPIRY=$!

log "drain: earliest, max_records 1000, 1 batch per alarm"
node scripts/consume.ts --name drain --start earliest --max 1000 $BASE 2> results/consume-drain.log > /dev/null
log "drain10k: earliest, max_records 10000, 1 batch per alarm"
node scripts/consume.ts --name drain10k --start earliest --max 10000 $BASE 2> results/consume-drain10k.log > /dev/null
log "chaos: shuffle and dup, 3 batches each"
node scripts/consume.ts --name chaos-shuffle --start earliest --max 1000 --chaos shuffle --max-batches 3 $BASE 2> /dev/null > /dev/null
node scripts/consume.ts --name chaos-dup --start earliest --max 1000 --chaos dup --max-batches 3 $BASE 2> /dev/null > /dev/null

log "waiting for the expiry probe"
wait "$EXPIRY" || log "expiry probe exited non-zero"

log "lag: latest subscription, producer nudges the projector after every send"
node scripts/consume.ts --name lag --start latest --max 1000 --baseline-first --no-nudge --phase setup 2> results/consume-lag.log
node scripts/produce.ts --run lag --mode single --lanes 50 --count 10000 --chunk 2500 --nudge lag > /dev/null 2> results/produce-lag.log
node scripts/consume.ts --name lag --phase wait --timeout 300 2>> results/consume-lag.log > /dev/null
log "done"
