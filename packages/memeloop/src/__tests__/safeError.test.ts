import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SAFE_ERROR_MESSAGE, safeErrorFromUnknown, safeErrorMessageFromUnknown } from '../safeError.js';

describe('safeErrorMessageFromUnknown', () => {
  it('reads only an own string data-property', () => {
    expect(safeErrorMessageFromUnknown(new Error('provider failed'))).toBe('provider failed');
    expect(safeErrorMessageFromUnknown({ message: 'plugin failed' })).toBe('plugin failed');
    expect(safeErrorMessageFromUnknown('raw thrown text')).toBe(DEFAULT_SAFE_ERROR_MESSAGE);
    expect(safeErrorMessageFromUnknown(Object.create({ message: 'inherited' }))).toBe(DEFAULT_SAFE_ERROR_MESSAGE);
  });

  it('never invokes getters, proxy traps beyond the descriptor lookup, or toString', () => {
    const getter = vi.fn(() => 'leaked');
    const toString = vi.fn(() => 'leaked');
    const accessor = Object.defineProperty({ toString }, 'message', { get: getter });
    expect(safeErrorMessageFromUnknown(accessor)).toBe(DEFAULT_SAFE_ERROR_MESSAGE);
    expect(getter).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();

    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('descriptor trap');
      },
    });
    expect(safeErrorMessageFromUnknown(hostile)).toBe(DEFAULT_SAFE_ERROR_MESSAGE);
  });

  it('redacts secret-shaped values', () => {
    expect(safeErrorMessageFromUnknown(new Error('upstream rejected sk-1234567890abcdef')))
      .toBe('upstream rejected [REDACTED]');
    expect(safeErrorMessageFromUnknown(new Error('Authorization: Bearer abcdef123456789')))
      .toBe('Authorization: Bearer [REDACTED]');
  });

  it('rejects invalid Unicode and messages exceeding the UTF-8 byte limit', () => {
    expect(safeErrorMessageFromUnknown(new Error('\ud800'), { fallback: 'safe' })).toBe('safe');
    expect(safeErrorMessageFromUnknown(new Error('界界'), { fallback: 'safe', maxBytes: 5 })).toBe('safe');
    expect(safeErrorMessageFromUnknown(new Error('界'), { fallback: 'safe', maxBytes: 3 })).toBe('界');
  });

  it('falls back to the built-in generic text when configured fallback is hostile', () => {
    expect(safeErrorMessageFromUnknown({}, { fallback: '\udfff' })).toBe(DEFAULT_SAFE_ERROR_MESSAGE);
    const options = Object.defineProperty({}, 'fallback', {
      get() {
        throw new Error('must not run');
      },
    });
    expect(safeErrorMessageFromUnknown({}, options)).toBe(DEFAULT_SAFE_ERROR_MESSAGE);
  });

  it('creates an Error without retaining the hostile object as a cause', () => {
    const hostile = { message: 'failed', secret: 'must not be retained' };
    const error = safeErrorFromUnknown(hostile);
    expect(error.message).toBe('failed');
    expect(error).not.toHaveProperty('cause');
  });
});
