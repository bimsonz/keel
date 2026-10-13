# The image of keel-verify's two container classes: KeelSandbox (ExecBox) runs
# project suites in Tier 2, and KeelDepsBox installs a candidate's dependencies
# from its lockfile. The runtime matches the sandbox @cloudflare/ci 0.2.0 pins.
# No project's dependencies are baked in: a deps box builds them once for a
# namespace and a lockfile, and a suite box fetches the parts it is handed, so
# a suite box still needs no registry.
FROM docker.io/cloudflare/sandbox:0.12.1

RUN npm install -g pnpm@11.18.0 && npm cache clean --force

# The toolchain a deps build is made with, in one line. The deps box reports it
# and the pointer records it: a build from a box that says another toolchain is
# never kept. A unit test holds this line and the pnpm above to core's
# DEPS_TOOLCHAIN ([image.toolchain]).
RUN echo "node $(node --version) pnpm $(pnpm --version)" > /etc/keel-toolchain
