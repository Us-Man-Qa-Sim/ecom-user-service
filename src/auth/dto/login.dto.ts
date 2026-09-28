import { z } from 'zod';

// We deliberately don't enforce the register-time min-length here — old
// accounts predate whatever the current policy is, and login must still work
// for them. Upper bound guards against a pathological argon2.verify() call.
export const LoginInputSchema = z.object({
  email: z.email().max(254).transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1).max(1024),
});

export type LoginInput = z.infer<typeof LoginInputSchema>;

export const RefreshInputSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});
export type RefreshInput = z.infer<typeof RefreshInputSchema>;

export const LogoutInputSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});
export type LogoutInput = z.infer<typeof LogoutInputSchema>;
