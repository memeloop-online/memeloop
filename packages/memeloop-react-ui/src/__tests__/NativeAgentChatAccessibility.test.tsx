import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChatMessage } from 'memeloop';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemeLoopChatAdapter, MemeLoopTimelineTurnEntry } from '../chat/coreTypes.js';
import { NativeAgentChatView } from '../native/AgentChatView.js';

const nativeCapture = vi.hoisted(() => ({
  dimensions: { width: 1_024, height: 768, scale: 1, fontScale: 1 },
  giftedMessageCount: 0,
  isRTL: false,
  styles: [] as unknown[],
  timelineEntryCount: 0,
}));

const themeColors = vi.hoisted(() => ({
  backdrop: 'paper-backdrop',
  error: 'paper-error',
  inverseOnSurface: 'paper-inverse-on-surface',
  inverseSurface: 'paper-inverse-surface',
  onPrimary: 'paper-on-primary',
  onPrimaryContainer: 'paper-on-primary-container',
  onSurface: 'paper-on-surface',
  onSurfaceVariant: 'paper-on-surface-variant',
  outline: 'paper-outline',
  primary: 'paper-primary',
  primaryContainer: 'paper-primary-container',
  surface: 'paper-surface',
  surfaceVariant: 'paper-surface-variant',
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const recordStyle = (style: unknown): string | undefined => {
    nativeCapture.styles.push(style);
    return style === undefined ? undefined : JSON.stringify(style);
  };
  const View = ({ children, style }: { children?: React.ReactNode; style?: unknown }) => ReactModule.createElement('div', { 'data-native-style': recordStyle(style) }, children);
  const Text = ({ children, numberOfLines, style }: { children?: React.ReactNode; numberOfLines?: number; style?: unknown }) =>
    ReactModule.createElement('span', {
      'data-native-style': recordStyle(style),
      'data-number-of-lines': numberOfLines,
    }, children);
  const Pressable = ({
    accessibilityLabel,
    accessibilityState,
    children,
    disabled,
    onPress,
    style,
  }: {
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
    children?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    style?: unknown;
  }) =>
    ReactModule.createElement('button', {
      'aria-label': accessibilityLabel,
      'aria-pressed': accessibilityState?.selected,
      'data-native-style': recordStyle(style),
      disabled,
      onClick: onPress,
      type: 'button',
    }, children);
  const Modal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? ReactModule.createElement('div', { 'data-testid': 'native-modal' }, children) : null;
  const TextInput = ({ accessibilityLabel, style }: { accessibilityLabel?: string; style?: unknown }) =>
    ReactModule.createElement('input', { 'aria-label': accessibilityLabel, 'data-native-style': recordStyle(style) });
  const FlatList = <ItemT,>({ data, ListFooterComponent, ListHeaderComponent, renderItem }: {
    data: readonly ItemT[];
    ListFooterComponent?: React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    renderItem: (info: { item: ItemT; index: number }) => React.ReactNode;
  }) => {
    nativeCapture.timelineEntryCount = data.length;
    return ReactModule.createElement(
      ReactModule.Fragment,
      undefined,
      ListHeaderComponent,
      ...data.map((item, index) => ReactModule.createElement(ReactModule.Fragment, { key: index }, renderItem({ item, index }))),
      ListFooterComponent,
    );
  };
  return {
    FlatList,
    I18nManager: {
      get isRTL() {
        return nativeCapture.isRTL;
      },
    },
    Modal,
    Pressable,
    Text,
    TextInput,
    useWindowDimensions: () => nativeCapture.dimensions,
    View,
  };
});

vi.mock('react-native-paper', () => ({
  useTheme: () => ({ colors: themeColors }),
}));

vi.mock('react-native-gifted-chat', async () => {
  const ReactModule = await import('react');
  return {
    GiftedChat: ({ messages }: { messages: readonly unknown[] }) => {
      nativeCapture.giftedMessageCount = messages.length;
      return ReactModule.createElement('div', { 'data-testid': 'gifted-chat' });
    },
  };
});

const genericErrorPresentation = { title: 'Operation failed', message: 'Try again.' };

function message(index: number): ChatMessage {
  return {
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    conversationId: 'long-chat',
    originNodeId: 'node',
    originSequence: index + 1,
    timestamp: index,
    lamportClock: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
  };
}

function timelineEntry(index: number): MemeLoopTimelineTurnEntry {
  return {
    kind: 'turn',
    entryId: `entry-${index}`,
    conversationId: 'long-chat',
    cursor: `cursor-${index}`,
    timestamp: 1_700_000_000_000 + index,
    lamportClock: index + 1,
    originNodeId: 'node',
    entryIndex: index,
    turnIndex: index,
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    userPreview: `remember ${index}`,
    participantPreviews: [{
      actorId: 'reviewer',
      actorLabel: 'Reviewer',
      role: 'agent',
      preview: `response ${index}`,
    }],
    responseCount: 3,
  };
}

function adapter(messages: readonly ChatMessage[], entries: readonly MemeLoopTimelineTurnEntry[]): MemeLoopChatAdapter {
  return {
    conversationId: 'long-chat',
    messages,
    timeline: {
      reset: false,
      items: entries,
      revision: 'revision-1',
      totalMessages: 1_000_000,
      totalTurns: 1_000_000,
      totalEntries: 1_000_000,
    },
    isRunning: false,
    isLoading: false,
    error: null,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    deleteTurn: vi.fn().mockResolvedValue(undefined),
    retryTurn: vi.fn().mockResolvedValue(undefined),
    executionTargets: [
      { id: 'local', label: 'Local' },
      { id: 'remote', label: 'Remote', kind: 'remote' },
    ],
    activeExecutionTargetId: 'local',
    setExecutionTarget: vi.fn().mockResolvedValue(undefined),
  };
}

function renderNative(chatAdapter: MemeLoopChatAdapter): ReturnType<typeof render> {
  return render(
    <NativeAgentChatView
      adapter={chatAdapter}
      labels={{ timelineTimestamp: timestamp => `When ${timestamp}` }}
      resolveErrorPresentation={() => null}
      genericErrorPresentation={genericErrorPresentation}
    />,
  );
}

describe('NativeAgentChatView timeline accessibility', () => {
  beforeEach(() => {
    nativeCapture.dimensions = { width: 1_024, height: 768, scale: 1, fontScale: 1 };
    nativeCapture.giftedMessageCount = 0;
    nativeCapture.isRTL = false;
    nativeCapture.styles.length = 0;
    nativeCapture.timelineEntryCount = 0;
  });

  it('uses logical RTL layout, Paper semantic colors and large-text-safe wrapping', () => {
    nativeCapture.isRTL = true;
    nativeCapture.dimensions = { width: 320, height: 640, scale: 2, fontScale: 2 };
    renderNative(adapter([message(0)], [timelineEntry(0)]));

    const navigation = screen.getByRole('button', { name: 'Conversation timeline: Turn 1 of 1000000' });
    const navigationStyle = JSON.parse(navigation.getAttribute('data-native-style') ?? '{}') as Record<string, unknown>;
    expect(navigationStyle).toMatchObject({ start: 4, maxWidth: 132, minHeight: 44, backgroundColor: themeColors.inverseSurface });
    expect(navigationStyle).not.toHaveProperty('left');
    expect(navigationStyle).not.toHaveProperty('right');

    fireEvent.click(navigation);
    expect(nativeCapture.styles).toContainEqual(expect.objectContaining({
      flexDirection: 'row-reverse',
      flexWrap: 'wrap',
    }));
    expect(nativeCapture.styles).toContainEqual(expect.objectContaining({
      backgroundColor: themeColors.surface,
      borderTopEndRadius: 16,
      borderTopStartRadius: 16,
      maxHeight: '85%',
    }));
    expect(nativeCapture.styles).toContainEqual(expect.objectContaining({
      backgroundColor: themeColors.primaryContainer,
      minHeight: 44,
    }));
    expect(screen.getByText('You: remember 0')).not.toHaveAttribute('data-number-of-lines');
  });

  it('announces and displays timestamp, user, participants and omitted responses', () => {
    renderNative(adapter([message(0)], [timelineEntry(0)]));
    fireEvent.click(screen.getByRole('button', { name: 'Conversation timeline: Turn 1 of 1000000' }));

    const rowLabel = 'Turn 1 of 1000000. When 1700000000000. You: remember 0. Reviewer: response 0. 2 more responses';
    const row = screen.getByRole('button', { name: rowLabel });
    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(row.getAttribute('data-native-style') ?? '{}')).toMatchObject({ minHeight: 44 });
    expect(screen.getByText('When 1700000000000')).toBeInTheDocument();
    expect(screen.getByText('You: remember 0')).toBeInTheDocument();
    expect(screen.getByText('Reviewer: response 0')).toBeInTheDocument();
    expect(screen.getByText('2 more responses')).toBeInTheDocument();
  });

  it('keeps native message and timeline views bounded for a million-entry conversation', () => {
    renderNative(adapter(
      Array.from({ length: 200 }, (_, index) => message(index)),
      Array.from({ length: 50 }, (_, index) => timelineEntry(index)),
    ));

    expect(nativeCapture.giftedMessageCount).toBe(50);
    fireEvent.click(screen.getByRole('button', { name: 'Conversation timeline: Turn 50 of 1000000' }));
    expect(nativeCapture.timelineEntryCount).toBe(50);
    expect(screen.getAllByRole('button', { name: /^Turn \d+ of 1000000\./u })).toHaveLength(50);
  });
});
