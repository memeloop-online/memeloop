import type { AgentAttachmentInput } from 'memeloop';
import { useCallback } from 'react';

import type { WebMemeLoopChatAdapter, WebMemeLoopSendMessageInput } from '../chat/types.js';
import type { AgentSessionCoreAdapterOptions, AgentSessionSendContext } from './useAgentSessionCoreAdapter.js';
import { useAgentSessionCoreAdapter } from './useAgentSessionCoreAdapter.js';

export interface AgentSessionChatAdapterOptions extends Omit<AgentSessionCoreAdapterOptions, 'prepareSendMessage'> {
  mapFile?: (
    file: File,
    context: AgentSessionSendContext,
  ) => Promise<AgentAttachmentInput> | AgentAttachmentInput;
}

/** Thin Web/File binding over the platform-neutral AgentSession adapter. */
export function useAgentSessionChatAdapter(options: AgentSessionChatAdapterOptions): WebMemeLoopChatAdapter {
  const { mapFile, ...coreOptions } = options;
  const prepareSendMessage = useCallback(async (
    input: WebMemeLoopSendMessageInput,
    context: AgentSessionSendContext,
  ) => {
    const attachment = input.file ? await mapFile?.(input.file, context) : undefined;
    context.signal.throwIfAborted();
    if (input.file && !attachment) throw new Error('file attachment mapper is not configured');
    return {
      text: input.text,
      attachment,
      wikiTiddlers: input.wikiTiddlers,
    };
  }, [mapFile]);

  return useAgentSessionCoreAdapter({
    ...coreOptions,
    prepareSendMessage,
  });
}
