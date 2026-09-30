# user-service

User management microservice for the ecom platform. Exposes a **gRPC** API on `:5001` and an internal HTTP **health** endpoint on `:8081`. Data lives in **PostgreSQL** via **Prisma**.

## Responsibilities

- User registration (argon2 password hashing) — *USR-4*
- Authentication: RS256 access + rotating refresh tokens — *USR-5*
- Address CRUD (per-user, with default address) — *USR-6*
- Publishes `user.registered` events via transactional outbox to Kafka — *USR-4 / USR-8*

## Status

`USR-1` **done** — NestJS gRPC microservice scaffold, Prisma bootstrap, Dockerfile. All RPCs return `UNIMPLEMENTED`; models, migrations and business logic land in `USR-2` onward.

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

| Script | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` (runs `prisma generate` first) |
| `npm run start` | Run `dist/main.js` |
| `npm run start:dev` | Watch-free ts-node runner |
| `npm run prisma:migrate:dev` | Create + apply a new migration locally |
| `npm run prisma:migrate:deploy` | Apply pending migrations (used in container start, USR-3) |
| `npm run seed:admin` | Idempotent admin bootstrap (USR-7) — see below |
| `npm run lint` / `format` | ESLint / Prettier |
| `npm test` | Jest unit tests |

## Admin seed (USR-7)

Bootstraps an `ADMIN` user so a fresh database can immediately call admin-only RPCs. Credentials come from environment variables (loaded from `.env` if present) — there is no built-in default so the script cannot accidentally create a well-known admin in production.

```bash
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD='a-very-strong-passphrase' \
npm run seed:admin
```

Behaviour is idempotent and non-destructive:

| Existing row | Result |
|---|---|
| none | creates the user with `role=ADMIN` |
| `role=CUSTOMER` on same email | promotes to `ADMIN`, keeps password |
| `role=ADMIN` already | no-op |

The script never overwrites an existing password and never emits the `user.registered` outbox event — this is out-of-band bootstrap, not a real registration.

## Environment

See `.env.example` for the full list. Notable variables:

| Variable | Default | Notes |
|---|---|---|
| `GRPC_PORT` | `5001` | Advertised as `user-service:5001` inside the compose network |
| `HTTP_PORT` | `8081` | Health only; not published to the host |
| `DATABASE_URL` | `postgresql://user_svc:changeme@localhost:5432/user_db?schema=public` | Matches `infra/.env` |
| `KAFKA_BROKERS` | `localhost:9092` | Wired in `USR-4` (outbox) |
