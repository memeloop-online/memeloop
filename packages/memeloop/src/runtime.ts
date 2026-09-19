import { assertAgentModelConfig, resolveAgentModelConfig } from './agent/types.js';
import {
  assertCanonicalConversationEvent,
  buildCanonicalChatMessageParts,
  type ChatMessage,
  type ConversationEventDraft,
  conversationEventToMessage,
  type ConversationMessageEvent,
  type ConversationMessagePayload,
  type ConversationTombstoneEvent,
  projectChatMessageParts,
} from './conversation/index.js';
import { domainSeparatedCanonicalJsonBytes } from './encoding/canonicalJson.js';
import { resolveAgentModelRoute, type ResolvedAgentModelRoute } from './llm/prepareModelRequest.js';

import { AgentProfileRegistry } from './agent/agentProfileRegistry.js';
import { appendLocalMessageEvent, requireLocalNodeId } from './loopAPI/agent-tool-loop/localMessageEvent.js';
import { HookRegistry } from './loopAPI/hooks/registry.js';
import { registerBuiltinLoops } from './loopAPI/plugins/builtinLoopsPlugin.js';
import { registerBuiltinToolPlugins } from './loopAPI/plugins/builtinToolsPlugin.js';
import { type LoopRegistry, LoopRegistryImpl } from './loopAPI/registry.js';
import { createScriptCheckpointRuntime } from './loopAPI/scriptCheckpointRuntime.js';
import type { AgentLoopGenerator, AgentLoopInput, AgentLoopRuntime, AgentLoopStep, LoopCheckpointRecord, LoopProfile, LoopScriptCheckpoint } from './loopAPI/types.js';
import { getBuiltinLoopProfile } from './loopProfiles/loadBuiltins.js';
import { registerBuiltinPromptPlugins } from './promptUtilities/builtinPromptPlugins.js';
import { agentRunErrorFromUnknown, AgentRunFailure, MemoryAgentRunStateStore } from './runState.js';
import type { AgentRunError, AgentRunRecord, AgentRunState, AgentRunStateStore } from './runState.js';
import { safeErrorMessageFromUnknown } from './safeError.js';
import {
  assertAtomicAgentRetryResult,
  type AtomicAgentRetryInput,
  createAtomicAgentRetryEventDrafts,
  createAtomicAgentRetryReplacementPayload,
  digestAtomicAgentRetryPayload,
  isAtomicAgentRetryStore,
  portableSha256Hex,
  type Sha256HexProvider,
} from './storage/atomicAgentRetry.js';
import { ToolApprovalBroker } from './tools/approval.js';
import { QuestionWaitBroker } from './tools/builtins/questionWaitRegistry.js';
import { RuntimeToolRegistry } from './tools/runtimeToolRegistry.js';
import { ToolSchemaRegistry } from './tools/schemaRegistry.js';
import type { AgentFrameworkContext, ResolveAgentDefinitionOptions } from './types.js';
import { assertPendingAgentUserMessageWithinLimits } from './userMessageAdmission.js';

export interface CreateAgentOptions {
  definitionId: string;
  initialMessage?: string;
  /** Host-stable conversation identity. Reusing it opens the durable conversation idempotently. */
  conversationId?: string;
}

export interface SendMessageOptions {
  conversationId: string;
  message: string;
  definitionId?: string;
  userMessage?: AgentLoopInput['userMessage'];
  /** Caller-stable idempotency key. Local callers may omit it to create a new run. */
  requestId?: string;
  /** Authenticated caller identity. RPC hosts must bind this to the verified peer. */
  requestPeerId?: string;
  /** Caller-selected user-root turn identity; must equal the persisted user messageId. */
  turnId?: string;
}

/** Durable turn identity is the only retry input; content is loaded by the target host. */
export interface RetryTurnOptions {
  conversationId: string;
  turnId: string;
  newTurnId: string;
  requestId: string;
  definitionId?: string;
  /** Authenticated caller identity. RPC hosts bind this to the verified peer. */
  requestPeerId?: string;
}

export type MemeLoopRunState = AgentRunState;

export interface MemeLoopRunHandle {
  runId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  state: 'accepted';
}

export type MemeLoopRunStatus = AgentRunRecord;

export interface MemeLoopRetryTurnResult {
  handle: MemeLoopRunHandle;
  tombstone: ConversationTombstoneEvent;
  userEvent: ConversationMessageEvent;
}

export type MemeLoopRuntimeUpdate =
  | { type: 'created'; conversationId: string }
  | { type: 'message-queued'; conversationId: string; runId: string }
  | { type: 'agent-step'; conversationId: string; runId?: string; step: AgentLoopStep }
  | { type: 'checkpoint-accepted'; conversationId: string; runId?: string; checkpoint: LoopScriptCheckpoint }
  | { type: 'agent-done'; conversationId: string; runId?: string }
  | { type: 'agent-error'; conversationId: string; runId?: string; error: AgentRunError }
  | { type: 'cancelled'; conversationId: string; runId?: string };

type MemeLoopRuntimeUpdatePayload = MemeLoopRuntimeUpdate extends infer Update ? Update extends MemeLoopRuntimeUpdate ? Omit<Update, 'conversationId'> : never
  : never;

export interface CreateMemeLoopRuntimeOptions {
  /** Durable store required by production hosts. */
  runStateStore?: AgentRunStateStore;
  /** Explicit opt-in for unit tests and intentionally ephemeral embedders. */
  allowEphemeralRunState?: boolean;
  /** Injectable cryptographically-strong durable ID source (deterministic tests). */
  idFactory?: () => string;
  /** Cooperative shutdown deadline; primarily injectable for deterministic tests. */
  disposeTimeoutMs?: number;
  /**
   * Explicit plugin fallback for genuinely separate run/event stores.
   * First-party production hosts implement AtomicAgentRetryStore instead.
   */
  allowNonAtomicRetry?: boolean;
  /** Native hosts may inject a non-blocking platform SHA-256 implementation. */
  sha256Hex?: Sha256HexProvider;
}

/** A host-visible checkpoint after the durable store accepted it. */
export interface MemeLoopCheckpoint {
  conversationId: string;
  runId?: string;
  checkpoint: LoopScriptCheckpoint;
}

export interface WaitForCheckpointOptions {
  conversationId: string;
  runId?: string;
  checkpointId?: string;
  key?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Raised when a durable checkpoint belongs to a different script identity. */
export { LoopCheckpointIdentityMismatchError } from './loopAPI/scriptCheckpointRuntime.js';

export type MemeLoopRuntimeShutdownErrorCode = 'SHUTDOWN_FAILED' | 'SHUTDOWN_TIMEOUT';

/** Stable lifecycle failure raised after the runtime has forced local resource cleanup. */
export class MemeLoopRuntimeShutdownError extends Error {
  constructor(public readonly code: MemeLoopRuntimeShutdownErrorCode) {
    super(
      code === 'SHUTDOWN_TIMEOUT'
        ? 'MemeLoopRuntime shutdown timed out with active work'
        : 'MemeLoopRuntime shutdown failed',
    );
    this.name = 'MemeLoopRuntimeShutdownError';
  }
}

export interface MemeLoopRuntime {
  createAgent(options: CreateAgentOptions): Promise<{ conversationId: string }>;
  sendMessage(options: SendMessageOptions): Promise<MemeLoopRunHandle>;
  /** Indexed, durable, idempotent retry that never accepts caller-supplied message content. */
  retryTurn(options: RetryTurnOptions): Promise<MemeLoopRetryTurnResult>;
  getRunStatus(runId: string): Promise<MemeLoopRunStatus | undefined>;
  cancelRun(runId: string): Promise<boolean>;
  cancelAgent(conversationId: string): Promise<void>;
  /** Wait until a matching checkpoint has been durably accepted by this runtime. */
  waitForCheckpoint(options: WaitForCheckpointOptions): Promise<MemeLoopCheckpoint>;
  /** Record that a host observer has consumed one accepted checkpoint. */
  ackCheckpoint(checkpoint: MemeLoopCheckpoint): boolean;
  /** Runtime-scoped nested-agent execution capability for trusted host adapters. */
  runChildAgent(
    input: Parameters<NonNullable<AgentFrameworkContext['runChildAgent']>>[0],
  ): AgentLoopGenerator;
  /** Stop active work and release runtime-owned listeners, timers, and state. */
  dispose(): Promise<void>;
  subscribeToUpdates(
    conversationId: string,
    listener: (update: MemeLoopRuntimeUpdate) => void,
  ): () => void;
}

export interface CreateAgentLoopRunnerOptions {
  definitionId: string;
  conversationId?: string;
}

async function drainAgentLoop(
  createGenerator: () => AgentLoopGenerator | Promise<AgentLoopGenerator>,
  conversationId: string,
  notify: (
    conversationId: string,
    update: MemeLoopRuntimeUpdatePayload,
  ) => void,
  runId?: string,
  lifecycle?: {
    /** False means another durable transition (normally cancellation) won. */
    running(): boolean | Promise<boolean>;
    completed(): boolean | Promise<boolean>;
    failed(error: unknown): boolean | Promise<boolean>;
    opened?(iterator: AsyncIterator<AgentLoopStep>): void;
    closed?(): void;
  },
  logger?: Pick<NonNullable<AgentFrameworkContext['logger']>, 'error'>,
): Promise<void> {
  try {
    if (lifecycle && !(await lifecycle.running())) return;
    const gen = await createGenerator();
    const iterator = gen[Symbol.asyncIterator]();
    lifecycle?.opened?.(iterator);
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      const step = item.value;
      notify(conversationId, { type: 'agent-step', ...(runId ? { runId } : {}), step });
    }
    if (!lifecycle || await lifecycle.completed()) {
      notify(conversationId, { type: 'agent-done', ...(runId ? { runId } : {}) });
    }
  } catch (error) {
    const runError = agentRunErrorFromUnknown(error);
    const failed = !lifecycle || await lifecycle.failed(runError);
    safeLogLoopFailure(logger, {
      conversationId,
      ...(runId === undefined ? {} : { runId }),
      diagnosticId: runError.diagnosticId,
      errorType: safeErrorType(error),
      ...safeErrorStackFrames(error),
    });
    if (failed) {
      notify(conversationId, {
        type: 'agent-error',
        ...(runId ? { runId } : {}),
        error: runError,
      });
    }
  } finally {
    lifecycle?.closed?.();
  }
}

/**
 * Logs only stack frames: the first stack line commonly embeds untrusted error
 * text (provider payloads, prompts, or tokens) and must not leave the host.
 */
const MAX_DIAGNOSTIC_STACK_FRAMES = 6;
const MAX_DIAGNOSTIC_STACK_FRAME_BYTES = 256;
const MAX_DIAGNOSTIC_STACK_BYTES = 16 * 1024;
const STACK_LOCATION = /^\s*at\s+(?:.*?\s+\()?((?:node:|file:|\/|[A-Za-z]:\\)[^()\s]*:\d+:\d+)\)?\s*$/u;
const SAFE_ERROR_TYPES = new Set([
  'AbortError',
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'name');
  const name: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  return typeof name === 'string' && SAFE_ERROR_TYPES.has(name) ? name : 'Error';
}

function safeErrorStackFrames(error: unknown): { stackFrames?: string[] } {
  if (!(error instanceof Error)) return {};
  let stack: unknown;
  try {
    stack = error.stack;
  } catch {
    return {};
  }
  if (typeof stack !== 'string') return {};
  const frames = stack.slice(0, MAX_DIAGNOSTIC_STACK_BYTES).split('\n')
    .map(line => line.match(STACK_LOCATION)?.[1])
    .filter((location): location is string => location !== undefined && new TextEncoder().encode(location).byteLength <= MAX_DIAGNOSTIC_STACK_FRAME_BYTES)
    .slice(0, MAX_DIAGNOSTIC_STACK_FRAMES)
    .map(location => `at ${location}`);
  return frames.length === 0 ? {} : { stackFrames: frames };
}

function safeLogLoopFailure(
  logger: Pick<NonNullable<AgentFrameworkContext['logger']>, 'error'> | undefined,
  metadata: Record<string, unknown>,
): void {
  try {
    logger?.error?.('MemeLoopRuntime agent loop failed', metadata);
  } catch {
    try {
      console.warn('MemeLoopRuntime agent loop diagnostic logger failed');
    } catch {
      return;
    }
  }
}

async function digestRunPayload(
  value: unknown,
  sha256Hex: Sha256HexProvider,
): Promise<string> {
  const bytes = domainSeparatedCanonicalJsonBytes('memeloop-run-payload-v1', value, {
    maxDepth: 64,
    maxNodes: 50_000,
    maxStringCodeUnits: 1_048_576,
    maxStringBytes: 1_048_576,
    maxBytes: 2 * 1_048_576,
  });
  return sha256Hex(bytes);
}

async function resolveDefinitionId(
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

async function resolveLoopProfile(
  context: AgentFrameworkContext,
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

function installRuntimePlugins(
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
 * workload execution path (plan 24.14) where the profile is synthesized from
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

function createScriptRuntime(
  context: AgentFrameworkContext,
  cancellation: Set<string>,
  scriptState: Map<string, unknown>,
  conversationId: string,
  parentConversationId?: string,
  runId?: string,
  runCancellation?: ReadonlySet<string>,
  checkpointLocks: Map<string, Promise<unknown>> = new Map(),
  checkpointRecords: Map<string, LoopCheckpointRecord> = new Map(),
  onCheckpoint?: (checkpoint: LoopScriptCheckpoint) => void,
): Partial<AgentLoopRuntime> {
  const checkpoints = createScriptCheckpointRuntime({
    conversationId,
    store: context.loopCheckpoints,
    fallbackScope: context.loopCheckpointScope,
    state: scriptState,
    locks: checkpointLocks,
    records: checkpointRecords,
    onAccepted: onCheckpoint,
  });
  return {
    orchestration: context.orchestration,
    scriptDeployment: context.scriptDeployment,
    runChildAgent: async function*(input) {
      await ensureConversationDefinition(context, input.conversationId, input.profileId);
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
      );
      const run = await createProfileRunner(
        context,
        input.profileId,
        childRuntime,
        input.conversationId,
      );
      if (!run) {
        yield {
          type: 'message',
          data: `Child agent profile not found: ${input.profileId}`,
        };
        return;
      }
      input.signal?.throwIfAborted();
      yield* run({
        conversationId: input.conversationId,
        message: input.prompt,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
      });
    },
    log: (event, data) => context.logger?.debug?.(event, data),
    emit: () => undefined,
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

export function createMemeLoopRuntime(
  callerContext: AgentFrameworkContext,
  options: CreateMemeLoopRuntimeOptions = {},
): MemeLoopRuntime {
  // Runtime-owned registries, brokers, and callbacks must never leak through
  // a caller-owned context reused by another runtime. An explicitly supplied
  // cancellation set is a host service and remains shared with that host.
  // Explicit host services (notably storage, network, model providers, and the
  // host tool registry) remain caller-owned and are never disposed here. Core
  // tools are installed into a runtime-local overlay over the host registry.
  const context: AgentFrameworkContext = { ...callerContext };
  const MAX_TRACKED_RUNS = 1024;
  const RUN_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
  const disposeTimeoutMs = options.disposeTimeoutMs ?? 5_000;
  const allowNonAtomicRetry = options.allowNonAtomicRetry === true || options.allowEphemeralRunState === true;
  const sha256Hex = options.sha256Hex ?? callerContext.sha256Hex ?? portableSha256Hex;
  context.sha256Hex = sha256Hex;
  if (!Number.isSafeInteger(disposeTimeoutMs) || disposeTimeoutMs < 10 || disposeTimeoutMs > 60_000) {
    throw new Error('disposeTimeoutMs must be a safe integer between 10 and 60000');
  }
  const listeners = new Map<string, Set<(update: MemeLoopRuntimeUpdate) => void>>();
  const runs = new Map<string, MemeLoopRunStatus>();
  const runWrites = new Map<string, Promise<void>>();
  const runProcesses = new Map<string, Promise<void>>();
  const retryPersistence = new Map<
    string,
    Promise<{
      tombstone: ConversationTombstoneEvent;
      userEvent: ConversationMessageEvent;
      persistedUserMessage: ChatMessage;
    }>
  >();
  const retryRequests = new Map<string, {
    fingerprint: string;
    promise: Promise<MemeLoopRetryTurnResult>;
  }>();
  const conversationRunQueues = new Map<string, Promise<void>>();
  const runDrains = new Map<string, Promise<void>>();
  const runGenerators = new Map<string, AsyncIterator<AgentLoopStep>>();
  const runProfiles = new Map<string, LoopProfile>();
  const runModelRoutes = new Map<string, ResolvedAgentModelRoute>();
  const runAbortControllers = new Map<string, AbortController>();
  const acceptedCheckpoints = new Map<string, MemeLoopCheckpoint>();
  const checkpointAcks = new Set<string>();
  const checkpointWaiters = new Set<{
    options: WaitForCheckpointOptions;
    resolve: (checkpoint: MemeLoopCheckpoint) => void;
    reject: (reason: unknown) => void;
    cleanup: () => void;
  }>();
  const runCancellation = new Set(callerContext.runCancellation ?? []);
  let disposed = false;
  let shuttingDown = false;
  let disposePromise: Promise<void> | undefined;
  let activeOperations = 0;
  const operationDrainWaiters = new Set<() => void>();
  const configuredRunStateStore = options.runStateStore ?? context.runStateStore ??
    (options.allowEphemeralRunState ? new MemoryAgentRunStateStore() : undefined);
  if (!configuredRunStateStore) {
    throw new Error(
      'createMemeLoopRuntime requires a durable runStateStore ' +
        '(tests/ephemeral embedders may set allowEphemeralRunState)',
    );
  }
  const runStateStore: AgentRunStateStore = configuredRunStateStore;
  const idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  const cancellation = callerContext.conversationCancellation ??= new Set<string>();
  const runtimeCancellationMarkers = new Set<string>();
  const localNodeId = requireLocalNodeId(context);
  context.conversationCancellation = cancellation;
  context.runCancellation = runCancellation;
  context.runStateStore ??= runStateStore;

  function nextDurableId(prefix: 'conversation' | 'request' | 'run' | 'turn'): string {
    const value = idFactory().trim();
    if (
      value.length < 8 ||
      value.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    ) {
      throw new Error('MemeLoopRuntime idFactory must return an 8-128 character UUID-like ID');
    }
    return `${prefix}:${value}`;
  }
  const localLoopRegistry = new LoopRegistryImpl();
  for (const loop of context.loopRegistry?.listLoops() ?? []) localLoopRegistry.registerLoop(loop);
  for (const profile of context.loopRegistry?.listProfiles() ?? []) {
    localLoopRegistry.registerProfile(profile);
  }
  for (const plugin of context.loopRegistry?.listPlugins() ?? []) localLoopRegistry.registerPlugin(plugin);
  context.loopRegistry = localLoopRegistry;
  const ownsHookRegistry = context.hooks === undefined || context.hooks instanceof HookRegistry;
  if (context.hooks instanceof HookRegistry) context.hooks = context.hooks.fork();
  const ownsToolSchemas = context.toolSchemas === undefined || context.toolSchemas instanceof ToolSchemaRegistry;
  if (context.toolSchemas instanceof ToolSchemaRegistry) context.toolSchemas = context.toolSchemas.fork();
  context.promptPlugins = new Map(
    context.promptPlugins ?? context.tools.getPromptPlugins?.() ?? [],
  );
  const ownsApprovalBroker = context.toolApprovals === undefined;
  const ownsQuestionWaits = context.questionWaits === undefined;
  const localAgentProfiles = new AgentProfileRegistry();
  for (const profile of context.agentProfiles?.listAgentProfiles() ?? []) {
    localAgentProfiles.replaceAgentProfile(profile);
  }
  context.hooks ??= new HookRegistry();
  context.toolSchemas ??= new ToolSchemaRegistry();
  context.runtimeId ??= `${localNodeId}:runtime:${nextDurableId('run')}`;
  context.toolApprovals ??= new ToolApprovalBroker({
    runtimeId: context.runtimeId,
    onListenerError: (_error, request) =>
      context.logger?.warn?.(
        '[tool-approval] listener failed',
        { approvalId: request.approvalId, runId: request.runId, toolName: request.toolName },
      ),
  });
  context.questionWaits ??= new QuestionWaitBroker();
  context.agentProfiles = localAgentProfiles;
  const runtimeTools = new RuntimeToolRegistry(
    context.tools,
    context.promptPlugins,
    context.toolSchemas,
  );
  context.tools = runtimeTools;
  registerBuiltinLoops(localLoopRegistry);
  registerBuiltinToolPlugins(localLoopRegistry);
  registerBuiltinPromptPlugins(context.promptPlugins);
  const runtimePluginTarget: { [key: string]: unknown } = {
    ...context,
    toolRegistry: runtimeTools,
  };
  let disposeRuntimePlugins: () => void;
  try {
    disposeRuntimePlugins = installRuntimePlugins(localLoopRegistry, runtimePluginTarget);
  } catch (error) {
    try {
      localLoopRegistry.reset();
    } finally {
      runtimeTools.dispose();
      if (ownsApprovalBroker) context.toolApprovals?.dispose();
      if (ownsQuestionWaits) context.questionWaits?.dispose();
    }
    throw error;
  }

  const recovery = (async (): Promise<void> => {
    const interrupted = await runStateStore.listActive();
    const now = Date.now();
    for (const record of interrupted) {
      if (context.storage.getMessageById) {
        try {
          const persistedUserMessage = await context.storage.getMessageById(
            record.conversationId,
            record.turnId,
          );
          if (persistedUserMessage) {
            const userRoot = assertRetryUserRoot(
              persistedUserMessage,
              record.conversationId,
              record.turnId,
            );
            const { resolvedProfile, resolvedModelRoute } = await resolveRunExecution(
              record.conversationId,
              record.definitionId,
            );
            runs.set(record.runId, record);
            if (resolvedProfile) runProfiles.set(record.runId, resolvedProfile);
            if (resolvedModelRoute) runModelRoutes.set(record.runId, resolvedModelRoute);
            scheduleRecoveredRun(record, {
              conversationId: record.conversationId,
              definitionId: record.definitionId,
              message: userRoot.content,
              requestPeerId: record.requestPeerId,
              requestId: record.requestId,
              turnId: record.turnId,
              userMessage: createAtomicAgentRetryReplacementPayload(userRoot, record.turnId),
            }, userRoot);
            continue;
          }
        } catch (error) {
          context.logger?.warn?.(
            '[runtime] run recovery deferred',
            {
              runId: record.runId,
              conversationId: record.conversationId,
              error: safeErrorMessageFromUnknown(error, { fallback: 'run recovery deferred' }),
            },
          );
        }
      }
      // Keep an active record durable when the user root is not locally
      // readable yet. A replicated event store can make it available later;
      // converting it to INTERRUPTED would permanently discard a resumable
      // checkpoint boundary.
      runs.set(record.runId, record);
    }
    await runStateStore.prune({
      finishedBefore: now - RUN_STATUS_TTL_MS,
      maxRecords: MAX_TRACKED_RUNS,
    });
  })();

  function assertActive(): void {
    if (disposed) throw new Error('MemeLoopRuntime has been disposed');
    if (shuttingDown) throw new Error('MemeLoopRuntime is shutting down');
  }

  async function withActiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    assertActive();
    activeOperations += 1;
    try {
      return await operation();
    } finally {
      activeOperations -= 1;
      if (activeOperations === 0) {
        for (const resolve of [...operationDrainWaiters]) resolve();
        operationDrainWaiters.clear();
      }
    }
  }

  async function waitForActiveOperations(): Promise<void> {
    if (activeOperations === 0) return;
    await new Promise<void>(resolve => operationDrainWaiters.add(resolve));
  }

  async function waitForBackgroundWork(): Promise<void> {
    const pending = [
      ...runProcesses.values(),
      ...runDrains.values(),
      ...runWrites.values(),
    ];
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  async function beforeShutdownDeadline<T>(
    operation: () => Promise<T>,
    deadline: number,
  ): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new MemeLoopRuntimeShutdownError('SHUTDOWN_TIMEOUT');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new MemeLoopRuntimeShutdownError('SHUTDOWN_TIMEOUT'));
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function forceLocalShutdownCleanup(): boolean {
    let failed = false;
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch {
        failed = true;
      }
    };
    for (const controller of runAbortControllers.values()) {
      cleanup(() => {
        controller.abort();
      });
    }
    if (ownsApprovalBroker) {
      cleanup(() => {
        context.toolApprovals?.dispose();
      });
    }
    if (ownsQuestionWaits) {
      cleanup(() => {
        context.questionWaits?.dispose();
      });
    }
    cleanup(disposeRuntimePlugins);
    cleanup(() => {
      context.loopRegistry?.reset();
    });
    cleanup(() => {
      runtimeTools.dispose();
    });
    const hooks = context.hooks;
    if (ownsHookRegistry && hooks instanceof HookRegistry) {
      cleanup(() => {
        hooks.clearHooks();
      });
    }
    if (ownsToolSchemas) cleanup(() => context.toolSchemas?.clear());
    cleanup(() => context.promptPlugins?.clear());
    cleanup(() => context.agentProfiles?.reset());
    listeners.clear();
    for (const conversationId of runtimeCancellationMarkers) cancellation.delete(conversationId);
    runtimeCancellationMarkers.clear();
    runCancellation.clear();
    runAbortControllers.clear();
    for (const waiter of checkpointWaiters) {
      cleanup(() => {
        waiter.cleanup();
      });
      cleanup(() => {
        waiter.reject(new Error('MemeLoopRuntime has been disposed'));
      });
    }
    checkpointWaiters.clear();
    acceptedCheckpoints.clear();
    checkpointAcks.clear();
    runGenerators.clear();
    runProfiles.clear();
    runModelRoutes.clear();
    runProcesses.clear();
    retryPersistence.clear();
    retryRequests.clear();
    runDrains.clear();
    runWrites.clear();
    conversationRunQueues.clear();
    runs.clear();
    for (const resolve of operationDrainWaiters) cleanup(resolve);
    operationDrainWaiters.clear();
    return failed;
  }

  function notify(
    conversationId: string,
    update: MemeLoopRuntimeUpdatePayload,
  ) {
    if (shuttingDown || disposed) return;
    const set = listeners.get(conversationId);
    if (!set) return;
    const snapshot = [...set];
    const event = { ...update, conversationId } as MemeLoopRuntimeUpdate;
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        context.logger?.warn?.('MemeLoopRuntime update listener failed', {
          conversationId,
          updateType: event.type,
          ...('runId' in event && event.runId ? { runId: event.runId } : {}),
          ...(event.type === 'agent-error'
            ? {
              errorCode: event.error.code,
              ...('diagnosticId' in event.error && typeof event.error.diagnosticId === 'string'
                ? { diagnosticId: event.error.diagnosticId }
                : {}),
            }
            : {}),
        });
      }
    }
  }

  function checkpointNotificationKey(checkpoint: MemeLoopCheckpoint): string {
    const identity = checkpoint.checkpoint.identity;
    return JSON.stringify([
      checkpoint.conversationId,
      checkpoint.runId ?? '',
      identity.id,
      identity.scriptVersion,
      identity.profileVersion,
      identity.scriptDigest,
      identity.runId ?? '',
      checkpoint.checkpoint.key,
    ]);
  }

  function checkpointMatches(
    checkpoint: MemeLoopCheckpoint,
    options: WaitForCheckpointOptions,
  ): boolean {
    return checkpoint.conversationId === options.conversationId &&
      (options.runId === undefined || checkpoint.runId === options.runId) &&
      (options.checkpointId === undefined || checkpoint.checkpoint.identity.id === options.checkpointId) &&
      (options.key === undefined || checkpoint.checkpoint.key === options.key);
  }

  function latestAcceptedCheckpoint(options: WaitForCheckpointOptions): MemeLoopCheckpoint | undefined {
    let latest: MemeLoopCheckpoint | undefined;
    for (const checkpoint of acceptedCheckpoints.values()) {
      if (
        checkpointMatches(checkpoint, options) &&
        (latest === undefined || checkpoint.checkpoint.acceptedAt > latest.checkpoint.acceptedAt)
      ) {
        latest = checkpoint;
      }
    }
    return latest;
  }

  function recordAcceptedCheckpoint(checkpoint: MemeLoopCheckpoint): void {
    const key = checkpointNotificationKey(checkpoint);
    acceptedCheckpoints.set(key, checkpoint);
    notify(checkpoint.conversationId, {
      type: 'checkpoint-accepted',
      ...(checkpoint.runId ? { runId: checkpoint.runId } : {}),
      checkpoint: checkpoint.checkpoint,
    });
    for (const waiter of [...checkpointWaiters]) {
      if (!checkpointMatches(checkpoint, waiter.options)) continue;
      checkpointWaiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve(checkpoint);
    }
  }

  function waitForCheckpoint(options: WaitForCheckpointOptions): Promise<MemeLoopCheckpoint> {
    const existing = latestAcceptedCheckpoint(options);
    if (existing) return Promise.resolve(existing);
    if (options.signal?.aborted) return Promise.reject(new Error('checkpoint wait cancelled'));
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3_600_000)
    ) {
      return Promise.reject(new Error('checkpoint wait timeoutMs must be a safe integer between 1 and 3600000'));
    }
    return new Promise<MemeLoopCheckpoint>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        checkpointWaiters.delete(waiter);
        cleanup();
        reject(new Error('checkpoint wait cancelled'));
      };
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const waiter = { options, resolve, reject, cleanup };
      checkpointWaiters.add(waiter);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          checkpointWaiters.delete(waiter);
          cleanup();
          reject(new Error('checkpoint wait timed out'));
        }, options.timeoutMs);
      }
      // A checkpoint can be accepted between the initial lookup and waiter
      // registration only through another microtask; check once more before
      // returning control to the caller.
      const accepted = latestAcceptedCheckpoint(options);
      if (accepted) {
        checkpointWaiters.delete(waiter);
        cleanup();
        resolve(accepted);
      }
    });
  }

  function ackCheckpoint(checkpoint: MemeLoopCheckpoint): boolean {
    const key = checkpointNotificationKey(checkpoint);
    if (!acceptedCheckpoints.has(key) || checkpointAcks.has(key)) return false;
    checkpointAcks.add(key);
    return true;
  }

  function isTerminalState(state: AgentRunState): boolean {
    return state === 'completed' || state === 'failed' || state === 'cancelled';
  }

  function cleanupRunResources(runId: string): void {
    if (runProcesses.has(runId) || runDrains.has(runId)) return;
    const run = runs.get(runId);
    if (run && !isTerminalState(run.state)) return;
    runCancellation.delete(runId);
    runAbortControllers.delete(runId);
    runGenerators.delete(runId);
    runProfiles.delete(runId);
    runModelRoutes.delete(runId);
    runWrites.delete(runId);
    if (run && !hasPendingConversationWork(run.conversationId)) {
      clearConversationCancellation(run.conversationId);
    }
  }

  function hasPendingConversationWork(conversationId: string): boolean {
    for (const pendingRunId of runProcesses.keys()) {
      if (runs.get(pendingRunId)?.conversationId === conversationId) return true;
    }
    for (const pendingRunId of runDrains.keys()) {
      if (runs.get(pendingRunId)?.conversationId === conversationId) return true;
    }
    for (const run of runs.values()) {
      if (run.conversationId === conversationId && !isTerminalState(run.state)) return true;
    }
    return false;
  }

  function markConversationCancelled(conversationId: string): void {
    runtimeCancellationMarkers.add(conversationId);
    cancellation.add(conversationId);
  }

  function clearConversationCancellation(conversationId: string): void {
    if (!runtimeCancellationMarkers.delete(conversationId)) return;
    cancellation.delete(conversationId);
  }

  async function canonicalRun(runId: string): Promise<AgentRunRecord | undefined> {
    const record = await runStateStore.get(runId);
    if (record) runs.set(runId, record);
    else runs.delete(runId);
    return record;
  }

  async function pruneRuns(now = Date.now()): Promise<void> {
    for (const [runId, run] of runs) {
      if (
        run.finishedAt !== undefined &&
        now - run.finishedAt > RUN_STATUS_TTL_MS
      ) {
        runs.delete(runId);
        cleanupRunResources(runId);
      }
    }
    while (runs.size >= MAX_TRACKED_RUNS) {
      const terminal = [...runs].find(([, run]) => run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled');
      if (!terminal) {
        throw new Error(`MemeLoopRuntime has reached its ${MAX_TRACKED_RUNS} active-run limit`);
      }
      runs.delete(terminal[0]);
      cleanupRunResources(terminal[0]);
    }
    await runStateStore.prune({
      finishedBefore: now - RUN_STATUS_TTL_MS,
      maxRecords: MAX_TRACKED_RUNS - 1,
    });
  }

  interface RunCandidateInput {
    conversationId: string;
    definitionId: string;
    turnId: string;
    requestPeerId: string;
    requestId: string;
    payloadDigest: string;
    retrySourceTurnId?: string;
  }

  async function createRunCandidate(input: RunCandidateInput): Promise<AgentRunRecord> {
    const now = Date.now();
    await pruneRuns(now);
    return {
      runId: nextDurableId('run'),
      ...input,
      state: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    };
  }

  async function acceptRun(input: RunCandidateInput): Promise<{ handle: MemeLoopRunHandle; isNew: boolean }> {
    const candidate = await createRunCandidate(input);
    const persisted = await runStateStore.createOrGet(candidate);
    runs.set(persisted.runId, persisted);
    return {
      handle: {
        runId: persisted.runId,
        conversationId: persisted.conversationId,
        turnId: persisted.turnId,
        requestId: persisted.requestId,
        state: 'accepted',
      },
      isNew: persisted.runId === candidate.runId,
    };
  }

  async function persistRun(
    record: AgentRunRecord,
    expectedState: AgentRunState,
  ): Promise<boolean> {
    const previous = runWrites.get(record.runId) ?? Promise.resolve();
    let transitioned = false;
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        transitioned = await runStateStore.transition(
          record.runId,
          [expectedState],
          record,
        );
      });
    runWrites.set(record.runId, write);
    try {
      await write;
    } finally {
      if (runWrites.get(record.runId) === write) runWrites.delete(record.runId);
    }
    return transitioned;
  }

  async function transitionRun(
    runId: string,
    state: MemeLoopRunState,
    error?: unknown,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await canonicalRun(runId);
      if (!current) return false;
      if (current.state === state) return true;
      if (isTerminalState(current.state)) return false;
      const now = Date.now();
      const next: AgentRunRecord = {
        ...current,
        state,
        updatedAt: now,
        ...(state === 'running' && current.startedAt === undefined ? { startedAt: now } : {}),
        ...(isTerminalState(state) ? { finishedAt: now } : {}),
        ...(state === 'cancelled' ? { cancelRequestedAt: now } : {}),
        ...(error !== undefined ? { error: agentRunErrorFromUnknown(error) } : {}),
      };
      const transitioned = await persistRun(next, current.state);
      if (transitioned) {
        runs.set(runId, next);
        return true;
      }
    }
    await canonicalRun(runId);
    return false;
  }

  function runAgentLoop(
    input: AgentLoopInput,
    profile: LoopProfile | undefined,
    runId?: string,
  ): Promise<void> | null {
    const injectedRun = context.runAgentToolLoop;
    if (!injectedRun && !profile) return null;
    const lifecycle = runId
      ? {
        running: async () => transitionRun(runId, 'running'),
        completed: async () => {
          if (shuttingDown || runCancellation.has(runId)) {
            await transitionRun(runId, 'cancelled');
            return false;
          }
          return transitionRun(runId, 'completed');
        },
        failed: async (error: unknown) => {
          if (shuttingDown || runCancellation.has(runId)) {
            await transitionRun(runId, 'cancelled');
            return false;
          }
          return transitionRun(runId, 'failed', error);
        },
        opened: (iterator: AsyncIterator<AgentLoopStep>) => runGenerators.set(runId, iterator),
        closed: () => runGenerators.delete(runId),
      }
      : undefined;
    const runScriptState = new Map<string, unknown>();
    const task = (async (): Promise<void> => {
      try {
        await drainAgentLoop(
          async () => {
            if (injectedRun) return injectedRun(input);
            const run = await createAgentProfileRunner(
              context,
              profile!,
              createScriptRuntime(
                context,
                cancellation,
                runScriptState,
                input.conversationId,
                undefined,
                runId,
                runCancellation,
                undefined,
                undefined,
                checkpoint => {
                  recordAcceptedCheckpoint({
                    conversationId: input.conversationId,
                    ...(runId ? { runId } : {}),
                    checkpoint,
                  });
                },
              ),
            );
            if (!run) throw new Error(`RUNNER_UNAVAILABLE:${profile!.loopId ?? 'agent-tool-loop'}`);
            return run(input);
          },
          input.conversationId,
          notify,
          runId,
          lifecycle,
          context.logger,
        );
      } catch (error) {
        const failed = runId ? await transitionRun(runId, 'failed', error).catch(() => false) : true;
        if (failed) {
          notify(input.conversationId, {
            type: 'agent-error',
            ...(runId ? { runId } : {}),
            error: agentRunErrorFromUnknown(error),
          });
        }
      } finally {
        if (runId) {
          runDrains.delete(runId);
          cleanupRunResources(runId);
        }
      }
    })();
    if (runId) runDrains.set(runId, task);
    void task.catch(() => undefined);
    return task;
  }

  function acceptedMessagePayload(
    handle: MemeLoopRunHandle,
    options: SendMessageOptions,
  ): ConversationMessagePayload {
    const host = options.userMessage;
    const messageId = host?.messageId ?? handle.turnId;
    const content = host?.content ?? options.message;
    const parts = buildCanonicalChatMessageParts({
      role: 'user',
      content,
      parts: host?.parts,
      reasoning_content: host?.reasoning_content,
      toolCalls: host?.toolCalls,
      attachments: host?.attachments,
      detailRef: host?.detailRef,
      metadata: host?.metadata,
    });
    const projection = projectChatMessageParts(parts);
    const payload: ConversationMessagePayload = {
      messageId,
      turnId: messageId,
      role: 'user',
      content,
      parts,
    };
    if (projection.toolCalls !== undefined) payload.toolCalls = projection.toolCalls;
    if (projection.attachments !== undefined) payload.attachments = projection.attachments;
    if (host?.detailRef !== undefined) payload.detailRef = host.detailRef;
    if (projection.reasoning_content !== undefined) payload.reasoning_content = projection.reasoning_content;
    if (host?.contentType !== undefined) payload.contentType = host.contentType;
    if (host?.hidden !== undefined) payload.hidden = host.hidden;
    if (host?.duration !== undefined) payload.duration = host.duration;
    if (host?.metadata !== undefined) payload.metadata = host.metadata;
    return payload;
  }

  async function persistAcceptedUserTurn(
    handle: MemeLoopRunHandle,
    options: SendMessageOptions,
  ): Promise<ChatMessage | undefined> {
    const current = await canonicalRun(handle.runId);
    if (current?.state !== 'queued') return undefined;
    const now = Date.now();
    const localNodeId = requireLocalNodeId(context);
    const host = options.userMessage;
    const originNodeId = host?.originNodeId?.trim() || localNodeId;
    if (originNodeId !== localNodeId) {
      throw new Error('PendingLocalChatMessage.originNodeId must match the local event allocator');
    }
    const payload = acceptedMessagePayload(handle, options);
    const messageDraft: ConversationEventDraft = {
      kind: 'message',
      eventId: payload.messageId,
      conversationId: options.conversationId,
      originNodeId: localNodeId,
      timestamp: host?.timestamp ?? now,
      message: payload,
    };
    assertPendingAgentUserMessageWithinLimits({
      conversationId: messageDraft.conversationId,
      originNodeId: messageDraft.originNodeId,
      timestamp: messageDraft.timestamp,
      message: payload,
    });
    return appendLocalMessageEvent(context, {
      conversationId: options.conversationId,
      timestamp: messageDraft.timestamp,
      message: payload,
    });
  }

  async function processAcceptedRun(
    handle: MemeLoopRunHandle,
    options: SendMessageOptions,
    alreadyPersistedUserMessage?: ChatMessage,
  ): Promise<void> {
    try {
      if (!(await claimAcceptedRun(handle.runId))) return;
      const queued = await canonicalRun(handle.runId);
      if (queued?.state !== 'queued') return;
      const profile = context.runAgentToolLoop ? undefined : runProfiles.get(handle.runId);
      if (!context.runAgentToolLoop && !profile) {
        throw new Error(`RUNNER_UNAVAILABLE:${queued.definitionId}`);
      }
      const persistedUserMessage = alreadyPersistedUserMessage ?? await persistAcceptedUserTurn(handle, options);
      if (!persistedUserMessage) return;
      const current = await canonicalRun(handle.runId);
      if (current?.state !== 'queued') return;
      const drain = runAgentLoop(
        {
          conversationId: options.conversationId,
          message: options.message,
          persistedUserMessage: persistedUserMessage,
          runId: handle.runId,
          signal: runAbortControllers.get(handle.runId)?.signal,
          modelRoute: runModelRoutes.get(handle.runId),
        },
        profile ?? undefined,
        handle.runId,
      );
      if (drain) {
        const canonical = await canonicalRun(handle.runId);
        if (canonical && !isTerminalState(canonical.state)) {
          notify(options.conversationId, { type: 'message-queued', runId: handle.runId });
        }
        await drain;
        return;
      }

      throw new Error(`RUNNER_UNAVAILABLE:${current.definitionId}`);
    } catch (error) {
      const failed = await transitionRun(handle.runId, 'failed', error).catch(() => false);
      if (failed) {
        notify(options.conversationId, {
          type: 'agent-error',
          runId: handle.runId,
          error: agentRunErrorFromUnknown(error),
        });
      }
    }
  }

  async function claimAcceptedRun(runId: string): Promise<boolean> {
    const current = await canonicalRun(runId);
    if (!current || current.state !== 'accepted') return false;
    const now = Date.now();
    const queued: AgentRunRecord = {
      ...current,
      state: 'queued',
      updatedAt: now,
    };
    const claimed = await persistRun(queued, 'accepted');
    if (claimed) runs.set(runId, queued);
    else await canonicalRun(runId);
    return claimed;
  }

  function scheduleAcceptedRun(
    handle: MemeLoopRunHandle,
    options: SendMessageOptions,
    alreadyPersistedUserMessage?: ChatMessage,
  ): void {
    if (runProcesses.has(handle.runId) || runDrains.has(handle.runId)) return;
    runAbortControllers.set(handle.runId, new AbortController());
    const previous = conversationRunQueues.get(handle.conversationId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => processAcceptedRun(handle, options, alreadyPersistedUserMessage));
    conversationRunQueues.set(handle.conversationId, task);
    runProcesses.set(handle.runId, task);
    void task.finally(() => {
      runProcesses.delete(handle.runId);
      if (conversationRunQueues.get(handle.conversationId) === task) {
        conversationRunQueues.delete(handle.conversationId);
      }
      cleanupRunResources(handle.runId);
    }).catch(() => undefined);
  }

  async function processRecoveredRun(
    record: AgentRunRecord,
    options: SendMessageOptions,
    persistedUserMessage: ChatMessage,
  ): Promise<void> {
    try {
      const current = await canonicalRun(record.runId);
      if (!current || isTerminalState(current.state)) return;
      if (current.state === 'accepted') {
        await processAcceptedRun(
          {
            runId: current.runId,
            conversationId: current.conversationId,
            turnId: current.turnId,
            requestId: current.requestId,
            state: 'accepted',
          },
          options,
          persistedUserMessage,
        );
        return;
      }
      const profile = context.runAgentToolLoop ? undefined : runProfiles.get(current.runId);
      if (!context.runAgentToolLoop && !profile) {
        throw new Error(`RUNNER_UNAVAILABLE:${current.definitionId}`);
      }
      const drain = runAgentLoop(
        {
          conversationId: current.conversationId,
          message: options.message,
          persistedUserMessage,
          runId: current.runId,
          signal: runAbortControllers.get(current.runId)?.signal,
          modelRoute: runModelRoutes.get(current.runId),
        },
        profile,
        current.runId,
      );
      if (!drain) throw new Error(`RUNNER_UNAVAILABLE:${current.definitionId}`);
      const canonical = await canonicalRun(current.runId);
      if (canonical && !isTerminalState(canonical.state)) {
        notify(current.conversationId, { type: 'message-queued', runId: current.runId });
      }
      await drain;
    } catch (error) {
      const failed = await transitionRun(record.runId, 'failed', error).catch(() => false);
      if (failed) {
        notify(record.conversationId, {
          type: 'agent-error',
          runId: record.runId,
          error: agentRunErrorFromUnknown(error),
        });
      }
    }
  }

  function scheduleRecoveredRun(
    record: AgentRunRecord,
    options: SendMessageOptions,
    persistedUserMessage: ChatMessage,
  ): void {
    const handle: MemeLoopRunHandle = {
      runId: record.runId,
      conversationId: record.conversationId,
      turnId: record.turnId,
      requestId: record.requestId,
      state: 'accepted',
    };
    if (record.state === 'accepted') {
      scheduleAcceptedRun(handle, options, persistedUserMessage);
      return;
    }
    if (runProcesses.has(record.runId) || runDrains.has(record.runId)) return;
    runAbortControllers.set(record.runId, new AbortController());
    const previous = conversationRunQueues.get(record.conversationId) ?? Promise.resolve();
    const task = previous.catch(() => undefined)
      .then(() => processRecoveredRun(record, options, persistedUserMessage));
    conversationRunQueues.set(record.conversationId, task);
    runProcesses.set(record.runId, task);
    void task.finally(() => {
      runProcesses.delete(record.runId);
      if (conversationRunQueues.get(record.conversationId) === task) {
        conversationRunQueues.delete(record.conversationId);
      }
      cleanupRunResources(record.runId);
    }).catch(() => undefined);
  }

  async function resolveRunExecution(
    conversationId: string,
    explicitDefinitionId?: string,
  ): Promise<{
    definitionId: string;
    resolvedProfile: LoopProfile | undefined;
    resolvedModelRoute: ResolvedAgentModelRoute | undefined;
  }> {
    const definitionId = await resolveDefinitionId(
      context,
      conversationId,
      explicitDefinitionId,
    );
    const resolvedProfile = context.runAgentToolLoop
      ? undefined
      : await resolveLoopProfile(context, definitionId, { conversationId });
    if (!context.runAgentToolLoop && !resolvedProfile) {
      throw new Error(`RUNNER_UNAVAILABLE:${definitionId}`);
    }
    let resolvedModelRoute: ResolvedAgentModelRoute | undefined;
    if (resolvedProfile) {
      if (!context.modelProviderRegistry) {
        throw new Error('model provider registry is not configured');
      }
      const modelConfig = resolveAgentModelConfig({
        definition: resolvedProfile,
        hostDefault: context.defaultModelConfig,
      });
      resolvedModelRoute = resolveAgentModelRoute(context.modelProviderRegistry, modelConfig);
      const preflightError = await context.preflightAgentRun?.({
        conversationId,
        definitionId,
        providerId: resolvedModelRoute.providerId,
        modelId: resolvedModelRoute.modelId,
        wireModelId: resolvedModelRoute.wireModelId,
        apiMode: resolvedModelRoute.apiMode,
      });
      if (preflightError) throw new AgentRunFailure(preflightError);
    }
    return { definitionId, resolvedProfile: resolvedProfile ?? undefined, resolvedModelRoute };
  }

  async function sendMessageImpl(options: SendMessageOptions): Promise<MemeLoopRunHandle> {
    await recovery;
    const { definitionId, resolvedProfile, resolvedModelRoute } = await resolveRunExecution(
      options.conversationId,
      options.definitionId,
    );
    const requestPeerId = options.requestPeerId?.trim() || requireLocalNodeId(context);
    const requestId = options.requestId?.trim() ||
      nextDurableId('request');
    const proposedTurnId = options.turnId?.trim() || (
      options.userMessage as (AgentLoopInput['userMessage'] & { turnId?: string }) | undefined
    )?.turnId?.trim() || options.userMessage?.messageId?.trim() ||
      nextDurableId('turn');
    if (options.userMessage?.messageId && options.userMessage.messageId !== proposedTurnId) {
      throw new Error('SendMessageOptions.turnId must equal the user messageId');
    }
    const payloadDigest = await digestRunPayload({
      conversationId: options.conversationId,
      definitionId,
      message: options.message,
      turnId: proposedTurnId,
      ...(options.userMessage === undefined ? {} : { userMessage: options.userMessage }),
    }, sha256Hex);
    const accepted = await acceptRun({
      conversationId: options.conversationId,
      definitionId,
      turnId: proposedTurnId,
      requestPeerId,
      requestId,
      payloadDigest,
    });
    const { handle } = accepted;
    if (accepted.isNew) {
      if (resolvedProfile) runProfiles.set(handle.runId, resolvedProfile);
      if (resolvedModelRoute) runModelRoutes.set(handle.runId, resolvedModelRoute);
      clearConversationCancellation(options.conversationId);
      scheduleAcceptedRun(handle, options);
    }
    return handle;
  }

  function assertRetryUserRoot(
    message: ChatMessage | null,
    conversationId: string,
    turnId: string,
  ): ChatMessage {
    if (
      !message ||
      message.conversationId !== conversationId ||
      message.messageId !== turnId ||
      message.turnId !== turnId ||
      message.role !== 'user'
    ) {
      throw new Error('retry_turn_user_root_not_found');
    }
    return message;
  }

  async function persistRetryTurn(
    handle: MemeLoopRunHandle,
    options: RetryTurnOptions,
    payload: ConversationMessagePayload,
  ): Promise<{
    tombstone: ConversationTombstoneEvent;
    userEvent: ConversationMessageEvent;
    persistedUserMessage: ChatMessage;
  }> {
    const existing = retryPersistence.get(handle.runId);
    if (existing) return existing;
    const operation = (async () => {
      const accepted = await canonicalRun(handle.runId);
      if (!accepted) throw new Error('retry_turn_run_not_found');
      assertPendingAgentUserMessageWithinLimits({
        conversationId: options.conversationId,
        originNodeId: localNodeId,
        timestamp: Date.now(),
        message: payload,
      });
      const drafts = createAtomicAgentRetryEventDrafts(accepted, {
        sourceTurnId: options.turnId,
        replacementPayload: payload,
        originNodeId: localNodeId,
      });
      const persisted = await context.storage.appendLocalEventsAtomic(drafts);
      const [tombstone, userEvent] = persisted;
      try {
        assertCanonicalConversationEvent(tombstone);
        assertCanonicalConversationEvent(userEvent);
      } catch {
        throw new Error('retry_turn_atomic_append_invalid');
      }
      if (
        tombstone.kind !== 'tombstone' ||
        tombstone.eventId !== `tombstone:retry:${handle.runId}` ||
        tombstone.conversationId !== options.conversationId ||
        tombstone.targetTurnId !== options.turnId ||
        userEvent.kind !== 'message' ||
        userEvent.eventId !== options.newTurnId ||
        userEvent.conversationId !== options.conversationId ||
        userEvent.message.messageId !== options.newTurnId ||
        userEvent.message.turnId !== options.newTurnId ||
        userEvent.message.role !== 'user'
      ) throw new Error('retry_turn_atomic_append_invalid');
      return {
        tombstone,
        userEvent,
        persistedUserMessage: conversationEventToMessage(userEvent),
      };
    })();
    retryPersistence.set(handle.runId, operation);
    try {
      return await operation;
    } finally {
      if (retryPersistence.get(handle.runId) === operation) retryPersistence.delete(handle.runId);
    }
  }

  async function retryTurnImpl(options: RetryTurnOptions): Promise<MemeLoopRetryTurnResult> {
    await recovery;
    const conversationId = options.conversationId.trim();
    const turnId = options.turnId.trim();
    const newTurnId = options.newTurnId.trim();
    const requestId = options.requestId.trim();
    if (
      !conversationId ||
      !turnId ||
      !newTurnId ||
      !requestId ||
      newTurnId === turnId
    ) throw new Error('invalid_retry_turn_identity');
    const { definitionId, resolvedProfile, resolvedModelRoute } = await resolveRunExecution(
      conversationId,
      options.definitionId,
    );
    const requestPeerId = options.requestPeerId?.trim() || localNodeId;
    if (!context.storage.getMessageById) {
      throw new Error('retry_turn_indexed_point_read_unavailable');
    }
    const getMessageById = (targetConversationId: string, messageId: string) => context.storage.getMessageById!(targetConversationId, messageId);
    const existingRequest = await runStateStore.getByRequest(requestPeerId, requestId);
    if (
      existingRequest && (
        existingRequest.conversationId !== conversationId ||
        existingRequest.definitionId !== definitionId ||
        existingRequest.turnId !== newTurnId ||
        existingRequest.retrySourceTurnId !== turnId
      )
    ) throw new Error('retry_turn_request_conflict');
    if (
      existingRequest?.state === 'failed' &&
      existingRequest.error?.code === 'INTERRUPTED'
    ) throw new Error('retry_turn_interrupted');
    const replayRoot = existingRequest
      ? await getMessageById(conversationId, newTurnId)
      : null;
    const source = replayRoot
      ? assertRetryUserRoot(replayRoot, conversationId, newTurnId)
      : assertRetryUserRoot(
        await getMessageById(conversationId, turnId),
        conversationId,
        turnId,
      );
    const payload = createAtomicAgentRetryReplacementPayload(source, newTurnId);
    const payloadDigest = await digestAtomicAgentRetryPayload({
      conversationId,
      definitionId,
      sourceTurnId: turnId,
      newTurnId,
      replacementPayload: payload,
    }, sha256Hex);
    const candidateInput: RunCandidateInput = {
      conversationId,
      definitionId,
      turnId: newTurnId,
      requestPeerId,
      requestId,
      payloadDigest,
      retrySourceTurnId: turnId,
    };
    const atomicStore = isAtomicAgentRetryStore(runStateStore) ? runStateStore : undefined;
    if (
      !atomicStore &&
      !allowNonAtomicRetry
    ) throw new Error('atomic_agent_retry_store_required');
    let handle: MemeLoopRunHandle;
    let persisted: {
      tombstone: ConversationTombstoneEvent;
      userEvent: ConversationMessageEvent;
      persistedUserMessage: ChatMessage;
    };
    if (atomicStore) {
      const candidateRun = await createRunCandidate(candidateInput);
      const atomicInput: AtomicAgentRetryInput = existingRequest
        ? {
          mode: 'replay',
          candidateRun,
          sourceTurnId: turnId,
          replacementPayload: payload,
          originNodeId: localNodeId,
        }
        : {
          mode: 'fresh',
          candidateRun,
          sourceTurnId: turnId,
          expectedSourceMessage: source,
          replacementPayload: payload,
          originNodeId: localNodeId,
        };
      const result = await atomicStore.retryTurnAtomic(atomicInput);
      assertAtomicAgentRetryResult(atomicInput, result);
      runs.set(result.run.runId, result.run);
      handle = {
        runId: result.run.runId,
        conversationId: result.run.conversationId,
        turnId: result.run.turnId,
        requestId: result.run.requestId,
        state: 'accepted',
      };
      persisted = {
        tombstone: result.tombstone,
        userEvent: result.userEvent,
        persistedUserMessage: conversationEventToMessage(result.userEvent),
      };
    } else {
      ({ handle } = await acceptRun(candidateInput));
      const normalizedOptions: RetryTurnOptions = {
        conversationId,
        turnId,
        newTurnId,
        requestId,
        definitionId,
        requestPeerId,
      };
      persisted = await persistRetryTurn(handle, normalizedOptions, payload);
    }
    if (resolvedProfile) runProfiles.set(handle.runId, resolvedProfile);
    if (resolvedModelRoute) runModelRoutes.set(handle.runId, resolvedModelRoute);
    const current = await canonicalRun(handle.runId);
    if (
      current?.state === 'accepted' &&
      !runProcesses.has(handle.runId) &&
      !runDrains.has(handle.runId)
    ) {
      clearConversationCancellation(conversationId);
      scheduleAcceptedRun(handle, {
        conversationId,
        definitionId,
        message: persisted.persistedUserMessage.content,
        requestPeerId,
        requestId,
        turnId: newTurnId,
        userMessage: createAtomicAgentRetryReplacementPayload(persisted.persistedUserMessage, newTurnId),
      }, persisted.persistedUserMessage);
    }
    return {
      handle,
      tombstone: persisted.tombstone,
      userEvent: persisted.userEvent,
    };
  }

  function coalesceRetryTurn(options: RetryTurnOptions): Promise<MemeLoopRetryTurnResult> {
    const requestPeerId = options.requestPeerId?.trim() || localNodeId;
    const requestId = options.requestId.trim();
    const key = JSON.stringify([requestPeerId, requestId]);
    const fingerprint = JSON.stringify([
      options.conversationId.trim(),
      options.turnId.trim(),
      options.newTurnId.trim(),
      options.definitionId?.trim() ?? null,
    ]);
    const existing = retryRequests.get(key);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? existing.promise
        : Promise.reject(new Error('retry_turn_request_conflict'));
    }
    const promise = retryTurnImpl(options);
    retryRequests.set(key, { fingerprint, promise });
    void promise.finally(() => {
      if (retryRequests.get(key)?.promise === promise) retryRequests.delete(key);
    }).catch(() => undefined);
    return promise;
  }

  async function* runChildAgent(
    input: Parameters<NonNullable<AgentFrameworkContext['runChildAgent']>>[0],
  ): AgentLoopGenerator {
    input.signal?.throwIfAborted();
    await ensureConversationDefinition(context, input.conversationId, input.profileId);
    const run = await createProfileRunner(
      context,
      input.profileId,
      createScriptRuntime(context, cancellation, new Map<string, unknown>(), input.conversationId),
      input.conversationId,
    );
    if (!run) {
      yield {
        type: 'message',
        data: `Child agent profile not found: ${input.profileId}`,
      };
      return;
    }
    yield* run({
      conversationId: input.conversationId,
      message: input.prompt,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    });
  }

  context.runChildAgent ??= runChildAgent;

  async function createAgentImpl(options: CreateAgentOptions): Promise<{ conversationId: string }> {
    await recovery;
    const now = Date.now();
    const localNodeId = requireLocalNodeId(context);
    const definitionId = options.definitionId.trim();
    if (!definitionId) throw new Error('CreateAgentOptions.definitionId is required');
    const requestedConversationId = options.conversationId?.trim();
    const conversationId = requestedConversationId || nextDurableId('conversation');
    const profile = context.runAgentToolLoop
      ? undefined
      : await resolveLoopProfile(context, definitionId, { conversationId });
    if (!context.runAgentToolLoop && !profile) {
      throw new Error(`RUNNER_UNAVAILABLE:${definitionId}`);
    }
    clearConversationCancellation(conversationId);

    if (requestedConversationId) {
      const existing = await context.storage.getConversationMeta(conversationId);
      if (existing) {
        await resolveDefinitionId(context, conversationId, definitionId);
        if (options.initialMessage) {
          const messageId = `${conversationId}:m1`;
          await sendMessageImpl({
            conversationId,
            definitionId,
            message: options.initialMessage,
            requestPeerId: localNodeId,
            requestId: `create:${conversationId}:initial`,
            turnId: messageId,
            userMessage: {
              messageId,
              turnId: messageId,
              content: options.initialMessage,
            },
          });
        }
        return { conversationId };
      }
    }

    await context.storage.appendLocalEvent({
      kind: 'metadataPatch',
      eventId: `metadata:create:${conversationId}`,
      conversationId,
      originNodeId: localNodeId,
      timestamp: now,
      patch: {
        title: definitionId,
        definitionId,
        isUserInitiated: true,
      },
    });

    if (options.initialMessage) {
      const messageId = `${conversationId}:m1`;
      await sendMessageImpl({
        conversationId,
        definitionId,
        message: options.initialMessage,
        requestPeerId: localNodeId,
        requestId: `create:${conversationId}:initial`,
        turnId: messageId,
        userMessage: {
          messageId,
          turnId: messageId,
          content: options.initialMessage,
          timestamp: now,
        },
      });
    }

    notify(conversationId, { type: 'created' });
    return { conversationId };
  }

  return {
    createAgent(options) {
      return withActiveOperation(() => createAgentImpl(options));
    },
    sendMessage(options) {
      return withActiveOperation(() => sendMessageImpl(options));
    },
    retryTurn(options) {
      return withActiveOperation(() => coalesceRetryTurn(options));
    },
    getRunStatus(runId) {
      return withActiveOperation(async () => {
        await recovery;
        await pruneRuns();
        const status = runs.get(runId) ?? await runStateStore.get(runId);
        if (status) runs.set(runId, status);
        return status ? { ...status } : undefined;
      });
    },
    cancelRun(runId) {
      return withActiveOperation(async () => {
        await recovery;
        const run = runs.get(runId) ?? await runStateStore.get(runId);
        if (!run) return false;
        runs.set(runId, run);
        if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled') {
          cleanupRunResources(runId);
          return false;
        }
        runCancellation.add(runId);
        context.toolApprovals?.cancelPendingApprovals({ runId });
        runAbortControllers.get(runId)?.abort();
        const cancelled = await transitionRun(runId, 'cancelled');
        if (!cancelled) {
          cleanupRunResources(runId);
          return false;
        }
        notify(run.conversationId, { type: 'cancelled', runId });
        cleanupRunResources(runId);
        return true;
      });
    },
    cancelAgent(conversationId) {
      return withActiveOperation(async () => {
        await recovery;
        const active = await runStateStore.listActive();
        const matching = active.filter(run =>
          run.conversationId === conversationId &&
          (run.state === 'accepted' || run.state === 'queued' || run.state === 'running')
        );
        if (matching.length === 0) {
          notify(conversationId, { type: 'cancelled' });
          return;
        }
        for (const run of matching) runs.set(run.runId, run);
        markConversationCancelled(conversationId);
        context.toolApprovals?.cancelPendingApprovals({ conversationId });
        for (const run of matching) {
          runCancellation.add(run.runId);
          runAbortControllers.get(run.runId)?.abort();
          await transitionRun(run.runId, 'cancelled');
          cleanupRunResources(run.runId);
        }
        notify(conversationId, { type: 'cancelled' });
      });
    },
    waitForCheckpoint(options) {
      return withActiveOperation(() => waitForCheckpoint(options));
    },
    ackCheckpoint(checkpoint) {
      assertActive();
      return ackCheckpoint(checkpoint);
    },
    runChildAgent,
    dispose() {
      if (disposePromise) return disposePromise;
      shuttingDown = true;
      disposePromise = (async () => {
        const deadline = Date.now() + disposeTimeoutMs;
        let shutdownFailure: MemeLoopRuntimeShutdownError | undefined;
        const recordFailure = (error: unknown): void => {
          const normalized = error instanceof MemeLoopRuntimeShutdownError
            ? error
            : new MemeLoopRuntimeShutdownError('SHUTDOWN_FAILED');
          if (
            shutdownFailure === undefined ||
            normalized.code === 'SHUTDOWN_TIMEOUT'
          ) shutdownFailure = normalized;
        };
        const attempt = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
          try {
            return await beforeShutdownDeadline(operation, deadline);
          } catch (error) {
            recordFailure(error);
            return undefined;
          }
        };

        try {
          const knownControllers = [...runAbortControllers];
          for (const [runId] of knownControllers) {
            runCancellation.add(runId);
            context.toolApprovals?.cancelPendingApprovals({ runId });
            await attempt(() => transitionRun(runId, 'cancelled'));
          }
          for (const [, controller] of knownControllers) {
            controller.abort();
          }
          await attempt(waitForActiveOperations);
          await attempt(async () => recovery);
          const active = await attempt(() => runStateStore.listActive()) ?? [];
          for (const run of active) {
            if (run.state !== 'accepted' && run.state !== 'queued' && run.state !== 'running') {
              continue;
            }
            runCancellation.add(run.runId);
            context.toolApprovals?.cancelPendingApprovals({ runId: run.runId });
            runAbortControllers.get(run.runId)?.abort();
            await attempt(() => transitionRun(run.runId, 'cancelled'));
          }
          const generatorClosures = [...runGenerators.values()].map(async iterator => {
            if (typeof iterator.return === 'function') await iterator.return();
          });
          if (ownsApprovalBroker) context.toolApprovals?.dispose();
          if (ownsQuestionWaits) context.questionWaits?.dispose();
          await attempt(async () => {
            const results = await Promise.allSettled([
              ...generatorClosures,
              waitForBackgroundWork(),
            ]);
            if (results.some(result => result.status === 'rejected')) {
              throw new MemeLoopRuntimeShutdownError('SHUTDOWN_FAILED');
            }
          });
        } catch (error) {
          recordFailure(error);
        } finally {
          if (forceLocalShutdownCleanup()) {
            recordFailure(new MemeLoopRuntimeShutdownError('SHUTDOWN_FAILED'));
          }
          disposed = true;
        }
        if (shutdownFailure) throw shutdownFailure;
      })();
      return disposePromise;
    },
    subscribeToUpdates(conversationId, listener) {
      assertActive();
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
