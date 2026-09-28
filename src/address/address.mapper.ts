import { Address as PrismaAddress } from '@prisma/client';
import { Address as ProtoAddress } from '@us-man-qa-sim/ecom-contracts/generated/user';

function dateToTimestamp(date: Date): { seconds: number; nanos: number } {
  const millis = date.getTime();
  return {
    seconds: Math.trunc(millis / 1000),
    nanos: (millis % 1000) * 1_000_000,
  };
}

export function toProtoAddress(address: PrismaAddress): ProtoAddress {
  // proto3 `optional` fields expect `undefined` for absence, not `null` — the
  // ts-proto types are `string | undefined`. Prisma gives us `string | null`.
  return {
    id: address.id,
    userId: address.userId,
    label: address.label ?? undefined,
    street: address.street,
    city: address.city,
    state: address.state ?? undefined,
    postalCode: address.postalCode,
    country: address.country,
    isDefault: address.isDefault,
    createdAt: dateToTimestamp(address.createdAt),
    updatedAt: dateToTimestamp(address.updatedAt),
  };
}
