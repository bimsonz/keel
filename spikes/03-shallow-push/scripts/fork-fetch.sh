#!/usr/bin/env bash
# Fork src through the binding, push to the fork, then fetch commits from the
# fork by SHA: an advertised tip, a reachable non-tip, an unreachable commit, a
# commit that only exists in src, a src branch the fork did not copy, and an
# oid that exists nowhere. Each in protocol v2 (git's default) and v0.
#
#   SRC_REMOTE SRC_TOKEN FORK_REMOTE FORK_TOKEN WORKER_URL SPIKE_KEY  scripts/fork-fetch.sh <workdir>
# The fork itself is made beforehand with: scripts/call.sh '/fork?src=src&name=fork1'
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
work="${1:?workdir}"
: "${SRC_REMOTE:?}" "${SRC_TOKEN:?}" "${FORK_REMOTE:?}" "${FORK_TOKEN:?}"
src() { TOKEN="$SRC_TOKEN" agit "$@"; }
frk() { TOKEN="$FORK_TOKEN" agit "$@"; }
rm -rf "$work" && mkdir -p "$work" && cd "$work"

echo "## fork refs right after the fork"
frk ls-remote "$FORK_REMOTE" | cut -c1-12,41-
side=$(src ls-remote "$SRC_REMOTE" 'refs/heads/agent/*' | head -1 | awk '{print $1}')
echo "src non-default branch tip (not copied by a default-branch-only fork): ${side:0:12}"

echo; echo "## push F1, F2 (F2 on F1) to fork main; F3 to a temp branch, then delete the branch"
frk clone -q "$FORK_REMOTE" f 2>&1 | redact
cd f
git commit -q --allow-empty -m F1 && F1=$(git rev-parse HEAD)
git commit -q --allow-empty -m F2 && F2=$(git rev-parse HEAD)
frk push -q "$FORK_REMOTE" HEAD:refs/heads/main 2>&1 | redact | grep -vE '^remote: Processing'
git checkout -q -b tmp && git commit -q --allow-empty -m F3 && F3=$(git rev-parse HEAD)
frk push -q "$FORK_REMOTE" HEAD:refs/heads/tmp 2>&1 | redact | grep -vE '^remote: Processing'
frk push -q "$FORK_REMOTE" :refs/heads/tmp 2>&1 | redact | grep -vE '^remote: Processing'
cd ..
echo "F1=${F1:0:12} F2=${F2:0:12} F3=${F3:0:12}"
echo "fork refs now:"; frk ls-remote "$FORK_REMOTE" | cut -c1-12,41-

echo; echo "## push S1 to src main after the fork (exists only in src)"
src clone -q "$SRC_REMOTE" s 2>&1 | redact
(cd s && git commit -q --allow-empty -m S1 && src push -q "$SRC_REMOTE" HEAD:refs/heads/main 2>&1 | redact | grep -vE '^remote: Processing')
S1=$(git -C s rev-parse HEAD)
echo "S1=${S1:0:12}"
NOWHERE=$(printf 'keel-spike-03 nowhere' | git hash-object --stdin)

try() { # <label> <sha> <protocol> [into-dir]
  local label="$1" sha="$2" proto="$3" dir="${4:-}" out rc present
  if [ -z "$dir" ]; then dir="probe-$label-v$proto"; rm -rf "$dir"; git init -q "$dir"; fi
  out=$(cd "$dir" && frk -c protocol.version="$proto" fetch "$FORK_REMOTE" "$sha" 2>&1); rc=$?
  present=$(git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null && echo yes || echo no)
  printf '%-34s v%s exit=%-3s object-present=%-3s %s\n' "$label (${sha:0:12})" "$proto" "$rc" "$present" \
    "$(echo "$out" | redact | grep -vE '^remote: (Processing|Counting|Compressing|Enumerating)|^From |^ \* branch' | head -2 | tr '\n' ' ')"
}

echo; echo "## fetch by SHA from the fork into a fresh empty repo"
for proto in 2 0; do
  try advertised-tip-F2 "$F2" "$proto"
  try reachable-non-tip-F1 "$F1" "$proto"
  try unreachable-F3 "$F3" "$proto"
  try source-only-S1 "$S1" "$proto"
  try src-branch-not-forked "$side" "$proto"
  try nonexistent "$NOWHERE" "$proto"
done

echo; echo "## the realistic flow: a full clone of src fetches the agent's tip from the fork by SHA"
src clone -q --bare "$SRC_REMOTE" trunk 2>&1 | redact
t0=$(now_ms)
try into-src-clone-F2 "$F2" 2 trunk
echo "  ms=$(( $(now_ms) - t0 )) parent-chain-ok=$(git -C trunk merge-base --is-ancestor "$(git -C trunk rev-parse "$F2~2")" "$F2" && echo yes || echo no)"
