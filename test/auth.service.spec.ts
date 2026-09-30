import { randomUUID } from 'node:crypto';
import { RefreshToken, Role, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from '../src/auth/auth.service';
import { hashRefreshToken, JwtService } from '../src/auth/jwt.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  UnauthenticatedError,
  ValidationError,
} from '../src/common/errors/domain-errors';

interface RefreshRow extends RefreshToken {
  user?: User;
}

// A minimal, mutable in-memory store just for the tests below. Only the
// operations AuthService actually performs are modelled.
function makeStore() {
  const users = new Map<string, User>();
  const usersByEmail = new Map<string, User>();
  const refreshes = new Map<string, RefreshRow>(); // by id
  const refreshesByHash = new Map<string, RefreshRow>();

  return {
    users,
    usersByEmail,
    refreshes,
    refreshesByHash,
    seedUser(user: User) {
      users.set(user.id, user);
      usersByEmail.set(user.email, user);
    },
  };
}

function makePrisma(store: ReturnType<typeof makeStore>): PrismaService {
  const refreshTokenApi = {
    findUnique: jest.fn(async ({ where, include }: any) => {
      const found = where.tokenHash
        ? store.refreshesByHash.get(where.tokenHash)
        : store.refreshes.get(where.id);
      if (!found) return null;
      if (include?.user) {
        return { ...found, user: store.users.get(found.userId)! };
      }
      return found;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = store.refreshes.get(where.id);
      if (!row) throw new Error('row missing');
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of store.refreshes.values()) {
        if (where.tokenHash && row.tokenHash !== where.tokenHash) continue;
        if (where.family && row.family !== where.family) continue;
        if (where.revokedAt === null && row.revokedAt !== null) continue;
        Object.assign(row, data);
        count++;
      }
      return { count };
    }),
    create: jest.fn(async ({ data }: any) => {
      const row: RefreshRow = {
        id: randomUUID(),
        userId: data.userId,
        tokenHash: data.tokenHash,
        family: data.family,
        expiresAt: data.expiresAt,
        revokedAt: null,
        createdAt: new Date(),
      };
      store.refreshes.set(row.id, row);
      store.refreshesByHash.set(row.tokenHash, row);
      return row;
    }),
  };

  const userApi = {
    findUnique: jest.fn(async ({ where }: any) => {
      if (where.email) return store.usersByEmail.get(where.email) ?? null;
      return store.users.get(where.id) ?? null;
    }),
  };

  return {
    refreshToken: refreshTokenApi,
    user: userApi,
    $transaction: async (fn: any) => fn({ refreshToken: refreshTokenApi, user: userApi }),
  } as unknown as PrismaService;
}

function makeJwtService(): JwtService {
  const jwt = {
    signAccessToken: jest.fn(async (claims: any) => ({
      token: `access.${claims.sub}.${Date.now()}`,
      expiresAt: new Date(Date.now() + 900_000),
      ttlSeconds: 900,
    })),
    mintRefreshToken: jest.fn(() => {
      const token = randomUUID().replace(/-/g, '');
      return {
        token,
        tokenHash: hashRefreshToken(token),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      };
    }),
    accessTtl: 900,
    refreshTtl: 30 * 86_400,
  } as unknown as JwtService;
  return jwt;
}

async function seededUser(store: ReturnType<typeof makeStore>, password: string): Promise<User> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 1, parallelism: 1 });
  const user: User = {
    id: randomUUID(),
    email: 'alice@example.com',
    passwordHash,
    firstName: 'Alice',
    lastName: 'Doe',
    role: Role.CUSTOMER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  store.seedUser(user);
  return user;
}

describe('AuthService', () => {
  let store: ReturnType<typeof makeStore>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let auth: AuthService;

  beforeEach(() => {
    store = makeStore();
    prisma = makePrisma(store);
    jwt = makeJwtService();
    auth = new AuthService(prisma, jwt);
  });

  describe('login', () => {
    it('rejects unknown email with UnauthenticatedError', async () => {
      await expect(
        auth.login({ email: 'nobody@example.com', password: 'irrelevant' }),
      ).rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it('rejects a wrong password with UnauthenticatedError', async () => {
      await seededUser(store, 'correct-horse-battery-staple');
      await expect(
        auth.login({ email: 'alice@example.com', password: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it('issues access + refresh tokens on success', async () => {
      const user = await seededUser(store, 'correct-horse-battery-staple');
      const result = await auth.login({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
      });
      expect(result.user.id).toBe(user.id);
      expect(result.tokens.access.token).toContain(user.id);
      expect(result.tokens.refresh.token).toBeTruthy();
      expect(store.refreshes.size).toBe(1);
      const row = store.refreshes.values().next().value!;
      expect(row.tokenHash).toBe(hashRefreshToken(result.tokens.refresh.token));
      expect(row.revokedAt).toBeNull();
    });

    it('rejects a malformed request with ValidationError', async () => {
      await expect(auth.login({ email: 'not-email', password: 'x' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token and returns fresh tokens', async () => {
      await seededUser(store, 'pw-pw-pw-pw-pw-pw');
      const login = await auth.login({ email: 'alice@example.com', password: 'pw-pw-pw-pw-pw-pw' });
      const oldToken = login.tokens.refresh.token;

      const refreshed = await auth.refresh({ refreshToken: oldToken });

      expect(refreshed.tokens.refresh.token).not.toBe(oldToken);
      // Original row is revoked, new one is live.
      const oldRow = store.refreshesByHash.get(hashRefreshToken(oldToken))!;
      expect(oldRow.revokedAt).not.toBeNull();
      const newRow = store.refreshesByHash.get(hashRefreshToken(refreshed.tokens.refresh.token))!;
      expect(newRow.revokedAt).toBeNull();
      expect(newRow.family).toBe(oldRow.family);
    });

    it('detects reuse and revokes the whole family', async () => {
      await seededUser(store, 'pw-pw-pw-pw-pw-pw');
      const login = await auth.login({ email: 'alice@example.com', password: 'pw-pw-pw-pw-pw-pw' });
      const oldToken = login.tokens.refresh.token;
      const refreshed = await auth.refresh({ refreshToken: oldToken });

      // Replay the already-rotated token → reuse detection.
      await expect(auth.refresh({ refreshToken: oldToken })).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );

      // Every row in the family, including the one issued by refresh, is revoked.
      for (const row of store.refreshes.values()) {
        expect(row.revokedAt).not.toBeNull();
      }
      // And the "new" token can no longer be used either.
      await expect(
        auth.refresh({ refreshToken: refreshed.tokens.refresh.token }),
      ).rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it('rejects an unknown refresh token', async () => {
      await expect(auth.refresh({ refreshToken: 'not-a-known-token' })).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });

    it('rejects an expired refresh token', async () => {
      const user = await seededUser(store, 'pw-pw-pw-pw-pw-pw');
      // Manually seed a live-but-expired row.
      const token = 'expired-token-abc';
      const row = {
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashRefreshToken(token),
        family: randomUUID(),
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: null,
        createdAt: new Date(),
      };
      store.refreshes.set(row.id, row);
      store.refreshesByHash.set(row.tokenHash, row);

      await expect(auth.refresh({ refreshToken: token })).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });
  });

  describe('logout', () => {
    it('revokes a live refresh token', async () => {
      await seededUser(store, 'pw-pw-pw-pw-pw-pw');
      const login = await auth.login({ email: 'alice@example.com', password: 'pw-pw-pw-pw-pw-pw' });
      await auth.logout({ refreshToken: login.tokens.refresh.token });
      const row = store.refreshesByHash.get(hashRefreshToken(login.tokens.refresh.token))!;
      expect(row.revokedAt).not.toBeNull();
    });

    it('is a no-op on an unknown token (idempotent)', async () => {
      await expect(auth.logout({ refreshToken: 'unknown' })).resolves.toBeUndefined();
    });

    it('rejects a malformed request', async () => {
      await expect(auth.logout({ refreshToken: '' })).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

