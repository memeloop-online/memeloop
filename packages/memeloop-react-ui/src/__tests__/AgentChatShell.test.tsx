import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { type ConversationMessageListProjection, createMissingApiKeyAgentRunError } from 'memeloop';
import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentChatShell } from '../agent/AgentChatShell.js';
import { resolveAgentRunErrorPresentation } from '../chat/agentRunErrorPresentation.js';
import type { WebMemeLoopChatAdapter } from '../chat/types.js';

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
});

function adapter(overrides: Partial<WebMemeLoopChatAdapter> = {}): WebMemeLoopChatAdapter {
  return {
    conversationId: 'conversation',
    messages: [],
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

function typedErrorMessage(): ConversationMessageListProjection {
  return {
    messageId: 'error-1',
    turnId: 'turn-1',
    conversationId: 'conversation',
    originNodeId: 'node-1',
    originSequence: 1,
    timestamp: 1,
    lamportClock: 1,
    role: 'error',
    content: 'raw provider body containing sk-secret',
    metadata: {
      agentRunError: createMissingApiKeyAgentRunError({ providerId: 'siliconflow', diagnosticId: 'diagnostic-1' }),
      errorDetail: { message: 'legacy raw error' },
    },
  };
}

describe('AgentChatShell', () => {
  const genericErrorPresentation = { title: 'Something went wrong', message: 'Try again.' };
  const resolveErrorPresentation = () => null;

  it('binds host title services and reports rejected async actions', async () => {
    const onError = vi.fn();
    render(
      <AgentChatShell
        adapter={adapter({ onError })}
        header={{ title: 'Conversation', onTitleChange: vi.fn().mockRejectedValue(new Error('rename failed')) }}
        resolveErrorPresentation={resolveErrorPresentation}
        genericErrorPresentation={genericErrorPresentation}
      />,
    );

    fireEvent.click(screen.getByText('Conversation'));
    const input = screen.getByRole('textbox', { name: 'Edit title' });
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'rename failed' }), 'rename-conversation');
    });
  });

  it('loads host attachment options lazily and catches loader failures', async () => {
    const onError = vi.fn();
    const loadOptions = vi.fn().mockRejectedValue(new Error('wiki unavailable'));
    render(
      <AgentChatShell
        adapter={adapter({ onError })}
        header={{ title: 'Conversation' }}
        resolveErrorPresentation={resolveErrorPresentation}
        genericErrorPresentation={genericErrorPresentation}
        attachmentSelector={{
          labels: {
            addAttachment: 'Add attachment',
            addFile: 'Add file',
            searchPlaceholder: 'Search wiki',
            noOptions: 'Nothing found',
          },
          loadOptions,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    await waitFor(() => {
      expect(loadOptions).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'wiki unavailable' }), 'load-attachment-options');
    });
  });

  it('exposes stable attachment picker semantics for desktop and narrow hosts', async () => {
    const loadOptions = vi.fn().mockResolvedValue([
      {
        id: 'wiki:ReleaseNotes',
        workspaceId: 'wiki',
        workspaceName: 'Wiki',
        tiddlerTitle: 'ReleaseNotes',
      },
    ]);
    render(
      <AgentChatShell
        adapter={adapter()}
        header={{ title: 'Conversation' }}
        resolveErrorPresentation={resolveErrorPresentation}
        genericErrorPresentation={genericErrorPresentation}
        attachmentSelector={{
          labels: {
            addAttachment: 'Add attachment',
            addFile: 'Add file',
            searchPlaceholder: 'Search wiki',
            noOptions: 'Nothing found',
          },
          loadOptions,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));

    expect(await screen.findByTestId('attachment-autocomplete-input')).toHaveAttribute('placeholder', 'Search wiki');
    expect(await screen.findByTestId('attachment-listbox')).toBeVisible();
    expect(screen.getByTestId('attachment-option-image-AddImage')).toHaveTextContent('Add file');
    expect(await screen.findByTestId('attachment-option-tiddler-ReleaseNotes')).toHaveTextContent('ReleaseNotes');
  });

  it('keeps configuration remediation host-neutral and catches action failures', async () => {
    const onError = vi.fn();
    render(
      <AgentChatShell
        adapter={adapter({ error: new Error('missing key'), onError })}
        header={{ title: 'Conversation' }}
        resolveErrorPresentation={() => ({
          title: 'Provider setup required',
          message: 'Add an API key.',
          actionLabel: 'Open settings',
          actionId: 'provider-settings',
        })}
        genericErrorPresentation={genericErrorPresentation}
        onErrorAction={vi.fn().mockRejectedValue(new Error('settings unavailable'))}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'settings unavailable' }), 'configure-error');
    });
  });

  it('preserves typed error metadata through display bounds and never renders raw provider diagnostics', async () => {
    const onErrorAction = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentChatShell
        adapter={adapter({ messages: [typedErrorMessage()] })}
        header={{ title: 'Conversation' }}
        resolveErrorPresentation={value =>
          resolveAgentRunErrorPresentation(value, {
            localize: () => ({ title: 'Provider setup required', message: 'Add an API key.' }),
            settingActionLabel: () => 'Open settings',
          })}
        genericErrorPresentation={genericErrorPresentation}
        onErrorAction={onErrorAction}
      />,
    );

    expect(screen.getByText('Provider setup required')).toBeInTheDocument();
    expect(screen.getByText('diagnostic-1')).toBeInTheDocument();
    expect(screen.queryByText(/sk-secret|legacy raw error/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await waitFor(() => {
      expect(onErrorAction).toHaveBeenCalledWith(expect.objectContaining({
        settingTarget: { kind: 'provider', providerId: 'siliconflow', field: 'apiKey' },
      }));
    });
  });
});
