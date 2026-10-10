#!/usr/bin/env bash
# Push a local source repo to its Artifacts repo, one commit per push so no single
# pack is larger than one commit. The token travels in a GIT_CONFIG_* env var,
# never in argv or the URL. Output has the account host redacted.
#   scripts/push-source.sh <workdir> <repo json from `wrangler artifacts repos create --json`>
set -euo pipefail
work="${1:?workdir}"; meta="${2:?repo json}"
remote=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['remote'])" "$meta")
token=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['token'])" "$meta")
cd "$work"
for c in $(git rev-list --reverse HEAD); do
  t0=$(python3 -c 'import time;print(time.time())')
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer ${token}" \
    git -c http.postBuffer=524288000 push -q "$remote" "$c:refs/heads/main" 2>&1 | sed -E 's#https://[0-9a-f]{32}\.#https://<acct>.#g'
  t1=$(python3 -c 'import time;print(time.time())')
  python3 -c "print('pushed $c in %.1f s' % ($t1-$t0))"
done
