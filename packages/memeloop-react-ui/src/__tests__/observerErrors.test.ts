import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearMemeLoopObserverFailures, getMemeLoopObserverFailures, notifyMemeLoopObserver } from '../chat/observerErrors.js';

afterEach(() => {
  clearMemeLoopObserverFailures();
});

describe('MemeLoop observer failure reporting', () => {
  it('keeps the primary UI operation alive and forwards observer failures to the secondary hook', () => {
    const onObserverError = vi.fn();
    expect(() => {
      notifyMemeLoopObserver(
        () => {
          throw new Error('primary observer failed');
        },
        'test.onError',
        'send-message',
        onObserverError,
      );
    }).not.toThrow();

    expect(onObserverError).toHaveBeenCalledWith(expect.objectContaining({
      source: 'test.onError',
      operation: 'send-message',
      error: expect.objectContaining({ message: 'primary observer failed' }),
    }));
    expect(getMemeLoopObserverFailures()).toHaveLength(1);
  });

  it('records a secondary observer failure without relying on console output', () => {
    notifyMemeLoopObserver(
      () => {
        throw new Error('primary observer failed');
      },
      'test.onError',
      'send-message',
      () => {
        throw new Error('secondary observer failed');
      },
    );

    expect(getMemeLoopObserverFailures().map(failure => failure.error.message)).toEqual([
      'primary observer failed',
      'secondary observer failed',
    ]);
  });
});
