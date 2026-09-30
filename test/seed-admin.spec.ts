import { randomUUID } from 'node:crypto';
import { PrismaClient, Role, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { seedAdmin, parseEnv, AdminSeedInput } from '../src/seed/seed-admin';

type UserApi = Pick<PrismaClient, 'user'>;

function makePrisma(seedUser?: User): {
  prisma: UserApi;
  findUnique: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
} {
  let stored = seedUser ?? null;

  const findUnique = jest.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
    if (!stored) return null;
    if (where.email && where.email === stored.email) return stored;
    if (where.id && where.id === stored.id) return stored;
    return null;
  });
  const create = jest.fn(async ({ data }: any) => {
    const row: User = {
      id: randomUUID(),
      email: data.email,
      passwordHash: data.passwordHash,
      firstName: data.firstName,
      lastName: data.lastName,
      role: data.role ?? Role.CUSTOMER,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    stored = row;
    return row;
  });
  const update = jest.fn(async ({ where, data }: any) => {
    if (!stored || stored.id !== where.id) throw new Error('not found');
    stored = { ...stored, ...data, updatedAt: new Date() };
    return stored;
  });

  return {
    prisma: { user: { findUnique, create, update } } as unknown as UserApi,
    findUnique,
    create,
    update,
  };
}

const input: AdminSeedInput = {
  databaseUrl: 'postgresql://user_svc:changeme@localhost:5432/user_db?schema=public',
  email: 'admin@example.com',
  password: 'a-very-strong-passphrase',
  firstName: 'Admin',
  lastName: 'User',
};

describe('seedAdmin', () => {
  it('creates a new admin when the email is unknown, hashing the password with argon2id', async () => {
    const { prisma, create, update } = makePrisma();

    const outcome = await seedAdmin(prisma, input);

    expect(outcome.action).toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();

    const createArgs = create.mock.calls[0][0].data;
    expect(createArgs.email).toBe('admin@example.com');
    expect(createArgs.role).toBe(Role.ADMIN);
    expect(createArgs.passwordHash).not.toBe(input.password);
    expect(createArgs.passwordHash.startsWith('$argon2id$')).toBe(true);
    await expect(argon2.verify(createArgs.passwordHash, input.password)).resolves.toBe(true);
  });

  it('promotes an existing CUSTOMER to ADMIN without touching the password', async () => {
    const existing: User = {
      id: randomUUID(),
      email: input.email,
      passwordHash: '$argon2id$existing-hash-do-not-overwrite',
      firstName: 'Someone',
      lastName: 'Else',
      role: Role.CUSTOMER,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { prisma, create, update } = makePrisma(existing);

    const outcome = await seedAdmin(prisma, input);

    expect(outcome).toEqual({ action: 'promoted', userId: existing.id, email: existing.email });
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { role: Role.ADMIN },
    });
    // Crucially: no passwordHash in the update payload.
    expect(update.mock.calls[0][0].data.passwordHash).toBeUndefined();
  });

  it('is a no-op when the email already belongs to an ADMIN', async () => {
    const existing: User = {
      id: randomUUID(),
      email: input.email,
      passwordHash: '$argon2id$existing-hash',
      firstName: 'Admin',
      lastName: 'User',
      role: Role.ADMIN,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { prisma, create, update } = makePrisma(existing);

    const outcome = await seedAdmin(prisma, input);

    expect(outcome).toEqual({ action: 'unchanged', userId: existing.id, email: existing.email });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('parseEnv', () => {
  const validRaw = {
    DATABASE_URL: 'postgresql://user_svc:changeme@localhost:5432/user_db?schema=public',
    ADMIN_EMAIL: 'Admin@Example.COM',
    ADMIN_PASSWORD: 'a-very-strong-passphrase',
  };

  it('normalises env vars into camelCase, lowercases the email, and defaults names', () => {
    const input = parseEnv(validRaw);
    expect(input).toEqual({
      databaseUrl: validRaw.DATABASE_URL,
      email: 'admin@example.com',
      password: validRaw.ADMIN_PASSWORD,
      firstName: 'Admin',
      lastName: 'User',
    });
  });

  it('rejects missing required vars with a helpful error', () => {
    expect(() => parseEnv({ DATABASE_URL: validRaw.DATABASE_URL })).toThrow(/ADMIN_EMAIL/);
  });

  it('rejects a too-short password (12-char minimum matches Register)', () => {
    expect(() => parseEnv({ ...validRaw, ADMIN_PASSWORD: 'short' })).toThrow(/ADMIN_PASSWORD/);
  });
});
