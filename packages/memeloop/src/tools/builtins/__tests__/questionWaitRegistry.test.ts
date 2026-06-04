import { describe, expect, it, vi } from 'vitest';

import { resolveQuestionAnswer, waitForQuestionAnswer } from '../questionWaitRegistry.js';

describe('questionWaitRegistry', () => {
  it('resolveQuestionAnswer returns false for unknown id', () => {
    expect(resolveQuestionAnswer('missing', 'x')).toBe(false);
  });

  it('waitForQuestionAnswer resolves when answer is provided', async () => {
    const p = waitForQuestionAnswer('q-2', 1000);
    expect(resolveQuestionAnswer('q-2', 'ok')).toBe(true);
    await expect(p).resolves.toBe('ok');
  });

  it('waitForQuestionAnswer times out', async () => {
    vi.useFakeTimers();
    try {
      const p = waitForQuestionAnswer('q-3', 10);
      const assertion = expect(p).rejects.toThrow('askQuestion_timeout');
      await vi.advanceTimersByTimeAsync(11);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
