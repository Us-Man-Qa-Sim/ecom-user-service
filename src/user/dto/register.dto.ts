import { z } from 'zod';

// Password minimum matches NIST SP 800-63B guidance: length over complexity.
// argon2 does the rest — no upper/lower/digit mandates that push users to `Password1!`.
export const RegisterInputSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  password: z.string().min(12).max(128),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
});

export type RegisterInput = z.infer<typeof RegisterInputSchema>;
