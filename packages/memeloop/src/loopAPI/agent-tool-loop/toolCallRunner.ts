import { type DetailReference } from '../../conversation/index.js';
import type { AgentOrchestrationClient, OrchestrationResourceReference } from '../../orchestration/client.js';
import { reconcileUnknownEffect } from '../../orchestration/drivers/unknownEffect.js';
import { OrchestrationError } from '../../orchestration/errors.js';
import { createToolOperationManifest, TOOL_OPERATION_API_VERSION, TOOL_OPERATION_KIND, type ToolOperationResource } from '../../orchestration/resources.js';
import { TOOL_PARAMETER_PARSE_ERROR_KEY } from '../../promptUtilities/responsePatternUtility.js';
import { safeErrorMessageFromUnknown } from '../../safeError.js';
import { canonicalizeToolResult, truncateToolSummary } from '../../tools/structuredToolResult.js';
import type { AgentFrameworkContext, ToolInvocationContext } from '../../types.js';
import { executeHooks, hasHooks } from '../hooks/registry.js';

import type { AgentLoopStep } from '../types.js';
import { appendLocalMessageEvent } from './localMessageEvent.js';
import { evaluateToolProgressGuard, observeToolProgress, type ToolProgressGuardState } from './toolProgressGuard.js';
import type { PendingToolCall } from './toolUseGate.js';

type ToolRunRow = {
  text: string;
  isError: boolean;
  payload?: unknown;
  detailRef?: DetailReference;
  awaitSessionId?: string;
};

type CompletedToolCall = ToolRunRow & { call: PendingToolCall; callIndex: number };

const TOOL_OPERATION_DEFAULT_TIMEOUT_MS = 60_000;
const TOOL_OPERATION_POLL_INTERVAL_MS = 250;

let toolOperationCounter = 0;

function isTerminalToolOperationPhase(phase: string | undefined): boolean {
  return phase === 'Completed' || phase === 'Failed' || phase === 'Cancelled';
}

function isTransientGetError(error: unknown): boolean {
  return (
    error instanceof OrchestrationError &&
    (error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT' || error.code === 'INTERNAL')
  );
}

/**
 * Poll a ToolOperation until terminal. Transient `get` failures are treated
 * as possible unknown-effect situations: reconciliation decides whether to
 * keep waiting (`retry`) or stop and surface the required intervention,
 * never blindly repeating the operation.
 */
async function waitForToolOperationTerminal(
  client: AgentOrchestrationClient,
  reference: OrchestrationResourceReference,
  timeoutMs: number,
  applied?: ToolOperationResource,
  signal?: AbortSignal,
): Promise<ToolOperationResource> {
  const deadline = Date.now() + timeoutMs;
  const deadlineIso = new Date(deadline).toISOString();
  let last: ToolOperationResource | null = applied ?? null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let resource: Awaited<ReturnType<AgentOrchestrationClient['get']>> | undefined;
    try {
      resource = await client.get(reference, { signal, deadline: deadlineIso });
    } catch (error) {
      if (!isTransientGetError(error)) throw error;
      const basis = last ?? applied;
      if (!basis) throw error;
      const decision = reconcileUnknownEffect(basis, { resultObserved: false });
      if (decision.action === 'retry') {
        // The operation itself is safe to keep awaiting; do not re-apply.
      } else {
        throw new Error(
          `ToolOperation ${reference.name ?? '<unknown>'} effect unknown after transport failure: ` +
            `${decision.action} — ${decision.reason}`,
        );
      }
    }
    if (resource) {
      last = resource as unknown as ToolOperationResource;
      if (isTerminalToolOperationPhase(last.status?.phase)) {
        return last;
      }
    }
    await abortableDelay(TOOL_OPERATION_POLL_INTERVAL_MS, signal);
  }
  if (last) {
    return last;
  }
  throw new Error(`ToolOperation ${reference.name ?? '<unknown>'} was not observed before timeout`);
}

function toolOperationRow(resource: ToolOperationResource): ToolRunRow {
  const status = resource.status;
  if (status?.phase === 'Completed') {
    return canonicalToolRunRow(status.result?.value);
  }
  if (status?.phase === 'Failed' || status?.phase === 'Cancelled') {
    const row = canonicalToolRunRow(status.result ?? { error: `ToolOperation ${status.phase}` });
    return { ...row, isError: true };
  }
  return {
    text: `ToolOperation did not reach a terminal phase (last phase: ${status?.phase ?? 'unknown'})`,
    isError: true,
  };
}

async function executeToolOperation(
  context: AgentFrameworkContext,
  conversationId: string,
  call: PendingToolCall,
  occurrence: number,
  signal?: AbortSignal,
): Promise<ToolRunRow | null> {
  signal?.throwIfAborted();
  const route = context.agentToolLoop?.toolExecutionRoute ??
    (context.orchestration ? 'orchestration-required' : 'local');
  if (route === 'local') return null;

  const client = context.orchestration;
  if (!client) {
    return {
      text: 'ToolOperation execution is required, but no orchestration facade is configured.',
      isError: true,
    };
  }

  const timeoutMs = context.agentToolLoop?.toolOperationTimeoutMs ?? TOOL_OPERATION_DEFAULT_TIMEOUT_MS;
  const deadline = new Date(Date.now() + timeoutMs).toISOString();

  try {
    const caps = await client.getCapabilities({ signal, deadline });
    signal?.throwIfAborted();
    if (
      !caps.resourceKinds.includes(TOOL_OPERATION_KIND) ||
      !caps.operations.includes('apply') ||
      !caps.operations.includes('get')
    ) {
      return {
        text: 'ToolOperation execution is required, but the orchestration facade does not support ToolOperation apply/get.',
        isError: true,
      };
    }
  } catch (error) {
    const message = safeErrorMessageFromUnknown(error, {
      fallback: 'orchestration capability discovery failed',
    });
    context.logger?.warn?.('[agentToolLoop] ToolOperation capability discovery failed', message);
    return {
      text: 'ToolOperation execution is unavailable because orchestration capabilities could not be verified.',
      isError: true,
    };
  }

  // Stable per logical call: controller retries re-deliver the same operation,
  // while a new identical call (next occurrence) produces a distinct key.
  const idempotencyKey = `${conversationId}:${call.callDigest}:${occurrence}`;

  toolOperationCounter += 1;
  const operation = createToolOperationManifest(
    `${call.toolId}-${Date.now().toString(36)}-${toolOperationCounter.toString(36)}`,
    {
      toolRef: { kind: 'BuiltinTool', name: call.toolId },
      effect: context.tools.getToolEffect?.(call.toolId) ?? 'execute',
      arguments: call.parameters,
      idempotencyKey,
      timeoutMs,
      policy: { auditLevel: 'metadata' },
    },
  );

  try {
    signal?.throwIfAborted();
    const applied = await client.apply(operation, { signal, deadline });
    signal?.throwIfAborted();
    if (applied.apiVersion !== TOOL_OPERATION_API_VERSION || applied.kind !== TOOL_OPERATION_KIND) {
      return { text: 'ToolOperation apply returned an unexpected resource kind', isError: true };
    }
    let resource = applied as unknown as ToolOperationResource;
    if (!isTerminalToolOperationPhase(resource.status?.phase)) {
      const reference: OrchestrationResourceReference = {
        apiVersion: applied.apiVersion,
        kind: applied.kind,
        name: applied.metadata.name,
        namespace: applied.metadata.namespace,
      };
      resource = await waitForToolOperationTerminal(client, reference, timeoutMs, resource, signal);
    }
    return toolOperationRow(resource);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    const message = safeErrorMessageFromUnknown(error, {
      fallback: 'ToolOperation execution failed',
    });
    return { text: `ToolOperation execution error: ${message}`, isError: true };
  }
}

async function executeRegistryTool(
  context: AgentFrameworkContext,
  toolId: string,
  parameters: Record<string, unknown>,
  invocation: ToolInvocationContext,
): Promise<ToolRunRow> {
  invocation.signal?.throwIfAborted();
  const normalizedId = toolId.includes('-')
    ? toolId.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
    : toolId;
  const impl = (context.tools.getTool(toolId) ?? context.tools.getTool(normalizedId)) as
    | ((arguments_: Record<string, unknown>, invocation?: ToolInvocationContext) => unknown)
    | undefined;

  if (typeof impl !== 'function') {
    return {
      text: `No tool registered for "${toolId}".`,
      isError: true,
    };
  }

  try {
    const raw = await impl(parameters, invocation);
    invocation.signal?.throwIfAborted();
    return canonicalToolRunRow(raw);
  } catch (error) {
    if (invocation.signal?.aborted) invocation.signal.throwIfAborted();
    const message = safeErrorMessageFromUnknown(error, { fallback: 'Tool execution failed' });
    if (context.logger?.warn) {
      context.logger.warn('[agentToolLoop] tool execution error', toolId, message);
    } else {
      console.warn('[agentToolLoop] tool execution error', toolId, message);
    }
    return { text: message, isError: true };
  }
}

function canonicalToolRunRow(raw: unknown): ToolRunRow {
  const canonical = canonicalizeToolResult(raw);
  return {
    text: canonical.summary,
    isError: canonical.isError,
    ...(canonical.payload === undefined ? {} : { payload: canonical.payload }),
    ...(canonical.detailRef === undefined ? {} : { detailRef: canonical.detailRef }),
    ...(canonical.awaitSessionId === undefined ? {} : { awaitSessionId: canonical.awaitSessionId }),
  };
}

async function executeWithGuards(
  context: AgentFrameworkContext,
  conversationId: string,
  recentToolCalls: string[],
  call: PendingToolCall,
  invocation: ToolInvocationContext,
): Promise<ToolRunRow> {
  invocation.signal?.throwIfAborted();
  const parameterParseError = call.parameters[TOOL_PARAMETER_PARSE_ERROR_KEY];
  if (typeof parameterParseError === 'string') {
    return { text: parameterParseError, isError: true };
  }

  const signature = call.callDigest;
  recentToolCalls.push(signature);
  // Occurrence of this exact call in the conversation; distinguishes a new
  // logical call from a controller retry of a previous one.
  const occurrence = recentToolCalls.filter((entry) => entry === signature).length;
  const row = (await executeToolOperation(context, conversationId, call, occurrence, invocation.signal)) ??
    (await executeRegistryTool(context, call.toolId, call.parameters, invocation));

  if (hasHooks('PostToolUse', context)) {
    await executeHooks(
      'PostToolUse',
      { ...context, operationSignal: invocation.signal },
      {
        toolId: call.toolId,
        parameters: call.parameters,
        result: row.text,
        isError: row.isError,
        conversationId,
      },
    );
  }

  return row;
}

async function persistToolResult(
  context: AgentFrameworkContext,
  conversationId: string,
  turnId: string,
  messageIdentity: string,
  callIndex: number,
  call: PendingToolCall,
  row: ToolRunRow,
): Promise<void> {
  const messageId = `${conversationId}:t:${messageIdentity}:${callIndex}:${call.toolId}`;
  await appendLocalMessageEvent(context, {
    conversationId,
    message: {
      messageId,
      turnId,
      role: 'tool',
      content: row.text,
      parts: [
        {
          type: 'tool-result',
          ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
          toolName: call.toolId,
          parameters: call.parameters,
          result: row.text,
          isError: row.isError,
          ...(row.payload === undefined ? {} : { payload: row.payload }),
          ...(row.detailRef === undefined ? {} : { detailRef: row.detailRef }),
        },
      ],
      ...(row.detailRef === undefined ? {} : { detailRef: row.detailRef }),
      metadata: {
        isToolResult: true,
        isError: row.isError,
        toolId: call.toolId,
        toolParameters: call.parameters,
      },
    },
  });
}

async function persistTerminalAwaitCompletion(
  context: AgentFrameworkContext,
  options: AgentFrameworkContext['agentToolLoop'],
  conversationId: string,
  turnId: string,
  messageIdentity: string,
  callIndex: number,
  call: PendingToolCall,
  row: ToolRunRow,
  signal?: AbortSignal,
): Promise<void> {
  const sid = row.awaitSessionId;
  const wait = options?.waitForTerminalSession;
  if (!sid || !wait || row.isError) return;
  const done = await waitForAbortable(wait(sid), signal);
  signal?.throwIfAborted();
  const body = truncateToolSummary(
    `[terminal.await done] session=${sid}\nexitCode: ${done.exitCode ?? 'null'}\n---\n${done.truncatedOutput}`,
  );
  const resolvedExitCode = done.exitCode ?? row.detailRef?.exitCode;
  const detailReference = row.detailRef
    ? {
      ...row.detailRef,
      ...(resolvedExitCode === undefined ? {} : { exitCode: resolvedExitCode }),
    }
    : undefined;
  const messageId = `${conversationId}:t:${messageIdentity}:${callIndex}:${call.toolId}:await`;
  await appendLocalMessageEvent(context, {
    conversationId,
    message: {
      messageId,
      turnId,
      role: 'tool',
      content: body,
      parts: [
        {
          type: 'tool-result',
          ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
          toolName: call.toolId,
          parameters: call.parameters,
          result: body,
          ...(detailReference ? { detailRef: detailReference } : {}),
        },
      ],
      ...(detailReference ? { detailRef: detailReference } : {}),
      metadata: {
        isToolResult: true,
        toolId: call.toolId,
        toolParameters: call.parameters,
        awaitSessionId: sid,
      },
    },
  });
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
  turnId: string;
  messageIdentity: string;
  calls: PendingToolCall[];
  parallel: boolean;
  recentToolCalls: string[];
  progressGuardState: ToolProgressGuardState;
  guardAlreadyChecked?: boolean;
  signal?: AbortSignal;
  runId?: string;
}): AsyncGenerator<AgentLoopStep, void, unknown> {
  const {
    context,
    agentToolLoopOptions,
    conversationId,
    turnId,
    messageIdentity,
    calls,
    parallel,
    recentToolCalls,
    progressGuardState,
    guardAlreadyChecked = false,
    signal,
    runId,
  } = options;
  const invocation: ToolInvocationContext = {
    conversationId,
    ...(runId === undefined ? {} : { runId }),
    ...(signal === undefined ? {} : { signal }),
  };
  signal?.throwIfAborted();

  if (!guardAlreadyChecked) {
    const decision = await evaluateToolProgressGuard(progressGuardState, calls, {
      exactRepeatThreshold: agentToolLoopOptions?.doomLoopThreshold,
      sameToolWithoutProgressThreshold: agentToolLoopOptions?.doomLoopSameToolThreshold,
      sha256Hex: context.sha256Hex,
      signal,
    });
    if (decision.blocked) {
      for (const [callIndex, call] of calls.entries()) {
        const row: CompletedToolCall = {
          call,
          callIndex,
          text: decision.message,
          isError: true,
        };
        yield toolStep(row, parallel);
        await persistToolResult(
          context,
          conversationId,
          turnId,
          messageIdentity,
          callIndex,
          call,
          row,
        );
      }
      return;
    }
  }

  if (parallel) {
    const results = await Promise.all(
      calls.map(
        async (call, callIndex): Promise<CompletedToolCall> => ({
          call,
          callIndex,
          ...(await executeWithGuards(context, conversationId, recentToolCalls, call, invocation)),
        }),
      ),
    );
    // The plugin path reconstructs the preceding tool results from history
    // immediately before its next guard evaluation. Observing them here as
    // well would count the same batch twice, using two different envelope
    // shapes, and could spuriously reset the no-progress counter.
    if (!guardAlreadyChecked) {
      await observeToolProgress(progressGuardState, toolProgressObservation(results), {
        sha256Hex: context.sha256Hex,
        signal,
      });
    }
    for (const row of results) {
      signal?.throwIfAborted();
      yield toolStep(row, true);
    }
    for (const row of results) {
      signal?.throwIfAborted();
      await persistToolResult(
        context,
        conversationId,
        turnId,
        messageIdentity,
        row.callIndex,
        row.call,
        row,
      );
    }
    for (const row of results) {
      signal?.throwIfAborted();
      await persistTerminalAwaitCompletion(
        context,
        agentToolLoopOptions,
        conversationId,
        turnId,
        messageIdentity,
        row.callIndex,
        row.call,
        row,
        signal,
      );
    }
    return;
  }

  const results: CompletedToolCall[] = [];
  for (const [callIndex, call] of calls.entries()) {
    signal?.throwIfAborted();
    const row = await executeWithGuards(context, conversationId, recentToolCalls, call, invocation);
    const completed = { call, callIndex, ...row };
    results.push(completed);
    yield toolStep(completed, false);
    await persistToolResult(context, conversationId, turnId, messageIdentity, callIndex, call, row);
    await persistTerminalAwaitCompletion(
      context,
      agentToolLoopOptions,
      conversationId,
      turnId,
      messageIdentity,
      callIndex,
      call,
      row,
      signal,
    );
  }
  if (!guardAlreadyChecked) {
    await observeToolProgress(progressGuardState, toolProgressObservation(results), {
      sha256Hex: context.sha256Hex,
      signal,
    });
  }
}

function toolProgressObservation(rows: readonly CompletedToolCall[]): unknown {
  return rows.map((row) => ({
    isError: row.isError,
    text: row.text,
    toolId: row.call.toolId,
  }));
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForAbortable<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Tool operation failed'));
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation aborted', 'AbortError');
}
