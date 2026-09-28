# syntax=docker/dockerfile:1.7

# ── Stage 1: build ──
FROM node:24.21.0-alpine AS build
WORKDIR /app

# Toolchain needed by node-gyp for native deps (e.g. argon2 added in USR-4).
RUN apk add --no-cache python3 make g++ openssl

COPY package.json package-lock.json* .npmrc ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Prune dev deps for the runtime layer.
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
COPY --from=build --chown=app:app /app/package.json ./package.json

USER app

EXPOSE 5001 8081

# USR-3 will swap CMD to `sh -c "npx prisma migrate deploy && node dist/main.js"`.
CMD ["node", "dist/main.js"]
