import { Injectable } from '@nestjs/common';
import { User as PrismaUser } from '@prisma/client';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { NotFoundError, ValidationError } from '../common/errors/domain-errors';
import { RegisterInput, RegisterInputSchema } from './dto/register.dto';
import { hashPassword } from './password.util';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async getById(userId: string): Promise<PrismaUser> {
    // `users.id` is a Postgres UUID column: querying it with a non-UUID string
    // raises a driver error that would surface as INTERNAL. Such an id cannot
    // exist, so answer NOT_FOUND without touching the database.
    if (!z.uuid().safeParse(userId).success) {
      throw new NotFoundError('User not found');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('User not found');
    }
    return user;
  }

  async register(raw: unknown): Promise<PrismaUser> {
    const input = this.parseRegisterInput(raw);
    const passwordHash = await hashPassword(input.password);

    // User row + outbox row commit atomically. Losing the outbox insert would
    // silently drop `user.registered`; committing without the user row would
    // publish a phantom event. One transaction rules out both. A duplicate
    // email surfaces as Prisma P2002, which the global GrpcExceptionFilter
    // maps to ALREADY_EXISTS — no service-level catch needed here.
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
        },
      });

      await this.outbox.enqueue(tx, {
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

      return user;
    });
  }

  private parseRegisterInput(raw: unknown): RegisterInput {
    const parsed = RegisterInputSchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new ValidationError(`Invalid Register request: ${message}`);
    }
    return parsed.data;
  }
}
