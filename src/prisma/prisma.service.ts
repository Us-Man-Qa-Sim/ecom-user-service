import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma 7 requires an adapter at runtime. For Postgres we use @prisma/adapter-pg,
// which wraps the standard `pg` driver. Migrations read the URL from prisma.config.ts.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ConfigService) config: ConfigService) {
    const connectionString = config.getOrThrow<string>('DATABASE_URL');
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  // Disconnect in onApplicationShutdown (the last lifecycle phase) so that
  // workers draining in onModuleDestroy (outbox relay) and in-flight gRPC
  // calls finishing while Nest closes the servers still have a connection.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
