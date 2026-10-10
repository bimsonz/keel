#!/usr/bin/env bash
# For each forge-lite world: build it from the fixture plus patches (in a scratch
# directory), then run the suite and the probe three ways and compare per-test status:
#   node   - `vitest run --reporter=json` on the host
#   docker - the same inside linux/amd64 node:22 (Tier 2 reference)
#   tier1  - worker-bundler bundle -> LOADER.get child on the edge
# Usage: BASE=... TOKEN=... scripts/worlds-parity.sh <fixtureDir> <workDir> <nodeModulesDir> [tag]
set -u
here=$(cd "$(dirname "$0")" && pwd)
fixture=$(cd "$1" && pwd)
work=$2
deps=$3
tag=${4:-w}
mkdir -p "$work"
s14="node $here/s14.ts"

worlds='base|
A|s1/a.patch
B|s1/b.patch
A+B|s1/a.patch s1/b.patch
A+B+Bp|s1/a.patch s1/b.patch s1/b-revised.patch
A+B+Bp+careless|s1/a.patch s1/b.patch s1/b-revised.patch s2/careless.patch'

printf '%-16s %-7s %-22s %-22s %-22s %-8s %-8s %-8s %-8s\n' world tests node-vs-tier1 docker-vs-tier1 node-vs-docker run-probe p.node p.docker p.tier1
i=0
while IFS='|' read -r name patches; do
  i=$((i + 1))
  dir="$work/$name"
  rm -rf "$dir" && mkdir -p "$dir"
  (cd "$fixture" && tar --exclude=./node_modules -cf - .) | tar -xf - -C "$dir"
  for p in $patches; do (cd "$dir" && git apply "$fixture/scenarios/$p") || { echo "patch $p failed for $name"; continue 2; }; done
  ln -s "$deps" "$dir/node_modules"
  tests=$(cd "$dir" && find test -name '*.test.ts' | sort | tr '\n' ',' | sed 's/,$//')
  out="$work/out-$name"
  mkdir -p "$out"

  # Node reference: suite and probe.
  (cd "$dir" && ./node_modules/.bin/vitest run --reporter=json --outputFile="$out/node.json" >"$out/node.log" 2>&1)
  (cd "$dir" && ./node_modules/.bin/vitest run --config scenarios/vitest.probe.config.ts --reporter=json --outputFile="$out/node-probe.json" >"$out/node-probe.log" 2>&1)
  # The fixture's own probe runner (exit 0 pass / 1 fail / 3 n/a, one JSON line).
  (cd "$dir" && node scenarios/run-probe.mjs >"$out/run-probe.txt" 2>&1; echo "exit=$?" >>"$out/run-probe.txt")

  # Tier 2 reference in Docker (node_modules symlink excluded; installed in the container).
  "$here/tier2-docker.sh" "$dir" "$out/docker.json" >"$out/docker.log" 2>&1
  "$here/tier2-docker.sh" "$dir" "$out/docker-probe.json" --config scenarios/vitest.probe.config.ts >"$out/docker-probe.log" 2>&1

  # Tier 1 on the edge.
  $s14 bundle "$dir" "$tag-$i" "tests=$tests" >"$out/bundle.json"
  $s14 run "$tag-$i" cold 1 1 "do=par-$tag-$i" "out=$out/tier1.json" >"$out/run.json"
  $s14 bundle "$dir" "$tag-$i-probe" tests=scenarios/s1/probe.test.ts >"$out/bundle-probe.json"
  $s14 run "$tag-$i-probe" cold 1 1 "do=par-$tag-$i-probe" "out=$out/tier1-probe.json" >"$out/run-probe.json"

  $s14 parity "$out/node.json" "$out/tier1.json" "$dir" >"$out/parity-node.json"
  $s14 parity "$out/docker.json" "$out/tier1.json" /w >"$out/parity-docker.json"
  # node vs docker, both read as vitest JSON: convert docker to rows first.
  node -e '
    const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1]));const rows=[];
    for (const f of j.testResults){const file=f.name.replace(/^\/w\//,"");for(const a of f.assertionResults)rows.push({file,name:[...a.ancestorTitles,a.title].join(" > "),status:a.status==="passed"?"pass":a.status==="failed"?"fail":"skip"});}
    fs.writeFileSync(process.argv[2],JSON.stringify(rows));' "$out/docker.json" "$out/docker-rows.json"
  $s14 parity "$out/node.json" "$out/docker-rows.json" "$dir" >"$out/parity-node-docker.json"

  summ() { node -e 'const p=require(process.argv[1]);console.log((p.identical?"identical":"DIFF")+" "+p.tier1Tests+"/"+p.nodeTests+" m="+p.mismatches.length)' "$1"; }
  pn=$($s14 probe "$out/node-probe.json")
  pd=$($s14 probe "$out/docker-probe.json")
  pt=$($s14 probe "$out/tier1-probe.json")
  ntests=$(node -e 'console.log(require(process.argv[1]).numTotalTests)' "$out/node.json")
  rp=$(grep -o '"outcome":"[^"]*"' "$out/run-probe.txt" | cut -d'"' -f4)
  printf '%-16s %-7s %-22s %-22s %-22s %-8s %-8s %-8s %-8s\n' "$name" "$ntests" "$(summ "$out/parity-node.json")" "$(summ "$out/parity-docker.json")" "$(summ "$out/parity-node-docker.json")" "$rp" "$pn" "$pd" "$pt"
done <<<"$worlds"
