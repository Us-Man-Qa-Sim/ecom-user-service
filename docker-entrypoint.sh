#!/bin/sh
# USR-3: apply pending Prisma migrations before starting the service.
# `prisma migrate deploy` is idempotent — running it on every container start
# means a fresh DB gets the full history, and a warm DB is a no-op.
# We fail fast if migrations fail rather than start with a stale schema.
# `exec` replaces the shell so Node receives SIGTERM directly and can shut down.
set -e

echo "[entrypoint] applying database migrations..."
node ./node_modules/prisma/build/index.js migrate deploy

echo "[entrypoint] starting user-service..."
exec node dist/main.js
