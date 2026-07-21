/**
 * TidGi-Desktop `agentInstance/tools/types.ts` 迁移并适配 memeloop（无 tapable，用 HookSlot.promise 串行执行）。
 */
import type { ChatMessage } from '../conversation/index.js';
import type { AgentLoopStep } from '../loopAPI/types.js';
import type { ToolCallingMatch } from '../promptUtilities/responsePatternUtility.js';
import type { IPrompt } from '../promptUtilities/types.js';
import type { AgentFrameworkContext, AgentInstance } from '../types.js';

export type { AgentLoopStep };

/** 供 defineTool / 审批使用：agent 视图包含完整 AgentInstance。 */
export type DefineToolAgentFrameworkContext = AgentFrameworkContext & {
  agent: AgentInstance;
};

export type ToolApprovalMode = 'auto' | 'confirm';

export interface ToolApprovalConfig {
  mode: ToolApprovalMode;
  allowPatterns?: string[];
  denyPatterns?: string[];
  timeoutMs?: number;
}

export type ApprovalDecision = 'allow' | 'deny' | 'pending';

export interface ToolApprovalRequest {
  approvalId: string;
  agentId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  originalText?: string;
  created: Date;
}

export type YieldNextRoundTarget = 'human' | 'self' | `agent:${string}`;

export interface ToolActions {
  yieldNextRoundTo?: YieldNextRoundTarget;
  newUserMessage?: string;
  toolCalling?: ToolCallingMatch;
}

export interface BaseToolContext {
  agentFrameworkContext: DefineToolAgentFrameworkContext;
  metadata?: Record<string, unknown>;
  actions?: ToolActions;
}

/** 与 TidGi IPromptConcatTool 对齐的插件行 */
export interface FrameworkPluginToolConfig {
  id: string;
  toolId: string;
  enabled?: boolean;
  caption?: string;
  content?: string;
  forbidOverrides?: boolean;
  approval?: ToolApprovalConfig;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface PromptConcatHookContext extends BaseToolContext {
  messages: ChatMessage[];
  prompts: IPrompt[];
  toolConfig: FrameworkPluginToolConfig;
  pluginIndex?: number;
}

export interface AgentResponse {
  id: string;
  text?: string;
  enabled?: boolean;
  children?: AgentResponse[];
}

export interface PostProcessContext extends PromptConcatHookContext {
  llmResponse: string;
  responses?: AgentResponse[];
}

/** 流式响应子集（memeloop ILLMProvider 聚合为最终文本后注入） */
export interface AIStreamResponseSubset {
  status: 'update' | 'done';
  content: string;
}

export interface AIResponseContext extends BaseToolContext {
  toolConfig: FrameworkPluginToolConfig;
  agentFrameworkConfig?: { plugins?: FrameworkPluginToolConfig[] };
  response: AIStreamResponseSubset;
  requestId?: string;
  isFinal?: boolean;
}

export interface UserMessageContext extends BaseToolContext {
  content: {
    text: string;
    file?: unknown;
    wikiTiddlers?: Array<{ workspaceName: string; tiddlerTitle: string }>;
  };
  messageId: string;
  timestamp: Date;
}

export interface AgentStatusContext extends BaseToolContext {
  status: {
    state: 'working' | 'completed' | 'failed' | 'canceled';
    modified: Date;
  };
}

export interface ToolExecutionContext extends BaseToolContext {
  toolResult: {
    success: boolean;
    data?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  };
  toolInfo: {
    toolId: string;
    parameters: Record<string, unknown>;
    originalText?: string;
  };
  requestId?: string;
}

/**
 * Hook 槽：与 tapable AsyncSeriesHook 一致 — `tapAsync` 注册，`promise(ctx)` 串行触发。
 */
export type TapAsyncHandler = {
  bivarianceHack(context: unknown, callback: () => void): void;
}['bivarianceHack'];

export interface HookSlot {
  tapAsync(name: string, function_: TapAsyncHandler): void;
  promise(context: unknown): Promise<void>;
}

export interface PromptConcatHooks {
  processPrompts: HookSlot;
  finalizePrompts: HookSlot;
  postProcess: HookSlot;
  userMessageReceived: HookSlot;
  agentStatusChanged: HookSlot;
  toolExecuted: HookSlot;
  responseUpdate: HookSlot;
  responseComplete: HookSlot;
}

export type PromptConcatTool = (hooks: PromptConcatHooks) => void;
