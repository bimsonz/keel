# KeelSandbox (ExecBox): runs project suites in Tier 2. The runtime matches the
# sandbox @cloudflare/ci 0.2.0 pins. Each ecosystem's dependencies are baked in
# (spike S4: baking beats npm ci and snapshots), so a runner needs no registry
# and its egress can stay closed to everything but the bundle host.
FROM docker.io/cloudflare/sandbox:0.12.1

RUN npm install -g pnpm@11.18.0 && npm cache clean --force

# forge-lite's dependencies (the js-ts pack's first project), from a byte-for-byte
# copy of its manifests: a unit test fails when they drift from the fixture. The
# suite command links this node_modules only when the candidate's lockfile hashes
# to .lock-sha; otherwise it abstains as lockfile-diverged.
WORKDIR /opt/forge-deps
COPY forge-deps/package.json forge-deps/pnpm-lock.yaml forge-deps/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile \
 && sha256sum pnpm-lock.yaml | cut -c1-64 > .lock-sha \
 && pnpm store prune

# Back to the sandbox server's own directory; its entrypoint is unchanged.
WORKDIR /container-server
