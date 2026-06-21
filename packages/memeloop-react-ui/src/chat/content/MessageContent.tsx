import type { ChatMessage } from 'memeloop';
import React from 'react';

import { AskQuestionContent } from './AskQuestionContent.js';

/**
 * Default fallback renderer for message content.
 *
 * Hosts are encouraged to provide their own renderContent implementation that
 * understands MemeLoop-specific output (tool XML stripping, wikitext, markdown,
 * thinking blocks, etc.). This fallback simply strips common tool XML tags and
 * renders the remaining text so the UI is never blank.
 */
function stripToolXml(content: string): string {
  return content
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gu, '')
    .replace(/<function_call>[\s\S]*?<\/function_call>/gu, '')
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/gu, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gu, '')
    .trim();
}

function isAskQuestionContent(content: string): boolean {
  return content.includes('"type": "ask-question"') || content.includes('"type":"ask-question"');
}

export interface MessageContentProps {
  message: ChatMessage;
}

export const MessageContent: React.FC<MessageContentProps> = ({ message }) => {
  // Render ask-question tool UI inline for non-user messages.
  if (message.role !== 'user' && isAskQuestionContent(message.content)) {
    const agentId = message.metadata?.agentId as string | undefined;
    return <AskQuestionContent message={message} agentId={agentId} />;
  }

  const text = stripToolXml(message.content);

  if (!text) {
    return (
      <span style={{ fontStyle: 'italic', opacity: 0.6 }}>
        {message.role === 'error' ? 'Error' : message.role === 'tool' ? 'Tool result' : '...'}
      </span>
    );
  }

  return (
    <span
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </span>
  );
};
