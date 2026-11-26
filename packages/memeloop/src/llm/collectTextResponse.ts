import { NativeModelStreamAccumulator } from '../loopAPI/agent-tool-loop/nativeStreamAccumulator.js';
import type { PortableLlmStreamPart } from './response.js';

export type PortableLlmProviderResult =
  | string
  | PortableLlmStreamPart
  | AsyncIterable<PortableLlmStreamPart>;

/**
 * Collect a text-only provider response through the same bounded portable
 * stream accumulator used by the agent loop. Hosts should use this helper for
 * auxiliary one-shot text features instead of defining another stream DTO.
 */
export async function collectPortableLlmTextResponse(
  result: PortableLlmProviderResult,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (typeof result === 'string') return result;

  const accumulator = new NativeModelStreamAccumulator();
  if (isAsyncIterable(result)) {
    for await (const part of result) {
      signal?.throwIfAborted();
      accumulator.apply(part);
    }
  } else {
    accumulator.apply(result);
  }
  signal?.throwIfAborted();
  return accumulator.finalize().assistantText;
}

function isAsyncIterable(
  value: PortableLlmStreamPart | AsyncIterable<PortableLlmStreamPart>,
): value is AsyncIterable<PortableLlmStreamPart> {
  return Symbol.asyncIterator in value;
}
