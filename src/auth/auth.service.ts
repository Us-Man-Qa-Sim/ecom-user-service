import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, User as PrismaUser } from '@prisma/client';
import * as argon2 from 'argon2';
import type { ZodType } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { UnauthenticatedError, ValidationError } from '../common/errors/domain-errors';
import { hashRefreshToken, JwtService, MintedAccessToken, MintedRefreshToken } from './jwt.service';
import { LoginInputSchema, LogoutInputSchema, RefreshInputSchema } from './dto/login.dto';
import { hashPassword } from '../user/password.util';

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
  private dummyHashPromise?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(raw: unknown): Promise<LoginResult> {
    const input = parseInput(LoginInputSchema, raw, 'Login');

    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    // Same error whether the email is unknown or the password is wrong: a
    // distinct "no such user" message would let an attacker enumerate accounts.
    // For the same reason an unknown email still pays for one argon2 verify —
    // otherwise the ~100 ms hash cost makes "no such user" measurably faster.
    const passwordOk = user
      ? await argon2.verify(user.passwordHash, input.password)
      : await argon2.verify(await this.dummyHash(), input.password).then(() => false);
    if (!user || !passwordOk) {
      throw new UnauthenticatedError('Invalid email or password');
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
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<{ reused: true } | { reused: false; tokens: IssuedTokens }> => {
        const existing = await tx.refreshToken.findUnique({
          where: { tokenHash: presentedHash },
          include: { user: true },
        });

        if (!existing) {
          throw new UnauthenticatedError('Refresh token not recognised');
        }

        if (existing.revokedAt) {
          // Reuse detection: someone presented an already-rotated token. Either
          // the legitimate holder is replaying an old response, or the token was
          // stolen. In both cases the safe move is to burn the family — the
          // attacker loses access and the legitimate user is forced to log in.
          // We must NOT throw inside the callback: Prisma rolls the interactive
          // transaction back on throw, which would undo the family revocation.
          // Return a marker instead, let the tx commit, then throw below.
          await tx.refreshToken.updateMany({
            where: { family: existing.family, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          this.logger.warn(
            { userId: existing.userId, family: existing.family },
            'Refresh token reuse detected; revoking family',
          );
          return { reused: true };
        }

        if (existing.expiresAt.getTime() <= Date.now()) {
          throw new UnauthenticatedError('Refresh token expired');
        }

        await tx.refreshToken.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() },
        });

        return {
          reused: false,
          tokens: await this.issueTokens(existing.user, existing.family, tx),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (outcome.reused) {
      throw new UnauthenticatedError('Refresh token reuse detected');
    }
    return { tokens: outcome.tokens };
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

  // Hashed lazily with the production cost params so the unknown-email path
  // costs the same as a real verify. Computed once per process.
  private dummyHash(): Promise<string> {
    this.dummyHashPromise ??= hashPassword(randomUUID());
    return this.dummyHashPromise;
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
    throw new ValidationError(`Invalid ${rpc} request: ${message}`);
  }
  return parsed.data;
}
