import { User as PrismaUser, Role as PrismaRole } from '@prisma/client';
import { Role, User as ProtoUser } from '@us-man-qa-sim/ecom-contracts/generated/user';

// Prisma Role uses the DB enum values (CUSTOMER / ADMIN); the proto enum prefixes
// them with ROLE_ and reserves ROLE_UNSPECIFIED (0) per the proto3 style guide.
const roleToProto: Record<PrismaRole, Role> = {
  CUSTOMER: Role.ROLE_CUSTOMER,
  ADMIN: Role.ROLE_ADMIN,
};

// Timestamp isn't re-exported from the top-level contracts entry and its subpath
// isn't declared in the package's exports; structural typing suffices because
// ts-proto's Timestamp is exactly { seconds; nanos }.
function dateToTimestamp(date: Date): { seconds: number; nanos: number } {
  const millis = date.getTime();
  return {
    seconds: Math.trunc(millis / 1000),
    nanos: (millis % 1000) * 1_000_000,
  };
}

export function toProtoUser(user: PrismaUser): ProtoUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: roleToProto[user.role],
    createdAt: dateToTimestamp(user.createdAt),
    updatedAt: dateToTimestamp(user.updatedAt),
  };
}
