/**
 * AgentSessionController — headless controller for an active agent conversation session.
 *
 * Manages agent runtime state, message sending, streaming, delete/retry turns,
 * and subscription to live agent updates.
 *
 * No React, DOM, Electron, MUI, Zustand, or RxJS dependency.
 */

import type { ChatMessage } from '../conversation/index.js';
import type { AgentConversationClient, AgentInstanceClient, AgentRuntimeView, WikiTiddlerAttachment } from './types.js';

/** Read-only snapshot of the session state. */
export interface AgentSessionSnapshot {
  agent: AgentRuntimeView | null;
  loading: boolean;
  error: Error | null;
  messages: ChatMessage[];
  orderedMessageIds: string[];
  streamingMessageIds: Set<string>;
}

/** Listener for snapshot changes. */
export type AgentSessionListener = (snapshot: AgentSessionSnapshot) => void;

/** Options for creating an AgentSessionController. */
export interface AgentSessionControllerOptions {
  agentInstanceClient: AgentInstanceClient;
  conversationClient: AgentConversationClient;
  /** Polling interval in ms for agent status updates. Default 500. */
  pollInterval?: number;
}

/**
 * Headless controller for an agent conversation session.
 *
 * Call {@link start} to load an agent, then {@link subscribe} to receive snapshot
 * updates. Use {@link sendMessage}, {@link deleteTurn}, {@link retryTurn}, {@link cancel}
 * to drive the conversation.
 *
 * Host UI frameworks (React, Ink) subscribe via {@link subscribe} and render
 * the snapshot.
 */
export class AgentSessionController {
  private readonly options: Required<AgentSessionControllerOptions>;
  private listener: AgentSessionListener | null = null;
  private snapshot: AgentSessionSnapshot = {
    agent: null,
    loading: false,
    error: null,
    messages: [],
    orderedMessageIds: [],
    streamingMessageIds: new Set(),
  };
  private unsubAgentUpdates: (() => void) | null = null;
  private unsubMessages: (() => void) | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private agentId: string | null = null;

  constructor(options: AgentSessionControllerOptions) {
    this.options = {
      pollInterval: 500,
      ...options,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Start a session for the given agent ID.
   * Fetches the agent, subscribes to live updates, and loads messages.
   */
  async start(agentId: string): Promise<void> {
    this.agentId = agentId;
    this.emitPartial({ loading: true, error: null });

    try {
      const [agent, rawMessages] = await Promise.all([
        this.options.agentInstanceClient.fetchAgent(agentId),
        this.options.conversationClient.getMessages(agentId),
      ]);

      const orderedMessageIds = rawMessages.map((m) => m.messageId);
      const messagesMap = new Map<string, ChatMessage>();
      for (const m of rawMessages) messagesMap.set(m.messageId, m);

      this.emitPartial({
        agent,
        loading: false,
        messages: rawMessages,
        orderedMessageIds,
        streamingMessageIds: new Set(),
      });

      // Subscribe to live agent updates
      this.unsubAgentUpdates = this.options.agentInstanceClient.subscribeToUpdates(
        agentId,
        this.handleAgentUpdate,
      );

      // Subscribe to new messages
      this.unsubMessages = this.options.conversationClient.subscribeToMessages(
        agentId,
        this.handleNewMessage,
      );

      // Poll for status changes
      this.startPolling(agentId);
    } catch (error_) {
      this.emitPartial({
        loading: false,
        error: error_ instanceof Error ? error_ : new Error(String(error_)),
      });
    }
  }

  /** Stop the session and clean up subscriptions. */
  stop(): void {
    this.stopPolling();
    this.unsubAgentUpdates?.();
    this.unsubAgentUpdates = null;
    this.unsubMessages?.();
    this.unsubMessages = null;
    this.agentId = null;
  }

  // ── Actions ───────────────────────────────────────────────────

  /** Send a user message. */
  async sendMessage(
    content: string,
    file?: File,
    wikiTiddlers?: WikiTiddlerAttachment[],
  ): Promise<void> {
    if (!this.agentId) return;
    this.emitPartial({ error: null });
    try {
      await this.options.conversationClient.sendMessage(this.agentId, content, file, wikiTiddlers);
    } catch (error_) {
      this.emitPartial({
        error: error_ instanceof Error ? error_ : new Error(String(error_)),
      });
    }
  }

  /** Cancel the current agent operation. */
  async cancel(): Promise<void> {
    if (!this.agentId) return;
    try {
      await this.options.agentInstanceClient.cancelAgent(this.agentId);
    } catch (error_) {
      this.emitPartial({
        error: error_ instanceof Error ? error_ : new Error(String(error_)),
      });
    }
  }

  /** Delete a turn starting at the given user message ID. */
  async deleteTurn(userMessageId: string): Promise<string | undefined> {
    return this.options.conversationClient.deleteTurn(userMessageId);
  }

  /** Retry a turn starting at the given user message ID. */
  async retryTurn(userMessageId: string): Promise<void> {
    return this.options.conversationClient.retryTurn(userMessageId);
  }

  // ── Subscription ──────────────────────────────────────────────

  /** Subscribe to snapshot changes. Returns unsubscribe function. */
  subscribe(listener: AgentSessionListener): () => void {
    this.listener = listener;
    // Immediately emit current state
    listener({ ...this.snapshot, streamingMessageIds: new Set(this.snapshot.streamingMessageIds) });
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** Get current snapshot without subscribing. */
  getSnapshot(): AgentSessionSnapshot {
    return this.snapshot;
  }

  // ── Private helpers ───────────────────────────────────────────

  private emitPartial(partial: Partial<AgentSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    if (this.listener) {
      this.listener({
        ...this.snapshot,
        streamingMessageIds: new Set(this.snapshot.streamingMessageIds),
      });
    }
  }

  private handleAgentUpdate = (update: Partial<AgentRuntimeView>): void => {
    if (this.snapshot.agent) {
      this.emitPartial({ agent: { ...this.snapshot.agent, ...update } });
    }
  };

  private handleNewMessage = (message: ChatMessage): void => {
    const messages = [...this.snapshot.messages.filter((m) => m.messageId !== message.messageId), message];
    const orderedMessageIds = [...new Set([...this.snapshot.orderedMessageIds, message.messageId])];
    this.emitPartial({ messages, orderedMessageIds });
  };

  private startPolling(agentId: string): void {
    this.stopPolling();
    this.pollingTimer = setInterval(async () => {
      try {
        const agent = await this.options.agentInstanceClient.fetchAgent(agentId);
        this.emitPartial({ agent });
      } catch {
        // Silently retry on next poll
      }
    }, this.options.pollInterval);
  }

  private stopPolling(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }
}
