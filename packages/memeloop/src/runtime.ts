import type { ChatMessage } from './conversation/index.js';
import type { ConversationMeta } from './sync/protocol.js';

import { registerBuiltinLoops } from './agentLoops/plugins/builtinLoopsPlugin.js';
import { registerBuiltinToolPlugins } from './agentLoops/plugins/builtinToolsPlugin.js';
import { getLoopRegistry } from './agentLoops/registry.js';
import type { AgentLoopGenerator, AgentLoopInput, LoopProfile } from './agentLoops/types.js';
import { getBuiltinLoopProfile } from './loopProfiles/loadBuiltins.js';
import { registerBuiltinPromptPlugins } from './promptUtilities/builtinPromptPlugins.js';
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
  subscribeToUpdates(conversationId: string, listener: (update: unknown) => void): () => void;
}

async function drainAgentLoop(
  gen: AgentLoopGenerator,
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

function inferDefinitionIdFromConversationId(conversationId: string): string {
  const parts = conversationId.split(':');
  if (parts.length >= 2) return parts.slice(0, -1).join(':');
  return conversationId;
}

async function resolveDefinitionId(
  context: AgentFrameworkContext,
  conversationId: string,
): Promise<string> {
  try {
    const meta = await context.storage.getConversationMeta(conversationId);
    if (meta?.definitionId) return meta.definitionId;
  } catch {
    /* optional for old storage adapters */
  }
  return inferDefinitionIdFromConversationId(conversationId);
}

async function resolveLoopProfile(
  context: AgentFrameworkContext,
  definitionId: string,
): Promise<LoopProfile | null> {
  const definition = (context.resolveAgentDefinition ? await context.resolveAgentDefinition(definitionId) : null) ??
    (await context.storage.getAgentDefinition(definitionId)) ??
    getBuiltinLoopProfile(definitionId) ??
    null;
  if (!definition) return null;
  return definition as unknown as LoopProfile;
}

async function createProfileRunner(
  context: AgentFrameworkContext,
  definitionId: string,
): Promise<((input: AgentLoopInput) => AgentLoopGenerator) | null> {
  const profile = await resolveLoopProfile(context, definitionId);
  if (!profile) return null;

  registerBuiltinLoops();
  registerBuiltinToolPlugins();
  registerBuiltinPromptPlugins(context.tools.getPromptPlugins?.());

  const runnerContext = {
    ...context,
    toolRegistry: context.tools,
  } as { [key: string]: unknown };
  return getLoopRegistry().createRunnerForProfile(profile, runnerContext);
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

  async function runAgentLoop(input: AgentLoopInput, definitionId: string): Promise<boolean> {
    const run = context.runTaskAgent ?? await createProfileRunner(context, definitionId);
    if (!run) return false;
    void drainAgentLoop(run(input), input.conversationId, notify);
    return true;
  }

  return {
    async createAgent(options) {
      const now = Date.now();
      const conversationId = `${options.definitionId}:${now.toString(36)}`;
      cancellation?.delete(conversationId);

      const meta: ConversationMeta = {
        conversationId,
        title: options.definitionId,
        lastMessagePreview: context.runTaskAgent ? '' : options.initialMessage ?? '',
        lastMessageTimestamp: now,
        messageCount: context.runTaskAgent || !options.initialMessage ? 0 : 1,
        originNodeId: 'local',
        definitionId: options.definitionId,
        isUserInitiated: true,
      };
      await context.storage.upsertConversationMetadata(meta);

      if (options.initialMessage) {
        const started = await runAgentLoop(
          { conversationId, message: options.initialMessage },
          options.definitionId,
        );
        if (started) {
          notify(conversationId, { type: 'created', conversationId });
          return { conversationId };
        }
      }

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
      const definitionId = await resolveDefinitionId(context, options.conversationId);
      const started = await runAgentLoop(
        { conversationId: options.conversationId, message: options.message },
        definitionId,
      );
      if (started) {
        notify(options.conversationId, { type: 'message-queued' });
        return;
      }

      const now = Date.now();
      const lamportClock = await nextLamportClockForConversation(
        context.storage,
        options.conversationId,
      );
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
