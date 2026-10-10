#!/usr/bin/env bash
# S3 shallow push: clone --depth 1 from src, commit, push into an empty repo,
# then check whether the destination serves a valid clone. Also pushes the same
# shallow clone back to src (which has the history) for comparison.
#
#   SRC_REMOTE=... SRC_TOKEN=... DST_REMOTE=... DST_TOKEN=... scripts/shallow.sh <workdir>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
work="${1:?workdir}"
: "${SRC_REMOTE:?}" "${SRC_TOKEN:?}" "${DST_REMOTE:?}" "${DST_TOKEN:?}"
src() { TOKEN="$SRC_TOKEN" agit "$@"; }
dst() { TOKEN="$DST_TOKEN" agit "$@"; }

# verify_clone <label> <remote-fn> : the check a consumer of the repo needs. A
# plain clone must be complete (not shallow), pass fsck --full, and the history
# must reach a root commit. Prints VERIFY OK/FAIL.
verify_clone() {
  local label="$1" fn="$2" dir="$work/verify-$1" out rc
  rm -rf "$dir"
  out=$($fn clone -q --no-checkout "$( [ "$fn" = src ] && echo "$SRC_REMOTE" || echo "$DST_REMOTE")" "$dir" 2>&1); rc=$?
  echo "$out" | redact | sed 's/^/  clone: /'
  if [ $rc != 0 ]; then echo "VERIFY FAIL [$label] clone exit=$rc"; return 1; fi
  echo "  shallow=$(git -C "$dir" rev-parse --is-shallow-repository) commits=$(git -C "$dir" rev-list --count --all 2>&1 | head -1)"
  out=$(git -C "$dir" fsck --full --no-dangling 2>&1); rc=$?
  echo "$out" | head -5 | sed 's/^/  fsck: /'
  if [ $rc != 0 ]; then echo "VERIFY FAIL [$label] fsck exit=$rc"; return 1; fi
  if [ "$(git -C "$dir" rev-parse --is-shallow-repository)" = true ]; then
    echo "  server-recorded shallow boundary: $(cut -c1-12 "$dir/.git/shallow" | tr '\n' ' ')"
    out=$($fn -C "$dir" fetch --unshallow 2>&1); rc=$?
    echo "$out" | redact | grep -vE '^remote: (Processing|Counting|Compressing)' | head -3 | sed 's/^/  unshallow: /'
    echo "  after --unshallow: exit=$rc shallow=$(git -C "$dir" rev-parse --is-shallow-repository) commits=$(git -C "$dir" rev-list --count --all)"
    echo "VERIFY FAIL [$label] plain clone is shallow: history truncated at the boundary"; return 1
  fi
  echo "  root commits: $(git -C "$dir" rev-list --max-parents=0 --all | wc -l | tr -d ' ')"
  echo "VERIFY OK   [$label]"
}

rm -rf "$work" && mkdir -p "$work" && cd "$work"

echo "## 1. shallow clone of src"
t0=$(now_ms); src clone -q --depth 1 "$SRC_REMOTE" sh 2>&1 | redact; echo "clone exit=${PIPESTATUS[0]} ms=$(( $(now_ms) - t0 ))"
cd sh
echo "is-shallow=$(git rev-parse --is-shallow-repository) commits-local=$(git rev-list --count HEAD) boundary=$(cut -c1-12 .git/shallow)"
src_head=$(git rev-parse HEAD)
echo "agent edit" >>docs/log.txt && git commit -q -am "agent commit on shallow clone"
c=$(git rev-parse HEAD)
echo "new commit=${c:0:12} parent=${src_head:0:12}"

echo; echo "## 2. push the shallow clone to the EMPTY repo shallow-dst"
t0=$(now_ms)
out=$(GIT_TRACE_PACKET="$work/push-dst.trace" dst push "$DST_REMOTE" HEAD:refs/heads/main 2>&1); rc=$?
echo "$out" | redact; echo "push exit=$rc ms=$(( $(now_ms) - t0 ))"
echo "shallow lines sent: $(grep -Eo '> shallow [0-9a-f]{40}' "$work/push-dst.trace" | cut -c1-22 | tr '\n' ' ')"
echo "dst refs: $(dst ls-remote "$DST_REMOTE" | cut -c1-12,41- | tr '\n' ' ')"
cd "$work"

echo; echo "## 3. does shallow-dst serve a valid clone?"
verify_clone dst dst
echo "-- shallow clone of dst (depth 1)"
rm -rf dst-d1; out=$(dst clone -q --depth 1 --no-checkout "$DST_REMOTE" dst-d1 2>&1); rc=$?; echo "$out" | redact; echo "depth-1 clone exit=$rc $( [ -d dst-d1 ] && git -C dst-d1 fsck --no-dangling >/dev/null 2>&1 && echo fsck-ok || echo fsck-fail-or-absent)"
echo "-- into a fresh repo, fetch by SHA from dst: the shallow root itself, then its parent (absent on dst)"
rm -rf full-src && git init -q --bare full-src && (cd full-src && src fetch -q "$SRC_REMOTE" main)
grand=$(git -C full-src rev-parse "$src_head~1")   # parent of the boundary: exists only in src
rm -rf probe && git init -q probe
out=$(cd probe && dst fetch "$DST_REMOTE" "$src_head" 2>&1); rc=$?; echo "$out" | redact | grep -vE '^remote: (Processing|Counting)' | head -3; echo "fetch boundary ${src_head:0:12} exit=$rc object-present=$(git -C probe cat-file -e "$src_head" 2>/dev/null && echo yes || echo no)"
out=$(cd probe && dst fetch "$DST_REMOTE" "$c" 2>&1); rc=$?; echo "$out" | redact | grep -vE '^remote: (Processing|Counting)' | head -3; echo "fetch tip ${c:0:12} exit=$rc object-present=$(git -C probe cat-file -e "$c" 2>/dev/null && echo yes || echo no) shallow=$(git -C probe rev-parse --is-shallow-repository)"
out=$(cd probe && dst fetch --update-shallow "$DST_REMOTE" "$c" 2>&1); rc=$?; echo "$out" | redact | grep -vE '^remote: (Processing|Counting)' | head -3; echo "fetch tip with --update-shallow exit=$rc object-present=$(git -C probe cat-file -e "$c" 2>/dev/null && echo yes || echo no) shallow=$(git -C probe rev-parse --is-shallow-repository)"
out=$(cd probe && dst fetch "$DST_REMOTE" "$grand" 2>&1); rc=$?; echo "$out" | redact | grep -vE '^remote: (Processing|Counting)' | head -3; echo "fetch boundary's parent ${grand:0:12} (not on dst) exit=$rc"

echo; echo "## 4. push the same shallow clone back to src (which holds the history) as agent/shallow-<pid>"
cd sh
t0=$(now_ms)
out=$(GIT_TRACE_PACKET="$work/push-src.trace" src push "$SRC_REMOTE" HEAD:refs/heads/agent/shallow-$$ 2>&1); rc=$?
echo "$out" | redact; echo "push exit=$rc ms=$(( $(now_ms) - t0 ))"
cd "$work"
verify_clone src src
