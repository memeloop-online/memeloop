import type { AttachmentReference, ChatAttachmentPart, ChatMessage, ChatMessagePart, ChatReasoningPart, ChatToolCallPart, ChatToolResultPart, ToolCall } from './types.js';

export interface ChatMessageProjection {
  content: string;
  reasoning_content?: string;
  toolCalls?: ToolCall[];
  attachments?: AttachmentReference[];
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function parseLegacyToolResultContent(content: string): ChatToolResultPart | null {
  const match = /(?:<functions_result>\s*)?Tool:\s*(.+?)\nParameters:\s*(.+?)\n(Error|Result):\s*([\s\S]*?)\s*(?:<\/functions_result>|$)/su.exec(content.trim());
  if (!match) return null;

  const [, rawToolName, rawParameters, kind, rawBody] = match;
  const parsedParameters = tryParseJson(rawParameters.trim());
  const result = rawBody.trim();
  return {
    type: 'tool-result',
    toolName: rawToolName.trim(),
    parameters: parsedParameters,
    result,
    isError: kind === 'Error',
    payload: tryParseJson(result),
  };
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

export function buildLegacyChatMessageParts(input: {
  role: string;
  content?: string;
  reasoning_content?: string;
  toolCalls?: ToolCall[];
  attachments?: AttachmentReference[];
  detailRef?: ChatToolResultPart['detailRef'];
  metadata?: Record<string, unknown>;
}): ChatMessagePart[] {
  const parts: ChatMessagePart[] = [];

  if (input.role !== 'tool' && typeof input.content === 'string' && input.content.trim().length > 0) {
    parts.push({ type: 'text', text: input.content });
  }

  if (typeof input.reasoning_content === 'string' && input.reasoning_content.trim().length > 0) {
    parts.push({ type: 'reasoning', text: input.reasoning_content });
  }

  if (input.toolCalls) {
    for (const toolCall of input.toolCalls) {
      parts.push({
        type: 'tool-call',
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        arguments: toolCall.arguments,
      });
    }
  }

  if (input.attachments) {
    for (const attachment of input.attachments) {
      parts.push({ type: 'attachment', attachment });
    }
  }

  if (input.role === 'tool') {
    const metadata = input.metadata ?? {};
    const parsed = typeof input.content === 'string' ? parseLegacyToolResultContent(input.content) : null;
    const toolName = typeof metadata.toolId === 'string' && metadata.toolId.length > 0
      ? metadata.toolId
      : parsed?.toolName ?? 'tool';
    const result = parsed?.result ?? (typeof input.content === 'string' ? input.content : '');
    const payload = parsed?.payload ?? tryParseJson(result);
    parts.push({
      type: 'tool-result',
      toolName,
      parameters: metadata.toolParameters ?? parsed?.parameters,
      result,
      isError: metadata.isError === true || parsed?.isError === true,
      payload,
      detailRef: input.detailRef,
    });
  }

  return parts;
}

export function getChatMessageParts(
  message: Pick<
    ChatMessage,
    'role' | 'parts' | 'content' | 'reasoning_content' | 'toolCalls' | 'attachments' | 'detailRef' | 'metadata'
  >,
): ChatMessagePart[] {
  return message.parts ?? buildLegacyChatMessageParts(message);
}
