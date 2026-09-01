import type { AgentProfileRegistry } from './agent/agentProfileRegistry.js';
import type { AgentDefinition, AgentModelConfig } from './agent/types.js';
import type { ChatMessage, ContextCompactionProgress } from './conversation/index.js';
import type { AgentOrchestrationClient, NodeTrustClass, ScriptDeploymentClientConfig, ToolOperationEffect } from './orchestration/index.js';
import type { AgentFrameworkConfig } from './promptUtilities/types.js';
import type { AgentRunError, AgentRunStateStore } from './runState.js';
import type { Sha256HexProvider } from './storage/atomicAgentRetry.js';
import type { IAgentStorage } from './storage/interface.js';
import type { ConversationMeta } from './sync/protocol.js';

import type { ProviderRegistryResolver } from './llm/providerRegistry.js';
import type { PortableLlmRequest } from './llm/request.js';
import type { PortableLlmStreamPart } from './llm/response.js';
import type { HookExecutionRegistry } from './loopAPI/hooks/types.js';
import type { LoopRegistry } from './loopAPI/registry.js';
import type { AgentLoopGenerator, AgentLoopInput, AgentLoopRuntime, AgentLoopScriptPolicy } from './loopAPI/types.js';
import type { LoopScriptCheckpointStore } from './loopAPI/types.js';
import type { ControlStore } from './orchestration/controlStore.js';
import type { CheckpointStore } from './storage/sessionStorage.js';
import type { ToolApprovalBroker } from './tools/approval.js';
import type { QuestionWaitBroker } from './tools/builtins/questionWaitRegistry.js';
import type { TodoStateStore } from './tools/builtins/todoWrite.js';
import type { ToolSchemaRegistry } from './tools/schemaRegistry.js';
import type { PromptConcatTool } from './tools/types.js';

// Storage types are defined once in `storage/ports.ts` (narrow ports) and
// composed in `storage/interface.ts`; re-exported here for compatibility.
export type { ConversationQueryMode, GetConversationListPageOptions, GetMessagesOptions, IAgentStorage } from './storage/interface.js';

export interface MemeLoopLogger {
  debug?(message: string, ...arguments_: unknown[]): void;
  info?(message: string, ...arguments_: unknown[]): void;
  warn?(message: string, ...arguments_: unknown[]): void;
  error?(message: string, ...arguments_: unknown[]): void;
}

/** Per-resolution turn identity supplied to host-backed definition stores. */
export interface ResolveAgentDefinitionOptions {
  /** Durable conversation whose instance overrides must be projected. */
  conversationId?: string;
  /** Cancellation fence for storage-backed resolution. */
  signal?: AbortSignal;
}

export interface ILLMProvider {
  name: string;
  /**
   * Serializable default model identity used by orchestration resources.
   * `model` may be an SDK object or factory and must never be persisted.
   */
  modelId?: string;
  model?: unknown;

  chat(request: PortableLlmRequest):
    | string
    | PortableLlmStreamPart
    | AsyncIterable<PortableLlmStreamPart>
    | Promise<string | PortableLlmStreamPart | AsyncIterable<PortableLlmStreamPart>>;
}

/** Per-invocation capabilities passed as the optional second tool argument. */
export interface ToolInvocationContext {
  signal?: AbortSignal;
  conversationId: string;
  runId?: string;
}

/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
export interface IToolRegistry {
  registerTool(
    id: string,
    impl: unknown,
    parameterSchema?: unknown,
    effect?: ToolOperationEffect,
  ): void;
  /** Remove a dynamically registered tool. Required for unloadable plugin hosts. */
  unregisterTool?: (id: string) => boolean;
  /** Unfiltered registration lookup. Plugin hosts use this instead of permission-filtered `getTool`. */
  hasTool?: (id: string) => boolean;
  getTool(id: string): unknown | undefined;
  listTools(): string[];
  /**
   * Instance-local schema lookup. Managed catalogs use this when available so
   * one embedded runtime cannot inherit another runtime's process-global schema.
   */
  getToolParameterSchema?: (id: string) => unknown | undefined;
  /** Instance-local public display metadata for managed catalogs. */
  getToolMetadata?: (id: string) => import('./tools/schemaRegistry.js').ToolSchemaMetadata | undefined;
  /** Host-authoritative effect classification; omitted tools default to conservative execute. */
  getToolEffect?: (id: string) => ToolOperationEffect | undefined;
  /** Prompt-concat plugin registry owned by this runtime. */
  getPromptPlugins?: () => Map<
    string,
    (hooks: import('./tools/types.js').PromptConcatHooks) => void
  >;
}

export interface IChatSyncAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface INetworkService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentToolLoopOptions {
  /** Maximum LLM-to-tool round-trips. `0` means unlimited, still capped internally. */
  maxIterations?: number;
  /** Whether to parse `<tool_use>` / `<function_call>` and execute through `IToolRegistry` (default true). */
  enableToolLoop?: boolean;
  /** Explicit compatibility mode for legacy XML-like tool calls embedded in model text. */
  legacyTextToolCalls?: boolean;
  /** Cancellation check, e.g. when the user stops a run. */
  isCancelled?: (conversationId: string) => boolean;
  /** Attachment injection for promptConcat, aligned with `PromptConcatOptions`. */
  readAttachmentFile?: (path: string) => Promise<Uint8Array>;
  /** Omit history older than this many milliseconds when building LLM input. `0` disables trimming. */
  maxHistoryAgeMs?: number;
  /**
   * When `defineTool` / plugins are configured, fall back to `IToolRegistry` for tool calls not handled by `onResponseComplete`.
   */
  fallbackRegistryTools?: boolean;
  /**
   * Tool permission rules (default allow).
   * Supports wildcards such as "terminal.*" and "file.read".
   */
  toolPermissions?: {
    default?: 'allow' | 'ask' | 'deny';
    rules?: Array<{ pattern: string; action: 'allow' | 'ask' | 'deny' }>;
    perAgent?: Record<
      string,
      {
        default?: 'allow' | 'ask' | 'deny';
        rules?: Array<{ pattern: string; action: 'allow' | 'ask' | 'deny' }>;
      }
    >;
  };
  /** Threshold for repeated identical tool+input calls (default 3). */
  doomLoopThreshold?: number;
  /** Higher cap for the same tool batch when results show no progress (default max(8, exact threshold * 3)). */
  doomLoopSameToolThreshold?: number;
  /**
   * Timeout for a single ToolOperation executed through the orchestration
   * facade (default 60_000ms). Covers the full lifecycle from apply until a
   * terminal phase, including scheduling and remote execution.
   */
  toolOperationTimeoutMs?: number;
  /**
   * Host-selected tool execution boundary.
   *
   * - `local`: execute only through this runtime's `IToolRegistry`.
   * - `orchestration-required`: every tool call must pass through a
   *   `ToolOperation`; a missing/incompatible/unreachable facade fails closed.
   *
   * When omitted, Core selects `orchestration-required` whenever an
   * orchestration facade is present, otherwise `local`. The model and tool
   * call payload cannot select or downgrade this host-owned route.
   */
  toolExecutionRoute?: 'local' | 'orchestration-required';
  /**
   * Host-bound trust class of the node running this loop. Restricted and
   * quarantine nodes default the model-facing tool permission layer to deny
   * when no explicit wildcard rule exists. Bound by the host at assembly
   * time; never self-reported by the workload or model.
   */
  trustClass?: NodeTrustClass;
  /**
   * Durable bounded context policy. Old prefixes are always summarized into
   * append-only compaction events; no setting permits an unbounded read.
   */
  autoCompact?: {
    /** Number of recent complete turns to preserve (default: 32). */
    recentTurnsToKeep?: number;
    /** Approximate request budget (default: 128k tokens, hard-capped at 4 MiB). */
    maxTokens?: number;
    /**
     * Ask the host to enqueue a later bounded compaction slice after the
     * foreground provider-call budget is exhausted. Core invokes this on a
     * microtask and never supplies message content.
     */
    scheduleContinuation?: (progress: Readonly<ContextCompactionProgress>) => void;
  };
  /** Session checkpoint: save conversation history after each turn for resume. */
  sessionCheckpoint?: {
    /** Enable checkpoint saves. Default: false. */
    enabled?: boolean;
    /** Store provided by the runtime host. */
    store?: CheckpointStore;
    /** Custom checkpoint directory (default: ~/.memeloop/sessions/) */
    directory?: string;
  };
  /**
   * After a tool returns `__memeloopToolResult.awaitSessionId`, AgentToolLoop waits here before the next LLM round.
   */
  waitForTerminalSession?: (sessionId: string) => Promise<{
    exitCode: number | null;
    truncatedOutput: string;
  }>;
}

export interface AgentFrameworkContext {
  storage: IAgentStorage;
  llmProvider: ILLMProvider;
  /** Exact runtime-local provider/model registry used by execution, preview, and compaction. */
  modelProviderRegistry?: ProviderRegistryResolver;
  /** Host-declared fallback used only when the resolved agent has no modelConfig. */
  defaultModelConfig?: AgentModelConfig;
  /** Current run cancellation, present only on per-run context projections. */
  operationSignal?: AbortSignal;
  /** Portable runtime digest capability; native hosts may inject a non-blocking implementation. */
  sha256Hex?: Sha256HexProvider;
  /** Host-owned secret/capability check after exact route resolution and before run acceptance. */
  preflightAgentRun?: (input: {
    conversationId: string;
    definitionId: string;
    providerId: string;
    modelId: string;
    wireModelId: string;
    apiMode: 'chat-completions' | 'responses';
  }) => AgentRunError | undefined | Promise<AgentRunError | undefined>;
  /**
   * Host-owned tool registry. Runtime factories expose it through a local
   * overlay: Core-owned tools never mutate or dispose this host registry, and
   * canonical runtime tools may safely shadow same-named host registrations.
   */
  tools: IToolRegistry;
  syncAdapters: IChatSyncAdapter[];
  network: INetworkService;
  /** Runtime-local lifecycle hooks. Runtime factories always inject this port. */
  hooks?: HookExecutionRegistry;
  /** Runtime-local loop/profile/plugin registry. Runtime factories install builtins into this instance. */
  loopRegistry?: LoopRegistry;
  /** Runtime-local schema and prompt-plugin catalogs. */
  toolSchemas?: ToolSchemaRegistry;
  promptPlugins?: Map<string, PromptConcatTool>;
  /** Runtime-local task-delegation role/profile registry. */
  agentProfiles?: AgentProfileRegistry;
  /** Runtime-local, principal-bound approval broker required by production execution. */
  toolApprovals?: ToolApprovalBroker;
  /** Stable runtime principal used by approval and other runtime-owned capabilities. */
  runtimeId?: string;
  /** Runtime-local builtin state stores. */
  todoStore?: TodoStateStore;
  questionWaits?: QuestionWaitBroker;
  /**
   * Stable identity of the host node that originates locally generated
   * conversation messages. Distributed hosts should set this to their
   * DeviceNetwork PeerId (or another stable, globally unique node ID).
   * Local event production fails closed when this identity is absent.
   */
  localNodeId?: string;
  /** Policy-scoped declarative manager facade shared by Agent loops and Agent-facing tools. */
  orchestration?: AgentOrchestrationClient;
  /**
   * Host-bound script deployment configuration (plan 24.14). Loop runtimes
   * build a `ctx.scriptClient` from it; scripts never see the raw config,
   * so trust class and interface ceilings stay host-controlled.
   */
  scriptDeployment?: ScriptDeploymentClientConfig;
  /** Trusted controller state store; Agent-facing loop scripts receive only its checkpoint adapter. */
  controlStore?: ControlStore;
  /** Durable milestones used by script-backed loops such as quality-gate. */
  loopCheckpoints?: LoopScriptCheckpointStore;
  /** Let host runtimes preserve platform-specific message aliases/metadata while core owns the loop. */
  normalizeMessage?: (message: ChatMessage) => ChatMessage;
  /**
   * Notify a host about an in-memory streaming message. The core invokes this
   * with the same message ID used for the immutable final persisted message.
   */
  onTransientMessage?: (message: ChatMessage) => void | Promise<void>;

  /** AgentToolLoop ReAct behavior, migrated from the TidGi-Desktop agentToolLoop integration. */
  agentToolLoop?: AgentToolLoopOptions;
  /**
   * Host-injected runner used by `createMemeLoopRuntime` after a user sends a message.
   */
  runAgentToolLoop?: (input: AgentLoopInput) => AgentLoopGenerator;
  /** Run a child agent for orchestration loops such as AgentAgentLoop. */
  runChildAgent?: AgentLoopRuntime['runChildAgent'];
  /**
   * Policy for loading script-backed loops. Builtins are statically available;
   * Node hosts default to module specifiers while portable hosts fail closed
   * unless they inject a finite `importModule` adapter.
   */
  loopScriptPolicy?: AgentLoopScriptPolicy;
  /**
   * Build the agent view supplied to defineTool hooks for a conversation.
   */
  resolveAgentRuntimeView?: (
    conversationId: string,
    messages: ChatMessage[],
  ) => Promise<AgentInstanceModel>;
  /** Current agent view for defineTool / TidGi compatibility. */
  agent?: { id: string; messages: ChatMessage[] };
  /** Persist a `ChatMessage` if the runtime host supplies this hook. */
  persistAgentMessage?: (message: ChatMessage) => Promise<void>;
  /** Cancellation markers written by `createMemeLoopRuntime`. */
  conversationCancellation?: Set<string>;
  /** Per-run cancellation markers written by `MemeLoopRuntime.cancelRun`. */
  runCancellation?: Set<string>;
  /** Durable lifecycle/idempotency store used by MemeLoopRuntime. */
  runStateStore?: AgentRunStateStore;
  /** Resolve a fresh AgentDefinition, including conversation-scoped persisted overrides. */
  resolveAgentDefinition?: (
    definitionId: string,
    options?: ResolveAgentDefinitionOptions,
  ) => Promise<AgentDefinition | null>;
  /** Fallback logger used when the host does not inject one. */
  logger?: MemeLoopLogger;
  /** TidGi defineTool compatibility: legacy plugins call this without arguments. */
  isCancelled?: () => boolean;
}

export type AgentInstanceState =
  | 'idle'
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'unknown';

export interface AgentInstanceLatestStatus {
  state: AgentInstanceState;
  message?: ChatMessage;
  /** Human-readable sub-status for the header — shown while agent is working. */
  progress?: string;
  created?: Date;
  modified?: Date;
}

/**
 * Bounded durable instance metadata shared by hosts and UI adapters.
 *
 * This is intentionally separate from {@link AgentInstanceModel}: directory,
 * subscription, and IPC reads must not fabricate definition fields or attach
 * an unbounded `messages` array merely to satisfy the execution model shape.
 */
export interface AgentInstanceMetadata {
  id: string;
  agentDefId: string;
  name?: string;
  status: AgentInstanceLatestStatus;
  created: Date;
  modified?: Date;
  modelConfig?: AgentModelConfig;
  avatarUrl?: string;
  agentFrameworkConfig?: AgentFrameworkConfig;
  closed: boolean;
  volatile: boolean;
  /** True only for renderer-created disposable previews. */
  preview: boolean;
}

/** Exact mutable subset accepted by an instance metadata store. */
export type AgentInstanceMetadataUpdate = Partial<
  Pick<AgentInstanceMetadata, 'name' | 'status' | 'modelConfig' | 'avatarUrl' | 'agentFrameworkConfig' | 'closed'>
>;

export interface AgentInstanceModel extends Omit<AgentDefinition, 'name'> {
  agentDefId: string;
  name?: string;
  agentFrameworkConfig?: AgentFrameworkConfig;
  messages: ChatMessage[];
  status: AgentInstanceLatestStatus;
  created: Date;
  modified?: Date;
  closed?: boolean;
  volatile?: boolean;
  isDelegatedAgentRun?: boolean;
  parentAgentRunId?: string;
}

export type { AgentInstanceModel as AgentInstance };

export function isUserInitiatedConversation(meta: ConversationMeta): boolean {
  return meta.isUserInitiated;
}

export function createInstanceDeltaFromDefinition(
  definition: AgentDefinition,
  overrides: Partial<AgentDefinition>,
): Partial<AgentDefinition> {
  const delta: Partial<AgentDefinition> = {};
  for (const key of Object.keys(overrides) as Array<Extract<keyof AgentDefinition, string>>) {
    const value = overrides[key];
    if (value !== undefined && value !== definition[key]) {
      (delta as Record<string, unknown>)[key] = value;
    }
  }
  return delta;
}
