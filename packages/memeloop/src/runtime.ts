import type { ChatMessage } from './conversation/index.js';
import type { ConversationMeta } from './sync/protocol.js';

import { registerBuiltinLoops } from './loopAPI/plugins/builtinLoopsPlugin.js';
import { registerBuiltinToolPlugins } from './loopAPI/plugins/builtinToolsPlugin.js';
import { getLoopRegistry } from './loopAPI/registry.js';
import type { AgentLoopGenerator, AgentLoopInput, AgentLoopRuntime, LoopProfile } from './loopAPI/types.js';
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
  definitionId?: string;
  userMessage?: AgentLoopInput['userMessage'];
  resumeSession?: ChatMessage[];
}

export interface MemeLoopRuntime {
  createAgent(options: CreateAgentOptions): Promise<{ conversationId: string }>;
  sendMessage(options: SendMessageOptions): Promise<void>;
  cancelAgent(conversationId: string): Promise<void>;
  subscribeToUpdates(conversationId: string, listener: (update: unknown) => void): () => void;
}

export interface CreateAgentLoopRunnerOptions {
  definitionId: string;
  conversationId?: string;
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
  runtime?: Partial<AgentLoopRuntime>,
): Promise<((input: AgentLoopInput) => AgentLoopGenerator) | null> {
  const profile = await resolveLoopProfile(context, definitionId);
  if (!profile) return null;
  return createAgentProfileRunner(context, profile, runtime);
}

/**
 * Create a loop runner for an already-resolved profile. Registers builtin
 * loops/tools/prompts and threads the host script policy through, exactly
 * like the definition-based path.
 */
export async function createAgentProfileRunner(
  context: AgentFrameworkContext,
  profile: LoopProfile,
  runtime?: Partial<AgentLoopRuntime>,
): Promise<((input: AgentLoopInput) => AgentLoopGenerator) | null> {
  registerBuiltinLoops();
  registerBuiltinToolPlugins();
  registerBuiltinPromptPlugins(context.tools.getPromptPlugins?.());

  const runnerContext = {
    ...context,
    runtime,
    scriptPolicy: context.loopScriptPolicy,
    toolRegistry: context.tools,
  } as { [key: string]: unknown };
  return getLoopRegistry().createRunnerForProfile(profile, runnerContext);
}

/**
 * Create a loop runner for a profile with a fresh per-conversation script
 * runtime (state, checkpoints, cancellation, child propagation). Used by the
 * workload execution path (plan 24.14) where the profile is synthesized from
 * a resource rather than resolved from the definition store.
 */
export async function createAgentLoopScriptRunner(
  context: AgentFrameworkContext,
  profile: LoopProfile,
  conversationId: string,
): Promise<((input: AgentLoopInput) => AgentLoopGenerator) | null> {
  const cancellation = context.conversationCancellation ?? new Set<string>();
  context.conversationCancellation ??= cancellation;
  const scriptState = new Map<string, unknown>();
  return createAgentProfileRunner(
    context,
    profile,
    createScriptRuntime(context, cancellation, scriptState, conversationId),
  );
}

function createScriptRuntime(
  context: AgentFrameworkContext,
  cancellation: Set<string>,
  scriptState: Map<string, unknown>,
  conversationId: string,
  parentConversationId?: string,
): Partial<AgentLoopRuntime> {
  const stateKey = (key: string): string => `${conversationId}:${key}`;
  return {
    orchestration: context.orchestration,
    scriptDeployment: context.scriptDeployment,
    runChildAgent: async function*(input) {
      const childRuntime = createScriptRuntime(
        context,
        cancellation,
        scriptState,
        input.conversationId,
        conversationId,
      );
      const run = await createProfileRunner(context, input.profileId, childRuntime);
      if (!run) {
        yield {
          type: 'message',
          data: `Child agent profile not found: ${input.profileId}`,
        };
        return;
      }
      yield* run({ conversationId: input.conversationId, message: input.prompt });
    },
    log: (event, data) => context.logger?.debug?.(event, data),
    emit: () => undefined,
    signal: {
      get cancelled() {
        return cancellation.has(conversationId) || (parentConversationId ? cancellation.has(parentConversationId) : false);
      },
    },
    state: {
      get: async <T>(key: string) => {
        const local = scriptState.get(stateKey(key)) as T | undefined;
        if (local !== undefined) return local;
        const persisted = await context.loopCheckpoints?.loadCheckpoint<T>(conversationId, `state:${key}`);
        if (persisted !== undefined) scriptState.set(stateKey(key), persisted);
        return persisted;
      },
      set: async (key, value) => {
        scriptState.set(stateKey(key), value);
        await context.loopCheckpoints?.saveCheckpoint(conversationId, `state:${key}`, value);
      },
      update: async (key, updater) => {
        const fullKey = stateKey(key);
        const previous = scriptState.get(fullKey);
        const next = updater(previous);
        scriptState.set(fullKey, next);
        await context.loopCheckpoints?.saveCheckpoint(conversationId, `state:${key}`, next);
      },
    },
    checkpoint: async (key, result) => {
      scriptState.set(stateKey(`checkpoint:${key}`), result);
      await context.loopCheckpoints?.saveCheckpoint(conversationId, key, result);
    },
    loadCheckpoint: async <T>(key: string) => {
      const memoryKey = stateKey(`checkpoint:${key}`);
      if (scriptState.has(memoryKey)) return scriptState.get(memoryKey) as T;
      const result = await context.loopCheckpoints?.loadCheckpoint<T>(conversationId, key);
      if (result !== undefined) scriptState.set(memoryKey, result);
      return result;
    },
  };
}

export async function createAgentLoopRunner(
  context: AgentFrameworkContext,
  options: CreateAgentLoopRunnerOptions,
): Promise<((input: AgentLoopInput) => AgentLoopGenerator) | null> {
  const cancellation = context.conversationCancellation ?? new Set<string>();
  context.conversationCancellation ??= cancellation;
  const scriptState = new Map<string, unknown>();
  const conversationId = options.conversationId ?? options.definitionId;
  return createProfileRunner(
    context,
    options.definitionId,
    createScriptRuntime(context, cancellation, scriptState, conversationId),
  );
}

export function createMemeLoopRuntime(context: AgentFrameworkContext): MemeLoopRuntime {
  const listeners = new Map<string, Set<(update: unknown) => void>>();
  const cancellation = context.conversationCancellation ?? new Set<string>();
  const scriptState = new Map<string, unknown>();
  context.conversationCancellation ??= cancellation;

  function notify(conversationId: string, update: unknown) {
    const set = listeners.get(conversationId);
    if (!set) return;
    for (const listener of set) {
      listener(update);
    }
  }

  async function runAgentLoop(input: AgentLoopInput, definitionId: string): Promise<boolean> {
    const run = context.runAgentToolLoop ?? await createProfileRunner(
      context,
      definitionId,
      createScriptRuntime(context, cancellation, scriptState, input.conversationId),
    );
    if (!run) return false;
    void drainAgentLoop(run(input), input.conversationId, notify);
    return true;
  }

  async function* runChildAgent(input: Parameters<NonNullable<AgentFrameworkContext['runChildAgent']>>[0]): AgentLoopGenerator {
    const run = await createProfileRunner(
      context,
      input.profileId,
      createScriptRuntime(context, cancellation, scriptState, input.conversationId),
    );
    if (!run) {
      yield {
        type: 'message',
        data: `Child agent profile not found: ${input.profileId}`,
      };
      return;
    }
    yield* run({ conversationId: input.conversationId, message: input.prompt });
  }

  context.runChildAgent ??= runChildAgent;

  return {
    async createAgent(options) {
      const now = Date.now();
      const conversationId = `${options.definitionId}:${now.toString(36)}`;
      cancellation?.delete(conversationId);

      const meta: ConversationMeta = {
        conversationId,
        title: options.definitionId,
        lastMessagePreview: context.runAgentToolLoop ? '' : options.initialMessage ?? '',
        lastMessageTimestamp: now,
        messageCount: context.runAgentToolLoop || !options.initialMessage ? 0 : 1,
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
      const definitionId = options.definitionId ?? await resolveDefinitionId(context, options.conversationId);
      const started = await runAgentLoop(
        {
          conversationId: options.conversationId,
          message: options.message,
          userMessage: options.userMessage,
          resumeSession: options.resumeSession,
        },
        definitionId,
      );
      if (started) {
        notify(options.conversationId, { type: 'message-queued' });
        return;
      }

      if (options.resumeSession && options.resumeSession.length > 0) {
        await context.storage.insertMessagesIfAbsent(options.resumeSession);
      }

      const now = Date.now();
      const lamportClock = await nextLamportClockForConversation(
        context.storage,
        options.conversationId,
      );
      const hostUserMessage = options.userMessage;
      const message: ChatMessage = {
        ...hostUserMessage,
        messageId: hostUserMessage?.messageId ?? `${options.conversationId}:${now.toString(36)}`,
        conversationId: options.conversationId,
        originNodeId: hostUserMessage?.originNodeId ?? 'local',
        timestamp: hostUserMessage?.timestamp ?? now,
        lamportClock: hostUserMessage?.lamportClock ?? lamportClock,
        role: 'user',
        content: hostUserMessage?.content ?? options.message,
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
