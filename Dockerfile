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
# base image. Because free-tier Chainguard doesn't keep point releases, the
# only way to move this pin forward is to re-resolve the tag to whatever
# digest it currently points at — see .github/dependabot.yml's docker
# ecosystem entry, which watches this Dockerfile for that.
#
# amd64 only, matching Dockerfile.alpine's current scope. Dockerfile.alpine
# is kept as a reference/fallback build; CI no longer builds it.
FROM cgr.dev/chainguard/node@sha256:3eb79c0858f6d4c565323e64ac2dc8f3f1e3a6e5e0097bbe379de4a96963312f AS deps
ARG TARGETARCH
WORKDIR /app
USER root
RUN apk add --no-cache build-base python3
COPY package.json package-lock.json ./
COPY scripts/prune-runtime-deps.mjs scripts/
RUN npm ci --omit=dev \
 && node scripts/prune-runtime-deps.mjs node_modules --arch=${TARGETARCH} \
 && npm cache clean --force

FROM cgr.dev/chainguard/node@sha256:3eb79c0858f6d4c565323e64ac2dc8f3f1e3a6e5e0097bbe379de4a96963312f AS build
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

FROM cgr.dev/chainguard/node@sha256:1f903d44fc11a6f6e74447fc2c6a3c141f112217576be5d96c283210116b5d25 AS runtime
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
