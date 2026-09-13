import { describe, expect, it } from 'vitest';

import { OrchestrationError, toOrchestrationErrorData } from '../errors.js';

describe('OrchestrationError', () => {
  it('preserves machine-readable retry and conflict details', () => {
    const error = new OrchestrationError({
      code: 'CONFLICT',
      message: 'resource version changed',
      retryable: true,
      retryAfterMs: 25,
      reason: 'ResourceVersionMismatch',
      details: { expected: '3', actual: '4' },
    });

    expect(error.toJSON()).toEqual({
      code: 'CONFLICT',
      message: 'resource version changed',
      retryable: true,
      retryAfterMs: 25,
      reason: 'ResourceVersionMismatch',
      details: { expected: '3', actual: '4' },
    });
  });

  it('normalizes unknown errors without making them retryable', () => {
    expect(toOrchestrationErrorData(new Error('unexpected'))).toEqual({
      code: 'INTERNAL',
      message: 'unexpected',
      retryable: false,
    });
  });

  it('allows a boundary to provide a retryable fallback code without stringifying hostile values', () => {
    expect(toOrchestrationErrorData('offline', { code: 'UNAVAILABLE', retryable: true })).toEqual({
      code: 'UNAVAILABLE',
      message: 'Orchestration request failed',
      retryable: true,
    });
  });
});
