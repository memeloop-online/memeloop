import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import type { ConversationMessageListProjection, ConversationTimelineEntry, ConversationTimelineMessageEntry, ConversationTimelinePageSuccess } from 'memeloop';
import React, { useMemo, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentChatView } from '../agent/AgentChatView.js';
import { ConversationTimelineRail, retainActiveTimelineMessageEntry, shouldUseCompactTimeline, timelineMarkerOffsets } from '../chat/thread/ConversationTimelineRail.js';
import type { WebMemeLoopChatAdapter, WikiTiddlerAttachment } from '../chat/types.js';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function message(messageId: string, role: ConversationMessageListProjection['role'] = 'user'): ConversationMessageListProjection {
  const index = Number(messageId.split('-').at(-1) ?? 0);
  return {
    messageId,
    turnId: role === 'user' ? messageId : `message-${Math.max(0, index - 1)}`,
    conversationId: 'long-conversation',
    originNodeId: 'local',
    originSequence: index + 1,
    timestamp: index,
    lamportClock: index,
    role,
    content: role === 'user' ? `User prompt ${index}` : `Assistant reply ${index}`,
  };
}

function timelineEntry(index: number, role: ConversationTimelineMessageEntry['role'] = 'user', turnId = `message-${index}`): ConversationTimelineMessageEntry {
  return {
    entryId: `message-${index}`,
    turnId,
    cursor: `cursor-${index}`,
    messageId: `message-${index}`,
    conversationId: 'long-conversation',
    timestamp: index,
    lamportClock: index,
    originNodeId: 'local',
    kind: 'message',
    entryIndex: index,
    turnIndex: index,
    role,
    actorId: role === 'user' ? 'user' : 'assistant',
    actorLabel: role === 'user' ? 'User' : 'Assistant',
    preview: role === 'user' ? `User prompt ${index}` : `Assistant reply ${index}`,
  };
}

function compactionEntry(index: number, summaryPreview = 'A bounded summary of older turns'): ConversationTimelineEntry {
  return {
    entryId: `compaction-${index}`,
    cursor: `compaction-cursor-${index}`,
    conversationId: 'long-conversation',
    timestamp: index,
    lamportClock: index,
    originNodeId: 'local',
    kind: 'compaction',
    entryIndex: index,
    turnIndex: index,
    summaryPreview,
    compactedMessageCount: 4,
    compactedTurnCount: 2,
  };
}

function timeline(count: number, startIndex = 0, totalTurns = count, revision = 'revision-1'): ConversationTimelinePageSuccess {
  return {
    reset: false,
    items: Array.from({ length: count }, (_, index) => timelineEntry(startIndex + index)),
    revision,
    totalMessages: totalTurns * 2,
    totalTurns,
    totalEntries: totalTurns,
    hasMoreBefore: startIndex > 0,
    hasMoreAfter: startIndex + count < totalTurns,
    startEntryIndex: startIndex,
    endEntryIndex: startIndex + count - 1,
    startCursor: `cursor-${startIndex}`,
    endCursor: `cursor-${startIndex + count - 1}`,
  };
}

function adapter(messages: readonly ConversationMessageListProjection[], overrides: Partial<WebMemeLoopChatAdapter> = {}): WebMemeLoopChatAdapter {
  return {
    conversationId: messages[0]?.conversationId ?? 'long-conversation',
    messages,
    isRunning: false,
    isLoading: false,
    error: null,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    deleteTurn: vi.fn().mockResolvedValue(undefined),
    retryTurn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('long conversation UI', () => {
  it('uses the 44px compact timeline at 320/480px and on coarse pointers', () => {
    expect(shouldUseCompactTimeline(320, false)).toBe(true);
    expect(shouldUseCompactTimeline(480, false)).toBe(true);
    expect(shouldUseCompactTimeline(481, false)).toBe(false);
    expect(shouldUseCompactTimeline(1_024, true)).toBe(true);
  });

  it('keeps a 100,000-turn server-paged ruler resident and DOM-bounded', async () => {
    const loadEarlier = vi.fn();
    render(
      <ConversationTimelineRail
        conversationId='long-conversation'
        timeline={{ ...timeline(50, 99_950, 100_000), hasMoreBefore: true }}
        onJump={vi.fn()}
        onLoadEarlier={loadEarlier}
      />,
    );
    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    expect(within(navigation).getAllByRole('button')).toHaveLength(51);
    expect(navigation.firstElementChild).toHaveStyle({ height: `${100_000 * 24}px` });
    navigation.scrollTop = 99_950 * 24;
    fireEvent.scroll(navigation);
    await waitFor(() => {
      expect(loadEarlier).toHaveBeenCalledTimes(1);
    });
  });

  it('debounces an arbitrary ruler seek into one cancellable bounded page request', async () => {
    const loadTimelineAround = vi.fn();
    function Harness() {
      const [page, setPage] = useState(timeline(50, 99_950, 100_000));
      return (
        <AgentChatView
          adapter={adapter([message('message-99999')], {
            timeline: page,
            loadTimelineAround: async (entryIndex, expectedRevision, signal) => {
              loadTimelineAround(entryIndex, expectedRevision, signal);
              const start = Math.max(0, Math.min(99_950, entryIndex - 25));
              setPage(timeline(50, start, 100_000));
            },
          })}
        />
      );
    }
    render(<Harness />);
    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    navigation.scrollTop = 1_200_000;
    fireEvent.scroll(navigation);
    await waitFor(() => {
      expect(loadTimelineAround).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });
    const [requestedTurnIndex, revision, signal] = loadTimelineAround.mock.calls[0];
    expect(requestedTurnIndex).toBeGreaterThan(49_000);
    expect(requestedTurnIndex).toBeLessThan(51_000);
    expect(revision).toBe('revision-1');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(within(navigation).getAllByRole('button').length).toBeLessThanOrEqual(50);
  });

  it('makes rapid around seeks latest-wins and aborts the obsolete target', async () => {
    const requests: Array<{ entryIndex: number; signal: AbortSignal }> = [];
    const loadAround = vi.fn((entryIndex: number, _revision: string, signal?: AbortSignal) => {
      requests.push({ entryIndex, signal: signal! });
      return new Promise<void>(() => {});
    });
    render(
      <ConversationTimelineRail
        conversationId='long-conversation'
        timeline={timeline(50, 50, 100)}
        onJump={vi.fn()}
        onLoadAround={loadAround}
      />,
    );
    fireEvent.click(screen.getByTestId('compact-conversation-timeline'));
    const seek = await screen.findByRole('slider', { name: 'Seek conversation timeline' });
    fireEvent.change(seek, { target: { value: '10' } });
    await waitFor(() => {
      expect(loadAround).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });
    fireEvent.change(seek, { target: { value: '90' } });
    await waitFor(() => {
      expect(loadAround).toHaveBeenCalledTimes(2);
    }, { timeout: 1_000 });
    expect(requests.map(request => request.entryIndex)).toEqual([10, 90]);
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests[1]?.signal.aborted).toBe(false);
  });

  it('keeps around seeks latest-wins after the host reports loading', async () => {
    const requests: Array<{ entryIndex: number; signal: AbortSignal }> = [];
    function Harness() {
      const [loading, setLoading] = useState(false);
      return (
        <ConversationTimelineRail
          conversationId='long-conversation'
          timeline={timeline(50, 50, 100)}
          loading={loading}
          onJump={vi.fn()}
          onLoadAround={(entryIndex, _revision, signal) => {
            requests.push({ entryIndex, signal: signal! });
            setLoading(true);
            return new Promise<void>(() => {});
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId('compact-conversation-timeline'));
    const seek = await screen.findByRole('slider', { name: 'Seek conversation timeline' });
    fireEvent.change(seek, { target: { value: '10' } });
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    fireEvent.change(seek, { target: { value: '90' } });
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests[1]).toMatchObject({ entryIndex: 90 });
  });

  it('keeps one million-entry marker hit targets ordered and non-overlapping', () => {
    const items = Array.from({ length: 50 }, (_, index) => timelineEntry(500_000 + index));
    const offsets = timelineMarkerOffsets(items, 1_000_000);
    expect(offsets).toHaveLength(50);
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index] - offsets[index - 1]).toBeGreaterThanOrEqual(24);
    }
  });

  it('renders one bounded timeline page as distinct, keyboard-reachable hitboxes', () => {
    const onJump = vi.fn<(entry: ConversationTimelineEntry) => void>();
    render(<ConversationTimelineRail conversationId='long-conversation' timeline={timeline(50, 70, 120)} onJump={onJump} />);

    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    const buttons = within(navigation).getAllByRole('button');
    expect(buttons).toHaveLength(50);
    expect(getComputedStyle(navigation).overflowY).toBe('auto');
    expect(getComputedStyle(buttons[0]).position).toBe('absolute');

    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[24]);
    fireEvent.click(buttons[49]);
    expect(onJump.mock.calls.map(([entry]) => entry.entryId)).toEqual([
      'message-70',
      'message-94',
      'message-119',
    ]);

    act(() => {
      buttons[0].focus();
      fireEvent.keyDown(buttons[0], { key: 'End' });
    });
    expect(buttons[49]).toHaveFocus();
  });

  it('keeps independent durable turns even when their user prompt text is identical', () => {
    const page = timeline(2);
    page.items = page.items.map(entry => entry.kind === 'message' ? { ...entry, preview: 'repeat this exact prompt' } : entry);
    render(<ConversationTimelineRail conversationId='long-conversation' timeline={page} onJump={vi.fn()} />);

    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    expect(within(navigation).getByRole('button', { name: 'user message 1 of 2' })).toHaveAttribute('data-timeline-entry-index', '0');
    expect(within(navigation).getByRole('button', { name: 'user message 2 of 2' })).toHaveAttribute('data-timeline-entry-index', '1');
  });

  it('loads the adjacent page when keyboard navigation crosses a page boundary', async () => {
    const loadLater = vi.fn();
    function Harness() {
      const [page, setPage] = useState<ConversationTimelinePageSuccess>({ ...timeline(2, 0, 4), hasMoreAfter: true });
      return (
        <ConversationTimelineRail
          conversationId='long-conversation'
          timeline={page}
          onJump={vi.fn()}
          onLoadLater={(cursor, revision, signal) => {
            loadLater(cursor, revision, signal);
            setPage({ ...timeline(2, 2, 4), hasMoreBefore: true });
          }}
        />
      );
    }
    render(<Harness />);
    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    const lastMarker = navigation.querySelector<HTMLElement>('[data-timeline-entry-index="1"]')!;
    await act(async () => {
      lastMarker.focus();
      fireEvent.keyDown(lastMarker, { key: 'ArrowDown' });
      await Promise.resolve();
    });

    expect(loadLater).toHaveBeenCalledWith('cursor-1', 'revision-1', expect.any(AbortSignal));
    await waitFor(() => {
      expect(navigation.querySelector('[data-timeline-entry-index="2"]')).toHaveFocus();
    });
  });

  it('keeps timeline edge loading exactly-once while a slow page request is in flight', async () => {
    let resolvePage!: () => void;
    const pending = new Promise<void>(resolve => {
      resolvePage = resolve;
    });
    const loadEarlier = vi.fn(() => pending);
    render(
      <ConversationTimelineRail
        conversationId='long-conversation'
        timeline={{ ...timeline(50, 50, 100), hasMoreBefore: true }}
        onJump={vi.fn()}
        onLoadEarlier={loadEarlier}
      />,
    );
    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    navigation.scrollTop = 50 * 24;
    for (let index = 0; index < 20; index += 1) fireEvent.scroll(navigation);
    await waitFor(() => {
      expect(loadEarlier).toHaveBeenCalledTimes(1);
    });
    for (let index = 0; index < 20; index += 1) fireEvent.scroll(navigation);
    await act(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePage();
      await pending;
    });
    fireEvent.scroll(navigation);
    await waitFor(() => {
      expect(loadEarlier).toHaveBeenCalledTimes(2);
    });
  });

  it('aborts an old conversation navigation without letting its completion unlock the new one', async () => {
    let resolveOld!: () => void;
    const oldPending = new Promise<void>(resolve => {
      resolveOld = resolve;
    });
    const newPending = new Promise<void>(() => {});
    const oldLoad = vi.fn((_cursor: string, _revision: string, _signal?: AbortSignal) => oldPending);
    const newLoad = vi.fn((_cursor: string, _revision: string, _signal?: AbortSignal) => newPending);
    const { rerender } = render(
      <ConversationTimelineRail
        conversationId='old'
        timeline={{ ...timeline(2, 2, 4, 'old-revision'), hasMoreBefore: true }}
        onJump={vi.fn()}
        onLoadEarlier={oldLoad}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => {
      expect(oldLoad).toHaveBeenCalledTimes(1);
    });
    const oldSignal = oldLoad.mock.calls[0]?.[2];

    rerender(
      <ConversationTimelineRail
        conversationId='new'
        timeline={{ ...timeline(2, 2, 4, 'new-revision'), hasMoreBefore: true }}
        onJump={vi.fn()}
        onLoadEarlier={newLoad}
      />,
    );
    await waitFor(() => {
      expect(oldSignal?.aborted).toBe(true);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => {
      expect(newLoad).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      resolveOld();
      await oldPending;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(newLoad).toHaveBeenCalledTimes(1);
  });

  it('contains rejected Home seeks and permits a later retry', async () => {
    const loadAround = vi.fn().mockRejectedValue(new Error('seek failed'));
    render(
      <ConversationTimelineRail
        conversationId='long-conversation'
        timeline={timeline(2, 50, 100)}
        onJump={vi.fn()}
        onLoadAround={loadAround}
      />,
    );
    const marker = screen.getByRole('button', { name: 'user message 51 of 100' });
    fireEvent.keyDown(marker, { key: 'Home' });
    await waitFor(() => {
      expect(loadAround).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(marker, { key: 'Home' });
    await waitFor(() => {
      expect(loadAround).toHaveBeenCalledTimes(2);
    });
    expect(loadAround).toHaveBeenLastCalledWith(0, 'revision-1', expect.any(AbortSignal));
  });

  it('keeps vertical arrows stable and mirrors horizontal marker navigation in RTL', async () => {
    render(
      <ThemeProvider theme={createTheme({ direction: 'rtl' })}>
        <ConversationTimelineRail conversationId='long-conversation' timeline={timeline(3)} onJump={vi.fn()} />
      </ThemeProvider>,
    );
    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    const first = navigation.querySelector<HTMLElement>('[data-timeline-entry-index="0"]')!;
    const middle = navigation.querySelector<HTMLElement>('[data-timeline-entry-index="1"]')!;
    const last = navigation.querySelector<HTMLElement>('[data-timeline-entry-index="2"]')!;
    await act(async () => {
      middle.focus();
      fireEvent.keyDown(middle, { key: 'ArrowLeft' });
      await Promise.resolve();
    });
    expect(last).toHaveFocus();
    await act(async () => {
      fireEvent.keyDown(last, { key: 'ArrowUp' });
      await Promise.resolve();
    });
    expect(middle).toHaveFocus();
    await act(async () => {
      fireEvent.keyDown(middle, { key: 'ArrowRight' });
      await Promise.resolve();
    });
    expect(first).toHaveFocus();
  });

  it('marks the bounded message viewport on the proportional ruler', () => {
    render(
      <ConversationTimelineRail
        conversationId='long-conversation'
        timeline={timeline(3)}
        activeMessageId='message-1'
        visibleEntryRange={{ start: 1, end: 2 }}
        onJump={vi.fn()}
      />,
    );

    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    const first = navigation.querySelector<HTMLElement>('[data-timeline-entry-index="0"]')!;
    const middle = navigation.querySelector<HTMLElement>('[data-timeline-entry-index="1"]')!;
    const last = navigation.querySelector<HTMLElement>('[data-timeline-entry-index="2"]')!;
    expect(first).not.toHaveAttribute('data-in-viewport');
    expect(middle).toHaveAttribute('data-in-viewport', 'true');
    expect(middle).toHaveAttribute('aria-current', 'location');
    expect(last).toHaveAttribute('data-in-viewport', 'true');
    expect(screen.getByTestId('conversation-timeline-track')).toHaveStyle({ insetBlock: '8px' });
    expect(screen.getByTestId('conversation-timeline-visible-window')).toHaveStyle({
      insetBlockStart: '24px',
      height: '48px',
    });
  });

  it('recentres a same-revision marker page around the exact active message after it slides away', async () => {
    const onJump = vi.fn();
    const onLoadAround = vi.fn().mockResolvedValue(undefined);
    const tailPage = timeline(50, 50, 100);
    const firstPage = timeline(50, 0, 100);
    const { rerender } = render(
      <ConversationTimelineRail
        conversationId='long-conversation'
        timeline={tailPage}
        activeMessageId='message-99'
        onJump={onJump}
        onLoadAround={onLoadAround}
      />,
    );
    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    await waitFor(() => {
      expect(navigation.scrollTop).toBeGreaterThan(0);
    });

    navigation.scrollTop = 0;
    rerender(
      <ConversationTimelineRail
        conversationId='long-conversation'
        timeline={firstPage}
        activeMessageId='message-99'
        onJump={onJump}
        onLoadAround={onLoadAround}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onLoadAround).toHaveBeenCalledWith(99, 'revision-1', expect.any(AbortSignal));
    });
    expect(navigation.querySelector('[aria-current="location"]')).toBeNull();
  });

  it('retains only one active marker while traversing thousands of same-revision pages', () => {
    const identity = 'long-conversation\u0000revision-1';
    let retained = retainActiveTimelineMessageEntry(undefined, identity, 'message-49', timeline(50, 0, 100_000).items);
    for (let start = 50; start < 100_000; start += 50) {
      retained = retainActiveTimelineMessageEntry(retained, identity, 'message-49', timeline(50, start, 100_000).items);
    }
    expect(retained).toEqual({ identity, messageId: 'message-49', entryIndex: 49 });
    expect(Object.keys(retained ?? {})).toHaveLength(3);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(retainActiveTimelineMessageEntry(retained, 'long-conversation\u0000revision-2', 'message-49', [])).toBeUndefined();
  });

  it('keeps a compaction summary discoverable in the narrow timeline surface', async () => {
    const summary = 'This summary represents older compacted context without loading the full transcript.';
    const onJump = vi.fn();
    const page: ConversationTimelinePageSuccess = {
      ...timeline(2),
      items: [compactionEntry(0, summary), timelineEntry(1)],
    };
    render(<ConversationTimelineRail conversationId='long-conversation' timeline={page} onJump={onJump} />);

    fireEvent.click(screen.getByTestId('compact-conversation-timeline'));
    const compactLabel = await screen.findByText('4 earlier messages compacted', { selector: 'span' });
    fireEvent.click(compactLabel.closest('button')!);

    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ kind: 'compaction', entryId: 'compaction-0' }));
    expect(await screen.findByTestId('compact-compaction-summary')).toHaveTextContent(summary);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveStyle({ minHeight: '44px' });
  });

  it('shows each user and assistant message as its own exact touch marker', async () => {
    const page = { ...timeline(2), items: [timelineEntry(0), timelineEntry(1, 'assistant', 'message-0')] };
    render(<ConversationTimelineRail conversationId='long-conversation' timeline={page} onJump={vi.fn()} />);
    const compactButton = screen.getByTestId('compact-conversation-timeline');
    expect(compactButton).toHaveStyle({ minWidth: '44px', minHeight: '44px' });
    fireEvent.click(compactButton);
    expect(await screen.findByText('User prompt 0')).toBeInTheDocument();
    expect(screen.getByText('Assistant reply 1')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /message/u })).toHaveLength(2);
  });

  it('jumps with the exact per-message identity rather than an aggregated turn', async () => {
    const onJump = vi.fn();
    const page = { ...timeline(2), items: [timelineEntry(0), timelineEntry(1, 'agent', 'message-0')] };
    render(<ConversationTimelineRail conversationId='long-conversation' timeline={page} onJump={onJump} />);
    const marker = screen.getByRole('button', { name: 'agent message 2 of 2' });
    expect(marker).toHaveAttribute('data-timeline-message-id', 'message-1');
    fireEvent.click(marker);
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message', messageId: 'message-1', turnId: 'message-0' }));
  });

  it('exposes a bounded exact message preview, actor, and host-formatted time on marker focus', async () => {
    const page = timeline(1);
    page.items = [{
      ...timelineEntry(0),
      preview: `Remember this location ${'x'.repeat(200)}`,
    }];
    render(
      <ConversationTimelineRail
        conversationId='long-conversation'
        timeline={page}
        formatTimestamp={() => 'August 26, 2026 at 12:34'}
        onJump={vi.fn()}
      />,
    );

    const marker = screen.getByRole('button', { name: 'user message 1 of 1' });
    act(() => {
      marker.focus();
    });
    expect(await screen.findByText('August 26, 2026 at 12:34')).toBeInTheDocument();
    const prompt = screen.getByText(/^Remember this location x+…$/u);
    expect(prompt.textContent).toHaveLength(121);
    expect(screen.getByText('User')).toBeInTheDocument();
  });

  it('starts a tail window at the newest timeline marker and keeps long content top-reachable', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function(this: HTMLElement) {
      return this.dataset.timelineEntryIndex === '119' ? 119 * 24 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) {
      return this.dataset.testid === 'conversation-timeline' ? 320 : 400;
    });
    render(
      <div style={{ width: 320, height: 400 }}>
        <AgentChatView
          adapter={adapter([message('message-119')], {
            timeline: timeline(50, 70, 120),
            hasMoreBefore: true,
            hasMoreAfter: false,
          })}
        />
      </div>,
    );

    const chat = screen.getByTestId('memeloop-agent-chat');
    const viewport = screen.getByTestId('conversation-viewport');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'user message 120 of 120' })).toHaveAttribute('aria-current', 'location');
      expect(screen.getByTestId('conversation-timeline').scrollTop).toBeGreaterThan(0);
    });
    expect(getComputedStyle(viewport).justifyContent).toBe('flex-start');
    expect(getComputedStyle(chat).minWidth).toMatch(/^0(?:px)?$/);
    expect(getComputedStyle(chat).containerName).toBe('memeloop-chat');
  });

  it('scrolls only the local conversation viewport after loadAround', async () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      const top = this.dataset.memeloopMessageId === 'message-0'
        ? 320
        : this.dataset.testid === 'conversation-viewport'
        ? 100
        : 0;
      return { top, left: 0, right: 100, bottom: top + 20, width: 100, height: 20, x: 0, y: top, toJSON: () => ({}) };
    });

    function Harness() {
      const [messages, setMessages] = useState<readonly ConversationMessageListProjection[]>([message('message-2')]);
      const chatAdapter = useMemo(() =>
        adapter(messages, {
          timeline: timeline(3),
          hasMoreBefore: true,
          hasMoreAfter: false,
          loadAround: async (messageId) => {
            setMessages([message(messageId)]);
          },
        }), [messages]);
      return <AgentChatView adapter={chatAdapter} />;
    }

    render(<Harness />);
    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    navigation.scrollTop = 0;
    fireEvent.scroll(navigation);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'user message 1 of 3' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'user message 1 of 3' }));

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 212, behavior: 'smooth' });
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('retries bounded reveal focus while a virtualized host settles', async () => {
    function Harness() {
      const [messages, setMessages] = useState<readonly ConversationMessageListProjection[]>([message('message-2')]);
      const chatAdapter = useMemo(() =>
        adapter(messages, {
          timeline: timeline(3),
          hasMoreBefore: true,
          hasMoreAfter: false,
          loadAround: async (turnId) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  setMessages([message(turnId)]);
                });
              });
            });
          },
        }), [messages]);
      return <AgentChatView adapter={chatAdapter} />;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'user message 1 of 3' }));
    await waitFor(() => {
      expect(document.querySelector('[data-memeloop-message-id="message-0"]')).toHaveFocus();
    });
  });

  it('focuses an already resident turn without a redundant bounded-window request', async () => {
    const loadAround = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentChatView
        adapter={adapter([message('message-0')], {
          timeline: timeline(1),
          loadAround,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'user message 1 of 1' }));
    await waitFor(() => {
      expect(document.querySelector('[data-memeloop-message-id="message-0"]')).toHaveFocus();
    });
    expect(loadAround).not.toHaveBeenCalled();
  });

  it('focuses the resolved nearest turn after a compaction seek', async () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      const top = this.dataset.memeloopMessageId === 'message-10'
        ? 280
        : this.dataset.testid === 'conversation-viewport'
        ? 100
        : 0;
      return { top, left: 0, right: 100, bottom: top + 20, width: 100, height: 20, x: 0, y: top, toJSON: () => ({}) };
    });
    const page: ConversationTimelinePageSuccess = {
      ...timeline(2),
      items: [compactionEntry(0), timelineEntry(1)],
    };
    function Harness() {
      const [resolved, setResolved] = useState(false);
      const resolvedMessage = { ...message('message-10'), turnId: 'resolved-turn' };
      return (
        <AgentChatView
          adapter={adapter(resolved ? [resolvedMessage] : [message('message-1')], {
            timeline: page,
            windowAnchorTurnId: resolved ? 'resolved-turn' : undefined,
            windowAnchorMessageId: resolved ? resolvedMessage.messageId : undefined,
            loadAroundTimelineEntry: async () => {
              setResolved(true);
            },
          })}
        />
      );
    }
    render(<Harness />);
    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    fireEvent.click(within(navigation).getByRole('button', { name: '4 earlier messages compacted' }));
    await waitFor(() => {
      expect(document.querySelector('[data-memeloop-message-id="message-10"]')).toHaveFocus();
      expect(scrollTo).toHaveBeenCalledWith({ top: 172, behavior: 'smooth' });
    });
  });

  it('coalesces repeated scroll events without re-querying every message', async () => {
    render(
      <AgentChatView
        adapter={adapter([message('message-0'), message('message-1', 'assistant')], {
          timeline: timeline(2),
        })}
      />,
    );
    const viewport = screen.getByTestId('conversation-viewport');
    await waitFor(() => {
      expect(screen.getByTestId('conversation-timeline')).toBeInTheDocument();
    });
    const querySelectorAll = vi.spyOn(viewport, 'querySelectorAll');
    await act(async () => {
      await new Promise(resolve =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve(undefined);
          })
        )
      );
    });
    querySelectorAll.mockClear();
    for (let index = 0; index < 30; index += 1) fireEvent.scroll(viewport);
    await act(async () => {
      await new Promise(resolve =>
        requestAnimationFrame(() => {
          resolve(undefined);
        })
      );
    });
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it('projects the visible message window onto timeline markers from the cached anchors', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function(this: HTMLElement) {
      if (this.dataset.memeloopMessageId === 'message-0') return 0;
      if (this.dataset.memeloopMessageId === 'message-2') return 100;
      if (this.dataset.memeloopMessageId === 'message-4') return 200;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) {
      return this.dataset.testid === 'conversation-viewport' ? 120 : 320;
    });
    const page = timeline(3);
    page.items = page.items.map((entry, index) => ({
      ...entry,
      entryId: `message-${index * 2}`,
      messageId: `message-${index * 2}`,
      turnId: `message-${index * 2}`,
    })) as ConversationTimelineMessageEntry[];
    render(
      <AgentChatView
        adapter={adapter([
          message('message-0'),
          message('message-2'),
          message('message-4'),
        ], { timeline: page })}
      />,
    );

    const viewport = screen.getByTestId('conversation-viewport');
    viewport.scrollTop = 125;
    fireEvent.scroll(viewport);
    const navigation = screen.getByRole('navigation', { name: 'Conversation timeline' });
    await waitFor(() => {
      expect(navigation.querySelector('[data-timeline-entry-index="1"]')).toHaveAttribute('aria-current', 'location');
    });
    expect(navigation.querySelector('[data-timeline-entry-index="0"]')).not.toHaveAttribute('data-in-viewport');
    expect(navigation.querySelector('[data-timeline-entry-index="1"]')).toHaveAttribute('data-in-viewport', 'true');
    expect(navigation.querySelector('[data-timeline-entry-index="2"]')).toHaveAttribute('data-in-viewport', 'true');
  });

  it('shows pending live-tail messages and delegates a single jump', async () => {
    const jumpToLatest = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentChatView
        adapter={adapter([message('message-0')], {
          isAtLiveTail: false,
          pendingNewMessageCount: 7,
          jumpToLatest,
        })}
        timelineLabels={{ newMessages: count => `${count} unread` }}
      />,
    );

    const viewport = screen.getByTestId('conversation-viewport');
    viewport.scrollTop = 0;
    const pending = screen.getByRole('button', { name: '7 unread' });
    expect(pending.parentElement).not.toBe(viewport);
    expect(pending).toHaveStyle({ position: 'absolute', minHeight: '44px' });
    fireEvent.click(pending);
    await waitFor(() => {
      expect(jumpToLatest).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces caught paging failures instead of creating an unhandled rejection', async () => {
    render(
      <AgentChatView
        adapter={adapter([message('message-1')], {
          hasMoreBefore: true,
          loadMoreBefore: vi.fn().mockRejectedValue(new Error('paging offline')),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByTestId('chat-operation-error')).toHaveTextContent('The operation could not be completed.');
    expect(screen.getByTestId('chat-operation-error')).not.toHaveTextContent('paging offline');
  });

  it('does not let a settled request from conversation A unlock an in-flight request for B', async () => {
    let resolveA!: () => void;
    let resolveB!: () => void;
    const requestA = new Promise<void>(resolve => {
      resolveA = resolve;
    });
    const requestB = new Promise<void>(resolve => {
      resolveB = resolve;
    });
    const loadA = vi.fn(() => requestA);
    const loadB = vi.fn(() => requestB);
    const { rerender } = render(
      <AgentChatView adapter={adapter([message('message-1')], { conversationId: 'A', hasMoreBefore: true, loadMoreBefore: loadA })} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(loadA).toHaveBeenCalledTimes(1);
    rerender(
      <AgentChatView adapter={adapter([message('message-2')], { conversationId: 'B', hasMoreBefore: true, loadMoreBefore: loadB })} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(loadB).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveA();
      await requestA;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(loadB).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveB();
      await requestB;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => {
      expect(loadB).toHaveBeenCalledTimes(2);
    });
  });
});

describe('controlled composer attachments', () => {
  function AttachmentHarness({ sendMessage }: { sendMessage: WebMemeLoopChatAdapter['sendMessage'] }) {
    const [file, setFile] = useState<File | undefined>(() => new File(['notes'], 'notes.txt'));
    const [wikiTiddlers, setWikiTiddlers] = useState([
      { workspaceName: 'Test Wiki', tiddlerTitle: 'Design' },
    ]);
    const chatAdapter = useMemo(() => adapter([], { sendMessage }), [sendMessage]);
    return (
      <AgentChatView
        adapter={chatAdapter}
        selectedFile={file}
        selectedWikiTiddlers={wikiTiddlers}
        onFileSelect={setFile}
        onClearAttachments={() => {
          setFile(undefined);
          setWikiTiddlers([]);
        }}
      />
    );
  }

  it('clears host-controlled attachments after a successful send', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    render(<AttachmentHarness sendMessage={sendMessage} />);

    fireEvent.change(screen.getByTestId('agent-message-input'), { target: { value: 'Use these' } });
    fireEvent.click(screen.getByTestId('agent-send-button'));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: 'Use these',
        file: expect.objectContaining({ name: 'notes.txt' }),
        wikiTiddlers: [{ workspaceName: 'Test Wiki', tiddlerTitle: 'Design' }],
      }));
      expect(screen.queryByTestId('attachment-preview')).not.toBeInTheDocument();
      expect(screen.queryByTestId('wiki-tiddler-chip-0')).not.toBeInTheDocument();
    });
  });

  it('preserves host-controlled attachments when sending fails', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('offline'));
    render(<AttachmentHarness sendMessage={sendMessage} />);

    fireEvent.change(screen.getByTestId('agent-message-input'), { target: { value: 'Try later' } });
    fireEvent.click(screen.getByTestId('agent-send-button'));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('attachment-preview')).toHaveTextContent('notes.txt');
    expect(screen.getByTestId('wiki-tiddler-chip-0')).toHaveTextContent('Test Wiki: Design');
  });

  it('snapshots ephemeral drop data before awaiting the host and commits once atomically', async () => {
    let livePayload = 'Original Tiddler';
    let continueResolution!: () => void;
    let observedSnapshot: import('../chat/types.js').DroppedAttachmentSnapshot | undefined;
    const gate = new Promise<void>(resolve => {
      continueResolution = resolve;
    });
    const resolveDroppedWikiTiddlers = vi.fn(async snapshot => {
      observedSnapshot = snapshot;
      await gate;
      return [{ workspaceName: 'Test Wiki', tiddlerTitle: snapshot.stringData['text/vnd.tiddlywiki']! }];
    });
    const onAttachmentsSelect = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentChatView
        adapter={adapter([])}
        resolveDroppedWikiTiddlers={resolveDroppedWikiTiddlers}
        onAttachmentsSelect={onAttachmentsSelect}
      />,
    );
    const dataTransfer = {
      files: [],
      types: ['text/vnd.tiddlywiki'],
      getData: () => livePayload,
    } as unknown as DataTransfer;

    fireEvent.drop(screen.getByTestId('memeloop-agent-chat'), { dataTransfer });
    livePayload = 'Mutated after drop';
    expect(resolveDroppedWikiTiddlers).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(observedSnapshot)).toBe(true);
    expect(Object.isFrozen(observedSnapshot?.files)).toBe(true);
    expect(Object.isFrozen(observedSnapshot?.stringData)).toBe(true);
    continueResolution();

    await waitFor(() => {
      expect(onAttachmentsSelect).toHaveBeenCalledTimes(1);
    });
    expect(onAttachmentsSelect).toHaveBeenCalledWith(
      { wikiTiddlers: [{ workspaceName: 'Test Wiki', tiddlerTitle: 'Original Tiddler' }] },
      { conversationId: 'long-conversation', signal: expect.any(AbortSignal) },
    );
    const [committed, context] = onAttachmentsSelect.mock.calls[0];
    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed.wikiTiddlers)).toBe(true);
    expect(Object.isFrozen(committed.wikiTiddlers[0])).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
    expect(context.signal.aborted).toBe(false);
  });

  it('supports an atomic-only picker and serializes file then tiddler commits against the latest batch', async () => {
    let resolveFileCommit!: () => void;
    const fileCommit = new Promise<void>(resolve => {
      resolveFileCommit = resolve;
    });
    const onAttachmentsSelect = vi.fn()
      .mockImplementationOnce(() => fileCommit)
      .mockResolvedValue(undefined);
    render(
      <AgentChatView
        adapter={adapter([])}
        onAttachmentsSelect={onAttachmentsSelect}
        renderAttachmentPicker={controls => (
          <>
            <button type='button' onClick={controls.openFilePicker}>Pick file</button>
            <button
              type='button'
              onClick={() => {
                controls.selectWikiTiddler({ workspaceName: ' Wiki ', tiddlerTitle: ' Design ' });
              }}
            >
              Pick tiddler
            </button>
          </>
        )}
      />,
    );
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('agent-file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Pick tiddler' }));

    await waitFor(() => {
      expect(onAttachmentsSelect).toHaveBeenCalledTimes(1);
    });
    expect(onAttachmentsSelect).toHaveBeenNthCalledWith(
      1,
      { file, wikiTiddlers: [] },
      { conversationId: 'long-conversation', signal: expect.any(AbortSignal) },
    );
    await act(async () => {
      resolveFileCommit();
      await fileCommit;
    });
    await waitFor(() => {
      expect(onAttachmentsSelect).toHaveBeenCalledTimes(2);
    });
    expect(onAttachmentsSelect).toHaveBeenNthCalledWith(
      2,
      { file, wikiTiddlers: [{ workspaceName: 'Wiki', tiddlerTitle: 'Design' }] },
      { conversationId: 'long-conversation', signal: expect.any(AbortSignal) },
    );
  });

  it('lets a new conversation select immediately while fencing an older pending commit', async () => {
    let resolveA!: () => void;
    let resolveB!: () => void;
    const pendingA = new Promise<void>(resolve => {
      resolveA = resolve;
    });
    const pendingB = new Promise<void>(resolve => {
      resolveB = resolve;
    });
    const onAttachmentsSelect = vi.fn()
      .mockImplementationOnce(() => pendingA)
      .mockImplementationOnce(() => pendingB)
      .mockResolvedValue(undefined);
    const renderPicker = (controls: import('../chat/types.js').AttachmentPickerControls) => (
      <button
        type='button'
        onClick={() => {
          controls.selectWikiTiddler({ workspaceName: 'Wiki', tiddlerTitle: 'After switch' });
        }}
      >
        Pick tiddler
      </button>
    );
    const rendered = render(
      <AgentChatView
        adapter={adapter([], { conversationId: 'conversation-A' })}
        onAttachmentsSelect={onAttachmentsSelect}
        renderAttachmentPicker={renderPicker}
      />,
    );
    const fileA = new File(['A'], 'A.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('agent-file-input'), { target: { files: [fileA] } });
    await waitFor(() => {
      expect(onAttachmentsSelect).toHaveBeenCalledTimes(1);
    });
    const signalA = onAttachmentsSelect.mock.calls[0]?.[1].signal as AbortSignal;

    rendered.rerender(
      <AgentChatView
        adapter={adapter([], { conversationId: 'conversation-B' })}
        onAttachmentsSelect={onAttachmentsSelect}
        renderAttachmentPicker={renderPicker}
      />,
    );
    expect(signalA.aborted).toBe(true);
    const fileB = new File(['B'], 'B.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('agent-file-input'), { target: { files: [fileB] } });
    await waitFor(() => {
      expect(onAttachmentsSelect).toHaveBeenCalledTimes(2);
    });
    const signalB = onAttachmentsSelect.mock.calls[1]?.[1].signal as AbortSignal;
    expect(signalB.aborted).toBe(false);

    await act(async () => {
      resolveA();
      await pendingA;
      resolveB();
      await pendingB;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pick tiddler' }));
    await waitFor(() => {
      expect(onAttachmentsSelect).toHaveBeenCalledTimes(3);
    });
    expect(onAttachmentsSelect.mock.calls[2]?.[0]).toEqual({
      file: fileB,
      wikiTiddlers: [{ workspaceName: 'Wiki', tiddlerTitle: 'After switch' }],
    });
  });

  it('rejects a mixed invalid drop batch without partially committing it', async () => {
    const onAttachmentsSelect = vi.fn();
    const onError = vi.fn();
    render(
      <AgentChatView
        adapter={adapter([], { onError })}
        resolveDroppedWikiTiddlers={() => [
          { workspaceName: 'Test Wiki', tiddlerTitle: 'Valid' },
          { workspaceName: 'Test Wiki', tiddlerTitle: 'Invalid\u0000Title' },
        ]}
        onAttachmentsSelect={onAttachmentsSelect}
      />,
    );

    fireEvent.drop(screen.getByTestId('memeloop-agent-chat'), {
      dataTransfer: { files: [], types: ['text/plain'], getData: () => 'drop' },
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'attachment-invalid-tiddler-title' }),
        'resolve-dropped-attachments',
      );
    });
    expect(screen.getByTestId('chat-operation-error')).toHaveTextContent('The operation could not be completed.');
    expect(screen.getByTestId('chat-operation-error')).not.toHaveTextContent('Invalid\u0000Title');
    expect(onAttachmentsSelect).not.toHaveBeenCalled();
  });

  it('canonicalizes every dropped tiddler before the one atomic commit', async () => {
    const onAttachmentsSelect = vi.fn();
    render(
      <AgentChatView
        adapter={adapter([])}
        resolveDroppedWikiTiddlers={() => [{ workspaceName: '  Test Wiki  ', tiddlerTitle: '  Design  ' }]}
        onAttachmentsSelect={onAttachmentsSelect}
      />,
    );

    fireEvent.drop(screen.getByTestId('memeloop-agent-chat'), {
      dataTransfer: { files: [], types: ['text/plain'], getData: () => 'drop' },
    });

    await waitFor(() => {
      expect(onAttachmentsSelect).toHaveBeenCalledTimes(1);
    });
    expect(onAttachmentsSelect).toHaveBeenCalledWith(
      { wikiTiddlers: [{ workspaceName: 'Test Wiki', tiddlerTitle: 'Design' }] },
      { conversationId: 'long-conversation', signal: expect.any(AbortSignal) },
    );
  });

  it('aborts a stale drop resolver and commits nothing after switching conversations', async () => {
    let resolveDrop!: (value: readonly WikiTiddlerAttachment[]) => void;
    let resolverSignal: AbortSignal | undefined;
    const pending = new Promise<readonly WikiTiddlerAttachment[]>(resolve => {
      resolveDrop = resolve;
    });
    const resolveDroppedWikiTiddlers = vi.fn((_snapshot, context) => {
      resolverSignal = context.signal;
      return pending;
    });
    const onAttachmentsSelect = vi.fn();
    const onError = vi.fn();
    const rendered = render(
      <AgentChatView
        adapter={adapter([], { conversationId: 'conversation-A', onError })}
        resolveDroppedWikiTiddlers={resolveDroppedWikiTiddlers}
        onAttachmentsSelect={onAttachmentsSelect}
      />,
    );

    fireEvent.drop(screen.getByTestId('memeloop-agent-chat'), {
      dataTransfer: { files: [], types: ['text/plain'], getData: () => 'drop' },
    });
    expect(resolveDroppedWikiTiddlers).toHaveBeenCalledWith(
      expect.any(Object),
      { conversationId: 'conversation-A', signal: expect.any(AbortSignal) },
    );
    rendered.rerender(
      <AgentChatView
        adapter={adapter([], { conversationId: 'conversation-B', onError })}
        resolveDroppedWikiTiddlers={resolveDroppedWikiTiddlers}
        onAttachmentsSelect={onAttachmentsSelect}
      />,
    );
    expect(resolverSignal?.aborted).toBe(true);
    resolveDrop([{ workspaceName: 'Wiki', tiddlerTitle: 'Stale' }]);
    await act(async () => {
      await pending;
      await Promise.resolve();
    });
    expect(onAttachmentsSelect).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects canonically duplicate titles and excessive drop data types without reading or committing them', async () => {
    const onAttachmentsSelect = vi.fn();
    const onError = vi.fn();
    const getData = vi.fn(() => 'payload');
    const { rerender } = render(
      <AgentChatView
        adapter={adapter([], { onError })}
        resolveDroppedWikiTiddlers={() => [
          { workspaceName: ' Test Wiki ', tiddlerTitle: ' Design ' },
          { workspaceName: 'Test Wiki', tiddlerTitle: 'Design' },
        ]}
        onAttachmentsSelect={onAttachmentsSelect}
      />,
    );

    fireEvent.drop(screen.getByTestId('memeloop-agent-chat'), {
      dataTransfer: { files: [], types: ['text/plain'], getData },
    });
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'attachment-duplicate' }), 'resolve-dropped-attachments');
    });
    expect(onAttachmentsSelect).not.toHaveBeenCalled();

    onError.mockClear();
    getData.mockClear();
    rerender(
      <AgentChatView
        adapter={adapter([], { onError })}
        resolveDroppedWikiTiddlers={() => []}
        onAttachmentsSelect={onAttachmentsSelect}
      />,
    );
    fireEvent.drop(screen.getByTestId('memeloop-agent-chat'), {
      dataTransfer: { files: [], types: Array.from({ length: 17 }, (_, index) => `application/x-hostile-${index}`), getData },
    });
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'attachment-count-exceeded' }), 'resolve-dropped-attachments');
    });
    expect(getData).not.toHaveBeenCalled();
    expect(onAttachmentsSelect).not.toHaveBeenCalled();
  });

  it('does not commit when the host drop resolver rejects', async () => {
    const onAttachmentsSelect = vi.fn();
    const onError = vi.fn();
    render(
      <AgentChatView
        adapter={adapter([], { onError })}
        resolveDroppedWikiTiddlers={vi.fn().mockRejectedValue(new Error('host resolver failed'))}
        onAttachmentsSelect={onAttachmentsSelect}
      />,
    );

    fireEvent.drop(screen.getByTestId('memeloop-agent-chat'), {
      dataTransfer: { files: [], types: ['text/plain'], getData: () => 'drop' },
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'host resolver failed' }),
        'resolve-dropped-attachments',
      );
    });
    expect(onAttachmentsSelect).not.toHaveBeenCalled();
  });
});
