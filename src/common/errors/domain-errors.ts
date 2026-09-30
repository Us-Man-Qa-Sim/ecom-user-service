// USR-9: transport-neutral domain errors.
//
// The rest of the codebase throws these (`NotFoundError`, `ConflictError`, …)
// instead of `RpcException`. The `GrpcExceptionFilter` translates them to
// gRPC status codes at the edge. This keeps services from importing anything
// under `@grpc/grpc-js` — the same errors could later drive an HTTP filter for
// a hypothetical debug endpoint without a new class hierarchy.
//
// Each subclass carries the smallest information the caller needs. Free-text
// messages are safe to expose to gateway callers: they are already
// sanitised by the domain (no SQL text, no stack traces, no PII beyond what
// the caller sent). Untyped Errors are treated as INTERNAL and their message
// is scrubbed at the filter boundary — see grpc-exception.filter.ts.

export type DomainErrorKind =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'UNAUTHENTICATED'
  | 'FAILED_PRECONDITION';

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly kind = 'INVALID_ARGUMENT';
}

export class NotFoundError extends DomainError {
  readonly kind = 'NOT_FOUND';
}

export class ConflictError extends DomainError {
  readonly kind = 'ALREADY_EXISTS';
}

export class PermissionDeniedError extends DomainError {
  readonly kind = 'PERMISSION_DENIED';
}

export class UnauthenticatedError extends DomainError {
  readonly kind = 'UNAUTHENTICATED';
}

export class FailedPreconditionError extends DomainError {
  readonly kind = 'FAILED_PRECONDITION';
}
