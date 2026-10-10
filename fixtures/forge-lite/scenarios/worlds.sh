#!/usr/bin/env bash
# Builds every world of the revocation scenario from the base fixture plus a
# stack of patches, runs the suite once and the probe three times in each, and
# compares the results with the expected matrix. Exits 0 only on a match.
#
# Each world is a copy of the fixture in a temporary directory, sharing this
# fixture's node_modules through a symlink. Nothing here touches the fixture.
#
#   FORGE_LITE_DIR  fixture to copy (default: the directory above this script)
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=${FORGE_LITE_DIR:-$(dirname "$here")}
work=$(mktemp -d "${TMPDIR:-/tmp}/forge-lite-worlds.XXXXXX")
trap 'rm -rf "$work"' EXIT

# world | patches, applied in order | suite | tests | probe
cat >"$work/expected" <<'EOF'
base||green|200|n/a
A|s1/a.patch|green|207|pass
B|s1/b.patch|green|207|n/a
A+B|s1/a.patch s1/b.patch|green|214|fail
A+B+B'|s1/a.patch s1/b.patch s1/b-revised.patch|green|214|pass
A+B+B'+careless|s1/a.patch s1/b.patch s1/b-revised.patch s2/careless.patch|green|214|fail
EOF

copy_fixture() {
  local dest=$1 entry
  mkdir -p "$dest"
  for entry in "$root"/* "$root"/.[!.]*; do
    [ -e "$entry" ] || continue
    [ "$(basename "$entry")" = node_modules ] && continue
    cp -R "$entry" "$dest/"
  done
  ln -s "$root/node_modules" "$dest/node_modules"
}

# Prints "passed total" from a vitest JSON report, or nothing if unreadable.
suite_counts() {
  node -e '
    try {
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(r.numPassedTests, r.numTotalTests);
    } catch {}
  ' "$1"
}

show() {
  local probe=$3
  [ "$probe" = fail ] && probe=FAIL
  printf '%-16s  %-14s  %-5s  %-9s  %s\n' "$1" "$2" "$probe" "$4" "$5"
}

mismatches=0
index=0
show "world" "suite" "probe" "stable" "detail"
show "-----" "-----" "-----" "------" "------"
while IFS='|' read -r name patches want_suite want_tests want_probe; do
  index=$((index + 1))
  dir="$work/world-$index"
  copy_fixture "$dir"

  applied=yes
  for patch in $patches; do
    if ! (cd "$dir" && git apply "$root/scenarios/$patch") </dev/null >"$work/apply-$index.log" 2>&1; then
      echo "world $name: scenarios/$patch does not apply:" >&2
      cat "$work/apply-$index.log" >&2
      applied=no
      break
    fi
  done

  suite=red
  passed=0
  total=0
  if [ "$applied" = yes ]; then
    report="$work/suite-$index.json"
    (cd "$dir" && pnpm --silent test --reporter=json --outputFile="$report") </dev/null >"$work/suite-$index.log" 2>&1
    suite_exit=$?
    read -r passed total <<<"$(suite_counts "$report")"
    passed=${passed:-0}
    total=${total:-0}
    if [ "$suite_exit" -eq 0 ] && [ "$total" -gt 0 ] && [ "$passed" -eq "$total" ]; then suite=green; fi
  fi

  outcomes=()
  detail=""
  for run in 1 2 3; do
    outcome=error
    if [ "$applied" = yes ]; then
      out=$(cd "$dir" && pnpm --silent probe 2>/dev/null </dev/null)
      code=$?
      json=$(printf '%s\n' "$out" | tail -n 1)
      case $code in
        0) outcome=pass ;;
        1) outcome=fail ;;
        3) outcome=n/a ;;
      esac
      # The exit code and the JSON line must tell the same story.
      case $json in
        "{\"outcome\":\"$outcome\","*) ;;
        *) outcome=error ;;
      esac
      if [ "$run" -eq 1 ]; then
        detail=$(printf '%s\n' "$out" | grep '^bob DELETE' || printf '%s\n' "$json" | sed -n 's/.*"reason":"\(.*\)"}$/\1/p')
      fi
    fi
    outcomes+=("$outcome")
  done
  probe=${outcomes[0]}
  stable=no
  if [ "${outcomes[1]}" = "$probe" ] && [ "${outcomes[2]}" = "$probe" ]; then stable="yes (3/3)"; fi

  verdict=""
  if [ "$suite" != "$want_suite" ] || [ "$total" != "$want_tests" ] || [ "$probe" != "$want_probe" ] || [ "$stable" = no ]; then
    mismatches=$((mismatches + 1))
    verdict="  <- expected $want_suite $want_tests/$want_tests, probe $want_probe, stable"
  fi
  show "$name" "$passed/$total $suite" "$probe" "$stable" "$detail$verdict"
done <"$work/expected"

echo
if [ "$mismatches" -eq 0 ]; then
  echo "matrix matches the expected outcomes"
  exit 0
fi
echo "matrix differs from the expected outcomes in $mismatches world(s)"
exit 1
