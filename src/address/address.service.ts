import { Injectable } from '@nestjs/common';
import { Address as PrismaAddress, Prisma } from '@prisma/client';
import type { ZodType } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { Identity } from '../identity/identity.util';
import { NotFoundError, ValidationError } from '../common/errors/domain-errors';
import {
  AddressIdSchema,
  CreateAddressInputSchema,
  UpdateAddressInput,
  UpdateAddressInputSchema,
} from './dto/address.dto';

@Injectable()
export class AddressService {
  constructor(private readonly prisma: PrismaService) {}

  async create(identity: Identity, raw: unknown): Promise<PrismaAddress> {
    const input = parse(CreateAddressInputSchema, raw, 'CreateAddress');
    // Setting isDefault has to un-default the sibling in one transaction — a
    // two-step approach can end up with two defaults if a concurrent create
    // interleaves. We do the same in update() below.
    return this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await this.clearDefault(tx, identity.userId, null);
      }
      return tx.address.create({
        data: {
          userId: identity.userId,
          label: input.label,
          street: input.street,
          city: input.city,
          state: input.state,
          postalCode: input.postalCode,
          country: input.country,
          isDefault: input.isDefault,
        },
      });
    });
  }

  async update(identity: Identity, raw: unknown): Promise<PrismaAddress> {
    const input = parse(UpdateAddressInputSchema, raw, 'UpdateAddress');
    return this.prisma.$transaction(async (tx) => {
      const owned = await this.findOwned(tx, identity, input.addressId);
      if (input.isDefault === true) {
        await this.clearDefault(tx, identity.userId, owned.id);
      }
      return tx.address.update({
        where: { id: owned.id },
        data: buildUpdateData(input),
      });
    });
  }

  async remove(identity: Identity, raw: unknown): Promise<void> {
    const input = parse(AddressIdSchema, raw, 'DeleteAddress');
    await this.prisma.$transaction(async (tx) => {
      const owned = await this.findOwned(tx, identity, input.addressId);
      await tx.address.delete({ where: { id: owned.id } });
    });
  }

  async list(identity: Identity): Promise<PrismaAddress[]> {
    return this.prisma.address.findMany({
      where: { userId: identity.userId },
      // Default first, then newest first — the shape a user's address picker
      // wants without any client-side sort.
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async get(identity: Identity, raw: unknown): Promise<PrismaAddress> {
    const input = parse(AddressIdSchema, raw, 'GetAddress');
    return this.findOwned(this.prisma, identity, input.addressId);
  }

  private async findOwned(
    client: PrismaService | Prisma.TransactionClient,
    identity: Identity,
    addressId: string,
  ): Promise<PrismaAddress> {
    const address = await client.address.findUnique({ where: { id: addressId } });
    if (!address) {
      throw new NotFoundError('Address not found');
    }
    // Ownership is a NOT_FOUND, not PERMISSION_DENIED: leaking "this ID exists
    // but isn't yours" would let a probe map another user's address IDs.
    if (address.userId !== identity.userId) {
      throw new NotFoundError('Address not found');
    }
    return address;
  }

  private async clearDefault(
    tx: Prisma.TransactionClient,
    userId: string,
    exceptId: string | null,
  ): Promise<void> {
    await tx.address.updateMany({
      where: {
        userId,
        isDefault: true,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      data: { isDefault: false },
    });
  }
}

function buildUpdateData(input: UpdateAddressInput): Prisma.AddressUpdateInput {
  const data: Prisma.AddressUpdateInput = {};
  if (input.label !== undefined) data.label = input.label;
  if (input.street !== undefined) data.street = input.street;
  if (input.city !== undefined) data.city = input.city;
  if (input.state !== undefined) data.state = input.state;
  if (input.postalCode !== undefined) data.postalCode = input.postalCode;
  if (input.country !== undefined) data.country = input.country;
  if (input.isDefault !== undefined) data.isDefault = input.isDefault;
  return data;
}

function parse<T>(schema: ZodType<T>, raw: unknown, rpc: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`Invalid ${rpc} request: ${message}`);
  }
  return parsed.data;
}

