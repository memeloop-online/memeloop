import type { AgentDefinition, AgentInstanceMeta } from './agent/types.js';
import type { AttachmentReference } from './conversation/index.js';
import type { ChatMessage } from './conversation/index.js';
import type { AgentOrchestrationClient, NodeTrustClass } from './orchestration/index.js';
import type { AgentFrameworkConfig } from './promptUtilities/types.js';
import type { ConversationMeta } from './sync/protocol.js';

import type { AgentLoopGenerator, AgentLoopInput, AgentLoopRuntime, AgentLoopScriptPolicy } from './loopAPI/types.js';
import type { CheckpointStore } from './storage/sessionStorage.js';

export type ConversationQueryMode = 'metadata-only' | 'full-content' | 'on-demand';

export interface ListConversationsOptions {
  limit?: number;
  offset?: number;
}

export interface GetMessagesOptions {
  mode?: ConversationQueryMode;
}

export interface IAgentStorage {
  listConversations(options?: ListConversationsOptions): Promise<ConversationMeta[]>;

  getMessages(conversationId: string, options?: GetMessagesOptions): Promise<ChatMessage[]>;

  appendMessage(message: ChatMessage): Promise<void>;

  /**
   * Upsert conversation directory row (sync / Solid / peer metadata).
   */
  upsertConversationMetadata(meta: ConversationMeta): Promise<void>;

  /**
   * Insert messages if messageId not present (merge from remote / Pod); refreshes per-conversation messageCount.
   */
  insertMessagesIfAbsent(messages: ChatMessage[]): Promise<void>;

  getAttachment(contentHash: string): Promise<AttachmentReference | null>;

  saveAttachment(reference: AttachmentReference, data: Buffer | Uint8Array): Promise<void>;

  /** Read persisted attachment bytes for cross-node RPC `memeloop.storage.getAttachmentBlob`. */
  readAttachmentData?(contentHash: string): Promise<Uint8Array | null>;

  getAgentDefinition(id: string): Promise<AgentDefinition | null>;

  /** Optional optimization: use `SELECT MAX(lamportClock)` instead of scanning all messages for clock state. */
  getMaxLamportClockForConversation?(conversationId: string): Promise<number>;

  saveAgentInstance(meta: AgentInstanceMeta): Promise<void>;

  /** Read the conversation metadata row used by AgentToolLoop to resolve `definitionId`. */
  getConversationMeta(conversationId: string): Promise<ConversationMeta | null>;

  /** IM user-to-conversation binding (persisted by memeloop-cli + SQLite). */
  getImBinding?(
    channelId: string,
    imUserId: string,
  ): Promise<import('./im/protocol.js').IMChannelBinding | null>;
  setImBinding?(record: import('./im/protocol.js').IMChannelBinding): Promise<void>;
}

export interface MemeLoopLogger {
  debug?(message: string, ...arguments_: unknown[]): void;
  info?(message: string, ...arguments_: unknown[]): void;
  warn?(message: string, ...arguments_: unknown[]): void;
  error?(message: string, ...arguments_: unknown[]): void;
}

export interface ILLMProvider {
  name: string;
  model?: unknown;

  chat(request: unknown): AsyncIterable<unknown> | Promise<unknown>;
}

/**
 * LLM Provider interface - now compatible with Vercel AI SDK's LanguageModelV1.
 * The `model` field holds the actual LanguageModelV1 instance from @ai-sdk/openai, @ai-sdk/anthropic, etc.
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
export interface IToolRegistry {
  registerTool(id: string, impl: unknown): void;
  getTool(id: string): unknown | undefined;
  listTools(): string[];
  /** Prompt-concat plugin registry, isolated per runtime. Falls back to the process-level default registry. */
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
  /** Cancellation check, e.g. when the user stops a run. */
  isCancelled?: (conversationId: string) => boolean;
  /** Attachment injection for promptConcat, aligned with `PromptConcatOptions`. */
  readAttachmentFile?: (path: string) => Promise<Uint8Array | Buffer>;
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
  /**
   * Timeout for a single ToolOperation executed through the orchestration
   * facade (default 60_000ms). Covers the full lifecycle from apply until a
   * terminal phase, including scheduling and remote execution.
   */
  toolOperationTimeoutMs?: number;
  /**
   * Host-bound trust class of the node running this loop. Restricted and
   * quarantine nodes default the model-facing tool permission layer to deny
   * when no explicit wildcard rule exists. Bound by the host at assembly
   * time; never self-reported by the workload or model.
   */
  trustClass?: NodeTrustClass;
  /** History compaction window: keep the most recent N turns plus the last user message. */
  contextCompaction?: { maxMessages?: number; replayLastUserMessage?: boolean };
  /**
   * Auto-compaction: when message count exceeds threshold, summarizes old
   * conversation turns via truncation or LLM summarization. Default: disabled.
   */
  autoCompact?: {
    /** Trigger compaction when message count exceeds this (default: 50) */
    threshold?: number;
    /** Number of recent turns to preserve (default: 4) */
    recentTurnsToKeep?: number;
    /** Maximum token estimate before compaction; 0 disables token-based compaction */
    maxTokens?: number;
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
  tools: IToolRegistry;
  syncAdapters: IChatSyncAdapter[];
  network: INetworkService;
  /** Policy-scoped declarative manager facade shared by Agent loops and Agent-facing tools. */
  orchestration?: AgentOrchestrationClient;
  /** Let host runtimes preserve platform-specific message aliases/metadata while core owns the loop. */
  normalizeMessage?: (message: ChatMessage) => ChatMessage;

  /** AgentToolLoop ReAct behavior, migrated from the TidGi-Desktop agentToolLoop integration. */
  agentToolLoop?: AgentToolLoopOptions;
  /**
   * Host-injected runner used by `createMemeLoopRuntime` after a user sends a message.
   */
  runAgentToolLoop?: (input: AgentLoopInput) => AgentLoopGenerator;
  /** Run a child agent for orchestration loops such as AgentAgentLoop. */
  runChildAgent?: AgentLoopRuntime['runChildAgent'];
  /** Policy for loading script-backed loops. Defaults to bundled scripts + import specifiers only. */
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
  /** Resolve an AgentDefinition from host-specific sources. */
  resolveAgentDefinition?: (definitionId: string) => Promise<AgentDefinition | null>;
  /** Fallback logger used when the host does not inject one. */
  logger?: MemeLoopLogger;
  /** TidGi defineTool compatibility: legacy plugins call this without arguments. */
  isCancelled?: () => boolean;
}

export type AgentInstanceState =
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
