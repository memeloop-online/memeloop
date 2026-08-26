import { assertPortableLlmStreamPart, type PortableLlmStreamPart, PortableLlmStreamProtocolError } from './response.js';

export async function* translateSdkFullStream(
  source: AsyncIterable<unknown>,
  options: {
    signal?: AbortSignal;
    getStreamingError?: () => unknown;
  } = {},
): AsyncGenerator<PortableLlmStreamPart, void, unknown> {
  let sawFinish = false;
  for await (const chunk of source) {
    options.signal?.throwIfAborted();
    const parts = toPortableStreamParts(chunk);
    if (sawFinish) {
      throw new PortableLlmStreamProtocolError(
        parts.some(part => part.type === 'finish')
          ? 'LLM_STREAM_DUPLICATE_FINISH'
          : 'LLM_STREAM_DATA_AFTER_FINISH',
      );
    }
    for (const part of parts) {
      assertPortableLlmStreamPart(part);
      if (part.type === 'finish') {
        if (sawFinish) throw new PortableLlmStreamProtocolError('LLM_STREAM_DUPLICATE_FINISH');
        sawFinish = true;
      }
      yield part;
    }
  }
  const streamingError = options.getStreamingError?.();
  if (streamingError !== undefined) {
    throw streamingError instanceof Error
      ? streamingError
      : new Error('The model stream failed', { cause: streamingError });
  }
  if (!sawFinish) throw new PortableLlmStreamProtocolError('LLM_STREAM_TRUNCATED');
}

/** Internal AI SDK -> portable stream boundary. Kept out of package exports. */
export function toPortableStreamParts(chunk: unknown): PortableLlmStreamPart[] {
  if (!isPlainSdkChunk(chunk)) throw new TypeError('invalid AI SDK stream chunk');
  const type = readSdkChunkField(chunk, 'type');
  if (typeof type !== 'string') throw new TypeError('invalid AI SDK stream chunk type');
  switch (type) {
    case 'text-delta':
    case 'reasoning-delta': {
      const id = requireSdkChunkString(chunk, 'id', type);
      const value = requireSdkChunkString(chunk, 'text', type);
      return [{ type, id, text: value }];
    }
    case 'tool-input-start':
      return [{
        type: 'tool-input-start',
        toolCallId: requireSdkChunkString(chunk, 'id', type),
        toolName: requireSdkChunkString(chunk, 'toolName', type),
      }];
    case 'tool-input-delta':
      return [{
        type: 'tool-input-delta',
        toolCallId: requireSdkChunkString(chunk, 'id', type),
        delta: requireSdkChunkString(chunk, 'delta', type),
      }];
    case 'tool-input-end':
      return [{
        type: 'tool-input-end',
        toolCallId: requireSdkChunkString(chunk, 'id', type),
      }];
    case 'tool-call':
      return [{
        type: 'tool-call',
        toolCallId: requireSdkChunkString(chunk, 'toolCallId', type),
        toolName: requireSdkChunkString(chunk, 'toolName', type),
        input: readSdkChunkField(chunk, 'input') as never,
      }];
    case 'finish': {
      const usage = toPortableUsage(readSdkChunkField(chunk, 'totalUsage'));
      return [usage, {
        type: 'finish',
        finishReason: requireSdkChunkString(chunk, 'finishReason', type),
      }];
    }
    case 'abort':
      throw new DOMException('The model stream was aborted', 'AbortError');
    case 'error':
    case 'tool-error':
      throw new Error('The model stream failed');
    default:
      return [];
  }
}

function toPortableUsage(value: unknown): Extract<PortableLlmStreamPart, { type: 'usage' }> {
  if (!isPlainSdkChunk(value)) throw new TypeError('invalid AI SDK stream usage');
  const inputTokens = readOptionalSdkChunkField(value, 'inputTokens');
  const outputTokens = readOptionalSdkChunkField(value, 'outputTokens');
  const totalTokens = readOptionalSdkChunkField(value, 'totalTokens');
  const inputDetails = readOptionalSdkChunkField(value, 'inputTokenDetails');
  const outputDetails = readOptionalSdkChunkField(value, 'outputTokenDetails');
  const cachedInputTokens = inputDetails === undefined
    ? undefined
    : readOptionalNestedUsage(inputDetails, 'cacheReadTokens');
  const reasoningTokens = outputDetails === undefined
    ? undefined
    : readOptionalNestedUsage(outputDetails, 'reasoningTokens');
  return {
    type: 'usage',
    ...(inputTokens === undefined ? {} : { inputTokens: requireUsageCount(inputTokens) }),
    ...(outputTokens === undefined ? {} : { outputTokens: requireUsageCount(outputTokens) }),
    ...(totalTokens === undefined ? {} : { totalTokens: requireUsageCount(totalTokens) }),
    ...(cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: requireUsageCount(cachedInputTokens) }),
    ...(reasoningTokens === undefined
      ? {}
      : { reasoningTokens: requireUsageCount(reasoningTokens) }),
  };
}

function readOptionalNestedUsage(value: unknown, key: string): unknown {
  if (!isPlainSdkChunk(value)) throw new TypeError('invalid AI SDK nested stream usage');
  return readOptionalSdkChunkField(value, key);
}

function requireUsageCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new PortableLlmStreamProtocolError('LLM_STREAM_INVALID_USAGE');
  }
  return Number(value);
}

function isPlainSdkChunk(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function readSdkChunkField(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined || !descriptor.enumerable ||
    'get' in descriptor || 'set' in descriptor
  ) throw new TypeError(`invalid AI SDK stream chunk field '${key}'`);
  return descriptor.value;
}

function readOptionalSdkChunkField(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
    throw new TypeError(`invalid AI SDK stream chunk field '${key}'`);
  }
  return descriptor.value;
}

function requireSdkChunkString(
  value: Record<string, unknown>,
  key: string,
  type: string,
): string {
  const field = readSdkChunkField(value, key);
  if (typeof field !== 'string') {
    throw new TypeError(`invalid AI SDK ${type} chunk field '${key}'`);
  }
  return field;
}
