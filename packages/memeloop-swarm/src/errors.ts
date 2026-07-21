import { OrchestrationError } from 'memeloop';
import type { OrchestrationErrorCode } from 'memeloop';

/**
 * Map a Docker Engine HTTP status code to a core {@link OrchestrationError}.
 *
 * Mapping table (documented in docs/AGENT_ORCHESTRATION_PLAN.md §10 envelope
 * semantics):
 *
 * | HTTP | Code        | Retryable |
 * | ---- | ----------- | --------- |
 * | 400  | INVALID     | no        |
 * | 401  | FORBIDDEN   | no        |
 * | 403  | FORBIDDEN   | no        |
 * | 404  | NOT_FOUND   | no        |
 * | 409  | CONFLICT    | no        |
 * | 5xx  | UNAVAILABLE | yes       |
 */
export function engineStatusError(statusCode: number, message: string, context: string): OrchestrationError {
  let code: OrchestrationErrorCode;
  let retryable = false;
  if (statusCode === 400) {
    code = 'INVALID';
  } else if (statusCode === 401 || statusCode === 403) {
    code = 'FORBIDDEN';
  } else if (statusCode === 404) {
    code = 'NOT_FOUND';
  } else if (statusCode === 409) {
    code = 'CONFLICT';
  } else if (statusCode >= 500) {
    code = 'UNAVAILABLE';
    retryable = true;
  } else {
    code = 'INTERNAL';
  }
  return new OrchestrationError({
    code,
    message: `${context}: Docker Engine responded ${statusCode}: ${message}`,
    retryable,
    details: { statusCode },
  });
}

/**
 * Normalize any failure thrown by the engine client into an
 * {@link OrchestrationError}. Aborts map to `CANCELLED`, driver-side deadline
 * aborts map to `TIMEOUT`, and transport failures (connection refused, reset,
 * missing unix socket) map to retryable `UNAVAILABLE`.
 */
export function toSwarmDriverError(error: unknown, context: string): OrchestrationError {
  if (error instanceof OrchestrationError) return error;
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new OrchestrationError({ code: 'CANCELLED', message: `${context}: request cancelled`, retryable: false });
    }
    if (error.name === 'TimeoutError') {
      return new OrchestrationError({ code: 'TIMEOUT', message: `${context}: request timed out`, retryable: true });
    }
    const nodeError = error as NodeJS.ErrnoException;
    if (typeof nodeError.code === 'string' && /^(ECONNREFUSED|ECONNRESET|EPIPE|ENOENT|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(nodeError.code)) {
      return new OrchestrationError({
        code: 'UNAVAILABLE',
        message: `${context}: Docker Engine unreachable (${nodeError.code}: ${error.message})`,
        retryable: true,
        details: { errno: nodeError.code },
      });
    }
  }
  return new OrchestrationError({
    code: 'INTERNAL',
    message: `${context}: ${error instanceof Error ? error.message : String(error)}`,
    retryable: false,
  });
}
