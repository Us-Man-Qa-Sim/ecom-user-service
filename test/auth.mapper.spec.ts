import { toProtoAuthTokens } from '../src/auth/auth.mapper';
import type { IssuedTokens } from '../src/auth/auth.service';

describe('toProtoAuthTokens', () => {
  it('surfaces both token strings and encodes access-token expiry as a Timestamp', () => {
    const expiresAt = new Date('2026-06-01T12:34:56.789Z');
    const issued: IssuedTokens = {
      access: { token: 'access-abc', expiresAt, ttlSeconds: 900 },
      refresh: {
        token: 'refresh-def',
        tokenHash: 'irrelevant-hash',
        expiresAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    };

    const proto = toProtoAuthTokens(issued);

    expect(proto.accessToken).toBe('access-abc');
    expect(proto.refreshToken).toBe('refresh-def');
    expect(proto.accessTokenExpiresAt).toEqual({
      seconds: Math.trunc(expiresAt.getTime() / 1000),
      nanos: (expiresAt.getTime() % 1000) * 1_000_000,
    });
  });

  it('does not leak the refresh tokenHash to the wire', () => {
    const issued: IssuedTokens = {
      access: { token: 'a', expiresAt: new Date(0), ttlSeconds: 1 },
      refresh: { token: 'r', tokenHash: 'SECRET-HASH', expiresAt: new Date(0) },
    };
    const proto = toProtoAuthTokens(issued);
    // The generated shape has no tokenHash field; we assert it structurally.
    expect(proto as unknown as Record<string, unknown>).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(proto)).not.toContain('SECRET-HASH');
  });
});
