import type { AgentAttachmentInput } from 'memeloop';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { ConversationTimelineWindowController } from '../chat/ConversationTimelineWindowController.js';
import type { MemeLoopChatAdapter, MemeLoopSendMessageInput, MessageDetailLoader, WikiTiddlerAttachment } from '../chat/coreTypes.js';
import { MEMELOOP_INITIAL_MESSAGE_PAGE_LIMIT } from '../chat/residentWindow.js';
import { useAgentSession } from './useAgentSession.js';

export interface AgentSessionSendContext {
  conversationId: string;
  signal: AbortSignal;
}

export interface AgentSessionPreparedMessage {
  text: string;
  attachment?: AgentAttachmentInput;
  wikiTiddlers?: readonly WikiTiddlerAttachment[];
}

export type AgentSessionCoreChatAdapter<TInput extends MemeLoopSendMessageInput = MemeLoopSendMessageInput> = Omit<MemeLoopChatAdapter, 'sendMessage'> & {
  sendMessage: (input: TInput) => Promise<void>;
};

export interface AgentSessionCoreAdapterOptions<TInput extends MemeLoopSendMessageInput = MemeLoopSendMessageInput> {
  conversationId: string;
  timelineController?: ConversationTimelineWindowController;
  createId: () => string;
  /** Host-owned local/remote execution choices layered onto the shared session. */
  executionTargets?: MemeLoopChatAdapter['executionTargets'];
  activeExecutionTarget?: MemeLoopChatAdapter['activeExecutionTarget'];
  setExecutionTarget?: MemeLoopChatAdapter['setExecutionTarget'];
  /** Optional portable attachment/message transform. It must observe signal. */
  prepareSendMessage?: (
    input: TInput,
    context: AgentSessionSendContext,
  ) => Promise<AgentSessionPreparedMessage> | AgentSessionPreparedMessage;
  loadMessageDetail?: MessageDetailLoader;
  loadMessageReasoning?: MemeLoopChatAdapter['loadMessageReasoning'];
  exportConversation?: MemeLoopChatAdapter['exportConversation'];
  exportMessage?: MemeLoopChatAdapter['exportMessage'];
  onError?: MemeLoopChatAdapter['onError'];
}

interface ActiveSendOperation {
  controller: AbortController;
  generation: number;
  token: symbol;
}

interface TimelineRefreshAttempt {
  conversationId: string;
  controller: ConversationTimelineWindowController;
  revision: string;
}

/**
 * Platform-neutral AgentSessionController adapter shared by browser and native
 * hosts. It contains no DOM/File/MUI types; platform bindings only transform
 * their send input into a portable AgentAttachmentInput.
 */
export function useAgentSessionCoreAdapter<TInput extends MemeLoopSendMessageInput = MemeLoopSendMessageInput>(
  options: AgentSessionCoreAdapterOptions<TInput>,
): AgentSessionCoreChatAdapter<TInput> {
  const { controller, snapshot } = useAgentSession();
  const {
    conversationId,
    activeExecutionTarget,
    createId,
    executionTargets,
    exportConversation,
    exportMessage,
    loadMessageDetail,
    loadMessageReasoning,
    onError,
    prepareSendMessage,
    setExecutionTarget,
    timelineController,
  } = options;
  const sendGenerationReference = useRef(0);
  const conversationIdReference = useRef(conversationId);
  const activeSendReference = useRef<ActiveSendOperation | undefined>(undefined);
  const timelineRefreshAttemptReference = useRef<TimelineRefreshAttempt | undefined>(undefined);
  const subscribeTimeline = useCallback((listener: () => void) => timelineController?.subscribe(listener) ?? (() => {}), [timelineController]);
  const getTimelineSnapshot = useCallback(() => timelineController?.getSnapshot(), [timelineController]);
  const timelineSnapshot = useSyncExternalStore(subscribeTimeline, getTimelineSnapshot, getTimelineSnapshot);

  useEffect(() => {
    timelineController?.start(conversationId);
  }, [conversationId, timelineController]);

  useEffect(() => {
    if (conversationIdReference.current === conversationId) return;
    conversationIdReference.current = conversationId;
    sendGenerationReference.current += 1;
    activeSendReference.current?.controller.abort(new Error('agent session send generation changed'));
    activeSendReference.current = undefined;
  }, [conversationId]);

  useEffect(() => {
    return () => {
      sendGenerationReference.current += 1;
      activeSendReference.current?.controller.abort(new Error('agent session adapter disposed'));
      activeSendReference.current = undefined;
    };
  }, []);

  useEffect(() => {
    const page = timelineSnapshot?.page;
    if (!timelineController || !snapshot.revision || (timelineSnapshot?.loading && timelineSnapshot.page !== undefined)) return;
    const previousAttempt = timelineRefreshAttemptReference.current;
    const sameAttempt = previousAttempt?.controller === timelineController &&
      previousAttempt.conversationId === conversationId && previousAttempt.revision === snapshot.revision;
    if (page?.revision === snapshot.revision) {
      if (sameAttempt) timelineRefreshAttemptReference.current = undefined;
      return;
    }
    // A failed/aborted initial read has no page. Recover it once for the
    // current host revision, while preventing a persistent error snapshot
    // from causing a render/retry loop. Controller generations fence stale
    // results when the conversation changes.
    if (sameAttempt) return;
    timelineRefreshAttemptReference.current = {
      conversationId,
      controller: timelineController,
      revision: snapshot.revision,
    };
    const explicitAnchor = snapshot.windowAnchorMessageId
      ? page?.items.find(entry => entry.kind === 'message' && entry.messageId === snapshot.windowAnchorMessageId)
      : undefined;
    const historicalFallback = snapshot.hasMoreAfter && page ? page.items[Math.floor(page.items.length / 2)] : undefined;
    void timelineController.refreshForRevision(snapshot.revision, explicitAnchor?.entryIndex ?? historicalFallback?.entryIndex);
  }, [conversationId, snapshot.hasMoreAfter, snapshot.revision, snapshot.windowAnchorMessageId, timelineController, timelineSnapshot]);

  const sendMessage = useCallback(async (input: TInput): Promise<void> => {
    activeSendReference.current?.controller.abort(new Error('agent session send superseded'));
    const operation: ActiveSendOperation = {
      controller: new AbortController(),
      generation: sendGenerationReference.current,
      token: Symbol('send-message'),
    };
    activeSendReference.current = operation;
    try {
      const prepared = prepareSendMessage
        ? await prepareSendMessage(input, Object.freeze({ conversationId, signal: operation.controller.signal }))
        : { text: input.text, wikiTiddlers: input.wikiTiddlers };
      operation.controller.signal.throwIfAborted();
      if (operation.generation !== sendGenerationReference.current) return;
      await controller.sendMessage(
        prepared.text,
        prepared.attachment,
        prepared.wikiTiddlers ? [...prepared.wikiTiddlers] : undefined,
      );
      operation.controller.signal.throwIfAborted();
    } finally {
      if (activeSendReference.current?.token === operation.token) activeSendReference.current = undefined;
    }
  }, [controller, conversationId, prepareSendMessage]);

  const cancel = useCallback(async (): Promise<void> => {
    activeSendReference.current?.controller.abort(new Error('agent session send cancelled'));
    activeSendReference.current = undefined;
    await controller.cancel();
  }, [controller]);

  return useMemo((): AgentSessionCoreChatAdapter<TInput> => ({
    conversationId,
    messages: snapshot.messages,
    timeline: timelineSnapshot?.page,
    hasMoreBefore: snapshot.hasMoreBefore,
    hasMoreAfter: snapshot.hasMoreAfter,
    isLoadingMoreBefore: snapshot.loadingMoreBefore,
    isLoadingMoreAfter: snapshot.loadingMoreAfter,
    loadMoreBefore: async signal => {
      signal?.throwIfAborted();
      await controller.loadMoreBefore(MEMELOOP_INITIAL_MESSAGE_PAGE_LIMIT, { signal });
      signal?.throwIfAborted();
    },
    loadMoreAfter: async signal => {
      signal?.throwIfAborted();
      await controller.loadMoreAfter(MEMELOOP_INITIAL_MESSAGE_PAGE_LIMIT, { signal });
      signal?.throwIfAborted();
    },
    loadAround: (messageId, turnId, cursor, expectedRevision, signal) => controller.seekToMessage(messageId, turnId, cursor, { expectedRevision, signal }).then(() => undefined),
    loadTimelineBefore: timelineController
      ? async (cursor, revision, signal) => {
        signal?.throwIfAborted();
        await timelineController.loadBefore(cursor, revision, signal);
        signal?.throwIfAborted();
      }
      : undefined,
    loadTimelineAfter: timelineController
      ? async (cursor, revision, signal) => {
        signal?.throwIfAborted();
        await timelineController.loadAfter(cursor, revision, signal);
        signal?.throwIfAborted();
      }
      : undefined,
    loadTimelineAround: timelineController
      ? async (entryIndex, revision, signal) => {
        signal?.throwIfAborted();
        await timelineController.loadAround(entryIndex, revision, signal);
        signal?.throwIfAborted();
      }
      : undefined,
    loadAroundTimelineEntry: (entryId, cursor, expectedRevision, signal) => controller.seekToTimelineEntry(entryId, cursor, { expectedRevision, signal }).then(() => undefined),
    isLoadingTimelineBefore: timelineSnapshot?.loadingKind === 'before',
    isLoadingTimelineAfter: timelineSnapshot?.loadingKind === 'after',
    windowAnchorTurnId: snapshot.windowAnchorTurnId,
    windowAnchorMessageId: snapshot.windowAnchorMessageId,
    isRunning: snapshot.agent?.status.state === 'working',
    isLoading: snapshot.loading,
    isMessageStreaming: messageId => snapshot.streamingMessageIds.has(messageId),
    isAtLiveTail: !snapshot.hasMoreAfter,
    pendingNewMessageCount: snapshot.pendingNewMessageCount,
    executionTargets,
    activeExecutionTarget,
    setExecutionTarget,
    jumpToLatest: signal => controller.jumpToLatest({ signal }),
    error: snapshot.error ?? timelineSnapshot?.error ?? null,
    sendMessage,
    cancel,
    deleteTurn: async turnId => {
      await controller.deleteTurn({ turnId, requestId: createId() });
    },
    retryTurn: async turnId => {
      await controller.retryTurn({
        turnId,
        requestId: createId(),
        newTurnId: createId(),
        definitionId: snapshot.agent?.agentDefId,
      });
    },
    loadMessageDetail,
    loadMessageReasoning,
    exportConversation,
    exportMessage,
    onError,
  }), [
    cancel,
    controller,
    conversationId,
    activeExecutionTarget,
    createId,
    executionTargets,
    exportConversation,
    exportMessage,
    loadMessageDetail,
    loadMessageReasoning,
    onError,
    sendMessage,
    setExecutionTarget,
    snapshot,
    timelineController,
    timelineSnapshot,
  ]);
}
