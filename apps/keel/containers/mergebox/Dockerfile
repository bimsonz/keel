# The image of MergeBox (Tier 2): git alone, which composes the batches
# GitCore refuses with its own merge-tree. The box has no credential and no
# way out but the Artifacts host, through the Worker's egress, which adds a
# fresh token to each request; the platform's HTTPS intercept CA is added to
# its trust at start, so only ca-certificates is needed beside git.
#
# Debian 13 (trixie) slim, pinned by its index digest, for git 2.47:
# `merge-tree --write-tree --merge-base` needs 2.40 or later. bash, coreutils
# and findutils, which the compose and check scripts use, are in the base.
FROM --platform=linux/amd64 docker.io/library/debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /root
# exec() starts every command; the main process only keeps the box up.
ENTRYPOINT []
CMD ["sleep", "infinity"]
