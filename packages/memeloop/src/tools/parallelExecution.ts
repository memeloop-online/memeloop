/**
 * TidGi `parallelExecution.ts` 迁移。
 */
import type { ToolCallingMatch } from "../promptUtilities/responsePatternUtility.js";
import type { ToolExecutionResult } from "./defineToolTypes.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_TIMEOUT_MS = 120_000;

export interface ToolCallEntry {
  call: ToolCallingMatch & { found: true };
  executor: (parameters: Record<string, unknown>) => Promise<ToolExecutionResult>;
  timeoutMs?: number;
}

export interface ToolCallResult {
  call: ToolCallingMatch & { found: true };
  status: "fulfilled" | "rejected" | "timeout";
  result?: ToolExecutionResult;
  error?: string;
}

async function executeWithTimeout(entry: ToolCallEntry): Promise<ToolCallResult> {
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  return new Promise<ToolCallResult>((resolve) => {
    let settled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (!settled) {
              settled = true;
              resolve({
                call: entry.call,
                status: "timeout",
                error: `Tool "${entry.call.toolId}" timed out after ${timeoutMs}ms`,
              });
            }
          }, timeoutMs)
        : undefined;

    entry
      .executor(entry.call.parameters ?? {})
      .then((result) => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ call: entry.call, status: "fulfilled", result });
        }
      })
      .catch((error: unknown) => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({
            call: entry.call,
            status: "rejected",
            result: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
  });
}

export async function executeToolCallsParallel(
  entries: ToolCallEntry[],
  batchTimeoutMs: number = DEFAULT_BATCH_TIMEOUT_MS,
): Promise<ToolCallResult[]> {
  if (entries.length === 0) return [];
  if (entries.length === 1) {
    return [await executeWithTimeout(entries[0])];
  }

  const promises = entries.map((entry) => executeWithTimeout(entry));

  if (batchTimeoutMs > 0) {
    const batchTimer = new Promise<ToolCallResult[]>((resolve) => {
      setTimeout(() => {
        resolve(
          entries.map((entry) => ({
            call: entry.call,
            status: "timeout" as const,
            error: `Batch timeout: ${batchTimeoutMs}ms exceeded`,
          })),
        );
      }, batchTimeoutMs);
    });

    return Promise.race([Promise.all(promises), batchTimer]);
  }

  return Promise.all(promises);
}

export async function executeToolCallsSequential(
  entries: ToolCallEntry[],
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];
  for (const entry of entries) {
    results.push(await executeWithTimeout(entry));
  }
  return results;
}
