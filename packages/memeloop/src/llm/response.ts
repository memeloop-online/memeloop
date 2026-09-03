import { assertPortableLlmJsonValue, type PortableLlmJsonValue, type PortableLlmToolResultPart } from './request.js';

export type PortableLlmStreamProtocolErrorCode =
  | 'LLM_STREAM_TRUNCATED'
  | 'LLM_STREAM_INVALID_USAGE'
  | 'LLM_STREAM_DUPLICATE_USAGE'
  | 'LLM_STREAM_DUPLICATE_FINISH'
  | 'LLM_STREAM_DATA_AFTER_FINISH'
  /** AI SDK content cannot be represented by the portable response contract. */
  | 'LLM_STREAM_UNSUPPORTED_PART';

export class PortableLlmStreamProtocolError extends Error {
  public readonly name = 'PortableLlmStreamProtocolError';

  public constructor(
    public readonly code: PortableLlmStreamProtocolErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

export type PortableLlmStreamPart =
  | { type: 'text-delta'; id: string; text: string }
  | { type: 'reasoning-delta'; id: string; text: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-delta'; toolCallId: string; delta: string }
  | { type: 'tool-input-end'; toolCallId: string }
  | {
    type: 'tool-call';
    toolCallId: string;
    toolName: string;
    input: PortableLlmJsonValue;
  }
  | PortableLlmToolResultPart
  | { type: 'structured-output'; output: PortableLlmJsonValue }
  | {
    type: 'usage';
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  }
  | { type: 'finish'; finishReason: string };

export const PORTABLE_LLM_STREAM_LIMITS = Object.freeze(
  {
    partBytes: 2 * 1_024 * 1_024,
    deltaBytes: 1 * 1_024 * 1_024,
    aggregateBytes: 16 * 1_024 * 1_024,
    toolInputBytes: 1 * 1_024 * 1_024,
    toolCalls: 256,
    openToolInputs: 256,
    // Allows the adversarial one-byte-delta case while keeping CPU bounded.
    parts: 1_100_000,
  } as const,
);

const MAX_IDENTIFIER_BYTES = 512;
const textEncoder = new TextEncoder();

export function assertPortableLlmStreamPart(value: unknown): asserts value is PortableLlmStreamPart {
  if (!isPlainRecord(value)) {
    throw new TypeError('invalid portable LLM stream part');
  }
  const part = value;
  let byteLength = 0;
  switch (part.type) {
    case 'text-delta':
    case 'reasoning-delta':
      requireKeys(part, ['type', 'id', 'text']);
      if (!isIdentifier(part.id) || !isText(part.text)) throw new TypeError('invalid text delta');
      byteLength = utf8Bytes(part.id) + utf8Bytes(part.text);
      break;
    case 'tool-input-start':
      requireKeys(part, ['type', 'toolCallId', 'toolName']);
      if (!isIdentifier(part.toolCallId) || !isIdentifier(part.toolName)) {
        throw new TypeError('invalid tool input start');
      }
      byteLength = utf8Bytes(part.toolCallId) + utf8Bytes(part.toolName);
      break;
    case 'tool-input-delta':
      requireKeys(part, ['type', 'toolCallId', 'delta']);
      if (!isIdentifier(part.toolCallId) || !isText(part.delta)) {
        throw new TypeError('invalid tool input delta');
      }
      byteLength = utf8Bytes(part.toolCallId) + utf8Bytes(part.delta);
      break;
    case 'tool-input-end':
      requireKeys(part, ['type', 'toolCallId']);
      if (!isIdentifier(part.toolCallId)) throw new TypeError('invalid tool input end');
      byteLength = utf8Bytes(part.toolCallId);
      break;
    case 'tool-call':
      requireKeys(part, ['type', 'toolCallId', 'toolName', 'input']);
      if (!isIdentifier(part.toolCallId) || !isIdentifier(part.toolName)) {
        throw new TypeError('invalid tool call');
      }
      assertPortableLlmJsonValue(part.input);
      byteLength = utf8Bytes(part.toolCallId) + utf8Bytes(part.toolName) + jsonBytes(part.input);
      break;
    case 'tool-result':
      requireKeys(part, ['type', 'toolCallId', 'toolName', 'output']);
      if (!isIdentifier(part.toolCallId) || !isIdentifier(part.toolName)) {
        throw new TypeError('invalid tool result');
      }
      assertToolResultOutput(part.output);
      byteLength = utf8Bytes(part.toolCallId) + utf8Bytes(part.toolName) + jsonBytes(part.output);
      break;
    case 'structured-output':
      requireKeys(part, ['type', 'output']);
      assertPortableLlmJsonValue(part.output);
      byteLength = jsonBytes(part.output);
      break;
    case 'usage':
      requireKeys(part, [
        'type',
        ...['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens']
          .filter(key => Object.hasOwn(part, key)),
      ]);
      for (
        const key of [
          'inputTokens',
          'outputTokens',
          'totalTokens',
          'cachedInputTokens',
          'reasoningTokens',
        ] as const
      ) {
        const count = part[key];
        if (
          count !== undefined &&
          (typeof count !== 'number' || !Number.isSafeInteger(count) ||
            count < 0 || count > 1_000_000_000_000_000)
        ) throw new TypeError('invalid portable LLM usage');
      }
      byteLength = 128;
      break;
    case 'finish':
      requireKeys(part, ['type', 'finishReason']);
      if (!isIdentifier(part.finishReason)) throw new TypeError('invalid finish reason');
      byteLength = utf8Bytes(part.finishReason);
      break;
    default:
      throw new TypeError('unsupported portable LLM stream part');
  }
  if (byteLength > PORTABLE_LLM_STREAM_LIMITS.partBytes) {
    throw new TypeError('portable LLM stream part exceeds byte limit');
  }
}

function requireKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some(key => typeof key !== 'string' || !expected.includes(key)) ||
    keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !descriptor.enumerable ||
        'get' in descriptor || 'set' in descriptor;
    })
  ) {
    throw new TypeError('invalid portable LLM stream part fields');
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    textEncoder.encode(value).byteLength <= MAX_IDENTIFIER_BYTES &&
    !containsAsciiControl(value);
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' &&
    textEncoder.encode(value).byteLength <= PORTABLE_LLM_STREAM_LIMITS.deltaBytes;
}

function assertToolResultOutput(value: unknown): void {
  if (!isPlainRecord(value)) throw new TypeError('invalid tool result output');
  requireKeys(value, ['type', 'value']);
  if (value.type === 'text' || value.type === 'error-text') {
    if (!isText(value.value)) throw new TypeError('invalid tool result text output');
    return;
  }
  if (value.type !== 'json' && value.type !== 'error-json') {
    throw new TypeError('invalid tool result output type');
  }
  assertPortableLlmJsonValue(value.value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function jsonBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}
