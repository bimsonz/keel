#!/usr/bin/env bash
# Can-fail check: sequential pushes where the second is based on a stale base
# must be rejected. The assertion is run three ways; the last two are controls
# in which the second push legitimately wins, so the assertion must go red.
#
#   REMOTE=... TOKEN=... scripts/stale.sh <workdir>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
work="${1:?workdir}"
: "${REMOTE:?}" "${TOKEN:?}"
raw() { node --no-warnings "$here/rawpush.ts" "$@"; }

# assert_stale_rejected <label> <second-push exit> <first commit> <second commit>
assert_stale_rejected() {
  local head; head=$(remote_ref refs/heads/main)
  if [ "$2" != 0 ] && [ "$head" = "$3" ]; then
    echo "ASSERT OK   [$1] stale second push rejected; head=${head:0:12} is the first push"
  else
    echo "ASSERT FAIL [$1] second push WON (exit=$2); head=${head:0:12}, first=${3:0:12} lost, second=${4:0:12}"
  fi
}

setup() { # two clones at the same base, each with its own commit
  rm -rf "$work" && mkdir -p "$work" && cd "$work"
  git init -q -b main A && git init -q -b main B
  (cd A && agit fetch -q "$REMOTE" main && git reset -q --hard FETCH_HEAD)
  base=$(git -C A rev-parse HEAD)
  (cd B && git fetch -q ../A "$base" && git reset -q --hard "$base")
  (cd A && git commit -q --allow-empty -m "first $1") && cA=$(git -C A rev-parse HEAD)
  (cd B && git commit -q --allow-empty -m "second $1 (stale base)") && cB=$(git -C B rev-parse HEAD)
  (cd A && agit push -q "$REMOTE" HEAD:refs/heads/main) || { echo "first push failed"; exit 1; }
}

echo "## 1. git push, second push stale (expected: rejected)"
setup git
out=$(cd B && agit push "$REMOTE" HEAD:refs/heads/main 2>&1); rc=$?
echo "$out" | redact | grep -E '^ ! '
assert_stale_rejected "git push" "$rc" "$cA" "$cB"

echo; echo "## 2. raw receive-pack, second update carries the stale old-oid (expected: rejected by the server)"
setup raw
out=$(cd B && raw single . "$base:$cB:refs/heads/main"); echo "$out"
echo "$out" | grep -q '"ok refs/heads/main"'; rc=$([ $? = 0 ] && echo 0 || echo 1)
assert_stale_rejected "raw stale old-oid" "$rc" "$cA" "$cB"

echo; echo "## 3. CONTROL: second push uses --force (it re-reads the head and overwrites)"
setup force
out=$(cd B && agit push --force "$REMOTE" HEAD:refs/heads/main 2>&1); rc=$?
echo "$out" | redact | grep -E 'forced|^ ! '
assert_stale_rejected "git push --force" "$rc" "$cA" "$cB"

echo; echo "## 4. CONTROL: raw update whose old-oid is the new head (a re-read), non-fast-forward"
setup rawreread
out=$(cd B && raw single . "$cA:$cB:refs/heads/main"); echo "$out"
echo "$out" | grep -q '"ok refs/heads/main"'; rc=$([ $? = 0 ] && echo 0 || echo 1)
assert_stale_rejected "raw re-read old-oid" "$rc" "$cA" "$cB"
