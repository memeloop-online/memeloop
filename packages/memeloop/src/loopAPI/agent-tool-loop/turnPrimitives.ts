import type { ChatMessage } from '../../conversation/index.js';

import { responseConcat } from '../../promptUtilities/responseConcat.js';
import { matchAllToolCallings, type ToolCallingMatch } from '../../promptUtilities/responsePatternUtility.js';
import { nextLamportClockForConversation } from '../../storage/nextLamport.js';
import { createHooksWithPlugins, resolvePromptPluginMap, runResponseCompleteHooks } from '../../tools/pluginRegistry.js';
import type { DefineToolAgentFrameworkContext } from '../../tools/types.js';
import type { AgentFrameworkContext, AgentInstanceModel } from '../../types.js';
import { executeHooks, hasHooks } from '../hooks/registry.js';
import type { AgentStopData } from '../hooks/types.js';
import type { AgentLoopInput, AgentLoopStep } from '../types.js';
import type { AgentToolLoopIterationGenerator, AgentToolLoopState, AgentToolLoopTurnStartResult } from './contracts.js';
import { prepareIterationHistory } from './historyCompaction.js';
import { chunkToText, streamLlm } from './llmStream.js';
import { buildLlmMessages, inferDefinitionId, resolveAgentDefinitionModel } from './modelMessages.js';
import { runRegistryToolCalls } from './toolCallRunner.js';
import { gateToolCallsWithPreToolUse } from './toolUseGate.js';

const DEFAULT_MAX_ITERATIONS = 256;

function toolCallHandledInAgentMessages(
  agentMessages: ChatMessage[],
  assistantContent: string,
  call: ToolCallingMatch & { found: true },
): boolean {
  let assistantIndex = -1;
  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    const message = agentMessages[index];
    if (message.role === 'assistant' && message.content === assistantContent) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return false;
  const after = agentMessages.slice(assistantIndex + 1);
  return after.some(
    message =>
      message.role === 'tool' &&
      (message.metadata?.toolId === call.toolId ||
        (typeof message.content === 'string' && message.content.includes(`Tool: ${call.toolId}`))),
  );
}

function resolveMaxIterations(context: AgentFrameworkContext): number {
  const configured = context.agentToolLoop?.maxIterations;
  return configured != null && configured > 0 ? configured : DEFAULT_MAX_ITERATIONS;
}

export function createAgentToolLoopState(context: AgentFrameworkContext): AgentToolLoopState {
  return {
    iteration: 0,
    maxIterations: resolveMaxIterations(context),
    recentToolCalls: [],
    agentStarted: false,
    agentStopped: false,
  };
}

function markAgentToolLoopStop(state: AgentToolLoopState, reason: AgentStopData['reason']): void {
  state.stopReason ??= reason;
}

function finishAgentToolLoopThinking(
  state: AgentToolLoopState,
  reason: AgentStopData['reason'],
  data: Record<string, unknown>,
): AgentLoopStep {
  markAgentToolLoopStop(state, reason);
  return { type: 'thinking', data };
}

export async function startAgentToolLoopTurn(
  context: AgentFrameworkContext,
  input: AgentLoopInput,
  state: AgentToolLoopState,
): Promise<AgentToolLoopTurnStartResult> {
  const now = Date.now();
  const lamportClock = await nextLamportClockForConversation(
    context.storage,
    input.conversationId,
  );
  const hostUserMessage = input.userMessage;
  const userMessage = context.normalizeMessage?.({
    ...hostUserMessage,
    messageId: hostUserMessage?.messageId ?? `${input.conversationId}:${now.toString(36)}`,
    conversationId: input.conversationId,
    originNodeId: hostUserMessage?.originNodeId ?? 'local',
    timestamp: hostUserMessage?.timestamp ?? now,
    lamportClock: hostUserMessage?.lamportClock ?? lamportClock,
    role: 'user',
    content: hostUserMessage?.content ?? input.message,
  }) ?? {
    ...hostUserMessage,
    messageId: hostUserMessage?.messageId ?? `${input.conversationId}:${now.toString(36)}`,
    conversationId: input.conversationId,
    originNodeId: hostUserMessage?.originNodeId ?? 'local',
    timestamp: hostUserMessage?.timestamp ?? now,
    lamportClock: hostUserMessage?.lamportClock ?? lamportClock,
    role: 'user',
    content: hostUserMessage?.content ?? input.message,
  };

  if (input.resumeSession && input.resumeSession.length > 0) {
    await context.storage.insertMessagesIfAbsent(input.resumeSession);
  }

  await context.storage.appendMessage(userMessage);

  if (hasHooks('UserPromptSubmit')) {
    const hookResult = await executeHooks('UserPromptSubmit', context, {
      message: input.message,
      conversationId: input.conversationId,
    });
    if (!hookResult.allowed) {
      return {
        action: 'stop',
        step: {
          type: 'thinking',
          data: {
            status: 'blocked',
            conversationId: input.conversationId,
            reason: hookResult.reason ?? 'Blocked by UserPromptSubmit hook',
          },
        },
      };
    }
  }

  const initialDefinitionId = await inferDefinitionId(context.storage, input.conversationId);
  if (hasHooks('AgentStart')) {
    const hookResult = await executeHooks('AgentStart', context, {
      conversationId: input.conversationId,
      definitionId: initialDefinitionId,
    });
    if (!hookResult.allowed) {
      return {
        action: 'stop',
        step: {
          type: 'thinking',
          data: {
            status: 'blocked',
            conversationId: input.conversationId,
            reason: hookResult.reason ?? 'Blocked by AgentStart hook',
          },
        },
      };
    }
  }
  state.agentStarted = true;
  return { action: 'continue' };
}

export async function* runAgentToolLoopIteration(
  context: AgentFrameworkContext,
  input: AgentLoopInput,
  state: AgentToolLoopState,
): AgentToolLoopIterationGenerator {
  const options = context.agentToolLoop ?? {};
  const enableToolLoop = options.enableToolLoop !== false;
  const fallbackRegistry = options.fallbackRegistryTools !== false;
  const checkpointOptions = options.sessionCheckpoint;

  if (state.iteration >= state.maxIterations) {
    yield finishAgentToolLoopThinking(state, 'max-iterations', {
      status: 'max-iterations',
      conversationId: input.conversationId,
      maxIterations: state.maxIterations,
    });
    return { action: 'stop', reason: 'max-iterations' };
  }

  state.iteration += 1;
  const iteration = state.iteration;

  if (options.isCancelled?.(input.conversationId)) {
    yield finishAgentToolLoopThinking(state, 'cancelled', {
      status: 'cancelled',
      conversationId: input.conversationId,
    });
    return { action: 'stop', reason: 'cancelled' };
  }

  const rawHistory = await context.storage.getMessages(input.conversationId, {
    mode: 'full-content',
  });

  const { history, steps: compactionSteps } = await prepareIterationHistory({
    context,
    conversationId: input.conversationId,
    iteration,
    rawHistory,
    agentToolLoopOptions: options,
  });
  for (const step of compactionSteps) {
    yield step;
  }

  const runtimeAgent = context.resolveAgentRuntimeView
    ? await context.resolveAgentRuntimeView(input.conversationId, history)
    : ({ id: input.conversationId, messages: history } as AgentInstanceModel);

  const hookContext: DefineToolAgentFrameworkContext = {
    ...context,
    agent: runtimeAgent,
    persistAgentMessage: async message => {
      await context.storage.appendMessage(message);
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
  const assistantMessageId = `${input.conversationId}:a:${Date.now().toString(36)}`;
  const assistantLamportClock = await nextLamportClockForConversation(
    context.storage,
    input.conversationId,
  );
  const buildAssistantMessage = (content: string) =>
    context.normalizeMessage?.({
      messageId: assistantMessageId,
      conversationId: input.conversationId,
      originNodeId: 'local',
      timestamp: Date.now(),
      lamportClock: assistantLamportClock,
      role: 'assistant',
      content,
    }) ?? {
      messageId: assistantMessageId,
      conversationId: input.conversationId,
      originNodeId: 'local',
      timestamp: Date.now(),
      lamportClock: assistantLamportClock,
      role: 'assistant' as const,
      content,
    };
  const upsertAssistantMessage = async (message: ChatMessage) => {
    const existingIndex = hookContext.agent.messages.findIndex(
      item => item.messageId === message.messageId,
    );
    if (existingIndex >= 0) {
      hookContext.agent.messages[existingIndex] = message;
    } else {
      hookContext.agent.messages.push(message);
    }
    await hookContext.persistAgentMessage?.(message);
  };
  let assistantText = '';
  for await (const chunk of streamLlm(context, request)) {
    assistantText += chunkToText(chunk);
    await upsertAssistantMessage(buildAssistantMessage(assistantText));
    yield { type: 'message', data: chunk };
  }

  const definitionId = await inferDefinitionId(context.storage, input.conversationId);
  const agentDefinition = await resolveAgentDefinitionModel(context, definitionId);
  const frameworkConfig = agentDefinition?.agentFrameworkConfig as
    | { prompts?: unknown[]; plugins?: unknown[]; response?: unknown[] }
    | undefined;
  const hasPlugins = Boolean(
    frameworkConfig?.plugins && Array.isArray(frameworkConfig.plugins) && frameworkConfig.plugins.length > 0,
  );

  const assistantMessage = buildAssistantMessage(assistantText);
  await upsertAssistantMessage(assistantMessage);

  const { calls, parallel } = matchAllToolCallings(assistantText);

  if (hasPlugins && frameworkConfig) {
    const { hooks } = await createHooksWithPlugins(
      frameworkConfig as { plugins: Array<{ toolId: string }> },
      {
        pluginRegistry: resolvePromptPluginMap(context),
      },
    );
    const responseCompletePayload: {
      agentFrameworkContext: DefineToolAgentFrameworkContext;
      response: { status: 'done'; content: string };
      agentFrameworkConfig: {
        plugins?: import('../../tools/types.js').FrameworkPluginToolConfig[];
      };
      requestId: undefined;
      toolConfig: import('../../tools/types.js').FrameworkPluginToolConfig;
      actions?: { yieldNextRoundTo?: 'human' | 'self' };
    } = {
      agentFrameworkContext: hookContext,
      response: { status: 'done', content: assistantText },
      agentFrameworkConfig: frameworkConfig as {
        plugins?: import('../../tools/types.js').FrameworkPluginToolConfig[];
      },
      requestId: undefined,
      toolConfig: { id: '_memeloop', toolId: '_memeloop' },
      actions: {},
    };
    await runResponseCompleteHooks(hooks, responseCompletePayload);

    await context.storage.insertMessagesIfAbsent(hookContext.agent.messages);

    const postProcess = await responseConcat(
      frameworkConfig as {
        response?: import('../../tools/types.js').AgentResponse[];
        plugins?: import('../../tools/types.js').FrameworkPluginToolConfig[];
      },
      assistantText,
      hookContext,
      hookContext.agent.messages,
    );

    const yieldTarget = responseCompletePayload.actions?.yieldNextRoundTo ?? postProcess.yieldNextRoundTo;

    if (yieldTarget === 'human') {
      yield finishAgentToolLoopThinking(state, 'completed', {
        status: 'input-required',
        conversationId: input.conversationId,
      });
      return { action: 'stop', reason: 'completed' };
    }
    if (yieldTarget === 'self') {
      return { action: 'continue' };
    }
  }

  if (calls.length === 0) {
    markAgentToolLoopStop(state, 'completed');
    return { action: 'stop', reason: 'completed' };
  }

  if (!enableToolLoop) {
    markAgentToolLoopStop(state, 'completed');
    return { action: 'stop', reason: 'completed' };
  }

  const pending = calls.filter(
    call => !toolCallHandledInAgentMessages(hookContext.agent.messages, assistantText, call),
  );

  if (pending.length === 0) {
    if (hasPlugins && calls.length > 0) {
      return { action: 'continue' };
    }
    markAgentToolLoopStop(state, 'completed');
    return { action: 'stop', reason: 'completed' };
  }

  if (!fallbackRegistry && hasPlugins) {
    return { action: 'continue' };
  }

  const allowedCalls = yield* gateToolCallsWithPreToolUse(
    context,
    options,
    definitionId,
    input.conversationId,
    pending,
  );

  if (allowedCalls.length === 0) {
    return { action: 'continue' };
  }

  yield* runRegistryToolCalls({
    context,
    agentToolLoopOptions: options,
    conversationId: input.conversationId,
    calls: allowedCalls,
    parallel,
    recentToolCalls: state.recentToolCalls,
  });

  if (checkpointOptions?.enabled) {
    const checkpointStore = checkpointOptions.store;
    if (!checkpointStore) {
      if (context.logger?.warn) {
        context.logger.warn('[agentToolLoop] checkpoint enabled without a checkpoint store');
      } else {
        console.warn('[agentToolLoop] checkpoint enabled without a checkpoint store');
      }
      return { action: 'continue' };
    }
    try {
      const allMessages = await context.storage.getMessages(input.conversationId, {
        mode: 'full-content',
      });
      await checkpointStore.saveCheckpoint(input.conversationId, allMessages);
    } catch (error) {
      if (context.logger?.warn) {
        context.logger.warn('[agentToolLoop] checkpoint save failed:', error);
      } else {
        console.warn('[agentToolLoop] checkpoint save failed:', error);
      }
    }
  }

  return { action: 'continue' };
}

export async function stopAgentToolLoopTurn(
  context: AgentFrameworkContext,
  input: AgentLoopInput,
  state: AgentToolLoopState,
  reason?: AgentStopData['reason'],
): Promise<void> {
  if (reason) markAgentToolLoopStop(state, reason);
  if (state.agentStarted && !state.agentStopped && state.stopReason && hasHooks('AgentStop')) {
    state.agentStopped = true;
    await executeHooks('AgentStop', context, {
      conversationId: input.conversationId,
      reason: state.stopReason,
    });
  }
}
