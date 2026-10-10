#!/usr/bin/env bash
# Deterministic server-side CAS checks with hand-built receive-pack commands,
# then the git-CLI lease and --atomic checks.
#
#   REMOTE=... TOKEN=... scripts/cas-single.sh <workdir>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
work="${1:?workdir}"
: "${REMOTE:?}" "${TOKEN:?}"
raw() { node --no-warnings "$here/rawpush.ts" "$@"; }

rm -rf "$work" && git init -q -b main "$work" && cd "$work"
agit fetch -q "$REMOTE" main && git reset -q --hard FETCH_HEAD
head=$(git rev-parse HEAD) prev=$(git rev-parse HEAD~1)
bogus=$(printf 'keel-spike-bogus' | git hash-object --stdin)   # a valid-looking oid the server has never seen
next() { git commit-tree "$(git rev-parse "$1^{tree}")" -p "$1" -m "$2"; }
echo "head=${head:0:12} prev(head~1)=${prev:0:12} bogus=${bogus:0:12}"

# Each step re-reads the head so a step that wrongly succeeds cannot poison the next.
cur() { raw head; }

echo; echo "## R1 wrong old-oid (never existed), new is a fast-forward of head"
h=$(cur); n=$(next "$h" R1); raw single . "$bogus:$n:refs/heads/main"
echo; echo "## R2 old-oid zero (create) on an existing ref"
h=$(cur); n=$(next "$h" R2); raw single . "zero:$n:refs/heads/main"
echo; echo "## R3 stale but real old-oid (head~1), new is a fast-forward of head"
h=$(cur); p=$(git rev-parse "$h~1" 2>/dev/null || echo "$prev"); n=$(next "$h" R3); raw single . "$p:$n:refs/heads/main"
echo; echo "## R4 wrong old-oid, new is NOT a fast-forward (what a forced update would send)"
h=$(cur); n=$(next "$(git rev-parse "$h~1")" R4); raw single . "$bogus:$n:refs/heads/main"
echo; echo "## R5 CONTROL: correct old-oid, fast-forward -> must be ok"
h=$(cur); n=$(next "$h" R5); raw single . "$h:$n:refs/heads/main"
echo; echo "## R6 correct old-oid, non-fast-forward (server-side non-ff policy?)"
h=$(cur); n=$(next "$(git rev-parse "$h~1")" R6); raw single . "$h:$n:refs/heads/main"

echo; echo "## R7 single command: create refs/heads/side with old-oid zero (control: must be ok)"
h=$(cur); s1=$(next "$h" side7); raw single . "zero:$s1:refs/heads/side"
echo; echo "## R8 two commands WITHOUT atomic: valid fast-forward of side + stale main"
h=$(cur); s2=$(next "$s1" side8); n=$(next "$h" R8); raw single . "$s1:$s2:refs/heads/side" "$bogus:$n:refs/heads/main"
echo; echo "## R9 two commands WITHOUT atomic, stale one first: stale main + valid fast-forward of side"
h=$(cur); n=$(next "$h" R9); raw single . "$bogus:$n:refs/heads/main" "$s1:$s2:refs/heads/side"
echo; echo "## R10 two commands WITH atomic: valid fast-forward of side + stale main"
h=$(cur); n=$(next "$h" R10); raw single . --atomic "$s1:$s2:refs/heads/side" "$bogus:$n:refs/heads/main"
echo; echo "## R11 two valid commands WITHOUT atomic (control: both must be ok)"
h=$(cur); n=$(next "$h" R11); raw single . "$s1:$s2:refs/heads/side" "$h:$n:refs/heads/main"
echo; echo "## R12 delete with wrong old-oid"
raw single . "$bogus:zero:refs/heads/side"
echo; echo "## R13 delete with correct old-oid (control: must be ok)"
sv=$(raw refs | awk '$2=="refs/heads/side"{print $1}'); raw single . "${sv:-zero}:zero:refs/heads/side"

# --- git CLI: lease and atomic -------------------------------------------------
agit fetch -q "$REMOTE" main && git reset -q --hard FETCH_HEAD
h=$(git rev-parse HEAD)
echo; echo "## L1 --force-with-lease=main:<wrong sha> (non-fast-forward rewrite)"
git commit -q --allow-empty -m L1 && c=$(git rev-parse HEAD)
GIT_TRACE_PACKET="$PWD/../lease1.trace" agit push --force-with-lease="main:$bogus" "$REMOTE" "$c:refs/heads/main" 2>&1 | redact; echo "exit=${PIPESTATUS[0]} head=$(cur | cut -c1-12) commandSent=$(grep -c '> [0-9a-f]\{40\} [0-9a-f]\{40\} refs/heads/main' ../lease1.trace)"
echo; echo "## L2 --force-with-lease=main:<stale real sha head~1>"
GIT_TRACE_PACKET="$PWD/../lease2.trace" agit push --force-with-lease="main:$(git rev-parse "$h~1")" "$REMOTE" "$c:refs/heads/main" 2>&1 | redact; echo "exit=${PIPESTATUS[0]} head=$(cur | cut -c1-12) commandSent=$(grep -c '> [0-9a-f]\{40\} [0-9a-f]\{40\} refs/heads/main' ../lease2.trace)"
echo; echo "## L3 --force-with-lease=main:<correct sha> with a non-fast-forward rewrite"
git reset -q --hard "$h~1" && git commit -q --allow-empty -m "L3 rewrite" && c=$(git rev-parse HEAD)
agit push --force-with-lease="main:$h" "$REMOTE" "$c:refs/heads/main" 2>&1 | redact; echo "exit=${PIPESTATUS[0]} head=$(cur | cut -c1-12) expected=${c:0:12}"

echo; echo "## A1 git push --atomic: main stale (non-ff, no force) + new branch atomic-x"
agit fetch -q "$REMOTE" main && h=$(git rev-parse FETCH_HEAD)
git reset -q --hard "$h~1" && git commit -q --allow-empty -m "A1 stale" && c=$(git rev-parse HEAD)
agit push --atomic "$REMOTE" "$c:refs/heads/main" "$h:refs/heads/atomic-x" 2>&1 | redact; echo "exit=${PIPESTATUS[0]}"; raw refs | grep -E 'atomic-x|refs/heads/main$' | cut -c1-12,41- || true
echo; echo "## A2 same without --atomic"
agit push "$REMOTE" "$c:refs/heads/main" "$h:refs/heads/nonatomic-x" 2>&1 | redact; echo "exit=${PIPESTATUS[0]}"; raw refs | grep -E 'nonatomic-x|refs/heads/main$' | cut -c1-12,41- || true
