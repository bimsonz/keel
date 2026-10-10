#!/usr/bin/env bash
# Time to first byte with curl, one fresh connection per request.
#
#   scripts/ttfb.sh <url> <n> [method]
#
# One line per request: http_code connect appconnect starttransfer total, in
# seconds. starttransfer is the TTFB criterion; it includes DNS, TCP and TLS.
# starttransfer - appconnect is the server's share plus one round trip.
set -u
url=$1 n=$2 method=${3:-GET}
for _ in $(seq "$n"); do
  curl -s -o /dev/null -X "$method" -H 'cache-control: no-cache' \
    -w '%{http_code} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}\n' "$url"
done
