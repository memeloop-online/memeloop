import { buildToolResultSummary, type ChatMessage, getChatMessageParts, isToolResultPart } from 'memeloop/conversation';
import React from 'react';

import { getDisplayTruncation } from '../displayBounds.js';
import { AskQuestionContent } from './AskQuestionContent.js';
import type { AskQuestionContentLabels } from './AskQuestionContent.js';

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
    .replace(/<tool_use\b[\s\S]*?<\/tool_use>/gu, '')
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

export interface MessageContentLabels {
  error: string;
  toolResult: string;
  toolCall: (toolName: string) => string;
  truncated: (originalCharacterCount: number, capability?: 'detail' | 'export') => string;
  askQuestion: AskQuestionContentLabels;
}

const defaultLabels: MessageContentLabels = {
  error: 'Error',
  toolResult: 'Tool result',
  toolCall: toolName => `Tool call: ${toolName}`,
  truncated: (count, capability) =>
    `Message shortened for display (${String(count)} characters).${
      capability === 'detail' ? ' View details for complete content.' : capability === 'export' ? ' Export for complete content.' : ''
    }`,
  askQuestion: {
    answerPlaceholder: 'Your answer…',
    submit: 'Submit',
    confirmSelection: 'Confirm selection',
    answered: 'Answered',
  },
};

function getDisplayText(message: ChatMessage, labels: MessageContentLabels): string {
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
        return [labels.toolCall(part.toolName)];
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
  labels?: Partial<MessageContentLabels>;
}

export const MessageContent: React.FC<MessageContentProps> = ({ message, labels: labelOverrides }) => {
  const labels = { ...defaultLabels, ...labelOverrides };
  const displayRole = getOriginalRole(message);
  // Raw provider/error message bodies are diagnostic data, not user-facing
  // content. Typed AgentRunError presentation is handled by AgentChatShell;
  // this base renderer fails closed for hosts that use AgentChatView directly.
  if (displayRole === 'error') {
    return <span style={{ fontStyle: 'italic', opacity: 0.6 }}>{labels.error}</span>;
  }
  // Render ask-question tool UI inline for non-user messages.
  if (
    getOriginalRole(message) !== 'user' &&
    (isAskQuestionContent(message.content) || getChatMessageParts(message).some((part) => isToolResultPart(part) && typeof part.payload === 'object'))
  ) {
    const agentId = message.metadata?.agentId as string | undefined;
    return <AskQuestionContent message={message} agentId={agentId} labels={labels.askQuestion} />;
  }

  const text = getDisplayText(message, labels);
  const truncation = getDisplayTruncation(message);

  if (!text) {
    return (
      <span style={{ fontStyle: 'italic', opacity: 0.6 }}>
        {displayRole === 'error' ? labels.error : displayRole === 'tool' ? labels.toolResult : '…'}
      </span>
    );
  }

  return (
    <>
      <span
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </span>
      {truncation && (
        <span data-testid='message-display-truncated' style={{ display: 'block', marginTop: 8, fontStyle: 'italic', opacity: 0.7 }}>
          {labels.truncated(truncation.originalCharacterCount, truncation.capability)}
        </span>
      )}
    </>
  );
};
