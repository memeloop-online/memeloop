import { AuiIf, ThreadPrimitive, useAuiState } from '@assistant-ui/react';
import { Alert, Box, styled } from '@mui/material';
import type { ConversationMessageListProjection, ConversationTimelineEntry } from 'memeloop';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { MemeLoopComposer } from '../composer/MemeLoopComposer.js';
import { useMemeLoopChatContext } from '../runtime/MemeLoopChatContext.js';
import type { MemeLoopThreadProps } from '../types.js';
import { ConversationTimelineRail } from './ConversationTimelineRail.js';
import { MemeLoopMessage } from './MemeLoopMessage.js';

const Root = styled(Box)`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`;

const ViewportShell = styled(Box)`
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`;

const MessagesList = styled(Box)`
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  justify-content: flex-start;
  background-color: ${(props) => props.theme.palette.background.default};
  padding-inline-start: 44px;

  /* Keep short conversations bottom-aligned without making the beginning of
   * an overflowing conversation unreachable above scrollTop=0. */
  &::before {
    content: '';
    margin-block-start: auto;
  }

  @container memeloop-chat (max-width: 480px) {
    padding: 8px;
    padding-inline-start: 26px;
    gap: 6px;
  }

  @container memeloop-chat (max-width: 319px) {
    padding-inline-start: 8px;
  }
`;

const ViewportFooter = styled(ThreadPrimitive.ViewportFooter)`
  border-top: 1px solid ${(props) => props.theme.palette.divider};
  background-color: ${(props) => props.theme.palette.background.paper};
`;

/**
 * Internal component that reads the current ChatMessage from assistant-ui context
 * and delegates to MemeLoopMessage with all slots.
 */
function ThreadMessage({
  renderMessageContent,
  renderTurnActions,
  onWikiTiddlerClick,
  loadMessageDetail,
  loadMessageReasoning,
  loadVisibleAttachments,
  attachmentRevision,
  onAttachmentHydrationError,
  exportMessage,
  messageLabels,
  activeDetailMessageId,
  onActivateDetailMessage,
}: {
  renderMessageContent?: (message: ConversationMessageListProjection, isUser: boolean) => React.ReactNode;
  renderTurnActions?: (message: ConversationMessageListProjection) => React.ReactNode;
  onWikiTiddlerClick?: (tiddler: {
    workspaceId: string;
    workspaceName: string;
    tiddlerTitle: string;
    renderedContent?: string;
  }) => void;
  loadMessageDetail?: import('../types.js').MessageDetailLoader;
  loadMessageReasoning?: import('../messageReasoning.js').MemeLoopMessageReasoningLoader;
  loadVisibleAttachments?: import('../visibleAttachmentHydration.js').MemeLoopVisibleAttachmentLoader;
  attachmentRevision?: string;
  onAttachmentHydrationError: (error: Error) => void;
  exportMessage?: (messageId: string, options: { signal: AbortSignal }) => Promise<void>;
  messageLabels?: import('../types.js').MemeLoopThreadProps['messageLabels'];
  activeDetailMessageId?: string;
  onActivateDetailMessage: (messageId: string) => void;
}) {
  const message = useAuiState(
    (s) => s.message.metadata?.custom?.memeloop as ConversationMessageListProjection | undefined,
  );
  const isStreaming = useAuiState(
    (s) => s.message.status?.type === 'running',
  );
  if (!message) return null;
  return (
    <MemeLoopMessage
      message={message}
      isStreaming={isStreaming}
      renderContent={renderMessageContent}
      renderTurnActions={renderTurnActions}
      onWikiTiddlerClick={onWikiTiddlerClick}
      loadMessageDetail={loadMessageDetail}
      loadMessageReasoning={loadMessageReasoning}
      loadVisibleAttachments={loadVisibleAttachments}
      attachmentRevision={attachmentRevision}
      onAttachmentHydrationError={onAttachmentHydrationError}
      detailDisplayActive={activeDetailMessageId === message.messageId}
      onActivateDetailDisplay={onActivateDetailMessage}
      exportMessage={exportMessage}
      labels={messageLabels}
    />
  );
}

export const MemeLoopThread: React.FC<MemeLoopThreadProps> = ({
  header,
  footer,
  empty,
  composerComponent: ComposerComponent = MemeLoopComposer,
  renderMessageContent,
  renderTurnActions,
  onWikiTiddlerClick,
  loadMessageDetail,
  loadMessageReasoning,
  loadVisibleAttachments,
  attachmentRevision,
  showTimeline = true,
  timelineLabels,
  formatTimelineTimestamp,
  messageLabels,
  renderOperationError,
  operationErrorOverride,
  onClearOperationErrorOverride,
  operationErrorMessage = 'The operation could not be completed.',
}) => {
  const { adapter, clearOperationError, operationError, reportOperationError } = useMemeLoopChatContext();
  const displayedOperationError = operationErrorOverride ?? operationError;
  const viewportReference = useRef<HTMLDivElement>(null);
  const prependInFlight = useRef(false);
  const appendInFlight = useRef(false);
  const prependAbortControllerReference = useRef<AbortController | undefined>(undefined);
  const appendAbortControllerReference = useRef<AbortController | undefined>(undefined);
  const timelineBeforeInFlight = useRef(false);
  const timelineAfterInFlight = useRef(false);
  const timelineBeforeAbortControllerReference = useRef<AbortController | undefined>(undefined);
  const timelineAfterAbortControllerReference = useRef<AbortController | undefined>(undefined);
  const timelineAroundAbortControllerReference = useRef<AbortController | undefined>(undefined);
  const messageAroundAbortControllerReference = useRef<AbortController | undefined>(undefined);
  const scrollFrameReference = useRef<number | undefined>(undefined);
  const focusFrameReference = useRef<number | undefined>(undefined);
  const nestedFocusFrameReference = useRef<number | undefined>(undefined);
  const jumpGenerationReference = useRef(0);
  const pendingCompactionFocusReference = useRef(false);
  const anchorPositionsReference = useRef<readonly { messageId: string; entryIndex: number; offsetTop: number }[]>([]);
  const activeMessageIdReference = useRef<string | undefined>(undefined);
  const [activeTimelineMessageId, setActiveTimelineMessageId] = useState<string | undefined>(undefined);
  const [visibleTimelineEntryRange, setVisibleTimelineEntryRange] = useState<Readonly<{ start: number; end: number }> | undefined>(undefined);
  const [activeDetailMessageId, setActiveDetailMessageId] = useState<string | undefined>(undefined);
  const conversationId = adapter.conversationId;
  const reportAttachmentHydrationError = useCallback((error: Error) => {
    reportOperationError(error, 'load-visible-attachments');
  }, [reportOperationError]);

  const focusResidentMessage = useCallback((messageId: string, generation: number) => {
    if (focusFrameReference.current !== undefined) cancelAnimationFrame(focusFrameReference.current);
    if (nestedFocusFrameReference.current !== undefined) cancelAnimationFrame(nestedFocusFrameReference.current);
    focusFrameReference.current = requestAnimationFrame(() => {
      focusFrameReference.current = undefined;
      const attemptFocus = (attempt: number) => {
        nestedFocusFrameReference.current = requestAnimationFrame(() => {
          nestedFocusFrameReference.current = undefined;
          if (jumpGenerationReference.current !== generation) return;
          const viewport = viewportReference.current;
          const target = [...(viewport?.querySelectorAll<HTMLElement>('[data-memeloop-message-id]') ?? [])]
            .find(node => node.dataset.memeloopMessageId === messageId);
          if (!viewport || !target) {
            if (attempt < 7) attemptFocus(attempt + 1);
            return;
          }
          const viewportRectangle = viewport.getBoundingClientRect();
          const targetRectangle = target.getBoundingClientRect();
          const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          viewport.scrollTo({
            top: Math.max(0, viewport.scrollTop + targetRectangle.top - viewportRectangle.top - 8),
            behavior: reduceMotion ? 'auto' : 'smooth',
          });
          target.focus({ preventScroll: true });
        });
      };
      attemptFocus(0);
    });
  }, []);

  const rebuildAnchorPositionCache = useCallback(() => {
    const viewport = viewportReference.current;
    if (!viewport || !adapter.timeline?.items.length) {
      anchorPositionsReference.current = [];
      return;
    }
    const messageEntryIndexes = new Map(
      adapter.timeline.items
        .filter(entry => entry.kind === 'message')
        .map(entry => [entry.messageId, entry.entryIndex] as const),
    );
    anchorPositionsReference.current = [...viewport.querySelectorAll<HTMLElement>('[data-memeloop-message-id]')]
      .flatMap(node => {
        const messageId = node.dataset.memeloopMessageId;
        const entryIndex = messageId === undefined ? undefined : messageEntryIndexes.get(messageId);
        return messageId && entryIndex !== undefined
          ? [{ messageId, entryIndex, offsetTop: node.offsetTop }]
          : [];
      })
      .sort((left, right) => left.offsetTop - right.offsetTop);
  }, [adapter.timeline]);

  const updateActiveAnchor = useCallback(() => {
    const viewport = viewportReference.current;
    if (!viewport || !adapter.timeline?.items.length) return;
    const messageEntries = adapter.timeline.items.filter(entry => entry.kind === 'message');
    const messageIds = new Set(messageEntries.map(entry => entry.messageId));
    const positions = anchorPositionsReference.current;
    const targetOffset = viewport.scrollTop + 8;
    let activePositionIndex = -1;
    let low = 0;
    let high = positions.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = positions[middle];
      if (candidate.offsetTop <= targetOffset) {
        activePositionIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const active = positions[activePositionIndex]?.messageId;
    const windowAnchor = adapter.windowAnchorMessageId && messageIds.has(adapter.windowAnchorMessageId)
      ? adapter.windowAnchorMessageId
      : undefined;
    const resolvedMessageId = active ??
      windowAnchor ??
      (!adapter.hasMoreAfter ? messageEntries.at(-1)?.messageId : undefined) ??
      (!adapter.hasMoreBefore ? messageEntries[0]?.messageId : undefined) ??
      activeMessageIdReference.current ??
      messageEntries.at(-1)?.messageId;
    activeMessageIdReference.current = resolvedMessageId;
    const resolvedEntry = messageEntries.find(entry => entry.messageId === resolvedMessageId);
    if (resolvedEntry) setActiveTimelineMessageId(resolvedEntry.messageId);

    let lastVisiblePositionIndex = -1;
    low = 0;
    high = positions.length - 1;
    const viewportEnd = viewport.scrollTop + Math.max(1, viewport.clientHeight);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (positions[middle].offsetTop < viewportEnd) {
        lastVisiblePositionIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const firstVisiblePositionIndex = activePositionIndex >= 0
      ? activePositionIndex
      : lastVisiblePositionIndex >= 0
      ? 0
      : -1;
    const firstVisible = positions[firstVisiblePositionIndex];
    const lastVisible = positions[lastVisiblePositionIndex];
    const nextVisibleRange = firstVisible && lastVisible && lastVisiblePositionIndex >= firstVisiblePositionIndex
      ? {
        start: Math.min(firstVisible.entryIndex, lastVisible.entryIndex),
        end: Math.max(firstVisible.entryIndex, lastVisible.entryIndex),
      }
      : resolvedEntry
      ? { start: resolvedEntry.entryIndex, end: resolvedEntry.entryIndex }
      : undefined;
    setVisibleTimelineEntryRange(previous =>
      previous?.start === nextVisibleRange?.start && previous?.end === nextVisibleRange?.end
        ? previous
        : nextVisibleRange
    );
  }, [adapter.hasMoreAfter, adapter.hasMoreBefore, adapter.timeline, adapter.windowAnchorMessageId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      rebuildAnchorPositionCache();
      updateActiveAnchor();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [adapter.messages, rebuildAnchorPositionCache, updateActiveAnchor]);

  useEffect(() => {
    const viewport = viewportReference.current;
    if (!viewport || typeof ResizeObserver !== 'function') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        rebuildAnchorPositionCache();
        updateActiveAnchor();
      });
    });
    observer.observe(viewport);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [rebuildAnchorPositionCache, updateActiveAnchor]);

  useEffect(() => {
    if (!pendingCompactionFocusReference.current || !adapter.windowAnchorMessageId) return;
    pendingCompactionFocusReference.current = false;
    activeMessageIdReference.current = adapter.windowAnchorMessageId;
    setActiveTimelineMessageId(adapter.windowAnchorMessageId);
    focusResidentMessage(adapter.windowAnchorMessageId, jumpGenerationReference.current);
  }, [adapter.messages, adapter.windowAnchorMessageId, focusResidentMessage]);

  useEffect(() => {
    jumpGenerationReference.current += 1;
    if (focusFrameReference.current !== undefined) cancelAnimationFrame(focusFrameReference.current);
    if (nestedFocusFrameReference.current !== undefined) cancelAnimationFrame(nestedFocusFrameReference.current);
    timelineAroundAbortControllerReference.current?.abort();
    messageAroundAbortControllerReference.current?.abort();
    prependAbortControllerReference.current?.abort();
    appendAbortControllerReference.current?.abort();
    timelineBeforeAbortControllerReference.current?.abort();
    timelineAfterAbortControllerReference.current?.abort();
    prependInFlight.current = false;
    appendInFlight.current = false;
    timelineBeforeInFlight.current = false;
    timelineAfterInFlight.current = false;
    anchorPositionsReference.current = [];
    pendingCompactionFocusReference.current = false;
    activeMessageIdReference.current = undefined;
    setActiveTimelineMessageId(undefined);
    setVisibleTimelineEntryRange(undefined);
    setActiveDetailMessageId(undefined);
  }, [conversationId]);

  useEffect(() => () => {
    jumpGenerationReference.current += 1;
    if (scrollFrameReference.current !== undefined) cancelAnimationFrame(scrollFrameReference.current);
    if (focusFrameReference.current !== undefined) cancelAnimationFrame(focusFrameReference.current);
    if (nestedFocusFrameReference.current !== undefined) cancelAnimationFrame(nestedFocusFrameReference.current);
    timelineAroundAbortControllerReference.current?.abort();
    messageAroundAbortControllerReference.current?.abort();
    prependAbortControllerReference.current?.abort();
    appendAbortControllerReference.current?.abort();
    timelineBeforeAbortControllerReference.current?.abort();
    timelineAfterAbortControllerReference.current?.abort();
  }, []);

  const loadEarlier = useCallback(async () => {
    const viewport = viewportReference.current;
    if (!viewport || prependInFlight.current || !adapter.hasMoreBefore || !adapter.loadMoreBefore) return;
    prependInFlight.current = true;
    const controller = new AbortController();
    prependAbortControllerReference.current = controller;
    const previousHeight = viewport.scrollHeight;
    const previousTop = viewport.scrollTop;
    const firstVisible = [...viewport.querySelectorAll<HTMLElement>('[data-memeloop-message-id]')]
      .find(node => node.offsetTop + node.offsetHeight > previousTop);
    const preservedAnchor = firstVisible?.dataset.memeloopMessageId
      ? { messageId: firstVisible.dataset.memeloopMessageId, pixelOffset: firstVisible.offsetTop - previousTop }
      : undefined;
    try {
      clearOperationError();
      await adapter.loadMoreBefore(controller.signal);
      requestAnimationFrame(() => {
        const current = viewportReference.current;
        if (!current) return;
        const preservedNode = preservedAnchor
          ? [...current.querySelectorAll<HTMLElement>('[data-memeloop-message-id]')]
            .find(node => node.dataset.memeloopMessageId === preservedAnchor.messageId)
          : undefined;
        current.scrollTop = preservedNode && preservedAnchor
          ? preservedNode.offsetTop - preservedAnchor.pixelOffset
          : previousTop + current.scrollHeight - previousHeight;
        rebuildAnchorPositionCache();
        updateActiveAnchor();
      });
    } catch (error) {
      if (!controller.signal.aborted) reportOperationError(error, 'load-more-before');
    } finally {
      if (prependAbortControllerReference.current === controller) {
        prependAbortControllerReference.current = undefined;
        prependInFlight.current = false;
      }
    }
  }, [adapter, clearOperationError, rebuildAnchorPositionCache, reportOperationError, updateActiveAnchor]);

  const loadLater = useCallback(async () => {
    if (appendInFlight.current || !adapter.hasMoreAfter || !adapter.loadMoreAfter) return;
    appendInFlight.current = true;
    const controller = new AbortController();
    appendAbortControllerReference.current = controller;
    try {
      clearOperationError();
      await adapter.loadMoreAfter(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) reportOperationError(error, 'load-more-after');
    } finally {
      if (appendAbortControllerReference.current === controller) {
        appendAbortControllerReference.current = undefined;
        appendInFlight.current = false;
      }
    }
  }, [adapter, clearOperationError, reportOperationError]);

  const handleScroll = useCallback(() => {
    if (scrollFrameReference.current !== undefined) return;
    scrollFrameReference.current = requestAnimationFrame(() => {
      scrollFrameReference.current = undefined;
      const viewport = viewportReference.current;
      if (!viewport) return;
      updateActiveAnchor();
      if (viewport.scrollTop < 160) void loadEarlier();
      if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 160) void loadLater();
    });
  }, [loadEarlier, loadLater, updateActiveAnchor]);

  const jumpToAnchor = useCallback(async (entry: ConversationTimelineEntry) => {
    const generation = jumpGenerationReference.current + 1;
    jumpGenerationReference.current = generation;
    messageAroundAbortControllerReference.current?.abort();
    const controller = new AbortController();
    messageAroundAbortControllerReference.current = controller;
    if (entry.kind === 'message') setActiveTimelineMessageId(entry.messageId);
    if (entry.kind === 'compaction') {
      if (!adapter.loadAroundTimelineEntry) return;
      pendingCompactionFocusReference.current = true;
      messageAroundAbortControllerReference.current?.abort();
      const timelineController = new AbortController();
      messageAroundAbortControllerReference.current = timelineController;
      try {
        clearOperationError();
        await adapter.loadAroundTimelineEntry(entry.entryId, entry.cursor, adapter.timeline!.revision, timelineController.signal);
      } catch (error) {
        pendingCompactionFocusReference.current = false;
        if (!timelineController.signal.aborted) reportOperationError(error, 'load-around-timeline-entry');
      } finally {
        if (messageAroundAbortControllerReference.current === timelineController) messageAroundAbortControllerReference.current = undefined;
      }
      return;
    }
    activeMessageIdReference.current = entry.messageId;
    const resident = [...(viewportReference.current?.querySelectorAll<HTMLElement>('[data-memeloop-message-id]') ?? [])]
      .some(node => node.dataset.memeloopMessageId === entry.messageId);
    if (adapter.loadAround && !resident) {
      try {
        clearOperationError();
        await adapter.loadAround(entry.messageId, entry.turnId, entry.cursor, adapter.timeline!.revision, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) reportOperationError(error, 'load-around');
        return;
      } finally {
        if (messageAroundAbortControllerReference.current === controller) messageAroundAbortControllerReference.current = undefined;
      }
    }
    if (jumpGenerationReference.current !== generation) return;
    focusResidentMessage(entry.messageId, generation);
  }, [adapter, clearOperationError, focusResidentMessage, reportOperationError]);

  const jumpToLatest = useCallback(async () => {
    if (!adapter.jumpToLatest) return;
    try {
      clearOperationError();
      await adapter.jumpToLatest();
      requestAnimationFrame(() => {
        const viewport = viewportReference.current;
        if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' });
      });
    } catch (error) {
      reportOperationError(error, 'jump-to-latest');
    }
  }, [adapter, clearOperationError, reportOperationError]);

  const exportFullMessage = useCallback(async (messageId: string, options: { signal: AbortSignal }) => {
    if (!adapter.exportMessage) return;
    try {
      clearOperationError();
      await adapter.exportMessage(messageId, options);
    } catch (error) {
      if (!options.signal.aborted) reportOperationError(error, 'export-message');
    }
  }, [adapter, clearOperationError, reportOperationError]);

  const loadTimelineEarlier = useCallback(async (cursor: string, expectedRevision: string, externalSignal?: AbortSignal) => {
    if (timelineBeforeInFlight.current || !adapter.timeline?.hasMoreBefore || !adapter.loadTimelineBefore) return;
    timelineBeforeInFlight.current = true;
    const controller = new AbortController();
    const abortFromExternal = () => {
      controller.abort(externalSignal?.reason);
    };
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    if (externalSignal?.aborted) abortFromExternal();
    timelineBeforeAbortControllerReference.current = controller;
    try {
      clearOperationError();
      await adapter.loadTimelineBefore(cursor, expectedRevision, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) reportOperationError(error, 'load-timeline-before');
    } finally {
      if (timelineBeforeAbortControllerReference.current === controller) {
        timelineBeforeAbortControllerReference.current = undefined;
        timelineBeforeInFlight.current = false;
      }
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  }, [adapter, clearOperationError, reportOperationError]);

  const loadTimelineLater = useCallback(async (cursor: string, expectedRevision: string, externalSignal?: AbortSignal) => {
    if (timelineAfterInFlight.current || !adapter.timeline?.hasMoreAfter || !adapter.loadTimelineAfter) return;
    timelineAfterInFlight.current = true;
    const controller = new AbortController();
    const abortFromExternal = () => {
      controller.abort(externalSignal?.reason);
    };
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    if (externalSignal?.aborted) abortFromExternal();
    timelineAfterAbortControllerReference.current = controller;
    try {
      clearOperationError();
      await adapter.loadTimelineAfter(cursor, expectedRevision, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) reportOperationError(error, 'load-timeline-after');
    } finally {
      if (timelineAfterAbortControllerReference.current === controller) {
        timelineAfterAbortControllerReference.current = undefined;
        timelineAfterInFlight.current = false;
      }
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  }, [adapter, clearOperationError, reportOperationError]);

  const loadTimelineAround = useCallback(async (entryIndex: number, expectedRevision = adapter.timeline?.revision, externalSignal?: AbortSignal) => {
    if (!adapter.loadTimelineAround || !expectedRevision) return;
    timelineAroundAbortControllerReference.current?.abort();
    const controller = new AbortController();
    const abortFromExternal = () => {
      controller.abort(externalSignal?.reason);
    };
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    if (externalSignal?.aborted) abortFromExternal();
    timelineAroundAbortControllerReference.current = controller;
    try {
      clearOperationError();
      await adapter.loadTimelineAround(entryIndex, expectedRevision, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) reportOperationError(error, 'load-timeline-around');
    } finally {
      if (timelineAroundAbortControllerReference.current === controller) timelineAroundAbortControllerReference.current = undefined;
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  }, [adapter, clearOperationError, reportOperationError]);

  return (
    <ThreadPrimitive.Root>
      <Root>
        {header}
        {displayedOperationError && (
          <Alert severity='error' onClose={operationErrorOverride ? onClearOperationErrorOverride : clearOperationError} data-testid='chat-operation-error'>
            {renderOperationError ? renderOperationError(displayedOperationError) : operationErrorMessage}
          </Alert>
        )}
        <ViewportShell>
          <ThreadPrimitive.Viewport
            autoScroll={adapter.isAtLiveTail !== false && (adapter.pendingNewMessageCount ?? 0) === 0}
            asChild
          >
            <MessagesList
              ref={viewportReference}
              id='messages-container'
              data-testid='conversation-viewport'
              onScroll={handleScroll}
            >
              {adapter.hasMoreBefore && (
                <Box component='button' type='button' onClick={() => void loadEarlier()} sx={{ alignSelf: 'center' }}>
                  {timelineLabels?.loadEarlier ?? 'Load earlier messages'}
                </Box>
              )}
              {empty && <AuiIf condition={(s) => s.thread.isEmpty}>{empty}</AuiIf>}
              <ThreadPrimitive.Messages>
                {() => (
                  <ThreadMessage
                    renderMessageContent={renderMessageContent}
                    renderTurnActions={renderTurnActions}
                    onWikiTiddlerClick={onWikiTiddlerClick}
                    loadMessageDetail={loadMessageDetail}
                    loadMessageReasoning={loadMessageReasoning ?? adapter.loadMessageReasoning}
                    loadVisibleAttachments={loadVisibleAttachments ?? adapter.loadVisibleAttachments}
                    attachmentRevision={attachmentRevision ?? adapter.timeline?.revision}
                    onAttachmentHydrationError={reportAttachmentHydrationError}
                    activeDetailMessageId={activeDetailMessageId}
                    onActivateDetailMessage={setActiveDetailMessageId}
                    exportMessage={adapter.exportMessage ? exportFullMessage : undefined}
                    messageLabels={messageLabels}
                  />
                )}
              </ThreadPrimitive.Messages>
              {adapter.hasMoreAfter && (
                <Box component='button' type='button' onClick={() => void loadLater()} sx={{ alignSelf: 'center' }}>
                  {timelineLabels?.loadLater ?? 'Load later messages'}
                </Box>
              )}
            </MessagesList>
          </ThreadPrimitive.Viewport>
          {(adapter.pendingNewMessageCount ?? 0) > 0 && adapter.jumpToLatest && (
            <Box
              component='button'
              type='button'
              data-testid='pending-new-messages'
              onClick={() => {
                void jumpToLatest();
              }}
              sx={{
                position: 'absolute',
                insetBlockEnd: 8,
                insetInlineStart: '50%',
                transform: 'translateX(-50%)',
                minHeight: 44,
                zIndex: 5,
                '@media (forced-colors: active)': { border: '1px solid ButtonText' },
              }}
            >
              {timelineLabels?.newMessages?.(adapter.pendingNewMessageCount ?? 0) ??
                `${adapter.pendingNewMessageCount} new messages`}
            </Box>
          )}
          {showTimeline && adapter.timeline && adapter.timeline.items.length > 0 && (
            <ConversationTimelineRail
              conversationId={conversationId}
              timeline={adapter.timeline}
              activeMessageId={activeTimelineMessageId}
              visibleEntryRange={visibleTimelineEntryRange}
              loading={adapter.isLoadingTimelineBefore || adapter.isLoadingTimelineAfter}
              loadingBefore={adapter.isLoadingTimelineBefore}
              loadingAfter={adapter.isLoadingTimelineAfter}
              labels={timelineLabels}
              formatTimestamp={formatTimelineTimestamp}
              onJump={anchor => void jumpToAnchor(anchor)}
              onLoadEarlier={adapter.loadTimelineBefore ? loadTimelineEarlier : undefined}
              onLoadLater={adapter.loadTimelineAfter ? loadTimelineLater : undefined}
              onLoadAround={adapter.loadTimelineAround ? loadTimelineAround : undefined}
            />
          )}
        </ViewportShell>
        <ViewportFooter>
          {footer}
          <ComposerComponent />
        </ViewportFooter>
      </Root>
    </ThreadPrimitive.Root>
  );
};
