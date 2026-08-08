# KANAL — multi-target build. The api and worker images share the same deps,
# so the dependency layer is built once and reused (plan §18.4, §16.3).
#
# Targets:  api   (Fastify server,  KANAL_BIND default 127.0.0.1)
#           worker (all four worker roles in one process)
#
# Containers run as non-root uid 10001, read-only root fs, cap_drop: ALL
# (enforced in compose, mirrored here as the image-level USER).

# --- base: install pnpm, copy lockfile, install deps once ---
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH="$PNPM_HOME:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# --- deps: only the lockfile + workspace manifests, so the cache layer
# invalidates only when dependencies actually change. ---
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/adapters/core/package.json packages/adapters/core/package.json
COPY packages/adapters/telegram/package.json packages/adapters/telegram/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/prompts/package.json packages/prompts/package.json
COPY packages/sources/package.json packages/sources/package.json
COPY packages/otel/package.json packages/otel/package.json
COPY packages/safety/package.json packages/safety/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --ignore-scripts

# --- build: copy all sources, build the packages api+worker depend on ---
FROM deps AS build
COPY apps apps
COPY packages packages
COPY packs packs
RUN pnpm --filter @kanal/api... --filter @kanal/worker... run build

# --- runtime: minimal image, no build toolchain ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S kanal && adduser -S -G kanal -u 10001 kanal
COPY --from=build /app /app
USER kanal
# Read-only root fs is set in compose; this is the image-level fallback.

# --- api target ---
FROM runtime AS api
EXPOSE 3001
ENTRYPOINT ["node", "--enable-source-maps", "apps/api/dist/index.js"]

# --- worker target ---
FROM runtime AS worker
ENTRYPOINT ["node", "--enable-source-maps", "apps/worker/dist/index.js"]
