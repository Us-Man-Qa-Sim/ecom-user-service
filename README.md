# user-service

User management microservice for the ecom platform. Exposes a gRPC API. Stores data in PostgreSQL via Prisma.

## Responsibilities

- User registration (argon2 password hashing)
- Authentication: RS256 access + rotating refresh tokens
- Address CRUD (per-user, with default address)
- Publishes `user.registered` events via transactional outbox to Kafka

## Development

```bash
npm install
npx prisma migrate dev
npm run start:dev
```

## Environment

See `.env.example` for required configuration.
