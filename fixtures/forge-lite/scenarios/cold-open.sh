#!/usr/bin/env bash
# Cold open for the Keel demo: two agents' branches merge without a conflict,
# the merged suite is green, and the revocation probe still fails.
#
# The setup runs silently in a throwaway git repository: a base commit, branch
# agent-a with scenarios/s1/a.patch, branch agent-b (from base) with
# scenarios/s1/b.patch, and agent-a checked out. Then three commands run, each
# echoed first:
#
#   git merge --no-commit agent-b
#   pnpm test
#   pnpm probe
#
# Exits 0 only if they show what the demo needs: a clean merge, 214 passing
# tests and a failing probe. The temporary repository is removed on exit.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
demo=$(mktemp -d "${TMPDIR:-/tmp}/forge-lite-cold-open.XXXXXX")
trap 'cd / && rm -rf "$demo"' EXIT

# Same git behaviour on every machine: no user or system config, no hooks, no
# signing, and a fixed identity for the setup commits.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@keel.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@keel.invalid

# Keep colour when a person is watching, even through tee.
if [ -t 1 ]; then export FORCE_COLOR=1; fi

commit_as() {
  local who=$1 message=$2
  git add -A
  GIT_AUTHOR_NAME=$who GIT_AUTHOR_EMAIL="$who@keel.invalid" git commit -q -m "$message"
}

# --- setup (not shown) ---------------------------------------------------
repo="$demo/forge-lite"
mkdir "$repo"
for entry in "$root"/* "$root"/.[!.]*; do
  [ -e "$entry" ] || continue
  [ "$(basename "$entry")" = node_modules ] && continue
  cp -R "$entry" "$repo/"
done
cd "$repo"
git init -q -b main
commit_as fixture "forge-lite"
git checkout -q -b agent-a
git apply scenarios/s1/a.patch
commit_as agent-a "Owners can revoke collaborators, effective immediately"
git checkout -q -b agent-b main
git apply scenarios/s1/b.patch
commit_as agent-b "Speed up permission checks with a per-session role cache"
git checkout -q agent-a
ln -s "$root/node_modules" node_modules
echo node_modules >>.git/info/exclude

# --- the cold open --------------------------------------------------------
shown() {
  local log=$1
  shift
  printf '$ %s\n' "$*"
  "$@" 2>&1 | tee "$log"
}
plain() { sed $'s/\x1b\\[[0-9;]*m//g' "$1"; }

shown "$demo/merge.log" git merge --no-commit agent-b
echo
shown "$demo/test.log" pnpm test
echo
probe_exit=0
shown "$demo/probe.log" pnpm probe || probe_exit=$?

# --- did it go as scripted? -----------------------------------------------
problems=()
plain "$demo/merge.log" | grep -q "Automatic merge went well; stopped before committing as requested" ||
  problems+=("the merge was not clean")
plain "$demo/test.log" | grep -Eq "Tests +214 passed \(214\)" ||
  problems+=("the suite did not show 214 passed")
[ "$probe_exit" -eq 1 ] || problems+=("pnpm probe exited $probe_exit, expected 1 (fail)")
plain "$demo/probe.log" | grep -q "^bob DELETE /repos/alice/forge -> 204 (expected 403)$" ||
  problems+=("the probe did not show bob's DELETE answering 204")
plain "$demo/probe.log" | grep -q '^{"outcome":"fail",' ||
  problems+=("the probe outcome was not fail")

if [ "${#problems[@]}" -gt 0 ]; then
  printf '\ncold open did not go as scripted:\n' >&2
  printf '  - %s\n' "${problems[@]}" >&2
  exit 1
fi
