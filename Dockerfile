# syntax=docker/dockerfile:1
#
# Multi-stage so the toolchain that compiles the native modules never reaches
# the runtime image. Three stages instead of two because production dependencies
# are installed separately from the build ones: `npm ci --omit=dev` in its own
# layer is what keeps the final image close to base-image size.
#
# amd64 only for now — that is what the target host runs, and cross-building the
# native modules (better-sqlite3, argon2) for arm64 doubles CI time for nothing.
ARG NODE_VERSION=26.8.1-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# better-sqlite3 and argon2 publish musl prebuilds, but a release without one
# would otherwise fail the build outright; the toolchain is the cheap insurance.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY scripts/prune-runtime-deps.mjs scripts/
# `--omit=dev` is not enough on its own — see scripts/prune-runtime-deps.mjs for
# what it leaves behind and why none of it can run here.
RUN npm ci --omit=dev \
 && node scripts/prune-runtime-deps.mjs \
 && npm cache clean --force

FROM node:${NODE_VERSION} AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Compiles the server and (once it exists) bundles the SPA. Migrations and i18n
# catalogues are copied into dist by scripts/copy-assets.mjs — tsc emits only JS.
RUN npm run build

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/balancr.db \
    ACTUAL_DATA_DIR=/data/actual
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The image runs with a read-only root filesystem (see compose.yaml), so /data is
# the only writable path: SQLite plus Actual's local sync cache.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
