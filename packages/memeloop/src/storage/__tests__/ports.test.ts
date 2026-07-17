import { describe, expect, it, vi } from 'vitest';

import { nextLamportClockForConversation } from '../nextLamport.js';
import type { ConversationEventStore, FullAgentStorage } from '../ports.js';

describe('narrow storage ports', () => {
  it('loop helpers consume only ConversationEventStore, not the monolithic facade', async () => {
    // A host implementing only the event port (no blobs, definitions, IM, ...)
    // must be usable by loop helpers without satisfying FullAgentStorage.
    const eventsOnly: ConversationEventStore = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([{ lamportClock: 41 }, { lamportClock: 7 }]),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
    };

    await expect(nextLamportClockForConversation(eventsOnly, 'c1')).resolves.toBe(42);
  });

  it('uses the optional lamport optimization when the port provides it', async () => {
    const eventsOnly: ConversationEventStore = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getMaxLamportClockForConversation: vi.fn().mockResolvedValue(100),
    };

    await expect(nextLamportClockForConversation(eventsOnly, 'c1')).resolves.toBe(101);
    expect(eventsOnly.getMessages).not.toHaveBeenCalled();
  });

  it('a full adapter remains assignable to every narrow port', () => {
    // Compile-time guarantee: an object typed as FullAgentStorage can be passed
    // wherever a narrow port is required.
    const full = {} as FullAgentStorage;
    const events: ConversationEventStore = full;
    expect(events).toBe(full);
  });
});
