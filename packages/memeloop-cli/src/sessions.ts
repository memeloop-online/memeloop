/**
 * sessions.ts — Session management commands
 *
 * Backed by SQLiteAgentStorage's `listConversations` / `getMessages` / `cancelAgent`.
 *
 * Usage:
 *   memeloop sessions list     — list recent sessions
 *   memeloop sessions resume   — resume a session by ID
 *   memeloop sessions delete   — cancel/delete a session
 */
import type { NodeRuntimeResult } from './runtime/nodeRuntime.js';

export interface SessionInfo {
  id: string;
  title: string;
  messageCount: number;
  lastMessageTimestamp: number;
  lastMessagePreview: string;
}

/**
 * Low-level access to storage methods not exposed on IAgentStorage type.
 */
type StorageRaw = Record<string, unknown> & {
  listConversations?(options?: { limit?: number; offset?: number }): Promise<ConversationMeta[]>;
  getMessages?(conversationId: string): Promise<ChatMessage[]>;
  cancelAgent?(conversationId: string): Promise<void>;
};

interface ConversationMeta {
  conversationId: string;
  title?: string;
  lastMessagePreview?: string;
  lastMessageTimestamp?: number;
  messageCount?: number;
}

interface ChatMessage {
  id?: string;
  messageId?: string;
  conversationId?: string;
  role: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

function rawStorage(runtime: NodeRuntimeResult): StorageRaw | null {
  return runtime.storage as unknown as StorageRaw | null;
}

/**
 * List recent sessions from the runtime's SQLite storage.
 */
export async function listSessions(
  runtime: NodeRuntimeResult,
): Promise<SessionInfo[]> {
  const storage = rawStorage(runtime);
  if (!storage?.listConversations) return [];

  try {
    const conversations = await storage.listConversations({ limit: 50 });
    if (!conversations || conversations.length === 0) return [];

    return conversations.map((c) => ({
      id: c.conversationId,
      title: c.title ?? c.conversationId.slice(0, 12),
      messageCount: c.messageCount ?? 0,
      lastMessageTimestamp: c.lastMessageTimestamp ?? 0,
      lastMessagePreview: c.lastMessagePreview ?? '',
    }));
  } catch {
    return [];
  }
}

/**
 * Resume a session — load messages for a conversation ID.
 */
export async function resumeSession(
  runtime: NodeRuntimeResult,
  sessionId: string,
): Promise<{ messages: ChatMessage[] } | null> {
  const storage = rawStorage(runtime);
  if (!storage?.getMessages) return null;

  try {
    const messages = await storage.getMessages(sessionId);
    if (!messages || messages.length === 0) return null;
    return { messages };
  } catch {
    return null;
  }
}

/**
 * Cancel/delete a session by ID.
 *
 * Note: SQLiteAgentStorage provides `cancelAgent(conversationId)` for this.
 * The method marks the agent as cancelled in the database.
 */
export async function deleteSession(
  runtime: NodeRuntimeResult,
  sessionId: string,
): Promise<boolean> {
  const storage = rawStorage(runtime);
  if (!storage?.cancelAgent) return false;

  try {
    await storage.cancelAgent(sessionId);
    return true;
  } catch {
    return false;
  }
}
