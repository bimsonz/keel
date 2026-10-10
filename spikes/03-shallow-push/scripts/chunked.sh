#!/usr/bin/env bash
# Push an existing big repo one commit at a time (main~2, main~1, main) so each
# receive-pack request carries only that commit's new objects.
#
#   REMOTE=... TOKEN=... scripts/chunked.sh <repo-dir>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
cd "${1:?repo-dir}"
for rev in main~2 main~1 main; do
  c=$(git rev-parse "$rev")
  newmb=$(git rev-list --objects "$c" --not $(remote_ref refs/heads/main) 2>/dev/null | git pack-objects --stdout -q 2>/dev/null | wc -c | awk '{printf "%.1f", $1/1048576}')
  t0=$(now_ms)
  out=$(agit push "$REMOTE" "$c:refs/heads/main" 2>&1); rc=$?
  echo "$rev new-objects=${newmb}MiB exit=$rc ms=$(( $(now_ms) - t0 )) $(echo "$out" | redact | grep -E '\.\.|new branch|rejected' | tr -s ' ' | head -2 | tr '\n' ' ')"
done
echo "remote main: $(remote_ref refs/heads/main | cut -c1-12) local: $(git rev-parse main | cut -c1-12)"
