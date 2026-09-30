import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';

export interface JwtKeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
  // `kid` (JWT header) lets the gateway (and later a JWKS endpoint) pick the
  // right key when signing keys are rotated. Deriving it from the public key's
  // SPKI SHA-256 makes it stable across restarts as long as the key file itself
  // is stable.
  kid: string;
}

const logger = new Logger('JwtKeys');

export function loadKeyMaterial(
  privateKeyPath: string | undefined,
  publicKeyPath: string | undefined,
): JwtKeyMaterial {
  if (privateKeyPath && publicKeyPath) {
    const privatePem = readFileSync(privateKeyPath, 'utf8');
    const publicPem = readFileSync(publicKeyPath, 'utf8');
    const privateKey = createPrivateKey(privatePem);
    const publicKey = createPublicKey(publicPem);
    assertRsaKey(privateKey, 'private');
    assertRsaKey(publicKey, 'public');
    return { privateKey, publicKey, kid: derivKid(publicKey) };
  }

  if (privateKeyPath || publicKeyPath) {
    throw new Error('JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH must be set together');
  }

  logger.warn(
    'No JWT keys configured — generating an ephemeral RS256 key pair. ' +
      'Tokens will be invalidated on every restart. Set JWT_PRIVATE_KEY_PATH ' +
      'and JWT_PUBLIC_KEY_PATH for stable keys.',
  );
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, publicKey, kid: derivKid(publicKey) };
}

function assertRsaKey(key: KeyObject, kind: 'public' | 'private'): void {
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`Expected RSA ${kind} key, got ${key.asymmetricKeyType ?? 'unknown'}`);
  }
}

function derivKid(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64url').slice(0, 16);
}
