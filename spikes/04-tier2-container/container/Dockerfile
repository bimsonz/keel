# Tier 2 container image for Keel's MergeBox and ExecBox: Node 22, git, pnpm,
# with forge-lite's dependencies installed ahead of time so a verify run never
# needs the npm registry.
FROM docker.io/library/node:22-bookworm-slim

# git for clone and merge-tree, ca-certificates for the trust store that the
# HTTPS intercept CA is appended to at runtime, curl for egress probes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.18.0 && npm cache clean --force

# Pre-baked dependencies, keyed by the lockfile's hash. A clone whose lockfile
# hashes the same links this node_modules instead of installing.
WORKDIR /opt/forge-deps
COPY forge-deps/package.json forge-deps/pnpm-lock.yaml forge-deps/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile \
 && sha256sum pnpm-lock.yaml | cut -c1-64 > .lock-sha \
 && pnpm store prune

WORKDIR /work
# exec() starts every command; the main process only keeps the container up.
ENTRYPOINT []
CMD ["sleep", "infinity"]
