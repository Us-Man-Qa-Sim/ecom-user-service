import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Prisma, User as PrismaUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { RegisterInput, RegisterInputSchema } from './dto/register.dto';

// argon2id with OWASP 2024 second-choice params (memoryCost: 19 MiB → 47 MiB).
// A dedicated worker pool inside the argon2 native binding keeps the event loop
// unblocked; each hash still costs ~100 ms of CPU, which is the point.
const ARGON2_OPTS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 47104,
  timeCost: 1,
  parallelism: 1,
};

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async getById(userId: string): Promise<PrismaUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: 'User not found',
      });
    }
    return user;
  }

  async register(raw: unknown): Promise<PrismaUser> {
    const input = this.parseRegisterInput(raw);
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTS);

    try {
      // User row + outbox row commit atomically. Losing the outbox insert would
      // silently drop `user.registered`; committing without the user row would
      // publish a phantom event. One transaction rules out both.
      return await this.prisma.$transaction(async (tx) => {
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
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new RpcException({
          code: GrpcStatus.ALREADY_EXISTS,
          message: 'A user with this email already exists',
        });
      }
      this.logger.error({ err }, 'Failed to register user');
      throw err;
    }
  }

  private parseRegisterInput(raw: unknown): RegisterInput {
    const parsed = RegisterInputSchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `Invalid Register request: ${message}`,
      });
    }
    return parsed.data;
  }
}
