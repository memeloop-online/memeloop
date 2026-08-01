import type { IAgentStorage } from 'memeloop';

import type { ITerminalSessionManager } from './sessionManager.js';
import type { TerminalOutputChunk } from './types.js';

export async function prepareTerminalSessionStorage(
  storage: IAgentStorage,
  originNodeId: string,
  sessionId: string,
): Promise<{ terminalCid: string }> {
  const terminalCid = `terminal:${sessionId}`;
  await storage.upsertConversationMetadata({
    conversationId: terminalCid,
    title: `Terminal ${sessionId.slice(0, 8)}`,
    lastMessagePreview: '',
    lastMessageTimestamp: Date.now(),
    messageCount: 0,
    originNodeId,
    originClock: 1,
    definitionId: 'memeloop:terminal-session',
    isUserInitiated: false,
  });
  return { terminalCid };
}

/**
 * Append each output chunk to `terminal:<sessionId>` in storage; optional `onChunk` for WS notify.
 */
export function wireTerminalOutputToStorage(
  storage: IAgentStorage,
  originNodeId: string,
  terminalCid: string,
  sessionId: string,
  manager: ITerminalSessionManager,
  onChunk?: (chunk: TerminalOutputChunk) => void,
): { persistQueue: Promise<void>; unsubOutput: () => void } {
  let persistQueue: Promise<void> = Promise.resolve();
  const unsubOutput = manager.onOutput((chunk) => {
    if (chunk.sessionId !== sessionId) return;
    onChunk?.(chunk);
    persistQueue = persistQueue
      .then(() =>
        storage.appendMessage({
          messageId: `${chunk.sessionId}-out-${chunk.seq}-${chunk.ts}`,
          conversationId: terminalCid,
          originNodeId,
          timestamp: chunk.ts,
          lamportClock: chunk.seq,
          role: 'tool',
          content: `[${chunk.stream}] ${chunk.data}`,
        })
      )
      .catch(() => undefined);
  });
  return { persistQueue, unsubOutput };
}
