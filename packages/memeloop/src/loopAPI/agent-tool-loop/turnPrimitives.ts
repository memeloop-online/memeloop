import { resolveAgentModelConfig } from '../../agent/types.js';
import { type ChatMessage, messageToConversationEvent } from '../../conversation/index.js';
import { resolveAgentModelRoute } from '../../llm/prepareModelRequest.js';

import { responseConcat } from '../../promptUtilities/responseConcat.js';
import { matchAllToolCallings, type ToolCallingMatch } from '../../promptUtilities/responsePatternUtility.js';
import { safeErrorMessageFromUnknown } from '../../safeError.js';
import { createHooksWithPlugins, resolvePromptPluginMap, runResponseCompleteHooks } from '../../tools/pluginRegistry.js';
import type { DefineToolAgentFrameworkContext } from '../../tools/types.js';
import type { AgentFrameworkContext, AgentInstanceModel } from '../../types.js';
import { assertPendingAgentUserMessageWithinLimits, normalizeAgentUserMessageForAdmission } from '../../userMessageAdmission.js';
import { executeHooks, hasHooks } from '../hooks/registry.js';
import type { AgentStopData } from '../hooks/types.js';
import type { AgentLoopInput, AgentLoopStep } from '../types.js';
import type { AgentToolLoopIterationGenerator, AgentToolLoopState, AgentToolLoopTurnStartResult } from './contracts.js';
import { loadAgentExecutionModelContext, prepareLoadedAgentExecutionModelRequest } from './executionModelContext.js';
import { streamLlm } from './llmStream.js';
import { appendLocalMessageEvent, requireLocalNodeId } from './localMessageEvent.js';
import { inferDefinitionId, resolveAgentDefinitionModel } from './modelMessages.js';
import { NativeModelStreamAccumulator, type NativeModelTransientStreamSnapshot } from './nativeStreamAccumulator.js';
import { runRegistryToolCalls } from './toolCallRunner.js';
import { createToolProgressGuardState, evaluateToolProgressGuard, fingerprintToolCalls, observeToolProgress } from './toolProgressGuard.js';
import { gateToolCallsWithPreToolUse, normalizePendingToolCalls } from './toolUseGate.js';

const DEFAULT_MAX_ITERATIONS = 256;

export const TRANSIENT_MESSAGE_STREAM_LIMITS = Object.freeze(
  {
    minimumIntervalMs: 50,
    emissions: 256,
  } as const,
);

type TransientMessageFactory = () => ChatMessage;

/**
 * One-slot, backpressure-aware publisher. A slow renderer can hold at most one
 * in-flight callback and one coalesced latest snapshot; it can never create a
 * promise or message queue proportional to provider delta count.
 */
class TransientMessagePublisher {
  private active = true;
  private emitted = 0;
  private inFlight = false;
  private lastEmissionAt = Number.NEGATIVE_INFINITY;
  private latest?: TransientMessageFactory;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly signal?: AbortSignal;
  private readonly abortListener = () => {
    this.stop();
  };

  public constructor(
    private readonly project: (message: ChatMessage) => void,
    private readonly publish: AgentFrameworkContext['onTransientMessage'],
    private readonly warn: (error: unknown) => void,
    signal?: AbortSignal,
  ) {
    this.signal = signal;
    signal?.addEventListener('abort', this.abortListener, { once: true });
  }

  public offer(factory: TransientMessageFactory): void {
    if (!this.active || this.emitted >= TRANSIENT_MESSAGE_STREAM_LIMITS.emissions) return;
    this.latest = factory;
    this.schedule();
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;
    this.latest = undefined;
    this.signal?.removeEventListener('abort', this.abortListener);
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (!this.active || this.inFlight || this.latest === undefined || this.timer !== undefined) {
      return;
    }
    const delay = Math.max(
      0,
      this.lastEmissionAt + TRANSIENT_MESSAGE_STREAM_LIMITS.minimumIntervalMs - Date.now(),
    );
    if (delay === 0) {
      this.emitLatest();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emitLatest();
    }, delay);
  }

  private emitLatest(): void {
    if (!this.active || this.inFlight || this.latest === undefined) return;
    if (this.emitted >= TRANSIENT_MESSAGE_STREAM_LIMITS.emissions) {
      this.stop();
      return;
    }
    const factory = this.latest;
    this.latest = undefined;
    this.emitted += 1;
    this.lastEmissionAt = Date.now();
    let message: ChatMessage;
    try {
      message = factory();
      this.project(message);
    } catch (error) {
      this.report(error);
      this.schedule();
      return;
    }
    if (!this.publish) {
      this.schedule();
      return;
    }
    this.inFlight = true;
    let result: void | Promise<void>;
    try {
      result = this.publish(message);
    } catch (error) {
      this.report(error);
      this.inFlight = false;
      this.schedule();
      return;
    }
    void Promise.resolve(result)
      .catch((error: unknown) => {
        this.report(error);
      })
      .finally(() => {
        this.inFlight = false;
        this.schedule();
      });
  }

  private report(error: unknown): void {
    try {
      this.warn(error);
    } catch {
      // Logging is observability only and must not alter model/durable output.
    }
  }
}

function createTransientAssistantMessage(input: {
  snapshot: NativeModelTransientStreamSnapshot;
  messageId: string;
  turnId: string;
  conversationId: string;
  originNodeId: string;
  timestamp: number;
}): ChatMessage {
  const { snapshot } = input;
  const toolCalls = snapshot.nativeCalls.map((call) => ({
    id: call.toolCallId,
    toolName: call.toolName,
    arguments: call.input,
  }));
  return {
    messageId: input.messageId,
    turnId: input.turnId,
    conversationId: input.conversationId,
    originNodeId: input.originNodeId,
    // Transients are not events and therefore have no allocated causal
    // position. The maximum safe sentinel keeps the ChatMessage projection
    // canonical and sorts it after durable history until the same ID is
    // replaced by appendLocalMessageEvent's real position.
    originSequence: Number.MAX_SAFE_INTEGER,
    lamportClock: Number.MAX_SAFE_INTEGER,
    timestamp: input.timestamp,
    role: 'assistant',
    content: snapshot.assistantText,
    parts: [
      ...(snapshot.assistantReasoning.length === 0
        ? []
        : [{ type: 'reasoning' as const, text: snapshot.assistantReasoning }]),
      ...(snapshot.assistantText.length === 0
        ? []
        : [{ type: 'text' as const, text: snapshot.assistantText }]),
      ...snapshot.nativeCalls.map((call) => ({
        type: 'tool-call' as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        arguments: call.input,
      })),
    ],
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    ...(snapshot.assistantReasoning.length === 0
      ? {}
      : { reasoning_content: snapshot.assistantReasoning }),
    metadata: {
      transientStream: {
        state: 'partial',
        textTruncated: snapshot.textTruncated,
        reasoningTruncated: snapshot.reasoningTruncated,
        toolCallsTruncated: snapshot.toolCallsTruncated,
        activeToolInputs: snapshot.activeToolInputs,
      },
    },
  };
}
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
    (message) =>
      message.role === 'tool' &&
      (message.metadata?.toolId === call.toolId ||
        (typeof message.content === 'string' && message.content.includes(`Tool: ${call.toolId}`))),
  );
}

function resolveMaxIterations(context: AgentFrameworkContext): number {
  const configured = context.agentToolLoop?.maxIterations;
  return configured != null && configured > 0 ? configured : DEFAULT_MAX_ITERATIONS;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export async function fingerprintPluginToolCalls(
  calls: Array<ToolCallingMatch & { found: true }>,
): Promise<string> {
  return fingerprintToolCalls(calls);
}

async function blockRepeatedPluginToolCalls(
  context: AgentFrameworkContext,
  input: AgentLoopInput,
  state: AgentToolLoopState,
  calls: Array<ToolCallingMatch & { found: true }>,
  hookContext: DefineToolAgentFrameworkContext,
): Promise<{ blocked: false } | { blocked: true; message: string }> {
  if (calls.length === 0) return { blocked: false };

  const previousProgress = previousToolProgressObservation(hookContext.agent.messages);
  if (previousProgress !== undefined) {
    await observeToolProgress(state.toolProgressGuard, previousProgress, {
      sha256Hex: context.sha256Hex,
      signal: input.signal,
    });
  }
  const decision = await evaluateToolProgressGuard(state.toolProgressGuard, calls, {
    exactRepeatThreshold: context.agentToolLoop?.doomLoopThreshold,
    sameToolWithoutProgressThreshold: context.agentToolLoop?.doomLoopSameToolThreshold,
    sha256Hex: context.sha256Hex,
    signal: input.signal,
  });
  if (!decision.blocked) {
    return decision;
  }

  const message = `${decision.message} Change the arguments or approach before trying again.`;
  const firstCall = calls[0];
  if (!firstCall.toolCallId) throw new Error('Doom-loop tool result requires a toolCallId');
  const turnId = input.userMessage?.turnId ?? input.userMessage?.messageId;
  if (!turnId) throw new Error('Tool result requires a user-rooted turnId');
  const toolMessage = await appendLocalMessageEvent(context, {
    conversationId: input.conversationId,
    message: {
      messageId: `${input.conversationId}:t:doom-loop:${input.runId ?? turnId}:${state.iteration}`,
      turnId,
      role: 'tool',
      content: message,
      parts: [
        {
          type: 'tool-result',
          toolCallId: firstCall.toolCallId,
          toolName: firstCall.toolId,
          parameters: firstCall.parameters,
          result: message,
          isError: true,
        },
      ],
      metadata: {
        isToolResult: true,
        isError: true,
        toolId: firstCall.toolId,
        toolParameters: firstCall.parameters,
        doomLoopBlocked: true,
      },
    },
  });
  hookContext.agent.messages.push(toolMessage);
  return { blocked: true, message };
}

export function createAgentToolLoopState(context: AgentFrameworkContext): AgentToolLoopState {
  return {
    iteration: 0,
    maxIterations: resolveMaxIterations(context),
    recentToolCalls: [],
    toolProgressGuard: createToolProgressGuardState(),
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
  input.signal?.throwIfAborted();
  const initialDefinitionId = await inferDefinitionId(context.storage, input.conversationId);
  input.signal?.throwIfAborted();
  const definition = await resolveAgentDefinitionModel(context, initialDefinitionId, {
    conversationId: input.conversationId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!definition) throw new Error(`agent definition '${initialDefinitionId}' was not found`);
  const providerRegistry = context.modelProviderRegistry;
  if (!providerRegistry) throw new Error('model provider registry is not configured');
  const modelConfig = resolveAgentModelConfig({
    definition,
    hostDefault: context.defaultModelConfig,
  });
  state.definitionId = initialDefinitionId;
  state.definition = definition;
  state.modelRoute = input.modelRoute ?? resolveAgentModelRoute(providerRegistry, modelConfig);

  const now = Date.now();
  const persistedUserMessage = input.persistedUserMessage;
  const hostUserMessage = input.userMessage;
  const localNodeId = requireLocalNodeId(context);
  const originNodeId = hostUserMessage?.originNodeId?.trim() || localNodeId;
  const messageId = hostUserMessage?.messageId ?? `${input.conversationId}:${now.toString(36)}`;
  if (hostUserMessage?.turnId && hostUserMessage.turnId !== messageId) {
    throw new Error('User message turnId must equal its messageId');
  }
  const messagePayload = {
    messageId,
    turnId: messageId,
    role: 'user' as const,
    content: hostUserMessage?.content ?? input.message,
    ...(hostUserMessage?.parts === undefined ? {} : { parts: hostUserMessage.parts }),
    ...(hostUserMessage?.toolCalls === undefined ? {} : { toolCalls: hostUserMessage.toolCalls }),
    ...(hostUserMessage?.attachments === undefined
      ? {}
      : { attachments: hostUserMessage.attachments }),
    ...(hostUserMessage?.detailRef === undefined ? {} : { detailRef: hostUserMessage.detailRef }),
    ...(hostUserMessage?.reasoning_content === undefined
      ? {}
      : { reasoning_content: hostUserMessage.reasoning_content }),
    ...(hostUserMessage?.contentType === undefined
      ? {}
      : { contentType: hostUserMessage.contentType }),
    ...(hostUserMessage?.hidden === undefined ? {} : { hidden: hostUserMessage.hidden }),
    ...(hostUserMessage?.duration === undefined ? {} : { duration: hostUserMessage.duration }),
    ...(hostUserMessage?.metadata === undefined ? {} : { metadata: hostUserMessage.metadata }),
  };
  let userMessage: ChatMessage;
  if (persistedUserMessage) {
    if (
      persistedUserMessage.conversationId !== input.conversationId ||
      persistedUserMessage.role !== 'user' ||
      persistedUserMessage.messageId !== persistedUserMessage.turnId ||
      !isPositiveSafeInteger(persistedUserMessage.originSequence) ||
      !isPositiveSafeInteger(persistedUserMessage.lamportClock)
    ) {
      throw new Error('Invalid canonical persisted user message');
    }
    userMessage = normalizeAgentUserMessageForAdmission(persistedUserMessage);
  } else {
    if (originNodeId !== localNodeId) {
      throw new Error('PendingLocalChatMessage.originNodeId must match the local event allocator');
    }
    input.signal?.throwIfAborted();
    assertPendingAgentUserMessageWithinLimits({
      conversationId: input.conversationId,
      originNodeId,
      timestamp: hostUserMessage?.timestamp ?? now,
      message: messagePayload,
    });
    userMessage = await appendLocalMessageEvent(context, {
      conversationId: input.conversationId,
      timestamp: hostUserMessage?.timestamp ?? now,
      message: messagePayload,
    });
    input.signal?.throwIfAborted();
  }
  input.userMessage = userMessage;

  if (hasHooks('UserPromptSubmit', context)) {
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

  if (hasHooks('AgentStart', context)) {
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
  input.signal?.throwIfAborted();
  const definition = state.definition;
  const modelRoute = state.modelRoute;
  if (!definition || !modelRoute) {
    throw new Error('agent model route was not prepared at turn start');
  }

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

  if (
    (input.runId ? context.runCancellation?.has(input.runId) === true : false) ||
    options.isCancelled?.(input.conversationId)
  ) {
    yield finishAgentToolLoopThinking(state, 'cancelled', {
      status: 'cancelled',
      conversationId: input.conversationId,
    });
    return { action: 'stop', reason: 'cancelled' };
  }

  const historySignal = input.signal ?? new AbortController().signal;
  const executionModelContext = await loadAgentExecutionModelContext(context, {
    conversationId: input.conversationId,
    signal: historySignal,
    definitionId: state.definitionId ?? definition.id,
    definition,
    route: modelRoute,
    recentTurnsToKeep: options.autoCompact?.recentTurnsToKeep ?? 32,
    maxContextBytes: modelContextByteBudget(options.autoCompact),
    onCompactionContinuationNeeded: options.autoCompact?.scheduleContinuation,
  });
  const rawHistory = executionModelContext.messages;
  const history = rawHistory;

  const runtimeAgent = context.resolveAgentRuntimeView
    ? await context.resolveAgentRuntimeView(input.conversationId, history)
    : ({ id: input.conversationId, messages: history } as AgentInstanceModel);

  const hookContext: DefineToolAgentFrameworkContext = {
    ...context,
    operationSignal: input.signal,
    agent: runtimeAgent,
    persistAgentMessage: async (message) => {
      const localNodeId = requireLocalNodeId(context);
      const originNodeId = message.originNodeId?.trim() || localNodeId;
      if (originNodeId !== localNodeId && !isPositiveSafeInteger(message.originSequence)) {
        throw new Error(
          `Remote plugin message from ${originNodeId} must provide a positive originSequence`,
        );
      }
      if (originNodeId === localNodeId) {
        const persisted = await appendLocalMessageEvent(context, {
          conversationId: message.conversationId,
          timestamp: message.timestamp,
          message: {
            messageId: message.messageId,
            turnId: message.turnId,
            role: message.role,
            content: message.content,
            ...(message.parts === undefined ? {} : { parts: message.parts }),
            ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
            ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
            ...(message.detailRef === undefined ? {} : { detailRef: message.detailRef }),
            ...(message.reasoning_content === undefined
              ? {}
              : { reasoning_content: message.reasoning_content }),
            ...(message.contentType === undefined ? {} : { contentType: message.contentType }),
            ...(message.hidden === undefined ? {} : { hidden: message.hidden }),
            ...(message.duration === undefined ? {} : { duration: message.duration }),
            ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
          },
        });
        Object.assign(message, persisted);
      } else {
        if (
          !isPositiveSafeInteger(message.originSequence) ||
          !isPositiveSafeInteger(message.lamportClock)
        ) {
          throw new Error(`Remote plugin message from ${originNodeId} has invalid causal identity`);
        }
        await context.storage.insertEventsIfAbsent([messageToConversationEvent(message)]);
      }
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
  const { prepared } = await prepareLoadedAgentExecutionModelRequest(
    hookContext,
    { ...executionModelContext, messages: history },
    {
      conversationId: input.conversationId,
      stream: true,
      signal: historySignal,
    },
  );
  // Include the iteration so rounds started within the same millisecond keep
  // distinct message identity; otherwise a later round replaces an earlier
  // round's assistant message and duplicate-output detection misfires.
  const assistantMessageId = `${input.conversationId}:a:${input.runId ?? input.persistedUserMessage?.turnId ?? 'standalone'}:${iteration}`;
  const assistantTurnId = input.userMessage?.turnId ?? input.userMessage?.messageId;
  if (!assistantTurnId) throw new Error('Assistant message requires a user-rooted turnId');
  const assistantTimestamp = Date.now();
  const assistantOriginNodeId = requireLocalNodeId(context);
  const updateAssistantView = (message: ChatMessage) => {
    const existingIndex = hookContext.agent.messages.findIndex(
      (item) => item.messageId === message.messageId,
    );
    if (existingIndex >= 0) {
      hookContext.agent.messages[existingIndex] = message;
    } else {
      hookContext.agent.messages.push(message);
    }
  };
  const removeTransientAssistantView = () => {
    const existingIndex = hookContext.agent.messages.findIndex(
      (item) => item.messageId === assistantMessageId,
    );
    if (
      existingIndex >= 0 &&
      hookContext.agent.messages[existingIndex]?.metadata?.transientStream !== undefined
    ) {
      hookContext.agent.messages.splice(existingIndex, 1);
    }
  };
  const transientPublisher = new TransientMessagePublisher(
    updateAssistantView,
    context.onTransientMessage,
    (error) => context.logger?.warn?.('[agentToolLoop] transient message subscriber failed:', error),
    input.signal,
  );
  const streamAccumulator = new NativeModelStreamAccumulator();
  let assembledStream: ReturnType<NativeModelStreamAccumulator['finalize']>;
  let assistantMessage: ChatMessage;
  let durableAssistantPersisted = false;
  try {
    for await (const chunk of streamLlm(prepared.route.provider, prepared.request)) {
      input.signal?.throwIfAborted();
      if (
        (input.runId ? context.runCancellation?.has(input.runId) === true : false) ||
        options.isCancelled?.(input.conversationId)
      ) {
        throw new DOMException('Agent turn cancelled', 'AbortError');
      }
      const previousTransientVersion = streamAccumulator.transientVersion;
      streamAccumulator.apply(chunk);
      if (streamAccumulator.transientVersion !== previousTransientVersion) {
        // Defer snapshot construction until the publisher's time/budget gate.
        // This avoids joining accumulated text once per provider token.
        transientPublisher.offer(() =>
          createTransientAssistantMessage({
            snapshot: streamAccumulator.transientSnapshot(),
            messageId: assistantMessageId,
            turnId: assistantTurnId,
            conversationId: input.conversationId,
            originNodeId: assistantOriginNodeId,
            timestamp: assistantTimestamp,
          })
        );
      }
      // Conversation stores are append-only. Keep streaming partials in the
      // in-memory agent view/UI only; persist the immutable final message once.
      yield { type: 'message', data: chunk };
    }
    // A durable storage projection replaces the last partial. Do not also send
    // the completed message through the transient channel.
    transientPublisher.stop();
    assembledStream = streamAccumulator.finalize();
  } catch (error) {
    transientPublisher.stop();
    removeTransientAssistantView();
    throw error;
  }
  const assistantText = assembledStream.assistantText;
  const assistantReasoning = assembledStream.assistantReasoning;
  const nativeCalls: Array<ToolCallingMatch & { found: true }> = assembledStream.nativeCalls.map(
    (call) => ({
      found: true,
      toolCallId: call.toolCallId,
      toolId: call.toolName,
      parameters: call.input,
      originalText: '',
    }),
  );

  input.signal?.throwIfAborted();
  const frameworkConfig = definition.agentFrameworkConfig as
    | { prompts?: unknown[]; plugins?: unknown[]; response?: unknown[] }
    | undefined;
  const hasPlugins = Boolean(
    frameworkConfig?.plugins &&
      Array.isArray(frameworkConfig.plugins) &&
      frameworkConfig.plugins.length > 0,
  );

  const legacy = options.legacyTextToolCalls ? matchAllToolCallings(assistantText) : undefined;
  const legacyCalls = (legacy?.calls ?? []).map((call, callIndex) => ({
    ...call,
    toolCallId: `${assistantMessageId}:legacy:${callIndex}`,
  }));
  const calls = normalizePendingToolCalls(nativeCalls.length > 0 ? nativeCalls : legacyCalls);
  const normalizedNativeCalls = nativeCalls.length > 0 ? calls : [];
  const parallel = nativeCalls.length > 0 ? nativeCalls.length > 1 : (legacy?.parallel ?? false);
  input.signal?.throwIfAborted();
  try {
    assistantMessage = await appendLocalMessageEvent(context, {
      conversationId: input.conversationId,
      timestamp: assistantTimestamp,
      message: {
        messageId: assistantMessageId,
        turnId: assistantTurnId,
        role: 'assistant',
        content: assistantText,
        parts: [
          ...(assistantReasoning.length === 0
            ? []
            : [{ type: 'reasoning' as const, text: assistantReasoning }]),
          ...(assistantText.length === 0 ? [] : [{ type: 'text' as const, text: assistantText }]),
          ...normalizedNativeCalls.map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.toolCallId!,
            toolName: call.toolId,
            arguments: call.parameters,
          })),
        ],
        toolCalls: normalizedNativeCalls.map((call) => ({
          id: call.toolCallId!,
          toolName: call.toolId,
          arguments: call.parameters,
        })),
        ...(assistantReasoning.length === 0 ? {} : { reasoning_content: assistantReasoning }),
        ...(calls.length === 0 && assembledStream.usage === undefined
          ? {}
          : {
            metadata: {
              ...(calls.length === 0 ? {} : { containsToolCall: true }),
              ...(assembledStream.usage === undefined
                ? {}
                : { modelUsage: assembledStream.usage }),
            },
          }),
      },
    });
    durableAssistantPersisted = true;
  } catch (error) {
    removeTransientAssistantView();
    throw error;
  } finally {
    transientPublisher.stop();
    if (!durableAssistantPersisted) removeTransientAssistantView();
  }
  input.signal?.throwIfAborted();
  updateAssistantView(assistantMessage);

  if (hasPlugins && frameworkConfig) {
    const doomLoop = await blockRepeatedPluginToolCalls(context, input, state, calls, hookContext);
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
      requestId: string | undefined;
      toolConfig: import('../../tools/types.js').FrameworkPluginToolConfig;
      actions?: { yieldNextRoundTo?: 'human' | 'self' };
    } = {
      agentFrameworkContext: hookContext,
      response: { status: 'done', content: assistantText },
      agentFrameworkConfig: frameworkConfig as {
        plugins?: import('../../tools/types.js').FrameworkPluginToolConfig[];
      },
      requestId: input.runId,
      toolConfig: { id: '_memeloop', toolId: '_memeloop' },
      actions: {},
    };
    await runResponseCompleteHooks(hooks, responseCompletePayload);

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
    (call) => !toolCallHandledInAgentMessages(hookContext.agent.messages, assistantText, call),
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

  if (!state.definitionId) throw new Error('Agent loop definitionId was not initialized');
  const allowedCalls = yield* gateToolCallsWithPreToolUse(
    context,
    options,
    state.definitionId,
    input.conversationId,
    assistantTurnId,
    input.runId ?? assistantTurnId,
    `${input.runId ?? assistantTurnId}:${iteration}`,
    pending,
    input.signal,
  );

  if (allowedCalls.length === 0) {
    return { action: 'continue' };
  }

  yield* runRegistryToolCalls({
    context,
    agentToolLoopOptions: options,
    conversationId: input.conversationId,
    turnId: assistantTurnId,
    messageIdentity: `${input.runId ?? assistantTurnId}:${iteration}`,
    calls: allowedCalls,
    parallel,
    recentToolCalls: state.recentToolCalls,
    progressGuardState: state.toolProgressGuard,
    guardAlreadyChecked: hasPlugins,
    signal: input.signal,
    runId: input.runId,
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
      const checkpointHistory = (
        await loadAgentExecutionModelContext(context, {
          conversationId: input.conversationId,
          signal: historySignal,
          definitionId: state.definitionId ?? definition.id,
          definition,
          route: modelRoute,
          recentTurnsToKeep: options.autoCompact?.recentTurnsToKeep ?? 32,
          maxContextBytes: modelContextByteBudget(options.autoCompact),
          onCompactionContinuationNeeded: options.autoCompact?.scheduleContinuation,
        })
      ).messages;
      await checkpointStore.saveCheckpoint(input.conversationId, checkpointHistory);
    } catch (error) {
      const message = safeErrorMessageFromUnknown(error, { fallback: 'Checkpoint save failed' });
      if (context.logger?.warn) {
        context.logger.warn('[agentToolLoop] checkpoint save failed:', message);
      } else {
        console.warn('[agentToolLoop] checkpoint save failed:', message);
      }
    }
  }

  return { action: 'continue' };
}

function previousToolProgressObservation(
  messages: readonly ChatMessage[],
): Array<{ content: string; isError: boolean; toolResults: unknown[] }> | undefined {
  let currentAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      currentAssistantIndex = index;
      break;
    }
  }
  if (currentAssistantIndex <= 0) return undefined;
  const results: Array<{ content: string; isError: boolean; toolResults: unknown[] }> = [];
  for (let index = currentAssistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'tool') break;
    results.push({
      content: message.content,
      isError: message.metadata?.isError === true,
      toolResults: (message.parts ?? [])
        .filter((part) => part.type === 'tool-result')
        .map((part) => ({
          isError: part.isError === true,
          result: part.result,
          toolName: part.toolName,
        })),
    });
  }
  return results.length === 0 ? undefined : results.reverse();
}

function modelContextByteBudget(
  autoCompact: NonNullable<AgentFrameworkContext['agentToolLoop']>['autoCompact'] | undefined,
): number {
  if (autoCompact) {
    const maximumTokens = autoCompact.maxTokens ?? 128_000;
    if (Number.isSafeInteger(maximumTokens) && maximumTokens > 0) {
      return Math.max(1024, Math.min(4 * 1024 * 1024, Math.ceil(maximumTokens * 3.5)));
    }
  }
  return 4 * 1024 * 1024;
}

export async function stopAgentToolLoopTurn(
  context: AgentFrameworkContext,
  input: AgentLoopInput,
  state: AgentToolLoopState,
  reason?: AgentStopData['reason'],
): Promise<void> {
  if (reason) markAgentToolLoopStop(state, reason);
  if (
    state.agentStarted &&
    !state.agentStopped &&
    state.stopReason &&
    hasHooks('AgentStop', context)
  ) {
    state.agentStopped = true;
    await executeHooks('AgentStop', context, {
      conversationId: input.conversationId,
      reason: state.stopReason,
    });
  }
}
