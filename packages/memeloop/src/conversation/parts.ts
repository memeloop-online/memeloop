import type { AttachmentReference, ChatAttachmentPart, ChatMessage, ChatMessagePart, ChatReasoningPart, ChatToolCallPart, ChatToolResultPart, ToolCall } from './types.js';

export interface ChatMessageProjection {
  content: string;
  reasoning_content?: string;
  toolCalls?: ToolCall[];
  attachments?: AttachmentReference[];
}

function isTextPart(part: ChatMessagePart): part is Extract<ChatMessagePart, { type: 'text' }> {
  return part.type === 'text';
}

function isReasoningPart(part: ChatMessagePart): part is ChatReasoningPart {
  return part.type === 'reasoning';
}

function isToolCallPart(part: ChatMessagePart): part is ChatToolCallPart {
  return part.type === 'tool-call';
}

function isAttachmentPart(part: ChatMessagePart): part is ChatAttachmentPart {
  return part.type === 'attachment';
}

export function isToolResultPart(part: ChatMessagePart): part is ChatToolResultPart {
  return part.type === 'tool-result';
}

export function buildToolResultSummary(part: ChatToolResultPart): string {
  const prefix = part.isError ? 'Error' : 'Result';
  const suffix = part.result.trim();
  if (suffix.length === 0) return `${prefix} from ${part.toolName}`;
  return `${prefix} from ${part.toolName}: ${suffix}`;
}

export function projectChatMessageParts(parts: readonly ChatMessagePart[]): ChatMessageProjection {
  const text = parts.filter(isTextPart).map((part) => part.text.trim()).filter(Boolean);
  const reasoning = parts.filter(isReasoningPart).map((part) => part.text.trim()).filter(Boolean);
  const toolCalls = parts
    .filter(isToolCallPart)
    .map((part) => ({ id: part.toolCallId, toolName: part.toolName, arguments: part.arguments }));
  const attachments = parts.filter(isAttachmentPart).map((part) => part.attachment);
  const toolResults = parts.filter(isToolResultPart);

  let content = text.join('\n\n');
  if (content.length === 0 && toolResults.length > 0) {
    content = toolResults.map(buildToolResultSummary).join('\n\n');
  }
  if (content.length === 0 && toolCalls.length > 0) {
    content = toolCalls.map((part) => `Tool call: ${part.toolName}`).join('\n\n');
  }

  return {
    content,
    reasoning_content: reasoning.length > 0 ? reasoning.join('\n\n') : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/**
 * Build canonical parts from a new message input. Explicit `parts` are
 * authoritative; the projection fields are accepted only as a convenience for
 * plain text/structured call producers and are converted deterministically.
 * No alternate text protocol is parsed here; callers must provide canonical parts.
 */
export function buildCanonicalChatMessageParts(input: {
  role: string;
  content?: string;
  parts?: ChatMessage['parts'];
  reasoning_content?: string;
  toolCalls?: ToolCall[];
  attachments?: AttachmentReference[];
  detailRef?: ChatToolResultPart['detailRef'];
  metadata?: Record<string, unknown>;
}): ChatMessagePart[] {
  if (input.parts !== undefined) {
    if (!Array.isArray(input.parts)) throw new TypeError('ChatMessage.parts must be an array');
    const parts = [...input.parts];
    if (input.role === 'tool' && !parts.some(isToolResultPart)) {
      throw new TypeError('Tool messages require an explicit tool-result part');
    }
    return parts;
  }

  if (input.role === 'tool') {
    throw new TypeError('Tool messages require explicit canonical parts');
  }

  const parts: ChatMessagePart[] = [];
  if (typeof input.content === 'string' && input.content.length > 0) {
    parts.push({ type: 'text', text: input.content });
  }
  if (typeof input.reasoning_content === 'string' && input.reasoning_content.length > 0) {
    parts.push({ type: 'reasoning', text: input.reasoning_content });
  }
  for (const toolCall of input.toolCalls ?? []) {
    parts.push({
      type: 'tool-call',
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
      arguments: toolCall.arguments,
    });
  }
  for (const attachment of input.attachments ?? []) {
    parts.push({ type: 'attachment', attachment });
  }
  return parts;
}

export function getChatMessageParts(
  message: Pick<
    ChatMessage,
    'parts'
  >,
): ChatMessagePart[] {
  if (!Array.isArray(message.parts)) {
    throw new TypeError('ChatMessage.parts is required');
  }
  return [...message.parts];
}
