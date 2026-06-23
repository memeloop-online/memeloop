import { describe, expect, it, vi } from 'vitest';

const nativeCrypto = globalThis.crypto;
vi.stubGlobal('crypto', {
  getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
  randomUUID: () => 'q-1',
});

const waitForQuestionAnswer = vi.fn<(...parameters: unknown[]) => Promise<string>>();
vi.mock('../questionWaitRegistry.js', () => ({
  waitForQuestionAnswer: (...parameters: unknown[]) => waitForQuestionAnswer(...parameters),
}));

import { askQuestionImpl } from '../askQuestion.js';

describe('askQuestionImpl', () => {
  it('returns invalid args error', async () => {
    const r = await askQuestionImpl({}, {} as any);
    expect(r).toEqual({ error: 'invalid_askQuestion_args' });
  });

  it('notifies and returns result', async () => {
    waitForQuestionAnswer.mockResolvedValueOnce('yes');
    const notifyAskQuestion = vi.fn();
    const r = await askQuestionImpl({ question: 'Q1', conversationId: 'c1' }, {
      notifyAskQuestion,
    } as any);
    expect(notifyAskQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 'q-1', question: 'Q1', conversationId: 'c1' }),
    );
    expect(waitForQuestionAnswer).toHaveBeenCalledWith('q-1', 300_000);
    expect(r).toEqual({ result: 'yes' });
  });

  it('uses timeoutMs and returns wait error', async () => {
    waitForQuestionAnswer.mockRejectedValueOnce(new Error('askQuestion_timeout'));
    const r = await askQuestionImpl({ question: 'Q1', timeoutMs: 1234 }, {
      notifyAskQuestion: vi.fn(),
    } as any);
    expect(waitForQuestionAnswer).toHaveBeenCalledWith('q-1', 1234);
    expect(r).toEqual({ error: 'askQuestion_timeout' });
  });
});
