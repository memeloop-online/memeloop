import type { TUIMessage } from './types.js';

export const TUI_WINDOW_HARD_MAX_MESSAGES = 50;
export const TUI_WINDOW_HARD_MAX_BYTES = 256 * 1024;
export const TUI_DETAIL_HARD_MAX_BYTES = 256 * 1024;

const MAX_OPAQUE_TOKEN_CHARACTERS = 2_048;

export interface TUIMessagePageRequest {
  limit: number;
  maxBytes: number;
  direction: 'backward' | 'forward';
  cursor?: string;
  expectedRevision?: string;
}

export interface TUIMessagePageSuccess {
  reset: false;
  conversationId: string;
  revision: string;
  items: TUIMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  previousCursor?: string;
  nextCursor?: string;
  /** Semantic focus rendered outside the 50-message resident budget. */
  semanticAnchor?: TUIMessage;
}

export interface TUIMessagePageReset {
  reset: true;
  conversationId: string;
  revision: string;
}

export type TUIMessagePage = TUIMessagePageSuccess | TUIMessagePageReset;

export type TUIMessageWindowFocus =
  | { kind: 'turn'; turnId: string; cursor?: string }
  | { kind: 'timeline-entry'; entryId: string; cursor: string };

export interface TUIMessageWindowAroundRequest {
  focus: TUIMessageWindowFocus;
  expectedRevision: string;
  maxMessages: number;
  maxBytes: number;
}

export interface TUIMessageWindowSource {
  getMessagePage(
    conversationId: string,
    request: TUIMessagePageRequest,
    options: { signal: AbortSignal },
  ): Promise<TUIMessagePage>;
  getMessageDetail?(
    conversationId: string,
    messageId: string,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<string>;
  getMessageWindowAround?(
    conversationId: string,
    request: TUIMessageWindowAroundRequest,
    options: { signal: AbortSignal },
  ): Promise<TUIMessagePage>;
}

export interface TUIMessageWindowOptions {
  pageSize?: number;
  maxBytes?: number;
}

export interface TUIMessageWindowSnapshot {
  readonly conversationId?: string;
  readonly revision?: string;
  readonly messages: readonly TUIMessage[];
  readonly semanticAnchor?: TUIMessage;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly previousCursor?: string;
  readonly nextCursor?: string;
  readonly pendingTailCount: number;
  readonly loading: boolean;
  readonly error?: Error;
}

export type TUIMessageWindowListener = (snapshot: TUIMessageWindowSnapshot) => void;

interface ActiveRead {
  generation: number;
  token: symbol;
  abortController: AbortController;
  cleanup: () => void;
}

export class TUIMessageWindowController {
  readonly #pageSize: number;
  readonly #maxBytes: number;
  readonly #listeners = new Set<TUIMessageWindowListener>();
  #source: TUIMessageWindowSource | undefined;
  #generation = 0;
  #activeRead: ActiveRead | undefined;
  #snapshot: TUIMessageWindowSnapshot = immutableSnapshot({
    messages: [],
    hasMoreBefore: false,
    hasMoreAfter: false,
    pendingTailCount: 0,
    loading: false,
  });

  constructor(options: TUIMessageWindowOptions = {}) {
    this.#pageSize = boundedPositiveInteger(
      options.pageSize ?? TUI_WINDOW_HARD_MAX_MESSAGES,
      TUI_WINDOW_HARD_MAX_MESSAGES,
      'pageSize',
    );
    this.#maxBytes = boundedPositiveInteger(
      options.maxBytes ?? TUI_WINDOW_HARD_MAX_BYTES,
      TUI_WINDOW_HARD_MAX_BYTES,
      'maxBytes',
    );
  }

  getSnapshot(): TUIMessageWindowSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: TUIMessageWindowListener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  /** Install an already bounded host page. Oversized input is rejected, never sliced. */
  setInitialMessages(messages: readonly TUIMessage[]): void {
    assertResidentMessages(messages, this.#pageSize, this.#maxBytes);
    this.#cancelActiveRead();
    this.#generation += 1;
    this.#source = undefined;
    this.#emit({
      messages,
      hasMoreBefore: false,
      hasMoreAfter: false,
      pendingTailCount: 0,
      loading: false,
      error: undefined,
    });
  }

  async open(
    source: TUIMessageWindowSource,
    conversationId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    assertOpaqueToken(conversationId, 'conversationId');
    this.#cancelActiveRead();
    this.#generation += 1;
    this.#source = source;
    const operation = this.#beginRead(options.signal);
    this.#emit({
      conversationId,
      messages: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
      pendingTailCount: 0,
      loading: true,
      error: undefined,
    });
    try {
      const page = await source.getMessagePage(conversationId, {
        limit: this.#pageSize,
        maxBytes: this.#maxBytes,
        direction: 'backward',
      }, { signal: operation.abortController.signal });
      if (!this.#isCurrent(operation)) return;
      const success = assertTUIMessagePage(page, conversationId, this.#pageSize, this.#maxBytes);
      if (success.reset) throw new Error('unexpected_initial_tui_message_page_reset');
      this.#replacePage(success);
    } catch (error) {
      if (operation.abortController.signal.aborted) {
        if (this.#ownsOperation(operation)) this.#emit({ ...this.#snapshot, loading: false });
        return;
      }
      if (!this.#isCurrent(operation)) return;
      this.#emit({ ...this.#snapshot, loading: false, error: asError(error) });
    } finally {
      this.#finishRead(operation);
    }
  }

  loadOlder(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.#loadDirection('backward', options.signal);
  }

  loadNewer(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.#loadDirection('forward', options.signal);
  }

  /** Atomically seek a historical turn or a real semantic timeline entry. */
  async jumpTo(
    focus: TUIMessageWindowFocus,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const source = this.#source;
    const conversationId = this.#snapshot.conversationId;
    const revision = this.#snapshot.revision;
    if (!source?.getMessageWindowAround || !conversationId || !revision) return;
    assertTUIMessageWindowFocus(focus);
    const operation = this.#beginRead(options.signal);
    this.#emit({ ...this.#snapshot, loading: true, error: undefined });
    try {
      const page = await source.getMessageWindowAround(conversationId, {
        focus,
        expectedRevision: revision,
        maxMessages: this.#pageSize,
        maxBytes: this.#maxBytes,
      }, { signal: operation.abortController.signal });
      if (!this.#isCurrent(operation)) return;
      const result = assertTUIMessagePage(page, conversationId, this.#pageSize, this.#maxBytes);
      if (result.reset) {
        await this.#refetchLatest(source, conversationId, operation);
        return;
      }
      if (result.revision !== revision) throw new Error('invalid_tui_message_page_revision');
      this.#replacePage(result);
    } catch (error) {
      if (operation.abortController.signal.aborted) {
        if (this.#ownsOperation(operation)) this.#emit({ ...this.#snapshot, loading: false });
        return;
      }
      if (!this.#isCurrent(operation)) return;
      this.#emit({ ...this.#snapshot, loading: false, error: asError(error) });
    } finally {
      this.#finishRead(operation);
    }
  }

  /** Add a live tail projection without allowing a disjoint old window. */
  appendTail(message: TUIMessage): void {
    assertTUIMessage(message);
    assertResidentMessages([message], this.#pageSize, this.#maxBytes);
    if (this.#snapshot.hasMoreAfter) {
      this.#emit({
        ...this.#snapshot,
        pendingTailCount: Math.min(Number.MAX_SAFE_INTEGER, this.#snapshot.pendingTailCount + 1),
      });
      return;
    }
    const merged = mergeResidentMessages(
      this.#snapshot.messages,
      [message],
      'newer',
      this.#pageSize,
      this.#maxBytes,
    );
    this.#emit({
      ...this.#snapshot,
      messages: merged.messages,
      hasMoreBefore: this.#snapshot.hasMoreBefore || merged.trimmed,
      pendingTailCount: 0,
      error: undefined,
    });
  }

  replaceLast(message: TUIMessage): void {
    assertTUIMessage(message);
    const current = this.#snapshot.messages;
    if (current.length === 0 || current.at(-1)?.messageId !== message.messageId) return;
    const messages = [...current.slice(0, -1), message];
    assertResidentMessages(messages, this.#pageSize, this.#maxBytes);
    this.#emit({ ...this.#snapshot, messages, error: undefined });
  }

  async loadDetail(
    messageId: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<string | undefined> {
    const source = this.#source;
    const conversationId = this.#snapshot.conversationId;
    if (!source?.getMessageDetail || !conversationId) return undefined;
    assertOpaqueToken(messageId, 'messageId');
    const maxBytes = boundedPositiveInteger(
      options.maxBytes ?? TUI_DETAIL_HARD_MAX_BYTES,
      TUI_DETAIL_HARD_MAX_BYTES,
      'detail.maxBytes',
    );
    if (maxBytes < 32) throw new Error('invalid_tui_detail_maxBytes');
    const operation = this.#beginRead(options.signal);
    try {
      const value = await source.getMessageDetail(conversationId, messageId, {
        maxBytes,
        signal: operation.abortController.signal,
      });
      if (!this.#isCurrent(operation)) return undefined;
      assertSafeDisplayText(value, 'detail');
      if (utf8Bytes(value) > maxBytes) throw new Error('tui_message_detail_exceeds_byte_budget');
      return value;
    } catch (error) {
      if (operation.abortController.signal.aborted) return undefined;
      throw error;
    } finally {
      this.#finishRead(operation);
    }
  }

  exportVisibleWindow(): string {
    const exported = JSON.stringify({
      conversationId: this.#snapshot.conversationId,
      revision: this.#snapshot.revision,
      semanticAnchor: this.#snapshot.semanticAnchor,
      messages: this.#snapshot.messages,
    });
    if (utf8Bytes(exported) > this.#maxBytes) throw new Error('tui_export_exceeds_byte_budget');
    return exported;
  }

  stop(): void {
    this.#cancelActiveRead();
    this.#generation += 1;
    this.#source = undefined;
  }

  async #loadDirection(direction: 'backward' | 'forward', signal?: AbortSignal): Promise<void> {
    const source = this.#source;
    const conversationId = this.#snapshot.conversationId;
    const revision = this.#snapshot.revision;
    const cursor = direction === 'backward'
      ? this.#snapshot.previousCursor
      : this.#snapshot.nextCursor;
    const hasMore = direction === 'backward'
      ? this.#snapshot.hasMoreBefore
      : this.#snapshot.hasMoreAfter;
    if (!source || !conversationId || !revision || !cursor || !hasMore) return;
    const operation = this.#beginRead(signal);
    this.#emit({ ...this.#snapshot, loading: true, error: undefined });
    try {
      const page = await source.getMessagePage(conversationId, {
        limit: this.#pageSize,
        maxBytes: this.#maxBytes,
        direction,
        cursor,
        expectedRevision: revision,
      }, { signal: operation.abortController.signal });
      if (!this.#isCurrent(operation)) return;
      const result = assertTUIMessagePage(page, conversationId, this.#pageSize, this.#maxBytes);
      if (result.reset) {
        await this.#refetchLatest(source, conversationId, operation);
        return;
      }
      if (result.revision !== revision) throw new Error('invalid_tui_message_page_revision');
      const merged = direction === 'backward'
        ? mergeResidentMessages(result.items, this.#snapshot.messages, 'older', this.#pageSize, this.#maxBytes)
        : mergeResidentMessages(this.#snapshot.messages, result.items, 'newer', this.#pageSize, this.#maxBytes);
      this.#emit({
        conversationId,
        revision: result.revision,
        messages: merged.messages,
        semanticAnchor: undefined,
        hasMoreBefore: direction === 'backward'
          ? result.hasMoreBefore
          : this.#snapshot.hasMoreBefore || merged.trimmed,
        hasMoreAfter: direction === 'forward'
          ? result.hasMoreAfter
          : this.#snapshot.hasMoreAfter || merged.trimmed,
        previousCursor: direction === 'backward'
          ? result.previousCursor
          : result.previousCursor ?? this.#snapshot.previousCursor,
        nextCursor: direction === 'forward'
          ? result.nextCursor
          : result.nextCursor ?? this.#snapshot.nextCursor,
        pendingTailCount: direction === 'forward' && !result.hasMoreAfter
          ? 0
          : this.#snapshot.pendingTailCount,
        loading: false,
        error: undefined,
      });
    } catch (error) {
      if (operation.abortController.signal.aborted) {
        if (this.#ownsOperation(operation)) this.#emit({ ...this.#snapshot, loading: false });
        return;
      }
      if (!this.#isCurrent(operation)) return;
      this.#emit({ ...this.#snapshot, loading: false, error: asError(error) });
    } finally {
      this.#finishRead(operation);
    }
  }

  async #refetchLatest(
    source: TUIMessageWindowSource,
    conversationId: string,
    operation: ActiveRead,
  ): Promise<void> {
    const latest = await source.getMessagePage(conversationId, {
      limit: this.#pageSize,
      maxBytes: this.#maxBytes,
      direction: 'backward',
    }, { signal: operation.abortController.signal });
    if (!this.#isCurrent(operation)) return;
    const result = assertTUIMessagePage(latest, conversationId, this.#pageSize, this.#maxBytes);
    if (result.reset) throw new Error('unexpected_latest_tui_message_page_reset');
    this.#replacePage(result);
  }

  #replacePage(page: TUIMessagePageSuccess): void {
    this.#emit({
      conversationId: page.conversationId,
      revision: page.revision,
      messages: page.items,
      semanticAnchor: page.semanticAnchor,
      hasMoreBefore: page.hasMoreBefore,
      hasMoreAfter: page.hasMoreAfter,
      previousCursor: page.previousCursor,
      nextCursor: page.nextCursor,
      pendingTailCount: 0,
      loading: false,
      error: undefined,
    });
  }

  #beginRead(externalSignal?: AbortSignal): ActiveRead {
    this.#cancelActiveRead();
    const abortController = new AbortController();
    const relay = () => {
      abortController.abort(externalSignal?.reason);
    };
    if (externalSignal?.aborted) relay();
    else externalSignal?.addEventListener('abort', relay, { once: true });
    const operation = {
      generation: this.#generation,
      token: Symbol('tui-message-read'),
      abortController,
      cleanup: () => externalSignal?.removeEventListener('abort', relay),
    };
    this.#activeRead = operation;
    return operation;
  }

  #isCurrent(operation: ActiveRead): boolean {
    return this.#ownsOperation(operation) &&
      !operation.abortController.signal.aborted;
  }

  #ownsOperation(operation: ActiveRead): boolean {
    return this.#activeRead === operation &&
      operation.generation === this.#generation &&
      this.#source !== undefined;
  }

  #finishRead(operation: ActiveRead): void {
    if (
      this.#ownsOperation(operation) &&
      operation.abortController.signal.aborted &&
      this.#snapshot.loading
    ) this.#emit({ ...this.#snapshot, loading: false });
    operation.cleanup();
    if (this.#activeRead === operation) this.#activeRead = undefined;
  }

  #cancelActiveRead(): void {
    const active = this.#activeRead;
    this.#activeRead = undefined;
    if (!active) return;
    active.abortController.abort();
    active.cleanup();
    if (this.#snapshot.loading) this.#emit({ ...this.#snapshot, loading: false });
  }

  #emit(snapshot: TUIMessageWindowSnapshot): void {
    this.#snapshot = immutableSnapshot(snapshot);
    for (const listener of [...this.#listeners]) listener(this.#snapshot);
  }
}

export function assertTUIMessagePage(
  value: TUIMessagePage,
  conversationId: string,
  limit: number,
  maxBytes: number,
): TUIMessagePage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_tui_message_page_scope');
  }
  assertExactKeys(value, [
    'reset',
    'conversationId',
    'revision',
    'items',
    'hasMoreBefore',
    'hasMoreAfter',
    'previousCursor',
    'nextCursor',
    'semanticAnchor',
  ]);
  if (value.conversationId !== conversationId) {
    throw new Error('invalid_tui_message_page_scope');
  }
  assertOpaqueToken(value.revision, 'revision');
  if (typeof value.reset !== 'boolean') throw new Error('invalid_tui_message_page');
  if (value.reset) {
    assertExactKeys(value, ['reset', 'conversationId', 'revision']);
    if (encodedBytes(value) > maxBytes) throw new Error('tui_message_page_exceeds_byte_budget');
    return value;
  }
  assertExactKeys(value, [
    'reset',
    'conversationId',
    'revision',
    'items',
    'hasMoreBefore',
    'hasMoreAfter',
    'previousCursor',
    'nextCursor',
    'semanticAnchor',
  ]);
  if (
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    typeof value.hasMoreBefore !== 'boolean' ||
    typeof value.hasMoreAfter !== 'boolean' ||
    (value.hasMoreBefore && !isOpaqueToken(value.previousCursor)) ||
    (value.hasMoreAfter && !isOpaqueToken(value.nextCursor)) ||
    (value.previousCursor !== undefined && !isOpaqueToken(value.previousCursor)) ||
    (value.nextCursor !== undefined && !isOpaqueToken(value.nextCursor))
  ) throw new Error('invalid_tui_message_page');
  assertResidentMessages(value.items, limit, maxBytes);
  if (value.semanticAnchor !== undefined) {
    assertTUIMessage(value.semanticAnchor);
    if (value.semanticAnchor.kind !== 'compaction') {
      throw new Error('invalid_tui_semantic_anchor');
    }
  }
  if (encodedBytes(value) > maxBytes) throw new Error('tui_message_page_exceeds_byte_budget');
  return value;
}

function assertTUIMessageWindowFocus(value: TUIMessageWindowFocus): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_tui_message_window_focus');
  }
  if (value.kind === 'turn') {
    assertExactKeys(value, ['kind', 'turnId', 'cursor']);
    assertOpaqueToken(value.turnId, 'focus.turnId');
    if (value.cursor !== undefined) assertOpaqueToken(value.cursor, 'focus.cursor');
    return;
  }
  if (value.kind === 'timeline-entry') {
    assertExactKeys(value, ['kind', 'entryId', 'cursor']);
    assertOpaqueToken(value.entryId, 'focus.entryId');
    assertOpaqueToken(value.cursor, 'focus.cursor');
    return;
  }
  throw new Error('invalid_tui_message_window_focus');
}

export function assertResidentMessages(
  messages: readonly TUIMessage[],
  limit = TUI_WINDOW_HARD_MAX_MESSAGES,
  maxBytes = TUI_WINDOW_HARD_MAX_BYTES,
): void {
  if (!Array.isArray(messages as unknown) || messages.length > limit) {
    throw new Error('tui_message_window_exceeds_message_limit');
  }
  const ids = new Set<string>();
  for (const message of messages) {
    assertTUIMessage(message);
    if (ids.has(message.messageId)) throw new Error('duplicate_tui_message_id');
    ids.add(message.messageId);
  }
  if (encodedBytes(messages) > maxBytes) throw new Error('tui_message_window_exceeds_byte_budget');
}

export function appendTUIResidentMessage(
  messages: readonly TUIMessage[],
  message: TUIMessage,
): { messages: TUIMessage[]; trimmed: boolean } {
  assertResidentMessages(messages);
  assertTUIMessage(message);
  return mergeResidentMessages(
    messages,
    [message],
    'newer',
    TUI_WINDOW_HARD_MAX_MESSAGES,
    TUI_WINDOW_HARD_MAX_BYTES,
  );
}

export function assertTUIMessage(value: TUIMessage): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_tui_message');
  }
  assertExactKeys(value, [
    'kind',
    'messageId',
    'role',
    'content',
    'timestamp',
    'toolName',
    'toolInput',
    'toolResult',
    'thinking',
    'detail',
    'compaction',
  ]);
  assertOpaqueToken(value.messageId, 'message.messageId');
  if (!['user', 'assistant', 'system', 'tool'].includes(value.role)) {
    throw new Error('invalid_tui_message_role');
  }
  if (
    Reflect.getPrototypeOf(value.timestamp) !== Date.prototype ||
    !Number.isFinite(Date.prototype.getTime.call(value.timestamp))
  ) {
    throw new Error('invalid_tui_message_timestamp');
  }
  assertSafeDisplayText(value.content, 'content');
  for (
    const [field, text] of [
      ['toolName', value.toolName],
      ['toolResult', value.toolResult],
      ['thinking', value.thinking],
    ] as const
  ) {
    if (text !== undefined) assertSafeDisplayText(text, field);
  }
  if (value.toolInput !== undefined) {
    if (Array.isArray(value.toolInput)) throw new Error('invalid_tui_tool_input');
    assertBoundedTUIJson(value.toolInput);
  }
  if (value.detail !== undefined) {
    assertExactKeys(value.detail, ['truncated', 'originalBytes', 'detailRef']);
    if (
      typeof value.detail.truncated !== 'boolean' ||
      !Number.isSafeInteger(value.detail.originalBytes) ||
      value.detail.originalBytes < 0
    ) throw new Error('invalid_tui_message_detail');
    if (value.detail.detailRef !== undefined) {
      assertSafeDisplayText(value.detail.detailRef, 'detailRef');
    }
  }
  if (value.kind === 'compaction') {
    if (
      !value.compaction ||
      value.role !== 'system' ||
      value.toolName !== undefined ||
      value.toolInput !== undefined ||
      value.toolResult !== undefined ||
      value.thinking !== undefined
    ) throw new Error('invalid_tui_compaction_marker');
    assertExactKeys(value.compaction, [
      'entryId',
      'summaryPreview',
      'compactedMessageCount',
      'compactedTurnCount',
    ]);
    assertOpaqueToken(value.compaction.entryId, 'compaction.entryId');
    if (value.messageId !== value.compaction.entryId) throw new Error('invalid_tui_compaction_marker');
    assertSafeDisplayText(value.compaction.summaryPreview, 'compaction.summaryPreview');
    if (
      !Number.isSafeInteger(value.compaction.compactedMessageCount) ||
      value.compaction.compactedMessageCount < 0 ||
      !Number.isSafeInteger(value.compaction.compactedTurnCount) ||
      value.compaction.compactedTurnCount < 0
    ) throw new Error('invalid_tui_compaction_marker');
  } else {
    if (value.kind !== undefined && value.kind !== 'message') {
      throw new Error('invalid_tui_message_kind');
    }
    if (value.compaction !== undefined) throw new Error('invalid_tui_compaction_marker');
  }
  // This also rejects cycles, BigInt, accessors reached by serialization, and
  // unbounded toolInput graphs before they enter resident state.
  if (encodedBytes(value) > TUI_WINDOW_HARD_MAX_BYTES) {
    throw new Error('tui_message_exceeds_byte_budget');
  }
}

function mergeResidentMessages(
  first: readonly TUIMessage[],
  second: readonly TUIMessage[],
  retain: 'older' | 'newer',
  limit: number,
  maxBytes: number,
): { messages: TUIMessage[]; trimmed: boolean } {
  const byId = new Map<string, TUIMessage>();
  for (const message of [...first, ...second]) byId.set(message.messageId, message);
  const ordered = [...byId.values()].sort((left, right) =>
    Date.prototype.getTime.call(left.timestamp) - Date.prototype.getTime.call(right.timestamp) ||
    left.messageId.localeCompare(right.messageId)
  );
  const candidates = retain === 'older' ? ordered : [...ordered].reverse();
  const selected: TUIMessage[] = [];
  for (const message of candidates) {
    if (selected.length >= limit) break;
    const trial = retain === 'older' ? [...selected, message] : [message, ...selected];
    if (encodedBytes(trial) > maxBytes) break;
    selected.push(message);
  }
  if (retain === 'newer') selected.reverse();
  return { messages: selected, trimmed: selected.length < ordered.length };
}

function immutableSnapshot(snapshot: TUIMessageWindowSnapshot): TUIMessageWindowSnapshot {
  const messages = snapshot.messages.map(message =>
    Object.freeze({
      ...message,
      timestamp: new Date(Date.prototype.getTime.call(message.timestamp)),
      ...(message.toolInput === undefined
        ? {}
        : { toolInput: cloneAndFreezeTUIJson(message.toolInput) }),
      ...(message.compaction ? { compaction: Object.freeze({ ...message.compaction }) } : {}),
      ...(message.detail ? { detail: Object.freeze({ ...message.detail }) } : {}),
    })
  );
  return Object.freeze({ ...snapshot, messages: Object.freeze(messages) });
}

function cloneAndFreezeTUIJson(value: Record<string, unknown>): Record<string, unknown>;
function cloneAndFreezeTUIJson(value: unknown): unknown;
function cloneAndFreezeTUIJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(item => cloneAndFreezeTUIJson(item)));
  }
  const clone = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    clone[key] = cloneAndFreezeTUIJson(child);
  }
  return Object.freeze(clone);
}

function encodedBytes(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value));
  } catch (error) {
    throw new Error('invalid_tui_json_value', { cause: error });
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) {
    throw new Error('invalid_tui_object_shape');
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('get' in descriptor || 'set' in descriptor) throw new Error('invalid_tui_accessor');
  }
}

function assertSafeDisplayText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !isWellFormedUnicode(value) || hasUnsafeTerminalControls(value)) {
    throw new Error(`invalid_tui_${field.replaceAll('.', '_')}`);
  }
}

function assertBoundedTUIJson(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 2_000 || current.depth > 16) throw new Error('invalid_tui_tool_input');
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'string') {
      assertSafeDisplayText(current.value, 'toolInput');
      continue;
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) throw new Error('invalid_tui_tool_input');
      continue;
    }
    if (typeof current.value !== 'object') throw new Error('invalid_tui_tool_input');
    const record = current.value;
    const prototype = Reflect.getPrototypeOf(record);
    if (!Array.isArray(record) && prototype !== Object.prototype && prototype !== null) {
      throw new Error('invalid_tui_tool_input');
    }
    const descriptors = Object.getOwnPropertyDescriptors(record);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new Error('invalid_tui_tool_input');
      if (Array.isArray(record) && key === 'length') continue;
      if (Array.isArray(record) && !/^(?:0|[1-9]\d*)$/u.test(key)) {
        throw new Error('invalid_tui_tool_input');
      }
      const descriptor = descriptors[key];
      assertSafeDisplayText(key, 'toolInput.key');
      if (
        'get' in descriptor ||
        'set' in descriptor ||
        descriptor.enumerable !== true
      ) throw new Error('invalid_tui_tool_input');
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) return false;
  }
  return true;
}

function hasUnsafeTerminalControls(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

function isOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_TOKEN_CHARACTERS &&
    value === value.trim() &&
    isWellFormedUnicode(value) &&
    !hasUnsafeTerminalControls(value);
}

function assertOpaqueToken(value: unknown, field: string): asserts value is string {
  if (!isOpaqueToken(value)) throw new Error(`invalid_tui_${field.replaceAll('.', '_')}`);
}

function boundedPositiveInteger(value: number, hardMaximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) {
    throw new Error(`invalid_tui_${field.replaceAll('.', '_')}`);
  }
  return value;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
