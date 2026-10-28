interface PendingQuestion {
  resolve(answer: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
}

export const QUESTION_WAIT_LIMITS = Object.freeze({
  maxQuestionIdBytes: 1_024,
  maxAnswerBytes: 256 * 1_024,
  maxTimeoutMs: 24 * 60 * 60 * 1_000,
});

const textEncoder = new TextEncoder();

/** Runtime-scoped question wait lifecycle with collision and cancellation safety. */
export class QuestionWaitBroker {
  private readonly pending = new Map<string, PendingQuestion>();
  private disposed = false;

  public resolveQuestionAnswer(questionId: string, answer: string): boolean {
    validateQuestionId(questionId);
    validateAnswer(answer);
    const pending = this.pending.get(questionId);
    if (!pending) return false;
    return this.settle(questionId, pending, () => {
      pending.resolve(answer);
    });
  }

  public waitForQuestionAnswer(
    questionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      validateQuestionId(questionId);
      validateTimeout(timeoutMs);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('questionId is invalid'));
    }
    if (this.disposed) return Promise.reject(new Error('question_wait_broker_disposed'));
    if (this.pending.has(questionId)) {
      return Promise.reject(new Error(`question_id_collision: ${questionId}`));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const pending: PendingQuestion = {
        resolve,
        reject,
        settled: false,
        signal,
        timer: setTimeout(() => {
          this.settle(questionId, pending, () => {
            reject(new Error('askQuestion_timeout'));
          });
        }, timeoutMs),
      };
      if (signal) {
        pending.abortListener = () => {
          this.settle(questionId, pending, () => {
            reject(abortReason(signal));
          });
        };
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.pending.set(questionId, pending);
    });
  }

  public cancelAll(reason = new Error('question_wait_cancelled')): void {
    for (const [questionId, pending] of [...this.pending]) {
      this.settle(questionId, pending, () => {
        pending.reject(reason);
      });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll(new Error('question_wait_broker_disposed'));
  }

  private settle(
    questionId: string,
    pending: PendingQuestion,
    completion: () => void,
  ): boolean {
    if (pending.settled || this.pending.get(questionId) !== pending) return false;
    pending.settled = true;
    this.pending.delete(questionId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    completion();
    return true;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('question_wait_cancelled');
}

function validateQuestionId(questionId: string): void {
  if (
    typeof questionId !== 'string' || questionId.length === 0 ||
    questionId !== questionId.trim() || hasControlCharacters(questionId) ||
    textEncoder.encode(questionId).byteLength > QUESTION_WAIT_LIMITS.maxQuestionIdBytes
  ) throw new TypeError('questionId is invalid');
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

function validateAnswer(answer: string): void {
  if (
    typeof answer !== 'string' ||
    textEncoder.encode(answer).byteLength > QUESTION_WAIT_LIMITS.maxAnswerBytes
  ) throw new TypeError('question answer exceeds the size limit');
}

function validateTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
    timeoutMs > QUESTION_WAIT_LIMITS.maxTimeoutMs
  ) throw new TypeError('question timeoutMs is outside the supported range');
}
