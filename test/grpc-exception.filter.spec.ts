import { firstValueFrom } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { GrpcExceptionFilter } from '../src/common/errors/grpc-exception.filter';
import {
  ConflictError,
  FailedPreconditionError,
  NotFoundError,
  PermissionDeniedError,
  UnauthenticatedError,
  ValidationError,
} from '../src/common/errors/domain-errors';

// The filter returns an Observable that immediately errors with the gRPC wire
// payload `{ code, message }` — Nest passes it to the grpc-js callback as-is.
// We convert with firstValueFrom to await and inspect it.
type GrpcError = { code: number; message: string };

async function runFilter(exception: unknown): Promise<GrpcError> {
  const filter = new GrpcExceptionFilter();
  // ArgumentsHost is unused by the filter — a naked object satisfies TS.
  const observable = filter.catch(exception, {} as never);
  try {
    await firstValueFrom(observable);
    throw new Error('expected filter to error');
  } catch (err) {
    if (err instanceof Error) throw err;
    return err as GrpcError;
  }
}

describe('GrpcExceptionFilter', () => {
  it('passes an existing RpcException through unchanged', async () => {
    const rpc = new RpcException({ code: GrpcStatus.CANCELLED, message: 'stop' });
    const result = await runFilter(rpc);
    expect(result).toBe(rpc.getError());
  });

  it.each([
    [new ValidationError('bad'), GrpcStatus.INVALID_ARGUMENT, 'bad'],
    [new NotFoundError('nope'), GrpcStatus.NOT_FOUND, 'nope'],
    [new ConflictError('dup'), GrpcStatus.ALREADY_EXISTS, 'dup'],
    [new PermissionDeniedError('go away'), GrpcStatus.PERMISSION_DENIED, 'go away'],
    [new UnauthenticatedError('who?'), GrpcStatus.UNAUTHENTICATED, 'who?'],
    [new FailedPreconditionError('nope'), GrpcStatus.FAILED_PRECONDITION, 'nope'],
  ])('maps %p to the matching gRPC status', async (err, expectedCode, expectedMessage) => {
    const result = await runFilter(err);
    expect(result).toMatchObject({ code: expectedCode, message: expectedMessage });
  });

  it('maps a ZodError to INVALID_ARGUMENT with a joined message', async () => {
    const schema = z.object({ email: z.email(), password: z.string().min(12) });
    let caught: unknown;
    try {
      schema.parse({ email: 'nope', password: 'x' });
    } catch (e) {
      caught = e;
    }
    const result = await runFilter(caught);
    const error = result;
    expect(error.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(error.message).toMatch(/Validation failed:/);
    expect(error.message).toMatch(/email/);
    expect(error.message).toMatch(/password/);
  });

  it('maps Prisma P2002 (unique violation) to ALREADY_EXISTS naming the target', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['email'] },
    });
    const result = await runFilter(err);
    expect(result).toMatchObject({
      code: GrpcStatus.ALREADY_EXISTS,
      message: expect.stringContaining('email'),
    });
  });

  it('maps Prisma P2025 to NOT_FOUND', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('missing', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const result = await runFilter(err);
    expect(result).toMatchObject({ code: GrpcStatus.NOT_FOUND });
  });

  it('maps Prisma P2003 (fk) to FAILED_PRECONDITION', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('fk', {
      code: 'P2003',
      clientVersion: 'test',
    });
    const result = await runFilter(err);
    expect(result).toMatchObject({ code: GrpcStatus.FAILED_PRECONDITION });
  });

  it('maps Prisma P2034 (serialization conflict) to ABORTED', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    const result = await runFilter(err);
    expect(result).toMatchObject({ code: GrpcStatus.ABORTED });
  });

  it('maps an unmapped Prisma code to INTERNAL with a scrubbed message', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('pool timeout', {
      code: 'P2024',
      clientVersion: 'test',
    });
    const result = await runFilter(err);
    expect(result).toMatchObject({
      code: GrpcStatus.INTERNAL,
      message: 'Internal server error',
    });
  });

  it('maps an unknown Error to INTERNAL and never leaks its message', async () => {
    const result = await runFilter(new Error('SELECT * FROM users WHERE secret=$1'));
    const error = result;
    expect(error.code).toBe(GrpcStatus.INTERNAL);
    expect(error.message).toBe('Internal server error');
    expect(error.message).not.toMatch(/SELECT|secret/);
  });
});
