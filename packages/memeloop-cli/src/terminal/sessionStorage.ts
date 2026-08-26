import type { IAgentStorage } from 'memeloop';

import type { ITerminalSessionManager } from './sessionManager.js';
import type { TerminalOutputChunk } from './types.js';

export async function prepareTerminalSessionStorage(
  storage: IAgentStorage,
  originNodeId: string,
  sessionId: string,
): Promise<{ terminalCid: string }> {
  const terminalCid = `terminal:${sessionId}`;
  if (!originNodeId.trim()) throw new Error('Terminal persistence requires a stable originNodeId');
  await storage.appendLocalEvent({
    kind: 'metadataPatch',
    eventId: `metadata:create:${terminalCid}`,
    conversationId: terminalCid,
    originNodeId,
    timestamp: Date.now(),
    patch: {
      title: `Terminal ${sessionId.slice(0, 8)}`,
      definitionId: 'memeloop:terminal-session',
      isUserInitiated: false,
    },
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
      .then(async () => {
        const messageId = `${chunk.sessionId}-out-${chunk.seq}-${chunk.ts}`;
        await storage.appendLocalEvent({
          kind: 'message',
          eventId: messageId,
          conversationId: terminalCid,
          originNodeId,
          timestamp: chunk.ts,
          message: {
            messageId,
            turnId: `terminal-turn:${sessionId}`,
            role: 'tool',
            content: `[${chunk.stream}] ${chunk.data}`,
          },
        });
      })
      .catch(() => undefined);
  });
  return { persistQueue, unsubOutput };
}
