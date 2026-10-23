import { describe, expect, it, vi } from 'vitest';

import { QUESTION_WAIT_LIMITS, QuestionWaitBroker } from '../questionWaitRegistry.js';

describe('questionWaitRegistry', () => {
  it('resolveQuestionAnswer returns false for unknown id', () => {
    expect(new QuestionWaitBroker().resolveQuestionAnswer('missing', 'x')).toBe(false);
  });

  it('waitForQuestionAnswer resolves when answer is provided', async () => {
    const broker = new QuestionWaitBroker();
    const p = broker.waitForQuestionAnswer('q-2', 1000);
    expect(broker.resolveQuestionAnswer('q-2', 'ok')).toBe(true);
    await expect(p).resolves.toBe('ok');
  });

  it('waitForQuestionAnswer times out', async () => {
    vi.useFakeTimers();
    try {
      const p = new QuestionWaitBroker().waitForQuestionAnswer('q-3', 10);
      const assertion = expect(p).rejects.toThrow('askQuestion_timeout');
      await vi.advanceTimersByTimeAsync(11);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates identical question IDs between runtimes', async () => {
    const first = new QuestionWaitBroker();
    const second = new QuestionWaitBroker();
    const firstAnswer = first.waitForQuestionAnswer('same-id', 1000);
    const secondAnswer = second.waitForQuestionAnswer('same-id', 1000);

    expect(first.resolveQuestionAnswer('same-id', 'first')).toBe(true);
    await expect(firstAnswer).resolves.toBe('first');
    expect(second.resolveQuestionAnswer('same-id', 'second')).toBe(true);
    await expect(secondAnswer).resolves.toBe('second');
  });

  it('rejects collisions, aborts once, and ignores late answers', async () => {
    const broker = new QuestionWaitBroker();
    const controller = new AbortController();
    const answer = broker.waitForQuestionAnswer('q', 1000, controller.signal);
    await expect(broker.waitForQuestionAnswer('q', 1000)).rejects.toThrow('question_id_collision');
    controller.abort(new Error('caller_cancelled'));
    await expect(answer).rejects.toThrow('caller_cancelled');
    expect(broker.resolveQuestionAnswer('q', 'late')).toBe(false);
  });

  it('disposes all waiters and rejects future waits', async () => {
    const broker = new QuestionWaitBroker();
    const answer = broker.waitForQuestionAnswer('q', 1000);
    broker.dispose();
    await expect(answer).rejects.toThrow('question_wait_broker_disposed');
    await expect(broker.waitForQuestionAnswer('later', 1000))
      .rejects.toThrow('question_wait_broker_disposed');
  });

  it('enforces exact identifier, answer, and timeout bounds without orphaning waits', async () => {
    const broker = new QuestionWaitBroker();
    const maxId = 'q'.repeat(QUESTION_WAIT_LIMITS.maxQuestionIdBytes);
    const maxAnswer = 'a'.repeat(QUESTION_WAIT_LIMITS.maxAnswerBytes);
    const answer = broker.waitForQuestionAnswer(
      maxId,
      QUESTION_WAIT_LIMITS.maxTimeoutMs,
    );
    expect(() => broker.resolveQuestionAnswer(maxId, `${maxAnswer}x`))
      .toThrow('size limit');
    expect(broker.resolveQuestionAnswer(maxId, maxAnswer)).toBe(true);
    await expect(answer).resolves.toBe(maxAnswer);

    await expect(broker.waitForQuestionAnswer(`${maxId}x`, 1_000))
      .rejects.toThrow('questionId');
    await expect(broker.waitForQuestionAnswer('bad\nid', 1_000))
      .rejects.toThrow('questionId');
    await expect(broker.waitForQuestionAnswer(
      'huge-timeout',
      QUESTION_WAIT_LIMITS.maxTimeoutMs + 1,
    )).rejects.toThrow('supported range');
    await expect(broker.waitForQuestionAnswer('overflow', 1e300))
      .rejects.toThrow('supported range');
    expect(broker.resolveQuestionAnswer('huge-timeout', 'late')).toBe(false);
  });
});
