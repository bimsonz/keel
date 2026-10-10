#!/usr/bin/env bash
# Seed keel-spike-04/forge with fixtures/forge-lite on main, plus agent-a
# (base + scenarios/s1/a.patch) and agent-b (base + scenarios/s1/b.patch).
#
#   REMOTE=... TOKEN=... scripts/seed.sh <fixture dir> <workdir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
fixture="${1:?fixture dir}" work="${2:?workdir}"
: "${REMOTE:?}" "${TOKEN:?}"
rm -rf "$work" && mkdir -p "$work"
tar -C "$fixture" --exclude=node_modules -cf - . | tar -C "$work" -xf -
cd "$work"
git init -q -b main
git add -A && git commit -q -m "forge-lite base"
git switch -q -c agent-a main && git apply scenarios/s1/a.patch && git add -A && git commit -q -m "agent-a: owners can revoke collaborators"
git switch -q -c agent-b main && git apply scenarios/s1/b.patch && git add -A && git commit -q -m "agent-b: per-session permission cache"
git switch -q main
for b in main agent-a agent-b; do echo "$b $(git rev-parse "$b")"; done
agit push "$REMOTE" main agent-a agent-b 2>&1 | redact
echo "push exit=${PIPESTATUS[0]}"
agit ls-remote "$REMOTE" | redact
