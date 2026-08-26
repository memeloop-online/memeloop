import { describe, expect, it, vi } from 'vitest';

import { nextLamportClockForConversation } from '../nextLamport.js';
import type { ConversationEventStore, FullAgentStorage } from '../ports.js';

describe('narrow storage ports', () => {
  function eventPort(
    overrides: Partial<ConversationEventStore> = {},
  ): ConversationEventStore {
    return {
      listConversationsPage: vi.fn(),
      getMessagePage: vi.fn(),
      getConversationTimelinePage: vi.fn(),
      getConversationEventPage: vi.fn(),
      appendLocalEvent: vi.fn(),
      appendLocalEventsAtomic: vi.fn(),
      insertEventsIfAbsent: vi.fn(),
      getEventVersionFrontierPage: vi.fn(),
      getEventVersionFrontiersForKeys: vi.fn(),
      getCompactionCandidatePage: vi.fn(),
      getRetainedCompactionControls: vi.fn(),
      ...overrides,
    } as ConversationEventStore;
  }

  it('fails closed when the indexed Lamport reader is unavailable', async () => {
    await expect(nextLamportClockForConversation(eventPort(), 'c1')).rejects.toThrow(
      /indexed Lamport clock reader unavailable/,
    );
  });

  it('uses the optional lamport optimization when the port provides it', async () => {
    const eventsOnly = eventPort({
      getMaxLamportClockForConversation: vi.fn().mockResolvedValue(100),
    });

    await expect(nextLamportClockForConversation(eventsOnly, 'c1')).resolves.toBe(101);
    expect(eventsOnly.getMessagePage).not.toHaveBeenCalled();
  });

  it('a full adapter remains assignable to every narrow port', () => {
    // Compile-time guarantee: an object typed as FullAgentStorage can be passed
    // wherever a narrow port is required.
    const full = {} as FullAgentStorage;
    const events: ConversationEventStore = full;
    expect(events).toBe(full);
  });
});
