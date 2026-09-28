import { validateEnv } from '../src/config/env.validation';

describe('env validation', () => {
  it('accepts a valid environment', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgresql://user_svc:changeme@localhost:5432/user_db?schema=public',
    });
    expect(env.NODE_ENV).toBe('development');
    expect(env.GRPC_PORT).toBe(5001);
    expect(env.HTTP_PORT).toBe(8081);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-numeric GRPC_PORT', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
        GRPC_PORT: 'not-a-port',
      }),
    ).toThrow(/GRPC_PORT/);
  });
});
