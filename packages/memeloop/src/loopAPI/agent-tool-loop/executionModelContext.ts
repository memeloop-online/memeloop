import { type AgentDefinition, resolveAgentModelConfig } from '../../agent/types.js';
import type { ChatMessage, ContextCompactionProgress } from '../../conversation/index.js';
import { type PreparedModelRequest, resolveAgentModelRoute, type ResolvedAgentModelRoute } from '../../llm/prepareModelRequest.js';
import type { AgentFrameworkContext } from '../../types.js';
import type { ContextCompactionWorkBudget } from './boundedModelContext.js';
import { loadEffectiveIterationHistory } from './historyCompaction.js';
import { summarizeModelContext } from './modelContextSummarizer.js';
import { inferDefinitionId, prepareAgentModelRequest, resolveAgentDefinitionModel } from './modelMessages.js';

export interface LoadAgentExecutionModelContextOptions {
  conversationId: string;
  signal: AbortSignal;
  /** Optional already-fenced values held by an active run generation. */
  definitionId?: string;
  definition?: AgentDefinition;
  route?: ResolvedAgentModelRoute;
  recentTurnsToKeep?: number;
  maxContextBytes?: number;
  /** Select one hard-bounded foreground or background compaction slice. */
  workMode?: 'foreground' | 'background';
  /** Optional tighter limits for this slice; Core hard caps both values. */
  workBudget?: Partial<ContextCompactionWorkBudget>;
  /** Notify the host that a later bounded slice should be enqueued. */
  onCompactionContinuationNeeded?: (progress: Readonly<ContextCompactionProgress>) => void;
}

export interface AgentExecutionModelContext {
  definitionId: string;
  definition: AgentDefinition;
  route: ResolvedAgentModelRoute;
  /** Persistent, bounded context after all retained summary controls are applied. */
  messages: ChatMessage[];
}

export interface PrepareAgentExecutionModelRequestOptions extends LoadAgentExecutionModelContextOptions {
  stream: boolean;
  inputText?: string;
}

export interface PrepareLoadedAgentExecutionModelRequestOptions {
  conversationId: string;
  stream: boolean;
  signal: AbortSignal;
  inputText?: string;
}

export interface PreparedAgentExecutionModelRequest extends AgentExecutionModelContext {
  prepared: PreparedModelRequest;
}

/**
 * Resolve the same exact model route and persistent bounded context used by a
 * real AgentToolLoop iteration. Preview hosts call this function directly;
 * they never provide their own summarizer or load a resident UI snapshot.
 */
export async function loadAgentExecutionModelContext(
  context: AgentFrameworkContext,
  options: LoadAgentExecutionModelContextOptions,
): Promise<AgentExecutionModelContext> {
  const { conversationId, signal } = options;
  signal.throwIfAborted();
  const durableDefinitionId = options.definitionId ??
    await inferDefinitionId(context.storage, conversationId);
  signal.throwIfAborted();
  const definition = options.definition ??
    await resolveAgentDefinitionModel(context, durableDefinitionId);
  signal.throwIfAborted();
  if (!definition || definition.id !== durableDefinitionId) {
    throw new Error(`agent definition '${durableDefinitionId}' was not found`);
  }
  const route = options.route ?? resolveRoute(context, definition);
  const messages = await loadEffectiveIterationHistory({
    storage: context.storage,
    conversationId,
    localNodeId: requireExecutionLocalNodeId(context.localNodeId),
    signal,
    summarize: (summaryMessages, summarySignal) => summarizeModelContext(route, summaryMessages, summarySignal),
    ...(options.recentTurnsToKeep === undefined
      ? {}
      : { recentTurnsToKeep: options.recentTurnsToKeep }),
    ...(options.maxContextBytes === undefined
      ? {}
      : { maxContextBytes: options.maxContextBytes }),
    ...(options.workMode === undefined ? {} : { workMode: options.workMode }),
    ...(options.workBudget === undefined ? {} : { workBudget: options.workBudget }),
    ...(options.onCompactionContinuationNeeded === undefined
      ? {}
      : { onCompactionContinuationNeeded: options.onCompactionContinuationNeeded }),
  });
  signal.throwIfAborted();
  return { definitionId: durableDefinitionId, definition, route, messages };
}

/** Resolve, compact, and prepare one preview/execution request under one route fence. */
export async function prepareAgentExecutionModelRequest(
  context: AgentFrameworkContext,
  options: PrepareAgentExecutionModelRequestOptions,
): Promise<PreparedAgentExecutionModelRequest> {
  const loaded = await loadAgentExecutionModelContext(context, options);
  return prepareLoadedAgentExecutionModelRequest(context, loaded, options);
}

/** Prepare an already fenced load result without re-resolving its route. */
export async function prepareLoadedAgentExecutionModelRequest(
  context: AgentFrameworkContext,
  loaded: AgentExecutionModelContext,
  options: PrepareLoadedAgentExecutionModelRequestOptions,
): Promise<PreparedAgentExecutionModelRequest> {
  options.signal.throwIfAborted();
  const runtimeAgent = context.agent ?? (context.resolveAgentRuntimeView
    ? await context.resolveAgentRuntimeView(options.conversationId, loaded.messages)
    : undefined);
  options.signal.throwIfAborted();
  const requestContext: AgentFrameworkContext = {
    ...context,
    operationSignal: options.signal,
    ...(runtimeAgent === undefined ? {} : { agent: runtimeAgent }),
  };
  const prepared = await prepareAgentModelRequest(
    requestContext,
    loaded.definition,
    loaded.messages,
    {
      route: loaded.route,
      conversationId: options.conversationId,
      stream: options.stream,
      signal: options.signal,
      ...(options.inputText === undefined ? {} : { inputText: options.inputText }),
    },
  );
  options.signal.throwIfAborted();
  return { ...loaded, prepared };
}

function resolveRoute(
  context: AgentFrameworkContext,
  definition: AgentDefinition,
): ResolvedAgentModelRoute {
  const registry = context.modelProviderRegistry;
  if (!registry) throw new Error('model provider registry is not configured');
  return resolveAgentModelRoute(
    registry,
    resolveAgentModelConfig({
      definition,
      hostDefault: context.defaultModelConfig,
    }),
  );
}

function requireExecutionLocalNodeId(localNodeId: string | undefined): string {
  const normalized = localNodeId?.trim();
  if (!normalized) throw new Error('localNodeId is required for model context compaction');
  return normalized;
}
