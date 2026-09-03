import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import type { ConversationMessageListProjection, WikiTiddlerClickData } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MemeLoopMessage } from '../chat/thread/MemeLoopMessage.js';

describe('MemeLoopMessage wiki content projection', () => {
  it('round-trips canonical projection metadata through the chip callback', () => {
    const contentProjection = {
      truncated: true,
      originalUtf8Bytes: 70_000,
      includedUtf8Bytes: 65_536,
      code: 'ATTACHMENT_CONTENT_TRUNCATED' as const,
    };
    const wikiTiddler: WikiTiddlerClickData = {
      workspaceId: 'workspace-1',
      workspaceName: 'Wiki',
      tiddlerTitle: 'Design',
      renderedContent: 'bounded content',
      contentProjection,
    };
    const message: ConversationMessageListProjection = {
      messageId: 'message-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      originNodeId: 'node-1',
      originSequence: 1,
      timestamp: 1,
      lamportClock: 1,
      role: 'user',
      content: 'message',
      metadata: { wikiTiddlers: [wikiTiddler] },
    };
    const onWikiTiddlerClick = vi.fn<(tiddler: WikiTiddlerClickData) => void>();

    render(
      <MemeLoopMessage
        message={message}
        onWikiTiddlerClick={onWikiTiddlerClick}
        renderContent={() => <span>message</span>}
      />,
    );

    fireEvent.click(screen.getByTestId('wiki-tiddler-chip-message-0'));
    expect(onWikiTiddlerClick).toHaveBeenCalledTimes(1);
    expect(onWikiTiddlerClick).toHaveBeenCalledWith(wikiTiddler);
  });

  it('ignores malformed metadata instead of asserting an untrusted array shape', () => {
    const onWikiTiddlerClick = vi.fn();
    const message: ConversationMessageListProjection = {
      messageId: 'message-malformed-wiki',
      turnId: 'turn-malformed-wiki',
      conversationId: 'conversation-1',
      originNodeId: 'node-1',
      originSequence: 1,
      timestamp: 1,
      lamportClock: 1,
      role: 'assistant',
      content: 'message',
      metadata: { wikiTiddlers: [{ workspaceName: 'Wiki', tiddlerTitle: 'Missing id' }] },
    };

    render(<MemeLoopMessage message={message} onWikiTiddlerClick={onWikiTiddlerClick} />);
    expect(screen.queryByTestId('wiki-tiddler-chip-message-0')).not.toBeInTheDocument();
    expect(onWikiTiddlerClick).not.toHaveBeenCalled();
  });
});
