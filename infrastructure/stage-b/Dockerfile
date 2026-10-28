# Dependency-only rootfs is prepared from the explicit local allowlist.
FROM scratch
COPY rootfs /
ENV PATH=/usr/bin:/bin HOME=/home/node LANG=C.UTF-8
USER 1000:1000
WORKDIR /work/backend
