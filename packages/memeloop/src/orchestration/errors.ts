export const ORCHESTRATION_ERROR_CODES = [
  'UNSUPPORTED',
  'FORBIDDEN',
  'CONFLICT',
  'STALE_EPOCH',
  'NOT_FOUND',
  'INVALID',
  'EXHAUSTED',
  'UNAVAILABLE',
  'TIMEOUT',
  'CANCELLED',
  'UNKNOWN_EFFECT',
  'WATCH_COMPACTED',
  'INTERNAL',
] as const;

export type OrchestrationErrorCode = typeof ORCHESTRATION_ERROR_CODES[number];

export interface OrchestrationErrorData {
  code: OrchestrationErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  reason?: string;
  details?: Record<string, unknown>;
}

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly reason?: string;
  readonly details?: Record<string, unknown>;

  constructor(data: OrchestrationErrorData) {
    super(data.message);
    this.name = 'OrchestrationError';
    this.code = data.code;
    this.retryable = data.retryable;
    this.retryAfterMs = data.retryAfterMs;
    this.reason = data.reason;
    this.details = data.details;
  }

  toJSON(): OrchestrationErrorData {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      reason: this.reason,
      details: this.details,
    };
  }
}

export function isOrchestrationError(error: unknown): error is OrchestrationError {
  return error instanceof OrchestrationError;
}

export function toOrchestrationErrorData(
  error: unknown,
  fallback: Pick<OrchestrationErrorData, 'code' | 'retryable'> = {
    code: 'INTERNAL',
    retryable: false,
  },
): OrchestrationErrorData {
  if (isOrchestrationError(error)) return error.toJSON();
  return {
    ...fallback,
    message: error instanceof Error ? error.message : String(error),
  };
}
