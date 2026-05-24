import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ChatMessage } from "@memeloop/protocol";
import { SessionStorage } from "../sessionStorage.js";

function createMessage(
  conversationId: string,
  overrides: Partial<ChatMessage> & { id: number | string },
): ChatMessage {
  const id = String(overrides.id);
  return {
    messageId: `${conversationId}:${id}`,
    conversationId,
    originNodeId: "local",
    timestamp: 1000 + Number(id) * 100,
    lamportClock: Number(id),
    role: "user",
    content: `Message ${id}`,
    ...overrides,
  } as ChatMessage;
}

describe("SessionStorage", () => {
  let testDir: string;
  let storage: SessionStorage;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `memeloop-checkpoint-test-${Date.now()}`);
    storage = new SessionStorage({ directory: testDir });
  });

  afterAll(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("saves a checkpoint successfully", async () => {
    const messages: ChatMessage[] = [
      createMessage("conv-1", { id: 1, role: "user", content: "Hello" }),
      createMessage("conv-1", { id: 2, role: "assistant", content: "Hi there!" }),
    ];

    const record = await storage.saveCheckpoint("conv-1", messages);

    expect(record.conversationId).toBe("conv-1");
    expect(record.messageCount).toBe(2);
    expect(record.messages).toEqual(messages);
    expect(record.savedAt).toBeTruthy();
    expect(record.lastMessagePreview).toBe("Hi there!");
  });

  it("loads a saved checkpoint", async () => {
    const messages: ChatMessage[] = [
      createMessage("conv-2", { id: 1, role: "user", content: "Question" }),
      createMessage("conv-2", { id: 2, role: "assistant", content: "Answer" }),
    ];

    await storage.saveCheckpoint("conv-2", messages);
    const loaded = await storage.loadCheckpoint("conv-2");

    expect(loaded).not.toBeNull();
    expect(loaded!.conversationId).toBe("conv-2");
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].content).toBe("Question");
    expect(loaded!.messages[1].content).toBe("Answer");
  });

  it("returns null for nonexistent checkpoint", async () => {
    const loaded = await storage.loadCheckpoint("nonexistent-conv");
    expect(loaded).toBeNull();
  });

  it("lists all checkpoints", async () => {
    const messages1: ChatMessage[] = [
      createMessage("conv-a", { id: 1, content: "A msg" }),
    ];
    const messages2: ChatMessage[] = [
      createMessage("conv-b", { id: 1, content: "B msg" }),
    ];

    await storage.saveCheckpoint("conv-a", messages1);
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await storage.saveCheckpoint("conv-b", messages2);

    const list = await storage.listCheckpoints();
    expect(list.length).toBeGreaterThanOrEqual(2);

    const convA = list.find((e) => e.conversationId === "conv-a");
    const convB = list.find((e) => e.conversationId === "conv-b");
    expect(convA).toBeDefined();
    expect(convB).toBeDefined();
    expect(convA!.messageCount).toBe(1);
    expect(convB!.messageCount).toBe(1);

    // Newest should be first
    if (convA && convB) {
      expect(convB.savedAt.localeCompare(convA.savedAt)).toBeGreaterThanOrEqual(0);
    }
  });

  it("deletes a checkpoint", async () => {
    const messages: ChatMessage[] = [
      createMessage("conv-del", { id: 1, content: "To delete" }),
    ];
    await storage.saveCheckpoint("conv-del", messages);

    let loaded = await storage.loadCheckpoint("conv-del");
    expect(loaded).not.toBeNull();

    const deleted = await storage.deleteCheckpoint("conv-del");
    expect(deleted).toBe(true);

    loaded = await storage.loadCheckpoint("conv-del");
    expect(loaded).toBeNull();
  });

  it("returns false when deleting nonexistent checkpoint", async () => {
    const deleted = await storage.deleteCheckpoint("definitely-not-there");
    expect(deleted).toBe(false);
  });

  it("handles large conversation checkpoints", async () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push(
        createMessage("conv-large", {
          id: i * 2,
          role: "user",
          content: `User message number ${i} with some additional content to make it bigger. `.repeat(3),
        }),
      );
      messages.push(
        createMessage("conv-large", {
          id: i * 2 + 1,
          role: "assistant",
          content: `Response ${i}: this is a detailed response that includes code examples, explanations, and tool outputs. `.repeat(5),
        }),
      );
    }

    const record = await storage.saveCheckpoint("conv-large", messages);
    expect(record.messageCount).toBe(200);

    const loaded = await storage.loadCheckpoint("conv-large");
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(200);
  });

  it("sanitizes conversation IDs with special characters", async () => {
    const dangerousId = 'conv:with/special<>chars?*';
    const messages: ChatMessage[] = [
      createMessage(dangerousId, { id: 1, content: "Safe content" }),
    ];

    // Should not throw
    await storage.saveCheckpoint(dangerousId, messages);
    const loaded = await storage.loadCheckpoint(dangerousId);
    expect(loaded).not.toBeNull();
  });

  it("listCheckpoints skips malformed files gracefully", async () => {
    // Create a corrupt checkpoint file
    const badFile = path.join(testDir, "bad.checkpoint.json");
    await fs.writeFile(badFile, "{not valid json", "utf-8");

    const list = await storage.listCheckpoints();
    // Should not include the bad file
    const bad = list.find((e) => e.conversationId === undefined);
    expect(bad).toBeUndefined();

    await fs.unlink(badFile);
  });

  it("returns empty list when no checkpoints exist", async () => {
    // Use a fresh empty directory
    const emptyDir = path.join(os.tmpdir(), `memeloop-empty-test-${Date.now()}`);
    const emptyStorage = new SessionStorage({ directory: emptyDir });

    const list = await emptyStorage.listCheckpoints();
    expect(list).toEqual([]);

    await fs.rm(emptyDir, { recursive: true, force: true });
  });
});
