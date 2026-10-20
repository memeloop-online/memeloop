import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PromptPreviewAuditDetailChunk, PromptPreviewPreparedExecution } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NativePromptExecutionInspector } from '../native/PromptExecutionInspector.js';

const native = vi.hoisted(() => ({ back: undefined as (() => boolean) | undefined, os: 'android', remove: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  BackHandler: {
    addEventListener: (_event: string, callback: () => boolean) => {
      native.back = callback;
      return {
        remove: () => {
          native.back = undefined;
          native.remove();
        },
      };
    },
  },
  View: ({ children, testID, style, onKeyDown }: {
    children?: React.ReactNode;
    testID?: string;
    style?: React.CSSProperties;
    onKeyDown?: React.KeyboardEventHandler;
  }) => <div data-testid={testID} style={style} onKeyDown={onKeyDown}>{children}</div>,
  Text: ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => <span role={accessibilityRole}>{children}</span>,
  Pressable: ({ children, accessibilityRole, accessibilityState, testID, disabled, onPress }: {
    children?: React.ReactNode;
    accessibilityRole?: string;
    accessibilityState?: { expanded?: boolean };
    testID?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => <button role={accessibilityRole} aria-expanded={accessibilityState?.expanded} data-testid={testID} disabled={disabled} onClick={onPress}>{children}</button>,
}));
vi.mock('react-native-paper', () => ({ useTheme: () => ({ colors: {} }) }));

const audit: PromptPreviewPreparedExecution = {
  sessionId: 'session',
  revision: 'revision',
  route: { providerId: 'provider', logicalModelId: 'model', wireModelId: 'model', apiMode: 'responses' },
  contextStats: { messageCount: 2, compactionSummaryCount: 0 },
  initialPage: {
    sessionId: 'session',
    revision: 'revision',
    totalEntries: 2,
    hasMoreBefore: false,
    hasMoreAfter: false,
    sampled: false,
    items: [
      { entryId: 'system', entryIndex: 0, role: 'system', source: 'prompt', preview: 'Instruction text', canonicalBytes: 40, promptPath: [{ id: 'persona', caption: 'Persona' }] },
      { entryId: 'user', entryIndex: 1, role: 'user', source: 'preview-input', preview: 'Current text', canonicalBytes: 40 },
    ],
  },
};
const chunk: PromptPreviewAuditDetailChunk = {
  sessionId: 'session',
  revision: 'revision',
  target: { kind: 'request' },
  canonicalUtf8: new TextEncoder().encode('Late request detail'),
  complete: true,
};

describe('native prompt inspection navigation', () => {
  it('shows visible count and preserves sampled gaps in both tree and flat views', () => {
    const sampled = {
      ...audit,
      initialPage: {
        ...audit.initialPage,
        sampled: true,
        totalEntries: 200,
        hasMoreBefore: true,
        previousCursor: 'previous',
        items: [audit.initialPage.items[0], { ...audit.initialPage.items[1], entryIndex: 199 }],
      },
    };
    render(<NativePromptExecutionInspector audit={sampled} controller={{ getAuditPage: vi.fn(), getAuditDetail: vi.fn() }} />);
    expect(screen.getByText('2 / 200')).toBeVisible();
    expect(screen.getByText('… 2–199 …')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    expect(screen.getByText('… 2–199 …')).toBeVisible();
    expect(screen.getByText('Current text')).toBeVisible();
  });

  it('handles Android back while loading without refetching or losing collapsed tree state', async () => {
    native.os = 'android';
    let resolve!: (value: PromptPreviewAuditDetailChunk) => void;
    const controller = {
      getAuditPage: vi.fn(),
      getAuditDetail: vi.fn(() =>
        new Promise<PromptPreviewAuditDetailChunk>(done => {
          resolve = done;
        })
      ),
    };
    render(<NativePromptExecutionInspector audit={audit} controller={controller} />);
    fireEvent.click(screen.getByRole('button', { name: /Persona/ }));
    expect(screen.queryByText('Instruction text')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('prompt-entry-1'));
    expect(screen.getByTestId('prompt-preview-detail-back')).toBeEnabled();
    act(() => {
      expect(native.back?.()).toBe(true);
    });
    expect(screen.queryByTestId('prompt-preview-audit-detail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Persona/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Current text')).toBeVisible();
    await act(async () => {
      resolve(chunk);
    });
    expect(screen.queryByTestId('prompt-preview-audit-detail')).not.toBeInTheDocument();
    expect(controller.getAuditPage).not.toHaveBeenCalled();
    expect(native.back).toBeUndefined();
  });

  it('supports Escape on native web and back after a detail failure', async () => {
    native.os = 'web';
    const controller = { getAuditPage: vi.fn(), getAuditDetail: vi.fn().mockRejectedValueOnce(new Error('expired')).mockResolvedValueOnce(chunk) };
    render(<NativePromptExecutionInspector audit={audit} controller={controller} />);
    fireEvent.click(screen.getByTestId('prompt-preview-model-request-detail'));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByTestId('prompt-preview-detail-back'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('prompt-preview-model-request-detail'));
    await screen.findByText('Late request detail');
    fireEvent.keyDown(screen.getByTestId('prompt-preview-detail-back'), { key: 'Escape' });
    expect(screen.queryByTestId('prompt-preview-audit-detail')).not.toBeInTheDocument();
    expect(screen.getByText('Instruction text')).toBeVisible();
    expect(controller.getAuditPage).not.toHaveBeenCalled();
  });
});
