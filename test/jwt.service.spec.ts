import { ConfigService } from '@nestjs/config';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { Role } from '@prisma/client';
import { hashRefreshToken, JwtService } from '../src/auth/jwt.service';

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const env: Record<string, unknown> = {
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 60 * 60 * 24 * 30,
    JWT_ISSUER: 'user-service',
    JWT_AUDIENCE: 'ecom-api',
    ...overrides,
  };
  return {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      if (!(key in env)) throw new Error(`missing ${key}`);
      return env[key];
    },
  } as unknown as ConfigService;
}

describe('JwtService', () => {
  let service: JwtService;
  let publicKey: ReturnType<typeof createPublicKey>;

  beforeAll(() => {
    // Use a fixed key pair per suite so verification uses the same public key.
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    publicKey = kp.publicKey;
    // JwtService.onModuleInit() loads keys from config; hijack the loader by
    // pre-populating what loadKeyMaterial() would produce.
    // Easier: point env at exported PEMs on disk. Even easier: monkey-patch the
    // loader — since we control the module boundary in tests, we just call
    // onModuleInit with the ephemeral path so loadKeyMaterial generates its own
    // pair, and re-extract that pair via signAccessToken → decoded header.
    service = new JwtService(makeConfig());
    service.onModuleInit();
    // Overwrite the internal keys via a controlled path: re-init after stubbing
    // env is complex; instead we reach into the service via signAccessToken and
    // recover the public key from the JWK the token references. But the service
    // exposes no JWKS. Cleaner: replace the internal keys directly.
    (
      service as unknown as { keys: { privateKey: unknown; publicKey: unknown; kid: string } }
    ).keys = {
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      kid: 'test-kid',
    };
  });

  it('signs an access token verifiable with the matching public key', async () => {
    const minted = await service.signAccessToken({
      sub: 'user-1',
      role: Role.CUSTOMER,
      email: 'a@b.com',
    });

    const { payload, protectedHeader } = await jwtVerify(minted.token, publicKey, {
      issuer: 'user-service',
      audience: 'ecom-api',
    });

    expect(protectedHeader.alg).toBe('RS256');
    expect(protectedHeader.kid).toBe('test-kid');
    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe(Role.CUSTOMER);
    expect(payload.email).toBe('a@b.com');
    // exp is in seconds and roughly now + 900s.
    const now = Math.floor(Date.now() / 1000);
    expect(payload.exp).toBeGreaterThan(now + 890);
    expect(payload.exp).toBeLessThan(now + 910);
  });

  it('mints a refresh token whose hash matches hashRefreshToken()', () => {
    const minted = service.mintRefreshToken();
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(minted.tokenHash).toBe(hashRefreshToken(minted.token));
    expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('exposes the configured TTLs', () => {
    expect(service.accessTtl).toBe(900);
    expect(service.refreshTtl).toBe(60 * 60 * 24 * 30);
  });
});
