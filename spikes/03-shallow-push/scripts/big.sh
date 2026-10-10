#!/usr/bin/env bash
# Generate a repo of about <size_mb> MB of mostly incompressible content and
# full-push it. 97% random binary files (1 MiB each), 3% text, over 3 commits.
#
#   REMOTE=... TOKEN=... scripts/big.sh <size_mb> <workdir> [gen-only|push-only]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
size="${1:?size_mb}" work="${2:?workdir}" phase="${3:-all}"

if [ "$phase" != push-only ]; then
  rm -rf "$work" && git init -q -b main "$work" && cd "$work"
  bins=$(( size * 97 / 100 )) per=$(( (size * 97 / 100 + 2) / 3 ))
  n=0
  for c in 1 2 3; do
    mkdir -p "data/c$c" text
    for _ in $(seq 1 "$per"); do
      [ "$n" -ge "$bins" ] && break
      head -c 1048576 /dev/urandom >"data/c$c/blob-$n.bin"; n=$((n + 1))
    done
    # ~1% of the size as text per commit, compressible
    for t in $(seq 1 $(( size / 100 + 1 ))); do
      yes "line $c $t of text content for the big push spike" | head -c 1048576 >"text/c$c-$t.txt"
    done
    git add -A && git -c core.bigFileThreshold=1m commit -q -m "big $size MB part $c"
  done
  git repack -adq -F --window=0 >/dev/null 2>&1 || true   # one pack, no delta search (random data does not delta)
  echo "generated: files=$(( $(du -sm . | cut -f1) - $(du -sm .git | cut -f1) ))MB .git=$(du -sm .git | cut -f1)MB objects=$(git count-objects -v | awk '/^(count|in-pack)/{s+=$2} END{print s}') head=$(git rev-parse HEAD)"
fi
[ "$phase" = gen-only ] && exit 0
: "${REMOTE:?}" "${TOKEN:?}"
cd "$work"
packmb=$(git count-objects -vH | awk '/size-pack/{print $2, $3}')
echo "pack on disk: $packmb"
t0=$(now_ms)
out=$(agit push --progress "$REMOTE" main 2>&1); rc=$?
t1=$(now_ms)
echo "$out" | tr '\r' '\n' | redact | grep -vE '(Counting|Compressing|Enumerating|Delta compression|Processing) objects: +[0-9]+% \([0-9]+/[0-9]+\)[^d]*$' | grep -vE 'Writing objects: +[0-9]+% \([0-9/]+\)[^d]*$' | awk '!/Writing objects/ || /done/' | tail -15
echo "push exit=$rc ms=$((t1 - t0))"
echo "remote main: $(remote_ref refs/heads/main | cut -c1-12) local: $(git rev-parse HEAD | cut -c1-12)"
