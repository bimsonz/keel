#!/usr/bin/env bash
# Push refs/keel/test, refs/notes/mfp and refs/heads/cand/x, list them, fetch
# them back into a fresh repo, and check a stale update to a custom ref is refused.
#
#   REMOTE=... TOKEN=... scripts/custom-refs.sh <workdir>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
work="${1:?workdir}"
: "${REMOTE:?}" "${TOKEN:?}"
raw() { node --no-warnings "$here/rawpush.ts" "$@"; }
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got '${2:0:40}' want '${3:0:40}'"; fail=1; fi; }

rm -rf "$work" && mkdir -p "$work" && cd "$work"
git init -q -b main src && cd src
agit fetch -q "$REMOTE" main && git reset -q --hard FETCH_HEAD
echo "custom $RANDOM" >custom.txt && git add -A && git commit -q -m "commit for custom refs"
c=$(git rev-parse HEAD)
git update-ref refs/keel/test "$c"
git notes --ref=mfp add -m '{"mfp":"spike-01","change":"I0001"}' "$c"
notes=$(git rev-parse refs/notes/mfp)
git branch -q cand/x "$c"
echo "commit=${c:0:12} notes-commit=${notes:0:12}"

echo; echo "## push the three refs"
agit push "$REMOTE" refs/keel/test:refs/keel/test refs/notes/mfp:refs/notes/mfp refs/heads/cand/x:refs/heads/cand/x 2>&1 | redact
echo "exit=${PIPESTATUS[0]}"

echo; echo "## ls-remote (protocol v2, git's default)"
agit ls-remote "$REMOTE" | redact | cut -c1-12,41-
echo; echo "## ls-remote (protocol v0)"
agit -c protocol.version=0 ls-remote "$REMOTE" | redact | cut -c1-12,41-
echo; echo "## receive-pack advertisement"
raw refs | cut -c1-12,41-

echo; echo "## fetch back into a fresh repo"
cd .. && git init -q -b main back && cd back
agit fetch -q "$REMOTE" 'refs/keel/*:refs/keel/*' 'refs/notes/*:refs/notes/*' 'refs/heads/cand/*:refs/remotes/o/cand/*' 2>&1 | redact
echo "fetch exit=${PIPESTATUS[0]}"
git for-each-ref --format='%(objectname:short=12) %(refname)'
check "refs/keel/test round-trips" "$(git rev-parse -q --verify refs/keel/test)" "$c"
check "refs/notes/mfp round-trips" "$(git rev-parse -q --verify refs/notes/mfp)" "$notes"
check "refs/heads/cand/x round-trips" "$(git rev-parse -q --verify refs/remotes/o/cand/x)" "$c"
check "note body readable after fetch" "$(git notes --ref=mfp show "$c" 2>&1)" '{"mfp":"spike-01","change":"I0001"}'

echo; echo "## a plain clone: which refs come along by default"
cd .. && agit clone -q "$REMOTE" plain 2>&1 | redact
git -C plain for-each-ref --format='%(refname)' | sed 's/^/  /'

echo; echo "## stale update to refs/keel/test is refused by the server"
cd src
bogus=$(printf 'keel-spike-bogus' | git hash-object --stdin)
n=$(git commit-tree "$(git rev-parse "$c^{tree}")" -p "$c" -m "custom ref stale")
raw single . "$bogus:$n:refs/keel/test"
echo; echo "## and a correct update to refs/keel/test is applied (control)"
raw single . "$c:$n:refs/keel/test"

echo; echo "## append a second note and push (notes ref is a fast-forward)"
git notes --ref=mfp add -m '{"mfp":"second"}' "$n"
agit push "$REMOTE" refs/notes/mfp:refs/notes/mfp 2>&1 | redact | grep -E '\.\.|rejected|new'
check "notes ref advanced on the server" "$(raw refs | awk '$2=="refs/notes/mfp"{print $1}')" "$(git rev-parse refs/notes/mfp)"

echo; [ "$fail" = 0 ] && echo "ALL CHECKS PASS" || echo "SOME CHECKS FAILED"
exit "$fail"
