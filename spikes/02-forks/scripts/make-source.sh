#!/usr/bin/env bash
# Build a local git repo of mostly incompressible content (random bytes).
#   scripts/make-source.sh <workdir> <total MB> <commits>
# Each commit adds <total MB>/<commits> of fresh random files (64 files per commit),
# so the pack cannot be compressed or delta-ed below the target size.
set -euo pipefail
work="${1:?workdir}"; mb="${2:?total MB}"; commits="${3:-1}"
rm -rf "$work" && mkdir -p "$work" && cd "$work"
git init -q -b main
per_commit_kb=$(( mb * 1024 / commits ))
files=64
file_kb=$(( per_commit_kb / files ))
[ "$file_kb" -lt 1 ] && file_kb=1
for c in $(seq 1 "$commits"); do
  mkdir -p "blob/c$c"
  for f in $(seq -f '%03g' 1 "$files"); do
    head -c "$(( file_kb * 1024 ))" /dev/urandom > "blob/c$c/f$f.bin"
  done
  printf 'source %s MB, commit %s of %s\n' "$mb" "$c" "$commits" > README.md
  git add -A
  git -c user.name=keel-seed -c user.email=seed@keel.invalid commit -q -m "seed: commit $c of $commits ($per_commit_kb KiB random)"
done
echo "head: $(git rev-parse HEAD)  commits: $commits  size: $(du -sh .git | cut -f1)"
