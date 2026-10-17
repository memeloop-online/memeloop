import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import type {
  PromptPreviewAuditDetailChunk,
  PromptPreviewAuditDetailRequest,
  PromptPreviewAuditDetailTarget,
  PromptPreviewAuditEntrySummary,
  PromptPreviewAuditPage,
  PromptPreviewAuditPageRequest,
  PromptPreviewAuditReleaseRequest,
  PromptPreviewGeneratedResult,
  PromptPreviewPreparedExecution,
} from './types.js';
import {
  MAX_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES,
  MAX_PROMPT_PREVIEW_AUDIT_ENTRY_PREVIEW_CODE_UNITS,
  MAX_PROMPT_PREVIEW_AUDIT_PAGE_BYTES,
  MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES,
  MAX_PROMPT_PREVIEW_GENERATED_RESULT_BYTES,
  MIN_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES,
  MIN_PROMPT_PREVIEW_AUDIT_PAGE_BYTES,
} from './types.js';

export type PromptPreviewAuditErrorCode =
  | 'capacity_exceeded'
  | 'entry_not_found'
  | 'invalid_cursor'
  | 'invalid_request'
  | 'invalid_response'
  | 'session_not_found'
  | 'stale_revision';

/** Stable fail-closed error for renderer/host prompt-audit boundaries. */
export class PromptPreviewAuditError extends Error {
  public constructor(public readonly code: PromptPreviewAuditErrorCode, cause?: unknown) {
    super(`prompt_preview_audit_${code}`, cause === undefined ? undefined : { cause });
    this.name = 'PromptPreviewAuditError';
  }
}

export interface PromptPreviewAuditPageAssertionOptions {
  expectedSessionId?: string;
  expectedRevision?: string;
  maxBytes?: number;
  maxEntries?: number;
}

export function assertPromptPreviewPreparedExecution(
  value: unknown,
): asserts value is PromptPreviewPreparedExecution {
  try {
    assertRecordKeys(value, ['sessionId', 'revision', 'route', 'contextStats', 'initialPage']);
    const execution = value;
    assertOpaque(execution.sessionId);
    assertOpaque(execution.revision);
    assertRecordKeys(execution.route, ['providerId', 'logicalModelId', 'wireModelId', 'apiMode']);
    const route = execution.route;
    assertBoundedText(route.providerId, 512);
    assertBoundedText(route.logicalModelId, 512);
    assertBoundedText(route.wireModelId, 512);
    if (route.apiMode !== 'chat-completions' && route.apiMode !== 'responses') throw new Error();
    assertRecordKeys(execution.contextStats, ['messageCount', 'compactionSummaryCount']);
    const stats = execution.contextStats;
    assertCount(stats.messageCount);
    assertCount(stats.compactionSummaryCount);
    if ((stats.compactionSummaryCount as number) > (stats.messageCount as number)) throw new Error();
    assertPromptPreviewAuditPage(execution.initialPage, {
      expectedSessionId: execution.sessionId as string,
      expectedRevision: execution.revision as string,
    });
    strictCanonicalSize(value, MAX_PROMPT_PREVIEW_AUDIT_PAGE_BYTES);
  } catch (error) {
    if (error instanceof PromptPreviewAuditError) throw error;
    throw new PromptPreviewAuditError('invalid_response', error);
  }
}

export function assertPromptPreviewAuditPageRequest(
  value: unknown,
): asserts value is PromptPreviewAuditPageRequest {
  try {
    if (!isPlainRecord(value)) throw new Error();
    const mode = readDataProperty(value, 'mode');
    const keys = mode === 'around'
      ? ['sessionId', 'expectedRevision', 'mode', 'entryIndex', 'limit', 'maxBytes']
      : ['sessionId', 'expectedRevision', 'mode', 'cursor', 'limit', 'maxBytes'];
    assertRecordKeys(value, keys);
    assertOpaque(readDataProperty(value, 'sessionId'));
    assertOpaque(readDataProperty(value, 'expectedRevision'));
    assertPageBounds(readDataProperty(value, 'limit'), readDataProperty(value, 'maxBytes'));
    if (mode === 'around') assertIndex(readDataProperty(value, 'entryIndex'));
    else {
      if (mode !== 'before' && mode !== 'after') throw new Error();
      assertOpaque(readDataProperty(value, 'cursor'));
    }
    strictCanonicalSize(value, 4_096);
  } catch (error) {
    if (error instanceof PromptPreviewAuditError) throw error;
    throw new PromptPreviewAuditError('invalid_request', error);
  }
}

export function assertPromptPreviewAuditPage(
  value: unknown,
  options: PromptPreviewAuditPageAssertionOptions = {},
): asserts value is PromptPreviewAuditPage {
  try {
    assertRecordKeys(value, [
      'sessionId',
      'revision',
      'items',
      'totalEntries',
      'previousCursor',
      'nextCursor',
      'hasMoreBefore',
      'hasMoreAfter',
      'sampled',
    ]);
    const page = value;
    assertOpaque(page.sessionId);
    assertOpaque(page.revision);
    if (options.expectedSessionId !== undefined && page.sessionId !== options.expectedSessionId) {
      throw new PromptPreviewAuditError('stale_revision');
    }
    if (options.expectedRevision !== undefined && page.revision !== options.expectedRevision) {
      throw new PromptPreviewAuditError('stale_revision');
    }
    if (!Array.isArray(page.items)) throw new Error();
    const maxEntries = Math.min(
      options.maxEntries ?? MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES,
      MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES,
    );
    if (page.items.length > maxEntries) throw new Error();
    for (const item of page.items) assertEntrySummary(item);
    assertCount(page.totalEntries);
    for (const item of page.items as PromptPreviewAuditEntrySummary[]) {
      if (item.entryIndex >= (page.totalEntries as number)) throw new Error();
    }
    if (page.previousCursor !== undefined) assertOpaque(page.previousCursor);
    if (page.nextCursor !== undefined) assertOpaque(page.nextCursor);
    if (
      typeof page.hasMoreBefore !== 'boolean' || typeof page.hasMoreAfter !== 'boolean' ||
      typeof page.sampled !== 'boolean'
    ) throw new Error();
    if (page.hasMoreBefore && page.previousCursor === undefined) throw new Error();
    if (page.hasMoreAfter && page.nextCursor === undefined) throw new Error();
    strictCanonicalSize(
      value,
      Math.min(options.maxBytes ?? MAX_PROMPT_PREVIEW_AUDIT_PAGE_BYTES, MAX_PROMPT_PREVIEW_AUDIT_PAGE_BYTES),
    );
  } catch (error) {
    if (error instanceof PromptPreviewAuditError) throw error;
    throw new PromptPreviewAuditError('invalid_response', error);
  }
}

export function assertPromptPreviewAuditDetailRequest(
  value: unknown,
): asserts value is PromptPreviewAuditDetailRequest {
  try {
    assertRecordKeys(value, ['sessionId', 'expectedRevision', 'target', 'cursor', 'maxBytes']);
    const request = value;
    assertOpaque(request.sessionId);
    assertOpaque(request.expectedRevision);
    assertDetailTarget(request.target);
    if (request.cursor !== undefined) assertOpaque(request.cursor);
    assertPositiveBound(
      request.maxBytes,
      MAX_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES,
      MIN_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES,
    );
    strictCanonicalSize(value, 8_192);
  } catch (error) {
    if (error instanceof PromptPreviewAuditError) throw error;
    throw new PromptPreviewAuditError('invalid_request', error);
  }
}

export function assertPromptPreviewAuditDetailChunk(
  value: unknown,
  request: PromptPreviewAuditDetailRequest,
): asserts value is PromptPreviewAuditDetailChunk {
  try {
    assertRecordKeys(value, [
      'sessionId',
      'revision',
      'target',
      'canonicalUtf8',
      'nextCursor',
      'complete',
    ]);
    const chunk = value;
    if (chunk.sessionId !== request.sessionId || chunk.revision !== request.expectedRevision) {
      throw new PromptPreviewAuditError('stale_revision');
    }
    assertDetailTarget(chunk.target);
    if (!targetsEqual(chunk.target, request.target)) throw new Error();
    if (
      !(chunk.canonicalUtf8 instanceof Uint8Array) ||
      Object.getPrototypeOf(chunk.canonicalUtf8) !== Uint8Array.prototype ||
      chunk.canonicalUtf8.byteLength > request.maxBytes ||
      chunk.canonicalUtf8.byteLength > MAX_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES
    ) throw new Error();
    // Each chunk must independently be valid UTF-8. Hosts split at code-point boundaries.
    new TextDecoder('utf-8', { fatal: true }).decode(chunk.canonicalUtf8);
    if (typeof chunk.complete !== 'boolean') throw new Error();
    if (chunk.nextCursor !== undefined) assertOpaque(chunk.nextCursor);
    if (chunk.complete !== (chunk.nextCursor === undefined)) throw new Error();
  } catch (error) {
    if (error instanceof PromptPreviewAuditError) throw error;
    throw new PromptPreviewAuditError('invalid_response', error);
  }
}

export function assertPromptPreviewAuditReleaseRequest(
  value: unknown,
): asserts value is PromptPreviewAuditReleaseRequest {
  try {
    assertRecordKeys(value, ['sessionId', 'expectedRevision']);
    const request = value;
    assertOpaque(request.sessionId);
    assertOpaque(request.expectedRevision);
  } catch (error) {
    throw new PromptPreviewAuditError('invalid_request', error);
  }
}

export function assertPromptPreviewGeneratedResult(
  value: unknown,
): asserts value is PromptPreviewGeneratedResult {
  try {
    assertRecordKeys(value, ['flatPrompts', 'processedPrompts']);
    const result = value;
    if (!Array.isArray(result.flatPrompts) || !Array.isArray(result.processedPrompts)) throw new Error();
    for (const message of result.flatPrompts) assertPromptFlatModelMessage(message);
    for (const prompt of result.processedPrompts) assertPromptNode(prompt, 0);
    strictCanonicalSize(value, MAX_PROMPT_PREVIEW_GENERATED_RESULT_BYTES);
  } catch (error) {
    throw new PromptPreviewAuditError('invalid_response', error);
  }
}

function assertPromptFlatModelMessage(value: unknown): void {
  assertRecordKeys(value, ['role', 'content']);
  if (!['system', 'user', 'assistant', 'tool'].includes(value.role as string)) throw new Error();
  if (!Object.hasOwn(value, 'content')) throw new Error();
}

function assertPromptNode(value: unknown, depth: number): void {
  if (depth > 64) throw new Error();
  assertRecordKeys(value, ['id', 'text', 'caption', 'role', 'enabled', 'children', 'source', 'dynamicPosition']);
  assertBoundedText(value.id, 512);
  if (value.text !== undefined) assertBoundedText(value.text, 1_000_000, true, true);
  if (value.caption !== undefined) assertBoundedText(value.caption, 16_384, true);
  if (value.role !== undefined && !['system', 'user', 'assistant', 'tool'].includes(value.role as string)) throw new Error();
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error();
  if (value.dynamicPosition !== undefined && value.dynamicPosition !== 'deferToEnd') throw new Error();
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) throw new Error();
    for (const child of value.children) assertPromptNode(child, depth + 1);
  }
}

function assertEntrySummary(value: unknown): asserts value is PromptPreviewAuditEntrySummary {
  assertRecordKeys(value, [
    'entryId',
    'entryIndex',
    'role',
    'source',
    'preview',
    'canonicalBytes',
  ]);
  const item = value;
  assertOpaque(item.entryId);
  assertIndex(item.entryIndex);
  if (!['system', 'user', 'assistant', 'tool'].includes(item.role as string)) throw new Error();
  if (
    ![
      'system',
      'prompt',
      'context-compaction-summary',
      'conversation-message',
      'preview-input',
      'tool',
    ].includes(item.source as string)
  ) throw new Error();
  assertBoundedText(item.preview, MAX_PROMPT_PREVIEW_AUDIT_ENTRY_PREVIEW_CODE_UNITS, true);
  assertCount(item.canonicalBytes);
}

function assertDetailTarget(value: unknown): asserts value is PromptPreviewAuditDetailTarget {
  if (!isPlainRecord(value)) throw new Error();
  const kind = readDataProperty(value, 'kind');
  if (kind === 'request') {
    assertRecordKeys(value, ['kind']);
    return;
  }
  if (kind !== 'entry') throw new Error();
  assertRecordKeys(value, ['kind', 'entryId', 'entryIndex']);
  assertOpaque(readDataProperty(value, 'entryId'));
  assertIndex(readDataProperty(value, 'entryIndex'));
}

function targetsEqual(left: PromptPreviewAuditDetailTarget, right: PromptPreviewAuditDetailTarget): boolean {
  return left.kind === 'request'
    ? right.kind === 'request'
    : right.kind === 'entry' && left.entryId === right.entryId && left.entryIndex === right.entryIndex;
}

function assertPageBounds(limit: unknown, maxBytes: unknown): void {
  assertPositiveBound(limit, MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES);
  assertPositiveBound(maxBytes, MAX_PROMPT_PREVIEW_AUDIT_PAGE_BYTES, MIN_PROMPT_PREVIEW_AUDIT_PAGE_BYTES);
}

function assertPositiveBound(value: unknown, maximum: number, minimum = 1): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error();
  }
}

function assertCount(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error();
}

function assertIndex(value: unknown): void {
  assertCount(value);
}

function assertOpaque(value: unknown): void {
  assertBoundedText(value, 512);
  if (!/^[\w.~-]+$/u.test(value as string)) throw new Error();
}

function assertBoundedText(
  value: unknown,
  maxCodeUnits: number,
  allowEmpty = false,
  allowMarkdownWhitespace = false,
): void {
  if (
    typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxCodeUnits ||
    hasControlCharacter(value, allowMarkdownWhitespace)
  ) throw new Error();
  // Fatal encoding is implemented by the canonical encoder below; this also rejects lone surrogates.
  strictCanonicalSize(value, Math.max(16, maxCodeUnits * 4 + 2));
}

function strictCanonicalSize(value: unknown, maxBytes: number): void {
  canonicalJsonBytes(value, {
    maxBytes,
    maxDepth: 64,
    maxNodes: 100_000,
    maxStringBytes: maxBytes,
    maxStringCodeUnits: Math.max(maxBytes, MAX_PROMPT_PREVIEW_AUDIT_ENTRY_PREVIEW_CODE_UNITS),
  });
}

function assertRecordKeys(value: unknown, allowedKeys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error();
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
  }
  for (const key of allowedKeys) {
    // Optional keys may be absent. Required fields are checked by their value validators.
    if (Object.hasOwn(value, key)) readDataProperty(value, key);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string, allowMarkdownWhitespace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (allowMarkdownWhitespace && (codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d)) continue;
    if (codeUnit < 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

function readDataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
  return descriptor.value;
}
