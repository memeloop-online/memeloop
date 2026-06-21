import { type AppendMessage, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react';
import { useCallback, useMemo, useRef } from 'react';

import type { ChatMessage } from 'memeloop';
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
 */
function convertMessage(message: ChatMessage, isStreaming: boolean): ThreadMessageLike {
  const role = message.role === 'user' ? 'user' : 'assistant';

  return {
    id: message.messageId,
    role,
    content: message.content,
    createdAt: new Date(message.timestamp),
    status: isStreaming ? { type: 'running' } : { type: 'complete', reason: 'unknown' },
    metadata: {
      custom: {
        memeloop: message,
      },
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

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: adapter.messages,
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
