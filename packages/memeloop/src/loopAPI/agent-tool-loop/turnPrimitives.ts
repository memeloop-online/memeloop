import { type ChatMessage, createChatMessage } from '../../conversation/index.js';

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

function pluginToolCallSignature(calls: Array<ToolCallingMatch & { found: true }>): string {
  return calls.map(call => `${call.toolId}:${JSON.stringify(call.parameters)}`).join('|');
}

async function blockRepeatedPluginToolCalls(
  context: AgentFrameworkContext,
  input: AgentLoopInput,
  state: AgentToolLoopState,
  calls: Array<ToolCallingMatch & { found: true }>,
  hookContext: DefineToolAgentFrameworkContext,
): Promise<{ blocked: false } | { blocked: true; message: string }> {
  if (calls.length === 0) return { blocked: false };

  const signature = pluginToolCallSignature(calls);
  state.recentToolCalls.push(signature);
  const threshold = Math.max(2, context.agentToolLoop?.doomLoopThreshold ?? 3);
  const last = state.recentToolCalls.slice(-threshold);
  if (last.length !== threshold || !last.every(entry => entry === signature)) {
    return { blocked: false };
  }

  const message = `Blocked by doom-loop guard: the model repeated the same tool call ${threshold} times. ` +
    'Change the arguments or approach before trying again.';
  const firstCall = calls[0];
  const lamportClock = await nextLamportClockForConversation(
    context.storage,
    input.conversationId,
  );
  const toolMessage = createChatMessage({
    messageId: `${input.conversationId}:t:doom-loop:${state.iteration}:${Date.now().toString(36)}`,
    conversationId: input.conversationId,
    originNodeId: 'local',
    lamportClock,
    role: 'tool',
    parts: [{
      type: 'tool-result',
      toolName: firstCall.toolId,
      parameters: firstCall.parameters,
      result: message,
      isError: true,
    }],
    metadata: {
      isToolResult: true,
      isError: true,
      toolId: firstCall.toolId,
      toolParameters: firstCall.parameters,
      doomLoopBlocked: true,
    },
  });
  hookContext.agent.messages.push(toolMessage);
  await context.storage.appendMessage(toolMessage);
  return { blocked: true, message };
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

  // Prompt plugins may inspect the live agent (for example Desktop's
  // persistent goal/todo tool). Give prompt concatenation the same enriched
  // context used by response hooks instead of the host-only base context.
  const messages = await buildLlmMessages(hookContext, input.conversationId, history);
  const request = { conversationId: input.conversationId, messages };
  // Include the iteration so rounds started within the same millisecond keep
  // distinct message identity; otherwise a later round replaces an earlier
  // round's assistant message and duplicate-output detection misfires.
  const assistantMessageId = `${input.conversationId}:a:${iteration}:${Date.now().toString(36)}`;
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
  const updateAssistantView = (message: ChatMessage) => {
    const existingIndex = hookContext.agent.messages.findIndex(
      item => item.messageId === message.messageId,
    );
    if (existingIndex >= 0) {
      hookContext.agent.messages[existingIndex] = message;
    } else {
      hookContext.agent.messages.push(message);
    }
  };
  let assistantText = '';
  for await (const chunk of streamLlm(context, request)) {
    assistantText += chunkToText(chunk);
    // Conversation stores are append-only. Keep streaming partials in the
    // in-memory agent view/UI only; persist the immutable final message once.
    const transientAssistantMessage = buildAssistantMessage(assistantText);
    updateAssistantView(transientAssistantMessage);
    try {
      await context.onTransientMessage?.(transientAssistantMessage);
    } catch (error) {
      // A renderer/update subscriber must not turn a successful model stream
      // into a failed turn or prevent the immutable final message from being
      // persisted.
      context.logger?.warn?.('[agentToolLoop] transient message subscriber failed:', error);
    }
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
  updateAssistantView(assistantMessage);
  await hookContext.persistAgentMessage?.(assistantMessage);

  const { calls, parallel } = matchAllToolCallings(assistantText);

  if (hasPlugins && frameworkConfig) {
    const doomLoop = await blockRepeatedPluginToolCalls(
      context,
      input,
      state,
      calls,
      hookContext,
    );
    if (doomLoop.blocked) {
      yield {
        type: 'tool',
        data: {
          toolId: calls[0].toolId,
          parameters: calls[0].parameters,
          parallel,
          result: doomLoop.message,
          isError: true,
        },
      };
      yield finishAgentToolLoopThinking(state, 'error', {
        status: 'blocked',
        conversationId: input.conversationId,
        reason: doomLoop.message,
      });
      return { action: 'stop', reason: 'error' };
    }

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
