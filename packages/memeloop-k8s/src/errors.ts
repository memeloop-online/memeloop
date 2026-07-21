import { OrchestrationError } from 'memeloop';
import type { OrchestrationErrorCode } from 'memeloop';

/**
 * Map a Kubernetes API HTTP status to a core {@link OrchestrationError}.
 *
 * | HTTP      | Code        | Retryable |
 * | --------- | ----------- | --------- |
 * | 400 / 422 | INVALID     | no        |
 * | 401 / 403 | FORBIDDEN   | no        |
 * | 404       | NOT_FOUND   | no        |
 * | 409       | CONFLICT    | no        |
 * | 429       | EXHAUSTED   | yes       |
 * | 5xx       | UNAVAILABLE | yes       |
 */
export function kubernetesStatusError(
  statusCode: number,
  message: string,
  context: string,
  retryAfterSeconds?: number,
): OrchestrationError {
  let code: OrchestrationErrorCode;
  let retryable = false;
  if (statusCode === 400 || statusCode === 422) {
    code = 'INVALID';
  } else if (statusCode === 401 || statusCode === 403) {
    code = 'FORBIDDEN';
  } else if (statusCode === 404) {
    code = 'NOT_FOUND';
  } else if (statusCode === 409) {
    code = 'CONFLICT';
  } else if (statusCode === 429) {
    code = 'EXHAUSTED';
    retryable = true;
  } else if (statusCode >= 500) {
    code = 'UNAVAILABLE';
    retryable = true;
  } else {
    code = 'INTERNAL';
  }
  return new OrchestrationError({
    code,
    message: `${context}: Kubernetes API responded ${statusCode}: ${message}`,
    retryable,
    ...(retryAfterSeconds !== undefined ? { retryAfterMs: retryAfterSeconds * 1000 } : {}),
    details: { statusCode },
  });
}

/**
 * Normalize any failure thrown by the API client into an
 * {@link OrchestrationError}. Aborts map to `CANCELLED`, driver-side deadline
 * aborts map to `TIMEOUT`, and transport failures (connection refused, TLS
 * errors, DNS failures) map to retryable `UNAVAILABLE`.
 */
export function toK8sDriverError(error: unknown, context: string): OrchestrationError {
  if (error instanceof OrchestrationError) return error;
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new OrchestrationError({ code: 'CANCELLED', message: `${context}: request cancelled`, retryable: false });
    }
    if (error.name === 'TimeoutError') {
      return new OrchestrationError({ code: 'TIMEOUT', message: `${context}: request timed out`, retryable: true });
    }
    const nodeError = error as NodeJS.ErrnoException;
    if (
      typeof nodeError.code === 'string' &&
      /^(ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED)$/
        .test(nodeError.code)
    ) {
      return new OrchestrationError({
        code: 'UNAVAILABLE',
        message: `${context}: Kubernetes API unreachable (${nodeError.code}: ${error.message})`,
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
