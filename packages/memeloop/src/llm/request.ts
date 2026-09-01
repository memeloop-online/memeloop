/** Portable, SDK-independent model request contract. */

import { isProviderId } from './providerRegistry.js';

export const PORTABLE_LLM_REQUEST_LIMITS = Object.freeze(
  {
    messages: 4_096,
    tools: 256,
    contentParts: 1_024,
    toolResults: 1_024,
    textBytes: 8 * 1_024 * 1_024,
    identifierBytes: 512,
    urlBytes: 8_192,
    mediaTypeBytes: 256,
    filenameBytes: 1_024,
    fileBytes: 10 * 1_024 * 1_024,
    totalFileBytes: 16 * 1_024 * 1_024,
    jsonDepth: 16,
    jsonNodes: 20_000,
    jsonObjectKeys: 256,
    jsonArrayItems: 4_096,
    jsonStringBytes: 1 * 1_024 * 1_024,
    jsonBytes: 8 * 1_024 * 1_024,
    schemaBytes: 256 * 1_024,
    maxOutputTokens: 1_000_000,
  } as const,
);

export type PortableLlmJsonValue =
  | null
  | boolean
  | number
  | string
  | PortableLlmJsonValue[]
  | { [key: string]: PortableLlmJsonValue };

export type PortableLlmFileData =
  | { type: 'bytes'; bytes: Uint8Array }
  | { type: 'url'; url: string }
  | { type: 'provider-reference'; provider: string; id: string }
  | { type: 'text'; text: string };

export interface PortableLlmTextPart {
  type: 'text';
  text: string;
}

export interface PortableLlmReasoningPart {
  type: 'reasoning';
  text: string;
}

export interface PortableLlmImagePart {
  type: 'image';
  data: PortableLlmFileData;
  mediaType?: string;
}

export interface PortableLlmFilePart {
  type: 'file';
  data: PortableLlmFileData;
  mediaType: string;
  filename?: string;
}

export interface PortableLlmToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: PortableLlmJsonValue;
}

export interface PortableLlmToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output:
    | { type: 'text'; value: string }
    | { type: 'error-text'; value: string }
    | { type: 'json'; value: PortableLlmJsonValue }
    | { type: 'error-json'; value: PortableLlmJsonValue };
}

export type PortableLlmMessage =
  | { role: 'system'; content: string }
  | {
    role: 'user';
    content: string | Array<PortableLlmTextPart | PortableLlmImagePart | PortableLlmFilePart>;
  }
  | {
    role: 'assistant';
    content:
      | string
      | Array<
        PortableLlmTextPart | PortableLlmReasoningPart | PortableLlmFilePart | PortableLlmToolCallPart
      >;
  }
  | { role: 'tool'; content: PortableLlmToolResultPart[] };

export interface PortableLlmStructuredOutput {
  type: 'json';
  schema: Record<string, PortableLlmJsonValue>;
  name?: string;
  description?: string;
}

export interface PortableLlmToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, PortableLlmJsonValue>;
}

export type PortableLlmToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'tool'; toolName: string };

export interface PortableLlmRequest {
  providerId: string;
  /** Logical catalog alias retained for routing and audit; never sent to the provider. */
  logicalModelId: string;
  /** Exact model identity sent to the provider. */
  wireModelId: string;
  apiMode: 'chat-completions' | 'responses';
  messages: PortableLlmMessage[];
  tools?: PortableLlmToolDefinition[];
  toolChoice?: PortableLlmToolChoice;
  conversationId?: string;
  stream?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  providerOptions?: Record<string, Record<string, PortableLlmJsonValue>>;
  output?: PortableLlmStructuredOutput;
  signal?: AbortSignal;
}

interface ValidationState {
  active: WeakSet<object>;
  jsonNodes: number;
  jsonBytes: number;
  textBytes: number;
  totalFileBytes: number;
}

const textEncoder = new TextEncoder();
const MIME_TYPE_PATTERN = /^[!#$%&'*+.^_`|~\dA-Za-z-]+\/(?:\*|[!#$%&'*+.^_`|~\dA-Za-z-]+)$/;

export function assertPortableLlmRequest(value: unknown): asserts value is PortableLlmRequest {
  const state: ValidationState = {
    active: new WeakSet(),
    jsonNodes: 0,
    jsonBytes: 0,
    textBytes: 0,
    totalFileBytes: 0,
  };
  if (
    !isRecordWithKeys(value, [
      'providerId',
      'logicalModelId',
      'wireModelId',
      'apiMode',
      'messages',
      'tools',
      'toolChoice',
      'conversationId',
      'stream',
      'maxOutputTokens',
      'temperature',
      'topP',
      'providerOptions',
      'output',
      'signal',
    ])
  ) throw new TypeError('invalid portable LLM request');
  if (
    !isProviderId(value.providerId) ||
    !isIdentifier(value.logicalModelId) ||
    !isIdentifier(value.wireModelId)
  ) {
    throw new TypeError('invalid portable LLM provider/model');
  }
  if (value.apiMode !== 'chat-completions' && value.apiMode !== 'responses') {
    throw new TypeError('invalid portable LLM apiMode');
  }
  if (
    !isStrictArray(
      value.messages,
      PORTABLE_LLM_REQUEST_LIMITS.messages,
      message => isMessage(message, state),
    )
  ) throw new TypeError('invalid portable LLM messages');
  let sawNonSystemMessage = false;
  for (const message of value.messages as PortableLlmMessage[]) {
    if (message.role === 'system' && sawNonSystemMessage) {
      throw new TypeError('portable LLM system messages must precede conversation messages');
    }
    if (message.role !== 'system') sawNonSystemMessage = true;
  }
  if (
    value.tools !== undefined &&
    !isStrictArray(value.tools, PORTABLE_LLM_REQUEST_LIMITS.tools, tool => isToolDefinition(tool, state))
  ) throw new TypeError('invalid portable LLM tools');
  if (value.toolChoice !== undefined && !isToolChoice(value.toolChoice)) {
    throw new TypeError('invalid portable LLM toolChoice');
  }
  if (value.conversationId !== undefined && !isIdentifier(value.conversationId)) {
    throw new TypeError('invalid portable LLM conversationId');
  }
  if (value.stream !== undefined && typeof value.stream !== 'boolean') {
    throw new TypeError('invalid portable LLM stream setting');
  }
  const maxOutputTokens = value.maxOutputTokens;
  if (
    maxOutputTokens !== undefined &&
    (typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 || maxOutputTokens > PORTABLE_LLM_REQUEST_LIMITS.maxOutputTokens)
  ) throw new TypeError('invalid portable LLM maxOutputTokens');
  if (
    value.temperature !== undefined &&
    (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) ||
      value.temperature < 0 || value.temperature > 2)
  ) throw new TypeError('invalid portable LLM temperature');
  if (
    value.topP !== undefined &&
    (typeof value.topP !== 'number' || !Number.isFinite(value.topP) ||
      value.topP < 0 || value.topP > 1)
  ) throw new TypeError('invalid portable LLM topP');
  if (value.providerOptions !== undefined && !isProviderOptions(value.providerOptions, state)) {
    throw new TypeError('invalid portable LLM providerOptions');
  }
  if (value.output !== undefined && !isStructuredOutput(value.output, state)) {
    throw new TypeError('invalid portable LLM output');
  }
  if (value.signal !== undefined && !isAbortSignal(value.signal)) {
    throw new TypeError('invalid portable LLM signal');
  }
  if (state.totalFileBytes > PORTABLE_LLM_REQUEST_LIMITS.totalFileBytes) {
    throw new TypeError('portable LLM file bytes exceed request limit');
  }
}

/** Validate one strict, bounded JSON value without accepting SDK-native objects. */
export function assertPortableLlmJsonValue(value: unknown): asserts value is PortableLlmJsonValue {
  const state: ValidationState = {
    active: new WeakSet(),
    jsonNodes: 0,
    jsonBytes: 0,
    textBytes: 0,
    totalFileBytes: 0,
  };
  if (!isJsonValue(value, state)) throw new TypeError('invalid portable LLM JSON value');
}

function isMessage(value: unknown, state: ValidationState): value is PortableLlmMessage {
  if (!isRecordWithKeys(value, ['role', 'content'])) return false;
  if (value.role === 'system') return isText(value.content, state);
  if (value.role === 'user') {
    return isText(value.content, state) || isParts(
      value.content,
      state,
      part => isTextPart(part, state) || isImagePart(part, state) || isFilePart(part, state),
    );
  }
  if (value.role === 'assistant') {
    return isText(value.content, state) || isParts(
      value.content,
      state,
      part =>
        isTextPart(part, state) || isReasoningPart(part, state) || isFilePart(part, state) ||
        isToolCallPart(part, state),
    );
  }
  return value.role === 'tool' && isStrictArray(
    value.content,
    PORTABLE_LLM_REQUEST_LIMITS.toolResults,
    part => isToolResultPart(part, state),
  );
}

function isParts(
  value: unknown,
  state: ValidationState,
  predicate: (part: unknown, state: ValidationState) => boolean,
): boolean {
  return isStrictArray(
    value,
    PORTABLE_LLM_REQUEST_LIMITS.contentParts,
    part => predicate(part, state),
  );
}

function isTextPart(value: unknown, state: ValidationState): value is PortableLlmTextPart {
  return isRecordWithKeys(value, ['type', 'text']) && value.type === 'text' &&
    isText(value.text, state);
}

function isReasoningPart(value: unknown, state: ValidationState): value is PortableLlmReasoningPart {
  return isRecordWithKeys(value, ['type', 'text']) && value.type === 'reasoning' &&
    isText(value.text, state);
}

function isImagePart(value: unknown, state: ValidationState): value is PortableLlmImagePart {
  return isRecordWithKeys(value, ['type', 'data', 'mediaType']) && value.type === 'image' &&
    isFileData(value.data, state) && value.data.type !== 'text' &&
    (value.mediaType === undefined || isMediaType(value.mediaType));
}

function isFilePart(value: unknown, state: ValidationState): value is PortableLlmFilePart {
  return isRecordWithKeys(value, ['type', 'data', 'mediaType', 'filename']) &&
    value.type === 'file' && isFileData(value.data, state) && isMediaType(value.mediaType) &&
    (value.filename === undefined || isFilename(value.filename));
}

function isFileData(value: unknown, state: ValidationState): value is PortableLlmFileData {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'bytes') {
    if (
      !hasExactKeys(value, ['type', 'bytes']) || !(value.bytes instanceof Uint8Array) ||
      value.bytes.byteLength > PORTABLE_LLM_REQUEST_LIMITS.fileBytes
    ) return false;
    state.totalFileBytes += value.bytes.byteLength;
    return true;
  }
  if (value.type === 'url') {
    if (
      !hasExactKeys(value, ['type', 'url']) ||
      !isBoundedString(value.url, PORTABLE_LLM_REQUEST_LIMITS.urlBytes, false)
    ) return false;
    try {
      const parsed = new URL(value.url);
      return parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
  if (value.type === 'provider-reference') {
    return hasExactKeys(value, ['type', 'provider', 'id']) &&
      isIdentifier(value.provider) && isIdentifier(value.id);
  }
  return value.type === 'text' && hasExactKeys(value, ['type', 'text']) &&
    isText(value.text, state);
}

function isToolCallPart(value: unknown, state: ValidationState): value is PortableLlmToolCallPart {
  return isRecordWithKeys(value, ['type', 'toolCallId', 'toolName', 'input']) &&
    value.type === 'tool-call' && isIdentifier(value.toolCallId) &&
    isIdentifier(value.toolName) && Object.hasOwn(value, 'input') &&
    isJsonValue(value.input, state);
}

function isToolResultPart(value: unknown, state: ValidationState): value is PortableLlmToolResultPart {
  if (
    !isRecordWithKeys(value, ['type', 'toolCallId', 'toolName', 'output']) ||
    value.type !== 'tool-result' || !isIdentifier(value.toolCallId) ||
    !isIdentifier(value.toolName) || !isPlainRecord(value.output)
  ) return false;
  const output = value.output;
  if (!hasExactKeys(output, ['type', 'value'])) return false;
  if (output.type === 'text' || output.type === 'error-text') return isText(output.value, state);
  return (output.type === 'json' || output.type === 'error-json') &&
    isJsonValue(output.value, state);
}

function isProviderOptions(value: unknown, state: ValidationState): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > PORTABLE_LLM_REQUEST_LIMITS.jsonObjectKeys) return false;
  return keys.every(provider => {
    if (typeof provider !== 'string' || !isIdentifier(provider)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, provider);
    return descriptor !== undefined && descriptor.enumerable &&
      !('get' in descriptor) && !('set' in descriptor) &&
      isPlainRecord(descriptor.value) && isJsonValue(descriptor.value, state);
  });
}

function isToolDefinition(value: unknown, state: ValidationState): boolean {
  return isRecordWithKeys(value, ['name', 'description', 'inputSchema']) &&
    isIdentifier(value.name) &&
    (value.description === undefined || isText(value.description, state)) &&
    isPlainRecord(value.inputSchema) && isJsonValue(value.inputSchema, state) &&
    textEncoder.encode(JSON.stringify(value.inputSchema)).byteLength <=
      PORTABLE_LLM_REQUEST_LIMITS.schemaBytes;
}

function isToolChoice(value: unknown): value is PortableLlmToolChoice {
  return value === 'auto' || value === 'none' || value === 'required' ||
    isRecordWithKeys(value, ['type', 'toolName']) && value.type === 'tool' &&
      isIdentifier(value.toolName);
}

function isStructuredOutput(value: unknown, state: ValidationState): boolean {
  if (
    !isRecordWithKeys(value, ['type', 'schema', 'name', 'description']) ||
    value.type !== 'json' || !isPlainRecord(value.schema)
  ) return false;
  const before = state.jsonNodes;
  if (!isJsonValue(value.schema, state)) return false;
  const schemaBytes = textEncoder.encode(JSON.stringify(value.schema)).byteLength;
  return state.jsonNodes > before && schemaBytes <= PORTABLE_LLM_REQUEST_LIMITS.schemaBytes &&
    (value.name === undefined || isIdentifier(value.name)) &&
    (value.description === undefined || isText(value.description, state));
}

function isJsonValue(value: unknown, state: ValidationState, depth = 0): value is PortableLlmJsonValue {
  state.jsonNodes += 1;
  if (
    state.jsonNodes > PORTABLE_LLM_REQUEST_LIMITS.jsonNodes ||
    depth > PORTABLE_LLM_REQUEST_LIMITS.jsonDepth
  ) return false;
  if (value === null) return consumeJsonBytes(state, 4);
  if (typeof value === 'boolean') return consumeJsonBytes(state, value ? 4 : 5);
  if (typeof value === 'string') {
    const bytes = textEncoder.encode(value).byteLength;
    return bytes <= PORTABLE_LLM_REQUEST_LIMITS.jsonStringBytes &&
      consumeJsonBytes(state, bytes);
  }
  // JSON numbers are IEEE-754 finite values, not integers. This deliberately
  // accepts decimals, exponents, and finite values outside the safe-integer
  // range. JSON serialization gives -0 the same wire representation as 0.
  if (typeof value === 'number') {
    return Number.isFinite(value) && consumeJsonBytes(state, String(value).length);
  }
  if (typeof value !== 'object' || state.active.has(value)) return false;
  state.active.add(value);
  let valid = false;
  if (Array.isArray(value)) {
    valid = isStrictArray(
      value,
      PORTABLE_LLM_REQUEST_LIMITS.jsonArrayItems,
      item => isJsonValue(item, state, depth + 1),
    );
  } else if (isPlainRecord(value)) {
    const keys = Reflect.ownKeys(value);
    valid = keys.length <= PORTABLE_LLM_REQUEST_LIMITS.jsonObjectKeys && keys.every(key => {
      if (typeof key !== 'string' || !isIdentifier(key)) return false;
      if (!consumeJsonBytes(state, textEncoder.encode(key).byteLength)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable &&
        !('get' in descriptor) && !('set' in descriptor) &&
        isJsonValue(descriptor.value, state, depth + 1);
    });
  }
  state.active.delete(value);
  return valid;
}

function consumeJsonBytes(state: ValidationState, bytes: number): boolean {
  state.jsonBytes += bytes;
  return state.jsonBytes <= PORTABLE_LLM_REQUEST_LIMITS.jsonBytes;
}

function isText(value: unknown, state: ValidationState): value is string {
  if (typeof value !== 'string') return false;
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes > PORTABLE_LLM_REQUEST_LIMITS.textBytes) return false;
  state.textBytes += bytes;
  return state.textBytes <= PORTABLE_LLM_REQUEST_LIMITS.textBytes;
}

function isIdentifier(value: unknown): value is string {
  return isBoundedString(value, PORTABLE_LLM_REQUEST_LIMITS.identifierBytes, false) &&
    !containsAsciiControl(value);
}

function isMediaType(value: unknown): value is string {
  return isBoundedString(value, PORTABLE_LLM_REQUEST_LIMITS.mediaTypeBytes, false) &&
    MIME_TYPE_PATTERN.test(value);
}

function isFilename(value: unknown): value is string {
  return isBoundedString(value, PORTABLE_LLM_REQUEST_LIMITS.filenameBytes, false) &&
    !containsAsciiControl(value) && !value.includes('/') && !value.includes('\\') &&
    value !== '.' && value !== '..';
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isBoundedString(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) &&
    textEncoder.encode(value).byteLength <= maxBytes;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function' &&
    typeof (value as AbortSignal).throwIfAborted === 'function';
}

function isRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value) && hasExactKeys(value, keys, true);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): boolean {
  const allowed = new Set(keys);
  const actual = Reflect.ownKeys(value);
  if (actual.some(key => typeof key !== 'string' || !allowed.has(key))) return false;
  if (!optional && keys.some(key => !Object.hasOwn(value, key))) return false;
  return actual.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable &&
      !('get' in descriptor) && !('set' in descriptor);
  });
}

function isStrictArray(
  value: unknown,
  maximum: number,
  predicate: (item: unknown) => boolean,
): value is unknown[] {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined || !descriptor.enumerable ||
      'get' in descriptor || 'set' in descriptor || !predicate(descriptor.value)
    ) return false;
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
