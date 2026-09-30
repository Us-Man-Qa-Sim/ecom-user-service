import type { Metadata } from '@grpc/grpc-js';
import { Role as PrismaRole } from '@prisma/client';
import {
  PermissionDeniedError,
  UnauthenticatedError,
} from '../common/errors/domain-errors';

export interface Identity {
  userId: string;
  role: PrismaRole;
  requestId?: string;
}

// The gateway is the only trusted origin for these headers — the private Docker
// network is the trust boundary (D5 / architecture §2). Services never re-verify
// the JWT; they read identity from metadata forwarded by the gateway.
const HEADER_USER_ID = 'x-user-id';
const HEADER_USER_ROLE = 'x-user-role';
const HEADER_REQUEST_ID = 'x-request-id';

function firstValue(metadata: Metadata | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  const values = metadata.get(key);
  if (!values || values.length === 0) return undefined;
  const raw = values[0];
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

export function readIdentity(metadata: Metadata | undefined): Identity {
  const userId = firstValue(metadata, HEADER_USER_ID);
  const roleRaw = firstValue(metadata, HEADER_USER_ROLE);

  if (!userId || !roleRaw) {
    throw new UnauthenticatedError('Missing identity metadata');
  }

  const role = normaliseRole(roleRaw);
  if (!role) {
    throw new UnauthenticatedError(`Unknown role: ${roleRaw}`);
  }

  return {
    userId,
    role,
    requestId: firstValue(metadata, HEADER_REQUEST_ID),
  };
}

// The gateway may forward the role in either its DB form (`CUSTOMER`/`ADMIN`) or
// the proto form (`ROLE_CUSTOMER`/`ROLE_ADMIN`). Accept both, canonicalise to DB.
function normaliseRole(value: string): PrismaRole | undefined {
  const upper = value.trim().toUpperCase();
  if (upper === 'CUSTOMER' || upper === 'ROLE_CUSTOMER') return PrismaRole.CUSTOMER;
  if (upper === 'ADMIN' || upper === 'ROLE_ADMIN') return PrismaRole.ADMIN;
  return undefined;
}

export function requireAdmin(identity: Identity): void {
  if (identity.role !== PrismaRole.ADMIN) {
    throw new PermissionDeniedError('Admin role required');
  }
}
