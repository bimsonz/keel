#!/usr/bin/env bash
# Run N sequential requests against the deployed Worker and append one
# sanitised JSON line per request to results/<label>.jsonl.
#   scripts/run.sh <label> <count> '<path?query>'   (run=<label>&i=<n> is appended)
set -euo pipefail
label="$1"; count="$2"; path="$3"
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/results/$label.jsonl"
: > "$out"
sep='?'; [[ "$path" == *\?* ]] && sep='&'
for i in $(seq 1 "$count"); do
  res=$("$here/scripts/call.sh" "${path}${sep}run=${label}&i=${i}")
  meta=$(printf '%s' "$res" | head -n1)
  body=$(printf '%s' "$res" | tail -n +2 | tr -d '\n')
  printf '{"label":"%s","i":%s,"http":%s,"clientS":%s,"body":%s}\n' \
    "$label" "$i" "${meta% *}" "${meta#* }" "$body" >> "$out"
  printf '%s #%s http=%s client=%ss\n' "$label" "$i" "${meta% *}" "${meta#* }"
done
