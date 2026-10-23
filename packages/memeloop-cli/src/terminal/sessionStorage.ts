import { createLocalMessageDraft, type FullAgentStorage } from 'memeloop';

import type { ITerminalSessionManager } from './sessionManager.js';
import type { TerminalOutputChunk } from './types.js';

/** Stable, redacted error surfaced when terminal output cannot be persisted. */
export class TerminalOutputPersistenceError extends Error {
  readonly code = 'TERMINAL_OUTPUT_PERSISTENCE_FAILED';
  readonly sessionId: string;
  readonly seq: number;

  constructor(chunk: Pick<TerminalOutputChunk, 'sessionId' | 'seq'>, cause?: unknown) {
    super(`terminal output persistence failed for ${chunk.sessionId}#${chunk.seq}`, { cause });
    this.name = 'TerminalOutputPersistenceError';
    this.sessionId = chunk.sessionId;
    this.seq = chunk.seq;
  }
}

export async function prepareTerminalSessionStorage(
  storage: FullAgentStorage,
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
  storage: FullAgentStorage,
  originNodeId: string,
  terminalCid: string,
  sessionId: string,
  manager: Pick<ITerminalSessionManager, 'onOutput'>,
  onChunk?: (chunk: TerminalOutputChunk) => void,
): { persistQueue: Promise<void>; unsubOutput: () => void } {
  const result: { persistQueue: Promise<void>; unsubOutput: () => void } = {
    persistQueue: Promise.resolve(),
    unsubOutput: () => undefined,
  };
  result.unsubOutput = manager.onOutput((chunk) => {
    if (chunk.sessionId !== sessionId) return;
    onChunk?.(chunk);
    result.persistQueue = result.persistQueue.then(async () => {
      const messageId = `${chunk.sessionId}-out-${chunk.seq}-${chunk.ts}`;
      const text = `[${chunk.stream}] ${chunk.data}`;
      try {
        await storage.appendLocalEvent(createLocalMessageDraft({
          messageId,
          turnId: `terminal-turn:${sessionId}`,
          conversationId: terminalCid,
          originNodeId,
          timestamp: chunk.ts,
          role: 'tool',
          content: text,
          parts: [{
            type: 'tool-result',
            toolName: 'terminal',
            result: text,
            isError: chunk.stream === 'stderr',
          }],
        }));
      } catch (error) {
        // Preserve the rejection for callers to await; never turn a partial
        // transcript into a successful terminal detail reference.
        throw new TerminalOutputPersistenceError(chunk, error);
      }
    });
  });
  return result;
}
