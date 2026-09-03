import { Box, CircularProgress, Popover, Tooltip, Typography, useTheme } from '@mui/material';
import type { ConversationTimelineEntry, ConversationTimelinePageSuccess } from 'memeloop';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ConversationTimelineLabels, MemeLoopChatOperation } from '../coreTypes.js';
import { notifyMemeLoopObserver } from '../observerErrors.js';
import type { MemeLoopObserverErrorHandler } from '../observerErrors.js';
import { boundedTimelinePageItems, TIMELINE_MARKER_HEIGHT, timelineEntryOffset, timelineMarkerOffsets, timelineScrollHeight } from '../timelineSampling.js';

export { boundedTimelinePageItems, MAX_RESIDENT_TIMELINE_ENTRIES, timelineEntryOffset, timelineMarkerOffsets, timelineScrollHeight } from '../timelineSampling.js';

const defaultLabels: ConversationTimelineLabels = {
  navigation: 'Conversation timeline',
  message: (index, total, role) => `${role} message ${index} of ${total}`,
  compacted: count => `${count} earlier messages compacted`,
  loadEarlier: 'Load earlier messages',
  loadLater: 'Load later messages',
  seek: 'Seek conversation timeline',
  close: 'Close',
  newMessages: count => `${count} new message${count === 1 ? '' : 's'}`,
};

export const TIMELINE_COMPACT_BREAKPOINT_PX = 480;

export interface RetainedActiveTimelineMessageEntry {
  identity: string;
  messageId: string;
  entryIndex: number;
}

/** Retains one active marker only; browsing pages can never grow resident memory. */
export function retainActiveTimelineMessageEntry(
  previous: Readonly<RetainedActiveTimelineMessageEntry> | undefined,
  identity: string,
  activeMessageId: string | undefined,
  items: readonly ConversationTimelineEntry[],
): Readonly<RetainedActiveTimelineMessageEntry> | undefined {
  if (activeMessageId === undefined) return undefined;
  const current = items.find(entry => entry.kind === 'message' && entry.messageId === activeMessageId);
  if (current?.kind === 'message') return Object.freeze({ identity, messageId: current.messageId, entryIndex: current.entryIndex });
  return previous?.identity === identity && previous.messageId === activeMessageId ? previous : undefined;
}

export function shouldUseCompactTimeline(containerWidth: number, coarsePointer: boolean): boolean {
  return coarsePointer || containerWidth <= TIMELINE_COMPACT_BREAKPOINT_PX;
}

function boundedPreview(value: string | undefined, maximum = 120): string | undefined {
  if (!value || value.length <= maximum) return value;
  let result = value.slice(0, maximum);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) result = result.slice(0, -1);
  return `${result}…`;
}

function entryPreview(entry: ConversationTimelineEntry): string {
  return entry.kind === 'compaction' ? entry.summaryPreview : entry.preview;
}

function entryLabel(
  entry: ConversationTimelineEntry,
  timeline: ConversationTimelinePageSuccess,
  labels: ConversationTimelineLabels,
): string {
  return entry.kind === 'compaction'
    ? labels.compacted(entry.compactedMessageCount)
    : labels.message(entry.entryIndex + 1, timeline.totalEntries, entry.role);
}

function TimelineCard({
  entry,
  timeline,
  labels,
  formatTimestamp,
}: {
  entry: ConversationTimelineEntry;
  timeline: ConversationTimelinePageSuccess;
  labels: ConversationTimelineLabels;
  formatTimestamp: (timestamp: number) => string;
}) {
  const date = new Date(entry.timestamp);
  const validTimestamp = Number.isFinite(date.getTime());
  return (
    <Box sx={{ maxWidth: 320, p: 0.5 }}>
      <Typography variant='caption' color='text.secondary'>
        {entryLabel(entry, timeline, labels)}
      </Typography>
      {validTimestamp && (
        <Typography component='time' dateTime={date.toISOString()} variant='caption' color='text.secondary' sx={{ display: 'block' }}>
          {formatTimestamp(entry.timestamp)}
        </Typography>
      )}
      <Typography variant='body2' sx={{ mt: 0.25, whiteSpace: 'pre-wrap' }}>
        {boundedPreview(entryPreview(entry))}
      </Typography>
      {entry.kind === 'message' && (
        <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 0.5 }}>
          {entry.actorLabel}
        </Typography>
      )}
    </Box>
  );
}

export interface ConversationTimelineRailProps {
  /** Used only to cancel delayed seeks when the host switches conversations. */
  conversationId: string;
  timeline: ConversationTimelinePageSuccess;
  /** Exact resident message that the viewport is currently centred around. */
  activeMessageId?: string;
  /** Inclusive timeline-entry range currently represented in the message viewport. */
  visibleEntryRange?: Readonly<{ start: number; end: number }>;
  loading?: boolean;
  loadingBefore?: boolean;
  loadingAfter?: boolean;
  labels?: Partial<ConversationTimelineLabels>;
  formatTimestamp?: (timestamp: number) => string;
  onJump: (entry: ConversationTimelineEntry) => void;
  onLoadEarlier?: (cursor: string, expectedRevision: string, signal?: AbortSignal) => Promise<void> | void;
  onLoadLater?: (cursor: string, expectedRevision: string, signal?: AbortSignal) => Promise<void> | void;
  onLoadAround?: (entryIndex: number, expectedRevision: string, signal?: AbortSignal) => Promise<void> | void;
  /** Receives rejected timeline page operations so the host can present an actionable error. */
  onOperationError?: (error: unknown, operation: MemeLoopChatOperation) => void;
  /** Receives failures raised by the operation observer itself. */
  onObserverError?: MemeLoopObserverErrorHandler;
}

type PendingFocus = 'first' | 'last' | undefined;
type NavigationKind = 'before' | 'after' | 'around';

function timelineNavigationOperation(kind: NavigationKind): MemeLoopChatOperation {
  if (kind === 'before') return 'load-timeline-before';
  if (kind === 'after') return 'load-timeline-after';
  return 'load-timeline-around';
}

interface TimelineNavigationOperation {
  kind: NavigationKind;
  token: symbol;
  generation: number;
  controller: AbortController;
}

export function ConversationTimelineRail({
  conversationId,
  timeline,
  activeMessageId,
  visibleEntryRange,
  loading,
  loadingBefore,
  loadingAfter,
  labels: labelOverrides,
  formatTimestamp = timestamp => new Date(timestamp).toISOString(),
  onJump,
  onLoadEarlier,
  onLoadLater,
  onLoadAround,
  onOperationError,
  onObserverError,
}: ConversationTimelineRailProps) {
  const theme = useTheme();
  const labels = { ...defaultLabels, ...labelOverrides };
  const navigationReference = useRef<HTMLElement>(null);
  const scrollFrameReference = useRef<number | undefined>(undefined);
  const rangeLoadTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingFocusReference = useRef<PendingFocus>(undefined);
  const navigationGenerationReference = useRef(0);
  const navigationInFlightReference = useRef<TimelineNavigationOperation | undefined>(undefined);
  const activeMessageEntryReference = useRef<Readonly<RetainedActiveTimelineMessageEntry> | undefined>(undefined);
  const timelineIdentityReference = useRef<string | undefined>(undefined);
  const lastRecenterRequestReference = useRef<string | undefined>(undefined);
  const [compactAnchorElement, setCompactAnchorElement] = useState<HTMLElement | undefined>(undefined);
  const [compactSummary, setCompactSummary] = useState<Extract<ConversationTimelineEntry, { kind: 'compaction' }> | undefined>(undefined);
  const [compactSeekEntryIndex, setCompactSeekEntryIndex] = useState(0);
  const items = useMemo(() => boundedTimelinePageItems(timeline.items), [timeline.items]);
  const markerOffsets = useMemo(() => timelineMarkerOffsets(items, timeline.totalEntries), [items, timeline.totalEntries]);
  const activeEntry = items.find(entry => entry.kind === 'message' && entry.messageId === activeMessageId) ?? items.at(-1);
  const scrollHeight = timelineScrollHeight(timeline.totalEntries);
  const firstEntry = items[0];
  const lastEntry = items.at(-1);
  const firstLoadedOffset = markerOffsets[0] ?? 0;
  const lastLoadedOffset = markerOffsets.at(-1) ?? 0;
  const normalizedVisibleEntryRange = useMemo(() => {
    if (
      timeline.totalEntries < 1 ||
      !visibleEntryRange ||
      !Number.isSafeInteger(visibleEntryRange.start) ||
      !Number.isSafeInteger(visibleEntryRange.end)
    ) return undefined;
    const start = Math.max(0, Math.min(timeline.totalEntries - 1, Math.min(visibleEntryRange.start, visibleEntryRange.end)));
    const end = Math.max(start, Math.min(timeline.totalEntries - 1, Math.max(visibleEntryRange.start, visibleEntryRange.end)));
    return { start, end };
  }, [timeline.totalEntries, visibleEntryRange]);
  const visibleWindowStartMarkerIndex = normalizedVisibleEntryRange
    ? items.findIndex(entry => entry.entryIndex === normalizedVisibleEntryRange.start)
    : -1;
  const visibleWindowEndMarkerIndex = normalizedVisibleEntryRange
    ? items.findIndex(entry => entry.entryIndex === normalizedVisibleEntryRange.end)
    : -1;
  const visibleWindowStartOffset = normalizedVisibleEntryRange
    ? markerOffsets[visibleWindowStartMarkerIndex] ?? timelineEntryOffset(normalizedVisibleEntryRange.start, timeline.totalEntries)
    : undefined;
  const visibleWindowEndOffset = normalizedVisibleEntryRange
    ? (markerOffsets[visibleWindowEndMarkerIndex] ?? timelineEntryOffset(normalizedVisibleEntryRange.end, timeline.totalEntries)) + TIMELINE_MARKER_HEIGHT
    : undefined;

  useEffect(() => {
    const next = activeEntry?.entryIndex ?? lastEntry?.entryIndex ?? 0;
    setCompactSeekEntryIndex(Math.max(0, Math.min(Math.max(0, timeline.totalEntries - 1), next)));
  }, [activeEntry?.entryIndex, conversationId, firstEntry?.entryIndex, lastEntry?.entryIndex, timeline.revision, timeline.totalEntries]);

  const runNavigation = (kind: NavigationKind, operation: (signal: AbortSignal) => Promise<void> | void): boolean => {
    const previous = navigationInFlightReference.current;
    if (previous) {
      if (kind !== 'around' || previous.kind !== 'around') return false;
      previous.controller.abort();
      navigationInFlightReference.current = undefined;
    }
    const current: TimelineNavigationOperation = {
      kind,
      token: Symbol(kind),
      generation: navigationGenerationReference.current,
      controller: new AbortController(),
    };
    navigationInFlightReference.current = current;
    void Promise.resolve()
      .then(() => operation(current.controller.signal))
      .catch((error: unknown) => {
        if (
          !current.controller.signal.aborted &&
          navigationInFlightReference.current?.token === current.token
        ) {
          pendingFocusReference.current = undefined;
          const operationName = timelineNavigationOperation(kind);
          notifyMemeLoopObserver(
            () => onOperationError?.(error, operationName),
            'timeline-rail.onOperationError',
            operationName,
            onObserverError,
          );
        }
      })
      .finally(() => {
        const active = navigationInFlightReference.current;
        if (active?.token === current.token && active.generation === current.generation) navigationInFlightReference.current = undefined;
      });
    return true;
  };

  const loadAroundDebounced = (entryIndex: number) => {
    const activeNavigation = navigationInFlightReference.current;
    if (!onLoadAround || (loading && activeNavigation?.kind !== 'around') || (activeNavigation && activeNavigation.kind !== 'around')) return;
    if (rangeLoadTimeoutReference.current !== undefined) clearTimeout(rangeLoadTimeoutReference.current);
    rangeLoadTimeoutReference.current = setTimeout(() => {
      rangeLoadTimeoutReference.current = undefined;
      const currentNavigation = navigationInFlightReference.current;
      if ((currentNavigation && currentNavigation.kind !== 'around') || (loading && currentNavigation?.kind !== 'around')) return;
      runNavigation('around', signal => onLoadAround(entryIndex, timeline.revision, signal));
    }, 150);
  };

  useEffect(() => {
    const identity = `${conversationId}\u0000${timeline.revision}`;
    if (timelineIdentityReference.current !== identity) {
      timelineIdentityReference.current = identity;
      activeMessageEntryReference.current = undefined;
      lastRecenterRequestReference.current = undefined;
    }
    activeMessageEntryReference.current = retainActiveTimelineMessageEntry(
      activeMessageEntryReference.current,
      identity,
      activeMessageId,
      items,
    );
  }, [activeMessageId, conversationId, items, timeline.revision]);

  useEffect(() => {
    const navigation = navigationReference.current;
    if (!navigation || activeMessageId === undefined) return;
    const loadedIndex = items.findIndex(entry => entry.kind === 'message' && entry.messageId === activeMessageId);
    const retained = activeMessageEntryReference.current;
    const knownEntryIndex = loadedIndex >= 0
      ? items[loadedIndex].entryIndex
      : retained?.identity === `${conversationId}\u0000${timeline.revision}` && retained.messageId === activeMessageId
      ? retained.entryIndex
      : undefined;
    if (knownEntryIndex === undefined) return;
    const offset = markerOffsets[loadedIndex] ?? timelineEntryOffset(knownEntryIndex, timeline.totalEntries);
    navigation.scrollTop = Math.max(0, offset - navigation.clientHeight / 2);
    if (loadedIndex >= 0 || !onLoadAround || loading) {
      if (loadedIndex >= 0) lastRecenterRequestReference.current = undefined;
      return;
    }
    // A same-revision page replacement can slide the resident marker page
    // away from the still-focused message. Restore the marker page around the
    // exact cached message position instead of leaving a stale/false marker.
    const requestIdentity = `${conversationId}\u0000${timeline.revision}\u0000${activeMessageId}\u0000${firstEntry?.entryIndex ?? -1}\u0000${lastEntry?.entryIndex ?? -1}`;
    if (lastRecenterRequestReference.current === requestIdentity) return;
    lastRecenterRequestReference.current = requestIdentity;
    runNavigation('around', signal => onLoadAround(knownEntryIndex, timeline.revision, signal));
  }, [activeMessageId, conversationId, firstEntry?.entryIndex, items, lastEntry?.entryIndex, loading, markerOffsets, onLoadAround, timeline.revision, timeline.totalEntries]);

  useEffect(() => {
    const pending = pendingFocusReference.current;
    if (!pending || items.length === 0) return;
    pendingFocusReference.current = undefined;
    const buttons = navigationReference.current?.querySelectorAll<HTMLElement>('[data-timeline-entry-index]');
    const target = pending === 'first' ? buttons?.[0] : buttons?.[buttons.length - 1];
    requestAnimationFrame(() => target?.focus());
  }, [items[0]?.cursor, items.at(-1)?.cursor, timeline.revision]);

  useEffect(() => {
    if (rangeLoadTimeoutReference.current !== undefined) clearTimeout(rangeLoadTimeoutReference.current);
    navigationGenerationReference.current += 1;
    navigationInFlightReference.current?.controller.abort();
    navigationInFlightReference.current = undefined;
    pendingFocusReference.current = undefined;
    setCompactAnchorElement(undefined);
    setCompactSummary(undefined);
  }, [conversationId, timeline.revision]);

  useEffect(() => () => {
    if (scrollFrameReference.current !== undefined) cancelAnimationFrame(scrollFrameReference.current);
    if (rangeLoadTimeoutReference.current !== undefined) clearTimeout(rangeLoadTimeoutReference.current);
    navigationGenerationReference.current += 1;
    navigationInFlightReference.current?.controller.abort();
    navigationInFlightReference.current = undefined;
  }, []);

  const loadPreviousPage = () => {
    if (!timeline.hasMoreBefore || !firstEntry || !onLoadEarlier || loadingBefore || loading || navigationInFlightReference.current) return;
    runNavigation('before', signal => onLoadEarlier(firstEntry.cursor, timeline.revision, signal));
  };
  const loadNextPage = () => {
    if (!timeline.hasMoreAfter || !lastEntry || !onLoadLater || loadingAfter || loading || navigationInFlightReference.current) return;
    runNavigation('after', signal => onLoadLater(lastEntry.cursor, timeline.revision, signal));
  };

  const renderEntryButton = (entry: ConversationTimelineEntry, index: number) => {
    const active = entry.kind === 'message' && entry.messageId === activeMessageId;
    const inViewport = normalizedVisibleEntryRange !== undefined &&
      entry.entryIndex >= normalizedVisibleEntryRange.start &&
      entry.entryIndex <= normalizedVisibleEntryRange.end;
    const compaction = entry.kind === 'compaction';
    return (
      <Tooltip
        key={entry.cursor}
        placement={theme.direction === 'rtl' ? 'left' : 'right'}
        enterDelay={180}
        title={<TimelineCard entry={entry} timeline={timeline} labels={labels} formatTimestamp={formatTimestamp} />}
      >
        <Box
          component='button'
          type='button'
          aria-current={active ? 'location' : undefined}
          aria-label={entryLabel(entry, timeline, labels)}
          aria-posinset={entry.entryIndex + 1}
          aria-setsize={timeline.totalEntries}
          data-timeline-entry-index={entry.entryIndex}
          data-timeline-message-id={entry.kind === 'message' ? entry.messageId : undefined}
          data-in-viewport={inViewport ? 'true' : undefined}
          onClick={() => {
            onJump(entry);
          }}
          onKeyDown={event => {
            const buttons = navigationReference.current?.querySelectorAll<HTMLElement>('[data-timeline-entry-index]');
            if (!buttons?.length) return;
            const previous = event.key === 'ArrowUp' || event.key === (theme.direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft');
            const next = event.key === 'ArrowDown' || event.key === (theme.direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
            if (event.key === 'Escape') {
              event.currentTarget.blur();
              return;
            }
            if (previous && index === 0 && timeline.hasMoreBefore) {
              event.preventDefault();
              pendingFocusReference.current = 'last';
              loadPreviousPage();
              return;
            }
            if (next && index === buttons.length - 1 && timeline.hasMoreAfter) {
              event.preventDefault();
              pendingFocusReference.current = 'first';
              loadNextPage();
              return;
            }
            if (event.key === 'Home' && entry.entryIndex !== 0 && onLoadAround) {
              event.preventDefault();
              pendingFocusReference.current = 'first';
              runNavigation('around', signal => onLoadAround(0, timeline.revision, signal));
              return;
            }
            if (event.key === 'End' && entry.entryIndex !== timeline.totalEntries - 1 && onLoadAround) {
              event.preventDefault();
              pendingFocusReference.current = 'last';
              runNavigation('around', signal => onLoadAround(timeline.totalEntries - 1, timeline.revision, signal));
              return;
            }
            let targetIndex: number | undefined;
            if (next) targetIndex = Math.min(index + 1, buttons.length - 1);
            else if (previous) targetIndex = Math.max(index - 1, 0);
            else if (event.key === 'Home') targetIndex = 0;
            else if (event.key === 'End') targetIndex = buttons.length - 1;
            if (targetIndex === undefined) return;
            event.preventDefault();
            buttons[targetIndex]?.focus();
          }}
          tabIndex={active || (activeMessageId === undefined && entry.entryIndex === lastEntry?.entryIndex) ? 0 : -1}
          sx={{
            appearance: 'none',
            position: 'absolute',
            insetBlockStart: markerOffsets[index],
            insetInlineStart: 2,
            width: 24,
            height: 24,
            p: 0,
            border: 0,
            bgcolor: 'transparent',
            cursor: 'pointer',
            '&::after': {
              content: '""',
              display: 'block',
              margin: 'auto',
              width: active ? 10 : compaction ? 8 : 6,
              height: active ? 10 : compaction ? 8 : 6,
              borderRadius: compaction ? 0.5 : '50%',
              transform: compaction ? 'rotate(45deg)' : undefined,
              bgcolor: active ? 'primary.main' : compaction ? 'warning.main' : 'text.secondary',
              boxShadow: active
                ? theme => `0 0 0 3px ${theme.palette.background.paper}`
                : inViewport
                ? theme => `0 0 0 2px ${theme.palette.background.paper}`
                : undefined,
              opacity: inViewport || active ? 1 : 0.72,
            },
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
            '&:hover::after': { width: 12, height: 12, bgcolor: 'primary.main' },
            '@media (forced-colors: active)': {
              '&::after': { backgroundColor: 'CanvasText', border: '1px solid Canvas' },
              '&[aria-current="location"]::after': { backgroundColor: 'Highlight' },
            },
          }}
        />
      </Tooltip>
    );
  };

  return (
    <>
      <Box
        ref={navigationReference}
        component='nav'
        aria-label={labels.navigation}
        data-testid='conversation-timeline'
        onScroll={event => {
          if (scrollFrameReference.current !== undefined) return;
          const navigation = event.currentTarget;
          scrollFrameReference.current = requestAnimationFrame(() => {
            scrollFrameReference.current = undefined;
            const approximateEntryIndex = timeline.totalEntries <= 1
              ? 0
              : Math.round(navigation.scrollTop / Math.max(1, scrollHeight - TIMELINE_MARKER_HEIGHT) * (timeline.totalEntries - 1));
            if (firstEntry && lastEntry && (approximateEntryIndex < firstEntry.entryIndex || approximateEntryIndex > lastEntry.entryIndex)) {
              loadAroundDebounced(approximateEntryIndex);
            } else {
              if (timeline.hasMoreBefore && navigation.scrollTop <= firstLoadedOffset + 160) loadPreviousPage();
              if (timeline.hasMoreAfter && navigation.scrollTop + navigation.clientHeight >= lastLoadedOffset - 160) loadNextPage();
            }
          });
        }}
        sx={{
          position: 'absolute',
          insetBlock: 8,
          insetInlineStart: 4,
          width: 28,
          zIndex: 3,
          overflowY: 'auto',
          overflowX: 'hidden',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
          [`@container memeloop-chat (max-width: ${TIMELINE_COMPACT_BREAKPOINT_PX}px)`]: { display: 'none' },
          '@media (pointer: coarse)': { display: 'none' },
        }}
      >
        <Box sx={{ position: 'relative', minHeight: '100%', height: scrollHeight }}>
          <Box
            aria-hidden='true'
            data-testid='conversation-timeline-track'
            sx={{
              position: 'absolute',
              insetBlock: 8,
              insetInlineStart: 13,
              width: 2,
              borderRadius: 1,
              bgcolor: 'divider',
              pointerEvents: 'none',
            }}
          />
          {visibleWindowStartOffset !== undefined && visibleWindowEndOffset !== undefined && (
            <Box
              aria-hidden='true'
              data-testid='conversation-timeline-visible-window'
              sx={{
                position: 'absolute',
                insetBlockStart: visibleWindowStartOffset,
                insetInlineStart: 11,
                width: 6,
                height: Math.max(6, visibleWindowEndOffset - visibleWindowStartOffset),
                borderRadius: 3,
                bgcolor: 'primary.main',
                opacity: 0.28,
                pointerEvents: 'none',
                '@media (forced-colors: active)': {
                  backgroundColor: 'Highlight',
                  opacity: 1,
                },
              }}
            />
          )}
          {timeline.hasMoreBefore && onLoadEarlier && (
            <Box
              component='button'
              type='button'
              aria-label={labels.loadEarlier}
              disabled={loadingBefore}
              onClick={loadPreviousPage}
              sx={{
                position: 'absolute',
                insetBlockStart: Math.max(0, firstLoadedOffset - 24),
                width: 24,
                minHeight: 24,
                p: 0,
                border: 0,
                borderRadius: 1,
                bgcolor: 'background.paper',
                color: 'text.primary',
                zIndex: 1,
              }}
            >
              ↑
            </Box>
          )}
          {items.map(renderEntryButton)}
          {timeline.hasMoreAfter && onLoadLater && (
            <Box
              component='button'
              type='button'
              aria-label={labels.loadLater}
              disabled={loadingAfter}
              onClick={loadNextPage}
              sx={{
                position: 'absolute',
                insetBlockStart: Math.min(scrollHeight - 24, lastLoadedOffset + 24),
                width: 24,
                minHeight: 24,
                p: 0,
                border: 0,
                borderRadius: 1,
                bgcolor: 'background.paper',
                color: 'text.primary',
                zIndex: 1,
              }}
            >
              ↓
            </Box>
          )}
        </Box>
        {loading && <CircularProgress size={14} aria-label={labels.navigation} sx={{ position: 'absolute', insetInlineStart: 7, insetBlockStart: 0 }} />}
      </Box>
      <Box
        component='button'
        type='button'
        data-testid='compact-conversation-timeline'
        aria-label={labels.navigation}
        onClick={event => {
          setCompactSeekEntryIndex(activeEntry?.entryIndex ?? lastEntry?.entryIndex ?? 0);
          setCompactAnchorElement(event.currentTarget);
        }}
        sx={{
          display: 'none',
          position: 'absolute',
          insetBlockStart: 8,
          insetInlineEnd: 8,
          zIndex: 4,
          minWidth: 44,
          minHeight: 44,
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          bgcolor: 'background.paper',
          color: 'text.primary',
          [`@container memeloop-chat (max-width: ${TIMELINE_COMPACT_BREAKPOINT_PX}px)`]: { display: 'block' },
          '@media (pointer: coarse)': { display: 'block' },
        }}
      >
        {activeEntry ? `${activeEntry.entryIndex + 1}/${timeline.totalEntries}` : timeline.totalEntries}
      </Box>
      <Popover
        open={!!compactAnchorElement}
        anchorEl={compactAnchorElement}
        onClose={() => {
          setCompactAnchorElement(undefined);
          setCompactSummary(undefined);
        }}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        slotProps={{ paper: { sx: { width: 'min(320px, calc(100vw - 32px))', maxHeight: '70vh', p: 1 } } }}
      >
        <Typography variant='subtitle2' sx={{ px: 1, py: 0.5 }}>{labels.navigation}</Typography>
        {compactSummary
          ? (
            <Box data-testid='compact-compaction-summary' sx={{ p: 1 }}>
              <Typography variant='caption'>{labels.compacted(compactSummary.compactedMessageCount)}</Typography>
              <Typography variant='body2' sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>{boundedPreview(compactSummary.summaryPreview, 2_000)}</Typography>
              <Box
                component='button'
                type='button'
                onClick={() => {
                  setCompactSummary(undefined);
                }}
                sx={{ minHeight: 44, mt: 1 }}
              >
                {labels.close}
              </Box>
            </Box>
          )
          : (
            <>
              {timeline.totalEntries > 1 && onLoadAround && (
                <Box
                  component='input'
                  type='range'
                  min={0}
                  max={timeline.totalEntries - 1}
                  value={compactSeekEntryIndex}
                  aria-label={labels.seek}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    const entryIndex = Number(event.currentTarget.value);
                    setCompactSeekEntryIndex(entryIndex);
                    loadAroundDebounced(entryIndex);
                  }}
                  sx={{ width: '100%', minHeight: 44 }}
                />
              )}
              {timeline.hasMoreBefore && onLoadEarlier && (
                <Box component='button' type='button' disabled={loadingBefore} onClick={loadPreviousPage} sx={{ width: '100%', minHeight: 44 }}>{labels.loadEarlier}</Box>
              )}
              {items.map(entry => {
                const inViewport = normalizedVisibleEntryRange !== undefined &&
                  entry.entryIndex >= normalizedVisibleEntryRange.start &&
                  entry.entryIndex <= normalizedVisibleEntryRange.end;
                return (
                  <Box
                    key={entry.cursor}
                    component='button'
                    type='button'
                    aria-current={entry.kind === 'message' && entry.messageId === activeMessageId ? 'location' : undefined}
                    data-timeline-message-id={entry.kind === 'message' ? entry.messageId : undefined}
                    data-in-viewport={inViewport ? 'true' : undefined}
                    onClick={() => {
                      onJump(entry);
                      if (entry.kind === 'compaction') setCompactSummary(entry);
                      else setCompactAnchorElement(undefined);
                    }}
                    sx={{
                      display: 'block',
                      width: '100%',
                      minHeight: 44,
                      p: 1,
                      border: 0,
                      borderRadius: 1,
                      textAlign: 'start',
                      bgcolor: entry.kind === 'message' && entry.messageId === activeMessageId
                        ? 'action.selected'
                        : inViewport
                        ? 'action.hover'
                        : 'transparent',
                      color: 'text.primary',
                      '&:hover': { bgcolor: 'action.hover' },
                    }}
                  >
                    <Typography variant='caption'>{entryLabel(entry, timeline, labels)}</Typography>
                    <Typography variant='body2' noWrap>{boundedPreview(entryPreview(entry))}</Typography>
                    {entry.kind === 'message' && <Typography variant='caption' color='text.secondary' noWrap>{entry.actorLabel}</Typography>}
                  </Box>
                );
              })}
              {timeline.hasMoreAfter && onLoadLater && (
                <Box component='button' type='button' disabled={loadingAfter} onClick={loadNextPage} sx={{ width: '100%', minHeight: 44 }}>{labels.loadLater}</Box>
              )}
            </>
          )}
      </Popover>
    </>
  );
}
