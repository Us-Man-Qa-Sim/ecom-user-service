import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtService } from './jwt.service';

@Module({
  providers: [JwtService, AuthService],
  exports: [JwtService, AuthService],
})
export class AuthModule {}
