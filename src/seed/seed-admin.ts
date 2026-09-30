// USR-7: idempotent admin seed script.
//
// Bootstraps an ADMIN user so a fresh database can immediately hit admin-only
// endpoints (product CRUD, order ship/deliver, …). Credentials come from env
// vars — no dev-friendly default that could accidentally ship to production.
//
// Idempotency rules:
//   - Missing user  → create it with role=ADMIN.
//   - Existing CUSTOMER on that email → promote to ADMIN, leave password alone.
//   - Existing ADMIN → no-op.
// The password is NEVER overwritten on re-run: if you need to rotate it, do
// that through the normal auth flow (or wipe the row manually first). This
// keeps `npm run seed:admin` safe to re-invoke from a Makefile, CI job or
// docker-entrypoint without silently changing production credentials.
//
// The `user.registered` outbox event is deliberately NOT emitted here. The seed
// is out-of-band bootstrap, not a real registration — we don't want a welcome
// email fired at the operator, and Kafka may not even be up at seed time.
//
// Usage (env vars required at invocation time):
//   ADMIN_EMAIL=admin@example.com \
//   ADMIN_PASSWORD=<>=12-char passphrase> \
//   npm run seed:admin
//
// `npm run seed:admin` invokes `scripts/seed-admin.js`, a tiny cross-platform
// launcher that calls `process.loadEnvFile('.env')` (Node ≥ 21.7 built-in — no
// dotenv dependency), registers ts-node in transpile-only mode with an
// explicit rootDir, then imports `main` from this file. The seed module also
// lands in the Docker image at `dist/seed/seed-admin.js`, reachable via
// `docker exec user-service node dist/seed/seed-admin.js` once the env vars
// are set on the container.

import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import { hashPassword } from '../user/password.util';

const AdminEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  ADMIN_EMAIL: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  ADMIN_PASSWORD: z.string().min(12).max(128),
  ADMIN_FIRST_NAME: z.string().trim().min(1).max(100).default('Admin'),
  ADMIN_LAST_NAME: z.string().trim().min(1).max(100).default('User'),
});

// Normalised shape consumed by seedAdmin. Kept separate from the env schema so
// the function reads like domain code (`input.email`, `input.password`) rather
// than shouting env-var names, and tests can construct an input literal without
// mentioning process.env at all.
export interface AdminSeedInput {
  databaseUrl: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export type AdminSeedOutcome =
  | { action: 'created'; userId: string; email: string }
  | { action: 'promoted'; userId: string; email: string }
  | { action: 'unchanged'; userId: string; email: string };

// Prisma client is passed in so tests can supply a mock without spinning up a DB.
// The runtime bootstrap below constructs a real client with the pg adapter.
export async function seedAdmin(
  prisma: Pick<PrismaClient, 'user'>,
  input: AdminSeedInput,
): Promise<AdminSeedOutcome> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });

  if (!existing) {
    const passwordHash = await hashPassword(input.password);
    const created = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        role: Role.ADMIN,
      },
    });
    return { action: 'created', userId: created.id, email: created.email };
  }

  if (existing.role !== Role.ADMIN) {
    const promoted = await prisma.user.update({
      where: { id: existing.id },
      data: { role: Role.ADMIN },
    });
    return { action: 'promoted', userId: promoted.id, email: promoted.email };
  }

  return { action: 'unchanged', userId: existing.id, email: existing.email };
}

export function parseEnv(raw: NodeJS.ProcessEnv): AdminSeedInput {
  const parsed = AdminEnvSchema.safeParse({
    DATABASE_URL: raw.DATABASE_URL,
    ADMIN_EMAIL: raw.ADMIN_EMAIL,
    ADMIN_PASSWORD: raw.ADMIN_PASSWORD,
    ADMIN_FIRST_NAME: raw.ADMIN_FIRST_NAME,
    ADMIN_LAST_NAME: raw.ADMIN_LAST_NAME,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Invalid admin seed environment:\n  ${issues}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    email: parsed.data.ADMIN_EMAIL,
    password: parsed.data.ADMIN_PASSWORD,
    firstName: parsed.data.ADMIN_FIRST_NAME,
    lastName: parsed.data.ADMIN_LAST_NAME,
  };
}

export async function main(): Promise<void> {
  const input = parseEnv(process.env);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: input.databaseUrl }),
  });
  try {
    await prisma.$connect();
    const outcome = await seedAdmin(prisma, input);
    switch (outcome.action) {
      case 'created':
        // eslint-disable-next-line no-console
        console.log(`[seed-admin] created admin ${outcome.email} (id=${outcome.userId})`);
        break;
      case 'promoted':
        // eslint-disable-next-line no-console
        console.log(
          `[seed-admin] promoted existing user ${outcome.email} (id=${outcome.userId}) to ADMIN`,
        );
        break;
      case 'unchanged':
        // eslint-disable-next-line no-console
        console.log(
          `[seed-admin] admin ${outcome.email} already present (id=${outcome.userId}); no changes`,
        );
        break;
    }
  } finally {
    await prisma.$disconnect();
  }
}

// `main` is exported so the JS launcher (`scripts/seed-admin.js`) can call it
// after registering ts-node. Tests import `seedAdmin` and `parseEnv` directly
// and never invoke `main`, so no DB connection is opened during unit tests.
