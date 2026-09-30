import { randomUUID } from 'node:crypto';
import { Address, Role } from '@prisma/client';
import { AddressService } from '../src/address/address.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { Identity } from '../src/identity/identity.util';
import { NotFoundError, ValidationError } from '../src/common/errors/domain-errors';

function makeStore() {
  const rows = new Map<string, Address>();
  return {
    rows,
    seed(address: Address) {
      rows.set(address.id, address);
    },
  };
}

function makePrisma(store: ReturnType<typeof makeStore>): PrismaService {
  const addressApi = {
    findUnique: jest.fn(async ({ where }: any) => store.rows.get(where.id) ?? null),
    findMany: jest.fn(async ({ where, orderBy }: any) => {
      let rows = [...store.rows.values()].filter((r) => r.userId === where.userId);
      if (Array.isArray(orderBy)) {
        rows = rows.slice().sort((a, b) => {
          for (const clause of orderBy) {
            const [key, dir] = Object.entries(clause)[0] as [keyof Address, 'asc' | 'desc'];
            const av = a[key] as unknown as number | boolean | Date;
            const bv = b[key] as unknown as number | boolean | Date;
            if (av === bv) continue;
            const cmp = av > bv ? 1 : -1;
            return dir === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
      }
      return rows;
    }),
    create: jest.fn(async ({ data }: any) => {
      const row: Address = {
        id: randomUUID(),
        userId: data.userId,
        label: data.label ?? null,
        street: data.street,
        city: data.city,
        state: data.state ?? null,
        postalCode: data.postalCode,
        country: data.country,
        isDefault: data.isDefault ?? false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.rows.set(row.id, row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = store.rows.get(where.id);
      if (!row) throw new Error('missing row');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of store.rows.values()) {
        if (where.userId && row.userId !== where.userId) continue;
        if (where.isDefault !== undefined && row.isDefault !== where.isDefault) continue;
        if (where.NOT?.id && row.id === where.NOT.id) continue;
        Object.assign(row, data);
        count++;
      }
      return { count };
    }),
    delete: jest.fn(async ({ where }: any) => {
      const row = store.rows.get(where.id);
      if (!row) throw new Error('missing');
      store.rows.delete(where.id);
      return row;
    }),
  };
  // clearDefault() takes a `SELECT ... FOR UPDATE` row lock on the user; the
  // in-memory store has no concurrency, so the lock is a recorded no-op.
  const executeRaw = jest.fn(async () => 1);
  return {
    address: addressApi,
    executeRaw,
    $transaction: async (fn: any) => fn({ address: addressApi, $executeRaw: executeRaw }),
  } as unknown as PrismaService & { executeRaw: jest.Mock };
}

const alice: Identity = { userId: 'user-alice', role: Role.CUSTOMER };
const bob: Identity = { userId: 'user-bob', role: Role.CUSTOMER };

const basePayload = {
  street: '123 Main St',
  city: 'Metropolis',
  postalCode: '12345',
  country: 'us',
};

describe('AddressService', () => {
  let store: ReturnType<typeof makeStore>;
  let prisma: PrismaService;
  let service: AddressService;

  beforeEach(() => {
    store = makeStore();
    prisma = makePrisma(store);
    service = new AddressService(prisma);
  });

  it('creates an address with the caller as owner and uppercases the country', async () => {
    const created = await service.create(alice, basePayload);
    expect(created.userId).toBe(alice.userId);
    expect(created.country).toBe('US');
    expect(created.isDefault).toBe(false);
  });

  it('rejects a payload missing required fields with ValidationError', async () => {
    await expect(
      service.create(alice, { street: '', city: '', country: 'us', postalCode: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('creating a default un-defaults the previous default', async () => {
    const first = await service.create(alice, { ...basePayload, isDefault: true });
    const second = await service.create(alice, {
      ...basePayload,
      street: '2 Second St',
      isDefault: true,
    });
    expect(store.rows.get(first.id)!.isDefault).toBe(false);
    expect(store.rows.get(second.id)!.isDefault).toBe(true);
  });

  it('locks the owning user row before changing the default', async () => {
    const executeRaw = (prisma as unknown as { executeRaw: jest.Mock }).executeRaw;
    await service.create(alice, basePayload);
    expect(executeRaw).not.toHaveBeenCalled();

    await service.create(alice, { ...basePayload, isDefault: true });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [sql, userId] = executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(sql.join('?')).toMatch(/FROM users WHERE id = \?::uuid FOR UPDATE/);
    expect(userId).toBe(alice.userId);
  });

  it('updating a non-owned address throws NotFoundError', async () => {
    const alicesAddress = await service.create(alice, basePayload);
    await expect(
      service.update(bob, { addressId: alicesAddress.id, street: 'evil' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updating a missing address throws NotFoundError', async () => {
    await expect(
      service.update(alice, { addressId: randomUUID(), street: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects an update with no fields to change', async () => {
    const created = await service.create(alice, basePayload);
    await expect(service.update(alice, { addressId: created.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('marking an address default un-defaults siblings and keeps this one', async () => {
    const first = await service.create(alice, { ...basePayload, isDefault: true });
    const second = await service.create(alice, { ...basePayload, street: '2 Second St' });
    const updated = await service.update(alice, { addressId: second.id, isDefault: true });
    expect(updated.isDefault).toBe(true);
    expect(store.rows.get(first.id)!.isDefault).toBe(false);
  });

  it('removes only the caller-owned address', async () => {
    const created = await service.create(alice, basePayload);
    await expect(service.remove(bob, { addressId: created.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await service.remove(alice, { addressId: created.id });
    expect(store.rows.has(created.id)).toBe(false);
  });

  it('list returns default first then newest first, scoped to caller', async () => {
    const a = await service.create(alice, { ...basePayload, street: '1' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await service.create(alice, { ...basePayload, street: '2', isDefault: true });
    await service.create(bob, basePayload);
    const list = await service.list(alice);
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('get returns the caller-owned address, NotFoundError for others', async () => {
    const created = await service.create(alice, basePayload);
    const got = await service.get(alice, { addressId: created.id });
    expect(got.id).toBe(created.id);
    await expect(service.get(bob, { addressId: created.id })).rejects.toBeInstanceOf(NotFoundError);
  });
});
