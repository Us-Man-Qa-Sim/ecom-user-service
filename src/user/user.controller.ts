import { Controller } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
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

// Every RPC is stubbed for USR-1. Real implementations land in USR-4 → USR-6.
function unimplemented(rpc: string): never {
  throw new RpcException({
    code: GrpcStatus.UNIMPLEMENTED,
    message: `UserService.${rpc} is not implemented yet`,
  });
}

@Controller()
@UserServiceControllerMethods()
export class UserController implements UserServiceController {
  register(_request: RegisterRequest): Promise<RegisterResponse> {
    return unimplemented('Register');
  }

  login(_request: LoginRequest): Promise<LoginResponse> {
    return unimplemented('Login');
  }

  refreshToken(_request: RefreshTokenRequest): Promise<RefreshTokenResponse> {
    return unimplemented('RefreshToken');
  }

  logout(_request: LogoutRequest): Promise<LogoutResponse> {
    return unimplemented('Logout');
  }

  getMe(_request: GetMeRequest): Promise<GetMeResponse> {
    return unimplemented('GetMe');
  }

  getUser(_request: GetUserRequest): Promise<GetUserResponse> {
    return unimplemented('GetUser');
  }

  createAddress(_request: CreateAddressRequest): Promise<CreateAddressResponse> {
    return unimplemented('CreateAddress');
  }

  updateAddress(_request: UpdateAddressRequest): Promise<UpdateAddressResponse> {
    return unimplemented('UpdateAddress');
  }

  deleteAddress(_request: DeleteAddressRequest): Promise<DeleteAddressResponse> {
    return unimplemented('DeleteAddress');
  }

  listAddresses(_request: ListAddressesRequest): Promise<ListAddressesResponse> {
    return unimplemented('ListAddresses');
  }

  getAddress(_request: GetAddressRequest): Promise<GetAddressResponse> {
    return unimplemented('GetAddress');
  }
}
