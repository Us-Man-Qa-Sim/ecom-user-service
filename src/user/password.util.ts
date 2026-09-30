import * as argon2 from 'argon2';

// argon2id with OWASP 2024 second-choice params (memoryCost: 47 MiB / t=1 / p=1).
// A dedicated worker pool inside the argon2 native binding keeps the event loop
// unblocked; each hash still costs ~100 ms of CPU, which is the point.
// Shared between UserService.register and the admin seed script so any change to
// the cost parameters applies uniformly — a script that hashed with different
// options would silently produce credentials the running service still accepts,
// which would make future tuning error-prone.
export const ARGON2_OPTS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 47104,
  timeCost: 1,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTS);
}
