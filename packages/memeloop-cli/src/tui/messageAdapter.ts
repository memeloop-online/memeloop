import { type ChatMessage, type ConversationMessageListProjection, getChatMessageParts, projectChatMessageParts } from 'memeloop';
import { assertResidentMessages } from './messageWindow.js';
import type { TUIMessage } from './types.js';

export const TUI_MESSAGE_CONTENT_MAX_BYTES = 3 * 1024;
export const TUI_MESSAGE_THINKING_MAX_BYTES = 512;
export const TUI_MESSAGE_TOOL_RESULT_MAX_BYTES = 3 * 1024;
const TUI_MESSAGE_TOOL_NAME_MAX_BYTES = 256;

/** Project live host rows before they enter the resident TUI window. */
export function projectTUIMessageForDisplay(message: TUIMessage): TUIMessage {
  const content = projectDisplayText(message.content, TUI_MESSAGE_CONTENT_MAX_BYTES);
  const thinking = message.thinking === undefined
    ? undefined
    : projectDisplayText(message.thinking, TUI_MESSAGE_THINKING_MAX_BYTES);
  const toolResult = message.toolResult === undefined
    ? undefined
    : projectDisplayText(message.toolResult, TUI_MESSAGE_TOOL_RESULT_MAX_BYTES);
  const toolName = message.toolName === undefined
    ? undefined
    : projectDisplayText(message.toolName, TUI_MESSAGE_TOOL_NAME_MAX_BYTES);
  const summary = message.compaction === undefined
    ? undefined
    : projectDisplayText(message.compaction.summaryPreview, TUI_MESSAGE_CONTENT_MAX_BYTES);
  const truncated = content.truncated ||
    thinking?.truncated === true ||
    toolResult?.truncated === true ||
    toolName?.truncated === true ||
    summary?.truncated === true;
  const originalBytes = content.originalBytes +
    (thinking?.originalBytes ?? 0) +
    (toolResult?.originalBytes ?? 0) +
    (toolName?.originalBytes ?? 0) +
    (summary?.originalBytes ?? 0);
  return {
    ...message,
    content: content.text,
    ...(thinking === undefined ? {} : { thinking: thinking.text }),
    ...(toolResult === undefined ? {} : { toolResult: toolResult.text }),
    ...(toolName === undefined ? {} : { toolName: toolName.text }),
    ...(summary === undefined
      ? {}
      : { compaction: { ...message.compaction!, summaryPreview: summary.text } }),
    ...(truncated || message.detail !== undefined
      ? {
        detail: {
          truncated: truncated || message.detail?.truncated === true,
          originalBytes: Math.max(originalBytes, message.detail?.originalBytes ?? 0),
          ...(message.detail?.detailRef === undefined
            ? {}
            : { detailRef: message.detail.detailRef }),
        },
      }
      : {}),
  };
}

export function chatMessageToTUIMessage(message: ChatMessage): TUIMessage {
  const timestamp = new Date(message.timestamp);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('invalid_tui_message_timestamp');
  const parts = getChatMessageParts(message);
  const projection = projectChatMessageParts(parts);
  // Canonical parts are authoritative. `content`/`reasoning_content` are
  // materialized projections and must never resurrect an obsolete payload when
  // parts are empty or malformed.
  const rawContent = projection.content;
  const rawThinking = projection.reasoning_content;
  const contentProjection = projectDisplayText(
    rawContent,
    message.role === 'tool' ? TUI_MESSAGE_TOOL_RESULT_MAX_BYTES : TUI_MESSAGE_CONTENT_MAX_BYTES,
  );
  const thinkingProjection = rawThinking === undefined
    ? undefined
    : projectDisplayText(rawThinking, TUI_MESSAGE_THINKING_MAX_BYTES);
  const detailReference = message.detailRef === undefined
    ? undefined
    : projectDisplayText(JSON.stringify(message.detailRef), 1_024).text;
  const truncated = contentProjection.truncated || thinkingProjection?.truncated === true;
  const role = chatRoleToTUIRole(message.role);
  return {
    kind: 'message',
    messageId: message.messageId,
    role,
    content: message.role === 'tool' ? '' : contentProjection.text,
    timestamp,
    ...(message.role === 'tool' ? { toolResult: contentProjection.text } : {}),
    ...(thinkingProjection === undefined ? {} : { thinking: thinkingProjection.text }),
    ...(truncated || detailReference !== undefined
      ? {
        detail: {
          truncated,
          originalBytes: contentProjection.originalBytes + (thinkingProjection?.originalBytes ?? 0),
          ...(detailReference === undefined ? {} : { detailRef: detailReference }),
        },
      }
      : {}),
  };
}

function chatRoleToTUIRole(role: ChatMessage['role']): TUIMessage['role'] {
  switch (role) {
    case 'user':
    case 'assistant':
    case 'tool':
      return role;
    case 'agent':
      return 'assistant';
    case 'error':
      return 'system';
  }
}

export function chatMessagesToTUIMessages(messages: readonly ChatMessage[]): TUIMessage[] {
  const projected = messages.map(chatMessageToTUIMessage);
  // A storage/host violation is surfaced explicitly. Never silently slice an
  // oversized page at the TUI boundary.
  assertResidentMessages(projected);
  return projected;
}

/**
 * Project a bounded storage list row for display without pretending that the
 * detached row is a full canonical ChatMessage. Interactive pages deliberately
 * omit parts/toolCalls/attachments; only the fields present in the list
 * projection may enter the resident TUI window.
 */
export function conversationMessageProjectionToTUIMessage(
  message: ConversationMessageListProjection,
): TUIMessage {
  const role = chatRoleToTUIRole(message.role);
  const contentProjection = projectDisplayText(
    message.content,
    role === 'tool' ? TUI_MESSAGE_TOOL_RESULT_MAX_BYTES : TUI_MESSAGE_CONTENT_MAX_BYTES,
  );
  const thinkingProjection = message.reasoning === undefined
    ? undefined
    : projectDisplayText(message.reasoning.text, TUI_MESSAGE_THINKING_MAX_BYTES);
  const presentation = message.presentations?.find(item => item.kind === 'tool-result');
  const toolName = presentation === undefined
    ? undefined
    : projectDisplayText(presentation.toolName, TUI_MESSAGE_TOOL_NAME_MAX_BYTES).text;
  const displayTruncation = readDisplayTruncation(message.metadata?.displayTruncation);
  const truncated = contentProjection.truncated ||
    thinkingProjection?.truncated === true ||
    message.reasoning?.hasMore === true ||
    displayTruncation?.truncated === true;
  const detailReference = message.detailRef === undefined
    ? undefined
    : projectDisplayText(JSON.stringify(message.detailRef), 1_024).text;
  const originalBytes = Math.max(
    contentProjection.originalBytes,
    thinkingProjection?.originalBytes ?? 0,
    message.reasoning?.totalBytes ?? 0,
    displayTruncation?.originalEstimatedBytes ?? 0,
  );
  return {
    kind: 'message',
    messageId: message.messageId,
    role,
    content: role === 'tool' ? '' : contentProjection.text,
    timestamp: new Date(message.timestamp),
    ...(role === 'tool' ? { toolResult: contentProjection.text } : {}),
    ...(toolName === undefined ? {} : { toolName }),
    ...(thinkingProjection === undefined ? {} : { thinking: thinkingProjection.text }),
    ...(truncated || detailReference !== undefined
      ? {
        detail: {
          truncated,
          originalBytes,
          ...(detailReference === undefined ? {} : { detailRef: detailReference }),
        },
      }
      : {}),
  };
}

/** Project a complete bounded list page without widening rows back to ChatMessage. */
export function conversationMessageProjectionsToTUIMessages(
  messages: readonly ConversationMessageListProjection[],
): TUIMessage[] {
  const projected = messages.map(conversationMessageProjectionToTUIMessage);
  assertResidentMessages(projected);
  return projected;
}

export function projectDisplayText(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 32) throw new Error('invalid_tui_text_budget');
  assertWellFormedUnicode(value);
  const sanitized = stripTerminalControls(value);
  const originalBytes = utf8Bytes(sanitized);
  if (originalBytes <= maxBytes) return { text: sanitized, truncated: false, originalBytes };
  const marker = '\n… [detail omitted]';
  const markerBytes = utf8Bytes(marker);
  let used = 0;
  let output = '';
  for (const character of sanitized) {
    const bytes = utf8Bytes(character);
    if (used + bytes + markerBytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return { text: `${output}${marker}`, truncated: true, originalBytes };
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) throw new Error('invalid_tui_unicode');
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new Error('invalid_tui_unicode');
    }
  }
}

function stripTerminalControls(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1B) {
      // Drop one complete CSI escape sequence without copying it to Ink.
      if (value[index + 1] === '[') {
        index += 2;
        while (index < value.length && !/[\x40-\x7E]/u.test(value[index])) index += 1;
      }
      continue;
    }
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) continue;
    output += value[index];
  }
  return output;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

interface DisplayTruncationMetadata {
  truncated: true;
  originalEstimatedBytes: number;
}

function readDisplayTruncation(value: unknown): DisplayTruncationMetadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.truncated === true &&
      typeof record.originalEstimatedBytes === 'number' &&
      Number.isSafeInteger(record.originalEstimatedBytes) &&
      record.originalEstimatedBytes >= 0
    ? {
      truncated: true,
      originalEstimatedBytes: record.originalEstimatedBytes,
    }
    : undefined;
}
