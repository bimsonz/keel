#!/usr/bin/env bash
# Seed a repo with 50 commits (~3 MB): each commit adds a 60 KB random binary
# file and appends to a text log, so history matters for a full clone.
#
#   REMOTE=... TOKEN=... scripts/seed.sh <workdir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
work="${1:?workdir}"
: "${REMOTE:?}" "${TOKEN:?}"
rm -rf "$work" && git init -q -b main "$work" && cd "$work"
mkdir -p bin docs
for i in $(seq -w 1 50); do
  head -c 61440 /dev/urandom >"bin/blob-$i.bin"
  printf 'commit %s: %s\n' "$i" "$(head -c 24 /dev/urandom | base64)" >>docs/log.txt
  git add -A && git commit -q -m "seed $i"
done
echo "commits=$(git rev-list --count HEAD) head=$(git rev-parse HEAD) size=$(du -sk .git | cut -f1)KB"
t0=$(now_ms)
agit push "$REMOTE" main 2>&1 | redact | grep -vE '^remote: (Processing|Counting|Compressing)'
echo "push exit=${PIPESTATUS[0]} ms=$(( $(now_ms) - t0 ))"
