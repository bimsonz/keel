#!/bin/sh
# Tier 2 reference: `vitest run --reporter=json` inside a linux/amd64 container.
# Default image is the Cloudflare sandbox image used by the container (ExecBox) runner.
# Usage: [IMAGE=...] scripts/tier2-docker.sh <projectDir> <out.json> [extra vitest args...]
# The project is copied inside the container and installed from its lockfile.
set -eu
IMAGE=${IMAGE:-docker.io/cloudflare/sandbox:0.12.1}
SRC=$(cd "$1" && pwd)
OUT_DIR=$(cd "$(dirname "$2")" && pwd)
OUT_NAME=$(basename "$2")
shift 2
docker run --rm --platform linux/amd64 --entrypoint sh \
  -v "$SRC":/src:ro \
  -v keel-spike-14-pnpm-store:/store \
  -v "$OUT_DIR":/out \
  "$IMAGE" -c '
    set -e
    mkdir /w && cd /src && tar --exclude=./node_modules -cf - . | tar -xf - -C /w && cd /w
    command -v pnpm >/dev/null || npm install -g pnpm@11.18.0 --registry=https://registry.npmjs.org/ >/dev/null 2>&1
    printf "registry=https://registry.npmjs.org/\nstore-dir=/store\n" > .npmrc
    pnpm install --frozen-lockfile >/tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 3; }
    set +e
    start=$(date +%s%N)
    pnpm exec vitest run --reporter=json --outputFile="/out/$0" "$@" >/tmp/vitest.log 2>&1
    code=$?
    end=$(date +%s%N)
    echo "vitest exit=$code ms=$(( (end - start) / 1000000 )) node=$(node --version) arch=$(uname -m) pnpm=$(pnpm --version)"
    [ -f "/out/$0" ] || tail -30 /tmp/vitest.log
  ' "$OUT_NAME" "$@"
