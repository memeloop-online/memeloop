import { type AppendMessage, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react';
import { useCallback, useMemo, useRef } from 'react';

import { type ChatMessage, getChatMessageParts, projectChatMessageParts } from 'memeloop';
import type { MemeLoopChatAdapter, WikiTiddlerAttachment } from '../types.js';

/** Pending attachments that the composer collects before sending. */
export interface PendingAttachments {
  file?: File;
  wikiTiddlers: WikiTiddlerAttachment[];
}

/**
 * Maps a MemeLoop ChatMessage into assistant-ui's ThreadMessageLike shape.
 * Non-user roles are surfaced as assistant so assistant-ui can render them;
 * the original role is preserved in metadata for host-specific rendering.
 *
 * assistant-ui only allows `status` on assistant messages, so user messages
 * omit it entirely.
 */
function convertMessage(message: ChatMessage, isStreaming: boolean): ThreadMessageLike {
  const role: 'user' | 'assistant' = message.role === 'user' ? 'user' : 'assistant';
  const base: ThreadMessageLike = {
    id: message.messageId,
    role,
    content: message.content,
    createdAt: new Date(message.timestamp),
    metadata: {
      custom: {
        memeloop: message,
      },
    },
  };

  if (role === 'user') {
    return base;
  }

  return {
    ...base,
    status: isStreaming ? { type: 'running' } : { type: 'complete', reason: 'unknown' },
  };
}

function projectRuntimeMessage(message: ChatMessage): ChatMessage {
  const originalRole = message.role;
  const parts = getChatMessageParts(message);
  const projection = projectChatMessageParts(parts);
  return {
    ...message,
    role: originalRole === 'user' ? 'user' : 'assistant',
    parts,
    content: projection.content || message.content,
    reasoning_content: projection.reasoning_content ?? message.reasoning_content,
    toolCalls: projection.toolCalls ?? message.toolCalls,
    attachments: projection.attachments ?? message.attachments,
    metadata: {
      ...message.metadata,
      originalRole,
    },
  };
}

/**
 * Hook that builds an assistant-ui AssistantRuntime from a MemeLoopChatAdapter.
 *
 * Pending file / wiki tiddler attachments are read from a mutable ref because
 * assistant-ui's ComposerPrimitive owns the text input state but the host
 * (Desktop / Mobile) owns the attachment pickers.
 */
export function useMemeLoopRuntime(adapter: MemeLoopChatAdapter) {
  const attachmentsReference = useRef<PendingAttachments>({
    file: undefined,
    wikiTiddlers: [],
  });

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');

      const pending = attachmentsReference.current;
      await adapter.sendMessage({
        text,
        file: pending.file,
        wikiTiddlers: pending.wikiTiddlers.length > 0 ? pending.wikiTiddlers : undefined,
      });

      // Clear pending attachments after a successful send.
      attachmentsReference.current = { file: undefined, wikiTiddlers: [] };
    },
    [adapter],
  );

  const onCancel = useCallback(async () => {
    await adapter.cancel();
  }, [adapter]);

  const onEdit = useMemo(() => {
    if (!adapter.editMessage) return undefined;
    return async (message: AppendMessage) => {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      if (!message.sourceId) return;
      await adapter.editMessage!(message.sourceId, text);
    };
  }, [adapter]);

  const onReload = useMemo(() => {
    if (!adapter.reloadMessage) return undefined;
    return async (_parentId: string | null, config: { sourceId?: string | null }) => {
      if (!config.sourceId) return;
      await adapter.reloadMessage!(config.sourceId);
    };
  }, [adapter]);

  const projectedMessages = useMemo(
    () => adapter.messages.map(projectRuntimeMessage),
    [adapter.messages],
  );

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: projectedMessages,
    convertMessage: (message) => convertMessage(message, adapter.isMessageStreaming?.(message.messageId) ?? false),
    isRunning: adapter.isRunning,
    isLoading: adapter.isLoading,
    onNew,
    onCancel,
    onEdit,
    onReload,
  });

  return { runtime, attachmentsRef: attachmentsReference };
}
