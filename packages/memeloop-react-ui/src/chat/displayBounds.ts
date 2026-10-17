import { type ConversationMessageDisplayTruncation, type ConversationMessageListProjection, extractAgentRunError, type WikiTiddlerContentProjection } from 'memeloop';

export const DEFAULT_RESIDENT_CONTENT_BYTE_LIMIT = 256 * 1024;
/** UI hard ceiling. Larger storage/RPC pages must be projected before rendering. */
export const MAX_RESIDENT_CONTENT_BYTE_LIMIT = DEFAULT_RESIDENT_CONTENT_BYTE_LIMIT;
export const DEFAULT_RESIDENT_RENDER_ROW_LIMIT = 4_000;
export const MAX_RESIDENT_RENDER_ROW_LIMIT = 12_000;
export const MAX_DISPLAY_MESSAGE_CHARACTERS = 32 * 1024;
export const MAX_DISPLAY_MESSAGE_RENDER_ROWS = 800;

const ESTIMATE_LIMIT = MAX_RESIDENT_CONTENT_BYTE_LIMIT + 1;
const MAX_ESTIMATE_NODES = 4_096;
const MAX_ESTIMATE_ARRAY_ITEMS = 128;
const MAX_ESTIMATE_SCANNED_STRING_CODE_UNITS = 256 * 1024;
const DISPLAY_METADATA_KEYS = [
  'agentId',
  'agentRunError',
  'askQuestionAnswered',
  'file',
  'displayTruncation',
  'isError',
  'originalRole',
  'toolId',
  'toolParameters',
  'wikiTiddlers',
] as const;

export type DisplayTruncationMetadata = ConversationMessageDisplayTruncation;

const DISPLAY_TRUNCATION_FIELDS = new Set([
  'truncated',
  'originalCharacterCount',
  'originalEstimatedBytes',
  'originalEstimatedRenderRows',
  'contentTruncated',
  'omittedFields',
  'capability',
]);
const DISPLAY_TRUNCATION_OMITTED_FIELDS = new Set(['parts', 'toolCalls', 'attachments', 'reasoning_content']);
const WIKI_CONTENT_PROJECTION_FIELDS = new Set(['truncated', 'originalUtf8Bytes', 'includedUtf8Bytes', 'code']);

interface Estimate {
  bytes: number;
  characters: number;
  rows: number;
}

function addEstimate(left: Estimate, right: Estimate, limit = ESTIMATE_LIMIT): Estimate {
  return {
    bytes: Math.min(limit, left.bytes + right.bytes),
    characters: Math.min(limit, left.characters + right.characters),
    rows: Math.min(limit, left.rows + right.rows),
  };
}

function saturatedEstimate(limit: number): Estimate {
  return { bytes: limit, characters: limit, rows: limit };
}

function estimateString(value: string, limit = ESTIMATE_LIMIT): Estimate {
  let lines = value.length > 0 ? 1 : 0;
  const scannedLength = Math.min(value.length, MAX_ESTIMATE_SCANNED_STRING_CODE_UNITS);
  let bytes = 0;
  for (let index = 0; index < scannedLength; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 10) lines += 1;
    if (codeUnit <= 0x7F) bytes += 1;
    else if (codeUnit <= 0x7FF) bytes += 2;
    else if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes >= limit) {
      bytes = limit;
      break;
    }
  }
  if (value.length > scannedLength) bytes = limit;
  return {
    bytes: Math.min(limit, bytes),
    characters: Math.min(limit, value.length),
    // Long unbroken output still creates layout work after wrapping.
    rows: Math.min(limit, Math.max(lines, Math.ceil(value.length / 100))),
  };
}

interface SafeOwnSnapshot {
  descriptors: Record<string, PropertyDescriptor>;
  keys: readonly string[];
}

function propertyDescriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor && 'value' in descriptor
    ? (descriptor as PropertyDescriptor & { value: unknown }).value
    : undefined;
}

/** Reads property descriptors only. Accessors, symbols and exotic prototypes fail closed. */
function safeOwnSnapshot(value: object, allowArray = false): SafeOwnSnapshot | undefined {
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (allowArray) {
      if (!Array.isArray(value) || prototype !== Array.prototype) return undefined;
    } else if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== 'string')) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) return undefined;
      if (key !== 'length' && !descriptor.enumerable) return undefined;
    }
    return { descriptors, keys: ownKeys as string[] };
  } catch {
    return undefined;
  }
}

function safeArrayValues(value: unknown): readonly unknown[] | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const snapshot = safeOwnSnapshot(value, true);
  const length = propertyDescriptorValue(snapshot?.descriptors.length);
  if (!snapshot || !Number.isSafeInteger(length) || (length as number) < 0) return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = snapshot.descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
    result.push(propertyDescriptorValue(descriptor));
  }
  if (snapshot.keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) return undefined;
  return result;
}

function safeArrayLength(value: object): number | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = propertyDescriptorValue(lengthDescriptor);
    return Number.isSafeInteger(length) && (length as number) >= 0 ? length as number : undefined;
  } catch {
    return undefined;
  }
}

function estimateUnknown(value: unknown, limit = ESTIMATE_LIMIT): Estimate {
  const pending: unknown[] = [value];
  const seen = new WeakSet();
  let visitedNodes = 0;
  let result: Estimate = { bytes: 0, characters: 0, rows: 0 };

  while (pending.length > 0) {
    if (visitedNodes >= MAX_ESTIMATE_NODES) return saturatedEstimate(limit);
    const current = pending.pop();
    visitedNodes += 1;
    if (typeof current === 'string') result = addEstimate(result, estimateString(current, limit), limit);
    else if (typeof current === 'number' || typeof current === 'boolean' || typeof current === 'bigint') {
      result = addEstimate(result, { bytes: 16, characters: String(current).length, rows: 1 }, limit);
    } else if (current === null || current === undefined || typeof current === 'symbol' || typeof current === 'function') {
      result = addEstimate(result, { bytes: 8, characters: 0, rows: 0 }, limit);
    } else {
      if (seen.has(current)) {
        result = addEstimate(result, { bytes: 16, characters: 10, rows: 1 }, limit);
        continue;
      }
      seen.add(current);
      result = addEstimate(result, { bytes: 32, characters: 0, rows: 1 }, limit);
      let isArray = false;
      try {
        isArray = Array.isArray(current);
      } catch {
        return saturatedEstimate(limit);
      }
      if (isArray) {
        const length = safeArrayLength(current);
        if (length === undefined) return saturatedEstimate(limit);
        // Account for container size before reading elements. Large dense and
        // sparse arrays therefore saturate immediately without a million-item loop.
        result = addEstimate(result, {
          bytes: Math.min(limit, length * 8),
          characters: Math.min(limit, length * 2),
          rows: Math.min(limit, length),
        }, limit);
        if (result.bytes >= limit || result.characters >= limit || result.rows >= limit) return saturatedEstimate(limit);
        const maximum = Math.min(length, MAX_ESTIMATE_ARRAY_ITEMS, MAX_ESTIMATE_NODES - visitedNodes);
        if (length > maximum) return saturatedEstimate(limit);
        const arrayValues = safeArrayValues(current);
        if (!arrayValues) return saturatedEstimate(limit);
        for (let index = maximum - 1; index >= 0; index -= 1) {
          pending.push(arrayValues[index]);
        }
      } else {
        const snapshot = safeOwnSnapshot(current);
        if (!snapshot) return saturatedEstimate(limit);
        let keysRead = 0;
        for (const key of snapshot.keys) {
          if (keysRead >= MAX_ESTIMATE_NODES - visitedNodes) return saturatedEstimate(limit);
          result = addEstimate(result, estimateString(key, limit), limit);
          pending.push(propertyDescriptorValue(snapshot.descriptors[key]));
          keysRead += 1;
          if (result.bytes >= limit || result.characters >= limit || result.rows >= limit) return saturatedEstimate(limit);
        }
      }
    }
    if (result.bytes >= limit || result.characters >= limit || result.rows >= limit) return saturatedEstimate(limit);
  }
  return result;
}

function estimateDisplayMetadata(metadata: Record<string, unknown> | undefined): Estimate {
  if (!metadata) return { bytes: 0, characters: 0, rows: 0 };
  const snapshot = safeOwnSnapshot(metadata);
  if (!snapshot) return saturatedEstimate(ESTIMATE_LIMIT);
  return DISPLAY_METADATA_KEYS.reduce((total, key) => {
    const descriptor = snapshot.descriptors[key];
    if (!descriptor || key === 'file') return total;
    return addEstimate(total, estimateUnknown(propertyDescriptorValue(descriptor)));
  }, { bytes: 0, characters: 0, rows: 0 });
}

export function estimateMessageDisplay(message: ConversationMessageListProjection): Estimate {
  const result = addEstimate(estimateString(message.content), estimateString(message.reasoning?.text ?? ''));
  return addEstimate(result, estimateDisplayMetadata(message.metadata));
}

export function estimateMessageDisplayBytes(message: ConversationMessageListProjection): number {
  return estimateMessageDisplay(message).bytes;
}

export function estimateMessageRenderRows(message: ConversationMessageListProjection): number {
  return estimateMessageDisplay(message).rows;
}

function unicodeSafeSlice(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let result = value.slice(0, Math.max(0, limit));
  const finalCodeUnit = result.charCodeAt(result.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) result = result.slice(0, -1);
  return result;
}

interface TextBudget {
  remaining: number;
  remainingRows?: number;
}

function unicodeSafeSliceForRows(value: string, characterLimit: number, rowLimit: number): string {
  if (rowLimit <= 0) return '';
  let rows = value.length > 0 ? 1 : 0;
  let column = 0;
  let index = 0;
  for (; index < value.length && index < characterLimit; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 10) {
      rows += 1;
      column = 0;
    } else {
      column += 1;
      if (column > 100) {
        rows += 1;
        column = 1;
      }
    }
    if (rows > rowLimit) break;
  }
  return unicodeSafeSlice(value, index);
}

function fitText(value: string, budget: TextBudget): { text: string; truncated: boolean } {
  const text = budget.remainingRows === undefined
    ? unicodeSafeSlice(value, budget.remaining)
    : unicodeSafeSliceForRows(value, budget.remaining, budget.remainingRows);
  budget.remaining = Math.max(0, budget.remaining - text.length);
  if (budget.remainingRows !== undefined) {
    budget.remainingRows = Math.max(0, budget.remainingRows - estimateString(text).rows);
  }
  return { text, truncated: text.length < value.length };
}

function displayOmission(kind: string, detailAvailable = false): Record<string, unknown> {
  return {
    __memeloopDisplayOmitted: true,
    kind,
    ...(detailAvailable ? { detailAvailable: true } : {}),
  };
}

function boundUnknown(value: unknown, characterLimit: number, kind: string): { value: unknown; truncated: boolean } {
  const estimate = estimateUnknown(value, characterLimit * 2 + 1);
  if (estimate.characters <= characterLimit && estimate.bytes <= characterLimit * 2) {
    return { value, truncated: false };
  }
  return { value: displayOmission(kind), truncated: true };
}

function boundMetadata(metadata: Record<string, unknown> | undefined): { metadata?: Record<string, unknown>; truncated: boolean } {
  if (!metadata) return { truncated: false };
  const snapshot = safeOwnSnapshot(metadata);
  if (!snapshot) return { metadata: {}, truncated: true };
  const result: Record<string, unknown> = {};
  let truncated = snapshot.keys.some(key => !DISPLAY_METADATA_KEYS.includes(key as typeof DISPLAY_METADATA_KEYS[number]) && key !== 'displayTruncation');
  for (const key of DISPLAY_METADATA_KEYS) {
    const descriptor = snapshot.descriptors[key];
    if (!descriptor) continue;
    const value = propertyDescriptorValue(descriptor);
    if (key === 'file') {
      // Browser File and host file handles must remain references; serialising
      // or cloning them would both be expensive and semantically wrong.
      result[key] = value;
    } else if (key === 'wikiTiddlers') {
      const values = safeArrayValues(value);
      if (!values) {
        truncated = true;
        continue;
      }
      result[key] = values.slice(0, 64).map(item => {
        if (!item || typeof item !== 'object') return undefined;
        const candidate = safeOwnSnapshot(item);
        if (!candidate) return undefined;
        const read = (name: string): unknown => propertyDescriptorValue(candidate.descriptors[name]);
        const renderedContent = read('renderedContent');
        const contentProjection = parseWikiTiddlerContentProjection(read('contentProjection'));
        if (read('contentProjection') !== undefined && contentProjection === undefined) truncated = true;
        return {
          workspaceId: read('workspaceId'),
          workspaceName: read('workspaceName'),
          tiddlerTitle: read('tiddlerTitle'),
          renderedContent: typeof renderedContent === 'string'
            ? unicodeSafeSlice(renderedContent, 1_024)
            : undefined,
          ...(contentProjection === undefined ? {} : { contentProjection }),
        };
      });
      if (
        values.length > 64 || values.slice(0, 64).some(item => {
          if (!item || typeof item !== 'object') return false;
          const itemSnapshot = safeOwnSnapshot(item);
          const renderedContent = propertyDescriptorValue(itemSnapshot?.descriptors.renderedContent);
          return typeof renderedContent === 'string' && renderedContent.length > 1_024;
        })
      ) truncated = true;
    } else if (key === 'displayTruncation') {
      const marker = parseDisplayTruncation(value);
      if (marker) result[key] = marker;
      else truncated = true;
    } else if (key === 'agentRunError') {
      const agentRunError = extractAgentRunError(value);
      if (agentRunError) result[key] = agentRunError;
      else truncated = true;
    } else {
      const bounded = boundUnknown(value, 4_096, `metadata-${key}`);
      result[key] = bounded.value;
      truncated ||= bounded.truncated;
    }
  }
  return { metadata: result, truncated };
}

function parseWikiTiddlerContentProjection(value: unknown): WikiTiddlerContentProjection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const snapshot = safeOwnSnapshot(value);
  if (
    !snapshot ||
    snapshot.keys.some(key => !WIKI_CONTENT_PROJECTION_FIELDS.has(key)) ||
    snapshot.keys.length < 3 || snapshot.keys.length > 4
  ) return undefined;
  const read = (key: string): unknown => propertyDescriptorValue(snapshot.descriptors[key]);
  const truncated = read('truncated');
  const originalUtf8Bytes = read('originalUtf8Bytes');
  const includedUtf8Bytes = read('includedUtf8Bytes');
  const code = read('code');
  if (
    typeof truncated !== 'boolean' ||
    !Number.isSafeInteger(originalUtf8Bytes) || (originalUtf8Bytes as number) < 0 ||
    !Number.isSafeInteger(includedUtf8Bytes) || (includedUtf8Bytes as number) < 0 ||
    (code !== undefined && code !== 'ATTACHMENT_CONTENT_TRUNCATED') ||
    (includedUtf8Bytes as number) > (originalUtf8Bytes as number)
  ) return undefined;
  return Object.freeze({
    truncated,
    originalUtf8Bytes: originalUtf8Bytes as number,
    includedUtf8Bytes: includedUtf8Bytes as number,
    ...(code === undefined ? {} : { code }),
  });
}

export function boundMessageForDisplay(
  message: ConversationMessageListProjection,
  characterLimit = MAX_DISPLAY_MESSAGE_CHARACTERS,
  renderRowLimit = MAX_DISPLAY_MESSAGE_RENDER_ROWS,
): ConversationMessageListProjection {
  return boundConversationMessageProjectionForDisplay(message, characterLimit, renderRowLimit);
}

/**
 * Bound the canonical resident row without materialising forbidden full-message
 * fields. Interactive adapters retain this exact Core projection end to end.
 */
export function boundConversationMessageProjectionForDisplay(
  message: ConversationMessageListProjection,
  characterLimit = MAX_DISPLAY_MESSAGE_CHARACTERS,
  renderRowLimit = MAX_DISPLAY_MESSAGE_RENDER_ROWS,
): ConversationMessageListProjection {
  const limit = Math.max(1_024, Math.min(characterLimit, MAX_DISPLAY_MESSAGE_CHARACTERS));
  const content = fitText(message.content, {
    remaining: Math.floor(limit * 0.8),
    remainingRows: Math.floor(renderRowLimit * 0.8),
  });
  const reasoning = message.reasoning === undefined
    ? undefined
    : fitText(message.reasoning.text, {
      remaining: Math.min(64 * 1_024, limit * 2),
      remainingRows: Math.max(1, renderRowLimit),
    });
  const boundedMetadata = boundMetadata(message.metadata);
  const previousTruncation = getDisplayTruncation(message);
  const contentEstimate = estimateString(message.content);
  const truncated = content.truncated || boundedMetadata.truncated;
  const reasoningProjection = message.reasoning === undefined || reasoning === undefined
    ? undefined
    : {
      text: reasoning.text,
      totalBytes: message.reasoning.totalBytes,
      hasMore: message.reasoning.hasMore || reasoning.truncated,
    };
  if (!truncated && reasoning?.truncated !== true) return message;
  const metadata = truncated
    ? {
      ...boundedMetadata.metadata,
      displayTruncation: {
        originalCharacterCount: previousTruncation?.originalCharacterCount ?? contentEstimate.characters,
        originalEstimatedBytes: previousTruncation?.originalEstimatedBytes ?? contentEstimate.bytes,
        originalEstimatedRenderRows: previousTruncation?.originalEstimatedRenderRows ?? contentEstimate.rows,
        truncated: true,
        contentTruncated: previousTruncation?.contentTruncated === true || content.truncated,
        omittedFields: previousTruncation?.omittedFields ?? [],
        capability: previousTruncation?.capability ?? (message.detailRef ? 'detail' : 'export'),
      } satisfies DisplayTruncationMetadata,
    }
    : message.metadata;
  return {
    ...message,
    content: content.text,
    ...(reasoningProjection === undefined ? {} : { reasoning: reasoningProjection }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** Read-only metadata capability shared by full durable messages and bounded list projections. */
export function getDisplayTruncation(
  message: Pick<ConversationMessageListProjection, 'metadata'>,
): DisplayTruncationMetadata | undefined {
  return parseDisplayTruncation(message.metadata?.displayTruncation);
}

function parseDisplayTruncation(value: unknown): DisplayTruncationMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const snapshot = safeOwnSnapshot(value);
  if (!snapshot || snapshot.keys.some(key => !DISPLAY_TRUNCATION_FIELDS.has(key)) || snapshot.keys.length !== DISPLAY_TRUNCATION_FIELDS.size) return undefined;
  const read = (key: string): unknown => propertyDescriptorValue(snapshot.descriptors[key]);
  const originalCharacterCount = read('originalCharacterCount');
  const originalEstimatedBytes = read('originalEstimatedBytes');
  const originalEstimatedRenderRows = read('originalEstimatedRenderRows');
  const contentTruncated = read('contentTruncated');
  const capability = read('capability');
  const rawOmittedFields = safeArrayValues(read('omittedFields'));
  if (
    read('truncated') !== true ||
    !Number.isSafeInteger(originalCharacterCount) || (originalCharacterCount as number) < 0 ||
    !Number.isSafeInteger(originalEstimatedBytes) || (originalEstimatedBytes as number) < 0 ||
    !Number.isSafeInteger(originalEstimatedRenderRows) || (originalEstimatedRenderRows as number) < 0 ||
    typeof contentTruncated !== 'boolean' ||
    (capability !== 'detail' && capability !== 'export') ||
    !rawOmittedFields || rawOmittedFields.length > DISPLAY_TRUNCATION_OMITTED_FIELDS.size ||
    rawOmittedFields.some(field => typeof field !== 'string' || !DISPLAY_TRUNCATION_OMITTED_FIELDS.has(field)) ||
    new Set(rawOmittedFields).size !== rawOmittedFields.length
  ) return undefined;
  const omittedFields = rawOmittedFields as ConversationMessageDisplayTruncation['omittedFields'];
  return Object.freeze({
    truncated: true,
    originalCharacterCount: originalCharacterCount as number,
    originalEstimatedBytes: originalEstimatedBytes as number,
    originalEstimatedRenderRows: originalEstimatedRenderRows as number,
    contentTruncated,
    omittedFields: Object.freeze([...omittedFields]) as ConversationMessageDisplayTruncation['omittedFields'],
    capability,
  });
}

export type DisplayTruncationAction = 'detail' | 'export';

export function resolveDisplayTruncationAction(
  message: ConversationMessageListProjection,
  capabilities: { detail: boolean; export: boolean },
): DisplayTruncationAction | undefined {
  const marker = getDisplayTruncation(message);
  if (!marker) return undefined;
  if (marker.capability === 'detail' && capabilities.detail) return 'detail';
  return capabilities.export ? 'export' : undefined;
}
