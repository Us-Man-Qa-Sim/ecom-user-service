# user-service

User management microservice for the ecom platform. Exposes a **gRPC** API on `:5001` and an internal HTTP **health** endpoint on `:8081`. Data lives in **PostgreSQL** via **Prisma**.

## Responsibilities

- User registration (argon2 password hashing) — _USR-4_
- Authentication: RS256 access + rotating refresh tokens — _USR-5_
- Address CRUD (per-user, with default address) — _USR-6_
- Admin seed script — _USR-7_
- Publishes `user.registered` events via transactional outbox to Kafka — _USR-4 / USR-8_
- Maps domain errors to gRPC status codes via a global filter — _USR-9_

## Status

Phase 3 (`USR-1` → `USR-10`) **done** — every RPC in `ecom.user.v1.UserService` is implemented, migrations run on container start, `user.registered` is published through the outbox relay, and the image has a Docker `HEALTHCHECK` against `/health`.

## Prerequisites

- Node.js **24.21.0** (see `.nvmrc`)
- Docker Desktop (for infra services in `../infra`)
- The infra stack running: `cd ../infra && make up`

## Local development

```bash
cp .env.example .env
npm install
npx prisma generate
npm run start:dev
```

`start:dev` runs `src/main.ts` under `ts-node`. gRPC binds on `GRPC_PORT` (5001); the health endpoint is served on `HTTP_PORT` (8081):

```
GET http://localhost:8081/health
GET http://localhost:8081/health/live
```

## Docker

The image is built by `../infra/docker-compose.yml` under the `app` profile:

```bash
cd ../infra
docker compose --profile app up -d --build user-service
```

## Scripts

| Script                          | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `npm run build`                 | Compile TypeScript to `dist/` (runs `prisma generate` first) |
| `npm run start`                 | Run `dist/main.js`                                           |
| `npm run start:dev`             | Watch-free ts-node runner                                    |
| `npm run prisma:migrate:dev`    | Create + apply a new migration locally                       |
| `npm run prisma:migrate:deploy` | Apply pending migrations (used in container start, USR-3)    |
| `npm run seed:admin`            | Idempotent admin bootstrap (USR-7) — see below               |
| `npm run lint` / `format`       | ESLint / Prettier                                            |
| `npm test`                      | Jest unit tests                                              |

## Admin seed (USR-7)

Bootstraps an `ADMIN` user so a fresh database can immediately call admin-only RPCs. Credentials come from environment variables (loaded from `.env` if present) — there is no built-in default so the script cannot accidentally create a well-known admin in production.

```bash
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD='a-very-strong-passphrase' \
npm run seed:admin
```

Behaviour is idempotent and non-destructive:

| Existing row                  | Result                              |
| ----------------------------- | ----------------------------------- |
| none                          | creates the user with `role=ADMIN`  |
| `role=CUSTOMER` on same email | promotes to `ADMIN`, keeps password |
| `role=ADMIN` already          | no-op                               |

The script never overwrites an existing password and never emits the `user.registered` outbox event — this is out-of-band bootstrap, not a real registration.

## Environment

See `.env.example` for the full list. Notable variables:

| Variable                        | Default                                                               | Notes                                                        |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GRPC_PORT`                     | `5001`                                                                | Advertised as `user-service:5001` inside the compose network |
| `HTTP_PORT`                     | `8081`                                                                | Health only; not published to the host                       |
| `DATABASE_URL`                  | `postgresql://user_svc:changeme@localhost:5432/user_db?schema=public` | Matches `infra/.env`                                         |
| `KAFKA_BROKERS`                 | `localhost:9092`                                                      | Producer target for the outbox relay                         |
| `KAFKA_CLIENT_ID`               | `user-service`                                                        | Advertised to the broker for metrics/logs                    |
| `OUTBOX_RELAY_ENABLED`          | `true`                                                                | Set `false` in seed/admin one-off containers                 |
| `OUTBOX_RELAY_POLL_INTERVAL_MS` | `250`                                                                 | Delay between drain passes when the queue is quiet           |
| `OUTBOX_RELAY_BATCH_SIZE`       | `32`                                                                  | Rows claimed per transaction (short lock windows)            |
| `OUTBOX_RELAY_ERROR_BACKOFF_MS` | `5000`                                                                | Wait after a failed tick before retrying                     |

## Outbox relay (USR-8)

The relay lives in `src/outbox/outbox-relay.service.ts` and runs as an in-process scheduled loop. On each tick it opens a single Prisma transaction, runs

```sql
SELECT id, aggregate_id, event_type, payload, created_at
  FROM outbox
 WHERE sent_at IS NULL
 ORDER BY created_at
 LIMIT $batch
 FOR UPDATE SKIP LOCKED
```

publishes each row's envelope through the `Publisher` interface (Kafka producer with `idempotent=true`, `acks=all`), then marks the rows sent and commits. `SKIP LOCKED` means multiple pods can run the relay safely; if a publish fails the transaction rolls back and the row is picked up on the next pass (at-least-once — consumers dedupe on `eventId` via `processed_events`, per KFK plan). Reusable pattern — copy the file plus `src/kafka/publisher.ts` into order-service unchanged.

## Error mapping (USR-9)

Services throw transport-neutral `DomainError` subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `PermissionDeniedError`, `UnauthenticatedError`, `FailedPreconditionError`). `GrpcExceptionFilter` (bound to the gRPC `UserController` with `@UseFilters` — deliberately not global, so HTTP `/health` keeps Nest's default error handling and returns 503 instead of hanging) maps them to gRPC status codes, translates Prisma `P2002/P2025/P2003/P2034` and `ZodError` on the fly, and returns a scrubbed `INTERNAL` for anything unknown so ORM/DB text never reaches the caller.
