import { Role as PrismaRole, User as PrismaUser } from '@prisma/client';
import { Role as ProtoRole } from '@us-man-qa-sim/ecom-contracts/generated/user';
import { toProtoUser } from '../src/user/user.mapper';

function makeUser(overrides: Partial<PrismaUser> = {}): PrismaUser {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'alice@example.com',
    passwordHash: '$argon2id$never-leak',
    firstName: 'Alice',
    lastName: 'Doe',
    role: PrismaRole.CUSTOMER,
    createdAt: new Date('2026-01-02T03:04:05.678Z'),
    updatedAt: new Date('2026-02-03T04:05:06.789Z'),
    ...overrides,
  };
}

describe('toProtoUser', () => {
  it('maps every scalar field, translates the role, and drops the password hash', () => {
    const proto = toProtoUser(makeUser());

    expect(proto).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Doe',
      role: ProtoRole.ROLE_CUSTOMER,
      createdAt: { seconds: expect.any(Number), nanos: expect.any(Number) },
      updatedAt: { seconds: expect.any(Number), nanos: expect.any(Number) },
    });
    // passwordHash is never a property of the proto shape.
    expect(proto as unknown as Record<string, unknown>).not.toHaveProperty('passwordHash');
  });

  it('maps Prisma ADMIN to proto ROLE_ADMIN', () => {
    const proto = toProtoUser(makeUser({ role: PrismaRole.ADMIN }));
    expect(proto.role).toBe(ProtoRole.ROLE_ADMIN);
  });

  it('converts Date fields to proto Timestamp with matching seconds + nanos', () => {
    const created = new Date('2026-01-02T03:04:05.678Z');
    const proto = toProtoUser(makeUser({ createdAt: created }));

    const millis = created.getTime();
    expect(proto.createdAt).toEqual({
      seconds: Math.trunc(millis / 1000),
      nanos: (millis % 1000) * 1_000_000,
    });
  });
});
