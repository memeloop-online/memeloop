import type { MemeLoopConversationTimelinePage, MemeLoopConversationTimelineResult, MemeLoopTimelineEntry, MemeLoopTimelineParticipantPreview } from './coreTypes.js';
import { MEMELOOP_TIMELINE_PAGE_LIMIT, MEMELOOP_TIMELINE_PAGE_MAX_BYTES } from './timelineSampling.js';

export interface ConversationTimelinePageRequest {
  conversationId: string;
  limit: number;
  maxBytes: number;
  expectedRevision?: string;
  beforeCursor?: string;
  afterCursor?: string;
  aroundEntryIndex?: number;
}

export interface ConversationTimelinePageClient {
  getPage(
    request: ConversationTimelinePageRequest,
    options: { signal: AbortSignal },
  ): Promise<MemeLoopConversationTimelineResult>;
}

export interface ConversationTimelineWindowSnapshot {
  conversationId?: string;
  page?: MemeLoopConversationTimelinePage;
  loading: boolean;
  loadingKind: 'initial' | 'before' | 'after' | 'around' | null;
  resetCount: number;
  error: Error | null;
}

export interface ConversationTimelineWindowControllerOptions {
  onListenerError?: (error: unknown) => void;
}

type OwnDescriptors = Record<string, PropertyDescriptor>;

const MAX_PARTICIPANT_PREVIEWS = 4;
const MAX_PARTICIPANT_PREVIEW_CODE_UNITS = 160;
const MAX_PARTICIPANT_PREVIEWS_BYTES = 1_024;
const MAX_TIMELINE_TURN_ENTRY_BYTES = 1_024;
const MAX_TIMELINE_PREVIEW_CODE_UNITS = 240;

function descriptors(value: unknown): OwnDescriptors {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('timeline projection must be an object');
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('timeline projection must be a plain object');
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new TypeError('timeline projection cannot contain symbol keys');
    return Object.getOwnPropertyDescriptors(value) as OwnDescriptors;
  } catch {
    throw new TypeError('timeline projection descriptors are unavailable');
  }
}

function denseArrayValues(value: unknown, key: string, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`timeline projection ${key} must be an array`);
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`timeline projection ${key} must be a plain array`);
    const properties = Object.getOwnPropertyDescriptors(value) as OwnDescriptors;
    if (Reflect.ownKeys(value).some(item => typeof item !== 'string')) throw new TypeError(`timeline projection ${key} cannot contain symbol keys`);
    const lengthDescriptor = properties.length;
    if (
      !lengthDescriptor || 'get' in lengthDescriptor || 'set' in lengthDescriptor ||
      !('value' in lengthDescriptor) || lengthDescriptor.enumerable ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximumLength
    ) throw new RangeError(`timeline projection ${key} exceeds its item limit`);
    const length = lengthDescriptor.value as number;
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = properties[String(index)];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`timeline projection ${key} must be a dense data array`);
      }
      values.push(descriptor.value);
    }
    if (Object.keys(properties).some(item => item !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(item))) {
      throw new TypeError(`timeline projection ${key} contains an unexpected field`);
    }
    if (Object.keys(properties).length !== length + 1) throw new TypeError(`timeline projection ${key} has invalid indexes`);
    return values;
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new TypeError(`timeline projection ${key} descriptors are unavailable`);
  }
}

function exactKeys(record: OwnDescriptors, allowed: readonly string[], kind: string): void {
  if (Object.keys(record).some(key => !allowed.includes(key))) {
    throw new TypeError(`timeline projection ${kind} contains an unexpected field`);
  }
}

function ownData(record: OwnDescriptors, key: string, required = true): unknown {
  const descriptor = record[key];
  if (!descriptor) {
    if (required) throw new TypeError(`timeline projection is missing ${key}`);
    return undefined;
  }
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError(`timeline projection ${key} must be enumerable data`);
  return descriptor.value;
}

function strictBoolean(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`timeline projection ${key} must be boolean`);
  return value;
}

function safeInteger(value: unknown, key: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`timeline projection ${key} must be a non-negative safe integer`);
  return value as number;
}

function addUtf8Bytes(value: unknown, key: string, state: { bytes: number }, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new TypeError(`timeline projection ${key} must be a string`);
  if (value.length > maximum - state.bytes) throw new RangeError('timeline page exceeds requested byte budget');
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xDC00 && low <= 0xDFFF)) throw new TypeError(`timeline projection ${key} contains invalid Unicode`);
      state.bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      throw new TypeError(`timeline projection ${key} contains invalid Unicode`);
    } else {
      state.bytes += codeUnit <= 0x7F ? 1 : codeUnit <= 0x7FF ? 2 : 3;
    }
    if (state.bytes > maximum) throw new RangeError('timeline page exceeds requested byte budget');
  }
  return value;
}

function opaqueString(value: unknown, key: string, state: { bytes: number }, maximum: number): string {
  const text = addUtf8Bytes(value, key, state, maximum);
  if (text.length > 2_048 || text !== text.trim()) throw new TypeError(`timeline projection ${key} is not opaque text`);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 31 || code === 127) throw new TypeError(`timeline projection ${key} contains control characters`);
  }
  return text;
}

function optionalSafeInteger(record: OwnDescriptors, key: string): number | undefined {
  const value = ownData(record, key, false);
  return value === undefined ? undefined : safeInteger(value, key);
}

function optionalString(record: OwnDescriptors, key: string, state: { bytes: number }, maximum: number): string | undefined {
  const value = ownData(record, key, false);
  return value === undefined ? undefined : addUtf8Bytes(value, key, state, maximum);
}

function participantText(
  record: OwnDescriptors,
  key: 'actorId' | 'actorLabel' | 'preview',
  state: { bytes: number },
  maximumBytes: number,
  allowEmpty = false,
): string {
  const value = addUtf8Bytes(ownData(record, key), key, state, maximumBytes, allowEmpty);
  if (value.length > MAX_PARTICIPANT_PREVIEW_CODE_UNITS) {
    throw new RangeError(`timeline projection ${key} exceeds its character limit`);
  }
  return value;
}

function timelinePreviewText(
  record: OwnDescriptors,
  key: 'summaryPreview' | 'userPreview',
  state: { bytes: number },
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  const value = addUtf8Bytes(ownData(record, key), key, state, maximumBytes, allowEmpty);
  if (value.length > MAX_TIMELINE_PREVIEW_CODE_UNITS) {
    throw new RangeError(`timeline projection ${key} exceeds its character limit`);
  }
  return value;
}

function validateParticipantPreviews(
  value: unknown,
  state: { bytes: number },
  maximumBytes: number,
): readonly MemeLoopTimelineParticipantPreview[] {
  const rawItems = denseArrayValues(value, 'participantPreviews', MAX_PARTICIPANT_PREVIEWS);
  const items = rawItems.map((item): MemeLoopTimelineParticipantPreview => {
    const record = descriptors(item);
    exactKeys(record, ['actorId', 'actorLabel', 'role', 'preview'], 'participant preview');
    const role = addUtf8Bytes(ownData(record, 'role'), 'role', state, maximumBytes);
    if (role !== 'assistant' && role !== 'agent') throw new TypeError('timeline projection participant role is invalid');
    return Object.freeze({
      actorId: participantText(record, 'actorId', state, maximumBytes),
      actorLabel: participantText(record, 'actorLabel', state, maximumBytes),
      role,
      preview: participantText(record, 'preview', state, maximumBytes, true),
    });
  });
  const frozen = Object.freeze(items);
  ensureCanonicalValueWithinBudget(frozen, MAX_PARTICIPANT_PREVIEWS_BYTES, 'participant previews');
  return frozen;
}

function validateEntry(
  value: unknown,
  expectedConversationId: string,
  totals: { totalEntries: number; totalTurns: number },
  state: { bytes: number },
  maximumBytes: number,
): MemeLoopTimelineEntry {
  const record = descriptors(value);
  const kind = addUtf8Bytes(ownData(record, 'kind'), 'kind', state, maximumBytes);
  if (kind !== 'turn' && kind !== 'compaction') throw new TypeError('timeline projection kind is invalid');
  const commonKeys = ['kind', 'entryId', 'conversationId', 'cursor', 'timestamp', 'lamportClock', 'originNodeId', 'entryIndex', 'turnIndex'];
  exactKeys(
    record,
    kind === 'turn'
      ? [...commonKeys, 'messageId', 'turnId', 'userPreview', 'participantPreviews', 'responseCount']
      : [...commonKeys, 'summaryPreview', 'compactedMessageCount', 'compactedTurnCount'],
    kind,
  );
  const base = {
    entryId: opaqueString(ownData(record, 'entryId'), 'entryId', state, maximumBytes),
    conversationId: addUtf8Bytes(ownData(record, 'conversationId'), 'conversationId', state, maximumBytes),
    cursor: opaqueString(ownData(record, 'cursor'), 'cursor', state, maximumBytes),
    timestamp: safeInteger(ownData(record, 'timestamp'), 'timestamp'),
    lamportClock: safeInteger(ownData(record, 'lamportClock'), 'lamportClock'),
    originNodeId: addUtf8Bytes(ownData(record, 'originNodeId'), 'originNodeId', state, maximumBytes),
    entryIndex: safeInteger(ownData(record, 'entryIndex'), 'entryIndex'),
    turnIndex: safeInteger(ownData(record, 'turnIndex'), 'turnIndex'),
  };
  if (base.conversationId !== expectedConversationId) throw new TypeError('timeline entry conversation identity mismatch');
  if (base.entryIndex >= totals.totalEntries || base.turnIndex > totals.totalTurns) {
    throw new TypeError('timeline entry index exceeds page totals');
  }
  if (kind === 'turn') {
    const messageId = opaqueString(ownData(record, 'messageId'), 'messageId', state, maximumBytes);
    const turnId = opaqueString(ownData(record, 'turnId'), 'turnId', state, maximumBytes);
    const participantPreviews = validateParticipantPreviews(ownData(record, 'participantPreviews'), state, maximumBytes);
    const responseCount = safeInteger(ownData(record, 'responseCount'), 'responseCount');
    if (responseCount < participantPreviews.length) throw new TypeError('timeline projection responseCount is smaller than its sample');
    if (base.entryId !== messageId || messageId !== turnId || base.turnIndex >= totals.totalTurns) {
      throw new TypeError('timeline turn identity or index is invalid');
    }
    const result = Object.freeze({
      ...base,
      kind,
      messageId,
      turnId,
      userPreview: timelinePreviewText(record, 'userPreview', state, maximumBytes, true),
      participantPreviews,
      responseCount,
    });
    ensureCanonicalValueWithinBudget(result, MAX_TIMELINE_TURN_ENTRY_BYTES, 'turn entry');
    return result;
  }
  return Object.freeze({
    ...base,
    kind,
    summaryPreview: timelinePreviewText(record, 'summaryPreview', state, maximumBytes, false),
    compactedMessageCount: safeInteger(ownData(record, 'compactedMessageCount'), 'compactedMessageCount'),
    compactedTurnCount: safeInteger(ownData(record, 'compactedTurnCount'), 'compactedTurnCount'),
  });
}

/** Strictly validates and clones an untrusted host projection without JSON/getter coercion. */
export function validateConversationTimelineResult(
  value: unknown,
  expectedConversationId: string,
  maximumBytes = MEMELOOP_TIMELINE_PAGE_MAX_BYTES,
): MemeLoopConversationTimelineResult {
  const identityState = { bytes: 0 };
  const boundedConversationId = opaqueString(expectedConversationId, 'conversationId', identityState, maximumBytes);
  const record = descriptors(value);
  const reset = strictBoolean(ownData(record, 'reset'), 'reset');
  const state = { bytes: 0 };
  const revision = opaqueString(ownData(record, 'revision'), 'revision', state, maximumBytes);
  if (reset) {
    exactKeys(record, ['reset', 'revision'], 'reset');
    const result = Object.freeze({ reset: true as const, revision });
    ensureCanonicalPageWithinBudget(result, maximumBytes);
    return result;
  }
  exactKeys(record, [
    'reset',
    'items',
    'revision',
    'totalMessages',
    'totalTurns',
    'totalEntries',
    'hasMoreBefore',
    'hasMoreAfter',
    'startEntryIndex',
    'endEntryIndex',
    'startCursor',
    'endCursor',
  ], 'page');
  const totalMessages = safeInteger(ownData(record, 'totalMessages'), 'totalMessages');
  const totalTurns = safeInteger(ownData(record, 'totalTurns'), 'totalTurns');
  const totalEntries = safeInteger(ownData(record, 'totalEntries'), 'totalEntries');
  if (totalTurns > totalMessages) throw new TypeError('timeline totalTurns exceeds totalMessages');
  // Read the transport array through descriptors just like participant
  // previews. Calling Array#map here would execute an accessor installed on a
  // numeric index and would also silently preserve sparse holes.
  const rawItems = denseArrayValues(ownData(record, 'items'), 'items', MEMELOOP_TIMELINE_PAGE_LIMIT);
  const items = rawItems.map(item => validateEntry(item, boundedConversationId, { totalEntries, totalTurns }, state, maximumBytes));
  const cursorIdentities = new Set<string>();
  const entryIdentities = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index];
    if (index > 0 && entry.entryIndex !== items[index - 1].entryIndex + 1) throw new TypeError('timeline entry indexes must be contiguous');
    if (index > 0) {
      const previous = items[index - 1];
      const expectedTurnIndex = previous.turnIndex + (previous.kind === 'turn' ? 1 : 0);
      if (entry.turnIndex !== expectedTurnIndex) throw new TypeError('timeline turn indexes are inconsistent');
    }
    if (cursorIdentities.has(entry.cursor) || entryIdentities.has(entry.entryId)) throw new TypeError('timeline entry identity must be unique');
    cursorIdentities.add(entry.cursor);
    entryIdentities.add(entry.entryId);
  }
  if (totalEntries < items.length) throw new TypeError('timeline totalEntries is smaller than page');
  const hasMoreBefore = strictBoolean(ownData(record, 'hasMoreBefore'), 'hasMoreBefore');
  const hasMoreAfter = strictBoolean(ownData(record, 'hasMoreAfter'), 'hasMoreAfter');
  const startEntryIndex = optionalSafeInteger(record, 'startEntryIndex');
  const endEntryIndex = optionalSafeInteger(record, 'endEntryIndex');
  const startCursor = optionalString(record, 'startCursor', state, maximumBytes);
  const endCursor = optionalString(record, 'endCursor', state, maximumBytes);
  if (items.length > 0) {
    if (startEntryIndex !== items[0].entryIndex || endEntryIndex !== items.at(-1)!.entryIndex) throw new TypeError('timeline page index bounds mismatch');
    if (startCursor !== items[0].cursor || endCursor !== items.at(-1)!.cursor) throw new TypeError('timeline page cursor bounds mismatch');
    if (hasMoreBefore !== (items[0].entryIndex > 0) || hasMoreAfter !== (items.at(-1)!.entryIndex + 1 < totalEntries)) {
      throw new TypeError('timeline page continuation bounds mismatch');
    }
  } else {
    if (startEntryIndex !== undefined || endEntryIndex !== undefined || startCursor !== undefined || endCursor !== undefined) {
      throw new TypeError('empty timeline page cannot contain bounds');
    }
    if (hasMoreBefore || hasMoreAfter || totalEntries !== 0) throw new TypeError('empty timeline page continuation is invalid');
  }
  const result = Object.freeze({
    reset: false as const,
    items: Object.freeze(items),
    revision,
    totalMessages,
    totalTurns,
    totalEntries,
    hasMoreBefore,
    hasMoreAfter,
    ...(startEntryIndex === undefined ? {} : { startEntryIndex }),
    ...(endEntryIndex === undefined ? {} : { endEntryIndex }),
    ...(startCursor === undefined ? {} : { startCursor }),
    ...(endCursor === undefined ? {} : { endCursor }),
  });
  ensureCanonicalPageWithinBudget(result, maximumBytes);
  return result;
}

function ensureCanonicalPageWithinBudget(value: MemeLoopConversationTimelineResult, maximumBytes: number): void {
  ensureCanonicalValueWithinBudget(value, maximumBytes, 'page');
}

function ensureCanonicalValueWithinBudget(value: unknown, maximumBytes: number, kind: string): void {
  const json = JSON.stringify(value);
  const state = { bytes: 0 };
  addUtf8Bytes(json, `canonical ${kind}`, state, maximumBytes, true);
}

export class ConversationTimelineWindowController {
  private generation = 0;
  private refreshTargetRevision?: string;
  private controller?: AbortController;
  private readonly listeners = new Set<() => void>();
  private snapshot: ConversationTimelineWindowSnapshot = Object.freeze({ loading: false, loadingKind: null, resetCount: 0, error: null });

  public constructor(
    private readonly client: ConversationTimelinePageClient,
    private readonly options: ConversationTimelineWindowControllerOptions = {},
  ) {}

  public getSnapshot = (): ConversationTimelineWindowSnapshot => this.snapshot;
  public subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public start(conversationId: string): void {
    assertControllerOpaqueText(conversationId, 'conversationId');
    if (conversationId === this.snapshot.conversationId) return;
    this.generation += 1;
    this.refreshTargetRevision = undefined;
    this.controller?.abort();
    this.snapshot = freezeSnapshot({ conversationId, loading: true, loadingKind: 'initial', resetCount: this.snapshot.resetCount, error: null });
    this.emit();
    void this.read({ conversationId }, this.generation, true);
  }

  public loadBefore(cursor: string, expectedRevision: string, signal?: AbortSignal): Promise<void> {
    assertControllerOpaqueText(cursor, 'beforeCursor');
    assertControllerOpaqueText(expectedRevision, 'expectedRevision');
    return this.navigate({ beforeCursor: cursor, expectedRevision }, signal, 'before');
  }

  public loadAfter(cursor: string, expectedRevision: string, signal?: AbortSignal): Promise<void> {
    assertControllerOpaqueText(cursor, 'afterCursor');
    assertControllerOpaqueText(expectedRevision, 'expectedRevision');
    return this.navigate({ afterCursor: cursor, expectedRevision }, signal, 'after');
  }

  public loadAround(entryIndex: number, expectedRevision: string, signal?: AbortSignal): Promise<void> {
    assertControllerSafeIndex(entryIndex, 'aroundEntryIndex');
    assertControllerOpaqueText(expectedRevision, 'expectedRevision');
    return this.navigate({ aroundEntryIndex: entryIndex, expectedRevision }, signal, 'around');
  }

  /** Reconcile a host revision without replaying stale cursors or scanning pages. */
  public refreshForRevision(targetRevision: string, aroundEntryIndex?: number): Promise<void> {
    assertControllerOpaqueText(targetRevision, 'targetRevision');
    if (aroundEntryIndex !== undefined) assertControllerSafeIndex(aroundEntryIndex, 'aroundEntryIndex');
    if (this.snapshot.page?.revision === targetRevision || this.refreshTargetRevision === targetRevision) return Promise.resolve();
    this.refreshTargetRevision = targetRevision;
    return this.navigate(
      aroundEntryIndex === undefined ? { expectedRevision: targetRevision } : { aroundEntryIndex, expectedRevision: targetRevision },
      undefined,
      aroundEntryIndex === undefined ? 'initial' : 'around',
    ).finally(() => {
      if (this.refreshTargetRevision === targetRevision) this.refreshTargetRevision = undefined;
    });
  }

  public dispose(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.refreshTargetRevision = undefined;
    this.listeners.clear();
  }

  private async navigate(
    selector: Omit<ConversationTimelinePageRequest, 'conversationId' | 'limit' | 'maxBytes'>,
    signal?: AbortSignal,
    loadingKind: ConversationTimelineWindowSnapshot['loadingKind'] = 'initial',
  ): Promise<void> {
    const conversationId = this.snapshot.conversationId;
    if (!conversationId || signal?.aborted) return;
    const generation = ++this.generation;
    this.controller?.abort();
    const rollback = this.snapshot;
    this.snapshot = freezeSnapshot({ ...this.snapshot, loading: true, loadingKind, error: null });
    this.emit();
    await this.read({ conversationId, ...selector }, generation, true, signal, rollback);
  }

  private async read(
    input: Omit<ConversationTimelinePageRequest, 'limit' | 'maxBytes'>,
    generation: number,
    allowReset: boolean,
    externalSignal?: AbortSignal,
    rollbackSnapshot?: ConversationTimelineWindowSnapshot,
  ): Promise<void> {
    const controller = new AbortController();
    let rolledBack = false;
    const abortFromExternal = () => {
      controller.abort(externalSignal?.reason);
      if (generation === this.generation && rollbackSnapshot) {
        rolledBack = true;
        this.snapshot = rollbackSnapshot;
        this.emit();
      }
    };
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    if (externalSignal?.aborted) abortFromExternal();
    this.controller = controller;
    try {
      if (controller.signal.aborted) return;
      const raw = await this.client.getPage({
        ...input,
        limit: MEMELOOP_TIMELINE_PAGE_LIMIT,
        maxBytes: MEMELOOP_TIMELINE_PAGE_MAX_BYTES,
      }, { signal: controller.signal });
      if (generation !== this.generation || controller.signal.aborted) return;
      const result = validateConversationTimelineResult(raw, input.conversationId);
      if (result.reset) {
        if (!allowReset) throw new Error('timeline reset repeated while loading latest page');
        const stableRollback = rollbackSnapshot ?? freezeSnapshot({
          ...this.snapshot,
          loading: false,
          loadingKind: null,
        });
        const recovery = timelineResetRecoveryRequest(input, stableRollback.page, result.revision);
        this.snapshot = freezeSnapshot({
          ...this.snapshot,
          resetCount: this.snapshot.resetCount + 1,
        });
        await this.read(
          recovery,
          generation,
          false,
          externalSignal,
          stableRollback,
        );
        return;
      }
      this.snapshot = freezeSnapshot({ conversationId: input.conversationId, page: result, loading: false, loadingKind: null, resetCount: this.snapshot.resetCount, error: null });
      this.emit();
    } catch (error) {
      if (generation !== this.generation) return;
      if (controller.signal.aborted) {
        if (rollbackSnapshot && !rolledBack) {
          this.snapshot = rollbackSnapshot;
          this.emit();
        }
        return;
      }
      this.snapshot = freezeSnapshot({ ...this.snapshot, loading: false, loadingKind: null, error: error instanceof Error ? error : new Error('timeline request failed') });
      this.emit();
    } finally {
      externalSignal?.removeEventListener('abort', abortFromExternal);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        try {
          this.options.onListenerError?.(error);
        } catch {
          // Listener-error observers are notifications and cannot break state.
        }
      }
    }
  }
}

function freezeSnapshot(snapshot: ConversationTimelineWindowSnapshot): ConversationTimelineWindowSnapshot {
  return Object.freeze(snapshot);
}

function assertControllerOpaqueText(value: string, key: string): void {
  const state = { bytes: 0 };
  opaqueString(value, key, state, MEMELOOP_TIMELINE_PAGE_MAX_BYTES);
}

function assertControllerSafeIndex(value: number, key: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${key} must be a safe integer`);
  if (value < 0) throw new RangeError(`${key} must be non-negative`);
}

function timelineResetRecoveryRequest(
  input: Omit<ConversationTimelinePageRequest, 'limit' | 'maxBytes'>,
  previousPage: MemeLoopConversationTimelinePage | undefined,
  revision: string,
): Omit<ConversationTimelinePageRequest, 'limit' | 'maxBytes'> {
  let aroundEntryIndex = input.aroundEntryIndex;
  if (aroundEntryIndex === undefined && previousPage && input.beforeCursor !== undefined) {
    const start = previousPage.startEntryIndex ?? previousPage.items[0]?.entryIndex ?? 0;
    aroundEntryIndex = Math.max(0, start - Math.ceil(MEMELOOP_TIMELINE_PAGE_LIMIT / 2));
  } else if (aroundEntryIndex === undefined && previousPage && input.afterCursor !== undefined) {
    const end = previousPage.endEntryIndex ?? previousPage.items.at(-1)?.entryIndex ?? 0;
    aroundEntryIndex = Math.min(Math.max(0, previousPage.totalEntries - 1), end + Math.ceil(MEMELOOP_TIMELINE_PAGE_LIMIT / 2));
  }
  return {
    conversationId: input.conversationId,
    expectedRevision: revision,
    ...(aroundEntryIndex === undefined ? {} : { aroundEntryIndex }),
  };
}
