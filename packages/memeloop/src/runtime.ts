import type { ChatMessage } from './protocol/index.js';
import type { ConversationMeta } from './sync/protocol.js';

import type { TaskAgentGenerator } from './framework/taskAgentContract.js';
import { nextLamportClockForConversation } from './storage/nextLamport.js';
import type { AgentFrameworkContext } from './types.js';

export interface CreateAgentOptions {
  definitionId: string;
  initialMessage?: string;
}

export interface SendMessageOptions {
  conversationId: string;
  message: string;
}

export interface MemeLoopRuntime {
  createAgent(options: CreateAgentOptions): Promise<{ conversationId: string }>;
  sendMessage(options: SendMessageOptions): Promise<void>;
  cancelAgent(conversationId: string): Promise<void>;
  subscribeToUpdates(
    conversationId: string,
    listener: (update: unknown) => void,
  ): () => void;
}

async function drainTaskAgent(
  gen: TaskAgentGenerator,
  conversationId: string,
  notify: (conversationId: string, update: unknown) => void,
): Promise<void> {
  try {
    for await (const step of gen) {
      notify(conversationId, { type: 'agent-step', step });
    }
    notify(conversationId, { type: 'agent-done' });
  } catch (error) {
    notify(conversationId, {
      type: 'agent-error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createMemeLoopRuntime(context: AgentFrameworkContext): MemeLoopRuntime {
  const listeners = new Map<string, Set<(update: unknown) => void>>();
  const cancellation = context.conversationCancellation;

  function notify(conversationId: string, update: unknown) {
    const set = listeners.get(conversationId);
    if (!set) return;
    for (const listener of set) {
      listener(update);
    }
  }

  return {
    async createAgent(options) {
      const now = Date.now();
      const conversationId = `${options.definitionId}:${now.toString(36)}`;
      cancellation?.delete(conversationId);

      const run = context.runTaskAgent;

      if (run && options.initialMessage) {
        const meta: ConversationMeta = {
          conversationId,
          title: options.definitionId,
          lastMessagePreview: '',
          lastMessageTimestamp: now,
          messageCount: 0,
          originNodeId: 'local',
          definitionId: options.definitionId,
          isUserInitiated: true,
        };
        await context.storage.upsertConversationMetadata(meta);
        void drainTaskAgent(run({ conversationId, message: options.initialMessage }), conversationId, notify);
        notify(conversationId, { type: 'created', conversationId });
        return { conversationId };
      }

      if (run && !options.initialMessage) {
        const meta: ConversationMeta = {
          conversationId,
          title: options.definitionId,
          lastMessagePreview: '',
          lastMessageTimestamp: now,
          messageCount: 0,
          originNodeId: 'local',
          definitionId: options.definitionId,
          isUserInitiated: true,
        };
        await context.storage.upsertConversationMetadata(meta);
        notify(conversationId, { type: 'created', conversationId });
        return { conversationId };
      }

      const meta: ConversationMeta = {
        conversationId,
        title: options.definitionId,
        lastMessagePreview: options.initialMessage ?? '',
        lastMessageTimestamp: now,
        messageCount: options.initialMessage ? 1 : 0,
        originNodeId: 'local',
        definitionId: options.definitionId,
        isUserInitiated: true,
      };

      if (options.initialMessage) {
        const message: ChatMessage = {
          messageId: `${conversationId}:m1`,
          conversationId,
          originNodeId: meta.originNodeId,
          timestamp: now,
          lamportClock: 1,
          role: 'user',
          content: options.initialMessage,
        };
        await context.storage.appendMessage(message);
      }

      notify(conversationId, { type: 'created', conversationId });
      return { conversationId };
    },
    async sendMessage(options) {
      cancellation?.delete(options.conversationId);
      const run = context.runTaskAgent;
      if (run) {
        void drainTaskAgent(
          run({ conversationId: options.conversationId, message: options.message }),
          options.conversationId,
          notify,
        );
        notify(options.conversationId, { type: 'message-queued' });
        return;
      }

      const now = Date.now();
      const lamportClock = await nextLamportClockForConversation(context.storage, options.conversationId);
      const message: ChatMessage = {
        messageId: `${options.conversationId}:${now.toString(36)}`,
        conversationId: options.conversationId,
        originNodeId: 'local',
        timestamp: now,
        lamportClock,
        role: 'user',
        content: options.message,
      };
      await context.storage.appendMessage(message);
      notify(options.conversationId, { type: 'message-queued' });
    },
    async cancelAgent(conversationId) {
      cancellation?.add(conversationId);
      notify(conversationId, { type: 'cancelled' });
    },
    subscribeToUpdates(conversationId, listener) {
      const set = listeners.get(conversationId) ?? new Set();
      set.add(listener);
      listeners.set(conversationId, set);
      return () => {
        const current = listeners.get(conversationId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) {
          listeners.delete(conversationId);
        }
      };
    },
  };
}
