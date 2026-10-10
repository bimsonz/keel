#!/usr/bin/env bash
# Shows that agent A's and agent B's changes do not collide on lines: in a
# throwaway repository, branch agent-a (a.patch) and branch agent-b (b.patch)
# from the same base, list the files each one changes, and merge them in both
# directions without committing. Exits non-zero if either merge is not clean.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
work=$(mktemp -d "${TMPDIR:-/tmp}/forge-lite-merge.XXXXXX")
trap 'cd / && rm -rf "$work"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@keel.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@keel.invalid

for entry in "$root"/* "$root"/.[!.]*; do
  [ -e "$entry" ] || continue
  [ "$(basename "$entry")" = node_modules ] && continue
  cp -R "$entry" "$work/"
done
cd "$work"
git init -q -b main
git add -A && git commit -q -m "forge-lite"
git checkout -q -b agent-a && git apply scenarios/s1/a.patch && git add -A && git commit -q -m "A"
git checkout -q -b agent-b main && git apply scenarios/s1/b.patch && git add -A && git commit -q -m "B"

echo "changed by A:    $(git diff --name-only main agent-a | tr '\n' ' ')"
echo "changed by B:    $(git diff --name-only main agent-b | tr '\n' ' ')"
echo "changed by both: $(comm -12 <(git diff --name-only main agent-a) <(git diff --name-only main agent-b) | tr '\n' ' ')"

merge() {
  local into=$1 from=$2
  git checkout -q "$into"
  echo "\$ git checkout $into && git merge --no-commit $from"
  git merge --no-commit "$from"
  git merge --abort
}
merge agent-a agent-b
merge agent-b agent-a
