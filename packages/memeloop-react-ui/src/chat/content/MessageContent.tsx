import { buildToolResultSummary, type ChatMessage, getChatMessageParts, isToolResultPart } from 'memeloop/conversation';
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

function getOriginalRole(message: ChatMessage): string {
  return typeof message.metadata?.originalRole === 'string' ? message.metadata.originalRole : message.role;
}

function getDisplayText(message: ChatMessage): string {
  const parts = getChatMessageParts(message);
  if (parts.length === 0) return stripToolXml(message.content);

  return parts.flatMap((part) => {
    switch (part.type) {
      case 'text': {
        const text = stripToolXml(part.text).trim();
        return text ? [text] : [];
      }
      case 'reasoning': {
        return [];
      }
      case 'tool-call': {
        return [`Tool call: ${part.toolName}`];
      }
      case 'tool-result': {
        const text = part.result.trim();
        return [text || buildToolResultSummary(part)];
      }
      case 'attachment': {
        return [];
      }
      default: {
        return [];
      }
    }
  }).join('\n\n').trim();
}

export interface MessageContentProps {
  message: ChatMessage;
}

export const MessageContent: React.FC<MessageContentProps> = ({ message }) => {
  // Render ask-question tool UI inline for non-user messages.
  if (
    getOriginalRole(message) !== 'user' &&
    (isAskQuestionContent(message.content) || getChatMessageParts(message).some((part) => isToolResultPart(part) && typeof part.payload === 'object'))
  ) {
    const agentId = message.metadata?.agentId as string | undefined;
    return <AskQuestionContent message={message} agentId={agentId} />;
  }

  const text = getDisplayText(message);
  const displayRole = getOriginalRole(message);

  if (!text) {
    return (
      <span style={{ fontStyle: 'italic', opacity: 0.6 }}>
        {displayRole === 'error' ? 'Error' : displayRole === 'tool' ? 'Tool result' : '...'}
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
