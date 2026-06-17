import type { AgentDefinition, AgentInstanceMeta } from "./agent/types.js";
import type { AttachmentReference } from "./conversation/index.js";
import type { ChatMessage } from "./conversation/index.js";
import type { AgentFrameworkConfig } from "./promptUtilities/types.js";
import type { ConversationMeta } from "./sync/protocol.js";

import type { AgentLoopGenerator, AgentLoopInput } from "./agentLoops/types.js";
import type { CheckpointStore } from "./storage/sessionStorage.js";

export type ConversationQueryMode = "metadata-only" | "full-content" | "on-demand";

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

  /**
   * 读取已落库的附件二进制（用于节点间 RPC `memeloop.storage.getAttachmentBlob`）。
   * 未实现时远端同步应通过其它通道拉取附件。
   */
  readAttachmentData?(contentHash: string): Promise<Uint8Array | null>;

  getAgentDefinition(id: string): Promise<AgentDefinition | null>;

  /**
   * 若实现，可用 `SELECT MAX(lamportClock)` 避免为时钟扫描全量消息。
   */
  getMaxLamportClockForConversation?(conversationId: string): Promise<number>;

  saveAgentInstance(meta: AgentInstanceMeta): Promise<void>;

  /**
   * 读取会话目录行（用于 TaskAgent 解析 definitionId 等）。
   */
  getConversationMeta(conversationId: string): Promise<ConversationMeta | null>;

  /** IM 用户与会话绑定（memeloop-cli + SQLite 持久化）。 */
  getImBinding?(
    channelId: string,
    imUserId: string,
  ): Promise<import("./im/protocol.js").IMChannelBinding | null>;
  setImBinding?(record: import("./im/protocol.js").IMChannelBinding): Promise<void>;
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
  /**
   * Prompt-concat 插件表（defineTool 注册的 `PromptConcatTool`），按运行时隔离。
   * 未实现时回退到进程级默认注册表（见 pluginRegistry）。
   */
  getPromptPlugins?: () => Map<
    string,
    (hooks: import("./tools/types.js").PromptConcatHooks) => void
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

export interface LlmIoLoopOptions {
  /** 最大 LLM↔工具往返次数，0 表示不限制（仍受内部安全上限约束） */
  maxIterations?: number;
  /** 是否解析 `<tool_use>` / `<function_call>` 并通过 IToolRegistry 执行（默认 true） */
  enableToolLoop?: boolean;
  /** 取消检查（例如用户点停止）；按会话维度 */
  isCancelled?: (conversationId: string) => boolean;
  /** promptConcat 附件注入（与 PromptConcatOptions 一致） */
  readAttachmentFile?: (path: string) => Promise<Uint8Array | Buffer>;
  /** 超过该时长的历史消息不送入 LLM（毫秒）；0 或未设置表示不裁剪 */
  maxHistoryAgeMs?: number;
  /**
   * 在已配置 `defineTool` / plugins 时，对未被 `onResponseComplete` 处理的 tool 调用回退到 `IToolRegistry`（默认 true）。
   */
  fallbackRegistryTools?: boolean;
  /**
   * 工具权限规则（默认 allow）。
   * 支持 wildcard，如 "terminal.*" / "file.read"。
   */
  toolPermissions?: {
    default?: "allow" | "ask" | "deny";
    rules?: Array<{ pattern: string; action: "allow" | "ask" | "deny" }>;
    perAgent?: Record<
      string,
      {
        default?: "allow" | "ask" | "deny";
        rules?: Array<{ pattern: string; action: "allow" | "ask" | "deny" }>;
      }
    >;
  };
  /** 相同 tool+input 连续触发阈值（默认 3） */
  doomLoopThreshold?: number;
  /** 历史压缩窗口：超过后只保留最近 N 条 + 最后一条用户消息 */
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
   * After a tool returns `__memeloopToolResult.awaitSessionId`, TaskAgent waits here before the next LLM round
   * (terminal `mode: 'await'`).
   */
  waitForTerminalSession?: (sessionId: string) => Promise<{
    exitCode: number | null;
    truncatedOutput: string;
  }>;
};

export interface IToolRegistry {
  registerTool(id: string, impl: unknown): void;
  getTool(id: string): unknown | undefined;
  listTools(): string[];
  /**
   * Prompt-concat 插件表（defineTool 注册的 `PromptConcatTool`），按运行时隔离。
   * 未实现时回退到进程级默认注册表（见 pluginRegistry）。
   */
  getPromptPlugins?: () => Map<
    string,
    (hooks: import("./tools/types.js").PromptConcatHooks) => void
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

export interface LlmIoLoopOptions {
  /** 最大 LLM↔工具往返次数，0 表示不限制（仍受内部安全上限约束） */
  maxIterations?: number;
  /** 是否解析 `<tool_use>` / `<function_call>` 并通过 IToolRegistry 执行（默认 true） */
  enableToolLoop?: boolean;
  /** 取消检查（例如用户点停止）；按会话维度 */
  isCancelled?: (conversationId: string) => boolean;
  /** promptConcat 附件注入（与 PromptConcatOptions 一致） */
  readAttachmentFile?: (path: string) => Promise<Uint8Array | Buffer>;
  /** 超过该时长的历史消息不送入 LLM（毫秒）；0 或未设置表示不裁剪 */
  maxHistoryAgeMs?: number;
  /**
   * 在已配置 `defineTool` / plugins 时，对未被 `onResponseComplete` 处理的 tool 调用回退到 `IToolRegistry`（默认 true）。
   */
  fallbackRegistryTools?: boolean;
  /**
   * 工具权限规则（默认 allow）。
   * 支持 wildcard，如 "terminal.*" / "file.read"。
   */
  toolPermissions?: {
    default?: "allow" | "ask" | "deny";
    rules?: Array<{ pattern: string; action: "allow" | "ask" | "deny" }>;
    perAgent?: Record<
      string,
      {
        default?: "allow" | "ask" | "deny";
        rules?: Array<{ pattern: string; action: "allow" | "ask" | "deny" }>;
      }
    >;
  };
  /** 相同 tool+input 连续触发阈值（默认 3） */
  doomLoopThreshold?: number;
  /** 历史压缩窗口：超过后只保留最近 N 条 + 最后一条用户消息 */
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
   * After a tool returns `__memeloopToolResult.awaitSessionId`, TaskAgent waits here before the next LLM round
   * (terminal `mode: 'await'`).
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
  /** Let host runtimes preserve platform-specific message aliases/metadata while core owns the loop. */
  normalizeMessage?: (message: ChatMessage) => ChatMessage;

  /** LLM_IO_Loop 配置（taskAgent 字段名保持兼容） */
  taskAgent?: LlmIoLoopOptions;
  /**
   * 由宿主注入（如 memeloop-cli）：存在时 `createMemeLoopRuntime` 在用户发消息后运行完整 TaskAgent 管线。
   */
  runTaskAgent?: (input: AgentLoopInput) => AgentLoopGenerator;
  /**
   * Build the agent view supplied to defineTool hooks for a conversation.
   */
  resolveAgentRuntimeView?: (
    conversationId: string,
    messages: ChatMessage[],
  ) => Promise<AgentInstanceModel>;
  /**
   * defineTool / TidGi 兼容：当前轮次的 agent 视图（`agent.messages` 与 `ChatMessage` 由 TaskAgent 同步）。
   */
  agent?: { id: string; messages: ChatMessage[] };
  /** 将 `ChatMessage` 持久化（可选，由 runtime 注入） */
  persistAgentMessage?: (message: ChatMessage) => Promise<void>;
  /**
   * 由 `createMemeLoopRuntime` 写入取消标记，`taskAgent.isCancelled` 应与此集合一致（如 memeloop-cli）。
   */
  conversationCancellation?: Set<string>;
  /**
   * 解析 AgentDefinition（如节点合并 YAML + 内置 + SQLite）。未设置时仅用 `storage.getAgentDefinition`。
   */
  resolveAgentDefinition?: (definitionId: string) => Promise<AgentDefinition | null>;
  /** 未注入时 TaskAgent 等对关键路径使用 console.warn/error。 */
  logger?: MemeLoopLogger;
  /** TidGi defineTool compatibility: legacy plugins call this without arguments. */
  isCancelled?: () => boolean;
}

export type AgentInstanceState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "unknown";

export interface AgentInstanceLatestStatus {
  state: AgentInstanceState;
  message?: ChatMessage;
  /** Human-readable sub-status for the header — shown while agent is working. */
  progress?: string;
  created?: Date;
  modified?: Date;
}

export interface AgentInstanceModel extends Omit<AgentDefinition, "name"> {
  agentDefId: string;
  name?: string;
  agentFrameworkConfig?: AgentFrameworkConfig;
  messages: ChatMessage[];
  status: AgentInstanceLatestStatus;
  created: Date;
  modified?: Date;
  closed?: boolean;
  volatile?: boolean;
  isSubAgent?: boolean;
  parentAgentId?: string;
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
