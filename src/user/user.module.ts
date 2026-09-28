import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { AuthModule } from '../auth/auth.module';
import { AddressModule } from '../address/address.module';

@Module({
  imports: [AuthModule, AddressModule],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
