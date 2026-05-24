/**
 * ACP Session Manager — bridges ACP protocol sessions to MemeLoopRuntime agents.
 */
import type { MemeLoopRuntime } from "memeloop";
import type { AcpResponseChunk, AcpSessionInfo } from "./protocol.js";

/** Internal per-session state. */
export interface SessionEntry {
  sessionId: string;
  conversationId: string;
  agentId: string;
  status: AcpSessionInfo["status"];
  createdAt: number;
  messageCount: number;
}

/** Options passed to `sendPrompt` for streaming control. */
export interface SendPromptStreamOptions {
  /** Signal to cancel the stream from the outside. */
  signal?: AbortSignal;
}

/** Next session counter (monotonic). */
let nextSessionId = 1;

export function resetSessionCounter(value = 1): void {
  nextSessionId = value;
}

export class AcpSessionManager {
  private runtime: MemeLoopRuntime;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(runtime: MemeLoopRuntime) {
    this.runtime = runtime;
  }

  /** Create a new agent session. */
  async createSession(
    agentId = "memeloop:general-assistant",
    resumeId?: string,
  ): Promise<AcpSessionInfo> {
    const result = await this.runtime.createAgent({
      definitionId: agentId,
      initialMessage: undefined,
    });

    const sessionId = `acp-${nextSessionId++}`;
    const entry: SessionEntry = {
      sessionId,
      conversationId: result.conversationId,
      agentId,
      status: "active",
      createdAt: Date.now(),
      messageCount: 0,
    };
    this.sessions.set(sessionId, entry);

    return this.toSessionInfo(entry);
  }

  /**
   * Send a prompt to an existing session and stream response chunks.
   * Returns an async iterator that yields `AcpResponseChunk` items as the
   * agent processes the prompt.
   *
   * The stream finishes when the agent emits `agent-done`, `agent-error`, or
   * the signal is aborted.
   */
  async *sendPrompt(
    sessionId: string,
    prompt: string,
    options?: SendPromptStreamOptions,
  ): AsyncGenerator<AcpResponseChunk, void, undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== "active") {
      throw new Error(`Session ${sessionId} is ${session.status}`);
    }

    const { conversationId } = session;

    // Use a Promise-based queue to bridge callback → async generator.
    type QueueItem =
      | { kind: "chunk"; chunk: AcpResponseChunk }
      | { kind: "done" }
      | { kind: "error"; error: string };

    const queue: QueueItem[] = [];
    let resolveWait: (() => void) | undefined;
    let finished = false;

    const push = (item: QueueItem) => {
      queue.push(item);
      resolveWait?.();
      resolveWait = undefined;
    };

    const wait = (): Promise<void> =>
      new Promise((resolve) => {
        resolveWait = resolve;
      });

    // Subscribe to runtime updates for this conversation.
    const unsubscribe = this.runtime.subscribeToUpdates(
      conversationId,
      (update: unknown) => {
        const u = update as Record<string, unknown>;
        const type = u["type"] as string | undefined;

        if (type === "agent-step") {
          const step = u["step"] as Record<string, unknown> | undefined;
          if (step) {
            const chunkType = (step["type"] as string) ?? "message";
            push({
              kind: "chunk",
              chunk: {
                type: chunkType as AcpResponseChunk["type"],
                data: step["data"],
                meta: { timestamp: Date.now() },
              },
            });
          }
        } else if (type === "agent-done") {
          push({ kind: "done" });
        } else if (type === "agent-error") {
          push({ kind: "error", error: (u["error"] as string) ?? "Unknown error" });
        }
        // Ignore 'created' and 'message-queued' – they aren't streaming chunks.
      },
    );

    // Register abort signal listener if provided.
    let onAbort: (() => void) | undefined;
    if (options?.signal) {
      onAbort = () => {
        void this.runtime.cancelAgent(conversationId);
        push({ kind: "done" });
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      // Fire the prompt into the runtime.
      await this.runtime.sendMessage({ conversationId, message: prompt });

      // Drain the queue until completion.
      while (!finished) {
        if (queue.length > 0) {
          const item = queue.shift()!;
          if (item.kind === "chunk") {
            session.messageCount++;
            yield item.chunk;
          } else if (item.kind === "done") {
            finished = true;
            if (item.kind === "error") {
              session.status = "error";
            } else {
              session.status = session.messageCount > 0 ? "completed" : "active";
            }
          }
        } else {
          await wait();
        }
      }
    } finally {
      if (onAbort && options?.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      unsubscribe();
    }
  }

  /** Get info for a single session. */
  getSession(sessionId: string): AcpSessionInfo | null {
    const session = this.sessions.get(sessionId);
    return session ? this.toSessionInfo(session) : null;
  }

  /** List all sessions. */
  listSessions(): AcpSessionInfo[] {
    return [...this.sessions.values()].map((s) => this.toSessionInfo(s));
  }

  /** Cancel a running session. */
  async cancelSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    await this.runtime.cancelAgent(session.conversationId);
    session.status = "cancelled";
    return true;
  }

  /** Clean up and dispose all sessions. */
  dispose(): void {
    this.sessions.clear();
  }

  private toSessionInfo(entry: SessionEntry): AcpSessionInfo {
    return {
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      conversationId: entry.conversationId,
      createdAt: entry.createdAt,
      messageCount: entry.messageCount,
      status: entry.status,
    };
  }
}
