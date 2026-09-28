import { randomUUID } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Prisma, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import { UserService } from '../src/user/user.service';
import { OutboxService } from '../src/outbox/outbox.service';
import type { PrismaService } from '../src/prisma/prisma.service';

interface CreatedUserRow {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

// Minimal fake TransactionClient — only the methods UserService touches.
function makeTx() {
  const create = jest.fn<Promise<CreatedUserRow>, [Prisma.UserCreateArgs]>();
  return {
    tx: { user: { create } } as unknown as Prisma.TransactionClient,
    create,
  };
}

function makePrisma(): {
  service: PrismaService;
  transaction: jest.Mock;
} {
  const transaction = jest.fn();
  return {
    service: { $transaction: transaction } as unknown as PrismaService,
    transaction,
  };
}

const validInput = {
  email: 'Alice@Example.com',
  password: 'a-very-strong-passphrase',
  firstName: '  Alice  ',
  lastName: 'Doe',
};

describe('UserService.register', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let outbox: OutboxService;
  let service: UserService;

  beforeEach(() => {
    prisma = makePrisma();
    outbox = new OutboxService();
    jest.spyOn(outbox, 'enqueue').mockResolvedValue(undefined);
    service = new UserService(prisma.service, outbox);
  });

  it('rejects a bad payload with INVALID_ARGUMENT', async () => {
    await expect(service.register({ email: 'nope', password: 'short' })).rejects.toMatchObject({
      error: { code: GrpcStatus.INVALID_ARGUMENT },
    });
    expect(prisma.transaction).not.toHaveBeenCalled();
  });

  it('hashes the password with argon2id, writes the user, and enqueues user.registered', async () => {
    const { tx, create } = makeTx();
    const now = new Date('2026-09-28T12:00:00Z');
    create.mockResolvedValue({
      id: randomUUID(),
      email: 'alice@example.com',
      passwordHash: 'placeholder',
      firstName: 'Alice',
      lastName: 'Doe',
      role: Role.CUSTOMER,
      createdAt: now,
      updatedAt: now,
    });
    prisma.transaction.mockImplementation(async (fn) => fn(tx));

    const user = await service.register(validInput);

    expect(user.email).toBe('alice@example.com');

    // Email normalised (lowercased + trimmed), names trimmed, password NOT stored plaintext.
    const createArgs = create.mock.calls[0][0]!.data as Prisma.UserCreateInput;
    expect(createArgs.email).toBe('alice@example.com');
    expect(createArgs.firstName).toBe('Alice');
    expect(createArgs.passwordHash).not.toBe(validInput.password);
    expect(createArgs.passwordHash.startsWith('$argon2id$')).toBe(true);
    await expect(argon2.verify(createArgs.passwordHash, validInput.password)).resolves.toBe(true);

    expect(outbox.enqueue).toHaveBeenCalledWith(tx, {
      aggregateType: 'User',
      aggregateId: user.id,
      topic: TOPICS.USER_REGISTERED,
      payload: {
        userId: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  });

  it('maps a duplicate-email violation to ALREADY_EXISTS', async () => {
    const { tx, create } = makeTx();
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['email'] },
      }),
    );
    prisma.transaction.mockImplementation(async (fn) => fn(tx));

    await expect(service.register(validInput)).rejects.toBeInstanceOf(RpcException);
    await expect(service.register(validInput)).rejects.toMatchObject({
      error: { code: GrpcStatus.ALREADY_EXISTS },
    });
  });
});
