type Pending = {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();

export function resolveQuestionAnswer(questionId: string, answer: string): boolean {
  const p = pending.get(questionId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(questionId);
  p.resolve(answer);
  return true;
}

export function waitForQuestionAnswer(questionId: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(questionId);
      reject(new Error("askQuestion_timeout"));
    }, timeoutMs);
    pending.set(questionId, { resolve, reject, timer });
  });
}
