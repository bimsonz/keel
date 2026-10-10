#!/usr/bin/env bash
# Build a ~200-file repo with local git and push it to an Artifacts repo
# using the Bearer header. The token is passed via GIT_CONFIG_* env vars so it
# never appears in argv or in the remote URL.
#
#   SEED_REMOTE=https://.../seed.git SEED_TOKEN=art_... scripts/seed.sh <workdir>
set -euo pipefail
: "${SEED_REMOTE:?}" "${SEED_TOKEN:?}"
work="${1:?workdir}"
rm -rf "$work" && mkdir -p "$work" && cd "$work"
git init -q -b main
for dir in src/core src/util docs test; do
  mkdir -p "$dir"
  for i in $(seq -f '%03g' 0 49); do
    printf '%s/file-%s\nline two\nline three: %s\n' "$dir" "$i" "$RANDOM" > "$dir/file-$i.txt"
  done
done
printf '# seed\n\nWorkspace seed for spike 12.\n' > README.md
git add -A
git -c user.name=keel-seed -c user.email=seed@keel.invalid commit -q -m "seed: 200 small files"
echo "files: $(git ls-files | wc -l | tr -d ' ')  head: $(git rev-parse HEAD)"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer ${SEED_TOKEN}" \
  git push "$SEED_REMOTE" main 2>&1 | sed -E 's#https://[0-9a-f]{32}\.#https://<account>.#g'
