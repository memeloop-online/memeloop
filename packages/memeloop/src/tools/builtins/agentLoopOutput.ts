import type { AgentLoopStep } from '../../loopAPI/types.js';

/** Drain a child-agent stream while retaining cancellation and iterator ownership. */
export async function collectAgentLoopText(
  source: AsyncIterable<AgentLoopStep>,
  signal?: AbortSignal,
): Promise<string> {
  const chunks: string[] = [];
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  let returned = false;
  const returnIterator = async (): Promise<void> => {
    if (returned) return;
    returned = true;
    await iterator.return?.();
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const item = await waitForAbortable(iterator.next(), signal);
      signal?.throwIfAborted();
      if (item.done) {
        completed = true;
        break;
      }
      const text = messageStepText(item.value);
      if (text !== undefined) chunks.push(text);
    }
  } finally {
    if (!completed) await returnIterator();
  }
  return chunks.join('').trim() || '(no text output)';
}

function messageStepText(step: AgentLoopStep): string | undefined {
  if (step.type !== 'message') return undefined;
  if (typeof step.data === 'string') return step.data;
  if (!step.data || typeof step.data !== 'object') return undefined;
  if ((step.data as { type?: unknown }).type === 'text-delta') {
    const text = (step.data as { text?: unknown }).text;
    return typeof text === 'string' ? text : undefined;
  }
  if ('content' in step.data) {
    const content = (step.data as { content?: unknown }).content;
    return typeof content === 'string' ? content : undefined;
  }
  return undefined;
}

function waitForAbortable<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Agent loop output failed'));
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation aborted', 'AbortError');
}
