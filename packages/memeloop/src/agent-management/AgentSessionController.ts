/**
 * AgentSessionController — headless controller for an active agent conversation session.
 *
 * Manages agent runtime state, message sending, streaming, delete/retry turns,
 * and subscription to live agent updates.
 *
 * No React, DOM, Electron, MUI, Zustand, or RxJS dependency.
 */

import { canonicalJsonBytes, CanonicalJsonError } from '../encoding/canonicalJson.js';
import { AGENT_RUN_ERROR_MESSAGE_KEYS, agentRunErrorFromUnknown, AgentRunFailure, createAgentRunError } from '../runState.js';
import { safeErrorFromUnknown } from '../safeError.js';
import {
  assertConversationMessageProjection,
  assertConversationTimelineCompactionEntry,
  compareMessageCursor,
  messageCursor,
  normalizeMessagePageLimit,
} from '../storage/conversationPaging.js';
import { linkAbortSignals } from './abortSignals.js';
import { type AgentSessionListener, type AgentSessionSnapshot, cloneImmutableSnapshotValue, createImmutableSessionSnapshot } from './agentSessionSnapshot.js';
import { assertAgentAttachmentInput } from './attachmentInput.js';
import {
  AGENT_SESSION_CONTRACT_LIMITS,
  type AgentConversationDeleteTurnRequest,
  type AgentConversationDeleteTurnResponse,
  type AgentConversationRetryTurnRequest,
  type AgentConversationRetryTurnResponse,
  type AgentConversationTurnDetailRequest,
  type AgentConversationTurnDetailResponse,
  parseAgentConversationDeleteTurnResponse,
  parseAgentConversationRetryTurnResponse,
  parseAgentConversationTurnDetailResponse,
} from './conversationCommands.js';
export type { AgentSessionListener, AgentSessionSnapshot } from './agentSessionSnapshot.js';
import type {
  AgentAttachmentInput,
  AgentConversationClient,
  AgentConversationMessagePage,
  AgentConversationMessagePageSuccess,
  AgentConversationMessageProjection,
  AgentConversationMessageWindowFocus,
  AgentConversationMessageWindowResult,
  AgentConversationUpdate,
  AgentInstanceClient,
  AgentManagementCallOptions,
  AgentRuntimeView,
  AgentSessionSeekResult,
  WikiTiddlerAttachment,
} from './types.js';
import { MAX_AGENT_CONVERSATION_APPENDED_MESSAGE_COUNT, MAX_AGENT_SESSION_PENDING_NEW_MESSAGE_COUNT } from './types.js';

const MAX_INTERACTIVE_SESSION_MESSAGES = 50;
const MAX_INTERACTIVE_SESSION_BYTES = 256 * 1024;
const DEFAULT_MAX_RESIDENT_SESSION_MESSAGES = MAX_INTERACTIVE_SESSION_MESSAGES;
const DEFAULT_MAX_RESIDENT_SESSION_BYTES = MAX_INTERACTIVE_SESSION_BYTES;
const INITIAL_MESSAGE_PAGE_SIZE = MAX_INTERACTIVE_SESSION_MESSAGES;
const MESSAGE_PROJECTION_MAX_DEPTH = 32;
const MESSAGE_PROJECTION_MAX_NODES = 10_000;

interface SessionGeneration {
  generation: number;
  agentId: string;
  conversationId: string;
  abortController: AbortController;
  initialSnapshotPending: boolean;
  bufferedMessages: Map<string, AgentConversationMessageProjection>;
  bufferedStreamingMessageIds: Set<string>;
  bufferedMessagesTrimmed: boolean;
  bufferedRevision?: string;
  bufferedInvalidationRevision?: string;
  refreshQueued: boolean;
  refreshRevision?: string;
  refreshAnchorTurnId?: string;
  refreshAnchorMessageId?: string;
  refreshPendingNewMessageCount: number;
  countedAppendRevisions: Map<string, { count: number; exact: boolean }>;
  seenInvalidationRevisions: Set<string>;
  acceptedInvalidationRevision?: string;
  refreshPromise?: Promise<void>;
}

interface SessionSeekOperation {
  abortController: AbortController;
  cleanup: () => void;
  windowGeneration: number;
}

/** Explicit durable identities for the runtime instance and its conversation. */
export interface AgentSessionTarget {
  agentId: string;
  conversationId: string;
}

export interface AgentSessionSeekCallOptions extends AgentManagementCallOptions {
  /** Required timeline revision used to fail closed on concurrent compaction/inserts. */
  expectedRevision: string;
}

/** Options for creating an AgentSessionController. */
export interface AgentSessionControllerOptions {
  agentInstanceClient: AgentInstanceClient;
  conversationClient: AgentConversationClient;
  /** Maximum projected messages retained in memory. Range 1..50; default 50. */
  maxResidentMessages?: number;
  /** Maximum UTF-8 JSON bytes shared by resident projections. Range 64..256 KiB; default 256 KiB. */
  maxResidentBytes?: number;
  /** Receives bounded diagnostics for listener and subscription cleanup failures. */
  onError?: (error: unknown, phase: 'listener' | 'unsubscribe') => void;
}

interface ResolvedAgentSessionControllerOptions extends AgentSessionControllerOptions {
  maxResidentMessages: number;
  maxResidentBytes: number;
}

/**
 * Headless controller for an agent conversation session.
 *
 * Call {@link start} to load an agent, then {@link subscribe} to receive snapshot
 * updates. Use {@link sendMessage}, {@link deleteTurn}, {@link retryTurn}, {@link cancel}
 * to drive the conversation.
 *
 * Host UI frameworks (React, Ink) subscribe via {@link subscribe} and render
 * the snapshot.
 */
export class AgentSessionController {
  private readonly options: ResolvedAgentSessionControllerOptions;
  private readonly listeners = new Set<AgentSessionListener>();
  private snapshot: AgentSessionSnapshot = createImmutableSessionSnapshot(undefined, {
    agent: null,
    loading: false,
    loadingMoreBefore: false,
    loadingMoreAfter: false,
    error: null,
    messages: [],
    orderedMessageIds: [],
    streamingMessageIds: new Set(),
    hasMoreBefore: false,
    hasMoreAfter: false,
    startCursor: undefined,
    endCursor: undefined,
    previousCursor: undefined,
    nextCursor: undefined,
    revision: undefined,
    windowAnchorTurnId: undefined,
    windowAnchorMessageId: undefined,
    pendingNewMessageCount: 0,
  });
  private unsubAgentUpdates: (() => void) | null = null;
  private unsubMessages: (() => void) | null = null;
  private generation = 0;
  private activeGeneration: SessionGeneration | null = null;
  private pageLoadToken: symbol | null = null;
  private activeSeek: SessionSeekOperation | null = null;
  private windowGeneration = 0;

  constructor(options: AgentSessionControllerOptions) {
    this.options = {
      maxResidentMessages: DEFAULT_MAX_RESIDENT_SESSION_MESSAGES,
      maxResidentBytes: DEFAULT_MAX_RESIDENT_SESSION_BYTES,
      ...options,
    };
    if (
      !Number.isSafeInteger(this.options.maxResidentMessages) ||
      this.options.maxResidentMessages < 1 ||
      this.options.maxResidentMessages > MAX_INTERACTIVE_SESSION_MESSAGES
    ) {
      throw new Error('invalid_max_resident_messages');
    }
    if (
      !Number.isSafeInteger(this.options.maxResidentBytes) ||
      this.options.maxResidentBytes < AGENT_SESSION_CONTRACT_LIMITS.projectionPageMinBytes ||
      this.options.maxResidentBytes > MAX_INTERACTIVE_SESSION_BYTES
    ) {
      throw new Error('invalid_max_resident_bytes');
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Start a session for the explicit agent and conversation identities.
   * Fetches the agent, subscribes to live updates, and loads messages.
   */
  async start(target: AgentSessionTarget): Promise<void> {
    this.assertSessionTarget(target);
    const context = this.beginGeneration(target);
    this.emitPartial({
      agent: null,
      loading: true,
      loadingMoreBefore: false,
      loadingMoreAfter: false,
      error: null,
      messages: [],
      orderedMessageIds: [],
      streamingMessageIds: new Set(),
      hasMoreBefore: false,
      hasMoreAfter: false,
      startCursor: undefined,
      endCursor: undefined,
      previousCursor: undefined,
      nextCursor: undefined,
      revision: undefined,
      windowAnchorTurnId: undefined,
      windowAnchorMessageId: undefined,
      pendingNewMessageCount: 0,
    });

    try {
      // Subscribe before the snapshot read. Messages delivered in the gap are
      // buffered and merged after the page, so page -> subscribe cannot lose a
      // committed message.
      const unsubscribeAgent = this.options.agentInstanceClient.subscribeToUpdates(
        context.agentId,
        update => {
          this.handleAgentUpdate(context, update);
        },
      );
      if (!this.isCurrent(context)) {
        this.safeUnsubscribe(unsubscribeAgent);
        return;
      }
      this.unsubAgentUpdates = unsubscribeAgent;

      const unsubscribeMessages = this.options.conversationClient.subscribeToMessages(
        context.conversationId,
        update => {
          this.handleConversationUpdate(context, update);
        },
      );
      if (!this.isCurrent(context)) {
        this.safeUnsubscribe(unsubscribeMessages);
        return;
      }
      this.unsubMessages = unsubscribeMessages;

      const [agent, initialPage] = await Promise.all([
        this.options.agentInstanceClient.fetchAgent(context.agentId, {
          signal: context.abortController.signal,
        }),
        this.options.conversationClient.getMessagePage(context.conversationId, {
          limit: this.residentMessageLimit(INITIAL_MESSAGE_PAGE_SIZE),
          direction: 'backward',
          maxBytes: this.projectionPageByteBudget(),
        }, {
          signal: context.abortController.signal,
        }),
      ]);
      if (!this.isCurrent(context)) return;
      const normalizedPageResult = this.normalizeMessagePageResult(
        initialPage,
        context.conversationId,
        this.residentMessageLimit(INITIAL_MESSAGE_PAGE_SIZE),
        undefined,
      );
      if (normalizedPageResult.reset) {
        throw new Error('unexpected_initial_conversation_message_page_reset');
      }
      let normalizedPage = normalizedPageResult;
      const bufferedRequiresRefresh = () =>
        context.bufferedInvalidationRevision !== undefined ||
        (context.bufferedRevision !== undefined && context.bufferedRevision !== normalizedPage.revision);
      for (let attempt = 0; attempt < 3 && bufferedRequiresRefresh(); attempt += 1) {
        context.bufferedMessages.clear();
        context.bufferedStreamingMessageIds.clear();
        context.bufferedMessagesTrimmed = false;
        context.bufferedRevision = undefined;
        context.bufferedInvalidationRevision = undefined;
        const refreshedResult = this.normalizeMessagePageResult(
          await this.options.conversationClient.getMessagePage(context.conversationId, {
            limit: this.residentMessageLimit(INITIAL_MESSAGE_PAGE_SIZE),
            direction: 'backward',
            maxBytes: this.projectionPageByteBudget(),
          }, {
            signal: context.abortController.signal,
          }),
          context.conversationId,
          this.residentMessageLimit(INITIAL_MESSAGE_PAGE_SIZE),
          undefined,
        );
        if (!this.isCurrent(context)) return;
        if (refreshedResult.reset) {
          throw new Error('unexpected_initial_conversation_message_page_reset');
        }
        normalizedPage = refreshedResult;
      }
      if (bufferedRequiresRefresh()) {
        throw new Error('conversation_invalidation_refresh_exhausted');
      }
      const bufferedMessages = [...context.bufferedMessages.values()];
      const bufferedStreamingMessageIds = new Set(context.bufferedStreamingMessageIds);
      context.bufferedMessages.clear();
      context.bufferedStreamingMessageIds.clear();
      context.initialSnapshotPending = false;
      const { messages: rawMessages, trimmed } = this.mergeResidentMessages(
        normalizedPage.items,
        bufferedMessages,
        'after',
      );
      const orderedMessageIds = rawMessages.map(message => message.messageId);

      this.emitPartial({
        agent,
        loading: false,
        messages: rawMessages,
        orderedMessageIds,
        streamingMessageIds: new Set(
          [...bufferedStreamingMessageIds].filter(messageId => rawMessages.some(message => message.messageId === messageId)),
        ),
        hasMoreBefore: normalizedPage.hasMoreBefore || context.bufferedMessagesTrimmed || trimmed,
        hasMoreAfter: normalizedPage.hasMoreAfter,
        startCursor: rawMessages[0] ? messageCursor(rawMessages[0]) : undefined,
        endCursor: rawMessages.at(-1) ? messageCursor(rawMessages.at(-1)!) : undefined,
        previousCursor: normalizedPage.previousCursor,
        nextCursor: normalizedPage.nextCursor,
        revision: normalizedPage.revision,
        ...this.messageAnchorFields(rawMessages.at(-1)),
      });
      this.acceptInvalidationRevision(context, normalizedPage.revision);
      if (!this.isCurrent(context)) return;
    } catch (error_) {
      if (!this.isCurrent(context)) return;
      this.cleanupSources();
      this.emitPartial({
        loading: false,
        error: safeErrorFromUnknown(error_, { fallback: 'Conversation session start failed' }),
      });
    }
  }

  /** Prepend one older keyset page when the host exposes optimized paging. */
  async loadMoreBefore(
    limit = MAX_INTERACTIVE_SESSION_MESSAGES,
    callOptions: AgentManagementCallOptions = {},
  ): Promise<void> {
    const context = this.activeGeneration;
    if (
      !context ||
      this.pageLoadToken ||
      this.activeSeek ||
      !this.snapshot.hasMoreBefore ||
      !this.snapshot.previousCursor ||
      !this.snapshot.revision
    ) return;
    const requestOpaqueCursor = this.snapshot.previousCursor;
    const expectedRevision = this.snapshot.revision;
    const resetAnchorTurnId = this.snapshot.windowAnchorTurnId;
    const resetAnchorMessageId = this.snapshot.windowAnchorMessageId;
    const resetPendingNewMessageCount = this.snapshot.pendingNewMessageCount;
    const normalizedLimit = this.residentMessageLimit(limit);
    const token = Symbol('load-more-before');
    const requestedWindowGeneration = this.windowGeneration;
    const linked = linkAbortSignals(context.abortController.signal, callOptions.signal);
    if (linked.signal.aborted) {
      linked.cleanup();
      return;
    }
    this.pageLoadToken = token;
    this.emitPartial({ loadingMoreBefore: true });
    try {
      const pageResult = this.normalizeMessagePageResult(
        await this.options.conversationClient.getMessagePage(context.conversationId, {
          limit: normalizedLimit,
          cursor: requestOpaqueCursor,
          expectedRevision,
          direction: 'backward',
          maxBytes: this.projectionPageByteBudget(),
        }, {
          signal: linked.signal,
        }),
        context.conversationId,
        normalizedLimit,
        expectedRevision,
      );
      if (
        linked.signal.aborted ||
        !this.isCurrent(context) ||
        requestedWindowGeneration !== this.windowGeneration
      ) return;
      if (pageResult.reset) {
        if (resetAnchorTurnId === undefined || resetAnchorMessageId === undefined) {
          this.emitPartial({ error: new Error('conversation_paging_reset_anchor_missing') });
          return;
        }
        await this.refreshInvalidatedResidentWindow(
          context,
          pageResult.revision,
          'reset',
          0,
          false,
          {
            turnId: resetAnchorTurnId,
            messageId: resetAnchorMessageId,
            pendingNewMessageCount: resetPendingNewMessageCount,
          },
        );
        await this.retryDirectionalPageAfterReset(
          context,
          'before',
          normalizedLimit,
          requestedWindowGeneration,
          linked.signal,
        );
        return;
      }
      const page = pageResult;
      const { messages, trimmed: wasTrimmed } = this.mergeResidentMessages(
        page.items,
        this.snapshot.messages,
        'before',
      );
      this.emitPartial({
        messages,
        orderedMessageIds: messages.map(message => message.messageId),
        streamingMessageIds: new Set(
          [...this.snapshot.streamingMessageIds].filter(messageId => messages.some(message => message.messageId === messageId)),
        ),
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: this.snapshot.hasMoreAfter || wasTrimmed,
        startCursor: messages[0] ? messageCursor(messages[0]) : this.snapshot.startCursor,
        endCursor: messages.at(-1) ? messageCursor(messages.at(-1)!) : this.snapshot.endCursor,
        previousCursor: page.previousCursor,
        nextCursor: wasTrimmed ? page.nextCursor : this.snapshot.nextCursor,
        revision: page.revision,
        ...this.pageBoundaryAnchorFields(messages, page.items, 'before'),
      });
    } catch (error_) {
      if (linked.signal.aborted || !this.isCurrent(context)) return;
      this.emitPartial({
        error: safeErrorFromUnknown(error_, { fallback: 'Conversation history load failed' }),
      });
    } finally {
      linked.cleanup();
      if (this.pageLoadToken === token) {
        this.pageLoadToken = null;
        if (this.isCurrent(context)) this.emitPartial({ loadingMoreBefore: false });
      }
    }
  }

  /** Append one newer keyset page without allowing the resident window to grow unbounded. */
  async loadMoreAfter(
    limit = MAX_INTERACTIVE_SESSION_MESSAGES,
    callOptions: AgentManagementCallOptions = {},
  ): Promise<void> {
    const context = this.activeGeneration;
    if (
      !context ||
      this.pageLoadToken ||
      this.activeSeek ||
      !this.snapshot.hasMoreAfter ||
      !this.snapshot.nextCursor ||
      !this.snapshot.revision
    ) return;
    const requestOpaqueCursor = this.snapshot.nextCursor;
    const expectedRevision = this.snapshot.revision;
    const resetAnchorTurnId = this.snapshot.windowAnchorTurnId;
    const resetAnchorMessageId = this.snapshot.windowAnchorMessageId;
    const resetPendingNewMessageCount = this.snapshot.pendingNewMessageCount;
    const normalizedLimit = this.residentMessageLimit(limit);
    const token = Symbol('load-more-after');
    const requestedWindowGeneration = this.windowGeneration;
    const linked = linkAbortSignals(context.abortController.signal, callOptions.signal);
    if (linked.signal.aborted) {
      linked.cleanup();
      return;
    }
    this.pageLoadToken = token;
    this.emitPartial({ loadingMoreAfter: true });
    try {
      const pageResult = this.normalizeMessagePageResult(
        await this.options.conversationClient.getMessagePage(context.conversationId, {
          limit: normalizedLimit,
          cursor: requestOpaqueCursor,
          expectedRevision,
          direction: 'forward',
          maxBytes: this.projectionPageByteBudget(),
        }, {
          signal: linked.signal,
        }),
        context.conversationId,
        normalizedLimit,
        expectedRevision,
      );
      if (
        linked.signal.aborted ||
        !this.isCurrent(context) ||
        requestedWindowGeneration !== this.windowGeneration
      ) return;
      if (pageResult.reset) {
        if (resetAnchorTurnId === undefined || resetAnchorMessageId === undefined) {
          this.emitPartial({ error: new Error('conversation_paging_reset_anchor_missing') });
          return;
        }
        await this.refreshInvalidatedResidentWindow(
          context,
          pageResult.revision,
          'reset',
          0,
          false,
          {
            turnId: resetAnchorTurnId,
            messageId: resetAnchorMessageId,
            pendingNewMessageCount: resetPendingNewMessageCount,
          },
        );
        await this.retryDirectionalPageAfterReset(
          context,
          'after',
          normalizedLimit,
          requestedWindowGeneration,
          linked.signal,
        );
        return;
      }
      const page = pageResult;
      const { messages, trimmed: wasTrimmed } = this.mergeResidentMessages(
        this.snapshot.messages,
        page.items,
        'after',
      );
      this.emitPartial({
        messages,
        orderedMessageIds: messages.map(message => message.messageId),
        streamingMessageIds: new Set(
          [...this.snapshot.streamingMessageIds].filter(messageId => messages.some(message => message.messageId === messageId)),
        ),
        hasMoreBefore: this.snapshot.hasMoreBefore || wasTrimmed,
        hasMoreAfter: page.hasMoreAfter,
        startCursor: messages[0] ? messageCursor(messages[0]) : this.snapshot.startCursor,
        endCursor: messages.at(-1) ? messageCursor(messages.at(-1)!) : this.snapshot.endCursor,
        previousCursor: wasTrimmed ? page.previousCursor : this.snapshot.previousCursor,
        nextCursor: page.nextCursor,
        revision: page.revision,
        pendingNewMessageCount: page.hasMoreAfter
          ? this.snapshot.pendingNewMessageCount
          : 0,
        ...this.pageBoundaryAnchorFields(messages, page.items, 'after'),
      });
    } catch (error_) {
      if (linked.signal.aborted || !this.isCurrent(context)) return;
      this.emitPartial({
        error: safeErrorFromUnknown(error_, { fallback: 'Conversation history load failed' }),
      });
    } finally {
      linked.cleanup();
      if (this.pageLoadToken === token) {
        this.pageLoadToken = null;
        if (this.isCurrent(context)) this.emitPartial({ loadingMoreAfter: false });
      }
    }
  }

  /** Atomically replace an older resident window with one bounded latest-tail page. */
  async jumpToLatest(callOptions: AgentManagementCallOptions = {}): Promise<void> {
    const context = this.activeGeneration;
    if (!context || context.initialSnapshotPending) return;
    const operation = this.beginSeekOperation(context, callOptions.signal);
    // Fence any in-flight keyset page and consume invalidations already queued
    // for the older window. An invalidation arriving after this point aborts
    // this operation and owns the next bounded refresh.
    this.pageLoadToken = null;
    context.bufferedMessages.clear();
    context.bufferedStreamingMessageIds.clear();
    context.bufferedMessagesTrimmed = false;
    context.bufferedRevision = undefined;
    context.bufferedInvalidationRevision = undefined;
    context.refreshQueued = false;
    context.refreshRevision = undefined;
    context.refreshAnchorTurnId = undefined;
    context.refreshAnchorMessageId = undefined;
    context.refreshPendingNewMessageCount = 0;
    try {
      const limit = this.residentMessageLimit(INITIAL_MESSAGE_PAGE_SIZE);
      const latestResult = this.normalizeMessagePageResult(
        await this.options.conversationClient.getMessagePage(context.conversationId, {
          limit,
          direction: 'backward',
          maxBytes: this.projectionPageByteBudget(),
        }, {
          signal: operation.abortController.signal,
        }),
        context.conversationId,
        limit,
        undefined,
      );
      if (
        latestResult.reset ||
        !this.isCurrent(context) ||
        this.activeSeek !== operation ||
        operation.abortController.signal.aborted ||
        operation.windowGeneration !== this.windowGeneration
      ) return;
      this.emitPartial({
        error: null,
        messages: latestResult.items,
        orderedMessageIds: latestResult.items.map(message => message.messageId),
        streamingMessageIds: new Set(),
        hasMoreBefore: latestResult.hasMoreBefore,
        hasMoreAfter: latestResult.hasMoreAfter,
        startCursor: latestResult.items[0]
          ? messageCursor(latestResult.items[0])
          : undefined,
        endCursor: latestResult.items.at(-1)
          ? messageCursor(latestResult.items.at(-1)!)
          : undefined,
        previousCursor: latestResult.previousCursor,
        nextCursor: latestResult.nextCursor,
        revision: latestResult.revision,
        pendingNewMessageCount: 0,
        ...this.messageAnchorFields(latestResult.items.at(-1)),
      });
    } catch (error_) {
      if (
        !this.isCurrent(context) ||
        this.activeSeek !== operation ||
        operation.abortController.signal.aborted
      ) return;
      this.emitPartial({
        error: safeErrorFromUnknown(error_, { fallback: 'Conversation latest jump failed' }),
      });
    } finally {
      this.finishSeekOperation(operation);
    }
  }

  /** Fetch one bounded turn-detail page for the active conversation. */
  async getTurnDetail(
    request: Omit<AgentConversationTurnDetailRequest, 'conversationId'>,
    callOptions: AgentManagementCallOptions = {},
  ): Promise<AgentConversationTurnDetailResponse | undefined> {
    const context = this.activeGeneration;
    if (!context) return undefined;
    const linked = linkAbortSignals(context.abortController.signal, callOptions.signal);
    if (linked.signal.aborted) {
      linked.cleanup();
      return undefined;
    }
    const scopedRequest: AgentConversationTurnDetailRequest = {
      ...request,
      conversationId: context.conversationId,
      limit: this.residentMessageLimit(
        request.limit ?? AGENT_SESSION_CONTRACT_LIMITS.turnDetailPage,
      ),
      maxBytes: this.interactiveRequestByteBudget(request.maxBytes),
    };
    try {
      const raw = await this.options.conversationClient.getTurnDetail(scopedRequest, {
        signal: linked.signal,
      });
      if (linked.signal.aborted || !this.isCurrent(context)) return undefined;
      return parseAgentConversationTurnDetailResponse(scopedRequest, raw);
    } catch (error_) {
      if (linked.signal.aborted || !this.isCurrent(context)) return undefined;
      this.emitPartial({
        error: safeErrorFromUnknown(error_, { fallback: 'Conversation turn detail failed' }),
      });
      return undefined;
    } finally {
      linked.cleanup();
    }
  }

  /** Atomically replace the resident window around an exact durable message identity. */
  async seekToMessage(
    messageId: string,
    turnId: string,
    cursor: string | undefined,
    callOptions: AgentSessionSeekCallOptions,
  ): Promise<AgentSessionSeekResult | undefined> {
    return this.seekToFocus({
      kind: 'message',
      messageId,
      turnId,
      ...(cursor === undefined ? {} : { cursor }),
    }, callOptions);
  }

  /** Atomically replace the resident window nearest a real timeline entry. */
  async seekToTimelineEntry(
    entryId: string,
    cursor: string,
    callOptions: AgentSessionSeekCallOptions,
  ): Promise<AgentSessionSeekResult | undefined> {
    return this.seekToFocus({ kind: 'timeline-entry', entryId, cursor }, callOptions);
  }

  private async seekToFocus(
    focus: AgentConversationMessageWindowFocus,
    callOptions: AgentSessionSeekCallOptions,
  ): Promise<AgentSessionSeekResult | undefined> {
    const context = this.activeGeneration;
    if (!context) return undefined;
    if (
      !callOptions ||
      typeof callOptions.expectedRevision !== 'string' ||
      callOptions.expectedRevision.length === 0
    ) throw new Error('invalid_agent_session_seek_revision');
    const operation = this.beginSeekOperation(context, callOptions.signal);
    const request = {
      conversationId: context.conversationId,
      focus,
      expectedRevision: callOptions.expectedRevision,
      maxMessages: Math.min(
        this.options.maxResidentMessages,
        INITIAL_MESSAGE_PAGE_SIZE,
      ),
      maxBytes: this.projectionPageByteBudget(),
    };
    try {
      const raw = await this.options.conversationClient.getMessageWindowAround(request, {
        signal: operation.abortController.signal,
      });
      if (
        !this.isCurrent(context) ||
        this.activeSeek !== operation ||
        operation.abortController.signal.aborted ||
        operation.windowGeneration !== this.windowGeneration
      ) return undefined;
      const result = this.normalizeMessageWindowResult(
        raw,
        request,
      );
      if (result.reset) {
        // A stale explicit focus is a typed reset for the timeline controller
        // to retry. Preserve the current resident window; only jumpToLatest()
        // is allowed to replace it with the tail.
        return cloneImmutableSnapshotValue(result);
      }
      const page = this.normalizeMessagePage(
        {
          reset: false,
          conversationId: result.conversationId,
          revision: result.revision,
          items: result.items,
          hasMoreBefore: result.hasMoreBefore,
          hasMoreAfter: result.hasMoreAfter,
          ...(result.previousCursor === undefined
            ? {}
            : { previousCursor: result.previousCursor }),
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        },
        context.conversationId,
        request.maxMessages,
      );
      this.emitPartial({
        error: null,
        messages: page.items,
        orderedMessageIds: page.items.map(message => message.messageId),
        streamingMessageIds: new Set(),
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: page.hasMoreAfter,
        startCursor: page.items[0] ? messageCursor(page.items[0]) : undefined,
        endCursor: page.items.at(-1) ? messageCursor(page.items.at(-1)!) : undefined,
        previousCursor: result.previousCursor,
        nextCursor: result.nextCursor,
        revision: result.revision,
        pendingNewMessageCount: 0,
        ...this.resolvedFocusAnchorFields(page.items, result.focus),
      });
      return cloneImmutableSnapshotValue({
        reset: false as const,
        revision: result.revision,
        focus: result.focus,
      });
    } catch (error_) {
      if (
        !this.isCurrent(context) ||
        this.activeSeek !== operation ||
        operation.abortController.signal.aborted
      ) return undefined;
      this.emitPartial({
        error: safeErrorFromUnknown(error_, { fallback: 'Conversation seek failed' }),
      });
      return undefined;
    } finally {
      this.finishSeekOperation(operation);
    }
  }

  /** Stop the session and clean up subscriptions. */
  stop(): void {
    this.generation += 1;
    this.activeGeneration?.abortController.abort();
    this.cancelActiveSeek();
    this.activeGeneration = null;
    this.pageLoadToken = null;
    this.cleanupSources();
    this.emitPartial({
      loading: false,
      loadingMoreBefore: false,
      loadingMoreAfter: false,
      streamingMessageIds: new Set(),
    });
  }

  // ── Actions ───────────────────────────────────────────────────

  /** Send a user message. */
  async sendMessage(
    content: string,
    attachment?: AgentAttachmentInput,
    wikiTiddlers?: WikiTiddlerAttachment[],
  ): Promise<void> {
    const context = this.requireActiveMutationContext();
    this.emitPartial({ error: null });
    try {
      if (attachment) assertAgentAttachmentInput(attachment);
      await this.options.conversationClient.sendMessage(
        context.conversationId,
        content,
        attachment,
        wikiTiddlers,
        { signal: context.abortController.signal },
      );
      this.assertMutationGeneration(context);
    } catch (error_) {
      throw this.recordMutationFailure(error_, context);
    }
  }

  /** Cancel the current agent operation. */
  async cancel(): Promise<void> {
    const context = this.requireActiveMutationContext();
    try {
      await this.options.agentInstanceClient.cancelAgent(context.agentId, {
        signal: context.abortController.signal,
      });
      this.assertMutationGeneration(context);
    } catch (error_) {
      throw this.recordMutationFailure(error_, context);
    }
  }

  /** Append a tombstone for a turn in the active conversation. */
  async deleteTurn(
    request: Omit<AgentConversationDeleteTurnRequest, 'conversationId'>,
  ): Promise<AgentConversationDeleteTurnResponse> {
    const context = this.requireActiveMutationContext();
    const scopedRequest: AgentConversationDeleteTurnRequest = {
      ...request,
      conversationId: context.conversationId,
    };
    try {
      const raw = await this.options.conversationClient.deleteTurn(scopedRequest, {
        signal: context.abortController.signal,
      });
      this.assertMutationGeneration(context);
      return parseAgentConversationDeleteTurnResponse(scopedRequest, raw);
    } catch (error_) {
      throw this.recordMutationFailure(error_, context);
    }
  }

  /** Atomically tombstone and retry a turn in the active conversation. */
  async retryTurn(
    request: Omit<AgentConversationRetryTurnRequest, 'conversationId'>,
  ): Promise<AgentConversationRetryTurnResponse> {
    const context = this.requireActiveMutationContext();
    const scopedRequest: AgentConversationRetryTurnRequest = {
      ...request,
      conversationId: context.conversationId,
    };
    try {
      const raw = await this.options.conversationClient.retryTurn(scopedRequest, {
        signal: context.abortController.signal,
      });
      this.assertMutationGeneration(context);
      return parseAgentConversationRetryTurnResponse(scopedRequest, raw);
    } catch (error_) {
      throw this.recordMutationFailure(error_, context);
    }
  }

  // ── Subscription ──────────────────────────────────────────────

  /** Subscribe to snapshot changes. Returns unsubscribe function. */
  subscribe(listener: AgentSessionListener): () => void {
    this.listeners.add(listener);
    this.safeNotify(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Get current snapshot without subscribing. */
  getSnapshot(): AgentSessionSnapshot {
    return this.snapshot;
  }

  // ── Private helpers ───────────────────────────────────────────

  private emitPartial(partial: Partial<AgentSessionSnapshot>): void {
    this.snapshot = createImmutableSessionSnapshot(this.snapshot, partial);
    for (const listener of [...this.listeners]) this.safeNotify(listener);
  }

  private safeNotify(listener: AgentSessionListener): void {
    try {
      listener(this.snapshot);
    } catch (error) {
      this.reportError(error, 'listener');
    }
  }

  private beginGeneration(target: AgentSessionTarget): SessionGeneration {
    this.generation += 1;
    this.activeGeneration?.abortController.abort();
    this.cancelActiveSeek();
    this.windowGeneration += 1;
    this.cleanupSources();
    this.pageLoadToken = null;
    const context: SessionGeneration = {
      generation: this.generation,
      agentId: target.agentId,
      conversationId: target.conversationId,
      abortController: new AbortController(),
      initialSnapshotPending: true,
      bufferedMessages: new Map(),
      bufferedStreamingMessageIds: new Set(),
      bufferedMessagesTrimmed: false,
      bufferedRevision: undefined,
      bufferedInvalidationRevision: undefined,
      refreshQueued: false,
      refreshRevision: undefined,
      refreshAnchorTurnId: undefined,
      refreshAnchorMessageId: undefined,
      refreshPendingNewMessageCount: 0,
      countedAppendRevisions: new Map(),
      seenInvalidationRevisions: new Set(),
      acceptedInvalidationRevision: undefined,
      refreshPromise: undefined,
    };
    this.activeGeneration = context;
    return context;
  }

  private isCurrent(context: SessionGeneration): boolean {
    return this.activeGeneration === context &&
      this.generation === context.generation &&
      !context.abortController.signal.aborted;
  }

  private cleanupSources(): void {
    const unsubscribeAgent = this.unsubAgentUpdates;
    const unsubscribeMessages = this.unsubMessages;
    this.unsubAgentUpdates = null;
    this.unsubMessages = null;
    this.safeUnsubscribe(unsubscribeAgent);
    this.safeUnsubscribe(unsubscribeMessages);
  }

  private beginSeekOperation(
    context: SessionGeneration,
    externalSignal: AbortSignal | undefined,
  ): SessionSeekOperation {
    this.cancelActiveSeek();
    this.windowGeneration += 1;
    const abortController = new AbortController();
    const signals = [context.abortController.signal, externalSignal]
      .filter((signal): signal is AbortSignal => signal !== undefined);
    const relayAbort = (signal: AbortSignal) => () => {
      if (!abortController.signal.aborted) abortController.abort(signal.reason);
    };
    const listeners = signals.map(signal => ({ signal, listener: relayAbort(signal) }));
    for (const { signal, listener } of listeners) {
      if (signal.aborted) listener();
      else signal.addEventListener('abort', listener, { once: true });
    }
    const operation: SessionSeekOperation = {
      abortController,
      windowGeneration: this.windowGeneration,
      cleanup: () => {
        for (const { signal, listener } of listeners) {
          signal.removeEventListener('abort', listener);
        }
      },
    };
    this.activeSeek = operation;
    return operation;
  }

  private finishSeekOperation(operation: SessionSeekOperation): void {
    operation.cleanup();
    if (this.activeSeek === operation) this.activeSeek = null;
  }

  private cancelActiveSeek(): void {
    const operation = this.activeSeek;
    this.activeSeek = null;
    if (!operation) return;
    operation.abortController.abort();
    operation.cleanup();
  }

  private safeUnsubscribe(unsubscribe: (() => void) | null): void {
    try {
      unsubscribe?.();
    } catch (error) {
      this.reportError(error, 'unsubscribe');
    }
  }

  private reportError(error: unknown, phase: 'listener' | 'unsubscribe'): void {
    try {
      this.options.onError?.(error, phase);
    } catch (diagnosticError) {
      void diagnosticError;
    }
  }

  private async replaceWithLatestPage(
    context: SessionGeneration,
    requestedWindowGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    const latestResult = this.normalizeMessagePageResult(
      await this.options.conversationClient.getMessagePage(context.conversationId, {
        limit: this.residentMessageLimit(INITIAL_MESSAGE_PAGE_SIZE),
        direction: 'backward',
        maxBytes: this.projectionPageByteBudget(),
      }, {
        signal,
      }),
      context.conversationId,
      this.residentMessageLimit(INITIAL_MESSAGE_PAGE_SIZE),
      undefined,
    );
    if (
      latestResult.reset ||
      signal.aborted ||
      !this.isCurrent(context) ||
      requestedWindowGeneration !== this.windowGeneration
    ) return;
    this.emitPartial({
      error: null,
      messages: latestResult.items,
      orderedMessageIds: latestResult.items.map(message => message.messageId),
      streamingMessageIds: new Set(),
      hasMoreBefore: latestResult.hasMoreBefore,
      hasMoreAfter: latestResult.hasMoreAfter,
      startCursor: latestResult.items[0]
        ? messageCursor(latestResult.items[0])
        : undefined,
      endCursor: latestResult.items.at(-1)
        ? messageCursor(latestResult.items.at(-1)!)
        : undefined,
      previousCursor: latestResult.previousCursor,
      nextCursor: latestResult.nextCursor,
      revision: latestResult.revision,
      pendingNewMessageCount: 0,
      ...this.messageAnchorFields(latestResult.items.at(-1)),
    });
  }

  private async replaceInvalidatedResidentWindow(
    context: SessionGeneration,
    requestedWindowGeneration: number,
    signal: AbortSignal,
    revision: string,
    anchorTurnId: string | undefined,
    anchorMessageId: string | undefined,
    pendingNewMessageCount: number,
  ): Promise<void> {
    if (anchorTurnId === undefined || anchorMessageId === undefined) {
      await this.replaceWithLatestPage(context, requestedWindowGeneration, signal);
      return;
    }
    const request = {
      conversationId: context.conversationId,
      focus: { kind: 'message' as const, messageId: anchorMessageId, turnId: anchorTurnId },
      expectedRevision: revision,
      maxMessages: this.residentMessageLimit(INITIAL_MESSAGE_PAGE_SIZE),
      maxBytes: this.projectionPageByteBudget(),
    };
    const raw = await this.options.conversationClient.getMessageWindowAround(request, { signal });
    if (
      signal.aborted ||
      !this.isCurrent(context) ||
      requestedWindowGeneration !== this.windowGeneration
    ) return;
    const result = this.normalizeMessageWindowResult(raw, request);
    if (result.reset) {
      // A stale historical re-seek must never eject the user to the tail. The
      // reset itself carries the next atomic revision, which is re-queued with
      // the same durable anchor even if its invalidation notification arrives
      // later (or is coalesced away).
      context.refreshQueued = true;
      context.refreshRevision = result.revision;
      context.refreshAnchorTurnId = anchorTurnId;
      context.refreshAnchorMessageId = anchorMessageId;
      context.refreshPendingNewMessageCount = pendingNewMessageCount;
      this.acceptInvalidationRevision(context, result.revision);
      return;
    }
    const page = this.normalizeMessagePage(
      {
        reset: false,
        conversationId: result.conversationId,
        revision: result.revision,
        items: result.items,
        hasMoreBefore: result.hasMoreBefore,
        hasMoreAfter: result.hasMoreAfter,
        ...(result.previousCursor === undefined ? {} : { previousCursor: result.previousCursor }),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      },
      context.conversationId,
      request.maxMessages,
    );
    const retainedAnchor = page.items.find(message => message.messageId === anchorMessageId);
    this.acceptInvalidationRevision(context, result.revision);
    this.emitPartial({
      error: null,
      messages: page.items,
      orderedMessageIds: page.items.map(message => message.messageId),
      streamingMessageIds: new Set(),
      hasMoreBefore: page.hasMoreBefore,
      hasMoreAfter: page.hasMoreAfter,
      startCursor: page.items[0] ? messageCursor(page.items[0]) : undefined,
      endCursor: page.items.at(-1) ? messageCursor(page.items.at(-1)!) : undefined,
      previousCursor: result.previousCursor,
      nextCursor: result.nextCursor,
      revision: result.revision,
      pendingNewMessageCount: page.hasMoreAfter ? pendingNewMessageCount : 0,
      ...(retainedAnchor
        ? this.messageAnchorFields(retainedAnchor)
        : this.resolvedFocusAnchorFields(page.items, result.focus)),
    });
  }

  private normalizeMessagePage(
    page: AgentConversationMessagePageSuccess,
    conversationId: string,
    limit: number,
  ): AgentConversationMessagePageSuccess {
    // Validate the complete descriptor graph before reading any untrusted field.
    // canonicalJsonBytes rejects accessors without invoking them.
    const pageBytes = this.projectionJsonByteLength(page, 'page');
    if (
      !page ||
      page.reset ||
      page.conversationId !== conversationId ||
      !this.isOpaqueCursor(page.revision) ||
      !Array.isArray(page.items) ||
      page.items.length > limit ||
      typeof page.hasMoreBefore !== 'boolean' ||
      typeof page.hasMoreAfter !== 'boolean'
    ) {
      throw new Error('invalid_conversation_message_page');
    }
    if (pageBytes > this.projectionPageByteBudget()) {
      throw new Error('conversation_message_page_exceeds_byte_budget');
    }
    const items = [...page.items];
    const ids = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const message = items[index];
      this.assertBoundedMessageProjection(message);
      if (message.conversationId !== conversationId || ids.has(message.messageId)) {
        throw new Error('invalid_conversation_message_page_scope');
      }
      ids.add(message.messageId);
      if (
        index > 0 &&
        compareMessageCursor(messageCursor(items[index - 1]), messageCursor(message)) >= 0
      ) {
        throw new Error('invalid_conversation_message_page_order');
      }
    }
    if (
      (page.hasMoreBefore && !this.isOpaqueCursor(page.previousCursor)) ||
      (page.hasMoreAfter && !this.isOpaqueCursor(page.nextCursor)) ||
      (page.previousCursor !== undefined && !this.isOpaqueCursor(page.previousCursor)) ||
      (page.nextCursor !== undefined && !this.isOpaqueCursor(page.nextCursor)) ||
      (items.length === 0 && (page.hasMoreBefore || page.hasMoreAfter))
    ) {
      throw new Error('invalid_conversation_message_page_cursor');
    }
    return {
      reset: false,
      conversationId,
      revision: page.revision,
      items,
      hasMoreBefore: page.hasMoreBefore,
      hasMoreAfter: page.hasMoreAfter,
      ...(page.previousCursor === undefined ? {} : { previousCursor: page.previousCursor }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  private normalizeMessagePageResult(
    value: AgentConversationMessagePage,
    conversationId: string,
    limit: number,
    expectedRevision: string | undefined,
  ): AgentConversationMessagePage {
    this.projectionJsonByteLength(value, 'page');
    if (!value || value.conversationId !== conversationId) {
      throw new Error('invalid_conversation_message_page_scope');
    }
    if (value.reset) {
      this.assertExactProjectionKeys(value, ['reset', 'conversationId', 'revision']);
      if (
        expectedRevision === undefined ||
        !this.isOpaqueCursor(value.revision)
      ) throw new Error('invalid_conversation_message_page_reset');
      return value;
    }
    this.assertExactProjectionKeys(value, [
      'reset',
      'conversationId',
      'revision',
      'items',
      'hasMoreBefore',
      'hasMoreAfter',
      'previousCursor',
      'nextCursor',
    ]);
    if (expectedRevision !== undefined && value.revision !== expectedRevision) {
      throw new Error('invalid_conversation_message_page_revision');
    }
    return this.normalizeMessagePage(value, conversationId, limit);
  }

  private normalizeMessageWindowResult(
    value: AgentConversationMessageWindowResult,
    request: {
      conversationId: string;
      focus: AgentConversationMessageWindowFocus;
      expectedRevision: string;
      maxMessages: number;
      maxBytes: number;
    },
  ): AgentConversationMessageWindowResult {
    this.projectionJsonByteLength(value, 'page');
    if (!value || value.conversationId !== request.conversationId) {
      throw new Error('invalid_conversation_message_window_scope');
    }
    if (value.reset) {
      this.assertExactProjectionKeys(value, ['reset', 'conversationId', 'revision']);
      if (
        !this.isOpaqueCursor(value.revision)
      ) throw new Error('invalid_conversation_message_window_reset');
      return value;
    }
    this.assertExactProjectionKeys(value, [
      'reset',
      'conversationId',
      'revision',
      'focus',
      'recenterAnchor',
      'items',
      'hasMoreBefore',
      'hasMoreAfter',
      'previousCursor',
      'nextCursor',
    ]);
    if (
      value.reset ||
      value.revision !== request.expectedRevision ||
      !Array.isArray(value.items) ||
      value.items.length > request.maxMessages ||
      typeof value.hasMoreBefore !== 'boolean' ||
      typeof value.hasMoreAfter !== 'boolean' ||
      (value.hasMoreBefore && !this.isOpaqueCursor(value.previousCursor)) ||
      (value.hasMoreAfter && !this.isOpaqueCursor(value.nextCursor)) ||
      (value.previousCursor !== undefined && !this.isOpaqueCursor(value.previousCursor)) ||
      (value.nextCursor !== undefined && !this.isOpaqueCursor(value.nextCursor)) ||
      (value.items.length === 0 && (value.hasMoreBefore || value.hasMoreAfter))
    ) throw new Error('invalid_conversation_message_window');
    this.assertResolvedMessageWindowFocus(value, request.focus);
    return value;
  }

  private assertResolvedMessageWindowFocus(
    result: Extract<AgentConversationMessageWindowResult, { reset: false }>,
    requested: AgentConversationMessageWindowFocus,
  ): void {
    const focus = result.focus;
    if (focus.kind === 'message') {
      this.assertExactProjectionKeys(focus, ['kind', 'messageId', 'turnId', 'entryId', 'cursor']);
      if (
        !this.isOpaqueCursor(focus.messageId) ||
        !this.isOpaqueCursor(focus.turnId) ||
        !result.items.some(message => message.messageId === focus.messageId && message.turnId === focus.turnId) ||
        result.recenterAnchor?.messageId !== focus.messageId ||
        result.recenterAnchor.turnId !== focus.turnId ||
        (requested.kind === 'message' && (
          focus.messageId !== requested.messageId ||
          focus.turnId !== requested.turnId ||
          focus.entryId !== undefined ||
          focus.cursor !== requested.cursor
        )) ||
        (requested.kind === 'timeline-entry' && (
          focus.entryId !== requested.entryId || focus.cursor !== requested.cursor
        ))
      ) throw new Error('invalid_conversation_message_window_focus');
      return;
    }
    this.assertExactProjectionKeys(focus, ['kind', 'entry', 'nearestPosition', 'nearestMessageId', 'nearestTurnId']);
    assertConversationTimelineCompactionEntry(focus.entry, {
      conversationId: result.conversationId,
    });
    if (
      requested.kind !== 'timeline-entry' ||
      focus.kind !== 'compaction' ||
      focus.entry.kind !== 'compaction' ||
      focus.entry.entryId !== requested.entryId ||
      focus.entry.cursor !== requested.cursor ||
      focus.entry.conversationId !== result.conversationId ||
      'turnId' in focus.entry ||
      'messageId' in focus.entry
    ) throw new Error('invalid_conversation_message_window_compaction');
    if (focus.nearestPosition === 'none') {
      if (focus.nearestMessageId !== undefined || focus.nearestTurnId !== undefined || result.recenterAnchor !== undefined || result.items.length !== 0) {
        throw new Error('invalid_conversation_message_window_compaction');
      }
      return;
    }
    if (
      (focus.nearestPosition !== 'before' && focus.nearestPosition !== 'after') ||
      typeof focus.nearestMessageId !== 'string' ||
      typeof focus.nearestTurnId !== 'string' ||
      !result.items.some(message => message.messageId === focus.nearestMessageId && message.turnId === focus.nearestTurnId) ||
      result.recenterAnchor?.messageId !== focus.nearestMessageId ||
      result.recenterAnchor.turnId !== focus.nearestTurnId
    ) throw new Error('invalid_conversation_message_window_compaction');
  }

  private assertExactProjectionKeys(value: object, allowed: readonly string[]): void {
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) {
      throw new Error('invalid_conversation_message_window');
    }
  }

  private isOpaqueCursor(value: unknown): value is string {
    return typeof value === 'string' &&
      value.length > 0 &&
      value.length <= AGENT_SESSION_CONTRACT_LIMITS.cursorCharacters &&
      value === value.trim() &&
      !this.hasControlCharacters(value) &&
      new TextEncoder().encode(value).byteLength <= AGENT_SESSION_CONTRACT_LIMITS.cursorCharacters * 4;
  }

  private assertOpaqueToken(value: unknown, field: string): asserts value is string {
    if (!this.isOpaqueCursor(value)) throw new Error(`invalid_${field.replaceAll('.', '_')}`);
  }

  private mergeResidentMessages<T extends AgentConversationMessageProjection>(
    first: readonly T[],
    second: readonly T[],
    retain: 'before' | 'after',
  ): { messages: T[]; trimmed: boolean } {
    const byId = new Map<string, T>();
    for (const message of [...first, ...second]) byId.set(message.messageId, message);
    const merged = [...byId.values()]
      .sort((left, right) => compareMessageCursor(messageCursor(left), messageCursor(right)));
    const selected: T[] = [];
    let bytes = 2;
    const candidates = retain === 'before' ? merged : [...merged].reverse();
    for (const message of candidates) {
      const messageBytes = this.projectionJsonByteLength(message, 'message');
      if (selected.length >= this.options.maxResidentMessages) break;
      if (messageBytes + 1 > this.options.maxResidentBytes) continue;
      if (bytes + messageBytes + (selected.length > 0 ? 1 : 0) > this.options.maxResidentBytes) break;
      selected.push(message);
      bytes += messageBytes + (selected.length > 1 ? 1 : 0);
    }
    if (retain === 'after') selected.reverse();
    const trimmed = selected.length !== merged.length;
    return {
      messages: selected,
      trimmed,
    };
  }

  private assertBoundedMessageProjection(message: AgentConversationMessageProjection): void {
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(message);
    } catch {
      throw new Error('invalid_conversation_message_projection_json');
    }
    for (const field of ['parts', 'toolCalls', 'attachments', 'reasoning_content']) {
      const descriptor = descriptors[field];
      if (!descriptor) continue;
      if ('get' in descriptor || 'set' in descriptor) {
        throw new Error('invalid_conversation_message_projection_json');
      }
      if (descriptor.value !== undefined) {
        throw new Error('unbounded_conversation_message_projection');
      }
    }
    assertConversationMessageProjection(message);
    const messageBytes = this.projectionJsonByteLength(message, 'message');
    if (
      messageBytes > this.options.maxResidentBytes ||
      messageBytes > AGENT_SESSION_CONTRACT_LIMITS.messageProjectionBytes
    ) {
      throw new Error('conversation_message_projection_exceeds_resident_budget');
    }
  }

  private projectionJsonByteLength(
    value: unknown,
    scope: 'message' | 'page' | 'update',
  ): number {
    const maxBytes = scope === 'page' || scope === 'update'
      ? this.projectionPageByteBudget()
      : Math.min(
        this.options.maxResidentBytes,
        AGENT_SESSION_CONTRACT_LIMITS.messageProjectionBytes,
      );
    try {
      return canonicalJsonBytes(value, {
        maxDepth: MESSAGE_PROJECTION_MAX_DEPTH,
        maxNodes: MESSAGE_PROJECTION_MAX_NODES,
        maxStringCodeUnits: maxBytes,
        maxStringBytes: maxBytes,
        maxBytes,
      }).byteLength;
    } catch (error_) {
      if (
        error_ instanceof CanonicalJsonError &&
        (error_.code === 'max_bytes' ||
          error_.code === 'max_string_bytes' ||
          error_.code === 'max_string_code_units')
      ) {
        throw new Error(
          scope === 'page'
            ? 'conversation_message_page_exceeds_byte_budget'
            : 'conversation_message_projection_exceeds_resident_budget',
        );
      }
      throw new Error('invalid_conversation_message_projection_json');
    }
  }

  private assertSessionTarget(target: AgentSessionTarget): void {
    if (
      target === null ||
      typeof target !== 'object' ||
      typeof target.agentId !== 'string' ||
      target.agentId.length === 0 ||
      typeof target.conversationId !== 'string' ||
      target.conversationId.length === 0
    ) throw new Error('invalid_agent_session_target');
  }

  private requireActiveMutationContext(): SessionGeneration {
    const context = this.activeGeneration;
    if (context && this.isCurrent(context)) return context;
    const failure = new AgentRunFailure(createAgentRunError({
      code: 'INVALID_REQUEST',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.INVALID_REQUEST,
      retryable: false,
      settingTarget: { kind: 'runtime', section: 'agent' },
    }));
    this.emitPartial({ error: failure });
    throw failure;
  }

  private assertMutationGeneration(context: SessionGeneration): void {
    if (this.isCurrent(context)) return;
    throw new AgentRunFailure(createAgentRunError({
      code: 'INTERRUPTED',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.INTERRUPTED,
      retryable: true,
      settingTarget: { kind: 'runtime', section: 'agent' },
    }));
  }

  private recordMutationFailure(error_: unknown, context: SessionGeneration): AgentRunFailure {
    const failure = error_ instanceof AgentRunFailure
      ? error_
      : new AgentRunFailure(agentRunErrorFromUnknown(error_));
    if (this.isCurrent(context)) this.emitPartial({ error: failure });
    return failure;
  }

  private messageAnchorFields(
    message: Readonly<AgentConversationMessageProjection> | undefined,
  ): Pick<AgentSessionSnapshot, 'windowAnchorTurnId' | 'windowAnchorMessageId'> {
    return message === undefined
      ? { windowAnchorTurnId: undefined, windowAnchorMessageId: undefined }
      : {
        windowAnchorTurnId: message.turnId,
        windowAnchorMessageId: message.messageId,
      };
  }

  private pageBoundaryAnchorFields(
    resident: readonly Readonly<AgentConversationMessageProjection>[],
    pageItems: readonly Readonly<AgentConversationMessageProjection>[],
    direction: 'before' | 'after',
  ): Pick<AgentSessionSnapshot, 'windowAnchorTurnId' | 'windowAnchorMessageId'> {
    const residentIds = new Set(resident.map(message => message.messageId));
    const candidates = direction === 'before' ? [...pageItems].reverse() : pageItems;
    const boundary = candidates.find(message => residentIds.has(message.messageId));
    if (boundary) return this.messageAnchorFields(boundary);
    const retainedAnchor = resident.find(
      message => message.messageId === this.snapshot.windowAnchorMessageId,
    );
    return this.messageAnchorFields(
      retainedAnchor ?? (direction === 'before' ? resident.at(-1) : resident[0]),
    );
  }

  private resolvedFocusAnchorFields(
    resident: readonly Readonly<AgentConversationMessageProjection>[],
    focus: Extract<AgentConversationMessageWindowResult, { reset: false }>['focus'],
  ): Pick<AgentSessionSnapshot, 'windowAnchorTurnId' | 'windowAnchorMessageId'> {
    const messageId = focus.kind === 'message'
      ? focus.messageId
      : focus.nearestPosition === 'none'
      ? undefined
      : focus.nearestMessageId;
    const turnId = focus.kind === 'message'
      ? focus.turnId
      : focus.nearestPosition === 'none'
      ? undefined
      : focus.nearestTurnId;
    if (turnId === undefined) return this.messageAnchorFields(undefined);
    return this.messageAnchorFields(resident.find(message => message.messageId === messageId && message.turnId === turnId));
  }

  private liveUpdateAnchorFields(
    resident: readonly Readonly<AgentConversationMessageProjection>[],
  ): Pick<AgentSessionSnapshot, 'windowAnchorTurnId' | 'windowAnchorMessageId'> {
    const retainedAnchor = resident.find(
      message => message.messageId === this.snapshot.windowAnchorMessageId,
    );
    return this.messageAnchorFields(retainedAnchor ?? resident.at(-1));
  }

  private projectionPageByteBudget(): number {
    return Math.max(
      AGENT_SESSION_CONTRACT_LIMITS.projectionPageMinBytes,
      Math.min(
        this.options.maxResidentBytes,
        AGENT_SESSION_CONTRACT_LIMITS.projectionPageDefaultBytes,
      ),
    );
  }

  private residentMessageLimit(requested: number): number {
    return Math.min(
      normalizeMessagePageLimit(requested),
      this.options.maxResidentMessages,
      MAX_INTERACTIVE_SESSION_MESSAGES,
    );
  }

  private interactiveRequestByteBudget(requested: number | undefined): number {
    if (requested === undefined) return this.projectionPageByteBudget();
    if (
      !Number.isSafeInteger(requested) ||
      requested < AGENT_SESSION_CONTRACT_LIMITS.projectionPageMinBytes
    ) throw new Error('invalid_agent_session_page_byte_budget');
    return Math.min(requested, this.projectionPageByteBudget(), MAX_INTERACTIVE_SESSION_BYTES);
  }

  private hasControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 31 || code === 127) return true;
    }
    return false;
  }

  private handleAgentUpdate(context: SessionGeneration, update: Partial<AgentRuntimeView>): void {
    if (!this.isCurrent(context)) return;
    if (this.snapshot.agent) {
      this.emitPartial({ agent: { ...this.snapshot.agent, ...update } });
    }
  }

  private handleConversationUpdate(
    context: SessionGeneration,
    update: AgentConversationUpdate,
  ): void {
    if (!this.isCurrent(context)) return;
    try {
      this.projectionJsonByteLength(update, 'update');
      if (!update || update.conversationId !== context.conversationId) {
        throw new Error('invalid_conversation_update_scope');
      }
      this.assertOpaqueToken(update.revision, 'update.revision');
      if (update.kind === 'invalidated') {
        this.assertExactProjectionKeys(update, [
          'kind',
          'conversationId',
          'previousRevision',
          'revision',
          'reason',
          ...(update.reason === 'append' ? ['appendedMessageCount'] : []),
        ]);
        if (
          update.conversationId !== context.conversationId ||
          update.previousRevision === update.revision ||
          update.reason !== 'append' &&
            update.reason !== 'reset' &&
            update.reason !== 'tombstone' &&
            update.reason !== 'compaction'
        ) throw new Error('invalid_conversation_update');
        if (
          update.reason === 'append' && (
            !Number.isSafeInteger(update.appendedMessageCount) ||
            update.appendedMessageCount <= 0 ||
            update.appendedMessageCount > MAX_AGENT_CONVERSATION_APPENDED_MESSAGE_COUNT
          )
        ) throw new Error('invalid_conversation_update_append_count');
        this.assertOpaqueToken(update.previousRevision, 'update.previousRevision');
        if (context.initialSnapshotPending) {
          context.bufferedInvalidationRevision = update.revision;
          return;
        }
        const knownRevision = context.acceptedInvalidationRevision ?? this.snapshot.revision;
        const duplicateAppendTarget = update.reason === 'append' &&
          context.countedAppendRevisions.has(update.revision);
        const duplicateTarget = update.revision === knownRevision || duplicateAppendTarget;
        if (!duplicateTarget && update.previousRevision !== knownRevision) {
          // A predecessor already observed in this generation identifies a
          // late overlapping edge (for example r2 after an r2->r3 edge arrived
          // first). Never roll the accepted revision backward. A genuinely
          // unseen gap adopts the advertised durable revision, but still does
          // not claim an untrustworthy append delta.
          const staleOverlap = context.seenInvalidationRevisions.has(update.previousRevision);
          const refreshRevision = staleOverlap && knownRevision !== undefined
            ? knownRevision
            : update.revision;
          if (!staleOverlap) this.acceptInvalidationRevision(context, update.revision);
          this.invalidateWindowOperations();
          void this.refreshInvalidatedResidentWindow(
            context,
            refreshRevision,
            'reset',
          );
          return;
        }
        if (!duplicateTarget) this.acceptInvalidationRevision(context, update.revision);
        const preservesHistoricalAnchor = this.snapshot.hasMoreAfter === true &&
          this.snapshot.windowAnchorTurnId !== undefined &&
          this.snapshot.windowAnchorMessageId !== undefined;
        // Tail windows fail closed while deletion/reset is being refreshed.
        // Historical windows remain intact until one atomic anchor re-seek
        // replaces them, avoiding an intermediate jump to the latest tail.
        if (update.reason !== 'append' && !preservesHistoricalAnchor) {
          this.emitPartial({
            error: null,
            messages: [],
            orderedMessageIds: [],
            streamingMessageIds: new Set(),
            hasMoreBefore: false,
            hasMoreAfter: false,
            startCursor: undefined,
            endCursor: undefined,
            previousCursor: undefined,
            nextCursor: undefined,
            revision: update.revision,
            windowAnchorTurnId: undefined,
            windowAnchorMessageId: undefined,
            pendingNewMessageCount: 0,
          });
        }
        this.invalidateWindowOperations();
        void this.refreshInvalidatedResidentWindow(
          context,
          update.revision,
          update.reason,
          update.reason === 'append' ? update.appendedMessageCount : 0,
          true,
        );
        return;
      }
      this.assertExactProjectionKeys(update, [
        'kind',
        'conversationId',
        'revision',
        'streaming',
        'message',
      ]);
      if (update.kind !== 'projection') throw new Error('invalid_conversation_update');
      if (
        update.conversationId !== context.conversationId ||
        typeof update.streaming !== 'boolean'
      ) throw new Error('invalid_conversation_update');
      this.assertBoundedMessageProjection(update.message);
    } catch (error_) {
      this.emitPartial({
        error: safeErrorFromUnknown(error_, { fallback: 'Conversation update failed' }),
      });
      return;
    }
    const { message } = update;
    if (message.conversationId !== context.conversationId) {
      this.emitPartial({ error: new Error('invalid_conversation_update_scope') });
      return;
    }
    if (context.initialSnapshotPending) {
      if (context.bufferedRevision !== undefined && context.bufferedRevision !== update.revision) {
        context.bufferedInvalidationRevision = update.revision;
      }
      context.bufferedRevision = update.revision;
      const { messages, trimmed } = this.mergeResidentMessages(
        [...context.bufferedMessages.values()],
        [message],
        'after',
      );
      context.bufferedMessages.clear();
      for (const buffered of messages) context.bufferedMessages.set(buffered.messageId, buffered);
      if (update.streaming) context.bufferedStreamingMessageIds.add(message.messageId);
      else context.bufferedStreamingMessageIds.delete(message.messageId);
      for (const messageId of context.bufferedStreamingMessageIds) {
        if (!context.bufferedMessages.has(messageId)) {
          context.bufferedStreamingMessageIds.delete(messageId);
        }
      }
      context.bufferedMessagesTrimmed ||= trimmed;
      return;
    }
    if (this.snapshot.revision !== update.revision) {
      this.acceptInvalidationRevision(context, update.revision);
      this.invalidateWindowOperations();
      void this.refreshInvalidatedResidentWindow(
        context,
        update.revision,
        'append',
        update.streaming ? 0 : 1,
        false,
      );
      return;
    }
    const existing = this.snapshot.messages.some(item => item.messageId === message.messageId);
    // A live tail message must not create a disjoint resident window while the
    // user is looking at an older page. It will arrive through loadMoreAfter.
    if (this.snapshot.hasMoreAfter && !existing) return;
    const { messages, trimmed } = this.mergeResidentMessages(
      this.snapshot.messages.filter(item => item.messageId !== message.messageId),
      [message],
      'after',
    );
    const streamingMessageIds = new Set(this.snapshot.streamingMessageIds);
    if (update.streaming) streamingMessageIds.add(message.messageId);
    else streamingMessageIds.delete(message.messageId);
    const residentIds = new Set(messages.map(item => item.messageId));
    for (const messageId of streamingMessageIds) {
      if (!residentIds.has(messageId)) streamingMessageIds.delete(messageId);
    }
    this.emitPartial({
      messages,
      orderedMessageIds: messages.map(item => item.messageId),
      streamingMessageIds,
      hasMoreBefore: this.snapshot.hasMoreBefore || trimmed,
      hasMoreAfter: this.snapshot.hasMoreAfter,
      startCursor: messages[0] ? messageCursor(messages[0]) : this.snapshot.startCursor,
      endCursor: this.snapshot.hasMoreAfter
        ? this.snapshot.endCursor
        : messages.at(-1)
        ? messageCursor(messages.at(-1)!)
        : this.snapshot.endCursor,
      revision: update.revision,
      pendingNewMessageCount: this.snapshot.hasMoreAfter
        ? this.snapshot.pendingNewMessageCount
        : 0,
      ...this.liveUpdateAnchorFields(messages),
    });
  }

  /**
   * A page reset first atomically re-seeks the captured durable anchor. This
   * helper then fulfils the caller's original direction exactly once using the
   * cursors from that replacement window. A second reset leaves the replacement
   * window resident and surfaces a typed protocol error instead of tail-falling.
   */
  private async retryDirectionalPageAfterReset(
    context: SessionGeneration,
    direction: 'before' | 'after',
    limit: number,
    requestedWindowGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      signal.aborted ||
      !this.isCurrent(context) ||
      requestedWindowGeneration !== this.windowGeneration
    ) return;
    const cursor = direction === 'before'
      ? this.snapshot.previousCursor
      : this.snapshot.nextCursor;
    const expectedRevision = this.snapshot.revision;
    if (cursor === undefined || expectedRevision === undefined) return;
    const pageResult = this.normalizeMessagePageResult(
      await this.options.conversationClient.getMessagePage(context.conversationId, {
        limit,
        cursor,
        expectedRevision,
        direction: direction === 'before' ? 'backward' : 'forward',
        maxBytes: this.projectionPageByteBudget(),
      }, { signal }),
      context.conversationId,
      limit,
      expectedRevision,
    );
    if (
      signal.aborted ||
      !this.isCurrent(context) ||
      requestedWindowGeneration !== this.windowGeneration
    ) return;
    if (pageResult.reset) {
      this.emitPartial({ error: new Error('conversation_paging_reset_exhausted') });
      return;
    }
    const page = pageResult;
    const merged = direction === 'before'
      ? this.mergeResidentMessages(page.items, this.snapshot.messages, 'before')
      : this.mergeResidentMessages(this.snapshot.messages, page.items, 'after');
    const messages = merged.messages;
    const streamingMessageIds = new Set(
      [...this.snapshot.streamingMessageIds].filter(messageId => messages.some(message => message.messageId === messageId)),
    );
    if (direction === 'before') {
      this.emitPartial({
        error: null,
        messages,
        orderedMessageIds: messages.map(message => message.messageId),
        streamingMessageIds,
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: this.snapshot.hasMoreAfter || merged.trimmed,
        startCursor: messages[0] ? messageCursor(messages[0]) : this.snapshot.startCursor,
        endCursor: messages.at(-1) ? messageCursor(messages.at(-1)!) : this.snapshot.endCursor,
        previousCursor: page.previousCursor,
        nextCursor: merged.trimmed ? page.nextCursor : this.snapshot.nextCursor,
        revision: page.revision,
        ...this.pageBoundaryAnchorFields(messages, page.items, 'before'),
      });
      return;
    }
    this.emitPartial({
      error: null,
      messages,
      orderedMessageIds: messages.map(message => message.messageId),
      streamingMessageIds,
      hasMoreBefore: this.snapshot.hasMoreBefore || merged.trimmed,
      hasMoreAfter: page.hasMoreAfter,
      startCursor: messages[0] ? messageCursor(messages[0]) : this.snapshot.startCursor,
      endCursor: messages.at(-1) ? messageCursor(messages.at(-1)!) : this.snapshot.endCursor,
      previousCursor: merged.trimmed ? page.previousCursor : this.snapshot.previousCursor,
      nextCursor: page.nextCursor,
      revision: page.revision,
      pendingNewMessageCount: page.hasMoreAfter ? this.snapshot.pendingNewMessageCount : 0,
      ...this.pageBoundaryAnchorFields(messages, page.items, 'after'),
    });
  }

  private acceptInvalidationRevision(context: SessionGeneration, revision: string): void {
    context.acceptedInvalidationRevision = revision;
    context.seenInvalidationRevisions.add(revision);
    if (context.seenInvalidationRevisions.size > 256) {
      context.seenInvalidationRevisions.delete(
        context.seenInvalidationRevisions.values().next().value!,
      );
    }
  }

  private invalidateWindowOperations(): void {
    this.cancelActiveSeek();
    this.pageLoadToken = null;
    this.windowGeneration += 1;
    if (this.snapshot.loadingMoreBefore || this.snapshot.loadingMoreAfter) {
      this.emitPartial({ loadingMoreBefore: false, loadingMoreAfter: false });
    }
  }

  private async refreshInvalidatedResidentWindow(
    context: SessionGeneration,
    revision: string,
    reason: 'append' | 'reset' | 'tombstone' | 'compaction' = 'reset',
    appendedMessageCount = 0,
    exactAppendCount = false,
    forcedAnchor?: {
      readonly turnId: string;
      readonly messageId: string;
      readonly pendingNewMessageCount: number;
    },
  ): Promise<void> {
    const preservesHistoricalAnchor = forcedAnchor !== undefined || (
      this.snapshot.hasMoreAfter === true &&
      this.snapshot.windowAnchorTurnId !== undefined &&
      this.snapshot.windowAnchorMessageId !== undefined
    );
    if (preservesHistoricalAnchor) {
      const alreadyTrackingAnchor = context.refreshAnchorTurnId !== undefined &&
        context.refreshAnchorMessageId !== undefined;
      if (forcedAnchor !== undefined) {
        context.refreshAnchorTurnId = forcedAnchor.turnId;
        context.refreshAnchorMessageId = forcedAnchor.messageId;
      } else {
        context.refreshAnchorTurnId ??= this.snapshot.windowAnchorTurnId;
        context.refreshAnchorMessageId ??= this.snapshot.windowAnchorMessageId;
      }
      if (!alreadyTrackingAnchor) {
        context.refreshPendingNewMessageCount = forcedAnchor?.pendingNewMessageCount ??
          this.snapshot.pendingNewMessageCount;
      }
      if (reason === 'append') {
        const previouslyCounted = context.countedAppendRevisions.get(revision);
        const delta = exactAppendCount
          ? appendedMessageCount - (previouslyCounted?.count ?? 0)
          : previouslyCounted === undefined
          ? appendedMessageCount
          : 0;
        if (exactAppendCount || previouslyCounted === undefined) {
          context.countedAppendRevisions.set(revision, {
            count: appendedMessageCount,
            exact: exactAppendCount,
          });
          if (context.countedAppendRevisions.size > 256) {
            context.countedAppendRevisions.delete(context.countedAppendRevisions.keys().next().value!);
          }
        }
        context.refreshPendingNewMessageCount = Math.min(
          MAX_AGENT_SESSION_PENDING_NEW_MESSAGE_COUNT,
          Math.max(0, context.refreshPendingNewMessageCount + delta),
        );
      }
    } else {
      context.refreshAnchorTurnId = undefined;
      context.refreshAnchorMessageId = undefined;
      context.refreshPendingNewMessageCount = 0;
    }
    context.refreshQueued = true;
    context.refreshRevision = revision;
    if (context.refreshPromise) return context.refreshPromise;
    const refresh = (async () => {
      const maximumAttempts = 3;
      for (let attempt = 0; attempt < maximumAttempts && this.isCurrent(context); attempt += 1) {
        if (!context.refreshQueued) return;
        context.refreshQueued = false;
        const requestedRevision = context.refreshRevision ?? revision;
        const anchorTurnId = context.refreshAnchorTurnId;
        const anchorMessageId = context.refreshAnchorMessageId;
        const pendingNewMessageCount = context.refreshPendingNewMessageCount;
        const requestedWindowGeneration = this.windowGeneration;
        try {
          await this.replaceInvalidatedResidentWindow(
            context,
            requestedWindowGeneration,
            context.abortController.signal,
            requestedRevision,
            anchorTurnId,
            anchorMessageId,
            pendingNewMessageCount,
          );
        } catch (error_) {
          if (!this.isCurrent(context) || context.abortController.signal.aborted) return;
          this.emitPartial({
            error: safeErrorFromUnknown(error_, { fallback: 'Conversation refresh failed' }),
          });
        }
        if (!context.refreshQueued) return;
        await this.waitForInvalidationBackoff(10 * (2 ** attempt), context.abortController.signal);
      }
      if (this.isCurrent(context) && context.refreshQueued) {
        context.refreshQueued = false;
        context.refreshRevision = undefined;
        context.refreshAnchorTurnId = undefined;
        context.refreshAnchorMessageId = undefined;
        context.refreshPendingNewMessageCount = 0;
        this.emitPartial({ error: new Error('conversation_invalidation_refresh_exhausted') });
      }
    })();
    context.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (context.refreshPromise === refresh) context.refreshPromise = undefined;
      if (this.isCurrent(context) && context.refreshQueued) {
        void this.refreshInvalidatedResidentWindow(
          context,
          context.refreshRevision ?? revision,
          reason,
        );
      } else if (this.isCurrent(context)) {
        context.refreshRevision = undefined;
        context.refreshAnchorTurnId = undefined;
        context.refreshAnchorMessageId = undefined;
        context.refreshPendingNewMessageCount = 0;
      }
    }
  }

  private async waitForInvalidationBackoff(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
