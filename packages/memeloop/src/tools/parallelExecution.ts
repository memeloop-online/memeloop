/**
 * TidGi `parallelExecution.ts` 迁移。
 */
import type { ToolCallingMatch } from '../promptUtilities/responsePatternUtility.js';
import { safeErrorMessageFromUnknown } from '../safeError.js';
import type { ToolExecutionResult } from './defineToolTypes.js';

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_TIMEOUT_MS = 120_000;

export interface ToolCallEntry {
  call: ToolCallingMatch & { found: true };
  executor: (
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ToolExecutionResult>;
  timeoutMs?: number;
}

export interface ToolCallResult {
  call: ToolCallingMatch & { found: true };
  status: 'fulfilled' | 'rejected' | 'timeout';
  result?: ToolExecutionResult;
  error?: string;
}

async function executeWithTimeout(
  entry: ToolCallEntry,
  batchSignal?: AbortSignal,
): Promise<ToolCallResult> {
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const controller = new AbortController();
  const abortFromBatch = () => {
    controller.abort(batchSignal?.reason);
  };
  batchSignal?.addEventListener('abort', abortFromBatch, { once: true });
  if (batchSignal?.aborted) abortFromBatch();

  return new Promise<ToolCallResult>((resolve) => {
    let settled = false;

    const finish = (result: ToolCallResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      batchSignal?.removeEventListener('abort', abortFromBatch);
      resolve(result);
    };

    const onAbort = () => {
      const reason: unknown = controller.signal.reason;
      const isTimeout = hasOwnTimeoutErrorName(reason);
      finish({
        call: entry.call,
        status: isTimeout ? 'timeout' : 'rejected',
        error: safeErrorMessageFromUnknown(reason, { fallback: 'Tool execution aborted' }),
      });
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        const error = new Error(`Tool "${entry.call.toolId}" timed out after ${timeoutMs}ms`);
        error.name = 'TimeoutError';
        controller.abort(error);
        finish({ call: entry.call, status: 'timeout', error: error.message });
      }, timeoutMs)
      : undefined;

    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();

    entry
      .executor(entry.call.parameters ?? {}, controller.signal)
      .then((result) => {
        finish({ call: entry.call, status: 'fulfilled', result });
      })
      .catch((error: unknown) => {
        const message = safeErrorMessageFromUnknown(error, { fallback: 'Tool execution failed' });
        finish({
          call: entry.call,
          status: 'rejected',
          result: {
            success: false,
            error: message,
          },
          error: message,
        });
      });
  });
}

function hasOwnTimeoutErrorName(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'name');
    return descriptor !== undefined && 'value' in descriptor && descriptor.value === 'TimeoutError';
  } catch {
    return false;
  }
}

export async function executeToolCallsParallel(
  entries: ToolCallEntry[],
  batchTimeoutMs: number = DEFAULT_BATCH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ToolCallResult[]> {
  if (entries.length === 0) return [];
  if (entries.length === 1) {
    return [await executeWithTimeout(entries[0], signal)];
  }

  const batchController = new AbortController();
  const abortFromParent = () => {
    batchController.abort(signal?.reason);
  };
  signal?.addEventListener('abort', abortFromParent, { once: true });
  if (signal?.aborted) abortFromParent();
  const timer = batchTimeoutMs > 0
    ? setTimeout(() => {
      const error = new Error(`Batch timeout: ${batchTimeoutMs}ms exceeded`);
      error.name = 'TimeoutError';
      batchController.abort(error);
    }, batchTimeoutMs)
    : undefined;
  try {
    return await Promise.all(entries.map(entry => executeWithTimeout(entry, batchController.signal)));
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

export async function executeToolCallsSequential(
  entries: ToolCallEntry[],
  signal?: AbortSignal,
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];
  for (const entry of entries) {
    results.push(await executeWithTimeout(entry, signal));
    if (signal?.aborted) break;
  }
  return results;
}
