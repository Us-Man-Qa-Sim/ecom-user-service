import { Address as PrismaAddress } from '@prisma/client';
import { toProtoAddress } from '../src/address/address.mapper';

function makeAddress(overrides: Partial<PrismaAddress> = {}): PrismaAddress {
  return {
    id: 'addr-1',
    userId: 'user-1',
    label: 'home',
    street: '123 Main St',
    city: 'Metropolis',
    state: 'NY',
    postalCode: '12345',
    country: 'US',
    isDefault: true,
    createdAt: new Date('2026-01-02T03:04:05.678Z'),
    updatedAt: new Date('2026-02-03T04:05:06.789Z'),
    ...overrides,
  };
}

describe('toProtoAddress', () => {
  it('copies every scalar field through', () => {
    const proto = toProtoAddress(makeAddress());
    expect(proto).toMatchObject({
      id: 'addr-1',
      userId: 'user-1',
      label: 'home',
      street: '123 Main St',
      city: 'Metropolis',
      state: 'NY',
      postalCode: '12345',
      country: 'US',
      isDefault: true,
    });
  });

  it('converts null label/state to undefined (proto3 optional shape)', () => {
    const proto = toProtoAddress(makeAddress({ label: null, state: null }));
    expect(proto.label).toBeUndefined();
    expect(proto.state).toBeUndefined();
  });

  it('encodes createdAt/updatedAt as proto Timestamps with matching seconds + nanos', () => {
    const created = new Date('2026-01-02T03:04:05.678Z');
    const updated = new Date('2026-02-03T04:05:06.789Z');
    const proto = toProtoAddress(makeAddress({ createdAt: created, updatedAt: updated }));

    const toTs = (d: Date) => ({
      seconds: Math.trunc(d.getTime() / 1000),
      nanos: (d.getTime() % 1000) * 1_000_000,
    });
    expect(proto.createdAt).toEqual(toTs(created));
    expect(proto.updatedAt).toEqual(toTs(updated));
  });
});
