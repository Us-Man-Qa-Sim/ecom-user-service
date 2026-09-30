import { randomUUID } from 'node:crypto';
import { Role, User } from '@prisma/client';
import { UserService } from '../src/user/user.service';
import { OutboxService } from '../src/outbox/outbox.service';
import { NotFoundError } from '../src/common/errors/domain-errors';
import type { PrismaService } from '../src/prisma/prisma.service';

function makePrisma(user?: User) {
  const findUnique = jest.fn(async ({ where }: { where: { id: string } }) => {
    if (!user) return null;
    return where.id === user.id ? user : null;
  });
  return {
    prisma: { user: { findUnique } } as unknown as PrismaService,
    findUnique,
  };
}

describe('UserService.getById', () => {
  const outbox = new OutboxService();
  const seeded: User = {
    id: randomUUID(),
    email: 'alice@example.com',
    passwordHash: '$argon2id$whatever',
    firstName: 'Alice',
    lastName: 'Doe',
    role: Role.CUSTOMER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('returns the row when the id matches', async () => {
    const { prisma, findUnique } = makePrisma(seeded);
    const service = new UserService(prisma, outbox);
    await expect(service.getById(seeded.id)).resolves.toBe(seeded);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: seeded.id } });
  });

  it('throws NotFoundError when the id does not match', async () => {
    const { prisma } = makePrisma(seeded);
    const service = new UserService(prisma, outbox);
    await expect(service.getById(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError for a non-UUID id without querying the database', async () => {
    const { prisma, findUnique } = makePrisma(seeded);
    const service = new UserService(prisma, outbox);
    await expect(service.getById('not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.getById('')).rejects.toBeInstanceOf(NotFoundError);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
