import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemeLoopRuntimeProvider } from '../chat/runtime/MemeLoopRuntimeProvider.js';
import type { WebMemeLoopChatAdapter } from '../chat/types.js';

const EMPTY_MESSAGES = Object.freeze([]);
const STABLE_ADAPTER: WebMemeLoopChatAdapter = Object.freeze({
  conversationId: 'provider-only-conversation',
  messages: EMPTY_MESSAGES,
  isRunning: false,
  isLoading: false,
  error: null,
  sendMessage: async () => {},
  cancel: async () => {},
  deleteTurn: async () => {},
  retryTurn: async () => {},
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MemeLoopRuntimeProvider', () => {
  it('keeps a provider-only tree stable without external-store snapshot loops', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <MemeLoopRuntimeProvider adapter={STABLE_ADAPTER}>
        <div data-testid='provider-only-child'>ready</div>
      </MemeLoopRuntimeProvider>,
    );

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(screen.getByTestId('provider-only-child')).toHaveTextContent('ready');
    expect(consoleError.mock.calls.flat().join('\n')).not.toMatch(
      /getSnapshot should be cached|Maximum update depth exceeded/u,
    );
  });
});
