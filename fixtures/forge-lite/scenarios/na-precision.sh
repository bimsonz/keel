#!/usr/bin/env bash
# Checks that the probe reports "n/a" only for Hono's default 404 on the revoke
# route, and never for a real 404 or 403 that the route itself returns.
#
#   base world, probe as written          -> n/a  (route absent)
#   world A, revoke someone who is not a  -> fail (the route answers a
#     collaborator                                 problem+json 404)
#   world A, bob as a write collaborator  -> fail (the route answers a
#     tries the revoke himself                     problem+json 403)
#
# Each case runs the real runner (scenarios/run-probe.mjs) on an edited copy
# of the probe in a throwaway world. Exits non-zero if any outcome differs.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
work=$(mktemp -d "${TMPDIR:-/tmp}/forge-lite-na.XXXXXX")
trap 'cd / && rm -rf "$work"' EXIT
probe=scenarios/s1/probe.test.ts

world() {
  local dir="$work/$1" entry
  mkdir "$dir"
  for entry in "$root"/* "$root"/.[!.]*; do
    [ -e "$entry" ] || continue
    [ "$(basename "$entry")" = node_modules ] && continue
    cp -R "$entry" "$dir/"
  done
  ln -s "$root/node_modules" "$dir/node_modules"
  shift
  for patch in "$@"; do (cd "$dir" && git apply "scenarios/$patch"); done
}

failures=0
case_() {
  local title=$1 dir=$2 want=$3 got
  shift 3
  echo "--- $title"
  if [ "$#" -gt 0 ]; then
    sed "$@" "$root/$probe" >"$dir/$probe"
    diff "$root/$probe" "$dir/$probe" | sed -n 's/^> *//p' | sed 's/^/    edited: /'
  else
    cp "$root/$probe" "$dir/$probe"
  fi
  (cd "$dir" && node scenarios/run-probe.mjs)
  case $? in 0) got=pass ;; 1) got=fail ;; 3) got=n/a ;; *) got=error ;; esac
  if [ "$got" = "$want" ]; then
    echo "    outcome $got, as expected"
  else
    echo "    outcome $got, expected $want"
    failures=$((failures + 1))
  fi
  echo
}

world base
world a s1/a.patch

case_ "base world: no revoke route, so Hono's default 404" "$work/base" n/a

case_ "world A: revoke carol, who is not a collaborator" "$work/a" fail \
  -e 's|call("DELETE", COLLABORATOR, alice)|call("DELETE", `${REPO}/collaborators/carol`, alice)|' \
  -e 's|alice DELETE ${COLLABORATOR}|alice DELETE ${REPO}/collaborators/carol|g'

case_ "world A: bob, only a write collaborator, tries the revoke himself" "$work/a" fail \
  -e 's|{ role: "admin" }|{ role: "write" }|' \
  -e 's|call("DELETE", COLLABORATOR, alice)|call("DELETE", COLLABORATOR, bob)|' \
  -e 's|alice DELETE ${COLLABORATOR}|bob DELETE ${COLLABORATOR}|g'

if [ "$failures" -eq 0 ]; then
  echo "n/a fires only for the absent route"
  exit 0
fi
echo "$failures case(s) gave the wrong outcome"
exit 1
