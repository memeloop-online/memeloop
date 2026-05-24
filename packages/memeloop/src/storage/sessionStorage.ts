import type { ChatMessage } from "@memeloop/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface CheckpointRecord {
  conversationId: string;
  messages: ChatMessage[];
  savedAt: string; // ISO timestamp
  messageCount: number;
  lastMessagePreview: string;
}

export interface SessionStorageOptions {
  /** Directory where checkpoints are stored. Default: ~/.memeloop/sessions/ */
  directory?: string;
}

const DEFAULT_DIR = path.join(os.homedir(), ".memeloop", "sessions");

export class SessionStorage {
  private directory: string;

  constructor(options: SessionStorageOptions = {}) {
    this.directory = options.directory ?? DEFAULT_DIR;
  }

  /**
   * Ensures the checkpoint directory exists.
   */
  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
  }

  /**
   * Returns the file path for a conversation checkpoint.
   */
  private checkpointPath(conversationId: string): string {
    // Sanitize conversation ID for filesystem safety
    const safeName = conversationId.replace(/[<>:"/\\|?*]/g, "_");
    return path.join(this.directory, `${safeName}.checkpoint.json`);
  }

  /**
   * Saves a full checkpoint of the conversation.
   *
   * @param conversationId - The conversation ID
   * @param messages - Full message history to save
   * @returns The saved checkpoint record
   */
  async saveCheckpoint(
    conversationId: string,
    messages: ChatMessage[],
  ): Promise<CheckpointRecord> {
    await this.ensureDirectory();

    const lastMsg = messages[messages.length - 1];
    const preview =
      lastMsg && typeof lastMsg.content === "string"
        ? lastMsg.content.slice(0, 200)
        : "";

    const record: CheckpointRecord = {
      conversationId,
      messages,
      savedAt: new Date().toISOString(),
      messageCount: messages.length,
      lastMessagePreview: preview,
    };

    const filePath = this.checkpointPath(conversationId);
    const json = JSON.stringify(record, null, 2);
    await fs.writeFile(filePath, json, "utf-8");

    return record;
  }

  /**
   * Loads a previously saved checkpoint.
   *
   * @param conversationId - The conversation ID
   * @returns The checkpoint record, or null if not found
   */
  async loadCheckpoint(
    conversationId: string,
  ): Promise<CheckpointRecord | null> {
    const filePath = this.checkpointPath(conversationId);
    try {
      const json = await fs.readFile(filePath, "utf-8");
      const record = JSON.parse(json) as CheckpointRecord;
      // Basic validation
      if (
        !record ||
        typeof record.conversationId !== "string" ||
        !Array.isArray(record.messages)
      ) {
        return null;
      }
      return record;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Lists all available checkpoint files.
   *
   * @returns Array of checkpoint records (without full message data)
   */
  async listCheckpoints(): Promise<
    Array<{
      conversationId: string;
      savedAt: string;
      messageCount: number;
      lastMessagePreview: string;
    }>
  > {
    await this.ensureDirectory();

    const entries: Array<{
      conversationId: string;
      savedAt: string;
      messageCount: number;
      lastMessagePreview: string;
    }> = [];

    try {
      const files = await fs.readdir(this.directory);
      for (const file of files) {
        if (!file.endsWith(".checkpoint.json")) continue;
        const filePath = path.join(this.directory, file);
        try {
          const json = await fs.readFile(filePath, "utf-8");
          const record = JSON.parse(json) as CheckpointRecord;
          if (record.conversationId && record.savedAt) {
            entries.push({
              conversationId: record.conversationId,
              savedAt: record.savedAt,
              messageCount: record.messageCount,
              lastMessagePreview: record.lastMessagePreview ?? "",
            });
          }
        } catch {
          // Skip malformed checkpoint files
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }

    // Sort by savedAt descending (newest first)
    entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));

    return entries;
  }

  /**
   * Deletes a checkpoint for a conversation.
   */
  async deleteCheckpoint(conversationId: string): Promise<boolean> {
    const filePath = this.checkpointPath(conversationId);
    try {
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw err;
    }
  }
}

/**
 * Convenience function: creates a default SessionStorage and saves a checkpoint.
 */
export async function saveCheckpoint(
  conversationId: string,
  messages: ChatMessage[],
  dir?: string,
): Promise<CheckpointRecord> {
  const storage = new SessionStorage(dir ? { directory: dir } : {});
  return storage.saveCheckpoint(conversationId, messages);
}

/**
 * Convenience function: creates a default SessionStorage and loads a checkpoint.
 */
export async function loadCheckpoint(
  conversationId: string,
  dir?: string,
): Promise<CheckpointRecord | null> {
  const storage = new SessionStorage(dir ? { directory: dir } : {});
  return storage.loadCheckpoint(conversationId);
}

/**
 * Convenience function: lists available checkpoints.
 */
export async function listCheckpoints(
  dir?: string,
): Promise<
  Array<{
    conversationId: string;
    savedAt: string;
    messageCount: number;
    lastMessagePreview: string;
  }>
> {
  const storage = new SessionStorage(dir ? { directory: dir } : {});
  return storage.listCheckpoints();
}
