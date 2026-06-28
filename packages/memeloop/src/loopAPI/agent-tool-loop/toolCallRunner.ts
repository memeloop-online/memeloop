import { createChatMessage, type DetailReference } from '../../conversation/index.js';
import { nextLamportClockForConversation } from '../../storage/nextLamport.js';
import { extractMemeloopStructuredToolPayload, truncateToolSummary } from '../../tools/structuredToolResult.js';
import type { AgentFrameworkContext } from '../../types.js';
import { executeHooks, hasHooks } from '../hooks/registry.js';

import type { AgentLoopStep } from '../types.js';
import type { PendingToolCall } from './toolUseGate.js';

type ToolRunRow = {
  text: string;
  isError: boolean;
  payload?: unknown;
  detailRef?: DetailReference;
  awaitSessionId?: string;
};

type CompletedToolCall = ToolRunRow & { call: PendingToolCall };

async function executeRegistryTool(
  context: AgentFrameworkContext,
  toolId: string,
  parameters: Record<string, unknown>,
): Promise<ToolRunRow> {
  const normalizedId = toolId.includes('-')
    ? toolId.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
    : toolId;
  const impl = (context.tools.getTool(toolId) ?? context.tools.getTool(normalizedId)) as
    | ((arguments_: Record<string, unknown>) => unknown)
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
          payload: typeof o.result === 'string' ? undefined : o.result,
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
    if (context.logger?.warn) {
      context.logger.warn('[agentToolLoop] tool execution error', toolId, message);
    } else {
      console.warn('[agentToolLoop] tool execution error', toolId, message);
    }
    return { text: message, isError: true };
  }
}

async function executeWithGuards(
  context: AgentFrameworkContext,
  options: AgentFrameworkContext['agentToolLoop'],
  conversationId: string,
  recentToolCalls: string[],
  call: PendingToolCall,
): Promise<ToolRunRow> {
  const signature = `${call.toolId}:${JSON.stringify(call.parameters)}`;
  recentToolCalls.push(signature);
  const threshold = Math.max(2, options?.doomLoopThreshold ?? 3);
  const last = recentToolCalls.slice(-threshold);
  if (last.length === threshold && last.every((x) => x === signature)) {
    return { text: 'Blocked by doom-loop guard', isError: true };
  }

  const row = await executeRegistryTool(context, call.toolId, call.parameters);

  if (hasHooks('PostToolUse')) {
    await executeHooks('PostToolUse', context, {
      toolId: call.toolId,
      parameters: call.parameters,
      result: row.text,
      isError: row.isError,
      conversationId,
    });
  }

  return row;
}

async function persistToolResult(
  context: AgentFrameworkContext,
  conversationId: string,
  call: PendingToolCall,
  row: ToolRunRow,
): Promise<void> {
  const lamportTool = await nextLamportClockForConversation(context.storage, conversationId);
  await context.storage.appendMessage(createChatMessage({
    messageId: `${conversationId}:t:${call.toolId}:${Date.now().toString(36)}`,
    conversationId,
    originNodeId: 'local',
    lamportClock: lamportTool,
    role: 'tool',
    parts: [{
      type: 'tool-result',
      toolName: call.toolId,
      parameters: call.parameters,
      result: row.text,
      isError: row.isError,
      payload: row.payload,
      detailRef: row.detailRef,
    }],
    detailRef: row.detailRef,
    metadata: {
      isToolResult: true,
      isError: row.isError,
      toolId: call.toolId,
      toolParameters: call.parameters,
    },
  }));
}

async function persistTerminalAwaitCompletion(
  context: AgentFrameworkContext,
  options: AgentFrameworkContext['agentToolLoop'],
  conversationId: string,
  call: PendingToolCall,
  row: ToolRunRow,
): Promise<void> {
  const sid = row.awaitSessionId;
  const wait = options?.waitForTerminalSession;
  if (!sid || !wait || row.isError) return;
  const done = await wait(sid);
  const lamportTool = await nextLamportClockForConversation(context.storage, conversationId);
  const body = truncateToolSummary(
    `[terminal.await done] session=${sid}\nexitCode: ${done.exitCode ?? 'null'}\n---\n${done.truncatedOutput}`,
  );
  await context.storage.appendMessage(createChatMessage({
    messageId: `${conversationId}:t:${call.toolId}:await:${Date.now().toString(36)}`,
    conversationId,
    originNodeId: 'local',
    lamportClock: lamportTool,
    role: 'tool',
    parts: [{
      type: 'tool-result',
      toolName: call.toolId,
      parameters: call.parameters,
      result: body,
      detailRef: row.detailRef
        ? { ...row.detailRef, exitCode: done.exitCode ?? row.detailRef.exitCode }
        : undefined,
    }],
    detailRef: row.detailRef
      ? { ...row.detailRef, exitCode: done.exitCode ?? row.detailRef.exitCode }
      : undefined,
    metadata: {
      isToolResult: true,
      toolId: call.toolId,
      toolParameters: call.parameters,
      awaitSessionId: sid,
    },
  }));
}

function toolStep(row: CompletedToolCall, parallel: boolean): AgentLoopStep {
  return {
    type: 'tool',
    data: {
      toolId: row.call.toolId,
      parameters: row.call.parameters,
      parallel,
      result: row.text,
      isError: row.isError,
    },
  };
}

export async function* runRegistryToolCalls(options: {
  context: AgentFrameworkContext;
  agentToolLoopOptions: AgentFrameworkContext['agentToolLoop'];
  conversationId: string;
  calls: PendingToolCall[];
  parallel: boolean;
  recentToolCalls: string[];
}): AsyncGenerator<AgentLoopStep, void, unknown> {
  const { context, agentToolLoopOptions, conversationId, calls, parallel, recentToolCalls } = options;

  if (parallel) {
    const results = await Promise.all(
      calls.map(
        async (call): Promise<CompletedToolCall> => ({
          call,
          ...(await executeWithGuards(
            context,
            agentToolLoopOptions,
            conversationId,
            recentToolCalls,
            call,
          )),
        }),
      ),
    );
    for (const row of results) {
      yield toolStep(row, true);
    }
    for (const row of results) {
      await persistToolResult(context, conversationId, row.call, row);
    }
    for (const row of results) {
      await persistTerminalAwaitCompletion(
        context,
        agentToolLoopOptions,
        conversationId,
        row.call,
        row,
      );
    }
    return;
  }

  for (const call of calls) {
    const row = await executeWithGuards(
      context,
      agentToolLoopOptions,
      conversationId,
      recentToolCalls,
      call,
    );
    yield toolStep({ call, ...row }, false);
    await persistToolResult(context, conversationId, call, row);
    await persistTerminalAwaitCompletion(context, agentToolLoopOptions, conversationId, call, row);
  }
}
