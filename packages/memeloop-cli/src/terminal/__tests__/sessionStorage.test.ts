import { afterEach, describe, expect, it, vi } from 'vitest';

import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { prepareTerminalSessionStorage, TerminalOutputPersistenceError, wireTerminalOutputToStorage } from '../sessionStorage.js';
import type { TerminalOutputChunk } from '../types.js';

function outputManager() {
  const listeners = new Set<(chunk: TerminalOutputChunk) => void>();
  return {
    onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(chunk: TerminalOutputChunk): void {
      for (const listener of listeners) listener(chunk);
    },
  };
}

describe('terminal session storage boundary', () => {
  let storage: SQLiteAgentStorage | undefined;

  afterEach(() => {
    storage?.close();
    storage = undefined;
  });

  it('preserves the first chunk and surfaces a second-chunk persistence failure', async () => {
    storage = new SQLiteAgentStorage();
    await prepareTerminalSessionStorage(storage, 'node-test', 's1');

    let messageAppends = 0;
    const append = storage.appendLocalEvent.bind(storage);
    vi.spyOn(storage, 'appendLocalEvent').mockImplementation(async (event) => {
      if (event.kind === 'message') {
        messageAppends += 1;
        if (messageAppends === 2) throw new Error('injected storage write failure');
      }
      return append(event);
    });

    const manager = outputManager();
    const wired = wireTerminalOutputToStorage(storage, 'node-test', 'terminal:s1', 's1', manager);
    manager.emit({ sessionId: 's1', seq: 1, stream: 'stdout', data: 'first', ts: 1_000 });
    manager.emit({ sessionId: 's1', seq: 2, stream: 'stdout', data: 'second', ts: 1_001 });

    await expect(wired.persistQueue).rejects.toMatchObject({
      name: 'TerminalOutputPersistenceError',
      code: 'TERMINAL_OUTPUT_PERSISTENCE_FAILED',
      sessionId: 's1',
      seq: 2,
    });

    const page = await storage.getFullContentMessagePage('terminal:s1', {
      direction: 'forward',
      limit: 10,
      maxBytes: 64 * 1024,
    });
    expect(page.reset).toBe(false);
    if (page.reset) return;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.content).toBe('[stdout] first');

    // Once the queue is failed, unsubscribing prevents later chunks from
    // creating a misleading successful tail; the original failure remains
    // observable to the caller.
    wired.unsubOutput();
    manager.emit({ sessionId: 's1', seq: 3, stream: 'stdout', data: 'third', ts: 1_002 });
    await expect(wired.persistQueue).rejects.toBeInstanceOf(TerminalOutputPersistenceError);
  });
});
