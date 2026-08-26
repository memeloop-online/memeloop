import { type AppendMessage, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react';
import { useCallback, useMemo, useRef } from 'react';

import { type ChatMessage, getChatMessageParts, projectChatMessageParts } from 'memeloop/conversation';
import { boundMessageForDisplay } from '../displayBounds.js';
import { boundedResidentMessages } from '../residentWindow.js';
import type { MemeLoopChatOperation, WebMemeLoopChatAdapter, WikiTiddlerAttachment } from '../types.js';

/** Pending attachments that the composer collects before sending. */
export interface PendingAttachments {
  file?: File;
  wikiTiddlers: readonly WikiTiddlerAttachment[];
  clearHostAttachments?: () => void;
  restoreComposerDraft?: (text: string) => void;
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
    // assistant-ui's outer message role is mapped in convertMessage. Keep the
    // embedded durable ChatMessage role intact so typed error/tool renderers do
    // not have to infer it from display text or legacy metadata.
    role: originalRole,
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

export function projectRuntimeMessageForDisplay(message: ChatMessage): ChatMessage {
  // Bound raw structured parts before projectChatMessageParts performs trim,
  // filter and join operations. This prevents a hostile tool payload from
  // creating a second unbounded allocation before the display limit applies.
  return boundMessageForDisplay(projectRuntimeMessage(boundMessageForDisplay(message)));
}

/**
 * Hook that builds an assistant-ui AssistantRuntime from a MemeLoopChatAdapter.
 *
 * Pending file / wiki tiddler attachments are read from a mutable ref because
 * assistant-ui's ComposerPrimitive owns the text input state but the host
 * (Desktop / Mobile) owns the attachment pickers.
 */
export function useMemeLoopRuntime(
  adapter: WebMemeLoopChatAdapter,
  reportOperationError?: (error: unknown, operation: MemeLoopChatOperation) => void,
  clearOperationError?: () => void,
) {
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
      try {
        clearOperationError?.();
        await adapter.sendMessage({
          text,
          file: pending.file,
          wikiTiddlers: pending.wikiTiddlers.length > 0 ? pending.wikiTiddlers : undefined,
        });
      } catch (error) {
        // ExternalThread clears the composer optimistically before dispatch.
        // Restore through the mounted composer bridge and keep attachments.
        pending.restoreComposerDraft?.(text);
        reportOperationError?.(error, 'send-message');
        return;
      }

      // Clear pending attachments after a successful send.
      attachmentsReference.current = {
        file: undefined,
        wikiTiddlers: [],
        restoreComposerDraft: pending.restoreComposerDraft,
      };
      if (pending.file || pending.wikiTiddlers.length > 0) pending.clearHostAttachments?.();
    },
    [adapter, clearOperationError, reportOperationError],
  );

  const onCancel = useCallback(async () => {
    try {
      clearOperationError?.();
      await adapter.cancel();
    } catch (error) {
      reportOperationError?.(error, 'cancel');
    }
  }, [adapter, clearOperationError, reportOperationError]);

  const onEdit = useMemo(() => {
    if (!adapter.editMessage) return undefined;
    return async (message: AppendMessage) => {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      if (!message.sourceId) return;
      try {
        clearOperationError?.();
        await adapter.editMessage!(message.sourceId, text);
      } catch (error) {
        reportOperationError?.(error, 'edit-message');
      }
    };
  }, [adapter, clearOperationError, reportOperationError]);

  const onReload = useMemo(() => {
    if (!adapter.reloadMessage) return undefined;
    return async (_parentId: string | null, config: { sourceId?: string | null }) => {
      if (!config.sourceId) return;
      try {
        clearOperationError?.();
        await adapter.reloadMessage!(config.sourceId);
      } catch (error) {
        reportOperationError?.(error, 'reload-message');
      }
    };
  }, [adapter, clearOperationError, reportOperationError]);

  const projectedMessages = useMemo(
    () =>
      boundedResidentMessages(
        adapter.messages,
        adapter.residentMessageLimit,
        adapter.windowAnchorMessageId,
        adapter.residentContentByteLimit,
        adapter.residentRenderRowLimit,
      ).map(projectRuntimeMessageForDisplay),
    [adapter.messages, adapter.residentContentByteLimit, adapter.residentMessageLimit, adapter.residentRenderRowLimit, adapter.windowAnchorMessageId],
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
