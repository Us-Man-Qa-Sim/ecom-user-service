# syntax=docker/dockerfile:1.7

# ── Stage 1: build ──
FROM node:24.21.0-alpine AS build
WORKDIR /app

# Toolchain needed by node-gyp for native deps (e.g. argon2 added in USR-4).
RUN apk add --no-cache python3 make g++ openssl

COPY package.json package-lock.json* .npmrc ./
RUN npm ci

COPY prisma.config.ts ./
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Prune dev deps for the runtime layer. `prisma` is a prod dep (USR-3) so the
# migrate CLI survives the prune and can run on container start.
RUN npm prune --omit=dev

# ── Stage 2: runtime ──
FROM node:24.21.0-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache openssl \
 && addgroup -S app -g 1001 \
 && adduser  -S app -G app -u 1001

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --chown=app:app docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER app

EXPOSE 5001 8081

# /health pings Postgres via Prisma. busybox wget ships with alpine, so no
# extra package is needed. start-period covers `prisma migrate deploy`.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${HTTP_PORT:-8081}/health" || exit 1

# USR-3: entrypoint applies pending migrations (`prisma migrate deploy`) then
# execs the app so Node receives signals directly.
ENTRYPOINT ["./docker-entrypoint.sh"]
