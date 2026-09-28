import { z } from 'zod';

// ISO 3166-1 alpha-2 country codes are exactly two uppercase letters. The DB
// column is CHAR(2); enforcing the shape here gives a friendlier error than a
// truncation surprise at write time.
const CountryCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().length(2).regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code'));

const OptionalLabel = z.string().trim().min(1).max(50).optional();
const OptionalState = z.string().trim().min(1).max(100).optional();

export const CreateAddressInputSchema = z.object({
  label: OptionalLabel,
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  state: OptionalState,
  postalCode: z.string().trim().min(1).max(20),
  country: CountryCode,
  isDefault: z.boolean().default(false),
});
export type CreateAddressInput = z.infer<typeof CreateAddressInputSchema>;

// Every field except `addressId` is optional so partial updates are cheap over
// the wire. `refine` keeps the request meaningful — an all-nullish body would
// otherwise no-op silently.
export const UpdateAddressInputSchema = z
  .object({
    addressId: z.uuid(),
    label: OptionalLabel,
    street: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: OptionalState,
    postalCode: z.string().trim().min(1).max(20).optional(),
    country: CountryCode.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.label !== undefined ||
      v.street !== undefined ||
      v.city !== undefined ||
      v.state !== undefined ||
      v.postalCode !== undefined ||
      v.country !== undefined ||
      v.isDefault !== undefined,
    { message: 'at least one field must be provided' },
  );
export type UpdateAddressInput = z.infer<typeof UpdateAddressInputSchema>;

export const AddressIdSchema = z.object({ addressId: z.uuid() });
export type AddressIdInput = z.infer<typeof AddressIdSchema>;
