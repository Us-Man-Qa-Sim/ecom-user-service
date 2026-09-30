import { Metadata } from '@grpc/grpc-js';
import { Role as PrismaRole, User } from '@prisma/client';
import { Role as ProtoRole } from '@us-man-qa-sim/ecom-contracts/generated/user';
import { UserController } from '../src/user/user.controller';
import { PermissionDeniedError } from '../src/common/errors/domain-errors';
import type { UserService } from '../src/user/user.service';
import type { AuthService, IssuedTokens } from '../src/auth/auth.service';
import type { AddressService } from '../src/address/address.service';

// Small helpers to build fully-typed test doubles without dragging in Nest DI.
function md(entries: Record<string, string>): Metadata {
  const m = new Metadata();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-alice',
    email: 'alice@example.com',
    passwordHash: 'ignored',
    firstName: 'Alice',
    lastName: 'Doe',
    role: PrismaRole.CUSTOMER,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeTokens(): IssuedTokens {
  return {
    access: { token: 'access.abc', expiresAt: new Date('2026-01-01T00:15:00Z'), ttlSeconds: 900 },
    refresh: { token: 'refresh.def', tokenHash: 'hash', expiresAt: new Date('2026-02-01Z') },
  };
}

function build() {
  const userService = {
    register: jest.fn(),
    getById: jest.fn(),
  } as unknown as jest.Mocked<UserService>;
  const authService = {
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
  } as unknown as jest.Mocked<AuthService>;
  const addressService = {
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
  } as unknown as jest.Mocked<AddressService>;
  const controller = new UserController(userService, authService, addressService);
  return { controller, userService, authService, addressService };
}

describe('UserController', () => {
  describe('register', () => {
    it('delegates to UserService and returns a proto user with no tokens', async () => {
      const { controller, userService } = build();
      userService.register.mockResolvedValue(makeUser());

      const res = await controller.register({
        email: 'alice@example.com',
        password: 'a-strong-passphrase',
        firstName: 'Alice',
        lastName: 'Doe',
      });

      expect(userService.register).toHaveBeenCalledTimes(1);
      expect(res.tokens).toBeUndefined();
      expect(res.user).toMatchObject({ id: 'user-alice', role: ProtoRole.ROLE_CUSTOMER });
    });
  });

  describe('login', () => {
    it('returns the proto user and mapped tokens on success', async () => {
      const { controller, authService } = build();
      authService.login.mockResolvedValue({ user: makeUser(), tokens: makeTokens() });

      const res = await controller.login({ email: 'alice@example.com', password: 'pw' });

      expect(res.user).toMatchObject({ id: 'user-alice' });
      expect(res.tokens).toMatchObject({ accessToken: 'access.abc', refreshToken: 'refresh.def' });
    });
  });

  describe('refreshToken', () => {
    it('returns mapped tokens', async () => {
      const { controller, authService } = build();
      authService.refresh.mockResolvedValue({ tokens: makeTokens() });

      const res = await controller.refreshToken({ refreshToken: 'refresh.def' });

      expect(authService.refresh).toHaveBeenCalledWith({ refreshToken: 'refresh.def' });
      expect(res.tokens?.accessToken).toBe('access.abc');
    });
  });

  describe('logout', () => {
    it('returns an empty response', async () => {
      const { controller, authService } = build();
      authService.logout.mockResolvedValue(undefined);
      await expect(controller.logout({ refreshToken: 'r' })).resolves.toEqual({});
      expect(authService.logout).toHaveBeenCalledWith({ refreshToken: 'r' });
    });
  });

  describe('getMe', () => {
    it('reads the caller id from metadata and returns their proto user', async () => {
      const { controller, userService } = build();
      userService.getById.mockResolvedValue(makeUser({ id: 'user-42' }));

      const res = await controller.getMe(
        {},
        md({ 'x-user-id': 'user-42', 'x-user-role': 'CUSTOMER' }),
      );

      expect(userService.getById).toHaveBeenCalledWith('user-42');
      expect(res.user?.id).toBe('user-42');
    });
  });

  describe('getUser', () => {
    it('lets a customer read their own record', async () => {
      const { controller, userService } = build();
      userService.getById.mockResolvedValue(makeUser({ id: 'user-alice' }));

      const res = await controller.getUser(
        { userId: 'user-alice' },
        md({ 'x-user-id': 'user-alice', 'x-user-role': 'CUSTOMER' }),
      );

      expect(res.user?.id).toBe('user-alice');
    });

    it('rejects a customer reading someone else with PermissionDeniedError', async () => {
      const { controller, userService } = build();
      await expect(
        controller.getUser(
          { userId: 'user-bob' },
          md({ 'x-user-id': 'user-alice', 'x-user-role': 'CUSTOMER' }),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(userService.getById).not.toHaveBeenCalled();
    });

    it('lets an admin read anyone', async () => {
      const { controller, userService } = build();
      userService.getById.mockResolvedValue(makeUser({ id: 'user-bob', role: PrismaRole.CUSTOMER }));

      const res = await controller.getUser(
        { userId: 'user-bob' },
        md({ 'x-user-id': 'user-root', 'x-user-role': 'ADMIN' }),
      );

      expect(userService.getById).toHaveBeenCalledWith('user-bob');
      expect(res.user?.id).toBe('user-bob');
    });
  });

  describe('address routes', () => {
    const meta = md({ 'x-user-id': 'user-alice', 'x-user-role': 'CUSTOMER' });
    const baseAddress = {
      id: 'addr-1',
      userId: 'user-alice',
      label: null,
      street: '1 Main',
      city: 'Metropolis',
      state: null,
      postalCode: '12345',
      country: 'US',
      isDefault: false,
      createdAt: new Date('2026-01-01Z'),
      updatedAt: new Date('2026-01-01Z'),
    };

    it('createAddress forwards identity + payload and maps the result', async () => {
      const { controller, addressService } = build();
      addressService.create.mockResolvedValue(baseAddress);
      const req = { street: '1 Main', city: 'Metropolis', postalCode: '12345', country: 'us' };

      const res = await controller.createAddress(req, meta);

      expect(addressService.create).toHaveBeenCalledWith(
        { userId: 'user-alice', role: PrismaRole.CUSTOMER, requestId: undefined },
        req,
      );
      expect(res.address?.id).toBe('addr-1');
      // Nullable optional field null→undefined in mapper.
      expect(res.address?.label).toBeUndefined();
    });

    it('updateAddress forwards identity + payload', async () => {
      const { controller, addressService } = build();
      addressService.update.mockResolvedValue({ ...baseAddress, street: '2 Second' });
      const req = { addressId: 'addr-1', street: '2 Second' };

      const res = await controller.updateAddress(req, meta);

      expect(addressService.update).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-alice' }), req);
      expect(res.address?.street).toBe('2 Second');
    });

    it('deleteAddress returns an empty response', async () => {
      const { controller, addressService } = build();
      addressService.remove.mockResolvedValue(undefined);
      await expect(controller.deleteAddress({ addressId: 'addr-1' }, meta)).resolves.toEqual({});
      expect(addressService.remove).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-alice' }),
        { addressId: 'addr-1' },
      );
    });

    it('listAddresses maps every row', async () => {
      const { controller, addressService } = build();
      addressService.list.mockResolvedValue([baseAddress, { ...baseAddress, id: 'addr-2' }]);
      const res = await controller.listAddresses({}, meta);
      expect(res.addresses).toHaveLength(2);
      expect(res.addresses.map((a) => a.id)).toEqual(['addr-1', 'addr-2']);
    });

    it('getAddress maps the returned row', async () => {
      const { controller, addressService } = build();
      addressService.get.mockResolvedValue(baseAddress);
      const res = await controller.getAddress({ addressId: 'addr-1' }, meta);
      expect(addressService.get).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-alice' }),
        { addressId: 'addr-1' },
      );
      expect(res.address?.id).toBe('addr-1');
    });
  });
});
