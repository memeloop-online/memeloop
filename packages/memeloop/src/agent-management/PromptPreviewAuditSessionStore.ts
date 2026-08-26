import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import { assertPortableLlmRequest, type PortableLlmMessage, type PortableLlmRequest } from '../llm/request.js';
import {
  assertPromptPreviewAuditDetailRequest,
  assertPromptPreviewAuditPage,
  assertPromptPreviewAuditPageRequest,
  assertPromptPreviewAuditReleaseRequest,
  assertPromptPreviewPreparedExecution,
  PromptPreviewAuditError,
} from './PromptPreviewAudit.js';
import type {
  PromptPreviewAuditDetailChunk,
  PromptPreviewAuditDetailRequest,
  PromptPreviewAuditDetailTarget,
  PromptPreviewAuditEntrySource,
  PromptPreviewAuditEntrySummary,
  PromptPreviewAuditPage,
  PromptPreviewAuditPageRequest,
  PromptPreviewAuditReleaseRequest,
  PromptPreviewPreparedExecution,
} from './types.js';
import { MAX_PROMPT_PREVIEW_AUDIT_ENTRY_PREVIEW_CODE_UNITS, MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES } from './types.js';

const MAX_AUDIT_REQUEST_BYTES = 64 * 1_024 * 1_024;
const MAX_AUDIT_SESSIONS = 32;

type SignalFreePortableLlmRequest = Omit<PortableLlmRequest, 'signal'>;

export interface PromptPreviewAuditSessionStoreOptions {
  /** Must return a unique opaque value matching `[A-Za-z0-9_.~-]+`. */
  createSessionId(): string;
  /** Must change whenever the exact retained request changes. */
  createRevision(): string;
  maxSessions?: number;
}

export interface CreatePromptPreviewAuditSessionInput {
  request: PortableLlmRequest;
  /** Optional exact source classification aligned one-to-one with request.messages. */
  sources?: readonly PromptPreviewAuditEntrySource[];
  /** Required when a host knows more than the source projection can express. */
  compactionSummaryCount?: number;
}

interface AuditSession {
  sessionId: string;
  revision: string;
  request: SignalFreePortableLlmRequest;
  summaries: PromptPreviewAuditEntrySummary[];
  pageCursors: Map<string, number>;
  pageCursorByBoundary: Map<number, string>;
  nextPageCursor: number;
  canonicalRequest?: Uint8Array;
}

/**
 * Host-side retained exact-request store. Instantiate it only in a trusted
 * main/worker process and expose the bounded methods through IPC; never expose
 * {@link getExactRequest} directly to a renderer.
 */
export class PromptPreviewAuditSessionStore {
  private readonly sessions = new Map<string, AuditSession>();
  private readonly maxSessions: number;

  public constructor(private readonly options: PromptPreviewAuditSessionStoreOptions) {
    const maxSessions = options.maxSessions ?? MAX_AUDIT_SESSIONS;
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_AUDIT_SESSIONS) {
      throw new TypeError('invalid prompt preview audit session capacity');
    }
    this.maxSessions = maxSessions;
  }

  /** Retain a signal-free immutable snapshot and return only a bounded renderer descriptor. */
  public createSession(input: CreatePromptPreviewAuditSessionInput): PromptPreviewPreparedExecution {
    assertPortableLlmRequest(input.request);
    if (this.sessions.size >= this.maxSessions) {
      throw new PromptPreviewAuditError('capacity_exceeded');
    }
    const sessionId = this.options.createSessionId();
    const revision = this.options.createRevision();
    if (this.sessions.has(sessionId)) throw new PromptPreviewAuditError('invalid_request');
    const request = cloneSignalFreeRequest(input.request);
    const sources = resolveSources(request.messages, input.sources);
    const compactionSummaryCount = input.compactionSummaryCount ??
      sources.filter(source => source === 'context-compaction-summary').length;
    if (
      !Number.isSafeInteger(compactionSummaryCount) || compactionSummaryCount < 0 ||
      compactionSummaryCount > request.messages.length
    ) throw new PromptPreviewAuditError('invalid_request');

    const session: AuditSession = {
      sessionId,
      revision,
      request,
      summaries: request.messages.map((message, entryIndex) => createSummary(message, entryIndex, sources[entryIndex])),
      pageCursors: new Map(),
      pageCursorByBoundary: new Map(),
      nextPageCursor: 0,
    };
    this.sessions.set(sessionId, session);
    try {
      const prepared: PromptPreviewPreparedExecution = {
        sessionId,
        revision,
        route: {
          providerId: request.providerId,
          logicalModelId: request.logicalModelId,
          wireModelId: request.wireModelId,
          apiMode: request.apiMode,
        },
        contextStats: {
          messageCount: request.messages.length,
          compactionSummaryCount,
        },
        initialPage: this.createInitialPage(session),
      };
      assertPromptPreviewPreparedExecution(prepared);
      return prepared;
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  /** Trusted-host only: return a fresh exact request snapshot and attach a local signal. */
  public getExactRequest(
    sessionId: string,
    expectedRevision: string,
    signal?: AbortSignal,
  ): PortableLlmRequest {
    const session = this.getSession(sessionId, expectedRevision);
    const request: PortableLlmRequest = {
      ...structuredClone(session.request),
      ...(signal === undefined ? {} : { signal }),
    };
    assertPortableLlmRequest(request);
    return request;
  }

  public getPage(request: PromptPreviewAuditPageRequest): PromptPreviewAuditPage {
    assertPromptPreviewAuditPageRequest(request);
    const session = this.getSession(request.sessionId, request.expectedRevision);
    const total = session.summaries.length;
    let start: number;
    let end: number;
    let focus: number | undefined;
    if (request.mode === 'around') {
      if (request.entryIndex >= total) throw new PromptPreviewAuditError('entry_not_found');
      focus = request.entryIndex;
      start = Math.max(0, focus - Math.floor((request.limit - 1) / 2));
      end = Math.min(total, start + request.limit);
      start = Math.max(0, end - request.limit);
    } else {
      const boundary = this.readPageCursor(session, request.cursor);
      if (request.mode === 'before') {
        end = boundary;
        start = Math.max(0, end - request.limit);
      } else {
        start = boundary;
        end = Math.min(total, start + request.limit);
      }
    }
    const page = this.fitContiguousPage(
      session,
      start,
      end,
      focus,
      request.maxBytes,
      request.mode,
    );
    assertPromptPreviewAuditPage(page, {
      expectedSessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      maxBytes: request.maxBytes,
      maxEntries: request.limit,
    });
    return page;
  }

  public getDetail(request: PromptPreviewAuditDetailRequest): PromptPreviewAuditDetailChunk {
    assertPromptPreviewAuditDetailRequest(request);
    const session = this.getSession(request.sessionId, request.expectedRevision);
    const targetKey = detailTargetKey(request.target);
    let offset = 0;
    if (request.cursor !== undefined) {
      offset = readDetailCursor(request.cursor, targetKey);
    }
    const bytes = this.detailBytes(session, request.target);
    if (offset < 0 || offset > bytes.byteLength) throw new PromptPreviewAuditError('invalid_cursor');
    const end = utf8ChunkEnd(bytes, offset, request.maxBytes);
    const complete = end === bytes.byteLength;
    const nextCursor = complete ? undefined : createDetailCursor(targetKey, end);
    return {
      sessionId: session.sessionId,
      revision: session.revision,
      target: request.target,
      canonicalUtf8: bytes.slice(offset, end),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      complete,
    };
  }

  /** Idempotent for missing/already-released sessions; stale revisions fail closed. */
  public release(request: PromptPreviewAuditReleaseRequest): void {
    assertPromptPreviewAuditReleaseRequest(request);
    const session = this.sessions.get(request.sessionId);
    if (session === undefined) return;
    if (session.revision !== request.expectedRevision) throw new PromptPreviewAuditError('stale_revision');
    this.sessions.delete(request.sessionId);
  }

  public get size(): number {
    return this.sessions.size;
  }

  private getSession(sessionId: string, expectedRevision: string): AuditSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new PromptPreviewAuditError('session_not_found');
    if (session.revision !== expectedRevision) throw new PromptPreviewAuditError('stale_revision');
    return session;
  }

  private createInitialPage(session: AuditSession): PromptPreviewAuditPage {
    const total = session.summaries.length;
    if (total <= MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES) {
      return this.pageFromItems(session, [...session.summaries], false);
    }
    const provisionalRecentStart = total - 40;
    const markerIndices = session.summaries
      .filter(item => item.entryIndex < provisionalRecentStart && isPinnedSource(item.source))
      .map(item => item.entryIndex);
    const pinned = selectPinnedIndices(markerIndices, 10);
    const recentCount = MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES - pinned.length;
    const recentStart = total - recentCount;
    const recent = session.summaries.slice(recentStart);
    const items = [
      ...pinned.map(index => session.summaries[index]),
      ...recent,
    ].sort((left, right) => left.entryIndex - right.entryIndex);
    const page: PromptPreviewAuditPage = {
      sessionId: session.sessionId,
      revision: session.revision,
      items,
      totalEntries: total,
      ...(recentStart > 0 ? { previousCursor: this.pageCursor(session, recentStart) } : {}),
      hasMoreBefore: recentStart > 0,
      hasMoreAfter: false,
      sampled: true,
    };
    assertPromptPreviewAuditPage(page);
    return page;
  }

  private fitContiguousPage(
    session: AuditSession,
    initialStart: number,
    initialEnd: number,
    focus: number | undefined,
    maxBytes: number,
    mode: PromptPreviewAuditPageRequest['mode'],
  ): PromptPreviewAuditPage {
    let start = initialStart;
    let end = initialEnd;
    while (true) {
      const page = this.pageFromItems(session, session.summaries.slice(start, end), false);
      if (fitsCanonicalPage(page, maxBytes)) return page;
      if (end - start <= 1) throw new PromptPreviewAuditError('invalid_response');
      if (focus === undefined) {
        // Keep the edge nearest the requesting cursor so cursor walking never
        // skips entries when a byte budget is tighter than the count budget.
        if (mode === 'before') start += 1;
        else end -= 1;
      } else if (focus - start > end - 1 - focus) {
        start += 1;
      } else {
        end -= 1;
      }
    }
  }

  private pageFromItems(
    session: AuditSession,
    items: PromptPreviewAuditEntrySummary[],
    sampled: boolean,
  ): PromptPreviewAuditPage {
    const totalEntries = session.summaries.length;
    const firstIndex = items[0]?.entryIndex ?? totalEntries;
    const afterBoundary = items.length === 0 ? firstIndex : items.at(-1)!.entryIndex + 1;
    const hasMoreBefore = firstIndex > 0;
    const hasMoreAfter = afterBoundary < totalEntries;
    return {
      sessionId: session.sessionId,
      revision: session.revision,
      items,
      totalEntries,
      ...(hasMoreBefore ? { previousCursor: this.pageCursor(session, firstIndex) } : {}),
      ...(hasMoreAfter ? { nextCursor: this.pageCursor(session, afterBoundary) } : {}),
      hasMoreBefore,
      hasMoreAfter,
      sampled,
    };
  }

  private pageCursor(session: AuditSession, boundary: number): string {
    const existing = session.pageCursorByBoundary.get(boundary);
    if (existing !== undefined) return existing;
    const cursor = `p.${(session.nextPageCursor++).toString(36)}`;
    session.pageCursors.set(cursor, boundary);
    session.pageCursorByBoundary.set(boundary, cursor);
    return cursor;
  }

  private readPageCursor(session: AuditSession, cursor: string): number {
    const boundary = session.pageCursors.get(cursor);
    if (boundary === undefined) throw new PromptPreviewAuditError('invalid_cursor');
    return boundary;
  }

  private detailBytes(session: AuditSession, target: PromptPreviewAuditDetailTarget): Uint8Array {
    if (target.kind === 'entry') {
      const summary = session.summaries[target.entryIndex];
      if (summary === undefined || summary.entryId !== target.entryId) {
        throw new PromptPreviewAuditError('entry_not_found');
      }
      return encodeAuditValue(session.request.messages[target.entryIndex]);
    }
    session.canonicalRequest ??= encodeAuditValue(session.request);
    return session.canonicalRequest;
  }
}

/** Decode complete request-detail bytes and restore exact Uint8Array file payloads. */
export function decodePromptPreviewAuditRequest(
  canonicalUtf8: Uint8Array,
): SignalFreePortableLlmRequest {
  let parsed: unknown;
  try {
    if (
      !(canonicalUtf8 instanceof Uint8Array) || Object.getPrototypeOf(canonicalUtf8) !== Uint8Array.prototype ||
      canonicalUtf8.byteLength > MAX_AUDIT_REQUEST_BYTES
    ) throw new Error();
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(canonicalUtf8));
    restoreRequestBytePayloads(parsed);
    assertPortableLlmRequest(parsed);
    if (Object.hasOwn(parsed, 'signal')) throw new Error();
  } catch (error) {
    throw new PromptPreviewAuditError('invalid_response', error);
  }
  return parsed;
}

function cloneSignalFreeRequest(request: PortableLlmRequest): SignalFreePortableLlmRequest {
  const signalFree = { ...request };
  delete signalFree.signal;
  const clone = structuredClone(signalFree) as PortableLlmRequest;
  assertPortableLlmRequest(clone);
  return clone;
}

function resolveSources(
  messages: readonly PortableLlmMessage[],
  input: readonly PromptPreviewAuditEntrySource[] | undefined,
): PromptPreviewAuditEntrySource[] {
  if (input !== undefined && input.length !== messages.length) {
    throw new PromptPreviewAuditError('invalid_request');
  }
  return messages.map((message, index) => {
    const source = input?.[index] ?? (message.role === 'system'
      ? 'system'
      : message.role === 'tool'
      ? 'tool'
      : 'conversation-message');
    if (
      ![
        'system',
        'prompt',
        'context-compaction-summary',
        'conversation-message',
        'preview-input',
        'tool',
      ].includes(source)
    ) throw new PromptPreviewAuditError('invalid_request');
    return source;
  });
}

function createSummary(
  message: PortableLlmMessage,
  entryIndex: number,
  source: PromptPreviewAuditEntrySource,
): PromptPreviewAuditEntrySummary {
  return {
    entryId: `message.${entryIndex.toString(36)}`,
    entryIndex,
    role: message.role,
    source,
    preview: previewMessage(message),
    canonicalBytes: encodeAuditValue(message).byteLength,
  };
}

function previewMessage(message: PortableLlmMessage): string {
  const fragments: string[] = [];
  if (typeof message.content === 'string') fragments.push(message.content);
  else {
    for (const part of message.content) {
      if ('text' in part && typeof part.text === 'string') fragments.push(part.text);
      else if (part.type === 'tool-call') fragments.push(`${part.toolName}(…)`);
      else if (part.type === 'tool-result') fragments.push(`${part.toolName}: ${part.output.type}`);
      else if (part.type === 'file') fragments.push(part.filename ?? part.mediaType);
      else if (part.type === 'image') fragments.push(part.mediaType ?? 'image');
      if (fragments.join(' ').length >= MAX_PROMPT_PREVIEW_AUDIT_ENTRY_PREVIEW_CODE_UNITS) break;
    }
  }
  return boundedPlainText(fragments.join(' '));
}

function boundedPlainText(input: string): string {
  let output = '';
  for (const character of input) {
    const codePoint = character.codePointAt(0)!;
    const safe = (codePoint >= 0x20 && codePoint !== 0x7f) ? character : ' ';
    if (output.length + safe.length > MAX_PROMPT_PREVIEW_AUDIT_ENTRY_PREVIEW_CODE_UNITS) break;
    output += safe;
  }
  return output;
}

function isPinnedSource(source: PromptPreviewAuditEntrySource): boolean {
  return source === 'system' || source === 'prompt' || source === 'context-compaction-summary';
}

function selectPinnedIndices(indices: number[], maximum: number): number[] {
  if (indices.length <= maximum) return indices;
  return [indices[0], ...indices.slice(-(maximum - 1))];
}

function fitsCanonicalPage(page: PromptPreviewAuditPage, maxBytes: number): boolean {
  try {
    canonicalJsonBytes(page, {
      maxBytes,
      maxDepth: 16,
      maxNodes: 10_000,
      maxStringBytes: maxBytes,
      maxStringCodeUnits: maxBytes,
    });
    return true;
  } catch {
    return false;
  }
}

function encodeAuditValue(value: unknown): Uint8Array {
  const clone = structuredClone(value);
  projectBytePayloads(clone);
  return canonicalJsonBytes(clone, {
    maxBytes: MAX_AUDIT_REQUEST_BYTES,
    maxDepth: 64,
    maxNodes: 500_000,
    maxStringBytes: 32 * 1_024 * 1_024,
    maxStringCodeUnits: 32 * 1_024 * 1_024,
  });
}

function projectBytePayloads(value: unknown): void {
  forEachFileData(value, data => {
    if (data.type !== 'bytes') return;
    data.bytes = {
      encoding: 'base64',
      value: bytesToBase64(data.bytes as Uint8Array),
    };
  });
}

function restoreRequestBytePayloads(value: unknown): void {
  forEachFileData(value, data => {
    if (data.type !== 'bytes') return;
    const projection = data.bytes;
    if (
      projection === null || typeof projection !== 'object' || Array.isArray(projection) ||
      Reflect.ownKeys(projection).length !== 2 ||
      (projection as Record<string, unknown>).encoding !== 'base64' ||
      typeof (projection as Record<string, unknown>).value !== 'string'
    ) throw new Error();
    data.bytes = base64ToBytes((projection as Record<string, string>).value);
  });
}

function forEachFileData(
  value: unknown,
  visit: (data: Record<string, unknown>) => void,
): void {
  if (value === null || typeof value !== 'object') return;
  const request = value as { messages?: unknown };
  const messages = Array.isArray(request.messages) ? request.messages : [value];
  for (const rawMessage of messages) {
    if (rawMessage === null || typeof rawMessage !== 'object') continue;
    const content = (rawMessage as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const rawPart of content) {
      if (rawPart === null || typeof rawPart !== 'object') continue;
      const part = rawPart as { type?: unknown; data?: unknown };
      if (part.type !== 'image' && part.type !== 'file') continue;
      if (part.data === null || typeof part.data !== 'object' || Array.isArray(part.data)) continue;
      visit(part.data as Record<string, unknown>);
    }
  }
}

function detailTargetKey(target: PromptPreviewAuditDetailTarget): string {
  return target.kind === 'request' ? 'request' : `entry.${target.entryIndex.toString(36)}.${target.entryId}`;
}

function createDetailCursor(targetKey: string, offset: number): string {
  return `d.${targetKey}.${offset.toString(36)}`;
}

function readDetailCursor(cursor: string, targetKey: string): number {
  const prefix = `d.${targetKey}.`;
  if (!cursor.startsWith(prefix)) throw new PromptPreviewAuditError('invalid_cursor');
  const encodedOffset = cursor.slice(prefix.length);
  if (!/^[0-9a-z]+$/u.test(encodedOffset)) throw new PromptPreviewAuditError('invalid_cursor');
  const offset = Number.parseInt(encodedOffset, 36);
  if (!Number.isSafeInteger(offset) || offset < 1 || offset.toString(36) !== encodedOffset) {
    throw new PromptPreviewAuditError('invalid_cursor');
  }
  return offset;
}

function utf8ChunkEnd(bytes: Uint8Array, offset: number, maximum: number): number {
  if (offset === bytes.byteLength) return offset;
  let end = Math.min(bytes.byteLength, offset + maximum);
  while (end > offset) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end));
      return end;
    } catch {
      end -= 1;
    }
  }
  throw new PromptPreviewAuditError('invalid_response');
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let blockStart = 0; blockStart < bytes.length; blockStart += 12_288) {
    const blockEnd = Math.min(bytes.length, blockStart + 12_288);
    let chunk = '';
    for (let index = blockStart; index < blockEnd; index += 3) {
      const first = bytes[index];
      const hasSecond = index + 1 < bytes.length;
      const hasThird = index + 2 < bytes.length;
      const second = hasSecond ? bytes[index + 1] : 0;
      const third = hasThird ? bytes[index + 2] : 0;
      chunk += BASE64_ALPHABET[first >> 2];
      chunk += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
      chunk += hasSecond ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '=';
      chunk += hasThird ? BASE64_ALPHABET[third & 0x3f] : '=';
    }
    chunks.push(chunk);
  }
  return chunks.join('');
}

function base64ToBytes(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error();
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(value[index]);
    const b = BASE64_ALPHABET.indexOf(value[index + 1]);
    const c = value[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 2]);
    const d = value[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 3]);
    output[outputIndex++] = (a << 2) | (b >> 4);
    if (outputIndex < output.length) output[outputIndex++] = ((b & 0x0f) << 4) | (c >> 2);
    if (outputIndex < output.length) output[outputIndex++] = ((c & 0x03) << 6) | d;
  }
  return output;
}
