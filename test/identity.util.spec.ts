import { Metadata } from '@grpc/grpc-js';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Role } from '@prisma/client';
import { readIdentity, requireAdmin } from '../src/identity/identity.util';

function md(entries: Record<string, string>): Metadata {
  const meta = new Metadata();
  for (const [k, v] of Object.entries(entries)) meta.set(k, v);
  return meta;
}

describe('readIdentity', () => {
  it('parses user id, role, and request id', () => {
    const identity = readIdentity(
      md({
        'x-user-id': 'user-1',
        'x-user-role': 'CUSTOMER',
        'x-request-id': 'req-1',
      }),
    );
    expect(identity).toEqual({ userId: 'user-1', role: Role.CUSTOMER, requestId: 'req-1' });
  });

  it('accepts the proto-form role prefix', () => {
    const identity = readIdentity(
      md({ 'x-user-id': 'user-1', 'x-user-role': 'ROLE_ADMIN' }),
    );
    expect(identity.role).toBe(Role.ADMIN);
  });

  it.each([
    ['no metadata at all', undefined as unknown as Metadata],
    ['missing x-user-id', md({ 'x-user-role': 'CUSTOMER' })],
    ['missing x-user-role', md({ 'x-user-id': 'user-1' })],
  ])('rejects %s with UNAUTHENTICATED', (_label, meta) => {
    expect(() => readIdentity(meta)).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ code: GrpcStatus.UNAUTHENTICATED }) }),
    );
  });

  it('rejects an unknown role', () => {
    expect(() => readIdentity(md({ 'x-user-id': 'u', 'x-user-role': 'SUPERUSER' }))).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ code: GrpcStatus.UNAUTHENTICATED }) }),
    );
  });
});

describe('requireAdmin', () => {
  it('lets an admin through', () => {
    expect(() => requireAdmin({ userId: 'u', role: Role.ADMIN })).not.toThrow();
  });

  it('rejects a customer with PERMISSION_DENIED', () => {
    expect(() => requireAdmin({ userId: 'u', role: Role.CUSTOMER })).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ code: GrpcStatus.PERMISSION_DENIED }) }),
    );
  });
});
