import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../conversation/index.js";
import {
  autoCompact,
  type CompactionOptions,
  compactMessages,
  shouldCompact,
} from "../compaction.js";

function createMessage(overrides: Partial<ChatMessage> & { id: number | string }): ChatMessage {
  const id = String(overrides.id);
  return {
    messageId: `test:${id}`,
    conversationId: "test-conv",
    originNodeId: "local",
    timestamp: 1000 + Number(id) * 100,
    lamportClock: Number(id),
    role: "user",
    content: `Message ${id}`,
    ...overrides,
    // Ensure metadata doesn't conflict
    metadata: overrides.metadata ?? undefined,
  } as ChatMessage;
}

function createConversation(turnCount: number, withTools = false): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let t = 0; t < turnCount; t++) {
    const base = t * 3;
    messages.push(createMessage({ id: base + 1, role: "user", content: `User message ${t + 1}` }));
    messages.push(
      createMessage({
        id: base + 2,
        role: "assistant",
        content: `Assistant response ${t + 1}`,
      }),
    );
    if (withTools && t % 2 === 0) {
      messages.push(
        createMessage({
          id: base + 3,
          role: "tool",
          content:
            `Tool output for turn ${t + 1}. This is a very long tool output that contains a lot of data and should be summarized during compaction. `.repeat(
              5,
            ),
        }),
      );
    }
  }
  return messages;
}

describe("compactMessages", () => {
  it("returns original messages when below threshold", () => {
    const messages = createConversation(2);
    const result = compactMessages(messages, { recentTurnsToKeep: 4 });
    expect(result.compacted).toBe(false);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("compacts when turns exceed recentTurnsToKeep", () => {
    const messages = createConversation(10); // 20 messages, 10 turns
    const result = compactMessages(messages, { recentTurnsToKeep: 4 });

    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    // Should have summary + kept messages
    expect(result.messages.length).toBeLessThan(messages.length);
    // First message should be a summary
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toContain("[context-summary]");
  });

  it("preserves configured number of recent turns", () => {
    const messages = createConversation(10); // 10 turns
    const recentTurnsToKeep = 2;

    const result = compactMessages(messages, { recentTurnsToKeep });

    // The last 2 turns should be preserved = last 4 messages (user + assistant each)
    const kept = result.messages.slice(1); // Skip summary
    const userMessages = kept.filter((m) => m.role === "user");
    expect(userMessages.length).toBe(recentTurnsToKeep);
  });

  it("does not compact when turns equal recentTurnsToKeep", () => {
    const messages = createConversation(4);
    const result = compactMessages(messages, { recentTurnsToKeep: 4 });
    expect(result.compacted).toBe(false);
  });

  it("creates summary with dropped count", () => {
    const messages = createConversation(10);
    const result = compactMessages(messages, { recentTurnsToKeep: 2 });

    expect(result.summaryText).toContain("[context-summary]");
    expect(result.summaryText).toContain("compacted");
  });

  it("handles empty messages gracefully", () => {
    const result = compactMessages([], { recentTurnsToKeep: 4 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual([]);
  });

  it("handles tool messages in compaction", () => {
    const messages = createConversation(8, true);
    const result = compactMessages(messages, { recentTurnsToKeep: 3 });

    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
  });
});

describe("shouldCompact", () => {
  it("returns false when below threshold", () => {
    const messages = createConversation(5); // 10 messages
    expect(shouldCompact(messages, 50)).toBe(false);
  });

  it("returns true when above threshold", () => {
    const messages = new Array(60)
      .fill(null)
      .map((_, i) => createMessage({ id: i, role: "user", content: `Msg ${i}` }));
    expect(shouldCompact(messages, 50)).toBe(true);
  });

  it("uses default threshold of 50", () => {
    const messages = new Array(51)
      .fill(null)
      .map((_, i) => createMessage({ id: i, role: "user", content: `Msg ${i}` }));
    expect(shouldCompact(messages)).toBe(true);
  });

  it("returns false when at exact threshold", () => {
    const messages = new Array(50)
      .fill(null)
      .map((_, i) => createMessage({ id: i, role: "user", content: `Msg ${i}` }));
    expect(shouldCompact(messages, 50)).toBe(false);
  });
});

describe("autoCompact", () => {
  it("returns original messages when within token budget", async () => {
    const messages = createConversation(3);
    const result = await autoCompact(messages, { maxTokens: 100000 });
    expect(result.compacted).toBe(false);
  });

  it("falls back to truncation when LLM is unavailable", async () => {
    const messages = createConversation(10);
    const options: CompactionOptions = {
      recentTurnsToKeep: 2,
      useLlmSummary: false,
    };
    const result = await autoCompact(messages, options);

    expect(result.compacted).toBe(true);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toContain("[context-summary]");
  });

  it("handles single-message edge case", async () => {
    const messages = [createMessage({ id: 0, role: "user", content: "One message" })];
    const result = await autoCompact(messages, { recentTurnsToKeep: 2 });
    expect(result.compacted).toBe(false);
  });

  it("uses custom recentTurnsToKeep", async () => {
    const messages = createConversation(8);
    const result = await autoCompact(messages, {
      recentTurnsToKeep: 1,
      useLlmSummary: false,
    });

    expect(result.compacted).toBe(true);
    const keptUser = result.messages.slice(1).filter((m) => m.role === "user");
    expect(keptUser.length).toBe(1);
  });
});
