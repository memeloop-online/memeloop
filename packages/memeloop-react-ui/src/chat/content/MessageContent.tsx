import type { ConversationMessageListProjection } from 'memeloop';
import React from 'react';

import { getDisplayTruncation } from '../displayBounds.js';
import { AskQuestionContent } from './AskQuestionContent.js';
import type { AskQuestionContentLabels } from './AskQuestionContent.js';

/**
 * Default fallback renderer for canonical message parts. Hosts are encouraged
 * to provide their own renderContent implementation for richer formats.
 */
function getOriginalRole(message: Pick<ConversationMessageListProjection, 'metadata' | 'role'>): string {
  return typeof message.metadata?.originalRole === 'string' ? message.metadata.originalRole : message.role;
}

export interface MessageContentLabels {
  error: string;
  toolResult: string;
  toolCall: (toolName: string) => string;
  truncated: (originalCharacterCount: number, capability?: 'detail' | 'export') => string;
  askQuestion: AskQuestionContentLabels;
}

export type MessageContentPresentation = NonNullable<ConversationMessageListProjection['presentations']>[number];

export interface MessageContentToolRendererContext {
  message: ConversationMessageListProjection;
  labels: MessageContentLabels;
}

/** Host-extensible renderer registry for bounded Core tool presentations. */
export type MessageContentToolRenderer = (
  presentation: MessageContentPresentation,
  context: MessageContentToolRendererContext,
) => React.ReactNode;

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

function getDisplayText(message: ConversationMessageListProjection): string {
  // List rows are an intentionally lightweight Core projection and never carry
  // canonical `parts`. Their bounded `content` field is the sole text surface;
  // full structured payloads are rendered by an explicitly privileged host
  // boundary instead of being reconstructed here.
  return message.content.trim();
}

export interface MessageContentProps {
  message: ConversationMessageListProjection;
  labels?: Partial<MessageContentLabels>;
  toolResultRenderers?: Readonly<Record<string, MessageContentToolRenderer>>;
}

export const MessageContent: React.FC<MessageContentProps> = ({ message, labels: labelOverrides, toolResultRenderers }) => {
  const labels = { ...defaultLabels, ...labelOverrides };
  const displayRole = getOriginalRole(message);
  // Raw provider/error message bodies are diagnostic data, not user-facing
  // content. Typed AgentRunError presentation is handled by AgentChatShell;
  // this base renderer fails closed for hosts that use AgentChatView directly.
  if (displayRole === 'error') {
    return <span style={{ fontStyle: 'italic', opacity: 0.6 }}>{labels.error}</span>;
  }
  // Core orders presentations deterministically.  Give each explicitly
  // registered renderer a chance in that order, then fall back to the bounded
  // text projection.  Unknown/truncated presentations are intentionally not
  // inspected or serialized by this generic surface.
  for (const presentation of message.presentations ?? []) {
    if (presentation.truncated) continue;
    const renderer = toolResultRenderers?.[presentation.toolName] ?? defaultToolResultRenderers[presentation.toolName];
    const rendered = renderer?.(presentation, { message, labels });
    if (rendered !== undefined && rendered !== null) return rendered;
  }
  const text = getDisplayText(message);
  const truncation = getDisplayTruncation(message);

  if (!text) {
    // Reasoning is rendered by MemeLoopMessage's separate collapsible panel.
    // Do not manufacture an ellipsis body while an answer is still empty: a
    // live reasoning-only projection must never look like a truncated answer.
    if ((message.reasoning?.totalBytes ?? 0) > 0) return null;
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
      {truncation?.contentTruncated === true && (
        <span data-testid='message-display-truncated' style={{ display: 'block', marginTop: 8, fontStyle: 'italic', opacity: 0.7 }}>
          {labels.truncated(truncation.originalCharacterCount, truncation.capability)}
        </span>
      )}
    </>
  );
};

const defaultToolResultRenderers: Readonly<Record<string, MessageContentToolRenderer>> = {
  'ask-question': (presentation, { message, labels }) =>
    presentation.payload === undefined
      ? null
      : <AskQuestionContent message={message} labels={labels.askQuestion} />,
};
