import type { AgentDefinition, ChatMessage, DetailReference } from '../protocol/index.js';

import { streamText } from 'ai';

import { executeHooks, hasHooks } from '../hooks/registry.js';
import type { MergedPermissions, PermissionAction, PermissionSet } from '../permission/index.js';
import { checkPermission, mergePermissionSets } from '../permission/index.js';
import { promptConcatStream } from '../prompt/promptConcat.js';
import { responseConcat } from '../prompt/responseConcat.js';
import { matchAllToolCallings, type ToolCallingMatch } from '../prompt/responsePatternUtility.js';
import { filterOldMessagesByDuration } from '../prompt/utilities.js';
import { autoCompact as autoCompactMessages, shouldCompact } from '../services/compact.js';
import { nextLamportClockForConversation } from '../storage/nextLamport.js';
import { requestApproval } from '../tools/approval.js';
import { createHooksWithPlugins, resolvePromptPluginMap, runResponseCompleteHooks } from '../tools/pluginRegistry.js';
import { extractMemeloopStructuredToolPayload, truncateToolSummary } from '../tools/structuredToolResult.js';
import type { DefineToolAgentFrameworkContext } from '../tools/types.js';
import type { AgentFrameworkContext } from '../types.js';

export type { TaskAgentGenerator, TaskAgentInput, TaskAgentStep } from './taskAgentContract.js';
import type { TaskAgentGenerator, TaskAgentInput } from './taskAgentContract.js';

const DEFAULT_MAX_ITERATIONS = 256;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

type LlmRequestMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown };

/**
 * Build layered permission sets from context options.
 *
 * Layers (lowest to highest priority):
 * 1. default  – `toolPermissions.default` (e.g. "allow")
 * 2. agent    – `toolPermissions.perAgent[definitionId]`
 * 3. user     – persisted in SQLite (loaded via permission storage)
 * 4. session  – `toolPermissions.rules` (global rules)
 */
function buildLayeredPermissions(
  options: AgentFrameworkContext['taskAgent'],
  definitionId: string,
  userSet?: PermissionSet,
): MergedPermissions {
  const global = options?.toolPermissions;
  const sets: PermissionSet[] = [];

  // Layer 1: default
  if (global?.default) {
    sets.push({
      source: 'default',
      rules: [{ toolPattern: '*', action: global.default }],
    });
  }

  // Layer 2: agent (per-agent overrides)
  const scoped = global?.perAgent?.[definitionId];
  if (scoped) {
    if (scoped.default) {
      sets.push({
        source: `agent:${definitionId}:default`,
        rules: [{ toolPattern: '*', action: scoped.default }],
      });
    }
    if (scoped.rules && scoped.rules.length > 0) {
      sets.push({
        source: `agent:${definitionId}`,
        rules: scoped.rules.map((r) => ({ toolPattern: r.pattern, action: r.action })),
      });
    }
  }

  // Layer 3: user (persisted)
  if (userSet && userSet.rules.length > 0) {
    sets.push(userSet);
  }

  // Layer 4: session (global rules override everything)
  if (global?.rules && global.rules.length > 0) {
    sets.push({
      source: 'session',
      rules: global.rules.map((r) => ({ toolPattern: r.pattern, action: r.action })),
    });
  }

  // Backward compatibility: if no explicit default action was provided,
  // insert an implied "allow all" as the lowest-priority layer.
  // This matches the old behavior: resolveToolPermission defaulted to "allow".
  if (!sets.some((s) => s.rules.some((r) => r.toolPattern === '*'))) {
    sets.unshift({
      source: 'implied-default',
      rules: [{ toolPattern: '*', action: 'allow' }],
    });
  }

  return mergePermissionSets(sets);
}

function compactHistory(
  history: ChatMessage[],
  options: AgentFrameworkContext['taskAgent'],
): ChatMessage[] {
  const maxMessages = options?.contextCompaction?.maxMessages ?? 0;
  if (maxMessages <= 0 || history.length <= maxMessages) return history;
  const dropped = history.length - maxMessages;
  const tail = history.slice(-maxMessages);
  const summaryMessage: ChatMessage = {
    ...(tail[0]),
    messageId: `${tail[0]?.conversationId ?? 'unknown'}:summary:${Date.now().toString(36)}`,
    role: 'assistant',
    content: `[context-summary] ${dropped} earlier messages were compacted.`,
  };
  if (options?.contextCompaction?.replayLastUserMessage === false) return tail;
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser) return [summaryMessage, ...tail];
  if (tail.some((m) => m.messageId === lastUser.messageId)) return tail;
  return [summaryMessage, lastUser, ...tail];
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk != null && typeof chunk === 'object' && 'content' in chunk) {
    const c = (chunk as { content?: unknown }).content;
    return typeof c === 'string' ? c : JSON.stringify(c);
  }
  return JSON.stringify(chunk);
}

async function* streamLlm(
  context: AgentFrameworkContext,
  request: unknown,
): AsyncGenerator<unknown, void, unknown> {
  const model = context.llmProvider.model;
  if (model != null) {
    const { messages } = request as { messages: LlmRequestMessage[] };
    const result = streamText({ model: model as any, messages: messages as any });
    for await (const chunk of result.textStream) {
      yield chunk;
    }
    return;
  }

  // Fallback to legacy chat() method
  const chatFunction = (context.llmProvider as any).chat as
    | ((request_: unknown) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>)
    | undefined;
  if (typeof chatFunction === 'function') {
    const raw = chatFunction(request);
    let resolved: unknown = raw;
    if (raw != null && typeof (raw as Promise<unknown>).then === 'function') {
      resolved = await (raw as Promise<unknown>);
    }
    if (isAsyncIterable(resolved)) {
      for await (const chunk of resolved) {
        yield chunk;
      }
      return;
    }
    yield resolved;
    return;
  }

  throw new Error(
    'ILLMProvider: neither model nor chat() is available. Provide a LanguageModelV1 or chat() method.',
  );
}

function chatMessageToModelMessage(m: ChatMessage): LlmRequestMessage {
  // Map ChatRole to LLM model roles (agent/error -> assistant)
  const role: LlmRequestMessage['role'] = m.role === 'agent' || m.role === 'error'
    ? 'assistant'
    : m.role === 'tool'
    ? 'tool'
    : m.role === 'user'
    ? 'user'
    : 'assistant';
  return {
    role,
    content: m.content,
  };
}

async function resolveAgentDefinitionModel(
  context: AgentFrameworkContext,
  definitionId: string,
): Promise<AgentDefinition | null> {
  if (context.resolveAgentDefinition) {
    return context.resolveAgentDefinition(definitionId);
  }
  return context.storage.getAgentDefinition(definitionId);
}

async function inferDefinitionId(
  storage: AgentFrameworkContext['storage'],
  conversationId: string,
): Promise<string> {
  try {
    const meta = await storage.getConversationMeta(conversationId);
    if (meta?.definitionId) return meta.definitionId;
  } catch {
    /* optional on old mocks */
  }
  const parts = conversationId.split(':');
  if (parts.length >= 2) {
    return parts.slice(0, -1).join(':');
  }
  return conversationId;
}

async function buildLlmMessages(
  context: AgentFrameworkContext,
  conversationId: string,
  history: ChatMessage[],
): Promise<LlmRequestMessage[]> {
  const definitionId = await inferDefinitionId(context.storage, conversationId);
  const def = await resolveAgentDefinitionModel(context, definitionId);
  const fw = def?.agentFrameworkConfig as { prompts?: unknown[]; plugins?: unknown[] } | undefined;
  const maxHistoryAgeMs = context.taskAgent?.maxHistoryAgeMs ?? 0;
  const historyForPrompt = maxHistoryAgeMs > 0 ? filterOldMessagesByDuration(history, maxHistoryAgeMs) : history;

  if (fw?.prompts && Array.isArray(fw.prompts) && fw.prompts.length > 0) {
    const readAttachmentFile = context.taskAgent?.readAttachmentFile;
    const gen = promptConcatStream(
      {
        agentFrameworkConfig: {
          prompts: fw.prompts as import('../prompt/types.js').PromptNode[],
          plugins: (fw.plugins ?? []) as import('../prompt/types.js').PromptPluginConfig[],
          response: [],
        },
      },
      historyForPrompt,
      context,
      readAttachmentFile ? { readAttachmentFile } : undefined,
    );
    let lastFlat: LlmRequestMessage[] = [];
    for await (const state of gen) {
      lastFlat = state.flatPrompts as LlmRequestMessage[];
    }
    const withoutTrailingUser = lastFlat.length > 0 && lastFlat[lastFlat.length - 1]?.role === 'user'
      ? lastFlat.slice(0, -1)
      : lastFlat;
    return [...withoutTrailingUser, ...historyForPrompt.map(chatMessageToModelMessage)];
  }

  const systemText = typeof def?.systemPrompt === 'string' ? def.systemPrompt.trim() : '';
  if (systemText.length > 0) {
    return [
      { role: 'system', content: systemText },
      ...historyForPrompt.map(chatMessageToModelMessage),
    ];
  }

  return historyForPrompt.map(chatMessageToModelMessage);
}

function formatToolResultMessage(
  toolName: string,
  parameters: Record<string, unknown>,
  body: string,
  isError: boolean,
): string {
  return `<functions_result>
Tool: ${toolName}
Parameters: ${JSON.stringify(parameters)}
${isError ? 'Error' : 'Result'}: ${body}
</functions_result>`;
}

type ToolRunRow = {
  text: string;
  isError: boolean;
  detailRef?: DetailReference;
  awaitSessionId?: string;
};

async function executeRegistryTool(
  context: AgentFrameworkContext,
  toolId: string,
  parameters: Record<string, unknown>,
): Promise<ToolRunRow> {
  const normalizedId = toolId.includes('-')
    ? toolId.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
    : toolId;
  const impl = (context.tools.getTool(toolId) ?? context.tools.getTool(normalizedId)) as
    | ((arguments_: Record<string, unknown>) => unknown | Promise<unknown>)
    | undefined;

  if (typeof impl !== 'function') {
    return {
      text: `No tool registered for "${toolId}".`,
      isError: true,
    };
  }

  try {
    const raw = await impl(parameters);
    if (raw != null && typeof raw === 'object') {
      const o = raw as { error?: string; result?: unknown };
      if (typeof o.error === 'string' && o.error.length > 0) {
        return { text: o.error, isError: true };
      }
      if ('result' in o) {
        return {
          text: typeof o.result === 'string' ? o.result : JSON.stringify(o.result),
          isError: false,
        };
      }
      const structured = extractMemeloopStructuredToolPayload(raw);
      if (structured) {
        return {
          text: structured.summary,
          isError: false,
          detailRef: structured.detailRef,
          awaitSessionId: structured.awaitSessionId,
        };
      }
    }
    return { text: typeof raw === 'string' ? raw : JSON.stringify(raw), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const log = context.logger?.warn ?? console.warn.bind(console);
    log('[taskAgent] tool execution error', toolId, message);
    return { text: message, isError: true };
  }
}

function toolCallHandledInAgentMessages(
  agentMessages: import('../types.js').AgentInstanceMessage[],
  assistantContent: string,
  call: ToolCallingMatch & { found: true },
): boolean {
  let assistantIndex = -1;
  for (let index = agentMessages.length - 1; index >= 0; index--) {
    const m = agentMessages[index];
    if (m.role === 'assistant' && m.content === assistantContent) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return false;
  const after = agentMessages.slice(assistantIndex + 1);
  return after.some(
    (m) =>
      m.role === 'tool' &&
      (m.metadata?.toolId === call.toolId ||
        (typeof m.content === 'string' && m.content.includes(`Tool: ${call.toolId}`))),
  );
}

/**
 * TaskAgent：TidGi `basicPromptConcatHandler` 对齐版。
 *
 * - defineTool：`createHooksWithPlugins` + `responseComplete` + `responseConcat`（postProcess）
 * - 回退：`IToolRegistry` 执行未被插件处理的 tool 调用
 */
export function createTaskAgent(
  context: AgentFrameworkContext,
): (input: TaskAgentInput) => TaskAgentGenerator {
  return async function* taskAgent(input: TaskAgentInput): TaskAgentGenerator {
    const options = context.taskAgent ?? {};
    const enableToolLoop = options.enableToolLoop !== false;
    const fallbackRegistry = options.fallbackRegistryTools !== false;
    const maxIterations = options.maxIterations != null && options.maxIterations > 0
      ? options.maxIterations
      : DEFAULT_MAX_ITERATIONS;
    const autoCompactOptions = options.autoCompact;
    const checkpointOptions = options.sessionCheckpoint;

    const now = Date.now();
    const lamportClock = await nextLamportClockForConversation(
      context.storage,
      input.conversationId,
    );
    const userMessage: ChatMessage = {
      messageId: `${input.conversationId}:${now.toString(36)}`,
      conversationId: input.conversationId,
      originNodeId: 'local',
      timestamp: now,
      lamportClock,
      role: 'user',
      content: input.message,
    };

    // Resume session: load previous messages before appending new user message
    if (input.resumeSession && input.resumeSession.length > 0) {
      // Insert resume messages into storage (skip duplicates via messageId)
      await context.storage.insertMessagesIfAbsent(input.resumeSession);
    }

    await context.storage.appendMessage(userMessage);

    // Execute UserPromptSubmit hooks
    if (hasHooks('UserPromptSubmit')) {
      const hookResult = await executeHooks('UserPromptSubmit', context, {
        message: input.message,
        conversationId: input.conversationId,
      });
      if (!hookResult.allowed) {
        yield {
          type: 'thinking',
          data: {
            status: 'blocked',
            conversationId: input.conversationId,
            reason: hookResult.reason ?? 'Blocked by UserPromptSubmit hook',
          },
        };
        return;
      }
    }

    let iteration = 0;
    const recentToolCalls: string[] = [];

    while (iteration < maxIterations) {
      iteration++;

      if (options.isCancelled?.(input.conversationId)) {
        yield {
          type: 'thinking',
          data: { status: 'cancelled', conversationId: input.conversationId },
        };
        return;
      }

      const rawHistory = await context.storage.getMessages(input.conversationId, {
        mode: 'full-content',
      });

      // Auto-compact if message count exceeds threshold (before contextCompaction)
      let history = rawHistory;
      if (autoCompactOptions) {
        const threshold = autoCompactOptions.threshold ?? 50;
        if (shouldCompact(history, threshold)) {
          try {
            const result = await autoCompactMessages(history, {
              recentTurnsToKeep: autoCompactOptions.recentTurnsToKeep ?? 4,
              maxTokens: autoCompactOptions.maxTokens ?? 0,
              llmProvider: context.llmProvider,
            });
            if (result.compacted) {
              history = result.messages;
              yield {
                type: 'thinking',
                data: {
                  status: 'compacted',
                  conversationId: input.conversationId,
                  droppedCount: result.droppedCount,
                  summaryText: result.summaryText,
                  iteration,
                },
              };
              // Persist the summary message to storage
              const summaryMessage = result.messages[0];
              if (summaryMessage) {
                const lamportSummary = await nextLamportClockForConversation(
                  context.storage,
                  input.conversationId,
                );
                await context.storage.appendMessage({
                  ...summaryMessage,
                  lamportClock: lamportSummary,
                });
              }
            }
          } catch (error) {
            const log = context.logger?.warn ?? console.warn.bind(console);
            log('[taskAgent] auto-compact failed:', error);
          }
        }
      }

      history = compactHistory(history, options);

      const hookContext: DefineToolAgentFrameworkContext = {
        ...context,
        agent: { id: input.conversationId, messages: history },
        persistAgentMessage: async (m) => {
          await context.storage.appendMessage(m);
        },
      };

      yield {
        type: 'thinking',
        data: {
          status: 'calling-llm',
          conversationId: input.conversationId,
          messageCount: history.length,
          iteration,
        },
      };

      const messages = await buildLlmMessages(context, input.conversationId, history);
      const request = { conversationId: input.conversationId, messages };
      let assistantText = '';
      for await (const c of streamLlm(context, request)) {
        assistantText += chunkToText(c);
        yield { type: 'message', data: c };
      }

      const definitionId = await inferDefinitionId(context.storage, input.conversationId);
      const def = await resolveAgentDefinitionModel(context, definitionId);
      const fw = def?.agentFrameworkConfig as
        | { prompts?: unknown[]; plugins?: unknown[]; response?: unknown[] }
        | undefined;
      const hasPlugins = Boolean(fw?.plugins && Array.isArray(fw.plugins) && fw.plugins.length > 0);

      const assistantMessage: ChatMessage = {
        messageId: `${input.conversationId}:a:${Date.now().toString(36)}`,
        conversationId: input.conversationId,
        originNodeId: 'local',
        timestamp: Date.now(),
        lamportClock: await nextLamportClockForConversation(context.storage, input.conversationId),
        role: 'assistant',
        content: assistantText,
      };
      hookContext.agent.messages.push(assistantMessage);
      await hookContext.persistAgentMessage?.(assistantMessage);

      const { calls, parallel } = matchAllToolCallings(assistantText);

      if (hasPlugins && fw) {
        const { hooks } = await createHooksWithPlugins(
          fw as { plugins: Array<{ toolId: string }> },
          {
            pluginRegistry: resolvePromptPluginMap(context),
          },
        );
        const rcPayload: {
          agentFrameworkContext: DefineToolAgentFrameworkContext;
          response: { status: 'done'; content: string };
          agentFrameworkConfig: {
            plugins?: import('../tools/types.js').FrameworkPluginToolConfig[];
          };
          requestId: undefined;
          toolConfig: import('../tools/types.js').FrameworkPluginToolConfig;
          actions?: { yieldNextRoundTo?: 'human' | 'self' };
        } = {
          agentFrameworkContext: hookContext,
          response: { status: 'done', content: assistantText },
          agentFrameworkConfig: fw as {
            plugins?: import('../tools/types.js').FrameworkPluginToolConfig[];
          },
          requestId: undefined,
          toolConfig: { id: '_memeloop', toolId: '_memeloop' },
          actions: {},
        };
        await runResponseCompleteHooks(hooks, rcPayload);

        const post = await responseConcat(
          fw as {
            response?: import('../tools/types.js').AgentResponse[];
            plugins?: import('../tools/types.js').FrameworkPluginToolConfig[];
          },
          assistantText,
          hookContext,
          hookContext.agent.messages,
        );

        const yieldTarget = rcPayload.actions?.yieldNextRoundTo ?? post.yieldNextRoundTo;

        if (yieldTarget === 'human') {
          yield {
            type: 'thinking',
            data: { status: 'input-required', conversationId: input.conversationId },
          };
          return;
        }
        if (yieldTarget === 'self') {
          continue;
        }
      }

      if (calls.length === 0) {
        return;
      }

      if (!enableToolLoop) {
        return;
      }

      const pending = calls.filter(
        (c) => !toolCallHandledInAgentMessages(hookContext.agent.messages, assistantText, c),
      );

      if (pending.length === 0) {
        if (hasPlugins && calls.length > 0) {
          continue;
        }
        return;
      }

      if (!fallbackRegistry && hasPlugins) {
        continue;
      }

      // Build layered permissions for this iteration
      const mergedPermissions = buildLayeredPermissions(options, definitionId);

      // Check permissions for all pending calls without yielding
      const actionMap: Array<{ call: (typeof pending)[0]; action: PermissionAction }> = [];
      for (const call of pending) {
        const action = checkPermission(call.toolId, mergedPermissions);
        actionMap.push({ call, action });
      }

      // Resolve "ask" actions: yield permission_request and await decision.
      // Track which calls were denied by the user (vs. denied by policy)
      // so we can produce the correct error message for backward compatibility.
      const askDeniedCallIds = new Set<string>();
      for (const entry of actionMap) {
        if (entry.action !== 'ask') continue;
        yield {
          type: 'permission_request' as const,
          data: { tool: entry.call.toolId, args: entry.call.parameters },
        };
        const decision = await requestApproval(
          {
            approvalId: `${input.conversationId}:${Date.now().toString(36)}:${entry.call.toolId}`,
            agentId: input.conversationId,
            toolName: entry.call.toolId,
            parameters: entry.call.parameters,
            created: new Date(),
          },
          60_000,
        );
        if (decision !== 'allow') {
          entry.action = 'deny';
          askDeniedCallIds.add(
            `${entry.call.toolId}:${JSON.stringify(entry.call.parameters)}`,
          );
        } else {
          entry.action = 'allow';
        }
      }

      // Separate allowed vs denied
      const allowedCalls = actionMap.filter((r) => r.action === 'allow').map((r) => r.call);
      const deniedCalls = actionMap.filter((r) => r.action === 'deny').map((r) => r.call);

      // Yield denied tool results and persist them
      for (const call of deniedCalls) {
        const wasAskDenied = askDeniedCallIds.has(
          `${call.toolId}:${JSON.stringify(call.parameters)}`,
        );
        const errorText = wasAskDenied
          ? 'Tool approval denied or timed out'
          : 'Denied by tool permission';
        yield {
          type: 'tool' as const,
          data: {
            toolId: call.toolId,
            parameters: call.parameters,
            parallel: false,
            result: errorText,
            isError: true,
          },
        };
        const lamportTool = await nextLamportClockForConversation(
          context.storage,
          input.conversationId,
        );
        await context.storage.appendMessage({
          messageId: `${input.conversationId}:t:${call.toolId}:${Date.now().toString(36)}`,
          conversationId: input.conversationId,
          originNodeId: 'local',
          timestamp: Date.now(),
          lamportClock: lamportTool,
          role: 'tool',
          content: formatToolResultMessage(call.toolId, call.parameters, errorText, true),
        });
      }

      if (allowedCalls.length === 0) {
        continue;
      }

      const executeWithGuards = async (call: (typeof pending)[0]): Promise<ToolRunRow> => {
        const signature = `${call.toolId}:${JSON.stringify(call.parameters)}`;
        recentToolCalls.push(signature);
        const threshold = Math.max(2, options.doomLoopThreshold ?? 3);
        const last = recentToolCalls.slice(-threshold);
        if (last.length === threshold && last.every((x) => x === signature)) {
          return { text: 'Blocked by doom-loop guard', isError: true };
        }

        // Execute PreToolUse hooks
        if (hasHooks('PreToolUse')) {
          const preResult = await executeHooks('PreToolUse', context, {
            toolId: call.toolId,
            parameters: call.parameters,
            conversationId: input.conversationId,
          });
          if (!preResult.allowed) {
            return {
              text: preResult.reason ?? 'Blocked by PreToolUse hook',
              isError: true,
            };
          }
        }

        const row = await executeRegistryTool(context, call.toolId, call.parameters);

        // Execute PostToolUse hooks
        if (hasHooks('PostToolUse')) {
          await executeHooks('PostToolUse', context, {
            toolId: call.toolId,
            parameters: call.parameters,
            result: row.text,
            isError: row.isError,
            conversationId: input.conversationId,
          });
        }

        return row;
      };

      const persistToolResult = async (
        call: (typeof pending)[0],
        row: ToolRunRow,
      ): Promise<void> => {
        const lamportTool = await nextLamportClockForConversation(
          context.storage,
          input.conversationId,
        );
        await context.storage.appendMessage({
          messageId: `${input.conversationId}:t:${call.toolId}:${Date.now().toString(36)}`,
          conversationId: input.conversationId,
          originNodeId: 'local',
          timestamp: Date.now(),
          lamportClock: lamportTool,
          role: 'tool',
          content: formatToolResultMessage(call.toolId, call.parameters, row.text, row.isError),
          detailRef: row.detailRef,
        });
      };

      const persistTerminalAwaitCompletion = async (
        call: (typeof pending)[0],
        row: ToolRunRow,
      ): Promise<void> => {
        const sid = row.awaitSessionId;
        const wait = options.waitForTerminalSession;
        if (!sid || !wait || row.isError) return;
        const done = await wait(sid);
        const lamport2 = await nextLamportClockForConversation(
          context.storage,
          input.conversationId,
        );
        const body = truncateToolSummary(
          `[terminal.await done] session=${sid}\nexitCode: ${done.exitCode ?? 'null'}\n---\n${done.truncatedOutput}`,
        );
        await context.storage.appendMessage({
          messageId: `${input.conversationId}:t:${call.toolId}:await:${Date.now().toString(36)}`,
          conversationId: input.conversationId,
          originNodeId: 'local',
          timestamp: Date.now(),
          lamportClock: lamport2,
          role: 'tool',
          content: formatToolResultMessage(call.toolId, call.parameters, body, false),
          detailRef: row.detailRef
            ? { ...row.detailRef, exitCode: done.exitCode ?? row.detailRef.exitCode }
            : undefined,
        });
      };

      if (parallel) {
        const results = await Promise.all(
          allowedCalls.map(async (call) => ({ call, ...(await executeWithGuards(call)) })),
        );
        for (const row of results) {
          yield {
            type: 'tool' as const,
            data: {
              toolId: row.call.toolId,
              parameters: row.call.parameters,
              parallel: true,
              result: row.text,
              isError: row.isError,
            },
          };
        }
        for (const row of results) {
          await persistToolResult(row.call, {
            text: row.text,
            isError: row.isError,
            detailRef: row.detailRef,
          });
        }
        for (const row of results) {
          await persistTerminalAwaitCompletion(row.call, row);
        }
      } else {
        for (const call of allowedCalls) {
          const row = await executeWithGuards(call);
          yield {
            type: 'tool',
            data: {
              toolId: call.toolId,
              parameters: call.parameters,
              parallel: false,
              result: row.text,
              isError: row.isError,
            },
          };
          await persistToolResult(call, row);
          await persistTerminalAwaitCompletion(call, row);
        }
      }

      // Save session checkpoint after each completed turn
      if (checkpointOptions?.enabled) {
        const checkpointStore = checkpointOptions.store;
        if (!checkpointStore) {
          const log = context.logger?.warn ?? console.warn.bind(console);
          log('[taskAgent] checkpoint enabled without a checkpoint store');
          continue;
        }
        try {
          const allMessages = await context.storage.getMessages(input.conversationId, {
            mode: 'full-content',
          });
          await checkpointStore.saveCheckpoint(input.conversationId, allMessages);
        } catch (error) {
          const log = context.logger?.warn ?? console.warn.bind(console);
          log('[taskAgent] checkpoint save failed:', error);
        }
      }

      continue;
    }

    yield {
      type: 'thinking',
      data: { status: 'max-iterations', conversationId: input.conversationId, maxIterations },
    };
  };
}
