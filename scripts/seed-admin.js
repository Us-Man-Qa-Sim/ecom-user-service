// USR-7: cross-platform launcher for the admin seed script.
//
// A plain-JS entry so npm scripts do not need shell-specific env-var syntax or
// a dotenv dependency. It:
//   1. Loads a local `.env` if present (Node ≥ 21.7 built-in — no dep).
//   2. Registers ts-node in transpile-only mode with an explicit rootDir so
//      TS5011 ("common source directory") does not fire when the seed module
//      imports a sibling under src/ (base tsconfig.json intentionally has no
//      rootDir so tsc/build and lint/test can each set their own).
//   3. Requires the TypeScript entry, which self-invokes `main()` when run as
//      the program entry point.

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional — CI and Docker set env vars directly.
}

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { rootDir: '.', module: 'commonjs' },
});

const { main } = require('../src/seed/seed-admin');
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed-admin] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
