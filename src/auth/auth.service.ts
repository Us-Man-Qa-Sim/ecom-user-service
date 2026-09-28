import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Prisma, User as PrismaUser } from '@prisma/client';
import * as argon2 from 'argon2';
import type { ZodType } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { hashRefreshToken, JwtService, MintedAccessToken, MintedRefreshToken } from './jwt.service';
import {
  LoginInputSchema,
  LogoutInputSchema,
  RefreshInputSchema,
} from './dto/login.dto';

export interface IssuedTokens {
  access: MintedAccessToken;
  refresh: MintedRefreshToken;
}

export interface LoginResult {
  user: PrismaUser;
  tokens: IssuedTokens;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(raw: unknown): Promise<LoginResult> {
    const input = parseInput(LoginInputSchema, raw, 'Login');

    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    // Same error whether the email is unknown or the password is wrong: a
    // distinct "no such user" message would let an attacker enumerate accounts.
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
      throw unauthenticated('Invalid email or password');
    }

    const tokens = await this.issueTokens(user, randomUUID());
    return { user, tokens };
  }

  async refresh(raw: unknown): Promise<{ tokens: IssuedTokens }> {
    const input = parseInput(RefreshInputSchema, raw, 'RefreshToken');
    const presentedHash = hashRefreshToken(input.refreshToken);

    // Wrap the lookup + rotation in a serializable transaction so two concurrent
    // refreshes of the same token can't both succeed. The reuse check depends
    // on the row's revokedAt state; a repeatable-read view is not enough.
    const tokens = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.refreshToken.findUnique({
          where: { tokenHash: presentedHash },
          include: { user: true },
        });

        if (!existing) {
          throw unauthenticated('Refresh token not recognised');
        }

        if (existing.revokedAt) {
          // Reuse detection: someone presented an already-rotated token. Either
          // the legitimate holder is replaying an old response, or the token was
          // stolen. In both cases the safe move is to burn the family — the
          // attacker loses access and the legitimate user is forced to log in.
          await tx.refreshToken.updateMany({
            where: { family: existing.family, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          this.logger.warn(
            { userId: existing.userId, family: existing.family },
            'Refresh token reuse detected; revoking family',
          );
          throw unauthenticated('Refresh token reuse detected');
        }

        if (existing.expiresAt.getTime() <= Date.now()) {
          throw unauthenticated('Refresh token expired');
        }

        await tx.refreshToken.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() },
        });

        return this.issueTokens(existing.user, existing.family, tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return { tokens };
  }

  async logout(raw: unknown): Promise<void> {
    const input = parseInput(LogoutInputSchema, raw, 'Logout');
    const presentedHash = hashRefreshToken(input.refreshToken);

    // Idempotent: a repeated logout, or a logout with an unknown/expired token,
    // is not an error — the goal state (this refresh token cannot be used) is
    // already met. Only revoke a row that exists and is still live.
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: presentedHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(
    user: PrismaUser,
    family: string,
    tx?: Prisma.TransactionClient,
  ): Promise<IssuedTokens> {
    const client = tx ?? this.prisma;
    const access = await this.jwt.signAccessToken({
      sub: user.id,
      role: user.role,
      email: user.email,
    });
    const refresh = this.jwt.mintRefreshToken();
    await client.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refresh.tokenHash,
        family,
        expiresAt: refresh.expiresAt,
      },
    });
    return { access, refresh };
  }
}

function parseInput<T>(schema: ZodType<T>, raw: unknown, rpc: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: `Invalid ${rpc} request: ${message}`,
    });
  }
  return parsed.data;
}

function unauthenticated(message: string): RpcException {
  return new RpcException({ code: GrpcStatus.UNAUTHENTICATED, message });
}
