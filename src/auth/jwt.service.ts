import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';
import { Role as PrismaRole } from '@prisma/client';
import { JwtKeyMaterial, loadKeyMaterial } from './keys';

export interface AccessTokenClaims {
  sub: string;
  role: PrismaRole;
  email: string;
}

export interface MintedAccessToken {
  token: string;
  expiresAt: Date;
  ttlSeconds: number;
}

export interface MintedRefreshToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

// 32 bytes of CSPRNG entropy → base64url ≈ 43 chars. Refresh tokens live long
// enough that the birthday bound matters (30d default TTL, many concurrent
// users); 256 bits is overkill for that but cheap. SHA-256 for storage is
// adequate because the token is already unpredictable — we're only defending
// against a DB read revealing usable tokens, not against a brute-force guess.
const REFRESH_BYTES = 32;

@Injectable()
export class JwtService implements OnModuleInit {
  private readonly logger = new Logger(JwtService.name);
  private keys!: JwtKeyMaterial;
  private accessTtlSeconds!: number;
  private refreshTtlSeconds!: number;
  private issuer!: string;
  private audience!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.keys = loadKeyMaterial(
      this.config.get<string>('JWT_PRIVATE_KEY_PATH'),
      this.config.get<string>('JWT_PUBLIC_KEY_PATH'),
    );
    this.accessTtlSeconds = this.config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
    this.refreshTtlSeconds = this.config.getOrThrow<number>('JWT_REFRESH_TTL_SECONDS');
    this.issuer = this.config.getOrThrow<string>('JWT_ISSUER');
    this.audience = this.config.getOrThrow<string>('JWT_AUDIENCE');
    this.logger.log(`JWT signing key loaded (kid=${this.keys.kid})`);
  }

  get accessTtl(): number {
    return this.accessTtlSeconds;
  }

  get refreshTtl(): number {
    return this.refreshTtlSeconds;
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<MintedAccessToken> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.accessTtlSeconds;
    const token = await new SignJWT({ role: claims.role, email: claims.email })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.keys.kid })
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.keys.privateKey);
    return { token, expiresAt: new Date(exp * 1000), ttlSeconds: this.accessTtlSeconds };
  }

  mintRefreshToken(): MintedRefreshToken {
    const token = randomBytes(REFRESH_BYTES).toString('base64url');
    return {
      token,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
    };
  }
}

// Exported so callers looking up a token by hash don't have to depend on the
// full JwtService (and tests can compute a hash without a Nest module).
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
