# syntax=docker/dockerfile:1
#
# Chainguard's Wolfi-based node image, not Alpine. Wolfi is glibc, not musl,
# so this rebuilds native deps (better-sqlite3, argon2) on a glibc base end
# to end rather than mixing an Alpine builder with a glibc runtime, which
# would ship musl-linked .node binaries into a glibc image.
#
# Chainguard's default `node` tag ships no shell/apk (only enough busybox for
# COPY-time RUN like mkdir); `node:latest-dev` adds apk + a build toolchain.
# Free-tier Chainguard only tracks `latest`/`latest-dev`, not pinned point
# releases, so there is no equivalent of Dockerfile.alpine's
# ARG NODE_VERSION=26.8.2-alpine pin here.
#
# Both stages below are pinned to the digest `latest-dev`/`latest` resolved
# to on 2026-09-21 (`docker buildx imagetools inspect cgr.dev/chainguard/node:latest-dev`),
# rather than the floating tag, so a rebuild doesn't silently pick up a new
# base image. Renovate (renovate.json) refreshes the pin itself on every run
# regardless of the `pinDigests: false` packageRule there — that rule only
# stops it converting a floating *tag* to a digest, and every FROM here is
# already a digest with no tag.
#
# The tag stays in the reference (`:latest-dev@sha256:...`, not bare
# `@sha256:...`) so Renovate can tell these two stages apart from the
# `runtime` stage below: with no tag, a bare `image@sha256:...` reference is
# ambiguous about which of Chainguard's tags it was resolved from, and
# Renovate silently treated all three FROM lines as tracking `latest` — the
# no-apk image — clobbering these two dev pins with that digest instead of
# `latest-dev`'s (#462's break).
#
# amd64 only, matching Dockerfile.alpine's current scope. Dockerfile.alpine
# is kept as a reference/fallback build; CI no longer builds it.
FROM cgr.dev/chainguard/node:latest-dev@sha256:ea7d0133c47e062b7754da987c05d4d1206e0a9e357a49679271d071f48e65e2 AS deps
ARG TARGETARCH
WORKDIR /app
USER root
RUN apk add --no-cache build-base python3
COPY package.json package-lock.json ./
COPY scripts/prune-runtime-deps.mjs scripts/
RUN npm ci --omit=dev \
 && node scripts/prune-runtime-deps.mjs node_modules --arch=${TARGETARCH} \
 && npm cache clean --force

FROM cgr.dev/chainguard/node:latest-dev@sha256:ea7d0133c47e062b7754da987c05d4d1206e0a9e357a49679271d071f48e65e2 AS build
WORKDIR /app
USER root
RUN apk add --no-cache build-base python3
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# Runtime stage has no shell, so the /data dir is created here and copied
# over rather than via RUN mkdir in the final stage.
#
# UID 1000, not the base image's nonroot `node` (65532): existing /data volumes
# from the alpine image (node:alpine's `node` user is 1000) would otherwise be
# unwritable after switching images. No /etc/passwd entry is needed for this —
# Docker accepts a bare numeric USER/--chown.
RUN mkdir -p /data && chown -R 1000:1000 /data

FROM cgr.dev/chainguard/node:latest@sha256:3d462c24088fa9189404fc19b837f6b39636671571491c9c5dd7b75e3e2df550 AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/balancr.db \
    ACTUAL_DATA_DIR=/data/actual
WORKDIR /app

COPY --chown=1000:1000 --from=deps /app/node_modules ./node_modules
COPY --chown=1000:1000 --from=build /app/dist ./dist
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 CHANGELOG.md ./
COPY --chown=1000:1000 config ./config
COPY --chown=1000:1000 --from=build /data /data

VOLUME ["/data"]
# Numeric, not the base image's nonroot `node` (65532) — see the /data comment
# in the build stage above.
USER 1000:1000
EXPOSE 3000

ARG BALANCR_REVISION=""
ENV BALANCR_REVISION=${BALANCR_REVISION}

# Exec form, not shell form: this image has no /bin/sh to interpret a shell-form CMD.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/usr/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Base image's ENTRYPOINT is already /usr/bin/node, so CMD is just the script.
CMD ["dist/main.js"]
