/**
 * Resolves host definitions and constructs profile runners with their plugin,
 * checkpoint, cancellation, and nested-script execution context.
 */
import { assertAgentModelConfig } from '../agent/types.js';
import { domainSeparatedCanonicalJsonBytes } from '../encoding/canonicalJson.js';
import { getBuiltinLoopProfile } from '../loopProfiles/loadBuiltins.js';
import type { ControlLeaseIdentity } from '../orchestration/controlStore.js';
import { registerBuiltinPromptPlugins } from '../promptUtilities/builtinPromptPlugins.js';
import { portableSha256Hex } from '../storage/atomicAgentRetry.js';
import { ToolApprovalBroker } from '../tools/approval.js';
import { QuestionWaitBroker } from '../tools/builtins/questionWaitRegistry.js';
import { RuntimeToolRegistry } from '../tools/runtimeToolRegistry.js';
import { ToolSchemaRegistry } from '../tools/schemaRegistry.js';
import type { AgentFrameworkContext, ResolveAgentDefinitionOptions } from '../types.js';
import { appendLocalMessageEvent, requireLocalNodeId } from './agent-tool-loop/localMessageEvent.js';
import { HookRegistry } from './hooks/registry.js';
import { registerBuiltinLoops } from './plugins/builtinLoopsPlugin.js';
import { registerBuiltinToolPlugins } from './plugins/builtinToolsPlugin.js';
import { type LoopRegistry, LoopRegistryImpl } from './registry.js';
import { createScriptCheckpointRuntime } from './scriptCheckpointRuntime.js';
import { createScriptMessagePersistence, type ScriptMessagePersistence } from './scriptMessagePersistence.js';
import type { AgentLoopGenerator, AgentLoopInput, AgentLoopRuntime, LoopCheckpointRecord, LoopProfile, LoopScriptCapabilities, LoopScriptCheckpoint } from './types.js';

export interface CreateAgentLoopRunnerOptions {
  definitionId: string;
  conversationId?: string;
}

export async function resolveDefinitionId(
  context: AgentFrameworkContext,
  conversationId: string,
  explicitDefinitionId?: string,
): Promise<string> {
  const meta = await context.storage.getConversationMeta(conversationId);
  const explicit = explicitDefinitionId?.trim();
  const persisted = meta?.definitionId?.trim();
  if (explicit && persisted && explicit !== persisted) {
    throw new Error(
      `Conversation ${conversationId} belongs to ${persisted}, not ${explicit}`,
    );
  }
  if (explicit) return explicit;
  if (persisted) return persisted;
  throw new Error(
    `Conversation ${conversationId} has no persisted definitionId; callers must provide one explicitly`,
  );
}

/** Persist the immutable profile identity before a script starts a child loop. */
async function ensureConversationDefinition(
  context: AgentFrameworkContext,
  conversationId: string,
  definitionId: string,
): Promise<void> {
  const existing = await context.storage.getConversationMeta(conversationId);
  if (existing) {
    await resolveDefinitionId(context, conversationId, definitionId);
    return;
  }
  await context.storage.appendLocalEvent({
    kind: 'metadataPatch',
    eventId: `metadata:child:${conversationId}`,
    conversationId,
    originNodeId: requireLocalNodeId(context),
    timestamp: Date.now(),
    patch: {
      title: definitionId,
      definitionId,
      isUserInitiated: false,
    },
  });
}

export async function resolveLoopProfile(
  context: Pick<AgentFrameworkContext, 'loopRegistry' | 'agentProfiles' | 'resolveAgentDefinition' | 'storage'>,
  definitionId: string,
  options?: ResolveAgentDefinitionOptions,
): Promise<LoopProfile | null> {
  const registered = context.loopRegistry?.getProfile(definitionId);
  if (registered) return registered;
  const agentProfile = context.agentProfiles?.getAgentProfile(definitionId);
  if (agentProfile) return normalizeResolvedLoopProfile(agentProfile.protocolDef);
  const definition = (context.resolveAgentDefinition
    ? await context.resolveAgentDefinition(definitionId, options)
    : null) ?? await context.storage.getAgentDefinition(definitionId);
  if (definition) return normalizeResolvedLoopProfile(definition);
  return getBuiltinLoopProfile(definitionId) ?? null;
}

function normalizeResolvedLoopProfile(value: unknown): LoopProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid resolved loop profile');
  }
  const definition = Object.fromEntries(Object.entries(value)) as Record<string, unknown>;
  for (const field of ['id', 'name', 'description'] as const) {
    if (typeof definition[field] !== 'string' || definition[field].trim().length === 0) {
      throw new Error(`Invalid ${field} in resolved loop profile`);
    }
  }
  if (
    definition.systemPrompt !== undefined && typeof definition.systemPrompt !== 'string' ||
    definition.version !== undefined && typeof definition.version !== 'string' ||
    definition.tools !== undefined && (
        !Array.isArray(definition.tools) ||
        definition.tools.some(tool => typeof tool !== 'string' || tool.length === 0)
      )
  ) {
    throw new Error(`Invalid resolved loop profile ${String(definition.id)}`);
  }
  const loopId = definition.loopId;
  if (loopId !== undefined && (typeof loopId !== 'string' || loopId.trim().length === 0)) {
    throw new Error(`Invalid loopId in resolved loop profile ${String(definition.id)}`);
  }
  const plugins = normalizeLoopProfilePlugins(definition.plugins, String(definition.id), 'plugins');
  const hookPlugins = normalizeLoopProfilePlugins(
    definition.hookPlugins,
    String(definition.id),
    'hookPlugins',
  );
  const scriptReference = normalizeLoopScriptReference(
    definition.scriptReference,
    String(definition.id),
  );
  let modelConfig: LoopProfile['modelConfig'];
  if (definition.modelConfig !== undefined) {
    assertAgentModelConfig(definition.modelConfig);
    modelConfig = { ...definition.modelConfig };
  }
  const tools = Array.isArray(definition.tools)
    ? (definition.tools as unknown[]).map(tool => tool as string)
    : undefined;
  if (
    definition.metadata !== undefined &&
    (definition.metadata === null || typeof definition.metadata !== 'object' ||
      Array.isArray(definition.metadata))
  ) {
    throw new Error(`Invalid metadata in resolved loop profile ${String(definition.id)}`);
  }
  const metadata = definition.metadata === undefined
    ? undefined
    : { ...(definition.metadata as Record<string, unknown>) };
  return {
    id: definition.id as string,
    name: definition.name as string,
    description: definition.description as string,
    ...(typeof definition.systemPrompt === 'string'
      ? { systemPrompt: definition.systemPrompt }
      : {}),
    ...(tools ? { tools } : {}),
    ...(modelConfig ? { modelConfig } : {}),
    ...(definition.agentFrameworkConfig && typeof definition.agentFrameworkConfig === 'object'
      ? { agentFrameworkConfig: definition.agentFrameworkConfig as LoopProfile['agentFrameworkConfig'] }
      : {}),
    ...(scriptReference ? { scriptReference } : {}),
    ...(typeof definition.version === 'string' ? { version: definition.version } : {}),
    ...(typeof loopId === 'string' ? { loopId } : {}),
    ...(plugins ? { plugins } : {}),
    ...(hookPlugins ? { hookPlugins } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeLoopScriptReference(
  value: unknown,
  profileId: string,
): LoopProfile['scriptReference'] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid scriptReference in resolved loop profile ${profileId}`);
  }
  const reference = Object.fromEntries(Object.entries(value)) as Record<string, unknown>;
  if (reference.kind === 'builtin' && typeof reference.id === 'string' && reference.id.length > 0) {
    return { kind: 'builtin', id: reference.id };
  }
  if (
    reference.kind === 'specifier' &&
    typeof reference.specifier === 'string' && reference.specifier.length > 0
  ) {
    return { kind: 'specifier', specifier: reference.specifier };
  }
  if (reference.kind === 'source' && typeof reference.source === 'string') {
    return {
      kind: 'source',
      source: reference.source,
      ...(typeof reference.name === 'string' ? { name: reference.name } : {}),
    };
  }
  throw new Error(`Invalid scriptReference in resolved loop profile ${profileId}`);
}

function normalizeLoopProfilePlugins(
  value: unknown,
  definitionId: string,
  field: 'plugins' | 'hookPlugins',
): LoopProfile['plugins'] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Invalid ${field} in agent definition ${definitionId}`);
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid ${field} entry in agent definition ${definitionId}`);
    }
    const item = Object.fromEntries(
      Object.entries(entry as Record<string, unknown>),
    ) as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.trim().length === 0) {
      throw new Error(`Invalid ${field} id in agent definition ${definitionId}`);
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      throw new Error(`Invalid ${field} enabled flag in agent definition ${definitionId}`);
    }
    if (
      item.config !== undefined &&
      (item.config === null || typeof item.config !== 'object' || Array.isArray(item.config))
    ) {
      throw new Error(`Invalid ${field} config in agent definition ${definitionId}`);
    }
    return {
      id: item.id,
      ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
      ...(item.config !== undefined ? { config: item.config as Record<string, unknown> } : {}),
    };
  });
}

async function createProfileRunner(
  context: AgentFrameworkContext,
  definitionId: string,
  runtime?: Partial<AgentLoopRuntime>,
  conversationId?: string,
): Promise<((input: AgentLoopInput) => AgentLoopGenerator) | null> {
  const profile = await resolveLoopProfile(
    context,
    definitionId,
    conversationId === undefined ? undefined : { conversationId },
  );
  if (!profile) return null;
  return createAgentProfileRunner(context, profile, runtime);
}

export function installRuntimePlugins(
  loopRegistry: LoopRegistry,
  target: { [key: string]: unknown },
): () => void {
  const disposers: Array<() => void> = [];
  try {
    for (const plugin of loopRegistry.listPlugins()) {
      if (plugin.activationScope !== 'runtime') continue;
      disposers.push(loopRegistry.installPluginsForLoop(
        plugin.targetLoopId ?? '*',
        target,
        [plugin.id],
      ));
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Runtime plugin activation failed and rollback was incomplete',
        { cause: error },
      );
    }
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Runtime plugin cleanup failed');
  };
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
  const preparedRuntime = context.tools instanceof RuntimeToolRegistry;
  const loopRegistry = preparedRuntime
    ? context.loopRegistry ?? new LoopRegistryImpl()
    : new LoopRegistryImpl();
  if (!preparedRuntime) {
    for (const loop of context.loopRegistry?.listLoops() ?? []) loopRegistry.registerLoop(loop);
    for (const registeredProfile of context.loopRegistry?.listProfiles() ?? []) {
      loopRegistry.registerProfile(registeredProfile);
    }
    for (const plugin of context.loopRegistry?.listPlugins() ?? []) {
      loopRegistry.registerPlugin(plugin);
    }
  }
  registerBuiltinLoops(loopRegistry);
  registerBuiltinToolPlugins(loopRegistry);
  if (preparedRuntime) {
    const promptPlugins = context.promptPlugins ?? context.tools.getPromptPlugins?.();
    if (promptPlugins) registerBuiltinPromptPlugins(promptPlugins);
    return loopRegistry.createRunnerForProfile(profile, {
      ...context,
      runtime,
      scriptPolicy: context.loopScriptPolicy,
      toolRegistry: context.tools,
    });
  }

  return async function* standaloneProfileRunner(input): AgentLoopGenerator {
    const hooks = context.hooks instanceof HookRegistry
      ? context.hooks.fork()
      : context.hooks ?? new HookRegistry();
    const toolSchemas = context.toolSchemas instanceof ToolSchemaRegistry
      ? context.toolSchemas.fork()
      : new ToolSchemaRegistry();
    const promptPlugins = new Map(
      context.promptPlugins ?? context.tools.getPromptPlugins?.() ?? [],
    );
    registerBuiltinPromptPlugins(promptPlugins);
    const tools = new RuntimeToolRegistry(context.tools, promptPlugins, toolSchemas);
    const runtimeId = context.runtimeId ??
      `${context.localNodeId ?? 'standalone'}:runner:${globalThis.crypto.randomUUID()}`;
    const ownsApprovalBroker = context.toolApprovals === undefined;
    const ownsQuestionWaits = context.questionWaits === undefined;
    const runnerContext: AgentFrameworkContext = {
      ...context,
      tools,
      loopRegistry,
      hooks,
      toolSchemas,
      promptPlugins,
      runtimeId,
      toolApprovals: context.toolApprovals ?? new ToolApprovalBroker({ runtimeId }),
      questionWaits: context.questionWaits ?? new QuestionWaitBroker(),
    };
    const target: { [key: string]: unknown } = {
      ...runnerContext,
      runtime,
      scriptPolicy: runnerContext.loopScriptPolicy,
      toolRegistry: tools,
    };
    const dispose = installRuntimePlugins(loopRegistry, target);
    try {
      const runner = loopRegistry.createRunnerForProfile(profile, target);
      if (!runner) throw new Error(`RUNNER_UNAVAILABLE:${profile.loopId ?? 'agent-tool-loop'}`);
      yield* runner(input);
    } finally {
      try {
        dispose();
      } finally {
        tools.dispose();
        if (ownsApprovalBroker) runnerContext.toolApprovals?.dispose();
        if (ownsQuestionWaits) runnerContext.questionWaits?.dispose();
        if (hooks instanceof HookRegistry && hooks !== context.hooks) hooks.clearHooks();
        toolSchemas.clear();
        promptPlugins.clear();
      }
    }
  };
}

/**
 * Create a loop runner for a profile with a fresh per-conversation script
 * runtime (state, checkpoints, cancellation, child propagation). Used by the
 * workload execution path where the profile is synthesized from
 * a resource rather than resolved from the definition store.
 */
export async function createAgentLoopScriptRunner(
  context: AgentFrameworkContext,
  profile: LoopProfile,
  conversationId: string,
): Promise<((input: AgentLoopInput) => AgentLoopGenerator) | null> {
  const cancellation = context.conversationCancellation ??= new Set<string>();
  const scriptState = new Map<string, unknown>();
  return createAgentProfileRunner(
    context,
    profile,
    createScriptRuntime(context, cancellation, scriptState, conversationId),
  );
}

export function createScriptRuntime(
  context: AgentFrameworkContext,
  cancellation: Set<string>,
  scriptState: Map<string, unknown>,
  conversationId: string,
  parentConversationId?: string,
  runId?: string,
  runCancellation?: ReadonlySet<string>,
  checkpointLocks: Map<string, Promise<unknown>> = new Map(),
  checkpointRecords: Map<string, LoopCheckpointRecord> = new Map(),
  onCheckpoint?: (checkpoint: LoopScriptCheckpoint, conversationId: string) => void,
  checkpointFencingEpoch?: number,
  checkpointLeasePrecondition?: () => ControlLeaseIdentity | undefined,
  output?: ScriptMessagePersistence,
): Partial<AgentLoopRuntime> {
  const checkpoints = createScriptCheckpointRuntime({
    conversationId,
    store: context.loopCheckpoints,
    fallbackScope: context.loopCheckpointScope,
    state: scriptState,
    locks: checkpointLocks,
    records: checkpointRecords,
    ...(checkpointFencingEpoch === undefined ? {} : { fencingEpoch: checkpointFencingEpoch }),
    ...(checkpointLeasePrecondition ? { leasePrecondition: checkpointLeasePrecondition } : {}),
    onAccepted: checkpoint => onCheckpoint?.(checkpoint, conversationId),
    output,
  });
  return {
    orchestration: context.orchestration,
    scriptDeployment: context.scriptDeployment,
    allocateChildRunId: output ? () => output.nextChildRunId() : undefined,
    runChildAgent: async function*(input) {
      await ensureConversationDefinition(context, input.conversationId, input.profileId);
      input.signal?.throwIfAborted();
      const childRunId = input.runId ?? output?.nextChildRunId() ?? globalThis.crypto.randomUUID();
      const userMessageId = `${childRunId}:child:${await (context.sha256Hex ?? portableSha256Hex)(domainSeparatedCanonicalJsonBytes('memeloop-child-turn-v1', {
        conversationId: input.conversationId,
        prompt: input.prompt,
      }))}`;
      const persistedUserMessage = await context.storage.getMessageById?.(input.conversationId, userMessageId) ??
        await appendLocalMessageEvent(context, {
          conversationId: input.conversationId,
          message: {
            messageId: userMessageId,
            turnId: userMessageId,
            role: 'user',
            content: input.prompt,
            parts: [{ type: 'text', text: input.prompt }],
          },
        });
      const childInput: AgentLoopInput = {
        conversationId: input.conversationId,
        message: input.prompt,
        persistedUserMessage,
        ...(input.signal ? { signal: input.signal } : {}),
        runId: childRunId,
      };
      const childOutput = createScriptMessagePersistence(context, childInput);
      const childRuntime = createScriptRuntime(
        context,
        cancellation,
        scriptState,
        input.conversationId,
        conversationId,
        runId,
        runCancellation,
        checkpointLocks,
        checkpointRecords,
        onCheckpoint,
        checkpointFencingEpoch,
        checkpointLeasePrecondition,
        childOutput,
      );
      const run = await createProfileRunner(context, input.profileId, childRuntime, input.conversationId);
      if (!run) {
        yield { type: 'message', data: `Child agent profile not found: ${input.profileId}` };
        return;
      }
      try {
        for await (const step of run(childInput)) {
          await childOutput.accept(step);
          yield step;
        }
      } finally {
        await childOutput.flush();
      }
    },
    log: (event, data) => context.logger?.debug?.(event, data),
    emit: step => output?.emit(step),
    signal: {
      get cancelled() {
        return (
          (runId ? runCancellation?.has(runId) === true : false) ||
          cancellation.has(conversationId) ||
          (parentConversationId ? cancellation.has(parentConversationId) : false)
        );
      },
    },
    ...checkpoints,
  };
}

/** Inspect the effective workflow without running its turn or installing plugins. */
export async function resolveAgentLoopCapabilities(
  context: Pick<AgentFrameworkContext, 'loopRegistry' | 'agentProfiles' | 'resolveAgentDefinition' | 'storage' | 'loopScriptPolicy'>,
  options: CreateAgentLoopRunnerOptions,
): Promise<LoopScriptCapabilities> {
  const profile = await resolveLoopProfile(context, options.definitionId, options.conversationId === undefined ? undefined : { conversationId: options.conversationId });
  if (!profile) return {};
  const registry = context.loopRegistry ?? new LoopRegistryImpl();
  registerBuiltinLoops(registry);
  const loop = registry.getLoop(profile.loopId ?? 'agent-tool-loop');
  return await loop?.resolveCapabilities?.({ profile, scriptPolicy: context.loopScriptPolicy }) ?? {};
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
    conversationId,
  );
}
