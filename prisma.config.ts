import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7 config: `datasource.url` moved out of schema.prisma. Migrations read
// the connection string from here; runtime uses @prisma/adapter-pg in PrismaService.
export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(__dirname, 'prisma', 'migrations'),
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
