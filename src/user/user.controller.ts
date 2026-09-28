import { Controller } from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import {
  CreateAddressRequest,
  CreateAddressResponse,
  DeleteAddressRequest,
  DeleteAddressResponse,
  GetAddressRequest,
  GetAddressResponse,
  GetMeRequest,
  GetMeResponse,
  GetUserRequest,
  GetUserResponse,
  ListAddressesRequest,
  ListAddressesResponse,
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  LogoutResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
  RegisterRequest,
  RegisterResponse,
  UpdateAddressRequest,
  UpdateAddressResponse,
  UserServiceController,
  UserServiceControllerMethods,
} from '@us-man-qa-sim/ecom-contracts/generated/user';
import { UserService } from './user.service';
import { toProtoUser } from './user.mapper';
import { AuthService } from '../auth/auth.service';
import { toProtoAuthTokens } from '../auth/auth.mapper';
import { AddressService } from '../address/address.service';
import { toProtoAddress } from '../address/address.mapper';
import { readIdentity, requireAdmin } from '../identity/identity.util';

@Controller()
@UserServiceControllerMethods()
export class UserController implements UserServiceController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly addressService: AddressService,
  ) {}

  async register(request: RegisterRequest): Promise<RegisterResponse> {
    // Register mints no tokens — the client calls Login next. Auto-login on
    // register would need Login's rate-limit and audit trail, which live at the
    // gateway; keeping the flow explicit avoids duplicating those rules here.
    const user = await this.userService.register(request);
    return { user: toProtoUser(user), tokens: undefined };
  }

  async login(request: LoginRequest): Promise<LoginResponse> {
    const { user, tokens } = await this.authService.login(request);
    return { user: toProtoUser(user), tokens: toProtoAuthTokens(tokens) };
  }

  async refreshToken(request: RefreshTokenRequest): Promise<RefreshTokenResponse> {
    const { tokens } = await this.authService.refresh(request);
    return { tokens: toProtoAuthTokens(tokens) };
  }

  async logout(request: LogoutRequest): Promise<LogoutResponse> {
    await this.authService.logout(request);
    return {};
  }

  async getMe(_request: GetMeRequest, metadata?: Metadata): Promise<GetMeResponse> {
    const identity = readIdentity(metadata);
    const user = await this.userService.getById(identity.userId);
    return { user: toProtoUser(user) };
  }

  async getUser(request: GetUserRequest, metadata?: Metadata): Promise<GetUserResponse> {
    // GetUser is service-to-service (notification-service fetches an email for
    // an outgoing message) and admin console lookups. Allowing every caller
    // would let a customer trawl the user directory.
    const identity = readIdentity(metadata);
    if (identity.userId !== request.userId) {
      requireAdmin(identity);
    }
    const user = await this.userService.getById(request.userId);
    return { user: toProtoUser(user) };
  }

  async createAddress(
    request: CreateAddressRequest,
    metadata?: Metadata,
  ): Promise<CreateAddressResponse> {
    const identity = readIdentity(metadata);
    const address = await this.addressService.create(identity, request);
    return { address: toProtoAddress(address) };
  }

  async updateAddress(
    request: UpdateAddressRequest,
    metadata?: Metadata,
  ): Promise<UpdateAddressResponse> {
    const identity = readIdentity(metadata);
    const address = await this.addressService.update(identity, request);
    return { address: toProtoAddress(address) };
  }

  async deleteAddress(
    request: DeleteAddressRequest,
    metadata?: Metadata,
  ): Promise<DeleteAddressResponse> {
    const identity = readIdentity(metadata);
    await this.addressService.remove(identity, request);
    return {};
  }

  async listAddresses(
    _request: ListAddressesRequest,
    metadata?: Metadata,
  ): Promise<ListAddressesResponse> {
    const identity = readIdentity(metadata);
    const addresses = await this.addressService.list(identity);
    return { addresses: addresses.map(toProtoAddress) };
  }

  async getAddress(
    request: GetAddressRequest,
    metadata?: Metadata,
  ): Promise<GetAddressResponse> {
    const identity = readIdentity(metadata);
    const address = await this.addressService.get(identity, request);
    return { address: toProtoAddress(address) };
  }
}
