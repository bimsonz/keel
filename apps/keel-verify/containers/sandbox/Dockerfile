# The image of keel-verify's two container classes: KeelSandbox (ExecBox) runs
# project suites in Tier 2, and KeelDepsBox installs a candidate's dependencies
# from its lockfile. One image for both, so a bundle the deps box builds runs
# in the suite box unchanged. No project's dependencies are baked in: a deps
# box builds them once for a namespace and a lockfile, and a suite box fetches
# the parts it is handed, so a suite box still needs no registry.
#
# Ubuntu 24.04, the base CI runs on, with the sandbox runtime of the
# @cloudflare/sandbox release the Worker runs (0.12.10: the package and this
# image move together, and @cloudflare/ci is held to it by an override).

# Git 2.55.0, the git CI runs and one GitCore's oracle tests are proven against
# (2.50 to 2.55). Built from kernel.org's tarball, which is not unpacked unless
# its sha256 matches; with its Rust parts, as the git-core PPA builds CI's; and
# without OpenSSL, Perl or Python, as nothing here needs them (its https goes
# through curl and gnutls).
FROM docker.io/library/ubuntu:24.04 AS git
ARG DEBIAN_FRONTEND=noninteractive
ARG GIT_VERSION=2.55.0
ARG GIT_SHA256=457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils build-essential cargo libcurl4-gnutls-dev libexpat1-dev libpcre2-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" -o /tmp/git.tar.xz \
 && echo "${GIT_SHA256}  /tmp/git.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/git.tar.xz -C /tmp \
 && make -C "/tmp/git-${GIT_VERSION}" -j"$(nproc)" prefix=/usr/local USE_LIBPCRE2=YesPlease NO_OPENSSL=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease NO_GETTEXT=YesPlease NO_TCLTK=YesPlease DESTDIR=/out install

FROM docker.io/library/ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive

# ca-certificates and curl for every fetch; procps; xz-utils for node's
# tarball; squashfs-tools, squashfuse and fuse3 for the workspace backups
# @cloudflare/ci restores; the libraries the built git links; openssh-client
# for ssh-keygen, which GitCore's SSH signatures are checked with.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl procps xz-utils squashfs-tools squashfuse fuse3 libcurl3t64-gnutls libexpat1 libpcre2-8-0 zlib1g openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY --from=git /out/usr/local/ /usr/local/

# Node as CI runs it (.node-version), from nodejs.org's tarball checked by the
# sha256 its SHASUMS256.txt gives; pnpm as the repository names it
# (packageManager).
ARG NODE_VERSION=22.22.3
ARG NODE_SHA256=2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
 && rm /tmp/node.tar.xz
RUN npm install -g pnpm@11.18.0 && npm cache clean --force

# The sandbox runtime, as its own image lays it out: the server, and the
# fuse-overlayfs its backups restore through (noble's 1.13 has the EEXIST
# fault the runtime's image pins 1.18 to avoid). The server reads its version
# from SANDBOX_VERSION. No code interpreter is used, so its pools stay empty.
COPY --from=docker.io/cloudflare/sandbox:0.12.10 /container-server /container-server
COPY --from=docker.io/cloudflare/sandbox:0.12.10 /usr/bin/fuse-overlayfs /usr/bin/fuse-overlayfs
RUN sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf \
 && ln -sf /proc/mounts /etc/mtab \
 && mkdir -p /workspace
ENV SANDBOX_VERSION=0.12.10 PYTHON_POOL_MIN_SIZE=0 JAVASCRIPT_POOL_MIN_SIZE=0 TYPESCRIPT_POOL_MIN_SIZE=0

# The toolchain a deps build is made with, in one line: node, pnpm and the
# base, since a native module built against another libc is another bundle.
# The deps box reports it and the pointer records it: a build from a box that
# says another toolchain is never kept. A unit test holds this line, the node
# and pnpm above and the base to core's DEPS_TOOLCHAIN ([image.toolchain]).
RUN echo "node $(node --version) pnpm $(pnpm --version) ubuntu $(. /etc/os-release && echo "$VERSION_ID")" > /etc/keel-toolchain

WORKDIR /container-server
EXPOSE 3000
ENTRYPOINT ["/container-server/sandbox"]
